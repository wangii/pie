// FramePane: the Frame's panel (docs/milestones.md §7.2), grown out of the v1
// user-prompt palette.
//
// Two parts, because they answer two different questions and §7.4 places them in
// two different rectangles:
//
//   * `renderFramePaneContent` — WHAT THE READING IS, and what the user is being
//     asked to do about it. Rendered into the shell's `frame` child. This is the
//     first surface on which `sources[]` is auditable: a belief chip opens the
//     belief pane, an execution chip centres the canvas.
//   * `renderFramePane` — WHAT THE USER WANTS TO SAY. The floating window the
//     palette always was, opened with ':' and closed with Esc, kept as an overlay
//     so it never reserves a band in the workspace layout.
//
// The two acts the pane exists to keep apart live in the banner, side by side and
// visibly different: `approve_frame` is the ONLY command that means consent, and a
// plain prompt never releases the pause. Hence a separate correction box (not the
// prompt box) and a submit button that says what it does not do.

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
    // The correction box. DELIBERATELY NOT `promptText`: §7.2 requires the two to
    // be separate inputs, so that submitting one can never be mistaken for the
    // other — and so a half-typed prompt is not consumed as an objection.
    std::string correctionText;
    // The version whose full text is being read in the history list, or empty for
    // the current one. Read-only: the pane never edits a published version.
    std::string viewedVersionId;
    bool showDeferral = true;
    bool showCorrections = true;
};

// Render the Frame content into the CURRENT ImGui child (the shell owns the
// rectangle). `canAct` is false in a replay, where there is no runtime to send a
// command to: a button that cannot do anything must not look like it can.
void renderFramePaneContent(const FormulationView& view, const NativeGuiModel& m,
                            FramePaneState& state, bool canAct, FrameApprover approve,
                            FrameCorrector correct, FrameChipHandler onChip);

// Render the floating prompt window. `open` is opened by the shell on ':' or
// Enter and closed by Esc; `state` carries the persistent editor state.
void renderFramePane(bool& open, FramePaneState& state, const pie::gui::NativeGuiModel& m,
                     bool canSend, bool historyNavigationEnabled, PromptSender send);

} // namespace pie::gui
