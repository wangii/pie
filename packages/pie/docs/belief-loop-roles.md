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

That diagram is one layer of a two-layer cycle. The belief set is the evidence-grounded layer;
the Frame is the task-conditioned layer that decides what the belief state is currently *read as*,
and therefore which hypotheses and experiments come next:

```text
TASK + USER INTENT
        |
        v
   BELIEF STATE --forms--> FRAME (current problem formulation)
        ^                      |
        |                      v
     DISTILL            hypothesis space, attention, anomaly priority,
        ^               next experiment selection
        |                      |
        +--- OBSERVATION <-----+
```

So the loop is `beliefs -> frame -> what becomes thinkable/testable -> observation -> beliefs`.
The Frame's job is not to summarize the belief set but to shape the next round of belief
formation. A Frame is not a larger or coarser belief, and the belief loop above still runs
unchanged underneath it; the Frame layer is described under *Frame feedback and revision pause*
below.

Routing, execution leases, domain events, and model selection are implementation helpers.
They are not cognitive phases and are not beliefs.

## Invariants

1. Beliefs are provisional. Records are retained across tasks as history; the task's *focus* —
   which beliefs it acts on — is task-local and never inherited.
2. A belief is an evidence-revisable relational judgment about code, product behavior, a user
   requirement, or a relevant convention.
3. Execution observes or intervenes; it does not interpret epistemic meaning.
4. Distill changes epistemic state from evidence.
5. Propose decides which unresolved uncertainty matters next, and which task decision that
   experiment could change.
6. Names are provisional pointers. Refine a referent only when evidence makes a distinction
   relevant to the task.
7. Do not investigate uncertainty that cannot materially change the task outcome.
8. Focus is scope, not truth. Entering or leaving the focus slice never changes a belief's
   status.

Routing, workflow state, exploration requests, coverage bookkeeping, and acceptance criteria do
not belong in `BeliefSet`. Routing is recorded separately by `route_task` in `RoutingSet`. The
user request remains the task target rather than being copied into framing beliefs.

## Roles

| role | responsibility | tools | model |
|---|---|---|---|
| `propose` | choose the next material uncertainty; state how the task is currently understood; answer the user's corrections; select one coherent experiment and the decision it informs | `route_task`, `declare_belief`, `focus_beliefs`, `select_experiment`, `set_formulation`, `defer_formulation`, `answer_correction`, `view_beliefs`, `conclude` | default |
| `execution` | gather all materially distinct raw observations; perform minimal interventions when needed | active execution tools plus read-only `view_beliefs` (fast path also `report_outcome`) | `pie.executionModel` |
| `distill` | adjudicate tested beliefs, inspect residual, and refine the world model | `declare_belief`, `view_beliefs`, `conclude` | `pie.distillationModel` |
| `finalReport` | synthesize the evidence-grounded answer and preserve uncertainty | none | default |

`set_formulation`, `defer_formulation`, and `answer_correction` are propose's alone. Distill may
find that the residual exposes a reframing, but a suggestion is not the current understanding: only
propose publishes, and a distill turn cannot state the agent's reading or clear the decision by
making it itself. Answering a user correction is propose's for the same reason — the user objected
to how the task is understood, and "I keep my reading, because…" is a statement about the agent's
position, not evidence about the world.

There is no independent batching planner. Propose selects the beliefs for one coherent execution
episode and states the decision that episode informs. This removes a model call that produced no
evidence and optimized belief count rather than task success. The domain `PlanProduced` event
remains an implementation record of the selection, including the propose-authored `intent`; it is
not a cognitive role.

Every role reads the current formulation from its system prompt, labeled as the agent's own
provisional position rather than an observation: the block says explicitly that it is never
support for a belief, so a reading cannot quietly become a fact no experiment tested. Nothing is
emitted before a reading exists — the decision is raised by the loop's transition, not by a
standing prompt.

Once an experiment has been dispatched, propose owes a formulation decision before it can choose
another experiment or conclude. The gate is checked against the replayed state, so a rejected
`set_formulation` call leaves the decision outstanding rather than satisfying it. Publishing a
version voids any experiment selected but not yet dispatched, which is why a propose turn that
both states a reading and selects an experiment must publish first: tools run in call order.

> Implemented (M7.3): the same gate is the per-round recheck. After *every* distillation propose owes
> a reconsideration result — "reconsidered and kept the reading" is a result, not a skipped step — so
> a publication no longer settles the decision for good. See *Two outputs, one step apart* below.

