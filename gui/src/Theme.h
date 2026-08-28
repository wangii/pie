// PIE Native GUI - theme / palette + small display helpers.
//
// Color constants, the animated flow-step pane background, and the small
// belief-status helpers shared by the UI components. Font resources for the
// markdown renderer also live here so a single theme/resources module owns them
// and the markdown component only reads them.
#pragma once

#include <imgui.h>
#include <string>

#include "Model.h"

namespace pie::gui {

// Flow-step colors.
extern const ImVec4 kAccent;
extern const ImVec4 kGreen;
extern const ImVec4 kAmber;
extern const ImVec4 kRed;
extern const ImVec4 kGray;
extern const ImVec4 kPaneBgDark;

// Animated background for the current flow-step pane (user-approved exception
// to the no-animation rule). Inactive panes keep the default child background.
ImVec4 paneBg(bool active);

// Symbol for a frame's history flag. Only used by the (removed) navigator's
// legend; retained for completeness/tests.
const char* historySymbol(pie::gui::LoopFrame::History h);

// Status -> row color for the belief set pane (proposed/supported/refuted/
// superseded).
ImVec4 beliefStatusColor(const std::string& status);

// Markdown renderer font resources, loaded by main and read by UiMarkdown.
void setMarkdownFonts(ImFont* codeFont, ImFont* boldFont);
ImFont* markdownCodeFont();
ImFont* markdownBoldFont();

} // namespace pie::gui
