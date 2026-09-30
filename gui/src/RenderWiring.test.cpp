// Headless render test for the two requirements that had only screenshot
// evidence: the footer's active-slot marker (colour + bold) and the Frame
// formulation sections rendered as tabs.
//
// The footer helpers are file-local to Footer.cpp, so this test includes that
// translation unit rather than linking it (the target must NOT list Footer.cpp).

#include <imgui.h>
#include <imgui_internal.h>

#include <cstdio>
#include <string>
#include <vector>

#include "Footer.cpp"  // NOLINT(build/include) - reaches renderRoleSlot/activeRoleSlot
#include "DomainEvents.h"
#include "FramePane.h"
#include "Model.h"
#include "Theme.h"

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

static int accentVertices() {
    const ImU32 accent = ImGui::ColorConvertFloat4ToU32(kAccent);
    const ImDrawData* dd = ImGui::GetDrawData();
    int n = 0;
    if (dd == nullptr) return 0;
    std::printf("probe: valid=%d lists=%d totalVtx=%d\n", (int)dd->Valid, dd->CmdLists.Size,
                dd->TotalVtxCount);
    for (int i = 0; i < dd->CmdLists.Size; ++i) {
        const ImDrawList* list = dd->CmdLists[i];
        for (int v = 0; v < list->VtxBuffer.Size; ++v)
            if (list->VtxBuffer[v].col == accent) ++n;
    }
    return n;
}

// Vertices of a given colour whose x sits within `margin` of the right edge of the
// draw area. Used to prove the activity indicator is right-aligned.
static int rightEdgeVertices(ImU32 col, float drawRight, float margin) {
    const ImDrawData* dd = ImGui::GetDrawData();
    int n = 0;
    if (dd == nullptr) return 0;
    for (int i = 0; i < dd->CmdLists.Size; ++i) {
        const ImDrawList* list = dd->CmdLists[i];
        for (int v = 0; v < list->VtxBuffer.Size; ++v) {
            if (list->VtxBuffer[v].col == col && list->VtxBuffer[v].pos.x >= drawRight - margin) ++n;
        }
    }
    return n;
}

