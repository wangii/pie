# PIE LLM 请求与 Frame 信息流概览

本文按**一次模型请求实际收到的信息**梳理 PIE 的 prompt design、四角色循环、Frame formulation 和辅助摘要调用。角色说明不能代替请求链：普通调用由 system prompt、活动工具、按角色投影的消息、状态转移 steer 及请求时附加的 Frame 共同构成；压缩、分支摘要、fast-path 摘要和 bug-report 摘要则各自构造独立请求。

代码引用均相对 `packages/pie/`。普通 agent loop 实现在 `packages/agent/src/agent-loop.ts`。

## 1. 普通请求的组装顺序

普通调用经 `AgentSession` 进入 agent loop。`agent-session.ts` 安装 belief-loop 的 next-turn 和 request hooks。每次请求大致按以下顺序组装：

```text
当前 LoopState / ROLE_SPECS
        │
        ├─ prepareNextTurnWithContext
        │    ├─ role system prompt
        │    ├─ role 的 active tools
        │    ├─ 按角色过滤后的 session messages
        │    ├─ role model 与 thinking level
        │    └─ evidenceWatermark
        │
        ├─ 插入准备消息及 steering 消息
        ├─ prepareRequest：若 task 有 Frame，追加末尾 user message
        └─ streamAssistantResponse → convertToLlm → provider
```

- `src/core/belief-loop/belief-loop-controller.ts` 的 `installAgentNextTurnRefresh()` 覆盖当前调用的 `systemPrompt`、`tools`、`messages`、model 和 thinking level。消息由 `projectContextMessages()` 从 session 投影产生。
- `applyRoleSurface()` 设置活动工具，并把生成的角色 system prompt 写进 transcript 的首条 system message。`roleSystemPrompt()` 组合基础 system prompt、所选工具 snippets/guidelines、角色指令和 `formulationGateProjection()`。
- `packages/agent/src/agent-loop.ts` 先运行 next-turn hook、处理准备与 steering 消息，再运行 prepareRequest，然后调用 `streamAssistantResponse()`。
- `installAgentFrameRequestProjection()` 包装 prepareRequest，在当前请求的 messages 末尾追加 `frameStateMessage()` 生成的 user message。这个动态 Frame 不写入 `agent.state.messages`；它不是历史 system prompt。

所以“本轮 prompt”不是一段文本：system、tool schema、history projection、steer 与末尾 Frame 处于不同位置，并有不同生命周期。

## 2. 四个普通角色的每次调用

| 当前角色 | System 指令与工具 | 此次调用可见的信息 | 常见下一步 |
|---|---|---|---|
| `propose` | 科学探究 preamble；`ROLE_SPECS.propose` 指令；路由、belief、focus、experiment、Frame 与 conclude 工具 | belief-side transcript 投影保留信念操作记录、遮蔽原始执行细节；收到当前 Frame、待处理 gate 和本轮 steer | 选路由/实验、处理 Frame 或更正，或请求结束 |
| `execution` | 实验执行 preamble；执行角色指令；活动探测工具和只读 `view_beliefs`；fast path 另有 `report_outcome` | execution 投影隐藏 belief mutation 与 formulation 操作回声，保留被测 belief 的查看结果与原始执行证据；Frame 仍由 request hook 追加 | 报告原始观察；普通 loop 转 distill，fast path 根据结束条件结算 |
| `distill` | 科学探究 preamble；裁决指令；主要为 `declare_belief`、`view_beliefs`、`conclude` | distill 投影通过 evidence watermark 暴露本轮原始证据；旧执行细节被遮蔽；Frame 仍由 request hook 追加 | 裁决所有已派发未裁决信念后返回 propose；否则由 controller 留在 distill |
| `finalReport` | 证据综合指令；无工具 | finalReport 投影隐藏操作细节与 belief tool echo；结论 handoff 提供汇总上下文；Frame 仍由 request hook 追加 | 写面向用户的最终答案 |

角色定义在 `src/core/role-specs.ts`；投影实现位于 `src/core/belief-loop/message-projection.ts`。投影还会遮蔽没有存活 tool call 的 tool result，避免向 provider 发送孤立结果。角色工具越权由 controller 检查并 steer；模型可用工具表和 prompt 文本不是唯一约束。

### 普通循环的转移

```text
propose → execution → distill → propose
                         └────→ finalReport（守卫通过时）
```

`belief-loop-controller.ts` 的 `transition()` 处理实际转移：propose 检查未答更正、Frame 决策及复核，再 dispatch；execution 按工具结果和 lease 继续、转 distill 或交还 propose；distill 在仍有派发信念未裁决时不离开本角色。结束还会经过 task outcome、revalidation 和 adversarial reflection 等守卫。已派发信念的裁决义务从 durable plan 读取，不会因改焦点或关闭 episode 而消失。

