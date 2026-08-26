// PIE Native GUI - Cognitive Process lane component.
#include "CognitiveLane.h"

#include <imgui.h>

#include <algorithm>
#include <string>

#include "PaletteMetrics.h"
#include "Theme.h"
#include "UiMarkdown.h"
#include "UiShared.h"

namespace pie::gui {

void renderCognitiveLane(const pie::gui::NativeGuiModel& m, int viewId, bool enableScroll) {
    const auto* f = displayedFrame(m, viewId);
    ImGui::TextUnformatted("COGNITIVE PROCESS");
    ImGui::Separator();
    ImGui::BeginChild("cog_scroll", ImVec2(0, 0), false);
    // Cmd/Ctrl+Up/Down (macOS Cmd, elsewhere Ctrl) page-scroll the cognitive
    // lane, mirroring the instruction palette's in-message scroll. Read while
    // the cog_scroll child is the current window so GetScrollY/SetScrollY target
    // this region, not any other. `enableScroll` is false while the user-
    // instruction pane is open (the palette then owns the chord), preserving its
    // own Cmd/Ctrl+Up/Down behavior.
    if (enableScroll) {
        auto& io = ImGui::GetIO();
        const float maxScroll = ImGui::GetScrollMaxY();
        const float pageStep = std::max(ImGui::GetContentRegionAvail().y, 1.0f);
        if ((io.KeySuper || io.KeyCtrl) && ImGui::IsKeyPressed(ImGuiKey_DownArrow, false)) {
            ImGui::SetScrollY(paletteScrollByPage(ImGui::GetScrollY(), pageStep, maxScroll, +1));
        }
        if ((io.KeySuper || io.KeyCtrl) && ImGui::IsKeyPressed(ImGuiKey_UpArrow, false)) {
            ImGui::SetScrollY(paletteScrollByPage(ImGui::GetScrollY(), pageStep, maxScroll, -1));
        }
    }
    if (!f) { ImGui::TextDisabled("(no frame)"); ImGui::EndChild(); return; }

    // The CursorChanged stage of the active frame drives which paragraph in the
    // cognitive lane is the current flow step. Only the matching paragraph gets
    // the dark-gray background; the other two keep the default child background.
    const pie::gui::FrameStage stage = m.cursor().valid() ? m.cursor().stage : pie::gui::FrameStage::NONE;

    // PLAN
    {
        bool active = (stage == pie::gui::FrameStage::PLANNING);
        ImGui::PushStyleColor(ImGuiCol_ChildBg, paneBg(active));
        ImGui::BeginChild("plan_section", ImVec2(0, 0), ImGuiChildFlags_AutoResizeY, ImGuiChildFlags_AlwaysUseWindowPadding);
        ImGui::PushStyleColor(ImGuiCol_Text, kAccent);
        ImGui::TextUnformatted("PLAN");
        ImGui::PopStyleColor();
        if (f->plan.valid()) {
            ImGui::TextUnformatted(("Intent " + f->plan.label).c_str());
            if (!f->selectedBeliefs.empty()) {
                std::string sel = "Selected: ";
                for (size_t i = 0; i < f->selectedBeliefs.size(); ++i) {
                    if (i) sel += ", ";
                    sel += beliefLabel(f->selectedBeliefs[i].value);
                }
                ImGui::TextDisabled("%s", sel.c_str());
            }
            ImGui::TextUnformatted(("Q: " + f->plan.question).c_str());
            ImGui::TextWrapped("%s", ("Intent: " + f->plan.intent).c_str());
        } else {
            ImGui::TextDisabled("(no plan yet)");
        }
        ImGui::EndChild();
        ImGui::PopStyleColor(1);
    }

    ImGui::Spacing();
    ImGui::Separator();

    // DISTILLATION
    {
        bool active = (stage == pie::gui::FrameStage::DISTILLING);
        ImGui::PushStyleColor(ImGuiCol_ChildBg, paneBg(active));
        ImGui::BeginChild("distillation_section", ImVec2(0, 0), ImGuiChildFlags_AutoResizeY, ImGuiChildFlags_AlwaysUseWindowPadding);
        ImGui::PushStyleColor(ImGuiCol_Text, kAmber);
        ImGui::TextUnformatted("DISTILLATION");
        ImGui::PopStyleColor();
        if (f->distillation.valid()) {
            ImGui::TextUnformatted(("D-42 " + f->distillation.label).c_str());
            ImGui::TextUnformatted("Input:");
            for (auto& id : f->distillation.inputIds) {
                ImGui::BulletText("%s", id.c_str());
            }
            if (!f->distillation.unexplained.empty()) {
                ImGui::TextWrapped("Unexplained:");
                ImGui::NewLine();
                renderMarkdownMessage(f->distillation.unexplained);
            }
            if (!f->distillation.interpretation.empty()) {
                ImGui::TextWrapped("Interpretation:");
                ImGui::NewLine();
                renderMarkdownMessage(f->distillation.interpretation);
            }
        } else {
            ImGui::TextDisabled("(no distillation yet)");
        }
        ImGui::EndChild();
        ImGui::PopStyleColor(1);
    }

    ImGui::EndChild();
}

} // namespace pie::gui
