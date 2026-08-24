// PIE Native GUI - current-frame summary component.
#include "Summary.h"

#include <imgui.h>

#include <string>

#include "Theme.h"
#include "UiShared.h"

namespace pie::gui {

void renderSummary(const pie::gui::NativeGuiModel& m, int viewId) {
    const auto* f = displayedFrame(m, viewId);
    ImGui::TextUnformatted("CURRENT FRAME");
    ImGui::SameLine();
    if (f) ImGui::TextDisabled("#%d", f->id);
    ImGui::Separator();
    if (!f) { ImGui::TextDisabled("(no frame)"); return; }

    // B42 + B47 -> intent -> N steps -> distillation -> {proposals}
    std::string sel;
    for (size_t i = 0; i < f->selectedBeliefs.size(); ++i) {
        if (i) sel += " + ";
        sel += beliefLabel(f->selectedBeliefs[i].value);
    }
    if (sel.empty()) sel = "(none)";
    std::string line = sel + "  →  ";
    line += f->plan.valid() ? f->plan.intent : "(planning)";
    line += "  →  ";
    line += std::to_string(f->trajectory.size()) + " execution step(s)";
    line += "  →  ";
    line += f->distillation.valid() ? (f->distillation.unexplained.empty() ? "distilled" : f->distillation.unexplained) : "(pending)";
    if (!f->proposals.empty()) {
        line += "  →  {";
        for (size_t i = 0; i < f->proposals.size(); ++i) {
            if (i) line += ", ";
            line += std::string(1, f->proposals[i].op) + f->proposals[i].belief;
        }
        line += "}";
    }
    ImGui::TextWrapped("%s", line.c_str());
}

} // namespace pie::gui
