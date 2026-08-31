// Headless tests for Phase 2 M4 (edge routing), M5 (selection dependency path),
// and M6 (live-layout stability). No window, no ImGui, no SDK.
// Run: ./pi_gui_graph_m456_test  (non-zero on failure).

#include "graph/GraphModel.h"
#include "graph/PieGraphLayout.h"
#include "graph/GraphRouting.h"
#include "graph/GraphInteraction.h"
#include "graph/GraphLive.h"

#include <cstdio>
#include <map>
#include <set>
#include <string>
#include <utility>
#include <vector>

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

// A compact GraphTaskState with one closed frame (with a cycle among its nodes)
// and two global beliefs, giving both cross-region (Belief->Plan,
// Distill->Belief) and
// local (Plan->Execution, Execution->Distill) edges. The cycle (E1 -> P1 -> E2
// -> D1 -> E1... but edges are semantic) exercises the cycle-safe traversal; we
// add one deliberate cross edge that re-enters an earlier node.
//
// Topology:
//   Beliefs: B1 (no frame), B2 (no frame)
//   Frame 10 (CLOSED):
//     Plan P10, Exec E10a, Exec E10b, Distill D10
//     Edges: B1->P10, B2->P10 (BeliefToPlan, orthogonal cross-region)
//            P10->E10a, P10->E10b (PlanToExecution, local)
//            E10a->D10, E10b->D10 (ExecutionToDistill, local)
//            D10->B1, D10->B2 (DistillToBelief, orthogonal return)
//   Frame 20 (OPEN):
//     Plan P20, Exec E20, Distill D20
//     Edges: B1->P20 (long top), P20->E20, E20->D20, D20->B2 (long bottom)
//            E20->E10b (a cross-frame local hop, creates a back-reference
//                       so a DFS that isn't cycle-safe would loop E20->E10b->D10->B1->P20->E20).
static GraphTaskState buildState() {
    GraphTaskState s;
    auto node = [&](const std::string& id, NodeFamily f, const std::string& frame, bool closedFrame) {
        GraphNode n;
        n.id.value = id;
        n.family = f;
        if (!frame.empty()) n.frameId = frame;
        n.title = id;
        n.compactText = id;
        n.fullText = id;
        s.nodes.push_back(n);
    };
    auto edge = [&](const std::string& src, const std::string& dst, EdgeSemanticType t) {
        GraphEdge e;
        e.source.value = src;
        e.target.value = dst;
        e.type = t;
        s.edges.push_back(e);
    };

    node("B1", NodeFamily::Belief, "", false);
    node("B2", NodeFamily::Belief, "", false);
    // Frame 10 (closed).
    node("P10", NodeFamily::Plan, "10", false);
    node("E10a", NodeFamily::Execution, "10", false);
    node("E10b", NodeFamily::Execution, "10", false);
    node("D10", NodeFamily::Distill, "10", false);
    // Frame 20 (open).
    node("P20", NodeFamily::Plan, "20", false);
    node("E20", NodeFamily::Execution, "20", false);
    node("D20", NodeFamily::Distill, "20", false);

    edge("B1", "P10", EdgeSemanticType::BeliefToPlan);
    edge("B2", "P10", EdgeSemanticType::BeliefToPlan);
    edge("P10", "E10a", EdgeSemanticType::PlanToExecution);
    edge("P10", "E10b", EdgeSemanticType::PlanToExecution);
    edge("E10a", "D10", EdgeSemanticType::ExecutionToDistill);
    edge("E10b", "D10", EdgeSemanticType::ExecutionToDistill);
    edge("D10", "B1", EdgeSemanticType::DistillToBelief);
    edge("D10", "B2", EdgeSemanticType::DistillToBelief);

    edge("B1", "P20", EdgeSemanticType::BeliefToPlan);
    edge("P20", "E20", EdgeSemanticType::PlanToExecution);
    edge("E20", "D20", EdgeSemanticType::ExecutionToDistill);
    edge("D20", "B2", EdgeSemanticType::DistillToBelief);
    // Cross-frame back-reference creating a cycle for the traversal test.
    edge("E20", "E10b", EdgeSemanticType::ExecutionToDistill);

    LoopFrameInfo f10;
    f10.id = "10";
    f10.label = "LoopFrame #10";
    f10.closed = true;
    LoopFrameInfo f20;
    f20.id = "20";
    f20.label = "LoopFrame #20";
    f20.closed = false;
    s.frames.push_back(f10);
    s.frames.push_back(f20);
    return s;
}

