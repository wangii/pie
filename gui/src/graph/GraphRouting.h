// GraphRouting: Phase 2 M4 edge routing.
//
// Headless, ImGui-free, unit-testable. It turns a GraphTaskState + a
// PieGraphLayout into a polyline route per edge. Belief -> Plan and Distill ->
// Belief use two-elbow orthogonal routes within their semantic row; local Plan
// -> Execution and Execution -> Distill edges keep a short curve. The
// GUI never infers cognition: the routing only uses the runtime-supplied edge
// semantic type and the geometry produced by the layout engine.
//
// Determinism: an identical GraphTaskState + PieGraphLayout yields identical
// routes (pure function of the two inputs).

#pragma once

#include <utility>
#include <vector>

#include "graph/GraphModel.h"
#include "graph/PieGraphLayout.h"

namespace pie::gui {

// One edge's routed polyline (in layout coordinates, y-down).
struct EdgeRoute {
    NodeId source;
    NodeId target;
    EdgeSemanticType type = EdgeSemanticType::BeliefToPlan;
    std::optional<BeliefOperation> beliefOperation;  // Distill->Belief result glyph
    // The routed path, first = source anchor, last = target anchor. The viewer
    // draws it as straight segments (cross-region) or as a curve (local).
    std::vector<std::pair<float, float>> points;
    // True for cross-region Belief read/write routes. Such edges default to
    // subdued in the viewer.
    bool longRoute = false;
};

// Compute a routed polyline for every edge in the state, anchored on the node
// rectangles in `layout`. Produces exactly one EdgeRoute per state edge whose
// source and target both have a rect; edges with a missing endpoint are skipped.
std::vector<EdgeRoute> computeEdgeRoutes(const GraphTaskState& state, const PieGraphLayout& layout);

} // namespace pie::gui
