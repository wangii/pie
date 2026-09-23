# Milestone：distillation 的两路反馈与 Frame 重审（M7.1–M7.5 已实现，终端人工验证待做）

状态：M7.1–M7.5 的代码与文档工作已完成（M7.3 落地门槛、任务级重审记录与协议 v6；M7.4 落地
投影与终端呈现；M7.5 完成场景 1–8 的确定性回归与协议/GUI 记录）。**唯一未完成项是终端人工
验证**，见 M7.5 末尾——实现方不能代为勾选。决策 1–7 已确认，选定的契约已回写
[belief-loop-roles.md](belief-loop-roles.md)、[epistemic-view-skeleton.md](epistemic-view-skeleton.md)
与 [milestone-problem-formulation.md](milestone-problem-formulation.md)。
日期：2026-09-21。

本文件承接 [milestone-problem-formulation.md](milestone-problem-formulation.md) 的 M1–M6
（M1–M5 已实现，M6 部分完成），只补充一个增量：distillation 之后走两条独立的反馈路，
而不是把 Frame 当作 belief set 的下一站。

同 M1–M6 的约定，文件中的工具名、事件名和交互入口是实现建议；产品行为以“已确认决策”
与“已确认边界”为准。

## 问题

在此之前，文档与实现都把循环描述成串行的 `belief → Frame`：distill 裁定 beliefs，propose 之后
再决定是否修订 Frame。两路反馈的说明已写入 [belief-loop-roles.md](belief-loop-roles.md) 与
[epistemic-view-skeleton.md](epistemic-view-skeleton.md)，但运行时尚未按它运转。串行读法会让
两件不同的事看起来像一件事的先后步骤：

- 证据裁定（belief 的真值/证据状态）：哪些判断被支持、反驳，哪些仍不确定。
- 问题理解（相关性与注意力）：当前理解是否仍然在合理地组织这个任务，解释边界、关注
  重点或调查方向是否需要改变。

串行表述带来两个具体缺陷：

1. **异常必须先变成 belief 才能影响 Frame。** 实际观察里经常出现“某些现象当前 belief set
   解释不了，但还不足以给任何一条 belief 下定论”。这类 residual 只留在 distill 的会话文本里：
   `DistillationProduced` 的 `contents` 仅存成功的 `declare_belief` 工具结果文本；一条这样的
   结果都没有时该事件不发出（`belief-loop-controller.ts:1637-1657` 的
   `if (lines.length === 0) return;`，过滤条件是 `toolName === "declare_belief" && !isError`
   且 text block 非空），因此异常既不进入领域记录，也不构成 propose 必须处理的动作。
2. **重审变成一次性动作。** 现有强制点 `formulationDecisionOwed` 只要求 propose 在已派发实验后
   做过一次发布或暂缓决定，且发布一次即永久结清（`domain-model.md` 的 “A published version
   settles the decision for good”）。已有的 `formulationReview`（schema v5）区分的是“修订版本
   是否得到用户回应与 focus 重审”，不是“这一轮蒸馏后是否重审过当前理解、结论是什么”。因此
   没有记录能区分“本轮重审后维持不变”与“本轮根本没有重审”。

本次确认把这两条分开处理：第 1 条按决策 1 选 B 接受为已知限制（residual 仍只以会话文本承载，
不可回放、不可分支隔离），第 2 条由决策 3、4、5 都选 A 修掉。决策 4 选 A 也补上了第 1 条真正
影响行为的那一半：residual 不落记录，但它所在的那一轮必然被 propose 重审——跳过检查没有出口，
只是检查的依据读不回结构化的异常清单。

## 设计

两条路各自独立，都从 distillation 出来，又在 propose 汇合：

```text
                         +--> 裁定 --> belief set 更新
observation --> distill
                         +--> residual --> 异常 / 解释缺口 / 修订建议
                                                    |
                                                    v
                                     propose 重审当前 Frame
                                     （任务 + 用户意图 + 当前 Frame + 更新后的 beliefs）
```

