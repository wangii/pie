# Milestone：Frame 作为 agent 当前的问题理解

状态：M1–M5 已实现，M6 部分完成（终端人工验证待做）。日期：2026-09-20。M1–M3 完成日期：2026-09-20；M4–M5 完成日期：2026-09-20。

本文件记录 14 个逐项讨论的决定，以及据此安排的实现阶段和验收条件。
文件中的工具名、事件名和交互入口是实现建议；产品行为以“已确认决策”为准。

## 产品目标

用户要知道：**这个 agent 此刻把我交给它的事情当成什么事情。**

Frame = agent 的 current problem formulation，即 agent 从用户任务与环境信息中
形成的当前问题理解。它表达解释、关注重点、待解释的张力，以及这种理解对后续方向的影响。

Frame 采用第一人称、暂定的立场：“我目前把它理解为……”。它不声称自身就是现实，
不代替用户目标、belief、实验计划、交付记录或完整推理过程。

Frame 必须被后续角色读取并用于决策；允许探索反例。用户纠正理解后，下一次实验选择
必须经过重新考虑。只生成展示文案不满足本 milestone。

## Belief-set 与 Frame 的关系

Belief-set 保存 agent 对相关世界的可检验判断及其证据；Frame 表达 agent 当前如何把用户任务
理解成一个问题。两者通过调查循环相互影响，但回答不同的问题。

| 对象 | 回答的问题 | 例子 |
|---|---|---|
| Belief-set | 我提出了哪些判断？证据支持、反驳了什么？ | “每次 HTTP 请求都会创建新的 payment identity。” |
| Frame | 这些信息让我把当前任务看成什么？ | “我目前主要把它看成身份生命周期问题，而不再优先看成 retry 控制流问题。” |

Belief-set 中的判断不都是事实：它们可以待验证、被支持、被反驳、尚无定论或已被替代。
Frame 是一种暂定的问题理解，不使用这些真假或证据裁定状态。

### 同一组 beliefs 可以形成不同的 Frame

例如 agent 已有三条受支持的 beliefs：

- B1：retry 可以跨越原请求的生命周期。
- B2：payment identity 在每次请求中创建。
- B3：retry guard 正常生效时，重复扣款仍然出现。

起初，agent 把任务看成“retry guard 漏掉了一种情况”。后来它把 B1、B2、B3 联系起来，
转而认为应调查身份如何跨请求保留。这次变化可以没有新增 belief；改变的是信息之间的
解释关系、关注重点和调查方向。

一个 Frame 可以组织多个 beliefs，同一组 beliefs 也可以支持不同的 Frame。
Frame 不是 belief-set 的摘要，不能从 belief 状态机械推导出来。用户任务及其纠正同样参与
问题理解：相同的系统证据，在不同任务下可能具有不同的重要性。

### 通过任务 focus 连接到实验选择

| 层次 | 作用 |
|---|---|
| Belief-set | 保留 session 中的判断与证据历史 |
| Frame 的 Focus | 说明当前为什么优先关注某些对象、关系或尺度 |
| `focus_beliefs` | 明确本任务当前关注哪些 belief IDs |
| 实验选择 | 决定下一次具体检验哪些 beliefs |

例如 Frame 让 agent 优先关注 PaymentIntent 的生命周期，propose 据此将相关 beliefs
放入任务 focus，再选择一个实验。修改 Frame 不会自动修改 belief 的真假，也不会自动
把其他 beliefs 移出 focus。关注优先级、任务范围和证据状态分别通过各自的对象表达。

### 相互影响，但可以独立变化

以下是已有 Frame 时的调查循环；首次调查可以在尚未形成 Frame 时开始。

```text
用户任务 + 已有 beliefs / 证据
              ↓
propose 形成或修订 Frame
              ↓
选择任务 focus 和实验
              ↓
execution 收集观察
              ↓
distill 更新 beliefs，并提出修订建议
              ↓
propose 决定是否改变 Frame，再选择下一次实验
```

- Beliefs 改变，Frame 不变：新的证据进一步支持身份生命周期这一理解，调查继续沿用原 Frame。
- Frame 改变，beliefs 不变：用户纠正任务重点，或 agent 对已有证据形成新的解释。

只有 propose 发布 Frame；distill 裁定证据、更新 belief-set 并提供修订建议。
这不改变 propose 通过现有工具提出候选 beliefs 的职责。Frame 更新使尚未执行的实验选择
失效，但已经获得的证据、belief 状态和历史执行记录都保留。

### Frame 不能充当证据

Frame 不能成为未经验证的判断绕过 belief-loop 的通道。如果“身份生命周期问题”隐含一个
会影响行动、但尚未验证的经验判断，就应将那个判断明确成 belief 并检验。Frame 可以指导
寻找证据，自身不能充当支持 belief 的证据，也不能因为替代解释不再优先就把它标为 refuted。

## 已确认决策

