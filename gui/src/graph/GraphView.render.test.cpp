// Headless render test for the graph canvas: drives renderGraphView inside a bare
// ImGui context (no window, no OS backend) and asserts on the real draw-list
// vertices, so the rectangle block fill and the in-row frame placement are
// verified rather than merely compiled.
//
// The canvas origin is captured with GetCursorScreenPos immediately before the
// call, which is exactly the value renderGraphView uses for toScreen, so expected
// screen positions are computed without hard-coding window padding.

#include "graph/GraphView.h"

#include <imgui.h>

#include <cstdio>
#include <string>

#include "DemoEvents.h"
#include "Model.h"
#include "graph/GraphModel.h"
#include "graph/GraphStyle.h"
#include "graph/PieGraphLayout.h"

using namespace pie::gui;

static int failures = 0;
static void check(bool cond, const char* what) {
    if (!cond) {
        std::fprintf(stderr, "FAIL: %s\n", what);
        ++failures;
    } else {
        std::printf("ok: %s\n", what);
    }
}

// True when some vertex of colour `col` sits within `tol` of (x, y).
static bool vertexNear(ImU32 col, float x, float y, float tol) {
    const ImDrawData* dd = ImGui::GetDrawData();
    if (dd == nullptr) return false;
    for (int i = 0; i < dd->CmdLists.Size; ++i) {
        const ImDrawList* list = dd->CmdLists[i];
        for (int v = 0; v < list->VtxBuffer.Size; ++v) {
            const ImDrawVert& vert = list->VtxBuffer[v];
            if (vert.col != col) continue;
            if (vert.pos.x >= x - tol && vert.pos.x <= x + tol && vert.pos.y >= y - tol &&
                vert.pos.y <= y + tol) {
                return true;
            }
        }
    }
    return false;
}

// A block drawn as a sharp rectangle has vertices at all four corners; a circle
// has none of the corners (its extremes sit at the mid-edges).
static bool allFourCorners(ImU32 col, float cx, float cy, float halfW, float halfH, float tol) {
    return vertexNear(col, cx - halfW, cy - halfH, tol) && vertexNear(col, cx + halfW, cy - halfH, tol) &&
           vertexNear(col, cx - halfW, cy + halfH, tol) && vertexNear(col, cx + halfW, cy + halfH, tol);
}

