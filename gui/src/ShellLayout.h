// ShellLayout: the workspace's panel geometry (docs/milestones.md §4).
//
// Pure logic, ImGui-free, so the layout invariants `AGENTS.md` states are
// testable without a window: the vertical bands stack in a fixed order and never
// overlap, heights derive from the font row rather than from pixel constants, an
// open side panel takes width AWAY from the canvas instead of floating over it,
// and when the window is too narrow for both, the panels move below the canvas.
//
// It replaces `LayoutMetrics` and its three-lane geometry (M1 removed the lanes;
// the constants below are what survived). `kMinWindowWidth`/`kMinWindowHeight`
// remain the single source of truth the platform's minimum-size hint reads.

#pragma once

#include <algorithm>

namespace pie::gui {

// The one rectangle type, kept here because this is where the geometry is
// computed (it used to live in LayoutMetrics.h, which M9 deleted).
struct Rect {
    float x = 0, y = 0, w = 0, h = 0;
    float right() const { return x + w; }
    float bottom() const { return y + h; }
    bool empty() const { return w <= 0.0f || h <= 0.0f; }
};

// The panels that can be open, in the order they appear when docked. The Frame
// pane is deliberately NOT here: it moved wholly into the floating window
// (FramePane.h), so it holds no docked rectangle and competes with the canvas for
// no width. FileList is listed only so its floating toggle has an id.
enum class PanelId { BeliefList, DispatchTrace, FileList, Count };
inline constexpr int kPanelCount = static_cast<int>(PanelId::Count);

inline constexpr float kPad = 8.0f;
// A docked panel narrower than this shows nothing worth reading.
inline constexpr float kMinPanelWidth = 140.0f;
// The canvas below this stops being a graph and becomes a viewport onto nothing,
// so the layout stacks the panels instead of shrinking it further.
inline constexpr float kMinCanvasWidth = 260.0f;
inline constexpr float kMinCanvasHeight = 120.0f;
inline constexpr float kRefRowHeight = 24.0f;  // reference font-row height
// The footer carries one line of per-role telemetry.
inline constexpr float kFooterRows = 1.2f;
// The header carries the status band.
inline constexpr float kHeaderRows = 1.0f;
// A stacked panel at the minimum window size. The window's minimum height is
// built to fit the canvas AND one of these, so opening a panel at the smallest
// allowed window does not produce an empty rectangle.
inline constexpr float kMinStackedPanelHeight = 80.0f;

// Single source of truth for the minimum window size: the canvas, its padding,
// and one docked panel. A window at the minimum is NOT wide enough for canvas and
// panel side by side, which is exactly the case `stacked` exists for.
inline constexpr float kMinWindowWidth = kMinCanvasWidth + kMinPanelWidth + kPad * 3.0f;
inline constexpr float kMinWindowHeight = kRefRowHeight * (kHeaderRows + kFooterRows) +
                                          kMinCanvasHeight + kMinStackedPanelHeight + kPad * 3.0f;

// Which panels the user has open, and how much width each asks for. The fractions
// are of the WINDOW, so a panel keeps its share when the window grows.
struct PanelState {
    // Belief list and dispatch trace closed by default; the file list is a picker
    // the user opens deliberately.
    bool open[kPanelCount] = {false, false, false};
    float beliefListFrac = 0.30f;
    float traceFrac = 0.36f;

    bool isOpen(PanelId id) const { return open[static_cast<int>(id)]; }
    // The flag itself, for the one panel whose renderer owns its own open/closed
    // state: the file list is a floating window with a close button, so its
    // renderer takes the flag by reference rather than being told what to draw.
    bool& openFlag(PanelId id) { return open[static_cast<int>(id)]; }
    void setOpen(PanelId id, bool value) { open[static_cast<int>(id)] = value; }
    void toggle(PanelId id) { open[static_cast<int>(id)] = !open[static_cast<int>(id)]; }
    int openCount() const {
        int count = 0;
        for (int i = 0; i < kPanelCount; ++i) {
            // The file list is a floating picker with no docked rectangle, so it
            // does not consume canvas width and is not counted here.
            if (i == static_cast<int>(PanelId::FileList)) continue;
            if (open[i]) ++count;
        }
        return count;
    }
};

struct ShellLayout {
    Rect header, canvas, footer;
    // Zero-sized when the panel is closed, so a caller can render unconditionally
    // and let an empty rectangle mean "nothing to draw".
    Rect beliefPanel, tracePanel;
    // True when the panels are below the canvas: the window is too narrow for
    // canvas and panel side by side.
    bool stacked = false;

