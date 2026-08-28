# PIE Native GUI Roadmap

Delivery plan for the PIE Native GUI layer in `gui/`. The roadmap organizes the
spec by delivery phase (Phase 0 through Phase 4) and tracks the current
implementation status, cross-phase dependencies, and links to the underlying
spec sections and source files.

The target cross-runtime/GUI Session/Task/TaskFrame business contract lives in
[`packages/pie/docs/domain-model.md`](../../packages/pie/docs/domain-model.md).
This roadmap tracks the current GUI implementation and its migration gaps; its
rendering structures are not a second source of business truth.

## Spec reference

- **Source of truth**: the PIE Native GUI Layer spec. Section numbers below refer
  to that spec and are the authority for requirements; this roadmap records
  implementation status and dependencies, not new requirements.

## Phase overview

| Phase | Focus | Status | Spec sections |
|-------|-------|--------|---------------|
| [Phase 0](phase-0-foundations.md) | Foundations / boundary | Implemented | 4, 24-28 |
| [Phase 1](phase-1-p0-workspace.md) | P0 workspace | Implemented | 1-3, 5-18, 21-23, 29-31 |
| [Phase 2](phase-2-node-graph-contract.md) | P0 Node Graph View | Implemented (M0-M9) | Node Graph View spec 1-32 |
| [Phase 3](phase-3-p1-inspection.md) | P1 inspection / navigation | Partial | 19, 20, 30 (P1) |
| [Phase 4](phase-4-future-integrations.md) | Future integrations | Not started | 24-26, 29-31 (future) |

## Implementation status

- **Implemented and verified**: Phase 0 and Phase 1. Both are backed by a
  headless model test (`pi_gui_model_test`, 37/37) and an instruction
  serialization/pipe test (`pi_gui_instruction_test`, 8/8), plus a successful
  `cmake --build .` and `ctest` (2/2).
- **Implemented (M0-M9)**: Phase 2. The P0 Node Graph View is built for M0-M9:
  `src/graph/` gains `GraphModel` (runtime contract), `PieGraphLayout` (layout
  engine), `GraphView` (a read-only custom ImGui canvas), `GraphRouting`
  (m4 edge routing), `GraphInteraction` (m5 selection dependency path),
  `GraphLive` (m6 live-layout stability), `GraphNavigation` (m7 Focus Current
  pan), `GraphCache` (m8 caches), and the `GraphStyle` config (m9 style); the
  m7 stage indicator lives in `GraphView`; a Cmd/Ctrl+G Text<->Graph toggle
  lives in `App.cpp`; and the headless `pi_gui_graph_test`
  (M1 projection + M3 layout), `pi_gui_graph_m456_test` (m4/m5/m6), and
  `pi_gui_graph_m789_test` (m7/m8/m9) cover the implementation. LoopFrames are
  logical propose cycles within a task, stacked top-to-bottom in the fixed
  Belief / Plan+Distillation / Execution layout.
- **Partial**: Phase 3. Belief filtering and frame search are implemented;
  proposal-to-source jump, frame comparison, and full provenance inspection are
  not yet present.
- **Not started**: Phase 4. These are explicitly deferred by the spec's "Not
  Current Priority" and future-integration notes.

## Phase dependencies

- Phase 1 depends on Phase 0: the model layer and runtime-client boundary
  (Phase 0) are consumed by the three-lane ImGui workspace (Phase 1).
- Phase 2 (Node Graph View) depends on Phase 0's runtime model boundary and
  `FrameStage` semantics, and on the frame history / active frame / live RPC
  event stream from Phase 1 to determine `current_node` and frame grouping. It
  does not depend on the three-lane workspace rendering itself.
- Phase 3 depends on Phase 1: navigation/inspection operates on the frame
  history and the P0 workspace already built in Phase 1.
- Phase 4 depends on Phases 0-3 and is gated on the spec's future scope.

## Key invariants (cross-cutting)

- The GUI never infers `FrameStage`, cursor, or epistemic meaning from a generic
  log. All such state comes only from the runtime event stream.
- `Proposal != BeliefUpdate`: `ProposalCreated` appends a proposal; only
  `BeliefUpdated` mutates belief state. Closed-frame history is immutable.
- The GUI keeps a platform layer (`src/plats/`): a native Cocoa/MTKView shell
  with `imgui_impl_osx` + `imgui_impl_metal` on macOS, and the `glfw`/`opengl3`
  backend on other platforms (per spec §25 this stack is a recommendation, not a
  hard requirement; SDL3/SDL_GPU is a future option).

## Navigation

- [index.md](index.md) — this file (overview, status, dependencies)
- [phase-0-foundations.md](phase-0-foundations.md)
- [phase-1-p0-workspace.md](phase-1-p0-workspace.md)
- [phase-2-node-graph-contract.md](phase-2-node-graph-contract.md)
- [phase-3-p1-inspection.md](phase-3-p1-inspection.md)
- [phase-4-future-integrations.md](phase-4-future-integrations.md)
