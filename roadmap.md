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

**Initial phase. Do not add epistemic primitives.** Use an empty epistemic state and establish a stable non-compaction baseline first.

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

## Phase 5 — Integrate only surviving primitives

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

## Phase 6 — Deliver a usable Pie application

**Current phase.** Turn the integrated research runtime into a complete application that can replace Pi for sustained coding work. The goal is not feature parity or UI richness; it is one dependable end-to-end path that users can keep using after the first successful turn.

### Product boundary

- Ship a dedicated `pie` entry point that starts a working coding agent, not an evaluation harness or extension prototype.
- Reuse `@earendil-works/pi-tui` and the existing interactive components. Do not build a second TUI framework or make terminal rendering part of cognition.
- Replace Pi's existing conversational agent loop with Pie's epistemic loop as the sole owner of turn progression, tool continuation, completion, cancellation, and recovery.
- Do not run the old agent loop underneath, beside, or as a fallback to the new loop. Shared provider, streaming, authentication, tool, event, and persistence utilities may remain execution services.
- Keep every model request behind `ContextCompiler`; neither the TUI nor a compatibility adapter may submit transcript-derived context directly.
- Keep the four surviving primitives as the complete ontology. Phase 6 integrates them into operation; it does not add another cognition experiment.

### 6.1 Define one production loop

Implement an explicit lifecycle:

```text
user request
    ↓
create or revise Anchor
    ↓
select/reconsider Frame
    ↓
authorize finite Action episode
    ↓
execute tools and preserve raw events
    ↓
materialize/adjudicate material Observation
    ↓
continue, return UNRESOLVABLE, or finish
```

The loop must have one authoritative state machine for idle, model streaming, tool execution, epistemic reconsideration, completion, cancellation, and recoverable failure. A user-visible final answer must be produced through this loop rather than by handing control back to Pi's old loop.

### 6.2 Connect the existing TUI

Adapt the current `pi-tui` interactive mode to the new loop's events and commands. The minimum usable surface is:

- start Pie and submit a request;
- stream assistant text, tool calls, and tool results;
- accept follow-up and steering input;
- cancel the active turn without corrupting the session;
- show actionable provider, tool, overflow, and loop errors;
- return reliably to an input-ready state after completion or recoverable failure;
- exit cleanly and resume the persisted session after process restart;
- expose concise compiler and epistemic diagnostics without making them editable canonical state.

Existing TUI components should be reused where their event assumptions still hold. Compatibility glue belongs at the UI/runtime boundary; it must not translate epistemic state back into a synthetic transcript.

#### 6.2.1 Make Pie's commitments and context ownership visible

The TUI currently exposes ordinary transcript activity but not the relations that distinguish Pie from Pi. Dogfood users must be able to answer four questions without inspecting JSONL: what Pie is committed to, why execution is continuing, when reconsideration is mandatory, and what the model actually saw.

**P0 — required for dependable dogfood:**

1. Add a compact persistent status surface sourced from production-loop state and `ContextCompiler` diagnostics. At minimum show:
   - authoritative loop state: idle, model streaming, tool execution, reconsidering, completed, cancelled, or failed;
   - whether an Action is active and its terminal result when it ends;
   - current Frame horizon consumption;
   - compiler input budget, selected-token estimate, and omitted-event count;
   - bounded recovery state such as retry attempt, `UNRESOLVABLE`, or returned-to-input-ready.

   Context pressure must be computed from the latest compiler manifest, not from transcript size. A compact form may look like:

   ```text
   Pie · ACTION running · Frame 7/24 · ctx 8.4k/12k · omitted 41
   ```

2. Add a read-only `/pie` diagnostics panel backed by `AgentSession.getEpistemicDiagnostics()`. It should present the current Anchor, Frame and falsifier, Action and frozen completion condition, durable Observations, compiler version, selected and omitted event counts, omission reasons, and budget estimates. IDs and exact provenance should be copyable or expandable, but the panel must not edit canonical state.

3. Render concise, collapsible state-transition markers in the transcript, for example:

   ```text
   Anchor revised · r2
   Frame replaced · v3
   Action started
   Observation materialized · O17
   Action UNRESOLVABLE
   ```

   These markers explain progression but are derived UI events, not synthetic conversation messages and not persisted cognition.

**P1 — recovery and failure clarity:**

