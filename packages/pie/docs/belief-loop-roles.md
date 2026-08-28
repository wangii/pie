# The four-phase belief loop — roles, steers, and context

> **Status: current.** Describes the implemented loop in `agent-session.ts`,
> `role-specs.ts`, `belief-set.ts`, and the belief tools.

The target cross-runtime/GUI ownership and event contract is documented in
[Agent session domain model](domain-model.md). This page continues to describe
the current loop behavior until that migration is implemented.

The belief loop has four phases plus a batching planner step between propose and
execution (propose → planner → execution → distill → finalReport). Their policy is
declared centrally in `src/core/role-specs.ts` (`ROLE_SPECS` + `TRANSITION_STEERS`)
so prompts, tool surfaces, model selection, and message projections cannot drift
apart.

> **Fast path.** A request may skip this loop. The propose role's first turn declares a
> routing decision with the `declare_belief` tool's `route` op (recorded as a `Routing` in
> the `RoutingSet`, not a belief): a `decision`, `suitabilityProbability`,
> `successProbability`, `estimatedSteps`, and `difficulty`, judged on the configured
> `defaultModel`. A `fast-path` decision dispatches the
> execution role to execute the request directly on `pie.fastPathModel` and answer the user;
> the run is then distilled with `pie.distillationModel` into a `fast_path_distillation`
> custom summary and the loop resets to the next task's propose. Each `route` is
> consumed by id on first evaluation, and only the latest unconsumed route decides. An
> initial `fast-path` route dispatches directly; open framing and world beliefs do not block
> this one-shot path, but they are not carried into it: the run executes without
> seeing them, and on success `_resetLoopForNewTask()` prunes any still-open hypotheses (only
> `supported` product/code knowledge survives). Snapshotting open world beliefs as unverified
> hypotheses and re-adjudicating them after the run is specific to the authorized frame-open
> handoff below. A later propose turn (after a distill batch
> settles) may therefore declare a one-shot `fast-path` handoff for the remaining work. A tool
> failure hands the same task back to propose with the summary (no `_resetLoopForNewTask()`);
> the consumed route is not re-dispatched. A `belief-loop` decision or a missing/rejected
> route keeps the four-phase loop below. Coverage of open framing beliefs is required only
> for the authorized mid-task handoff described next.

> **Task boundaries.** At every task-boundary reset (`_resetLoopForNewTask()` — a fast-path
> success, or the next task arriving after a concluded one) the belief set is pruned to
> settled product/code knowledge: framing obligations, refuted and
> superseded records, and any leftover proposed entries are dropped (routing decisions live
> in a separate `RoutingSet`, cleared independently); only `supported`
> product/code beliefs carry over as session knowledge for the next task. A failed fast-path
> run hands the same task back to propose without pruning. The set is capped at
> `MAX_BELIEFS` (200) records: a 201st record (propose or refine) is rejected with a
> validation error, while support/refute/retract keep working at capacity. Routing decisions
> are not belief records; they are held in `RoutingSet`, likewise capped at `MAX_BELIEFS`.

> **Mid-task frame-open handoff.** A later propose turn may hand the remaining work to the
> fast path even while a framing obligation is still open, but only with explicit
> authorization. Declare a `route` with decision `fast-path` plus `handoffFromBeliefIds`
> naming **exactly** the open framing obligations it takes over, and a `reason`. The gate
> (`_frameOpenHandoffAuthorized`) requires that every open framing is covered exactly by
> `handoffFromBeliefIds`; otherwise the route is rejected and the belief loop continues. Unlike the
> one-shot path, the handoff snapshots any still-open world hypotheses into the fast-path
> context as unverified assumptions (not facts): the execution role sees them explicitly, and
> the distillation prompt lists them. Because the loop is not reset, the distill step
> re-adjudicates any that remain after the run. On success the harness synthesizes a `proposed` product/code outcome belief,
> marks it dispatched, and routes to distill via `fastPathDischarge`; the distill step then
> supports/refutes the outcome and, once supported, discharges the authorized framing per the
> `evidenceBeliefIds` rule. The `fast_path_distillation` summary carries the traceability
> fields (`parentTaskId`, `handoffFromBeliefIds`, `reason`, `outcomeBeliefId`). A tool failure
> hands the same task back to propose (`fastPathHandoff`) without pruning.

## Terminology


| legacy name | current name | meaning |
|---|---|---|
| `epistemic` (old single role) | `propose` + `distill` | the belief-side pair; `epistemic` survives only as a deprecated key in `getRoleContextUsage` |
| `two-role loop` | four-phase loop | the loop has four phases, not two |
| — | `planner` | groups the open beliefs into one execution batch per turn (direct `Batch:` output; no tools); a single open belief or a failed selection falls back to the whole-frame dispatch |
| — | `execution` | probes by observation or minimal intervention and reports raw observations |
| — | `finalReport` | writes the conclusion from the injected snapshot |

## The five roles

