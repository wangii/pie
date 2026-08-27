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

std::optional<int> inferredCreationFrame(
    const GraphNode& belief,
    const std::map<std::string, int>& nodeFrames,
    const std::map<int, std::size_t>& frameOrder,
    const std::vector<GraphEdge>& edges) {
    if (belief.createdInFrame) return belief.createdInFrame;

    std::optional<int> result;
    std::size_t bestOrder = frameOrder.size();
    for (const GraphEdge& edge : edges) {
        if (edge.type != EdgeSemanticType::DistillToBelief ||
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

    std::map<int, std::size_t> frameOrder;
    std::map<int, std::vector<const GraphNode*>> plansByFrame;
    std::map<int, std::vector<const GraphNode*>> executionsByFrame;
    std::map<int, std::vector<const GraphNode*>> distillationsByFrame;
    std::map<std::string, int> nodeFrames;
    std::vector<const GraphNode*> beliefs;

    for (std::size_t i = 0; i < state.frames.size(); ++i) {
        frameOrder[state.frames[i].id] = i;
    }
    for (const GraphNode& node : state.nodes) {
        if (node.family == NodeFamily::Belief || !node.frameId) {
            beliefs.push_back(&node);
            continue;
        }
        const int frameId = *node.frameId;
        nodeFrames[node.id.value] = frameId;
        if (node.family == NodeFamily::Plan) plansByFrame[frameId].push_back(&node);
        else if (node.family == NodeFamily::Execution) executionsByFrame[frameId].push_back(&node);
        else if (node.family == NodeFamily::Distill) distillationsByFrame[frameId].push_back(&node);
    }

    sortByOrder(beliefs, [](const GraphNode& node) { return node.creationOrder; });
    for (const LoopFrameInfo& frame : state.frames) {
        sortByOrder(plansByFrame[frame.id], [](const GraphNode& node) { return node.creationOrder; });
        sortByOrder(executionsByFrame[frame.id], [](const GraphNode& node) {
            return node.executionOrder.value_or(node.creationOrder);
        });
        sortByOrder(distillationsByFrame[frame.id], [](const GraphNode& node) { return node.creationOrder; });
    }

    // Assign each global Belief to the row where it first appeared. Beliefs
    // without creation provenance form the initial group in the first row.
    std::map<int, std::vector<const GraphNode*>> beliefsByFrame;
    std::map<int, std::vector<const GraphNode*>> createdBeliefsByFrame;
    std::vector<const GraphNode*> unanchoredBeliefs;
    for (const GraphNode* belief : beliefs) {
        std::optional<int> created = inferredCreationFrame(
            *belief, nodeFrames, frameOrder, state.edges);
        if (created && frameOrder.count(*created)) {
            beliefsByFrame[*created].push_back(belief);
            createdBeliefsByFrame[*created].push_back(belief);
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
    for (const LoopFrameInfo& frame : state.frames) {
        maxPlanCount = std::max(maxPlanCount, plansByFrame[frame.id].size());
        maxDistillCount = std::max(maxDistillCount, distillationsByFrame[frame.id].size());
    }

    const float beliefX = st.canvasPad + st.beliefAnnotationWidth;
    const float middleX = beliefX + st.nodeW + st.regionGap;
    const float middleW = std::max(sequenceWidth(maxPlanCount), sequenceWidth(maxDistillCount));
    const float executionX = middleX + middleW + st.regionGap;
    const float contentTop = st.canvasPad + st.columnHeaderHeight;
    float rowTop = contentTop;

    for (const LoopFrameInfo& frame : state.frames) {
        const auto& planNodes = plansByFrame[frame.id];
        const auto& executionNodes = executionsByFrame[frame.id];
        const auto& distillNodes = distillationsByFrame[frame.id];
        const auto& beliefNodes = beliefsByFrame[frame.id];

        const float planH = planNodes.empty() ? 0.0f : st.nodeH;
        const float distillH = distillNodes.empty() ? 0.0f : st.nodeH;
        const float middleH = planH + distillH +
            ((planH > 0.0f && distillH > 0.0f) ? st.phaseBandGap : 0.0f);
        const float contentH = std::max({st.nodeH, middleH,
                                         stackHeight(executionNodes.size()),
                                         stackHeight(beliefNodes.size())});
        const float rowH = contentH + st.framePad * 2.0f;
        const float nodeTop = rowTop + st.framePad;
        const float distillY = rowTop + rowH - st.framePad - st.nodeH;

        for (std::size_t i = 0; i < beliefNodes.size(); ++i) {
            out.nodeRects[beliefNodes[i]->id.value] = GraphRect{
                beliefX,
                nodeTop + static_cast<float>(i) * (st.nodeH + st.nodeGapV),
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
            rowTop,
            executionX + st.nodeW - middleX + st.framePad * 2.0f,
            rowH,
        };
        out.planRegionRects[frame.id] = GraphRect{
            middleX - st.framePad * 0.5f,
            rowTop + st.framePad * 0.5f,
            middleW + st.framePad,
            rowH * 0.5f - st.framePad * 0.5f,
        };
        out.distillRegionRects[frame.id] = GraphRect{
            middleX - st.framePad * 0.5f,
            rowTop + rowH * 0.5f,
            middleW + st.framePad,
            rowH * 0.5f - st.framePad * 0.5f,
        };
        out.executionRegionRects[frame.id] = GraphRect{
            executionX - st.framePad * 0.5f,
            rowTop + st.framePad * 0.5f,
            st.nodeW + st.framePad,
            rowH - st.framePad,
        };

        const auto& created = createdBeliefsByFrame[frame.id];
        GraphRect createdBounds = paddedBounds(created, out.nodeRects, st.framePad * 0.5f);
        if (createdBounds.w > 0.0f) out.beliefRegionRects[frame.id] = createdBounds;

        rowTop += rowH + st.rowGap;
    }

    // A belief-only state still has a useful layout before the first frame.
    if (state.frames.empty()) {
        for (std::size_t i = 0; i < beliefs.size(); ++i) {
            out.nodeRects[beliefs[i]->id.value] = GraphRect{
                beliefX,
                contentTop + static_cast<float>(i) * (st.nodeH + st.nodeGapV),
                st.nodeW,
                st.nodeH,
            };
        }
        rowTop = contentTop + stackHeight(beliefs.size());
    }

    out.beliefColumnRect = paddedBounds(beliefs, out.nodeRects, st.framePad * 0.5f);
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
