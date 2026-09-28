// M4: link geometry, dependency emphasis, live stability and the cache
// (docs/milestones.md §6.2), replacing the v1 pi_gui_graph_m456_test.
//
// These four modules are all "geometry over the projection", and they share one
// contract: they read the projected state and the layout, and they never invent
// semantics. What is worth pinning is therefore:
//
//   * a link anchors ON its dot, so it is not drawn under the node it connects;
//   * a dependency query terminates on a cycle (the graphs are cyclic by
//     construction: execution -> distillation -> delta -> belief -> plan ->
//     execution);
//   * a CLOSED row's geometry is frozen, and an OPEN row's is not — the whole
//     point of the live layer is that a session in progress does not reflow the
//     part the user has already read;
//   * the cache recomputes exactly when the content changes, no more and no less.

#include <cmath>
#include <cstdio>
#include <set>
#include <string>
#include <vector>

#include "DemoEvents.h"
#include "Model.h"
#include "graph/GraphCache.h"
#include "graph/GraphInteraction.h"
#include "graph/GraphLive.h"
#include "graph/GraphModel.h"
#include "graph/GraphNavigation.h"
#include "graph/GraphRouting.h"
#include "graph/PieGraphLayout.h"

using namespace pie::gui;

static int failures = 0;
static void check(bool cond, const char* what) {
    if (!cond) {
        std::fprintf(stderr, "FAIL: %s\n", what);
        ++failures;
    } else {
        std::printf("ok: %s\n", what);
    }
}

// A hand-built state with a deliberate cycle, matching the demo's real shape:
// exec -> distill -> delta -> belief -> plan -> exec. The projection produces
// cycles legitimately, so every graph algorithm here has to survive one.
static GraphTaskState cyclicState() {
    GraphTaskState state;
    state.taskId = "t";
    auto node = [&state](const char* id, NodeFamily family, const char* episodeId) {
        GraphNode n;
        n.id = NodeId{id};
        n.family = family;
        n.episodeId = episodeId;
        n.title = id;
        n.fullText = id;
        state.nodes.push_back(std::move(n));
    };
    node("B:b1", NodeFamily::Belief, "");
    node("plan:p1", NodeFamily::Plan, "e1");
    node("exec:x1", NodeFamily::Execution, "e1");
    node("distill:d1", NodeFamily::Distillation, "e1");
    node("delta:dl1", NodeFamily::BeliefDelta, "e1");
    node("row:e1", NodeFamily::EpisodeRow, "e1");
    node("plan:p2", NodeFamily::Plan, "e2");
    node("exec:x2", NodeFamily::Execution, "e2");
    node("row:e2", NodeFamily::EpisodeRow, "e2");

    auto edge = [&state](const char* s, const char* t, EdgeSemanticType type) {
        GraphEdge e;
        e.source = NodeId{s};
        e.target = NodeId{t};
        e.type = type;
        state.edges.push_back(std::move(e));
    };
    edge("plan:p1", "exec:x1", EdgeSemanticType::PlanToExecution);
    edge("exec:x1", "distill:d1", EdgeSemanticType::ExecutionToDistillation);
    edge("distill:d1", "delta:dl1", EdgeSemanticType::DistillationToBeliefDelta);
    edge("delta:dl1", "B:b1", EdgeSemanticType::BeliefDeltaToBelief);
    // The cycle: the belief the delta wrote is read by the NEXT round's plan.
    edge("B:b1", "plan:p2", EdgeSemanticType::SourceToFormulation);
    edge("plan:p2", "exec:x2", EdgeSemanticType::PlanToExecution);

    EpisodeGutter g1;
    g1.id = "e1";
    g1.ordinal = 1;
    g1.status = EpisodeStatus::Closed;
    g1.stage = EpisodeStage::Closed;
    state.rows.push_back(g1);
    EpisodeGutter g2;
    g2.id = "e2";
    g2.ordinal = 2;
    g2.status = EpisodeStatus::Active;
    g2.stage = EpisodeStage::Executing;
    state.rows.push_back(g2);
    return state;
}

