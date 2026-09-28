// BeliefPane: the belief list panel (docs/milestones.md §7.1).
//
// The rows are built by BeliefListModel (M6, headless and tested); this file only
// draws them. Two rules from the model layer are rendered here rather than
// decided here, and both are easy to undo by accident:
//
//   * The label comes from the row (`B7`), which was derived from record order at
//     build time. This file never numbers anything.
//   * The colour comes from the DERIVED status, via `beliefStatusColor`. There is
//     no stored status field to read even if someone wanted to.
//
// The one thing this file must get right on its own is `focusDeclared`: "the task
// never declared a focus" and "it declared an empty one" filter to the same empty
// list and mean different things, so the panel says which it is showing.

#pragma once

#include "BeliefListModel.h"
#include "Model.h"

namespace pie::gui {

// Render into the CURRENT ImGui child (the shell owns the panel rectangle, §7.4).
// `sort` and `filter` are edited in place by the panel's own toolbar, and the
// caller rebuilds the list from them each frame.
void renderBeliefList(const BeliefListModel& list, const pie::gui::NativeGuiModel& m,
                      BeliefSort& sort, BeliefFilter& filter);

} // namespace pie::gui
