// GraphMinimap: Phase 2 M7 navigation geometry (headless, ImGui-free).
//
// The view-layer minimap overlay (drawn in GraphView.cpp) needs two headless,
// unit-testable pieces of geometry: (1) a projection of the graph + layout into
// a scaled minimap box, and (2) the pan/zoom math for Focus Current and the
// viewport rectangle shown on the minimap. Keeping these functions here (in the
// model layer) means the M7 navigation math is verifiable without a window. The
// GUI never infers cognition: this module only maps geometry, never semantics.

#pragma once

#include <map>
#include <string>

#include "graph/GraphModel.h"
#include "graph/PieGraphLayout.h"

namespace pie::gui {

// A rectangle in minimap (scaled) coordinates.
struct MiniRect {
    float x = 0.0f;
    float y = 0.0f;
    float w = 0.0f;
    float h = 0.0f;
};

// The minimap projection of a laid-out graph, scaled to fit within a target
// box while preserving the layout's aspect ratio.
struct GraphMinimapLayout {
    float width = 0.0f;      // minimap canvas size (in minimap px)
    float height = 0.0f;
    std::map<std::string, MiniRect> nodeRects;  // node id -> minimap rect
    std::map<int, MiniRect> frameRects;         // frame id -> minimap rect
    float worldW = 0.0f;     // original graph canvas size
    float worldH = 0.0f;
    float scale = 1.0f;      // minimap px per graph px
};

// Project `layout` into a minimap that fits within maxW x maxH. Preserves the
// layout aspect ratio; every laid-out node and (if present) frame gets a rect.
GraphMinimapLayout computeGraphMinimap(const GraphTaskState& state,
                                       const PieGraphLayout& layout,
                                       float maxW, float maxH);

// The graph-coordinates rectangle currently visible on screen, given the view
// pan/zoom and the on-screen viewport size (viewW x viewH). The viewer draws
// this as the minimap viewport rectangle. Equal to: x = -panX/zoom,
// y = -panY/zoom, w = viewW/zoom, h = viewH/zoom.
struct GraphViewport {
    float x = 0.0f;
    float y = 0.0f;
    float w = 0.0f;
    float h = 0.0f;
};
GraphViewport computeViewport(float panX, float panY, float zoom, float viewW, float viewH);

// The pan that centers `nodeId` in a viewW x viewH viewport at the given zoom.
// Independent of the current pan, so it can be used for first-entry and explicit
// Focus Current. Returns {0,0} if the node has no rect.
struct PanResult {
    float x = 0.0f;
    float y = 0.0f;
};
PanResult computeFocusPan(const PieGraphLayout& layout, const std::string& nodeId,
                          float viewW, float viewH, float zoom);

} // namespace pie::gui
