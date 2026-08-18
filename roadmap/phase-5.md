# Phase 5 — Integrate only surviving primitives

After all independent gates pass:

- run full `Anchor → Frame → Action → Observation` flows;
- test state restoration, branching, and raw provenance across restarts;
- define migration behavior for sessions containing legacy compaction entries;
- expose concise context/state diagnostics without making the TUI the source of truth;
- run broader coding benchmarks and long interactive sessions;
- document which primitives survived and which hypotheses failed.

Do not optimize UI polish or add further ontology until integrated evaluation is stable.

### Integration gate — 2026-08-13

**Status: PASS. The surviving four-primitive stack is integrated; no further ontology is authorized.**

Evidence collected:

- Phase 5's deterministic faux-provider coverage passes persisted restart with active `Anchor → Frame → Action → Observation` state, exact Observation provenance, legacy compaction and branch-summary artifacts, and an abandoned sibling trace. Additional tests repeatedly reopen divergent sibling branches, migrate a version-2 compacted session without inventing epistemic state, and run 18 bounded Action/Observation episodes with four process restarts under a 700-token projection limit.
- Phase 0–5 provider-boundary controls pass 26/26. The long-session stress keeps all 18 durable Observation identities and exact raw result sources, omits older state projection under budget pressure, creates no narrative summary, and leaves raw events resumable.
- `AgentSession.getEpistemicDiagnostics()` exposes a concise derived view of active state, raw/branch event counts, compiler version, omission counts, and budget estimates without becoming a persistence or TUI source of truth.
- The eval harness can reopen the same persisted session while preserving its workspace and raw log. `packages/evals/src/phase-5-integration.eval.ts` compares the full four-primitive stack continuously versus the same stack with real process restarts; Observation is enabled in both arms, so this does not repeat the Phase 4 ablation.
- The matched `deepseek/deepseek-v4-flash` run covers one contradictory-evidence adjudication, three real coding fixes using built-in tools, and one long coding flow with six intervening turns and two restarts. Both arms passed 4/4 at one repetition. The restarted candidate used 28,774.3 total model tokens per run versus 26,923.5 for the uninterrupted control (`+1,850.8`, about `+6.9%`), added 402.5 ms mean latency (about `+3.8%`), and about `$0.0001` estimated cost per run.
- A preceding three-repetition stress run produced 11/11 eligible matched pairs at 100% in both arms; one uninterrupted control run failed before Observation materialization because the model skipped its required read tool. A clean one-repetition rerun passed 8/8 tests with complete pairs. This is recorded as model/tool-use variance, not restart evidence.
- Surviving hypotheses: durable Anchor improves goal retention; finite Frame changes action selection and terminates under falsifier/horizon; Action episodes preserve frozen completion semantics and bounded control return; Observation preserves contradictory evidence across execution boundaries; the combined stack restores across restarts and branches without narrative compaction.
- No primitive failed its gate. The earlier no-tool Action ablation was insufficient for tool-noise claims and was superseded by the tool-based ablation; the earlier Phase 5 checkpoint comparison against Observation-disabled Phase 3 was also insufficient to isolate integration and was superseded by the matched full-stack restart comparison.

Reproduce with `PI_PROVIDER=deepseek PI_MODEL=deepseek-v4-flash npm run eval -- src/phase-5-integration.eval.ts`; complete passing artifacts were written under `packages/evals/.eval/2026-08-13T01-36-22.931Z_ffd014fb-3f5d-4a20-a005-1daefdf59190/` and remain intentionally untracked.

This gate establishes deterministic long-session stability and matched real-model coding/restart coverage. A manual TUI soak remains useful release validation, but the TUI is not a cognition source and interactive polish remains out of scope.
