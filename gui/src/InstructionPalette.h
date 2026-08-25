// PIE Native GUI - floating user-instruction palette (⌘T / Ctrl-T).
//
// A standalone undecorated window for entering an instruction (submitted via
// Cmd/Ctrl+Enter) and showing the assistant's streaming reply. Interaction
// state previously held in function-local statics (instrBuf, lastInMsgLen) has
// been moved into an explicit InstructionPaletteState owned by the caller.
#pragma once

#include <functional>
#include <string>

#include "Model.h"

namespace pie::gui {

// Callback that sends one instruction back to the runtime client (live mode).
using InstructionSender = std::function<void(const std::string&)>;

// Explicit mutable state for the palette, owned by the caller (main). Replaces
// the former function-local statics so the render function stays otherwise pure.
struct InstructionPaletteState {
    std::string instrText;         // growable instruction buffer (was `instrBuf`)
    size_t lastInMessageLength = 0; // in-message length since last auto-scroll (was `lastInMsgLen`)
    bool inMessagePinned = true;    // while pinned, new content auto-scrolls to the bottom
};

// Render the palette as a floating window. `open` is toggled by the caller via
// Cmd/Ctrl-T and Escape/close; `state` carries the persistent editor state.
void renderInstructionPalette(bool& open, InstructionPaletteState& state,
                              const pie::gui::NativeGuiModel& m, bool canSend,
                              InstructionSender send);

} // namespace pie::gui
