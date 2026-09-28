// The headless transcript replay's command line (docs/milestones.md §10).
//
// Split out of the tool's own `main` so the SAME entry point can be reached two
// ways: as the standalone `pie_gui_replay` binary (which `PIE_GUI_BUILD_APP=OFF`
// can still build, so a machine without the platform SDK can replay a
// transcript), and as `pie_gui --replay <file>`.
//
// Returns the process exit status: 0 when the transcript replayed, 1 when it
// could not be read. A ReplayIssue is NOT a failure — an issue is a fact about
// the log, and showing it is the point of the tool.

#pragma once

namespace pie::gui {

int runReplayCli(int argc, char** argv);

} // namespace pie::gui
