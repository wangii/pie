// NativeGuiModel: a headless, testable mirror of the runtime's agent-session
// domain state (schema v7).
//
// Every struct below names its TypeScript counterpart in
// `packages/pie/src/core/agent-session-domain.ts` so drift is visible in review.
// The GUI is a read-only projection: it replays the explicit domain events the
// runtime emits and never infers stage, cursor, episode boundaries, or
// epistemic meaning from generic log adjacency (docs/milestones.md §3.7).
//
// ---------------------------------------------------------------------------
// APPLIER CONTRACT (docs/milestones.md §5.3) — read before adding an applier.
// ---------------------------------------------------------------------------
// The domain snapshot and the live event stream NECESSARILY overlap: the
// runtime computes the snapshot at the moment it handles the command, while the
// GUI has already received (or is about to receive) the events on both sides of
// that moment. `RpcDomainSnapshot` carries no cursor and no event id, so eventId
// dedup cannot reconcile the two.
//
// Therefore every applier is a pure function f(state, event): no counters, no
// accumulators, keyed on the record id it writes. Its behaviour is exactly one
// of
//   * "that record already exists and agrees" -> no-op, or
//   * field-level last-write-wins.
// Display labels are computed at render time from record order (see
// beliefLabel()), NEVER accumulated — an accumulator drifts on reconnect.
// This is not an invention: it is how the TypeScript `DOMAIN_EVENT_APPLIERS`
// are already written.
//
// Where the TypeScript fold calls `fail(...)`, this mirror records a
// ReplayIssue rather than throwing. The GUI must neither crash on a log the
// runtime itself would reject nor swallow it silently, so the trace panel
// surfaces the issue count. It deliberately does NOT mirror "abort on first
// error".
//
// The mirror draws a line the TypeScript fold does not need to draw, because
// `fail` is all-or-nothing there. Three cases, in the order each applier must
// check them:
//
//   1. RECORD-KEYED WRITE, already present -> SILENT NO-OP when the replay
//      agrees, issue when it contradicts. This is the snapshot/stream overlap
//      case and it must be silent: an identical replay is not a problem to
//      report. Checked BEFORE any precondition, because on a full replay the
//      state has already moved past the event and a precondition-first order
//      would raise a phantom issue for every line.
//   2. INVARIANT VIOLATION -> issue + NO-OP. Applying would break the stored
//      state's own rules: a non-consecutive ordinal, a broken previousVersionId
//      chain, a belief delta that does not carry its own result, a write to a
//      closed episode. The record is not written — which is what makes a closed
//      episode immutable rather than merely discouraged.
//   3. DANGLING CITATION -> issue + STILL APPLY. The event names something this
//      projection has no record of (an unknown parent task, inherited belief,
//      belief source, formulation version). The reference is display-only, so
//      dropping the record would hide the runtime's own state from the user — the
//      opposite of what a debugger is for.
//
// Two categories are deliberately SILENT, because a full replay cannot tell them
// apart from a legitimate arrival and reporting them would bury the real issues:
//   * STALENESS — an event that was valid when emitted but is no longer current
//     (an approval of a version a later publication replaced, a claim of
//     `unformed` made before a version existed). Refusing it is a no-op and the
//     state still converges.
//   * LAST-WRITE-WINS FIELDS that carry no record id (the cursor, the declared
//     focus, the experiment selection, activeBeliefs). There is no key to test
//     for "already applied", so the value is written and nothing is judged.
//
// Nothing throws, and nothing is silently DROPPED: every case above either
// writes the record or raises an issue.
//
// THE DUPLICATE PATH MUST STILL RECONCILE. Case 1 returning early is right for
// the record it writes, and wrong for anything else the applier derives from it.
// An applier's side effects are INVARIANTS, not extras: "a plan exists implies no
// selection is pending" (`PlanProduced` resetting `experimentSelection`) and "a
// closed episode implies the cursor has moved past it" (`EpisodeClosed`) both hold
// of the terminal state no matter which order the events arrived in. A replayed
// `ExperimentSelected` can put a selection back after the snapshot already
// contained the plan, so skipping the reset on the duplicate path leaves the SAME
// log ending in two different states depending on what the snapshot happened to
// contain — the exact order-dependence the bootstrap exists to eliminate.
//
// This is not theoretical: it was found by Bootstrap.test.cpp's
// snapshot-then-every-event-replayed case, which is the only test that can see it.
// When adding an applier with a side effect beyond its own record, check that the
// duplicate path performs it too.

#pragma once

#include <cstddef>
#include <cstdint>
#include <map>
#include <optional>
#include <set>
#include <string>
#include <string_view>
#include <vector>

#include "FileList.h"
#include "Json.h"

