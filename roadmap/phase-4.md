# Phase 4 — Add Observation

An Observation is durable only when execution changes Anchor satisfaction or Frame admissibility.

### Scope

- Materialize observations selectively; ordinary command errors remain raw events.
- Give each Observation stable identity independent of any Frame.
- Link it to exact raw event provenance.
- Allow Frames to project Observations but never rewrite or delete their identity.
- Prioritize current-Frame and Anchor-relevant Observations during compilation.

### Evaluation

Use tasks containing evidence that contradicts an attractive initial Frame.

Measure:

- epistemic steps before the Frame changes or dies;
- contradictory evidence omitted from context;
- recovery cost;
- false escalation of routine execution noise.

**Gate:** if useful observations require a growing set of task-specific schemas, remove or simplify the primitive.

### Gate check — 2026-08-13

**Status: PASS. Phase 5 may begin.**

Evidence collected against Phase 3:

- `npm run check` passed.
- Phase 4 Observation persistence, compiler, and provider-boundary tests passed: 15/15.
- Phase 0–3 provider-boundary controls passed: 19/19.
- Deterministic coverage confirms selective explicit materialization, no automatic escalation of routine tool errors, append-only immutable identity, exact `toolResult`/`bashExecution` provenance from the active Action, survival across later Frame death, and relevance-prioritized projection under budget pressure.
- The matched tool-based ablation in `packages/evals/src/observation.eval.ts` used `deepseek/deepseek-v4-flash`, two contradictory-evidence scenarios, three repetitions, and identical seeded workspaces and prompts. Both harnesses used real `read` tool results and Phase 3 Action-local projection; the only difference was `observationEnabled`.
- The harness deterministically completed the evidence-gathering Action and removed the source fixture before adjudication. This isolates durable Observation projection from transcript visibility and world-evidence rediscovery. Success required both an exact `REJECT_FRAME` Action result and an append-only `falsified` Frame transition; prose intent alone did not pass.
- Contradictory evidence terminated the attractive initial Frame in 6/6 candidate runs versus 0/6 baseline runs, a `+100 pp` lift. Every candidate run selected durable evidence from exact raw provenance after the original execution window and source fixture were unavailable.
- The candidate used 6,640.8 model tokens per run versus 8,881.0 for the baseline (`-2,240.2`, about `-25.2%`), reduced mean latency by 1,727.4 ms, and reduced estimated cost by about `$0.0002` per run.
- Routine execution errors remain ordinary raw events unless explicitly materialized; Observation has no task-specific subtype or schema beyond statement, exact provenance, and Anchor/Frame relevance.

Reproduce with `PI_PROVIDER=deepseek PI_MODEL=deepseek-v4-flash npm run eval -- src/observation.eval.ts` from `packages/evals`; artifacts from the complete gate run were written under `packages/evals/.eval/2026-08-13T00-41-18.163Z_1e7e3cce-70f3-40d5-891d-e0fb0efde9c1/` and remain intentionally untracked.
