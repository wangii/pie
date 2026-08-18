# Phase 11 — Separate epistemic knowledge from execution information

**Status: PROPOSED (design). No implementation yet.** Phase 10 closes the execution→epistemic feedback loop, but its promotion contract — every terminal Action outcome materializes an Observation whose statement is `expectation + prediction error` — regresses the boundary this project depends on. This phase restores it by treating *what the execution did* and *what the world result now licenses us to believe* as orthogonal, and by keeping scheduling/lease/error data out of epistemic state and out of epistemic projection.

This phase adds no primitive and no ontology. It re-scopes which data crosses the execution→epistemic boundary and under what authority.

### Design rationale

Epistemic knowledge in a coding task is a *contextual relation assertion*: it names two identifiable project referents (symbol, type, file, module, config key, behavior) and the observable relation that connects them through procedure, model, algorithm, data structure, or file. "worker-local cache survives logout for 30s" is knowledge; "we did not prove the cache behavior within budget" is a process record, not a world assertion.

Language is contextual and drifting, so this knowledge cannot be persisted as a stable entity-relation graph. Entity resolution, relation extraction, and graph inference all assume a word string keeps a stable referent; in an investigation "Auth" means a module on turn 1, a middleware function on turn 10, and a behavior contract on turn 20, and every edge attached to that drifting node loses its meaning with it. This — not a prohibition in the research discipline — is why the project never persists a knowledge graph: the only stable durable form of a language-borne assertion is the *delta* that produced it (frozen statement + exact source-event provenance + the Frame version it was asserted under), and the only place a current belief exists is the compiled projection.

Consequently Frame and Observation are update-delta mechanisms, not knowledge itself. Their `statement` fields carry the assertion; their remaining fields (falsifier, horizon, version, `predictionErrorSign`, `sourceEventIds`, targets) record how and against what a belief was updated. Knowledge — the current set of believed relations — is what `ContextCompiler` projects each turn; the durable log, raw and epistemic alike, is provenance, not the mind.

### Problem to correct

Phase 10 conflates four distinct things into one terminal-Action path:

1. **Execution outcome is fused to epistemic effect.** The control protocol hardcodes `complete_action → confirmed/refined`, `unresolvable_action → refuted/refined`, `escalate_action → refuted` (`pie-agent-loop.ts` control kinds; `agent-session.ts` `_applyProductionControl`). The two dimensions are independent: an Action whose result *disproves* the Frame's premise is still `completed` as an episode, while also `refuted` as evidence. `completed + refuted` has no representation today.
2. **Mechanical outcomes are promoted to Observations.** Budget exhaustion produces `refuted: the completion condition was not established before the budget was exhausted` (`agent-session.ts` `continue_action` exhaustion path). That is an execution fact — "not proven within budget" — not a world fact — "disproven". It contradicts the Phase 4 contract that only a result changing Anchor satisfaction or Frame admissibility materializes.
3. **EpistemicState carries scheduler/execution counters.** `restoreEpistemicState` mutates `completedModelResponses` on the live `Frame`/`Action` objects as it walks assistant messages, and the `Action` surface carries `expectedEvidenceRounds` and `budgetReason` (`epistemic-state.ts`). The durable state is therefore commitments + execution contract + lease accounting in one object.
4. **Observation persists the experiment, not the knowledge.** The canonical statement is `Expectation: …\nPrediction error: …`, so every later consumer must re-derive the world fact from the experiment record instead of reading it directly. `expectation`/`predictionErrorSign` are provenance, not the conclusion.
5. **The epistemic controller reads execution-role prose.** `selectBroadRawEventIds` and `buildExecutionEvidenceMessage` drop raw finalized tool results from the epistemic projection and substitute the execution model's own "distilled conclusion" (`context-compiler.ts`). This is an implicit narrative-summary channel: the controller cannot inspect the structural result it adjudicates, and an inaccurate narration becomes durable cognition.
6. **One result enters context several times.** The epistemic projection can carry `[ACTION OUTCOME]`, `[OBSERVATION]`, `[EXECUTION EVIDENCE]`, and `[FRAME OUTCOME]` for the same evidence, inflating tokens and creating competing accounts of the same result.

### 11.1 Re-establish the layer boundaries

