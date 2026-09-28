# PIE Native GUI 重写 — 交付计划（milestones-ds）

本文件是 `gui/`（PIE Native GUI）重写的**唯一有效交付计划**。
`gui/roadmap/phase-*.md` 归档至 `gui/roadmap/archive/`，不再维护。

写作约定：中文论述 + 英文标识符，与 `gui/terminology.md` 的双语结构一致。源码中的英文原名不做本地化改写。

---

## 1. 背景：为什么是重写而不是更新

`gui/` 是 `packages/pie/` 的专属原生前端（C++20 + Dear ImGui 1.92.9 + CMake，约 10.3k 行）。它当前的状态不是「可以小修」：

### 1.1 协议层已经不兼容

`packages/pie/docs/domain-model.md` 明确记载：

> `gui/src/Model.cpp` and its tests still parse the pre-rename names and `frameId`. The native GUI is **not** compatible with a v2-or-later runtime until it is adapted.

运行时已到 **schema v7**（`AGENT_SESSION_DOMAIN_SCHEMA_VERSION = 7`），而 GUI 仍在解析 v1 事件名：

| GUI 解析的（v1） | v7 实际 |
|---|---|
| `FrameOpened` | `EpisodeOpened` |
| `FrameBodySelected` | `EpisodeBodySelected` |
| `FrameClosed` | `EpisodeClosed` |
| `frameId` 字段 | `episodeId` |

具体后果：v2 把 `DistillationProduced` 的关联字段从 `frameId` 改成 `episodeId`，因此 **GUI 至今收不到任何一次实时的蒸馏事件**。这不是理论问题，是当前就在发生的功能缺失。

### 1.2 GUI 在推断本该由运行时显式给出的语义

当前 live adapter 有三处推断，全部被契约禁止（*never infer cognition from generic message/tool ordering*）：

1. 用 `CursorChanged(stage=PROPOSING)` 切分「帧边界」；
2. 把 tool call 自行关联到当前 plan；
3. 把未被消费的 execution 归给 distillation。

`domain-model.md` §"Downstream consumers" 专门点名了这些偏差。

### 1.3 数据模型的中心对象是错的

| 旧 GUI（`LoopFrame`） | v7 |
|---|---|
| `LoopFrame` | `ExecutionEpisode` |
| `FrameStage` | `EpisodeStage` |
| `FrameCursor` | `AgentSessionCursor` |
| —— GUI 中无对应物 | `ProblemFormulation`（产品名即 **Frame**） |

同时 GUI 把 belief 的 `status` 当作**存储字段**，而契约要求它由 provenance **派生**。

### 1.4 产品方向调整

三栏（Belief / Cognitive / Execution）文本工作区整体去掉，只保留 graph view；canvas 简化为 dot/link + tooltip；用户交互围绕 **Frame** 重新组织。

**目标产出**：一个只读、graph-only、以 Frame 为中心的认知反馈回路调试器，数据模型逐字对齐 schema v7，模型层保持 ImGui-free 以便无窗口单测。

---

## 2. 已确认决策

| 决策 | 选择 |
|---|---|
| RPC 协议 | **Protocol A**：stdio JSONL（`node <PI_CLI> -ne --mode rpc`）。不引入 CBOR/Chord。 |
| 落地方式 | **原地重写 `gui/src`**。保留 `CMakeLists.txt`（字体/平台部分）、`cmake/`、`src/plats/`、`Theme`、`Paths`、`UiMarkdown`。 |
| 调度视图 | **结构化调度轨迹**：每角色一行，非原始 JSONL dump。 |
| 旧代码/文档 | 删 textview 与死代码 `main.cpp`；`gui/roadmap/` 归档；本文件成为唯一计划。 |
| 过渡策略 | **只保 headless 绿**：M2–M5 期间 `pie_gui` 二进制不链接，但所有 headless CTest 目标在每个里程碑边界全绿。 |
| 降级呈现 | **派生徽标 `model≠role`**，不改动 `packages/pie/`。 |

---

## 3. 契约事实（全部经源码验证）

### 3.1 事件在 wire 上是**扁平的**

> ⚠️ 这一条曾经被搞错过，特此写明以免重蹈覆辙。

domain 事件**不是**以 `entry_added` / `customType` 包装形式出现的。真实路径：

```
BeliefLoopController.recordDomainEvent(event)
  ├─ appendAgentSessionDomainEvent(...)   → 存盘：写入 {schemaVersion, event} 包装 + customType
  └─ this.host._emit(event)               → 发到实时事件流：**裸事件**
toJsonEvent(event)   // modes/json-event.ts
  → 非 message_update 一律原样透传
AgentSessionEvent ⊇ AgentSessionDomainEvent     // union 成员
```

所以 wire 上的一行就是（顶层 `type` 即事件名）：

```json
{"type":"EpisodeOpened","schemaVersion":7,"eventId":"event-…","timestamp":"…","taskId":"task-…","episodeId":"…","ordinal":1}
```

`{schemaVersion, event}` 包装与 `customType: "pie.agent-session-domain-event"` **只存在于磁盘上的 session entry**，不上 wire。

**后果**：adapter 不需要解包、不需要查 `customType`；现有 `Model.cpp` 对 wire 形状的判断本来就对，错的只是词汇表。

### 3.2 相关性字段与去重键

