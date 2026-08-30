// PIE Native GUI - unified LogListBox component.
#include "LogListBox.h"

#include <imgui.h>

#include "BeliefLane.h"
#include "CognitiveLane.h"
#include "ExecutionLane.h"
#include "Theme.h"

namespace pie::gui {

void renderLogListBox(const pie::gui::NativeGuiModel& m, const std::string& viewId) {
    // Single scroll context owns the whole unified list. Each message type is a
    // section differentiated by Title and background color, in stable type order
    // (Belief, Cognitive, Execution). No cross-type time order is fabricated.
    ImGui::BeginChild("loglist_scroll", ImVec2(0, 0), false);

    // Belief section.
    ImGui::PushStyleColor(ImGuiCol_ChildBg, ImVec4(0.15f, 0.18f, 0.24f, 1.0f));
    ImGui::BeginChild("loglist_belief", ImVec2(0, 0), ImGuiChildFlags_AutoResizeY, ImGuiChildFlags_AlwaysUseWindowPadding);
    renderBeliefLane(m, viewId);
    ImGui::EndChild();
    ImGui::PopStyleColor(1);

    ImGui::Separator();

    // Cognitive section.
    ImGui::PushStyleColor(ImGuiCol_ChildBg, ImVec4(0.18f, 0.17f, 0.14f, 1.0f));
    ImGui::BeginChild("loglist_cognitive", ImVec2(0, 0), ImGuiChildFlags_AutoResizeY, ImGuiChildFlags_AlwaysUseWindowPadding);
    renderCognitiveLane(m, viewId);
    ImGui::EndChild();
    ImGui::PopStyleColor(1);

    ImGui::Separator();

    // Execution section.
    ImGui::PushStyleColor(ImGuiCol_ChildBg, ImVec4(0.13f, 0.20f, 0.15f, 1.0f));
    ImGui::BeginChild("loglist_execution", ImVec2(0, 0), ImGuiChildFlags_AutoResizeY, ImGuiChildFlags_AlwaysUseWindowPadding);
    renderExecutionLane(m, viewId);
    ImGui::EndChild();
    ImGui::PopStyleColor(1);

    ImGui::EndChild();
}

} // namespace pie::gui
