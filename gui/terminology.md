# PIE Native GUI 专用术语表（Terminology）

本表整理 `gui/` 代码库（PIE Native GUI）在源码、模块注释与文档中出现的专用术语，重点覆盖 UI 组件及其相关边界。术语来源为仓库中的真实标识符与约定，非自造词；每项给出规范的英文拼写、含义与在代码中的出处。

> **v7 重写已完成（M0–M10）。** `docs/milestones.md` 是本次重写的唯一交付计划，`docs/archive/roadmap/` 是归档的旧路线图（不再维护）。
>
> 重写删除了三栏文本工作区（`BeliefLane` / `CognitiveLane` / `ExecutionLane` / `LogListBox` / `Summary` / `UiShared` / `LayoutMetrics` 的几何）与遗留的独立查看器 `gui/main.cpp`；下表中标有「已删除」的词条**在源码中已不存在**，保留在此仅用于对照历史。
>
> 新增的层次：`Bootstrap` / `EventQueue`（M3）、v7 graph 投影与布局（M4/M5）、`BeliefListModel`（M6）、`TraceModel` / `TracePane`（M7）、`FormulationView` / `FramePane`（M8）、`ShellLayout` / 面板接线（M9）。

## 写作约定（Conventions）

- 术语一律使用源码中的英文原名，不做本地化改写，以保证与代码一致。
- 每条术语给出：中文释义、英文原名、含义、出处（文件/函数/注释）。
- 本文件采用与根 `README.md` 一致的双语结构（中文标题 + 英文括注或正文）。

## UI 组件（UI components）

UI 层由若干独立的 `render*` 组件函数组成，每个组件只读模型，不修改模型。

