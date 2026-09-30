// GraphNavigation.cpp: Focus Current navigation geometry (headless).
// The minimap overlay was removed (replaced by the Stage indicator); only the
// Focus Current pan survives.

#include "graph/GraphNavigation.h"

namespace pie::gui {

PanResult computeFocusPan(const PieGraphLayout& layout, const std::string& nodeId,
                          float viewW, float viewH, float zoom) {
    PanResult p;
    const Dot* dot = layout.dot(nodeId);
    if (dot == nullptr) return p;
    // The block's centre IS the node's centre and, for a rectangle, its midpoint:
    // a block of any width is still centred on (x, y).
    float cx = dot->x;
    float cy = dot->y;
    // Center the node at the viewport centre: pan = viewportCentre - node*zoom.
    p.x = viewW * 0.5f - cx * zoom;
    p.y = viewH * 0.5f - cy * zoom;
    return p;
}

} // namespace pie::gui
