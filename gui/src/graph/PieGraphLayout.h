// PieGraphLayout: the graph layout engine (Phase 2 M3).
//
// Headless, ImGui-free, unit-testable. It projects the PIE cognition ontology
// (nodes/edges) into a deterministic custom layout: LoopFrames are stacked as
// vertical rows, Beliefs occupy a fixed left column ordered by creation order,
// Plan / Propose / Distillation occupy the middle regions (Propose at the top,
// Plan in the middle, Distillation at the bottom, i.e. the loop's time sequence)
// and Execution occupies the right column ordered by execution order.
// It does not infer
// cognition: node/edge semantic types and creation/execution orders are
// runtime-supplied, only positions come from the engine.
//
// Determinism: identical input yields identical output. Positions are keyed by
// NodeId so a viewer can place them without re-deriving cognition.

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
    std::map<std::string, GraphRect> frameRects;          // keyed by frame id
    std::map<std::string, GraphRect> beliefRegionRects;   // newly-created Beliefs, keyed by frame id
    std::map<std::string, GraphRect> planRegionRects;     // upper middle band, keyed by frame id
    std::map<std::string, GraphRect> proposeRegionRects;  // middle band, keyed by frame id
    std::map<std::string, GraphRect> distillRegionRects;  // lower middle band, keyed by frame id
    std::map<std::string, GraphRect> executionRegionRects;// right column, keyed by frame id
    GraphRect beliefColumnRect;                   // global left column
    float canvasWidth = 0.0f;
    float canvasHeight = 0.0f;
};

// Compute a deterministic custom layout for a projected task graph, replacing
// the Graphviz DOT auto-layout. LoopFrames are stacked as vertical rows; Belief
// nodes form a fixed left column ordered by creation order (and grouped by the
// round that created them); Plan / Execution / Distillation form the middle /
// right regions per frame. Region adjacency and row / node spacing derive from
// GraphStyle. General contract: every node rect has positive size, node rects
// do not overlap, frames have a container, and the canvas size is positive. The
// per-region directional ordering (Belief left-of-Plan, Distill return-leftward)
// is now guaranteed by construction.
PieGraphLayout computeGraphLayout(const GraphTaskState& state);

} // namespace pie::gui
