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

    ImGui::DestroyContext();
    if (failures == 0) std::printf("ALL PASS\n");
    else std::printf("%d FAILURES\n", failures);
    return failures == 0 ? 0 : 1;
}