```
DomainEventBase   { type, schemaVersion, eventId, timestamp }
  └ TaskEventBase { taskId }
      └ EpisodeEventBase { episodeId }
```

`eventId` 是幂等去重键。

### 3.3 25 个 domain 事件（权威列表，来自 `DOMAIN_EVENT_APPLIERS` 的键数）

| 分组 | 事件 |
|---|---|
| task | `TaskOpened` `TaskClosed` `TargetDefined` `FocusDeclared` `TaskOutcomeRecorded` |
| formulation | `ProblemFormulationRecorded` `ProblemFormulationDeferred` `FormulationApproved` `FormulationCorrectionSubmitted` `FormulationCorrectionResolved` `FormulationApplicabilityRecorded` `FormulationRecheckRecorded` |
| episode | `EpisodeOpened` `RoutingDecided` `EpisodeBodySelected` `EpisodeClosed` `CursorChanged` `InterventionAdded` `ExperimentSelected` `ExperimentSelectionVoided` |
| loop | `BeliefDeltaApplied` `PlanProduced` `ExecutionStarted` `ExecutionCompleted` `DistillationProduced` |

### 3.4 命令面（stdin）

| 命令 | 响应 | 用途 |
|---|---|---|
| `{"type":"get_domain_snapshot"}` | `{sessionId, activeBranchTasks[], tasks[], beliefs[], activeBeliefs[], cursor?}` | 连接时 bootstrap，直接读运行时 replay 后的 snapshot |
| `{"type":"get_state"}` | `RpcSessionState`，含 `formulation: FormulationState\|null` | 取 Frame 状态 |
| `{"type":"approve_frame","versionId"?}` | `{outcome, versionId, continuation}` | **唯一表示「同意」的命令** |
| `{"type":"frame_correct","message"}` | `{correctionId}` | 提交用户异议 |
| `{"type":"prompt","id","message","streamingBehavior":"steer"}` | `{disposition}` | 普通输入 |

**`approve_frame` 的语义**：拒绝时返回 **error** 而非 approval —— *"reporting 'nothing was waiting' as consent is exactly the failure this command exists to remove"*。Frame 面板必须把「无可批准对象」当**错误**呈现。

**普通输入不是同意**：契约明确规定 plain `prompt`/`steer` 永不释放 pause。UI 必须让用户无法混淆这两者。

### 3.5 stdout 行种类

1. `{"type":"response", ...}` — 命令 ack
2. `{"type":"session_status", roleStatus, roleUsage, cost, tokens}` — 每个事件后各发一次
3. `{"type":"<DomainEventName>", ...}` — 裸 domain 事件（见 3.1）
4. `message_start` / `message_update` / `message_end` — 流式回复

### 3.6 `session_status` 比预期薄得多

```ts
interface RoleStatusSlot { model; latestCacheHitRate }
interface RoleStatus { epistemic; distillation; execution }   // 无 finalReport 槽
```

**没有** thinking level、**没有**耗时、**没有** degraded 标志，且 `getRoleStatus()` 在 `beliefSetUsable` 之前返回 `undefined`（会话初期根本没有这行遥测）。

→ 调度轨迹的多数列**不能**来自 `session_status`。逐列出处见 §7。

### 3.7 不变量

- 唯一的 belief 注册表写入者是 `BeliefDeltaApplied`。
- belief status **由 provenance 派生**，precedence：`superseded > refuted > supported > inconclusive > proposed`。
- **episode 边界只能来自 `EpisodeOpened` / `EpisodeClosed`**。第二个 plan、`PROPOSING` 阶段都不得充当分隔符。
- 已关闭的 episode 不可变（invariant 2）。
- GUI 只 replay/project，不推断 stage、cursor、认知语义。
- 模型层保持 ImGui-free。
- 不迁移平台后端。

---

## 4. 目标架构

沿用 `gui/AGENTS.md` 的三层划分，目录重组：

```
gui/src/
├── Json.h/.cpp             # 真正的 JSON DOM（headless，零依赖）
├── Model.h/.cpp            # NativeGuiModel：v7 snapshot 镜像 + appliers
├── DomainEvents.h/.cpp     # 25 类事件的 kind 枚举与解析
├── FormulationView.h/.cpp  # deriveFormulationState（FormulationState 的 C++ 镜像）
├── BeliefListModel.h/.cpp  # belief 行构建/排序/过滤
├── TraceModel.h/.cpp       # 调度轨迹
├── ShellLayout.h/.cpp      # 面板几何（ImGui-free，可单测）
├── Shell.h/.cpp            # UI 层外壳
├── FramePane.h/.cpp        # 由 PromptPalette 演化而来
├── StatusBar.h/.cpp        # 保留，改用 EpisodeStage
├── Footer.h/.cpp           # 合并 renderFooter / renderGraphFooter
├── RuntimeClient.h/.cpp    # 保留
├── PromptCmd.h             # 命令序列化（扩展）
├── Theme / Paths / UiMarkdown / UiShared / FileList / FileListWindow / PathComplete / PaletteMetrics
├── graph/
│   ├── GraphModel.h/.cpp   # v7 投影
│   ├── PieGraphLayout.h/.cpp # 确定性布局（dot + rail + episode row）
│   ├── GraphView.h/.cpp    # dot/link + tooltip 渲染
│   ├── GraphRouting / GraphInteraction / GraphCache / GraphLive / GraphStyle
└── plats/                  # 不动
```

