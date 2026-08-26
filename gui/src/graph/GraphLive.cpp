// GraphLive.cpp: Phase 2 M6 live-layout stability implementation.
//
// Stabilize a fresh auto-layout by freezing the settled nodes (global Beliefs
// and nodes of CLOSED frames) at their previous rects, and letting active /
// open-frame nodes take fresh positions. This keeps the graph from jumping on
// every streamed event while still relaying-out the currently active frame.

#include "graph/GraphLive.h"

#include <set>

namespace pie::gui {

namespace {
// A node is "settled" (position-stable) if it is a global Belief (no owning
// frame) or belongs to a frame the runtime has marked closed.
bool isSettled(const GraphTaskState& state, const GraphNode& n) {
    if (n.family == NodeFamily::Belief) return true;
    if (!n.frameId) return false;
    for (const LoopFrameInfo& fi : state.frames) {
        if (fi.id == *n.frameId) return fi.closed;
    }
    return false;
}
} // namespace

PieGraphLayout stabilizeLiveLayout(const GraphTaskState& state,
                                   const PieGraphLayout& fresh,
                                   GraphLiveState& live) {
    PieGraphLayout result = fresh;
    if (live.havePrev) {
        // Freeze settled nodes at their previous rects (only if the node still
        // exists in the fresh layout).
        for (const GraphNode& n : state.nodes) {
            if (!isSettled(state, n)) continue;
            auto prevIt = live.prevLayout.nodeRects.find(n.id.value);
            auto freshIt = result.nodeRects.find(n.id.value);
            if (prevIt != live.prevLayout.nodeRects.end() &&
                freshIt != result.nodeRects.end()) {
                freshIt->second = prevIt->second;
            }
        }
    }
    // Persist the stabilized layout for the next round of updates.
    live.prevLayout = result;
    live.havePrev = true;
    return result;
}

} // namespace pie::gui
