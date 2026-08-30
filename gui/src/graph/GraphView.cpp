// GraphView.cpp: custom read-only ImGui node canvas (Phase 2 M0 + M2).
//
// Draws the GraphTaskState nodes/edges onto the current ImGui window using a
// pan/zoom transform. A node is a small family/status indicator dot followed by
// a free-standing text label (status/result color, current/selected ring and
// accent, tooltip) -- it is not a card wrapping its text. The canvas is
// read-only: no drag, no link create/delete, no semantic mutation.
//
// Phase 2 M8/M9 integration plus the M7 Focus Current navigation and the Stage
// indicator are drawn here (view layer); the Focus Current pan geometry comes
// from GraphNavigation; the dependency set and edge routes come from the
// GraphCache; and every visual constant comes from the centralized GraphStyle
// (kGraphStyle) instead of being inlined as literals.

#include "graph/GraphView.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <optional>
#include <string>
#include <vector>

#include <imgui.h>

#include "Model.h"
#include "graph/GraphStyle.h"
#include "graph/GraphLabelLayout.h"
#include "graph/GraphNavigation.h"
#include "graph/GraphRouting.h"

namespace pie::gui {

namespace {

constexpr const GraphStyle& st = kGraphStyle;  // single style entry point

// The Stage indicator label / color for the runtime's explicit frame stage. The
// stage comes only from the runtime (model.cursor().stage), never inferred here.
const char* stageLabel(FrameStage s) {
    switch (s) {
        case FrameStage::ROUTING: return "Route";
        case FrameStage::PROPOSING: return "Propose";
        case FrameStage::PLANNING: return "Plan";
        case FrameStage::EXECUTING: return "Execution";
        case FrameStage::DISTILLING: return "Distillation";
        case FrameStage::CLOSED: return "Close";
        case FrameStage::NONE: break;
    }
    return "Idle";
}

ImU32 stageColor(FrameStage s) {
    auto rgb = [](const GraphStyle::Rgb& c) { return IM_COL32(c.r, c.g, c.b, 255); };
    switch (s) {
        case FrameStage::ROUTING: return rgb(st.beliefRegionLabel);
        case FrameStage::PROPOSING: return rgb(st.beliefRegionLabel);
        case FrameStage::PLANNING: return rgb(st.planRegionLabel);
        case FrameStage::EXECUTING: return rgb(st.executionRegionLabel);
        case FrameStage::DISTILLING: return rgb(st.distillRegionLabel);
        case FrameStage::CLOSED: return rgb(st.frameBorder);
        case FrameStage::NONE: break;
    }
    return rgb(st.textBody);
}

// Card colors by family. Result color for Execution is derived from status.
ImU32 cardColor(NodeFamily f, const GraphNode& n, bool selected, bool current) {
    if (selected) return IM_COL32(st.cardSelected.r, st.cardSelected.g, st.cardSelected.b, 255);
    if (current) return IM_COL32(st.cardCurrent.r, st.cardCurrent.g, st.cardCurrent.b, 255);
    switch (f) {
        case NodeFamily::Belief:
            // Framing beliefs (the revisable "target" obligations) carry a
            // distinct domain color; routing is no longer a belief domain.
            if (n.domain == "framing") return IM_COL32(st.cardBeliefFraming.r, st.cardBeliefFraming.g, st.cardBeliefFraming.b, 255);
            if (n.displayType == "refuted" || n.displayType == "falsified") return IM_COL32(st.cardBeliefFalsified.r, st.cardBeliefFalsified.g, st.cardBeliefFalsified.b, 255);
            if (n.displayType == "revised") return IM_COL32(st.cardBeliefRevised.r, st.cardBeliefRevised.g, st.cardBeliefRevised.b, 255);
            if (n.displayType == "closed") return IM_COL32(st.cardBeliefClosed.r, st.cardBeliefClosed.g, st.cardBeliefClosed.b, 255);
            if (n.displayType == "supported") return IM_COL32(st.cardBeliefSupported.r, st.cardBeliefSupported.g, st.cardBeliefSupported.b, 255);
            if (n.displayType == "superseded" || n.displayType == "supersede") return IM_COL32(st.cardBeliefSuperseded.r, st.cardBeliefSuperseded.g, st.cardBeliefSuperseded.b, 255);
            return IM_COL32(st.cardBelief.r, st.cardBelief.g, st.cardBelief.b, 255);
        case NodeFamily::Plan: return IM_COL32(st.cardPlan.r, st.cardPlan.g, st.cardPlan.b, 255);
        case NodeFamily::Execution:
            if (n.displayType == "failed") return IM_COL32(st.cardExecFailed.r, st.cardExecFailed.g, st.cardExecFailed.b, 255);
            if (n.displayType == "ok") return IM_COL32(st.cardExecOk.r, st.cardExecOk.g, st.cardExecOk.b, 255);
            return IM_COL32(st.cardExecRunning.r, st.cardExecRunning.g, st.cardExecRunning.b, 255);
        case NodeFamily::Distill: return IM_COL32(st.cardDistill.r, st.cardDistill.g, st.cardDistill.b, 255);
        case NodeFamily::Propose: return IM_COL32(st.cardPropose.r, st.cardPropose.g, st.cardPropose.b, 255);
    }
    return IM_COL32(st.cardDefault.r, st.cardDefault.g, st.cardDefault.b, 255);
}

// Emphasize the selected node and its dependency path; de-emphasize the rest
// when a dependency query is active. Non-selected nodes outside the dependency
// set are dimmed (Muted). `dep` is the dependency set derived by the m5
// selection pass; empty means no selection query is active.
float nodeAlpha(const GraphNode& n, const std::set<std::string>& dep) {
    if (dep.empty()) return 1.0f;
    if (dep.count(n.id.value)) return 1.0f;
    return st.dimMuted;  // Muted / dim the rest during a selection query.
}

ImU32 edgeColor(EdgeSemanticType t, float alpha) {
    if (alpha < 0.5f) return IM_COL32(st.edgeMuted.r, st.edgeMuted.g, st.edgeMuted.b, (int)(st.edgeMutedAlphaScale * alpha));
    switch (t) {
        case EdgeSemanticType::BeliefToPlan: return IM_COL32(st.edgeBeliefToPlan.r, st.edgeBeliefToPlan.g, st.edgeBeliefToPlan.b, 255);
        case EdgeSemanticType::PlanToExecution: return IM_COL32(st.edgePlanToExecution.r, st.edgePlanToExecution.g, st.edgePlanToExecution.b, 255);
        case EdgeSemanticType::ExecutionToDistill: return IM_COL32(st.edgeExecutionToDistill.r, st.edgeExecutionToDistill.g, st.edgeExecutionToDistill.b, 255);
        case EdgeSemanticType::DistillToBelief: return IM_COL32(st.edgeDistillToBelief.r, st.edgeDistillToBelief.g, st.edgeDistillToBelief.b, 255);
        case EdgeSemanticType::DistillToPropose: return IM_COL32(st.edgeDistillToPropose.r, st.edgeDistillToPropose.g, st.edgeDistillToPropose.b, 255);
        case EdgeSemanticType::ProposeToBelief: return IM_COL32(st.edgeProposeToBelief.r, st.edgeProposeToBelief.g, st.edgeProposeToBelief.b, 255);
    }
    return IM_COL32(st.edgeMuted.r, st.edgeMuted.g, st.edgeMuted.b, 255);
}

// ImGui has no dashed-rect primitive (ImDrawFlags only exposes rounding bounds +
// Closed), so a dashed LoopFrame boundary is drawn as four dashed line segments.
void drawDashedRect(ImDrawList* dl, const ImVec2& p0, const ImVec2& p1, ImU32 col, float thickness, float zoom) {
    const float dash = 6.0f * zoom;
    const float gap = 4.0f * zoom;
    auto seg = [&](ImVec2 a, ImVec2 b) {
        float dx = b.x - a.x, dy = b.y - a.y;
        float len = std::sqrt(dx * dx + dy * dy);
        if (len < 1e-3f) return;
        float ux = dx / len, uy = dy / len;
        for (float d = 0.0f; d < len; d += dash + gap) {
            float e = std::min(d + dash, len);
            dl->AddLine(ImVec2(a.x + ux * d, a.y + uy * d), ImVec2(a.x + ux * e, a.y + uy * e), col, thickness);
        }
    };
    seg(ImVec2(p0.x, p0.y), ImVec2(p1.x, p0.y));
    seg(ImVec2(p1.x, p0.y), ImVec2(p1.x, p1.y));
    seg(ImVec2(p1.x, p1.y), ImVec2(p0.x, p1.y));
    seg(ImVec2(p0.x, p1.y), ImVec2(p0.x, p0.y));
}

void drawDashedLine(ImDrawList* dl, const ImVec2& a, const ImVec2& b,
                    ImU32 col, float thickness, float zoom) {
    const float dx = b.x - a.x;
    const float dy = b.y - a.y;
    const float length = std::sqrt(dx * dx + dy * dy);
    if (length < 1e-3f) return;
    const float ux = dx / length;
    const float uy = dy / length;
    const float dash = 6.0f * zoom;
    const float gap = 4.0f * zoom;
    for (float offset = 0.0f; offset < length; offset += dash + gap) {
        const float end = std::min(offset + dash, length);
        dl->AddLine(ImVec2(a.x + ux * offset, a.y + uy * offset),
                    ImVec2(a.x + ux * end, a.y + uy * end), col, thickness);
    }
}
} // namespace

bool renderGraphView(GraphViewState& view, const GraphTaskState& state, const PieGraphLayout& layout, FrameStage stage, const std::string& cwd) {
    bool selectionChanged = false;

    ImGuiIO& io = ImGui::GetIO();
    ImDrawList* dl = ImGui::GetWindowDrawList();
    ImVec2 origin = ImGui::GetCursorScreenPos();
    ImVec2 avail = ImGui::GetContentRegionAvail();

    // --- Focus Current (explicit): F centers the current node (no modifier, so
    // it does not clash with Cmd+F file-list or the ':' prompt palette). ---
    if (ImGui::IsWindowHovered() && ImGui::IsKeyPressed(ImGuiKey_F, false) && state.currentNode) {
        view.focusCurrentOnce = state.currentNode->value;
    }

    // --- Background grid (static, calm) ---
    const float gridStep = st.gridStep * view.zoom;
    ImVec2 gridSize(avail.x, avail.y);
    dl->AddRectFilled(origin, ImVec2(origin.x + gridSize.x, origin.y + gridSize.y), IM_COL32(st.canvasBg.r, st.canvasBg.g, st.canvasBg.b, 255));
    ImU32 gridCol = IM_COL32(st.gridLine.r, st.gridLine.g, st.gridLine.b, st.gridLineAlpha);
    float x = origin.x - std::fmod(origin.x + view.panX, gridStep);
    for (; x < origin.x + gridSize.x; x += gridStep) dl->AddLine(ImVec2(x, origin.y), ImVec2(x, origin.y + gridSize.y), gridCol);
    float y = origin.y - std::fmod(origin.y + view.panY, gridStep);
    for (; y < origin.y + gridSize.y; y += gridStep) dl->AddLine(ImVec2(origin.x, y), ImVec2(origin.x + gridSize.x, y), gridCol);

    // --- Pan / zoom via mouse ---
    if (io.MouseWheel != 0.0f && ImGui::IsWindowHovered()) {
        view.zoom = std::clamp(view.zoom + io.MouseWheel * st.zoomStep, st.zoomMin, st.zoomMax);
    }
    if (ImGui::IsMouseDragging(ImGuiMouseButton_Middle) || ImGui::IsMouseDragging(ImGuiMouseButton_Right)) {
        view.panX += io.MouseDelta.x;
        view.panY += io.MouseDelta.y;
    }

    auto toScreen = [&](float gx, float gy) -> ImVec2 {
        return ImVec2(origin.x + view.panX + gx * view.zoom,
                      origin.y + view.panY + gy * view.zoom);
    };

    // --- Semantic region surfaces ---
    auto drawSurface = [&](const GraphRect& rect, const GraphStyle::Rgb& fill) {
        ImVec2 p0 = toScreen(rect.x, rect.y);
        ImVec2 p1 = toScreen(rect.x + rect.w, rect.y + rect.h);
        dl->AddRectFilled(p0, p1,
                          IM_COL32(fill.r, fill.g, fill.b, st.regionFillAlpha),
                          st.frameRadius);
        drawDashedRect(dl, p0, p1,
                       IM_COL32(st.frameBorder.r, st.frameBorder.g,
                                st.frameBorder.b, 70),
                       view.zoom, view.zoom);
    };
    drawSurface(layout.beliefColumnRect, st.beliefRegionFill);
    for (const auto& [frameId, rect] : layout.planRegionRects) {
        (void)frameId;
        drawSurface(rect, st.planRegionFill);
    }
    for (const auto& [frameId, rect] : layout.distillRegionRects) {
        (void)frameId;
        drawSurface(rect, st.distillRegionFill);
    }
    for (const auto& [frameId, rect] : layout.proposeRegionRects) {
        (void)frameId;
        drawSurface(rect, st.proposeRegionFill);
    }
    for (const auto& [frameId, rect] : layout.executionRegionRects) {
        (void)frameId;
        drawSurface(rect, st.executionRegionFill);
    }

    // --- LoopFrame row boundaries ---
    for (const auto& fi : state.frames) {
        auto it = layout.frameRects.find(fi.id);
        if (it == layout.frameRects.end()) continue;
        GraphRect r = it->second;
        ImVec2 p0 = toScreen(r.x, r.y);
        ImVec2 p1 = toScreen(r.x + r.w, r.y + r.h);
        drawDashedRect(dl, p0, p1, IM_COL32(st.frameBorder.r, st.frameBorder.g, st.frameBorder.b, st.frameBorderAlpha), st.frameBorderWidth * view.zoom, view.zoom);
        // Label is drawn at an explicit position via AddText; do NOT SetCursorScreenPos
        // here (it submits no item, leaving IsSetPos set and triggering the
        // "SetCursorPos() to extend window/parent boundaries" assert at End()).
        dl->AddText(ImVec2(p1.x + st.frameLabelPadX,
                           (p0.y + p1.y) * 0.5f - 7.0f),
                    IM_COL32(st.frameLabel.r, st.frameLabel.g, st.frameLabel.b, st.frameLabelAlpha), fi.label.c_str());
        // Routing decision (from the RoutingDecided event) drawn centered ABOVE
        // the frame box: the layout reserves a routing slot (routingTextSlotH)
        // above each frame with a routing decision, so this text never overlaps
        // the preceding row.
        if (!fi.routingDecision.empty() || !fi.routingReason.empty()) {
            std::string route = "Route: " + (fi.routingDecision.empty() ? "?" : fi.routingDecision);
            if (!fi.routingReason.empty()) route += "  (" + fi.routingReason + ")";
            ImVec2 ts = ImGui::CalcTextSize(route.c_str());
            dl->AddText(ImVec2((p0.x + p1.x) * 0.5f - ts.x * 0.5f,
                               p0.y - ts.y - 4.0f),
                        IM_COL32(st.beliefRoutingLabel.r, st.beliefRoutingLabel.g,
                                 st.beliefRoutingLabel.b, 230),
                        route.c_str());
        }
    }

    // Each new-belief group is marked at the top of the LoopFrame that created
    // it. The cards themselves remain in the one global creation-order column.
    for (std::size_t i = 0; i < state.frames.size(); ++i) {
        auto it = layout.beliefRegionRects.find(state.frames[i].id);
        if (it == layout.beliefRegionRects.end()) continue;
        ImVec2 p0 = toScreen(it->second.x, it->second.y);
        ImVec2 p1 = toScreen(it->second.x + it->second.w,
                             it->second.y + it->second.h);
        drawDashedRect(dl, p0, p1,
                       IM_COL32(st.beliefRegionLabel.r, st.beliefRegionLabel.g,
                                st.beliefRegionLabel.b, 120),
                       view.zoom, view.zoom);
        // char label[80];
        // std::snprintf(label, sizeof(label), "Round %zu\nnew beliefs", i + 1);
        // dl->AddText(toScreen(it->second.x - st.beliefAnnotationWidth + 8.0f,
        //                      it->second.y + 4.0f),
        //             IM_COL32(st.beliefRegionLabel.r, st.beliefRegionLabel.g,
        //                      st.beliefRegionLabel.b, 230), label);
    }

    // --- Edges: typed, directed, routed (m4). Belief read/write edges use
    // orthogonal cross-region routes; local edges keep a short curve. The m5
    // dependency set drives emphasis on selection.
    // Both the dependency set and the routes come from the M8 cache (recomputed
    // only when the state / layout changed).
    const std::set<std::string>& dep = view.cache.getDependencySet(state, view.selectedNode, view.cacheMetrics);
    auto nodeCenter = [&](const std::string& id) -> std::optional<ImVec2> {
        auto it = layout.nodeRects.find(id);
        if (it == layout.nodeRects.end()) return std::nullopt;
        GraphRect r = it->second;
        return toScreen(r.x + r.w * 0.5f, r.y + r.h * 0.5f);
    };
    const std::vector<EdgeRoute>& routes = view.cache.getRoutes(state, layout, view.cacheMetrics);
    for (const EdgeRoute& route : routes) {
        if (route.points.size() < 2) continue;
        auto toPx = [&](float gx, float gy) { return toScreen(gx, gy); };
        // Emphasis: strong when the route is on the selected dependency path,
        // subdued for long routes by default (m4 default-dim rule).
        bool onPath = dep.empty() || dep.count(route.source.value) || dep.count(route.target.value);
        float alpha = dep.empty() ? (route.longRoute ? st.edgeAlphaLongDefault : st.edgeAlphaLocalDefault)
                                  : (onPath ? st.edgeAlphaPath : st.edgeAlphaOffPath);
        ImU32 col = edgeColor(route.type, alpha);
        if (route.longRoute) {
            const bool dashedCreate = edgeIsCreate(route.type, route.beliefOperation);
            for (size_t i = 0; i + 1 < route.points.size(); ++i) {
                ImVec2 a = toPx(route.points[i].first, route.points[i].second);
                ImVec2 b = toPx(route.points[i + 1].first, route.points[i + 1].second);
                if (dashedCreate) {
                    drawDashedLine(dl, a, b, col,
                                   st.edgeWidthLong * view.zoom, view.zoom);
                } else {
                    dl->AddLine(a, b, col, st.edgeWidthLong * view.zoom);
                }
            }
        } else {
            // Local curve: source -> mid control -> target.
            ImVec2 s = toPx(route.points[0].first, route.points[0].second);
            ImVec2 t = toPx(route.points.back().first, route.points.back().second);
            ImVec2 mid = toPx(route.points[1].first, route.points[1].second);
            dl->AddBezierCubic(s, mid, mid, t, col, st.edgeWidthLocal * view.zoom);
        }
        // Arrowhead toward the target.
        ImVec2 s = toPx(route.points[0].first, route.points[0].second);
        ImVec2 t = toPx(route.points.back().first, route.points.back().second);
        ImVec2 dir(t.x - s.x, t.y - s.y);
        float len = std::sqrt(dir.x * dir.x + dir.y * dir.y);
        if (len > 1e-3f) {
            dir.x /= len; dir.y /= len;
            ImVec2 base(t.x - dir.x * st.arrowheadSize, t.y - dir.y * st.arrowheadSize);
            ImVec2 n(-dir.y, dir.x);
            dl->AddTriangleFilled(t, ImVec2(base.x + n.x * st.arrowheadHalf, base.y + n.y * st.arrowheadHalf),
                                  ImVec2(base.x - n.x * st.arrowheadHalf, base.y - n.y * st.arrowheadHalf), col);
        }
    }

    // --- Nodes: an indicator glyph in front of a free-standing text label. The
    // node is no longer a card that wraps its text; it is a small family/status
    // indicator (colored dot, or the execution status mark) followed by the
    // label. The node rect still anchors edges, the hit-test and the tooltip. ---
    // The framing / "Target" belief nodes render LAST (they are drawn after every
    // other node) so the target kind is always the final node on the canvas. Node
    // positions come from computeGraphLayout, so this draw order does not change
    // the geometric alignment to the next loopframe's top border -- it only makes
    // the target the last-drawn element.
    auto drawNode = [&](const GraphNode& n) {
        auto it = layout.nodeRects.find(n.id.value);
        if (it == layout.nodeRects.end()) return;
        GraphRect r = it->second;
        bool selected = (view.selectedNode == n.id.value);
        bool current = (state.currentNode && state.currentNode->value == n.id.value);
        float alpha = nodeAlpha(n, dep);

        ImVec2 p0 = toScreen(r.x, r.y);
        ImVec2 p1 = toScreen(r.x + r.w, r.y + r.h);
        ImU32 fill = cardColor(n.family, n, selected, current);
        ImU32 textCol = IM_COL32(st.textBody.r, st.textBody.g, st.textBody.b, (int)(255 * alpha));

        std::string title;
        const char* execGlyph = nullptr;
        if (n.family == NodeFamily::Belief) {
            // Belief nodes show a category + number (B<n>) with a parenthesized
            // status suffix when the runtime supplies one; the descriptive content
            // lives in the hover tooltip below.
            title = beliefNodeTitle(n);
        } else if (n.family == NodeFamily::Plan) {
            title = "Plan";
        } else if (n.family == NodeFamily::Execution) {
            // Simplified "<tool> <command>" label (no "exec:" prefix, no wrap).
            title = n.title.empty() ? n.id.value : n.title;
            if (n.displayType == "ok") execGlyph = "✓";
            else if (n.displayType == "failed") execGlyph = "✗";
            else execGlyph = "●";
        } else if (n.family == NodeFamily::Propose) {
            title = n.title.empty() ? n.id.value : n.title;
        } else {
            title = "Distill";  // no "Distill " prefix; status shown by dot color
        }

        // Indicator dot, vertically centered at the node's left edge; the
        // execution status mark is drawn inside the dot for Execution nodes.
        const float cy = (p0.y + p1.y) * 0.5f;
        const float cxp = p0.x + st.indicatorRadius;
        dl->AddCircleFilled(ImVec2(cxp, cy), st.indicatorRadius, fill);
        if (execGlyph) {
            ImU32 gtext = IM_COL32(st.opGlyphText.r, st.opGlyphText.g, st.opGlyphText.b, (int)(255 * alpha));
            ImVec2 gts = ImGui::CalcTextSize(execGlyph);
            dl->AddText(ImVec2(cxp - gts.x * 0.5f, cy - gts.y * 0.5f), gtext, execGlyph);
        }
        // Selection / current ring around the indicator.
        ImU32 ring = selected ? IM_COL32(st.borderSelected.r, st.borderSelected.g, st.borderSelected.b, 255)
                     : current ? IM_COL32(st.borderCurrent.r, st.borderCurrent.g, st.borderCurrent.b, 255)
                     : IM_COL32(st.borderDefault.r, st.borderDefault.g, st.borderDefault.b, (int)(st.borderDefaultAlpha * alpha));
        dl->AddCircle(ImVec2(cxp, cy), st.indicatorRadius, ring, 0, st.cardBorderWidth * view.zoom);

        // Free-standing text label to the right of the indicator (not wrapped by
        // a card box).
        const float labelX = cxp + st.indicatorRadius + st.indicatorGap;
        ImVec2 ts = ImGui::CalcTextSize(title.c_str());
        // Keep the free-standing label's visible pixels inside the geometry used
        // for hit testing and layout.  The layout remains unchanged; long labels
        // are clipped rather than leaking into the adjacent phase band.
        const GraphRect clipRect = nodeLabelClipRect(r);
        const ImVec4 labelClip(toScreen(clipRect.x, clipRect.y).x,
                               toScreen(clipRect.x, clipRect.y).y,
                               toScreen(clipRect.x + clipRect.w, clipRect.y + clipRect.h).x,
                               toScreen(clipRect.x + clipRect.w, clipRect.y + clipRect.h).y);
        dl->AddText(ImGui::GetFont(), ImGui::GetFontSize(),
                    ImVec2(labelX, cy - ts.y * 0.5f), textCol, title.c_str(),
                    nullptr, 0.0f, &labelClip);

        // Current stage indicator (small accent bar) for the CURRENT node.
        if (current) {
            dl->AddRectFilled(p0, ImVec2(p0.x + st.currentBarWidth, p1.y), IM_COL32(st.currentAccent.r, st.currentAccent.g, st.currentAccent.b, 255));
        }

        // Selection hit test (only read-only select; no drag).
        if (ImGui::IsWindowHovered() && ImGui::IsMouseClicked(ImGuiMouseButton_Left) &&
            ImGui::IsMouseHoveringRect(p0, p1)) {
            view.selectedNode = n.id.value;
            selectionChanged = true;
        }

        // Tooltip on hover: the indicator label plus the previously-visible
        // compact content and the expanded text, so nothing descriptive is lost.
        // Plan and Distill nodes intentionally have no tooltip (user request).
        if (n.family != NodeFamily::Plan && n.family != NodeFamily::Distill &&
            ImGui::IsMouseHoveringRect(p0, p1)) {
            ImGui::BeginTooltip();
            // ImGui::TextUnformatted((title + "\n" + n.compactText + "\n" + n.fullText).c_str());
            ImGui::TextUnformatted(n.fullText.c_str());
            ImGui::EndTooltip();
        }
    };

    // Pass 1: every non-framing node, in model order.
    for (const auto& n : state.nodes) {
        if (n.family == NodeFamily::Belief && n.domain == "framing") continue;
        drawNode(n);
    }
    // Pass 2: the framing / "Target" belief nodes, drawn LAST.
    for (const auto& n : state.nodes) {
        if (n.family != NodeFamily::Belief || n.domain != "framing") continue;
        drawNode(n);
    }

    // --- Legend: the five edge-semantic encodings (top-left overlay). ---
    {
        // Belief create is part of the propose write-back, not a separate
        // category: Propose->Belief is listed once, drawn dashed for the create
        // sub-state. Distillation->Belief is a distinct legacy semantic.
        const char* labels[] = {
            "Belief -> Plan   (read)",
            "Distillation -> Propose",
            "Propose -> Belief   (write back / create)",
            "Distillation -> Belief   (create)",
        };
        const EdgeSemanticType types[] = {
            EdgeSemanticType::BeliefToPlan,
            EdgeSemanticType::DistillToPropose,
            EdgeSemanticType::ProposeToBelief,
            EdgeSemanticType::DistillToBelief,
        };
        const float lgPad = 8.0f, lgLineH = 20.0f, lgRowGap = 6.0f;
        const float lgW = 330.0f;
        const float lgH = lgPad * 2.0f + (int)(sizeof(labels) / sizeof(labels[0])) * (lgLineH + lgRowGap);
        ImVec2 lg0(origin.x + lgPad,
                   origin.y + gridSize.y - lgH - lgPad);
        dl->AddRectFilled(lg0, ImVec2(lg0.x + lgW, lg0.y + lgH), IM_COL32(22, 24, 28, 220), st.frameRadius, 0);
        dl->AddRect(lg0, ImVec2(lg0.x + lgW, lg0.y + lgH), IM_COL32(st.frameBorder.r, st.frameBorder.g, st.frameBorder.b, 120), st.frameRadius, 0, 1.0f);
        float ly = lg0.y + lgPad;
        for (int i = 0; i < (int)(sizeof(labels) / sizeof(labels[0])); ++i) {
            ImU32 col = edgeColor(types[i], 1.0f);
            ImVec2 sampleStart(lg0.x + lgPad, ly + lgLineH * 0.5f);
            ImVec2 sampleEnd(lg0.x + lgPad + 28.0f, ly + lgLineH * 0.5f);
            if (edgeIsCreate(types[i], BeliefOperation::Create)) drawDashedLine(dl, sampleStart, sampleEnd, col, 2.0f, 1.0f);
            else dl->AddLine(sampleStart, sampleEnd, col, 2.0f);
            // Arrowhead toward the right end of the sample line.
            dl->AddTriangleFilled(ImVec2(lg0.x + lgPad + 32.0f, ly + lgLineH * 0.5f),
                                  ImVec2(lg0.x + lgPad + 26.0f, ly + lgLineH * 0.5f - 4.0f),
                                  ImVec2(lg0.x + lgPad + 26.0f, ly + lgLineH * 0.5f + 4.0f), col);
            ImU32 textCol = IM_COL32(st.textBody.r, st.textBody.g, st.textBody.b, 255);
            dl->AddText(ImVec2(lg0.x + lgPad + 42.0f, ly + lgLineH * 0.5f - 8.0f), textCol, labels[i]);
            ly += lgLineH + lgRowGap;
        }
    }

    // --- Current Stage indicator (replaces the M7 minimap overlay): a compact
    // badge in the top-right showing the runtime's explicit frame stage. The
    // stage comes only from the runtime; the GUI never infers it. ---
    {
        const char* label = stageLabel(stage);
        ImU32 col = stageColor(stage);
        const float pad = 10.0f;
        const char* title = "Stage";
        ImVec2 ts = ImGui::CalcTextSize(title);
        ImVec2 ls = ImGui::CalcTextSize(label);
        float w = std::max(ts.x, ls.x) + pad * 2.0f;
        float h = ts.y + ls.y + pad * 2.0f + 6.0f;
        ImVec2 bg0(origin.x + gridSize.x - w - 12.0f,
                   origin.y + 12.0f);
        dl->AddRectFilled(bg0, ImVec2(bg0.x + w, bg0.y + h), IM_COL32(22, 24, 28, 230));
        // Restrained "working" pulse for non-terminating stages (user-requested
        // augmentation of the stage badge; CLOSED / NONE stay static). The pulse
        // is limited to the border so the label keeps full contrast, and follows
        // the cosine-time convention already used by paneBg().
        const bool working = stage != FrameStage::CLOSED && stage != FrameStage::NONE;
        ImU32 borderCol = col;
        if (working) {
            const float kSpeed = 1.0f;  // radians per second (full cycle ~ 6.28 s)
            const float t = 0.5f - 0.5f * std::cos(ImGui::GetTime() * kSpeed);  // 0..1
            const int alpha = static_cast<int>((0.55f + 0.45f * t) * 255.0f);
            borderCol = IM_COL32((col >> 16) & 255, (col >> 8) & 255, col & 255, alpha);
        }
        dl->AddRect(bg0, ImVec2(bg0.x + w, bg0.y + h), borderCol, st.frameRadius, 0, 1.0f);
        dl->AddText(ImVec2(bg0.x + pad, bg0.y + pad),
                    IM_COL32(st.textBody.r, st.textBody.g, st.textBody.b, 255), title);
        dl->AddText(ImVec2(bg0.x + pad, bg0.y + pad + ts.y + 2.0f), col, label);
    }

    // --- Focus Current: first-entry (once) and explicit (F / focusCurrentOnce)
    // both center the current node in the viewport. ---
    bool doFocus = state.currentNode &&
                   (!view.hasFocusedOnce || view.focusCurrentOnce.has_value());
    if (doFocus) {
        PanResult p = computeFocusPan(layout, state.currentNode->value, gridSize.x, gridSize.y, view.zoom);
        view.panX = p.x;
        view.panY = p.y;
        view.hasFocusedOnce = true;
        view.focusCurrentOnce.reset();
    }

    // --- User request: show the session cwd centered at the top edge of the
    // graph canvas. Drawn last so it stays above any panned/zoomed node. The
    // label does not affect node layout (positions come from layout.nodeRects).
    if (!cwd.empty()) {
        ImVec2 ts = ImGui::CalcTextSize(cwd.c_str());
        const float cx = origin.x + gridSize.x * 0.5f;
        dl->AddText(ImVec2(cx - ts.x * 0.5f, origin.y + 8.0f),
                    IM_COL32(st.textBody.r, st.textBody.g, st.textBody.b, 220),
                    cwd.c_str());
    }

    return selectionChanged;
}

} // namespace pie::gui
