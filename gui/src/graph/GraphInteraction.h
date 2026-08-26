// GraphInteraction: Phase 2 M5 selection dependency path.
//
// Headless, ImGui-free, unit-testable. When the user selects a node in the Graph
// View, the viewer must emphasize the node's dependency path (its ancestors and
// descendants) and dim everything else. This module computes that dependency set
// as a cycle-safe traversal (visited set) over the task's typed, directed edges,
// so a cyclic task graph cannot cause an infinite loop. The viewer owns the
// selection state; this module only derives the emphasized set from it.

#pragma once

#include <map>
#include <set>
#include <string>
#include <vector>

#include "graph/GraphModel.h"

namespace pie::gui {

// A reusable adjacency index over a task's edge list: forward (source ->
// targets) and reverse (target -> sources). Built once from the state and reused
// across selections so the M5 dependency query does not rebuild it each time
// (Phase 2 M8 cache reuses this instead of recomputing per selection).
struct GraphAdjacency {
    std::map<std::string, std::vector<std::string>> forward;
    std::map<std::string, std::vector<std::string>> reverse;
};

// Build the adjacency index for `state`. Only edges whose endpoints are real
// nodes are indexed.
GraphAdjacency buildGraphAdjacency(const GraphTaskState& state);

// Compute the dependency set for a selected node using a prebuilt adjacency
// index. The selected node plus every ancestor (nodes that can reach it) and
// every descendant (nodes it can reach), guarded by a per-direction visited set
// so cycles terminate.
std::set<std::string> computeDependencySetFromAdjacency(const GraphAdjacency& adj,
                                                        const std::string& selected);

// Compute the dependency set for a selected node: the selected node plus every
// ancestor (nodes that can reach it) and every descendant (nodes it can reach).
// Traversal is on direct edges only (no transitive closure expansion step beyond
// the reachable set), uses a visited set per direction so cycles terminate, and
// ignores edges whose source/target ids are not present in the node set.
//
// `selected` is the NodeId value ("" means none selected -> empty set).
std::set<std::string> computeDependencySet(const GraphTaskState& state, const std::string& selected);

} // namespace pie::gui
