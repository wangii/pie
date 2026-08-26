// Headless tests for the user prompt palette input box autogrow height logic
// in PaletteMetrics.h. No window, no ImGui.

#include "PaletteMetrics.h"

#include <cstdio>
#include <cstring>

using pie::gui::paletteInputBoxHeight;
using pie::gui::paletteScrollAtBottom;
using pie::gui::paletteScrollByPage;
using pie::gui::paletteTrailingEmptyLines;

static int failures = 0;
static void check(bool cond, const char* what) {
    if (!cond) { std::fprintf(stderr, "FAIL: %s\n", what); ++failures; }
    else std::printf("ok: %s\n", what);
}

int main() {
    const float lineH = 20.0f;
    const float framePad = 8.0f;  // padding.y * 2

    // --- trailing newline detection ---
    check(paletteTrailingEmptyLines(nullptr) == 0, "null buffer -> no extra line");
    check(paletteTrailingEmptyLines("") == 0, "empty buffer -> no extra line");
    check(paletteTrailingEmptyLines("hello") == 0, "no trailing newline -> no extra line");
    check(paletteTrailingEmptyLines("hello\n") == 1, "trailing newline -> one extra line");
    check(paletteTrailingEmptyLines("hello\n\n") == 1, "only one trailing empty line reserved");

    // --- minimum height (one line) ---
    {
        float h = paletteInputBoxHeight(0.0f, lineH, framePad, 0);
        check(h == lineH + framePad, "empty/wrapped-0 content shows one line");
    }

    // --- grows with wrapped content ---
    {
        float h1 = paletteInputBoxHeight(0.0f, lineH, framePad, 0);
        float h2 = paletteInputBoxHeight(lineH * 1.5f, lineH, framePad, 0);  // content exceeding one line
        float h3 = paletteInputBoxHeight(lineH * 2.0f, lineH, framePad, 0);  // two wrapped lines
        check(h2 > h1, "wrapped content exceeding baseline is taller than minimum");
        check(h3 > h2, "more wrapped lines taller than fewer");
    }

    // --- trailing newline reserves one extra line ---
    {
        float base = paletteInputBoxHeight(lineH, lineH, framePad, 0);
        float withExtra = paletteInputBoxHeight(lineH, lineH, framePad, 1);
        check(withExtra == base + lineH, "trailing newline adds exactly one line");
    }

    // --- negative extraLines clamped (no shrink below content) ---
    {
        float base = paletteInputBoxHeight(lineH, lineH, framePad, 0);
        float clamped = paletteInputBoxHeight(lineH, lineH, framePad, -5);
        check(clamped == base, "negative extraLines clamped to zero");
    }

    // --- page scroll: clamped in [0, maxScroll] ---
    {
        const float maxScroll = 100.0f;
        const float step = 20.0f;
        check(paletteScrollByPage(20.0f, step, maxScroll, -1) == 0.0f, "scroll up clamps at 0");
        check(paletteScrollByPage(80.0f, step, maxScroll, +1) == 100.0f, "scroll down clamps at maxScroll");
        check(paletteScrollByPage(50.0f, step, maxScroll, +1) == 70.0f, "scroll down advances one page");
        check(paletteScrollByPage(50.0f, step, maxScroll, -1) == 30.0f, "scroll up retreats one page");
        check(paletteScrollByPage(50.0f, step, maxScroll, 0) == 50.0f, "zero direction leaves offset unchanged");
        check(paletteScrollByPage(150.0f, step, maxScroll, +1) == 100.0f, "scroll down above max clamps to max");
        check(paletteScrollByPage(50.0f, step, maxScroll, -1) == 30.0f, "scroll up stays non-negative");
    }

    // --- at-bottom: epsilon test ---
    {
        check(paletteScrollAtBottom(100.0f, 100.0f), "at maxScroll is at bottom");
        check(paletteScrollAtBottom(99.5f, 100.0f), "within epsilon of maxScroll is at bottom");
        check(!paletteScrollAtBottom(50.0f, 100.0f), "mid-scroll is not at bottom");
        check(paletteScrollAtBottom(0.0f, 0.0f), "content that fits is at bottom");
    }

    if (failures == 0) std::printf("ALL PASS\n");
    else std::printf("%d FAILURES\n", failures);
    return failures == 0 ? 0 : 1;
}
