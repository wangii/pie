// Headless tests for Phase 2 M7 (Focus Current pan navigation), M8 (cache reuse
// + precise invalidation / 500-node x 50-frame), and M9 (centralized graph_style
// structure). No window, no ImGui, no SDK.
// Run: ./pi_gui_graph_m789_test  (non-zero on failure).

#include "graph/GraphNavigation.h"
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
    auto node = [&](const std::string& id, NodeFamily f, const std::string& frame) {
        GraphNode n; n.id.value = id; n.family = f;
        if (!frame.empty()) n.frameId = frame;
        n.title = id; n.compactText = id; n.fullText = id;
        s.nodes.push_back(n);
    };
    auto edge = [&](const std::string& src, const std::string& dst, EdgeSemanticType t, std::optional<BeliefOperation> op = std::nullopt) {
        GraphEdge e; e.source.value = src; e.target.value = dst; e.type = t; e.beliefOperation = op;
        s.edges.push_back(e);
    };
    node("B1", NodeFamily::Belief, "");
    node("B2", NodeFamily::Belief, "");
    node("P10", NodeFamily::Plan, "10");
    node("E10a", NodeFamily::Execution, "10");
    node("D10", NodeFamily::Distill, "10");
    node("P20", NodeFamily::Plan, "20");
    node("E20", NodeFamily::Execution, "20");
    node("D20", NodeFamily::Distill, "20");
    edge("B1", "P10", EdgeSemanticType::BeliefToPlan);
    edge("P10", "E10a", EdgeSemanticType::PlanToExecution);
    edge("E10a", "D10", EdgeSemanticType::ExecutionToDistill);
    edge("D10", "B1", EdgeSemanticType::DistillToBelief, BeliefOperation::Update);
    edge("B2", "P20", EdgeSemanticType::BeliefToPlan);
    edge("P20", "E20", EdgeSemanticType::PlanToExecution);
    edge("E20", "D20", EdgeSemanticType::ExecutionToDistill);
    edge("D20", "B1", EdgeSemanticType::DistillToBelief, BeliefOperation::Create);
    LoopFrameInfo f10; f10.id = "10"; f10.label = "LoopFrame #10"; f10.closed = true;
    LoopFrameInfo f20; f20.id = "20"; f20.label = "LoopFrame #20"; f20.closed = false;
    s.frames.push_back(f10); s.frames.push_back(f20);
    return s;
}

