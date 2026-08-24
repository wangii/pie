// PIE Native GUI - global status bar component.
//
// Renders the session/frame/stage indicator plus the "current" tool for the
// EXECUTING stage. Pure display; reads only from the model.
#pragma once

#include "Model.h"

namespace pie::gui {

void renderStatusBar(const pie::gui::NativeGuiModel& m);

} // namespace pie::gui