**面板抽象**（取代 `App.cpp` 里 `if (app.graphOpen) {...return;}` 的裸分支）：

```cpp
// ShellLayout.h — 纯逻辑，ImGui-free
enum class PanelId { BeliefList, DispatchTrace, FrameControl, FileList, Count };
struct PanelState {
    bool open[kPanelCount] = { false, false, true, false };
    float beliefListFrac = 0.30f, traceFrac = 0.36f, framePaneFrac = 0.42f;
};
struct ShellLayout {
    Rect header, canvas, footer;
    Rect beliefPanel, tracePanel, framePane;   // 关闭时宽/高为 0
    bool stacked = false;                      // 窄窗时面板下移堆叠
};
ShellLayout computeShellLayout(float winW, float winH, float rowH, const PanelState&);
```

布局不变量沿用现行 `AGENTS.md`：垂直 band 顺序排布不重叠；高度由 `GetFrameHeightWithSpacing()` 推导；侧栏从 canvas row **切走宽度**而非浮在其上；窄于最小 canvas 宽度时改为可滚动堆叠；`kMinWindowWidth/Height` 仍是单一来源。

**键位**：`Cmd/Ctrl+B` belief list、`Cmd/Ctrl+T` trace、`Enter`/`:` frame pane、`Cmd/Ctrl+F` file list（**保持**）、`Cmd/Ctrl+=`/`-` 字体缩放。**移除 `Cmd/Ctrl+G`**（随 textview 一起去掉）。

---

## 5. 数据模型

### 5.1 JSON：用 DOM 替换扫描器

现有 `Model.cpp` 的 `findKey`（`Model.cpp:23`）返回字符串中**第一次**出现 `"key"` 的位置，与嵌套层级无关。对 `tasks:[{id:"task-1"},{id:"task-2"}]` 这种 snapshot，查 `"id"` 会把每个 task 都解析成 `task-1`。`rawValue`（`:282`）有同样缺陷。snapshot 是嵌套的 array-of-objects-of-arrays，必须用结构化 parser。

**自写 `Json.h` / `Json.cpp`（约 400 行，零依赖）**，理由：
- 保持离线可构建（不新增 FetchContent）；
- 本仓库已基于同样的理由否决过 `imgui-node-editor`；
- 可针对**我们实际用到的形状**写测试，这是 vendored 库做不到的。

解析规则：深度上限 256；每个 string 值一次分配；**任何失败都返回错误，绝不抛异常或 abort** —— 畸形输入降级为一个 `ReplayIssue`，符合「GUI 只 replay」的纪律。

**显示层截断**：`Execution.output` 可能是数 MB 的工具输出。模型只存 `outputPreview`（截断至 2000 字符）+ `outputBytes` 字节数。这是显示层截断，必须在注释中标明；否则长会话的 snapshot 会占用数十 MB。

### 5.2 v7 结构体

逐个对应 `agent-session-domain.ts`，**每个结构体上标注 TS 名**，让漂移在 review 中可见。要点：

- 所有 id 统一 `using Id = std::string`，不做整数重映射。
- `Belief::status()` 是**方法**，按 precedence 派生。
- `FormulationAdoption { bool unformed; Id versionId; }` —— `Unformed` 是一个**被记录的事实**，不是「缺失」。
- `EpisodeBody` 用 `kind` 判别（`Pending` / `BeliefLoop` / `FastPath`），只填充匹配的字段。
- `FormulationSource` 是 6 变体 union，扁平化为 `{kind, ref, beliefId, beliefDeltaId}`。

### 5.3 事件适配与幂等

snapshot 与实时流**必然重叠**：snapshot 由运行时在处理命令的那一刻算出，而 GUI 已经/将要收到该时刻两侧的事件。`RpcDomainSnapshot` **不携带 cursor 或 event id**，所以无法用 eventId 去重来调和两者。

**契约（必须写进 `Model.h`）**：每个 applier 是纯函数 `f(state, event)`，不持有计数器或累加器，以它写入的记录 id 为键；行为只有两种 —— 「记录已存在且相同则 no-op」或「字段级 last-write-wins」。

这不是发明，正是 TS 侧 `DOMAIN_EVENT_APPLIERS` 的写法。当前 C++ 模型违反此契约的一处值得点名：`nextBeliefOrdinal_` / `nextPlanOrdinal_` / `nextDistillOrdinal_`（`Model.h:395-397`）是 applier 侧的累加器。**显示标签必须在渲染时由记录顺序算出，绝不累加** —— 否则重连后标签会漂移。

**启动序列**：

```
connect
  → write get_domain_snapshot (req_0)
  → write get_state           (req_1)
  → phase = Bootstrapping：缓冲所有入站行（上限 20k 行 / 8 MB）
  → response get_domain_snapshot: applyDomainSnapshot(data)      // 整体替换
        然后按行序回放缓冲区（走同一组幂等 applier）
        phase = Live
  → response get_state: applySessionState(data)                   // 必须在 snapshot 之后应用
  → 5s 内无 snapshot 或返回 error：phase = Live, isEventOnly = true
        status bar 显示 "bootstrap unavailable — state is event-only"，绝不阻塞渲染
```

若 `get_state` 的响应先到，**必须持有**，待 snapshot 应用后再应用 —— `formulation.resume` / `decisionOwed` / `recheckOwed` 以运行为准，不能被 event-only 投影覆盖。

