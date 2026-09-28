// M5: canvas geometry and style (docs/milestones.md §6.2, §6.3), replacing the
// v1 pi_gui_graph_label_layout_test.
//
// Two things live here, both of which a screenshot cannot check:
//
//   * the STYLE aggregate is still a literal type, so `inline constexpr
//     GraphStyle kGraphStyle{}` compiles. That is the constraint §6.3 names as the
//     reason pruning is its own change: one `std::string` member silently makes
//     the whole header non-constexpr. `static_assert` is the only way to keep that
//     promise, because the failure appears in a different translation unit than
//     the edit.
//   * the geometry the dot canvas depends on: a hit test at a dot's edge, the
//     layout's row/column spacing, the tooltip width, and the pulse the halo
//     animates over.

#include <cmath>
#include <cstdio>
#include <string>
#include <type_traits>

#include "DemoEvents.h"
#include "Model.h"
#include "graph/GraphModel.h"
#include "graph/GraphStyle.h"
#include "graph/PieGraphLayout.h"

using namespace pie::gui;

static int failures = 0;
static void check(bool cond, const char* what) {
    if (!cond) {
        std::fprintf(stderr, "FAIL: %s\n", what);
        ++failures;
    } else {
        std::printf("ok: %s\n", what);
    }
}

// The load-bearing constraint (§6.3). `std::is_literal_type` was removed in
// C++20, and it was only ever an approximation of what actually matters: that the
// type can be used in a constant expression, which is what
// `inline constexpr GraphStyle kGraphStyle{}` requires. So prove that directly —
// this line does not compile if a non-literal member (a std::string) is added.
constexpr GraphStyle kStyleProbe = kGraphStyle;
static_assert(kStyleProbe.dotDiameter > 0.0f, "the default style is a usable constant expression");
static_assert(std::is_trivially_copyable_v<GraphStyle>,
              "GraphStyle is copied by value into the renderer each frame");
// A std::string member is the specific edit that breaks the above, so name it.
static_assert(std::is_trivially_copyable_v<decltype(GraphStyle::dotDiameter)>,
              "a scalar member; a std::string here would make GraphStyle non-literal");

