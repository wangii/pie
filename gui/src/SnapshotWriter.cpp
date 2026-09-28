#include "SnapshotWriter.h"

#include <cstdio>

#include "DomainEvents.h"

namespace pie::gui {

namespace {

// A minimal JSON emitter. Values go out in the order the writer writes them,
// which is what keeps a dump diffable: the same state always produces the same
// bytes.
class Emitter {
public:
    void objStart() {
        prefix();
        out_ += '{';
        needComma_.push_back(false);
    }
    void objEnd() {
        out_ += '}';
        needComma_.pop_back();
    }
    void arrStart() {
        prefix();
        out_ += '[';
        needComma_.push_back(false);
    }
    void arrEnd() {
        out_ += ']';
        needComma_.pop_back();
    }

    // A member name. Suppresses the comma for the value that follows, so
    // `key("a"); str("b")` emits `"a":"b"` rather than `"a","b"`.
    void key(const char* name) {
        prefix();
        writeString(name);
        out_ += ':';
        if (!needComma_.empty()) needComma_.back() = false;
    }

    void str(const std::string& value) {
        prefix();
        writeString(value);
    }
    void num(long long value) {
        prefix();
        out_ += std::to_string(value);
    }
    void num(unsigned long long value) {
        prefix();
        out_ += std::to_string(value);
    }
    void numSize(size_t value) {
        prefix();
        out_ += std::to_string(value);
    }
    void numDouble(double value) {
        prefix();
        char buf[32];
        // %.6g is enough for a probability, and unlike a locale-aware formatter
        // it cannot emit a decimal comma that would make the line invalid JSON.
        std::snprintf(buf, sizeof(buf), "%.6g", value);
        out_ += buf;
    }
    void boolean(bool value) {
        prefix();
        out_ += value ? "true" : "false";
    }
    void null() {
        prefix();
        out_ += "null";
    }

    std::string take() { return std::move(out_); }

private:
    void prefix() {
        if (needComma_.empty()) return;
        if (needComma_.back()) out_ += ',';
        needComma_.back() = true;
    }

    void writeString(const std::string& value) {
        out_ += '"';
        for (char c : value) {
            switch (c) {
                case '"': out_ += "\\\""; break;
                case '\\': out_ += "\\\\"; break;
                case '\b': out_ += "\\b"; break;
                case '\f': out_ += "\\f"; break;
                case '\n': out_ += "\\n"; break;
                case '\r': out_ += "\\r"; break;
                case '\t': out_ += "\\t"; break;
                default:
                    if (static_cast<unsigned char>(c) < 0x20u) {
                        char buf[8];
                        std::snprintf(buf, sizeof(buf), "\\u%04x",
                                      static_cast<unsigned int>(static_cast<unsigned char>(c)));
                        out_ += buf;
                    } else {
                        out_ += c;
                    }
            }
        }
        out_ += '"';
    }

