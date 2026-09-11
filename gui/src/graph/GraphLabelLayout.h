// Headless geometry helpers for GraphView node labels.
#pragma once

#include "graph/PieGraphLayout.h"

namespace pie::gui {

// Labels are drawn as free text, but their visible pixels must stay within the
// node geometry used by hit testing and layout.
inline GraphRect nodeLabelClipRect(const GraphRect& nodeRect) {
    return nodeRect;
}

// The left-edge accent bars a node can carry, in layout coordinates. A zero-width rect means
// the bar is absent.
struct NodeAccentBars {
    GraphRect current;  // the CURRENT node marker (runtime is executing this node)
    GraphRect focus;    // the node is in the selected task's focus (a Belief node)
};

// The two bars must not overlap, and CURRENT keeps its position because it marks what the
// runtime is doing right now; the focus bar follows it. Widths come from GraphStyle, passed in
// so this stays style-free and headless.
inline NodeAccentBars nodeAccentBars(const GraphRect& nodeRect, bool current, bool inFocus,
                                     float currentBarW, float focusBarW) {
    NodeAccentBars bars;
    float offset = 0.0f;
    if (current) {
        bars.current = GraphRect{nodeRect.x, nodeRect.y, currentBarW, nodeRect.h};
        offset = currentBarW;
    }
    if (inFocus) {
        bars.focus = GraphRect{nodeRect.x + offset, nodeRect.y, focusBarW, nodeRect.h};
    }
    return bars;
}

} // namespace pie::gui