| 术语 | 含义 | 出处 |
|------|------|------|
| **Status Bar**（状态栏） | 显示 session/frame/stage 指示器与 EXECUTING 阶段的当前工具；纯显示。 | `src/StatusBar.h` `renderStatusBar` |
| **Belief Lane**（信念集栏）【已删除（M1）】 | 渲染当前信念集合（belief set）的三条栏之一。每行可带两条独立的左侧强调标记：`kAccent`（挂在行左侧槽内）表示该信念被**当前帧的 plan 选中**；`kFocusAccent`（画在行内左边缘）表示该信念在**任务关注范围内**。后者画在行内而非槽内，因为行左槽只有几像素宽、已被前者占用，第二条会被子窗口裁剪矩形裁掉。 | `src/BeliefLane.h` `renderBeliefLane` |
| **Cognitive Lane**（认知过程栏）【已删除（M1）】 | 渲染认知过程（plan/execution/distillation）的三条栏之一。 | ~~`src/CognitiveLane.h`~~ |
| **Execution Lane**（执行栏）【已删除（M1）】 | 渲染执行轨迹（工具调用与输出）的三条栏之一。 | ~~`src/ExecutionLane.h`~~ |
| **Lane**（栏）【已删除（M1）】 | 主工作区中并排（或窄窗时垂直堆叠）的三列内容区域；有左/中/右三条。 | ~~`src/LayoutMetrics.h` `laneRects`~~ |
| **Panel**（面板，M9） | 取代 lane 的工作区单元：belief / trace 两个可停靠面板，由 `ShellLayout` 给出矩形；file list 是浮动选择器。开合由 `Cmd/Ctrl+B` / `Cmd/Ctrl+T` 控制。**Frame 面板已不是停靠面板**：它整体进入 `FramePane` 的浮动窗，由 `:`/Enter 唤出、Esc 关闭。 | `src/ShellLayout.h` |
| **Summary**（当前帧摘要）【已删除（M1）】 | 渲染当前循环帧（loop frame）的摘要。 | ~~`src/Summary.h`~~ |
| **Footer**（底部栏） | 渲染四个信念循环角色（Epistemic/Planner/Distillation/Execution）的模型与缓存命中率，以及累计会话成本；单行紧凑行，钉在工作区底部。 | `src/Footer.h` `renderFooter` |
| **Prompt Palette / FramePane**（提示面板 → Frame 面板，M8） | 由 `PromptPalette` 演化而来。**它是一个窗口、一个界面**（`renderFramePane`）：上半是**读法**（`FormulationView` 渲染出的状态横幅、三个动作（见 Frame Actions）、当前 Frame、sources、deferral、corrections、review 义务、recheck、版本历史），下半是**回话**（保留 v1 的多行输入 + Cmd/Ctrl+Enter、`@` 补全、prompt 历史、归档回复翻页与流式 markdown 回复）。横幅与两个动作**钉住不滚动**，只有 Frame 正文滚动——长读法不能把 Approve 滚到手够不着的地方。M8 曾把两半拆成「停靠面板 + 浮动窗」，之后又合回一个窗口：拆分让 Frame 在工作区里没有自己的位置，而两半都只能靠一个界面上没有任何提示的按键唤出。提交按钮文案写明 `Send (does not approve the Frame)`——普通 prompt **永不**释放 pause。 | `src/FramePane.h` |
| **Frame Actions**（Frame 三个动作，M8/后改） | 面板顶部**始终显示**的一行/两行控件：`Approve`（同意**屏幕上**这一版读法，仅当有读法在等待时可用）、`Auto-approve`（同意**尚未写出**的读法，是会话级设置，不是对当前版本的同意）、objection 输入框 + `Submit objection`（**不是**同意，任何时刻都可提交）。不可用时**照画不误**并灰显，下面一行短句说明原因——隐藏动作那一版让被暂停的用户看到的是一片空白，分不清「这个面板没有动作」和「动作在别处」。原因必须**短**：窗口只有应用宽度的 72%，窄窗下长句会折成七行，把动作本身挤出面板。`Auto-approve` 是复选框而不是第二个按钮，因为它绝不能被误当成「同意当前这一版」；打开它**会立刻批准正在等待的那一版**，tooltip 必须写明。 | `src/FramePane.cpp` `renderActions` |
| **State Refresh**（状态重读） | 暂停没有事件：`awaitingResponse` 只出现在 `get_state` 响应体里，任何 domain 事件与 `session_status` 都不携带它。因此只在连接时问一次 `get_state` 的客户端**永远学不到**运行中途停下来问了用户一句话，那个本该亮起的 Approve 按钮就一直是灰的。`NativeGuiModel` 在 `agent_settled`（运行时 `_autoApproveWaitingFrame` 所在的同一条边界）上标记一次重读请求，App 每帧消费它并发出一条 `get_state`；`Bootstrap::ingest` 在 Live 阶段同样应用 `get_state` 响应，所以这就是连接序列用过的同一条命令。**这是边界上的重读，不是轮询**——不要放到定时器上，也不要从日志推导暂停。三个动作各自也请求一次，因为它们改的是 domain 日志不承载的运行时状态。 | `src/Model.h` `requestStateRefresh`；`src/App.cpp` |
| **Frame Banner**（状态横幅，M8） | 面板顶部的**恰好一种**状态：`Waiting for your response` / `Approved — continuing` / `Approved — no run continuing` / `Approval continuation failed: {reason}` / `propose owes a reading` / `owes a reconsideration of episode #{ordinal}`。优先级即设计：**用户要动手的**排在**智能体欠账的**之前，因为前者运行已暂停。Approve 是唯一的主按钮，且仅在 `awaitingResponse` 时可用。 | `src/FormulationView.h` `FrameBanner` |
| **FormulationView**（Frame 视图，M8） | 面板的内容，来自**两个不等权威**的来源：由 domain 记录派生的部分（当前版本、review、deferral、corrections、recheck、两个 *Owed）与 `get_state` 的**运行时事实**（`awaitingResponse` / `approved` / `resume`）。后者不可重放——重放能还原「批准」，还原不了「批准之后的那个 turn 有没有跑起来」——因此原样携带、绝不在此重算。 | `src/FormulationView.h` |
| **Source Chip**（出处 chip，M8） | `sources[]` 的每一条渲染成一枚 chip：belief chip 打开 belief 面板，execution/distillation chip 把 canvas 居中到该节点，prompt/intervention chip 无处可去因而**不可点**（一个点了没反应的链接比纯文本更糟）。这是第一个让 `sources[]` 可审计的界面。 | `src/FormulationView.cpp` `formulationChips` |
| **Changed Fields**（变化字段，M8） | 版本历史里相邻两版之间**哪些字段**变了（`interpretation`/`focus`/`alternative`/`tension`/`implication`/`reason`）。**不做文本 diff**：比较两个被记录的值是事实，比较它们的措辞是对智能体意图的解读，而 GUI 不做解读。 | `src/FormulationView.cpp` `formulationChangedFields` |
| **Navigator**（帧导航器）【已删除（M1）】 | 历史帧导航。 | — |
| **Pane**（窗格） | 当前流程步骤所在的子区域。**M1 之后 `paneBg` 一度无调用者**：它的两处调用方（`CognitiveLane.cpp` 与 `App.cpp` 的执行栏区域）随文本工作区一并删除。该动画是唯一被用户批准的动画，不随之作废——M5 已完成 `docs/milestones.md` §6.3 要求的重定向：canvas 的 current-node halo 调用 `paneBg(true)` 得到脉冲环，沿用同一条 black ↔ `kPaneBgDark` 正弦关系。`GraphView.cpp` 现在是它唯一的调用者。名字保留不改：它叫 "pane" 是因为用户当年是在 pane 上批准的，改名会让这次重定向看起来像是第二种动画。 | `src/Theme.h` `paneBg`；调用者 `src/graph/GraphView.cpp` |
| **Halo**（当前节点光环，M5） | 光标所指 station 外围的脉冲环。它是 `paneBg` 动画的新落点，**不是**新动画。光标 stage 为 `closed` 时不脉冲，改为常亮暗环：那表示「这一轮在这里结束了」，而不是「这里正在做事」。 | `src/graph/GraphView.cpp`；`GraphStyle::currentHaloWidth` / `currentHaloColor` |
| **Dot**（节点圆点，M5） | v7 canvas 上节点的全部几何：一个圆心 + 半径，没有宽高。因此命中测试与 tooltip 都是**按半径**的，`GraphRect` 只用于 band（rail / row gutter / outcome strip）。取代 v1 的 200×60 卡片。 | `PieGraphLayout.h` `Dot` |
| **Episode Row / Gutter**（回合行与其行槽，M4/M5） | 一个 `ExecutionEpisode` 一行，按 ordinal 自上而下堆叠；行槽里画分隔线与 ordinal 标签（行锚点本身也是一个 node，family 为 `EpisodeRow`）。行**不是**容器：v1 那种带标题的方框在 §6.3 被剪掉了。 | `GraphModel.h` `EpisodeGutter` |
| **Version Rail / Belief Rail**（Frame 轨与信念轨，M4） | 两条刻意置于回合链之外的 rail：Frame 轨在顶部横向，按 `previousVersionId` 串起 `ProblemFormulationVersion`；信念轨在左侧纵向，按记录顺序排列全局 belief。rail 上的元素是**追加型**的，因此 `GraphLive` 可以安全地冻结它们的位置。 | `PieGraphLayout.h` `versionRail` / `beliefRail` |
| **Belief Row**（信念行，M6） | belief 面板的一行。`label`（`B7`）由记录顺序在构建时算出，绝不存储；`status` 取自 `Belief::status()` 的派生结果。`focusDeclared == false` 与「已声明但为空」必须能区分显示。被顶替的 belief 内联展示整条链（`B7 → B12 → B19`）与链头状态，避免读成死胡同。 | `src/BeliefListModel.h` `BeliefRow` |
| **Belief Pane**（信念面板，M6/M9） | 停靠面板，渲染 Belief Row 并自带 sort / filter 工具条。行分两行画：第一行是固定列（label/status/domain/evidence/focus 标记），第二行是被 `Indent` 的 statement。原因很实际——面板通常只有窗口的三分之一宽，把列和 statement 挤在同一行会让 statement 每行只放得下一个字。 | `src/BeliefPane.h` `renderBeliefList` |
| **Supersession Chain**（顶替链，M6） | 沿 `supersededBy` 从该 belief 走到链头，old→new。带 visited 集与长度上限：运行时写不出环，但一份被改坏的日志可以，此时必须停下并标记 `chainTruncated`，而不是走死循环。 | `src/BeliefListModel.cpp` `followSupersession` |
| **Bootstrap**（连接序列，M3） | 连接时的唯一正确顺序：先 `get_domain_snapshot`、再 `get_state`；快照落地前**缓冲所有入站行**；`get_state` 必须**持有**到快照应用之后（它携带的 `resume` / `decisionOwed` 以运行为准，不能被 event-only 投影覆盖）；5s 无快照则降级为 `isEventOnly`。缓冲上限**丢弃最旧**的行——cursor / focus / selection 都是字段级 last-write-wins，只有尾部够到快照时刻才会收敛。 | `src/Bootstrap.h` |
| **ReplayIssue**（重放问题，M2/M3） | TS fold 里 `fail(...)` 的地方，C++ 镜像记录一条 issue 并 **no-op**，绝不中止。status bar 显示计数。**重复事件仍须调和它派生的状态**：`PlanProduced` 在重复路径上仍要清掉 `experimentSelection`，否则同一份日志在不同快照内容下会收敛到不同终态。 | `src/Model.h` APPLIER CONTRACT |
| **Replay Tool**（重放工具，M3） | headless 跑真实 transcript 的 dev 工具（`--replay` / `--demo` / `--dump-snapshot`），走与 live 完全相同的 Bootstrap 与 appliers。§10 把它列为最高风险的缓解手段：单测与 parser 共享同一套心智模型，只有真 transcript 不是。 | `src/ReplayTool.cpp` |
| **Dispatch Trace / Trace Row**（调度轨迹与其行，M7） | 一行 = **一个 stage 窗口**：由移动光标的事件开启（`CursorChanged`，或 `EpisodeClosed`——finalReport 角色没有 `CursorChanged`，它关掉 episode，fold 把光标置为 `closed`），下一个移动事件关闭。列各有出处：role 来自 stage、model 来自真的跑起来的 `message_start`、role-model 来自 `session_status`、thinking 来自 turn 否则 `get_state`、cache 取遥测否则由 `message.usage` 按**与运行时相同的公式**算、耗时来自两个时间戳。**没有来源的列渲染成 `—`**，绝不把缺口显示成不匹配。窗口里若跑了不止一个 turn，行上标 `(N turns)` 并全部列在展开里——同一 stage 里的第二次模型调用不能被平均掉。 | `src/TraceModel.h` `TraceRow` |
| **model≠role**（派生徽标，M7） | 「实际跑的 model」≠「该角色解析出的 model」。**命名必须叫 `model≠role`，不能叫 `degraded`**：`roleModelFor` 在角色降级后**直接返回 fallback model**，真实的降级标志无法从遥测观察到，宣称它等于宣称 GUI 没有的权威性。任一侧未知就**不**报不匹配——两个缺失值支持不了「不同」这个判断。 | `src/TraceModel.h` `modelDiffersFromRole` |
| **Trace Pane / Events Tab**（轨迹面板与事件页，M7） | 面板两个 tab：**dispatch**（上述行，定宽列文本，点击展开 detail、复制行、follow-tail 钉住）与 **events**（每个 domain 事件一行 + `ReplayIssue` 明细表）。第二个 tab §7.3 只列为可选，但 §5.3 要求 issue 必须**可读明细**——status bar 只有一个计数。 | `src/TracePane.h` |
| **Session Telemetry**（会话遥测，M7） | `message_start` / `message_end` / `session_status` 的观测日志，与 `SessionState` 一样属于**观测而非重放**：它们没有 eventId、不在任何 snapshot 里，因此重连后这段日志是空的。模型只负责**记录**（`TraceEntry`），「一行是什么」由 `TraceModel` 决定。`session_status` 每个事件后都发一次，所以只在**某个 slot 变化**时才落一条。 | `src/Model.h` `TraceEntry` |