// --- M4: edge routing ---
static void testRouting(const GraphTaskState& s, const PieGraphLayout& layout) {
    std::vector<EdgeRoute> routes = computeEdgeRoutes(s, layout);
    check(!routes.empty(), "M4: routes produced for every placed edge");

    bool haveForward = false, haveReturn = false, haveLocal = false;
    for (const EdgeRoute& r : routes) {
        if (r.type == EdgeSemanticType::BeliefToPlan) {
            haveForward = true;
            check(r.longRoute, "M4: Belief->Plan is a long cross-region route");
            check(r.points.size() == 2, "M4: Belief->Plan is a direct line, not a polyline");
        } else if (r.type == EdgeSemanticType::DistillToBelief) {
            haveReturn = true;
            check(r.longRoute, "M4: Distill->Belief is a long cross-region return route");
            check(r.points.size() == 2, "M4: Distill->Belief is a direct line, not a polyline");
        } else {
            haveLocal = true;
            check(!r.longRoute, "M4: local edge is not a long route");
            check(r.points.size() == 3, "M4: local edge keeps the short curve");
        }
    }
    check(haveForward, "M4: at least one Belief->Plan route");
    check(haveReturn, "M4: at least one Distill->Belief route");
    check(haveLocal, "M4: at least one local (Plan/Exec ->) route");

    // Determinism: identical inputs -> identical routes.
    std::vector<EdgeRoute> again = computeEdgeRoutes(s, layout);
    bool deterministic = again.size() == routes.size();
    if (deterministic) {
        for (size_t i = 0; i < routes.size(); ++i) {
            if (again[i].points.size() != routes[i].points.size()) { deterministic = false; break; }
            for (size_t j = 0; j < routes[i].points.size(); ++j) {
                if (again[i].points[j] != routes[i].points[j]) { deterministic = false; break; }
            }
            if (!deterministic) break;
        }
    }
    check(deterministic, "M4: routing is deterministic");
}

// --- M5: selection dependency path (cycle-safe) ---
static void testDependency(const GraphTaskState& s) {
    // Select P20. Its ancestors = B1 (and by the back-ref E20->E10b chain, all
    // nodes reaching P20 via reverse edges). Its descendants = E20, D20, E10b
    // (via E20->E10b), D10, E20... but the set is cycle-safe and must terminate.
    std::set<std::string> dep = computeDependencySet(s, "P20");
    // The cycle E20->E10b->D10->B1->P20 must not cause an infinite loop; the set
    // is finite and includes the reachable descendants of P20.
    check(dep.count("P20"), "M5: selected node is in its dependency set");
    check(dep.count("E20"), "M5: P20's descendant E20 is in the set");
    check(dep.count("D20"), "M5: P20's descendant D20 is in the set");
    check(dep.count("E10b"), "M5: back-referenced E10b is reachable from P20");

    // Cycle safety: a node far from the selection must not be pulled in unless
    // actually reachable within the cycle. No infinite loop = the test returns.
    dep = computeDependencySet(s, "E10a");
    check(dep.count("E10a") && dep.count("D10") && dep.count("P10"), "M5: E10a's ancestors/descendants found");
    check(dep.count("B1"), "M5: E10a reaches global belief B1 through D10");

    // Empty selection -> empty set.
    check(computeDependencySet(s, "").empty(), "M5: empty selection yields empty set");

    // Cycle-safe: assert the traversal terminated for a graph with a 2-cycle.
    GraphTaskState cyc;
    GraphNode a; a.id.value = "A"; a.family = NodeFamily::Plan; cyc.nodes.push_back(a);
    GraphNode b; b.id.value = "B"; b.family = NodeFamily::Plan; cyc.nodes.push_back(b);
    GraphEdge ab; ab.source.value = "A"; ab.target.value = "B"; ab.type = EdgeSemanticType::PlanToExecution; cyc.edges.push_back(ab);
    GraphEdge ba; ba.source.value = "B"; ba.target.value = "A"; ba.type = EdgeSemanticType::ExecutionToDistill; cyc.edges.push_back(ba);
    std::set<std::string> two = computeDependencySet(cyc, "A");
    check(two.size() == 2 && two.count("A") && two.count("B"), "M5: 2-cycle traversal terminates with both nodes");
}

