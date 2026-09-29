// Headless test for `NativeGuiModel::openTurn()` (the only source of the footer's
// active slot) and for the footer's turn -> active-slot derivation.

#include <imgui.h>

#include <cstdio>
#include <string>

#include "Footer.h"
#include "Model.h"
#include "Theme.h"

using namespace pie::gui;

static int failures = 0;
static void check(bool cond, const char* what) {
    if (!cond) { std::fprintf(stderr, "FAIL: %s\n", what); ++failures; }
    else std::printf("ok: %s\n", what);
}

static const char* kTaskOpened =
    R"({"type":"TaskOpened","schemaVersion":7,"eventId":"e1","timestamp":"2026-01-01T00:00:00.000Z","taskId":"task-1","initialPrompt":{"id":"prompt-1","original":"Is pytest available?","effective":"Is pytest available?"},"inheritedBeliefs":[]})";
static const char* kEpisodeOpened =
    R"({"type":"EpisodeOpened","schemaVersion":7,"eventId":"e2","timestamp":"2026-01-01T00:00:01.000Z","taskId":"task-1","episodeId":"episode-1","ordinal":1})";
static const char* kSessionStatus =
    R"({"type":"session_status","roleStatus":{"epistemic":{"model":{"id":"m-epi"},"latestCacheHitRate":0.5},"distillation":{"model":{"id":"m-dis"},"latestCacheHitRate":0.5},"execution":{"model":{"id":"m-exe"},"latestCacheHitRate":0.5}},"cost":0.01})";
static const char* kStart =
    R"({"type":"message_start","timestamp":"2026-01-01T00:00:02.000Z","message":{"role":"assistant","model":{"id":"x","provider":"p"},"content":[]}})";
static const char* kEnd =
    R"({"type":"message_end","timestamp":"2026-01-01T00:00:03.000Z","message":{"role":"assistant","model":{"id":"x","provider":"p"},"usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0},"stopReason":"endTurn"}})";
static std::string cursorLine(const char* stage) {
    return std::string("{\"type\":\"CursorChanged\",\"schemaVersion\":7,\"eventId\":\"e3\",\"timestamp\":\"2026-01-01T00:00:01.000Z\",\"taskId\":\"task-1\",\"episodeId\":\"episode-1\",\"stage\":\"") +
           stage + "\"}";
}

// Left-most x of any accent-coloured vertex in the last rendered frame, or -1.
static float accentMinX() {
    const ImU32 accent = ImGui::ColorConvertFloat4ToU32(kAccent);
    const ImDrawData* dd = ImGui::GetDrawData();
    if (dd == nullptr) return -1.0f;
    float best = -1.0f;
    for (int i = 0; i < dd->CmdLists.Size; ++i) {
        const ImDrawList* list = dd->CmdLists[i];
        for (int v = 0; v < list->VtxBuffer.Size; ++v) {
            if (list->VtxBuffer[v].col != accent) continue;
            const float x = list->VtxBuffer[v].pos.x;
            if (best < 0.0f || x < best) best = x;
        }
    }
    return best;
}

static float renderFooterAccentMinX(const NativeGuiModel& m) {
    ImGui::NewFrame();
    ImGui::Begin("footer");
    renderFooter(m);
    ImGui::End();
    ImGui::EndFrame();
    ImGui::Render();
    return accentMinX();
}

int main() {
    ImGui::CreateContext();
    ImGuiIO& io = ImGui::GetIO();
    io.DisplaySize = ImVec2(1200.0f, 800.0f);
    io.DeltaTime = 1.0f / 60.0f;
    io.BackendFlags |= ImGuiBackendFlags_RendererHasTextures;
    io.Fonts->AddFontDefault();

    // --- the contract ------------------------------------------------------
    NativeGuiModel fresh;
    check(fresh.openTurn() == nullptr, "a model with no message_start has no open turn");

    NativeGuiModel model;
    applyRpcLine(model, kTaskOpened);
    applyRpcLine(model, kEpisodeOpened);
    applyRpcLine(model, kSessionStatus);
    check(model.footer().hasData, "the session_status gives the footer telemetry");
    const float noTurnX = renderFooterAccentMinX(model);
    check(noTurnX < 0.0f, "with no open turn the footer highlights no slot");

    applyRpcLine(model, cursorLine("proposing"));
    applyRpcLine(model, kStart);
    const TraceEntry* turn = model.openTurn();
    check(turn != nullptr, "message_start opens a turn");
    if (turn != nullptr) {
        check(turn->kind == TraceEntry::Kind::Turn, "the open turn is a Turn entry");
        check(!turn->ended, "the open turn is not ended yet");
        check(turn->stage == EpisodeStage::Proposing, "the open turn carries the cursor's proposing stage");
    }
    const float proposingX = renderFooterAccentMinX(model);
    check(proposingX >= 0.0f, "an open proposing turn highlights a footer slot");

    NativeGuiModel exec;
    applyRpcLine(exec, kTaskOpened);
    applyRpcLine(exec, kEpisodeOpened);
    applyRpcLine(exec, kSessionStatus);
    applyRpcLine(exec, cursorLine("executing"));
    applyRpcLine(exec, kStart);
    const TraceEntry* execTurn = exec.openTurn();
    check(execTurn != nullptr && execTurn->stage == EpisodeStage::Executing,
          "the executing cursor stage is carried by the open turn");
    const float executingX = renderFooterAccentMinX(exec);
    check(executingX >= 0.0f, "an open executing turn highlights a footer slot");
    check(executingX > proposingX, "the executing stage highlights a slot further right than proposing");

    // --- message_end closes it --------------------------------------------
    applyRpcLine(exec, kEnd);
    check(exec.openTurn() == nullptr, "message_end clears the open turn");
    check(renderFooterAccentMinX(exec) < 0.0f, "after message_end no footer slot is highlighted");

    ImGui::DestroyContext();
    if (failures == 0) std::printf("ALL PASS\n");
    else std::printf("%d FAILURES\n", failures);
    return failures == 0 ? 0 : 1;
}