    Rect* panel(PanelId id) {
        switch (id) {
            case PanelId::BeliefList: return &beliefPanel;
            case PanelId::DispatchTrace: return &tracePanel;
            case PanelId::FileList:
            case PanelId::Count: return nullptr;
        }
        return nullptr;
    }
    const Rect* panel(PanelId id) const {
        switch (id) {
            case PanelId::BeliefList: return &beliefPanel;
            case PanelId::DispatchTrace: return &tracePanel;
            case PanelId::FileList:
            case PanelId::Count: return nullptr;
        }
        return nullptr;
    }
};

// The docked panels, in the order they are placed. The file list is absent on
// purpose: it is a floating picker. So is the Frame pane, which is now the
// floating window itself.
inline constexpr PanelId kDockedPanels[] = {PanelId::BeliefList, PanelId::DispatchTrace};
inline constexpr int kDockedPanelCount = 2;

// Compute the workspace geometry for a window of size `winW` x `winH` and a font
// row of `rowH`. Deterministic: identical inputs give an identical layout, so the
// canvas never reflows between two frames with no new data.
inline ShellLayout computeShellLayout(float winW, float winH, float rowH,
                                      const PanelState& panels) {
    ShellLayout layout;
    const float w = std::max(0.0f, winW);
    const float h = std::max(0.0f, winH);
    const float row = std::max(1.0f, rowH);

    layout.header = Rect{0.0f, 0.0f, w, row * kHeaderRows};
    const float footerH = row * kFooterRows;
    layout.footer = Rect{0.0f, std::max(0.0f, h - footerH), w, footerH};

    // The row between the bands, inset so a panel's scrollbar is not against the
    // window edge.
    const float rowX = kPad;
    const float rowW = std::max(0.0f, w - kPad * 2.0f);
    const float rowY = layout.header.bottom() + kPad;
    const float rowHgt =
        std::max(0.0f, layout.footer.y - kPad - rowY);

    float frac[kDockedPanelCount] = {panels.beliefListFrac, panels.traceFrac};
    for (float& value : frac) value = std::clamp(value, 0.0f, 1.0f);

    const int openCount = panels.openCount();
    float demanded = 0.0f;
    for (int i = 0; i < kDockedPanelCount; ++i) {
        if (panels.isOpen(kDockedPanels[i])) demanded += w * frac[i];
    }
    const float gapTotal = kPad * static_cast<float>(openCount + (openCount > 0 ? 1 : 0));
    const float sideBySideCanvas = rowW - demanded - gapTotal;
    layout.stacked = openCount > 0 && sideBySideCanvas < kMinCanvasWidth;

    if (!layout.stacked) {
        // Canvas on the left, panels to its right. The canvas keeps the window's
        // left edge, so the graph does not move when a panel opens.
        const float canvasW = std::max(0.0f, sideBySideCanvas);
        layout.canvas = Rect{rowX, rowY, canvasW, rowHgt};
        float x = layout.canvas.right() + kPad;
        for (int i = 0; i < kDockedPanelCount; ++i) {
            Rect* rect = layout.panel(kDockedPanels[i]);
            if (rect == nullptr || !panels.isOpen(kDockedPanels[i])) continue;
            const float panelW = std::min(std::max(w * frac[i], kMinPanelWidth), std::max(0.0f, w - x - kPad));
            *rect = Rect{x, rowY, panelW, rowHgt};
            x += panelW + kPad;
        }
        return layout;
    }

    // Stacked: the canvas keeps the top of the row and every open panel takes an
    // equal share of what is left, one under the other. Every rectangle stays
    // inside the window — the panels scroll INTERNALLY rather than the stack
    // running off the bottom, because a rect outside the work area is the one
    // layout outcome `AGENTS.md` forbids outright.
    const int stackCount = std::max(1, openCount);
    const float stackGaps = kPad * static_cast<float>(stackCount);
    const float availableForAll = std::max(0.0f, rowHgt - stackGaps);
    // The canvas' minimum wins when the two cannot both be satisfied: a graph
    // squeezed below its minimum is not a smaller graph, it is an unusable one,
    // while a short panel still scrolls.
    const float canvasH = std::min(availableForAll, std::max(kMinCanvasHeight, availableForAll * 0.55f));
    layout.canvas = Rect{rowX, rowY, rowW, canvasH};

    const float each = std::max(0.0f, (availableForAll - canvasH) / static_cast<float>(stackCount));
    float y = layout.canvas.bottom() + kPad;
    for (int i = 0; i < kDockedPanelCount; ++i) {
        Rect* rect = layout.panel(kDockedPanels[i]);
        if (rect == nullptr || !panels.isOpen(kDockedPanels[i])) continue;
        *rect = Rect{rowX, y, rowW, each};
        y += each + kPad;
    }
    return layout;
}

} // namespace pie::gui