## 布局与度量（Layout & metrics）

工作区几何由 `ShellLayout` 计算（无 ImGui 的纯逻辑，可被无窗口单测）；输入框的自动增高由 `PaletteMetrics` 计算。

| 术语 | 含义 | 出处 |
|------|------|------|
| **ShellLayout**（外壳布局，M9） | 由窗口尺寸、字体行高与打开的 panel 算出**每一个**矩形：`header` / `canvas` / `footer` 三条 band，加上 `beliefPanel` / `tracePanel` 两个停靠面板。它取代了 `LayoutMetrics` 的三栏几何（M9 已删除 `LayoutMetrics.h` 与其测试）。 | `src/ShellLayout.h` `computeShellLayout` |
| **PanelId / PanelState**（面板标识与开关，M9） | 可开关的面板集合（BeliefList / DispatchTrace / FileList）与它们各自的宽度分数。**FileList 不占 canvas 宽度**：它是一个浮动选择器，没有停靠矩形，因此不计入 `openCount`。 | `src/ShellLayout.h` |
| **Stacked**（窄窗堆叠，M9） | 窗口窄到 canvas 与面板无法并排时的布局：canvas 占满整行宽度，面板等分剩余高度依次排在它**下面**。每个矩形都留在工作区内——面板各自内部滚动，而不是让整摞跑出窗口底部（矩形越出工作区是 `AGENTS.md` 明令禁止的那一种布局结果）。 | `src/ShellLayout.h` |
| **PaletteMetrics**（面板度量） | 指令输入框的自动增高高度（信念栏颜色图例的度量已随文本工作区删除）。 | `src/PaletteMetrics.h` |
| **kMinWindowWidth / kMinWindowHeight** | 窗口最小尺寸单一来源：canvas + padding + 一个面板（宽），以及 header/footer band + canvas 最小高 + 一个堆叠面板（高）。 | `src/ShellLayout.h` |
| **kPad / kRefRowHeight** | 布局内边距与参考字体行高。 | `src/ShellLayout.h` |
| **LayoutMetrics**（旧布局度量）【已删除（M9）】 | v1 的三栏几何。M1 之后仅 `kMinWindowWidth`/`kMinWindowHeight` 还在用，M9 把这两个常量搬进 `ShellLayout.h` 并删除本文件。 | ~~`src/LayoutMetrics.h`~~ |