**不变量冲突处理**：TS fold 中调用 `fail(...)` 的地方（对已存在 task 的 `TaskOpened`、重复的 `ProblemFormulationRecorded`、序号不连续），C++ 镜像记录一个 `ReplayIssue{eventType, eventId, message}` 并 **no-op**。GUI 不能因为运行时自己会拒绝的日志而崩溃，也不能静默吞掉 —— trace 面板显示 issue 计数与明细。**不要**镜像「首个错误即中止」。

**线程**：`RuntimeClient`（fork/exec + pipes + `EventQueue` + reader thread）保持原样。但把 **JSON 解析放到 reader thread**（推 `json::Value` + kind 而非裸行），避免数 MB 的 snapshot 卡住一帧；主线程 drain 限制在每帧约 48 行 / 4 ms。

---

## 6. Graph 渲染：dot + link + tooltip

### 6.1 节点/边词汇

belief-loop 映射为**每个 episode 一条从左到右的 station 链**，episode 按 `ordinal` 自上而下堆叠，另有两条刻意置于链外的 rail：

```
        ┌ Frame rail（task 级，跨越多个 round）────────────────────┐
        │  Fv1 ──▶ Fv2 ──▶ Fv3        (previousVersionId 链)      │
        └───┬────────┬─────────────────────────────────────────────┘
            │ cites  │ cites              belief rail（全局，左侧）
  ┌─────────┴────────┴────────────────────────────────────┐   ● B1  ● B2
  │ Ep1 │ ◇route ▶ ●plan ▶ ●exec ●exec ✗ ▶ ●distill ▶ ▲delta│      ▲      ▲
  ├─────┼──────────────────────────────────────────────────┤      │      │
  │ Ep2 │ ◇route ▶ ◌select ▶ ●plan ▶ ●exec ▶ ●distill ▶ ▲delta│    │      │
  └──────────────────────────────────────────────────────────┘
        TaskOutcome band
```

所有元素**全部来自显式字段**，无推断：

| 元素 | 来源 |
|---|---|
| Routing 点 | `episode.routing`；按 `decision` 着色 |
| ExperimentSelection 空心环 | `episode.experimentSelection`（仅在 `ExperimentSelected` 到消它的 `Plan`/void 之间存在） |
| Plan 点 | `episode.body.plan`；tooltip 含 `intent`、`selectedToExplore`、adoption |
| Execution 点 | `body.trajectory` 每项一个；按 `status` 着色/取字形 |
| Distillation 点 | `body.distillation` |
| BeliefDelta 菱形 | `body.beliefDeltas` 每项一个；字形按 `operation`，填充按 `producerPhase` |
| Intervention 点 | `episode.steering` |
| Frame 节点 | `task.formulations` 每项一个，位于 Frame rail |
| TaskOutcome band | `task.taskOutcome` |

| 边 | 来源 |
|---|---|
| **plan → execution** | `execution.planId` —— 今日**已声明但从未生成**，必须补上 |
| **execution → distillation** | `distillation.inputs` —— 同上 |
| distillation → belief-delta | `distillation.outputs` |
| belief-delta → belief | `delta.resultingBeliefs[].id`；新增时虚线 |
| belief → belief-delta | `delta.sourceBeliefId`（refine/retract 谱系） |
| belief / correction / intervention / execution / distillation → frame version | `version.sources` |
| version → version | `previousVersionId` |
| recheck → episode | `recheck.episodeId` |

fast-path episode 是同一条链去掉 plan，`execution.planId` 缺失 —— 投影必须**不**凭空造一个 plan 节点。旧模型「每帧至多一个 plan」的假设现在是一个 **body-kind 分支**。

**当前节点高亮**：用 `AgentSessionCursor{taskId, episodeId, stage}` 取代由 `FrameStage` 算出的 `currentNode`。stage→station 的映射是**显示层派生**，必须标注为派生：`routing`→routing 点；`proposing`→plan 点（或 select 环）；`executing`→最后一个 execution 点；`distilling`→distillation 点；`closed`→distillation 点变暗。

### 6.2 布局引擎

保留 `PieGraphLayout` 的确定性契约（identical input → identical output；位置按 `NodeId` 键控）。改动：

- **去掉 region/band 模型**：`frameRects` / `beliefRegionRects` / `planRegionRects` / `proposeRegionRects` / `distillRegionRects` / `executionRegionRects` / `columnHeaderHeight` / `phaseBandGap` 等全部存在只为画带标题的方框。dot+link 没有 region。
- **新形状**：`std::map<std::string, Dot> nodes`（`Dot{x,y,r}`，无 w/h 盒）+ `episodeGutters`（行分隔 + ordinal 标签）+ `versionRail` + `outcomeBand`。
- **尺寸收缩**：从 `nodeW/nodeH = 200×60` 降到单一常量 `dotDiameter`（约 14）+ `rowGap`/`columnGap`。命中测试与 tooltip 按半径而非卡片矩形。
- **`GraphLive`**：冻结单位从「closed LoopFrame」改为 **closed ExecutionEpisode** + closed Task。`CompletedFrameLayout` → `CompletedEpisodeLayout`。belief 锚点逻辑彻底消失（belief 的站位由 `delta.resultingBeliefs` 成员关系决定，不再需要 `createdInFrame`）。
- **保留** `GraphRouting` / `GraphInteraction` / `GraphCache` / `GraphNavigation`。
- **删除**：`GraphModel.cpp:49` 的 `pendingFrameId` 合成后继帧（有了 delta→belief 边，重父化问题不复存在）。

