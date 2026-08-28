// PIE Native GUI - current-frame summary component.
#include "Summary.h"

#include <imgui.h>

#include <string>

#include "UiShared.h"

namespace pie::gui {

void renderSummary(const pie::gui::NativeGuiModel& m, const std::string& viewId) {
    const auto* f = displayedFrame(m, viewId);
    if (!f) { ImGui::TextDisabled("(no task)"); return; }

    // B1 + B2 -> intent -> N steps -> distillation -> {deltas}
    std::string sel;
    for (size_t i = 0; i < f->plan.selectedToExplore.size(); ++i) {
        if (i) sel += " + ";
        sel += m.beliefLabel(f->plan.selectedToExplore[i]);
    }
    if (sel.empty()) sel = "(none)";
    std::string line = sel + "  →  ";
    line += f->plan.valid() ? (f->plan.intent.empty() ? "planned" : f->plan.intent) : "(planning)";
    line += "  →  ";
    line += std::to_string(f->trajectory.size()) + " execution step(s)";
    line += "  →  ";
    line += f->distillation.valid() ? (f->distillation.contents.empty() ? "distilled" : f->distillation.contents) : "(pending)";
    if (!f->beliefDeltas.empty()) {
        line += "  →  {";
        for (size_t i = 0; i < f->beliefDeltas.size(); ++i) {
            if (i) line += ", ";
            line += f->beliefDeltas[i].operation + " " + m.beliefLabel(f->beliefDeltas[i].beliefId);
        }
        line += "}";
    }
    ImGui::TextWrapped("%s", line.c_str());
}

} // namespace pie::gui
