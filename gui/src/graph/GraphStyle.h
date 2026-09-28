// GraphStyle: the canvas's single visual style entry point.
//
// One governable place for every spacing / colour / dim-ratio / arrow / size
// literal the canvas uses. Headless and ImGui-free: colours are rgb triples
// (uint8_t) so the config compiles into the model layer and can be asserted
// without a window; the UI layer converts them with IM_COL32.
//
// The default instance `kGraphStyle` is the single source of truth: the headless
// layout reads its geometry and the renderer reads its colours, so the two cannot
// drift.
//
// NEVER ADD A `std::string` MEMBER. `inline constexpr GraphStyle kGraphStyle{}`
// requires a literal type, and a std::string member makes the type non-literal —
// which breaks the single default instance and every `constexpr` reader at once.
// If a string is ever needed here, it belongs beside the style, not inside it.
//
// PRUNED FOR THE DOT CANVAS (§6.3). The v1 style carried a region/band vocabulary:
// `*RegionFill` / `*RegionLabel` / `regionFillAlpha` for the titled boxes the old
// layout drew, `frame*` for the LoopFrame container, `cardTextPad*`, `nodeW/H`,
// `columnHeaderHeight`, `phaseBandGap`, `routingTextSlotH`, `peripheryGap`,
// `pointsPerInch`. A dot-and-link canvas has no boxes, no headers and no bands, so
// every one of those is gone rather than left unread. What survived was renamed
// for the same reason: `indicatorRadius` became `dotRadius`, `cardBorderWidth`
// became `dotRingWidth`, and the `edge*Width` / `edge*` colour block became the
// `link*` block, because "edge" named a graph-theory relation and "link" names
// what is drawn.

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
    float gridStep = 32.0f;  // base grid spacing (multiplied by zoom at draw)
    float zoomMin = 0.3f;
    float zoomMax = 2.5f;
    float zoomStep = 0.1f;
    Rgb canvasBg{24, 26, 30};
    Rgb gridLine{44, 48, 54};
    int gridLineAlpha = 90;

    // --- Dot geometry ---
    // A node's whole geometry is a centre and a radius. There is no width or
    // height: the v1 200x60 card is gone.
    float dotDiameter = 14.0f;
    // The ring drawn around a dot to mark selection / the current station.
    float dotRadius = 7.0f;
    float dotRingWidth = 2.0f;
    // A link stops this far short of the dot's edge, so the arrowhead is legible
    // rather than buried in the ring.
    float linkGapFromDot = 3.0f;

    // --- Link geometry ---
    // Two dash lengths (on, off) for a link to a record this delta introduced.
    // Two floats rather than a std::vector so the aggregate stays constexpr.
    float linkDash[2] = {5.0f, 4.0f};
    float linkWidthLocal = 1.6f;   // station-to-station
    float linkWidthLong = 1.1f;    // cross-row / rail-bound
    float arrowheadSize = 7.0f;
    float arrowheadHalf = 3.6f;

    // --- Node colours, by family ---
    Rgb dotDefault{120, 126, 136};
    Rgb dotRow{96, 104, 118};
    Rgb dotRouting{150, 190, 210};
    Rgb dotSelection{176, 208, 224};
    Rgb dotPlan{104, 168, 238};
    Rgb dotDistillation{190, 126, 224};
    Rgb dotDelta{220, 180, 140};
    Rgb dotIntervention{238, 184, 74};
    Rgb dotRecheck{140, 200, 190};
    Rgb dotFormulation{112, 205, 126};

    // --- Execution colours, by terminal status ---
    Rgb dotExecutionRunning{238, 184, 74};
    Rgb dotExecutionOk{104, 204, 120};
    Rgb dotExecutionFailed{220, 96, 90};
    Rgb dotExecutionCancelled{150, 150, 150};

    // --- Belief colours, by DERIVED status ---
    // The status is never stored; it is derived from provenance with the
    // precedence superseded > refuted > supported > inconclusive > proposed, so
    // these five are the complete set.
    Rgb dotBeliefProposed{88, 132, 200};
    Rgb dotBeliefSupported{104, 204, 120};
    Rgb dotBeliefRefuted{220, 96, 90};
    Rgb dotBeliefInconclusive{150, 150, 150};
    Rgb dotBeliefSuperseded{190, 150, 70};

    // --- Rings ---
    Rgb dotRingDefault{70, 76, 86};
    Rgb dotRingSelected{240, 240, 240};
    // The cursor's station. The halo below pulses; this is the steady ring.
    Rgb dotRingCurrent{88, 166, 255};
    int dotRingDefaultAlpha = 140;

    // --- The current-node halo (the one approved animation, §6.3) ---
    // The v1 paneBg pulse highlighted the active pane's background. Its callers
    // were the three lanes and App.cpp, all removed; the animation itself was
    // approved by the user and is not dropped. It now draws as a ring around the
    // cursor's station, over the same black <-> halo-peak sinusoid.
    float currentHaloWidth = 5.0f;
    Rgb currentHaloColor{88, 166, 255};

    // --- Task focus accent ---
    float focusBarWidth = 3.0f;
    Rgb focusAccent{110, 200, 220};

    // --- Task outcome band ---
    float outcomeBandLineH = 34.0f;
    float outcomeBandPad = 8.0f;
    int outcomeBandAlpha = 30;
    Rgb outcomeBandFill{70, 96, 120};
    Rgb outcomeLabel{200, 216, 232};
    Rgb outcomeBlockers{238, 184, 74};

    // --- Dim ratios ---
    float dimMuted = 0.35f;           // a node unrelated to the selection
    float linkAlphaPath = 0.95f;      // a link on the highlighted path
    float linkAlphaOffPath = 0.16f;   // a link off it, while something is selected
    float linkAlphaLong = 0.45f;      // a cross-row link with nothing selected
    float linkAlphaLocal = 0.85f;     // a station-to-station link

    // --- Link colours, by semantic type ---
    Rgb linkPlanToExecution{104, 168, 238};
    Rgb linkExecutionToDistillation{170, 140, 220};
    Rgb linkDistillationToDelta{190, 126, 224};
    Rgb linkDeltaToBelief{104, 204, 120};
    Rgb linkBeliefToDelta{220, 180, 140};
    Rgb linkSourceToFormulation{112, 205, 126};
    Rgb linkVersionToVersion{150, 190, 210};
    Rgb linkRecheckToEpisode{140, 200, 190};
    Rgb linkMuted{90, 94, 100};

    // --- Text ---
    Rgb textBody{214, 218, 224};
    Rgb textMuted{150, 156, 164};
    Rgb accent{88, 166, 255};

    // --- Tooltip ---
    // Every node family now has one, so the width and the wrap column are what
    // keep a long plan intent readable.
    float tooltipMaxWidth = 520.0f;
    float tooltipWrapColumn = 76.0f;

    // --- Belief rail series mark ---
    // A small mark beside a belief dot showing how many rounds carried it. A mark,
    // not a node: never hit-tested, never a layout input.
    float seriesMarkRadius = 3.0f;

    // --- Layout / routing geometry ---
    float rowGap = 48.0f;      // vertical gap between episode rows
    float columnGap = 40.0f;   // horizontal gap between stations / rail entries
    float canvasPad = 28.0f;
};

// The single default style instance. Shared by the headless layout / routing
// modules and the ImGui renderer.
inline constexpr GraphStyle kGraphStyle{};

} // namespace pie::gui
