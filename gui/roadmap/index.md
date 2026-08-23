# PIE Native GUI Roadmap

Delivery plan for the PIE Native GUI layer in `gui/`. The roadmap organizes the
spec by delivery phase (Phase 0 through Phase 3) and tracks the current
implementation status, cross-phase dependencies, and links to the underlying
spec sections and source files.

## Spec reference

- **Source of truth**: the PIE Native GUI Layer spec. Section numbers below refer
  to that spec and are the authority for requirements; this roadmap records
  implementation status and dependencies, not new requirements.

## Phase overview

| Phase | Focus | Status | Spec sections |
|-------|-------|--------|---------------|
| [Phase 0](phase-0-foundations.md) | Foundations / boundary | Implemented | 4, 24-28 |
| [Phase 1](phase-1-p0-workspace.md) | P0 workspace | Implemented | 1-3, 5-18, 21-23, 29-31 |
| [Phase 2](phase-2-p1-inspection.md) | P1 inspection / navigation | Partial | 19, 20, 30 (P1) |
| [Phase 3](phase-3-future-integrations.md) | Future integrations | Not started | 24-26, 29-31 (future) |

## Implementation status

- **Implemented and verified**: Phase 0 and Phase 1. Both are backed by a
  headless model test (`pi_gui_model_test`, 37/37) and an instruction
  serialization/pipe test (`pi_gui_instruction_test`, 8/8), plus a successful
  `cmake --build .` and `ctest` (2/2).
- **Partial**: Phase 2. Belief filtering and frame search are implemented;
  proposal-to-source jump, frame comparison, and full provenance inspection are
  not yet present.
- **Not started**: Phase 3. These are explicitly deferred by the spec's "Not
  Current Priority" and future-integration notes.

## Phase dependencies

- Phase 1 depends on Phase 0: the model layer and runtime-client boundary
  (Phase 0) are consumed by the three-lane ImGui workspace (Phase 1).
- Phase 2 depends on Phase 1: navigation/inspection operates on the frame
  history and the P0 workspace already built in Phase 1.
- Phase 3 depends on Phases 0-2 and is gated on the spec's future scope.

## Key invariants (cross-cutting)

- The GUI never infers `FrameStage`, cursor, or epistemic meaning from a generic
  log. All such state comes only from the runtime event stream.
- `Proposal != BeliefUpdate`: `ProposalCreated` appends a proposal; only
  `BeliefUpdated` mutates belief state. Closed-frame history is immutable.
- The GUI keeps the GLFW + Dear ImGui + OpenGL3 backend (per spec §25 this stack
  is a recommendation, not a hard requirement; SDL3/SDL_GPU is a future option).

## Navigation

- [index.md](index.md) — this file (overview, status, dependencies)
- [phase-0-foundations.md](phase-0-foundations.md)
- [phase-1-p0-workspace.md](phase-1-p0-workspace.md)
- [phase-2-p1-inspection.md](phase-2-p1-inspection.md)
- [phase-3-future-integrations.md](phase-3-future-integrations.md)
