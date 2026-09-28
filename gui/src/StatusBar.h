// PIE Native GUI - global status bar component.
//
// Renders the session identity, the round the runtime cursor names, and the
// per-role context usage. Pure display; reads only from the model.
//
// The v1 bar read `selectedTask()` and `targetStatement`, neither of which the v7
// model has: there is no user-selected task (the canvas follows the runtime), and
// the prompt's own text is `initialPrompt`, not a "target statement". The stage
// comes from `AgentSessionCursor` as `EpisodeStage`.
#pragma once

#include "Model.h"

namespace pie::gui {

void renderStatusBar(const pie::gui::NativeGuiModel& m);

} // namespace pie::gui