区分四件事，避免任何一件被另一件替代：

| 动作 | 回答的问题 | 谁做 |
|---|---|---|
| 裁定 | 哪些 judgment 被支持、反驳或仍不确定 | distill（`declare_belief`） |
| 异常记录 | 当前 belief set 还解释不了什么 | distill，交 propose 使用 |
| 重审 | 当前理解是否仍成立、什么观察会迫使它改变 | propose |
| 发布版本 | 理解、关注重点或调查方向有实质变化 | propose（`set_formulation`） |

表中的“异常记录”是设计要求（异常必须作为独立于 belief 裁定的信息进入 propose）。决策 1 选 B：
它以 distill 散文承载，不新增事件；决策 2 选 A 规定其呈现单位是“一条 residual 含多个观察，
每个观察附来源”。所以“异常进入 propose”靠的是 distill 轮次的文本进入 propose 上下文，而不是
一条可回放的记录——这是明确接受的代价（决策 1），不是仍待补的缺口。

要点：

- **两路不是互相替代。** belief 集合没有变化，仍可能需要重审（新证据让已有的关系变得重要，
  或任务重点移动）；belief 集合变化也不强制修订 Frame。
- **重审是常规动作，发布是稀有动作。** 每轮都重审，只有实质变化才创建版本；完全相同内容
  的重复提交仍是运行时无操作（沿用已确认决策 6）。
- **residual 不是 Frame 的证据。** 如果异常隐含一条会影响行动、但尚未验证的经验判断，它必须
  转成 belief 去检验；重审不能把异常当成支持某条 belief 的证据，也不能因为替代解释不再优先
  就把它标为 refuted（沿用“Frame 不能充当证据”）。
- **重审不等于免债。** 重新表述不结清未裁定的 belief，也不清除被打断实验的观察；未裁定责任
  与结论门槛按现有规则保留。
- **用户纠正优先于重审。** 待处理纠正仍按现有规则打断执行并交回 propose；重审不改变该顺序。

### 不因选项取舍而削弱的要求

下列三件事是本次讨论确定的需求，不由决策 1–7 的任何一种选法取消；已确认的选择满足它们：

- **检查必须发生，且独立于裁定。** 每次 distillation 之后都要检查当前理解是否仍然成立，
  包括没有 belief 变更、没有已识别异常、结论为“维持不变”的轮次；检查不能只在发现异常时才发生。
- **检查与记录是两件事。** 决策 3、4 决定的是这次检查是否留下可回放的结果、以什么条件要求
  留痕，不是“是否需要检查”。两者都选 A，因此每轮检查都留下可回放的结果，“未重审”与
  “已重审、维持不变”在运行时与界面上都可区分；若改选 B，必须承认代价：运行时无法验证
  检查发生过。
- **发布仍是稀有动作。** 检查发生得多不代表版本多；只有实质变化才创建版本（沿用决策 6）。

对应的验收场景见下节 1、2、4、8。

## 已确认决策

