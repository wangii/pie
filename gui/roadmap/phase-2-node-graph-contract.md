# Phase 2 — P0 Node Graph View

A second main view for the PIE Native GUI, beside the existing three-lane
column/text view. **M0-M9 are implemented** (see the Deliverables table).

## Purpose

Visualize the belief-driven cognitive feedback loop's semantic / provenance
structure for one complete User Task. The Text View answers "what happened, in
what order, with what content"; the Graph View answers "why are these things
connected, how does a belief drive execution, how does execution change a belief
via distillation, and where does a node come from and what it affects".

`GraphTaskState` is a GUI rendering projection, not the shared business model.
The target Session/Task/TaskFrame ownership and event contract is defined in
[`packages/pie/docs/domain-model.md`](../../packages/pie/docs/domain-model.md).

The authoritative spec is the user-provided Node Graph View spec (§1-§32). This
roadmap phase records implementation status, dependencies, and the core GUI
projection contract; it does not restate the spec as a new requirement.

## Spec sections

Node Graph View spec §1-§32 (Goal, Design Principle, Scope, Layout, Node
Ontology, Proposal Projection, Edges, Selection, View Switch, Live, Layout
Engine, Runtime Contract, Module Structure, Milestones, Non-Goals, P1
Candidates, Success Criterion).

## Deliverables

| Graph View item | Expected location | Status |
|-----------------|-------------------|--------|
| `Cmd+G` Text/Graph view toggle | shared main window (same runtime model) | Implemented (M0) `src/App.cpp` |
| `graph/` module (`graph_*`) + `graph_view`, `graph_model`, `graph_projection`, `graph_renderer`, `graph_node_renderer`, `graph_link_renderer`, `graph_interaction`, `pie_graph_layout`, `graph_navigation`, `graph_style`) | `gui/src/graph/` | Implemented (M0-M9): `GraphModel.*`, `PieGraphLayout.*`, `GraphView.*`, `GraphRouting.*`, `GraphInteraction.*`, `GraphLive.*` (the renderer/node/link and `graph_renderer`/`graph_node_renderer`/`graph_link_renderer` duties fold into `GraphView`), plus `GraphNavigation.*` (M7 Focus Current pan), `GraphCache.*` (M8 caches), and the `GraphStyle` config (M9 style); the M7 stage indicator lives in `GraphView` |
| Read-only node-editor canvas (hidden pins, no drag/create/delete, no library layout persistence) | custom `GraphView` canvas (see deviation below) | Implemented (M0/M2) `src/graph/GraphView.*` |
| PIE layout engine (`PieGraphLayout`) | `gui/src/graph/pie_graph_layout.*` | Implemented (M3) `src/graph/PieGraphLayout.*` |
| Runtime contract (`GraphNode`/`GraphEdge`/`GraphTaskState`) | `gui/src/graph/graph_model.*` | Implemented (M1) `src/graph/GraphModel.*` |

### Implementation deviation: custom canvas instead of vendored node-editor

The original plan pinned `imgui-node-editor` (vendored). That dependency does
not compile against the project's pinned Dear ImGui 1.92.9:

- `imgui_extra_math.inl` unconditionally defines ImVec2 `operator==`/`!=`/`*`,
  which collide with the operators ImGui 1.92.9 provides when
  `IMGUI_DEFINE_MATH_OPERATORS` is defined (hard redefinition errors).
- v0.9.3 also calls the removed `ImRect::Floor()` and `ImGui::GetKeyIndex()`.
- master drops those, but still conflicts on the operators and on the changed
  `ImCubicBezierDt` signature.

To stay on the pinned ImGui while delivering M0/M2, the canvas is a custom
`src/graph/GraphView.*` that renders the same read-only affordances
(pan/zoom/select/hidden-pins-suppressed editing/current/selected highlight,
tooltip) directly with ImGui draw primitives. It keeps the repo convention of
not defining `IMGUI_DEFINE_MATH_OPERATORS` (offsets are field-wise ImVec2
construction, as in `BeliefLane.cpp`).

## Key elements

### Design principle and scope

Graph View displays only semantic / epistemic dependency, never pure temporal
sequence. Chronology may influence position, never topology. Scope is one User
Task (not one LoopFrame), P0 target ~50 LoopFrames / ~500 nodes, all frames
expanded by default (no frame collapse in P0).

