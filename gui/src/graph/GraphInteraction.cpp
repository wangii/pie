// GraphInteraction.cpp: Phase 2 M5 selection dependency path implementation.
//
// A BFS in both directions over the task's edge set, guarded by a visited set so
// cycles terminate. Ancestors = nodes that can reach the selection (reverse edge
// traversal); descendants = nodes reachable from the selection (forward edge
// traversal). The union of both, plus the selected node itself, is the dependency
// set the viewer emphasizes; everything else is dimmed.

#include "graph/GraphInteraction.h"

#include <queue>
#include <vector>

namespace pie::gui {

namespace {
// Breadth-first reachability from `start` over `neighbors` (a lambda returning
// the adjacency list for a node), guarded by a visited set. Returns all reached
// ids including `start`.
template <typename Neighbors>
std::set<std::string> reachable(const std::string& start, Neighbors&& neighbors) {
    std::set<std::string> visited;
    std::queue<std::string> q;
    if (!start.empty()) {
        visited.insert(start);
        q.push(start);
    }
    while (!q.empty()) {
        std::string cur = q.front();
        q.pop();
        for (const std::string& nxt : neighbors(cur)) {
            if (visited.insert(nxt).second) q.push(nxt);
        }
    }
    return visited;
}
} // namespace

GraphAdjacency buildGraphAdjacency(const GraphTaskState& state) {
    GraphAdjacency adj;
    for (const GraphEdge& e : state.edges) {
        adj.forward[e.source.value].push_back(e.target.value);
        adj.reverse[e.target.value].push_back(e.source.value);
    }
    return adj;
}

std::set<std::string> computeDependencySetFromAdjacency(const GraphAdjacency& adj,
                                                        const std::string& selected) {
    if (selected.empty()) return {};
    auto fwd = [&adj](const std::string& id) -> const std::vector<std::string>& {
        static const std::vector<std::string> empty;
        auto it = adj.forward.find(id);
        return it == adj.forward.end() ? empty : it->second;
    };
    auto rev = [&adj](const std::string& id) -> const std::vector<std::string>& {
        static const std::vector<std::string> empty;
        auto it = adj.reverse.find(id);
        return it == adj.reverse.end() ? empty : it->second;
    };
    std::set<std::string> result = reachable(selected, fwd);
    std::set<std::string> ancestors = reachable(selected, rev);
    for (const std::string& a : ancestors) result.insert(a);
    return result;
}

std::set<std::string> computeDependencySet(const GraphTaskState& state, const std::string& selected) {
    if (selected.empty()) return {};
    GraphAdjacency adj = buildGraphAdjacency(state);
    return computeDependencySetFromAdjacency(adj, selected);
}

} // namespace pie::gui