    std::string out_;
    std::vector<bool> needComma_;
};

void writeStrings(Emitter& e, const std::vector<std::string>& values) {
    e.arrStart();
    for (const std::string& value : values) e.str(value);
    e.arrEnd();
}

void writeSource(Emitter& e, const FormulationSource& source) {
    e.objStart();
    e.key("kind");
    e.str(toString(source.kind));
    switch (source.kind) {
        case FormulationSourceKind::Prompt:
            e.key("promptId");
            e.str(source.promptId);
            break;
        case FormulationSourceKind::Intervention:
            e.key("interventionId");
            e.str(source.interventionId);
            break;
        case FormulationSourceKind::Correction:
            e.key("correctionId");
            e.str(source.correctionId);
            break;
        case FormulationSourceKind::Execution:
            e.key("executionId");
            e.str(source.executionId);
            break;
        case FormulationSourceKind::Distillation:
            e.key("distillationId");
            e.str(source.distillationId);
            break;
        case FormulationSourceKind::Belief:
            // Cited with its delta, always: the id alone would read today's
            // state back into a past decision (see readFormulationSource).
            e.key("beliefId");
            e.str(source.beliefId);
            e.key("beliefDeltaId");
            e.str(source.beliefDeltaId);
            break;
        case FormulationSourceKind::Unknown:
            break;
    }
    e.objEnd();
}

void writeSources(Emitter& e, const char* key, const std::vector<FormulationSource>& sources) {
    e.key(key);
    e.arrStart();
    for (const FormulationSource& source : sources) writeSource(e, source);
    e.arrEnd();
}

void writeBelief(Emitter& e, const Belief& belief) {
    e.objStart();
    e.key("id");
    e.str(belief.id);
    e.key("statement");
    e.str(belief.statement);
    e.key("domain");
    e.str(toString(belief.domain));
    e.key("expectation");
    e.str(belief.expectation);
    e.key("evidenceRounds");
    e.num(static_cast<long long>(belief.evidenceRounds));
    e.key("skillRefs");
    writeStrings(e, belief.skillRefs);
    // The evidence records are `{evidence: string}` objects on the wire.
    auto evidence = [&](const char* field, const std::vector<std::string>& entries) {
        e.key(field);
        e.arrStart();
        for (const std::string& entry : entries) {
            e.objStart();
            e.key("evidence");
            e.str(entry);
            e.objEnd();
        }
        e.arrEnd();
    };
    evidence("supportedBy", belief.supportedBy);
    evidence("refutedBy", belief.refutedBy);
    evidence("inconclusiveBy", belief.inconclusiveBy);
    if (belief.supersededBy.has_value()) {
        e.key("supersededBy");
        e.str(*belief.supersededBy);
    }
    e.key("withdrawn");
    e.boolean(belief.withdrawn);
    e.objEnd();
}

void writeAdvancement(Emitter& e, const std::optional<std::string>& action,
                      const std::optional<std::string>& condition,
                      const std::optional<std::string>& next) {
    if (!action.has_value()) return;
    e.key("advancement");
    e.objStart();
    e.key("action");
    e.str(*action);
    if (condition.has_value()) {
        e.key("condition");
        e.str(*condition);
    }
    if (next.has_value()) {
        e.key("next");
        e.str(*next);
    }
    e.objEnd();
}

void writeAdoption(Emitter& e, const char* key, const FormulationAdoption& adoption) {
    e.key(key);
    e.objStart();
    e.key("kind");
    e.str(adoption.kind == FormulationAdoptionKind::Version ? "version" : "unformed");
    if (adoption.kind == FormulationAdoptionKind::Version) {
        e.key("versionId");
        e.str(adoption.versionId);
    }
    e.objEnd();
}

void writeRouting(Emitter& e, const Routing& routing) {
    e.key("routing");
    e.objStart();
    e.key("id");
    e.str(routing.id);
    e.key("statement");
    e.str(routing.statement);
    e.key("decision");
    e.str(toString(routing.decision));
    e.key("suitabilityProbability");
    e.numDouble(routing.suitabilityProbability);
    e.key("successProbability");
    e.numDouble(routing.successProbability);
    e.key("estimatedSteps");
    e.num(static_cast<long long>(routing.estimatedSteps));
    e.key("difficulty");
    e.str(toString(routing.difficulty));
    e.key("reason");
    e.str(routing.reason);
    e.objEnd();
}

void writePlan(Emitter& e, const Plan& plan) {
    e.key("plan");
    e.objStart();
    e.key("id");
    e.str(plan.id);
    e.key("selectedToExplore");
    writeStrings(e, plan.selectedToExplore);
    if (plan.intent.has_value()) {
        e.key("intent");
        e.str(*plan.intent);
    }
    writeAdvancement(e, plan.advancementAction, plan.advancementCondition, plan.advancementNext);
    writeAdoption(e, "formulation", plan.formulation);
    e.objEnd();
}

void writeDistillation(Emitter& e, const Distillation& distillation) {
    e.key("distillation");
    e.objStart();
    e.key("id");
    e.str(distillation.id);
    e.key("inputs");
    writeStrings(e, distillation.inputs);
    e.key("contents");
    e.str(distillation.contents);
    e.key("outputs");
    writeStrings(e, distillation.outputs);
    e.objEnd();
}

void writeDelta(Emitter& e, const BeliefDelta& delta) {
    e.objStart();
    e.key("id");
    e.str(delta.id);
    e.key("episodeId");
    e.str(delta.episodeId);
    if (delta.distillationId.has_value()) {
        e.key("distillationId");
        e.str(*delta.distillationId);
    }
    e.key("producerPhase");
    e.str(toString(delta.producerPhase));
    e.key("operation");
    e.str(toString(delta.operation));
    if (delta.sourceBeliefId.has_value()) {
        e.key("sourceBeliefId");
        e.str(*delta.sourceBeliefId);
    }
    e.key("resultBeliefId");
    e.str(delta.resultBeliefId);
    if (delta.beliefId.has_value()) {
        e.key("beliefId");
        e.str(*delta.beliefId);
    }
    if (delta.evidence.has_value()) {
        e.key("evidence");
        e.str(*delta.evidence);
    }
    e.key("resultingBeliefs");
    e.arrStart();
    for (const Belief& belief : delta.resultingBeliefs) writeBelief(e, belief);
    e.arrEnd();
    e.objEnd();
}

void writeExecution(Emitter& e, const Execution& execution) {
    e.objStart();
    e.key("id");
    e.str(execution.id);
    if (execution.planId.has_value()) {
        e.key("planId");
        e.str(*execution.planId);
    }
    e.key("intention");
    e.str(execution.intention);
    e.key("tool");
    e.str(execution.tool);
    // `input` on the wire is a JsonValue; the model keeps only a one-line
    // summary. Writing the summary as a string re-reads to the same summary.
    e.key("input");
    e.str(execution.inputSummary);
    e.key("output");
    e.str(execution.outputPreview);
    e.key("status");
    e.str(toString(execution.status));
    if (execution.error.has_value()) {
        e.key("error");
        e.str(*execution.error);
    }
    if (execution.filePath.has_value()) {
        e.key("filePath");
        e.str(*execution.filePath);
    }
    e.objEnd();
}

void writeIntervention(Emitter& e, const Intervention& intervention) {
    e.objStart();
    e.key("id");
    e.str(intervention.id);
    e.key("contents");
    e.str(intervention.contents);
    e.key("stage");
    e.str(toString(intervention.stage));
    if (intervention.afterExecution.has_value()) {
        e.key("afterExecution");
        e.str(*intervention.afterExecution);
    }
    e.key("createdAt");
    e.str(intervention.createdAt);
    e.objEnd();
}

void writeBody(Emitter& e, const EpisodeBody& body) {
    e.key("body");
    e.objStart();
    e.key("kind");
    e.str(toString(body.kind));
    if (body.kind == EpisodeBodyKind::BeliefLoop) {
        e.key("openBeliefsAtStart");
        writeStrings(e, body.openBeliefsAtStart);
        if (body.plan.has_value()) writePlan(e, *body.plan);
        e.key("beliefDeltas");
        e.arrStart();
        for (const BeliefDelta& delta : body.beliefDeltas) writeDelta(e, delta);
        e.arrEnd();
    }
    if (body.kind == EpisodeBodyKind::FastPath && body.formulation.has_value()) {
        writeAdoption(e, "formulation", *body.formulation);
    }
    // Shared by both classified kinds.
    e.key("trajectory");
    e.arrStart();
    for (const Execution& execution : body.trajectory) writeExecution(e, execution);
    e.arrEnd();
    if (body.distillation.has_value()) writeDistillation(e, *body.distillation);
    e.objEnd();
}

void writeEpisode(Emitter& e, const ExecutionEpisode& episode) {
    e.objStart();
    e.key("id");
    e.str(episode.id);
    e.key("taskId");
    e.str(episode.taskId);
    e.key("ordinal");
    e.num(episode.ordinal);
    e.key("status");
    e.str(toString(episode.status));
    e.key("stage");
    e.str(toString(episode.stage));
    e.key("steering");
    e.arrStart();
    for (const Intervention& intervention : episode.steering) writeIntervention(e, intervention);
    e.arrEnd();
    if (episode.routing.has_value()) writeRouting(e, *episode.routing);
    if (episode.experimentSelection.has_value()) {
        const ExperimentSelectionRecord& selection = *episode.experimentSelection;
        e.key("experimentSelection");
        e.objStart();
        e.key("intent");
        e.str(selection.intent);
        e.key("beliefIds");
        writeStrings(e, selection.beliefIds);
        writeAdvancement(e, selection.advancementAction, selection.advancementCondition,
                         selection.advancementNext);
        writeAdoption(e, "formulation", selection.formulation);
        e.objEnd();
    }
    writeBody(e, episode.body);
    e.objEnd();
}

void writeVersion(Emitter& e, const ProblemFormulationVersion& version) {
    e.objStart();
    e.key("id");
    e.str(version.id);
    e.key("taskId");
    e.str(version.taskId);
    e.key("ordinal");
    e.num(version.ordinal);
    if (version.previousVersionId.has_value()) {
        e.key("previousVersionId");
        e.str(*version.previousVersionId);
    }
    e.key("recordedAt");
    e.str(version.recordedAt);
    e.key("origin");
    e.str(version.origin);
    e.key("content");
    e.objStart();
    e.key("interpretation");
    e.str(version.content.interpretation);
    if (version.content.alternative.has_value()) {
        e.key("alternative");
        e.str(*version.content.alternative);
    }
    e.key("focus");
    e.str(version.content.focus);
    if (version.content.tension.has_value()) {
        e.key("tension");
        e.str(*version.content.tension);
    }
    e.key("implication");
    e.str(version.content.implication);
    e.objEnd();
    e.key("reason");
    e.str(version.reason);
    writeSources(e, "sources", version.sources);
    e.objEnd();
}

void writeDeferral(Emitter& e, const FormulationDeferral& deferral) {
    e.key("deferral");
    e.objStart();
    e.key("missingInformation");
    e.str(deferral.missingInformation);
    e.key("reason");
    e.str(deferral.reason);
    writeSources(e, "sources", deferral.sources);
    e.key("deferredAt");
    e.str(deferral.deferredAt);
    e.key("answeredThroughEpisodeOrdinal");
    e.num(deferral.answeredThroughEpisodeOrdinal);
    e.objEnd();
}

void writeCorrection(Emitter& e, const FormulationCorrection& correction) {
    e.objStart();
    e.key("id");
    e.str(correction.id);
    e.key("taskId");
    e.str(correction.taskId);
    if (correction.targetVersionId.has_value()) {
        e.key("targetVersionId");
        e.str(*correction.targetVersionId);
    }
    e.key("original");
    e.str(correction.original);
    e.key("receivedAt");
    e.str(correction.receivedAt);
    e.key("status");
    e.str(toString(correction.status));
    if (correction.response.has_value()) {
        e.key("response");
        e.str(*correction.response);
    }
    if (correction.recordedVersionId.has_value()) {
        e.key("recordedVersionId");
        e.str(*correction.recordedVersionId);
    }
    e.objEnd();
}

void writeReview(Emitter& e, const FormulationReview& review) {
    e.key("formulationReview");
    e.objStart();
    e.key("versionId");
    e.str(review.versionId);
    if (review.responseCorrectionId.has_value()) {
        e.key("responseCorrectionId");
        e.str(*review.responseCorrectionId);
    }
    if (review.approval.has_value()) {
        e.key("approval");
        e.objStart();
        e.key("versionId");
        e.str(review.approval->versionId);
        e.key("approvedAt");
        e.str(review.approval->approvedAt);
        e.objEnd();
    }
    e.key("focusReviewed");
    e.boolean(review.focusReviewed);
    e.key("scopedBeliefIds");
    writeStrings(e, review.scopedBeliefIds);
    e.key("introducedAtRevision");
    e.numSize(review.introducedAtRevision);
    e.key("applicability");
    e.arrStart();
    for (const FormulationApplicabilityEntry& entry : review.applicability) {
        e.objStart();
        e.key("beliefId");
        e.str(entry.beliefId);
        e.key("decision");
        e.str(toString(entry.decision));
        e.key("reason");
        e.str(entry.reason);
        // Both of these are fold state, not event payload — but the reader reads
        // them, so a dump that omitted them would reload differently.
        if (entry.revalidatedByDeltaId.has_value()) {
            e.key("revalidatedByDeltaId");
            e.str(*entry.revalidatedByDeltaId);
        }
        e.key("stale");
        e.boolean(entry.stale);
        e.objEnd();
    }
    e.arrEnd();
    e.objEnd();
}

void writeRecheck(Emitter& e, const FormulationRecheck& recheck) {
    e.key("formulationRecheck");
    e.objStart();
    e.key("episodeId");
    e.str(recheck.episodeId);
    e.key("verdict");
    e.str(toString(recheck.verdict));
    e.key("reason");
    e.str(recheck.reason);
    if (recheck.versionId.has_value()) {
        e.key("versionId");
        e.str(*recheck.versionId);
    }
    e.key("recordedAt");
    e.str(recheck.recordedAt);
    e.objEnd();
}

void writeTask(Emitter& e, const Task& task) {
    e.objStart();
    e.key("id");
    e.str(task.id);
    if (task.parentTaskId.has_value()) {
        e.key("parentTaskId");
        e.str(*task.parentTaskId);
    }
    e.key("initialPrompt");
    e.objStart();
    e.key("id");
    e.str(task.initialPrompt.id);
    e.key("original");
    e.str(task.initialPrompt.original);
    e.key("effective");
    e.str(task.initialPrompt.effective);
    e.objEnd();
    if (task.initialTarget.has_value()) {
        e.key("initialTarget");
        e.objStart();
        e.key("id");
        e.str(task.initialTarget->id);
        e.key("statement");
        e.str(task.initialTarget->statement);
        e.objEnd();
    }
    e.key("status");
    e.str(toString(task.status));
    e.key("inheritedBeliefs");
    writeStrings(e, task.inheritedBeliefs);
    e.key("introducedBeliefs");
    writeStrings(e, task.introducedBeliefs);
    e.key("episodes");
    e.arrStart();
    for (const ExecutionEpisode& episode : task.episodes) writeEpisode(e, episode);
    e.arrEnd();
    e.key("focus");
    writeStrings(e, task.focus);
    e.key("focusDeclared");
    e.boolean(task.focusDeclared);
    if (task.formulationReview.has_value()) writeReview(e, *task.formulationReview);
    if (task.taskOutcome.has_value()) {
        e.key("taskOutcome");
        e.objStart();
        e.key("result");
        e.str(task.taskOutcome->result);
        e.key("evidence");
        e.str(task.taskOutcome->evidence);
        e.key("blockers");
        e.str(task.taskOutcome->blockers);
        e.objEnd();
    }
    e.key("formulations");
    e.arrStart();
    for (const ProblemFormulationVersion& version : task.formulations) writeVersion(e, version);
    e.arrEnd();
    if (task.formulationDeferral.has_value()) writeDeferral(e, *task.formulationDeferral);
    e.key("formulationCorrections");
    e.arrStart();
    for (const FormulationCorrection& correction : task.formulationCorrections) {
        writeCorrection(e, correction);
    }
    e.arrEnd();
    if (task.formulationRecheck.has_value()) writeRecheck(e, *task.formulationRecheck);
    e.objEnd();
}

void writeSnapshot(Emitter& e, const NativeGuiModel& model) {
    const AgentSessionSnapshot& snapshot = model.snapshot();
    e.objStart();
    e.key("sessionId");
    e.str(snapshot.id);
    e.key("activeBranchTasks");
    writeStrings(e, snapshot.activeBranchTasks);
    // Arrays, not objects: the RPC handler spreads the Maps, so the wire order is
    // the record order the display labels derive from.
    e.key("tasks");
    e.arrStart();
    for (const TaskId& id : snapshot.taskOrder) {
        const Task* task = snapshot.task(id);
        if (task != nullptr) writeTask(e, *task);
    }
    e.arrEnd();
    e.key("beliefs");
    e.arrStart();
    for (const BeliefId& id : snapshot.beliefOrder) {
        const Belief* belief = snapshot.belief(id);
        if (belief != nullptr) writeBelief(e, *belief);
    }
    e.arrEnd();
    e.key("activeBeliefs");
    writeStrings(e, snapshot.activeBeliefs);
    if (model.cursor().valid()) {
        e.key("cursor");
        e.objStart();
        e.key("taskId");
        e.str(model.cursor().taskId);
        e.key("episodeId");
        e.str(model.cursor().episodeId);
        e.key("stage");
        e.str(toString(model.cursor().stage));
        e.objEnd();
    }
    e.objEnd();
}

} // namespace

std::string writeDomainSnapshotData(const NativeGuiModel& model) {
    Emitter e;
    writeSnapshot(e, model);
    return e.take();
}

std::string writeDomainSnapshotLine(const NativeGuiModel& model, const std::string& requestId) {
    Emitter e;
    e.objStart();
    e.key("type");
    e.str("response");
    e.key("id");
    e.str(requestId);
    e.key("command");
    e.str("get_domain_snapshot");
    e.key("success");
    e.boolean(true);
    e.key("data");
    writeSnapshot(e, model);
    e.objEnd();
    return e.take();
}

} // namespace pie::gui
