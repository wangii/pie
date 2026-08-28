// GraphLive.cpp: Phase 2 M6 live-layout stability implementation.
//
// Stabilize a fresh auto-layout by freezing every node at its previous rect
// except the framing ("Target") belief cards, which anchor below the latest
// episode and keep taking fresh positions as it grows. This keeps the graph
// from jumping on every streamed event while still tracking the opened target.

#include "graph/GraphLive.h"

#include <set>

namespace pie::gui {

namespace {
// A node is "settled" (position-stable) unless it is a framing ("Target")
// belief that is still in the propose state (displayType == "proposed", the
// deriveBeliefStatus fallback). Only that actively-worked target keeps
// updating its position as its episode box grows; every other node — global
// beliefs (including a framing target that is no longer proposed), closed-frame
// nodes, and active/open-frame nodes — freezes at its previous rect across live
// updates. New nodes still receive a fresh initial position because they have
// no previous rect yet.
bool isSettled(const GraphTaskState& state, const GraphNode& n) {
    (void)state;
    if (n.family == NodeFamily::Belief && n.domain == "framing")
        return n.displayType != "proposed";
    return true;
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
