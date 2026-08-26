// PieGraphLayout.cpp: automatic graph layout via Graphviz (Phase 2 M3).
//
// Headless, ImGui-free, unit-testable. It maps a GraphTaskState to node
// positions (and frame container rectangles) by projecting the nodes/edges into
// a Graphviz (gvc/dot) directed graph, running the DOT automatic layout engine,
// and converting the resulting coordinates back into the PieGraphLayout
// nodeRects / frameRects contract. The GraphView consumer is unchanged: it still
// reads nodeRects/frameRects keyed by NodeId / frame id.
//
// Determinism: an identical GraphTaskState yields an identical layout because
// the DOT engine is deterministic for the same input graph and version.

#include "graph/PieGraphLayout.h"

#include <algorithm>
#include <cstdlib>
#include <cstring>

#include <gvc.h>

#include "graph/GraphStyle.h"

namespace pie::gui {

namespace {
// Sizes come from the centralized GraphStyle (M9) so the layout geometry is a
// single governable entry point, not a set of scattered literals.
constexpr const GraphStyle& st = kGraphStyle;

} // namespace

PieGraphLayout computeGraphLayout(const GraphTaskState& state) {
    PieGraphLayout out;

    // Build a Graphviz directed graph from the task state.
    GVC_t* gvc = gvContext();
    if (!gvc) return out;
    Agraph_t* g = agopen(const_cast<char*>("pie"), Agdirected, nullptr);
    if (!g) { gvFreeContext(gvc); return out; }

    // Create graph nodes for every semantic node, keyed by NodeId value.
    // We set an explicit size so the DOT engine keeps our node dimensions.
    char wbuf[32], hbuf[32];
    std::snprintf(wbuf, sizeof(wbuf), "%f", st.nodeW / st.pointsPerInch);
    std::snprintf(hbuf, sizeof(hbuf), "%f", st.nodeH / st.pointsPerInch);
    Agnode_t graphNodeOf[1]; // unused, placeholder to avoid unused warning
    (void)graphNodeOf;
    std::vector<Agnode_t*> nodeHandles;
    for (const GraphNode& n : state.nodes) {
        Agnode_t* an = agnode(g, const_cast<char*>(n.id.value.c_str()), 1);
        if (!an) continue;
        agset(an, const_cast<char*>("width"), wbuf);
        agset(an, const_cast<char*>("height"), hbuf);
        agset(an, const_cast<char*>("shape"), const_cast<char*>("box"));
        nodeHandles.push_back(an);
    }
    // Add explicit, directed edges only between nodes that exist in the graph.
    for (const GraphEdge& e : state.edges) {
        Agnode_t* s = agnode(g, const_cast<char*>(e.source.value.c_str()), 0);
        Agnode_t* t = agnode(g, const_cast<char*>(e.target.value.c_str()), 0);
        if (s && t) agedge(g, s, t, nullptr, 1);
    }

    // Run the DOT automatic layout.
    if (gvLayout(gvc, g, const_cast<char*>("dot")) != 0) {
        agclose(g);
        gvFreeContext(gvc);
        return out;
    }

    // Recover the graph bounding box ("xmin,ymin,xmax,ymax") to translate/flip
    // coordinates from Graphviz's bottom-left origin to our top-left y-down.
    const char* bb = agget((Agraph_t*)g, const_cast<char*>("bb"));
    float xmin = 0.0f, ymin = 0.0f, xmax = 0.0f, ymax = 0.0f;
    // Graphviz "bb" is space-separated: "xmin ymin xmax ymax".
    if (bb) std::sscanf(bb, "%f %f %f %f", &xmin, &ymin, &xmax, &ymax);
    float canvasW = (xmax > xmin) ? (xmax - xmin) : 0.0f;
    float canvasH = (ymax > ymin) ? (ymax - ymin) : 0.0f;

    // Map each graph node's center position back into a nodeRect.
    for (const GraphNode& n : state.nodes) {
        Agnode_t* an = agnode(g, const_cast<char*>(n.id.value.c_str()), 0);
        if (!an) continue;
        // Graphviz v15 exposes post-layout geometry through the ND_* macros
        // (accessing Agnodeinfo_t via AGDATA), NOT via agget(node,"pos").
        // ND_coord is the node center in points; ND_width/ND_height are in inches.
        pointf c = ND_coord(an);
        float cx = c.x, cy = c.y;
        float wpt = (float)(ND_width(an) * st.pointsPerInch);
        float hpt = (float)(ND_height(an) * st.pointsPerInch);
        // Graphviz center (cx,cy); top-left in graphviz coords is (cx-w/2, cy+h/2).
        // Convert to our top-left y-down canvas.
        GraphRect r;
        r.x = (cx - wpt * 0.5f) - xmin;
        r.y = ymax - (cy + hpt * 0.5f);
        r.w = wpt;
        r.h = hpt;
        out.nodeRects[n.id.value] = r;
    }

    out.canvasWidth = canvasW;
    out.canvasHeight = canvasH;

    // Frame container rects: bounding box of each frame's constituent nodes,
    // plus horizontal gutters so frames read left->right.
    float maxRight = 0.0f;
    std::map<int, float> frameMinX, frameMaxX, frameMinY, frameMaxY;
    for (const GraphNode& n : state.nodes) {
        if (!n.frameId) continue;
        auto it = out.nodeRects.find(n.id.value);
        if (it == out.nodeRects.end()) continue;
        const GraphRect& r = it->second;
        int fid = *n.frameId;
        bool first = frameMinX.find(fid) == frameMinX.end();
        if (first) { frameMinX[fid] = r.x; frameMaxX[fid] = r.x + r.w; frameMinY[fid] = r.y; frameMaxY[fid] = r.y + r.h; }
        else {
            frameMinX[fid] = std::min(frameMinX[fid], r.x);
            frameMaxX[fid] = std::max(frameMaxX[fid], r.x + r.w);
            frameMinY[fid] = std::min(frameMinY[fid], r.y);
            frameMaxY[fid] = std::max(frameMaxY[fid], r.y + r.h);
        }
    }
    for (const LoopFrameInfo& fi : state.frames) {
        auto mx = frameMaxX.find(fi.id);
        if (mx == frameMaxX.end()) continue;
        float pad = st.framePad;
        GraphRect r;
        r.x = frameMinX[fi.id] - pad;
        r.y = frameMinY[fi.id] - pad;
        r.w = (frameMaxX[fi.id] - frameMinX[fi.id]) + pad * 2.0f;
        r.h = (frameMaxY[fi.id] - frameMinY[fi.id]) + pad * 2.0f;
        maxRight = std::max(maxRight, r.x + r.w + st.frameGap);
        out.frameRects[fi.id] = r;
    }
    if (maxRight > out.canvasWidth) out.canvasWidth = maxRight;

    gvFreeLayout(gvc, g);
    agclose(g);
    gvFreeContext(gvc);

    return out;
}

} // namespace pie::gui