| # | 问题 | 选择 | 确定的行为 |
|---|---|---|---|
| 1 | residual 是否需要结构化记录 | B | 继续只靠 distill 散文：不新增事件、不折叠、不进 snapshot/RPC。代价是 residual 不可回放、不可分支隔离，恢复与压缩后只能靠会话文本。 |
| 2 | residual 的粒度 | A | 呈现单位是“一条 residual 含多个观察”，每个观察保留自己的来源；不按观察逐条记录。决策 1 选 B 时它约束的是 propose 的重审上下文与终端呈现，不是存储单位。 |
| 3 | 重审结果如何记录 | A | 任务级重审记录同时表达“已重审”（附结论：维持／修订／暂缓）与“未重审”，可回放、可分支隔离。它不是 `FormulationApplicabilityRecorded`，也不与它互相替代。 |
| 4 | 何时要求留下重审结果 | A | 每次 distillation 之后都必须出现一次重审记录：没有 belief 变更、没有被标记的异常、结论为“维持不变”的轮次同样要求。没有 distillation 的路径（fast path）不受此门槛约束。 |
| 5 | 重审是否复用现有 formulation 决定 | A | 复用 `formulationDecisionOwed`，把语义从“欠一次发布或暂缓决定”扩展为“本轮 distillation 必须给出一次重审结果”。发布一次即永久结清的旧语义被取代；欠重审时 propose 不能选下一个实验或结案，distill 直接 conclude 同样被改道回 propose。propose 另需一个不创建版本的“维持不变”出口（新增工具或扩展现有工具，属 M7.3 实现细节）。 |
| 6 | 终端与 RPC 如何呈现 | A | 显示“本版本已重审、维持不变”与最近一次重审依据（propose 写在重审记录里的一行理由）。不得把“未重审”显示成“已重审”，也不得暗示存在一份结构化的异常清单；重连后一致。 |
| 7 | 旧的 schema 兼容 | A | 提升领域协议版本并明确拒绝旧日志，沿用 M1–M4 做法：不迁移、不提供别名、不改写或删除用户旧日志。旧日志里没有重审这个概念，新运行时无法把它与“未重审”区分。 |

## 已确认边界

- **不重复已有的适用性审查。** `FormulationApplicabilityRecorded` 表达的是「修订后的理解下，
  旧结论还算不算数」，且只在有 `formulationReview` 待结清时可用；它不能表示「本轮蒸馏后决定
  保留当前理解」。M7 不重复这一机制，也不把它当作逐轮重审结果；重审记录与它并存。
- **重审记录不承载 residual。** 决策 1 选 B，residual 仍只是 distill 文本：重审记录写的是
  「这一轮是否重审过、结论和理由是什么」，不是「这一轮哪些观察未被解释」。两者不能互相推断，
  界面也不得把重审依据显示成一份异常清单。
- 不恢复 framing belief，不引入完成义务、覆盖检查或 framing-discharge 协议
  （见 [framing-belief.md](framing-belief.md)）。
- 不新增平行的 Frame 对象：Frame 仍是任务级 `ProblemFormulation` 版本历史，发布权仍只在
  propose（沿用决策 5）。
- 不改变 belief 的状态语义：`proposed`/`supported`/`refuted`/`inconclusive`/`superseded`
  与证据折叠规则不动。
- 不把 residual 或重审结果写成 belief，也不写进 `BeliefSet`。
- 不要求每轮发布新版本；重复提交无副作用。
- `FocusSet`（`focus_beliefs`）与实验选择（`select_experiment`）的语义不变：重审不自动修改
  关注集合，也不自动使已派发的实验失效；只有发布新版本才作废尚未派发的选择（沿用决策 11）。

## 实施阶段

### M7.1：文档与术语收敛

- [x] 在 `belief-loop-roles.md` 与 `epistemic-view-skeleton.md` 写明 distillation 的两个输出。
- [x] 建立本文件，记录决策项、边界与验收场景。
- [x] 决策 1–7 确认后，把选定的契约写回上述两份文档，并写入
      `milestone-problem-formulation.md` 的后续增量段。

### M7.2：异常进入 propose 的承载（决策 1 选 B、决策 2 选 A）

决策 1 选 B，因此本阶段不新增事件、字段、折叠或快照逻辑；“异常进入 propose”靠 distill 轮次的
文本进入 propose 上下文，交付物是这条路径能成立以及代价被写下来。

- [x] distill 必须能表达未被解释的观察而不必先造出一条 belief：不新增事件、不新增字段。
- [x] 一轮 residual 以整块进入 propose 的 transcript，不拆成逐条条目（逐轮重审上下文本身属
      M7.3，它消费的是同一份文本）。
