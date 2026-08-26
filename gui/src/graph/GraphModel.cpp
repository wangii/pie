// GraphModel.cpp: projection implementation (Phase 2 M1). Headless, ImGui-free.

#include "graph/GraphModel.h"

#include <algorithm>

#include "Model.h"

namespace pie::gui {

const char* nodeFamilyToString(NodeFamily f) {
    switch (f) {
        case NodeFamily::Belief: return "Belief";
        case NodeFamily::Plan: return "Plan";
        case NodeFamily::Execution: return "Execution";
        case NodeFamily::Distill: return "Distill";
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
    }
    return "?";
}

namespace {

// A runtime LabelId ("B42", "P-128", ...) is carried into the graph verbatim.
NodeId makeNodeId(const std::string& label) { return NodeId{label}; }

// The graph node id for a plan occurrence: the authoritative runtime planId when
// present (live mode), else the label (demo/headless and the text-view key).
NodeId planNodeId(const PlannerOutput& p) {
    return makeNodeId(!p.id.empty() ? p.id : p.label);
}

// The graph node id for a distillation occurrence: the runtime emits no separate
// distillId, so the (unique) label is the id. Demo/headless labels are distinct.
NodeId distillNodeId(const DistillationOutput& d) {
    return makeNodeId(d.label);
}

} // namespace

GraphTaskState projectGraphTask(const NativeGuiModel& model) {
    GraphTaskState state;

    // --- Global Belief nodes (creation-order stable, no owning frame) ---
    uint64_t beliefOrder = 1;
    for (const Belief& b : model.beliefs()) {
        GraphNode node;
        // The runtime's belief register uses "B" prefix as seen in the demo
        // Proposal events (e.g. "B42"). If the belief id has no string label,
        // synthesize one from the numeric id for display stability.
        node.id = makeNodeId("B" + std::to_string(b.id.value >= 0 ? b.id.value : beliefOrder));
        node.family = NodeFamily::Belief;
        node.displayType = b.status.empty() ? "belief" : b.status;
        node.title = b.statement.empty()
            ? (b.lhs + " " + b.relation + " " + b.rhs)
            : b.statement;
        node.compactText = node.title;
        node.fullText = node.title;
        if (b.confidence >= 0.0) {
            char buf[32];
            std::snprintf(buf, sizeof(buf), "%.2f", b.confidence);
            node.fullText += std::string("  (confidence ") + buf + ")";
        }
        node.creationOrder = beliefOrder++;
        // Default belief visual state; a later selection/dependency pass or the
        // runtime supplies Current/Selected. The GUI never fabricates state.
        node.state = NodeVisualState::Default;
        state.nodes.push_back(std::move(node));
    }

    // --- Frames as containers; one frame's plan/execution/distill become nodes ---
    for (const LoopFrame& f : model.frames()) {
        LoopFrameInfo info;
        info.id = f.id;
        info.label = "LoopFrame #" + std::to_string(f.id);
        // The active (open) frame shows the EXECUTING marker when the cursor is
        // executing within it, matching the runtime's current frame.
        info.executing = model.activeFrame() && model.activeFrame()->id == f.id &&
                         model.cursor().stage == FrameStage::EXECUTING;
        state.frames.push_back(info);

        // --- Plan nodes: one per occurrence, so multiple plan batches in one
        // frame each become a distinct node. Falls back to the single-value
        // `plan` (demo/headless) when no occurrence list was accumulated. ---
        if (!f.plans.empty()) {
            uint64_t planIdx = 0;
            for (const PlannerOutput& po : f.plans) {
                GraphNode plan;
                plan.id = planNodeId(po);
                plan.family = NodeFamily::Plan;
                plan.frameId = f.id;
                plan.displayType = "plan";
                plan.title = po.label;
                plan.compactText = po.intent.empty() ? po.question : po.intent;
                plan.fullText = po.question;
                plan.creationOrder = static_cast<uint64_t>(f.id) * 1000 + planIdx;
                plan.state = NodeVisualState::Default;
                state.nodes.push_back(std::move(plan));
                ++planIdx;
            }
        } else if (f.plan.valid()) {
            GraphNode plan;
            plan.id = planNodeId(f.plan);
            plan.family = NodeFamily::Plan;
            plan.frameId = f.id;
            plan.displayType = "plan";
            plan.title = f.plan.label;
            plan.compactText = f.plan.intent.empty() ? f.plan.question : f.plan.intent;
            plan.fullText = f.plan.question;
            plan.creationOrder = static_cast<uint64_t>(f.id) * 1000;
            plan.state = NodeVisualState::Default;
            state.nodes.push_back(std::move(plan));
        }

        // --- Execution nodes (right region). Tool call + result merged into one
        // node per call; no Observation / ExecutionStep wrapper. ---
        uint64_t execOrder = 1;
        for (const ToolCall& t : f.trajectory) {
            GraphNode exec;
            exec.id = makeNodeId(t.id);
            exec.family = NodeFamily::Execution;
            exec.frameId = f.id;
            exec.displayType = t.status.empty() ? "execution" : t.status;
            exec.title = "exec: " + t.tool;
            exec.compactText = t.command;
            exec.fullText = t.result;
            if (!t.warning.empty()) exec.fullText += "\n" + t.warning;
            exec.creationOrder = static_cast<uint64_t>(f.id) * 1000 + execOrder;
            exec.executionOrder = execOrder;
            exec.state = NodeVisualState::Default;
            state.nodes.push_back(std::move(exec));
            ++execOrder;
        }

        // --- Distill nodes: one per occurrence (analogous to plans). ---
        if (!f.distillations.empty()) {
            uint64_t distillIdx = 0;
            for (const DistillationOutput& do_ : f.distillations) {
                GraphNode distill;
                distill.id = distillNodeId(do_);
                distill.family = NodeFamily::Distill;
                distill.frameId = f.id;
                distill.displayType = "distill";
                distill.title = do_.label;
                distill.compactText = do_.interpretation;
                distill.fullText = do_.unexplained;
                distill.creationOrder = static_cast<uint64_t>(f.id) * 1000 + 500 + distillIdx;
                distill.state = NodeVisualState::Default;
                state.nodes.push_back(std::move(distill));
                ++distillIdx;
            }
        } else if (f.distillation.valid()) {
            GraphNode distill;
            distill.id = distillNodeId(f.distillation);
            distill.family = NodeFamily::Distill;
            distill.frameId = f.id;
            distill.displayType = "distill";
            distill.title = f.distillation.label;
            distill.compactText = f.distillation.interpretation;
            distill.fullText = f.distillation.unexplained;
            distill.creationOrder = static_cast<uint64_t>(f.id) * 1000 + 500;
            distill.state = NodeVisualState::Default;
            state.nodes.push_back(std::move(distill));
        }
    }

    // --- Edges (typed, directed, runtime-supplied). Cross-frame cognition passes
    // only through Belief; direct Distill(frame A) -> Plan(frame B) is forbidden.
    for (const LoopFrame& f : model.frames()) {
        bool havePlan = f.plan.valid();
        std::vector<NodeId> execNodes;
        for (const ToolCall& t : f.trajectory) {
            if (!t.id.empty()) execNodes.push_back(makeNodeId(t.id));
        }
        bool haveDistill = f.distillation.valid();

        if (havePlan) {
            // Selected beliefs are expressed only by incoming edges to the plan.
            for (const BeliefId& bid : f.selectedBeliefs) {
                GraphEdge e;
                e.source = makeNodeId("B" + std::to_string(bid.value));
                e.target = makeNodeId(f.plan.label);
                e.type = EdgeSemanticType::BeliefToPlan;
                state.edges.push_back(std::move(e));
            }
            // Plan -> Execution edges.
            for (const NodeId& ex : execNodes) {
                GraphEdge e;
                e.source = makeNodeId(f.plan.label);
                e.target = ex;
                e.type = EdgeSemanticType::PlanToExecution;
                state.edges.push_back(std::move(e));
            }
        }

        if (haveDistill) {
            // Execution -> Distill edges (explicit, runtime-supplied).
            for (const NodeId& ex : execNodes) {
                GraphEdge e;
                e.source = ex;
                e.target = makeNodeId(f.distillation.label);
                e.type = EdgeSemanticType::ExecutionToDistill;
                state.edges.push_back(std::move(e));
            }
            // Distill -> Belief edges: the epistemic result, with the create/update
            // glyph from the runtime's proposal op. Proposals never become nodes.
            for (const Proposal& p : f.proposals) {
                if (!p.belief.empty()) {
                    GraphEdge e;
                    e.source = makeNodeId(f.distillation.label);
                    e.target = makeNodeId(p.belief);
                    e.type = EdgeSemanticType::DistillToBelief;
                    if (p.op == '+') e.beliefOperation = BeliefOperation::Create;
                    else e.beliefOperation = BeliefOperation::Update;
                    state.edges.push_back(std::move(e));
                }
            }
        }
    }

    // --- Current node from the explicit runtime cursor, if it names a node. ---
    if (model.cursor().valid() && !model.cursor().item.empty()) {
        state.currentNode = makeNodeId(model.cursor().item);
    }

    return state;
}

} // namespace pie::gui