// A big task: `frames` frames x `nodesPerFrame` nodes (chain edges per frame),
// ~= the 500-node target when frames=50, nodesPerFrame=10.
static GraphTaskState buildBigState(int frames, int nodesPerFrame) {
    GraphTaskState s;
    int idc = 0;
    for (int f = 1; f <= frames; ++f) {
        LoopFrameInfo fi; fi.id = std::to_string(f); fi.label = "LoopFrame #" + std::to_string(f);
        fi.closed = (f < frames);
        s.frames.push_back(fi);
        std::vector<std::string> ids;
        for (int j = 0; j < nodesPerFrame; ++j) {
            GraphNode n;
            n.id.value = "N" + std::to_string(idc++);
            n.frameId = std::to_string(f);
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
        if (n.frameId == "1") {
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
    // Routing / framing domain colors are distinct from the plain belief card and
    // from each other, so the belief element itself carries the domain role.
    bool rfDistinct = (g.cardBeliefRouting.r != g.cardBelief.r ||
                       g.cardBeliefRouting.g != g.cardBelief.g ||
                       g.cardBeliefRouting.b != g.cardBelief.b) &&
                      (g.cardBeliefFraming.r != g.cardBelief.r ||
                       g.cardBeliefFraming.g != g.cardBelief.g ||
                       g.cardBeliefFraming.b != g.cardBelief.b) &&
                      (g.cardBeliefRouting.r != g.cardBeliefFraming.r ||
                       g.cardBeliefRouting.g != g.cardBeliefFraming.g ||
                       g.cardBeliefRouting.b != g.cardBeliefFraming.b);
    check(rfDistinct, "M9: routing/framing domain colors are distinct from plain belief");
    (void)g;
}

// --- Routing / Framing card placement (PieGraphLayout domain reparenting) ---
static void testRoutingFramingPlacement() {
    GraphTaskState s = buildSmallState();  // frames 10, 20; beliefs B1, B2 (no domain)
    for (GraphNode& n : s.nodes) {
        if (n.id.value == "B1") { n.domain = "routing"; n.createdInFrame = "10"; }
        else if (n.id.value == "B2") { n.domain = "framing"; n.createdInFrame = "10"; }
    }
    PieGraphLayout layout = computeGraphLayout(s);
    auto fr10 = layout.frameRects.find("10");
    auto fr20 = layout.frameRects.find("20");
    auto r1 = layout.nodeRects.find("B1");
    auto r2 = layout.nodeRects.find("B2");
    check(fr10 != layout.frameRects.end() && fr20 != layout.frameRects.end(),
          "RF: frames 10/20 have containers");
    if (fr10 != layout.frameRects.end() && fr20 != layout.frameRects.end() &&
        r1 != layout.nodeRects.end() && r2 != layout.nodeRects.end()) {
        const GraphRect& f10 = fr10->second;
        const GraphRect& f20 = fr20->second;
        const GraphRect& rb = r1->second;
        const GraphRect& rf = r2->second;
        // Routing cards anchor directly ABOVE their owning frame box, centered.
        check(rb.y + rb.h <= f10.y + 1e-3f,
              "RF: routing card sits above its frame (frame 10)");
        check(std::fabs((rb.x + rb.w * 0.5f) - (f10.x + f10.w * 0.5f)) <= 1e-3f,
              "RF: routing card is horizontally centered on its frame");
        // Framing (target) cards anchor directly BELOW the LATEST episode box,
        // centered on it.
        check(rf.y >= f20.y + f20.h - 1e-3f,
              "RF: framing card is below the latest episode (frame 20)");
        check(std::fabs((rf.x + rf.w * 0.5f) - (f20.x + f20.w * 0.5f)) <= 1e-3f,
              "RF: framing card is horizontally centered on the latest episode");
    } else {
        check(false, "RF: routing/framing cards were placed");
    }

    // No two node rects overlap after domain reparenting.
    bool noOverlap = true;
    for (const auto& [k, r] : layout.nodeRects) {
        for (const auto& [k2, r2] : layout.nodeRects) {
            if (k == k2) continue;
            if (r.x < r2.x + r2.w && r2.x < r.x + r.w &&
                r.y < r2.y + r2.h && r2.y < r.y + r.h) noOverlap = false;
        }
    }
    check(noOverlap, "RF: no node overlap after routing/framing placement");

    // A plain belief (no domain) still lays out in the global belief column.
    GraphTaskState s2 = buildSmallState();
    PieGraphLayout l2 = computeGraphLayout(s2);
    check(l2.nodeRects.count("B1") == 1, "RF: plain belief remains laid out");
}

// --- Framing/target anchor: always below the LAST (latest) episode ---
// Fix 4: the framing (target) beliefs are anchored below the latest episode/
// loop-frame, so their y position must sit below the last frame's bottom edge,
// independent of which frame is "current".
static void testCurrentFrameSelection() {
    auto make = [](bool f10closed, bool f20closed, bool f20exec) {
        GraphTaskState s = buildSmallState();
        for (GraphNode& n : s.nodes) {
            if (n.id.value == "B1") {
                n.domain = "routing";
            } else if (n.id.value == "B2") {
                n.domain = "framing";
                n.createdInFrame = "10";
            }
        }
        s.frames[0].closed = f10closed;
        s.frames[1].closed = f20closed;
        s.frames[1].executing = f20exec;
        return s;
    };
    auto bottom = [](const GraphRect& r) { return r.y + r.h; };

    // Every current-frame path must place the framing card below the LAST frame.
    for (int path = 0; path < 3; ++path) {
        bool f10closed, f20closed, f20exec;
        switch (path) {
            case 0: f10closed = true;  f20closed = false; f20exec = true;  break;  // executing
            case 1: f10closed = true;  f20closed = false; f20exec = false; break;  // last non-closed
            default: f10closed = true; f20closed = true;  f20exec = false; break;  // all closed -> last frame
        }
        PieGraphLayout layout = computeGraphLayout(make(f10closed, f20closed, f20exec));
        auto f20 = layout.frameRects.find("20");
        auto rf = layout.nodeRects.find("B2");
        check(f20 != layout.frameRects.end() && rf != layout.nodeRects.end(),
              "CUR: path places the framing card");
        if (f20 != layout.frameRects.end() && rf != layout.nodeRects.end())
            check(rf->second.y >= bottom(f20->second) - 1e-3f,
                  "CUR: framing card is below the last (latest) episode");
        if (f20 != layout.frameRects.end() && rf != layout.nodeRects.end())
            check(std::fabs((rf->second.x + rf->second.w * 0.5f) -
                            (f20->second.x + f20->second.w * 0.5f)) <= 1e-3f,
                  "CUR: framing card is horizontally centered on the latest episode");
    }
}

// --- M7: Focus Current pan (the surviving navigation geometry; the minimap
// overlay was removed and replaced by the Stage indicator) ---
static void testFocusNavigation() {
    GraphTaskState s = buildSmallState();
    PieGraphLayout layout = computeGraphLayout(s);
    check(!layout.nodeRects.empty(), "M7: layout produced");

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

// --- Framing/target anchor with a real successor: the framing stack hugs the
// LAST (latest) episode's bottom border, not the current frame's successor. ---
// Fix 4: the framing (target) cards always anchor below the last episode, so with
// three frames the stack sits below frame 30, not below frame 20's successor.
static void testFramingNextLoopframe() {
    GraphTaskState s;
    auto node = [&](const std::string& id, NodeFamily f, const std::string& frame) {
        GraphNode n; n.id.value = id; n.family = f;
        if (!frame.empty()) n.frameId = frame;
        n.title = id; n.compactText = id; n.fullText = id;
        s.nodes.push_back(n);
    };
    auto edge = [&](const std::string& src, const std::string& dst, EdgeSemanticType t, std::optional<BeliefOperation> op = std::nullopt) {
        GraphEdge e; e.source.value = src; e.target.value = dst; e.type = t; e.beliefOperation = op;
        s.edges.push_back(e);
    };
    // Beliefs B1/B2/B3 plus one plan-distill cycle per frame 10/20/30.
    node("B1", NodeFamily::Belief, "");
    node("B2", NodeFamily::Belief, "");
    node("B3", NodeFamily::Belief, "");
    node("P10", NodeFamily::Plan, "10");
    node("D10", NodeFamily::Distill, "10");
    node("P20", NodeFamily::Plan, "20");
    node("D20", NodeFamily::Distill, "20");
    node("P30", NodeFamily::Plan, "30");
    node("D30", NodeFamily::Distill, "30");
    edge("B1", "P10", EdgeSemanticType::BeliefToPlan);
    edge("P10", "D10", EdgeSemanticType::PlanToExecution);
    edge("D10", "B1", EdgeSemanticType::DistillToBelief, BeliefOperation::Update);
    edge("B2", "P20", EdgeSemanticType::BeliefToPlan);
    edge("P20", "D20", EdgeSemanticType::PlanToExecution);
    edge("D20", "B1", EdgeSemanticType::DistillToBelief, BeliefOperation::Create);
    edge("B3", "P10", EdgeSemanticType::BeliefToPlan);
    edge("B1", "P30", EdgeSemanticType::BeliefToPlan);
    edge("P30", "D30", EdgeSemanticType::PlanToExecution);
    edge("D30", "B1", EdgeSemanticType::DistillToBelief, BeliefOperation::Update);

    LoopFrameInfo f10; f10.id = "10"; f10.label = "LoopFrame #10"; f10.closed = true;
    LoopFrameInfo f20; f20.id = "20"; f20.label = "LoopFrame #20"; f20.closed = false;
    LoopFrameInfo f30; f30.id = "30"; f30.label = "LoopFrame #30"; f30.closed = true;
    s.frames.push_back(f10); s.frames.push_back(f20); s.frames.push_back(f30);

    // B2 is the framing card, created in frame 10; B3 created in frame 20. With
    // Fix 1, the routing belief B1 sits inside the frame that created it.
    for (GraphNode& n : s.nodes) {
        if (n.id.value == "B1") n.domain = "routing";
        else if (n.id.value == "B2") { n.domain = "framing"; n.createdInFrame = "10"; }
        else if (n.id.value == "B3") { n.domain = "framing"; n.createdInFrame = "20"; }
    }

    PieGraphLayout layout = computeGraphLayout(s);
    auto fr10 = layout.frameRects.find("10");
    auto fr20 = layout.frameRects.find("20");
    auto fr30 = layout.frameRects.find("30");
    auto rb = layout.nodeRects.find("B1");
    auto rf = layout.nodeRects.find("B2");
    auto rf2 = layout.nodeRects.find("B3");
    check(fr10 != layout.frameRects.end() && fr20 != layout.frameRects.end() &&
          fr30 != layout.frameRects.end() && rb != layout.nodeRects.end() &&
          rf != layout.nodeRects.end() && rf2 != layout.nodeRects.end(),
          "NLF: three-frame layout plus routing/two framing cards produced");
    if (fr10 != layout.frameRects.end() && fr20 != layout.frameRects.end() &&
        fr30 != layout.frameRects.end() && rf != layout.nodeRects.end() &&
        rf2 != layout.nodeRects.end()) {
        const GraphRect& f10 = fr10->second;
        const GraphRect& f20 = fr20->second;
        const GraphRect& f30 = fr30->second;
        const GraphRect& rfrect = rf->second;
        const GraphRect& rf2rect = rf2->second;
        // Routing cards anchor directly ABOVE their inferred frame box, centered.
        check(rb != layout.nodeRects.end() && rb->second.y + rb->second.h <= f20.y + 1e-3f,
              "NLF: routing card is above its inferred frame");
        check(rb != layout.nodeRects.end() &&
              std::fabs((rb->second.x + rb->second.w * 0.5f) -
                        (f20.x + f20.w * 0.5f)) <= 1e-3f,
              "NLF: routing card is horizontally centered on its inferred frame");
        // Fix 4: the framing (target) cards anchor below the LAST episode (frame 30),
        // so the stack's TOP card sits at frame 30's bottom edge.
        check(rfrect.y >= f30.y + f30.h - 1e-3f,
              "NLF: framing card is not above the latest episode bottom");

        // Two framing cards must stack as a whole: one is the top-of-stack card,
        // the other below it (distinct y, creation order), neither overlapping.
        check(rf2rect.y != rfrect.y,
              "NLF: multiple framing cards occupy distinct stack slots");
        const float topOfStack = std::min(rf2rect.y, rfrect.y);
        const float bottomOfStack = std::max(rf2rect.y + rf2rect.h, rfrect.y + rfrect.h);
        // The whole stack hangs below the latest episode (frame 30) bottom: the
        // top-of-stack card starts at (or just after) frame 30's bottom edge.
        check(std::fabs(topOfStack - (f30.y + f30.h)) <= 1e-3f,
              "NLF: framing stack top aligns below the latest episode");
        // Each framing card is horizontally centered on the latest episode box.
        check(std::fabs((rfrect.x + rfrect.w * 0.5f) - (f30.x + f30.w * 0.5f)) <= 1e-3f,
              "NLF: framing cards are horizontally centered on the latest episode");
        check(rf2rect.y + rf2rect.h <= rfrect.y + 1e-3f ||
              rfrect.y + rfrect.h <= rf2rect.y + 1e-3f,
              "NLF: two framing cards do not overlap each other");
    }

    // The no-overlap invariant must still hold.
    bool noOverlap = true;
    for (const auto& [k, r] : layout.nodeRects) {
        for (const auto& [k2, r2] : layout.nodeRects) {
            if (k == k2) continue;
            if (r.x < r2.x + r2.w && r2.x < r.x + r.w &&
                r.y < r2.y + r2.h && r2.y < r.y + r.h) noOverlap = false;
        }
    }
    check(noOverlap, "NLF: no node overlap after next-loopframe framing placement");
}

// --- Routing decision text slot: a frame carrying a real RoutingDecided
// decision is pushed DOWN by routingTextSlotH so GraphView can draw its
// "Route: ..." label centered above the box without overlapping the row above. ---
static void testRoutingSlotReserved() {
    GraphTaskState withRoute = buildSmallState();  // frames 10, 20; no domain cards
    withRoute.frames[0].routingDecision = "belief-loop";
    withRoute.frames[0].routingReason = "needs beliefs";
    GraphTaskState withoutRoute = buildSmallState();
    PieGraphLayout la = computeGraphLayout(withRoute);
    PieGraphLayout lb = computeGraphLayout(withoutRoute);
    auto fa = la.frameRects.find("10");
    auto fb = lb.frameRects.find("10");
    check(fa != la.frameRects.end() && fb != lb.frameRects.end(),
          "RS: containers present");
    if (fa != la.frameRects.end() && fb != lb.frameRects.end()) {
        const float dy = fa->second.y - fb->second.y;
        check(std::fabs(dy - kGraphStyle.routingTextSlotH) <= 1e-3f,
              "RS: frame with a routing decision reserves a routing slot above its box");
    }
}

int main() {
    testStyle();
    testFocusNavigation();
    testCache();
    testRoutingFramingPlacement();
    testCurrentFrameSelection();
    testFramingNextLoopframe();
    testRoutingSlotReserved();

    std::printf("graph m789 test: %s\n", failures == 0 ? "PASS" : "FAIL");
    return failures == 0 ? 0 : 1;
}
