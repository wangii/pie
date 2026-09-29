// Headless render test: drives renderFramePane inside a bare ImGui context (no
// window, no OS backend) to assert the wiring the state-only tests cannot see:
//   * Esc while in correction mode cancels the MODE and leaves the pane open,
//     restoring the held prompt draft.
//   * Esc outside correction mode closes the pane.
//   * a synthetic mouse click on the `Correction` button enters the mode.
//   * submitting in correction mode routes to `FrameCorrector` and never to
//     `PromptSender`; submitting in prompt mode does the opposite.
//
// The buttons are found by scanning the pane area for the coordinate that fires
// the expected callback, so the test does not hard-code widget geometry that the
// layout owns.

#include "FramePane.h"

#include <imgui.h>

#include <cstdio>
#include <string>

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

static ImGuiIO* gIo = nullptr;

// What the two submit callbacks saw. Kept in one struct so a probe can assert
// both directions of the anti-confusion rule at once.
struct Calls {
    std::string sent;
    std::string corrected;
    int sendCalls = 0;
    int correctCalls = 0;
};

static void frame(bool& open, FramePaneState& s, const FormulationView& view, const NativeGuiModel& m,
                  bool canSend, bool canAct, bool historyNav, const PromptSender& send,
                  const FrameCorrector& correct) {
    ImGui::NewFrame();
    renderFramePane(open, s, view, m, canSend, canAct, historyNav, send, FrameApprover(), correct,
                    FrameAutoApprover(), FrameChipHandler());
    ImGui::EndFrame();
    ImGui::Render();
}

static void clickAt(bool& open, FramePaneState& s, const FormulationView& view, const NativeGuiModel& m,
                    bool canSend, bool canAct, bool historyNav, float x, float y, Calls& calls) {
    const PromptSender send = [&calls](const std::string& t) { calls.sent = t; ++calls.sendCalls; };
    const FrameCorrector correct = [&calls](const std::string& t) { calls.corrected = t; ++calls.correctCalls; };
    gIo->AddMousePosEvent(x, y);
    frame(open, s, view, m, canSend, canAct, historyNav, send, correct);
    gIo->AddMouseButtonEvent(0, true);
    frame(open, s, view, m, canSend, canAct, historyNav, send, correct);
    gIo->AddMouseButtonEvent(0, false);
    frame(open, s, view, m, canSend, canAct, historyNav, send, correct);
}

// Scan the pane for the first coordinate whose click satisfies `hit`.
template <typename Hit>
static bool scan(const FormulationView& view, const NativeGuiModel& m, bool canSend, bool canAct,
                 bool historyNav, FramePaneState seed, Hit hit, float& outX, float& outY) {
    for (float y = 80.0f; y <= 760.0f; y += 8.0f) {
        for (float x = 180.0f; x <= 1020.0f; x += 16.0f) {
            FramePaneState s = seed;
            bool open = true;
            Calls calls;
            clickAt(open, s, view, m, canSend, canAct, historyNav, x, y, calls);
            if (hit(s, open, calls)) {
                outX = x;
                outY = y;
                return true;
            }
        }
    }
    return false;
}