| 问题 | 选择 | 确定的行为 |
|---|---|---|
| 1. 运行时作用 | A | Frame 是决策依据；允许反例和修订，不把符合 Frame 设为执行许可条件。 |
| 2. 首次出现 | B | 允许先调查，初步调查后再形成 Frame；此前显示“尚未形成”。 |
| 3. 对照项 | A | `rather than Y` 可选，仅表达实际影响调查方向的替代解释。 |
| 4. 内容完整度 | A | Interpretation、Focus、Implication 必填；Tension 可以尚未明确。 |
| 5. 发布者 | B | 只有 propose 发布或修订；distill 提供证据和修订建议。 |
| 6. 版本边界 | A | 理解、关注重点或调查方向有实质变化时创建版本；补充证据或润色不单独创建版本。 |
| 7. 修订依据 | A | 修订记录简短原因和可追溯来源；重新理解已有信息也可触发修订。 |
| 8. 用户纠正 | A | 用户针对 Frame 提交纠正，由 propose 处理并明确回应，不直接覆盖 Frame 字段。 |
| 9. 纠正时机 | A | 当前已发出的工具调用结束后暂停后续执行，交回 propose；保留已经发生的操作和证据。 |
| 10. 首次调查后 | A | 首次调查后的 propose 必须发布 Frame，或说明缺少什么信息、为何暂缓。 |
| 11. 待执行实验 | B | Frame 更新自动使尚未执行的实验选择失效，必须重新选择。 |
| 12. Fast path | B | Fast path 也必须形成 Frame；结束前经过 propose 发布环节，已有 Frame 可以沿用。 |
| 13. 本次范围 | A | 覆盖 packages/pie 的核心、事件接口和终端交互；原生 GUI 后续处理。 |
| 14. 旧命名 | A | 本次将旧 TaskFrame 及相关类型、事件改为 ExecutionEpisode 语义，Frame 专指问题理解。 |

## 现有实现与必要调整

当前实现见 [domain-model.md](domain-model.md)、[belief-loop-roles.md](belief-loop-roles.md)、
[belief-loop-controller.ts](../src/core/belief-loop/belief-loop-controller.ts) 和
[role-specs.ts](../src/core/role-specs.ts)。domain-model.md 已随 M1–M3 更新；下面几条描述的是尚未接入角色的运行时行为（M4 之前），
记录本身已由 M2 落地。

- `ExecutionEpisode`（M1 前名为 `TaskFrame`）保存 routing、plan、trajectory、distillation
  和 belief deltas。distill 返回 propose 时会开启下一个 episode，因此它表示执行轮次，
  不表示问题理解。M2 起 Plan 与 fast-path episode 另外记录当时采用的 formulation 版本。
- `FocusSet` 保存任务关注的 belief ID 集合。Formulation 的 Focus 解释关注重点，
  不能代替该集合，不能因改写一句话而移除未解决的 belief。
- propose 的消息投影隐藏原始工具结果；distill 可以读取当前执行轮次的原始证据。
  新的 Frame 状态与修订建议已由 M3 进入上下文；纠正交接仍需显式进入上下文（M4 尚未接入）。
- 当前 distill 可以直接 conclude 并进入 finalReport。此路径不能绕过必需的首次
  formulation 决策或尚未处理的用户纠正。
- 当前 fast-path execution 直接拥有最终回答。新增结束前的 propose 环节需要调整交接，
  防止先结束任务、再补写 Frame，或重复发送最终回答。
- [framing-belief.md](framing-belief.md) 记录的是已移除的 framing beliefs。
  本 milestone 不恢复这种 belief，也不引入完成义务、覆盖检查或 framing-discharge 协议。

## 对象与生命周期

### Formulation 内容

| 字段 | 含义 | 约束 |
|---|---|---|
| `interpretation` | 我目前如何理解这个任务 | 必填，表达暂定理解 |
| `alternative` | 我暂时不优先采用的另一种理解 | 可选；不是被证伪的结论，也不必是上一版本 |
| `focus` | 在此理解下，我优先关注哪些对象、关系或尺度 | 必填；不等同于 belief ID 集合 |
| `tension` | 我试图解释的冲突、落差或现象 | 可缺省；界面显示“尚未明确” |
| `implication` | 如果此理解成立，会怎样改变调查或干预方向 | 必填；不展开成操作步骤 |

第一人称是表达立场，不要求通过固定英文前缀校验。不得为了填字段而虚构替代解释或张力。
内容使用现有的 belief language 设置，终端标签遵循现有界面语言约定。

### 任务级记录

建议核心类型使用 `ProblemFormulation`，终端产品名称使用 Frame。

每个 Task 保存自己的当前版本和有序历史。版本记录至少包含：

- 稳定版本 ID、task ID、版本序号、前一版本 ID、发布时间；
- 完整 formulation 内容；
- 简短形成或修订原因，以及依据引用；
- 发布来源为 propose 的可验证记录。

