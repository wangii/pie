// PIE Native GUI - session file-operation list data.
//
// A session-level, read/write/edit file list collected from the runtime's tool
// calls, with paths normalized relative to the current working directory. The
// model layer consumes tool-call events and records entries here; the UI layer
// renders them. Kept ImGui-free so it can be unit-tested without a window.
#pragma once

#include <string>

namespace pie::gui {

// One normalized file operation entry in the session file list.
struct FileEntry {
    std::string path;  // display path, normalized relative to cwd when under it
    std::string op;    // "read" / "write" / "edit"
};

// Resolve a raw tool path against `cwd` and produce a display path:
//   - a relative path is joined to cwd and lexically normalized;
//   - an absolute path is lexically normalized;
//   - when the resolved path lies under cwd it is shown relative to cwd,
//     otherwise a normalized absolute path is shown (with ".." segments).
//   - duplicate paths (same resolved path, same op) are NOT deduped here; the
//     model layer dedupes by (op, path).
std::string normalizeDisplayPath(const std::string& cwd, const std::string& raw);

} // namespace pie::gui
