// GraphLive: Phase 2 M6 live-layout stability.
//
// Headless, ImGui-free, unit-testable. In live mode the runtime streams
// node/edge additions and belief updates across the task, and the model
// recomputes a fresh auto-layout each frame. An unthrottled relayout would make
// the whole graph jump every event. This module keeps the view stable under
// updates by freezing the positions of nodes the runtime has already settled
// (global Belief nodes and nodes belonging to CLOSED frames) while letting the
// active/open frames take fresh positions (active relayout). Belief nodes are
// stable by construction (created once, positioned once, never re-laid-out);
// closed-frame nodes are frozen after their frame closes. The GUI never infers
// cognition: whether a frame is closed comes from the runtime's FrameStage /
// closed flag, which the projection carries into GraphTaskState.

#pragma once

#include <map>
#include <string>

#include "graph/GraphModel.h"
#include "graph/PieGraphLayout.h"

namespace pie::gui {

// Persistent per-session live-layout state. Holds the previously emitted layout
// so closed/belief node rects can be re-used (frozen) across relayouts.
struct GraphLiveState {
    bool havePrev = false;
    PieGraphLayout prevLayout;
};

// Produce a stable layout for `state` given a `fresh` auto-layout (computed by
// the caller from the same state) and the previous round's layout. Freezes
// stable nodes (beliefs + closed-frame nodes) at their previous rects; active /
// open-frame nodes take fresh positions. Stores `result` back in `live` for the
// next round. Deterministic given (state, fresh, live.prevLayout).
PieGraphLayout stabilizeLiveLayout(const GraphTaskState& state,
                                   const PieGraphLayout& fresh,
                                   GraphLiveState& live);

} // namespace pie::gui
