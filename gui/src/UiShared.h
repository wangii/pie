// PIE Native GUI - shared UI helper.
//
// Frame selection for the lanes/summary: pick the frame the view is locked to,
// or the active frame when no view is selected. Pure, read-only.
#pragma once

#include <string>

#include "Model.h"

namespace pie::gui {

// Return the frame to display for `viewId` (a non-empty stable frame id locks a
// historical frame; empty shows the active frame). Never null only if a
// matching frame exists.
const pie::gui::LoopFrame* displayedFrame(const pie::gui::NativeGuiModel& m, const std::string& viewId);

} // namespace pie::gui