int main() {
    // --- the stage -> slot mapping (requirement 1's "which role is live") ----
    check(activeRoleSlot(EpisodeStage::Proposing) == 0, "Proposing maps to the epistemic slot");
    check(activeRoleSlot(EpisodeStage::Distilling) == 1, "Distilling maps to the distillation slot");
    check(activeRoleSlot(EpisodeStage::Executing) == 2, "Executing maps to the execution slot");
    check(activeRoleSlot(EpisodeStage::Routing) == -1, "Routing highlights no slot");
    check(activeRoleSlot(EpisodeStage::Closed) == -1, "Closed highlights no slot");
    check(activeRoleSlot(EpisodeStage::Unknown) == -1, "Unknown highlights no slot");

    ImGui::CreateContext();
    ImGuiIO& io = ImGui::GetIO();
    io.DisplaySize = ImVec2(1200.0f, 800.0f);
    io.DeltaTime = 1.0f / 60.0f;
    io.BackendFlags |= ImGuiBackendFlags_RendererHasTextures;
    io.Fonts->AddFontDefault();

    RoleFooterSlot slot;
    slot.model = "gpt-5-codex";
    slot.cacheHitRate = 42.5f;

    // --- the footer marker: accent colour only on the ACTIVE slot ----------
    ImGui::NewFrame();
    ImGui::Begin("footer_probe");
    renderRoleSlot("Epistemic", slot, false);
    ImGui::End();
    ImGui::EndFrame();
    ImGui::Render();
    const int inactiveAccent = accentVertices();
    check(inactiveAccent == 0, "an inactive footer slot draws no accent-coloured glyphs");

    ImGui::NewFrame();
    ImGui::Begin("footer_probe");
    renderRoleSlot("Epistemic", slot, true);
    ImGui::End();
    ImGui::EndFrame();
    ImGui::Render();
    const int activeAccent = accentVertices();
    check(activeAccent > 0, "the active footer slot draws accent-coloured glyphs");
    std::printf("ok: active slot accent vertices = %d, inactive = %d\n", activeAccent, inactiveAccent);

    // --- the Frame sections as tabs (requirement 3) ------------------------
    ProblemFormulationVersion version;
    version.id = "v1";
    version.taskId = "t1";
    version.ordinal = 2;
    version.recordedAt = "2026-01-01T00:00:00Z";
    version.origin = "propose";
    version.content.interpretation = "the task is about X";
    version.content.focus = "the gap between the declaration and the runtime";
    version.content.implication = "the declaration must change";
    version.content.alternative = "the runtime is wrong";  // present -> gets a tab
    // tension intentionally absent -> must get NO tab
    version.reason = "the manifest entry is missing";

    FormulationView view;
    view.hasTask = true;
    view.current = &version;
    view.reviewVersionId = version.id;

    NativeGuiModel model;
    FramePaneState state;
    bool open = true;
    ImGui::NewFrame();
    renderFramePane(open, state, view, model, true, true, false, PromptSender(), FrameApprover(),
                    FrameCorrector(), FrameAutoApprover(), FrameChipHandler());
    ImGui::EndFrame();
    ImGui::Render();

    ImGuiContext* ctx = ImGui::GetCurrentContext();
    std::vector<std::string> names;
    std::printf("probe: tab bars alive=%d mapSize=%d\n", ctx->TabBars.GetAliveCount(),
                ctx->TabBars.GetMapSize());
    for (int i = 0; i < ctx->TabBars.GetMapSize(); ++i) {
        ImGuiTabBar* bar = ctx->TabBars.TryGetMapData(i);
        if (bar == nullptr) continue;
        for (int t = 0; t < bar->Tabs.Size; ++t)
            names.push_back(ImGui::TabBarGetTabName(bar, &bar->Tabs[t]));
    }
    const std::vector<std::string> expected = {"interpretation", "focus", "implication", "alternative", "reason"};
    std::string joined;
    for (const std::string& n : names) joined += n + " ";
    std::printf("ok: tab bar items = %s\n", joined.c_str());
    check(names == expected, "the frame sections render as tabs in section order, without an absent section");
    check(names.size() == 5, "exactly the five non-empty sections get a tab");

    // --- the graph footer's right-aligned activity indicator ---------------
    {
        NativeGuiModel m;
        applyRpcLine(m, R"({"type":"TaskOpened","schemaVersion":7,"eventId":"f1","timestamp":"2026-01-01T00:00:00.000Z","taskId":"t1","initialPrompt":{"id":"p1","original":"q","effective":"q"},"inheritedBeliefs":[]})");
        applyRpcLine(m, R"({"type":"EpisodeOpened","schemaVersion":7,"eventId":"f2","timestamp":"2026-01-01T00:00:01.000Z","taskId":"t1","episodeId":"ep1","ordinal":1})");
        applyRpcLine(m, R"({"type":"CursorChanged","schemaVersion":7,"eventId":"f3","timestamp":"2026-01-01T00:00:01.100Z","taskId":"t1","episodeId":"ep1","stage":"proposing"})");
        applyRpcLine(m, R"({"type":"session_status","timestamp":"2026-01-01T00:00:01.200Z","roleStatus":{"epistemic":{"model":"m1","cacheHitRate":10.0},"distillation":{"model":"m2","cacheHitRate":20.0},"execution":{"model":"m3","cacheHitRate":30.0}},"cost":0.1})");

        const ImU32 working = IM_COL32(104, 204, 120, 255);
        const ImU32 idle = IM_COL32(120, 126, 136, 255);
        float windowRight = 0.0f;
        auto footerFrame = [&]() {
            ImGui::NewFrame();
            ImGui::SetNextWindowPos(ImVec2(0.0f, 0.0f));
            ImGui::SetNextWindowSize(io.DisplaySize);
            ImGui::Begin("footer_host", nullptr,
                         ImGuiWindowFlags_NoTitleBar | ImGuiWindowFlags_NoResize |
                             ImGuiWindowFlags_NoMove | ImGuiWindowFlags_NoCollapse |
                             ImGuiWindowFlags_NoScrollbar | ImGuiWindowFlags_NoSavedSettings);
            ImGui::SetCursorPos(ImVec2(0.0f, io.DisplaySize.y - 40.0f));
            ImGui::BeginChild("footer", ImVec2(io.DisplaySize.x, 40.0f), true);
            renderGraphFooter(m);
            // The footer is a SIZED child of a full-display host, exactly as
            // App.cpp does; its right edge is the display width minus the child
            // frame/padding.
            windowRight = ImGui::GetWindowPos().x + ImGui::GetWindowWidth();
            ImGui::EndChild();
            ImGui::End();
            ImGui::EndFrame();
            ImGui::Render();
        };

        // No open turn: the indicator reads idle.
        check(m.openTurn() == nullptr, "no turn is open before message_start");
        footerFrame();  // warm-up: let the auto-sized window fit its content
        footerFrame();
        const float idleRight = windowRight;
        const int idleWorkingVerts = rightEdgeVertices(working, idleRight, 220.0f);
        const int idleIdleVerts = rightEdgeVertices(idle, idleRight, 220.0f);

        // An open turn: the indicator reads working and sits at the window's right edge.
        applyRpcLine(m, R"({"type":"message_start","timestamp":"2026-01-01T00:00:02.000Z","message":{"role":"assistant","model":{"id":"m1","provider":"pp"},"usage":{"input":10},"content":[]}})");
        check(m.openTurn() != nullptr, "message_start opens a turn");
        footerFrame();  // warm-up
        footerFrame();
        const int workingWorkingVerts = rightEdgeVertices(working, windowRight, 220.0f);
        std::printf("probe: childRight=%.1f displayWidth=%.1f working verts=%d idle verts=%d (idle state: working=%d idle=%d)\n",
                    windowRight, io.DisplaySize.x, workingWorkingVerts, idleIdleVerts, idleWorkingVerts,
                    idleIdleVerts);
        check(workingWorkingVerts > 0, "the working indicator draws a working-coloured dot near the window's right edge");
        check(idleWorkingVerts == 0, "no working-coloured dot is drawn while no turn is open");
        check(idleIdleVerts > 0, "an idle-coloured dot is drawn at the right edge while no turn is open");
    }

    ImGui::DestroyContext();
    if (failures == 0) std::printf("ALL PASS\n");
    else std::printf("%d FAILURES\n", failures);
    return failures == 0 ? 0 : 1;
}
