// PieGraphLayout: the graph layout engine (Phase 2 M3).
//
// Headless, ImGui-free, unit-testable. It projects the PIE cognition ontology
// (nodes/edges) into a Graphviz directed graph and runs the DOT automatic
// layout engine to position nodes (and derive frame container rectangles). It
// does not infer cognition: node/edge semantic types are runtime-supplied, only
// positions come from the engine.
//
// Determinism: identical input yields identical output for the same Graphviz
// version. Positions are keyed by NodeId so a viewer can place them without
// re-deriving cognition.

#pragma once

#include <map>
#include <string>
#include <vector>

#include "graph/GraphModel.h"

namespace pie::gui {

// A plain axis-aligned rectangle in layout coordinates. Kept ImGui-free so the
// layout engine is testable without a window; the UI layer converts to ImVec2.
struct GraphRect {
    float x = 0.0f;
    float y = 0.0f;
    float w = 0.0f;
    float h = 0.0f;
};

// The layout output: every node's rectangle, every frame container rectangle,
// and the total canvas size.
struct PieGraphLayout {
    std::map<std::string, GraphRect> nodeRects;   // keyed by NodeId value
    std::map<int, GraphRect> frameRects;          // keyed by frame id
    std::map<int, GraphRect> beliefRegionRects;   // keyed by Belief NodeId value string (reuse node key)
    float canvasWidth = 0.0f;
    float canvasHeight = 0.0f;
};

// Compute the layout for a projected task graph using Graphviz DOT auto-layout.
// Node geometry is read via the C API macros ND_coord / ND_width / ND_height
// (Agnodeinfo_t through AGDATA), sizes scaled by 72 points/inch, and converted
// from Graphviz's bottom-left origin to the viewer's top-left y-down space.
// General contract: every node rect has positive size, node rects do not
// overlap, frames have a container, and the canvas size is positive. The
// per-region directional ordering (Belief left-of-Plan, Distill return-leftward)
// is NOT guaranteed by the DOT engine and is not asserted.
PieGraphLayout computeGraphLayout(const GraphTaskState& state);

} // namespace pie::gui
