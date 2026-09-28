// GraphRouting: link geometry for the dot canvas (docs/milestones.md §6).
//
// Headless, ImGui-free, unit-testable. It turns a GraphTaskState + a
// PieGraphLayout into a polyline per edge. Station-to-station links inside a row
// get a short 3-point dogleg; links that cross rows or reach a rail get a single
// straight segment. "Direct" describes the routing style, not ownership: a link
// may connect two different rows, which is the point of a rail.
//
// The anchors are ON the circles, not at their centres and not at a bounding box:
// a dot has no left edge for the v1 rule to use. The GUI never infers cognition:
// routing reads only the edge's own semantic type and the layout geometry.
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
    EdgeSemanticType type = EdgeSemanticType::PlanToExecution;
    std::optional<BeliefOperation> beliefOperation;  // delta -> belief result glyph
    // The routed path, first = source anchor, last = target anchor. Both anchors
    // lie on their dot's circle, pulled back by kGraphStyle.linkGapFromDot.
    std::vector<std::pair<float, float>> points;
    // True for a link that crosses rows or reaches a rail. Such links default to
    // subdued in the viewer, because they are context rather than the local step.
    bool longRoute = false;
    // A link to a belief record this delta introduced (§6.1). Drawn dashed.
    bool dashed = false;
};

// Compute a routed polyline for every edge in the state, anchored on the dots in
// `layout`. Produces exactly one EdgeRoute per state edge whose source and target
// both have a dot; an edge with a missing endpoint is skipped rather than drawn
// to the origin.
std::vector<EdgeRoute> computeEdgeRoutes(const GraphTaskState& state, const PieGraphLayout& layout);

} // namespace pie::gui
