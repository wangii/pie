// PIE Native GUI - bottom footer component.
//
// Renders the per-belief-loop-role model + cache hit rate for the four phases
// (epistemic/propose, planner, distillation, execution) and the accumulated
// session cost. Reads only the footer telemetry on the model (populated by the
// runtime's session_status RPC event) and renders a single compact row pinned
// to the bottom of the workspace.
#pragma once

#include "Model.h"

namespace pie::gui {

void renderFooter(const pie::gui::NativeGuiModel& m);

} // namespace pie::gui
