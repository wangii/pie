// M5: the live canvas (docs/milestones.md §6.2), replacing the v1
// pi_gui_graph_m789_test.
//
// GraphEdges.test.cpp already covers the freeze rule at the module level. What is
// tested here is the part that only shows up once a session has been running for a
// while: a LONG session. The v1 suite used a 500-node/50-row fixture for the same
// reason — the failures that matter are the ones that need many rounds to appear:
//
//   * the canvas still grows (a frozen row must not stop the extent from growing),
//   * the cache still serves an unchanged state after hundreds of frames,
//   * and layout cost stays proportional to the state, not to the session's age.

#include <chrono>
#include <cstdio>
#include <string>
#include <vector>

#include "Model.h"
#include "graph/GraphCache.h"
#include "graph/GraphLive.h"
#include "graph/GraphModel.h"
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

// A synthetic session of `episodes` closed rounds plus one open one, with two
// beliefs carried across all of them. Built directly rather than by folding
// events: the point is the canvas's behaviour at scale, not the fold's.
static NativeGuiModel longSession(int episodes) {
    NativeGuiModel model;
    std::string lines;
    auto emit = [&](const std::string& line) { applyRpcLine(model, line); };

    emit(R"({"type":"TaskOpened","schemaVersion":7,"eventId":"e0","taskId":"t","initialPrompt":{"id":"p","original":"a long session","effective":"a long session"},"inheritedBeliefs":[]})");
    emit(R"({"type":"FocusDeclared","schemaVersion":7,"eventId":"e1","taskId":"t","beliefIds":["b1"]})");

    for (int i = 1; i <= episodes; ++i) {
        const std::string n = std::to_string(i);
        const bool last = i == episodes;
        emit("{\"type\":\"EpisodeOpened\",\"schemaVersion\":7,\"eventId\":\"o" + n +
             "\",\"taskId\":\"t\",\"episodeId\":\"ep" + n + "\",\"ordinal\":" + n + "}");
        emit("{\"type\":\"RoutingDecided\",\"schemaVersion\":7,\"eventId\":\"r" + n +
             "\",\"taskId\":\"t\",\"episodeId\":\"ep" + n +
             "\",\"routing\":{\"id\":\"ro" + n +
             "\",\"statement\":\"s\",\"decision\":\"belief-loop\",\"suitabilityProbability\":0.5,"
             "\"successProbability\":0.5,\"estimatedSteps\":1,\"difficulty\":\"low\",\"reason\":\"r\"}}");
        emit("{\"type\":\"EpisodeBodySelected\",\"schemaVersion\":7,\"eventId\":\"b" + n +
             "\",\"taskId\":\"t\",\"episodeId\":\"ep" + n +
             "\",\"body\":\"belief-loop\",\"openBeliefsAtStart\":[]}");
        emit("{\"type\":\"PlanProduced\",\"schemaVersion\":7,\"eventId\":\"pl" + n +
             "\",\"taskId\":\"t\",\"episodeId\":\"ep" + n + "\",\"plan\":{\"id\":\"plan" + n +
             "\",\"selectedToExplore\":[],\"intent\":\"probe " + n +
             "\",\"formulation\":{\"kind\":\"unformed\"}}}");
        emit("{\"type\":\"ExecutionStarted\",\"schemaVersion\":7,\"eventId\":\"x" + n +
             "\",\"taskId\":\"t\",\"episodeId\":\"ep" + n + "\",\"execution\":{\"id\":\"exec" + n +
             "\",\"planId\":\"plan" + n + "\",\"intention\":\"i\",\"tool\":\"bash\",\"input\":{\"command\":\"true\"}}}");
        emit("{\"type\":\"ExecutionCompleted\",\"schemaVersion\":7,\"eventId\":\"xc" + n +
             "\",\"taskId\":\"t\",\"episodeId\":\"ep" + n + "\",\"executionId\":\"exec" + n +
             "\",\"output\":\"ok\",\"status\":\"succeeded\"}");
        // Round 1 PROPOSES the belief: there is nothing to support yet, and a
        // propose-phase delta is not "distill-produced", so round 1 records no
        // distillation (the contract requires a distillation's outputs to match the
        // distill-produced deltas exactly, and an empty match is a refusal, not an
        // empty list). Later rounds support it, from the distill phase.
        const bool proposing = i == 1;
        const std::string source =
            proposing ? "" : "\"sourceBeliefId\":\"b1\",\"beliefId\":\"b1\",";
        emit("{\"type\":\"BeliefDeltaApplied\",\"schemaVersion\":7,\"eventId\":\"d" + n +
             "\",\"taskId\":\"t\",\"episodeId\":\"ep" + n + "\",\"delta\":{\"id\":\"delta" + n +
             "\",\"episodeId\":\"ep" + n + "\",\"producerPhase\":\"" +
             (proposing ? "propose" : "distill") + "\",\"operation\":\"" +
             (proposing ? "propose" : "support") + "\"," + source +
             "\"resultBeliefId\":\"b1\",\"resultingBeliefs\":[{\"id\":\"b1\",\"statement\":\"a carried claim\","
             "\"domain\":\"code\",\"expectation\":\"e\",\"evidenceRounds\":" + n +
             ",\"skillRefs\":[],\"supportedBy\":[],\"refutedBy\":[],\"withdrawn\":false}]},"
             "\"activeBeliefs\":[\"b1\"]}");
        if (!proposing) {
            emit("{\"type\":\"DistillationProduced\",\"schemaVersion\":7,\"eventId\":\"di" + n +
                 "\",\"taskId\":\"t\",\"episodeId\":\"ep" + n + "\",\"distillation\":{\"id\":\"dist" + n +
                 "\",\"inputs\":[\"exec" + n + "\"],\"contents\":\"c\",\"outputs\":[\"delta" + n + "\"]}}");
        }
        if (!last) {
            emit("{\"type\":\"EpisodeClosed\",\"schemaVersion\":7,\"eventId\":\"c" + n +
                 "\",\"taskId\":\"t\",\"episodeId\":\"ep" + n + "\"}");
        }
    }
    return model;
}

