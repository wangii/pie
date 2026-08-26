// Pure, ImGui-free helpers for the instruction palette's "@" file/folder
// completion: detecting an active "@" mention and enumerating matching paths.
// Headless so they can be unit-tested without a window or ImGui.
//
// The user instruction input box is an ImGui::InputTextMultiline. When the
// cursor sits inside a whitespace-delimited token that begins with "@", the
// text right after "@" (up to the cursor) is a path prefix to complete against
// the working directory. These helpers isolate the parse and enumeration so the
// Tab-driven completion in the palette stays a thin overlay.

#pragma once

#include <algorithm>
#include <cstdint>
#include <filesystem>
#include <string>
#include <vector>

namespace pie::gui {

// An active "@" mention detected in an input buffer.
struct MentionContext {
    bool active = false;   // cursor is inside a token that begins with '@'
    int ampPos = -1;       // buffer index of the '@'
    std::string query;     // path prefix typed after '@', up to the cursor
};

// Scan `text` for the whitespace-delimited token ending at `cursor`. If that
// token starts with '@', it is an active mention: `ampPos` is the '@' index and
// `query` is the substring after '@' up to the cursor. A token is the run of
// non-whitespace characters immediately before `cursor`; if the '@' is not the
// token's first character (e.g. an email "foo@bar") no mention is reported.
inline MentionContext findMention(const std::string& text, int cursor) {
    MentionContext ctx;
    const int n = static_cast<int>(text.size());
    if (cursor < 0) cursor = 0;
    if (cursor > n) cursor = n;

    int start = cursor;
    while (start > 0 && text[static_cast<size_t>(start - 1)] != ' ' &&
           text[static_cast<size_t>(start - 1)] != '\t' &&
           text[static_cast<size_t>(start - 1)] != '\n') {
        --start;
    }
    if (start < cursor && text[static_cast<size_t>(start)] == '@') {
        ctx.active = true;
        ctx.ampPos = start;
        ctx.query = text.substr(static_cast<size_t>(start + 1),
                                static_cast<size_t>(cursor - (start + 1)));
    }
    return ctx;
}

inline bool pathStartsWith(const std::string& s, const std::string& prefix) {
    return s.size() >= prefix.size() &&
           s.compare(0, prefix.size(), prefix) == 0;
}

// Result of a single Tab-driven completion step: the rewritten buffer and the
// new cursor position, plus the index of the candidate that was inserted.
struct MentionCompletion {
    int activeIndex = -1; // candidate index inserted into the buffer
    std::string text;     // full buffer after replacing the mention range
    int cursor = 0;       // cursor position after the inserted candidate
};

// Perform one completion step on `buf`. Replaces the mention range
// [ampPos+1, cursor) (implied by `ctx`) with the candidate at `nextIndex`,
// returning the new buffer and cursor. `nextIndex` must be a valid index into
// `candidates`. Pure and ImGui-free so it is unit-testable.
inline MentionCompletion applyMention(const std::string& buf, const MentionContext& ctx,
                                      const std::vector<std::string>& candidates,
                                      int nextIndex) {
    MentionCompletion out;
    out.activeIndex = nextIndex;
    const int start = ctx.ampPos + 1;
    out.text = buf.substr(0, static_cast<size_t>(start)) +
               candidates[static_cast<size_t>(nextIndex)] +
               buf.substr(static_cast<size_t>(ctx.ampPos + 1) +
                          static_cast<size_t>(ctx.query.size()));
    out.cursor = start + static_cast<int>(candidates[static_cast<size_t>(nextIndex)].size());
    return out;
}

// Enumerate files/folders under `baseDir` whose relative path begins with
// `query`, returning sorted candidate strings (dirs get a trailing '/'). The
// query is split into a directory part and a filename prefix; only the filename
// prefix is matched at entry level so partial names like "src/ma" match
// "src/main.cpp". An empty query lists every entry directly under baseDir.
inline std::vector<std::string> completePaths(const std::string& baseDir,
                                              const std::string& query) {
    namespace fs = std::filesystem;
    std::vector<std::string> out;

    fs::path base(baseDir);
    fs::path q(query);
    const std::string filename = q.filename().string();
    const fs::path searchDir = base / q.parent_path();

    std::error_code ec;
    if (!fs::is_directory(searchDir, ec)) return out;

    for (fs::directory_iterator it(searchDir, ec);
         it != fs::directory_iterator();
         it.increment(ec)) {
        const fs::directory_entry& entry = *it;
        std::string name = entry.path().filename().string();
        if (!filename.empty() && !pathStartsWith(name, filename)) continue;
        fs::path rel = q.parent_path() / name;
        std::string cand = rel.generic_string();
        if (entry.is_directory(ec)) cand += "/";
        out.push_back(std::move(cand));
    }

    std::sort(out.begin(), out.end());
    return out;
}

} // namespace pie::gui