namespace pie::gui {

// Defined in DomainEvents.h. Forward-declared so this header does not depend on
// the wire vocabulary: the model is the state, the events are how it arrives.
// (Json.h is included rather than forward-declared because `applyRpcLine` takes a
// `json::Value` by reference and the reader thread hands the model a parsed DOM.)
struct DomainEvent;

// ---------------------------------------------------------------------------
// Stable domain ids (TS: every `export type XId = string`)
//
// Opaque strings emitted verbatim by the runtime. The GUI never remaps an id to
// an integer index (docs/milestones.md §5.2): a display label is derived at
// render time and is never used for correlation.
// ---------------------------------------------------------------------------
using Id = std::string;
using SessionId = Id;
using TaskId = Id;
using PromptId = Id;
using TargetId = Id;
using EpisodeId = Id;
using RoutingId = Id;
using BeliefId = Id;
using BeliefDeltaId = Id;
using PlanId = Id;
using ExecutionId = Id;
using DistillationId = Id;
using InterventionId = Id;
using FormulationVersionId = Id;
using FormulationCorrectionId = Id;
using DomainEventId = Id;

// TS: AGENT_SESSION_DOMAIN_SCHEMA_VERSION
inline constexpr int kAgentSessionDomainSchemaVersion = 7;

// Display-layer truncation of `Execution.output` (docs/milestones.md §5.1). A
// tool output can be several megabytes; keeping it whole would make a long
// session's snapshot occupy tens of MB, so the model stores a preview plus the
// original byte count. This is a DISPLAY cap, not a domain fact.
inline constexpr size_t kExecutionOutputPreviewChars = 2000;

// ---------------------------------------------------------------------------
// Wire enums (TS: the string-literal union types)
// ---------------------------------------------------------------------------

// TS: TaskStatus
enum class TaskStatus { Active, Completed, Cancelled, Failed, Unknown };
// TS: EpisodeStatus
enum class EpisodeStatus { Active, Closed, Unknown };
// TS: EpisodeStage
enum class EpisodeStage { Routing, Proposing, Executing, Distilling, Closed, Unknown };
// TS: EpisodeBodyKind
enum class EpisodeBodyKind { Pending, BeliefLoop, FastPath };
// TS: BeliefDomain
enum class BeliefDomain { Product, Code, Unknown };
// TS: BeliefStatus
enum class BeliefStatus { Proposed, Supported, Refuted, Inconclusive, Superseded };
// TS: BeliefOperation
enum class BeliefOperation { Propose, Support, Refute, Refine, Inconclusive, Retract, Unknown };
// TS: BeliefDeltaProducerPhase
enum class BeliefDeltaProducerPhase { Propose, Distill, Unknown };
// TS: RoutingDecision
enum class RoutingDecision { BeliefLoop, FastPath, Unknown };
// TS: RoutingDifficulty
enum class RoutingDifficulty { Low, Medium, High, Unknown };
// TS: ExecutionStatus
enum class ExecutionStatus { Running, Succeeded, Failed, Cancelled, Unknown };
// TS: FormulationCorrectionStatus
enum class FormulationCorrectionStatus { Pending, Resolved, Unknown };
// TS: FormulationRecheckVerdict
enum class FormulationRecheckVerdict { Maintained, Revised, Deferred, Unknown };
// TS: FormulationApplicabilityDecision
enum class FormulationApplicabilityDecision { CarriesOver, NotApplicable, NeedsRevalidation, Unknown };
// TS: FormulationSource["kind"]
enum class FormulationSourceKind { Prompt, Intervention, Correction, Execution, Distillation, Belief, Unknown };
// TS: FormulationAdoption["kind"] — `Unformed` is a RECORDED FACT ("no version
// existed at that moment"), not a missing field (docs/milestones.md §5.2).
enum class FormulationAdoptionKind { Version, Unformed };

// The wire spelling for each enum value, so the display layer never re-invents
// a literal and a typo cannot silently become a distinct state.
const char* toString(TaskStatus v);
const char* toString(EpisodeStatus v);
const char* toString(EpisodeStage v);
const char* toString(EpisodeBodyKind v);
const char* toString(BeliefDomain v);
const char* toString(BeliefStatus v);
const char* toString(BeliefOperation v);
const char* toString(BeliefDeltaProducerPhase v);
const char* toString(RoutingDecision v);
const char* toString(RoutingDifficulty v);
const char* toString(ExecutionStatus v);
const char* toString(FormulationCorrectionStatus v);
const char* toString(FormulationRecheckVerdict v);
const char* toString(FormulationApplicabilityDecision v);
const char* toString(FormulationSourceKind v);

// ---------------------------------------------------------------------------
// Belief (TS: Belief) — an immutable domain record
//
// `status` is NOT stored: the contract derives it from provenance, with the
// precedence superseded > refuted > supported > inconclusive > proposed
// (TS: statusOfDomainBelief).
// ---------------------------------------------------------------------------
struct Belief {
    BeliefId id;
    std::string statement;
    BeliefDomain domain = BeliefDomain::Unknown;
    std::string expectation;
    int evidenceRounds = 0;
    std::vector<std::string> skillRefs;
    // TS: readonly SupportEvidence[] / RefutationEvidence[] — each record has the
    // single `evidence` field, so it is flattened to that string.
    std::vector<std::string> supportedBy;
    std::vector<std::string> refutedBy;
    std::vector<std::string> inconclusiveBy;
    std::optional<BeliefId> supersededBy;
    bool withdrawn = false;

