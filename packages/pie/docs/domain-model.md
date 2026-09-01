# Agent session domain model

> **Status: current runtime contract.** `agent-session-domain.ts` defines this model,
> `BeliefLoopController` emits and replays its events, and RPC forwards those events unchanged.
> GUI projections remain consumers rather than sources of truth.

## Problem and solution

Operational messages alone do not provide durable task, frame, routing, belief, execution, and
distillation identity. Inferring those objects from adjacent model turns makes phase transitions
ambiguous and couples consumers to controller implementation details.

PIE therefore emits one language-neutral domain contract with stable opaque ids and explicit
lifecycle events. The runtime is authoritative. Consumers replay the events into a read model;
they do not discover task/frame boundaries or epistemic relationships from message adjacency.

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
│  └─ ordered TaskFrame records
└─ session-wide Belief registry
```

Ownership rules:

- a Belief belongs to the session-wide registry, not to a Task or TaskFrame;
- a Task records which beliefs it inherited and introduced by id;
- a Plan selects Beliefs by id;
- a TaskFrame records Belief deltas and provenance, but never owns mutable
  Belief pointers;
- Execution and Distillation occurrences belong to exactly one TaskFrame;
- Routing belongs to the TaskFrame/Episode whose path it selected;
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
  std::vector<TaskFrame> frames;
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

struct TaskFrame {
  FrameId id;
  TaskId taskId;
  uint64_t ordinal;
  FrameStatus status;
  FrameStage stage;

  std::vector<Intervention> steering;
  std::optional<Routing> routing;
  std::variant<PendingFrame, BeliefLoopFrame, FastPathFrame> body;
};

struct PendingFrame {};

struct BeliefLoopFrame {
  std::vector<BeliefId> openBeliefsAtStart;
  Plan plan;
  std::vector<Execution> trajectory;
  std::optional<Distillation> distillation;
  std::vector<BeliefDelta> beliefDeltas;
};

struct FastPathFrame {
  std::vector<Execution> trajectory;
  std::optional<Distillation> distillation;
};
```

`PendingFrame` is legal only while an active frame is waiting for routing/path
selection. A closed frame must contain either `BeliefLoopFrame` or
`FastPathFrame`. The tagged union prevents both bodies from being present and
prevents an unclassified closed frame.

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

Task-boundary pruning removes ids from `activeBeliefs`; it does not delete
historical Belief records or reuse their ids. This preserves Task/Frame
provenance while keeping the next task's working set small.

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

There is one Routing record on the outer `TaskFrame`. `FastPathFrame` does not
repeat it. Routing is written through the control-only `route_task` tool. Fast-path dispatch is
blocked while any proposed belief remains; an immaterial proposal must be explicitly retracted.

### Plan

```cpp
struct Plan {
  PlanId id;
  std::vector<BeliefId> selectedToExplore;
  std::optional<std::string> intent;
};
```

`selectedToExplore` records the coherent beliefs chosen by propose for one execution episode.
`intent` is optional and must not be synthesized by the GUI. Plan is harness bookkeeping, not a
separate cognitive role.

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

`planId` is required for a `BeliefLoopFrame` execution and absent for a direct
`FastPathFrame` execution. The runtime emits a minimal Plan occurrence selecting the coherent
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
  FrameId frameId;
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

A frame can contain zero or more belief deltas. `producerPhase` records whether
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
  FrameStage stage;
  std::optional<ExecutionId> afterExecution;
  Timestamp createdAt;
};
```

Steering is a sequence, not `optional<string>`: several messages can arrive in
one frame, and their location in the execution/cognitive flow matters.

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

FrameOpened
RoutingDecided
FrameBodySelected
FrameClosed
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
- every Frame event carries `taskId` and `frameId`;
- Plan, Execution, Distillation, Intervention, Routing, and BeliefDelta carry
  their own stable string id plus their owning/correlation ids;
- `ExecutionCompleted` carries structured output and terminal status;
- `DistillationProduced` carries explicit execution input ids and only the ids
  of deltas whose `producerPhase` is `Distill`;
- `BeliefDeltaApplied` carries the producer phase, source/result Belief ids, and
  resulting immutable record/provenance;
- `FrameOpened`/`FrameClosed` are emitted by the runtime. `PROPOSING`, a second
  plan, or a second distillation is never used by the GUI as a frame delimiter.

Display labels such as `B42`, `P-3`, or `D-7` are separate from ids and may be
derived for presentation. They never participate in correlation.

## Persistence and replay

Domain events are persisted as non-context session entries on the same branch as
the messages that caused them. They do not enter LLM context automatically.

On resume:

1. select the active session branch;
2. replay its domain events into `AgentSessionSnapshot`;
3. restore the runtime's current task/frame/belief state;
4. feed the same events/snapshot to GUI projections.

Compaction may remove messages from model context, but it must not remove domain
events required to reconstruct the active branch's Task/Frame/Belief state.

## Runtime and GUI responsibilities

Runtime responsibilities:

- allocate stable ids;
- decide Task and TaskFrame boundaries;
- own the session-wide Belief registry and apply validated deltas;
- emit explicit plan/execution/distillation/provenance correlations;
- persist domain events.

GUI responsibilities:

- replay events into a read-only model;
- select one Task for Text/Graph views;
- derive display-only fields such as normalized file paths, labels, layout,
  filtering, and expansion state;
- never infer cognition from generic message/tool ordering.

`GraphTaskState` remains a rendering projection. It is not the shared business
model and must not become a second source of truth.

## Invariants

1. Stable ids never change after pruning, reload, compaction, or GUI projection.
2. A closed TaskFrame is immutable.
3. A closed TaskFrame has exactly one classified body: belief loop or fast path.
4. Beliefs are session-wide immutable records; Tasks and Frames reference ids.
5. Belief status is derived from provenance.
6. A Plan selects Belief ids; it does not own Beliefs.
7. Every Execution belongs to one Frame and, when applicable, one Plan.
8. Every Distillation names its Execution inputs and only its own BeliefDelta outputs.
9. Routing exists once per routed Frame and is not duplicated in FastPathFrame.
10. Target is immutable and remains distinct from evidence-revisable world beliefs.
11. A GUI Task view contains exactly one Task's Frames.
12. Session branching is preserved by the event tree; a Task vector is only a
    selected-branch projection.

## Current implementation notes

- Domain events are stored as `pie.agent-session-domain-event` custom session entries and replayed
  into `AgentSessionSnapshot` for the selected branch.
- The live controller still owns the operational `BeliefSet`; the replayed snapshot is a durable
  read model, not a replacement mutable store.
- `BeliefDelta.producerPhase` provides phase ownership; `Distillation.outputs`
  contains exactly the distill-produced delta ids. The optional reverse
  `BeliefDelta.distillationId` is not required for replay.
- Fast-path summaries appear both as a structured domain distillation and as the hidden
  `fast_path_distillation` custom message used for conversational continuity.
- Any GUI or external client must consume stable ids and explicit lifecycle events. It must not
  recreate frame boundaries from role or message adjacency.
