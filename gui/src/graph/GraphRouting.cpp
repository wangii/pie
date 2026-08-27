// GraphRouting.cpp: deterministic routes for the semantic row layout.

#include "graph/GraphRouting.h"

namespace pie::gui {

std::vector<EdgeRoute> computeEdgeRoutes(const GraphTaskState& state,
                                         const PieGraphLayout& layout) {
    std::vector<EdgeRoute> routes;

    auto rect = [&](const std::string& id) -> const GraphRect* {
        auto it = layout.nodeRects.find(id);
        return it == layout.nodeRects.end() ? nullptr : &it->second;
    };
    auto left = [](const GraphRect& r) {
        return std::pair<float, float>{r.x, r.y + r.h * 0.5f};
    };
    auto right = [](const GraphRect& r) {
        return std::pair<float, float>{r.x + r.w, r.y + r.h * 0.5f};
    };

    for (const GraphEdge& edge : state.edges) {
        const GraphRect* sourceRect = rect(edge.source.value);
        const GraphRect* targetRect = rect(edge.target.value);
        if (!sourceRect || !targetRect) continue;

        EdgeRoute route;
        route.source = edge.source;
        route.target = edge.target;
        route.type = edge.type;
        route.beliefOperation = edge.beliefOperation;

        if (edge.type == EdgeSemanticType::BeliefToPlan) {
            const auto source = right(*sourceRect);
            const auto target = left(*targetRect);
            const float midX = (source.first + target.first) * 0.5f;
            route.points = {source, {midX, source.second},
                            {midX, target.second}, target};
            route.longRoute = true;
        } else if (edge.type == EdgeSemanticType::DistillToBelief) {
            // Distill -> Belief is a direct line, not a two-elbow orthogonal
            // polyline: the write-back returns to the belief column as a single
            // straight segment so it reads as a direct epistemic result.
            const auto source = left(*sourceRect);
            const auto target = right(*targetRect);
            route.points = {source, target};
            route.longRoute = true;
        } else if (edge.type == EdgeSemanticType::PlanToExecution) {
            const auto source = right(*sourceRect);
            const auto target = left(*targetRect);
            route.points = {source,
                            {(source.first + target.first) * 0.5f,
                             (source.second + target.second) * 0.5f},
                            target};
        } else if (edge.type == EdgeSemanticType::ProposeToBelief) {
            // Propose (middle) writes back to the belief column: a direct long
            // cross-region return line, isomorphic to Distill -> Belief.
            const auto source = left(*sourceRect);
            const auto target = right(*targetRect);
            route.points = {source, target};
            route.longRoute = true;
        } else {
            // Local Plan -> Execution / Execution -> Distill / Distill -> Propose.
            const auto source = left(*sourceRect);
            const auto target = right(*targetRect);
            route.points = {source,
                            {(source.first + target.first) * 0.5f,
                             (source.second + target.second) * 0.5f},
                            target};
        }
        routes.push_back(std::move(route));
    }
    return routes;
}

} // namespace pie::gui
