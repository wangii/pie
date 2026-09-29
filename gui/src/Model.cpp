// NativeGuiModel — the v7 fold.
//
// This is a C++ mirror of `applyAgentSessionDomainEvent` and the free functions
// around it in packages/pie/src/core/agent-session-domain.ts. Read the APPLIER
// CONTRACT at the top of Model.h before changing anything here: every applier is
// a pure f(state, event) keyed on the record id it writes, and the division
// between "invariant violation" (issue + no-op) and "dangling citation"
// (issue + still apply) is load-bearing.

#include "Model.h"

#include "DomainEvents.h"

#include <algorithm>
#include <cstddef>
#include <utility>

namespace pie::gui {

// ---------------------------------------------------------------------------
// Belief status derivation (TS: statusOfDomainBelief)
// ---------------------------------------------------------------------------
BeliefStatus Belief::status() const {
    if (supersededBy.has_value() || withdrawn) return BeliefStatus::Superseded;
    if (!refutedBy.empty()) return BeliefStatus::Refuted;
    if (!supportedBy.empty()) return BeliefStatus::Supported;
    if (!inconclusiveBy.empty()) return BeliefStatus::Inconclusive;
    return BeliefStatus::Proposed;
}

// ---------------------------------------------------------------------------
// Record lookups
// ---------------------------------------------------------------------------
const Execution* ExecutionEpisode::execution(const ExecutionId& id) const {
    for (const Execution& e : body.trajectory) {
        if (e.id == id) return &e;
    }
    return nullptr;
}

const BeliefDelta* ExecutionEpisode::beliefDelta(const BeliefDeltaId& id) const {
    for (const BeliefDelta& d : body.beliefDeltas) {
        if (d.id == id) return &d;
    }
    return nullptr;
}

const ExecutionEpisode* Task::episode(const EpisodeId& id) const {
    for (const ExecutionEpisode& e : episodes) {
        if (e.id == id) return &e;
    }
    return nullptr;
}

bool Task::inFocus(const BeliefId& id) const {
    return std::find(focus.begin(), focus.end(), id) != focus.end();
}

bool Task::hasIntroduced(const BeliefId& id) const {
    return std::find(introducedBeliefs.begin(), introducedBeliefs.end(), id) != introducedBeliefs.end();
}

const Task* AgentSessionSnapshot::task(const TaskId& id) const {
    auto it = tasks.find(id);
    return it == tasks.end() ? nullptr : &it->second;
}

const Belief* AgentSessionSnapshot::belief(const BeliefId& id) const {
    auto it = beliefs.find(id);
    return it == beliefs.end() ? nullptr : &it->second;
}

size_t AgentSessionSnapshot::beliefIndex(const BeliefId& id) const {
    for (size_t i = 0; i < beliefOrder.size(); ++i) {
        if (beliefOrder[i] == id) return i;
    }
    return npos;
}

// ---------------------------------------------------------------------------
// Derivations (TS: the free functions in agent-session-domain.ts)
// ---------------------------------------------------------------------------
const ProblemFormulationVersion* currentFormulation(const Task& task) {
    if (task.formulations.empty()) return nullptr;
    return &task.formulations.back();
}

std::vector<const FormulationCorrection*> pendingFormulationCorrections(const Task& task) {
    std::vector<const FormulationCorrection*> out;
    for (const FormulationCorrection& correction : task.formulationCorrections) {
        if (correction.status == FormulationCorrectionStatus::Pending) out.push_back(&correction);
    }
    return out;
}

std::optional<uint64_t> latestDispatchedEpisodeOrdinal(const Task& task) {
    std::optional<uint64_t> latest;
    for (const ExecutionEpisode& episode : task.episodes) {
        // "Dispatched" is read off durable records: a belief-loop episode records
        // it in its Plan, a fast-path episode in its body selection. Routing alone
        // does not count, because selecting a body and then waiting to choose an
        // experiment is not an investigation.
        const bool dispatched = episode.body.kind == EpisodeBodyKind::FastPath ||
                                (episode.body.kind == EpisodeBodyKind::BeliefLoop && episode.body.plan.has_value());
        if (dispatched) latest = episode.ordinal;
    }
    return latest;
}

std::optional<FormulationAdoption> latestFormulationAdoption(const Task& task) {
    const std::optional<uint64_t> ordinal = latestDispatchedEpisodeOrdinal(task);
    if (!ordinal.has_value()) return std::nullopt;
    for (const ExecutionEpisode& episode : task.episodes) {
        if (episode.ordinal != *ordinal) continue;
        if (episode.body.kind == EpisodeBodyKind::BeliefLoop && episode.body.plan.has_value()) {
            return episode.body.plan->formulation;
        }
        if (episode.body.kind == EpisodeBodyKind::FastPath) return episode.body.formulation;
        return std::nullopt;
    }
    return std::nullopt;
}

const ExecutionEpisode* latestDistilledEpisode(const Task& task) {
    const ExecutionEpisode* latest = nullptr;
    for (const ExecutionEpisode& episode : task.episodes) {
        // Distillation is the marker rather than dispatch: a round whose
        // experiment was interrupted before distill never produced evidence to
        // reconsider. The body kind is part of the test on purpose — a fast path
        // has no distill role and no adjudication to reconsider, so its round
        // must not be pulled under the per-round gate.
        if (episode.body.kind == EpisodeBodyKind::BeliefLoop && episode.body.distillation.has_value()) {
            latest = &episode;
        }
    }
    return latest;
}

namespace {

// The decision that still counts for a belief: a stale one counts for nothing.
const FormulationApplicabilityEntry* liveApplicability(const FormulationReview& review, const BeliefId& beliefId) {
    for (const FormulationApplicabilityEntry& entry : review.applicability) {
        if (entry.beliefId == beliefId && !entry.stale) return &entry;
    }
    return nullptr;
}

} // namespace

bool applicabilityComplete(const FormulationReview& review) {
    for (const BeliefId& beliefId : review.scopedBeliefIds) {
        if (liveApplicability(review, beliefId) == nullptr) return false;
    }
    return true;
}

std::vector<BeliefId> pendingApplicabilityBeliefs(const Task& task) {
    std::vector<BeliefId> out;
    if (!task.formulationReview.has_value()) return out;
    const FormulationReview& review = *task.formulationReview;
    for (const BeliefId& beliefId : review.scopedBeliefIds) {
        if (liveApplicability(review, beliefId) == nullptr) out.push_back(beliefId);
    }
    return out;
}

std::vector<const FormulationApplicabilityEntry*> unrevalidatedApplicability(const Task& task) {
    std::vector<const FormulationApplicabilityEntry*> out;
    if (!task.formulationReview.has_value()) return out;
    for (const FormulationApplicabilityEntry& entry : task.formulationReview->applicability) {
        if (!entry.stale && entry.decision == FormulationApplicabilityDecision::NeedsRevalidation &&
            !entry.revalidatedByDeltaId.has_value()) {
            out.push_back(&entry);
        }
    }
    return out;
}

bool firstFormulationDecisionOwed(const Task& task) {
    const std::optional<uint64_t> investigated = latestDispatchedEpisodeOrdinal(task);
    if (!investigated.has_value()) return false;
    if (currentFormulation(task) != nullptr) return false;
    const FormulationDeferral* deferral = task.formulationDeferral.has_value() ? &*task.formulationDeferral : nullptr;
    return deferral == nullptr || deferral->answeredThroughEpisodeOrdinal < *investigated;
}

bool formulationRecheckOwed(const Task& task) {
    const ExecutionEpisode* distilled = latestDistilledEpisode(task);
    if (distilled == nullptr) return false;
    if (currentFormulation(task) == nullptr) return false;
    return !task.formulationRecheck.has_value() || task.formulationRecheck->episodeId != distilled->id;
}

bool formulationDecisionOwed(const Task& task) {
    return firstFormulationDecisionOwed(task) || formulationRecheckOwed(task);
}

// ---------------------------------------------------------------------------
// Model: telemetry and session-scoped state
// ---------------------------------------------------------------------------
void NativeGuiModel::recordFileOp(const std::string& op, const std::string& rawPath) {
    if (rawPath.empty()) return;
    const std::string display = normalizeDisplayPath(session_, rawPath);
    const std::string key = op + "\n" + display;
    if (fileOpSeen_.insert(key).second) fileList_.push_back(FileEntry{display, op});
}

void NativeGuiModel::clearFileList() {
    fileList_.clear();
    fileOpSeen_.clear();
}

void NativeGuiModel::beginInMessage(const std::string& text) {
    // Archive the reply being replaced so the pane can page back through it.
    // Capturing at the replacement point (not at render time) is what keeps every
    // replacement in a single drained batch.
    if (!inMessage_.empty()) inMessageHistory_.push_back(ArchivedInMessage{inMessage_, inMessageError_});
    inMessage_ = text;
    inMessageError_ = false;
}

void NativeGuiModel::appendInMessage(const std::string& delta) { inMessage_ += delta; }

void NativeGuiModel::endInMessage() {
    // The buffer already holds the accumulated text; nothing more to do.
}

void NativeGuiModel::setInMessageThinking(bool thinking) { inMessageThinking_ = thinking; }

void NativeGuiModel::setInMessageError(const std::string& message) {
    if (!inMessage_.empty()) inMessageHistory_.push_back(ArchivedInMessage{inMessage_, inMessageError_});
    inMessage_ = message;
    inMessageThinking_ = false;
    inMessageError_ = true;
}

void NativeGuiModel::recordIssue(std::string eventType, std::string eventId, std::string message) {
    issues_.push_back(ReplayIssue{std::move(eventType), std::move(eventId), std::move(message)});
}

// ---------------------------------------------------------------------------
// Dispatch telemetry
// ---------------------------------------------------------------------------
float TurnUsage::cacheHitRate() const {
    // The SAME derivation the runtime uses for `roleStatus.<slot>.latestCacheHitRate`
    // (agent-session.ts: `promptTokens = input + cacheRead + cacheWrite`, then
    // `cacheRead / promptTokens * 100`). Deliberately identical: §7.3 offers this
    // as the fallback for when the telemetry has not caught up, and a fallback
    // that computes a different number from the value it stands in for would be
    // worse than showing nothing.
    const long promptTokens = input + cacheRead + cacheWrite;
    if (input < 0 || cacheRead < 0 || cacheWrite < 0 || promptTokens <= 0) return -1.0f;
    return 100.0f * static_cast<float>(cacheRead) / static_cast<float>(promptTokens);
}

void NativeGuiModel::recordTrace(TraceEntry entry) {
    trace_.push_back(std::move(entry));
}

void NativeGuiModel::beginTraceTurn(TraceEntry turn) {
    turn.kind = TraceEntry::Kind::Turn;
    openTurn_ = trace_.size();
    trace_.push_back(std::move(turn));
}

bool NativeGuiModel::endTraceTurn(TraceEntry closing) {
    if (!openTurn_.has_value() || *openTurn_ >= trace_.size()) return false;
    TraceEntry& turn = trace_[*openTurn_];
    turn.ended = true;
    turn.endedAt = std::move(closing.endedAt);
    turn.endedAtMs = closing.endedAtMs;
    turn.stopReason = std::move(closing.stopReason);
    turn.errorMessage = std::move(closing.errorMessage);
    // Only when the end actually carried token accounting: a `message_end` with no
    // `usage` must not erase the counts `message_start` already reported.
    if (closing.usage.any()) turn.usage = closing.usage;
    openTurn_.reset();
    return true;
}

// ---------------------------------------------------------------------------
// Model: state access
// ---------------------------------------------------------------------------
void NativeGuiModel::reset() {
    snapshot_ = AgentSessionSnapshot{};
    cursor_ = AgentSessionCursor{};
    issues_.clear();
    footer_ = Footer{};
    roleContext_ = RoleContextUsagePair{};
    inMessage_.clear();
    inMessageThinking_ = false;
    inMessageError_ = false;
    inMessageHistory_.clear();
    trace_.clear();
    openTurn_.reset();
    lastRoleStatus_ = Footer{};
    clearFileList();
}

void NativeGuiModel::applyDomainSnapshot(const AgentSessionSnapshot& snapshot) {
    snapshot_ = snapshot;
    cursor_ = snapshot.cursor.has_value() ? *snapshot.cursor : AgentSessionCursor{};
    // The snapshot is an integral replacement of what the state IS, so issues
    // raised against the state it replaces no longer describe anything.
    issues_.clear();
}

void NativeGuiModel::applySessionState(SessionState state) {
    sessionState_ = std::move(state);
}

std::vector<const Task*> NativeGuiModel::tasks() const {
    std::vector<const Task*> out;
    out.reserve(snapshot_.taskOrder.size());
    for (const TaskId& id : snapshot_.taskOrder) {
        if (const Task* task = snapshot_.task(id)) out.push_back(task);
    }
    return out;
}

std::vector<const Belief*> NativeGuiModel::beliefs() const {
    std::vector<const Belief*> out;
    out.reserve(snapshot_.beliefOrder.size());
    for (const BeliefId& id : snapshot_.beliefOrder) {
        if (const Belief* belief = snapshot_.belief(id)) out.push_back(belief);
    }
    return out;
}

const ExecutionEpisode* NativeGuiModel::episode(const TaskId& taskId, const EpisodeId& episodeId) const {
    const Task* task = snapshot_.task(taskId);
    return task == nullptr ? nullptr : task->episode(episodeId);
}

std::string NativeGuiModel::beliefLabel(const BeliefId& id) const {
    // DERIVED AT RENDER TIME from record order (docs/milestones.md §5.3). Never
    // stored: an accumulated ordinal drifts on reconnect, when the registry is
    // re-applied from a snapshot the events around it also describe.
    const size_t index = snapshot_.beliefIndex(id);
    if (index == AgentSessionSnapshot::npos) return id;
    return "B" + std::to_string(index + 1);
}

Task* NativeGuiModel::mutableTask(const TaskId& id) {
    auto it = snapshot_.tasks.find(id);
    return it == snapshot_.tasks.end() ? nullptr : &it->second;
}

ExecutionEpisode* NativeGuiModel::mutableEpisode(const TaskId& taskId, const EpisodeId& episodeId) {
    Task* task = mutableTask(taskId);
    if (task == nullptr) return nullptr;
    for (ExecutionEpisode& episode : task->episodes) {
        if (episode.id == episodeId) return &episode;
    }
    return nullptr;
}

Belief* NativeGuiModel::mutableBelief(const BeliefId& id) {
    auto it = snapshot_.beliefs.find(id);
    return it == snapshot_.beliefs.end() ? nullptr : &it->second;
}

Belief& NativeGuiModel::upsertBelief(const BeliefId& id) {
    auto it = snapshot_.beliefs.find(id);
    if (it != snapshot_.beliefs.end()) return it->second;
    Belief belief;
    belief.id = id;
    auto inserted = snapshot_.beliefs.emplace(id, std::move(belief));
    // Record order is what beliefLabel() counts, so appending on first sight
    // keeps the label aligned with the order the runtime registered them in.
    snapshot_.beliefOrder.push_back(id);
    return inserted.first->second;
}

// ---------------------------------------------------------------------------
// Identity-level comparisons
//
// The applier's job is to notice a GENUINE conflict (so it can raise an issue),
// not to be a diff. These compare the fields that carry a record's identity.
// ---------------------------------------------------------------------------
namespace {

bool sameRouting(const Routing& a, const Routing& b) {
    return a.id == b.id && a.decision == b.decision && a.reason == b.reason;
}

bool samePlan(const Plan& a, const Plan& b) {
    return a.id == b.id && a.selectedToExplore == b.selectedToExplore && a.intent == b.intent;
}

bool sameDistillation(const Distillation& a, const Distillation& b) {
    return a.id == b.id && a.inputs == b.inputs && a.outputs == b.outputs && a.contents == b.contents;
}

bool sameIntervention(const Intervention& a, const Intervention& b) {
    return a.id == b.id && a.contents == b.contents && a.stage == b.stage;
}

bool sameDeferral(const FormulationDeferral& a, const FormulationDeferral& b) {
    return a.missingInformation == b.missingInformation && a.reason == b.reason && a.deferredAt == b.deferredAt;
}

bool sameTarget(const Target& a, const Target& b) { return a.id == b.id && a.statement == b.statement; }

bool sameCorrection(const FormulationCorrection& a, const FormulationCorrection& b) {
    return a.id == b.id && a.original == b.original && a.receivedAt == b.receivedAt &&
           a.targetVersionId == b.targetVersionId;
}

// TS: reviewScopeAfterFocus — a belief brought back into focus while a review is
// owed also has to be accounted for, unless it was first introduced after the
// revision: the reading that produced it is the one being reviewed.
//
// "Pre-existing" is read off the durable registry as well as off the index. A
// belief declared in the turn that focuses it has no record yet — its delta is
// still in flight, because the round that carries it is not dispatched until the
// turn ends — so it did not exist when the version was published either.
// Counting it as pre-existing would owe it a decision that
// FormulationApplicabilityRecorded then refuses, and the review could never be
// completed.
std::vector<BeliefId> reviewScopeAfterFocus(const Task& task, const FormulationReview& review,
                                            const std::vector<BeliefId>& focused,
                                            const AgentSessionSnapshot& snapshot) {
    std::vector<BeliefId> scoped = review.scopedBeliefIds;
    for (const BeliefId& beliefId : focused) {
        if (std::find(scoped.begin(), scoped.end(), beliefId) != scoped.end()) continue;
        if (snapshot.belief(beliefId) == nullptr) continue;
        const size_t introduced = [&]() -> size_t {
            for (size_t i = 0; i < task.introducedBeliefs.size(); ++i) {
                if (task.introducedBeliefs[i] == beliefId) return i;
            }
            return AgentSessionSnapshot::npos;
        }();
        if (introduced != AgentSessionSnapshot::npos && introduced >= review.introducedAtRevision) continue;
        scoped.push_back(beliefId);
    }
    return scoped;
}

// TS: deltaAnswersBelief — a delta answers a review's request when it touches the
// belief itself or a belief that now stands in its place after a refinement (or a
// retraction). The chain is followed one predecessor at a time, so refining twice
// still answers the original.
bool deltaAnswersBelief(const BeliefDelta& delta, const BeliefId& beliefId, const AgentSessionSnapshot& snapshot) {
    std::vector<BeliefId> touched{delta.resultBeliefId};
    if (delta.beliefId.has_value()) touched.push_back(*delta.beliefId);
    if (delta.sourceBeliefId.has_value()) touched.push_back(*delta.sourceBeliefId);

    std::vector<BeliefId> seen;
    const BeliefId* current = &beliefId;
    BeliefId next;
    while (current != nullptr) {
        if (std::find(touched.begin(), touched.end(), *current) != touched.end()) return true;
        if (std::find(seen.begin(), seen.end(), *current) != seen.end()) return false;
        seen.push_back(*current);
        const Belief* belief = snapshot.belief(*current);
        if (belief == nullptr || !belief->supersededBy.has_value()) return false;
        next = *belief->supersededBy;
        current = &next;
    }
    return false;
}

} // namespace

// ---------------------------------------------------------------------------
// applyDomainEvent
// ---------------------------------------------------------------------------
bool NativeGuiModel::applyDomainEvent(const DomainEvent& event) {
    if (event.kind == DomainEventKind::Unknown) return false;
    // Every bump so far has been breaking with no migration path (v2 renamed
    // TaskFrame to ExecutionEpisode; v3 added the formulation records; v4 the
    // experiment selection; v5 revision response and focus review; v6 the
    // per-round recheck; v7 explicit Frame approval). Replaying an older log
    // would either miss records or misread them, so it is refused loudly instead
    // of being reinterpreted — the same choice the runtime makes.
    if (event.schemaVersion != kAgentSessionDomainSchemaVersion) {
        recordIssue(event.type, event.eventId,
                    "unsupported schema version " + std::to_string(event.schemaVersion) + " (this build requires v" +
                        std::to_string(kAgentSessionDomainSchemaVersion) + ")");
        return true;
    }
    switch (domainEventCategory(event.kind)) {
        case DomainEventCategory::Task: return applyTaskEvent(event);
        case DomainEventCategory::Formulation: return applyFormulationEvent(event);
        case DomainEventCategory::Episode: return applyEpisodeEvent(event);
        case DomainEventCategory::Loop: return applyLoopEvent(event);
        case DomainEventCategory::Unknown: break;
    }
    return false;
}

// ---------------------------------------------------------------------------
// Task applier (TS: applyTaskEvent)
// ---------------------------------------------------------------------------
bool NativeGuiModel::applyTaskEvent(const DomainEvent& event) {
    switch (event.kind) {
        case DomainEventKind::TaskOpened: {
            const std::string parent = event.json.string("parentTaskId");
            if (Task* existing = mutableTask(event.taskId)) {
                // Snapshot/stream overlap: the task is already here. Silent when
                // the replay agrees, an issue when it contradicts.
                const std::string existingParent = existing->parentTaskId.value_or("");
                const std::string replayedPrompt = event.json.object("initialPrompt") != nullptr
                                                       ? event.json.object("initialPrompt")->string("id")
                                                       : std::string{};
                if (existingParent != parent ||
                    (!replayedPrompt.empty() && existing->initialPrompt.id != replayedPrompt)) {
                    recordIssue(event.type, event.eventId,
                                "task " + event.taskId + " already exists with different content");
                }
                return true;
            }
            if (event.taskId.empty()) {
                recordIssue(event.type, event.eventId, "TaskOpened has no taskId");
                return true;
            }
            Task task;
            task.id = event.taskId;
            if (!parent.empty()) {
                if (snapshot_.task(parent) == nullptr) {
                    // Dangling citation: keep the task (dropping it would hide the
                    // whole subtree) but do not record a parent that isn't there.
                    recordIssue(event.type, event.eventId, "unknown parent task " + parent);
                } else {
                    task.parentTaskId = parent;
                }
            }
            if (const json::Value* prompt = event.json.object("initialPrompt")) {
                readInitialPrompt(*prompt, task.initialPrompt);
            }
            task.status = TaskStatus::Active;
            task.inheritedBeliefs = event.json.stringArray("inheritedBeliefs");
            for (const BeliefId& beliefId : task.inheritedBeliefs) {
                if (snapshot_.belief(beliefId) == nullptr) {
                    recordIssue(event.type, event.eventId, "unknown inherited belief " + beliefId);
                }
            }
            // A new task inherits beliefs, never scope or understanding: it starts
            // undeclared with an empty formulation history.
            snapshot_.taskOrder.push_back(task.id);
            snapshot_.tasks.emplace(task.id, std::move(task));
            snapshot_.activeBranchTasks.push_back(event.taskId);
            snapshot_.activeBeliefs = snapshot_.task(event.taskId)->inheritedBeliefs;
            return true;
        }
        case DomainEventKind::TaskClosed: {
            Task* task = mutableTask(event.taskId);
            if (task == nullptr) {
                recordIssue(event.type, event.eventId, "unknown task " + event.taskId);
                return true;
            }
            const TaskStatus status = parseTaskStatus(event.json.string("status"));
            if (task->status != TaskStatus::Active) {
                // Already closed: closing again is the same state, so this is the
                // idempotent case rather than a conflict.
                if (task->status != status) {
                    recordIssue(event.type, event.eventId,
                                "task " + task->id + " is already " + toString(task->status));
                }
                return true;
            }
            if (status == TaskStatus::Active || status == TaskStatus::Unknown) {
                recordIssue(event.type, event.eventId, "TaskClosed carries no terminal status");
            }
            if (!task->initialTarget.has_value()) {
                recordIssue(event.type, event.eventId, "task " + task->id + " has no target");
            }
            for (const ExecutionEpisode& episode : task->episodes) {
                if (episode.status != EpisodeStatus::Closed) {
                    recordIssue(event.type, event.eventId, "task " + task->id + " has an open episode");
                    break;
                }
            }
            if (status != TaskStatus::Active && status != TaskStatus::Unknown) task->status = status;
            return true;
        }
        case DomainEventKind::TargetDefined: {
            Task* task = mutableTask(event.taskId);
            if (task == nullptr) {
                recordIssue(event.type, event.eventId, "unknown task " + event.taskId);
                return true;
            }
            Target target;
            const json::Value* raw = event.json.object("target");
            if (raw == nullptr || !readTarget(*raw, target)) {
                recordIssue(event.type, event.eventId, "TargetDefined carries no target");
                return true;
            }
            if (task->initialTarget.has_value()) {
                // The target is immutable: an identical replay is the overlap
                // case, a different one is a contradiction.
                if (!sameTarget(*task->initialTarget, target)) {
                    recordIssue(event.type, event.eventId, "task " + task->id + " target is immutable");
                }
                return true;
            }
            task->initialTarget = std::move(target);
            return true;
        }
        case DomainEventKind::FocusDeclared: {
            Task* task = mutableTask(event.taskId);
            if (task == nullptr) {
                recordIssue(event.type, event.eventId, "unknown task " + event.taskId);
                return true;
            }
            // No activity check: the declared slice is a last-write-wins field, so
            // a replay onto a task that has since closed is indistinguishable from
            // a late declaration, and the write is idempotent either way.
            const std::vector<BeliefId> declared = event.json.stringArray("beliefIds");
            // Re-declaration replaces: a task may restate or narrow its scope and
            // the last declaration wins. No belief-existence check — a focus id
            // can name a belief whose delta is still in flight.
            if (task->formulationReview.has_value()) {
                FormulationReview& review = *task->formulationReview;
                // `sameVersion` gates the review update: a focus declaration made
                // under a later reading says nothing about the reading being
                // reviewed.
                const json::Value* adoption = event.json.find("formulation");
                const bool sameVersion = adoption != nullptr && adoption->isObject() &&
                                         adoption->string("kind") == "version" &&
                                         adoption->string("versionId") == review.versionId;
                if (sameVersion) {
                    // Putting a belief the review called `not-applicable` back in
                    // scope makes that decision a statement about a scope the task
                    // no longer holds: it stops counting, so the belief is owed a
                    // fresh one. Without this, "classify it away, then put it back"
                    // would be a way around the review.
                    for (FormulationApplicabilityEntry& entry : review.applicability) {
                        if (entry.decision == FormulationApplicabilityDecision::NotApplicable &&
                            std::find(declared.begin(), declared.end(), entry.beliefId) != declared.end()) {
                            entry.stale = true;
                        }
                    }
                    review.scopedBeliefIds = reviewScopeAfterFocus(*task, review, declared, snapshot_);
                    // The reading is reviewed only once the user has acted on that
                    // version — approval and objection both count, neither is
                    // reachable from a plain message — and every belief it has to
                    // account for has a decision that still counts.
                    const bool readingReviewed =
                        applicabilityComplete(review) &&
                        (review.responseCorrectionId.has_value() || review.approval.has_value()) &&
                        pendingFormulationCorrections(*task).empty();
                    review.focusReviewed = review.focusReviewed || readingReviewed;
                }
            }
            task->focus = declared;
            task->focusDeclared = true;
            return true;
        }
        case DomainEventKind::TaskOutcomeRecorded: {
            Task* task = mutableTask(event.taskId);
            if (task == nullptr) {
                recordIssue(event.type, event.eventId, "unknown task " + event.taskId);
                return true;
            }
            TaskOutcome outcome;
            const json::Value* raw = event.json.object("outcome");
            if (raw == nullptr || !readTaskOutcome(*raw, outcome)) {
                recordIssue(event.type, event.eventId, "TaskOutcomeRecorded carries no outcome");
                return true;
            }
            if (outcome.result.empty()) {
                recordIssue(event.type, event.eventId, "task outcome has no result");
                return true;
            }
            if (outcome.evidence.empty()) {
                recordIssue(event.type, event.eventId, "task outcome has no evidence");
            }
            // Last-wins: the loop can refuse a `conclude` after the tool recorded
            // its outcome, and the model may conclude again with a correction.
            task->taskOutcome = std::move(outcome);
            return true;
        }
        default:
            return false;
    }
}

// ---------------------------------------------------------------------------
// Formulation applier (TS: applyFormulationEvent)
// ---------------------------------------------------------------------------
bool NativeGuiModel::applyFormulationEvent(const DomainEvent& event) {
    switch (event.kind) {
        case DomainEventKind::ProblemFormulationRecorded: {
            Task* task = mutableTask(event.taskId);
            if (task == nullptr) {
                recordIssue(event.type, event.eventId, "unknown task " + event.taskId);
                return true;
            }
            ProblemFormulationVersion version;
            const json::Value* raw = event.json.object("version");
            if (raw == nullptr || !readFormulationVersion(*raw, version)) {
                recordIssue(event.type, event.eventId, "ProblemFormulationRecorded carries no version");
                return true;
            }
            const std::string versionId = version.id;
            // Snapshot/stream overlap: the version is already in the history.
            for (const ProblemFormulationVersion& existing : task->formulations) {
                if (existing.id == versionId) return true;
            }
            if (version.taskId != task->id) {
                recordIssue(event.type, event.eventId,
                            "formulation version " + versionId + " names task " + version.taskId);
            }
            if (version.origin != kFormulationOriginPropose) {
                recordIssue(event.type, event.eventId, "formulation version " + versionId + " is not published by propose");
            }
            if (version.reason.empty()) {
                recordIssue(event.type, event.eventId, "formulation version " + versionId + " has no reason");
            }
            if (version.recordedAt.empty()) {
                recordIssue(event.type, event.eventId, "formulation version " + versionId + " has no recorded time");
            }
            if (version.content.interpretation.empty() || version.content.focus.empty() ||
                version.content.implication.empty()) {
                recordIssue(event.type, event.eventId,
                            "formulation version " + versionId + " is missing required content");
            }
            // The chain is what makes the history a history: a revision must name
            // the version it revises, and a first version must not name one.
            const ProblemFormulationVersion* current = currentFormulation(*task);
            const bool firstVersion = current == nullptr;
            if (firstVersion && version.previousVersionId.has_value()) {
                recordIssue(event.type, event.eventId,
                            "first formulation version " + versionId + " names a previous version");
                return true;
            }
            if (!firstVersion && (!version.previousVersionId.has_value() ||
                                  *version.previousVersionId != current->id)) {
                recordIssue(event.type, event.eventId,
                            "formulation version " + versionId + " does not follow " +
                                (current != nullptr ? current->id : std::string("(none)")));
                return true;
            }
            if (version.ordinal != task->formulations.size() + 1) {
                recordIssue(event.type, event.eventId,
                            "formulation ordinal " + std::to_string(version.ordinal) + " does not follow " +
                                std::to_string(task->formulations.size()));
                return true;
            }
            for (const FormulationSource& source : version.sources) {
                if (source.kind == FormulationSourceKind::Unknown) {
                    recordIssue(event.type, event.eventId, "formulation version " + versionId + " cites an unknown source kind");
                }
            }
            task->formulations.push_back(std::move(version));
            // Every publication waits for the user: the first reading is the one
            // the investigation is about to be built on, so it is reviewed like a
            // revision. Publishing also answers the deferral — the deferral record
            // stays in the log, only the task's current state drops it.
            FormulationReview review;
            review.versionId = versionId;
            review.focusReviewed = false;
            review.scopedBeliefIds = task->focus;
            review.introducedAtRevision = task->introducedBeliefs.size();
            task->formulationReview = std::move(review);
            task->formulationDeferral.reset();
            return true;
        }
        case DomainEventKind::ProblemFormulationDeferred: {
            Task* task = mutableTask(event.taskId);
            if (task == nullptr) {
                recordIssue(event.type, event.eventId, "unknown task " + event.taskId);
                return true;
            }
            FormulationDeferral deferral;
            deferral.missingInformation = event.json.string("missingInformation");
            deferral.reason = event.json.string("reason");
            const json::Value* sources = event.json.find("sources");
            if (sources != nullptr) deferral.sources = readFormulationSourceArray(*sources);
            deferral.deferredAt = event.json.string("deferredAt");
            if (deferral.missingInformation.empty()) {
                recordIssue(event.type, event.eventId, "formulation deferral has no missing information");
                return true;
            }
            if (deferral.reason.empty()) {
                recordIssue(event.type, event.eventId, "formulation deferral has no reason");
                return true;
            }
            // A deferral answers the investigation as it stood at this point in
            // the log. Deriving the ordinal from the task (rather than reading it
            // off the event) is what lets later evidence re-open the decision
            // instead of the deferral standing forever as an exemption.
            //
            // Idempotence: the derived ordinal would MOVE if the same deferral
            // were re-applied after a later dispatch, so an identical replay is
            // keyed on the record and no-ops rather than recomputing.
            if (task->formulationDeferral.has_value() && sameDeferral(*task->formulationDeferral, deferral)) {
                return true;
            }
            deferral.answeredThroughEpisodeOrdinal = latestDispatchedEpisodeOrdinal(*task).value_or(0);
            // Last-wins: a later deferral replaces the earlier one because it was
            // made against newer evidence, and it never removes a version.
            task->formulationDeferral = std::move(deferral);
            return true;
        }
        case DomainEventKind::FormulationApproved: {
            Task* task = mutableTask(event.taskId);
            if (task == nullptr) {
                recordIssue(event.type, event.eventId, "unknown task " + event.taskId);
                return true;
            }
            const std::string versionId = event.json.string("versionId");
            const std::string approvedAt = event.json.string("approvedAt");
            if (approvedAt.empty()) {
                recordIssue(event.type, event.eventId, "formulation approval has no recorded time");
            }
            const bool known = std::any_of(
                task->formulations.begin(), task->formulations.end(),
                [&](const ProblemFormulationVersion& v) { return v.id == versionId; });
            if (!known) {
                // Dangling citation: an approval for a version this task never
                // published is a real error, and a replay of the stream cannot
                // produce one.
                recordIssue(event.type, event.eventId, "formulation approval names unknown version " + versionId);
                return true;
            }
            const ProblemFormulationVersion* current = currentFormulation(*task);
            if (current == nullptr || current->id != versionId) {
                // An approval is an act on the reading the user was shown, so
                // approving a version a later publication replaced records nothing.
                //
                // The refusal is SILENT: a version that is no longer current is
                // exactly what a full replay presents (the stream revisits the
                // earlier reading after the state has moved to the revision), and
                // raising an issue for it would make a clean replay look broken.
                return true;
            }
            if (!task->formulationReview.has_value() || task->formulationReview->versionId != versionId) {
                return true;
            }
            FormulationReview& review = *task->formulationReview;
            for (const FormulationCorrection* correction : pendingFormulationCorrections(*task)) {
                if (correction->targetVersionId == versionId) {
                    // An objection the user has not yet had answered is not consent.
                    recordIssue(event.type, event.eventId,
                                "formulation " + versionId + " still has an unanswered objection");
                    return true;
                }
            }
            // Approving the same version again is a no-op rather than a second
            // decision, so a client retrying after a reconnect cannot create a
            // duplicate record of the same act.
            if (review.approval.has_value()) return true;
            FormulationApproval approval;
            approval.versionId = versionId;
            approval.approvedAt = approvedAt;
            review.approval = std::move(approval);
            return true;
        }
        case DomainEventKind::FormulationCorrectionSubmitted: {
            Task* task = mutableTask(event.taskId);
            if (task == nullptr) {
                recordIssue(event.type, event.eventId, "unknown task " + event.taskId);
                return true;
            }
            FormulationCorrection correction;
            const json::Value* raw = event.json.object("correction");
            if (raw == nullptr || !readFormulationCorrection(*raw, correction)) {
                recordIssue(event.type, event.eventId, "FormulationCorrectionSubmitted carries no correction");
                return true;
            }
            for (const FormulationCorrection& existing : task->formulationCorrections) {
                if (existing.id != correction.id) continue;
                // Idempotent replay; an issue only when the replay contradicts.
                if (!sameCorrection(existing, correction)) {
                    recordIssue(event.type, event.eventId, "correction " + correction.id + " already exists");
                }
                return true;
            }
            if (correction.taskId != task->id) {
                recordIssue(event.type, event.eventId,
                            "correction " + correction.id + " names task " + correction.taskId);
            }
            if (correction.status != FormulationCorrectionStatus::Pending) {
                recordIssue(event.type, event.eventId, "correction " + correction.id + " is not submitted as pending");
                return true;
            }
            if (correction.receivedAt.empty()) {
                recordIssue(event.type, event.eventId, "correction " + correction.id + " has no received time");
            }
            // A correction may target no version — the user can object before any
            // version exists — but a target it names must be real, so "which
            // version was the user looking at" is answerable later.
            if (correction.targetVersionId.has_value() &&
                !std::any_of(task->formulations.begin(), task->formulations.end(),
                             [&](const ProblemFormulationVersion& v) { return v.id == *correction.targetVersionId; })) {
                recordIssue(event.type, event.eventId,
                            "correction " + correction.id + " targets unknown formulation " + *correction.targetVersionId);
            }
            task->formulationCorrections.push_back(std::move(correction));
            if (task->formulationReview.has_value()) {
                FormulationReview& review = *task->formulationReview;
                review.focusReviewed = false;
                const FormulationCorrection& added = task->formulationCorrections.back();
                if (added.targetVersionId.has_value() && *added.targetVersionId == review.versionId) {
                    review.responseCorrectionId = added.id;
                }
            }
            return true;
        }
        case DomainEventKind::FormulationCorrectionResolved: {
            Task* task = mutableTask(event.taskId);
            if (task == nullptr) {
                recordIssue(event.type, event.eventId, "unknown task " + event.taskId);
                return true;
            }
            const std::string correctionId = event.json.string("correctionId");
            const std::string response = event.json.string("response");
            FormulationCorrection* target = nullptr;
            for (FormulationCorrection& correction : task->formulationCorrections) {
                if (correction.id == correctionId) {
                    target = &correction;
                    break;
                }
            }
            if (target == nullptr) {
                recordIssue(event.type, event.eventId, "unknown correction " + correctionId);
                return true;
            }
            if (target->status == FormulationCorrectionStatus::Resolved) {
                // Resolution is idempotent: the record is already in that state.
                return true;
            }
            // Only a response that says something resolves a correction; an empty
            // one would mark it handled without the user learning how.
            if (response.empty()) {
                recordIssue(event.type, event.eventId, "correction " + correctionId + " is resolved without a response");
                return true;
            }
            const std::string recordedVersionId = event.json.string("recordedVersionId");
            if (!recordedVersionId.empty() &&
                !std::any_of(task->formulations.begin(), task->formulations.end(),
                             [&](const ProblemFormulationVersion& v) { return v.id == recordedVersionId; })) {
                recordIssue(event.type, event.eventId,
                            "correction " + correctionId + " names unknown formulation " + recordedVersionId);
            }
            // Resolution is addressed to one correction id, so an answer to an
            // older correction can never be recorded as the answer to a newer one
            // that arrived while it was being handled.
            target->status = FormulationCorrectionStatus::Resolved;
            target->response = response;
            if (!recordedVersionId.empty()) target->recordedVersionId = recordedVersionId;
            return true;
        }
        case DomainEventKind::FormulationApplicabilityRecorded: {
            Task* task = mutableTask(event.taskId);
            if (task == nullptr) {
                recordIssue(event.type, event.eventId, "unknown task " + event.taskId);
                return true;
            }
            if (!task->formulationReview.has_value()) {
                recordIssue(event.type, event.eventId, "there is no formulation review to classify beliefs against");
                return true;
            }
            FormulationReview& review = *task->formulationReview;
            const std::string versionId = event.json.string("versionId");
            if (versionId != review.versionId) {
                recordIssue(event.type, event.eventId,
                            "applicability names version " + versionId + ", not the reviewed " + review.versionId);
                return true;
            }
            std::vector<FormulationApplicabilityEntry> entries;
            const json::Value* raw = event.json.find("applicability");
            if (raw == nullptr) raw = event.json.find("entries");
            if (raw == nullptr || !raw->isArray() || raw->size() == 0) {
                recordIssue(event.type, event.eventId, "an applicability review must classify at least one belief");
                return true;
            }
            std::vector<BeliefId> classified;
            bool invalid = false;
            for (size_t i = 0; i < raw->size() && !invalid; ++i) {
                FormulationApplicabilityEntry entry;
                if (!readApplicabilityEntry(raw->at(i), entry)) {
                    invalid = true;
                    break;
                }
                if (std::find(classified.begin(), classified.end(), entry.beliefId) != classified.end()) {
                    recordIssue(event.type, event.eventId,
                                "belief " + entry.beliefId + " is classified twice in one record");
                    invalid = true;
                    break;
                }
                classified.push_back(entry.beliefId);
                if (std::find(review.scopedBeliefIds.begin(), review.scopedBeliefIds.end(), entry.beliefId) ==
                    review.scopedBeliefIds.end()) {
                    recordIssue(event.type, event.eventId,
                                "belief " + entry.beliefId + " was not in scope when version " + review.versionId +
                                    " was published");
                    invalid = true;
                    break;
                }
                if (snapshot_.belief(entry.beliefId) == nullptr) {
                    recordIssue(event.type, event.eventId, "unknown belief " + entry.beliefId);
                    invalid = true;
                    break;
                }
                if (entry.reason.empty()) {
                    recordIssue(event.type, event.eventId, "belief " + entry.beliefId + " is classified without a reason");
                    invalid = true;
                    break;
                }
                if (entry.revalidatedByDeltaId.has_value()) {
                    recordIssue(event.type, event.eventId,
                                "belief " + entry.beliefId + " cannot name its re-examination as it is recorded");
                    invalid = true;
                    break;
                }
                if (entry.stale) {
                    recordIssue(event.type, event.eventId,
                                "belief " + entry.beliefId + " is stale by the fold's reckoning, not here");
                    invalid = true;
                    break;
                }
                entries.push_back(std::move(entry));
            }
            if (invalid) return true;
            // A re-classification replaces the earlier decision for those beliefs
            // and leaves the others alone.
            std::vector<FormulationApplicabilityEntry> next;
            for (const FormulationApplicabilityEntry& existing : review.applicability) {
                if (std::find(classified.begin(), classified.end(), existing.beliefId) == classified.end()) {
                    next.push_back(existing);
                }
            }
            for (FormulationApplicabilityEntry& entry : entries) next.push_back(std::move(entry));
            review.applicability = std::move(next);
            return true;
        }
        case DomainEventKind::FormulationRecheckRecorded: {
            Task* task = mutableTask(event.taskId);
            if (task == nullptr) {
                recordIssue(event.type, event.eventId, "unknown task " + event.taskId);
                return true;
            }
            FormulationRecheck recheck;
            const json::Value* raw = event.json.object("recheck");
            if (raw == nullptr || !readFormulationRecheck(*raw, recheck)) {
                recordIssue(event.type, event.eventId, "FormulationRecheckRecorded carries no recheck");
                return true;
            }
            const ExecutionEpisode* episode = task->episode(recheck.episodeId);
            if (episode == nullptr) {
                recordIssue(event.type, event.eventId, "unknown episode " + recheck.episodeId);
                return true;
            }
            // A recheck answers a round that actually reached distillation. A
            // round whose experiment was interrupted before distill never
            // distilled, and answering a correction owns that state instead — so a
            // recheck naming it would claim a check that never happened.
            if (episode->body.kind != EpisodeBodyKind::BeliefLoop || !episode->body.distillation.has_value()) {
                recordIssue(event.type, event.eventId,
                            "episode " + recheck.episodeId + " has no recorded distillation to reconsider");
                return true;
            }
            if (recheck.reason.empty()) {
                recordIssue(event.type, event.eventId,
                            "a recheck of episode " + recheck.episodeId + " needs a reason");
                return true;
            }
            if (recheck.verdict == FormulationRecheckVerdict::Revised) {
                if (!recheck.versionId.has_value()) {
                    recordIssue(event.type, event.eventId,
                                "a revised recheck of episode " + recheck.episodeId +
                                    " must name the version it published");
                    return true;
                }
                if (!std::any_of(task->formulations.begin(), task->formulations.end(),
                                 [&](const ProblemFormulationVersion& v) { return v.id == *recheck.versionId; })) {
                    recordIssue(event.type, event.eventId,
                                "recheck names version " + *recheck.versionId + ", which this task never published");
                    return true;
                }
            } else if (recheck.versionId.has_value()) {
                recordIssue(event.type, event.eventId,
                            std::string("a ") + toString(recheck.verdict) + " recheck publishes no version");
                return true;
            }
            // The recorded result is the latest one, so going backwards would
            // re-open a settled round. Recording twice for the SAME round stays
            // legal: a turn can say the reading holds and then publish a
            // revision, and the publication answers the same round again.
            //
            // The refusal is SILENT, unlike the other invariant checks. A
            // full-stream replay legitimately revisits earlier rounds onto a state
            // that already holds a later result, so raising an issue here would
            // make a clean replay look broken. The record is keyed on the round it
            // answers, so refusing it is a no-op and the state still converges.
            if (task->formulationRecheck.has_value()) {
                const ExecutionEpisode* previous = task->episode(task->formulationRecheck->episodeId);
                if (previous != nullptr && episode->ordinal < previous->ordinal) return true;
            }
            task->formulationRecheck = std::move(recheck);
            return true;
        }
        default:
            return false;
    }
}

// ---------------------------------------------------------------------------
// Episode applier (TS: applyEpisodeEvent)
// ---------------------------------------------------------------------------
bool NativeGuiModel::applyEpisodeEvent(const DomainEvent& event) {
    // TS: requireActiveEpisode / requireClassifiedEpisode, in mirrored form.
    //
    // Split in two on purpose. Locating is separate from judging activity,
    // because the appliers must check "is this record already here?" BEFORE they
    // judge activity: on a full replay the state has already moved past the
    // event, so a precondition-first order would report a phantom problem for
    // every line. Only an event that would actually WRITE gets the activity
    // check, and failing it is a no-op — which is what makes a closed episode
    // immutable instead of merely discouraged.
    struct Located {
        Task* task = nullptr;
        ExecutionEpisode* episode = nullptr;
        bool active = false;  // task active, episode active, body classified if required
        bool found = false;   // both records exist
    };
    auto locate = [&](bool needClassifiedBody) -> Located {
        Located out;
        out.task = mutableTask(event.taskId);
        if (out.task == nullptr) {
            recordIssue(event.type, event.eventId, "unknown task " + event.taskId);
            return out;
        }
        for (ExecutionEpisode& candidate : out.task->episodes) {
            if (candidate.id == event.episodeId) {
                out.episode = &candidate;
                break;
            }
        }
        if (out.episode == nullptr) {
            recordIssue(event.type, event.eventId, "unknown episode " + event.episodeId);
            return out;
        }
        out.found = true;
        const bool bodyOk = !needClassifiedBody || out.episode->body.kind != EpisodeBodyKind::Pending;
        out.active = out.task->status == TaskStatus::Active &&
                     out.episode->status == EpisodeStatus::Active && bodyOk;
        return out;
    };
    // Report why a write was refused, then let the caller no-op.
    auto refuseInactive = [&](const Located& l) {
        if (l.task->status != TaskStatus::Active) {
            recordIssue(event.type, event.eventId, "task " + l.task->id + " is " + toString(l.task->status));
        } else if (l.episode->status != EpisodeStatus::Active) {
            recordIssue(event.type, event.eventId, "episode " + l.episode->id + " is closed");
        } else {
            recordIssue(event.type, event.eventId, "episode " + l.episode->id + " has no selected body");
        }
    };

    switch (event.kind) {
        case DomainEventKind::EpisodeOpened: {
            Task* task = mutableTask(event.taskId);
            if (task == nullptr) {
                recordIssue(event.type, event.eventId, "unknown task " + event.taskId);
                return true;
            }
            if (event.episodeId.empty()) {
                recordIssue(event.type, event.eventId, "EpisodeOpened has no episodeId");
                return true;
            }
            // Snapshot/stream overlap.
            if (task->episode(event.episodeId) != nullptr) return true;
            if (task->status != TaskStatus::Active) {
                recordIssue(event.type, event.eventId, "task " + task->id + " is " + toString(task->status));
                return true;
            }
            for (const ExecutionEpisode& episode : task->episodes) {
                if (episode.status == EpisodeStatus::Active) {
                    recordIssue(event.type, event.eventId, "task " + task->id + " already has an open episode");
                    return true;
                }
            }
            const uint64_t ordinal = static_cast<uint64_t>(event.json.integer("ordinal", 0));
            if (ordinal != task->episodes.size() + 1) {
                recordIssue(event.type, event.eventId,
                            "episode ordinal " + std::to_string(ordinal) + " does not follow " +
                                std::to_string(task->episodes.size()));
                return true;
            }
            ExecutionEpisode episode;
            episode.id = event.episodeId;
            episode.taskId = task->id;
            episode.ordinal = ordinal;
            episode.status = EpisodeStatus::Active;
            episode.stage = EpisodeStage::Routing;
            task->episodes.push_back(std::move(episode));
            return true;
        }
        case DomainEventKind::RoutingDecided: {
            const Located l = locate(false);
            if (!l.found) return true;
            Routing routing;
            const json::Value* raw = event.json.object("routing");
            if (raw == nullptr || !readRouting(*raw, routing)) {
                recordIssue(event.type, event.eventId, "RoutingDecided carries no routing");
                return true;
            }
            if (l.episode->routing.has_value()) {
                // Routing is written once; an identical replay is the overlap case.
                if (!sameRouting(*l.episode->routing, routing)) {
                    recordIssue(event.type, event.eventId, "episode " + l.episode->id + " already has routing");
                }
                return true;
            }
            if (!l.active) {
                refuseInactive(l);
                return true;
            }
            l.episode->routing = std::move(routing);
            return true;
        }
        case DomainEventKind::EpisodeBodySelected: {
            const Located l = locate(false);
            if (!l.found) return true;
            ExecutionEpisode* episode = l.episode;
            const EpisodeBodyKind kind = parseEpisodeBodyKind(event.json.string("body"));
            if (episode->body.kind != EpisodeBodyKind::Pending) {
                if (episode->body.kind != kind) {
                    recordIssue(event.type, event.eventId,
                                "episode " + episode->id + " body is already " + toString(episode->body.kind));
                }
                return true;
            }
            if (!l.active) {
                refuseInactive(l);
                return true;
            }
            // The body must be the one routing selected; a disagreement means the
            // record contradicts itself.
            if (episode->routing.has_value()) {
                const RoutingDecision decided = episode->routing->decision;
                const bool agrees = decided == RoutingDecision::Unknown ||
                                    (decided == RoutingDecision::BeliefLoop && kind == EpisodeBodyKind::BeliefLoop) ||
                                    (decided == RoutingDecision::FastPath && kind == EpisodeBodyKind::FastPath);
                if (!agrees) {
                    recordIssue(event.type, event.eventId,
                                std::string("routing selected ") + toString(decided) + ", not " + toString(kind));
                }
            }
            const json::Value* adoption = event.json.find("formulation");
            EpisodeBody body;
            body.kind = kind;
            if (kind == EpisodeBodyKind::BeliefLoop) {
                // A belief-loop episode never carries the adoption itself: its
                // Plan does, so the selection and the dispatch cannot disagree
                // about which version governed them.
                if (adoption != nullptr && !adoption->isNull()) {
                    recordIssue(event.type, event.eventId,
                                "belief-loop episode " + episode->id +
                                    " records its formulation on the plan, not the body");
                }
                body.openBeliefsAtStart = event.json.stringArray("openBeliefsAtStart");
            } else if (kind == EpisodeBodyKind::FastPath) {
                // The fast path has no Plan, so the episode is the only place this
                // can be recorded. An absent field would be indistinguishable from
                // "no version had been formed", which is the distinction that
                // matters, so it is refused rather than defaulted.
                if (adoption == nullptr || adoption->isNull()) {
                    recordIssue(event.type, event.eventId,
                                "fast-path episode " + episode->id +
                                    " does not record which formulation it ran under");
                    return true;
                }
                // A claim of `unformed` made after a version exists is a STALENESS
                // anomaly, not a contradiction: it was true when the runtime
                // emitted it, and a full replay legitimately revisits it. It is
                // recorded as the runtime recorded it, without an issue.
                body.formulation = readFormulationAdoption(*adoption);
            }
            episode->body = std::move(body);
            return true;
        }
        case DomainEventKind::EpisodeClosed: {
            const Located l = locate(false);
            if (!l.found) return true;
            ExecutionEpisode* episode = l.episode;
            if (episode->status == EpisodeStatus::Closed) {
                // Already closed: idempotent. The cursor is still reconciled,
                // because a replay can arrive after a CursorChanged has moved the
                // cursor back onto this episode, and a close must leave it closed.
                if (cursor_.episodeId == episode->id) {
                    cursor_.stage = EpisodeStage::Closed;
                    snapshot_.cursor = cursor_;
                }
                return true;
            }
            if (episode->body.kind == EpisodeBodyKind::Pending) {
                recordIssue(event.type, event.eventId, "episode " + episode->id + " has no selected body");
                return true;
            }
            for (const Execution& execution : episode->body.trajectory) {
                if (execution.status == ExecutionStatus::Running) {
                    recordIssue(event.type, event.eventId, "episode " + episode->id + " has a running execution");
                    return true;
                }
            }
            if (episode->body.kind == EpisodeBodyKind::BeliefLoop && !episode->body.plan.has_value()) {
                recordIssue(event.type, event.eventId, "belief-loop episode " + episode->id + " has no plan");
                return true;
            }
            episode->status = EpisodeStatus::Closed;
            episode->stage = EpisodeStage::Closed;
            // The close mirrors onto the cursor, so the two cannot disagree about
            // an episode that has ended.
            if (cursor_.episodeId == episode->id) {
                cursor_.stage = EpisodeStage::Closed;
                snapshot_.cursor = cursor_;
            }
            return true;
        }
        case DomainEventKind::CursorChanged: {
            Task* task = mutableTask(event.taskId);
            if (task == nullptr) {
                recordIssue(event.type, event.eventId, "unknown task " + event.taskId);
                return true;
            }
            const ExecutionEpisode* episode = task->episode(event.episodeId);
            if (episode == nullptr) {
                recordIssue(event.type, event.eventId, "unknown episode " + event.episodeId);
                return true;
            }
            // Deliberately NO issue for an inactive task or a closed episode. The
            // cursor is the runtime's own statement of where it is, and it is the
            // one field a bootstrap replay routinely sets onto a state that has
            // since moved past it (the snapshot is newer than every buffered
            // line). Raising an issue there would flood the trace panel with
            // phantom problems; the value itself is last-write-wins, so replaying
            // the stream in order converges on the same cursor.
            cursor_.taskId = event.taskId;
            cursor_.episodeId = event.episodeId;
            cursor_.stage = parseEpisodeStage(event.json.string("stage"));
            snapshot_.cursor = cursor_;
            return true;
        }
        case DomainEventKind::InterventionAdded: {
            const Located l = locate(false);
            if (!l.found) return true;
            Intervention intervention;
            const json::Value* raw = event.json.object("intervention");
            if (raw == nullptr || !readIntervention(*raw, intervention)) {
                recordIssue(event.type, event.eventId, "InterventionAdded carries no intervention");
                return true;
            }
            for (const Intervention& existing : l.episode->steering) {
                if (existing.id == intervention.id) {
                    if (!sameIntervention(existing, intervention)) {
                        recordIssue(event.type, event.eventId, "intervention " + intervention.id + " already exists");
                    }
                    return true;
                }
            }
            if (!l.active) {
                refuseInactive(l);
                return true;
            }
            l.episode->steering.push_back(std::move(intervention));
            return true;
        }
        case DomainEventKind::ExperimentSelected: {
            const Located l = locate(false);
            if (!l.found) return true;
            ExperimentSelectionRecord selection;
            const json::Value* raw = event.json.object("selection");
            if (raw == nullptr || !readExperimentSelection(*raw, selection)) {
                recordIssue(event.type, event.eventId, "ExperimentSelected carries no selection");
                return true;
            }
            if (selection.beliefIds.empty()) {
                recordIssue(event.type, event.eventId, "experiment selection has no beliefs");
                return true;
            }
            if (selection.intent.empty()) {
                recordIssue(event.type, event.eventId, "experiment selection has no intent");
                return true;
            }
            // A condition with no next step (or the reverse) is half an intention,
            // which a reader would take for a promise the agent never made.
            if (selection.advancementCondition.has_value() != selection.advancementNext.has_value()) {
                recordIssue(event.type, event.eventId,
                            "advancement must state the condition and the next step together, or neither");
                return true;
            }
            // The belief ids are deliberately not checked against the registry: a
            // selection is a choice, not a commitment. Rejecting one on replay
            // would fail a log over a belief that never became anything. A claim of
            // `unformed` after a version exists is likewise left alone: it was
            // true when emitted, and a replay revisits it.
            //
            // The selection is last-write-wins and carries no id, so there is no
            // way to tell a stale replay from a fresh re-selection; it is applied
            // silently rather than judged.
            l.episode->experimentSelection = std::move(selection);
            return true;
        }
        case DomainEventKind::ExperimentSelectionVoided: {
            const Located l = locate(false);
            if (!l.found) return true;
            if (!l.episode->experimentSelection.has_value()) {
                // The selection is already gone. "Voided" and "never selected"
                // are the same absence here, and an idempotent replay must not
                // raise a phantom issue, so this is a silent no-op rather than the
                // TypeScript fold's `fail`.
                return true;
            }
            if (!l.active) {
                refuseInactive(l);
                return true;
            }
            if (event.json.string("reason").empty()) {
                recordIssue(event.type, event.eventId, "a voided experiment selection needs a reason");
            }
            l.episode->experimentSelection.reset();
            return true;
        }
        default:
            return false;
    }
}

// ---------------------------------------------------------------------------
// Loop applier (TS: applyLoopEvent)
// ---------------------------------------------------------------------------
bool NativeGuiModel::applyLoopEvent(const DomainEvent& event) {
    // TS: requireClassifiedEpisode, split the same way as the episode applier:
    // locate first, judge activity only when the event would actually write.
    struct Located {
        Task* task = nullptr;
        ExecutionEpisode* episode = nullptr;
        bool active = false;
        bool found = false;
    };
    auto locate = [&]() -> Located {
        Located out;
        out.task = mutableTask(event.taskId);
        if (out.task == nullptr) {
            recordIssue(event.type, event.eventId, "unknown task " + event.taskId);
            return out;
        }
        for (ExecutionEpisode& candidate : out.task->episodes) {
            if (candidate.id == event.episodeId) {
                out.episode = &candidate;
                break;
            }
        }
        if (out.episode == nullptr) {
            recordIssue(event.type, event.eventId, "unknown episode " + event.episodeId);
            return out;
        }
        out.found = true;
        out.active = out.task->status == TaskStatus::Active &&
                     out.episode->status == EpisodeStatus::Active &&
                     out.episode->body.kind != EpisodeBodyKind::Pending;
        return out;
    };
    auto refuseInactive = [&](const Located& l) {
        if (l.task->status != TaskStatus::Active) {
            recordIssue(event.type, event.eventId, "task " + l.task->id + " is " + toString(l.task->status));
        } else if (l.episode->status != EpisodeStatus::Active) {
            recordIssue(event.type, event.eventId, "episode " + l.episode->id + " is closed");
        } else {
            recordIssue(event.type, event.eventId, "episode " + l.episode->id + " has no selected body");
        }
    };

    switch (event.kind) {
        case DomainEventKind::BeliefDeltaApplied: {
            const Located l = locate();
            if (!l.found) return true;
            Task* task = l.task;
            ExecutionEpisode* episode = l.episode;
            if (episode->body.kind != EpisodeBodyKind::BeliefLoop) {
                recordIssue(event.type, event.eventId,
                            "fast-path episode " + episode->id + " cannot apply belief deltas");
                return true;
            }
            BeliefDelta delta;
            const json::Value* raw = event.json.object("delta");
            if (raw == nullptr || !readBeliefDelta(*raw, delta)) {
                recordIssue(event.type, event.eventId, "BeliefDeltaApplied carries no delta");
                return true;
            }
            // Snapshot/stream overlap: this mutation is already recorded.
            if (episode->beliefDelta(delta.id) != nullptr) return true;
            if (delta.episodeId != episode->id) {
                recordIssue(event.type, event.eventId,
                            "belief delta " + delta.id + " names episode " + delta.episodeId);
            }
            if (delta.producerPhase != BeliefDeltaProducerPhase::Propose &&
                delta.producerPhase != BeliefDeltaProducerPhase::Distill) {
                recordIssue(event.type, event.eventId, "belief delta " + delta.id + " has invalid producer phase");
            }
            bool carriesResult = false;
            for (const Belief& belief : delta.resultingBeliefs) {
                if (belief.id == delta.resultBeliefId) carriesResult = true;
            }
            if (!carriesResult) {
                recordIssue(event.type, event.eventId,
                            "belief delta " + delta.id + " does not contain result " + delta.resultBeliefId);
                return true;
            }
            if (delta.sourceBeliefId.has_value() && snapshot_.belief(*delta.sourceBeliefId) == nullptr) {
                recordIssue(event.type, event.eventId,
                            "belief delta " + delta.id + " names unknown source " + *delta.sourceBeliefId);
            }
            if (!l.active) {
                refuseInactive(l);
                return true;
            }
            // The registry is the write target of this event and of nothing else.
            for (const Belief& belief : delta.resultingBeliefs) {
                if (belief.id.empty()) continue;
                const bool isNew = snapshot_.belief(belief.id) == nullptr;
                Belief& stored = upsertBelief(belief.id);
                stored = belief;
                stored.id = belief.id;
                if (isNew && !task->hasIntroduced(belief.id)) task->introducedBeliefs.push_back(belief.id);
            }
            const std::vector<BeliefId> active = event.json.stringArray("activeBeliefs");
            for (const BeliefId& beliefId : active) {
                if (snapshot_.belief(beliefId) == nullptr) {
                    recordIssue(event.type, event.eventId, "active belief " + beliefId + " has no record");
                }
            }
            snapshot_.activeBeliefs = active;
            episode->body.beliefDeltas.push_back(std::move(delta));
            // A belief the revision sent back for re-examination is answered by
            // the delta that re-states, replaces, or retracts it — following the
            // refinement chain. Deriving this in the fold keeps "has it been
            // re-examined" answerable from the log alone.
            const BeliefDelta& applied = episode->body.beliefDeltas.back();
            if (task->formulationReview.has_value() && !task->formulationReview->applicability.empty()) {
                for (FormulationApplicabilityEntry& entry : task->formulationReview->applicability) {
                    if (entry.decision != FormulationApplicabilityDecision::NeedsRevalidation) continue;
                    if (entry.revalidatedByDeltaId.has_value()) continue;
                    if (deltaAnswersBelief(applied, entry.beliefId, snapshot_)) {
                        entry.revalidatedByDeltaId = applied.id;
                    }
                }
            }
            return true;
        }
        case DomainEventKind::PlanProduced: {
            const Located l = locate();
            if (!l.found) return true;
            ExecutionEpisode* episode = l.episode;
            if (episode->body.kind != EpisodeBodyKind::BeliefLoop) {
                recordIssue(event.type, event.eventId, "fast-path episode " + episode->id + " cannot own a plan");
                return true;
            }
            Plan plan;
            const json::Value* raw = event.json.object("plan");
            if (raw == nullptr || !readPlan(*raw, plan)) {
                recordIssue(event.type, event.eventId, "PlanProduced carries no plan");
                return true;
            }
            if (episode->body.plan.has_value()) {
                if (!samePlan(*episode->body.plan, plan)) {
                    recordIssue(event.type, event.eventId,
                                "episode " + episode->id + " already has plan " + episode->body.plan->id);
                }
                // The duplicate still reconciles. "A plan exists" implies "no
                // selection is pending" (the plan IS the dispatch that committed
                // it), and the snapshot/stream overlap can reach this branch AFTER
                // a replayed `ExperimentSelected` put the selection back. Skipping
                // the reset here would leave the same log ending in two different
                // states depending on what the snapshot happened to contain —
                // exactly the order-dependence the bootstrap is built to avoid.
                episode->experimentSelection.reset();
                return true;
            }
            for (const BeliefId& beliefId : plan.selectedToExplore) {
                if (snapshot_.belief(beliefId) == nullptr) {
                    recordIssue(event.type, event.eventId, "plan selects unknown belief " + beliefId);
                }
            }
            if (plan.advancementCondition.has_value() != plan.advancementNext.has_value()) {
                recordIssue(event.type, event.eventId,
                            "advancement must state the condition and the next step together, or neither");
                return true;
            }
            if (!l.active) {
                refuseInactive(l);
                return true;
            }
            episode->body.plan = std::move(plan);
            // Dispatching commits the choice, so the selection stops being
            // pending: what remains is the plan.
            episode->experimentSelection.reset();
            return true;
        }
        case DomainEventKind::ExecutionStarted: {
            const Located l = locate();
            if (!l.found) return true;
            ExecutionEpisode* episode = l.episode;
            Execution execution;
            const json::Value* raw = event.json.object("execution");
            if (raw == nullptr || !readExecutionStarted(*raw, execution)) {
                recordIssue(event.type, event.eventId, "ExecutionStarted carries no execution");
                return true;
            }
            for (const Execution& existing : episode->body.trajectory) {
                if (existing.id == execution.id) return true;  // snapshot/stream overlap
            }
            if (episode->body.kind == EpisodeBodyKind::BeliefLoop) {
                if (!episode->body.plan.has_value()) {
                    recordIssue(event.type, event.eventId, "belief-loop episode " + episode->id + " has no plan");
                    return true;
                }
                if (!execution.planId.has_value() || *execution.planId != episode->body.plan->id) {
                    recordIssue(event.type, event.eventId, "execution does not name episode plan");
                    return true;
                }
            } else if (execution.planId.has_value()) {
                recordIssue(event.type, event.eventId, "fast-path execution must not name a plan");
                return true;
            }
            if (!l.active) {
                refuseInactive(l);
                return true;
            }
            // Session file list: read/write/edit carry a path. Kept here rather
            // than in the RPC adapter so the file list follows the same record the
            // graph renders.
            if (execution.tool == "read" || execution.tool == "write" || execution.tool == "edit") {
                std::string path = execution.filePath.value_or("");
                if (path.empty() && raw->object("input") != nullptr) {
                    path = raw->object("input")->string("path");
                    if (path.empty()) path = raw->object("input")->string("file_path");
                }
                recordFileOp(execution.tool, path);
            }
            episode->body.trajectory.push_back(std::move(execution));
            return true;
        }
        case DomainEventKind::ExecutionCompleted: {
            const Located l = locate();
            if (!l.found) return true;
            ExecutionEpisode* episode = l.episode;
            const std::string executionId = event.json.string("executionId");
            Execution* execution = nullptr;
            for (Execution& candidate : episode->body.trajectory) {
                if (candidate.id == executionId) {
                    execution = &candidate;
                    break;
                }
            }
            if (execution == nullptr) {
                recordIssue(event.type, event.eventId, "unknown execution " + executionId);
                return true;
            }
            if (execution->status != ExecutionStatus::Running) {
                // Silent when the replay agrees with what is already recorded (the
                // bootstrap overlap case); an issue only when it contradicts.
                const ExecutionStatus replayed = parseExecutionStatus(event.json.string("status"));
                if (replayed != execution->status) {
                    recordIssue(event.type, event.eventId,
                                "execution " + executionId + " is already " + toString(execution->status));
                }
                return true;
            }
            if (!l.active) {
                refuseInactive(l);
                return true;
            }
            if (!readExecutionCompleted(event.json, *execution)) {
                recordIssue(event.type, event.eventId, "ExecutionCompleted carries no status");
                return true;
            }
            if (execution->status == ExecutionStatus::Failed && !execution->error.has_value()) {
                recordIssue(event.type, event.eventId, "failed execution " + executionId + " has no error");
            }
            // A real execution failure with error text is surfaced in the live
            // in-message area too, so the Frame pane shows why the round stopped.
            if (execution->status == ExecutionStatus::Failed && execution->error.has_value() &&
                !execution->error->empty()) {
                setInMessageError(*execution->error);
            }
            return true;
        }
        case DomainEventKind::DistillationProduced: {
            const Located l = locate();
            if (!l.found) return true;
            ExecutionEpisode* episode = l.episode;
            Distillation distillation;
            const json::Value* raw = event.json.object("distillation");
            if (raw == nullptr || !readDistillation(*raw, distillation)) {
                recordIssue(event.type, event.eventId, "DistillationProduced carries no distillation");
                return true;
            }
            if (episode->body.distillation.has_value()) {
                if (!sameDistillation(*episode->body.distillation, distillation)) {
                    recordIssue(event.type, event.eventId, "episode " + episode->id + " already has distillation");
                }
                return true;
            }
            for (const ExecutionId& input : distillation.inputs) {
                if (episode->execution(input) == nullptr) {
                    recordIssue(event.type, event.eventId,
                                "distillation input " + input + " is not in episode " + episode->id);
                }
            }
            if (episode->body.kind == EpisodeBodyKind::BeliefLoop) {
                // The outputs must be exactly the distill-produced deltas the
                // episode already recorded, in order: a mismatch means the record
                // disagrees with the mutations it claims to have produced.
                std::vector<BeliefDeltaId> expected;
                for (const BeliefDelta& delta : episode->body.beliefDeltas) {
                    if (delta.producerPhase == BeliefDeltaProducerPhase::Distill) expected.push_back(delta.id);
                }
                if (expected != distillation.outputs) {
                    recordIssue(event.type, event.eventId,
                                "distillation outputs must exactly match distill-produced belief deltas");
                }
            } else if (!distillation.outputs.empty()) {
                recordIssue(event.type, event.eventId, "fast-path distillation cannot produce belief deltas");
            }
            if (!l.active) {
                refuseInactive(l);
                return true;
            }
            episode->body.distillation = std::move(distillation);
            return true;
        }
        default:
            return false;
    }
}

// ---------------------------------------------------------------------------
// RPC event adapter (live mode)
// ---------------------------------------------------------------------------
namespace {

// TS: session_status.roleStatus.<slot> — model + latest cache hit rate. The
// telemetry is deliberately thin: no thinking level, no timing, no degraded
// flag, and no finalReport slot at all (docs/milestones.md §3.6).
RoleFooterSlot readRoleSlot(const json::Value& roleStatus, const char* name) {
    RoleFooterSlot slot;
    const json::Value* raw = roleStatus.object(name);
    if (raw == nullptr) return slot;
    if (raw->has("latestCacheHitRate")) {
        slot.cacheHitRate = static_cast<float>(raw->number("latestCacheHitRate", -1.0));
    }
    if (const json::Value* model = raw->object("model")) {
        slot.model = model->string("id");
    }
    return slot;
}

RoleContextUsage readRoleUsage(const json::Value& roleUsage, const char* name) {
    RoleContextUsage usage;
    const json::Value* raw = roleUsage.object(name);
    if (raw == nullptr) return usage;
    if (raw->has("tokens")) usage.tokens = static_cast<long>(raw->number("tokens", -1.0));
    if (raw->has("contextWindow")) usage.contextWindow = static_cast<long>(raw->number("contextWindow", 0.0));
    if (raw->has("percent")) usage.percent = raw->number("percent", -1.0);
    return usage;
}

// TS: AssistantMessage.usage — the token buckets, negative when unreported.
TurnUsage readTurnUsage(const json::Value& message) {
    TurnUsage usage;
    const json::Value* raw = message.object("usage");
    if (raw == nullptr) return usage;
    if (raw->has("input")) usage.input = static_cast<long>(raw->number("input", -1.0));
    if (raw->has("output")) usage.output = static_cast<long>(raw->number("output", -1.0));
    if (raw->has("cacheRead")) usage.cacheRead = static_cast<long>(raw->number("cacheRead", -1.0));
    if (raw->has("cacheWrite")) usage.cacheWrite = static_cast<long>(raw->number("cacheWrite", -1.0));
    return usage;
}

bool sameSlot(const RoleFooterSlot& a, const RoleFooterSlot& b) {
    return a.model == b.model && a.cacheHitRate == b.cacheHitRate;
}

// One domain event, as an observation. `describeDomainEvent` runs AFTER the event
// was applied: the delta that introduces a belief is what gives that belief its
// label, and describing first would print a raw id where the rest of the GUI says
// "B4".
void recordDomainTrace(NativeGuiModel& model, const DomainEvent& event) {
    TraceEntry entry;
    entry.kind = TraceEntry::Kind::Domain;
    entry.type = event.type;
    entry.at = event.timestamp;
    entry.atMs = parseIso8601Millis(event.timestamp);
    entry.taskId = event.taskId;
    entry.episodeId = event.episodeId;

    // A stage is claimed only when the cursor is ACTUALLY there now, and only for
    // the two events that can move it: `CursorChanged` (by its own `stage`) and
    // `EpisodeClosed` (which the fold applies as `closed` — the controller emits
    // no CursorChanged for the final-report role). Reading the cursor back is what
    // keeps an event the fold REFUSED, such as a CursorChanged on a closed
    // episode, from opening a row for a stage that never happened.
    const AgentSessionCursor& cursor = model.cursor();
    if (cursor.valid() && cursor.taskId == event.taskId && cursor.episodeId == event.episodeId &&
        (event.kind == DomainEventKind::CursorChanged || event.kind == DomainEventKind::EpisodeClosed)) {
        entry.stage = cursor.stage;
    }
    entry.text = describeDomainEvent(model, event);
    model.recordTrace(std::move(entry));
}

} // namespace

RpcApplyResult applyRpcLine(NativeGuiModel& model, const std::string& line) {
    json::Value parsed;
    if (!json::parseLine(line, parsed, nullptr)) return RpcApplyResult::Error;
    return applyRpcLine(model, parsed);
}

RpcApplyResult applyRpcLine(NativeGuiModel& model, const json::Value& parsed) {
    if (!parsed.isObject()) return RpcApplyResult::Error;
    const std::string type = parsed.string("type");
    if (type.empty()) return RpcApplyResult::Error;

    // A failed command surfaces in the Frame pane so the user can see why the
    // request was rejected. This is exactly how a refused `approve_frame` — which
    // the contract returns as an error rather than an approval — becomes visible
    // instead of reading as consent (docs/milestones.md §3.4).
    if (type == "response") {
        if (parsed.has("success") && !parsed.boolean("success", true)) {
            std::string message = parsed.string("error");
            if (message.empty()) message = "RPC request failed";
            model.setInMessageError(message);
        }
        return RpcApplyResult::Ignored;
    }

    if (type == "session_status") {
        Footer footer;
        if (const json::Value* roleStatus = parsed.object("roleStatus")) {
            footer.epistemic = readRoleSlot(*roleStatus, "epistemic");
            footer.distillation = readRoleSlot(*roleStatus, "distillation");
            footer.execution = readRoleSlot(*roleStatus, "execution");
            footer.hasData = true;
        }
        footer.sessionCost = parsed.number("cost", 0.0);
        model.setFooter(std::move(footer));

        RoleContextUsagePair usagePair;
        if (const json::Value* roleUsage = parsed.object("roleUsage")) {
            usagePair.epistemic = readRoleUsage(*roleUsage, "epistemic");
            usagePair.execution = readRoleUsage(*roleUsage, "execution");
            usagePair.hasData = true;
        }
        model.setRoleContext(std::move(usagePair));

        // Logged only when a slot CHANGES. This line is emitted after every single
        // event, so recording each one would bury the trace under hundreds of
        // identical rows while telling a row nothing it did not already know.
        if (const Footer& now = model.footer(); now.hasData) {
            const Footer& last = model.lastRoleStatus();
            if (!last.hasData || !sameSlot(now.epistemic, last.epistemic) ||
                !sameSlot(now.distillation, last.distillation) || !sameSlot(now.execution, last.execution)) {
                TraceEntry entry;
                entry.kind = TraceEntry::Kind::Status;
                entry.type = type;
                entry.at = parsed.string("timestamp");
                entry.atMs = parseIso8601Millis(entry.at);
                entry.epistemic = now.epistemic;
                entry.distillation = now.distillation;
                entry.execution = now.execution;
                model.recordTrace(std::move(entry));
                model.setLastRoleStatus(now);
            }
        }
        return RpcApplyResult::Applied;
    }

    // AgentEvent turn boundaries. The domain events are authoritative for episode
    // lifecycles; these only mark a model turn and never open or close one.
    if (type == "agent_start" || type == "turn_start" || type == "turn_end" || type == "agent_settled") {
        // A settled run is the one moment a NEW pause can exist: the reading was
        // published during the run, and the run's boundary is when the runtime
        // stops on it (see `_autoApproveWaitingFrame`, which runs at the same
        // point). Nothing pushes that fact — `awaitingResponse` travels only in a
        // `get_state` body — so ask for one here. This is a re-read, not a poll:
        // it fires on a run boundary, not on a timer.
        if (type == "agent_settled") model.requestStateRefresh();
        return RpcApplyResult::Ignored;
    }

    if (type == "message_start") {
        const json::Value* message = parsed.object("message");
        const std::string role = message != nullptr ? message->string("role") : parsed.string("role");
        if (role == "assistant") {
            const json::Value* content = message != nullptr ? message->find("content") : nullptr;
            model.beginInMessage(content != nullptr ? domainContentText(*content) : std::string{});

            // The dispatch this turn represents: the model that ACTUALLY ran, which
            // is the one column the trace can state without deriving anything. The
            // stage is read from the cursor rather than guessed from the event
            // order — the pane attributes the turn to the stage the cursor is in.
            TraceEntry turn;
            turn.type = type;
            turn.at = parsed.string("timestamp");
            turn.atMs = parseIso8601Millis(turn.at);
            if (message != nullptr) {
                if (const json::Value* modelObj = message->object("model")) {
                    turn.model = modelObj->string("id");
                    turn.provider = modelObj->string("provider");
                }
                turn.thinkingLevel = message->string("providerThinkingLevel");
                turn.usage = readTurnUsage(*message);
                if (turn.at.empty()) {
                    // Some turns timestamp the message instead of the envelope.
                    const json::Value* raw = message->find("timestamp");
                    if (raw != nullptr && raw->isNumber()) {
                        turn.atMs = raw->asInt(-1);
                        turn.at = std::to_string(turn.atMs);
                    }
                }
            }
            const AgentSessionCursor& cursor = model.cursor();
            turn.taskId = cursor.taskId;
            turn.episodeId = cursor.episodeId;
            if (cursor.valid()) turn.stage = cursor.stage;
            model.beginTraceTurn(std::move(turn));
            return RpcApplyResult::Applied;
        }
        if (role == "user") {
            // Clear the previous reply so it does not linger behind the new turn.
            model.beginInMessage("");
            return RpcApplyResult::Applied;
        }
        return RpcApplyResult::Ignored;
    }
    if (type == "message_update") {
        if (const json::Value* delta = parsed.object("assistantMessageEvent")) {
            const std::string deltaType = delta->string("type");
            if (deltaType == "thinking_start") {
                model.setInMessageThinking(true);
                return RpcApplyResult::Applied;
            }
            if (deltaType == "thinking_end" || deltaType == "text_start") {
                model.setInMessageThinking(false);
                return RpcApplyResult::Applied;
            }
            if (deltaType == "text_delta" || deltaType == "thinking_delta") {
                model.appendInMessage(delta->string("delta"));
                return RpcApplyResult::Applied;
            }
        }
        return RpcApplyResult::Ignored;
    }
    if (type == "message_end") {
        // A model-stream failure arrives as an assistant message whose stopReason
        // is "error". The DOM reads the message object's OWN members, so a
        // same-named key nested inside content (a toolCall argument called
        // stopReason, say) can never shadow it.
        if (const json::Value* message = parsed.object("message")) {
            if (message->string("role") == "assistant") {
                TraceEntry closing;
                closing.endedAt = parsed.string("timestamp");
                closing.endedAtMs = parseIso8601Millis(closing.endedAt);
                closing.stopReason = message->string("stopReason");
                closing.errorMessage = message->string("errorMessage");
                closing.usage = readTurnUsage(*message);
                if (closing.endedAt.empty()) {
                    const json::Value* raw = message->find("timestamp");
                    if (raw != nullptr && raw->isNumber()) {
                        closing.endedAtMs = raw->asInt(-1);
                        closing.endedAt = std::to_string(closing.endedAtMs);
                    }
                }
                model.endTraceTurn(std::move(closing));
            }
            if (message->string("role") == "assistant" && message->string("stopReason") == "error") {
                std::string text = message->string("errorMessage");
                if (text.empty()) text = "Request failed";
                model.setInMessageError(text);
            }
        }
        model.endInMessage();
        return RpcApplyResult::Applied;
    }

    // Tool-call telemetry feeds the session file list only; the execution
    // trajectory is built from the domain ExecutionStarted/Completed events, so a
    // non-probe tool never appears as an execution.
    if (type == "tool_execution_start") {
        const std::string tool = parsed.string("toolName");
        if (tool == "read" || tool == "write" || tool == "edit") {
            std::string path;
            if (const json::Value* args = parsed.object("args")) {
                path = args->string("path");
                if (path.empty()) path = args->string("file_path");
            }
            model.recordFileOp(tool, path);
        }
        return RpcApplyResult::Applied;
    }
    if (type == "tool_execution_end") return RpcApplyResult::Ignored;

    // Domain events. The line was already parsed once; reuse the DOM rather than
    // re-parsing it.
    DomainEvent event;
    if (parseDomainEvent(parsed, event) == DomainParseResult::Parsed) {
        model.applyDomainEvent(event);
        // Recorded AFTER applying, because the detail line renders belief ids
        // through the label the registry derives from record order — and a delta
        // that introduces a belief is what puts that belief in the registry.
        recordDomainTrace(model, event);
        return RpcApplyResult::Applied;
    }
    return RpcApplyResult::Ignored;
}

} // namespace pie::gui
