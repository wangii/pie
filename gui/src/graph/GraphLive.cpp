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
                if (nodeBelongsTo(state, entry.first, gutter.id)) out.nodes[entry.first] = entry.second;
            }
            for (EpisodeGutter& freshGutter : out.gutters) {
                if (freshGutter.id == gutter.id) freshGutter.rect = cached->second.rect;
            }
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

    // The rails are append-only too, so an entry that has been drawn once keeps
    // its position. A node that is not in the rail set was never frozen and takes
    // the fresh position, which is what lets a brand-new belief appear.
    for (const GraphNode& node : state.nodes) {
        const bool onRail = node.family == NodeFamily::Belief || node.family == NodeFamily::Formulation;
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