- [x] 记录已知限制：residual 不可回放、不可分支隔离，恢复与压缩后只能靠会话文本；相应验收项
      从本阶段除去。

实现说明：

- **无需改动运行时。** 投影层对非 probe 的 assistant turn 只剥 thinking
  （`maskEpistemicThinking`，`src/core/belief-loop/message-projection.ts:72-75`），distill 的
  自由文本因此原样进入 propose 的 transcript；distill 分支只要不调用 `conclude` 就必定交回
  propose（`belief-loop-controller.ts` 的 `case "distill"`），该轮一个工具都不调用也一样。
- **覆盖测试** `test/belief-loop-residual.test.ts`：两个场景都断言 propose 实际收到的
  transcript（用 faux provider 的 response factory 读 `context.messages`，也就是 provider
  真正收到的投影结果）。第一个是同一轮“先裁定、后写 residual”，residual 与其单条观察逐行可见、
  并作为一整块出现；第二个是一轮 belief 零变更、也没有为异常新建 belief——residual 仍然到达
  propose。两个用例都做过变异验证（让投影丢弃 assistant 文本即双双失败），不是恒真断言。
- **已知限制**（本阶段确认接受，已从验收中除去）：零 belief 变更的轮次不发出
  `DistillationProduced`（`emitDistillationBlock` 的 `lines.length === 0` 早退），所以该轮的
  residual 在领域记录里没有条目，不参与回放与分支隔离，恢复与压缩后只能靠会话文本。测试把这条
  限制也钉住了：它会在 M7.3 补上“本轮蒸馏过”的可回放标记时被有意更新——变的是那个标记，
  “residual 文本本身不落记录”不变。

验收：未被解释的观察可以在不新增 belief 的情况下进入 propose 的上下文（已验证）。residual
本身不在分支切换与压缩后保持可回放（已知限制，不作为验收项）。

### M7.3：propose 重审动作（决策 3、4、5 都选 A）

- [x] 重审结果可表达“维持当前理解”，且该结果不创建版本、不触发修订通知。
- [x] 任务级重审记录同时表达“已重审（维持／修订／暂缓）”与“未重审”，可回放、可分支隔离，
      并与 `FormulationApplicabilityRecorded` 并存，不合并、不互相替代。
- [x] 把 `formulationDecisionOwed` 的语义扩展为“本轮 distillation 必须给出重审结果”：未重审时
      propose 不能选择下一个实验或结案，distill 的 conclude 同样被改道回 propose。“发布一次即
      永久结清”的旧语义随之作废，`docs/domain-model.md` 的 “The gate is deliberately narrow”
      已按新语义重写。
- [x] 门槛需要“本轮蒸馏过”在回放后可判定：`DistillationProduced` 现在每轮都发出（见下）。
- [x] fast path 没有 distillation，不受重审门槛约束。
- [x] 异常隐含可检验断言时，必须转成 belief 检验，并保留“Frame 不是证据”的约束。

实现说明：

- **记录**：`FormulationRecheck { episodeId, verdict, reason, versionId?, recordedAt }` 落在
  `agent-session-domain.ts`，事件 `FormulationRecheckRecorded` 是任务级的，`Task.formulationRecheck`
  保存最新一条。折叠校验：该 episode 存在且已有 distillation（裁定未结束的轮次不算完成的蒸馏）、
  `reason` 非空、`versionId` 当且仅当 verdict 为 `revised` 且能在 `task.formulations` 里解析、
  轮次序号不倒退。同一轮允许记录两次（先“维持”后“发布”），后写的一条生效。
