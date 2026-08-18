# Phase 7 — Restore Frame and Action semantic separation

**Status: REOPENED (2026-08-13).** A real Pie dogfood session after the initial gate exposed the original degeneration again: a Frame restated the investigation request, one Action covered the full diagnosis and proposed fix, and that Action survived until the containing Frame lease expired. The previous PASS evidence was therefore insufficient. Phase 6's application gate remains independently open.

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

### Initial gate check — 2026-08-13

**Status: SUPERSEDED.** The following evidence supported the initial PASS but did not cover natural-task degeneration strongly enough:

Evidence originally collected:

- The production loop now uses explicit epistemic, execution, and final-answer request roles. A provider `stop` ends one generation only; Action completion, `UNRESOLVABLE`, escalation, and final-answer authorization are separate bounded controller decisions.
- Controller-created Frames contain only the existing statement, falsifier, and response-horizon fields. Empty/request-paraphrase decisions receive at most three repairs, horizons are clamped to a configurable finite range, and renewal requires an append-only Frame revision.
- Horizon counts completed assistant/model responses under one exact Frame version. Expiry terminates an active Action as `UNRESOLVABLE` before appending the Frame expiry and immediately returns to reconsideration in the same production run. TUI and compiler diagnostics label the unit as model responses rather than task progress.
- Action execution treats the current frozen contract as exclusive scope, permits multiple responses and tool calls, and stops before later-episode work. One Frame can authorize multiple sequential Actions without revision. Controller decisions cannot credit out-of-scope execution as a mutation of the current contract.
- Controller instructions are compiler-owned transient request projections, not persisted transcript events or narrative summaries. Raw assistant generations, tool calls/results, and all state transitions remain append-only provenance. Every epistemic, execution, recovery, and final-answer request still passes through `ContextCompiler`.
- Deterministic Phase 7 production coverage passes 10/10. It covers semantic non-paraphrase Frames, competing Frames causing different first Actions, same-Frame sequential Actions, multi-response/multi-tool Actions, plain-stop non-completion, exclusive Action scope, all terminal Action outcomes, same-run expiry ordering, terminated-Frame rejection, bounded malformed-decision repair, and compiler-produced requests.
- Phase 6 production and Phase 0–5 boundary/restoration controls continue to pass. The focused coding-agent run passed 42/42; agent-core assistant-tail continuation passed 23/23; eval-harness controls passed 6/6; `npm run check` passed.
- The matched `deepseek/deepseek-v4-flash` real-tool evaluation passed 4/4 at one repetition. The candidate produced two completed Actions under one unchanged Frame for the diagnosis/repair scenario, and explicitly falsified the attractive cache Frame before same-run reconsideration in the contradictory-evidence scenario.
- Candidate and task-sized baseline both completed 2/2 real-tool tasks. The separated candidate used 86,330 mean total tokens versus 44,349 for baseline (`+41,981`, about `+94.7%`), added 22,693 ms mean latency (about `+105.5%`), and about `$0.0032` estimated cost per run. This substantial efficiency regression is recorded; it did not violate a Phase 7 semantic gate criterion but requires optimization before treating the controller as product-efficient.

Reproduce the initial run with `PI_PROVIDER=deepseek PI_MODEL=deepseek-v4-flash PI_PHASE_7_EVAL_REPETITIONS=1 npm run eval -- src/phase-7-semantic-separation.eval.ts`; its artifacts were written under `packages/evals/.eval/2026-08-13T06-14-25.526Z_3d130350-b421-4431-bc20-52ca8d551652/` and remain intentionally untracked.

### Reopened gate evidence — 2026-08-13

- Dogfood session `2026-08-13T06-34-20-472Z_019ff9d4-2fb8-7429-bebb-e4d4668828ae.jsonl` produced two task-shaped Frames and two task-sized Actions. Each Action consumed 14–15 model responses and ended only when its 16-response Frame lease forced `UNRESOLVABLE` and expiry.
- The initial guards only rejected ASCII-normalized exact Anchor equality. They did not preserve non-ASCII text, reject near-restatements, require a relation/contradictory-falsifier pair, reject bundled deliverables, or bound an Action independently of its Frame.
- Deterministic regressions now reject the observed natural-task Frame and Action forms, preserve non-ASCII semantic text, require a contradictory falsifier, preserve explicit Frame adjudication at the exact lease boundary, and force a long Action to return control before consuming its Frame. The focused Phase 6/7 and Frame/Action/Observation boundary suites pass.
- A first post-fix `deepseek/deepseek-v4-flash` run completed all four workspaces and improved candidate mean tokens from 84,077.5 to 65,759.0, but one candidate Frame expired rather than being explicitly adjudicated. That residual led to additional falsifier-direction and lease-boundary fixes. Artifacts: `packages/evals/.eval/2026-08-13T07-18-31.452Z_25169461-5525-4ce4-95bc-fe8b95fd1ecb/`.
- The required clean real-model rerun is pending because DeepSeek returned HTTP 402 `Insufficient Balance` for all four arms. Phase 7 remains reopened until that rerun passes; deterministic tests and `npm run check` are necessary but not sufficient to restore PASS.
