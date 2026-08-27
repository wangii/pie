// GraphCache: Phase 2 M8 caches for the graph hot paths.
//
// The Graph View's per-frame render path recomputes the layout, the selection
// dependency set, and the edge routes on every frame. At the 50-frame / 500-node
// target that is wasteful: most frames the task state is unchanged. This module
// caches those results and invalidates them by an input version: a content
// fingerprint of the task state (and, for routes, of the layout geometry) is
// derived per call; when it is unchanged the previous result is reused, and only
// when it changes is the expensive value recomputed. This gives precise
// invalidation without the caller having to manage versions manually, and
// doubles as the "dirty flag" signal for the viewer.
//
// Headless / ImGui-free: the cache only wraps the headless layout, dependency,
// routing, and long-route computations, so it is unit-testable without a window.

#pragma once

#include <map>
#include <set>
#include <string>
#include <vector>

#include "graph/GraphModel.h"
#include "graph/PieGraphLayout.h"
#include "graph/GraphRouting.h"
#include "graph/GraphInteraction.h"

namespace pie::gui {

// Counters for how often each cache actually recomputed (vs. served from cache).
// A performance / reuse test asserts these stay low across an unchanged input
// and bump on change.
struct GraphCacheMetrics {
    int layoutComputes = 0;
    int dependencyComputes = 0;
    int routeComputes = 0;
};

class GraphCache {
public:
    GraphCache() = default;
    GraphCache(const GraphCache&) = delete;
    GraphCache& operator=(const GraphCache&) = delete;

    // The auto-layout for `state`. Recomputed only when the state fingerprint
    // changes; otherwise the previous layout is returned.
    const PieGraphLayout& getLayout(const GraphTaskState& state, GraphCacheMetrics& m);

    // The selection dependency set for `selected`. The adjacency index is built
    // once per state fingerprint and reused across selections; the per-selection
    // set is cached and reused when the state is unchanged and the same node is
    // selected.
    const std::set<std::string>& getDependencySet(const GraphTaskState& state,
                                                  const std::string& selected,
                                                  GraphCacheMetrics& m);

    // Edge routes for `state` + `layout`. Recomputed when either the state or
    // the layout geometry changes; otherwise reused.
    const std::vector<EdgeRoute>& getRoutes(const GraphTaskState& state,
                                            const PieGraphLayout& layout,
                                            GraphCacheMetrics& m);

    // The cross-region Belief read/write subset of getRoutes(). Recomputed
    // together with getRoutes().
    const std::vector<EdgeRoute>& getLongRoutes(const GraphTaskState& state,
                                                const PieGraphLayout& layout,
                                                GraphCacheMetrics& m);

    // Drop all caches (forces recompute on the next get* call).
    void clear();

private:
    uint64_t stateFingerprint(const GraphTaskState& state) const;
    uint64_t layoutFingerprint(const PieGraphLayout& layout) const;

    uint64_t lastLayoutFp_ = 0;
    bool haveLayout_ = false;
    PieGraphLayout layout_;

    uint64_t lastAdjFp_ = 0;
    bool haveAdj_ = false;
    // Reusable adjacency index (built once per state fingerprint).
    struct GraphAdjacency adj_;
    std::map<std::string, std::set<std::string>> depCache_;

    uint64_t lastRoutesFp_ = 0;
    bool haveRoutes_ = false;
    std::vector<EdgeRoute> routes_;
    std::vector<EdgeRoute> longRoutes_;
};

} // namespace pie::gui