4. On process restart or session switch, show a one-time restoration receipt containing restored primitive identities, active or terminal Action state, raw and branch event counts, and whether legacy summaries were ignored. An interrupted persisted Action must never be silently presented as completed or automatically replayed.

5. Show operational error class and bounded recovery progress without introducing epistemic types. Distinguish pre-execution rejection, invocation failure, completed negative result, interrupted execution, and ambiguous mutation. Make clear that the Action contract remains frozen, that ambiguous mutations will be inspected instead of blindly replayed, and when repair exhaustion returns `UNRESOLVABLE`.

6. Allow each Observation to expand to exact finalized-result provenance: raw event identity, tool-call/result identity, tool name, relevant arguments or command, exit/error/cancellation status, and retained output. The display must not imply that tool name, success, or `isError` alone justified materialization.

**P2 — sustained-use efficiency:**

7. When budget pressure reduces projection, emit one concise notice such as:

   ```text
   Projection reduced: 37 older events omitted; raw log unchanged.
   ```

   Do not use compaction language or generate a prose account of omitted history.

8. Collapse an Action's execution-local trace by default while preserving expansion to every attempt, repair, streamed update, and finalized result. The summary should report structural counts and terminal status, not narratively summarize the episode.

The UI must not add editable state forms, confidence or belief displays, claim graphs, automatic transcript summaries, or automatic Observation badges for ordinary tool results. Feature visibility is useful only when it remains a projection of loop, compiler, durable state, and raw provenance rather than becoming another context owner.

### 6.3 Re-plan tool contracts for the new loop

Inventory every built-in tool before wiring it into the production loop. Do not classify a tool itself as "execution" or "observation": every invocation occurs inside Action-local execution, while only the meaning of a particular world result relative to the current Anchor and Frame can justify materializing an Observation.

Record only operational traits needed to execute safely:

| Tools | Conservative side-effect class | Loop consequence |
| --- | --- | --- |
| `read`, `grep`, `find`, `ls` | read-only | May run concurrently when their existing execution contracts permit it |
| `view_frame_action_graph` | read-only derived state | Project the active branch without mutating raw or epistemic state; never treat viewing the graph itself as an Observation |
| `edit`, `write` | workspace mutation | Serialize conflicting mutations and never replay them implicitly during recovery |
| `bash` | mixed/unbounded | Treat conservatively; the command and result, not the tool name, determine what happened |

This is execution metadata, not a fifth epistemic primitive or a shortcut for relevance. The adapters must:

- preserve each invocation, streamed update, final result, error, and cancellation in the raw log with stable call/result identity;
- keep provider-required tool-call/result pairs structurally valid in compiled context;
- treat streamed updates as transient execution progress unless a finalized result is explicitly adjudicated;
- avoid automatically escalating a result because the tool is read-only, the call succeeded, or `isError` is set;
- avoid treating a successful mutation response as proof that the Action completion condition or Anchor is satisfied;
- make exact finalized results available as Observation provenance when later adjudication finds them material;
- prevent resume and recovery from re-executing a persisted side effect merely to reconstruct state.

Evaluate the boundary with counterexamples: a `read` used only to continue editing versus a `read` that reveals Frame-falsifying evidence; a `bash` formatting command versus a `bash` test that contradicts the current Frame; and a successful `edit` followed by a world result showing that the completion condition is still unmet. The same tool must be able to produce ordinary execution noise in one episode and material evidence in another without changing its definition.

#### Agent-generated command and tool errors

Treat an invalid command proposed by the agent as a first-class raw execution outcome, not as an exceptional gap in history and not automatically as an Observation. Preserve the attempted arguments, validation or policy decision, stdout/stderr where applicable, exit status, timeout/signal/cancellation state, and final error classification.

Distinguish enough operational failure classes to choose safe recovery without adding epistemic ontology:

- pre-execution rejection: malformed tool arguments, schema failure, blocked command, or violated runtime policy;
- invocation failure: missing executable, invalid path or option, permission denial, or process spawn failure;
- completed negative result: non-zero exit, failed test, or tool-reported error;
- interrupted execution: user cancellation, timeout, signal termination, or process loss;
- partial or ambiguous mutation: a write-capable command failed after it may have changed the workspace.

The Action-local loop may repair a command, arguments, path, or tool choice while the Action's frozen intent and completion condition remain unchanged. Retries must be bounded by the Action horizon or an explicit per-episode attempt budget, must retain every failed attempt, and must never blindly replay a write-capable call whose effect is unknown. Before retrying an ambiguous mutation, inspect current world state or return control upward.

