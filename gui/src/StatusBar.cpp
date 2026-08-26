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
        // ImGui::TextUnformatted(("Task #" + std::to_string(c.frameId)).c_str());
        // ImGui::SameLine();
        // ImGui::PushStyleColor(ImGuiCol_Text, kAccent);
        // ImGui::TextUnformatted(pie::gui::frameStageToString(c.stage));
        // ImGui::PopStyleColor();
        // ImGui::SameLine();
        // ImGui::Separator();

        // if (const auto* f = m.frameById(c.frameId); f && !f->selectedBeliefs.empty()) {
        //     std::string sel = "Selected: ";
        //     for (size_t i = 0; i < f->selectedBeliefs.size(); ++i) {
        //         if (i) sel += ", ";
        //         sel += beliefLabel(f->selectedBeliefs[i].value);
        //     }
        //     ImGui::TextUnformatted(sel.c_str());
        //     ImGui::SameLine();
        //     ImGui::Separator();
        // }
        // // The runtime never provides CursorChanged.item (rpc.md and the runtime
        // // emit only frameId+stage), so derive the "current" tool from the active
        // // frame's in-flight trajectory instead of a static, never-populated field.
        // if (c.stage == pie::gui::FrameStage::EXECUTING) {
        //     if (const auto* f = m.frameById(c.frameId)) {
        //         for (const auto& t : f->trajectory) {
        //             if (t.status == "running") {
        //                 ImGui::TextUnformatted(("Current: " + t.id).c_str());
        //                 break;
        //             }
        //         }
        //     }
        // }
    } else {
        ImGui::TextUnformatted("(no active frame)");
    }

    // Current context length for the two belief-loop roles (split epistemic /
    // execution), displayed to the left of the right-aligned ⌘T prompt hint. The
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

        ImGui::SameLine();
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
    ImGui::TextUnformatted("⌘T  User prompt");
    ImGui::PopStyleColor();
}

} // namespace pie::gui