- **“本轮是否蒸馏过”的可回放标记**：`emitDistillationBlock` 拆成两件事——`emitDistillationEcho`
  仍按轮显示裁定回声（用户看到的行为不变），`recordDomainDistillation` 在本轮 distill
  无事可裁定时写一次记录，因此**零 belief 变更的轮次也有记录**，门槛可在回放后判定。
  `outputs` 改为从回放的 episode 推导（`episode.body.beliefDeltas` 中 `producerPhase === "distill"`），
  与折叠重算的表达式逐字一致：原先读内存累加器，而该累加器在 `rehydrateFromBranch` 被清空却没在
  `adoptReplayedDomainState` 重建，分支切换后写出的记录会与折叠期望不符并抛重放错误。累加器随之删除。
- **门槛**：`formulationDecisionOwed = firstFormulationDecisionOwed || formulationRecheckOwed`。
  两者互斥（前者要求尚无版本，后者要求已有版本），所以 steer 可以按哪一条成立来选；新增
  `TRANSITION_STEERS.formulationRecheck`。未重审时 propose 不能派发下一个实验，也不能结案；
  distill 的 conclude 同样被改道回 propose。裁定债务先于门槛检查，所以有未裁定 belief 的轮次
  根本不算完成的蒸馏，也就不会被要求重审。
- **结清**：新增 propose 专属工具 `recheck_formulation({ reason })`（记 `maintained`）；在欠重审的
  轮次里调用 `set_formulation` 记 `revised`（含**首次**版本——说出理解本身就是那一轮的重审）、
  `defer_formulation` 记 `deferred`。工具在无事可做时拒绝，并且区分两种无事可做：本轮已重审过，
  或尚无当前理解可重审。`set_formulation`/`defer_formulation` 的 `unchanged` 结果文案改为指向
  `recheck_formulation`，避免模型反复重提交同一份内容。
- **修订暂停的洞**：`advanceRole` 在 `awaitingFormulationResponse()` 时直接返回而不调用
  `transition`，因此“在 distill 轮里发布修订”的那一轮原本不会留下 distill 记录；该分支现在补记一次。
- **协议**：v5 → v6，重放报错里的版本变更说明同步更新；`index.ts`/`core/index.ts` 导出
  `FormulationRecheck` 与 `FormulationRecheckVerdict`；`FormulationState` 增加 `recheckOwed` 与
  `recheck`（呈现属 M7.4）。
- **覆盖测试**：`test/suite/formulation-recheck.test.ts`（7 个场景：拦住下一个实验、发布/暂缓各自结清、
  两种拒绝文案、分支与下一任务、fast path 豁免、未裁定轮次不算完成的蒸馏），
  加上 `test/agent-session-domain.test.ts` 的折叠与谓词用例。既有 suite 中蒸馏后直接 conclude
  的脚本逐个补上重审调用。
- **已知限制**（记录为限制，不作为验收项）：进程在 distill 中途中断或恢复时，那一轮不会留下
  distill 记录，因此不会被要求重审——该轮未裁定的 belief 仍由既有未裁定门槛拦住，任务不会因此
  静默完成。

验收：不存在“belief 集合未变所以没有重审”的路径；也不存在“重新表述就跳过未裁定 belief”的路径。

### M7.4：投影与呈现（决策 1 选 B、决策 3 与 6 选 A）

- [x] propose 能读到本轮 residual 的散文（作为 distill 轮次的文本，而不是一条领域记录），以及
      最近一次重审结果；两者都明确标注为立场或待解释项，不是受支持事实。
- [x] 终端与 RPC 快照显示“已重审、维持不变”与最近一次重审依据（propose 写在重审记录里的
      一行理由）；不得把“未重审”显示成“已重审”；重连后一致。
- [x] 因为 residual 不落记录，“依据是哪些观察”只能来自那行理由与 distill 文本，界面不得暗示
      存在一份结构化的异常清单。

实现说明：

- **投影**：`formulationProjection()` 在 `<current_formulation>` 块内补两行——最近一次重审的结果
  （“you reconsidered this reading and kept it / changed it… / recorded that no reading could be
  stated”）与 propose 自己写下的依据，措辞明确标注为立场（“Your stated basis, which is a position
  and not evidence”）；欠重审时只对 propose 追加一行义务说明并点名三个工具，避免向没有这些工具的
  角色（尤其是 execution）点名工具。residual 仍只以 distill 轮次的文本进入上下文（M7.2 已验证），
  不新增字段。