A user correction travels the same gate as the decision, and takes priority over it. It is
recorded immediately and blocks execution probes at the tool boundary: calls already in flight
come back with their results, and the ones behind them do not start — blocked with a result that
names the correction, so every tool call in the batch is still answered. The next decision is
propose's, and until each pending correction has an answer with `answer_correction`, propose can
neither dispatch another experiment nor conclude. The round's plan and the evidence it gathered
stay in the log: the beliefs it dispatched keep blocking conclusion until distill adjudicates them,
because closing a round is not adjudication.

The decision roles (`propose`, `distill`) receive the `<project_context>` block even though they
have no `read` tool. That block is normally gated on `read`, but project constraints ("`dist/` is
generated output", "never edit the vendored tree") change which action propose selects and how
distill reads evidence, so withholding them would hide part of the basis for the decision.
`finalReport` writes rather than decides and stays on the `read` gate.

## Frame feedback and revision pause

A Frame answers "what problem do I currently think I am solving", where a belief answers "what do I
currently think is true". It is therefore not derived from the belief state alone:

```text
Frame_t = f(Task, user intent, B_t, Frame_t-1)      not      Frame = Aggregate(B_t)
```

The same beliefs under a different task yield a different Frame, and a reading can be stated before
any evidence has been gathered, because the request itself already constrains it; what the runtime
requires is that the decision be made once an experiment has been dispatched, not that a reading
precede the first probe. A Frame is a *structural prior for the next inquiry* — it orders which
hypotheses are generated, which anomaly matters, which tool is called, and when the current reading
is no longer tenable — not a posterior claim about the world. That is why it is projected as the
agent's own provisional position and never as support for a belief.

Because the Frame conditions the next hypothesis and the context it is read in, a reading can seal
itself: it produces only compatible beliefs, which strengthen it further. Reframing is therefore a
normal operation rather than an exception. Two things keep the loop open: where the agent can name
them, the reading says what observation would force a new reading (`implication` carries the
direction; `tension` carries the conflict and may stay unstated), and propose may select a belief
that conflicts with the current reading as a counterexample. That selection is subject to the usual
gates — the belief must be in the task's focus, and a pending revision review still has to be
answered first — so nothing is dispatched during the revision pause. The version history preserves
the `X -> Y` transition instead of silently rewriting the reading, which is what makes a reframing
reviewable.

Evidence and beliefs inform the Frame; the Frame's objects, relations and scale inform task focus;
focus guides experiments; distill's residual can prompt a new reading. Scope does not mechanically
map files to functions, components to data structures, or systems to component definitions: explain
which distinctions matter for this task. A Frame is never evidence and may guide counterexample probes.

First publication and unformed preliminary investigation remain permitted without a user handshake.
A substantive revision, however, pauses the run at the tool boundary, keeps the task active, and
waits for a user response against that version. A normal reply resumes the same task through the
correction channel; earlier queued input or an automated extension message cannot acknowledge it.
There is no automatic approval on timeout. The terminal shows the revised reading and why it changed.

Propose answers the response, then explicitly calls `focus_beliefs` before selecting an experiment,
routing to fast path or concluding. It may keep exactly the same ids. `FocusDeclared.formulation`
records which version was reviewed; another revision requires another response and review.
Review changes relevance, never belief truth or the adjudication debt of an interrupted experiment.

Substantive change remains propose's judgment: accumulated confirming evidence or wording edits
must not manufacture revisions. Residual evidence conflicting with the assumptions or scope should
trigger reconsideration, not necessarily a new version. An identical submission is a runtime no-op.

## Task focus and experiment selection

The belief set is history; the focus is scope. Two control-only tools keep them apart:

- `focus_beliefs` declares the belief ids the task currently acts on. It *replaces* the slice, so
  dropping a belief from focus — for example an unresolved question that no longer bears on the
  fix — changes only the task's attention, never the belief's status. A refuted or inconclusive
  belief can be put back if it becomes relevant again, which is why records are retained rather
  than pruned to the supported ones.
- `select_experiment` names the subset of the focus to probe next, plus one sentence for the task
  decision the outcome could change ("whether to change the caller or the adapter", not "learn
  about the network layer"). Dispatch is limited to that subset; beliefs left out keep their
  status and stay in focus.

A task must declare its focus before it can select an experiment, and a new task starts
undeclared: focus is never inherited, because the previous task's scope is not evidence about
this one. Changing the focus invalidates an already-selected experiment, so a selection is never
silently re-scoped; re-declaring the *same* scope does not, since tools run in call order within a
turn.

Dispatch is not automatic. An unresolved belief the task owns — declared during this task, or
already in focus — with no experiment selected produces a steer asking for the selection. Retained
history from earlier tasks is excluded from that steer: it neither dispatches nor re-enters the
task's attention unless the task focuses it again.

Because records are retained, the `view_beliefs` listing is history rather than current scope. It
therefore opens with a control-metadata header — `[FOCUS]` for the current slice, and
`[SELECTED EXPERIMENT]` when one is pending — so the model reads its scope before its history
instead of reconstructing the slice from the transcript. Neither line is a belief.

The slice is published as the task-scoped `FocusDeclared` domain event and folded onto the Task
record, so a viewer (the native GUI's graph view) renders scope without inferring it. The event is
emitted on the first declaration, any membership change, or a required version-bound focus review.
Other restatements do not emit an event.

## Propose objective

Propose selects the coherent experiment with the highest expected task-relevant information gain
relative to:

- importance to the final task;
- uncertainty reduction;
- cost;
- side-effect risk;
- evidence dependencies;
- ability to prevent substantial wasted work.

Information gain is worth something only when it reaches the task: the selection must name the
action, conclusion, or answer the outcome could change. An unknown whose resolution cannot change
any of those is out of scope even when it would be interesting to know.

There is no fixed three-belief limit. One natural experiment may test any coherent number of
beliefs. Review checks such as internal consistency, summary/body drift, reverse drift, and
category boundaries are heuristics. Use them when evidence suggests the current framing may hide drift or
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

Execution carries an episode-scoped lease (a budget of tool results). When the lease is exhausted the
runtime says only that the budget was spent; it does not infer whether the experiment finished. The
report prompt and the distill handoff state this as a resource-limit fact, so distill adjudicates
only the evidence actually gathered and may support, refute, or mark inconclusive on the evidence,
never on the budget alone.

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

### Two outputs, one step apart

The two steps produce two different outputs, and the loop carries both forward:

```text
                       +--> adjudication --> belief-set changes
observation --> distill
                       +--> residual ------> anomaly / explanation gap / revision suggestion
                                                      |
                                                      v
                                           propose reconsiders the Frame
```

- The adjudication branch answers "which judgments are now supported, refuted, or still open". It
  settles beliefs or leaves them open.
- The residual branch answers "what does the current belief set still not explain, and does the
  current reading still organize this task". An anomaly that cannot yet change any belief's status
  is still a reason to reconsider the reading, so this branch must not be required to travel
  through a belief first.

This is not a `belief-set -> Frame` pipeline. An unchanged belief set can still require a
reconsideration (new evidence makes an existing relation matter, or the task's emphasis moved), and
a changed belief set does not force a revision. Reconsidering is a normal step; publishing a new
version happens only when the reading itself changes. Neither branch substitutes for the other:
reconsidering does not settle an unadjudicated belief, and adjudicating does not stand in for
looking at what the beliefs now mean for the task.

The residual branch is carried as *prose, not as a record*. Distill writes what the belief set still
cannot explain into its turn, with one residual holding several sourced observations rather than one
entry per observation; there is no residual event, field, or snapshot entry, so residual is not
replayed and not branch-isolated. That is a chosen limit, not an oversight: what the runtime records
instead is the *recheck*. Every distillation owes propose a reconsideration result, and
"reconsidered and kept the reading" is distinguishable from "not reconsidered" — a task-level record,
replayable and branch-isolated, with propose's own one-line reason, shown in the terminal and the RPC
snapshot. Because the recheck is per round, an anomaly that cannot yet change any belief's status
still cannot be skipped past: it is the round it appeared in that must be answered, whether or not
the reading changes. Residual never becomes support for a belief through this path, and the recheck
is not the applicability review (`FormulationApplicabilityRecorded`), which answers what a *revised*
reading means for the conclusions the previous one reached.

The result is projected with the reading itself: the `<current_formulation>` block carries what
propose last made of the reading, labeled as the agent's own position and never as evidence, and it
names the round still unanswered while one is. The terminal reads the same replayed state — the dock
panel marks the last round *recheck owed* or *rechecked · kept the reading*, and `/frame` gives the
verdict with the agent's stated basis. What it deliberately does not give is a list of unexplained
observations: residual is prose, so no such list exists to show.

## Conclusion, task outcome, and reflection

`conclude` is blocked while a proposed belief remains unadjudicated **within the task's scope** —
either in the focus slice, or dispatched by the current experiment (an experiment's outcome must be
adjudicated regardless of later focus changes). An unresolved belief outside the focus does not
block conclusion: the task has said it is not acting on it. Only `proposed` (unadjudicated) beliefs
block; an `inconclusive` belief that has been adjudicated does not.

Before terminal handoff, propose or distill gets one cheap adversarial check:

> Is there any obvious unresolved uncertainty that could materially change the answer? If yes,
> investigate it. Otherwise conclude.

This single guard gates every normal final report entry, including the propose path that falls
through to finalReport when there is no open work — it is not bypassed by omitting an explicit
`conclude`.

A second guard runs before it: once an experiment has been dispatched, propose owes a formulation
decision, and neither choosing another experiment nor concluding may happen first. Distill
concluding is the path that would otherwise reach finalReport without propose ever running again,
so an owed decision diverts it back to propose instead. The formulation is the agent's reading of
the task, not evidence, so it never substitutes for a task outcome: a task with a stated reading
and no delivered result is still unfinished, and a task with a delivered result still has to say
what it made of the request.

### Epistemic sufficiency is not task completion

Concluding also records a **task outcome**, held outside the belief set: what was actually
delivered, the evidence that it was delivered, and any remaining blocker. The same settled beliefs
can answer an explanation request and still fail a change request that also required the change to
exist and be verified, so the two judgments are recorded separately:

- `result` — the answer, change, or artifact actually delivered, not a restatement of beliefs;
- `evidence` — the observation or verification showing the delivery happened (for a change, that it
  works), with source or command result;
- `blockers` — known limitations that remain.

A `conclude` call that is refused — blank `result`/`evidence` — records no outcome and must not
advance the handoff; the loop steers back for the missing delivery record. The outcome is persisted
as a `task_outcome` session entry, published as the task-scoped `TaskOutcomeRecorded` domain event,
and included in `<final_report_context>`, so it survives the final turn and branch replay. The
event is emitted when the record changes, so the loop's second `conclude` (the one that actually
finishes, after the adversarial reflection) does not repeat it. The custom message keeps its own
`delivered`/`verifiedBy`/`blockers` key names; the domain event uses the type's `result`/`evidence`
/`blockers`.

There is no coverage, ontology, conjunction, or recursive completeness protocol. Inconclusive
beliefs are included in `<final_report_context>` so finalReport can preserve uncertainty rather
than silently globalizing a local observation.

FinalReport runs on the default model, not `pie.fastPathModel`, because final synthesis must select
relevant beliefs, combine evidence, and control uncertainty.

## Fast path

Fast path is based on epistemic closure, not operational simplicity. `route_task` may choose it only
when no unresolved belief could materially change the selected action or its safety. The controller
also blocks a fast-path route while an unresolved belief in the task's focus remains; a belief must
first be adjudicated or explicitly retracted as immaterial. An unresolved belief outside the focus
does not block, because the task has declared it is not acting on it.

Terminal ownership is unique:

```text
fast-path execution -> propose (publish/retain Frame) -> finalReport -> user
```

Execution records the outcome; finalReport writes the single terminal response after propose has
stated its reading. A hidden `fast_path_distillation` summary preserves completed actions and blockers
for session continuity. A failed run returns to propose without replaying the consumed route.
Revising an existing Frame here requires the same user response and focus review as a normal loop.

The fast path has no belief loop, so it cannot `conclude`: it submits the same task outcome through
`report_outcome` instead. A clean tool log is operational evidence, not a completion judgment.
Without an explicit submission the run is a failure that hands back to the belief loop, and a
submitted outcome that still carries a blocker is likewise a failure — a partially delivered change
is not a completed one.

A submitted outcome is published as `TaskOutcomeRecorded` like any other. The synthesized failure
outcome the runtime records for continuity is not: it is derived from the tool log and the absence
of a submission rather than delivered by the model, and publishing it would put a sentence the
model never wrote into the channel a viewer renders as the task's delivered result. A viewer
therefore shows "no outcome recorded", which is the truthful state, and the failure handoff back
into the belief loop supplies the real one.

At task boundaries the focus slice is reset and must be re-declared; belief records are *not*
pruned. Supported, refuted, inconclusive, superseded, and leftover proposed records all survive as
history, because a prior refutation or inconclusive judgment can be selected again — retaining only
supported conclusions would let the inheritance mechanism accumulate confirmations and lose the
counter-evidence. Routing is cleared separately.

> Consequence: belief ids are allocated from a monotonic counter and records are never reclaimed, so
> `MAX_BELIEFS` is a budget for the whole session rather than for one task.
