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

A belief is a provisional, evidence-revisable relational judgment about code, product behavior, a
user requirement, or a relevant convention. `expectation` states what observation would bear on
the judgment. It is not the only evidence distill may consider: a prediction being fulfilled is
itself support evidence.

Records are retained for the session: a task boundary resets the *focus* (see below) but does not
prune the set. A belief, once created, keeps its provenance — including refutations and
inconclusive attempts — and can be selected again by a later task.

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

- The **current problem formulation** (the Frame) is propose's task-local reading of what problem is
  being solved, published by `set_formulation` as an immutable per-task version (or recorded by
  `defer_formulation` as a deferral while no reading can be stated). It is formed from the task, the
  user's intent, and the belief state: the same beliefs under a different task give a different
  reading, so it is neither a belief nor an aggregate of beliefs. It conditions which hypotheses and
  experiments come next and is never evidence for a belief.
- The **task objective** is the domain `Target` derived from the user request.
- The **recheck** is the task-level result of propose reconsidering the current reading after a
  distillation: "reconsidered and kept it", "revised" (which is the published version), or "not
  reconsidered yet". It is what makes the routine step visible — a published version only records
  that the reading changed, never that a round looked and kept it. Residual is not part of it: what
  the belief set still does not explain stays in the distill turn's prose and is written at the
  granularity of one residual holding several sourced observations, so nothing here should be read
  as a structured list of unexplained observations. The recheck is also not
  `FormulationApplicabilityRecorded`, which answers what a *revised* reading means for the
  conclusions the previous one reached.
- Fast-path selection is `RoutingSet` control metadata written by `route_task`.
- The **task focus** (`FocusSet`) is the control-only slice of belief ids the current task acts on,
  written by `focus_beliefs`. It is scope, not truth: membership never changes a belief's status, so
  a belief can leave the focus — an unknown that no longer bears on the fix — while remaining
  proposed, refuted, or inconclusive, and can be focused again later. The slice starts empty and
  undeclared for every task and is never inherited.
- An **experiment selection** is the control-only pair of a belief subset (drawn from the focus) and
  the task decision its outcome could change, written by `select_experiment`. Dispatch is limited to
  that subset; beliefs left out keep their status and stay in focus.
- The **task outcome** is what the task actually delivered, the evidence that it was delivered, and
  any remaining blocker — written by `conclude` (or `report_outcome` on the fast path). Epistemic
  sufficiency and task completion are separate judgments: the same settled beliefs can answer an
  explanation request and fail a change request that also required the change to be verified.
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
         |
         +--> propose reconsiders the Frame (an anomaly need not become a belief first)
```

Evidence settles existing beliefs. Residual exposes missing beliefs or reframing, and it also
carries what the belief set does not explain: an anomaly that cannot yet change any belief's status
is still a reason to reconsider the current reading, so that branch does not have to pass through a
belief. The two branches are not substitutes — an unchanged belief set can still require
reconsideration, and reconsideration never settles an unadjudicated belief. Propose then
chooses which unresolved uncertainty matters next relative to task value, cost, risk, side effects,
and evidence dependencies — and which task decision that choice could change.

Only the recheck branch is recorded, and it is recorded every round: a distillation leaves either a
reconsideration result (maintained, revised, or deferred) or the state "not reconsidered yet", so
"looked and kept it" is never indistinguishable from "never looked". An anomaly therefore cannot be
skipped past even though it is not itself a record — the round it appeared in owes a result. The
record, the gate, and the projection of the result into the reading's own block are implemented
(M7.3–M7.4), and the terminal shows the same two states — `recheck owed` or `rechecked`, with the
agent's stated basis in `/frame` — because it reads the replayed task rather than a counter kept
beside it. Residual stays outside all of this: the panel shows the basis propose wrote, never a
list of unexplained observations, because no such list is recorded.

The Frame sits above this flow. Adjudicated beliefs are read into a formulation, the formulation
orders which uncertainty propose considers next, and evidence that does not fit the reading forces a
new formulation — so a revision can change the investigation without changing any belief's status.
Focus sits beside this flow rather than in it: `focus_beliefs` decides what the task is acting on,
and `select_experiment` picks the subset to probe. Neither is an arrow into the belief set, so
neither can settle a belief, and an unresolved belief outside the focus neither dispatches nor
blocks conclusion.

Both are published explicitly — `FocusDeclared` and `TaskOutcomeRecorded` are task-scoped domain
events folded onto the Task — so a viewer renders the scope and the delivered result directly
instead of inferring them from which beliefs happened to be dispatched.