    // Derived, never stored. TS: statusOfDomainBelief.
    BeliefStatus status() const;
};

// TS: SupportEvidence / RefutationEvidence — one field, so the readers return
// the evidence strings directly.
struct Routing {
    RoutingId id;
    std::string statement;
    RoutingDecision decision = RoutingDecision::Unknown;
    double suitabilityProbability = 0.0;
    double successProbability = 0.0;
    int estimatedSteps = 0;
    RoutingDifficulty difficulty = RoutingDifficulty::Unknown;
    std::string reason;
    // When the event that created this record was observed. -1 when the record
    // came from a snapshot, which carries no per-record time. The graph orders a
    // row by this when present and falls back to record order when absent.
    int64_t occurredAtMs = -1;
};

// TS: TaskOutcome — a task result, not a world belief. Epistemic sufficiency and
// task completion are separate judgments.
struct TaskOutcome {
    std::string result;
    std::string evidence;
    std::string blockers;
    // Display convenience: an outcome with no result is not a recorded outcome.
    bool present() const { return !result.empty(); }
};

// TS: InitialPrompt. `original`/`effective` are DomainContent (`string |
// JsonValue[]`); the GUI renders prose, so the array form is flattened to its
// concatenated text at parse time.
struct InitialPrompt {
    PromptId id;
    std::string original;
    std::string effective;
};

// TS: Target
struct Target {
    TargetId id;
    std::string statement;
};

// ---------------------------------------------------------------------------
// Problem formulation (the product-facing name is "Frame")
// ---------------------------------------------------------------------------

// TS: FormulationContent. `interpretation`, `focus`, and `implication` are
// required by the contract; `alternative` and `tension` are optional and a
// present-but-blank one is refused at the tool, so an absent optional here means
// the agent had nothing to say rather than that the field was dropped.
struct FormulationContent {
    std::string interpretation;
    std::optional<std::string> alternative;
    std::string focus;
    std::optional<std::string> tension;
    std::string implication;
};

// TS: FormulationSource — a 6-variant union, flattened to one record with a
// `kind` discriminator (docs/milestones.md §5.2). Only the fields the kind names
// are populated: a belief source is always cited together with the delta that
// recorded the belief's state at the time.
struct FormulationSource {
    FormulationSourceKind kind = FormulationSourceKind::Unknown;
    PromptId promptId;
    InterventionId interventionId;
    FormulationCorrectionId correctionId;
    ExecutionId executionId;
    DistillationId distillationId;
    BeliefId beliefId;
    BeliefDeltaId beliefDeltaId;
};

// TS: FormulationOrigin — only propose publishes a formulation.
inline constexpr const char* kFormulationOriginPropose = "propose";

// TS: ProblemFormulationVersion — append-only; a revision is a new version
// pointing back at its predecessor, never an edit of one.
struct ProblemFormulationVersion {
    FormulationVersionId id;
    TaskId taskId;
    uint64_t ordinal = 0;
    std::optional<FormulationVersionId> previousVersionId;
    std::string recordedAt;
    // The ordinal of the episode the version was formed in, or 0 when none was open. Recorded
    // by the runtime at publication; the canvas reads it to place the Frame between rows
    // instead of inferring a position from the version's citations.
    uint64_t formedInEpisodeOrdinal = 0;
    std::string origin;
    FormulationContent content;
    std::string reason;
    std::vector<FormulationSource> sources;
};

// TS: FormulationDeferral — "investigated and deferred" is a state in its own
// right, distinct from "not investigated", and it never erases a version.
struct FormulationDeferral {
    std::string missingInformation;
    std::string reason;
    std::vector<FormulationSource> sources;
    std::string deferredAt;
    // Derived by the fold from the task, never read off the event (a client must
    // not be able to assert it wrong).
    uint64_t answeredThroughEpisodeOrdinal = 0;
};

// TS: FormulationCorrection — kept as its own record so the published version
// stays the agent's own stated position and the user's objection stays
// auditable beside it.
struct FormulationCorrection {
    FormulationCorrectionId id;
    TaskId taskId;
    std::optional<FormulationVersionId> targetVersionId;
    std::string original;
    std::string receivedAt;
    FormulationCorrectionStatus status = FormulationCorrectionStatus::Unknown;
    std::optional<std::string> response;
    std::optional<FormulationVersionId> recordedVersionId;
};

// TS: FormulationAdoption — the version a decision was made under.
struct FormulationAdoption {
    FormulationAdoptionKind kind = FormulationAdoptionKind::Unformed;
    FormulationVersionId versionId;
    static FormulationAdoption unformed() { return FormulationAdoption{}; }
    static FormulationAdoption version(FormulationVersionId id) {
        FormulationAdoption a;
        a.kind = FormulationAdoptionKind::Version;
        a.versionId = std::move(id);
        return a;
    }
};

// TS: FormulationApplicabilityEntry — what a revision means for one belief that
// was already in scope. The belief's own evidence and status are untouched.
struct FormulationApplicabilityEntry {
    BeliefId beliefId;
    FormulationApplicabilityDecision decision = FormulationApplicabilityDecision::Unknown;
    std::string reason;
    // Set by the fold once a delta re-examined a `needs-revalidation` belief.
    std::optional<BeliefDeltaId> revalidatedByDeltaId;
    // Set by the fold when a `not-applicable` belief is declared back into focus:
    // the decision then describes a scope the task no longer holds, so it stops
    // counting and the belief is owed a new one.
    bool stale = false;
};

// TS: FormulationApproval — bound to a version id, so it can never carry over to
// a reading published after it.
struct FormulationApproval {
    FormulationVersionId versionId;
    std::string approvedAt;
};

// TS: FormulationReview
struct FormulationReview {
    FormulationVersionId versionId;
    std::optional<FormulationCorrectionId> responseCorrectionId;
    std::optional<FormulationApproval> approval;
    bool focusReviewed = false;
    std::vector<BeliefId> scopedBeliefIds;
    size_t introducedAtRevision = 0;
    std::vector<FormulationApplicabilityEntry> applicability;
};

// TS: FormulationRecheck — the routine per-round step, recorded rather than
// inferred, so "kept the reading" and "never reconsidered" are not the same
// absence in the log.
struct FormulationRecheck {
    EpisodeId episodeId;
    FormulationRecheckVerdict verdict = FormulationRecheckVerdict::Unknown;
    std::string reason;
    std::optional<FormulationVersionId> versionId;
    std::string recordedAt;
};

// ---------------------------------------------------------------------------
// Episode contents
// ---------------------------------------------------------------------------

// TS: Plan
struct Plan {
    PlanId id;
    std::vector<BeliefId> selectedToExplore;
    std::optional<std::string> intent;
    // TS: advancement (AdvancementIntent) — the agent's own words about what it
    // is doing and would do next. Display only; it dispatches nothing.
    std::optional<std::string> advancementAction;
    std::optional<std::string> advancementCondition;
    std::optional<std::string> advancementNext;
    // Which formulation version this experiment was chosen under.
    FormulationAdoption formulation;
    bool valid() const { return !id.empty(); }
    // Event-observed creation time; -1 for a snapshot-loaded record. See Routing.
    int64_t occurredAtMs = -1;
};

// TS: ExperimentSelectionRecord — a choice, not a commitment: it can be voided
// before anything runs, and that void is itself a fact worth replaying.
struct ExperimentSelectionRecord {
    std::string intent;
    std::vector<BeliefId> beliefIds;
    std::optional<std::string> advancementAction;
    std::optional<std::string> advancementCondition;
    std::optional<std::string> advancementNext;
    FormulationAdoption formulation;
    // Event-observed creation time; -1 for a snapshot-loaded record. See Routing.
    int64_t occurredAtMs = -1;
};

// TS: Execution
struct Execution {
    ExecutionId id;
    // Absent for a fast-path execution: the fast path has no plan. Its absence
    // also makes "the belief-loop body has a plan" a checkable invariant.
    std::optional<PlanId> planId;
    std::string intention;
    std::string tool;
    // TS: input (JsonValue) — summarized to one readable line for display; the
    // raw value is not retained (nothing downstream reads it).
    std::string inputSummary;
    // TS: output (DomainContent) — DISPLAY-TRUNCATED to
    // kExecutionOutputPreviewChars; `outputBytes` is the untruncated byte count.
    std::string outputPreview;
    size_t outputBytes = 0;
    ExecutionStatus status = ExecutionStatus::Running;
    std::optional<std::string> error;
    std::optional<std::string> filePath;
    // UI-side expand/collapse state for the graph tooltip.
    bool expanded = true;
    // Event-observed START time; -1 for a snapshot-loaded record. A completion
    // event must not overwrite this: the node's place is where the execution
    // began, not where it finished. See Routing.
    int64_t occurredAtMs = -1;
};

// TS: Distillation
struct Distillation {
    DistillationId id;
    std::vector<ExecutionId> inputs;
    std::string contents;
    std::vector<BeliefDeltaId> outputs;
    bool valid() const { return !id.empty(); }
    // Event-observed creation time; -1 for a snapshot-loaded record. See Routing.
    int64_t occurredAtMs = -1;
};

// TS: BeliefDelta — the only writer of the belief registry.
struct BeliefDelta {
    BeliefDeltaId id;
    EpisodeId episodeId;
    std::optional<DistillationId> distillationId;
    // Cognitive phase that produced this mutation; never inferred from event
    // order.
    BeliefDeltaProducerPhase producerPhase = BeliefDeltaProducerPhase::Unknown;
    BeliefOperation operation = BeliefOperation::Unknown;
    // Existing belief read or replaced by this mutation.
    std::optional<BeliefId> sourceBeliefId;
    // Canonical belief written by this mutation. For refine, this is the new
    // record.
    BeliefId resultBeliefId;
    std::optional<BeliefId> beliefId;
    std::optional<std::string> evidence;
    // Complete immutable records changed by this operation, including both sides
    // of a refinement.
    std::vector<Belief> resultingBeliefs;
    // Event-observed creation time; -1 for a snapshot-loaded record. See Routing.
    int64_t occurredAtMs = -1;
};

// TS: Intervention
struct Intervention {
    InterventionId id;
    std::string contents;
    EpisodeStage stage = EpisodeStage::Unknown;
    std::optional<ExecutionId> afterExecution;
    std::string createdAt;
    // Event-observed creation time; -1 for a snapshot-loaded record. See Routing.
    int64_t occurredAtMs = -1;
};

// TS: EpisodeBody = PendingEpisode | BeliefLoopEpisode | FastPathEpisode
//
// One record discriminated by `kind`, with only the matching fields populated
// (docs/milestones.md §5.2). `Pending` fills nothing.
struct EpisodeBody {
    EpisodeBodyKind kind = EpisodeBodyKind::Pending;
    // belief-loop only
    std::vector<BeliefId> openBeliefsAtStart;
    std::optional<Plan> plan;
    std::vector<BeliefDelta> beliefDeltas;
    // fast-path only: the fast path has no Plan to carry the adoption, so the
    // episode records it directly and `unformed` is the honest record for a
    // first investigation.
    std::optional<FormulationAdoption> formulation;
    // both
    std::vector<Execution> trajectory;
    std::optional<Distillation> distillation;
};

// TS: ExecutionEpisode — one execution round. Not the agent's problem
// formulation: `stage`/`status` describe where a round is in the loop, and
// `proposing`/`distilling` name the roles that owned the round.
struct ExecutionEpisode {
    EpisodeId id;
    TaskId taskId;
    uint64_t ordinal = 0;
    EpisodeStatus status = EpisodeStatus::Active;
    EpisodeStage stage = EpisodeStage::Routing;
    // When the round opened, observed from EpisodeOpened. -1 when the record came
    // from a snapshot, which carries no per-record time. The task-level layout
    // merges episodes and Frame versions on one vertical time axis by this value.
    int64_t occurredAtMs = -1;
    std::vector<Intervention> steering;
    std::optional<Routing> routing;
    // The choice propose has made and not yet dispatched; cleared when a plan
    // commits it and by an explicit void.
    std::optional<ExperimentSelectionRecord> experimentSelection;
    EpisodeBody body;

