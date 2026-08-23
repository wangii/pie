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
// derived from the minimum lane width (three side-by-side lanes + padding).
// `kMinWindowHeight` is derived from a reference row height and the band
// multipliers used in computeLayout (header 1.2, nav 1.0, summary 2.0) plus
// the minimum lane height and padding margins.
inline constexpr float kMinLaneWidth = 120.0f;
inline constexpr float kMinLaneHeight = 100.0f;
inline constexpr float kPad = 8.0f;
inline constexpr float kRefRowHeight = 24.0f;  // reference font-row height
inline constexpr float kMinWindowWidth = kMinLaneWidth * 3.0f + kPad * 2.0f;  // 360 + 16
inline constexpr float kMinWindowHeight =
    kRefRowHeight * (1.2f + 1.0f + 2.0f) + kMinLaneHeight + kPad * 5.0f;  // 100.8 + 100 + 40

struct LayoutMetrics {
    float pad = 8.0f;
    float headerH = 0.0f;   // status bar
    float navH = 0.0f;      // frame navigator
    float summaryH = 0.0f;  // current-frame summary
    float laneH = 0.0f;     // lanes (main content)

    float minLaneH = kMinLaneHeight;
    float minLaneW = kMinLaneWidth;
    float laneFracLeft = 0.27f;
    float laneFracMid = 0.36f;
};

// Compute region heights for a window of height `winH` and a font-row height
// `rowH`.
inline LayoutMetrics computeLayout(float winW, float winH, float rowH) {
    LayoutMetrics m;
    m.headerH = rowH * 1.2f;
    m.navH = rowH * 1.0f;
    m.summaryH = rowH * 2.0f;

    float availH = std::max(0.0f, winH - (m.headerH + m.navH + m.summaryH + m.pad * 5));
    m.laneH = std::max(m.minLaneH, availH);
    return m;
}

// Return the stacked (one-column) lane rects when the window is too narrow.
// Returns true if the lanes fit side-by-side (3 columns), false if stacked.
inline bool laneRects(const LayoutMetrics& m, float winW, float& left, float& mid, float& right, bool& stacked) {
    float availW = std::max(0.0f, winW - m.pad * 2);
    left = availW * m.laneFracLeft;
    mid = availW * m.laneFracMid;
    right = std::max(0.0f, availW - left - mid);
    stacked = availW < m.minLaneW * 3;
    return !stacked;
}

} // namespace pie::gui
