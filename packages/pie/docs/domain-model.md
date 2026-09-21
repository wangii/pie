# Agent session domain model

> **Status: current runtime contract, schema v6.** `agent-session-domain.ts` defines this model,
> `BeliefLoopController` emits and replays its events, and RPC forwards those events unchanged.
> GUI projections remain consumers rather than sources of truth.

> **Every schema bump so far has been breaking.** v2 renamed the execution-round vocabulary from
> `TaskFrame`/`frameId` to `ExecutionEpisode`/`episodeId`; v3 added the task-level problem
> formulation; v4 added the experiment selection; v5 added revision response and focus review;
> v6 added the per-round formulation recheck.
> Older logs are rejected rather than migrated —
> see [Protocol versioning and old logs](#protocol-versioning-and-old-logs).

## Problem and solution

Operational messages alone do not provide durable task, episode, routing, belief, execution,
distillation, and problem-formulation identity. Inferring those objects from adjacent model turns
makes phase transitions ambiguous and couples consumers to controller implementation details.

PIE therefore emits one language-neutral domain contract with stable opaque ids and explicit
lifecycle events. The runtime is authoritative. Consumers replay the events into a read model;
they do not discover task/episode boundaries or epistemic relationships from message adjacency.

## Three layers, not one object

The unified vocabulary does not mean that one C++ object becomes the database,
runtime controller, and GUI model.

1. **Domain event log** — durable source of truth on the active session branch.
2. **`AgentSessionSnapshot`** — replayed read model for one active branch.
3. **GUI projections** — `NativeGuiModel` and `GraphTaskState`, derived from the
   snapshot/events for display.

The existing TypeScript `AgentSession` class keeps its operational meaning. The
new read model is named `AgentSessionSnapshot` to avoid conflating behavior with
data.

## Identity and ownership

All domain ids are stable opaque strings. They are emitted on the wire exactly
as stored; no array-index or display-label remapping is allowed.

```text
Session
├─ active branch -> ordered Task ids
├─ Task records
│  ├─ ordered ExecutionEpisode records
│  └─ ordered ProblemFormulationVersion records
└─ session-wide Belief registry
```

Ownership rules:

- a Belief belongs to the session-wide registry, not to a Task or ExecutionEpisode;
- a Task records which beliefs it inherited and introduced by id;
- a Plan selects Beliefs by id;
- an ExecutionEpisode records Belief deltas and provenance, but never owns mutable
  Belief pointers;
- Execution and Distillation occurrences belong to exactly one ExecutionEpisode;
- Routing belongs to the ExecutionEpisode whose path it selected;
- a ProblemFormulationVersion belongs to exactly one Task, is append-only, and is
  never inherited by another Task;
- Target is the immutable user outcome captured at task start; it remains control context and is not copied into the Belief registry.

Cross-language and persisted records use ids, never `shared_ptr`/`unique_ptr`.
An implementation may use references internally, but pointer ownership is not
part of the domain or wire contract.

## Read model

The following C++-like pseudocode describes relationships, not a required C++
header. TypeScript uses tagged unions with the same discriminants.

```cpp
struct AgentSessionSnapshot {
  SessionId id;

  // One projection of the SessionManager tree: tasks on the selected branch.
  std::vector<TaskId> activeBranchTasks;
  std::unordered_map<TaskId, Task> tasks;

  // Canonical knowledge registry for the active branch.
  std::unordered_map<BeliefId, Belief> beliefs;
  std::vector<BeliefId> activeBeliefs;
};

struct Task {
  TaskId id;
  std::optional<TaskId> parentTaskId;

  InitialPrompt initialPrompt;
  Target initialTarget;
  TaskStatus status;

  std::vector<BeliefId> inheritedBeliefs;
  std::vector<BeliefId> introducedBeliefs;
  std::vector<ExecutionEpisode> episodes;

  // Task scope: the beliefs this task is acting on. Never inherited; a new Task
  // starts undeclared.
  std::vector<BeliefId> focus;
  bool focusDeclared;
  std::optional<FormulationReview> formulationReview;
  // What the task delivered, and how it was verified. Absent until recorded.
  std::optional<TaskOutcome> taskOutcome;

  // The agent's understanding of its own task, oldest first. Append-only, and never
  // inherited: a new Task starts with an empty history.
  std::vector<ProblemFormulationVersion> formulations;
  // Set while propose has deferred and has not published since. Never removes a version.
  std::optional<FormulationDeferral> formulationDeferral;
  // User corrections against this task's understanding, oldest first.
  std::vector<FormulationCorrection> formulationCorrections;
  // The most recent round's reconsideration result. Absent until one is recorded.
  std::optional<FormulationRecheck> formulationRecheck;
};

struct FormulationRecheck {
  EpisodeId episodeId;              // the distilled round it answers
  FormulationRecheckVerdict verdict; // maintained | revised | deferred
  std::string reason;                // propose's own one-line basis
  std::optional<FormulationVersionId> versionId; // present exactly when revised
  std::string recordedAt;
};

struct TaskOutcome {
  std::string result;
  std::string evidence;
  std::optional<std::string> blockers;
};

struct InitialPrompt {
  PromptId id;
  Content original;
  Content effective; // after input hooks, skills, and prompt templates
};

struct Target {
  TargetId id;
  std::string statement;
};

struct ExecutionEpisode {
  EpisodeId id;
  TaskId taskId;
  uint64_t ordinal;
  EpisodeStatus status;
  EpisodeStage stage;

  std::vector<Intervention> steering;
  std::optional<Routing> routing;
  // The experiment propose has chosen and not yet dispatched. Cleared by the Plan that
  // commits it, or by an explicit void.
  std::optional<ExperimentSelectionRecord> experimentSelection;
  std::variant<PendingEpisode, BeliefLoopEpisode, FastPathEpisode> body;
};

struct ExperimentSelectionRecord {
  std::string intent;
  std::vector<BeliefId> beliefIds;
  // The understanding this choice was made under; Unformed before the first version.
  FormulationAdoption formulation;
};

struct PendingEpisode {};

struct BeliefLoopEpisode {
  std::vector<BeliefId> openBeliefsAtStart;
  Plan plan;
  std::vector<Execution> trajectory;
  std::optional<Distillation> distillation;
  std::vector<BeliefDelta> beliefDeltas;
};

struct FastPathEpisode {
  std::vector<Execution> trajectory;
  std::optional<Distillation> distillation;
  // The fast path has no Plan to carry this, so the episode records it directly.
  FormulationAdoption formulation;
};
```

`PendingEpisode` is legal only while an active episode is waiting for routing/path
selection. A closed episode must contain either `BeliefLoopEpisode` or
`FastPathEpisode`. The tagged union prevents both bodies from being present and
prevents an unclassified closed episode.

### ExecutionEpisode is not the problem formulation

An `ExecutionEpisode` is one round of execution: a routing decision, one experiment, and the
evidence it produced. It answers "what was tried, and what came back". It is not the agent's
current understanding of the task.

This vocabulary was renamed from `TaskFrame` precisely because the old name invited the
conflation. The old `TaskFrame` opened on every distill → propose handoff, so it always meant an
execution round; the name merely made it look like a frame of reference, and readers — including
this document — drifted into describing it as one. `EpisodeStage` reflects that: `proposing` and
`distilling` name the role that owned the round, not an interpretation of the task.

A new episode never implies a revised understanding, and a revised understanding never implies a
new episode: see [Problem formulation](#problem-formulation) for the other record.

### Problem formulation

The product-facing name for this record is **Frame**. It is the agent's current answer to "what am
I taking this task to be", stated in its own provisional first person. It is not a Belief: it
carries no evidence verdict and no truth status, and a formulation may never stand in as support
for one. If a reading smuggles in an empirical claim that would change what the agent does, that
claim belongs in the Belief registry where it can be tested.

```cpp
struct FormulationContent {
  std::string interpretation;          // how I currently understand this task
  std::optional<std::string> alternative; // a reading I am not prioritizing
  std::string focus;                   // which objects, relations, or scales I am attending to
  std::optional<std::string> tension;  // the conflict I am trying to explain; absent = not yet clear
  std::string implication;             // what this reading changes about where the work goes
};

struct ProblemFormulationVersion {
  FormulationVersionId id;
  TaskId taskId;
  uint64_t ordinal;
  std::optional<FormulationVersionId> previousVersionId; // absent only for ordinal 1
  Timestamp recordedAt;
  FormulationOrigin origin;            // always Propose
  FormulationContent content;
  std::string reason;                  // short: why this version was formed or revised
  std::vector<FormulationSource> sources;
};

struct FormulationDeferral {
  std::string missingInformation;
  std::string reason;
  std::vector<FormulationSource> sources;
  Timestamp deferredAt;
};

struct FormulationCorrection {
  FormulationCorrectionId id;
  TaskId taskId;
  std::optional<FormulationVersionId> targetVersionId; // absent when no version existed yet
  Content original;                    // the user's words, verbatim
  Timestamp receivedAt;
  FormulationCorrectionStatus status;  // Pending | Resolved
  std::optional<std::string> response; // propose's answer; required once resolved
  std::optional<FormulationVersionId> recordedVersionId; // the revision that answered it, if any
};
```

`interpretation`, `focus`, and `implication` are required. A version that cannot say what it
understands, what it is attending to, and what that changes is a label rather than a working
understanding. `alternative` and `tension` are optional and must stay genuinely optional: an agent
with no rival reading and no articulated tension publishes without them rather than inventing
content to fill a field, and a present-but-blank optional is rejected for the same reason.

#### Sources

A source names what a version was formed from, and every kind resolves to a record that is already
durable:

```cpp
std::variant<
  PromptRef,        // this task's InitialPrompt
  InterventionRef,  // a steering message delivered to one of this task's episodes
  CorrectionRef,    // a user correction recorded on this task
  ExecutionRef,     // one tool execution in one of this task's episodes
  DistillationRef,  // one distillation in one of this task's episodes
  BeliefRef         // a BeliefId plus the BeliefDeltaId that recorded its state
> FormulationSource;
```

Two rules make citations auditable rather than decorative. A citation that names nothing is
rejected, because unresolvable provenance reads as provenance. And a belief is cited through a
delta rather than an id alone, because a belief is mutable: replaying a version later must show the
belief's state *at the time*, not its latest one. Citing an existing record is by itself a
legitimate reason to reframe — reinterpreting old evidence is real work and does not require a
fresh tool call.

#### Versions are immutable

Versions are append-only. A revision is a new version whose `previousVersionId` names its
predecessor; the fold rejects a version whose ordinal does not follow the history, whose
predecessor is not the current version, and whose id already exists. Nothing rewrites a version in
place, so a later correction or reframing leaves the earlier record readable exactly as it was
published.

Whether a change is *substantive* is propose's judgment, not the runtime's. The only mechanical
rule is that resubmitting content identical to the current version is a no-op: it emits no event
and creates no version. Deciding whether a paraphrase is substantive would take a second model to
compare semantics, and the runtime deliberately does not add one — which also means more evidence
for an unchanged reading never manufactures a revision.

#### Revision response and focus review

A revision (ordinal > 1) creates task-local `formulationReview`:
`{ versionId, responseCorrectionId?, focusReviewed: false }`. The first publication does not
require user interaction, and the first investigation may still run without a Frame.

Until a user response targets that exact version, the run stops after the tool batch and the task
stays active. Later tools in the batch cannot dispatch, reframe, change focus, or conclude. A normal
user reply while paused is recorded through the correction channel; an explicit correction can
name its target version. Earlier queued input, responses targeting older versions, and extension
messages do not release the wait. There is no timeout approval.

After the response arrives, propose must answer every pending correction and call `focus_beliefs`.
The resulting `FocusDeclared.formulation` names the reviewed version, even when the belief ids are
unchanged. Experiment selection, routing and conclusion remain gated until that review. A further
revision requires another response; answering an earlier correction cannot acknowledge a later
version. These states are replayed with the active branch, including its beliefs and focus.

The terminal shows the wait and the review obligation. Reply normally to continue the paused task.
`/frame correct` records a correction; when idle, a subsequent prompt starts its processing.
RPC exposes the same review through `get_state.formulation.review` and the domain snapshot, and the
same reconsideration state through `get_state.formulation.recheck` / `.recheckOwed`: the panel and
the snapshot therefore agree on whether the last round was looked at, because both read the replayed
task rather than a counter the runtime keeps beside it.
Native GUI rendering and terminal manual smoke validation are separate from this core contract.

#### Adoption: which version governed a decision

```cpp
std::variant<
  FormulationVersionRef,  // { versionId }
  Unformed                // no version had been formed at that moment
> FormulationAdoption;
```

`Plan` and `FastPathEpisode` each record the adoption for the selection and the dispatch they
represent. `Unformed` is a recorded fact, not a missing field: it is what keeps a first
investigation honest, because the version a later round publishes cannot be back-dated onto a
decision that was made before it existed. The fold therefore refuses `Unformed` once a version
exists — a decision made after a publication is under that publication.

A belief-loop episode does not carry the adoption itself; its `Plan` does, so the selection and the
dispatch cannot disagree about which understanding governed them. The fast path has no `Plan`, so
its episode carries the adoption directly.

#### Deferral

"Not investigated yet" and "investigated and deferred" are different states, and only the second
is recorded. A deferral states what information is missing and why, and it is never a blank
version. It does not remove a version that already exists; a deferral recorded after a publication
adds a state beside the current understanding. A publication answers the deferral, so the deferred
state stops being current — while the deferral event itself stays in the log.

#### Corrections

A user correction is kept as its own record beside the version it targets, never written into it,
so the published version stays the agent's own stated position and the objection stays auditable.
A correction may target no version — a user can object before any version exists. Resolution is
addressed to a specific correction id and requires a non-empty response, so a response written for
an older correction can never be recorded as the answer to one that arrived while it was being
handled.

### Who decides, and when the decision is owed

Only propose publishes. The record states this itself (`origin: Propose`), and the runtime
enforces it by keeping `set_formulation` and `defer_formulation` off every other role's surface —
distill may find that the residual exposes a reframing, but a suggestion does not become the
current understanding until propose states it.

Once an experiment has been dispatched, propose owes a decision before it can choose another
experiment or conclude. Two properties make that gate a real one rather than a formality:

- **It is read off the replayed records, not off the turn.** A `set_formulation` call that was
  rejected changed nothing, so the decision remains outstanding; a call that succeeded changed the
  state the gate reads. "Which episode counts as investigated" is `latestDispatchedEpisodeOrdinal`,
  derived from the durable records, so the answer survives a reload.
- **It cannot be routed around.** Distill concluding normally hands straight to finalReport, which
  would skip propose entirely; an owed decision diverts that path back to propose instead. The gate
  also applies *during* a round, so nothing depends on the episode having closed first.

One gate carries two obligations, and they are mutually exclusive because the first requires that no
version exists and the second requires that one does:

- **Before the first reading**, publishing or deferring is owed once an experiment has been
  dispatched. A preliminary probe chosen before any reading exists is legitimate, and its `Plan`
  records `Unformed`. Nothing is owed before the first dispatch.
- **After every distillation**, a *recheck* result is owed for the round that just reported:
  `maintained`, `revised`, or `deferred`. This is the routine step made visible. Only a *changed*
  reading used to leave a record, so "I reconsidered and kept the reading" and "I never
  reconsidered" were the same absence; the record is what separates them, and it is read off the
  log rather than off loop state, so it survives a reload and a branch switch the same way the
  reading does.

The recheck answers a *round*, not the task: `FormulationRecheckRecorded` names the distilled
episode, and the next round owes its own result. A round is in scope once it has reached
distillation — a round whose experiment was interrupted before distill never produced evidence to
reconsider, and the correction gate owns that state instead. The fast path is out of scope for the
same reason: it settles through a distillation record of its own, but it has no distill role and no
adjudication to reconsider.

Three things settle a recheck, and all three are explicit answers rather than skipped steps:
`recheck_formulation` records that the reading still holds; publishing a version records `revised`
with the version that carried the change, including when it is the *first* version, since stating a
reading is itself the round's reconsideration; and deferring records `deferred`, which never erases
a version that already exists. A recheck settles only the round it answers — it does not clear an
unadjudicated belief's debt, does not stand in for the applicability review, and carries no residual.

The gate cannot be satisfied without looking at the round, but it also cannot force the look to be
honest: the reason is prose, and nothing checks that it names what the round found. That is the
accepted cost of keeping residual out of the recorded state — see
[Two outputs, one step apart](belief-loop-roles.md).

A deferral settles the first obligation only for the investigation it answered: new work re-opens
it, which is what keeps the first deferral from becoming a standing exemption.

### Publication invalidates an un-dispatched selection

Publishing a version voids any experiment that was selected but not yet dispatched: `Plan` is
written at dispatch time, so the selection's adoption can only be honest if it names the version
that was current when it was chosen. Propose must choose again, and the new selection is recorded
against the new version.

Two consequences follow directly, and both are observable in the event stream:

- Within one turn, tools run in call order. A turn that selects an experiment and then publishes a
  version ends with no selection. After a first publication, selecting again binds the new version;
  after a revision, user response and focus review must precede the new selection.
- An already-dispatched experiment is untouched. Its `Plan` and its episode's observations stay
  exactly as recorded — a reframe does not un-run what ran, nor erase the evidence it produced.

### Belief

Belief records are immutable. Status is derived from append-only provenance and
is never an independently writable field.

```cpp
struct Belief {
  BeliefId id;
  std::string statement;
  BeliefDomain domain; // Product | Code
  std::string expectation;
  uint32_t evidenceRounds;
  std::vector<SkillId> skillRefs;

  std::vector<SupportEvidence> supportedBy;
  std::vector<RefutationEvidence> refutedBy;
  std::vector<RefutationEvidence> inconclusiveBy;
  std::optional<BeliefId> supersededBy;
  bool withdrawn;
};

enum class BeliefStatus {
  Proposed,
  Supported,
  Refuted,
  Inconclusive,
  Superseded,
};
```

An inconclusive experiment does not settle the belief. Its evidence is retained
as attempt history and the same belief remains eligible for another experiment:

```text
Proposed -> Supported | Refuted | Inconclusive
Inconclusive -> Inconclusive | Supported | Refuted
Proposed | Supported | Refuted | Inconclusive -> Superseded
```

A task boundary resets the task's *focus* rather than pruning the registry. Every
Belief record is retained — supported, refuted, inconclusive, superseded, and
leftover proposed alike — and ids are never reused, so a later Task can select a
prior refutation or inconclusive judgment again. Retaining only supported records
would have made inheritance accumulate confirmations and drop counter-evidence.

The task's scope is therefore declared explicitly, by the control-only
`focus_beliefs` tool, into a `FocusSet` that is cleared at the boundary and never
inherited. The slice is runtime control state: membership never changes a
Belief's status, and it is never a Belief. It is published as the task-scoped
`FocusDeclared` event and folded onto the Task record, so a viewer can render the
task's scope without inferring it. The event's presence is the declaration, so
`beliefIds: []` means "declared, nothing in scope" — distinct from a Task that
has not declared a focus.

`activeBeliefs` remains a separate, derived record — the ids of every open
(proposed, inconclusive, or supported) Belief at the moment a delta is applied,
also used to populate `inheritedBeliefs` at `TaskOpened`. It describes what was
open, not what the task is acting on; `FocusSet` is the authoritative scope, and
an unresolved Belief outside it neither dispatches nor blocks conclusion.

Routing is not encoded as a Belief domain in the target model. A routing
decision is control metadata, not a world assertion. Its reason explains the
control decision but does not become belief evidence.

### Routing

```cpp
struct Routing {
  RoutingId id;
  std::string statement;
  RoutingDecision decision; // BeliefLoop | FastPath

  double suitabilityProbability;
  double successProbability;
  uint32_t estimatedSteps;
  RoutingDifficulty difficulty;
  std::string reason;
};
```

There is one Routing record on the outer `ExecutionEpisode`. `FastPathEpisode` does not
repeat it. Routing is written through the control-only `route_task` tool. Fast-path dispatch is
blocked while an unresolved belief *in the task's focus* remains; a belief outside the focus does
not block, and an immaterial in-focus proposal must be explicitly retracted.

### Plan

```cpp
struct Plan {
  PlanId id;
  std::vector<BeliefId> selectedToExplore;
  std::optional<std::string> intent;
  FormulationAdoption formulation; // the version this experiment was chosen under
};
```

`selectedToExplore` records the coherent beliefs chosen by propose for one execution episode.
`intent` names the task decision that episode's outcome could change ("whether to change the caller
or the adapter", not "probe belief-1"). Propose authors both through `select_experiment`, so the
intent is model-produced rather than synthesized by the GUI or the harness; it is required on that
path and the runtime only falls back to a mechanical `Probe <ids>` label when a dispatch did not
come from an explicit selection. `selectedToExplore` is a subset of the task's declared focus. Plan
is harness bookkeeping, not a separate cognitive role.

`formulation` is what makes a selection auditable against the understanding it was made under: a
plan chosen before the first version records `Unformed`, and one chosen afterwards must name the
version. Executions inherit the adoption through their `planId` rather than repeating it.

### Execution

```cpp
struct Execution {
  ExecutionId id;
  std::optional<PlanId> planId;
  std::string intention;
  std::string tool;

  JsonValue input;
  Content output;
  ExecutionStatus status;
  std::optional<std::string> error;

  // Search/display index only; not the canonical tool input.
  std::optional<std::string> filePath;
};
```

Tool input is arbitrary structured data, and output may contain text, images, or
other content blocks. A core `command: string`/`result: string` pair would lose
information. `filePath` is retained only as an optional normalized index for
file-related tools.

`planId` is required for a `BeliefLoopEpisode` execution and absent for a direct
`FastPathEpisode` execution. The runtime emits a minimal Plan occurrence selecting the coherent
belief set proposed for execution; this is harness bookkeeping, not model-generated planner prose.

### Distillation and belief deltas

```cpp
struct Distillation {
  DistillationId id;
  std::vector<ExecutionId> inputs;
  std::string contents;
  std::vector<BeliefDeltaId> outputs;
};

struct BeliefDelta {
  BeliefDeltaId id;
  EpisodeId episodeId;
  std::optional<DistillationId> distillationId;
  BeliefDeltaProducerPhase producerPhase; // Propose | Distill
  BeliefOperation operation; // Propose | Support | Refute | Refine | Inconclusive | Retract

  std::optional<BeliefId> sourceBeliefId;
  BeliefId resultBeliefId;
  std::optional<BeliefId> beliefId;
  std::optional<Belief> proposedRecord;
  std::optional<std::string> evidence;
  std::vector<Belief> resultingBeliefs;
};
```

An execution episode can contain zero or more belief deltas. `producerPhase` records whether
propose or distill emitted the mutation without relying on event order.
`sourceBeliefId` and `resultBeliefId` make refinement lineage explicit: the old
belief is the source and the replacement is the result. `proposal: string` is
insufficient because one propose/distill phase may create, settle, refine, or
retract several beliefs. Distillation output ids provide an explicit
`Execution -> Distillation -> BeliefDelta -> Belief` provenance chain.

### Steering/intervention

```cpp
struct Intervention {
  InterventionId id;
  Content contents;
  EpisodeStage stage;
  std::optional<ExecutionId> afterExecution;
  Timestamp createdAt;
};
```

Steering is a sequence, not `optional<string>`: several messages can arrive in
one episode, and their location in the execution/cognitive flow matters.

## Target versus beliefs

| Object | Meaning | Mutable? |
|---|---|---|
| `InitialPrompt` | what the user sent and what the runtime executed after expansion | no |
| `Target` | the user outcome the Task is trying to achieve | no |
| Belief | a provisional, evidence-revisable judgment about the relevant world | superseded through refinement |

Target is control context, not a belief and not a recursive completeness checklist. The default
Target statement is the effective initial prompt unless an input hook supplies a more precise
explicit outcome. A steering message that changes tactics remains an Intervention under the same
Target. A message that replaces the desired outcome closes the current Task and opens a new one.

## Task and session branching

`SessionManager` stores a tree of entries. Therefore `std::vector<Task>` is not
the durable shape of the whole session; it is the ordered projection of Tasks on
one selected branch.

The durable domain log keeps `parentId`/branch structure. Replaying a selected
branch produces `activeBranchTasks`. `Task.parentTaskId` records task-level
lineage for inspection, but does not replace the session-entry tree.

## Domain event contract

The runtime emits explicit, versioned domain events with string ids. Minimum
event vocabulary:

```text
TaskOpened
TaskClosed
TargetDefined
FocusDeclared          (task scope: the belief ids the task acts on)
TaskOutcomeRecorded    (what the task delivered, and how it was verified)

ProblemFormulationRecorded    (a complete, immutable version)
ProblemFormulationDeferred    (what is missing, and why)
FormulationRecheckRecorded    (the round's reconsideration result)
FormulationCorrectionSubmitted
FormulationCorrectionResolved

EpisodeOpened
RoutingDecided
EpisodeBodySelected
ExperimentSelected             (the choice: beliefs, intent, and the version it was made under)
ExperimentSelectionVoided      (a revision or scope change took the choice back)
EpisodeClosed
CursorChanged
InterventionAdded

BeliefDeltaApplied
PlanProduced
ExecutionStarted
ExecutionCompleted
DistillationProduced
```

Required correlation fields:

- `TaskOpened` carries `taskId`, parent/branch correlation, and the immutable
  original/effective `InitialPrompt`;
- every other Task event carries `taskId`;
- every Episode event carries `taskId` and `episodeId`;
- Plan, Execution, Distillation, Intervention, Routing, and BeliefDelta carry
  their own stable string id plus their owning/correlation ids;
- `ExecutionCompleted` carries structured output and terminal status;
- `DistillationProduced` carries explicit execution input ids and only the ids
  of deltas whose `producerPhase` is `Distill`. It is written for every round that
  reaches distill, including one that changed no belief and echoed nothing, because
  a round with no record could not be asked for a reconsideration. `contents` is the
  adjudication echo of the turn that wrote it and is empty when there was none; what
  the belief set still cannot explain stays in the distill turn's text and is not
  recorded;
- `BeliefDeltaApplied` carries the producer phase, source/result Belief ids, and
  resulting immutable record/provenance;
- `FocusDeclared` carries the task-scoped belief-id slice verbatim, replacing any
  earlier declaration, together with the current `formulation` adoption. It is emitted on the first
  declaration, a membership change, or a required version-bound review. Other restatements are no-ops;
- `TaskOutcomeRecorded` carries the task-scoped `result`/`evidence`/`blockers`.
  It is emitted only for a delivery a model recorded through `conclude` /
  `report_outcome`; the fast path's synthesized failure outcome is runtime
  bookkeeping and deliberately stays out of the event stream;
- the formulation events are task-level, not episode-level: an understanding
  outlives the rounds it was formed in. `ProblemFormulationRecorded` carries the
  complete version rather than a diff, so a replayed version is exactly what was
  published. `ProblemFormulationDeferred` carries the missing information and the
  reason. `FormulationCorrectionResolved` carries the correction id it answers,
  so resolution is addressed rather than positional. `FormulationRecheckRecorded`
  carries the round it answers, the verdict, propose's one-line reason, and the
  version when the verdict is `revised` — the round is named rather than implied so
  that "this round was reconsidered" and "no round was" are different records
  rather than the same absence;
- `ExperimentSelected` carries the choice — the belief ids, the decision they
  inform, and the `FormulationAdoption` in force when it was made — on the episode
  it belongs to. `PlanProduced` on the same episode commits that choice and clears
  it: the plan is the commitment, the selection is the choice, and the log keeps
  both so "chose E1, published v2, chose E2" replays as the sequence it was.
  `ExperimentSelectionVoided` carries the reason and is the only other way a
  selection leaves the episode state;
- `EpisodeOpened`/`EpisodeClosed` are emitted by the runtime. `PROPOSING`, a second
  plan, or a second distillation is never used by the GUI as an episode delimiter.

Display labels such as `B42`, `P-3`, or `D-7` are separate from ids and may be
derived for presentation. They never participate in correlation.

## Persistence and replay

Domain events are persisted as non-context session entries on the same branch as
the messages that caused them. They do not enter LLM context automatically.

On resume:

1. select the active session branch;
2. replay its domain events into `AgentSessionSnapshot`;
3. restore the runtime's current task/episode/belief state, including the current formulation
   version, any deferral, pending corrections, the adoption recorded on each plan or
   fast-path dispatch, and the experiment choice an open episode is still holding;
4. feed the same events/snapshot to GUI projections.

Compaction may remove messages from model context, but it must not remove domain
events required to reconstruct the active branch's Task/Episode/Belief/formulation state.
A reconnecting client that reads the snapshot and then re-subscribes must not replay a revision
twice or resume a selection the log has already superseded — the state comes from the folded
snapshot, and the events only extend it. Tree navigation inside one session file is the same
operation: the runtime replays the branch the leaf moved to before it reports any of this state,
so a client is never told the agent holds an understanding from a branch it just left.

`get_state` answers the same question for clients that want only the current reading: it carries
the active task's `FormulationState` (current version, deferral, corrections, revision review, and
whether the decision is still owed), and `get_domain_snapshot` returns the whole replayed snapshot — the
tasks, their beliefs, and the cursor — in a JSON-serializable shape.

## Protocol versioning and old logs

`AGENT_SESSION_DOMAIN_SCHEMA_VERSION` currently reads `6`. Every stored event carries the version
twice — once on the entry envelope, once on the event — and replay rejects any event whose version
is not the current one.

| Version | What it introduced | Readable by the current runtime? |
|---|---|---|
| v1 | `TaskFrame`/`frameId` execution-round vocabulary | no |
| v2 | `ExecutionEpisode`/`episodeId` (the rename) | no |
| v3 | Problem-formulation records; `FormulationAdoption` on `Plan`/`FastPathEpisode` | no |
| v4 | Experiment-selection records (`ExperimentSelected`/`ExperimentSelectionVoided`) | no |
| v5 | Version-bound user response and focus review | no |
| v6 | The per-round formulation recheck | yes |

Every bump is a rename or an addition, never a migration, and the code is deliberately written
that way:

- **No alias, no migration.** v1 event names (`FrameOpened`, `FrameBodySelected`, `FrameClosed`)
  and the v1 `frameId` field are not accepted anywhere. There is no upgrade path from a v1 log.
- **Explicit failure, not a partial replay.** An entry from an older version makes
  `domainEventsFromSessionEntries` throw a `DomainReplayError` naming the stored version and the
  required one. The alternative — skipping unreadable entries — would silently produce a history
  with missing records and no trace of why.
- **Old logs are never rewritten or deleted.** The failure happens during replay; the session
  entries on disk are left exactly as they were, so the user's own history stays intact and a
  later runtime that can read it still can.
- **Load failure is not silent.** Because replay runs in the `AgentSession` constructor, an
  unloadable session fails at load with that error rather than opening with an empty domain model.

A v2 log is rejected by a v4 runtime for a concrete reason rather than for symmetry: v2's `Plan`
carries no `FormulationAdoption`, so a replayed v2 plan is indistinguishable from one whose version
was never formed — exactly the distinction `Unformed` exists to preserve. A v3 log is rejected for
the same kind of reason: an episode in it has no way to say whether an experiment was chosen and
not yet dispatched, so replaying one would silently drop a choice the runtime was holding or
invent one it never made. A v4 log cannot attest that a revision received a user response followed
by focus review, so it is rejected by v5 rather than silently treating old scope as reviewed. A v5
log cannot attest a per-round recheck either: it records a distillation only when the round echoed
an adjudication, so a round that changed no belief is invisible in it, and nothing in it separates
"reconsidered and kept the reading" from "never reconsidered". Replaying one would read as a task
that owes a result for every round it ever ran.

### Downstream consumers

The protocol reaches every consumer of the domain event stream, and consumers are adapted
separately from the runtime:

- `gui/src/Model.cpp` and its tests still parse the pre-rename names and `frameId`. The native GUI
  is **not** compatible with a v2-or-later runtime until it is adapted, and that adaptation is not
  part of the rename itself.
- The same applies to the formulation events and the experiment-selection events: no GUI consumer
  reads `ProblemFormulationRecorded`/`ProblemFormulationDeferred`, the correction events,
  `FormulationRecheckRecorded`, or `ExperimentSelected`/`ExperimentSelectionVoided` yet. A GUI that
  keys on `frameId` also never sees a live `DistillationProduced`, because the protocol renamed it to
  `episodeId` in v2 — and once adapted, an empty `contents` now renders as a distillation that
  changed nothing rather than as a round that was never recorded.
- RPC forwards domain events unchanged, so any RPC client pattern-matching on event names needs the
  same treatment. `get_state`'s `formulation` field and the `get_domain_snapshot` command are the
  two additions a client can read without parsing the log.

## Runtime and GUI responsibilities

Runtime responsibilities:

- allocate stable ids;
- decide Task and ExecutionEpisode boundaries;
- own the session-wide Belief registry and apply validated deltas;
- emit explicit plan/execution/distillation/provenance correlations;
- record each Task's problem-formulation versions, deferrals, and corrections as they are
  published, and never rewrite or erase one;
- demand the formulation decision once an experiment has been dispatched, and void a selection
  that a new version superseded — recording the choice, the void, and the re-choice rather than
  only clearing a field;
- stop an execution round at the next tool boundary when the user corrects the task's reading,
  and hand the decision back to propose;
- persist domain events.

GUI responsibilities:

- replay events into a read-only model;
- select one Task for Text/Graph views;
- derive display-only fields such as normalized file paths, labels, layout,
  filtering, and expansion state;
- never infer cognition from generic message/tool ordering, and never infer a
  formulation version from adjacent text or role turns — read it from the record.

`GraphTaskState` remains a rendering projection. It is not the shared business
model and must not become a second source of truth.

## Invariants

1. Stable ids never change after pruning, reload, compaction, or GUI projection.
2. A closed ExecutionEpisode is immutable.
3. A closed ExecutionEpisode has exactly one classified body: belief loop or fast path.
4. Beliefs are session-wide immutable records; Tasks and Episodes reference ids.
5. Belief status is derived from provenance.
6. A Plan selects Belief ids; it does not own Beliefs.
7. Every Execution belongs to one Episode and, when applicable, one Plan.
8. Every Distillation names its Execution inputs and only its own BeliefDelta outputs.
9. Routing exists once per routed Episode and is not duplicated in FastPathEpisode.
10. Target is immutable and remains distinct from evidence-revisable world beliefs.
11. A GUI Task view contains exactly one Task's Episodes.
12. Session branching is preserved by the event tree; a Task vector is only a
    selected-branch projection.
13. A ProblemFormulationVersion is immutable once recorded, and its history is append-only and
    per-Task: a version's `previousVersionId` names the version it revised, and no version is
    inherited by another Task.
14. Every formulation source resolves to a record that already exists on the same Task.
15. A recorded `FormulationAdoption` cannot contradict the history: `Unformed` is only valid while
    the Task has no version, so a decision made under a version always names it.
16. A formulation version never carries belief status, and never counts as evidence for a belief.
17. Publishing a version leaves the focus slice, every belief record, and every already-recorded
    observation untouched; it invalidates a selection that has not been dispatched. A revision also
    requires a user response followed by explicit focus review, without forcing different belief ids.
18. Every belief-loop round that reached distillation carries a reconsideration result before
    propose chooses another experiment or concludes, and a result that keeps the reading creates no
    version. Recording one neither settles an unadjudicated belief nor answers the applicability
    review, and it never makes residual evidence for a belief.
19. A dispatch is traceable to the understanding that governed it: its plan (or, on the fast path,
    its episode) names the current version, or records that none existed.

## Current implementation notes

- Domain events are stored as `pie.agent-session-domain-event` custom session entries and replayed
  into `AgentSessionSnapshot` for the selected branch.
- The live controller still owns the operational `BeliefSet`; the replayed snapshot is a durable
  read model, not a replacement mutable store.
- `BeliefDelta.producerPhase` provides phase ownership; `Distillation.outputs`
  contains exactly the distill-produced delta ids. The optional reverse
  `BeliefDelta.distillationId` is not required for replay.
- Fast-path summaries appear both as a structured domain distillation and as the hidden
  `fast_path_distillation` custom message used for conversational continuity. That custom
  message also carries a deterministic tool-operation record (calls and their `ok`/`error`/no-result
  outcomes) so the epistemic side can cross-check what actually ran, independent of the model
  summary.
- `BeliefLoopController.publishFormulation` / `deferFormulation` /
  `submitFormulationCorrection` / `resolveFormulationCorrection` are the only writers of the
  formulation records. `currentFormulation`, `formulationDeferral`, `pendingCorrections`, and
  `formulationHistory` read them back off the replayed snapshot, so a resumed, branch-switched, or
  post-compaction session reports the same state the log does without any separate restoration
  step.
- The propose-only `set_formulation` / `defer_formulation` tools resolve the citations a model can
  actually make (the task prompt, a belief, a correction) into durable references, then delegate.
  Execution and distillation ids are not reachable from the propose transcript, so those source
  kinds stay protocol-level; confirming an experiment's result as a citation is part of the
  correction handoff, not of this surface.
- The belief surface is defined once, in `BELIEF_SURFACE_TOOLS`. The propose tool list, the
  projection that decides which calls are bookkeeping rather than observations, and the session's
  force-enabled tool list are all derived from it, because a tool missing from any one of them is
  misread rather than merely absent.
- Any GUI or external client must consume stable ids and explicit lifecycle events. It must not
  recreate episode boundaries from role or message adjacency.
