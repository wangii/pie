// Headless tests for Phase 2 M7 (minimap geometry / navigation), M8 (cache
// reuse + precise invalidation / 500-node x 50-frame), and M9 (centralized
// graph_style structure). No window, no ImGui, no SDK.
// Run: ./pi_gui_graph_m789_test  (non-zero on failure).

#include "graph/GraphMinimap.h"
#include "graph/GraphCache.h"
#include "graph/GraphStyle.h"

#include <cstdio>
#include <cmath>
#include <map>
#include <set>
#include <string>
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

// A small, deterministic task graph (mirrors the M456 fixture topology).
static GraphTaskState buildSmallState() {
    GraphTaskState s;
    auto node = [&](const std::string& id, NodeFamily f, int frame) {
        GraphNode n; n.id.value = id; n.family = f;
        if (frame >= 0) n.frameId = frame;
        n.title = id; n.compactText = id; n.fullText = id;
        s.nodes.push_back(n);
    };
    auto edge = [&](const std::string& src, const std::string& dst, EdgeSemanticType t, std::optional<BeliefOperation> op = std::nullopt) {
        GraphEdge e; e.source.value = src; e.target.value = dst; e.type = t; e.beliefOperation = op;
        s.edges.push_back(e);
    };
    node("B1", NodeFamily::Belief, -1);
    node("B2", NodeFamily::Belief, -1);
    node("P10", NodeFamily::Plan, 10);
    node("E10a", NodeFamily::Execution, 10);
    node("D10", NodeFamily::Distill, 10);
    node("P20", NodeFamily::Plan, 20);
    node("E20", NodeFamily::Execution, 20);
    node("D20", NodeFamily::Distill, 20);
    edge("B1", "P10", EdgeSemanticType::BeliefToPlan);
    edge("P10", "E10a", EdgeSemanticType::PlanToExecution);
    edge("E10a", "D10", EdgeSemanticType::ExecutionToDistill);
    edge("D10", "B1", EdgeSemanticType::DistillToBelief, BeliefOperation::Update);
    edge("B2", "P20", EdgeSemanticType::BeliefToPlan);
    edge("P20", "E20", EdgeSemanticType::PlanToExecution);
    edge("E20", "D20", EdgeSemanticType::ExecutionToDistill);
    edge("D20", "B1", EdgeSemanticType::DistillToBelief, BeliefOperation::Create);
    LoopFrameInfo f10; f10.id = 10; f10.label = "LoopFrame #10"; f10.closed = true;
    LoopFrameInfo f20; f20.id = 20; f20.label = "LoopFrame #20"; f20.closed = false;
    s.frames.push_back(f10); s.frames.push_back(f20);
    return s;
}

// A big task: `frames` frames x `nodesPerFrame` nodes (chain edges per frame),
// ~= the 500-node target when frames=50, nodesPerFrame=10.
static GraphTaskState buildBigState(int frames, int nodesPerFrame) {
    GraphTaskState s;
    int idc = 0;
    for (int f = 1; f <= frames; ++f) {
        LoopFrameInfo fi; fi.id = f; fi.label = "LoopFrame #" + std::to_string(f);
        fi.closed = (f < frames);
        s.frames.push_back(fi);
        std::vector<std::string> ids;
        for (int j = 0; j < nodesPerFrame; ++j) {
            GraphNode n;
            n.id.value = "N" + std::to_string(idc++);
            n.frameId = f;
            n.family = (j == 0) ? NodeFamily::Plan
                          : (j == nodesPerFrame - 1) ? NodeFamily::Distill
                          : NodeFamily::Execution;
            n.title = n.id.value; n.compactText = n.id.value; n.fullText = n.id.value;
            s.nodes.push_back(n);
            ids.push_back(n.id.value);
        }
        for (size_t k = 0; k + 1 < ids.size(); ++k) {
            GraphEdge e;
            e.source.value = ids[k]; e.target.value = ids[k + 1];
            e.type = EdgeSemanticType::PlanToExecution;
            s.edges.push_back(e);
        }
    }

    // Add global beliefs + cross-region semantic edges so the long-route cache
    // path is exercised. Frame 1's plan and distill are the first/last node ids
    // of frame 1.
    GraphNode b1; b1.id.value = "B1"; b1.family = NodeFamily::Belief;
    b1.title = "B1"; b1.compactText = "b"; b1.fullText = "b";
    GraphNode b2; b2.id.value = "B2"; b2.family = NodeFamily::Belief;
    b2.title = "B2"; b2.compactText = "b"; b2.fullText = "b";
    s.nodes.push_back(b1);
    s.nodes.push_back(b2);

    std::string frame1Plan, frame1Distill;
    for (const GraphNode& n : s.nodes) {
        if (n.frameId == 1) {
            if (frame1Plan.empty()) frame1Plan = n.id.value;
            frame1Distill = n.id.value;
        }
    }
    GraphEdge bp; bp.source.value = "B1"; bp.target.value = frame1Plan;
    bp.type = EdgeSemanticType::BeliefToPlan;
    GraphEdge db; db.source.value = frame1Distill; db.target.value = "B2";
    db.type = EdgeSemanticType::DistillToBelief;
    s.edges.push_back(bp);
    s.edges.push_back(db);
    return s;
}

