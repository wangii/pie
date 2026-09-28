#include "graph/PieGraphLayout.h"

#include <algorithm>
#include <cmath>

#include "graph/GraphStyle.h"

namespace pie::gui {

namespace {

// The rail bands sit above the rows; the rows stack under them. Every constant is
// read from kGraphStyle so the headless layout and the renderer cannot drift.
constexpr float kRowLabelWidth = 46.0f;  // the "Ep1" gutter label's column

float beliefRailWidth() { return kGraphStyle.dotDiameter + kGraphStyle.columnGap * 2.0f; }

// The x of the n-th station in a row, relative to the row's content start.
float stationX(size_t index) {
    return kRowLabelWidth + static_cast<float>(index) * (kGraphStyle.dotDiameter + kGraphStyle.columnGap);
}

} // namespace

const Dot* PieGraphLayout::dot(const std::string& nodeId) const {
    const auto it = nodes.find(nodeId);
    return it == nodes.end() ? nullptr : &it->second;
}

PieGraphLayout computeGraphLayout(const GraphTaskState& state) {
    PieGraphLayout out;
    const float pad = kGraphStyle.canvasPad;
    const float diameter = kGraphStyle.dotDiameter;
    const float radius = diameter * 0.5f;

    // --- the Frame rail ---------------------------------------------------
    // Left to right in ordinal order. It spans the content width, above the
    // beliefs and the rows, because a version is task-scoped: it is read by rounds
    // that sit below it.
    float railY = pad + radius;
    size_t versionIndex = 0;
    for (const GraphRailVersion& version : state.versions) {
        const std::string nodeKey = "Fv:" + version.id;
        const GraphNode* node = state.node(nodeKey);
        if (node == nullptr) continue;
        Dot dot;
        dot.x = pad + kRowLabelWidth + static_cast<float>(versionIndex) * (diameter + kGraphStyle.columnGap);
        dot.y = railY;
        dot.r = radius;
        out.nodes[nodeKey] = dot;
        ++versionIndex;
    }
    if (versionIndex == 0) {
        // No versions: the rail still gets a band so the rows below start at a
        // stable y. A zero-height band would make the first row's position depend
        // on whether a reading happened to exist yet, which is exactly the reflow
        // the deterministic contract forbids.
        out.versionRail = GraphRect{pad, pad, 0.0f, diameter};
    } else {
        out.versionRail = GraphRect{pad, pad, static_cast<float>(versionIndex) * (diameter + kGraphStyle.columnGap),
                                    diameter};
    }

    const float railBandH = pad + diameter + kGraphStyle.rowGap;

    // --- the belief rail --------------------------------------------------
    // A vertical column on the far left (§6.1: "belief rail (global, left)"),
    // ordered by creation order. A belief is not owned by a row: it outlives the
    // round that first wrote it, which is why a delta -> belief edge is allowed to
    // cross rows.
    float beliefX = pad + radius;
    float beliefY = railBandH + pad + radius;
    size_t beliefCount = 0;
    for (const GraphNode& node : state.nodes) {
        if (node.family != NodeFamily::Belief) continue;
        Dot dot;
        dot.x = beliefX;
        dot.y = beliefY + static_cast<float>(beliefCount) * (diameter + kGraphStyle.rowGap);
        dot.r = radius;
        out.nodes[node.id.value] = dot;
        ++beliefCount;
    }
    out.beliefRail = GraphRect{pad, railBandH + pad, beliefCount == 0 ? 0.0f : diameter,
                               static_cast<float>(beliefCount) * (diameter + kGraphStyle.rowGap)};

    // --- episode rows -----------------------------------------------------
    // Top to bottom in ordinal order. A row's height is fixed by its widest
    // station count, so adding a node to a row does not move the rows below it
    // more than that row's own growth.
    const float rowsX = pad + beliefRailWidth() + kGraphStyle.columnGap;
    float rowY = railBandH + pad + radius;
    if (beliefCount > 0) {
        const float beliefRailHeight =
            static_cast<float>(beliefCount) * (diameter + kGraphStyle.rowGap);
        rowY = std::max(rowY, railBandH + pad + radius + beliefRailHeight);
    }

    out.gutters = state.rows;
    for (EpisodeGutter& gutter : out.gutters) {
        // Stations in this row, in station order (the projection already assigned
        // `order`; ties break on the node id so the layout is total).
        std::vector<const GraphNode*> rowNodes;
        for (const GraphNode& node : state.nodes) {
            if (node.episodeId != gutter.id) continue;
            rowNodes.push_back(&node);
        }
        // The row anchor is drawn in the gutter, not among the stations.
        std::stable_sort(rowNodes.begin(), rowNodes.end(),
                         [](const GraphNode* a, const GraphNode* b) {
                             if (a->order != b->order) return a->order < b->order;
                             return a->id.value < b->id.value;
                         });

        size_t station = 0;
        for (const GraphNode* node : rowNodes) {
            Dot dot;
            dot.r = radius;
            if (node->family == NodeFamily::EpisodeRow) {
                dot.x = rowsX - kRowLabelWidth * 0.5f;
                dot.y = rowY;
                out.nodes[node->id.value] = dot;
                continue;
            }
            dot.x = rowsX + stationX(station);
            dot.y = rowY;
            out.nodes[node->id.value] = dot;
            ++station;
        }
        const float rowWidth = stationX(station == 0 ? 1 : station);
        gutter.rect = GraphRect{rowsX, rowY - radius - kGraphStyle.rowGap * 0.5f, rowWidth,
                                diameter + kGraphStyle.rowGap};
        rowY += diameter + kGraphStyle.rowGap * 2.0f;
    }

    // --- the outcome band -------------------------------------------------
    // Task scope, not row content: it sits below the last row and never inside one.
    if (state.taskOutcome.present) {
        const float bandY = rowY - kGraphStyle.rowGap;
        out.outcomeBand = GraphRect{pad, bandY, rowsX + stationX(6) - pad,
                                    kGraphStyle.outcomeBandLineH + kGraphStyle.outcomeBandPad * 2.0f};
    }

    // --- canvas extent ----------------------------------------------------
    // Positive even when empty: a zero-sized canvas makes a consumer's division by
    // it undefined, and "nothing to draw" is a state the app does render.
    float maxX = 0.0f;
    float maxY = 0.0f;
    for (const auto& entry : out.nodes) {
        maxX = std::max(maxX, entry.second.x + entry.second.r);
        maxY = std::max(maxY, entry.second.y + entry.second.r);
    }
    maxX = std::max(maxX, out.versionRail.x + out.versionRail.w);
    maxX = std::max(maxX, out.beliefRail.x + out.beliefRail.w);
    for (const EpisodeGutter& gutter : out.gutters) {
        maxX = std::max(maxX, gutter.rect.x + gutter.rect.w);
        maxY = std::max(maxY, gutter.rect.y + gutter.rect.h);
    }
    maxY = std::max(maxY, out.outcomeBand.y + out.outcomeBand.h);
    out.canvasWidth = std::max(maxX + pad, kGraphStyle.canvasPad * 2.0f + diameter);
    out.canvasHeight = std::max(maxY + pad, kGraphStyle.canvasPad * 2.0f + diameter);
    return out;
}

} // namespace pie::gui
