// GraphRouting.cpp: deterministic link geometry for the dot canvas.
//
// A dot has no left or right edge, so the v1 "enter at the target's left edge"
// rule is gone with the boxes. What replaces it is a rule with the same spirit:
// the anchor point is where the segment MEETS the circle. A link that stops at the
// centre would be drawn under the dot; one that stops at the bounding box would
// float away from it on a diagonal.
//
// Two shapes remain, chosen by whether the link stays inside its row:
//
//   * a DIRECT segment, for a link that crosses rows or reaches a rail (a belief
//     write-back, a source citation, a version chain);
//   * a SHORT 3-point dogleg, for a link between two stations in the same row,
//     which keeps neighboring stations readable when many links overlap.
//
// Deterministic: pure function of the two dot positions.

#include "graph/GraphRouting.h"

#include <cmath>

#include "graph/GraphStyle.h"

namespace pie::gui {

namespace {

// The point on the circle around `from` in the direction of `to`, pulled back by
// linkGapFromDot so the link does not touch the dot.
std::pair<float, float> anchorTowards(const Dot& from, const Dot& to) {
    const float dx = to.x - from.x;
    const float dy = to.y - from.y;
    const float length = std::sqrt(dx * dx + dy * dy);
    const float pull = from.r + kGraphStyle.linkGapFromDot;
    if (length <= 0.0001f) return {from.x, from.y};
    const float t = pull / length;
    // A very short link would otherwise invert: clamp so the anchor never ends up
    // on the far side of the target.
    const float clamped = std::min(t, 0.5f);
    return {from.x + dx * clamped, from.y + dy * clamped};
}

} // namespace

std::vector<EdgeRoute> computeEdgeRoutes(const GraphTaskState& state,
                                         const PieGraphLayout& layout) {
    std::vector<EdgeRoute> routes;
    for (const GraphEdge& edge : state.edges) {
        const Dot* source = layout.dot(edge.source.value);
        const Dot* target = layout.dot(edge.target.value);
        // An edge whose endpoint has no dot is skipped rather than drawn to
        // (0,0): a line to nowhere is worse than a missing line.
        if (source == nullptr || target == nullptr) continue;

        EdgeRoute route;
        route.source = edge.source;
        route.target = edge.target;
        route.type = edge.type;
        route.beliefOperation = edge.beliefOperation;
        route.dashed = edge.dashed;

        const auto start = anchorTowards(*source, *target);
        const auto end = anchorTowards(*target, *source);
        if (edge.type == EdgeSemanticType::PlanToExecution ||
            edge.type == EdgeSemanticType::ExecutionToDistillation ||
            edge.type == EdgeSemanticType::DistillationToBeliefDelta ||
            edge.type == EdgeSemanticType::RecheckToEpisode) {
            // Station to station: the dogleg keeps a dense row legible.
            route.points = {start,
                            {(start.first + end.first) * 0.5f, (start.second + end.second) * 0.5f},
                            end};
        } else {
            // Cross-row or rail-bound: one straight segment, which is what makes a
            // long citation read as a single claim rather than a routed path.
            route.points = {start, end};
            route.longRoute = true;
        }
        routes.push_back(std::move(route));
    }
    return routes;
}

} // namespace pie::gui