    const Execution* execution(const ExecutionId& id) const;
    const BeliefDelta* beliefDelta(const BeliefDeltaId& id) const;
    const Distillation* distillation() const {
        return body.distillation.has_value() ? &*body.distillation : nullptr;
    }
    const Plan* plan() const { return body.plan.has_value() ? &*body.plan : nullptr; }
};

// TS: Task
struct Task {
    TaskId id;
    std::optional<TaskId> parentTaskId;
    InitialPrompt initialPrompt;
    std::optional<Target> initialTarget;
    TaskStatus status = TaskStatus::Active;
    std::vector<BeliefId> inheritedBeliefs;
    std::vector<BeliefId> introducedBeliefs;
    std::vector<ExecutionEpisode> episodes;
    // Scope, not truth: membership never changes a belief's status, and the
    // slice is never inherited from the parent task. `focusDeclared` separates
    // "declared, and the slice is empty" from "not declared yet".
    std::vector<BeliefId> focus;
    bool focusDeclared = false;
    std::optional<FormulationReview> formulationReview;
    std::optional<TaskOutcome> taskOutcome;
    // This task's formulation history, oldest first. Append-only and never
    // inherited: a new task starts empty because its understanding of its own
    // request is its own.
    std::vector<ProblemFormulationVersion> formulations;
    std::optional<FormulationDeferral> formulationDeferral;
    std::vector<FormulationCorrection> formulationCorrections;
    std::optional<FormulationRecheck> formulationRecheck;

