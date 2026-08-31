// PIE Native GUI - theme / palette + small display helpers.
#include "Theme.h"

#include <cmath>

namespace pie::gui {

const ImVec4 kAccent(0.36f, 0.63f, 0.98f, 1.0f);
const ImVec4 kGreen(0.45f, 0.79f, 0.47f, 1.0f);
const ImVec4 kAmber(0.95f, 0.77f, 0.38f, 1.0f);
const ImVec4 kRed(0.86f, 0.38f, 0.35f, 1.0f);
const ImVec4 kGray(0.62f, 0.62f, 0.62f, 1.0f);
// Dark gray background used to highlight the pane/paragraph that corresponds
// to the current flow step (the CursorChanged stage): PLAN / DISTILLATION /
// PROPOSALS paragraphs in the cognitive lane, or the right execution lane for
// the EXECUTING stage. Distinct from kGray, which is a text color.
const ImVec4 kPaneBgDark(0.22f, 0.23f, 0.25f, 1.0f);

// Animated background for the current flow-step pane. The active pane's
// background oscillates between black and kPaneBgDark following a sinusoidal
// (non-linear) time relationship, per the user's explicit request overriding
// the gui no-animation rule for this highlight.
ImVec4 paneBg(bool active) {
    if (!active) return ImGui::GetStyleColorVec4(ImGuiCol_ChildBg);
    const float kSpeed = 1.0f;  // radians per second; full cycle ~ 6.28 s
    const float t = 0.5f - 0.5f * std::cos(ImGui::GetTime() * kSpeed);  // 0..1
    return ImVec4(kPaneBgDark.x * t, kPaneBgDark.y * t, kPaneBgDark.z * t, 1.0f);
}

const char* historySymbol(pie::gui::LoopFrame::History h) {
    switch (h) {
        case pie::gui::LoopFrame::History::Closed: return "✓";
        case pie::gui::LoopFrame::History::Unresolved: return "!";
        case pie::gui::LoopFrame::History::Falsified: return "✗";
        case pie::gui::LoopFrame::History::NewBelief: return "+";
        case pie::gui::LoopFrame::History::Revised: return "~";
        case pie::gui::LoopFrame::History::Current: return "●";
    }
    return "";
}

ImVec4 beliefStatusColor(const std::string& status) {
    if (status == "proposed") return kAccent;
    if (status == "supported") return kGreen;
    if (status == "refuted") return kRed;
    if (status == "inconclusive") return kGray;
    if (status == "superseded") return kAmber;
    // Legacy demo statuses retained for back-compat with older fixtures.
    if (status == "open") return kAccent;
    if (status == "closed") return kGreen;
    if (status == "falsified") return kRed;
    if (status == "revised") return kAmber;
    return ImGui::GetStyleColorVec4(ImGuiCol_Text);
}

// Markdown renderer font resources, loaded once by main and read by UiMarkdown.
static ImFont* gMarkdownCodeFont = nullptr;  // Italic face (fc-scan index 4).
static ImFont* gMarkdownBoldFont = nullptr;  // Bold face (fc-scan index 0).

void setMarkdownFonts(ImFont* codeFont, ImFont* boldFont) {
    gMarkdownCodeFont = codeFont;
    gMarkdownBoldFont = boldFont;
}

ImFont* markdownCodeFont() { return gMarkdownCodeFont; }
ImFont* markdownBoldFont() { return gMarkdownBoldFont; }

} // namespace pie::gui