int main() {
    ImGui::CreateContext();
    ImGuiIO& io = ImGui::GetIO();
    io.DisplaySize = ImVec2(1200.0f, 800.0f);
    io.DeltaTime = 1.0f / 60.0f;
    io.BackendFlags |= ImGuiBackendFlags_RendererHasTextures;
    io.Fonts->AddFontDefault();

    NativeGuiModel model;
    for (const std::string& line : demoEvents()) applyRpcLine(model, line);
    check(model.issues().empty(), "the demo stream folds without issues");
    const GraphTaskState state = projectGraphTask(model);
    const PieGraphLayout layout = computeGraphLayout(state);

    GraphViewState view;
    view.hasFocusedOnce = true;  // keep pan at 0 so expected positions are exact

    ImVec2 origin(0.0f, 0.0f);
    auto frame = [&]() {
        ImGui::NewFrame();
        ImGui::SetNextWindowPos(ImVec2(0.0f, 0.0f));
        ImGui::SetNextWindowSize(ImVec2(1200.0f, 800.0f));
        ImGui::Begin("graph_probe", nullptr, ImGuiWindowFlags_NoSavedSettings);
        origin = ImGui::GetCursorScreenPos();
        renderGraphView(view, state, layout);
        ImGui::End();
        ImGui::EndFrame();
        ImGui::Render();
    };
    frame();  // warm-up
    frame();  // measured frame; origin captured inside

    const float tol = 1.5f;
    const ImU32 planCol = IM_COL32(kGraphStyle.dotPlan.r, kGraphStyle.dotPlan.g, kGraphStyle.dotPlan.b, 255);
    const ImU32 fvCol =
        IM_COL32(kGraphStyle.dotFormulation.r, kGraphStyle.dotFormulation.g, kGraphStyle.dotFormulation.b, 255);

    // --- a Plan block is drawn as a rectangle ------------------------------
    {
        const Dot* dot = layout.dot(nodeId("plan", "plan-1").value);
        check(dot != nullptr, "the plan block is placed");
        if (dot != nullptr) {
            const float cx = origin.x + dot->x * view.zoom + view.panX;
            const float cy = origin.y + dot->y * view.zoom + view.panY;
            const float hw = (dot->w > 0.0f ? dot->w * 0.5f : dot->r) * view.zoom;
            const float hh = dot->r * view.zoom;
            check(allFourCorners(planCol, cx, cy, hw, hh, tol),
                  "the plan block is a filled rectangle with all four corners drawn");
            // A circle would have a vertex at the left mid-edge but not at a
            // corner pair; the top-left corner existing is the rectangle signature.
            check(vertexNear(planCol, cx - hw, cy - hh, tol),
                  "the plan block has a top-left corner (not a circle)");
        }
    }

    // --- an episode-anchored Frame version is drawn in its row -------------
    {
        const Dot* v2 = layout.dot(nodeId("Fv", "formulation-2").value);
        check(v2 != nullptr, "the anchored frame version is placed");
        if (v2 != nullptr) {
            const float cx = origin.x + v2->x * view.zoom + view.panX;
            const float cy = origin.y + v2->y * view.zoom + view.panY;
            const float hw = (v2->w > 0.0f ? v2->w * 0.5f : v2->r) * view.zoom;
            const float hh = v2->r * view.zoom;
            check(allFourCorners(fvCol, cx, cy, hw, hh, tol),
                  "the anchored frame version is drawn as a rectangle at its in-row position");
        }
    }

    // --- rectangle hit test: a click inside the block selects it ----------
    {
        const Dot* dot = layout.dot(nodeId("plan", "plan-1").value);
        check(dot != nullptr, "the plan block is placed for the hit test");
        if (dot != nullptr) {
            const float cx = origin.x + dot->x * view.zoom + view.panX;
            const float cy = origin.y + dot->y * view.zoom + view.panY;
            view.selectedNode.clear();
            io.AddMousePosEvent(cx, cy);
            frame();
            io.AddMouseButtonEvent(0, true);
            frame();
            io.AddMouseButtonEvent(0, false);
            frame();
            check(view.selectedNode == nodeId("plan", "plan-1").value,
                  "a click inside the rectangle block selects it");

            // A click well outside any block clears the selection.
            std::printf("probe: origin=(%.1f,%.1f) avail=(%.1f,%.1f)\n", origin.x, origin.y,
                        ImGui::GetIO().DisplaySize.x, ImGui::GetIO().DisplaySize.y);
            const float points[][2] = {{2.0f, 2.0f},   {1180.0f, 2.0f}, {2.0f, 780.0f},
                                        {1180.0f, 780.0f}, {600.0f, 780.0f}};
            bool anyCleared = false;
            for (const auto& pt : points) {
                view.selectedNode = nodeId("plan", "plan-1").value;
                io.AddMousePosEvent(origin.x + pt[0], origin.y + pt[1]);
                frame();
                io.AddMouseButtonEvent(0, true);
                frame();
                io.AddMouseButtonEvent(0, false);
                frame();
                const bool cleared = view.selectedNode.empty();
                anyCleared = anyCleared || cleared;
                std::printf("probe: empty click at (+%.0f,+%.0f) cleared=%d\n", pt[0], pt[1], cleared ? 1 : 0);
            }
            check(anyCleared, "a click on empty canvas clears the selection");
        }
    }

    // --- decoration layer: selection ring, focus ring, halo, series marks ---
    {
        const ImU32 selCol = IM_COL32(240, 240, 240, 255);     // dotRingSelected
        const ImU32 focusCol = IM_COL32(110, 200, 220, 255);   // focusAccent
        const ImU32 haloCol = IM_COL32(88, 166, 255, 71);      // dotRingCurrent @ 0.28 (faded)
        const ImU32 markCol = IM_COL32(150, 156, 164, 255);    // textMuted

        // Selection ring: offset 3px outside the selected block.
        const Dot* plan = layout.dot(nodeId("plan", "plan-1").value);
        check(plan != nullptr, "the plan block is placed for the selection ring");
        if (plan != nullptr) {
            view.selectedNode = nodeId("plan", "plan-1").value;
            io.AddMousePosEvent(origin.x + 2.0f, origin.y + 2.0f);
            frame();
            const float cx = origin.x + plan->x * view.zoom + view.panX;
            const float cy = origin.y + plan->y * view.zoom + view.panY;
            const float hw = (plan->w > 0.0f ? plan->w * 0.5f : plan->r) * view.zoom;
            const float hh = plan->r * view.zoom;
            check(vertexNear(selCol, cx - hw - 3.0f, cy - hh - 3.0f, tol),
                  "the selected block draws a rectangle selection ring at its corner");
        }

        // Focus ring and series mark on an in-focus belief, and the halo on the
        // current station. Clear the selection so those nodes are not dimmed.
        view.selectedNode.clear();
        frame();
        const GraphNode* focusBelief = nullptr;
        for (const GraphNode& n : state.nodes) {
            if (n.family == NodeFamily::Belief && n.inFocus && n.evidenceRounds > 0) {
                focusBelief = &n;
                break;
            }
        }
        check(focusBelief != nullptr, "a belief with a focus mark and evidence rounds is projected");
        if (focusBelief != nullptr) {
            const Dot* bd = layout.dot(focusBelief->id.value);
            if (bd != nullptr) {
                const float cx = origin.x + bd->x * view.zoom + view.panX;
                const float cy = origin.y + bd->y * view.zoom + view.panY;
                const float hw = (bd->w > 0.0f ? bd->w * 0.5f : bd->r) * view.zoom;
                const float hh = bd->r * view.zoom;
                check(vertexNear(focusCol, cx - hw - 2.0f, cy - hh - 2.0f, tol),
                      "an in-focus belief draws a rectangle focus ring");
                check(vertexNear(markCol, cx - hw, cy - hh - 6.0f, 3.5f),
                      "a belief with evidence rounds draws a series mark above the block");
            }
        }
        if (state.currentNode.has_value()) {
            const Dot* cd = layout.dot(state.currentNode->value);
            check(cd != nullptr, "the current station is placed");
            if (cd != nullptr) {
                const float cx = origin.x + cd->x * view.zoom + view.panX;
                const float cy = origin.y + cd->y * view.zoom + view.panY;
                const float hw = (cd->w > 0.0f ? cd->w * 0.5f : cd->r) * view.zoom;
                const float hh = cd->r * view.zoom;
                check(vertexNear(haloCol, cx - hw - 2.0f, cy - hh - 2.0f, tol),
                      "the current station draws a rectangle halo ring");
            }
        }
    }

    ImGui::DestroyContext();
    if (failures == 0) std::printf("ALL PASS\n");
    else std::printf("%d FAILURES\n", failures);
    return failures == 0 ? 0 : 1;
}