### 6.3 `GraphStyle` 剪枝

剪枝，但保持**单一 POD 聚合**，以便 `inline constexpr GraphStyle kGraphStyle{}` 继续工作 —— 这意味着**永远不能新增 `std::string` 成员**（在头文件里注明）。

- 删除：`cardTextPadX/Y`、`nodeW/nodeH`、各 `*RegionFill/Label`、`regionFillAlpha`、`frameRadius/BorderWidth/LabelPadX/LabelPadY/Border/BorderAlpha/Label/LabelAlpha`、`columnHeaderHeight`、`phaseBandGap`、`routingTextSlotH`、`peripheryGap`、`pointsPerInch`。
- 保留并改名：`indicatorRadius`→`dotRadius`、`cardBorderWidth`→`dotRingWidth`、`edgeWidth*`→`linkWidth*`、各 `edge*` 颜色（重定向到新边类型）、`dimMuted`、`currentAccent`、`focusAccent`、`focusBarWidth`、`zoom*`、`gridStep`、`canvasBg`、`arrowhead*`、`canvasPad`、`rowGap`、`columnGap`、`outcomeBand*`。
- 新增：`dotDiameter`、`linkGapFromDot`、`linkDash[2]`、`currentHaloWidth`、`currentHaloColor`、`tooltipMaxWidth`、`tooltipWrapColumn`、`seriesMarkRadius`。

**保留阶段脉冲**：`Theme::paneBg(bool)` 目前只被 `CognitiveLane.cpp` 与 `App.cpp` 调用，两者都要删。按 `AGENTS.md` 记载它是**唯一被用户批准过的动画**，不应静默丢弃 —— 把它重定向到 canvas 的 current-node halo（同样的黑↔`kPaneBgDark` 正弦关系），并同步更新 `AGENTS.md` 的措辞指明新落点。

---

## 7. 四个面板

### 7.1 Belief list（可开关）

Headless `BeliefListModel`：

```cpp
enum class BeliefSort { RecordOrder, Status, Domain, EvidenceRounds };
struct BeliefFilter { bool focusOnly = false; bool hideSuperseded = false;
                      std::optional<BeliefDomain> domain; std::string query; };
struct BeliefRow {
    Id id; std::string label;        // "B7" —— 在渲染时由记录顺序算出，绝不存储
    const Belief* record = nullptr;
    BeliefStatus status; size_t supportCount, refuteCount, inconclusiveCount;
    bool inFocus, focusDeclared, introducedByThisTask;
    std::vector<Id> supersededChain;         // [B7, B12, B19] old→new，带环保护
    std::optional<Id> lineageHead;           // 顶替它的 belief
    BeliefStatus lineageStatus;
    std::optional<ApplicabilityDecision> applicability; bool applicabilityStale;
    bool awaitsRevalidation, owesDecision; size_t taskCount;
};
```

显示列：`label | status | domain | evidence(S/R/I) | focus | statement`；tooltip 载 `expectation` 与原始 evidence 字符串。行色取自派生 status（复用已有的 `Theme::beliefStatusColor`）。superseded 行内联显示链（`B7 → B12 → B19`）并展示链头状态，避免读成死胡同。

**`focusDeclared == false` 必须与「已声明但为空」区分显示**（语义不同）。

### 7.2 Frame 为中心的交互面板（可开关）

`PromptPalette` → `FramePane`。**原样保留**：多行输入 + Cmd/Ctrl+Enter 提交、`@` mention 补全（`PathComplete.h`）、prompt 历史（↑/↓）、归档回复翻页、`renderMarkdownMessage` 流式回复。这些与 Frame 正交且已有测试。

面板内容（自上而下）：

1. **状态横幅** —— 恰为以下之一：`Waiting for your response`（含 Approve + Correct）／`Approved — continuing`／`Approved — no run continuing`／`Approval continuation failed: {reason}`／`propose owes a reading`／`owes a reconsideration of episode #{ordinal}`。
2. **当前 Frame** —— `v{ordinal}`、`recordedAt`、`interpretation`（主）、`focus`、`implication`；`alternative` 与 `tension` 放在灰调块（**可选字段，为空时不渲染**）；`reason`；`sources[]` 作为可点 chip。belief chip 联动 belief 面板；execution chip 把 canvas 居中到该点。**这是第一个让 `sources[]` 可审计的 GUI 界面。**
3. **Deferral 块**（存在时）—— `missingInformation`、`reason`、`deferredAt`。
4. **Corrections** —— 逐条显示 `original` 原文、`status`、propose 的 `response`、`recordedVersionId`。pending 优先。
5. **Review 义务** —— `pendingApplicability` 与 `unrevalidated` 作为 belief chip。这两个状态会阻塞结论，目前在其他任何界面都不可见。
6. **Recheck** —— verdict、`reason`、`revised` 时的 version。
7. **版本历史** —— 紧凑列表（ordinal / recordedAt / reason），点击只读查看该版本全文。**不做文本 diff**（那是推断），只标出变化的**字段**。

