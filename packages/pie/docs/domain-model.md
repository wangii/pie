# Agent session domain model

> **Status: target contract; not yet implemented.** This document defines the
> shared business vocabulary and ownership rules for `packages/pie` and `gui`.
> Current runtime and GUI gaps are called out explicitly below. It does not
> describe the existing session JSONL format as if the migration had happened.

## Problem

The current implementation has three related but different models:

- `AgentSession` in `packages/pie` is an operational controller. It owns the
  agent, queues, the current role, a session-wide `BeliefSet`, and a numeric task
  counter, but it does not retain `Task` or runtime `LoopFrame` records.
- the live RPC stream calls its numeric task id `frameId` and emits phase events,
  but it does not emit a complete task/frame lifecycle;
- `NativeGuiModel` reconstructs logical LoopFrames from those phase events and
  then projects them again into `GraphTaskState`.

For example, a runtime event with `frameId = 7` means task 7. If execution later
returns to `PROPOSING`, the GUI closes its current logical frame and creates a
new synthetic frame that still belongs to runtime task 7. The same field
therefore names a task on one side and a frame on the other.

The solution is one language-neutral domain contract with stable ids and
explicit lifecycle events. The runtime remains authoritative. The GUI replays
the events into a read model; it does not discover task/frame boundaries or
epistemic relationships from event adjacency.

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
- Target is the immutable user outcome captured at task start; revisable
  completion obligations remain framing beliefs.

Cross-language and persisted records use ids, never `shared_ptr`/`unique_ptr`.
An implementation may use references internally, but pointer ownership is not
part of the domain or wire contract.

## Target read model

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
  BeliefDomain domain; // Product | Code | Framing
  std::string expectation;
  uint32_t evidenceRounds;
  std::vector<SkillId> skillRefs;

  std::vector<SupportEvidence> supportedBy;
  std::vector<RefutationEvidence> refutedBy;
  std::optional<BeliefId> supersededBy;
  bool withdrawn;
};

enum class BeliefStatus {
  Proposed,
  Supported,
  Refuted,
  Superseded,
};
```

The status transition remains monotone:

```text
Proposed -> Supported | Refuted
Proposed | Supported | Refuted -> Superseded
```

Task-boundary pruning removes ids from `activeBeliefs`; it does not delete
historical Belief records or reuse their ids. This preserves Task/Frame
provenance while keeping the next task's working set small.

Routing is not encoded as a Belief domain in the target model. A routing
decision is an action by the harness/model, not a world assertion whose evidence
is the decision itself. If an epistemic justification is needed, `Routing` may
reference supporting Belief ids.

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

  std::vector<BeliefId> supportingBeliefs;
  std::vector<BeliefId> handoffFromFramingBeliefs;
  std::string reason;
};
```

There is one Routing record on the outer `TaskFrame`. `FastPathFrame` does not
repeat it. Initial routing and a later mid-task fast-path handoff use the same
shape; the latter fills `handoffFromFramingBeliefs`.

### Plan

```cpp
struct Plan {
  PlanId id;
  std::vector<BeliefId> selectedToExplore;
  std::optional<std::string> intent;
};
```

The current planner emits only a `Batch:` list. `selectedToExplore` is therefore
authoritative; `intent` is optional and must not be synthesized by the GUI.

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
`FastPathFrame` execution. A singleton belief may skip the planner model, but
the runtime still emits a minimal Plan occurrence selecting that belief; this is
harness bookkeeping, not fabricated planner prose.

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
  BeliefOperation operation; // Propose | Support | Refute | Refine | Retract

  std::optional<BeliefId> beliefId;
  std::optional<Belief> proposedRecord;
  std::optional<std::string> evidence;
  std::vector<BeliefId> evidenceBeliefIds;
};
```

A frame can contain zero or more belief deltas. `proposal: string` is
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

## Target versus framing beliefs

`Target` and a framing Belief answer different questions:

| Object | Meaning | Mutable? |
|---|---|---|
| `InitialPrompt` | what the user sent and what the runtime executed after expansion | no |
| `Target` | the initial user outcome the Task is trying to achieve | no |
| framing Belief | the current revisable judgment of what the answer must establish | superseded through Belief refinement |

Target must not become the conclude gate. The existing framing-belief rule stays:
open framing obligations block conclusion, and supporting one requires links to
supported product/code beliefs.

The default Target statement is the effective initial prompt unless an input
hook supplies a more precise explicit outcome; creating it does not require an
extra LLM inference. A steering message that changes tactics remains an
Intervention under the same Target. A message that replaces the desired outcome
closes the current Task and opens a new one instead of mutating Target.

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
- `DistillationProduced` carries explicit execution input ids and belief-delta
  output ids;
- `BeliefDeltaApplied` carries the stable Belief id and resulting immutable
  record/provenance;
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
8. Every Distillation names its Execution inputs and BeliefDelta outputs.
9. Routing exists once per routed Frame and is not duplicated in FastPathFrame.
10. Target is immutable; revisable completion semantics live in framing beliefs.
11. A GUI Task view contains exactly one Task's Frames.
12. Session branching is preserved by the event tree; a Task vector is only a
    selected-branch projection.

## Current implementation gaps

- runtime `AgentSession` retains only the current task counter/request and a
  session-wide in-memory BeliefSet;
- belief/task/frame state is not reconstructed as a durable domain snapshot on
  session resume;
- RPC `frameId` is a numeric task id;
- the GUI allocates logical Frame ids and derives Frame boundaries;
- runtime Belief ids are remapped to numeric registry indexes for the GUI;
- GUI Belief records omit expectation, evidence, and supersession provenance;
- live Distillation input ids and belief-delta output ids are inferred or
  absent;
- fast-path planning is synthesized and fast-path distillation is a custom
  message rather than the same structured Distillation occurrence;
- `GraphTaskState` currently projects every Frame in `NativeGuiModel`, not an
  explicitly selected Task.

These gaps describe migration work. They are not permission for the GUI to
become authoritative.

## Migration order

1. Add stable id types and versioned domain-event TypeScript definitions.
2. Emit Task/Frame lifecycle and stable Belief ids without changing the GUI.
3. Persist/replay domain events into `AgentSessionSnapshot`.
4. Adapt `NativeGuiModel` to consume explicit ids and correlations; keep legacy
   demo fixtures behind an adapter during the transition.
5. Make Text/Graph views select one Task and remove synthetic Frame splitting.
6. Remove numeric Belief remapping and adjacency-based provenance inference.

Each step must keep the runtime authoritative and closed history immutable.
