// GraphModel.cpp: projection implementation (Phase 2 M1). Headless, ImGui-free.

#include "graph/GraphModel.h"

#include <algorithm>
#include <cstdio>
#include <set>

#include "Model.h"

namespace pie::gui {

const char* nodeFamilyToString(NodeFamily f) {
    switch (f) {
        case NodeFamily::Belief: return "Belief";
        case NodeFamily::Plan: return "Plan";
        case NodeFamily::Execution: return "Execution";
        case NodeFamily::Distill: return "Distill";
        case NodeFamily::Propose: return "Propose";
    }
    return "?";
}

const char* nodeVisualStateToString(NodeVisualState s) {
    switch (s) {
        case NodeVisualState::Default: return "Default";
        case NodeVisualState::Current: return "Current";
        case NodeVisualState::Selected: return "Selected";
        case NodeVisualState::Muted: return "Muted";
    }
    return "?";
}

const char* edgeSemanticTypeToString(EdgeSemanticType t) {
    switch (t) {
        case EdgeSemanticType::BeliefToPlan: return "Belief->Plan";
        case EdgeSemanticType::PlanToExecution: return "Plan->Execution";
        case EdgeSemanticType::ExecutionToDistill: return "Execution->Distill";
        case EdgeSemanticType::DistillToBelief: return "Distill->Belief";
        case EdgeSemanticType::DistillToPropose: return "Distill->Propose";
        case EdgeSemanticType::ProposeToBelief: return "Propose->Belief";
    }
    return "?";
}

namespace {

// A stable id is carried into the graph verbatim (never remapped).
NodeId makeNodeId(const std::string& id) { return NodeId{id}; }

// Simplified Execution-node label: "<tool> <command>" (no "exec:" prefix), so an
// Execution node reads as one concise line. The command is trimmed and the tool
// verb is not duplicated when the command already begins with it.
std::string execSummary(const std::string& tool, std::string cmd) {
    auto trim = [](std::string& s) {
        const std::size_t b = s.find_first_not_of(" \t\r\n");
        if (b == std::string::npos) { s.clear(); return; }
        const std::size_t e = s.find_last_not_of(" \t\r\n");
        s = s.substr(b, e - b + 1);
    };
    trim(cmd);
    if (cmd.empty()) return tool;
    if (cmd.rfind(tool, 0) == 0 || cmd.rfind(tool + " ", 0) == 0) return cmd;
    return tool + " " + cmd;
}

// Map a BeliefDelta operation to the edge's create/update/remove encoding.
BeliefOperation beliefOperationFromDelta(const std::string& operation) {
    if (operation == "propose") return BeliefOperation::Create;
    if (operation == "retract") return BeliefOperation::Remove;
    return BeliefOperation::Update; // support / refute / refine
}

} // namespace

std::string beliefNodeTitle(const GraphNode& n) {
    const char* cat = "";
    if (n.domain == "framing") cat = "Target";
    else if (n.domain == "routing") cat = "Route";
    const std::string num = n.title.empty() ? n.id.value : n.title;
    std::string label = std::string(cat) + " " + num;
    if (!n.displayType.empty() && n.displayType != "belief")
        label += " (" + n.displayType + ")";
    return label;
}

bool edgeIsCreate(EdgeSemanticType t, const std::optional<BeliefOperation>& op) {
    if (!op || *op != BeliefOperation::Create) return false;
    return t == EdgeSemanticType::DistillToBelief ||
           t == EdgeSemanticType::ProposeToBelief;
}

GraphTaskState projectGraphTask(const NativeGuiModel& model) {
    GraphTaskState state;

    // --- Global Belief nodes (creation-order stable, no owning frame) ---
    std::set<std::string> projectedBeliefIds;
    uint64_t beliefOrder = 1;
    for (const Belief& b : model.beliefs()) {
        GraphNode node;
        node.id = makeNodeId(b.id);
        projectedBeliefIds.insert(node.id.value);
        node.family = NodeFamily::Belief;
        node.displayType = b.status.empty() ? "belief" : b.status;
        node.domain = b.domain;
        // Belief nodes show a display category + number; the descriptive
        // statement lives in the hover tooltip (compact/full text).
        node.title = b.label.empty() ? b.id : b.label;
        node.compactText = b.statement;
        node.fullText = b.statement;
        if (!b.expectation.empty()) node.fullText += std::string("  (expects ") + b.expectation + ")";
        node.creationOrder = beliefOrder++;
        if (!b.createdInFrame.empty()) node.createdInFrame = b.createdInFrame;
        node.state = NodeVisualState::Default;
        state.nodes.push_back(std::move(node));
    }

    // --- Frames as containers; one frame's plan/execution/distillation/deltas
    // become nodes. A frame carries at most one plan and one distillation. ---
    const std::vector<LoopFrame> frames = model.frames();
    for (std::size_t frameIndex = 0; frameIndex < frames.size(); ++frameIndex) {
        const LoopFrame& f = frames[frameIndex];
        const uint64_t frameBase = static_cast<uint64_t>(frameIndex) * 1000;

        LoopFrameInfo info;
        info.id = f.id;
        info.label = "#" + std::to_string(frameIndex + 1);
        info.executing = model.activeFrame() && model.activeFrame()->id == f.id &&
                         model.cursor().stage == FrameStage::EXECUTING;
        info.closed = f.closed;
        info.routingDecision = f.routingDecision;
        info.routingReason = f.routingReason;
        state.frames.push_back(info);

        // --- Plan node ---
        if (f.plan.valid()) {
            GraphNode plan;
            plan.id = makeNodeId(f.plan.id);
            plan.family = NodeFamily::Plan;
            plan.frameId = f.id;
            plan.displayType = "plan";
            plan.title = f.plan.label.empty() ? f.plan.id : f.plan.label;
            plan.compactText = f.plan.intent.empty() ? plan.title : f.plan.intent;
            plan.fullText = f.plan.intent;
            plan.creationOrder = frameBase;
            plan.state = NodeVisualState::Default;
            state.nodes.push_back(std::move(plan));
        }

        // --- Execution nodes (right region). Tool call + result merged into one
        // node per call. ---
        uint64_t execOrder = 1;
        for (const Execution& t : f.trajectory) {
            GraphNode exec;
            exec.id = makeNodeId(t.id);
            exec.family = NodeFamily::Execution;
            exec.frameId = f.id;
            exec.displayType = t.status.empty() ? "execution" : t.status;
            exec.title = execSummary(t.tool, t.command);
            exec.compactText = t.command;
            exec.fullText = t.result;
            if (!t.warning.empty()) exec.fullText += "\n" + t.warning;
            exec.creationOrder = frameBase + 200 + execOrder;
            exec.executionOrder = execOrder;
            exec.state = NodeVisualState::Default;
            state.nodes.push_back(std::move(exec));
            ++execOrder;
        }

        // --- Distill node ---
        if (f.distillation.valid()) {
            GraphNode distill;
            distill.id = makeNodeId(f.distillation.id);
            distill.family = NodeFamily::Distill;
            distill.frameId = f.id;
            distill.displayType = "distill";
            distill.title = f.distillation.label.empty() ? f.distillation.id : f.distillation.label;
            distill.compactText = f.distillation.contents;
            distill.fullText = f.distillation.contents;
            distill.creationOrder = frameBase + 500;
            distill.state = NodeVisualState::Default;
            state.nodes.push_back(std::move(distill));
        }

        // --- Propose nodes (one per belief delta: the hypothesis-formation
        // step between distillation and the belief it writes back). ---
        // A propose that a distillation produced (its outputs name the delta)
        // belongs to the NEXT loopframe/episode: the distillation closes out the
        // frame's epistemic work, and the propose it feeds is the following
        // frame's proposal step. The last frame has no successor, so its
        // distillation-produced propose stays in the current frame.
        std::set<std::string> distillOutputs;
        if (f.distillation.valid()) {
            for (const BeliefDeltaId& o : f.distillation.outputs) distillOutputs.insert(o);
        }
        const std::string& nextFrameId =
            (frameIndex + 1 < frames.size()) ? frames[frameIndex + 1].id : f.id;
        uint64_t proposeIdx = 0;
        for (const BeliefDelta& d : f.beliefDeltas) {
            if (d.beliefId.empty()) continue;
            GraphNode propose;
            propose.id = makeNodeId(d.id.empty()
                ? ("PR-" + f.id + "-" + std::to_string(proposeIdx))
                : d.id);
            propose.family = NodeFamily::Propose;
            propose.frameId = (frameIndex + 1 < frames.size() && distillOutputs.count(d.id))
                ? nextFrameId
                : f.id;
            propose.displayType = "propose";
            propose.title = d.operation;
            propose.compactText = d.evidence;
            propose.fullText = d.evidence;
            propose.creationOrder = frameBase + 400 + proposeIdx;
            propose.state = NodeVisualState::Default;
            state.nodes.push_back(std::move(propose));
            ++proposeIdx;
        }
    }

    // --- Edges (typed, directed, runtime-supplied). ---
    for (const LoopFrame& f : frames) {
        // Belief -> Plan: the plan's authoritative selectedToExplore.
        if (f.plan.valid()) {
            for (const BeliefId& b : f.plan.selectedToExplore) {
                GraphEdge edge;
                edge.source = makeNodeId(b);
                edge.target = makeNodeId(f.plan.id);
                edge.type = EdgeSemanticType::BeliefToPlan;
                state.edges.push_back(std::move(edge));
            }
        }

        // Distill -> Propose -> Belief: explicit provenance. Distillation names
        // the belief-delta ids it produced (outputs); each delta names the belief
        // it wrote back (beliefId) and its operation. Only deltas whose belief is
        // projected are linked (a dangling target is dropped).
        std::set<std::string> distillOutputs;
        if (f.distillation.valid()) {
            for (const BeliefDeltaId& o : f.distillation.outputs) distillOutputs.insert(o);
        }
        for (const BeliefDelta& d : f.beliefDeltas) {
            if (d.beliefId.empty() || !projectedBeliefIds.count(d.beliefId)) continue;
            const std::string proposeId = d.id;
            // Distill -> Propose when the distillation names this delta.
            if (f.distillation.valid() && distillOutputs.count(d.id)) {
                GraphEdge distillToPropose;
                distillToPropose.source = makeNodeId(f.distillation.id);
                distillToPropose.target = makeNodeId(proposeId);
                distillToPropose.type = EdgeSemanticType::DistillToPropose;
                state.edges.push_back(std::move(distillToPropose));
            }
            // Propose -> Belief with the operation encoding.
            GraphEdge proposeToBelief;
            proposeToBelief.source = makeNodeId(proposeId);
            proposeToBelief.target = makeNodeId(d.beliefId);
            proposeToBelief.type = EdgeSemanticType::ProposeToBelief;
            proposeToBelief.beliefOperation = beliefOperationFromDelta(d.operation);
            state.edges.push_back(std::move(proposeToBelief));
        }
    }

    // --- Current node from the explicit runtime cursor, if it names a node. ---
    if (model.cursor().valid() && !model.cursor().item.empty()) {
        state.currentNode = makeNodeId(model.cursor().item);
    }

    return state;
}

} // namespace pie::gui
