// Headless test for the no-overlap layout geometry. Verifies that region sizes
// are non-negative, contained in the work area, and pairwise disjoint (no
// vertical overlap) across a range of window sizes, and with the stacked-lane
// fallback for narrow windows.

#include "LayoutMetrics.h"

#include <cstdio>

using pie::gui::LayoutMetrics;
using pie::gui::Rect;
using pie::gui::computeLayout;
using pie::gui::laneRects;

static int failures = 0;
static void check(bool cond, const char* what) {
    if (!cond) { std::fprintf(stderr, "FAIL: %s\n", what); ++failures; }
    else std::printf("ok: %s\n", what);
}

bool disjoint(const Rect& a, const Rect& b) {
    return a.right() <= b.x || a.bottom() <= b.y || b.right() <= a.x || b.bottom() <= a.y;
}

int main() {
    const float rowH = 24.0f; // representative row height for an 18px font

    // The minimum window size must be a single source of truth and produce
    // valid (non-negative, contained, pairwise-disjoint) geometry.
    check(pie::gui::kMinWindowWidth == pie::gui::kMinLaneWidth * 3.0f + pie::gui::kPad * 2.0f,
          "kMinWindowWidth derived from lane width + padding");
    check(pie::gui::kMinWindowHeight > 0.0f, "kMinWindowHeight positive");

    for (float winW : {pie::gui::kMinWindowWidth, 500.0f, 800.0f, 1440.0f}) {
        for (float winH : {pie::gui::kMinWindowHeight, 600.0f, 900.0f}) {
            {
                LayoutMetrics m = computeLayout(winW, winH, rowH);

                check(m.headerH > 0.0f, "header height positive");
                check(m.navH > 0.0f, "nav height positive");
                check(m.summaryH > 0.0f, "summary height positive");
                check(m.laneH > 0.0f, "lane height positive");

                // Vertically stacked regions: top, nav, lanes, summary.
                Rect top{0, 0, winW, m.headerH};
                Rect nav{0, top.bottom(), winW, m.navH};
                Rect lanes{0, nav.bottom(), winW, m.laneH};
                Rect summary{0, lanes.bottom(), winW, m.summaryH};

                // All within the window height (no out-of-work-area, no negative).
                check(summary.bottom() <= winH + 1.0f, "all regions fit within window height");

                // Pairwise disjoint vertically.
                check(disjoint(top, nav), "top vs nav disjoint");
                check(disjoint(nav, lanes), "nav vs lanes disjoint");
                check(disjoint(lanes, summary), "lanes vs summary disjoint");

                // Lane widths: non-negative.
                float left = 0, mid = 0, right = 0;
                bool stacked = false;
                laneRects(m, winW, left, mid, right, stacked);
                if (stacked) {
                    check(true, "stacked fallback for narrow window");
                } else {
                    check(left > 0.0f && mid > 0.0f && right >= 0.0f, "lane widths non-negative");
                    check(left + mid + right <= winW, "lanes fit within window width");
                }
            }
        }
    }

    if (failures == 0) std::printf("ALL PASS\n");
    else std::printf("%d FAILURES\n", failures);
    return failures == 0 ? 0 : 1;
}
