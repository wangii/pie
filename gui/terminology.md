# PIE Native GUI 专用术语表（Terminology）

本表整理 `gui/` 代码库（PIE Native GUI）在源码、模块注释与文档中出现的专用术语，重点覆盖 UI 组件及其相关边界。术语来源为仓库中的真实标识符与约定，非自造词；每项给出规范的英文拼写、含义与在代码中的出处。

## 写作约定（Conventions）

- 术语一律使用源码中的英文原名，不做本地化改写，以保证与代码一致。
- 每条术语给出：中文释义、英文原名、含义、出处（文件/函数/注释）。
- 本文件采用与根 `README.md` 一致的双语结构（中文标题 + 英文括注或正文）。

## UI 组件（UI components）

UI 层由若干独立的 `render*` 组件函数组成，每个组件只读模型，不修改模型。

| 术语 | 含义 | 出处 |
|------|------|------|
| **Status Bar**（状态栏） | 显示 session/frame/stage 指示器与 EXECUTING 阶段的当前工具；纯显示。 | `src/StatusBar.h` `renderStatusBar` |
| **Belief Lane**（信念集栏） | 渲染当前信念集合（belief set）的三条栏之一。 | `src/BeliefLane.h` `renderBeliefLane` |
| **Cognitive Lane**（认知过程栏） | 渲染认知过程（plan/execution/distillation）的三条栏之一。 | `src/CognitiveLane.h` `renderCognitiveLane` |
| **Execution Lane**（执行栏） | 渲染执行轨迹（工具调用与输出）的三条栏之一。 | `src/ExecutionLane.h` `renderExecutionLane` |
| **Lane**（栏） | 主工作区中并排（或窄窗时垂直堆叠）的三列内容区域；有左/中/右三条。 | `src/LayoutMetrics.h` `laneRects` |
| **Summary**（当前帧摘要） | 渲染当前循环帧（loop frame）的摘要。 | `src/Summary.h` `renderSummary` |
| **Footer**（底部栏） | 渲染四个信念循环角色（Epistemic/Planner/Distillation/Execution）的模型与缓存命中率，以及累计会话成本；单行紧凑行，钉在工作区底部。 | `src/Footer.h` `renderFooter` |
| **Prompt Palette**（提示面板） | ⌘T/Ctrl-T 切换的浮动无装饰窗口，用于输入用户提示（Cmd/Ctrl+Enter 提交）并显示助手流式回复；独立于主工作区布局。 | `src/PromptPalette.h` `renderPromptPalette` |
| **Navigator**（帧导航器） | 历史帧导航；当前版本不再渲染（其 band 已从布局中移除）。 | `src/LayoutMetrics.h` |
| **Pane**（窗格） | 当前流程步骤所在的子区域（PLAN/DISTILLATION/PROPOSALS 段落，或 EXECUTING 阶段的右侧执行栏区域）。活动窗格使用 `paneBg` 的背景色高亮；`paneBg` 仅由 `CognitiveLane.cpp` 与 `App.cpp` 的执行栏区域调用，而非 `ExecutionLane.cpp` 内的 `renderExecutionLane`。 | `src/Theme.h` `paneBg` |

## 布局与度量（Layout & metrics）

布局几何由 `LayoutMetrics` / `PaletteMetrics` 计算，二者都是无 ImGui 的纯逻辑，可被无窗口单元测试。

| 术语 | 含义 | 出处 |
|------|------|------|
| **LayoutMetrics**（布局度量） | 根据窗口尺寸、字体行高与内边距计算主工作区各区域的高度与三条栏的矩形；保证区域不重叠、不越界。 | `src/LayoutMetrics.h` `computeLayout`/`laneRects` |
| **PaletteMetrics**（面板度量） | 指令输入框的自动增高高度、信念栏颜色图例的度量逻辑。 | `src/PaletteMetrics.h` |
| **kMinWindowWidth / kMinWindowHeight** | 窗口最小尺寸单一来源，由三条栏最小宽度与各区域高度预算推导。 | `src/LayoutMetrics.h` |
| **kPad / kRefRowHeight** | 布局内边距与参考字体行高。 | `src/LayoutMetrics.h` |

## 主题与渲染辅助（Theme & rendering helpers）

| 术语 | 含义 | 出处 |
|------|------|------|
| **Theme**（主题） | 颜色常量、活动窗格背景色 `paneBg`、信念标签/状态辅助函数（`beliefLabel`/`beliefIdFromLabel`/`beliefStatusColor`/`historySymbol`），以及 markdown 字体资源。 | `src/Theme.h` |
| **historySymbol**（历史符号） | 为 `LoopFrame::History` 枚举返回渲染符号：Closed→✓、Unresolved→!、Falsified→✗、NewBelief→+、Revised→~、Current→●；仅供（已移除的）导航器图例使用，为完整性与测试保留。 | `src/Theme.h` `historySymbol` |
| **UiMarkdown**（Markdown 渲染） | 将助手/会话文本作为 Markdown 渲染到当前 ImGui 光标处；含转义换行展开（`\\n`→换行）。 | `src/UiMarkdown.h` `renderMarkdownMessage` `replaceEscapedNewlines` |
| **UiShared**（共享 UI 辅助） | 为栏与摘要选择要显示的帧：视图锁定的历史帧，或活动帧。 | `src/UiShared.h` `displayedFrame` |

