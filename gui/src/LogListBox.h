// PIE Native GUI - unified LogListBox component.
//
// Replaces the three side-by-side lanes (Belief / Cognitive / Execution) with
// a single scrolling list. The LogListBox owns the only scroll context; each
// message type is a distinct section, distinguished by its Title and background
// color, rendered in a stable type order (Belief, Cognitive, Execution). No
// cross-type time order is fabricated: the model has no global sort key.
#pragma once

#include <string>

#include "Model.h"

namespace pie::gui {

void renderLogListBox(const pie::gui::NativeGuiModel& m, const std::string& viewId);

} // namespace pie::gui