## 主题与渲染辅助（Theme & rendering helpers）

| 术语 | 含义 | 出处 |
|------|------|------|
| **Theme**（主题） | 颜色常量、活动窗格背景色 `paneBg`、信念状态着色 `beliefStatusColor`，以及 markdown 字体资源。 | `src/Theme.h` |
| **historySymbol**（历史符号）【已删除（M1）】 | 为 `LoopFrame::History` 枚举返回渲染符号；仅由已移除的导航器图例使用。 | ~~`src/Theme.h`~~ |
| **UiMarkdown**（Markdown 渲染） | 将助手/会话文本作为 Markdown 渲染到当前 ImGui 光标处；含转义换行展开（`\\n`→换行）。 | `src/UiMarkdown.h` `renderMarkdownMessage` `replaceEscapedNewlines` |
| **UiShared**（共享 UI 辅助）【已删除（M1）】 | 为栏与摘要选择要显示的帧。 | ~~`src/UiShared.h`~~ |

## 运行时模型（Runtime model）

模型层位于 `src/Model.h` / `src/Model.cpp`（`NativeGuiModel`）与 `src/DomainEvents.h` / `src/DomainEvents.cpp`（事件词汇与解析），是 v7 schema 的无头、可测试镜像，独立于 Dear ImGui，由运行时事件流驱动。JSON 由 `src/Json.h` 的 DOM 解析——不再扫描字符串（旧的 `findKey` 对嵌套 payload 会张冠李戴）。