// --- M9: centralized graph_style structure and default values ---
static void testStyle() {
    constexpr const GraphStyle& g = kGraphStyle;
    check(g.zoomMin > 0.0f && g.zoomMax > g.zoomMin, "M9: zoom range is ordered");
    check(g.zoomStep > 0.0f, "M9: zoom step positive");
    check(g.gridStep > 0.0f, "M9: grid step positive");
    check(g.dimMuted > 0.0f && g.dimMuted <= 1.0f, "M9: dimMuted is in (0,1]");
    check(g.edgeAlphaPath > 0.0f && g.edgeAlphaPath <= 1.0f, "M9: edgeAlphaPath in (0,1]");
    check(g.edgeAlphaLongDefault > 0.0f && g.edgeAlphaLongDefault <= 1.0f, "M9: edgeAlphaLongDefault in (0,1]");
    check(g.edgeAlphaOffPath < g.edgeAlphaPath, "M9: off-path edge dimmer than path");
    check(g.nodeW > 0.0f && g.nodeH > 0.0f, "M9: node size positive");
    check(g.pointsPerInch > 0.0f, "M9: points-per-inch positive");
    check(g.framePad > 0.0f && g.frameGap > 0.0f, "M9: frame padding/gap positive");
    check(g.peripheryGap > 0.0f, "M9: periphery gap positive");
    check(g.arrowheadSize > 0.0f && g.arrowheadHalf > 0.0f, "M9: arrowhead positive");
    check(g.opGlyphRadius > 0.0f, "M9: operation glyph radius positive");
    // RGB triples are typed uint8_t by construction; assert a few known defaults.
    check(g.cardBelief.r == 58 && g.cardBelief.g == 88 && g.cardBelief.b == 96, "M9: belief card color default matches");
    check(g.edgeDistillToBelief.r == 220 && g.edgeDistillToBelief.g == 140 && g.edgeDistillToBelief.b == 220, "M9: distill edge color default matches");
    (void)g;
}

// --- M7: minimap geometry, viewport mapping, Focus Current pan ---
static void testMinimap() {
    GraphTaskState s = buildSmallState();
    PieGraphLayout layout = computeGraphLayout(s);
    check(!layout.nodeRects.empty(), "M7: layout produced");

    // Minimap projection fits the box and preserves aspect ratio.
    const float maxW = 200.0f, maxH = 140.0f;
    GraphMinimapLayout mini = computeGraphMinimap(s, layout, maxW, maxH);
    check(mini.width > 0.0f && mini.height > 0.0f, "M7: minimap has positive size");
    check(mini.width <= maxW + 1e-3f && mini.height <= maxH + 1e-3f, "M7: minimap fits its target box");
    float arWorld = layout.canvasWidth / layout.canvasHeight;
    float arMini = mini.width / mini.height;
    check(std::fabs(arWorld - arMini) < 1e-2f, "M7: minimap preserves aspect ratio");
    check(mini.nodeRects.size() == layout.nodeRects.size(), "M7: every laid-out node has a minimap rect");
    bool allIn = true;
    for (const auto& [id, mr] : mini.nodeRects) {
        (void)id;
        if (mr.x < -1e-3f || mr.y < -1e-3f || mr.x + mr.w > mini.width + 1e-3f || mr.y + mr.h > mini.height + 1e-3f) allIn = false;
    }
    check(allIn, "M7: all node minimap rects lie inside the minimap box");

    // Viewport mapping: pan/zoom -> graph-coords visible rectangle.
    GraphViewport vp = computeViewport(100.0f, -20.0f, 1.25f, 800.0f, 600.0f);
    check(std::fabs(vp.x + 100.0f / 1.25f) < 1e-3f, "M7: viewport x = -panX/zoom");
    check(std::fabs(vp.y - 20.0f / 1.25f) < 1e-3f, "M7: viewport y = -panY/zoom");
    check(std::fabs(vp.w - 800.0f / 1.25f) < 1e-3f, "M7: viewport w = viewW/zoom");
    check(std::fabs(vp.h - 600.0f / 1.25f) < 1e-3f, "M7: viewport h = viewH/zoom");

    // Focus Current pan centers the node in the viewport.
    const std::string nodeId = "P20";
    const float viewW = 800.0f, viewH = 600.0f, zoom = 1.0f;
    PanResult pan = computeFocusPan(layout, nodeId, viewW, viewH, zoom);
    auto it = layout.nodeRects.find(nodeId);
    const GraphRect& r = it->second;
    float cx = r.x + r.w * 0.5f, cy = r.y + r.h * 0.5f;
    // With zoom=1 the pan must place the node center at the viewport center:
    // pan = viewportCenter - nodeCenter.
    check(std::fabs(pan.x - (viewW * 0.5f - cx)) < 1e-3f, "M7: focus pan x centers node");
    check(std::fabs(pan.y - (viewH * 0.5f - cy)) < 1e-3f, "M7: focus pan y centers node");
    // Unknown node -> zero pan.
    PanResult missing = computeFocusPan(layout, "nope", viewW, viewH, zoom);
    check(missing.x == 0.0f && missing.y == 0.0f, "M7: unknown node yields zero pan");
}