- **紧凑面板**：`FramePanel` 的重审标记只描述**最后一轮**——欠重审显示 `recheck owed`，已重审显示
  `rechecked · kept the reading | reading revised | deferred`，两者互斥，避免同一轮看起来有两个答案；
  首次理解的欠账仍显示 `decision owed`。
- **`/frame` 详情**：新增 “Reconsidered” 段：维持／修订（点名版本）／暂缓，随后是 “The agent's
  stated basis:”，不列任何“未解释的观察”——residual 没有可回放的条目，界面不得暗示有。
- **RPC**：`FormulationState` 的 `recheck` 与 `recheckOwed` 在 M7.3 已暴露，快照与面板读同一份
  回放状态，因此重连后一致。`interactive-mode` 的领域事件 switch 增加
  `FormulationRecheckRecorded` 以触发重绘（此前新事件类型会被静默忽略）。
- **覆盖测试**：`test/frame-panel.test.ts` 的“tells a reconsidered reading apart from one nobody has
  looked at yet”（三种 verdict + 欠重审，含 24/40/60 列宽度），以及
  `test/suite/formulation-recheck.test.ts` 中捕获 propose 实际收到的 system prompt 两处断言。

验收：用户能看出 agent 是否重审过当前理解，以及它给出的理由；界面不暗示一个没有被记录过的
检查发生过，也不暗示 residual 有可回放的条目。显示不依赖不可配置快捷键。

### M7.5：回归验证

- [x] 用 faux provider 的确定性场景覆盖下节验收场景 1–8。
- [x] 协议版本提升（v5 → v6）并明确拒绝旧日志；记录 GUI 消费者适配仍待做。
- [x] 随实现更新文档状态，区分已实现契约与尚未完成的阶段。
- [x] 全部代码检查通过，记录协议变更。
- [ ] 终端人工验证（见下）——不由实现方代为勾选。

实现说明：

- **场景 → 测试**（全部使用 faux provider，不调用真实 provider）：

  | 场景 | 覆盖 |
  |---|---|
  | 1 异常不足以改变 belief 但触发重审 | `test/belief-loop-residual.test.ts`（同轮先裁定后写 residual；零变更轮的 prose residual）；`test/suite/formulation-recheck.test.ts` 用例 1、2 |
  | 2 重审结论为维持不变 | `formulation-recheck.test.ts` 用例 1（不创建版本、无修订通知、依据可查）；`test/frame-panel.test.ts`（界面显示 `rechecked · kept the reading` 与依据） |
  | 3 异常必须可检验 | `formulation-recheck.test.ts` 的“keeps residual out of the belief record”：residual 不成为 belief、不进任何 belief 的证据、只存在于那一轮的文本 |
  | 4 两路不互相替代 | `formulation-recheck.test.ts` 用例 1（两轮都重审、版本仍只有一个）；`belief-loop-residual.test.ts` 用例 2 |
  | 5 未裁定责任保留 | `formulation-recheck.test.ts` 末例（未裁定轮次不算完成的蒸馏）；`test/suite/formulation-decision.test.ts` 用例 4 |
  | 6 纠正优先 | `formulation-recheck.test.ts` 的“answers a user correction before the round it interrupted is reconsidered”：纠正到达且模型跳过时，循环先交回纠正，`FormulationCorrectionResolved` 早于 `FormulationRecheckRecorded` |
  | 7 恢复与分支 | `formulation-recheck.test.ts` 用例 5（分支切换后该轮的欠账仍在、新任务不继承）与压缩用例（压缩前后一致）；residual 本身不可回放是已知限制，不在本场景范围内 |
  | 8 没有异常也必须检查 | `belief-loop-residual.test.ts` 用例 2（零 belief 变更轮次仍有 distillation 记录与重审）；`formulation-recheck.test.ts` 用例 1 |

