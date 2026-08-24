// PIE Native GUI - shared UI helper.
//
// Frame selection for the lanes/summary: pick the frame the view is locked to,
// or the active frame when no view is selected. Pure, read-only.
#pragma once

#include "Model.h"

namespace pie::gui {

// Return the frame to display for `viewId` (>=0 locks a historical frame;
// -1 shows the active frame). Never null only if a matching frame exists.
const pie::gui::LoopFrame* displayedFrame(const pie::gui::NativeGuiModel& m, int viewId);

} // namespace pie::gui