**自 M2 起，v1 词汇表（LoopFrame / FrameStage / FrameCursor / Proposal / ToolCall …）已不存在。** 每个结构体在源码上标注其 TS 名（`packages/pie/src/core/agent-session-domain.ts`）。

| 术语 | 含义 | 出处 |
|------|------|------|
| **Json**（JSON DOM） | 零依赖的只读 JSON DOM：解析绝不抛异常/abort，失败返回 `ParseError`；深度上限 256。 | `src/Json.h` |
| **NativeGuiModel**（原生 GUI 模型） | 消费 v7 事件流并持有 `AgentSessionSnapshot` 与 RPC 遥测的状态模型；不推断阶段/光标/认知语义。 | `src/Model.h` |
| **DomainEvent / DomainEventKind** | 线上事件的 kind 枚举与解析结果，共 25 类（与 TS `DOMAIN_EVENT_APPLIERS` 一一对应），分 task / formulation / episode / loop 四个 applier 类别。 | `src/DomainEvents.h` |
| **ReplayIssue** | applier 拒绝一条记录时留下的 `{eventType, eventId, message}`。GUI 既不因运行时会拒绝的日志而崩溃，也不静默吞掉。 | `src/Model.h` |
| **AgentSessionSnapshot** | v7 重放后的整体状态：`activeBranchTasks` / `tasks` / `beliefs` / `activeBeliefs` / `cursor`。应用 snapshot 是**整体替换**，不是合并。 | `src/Model.h` |
| **Task**（任务） | 一次用户请求的投影：`initialPrompt`、`initialTarget`、`episodes`、`focus`/`focusDeclared`、`formulations` 与 review/correction/recheck 记录、`taskOutcome`。 | `src/Model.h` `Task` |
| **ExecutionEpisode**（执行轮次） | 一次路由决策、一次实验及其证据：`routing`、`experimentSelection`、`body`、`steering`、`status`/`stage`。**它是循环派发的单位，不是智能体的问题表述**——后者是 task 级的 Frame。episode 边界只能来自 `EpisodeOpened`/`EpisodeClosed`。 | `src/Model.h` `ExecutionEpisode` |
| **EpisodeStage**（轮次阶段） | `routing/proposing/executing/distilling/closed`；`proposing`/`distilling` 命名的是拥有该轮次的**角色**，不是对任务的解读。仅由 `CursorChanged` 与关闭事件设置。 | `src/Model.h` |
| **AgentSessionCursor**（会话光标） | `{taskId, episodeId, stage}`，取代旧的 `FrameCursor`；只由 `CursorChanged`/`EpisodeClosed` 设置。 | `src/Model.h` |
| **EpisodeBody** | 以 `kind` 判别的联合：`Pending` / `BeliefLoop`（含 `plan`、`beliefDeltas`、`openBeliefsAtStart`）/ `FastPath`（含 `formulation`，因为 fast path 没有 Plan 来承载它）。只填充匹配 `kind` 的字段。 | `src/Model.h` `EpisodeBody` |
| **Belief**（信念） | 不可变记录：statement / domain / expectation / evidenceRounds / supportedBy / refutedBy / inconclusiveBy / supersededBy / withdrawn。**`status` 不是存储字段**：`Belief::status()` 由 provenance 按 `superseded > refuted > supported > inconclusive > proposed` 派生。 | `src/Model.h` `Belief` |
| **BeliefId**（信念 ID） | 一条信念的不透明字符串标识（运行时原样给出，如 `belief-1`）。展示标签 `B<n>` 是**渲染时**按记录顺序算出的派生标签（`beliefLabel()`），绝不累加存储。 | `src/Model.h` |
| **BeliefDelta**（信念变更） | **唯一**写入信念注册表的事件载荷：`producerPhase`（propose/distill，显式而非按事件顺序推断）、`operation`、`sourceBeliefId`、`resultBeliefId`、`resultingBeliefs`（含 refine 两侧的完整不可变记录）。 | `src/Model.h` `BeliefDelta` |
| **Plan / ExperimentSelection** | Plan 是**承诺**（派发时写定、携带出处、从不修改）；ExperimentSelection 是**选择**（可被 revision 或范围变更 void，且 void 本身是可重放的事实）。 | `src/Model.h` |
| **FormulationAdoption** | 某次决策是在哪个 Frame 版本下做出的。`unformed` 是**被记录的事实**（那一刻没有版本），不是缺失字段。 | `src/Model.h` |
| **FormulationReview / FormulationApplicabilityEntry** | 一个版本必须被用户回应（approve 或 correct）并逐一说明旧结论在新读法下的地位；`not-applicable` 的信念被重新纳入 focus 时，该决定标记 `stale` 而不再计数。 | `src/Model.h` |
| **FormulationRecheck** | 每轮蒸馏都欠 propose 一个结果——`maintained`/`revised`/`deferred`，因此「重新考虑后保持读法」与「从未重新考虑」在日志中不是同一种缺失。 | `src/Model.h` |
| **TaskFocus**（任务关注范围） | 任务声明"当前在用的 belief id 切片"。是**范围**而非真值：进出切片不改变 belief 的 status。`focusDeclared == false` 表示本任务尚未声明（与"声明为空"不同）。仅由 `FocusDeclared` 事件设置，GUI 不推断。注意与 **Focus Current**（视口平移）是不同的概念，代码中一律写作 `taskFocus`/`inFocus`。 | `src/Model.h` `Task::focus` |
| **TaskOutcome**（任务结果） | 任务实际交付了什么、由什么证据验证、剩余阻塞。是任务结果而非世界信念：认识充分性与任务完成是两件事。仅由 `TaskOutcomeRecorded` 事件设置。 | `src/Model.h` `TaskOutcome` |
| **RpcApplyResult**（RPC 应用结果） | 应用一行事件的结果：`Applied/Ignored/Error`。 | `src/Model.h` |

