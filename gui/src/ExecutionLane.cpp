// PIE Native GUI - Execution lane component.
#include "ExecutionLane.h"

#include <imgui.h>

#include <string>

#include "Theme.h"
#include "UiShared.h"

namespace pie::gui {

void renderExecutionLane(const pie::gui::NativeGuiModel& m, const std::string& viewId) {
    const auto* f = displayedFrame(m, viewId);
    const auto& cur = m.cursor();
    ImGui::TextUnformatted("EXECUTION");
    if (f && f->closed) { ImGui::SameLine(); ImGui::TextDisabled("(closed)"); }
    ImGui::Separator();
    if (!f) { ImGui::TextDisabled("(no frame)"); return; }
    if (f->trajectory.empty()) { ImGui::TextDisabled("(no execution steps)"); return; }

    for (auto& t : f->trajectory) {
        // A tool is "current" when it is in flight (status == running) during
        // the EXECUTING stage.
        bool isCurrent = (cur.valid() && cur.stage == pie::gui::FrameStage::EXECUTING && t.status == "running");
        std::string statusSym = "○";
        if (t.status == "ok") statusSym = "✓";
        else if (t.status == "running") statusSym = "●";
        else if (t.status == "failed") statusSym = "✗";
        else if (t.status == "cancelled") statusSym = "✗";
        else if (t.status == "pending") statusSym = "○";

        std::string label = std::string(statusSym) + " " + t.tool + ": " + t.command;
        if (isCurrent) {
            ImGui::PushStyleColor(ImGuiCol_Text, kAccent);
            label += "   CURRENT";
        }

        ImGui::PushID(t.id.c_str());
        if (ImGui::TreeNode(label.c_str())) {
            if (isCurrent) ImGui::PopStyleColor();
            ImGui::TextUnformatted(("tool:   " + t.tool).c_str());
            ImGui::TextWrapped("%s", ("command: " + t.command).c_str());
            ImGui::TextWrapped("%s", ("result:  " + t.result).c_str());
            if (!t.warning.empty()) {
                ImGui::PushStyleColor(ImGuiCol_Text, kAmber);
                ImGui::TextWrapped("%s", ("WARNING: " + t.warning).c_str());
                ImGui::PopStyleColor();
            }
            ImGui::TextDisabled("status: %s", t.status.c_str());
            ImGui::TreePop();
            ImGui::PopID();
            continue;
        }
        if (isCurrent) ImGui::PopStyleColor();
        ImGui::PopID();
    }
}

} // namespace pie::gui