Escalate only when the finalized failure or resulting world state changes Frame admissibility, changes Anchor satisfaction, or shows that the Action cannot meet its completion condition. Otherwise keep the error as execution-local provenance. Exhausted repair returns `UNRESOLVABLE`; it must not silently weaken completion semantics, claim success from a merely successful command, or trigger an old-loop fallback.

### 6.4 Preserve the execution chassis

Keep existing model selection, authentication, streaming, built-in coding tools, and raw session persistence working through narrow adapters. Validate at least the default configured provider and all eight built-ins: `read`, `grep`, `find`, `ls`, `bash`, `edit`, `write`, and `view_frame_action_graph`. Provider or tool redesign is out of scope unless the new loop exposes a concrete blocking incompatibility.

Legacy sessions may be opened using the migration behavior established in Phase 5. Their raw entries remain provenance; Pie must not reactivate legacy compaction summaries as cognition merely to render or resume them.

### 6.5 Make interruption and recovery routine

Sustained usability requires bounded behavior outside the happy path:

- cancellation during model streaming and tool execution;
- malformed arguments and blocked commands that never execute;
- missing commands, bad paths/options, permission errors, non-zero exits, and timeouts followed by bounded local repair;
- ambiguous partial mutations resolved by inspecting world state rather than blind replay;
- repeated command failure exhausting its budget and returning `UNRESOLVABLE` to epistemic reconsideration;
- provider failure without a stuck busy state;
- context-budget reduction without compaction or malformed tool pairs;
- process restart during a persisted multi-turn task;
- repeated turns without duplicated final answers, lost user input, or parallel loop ownership.

Recovery may be simple and explicit. It must not be an unbounded retry loop or a silent fallback to Pi cognition.

### 6.6 Deliberately limit product scope

Phase 6 does not require stock Pi feature parity, a new visual design, extension compatibility, a large command set, remote/RPC parity, configuration richness, or polished state editors. Retain such functionality only when it already works through the new boundary without weakening loop ownership. The shortest coherent daily-use path takes priority over breadth.

### Application gate

Phase 6 passes only when all of the following hold:

- deterministic tests prove that interactive requests, tool continuations, follow-ups, cancellation, failures, and resumed sessions are driven exclusively by the new loop;
- provider-boundary tests prove every request is produced by `ContextCompiler`, including recovery and continuation requests;
- a deterministic tool matrix covers all eight built-ins, preserves exact call/result provenance, prevents side-effect replay on resume, and proves Observation materialization depends on contextual adjudication rather than tool name or success/error status;
- command-error tests cover pre-execution rejection, invocation failure, completed negative results, interruption, and ambiguous partial mutation; they prove bounded repair, no blind mutation replay, frozen completion semantics, and exact `UNRESOLVABLE` control return;
- `pie` can start in the existing TUI, complete real repository edits with built-in tools, accept another task, exit, reopen, and continue the same raw session;
- one persisted manual soak completes at least three non-trivial coding tasks across 30 or more model requests and two process restarts, including steering, cancellation, an agent-generated invalid command with successful repair, an exhausted command-repair path, and forced context-budget pressure;
- the soak shows no deadlock, stuck busy state, lost input, malformed tool-call/result pairing, duplicated completion, narrative compaction, or loss of raw/epistemic provenance;
- failures leave the application either usable for the next input or stopped with an actionable error;
- no old-loop fallback and no new epistemic primitive were added to make the gate pass.

Feature count is not a success measure. Passing means Pie is a small but complete application whose new loop remains usable over sustained work.

### Implementation checkpoint — 2026-08-13

**Status: IN PROGRESS. The production loop ownership seam exists; the application gate has not been run or passed.**

Implemented in this checkpoint:

- agent-core now accepts an explicit `AgentLoopRunner`; its inherited conversational loop remains only the generic default;
- coding-agent production creation injects `PieProductionLoop`, which owns model requests, tool continuation, steering/follow-up draining, completion, and cancellation boundaries without delegating turn progression to the inherited loop;
- provider streaming and tool execution are reused as execution services, while every provider request still crosses the installed `ContextCompiler` boundary;
- the package exposes a dedicated `pie` executable alongside the existing compatibility entry point;
- deterministic Phase 6 tests were added for loop identity, state transitions, tool continuation, compiler-produced provider requests, and queued steering.

The initial seam was subsequently verified and extended:

- the dedicated `pie` entry now resolves through `dist/pie-cli.js`, presents itself as Pie, and has a source-tree dogfood launcher at `./pie-test.sh`;
- ordinary production requests automatically create or revise an Anchor, create or revise a finite Frame, start a frozen Action, and terminate that Action on final completion or interruption; explicit SDK/eval epistemic directives remain authoritative and bypass these defaults;
- deterministic production-loop coverage passes 7/7 for automatic lifecycle, explicit-directive preservation, cancellation, bounded provider retry with one frozen Action, exhausted-retry `UNRESOLVABLE` return, tool continuation, compiler ownership, and steering;
- `npm run check` passed, generated shrinkwrap/install-lock artifacts were verified, and source-tree CLI help/version smoke checks passed;
- real `deepseek/deepseek-v4-flash` print-mode requests returned through `pie`; one persisted raw session contains the exact user event followed by Anchor, Frame, Action, assistant response, and completed Action transition, and a two-process resume smoke produced two append-only revisions/episodes without replay;
- the existing TUI started as `pie v0.84.1` and returned to an input-ready screen without creating a second UI framework.

Phase 6.2.1's P0/P1 visibility and recovery surface is now implemented:

- a persistent Pie status row projects authoritative production-loop state, active or terminal Action state, Frame horizon consumption, the latest compiler budget/selection estimate, omissions, and bounded recovery progress;
- read-only `/pie` diagnostics expose Anchor, Frame/falsifier, frozen Action contract, compiler selection and omission reasons, and durable Observations with exact finalized raw-result provenance;
- derived collapsible transition markers and one-time persisted-session restoration receipts render without creating synthetic conversation messages or persisted cognition;
- operational failures are classified as pre-execution rejection, invocation failure, completed negative result, interruption, or ambiguous mutation; repair is bounded to three failed attempts per Action, exhaustion returns `UNRESOLVABLE`, and exact ambiguous mutation replay is blocked until read-only inspection;
- deterministic production-loop, Observation provenance, diagnostics UI, footer, interactive status, and session-file restoration tests pass, and `npm run check` passes.

Phase 6.2.1's P2 sustained-use surface is also implemented:

- context manifests with budget omissions emit a concise, deduplicated `Projection reduced` notice that reports the omitted raw-event count and explicitly states that the raw log is unchanged; structural Action-local and legacy-summary omissions do not trigger it;
- each Action's tool attempts, streamed updates, operational repairs, and finalized results are grouped into one trace collapsed by default, while assistant messages remain visible outside the trace;
- the collapsed summary reports only attempt, finalized/tool-error, repair, streamed-update, and terminal-status counts; expansion restores the retained execution detail without generating a narrative episode summary;
- deterministic component and interactive tests cover projection-notice classification/deduplication, collapsed/expanded Action traces, streamed-update retention, terminal status, historical tool completion, and existing pending-tool recovery; `npm run check` passes.

The application gate remains open. Next work is the full eight-built-in tool matrix, broader application-boundary cancellation/resume coverage, and the required sustained manual soak. Observation remains selective and is not inferred from tool name, success, or error status.

## Phase 7 — Restore Frame and Action semantic separation

**Status: PASS (2026-08-13).** Implemented under an explicit user override to begin before the still-open Phase 6 application gate. This phase corrects production-loop orchestration; it does not add an epistemic primitive or enlarge the surviving ontology.

### Problem to correct

The durable state model still preserves the intended hierarchy, but the Phase 6 automatic production path collapses it:

- `packages/coding-agent/src/core/agent-session.ts` currently creates a Frame whose statement restates the user request, uses a generic inability-to-complete falsifier, and assigns the fixed `horizon: 24` near lines 996–1000;
- the same path creates one Action whose intent and completion condition cover the entire user request near lines 1018–1019;
- `packages/coding-agent/src/core/pie-agent-loop.ts` treats an ordinary assistant `stop` without tool calls as request and Action completion.

As a result, Frame no longer acts as a finite investigation commitment that causally constrains Action selection, and Action becomes one task-sized wrapper rather than one bounded investigation episode. The underlying rule that only one Action may be active at a time remains correct; one Frame must be able to authorize multiple Actions sequentially.

### 7.1 Make Frame creation an epistemic decision

Replace the generic automatic Frame template with an explicit controller decision that produces only the existing Frame fields:

```text
statement
falsifier
horizon
```

Requirements:

- `statement` expresses the current investigation commitment, not a paraphrase of the Anchor or user request;
- `falsifier` names a concrete world result that makes the commitment inadmissible;
- competing admissible Frames must be capable of authorizing measurably different next Actions;
- malformed or semantically empty Frame decisions receive bounded repair and must not fall back silently to the generic request wrapper;
- Frame creation, revision, replacement, falsification, expiry, and death remain append-only transitions with exact raw provenance.

### 7.2 Treat horizon as a bounded epistemic lease

`horizon` counts completed assistant/model responses under one exact Frame version. It is not a plan-step count, tool-call count, task-progress percentage, or estimate of total work.

The epistemic controller may estimate how many model responses the commitment may survive before mandatory reconsideration, without generating a step list. The harness must:

- validate and clamp the estimate to a configurable bounded range;
- reject automatic unbounded extension;
- terminate an active Action as `UNRESOLVABLE` before expiring its containing Frame;
- force reconsideration immediately when the lease expires rather than waiting for another user request;
- require an explicit Frame revision with provenance for any renewed lease.

Diagnostics must label the unit explicitly, for example:

```text
Frame responses 3/8
```

The display must not imply task completion progress.

### 7.3 Make Action one finite investigation episode

An Action binds one frozen `intent` and `completionCondition`; it does not bind one LLM call, one tool call, or the whole user task.

Within one Action, the production loop may perform multiple model responses, tool calls, command failures, local repairs, and retries. Tools, commands, paths, and execution strategy may change, but intent and completion semantics may not. A Frame may authorize a sequence such as:

```text
Frame
  → Action 1 → completed
  → Action 2 → UNRESOLVABLE
  → Action 3 → escalated
```

Only one Action may be active concurrently. Starting a later Action under the same Frame must not require revising the Frame unless the investigation commitment itself changed.

### 7.4 Require explicit control transfer

Remove the implicit relation:

```text
assistant stop with no tool call → Action completed → request completed
```

The production decision protocol must distinguish the following existing outcomes and runtime operation:

```text
Action completed
Action UNRESOLVABLE
Action escalated to Frame or Anchor reconsideration
final answer authorized because the Anchor is satisfied
```

These are control decisions over the existing ontology, not new persisted primitives. A plain provider `stop` ends one generation only. It does not prove the Action completion condition or Anchor satisfaction.

After every terminal Action result, control returns to epistemic reconsideration, which must choose one of:

- authorize another Action under the current Frame;
- revise, replace, falsify, expire, or deliberately kill the Frame;
- authorize a final answer after establishing Anchor satisfaction;
- report a bounded inability to continue.

Final-answer text is output, not evidence that its own completion conditions were met.

### 7.5 Preserve user-input relations

Production handling must distinguish input by its effect rather than treating every user message as a fresh task-sized state stack:

- steering may alter Action-local execution strategy but not its frozen contract;
- new evidence may be adjudicated against the current Frame;
- a legitimate success-semantics change explicitly revises the Anchor;
- a distinct new task terminates or supersedes incompatible active commitments before creating new state.

A user message must not automatically revise the Anchor, revise the Frame, terminate the old Action, and start a new task-sized Action merely because it arrived during an existing session.

### 7.6 Deterministic coverage

Add production-path tests that prove:

- an automatically created Frame is not a request paraphrase and has a concrete falsifier;
- the same Anchor under competing Frames produces different first Actions;
- one Frame authorizes at least two sequential Actions without a forced Frame revision;
- one Action spans multiple model responses and multiple tool calls while preserving its frozen contract;
- a single LLM call or external tool call neither defines nor automatically terminates an Action;
- an ordinary assistant `stop` cannot complete an Action whose condition has not been established;
- Action completion, `UNRESOLVABLE`, escalation, and final-answer authorization are distinct bounded paths;
- horizon expiry terminates the active Action first and triggers reconsideration in the same production run;
- a falsified or expired Frame cannot authorize another Action;
- steering and evidence do not silently rebuild the full Anchor/Frame/Action stack;
- all provider requests, including reconsideration and final-answer requests, remain compiler-produced;
- raw execution and state-transition provenance remains append-only across restart and branching.

Put the primary coverage in `packages/coding-agent/test/suite/phase-6-production-loop.test.ts` or a focused Phase 7 production-flow suite. Use the faux provider; do not infer success from prose alone.

### 7.7 Evaluation

Run matched `deepseek/deepseek-v4-flash` evaluations after deterministic coverage passes. Measure:

- causal change in Action selection under competing Frames;
- number of sequential Actions authorized per stable Frame;
- incorrect Action-completion and final-answer rates;
- model responses and tool calls per Action;
- recovery cost after Frame falsification or horizon expiry;
- unauthorized mutation of frozen Action contracts;
- context and latency overhead relative to the Phase 6 production baseline.

Do not use marker-only prompts as the sole evidence. Include real tool traces in which one Action requires multiple calls, a completed Action leads to another Action under the same Frame, and an attractive Frame becomes inadmissible.

### Phase 7 gate

Phase 7 passes only when:

- production Frames causally constrain Action selection rather than restating requests;
- horizon is a bounded, inspectable model-response lease and expiry forces same-run reconsideration;
- production Actions are finite multi-call episodes, and one Frame can authorize multiple sequential Actions;
- no ordinary provider stop, successful tool call, or final-looking prose can implicitly satisfy an Action or Anchor;
- terminal Action outcomes transfer control explicitly and in bounded time;
- steering, follow-up evidence, and new tasks preserve their distinct state effects;
- provider-boundary, persistence, restart, branch, and raw-provenance invariants continue to pass;
- no new ontology, old-loop fallback, transcript summary, or task-specific schema was introduced.

### Gate check — 2026-08-13

**Status: PASS. Phase 7 semantic separation is implemented; the Phase 6 application gate remains independently open.**

Evidence collected:

- The production loop now uses explicit epistemic, execution, and final-answer request roles. A provider `stop` ends one generation only; Action completion, `UNRESOLVABLE`, escalation, and final-answer authorization are separate bounded controller decisions.
- Controller-created Frames contain only the existing statement, falsifier, and response-horizon fields. Empty/request-paraphrase decisions receive at most three repairs, horizons are clamped to a configurable finite range, and renewal requires an append-only Frame revision.
- Horizon counts completed assistant/model responses under one exact Frame version. Expiry terminates an active Action as `UNRESOLVABLE` before appending the Frame expiry and immediately returns to reconsideration in the same production run. TUI and compiler diagnostics label the unit as model responses rather than task progress.
- Action execution treats the current frozen contract as exclusive scope, permits multiple responses and tool calls, and stops before later-episode work. One Frame can authorize multiple sequential Actions without revision. Controller decisions cannot credit out-of-scope execution as a mutation of the current contract.
- Controller instructions are compiler-owned transient request projections, not persisted transcript events or narrative summaries. Raw assistant generations, tool calls/results, and all state transitions remain append-only provenance. Every epistemic, execution, recovery, and final-answer request still passes through `ContextCompiler`.
- Deterministic Phase 7 production coverage passes 10/10. It covers semantic non-paraphrase Frames, competing Frames causing different first Actions, same-Frame sequential Actions, multi-response/multi-tool Actions, plain-stop non-completion, exclusive Action scope, all terminal Action outcomes, same-run expiry ordering, terminated-Frame rejection, bounded malformed-decision repair, and compiler-produced requests.
- Phase 6 production and Phase 0–5 boundary/restoration controls continue to pass. The focused coding-agent run passed 42/42; agent-core assistant-tail continuation passed 23/23; eval-harness controls passed 6/6; `npm run check` passed.
- The matched `deepseek/deepseek-v4-flash` real-tool evaluation passed 4/4 at one repetition. The candidate produced two completed Actions under one unchanged Frame for the diagnosis/repair scenario, and explicitly falsified the attractive cache Frame before same-run reconsideration in the contradictory-evidence scenario.
- Candidate and task-sized baseline both completed 2/2 real-tool tasks. The separated candidate used 86,330 mean total tokens versus 44,349 for baseline (`+41,981`, about `+94.7%`), added 22,693 ms mean latency (about `+105.5%`), and about `$0.0032` estimated cost per run. This substantial efficiency regression is recorded; it did not violate a Phase 7 semantic gate criterion but requires optimization before treating the controller as product-efficient.

Reproduce with `PI_PROVIDER=deepseek PI_MODEL=deepseek-v4-flash PI_PHASE_7_EVAL_REPETITIONS=1 npm run eval -- src/phase-7-semantic-separation.eval.ts`; passing artifacts were written under `packages/evals/.eval/2026-08-13T06-14-25.526Z_3d130350-b421-4431-bc20-52ca8d551652/` and remain intentionally untracked.

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