## 事件（Events）

模型仅由显式运行时事件驱动（JSONL 每行一个 JSON 对象）。

**线上是扁平事件**：domain 事件不是以 `entry_added`/`customType` 包装出现的，顶层 `type` 就是事件名（`{schemaVersion, event}` 包装只存在于磁盘上的 session entry）。schema v7；每个事件带 `eventId`（幂等去重键）与 `timestamp`，task/episode 级事件另带 `taskId`/`episodeId`。

**自 M2 起，v1 事件名不再被解析**（`FrameOpened`/`FrameBodySelected`/`FrameClosed` 等已不存在，且不会被别名到新名字）。共 25 类，按 applier 分组；权威列表见 `src/DomainEvents.cpp` 的 `kEventNames` 与 TS 的 `DOMAIN_EVENT_APPLIERS`。

| 分组 | 事件 |
|------|------|
| task | `TaskOpened` `TaskClosed` `TargetDefined` `FocusDeclared` `TaskOutcomeRecorded` |
| formulation | `ProblemFormulationRecorded` `ProblemFormulationDeferred` `FormulationApproved` `FormulationCorrectionSubmitted` `FormulationCorrectionResolved` `FormulationApplicabilityRecorded` `FormulationRecheckRecorded` |
| episode | `EpisodeOpened` `RoutingDecided` `EpisodeBodySelected` `EpisodeClosed` `CursorChanged` `InterventionAdded` `ExperimentSelected` `ExperimentSelectionVoided` |
| loop | `BeliefDeltaApplied` `PlanProduced` `ExecutionStarted` `ExecutionCompleted` `DistillationProduced` |

