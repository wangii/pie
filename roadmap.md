# Pie Roadmap

## Objective

Pie forks Pi at the context boundary. Pi remains the execution chassis for models, streaming, authentication, tools, the TUI, and raw session persistence. Pie owns the policy that decides what the model sees.

The target relation is:

```text
raw event log + epistemic state + context budget
                         ↓
                  ContextCompiler
                         ↓
                 model-facing context
```

The transcript is provenance, not canonical cognitive state. Context overflow must reduce a projection, not rewrite history into a narrative summary.

## Architectural contracts

These contracts apply to every phase:

1. **One context owner.** Every model request passes through Pie's `ContextCompiler`.
2. **Raw history remains raw.** User messages, assistant messages, tool calls, tool results, errors, retries, and temporary experiments remain recoverable from the event log.
3. **Compiled context is derived.** Compiler output is not appended back to the raw log as if it happened.
4. **No implicit visibility.** Persisted events enter model context only when selected by the compiler.
5. **Budget pressure changes projection.** It does not mutate canonical state or invoke transcript summarization.
6. **Execution remains independent.** Provider, streaming, authentication, tools, and TUI behavior should change only where the context boundary requires it.
7. **The ontology stays bounded.** The only candidate epistemic primitives are Anchor, Frame, Action, and Observation. They are introduced one at a time.
8. **Each primitive must survive ablation.** A primitive is retained only if enabling it causes a measurable improvement over the immediately preceding phase.
9. **Boundary mistakes are bounded.** The runtime need not classify every failure correctly as execution noise or epistemic evidence. It must prevent a mistaken classification or commitment from persisting indefinitely.
10. **Freedom narrows down the hierarchy.** `Anchor → Frame → Action → execution attempts → world result` is not a thinking/execution split. Each layer may adapt only within the success and completion semantics fixed above it.

Once the relevant primitives exist, bounded control transfer is mandatory: a Frame's falsifier or horizon must force epistemic reconsideration, and an Action that cannot meet its frozen completion condition must return `UNRESOLVABLE`. The weak operating assumption is only that a local epistemic intent can be frozen for one finite execution episode; perfect advance knowledge of why an attempt failed is not required.

## Current boundary to replace

The existing request path is broadly:

```text
session entries
    ↓
compaction-aware session projection
    ↓
AgentMessage[] / transformContext
    ↓
provider messages
```

Auto-compaction is also part of overflow and threshold recovery. This means a transform that receives already-compacted messages is not sufficient: Pie must compile from raw persisted events and its own durable state before default compaction semantics have determined model-visible cognition.

Initial code landmarks to validate during implementation:

- `packages/agent/src/agent-loop.ts`: final message transformation and provider request boundary.
- `packages/agent/src/harness/session/context.ts`: session-entry projection.
- `packages/coding-agent/src/core/agent-session.ts`: persistence, threshold/overflow recovery, and compaction orchestration.
- `packages/coding-agent/src/core/session-manager.ts`: coding-agent session context reconstruction.

These are investigation starting points, not a required final module layout.

## Phase 0 — Own the context boundary

**Current phase. Do not add epistemic primitives.** Use an empty epistemic state and establish a stable non-compaction baseline first.

### 0.1 Characterize the current path

- Trace a new prompt, tool continuation, retry, resume, branch switch, manual compaction, threshold compaction, and overflow recovery from persisted entry to provider payload.
- Add a test seam that captures the exact model-facing messages without using a real provider.
- Record baseline task behavior, visible token count, raw-log completeness, and overflow behavior.
- Identify every path that can insert a compaction or branch summary into model context.

**Deliverable:** boundary tests that fail if an unobserved path bypasses context compilation.

### 0.2 Introduce `ContextCompiler`

Define one explicit compiler interface whose inputs include:

- raw events or an uncompressed branch view;
- current epistemic state, empty in Phase 0;
- model context budget;
- request/runtime data needed to produce valid provider messages.

Its output should include the selected `AgentMessage[]` and a machine-readable selection manifest for diagnostics and evaluation. The baseline compiler must be deterministic and must not call an LLM.

Invoke it once for each model request, immediately before provider conversion. Persistence and session reconstruction must not consume compiler output as canonical history.

### 0.3 Separate persistence from projection

- Continue append-oriented persistence of all raw events.
- Restore sessions from raw entries rather than from a previously compiled projection.
- Keep event identities stable enough for later provenance references.
- Ensure retries and branches select raw events without deleting the abandoned trace.
- Treat existing compaction and branch-summary entries as historical artifacts, not privileged cognition.

**Invariant test:** reducing the model-visible context must not reduce the raw event count.

### 0.4 Remove default compaction from Pie cognition

- Disable threshold and overflow paths that summarize history for subsequent model requests.
- Ensure manual compaction cannot silently restore Pi's narrative context policy.
- Replace overflow recovery with a stricter compiler budget and projection reduction.
- Bound retries. If the minimum valid projection still overflows, return an actionable error instead of entering a summarize/retry loop.
- Preserve any archival information needed to inspect sessions; removing model-facing compaction does not require deleting provenance.

### 0.5 Implement the baseline projection

The first compiler uses only structural selection, not semantic epistemic objects:

1. required system/runtime content;
2. the current user request or continuation;
3. the newest coherent execution window that fits;
4. tool calls paired with their results;
5. older raw events only while budget remains.

Do not split provider-required message/tool-call groups. Do not generate a prose account of omitted events. The selection manifest may identify omitted event ranges, but it is diagnostic metadata and is not model cognition.

### 0.6 Make resume and recovery reliable