int main() {
    // ---------------------------------------------------------------------
    // Link routing
    // ---------------------------------------------------------------------
    {
        NativeGuiModel model;
        for (const std::string& line : demoEvents()) applyRpcLine(model, line);
        const GraphTaskState state = projectGraphTask(model);
        const PieGraphLayout layout = computeGraphLayout(state);
        const std::vector<EdgeRoute> routes = computeEdgeRoutes(state, layout);

        check(routes.size() == state.edges.size(),
              "every edge whose endpoints are placed produces exactly one route");

        bool anchorsOutsideDots = true;
        bool endpointsMatch = true;
        for (const EdgeRoute& route : routes) {
            const Dot* source = layout.dot(route.source.value);
            const Dot* target = layout.dot(route.target.value);
            if (source == nullptr || target == nullptr) {
                endpointsMatch = false;
                continue;
            }
            if (route.points.size() < 2) {
                endpointsMatch = false;
                continue;
            }
            // The first point must be nearer the source than the target, and the
            // last the reverse: a route drawn backwards would render an arrowhead
            // at the wrong end.
            const auto& first = route.points.front();
            const auto& last = route.points.back();
            const float firstToSource = std::hypot(first.first - source->x, first.second - source->y);
            const float lastToTarget = std::hypot(last.first - target->x, last.second - target->y);
            if (firstToSource < source->r * 0.9f || lastToTarget < target->r * 0.9f) {
                anchorsOutsideDots = false;
                std::fprintf(stderr, "  %s -> %s anchors inside a dot\n", route.source.value.c_str(),
                             route.target.value.c_str());
            }
        }
        check(endpointsMatch, "every route has both endpoints placed and at least two points");
        check(anchorsOutsideDots, "no link is drawn under the dot it connects");

        // Station-to-station links dogleg; cross-row links are straight.
        {
            bool stationDoglegs = true;
            bool crossRowStraight = true;
            for (const EdgeRoute& route : routes) {
                const GraphNode* source = state.node(route.source);
                const GraphNode* target = state.node(route.target);
                if (source == nullptr || target == nullptr) continue;
                const bool sameRow = !source->episodeId.empty() &&
                                     source->episodeId == target->episodeId;
                if (sameRow && !route.longRoute && route.points.size() != 3) stationDoglegs = false;
                if (route.longRoute && route.points.size() != 2) crossRowStraight = false;
            }
            check(stationDoglegs, "a station-to-station link is a 3-point dogleg");
            check(crossRowStraight, "a cross-row link is a single straight segment");
        }
        check(!routes.empty() && routes.front().points.size() >= 2, "routes carry points");

        // Determinism.
        {
            const std::vector<EdgeRoute> again = computeEdgeRoutes(state, layout);
            bool identical = again.size() == routes.size();
            for (size_t i = 0; identical && i < routes.size(); ++i) {
                identical = again[i].points == routes[i].points;
            }
            check(identical, "routing is deterministic");
        }
        // An edge whose endpoint has no dot is skipped rather than drawn to (0,0).
        {
            GraphTaskState broken = cyclicState();
            GraphEdge dangling;
            dangling.source = NodeId{"plan:p1"};
            dangling.target = NodeId{"does-not-exist"};
            dangling.type = EdgeSemanticType::PlanToExecution;
            broken.edges.push_back(dangling);
            const std::vector<EdgeRoute> brokenRoutes =
                computeEdgeRoutes(broken, computeGraphLayout(broken));
            check(brokenRoutes.size() == broken.edges.size() - 1,
                  "an edge with an unplaced endpoint is skipped, not drawn to the origin");
        }
    }

    // ---------------------------------------------------------------------
    // Dependency emphasis, on a cyclic graph
    // ---------------------------------------------------------------------
    {
        const GraphTaskState state = cyclicState();
        const std::set<std::string> fromP2 = computeDependencySet(state, "plan:p2");
        check(fromP2.count("plan:p2") != 0, "the selection is in its own dependency set");
        check(fromP2.count("exec:x2") != 0, "a descendant is included");
        // p2's ancestors run back through the cycle: B:b1 <- delta <- distill <-
        // exec <- plan:p1, and plan:p1 is also a descendant of p2 through the
        // cycle. The set must terminate and include the whole loop.
        check(fromP2.count("B:b1") != 0, "an ancestor across the row boundary is included");
        check(fromP2.count("delta:dl1") != 0, "the ancestor chain reaches the delta");
        check(fromP2.count("plan:p1") != 0, "the cycle is traversed rather than cut short");
        check(computeDependencySet(state, "").empty(), "an empty selection has an empty set");
        // A node with no edges still depends on itself: the set is "the selected
        // node plus its ancestors and descendants", and a node nobody links to has
        // exactly one member. Asserting an empty set here would be asserting a
        // different rule than the one the module implements.
        {
            const std::set<std::string> lonely = computeDependencySet(state, "no-such-node");
            check(lonely.size() == 1 && lonely.count("no-such-node") != 0,
                  "an unconnected selection depends only on itself");
        }

        // A bare 2-cycle terminates.
        {
            GraphTaskState two;
            GraphNode a;
            a.id = NodeId{"a"};
            a.title = "a";
            a.fullText = "a";
            GraphNode b;
            b.id = NodeId{"b"};
            b.title = "b";
            b.fullText = "b";
            two.nodes = {a, b};
            GraphEdge ab;
            ab.source = NodeId{"a"};
            ab.target = NodeId{"b"};
            GraphEdge ba;
            ba.source = NodeId{"b"};
            ba.target = NodeId{"a"};
            two.edges = {ab, ba};
            const std::set<std::string> set = computeDependencySet(two, "a");
            check(set.size() == 2 && set.count("a") && set.count("b"),
                  "a two-node cycle terminates with exactly both nodes");
        }
    }

    // ---------------------------------------------------------------------
    // Live stability: a closed row is frozen, an open one is not
    // ---------------------------------------------------------------------
    {
        // Built from the demo UP TO the point where episode 1 has closed and the
        // task is still open. Appending to the finished demo would be refused by
        // the fold (an episode cannot open on a completed task), which is the
        // contract working rather than a bug to work around.
        const std::vector<std::string> demo = demoEvents();
        NativeGuiModel model;
        for (size_t i = 0; i < 22; ++i) applyRpcLine(model, demo[i]);
        check(model.issues().empty(), "the live fixture's prefix folds cleanly");
        GraphTaskState state = projectGraphTask(model);
        check(state.rows.size() == 1 && state.rows[0].status == EpisodeStatus::Closed,
              "the fixture starts with one closed row");
        const PieGraphLayout fresh1 = computeGraphLayout(state);
        GraphLiveState live;
        const PieGraphLayout stable1 = stabilizeLiveLayout(state, fresh1, live);
        check(live.completedEpisodes.size() == 1, "the closed row is frozen");
        check(live.stableRailNodes.size() == 3,
              "one belief and the one version so far are frozen on their rails");

        // Now append to the session: a third episode opens and runs. The frozen
        // rows must not move, and the new row must be placed.
        const char* more[] = {
            R"({"type":"EpisodeOpened","schemaVersion":7,"eventId":"live-1","taskId":"task-1","episodeId":"episode-3","ordinal":2})",
            R"({"type":"RoutingDecided","schemaVersion":7,"eventId":"live-2","taskId":"task-1","episodeId":"episode-3","routing":{"id":"routing-3","statement":"s","decision":"belief-loop","suitabilityProbability":0.5,"successProbability":0.5,"estimatedSteps":1,"difficulty":"low","reason":"r"}})",
            R"({"type":"EpisodeBodySelected","schemaVersion":7,"eventId":"live-3","taskId":"task-1","episodeId":"episode-3","body":"belief-loop","openBeliefsAtStart":["belief-1"]})",
            R"({"type":"PlanProduced","schemaVersion":7,"eventId":"live-4","taskId":"task-1","episodeId":"episode-3","plan":{"id":"plan-3","selectedToExplore":["belief-1"],"intent":"one more probe","formulation":{"kind":"version","versionId":"formulation-1"}}})",
        };
        for (const char* line : more) applyRpcLine(model, line);
        check(model.issues().empty(), "the appended round folds cleanly");
        state = projectGraphTask(model);
        const PieGraphLayout fresh2 = computeGraphLayout(state);
        const PieGraphLayout stable2 = stabilizeLiveLayout(state, fresh2, live);

        bool frozen = true;
        for (const auto& entry : live.completedEpisodes) {
            for (const auto& nodeEntry : entry.second.nodes) {
                const Dot* now = stable2.dot(nodeEntry.first);
                if (now == nullptr || now->x != nodeEntry.second.x || now->y != nodeEntry.second.y) {
                    frozen = false;
                    std::fprintf(stderr, "  frozen node %s moved\n", nodeEntry.first.c_str());
                }
            }
        }
        check(frozen, "a closed row's dots keep their exact positions across a live update");
        check(state.rows.size() == 2, "the new row was projected");
        check(stable2.dot("row:episode-3") != nullptr, "the new row was placed");
        check(stable2.dot("plan:plan-3") != nullptr, "the new station was placed");
        // The rail did not move either: a version and a belief are append-only, so
        // their positions cannot legitimately change.
        {
            const Dot* version = stable2.dot("Fv:formulation-1");
            const Dot* before = stable1.dot("Fv:formulation-1");
            check(version != nullptr && before != nullptr && version->x == before->x &&
                      version->y == before->y,
                  "a frozen rail entry keeps its position");
        }
        check(live.completedEpisodes.count("episode-3") == 0,
              "an OPEN row is not frozen — only a closed one has final geometry");
        // An empty state stabilizes to an empty layout without crashing.
        {
            GraphLiveState emptyLive;
            const GraphTaskState empty;
            const PieGraphLayout stabilized = stabilizeLiveLayout(empty, computeGraphLayout(empty), emptyLive);
            check(stabilized.nodes.empty(), "an empty state stabilizes to nothing");
        }
    }

    // ---------------------------------------------------------------------
    // The cache: recompute exactly when the content changes
    // ---------------------------------------------------------------------
    {
        NativeGuiModel model;
        for (const std::string& line : demoEvents()) applyRpcLine(model, line);
        const GraphTaskState state = projectGraphTask(model);
        const PieGraphLayout layout = computeGraphLayout(state);

        GraphCache cache;
        GraphCacheMetrics metrics;
        cache.getLayout(state, metrics);
        cache.getDependencySet(state, "plan:plan-1", metrics);
        cache.getRoutes(state, layout, metrics);
        check(metrics.layoutComputes == 1 && metrics.dependencyComputes == 1 &&
                  metrics.routeComputes == 1,
              "the first access computes each cache once");

        // Unchanged input: served from cache.
        for (int i = 0; i < 20; ++i) {
            cache.getLayout(state, metrics);
            cache.getDependencySet(state, "plan:plan-1", metrics);
            cache.getRoutes(state, layout, metrics);
        }
        check(metrics.layoutComputes == 1 && metrics.dependencyComputes == 1 &&
                  metrics.routeComputes == 1,
              "an unchanged state recomputes nothing");

        // A new selection recomputes only the dependency set.
        cache.getDependencySet(state, "plan:plan-2", metrics);
        check(metrics.dependencyComputes == 2, "a new selection recomputes the dependency set");
        check(metrics.layoutComputes == 1 && metrics.routeComputes == 1,
              "a new selection does not touch the layout or the routes");

        // A state change recomputes the layout and the routes.
        const GraphTaskState changed = [&] {
            GraphTaskState copy = state;
            GraphNode extra;
            extra.id = NodeId{"invented:1"};
            extra.family = NodeFamily::Execution;
            extra.episodeId = "episode-2";
            extra.title = "invented";
            extra.fullText = "invented";
            extra.order = 99;
            copy.nodes.push_back(extra);
            return copy;
        }();
        cache.getLayout(changed, metrics);
        check(metrics.layoutComputes == 2, "a changed state recomputes the layout");

        // A pure geometry change invalidates the routes but not the state itself.
        {
            GraphCache geometryCache;
            GraphCacheMetrics geometryMetrics;
            geometryCache.getRoutes(state, layout, geometryMetrics);
            PieGraphLayout moved = layout;
            if (!moved.nodes.empty()) moved.nodes.begin()->second.x += 10.0f;
            geometryCache.getRoutes(state, moved, geometryMetrics);
            check(geometryMetrics.routeComputes == 2, "a geometry change recomputes the routes");
        }

        cache.clear();
        cache.getLayout(state, metrics);
        check(metrics.layoutComputes == 3, "clear() forces a recompute");

        check(cache.getLongRoutes(state, layout, metrics).size() <=
                  cache.getRoutes(state, layout, metrics).size(),
              "the long-route subset is a subset of the routes");
        check(!cache.getLongRoutes(state, layout, metrics).empty(),
              "the demo has cross-row citations, so the long-route set is not empty");
    }

    // ---------------------------------------------------------------------
    // Focus Current pan, on dots
    // ---------------------------------------------------------------------
    {
        const GraphTaskState state = cyclicState();
        const PieGraphLayout layout = computeGraphLayout(state);
        const PanResult pan = computeFocusPan(layout, "plan:p2", 800.0f, 600.0f, 1.0f);
        const Dot* dot = layout.dot("plan:p2");
        check(dot != nullptr, "the target dot exists");
        check(dot != nullptr && std::fabs(pan.x - (800.0f * 0.5f - dot->x)) < 0.001f &&
                  std::fabs(pan.y - (600.0f * 0.5f - dot->y)) < 0.001f,
              "Focus Current centers the dot in the viewport");
        const PanResult unknown = computeFocusPan(layout, "no-such-node", 800.0f, 600.0f, 1.0f);
        check(unknown.x == 0.0f && unknown.y == 0.0f, "an unknown node pans nowhere");
    }

    if (failures == 0) {
        std::printf("ALL PASS\n");
    } else {
        std::printf("%d FAILURES\n", failures);
    }
    return failures == 0 ? 0 : 1;
}
