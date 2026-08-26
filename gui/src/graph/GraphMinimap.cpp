// GraphMinimap.cpp: Phase 2 M7 navigation geometry implementation (headless).

#include "graph/GraphMinimap.h"

#include <algorithm>

namespace pie::gui {

GraphMinimapLayout computeGraphMinimap(const GraphTaskState& state,
                                       const PieGraphLayout& layout,
                                       float maxW, float maxH) {
    GraphMinimapLayout m;
    m.worldW = layout.canvasWidth;
    m.worldH = layout.canvasHeight;

    if (layout.nodeRects.empty()) return m;
    if (m.worldW <= 0.0f || m.worldH <= 0.0f) return m;

    m.scale = std::min(maxW / m.worldW, maxH / m.worldH);
    m.width = m.worldW * m.scale;
    m.height = m.worldH * m.scale;

    for (const auto& [id, r] : layout.nodeRects) {
        MiniRect mr;
        mr.x = r.x * m.scale;
        mr.y = r.y * m.scale;
        mr.w = r.w * m.scale;
        mr.h = r.h * m.scale;
        m.nodeRects[id] = mr;
    }
    for (const auto& [fid, r] : layout.frameRects) {
        MiniRect mr;
        mr.x = r.x * m.scale;
        mr.y = r.y * m.scale;
        mr.w = r.w * m.scale;
        mr.h = r.h * m.scale;
        m.frameRects[fid] = mr;
    }
    (void)state;
    return m;
}

GraphViewport computeViewport(float panX, float panY, float zoom, float viewW, float viewH) {
    GraphViewport v;
    if (zoom <= 0.0f) return v;
    v.x = -panX / zoom;
    v.y = -panY / zoom;
    v.w = viewW / zoom;
    v.h = viewH / zoom;
    return v;
}

PanResult computeFocusPan(const PieGraphLayout& layout, const std::string& nodeId,
                          float viewW, float viewH, float zoom) {
    PanResult p;
    auto it = layout.nodeRects.find(nodeId);
    if (it == layout.nodeRects.end()) return p;
    const GraphRect& r = it->second;
    float cx = r.x + r.w * 0.5f;
    float cy = r.y + r.h * 0.5f;
    // Center the node at the viewport center: pan = viewportCenter - node*zoom.
    p.x = viewW * 0.5f - cx * zoom;
    p.y = viewH * 0.5f - cy * zoom;
    return p;
}

} // namespace pie::gui
