# Phase 2 — P0 Node Graph View

A second main view for the PIE Native GUI, beside the existing three-lane
column/text view. This phase is set to **immediate priority**: it is the next P0
deliverable. No implementation exists yet (`src/` has no graph module, Cmd+G
toggle, or node-editor integration).

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

## Deliverables (planned)

| Graph View item | Expected location | Status |
|-----------------|-------------------|--------|
| `Cmd+G` Text/Graph view toggle | shared main window (same runtime model) | Planned |
| `graph/` module (`graph_*`) + `graph_view`, `graph_model`, `graph_projection`, `graph_renderer`, `graph_node_renderer`, `graph_link_renderer`, `graph_interaction`, `pie_graph_layout`, `graph_minimap`, `graph_style`) | `gui/src/graph/` | Planned |
| Read-only node-editor canvas (hidden pins, no drag/create/delete, no library layout persistence) | `imgui-node-editor` (vendored, pinned) | Planned |
| PIE layout engine (`PieGraphLayout`) | `gui/src/graph/pie_graph_layout.*` | Planned |
| Runtime contract (`GraphNode`/`GraphEdge`/`GraphTaskState`) | `gui/src/graph/graph_model.*` | Planned |

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

### PIE-specific layout engine (disambiguation)

P0 implements `PieGraphLayout`, which serves only the PIE cognition ontology
(Belief grid by creation order; frames by produce order; Plan upper region;
Execution right region; Distill lower region with return-flow). It deliberately
does NOT introduce Graphviz, a generic Sugiyama engine, or force-directed
layout.

This must be reconciled with two other roadmap/spec mentions of "graph
layout":

- **P0 non-goal `Generic auto layout`** (Node Graph View spec §28 / §22): the
  same rejection of generic auto-layout engines, now resolved by
  `PieGraphLayout`.
- **spec §29 "Not Current Priority": `elaborate graph layout`** (tracked under
  Phase 4 Future Integrations, still deferred): this refers to further
  decorative/general graph-layout polish beyond the PIE-specific engine, and
  remains out of current scope.

Both stay true: this phase owns the PIE-specific `PieGraphLayout`; generic and
"elaborate" layout remain non-goals / deferred.

### Per-region layout rules (PieGraphLayout sub-layouts)

- **§22.2 Belief Region**: creation-order grid (B01 B02 B03 ...); new beliefs
  append, existing beliefs never auto-move.
- **§22.3 Plan upper region**: ordered left→right by semantic dependency with a
  creation-order fallback on cycle / undecidable stratification; the goal is
  stability and determinism, not generic optimal layout.
- **§22.4 Execution right region**: stacked vertically by runtime execution
  order; this is position only and never creates temporal edges.
- **§22.5 Distill lower region**: laid out right→left (return flow back toward
  the Belief Region), so a frame reads `Belief → Plan → Execution → Distill →
  Belief`.

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
                 hidden pins, editing suppressed, no layout persistence, mock nodes)
M1 Graph Model   runtime data -> GraphTaskState projection (no Proposal/Observation
                 node; tool+result merged; no ExecutionStep wrapper; runtime-supplied edges)
M2 Nodes         belief/plan/execution/distill card renderers (status/result colors,
                 hidden pins, current/selected highlight, tooltip, "..." popup)
M3 Layout v1     PieGraphLayout (Belief grid, frames left->right, Plan top,
                 Exec right, Distill bottom, frame sizing) -> reads as feedback loop
M4 Edge Routing  local semantic edges + long Belief->Plan (top) / Distill->Belief
                 (bottom) routes, default dim, +/- operation glyphs
M5 Selection     click node -> ancestor + descendant dependency path (cycle-safe
                 visited set, cached adjacency), emphasize related, dim rest
M6 Live          runtime events (node/edge added, belief created/updated, current
                 changed, frame opened/closed); active relayout, closed freeze,
                 belief stable, no auto-follow
M7 Navigation    first-entry Focus Current, explicit Focus Current, Graph session
                 state preserved across Text<->Graph, custom minimap overlay
M8 Performance   50 frames / 500 nodes: layout cache, adjacency cache, render
                 cache, dirty flags, long-route cache
M9 Polish        spacing, typography, borders, dim ratios, arrows, padding, sizes
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
(`GraphNode`/`GraphEdge`/`GraphTaskState`). This is the P0 planned module layout
under `gui/src/graph/` (no code exists yet).

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
