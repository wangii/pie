// PIE Native GUI - Belief Set lane component.
#include "BeliefLane.h"

#include <imgui.h>

#include <set>
#include <string>
#include <vector>

#include "Theme.h"
#include "UiShared.h"

namespace pie::gui {

void renderBeliefLane(const pie::gui::NativeGuiModel& m, const std::string& viewId) {
    const auto* f = displayedFrame(m, viewId);

    // Beliefs changed by this frame's explicit belief deltas (highlight amber).
    std::set<std::string> changedIds;
    if (f) {
        for (const auto& d : f->beliefDeltas) {
            if (!d.beliefId.empty()) changedIds.insert(d.beliefId);
        }
    }

    ImGui::TextUnformatted("BELIEF SET");
    ImGui::Separator();

    const auto& beliefs = m.beliefs();
    for (const auto& b : beliefs) {
        bool isSel = m.isSelectedInCurrentFrame(b.id);
        bool isChanged = changedIds.count(b.id) != 0;

        ImVec2 start = ImGui::GetCursorScreenPos();
        ImGui::PushID(b.id.c_str());

        // Visible belief label as the header title. Items default to open so the
        // statement is visible without extra clicks.
        const std::string title = m.beliefLabel(b.id) + " " + b.status;
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
            ImGui::TextWrapped("%s", b.statement.c_str());
            if (!b.expectation.empty()) {
                ImGui::TextDisabled("expects: %s", b.expectation.c_str());
            }
            if (!b.createdInFrame.empty()) {
                ImGui::TextDisabled("source: %s", b.createdInFrame.c_str());
            }
            ImGui::Unindent();
        }

        ImGui::PopID();

        // Left accent markers: two independent facts about this belief, drawn so that
        // neither hides the other.
        //   - kAccent      = the displayed frame's plan selected this belief;
        //   - kFocusAccent = the task declared it is acting on this belief.
        // Scope is not status: a focused belief keeps its own status color, and an
        // out-of-focus one is retained history that stays fully readable. Nothing is
        // marked until the task declares a focus, matching the graph view.
        //
        // The selected marker hangs in the gutter left of the row. That gutter is only a
        // few pixels wide, so the focus marker is drawn inside the row at its left edge
        // instead: a second bar in the gutter is clipped by the child's clip rect.
        const bool inFocus = m.beliefInSelectedTaskFocus(b.id);
        if (isSel || inFocus) {
            ImVec2 end = ImGui::GetCursorScreenPos();
            ImDrawList* dl = ImGui::GetWindowDrawList();
            if (isSel) {
                dl->AddRectFilled(ImVec2(start.x - 4.0f, start.y),
                                  ImVec2(start.x - 1.0f, end.y),
                                  ImGui::GetColorU32(kAccent));
            }
            if (inFocus) {
                dl->AddRectFilled(ImVec2(start.x + 1.0f, start.y),
                                  ImVec2(start.x + 4.0f, end.y),
                                  ImGui::GetColorU32(kFocusAccent));
            }
        }
        ImGui::Spacing();
    }
}

} // namespace pie::gui
