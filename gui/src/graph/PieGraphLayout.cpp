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

    // --- the task-level vertical time sequence ----------------------------
    // A task is made of episode tracks and Frame versions, and they share ONE
    // top-to-bottom axis ordered by when they happened: an episode by the time it
    // opened, a version by when it was recorded. When either time is absent (a
    // snapshot carries no per-record time) the pair compares by the boundary
    // ordinal it belongs to, which reproduces the pre-time-axis placement; the
    // mixed case is therefore deterministic rather than reflowing.
    struct TaskEntry {
        bool isFrame = false;
        int64_t atMs = -1;
        uint64_t boundary = 0;  // episode ordinal, or the version's formedInEpisodeOrdinal
        uint64_t ordinal = 0;   // the record's own ordinal
        size_t index = 0;       // into state.rows / state.versions
        std::string id;
    };
    std::vector<TaskEntry> entries;
    entries.reserve(state.rows.size() + state.versions.size());
    for (size_t i = 0; i < state.rows.size(); ++i) {
        TaskEntry e;
        e.isFrame = false;
        e.atMs = state.rows[i].occurredAtMs;
        e.boundary = state.rows[i].ordinal;
        e.ordinal = state.rows[i].ordinal;
        e.index = i;
        e.id = state.rows[i].id;
        entries.push_back(std::move(e));
    }
    for (size_t i = 0; i < state.versions.size(); ++i) {
        TaskEntry e;
        e.isFrame = true;
        e.atMs = state.versions[i].occurredAtMs;
        e.boundary = state.versions[i].formedInEpisodeOrdinal;
        e.ordinal = state.versions[i].ordinal;
        e.index = i;
        e.id = state.versions[i].id;
        entries.push_back(std::move(e));
    }
    // ONE uniform lexicographic key: (time, boundary, episode-before-frame,
    // ordinal, id). A missing time is the explicit sentinel -1, so it is compared
    // as a time rather than dropping the whole sequence back to boundary order:
    // a known time ALWAYS decides the order of two timed entries, even when some
    // other entry has no time. Comparing the time first is also what keeps the
    // comparator transitive — A(t=1000,b=3), B(t=2000,b=1), C(untimed,b=2) yields
    // C(-1) < A < B, never the C<A, B<C, A<B cycle of a per-pair time/boundary
    // switch. A state whose times are all absent (a snapshot) collapses to the
    // boundary order, so it still renders as it did before the time axis existed.
    std::stable_sort(entries.begin(), entries.end(), [](const TaskEntry& a, const TaskEntry& b) {
        if (a.atMs != b.atMs) return a.atMs < b.atMs;
        if (a.boundary != b.boundary) return a.boundary < b.boundary;
        if (a.isFrame != b.isFrame) return !a.isFrame;
        if (a.ordinal != b.ordinal) return a.ordinal < b.ordinal;
        return a.id < b.id;
    });
    // The top band stays reserved so the first entry's y does not depend on
    // whether a reading happened to exist yet.
    out.versionRail = GraphRect{pad, pad, 0.0f, diameter};
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
        dot.w = diameter;
        out.nodes[node.id.value] = dot;
        ++beliefCount;
    }
    out.beliefRail = GraphRect{pad, railBandH + pad, beliefCount == 0 ? 0.0f : diameter,
                               static_cast<float>(beliefCount) * (diameter + kGraphStyle.rowGap)};

    // --- episode tracks and Frame versions, top to bottom by time --------
    // Every entry owns a fixed vertical slot, so a row's y is decided by its place
    // in the time sequence and never by how many stations it grew. A row's height
    // is fixed by its widest station count, so adding a node to a row does not
    // move the entries below it more than that row's own growth.
    const float rowsX = pad + beliefRailWidth() + kGraphStyle.columnGap;
    float slotY = railBandH + pad + radius;
    if (beliefCount > 0) {
        const float beliefRailHeight =
            static_cast<float>(beliefCount) * (diameter + kGraphStyle.rowGap);
        slotY = std::max(slotY, railBandH + pad + radius + beliefRailHeight);
    }
    const float step = diameter + kGraphStyle.rowGap * 2.0f;

    out.gutters = state.rows;
    bool haveSlot = false;
    for (const TaskEntry& entry : entries) {
        // Every entry — episode track or Frame version — owns exactly one vertical
        // slot. Sharing a slot (side by side) would reintroduce a family grouping
        // and break the rule that y grows with occurrence time.
        if (haveSlot) slotY += step;
        haveSlot = true;
        const float y = slotY + radius;

        if (entry.isFrame) {
            const GraphNode* node = state.node("Fv:" + entry.id);
            if (node == nullptr) continue;
            Dot dot;
            dot.r = radius;
            dot.w = diameter;
            dot.x = pad + kRowLabelWidth;
            dot.y = y;
            out.nodes[node->id.value] = dot;
            continue;
        }

        EpisodeGutter& gutter = out.gutters[entry.index];
        // Stations in this row, in station order (the projection already assigned
        // `order`; ties break on the node id so the layout is total).
        std::vector<const GraphNode*> rowNodes;
        for (const GraphNode& node : state.nodes) {
            if (node.episodeId != gutter.id) continue;
            rowNodes.push_back(&node);
        }
        // The row anchor is drawn in the gutter, not among the stations.
        // A total order keyed by (has-time, time-or-0, record order, id): timed
        // records interleave across families by occurrence, records with no time
        // (a snapshot carries no per-record time) keep their fixed record order
        // and sort before the timed ones. Lexicographic, so it is a strict weak
        // ordering even when a row mixes the two.
        std::stable_sort(rowNodes.begin(), rowNodes.end(),
                         [](const GraphNode* a, const GraphNode* b) {
                             const bool at = a->occurredAtMs >= 0;
                             const bool bt = b->occurredAtMs >= 0;
                             if (at != bt) return !at;
                             if (at && a->occurredAtMs != b->occurredAtMs) {
                                 return a->occurredAtMs < b->occurredAtMs;
                             }
                             if (a->order != b->order) return a->order < b->order;
                             return a->id.value < b->id.value;
                         });

        long maxBlockTokens = 0;
        for (const GraphNode* node : rowNodes) {
            if (node->blockTokens > maxBlockTokens) maxBlockTokens = node->blockTokens;
        }
        // A token-bearing block is widened within its fixed station slot: the
        // width is normalised against the row's largest block and capped below the
        // station spacing so neighbouring blocks still cannot overlap. No
        // telemetry (maxBlockTokens == 0) leaves every block at its base width.
        const float baseW = diameter;
        const float maxW = diameter + (kGraphStyle.columnGap - 6.0f);

        size_t station = 0;
        for (const GraphNode* node : rowNodes) {
            Dot dot;
            dot.r = radius;
            float width = baseW;
            if (node->blockTokens > 0 && maxBlockTokens > 0) {
                const float frac = static_cast<float>(node->blockTokens) / static_cast<float>(maxBlockTokens);
                width = baseW + (maxW - baseW) * frac;
            }
            dot.w = width;
            if (node->family == NodeFamily::EpisodeRow) {
                dot.x = rowsX - kRowLabelWidth * 0.5f;
                dot.y = y;
                out.nodes[node->id.value] = dot;
                continue;
            }
            dot.x = rowsX + stationX(station);
            dot.y = y;
            out.nodes[node->id.value] = dot;
            ++station;
        }
        const float rowWidth = stationX(station == 0 ? 1 : station);
        gutter.rect = GraphRect{rowsX, y - radius - kGraphStyle.rowGap * 0.5f, rowWidth,
                                diameter + kGraphStyle.rowGap};
    }
    const float afterY = haveSlot ? slotY + step : slotY;

    // --- the outcome band -------------------------------------------------
    // Task scope, not row content: it sits below the last row and never inside one.
    if (state.taskOutcome.present) {
        const float bandY = afterY - kGraphStyle.rowGap;
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