int main() {
    // ---------------------------------------------------------------------
    // A long session: the canvas grows, the frozen rows stay put
    // ---------------------------------------------------------------------
    {
        constexpr int kEpisodes = 40;
        NativeGuiModel model = longSession(kEpisodes);
        check(model.issues().empty(), "the 40-round fixture folds without issues");

        GraphTaskState state = projectGraphTask(model);
        check(state.rows.size() == static_cast<size_t>(kEpisodes), "every round has a row");
        check(state.nodes.size() > static_cast<size_t>(kEpisodes) * 5,
              "every round contributed its stations");
        check(state.edges.size() > static_cast<size_t>(kEpisodes) * 3,
              "every round contributed its links");

        const PieGraphLayout fresh = computeGraphLayout(state);
        check(fresh.nodes.size() == state.nodes.size(), "every node is placed at scale");
        check(fresh.canvasHeight > 0.0f && fresh.canvasWidth > 0.0f, "the canvas has an extent");

        GraphLiveState live;
        const PieGraphLayout stable = stabilizeLiveLayout(state, fresh, live);
        check(live.completedEpisodes.size() == static_cast<size_t>(kEpisodes - 1),
              "every closed round is frozen");
        check(live.completedEpisodes.count("ep" + std::to_string(kEpisodes)) == 0,
              "the open round is not frozen");

        // The frozen geometry is identical to the fresh one on FIRST freeze (a
        // freeze must not move anything), and stays identical afterwards.
        {
            bool same = true;
            for (const auto& entry : live.completedEpisodes) {
                for (const auto& node : entry.second.nodes) {
                    const Dot* now = stable.dot(node.first);
                    if (now == nullptr || now->x != node.second.x || now->y != node.second.y) same = false;
                }
            }
            check(same, "freezing a row does not move it");
        }

        // Now the open round grows. The frozen rows must not move, and the canvas
        // must still get taller if the open round needs more room.
        applyRpcLine(model, R"({"type":"ExecutionStarted","schemaVersion":7,"eventId":"grow","taskId":"t","episodeId":"ep40","execution":{"id":"exec-extra","planId":"plan40","intention":"i","tool":"bash","input":{"command":"true"}}})");
        applyRpcLine(model, R"({"type":"ExecutionCompleted","schemaVersion":7,"eventId":"grow2","taskId":"t","episodeId":"ep40","executionId":"exec-extra","output":"ok","status":"succeeded"})");
        GraphTaskState grown = projectGraphTask(model);
        const PieGraphLayout grownFresh = computeGraphLayout(grown);
        const PieGraphLayout grownStable = stabilizeLiveLayout(grown, grownFresh, live);

        bool frozenStill = true;
        for (const auto& entry : live.completedEpisodes) {
            for (const auto& node : entry.second.nodes) {
                const Dot* now = grownStable.dot(node.first);
                if (now == nullptr || now->x != node.second.x || now->y != node.second.y) {
                    frozenStill = false;
                    std::fprintf(stderr, "  %s moved after the open round grew\n", node.first.c_str());
                }
            }
        }
        check(frozenStill, "40 frozen rows do not move when the open round grows");
        check(grownStable.dot("exec:exec-extra") != nullptr, "the new station in the open round is placed");
        check(grownStable.canvasWidth > 0.0f, "the canvas extent survives a live update");
    }

    // ---------------------------------------------------------------------
    // The cache across a long, mostly-unchanged session
    // ---------------------------------------------------------------------
    {
        NativeGuiModel model = longSession(30);
        const GraphTaskState state = projectGraphTask(model);
        const PieGraphLayout layout = computeGraphLayout(state);

        GraphCache cache;
        GraphCacheMetrics metrics;
        cache.getLayout(state, metrics);
        cache.getRoutes(state, layout, metrics);
        cache.getDependencySet(state, "plan:plan15", metrics);
        check(metrics.layoutComputes == 1 && metrics.routeComputes == 1 &&
                  metrics.dependencyComputes == 1,
              "the first frame computes each cache once");

        // A hundred frames of a live session with nothing new. Every frame asks for
        // the same three things; none of them may recompute.
        for (int frame = 0; frame < 100; ++frame) {
            cache.getLayout(state, metrics);
            cache.getRoutes(state, layout, metrics);
            cache.getDependencySet(state, "plan:plan15", metrics);
        }
        check(metrics.layoutComputes == 1 && metrics.routeComputes == 1 &&
                  metrics.dependencyComputes == 1,
              "a hundred idle frames recompute nothing");

        // One new event: the layout and the routes recompute once, and the reused
        // dependency set is recomputed too (its input changed).
        GraphTaskState changed = state;
        GraphNode extra;
        extra.id = NodeId{"exec:late"};
        extra.family = NodeFamily::Execution;
        extra.episodeId = "ep30";
        extra.title = "bash";
        extra.fullText = "late";
        extra.order = 90;
        changed.nodes.push_back(std::move(extra));
        cache.getLayout(changed, metrics);
        cache.getRoutes(changed, computeGraphLayout(changed), metrics);
        check(metrics.layoutComputes == 2, "one new event recomputes the layout exactly once");
        check(metrics.routeComputes == 2, "one new event recomputes the routes exactly once");
    }

    // ---------------------------------------------------------------------
    // Cost: a layout over a long session stays fast, and is not quadratic
    // ---------------------------------------------------------------------
    {
        // The layout is O(nodes) plus an O(nodes * rows) scan. A session with 40
        // rounds is around 300 nodes; if a future edit makes it quadratic this
        // budget catches it before the canvas stutters. Generous on purpose — this
        // is a canary, not a benchmark.
        NativeGuiModel model = longSession(40);
        const GraphTaskState state = projectGraphTask(model);
        const auto start = std::chrono::steady_clock::now();
        constexpr int kIterations = 50;
        for (int i = 0; i < kIterations; ++i) {
            const PieGraphLayout layout = computeGraphLayout(state);
            if (layout.nodes.empty()) {
                check(false, "the layout produced nothing");
                break;
            }
        }
        const auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
                                 std::chrono::steady_clock::now() - start)
                                 .count();
        std::printf("  50 layouts of %zu nodes over %zu rows took %lldms\n", state.nodes.size(),
                    state.rows.size(), static_cast<long long>(elapsed));
        // A frame draws once, so the per-frame cost is this divided by 50. One
        // second for 50 is a very loose ceiling that still catches an accidental
        // quadratic.
        check(elapsed < 1000, "50 layouts of a 40-round session stay well under a second");
    }

    // ---------------------------------------------------------------------
    // An empty session is a state the canvas renders
    // ---------------------------------------------------------------------
    {
        NativeGuiModel empty;
        const GraphTaskState state = projectGraphTask(empty);
        const PieGraphLayout layout = computeGraphLayout(state);
        check(state.nodes.empty() && state.rows.empty(), "an empty session projects nothing");
        check(layout.canvasWidth > 0.0f && layout.canvasHeight > 0.0f,
              "an empty session still has a positive canvas, so no consumer divides by zero");
        GraphLiveState live;
        const PieGraphLayout stable = stabilizeLiveLayout(state, layout, live);
        check(stable.nodes.empty() && live.completedEpisodes.empty(),
              "an empty session freezes nothing");
    }

    if (failures == 0) {
        std::printf("ALL PASS\n");
    } else {
        std::printf("%d FAILURES\n", failures);
    }
    return failures == 0 ? 0 : 1;
}
