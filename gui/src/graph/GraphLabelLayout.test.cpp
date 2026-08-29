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
    std::printf("graph label layout test: %s\n", failures == 0 ? "PASS" : "FAIL");
    return failures == 0 ? 0 : 1;
}
