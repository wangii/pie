// GraphModel.cpp: projection implementation (Phase 2 M1). Headless, ImGui-free.

#include "graph/GraphModel.h"

#include <algorithm>
#include <cstdio>

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

// Belief-mutation / belief-read surface tools are not execution probes. The
// runtime classifies declare_belief / view_beliefs / conclude as the belief
// surface (not probe/execution tools), so they must not project as Execution
// nodes nor produce Plan->Execution edges.
bool isBeliefSurfaceTool(const std::string& tool) {
    return tool == "declare_belief" || tool == "view_beliefs" || tool == "conclude";
}

// Simplified Execution-node label: "<tool> <command>" (no "exec:" prefix), so an
// Execution node reads as one concise line ("read requirements.txt",
// "bash pip show pytest"). The command is trimmed and the tool verb is not
// duplicated when the command already begins with it (tool="grep" command=
// "grep pytest ." -> "grep pytest ."). Falls back to the bare tool name when the
// command is empty. Belief-surface tools are filtered out before this point.
std::string execSummary(const ToolCall& t) {
    std::string cmd = t.command;
    auto trim = [](std::string& s) {
        const std::size_t b = s.find_first_not_of(" \t\r\n");
        if (b == std::string::npos) { s.clear(); return; }
        const std::size_t e = s.find_last_not_of(" \t\r\n");
        s = s.substr(b, e - b + 1);
    };
    trim(cmd);
    if (cmd.empty()) return t.tool;
    // Do not repeat the tool verb if the command already starts with it.
    if (cmd.rfind(t.tool, 0) == 0 || cmd.rfind(t.tool + " ", 0) == 0) return cmd;
    return t.tool + " " + cmd;
}

} // namespace

