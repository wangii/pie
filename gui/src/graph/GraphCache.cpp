// GraphCache.cpp: Phase 2 M8 cache implementation (headless). Invalidates by a
// content fingerprint of the task state (and, for routes, the layout geometry);
// when unchanged, the previous result is reused.

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
} // namespace

uint64_t GraphCache::stateFingerprint(const GraphTaskState& state) const {
    uint64_t h = 14695981039346656037ULL;  // FNV offset basis
    h = hashMix(h, state.nodes.size());
    for (const GraphNode& n : state.nodes) {
        // Fold the id and the fractionally-relevant fields.
        for (unsigned char c : n.id.value) h = hashMix(h, c);
        h = hashMix(h, static_cast<uint64_t>(n.family));
        h = hashMix(h, n.frameId.has_value() ? static_cast<uint64_t>(*n.frameId) : 0xFFFFFFFFFFFFFFFFULL);
        h = hashMix(h, n.createdInFrame.has_value() ? static_cast<uint64_t>(*n.createdInFrame) : 0xFFFFFFFFFFFFFFFFULL);
        h = hashMix(h, n.creationOrder);
        h = hashMix(h, n.executionOrder.value_or(0));
        h = hashMix(h, n.displayType.empty() ? 0 : static_cast<unsigned char>(n.displayType[0]));
    }
    h = hashMix(h, state.edges.size());
    for (const GraphEdge& e : state.edges) {
        for (unsigned char c : e.source.value) h = hashMix(h, c);
        for (unsigned char c : e.target.value) h = hashMix(h, c);
        h = hashMix(h, static_cast<uint64_t>(e.type));
        h = hashMix(h, e.beliefOperation.has_value() ? static_cast<uint64_t>(*e.beliefOperation) : 0);
    }
    h = hashMix(h, state.frames.size());
    for (const LoopFrameInfo& frame : state.frames) {
        h = hashMix(h, static_cast<uint64_t>(frame.id));
        h = hashMix(h, frame.closed ? 1 : 0);
        h = hashMix(h, frame.executing ? 1 : 0);
    }
    return h;
}

uint64_t GraphCache::layoutFingerprint(const PieGraphLayout& layout) const {
    uint64_t h = 14695981039346656037ULL;
    h = hashMix(h, layout.nodeRects.size());
    for (const auto& [id, r] : layout.nodeRects) {
        for (unsigned char c : id) h = hashMix(h, c);
        h = hashMix(h, static_cast<uint64_t>(r.x * 100.0f));
        h = hashMix(h, static_cast<uint64_t>(r.y * 100.0f));
        h = hashMix(h, static_cast<uint64_t>(r.w * 100.0f));
        h = hashMix(h, static_cast<uint64_t>(r.h * 100.0f));
    }
    h = hashMix(h, layout.frameRects.size());
    for (const auto& [fid, r] : layout.frameRects) {
        h = hashMix(h, static_cast<uint64_t>(fid));
        h = hashMix(h, static_cast<uint64_t>(r.x * 100.0f));
        h = hashMix(h, static_cast<uint64_t>(r.y * 100.0f));
        h = hashMix(h, static_cast<uint64_t>(r.w * 100.0f));
        h = hashMix(h, static_cast<uint64_t>(r.h * 100.0f));
    }
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
