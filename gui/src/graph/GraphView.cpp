// GraphView.cpp: custom read-only ImGui node canvas (Phase 2 M0 + M2).
//
// Draws the GraphTaskState nodes/edges onto the current ImGui window using a
// pan/zoom transform. Node cards follow the PIE single-card-family visual
// language (status/result color, current/selected highlight, tooltip). The
// canvas is read-only: no drag, no link create/delete, no semantic mutation.
//
// Phase 2 M7/M8/M9 integration: the minimap overlay and Focus Current navigation
// are drawn here (view layer) over the headless geometry from GraphMinimap; the
// dependency set and edge routes come from the GraphCache; and every visual
// constant comes from the centralized GraphStyle (kGraphStyle) instead of being
// inlined as literals.

#include "graph/GraphView.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <optional>

#include <imgui.h>

#include "graph/GraphStyle.h"
#include "graph/GraphMinimap.h"
#include "graph/GraphRouting.h"

namespace pie::gui {

namespace {

constexpr const GraphStyle& st = kGraphStyle;  // single style entry point

// Card colors by family. Result color for Execution is derived from status.
ImU32 cardColor(NodeFamily f, const GraphNode& n, bool selected, bool current) {
    if (selected) return IM_COL32(st.cardSelected.r, st.cardSelected.g, st.cardSelected.b, 255);
    if (current) return IM_COL32(st.cardCurrent.r, st.cardCurrent.g, st.cardCurrent.b, 255);
    switch (f) {
        case NodeFamily::Belief:
            if (n.displayType == "falsified") return IM_COL32(st.cardBeliefFalsified.r, st.cardBeliefFalsified.g, st.cardBeliefFalsified.b, 255);
            if (n.displayType == "revised") return IM_COL32(st.cardBeliefRevised.r, st.cardBeliefRevised.g, st.cardBeliefRevised.b, 255);
            if (n.displayType == "closed") return IM_COL32(st.cardBeliefClosed.r, st.cardBeliefClosed.g, st.cardBeliefClosed.b, 255);
            return IM_COL32(st.cardBelief.r, st.cardBelief.g, st.cardBelief.b, 255);
        case NodeFamily::Plan: return IM_COL32(st.cardPlan.r, st.cardPlan.g, st.cardPlan.b, 255);
        case NodeFamily::Execution:
            if (n.displayType == "failed") return IM_COL32(st.cardExecFailed.r, st.cardExecFailed.g, st.cardExecFailed.b, 255);
            if (n.displayType == "ok") return IM_COL32(st.cardExecOk.r, st.cardExecOk.g, st.cardExecOk.b, 255);
            return IM_COL32(st.cardExecRunning.r, st.cardExecRunning.g, st.cardExecRunning.b, 255);
        case NodeFamily::Distill: return IM_COL32(st.cardDistill.r, st.cardDistill.g, st.cardDistill.b, 255);
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

bool renderGraphView(GraphViewState& view, const GraphTaskState& state, const PieGraphLayout& layout) {
    bool selectionChanged = false;

    ImGuiIO& io = ImGui::GetIO();
    ImDrawList* dl = ImGui::GetWindowDrawList();
    ImVec2 origin = ImGui::GetCursorScreenPos();
    ImVec2 avail = ImGui::GetContentRegionAvail();

    // --- Focus Current (explicit): F centers the current node (no modifier, so
    // it does not clash with Cmd+F file-list / Cmd+T prompt toggles). ---
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
    for (const auto& [frameId, rect] : layout.executionRegionRects) {
        (void)frameId;
        drawSurface(rect, st.executionRegionFill);
    }

    // Column headings sit in the reserved header band and remain aligned with
    // the semantic columns while the canvas pans and zooms.
    const float headerY = st.canvasPad + st.columnHeaderHeight * 0.15f;
    dl->AddText(toScreen(layout.beliefColumnRect.x, headerY),
                IM_COL32(st.beliefRegionLabel.r, st.beliefRegionLabel.g,
                         st.beliefRegionLabel.b, 255), "Belief Set (global)");
    if (!layout.planRegionRects.empty()) {
        const GraphRect& rect = layout.planRegionRects.begin()->second;
        dl->AddText(toScreen(rect.x, headerY),
                    IM_COL32(st.planRegionLabel.r, st.planRegionLabel.g,
                             st.planRegionLabel.b, 255), "Plan (upper)");
        dl->AddText(toScreen(rect.x, headerY + 16.0f),
                    IM_COL32(st.distillRegionLabel.r, st.distillRegionLabel.g,
                             st.distillRegionLabel.b, 255), "Distillation (lower)");
    }
    if (!layout.executionRegionRects.empty()) {
        const GraphRect& rect = layout.executionRegionRects.begin()->second;
        dl->AddText(toScreen(rect.x, headerY),
                    IM_COL32(st.executionRegionLabel.r, st.executionRegionLabel.g,
                             st.executionRegionLabel.b, 255), "Execution Blocks");
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
        char label[80];
        std::snprintf(label, sizeof(label), "Round %zu\nnew beliefs", i + 1);
        dl->AddText(toScreen(it->second.x - st.beliefAnnotationWidth + 8.0f,
                             it->second.y + 4.0f),
                    IM_COL32(st.beliefRegionLabel.r, st.beliefRegionLabel.g,
                             st.beliefRegionLabel.b, 230), label);
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
            const bool dashedCreate = route.type == EdgeSemanticType::DistillToBelief &&
                                      route.beliefOperation == BeliefOperation::Create;
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
        // Operation glyph on Distill->Belief edges.
        if (route.type == EdgeSemanticType::DistillToBelief && route.beliefOperation) {
            const char* g = (*route.beliefOperation == BeliefOperation::Create) ? "+" : "~";
            ImVec2 gpos((s.x + t.x) * 0.5f, (s.y + t.y) * 0.5f);
            dl->AddCircleFilled(gpos, st.opGlyphRadius, IM_COL32(st.opGlyphFill.r, st.opGlyphFill.g, st.opGlyphFill.b, st.opGlyphFillAlpha));
            dl->AddText(ImVec2(gpos.x - 3.0f, gpos.y - 7.0f), IM_COL32(st.opGlyphText.r, st.opGlyphText.g, st.opGlyphText.b, 255), g);
        }
    }

    // --- Nodes: single card family ---
    for (const auto& n : state.nodes) {
        auto it = layout.nodeRects.find(n.id.value);
        if (it == layout.nodeRects.end()) continue;
        GraphRect r = it->second;
        bool selected = (view.selectedNode == n.id.value);
        bool current = (state.currentNode && state.currentNode->value == n.id.value);
        float alpha = nodeAlpha(n, dep);

        ImVec2 p0 = toScreen(r.x, r.y);
        ImVec2 p1 = toScreen(r.x + r.w, r.y + r.h);
        ImU32 fill = cardColor(n.family, n, selected, current);
        ImU32 border = selected ? IM_COL32(st.borderSelected.r, st.borderSelected.g, st.borderSelected.b, 255)
                       : current ? IM_COL32(st.borderCurrent.r, st.borderCurrent.g, st.borderCurrent.b, 255)
                       : IM_COL32(st.borderDefault.r, st.borderDefault.g, st.borderDefault.b, st.borderDefaultAlpha);
        dl->AddRectFilled(p0, p1, IM_COL32(fill >> 24 & 0xFF, fill >> 16 & 0xFF, fill >> 8 & 0xFF, (int)(255 * alpha)));
        dl->AddRect(p0, p1, IM_COL32(border >> 24 & 0xFF, border >> 16 & 0xFF, border >> 8 & 0xFF, (int)(255 * alpha)), st.cardRadius, 0, st.cardBorderWidth * view.zoom);

        // Title (family badge), compact text. The node body carries only the
        // ID badge; the descriptive content (compactText + fullText) is shown
        // via the tooltip so the richer information is preserved off-card.
        ImU32 textCol = IM_COL32(st.textBody.r, st.textBody.g, st.textBody.b, (int)(255 * alpha));
        std::string title = n.family == NodeFamily::Belief ? std::string("Belief ") + n.id.value
                            : n.family == NodeFamily::Plan ? std::string("Plan ") + n.id.value
                            : n.family == NodeFamily::Execution ? (n.title.empty() ? std::string("Exec ") + n.id.value : n.title)
                            : std::string("Distill ") + n.id.value;
        dl->AddText(ImVec2(p0.x + st.cardTextPadX, p0.y + st.cardTextPadY), textCol, title.c_str());

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

        // Tooltip on hover: the ID badge plus the previously-visible compact
        // content and the expanded text, so nothing descriptive is lost.
        if (ImGui::IsMouseHoveringRect(p0, p1)) {
            ImGui::BeginTooltip();
            ImGui::TextUnformatted((title + "\n" + n.compactText + "\n" + n.fullText).c_str());
            ImGui::EndTooltip();
        }
    }

    // --- Legend: the five edge-semantic encodings (top-left overlay). ---
    {
        const char* labels[] = {
            "Belief -> Plan   (read)",
            "Plan -> Execution",
            "Execution -> Distillation",
            "Distillation -> Belief   (write back)",
            "Distillation -> Belief   (create)",
        };
        const EdgeSemanticType types[] = {
            EdgeSemanticType::BeliefToPlan,
            EdgeSemanticType::PlanToExecution,
            EdgeSemanticType::ExecutionToDistill,
            EdgeSemanticType::DistillToBelief,
            EdgeSemanticType::DistillToBelief,
        };
        const char* glyphs[] = {"", "", "", "~", "+"};
        const float lgPad = 8.0f, lgLineH = 20.0f, lgRowGap = 6.0f;
        const float lgW = 310.0f;
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
            if (i == 4) drawDashedLine(dl, sampleStart, sampleEnd, col, 2.0f, 1.0f);
            else dl->AddLine(sampleStart, sampleEnd, col, 2.0f);
            // Arrowhead toward the right end of the sample line.
            dl->AddTriangleFilled(ImVec2(lg0.x + lgPad + 32.0f, ly + lgLineH * 0.5f),
                                  ImVec2(lg0.x + lgPad + 26.0f, ly + lgLineH * 0.5f - 4.0f),
                                  ImVec2(lg0.x + lgPad + 26.0f, ly + lgLineH * 0.5f + 4.0f), col);
            ImU32 textCol = IM_COL32(st.textBody.r, st.textBody.g, st.textBody.b, 255);
            dl->AddText(ImVec2(lg0.x + lgPad + 42.0f, ly + lgLineH * 0.5f - 8.0f), textCol, labels[i]);
            if (glyphs[i][0] != '\0') {
                dl->AddText(ImVec2(lg0.x + lgPad + 286.0f, ly + lgLineH * 0.5f - 8.0f),
                            IM_COL32(st.opGlyphText.r, st.opGlyphText.g, st.opGlyphText.b, 255), glyphs[i]);
            }
            ly += lgLineH + lgRowGap;
        }
    }

    // --- Minimap overlay (M7): a scaled projection of the whole graph with a
    // viewport rectangle; clicking / dragging pans the main view. ---
    if (view.minimapVisible && !layout.nodeRects.empty()) {
        const float mmW = 200.0f, mmH = 140.0f, mmPad = 12.0f;
        GraphMinimapLayout mini = computeGraphMinimap(state, layout, mmW, mmH);
        if (mini.width > 0.0f && mini.height > 0.0f) {
            ImVec2 mmOrigin(origin.x + gridSize.x - mini.width - mmPad,
                            origin.y + gridSize.y - mini.height - mmPad);
            dl->AddRectFilled(mmOrigin, ImVec2(mmOrigin.x + mini.width, mmOrigin.y + mini.height),
                              IM_COL32(22, 24, 28, 230));
            dl->AddRect(mmOrigin, ImVec2(mmOrigin.x + mini.width, mmOrigin.y + mini.height),
                        IM_COL32(90, 100, 115, 180), 2.0f, 0, 1.0f);
            // Frames as subtle boxes, nodes as filled dots.
            for (const auto& [fid, mr] : mini.frameRects) {
                (void)fid;
                dl->AddRect(ImVec2(mmOrigin.x + mr.x, mmOrigin.y + mr.y),
                            ImVec2(mmOrigin.x + mr.x + mr.w, mmOrigin.y + mr.y + mr.h),
                            IM_COL32(80, 90, 110, 130), 2.0f, 0, 1.0f);
            }
            for (const auto& [id, mr] : mini.nodeRects) {
                (void)id;
                dl->AddRectFilled(ImVec2(mmOrigin.x + mr.x, mmOrigin.y + mr.y),
                                  ImVec2(mmOrigin.x + mr.x + mr.w, mmOrigin.y + mr.y + mr.h),
                                  IM_COL32(150, 160, 175, 200));
            }
            // Viewport rectangle (the currently visible graph area).
            GraphViewport vp = computeViewport(view.panX, view.panY, view.zoom, gridSize.x, gridSize.y);
            float vx = mmOrigin.x + vp.x * mini.scale;
            float vy = mmOrigin.y + vp.y * mini.scale;
            float vw = std::clamp(vp.w * mini.scale, 4.0f, mini.width);
            float vh = std::clamp(vp.h * mini.scale, 4.0f, mini.height);
            dl->AddRect(ImVec2(vx, vy), ImVec2(vx + vw, vy + vh), IM_COL32(255, 200, 90, 240), 1.0f, 0, 1.0f);

            // Minimap interaction: click / drag pans the main view so the
            // clicked graph point is centered.
            ImVec2 mouse = io.MousePos;
            bool overMinimap = mouse.x >= mmOrigin.x && mouse.x <= mmOrigin.x + mini.width &&
                               mouse.y >= mmOrigin.y && mouse.y <= mmOrigin.y + mini.height;
            if (overMinimap && ImGui::IsMouseClicked(ImGuiMouseButton_Left)) {
                float gx = (mouse.x - mmOrigin.x) / mini.scale;
                float gy = (mouse.y - mmOrigin.y) / mini.scale;
                view.panX = gridSize.x * 0.5f - gx * view.zoom;
                view.panY = gridSize.y * 0.5f - gy * view.zoom;
            }
        }
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

    return selectionChanged;
}

} // namespace pie::gui