    const ExecutionEpisode* episode(const EpisodeId& id) const;
    // True when the declared focus contains `id`. Undeclared answers false:
    // nothing is in scope until the task says so.
    bool inFocus(const BeliefId& id) const;
    bool hasIntroduced(const BeliefId& id) const;
};

// TS: AgentSessionCursor
struct AgentSessionCursor {
    TaskId taskId;
    EpisodeId episodeId;
    EpisodeStage stage = EpisodeStage::Unknown;
    bool valid() const { return !episodeId.empty(); }
};

// TS: AgentSessionSnapshot — the replayed whole state. `agent-session-domain.ts`
// holds `tasks`/`beliefs` as Maps, whose iteration order is insertion order; the
// explicit `*Order` vectors preserve that, because belief display labels are
// derived from record order (docs/milestones.md §5.3).
struct AgentSessionSnapshot {
    SessionId id;
    std::vector<TaskId> activeBranchTasks;
    std::map<TaskId, Task> tasks;
    std::vector<TaskId> taskOrder;
    std::map<BeliefId, Belief> beliefs;
    std::vector<BeliefId> beliefOrder;
    std::vector<BeliefId> activeBeliefs;
    std::optional<AgentSessionCursor> cursor;

    const Task* task(const TaskId& id) const;
    const Belief* belief(const BeliefId& id) const;
    // Record-order position of a belief, or npos when unknown. This is what a
    // display label ("B7") is derived from.
    static constexpr size_t npos = static_cast<size_t>(-1);
    size_t beliefIndex(const BeliefId& id) const;
};

// A fold step the TypeScript applier would `fail(...)` on, or a wire line this
// mirror could not read. Recorded rather than thrown (see the applier contract
// at the top of this file). The trace panel renders the count and the details.
struct ReplayIssue {
    std::string eventType;
    std::string eventId;
    std::string message;
};

// ---------------------------------------------------------------------------
// Pure derivations over replayed state (TS: the free functions in
// agent-session-domain.ts). No accumulator, no cached ordinal: each is computed
// from the records, so a reconnect cannot make it drift.
// ---------------------------------------------------------------------------

// TS: currentFormulation — this task's current understanding, or nullptr before
// the first version.
const ProblemFormulationVersion* currentFormulation(const Task& task);
// TS: pendingFormulationCorrections — oldest first.
std::vector<const FormulationCorrection*> pendingFormulationCorrections(const Task& task);
// TS: latestDispatchedEpisodeOrdinal — the highest episode ordinal that had an
// experiment dispatched, or nullopt. "Dispatched" is read off the durable
// records: a belief-loop episode records it in its Plan, a fast-path episode in
// its body selection. Routing alone does not count.
std::optional<uint64_t> latestDispatchedEpisodeOrdinal(const Task& task);
// TS: latestFormulationAdoption — the understanding the most recent dispatched
// round was chosen under.
std::optional<FormulationAdoption> latestFormulationAdoption(const Task& task);
// TS: latestDistilledEpisode
const ExecutionEpisode* latestDistilledEpisode(const Task& task);
// TS: applicabilityComplete — every belief a review has to account for has a
// decision that still counts.
bool applicabilityComplete(const FormulationReview& review);
// TS: pendingApplicabilityBeliefs
std::vector<BeliefId> pendingApplicabilityBeliefs(const Task& task);
// TS: unrevalidatedApplicability
std::vector<const FormulationApplicabilityEntry*> unrevalidatedApplicability(const Task& task);
// TS: firstFormulationDecisionOwed / formulationRecheckOwed / formulationDecisionOwed
bool firstFormulationDecisionOwed(const Task& task);
bool formulationRecheckOwed(const Task& task);
bool formulationDecisionOwed(const Task& task);

// ---------------------------------------------------------------------------
// RPC telemetry (session_status / message_*), independent of the domain schema
// ---------------------------------------------------------------------------

// One belief-loop role slot from `session_status.roleStatus`. There is no
// `finalReport` slot, no thinking level, and no timing (docs/milestones.md
// §3.6), and getRoleStatus() returns undefined before the belief set is usable —
// so a missing value renders as "—" and never as a mismatch.
struct RoleFooterSlot {
    std::string model;           // "provider/id"
    float cacheHitRate = -1.0f;  // percentage, or negative when undefined
};

// Per-role context usage. tokens/percent are negative when the runtime reports
// null (unknown).
struct RoleContextUsage {
    long tokens = -1;
    long contextWindow = 0;
    double percent = -1.0;
    bool valid() const { return tokens >= 0; }
};

struct RoleContextUsagePair {
    RoleContextUsage epistemic;
    RoleContextUsage execution;
    bool hasData = false;
};

struct Footer {
    RoleFooterSlot epistemic;    // propose
    RoleFooterSlot distillation; // distill
    RoleFooterSlot execution;
    double sessionCost = 0.0;
    bool hasData = false;
};

// ---------------------------------------------------------------------------
// Dispatch trace telemetry (docs/milestones.md §7.3)
//
// The trace pane's raw material, and the second thing in this model that is
// OBSERVED rather than replayed (the first is SessionState). `message_start`,
// `message_end` and `session_status` carry no eventId, appear in no snapshot,
// and cannot be reconstructed from the domain log — so a reconnect starts this
// log empty. The pane says "no telemetry" rather than rendering a gap as a
// mismatch, which §10 names as the risk: a missing value must never be presented
// as a fact about the runtime.
//
// The model only RECORDS here. What constitutes one row, which column comes from
// which entry, and how a duration is computed are TraceModel's job.
// ---------------------------------------------------------------------------

// TS: message.usage — token accounting as the provider reported it. Negative is
// "not reported", never zero.
struct TurnUsage {
    long input = -1;
    long output = -1;
    long cacheRead = -1;
    long cacheWrite = -1;
    bool any() const {
        return input >= 0 || output >= 0 || cacheRead >= 0 || cacheWrite >= 0;
    }
    // Derived cache hit rate, for when the runtime's roleStatus telemetry has not
    // caught up (§7.3: "telemetry 滞后时可自行计算"). Negative when the components
    // are unknown: a rate needs a denominator, and "0%" is a claim.
    float cacheHitRate() const;
};

// One observed wire fact, in arrival order. `kind` says which fields are live —
// the same discriminated-record shape EpisodeBody and FormulationSource use.
struct TraceEntry {
    enum class Kind {
        Domain,  // one of the 25 domain events (DOMAIN_EVENT_APPLIERS)
        Turn,    // one assistant turn: opened by message_start, closed by message_end
        Status,  // session_status, recorded only when a slot CHANGED
    };
    Kind kind = Kind::Domain;

