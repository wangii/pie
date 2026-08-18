# Phase 6 — Deliver a usable Pie application

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
