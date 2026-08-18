# Epistemic knowledge vs execution information

Primary-source map of how Pie currently models, stores, passes, and consumes the two layers in `packages/coding-agent`. No fixes — only what the code, comments, types, tests, and in-repo docs actually do.

---

## Intended architecture (from comments / docs / types)

Pie splits **model-facing responsibility** from **durable state**. The comments describe a two-layer loop: an epistemic controller that decides, and an execution role that probes.

**Roles.** `PieModelRole` is `"epistemic" | "execution" | "observation" | "verification" | "finalAnswer"` (`src/core/pie-models.ts:5`). The production loop’s request role is narrower: `"epistemic" | "execution" | "finalAnswer"` (`src/core/pie-agent-loop.ts:25`). Observation and verification exist as model-routing / thinking-level slots (`pie-models.ts:15-22`, `agent-session.ts:532-533`, `788-790`) but are never a `PieProductionRequestRole`.

**Who is allowed to act.**

- Epistemic control “has no tool access” (`grounding-map.ts:8-12`). The loop refuses to execute tools unless `requestRole === "execution"` (`pie-agent-loop.ts:270`). Control parse rejects structured tool calls (`agent-session.ts:1548-1549`). Final-answer must not invoke tools (`pie-agent-loop.ts:327`).
- Provider streaming and tool execution are “shared execution services. A provider stop ends one generation only. Durable Action/Frame transitions and final-answer authorization are explicit controller decisions” (`pie-agent-loop.ts:93-98`).
- Roadmap Phase 7: “Controller instructions are compiler-owned transient request projections, not persisted transcript events… Raw assistant generations, tool calls/results, and all state transitions remain append-only provenance. Every epistemic, execution, recovery, and final-answer request still passes through `ContextCompiler`” (`roadmap.md:713`).

**The epistemic ontology** (restored from the raw branch, never stored as a single blob):

| Primitive | Intended meaning | Source |
|---|---|---|
| Anchor | Task-success semantics | `epistemic-state.ts:12-21`; session-format.md:217 |
| Frame | One provisional world relation + expectation + finite response horizon | `epistemic-state.ts:23-39`; session-format.md:218 |
| Action | One frozen investigation episode under exactly one Frame version **or** the Anchor (`explore`) | `epistemic-state.ts:43-60`; session-format.md:220 |
| Observation | Immutable evidence selected from Action-local execution results | `epistemic-state.ts:64-79`; session-format.md:222 |
| PredictionError | Structured `sign + detail` of how reality diverged from a frozen expectation | `session-manager.ts:187-194` |

`EpistemicState` exposes only the **current** Anchor / admissible Frame / active Action plus all Observations; terminal Frames and complete Action traces “remain in the raw log” (`epistemic-state.ts:81-89`).

**The intended crossing.**

- “Raw result text never enters the statement: `sourceEventIds` is a downward pointer to the episode’s finalized execution results, which stay at the execution layer. The only thing that crosses into the epistemic layer is the named conclusion carried by the prediction-error detail” (`agent-session.ts:1081-1084`).
- “The prediction-error detail is the only semantic carrier that crosses from the execution layer into the epistemic layer” (`agent-session.ts:606-611`).
- “Raw evidence is the execution role’s private working memory” (`context-compiler.ts:304-311`).
- Execution must “End every generation with a single prose sentence stating the established result… The controller reads only this prose, not your raw tool output” (`agent-session.ts:1335-1337`).
- Commit `5858362`: “feed the epistemic controller distilled results, not raw tool traces.”
- Commit `cddc0ea`: “Raw tool-result text stays at the execution layer; only the named conclusion crosses.”
- Commit `4a266a4`: replace raw tool-call/tool-result projection so the no-tool controller stops imitating `<invoke>`.
- Commit `56b02ae`: inject prior Actions’ located probes into the **execution** projection so a fresh Action does not re-run `find`/`ls`/`wc`.

**Context is role-projected, not shared transcript.** `ContextProjectionRole = "default" | "execution" | "epistemic" | "finalAnswer"` (`context-compiler.ts:22`). Policies: `commitment-depth/v1` (execution), `epistemic-breadth/v1` (epistemic / finalAnswer), `transcript/v1` (default) (`context-compiler.ts:45`, `960-965`).

**Lease / budget.** Frame horizon is not guessed; it is derived from provisional Action contracts (`frame-lease-budget.ts:94-143`). The lease is “compiler/controller data and must not be persisted as a fifth primitive” (`roadmap.md:750`). Explore carries `expectedEvidenceRounds` on the Action itself (`session-manager.ts:170-171`).