来源可以是用户消息或纠正、工具执行结果、distillation、belief。
引用必须指向稳定记录；引用可变化的 belief 时，应关联相应 delta/event 或当时的记录，
不能在回看历史时误用其最新状态。旧证据的新解释是有效来源，不强制新增工具调用。

版本不可原地重写。propose 对实质变化负责；重复提交完全相同内容应为无副作用操作。
仅为润色而产生的新说法不应发布，也不另加一个语义比较模型来判断是否值得发布。

新 Task 不自动继承前一任务的当前 Frame。历史可以作为上下文，但当前理解必须归属本任务。

### 未形成状态

明确区分：

1. 尚未经过首次调查：Frame 尚未形成。
2. 已经过调查，但 propose 暂缓：保存缺失信息和暂缓原因。
3. 已形成：显示当前版本和发布时间。

建议提供 `set_formulation` 和 `defer_formulation` 两个 propose 专用操作。
首次调查后的 propose 必须完成其中一个有效操作；工具校验失败不能视为完成该决定。
后续获得相关信息时重新考虑暂缓原因，不能将第一次暂缓当作永久豁免。
暂缓不是空白版本，已有 Frame 后也不能用暂缓操作抹掉当前理解。

### 执行轮次和版本的关系

```text
Task
  Frame：v1 -> v2
  ExecutionEpisode 1：初步调查，无 formulation 版本
  ExecutionEpisode 2：使用 v1，检查 retry guard
  ExecutionEpisode 3：使用 v1，复现并发请求
  ExecutionEpisode 4：使用 v2，检查 payment identity 生命周期
```

新执行轮次不自动生成新 Frame。证据增加也不自动生成新 Frame。
Frame 改变可以没有 belief 变化，例如把两条已有事实联系成新的问题解释。

Plan/实验选择和实际 dispatch 必须记录采用的 formulation 版本。Fast path 没有 Plan，
其执行也必须能关联当时的版本，或明确记录当时尚未形成。首次调查或 fast path 结束后
形成的版本不能回填为已执行操作的决策依据。

## 角色与交接行为

### 正常 belief loop

1. propose 可以在没有 Frame 时选择初步调查。
2. execution 收集观察，distill 裁定被测试的 beliefs，并提供有来源的修订建议。
3. 首次调查后的 propose 发布 Frame 或明确暂缓；后续 propose 按实质变化更新。
4. 所有后续角色读取当前 Frame、适用版本和相关纠正状态；对反例保持开放。
5. 更新 Frame 自动清除尚未执行的实验选择。propose 必须重新调用实验选择操作，
   即使新实验仍选取相同 belief ID，也应关联新版本。
6. 已经派发的实验仍使用派发时的版本，其观察和未裁定 beliefs 不因 reframe 被清除。

propose 负责选择，distill 负责证据裁定，execution 负责观察和干预，finalReport 负责回答。
不新增一个专门的 framing 模型角色。distill 的建议在 propose 接纳前不能出现在“当前 Frame”中。

初始版本发布也改变了待执行实验的 formulation 上下文：若此前已选但未派发，需重新选择。
Frame 不改变 `FocusSet` 或 belief 状态；仍通过现有工具显式修改 scope 和 truth。

### 用户纠正

建议以任务级纠正记录保存：纠正 ID、目标版本、原文、接收时间、处理状态及 propose 的回应。
没有 Frame 时也应允许纠正当前任务理解；目标版本可以为空。

处理顺序：

1. 接收纠正后记录为待处理，不直接覆盖当前版本。
2. 允许已实际开始的工具调用结束，保留结果；不再启动新的执行调用。
   对并行调用等待已启动集合结束，对同一批次中尚未启动的调用也应阻止启动。
3. 下一个决策交回 propose，读取纠正和此时已经取得的观察；可以修订、明确维持原理解，
   或就歧义请求说明。用户约束必须遵守；与证据存在冲突时明确说明，不能静默忽略。
4. 只有有效回应才能把纠正标为已处理。修订使旧实验选择失效；被打断实验的后续行动
   也必须经过 propose 重新选择，不能自动续跑旧调用。
5. 已取得证据仍需由 distill 完成必要裁定。重新开执行轮次或更新版本不能丢失这项责任。

此交接需要在 packages/pie 内实现有界的观察上下文：让 propose 看见纠正处理所需的已完成
结果及来源，但不因此把 truth 裁定交给 propose，也不全量打开历史原始工具输出。
应记录仍待 distill 处理的实验与证据，终结前保留现有未裁定检查。

相继到达的纠正逐条保留；新的纠正到达时不能被旧回应错误地标为已处理。
用户纠正旧版本时同时展示目标版本和当前版本，propose 根据当前状态回应。

### Fast path

Fast path 可先执行，但不能在缺少 Frame 时成功结束。

```text
propose：路由
  -> fast-path execution：操作、观察、提交 outcome
  -> propose：发布初始 Frame / 沿用或修订已有 Frame
  -> 唯一最终回答，任务关闭
```

