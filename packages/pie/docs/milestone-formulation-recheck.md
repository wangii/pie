# Milestone：distillation 的两路反馈与 Frame 重审（规划中）

状态：设计说明已写入 [belief-loop-roles.md](belief-loop-roles.md) 与
[epistemic-view-skeleton.md](epistemic-view-skeleton.md)；运行时增量 M7 尚未实现。
日期：2026-09-21。

本文件承接 [milestone-problem-formulation.md](milestone-problem-formulation.md) 的 M1–M6
（M1–M5 已实现，M6 部分完成），只补充一个增量：distillation 之后走两条独立的反馈路，
而不是把 Frame 当作 belief set 的下一站。

同 M1–M6 的约定，文件中的工具名、事件名和交互入口是实现建议；产品行为以“待确认决策”
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

表中的“异常记录”是设计要求（异常必须作为独立于 belief 裁定的信息进入 propose），不是已选定的
机制：它是否要成为可回放的记录、以什么粒度、用什么形式，仍由待确认决策 1、2、7 决定。本文件
不预设必然是新增事件。

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

### 不因待确认选项削弱的要求

下列三件事是本次讨论确定的需求，不由决策 1–7 的任何一种选法取消：

- **检查必须发生，且独立于裁定。** 每次 distillation 之后都要检查当前理解是否仍然成立，
  包括没有 belief 变更、没有已识别异常、结论为“维持不变”的轮次；检查不能只在发现异常时才发生。
- **检查与记录是两件事。** 决策 3、4 决定的是这次检查是否留下可回放的结果、以什么条件要求
  留痕，不是“是否需要检查”。若选择不区分「已重审/未重审」，必须承认代价：运行时无法验证
  检查发生过。
- **发布仍是稀有动作。** 检查发生得多不代表版本多；只有实质变化才创建版本（沿用决策 6）。

对应的验收场景见下节 1、2、4、8。若某个选项使这几条无法成立，该选项应被判为不合格，而不是
修改这些场景。

## 待确认决策

| # | 问题 | 选项 | 影响的契约 |
|---|---|---|---|
| 1 | residual 是否需要结构化记录 | A 需要任务级记录（可回放、可分支隔离） / B 继续只靠 distill 散文 | 决定 M7.2 是否要新增事件与折叠逻辑 |
| 2 | residual 的粒度 | A 一条 residual 可含多个未被解释的观察，附来源 / B 每条观察单独记录 | 决定回放与 UI 的展示单位 |
| 3 | 重审结果如何记录 | A 记录“已重审、维持不变”与“未重审”两种状态 / B 只记录发生变化的版本（运行时无法验证检查是否发生） | 只影响可验证性，不影响“每次蒸馏后都要检查”的要求 |
| 4 | 何时要求留下重审结果 | A 每次 distillation 之后都必须出现一次记录 / B 仅在 residual 非空或存在待处理纠正时才要求记录（检查本身仍每轮发生） | 决定记录频率；选 B 时需在 M7.3 验收中显式列出未覆盖的情形 |
| 5 | 重审是否复用现有 formulation 决定 | A 复用 `formulationDecisionOwed` 并把它的语义扩展到“必须给出重审结果” / B 新增独立的 propose 动作 | 决定是否新增 propose 工具与事件 |
| 6 | 终端与 RPC 如何呈现 | A 显示“本版本已重审、维持不变”与最近一次重审依据 / B 只在有修订时显示 | 决定用户能否看出 agent 没有跳过重审 |
| 7 | 旧的 schema 兼容 | A 提升领域协议版本并明确拒绝旧日志（沿用 M1–M4 做法） / B 复用现有事件字段 | 决定是否再次破坏性升级 |

## 已确认边界

- **不重复已有的适用性审查。** `FormulationApplicabilityRecorded` 表达的是「修订后的理解下，
  旧结论还算不算数」，且只在有 `formulationReview` 待结清时可用；它不能表示「本轮蒸馏后决定
  保留当前理解」。M7 不重复这一机制，也不把它当作逐轮重审结果。
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
- [x] 建立本文件，记录待确认决策、边界与验收场景。
- [ ] 待决策 1–7 确认后，把选定的契约写回上述两份文档，并写入
      `milestone-problem-formulation.md` 的后续增量段。

### M7.2：异常进入 propose 的承载（依赖决策 1、2、7）

本阶段的交付物依决策 1 而异，两种选法都不能以“把异常写成 belief”为唯一出口：

- 若选 A（结构化记录）：选定承载形式并实现记录、折叠、快照与恢复。
- 若选 B（继续只靠 distill 文本）：明确接受的代价（不可回放、不可分支隔离、无法在 UI 区分
  “未重审”与“重审无异常”），并把这部分从验收中除去；此时不需要新增事件。

- [ ] 无论选哪种，distill 都必须能表达未被解释的观察而不必先造出一条 belief。
- [ ] 回放后异常及其与当前版本、纠正、未裁定责任的相对顺序保持一致（选 A 时验证；选 B 时
      记录为已知限制）。

