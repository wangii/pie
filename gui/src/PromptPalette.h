// PIE Native GUI - floating user-prompt palette (⌘T / Ctrl-T).
//
// A standalone undecorated window for entering a user prompt (submitted via
// Cmd/Ctrl+Enter) and showing the assistant's streaming reply. Interaction
// state previously held in function-local statics (instrBuf, lastInMsgLen) has
// been moved into an explicit PromptPaletteState owned by the caller.
#pragma once

#include <functional>
#include <string>
#include <vector>

#include "Model.h"

namespace pie::gui {

// Callback that sends one user prompt back to the runtime client (live mode).
using PromptSender = std::function<void(const std::string&)>;

// Explicit mutable state for the palette, owned by the caller (main). Replaces
// the former function-local statics so the render function stays otherwise pure.
struct PromptPaletteState {
    std::string promptText;        // growable user prompt buffer (was `instrText`/`instrBuf`)
    size_t lastInMessageLength = 0; // in-message length since last auto-scroll (was `lastInMsgLen`)
    bool inMessagePinned = true;    // while pinned, new content auto-scrolls to the bottom

    // "@" file/folder completion state, populated by the input callback each
    // frame and rendered as a candidate list below the input box. The working
    // directory is the base for enumerating candidates.
    std::string workDir;                     // base dir for path completion (model session)
    std::vector<std::string> mentionCandidates; // matches for the current `@` query
    int mentionActiveIndex = -1;             // highlighted candidate (-1 = none)
};

// Render the palette as a floating window. `open` is toggled by the caller via
// Cmd/Ctrl-T and Escape/close; `state` carries the persistent editor state.
void renderPromptPalette(bool& open, PromptPaletteState& state,
                         const pie::gui::NativeGuiModel& m, bool canSend,
                         PromptSender send);

} // namespace pie::gui
