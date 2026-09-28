// M9: the shell geometry (docs/milestones.md §4), replacing pi_gui_layout_test.
//
// The invariants asserted here are the ones `AGENTS.md` states as rules and that
// a screenshot cannot check: no two regions overlap at ANY window size, nothing
// escapes the work area, a closed panel occupies nothing, the canvas keeps its
// minimum or the layout stacks, and the two cases are the only two.
//
// It is a sweep rather than a handful of cases on purpose: a layout bug lives at
// one window size, and the size that breaks is never the one that was typed into
// the test.

#include <cstdio>
#include <string>

#include "ShellLayout.h"

using namespace pie::gui;

static int failures = 0;
static void check(bool cond, const std::string& what) {
    if (!cond) {
        std::fprintf(stderr, "FAIL: %s\n", what.c_str());
        ++failures;
    } else {
        std::printf("ok: %s\n", what.c_str());
    }
}

static bool overlaps(const Rect& a, const Rect& b) {
    if (a.empty() || b.empty()) return false;
    const bool disjoint = a.right() <= b.x + 0.001f || b.right() <= a.x + 0.001f ||
                          a.bottom() <= b.y + 0.001f || b.bottom() <= a.y + 0.001f;
    return !disjoint;
}

static bool inside(const Rect& r, float w, float h) {
    if (r.empty()) return true;
    return r.x >= -0.001f && r.y >= -0.001f && r.right() <= w + 0.001f && r.bottom() <= h + 0.001f;
}

static std::string describe(const Rect& r) {
    char buf[96];
    std::snprintf(buf, sizeof(buf), "(x=%.0f y=%.0f w=%.0f h=%.0f)", r.x, r.y, r.w, r.h);
    return buf;
}