Each layer owns exactly one kind of content, and only explicit, validated promotion crosses upward:

| Layer | Content |
| --- | --- |
| Normative | Anchor: what counts as task success |
| Epistemic | Frame: one admissible falsifiable commitment; Observation: durable world evidence with exact provenance |
| Boundary contract | Action: frozen `intent`, `completionCondition`, `expectation` |
| Execution control | episode status, tool attempts, errors, retries, round budget, lease counters, repair state |
| Raw provenance | every assistant/tool-call/tool-result/bash event, append-only |

Action is a boundary object: its frozen contract is epistemic, but everything that happens while satisfying it is execution-local. Execution data must not be reclassified as knowledge merely because an episode ended.

### 11.2 Decouple execution outcome from epistemic effect

An Action terminal transition records the episode result and control transfer. A durable Observation is a *separate, controller-authored* decision that a finalized world result licenses a belief change. The permitted combinations must include at least:

```text
completed  + refuted    (episode finished; its result disproves the Frame)
completed  + no observation
unresolvable + no observation
unresolvable + material observation
```

Sketch the terminal decision as two orthogonal parts (exact schema is an implementation detail):

```ts
{
  status: "completed" | "unresolvable";
  reason: string;                 // execution-level: why the episode ended
  observation?: {                 // epistemic-level: optional, controller-authored
    statement: string;            // direct contextual relation assertion, not an experiment record
    affects: "anchor" | "frame" | "anchor_and_frame";
    sourceEventIds: string[];     // exact result(s) supporting the assertion
    predictionErrorSign?: "confirmed" | "refuted" | "refined";
  };
  next: "continue_frame" | "reconsider" | "final";
}
```

`escalate` remains a distinct control transfer (it names the challenged object and forces reconsideration), but its epistemic effect is recorded the same way: an explicit material Observation, never implied by the verb alone.

### 11.3 Stop mechanical Observation promotion

The following must remain raw/execution events unless the controller explicitly adjudicates a material world conclusion:

- budget or evidence-round exhaustion;
- timeout, cancellation, or interruption;
- malformed arguments, blocked command, pre-execution rejection;
- missing executable, bad path/option, permission denial;
- tool success or `complete_action` alone;
- retry exhaustion and bounded-repair `UNRESOLVABLE`.

"We did not establish X in time" is execution provenance. "The world shows X is false" is epistemic evidence. Only the latter materializes.

### 11.4 Split the restored view into EpistemicView and ExecutionView

Derive two views from the same append-only branch:

```ts
EpistemicView { anchor; frame; observations }
ExecutionView { activeAction; episodeStatus; evidenceRounds; responseCounters; operationalErrors; retryState }
```

`restoreEpistemicState()` must not mutate live Frame/Action objects with `completedModelResponses`, and Action runtime fields (`expectedEvidenceRounds`, `budgetReason`, counters) must not live on the epistemic surface. The persisted entry schema may stay unchanged for now; the split is in restoration and projection, not yet in file format.

### 11.5 Make the Observation statement a direct, contextual relation assertion

Persist what the result licenses us to believe, not the probe that produced it. A material statement names two identifiable project referents and the observable relation connecting them:

```text
Good:  "worker-local authorization cache survives logout for 30s"
       (cache --survives--> logout, via the 30s TTL)
Bad:   "Expectation: cache survives logout\nPrediction error: confirmed: ..."
       (an experiment record, not the fact)
Bad:   "we did not prove the cache behavior within budget"
       (a process record; no named relation)
```

The relation is a free predicate, not a closed relation-type enum: procedure, model, algorithm, data structure, and file are examples of carriers, not a schema. What is durable is the delta, not the assertion's truth — the frozen statement, its `sourceEventIds`, and the Frame version it targets stay immutable, but whether the assertion still holds in a later context is always subject to re-adjudication.

`expectation` and `predictionErrorSign` remain as provenance metadata on the entry so the Phase 4/10 dedupe and ablation evidence stays reconstructable, but the projected canonical statement is the assertion.

### 11.6 Replace the prose handoff with a structural handoff

The epistemic controller must receive, for the episode under adjudication:

- exact finalized result event identity, tool name, and status;
- bounded deterministic result content (truncation marked, not summarized);
- the execution role's conclusion explicitly labeled as a model assertion, not as ground truth.