`src/core/tools/declare-belief.ts` 对实验选择校验焦点已声明、belief 位于焦点且状态仍可 probe。`src/core/tools/conclude.ts` 要求记录交付结果和验证 evidence；controller 另行验证任务级完成条件。

## 3. Frame formulation 的跨请求链

Frame（代码中称 `ProblemFormulation`）回答“当前把任务理解成什么”，不是 world belief，也不是 evidence。它有独立的事件记录和状态回放：

- `src/core/agent-session-domain.ts` 定义不可变 Frame versions、sources、deferrals、corrections、applicability reviews、rechecks 和 experiment 的 formulation adoption。领域事件被写入 session log 并 replay 到 task snapshot。
- `publishFormulation()` 验证 interpretation/focus/implication 等必需字段，追加新版本；相同内容是 no-op。未派发 experiment selection 会因新版本而失效，已派发 plan 保留其原 adoption。
- 每次发布都会暂停运行，等待用户回应。普通用户回应被记录为针对该版本的 correction，不覆盖 agent 版本；propose 回答后仍需 review applicability 与 focus。待回应期间 prompt 会被拒绝。
- 每次 distillation 后 propose 还需 `recheck_formulation`、发布新版本或 defer。它和 revision applicability review 不同：recheck 回答“刚完成的这一轮对当前 Frame 意味着什么”；applicability 回答“旧结论在新 Frame 下是否仍适用”。
- `frameStateMessage()` 在普通请求时重建 `<current_formulation>`：当前解释、关注点、可选 tension/alternative、implication，最近 recheck、pending correction、pending applicability 和需重新验证 belief。没有已发布版本但有 deferral 时则显示缺失信息与原因。自由文本会转义该容器的 delimiter。
- `formulationGateProjection()` 将尚未履行的 gate 加到 system prompt；转移时 steer 也可能再次要求处理同一义务。Frame 是末尾 user message，gate 是 system prompt，steer 是对话消息，三者不是同一份存储。

流程示意：

```text
propose 发布 Frame
      ↓
持久事件 + 可见 formulation_wait，运行暂停
      ↓ 用户真实回应
记录 correction → propose 回答
      ↓
逐项 applicability review → focus review
      ↓
实验可继续；distill 后每轮 recheck
```

关键测试包括 `test/suite/formulation-review.test.ts`、`test/suite/formulation-decision.test.ts`、`test/suite/formulation-recheck.test.ts`。`formulation-decision.test.ts` 检查 provider 请求末尾只有一个 Frame block，并检查不可信 delimiter 转义；recheck tests 检查 system gate 和 Frame projection 的状态。

## 4. 普通请求的上下文过滤

`message-projection.ts` 按 `ROLE_SPECS[role].projection` 过滤权威会话消息：

- propose：保留 belief bookkeeping，操作细节改为占位内容。
- distill：如 propose，但 watermark 之后的本轮执行证据只暴露给当前 distillation。
- execution：隐藏 belief mutations/formulation 回声，保留 `view_beliefs` 与原始操作证据。
- finalReport：隐藏操作细节和 belief tool echoes，保留已结算 belief 信息供显式 final context 汇总。

`evidenceWatermark` 在 experiment dispatch 时更新。因而 execution 是否看到旧记录、本轮证据是否供 distill 使用，不由 prompt 文字单独决定。

## 5. 独立模型请求：不属于四角色表

这些调用使用专用输入，不经过普通角色的 `prepareNextTurnWithContext` / Frame request hook。触发条件和材料应单独说明。

| 调用 | 触发入口 | 请求材料与行为 |
|---|---|---|
| **Fast-path summary** | `settleFastPath()` 调用 `distillFastPath()` | `completeSimple()` 使用固定 system prompt、单条 user message（任务请求 + fast-path 执行片段），禁用工具选择，使用 fast-path thinking level。找不到 model、请求失败或输出为空时使用本地 fallback。摘要后回 propose，而不是进入 distill 角色。 |
| **PIE compaction summary** | `AgentSession.compact()` 手动压缩；`_checkCompaction()` 检测 threshold/overflow 后自动压缩 | 本地 `src/core/compaction/compaction.ts` 将投影历史序列化为 conversation，再附摘要指令，可带 previous summary 与 custom instructions；专用 summarization system prompt，`completeSummarization()` 走传入 streamFn 或 `completeSimple()`。压缩后 future context 使用 compaction summary 与保留尾部。 |
| **Branch summary** | tree navigation 且调用方选择 summarize，并且有可摘要 entries；扩展未提供替代结果时 | 本地 `src/core/compaction/branch-summarization.ts` 按 token budget 从最近 entries 收集 message、custom_message、branch/compaction summaries；跳过 toolResult、普通 custom 与元数据 entries。序列化为一条 conversation user message，配 branch summary 指令和独立 system prompt；可追加或替换 custom instructions。 |
| **Bug-report summary** | `AgentSession.summarizeForBugReport()` | 本地 `src/core/bug-report.ts` 从当前 messages 选择最多模型 context window 60% 的末尾内容，序列化成 `<conversation>`，可附 `<user-report>` hint，再附 bug-report 格式指令；专用 system prompt，拒绝 tool call 和空结果。 |

