// PIE Native GUI - shared UI helper.
#include "UiShared.h"

namespace pie::gui {

const pie::gui::LoopFrame* displayedFrame(const pie::gui::NativeGuiModel& m, const std::string& viewId) {
    if (!viewId.empty()) return m.frameById(viewId);
    return m.activeFrame();
}

} // namespace pie::gui