// --- M6: live-layout stability ---
static void testLive(const GraphTaskState& s) {
    GraphLiveState live;
    PieGraphLayout fresh1 = computeGraphLayout(s);
    check(fresh1.nodeRects.size() == s.nodes.size(), "M6: fresh layout places every node");
    PieGraphLayout stable1 = stabilizeLiveLayout(s, fresh1, live);
    check(live.completedFrames.count("10") == 1 && !live.completedFrames.count("20"),
          "M6: only the completed frame is cached");

    // Emulate a later live round with an extra execution and a Propose node in
    // the open frame. The completed frame must stay frozen as one geometry
    // group, while the open frame takes the fresh relayout.
    GraphTaskState s2 = s;
    // Add a second open-frame node so the layout engine produces different
    // coordinates for the open frame; settled nodes must not move.
    GraphNode n;
    n.id.value = "E21";
    n.family = NodeFamily::Execution;
    n.frameId = "20";
    n.title = "E21";
    s2.nodes.push_back(n);
    GraphNode proposal;
    proposal.id.value = "PR20";
    proposal.family = NodeFamily::Propose;
    proposal.frameId = "20";
    proposal.title = "PR20";
    s2.nodes.push_back(proposal);
    s2.currentNode = NodeId{"E21"};
    LoopFrameInfo g20;
    g20.id = "20"; g20.label = "LoopFrame #20"; g20.closed = false;
    s2.frames.clear();
    s2.frames.push_back(s.frames[0]);  // frame 10 (closed)
    s2.frames.push_back(g20);          // frame 20 (open)

    PieGraphLayout fresh2 = computeGraphLayout(s2);
    PieGraphLayout stable2 = stabilizeLiveLayout(s2, fresh2, live);

    bool settledFrozen = true;
    for (const GraphNode& node : s2.nodes) {
        bool settled = node.family == NodeFamily::Belief || (node.frameId && node.frameId == "10");
        if (!settled) continue;
        auto it1 = stable1.nodeRects.find(node.id.value);
        auto it2 = stable2.nodeRects.find(node.id.value);
        if (it1 == stable1.nodeRects.end() || it2 == stable2.nodeRects.end()) { settledFrozen = false; break; }
        if (it1->second.x != it2->second.x || it1->second.y != it2->second.y ||
            it1->second.w != it2->second.w || it1->second.h != it2->second.h) settledFrozen = false;
    }
    check(settledFrozen, "M6: closed-frame + belief nodes are frozen across a live update");

    auto sameRect = [](const GraphRect& a, const GraphRect& b) {
        return a.x == b.x && a.y == b.y && a.w == b.w && a.h == b.h;
    };
    check(sameRect(stable1.frameRects.at("10"), stable2.frameRects.at("10")) &&
              sameRect(stable1.planRegionRects.at("10"), stable2.planRegionRects.at("10")) &&
              sameRect(stable1.executionRegionRects.at("10"), stable2.executionRegionRects.at("10")),
          "M6: completed frame boundary and region surfaces are cached together");

    // Adding the Propose band moves the existing open-frame Plan down. It must
    // use the fresh position instead of an old node-level frozen rectangle.
    check(stable1.nodeRects.at("P20").y != fresh2.nodeRects.at("P20").y &&
              sameRect(stable2.nodeRects.at("P20"), fresh2.nodeRects.at("P20")),
          "M6: existing open-frame nodes take the fresh relayout");

    auto e21 = stable2.nodeRects.find("E21");
    check(e21 != stable2.nodeRects.end(), "M6: new open-frame node is placed after relayout");

    // Belief stability: belief nodes appear in the same rects across rounds.
    auto b1a = stable1.nodeRects.find("B1");
    auto b1b = stable2.nodeRects.find("B1");
    check(b1a != stable1.nodeRects.end() && b1b != stable2.nodeRects.end() &&
          b1a->second.x == b1b->second.x && b1a->second.y == b1b->second.y,
          "M6: belief nodes are position-stable across live updates");
}

