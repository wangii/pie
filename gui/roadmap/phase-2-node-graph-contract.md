# Phase 2 — P0 Node Graph View

A second main view for the PIE Native GUI, beside the existing three-lane
column/text view. **M0-M9 are implemented** (see the Deliverables table).

## Purpose

Visualize the belief-driven cognitive feedback loop's semantic / provenance
structure for one complete User Task. The Text View answers "what happened, in
what order, with what content"; the Graph View answers "why are these things
connected, how does a belief drive execution, how does execution change a belief
via distillation, and where does a node come from and what it affects".

The authoritative spec is the user-provided Node Graph View spec (§1-§32). This
roadmap phase records implementation status, dependencies, and the core runtime
contract to implement; it does not restate the spec as a new requirement.

## Spec sections

Node Graph View spec §1-§32 (Goal, Design Principle, Scope, Layout, Node
Ontology, Proposal Projection, Edges, Selection, View Switch, Live, Layout
Engine, Runtime Contract, Module Structure, Milestones, Non-Goals, P1
Candidates, Success Criterion).

## Deliverables

| Graph View item | Expected location | Status |
|-----------------|-------------------|--------|
| `Cmd+G` Text/Graph view toggle | shared main window (same runtime model) | Implemented (M0) `src/App.cpp` |
| `graph/` module (`graph_*`) + `graph_view`, `graph_model`, `graph_projection`, `graph_renderer`, `graph_node_renderer`, `graph_link_renderer`, `graph_interaction`, `pie_graph_layout`, `graph_minimap`, `graph_style`) | `gui/src/graph/` | Implemented (M0-M9): `GraphModel.*`, `PieGraphLayout.*`, `GraphView.*`, `GraphRouting.*`, `GraphInteraction.*`, `GraphLive.*` (the renderer/node/link and `graph_renderer`/`graph_node_renderer`/`graph_link_renderer` duties fold into `GraphView`), plus `GraphMinimap.*` (M7 navigation), `GraphCache.*` (M8 caches), and the `GraphStyle` config (M9 style) |
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

### Highest-level layout

Belief Region (global, left) feeds the frames laid left→right. Inside a frame:
Plan-family nodes top, Execution/Tool nodes right, Distill-family nodes bottom.
This yields the direction `Belief → Plan → Execution → Distill → Belief` per
frame, which is a feedback loop, not a linear pipeline.

### Node ontology

- **Belief**: compact relationship card, status by color, globally unique,
  creation-order stable (mutable content/color, immutable identity/position).
- **Plan**: intent/reasoning card; family = PLAN, subtype is runtime display
  metadata. Selected beliefs are expressed only by incoming edges.
- **Execution / Tool**: tool call + result merged into one node; no separate
  Observation node; success/failure by color.
- **Distill**: family = DISTILL, subtype is runtime display metadata.

No Proposal node and no synthetic Observation/ExecutionStep wrapper: the
epistemic result is `Distill → Belief` with `~` (update) / `+` (create) glyphs,
and is runtime-provided, not inferred by the GUI.

### Edges and cross-frame semantics

All edges are typed, directed, explicit. Default UI shows no edge labels and no
edge legend. Cross-frame cognition passes only through Belief; direct
`Frame#3 Distill → Frame#8 Plan` is not allowed. Long `Belief → Plan` routes go
along the top outer periphery and long `Distill → Belief` routes along the
bottom, with cross-frame long edges defaulting to subdued and emphasizing only on
selection.

### LoopFrame boundary (one propose as delimiter)

A LoopFrame is the container for one complete epistemic transaction. At the
cognitive level it is delimited by a single Proposal: the frame's
plan/execution/distillation run and it produces exactly one proposal, which is
the epistemic boundary of that turn. The Graph View maps one User Task's frames
to the horizontal top-level layout; frames do not own Belief nodes (beliefs are
global in the Belief Region).

**Event boundary (must not be conflated with `ProposalCreated`).** The user-word
"a single propose as the boundary" is a conceptual/cognitive boundary, but the
GUI/runtime only closes a frame on an explicit close event: `CursorChanged` with
`stage=CLOSED`, `turn_end` / `agent_settled`, or `FrameClosed` (demo path).
`ProposalCreated` only appends a proposal to the frame's proposal list and never
closes the frame; it is not the close event. The roadmap therefore records the
boundary as "one proposal per frame" for cognition, and the close trigger as the
runtime close event, not `ProposalCreated`.

### Node visual language (single card family)

All nodes share one card family. Different node types use light structural
variation, never classic flowchart shapes: no diamond, no hexagon, no UML-style
shape grammar. Belief = relationship-first card (color = belief status); Plan =
intent/reasoning card (neutral cognitive styling); Tool/Execution = code-like
structure (color = execution result); Distill = semantic-statement card, with
inputs/outputs expressed by edges.

### LoopFrame container header

The frame container is the only explicit group (no nested Plan/Distill groups).
Its header is minimal: `LoopFrame #<n>` plus an optional short `EXECUTING` marker
when the active runtime state is present. It shows no summary, no selected
beliefs, no proposal count, and no explanation — all of that is read from the
graph itself.

