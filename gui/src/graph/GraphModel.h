// GraphModel: the v7 projection feeding the canvas (docs/milestones.md §6.1).
//
// Headless and ImGui-free like the rest of the model layer, so the projection is
// unit-testable without a window.
//
// WHAT CHANGED FROM THE v1 PROJECTION, and why the rewrite is not a rename:
//
//  * The ontology is now the v7 records themselves. `LoopFrame` is gone; a row on
//    the canvas is one `ExecutionEpisode`, and the nodes in it are the records the
//    contract names — routing, experiment selection, plan, executions,
//    distillation, belief deltas, interventions, recheck.
//  * `ProblemFormulation` (the product's "Frame") is a first-class node family on
//    its own rail, because the whole product is organized around it. The v1
//    projection had no counterpart.
//  * The Frame nodes are joined by `previousVersionId`, and the records that
//    shaped them are joined by `version.sources`. This is the first surface where
//    `sources[]` can be audited — §7.2 calls it out as such.
//  * Two edges the v1 projection declared but never produced are now produced:
//    `plan → execution` (from `execution.planId`) and `execution → distillation`
//    (from `distillation.inputs`). `domain-model.md` names their absence.
//  * Nothing is inferred. Every node and edge below comes from an explicit field.
//    In particular a fast-path episode has no plan and its executions carry no
//    `planId`, so the projection must NOT invent a plan node for them (§6.1).
//
// A belief delta points at its result belief, and — when it names a source — the
// source belief points back at the delta. That is the refine/retract lineage, and
// it is why the v1 "synthesise a successor frame for a pending belief" hack
// (`GraphModel.cpp:49 pendingFrameId`) is gone: adoption is now a real record, so
// there is nothing to synthesise.

#pragma once

#include <cstdint>
#include <map>
#include <optional>
#include <string>
#include <vector>

#include "Model.h"

namespace pie::gui {

struct Task;

// The v7 node vocabulary (§6.1's element table, one family per row).
enum class NodeFamily {
    Belief,              // the global belief rail
    EpisodeRow,          // a row's anchor: the ordinal label in the left gutter
    Routing,             // episode.routing
    ExperimentSelection, // episode.experimentSelection, alive only until dispatched
    Plan,                // episode.body.plan
    Execution,           // one per episode.body.trajectory entry
    Distillation,        // episode.body.distillation
    BeliefDelta,         // one per episode.body.beliefDeltas entry
    Intervention,        // one per episode.steering entry
    Recheck,             // task.formulationRecheck, drawn in the row it reconsiders
    Formulation,         // a Frame version, on the version rail
};
const char* nodeFamilyToString(NodeFamily f);

// Display state. Every value here is decided by the projection from explicit
// fields; the renderer only maps it to colour and geometry.
enum class NodeVisualState {
    Default,
    // The node the runtime cursor names.
    Current,
    // The cursor's node when the cursor's stage is `closed`: the same station,
    // drawn faded, because "this round finished here" is not the same claim as
    // "work is happening here" (§6.1).
    CurrentFaded,
    Selected,  // the node the user is inspecting
    Muted,     // de-emphasized while a dependency path is highlighted
};
const char* nodeVisualStateToString(NodeVisualState s);

// Every edge is directed and names its own source field. There is no
// "associated with" edge: an edge that cannot be read off a field is not drawn.
enum class EdgeSemanticType {
    PlanToExecution,          // execution.planId
    ExecutionToDistillation,  // distillation.inputs
    DistillationToBeliefDelta,// distillation.outputs
    BeliefDeltaToBelief,      // delta.resultingBeliefs[].id
    BeliefToBeliefDelta,      // delta.sourceBeliefId (the refine/retract lineage)
    SourceToFormulation,      // version.sources
    FormulationToFormulation, // version.previousVersionId
    RecheckToEpisode,         // recheck.episodeId
};
const char* edgeSemanticTypeToString(EdgeSemanticType t);

struct GraphRect {
    float x = 0.0f;
    float y = 0.0f;
    float w = 0.0f;
    float h = 0.0f;
};

// A node id is a STRING, and it is namespaced by family. The runtime's ids are
// opaque and only unique within their own record type, so a bare `id` would let a
// plan and a distillation collide in the layout's map.
struct NodeId {
    std::string value;
    bool valid() const { return !value.empty(); }
    bool operator==(const NodeId& other) const { return value == other.value; }
    bool operator<(const NodeId& other) const { return value < other.value; }
};

// Build a namespaced node id, e.g. nodeId("plan", "plan-1") -> "plan:plan-1".
NodeId nodeId(const char* family, const std::string& recordId);

struct GraphNode {
    NodeId id;
    NodeFamily family = NodeFamily::Belief;
    // The owning episode row, or empty for rail nodes (belief, formulation).
    std::string episodeId;
    // Short kind label ("route", "select", "plan", "exec", "distill", "delta",
    // "steer", "recheck", "Fv1", "B2", "Ep1"). A display label, derived here so
    // every surface spells a node the same way.
    std::string title;
    // One line, for the node's place in a list or a legend.
    std::string compactText;
    // The full text, which is what a tooltip shows (§5 of the rewrite: every node
    // family gets one, including the two that deliberately had none).
    std::string fullText;
    NodeVisualState state = NodeVisualState::Default;
    // Station position within the row, and the tiebreaker for a deterministic
    // layout. Derived from record order, never stored on the record.
    uint64_t order = 0;