// --- M8: cache reuse, precise invalidation, 500-node x 50-frame ---
static void testCache() {
    GraphTaskState big = buildBigState(50, 10);  // 50 frames x 10 nodes + beliefs
    check(big.nodes.size() >= 500, "M8: 500-node fixture built");
    check(big.frames.size() == 50, "M8: 50-frame fixture built");

    GraphCache cache;
    GraphCacheMetrics m;
    const std::string sel = "N0";

    // First access computes each cache once.
    const PieGraphLayout& l1 = cache.getLayout(big, m);
    const std::set<std::string>& dep1 = cache.getDependencySet(big, sel, m);
    const std::vector<EdgeRoute>& r1 = cache.getRoutes(big, l1, m);
    const std::vector<EdgeRoute>& lr1 = cache.getLongRoutes(big, l1, m);
    check(m.layoutComputes == 1, "M8: layout computed once on first access");
    check(m.dependencyComputes == 1, "M8: dependency computed once on first access");
    check(m.routeComputes == 1, "M8: routes computed once on first access");
    check(!lr1.empty(), "M8: long routes present");
    check(dep1.count(sel), "M8: dependency set includes selected node");

    // 49 more "frames" with an unchanged state: every cache must be reused.
    for (int i = 0; i < 49; ++i) {
        const PieGraphLayout& l = cache.getLayout(big, m);
        const std::set<std::string>& dep = cache.getDependencySet(big, sel, m);
        const std::vector<EdgeRoute>& r = cache.getRoutes(big, l, m);
        const std::vector<EdgeRoute>& lr = cache.getLongRoutes(big, l, m);
        (void)dep; (void)r; (void)lr;
    }
    check(m.layoutComputes == 1, "M8: layout reused across 50 unchanged frames");
    check(m.dependencyComputes == 1, "M8: dependency reused across 50 unchanged frames");
    check(m.routeComputes == 1, "M8: route cache reused across 50 unchanged frames");

    // Adjacency is reused across selection changes (state unchanged) but a new
    // selected node triggers a fresh dependency set compute.
    const std::string sel2 = "N250";
    const std::set<std::string>& depB = cache.getDependencySet(big, sel2, m);
    check(depB.count(sel2), "M8: second selection's dependency set computed");
    check(m.dependencyComputes == 2, "M8: dependency recomputed only for new selection");

    // A state change invalidates everything exactly once each.
    GraphTaskState big2 = big;
    GraphNode extra; extra.id.value = "EXTRA"; extra.family = NodeFamily::Belief;
    extra.title = "EXTRA"; extra.compactText = "x"; extra.fullText = "x";
    big2.nodes.push_back(extra);
    const PieGraphLayout& l2 = cache.getLayout(big2, m);
    const std::set<std::string>& dep2 = cache.getDependencySet(big2, sel, m);
    const std::vector<EdgeRoute>& r2 = cache.getRoutes(big2, l2, m);
    cache.getLongRoutes(big2, l2, m);
    (void)dep2; (void)r2;
    check(m.layoutComputes == 2, "M8: state change recomputes layout once");
    check(m.dependencyComputes == 3, "M8: state change recomputes dependency once");
    check(m.routeComputes == 2, "M8: state change recomputes routes once");

    // Dropping caches forces recompute on next access.
    cache.clear();
    cache.getLayout(big, m);
    check(m.layoutComputes == 3, "M8: clear() forces layout recompute");

    // Sanity: a small self-consistency check that dep for an empty selection is
    // an empty set (and does not grow the adjacency-cached state).
    GraphTaskState small = buildSmallState();
    const std::set<std::string>& none = cache.getDependencySet(small, "", m);
    check(none.empty(), "M8: empty selection yields empty dependency set");
}

int main() {
    testStyle();
    testMinimap();
    testCache();

    std::printf("graph m789 test: %s\n", failures == 0 ? "PASS" : "FAIL");
    return failures == 0 ? 0 : 1;
}