Fast path 的完整 terminal 路径在当前 controller/test 中是 **execution → propose → finalReport**：execution 通过 `report_outcome` 记录交付，摘要是辅助调用，不是用户最终报告；propose 先表达/确认 Frame，finalReport 才输出最终答复。`test/suite/agent-session-fast-path.test.ts` 覆盖成功摘要、失败 handoff 和最终答案顺序。

## 6. 压缩、结构化状态与历史

`src/core/session-manager.ts` 区分普通 `custom` entry 与 `custom_message`：前者不直接进入模型 context，后者可以转换为 context 消息。belief-loop domain events 使用普通 custom entry；当前 Frame 则由 replayed task 状态在每个普通请求重新构造。由此：

- compaction 和 branch-summary 摘要模型不会从普通角色 Frame hook 自动取得动态 Frame。
- 压缩后的普通对话历史由 summary 与保留范围组成；summary 的历史细节保真度取决于辅助摘要请求及保留尾部。
- belief/Frame 的结构化领域状态有独立的 durable event replay 路径；这不同于自然语言摘要是否复述相同信息。
- `test/session-manager/build-context.test.ts` 检查 compaction summary 与保留消息的排列，普通 custom entry 不进入模型 messages；`test/compaction.test.ts` 检查 custom_message 会参与 token budgeting。`test/suite/agent-session-compaction.test.ts` 检查 standalone compaction request 不继承 agent 的 `transformContext`、tools、session ID 或 transport。

branch summary 会成为后续 branch context 的摘要消息；它替代被放弃分支的逐条消息。因此不要把“结构化 Frame 可重建”扩写成“历史 evidence 一定无损”，也不要把“摘要模型没看到 Frame”误写成“下一次普通请求没有 Frame”。

## 7. 可由代码支持的保证与仅属 prompt 约定的内容

**控制器／工具能检查的内容**包括角色工具白名单、belief/experiment/focus 结构条件、已派发 belief 裁决义务、Frame response/applicability/focus/recheck gate、task outcome 非空以及压缩／摘要的调用边界。

**主要依赖模型遵循的内容**包括观察描述是否完整且有用、证据是否语义上支持某 belief、Frame 是否真是任务特有的 organizing reading、recheck 理由是否切题，以及摘要是否忠实保留有用上下文。现有 evidence 字段主要进行非空检查；代码无法据此证明语义真实性。

## 8. 改进建议（按风险排序）

1. **增加 evidence 可追溯引用。** execution prompt 要求来源/位置/命令结果，但 belief adjudication 与 `conclude` 对 evidence 主要作非空检查；回归测试也使用 `evidence: "observed"`。可给 observations 分配 ID，并让 belief delta、任务 outcome 和最终上下文引用这些 ID。结构化引用能检查链路，不代表证明来源内容真实。
2. **用实际请求快照测试信息组织。** 对 system、工具、投影消息、steer、末尾 Frame 分层断言；涵盖首个 Frame、user correction、recheck、finalReport 和 compaction 后恢复。已有测试确认末尾 Frame 和 delimiter 转义，可扩展到转移边界。
3. **统一 obligation 的来源再渲染到各通道。** recheck gate 会出现在 system prompt，转移 steer 也可能要求 recheck，Frame 还携带最新 recheck 状态。可从单一结构化 obligation 生成这些表示，并分别定义职责；目前代码和测试证明这些材料并存，没有实测重复文字会降低模型表现或浪费多少 token，不应把潜在重复说成已证实缺陷。
4. **为摘要保真做独立回归测试。** 用 fixture 覆盖 Frame 发布／user correction、belief evidence、domain custom event、custom_message、compaction 保留尾部与 branch summary。断言结构化 state 可重放，同时注明哪些会话历史仅以摘要保存。摘要 quality 不应被视为 Frame 状态恢复的唯一来源。
5. **在调用诊断中标明调用类别与材料边界。** 记录普通 role、fast-path summary、compaction、branch summary、bug-report summary 的调用类型、Frame version、history selection/watermark 和 fallback 状态；避免仅从 transcript 反推 provider 实际收到什么。

## 9. 证据边界

本文依据 PIE 本地源代码与相关测试定义整理，没有运行测试或调用真实 provider。没有实测摘要质量、重复 gate 对模型行为的影响，也没有核定所有 split-turn compaction 分支的精确请求数；因此不把“一次压缩必定只触发一次模型请求”作为保证。

## 相关文档

- [Belief-loop roles, steers, and context](belief-loop-roles.md)
- [Agent-session domain model](domain-model.md)
- [Frame formulation milestone](milestone-problem-formulation.md)
- [Frame recheck milestone](milestone-formulation-recheck.md)
