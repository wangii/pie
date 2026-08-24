// PIE Native GUI - Execution lane component.
#include "ExecutionLane.h"

#include <imgui.h>

#include <string>

#include "Theme.h"
#include "UiShared.h"

namespace pie::gui {

void renderExecutionLane(const pie::gui::NativeGuiModel& m, int viewId) {
    const auto* f = displayedFrame(m, viewId);
    const auto& cur = m.cursor();
    ImGui::TextUnformatted("EXECUTION");
    if (f && f->closed) { ImGui::SameLine(); ImGui::TextDisabled("(closed)"); }
    ImGui::Separator();
    ImGui::BeginChild("exec_scroll", ImVec2(0, 0), false);
    if (!f) { ImGui::TextDisabled("(no frame)"); ImGui::EndChild(); return; }
    if (f->trajectory.empty()) { ImGui::TextDisabled("(no execution steps)"); ImGui::EndChild(); return; }

    for (auto& t : f->trajectory) {
        // The runtime never provides CursorChanged.item, so a tool is "current"
        // when it is in flight (status == running) during the EXECUTING stage.
        bool isCurrent = (cur.valid() && cur.stage == pie::gui::FrameStage::EXECUTING && t.status == "running");
        std::string statusSym = "○";
        if (t.status == "ok") statusSym = "✓";
        else if (t.status == "running") statusSym = "●";
        else if (t.status == "failed") statusSym = "✗";
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

    // Always keep the execution log scrolled to the bottom so the newest step
    // stays visible as content is appended.
    ImGui::SetScrollHereY(1.0f);
    ImGui::EndChild();
}

} // namespace pie::gui
