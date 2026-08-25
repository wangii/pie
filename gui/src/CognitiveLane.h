// PIE Native GUI - Cognitive Process lane component.
#pragma once

#include "Model.h"

namespace pie::gui {

void renderCognitiveLane(const pie::gui::NativeGuiModel& m, int viewId, bool enableScroll);

// Render the proposals pane at the top of the left (belief set) lane. It spans
// the lane width and holds a fixed `height` (fraction of the lane); the belief
// set is rendered below the remaining region by renderBeliefLane.
void renderProposalsPane(const pie::gui::NativeGuiModel& m, int viewId, float height);

} // namespace pie::gui
