// GraphRouting.cpp: Phase 2 M4 edge routing implementation (headless).
//
// Long semantic edges ride the canvas periphery: a Belief -> Plan route runs
// along the top edge (the belief region feeds the frame strip left->right, so
// the return to the plan is a forward pass), and a Distill -> Belief route runs
// along the bottom edge (the distill result returns leftward to the global
// Belief Region). These two are "long"; all other edges (Plan -> Execution,
// Execution -> Distill) stay local to a frame and keep a short curve. The routing
// is a pure function of (GraphTaskState, PieGraphLayout): identical inputs give
// identical routes.

#include "graph/GraphRouting.h"

#include <algorithm>
#include <cstddef>

#include "graph/GraphStyle.h"

namespace pie::gui {

namespace {
// Gap between the node content and the periphery band the long routes ride on,
// taken from the centralized GraphStyle (M9).
constexpr const GraphStyle& st = kGraphStyle;
} // namespace

std::vector<EdgeRoute> computeEdgeRoutes(const GraphTaskState& state, const PieGraphLayout& layout) {
    std::vector<EdgeRoute> routes;
    if (layout.nodeRects.empty()) return routes;

    // Canvas periphery bands. The layout top-left is y-down; the top band sits
    // above every node, the bottom band below every node. Derived from the
    // union of node rects so it tracks whatever the layout engine produced.
    float topBand = 0.0f, bottomBand = 0.0f;
    bool haveBand = false;
    for (const auto& [id, r] : layout.nodeRects) {
        (void)id;
        float nodeTop = r.y;
        float nodeBottom = r.y + r.h;
        if (!haveBand) {
            topBand = nodeTop;
            bottomBand = nodeBottom;
            haveBand = true;
        } else {
            topBand = std::min(topBand, nodeTop);
            bottomBand = std::max(bottomBand, nodeBottom);
        }
    }
    if (!haveBand) return routes;
    topBand -= st.peripheryGap;
    bottomBand += st.peripheryGap;

    // Helper: midpoint of a node rect center.
    auto centerOf = [&layout](const std::string& id) -> std::pair<float, float> {
        auto it = layout.nodeRects.find(id);
        if (it == layout.nodeRects.end()) return {0.0f, 0.0f};
        const GraphRect& r = it->second;
        return {r.x + r.w * 0.5f, r.y + r.h * 0.5f};
    };
    auto hasRect = [&layout](const std::string& id) -> bool {
        return layout.nodeRects.find(id) != layout.nodeRects.end();
    };

    for (const GraphEdge& e : state.edges) {
        if (!hasRect(e.source.value) || !hasRect(e.target.value)) continue;

        EdgeRoute route;
        route.source = e.source;
        route.target = e.target;
        route.type = e.type;
        route.beliefOperation = e.beliefOperation;

        auto s = centerOf(e.source.value);
        auto t = centerOf(e.target.value);

        // Long edges: Belief->Plan along the top periphery, Distill->Belief
        // along the bottom periphery. These are the two routes that cross the
        // frame strip or return across it, so they get a dedicated band.
        bool isLong = (e.type == EdgeSemanticType::BeliefToPlan) ||
                      (e.type == EdgeSemanticType::DistillToBelief);
        route.longRoute = isLong;

        if (isLong && e.type == EdgeSemanticType::BeliefToPlan) {
            // Forward pass along the top: source center -> top band -> target.
            route.points = {
                {s.first, s.second},
                {s.first, topBand},
                {t.first, topBand},
                {t.first, t.second},
            };
        } else if (isLong && e.type == EdgeSemanticType::DistillToBelief) {
            // Return pass along the bottom: source center -> bottom band -> target.
            route.points = {
                {s.first, s.second},
                {s.first, bottomBand},
                {t.first, bottomBand},
                {t.first, t.second},
            };
        } else {
            // Local curve: source center -> upward mid control -> target center.
            float midY = (s.second + t.second) * 0.5f - 20.0f;
            route.points = {
                {s.first, s.second},
                {(s.first + t.first) * 0.5f, midY},
                {t.first, t.second},
            };
        }
        routes.push_back(std::move(route));
    }
    return routes;
}

} // namespace pie::gui