Raw tool noise stays execution-local; structured finalized results are the adjudication input. Observation `sourceEventIds` must be the exact subset of results supporting the assertion, not every result in the Action.

### 11.7 Project by role and de-duplicate

```text
Epistemic context:   Anchor, Frame, material Observations, structural results under adjudication.
Execution context:   current Action contract, local tool-call/result pairs, retry/error/lease state, bounded prior working set.
Final-answer context: Anchor, relevant Observations, accepted conclusions.
```

Once a result is materialized as an Observation, it must not re-enter a later epistemic request as `[ACTION OUTCOME]` or `[EXECUTION EVIDENCE]`. One evidence item, one projection channel.

### 11.8 Keep the abstraction behind the harness boundary

The distinctions above are design guidance, not prompt content. The model must never be asked to judge "is this epistemic knowledge" or to emit free-form relations; it operates only a finite menu of decisions with machine-checkable fields (`PIE_CONTROL_KIND_FIELDS`). Each design conclusion compiles down to a mechanical rule the harness verifies:

| Design conclusion | Mechanical rule the model actually faces |
| --- | --- |
| knowledge is a relation assertion, not a process record | `predictionErrorSign` is an enum; `detail` must be non-empty and name a concrete referent, not `confirmed` / `found it` |
| a refuted predicate cannot be softened into `refined` | reject `refined` when `detail` negates the expectation (`contains no X`, `does not`, `rather than`) |
| language drifts, so a commitment is finite | `horizon` is derived by `deriveFrameLease`, never model-supplied |
| the durable layer is delta-only | materialize only when `sourceEventIds` is non-empty; never rewrite an Observation |

Mechanical rules are necessary but not sufficient — Phase 7 showed regexes leak. The remaining defenses are bounded repair (return the rejection reason, retry up to `_maxControlRepairAttempts`, then `report_inability`) and ablation-plus-gate (a rule survives only if enabling it changes behavior measurably). Abstraction stays in the roadmap and in the harness validators; it never becomes a task the model must perform.

### 11.9 Deterministic coverage

Add faux-provider tests proving:

- budget/round exhaustion leaves `EpistemicView` unchanged (no Observation, no Anchor/Frame mutation);
- tool success and `complete_action` alone materialize nothing;
- `completed + refuted` terminates the Action and falsifies the Frame;
- routine errors, retries, and cancellation never enter the epistemic projection;
- a material Observation requires a direct world statement and exact result provenance;
- after materialization, the same evidence is not re-projected as ActionOutcome or ExecutionEvidence;
- deleting a model-visible execution trace does not delete a durable Observation;
- the same raw episode produces no epistemic-state change when materiality is disabled (Phase 4 ablation control).

### 11.10 Evaluation

Compare Phase 11 against Phase 10 on the two Phase 10 failure shapes (false Frame premise; over-scoped Action). Measure false materializations (routine errors/budget exhaustion promoted), omitted real evidence, successor-Frame first-Action divergence from failed-episode evidence, recovery without re-discovery, and token/latency overhead from removing the duplicate projection channels. Use `deepseek/deepseek-v4-flash`; the faux-provider deterministic suite is the gate prerequisite.

### Phase 11 gate

Phase 11 passes only when:

- execution outcome and epistemic effect are orthogonal, and `completed + refuted` is representable;
- no budget exhaustion, timeout, cancellation, routine error, or bare tool success materializes an Observation;
- `EpistemicView` contains only Anchor, Frame, and durable Observations — no response counters, round estimates, or lease state;
- Observation statements are direct, contextual relation assertions naming two project referents and a relation, with `expectation`/`predictionErrorSign` as provenance only and no relation-type schema;
- the epistemic controller adjudicates structural finalized results, not execution-role prose alone;
- each evidence item is projected through exactly one channel, and materialized Observations are not re-projected;
- raw logs remain append-only and complete, and deleting model-visible execution traces does not affect durable state;
- the compiler stays deterministic, budget-bounded, and LLM-free;
- every design conclusion is enforced by a mechanical harness rule plus bounded repair and ablation; no abstraction crosses into prompts or free text;
- no new primitive or ontology is added.
