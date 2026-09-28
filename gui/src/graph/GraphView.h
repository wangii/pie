// GraphView: the dot + link canvas (docs/milestones.md §6).
//
// The only ImGui-touching module in the graph layer; everything it draws comes
// from the projection (`GraphTaskState`) and the layout (`PieGraphLayout`), and
// every colour and size from `kGraphStyle`. The renderer decides nothing about
// meaning — that is the whole reason the projection is a separate headless unit.
//
// WHAT CHANGED FROM THE v1 VIEW, and why it is a rewrite rather than an edit:
//
//  * Cards became dots. A node is a circle with a radius, so hit testing and
//    tooltips are radial. There is no box to clip a label into, so the v1 inline
//    labels are gone: content moved into the tooltip, which is now the only place
//    a node's text is read.
//  * EVERY node family has a tooltip. The v1 view deliberately gave Plan and
//    Distill none, which meant their content was unreachable; §6.3/M5 removes that
//    carve-out.
//  * The regions and their headers are gone, replaced by two rails (frames above,
//    beliefs to the left) and one band per episode row.
//  * The current station is drawn as a pulsing halo — the redirect of the one
//    animation the user approved (§6.3).
//
// The view never mutates cognition: no drag-to-connect, no node creation, no
// belief editing. Selection is read-only, and the only state it keeps is where the
// user is looking.

#pragma once

#include <optional>
#include <string>

#include "graph/GraphCache.h"
#include "graph/GraphModel.h"
#include "graph/PieGraphLayout.h"

namespace pie::gui {

struct GraphViewState {
    float panX = 0.0f;
    float panY = 0.0f;
    float zoom = 1.0f;
    // The inspected node, by NodeId value. Empty means none.
    std::string selectedNode;
    // A one-shot request to centre the current station, consumed on the frame it
    // is honoured so a user pan afterwards is not fought.
    std::optional<std::string> focusCurrentOnce;
    bool hasFocusedOnce = false;
    GraphCache cache;
    GraphCacheMetrics cacheMetrics;
};

// Draw the canvas into the current ImGui child. Returns true when the selection
// changed this frame, so the caller can refresh anything derived from it.
bool renderGraphView(GraphViewState& view, const GraphTaskState& state, const PieGraphLayout& layout);

} // namespace pie::gui
