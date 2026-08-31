// GraphLive: Phase 2 M6 live-layout stability.
//
// Headless, ImGui-free, unit-testable. In live mode the runtime streams
// node/edge additions and belief updates across the task, and the model
// recomputes a fresh auto-layout each frame. Completed frames are the stable
// unit: once a frame closes, its node rectangles, frame boundary, and semantic
// region surfaces are cached together. Open and pending frames always use the
// fresh layout, so a Propose node can move from its provisional current-frame
// position into the successor frame when DistillationProduced supplies its
// provenance. Global Beliefs have no owning frame and keep a stable position.

#pragma once

#include <map>
#include <optional>
#include <string>

#include "graph/GraphModel.h"
#include "graph/PieGraphLayout.h"

namespace pie::gui {

// One completed-frame cache entry. Region rectangles are optional because an
// empty phase has no surface in PieGraphLayout.
struct CompletedFrameLayout {
    std::map<std::string, GraphRect> nodeRects;
    GraphRect frameRect;
    std::optional<GraphRect> beliefRegionRect;
    std::optional<GraphRect> planRegionRect;
    std::optional<GraphRect> proposeRegionRect;
    std::optional<GraphRect> distillRegionRect;
    std::optional<GraphRect> executionRegionRect;
};

// Persistent per-session live-layout cache. Completed frames are cached as
// complete geometry groups; global Beliefs are cached separately because they
// intentionally have no owning frame.
struct GraphLiveState {
    std::map<std::string, CompletedFrameLayout> completedFrames;
    std::map<std::string, GraphRect> stableBeliefRects;
    // The display-anchor frame (createdInFrame) each cached stable Belief was
    // positioned for. A Belief's anchor can change when its producing Propose is
    // reparented to a successor frame; a stale rect for an old anchor must be
    // invalidated so the Belief moves to the new row instead of staying put.
    std::map<std::string, std::string> stableBeliefAnchors;
};

// Produce a stable layout for `state` given a `fresh` layout computed from the
// same state. Previously cached closed frames are restored as complete geometry
// groups. A newly closed or structurally changed frame is captured from fresh
// geometry. Open/pending frames always remain fresh. Non-framing Beliefs keep
// their first position; a framing Belief remains fresh while its display type
// is "proposed", then becomes stable. Stores updated frame and Belief entries
// back in `live`.
PieGraphLayout stabilizeLiveLayout(const GraphTaskState& state,
                                   const PieGraphLayout& fresh,
                                   GraphLiveState& live);

} // namespace pie::gui
