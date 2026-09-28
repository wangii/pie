// PieGraphLayout: the deterministic dot + rail + episode-row layout (§6.2).
//
// Headless and ImGui-free. The engine supplies POSITIONS ONLY: it reads the
// projected state and never decides what a node means. Anything the canvas shows
// that is not a position comes from GraphModel.
//
// The deterministic contract is unchanged from the v1 engine and still the point:
// identical input produces identical output, and every position is keyed by
// NodeId. A layout that reflows differently on the same state makes the canvas
// unusable for following a live session, and makes the layout untestable.
//
// WHAT WENT AWAY. The v1 engine laid out a region/band model: `frameRects`,
// `beliefRegionRects`, `planRegionRects`, `proposeRegionRects`,
// `distillRegionRects`, `executionRegionRects`, `columnHeaderHeight`,
// `phaseBandGap`. Every one of those existed to draw a titled box around a group
// of nodes. A dot-and-link canvas has no boxes, so none of them survive. What is
// left is:
//
//   * `nodes`          — every node's Dot{x, y, r}, keyed by NodeId.
//   * `gutters`        — one band per episode row: the separator and the ordinal
//                        label live in the left gutter.
//   * `versionRail`    — the band the Frame versions are laid along.
//   * `beliefRail`     — the band the global belief column occupies.
//   * `outcomeBand`    — the task outcome strip; zero-sized when none was recorded.
//
// Sizes collapse from the v1 200x60 card to a single `dotDiameter`. Hit testing
// and tooltips are radial rather than rectangular, which is why `GraphRect` is now
// only used for BANDS (rails, gutters, the outcome strip) and never for a node.

#pragma once

#include <map>
#include <string>
#include <vector>

#include "graph/GraphModel.h"

namespace pie::gui {

// A node's position and radius. There is no width or height: a dot is a circle,
// and a consumer that needs a box computes it from the radius.
struct Dot {
    float x = 0.0f;
    float y = 0.0f;
    float r = 0.0f;
    bool valid() const { return r > 0.0f; }
};

struct PieGraphLayout {
    // Keyed by NodeId value. Every node in the state has an entry.
    std::map<std::string, Dot> nodes;
    // One band per episode row, in row order.
    std::vector<EpisodeGutter> gutters;
    // The Frame rail's band and the belief column's band. Both are zero-sized when
    // the state has no versions / no beliefs.
    GraphRect versionRail;
    GraphRect beliefRail;
    // The task outcome strip, or a zero-size rect when the task recorded none.
    GraphRect outcomeBand;
    float canvasWidth = 0.0f;
    float canvasHeight = 0.0f;

    // The dot for a node, or nullptr. Radial hit testing: a consumer asks whether a
    // point is inside `r` of (x, y).
    const Dot* dot(const std::string& nodeId) const;
};

// Lay one projected task out. Deterministic: identical `state` in, identical
// `PieGraphLayout` out.
PieGraphLayout computeGraphLayout(const GraphTaskState& state);

} // namespace pie::gui
