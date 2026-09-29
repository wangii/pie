// FramePane: the Frame's pane, and the user-prompt palette the v1 workspace had.
//
// These are ONE surface, not two. M8 split them — a docked panel for the reading
// ("what the Frame is") and the floating window for the reply ("what the user
// wants to say") — and bound them to a single key so neither could be opened
// alone. That split had two costs that only show up when you use it: the Frame
// had no place of its own in the workspace, and the only way to reach either half
// was a keystroke nothing in the UI announced. So the window carries both now:
//
//   * the READING at the top — the banner, the acts it can offer (Approve,
//     Auto-approve, Correction), and the Frame itself: version, sources, deferral,
//     corrections, review obligations, recheck, history.
//   * the REPLY below it — the prompt box, and the assistant's streaming answer.
//
// The banner and the acts stay pinned while only the Frame body scrolls, so
// Approve cannot be scrolled out of reach on a long reading.
//
// The acts the pane exists to keep apart stay side by side and visibly different:
// `approve_frame` is the ONLY command that means consent, and a plain prompt never
// releases the pause. The correction is neither: pressing the one `Correction`
// button turns the SAME prompt box into the correction input (a mode, not a second
// box), and the normal Send button keeps saying what it does not do.

#pragma once

#include <functional>
#include <string>
#include <vector>

#include "FormulationView.h"
#include "Model.h"

namespace pie::gui {

// Callback that sends one user prompt back to the runtime client (live mode).
using PromptSender = std::function<void(const std::string&)>;
// `approve_frame` — the only command that expresses consent (§3.4). It is sent
// with the REVIEW's version id, and the runtime answers a refusal with an error
// rather than an approval.
using FrameApprover = std::function<void(const std::string& versionId)>;
// `frame_correct` — the user's objection to the reading.
using FrameCorrector = std::function<void(const std::string& message)>;
// `set_auto_approve_frame` — the session-scoped toggle. Deliberately NOT an
// approve: it consents to readings that do not exist yet, which is why it is a
// checkbox rather than a second button next to Approve.
using FrameAutoApprover = std::function<void(bool enabled)>;
// A click on a `sources[]` chip. The pane does not decide where a belief or an
// execution is shown; it reports the click.
using FrameChipHandler = std::function<void(const FormulationChip& chip)>;

struct FramePaneState {
    // --- the prompt box (unchanged from the v1 palette) -------------------
    std::string promptText;         // growable user prompt buffer
    size_t lastInMessageLength = 0; // in-message length since last auto-scroll
    bool inMessagePinned = true;    // while pinned, new content auto-scrolls down
    std::vector<std::string> promptHistory;
    int promptHistoryIndex = -1;    // -1 = current draft, otherwise history entry
    std::string promptHistoryDraft;
    int inMessageHistoryIndex = -1; // -1 = live/latest; otherwise an archive index
    int lastInMessagePage = -1;
    std::string workDir;                      // base dir for `@` completion
    std::vector<std::string> mentionCandidates;
    int mentionActiveIndex = -1;

    // --- the Frame's own state -------------------------------------------
    // The correction mode. Entering it reuses the ONE prompt box as the correction
    // input; `correctionDraft` keeps the normal prompt draft so Esc can restore it.
    // A mode on the one input, rather than a second box, so a half-typed prompt is
    // never consumed as an objection and there is never a second place to type.
    bool correctionMode = false;
    std::string correctionDraft;
    // Set when entering correction mode so the next frame lands the caret in the
    // prompt box even if the window is not appearing.
    bool requestPromptFocus = false;
    // The version whose full text is being read in the history list, or empty for
    // the current one. Read-only: the pane never edits a published version.
    std::string viewedVersionId;
    bool showDeferral = true;
    bool showCorrections = true;
};

// --- correction mode transitions (headless, so the semantics are testable) ---
//
// Entering correction mode holds the current prompt as the draft and starts the
// correction from empty, so a half-typed prompt is never submitted as an
// objection. Esc cancels the MODE (not the pane) and restores that draft; a
// successful submit leaves the mode and clears the input. These are the exact
// state changes the render function makes; keeping them here makes each one
// assertable without a window.
inline void enterCorrectionMode(FramePaneState& s) {
    s.correctionMode = true;
    s.correctionDraft = s.promptText;
    s.promptText.clear();
    // Prompt-only affordances would otherwise replace the correction text.
    s.promptHistoryIndex = -1;
    s.promptHistoryDraft.clear();
    s.mentionCandidates.clear();
    s.mentionActiveIndex = -1;
    s.requestPromptFocus = true;
}

inline void cancelCorrectionMode(FramePaneState& s) {
    s.correctionMode = false;
    s.promptText = s.correctionDraft;
    s.correctionDraft.clear();
    s.promptHistoryIndex = -1;
    s.promptHistoryDraft.clear();
    s.mentionCandidates.clear();
    s.mentionActiveIndex = -1;
    s.requestPromptFocus = true;
}

// After a submit has been handed to `frame_correct`: leave the mode, clear the
// input, and keep the caret ready for a following prompt. The pane stays open so
// the reply to the correction lands where the user is looking.
inline void leaveCorrectionModeAfterSubmit(FramePaneState& s) {
    s.correctionMode = false;
    s.correctionDraft.clear();
    s.promptText.clear();
    s.mentionCandidates.clear();
    s.mentionActiveIndex = -1;
    s.requestPromptFocus = true;
}

// Render the Frame pane. `open` is opened by the shell on ':' or Enter and closed
// by Esc; `state` carries the persistent editor state.
//
// `canSend` and `canAct` are separate on purpose: sending a prompt and acting on
// the Frame are different acts with different availability. Both are false in a
// replay, where there is no runtime to send a command to — a button that cannot do
// anything must not look like it can.
void renderFramePane(bool& open, FramePaneState& state, const FormulationView& view,
                     const NativeGuiModel& m, bool canSend, bool canAct,
                     bool historyNavigationEnabled, PromptSender send, FrameApprover approve,
                     FrameCorrector correct, FrameAutoApprover setAutoApprove,
                     FrameChipHandler onChip);

} // namespace pie::gui