新增命令序列化（放在 `PromptCmd.h`，紧邻现有 `serializePromptCommand`）：

```cpp
inline std::string serializeGetSnapshotCommand(const std::string& id);
inline std::string serializeGetStateCommand(const std::string& id);
inline std::string serializeApproveFrameCommand(const std::string& id, const std::string& versionId);
inline std::string serializeFrameCorrectCommand(const std::string& id, const std::string& message);
```

UI 必须编码的规则：

- **Approve 仅在 `awaitingResponse` 时可用**，且是唯一的主按钮样式。`versionId` 取自 `review.versionId`。拒绝以 error response 返回，必须呈现（现有 `applyRpcLine` 已把 `success:false` 路由到 `setInMessageError`）。
- **普通 prompt 明确不是同意** —— 提交按钮文案须写明「Send（不会批准 Frame）」。
- **Correct 是独立输入框**，与 prompt 输入分开，两个动作不可混淆。

**自动打开**：用 `FormulationView` 上的**边沿触发**取代现有 `markFinalReportPending` / `consumeAutoOpenPrompt`（后者触发于 `CursorChanged(stage="closed")`，即旧词汇）：

```cpp
// 仅在以下字段 false→true 边沿打开，并按 versionId 闩锁，避免重连或重复事件反复弹窗
bool autoOpenEdge(const FormulationView& prev, const FormulationView& next, Id& latchVersionId);
//   awaitingResponse       → true
//   decisionOwed           → true
//   resume.phase == Failed → true
```

`decisionOwed` 几乎每轮都会触发，因此**只**用 `awaitingResponse` 与 `resume.Failed` 触发自动打开；`decisionOwed` / `recheckOwed` 作为常驻横幅上的**徽标**呈现。

### 7.3 调度轨迹（可开关）

`session_status` 太薄（§3.6），因此逐列标注真实出处：

| 列 | 来源 | 诚实性说明 |
|---|---|---|
| role | `CursorChanged.stage` → `{proposing→propose, executing→execution, distilling→distill, closed→finalReport}` | `closed` 会把 finalReport 与「episode 关闭」混在一起；渲染为 `finalReport (closed)`，并由 `body.kind` 附 `fastPath` 标记 |
| 实际 model | `message_start.message.model` / `.provider` | 真正跑的那个 |
| 角色 model | `session_status.roleStatus.<slot>.model` | 运行时的按角色解析结果；finalReport **无槽位** → `—` |
| model≠role 徽标 | `dispatchedModel != roleModel` | **命名必须叫 `model≠role`，不能叫 `degraded`** —— 见下 |
| thinking level | `message_start.message.providerThinkingLevel`，否则 `get_state` 的 `thinkingLevel` | 按角色的 thinking level 有配置但从不发出 |
| cache 命中 | `session_status.roleStatus.<slot>.latestCacheHitRate`，否则由 `message.usage` 计算 | telemetry 滞后时可自行计算 |
| 耗时 | `message_start.timestamp` → `message_end.timestamp` | 均为运行时时间戳 |
| 状态 | `message.stopReason` / `errorMessage` | |
| detail | 触发该次切换的 domain 事件（一行原文） | 例如 `Plan P3 selects B1,B4` |

**关于 `degraded`**：`roleModelFor` 在角色降级后会**直接返回 fallback model**，因此真实的降级标志**无法从遥测观察到**。本计划选择派生徽标 `model≠role`（诚实、零 pie 改动），并在 UI 上明确它表达的是「实际运行 model 与角色 model 不一致」，而非「已降级」。**不得**让 GUI 宣称它没有的权威性。

渲染：单个滚动 child，每行定宽列文本（`propose  claude-x  high  CH 62%  4.2s  ok  Plan P3 selects B1,B4`），点击展开 detail，带 follow-tail 钉住与复制行按钮。**无 `session_status` 时渲染 `—`，绝不显示成 mismatch。**

可选第二个 tab（P2）：**Events** 列表，每行一个 domain 事件 + `ReplayIssue` 明细表。DOM 与事件模型就绪后几乎免费，调试价值高。

### 7.4 Graph（唯一主视图）

见 §6。`App.cpp` 变为无早返回的平铺序列：

```cpp
onDraw:
  ShellLayout L = computeShellLayout(io.DisplaySize.x, io.DisplaySize.y, rowH, panels);
  beginMainWindow();
    beginChild("header", L.header);  renderStatusBar(model, frameView); endChild();
    beginChild("canvas", L.canvas);  renderGraphView(view, graphState, layout, cursor); endChild();
    if (panels.open[BeliefList])    { beginChild("beliefs", L.beliefPanel); renderBeliefList(...); }
    if (panels.open[DispatchTrace]) { beginChild("trace",   L.tracePanel);  renderDispatchTrace(...); }
    if (panels.open[FrameControl])  { beginChild("frame",   L.framePane);   renderFramePaneContent(...); }
    beginChild("footer", L.footer);  renderFooter(model); endChild();
  endMainWindow();
  renderFramePane(panels.open[FrameControl], framePaneState, frameView, model, canSend, send);
  renderFileList(panels.open[FileList], model);
```

`LayoutMetrics.h` 由 `ShellLayout.h` 取代（其三栏几何已死）；`pi_gui_layout_test` 由 `pi_gui_shell_layout_test` 取代。

---

## 8. 里程碑