## 运行时模型（Runtime model）

模型层位于 `src/Model.h` / `src/Model.cpp`，是名为 `NativeGuiModel` 的无头、可测试状态模型，独立于 Dear ImGui，由运行时事件流驱动。

| 术语 | 含义 | 出处 |
|------|------|------|
| **NativeGuiModel**（原生 GUI 模型） | 消费运行时事件流（JSONL）并持有信念快照、活动循环帧、帧历史、执行轨迹与帧光标的状态模型；不推断阶段/光标/认知语义。 | `src/Model.h` |
| **BeliefId**（信念 ID） | 一条信念的整数标识（`B<n>`），如 `B31`。 | `src/Model.h` |
| **Belief**（信念） | 一条带标签的关系：lhs/relation/rhs、置信度、状态与断言（statement）。 | `src/Model.h` |
| **LoopFrame**（循环帧） | 一次完整的认知事务：所选信念、planner 输出、执行轨迹、蒸馏输出与提案。 | `src/Model.h` |
| **FrameStage**（帧阶段） | 运行时显式阶段：`NONE/PLANNING/EXECUTING/DISTILLING/PROPOSING/CLOSED`；GUI 只读不推。 | `src/Model.h` |
| **FrameCursor**（帧光标） | 活动帧光标/当前执行位置，仅由 `CursorChanged` 等事件设置。 | `src/Model.h` |
| **PlannerOutput**（规划输出） | planner 阶段输出：label（`P-<n>`）、question、intent。 | `src/Model.h` |
| **DistillationOutput**（蒸馏输出） | distillation 阶段输出：label（`D-<n>`）、输入 ID、unexplained 与 interpretation。 | `src/Model.h` |
| **ToolCall**（工具调用） | 一次执行工具调用：id（`E-<n>`）、tool、command、result、warning、status、expanded。 | `src/Model.h` |
| **Proposal**（提案） | 一条提议的信念变更；`op` 语义：`+` 创建、`~` 修改、`-` 移除/失效、`?` 未决。 | `src/Model.h` |
| **RpcApplyResult**（RPC 应用结果） | 应用一行事件的结果：`Applied/Ignored/Error`。 | `src/Model.h` |
| **LoopFrame::History**（帧历史标记） | 记录帧的历史状态枚举：`Closed/Unresolved/Falsified/NewBelief/Revised/Current`。 | `src/Model.h`（`LoopFrame::History`） |

## 事件（Events）

模型仅由显式运行时事件驱动（JSONL 每行一个 JSON 对象）。

| 事件 | 含义 | 出处 |
|------|------|------|
| **FrameOpened** | 打开一个新循环帧。 | `src/Model.cpp` |
| **BeliefsSelected**（复数） | 选择该帧要处理的信念。 | `src/Model.cpp` |
| **PlanProduced** | 生成规划输出。 | `src/Model.cpp` |
| **ExecutionStarted** | 开始执行。 | `src/Model.cpp` |
| **ToolCalled** | 发起一次工具调用。 | `src/Model.cpp` |
| **ToolReturned** | 工具返回结果。 | `src/Model.cpp` |
| **ExecutionCompleted** | 执行完成。 | `src/Model.cpp` |
| **DistillationProduced** | 生成蒸馏输出。 | `src/Model.cpp` |
| **ProposalCreated** | 追加一条提案（不修改信念注册表）。 | `src/Model.cpp` |
| **BeliefUpdated** | 唯一改变信念注册表的事件。 | `src/Model.cpp` |
| **CursorChanged** | 更新帧光标/阶段。 | `src/Model.cpp` |
| **FrameClosed** | 关闭一个帧；关闭后的帧不可变。 | `src/Model.cpp` |

## 非渲染辅助模块（Non-rendering helpers）

以下模块不渲染任何 UI 内容，但作为支撑被收录或说明。模型层（`NativeGuiModel`）与无 ImGui 的布局/度量（`LayoutMetrics`/`PaletteMetrics`）已在上述相应小节收录，这里补充其余两个非渲染辅助模块：

| 模块 | 含义 | 归入 |
|------|------|------|
| **Paths**（路径助手） | 平台路径 helper：定位二进制所在目录（`executableDirectory`）并由此推导 Sarasa 字体路径（`fontPath`）；与任何 UI 组件解耦，可被复用并无窗口测试。 | 非渲染辅助 → 收列 |
| **RuntimeClient**（运行时客户端） | 运行时客户端：fork/exec 以 RPC 模式启动 PI CLI，写入指令、读取 JSONL 事件到线程安全 `EventQueue`，并干净地停止读取线程；不渲染，供 `main` 在 `--live` 模式使用。 | 非渲染辅助 → 收列 |

> 说明：两者均属非 UI 渲染辅助，但因其在运行时边界与资源定位上的关键性，术语表予以收列，而非排除。

## 术语间的不变式（Key invariants）

- **Proposal != BeliefUpdate**：`ProposalCreated` 只追加提案，只有 `BeliefUpdated` 修改信念状态。
- **不可变历史**：已关闭的帧（`FrameClosed`）不可被修改；新证据打开新帧而非改写历史帧。
- **GUI 不推断语义**：`FrameStage`、光标与认知含义只来自显式事件，GUI 不据日志推导。

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
