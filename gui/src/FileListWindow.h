// PIE Native GUI - floating session file-list window (⌘F / Ctrl-F).
//
// A standalone, undecorated overlay window showing the read/write/edit files
// collected so far in the session, normalized relative to the session cwd.
// Mirrors the user-prompt palette pattern: toggled by the caller via Cmd/Ctrl-F
// and closed via Escape. Reads model state; never mutates it.
#pragma once

#include "Model.h"

namespace pie::gui {

// Render the file list as a floating window. `open` is toggled by the caller
// via Cmd/Ctrl-F and closed via Escape.
void renderFileList(bool& open, const pie::gui::NativeGuiModel& m);

} // namespace pie::gui