---

## Actual data structures

### Durable (append-only JSONL, one tree)

All of the following are members of `SessionEntry` (`session-manager.ts:234-249`) and live on the **same** parent-linked session tree as chat:

- `AnchorRevisionEntry`
- `FrameRevisionEntry` / `FrameTransitionEntry`
- `ActionStartEntry` (expectation required; binds to exactly one of `frameRevisionEntryId` | `anchorRevisionEntryId`)
- `ActionTransitionEntry` (`reason: string`; optional challenge)
- `PredictionError` (`sign` + `detail`)
- `ObservationEntry` (statement + optional expectation/sign + `sourceEventIds[]`)

`sessionEntryToContextMessages` converts only `message` / `custom_message` / `branch_summary` / `compaction`. Epistemic entry types return `[]` (`session-manager.ts:488-512`). They become model-facing only when the compiler synthesizes custom messages.

`restoreEpistemicState(entries)` (`epistemic-state.ts:230-365`) walks the active branch and rebuilds `{ anchor?, frame?, action?, observations? }`. Observations may only cite `toolResult` or `bashExecution` messages after the current Action start (`epistemic-state.ts:333-341`).

Assistant messages increment **both** `frame.completedModelResponses` and `action.completedModelResponses` with no role filter (`epistemic-state.ts:346-354`).

### Transient / role-private (not persisted)

| Structure | Where | Persistence |
|---|---|---|
| `PieControlDecision` | `pie-agent-loop.ts:27-65` | Control JSON is persisted as a normal assistant `message` |
| `ActiveFrameLeaseBudget` | `agent-session.ts:504-508` | In-memory; lost on restore |
| `_pendingFinalAuthorization` | set in `_applyProductionControl` | In-memory |
| Grounding map | `grounding-map.ts` | Transient `pie.grounding` custom message |
| Request instruction / role system prompt | `_productionSystemPrompt` | Compiler-owned; not a raw event |
| `_activeProductionRequestRole` | session field | In-memory |

### Compiler-owned custom message types

`context-compiler.ts:13-20`:

- `pie.anchor`, `pie.grounding`, `pie.frame`, `pie.action`, `pie.observation`
- `pie.action-outcome`, `pie.frame-outcome`
- `pie.execution-evidence` — **one customType, two opposite payloads**

---

## Data flow (who sees what)

```
user prompt
  → beginRequest: if no Anchor, user text becomes Anchor revision 1
  → initialRole: "epistemic" (or "execution" if pie loop off / pending start)
  → PieProductionLoop.run
       epistemic: tools=[], controlMaxTokens, thinking "off"
                  handleControlResponse → _applyProductionControl
       execution: full tools, user thinking level
                  handleExecutionResponse → continue or return control
       finalAnswer: tools=[], optional deterministic text (ask/inability)
```

### What the epistemic controller sees

1. `[CURRENT EPISTEMIC STATE]` snapshot inside the role system prompt — Anchor, Frame+lease, active/last Action, **latest** Observation statement only.
2. Allowed `kind`s and JSON field signatures.
3. Unused provisional Action contracts as JSON and already-consumed contracts.
4. Compiler-owned blocks: `[ANCHOR]`, optional `[CODEBASE GROUNDING]`, `[CURRENT FRAME]`, `[FRAME OUTCOME]`, `[OBSERVATION]`, `[ACTION OUTCOME]`, `[CURRENT ACTION]`, `[EXECUTION EVIDENCE]`.
5. Raw events restricted by `selectBroadRawEventIds`: the latest user message, plus the latest non-control, non-toolCall, non-markup assistant prose after the episode boundary.
6. **No tools**.
7. **Still the base coding-agent system prompt** (tool catalog, guidelines, project context) plus the control addendum.

### What the execution role sees

1. Role prompt: execute only the frozen CURRENT ACTION; evidence-round countdown; “read named paths directly”; end with one prose sentence for the controller.
2. Compiler-owned: `[ANCHOR]`, `[CURRENT FRAME]`, **all selected `[OBSERVATION]`s**, `[CURRENT ACTION]`, `[PRIOR EXECUTION EVIDENCE]`. Not `[ACTION OUTCOME]` / `[FRAME OUTCOME]`.
3. Raw events after `action.startEntryId` — this episode’s raw tool-call / tool-result / assistant prose. Control JSON is omitted.
4. Full tool list.

`[CURRENT ACTION]` shows intent + completionCondition only. It does **not** project `action.expectation` (`context-compiler.ts:564-581`).

