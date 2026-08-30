// Pure layout geometry for the PIE Native GUI main workspace. Computed from
// window size, a font-row height, and padding. It is ImGui-free so the region
// rectangles can be unit-tested for non-negativity, containment in the work
// area, and pairwise disjointness.

#pragma once

#include <algorithm>

namespace pie::gui {

struct Rect {
    float x = 0, y = 0, w = 0, h = 0;
    float right() const { return x + w; }
    float bottom() const { return y + h; }
};

// Single source of truth for the minimum window size. `kMinWindowWidth` is
// derived from the minimum lane width and padding.
// `kMinWindowHeight` is derived from a reference row height and the band
// multipliers used in computeLayout (header 1.2, footer 1.6, summary 2.0) plus
// the minimum lane height and padding margins.
//
// The frame navigator is no longer rendered, so its band (nav 1.0) and one
// region boundary are omitted from both the height budget and computeLayout;
// the lanes reclaim that vertical space.
inline constexpr float kMinLaneWidth = 120.0f;
inline constexpr float kMinLaneHeight = 100.0f;
inline constexpr float kPad = 8.0f;
inline constexpr float kRefRowHeight = 24.0f;  // reference font-row height
inline constexpr float kMinWindowWidth = kMinLaneWidth * 3.0f + kPad * 2.0f;  // 360 + 16
inline constexpr float kMinWindowHeight =
    kRefRowHeight * (1.2f + 2.0f + 1.6f) + kMinLaneHeight + kPad * 4.0f;  // 115.2 + 100 + 32

struct LayoutMetrics {
    float pad = 8.0f;
    float headerH = 0.0f;   // status bar
    float summaryH = 0.0f;  // current-frame summary
    float footerH = 0.0f;   // bottom footer (model/cache/cost telemetry)
    float laneH = 0.0f;     // lanes (main content)

    float minLaneH = kMinLaneHeight;
};

// Compute region heights for a window of height `winH` and a font-row height
// `rowH`.
inline LayoutMetrics computeLayout(float winW, float winH, float rowH) {
    LayoutMetrics m;
    m.headerH = (rowH * 2.) * 1.2f;
    m.summaryH = rowH;

    // Footer is a compact row at the very bottom; budget a couple of font rows
    // (one per line of the per-phase model/cache summary plus the cost line).
    m.footerH = rowH * 1.2f;

    float availH = std::max(0.0f, winH - (m.headerH + m.summaryH + m.footerH + m.pad * 4));
    m.laneH = std::max(m.minLaneH, availH);
    return m;
}

} // namespace pie::gui
