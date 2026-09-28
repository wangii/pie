// GraphLive: layout stability for a live session (§6.2).
//
// The projection recomputes from scratch every frame, and a live session keeps
// appending to it: a new execution lands, a new delta arrives, a new row opens.
// Re-laying the WHOLE canvas each time makes nodes jump under the user's cursor,
// which is unreadable in exactly the situation the canvas exists for.
//
// The v1 rule was "a closed LoopFrame is the stable unit". The v7 rule is the same
// idea with the right unit: **a closed ExecutionEpisode**, plus (task scope) a
// closed Task. Once a row's episode is closed, nothing may be appended to it —
// the fold enforces that — so its positions cannot legitimately change, and
// freezing them is not a heuristic but a consequence of the invariant.
//
// The belief rail is frozen differently, and more simply than in v1: a belief's
// position is now decided by the belief rail's own order (record order), not by
// the round that first wrote it. The v1 `stableBeliefAnchors` / `createdInFrame`
// machinery existed to keep a belief next to its creating frame; with the delta ->
// belief edge expressing that relation explicitly, a belief has no anchor to
// track, and the whole re-anchoring path is gone.

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
    // The Frame rail and the belief rail, frozen as bands. Both are append-only:
    // a version is never edited and a belief is never re-ordered, so a rail entry
    // that was drawn once stays where it was drawn.
    std::map<std::string, Dot> stableRailNodes;
};

// Merge a freshly computed layout with the frozen rows in `live`. Rows whose
// episode is closed keep their cached positions; every other node takes the fresh
// one. `live` is updated in place. The returned layout has the same canvas extent
// as `fresh`, so the scrollable area still grows with the session.
PieGraphLayout stabilizeLiveLayout(const GraphTaskState& state, const PieGraphLayout& fresh,
                                   GraphLiveState& live);

} // namespace pie::gui
