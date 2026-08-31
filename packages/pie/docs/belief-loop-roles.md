# Belief loop roles, steers, and context

> **Status: current.** Implemented by `belief-loop-controller.ts`, `role-specs.ts`,
> `belief-set.ts`, and the belief tools.

PIE separates four cognitive roles:

```text
BELIEF STATE
    |
    v
PROPOSE / NEXT
choose the material uncertainty with the best expected information gain
    |
    v
EXECUTION
contact the world and preserve raw evidence
    |
    v
DISTILL
adjudicate beliefs, inspect residual, refine epistemic state
    |
    +---- material uncertainty remains ---> PROPOSE
    |
    +---- epistemically sufficient --------> FINAL REPORT
```

Routing, execution leases, domain events, and model selection are implementation helpers.
They are not cognitive phases and are not beliefs.

## Invariants

1. Beliefs are provisional and task-local.
2. A belief is an evidence-revisable relational judgment about code, product behavior, a user
   requirement, or a relevant convention.
3. Execution observes or intervenes; it does not interpret epistemic meaning.
4. Distill changes epistemic state from evidence.
5. Propose decides which unresolved uncertainty matters next.
6. Names are provisional pointers. Refine a referent only when evidence makes a distinction
   relevant to the task.
7. Do not investigate uncertainty that cannot materially change the task outcome.

Routing, workflow state, exploration requests, coverage bookkeeping, and acceptance criteria do
not belong in `BeliefSet`. Routing is recorded separately by `route_task` in `RoutingSet`. The
user request remains the task target rather than being copied into framing beliefs.

## Roles

| role | responsibility | tools | model |
|---|---|---|---|
| `propose` | choose the next material uncertainty; declare one coherent experiment's beliefs | `route_task`, `declare_belief`, `view_beliefs`, `conclude` | default |
| `execution` | gather all materially distinct raw observations; perform minimal interventions when needed | active execution tools plus read-only `view_beliefs` | `pie.executionModel` |
| `distill` | adjudicate tested beliefs, inspect residual, and refine the world model | `declare_belief`, `view_beliefs`, `conclude` | `pie.distillationModel` |
| `finalReport` | synthesize the evidence-grounded answer and preserve uncertainty | none | default |

There is no independent batching planner. Beliefs declared together by propose form one coherent
execution episode. This removes a model call that produced no evidence and optimized belief count
rather than task success. The domain `PlanProduced` event remains an implementation record of the
selected beliefs; it is not a cognitive role.

## Propose objective

Propose selects the coherent experiment with the highest expected task-relevant information gain
relative to:

- importance to the final task;
- uncertainty reduction;
- cost;
- side-effect risk;
- evidence dependencies;
- ability to prevent substantial wasted work.

There is no fixed three-belief limit. One natural experiment may test any coherent number of
beliefs. Review checks such as internal consistency, summary/body drift, reverse drift, and
category boundaries are heuristics. Use them when evidence suggests the frame may hide drift or
missing scope; do not expand scope merely to prove every user category coherent.

## Names and referents

A name can be used immediately as a provisional pointer. No scope-discovery or atomicity proof is
required. If execution reveals ambiguity, materially different senses, or task-relevant component
boundaries, distill may refine the referent, split the belief, and create directly implied
candidate beliefs. `[code]`, `[prod]`, `[user]`, and `[convention]` tags were removed because no
algorithm consumed them.

## Execution evidence interface

Execution reports observations only, not conclusions. It preserves every distinct observation
that materially bears on the tested beliefs, including source, location, and command result when
available. It must not compress conflicting or otherwise different evidence into one sentence.

```text
Observed:
- `foo.ts:42` does X.
- README claims Y.
- Test Z expects Y.
- command ABC failed with error D.
```

The evidence watermark exposes the current execution episode's raw evidence to distill once, then
masks it from later belief-side turns.

## Distillation

Distill has two ordered steps:

1. **Adjudication** — use all relevant execution evidence to classify each tested belief as
   support, refute, refine, or inconclusive. A fulfilled prediction is support evidence.
2. **Residual** — after adjudication, find observations not explained by the current belief set.
   Residual can expose missing beliefs, a task-relevant referent split, or reframing.

> Evidence settles existing beliefs. Residual exposes missing beliefs or reframing.

`refine` can directly create an evidence-supported corrected belief. Distill may also propose
candidate beliefs directly implied by an observation; propose decides whether those uncertainties
matter enough to execute next. Derived reasoning from supported beliefs is not automatically a new
empirical assumption.

## Conclusion and reflection

`conclude` is blocked while a proposed belief remains. Before terminal handoff, propose or distill
gets one cheap adversarial check:

> Is there any obvious unresolved uncertainty that could materially change the answer? If yes,
> investigate it. Otherwise conclude.

There is no coverage, ontology, conjunction, or recursive completeness protocol. Inconclusive
beliefs are included in `<final_report_context>` so finalReport can preserve uncertainty rather
than silently globalizing a local observation.

FinalReport runs on the default model, not `pie.fastPathModel`, because final synthesis must select
relevant beliefs, combine evidence, and control uncertainty.

## Fast path

Fast path is based on epistemic closure, not operational simplicity. `route_task` may choose it only
when no unresolved belief could materially change the selected action or its safety. The controller
also blocks a fast-path route while any proposed belief remains; a belief must first be adjudicated
or explicitly retracted as immaterial.

Terminal ownership is unique:

```text
fast-path execution -> user
```

The execution role writes the terminal response. A hidden `fast_path_distillation` summary preserves
completed actions and blockers for session continuity, but neither distill nor finalReport writes a
second user answer. A failed run returns to propose without replaying the consumed route.

At task boundaries, only supported product/code beliefs survive as session knowledge. Refuted,
inconclusive, superseded, and leftover proposed records are pruned. Routing is cleared separately.
