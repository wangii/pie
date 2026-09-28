#include "graph/GraphModel.h"

#include <algorithm>
#include <set>
#include <utility>

#include "Model.h"

namespace pie::gui {

namespace {

std::string collapseWhitespace(const std::string& text) {
    std::string out;
    out.reserve(text.size());
    bool pendingSpace = false;
    for (char c : text) {
        if (c == '\n' || c == '\r' || c == '\t' || c == ' ') {
            pendingSpace = !out.empty();
            continue;
        }
        if (pendingSpace) out += ' ';
        pendingSpace = false;
        out += c;
    }
    return out;
}

std::string truncate(const std::string& text, size_t max) {
    if (text.size() <= max) return text;
    // Cut on a UTF-8 boundary so a multi-byte character is never split in half.
    size_t cut = max;
    while (cut > 0 && (static_cast<unsigned char>(text[cut]) & 0xC0u) == 0x80u) --cut;
    return text.substr(0, cut) + "…";
}

std::string firstLine(const std::string& text, size_t max = 120) {
    return truncate(collapseWhitespace(text), max);
}

// The label beside a belief node: "B7" by record order, or the raw id when the
// projection has no record for it. Derived here and cached in `beliefLabels` so
// every surface that shows a belief spells it the same way (§5.3: derived at
// render time, never stored).
std::string labelFor(const NativeGuiModel& model, const std::map<std::string, std::string>& labels,
                     const std::string& beliefId) {
    if (beliefId.empty()) return "?";
    const auto it = labels.find(beliefId);
    if (it != labels.end()) return it->second;
    return model.beliefLabel(beliefId);
}

std::string joinIds(const std::vector<std::string>& ids) {
    std::string out;
    for (size_t i = 0; i < ids.size(); ++i) {
        if (i != 0) out += ", ";
        out += ids[i];
    }
    return out;
}

// "state: value" pairs for a tooltip body, skipping fields the contract left out.
void appendField(std::string& out, const char* name, const std::string& value) {
    if (value.empty()) return;
    if (!out.empty()) out += '\n';
    out += name;
    out += ": ";
    out += value;
}

void appendField(std::string& out, const char* name, bool value) {
    if (!out.empty()) out += '\n';
    out += name;
    out += ": ";
    out += value ? "yes" : "no";
}

std::string adoptionText(const FormulationAdoption& adoption) {
    if (adoption.kind == FormulationAdoptionKind::Unformed) {
        // A RECORDED fact, not a missing field: the decision was made before any
        // version existed.
        return "unformed (no version had been published)";
    }
    return adoption.versionId;
}

// A delta "introduces" a belief record when its operation creates one. Propose
// creates; refine creates the successor record while superseding the source.
// Support/refute/inconclusive/retract only change provenance on a record that
// already exists. The distinction is read off `operation`, never off the registry
// (§6.1: dashed when the belief is newly added).
bool operationIntroducesRecord(BeliefOperation operation) {
    return operation == BeliefOperation::Propose || operation == BeliefOperation::Refine;
}

} // namespace

const char* nodeFamilyToString(NodeFamily f) {
    switch (f) {
        case NodeFamily::Belief: return "belief";
        case NodeFamily::EpisodeRow: return "row";
        case NodeFamily::Routing: return "routing";
        case NodeFamily::ExperimentSelection: return "selection";
        case NodeFamily::Plan: return "plan";
        case NodeFamily::Execution: return "execution";
        case NodeFamily::Distillation: return "distillation";
        case NodeFamily::BeliefDelta: return "delta";
        case NodeFamily::Intervention: return "intervention";
        case NodeFamily::Recheck: return "recheck";
        case NodeFamily::Formulation: return "formulation";
    }
    return "unknown";
}

const char* nodeVisualStateToString(NodeVisualState s) {
    switch (s) {
        case NodeVisualState::Default: return "default";
        case NodeVisualState::Current: return "current";
        case NodeVisualState::CurrentFaded: return "current-faded";
        case NodeVisualState::Selected: return "selected";
        case NodeVisualState::Muted: return "muted";
    }
    return "unknown";
}

const char* edgeSemanticTypeToString(EdgeSemanticType t) {
    switch (t) {
        case EdgeSemanticType::PlanToExecution: return "plan->execution";
        case EdgeSemanticType::ExecutionToDistillation: return "execution->distillation";
        case EdgeSemanticType::DistillationToBeliefDelta: return "distillation->delta";
        case EdgeSemanticType::BeliefDeltaToBelief: return "delta->belief";
        case EdgeSemanticType::BeliefToBeliefDelta: return "belief->delta";
        case EdgeSemanticType::SourceToFormulation: return "source->formulation";
        case EdgeSemanticType::FormulationToFormulation: return "formulation->formulation";
        case EdgeSemanticType::RecheckToEpisode: return "recheck->episode";
    }
    return "unknown";
}

NodeId nodeId(const char* family, const std::string& recordId) {
    NodeId id;
    id.value = std::string(family) + ":" + recordId;
    return id;
}

const GraphNode* GraphTaskState::node(const NodeId& id) const { return node(id.value); }

const GraphNode* GraphTaskState::node(const std::string& idValue) const {
    for (const GraphNode& n : nodes) {
        if (n.id.value == idValue) return &n;
    }
    return nullptr;
}

const Task* projectedTask(const NativeGuiModel& model) {
    // The cursor names the round the runtime is in, so it names the task too.
    // Falling back to the LAST task in record order (rather than the first) keeps
    // a canvas that follows a session as it opens new work.
    if (model.cursor().valid()) {
        if (const Task* task = model.task(model.cursor().taskId)) return task;
    }
    const std::vector<const Task*> tasks = model.tasks();
    if (tasks.empty()) return nullptr;
    return tasks.back();
}

std::optional<NodeId> currentStationFor(const GraphTaskState& state, const std::string& episodeId,
                                        EpisodeStage stage) {
    // The stage -> station map is a DISPLAY derivation (§6.1). It reads the
    // cursor's stage and the records present; it never guesses what the runtime is
    // doing from event order.
    auto familyStation = [&](NodeFamily family) -> std::optional<NodeId> {
        std::optional<NodeId> found;
        for (const GraphNode& n : state.nodes) {
            if (n.family != family) continue;
            if (n.episodeId != episodeId) continue;
            // Last wins for Execution (the latest probe is where work is), and
            // there is at most one of the others.
            found = n.id;
        }
        return found;
    };
    switch (stage) {
        case EpisodeStage::Routing:
            return familyStation(NodeFamily::Routing);
        case EpisodeStage::Proposing: {
            // Propose is either writing the reading (a plan is not out yet, so the
            // selection ring is where it sits) or has dispatched it.
            if (auto plan = familyStation(NodeFamily::Plan)) return plan;
            if (auto selection = familyStation(NodeFamily::ExperimentSelection)) return selection;
            return familyStation(NodeFamily::Routing);
        }
        case EpisodeStage::Executing:
            if (auto execution = familyStation(NodeFamily::Execution)) return execution;
            return familyStation(NodeFamily::Plan);
        case EpisodeStage::Distilling:
        case EpisodeStage::Closed:
            // `closed` resolves to the same station, drawn faded: the round ended
            // here rather than working here.
            if (auto distillation = familyStation(NodeFamily::Distillation)) return distillation;
            if (auto execution = familyStation(NodeFamily::Execution)) return execution;
            return familyStation(NodeFamily::Plan);
        case EpisodeStage::Unknown:
            return std::nullopt;
    }
    return std::nullopt;
}

namespace {

// Append every belief in the registry as a rail node, in record order — the same
// order the display label derives from.
void projectBeliefRail(const NativeGuiModel& model, const Task& task, GraphTaskState& out,
                       std::set<std::string>& introduced) {
    for (const Belief* belief : model.beliefs()) {
        GraphNode node;
        node.id = nodeId("B", belief->id);
        node.family = NodeFamily::Belief;
        node.title = out.beliefLabels.at(belief->id);
        node.compactText = firstLine(belief->statement);
        node.beliefStatus = belief->status();
        node.evidenceRounds = static_cast<uint32_t>(std::max(belief->evidenceRounds, 0));
        node.superseded = belief->supersededBy.has_value();
        node.beliefWithdrawn = belief->withdrawn;
        node.inFocus = task.focusDeclared && task.inFocus(belief->id);
        node.order = static_cast<uint64_t>(out.nodes.size());

        std::string text;
        appendField(text, "statement", collapseWhitespace(belief->statement));
        appendField(text, "domain", toString(belief->domain));
        // The status is DERIVED from provenance, so the tooltip shows the
        // provenance and the derived line, in that order.
        appendField(text, "status", toString(belief->status()));
        appendField(text, "expectation", collapseWhitespace(belief->expectation));
        appendField(text, "evidence rounds", std::to_string(belief->evidenceRounds));
        for (const std::string& evidence : belief->supportedBy) {
            appendField(text, "supported by", collapseWhitespace(evidence));
        }
        for (const std::string& evidence : belief->refutedBy) {
            appendField(text, "refuted by", collapseWhitespace(evidence));
        }
        for (const std::string& evidence : belief->inconclusiveBy) {
            appendField(text, "inconclusive on", collapseWhitespace(evidence));
        }
        if (belief->supersededBy.has_value()) {
            appendField(text, "superseded by", labelFor(model, out.beliefLabels, *belief->supersededBy));
        }
        if (belief->withdrawn) appendField(text, "withdrawn", true);
        node.fullText = text;
        out.nodes.push_back(std::move(node));
        introduced.insert(belief->id);
    }
}

void projectEpisodeRow(const NativeGuiModel& model, const Task& task, const ExecutionEpisode& episode,
                       GraphTaskState& out) {
    EpisodeGutter gutter;
    gutter.id = episode.id;
    gutter.ordinal = episode.ordinal;
    gutter.status = episode.status;
    gutter.stage = episode.stage;
    gutter.routingDecision = episode.routing.has_value() ? toString(episode.routing->decision) : "";
    gutter.bodyKind = toString(episode.body.kind);
    out.rows.push_back(gutter);

    uint64_t order = 0;
    auto next = [&order]() { return order++; };

    // The row anchor: the ordinal label in the gutter. It is a node so every edge
    // is node -> node and the routing/cache layers stay uniform.
    {
        GraphNode node;
        node.id = nodeId("row", episode.id);
        node.family = NodeFamily::EpisodeRow;
        node.episodeId = episode.id;
        node.ordinal = episode.ordinal;
        node.title = "Ep" + std::to_string(episode.ordinal);
        node.compactText = "episode #" + std::to_string(episode.ordinal) + " · " + toString(episode.status) +
                           " · " + toString(episode.stage);
        std::string text;
        appendField(text, "episode", episode.id);
        appendField(text, "ordinal", std::to_string(episode.ordinal));
        appendField(text, "status", toString(episode.status));
        appendField(text, "stage", toString(episode.stage));
        // `closed` conflates "the round ended" with "the final report was written";
        // the body kind is what separates a fast path from a belief loop (§7.3).
        appendField(text, "body", toString(episode.body.kind));
        node.fullText = text;
        node.order = next();
        out.nodes.push_back(std::move(node));
    }

    if (episode.routing.has_value()) {
        const Routing& routing = *episode.routing;
        GraphNode node;
        node.id = nodeId("route", routing.id);
        node.family = NodeFamily::Routing;
        node.episodeId = episode.id;
        node.routingDecision = routing.decision;
        node.title = "route";
        node.compactText = std::string(toString(routing.decision)) + " · " +
                           toString(routing.difficulty);
        std::string text;
        appendField(text, "decision", toString(routing.decision));
        appendField(text, "statement", collapseWhitespace(routing.statement));
        appendField(text, "difficulty", toString(routing.difficulty));
        appendField(text, "reason", collapseWhitespace(routing.reason));
        node.fullText = text;
        node.order = next();
        out.nodes.push_back(std::move(node));
    }

    if (episode.experimentSelection.has_value()) {
        // Alive only between `ExperimentSelected` and the plan (or void) that
        // settles it — which is exactly what holding it on the episode means. The
        // projection does not have to decide that; it just draws what is there.
        const ExperimentSelectionRecord& selection = *episode.experimentSelection;
        GraphNode node;
        node.id = nodeId("select", episode.id);
        node.family = NodeFamily::ExperimentSelection;
        node.episodeId = episode.id;
        node.title = "select";
        node.compactText = firstLine(selection.intent);
        std::string text;
        appendField(text, "intent", collapseWhitespace(selection.intent));
        std::string beliefs;
        for (size_t i = 0; i < selection.beliefIds.size(); ++i) {
            if (i != 0) beliefs += ", ";
            beliefs += labelFor(model, out.beliefLabels, selection.beliefIds[i]);
        }
        appendField(text, "selecting", beliefs);
        appendField(text, "adoption", adoptionText(selection.formulation));
        if (selection.advancementAction.has_value()) {
            appendField(text, "doing", collapseWhitespace(*selection.advancementAction));
        }
        node.fullText = text;
        node.order = next();
        out.nodes.push_back(std::move(node));
    }

    if (episode.body.plan.has_value()) {
        const Plan& plan = *episode.body.plan;
        GraphNode node;
        node.id = nodeId("plan", plan.id);
        node.family = NodeFamily::Plan;
        node.episodeId = episode.id;
        node.title = "plan";
        node.compactText = plan.intent.has_value() ? firstLine(*plan.intent) : plan.id;
        std::string text;
        appendField(text, "plan", plan.id);
        appendField(text, "intent", collapseWhitespace(plan.intent.value_or("")));
        std::string beliefs;
        for (size_t i = 0; i < plan.selectedToExplore.size(); ++i) {
            if (i != 0) beliefs += ", ";
            beliefs += labelFor(model, out.beliefLabels, plan.selectedToExplore[i]);
        }
        appendField(text, "selected to explore", beliefs);
        appendField(text, "adoption", adoptionText(plan.formulation));
        if (plan.advancementAction.has_value()) {
            appendField(text, "doing", collapseWhitespace(*plan.advancementAction));
        }
        if (plan.advancementCondition.has_value()) {
            appendField(text, "if", collapseWhitespace(*plan.advancementCondition));
        }
        if (plan.advancementNext.has_value()) {
            appendField(text, "then", collapseWhitespace(*plan.advancementNext));
        }
        node.fullText = text;
        node.order = next();
        out.nodes.push_back(std::move(node));
    }

    for (const Execution& execution : episode.body.trajectory) {
        GraphNode node;
        node.id = nodeId("exec", execution.id);
        node.family = NodeFamily::Execution;
        node.episodeId = episode.id;
        node.executionStatus = execution.status;
        node.title = execution.tool.empty() ? execution.id : execution.tool;
        node.compactText = firstLine(execution.intention);
        std::string text;
        appendField(text, "execution", execution.id);
        appendField(text, "tool", execution.tool);
        // Absent for a fast-path execution, and the absence is the point: it is
        // what says the plan -> execution edge must not be invented.
        appendField(text, "plan", execution.planId.value_or(""));
        appendField(text, "intention", collapseWhitespace(execution.intention));
        appendField(text, "status", toString(execution.status));
        appendField(text, "input", collapseWhitespace(execution.inputSummary));
        appendField(text, "output", collapseWhitespace(execution.outputPreview));
        if (execution.outputBytes > execution.outputPreview.size()) {
            appendField(text, "output bytes", std::to_string(execution.outputBytes) +
                                                  " (shown truncated)");
        }
        appendField(text, "error", collapseWhitespace(execution.error.value_or("")));
        appendField(text, "file", execution.filePath.value_or(""));
        node.fullText = text;
        node.order = next();
        out.nodes.push_back(std::move(node));
    }

    if (episode.body.distillation.has_value()) {
        const Distillation& distillation = *episode.body.distillation;
        GraphNode node;
        node.id = nodeId("distill", distillation.id);
        node.family = NodeFamily::Distillation;
        node.episodeId = episode.id;
        node.title = "distill";
        node.compactText = firstLine(distillation.contents);
        std::string text;
        appendField(text, "contents", collapseWhitespace(distillation.contents));
        appendField(text, "inputs", joinIds(distillation.inputs));
        appendField(text, "outputs", joinIds(distillation.outputs));
        node.fullText = text;
        node.order = next();
        out.nodes.push_back(std::move(node));
    }

    for (const BeliefDelta& delta : episode.body.beliefDeltas) {
        GraphNode node;
        node.id = nodeId("delta", delta.id);
        node.family = NodeFamily::BeliefDelta;
        node.episodeId = episode.id;
        node.beliefOperation = delta.operation;
        node.deltaPhase = delta.producerPhase;
        node.title = toString(delta.operation);
        node.compactText = labelFor(model, out.beliefLabels, delta.resultBeliefId) + " " +
                           toString(delta.operation);
        std::string text;
        appendField(text, "operation", toString(delta.operation));
        appendField(text, "producer phase", toString(delta.producerPhase));
        appendField(text, "result", labelFor(model, out.beliefLabels, delta.resultBeliefId));
        appendField(text, "source", labelFor(model, out.beliefLabels, delta.sourceBeliefId.value_or("")));
        appendField(text, "distillation", delta.distillationId.value_or(""));
        appendField(text, "evidence", collapseWhitespace(delta.evidence.value_or("")));
        node.fullText = text;
        node.order = next();
        out.nodes.push_back(std::move(node));
    }

    // Interventions are placed at the end of their row, in record order. The wire
    // carries the stage each one landed at, but deriving "which station came next"
    // from that would be inference; the stage is in the tooltip instead.
    for (const Intervention& intervention : episode.steering) {
        GraphNode node;
        node.id = nodeId("steer", intervention.id);
        node.family = NodeFamily::Intervention;
        node.episodeId = episode.id;
        node.title = "steer";
        node.compactText = firstLine(intervention.contents);
        std::string text;
        appendField(text, "contents", collapseWhitespace(intervention.contents));
        appendField(text, "stage", toString(intervention.stage));
        node.fullText = text;
        node.order = next();
        out.nodes.push_back(std::move(node));
    }

    // The recheck reconsiders one round, so it is drawn in that round's row even
    // though it is recorded on the task.
    if (task.formulationRecheck.has_value() &&
        task.formulationRecheck->episodeId == episode.id) {
        const FormulationRecheck& recheck = *task.formulationRecheck;
        GraphNode node;
        node.id = nodeId("recheck", episode.id);
        node.family = NodeFamily::Recheck;
        node.episodeId = episode.id;
        node.title = "recheck";
        node.compactText = toString(recheck.verdict);
        std::string text;
        appendField(text, "verdict", toString(recheck.verdict));
        appendField(text, "reason", collapseWhitespace(recheck.reason));
        appendField(text, "version", recheck.versionId.value_or(""));
        appendField(text, "recorded at", recheck.recordedAt);
        node.fullText = text;
        node.order = next();
        out.nodes.push_back(std::move(node));
    }
}

} // namespace

GraphTaskState projectGraphTask(const NativeGuiModel& model, const Task* task) {
    GraphTaskState out;
    if (task == nullptr) return out;
    out.taskId = task->id;

    // Labels first: every later node's text quotes beliefs by label.
    for (const Belief* belief : model.beliefs()) {
        out.beliefLabels.emplace(belief->id, model.beliefLabel(belief->id));
    }

    std::set<std::string> beliefIds;
    projectBeliefRail(model, *task, out, beliefIds);

    // The version rail, oldest first. `task.formulations` is append-only, so its
    // order is the ordinal order.
    for (const ProblemFormulationVersion& version : task->formulations) {
        GraphRailVersion rail;
        rail.id = version.id;
        rail.ordinal = version.ordinal;
        rail.recordedAt = version.recordedAt;
        rail.previousVersionId = version.previousVersionId.value_or("");
        rail.approved = task->formulationReview.has_value() &&
                        task->formulationReview->approval.has_value() &&
                        task->formulationReview->approval->versionId == version.id;
        if (const ProblemFormulationVersion* current = currentFormulation(*task)) {
            rail.current = current->id == version.id;
        }
        out.versions.push_back(rail);

        GraphNode node;
        node.id = nodeId("Fv", version.id);
        node.family = NodeFamily::Formulation;
        node.ordinal = version.ordinal;
        node.title = "Fv" + std::to_string(version.ordinal);
        node.compactText = firstLine(version.content.interpretation);
        std::string text;
        appendField(text, "version", version.id);
        appendField(text, "ordinal", std::to_string(version.ordinal));
        appendField(text, "recorded at", version.recordedAt);
        appendField(text, "interpretation", collapseWhitespace(version.content.interpretation));
        // `alternative` and `tension` are optional and a present-but-blank one is
        // refused at the tool, so an absent one means the agent had nothing to say.
        appendField(text, "alternative", collapseWhitespace(version.content.alternative.value_or("")));
        appendField(text, "focus", collapseWhitespace(version.content.focus));
        appendField(text, "tension", collapseWhitespace(version.content.tension.value_or("")));
        appendField(text, "implication", collapseWhitespace(version.content.implication));
        appendField(text, "reason", collapseWhitespace(version.reason));
        if (!version.sources.empty()) {
            appendField(text, "sources", std::to_string(version.sources.size()));
        }
        if (rail.approved) appendField(text, "approved", true);
        node.fullText = text;
        node.order = version.ordinal;
        out.nodes.push_back(std::move(node));
    }

    for (const ExecutionEpisode& episode : task->episodes) {
        projectEpisodeRow(model, *task, episode, out);
    }

    // --- edges ----------------------------------------------------------
    // Built after every node exists, so an edge is only emitted when both ends are
    // real records. A dangling citation is not drawn as a line to nowhere.
    std::set<std::string> nodeIds;
    for (const GraphNode& node : out.nodes) nodeIds.insert(node.id.value);
    auto has = [&nodeIds](const NodeId& id) { return nodeIds.count(id.value) != 0; };
    auto addEdge = [&out, &has](const NodeId& source, const NodeId& target, EdgeSemanticType type) {
        if (!has(source) || !has(target)) return;
        GraphEdge edge;
        edge.source = source;
        edge.target = target;
        edge.type = type;
        out.edges.push_back(std::move(edge));
    };

    for (const ExecutionEpisode& episode : task->episodes) {
        // plan -> execution, from execution.planId. Declared by the contract and
        // never produced by the v1 projection.
        for (const Execution& execution : episode.body.trajectory) {
            if (execution.planId.has_value()) {
                addEdge(nodeId("plan", *execution.planId), nodeId("exec", execution.id),
                        EdgeSemanticType::PlanToExecution);
            }
        }
        if (episode.body.distillation.has_value()) {
            const Distillation& distillation = *episode.body.distillation;
            for (const ExecutionId& input : distillation.inputs) {
                addEdge(nodeId("exec", input), nodeId("distill", distillation.id),
                        EdgeSemanticType::ExecutionToDistillation);
            }
            for (const BeliefDeltaId& output : distillation.outputs) {
                addEdge(nodeId("distill", distillation.id), nodeId("delta", output),
                        EdgeSemanticType::DistillationToBeliefDelta);
            }
        }
        for (const BeliefDelta& delta : episode.body.beliefDeltas) {
            const NodeId deltaNode = nodeId("delta", delta.id);
            // delta -> belief for the record the delta wrote. The result is always
            // linked; a refine also lists the superseded side in `resultingBeliefs`,
            // which is a record the delta changed, so it is linked too.
            for (const Belief& belief : delta.resultingBeliefs) {
                GraphEdge edge;
                edge.source = deltaNode;
                edge.target = nodeId("B", belief.id);
                edge.type = EdgeSemanticType::BeliefDeltaToBelief;
                edge.beliefOperation = delta.operation;
                edge.dashed = operationIntroducesRecord(delta.operation) &&
                              belief.id == delta.resultBeliefId;
                if (has(edge.source) && has(edge.target)) out.edges.push_back(std::move(edge));
            }
            // belief -> delta is the LINEAGE edge (§6.1): the source a mutation
            // replaced. A support or a refutation names the very record it
            // adjudicates, so the write-back above already expresses it and a
            // reverse edge would put two arrows between the same pair, reading as a
            // cycle. Only a source that is a DIFFERENT record — refine's
            // predecessor — earns a lineage edge.
            if (delta.sourceBeliefId.has_value() && *delta.sourceBeliefId != delta.resultBeliefId) {
                addEdge(nodeId("B", *delta.sourceBeliefId), deltaNode,
                        EdgeSemanticType::BeliefToBeliefDelta);
            }
        }
        if (task->formulationRecheck.has_value() &&
            task->formulationRecheck->episodeId == episode.id) {
            addEdge(nodeId("recheck", episode.id), nodeId("row", episode.id),
                    EdgeSemanticType::RecheckToEpisode);
        }
    }

    // version -> version, and every source -> the version it shaped.
    for (const ProblemFormulationVersion& version : task->formulations) {
        const NodeId versionNode = nodeId("Fv", version.id);
        if (version.previousVersionId.has_value()) {
            addEdge(nodeId("Fv", *version.previousVersionId), versionNode,
                    EdgeSemanticType::FormulationToFormulation);
        }
        for (const FormulationSource& source : version.sources) {
            // A correction and a prompt have no node on the canvas: corrections
            // belong to the Frame pane (§7.2), and a prompt is not a record drawn
            // anywhere. Those citations stay in the tooltip rather than becoming a
            // line to a node that does not exist.
            switch (source.kind) {
                case FormulationSourceKind::Belief:
                    addEdge(nodeId("B", source.beliefId), versionNode,
                            EdgeSemanticType::SourceToFormulation);
                    break;
                case FormulationSourceKind::Execution:
                    addEdge(nodeId("exec", source.executionId), versionNode,
                            EdgeSemanticType::SourceToFormulation);
                    break;
                case FormulationSourceKind::Distillation:
                    addEdge(nodeId("distill", source.distillationId), versionNode,
                            EdgeSemanticType::SourceToFormulation);
                    break;
                case FormulationSourceKind::Intervention:
                    addEdge(nodeId("steer", source.interventionId), versionNode,
                            EdgeSemanticType::SourceToFormulation);
                    break;
                case FormulationSourceKind::Prompt:
                case FormulationSourceKind::Correction:
                case FormulationSourceKind::Unknown:
                    break;
            }
        }
    }

    out.focusDeclared = task->focusDeclared;
    out.focusBeliefIds = task->focus;
    if (task->taskOutcome.has_value() && task->taskOutcome->present()) {
        out.taskOutcome.present = true;
        out.taskOutcome.result = task->taskOutcome->result;
        out.taskOutcome.evidence = task->taskOutcome->evidence;
        out.taskOutcome.blockers = task->taskOutcome->blockers;
    }

    // --- the current node -------------------------------------------------
    if (model.cursor().valid() && model.cursor().taskId == task->id) {
        out.cursorStage = model.cursor().stage;
        const std::optional<NodeId> station =
            currentStationFor(out, model.cursor().episodeId, model.cursor().stage);
        if (station.has_value()) out.currentNode = station;
        const bool faded = model.cursor().stage == EpisodeStage::Closed;
        for (GraphNode& node : out.nodes) {
            if (out.currentNode.has_value() && node.id == *out.currentNode) {
                node.state = faded ? NodeVisualState::CurrentFaded : NodeVisualState::Current;
            }
        }
        for (EpisodeGutter& row : out.rows) {
            row.current = row.id == model.cursor().episodeId;
        }
    }
    // A stale cursor (its task is not this one, or its episode is gone) leaves no
    // current node rather than highlighting an arbitrary station.
    return out;
}

GraphTaskState projectGraphTask(const NativeGuiModel& model) {
    return projectGraphTask(model, projectedTask(model));
}

} // namespace pie::gui