Current limitation: `projectGraphTask` projects every frame held by one
`NativeGuiModel`; the model has no first-class Task collection/selection. The
target domain contract makes the one-Task scope enforceable instead of relying
on one task per viewer session.

### Highest-level layout

LoopFrames are complete rows stacked top→bottom in cognition order. Each
LoopFrame starts at propose and carries at most one Plan and one Distillation;
multiple Execution Blocks stack vertically on the right. A second PlanProduced
or DistillationProduced closes the frame and opens a fresh one, so a row never
holds more than one Plan or one Distillation node. The global Belief Set is the
fixed left column; each row has Plan in the upper middle, Distillation in the
lower middle, and vertically ordered Execution Blocks on the right. This yields
`Belief → Plan → Execution → Distill → Belief` within a row while preserving
the task's accumulated history down the canvas.

### Node ontology

A node is a small family/status indicator dot followed by a free-standing text
label (not a card wrapping its text).

- **Belief**: indicator dot + label, status by color, globally unique,
  creation-order stable (mutable content/color, immutable identity/position).
- **Plan**: indicator dot + label; family = PLAN, subtype is runtime display
  metadata. Selected beliefs are expressed only by incoming edges.
- **Execution / Tool**: tool call + result merged into one node; no separate
  Observation node; success/failure by color; the label is a simplified
  `<tool> <command>` summary (e.g. `read requirements.txt`, `bash pip show pytest`).
- **Distill**: indicator dot + label; family = DISTILL, subtype is runtime display
  metadata.

No synthetic Observation/ExecutionStep wrapper: a ProposalCreated occurrence is
projected as a Propose node on the chain `Distill → Propose → Belief` (`+` =
create, `~` = update, `-` = remove, `?` = unresolved; create write-backs dashed,
the rest solid; no on-link operation glyph), and is runtime-provided, not
inferred by the GUI. Old data without a Proposal record keeps the direct
`Distill → Belief` edge. A proposal whose target belief is not in the projected
belief set is dropped rather than leaving a dangling edge.

### Edges and cross-frame semantics

All graph edges are typed and directed. The UI includes a compact legend but
does not put labels on individual edges. Cross-frame cognition passes only
through Belief; direct `Frame#3 Distill → Frame#8 Plan` is not allowed.
`Belief → Plan` uses a direct single-segment line; `Distill → Belief` and
`Propose → Belief` are direct two-point lines (the write-back returns to the
belief column as a single straight segment). `Plan → Execution`, `Execution →
Distill`, and `Distill → Propose` remain local curves. Create write-backs are
dashed and the rest are solid.

The current live adapter still derives some correlations: it associates tool
calls with the active plan, attributes otherwise unconsumed executions to a
distillation, and binds belief changes to the active distillation/frame. These
are compatibility projections, not authoritative cognition. The target runtime
events explicitly carry Plan→Execution, Execution→Distillation, and
Distillation→BeliefDelta ids.

### LoopFrame boundary (entering propose is the delimiter)

A LoopFrame is one cognition-feedback cycle inside a User Task. Every explicit
`CursorChanged(stage=PROPOSING)` entry starts a new LoopFrame; `frameId` in live
RPC events remains the runtime task id, so several logical LoopFrames can share
one task id. The first propose entry reuses an empty task placeholder. A later
entry closes the prior logical frame and opens the next one. `turn_end` and
`agent_settled` are model-turn boundaries and do not close a belief-loop frame;
`CursorChanged(stage=CLOSED)` closes the final frame. Demo `FrameOpened` /
`FrameClosed` events remain explicit frame boundaries.

`ProposalCreated` still only appends a proposal and never opens or closes a
frame. Frames do not own Belief nodes: beliefs are global, with separate
creation provenance used only to align a newly created belief with the row that
produced it.

This delimiter documents the current adapter only. Under the target domain
contract, the runtime emits `FrameOpened`/`FrameClosed` with stable string ids;
the GUI does not split frames on `PROPOSING`, a second plan, or a second
distillation.

### Node visual language (indicator + label)

All nodes share one visual family: a small indicator dot (color = family/status,
with the execution status mark drawn inside for Execution nodes) preceding a
free-standing text label. No differential cards, no classic flowchart shapes: no
diamond, no hexagon, no UML-style shape grammar. Belief = status-colored dot +
label (or the routing/framing domain color when the runtime supplies a domain);
Plan = neutral dot + label; Tool/Execution = result-colored dot + simplified
`<tool> <command>` label; Distill = dot + label, with inputs/outputs expressed by
edges.

