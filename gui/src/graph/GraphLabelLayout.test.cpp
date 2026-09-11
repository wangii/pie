// Headless regression tests for the GraphView label clip geometry.
#include "graph/GraphLabelLayout.h"

#include <cstdio>
#include <string>

using namespace pie::gui;

static int failures = 0;
static void check(bool condition, const char* message) {
    if (!condition) {
        std::fprintf(stderr, "FAIL: %s\n", message);
        ++failures;
    }
}

int main() {
    const GraphRect node{120.0f, 240.0f, 200.0f, 60.0f};
    const std::string labels[] = {
        "a deliberately long Propose label that must be clipped",
        "Plan",
        "Distill",
    };
    for (const std::string& label : labels) {
        (void)label;
        const GraphRect clip = nodeLabelClipRect(node);
        check(clip.x == node.x && clip.y == node.y &&
              clip.w == node.w && clip.h == node.h,
              "label clip matches the owning node rect");
    }
    // ---------------------------------------------------------------------
    // Accent bars: the CURRENT marker keeps its position, and the focus bar
    // follows it so the two never overlap.
    // ---------------------------------------------------------------------
    const float currentBarW = 4.0f;
    const float focusBarW = 4.0f;
    {
        const NodeAccentBars none = nodeAccentBars(node, false, false, currentBarW, focusBarW);
        check(none.current.w == 0.0f, "no current -> no current bar");
        check(none.focus.w == 0.0f, "no focus -> no focus bar");
    }
    {
        const NodeAccentBars only = nodeAccentBars(node, false, true, currentBarW, focusBarW);
        check(only.current.w == 0.0f, "focus alone -> no current bar");
        check(only.focus.x == node.x, "focus alone sits at the node's left edge");
        check(only.focus.w == focusBarW && only.focus.h == node.h, "focus bar spans the node height");
    }
    {
        const NodeAccentBars both = nodeAccentBars(node, true, true, currentBarW, focusBarW);
        check(both.current.x == node.x && both.current.w == currentBarW, "current bar keeps its position");
        check(both.focus.x == node.x + currentBarW, "focus bar is offset past the current bar");
        check(both.focus.x >= both.current.x + both.current.w, "the two bars do not overlap");
        check(both.focus.w == focusBarW, "focus bar keeps its own width");
    }
    {
        const NodeAccentBars currentOnly = nodeAccentBars(node, true, false, currentBarW, focusBarW);
        check(currentOnly.current.w == currentBarW, "current alone draws the current bar");
        check(currentOnly.focus.w == 0.0f, "current alone draws no focus bar");
    }

    std::printf("graph label layout test: %s\n", failures == 0 ? "PASS" : "FAIL");
    return failures == 0 ? 0 : 1;
}