**过渡策略：只保 headless 绿。** M2–M5 期间 `pie_gui` 二进制不链接；分支中途不发布。每个里程碑的 **green gate** 是硬性出口。

| # | 里程碑 | 依赖 | Green gate |
|---|---|---|---|
| **M0** | **JSON DOM**：`Json.h/.cpp` + `Json.test.cpp` → `pi_gui_json_test`。fixture 含真实形状的 `RpcDomainSnapshot` 片段与真实 domain 事件行。 | — | `ctest -R pi_gui_json_test` |
| **M1** | **删代码优先**（安全，不动模型）：删 `BeliefLane` `CognitiveLane` `ExecutionLane` `Summary` `LogListBox`、死代码 `gui/main.cpp`、`frameMatchesQuery`、`FrameCursor`、`selectedTaskId_`/`viewId`、`graphOpen` 开关与 `Cmd/Ctrl+G`，并同步 CMake 源列表。`App.cpp` 在**旧模型**上变成 graph-only。**同一提交内**更新 `gui/AGENTS.md`：删除保护 `main.cpp` 的那段（否则下一个 agent 会把它加回来），并改写 `paneBg` 的措辞。 | — | 全量 `ctest`（集合不变）+ `./build/pie_gui` 启动，graph-only |
| **M2** | **v7 模型**：替换 `Model.h/.cpp`；新增 `DomainEvents.*`（25 类事件 + appliers）；v7 版 `DemoEvents.h`；`Domain.test.cpp` → `pi_gui_domain_test`。删除 `pi_gui_model_test`。 | M0 | `ctest -R 'pi_gui_json\|pi_gui_domain\|pi_gui_prompt\|pi_gui_path_complete\|pi_gui_palette_metrics'` |
| **M3** | **Bootstrap + adapter**：`get_domain_snapshot` + `get_state`、缓冲、幂等应用、`ReplayIssue`、`session_status` 解析、`PromptCmd.h` 新序列化器、reader 线程解析 + 预算化 drain。`Bootstrap.test.cpp` → `pi_gui_bootstrap_test`；扩展 `PromptCmd.test.cpp`。同时建 `--replay <jsonl>` 开发模式。 | M2 | `ctest` + `--replay <jsonl>` 打印派生模型 |
| **M4** | **Graph 投影 v7**：重写 `GraphModel`/`GraphTaskState`（Episode/Plan/Execution/Distillation/BeliefDelta/ExperimentSelection/Routing/Formulation/Outcome），补上 `plan→execution` 与 `execution→distillation` 边、Frame rail、cursor→node 解析。重写 `PieGraphLayout`（dot + rail + episode row）与 `GraphLive`（closed-episode 单位），适配保留 `GraphRouting`/`GraphInteraction`/`GraphCache`。 | M2 | `pi_gui_graph_projection_test`（取代 `pi_gui_graph_test`）、`pi_gui_graph_edges_test`（取代 `pi_gui_graph_m456_test`） |
| **M5** | **Canvas 简化**：`GraphView.cpp` 改为 dot + link + tooltip；删除内联标签；为**所有**节点族补 tooltip（今日 Plan 与 Distill 刻意没有，`GraphView.cpp:458-463`）；剪枝 `GraphStyle`；`paneBg` 重定向到 current-node halo。 | M4 | `pi_gui_graph_geometry_test`、`pi_gui_graph_live_test`（取代 `pi_gui_graph_m789_test`）+ `./build/pie_gui --demo` 目视确认 |
| **M6** | **Belief list 面板**：`BeliefListModel.*` + `BeliefList.test.cpp` → `pi_gui_belief_list_test`。 | M2 | 该目标 |
| **M7** | **调度轨迹面板**：`TraceModel.*` + `Trace.test.cpp` → `pi_gui_trace_test`（fixture 驱动，断言精确行，含 `model≠role` 徽标与 `—` 情形）。 | M3 | 该目标 |
| **M8** | **FormulationView + FramePane**：`FormulationView.*` + `Formulation.test.cpp` → `pi_gui_formulation_test`；`PromptPalette.*` → `FramePane.*`（状态横幅、Frame 内容、deferral/corrections/review/recheck 块、版本历史、Approve/Correct 动作、派生自动打开边沿）。 | M3 | 该目标 + `pi_gui_prompt_test` |
| **M9** | **Shell + graph-only App**：`ShellLayout.h` + `ShellLayout.test.cpp` → `pi_gui_shell_layout_test`（取代 `pi_gui_layout_test`）；`App.cpp` 重写为无早返回；四个面板接线；CMake 源列表定稿。 | M5,M6,M7,M8 | 全量 `ctest` + `./build/pie_gui --live` 与 `--demo` + `PI_GUI_SIZE=320x500` |
| **M10** | **文档**：`git mv roadmap docs/archive/roadmap`；本文件即交付计划；更新 `gui/AGENTS.md`（源布局、新的 no-animation 落点、roadmap 规则改指 archive）与 `gui/terminology.md`（lane/pane/palette 词条已死，新增 Frame / Episode / FramePane / BeliefList / DispatchTrace / ShellLayout）。**`git add gui/docs/`**。 | M9 | 文档 review 通过；`pi_gui` 仍全绿 |