### LoopFrame container header

Each row has subtle Plan, Distillation, and Execution region surfaces plus a
dashed LoopFrame boundary. Its label is the logical order `LoopFrame #<n>`; it
shows no summary, selected-belief list, or proposal count.

Routing and framing belief cards are laid out in reserved slots that hug a
boundary: routing sits directly above the whole loop-frame area; framing (the
current "target") hugs the NEXT loopframe's top border when one follows the
current frame, else the loop-frame area top border. Neither is fixed to the
current frame. They use distinct domain colors, so the belief element itself
carries the domain role. Beliefs without a routing/framing domain stay in the
global creation-order left column.

### CURRENT vs SELECTED

CURRENT and SELECTED are distinct states. CURRENT = which node the runtime is
executing now; SELECTED = which node the user is inspecting. Only the CURRENT
node is highlighted (with its stage-indicator); the current LoopFrame is not
extra-highlighted, and no animation is used.

### Read-only contract

P0 is read-only: pan, zoom, select, tooltip, temp popup, and Focus Current are
allowed; the M7 stage indicator is drawn by the Graph View; node drag, link create/delete, node create, belief edit,
reconnect, frame move, and semantic mutation are forbidden. The GUI never
mutates cognition. `GraphNode`/`GraphEdge`/`GraphTaskState` are display
projections; temporary inference in the current RPC adapter is removed when the
target explicit domain correlations are available.

### PIE-specific deterministic layout engine

`PieGraphLayout` directly implements the ontology instead of delegating to a
generic graph engine. It computes fixed semantic columns, sizes each LoopFrame
row to the maximum of its belief group, Plan/Distillation bands, and Execution
stack, then advances to the next row. Plans and Distillations expand
horizontally; Executions and Beliefs expand vertically. Beliefs stay globally
unique and creation-ordered. New beliefs begin at their producing frame's row
top, with an explicit per-round marker.

Graphviz and pkg-config are not build dependencies. Identical
`GraphTaskState` input produces identical rectangles. Tests assert positive
geometry, no node overlap, top-to-bottom frame separation, and the fixed
Belief / middle / Execution ordering.

### Current GUI projection contract

This contract feeds layout/rendering. It is intentionally downstream of the
shared domain model and must not become a second source of business truth.

```cpp
struct GraphNode {
    NodeId id;
    NodeFamily family;            // Belief | Plan | Execution | Distill
    optional<LoopFrameId> frame_id;
    optional<LoopFrameId> created_in_frame;  // Belief provenance only
    string display_type;
    string title;
    string compact_text;
    string full_text;
    NodeVisualState state;
    uint64_t creation_order;
    optional<uint64_t> execution_order;
};

struct GraphEdge {
    EdgeId id;
    NodeId source;
    NodeId target;
    EdgeSemanticType type;
    optional<BeliefOperation> belief_operation;  // Create | Update
};

struct GraphTaskState {
    vector<GraphNode> nodes;
    vector<GraphEdge> edges;
    vector<LoopFrameInfo> frames;
    optional<NodeId> current_node;
};
```

### Milestones (M0-M9)

```text
M0 Canvas        node-editor integration spike (Cmd+G toggle, pan/zoom/select,
                 hidden pins, editing suppressed, no layout persistence, mock nodes)   [implemented]
M1 Graph Model   runtime data -> GraphTaskState projection (no Proposal/Observation
                 node; tool+result merged; no ExecutionStep wrapper; runtime-supplied edges)  [implemented]
M2 Nodes         belief/plan/execution/distill indicator+label renderers (status/result
                 colors, hidden pins, current/selected highlight, tooltip, "..." popup)  [implemented]
M3 Layout v1     deterministic three-column semantic layout; LoopFrame rows
                 stacked top-to-bottom; valid, non-overlapping region geometry  [implemented]
M4 Edge Routing  local curves + direct Belief->Plan line; direct
                 Distill->Belief line, default dim, dashed-create/solid-update
                 styling (no on-link operation glyph)  [implemented]
M5 Selection     click node -> ancestor + descendant dependency path (cycle-safe
                 visited set, cached adjacency), emphasize related, dim rest  [implemented]
M6 Live          runtime events (node/edge added, belief created/updated, current
                 changed, frame opened/closed); active relayout, closed freeze,
                 belief stable, no auto-follow  [implemented]
M7 Navigation    first-entry Focus Current, explicit Focus Current, Graph session
                 state preserved across Text<->Graph, Stage indicator
                 (GraphView draws it from the runtime stage; Focus Current pan in
                 GraphNavigation.* + GraphViewState.hasFocusedOnce)  [implemented]
M8 Performance   50 frames / 500 nodes: layout cache, adjacency cache, render
                 cache, dirty flags, long-route cache (GraphCache.* with content
                 fingerprint invalidation + GraphCacheMetrics; 500-node x 50-frame
                 reuse/invalidation test)  [implemented]
M9 Polish        spacing, typography, borders, dim ratios, arrows, padding, sizes
                 (centralized GraphStyle config consumed by GraphView / layout /
                 routing)  [implemented]
```