实现建议：保留 execution 作为 fast path 最终回答的作者，将其终结性回答延后到 propose
处理完成后释放；或者通过一个无工具的收尾阶段交付同一结果。实施时选择一个明确方案，
不得先向用户宣布结束再补 Frame，也不得在收尾阶段重放已完成操作。

- 后置 Frame 的时间和来源必须真实，不能声称已完成的操作曾受该版本指导。
- propose 只读取已完成操作、outcome、观察及其来源，不为生成 Frame 额外制造实验。
- propose 若发现仍有会影响任务结果的实质不确定性，则回到正常 belief loop。
- 发布失败或暂缓不满足 fast-path 结束条件；保留未完成状态及具体原因，不伪造 Frame。
- 未提交 outcome、已有 blocker、工具失败仍按现有规则处理；有 Frame 不代表任务已完成。
- Fast path 中收到纠正也遵守工具边界交回规则，不能等待整次 fast path 结束。

## 事件、恢复与命名

在 packages/pie 内统一替换旧执行轮次词汇，例如：

| 旧名称 | 目标名称 |
|---|---|
| `TaskFrame` | `ExecutionEpisode` |
| `FrameId` / `frameId` | `EpisodeId` / `episodeId` |
| `Task.frames` | `Task.episodes` |
| `FrameStage` / `FrameStatus` | `EpisodeStage` / `EpisodeStatus` |
| `PendingFrame` / `BeliefLoopFrame` / `FastPathFrame` | `PendingEpisode` / `BeliefLoopEpisode` / `FastPathEpisode` |
| `FrameOpened` / `FrameBodySelected` / `FrameClosed` | `EpisodeOpened` / `EpisodeBodySelected` / `EpisodeClosed` |

相应 controller 状态、cursor、delta 关联字段、SDK 导出、RPC 事件、测试和当前文档一起调整。
按实际语义修改：例如 `dispatchedFrameIds` 当前存的是 belief IDs，应该采用准确的 belief 命名；
终端绘制帧等无关 `frame` 词汇不属于这次改名。

建议增加任务级事件：

- `ProblemFormulationRecorded`：完整不可变版本，应用后使未执行实验失效。
- `ProblemFormulationDeferred`：尚未形成时的缺失信息和暂缓原因。
- `FormulationCorrectionSubmitted`：用户纠正及其目标版本。
- `FormulationCorrectionResolved`：propose 的处理回应及关联的新版本（若有）。

实验失效、重新选择及 dispatch 所用版本也必须有可回放的记录；仅清空内存字段不足以支持恢复。
上述事件进入现有分支事件日志、snapshot 和 RPC。UI 不从普通文本或相邻轮次推断版本。
恢复、分支切换及压缩后，当前版本、来源、暂缓原因、待处理纠正和过期实验状态应保持一致。
重连客户端读取 snapshot 后继续订阅事件，不能重复显示修订或恢复执行旧实验。

这是领域协议的破坏性改名。同步提升 schema 版本，不默认提供旧名称别名或旧日志迁移。
不支持的旧事件应明确拒绝，不能静默跳过后生成缺失的历史；不得改写或删除用户旧日志。

当前 gui/src/Model.cpp 消费旧事件名和 frameId。GUI 适配是后续依赖，不属于本 milestone。
本 milestone 完成不代表旧 GUI 与新协议兼容；对外同步使用前须完成消费者适配。

## 终端交互

提供当前 Frame、版本历史、变化原因与来源查看，以及针对 Frame 的纠正入口。
具体命令名可在实现时沿用现有终端风格；如增加快捷键，必须进入可配置 keybindings。

当前视图示例：

```text
HOW I SEE THIS TASK                         v2

Interpretation
  我目前主要把它理解为 payment identity 与请求生命周期不一致的问题。
  我暂时不再优先把它看成 retry 控制流中的局部 bug。

Focus
  我优先关注跨多次尝试存在的 PaymentIntent，以及身份的创建和保留位置。

Core tension
  我试图解释：retry 可以跨越请求生命周期，但 payment identity 没有随之保留。

What this changes
  我会先调查身份的归属和生命周期，再决定是否改变 retry 控制流。
```

历史视图对比真实版本，突出“之前如何理解、现在如何理解、为什么改变、方向如何改变”。
对照项只描述当前解释的替代项，不用它推断上一版内容。首次版本明确标记为初始形成。

纠正待处理时，仍展示已发布版本，同时标出“有纠正待处理”。完成后展示 propose 的回应，
即使其明确保留原理解也应可见。不能用暂缓、建议版本或用户输入冒充已发布的 agent 立场。

现有 belief 面板继续展示 beliefs；其中把 proposed beliefs 标成 `[frame]` 的旧文案需要更新，
避免把所有开放 beliefs 当作新的 Frame。紧凑视图允许折叠，但不能截断后失去查看完整内容的入口。

## 实施阶段

### M1：执行轮次改名与协议边界

