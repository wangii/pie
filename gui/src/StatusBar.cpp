// PIE Native GUI - global status bar component.
#include "StatusBar.h"

#include <imgui.h>

#include <cstdio>
#include <string>

#include "Theme.h"

namespace pie::gui {

void renderStatusBar(const pie::gui::NativeGuiModel& m) {
    const auto& c = m.cursor();
    ImGui::TextUnformatted("PIE");
    ImGui::SameLine();
    ImGui::TextUnformatted(("Session: " + m.session()).c_str());
    ImGui::SameLine();
    ImGui::Separator();

    if (c.valid()) {
        const auto* task = m.selectedTask();
        std::string taskLabel =
            (task && !task->targetStatement.empty()) ? task->targetStatement : c.taskId;
        ImGui::TextUnformatted(("Task: " + taskLabel).c_str());
        ImGui::SameLine();
        ImGui::PushStyleColor(ImGuiCol_Text, kAccent);
        ImGui::TextUnformatted(pie::gui::frameStageToString(c.stage));
        ImGui::PopStyleColor();
        ImGui::SameLine();
        ImGui::Separator();
    } else {
        ImGui::TextUnformatted("(no active frame)");
    }

    // Current context length for the two belief-loop roles (split epistemic /
    // execution), displayed to the left of the right-aligned : prompt hint. The
    // runtime may report tokens as unknown (negative placeholder -> em-dash).
    const pie::gui::RoleContextUsagePair& rcu = m.roleContext();
    if (rcu.hasData) {
        auto fmt = [](long tokens) -> std::string {
            if (tokens < 0) return "\xe2\x80\x94";                 // em-dash
            if (tokens >= 1000000) return std::to_string(tokens / 1000000) + "M";
            if (tokens >= 1000) {
                char buf[16];
                std::snprintf(buf, sizeof(buf), "%.1fk", tokens / 1000.0);
                return buf;
            }
            return std::to_string(tokens);
        };

        std::string ctx = "ctx [Epi]";
        ctx += fmt(rcu.epistemic.tokens);
        ctx += " · [Exec]";
        ctx += fmt(rcu.execution.tokens);

        // ImGui::SameLine();
        ImGui::PushStyleColor(ImGuiCol_Text, kGray);
        ImGui::TextUnformatted(ctx.c_str());
        ImGui::SameLine();
        ImGui::Separator();
        ImGui::PopStyleColor();
    }

    ImGui::SameLine();
    float avail = ImGui::GetContentRegionAvail().x;
    ImGui::SetCursorPosX(ImGui::GetCursorPosX() + std::max(30.0f, avail - 120.0f));
    ImGui::PushStyleColor(ImGuiCol_Text, kGray);
    ImGui::TextUnformatted(":  User prompt");
    ImGui::PopStyleColor();
}

} // namespace pie::gui