### How tool results are distilled vs passed raw

There is **no harness-owned distillation function**. Distillation is (a) whatever the execution model writes after its tools, and (b) whatever the controller puts in `predictionError.detail`.

`handleExecutionResponse` does not read the message (`agent-session.ts:2381`). Only `toolResults.length` and budgets decide the next role.

There is no role-private store. Privacy is a **projection filter** over a shared log.

---

## Leak points

### 1. One session tree holds both layers

`SessionEntry` is a single union of chat messages and epistemic primitives (`session-manager.ts:234-249`). Separation is reconstructive.

### 2. Same `AgentMessage` type for control and execution

Control decisions are persisted as ordinary assistant messages. `isControlDecisionMessage` (`context-compiler.ts:275-301`) is a JSON heuristic, not a persisted role tag.

### 3. Failed / non-JSON control responses become “execution evidence”

A rejected control turn that is free prose is collected as the execution role’s “established result” (`context-compiler.ts:336-349` + `agent-session.ts:2360-2378`).

### 4. Latest execution prose is retained **and** copied into `[EXECUTION EVIDENCE]`

`selectBroadRawEventIds` still keeps the latest non-tool assistant prose (`context-compiler.ts:471-479`), **and** `buildExecutionEvidenceMessage` copies that same prose (`324-359`). The controller can see the execution narration twice.

### 5. Distillation is honor-system — raw dumps ride the “prose” channel

The compiler takes **any** non-markup assistant text, truncated at 400 characters, up to 24 texts. Nothing checks that the text is a conclusion rather than pasted `ls`/`read` output.

### 6. Observations are projected into the **execution** role

`projectedObservations` are **not** gated on `broadProjection` (`context-compiler.ts:832-866`, `898-907`). Execution also always sees `[ANCHOR]` and `[CURRENT FRAME]`.

### 7. `[CURRENT ACTION]` omits the frozen expectation

Execution is judged later on expectation + predictionError but never sees the expectation in the compiler-owned Action block.

### 8. One customType, two opposite payloads

`pie.execution-evidence` is used for distilled prose (epistemic) and raw prior traces (execution).

### 9. Prior-probe injection is raw tool traces into the next execution turn

`buildPriorExecutionEvidenceMessage` (`370-407`) walks every message before `action.startEntryId` and copies tool-call arguments plus up to 400 characters of each toolResult.

### 10. Base system prompt (tool catalog) is sent to the no-tool controller

`prepareModelRequest` appends the role addendum onto `buildSystemPrompt` (`agent-session.ts:2272-2276`). Tools are stripped from the API payload; the **text** still describes them.

### 11. Grounding map is raw filesystem inventory in epistemic context

While Anchor exists and Frame does not, the controller receives up to 200 largest source files with byte sizes. World evidence obtained without an Action, Observation, or predictionError.

### 12. `predictionError.detail` is unconstrained text that becomes durable epistemic state

The gate rejects only empty / vague / sign-mismatched detail. Anything else — including pasted command output — is written into `Observation.statement` and then into every later `[OBSERVATION]`.

### 13. Execution can terminate an Action without a PredictionError

If the execution model’s text is exactly `UNRESOLVABLE`, `_handleAgentEvent` appends `action_transition` without calling `_materializeTerminalObservation` (`agent-session.ts:2862-2876`).

### 14. Shared response counters mix control and execution

`restoreEpistemicState` increments Frame/Action `completedModelResponses` on every assistant message, including control JSON. A control turn therefore consumes the same Frame horizon the lease derived from execution rounds.

### 15. Explore is an Action — execution machinery under an epistemic operator

`_appendExploreStart` writes a normal `action_start` bound to the Anchor. Pre-Frame comprehension shares Action identity, evidence-round counters, Observation materialization, and `[CURRENT ACTION]` projection with solution-level probes.

### 16. Loop-local `currentContext` accumulates mixed-role messages

`PieProductionLoop` appends every streamed assistant message and every toolResult onto `currentContext.messages` regardless of role. The compiler is the filter; this package cannot show that the filter runs on every continuation.

### 17. `default` projection is the unseparated transcript

Any caller that forgets to set the role gets both layers (`transcript/v1`).

### 18. Observation / verification roles are declared but unused

`PieModelRole` includes them; `PieProductionRequestRole` does not. No request is ever compiled with an observation or verification projection.

### 19. Prompt text, not types, is the remaining boundary enforcement

Neither “never emit tool-call syntax” nor “end with one prose sentence” is a type-level or compiler-level guarantee.