    std::string type;   // the wire `type`, verbatim
    std::string at;     // the entry's own timestamp, "" when the line carries none
    int64_t atMs = -1;  // the same as epoch milliseconds, when parseable
    TaskId taskId;
    EpisodeId episodeId;

    // --- Kind::Domain ---------------------------------------------------
    // The stage the cursor entered, for the only two events that move it:
    // `CursorChanged` (by its own `stage`) and `EpisodeClosed` (which the fold
    // applies as `closed`). Unknown for every other event — a stage is a fact
    // these two carry, and inferring one from adjacency is forbidden (§3.7).
    EpisodeStage stage = EpisodeStage::Unknown;
    // One-line rendering for the detail column.
    std::string text;

    // --- Kind::Turn -----------------------------------------------------
    bool ended = false;         // false: message_end never arrived
    std::string model;          // TS: message.model.id — the model that ACTUALLY ran
    std::string provider;       // TS: message.model.provider
    std::string thinkingLevel;  // TS: message.providerThinkingLevel
    std::string stopReason;     // TS: message.stopReason
    std::string errorMessage;   // TS: message.errorMessage
    std::string endedAt;
    int64_t endedAtMs = -1;
    TurnUsage usage;

    // --- Kind::Status ---------------------------------------------------
    // The role slots in force, copied from `session_status.roleStatus`. The line
    // is emitted after every event, so an entry is appended only when a slot
    // changes: an identical repeat carries nothing a row could read.
    RoleFooterSlot epistemic, distillation, execution;
};

// ---------------------------------------------------------------------------
// Runtime session state (the `get_state` response)
//
// This is the ONE part of the model that is not replayed: `RpcSessionState` is
// what the runtime can attest about *itself* right now, and the domain log
// cannot express it. Two facts in particular live only here:
//
//   * `formulation.resume` — whether the turn an approval started actually ran.
//     Replaying the log restores the approval, not the delivery of the turn that
//     followed it (agent-session-domain.ts, FormulationResumeState).
//   * `formulation.decisionOwed` / `recheckOwed` — computed by the runtime from
//     its own state, and authoritative over anything the GUI derives.
//
// Because of that, §5.3 requires the response to be held until the snapshot has
// been applied: an event-only projection must never overwrite these. See
// Bootstrap.
// ---------------------------------------------------------------------------

// TS: FormulationResumeState
enum class FormulationResumePhase { Started, Settled, Failed, Unknown };
const char* toString(FormulationResumePhase v);

struct FormulationResumeState {
    FormulationVersionId versionId;
    FormulationResumePhase phase = FormulationResumePhase::Unknown;
    // Set only when phase is Failed.
    std::optional<std::string> reason;
};

// TS: FormulationState — the runtime's own summary of the active task's
// understanding. A *mirror*, not a second fold: nothing here is recomputed from
// events, and the GUI's own derivations (currentFormulation, the *Owed helpers)
// remain the source for everything the log can answer. Where the two disagree
// the runtime wins, which is the whole reason this is carried separately.
struct FormulationState {
    std::optional<FormulationReview> review;
    // Null before the first published version.
    std::optional<ProblemFormulationVersion> current;
    std::optional<FormulationDeferral> deferral;
    std::vector<FormulationCorrection> corrections;
    bool decisionOwed = false;
    bool recheckOwed = false;
    std::optional<FormulationRecheck> recheck;
    // The run is paused while this is true, and only `approve_frame` (or an
    // objection) clears it.
    bool awaitingResponse = false;
    bool approved = false;
    std::optional<FormulationResumeState> resume;
    std::vector<BeliefId> pendingApplicability;
    std::vector<BeliefId> unrevalidated;
};

// TS: RpcSessionState — the session-level half; `formulation` is the task-level
// half above and is null when no task is open.
struct SessionState {
    // False until a `get_state` response has been applied. A default-constructed
    // SessionState is "not yet known", which is NOT the same as a state whose
    // every field is at its default — the panels must render "—", never a value.
    bool present = false;
    SessionId sessionId;
    std::string sessionFile;
    std::string sessionName;
    // TS: ThinkingLevel — informational here. Per-role thinking levels are
    // configured but never emitted (docs/milestones.md §3.6), so this session
    // value is the only one available and the trace panel labels it as such.
    std::string thinkingLevel;
    bool isStreaming = false;
    bool isCompacting = false;
    // Session-scoped auto-approval of published readings. `autoApproveKnown`
    // separates "the runtime said off" from "the runtime did not say": the pane
    // renders the second as a disabled toggle, never as off. Every other fact the
    // Frame pane reads is derived from the domain log; this one is not — the
    // approval the toggle causes is recorded as an ordinary `FormulationApproved`,
    // so a reading approved automatically and one approved by hand replay alike.
    bool autoApproveKnown = false;
    bool autoApproveFrame = false;
    long messageCount = 0;
    long pendingMessageCount = 0;
    std::optional<FormulationState> formulation;
};

// The model: a v7 snapshot mirror plus the RPC telemetry the panels read.
class NativeGuiModel {
public:
    // Apply one domain event. Returns true when the event type was recognized
    // (even if the applier no-opped); false for a non-domain event.
    bool applyDomainEvent(const DomainEvent& event);

