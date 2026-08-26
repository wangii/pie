// GraphStyle: central Graph View visual style (Phase 2 M9).
//
// A single, governable entry point for every spacing / typography / border /
// dim-ratio / arrow / padding / size literal that used to be scattered through
// GraphView.cpp (and the layout / routing geometry constants in PieGraphLayout
// and GraphRouting). Headless and ImGui-free: colors are rgb triples (uint8_t)
// so the config compiles into the headless model layer and can be asserted
// without a window; the UI layer converts them to ImU32 via IM_COL32.
//
// The default instance `kGraphStyle` is the single source of truth. A viewer
// (GraphView) reads from it rather than hardcoding values, so a future style
// tweak is one place, not a sweep of literals.

#pragma once

#include <cstdint>

namespace pie::gui {

struct GraphStyle {
    struct Rgb {
        std::uint8_t r = 0;
        std::uint8_t g = 0;
        std::uint8_t b = 0;
    };

    // --- Canvas / grid ---
    float gridStep = 32.0f;      // base grid spacing (multiplied by zoom at draw)
    float zoomMin = 0.3f;
    float zoomMax = 2.5f;
    float zoomStep = 0.08f;
    Rgb canvasBg{18, 18, 22};
    Rgb gridLine{50, 52, 60};
    int gridLineAlpha = 70;

    // --- Node card ---
    float cardRadius = 4.0f;
    float cardBorderWidth = 1.5f;   // drawn width scaled by zoom
    float cardTextPadX = 8.0f;
    float cardTextPadY = 6.0f;
    float currentBarWidth = 4.0f;
    Rgb cardSelected{60, 90, 135};
    Rgb cardCurrent{80, 60, 140};
    Rgb cardBelief{58, 88, 96};
    Rgb cardBeliefFalsified{120, 50, 50};
    Rgb cardBeliefRevised{110, 95, 50};
    Rgb cardBeliefClosed{70, 70, 76};
    Rgb cardPlan{52, 78, 108};
    Rgb cardExecOk{48, 110, 70};
    Rgb cardExecFailed{120, 48, 48};
    Rgb cardExecRunning{60, 72, 92};
    Rgb cardDistill{96, 66, 116};
    Rgb cardDefault{60, 65, 78};
    Rgb borderSelected{255, 176, 50};
    Rgb borderCurrent{150, 90, 240};
    Rgb borderDefault{120, 130, 145};
    int borderDefaultAlpha = 220;
    Rgb textBody{230, 235, 240};
    Rgb currentAccent{255, 200, 90};

    // --- Dim ratios (selection / dependency query) ---
    float dimMuted = 0.38f;       // node alpha when outside the dependency set
    float edgeAlphaPath = 0.9f;   // route on the selected dependency path
    float edgeAlphaOffPath = 0.25f;
    float edgeAlphaLongDefault = 0.45f;
    float edgeAlphaLocalDefault = 0.6f;

    // --- Edges ---
    float edgeWidthLong = 1.6f;   // * zoom at draw
    float edgeWidthLocal = 2.0f;  // * zoom at draw
    int edgeMutedAlphaScale = 70; // alpha denominator for the muted edge color
    Rgb edgeBeliefToPlan{200, 180, 90};
    Rgb edgePlanToExecution{120, 180, 220};
    Rgb edgeExecutionToDistill{150, 220, 160};
    Rgb edgeDistillToBelief{220, 140, 220};
    Rgb edgeMuted{90, 95, 100};
    float arrowheadSize = 8.0f;   // base length along the direction
    float arrowheadHalf = 4.0f;   // half-width across the direction
    float opGlyphRadius = 9.0f;
    Rgb opGlyphFill{220, 140, 220};
    int opGlyphFillAlpha = 230;
    Rgb opGlyphText{30, 30, 30};

    // --- Frame container / navigation header ---
    float frameRadius = 6.0f;
    float frameBorderWidth = 1.5f;  // * zoom at draw
    float frameLabelPadX = 6.0f;
    float frameLabelPadY = 4.0f;
    Rgb frameBorder{80, 90, 110};
    int frameBorderAlpha = 110;
    Rgb frameLabel{170, 185, 200};
    int frameLabelAlpha = 200;

    // --- Layout / routing geometry (sizes) ---
    float nodeW = 200.0f;
    float nodeH = 60.0f;
    float pointsPerInch = 72.0f;
    float framePad = 12.0f;
    float frameGap = 120.0f;
    float peripheryGap = 40.0f;
};

// The single default style instance. Shared by the headless layout / routing
// modules and the ImGui renderer.
inline constexpr GraphStyle kGraphStyle{};

} // namespace pie::gui