- [x] 将旧 TaskFrame 体系统一改为 ExecutionEpisode，保留原有执行和证据关联行为。
- [x] 更新类型、controller、SDK/RPC、schema、测试夹具和当前协议文档。
- [x] 明确旧日志处理及后续 GUI 消费者适配依赖。

验收：正常循环和 fast path 的 episode 生命周期可回放；新轮次不会被解释为 reframe；
不支持的旧 schema 明确失败。改名不改变 belief 裁定、outcome 或实验预算语义。

实现说明：

- `AGENT_SESSION_DOMAIN_SCHEMA_VERSION` 提升为 2。v1 事件（`FrameOpened`、
  `FrameBodySelected`、`FrameClosed`、`frameId`）不提供别名或迁移，replay 直接抛出
  `DomainReplayError`，明确说明存储版本与所需版本；用户旧日志不被改写或删除。
  v1 session 在 `AgentSession` 构造时即失败，不会以空 domain model 打开。
- `FrameBodyKind`/`FrameStage`/`FrameStatus` → `EpisodeBodyKind`/`EpisodeStage`/
  `EpisodeStatus`，`TaskFrameBody` → `EpisodeBody`，`domainIdKind` 的 `"frame"` → `"episode"`。
- controller 侧 `currentFrameId`、`currentFrameExecutionIds`、
  `currentFrameDistillationDeltaIds`、`openNextDomainFrame`、`closeDomainFrame`、
  `selectDomainFrameBody` 一并改名。execution lease 的 `frameHorizon` →
  `episodeHorizon`（`FRAME_HORIZON_HEADROOM` → `EPISODE_HORIZON_HEADROOM`）。
- `dispatchedFrameIds` 存的始终是 belief ID，按实际语义改名为 `dispatchedBeliefIds`。
- 终端绘制帧、belief 面板旧 `[frame]` 文案、`view_beliefs` 的 `[FRAME]` 标签都不属于本次
  改名范围，保持原样（面板文案由 M5 处理）。
- GUI 消费者适配仍未完成：`gui/src/Model.cpp` 及其测试仍按旧事件名和 `frameId` 解析，
  与 v2 runtime 不兼容。该适配是后续依赖，不属于本 milestone，对外同步前必须完成。
  `packages/pie/docs/domain-model.md` 的 "Protocol versioning and old logs" 记录了这一点。

### M2：Formulation 对象与持久化

- [x] 增加任务级内容、版本、来源、未形成/暂缓和纠正记录。
- [x] 增加校验、事件折叠、snapshot/RPC 输出及控制器状态恢复。
- [x] 为实验选择和派发记录采用的版本，支持首次调查时无版本。

验收：版本不可变、来源可追溯、任务与分支隔离；重启或压缩后状态一致；
缺失必填内容不发布，缺少 Tension 或对照项可以发布，完全重复提交不创建事件。

实现说明：

- `FormulationContent`（`interpretation`/`focus`/`implication` 必填，`alternative`/`tension`
  可选）、`ProblemFormulationVersion`、`FormulationDeferral`、`FormulationCorrection`、
  `FormulationSource` 与 `FormulationAdoption` 落在 `agent-session-domain.ts`；
  Task 增加 `formulations`、`formulationDeferral`、`formulationCorrections`。
- 四个任务级事件：`ProblemFormulationRecorded`（携带完整版本）、
  `ProblemFormulationDeferred`、`FormulationCorrectionSubmitted`、
  `FormulationCorrectionResolved`。折叠逻辑校验版本序号、前一版本链、id 唯一性、必填内容、
  reason、来源可解析，以及纠正的目标版本与回应。
- **来源**：`prompt`/`intervention`/`correction`/`execution`/`distillation`/`belief`。
  belief 必须连同当时的 `beliefDeltaId` 一起引用，折叠时会校验该 delta 确实承载该 belief，
  避免回看历史时误用 belief 的最新状态；无法解析的引用直接拒绝。
- **无版本**：`FormulationAdoption` 为 `{kind:"version"}` 或 `{kind:"unformed"}`。
  `Plan.formulation` 记录"实验选择"采用的版本；fast path 没有 Plan，由
  `FastPathEpisode.formulation` 记录"派发"采用的版本。`unformed` 是明确记录的事实；
  已有版本后再声称 `unformed` 会被折叠拒绝，因此事后形成的版本无法回填为已执行操作的依据。
- **不可变**：版本只追加。`publishFormulation` 对与当前版本内容完全相同的提交返回
  `unchanged` 且不产生事件（reason/sources 不同也算重复，因为"补充证据"不应制造修订）；
  是否属于实质变化由 propose 判断，不引入语义比较模型。
- **暂缓**：记录缺失信息与原因；发布会使暂缓不再是当前状态，但不会删除任何版本；
  已有理解时暂缓也不会抹掉它。
- **纠正**：作为独立记录保存，绝不写回被纠正的版本；`targetVersionId` 可为空；
  处理按 correction ID 定位，必须有非空回应，因此不能把针对旧纠正的回应记到新纠正上。
