// GraphLive.cpp: Phase 2 M6 live-layout stability implementation.
//
// Completed LoopFrames are cached and restored as geometry groups. Open and
// pending frames always use the fresh layout, which lets nodes move while their
// semantic ownership is still changing. Global Beliefs are stabilized
// separately because they intentionally have no owning frame.

#include "graph/GraphLive.h"

#include <set>
#include <utility>

namespace pie::gui {

namespace {

bool stableBelief(const GraphNode& node) {
    if (node.family != NodeFamily::Belief) return false;
    return true;
}

bool frameStructureMatches(const CompletedFrameLayout& cached,
                           const GraphTaskState& state,
                           const std::string& frameId) {
    std::size_t nodeCount = 0;
    for (const GraphNode& node : state.nodes) {
        if (!node.frameId || *node.frameId != frameId) continue;
        ++nodeCount;
        if (!cached.nodeRects.contains(node.id.value)) return false;
    }
    return nodeCount == cached.nodeRects.size();
}

void restoreRegion(const std::optional<GraphRect>& cached,
                   std::map<std::string, GraphRect>& regions,
                   const std::string& frameId) {
    if (cached) regions[frameId] = *cached;
    else regions.erase(frameId);
}

std::optional<GraphRect> regionFor(
    const std::map<std::string, GraphRect>& regions,
    const std::string& frameId) {
    auto it = regions.find(frameId);
    if (it == regions.end()) return std::nullopt;
    return it->second;
}

std::optional<CompletedFrameLayout> captureFrame(
    const GraphTaskState& state,
    const PieGraphLayout& layout,
    const std::string& frameId) {
    auto frameRect = layout.frameRects.find(frameId);
    if (frameRect == layout.frameRects.end()) return std::nullopt;

    CompletedFrameLayout cached;
    cached.frameRect = frameRect->second;
    for (const GraphNode& node : state.nodes) {
        if (!node.frameId || *node.frameId != frameId) continue;
        auto rect = layout.nodeRects.find(node.id.value);
        if (rect != layout.nodeRects.end()) {
            cached.nodeRects[node.id.value] = rect->second;
        }
    }
    cached.beliefRegionRect = regionFor(layout.beliefRegionRects, frameId);
    cached.planRegionRect = regionFor(layout.planRegionRects, frameId);
    cached.proposeRegionRect = regionFor(layout.proposeRegionRects, frameId);
    cached.distillRegionRect = regionFor(layout.distillRegionRects, frameId);
    cached.executionRegionRect = regionFor(layout.executionRegionRects, frameId);
    return cached;
}

void restoreFrame(const CompletedFrameLayout& cached,
                  PieGraphLayout& layout,
                  const std::string& frameId) {
    layout.frameRects[frameId] = cached.frameRect;
    for (const auto& [nodeId, rect] : cached.nodeRects) {
        if (layout.nodeRects.contains(nodeId)) layout.nodeRects[nodeId] = rect;
    }
    restoreRegion(cached.beliefRegionRect, layout.beliefRegionRects, frameId);
    restoreRegion(cached.planRegionRect, layout.planRegionRects, frameId);
    restoreRegion(cached.proposeRegionRect, layout.proposeRegionRects, frameId);
    restoreRegion(cached.distillRegionRect, layout.distillRegionRects, frameId);
    restoreRegion(cached.executionRegionRect, layout.executionRegionRects, frameId);
}

} // namespace

PieGraphLayout stabilizeLiveLayout(const GraphTaskState& state,
                                   const PieGraphLayout& fresh,
                                   GraphLiveState& live) {
    PieGraphLayout result = fresh;

    // Beliefs are global rather than frame-owned. Keep beliefs at their first
    // position (stable across live updates; there is no framing Target case).
    std::set<std::string> currentBeliefIds;
    for (const GraphNode& node : state.nodes) {
        if (node.family != NodeFamily::Belief) continue;
        currentBeliefIds.insert(node.id.value);
        if (!stableBelief(node)) {
            live.stableBeliefRects.erase(node.id.value);
            live.stableBeliefAnchors.erase(node.id.value);
            continue;
        }

        const std::string anchor = node.createdInFrame.has_value() ? *node.createdInFrame : std::string();
        // If the Belief's display anchor frame changed (its producing Propose
        // was reparented to a successor), drop the stale rect so it re-anchors
        // in the new row; otherwise keep the cached position.
        auto anchorIt = live.stableBeliefAnchors.find(node.id.value);
        if (anchorIt != live.stableBeliefAnchors.end() && anchorIt->second != anchor) {
            live.stableBeliefRects.erase(node.id.value);
        }
        live.stableBeliefAnchors[node.id.value] = anchor;

        auto cached = live.stableBeliefRects.find(node.id.value);
        auto rect = result.nodeRects.find(node.id.value);
        if (cached != live.stableBeliefRects.end() && rect != result.nodeRects.end()) {
            rect->second = cached->second;
        } else if (rect != result.nodeRects.end()) {
            live.stableBeliefRects[node.id.value] = rect->second;
        }
    }
    for (auto it = live.stableBeliefRects.begin(); it != live.stableBeliefRects.end();) {
        if (!currentBeliefIds.contains(it->first)) it = live.stableBeliefRects.erase(it);
        else ++it;
    }
    for (auto it = live.stableBeliefAnchors.begin(); it != live.stableBeliefAnchors.end();) {
        if (!currentBeliefIds.contains(it->first)) it = live.stableBeliefAnchors.erase(it);
        else ++it;
    }

    // Restore only completed frames. Open and pending frames intentionally use
    // fresh geometry so their nodes can grow, reorder, or change ownership.
    std::set<std::string> currentClosedFrameIds;
    for (const LoopFrameInfo& frame : state.frames) {
        if (!frame.closed) {
            live.completedFrames.erase(frame.id);
            continue;
        }
        currentClosedFrameIds.insert(frame.id);
        auto cached = live.completedFrames.find(frame.id);
        if (cached == live.completedFrames.end()) continue;
        if (!frameStructureMatches(cached->second, state, frame.id)) {
            live.completedFrames.erase(cached);
            continue;
        }
        restoreFrame(cached->second, result, frame.id);
    }
    for (auto it = live.completedFrames.begin(); it != live.completedFrames.end();) {
        if (!currentClosedFrameIds.contains(it->first)) it = live.completedFrames.erase(it);
        else ++it;
    }

    // A frame is captured only after its final fresh geometry is available.
    // Structurally changed closed frames were invalidated above and are recaptured.
    for (const LoopFrameInfo& frame : state.frames) {
        if (!frame.closed || live.completedFrames.contains(frame.id)) continue;
        std::optional<CompletedFrameLayout> cached = captureFrame(state, result, frame.id);
        if (cached) live.completedFrames[frame.id] = std::move(*cached);
    }

    return result;
}

} // namespace pie::gui
