// GraphRouting: Phase 2 M4 edge routing.
//
// Headless, ImGui-free, unit-testable. It turns a GraphTaskState + a
// PieGraphLayout into a polyline route per edge. Long semantic edges (a Belief
// -> Plan expressed across the frame strip, and a Distill -> Belief returning
// to the global Belief Region) are routed around the top / bottom periphery of
// the canvas so they do not cut through the frame content; local edges (Plan ->
// Execution, Execution -> Distill, within one frame) keep a short curve. The
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
    // draws it as straight segments (long periphery) or as a curve (local).
    std::vector<std::pair<float, float>> points;
    // True when the edge was routed along a canvas periphery (Belief->Plan top /
    // Distill->Belief bottom). Such edges default to subdued in the viewer.
    bool longRoute = false;
};

// Compute a routed polyline for every edge in the state, anchored on the node
// rectangles in `layout`. Produces exactly one EdgeRoute per state edge whose
// source and target both have a rect; edges with a missing endpoint are skipped.
std::vector<EdgeRoute> computeEdgeRoutes(const GraphTaskState& state, const PieGraphLayout& layout);

} // namespace pie::gui