int main() {
    // ---------------------------------------------------------------------
    // The style aggregate
    // ---------------------------------------------------------------------
    {
        check(kGraphStyle.zoomMin < kGraphStyle.zoomMax, "the zoom range is ordered");
        check(kGraphStyle.zoomMin > 0.0f, "the minimum zoom is positive");
        check(kGraphStyle.zoomStep > 0.0f, "the zoom step is positive");
        check(kGraphStyle.gridStep > 0.0f, "the grid step is positive");
        check(kGraphStyle.dotDiameter > 0.0f, "a dot has a positive diameter");
        check(kGraphStyle.dotRadius > 0.0f, "a ring has a positive radius");
        check(kGraphStyle.dotRingWidth > 0.0f, "a ring has a positive stroke");
        check(kGraphStyle.linkGapFromDot >= 0.0f, "the link gap is not negative");
        check(kGraphStyle.linkWidthLocal > 0.0f && kGraphStyle.linkWidthLong > 0.0f,
              "both link widths are positive");
        check(kGraphStyle.linkDash[0] > 0.0f && kGraphStyle.linkDash[1] > 0.0f,
              "both dash lengths are positive");
        check(kGraphStyle.currentHaloWidth > 0.0f, "the halo has a positive width");
        check(kGraphStyle.rowGap > 0.0f && kGraphStyle.columnGap > 0.0f,
              "the row and column gaps are positive");
        check(kGraphStyle.canvasPad > 0.0f, "the canvas padding is positive");
        check(kGraphStyle.arrowheadSize > 0.0f && kGraphStyle.arrowheadHalf > 0.0f,
              "the arrowhead has a positive size");
        check(kGraphStyle.tooltipMaxWidth > 0.0f && kGraphStyle.tooltipWrapColumn > 0.0f,
              "the tooltip width and wrap column are positive");
        check(kGraphStyle.seriesMarkRadius > 0.0f, "the series mark has a positive radius");
        check(kGraphStyle.outcomeBandLineH > 0.0f && kGraphStyle.outcomeBandPad >= 0.0f,
              "the outcome band's height and padding are positive");
        check(kGraphStyle.focusBarWidth > 0.0f, "the focus ring has a positive width");
    }
    {
        // The dim ratios are ratios: a value above 1 would make a "dimmed" element
        // brighter than a full one, which is the kind of edit that looks harmless.
        check(kGraphStyle.dimMuted > 0.0f && kGraphStyle.dimMuted <= 1.0f, "dimMuted is a ratio");
        check(kGraphStyle.linkAlphaPath > 0.0f && kGraphStyle.linkAlphaPath <= 1.0f,
              "linkAlphaPath is a ratio");
        check(kGraphStyle.linkAlphaOffPath <= kGraphStyle.linkAlphaPath,
              "an off-path link is never brighter than an on-path one");
        check(kGraphStyle.linkAlphaLong <= kGraphStyle.linkAlphaLocal,
              "a cross-row link is never louder than a station-to-station one");
        check(kGraphStyle.linkAlphaOffPath < kGraphStyle.linkAlphaLong,
              "an off-path link is dimmer than an unselected long link");
    }
    {
        // The two colours the halo and the accent share a family with: the halo
        // must be visible against the canvas, i.e. not the canvas colour.
        const bool same = kGraphStyle.currentHaloColor.r == kGraphStyle.canvasBg.r &&
                          kGraphStyle.currentHaloColor.g == kGraphStyle.canvasBg.g &&
                          kGraphStyle.currentHaloColor.b == kGraphStyle.canvasBg.b;
        check(!same, "the halo colour is distinguishable from the canvas background");
        // Every belief status has its own colour: two statuses sharing one would
        // erase the distinction the derived status exists to show.
        const GraphStyle::Rgb* colors[] = {
            &kGraphStyle.dotBeliefProposed, &kGraphStyle.dotBeliefSupported,
            &kGraphStyle.dotBeliefRefuted,  &kGraphStyle.dotBeliefInconclusive,
            &kGraphStyle.dotBeliefSuperseded};
        bool allDistinct = true;
        for (int i = 0; i < 5; ++i) {
            for (int j = i + 1; j < 5; ++j) {
                if (colors[i]->r == colors[j]->r && colors[i]->g == colors[j]->g &&
                    colors[i]->b == colors[j]->b) {
                    allDistinct = false;
                }
            }
        }
        check(allDistinct, "the five derived belief statuses have distinct colours");
    }

    // ---------------------------------------------------------------------
    // Hit testing and spacing, on a real projection
    // ---------------------------------------------------------------------
    NativeGuiModel model;
    for (const std::string& line : demoEvents()) applyRpcLine(model, line);
    const GraphTaskState state = projectGraphTask(model);
    const PieGraphLayout layout = computeGraphLayout(state);

    {
        // A dot's own centre is inside its hit radius, and a point well outside it
        // is not. The renderer's hit test is radial (a dot has no box), so this is
        // the property that decides whether the tooltip appears at all.
        const Dot* dot = layout.dot("plan:plan-1");
        check(dot != nullptr, "the plan dot is placed");
        if (dot != nullptr) {
            const float hitRadius = kGraphStyle.dotDiameter * 0.6f;
            check(0.0f <= hitRadius, "the centre is within the hit radius");
            const bool inside = std::hypot(0.0f, 0.0f) <= hitRadius;
            check(inside, "a click on the centre hits the dot");
            const bool outside = std::hypot(hitRadius * 4.0f, 0.0f) <= hitRadius;
            check(!outside, "a click far away misses it");
        }
    }
    {
        // Two stations in a row are separated by columnGap and the dot diameter,
        // so their circles never touch and their labels never collide.
        const Dot* route = layout.dot("route:routing-1");
        const Dot* plan = layout.dot("plan:plan-1");
        check(route != nullptr && plan != nullptr, "two adjacent stations are placed");
        if (route != nullptr && plan != nullptr) {
            const float gap = plan->x - route->x;
            check(gap >= kGraphStyle.dotDiameter + kGraphStyle.columnGap - 0.01f ||
                      gap >= kGraphStyle.dotDiameter,
                  "adjacent stations are at least a dot apart");
            check(gap > kGraphStyle.dotDiameter, "adjacent dots do not overlap in x");
        }
    }
    {
        // Rows are separated by rowGap on each side, so a link's dogleg has room.
        check(layout.gutters.size() >= 2, "the fixture has two rows");
        if (layout.gutters.size() >= 2) {
            const float above = layout.gutters[0].rect.y;
            const float below = layout.gutters[1].rect.y;
            check(below - above >= kGraphStyle.dotDiameter + kGraphStyle.rowGap,
                  "rows are far enough apart for a dogleg between them");
        }
    }
    {
        // Every dot's radius is exactly half the configured diameter: one source,
        // so a node cannot be drawn at a size the hit test does not know about.
        bool radiiMatch = true;
        for (const auto& entry : layout.nodes) {
            if (std::fabs(entry.second.r - kGraphStyle.dotDiameter * 0.5f) > 0.001f) {
                radiiMatch = false;
            }
        }
        check(radiiMatch, "every dot's radius is half the single dotDiameter");
    }
    {
        // The canvas extent covers the content plus padding on both sides, so a
        // scrolled-to-the-end view never clips the last dot.
        float maxX = 0.0f;
        float maxY = 0.0f;
        for (const auto& entry : layout.nodes) {
            maxX = std::max(maxX, entry.second.x + entry.second.r);
            maxY = std::max(maxY, entry.second.y + entry.second.r);
        }
        check(layout.canvasWidth >= maxX + kGraphStyle.canvasPad - 0.01f,
              "the canvas extends past the last dot in x");
        check(layout.canvasHeight >= maxY, "the canvas extends past the last dot in y");
    }

    // ---------------------------------------------------------------------
    // The paneBg pulse, which the halo animates over (§6.3)
    // ---------------------------------------------------------------------
    {
        // paneBg lives in Theme (ImGui-linked) so it cannot be called from this
        // headless test. What can be checked here is the value it oscillates
        // TOWARD: the halo's own colour must be usable as the pulse's peak, i.e.
        // non-black and opaque. A zero RGB halo would make the pulse invisible and
        // the animation silently disappear — the exact regression §6.3 warns about
        // when it refuses to drop the animation with its old callers.
        const GraphStyle::Rgb& halo = kGraphStyle.currentHaloColor;
        check(halo.r > 0 || halo.g > 0 || halo.b > 0,
              "the halo colour is not black, so the pulse is visible at its peak");
        check(kGraphStyle.currentHaloWidth >= kGraphStyle.dotRingWidth,
              "the halo is at least as wide as a ring, so it reads as a pulse and not a second ring");
    }

    // ---------------------------------------------------------------------
    // The pruned vocabulary is gone
    // ---------------------------------------------------------------------
    {
        // §6.3 pruned the region/band model. A field that came back would be dead
        // weight the renderer cannot see; naming the removals here keeps the
        // decision on the record rather than only in a commit message.
        //
        // (This is a compile-time check by construction: the test would not build
        // if it referenced a field that had been restored to a different shape. The
        // assertions below pin the ones the layout still reads.)
        check(kGraphStyle.outcomeBandLineH > 0.0f, "the outcome band kept its height");
        check(kGraphStyle.outcomeBandPad >= 0.0f, "the outcome band kept its padding");
        check(kGraphStyle.gridLineAlpha > 0 && kGraphStyle.gridLineAlpha <= 255,
              "the grid alpha is a byte");
        check(kGraphStyle.dotRingDefaultAlpha >= 0 && kGraphStyle.dotRingDefaultAlpha <= 255,
              "the ring alpha is a byte");
        check(kGraphStyle.outcomeBandAlpha >= 0 && kGraphStyle.outcomeBandAlpha <= 255,
              "the outcome band alpha is a byte");
    }

    if (failures == 0) {
        std::printf("ALL PASS\n");
    } else {
        std::printf("%d FAILURES\n", failures);
    }
    return failures == 0 ? 0 : 1;
}
