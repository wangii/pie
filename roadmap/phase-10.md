# Phase 10 — Route execution feedback through durable Observation

**Status: IN PROGRESS (design revised).** Phase 9 projects terminal Frame outcomes and retains failed-episode evidence transiently, but the production loop still never materializes a durable Observation from execution feedback. This phase closes the feedback loop: the terminal outcome of an Action episode is the feedback signal, and Observation is the primitive that carries it across the next epistemic decision.

The original Phase 10 materialized only *failure* (unresolvable/escalate), and only as the controller's bare `reason`, with success (`complete_action`) left un-materialized. This revision replaces that asymmetry with a single epistemic format for **every** terminal outcome: `expectation + prediction error`. A completed Action is not "no information" — it is "the frozen expectation was confirmed (prediction error ≈ 0, with any residual refinement)". Raw result text stays at the execution layer; only the named conclusion crosses into the epistemic layer.

### Problem to correct

Observation's contract is "durable only when execution changes Anchor satisfaction or Frame admissibility" — i.e., Observation is the feedback channel between execution and the next epistemic decision. In the production loop that channel is unwired:

- `escalate_action(challenge)` is the one control verb whose field explicitly names which object (Anchor or Frame) the execution result bears on, but `_applyProductionControl` only appends an `action_transition` and returns to epistemic; the challenge reason is never materialized.
- `unresolvable_action` carries the controller's account of what the episode found (often the falsifying or near-falsifying evidence), but the same account persists only in the raw `action_transition` and the Phase 9 transient projection.
- The next epistemic decision therefore re-derives, re-discovers, or loses the decisive evidence. Both dogfood sessions died this way: one chased a false Frame premise through three Actions and a kill, the other re-issued the same over-scoped extraction Action four times until it escalated to a user choice.

### 10.1 Materialize every terminal Action outcome as `expectation + prediction error`

When `_applyProductionControl` handles a controller-authored terminal decision (`complete_action`, `unresolvable_action`, `escalate_action`), materialize exactly one durable Observation before appending the Action transition. Its statement is the two-part epistemic record:

```text
Expectation: <the frozen expectation>
Prediction error: <sign> <detail naming the concrete referent>
```

The `sign` is a structured discriminant (`confirmed` | `refuted` | `refined`):

- `complete_action` → `confirmed` (expectation held) or `refined` (held, and reality added precision);
- `unresolvable_action` → `refuted` (the world contradicted or could not satisfy the expectation) or `refined` (scope-narrowing produced a bounded sub-result);
- `escalate_action` → `refuted` (the finalized results contradict or undermine the Frame relation or Anchor success semantics).

`affects` maps to the evidence's layer: anchor-bound `explore` → `anchor`; a Frame Action whose prediction was confirmed/refined → `frame`; a Frame Action whose prediction was refuted (unresolvable/escalate) → `anchor_and_frame` (task-level evidence that stays relevant after the Frame dies).

**Raw result text never enters the Observation statement.** `sourceEventIds` is a downward pointer to the episode's finalized `toolResult`/`bashExecution` events; the raw output stays at the execution layer, recoverable from the transcript within its episode. The only thing that crosses the boundary is the *named conclusion* (file path, symbol, line, count, output), which the prediction-error `detail` is required to name. `complete_action` is no longer a no-op for materialization: confirmation is evidence.

Materialize only when the episode produced at least one finalized result to cite; a prediction error without provenance is not material evidence. Harness-generated terminal transitions (Frame lease expiry, evidence-round exhaustion) remain raw events and do not materialize: they are bounded-return mechanics, not controller feedback. Routine command errors remain raw events.

### 10.2 Require a frozen expectation on every Action

`expectation` becomes a required field on every Action — not only pre-Frame `explore`. It flows through `ProvisionalActionContract`, the `create_frame`/`advance_frame`/`revise_frame`/`replace_frame` schemas, and `ActionStartEntry`. The expectation is the single observable the probe predicts it will find, distinct from `intent` (what to do) and `completionCondition` (what proves done). Freezing it at Action start is what makes the terminal prediction error a genuine comparison rather than a post-hoc rationalization: the prediction is fixed before the result arrives.

### 10.3 Validate the prediction error names a concrete referent

Add `validatePredictionError(sign, detail, expectation)`, in the same style as `validateBudgetReason`: the `detail` must be non-empty and must not be a bare confirmation token (`confirmed`/`found it` carry no named conclusion), while any substantive sentence naming a path, symbol, line, or count passes. Cross-check `sign` against the transition: `escalate` requires `refuted`, `complete` allows `confirmed`/`refined`, `unresolvable` allows `refuted`/`refined`. The `refined` sign is narrowed to "the expectation's claim held and reality added detail": a `refined` detail that negates the expectation's predicate ("contains no X", "does not", "rather than", "instead") is rejected and must be `refuted` — softening a false predicate into "progress" is exactly the failure that lets a wrong Frame survive.

### 10.4 Deterministic coverage

Add faux-provider tests proving:

- `complete_action`, `unresolvable_action`, and `escalate_action` each materialize exactly one durable Observation whose statement is `expectation + prediction error`, whose provenance is the episode's finalized results, and whose `affects` target is correct;
- the Observation statement never inlines raw tool-result text; `sourceEventIds` still points to the exact result events;
- a terminal Action with no finalized results materializes no Observation;
- harness-generated unresolvable transitions (lease expiry, round exhaustion) materialize no Observation;
- a Frame Action `complete_action` materializes (this was previously a no-op);
- `validatePredictionError` rejects a vague `detail` and rejects a `confirmed` escalate;
- the information-gain gates dedupe on `expectation` against confirmed observations, not on raw statement text;
- the Observation is projected with correct relevance into the next epistemic request and survives a subsequent Frame death;
- observation-disabled sessions (Phase 4 ablation) materialize nothing.

### 10.5 Evaluation

Compare Phase 10 against Phase 9 on the two observed failure shapes: a false Frame premise (feedback should falsify early) and an over-scoped Action (feedback should trigger narrowing, not re-issue). Measure terminal-Action Observation count, whether the successor Frame's first Action differs causally from the failed episode's evidence, recovery without re-discovery, and token/latency overhead. Use `deepseek/deepseek-v4-flash` with the faux-provider deterministic suite as the gate prerequisite.

### Phase 10 gate

Phase 10 passes only when:

- every controller-authored terminal Action outcome (`complete_action`, `unresolvable_action`, `escalate_action`) materializes a durable Observation with `expectation + prediction error`, exact provenance, and correct `affects`;
- `complete_action` materializes (confirmation is evidence), and raw result text is never inlined into the statement;
- the next epistemic decision projects those Observations and the successor Frame's first Action responds to the evidence rather than re-issuing the failed episode;
- every Action carries a frozen `expectation`, and the information-gain gates dedupe on it;
- harness-generated terminal transitions and routine errors remain raw events;
- the compiler stays deterministic, budget-bounded, and LLM-free;
- no new primitive or ontology is added (persisted fields `expectation` and `predictionErrorSign` are the only schema additions).