- **控制器状态恢复**：`currentFormulation`/`formulationDeferral`/`pendingCorrections`/
  `formulationHistory` 直接读取 replay 后的 snapshot，没有独立的镜像状态，所以重启、切换分支
  与压缩后与日志一致。`dispatchedBeliefIds` 等执行期内存状态不在本阶段持久化（见 M3）。
- **schema 提升为 3（后随 M3 提升为 4）**：v2 的 `Plan` 没有 `FormulationAdoption`，replay 后
  无法区分"当时尚未形成"与"没有记录"，因此 v2 日志与 v1 一样被明确拒绝（`DomainReplayError`），
  旧日志不改写。
- **RPC 状态快照**：`get_state` 增加 `formulation`（当前版本、暂缓、待处理纠正、是否仍欠决定），
  新增 `get_domain_snapshot` 返回 replay 后的 snapshot（tasks、beliefs、cursor）。实时事件已经
  转发，但重连的客户端需要一次读取就能拿到"现在是什么状态"，否则只能重放它错过的日志。
- 本阶段只落地记录与持久化；谁有权发布、propose 何时必须做决定、发布后如何使待执行实验失效
  已由 M3 接入，纠正如何打断执行仍属于 M4。

### M3：Propose 所有权与实验选择

- [x] propose 专属发布/暂缓操作；distill 输出建议和依据。
- [x] 初次调查后强制完成发布或暂缓决定，覆盖 distill 直接 conclude 的交接路径。
- [x] 为各角色显式投影当前 Frame，不将其内容当作受支持事实。
- [x] 发布新版本时自动使待执行实验失效，要求重新选择。

验收：只有 propose 可以发布；新 Frame 实际进入下一次决策上下文；
可主动选择检验反例；选择后更新会阻止旧实验派发，更新后重新选择可以派发；
新版本不修改 FocusSet、belief 状态或历史操作版本。

实现说明：

- 新增 propose 专属工具 `set_formulation` / `defer_formulation`（`src/core/tools/formulation.ts`）。
  `execution` 的工具过滤显式排除二者，`distill`/`finalReport` 用固定列表，因此只有 propose 能发布。
  工具的 `sources` 是模型真正能给出的引用（任务 prompt、belief、纠正）；controller 把 belief
  引用绑定到当时那条 delta，execution/distillation 引用留给 M4 的纠正交接上下文。
- **强制决定**：`formulationDecisionOwed` 在 propose 分支与 distill 的 conclude 分支都检查，
  且读取 replay 后的状态而非本回合的工具调用 —— 校验失败的 `set_formulation` 不改变状态，
  因此不算完成决定。distill 直接 conclude 会被改道回 propose，不再绕过。
- **"已调查"的判定**用 `latestDispatchedEpisodeOrdinal`：episode 的 plan 存在（belief loop）
  或 body 为 fast path。只看"episode 已关闭"会漏掉 distill 在轮次中途 conclude 的路径；
  只看"有工具执行"又会让没跑工具的一轮蒙混过关。
- **无效化**：发布新版本时清除 `pendingExperiment`，并在当前 episode 尚无 plan 时清除
  `currentPlanId`，使下一次 `ensureDomainPlan` 记录新版本。已派发的实验不动：episode 的 plan
  与观察记录都不变。同一回合内工具按调用顺序执行，所以"先选后发布"会被作废，"先发布后选"
  会绑定新版本。
- **选择可回放**：`select_experiment` 现在写 `ExperimentSelected`（携带 belief ids、intent 与
  当时的 `FormulationAdoption`），`ExperimentSelectionVoided` 记录失效原因，`PlanProduced`
  在派发时清除它。这是 schema 提升为 4 的原因：v3 的 episode 只把选择放在内存里，replay 后
  无法区分"当时没有选择"与"选择没有落盘"，"选择 → 失效 → 重新选择"因此无法还原。控制器
  不再只在字段里持有选择：`adoptReplayedDomainState` 从 snapshot 读回，重启、切换分支与压缩
  后选择一致。
- **失效与结论的先后**：distill 的 `conclude` 若发现本回合派发过的 belief 仍未裁定，先要求
  裁定再考虑交接。该交接会开启下一个 episode 并清空 `dispatchedBeliefIds`，所以未裁定的责任
  必须在交接前结清，否则清理 focus 之后任务可以在 belief 未经任何裁定的情况下完成。
- **暂缓的去重**：重复暂缓只在"回应同一轮调查"时算无副作用。去重条件包含
  `answeredThroughEpisodeOrdinal`，所以新证据之后仍缺同一信息时必须重新记录，门槛不会被
  旧的暂缓记录继续挡住。
- **分支隔离**：`navigateTree` 切换 leaf 后调用 `BeliefLoopController.rehydrateFromBranch()`，
  重新 replay 新分支并重建 task/episode/plan 指针与选择。否则离开的分支上发布的版本会继续
  被当作当前理解。
