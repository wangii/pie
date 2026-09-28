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
// Left-accent marker for a belief in the selected task's focus slice. Scope, not
// status: the belief keeps its own status color, and the marker only says the task
// is acting on it. Matches the graph view's GraphStyle.focusAccent.
extern const ImVec4 kFocusAccent;
extern const ImVec4 kPaneBgDark;

// The one user-approved animation in the GUI (docs/milestones.md §6.3), and its
// single definition. `active` false is the resting child background; true is the
// black <-> kPaneBgDark sinusoid.
//
// It used to wash the background of the current flow-step pane, which is why the
// name says "pane". Those panes were the cognitive and execution lanes, both
// removed with the text workspace. The animation was NOT dropped with them: M5
// redirected it onto the canvas's current-node halo (GraphView.cpp), which calls
// `paneBg(true)` for the pulsing ring. The name is kept deliberately — renaming it
// would make the redirect look like a new animation rather than the one the user
// asked to keep.
ImVec4 paneBg(bool active);

// Colour for a belief's DERIVED status. Takes the enum rather than a string: the
// v1 signature took a status name, which let a caller pass a spelling the model
// could not produce (and it did: four legacy spellings were carried for
// back-compat with fixtures that no longer exist).
ImVec4 beliefStatusColor(BeliefStatus status);

// Markdown renderer font resources, loaded by main and read by UiMarkdown.
void setMarkdownFonts(ImFont* codeFont, ImFont* boldFont);
ImFont* markdownCodeFont();
ImFont* markdownBoldFont();

} // namespace pie::gui
