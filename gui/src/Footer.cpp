// PIE Native GUI - bottom footer component.
#include "Footer.h"

#include <cstring>
#include <imgui.h>

#include <string>

#include "Theme.h"

namespace pie::gui {

namespace {

// Render one belief-loop-role slot as "<label>: <provider/id> (CH x.xx%)".
// Undefined model / cache hit rate render as the em-dash placeholder, matching
// the TUI footer (formatRoleSlotLine).
void renderRoleSlot(const char* label, const RoleFooterSlot& slot) {

    char name[6];
    name[0] = '[';
    name[4] = ']';
    name[5] = 0;
    std::strncpy(&name[1], label, 3);

    ImGui::TextUnformatted(name);
    ImGui::SameLine();
    ImGui::TextUnformatted(":");
    ImGui::SameLine();
    if (slot.model.empty()) {
        ImGui::TextUnformatted("\xe2\x80\x94");  // em-dash
    } else {
        ImGui::TextUnformatted(slot.model.c_str());
    }
    ImGui::SameLine();
    ImGui::PushStyleColor(ImGuiCol_Text, kGray);
    if (slot.cacheHitRate < 0.0f) {
        ImGui::TextUnformatted("(CH \xe2\x80\x94)");
    } else {
        char buf[64];
        std::snprintf(buf, sizeof(buf), "(CH %.1f%%)", slot.cacheHitRate);
        ImGui::TextUnformatted(buf);
    }
    ImGui::PopStyleColor();
    ImGui::SameLine();
    ImGui::Separator();
}

} // namespace

void renderFooter(const pie::gui::NativeGuiModel& m) {
    const Footer& f = m.footer();

    if (!f.hasData) {
        ImGui::PushStyleColor(ImGuiCol_Text, kGray);
        ImGui::TextUnformatted("footer: waiting for session telemetry...");
        ImGui::PopStyleColor();
        return;
    }

    renderRoleSlot("Epistemic", f.epistemic);
    ImGui::SameLine();
    renderRoleSlot("Planner", f.planner);
    ImGui::SameLine();
    renderRoleSlot("Distillation", f.distillation);
    ImGui::SameLine();
    renderRoleSlot("Execution", f.execution);

    // ImGui::SameLine();
    // ImGui::TextUnformatted("Total cost:");
    // ImGui::SameLine();
    // char cost[64];
    // std::snprintf(cost, sizeof(cost), "$%.3f", f.sessionCost);
    // ImGui::TextUnformatted(cost);
}

} // namespace pie::gui