int main() {
    ImGui::CreateContext();
    ImGuiIO& io = ImGui::GetIO();
    gIo = &io;
    io.DisplaySize = ImVec2(1200.0f, 800.0f);
    io.DeltaTime = 1.0f / 60.0f;
    // No OS backend in this test: tell ImGui the textures are managed elsewhere so
    // it does not require the legacy font-atlas build before its first NewFrame().
    io.BackendFlags |= ImGuiBackendFlags_RendererHasTextures;
    io.Fonts->AddFontDefault();
    if (io.Fonts->Fonts.Size > 0) setMarkdownFonts(io.Fonts->Fonts[0], io.Fonts->Fonts[0]);

    NativeGuiModel model;
    FormulationView view;  // defaults: no task, nothing waiting
    FramePaneState s;
    bool open = true;
    const PromptSender send;
    const FrameCorrector correct;

    // Warm-up frame so fonts/ids settle before the asserted frames.
    frame(open, s, view, model, false, false, false, send, correct);

    // --- Esc in correction mode: cancel the mode, keep the pane ------------
    s.correctionMode = true;
    s.correctionDraft = "half-typed prompt";
    s.promptText = "typing a correction";
    open = true;
    io.AddKeyEvent(ImGuiKey_Escape, true);
    frame(open, s, view, model, false, false, false, send, correct);
    io.AddKeyEvent(ImGuiKey_Escape, false);
    check(open, "Esc in correction mode leaves the pane open");
    check(!s.correctionMode, "Esc in correction mode cancels the mode");
    check(s.promptText == "half-typed prompt", "Esc restores the held prompt draft");

    // --- Esc outside correction mode: close the pane -----------------------
    s.correctionMode = false;
    s.promptText = "hello";
    open = true;
    frame(open, s, view, model, false, false, false, send, correct);  // key-up frame
    io.AddKeyEvent(ImGuiKey_Escape, true);
    frame(open, s, view, model, false, false, false, send, correct);
    io.AddKeyEvent(ImGuiKey_Escape, false);
    check(!open, "Esc outside correction mode closes the pane");

    // --- a synthetic click on `Correction` enters the mode -----------------
    {
        FramePaneState seed;
        float hx = 0.0f, hy = 0.0f;
        const bool found = scan(view, model, true, true, false, seed,
                                [](const FramePaneState& st, bool, const Calls&) { return st.correctionMode; },
                                hx, hy);
        check(found, "a synthetic click on the Correction button enters correction mode");
        if (found) std::printf("ok: correction button hit at (%.0f, %.0f)\n", hx, hy);
    }

    // --- correction submit goes to FrameCorrector, never PromptSender ------
    {
        FramePaneState seed;
        seed.correctionMode = true;
        seed.promptText = "the reading gets the gap wrong";
        float hx = 0.0f, hy = 0.0f;
        const bool found = scan(view, model, true, true, true, seed,
                                [](const FramePaneState& st, bool, const Calls& c) {
                                    return c.correctCalls > 0 && c.corrected == "the reading gets the gap wrong" &&
                                           !st.correctionMode && st.promptText.empty();
                                },
                                hx, hy);
        check(found, "a synthetic click on `Submit correction` hands the text to FrameCorrector");
        if (found) std::printf("ok: Submit correction hit at (%.0f, %.0f)\n", hx, hy);

        FramePaneState probe = seed;
        bool probeOpen = true;
        Calls calls;
        clickAt(probeOpen, probe, view, model, true, true, true, hx, hy, calls);
        check(calls.correctCalls == 1, "the correction submit called FrameCorrector exactly once");
        check(calls.sendCalls == 0, "the correction submit did NOT call PromptSender");
        check(calls.corrected == "the reading gets the gap wrong", "FrameCorrector got the correction text");
        check(!probe.correctionMode, "submitting a correction leaves correction mode");
        check(probe.promptText.empty(), "submitting a correction clears the input");
        check(probeOpen, "submitting a correction keeps the pane open");
    }

    // --- prompt submit goes to PromptSender, never FrameCorrector ----------
    {
        FramePaneState seed;
        seed.correctionMode = false;
        seed.promptText = "a plain prompt";
        float hx = 0.0f, hy = 0.0f;
        const bool found = scan(view, model, true, true, true, seed,
                                [](const FramePaneState&, bool, const Calls& c) {
                                    return c.sendCalls > 0 && c.sent == "a plain prompt";
                                },
                                hx, hy);
        check(found, "a synthetic click on `Send (does not approve the Frame)` hands the text to PromptSender");
        if (found) std::printf("ok: Send hit at (%.0f, %.0f)\n", hx, hy);

        FramePaneState probe = seed;
        bool probeOpen = true;
        Calls calls;
        clickAt(probeOpen, probe, view, model, true, true, true, hx, hy, calls);
        check(calls.sendCalls == 1, "the prompt submit called PromptSender exactly once");
        check(calls.correctCalls == 0, "the prompt submit did NOT call FrameCorrector");
        check(calls.sent == "a plain prompt", "PromptSender got the prompt text");
    }

    ImGui::DestroyContext();
    if (failures == 0) std::printf("ALL PASS\n");
    else std::printf("%d FAILURES\n", failures);
    return failures == 0 ? 0 : 1;
}
