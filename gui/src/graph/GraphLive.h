// GraphLive: layout stability for a live session (§6.2).
//
// The projection recomputes from scratch every frame, and a live session keeps
// appending to it: a new execution lands, a new delta arrives, a new row opens.
// Re-laying the WHOLE canvas each time makes nodes jump under the user's cursor,
// which is unreadable in exactly the situation the canvas exists for.
//
// The v1 rule was "a closed LoopFrame is the stable unit". The v7 rule is the same
// idea with the right unit: **a closed ExecutionEpisode**. Once a row's episode is
// closed, nothing may be appended to it — the fold enforces that — so its
// INTERNAL geometry (each station's x, width and radius) cannot legitimately
// change. Its y is NOT frozen: episodes and Frame versions share one top-to-bottom
// time axis, so a closed row's y follows the fresh layout as new, earlier-timed
// entries arrive. Freezing x while letting y move is what keeps a station from
// sliding sideways without pinning the row against the time order.
//
// The belief rail is frozen the simple way: a belief's position is decided by the
// belief rail's own order (record order), not by the round that first wrote it, so
// a drawn entry stays where it was drawn. A Frame version is NOT frozen here — it
// lives on the shared time axis and must take the fresh y. The v1
// `stableBeliefAnchors` / `createdInFrame` machinery existed to keep a belief next
// to its creating frame; with the delta -> belief edge expressing that relation
// explicitly, a belief has no anchor to track, and that path is gone.

#pragma once

#include <map>
#include <string>

#include "graph/GraphModel.h"
#include "graph/PieGraphLayout.h"

namespace pie::gui {

// The frozen geometry of one completed row.
struct CompletedEpisodeLayout {
    // Every node of the row, by NodeId. The row anchor is in here too.
    std::map<std::string, Dot> nodes;
    GraphRect rect;
};

struct GraphLiveState {
    // Rows whose episode has closed, frozen. Keyed by episode id.
    std::map<std::string, CompletedEpisodeLayout> completedEpisodes;
    // Beliefs only, frozen by position. The belief rail is append-only, so an
    // entry that was drawn once stays where it was drawn. Frame versions are
    // deliberately absent: they are on the shared time axis and take the fresh y.
    std::map<std::string, Dot> stableRailNodes;
};

// Merge a freshly computed layout with the frozen rows in `live`. A closed row
// keeps its cached internal geometry (x, width, radius) but takes the fresh y; a
// frozen belief keeps its position; a Frame version always takes the fresh
// position. Every other node takes the fresh one. `live` is updated in place. The
// returned layout has the same canvas extent as `fresh`, so the scrollable area
// still grows with the session.
PieGraphLayout stabilizeLiveLayout(const GraphTaskState& state, const PieGraphLayout& fresh,
                                   GraphLiveState& live);

} // namespace pie::gui
