# Phase 9 — Preserve failure evidence across terminal frames

**Status: IN PROGRESS.** Phase 7/8 fix why Frames expire (lease derivation) and how Frames are created, but neither preserves the world evidence accumulated during a failed episode for the next epistemic decision. This phase addresses that gap without adding primitives or narrative summarization. Sections 9.1 and 9.2 are implemented with deterministic coverage; 9.3 remains conditional on real-model evaluation.

### Problem to correct

When a Frame terminates (`expired`, `falsified`, `replaced`) or an Action returns `UNRESOLVABLE`, the evidence accumulated during the episode is dropped from model-visible context:

- `context-compiler.ts` `frameMessage()` emits only `[CURRENT FRAME]` (commitment + falsifier + response lease). Terminal `frame_transition` events and their reasons stay in the raw log and are never projected into any context message; `projectActionOutcomes()` iterates only `action_transition`, and `restoreEpistemicState()` exposes only the admissible (non-terminal) Frame.
- `actionOutcomeMessage()` surfaces `[ACTION OUTCOME]` with outcome/challenge/control reason, but only when `broadProjection` is true (epistemic/finalAnswer roles), budget-limited, and the reason is structural (`Frame reached its N-response horizon before the completion condition was met`), not what was discovered.
- `selectBroadRawEventIds()` for the epistemic role keeps only the last user message plus the last non-control assistant message and its tool results; finalAnswer keeps only the last user message. After a Frame expires, epistemic reconsideration sees the last round, not the accumulated `read`/`bash`/test results from the whole episode.

The result: a failed episode's falsifying or near-falsifying evidence, and the reason it could not complete, are not available to the next Frame's creation decision. This is a context-projection gap, not an ontology gap.

### 9.1 Project terminal Frame outcomes

Add `projectFrameOutcomes()` to `context-compiler.ts`, mirroring `projectActionOutcomes()`: map terminal `frame_transition` events (`expired`, `falsified`, `replaced`) to a `[FRAME OUTCOME <frameId>]` message containing the Frame statement, falsifier, terminal transition, reason, and the action outcomes attributed to that Frame. Project only in `broadProjection` (epistemic/finalAnswer), budget-prioritized toward the current Frame. This is compiler output over existing events; it introduces no primitive and no persisted state.

### 9.2 Retain episode world evidence under budget

Extend `selectBroadRawEventIds()` (or add a selector): for a terminal Action's episode, do not reduce it to the last assistant message plus its tool results. Retain all finalized tool results within the episode while budget allows; under budget pressure keep the newest N plus the first, and record each omission in the manifest with `reason: "budget"`. Selection stays deterministic and structural; no summarization of omitted results.

### 9.3 Enrich Action outcomes structurally (conditional)

Only if 9.1/9.2 still leave the model without a "what happened" overview: add deterministic structural counts to `[ACTION OUTCOME]` — tool-call count, distinct tools, error classification (`pre-execution rejection`, `invocation failure`, `completed negative result`, `interruption`, `ambiguous mutation`), and touched paths. Counts only, matching the collapsed-trace contract; no narrative episode summary.

### Out of scope for this phase

- No automatic Observation materialization on expiry/falsification; routine failures remain raw events.
- No LLM narrative summarization inside `ContextCompiler`.
- No change to Phase 8 lease derivation; this phase consumes leases, it does not redesign them.

### 9.4 Deterministic coverage

Add faux-provider tests proving:

- a terminal Frame's statement, falsifier, terminal transition, and reason appear in the epistemic projection after expiry/falsification/replacement;
- action outcomes attributed to the terminal Frame appear alongside the Frame outcome;
- the full finalized tool-result set of a failed episode is retained while budget allows, and under pressure the newest-plus-first selection is deterministic with manifest omissions marked `budget`;
- no `[FRAME OUTCOME]` message enters default/execution projections;
- no new persisted primitive or summary event is appended to the raw log;
- all projections remain compiler-produced and budget-bounded.

### 9.5 Evaluation

Compare Phase 9 against Phase 8 on natural tasks with a Frame that expires or falsifies before completion. Measure whether the successor Frame's first Action differs causally from the evidence in the failed episode; whether reconsideration recovers without re-discovering already-seen results; token and latency overhead of retaining episode evidence; and task success after a wrong branch.

### Implementation checkpoint — 2026-08-13

Implemented:

- `projectFrameOutcomes()` and `frameOutcomeMessage()` in `context-compiler.ts` project terminal `frame_transition` events as `[FRAME OUTCOME <frameId>]` (commitment, falsifier, transition, replacement identity, terminal reason) in `broadProjection` only, budget-selected between Observations and Action outcomes, and surfaced in `manifest.projection.frameOutcomes`;
- `selectBroadRawEventIds()` retains all finalized tool results and their tool-call assistant messages within the episode boundary — the active Action start, or the most recent `unresolvable`/`escalated` Action transition when no Action is active — instead of only the last feedback round; selection stays deterministic and structural;
- deterministic coverage in `packages/coding-agent/test/context-compiler.test.ts` passes 14/14, including terminal Frame outcome projection with falsifier and reason, no `[FRAME OUTCOME]` in the default projection, and two-round tool-result retention after `unresolvable`; `npm run check` passes.

Section 9.3 (structural Action-outcome counts) remains conditional pending real-model evaluation of 9.1/9.2. The natural-task evaluation gate has not been run.

### Phase 9 gate

Phase 9 passes only when:

- terminal Frame outcomes (statement, falsifier, transition, reason) reach the epistemic projection without becoming persisted state;
- failed-episode world evidence is retained under budget deterministically and omits only with explicit `budget` reasons;
- default/execution projections remain unchanged in structure;
- the raw log stays append-only with no summary events;
- the compiler remains deterministic and does not call an LLM;
- no new epistemic primitive, ontology, or transcript summary is added.
