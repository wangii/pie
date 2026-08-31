# Epistemic view — current belief-set boundary

The live epistemic state is an append-only set of provisional world beliefs. It is not a planner,
workflow ledger, ontology, report schema, or knowledge graph.

## Belief

```ts
type BeliefDomain = "product" | "code";
type BeliefStatus = "proposed" | "supported" | "refuted" | "inconclusive" | "superseded";

interface Belief {
  readonly id: string;
  readonly statement: string;
  readonly domain: BeliefDomain;
  readonly expectation: string;
  readonly evidenceRounds: number;
  readonly skillRefs?: readonly string[];
  readonly supportedBy: readonly { evidence: string }[];
  readonly refutedBy: readonly { evidence: string }[];
  readonly inconclusiveBy: readonly { evidence: string }[];
  readonly supersededBy?: string;
}
```

A belief is a task-local, evidence-revisable relational judgment about code, product behavior, a
user requirement, or a relevant convention. `expectation` states what observation would bear on
the judgment. It is not the only evidence distill may consider: a prediction being fulfilled is
itself support evidence.

Names inside statements are provisional pointers. PIE does not require semantic tags or an
atomicity proof. Distill refines a referent only when evidence reveals ambiguity, materially
different senses, or component boundaries that matter to the task.

## Status and provenance

- `propose` creates an unadjudicated belief.
- `support` records evidence that bears positively on it.
- `refute` records contradictory evidence.
- `inconclusive` records that the experiment could not settle it without pretending that failure
  to observe is refutation.
- `refine` requires material evidence, supersedes the old statement, and creates an immediately
  supported corrected belief. A merely plausible follow-up remains a separate `propose` candidate.
- `retract` withdraws a belief that is abandoned or no longer material.

Statuses are derived from immutable provenance. Tool output is not copied wholesale into the set;
distill records only evidence material to the judgment.

## What is outside the belief set

- The task objective is the domain `Target` derived from the user request.
- Fast-path selection is `RoutingSet` control metadata written by `route_task`.
- Execution leases, domain plans, cursor stages, and terminal handoff are runtime control state.
- Review coverage and consistency checks are optional heuristics selected by expected information
  gain.

These objects may constrain the loop, but they are not beliefs about the world.

## State change

```text
execution evidence
  |
  +-- adjudication: support / refute / refine / inconclusive
  |
  +-- residual: missing belief, referent refinement, or task-relevant reframing
```

Evidence settles existing beliefs. Residual exposes missing beliefs or reframing. Propose then
chooses which unresolved uncertainty matters next relative to task value, cost, risk, side effects,
and evidence dependencies.
