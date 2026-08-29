// Headless geometry helpers for GraphView node labels.
#pragma once

#include "graph/PieGraphLayout.h"

namespace pie::gui {

// Labels are drawn as free text, but their visible pixels must stay within the
// node geometry used by hit testing and layout.
inline GraphRect nodeLabelClipRect(const GraphRect& nodeRect) {
    return nodeRect;
}

} // namespace pie::gui
