# The four-phase belief loop — roles, steers, and context

> **Status: current.** Describes the implemented loop in `agent-session.ts`,
> `role-specs.ts`, `belief-set.ts`, and the belief tools.

The belief loop has four phases. Their policy is declared centrally in
`src/core/role-specs.ts` (`ROLE_SPECS` + `TRANSITION_STEERS`) so prompts, tool
surfaces, model selection, and message projections cannot drift apart.

## Terminology

| legacy name | current name | meaning |
|---|---|---|
| `epistemic` (old single role) | `propose` + `distill` | the belief-side pair; `epistemic` survives only as a deprecated key in `getRoleContextUsage` |
| `two-role loop` | four-phase loop | the loop has four phases, not two |
| — | `execution` | probes the code/product and reports raw observations |
| — | `finalAnswer` | writes the conclusion from the injected snapshot |

## The four roles

| | `propose` | `execution` | `distill` | `finalAnswer` |
|---|---|---|---|---|
| job | decide what to test; open/close framing obligations | probe the belief's referent | turn the observation into belief updates | write the conclusion |
| tools | `declare_belief` `view_beliefs` `conclude` | all probe tools + `view_beliefs` (no `declare_belief`/`conclude`) | `declare_belief` `view_beliefs` `conclude` | none |
| `view_beliefs` scope | `all` | `frame` | `all` | n/a |
| model | session default | `pie.executionModel` (settings) | `pie.distillationModel` (settings) | session default |
| projection | operational detail masked by watermark; probe calls elided | belief bookkeeping masked (`declare_belief`/`conclude`) | same as `propose` | all operational detail and belief-tool echoes masked |
| output | proposed beliefs, framing obligations, `conclude` | a one-sentence raw observation | `support`/`refute`/`refine`/`retract` | the conclusion text |

Each row is a `RoleSpec` in `role-specs.ts` (`instruction`, `tools`, `beliefScope`,
`modelPolicy`, `projection`, `strayToolSteer`). The execution tool list is derived from the
full active set minus the belief-mutation tools, so custom tools stay available to it.

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
