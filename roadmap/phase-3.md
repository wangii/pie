# Phase 3 — Add Action episodes

Separate epistemic intent from low-level tool competence.

### Scope

- Represent one authorized investigation intent as an Action episode with a minimal contract: `intent` and `completion_condition`.
- Freeze that contract for the finite lifetime of the episode.
- Allow the action-local loop to change tools, commands, paths, and execution strategies, but never what counts as completion.
- Keep command mistakes, retries, patch failures, and local repairs inside the episode by default.
- Return `UNRESOLVABLE` and transfer control to the epistemic loop when the completion condition cannot be met under the current Frame and constraints.
- Preserve the complete episode trace in the raw log.
- Compile only the execution window needed to continue the current episode.
- Provide an explicit escalation path when a world result challenges the Anchor or current Frame, without requiring perfect classification on the first attempt.

### Evaluation

Compare tool-call-level replanning with episode-local execution on debugging and repository tasks. Include unsatisfiable Actions and results whose epistemic significance becomes clear only after local retries.

Measure:

- model-visible execution-noise tokens;
- LLM round trips per stable intent;
- repeated planning for the same intent;
- unauthorized changes to completion semantics;
- time or attempts before an unsatisfiable Action returns `UNRESOLVABLE`;
- debugging adaptability when an unexpected result occurs;
- bounded return to the epistemic loop after persistent reality pushback.

**Gate:** retain episodes only if they reduce cognitive thrashing and context pollution, preserve fixed completion semantics, and return control in bounded time without hiding anomalies or materially weakening debugging.

### Gate check — 2026-08-12

**Status: PASS. Phase 4 may begin.**

Evidence collected against Phase 2:

- `npm run check` passed.
- Phase 3 persistence, compiler, and provider-boundary tests passed: 17/17.
- Phase 0–2 provider-boundary controls passed: 13/13.
- The `deepseek/deepseek-v4-flash` matched ablation in `packages/evals/src/action.eval.ts` passed 6/6 candidate runs versus 0/6 baseline runs, a `+100 pp` lift for preserving frozen completion semantics.
- The candidate used 2204.3 model tokens per run versus 2030.7 for the baseline (`+173.7`, about `+8.6%`) and reduced mean latency by 482.4 ms. Estimated cost was unchanged at the displayed precision.
- Deterministic coverage confirms append-only Action provenance, episode-local projection, fixed contracts, explicit escalation, exact `UNRESOLVABLE` handling, and control return before Frame expiry.
- The matched tool-based ablation in `packages/evals/src/action-tools.eval.ts` (`deepseek/deepseek-v4-flash`, 3 scenarios x 3 repetitions x 2 harnesses, 18/18 tests passing) measures the missing criteria on real tool traces. Both harnesses run the same seeded workspaces and prompts with built-in tools (`read`, `bash`, `edit`, `write`); the only difference is `actionEnabled`. Every candidate run made real tool calls.
- Completion semantics preserved under tools: candidate 9/9, baseline 1/9, a `+88.9 pp` lift. The frozen completion condition survived a misleading restart claim (scenario 1), a second episode started after an episode `complete` (scenario 2), and an unsatisfiable Action (scenario 3).
- Model-visible context pollution reduced on real traces: candidate 19,487 input tokens per run versus 46,346 for the baseline (`-26,859`, about `-58%`); latency and estimated cost were also lower.
- Bounded return: the unsatisfiable Action returned exactly `UNRESOLVABLE` in every repetition, within 15 model turns and 15 tool attempts in both harnesses.
- Debugging adaptability under an unexpected result: in scenario 1 the orchestrator claim "restart clears the failure" was contradicted by the actual test run, and the candidate still kept the frozen completion condition and identified the cache lifetime; in scenario 2 the candidate captured the position divergence instead of stopping at the cheaper local proxy.

The earlier no-tool ablation (`src/action.eval.ts`) is retained as a regression; its `toolCalls = 0` limitation is superseded by the tool-based ablation above, which measures reduced execution-noise tokens, preserved completion semantics, bounded `UNRESOLVABLE` return, and debugging adaptability on real traces, all in the required direction. Reproduce with `npm run eval -- src/action-tools.eval.ts`; artifacts from this check were written under `packages/evals/.eval/2026-08-12T14-41-16.662Z_92a0fd34-9ef4-42b6-92cc-3ef45d755dac/` and remain intentionally untracked.
