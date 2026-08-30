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

// Single-line telemetry footer for the Graph View, pinned to the screen bottom.
// Reuses the per-role slot rendering and appends the role context lengths, all
// on one horizontal row so it reads as a footer rather than an in-canvas overlay.
void renderGraphFooter(const pie::gui::NativeGuiModel& m);

} // namespace pie::gui