// --- Belief lifecycle across live updates: a product/code belief is position-
// stable (frozen) when the latest episode grows, whether it is still proposed or
// already adjudicated. There is no longer a framing "Target" freshness case.
static void testFramingFollowsLatest() {
    auto mkNode = [](const std::string& id, NodeFamily f, const std::string& frame,
                     const std::string& domain, const std::string& createdIn,
                     const std::string& displayType, uint64_t order) {
        GraphNode n;
        n.id.value = id;
        n.family = f;
        if (!frame.empty()) n.frameId = frame;
        if (!domain.empty()) n.domain = domain;
        if (!createdIn.empty()) n.createdInFrame = createdIn;
        n.displayType = displayType;
        n.title = id;
        n.compactText = id;
        n.fullText = id;
        n.creationOrder = order;
        return n;
    };

    GraphTaskState s;
    LoopFrameInfo f20; f20.id = "20"; f20.label = "LoopFrame #20"; f20.closed = false;
    s.frames.push_back(f20);
    s.nodes.push_back(mkNode("B1", NodeFamily::Belief, "", "code", "20", "proposed", 1));
    s.nodes.push_back(mkNode("B2", NodeFamily::Belief, "", "code", "20", "supported", 2));
    s.nodes.push_back(mkNode("P20", NodeFamily::Plan, "20", "", "", "", 3));
    s.nodes.push_back(mkNode("E20", NodeFamily::Execution, "20", "", "", "", 4));

    GraphLiveState live;
    PieGraphLayout stable1 = stabilizeLiveLayout(s, computeGraphLayout(s), live);
    float b1y1 = stable1.nodeRects["B1"].y;
    float b2y1 = stable1.nodeRects["B2"].y;
    check(stable1.nodeRects.count("B1") == 1, "M6+: product/code belief placed by fresh layout");

    // Grow the latest (open) episode with a second execution node; the frame gets
    // taller, but the beliefs stay position-stable.
    GraphTaskState s2 = s;
    s2.nodes.push_back(mkNode("E21", NodeFamily::Execution, "20", "", "", "", 5));
    PieGraphLayout stable2 = stabilizeLiveLayout(s2, computeGraphLayout(s2), live);

    float b1y2 = stable2.nodeRects["B1"].y;
    float b2y2 = stable2.nodeRects["B2"].y;
    check(b1y2 == b1y1, "M6+: proposed product/code belief stays frozen across the update");
    check(b2y2 == b2y1, "M6+: adjudicated product/code belief stays frozen across the update");
}

int main() {
    GraphTaskState s = buildState();
    PieGraphLayout layout = computeGraphLayout(s);
    check(!layout.nodeRects.empty(), "setup: layout produced");

    testRouting(s, layout);
    testDependency(s);
    testLive(s);
    testFramingFollowsLatest();

    std::printf("graph m456 test: %s\n", failures == 0 ? "PASS" : "FAIL");
    return failures == 0 ? 0 : 1;
}
