// PIE Native GUI - Belief Set lane component.
#include "BeliefLane.h"

#include <imgui.h>

#include <string>
#include <vector>

#include "Theme.h"
#include "UiShared.h"

namespace pie::gui {

void renderBeliefLane(const pie::gui::NativeGuiModel& m, int viewId) {
    const auto* f = displayedFrame(m, viewId);

    std::vector<int> changedIds;
    if (f) {
        for (auto& p : f->proposals) {
            int id = beliefIdFromLabel(p.belief);
            if (id > 0) changedIds.push_back(id);
        }
    }

    ImGui::TextUnformatted("BELIEF SET");
    ImGui::Separator();

    ImGui::BeginChild("belief_scroll", ImVec2(0, 0), false);
    const auto& beliefs = m.beliefs();
    for (const auto& b : beliefs) {
        bool isSel = false;
        if (f) for (auto s : f->selectedBeliefs) if (s.value == b.id.value) { isSel = true; break; }
        bool isChanged = false;
        for (int id : changedIds) if (id == b.id.value) { isChanged = true; break; }

        ImVec2 start = ImGui::GetCursorScreenPos();
        ImGui::PushID(b.id.value);

        // Visible belief ID as the header title. Items default to open so the statement
        // is visible without extra clicks; DefaultOpen only sets the initial state, so a
        // manual collapse afterward is preserved (ImGui TreeNodeUpdateNextOpen stores it).
        const std::string title = beliefLabel(b.id.value) + " " + b.status;
        ImVec4 c = beliefStatusColor(b.status);
        if (isSel) c = kAccent;
        if (isChanged) c = kAmber;
        ImGui::PushStyleColor(ImGuiCol_Text, c);
        ImGui::PushStyleColor(ImGuiCol_Header, ImVec4(c.x, c.y, c.z, 0.25f));
        ImGui::PushStyleColor(ImGuiCol_HeaderHovered, ImVec4(c.x, c.y, c.z, 0.25f));
        ImGui::PushStyleColor(ImGuiCol_HeaderActive, ImVec4(c.x, c.y, c.z, 0.25f));
        bool open = ImGui::CollapsingHeader(title.c_str(), ImGuiTreeNodeFlags_DefaultOpen);
        ImGui::PopStyleColor(4);

        if (open) {
            ImGui::Indent();
            if (b.confidence >= 0.0) {
                ImGui::TextDisabled("%.2f", b.confidence);
            }
            // Live mode carries the prose belief statement; the demo/headless
            // fixture uses the structured lhs/relation/rhs.
            if (!b.statement.empty()) {
                ImGui::TextWrapped("%s", b.statement.c_str());
            } else {
                ImGui::TextUnformatted((b.lhs + " ──" + b.relation + "──> " + b.rhs).c_str());
            }
            if (!b.sourceFrames.empty()) {
                std::string src = "source: ";
                for (size_t i = 0; i < b.sourceFrames.size(); ++i) {
                    if (i) src += ", ";
                    src += "#" + std::to_string(b.sourceFrames[i]);
                }
                ImGui::TextDisabled("%s", src.c_str());
            }
            ImGui::Unindent();
        }

        ImGui::PopID();

        // Left accent bar for selected beliefs.
        if (isSel) {
            ImVec2 end = ImGui::GetCursorScreenPos();
            ImGui::GetWindowDrawList()->AddRectFilled(
                ImVec2(start.x - 4.0f, start.y),
                ImVec2(start.x - 1.0f, end.y),
                ImGui::GetColorU32(kAccent));
        }
        ImGui::Spacing();
    }
    ImGui::EndChild();
}

} // namespace pie::gui
