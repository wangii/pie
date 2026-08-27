// GraphNavigation: Phase 2 M7 Focus Current navigation geometry (headless,
// ImGui-free).
//
// The M7 minimap overlay was removed from the Graph View (replaced by the Stage
// indicator). The only surviving piece of navigation geometry is the Focus
// Current pan: the pan that centers the current node in a viewport, used by
// GraphView.cpp. It is kept here (in the model layer) so the M7 navigation math
// stays verifiable without a window. The GUI never infers cognition: this
// module only maps geometry, never semantics.

#pragma once

#include <string>

#include "graph/GraphModel.h"
#include "graph/PieGraphLayout.h"

namespace pie::gui {

// The pan that centers `nodeId` in a viewW x viewH viewport at the given zoom.
// Independent of the current pan, so it can be used for first-entry and explicit
// Focus Current. Returns {0,0} if the node has no rect.
struct PanResult {
    float x = 0.0f;
    float y = 0.0f;
};
PanResult computeFocusPan(const PieGraphLayout& layout, const std::string& nodeId,
                          float viewW, float viewH, float zoom);

} // namespace pie::gui