| | `propose` | `planner` | `execution` | `distill` | `finalReport` |
|---|---|---|---|---|---|
| job | decide what to test; open/close framing obligations | group the open beliefs into the next execution batch (one batch per turn) | probe the belief's referent; intervene minimally when the intended outcome requires an actual change | turn the observation into belief updates | write the conclusion |
| tools | `declare_belief` `view_beliefs` `conclude` | none (open beliefs injected directly) | all active tools except `declare_belief`/`conclude` + `view_beliefs` | `declare_belief` `view_beliefs` `conclude` | none |
| `view_beliefs` scope | `all` | n/a | `all` | `all` | n/a |
| model | session default | `pie.plannerModel` (settings) | `pie.executionModel` (settings) | `pie.distillationModel` (settings) | `pie.fastPathModel` (settings) |
| thinking | session default | session default | session default | `pie.distillationThinkingLevel` (settings, default `low`) | session default |
| projection | operational detail masked unconditionally; probe calls and epistemic thinking elided | belief projection with open beliefs injected in the role prompt | current episode's raw evidence shown once above the watermark; epistemic thinking elided | operational detail, belief-tool echoes, and thinking masked | raw operations and belief echoes masked; explicit final-report snapshot injected |
| output | proposed beliefs, framing obligations, `conclude` | one `Batch:` line | raw probe/intervention observation | `support`/`refute`/`refine`/`retract` deltas | conclusion text |

Each row is a `RoleSpec` in `role-specs.ts` (`instruction`, `tools`,
`modelPolicy`, `projection`, `strayToolSteer`). The execution tool list is derived from the
full active set minus the belief-mutation tools, so custom tools stay available to it.

The propose and distill projections strip plaintext `thinking` from every assistant turn —
probe reasoning via `_maskProbeAssistant` (with its tool calls), and the epistemic roles' own
reasoning via `_maskEpistemicThinking` (keeping text and every belief tool call) — so neither
view ever receives a `ThinkingContent` block. A distill turn that applies belief updates also
emits a displayable `belief_distillation` custom message (the `Applied`/`Rejected` status
lines, `display: true`), the in-loop analog of the fast path's `fast_path_distillation` block.

Beliefs must be written in the language configured by `pie.beliefLang` in settings
(default `English`); the role instructions and belief-tool guidelines substitute it at
prompt assembly.

## Transitions

The state machine lives in `_transition`; every steer text lives in `TRANSITION_STEERS`:

- propose/distill → planner: plan the next batch from the remaining open beliefs
  ("Plan the next execution batch …"). The planner has no tools: the open beliefs
  (id + statement) are handed to it directly in the steer and it replies with exactly one
  `Batch:` line naming the batch. A single remaining open belief needs no grouping decision
  and is dispatched directly, and a failed selection (no `Batch:` line, an empty or stale
  selection) falls back to the whole-frame dispatch.
- planner → execution: dispatch the selected batch ("Run the experiments for the
  beliefs …"), with a per-batch lease. After distill settles the batch, the remaining
  open beliefs are re-planned from the latest open set.
- execution → distill: `residual` steer ("Account for the observation: explain what your
  beliefs already explain, isolate the residual they do not, and update only on that
  residual."). The execution lease is `ceil(sum(evidenceRounds) × 1.3)` tool results; at
  exhaustion it nudges once (`leaseNudge`), then forces the return.
- distill → propose: `deepenOrConclude`, or `openBeliefs` while any belief is still open.
- propose/distill → finalReport (via `conclude`): gated — open framing obligations or open
  world beliefs block it (`concludePremature`); a one-time `reflection` steer (coverage /
  composition / completeness) fires when the task produced beliefs; the second `conclude`
  delivers `writeConclusion` plus the `<final_report_context>` snapshot.

## FinalReportContext

The finalReport role has no tools and the belief set is never injected into the system
prompt, so the terminal handoff injects an explicit snapshot
(`_formatFinalReportContext` in `agent-session.ts`):

- settled world beliefs (statement, expectation, evidence),
- framing outcomes (statement, status, discharge evidence),
- refuted beliefs (to be treated as non-facts).

The finalReport projection (`projection: "finalReport"`) masks raw operational detail, distills
epistemic assistant turns (`_maskEpistemicAssistant` — thinking and every belief tool call
dropped, text kept), and masks every belief-tool echo (`_maskBeliefEchoes`, now including
`conclude`), so the conclusion is grounded in the snapshot, not in whatever tool results or
bookkeeping calls happen to survive in the transcript.

## Framing discharge

A framing belief (`domain: "framing"`) is an obligation, not a probe target (it never
dispatches; `conclude` is gated while one is proposed). Supporting one now requires
`evidenceBeliefIds` — ids of product/code beliefs that establish the obligation. The harness
(`_validateFramingDischarge` in `belief-set.ts`) rejects a framing `support` unless at least
one id is given, all ids exist, all are `product`/`code`, and all are already `supported`;
the references are persisted as `supportedBy[].beliefIds`. Non-framing support ignores the
field, so old callers stay compatible.
