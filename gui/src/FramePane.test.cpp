// Headless tests for the correction-mode state transitions in FramePane.h.
//
// The mode semantics — enter holds the prompt draft and starts the correction
// empty, Esc cancels the MODE and restores the draft, submit clears the input and
// leaves the mode — are pure state changes. Testing them here (no window) is what
// separates "the widgets compile" from "the flow is the one that was asked for".
// Whether the render function routes a submit to `FrameCorrector` rather than
// `PromptSender` is a wiring fact, asserted by reading `renderFramePane`.

#include "FramePane.h"

#include <cstdio>
#include <string>
#include <vector>

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

int main() {
    // A fresh pane is in normal prompt mode.
    {
        FramePaneState s;
        check(!s.correctionMode, "a fresh state is in normal prompt mode");
        check(s.correctionDraft.empty(), "with no held correction draft");
        check(!s.requestPromptFocus, "and no pending focus request");
    }

    // Enter: the normal prompt is held and the correction starts empty, so a
    // half-typed prompt can never be submitted as an objection.
    {
        FramePaneState s;
        s.promptText = "half-typed prompt";
        s.promptHistory = {"an earlier prompt"};
        s.promptHistoryIndex = 0;
        s.promptHistoryDraft = "an earlier prompt";
        s.mentionCandidates = {"src/main.cpp"};
        s.mentionActiveIndex = 0;
        enterCorrectionMode(s);
        check(s.correctionMode, "enterCorrectionMode turns the mode on");
        check(s.promptText.empty(), "and starts the correction from empty");
        check(s.correctionDraft == "half-typed prompt", "holding the normal prompt draft");
        check(s.promptHistoryIndex == -1, "and resets prompt history");
        check(s.promptHistoryDraft.empty(), "clearing the history draft");
        check(s.mentionCandidates.empty() && s.mentionActiveIndex == -1,
              "and clears the `@` mention candidates");
        check(s.requestPromptFocus, "and asks for the prompt focus");
    }

    // Cancel (Esc in correction mode): the held draft comes back, the mode is off,
    // and the correction text is discarded — not the prompt the user had.
    {
        FramePaneState s;
        s.promptText = "half-typed prompt";
        enterCorrectionMode(s);
        s.promptText = "an objection in progress";
        cancelCorrectionMode(s);
        check(!s.correctionMode, "cancelCorrectionMode turns the mode off");
        check(s.promptText == "half-typed prompt",
              "and restores the prompt draft, not the abandoned correction");
        check(s.correctionDraft.empty(), "and drops the held draft");
        check(s.requestPromptFocus, "and asks for the prompt focus");
    }

    // Submit: the input is cleared, the mode is off, and the held prompt draft is
    // NOT resurrected — a correction is not a prompt.
    {
        FramePaneState s;
        s.promptText = "half-typed prompt";
        enterCorrectionMode(s);
        s.promptText = "what the reading gets wrong";
        leaveCorrectionModeAfterSubmit(s);
        check(!s.correctionMode, "leaveCorrectionModeAfterSubmit turns the mode off");
        check(s.promptText.empty(), "and clears the input");
        check(s.correctionDraft.empty(), "and drops the held draft");
        check(s.requestPromptFocus, "and asks for the prompt focus");
    }

    // A second enter/cancel cycle is independent: nothing leaks between cycles.
    {
        FramePaneState s;
        s.promptText = "prompt A";
        enterCorrectionMode(s);
        cancelCorrectionMode(s);
        s.promptText = "prompt B";
        enterCorrectionMode(s);
        check(s.correctionDraft == "prompt B", "a second enter holds the current draft");
        cancelCorrectionMode(s);
        check(s.promptText == "prompt B", "and cancel restores it, not the first draft");
    }

    if (failures == 0) {
        std::printf("ALL PASS\n");
    } else {
        std::printf("%d FAILURES\n", failures);
    }
    return failures == 0 ? 0 : 1;
}