- **投影**：当前版本（或暂缓，或尚未形成时不投影）进入每个角色的 system prompt，明确标注
  它是 agent 自己的暂定立场、不是观察、不是证据、不能作为 belief 的支持。放在 system prompt
  而不是 transcript，是为了让 transcript 保持 append-only 可缓存，并让每个角色读到的始终是
  *当前* 版本。尚未形成时不做任何投影，避免逼出没有依据的 Frame。
- **投影不产生孤立工具结果**：execution 角色的投影按 `BELIEF_MUTATIONS` 统一屏蔽 belief
  工具（含 `set_formulation`/`defer_formulation`）的结果，与 `maskEpistemicAssistant` 丢弃
  调用的范围同源。只屏蔽调用会留下没有对应 `tool_calls` 的 `tool` 消息，严格校验的 provider
  会直接拒绝整个请求。
- **反例**：Frame 只投影进上下文，不参与任何过滤。propose 仍可自由选择与当前理解相冲突的
  belief 去检验（新增测试覆盖"修订不影响 FocusSet/belief 状态"，选择逻辑与 Frame 无关）。
- 消息投影的 belief 工具清单收敛为 `BELIEF_SURFACE_TOOLS` 单一来源（role-specs），
  propose 工具表、projection 的判定、session 强制启用的工具表都从它派生，避免新增工具时漏改。
- 用户纠正的交接（打断已启动工具、交回 propose）仍属于 M4。

### M4：纠正与 Fast-path 交接

- [x] 用户纠正在已启动工具结束后交回 propose，阻止未启动的后续调用。
- [x] 保留已取得证据、未裁定责任、纠正来源和显式回应。
- [x] 调整 fast-path 终结交接，保证 propose 处理 Frame 后才成功结束。
- [x] 保留唯一最终回答，以及现有失败、blocker、outcome 和不重复操作规则。

验收：纠正无需等待整轮实验；串行及并行调用边界均符合约定；恢复后纠正不会丢失或重复处理；
fast path 有 Frame 后才能成功关闭，发布失败不能假成功，收尾不会重复执行副作用。

实现说明：

- **入口**：`AgentSession.submitFormulationCorrection(text, targetVersionId?)` 记录纠正（目标版本默认
  为当前版本，无版本时为空）。终端入口见 M5。工具层新增 propose 专属 `answer_correction`。
- **工具边界**：`beforeToolCall` 在 correction 待处理时阻止 execution 的 probe 调用。选择阻止而不是
  abort：被阻止的调用仍返回一条结果，assistant 消息里的每个 tool call 都有回答，provider 不会拒收。
  并行批次在 prepare 阶段串行执行，所以同批次中尚未开始的调用同样被拦下；已开始的调用照常返回。
- **交回**：`transition` 的 execution 分支在存在待处理纠正时交回 propose（fast path 同样适用，
  不等整轮结束），`advanceRole` 关闭该轮并开新轮，因此被打断实验的后续行动必须由 propose 重新选择。
- **有界观察上下文**：`correctionHandoff` 给出纠正原文/目标版本、本轮已完成操作（每条结果截断，
  最多 12 条）、仍待 distill 裁定的 belief。propose 不因此获得 truth 裁定权，也不打开全部历史原始输出。
- **未裁定责任**：`dispatchedBeliefIds` 内存集合被删除，改为从各 episode 的 `PlanProduced` 推导
  （`plannedBeliefIds`）。轮次结束不再清空责任，"清空 focus 后 conclude" 也无法绕过；
  终结前检查同时覆盖 `concludeTransition`。
- **终结门槛**：`concludeTransition` 依次检查未裁定 beliefs、待处理纠正、fast path 的 Frame 条件。
  `fastPathAwaitingReading` 要求最近一次派发的 fast path 已有版本（暂缓不算），否则交回 belief loop。
- **Fast path 交接（选择"无工具收尾"方案）**：fast-path execution 不再写最终回答，只报告 outcome；
  结算后交回 propose 发布/沿用 Frame，再由 finalReport 交付唯一最终回答。`fastPathDispatch` 与
  `fastPathFormulation` 的文案随之调整；已完成的 fast path 测试脚本按新交接改写。

### M5：终端产品闭环

- [x] 实现当前 Frame、未形成/暂缓状态、版本历史、修订来源和用户纠正入口。
- [x] 展示纠正待处理/已处理状态，支持完整内容查看和终端宽度变化。
- [x] 清理 belief 面板中旧 `[frame]` 文案，区分 Frame 与执行轮次。

验收：用户能够指出一个理解错误，看到 propose 如何处理，以及后续选择依据哪个版本；
重连或恢复显示同一状态；英文和中文内容均可阅读，交互不依赖不可配置快捷键。

实现说明：

