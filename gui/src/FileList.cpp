// PIE Native GUI - session file-operation list data (model layer).
#include "FileList.h"

#include <filesystem>

namespace pie::gui {

std::string normalizeDisplayPath(const std::string& cwd, const std::string& raw) {
    using std::filesystem::path;
    if (raw.empty()) return raw;

    path base = cwd.empty() ? std::filesystem::current_path() : path(cwd);
    path rawPath(raw);
    path resolved = rawPath.is_absolute() ? rawPath : (base / rawPath);
    resolved = resolved.lexically_normal();

    // Show relative to cwd when the resolved path lies under cwd; otherwise a
    // normalized absolute path (with ".." segments) is the consistent display.
    path rel = resolved.lexically_relative(base);
    if (!rel.empty() && rel.string().rfind("..", 0) != 0) {
        return rel.generic_string();
    }
    return resolved.generic_string();
}

} // namespace pie::gui
