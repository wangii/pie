#include "graph/GraphLive.h"

namespace pie::gui {

namespace {

bool nodeBelongsTo(const GraphTaskState& state, const std::string& nodeId,
                   const std::string& episodeId) {
    const GraphNode* node = state.node(nodeId);
    return node != nullptr && node->episodeId == episodeId;
}

} // namespace

PieGraphLayout stabilizeLiveLayout(const GraphTaskState& state, const PieGraphLayout& fresh,
                                   GraphLiveState& live) {
    PieGraphLayout out = fresh;

    // A row whose episode is closed will never legitimately move: the fold refuses
    // every write to a closed episode (Model.h, invariant 2), so its node set is
    // final and freezing its geometry is exact rather than approximate.
    for (const EpisodeGutter& gutter : state.rows) {
        if (gutter.status != EpisodeStatus::Closed) continue;

        const auto cached = live.completedEpisodes.find(gutter.id);
        if (cached != live.completedEpisodes.end()) {
            for (const auto& entry : cached->second.nodes) {
                // A node the cache knows about but the fresh layout dropped (a
                // record removed by a snapshot replacement) must not be
                // resurrected: only nodes still present in `state` are frozen.
                if (!nodeBelongsTo(state, entry.first, gutter.id)) continue;
                // The row's INTERNAL geometry is frozen — the x of each station, its
                // width and radius — so a station never slides sideways under the
                // cursor. Its y follows the fresh layout: the vertical axis is the
                // task-level time sequence, and a closed row's place on that axis is
                // decided by its occurrence time, not by when it was first drawn.
                const auto freshIt = fresh.nodes.find(entry.first);
                if (freshIt == fresh.nodes.end()) continue;
                Dot dot = entry.second;
                dot.y = freshIt->second.y;
                out.nodes[entry.first] = dot;
            }
            // The gutter rect is a horizontal band: its x/width stay fresh too, so
            // the separator follows the row it labels instead of pinning an old y.
            continue;
        }

        CompletedEpisodeLayout frozen;
        frozen.rect = gutter.rect;
        for (const GraphNode& node : state.nodes) {
            if (node.episodeId != gutter.id) continue;
            const auto it = fresh.nodes.find(node.id.value);
            if (it == fresh.nodes.end()) continue;
            frozen.nodes.emplace(node.id.value, it->second);
        }
        live.completedEpisodes.emplace(gutter.id, std::move(frozen));
    }

    // The BELIEF rail is append-only, so an entry that has been drawn once keeps
    // its position. A Frame version is not frozen here: it lives on the shared
    // vertical time axis with the episode tracks, so freezing its y would pin it
    // against the very order the axis expresses. A node that is not in the rail
    // set was never frozen and takes the fresh position, which is what lets a
    // brand-new belief or version appear.
    for (const GraphNode& node : state.nodes) {
        const bool onRail = node.family == NodeFamily::Belief;
        if (!onRail) continue;
        const auto cached = live.stableRailNodes.find(node.id.value);
        if (cached != live.stableRailNodes.end()) {
            out.nodes[node.id.value] = cached->second;
            continue;
        }
        const auto it = fresh.nodes.find(node.id.value);
        if (it != fresh.nodes.end()) live.stableRailNodes.emplace(node.id.value, it->second);
    }

    return out;
}

} // namespace pie::gui