- **面板**：`frame-panel.ts` 的 `FramePanel` 挂在 dock（belief 面板下方），显示当前版本或
  "not yet formed"/"deferred"、待处理纠正数与"decision owed"标记，并给出 `/frame` 入口。
  与 belief 面板一样每次渲染重读 replay 后的状态，所以恢复、切换分支与纠正处理后显示一致。
- **完整视图**：`/frame` 打开 `FrameDetailComponent`（`showSelector` 承载），给出
  Interpretation/Focus/Core tension/对照项/What this changes、来源、`v1 → v2` 历史与变更原因、
  逐条纠正的 pending/answered 状态及 propose 的回应，以及"最近一次实验依据哪个版本"
  （`latestFormulationAdoption`，与"当前版本"不同的问题）。
- **纠正入口**：`/frame correct <text>` 直接提交；提交后在对话区留下一行，`handleEvent` 的
  `FormulationCorrectionSubmitted`/`Resolved` 分别显示待处理与 propose 的回应。
- **快捷键**：`app.frame.toggle`（默认 `shift+ctrl+g`）进入可配置 keybindings，并列入 `/hotkeys`；
  `/frame` 本身是命令，交互不依赖不可配置快捷键。
- **面板文案**：belief 面板不再把 proposed beliefs 标成 `[frame]`；`view_beliefs` 的 `[FRAME]`
  标签按 M1 的范围说明保持原样。
- **宽度**：所有行经 `truncateToWidth`/`wrapTextWithAnsi`，测试覆盖 24/40/60 列下的中文内容。

### M6：回归验证与文档收敛

- [ ] 完成下列关键场景测试，更新角色、领域模型及 framing-belief 历史说明中的关联文档。
- [x] 在 docs/README.md 索引本 milestone，并标记为待实现。
- [ ] 随实现更新文档状态，区分已实现契约与尚未完成的阶段。
- [ ] 全部代码检查通过，完成终端人工验证，记录协议变更及 GUI 后续依赖。

验收：产品决策 1–14 均有实现或行为验证对应；不得把后续 GUI 工作算作本阶段已完成。

## 关键验收场景

1. **初步调查**：无 Frame 可以派发首次实验；其后 propose 发布或明确暂缓，不能无声跳过。
2. **暂缓后形成**：暂缓原因在恢复后仍可见，后续证据足够时发布初始版本，不回填历史执行版本。
3. **真实内容**：无有意义替代解释、无明确张力时仍能发布有效 Frame，不编造字段。
4. **选择发生变化**：同一核心解释下 Focus/Implication 实质改变产生新版本，待执行选择失效。
5. **证据增加但理解不变**：同一 Frame 可跨多个 episode，追加 belief 证据不制造修订通知。
6. **旧信息的新解释**：依据已有记录可以 reframe；belief 集合及其状态不必改变。
7. **角色边界**：distill 的修订建议可供 propose 使用，但不会直接覆盖当前版本。
8. **防止旧选择执行**：选择 E1 后发布 v2，E1 不执行；重新选择 E2 后记录其 v2 关联。
9. **中途纠正**：已启动调用完成，未启动调用停止；propose 读取纠正和已有结果，明确回应，
   既不重放已完成操作，也不丢弃未裁定的证据。
10. **相继纠正与旧版本**：逐条保留纠正的目标及回应，不用针对旧版本的回应处理新纠正。
11. **终结路径**：distill 直接 conclude 不绕过必要的首次决策或纠正处理；Frame 不代替 outcome。
12. **Fast-path 完成**：有工具和无工具的 fast path 都经过 propose 处理，成功结束时存在 Frame，
    最终回答只有一份；后置形成的版本不冒充先前执行依据。
13. **Fast-path 失败**：发布失败、存在 blocker、缺少 outcome 或出现实质不确定性时，
    保留真实状态或回到 belief loop，不能因已有 Frame 而宣告成功。
14. **恢复与分支**：版本、来源、暂缓原因、纠正、失效选择和执行版本绑定在恢复后完全一致，
    切换分支不混入其他分支状态，新任务不继承当前 Frame。

## 验证方式与范围

本 milestone 的实现改动限于 packages/pie。需要触及其他目录的实现依赖应单独提出，
不得为了完成本阶段默默扩展范围。原生 GUI 展示和旧协议消费者适配留到后续。

核心测试使用确定性的事件和 faux provider，不调用真实 provider 或付费模型。
优先扩展 domain、belief-set integration、message projection、fast-path 及相关 suite 回归测试；
每个新建或修改的测试文件都必须单独运行。涉及 suite 场景沿用现有 harness。

代码修改后运行 `npm run check` 并处理全部报告项。定向 Vitest 在 packages/pie 根目录执行：

```sh
node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/specific.test.ts
```

不运行 `npm run build`、`npm test` 或直接运行全量 Vitest。
终端人工验证加载仓库的交互测试说明，覆盖面板、历史、纠正及不同窗口宽度。

首次落地本文件时只写了文档，未修改运行时代码。M1 已按上述范围实现并单独运行相关测试；
终端人工验证属于 M5，尚未执行。