关键语义（见 `src/Model.h` 顶部的 applier 契约）：

- `FormulationApproved` 是**唯一**表示「同意」的事件；拒绝时以 RPC error 返回，不是 approval。
- `BeliefDeltaApplied` 是**唯一**的信念注册表写入者。
- episode 边界只能来自 `EpisodeOpened`/`EpisodeClosed`；第二个 plan、`PROPOSING` 阶段都不得充当分隔符。

## 非渲染辅助模块（Non-rendering helpers）

以下模块不渲染任何 UI 内容，但作为支撑被收录或说明。模型层（`NativeGuiModel`）与无 ImGui 的布局/度量（`ShellLayout`/`PaletteMetrics`）已在上述相应小节收录，这里补充其余几个非渲染辅助模块：

| 模块 | 含义 | 归入 |
|------|------|------|
| **Paths**（路径助手） | 平台路径 helper：定位二进制所在目录（`executableDirectory`）并由此推导 Sarasa 字体路径（`fontPath`）；与任何 UI 组件解耦，可被复用并无窗口测试。 | 非渲染辅助 → 收列 |
| **RuntimeClient**（运行时客户端） | 只管进程的那一半：fork/exec 以 RPC 模式启动 PI CLI、写指令、在 reader 线程里分帧并**解析** JSONL，推入线程安全的 `EventQueue`，然后干净地停止。JSON 解析放在 reader 线程而不是帧线程，是因为长会话的 `get_domain_snapshot` 一行就有数 MB，在帧循环里解析会卡住整帧。 | 非渲染辅助 → 收列 |
| **EventQueue**（入站队列，M3） | 分帧（chunk 边界不是行边界）、逐行解析、以及**预算化 drain**（每帧最多 48 行 / 4 ms，剩下的留给下一帧）。队列自身不做有损丢弃：丢掉活事件是 replay 不允许做的事。 | 非渲染辅助 → 收列 |
| **ModelDump / SnapshotWriter**（推导转储与快照写出，M3） | 把派生模型渲染成稳定文本（`--replay` 的输出，被 `Bootstrap.test.cpp` 断言），以及把状态写回成一条 `get_domain_snapshot` 响应行。后者让 §5.3 的核心主张可被**证明**：取前 N 个事件后的状态序列化成快照，再把余下事件跑在它上面，三种顺序必须收敛到同一终态。 | 非渲染辅助 → 收列 |

> 说明：两者均属非 UI 渲染辅助，但因其在运行时边界与资源定位上的关键性，术语表予以收列，而非排除。

## 术语间的不变式（Key invariants）