### CURRENT vs SELECTED

CURRENT and SELECTED are distinct states. CURRENT = which node the runtime is
executing now; SELECTED = which node the user is inspecting. Only the CURRENT
node is highlighted (with its stage-indicator); the current LoopFrame is not
extra-highlighted, and no animation is used.

### Read-only contract

P0 is read-only: pan, zoom, select, tooltip, temp popup, minimap, and Focus
Current are allowed; node drag, link create/delete, node create, belief edit,
reconnect, frame move, and semantic mutation are forbidden. The GUI never
infers cognition; `GraphNode`/`GraphEdge`/`GraphTaskState` semantic edges are
runtime-supplied.

### PIE-specific layout engine (Graphviz auto-layout)

P0 implements `PieGraphLayout`, which projects the PIE cognition ontology
(nodes/edges) into a Graphviz directed graph and runs the DOT automatic layout
engine to position nodes. The layout is deterministic for an identical
`GraphTaskState` (same input graph and Graphviz version). The GUI never infers
cognition: node/edge semantic types are runtime-supplied; only positions come
from the engine.

- **Dependency**: Graphviz is a hard build dependency. CMake finds it via
  pkg-config modules `libcgraph` / `libgvc` (note: not `graphviz`/`gvc`),
  propagates it to the model library and app, and errors with an explicit
  install hint (`brew install graphviz` / `apt-get install libgraphviz-dev`)
  if missing. There is no silent fallback to a hand-rolled layout.
- **Geometry**: post-layout node positions/sizes are read via the C API macros
  `ND_coord` / `ND_width` / `ND_height` (accessing `Agnodeinfo_t` through
  `AGDATA`); sizes are in inches and are scaled by 72 points/inch. The Graphviz
  `bb` graph bounding box is space-separated (`xmin ymin xmax ymax`) and is
  used to translate/flip coordinates from Graphviz's bottom-left origin to the
  viewer's top-left y-down space.
- **Contract**: the general layout contract is that every node gets a
  positive-size rectangle, node rectangles do not overlap, the canvas size is
  positive, and each frame has a container rectangle. The previous per-region
  directional ordering (Belief left-of-Plan, Distill return-leftward) is NOT
  guaranteed by the DOT engine and is deliberately not asserted; the
  auto-layout is top-down by edge direction.

### Per-region layout (superseded)

The prior hand-rolled `PieGraphLayout` placed a Belief creation-order grid, Plan
upper region, Execution right region, and Distill lower right→left return flow.
Under the Graphviz auto-layout those per-region directional rules are replaced
by the engine's general placement; tests assert only the general contract
(valid, non-overlapping, framed, positive canvas) enumerated above.

### Runtime contract (to be supplied by the runtime)

```cpp
struct GraphNode {
    NodeId id;
    NodeFamily family;            // Belief | Plan | Execution | Distill
    optional<LoopFrameId> frame_id;
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
M2 Nodes         belief/plan/execution/distill card renderers (status/result colors,
                 hidden pins, current/selected highlight, tooltip, "..." popup)  [implemented]
M3 Layout v1     PieGraphLayout -> Graphviz dot auto-layout (project nodes/edges,
                 run DOT, ND_coord/ND_width/ND_height -> nodeRects/frameRects);
                 general contract: valid, non-overlapping, framed, positive canvas  [implemented]
M4 Edge Routing  local semantic edges + long Belief->Plan (top) / Distill->Belief
                 (bottom) routes, default dim, +/- operation glyphs  [implemented]
M5 Selection     click node -> ancestor + descendant dependency path (cycle-safe
                 visited set, cached adjacency), emphasize related, dim rest  [implemented]
M6 Live          runtime events (node/edge added, belief created/updated, current
                 changed, frame opened/closed); active relayout, closed freeze,
                 belief stable, no auto-follow  [implemented]
M7 Navigation    first-entry Focus Current, explicit Focus Current, Graph session
                 state preserved across Text<->Graph, custom minimap overlay
                 (GraphMinimap.* + GraphView overlay + GraphViewState.hasFocusedOnce)  [implemented]
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
frames"). Do not over-invest in card detail before M3/M4.

### P0 non-goals

No graph editing, node dragging, manual edge creation, frame collapse, graph
search, node-type filter, generic auto layout, historical belief snapshots,
Proposal nodes, Observation nodes, side inspector, animation, layout
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
dependency path / focus; `graph_minimap` handles overview navigation;
`graph_model` holds the runtime contract types
(`GraphNode`/`GraphEdge`/`GraphTaskState`). M0-M9 implement the core of this
layout under `gui/src/graph/`: `GraphModel` holds the runtime contract types and
the runtime->graph projection (`graph_projection`), `PieGraphLayout` is the
`pie_graph_layout` positions pass, `GraphView` is the graph renderer + node
renderer + canvas (and the M7 minimap overlay + M9 style consumer), `GraphRouting`
is the m4 edge-routing pass, `GraphInteraction` is the `graph_interaction`
selection / dependency-path pass, `GraphLive` is the m6 live-layout stability
pass, `GraphMinimap` is the `graph_minimap` M7 navigation geometry, `GraphCache`
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
