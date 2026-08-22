# The four-phase belief loop — roles, steers, and context

> **Status: current.** Describes the implemented loop in `agent-session.ts`,
> `role-specs.ts`, `belief-set.ts`, and the belief tools.

The belief loop has four phases. Their policy is declared centrally in
`src/core/role-specs.ts` (`ROLE_SPECS` + `TRANSITION_STEERS`) so prompts, tool
surfaces, model selection, and message projections cannot drift apart.

> **Fast path.** A request may skip this loop. The propose role's first turn declares a
> `route` belief (op `route`, domain `routing`) with a `decision`, `suitabilityProbability`,
> `successProbability`, `estimatedSteps`, and `difficulty`, judged on the configured
> `defaultModel`. A `fast-path` decision dispatches the
> execution role to execute the request directly on `pie.fastPathModel` and answer the user;
> the run is then distilled with `pie.distillationModel` into a `fast_path_distillation`
> custom summary and the loop resets to the next task's propose. Each `route` belief is
> consumed by id on first evaluation, and only the latest unconsumed route decides; the fast
> path dispatches only when the belief set is quiescent — no proposed world belief pending
> verification, no open framing obligation. A later propose turn (after a distill batch
> settles) may therefore declare a one-shot `fast-path` handoff for the remaining work. A tool
> failure hands the same task back to propose with the summary (no `_resetLoopForNewTask()`);
> the consumed route is not re-dispatched. A `belief-loop` decision — or a missing/rejected
> route, or a route evaluated while the belief set is not quiescent — keeps the four-phase
> loop below.

> **Task boundaries.** At every task-boundary reset (`_resetLoopForNewTask()` — a fast-path
> success, or the next task arriving after a concluded one) the belief set is pruned to
> settled product/code knowledge: framing obligations, routing decisions, refuted and
> superseded records, and any leftover proposed entries are dropped; only `supported`
> product/code beliefs carry over as session knowledge for the next task. A failed fast-path
> run hands the same task back to propose without pruning. The set is capped at
> `MAX_BELIEFS` (200) records: a 201st record (propose, refine, or route) is rejected with a
> validation error, while support/refute/retract keep working at capacity.

> **Mid-task frame-open handoff.** A later propose turn may hand the remaining work to the
> fast path even while a framing obligation is still open, but only with explicit
> authorization. Declare a `route` belief with decision `fast-path` plus `handoffFromBeliefIds`
> naming **exactly** the open framing obligations it takes over, the current `parentTaskId`
> (the session's stable task id), and a `reason`. The gate (`_frameOpenHandoffAuthorized`)
> requires no proposed world belief, that every open framing is covered exactly, and that the
> `parentTaskId` matches the current task id; otherwise the route is rejected and the belief
> loop continues. On success the harness synthesizes a `proposed` product/code outcome belief,
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
| — | `execution` | probes by observation or minimal intervention and reports raw observations |
| — | `finalAnswer` | writes the conclusion from the injected snapshot |

## The four roles

| | `propose` | `execution` | `distill` | `finalAnswer` |
|---|---|---|---|---|
| job | decide what to test; open/close framing obligations | probe the belief's referent; intervene minimally when the intended outcome requires an actual change | turn the observation into belief updates | write the conclusion |
| tools | `declare_belief` `view_beliefs` `conclude` | all active tools except `declare_belief`/`conclude` + `view_beliefs` | `declare_belief` `view_beliefs` `conclude` | none |
| `view_beliefs` scope | `all` | `frame` | `all` | n/a |
| model | session default | `pie.executionModel` (settings) | `pie.distillationModel` (settings) | session default |
| thinking | session default | session default | `pie.distillationThinkingLevel` (settings, default `low`) | session default |
| projection | operational detail masked unconditionally; probe calls and epistemic thinking elided | belief bookkeeping masked (`declare_belief`/`conclude`) | like `propose`, except the current episode's raw evidence is shown exactly once above the watermark, then masked; epistemic thinking elided | all operational detail, belief-tool echoes, and thinking masked |
| output | proposed beliefs, framing obligations, `conclude` | a one-sentence raw observation of the probe or intervention result | `support`/`refute`/`refine`/`retract` | the conclusion text |

Each row is a `RoleSpec` in `role-specs.ts` (`instruction`, `tools`, `beliefScope`,
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

- propose → execution: dispatch the open frame ("Run the experiments for the beliefs …").
- execution → distill: `residual` steer ("Account for the observation: explain what your
  beliefs already explain, isolate the residual they do not, and update only on that
  residual."). The execution lease is `ceil(sum(evidenceRounds) × 1.3)` tool results; at
  exhaustion it nudges once (`leaseNudge`), then forces the return.
- distill → propose: `deepenOrConclude`, or `openBeliefs` while any belief is still open.
- propose/distill → finalAnswer (via `conclude`): gated — open framing obligations or open
  world beliefs block it (`concludePremature`); a one-time `reflection` steer (coverage /
  composition / completeness) fires when the task produced beliefs; the second `conclude`
  delivers `writeConclusion` plus the `<final_answer_context>` snapshot.

## FinalAnswerContext

The finalAnswer role has no tools and the belief set is never injected into the system
prompt, so the terminal handoff injects an explicit snapshot
(`_formatFinalAnswerContext` in `agent-session.ts`):

- settled world beliefs (statement, expectation, evidence),
- framing outcomes (statement, status, discharge evidence),
- refuted beliefs (to be treated as non-facts).

The finalAnswer projection (`projection: "finalAnswer"`) masks raw operational detail, distills
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