- **协议变更**：领域协议 v5 → v6（新事件 `FormulationRecheckRecorded`、新字段
  `Task.formulationRecheck`）；v5 日志被明确拒绝（`DomainReplayError`），不迁移、不提供别名、
  不改写用户旧日志，理由见 [domain-model.md](domain-model.md) 的 “Protocol versioning and old
  logs”。同一处补上了 `DistillationProduced` 现在每轮都发出（零变更轮次在 v5 里不可见）。
- **GUI 消费者适配仍待做**：`gui/src/Model.cpp` 仍按 v1 事件名与 `frameId` 解析，既不识别
  `FormulationRecheckRecorded` 也不识别 v2 起的 `episodeId`；本次的呈现实现在终端侧
  （`FramePanel`/`FrameDetailPanel`），原生 GUI 不共享。适配完成前原生 GUI 与 v6 运行时不兼容
  ——这与 M1–M6 的既有结论一致，不是本次新增的依赖。
- **文档状态**：`milestone-problem-formulation.md` 的后续增量段、`belief-loop-roles.md` 与
  `epistemic-view-skeleton.md` 的相关段落已改为描述已实现的契约；`docs/README.md` 的索引
  标注从 “planned” 改为 “M7.1–M7.4 implemented”。
- **仍未完成的终端人工验证**：需要按仓库的交互测试说明在真实终端确认——(a) 一轮蒸馏后 dock
  面板出现 `recheck owed`，模型回答后变为 `rechecked · kept the reading`；(b) `/frame` 里能看到
  verdict 与 propose 写下的依据，且没有任何“未解释的观察”清单；(c) 欠重审时模型既不能派发下一个
  实验也不能结案；(d) RPC 重连与分支切换后显示一致；(e) 24/40/60 列下中英文内容都可读。这些在
  自动化测试里已覆盖到渲染与状态层（`test/frame-panel.test.ts`、`formulation-recheck.test.ts`），
  但 TUI 的实际接线（键盘、重绘、重连）只有人工能确认，因此该复选框保持未勾选。

## 关键验收场景

1. **异常不足以改变 belief 但触发重审**：实验后 residual 指出未被解释的现象；distill 裁定
   tested beliefs 后记录该现象；propose 在没有任何 belief 新增或改判的情况下重审并说明结论。
2. **重审结论为维持不变**：propose 明确维持当前理解；不创建版本、不通知修订。“已重审”状态
   可在界面与快照中查到，重连后一致，依据是 propose 写下的那行理由。随后仍可正常选择下一个实验。
3. **异常必须可检验**：residual 隐含会影响行动的未验证断言时，它被转成 belief 并检验，而不是
   直接充当 Frame 的依据。
4. **两路不互相替代**：没有 belief 变化的一轮仍然出现重审；有 belief 变化但不影响理解的
   一轮不产生新版本。
5. **未裁定责任保留**：重审、维持或修订都不清除未裁定 belief 的责任，结论门槛不被绕过。
6. **纠正优先**：重审期间收到用户纠正时，仍按现有规则在工具边界交回 propose 并逐条回应。
7. **恢复与分支**：重审结果与版本历史在恢复、压缩与分支切换后一致；新任务不继承上一任务的
   当前理解。决策 1 选 B，residual 本身不落记录，因此它的恢复一致性明确不在本场景范围内。
8. **没有异常也必须检查**：一轮 distillation 没有产生任何 belief 变更、也没有被标记的异常时，
   仍然发生一次对当前理解的检查（结论可以是维持不变）；不得以“没有异常”作为跳过检查的理由。
   决策 3、4 都选 A，因此这一轮同样留下可回放的重审记录——包括那些连 `DistillationProduced`
   都没有发出的零变更轮次。

