// PIE Native GUI - global status bar component.
#include "StatusBar.h"

#include <imgui.h>

#include <cstdio>
#include <string>

#include "Theme.h"

namespace pie::gui {

// One row, always. `Separator()` after `SameLine()` draws a VERTICAL rule but does
// NOT return the cursor to the same row, so every separator here is followed by a
// `SameLine()` of its own. Without them the bar silently becomes two rows, which
// is invisible until something gives it a fixed height — as the M1 header band
// does, at which point the second row is clipped rather than merely wrapped.

namespace {

// Token counts arrive as -1 when the runtime reports null, which is "unknown" and
// not "zero". It renders as an em-dash, never as a number (§3.6).
std::string formatTokens(long tokens) {
    if (tokens < 0) return "\xe2\x80\x94";
    if (tokens >= 1000000) return std::to_string(tokens / 1000000) + "M";
    if (tokens >= 1000) {
        char buf[16];
        std::snprintf(buf, sizeof(buf), "%.1fk", tokens / 1000.0);
        return buf;
    }
    return std::to_string(tokens);
}

} // namespace

void renderStatusBar(const pie::gui::NativeGuiModel& m) {
    ImGui::TextUnformatted("PIE");
    ImGui::SameLine();
    ImGui::TextUnformatted(("Session: " + m.session()).c_str());
    ImGui::SameLine();
    ImGui::Separator();
    ImGui::SameLine();

    const AgentSessionCursor& cursor = m.cursor();
    if (cursor.valid()) {
        // The task is named by its own prompt, which is the only human-readable
        // handle the model carries. There is no user selection to name it by.
        std::string label = cursor.taskId;
        if (const Task* task = m.task(cursor.taskId)) {
            if (!task->initialPrompt.original.empty()) label = task->initialPrompt.original;
            if (label.size() > 64) label = label.substr(0, 63) + "\xe2\x80\xa6";
        }
        ImGui::TextUnformatted(("Task: " + label).c_str());
        ImGui::SameLine();
        ImGui::PushStyleColor(ImGuiCol_Text, kAccent);
        ImGui::TextUnformatted(pie::gui::toString(cursor.stage));
        ImGui::PopStyleColor();
        ImGui::SameLine();
        ImGui::Separator();
        ImGui::SameLine();
    } else {
        ImGui::TextUnformatted("(no active round)");
    }

    // An event-only session has no snapshot, so the panels are showing a
    // projection of the stream alone. Saying so is the difference between "there
    // are no beliefs" and "I could not read them" (§5.3), which is the whole
    // reason the flag exists.
    if (m.isEventOnly()) {
        ImGui::PushStyleColor(ImGuiCol_Text, kAmber);
        ImGui::TextUnformatted("bootstrap unavailable \xe2\x80\x94 state is event-only");
        ImGui::PopStyleColor();
        ImGui::SameLine();
        ImGui::Separator();
        ImGui::SameLine();
    }

    // Replay issues: the fold refused something the runtime's own log said. The
    // count is shown rather than swallowed, because a silent refusal is how a
    // mirror drifts from its original (§5.3).
    if (!m.issues().empty()) {
        ImGui::PushStyleColor(ImGuiCol_Text, kRed);
        ImGui::TextUnformatted(("issues: " + std::to_string(m.issues().size())).c_str());
        ImGui::PopStyleColor();
        ImGui::SameLine();
        ImGui::Separator();
        ImGui::SameLine();
    }

    const RoleContextUsagePair& usage = m.roleContext();
    if (usage.hasData) {
        std::string ctx = "ctx [Epi]" + formatTokens(usage.epistemic.tokens) + " \xc2\xb7 [Exec]" +
                          formatTokens(usage.execution.tokens);
        ImGui::PushStyleColor(ImGuiCol_Text, kGray);
        ImGui::TextUnformatted(ctx.c_str());
        ImGui::PopStyleColor();
        ImGui::SameLine();
        ImGui::Separator();
        ImGui::SameLine();
    }

    // The right-aligned hint, drawn only when it actually fits: the bar is one
    // row and the content before it grows with the session, so a fixed offset
    // pushed it off the edge and clipped it mid-word. A hint that cannot be read
    // is worse than no hint — the chord is in `AGENTS.md` and the Frame pane's own
    // button says the same thing.
    const char* hint = ":  User prompt";
    const float hintW = ImGui::CalcTextSize(hint).x;
    const float avail = ImGui::GetContentRegionAvail().x;
    if (avail >= hintW + 16.0f) {
        ImGui::SameLine();
        ImGui::SetCursorPosX(ImGui::GetCursorPosX() + avail - hintW - 4.0f);
        ImGui::PushStyleColor(ImGuiCol_Text, kGray);
        ImGui::TextUnformatted(hint);
        ImGui::PopStyleColor();
    }
}

} // namespace pie::gui
