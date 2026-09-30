// GraphCache.cpp: cache implementation (headless). Invalidates by a content
// fingerprint of the task state (and, for routes, the layout geometry); when
// unchanged, the previous result is reused.
//
// The fingerprint must cover everything the downstream computation reads, and
// nothing else. Too narrow and a change is served stale; too wide and the cache
// recomputes on every frame, which is the same as not having one. The v7 fields
// folded below are exactly the ones the projection and the layout consume.

#include "graph/GraphCache.h"

#include <functional>

#include "graph/GraphInteraction.h"

namespace pie::gui {

namespace {
// FNV-1a over a small integer stream, appended with a field separator so
// concatenated values cannot collide (e.g. "12"+"3" vs "1"+"23").
uint64_t hashMix(uint64_t h, uint64_t v) {
    // Fold v into the hash with a separator.
    h ^= (v + 0x9e3779b97f4a7c15ULL + (h << 6) + (h >> 2));
    return h;
}

// Fold a string into the hash, byte by byte, so string ids (frame ids, node
// ids) participate in the fingerprint without truncation.
uint64_t hashMixStr(uint64_t h, const std::string& s) {
    for (unsigned char c : s) h = hashMix(h, c);
    h = hashMix(h, 0xFF);  // terminator distinguishes "ab" from "a"+"b"
    return h;
}
} // namespace

uint64_t GraphCache::stateFingerprint(const GraphTaskState& state) const {
    uint64_t h = 14695981039346656037ULL;  // FNV offset basis
    h = hashMix(h, state.nodes.size());
    for (const GraphNode& n : state.nodes) {
        // Fold the id and every field that changes what is drawn or where.
        h = hashMixStr(h, n.id.value);
        h = hashMix(h, static_cast<uint64_t>(n.family));
        h = hashMixStr(h, n.episodeId);
        h = hashMix(h, n.order);
        h = hashMix(h, n.ordinal);
        // The layout reads this: it orders the stations inside a row by occurrence.
        // A time-only change must invalidate, or the cache serves a stale x order.
        h = hashMix(h, static_cast<uint64_t>(n.occurredAtMs));
        h = hashMix(h, static_cast<uint64_t>(n.blockTokens));
        h = hashMix(h, static_cast<uint64_t>(n.state));
        h = hashMix(h, static_cast<uint64_t>(n.executionStatus));
        h = hashMix(h, static_cast<uint64_t>(n.routingDecision));
        h = hashMix(h, static_cast<uint64_t>(n.beliefOperation));
        h = hashMix(h, static_cast<uint64_t>(n.deltaPhase));
        h = hashMix(h, static_cast<uint64_t>(n.beliefStatus));
        h = hashMix(h, n.beliefWithdrawn ? 1 : 0);
        h = hashMix(h, n.superseded ? 1 : 0);
        h = hashMix(h, n.inFocus ? 1 : 0);
    }
    // The outcome band changes derived geometry (it advances the canvas height), so it is part of
    // the layout fingerprint even though it owns no node.
    h = hashMix(h, state.taskOutcome.present ? 1 : 0);
    h = hashMixStr(h, state.taskOutcome.result);
    h = hashMixStr(h, state.taskOutcome.evidence);
    h = hashMixStr(h, state.taskOutcome.blockers);
    h = hashMix(h, state.focusDeclared ? 1 : 0);
    h = hashMix(h, state.focusBeliefIds.size());
    for (const std::string& id : state.focusBeliefIds) h = hashMixStr(h, id);
    h = hashMix(h, state.edges.size());
    for (const GraphEdge& e : state.edges) {
        for (unsigned char c : e.source.value) h = hashMix(h, c);
        for (unsigned char c : e.target.value) h = hashMix(h, c);
        h = hashMix(h, static_cast<uint64_t>(e.type));
        h = hashMix(h, e.beliefOperation.has_value() ? static_cast<uint64_t>(*e.beliefOperation) : 0);
        h = hashMix(h, e.dashed ? 1 : 0);
    }
    h = hashMix(h, state.rows.size());
    for (const EpisodeGutter& row : state.rows) {
        h = hashMixStr(h, row.id);
        h = hashMix(h, row.ordinal);
        // The task-level sequence reads this: it is the episode's place on the
        // shared vertical time axis.
        h = hashMix(h, static_cast<uint64_t>(row.occurredAtMs));
        h = hashMix(h, static_cast<uint64_t>(row.status));
        h = hashMix(h, static_cast<uint64_t>(row.stage));
        h = hashMixStr(h, row.routingDecision);
        h = hashMixStr(h, row.bodyKind);
        h = hashMix(h, row.current ? 1 : 0);
    }
    h = hashMix(h, state.versions.size());
    for (const GraphRailVersion& version : state.versions) {
        h = hashMixStr(h, version.id);
        h = hashMix(h, version.ordinal);
        // The layout reads both: recordedAt decides the version's place on the
        // time axis and formedInEpisodeOrdinal is the boundary fallback when the
        // time is absent.
        h = hashMix(h, static_cast<uint64_t>(version.occurredAtMs));
        h = hashMix(h, version.formedInEpisodeOrdinal);
        h = hashMix(h, version.current ? 1 : 0);
        h = hashMix(h, version.approved ? 1 : 0);
    }
    h = hashMix(h, state.currentNode.has_value() ? 1 : 0);
    if (state.currentNode.has_value()) h = hashMixStr(h, state.currentNode->value);
    h = hashMix(h, static_cast<uint64_t>(state.cursorStage));
    return h;
}

uint64_t GraphCache::layoutFingerprint(const PieGraphLayout& layout) const {
    uint64_t h = 14695981039346656037ULL;
    h = hashMix(h, layout.nodes.size());
    for (const auto& [id, dot] : layout.nodes) {
        h = hashMixStr(h, id);
        // Centimetre precision is far below a pixel: a sub-0.01 change is not a
        // layout change, and hashing floats' exact bits would invalidate on
        // rounding noise.
        h = hashMix(h, static_cast<uint64_t>(dot.x * 100.0f));
        h = hashMix(h, static_cast<uint64_t>(dot.y * 100.0f));
        h = hashMix(h, static_cast<uint64_t>(dot.r * 100.0f));
        h = hashMix(h, static_cast<uint64_t>(dot.w * 100.0f));
    }
    h = hashMix(h, layout.gutters.size());
    for (const EpisodeGutter& gutter : layout.gutters) {
        h = hashMixStr(h, gutter.id);
        h = hashMix(h, static_cast<uint64_t>(gutter.rect.x * 100.0f));
        h = hashMix(h, static_cast<uint64_t>(gutter.rect.y * 100.0f));
        h = hashMix(h, static_cast<uint64_t>(gutter.rect.w * 100.0f));
        h = hashMix(h, static_cast<uint64_t>(gutter.rect.h * 100.0f));
    }
    h = hashMix(h, static_cast<uint64_t>(layout.canvasWidth * 100.0f));
    h = hashMix(h, static_cast<uint64_t>(layout.canvasHeight * 100.0f));
    return h;
}

void GraphCache::clear() {
    haveLayout_ = false;
    haveAdj_ = false;
    depCache_.clear();
    haveRoutes_ = false;
    routes_.clear();
    longRoutes_.clear();
}

const PieGraphLayout& GraphCache::getLayout(const GraphTaskState& state, GraphCacheMetrics& m) {
    uint64_t fp = stateFingerprint(state);
    if (!haveLayout_ || fp != lastLayoutFp_) {
        layout_ = computeGraphLayout(state);
        lastLayoutFp_ = fp;
        haveLayout_ = true;
        ++m.layoutComputes;
    }
    return layout_;
}

const std::set<std::string>& GraphCache::getDependencySet(const GraphTaskState& state,
                                                          const std::string& selected,
                                                          GraphCacheMetrics& m) {
    uint64_t fp = stateFingerprint(state);
    if (!haveAdj_ || fp != lastAdjFp_) {
        adj_ = buildGraphAdjacency(state);
        lastAdjFp_ = fp;
        haveAdj_ = true;
        depCache_.clear();
    }
    auto it = depCache_.find(selected);
    if (it != depCache_.end()) return it->second;
    std::set<std::string> dep = computeDependencySetFromAdjacency(adj_, selected);
    ++m.dependencyComputes;
    return depCache_.emplace(selected, std::move(dep)).first->second;
}

const std::vector<EdgeRoute>& GraphCache::getRoutes(const GraphTaskState& state,
                                                    const PieGraphLayout& layout,
                                                    GraphCacheMetrics& m) {
    uint64_t fp = stateFingerprint(state) ^ layoutFingerprint(layout);
    if (!haveRoutes_ || fp != lastRoutesFp_) {
        routes_ = computeEdgeRoutes(state, layout);
        longRoutes_.clear();
        for (const EdgeRoute& r : routes_) {
            if (r.longRoute) longRoutes_.push_back(r);
        }
        lastRoutesFp_ = fp;
        haveRoutes_ = true;
        ++m.routeComputes;
    }
    return routes_;
}

const std::vector<EdgeRoute>& GraphCache::getLongRoutes(const GraphTaskState& state,
                                                        const PieGraphLayout& layout,
                                                        GraphCacheMetrics& m) {
    // Force the routes to be up to date (recomputes only if state/layout changed).
    getRoutes(state, layout, m);
    return longRoutes_;
}

} // namespace pie::gui
