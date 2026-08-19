# Framing beliefs — the revisable "what must be answered"

> **Status: implemented.** The `domain: "framing"` primitive, the Rule 1 dispatch
> exclusion, and the Rule 2 conclude gate described below are all implemented in
> `belief-set.ts` and `agent-session.ts`. Kept as the design rationale.

Companion to `epistemic-view-skeleton.md` (which defines the world-belief set) and to the
execution→epistemic residual pipeline in `agent-session.ts`. This doc proposes the
**minimal** addition that gives the loop a revisable notion of "what counts as answered",
without introducing a second belief class.

## The problem

Three concrete gaps exist today:

1. **Reframing has no home.** A world belief can be `refine`d ("the world is different than I
   thought"), but nothing can be revised when the *question itself* was mis-framed ("I thought
   this was one bug; it is two"). That revision is not a claim about the world, so it has no
   object to live in.
2. **`conclude` is ungrounded.** The only completion signal is the model's own call, with
   nothing to grade it against. Nothing tracks "here is what the answer must still establish".
3. **The filter lacks a predicate.** The residual pipeline routes "does this change what we
   must say?", but that question currently has no referent to be checked against.

Gap (3) is already *computable* (see "the filter is a predicate", below). Gaps (1) and (2) are
the ones that justify a new object — and only a small one.

## What this is NOT

Deliberately excluded, to keep it from becoming a planner or a schema:

- **Not a report template or outline.** No `Architecture / Files / Root Cause / Tests` slots.
  The finalAnswer role writes from world beliefs, never from framing beliefs.
- **Not an action path.** It names a *knowledge destination*, never a probe. It is structurally
  barred from dispatching to execution.
- **Not a second belief class.** Same record shape, same status machine, same `declare_belief`
  ops. The distinction is a field, not a type.
- **Not a stored "relevance" flag on observations.** The filter is a computed predicate over
  residuals, not a property we persist.

## The primitive: `domain: "framing"`

Extend the existing belief domain enum by one value.

```ts
export type BeliefDomain = "product" | "code" | "framing";
```

| | world belief (`product` / `code`) | framing belief (`framing`) |
|---|---|---|
| answers | *What do we think is true?* | *What must we be able to explain for this to count as resolved?* |
| `statement` | a relation between named things | an epistemic obligation |
| `expectation` | what observing the referent will show if true | what evidence would show this framing is **wrong or incomplete** |
| `evidenceRounds` | how many probes the test needs | inert (always 1) — no probe |
| dispatchable | yes | **no** |
| status machine | proposed → supported/refuted → superseded | identical |

A framing belief is the `Anchor` from `epistemic-view-skeleton.md`, made *revisable*: the
anchor was "normative success semantics, never a belief". Here the success semantics are a
*proposed* (tentative, revisable) judgment, because evidence can show the framing itself is
wrong.

## The two rules (this is the whole design)

**Rule 1 — framing beliefs never dispatch.** Only `product`/`code` beliefs trigger the
execution role. A proposed framing belief stays in the epistemic role as an open obligation;
it is never handed to execution. (This is what stops it from becoming a planner: it is deprived
of the one power a planner has.)

**Rule 2 — `conclude` is valid only when no framing belief is `proposed`.** A proposed framing
belief is an *unmet obligation*. Concluding with an unmet obligation is premature, so the
harness rejects `conclude` and steers the epistemic role back: *"you still have an unresolved
obligation: <statement>. Satisfy it (support), reframe it (refine), or drop it (retract)."*

The gate is structural — it checks only "no open obligation remains", never "is the obligation
*actually* satisfied". Satisfaction is the model's judgment, expressed as `support`/`refute`/
`refine`/`retract` on the framing belief, at exactly the same trust level as world-belief
support. The `retract` escape hatch is mandatory: it is what prevents an obligation from
becoming a permanent blocker.

## Worked example: the bug that was actually two bugs

1. Epistemic proposes framing belief `F1`: `domain: "framing"`, statement *"the task is a
   single root-cause bug"*, expectation *"no observation reveals a second, independent failure
   mechanism"*.
2. Epistemic proposes world beliefs about the cache, probes run, residuals update them. F1
   stays `proposed` (the obligation is open, not yet met).
3. A residual arrives: *"disabling the cache fixes symptom A, but symptom B persists"*. It is
   not explained by current world beliefs **and** it contradicts F1's expectation.
4. The residual pass routes it as a **reframe**, not a fill: `refine` F1 → F2 *"the task is two
   independent mechanisms"*, and propose world beliefs for the second mechanism.
5. Eventually world beliefs establish both mechanisms. The model `support`s F2 with evidence
   referencing those beliefs (*"W1, W2, W3 establish both mechanisms and their evidence"*).
6. No framing belief is `proposed` anymore. `conclude` is now valid → finalAnswer.

## Reframing vs filling (the falsifiability asymmetry)

The one hard question — "is the framing falsified, or just not filled in yet?" — is answered
the same way world beliefs are, by the `expectation` field:

- a residual **within** the framing's scope (deepens the current explanation) → fill: `support`
  world beliefs, framing stays `proposed`.
- a residual **contradicting** the framing's `expectation` (out of frame) → reframe: `refine`/
  `refute` the framing belief.

The asymmetry to be honest about: world beliefs are falsified by *in-frame* contradiction (a
prediction fails); framing beliefs are falsified by *out-of-frame* surprise (an observation
falls outside what the framing said had to be explained). Detecting out-of-frame surprise is
harder, and it is the one place the residual pipeline — "world beliefs can't explain it **and**
the framing didn't ask for it" — earns its keep.

## The filter is a predicate, not a belief

"Do we retain this information, and where?" is a routing decision made inside the residual pass,
expressed as ordinary `declare_belief` ops:

```
residual
  ├─ explained by a world belief            → drop (not a residual)
  ├─ unexplained, within framing scope      → world-belief revision (propose/refine/support)
  ├─ unexplained, contradicts framing       → framing revision (refine/refute)
  └─ changes neither                        → forget (never stored)
```

No relevance score, no per-observation flag, no new object.

## Schema containment

The honest position: framing beliefs *will* drift toward a checklist unless fought. Defenses,
all cheap:

- **1–3 live framing beliefs, typically 1.** A set is a schema; a single revisable frame is not.
- **Structural-only validation.** Same `validateBelief` rule as world beliefs: non-empty,
  valid domain. No content heuristic, no "must mention evidence" rule.
- **finalAnswer never reads framing as an outline.** It is an epistemic-side judge, not a
  template for the report.

Accept mild drift; prevent reification.

## What changes in code

- `belief-set.ts`: add `"framing"` to `BeliefDomain`; widen `validateBelief`'s domain check to a
  set membership.
- `declare-belief.ts`: add `Type.Literal("framing")` to the `domain` union; accept it in
  `toDelta`. `evidenceRounds` stays required but defaults to 1 for framing (inert).
- `agent-session.ts`:
  - dispatch: exclude `domain === "framing"` from `undispatched` (Rule 1).
  - `_advanceRole`: on `concluded`, reject into a steer-back if any `proposed()` belief has
    `domain === "framing"` (Rule 2).
- `view-beliefs.ts` / `formatBeliefsForView`: render framing beliefs under a `[FRAMING]` section
  (open obligations) instead of `[FRAME]` (dispatchable world beliefs).

## Known warts (honest)

- `domain: "framing"` conflates two axes — what a belief is *about* (product/code) vs *whether
  it is about the world or about the question*. The conflation is deliberate: a separate `kind`
  field would add surface and schema risk for no immediate gain.
- `evidenceRounds` is dead weight for framing beliefs. It is the price of reusing the primitive
  instead of building a second type.
- The conclude gate has a one-turn wrinkle: the `conclude` tool already returns "concluded"
  before the harness rejects it, so the model sees "concluded" then a corrective steer. Acceptable
  for a first cut; wiring the belief set into the `conclude` tool for a clean refusal is a later
  refinement.

## What we deliberately do NOT build

- No `declare_framing` tool — reuse `declare_belief` with `domain: "framing"`.
- No separate `FramingSet` or second status machine.
- No auto-inference of completion — `conclude` remains the model's explicit call, now gated.
- No "relevance score" persisted on observations — the filter stays a computed predicate.