- **唯一注册表写入者**：只有 `BeliefDeltaApplied` 写入信念注册表；`PlanProduced`/`DistillationProduced` 都不修改它。
- **不可变历史**：已关闭的 episode 不可被修改——applier 对它的写入是 issue + no-op；新证据打开新 episode 而非改写历史 episode。
- **belief status 由 provenance 派生**：precedence 为 `superseded > refuted > supported > inconclusive > proposed`，不是存储字段。
- **GUI 不推断语义**：`EpisodeStage`、光标与认知含义只来自显式事件，GUI 不据日志推导。
- **applier 纯度**：每个 applier 是 `f(state, event)`，以它写入的记录 id 为键，行为只有「已存在且相同 → no-op」或「字段级 last-write-wins」。显示标签由记录顺序在渲染时算出，绝不累加。
- **重复事件仍须调和**：重复路径提前返回对**它写的那条记录**是对的，对 applier 派生出来的其他状态是错的。副作用是**不变量**而非附赠品：「有 plan ⇒ 没有待定 selection」「episode 已关闭 ⇒ 光标已越过它」在任何到达顺序下都成立。漏掉这一步，同一份日志会因快照当时恰好包含什么而收敛到不同终态。
- **投影决定含义，渲染器只决定颜色与位置**：节点或边不在 `GraphModel.cpp` 里，就不在 canvas 上；反之，投影凭空造出的任何东西都是运行时从未作出的声明。fast path 是常备例子：它没有 `Plan`，所以不得为它画 plan 节点，也不得画 `plan → execution` 边。
- **canvas 只读**：可以平移、缩放、选中节点、（右键）把视图重新钉回 runtime 光标。除此之外没有拖拽连线、没有新建节点、没有编辑 belief。选中只改变**强调**：高亮该节点的依赖集合并压暗其余，而这个集合由投影出的边算出，不来自对「相关性」的猜测。
- **面板不得重叠**：垂直 band 依序排布且互不重叠；打开的停靠面板从 canvas row **切走宽度**而非浮在它上面；窄到放不下时改为堆叠（`stacked`），并且**每个矩形都留在工作区内**。这条不变量由 `pi_gui_shell_layout_test` 对「4 种面板组合 × 6 种宽度 × 4 种高度」扫描断言，而不是靠几个手写尺寸。Frame 窗不在这条扫描里：它是浮动窗，不占停靠矩形。
- **一个 stage 窗口 = 一行轨迹，一行内的多次模型调用不得被平均掉**：同一 stage 里跑了两个 turn 时，行上标 `(N turns)` 并在展开里逐个列出。合并它们等于在调试器里藏掉一次模型调用。
- **缺来源就渲染 `—`，绝不把缺口显示成不匹配**：trace 的 model/thinking/cache/耗时列、belief 面板的 focus 说明、footer 的角色槽，都遵守同一条规则。「运行时没说」与「运行时说了否」是两件事。
- **两条输入通道不可混淆**：`approve_frame` 是唯一表示「同意**某一版**」的命令，仅在 `awaitingResponse` 时可用；普通 `prompt` 永不释放 pause；`frame_correct` 有自己的输入框（不是 prompt 框）。`set_auto_approve_frame` 是第三种，且**不是**前两种的变体：它同意的是**尚未写出**的读法，因此不带 versionId，在界面上是复选框而不是按钮——它绝不能被误当成「同意当前这一版」。它打开的瞬间会批准正在等待的那一版（运行时的 `setAutoApproveFrame` 行为），且同样走 `approveFormulation`，所以未答复的反对一样会拒绝它。

## 相关的信念循环概念（Related belief-loop concepts）

`gui/` 本身不运行信念循环；以下术语来自根 `README.md`，用于理解 footer 遥测与模型配置。

| 术语 | 含义 | 出处 |
|------|------|------|
| **belief loop**（信念循环） | 将"智能体如何回答问题"建模为四阶段状态机：propose/execution/distill/finalReport。 | `README.md` |
| **footer 槽名 → 阶段映射** | `Epistemic`=propose、`Planner`=plan、`Distillation`=distill、`Execution`=execution。 | `src/Footer.cpp` |
| **executionModel / distillationModel** | 分别用于 execution 探测与 distill 蒸馏角色的模型配置。 | `README.md` |
| **distillationThinkingLevel** | distill 角色的思考级别，默认 `low`。 | `README.md` |
| **beliefLang** | 信念提示词书写语言，默认 `English`。 | `README.md` |
| **fastPathModel** | fast-path 执行模型；fast path 与 belief-loop 为两种路由。 | `README.md` |
| **defaultModel** | 会话主模型，propose 与 finalReport 角色始终使用。 | `README.md` |
