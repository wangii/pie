#include "ModelDump.h"

#include <cstdio>

namespace pie::gui {

namespace {

// One line, indented by `depth` two-space steps. Every writer goes through this
// so the dump cannot develop an inconsistent indent.
class Writer {
public:
    explicit Writer(std::string& out) : out_(out) {}

    void line(int depth, const std::string& text) {
        for (int i = 0; i < depth; ++i) out_ += "  ";
        out_ += text;
        out_ += '\n';
    }

    // "key: value" with an explicit marker for "the runtime did not say" — the
    // dump must not let an absent value look like an empty one.
    void field(int depth, const char* key, const std::string& value) {
        line(depth, std::string(key) + ": " + (value.empty() ? std::string("—") : value));
    }

    void field(int depth, const char* key, bool value) {
        line(depth, std::string(key) + ": " + (value ? "yes" : "no"));
    }
    void field(int depth, const char* key, unsigned long long value) {
        line(depth, std::string(key) + ": " + std::to_string(value));
    }
    void field(int depth, const char* key, long long value) {
        line(depth, std::string(key) + ": " + std::to_string(value));
    }
    void field(int depth, const char* key, size_t value) {
        line(depth, std::string(key) + ": " + std::to_string(value));
    }

    // A list of ids as one line. An empty list prints "—" rather than nothing, so
    // "no sources" is never confused with "this line was not written".
    void ids(int depth, const char* key, const std::vector<std::string>& values) {
        std::string joined;
        for (size_t i = 0; i < values.size(); ++i) {
            if (i != 0) joined += ",";
            joined += values[i];
        }
        field(depth, key, joined.empty() ? std::string("—") : joined);
    }