int main() {
    const float rowH = kRefRowHeight;

    // ---------------------------------------------------------------------
    // The minimum window size, with nothing open
    // ---------------------------------------------------------------------
    {
        PanelState panels;
        const ShellLayout layout = computeShellLayout(kMinWindowWidth, kMinWindowHeight, rowH, panels);
        check(!layout.stacked, "with no panel open there is nothing to stack");
        check(inside(layout.header, kMinWindowWidth, kMinWindowHeight), "the header fits");
        check(inside(layout.canvas, kMinWindowWidth, kMinWindowHeight), "the canvas fits");
        check(inside(layout.footer, kMinWindowWidth, kMinWindowHeight), "the footer fits");
        check(!overlaps(layout.header, layout.canvas), "the header does not overlap the canvas");
        check(!overlaps(layout.canvas, layout.footer), "the canvas does not overlap the footer");
        check(layout.header.bottom() <= layout.canvas.y + 0.001f, "the header is above the canvas");
        check(layout.canvas.bottom() <= layout.footer.y + 0.001f, "the canvas is above the footer");
        check(layout.beliefPanel.empty() && layout.tracePanel.empty() && layout.framePane.empty(),
              "a closed panel occupies nothing");
        check(layout.canvas.w >= kMinCanvasWidth, "the canvas keeps its minimum width");
        check(layout.canvas.h >= kMinCanvasHeight, "the canvas keeps its minimum height");
        check(layout.footer.bottom() <= kMinWindowHeight + 0.001f, "the footer is the last band");
    }

    // ---------------------------------------------------------------------
    // A sweep: every panel combination, at every window size
    // ---------------------------------------------------------------------
    {
        const float widths[] = {kMinWindowWidth, 480.0f, 640.0f, 900.0f, 1440.0f, 2560.0f};
        const float heights[] = {kMinWindowHeight, 320.0f, 600.0f, 1200.0f};
        int cases = 0;
        int stackedCases = 0;
        bool allDisjoint = true;
        bool allInside = true;
        bool allOrdered = true;
        bool allCanvasMin = true;
        std::string firstFailure;

        // Every combination of the three docked panels.
        for (int mask = 0; mask < 8; ++mask) {
            PanelState panels;
            panels.setOpen(PanelId::BeliefList, (mask & 1) != 0);
            panels.setOpen(PanelId::DispatchTrace, (mask & 2) != 0);
            panels.setOpen(PanelId::FrameControl, (mask & 4) != 0);
            for (float w : widths) {
                for (float h : heights) {
                    ++cases;
                    const ShellLayout layout = computeShellLayout(w, h, rowH, panels);
                    if (layout.stacked) ++stackedCases;

                    Rect rects[6] = {layout.header,   layout.canvas,    layout.footer,
                                     layout.beliefPanel, layout.tracePanel, layout.framePane};
                    for (int i = 0; i < 6; ++i) {
                        if (!inside(rects[i], w, h)) {
                            allInside = false;
                            if (firstFailure.empty()) {
                                firstFailure = "outside the work area at " + std::to_string(int(w)) + "x" +
                                               std::to_string(int(h)) + " mask " + std::to_string(mask) + " " +
                                               describe(rects[i]);
                            }
                        }
                        for (int j = i + 1; j < 6; ++j) {
                            if (overlaps(rects[i], rects[j])) {
                                allDisjoint = false;
                                if (firstFailure.empty()) {
                                    firstFailure = "overlap at " + std::to_string(int(w)) + "x" +
                                                   std::to_string(int(h)) + " mask " + std::to_string(mask) + " " +
                                                   describe(rects[i]) + " vs " + describe(rects[j]);
                                }
                            }
                        }
                    }
                    // The vertical order of the three bands holds everywhere.
                    if (!(layout.header.bottom() <= layout.canvas.y + 0.001f &&
                          layout.canvas.bottom() <= layout.footer.y + 0.001f)) {
                        allOrdered = false;
                    }
                    // The canvas is never squeezed below its minimum: the layout
                    // stacks first.
                    if (layout.canvas.w < kMinCanvasWidth - 0.001f) allCanvasMin = false;
                    // A closed panel is zero-sized at every size.
                    if (!panels.isOpen(PanelId::BeliefList) && !layout.beliefPanel.empty()) allDisjoint = false;
                    if (!panels.isOpen(PanelId::DispatchTrace) && !layout.tracePanel.empty()) allDisjoint = false;
                    if (!panels.isOpen(PanelId::FrameControl) && !layout.framePane.empty()) allDisjoint = false;
                }
            }
        }
        check(allDisjoint, "no two regions overlap at any size or panel combination");
        check(allInside, "every region stays inside the work area");
        check(allOrdered, "the header, canvas and footer keep their order");
        check(allCanvasMin, "the canvas is never narrower than its minimum");
        check(cases == 8 * 6 * 4, "the sweep covered every combination");
        check(stackedCases > 0, "the sweep reached the stacked case");
        check(stackedCases < cases, "and the side-by-side case too");
        if (!firstFailure.empty()) std::fprintf(stderr, "  first failure: %s\n", firstFailure.c_str());
        std::printf("  swept %d layouts, %d stacked\n", cases, stackedCases);
    }

    // ---------------------------------------------------------------------
    // Side by side: an open panel takes width FROM the canvas
    // ---------------------------------------------------------------------
    {
        PanelState closed;
        const ShellLayout withoutPanel = computeShellLayout(1200, 800, rowH, closed);
        PanelState one;
        one.setOpen(PanelId::BeliefList, true);
        const ShellLayout withPanel = computeShellLayout(1200, 800, rowH, one);
        check(!withPanel.stacked, "1200px holds a canvas and a panel");
        check(withPanel.beliefPanel.w > 0.0f, "the open panel has a rectangle");
        check(withPanel.canvas.w < withoutPanel.canvas.w,
              "the panel takes width from the canvas rather than floating over it");
        check(withPanel.canvas.x == withoutPanel.canvas.x,
              "and the canvas keeps its left edge, so the graph does not jump when a panel opens");
        check(withPanel.beliefPanel.x >= withPanel.canvas.right(),
              "the panel sits to the right of the canvas");
        check(withPanel.beliefPanel.h == withPanel.canvas.h, "and shares the canvas row's height");
    }

    // ---------------------------------------------------------------------
    // Stacking: too narrow for both, so the panels move below
    // ---------------------------------------------------------------------
    {
        PanelState panels;
        panels.setOpen(PanelId::FrameControl, true);
        const ShellLayout layout = computeShellLayout(kMinWindowWidth, kMinWindowHeight, rowH, panels);
        check(layout.stacked, "the minimum window width cannot hold both, so it stacks");
        check(layout.framePane.y >= layout.canvas.bottom(), "the panel is below the canvas");
        check(layout.framePane.w > 0.0f && layout.framePane.h > 0.0f,
              "and at the minimum window size it is still big enough to read");
        check(layout.canvas.h >= kMinCanvasHeight, "the canvas keeps its minimum height too");
        check(layout.framePane.bottom() <= layout.footer.y + 0.001f, "the stack stops above the footer");
    }

    // ---------------------------------------------------------------------
    // The stacked canvas is the full row width
    // ---------------------------------------------------------------------
    {
        PanelState panels;
        panels.setOpen(PanelId::BeliefList, true);
        panels.setOpen(PanelId::DispatchTrace, true);
        const ShellLayout layout = computeShellLayout(500, 400, rowH, panels);
        check(layout.stacked, "two panels at 500px stack");
        check(layout.beliefPanel.w == layout.tracePanel.w, "stacked panels share the row width");
        check(layout.beliefPanel.y != layout.tracePanel.y, "and are stacked, not side by side");
        check(layout.tracePanel.y > layout.beliefPanel.y, "in the order the shell places them");
        // When the panels cannot have their own column, the canvas gets the whole
        // row back: stacking is not just moving the panels, it is giving the graph
        // the width they were competing for.
        check(layout.canvas.w == layout.beliefPanel.w,
              "the stacked canvas takes the full row width back");
        check(layout.beliefPanel.y > layout.canvas.bottom(), "and the panels are under it");
    }

    // ---------------------------------------------------------------------
    // The font row drives the bands
    // ---------------------------------------------------------------------
    {
        PanelState panels;
        const ShellLayout small = computeShellLayout(1000, 800, 18.0f, panels);
        const ShellLayout large = computeShellLayout(1000, 800, 36.0f, panels);
        check(large.header.h > small.header.h, "a bigger font row makes a taller header");
        check(large.footer.h > small.footer.h, "and a taller footer");
        check(large.canvas.h < small.canvas.h, "which comes out of the canvas, not out of the window");
    }

    // ---------------------------------------------------------------------
    // Degenerate sizes do not produce negative rectangles
    // ---------------------------------------------------------------------
    {
        PanelState panels;
        panels.setOpen(PanelId::BeliefList, true);
        panels.setOpen(PanelId::DispatchTrace, true);
        panels.setOpen(PanelId::FrameControl, true);
        for (float w : {0.0f, 1.0f, 40.0f, 200.0f}) {
            for (float h : {0.0f, 1.0f, 30.0f, 120.0f}) {
                const ShellLayout layout = computeShellLayout(w, h, rowH, panels);
                const Rect rects[6] = {layout.header,      layout.canvas,    layout.footer,
                                       layout.beliefPanel, layout.tracePanel, layout.framePane};
                bool nonNegative = true;
                for (const Rect& r : rects) {
                    if (r.w < 0.0f || r.h < 0.0f) nonNegative = false;
                    if (r.x < -0.001f || r.y < -0.001f) nonNegative = false;
                }
                check(nonNegative, "a tiny window produces no negative rectangle at " +
                                       std::to_string(int(w)) + "x" + std::to_string(int(h)));
            }
        }
    }

    // ---------------------------------------------------------------------
    // Determinism: the same inputs give the same layout
    // ---------------------------------------------------------------------
    {
        PanelState panels;
        panels.setOpen(PanelId::DispatchTrace, true);
        const ShellLayout a = computeShellLayout(1100, 700, rowH, panels);
        const ShellLayout b = computeShellLayout(1100, 700, rowH, panels);
        check(a.canvas.x == b.canvas.x && a.canvas.y == b.canvas.y && a.canvas.w == b.canvas.w &&
                  a.canvas.h == b.canvas.h,
              "two identical inputs give an identical canvas, so nothing reflows between frames");
        check(a.tracePanel.x == b.tracePanel.x && a.tracePanel.h == b.tracePanel.h,
              "and an identical panel rectangle");
    }

    // ---------------------------------------------------------------------
    // The panel set
    // ---------------------------------------------------------------------
    {
        PanelState panels;
        check(panels.openCount() == 0, "a fresh shell opens no docked panel");
        panels.setOpen(PanelId::FileList, true);
        check(panels.openCount() == 0,
              "the file list is a floating picker: it is open but takes no canvas width");
        const ShellLayout layout = computeShellLayout(1000, 800, rowH, panels);
        check(layout.panel(PanelId::FileList) == nullptr, "and has no docked rectangle");
        check(layout.panel(PanelId::BeliefList) == &layout.beliefPanel,
              "while a docked panel's rectangle is addressable by id");        panels.setOpen(PanelId::BeliefList, true);
        check(panels.openCount() == 1, "a docked panel is counted");
        panels.toggle(PanelId::BeliefList);
        check(panels.openCount() == 0 && !panels.isOpen(PanelId::BeliefList), "and toggling closes it");
        check(kMinWindowWidth >= kMinCanvasWidth + kMinPanelWidth,
              "the minimum window width is at least a canvas and a panel");
        check(kMinWindowHeight >= kMinCanvasHeight + kMinStackedPanelHeight,
              "and the minimum height is at least a canvas and a stacked panel");
    }

    if (failures == 0) {
        std::printf("ALL PASS\n");
    } else {
        std::printf("%d FAILURES\n", failures);
    }
    return failures == 0 ? 0 : 1;
}
