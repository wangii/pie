// Headless tests for the instruction palette input box autogrow height logic
// in PaletteMetrics.h. No window, no ImGui.

#include "PaletteMetrics.h"

#include <cstdio>
#include <cstring>

using pie::gui::paletteInputBoxHeight;
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

    if (failures == 0) std::printf("ALL PASS\n");
    else std::printf("%d FAILURES\n", failures);
    return failures == 0 ? 0 : 1;
}