    // Collapse a possibly multi-line string to one line so the dump stays
    // line-oriented; the escape is visible rather than silent.
    static std::string oneLine(const std::string& text, size_t max = 160) {
        std::string out;
        out.reserve(text.size());
        for (char c : text) {
            if (c == '\n') out += "\\n";
            else if (c == '\r') out += "\\r";
            else if (c == '\t') out += "\\t";
            else out += c;
            if (out.size() >= max) {
                out += "…";
                break;
            }
        }
        return out;
    }

private:
    std::string& out_;
};

std::string beliefLabelOf(const NativeGuiModel& model, const BeliefId& id) {
    if (id.empty()) return "—";
    return model.beliefLabel(id);
}

std::string adoptionText(const FormulationAdoption& adoption) {
    if (adoption.kind == FormulationAdoptionKind::Unformed) return "unformed";
    return adoption.versionId;
}

void dumpEpisode(const NativeGuiModel& model, Writer& w, const ExecutionEpisode& episode, int depth) {
    w.line(depth, "episode " + episode.id + " [episode " + std::to_string(episode.ordinal) + "]" +
                      std::string(" status=") + toString(episode.status) +
                      " stage=" + toString(episode.stage));
    ++depth;
    if (episode.routing.has_value()) {
        const Routing& routing = *episode.routing;
        w.line(depth, std::string("routing: ") + toString(routing.decision) +
                          " difficulty=" + toString(routing.difficulty) +
                          " p=" + std::to_string(routing.suitabilityProbability));
    } else {
        w.line(depth, "routing: —");
    }
    if (episode.experimentSelection.has_value()) {
        w.line(depth, "experiment-selection: " + Writer::oneLine(episode.experimentSelection->intent));
        w.ids(depth, "  selecting", episode.experimentSelection->beliefIds);
    } else {
        w.line(depth, "experiment-selection: —");
    }
    w.line(depth, std::string("body: ") + toString(episode.body.kind));
    if (episode.body.plan.has_value()) {
        const Plan& plan = *episode.body.plan;
        w.line(depth, "  plan " + plan.id +
                          (plan.intent.has_value() ? " intent=\"" + Writer::oneLine(*plan.intent) + "\"" : ""));
        w.ids(depth, "    selects", plan.selectedToExplore);
        w.field(depth, "    adoption", adoptionText(plan.formulation));
    } else {
        w.line(depth, "  plan: —");
    }
    w.ids(depth, "  open-beliefs-at-start", episode.body.openBeliefsAtStart);
    if (episode.body.formulation.has_value()) {
        w.field(depth, "  formulation", adoptionText(*episode.body.formulation));
    }
    if (episode.body.trajectory.empty()) {
        w.line(depth, "  executions: —");
    }
    for (const Execution& execution : episode.body.trajectory) {
        w.line(depth, "  execution " + execution.id + " tool=" + execution.tool +
                          " status=" + toString(execution.status) +
                          (execution.planId.has_value() ? " plan=" + *execution.planId : " plan=—"));
        if (!execution.intention.empty()) {
            w.line(depth, "    intention: " + Writer::oneLine(execution.intention));
        }
        w.line(depth, "    output: " + std::to_string(execution.outputBytes) + " bytes, preview " +
                          std::to_string(execution.outputPreview.size()) + " chars");
        if (execution.error.has_value()) {
            w.line(depth, "    error: " + Writer::oneLine(*execution.error));
        }
    }
    if (episode.body.distillation.has_value()) {
        const Distillation& distillation = *episode.body.distillation;
        w.line(depth, "  distillation " + distillation.id);
        w.ids(depth, "    inputs", distillation.inputs);
        w.ids(depth, "    outputs", distillation.outputs);
    } else {
        w.line(depth, "  distillation: —");
    }
    if (episode.body.beliefDeltas.empty()) {
        w.line(depth, "  belief-deltas: —");
    }
    for (const BeliefDelta& delta : episode.body.beliefDeltas) {
        w.line(depth, "  delta " + delta.id + " op=" + toString(delta.operation) +
                          " phase=" + toString(delta.producerPhase) +
                          " source=" + beliefLabelOf(model, delta.sourceBeliefId.value_or("")) +
                          " result=" + beliefLabelOf(model, delta.resultBeliefId));
    }
    if (episode.steering.empty()) {
        w.line(depth, "  steering: —");
    }
    for (const Intervention& intervention : episode.steering) {
        w.line(depth, "  steering " + intervention.id + " at=" + toString(intervention.stage) +
                          " \"" + Writer::oneLine(intervention.contents) + "\"");
    }
}

} // namespace

std::string dumpTask(const NativeGuiModel& model, const Task& task) {
    std::string out;
    Writer w(out);
    w.line(0, "task " + task.id + " status=" + toString(task.status) +
                  (task.parentTaskId.has_value() ? " parent=" + *task.parentTaskId : ""));
    w.field(1, "prompt", Writer::oneLine(task.initialPrompt.original));
    if (task.initialTarget.has_value()) {
        w.field(1, "target", Writer::oneLine(task.initialTarget->statement));
    }
    // `focusDeclared` is printed beside the slice because "declared and empty" and
    // "never declared" are different facts (docs/milestones.md §7.1).
    std::string focus;
    for (size_t i = 0; i < task.focus.size(); ++i) {
        if (i != 0) focus += ",";
        focus += beliefLabelOf(model, task.focus[i]);
    }
    w.line(1, "focus: " + std::string(task.focusDeclared ? "declared" : "undeclared") +
                  " [" + (focus.empty() ? std::string("—") : focus) + "]");
    w.ids(1, "inherited", task.inheritedBeliefs);
    w.ids(1, "introduced", task.introducedBeliefs);

    if (task.taskOutcome.has_value() && task.taskOutcome->present()) {
        w.field(1, "outcome", Writer::oneLine(task.taskOutcome->result));
        w.field(1, "  evidence", Writer::oneLine(task.taskOutcome->evidence));
        w.field(1, "  blockers", Writer::oneLine(task.taskOutcome->blockers));
    } else {
        w.line(1, "outcome: —");
    }

    if (task.formulations.empty()) {
        w.line(1, "formulations: —");
    }
    for (const ProblemFormulationVersion& version : task.formulations) {
        w.line(1, "Fv" + std::to_string(version.ordinal) + " " + version.id +
                      (version.previousVersionId.has_value() ? " prev=" + *version.previousVersionId : "") +
                      " at=" + version.recordedAt);
        w.field(2, "interpretation", Writer::oneLine(version.content.interpretation));
        if (version.content.alternative.has_value()) {
            w.field(2, "alternative", Writer::oneLine(*version.content.alternative));
        }
        w.field(2, "focus", Writer::oneLine(version.content.focus));
        if (version.content.tension.has_value()) {
            w.field(2, "tension", Writer::oneLine(*version.content.tension));
        }
        w.field(2, "implication", Writer::oneLine(version.content.implication));
        w.field(2, "reason", Writer::oneLine(version.reason));
        w.field(2, "sources", std::to_string(version.sources.size()));
    }

    if (task.formulationReview.has_value()) {
        const FormulationReview& review = *task.formulationReview;
        w.line(1, "review: version=" + review.versionId +
                      (review.approval.has_value() ? " approved=" + review.approval->approvedAt
                                                   : " approved=—"));
        w.ids(2, "scoped", review.scopedBeliefIds);
        for (const FormulationApplicabilityEntry& entry : review.applicability) {
            w.line(2, "applicability " + beliefLabelOf(model, entry.beliefId) +
                          " = " + toString(entry.decision) +
                          (entry.stale ? " (stale)" : "") +
                          (entry.revalidatedByDeltaId.has_value() ? " revalidated" : ""));
        }
    } else {
        w.line(1, "review: —");
    }

    if (task.formulationDeferral.has_value()) {
        w.line(1, "deferral: " + Writer::oneLine(task.formulationDeferral->reason));
    } else {
        w.line(1, "deferral: —");
    }

    {
        // The gate facts, all derived — never read off a stored flag.
        w.line(1, "owes: decision=" + std::string(formulationDecisionOwed(task) ? "yes" : "no") +
                      " recheck=" + std::string(formulationRecheckOwed(task) ? "yes" : "no") +
                      " first=" + std::string(firstFormulationDecisionOwed(task) ? "yes" : "no"));
        w.ids(1, "pending-applicability", pendingApplicabilityBeliefs(task));
        std::vector<std::string> unrevalidated;
        for (const FormulationApplicabilityEntry* entry : unrevalidatedApplicability(task)) {
            unrevalidated.push_back(entry->beliefId);
        }
        w.ids(1, "unrevalidated", unrevalidated);
    }

    for (size_t i = 0; i < task.formulationCorrections.size(); ++i) {
        const FormulationCorrection& correction = task.formulationCorrections[i];
        w.line(1, "correction " + correction.id + " [" + toString(correction.status) + "] \"" +
                      Writer::oneLine(correction.original) + "\"");
        if (correction.response.has_value()) {
            w.field(2, "response", Writer::oneLine(*correction.response));
        }
        if (correction.recordedVersionId.has_value()) {
            w.field(2, "recorded", *correction.recordedVersionId);
        }
    }

    if (task.formulationRecheck.has_value()) {
        w.line(1, "recheck: " + std::string(toString(task.formulationRecheck->verdict)) +
                      " episode=" + task.formulationRecheck->episodeId);
    } else {
        w.line(1, "recheck: —");
    }

    if (task.episodes.empty()) {
        w.line(1, "episodes: —");
    }
    for (const ExecutionEpisode& episode : task.episodes) {
        dumpEpisode(model, w, episode, 1);
    }
    return out;
}

std::string dumpModel(const NativeGuiModel& model) {
    std::string out;
    Writer w(out);
    const AgentSessionSnapshot& snapshot = model.snapshot();
    w.line(0, "session: " + (snapshot.id.empty() ? std::string("—") : snapshot.id));
    w.field(0, "event-only", model.isEventOnly());
    w.field(0, "issues", model.issues().size());
    if (model.cursor().valid()) {
        w.line(0, "cursor: " + model.cursor().taskId + " / " + model.cursor().episodeId +
                      " @ " + toString(model.cursor().stage));
    } else {
        w.line(0, "cursor: —");
    }

    if (snapshot.beliefOrder.empty()) {
        w.line(0, "beliefs: —");
    }
    for (const Belief* belief : model.beliefs()) {
        // The label is derived from record order here, exactly as the panel does,
        // so a drift in that derivation is visible in the dump.
        w.line(0, "belief " + model.beliefLabel(belief->id) + " [" + toString(belief->status()) + "] " +
                      toString(belief->domain) + " S" + std::to_string(belief->supportedBy.size()) +
                      " R" + std::to_string(belief->refutedBy.size()) +
                      " I" + std::to_string(belief->inconclusiveBy.size()) +
                      (belief->supersededBy.has_value()
                           ? " superseded-by=" + beliefLabelOf(model, *belief->supersededBy)
                           : "") +
                      (belief->withdrawn ? " withdrawn" : ""));
        w.line(1, "\"" + Writer::oneLine(belief->statement) + "\"");
        if (!belief->expectation.empty()) {
            w.field(1, "expectation", Writer::oneLine(belief->expectation));
        }
    }
    w.ids(0, "active-beliefs", snapshot.activeBeliefs);
    w.ids(0, "active-branch-tasks", snapshot.activeBranchTasks);

    if (model.sessionState().present) {
        const SessionState& state = model.sessionState();
        w.line(0, "session-state: thinking=" +
                      (state.thinkingLevel.empty() ? std::string("—") : state.thinkingLevel) +
                      " streaming=" + (state.isStreaming ? "yes" : "no") +
                      " messages=" + std::to_string(state.messageCount) +
                      " pending=" + std::to_string(state.pendingMessageCount));
        if (state.formulation.has_value()) {
            const FormulationState& formulation = *state.formulation;
            w.line(0, "runtime-formulation: awaiting=" +
                          std::string(formulation.awaitingResponse ? "yes" : "no") +
                          " approved=" + (formulation.approved ? "yes" : "no") +
                          " decisionOwed=" + (formulation.decisionOwed ? "yes" : "no") +
                          " recheckOwed=" + (formulation.recheckOwed ? "yes" : "no"));
            if (formulation.resume.has_value()) {
                w.line(1, "resume: " + std::string(toString(formulation.resume->phase)) +
                              " version=" + formulation.resume->versionId +
                              (formulation.resume->reason.has_value()
                                   ? " reason=\"" + Writer::oneLine(*formulation.resume->reason) + "\""
                                   : ""));
            }
        } else {
            w.line(0, "runtime-formulation: —");
        }
    } else {
        w.line(0, "session-state: —");
    }

    if (snapshot.taskOrder.empty()) {
        w.line(0, "tasks: —");
    }
    for (const Task* task : model.tasks()) {
        out += dumpTask(model, *task);
    }

    if (!model.issues().empty()) {
        w.line(0, "issue-detail:");
        for (const ReplayIssue& issue : model.issues()) {
            w.line(1, issue.eventType + " " + (issue.eventId.empty() ? "—" : issue.eventId) +
                          " :: " + issue.message);
        }
    }
    return out;
}

// The dispatch trace (M7). One block per row with every column named, so a
// transcript's trace can be read without a window — and so the columns whose
// source was missing are visible AS missing, which is the whole discipline §7.3
// asks for. `—` here means "the runtime did not say", never "the value is zero".
std::string dumpTrace(const NativeGuiModel& model) {
    std::string out;
    Writer w(out);
    const TraceModel trace = buildDispatchTrace(model);

    w.line(0, "trace:");
    w.field(1, "telemetry", trace.hasTelemetry);
    w.field(1, "rows", trace.rows.size());
    w.field(1, "events", trace.events.size());
    if (!trace.hasTelemetry) {
        // Named, not merely absent: a demo transcript has no runtime to emit
        // message_start/session_status, and a reader who does not know that would
        // read the em-dashes below as a runtime that reported nothing.
        w.line(1, "no message_start / session_status observed: this run had no telemetry");
    }
    for (const TraceRow& row : trace.rows) {
        std::string head = std::string(dispatchRoleName(row.role));
        if (row.stage == EpisodeStage::Closed) head += " (closed)";
        if (row.fastPath) head += " [fast-path]";
        w.line(1, head + "  " + (row.episodeId.empty() ? "—" : row.episodeId));
        w.field(2, "dispatched-model", row.dispatchedModel);
        w.field(2, "role-model", row.roleModel);
        // The derived badge, spelled out rather than as a symbol: the dump is read
        // by a person deciding whether the GUI claimed something it cannot know.
        w.field(2, "model-differs-from-role",
                row.modelComparisonKnown ? (row.modelDiffersFromRole ? "yes" : "no") : std::string("unknown"));
        w.field(2, "thinking", row.thinkingLevel.empty()
                                   ? std::string("—")
                                   : row.thinkingLevel + (row.thinkingFromTurn ? " (turn)" : " (session)"));
        w.field(2, "cache-hit", formatTraceCache(row.cacheHitRate, row.cacheFromTurnUsage));
        w.field(2, "duration", formatTraceDuration(row.durationMs));
        w.field(2, "turns", row.turnCount);
        for (size_t i = 0; i < row.turns.size(); ++i) {
            const TraceTurn& turn = row.turns[i];
            w.line(3, "turn " + std::to_string(i + 1) + ": " +
                          (turn.model.empty() ? "—" : turn.model) + " " +
                          formatTraceDuration(turn.durationMs) + " " +
                          (turn.ended ? "ended" : "unterminated") + " " +
                          (turn.stopReason.empty() ? "—" : turn.stopReason));
        }
        w.field(2, "status", row.status);
        w.field(2, "detail", row.detail);
        for (size_t i = 0; i < row.details.size(); ++i) {
            w.line(3, "event: " + row.details[i]);
        }
    }
    return out;
}

} // namespace pie::gui