GraphTaskState projectGraphTask(const NativeGuiModel& model) {
    GraphTaskState state;

    // --- Global Belief nodes (creation-order stable, no owning frame) ---
    std::set<std::string> projectedBeliefIds;
    uint64_t beliefOrder = 1;
    for (const Belief& b : model.beliefs()) {
        GraphNode node;
        // The runtime's belief register uses "B" prefix as seen in the demo
        // Proposal events (e.g. "B42"). If the belief id has no string label,
        // synthesize one from the numeric id for display stability.
        node.id = makeNodeId("B" + std::to_string(b.id.value >= 0 ? b.id.value : beliefOrder));
        projectedBeliefIds.insert(node.id.value);
        node.family = NodeFamily::Belief;
        node.displayType = b.status.empty() ? "belief" : b.status;
        node.domain = b.domain;
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
        if (b.createdInFrame >= 0) node.createdInFrame = b.createdInFrame;
        // Default belief visual state; a later selection/dependency pass or the
        // runtime supplies Current/Selected. The GUI never fabricates state.
        node.state = NodeVisualState::Default;
        state.nodes.push_back(std::move(node));
    }

    // --- Frames as containers; one frame's plan/execution/distill become nodes ---
    const std::vector<LoopFrame> frames = model.frames();
    for (std::size_t frameIndex = 0; frameIndex < frames.size(); ++frameIndex) {
        const LoopFrame& f = frames[frameIndex];
        LoopFrameInfo info;
        info.id = f.id;
        info.label = "#" + std::to_string(frameIndex + 1);
        // The active (open) frame shows the EXECUTING marker when the cursor is
        // executing within it, matching the runtime's current frame.
        info.executing = model.activeFrame() && model.activeFrame()->id == f.id &&
                         model.cursor().stage == FrameStage::EXECUTING;
        info.closed = f.closed;
        state.frames.push_back(info);

        // --- Plan nodes: one per occurrence. A LoopFrame carries at most one
        // plan (a second PlanProduced splits into a fresh frame), so this renders
        // the frame's single plan; the fallback covers the demo/headless
        // single-value `plan` when no occurrence list was accumulated. ---
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
            // Belief-surface tools (declare_belief / view_beliefs / conclude) are
            // not execution probes; skip them so they never render as Execution.
            if (isBeliefSurfaceTool(t.tool)) continue;
            GraphNode exec;
            exec.id = makeNodeId(t.id);
            exec.family = NodeFamily::Execution;
            exec.frameId = f.id;
            exec.displayType = t.status.empty() ? "execution" : t.status;
            exec.title = execSummary(t);
            exec.compactText = t.command;
            exec.fullText = t.result;
            if (!t.warning.empty()) exec.fullText += "\n" + t.warning;
            exec.creationOrder = static_cast<uint64_t>(f.id) * 1000 + execOrder;
            exec.executionOrder = execOrder;
            exec.state = NodeVisualState::Default;
            state.nodes.push_back(std::move(exec));
            ++execOrder;
        }

        // --- Distill nodes: one per occurrence. A LoopFrame carries at most one
        // distillation (a second DistillationProduced splits into a fresh frame), so
        // this renders the frame's single distillation. ---
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
    for (const LoopFrame& f : frames) {
        std::vector<const PlannerOutput*> plans;
        if (!f.plans.empty()) {
            for (const PlannerOutput& plan : f.plans) plans.push_back(&plan);
        } else if (f.plan.valid()) {
            plans.push_back(&f.plan);
        }

        // Each explicit BeliefsSelected occurrence feeds the plan occurrence at
        // the same stream position. The single-value fields remain a fallback
        // for demo streams that expose only one batch.
        for (std::size_t i = 0; i < plans.size(); ++i) {
            const std::vector<BeliefId>* selected = nullptr;
            if (i < f.selectedBeliefBatches.size()) selected = &f.selectedBeliefBatches[i];
            else if (plans.size() == 1) selected = &f.selectedBeliefs;
            if (!selected) continue;
            for (const BeliefId& bid : *selected) {
                GraphEdge edge;
                edge.source = makeNodeId("B" + std::to_string(bid.value));
                edge.target = planNodeId(*plans[i]);
                edge.type = EdgeSemanticType::BeliefToPlan;
                state.edges.push_back(std::move(edge));
            }
        }

        // A ToolCall records the plan occurrence active when it was dispatched.
        // Fall back to the latest plan for older/demo events.
        for (const ToolCall& call : f.trajectory) {
            if (call.id.empty() || plans.empty() || isBeliefSurfaceTool(call.tool)) continue;
            GraphEdge edge;
            edge.source = !call.planId.empty() ? makeNodeId(call.planId) : planNodeId(*plans.back());
            edge.target = makeNodeId(call.id);
            edge.type = EdgeSemanticType::PlanToExecution;
            state.edges.push_back(std::move(edge));
        }

        std::vector<const DistillationOutput*> distillations;
        if (!f.distillations.empty()) {
            for (const DistillationOutput& distillation : f.distillations) {
                distillations.push_back(&distillation);
            }
        } else if (f.distillation.valid()) {
            distillations.push_back(&f.distillation);
        }

        for (const DistillationOutput* distillation : distillations) {
            std::vector<std::string> inputIds = distillation->inputIds;
            if (inputIds.empty() && distillations.size() == 1) {
                for (const ToolCall& call : f.trajectory) inputIds.push_back(call.id);
            }
            for (const std::string& inputId : inputIds) {
                if (inputId.empty()) continue;
                GraphEdge edge;
                edge.source = makeNodeId(inputId);
                edge.target = distillNodeId(*distillation);
                edge.type = EdgeSemanticType::ExecutionToDistill;
                state.edges.push_back(std::move(edge));
            }
        }

        // Distill -> Belief write-back edges. The runtime expresses a distillation's
        // created/updated beliefs as BeliefCreated / BeliefUpdated (via declare_belief),
        // so these are carried on the belief record's explicit provenance
        // (createdInFrame / sourceFrames) rather than as ProposalCreated events. The
        // demo/headless path instead emits explicit ProposalCreated events, so we
        // also consume f.proposals. Both sources are deduped by (distill label, belief)
        // so a belief written back by both is not double-linked.
        // Distill -> Propose -> Belief write-back. A ProposalCreated occurrence is a
        // hypothesis-formation step between the distillation and the belief it
        // writes back, so it projects as a Propose node on the chain
        // Distill -> Propose -> Belief. The node id is deterministic per frame and
        // proposal index. The create/update operation rides on Propose -> Belief.
        std::set<std::pair<std::string, std::string>> writtenBack;
        uint64_t proposalIdx = 0;
        for (const Proposal& proposal : f.proposals) {
            if (proposal.belief.empty()) continue;
            std::string distillationLabel = proposal.distillationLabel;
            if (distillationLabel.empty() && distillations.size() == 1) {
                distillationLabel = distillations.front()->label;
            }
            if (distillationLabel.empty()) continue;
            // Drop proposals whose target belief is not in the projected belief set:
            // a Distill -> Propose -> Belief chain to a missing belief node would
            // leave a dangling edge (the proposal was never materialized as a
            // BeliefCreated / BeliefUpdated in the runtime).
            if (!projectedBeliefIds.count(proposal.belief)) continue;
            writtenBack.insert({distillationLabel, proposal.belief});

            const std::string proposeId = "PR-" + std::to_string(f.id) + "-" + std::to_string(proposalIdx);
            GraphNode proposeNode;
            proposeNode.id = makeNodeId(proposeId);
            proposeNode.family = NodeFamily::Propose;
            proposeNode.frameId = f.id;
            proposeNode.displayType = "propose";
            proposeNode.title = "Propose " + proposal.belief;
            proposeNode.compactText = proposal.detail;
            proposeNode.fullText = proposal.detail;
            if (!proposal.lhs.empty()) {
                proposeNode.fullText += "\n" + proposal.lhs + " " + proposal.relation + " " + proposal.rhs;
            }
            proposeNode.creationOrder = static_cast<std::uint64_t>(f.id) * 1000 + 400 + proposalIdx;
            proposeNode.state = NodeVisualState::Default;
            state.nodes.push_back(std::move(proposeNode));
            ++proposalIdx;

            GraphEdge distillToPropose;
            distillToPropose.source = makeNodeId(distillationLabel);
            distillToPropose.target = makeNodeId(proposeId);
            distillToPropose.type = EdgeSemanticType::DistillToPropose;
            state.edges.push_back(std::move(distillToPropose));

            GraphEdge proposeToBelief;
            proposeToBelief.source = makeNodeId(proposeId);
            proposeToBelief.target = makeNodeId(proposal.belief);
            proposeToBelief.type = EdgeSemanticType::ProposeToBelief;
            switch (proposal.op) {
                case '+': proposeToBelief.beliefOperation = BeliefOperation::Create; break;
                case '-': proposeToBelief.beliefOperation = BeliefOperation::Remove; break;
                case '?': proposeToBelief.beliefOperation = BeliefOperation::Unresolved; break;
                default:  proposeToBelief.beliefOperation = BeliefOperation::Update; break;  // '~' and unknown
            }
            state.edges.push_back(std::move(proposeToBelief));
        }

        // Live-path provenance: a belief created or updated while this frame was the
        // active DISTILLING frame points back via createdInFrame / sourceFrames, and
        // (since the RPC adapter binds a distillation label in DistillationProduced)
        // via distillationLabel when the mutation was attributed to a specific
        // distillation occurrence. Prefer the label (exact attribution in a frame
        // with several distillations); fall back to the frame's single distillation
        // when the label is empty or names no distillation in this frame. A pair
        // already written back by a proposal is not repeated.
        for (const Belief& belief : model.beliefs()) {
            bool createdHere = belief.createdInFrame == f.id;
            bool updatedHere = false;
            for (int src : belief.sourceFrames) {
                if (src == f.id) { updatedHere = true; break; }
            }
            if (!createdHere && !updatedHere && belief.distillationLabel.empty()) continue;
            const std::string beliefLabel = "B" + std::to_string(belief.id.value);
            // Resolve the distillation to link: the specific label when it names a
            // distillation in this frame, else the sole distillation (frame ==
            // distillation).
            const DistillationOutput* distillation = nullptr;
            if (!belief.distillationLabel.empty()) {
                for (const DistillationOutput* d : distillations) {
                    if (d->label == belief.distillationLabel) { distillation = d; break; }
                }
            }
            if (!distillation && distillations.size() == 1) {
                distillation = distillations.front();
            }
            if (!distillation) continue;
            const std::pair<std::string, std::string> key{distillation->label, beliefLabel};
            if (writtenBack.count(key)) continue;
            writtenBack.insert(key);
            GraphEdge edge;
            edge.source = distillNodeId(*distillation);
            edge.target = makeNodeId(beliefLabel);
            edge.type = EdgeSemanticType::DistillToBelief;
            edge.beliefOperation = createdHere
                ? BeliefOperation::Create
                : BeliefOperation::Update;
            state.edges.push_back(std::move(edge));
        }
    }

    // --- Current node from the explicit runtime cursor, if it names a node. ---
    if (model.cursor().valid() && !model.cursor().item.empty()) {
        state.currentNode = makeNodeId(model.cursor().item);
    }

    return state;
}

} // namespace pie::gui