Cover:

- normal multi-turn sessions;
- repeated tool failures and retries;
- process restart and session resume;
- branch navigation;
- queued steering and follow-up messages;
- model changes with different context windows;
- repeated forced overflow under a small synthetic budget.

### 0.7 Establish the baseline gate

Phase 0 passes only when:

- ordinary short tasks behave like Pi when the full transcript fits;
- every model request is compiler-produced;
- forced budget pressure drops selected events without creating a narrative summary;
- raw logs remain complete and resumable after projection reduction;
- provider message ordering and tool-call/result constraints remain valid;
- overflow recovery is bounded and does not loop;
- compiler inputs, selected event IDs, omissions, and token estimates are observable;
- no Anchor, Frame, Action, or Observation implementation exists.

Compare task completion, model-visible tokens, execution-noise ratio, overflow recovery, and information loss against unmodified Pi. If the baseline materially regresses and a simple projection policy cannot repair it, stop before Phase 1.

## Phase 1 — Add Anchor only

Introduce one durable statement of task success semantics.

### Scope

- Create, persist, restore, and explicitly revise an Anchor.
- Always retain the current Anchor in compiled context.
- Keep all other selection behavior identical to Phase 0.
- Record Anchor revisions with provenance; do not silently overwrite them.

### Evaluation

Run matched long-horizon tasks with Anchor enabled and disabled. Include tasks where a useful local proxy can diverge from the original request.

Measure:

- final-task success;
- goal-drift incidents;
- Anchor token cost;
- unnecessary resistance to legitimate user goal changes.

**Gate:** retain Anchor only if it measurably reduces goal drift without a material task-completion regression. Otherwise remove it and reconsider the hypothesis.

## Phase 2 — Add Frame

A Frame is a finite-lived investigation commitment, not a structured scratchpad.

### Scope

- Give each Frame stable identity and an explicit version.
- Require a falsifier that states what result makes the Frame inadmissible.
- Require a finite horizon after which the Frame must be reconsidered even if failure classification remains ambiguous.
- Make replacement, revision, death, falsification, and expiry visible state transitions.
- Prevent silent mutation or reinterpretation of the falsifier and horizon.
- Compile only the current admissible Frame by default.
- Do not add confidence scores, claim graphs, question graphs, or hidden subtypes.

The horizon is an epistemic timeout, analogous to a distributed-system timeout. It need not diagnose why progress stopped; it guarantees that the current investigation commitment cannot hang indefinitely.

### Evaluation

For the same state and task, compare action selection with and without the Frame. Use cases where competing explanations authorize different next actions, including cases where relevant evidence is initially mistaken for routine execution failure.

Measure:

- change in next-action distribution;
- recovery cost from an incorrect Frame;
- persistence after contradictory evidence;
- whether falsifiers terminate Frames rather than trigger repeated reinterpretation;
- whether horizons force bounded reconsideration under ambiguous failure;
- context and state-management overhead.

**Gate:** retain Frame only if it causally improves useful action selection and incorrect commitments terminate under their falsifier or horizon. Otherwise remove it rather than enriching its schema.

## Phase 3 — Add Action episodes

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

## Phase 4 — Add Observation

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

## Phase 5 — Integrate only surviving primitives

After all independent gates pass:

- run full `Anchor → Frame → Action → Observation` flows;
- test state restoration, branching, and raw provenance across restarts;
- define migration behavior for sessions containing legacy compaction entries;
- expose concise context/state diagnostics without making the TUI the source of truth;
- run broader coding benchmarks and long interactive sessions;
- document which primitives survived and which hypotheses failed.

Do not optimize UI polish or add further ontology until integrated evaluation is stable.

## Evaluation matrix

Every phase compares the new system with the immediately preceding phase and, where relevant, stock Pi.

| Dimension | Primary measure |
| --- | --- |
| Task outcome | solved tasks / attempted tasks |
| Context efficiency | model-visible tokens / solved task |
| Execution noise | execution-noise tokens / visible tokens |
| Goal drift | behavior inconsistent with original success semantics |
| Frame persistence | epistemic steps an invalid Frame survives |
| Recovery cost | tokens, tool calls, and epistemic steps after a wrong branch |
| Cognitive thrashing | LLM replans for one unchanged investigation intent |
| Context interference | irrelevant old narrative or execution affects current action |
| Provenance | selected state traceable to exact raw events |

Use deterministic faux-provider tests for context and persistence invariants. Use fixed task fixtures for behavioral comparisons. Real-model evaluation must record model, settings, prompt, budget, compiler version, and run variance.

## Out of scope until a gate requires reconsideration

- More primitives than Anchor, Frame, Action, and Observation.
- Claim, question, dependency, confidence, belief-score, or knowledge-graph schemas.
- LLM-generated transcript summaries inside `ContextCompiler`.
- RAG or vector search as a substitute for context ownership.
- Rebuilding providers, tools, authentication, streaming, or the TUI.
- Treating an extension prototype as the final architecture. Extensions may supply comparative evidence, but Pie's cognition policy belongs at the forked context boundary.

## Project-level stop conditions

Stop and reassess when any of these occurs:

1. The non-compaction baseline remains materially worse after simple projection-policy fixes.
2. Anchor does not measurably reduce goal drift.
3. Frame does not causally improve action selection.
4. Action episodes save context but materially reduce debugging adaptability.
5. Observation requires increasingly task-specific schemas.
6. The compiler evolves into another mechanism for narratively summarizing the transcript.

A failed gate is a valid research result. Do not mask it by adding ontology or exceptions.
