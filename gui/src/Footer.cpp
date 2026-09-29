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
//
// `active` marks the slot whose phase currently has an assistant turn in flight
// (`NativeGuiModel::openTurn()`): colour + bold is the whole marker, so it stays a
// static emphasis (gui/AGENTS.md forbids animation) and reuses the bold face the
// markdown renderer already loaded.
void renderRoleSlot(const char* label, const RoleFooterSlot& slot, bool active) {
    ImFont* const bold = active ? markdownBoldFont() : nullptr;
    if (active) {
        ImGui::PushStyleColor(ImGuiCol_Text, kAccent);
        if (bold != nullptr) ImGui::PushFont(bold);
    }

    // Keep the compact bracket label ("[Epi]") used by the text-workspace
    // footer; the graph footer reuses the same slot renderer.
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

    if (active) {
        if (bold != nullptr) ImGui::PopFont();
        ImGui::PopStyleColor();
    }
}

// The footer slot an in-flight turn belongs to, or -1 when its stage has no slot.
// Routing and finalReport (`Closed`) dispatch a model too, but `session_status`
// carries no slot for them, so they highlight nothing rather than the wrong role.
int activeRoleSlot(EpisodeStage stage) {
    switch (stage) {
        case EpisodeStage::Proposing: return 0;
        case EpisodeStage::Distilling: return 1;
        case EpisodeStage::Executing: return 2;
        case EpisodeStage::Routing:
        case EpisodeStage::Closed:
        case EpisodeStage::Unknown: return -1;
    }
    return -1;
}

// Render the role context lengths as one short labeled segment (used by the
// graph footer so the ctx info stays on the same single line as the roles).
void renderCtxSlot(const char* label, long tokens) {
    ImGui::TextUnformatted(label);
    ImGui::SameLine();
    ImGui::PushStyleColor(ImGuiCol_Text, kGray);
    if (tokens < 0) {
        ImGui::TextUnformatted("\xe2\x80\x94");
    } else if (tokens >= 1000000) {
        char buf[32];
        std::snprintf(buf, sizeof(buf), "%ldM", tokens / 1000000);
        ImGui::TextUnformatted(buf);
    } else if (tokens >= 1000) {
        char buf[32];
        std::snprintf(buf, sizeof(buf), "%.1fk", tokens / 1000.0);
        ImGui::TextUnformatted(buf);
    } else {
        char buf[32];
        std::snprintf(buf, sizeof(buf), "%ld", tokens);
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

    const TraceEntry* const turn = m.openTurn();
    const int active = turn != nullptr ? activeRoleSlot(turn->stage) : -1;
    renderRoleSlot("Epistemic", f.epistemic, active == 0);
    ImGui::SameLine();
    renderRoleSlot("Distillation", f.distillation, active == 1);
    ImGui::SameLine();
    renderRoleSlot("Execution", f.execution, active == 2);

    // ImGui::SameLine();
    // ImGui::TextUnformatted("Total cost:");
    // ImGui::SameLine();
    // char cost[64];
    // std::snprintf(cost, sizeof(cost), "$%.3f", f.sessionCost);
    // ImGui::TextUnformatted(cost);
}

void renderGraphFooter(const pie::gui::NativeGuiModel& m) {
    const Footer& f = m.footer();
    const RoleContextUsagePair& rc = m.roleContext();

    if (!f.hasData && !rc.hasData) {
        ImGui::PushStyleColor(ImGuiCol_Text, kGray);
        ImGui::TextUnformatted("graph footer: waiting for session telemetry...");
        ImGui::PopStyleColor();
        return;
    }

    if (rc.hasData) {
        renderCtxSlot("Ctx[Epi]", rc.epistemic.tokens);
        ImGui::SameLine();
        renderCtxSlot("Ctx[Exec]", rc.execution.tokens);
        ImGui::SameLine();
    }
    if (f.hasData) {
        const TraceEntry* const turn = m.openTurn();
        const int active = turn != nullptr ? activeRoleSlot(turn->stage) : -1;
        renderRoleSlot("Epistemic", f.epistemic, active == 0);
        ImGui::SameLine();
        renderRoleSlot("Distillation", f.distillation, active == 1);
        ImGui::SameLine();
        renderRoleSlot("Execution", f.execution, active == 2);
    }
}

} // namespace pie::gui