**最终 CTest 集合（14 个，现为 9 个）**：
保留 `pi_gui_prompt_test` / `pi_gui_path_complete_test` / `pi_gui_palette_metrics_test`；移除 `pi_gui_model_test` / `pi_gui_graph_test` / `pi_gui_graph_m456_test` / `pi_gui_graph_m789_test` / `pi_gui_graph_label_layout_test` / `pi_gui_layout_test`；新增 `pi_gui_json_test` / `pi_gui_domain_test` / `pi_gui_bootstrap_test` / `pi_gui_formulation_test` / `pi_gui_trace_test` / `pi_gui_belief_list_test` / `pi_gui_graph_projection_test` / `pi_gui_graph_edges_test` / `pi_gui_graph_live_test` / `pi_gui_graph_geometry_test` / `pi_gui_shell_layout_test`。

`pi_gui_model` 静态库新增 `Json.cpp` / `DomainEvents.cpp` / `FormulationView.cpp` / `TraceModel.cpp` / `BeliefListModel.cpp`，并保留 `target_include_directories(pi_gui_model PUBLIC src)`，让 ImGui-free 边界继续由**链接图**强制。

---

## 9. 验证

**每里程碑**：`cd gui && cmake --preset debug && cmake --build --preset debug && ctest --preset debug` 全绿。

**端到端**（M5 之后每个里程碑）：
```bash
./build/debug/pie_gui --demo               # 脚本化事件流，不 spawn node
./build/debug/pie_gui --replay saved.jsonl # 无窗口，打印派生模型
./build/debug/pie_gui                      # 默认 --live
PI_GUI_SIZE=320x500 ./build/debug/pie_gui  # 窄窗
```
人工确认：无 `Could not load font file` 警告；拖拽/缩放正常；tooltip 显示节点全文；面板可独立开关且不重叠；Frame 面板在 `awaitingResponse` 时 Approve 可用。

**协议正确性**（关键回归，连真实 runtime）：
1. `get_domain_snapshot` 装载成功；
2. 一次蒸馏后 Belief 面板出现新 belief 且 status 派生正确 —— **这正是当前 GUI 收不到的事件**；
3. 一个 episode 关闭后，后续事件不改写它。

---

## 10. 风险

| 风险 | 缓解 |
|---|---|
| **JSON parser 对真实 payload 的正确性（最高）** | DOM parser 的笔误，用同一套心智模型写的单测抓不到。先建 `--replay <jsonl>`（headless 跑真实 transcript）与 `--dump-snapshot <file>`，M0/M3 就做，不拖后 |
| snapshot 体积卡帧 | reader 线程解析；主线程 drain 预算 48 行 / 4 ms；`Execution.output` 截断为 2000 字符预览 + 字节数 |
| bootstrap 重叠 bug | §5.3 的 applier 纯度契约 + 专项测试：`events→snapshot`、`snapshot→events`、`snapshot→同样的事件再来一遍` 三种顺序必须得到同一终态；重复的缓冲行不改变任何东西 |
| 构建/字体/平台回归 | CMake 改动只碰 `pie_gui` 与 `pi_gui_model` 的源列表；`FetchContent`、`find_package(Freetype)`、`APPLE` 分支、Sarasa 下载 + `POST_BUILD` 拷贝均不动。注意陈旧的 `build/` 会保留已删对象 —— M9 后配置到全新 binary dir；另注意删 `App.cpp` 的 include 时要真删文件，否则 ImGui 会被拖进 `pi_gui_model`，**静默破坏 headless 边界** |
| `GraphStyle` 剪枝破坏 `kGraphStyle` | `inline constexpr` 要求字面量/聚合类型：剪枝**单独一个提交**，且永不加 `std::string`；同提交删掉旧断言（`GraphM789.test.cpp:120`） |
| `session_status` 缺口 | 会话初期与 finalReport 无遥测。trace 与 footer 渲染 `—`，**绝不**把「缺遥测」显示成 mismatch。fixture 必须覆盖前几行完全没有 `session_status` |
| `degraded` 的权威性 | v1 只显示派生 `model≠role`，不宣称降级。若日后要权威标志，需在 pie 侧加 `RoleStatusSlot.degraded?`（约 3 行），那是独立决定 |
| 自动打开抖动 | 按 `versionId` 闩锁；只用 `awaitingResponse` 与 `resume.Failed` 触发；`decisionOwed`/`recheckOwed` 降级为常驻徽标 |
| 删掉被文档保护的代码 | `AGENTS.md:178-180` 明确保护 `main.cpp`；`AGENTS.md:183-193` 要求 roadmap 同步；`terminology.md` 记录了每个将删组件。三处必须与 M1/M10 **同提交**修改 |
| `gui/docs/` 未被跟踪 | `git status` 显示 `?? gui/docs/`。M10 必须 `git add gui/docs/`，roadmap 用 `git mv` 以保留历史 |

---

## 11. 不做的事

- 不实现 Protocol B（Chord/CBOR）。
- 不引入 `imgui-node-editor`（与 ImGui 1.92.9 不兼容，此前已否决）。
- 不新增第三方 JSON 库（保持离线可构建）。
- 不改动 `packages/pie/` 的任何代码 —— 纯前端重写。
- 不做动画/过渡；仅保留 `paneBg` 阶段脉冲（重定向到 current-node halo）。
- 不迁移平台后端（SDL3 仍是 future）。
- 不声称 GUI 拥有它无法观察到的事实（如真实的 model 降级）。
