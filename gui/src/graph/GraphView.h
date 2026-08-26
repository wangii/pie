// GraphView: the P0 Node Graph View canvas (Phase 2 M0 + M2).
//
// A read-only, custom ImGui node canvas that renders a GraphTaskState. It is a
// deliberate replacement for a vendored imgui-node-editor: that dependency does
// not compile against the pinned ImGui 1.92.9 (operator redefinition,
// ImRect::Floor / ImGui::GetKeyIndex removals). It provides only the P0
// read-only affordances — pan, zoom, select, tooltip, current/selected
// highlight — and never mutates cognition (no drag, no link create/delete, no
// belief edit, no frame move).
//
// The canvas keeps the headless/UI split: it consumes a GraphTaskState produced
// by the headless graph_model + PieGraphLayout and only renders positions. It
// does not infer FrameStage, cursor, or epistemic meaning.

#pragma once

#include <optional>
#include <string>

#include "graph/GraphModel.h"
#include "graph/PieGraphLayout.h"
#include "graph/GraphCache.h"

namespace pie::gui {

// Persistent view state for a Graph View session (pan/zoom + selection). Kept
// across Text<->Graph toggles within a session but not persisted to disk.
struct GraphViewState {
    float panX = 0.0f;
    float panY = 0.0f;
    float zoom = 1.0f;
    std::string selectedNode;  // empty = none selected
    std::optional<std::string> focusCurrentOnce;  // one-shot explicit Focus Current

    // M8: caches + cache-hit counters for the per-frame hot path (layout,
    // dependency set, routes, long routes). Invalidate automatically by input
    // version (GraphCache fingerprints), reused while the input is unchanged.
    GraphCache cache;
    GraphCacheMetrics cacheMetrics;

    // M7: minimap overlay visibility and the first-entry focus latch (the first
    // time a current node appears it is centered once; thereafter only explicit
    // F / focusCurrentOnce re-centers).
    bool minimapVisible = true;
    bool hasFocusedOnce = false;
};

// Render the graph into the current ImGui window. `layout` positions come from
// PieGraphLayout; `state` supplies node content and the current node. Returns
// true when a node selection changed this frame (the caller may want to run a
// dependency-path query / re-emphasize).
bool renderGraphView(GraphViewState& view, const GraphTaskState& state, const PieGraphLayout& layout);

} // namespace pie::gui
