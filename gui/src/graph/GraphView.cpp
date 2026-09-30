#include "graph/GraphView.h"

#include <imgui.h>

#include <algorithm>
#include <cmath>
#include <set>
#include <string>
#include <vector>

#include "Theme.h"
#include "graph/GraphCache.h"
#include "graph/GraphInteraction.h"
#include "graph/GraphNavigation.h"
#include "graph/GraphRouting.h"
#include "graph/GraphStyle.h"

namespace pie::gui {

namespace {

ImU32 rgba(const GraphStyle::Rgb& c, float alpha) {
    return IM_COL32(c.r, c.g, c.b, static_cast<int>(std::clamp(alpha, 0.0f, 1.0f) * 255.0f));
}

ImVec4 vec4(const GraphStyle::Rgb& c, float alpha = 1.0f) {
    return ImVec4(c.r / 255.0f, c.g / 255.0f, c.b / 255.0f, alpha);
}

// A belief's dot colour is chosen by its DERIVED status, so a belief that a later
// round refuted changes colour without anything being rewritten.
const GraphStyle::Rgb& beliefDotColor(BeliefStatus status) {
    switch (status) {
        case BeliefStatus::Supported: return kGraphStyle.dotBeliefSupported;
        case BeliefStatus::Refuted: return kGraphStyle.dotBeliefRefuted;
        case BeliefStatus::Inconclusive: return kGraphStyle.dotBeliefInconclusive;
        case BeliefStatus::Superseded: return kGraphStyle.dotBeliefSuperseded;
        case BeliefStatus::Proposed: return kGraphStyle.dotBeliefProposed;
    }
    return kGraphStyle.dotBeliefProposed;
}

const GraphStyle::Rgb& executionDotColor(ExecutionStatus status) {
    switch (status) {
        case ExecutionStatus::Succeeded: return kGraphStyle.dotExecutionOk;
        case ExecutionStatus::Failed: return kGraphStyle.dotExecutionFailed;
        case ExecutionStatus::Cancelled: return kGraphStyle.dotExecutionCancelled;
        case ExecutionStatus::Running: return kGraphStyle.dotExecutionRunning;
        case ExecutionStatus::Unknown: break;
    }
    return kGraphStyle.dotDefault;
}

const GraphStyle::Rgb& nodeDotColor(const GraphNode& node) {
    switch (node.family) {
        case NodeFamily::Belief: return beliefDotColor(node.beliefStatus);
        case NodeFamily::EpisodeRow: return kGraphStyle.dotRow;
        case NodeFamily::Routing: return kGraphStyle.dotRouting;
        case NodeFamily::ExperimentSelection: return kGraphStyle.dotSelection;
        case NodeFamily::Plan: return kGraphStyle.dotPlan;
        case NodeFamily::Execution: return executionDotColor(node.executionStatus);
        case NodeFamily::Distillation: return kGraphStyle.dotDistillation;
        case NodeFamily::BeliefDelta: return kGraphStyle.dotDelta;
        case NodeFamily::Intervention: return kGraphStyle.dotIntervention;
        case NodeFamily::Recheck: return kGraphStyle.dotRecheck;
        case NodeFamily::Formulation: return kGraphStyle.dotFormulation;
    }
    return kGraphStyle.dotDefault;
}

const GraphStyle::Rgb& linkColor(EdgeSemanticType type) {
    switch (type) {
        case EdgeSemanticType::PlanToExecution: return kGraphStyle.linkPlanToExecution;
        case EdgeSemanticType::ExecutionToDistillation: return kGraphStyle.linkExecutionToDistillation;
        case EdgeSemanticType::DistillationToBeliefDelta: return kGraphStyle.linkDistillationToDelta;
        case EdgeSemanticType::BeliefDeltaToBelief: return kGraphStyle.linkDeltaToBelief;
        case EdgeSemanticType::BeliefToBeliefDelta: return kGraphStyle.linkBeliefToDelta;
        case EdgeSemanticType::SourceToFormulation: return kGraphStyle.linkSourceToFormulation;
        case EdgeSemanticType::FormulationToFormulation: return kGraphStyle.linkVersionToVersion;
        case EdgeSemanticType::RecheckToEpisode: return kGraphStyle.linkRecheckToEpisode;
    }
    return kGraphStyle.linkMuted;
}

// A belief's ring says whether the task is acting on it. Scope, not truth: a
// refuted belief that is still in focus keeps its refuted fill and gains the ring.
bool isFocused(const GraphNode& node) { return node.family == NodeFamily::Belief && node.inFocus; }

} // namespace

bool renderGraphView(GraphViewState& view, const GraphTaskState& state,
                     const PieGraphLayout& layout) {
    const GraphStyle& st = kGraphStyle;
    ImDrawList* draw = ImGui::GetWindowDrawList();
    const ImVec2 origin = ImGui::GetCursorScreenPos();
    const ImVec2 avail = ImGui::GetContentRegionAvail();
    const ImVec2 canvasMin = origin;
    const ImVec2 canvasMax = ImVec2(origin.x + std::max(avail.x, 1.0f), origin.y + std::max(avail.y, 1.0f));

    draw->AddRectFilled(canvasMin, canvasMax, rgba(st.canvasBg, 1.0f));
    ImGui::InvisibleButton("canvas", ImVec2(std::max(avail.x, 1.0f), std::max(avail.y, 1.0f)),
                           ImGuiButtonFlags_MouseButtonLeft | ImGuiButtonFlags_MouseButtonRight);

    const bool hovered = ImGui::IsItemHovered();
    const ImVec2 mouse = ImGui::GetIO().MousePos;

    // --- pan / zoom ------------------------------------------------------
    if (hovered && ImGui::IsMouseDragging(ImGuiMouseButton_Left) && view.selectedNode.empty()) {
        const ImVec2 delta = ImGui::GetIO().MouseDelta;
        view.panX += delta.x;
        view.panY += delta.y;
    }
    if (hovered && ImGui::GetIO().MouseWheel != 0.0f) {
        const float previous = view.zoom;
        view.zoom = std::clamp(view.zoom + ImGui::GetIO().MouseWheel * st.zoomStep, st.zoomMin, st.zoomMax);
        // Zoom about the pointer, so the node under the cursor stays under it.
        const ImVec2 centre = ImVec2(mouse.x - canvasMin.x, mouse.y - canvasMin.y);
        const float ratio = view.zoom / previous;
        view.panX = centre.x - (centre.x - view.panX) * ratio;
        view.panY = centre.y - (centre.y - view.panY) * ratio;
    }

    auto toScreen = [&](float x, float y) {
        return ImVec2(canvasMin.x + x * view.zoom + view.panX, canvasMin.y + y * view.zoom + view.panY);
    };

    // --- one-shot Focus Current ------------------------------------------
    if (view.focusCurrentOnce.has_value()) {
        const PanResult pan = computeFocusPan(layout, *view.focusCurrentOnce, avail.x, avail.y, view.zoom);
        view.panX = pan.x;
        view.panY = pan.y;
        view.focusCurrentOnce.reset();
        view.hasFocusedOnce = true;
    } else if (!view.hasFocusedOnce && state.currentNode.has_value()) {
        // First sight of a current station: centre it, once. After that the user's
        // pan wins — re-centring every frame would make the canvas unusable.
        const PanResult pan = computeFocusPan(layout, state.currentNode->value, avail.x, avail.y, view.zoom);
        view.panX = pan.x;
        view.panY = pan.y;
        view.hasFocusedOnce = true;
    }

    // --- selection highlight set -----------------------------------------
    // The dependency set is what "show me what this touches" means, and it is a
    // read-only emphasis: nothing about the model changes.
    // The cache owns the set, so hold the pointer rather than a reference: an
    // empty selection has no set to reference.
    static const std::set<std::string> kNoSelection;
    const std::set<std::string>* emphasisedPtr = &kNoSelection;
    if (!view.selectedNode.empty()) {
        emphasisedPtr = &view.cache.getDependencySet(state, view.selectedNode, view.cacheMetrics);
    }
    const std::set<std::string>& emphasised = *emphasisedPtr;

    const std::vector<EdgeRoute>& routes = view.cache.getRoutes(state, layout, view.cacheMetrics);

    // --- grid ------------------------------------------------------------
    {
        const float step = st.gridStep * view.zoom;
        if (step > 4.0f) {
            const ImU32 gridColor = rgba(st.gridLine, st.gridLineAlpha / 255.0f);
            for (float x = std::fmod(view.panX, step); x < avail.x; x += step) {
                draw->AddLine(ImVec2(canvasMin.x + x, canvasMin.y), ImVec2(canvasMin.x + x, canvasMax.y), gridColor);
            }
            for (float y = std::fmod(view.panY, step); y < avail.y; y += step) {
                draw->AddLine(ImVec2(canvasMin.x, canvasMin.y + y), ImVec2(canvasMax.x, canvasMin.y + y), gridColor);
            }
        }
    }

    // --- rails and row gutters -------------------------------------------
    auto drawBand = [&](const GraphRect& rect, const char* label) {
        if (rect.w <= 0.0f && rect.h <= 0.0f) return;
        const ImVec2 a = toScreen(rect.x, rect.y);
        const ImVec2 b = toScreen(rect.x + rect.w, rect.y + rect.h);
        draw->AddRect(a, b, rgba(st.linkMuted, 0.28f), 4.0f * view.zoom);
        if (label != nullptr && rect.h * view.zoom > 10.0f) {
            draw->AddText(ImVec2(a.x + 4.0f, a.y), rgba(st.textMuted, 0.8f), label);
        }
    };
    drawBand(layout.versionRail, "Frame");
    for (const EpisodeGutter& gutter : layout.gutters) {
        const ImVec2 a = toScreen(gutter.rect.x, gutter.rect.y);
        const ImVec2 b = toScreen(gutter.rect.x + gutter.rect.w, gutter.rect.y + gutter.rect.h);
        // A row separator, not a container: a line above each row, plus the
        // ordinal in the gutter. The "Ep1" label is a real node (the row anchor),
        // drawn with the other dots.
        draw->AddLine(ImVec2(canvasMin.x + 2.0f, a.y - 2.0f), ImVec2(canvasMax.x - 2.0f, a.y - 2.0f),
                      rgba(st.linkMuted, gutter.current ? 0.55f : 0.22f));
        if (gutter.current) {
            draw->AddLine(ImVec2(canvasMin.x + 2.0f, b.y + 2.0f), ImVec2(canvasMax.x - 2.0f, b.y + 2.0f),
                          rgba(st.accent, 0.35f));
        }
    }
    if (state.taskOutcome.present) {
        const ImVec2 a = toScreen(layout.outcomeBand.x, layout.outcomeBand.y);
        const ImVec2 b = toScreen(layout.outcomeBand.x + layout.outcomeBand.w,
                                  layout.outcomeBand.y + layout.outcomeBand.h);
        draw->AddRectFilled(a, b, rgba(st.outcomeBandFill, st.outcomeBandAlpha / 255.0f), 4.0f * view.zoom);
        draw->AddText(ImVec2(a.x + 6.0f, a.y + 4.0f), rgba(st.outcomeLabel, 0.9f), "TaskOutcome");
    }

    // --- links -----------------------------------------------------------
    for (const EdgeRoute& route : routes) {
        const bool inPath = !emphasised.empty() &&
                            emphasised.count(route.source.value) != 0 &&
                            emphasised.count(route.target.value) != 0;
        float alpha = route.longRoute ? st.linkAlphaLong : st.linkAlphaLocal;
        if (!emphasised.empty() && !inPath) alpha = st.linkAlphaOffPath;
        else if (inPath) alpha = st.linkAlphaPath;

        const ImU32 color = rgba(inPath ? st.accent : linkColor(route.type), alpha);
        const float width = (route.longRoute ? st.linkWidthLong : st.linkWidthLocal) * view.zoom;

        std::vector<ImVec2> points;
        points.reserve(route.points.size());
        for (const auto& point : route.points) points.push_back(toScreen(point.first, point.second));

        if (route.dashed) {
            // A dashed link says "this record was introduced here" (§6.1). Drawn by
            // walking the polyline and alternating dash lengths.
            const float on = st.linkDash[0] * view.zoom;
            const float off = st.linkDash[1] * view.zoom;
            for (size_t i = 0; i + 1 < points.size(); ++i) {
                const ImVec2 a = points[i];
                const ImVec2 b = points[i + 1];
                const float dx = b.x - a.x;
                const float dy = b.y - a.y;
                const float length = std::sqrt(dx * dx + dy * dy);
                if (length <= 0.0f) continue;
                const float ux = dx / length;
                const float uy = dy / length;
                float travelled = 0.0f;
                bool drawing = true;
                while (travelled < length) {
                    const float span = std::min(drawing ? on : off, length - travelled);
                    if (drawing) {
                        draw->AddLine(ImVec2(a.x + ux * travelled, a.y + uy * travelled),
                                      ImVec2(a.x + ux * (travelled + span), a.y + uy * (travelled + span)),
                                      color, width);
                    }
                    travelled += span;
                    drawing = !drawing;
                }
            }
        } else {
            for (size_t i = 0; i + 1 < points.size(); ++i) {
                draw->AddLine(points[i], points[i + 1], color, width);
            }
        }

        // Arrowhead at the target end, oriented along the last segment.
        if (points.size() >= 2) {
            const ImVec2 tip = points.back();
            const ImVec2 prev = points[points.size() - 2];
            const float dx = tip.x - prev.x;
            const float dy = tip.y - prev.y;
            const float length = std::sqrt(dx * dx + dy * dy);
            if (length > 0.001f) {
                const float ux = dx / length;
                const float uy = dy / length;
                const float size = st.arrowheadSize * view.zoom;
                const float half = st.arrowheadHalf * view.zoom;
                draw->AddTriangleFilled(
                    tip, ImVec2(tip.x - ux * size - uy * half, tip.y - uy * size + ux * half),
                    ImVec2(tip.x - ux * size + uy * half, tip.y - uy * size - ux * half), color);
            }
        }
    }

    // --- the current station's halo (the redirect of the paneBg pulse) ----
    if (state.currentNode.has_value()) {
        const Dot* dot = layout.dot(state.currentNode->value);
        if (dot != nullptr) {
            const ImVec2 centre = toScreen(dot->x, dot->y);
            const bool faded = state.cursorStage == EpisodeStage::Closed;
            const float halfH = dot->r * view.zoom;
            const float halfW = (dot->w > 0.0f ? dot->w * 0.5f : dot->r) * view.zoom;
            // paneBg(true) is the one animated colour in the GUI. It used to wash a
            // pane background; it now draws this ring (§6.3).
            const ImVec4 pulse = paneBg(true);
            if (!faded) {
                const float o = (dot->r + st.currentHaloWidth - dot->r) * view.zoom;
                draw->AddRect(ImVec2(centre.x - halfW - o, centre.y - halfH - o),
                              ImVec2(centre.x + halfW + o, centre.y + halfH + o),
                              IM_COL32(static_cast<int>(pulse.x * 255.0f),
                                       static_cast<int>(pulse.y * 255.0f),
                                       static_cast<int>(pulse.z * 255.0f), 220),
                              4.0f * view.zoom,
                              static_cast<float>(std::max(st.dotRingWidth * 2.0f * view.zoom, 1.0f)), 0);
            }
            // A faded station still gets a steady ring: "the round ended here" must
            // remain visible, it just must not pulse as if work were happening.
            const float o = 2.0f * view.zoom;
            draw->AddRect(ImVec2(centre.x - halfW - o, centre.y - halfH - o),
                          ImVec2(centre.x + halfW + o, centre.y + halfH + o),
                          rgba(st.dotRingCurrent, faded ? 0.28f : 0.9f), 4.0f * view.zoom,
                          static_cast<float>(std::max(st.dotRingWidth * view.zoom, 1.0f)), 0);
        }
    }

    // --- blocks, then the hover hit test ------------------------------
    const GraphNode* hoveredNode = nullptr;
    for (const GraphNode& node : state.nodes) {
        const Dot* dot = layout.dot(node.id.value);
        if (dot == nullptr) continue;
        const ImVec2 centre = toScreen(dot->x, dot->y);

        const bool emphasisedNode = emphasised.empty() || emphasised.count(node.id.value) != 0;
        float alpha = emphasisedNode ? 1.0f : st.dimMuted;
        const bool isCurrent = node.state == NodeVisualState::Current ||
                               node.state == NodeVisualState::CurrentFaded;

        const ImU32 fill = rgba(nodeDotColor(node), alpha);
        // A block is a rectangle: its half-height is the dot radius and its
        // half-width comes from Dot.w (a circle is w == 2r).
        const float halfH = std::max(dot->r * view.zoom, 2.0f);
        const float halfW = std::max((dot->w > 0.0f ? dot->w * 0.5f : dot->r) * view.zoom, 2.0f);
        const ImVec2 boxMin(centre.x - halfW, centre.y - halfH);
        const ImVec2 boxMax(centre.x + halfW, centre.y + halfH);

        // A delta is a diamond and a selection is a hollow ring: the shape carries
        // the kind, so a colour-blind reader still has the distinction.
        if (node.family == NodeFamily::BeliefDelta) {
            const float d = halfH * 1.25f;
            draw->AddQuadFilled(ImVec2(centre.x, centre.y - d), ImVec2(centre.x + d, centre.y),
                                ImVec2(centre.x, centre.y + d), ImVec2(centre.x - d, centre.y), fill);
        } else if (node.family == NodeFamily::ExperimentSelection) {
            draw->AddCircle(centre, halfH, fill, 0, static_cast<int>(std::max(st.dotRingWidth * view.zoom, 1.0f)));
        } else {
            draw->AddRectFilled(boxMin, boxMax, fill);
        }

        // Rings, outermost claim last so the strongest wins visually.
        const bool isSelected = !view.selectedNode.empty() && view.selectedNode == node.id.value;
        if (isFocused(node)) {
            // The focus accent bar became a ring: with no box there is no left edge
            // to put a bar on, and a ring reads as "in scope" just as well.
            const float o = 2.0f * view.zoom;
            draw->AddRect(ImVec2(boxMin.x - o, boxMin.y - o), ImVec2(boxMax.x + o, boxMax.y + o),
                          rgba(st.focusAccent, alpha), 3.0f * view.zoom,
                          static_cast<float>(std::max(st.focusBarWidth * view.zoom, 1.0f)), 0);
        }
        if (isSelected) {
            const float o = 3.0f * view.zoom;
            draw->AddRect(ImVec2(boxMin.x - o, boxMin.y - o), ImVec2(boxMax.x + o, boxMax.y + o),
                          rgba(st.dotRingSelected, 1.0f), 3.0f * view.zoom,
                          static_cast<float>(std::max(st.dotRingWidth * 1.5f * view.zoom, 1.0f)), 0);
        } else if (!isCurrent && node.family != NodeFamily::ExperimentSelection) {
            draw->AddRect(boxMin, boxMax,
                          rgba(st.dotRingDefault, st.dotRingDefaultAlpha / 255.0f * alpha),
                          3.0f * view.zoom,
                          static_cast<float>(std::max(st.dotRingWidth * view.zoom, 1.0f)), 0);
        }

        // A belief's series mark: one small mark per round that carried it, capped
        // so a long-lived belief does not grow a tail across the canvas. A mark,
        // never hit-tested and never a layout input.
        if (node.family == NodeFamily::Belief && node.evidenceRounds > 0) {
            const uint32_t marks = std::min<uint32_t>(node.evidenceRounds, 4);
            for (uint32_t i = 0; i < marks; ++i) {
                draw->AddCircleFilled(
                    ImVec2(centre.x - halfW + static_cast<float>(i) * st.seriesMarkRadius * 2.2f,
                           centre.y - halfH - st.seriesMarkRadius * 2.0f),
                    st.seriesMarkRadius * view.zoom, rgba(st.textMuted, alpha));
            }
        }

        // Hover: a block is hit inside its rectangle, not inside a circle.
        if (hovered && mouse.x >= boxMin.x - 3.0f && mouse.x <= boxMax.x + 3.0f &&
            mouse.y >= boxMin.y - 3.0f && mouse.y <= boxMax.y + 3.0f) {
            if (hoveredNode == nullptr || node.state == NodeVisualState::Current) hoveredNode = &node;
        }
    }

    // --- interaction -----------------------------------------------------
    bool selectionChanged = false;
    if (hovered && hoveredNode != nullptr) {
        // EVERY node family has a tooltip. The v1 view withheld them from Plan and
        // Distill, which left their content unreachable; that carve-out is gone.
        ImGui::BeginTooltip();
        ImGui::PushTextWrapPos(st.tooltipMaxWidth);
        ImGui::TextUnformatted(hoveredNode->title.c_str());
        if (!hoveredNode->compactText.empty() && hoveredNode->compactText != hoveredNode->title) {
            ImGui::PushStyleColor(ImGuiCol_Text, vec4(kGraphStyle.textMuted));
            ImGui::TextUnformatted(hoveredNode->compactText.c_str());
            ImGui::PopStyleColor();
        }
        ImGui::Separator();
        ImGui::TextUnformatted(hoveredNode->fullText.c_str());
        ImGui::PopTextWrapPos();
        ImGui::EndTooltip();
    }
    if (hovered && ImGui::IsMouseClicked(ImGuiMouseButton_Left) && hoveredNode != nullptr) {
        const std::string id = hoveredNode->id.value;
        if (view.selectedNode == id) {
            view.selectedNode.clear();
            selectionChanged = true;
        } else if (view.selectedNode.empty()) {
            view.selectedNode = id;
            selectionChanged = true;
        }
    }
    // A right click clears the selection and re-pins the view to the cursor.
    if (hovered && ImGui::IsMouseClicked(ImGuiMouseButton_Right)) {
        view.selectedNode.clear();
        if (state.currentNode.has_value()) {
            view.focusCurrentOnce = state.currentNode->value;
        } else {
            view.focusCurrentOnce.reset();
        }
        selectionChanged = true;
    }
    // A click on empty space clears the selection.
    if (hovered && ImGui::IsMouseClicked(ImGuiMouseButton_Left) && hoveredNode == nullptr &&
        !view.selectedNode.empty()) {
        view.selectedNode.clear();
        selectionChanged = true;
    }

    // --- legend ----------------------------------------------------------
    // A read-only canvas still has to say what a shape means. One row, bottom
    // left, drawn last so it sits above the links.
    {
        static const char* kLegend = "block = record  ·  diamond = belief delta  ·  ring = experiment selection";
        const ImVec2 size = ImGui::CalcTextSize(kLegend);
        draw->AddText(ImVec2(canvasMin.x + 8.0f, canvasMax.y - size.y - 6.0f),
                      rgba(st.textMuted, 0.65f), kLegend);
    }
    return selectionChanged;
}

} // namespace pie::gui
