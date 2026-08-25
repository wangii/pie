// Pure, ImGui-free helpers for the instruction palette input box autogrow
// height and the belief lane color legend. Headless so they can be unit-tested
// without a window or ImGui.
//
// The instruction input box is an ImGui::InputTextMultiline. Its height must
// grow as the buffer soft-wraps past the available width. ImGui::CalcTextSize
// measures the wrapped text height but its `y` ignores a trailing newline, so
// the palette must reserve one extra line when the buffer ends in a newline
// (the cursor sits on a fresh empty line). These helpers isolate that logic.

#pragma once

#include <algorithm>
#include <cstddef>
#include <cstring>

namespace pie::gui {

// Number of extra empty lines to reserve beyond the measured wrapped height.
// A trailing newline places the cursor on an empty line that CalcTextSize.y
// does not count, so it costs one additional line. Non-newline-terminated
// buffers incur no extra line.
inline int paletteTrailingEmptyLines(const char* buf) {
    if (!buf) return 0;
    const std::size_t len = std::strlen(buf);
    if (len > 0 && buf[len - 1] == '\n') return 1;
    return 0;
}

// Compute the auto-grow height of the instruction input box.
//   wrappedY   - wrapped text height measured by ImGui::CalcTextSize at the
//                widget width (its `y` ignores a trailing newline).
//   lineH      - height of one text line.
//   framePad   - vertical frame padding (already doubled: padding.y * 2).
//   extraLines - number of additional empty lines to reserve (see
//                paletteTrailingEmptyLines).
// The box always shows at least one line (plus padding), and grows with the
// wrapped content plus any reserved trailing line.
inline float paletteInputBoxHeight(float wrappedY, float lineH, float framePad, int extraLines) {
    float h = std::max(lineH + framePad, wrappedY + framePad);
    h += static_cast<float>(std::max(0, extraLines)) * lineH;
    return h;
}

// Clamp the in-message scroll offset after a one-page manual scroll.
//   scrollY   - current scroll offset (in [0, maxScroll]).
//   step      - page height (the child's visible height).
//   maxScroll - maximum scroll offset (0 when the content fits).
//   direction - +1 scroll down, -1 scroll up, 0 leaves it unchanged.
// Returns the clamped offset in [0, maxScroll].
inline float paletteScrollByPage(float scrollY, float step, float maxScroll, int direction) {
    if (direction > 0) return std::min(scrollY + step, maxScroll);
    if (direction < 0) return std::max(scrollY - step, 0.0f);
    return scrollY;
}

// True when a scroll offset has reached (or is within epsilon of) the bottom of
// the region, i.e. the last content line is visible.
inline bool paletteScrollAtBottom(float scrollY, float maxScroll, float epsilon = 1.0f) {
    return maxScroll - scrollY <= epsilon;
}

} // namespace pie::gui