    // Replace the whole domain state from a `get_domain_snapshot` payload. This
    // is an integral replacement, not a merge: the snapshot is what the state
    // IS at the moment of connecting (docs/milestones.md §5.3).
    void applyDomainSnapshot(const AgentSessionSnapshot& snapshot);

    // Apply a `get_state` response. Must be called AFTER any snapshot the same
    // bootstrap produced, and never by an event-only run — see Bootstrap and the
    // SessionState comment above.
    void applySessionState(SessionState state);
    const SessionState& sessionState() const { return sessionState_; }

    // Ask for a fresh `get_state` on the next frame. The run's pause is the one
    // fact the Frame pane shows that no event announces: `awaitingResponse` only
    // ever arrives in a `get_state` body, so a client that asks once at connect
    // can never learn that a run stopped mid-session to ask the user something —
    // and the Approve button it would light up stays dark forever.
    void requestStateRefresh() { stateRefreshRequested_ = true; }
    // True at most once per request, so the caller sends one command per reason.
    bool takeStateRefreshRequest() {
        const bool requested = stateRefreshRequested_;
        stateRefreshRequested_ = false;
        return requested;
    }

    // True when the bootstrap could not read a snapshot and the whole model is a
    // projection of the live event stream alone. The status bar says so; a panel
    // that renders an empty belief list must not read as "there are no beliefs".
    bool isEventOnly() const { return eventOnly_; }
    void setEventOnly(bool eventOnly) { eventOnly_ = eventOnly; }
    // Append one event to the registry the fold reads (used by the snapshot
    // parser and by tests).
    void reset();

    const AgentSessionSnapshot& snapshot() const { return snapshot_; }

    // Replay issues, oldest first. The GUI never swallows a log the runtime
    // would reject, and never crashes on one either.
    const std::vector<ReplayIssue>& issues() const { return issues_; }
    void clearIssues() { issues_.clear(); }

    // --- Domain accessors ------------------------------------------------
    const Belief* belief(const BeliefId& id) const { return snapshot_.belief(id); }
    const Task* task(const TaskId& id) const { return snapshot_.task(id); }
    // Tasks in record order.
    std::vector<const Task*> tasks() const;
    // Beliefs in record order (the order a display label is derived from).
    std::vector<const Belief*> beliefs() const;
    const ExecutionEpisode* episode(const TaskId& taskId, const EpisodeId& episodeId) const;
    const AgentSessionCursor& cursor() const { return cursor_; }

    // Display label for a belief: "B<n>" by record order, or the raw id when the
    // belief is unknown. DERIVED AT RENDER TIME — never stored, never used for
    // correlation (docs/milestones.md §5.3).
    std::string beliefLabel(const BeliefId& id) const;

    // --- RPC telemetry ---------------------------------------------------
    const Footer& footer() const { return footer_; }
    void setFooter(Footer f) { footer_ = std::move(f); }
    const RoleContextUsagePair& roleContext() const { return roleContext_; }
    void setRoleContext(RoleContextUsagePair r) { roleContext_ = std::move(r); }