## 验证方式与范围

实现改动限于 packages/pie。需要触及其他目录的实现依赖应单独提出。
核心测试使用确定性事件与 faux provider，不调用真实 provider。定向 Vitest 在
packages/pie 根目录执行；每个新建或修改的测试文件单独运行。代码修改后运行
`npm run check` 并处理全部报告项，不运行 `npm run build` / `npm test` / 全量 Vitest。
原生 GUI 展示与旧协议消费者适配仍是后续依赖。

## 现有实现与差距

已实现（本文件的依据）：

- distill 的角色提示已有两个有序步骤，并写明 `Evidence settles existing beliefs. Residual
  exposes missing beliefs or reframing.`（`src/core/role-specs.ts:155-159`）。
- 裁定确实独立于理解：distill 只有 `declare_belief` / `view_beliefs` / `conclude`，没有发布
  formulation 的权力；发布工具 `set_formulation` / `defer_formulation` 独属 propose
  （`src/core/role-specs.ts:27-28`、`src/core/tools/formulation.ts:148,173`）。
- distillation 有记录，但内容是 belief 变更的回显：`DistillationProduced` 携带
  `Distillation { id, inputs, contents, outputs }`（`src/core/agent-session-domain.ts:610`），
  折叠时校验 `outputs` 必须与该 episode 中 distill 产生的 belief deltas 完全一致（同文件
  `case "DistillationProduced"`）。`contents` 由 `emitDistillationBlock` 从 `declare_belief` 的
  工具结果文本拼成（`src/core/belief-loop/belief-loop-controller.ts:1637-1657`），不含 distill
  轮次的自由文本；没有成功的 `declare_belief` 文本结果时（`if (lines.length === 0) return;`）
  该事件不发出，因此那次蒸馏在领域记录中没有条目。
- 已有“修订后旧结论是否仍适用”的审查：`FormulationApplicabilityRecorded` 携带
  `{ versionId, entries }`，注释写明它记录“the previous reading's conclusions mean under this
  one”（`src/core/agent-session-domain.ts:575-582`）；`recordApplicability` 在没有待结清的
  `formulationReview` 时报错 `no reading is waiting for a review of the beliefs it affects`
  （`src/core/belief-loop/belief-loop-controller.ts:622-655`），即它只在发布新版本后可用。
- 已有版本绑定的重审状态：发布（含首版）会创建任务级 `formulationReview`
  `{ versionId, responseCorrectionId?, focusReviewed: false }`，要求用户回应后由 propose 调用
  `focus_beliefs` 结清（`docs/domain-model.md` 的 “Publication response and focus review”、
  `src/core/agent-session-domain.ts:315-334,491`）。

尚未实现（M7 的范围）：

- residual 没有独立记录：`grep -rn -i "residual|anomal" src` 只命中提示与描述文本
  （`src/core/role-specs.ts:115,152,153,157,265,266,271`、`src/core/tools/declare-belief.ts:330`），
  领域事件类型中没有 residual/anomaly 事件，也没有对应字段或折叠逻辑；异常只留在会话消息里。
  M7.2 确认这条路径本身成立（散文 residual 能到达 propose），因此它不再是待补的缺口，而是
  决策 1 选 B 接受的限制。
- 没有“本轮是否重审过”的状态：`formulationReview` 只在发布新版本后存在，结清的是“用户回应 +
  focus 重审 + 新理解下既有 beliefs 的分类”；`formulationDecisionOwed` 只鉴别“是否做过一次
  发布或暂缓决定”，且发布一次即永久结清（`docs/domain-model.md` 的 “The gate is deliberately
  narrow”）。两者都不能表示“本轮蒸馏后重审过当前理解并决定维持不变”。
- 因此现在的运行时不保证每轮把异常送进重审，也不保证重审发生过；本文件的设计属于待实现
  要求，不是已实现契约。