    // --- family-specific, all read off explicit fields -------------------
    ExecutionStatus executionStatus = ExecutionStatus::Unknown;
    RoutingDecision routingDecision = RoutingDecision::Unknown;
    BeliefOperation beliefOperation = BeliefOperation::Unknown;
    BeliefDeltaProducerPhase deltaPhase = BeliefDeltaProducerPhase::Unknown;
    BeliefStatus beliefStatus = BeliefStatus::Proposed;
    bool beliefWithdrawn = false;
    bool inFocus = false;
    // A belief is in scope but not in focus: history the task no longer acts on.
    bool superseded = false;
    // How many rounds carried a belief. Drawn as a small series mark beside the
    // dot, so "this claim has been tested repeatedly" is visible at a glance.
    uint32_t evidenceRounds = 0;
    uint64_t ordinal = 0;  // episode ordinal, or version ordinal
};

struct GraphEdge {
    NodeId source;
    NodeId target;
    EdgeSemanticType type = EdgeSemanticType::PlanToExecution;
    // Set only for BeliefDeltaToBelief: the mutation the delta performed.
    std::optional<BeliefOperation> beliefOperation;
    // A delta that INTRODUCED a belief record draws dashed; one that changed
    // provenance on an existing record draws solid (§6.1).
    bool dashed = false;
};

// One episode row. `rect` is the row band (used for the separator and the ordinal
// label); the row's anchor node carries the same position as a Dot.
struct EpisodeGutter {
    std::string id;
    uint64_t ordinal = 0;
    EpisodeStatus status = EpisodeStatus::Unknown;
    EpisodeStage stage = EpisodeStage::Unknown;
    std::string routingDecision;  // "belief-loop" | "fast-path" | "" while pending
    std::string bodyKind;         // "pending" | "belief-loop" | "fast-path"
    bool current = false;
    GraphRect rect;
};

// A Frame version, for the rail. The node itself is in `nodes`; this is the rail's
// own view of it, in ordinal order, which is what the rail is drawn from.
struct GraphRailVersion {
    std::string id;
    uint64_t ordinal = 0;
    std::string recordedAt;
    std::string previousVersionId;
    // The version the runtime cursor's task currently holds. Not "approved": that
    // is the review's fact, shown by the Frame pane.
    bool current = false;
    bool approved = false;
};

struct GraphTaskOutcome {
    bool present = false;
    std::string result;
    std::string evidence;
    std::string blockers;
};

struct GraphTaskState {
    std::string taskId;
    std::vector<GraphNode> nodes;
    std::vector<GraphEdge> edges;
    std::vector<EpisodeGutter> rows;
    std::vector<GraphRailVersion> versions;
    // The node the runtime cursor names, resolved to a station. Absent when the
    // cursor names a task or episode this projection has no record of.
    std::optional<NodeId> currentNode;
    // The stage the cursor named, so the renderer can distinguish "current" from
    // "closed here" without re-reading the model.
    EpisodeStage cursorStage = EpisodeStage::Unknown;
    bool focusDeclared = false;
    std::vector<std::string> focusBeliefIds;
    GraphTaskOutcome taskOutcome;
    // The runtime's own belief labels ("B1"), by record order. Present so a
    // consumer does not have to re-derive them from a model it may not hold.
    std::map<std::string, std::string> beliefLabels;

    // Lookup helpers, for the renderer and the tests.
    const GraphNode* node(const NodeId& id) const;
    const GraphNode* node(const std::string& idValue) const;
};

// Which task this projection describes: the runtime cursor's task when the cursor
// names one, else the last task in record order, else nothing. There is no
// "selected task" — the v7 model has no such concept, and the canvas follows the
// runtime rather than a user selection (§6.1).
const Task* projectedTask(const NativeGuiModel& model);

// Project one task. When `task` is null the result is empty (no rows, no nodes).
GraphTaskState projectGraphTask(const NativeGuiModel& model, const Task* task);

// The convenience entry point the app calls: project whatever `projectedTask`
// names.
GraphTaskState projectGraphTask(const NativeGuiModel& model);

// The stage -> station mapping (§6.1). Exposed because it is a display-layer
// derivation and the tests pin it: `closed` resolves to the distillation station
// with a faded state, never to a station of its own.
std::optional<NodeId> currentStationFor(const GraphTaskState& state, const std::string& episodeId,
                                        EpisodeStage stage);

} // namespace pie::gui