Implementation order is M0 → M9; the real technical risk concentrates in M3+M4
(keeping a feedback loop legible under "global beliefs + horizontally growing
frames"). Do not over-invest in node label detail before M3/M4.

### P0 non-goals

No graph editing, node dragging, manual edge creation, frame collapse, graph
search, node-type filter, generic auto layout, historical belief snapshots,
Observation nodes, side inspector, animation, layout
persistence, or shared Text/Graph selection.

### P1 candidates (only if real use justifies)

Graph search (Cmd+F), type filtering (Belief/Plan/Exec/Distill), frame collapse,
historical belief state, edge-type inspection, compare paths/frames.

### P0 success criterion

On a 50-frame / 500-node task the user can quickly answer: current beliefs
(Belief Region); why a frame ran these things (`Belief → Plan → Execution`);
which execution results entered cognition (explicit `Execution → Distill` edges);
why a belief changed (click Belief, ancestor highlight); what a belief caused
(click Belief, descendant highlight); and where the agent is (the single CURRENT
node).

### Module structure and responsibility split

Runtime and responsibilities are strictly separated: `graph_projection` maps
runtime → graph model; `pie_graph_layout` maps graph model → positions;
`graph_renderer` (with `graph_node_renderer` / `graph_link_renderer`) turns
positions + model → ImGui/node-editor; `graph_interaction` handles selection /
dependency path / focus; `graph_navigation` handles the Focus Current pan;
`graph_model` holds the runtime contract types
(`GraphNode`/`GraphEdge`/`GraphTaskState`). M0-M9 implement the core of this
layout under `gui/src/graph/`: `GraphModel` holds the runtime contract types and
the runtime->graph projection (`graph_projection`), `PieGraphLayout` is the
`pie_graph_layout` positions pass, `GraphView` is the graph renderer + node
renderer + canvas (and the M7 stage indicator + M9 style consumer), `GraphRouting`
is the m4 edge-routing pass, `GraphInteraction` is the `graph_interaction`
selection / dependency-path pass, `GraphLive` is the m6 live-layout stability
pass, `GraphNavigation` is the `graph_navigation` M7 Focus Current pan geometry, `GraphCache`
is the M8 cache / invalidation pass, and `GraphStyle` is the `graph_style` M9
central config.

### Final mental model

Text View = "what happened". Graph View = "why is it connected". Belief Region =
"what do we currently believe". LoopFrames = "how interaction with the world
produced changes to those beliefs". The Graph View makes the whole task read as a
repeated belief → action → evidence → belief feedback structure, connected by
semantic dependency across time, not as a timeline or a linear pipeline.

## Dependency (from Phase 2 to prior phases)

- Depends on **Phase 0**: the runtime model boundary, `FrameStage` semantics,
  and the event-driven model (`NativeGuiModel`) the graph projection consumes.
- Depends on **Phase 1**: the frame history / active frame / live RPC event
  stream that supply `current_node` and frame grouping, and the shared runtime
  model both views read. Graph View does not depend on the three-lane rendering
  itself.

## Verification (once implemented)

- `Cmd+G` toggles to a read-only graph: pan / zoom / select works, no semantic
  editing possible, `Cmd+G` returns to Text.
- `src/` gains a `graph/` module; `graph_model_test` (headless) proves the
  runtime → GraphTaskState projection and the PieGraphLayout output.
- Headless layout/geometry and runtime-contract tests pass in `ctest`.
- Doc-consistency check: `index.md` links resolve; phase table / status /
  dependencies / navigation match the actual files.