验收：未被解释的观察可以在不新增 belief 的情况下进入 propose 的上下文；选 A 时还需在分支
切换与压缩后不丢失、不串分支。

### M7.3：propose 重审动作（依赖决策 3、4、5）

- [ ] 重审结果可表达“维持当前理解”，且该结果不创建版本、不触发修订通知。
- [ ] 区分“已重审”与“未重审”；未重审时 propose 不能选下一个实验或结案（若决策 4 选 A）
      或仅在有 residual/纠正时受限（若选 B）。
- [ ] 异常隐含可检验断言时，必须转成 belief 检验，并保留“Frame 不是证据”的约束。

验收（以决策 4 选 A 为前提；若选 B，则只要求在有异常或待处理纠正时出现重审结果）：
不存在“belief 集合未变所以没有重审”的路径；也不存在“重新表述就跳过未裁定 belief”的路径。

### M7.4：投影与呈现（依赖决策 1、3、6）

- [ ] propose 与 distill 能读到最近一次被标记的异常与最近一次重审结果（后者依决策 1、3；
      若这些选项选 B，则只要求投影能在上下文中区分“已检查过”与“未检查”），且明确标注为
      立场或待解释项，不是受支持事实。
- [ ] 终端与 RPC 快照能显示“已重审、维持不变”与重审依据（需决策 3 选 A）；选 B 时至少
      不得把“未检查”显示成“已重审”。重连后一致。

验收（依决策 3 的选法）：选 A 时用户能看出 agent 是否重审过当前理解，以及依据是哪些观察；
选 B 时界面不得暗示一个没有被记录过的检查发生过。显示不依赖不可配置快捷键。

### M7.5：回归验证

- [ ] 用 faux provider 的确定性场景覆盖下节验收场景 1–8。
- [ ] 随实现更新文档状态，区分已实现契约与尚未完成的阶段。
- [ ] 全部代码检查通过，记录协议变更；不做终端人工验证不算完成。

## 关键验收场景

1. **异常不足以改变 belief 但触发重审**：实验后 residual 指出未被解释的现象；distill 裁定
   tested beliefs 后记录该现象；propose 在没有任何 belief 新增或改判的情况下重审并说明结论。
2. **重审结论为维持不变**：propose 明确维持当前理解；不创建版本、不通知修订。（若决策 3 选 A：
   “已重审”状态可在界面与快照中查到。）随后仍可正常选择下一个实验。
3. **异常必须可检验**：residual 隐含会影响行动的未验证断言时，它被转成 belief 并检验，而不是
   直接充当 Frame 的依据。
4. **两路不互相替代**：没有 belief 变化的一轮仍然出现重审；有 belief 变化但不影响理解的
   一轮不产生新版本。
5. **未裁定责任保留**：重审、维持或修订都不清除未裁定 belief 的责任，结论门槛不被绕过。
6. **纠正优先**：重审期间收到用户纠正时，仍按现有规则在工具边界交回 propose 并逐条回应。
7. **恢复与分支**：residual 记录、重审结果与版本历史在恢复、压缩与分支切换后一致；新任务
   不继承上一任务的当前理解，也不继承其 residual。
8. **没有异常也必须检查**：一轮 distillation 没有产生任何 belief 变更、也没有被标记的异常时，
   仍然发生一次对当前理解的检查（结论可以是维持不变）；不得以“没有异常”作为跳过检查的理由。
   这一场景不因决策 1、3、4 的任何选法而取消，只决定它是否留下可回放的痕迹。

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
  `formulationReview` 时报错 `no revision is waiting for a review of the beliefs it affects`
  （`src/core/belief-loop/belief-loop-controller.ts:622-655`），即它只在发布新版本后可用。
- 已有版本绑定的重审状态：修订（ordinal > 1）会创建任务级 `formulationReview`
  `{ versionId, responseCorrectionId?, focusReviewed: false }`，要求用户回应后由 propose 调用
  `focus_beliefs` 结清（`docs/domain-model.md` 的 “Revision response and focus review”、
  `src/core/agent-session-domain.ts:315-334,491`）。

尚未实现（M7 的范围）：

- residual 没有独立记录：`grep -rn -i "residual|anomal" src` 只命中提示与描述文本
  （`src/core/role-specs.ts:115,152,153,157,265,266,271`、`src/core/tools/declare-belief.ts:330`），
  领域事件类型中没有 residual/anomaly 事件，也没有对应字段或折叠逻辑；异常只留在会话消息里。
- 没有“本轮是否重审过”的状态：`formulationReview` 只在发布新版本后存在，结清的是“用户回应 +
  focus 重审 + 新理解下既有 beliefs 的分类”；`formulationDecisionOwed` 只鉴别“是否做过一次
  发布或暂缓决定”，且发布一次即永久结清（`docs/domain-model.md` 的 “The gate is deliberately
  narrow”）。两者都不能表示“本轮蒸馏后重审过当前理解并决定维持不变”。
- 因此现在的运行时不保证每轮把异常送进重审，也不保证重审发生过；本文件的设计属于待实现
  要求，不是已实现契约。
