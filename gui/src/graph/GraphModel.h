// GraphModel: the P0 Node Graph View runtime contract (Phase 2 M1).
//
// Headless, ImGui-free, unit-testable without a window (matches the pi_gui_model
// layering convention). Holds the GraphNode / GraphEdge / GraphTaskState types
// and the projection from the runtime model (NativeGuiModel) into a
// GraphTaskState. The GUI never infers cognition: the projection maps explicit
// runtime state into semantic nodes/edges and supplies every field from the
// runtime, it does not fabricate epistemic meaning.
//
// Contract invariants (see roadmap/phase-2-node-graph-contract.md):
//  - No Proposal node and no synthetic Observation/ExecutionStep wrapper.
//  - A tool call and its result are merged into a single Execution node.
//  - Beliefs are global (no owning frame); frames do not own Belief nodes.
//  - All edges are typed, directed, explicit, and runtime-supplied.
//  - Distill -> Belief encodes the epistemic result as a create/update edge
//    (a create edge is drawn dashed; no on-link operation glyph is rendered).

#pragma once

#include <optional>
#include <string>
#include <vector>

namespace pie::gui {

// Default models are forward-declared to keep this layer independent of the
// runtime model's implementation; the projection lives in GraphModel.cpp which
// includes Model.h.
class NativeGuiModel;

// A semantic node in the graph. Family is the PIE node ontology; display_type
// is runtime display metadata (subtype). Position/state are supplied by the
// layout engine / runtime, never inferred by a viewer.
enum class NodeFamily {
    Belief,
    Plan,
    Execution,
    Distill,
};
const char* nodeFamilyToString(NodeFamily f);

// Runtime-supplied node visual state. The GUI only renders what the runtime
// says; it never derives a node's status from a generic log.
enum class NodeVisualState {
    Default,
    Current,   // the single node the runtime is executing now
    Selected,  // the node the user is inspecting
    Muted,     // non-selected, de-emphasized during a dependency query
};
const char* nodeVisualStateToString(NodeVisualState s);

// Edge semantic type. All edges are directed and explicit.
enum class EdgeSemanticType {
    BeliefToPlan,      // a frame expressed these beliefs to its plan
    PlanToExecution,   // the plan drove execution
    ExecutionToDistill,// execution results entered cognition
    DistillToBelief,   // distillation updated / created a belief (epistemic result)
};
const char* edgeSemanticTypeToString(EdgeSemanticType t);

// The operation a Distill -> Belief edge encodes: a belief was created (+) or
// updated (~). Undefined when the edge is not a Distill -> Belief edge.
enum class BeliefOperation {
    Create,
    Update,
};

// A unique node identifier. Value is the runtime label ("B42", "P-128",
// "E-88", "D-42"); empty means invalid.
struct NodeId {
    std::string value;
    bool valid() const { return !value.empty(); }
    bool operator==(const NodeId& o) const { return value == o.value; }
};

struct GraphNode {
    NodeId id;
    NodeFamily family = NodeFamily::Belief;
    // The owning frame, or nullopt for a global Belief node.
    std::optional<int> frameId;
    // Creation provenance for a global Belief. This positions the Belief in the
    // corresponding LoopFrame row without making the frame its owner.
    std::optional<int> createdInFrame;
    std::string displayType;
    // Belief domain (world / routing / framing) for a Belief node; empty for
    // non-Belief families. Lets the renderer color routing and framing beliefs
    // distinctly.
    std::string domain;
    std::string title;        // short node label (exec: simplified "<tool> <command>" summary)
    std::string compactText;  // first line / compact content
    std::string fullText;     // expanded content (tool tip / "..." popup)
    NodeVisualState state = NodeVisualState::Default;
    uint64_t creationOrder = 0;      // stable, creation-order key (Belief grid)
    std::optional<uint64_t> executionOrder;  // runtime execution order (Execution)
    std::optional<BeliefOperation> beliefOperation;  // Distill->Belief create/update (drives dashed styling)
};

struct GraphEdge {
    NodeId source;
    NodeId target;
    EdgeSemanticType type = EdgeSemanticType::BeliefToPlan;
    std::optional<BeliefOperation> beliefOperation;  // set only for Distill->Belief
};

// Container summary for a LoopFrame in the graph, used by the frame container
// header and the horizontal frame strip.
struct LoopFrameInfo {
    int id = -1;
    std::string label;  // "LoopFrame #8"
    bool executing = false;  // active runtime state (EXECUTING marker)
    bool closed = false;     // frame has reached a terminal close event
};

// The read-only semantic task state the graph renders.
struct GraphTaskState {
    std::vector<GraphNode> nodes;
    std::vector<GraphEdge> edges;
    std::vector<LoopFrameInfo> frames;
    std::optional<NodeId> currentNode;  // the single CURRENT node
};

// Project the runtime model into a GraphTaskState (Phase 2 M1). Believes are
// global; each frame's plan/execution/distillation become nodes; proposals are
// folded into Distill -> Belief edges (never a Proposal node). Tool call +
// result are merged into one Execution node.
GraphTaskState projectGraphTask(const NativeGuiModel& model);

} // namespace pie::gui