    // The dispatch-trace observation log, in arrival order. Recorded by
    // `applyRpcLine`; folded into rows by `buildDispatchTrace`. Never replayed —
    // see the section comment above.
    const std::vector<TraceEntry>& trace() const { return trace_; }
    // The assistant turn `message_end` has not closed yet, or nullptr when no turn
    // is in flight. The footer reads its `stage` to mark which role slot is
    // currently executing; a turn the cursor attributed to routing/finalReport
    // carries no slot and highlights none.
    const TraceEntry* openTurn() const {
        if (!openTurn_.has_value() || *openTurn_ >= trace_.size()) return nullptr;
        return &trace_[*openTurn_];
    }
    // Append one observation. Public so a test can drive the fold with a log it
    // states outright instead of one it has to coax out of the adapter.
    void recordTrace(TraceEntry entry);
    // Open one assistant turn. A turn already open is left unterminated rather
    // than merged, so two `message_start`s with no `message_end` between them stay
    // visible as two rows instead of averaging into one.
    void beginTraceTurn(TraceEntry turn);
    // Close the open turn with the end-of-turn fields (`endedAt`/`endedAtMs`,
    // `stopReason`, `errorMessage`, `usage`). False when no turn was open: a
    // `message_end` with no `message_start` is a malformed stream, and inventing a
    // turn for it would put a dispatch in the trace that never ran.
    bool endTraceTurn(TraceEntry closing);
    // The role slots the last recorded Status entry carried, so an identical
    // `session_status` repeat is not logged twice.
    const Footer& lastRoleStatus() const { return lastRoleStatus_; }
    void setLastRoleStatus(Footer footer) { lastRoleStatus_ = std::move(footer); }

    // Live in-message stream (the assistant's streaming reply shown in the Frame
    // pane). Populated from message_start / message_update / message_end.
    void beginInMessage(const std::string& text);
    void appendInMessage(const std::string& delta);
    void endInMessage();
    const std::string& inMessage() const { return inMessage_; }
    bool inMessageThinking() const { return inMessageThinking_; }
    bool inMessageError() const { return inMessageError_; }
    void setInMessageThinking(bool thinking);
    void setInMessageError(const std::string& message);

    // Archived prior replies, oldest first. Captured when a new reply replaces a
    // non-empty current one, so every replacement in a single drained batch is
    // retained even though the pane only ever sees the final `inMessage()`.
    struct ArchivedInMessage {
        std::string text;
        bool error = false;
    };
    const std::vector<ArchivedInMessage>& inMessageHistory() const { return inMessageHistory_; }

    // --- Session-scoped, schema-independent state ------------------------
    const std::string& session() const { return session_; }
    void setSession(std::string s) { session_ = std::move(s); }
    void recordFileOp(const std::string& op, const std::string& rawPath);
    const std::vector<FileEntry>& fileList() const { return fileList_; }
    void clearFileList();

    // --- Fold internals used by the appliers (public so tests can drive them) --
    void recordIssue(std::string eventType, std::string eventId, std::string message);

private:
    // The four appliers, one per applier category (TS: DOMAIN_EVENT_APPLIERS).
    // Each returns true when the event type belongs to its category.
    bool applyTaskEvent(const DomainEvent& event);
    bool applyFormulationEvent(const DomainEvent& event);
    bool applyEpisodeEvent(const DomainEvent& event);
    bool applyLoopEvent(const DomainEvent& event);

    Task* mutableTask(const TaskId& id);
    ExecutionEpisode* mutableEpisode(const TaskId& taskId, const EpisodeId& episodeId);
    Belief* mutableBelief(const BeliefId& id);
    // Insert (or fetch) a belief record, appending to `beliefOrder` on first
    // sight so the record order the display label derives from is the order the
    // runtime registered them in.
    Belief& upsertBelief(const BeliefId& id);

    AgentSessionSnapshot snapshot_;
    AgentSessionCursor cursor_;  // mirrors snapshot_.cursor for cheap reads
    SessionState sessionState_;
    bool eventOnly_ = false;
    std::vector<ReplayIssue> issues_;
    Footer footer_;
    RoleContextUsagePair roleContext_;
    std::string inMessage_;
    bool inMessageThinking_ = false;
    bool inMessageError_ = false;
    std::vector<ArchivedInMessage> inMessageHistory_;
    // Dispatch telemetry. `trace_` is append-only in arrival order; `openTurn_`
    // is the index of the assistant turn `message_end` has not closed yet, so an
    // unterminated turn is visible as itself rather than as an absent one.
    std::vector<TraceEntry> trace_;
    std::optional<size_t> openTurn_;
    // The role slots the last recorded Status entry carried, so an identical
    // `session_status` repeat is not logged again. Separate from `footer_`, which
    // also carries the session cost.
    Footer lastRoleStatus_;
    std::string session_;
    std::vector<FileEntry> fileList_;
    std::set<std::string> fileOpSeen_;
    bool stateRefreshRequested_ = false;
};

// The RPC event adapter (live mode). Consumes one runtime JSONL line (a domain
// event, an AgentEvent, or an RpcResponse ack) and updates the model. Returns
// Applied if the line produced a model change, Ignored if it was a benign
// non-model event, or Error if the line could not be interpreted.
enum class RpcApplyResult { Applied, Ignored, Error };
RpcApplyResult applyRpcLine(NativeGuiModel& model, const std::string& line);
// The same, on a line the caller already parsed (the reader thread parses, so
// re-parsing on the frame thread would double the cost of every event).
RpcApplyResult applyRpcLine(NativeGuiModel& model, const json::Value& parsed);

} // namespace pie::gui
