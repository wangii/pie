// GraphNavigation.cpp: Phase 2 M7 Focus Current navigation implementation (headless).
// The M7 minimap overlay was removed (replaced by the Stage indicator); only the
// Focus Current pan geometry survives.

#include "graph/GraphNavigation.h"

namespace pie::gui {

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
