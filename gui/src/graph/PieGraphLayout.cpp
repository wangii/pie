// PieGraphLayout.cpp: deterministic semantic Graph View layout.
//
// LoopFrames are stacked as rows. Beliefs stay in one global left column;
// Plan and Distillation occupy the upper/lower middle bands; Execution occupies
// the right column. A row grows to fit every region, including the beliefs first
// created in that frame, so regions never overlap across frame boundaries.

#include "graph/PieGraphLayout.h"

#include <algorithm>
#include <map>
#include <optional>
#include <vector>

#include "graph/GraphStyle.h"

namespace pie::gui {

namespace {
constexpr const GraphStyle& st = kGraphStyle;

float sequenceWidth(std::size_t count) {
    if (count == 0) return 0.0f;
    return static_cast<float>(count) * st.nodeW +
           static_cast<float>(count - 1) * st.nodeGapH;
}

float stackHeight(std::size_t count) {
    if (count == 0) return 0.0f;
    return static_cast<float>(count) * st.nodeH +
           static_cast<float>(count - 1) * st.nodeGapV;
}

template <typename Order>
void sortByOrder(std::vector<const GraphNode*>& nodes, Order order) {
    std::stable_sort(nodes.begin(), nodes.end(), [&](const GraphNode* a, const GraphNode* b) {
        return order(*a) < order(*b);
    });
}

std::optional<std::string> inferredCreationFrame(
    const GraphNode& belief,
    const std::map<std::string, std::string>& nodeFrames,
    const std::map<std::string, std::size_t>& frameOrder,
    const std::vector<GraphEdge>& edges) {
    if (belief.createdInFrame) return belief.createdInFrame;

    std::optional<std::string> result;
    std::size_t bestOrder = frameOrder.size();
    for (const GraphEdge& edge : edges) {
        if ((edge.type != EdgeSemanticType::DistillToBelief &&
             edge.type != EdgeSemanticType::ProposeToBelief) ||
            edge.beliefOperation != BeliefOperation::Create ||
            edge.target.value != belief.id.value) {
            continue;
        }
        auto source = nodeFrames.find(edge.source.value);
        if (source == nodeFrames.end()) continue;
        auto order = frameOrder.find(source->second);
        if (order != frameOrder.end() && order->second < bestOrder) {
            result = source->second;
            bestOrder = order->second;
        }
    }
    return result;
}

GraphRect paddedBounds(const std::vector<const GraphNode*>& nodes,
                       const std::map<std::string, GraphRect>& rects,
                       float pad) {
    float minX = 1e30f;
    float minY = 1e30f;
    float maxX = -1e30f;
    float maxY = -1e30f;
    for (const GraphNode* node : nodes) {
        auto it = rects.find(node->id.value);
        if (it == rects.end()) continue;
        minX = std::min(minX, it->second.x);
        minY = std::min(minY, it->second.y);
        maxX = std::max(maxX, it->second.x + it->second.w);
        maxY = std::max(maxY, it->second.y + it->second.h);
    }
    if (maxX < minX || maxY < minY) return {};
    return GraphRect{minX - pad, minY - pad,
                     maxX - minX + pad * 2.0f,
                     maxY - minY + pad * 2.0f};
}
} // namespace

PieGraphLayout computeGraphLayout(const GraphTaskState& state) {
    PieGraphLayout out;

    std::map<std::string, std::size_t> frameOrder;
    std::map<std::string, std::vector<const GraphNode*>> plansByFrame;
    std::map<std::string, std::vector<const GraphNode*>> executionsByFrame;
    std::map<std::string, std::vector<const GraphNode*>> distillationsByFrame;
    std::map<std::string, std::vector<const GraphNode*>> proposeByFrame;
    std::map<std::string, std::string> nodeFrames;
    std::vector<const GraphNode*> beliefs;
    std::vector<const GraphNode*> columnBeliefs;  // beliefs in the left column (world + routing)

    for (std::size_t i = 0; i < state.frames.size(); ++i) {
        frameOrder[state.frames[i].id] = i;
    }
    for (const GraphNode& node : state.nodes) {
        if (node.family == NodeFamily::Belief || !node.frameId) {
            beliefs.push_back(&node);
            if (node.family == NodeFamily::Belief &&
                node.domain != "framing" && node.domain != "routing") {
                columnBeliefs.push_back(&node);
            }
            continue;
        }
        const std::string frameId = *node.frameId;
        nodeFrames[node.id.value] = frameId;
        if (node.family == NodeFamily::Plan) plansByFrame[frameId].push_back(&node);
        else if (node.family == NodeFamily::Execution) executionsByFrame[frameId].push_back(&node);
        else if (node.family == NodeFamily::Distill) distillationsByFrame[frameId].push_back(&node);
        else if (node.family == NodeFamily::Propose) proposeByFrame[frameId].push_back(&node);
    }

    sortByOrder(beliefs, [](const GraphNode& node) { return node.creationOrder; });
    for (const LoopFrameInfo& frame : state.frames) {
        sortByOrder(plansByFrame[frame.id], [](const GraphNode& node) { return node.creationOrder; });
        sortByOrder(executionsByFrame[frame.id], [](const GraphNode& node) {
            return node.executionOrder.value_or(node.creationOrder);
        });
        sortByOrder(distillationsByFrame[frame.id], [](const GraphNode& node) { return node.creationOrder; });
        sortByOrder(proposeByFrame[frame.id], [](const GraphNode& node) { return node.creationOrder; });
    }

    // Assign each global Belief to the row where it first appeared. Beliefs
    // without creation provenance form the initial group in the first row.
    std::map<std::string, std::vector<const GraphNode*>> beliefsByFrame;
    std::vector<const GraphNode*> unanchoredBeliefs;
    for (const GraphNode* belief : beliefs) {
        std::optional<std::string> created = inferredCreationFrame(
            *belief, nodeFrames, frameOrder, state.edges);
        if (created && frameOrder.count(*created)) {
            beliefsByFrame[*created].push_back(belief);
        } else {
            unanchoredBeliefs.push_back(belief);
        }
    }
    if (!state.frames.empty()) {
        auto& first = beliefsByFrame[state.frames.front().id];
        first.insert(first.begin(), unanchoredBeliefs.begin(), unanchoredBeliefs.end());
    }

    std::size_t maxPlanCount = 1;
    std::size_t maxDistillCount = 1;
    std::size_t maxProposeCount = 1;
    for (const LoopFrameInfo& frame : state.frames) {
        maxPlanCount = std::max(maxPlanCount, plansByFrame[frame.id].size());
        maxDistillCount = std::max(maxDistillCount, distillationsByFrame[frame.id].size());
        maxProposeCount = std::max(maxProposeCount, proposeByFrame[frame.id].size());
    }

    const float beliefX = st.canvasPad + st.beliefAnnotationWidth;
    const float middleX = beliefX + st.nodeW + st.regionGap;
    const float middleW = std::max({sequenceWidth(maxPlanCount),
                                    sequenceWidth(maxDistillCount),
                                    sequenceWidth(maxProposeCount)});
    const float executionX = middleX + middleW + st.regionGap;
    const float contentTop = st.canvasPad + st.columnHeaderHeight;

    // Framing (Target) beliefs anchor below the latest episode as a whole.
    std::vector<const GraphNode*> globalFraming;
    for (const LoopFrameInfo& frame : state.frames) {
        for (const GraphNode* b : beliefsByFrame[frame.id]) {
            if (b->domain == "framing") globalFraming.push_back(b);
        }
    }
    sortByOrder(globalFraming, [](const GraphNode& node) { return node.creationOrder; });

    const float framingH = globalFraming.empty()
        ? 0.0f
        : stackHeight(globalFraming.size()) + st.framePad;
    const float loopAreaTop = contentTop;
    float rowTop = loopAreaTop;

    for (const LoopFrameInfo& frame : state.frames) {
        const auto& planNodes = plansByFrame[frame.id];
        const auto& executionNodes = executionsByFrame[frame.id];
        const auto& distillNodes = distillationsByFrame[frame.id];
        const auto& proposeNodes = proposeByFrame[frame.id];
        const auto& beliefNodes = beliefsByFrame[frame.id];

        // Routing beliefs are re-anchored directly ABOVE their owning frame's
        // box (centered on it), so they are pulled out of the belief column; the
        // world (non-routing, non-framing) beliefs stay in the left column.
        std::vector<const GraphNode*> routingNodes;
        std::vector<const GraphNode*> column;
        for (const GraphNode* b : beliefNodes) {
            if (b->domain == "routing") routingNodes.push_back(b);
            else if (b->domain != "framing") column.push_back(b);
        }
        // Reserve a routing slot above the owning frame box: it holds either a
        // legacy routing belief card stack (domain == "routing") or the frame's
        // own routing-decision text (the real Routing step), whichever is present.
        const bool hasRoutingText =
            !frame.routingDecision.empty() || !frame.routingReason.empty();
        const float routingSlotH =
            (routingNodes.empty()
                 ? 0.0f
                 : stackHeight(routingNodes.size()) + st.phaseBandGap) +
            (hasRoutingText ? st.routingTextSlotH : 0.0f);

        const float planH = planNodes.empty() ? 0.0f : st.nodeH;
        const float distillH = distillNodes.empty() ? 0.0f : st.nodeH;
        const float proposeH = proposeNodes.empty() ? 0.0f : stackHeight(proposeNodes.size());
        float middleH = 0.0f;
        int middleBands = 0;
        if (planH > 0.0f) { middleH += planH; ++middleBands; }
        if (proposeH > 0.0f) { middleH += proposeH; ++middleBands; }
        if (distillH > 0.0f) { middleH += distillH; ++middleBands; }
        if (middleBands > 1) middleH += static_cast<float>(middleBands - 1) * st.phaseBandGap;
        const float contentH = std::max({st.nodeH, middleH,
                                         stackHeight(executionNodes.size()),
                                         stackHeight(column.size())});
        const float blockH = contentH + st.framePad * 2.0f;

        const float frameTop = rowTop + routingSlotH;
        const float frameBottom = frameTop + blockH;
        const float nodeTop = frameTop + st.framePad;
        // Middle band vertical order: Plan (top), Distillation (middle),
        // Propose (bottom). Distillation sits directly below the Plan band;
        // the Propose stack is anchored to the block bottom.
        const float distillY = nodeTop + planH + (planH > 0.0f ? st.phaseBandGap : 0.0f);
        const bool isLastFrame = &frame == &state.frames.back();
        const float framingSlotH = (isLastFrame && !globalFraming.empty()) ? framingH : 0.0f;

        for (std::size_t i = 0; i < column.size(); ++i) {
            out.nodeRects[column[i]->id.value] = GraphRect{
                beliefX,
                nodeTop + static_cast<float>(i) * (st.nodeH + st.nodeGapV),
                st.nodeW,
                st.nodeH,
            };
        }
        // Routing nodes sit directly above the owning frame box, horizontally
        // centered on the box (frameCenterX = box center x).
        const float frameCenterX = (middleX + executionX + st.nodeW) * 0.5f;
        for (std::size_t i = 0; i < routingNodes.size(); ++i) {
            out.nodeRects[routingNodes[i]->id.value] = GraphRect{
                frameCenterX - st.nodeW * 0.5f,
                rowTop + static_cast<float>(i) * (st.nodeH + st.nodeGapV),
                st.nodeW,
                st.nodeH,
            };
        }
        for (std::size_t i = 0; i < planNodes.size(); ++i) {
            out.nodeRects[planNodes[i]->id.value] = GraphRect{
                middleX + static_cast<float>(i) * (st.nodeW + st.nodeGapH),
                nodeTop,
                st.nodeW,
                st.nodeH,
            };
        }
        float proposeY = frameTop + blockH - st.framePad - proposeH;
        for (std::size_t i = 0; i < proposeNodes.size(); ++i) {
            out.nodeRects[proposeNodes[i]->id.value] = GraphRect{
                middleX,
                proposeY + static_cast<float>(i) * (st.nodeH + st.nodeGapV),
                st.nodeW,
                st.nodeH,
            };
        }
        GraphRect proposeBounds = paddedBounds(proposeNodes, out.nodeRects, st.framePad * 0.5f);
        if (proposeBounds.w > 0.0f) out.proposeRegionRects[frame.id] = proposeBounds;
        for (std::size_t i = 0; i < executionNodes.size(); ++i) {
            out.nodeRects[executionNodes[i]->id.value] = GraphRect{
                executionX,
                nodeTop + static_cast<float>(i) * (st.nodeH + st.nodeGapV),
                st.nodeW,
                st.nodeH,
            };
        }
        for (std::size_t i = 0; i < distillNodes.size(); ++i) {
            out.nodeRects[distillNodes[i]->id.value] = GraphRect{
                middleX + static_cast<float>(i) * (st.nodeW + st.nodeGapH),
                distillY,
                st.nodeW,
                st.nodeH,
            };
        }

        out.frameRects[frame.id] = GraphRect{
            middleX - st.framePad,
            frameTop,
            executionX + st.nodeW - middleX + st.framePad * 2.0f,
            blockH,
        };
        out.planRegionRects[frame.id] = GraphRect{
            middleX - st.framePad * 0.5f,
            frameTop + st.framePad * 0.5f,
            middleW + st.framePad,
            blockH * 0.5f - st.framePad * 0.5f,
        };
        out.distillRegionRects[frame.id] = GraphRect{
            middleX - st.framePad * 0.5f,
            frameTop + blockH * 0.5f,
            middleW + st.framePad,
            blockH * 0.5f - st.framePad * 0.5f,
        };
        out.executionRegionRects[frame.id] = GraphRect{
            executionX - st.framePad * 0.5f,
            frameTop + st.framePad * 0.5f,
            st.nodeW + st.framePad,
            blockH - st.framePad,
        };

        GraphRect createdBounds = paddedBounds(column, out.nodeRects, st.framePad * 0.5f);
        if (createdBounds.w > 0.0f) out.beliefRegionRects[frame.id] = createdBounds;

        rowTop = frameBottom + framingSlotH + st.rowGap;
    }

    // Global framing slot: the framing (Target) beliefs anchor below the LATEST
    // episode/loop-frame, so their position follows the newest frame dynamically
    // instead of being fixed to a frame boundary.
    if (!state.frames.empty() && !globalFraming.empty()) {
        auto lastIt = out.frameRects.find(state.frames.back().id);
        float lastBottom = (lastIt != out.frameRects.end())
            ? lastIt->second.y + lastIt->second.h
            : loopAreaTop;
        // Framing (Target) cards anchor directly below the latest episode box,
        // horizontally centered on it.
        float framingCenterX = beliefX;
        if (lastIt != out.frameRects.end()) {
            const GraphRect& fr = lastIt->second;
            framingCenterX = fr.x + fr.w * 0.5f;
        }
        float fy = lastBottom;
        for (const GraphNode* b : globalFraming) {
            out.nodeRects[b->id.value] = GraphRect{
                framingCenterX - st.nodeW * 0.5f, fy, st.nodeW, st.nodeH};
            fy += st.nodeH + st.nodeGapV;
        }
    }

    if (state.frames.empty()) {
        for (std::size_t i = 0; i < columnBeliefs.size(); ++i) {
            out.nodeRects[columnBeliefs[i]->id.value] = GraphRect{
                beliefX,
                contentTop + static_cast<float>(i) * (st.nodeH + st.nodeGapV),
                st.nodeW,
                st.nodeH,
            };
        }
        rowTop = contentTop + stackHeight(columnBeliefs.size());
    }

    out.beliefColumnRect = paddedBounds(columnBeliefs, out.nodeRects, st.framePad * 0.5f);
    if (out.beliefColumnRect.w <= 0.0f) {
        out.beliefColumnRect = GraphRect{beliefX - st.framePad * 0.5f,
                                         contentTop,
                                         st.nodeW + st.framePad,
                                         st.nodeH};
    }

    out.canvasWidth = executionX + st.nodeW + st.framePad +
                      st.frameLabelWidth + st.canvasPad;
    out.canvasHeight = std::max(rowTop - st.rowGap + st.canvasPad,
                                out.beliefColumnRect.y + out.beliefColumnRect.h + st.canvasPad);
    if (state.frames.empty()) {
        out.canvasHeight = std::max(out.canvasHeight,
                                    contentTop + st.nodeH + st.canvasPad);
    }
    return out;
}

} // namespace pie::gui