### 20. Current uncommitted diff does not change the boundary

Working tree only restates `expectedEvidenceRounds` semantics and broadens `SERIAL_DEPENDENCY_PATTERN`. It does not add a private store or change projections.

---

## Tests that encode the intended boundary

| Test | File | Contract |
|---|---|---|
| “surfaces the execution role’s distilled narration, not raw tool results” | `test/context-compiler.test.ts:785-881` | Epistemic projection contains distilled prose; must not contain raw evidence strings |
| “replaces raw tool-call/tool-result traffic with the execution role’s distilled narration” | `test/context-compiler.test.ts:883-969` | No `toolResult` role; no `toolCall` parts; one `pie.execution-evidence` custom message |
| “injects prior Actions’ located probes into the execution projection” | `test/context-compiler.test.ts:971-1042` | Execution projection contains `[PRIOR EXECUTION EVIDENCE]` |
| “projects execution depth and epistemic breadth through the production boundary” | `test/suite/context-compiler-boundary.test.ts:64-146` | After first Action, epistemic sees `[ACTION OUTCOME]` and not the prior episode’s raw trace |
| “materializes a frame-targeted Observation for complete_action” | `test/suite/phase-10-feedback-observation.test.ts:179-226` | Statement is expectation + `confirmed: …`; statement must not contain raw `observed:` |
| “returns control when the accepted evidence-round estimate is exhausted” | `test/suite/phase-7-production-flow.test.ts:584-620` | Budget exhaustion still materializes a refuted Observation |
| “gives a targeted repair hint when control emits a tool call as text” | `test/suite/completion-condition-bounds.test.ts:927+` | `<invoke>` from the no-tool role is rejected with a hint, not executed |

What the tests **do not** encode: Observation-free execution context; omission of the raw latest-prose assistant event from epistemic projection; validation that “established result” text is not a dump; a persisted role tag on assistant messages; a role-private store.

---

## Open questions / ambiguities in the code itself

1. **`observation` and `verification` PieModelRoles** are routable and have thinking-level defaults, but no production request ever uses them.
2. **Is the latest raw execution assistant message supposed to remain in epistemic context?** Comments say the derived evidence message replaces tool traffic; `selectBroadRawEventIds` still keeps that result as a raw event.
3. **Should Observations appear in execution context?** Compiler always injects them. Phase 7 boundary test only hides `[ACTION OUTCOME]` from execution.
4. **Two terminalization paths.** Controller `complete_action` goes through `PredictionError` + Observation. Execution `UNRESOLVABLE` token and public `ActionDirective.reason` do not.
5. **Lease budget is transient.** After restore, `authorize_action` throws. Explore rounds **are** persisted on `ActionStartEntry`.
6. **`Action.expectation` is required on the type, then dropped from `[CURRENT ACTION]`.** Execution is instructed against `completionCondition`; adjudication is against `expectation`.
7. **Does agent-core always apply `transformContext`?** The loop buffer mixes roles; the compiler is the filter.
8. **`buildExecutionEvidenceMessage` collects every qualifying prose line in the episode (max 24), not just the last.**
9. **`episodeBoundary` for a terminal failure uses the last `unresolvable`/`escalated` start.** A later completed Action that has already ended leaves `action` undefined; the controller then sees the **failed** episode’s evidence.
10. **Session-format.md:220** still describes `action_start` as “bound to one exact Frame revision” and does not mention Anchor-bound `explore`.
11. **Roadmap.md:713** says controller instructions are “not persisted transcript events.” Control JSON **is** persisted as assistant messages.
12. **Diagnostics vs cognition.** `getEpistemicDiagnostics` inlines raw tool output next to Observation statements. Easy to mistake for the model-facing boundary.

---

## Intended vs actual (one paragraph)

Intended: two cognitive layers; shared append-only provenance; the only execution→epistemic crossing is a named `predictionError.detail`; the only epistemic→execution crossing is a frozen Action contract; the compiler projects different slices by role. Actual: one log, one `AgentMessage` type, no persisted role tag; distillation is whatever the execution model writes and whatever the controller puts in `detail`; Observations, Anchor, and Frame are injected into execution; grounding and the base tool-list prompt are injected into epistemic; failed control prose can be reclassified as execution evidence; the latest execution narration is both copied and retained raw; `UNRESOLVABLE` and string-reason APIs bypass the structured crossing; `observation`/`verification` roles are unused. Recent commits (`4a266a4`, `5858362`, `cddc0ea`, `56b02ae`) tightened the **projection** of tool traces without splitting storage or making distillation structural.
