// Headless tests for the "@" mention parsing and path completion helpers in
// PathComplete.h. No window, no ImGui.

#include "PathComplete.h"

#include <chrono>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <string>
#include <vector>

using pie::gui::applyMention;
using pie::gui::completePaths;
using pie::gui::findMention;

static int failures = 0;
static void check(bool cond, const char* what) {
    if (!cond) { std::fprintf(stderr, "FAIL: %s\n", what); ++failures; }
    else std::printf("ok: %s\n", what);
}

int main() {
    // --- findMention ---
    {
        auto c = findMention("go @src/ma", 10);
        check(c.active, "mention after @ is active");
        check(c.ampPos == 3, "@ index located");
        check(c.query == "src/ma", "query is the text after @ up to cursor");
    }
    {
        auto c = findMention("go @", 4);
        check(c.active && c.ampPos == 3 && c.query.empty(),
              "bare @ (empty query) is an active mention");
    }
    {
        auto c = findMention("email foo@bar", 13);
        check(!c.active, "@ mid-token is not a mention");
    }
    {
        auto c = findMention("no mention", 10);
        check(!c.active, "no @ is not a mention");
    }
    {
        auto c = findMention("", 0);
        check(!c.active, "empty buffer is not a mention");
    }
    {
        auto c = findMention("after @src rest", 10);
        check(c.active && c.query == "src", "mention at word boundary after space");
    }

    // --- completePaths against a scratch tree ---
    namespace fs = std::filesystem;
    const auto base = fs::temp_directory_path() /
                      ("pi_gui_path_test_" +
                       std::to_string(std::chrono::steady_clock::now()
                                          .time_since_epoch()
                                          .count()));
    fs::create_directories(base / "src");
    { std::ofstream(base / "README.md") << ""; }
    { std::ofstream(base / "src" / "main.cpp") << ""; }
    { std::ofstream(base / "src" / "main.txt") << ""; }
    { std::ofstream(base / "src" / "util.cpp") << ""; }

    {
        auto v = completePaths(base.string(), "README");
        check(v.size() == 1 && v[0] == "README.md",
              "filename-prefix match returns exact path");
    }
    {
        auto v = completePaths(base.string(), "src/ma");
        check(v.size() == 2 && v[0] == "src/main.cpp" && v[1] == "src/main.txt",
              "directory+prefix match returns the two main.* files");
    }
    {
        auto v = completePaths(base.string(), "src/");
        check(v.size() == 3 && v[0] == "src/main.cpp" && v[2] == "src/util.cpp",
              "trailing slash lists the directory contents");
    }
    {
        auto v = completePaths(base.string(), "src");
        check(v.size() == 1 && v[0] == "src/",
              "bare dir name resolves to a trailing-slash dir candidate");
    }
    {
        auto v = completePaths(base.string(), "nonexistent");
        check(v.empty(), "no match returns nothing");
    }
    {
        auto v = completePaths(base.string(), "");
        check(v.size() == 2 && v[0] == "README.md" && v[1] == "src/",
              "empty query lists base directory entries (sorted)");
    }

    fs::remove_all(base);

    // --- applyMention: one Tab-driven cycle-and-insert step ---
    {
        // Buffer "go @src/ma", cursor at index 12 (after 'a'), mention @ at 3.
        const std::string text = "go @src/ma";
        const auto ctx = findMention(text, 12);
        check(ctx.active && ctx.ampPos == 3 && ctx.query == "src/ma",
              "applyMention context: src/ma mention located");
        const std::vector<std::string> cands = {"src/main.cpp", "src/main.txt"};
        const auto m0 = applyMention(text, ctx, cands, 0);
        check(m0.activeIndex == 0 && m0.text == "go @src/main.cpp" && m0.cursor == 16,
              "applyMention index0 replaces query with first candidate");
        const auto m1 = applyMention(text, ctx, cands, 1);
        check(m1.activeIndex == 1 && m1.text == "go @src/main.txt" && m1.cursor == 16,
              "applyMention index1 replaces query with second candidate");
        // Repeat-Tab semantics: re-apply from the already-completed buffer, so
        // cycling answers "@src/main.cpp" -> "@src/main.txt" -> "@src/main.cpp".
        const auto back = applyMention(m0.text, findMention(m0.text, m0.cursor), cands, 1);
        check(back.text == "go @src/main.txt" && back.cursor == 16,
              "applyMention cycles from an already-inserted candidate");
    }

    if (failures == 0) std::printf("ALL PASS\n");
    else std::printf("%d FAILURES\n", failures);
    return failures == 0 ? 0 : 1;
}
