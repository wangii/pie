// PIE Native GUI - floating user-instruction palette (⌘T / Ctrl-T).
//
// Standalone undecorated window for entering an instruction (submitted via
// Cmd/Ctrl+Enter) and showing the assistant's streaming reply. Interaction
// state is held in an InstructionPaletteState owned by the caller, so the
// render function is otherwise pure (no function-local statics).
#include "InstructionPalette.h"

#include <algorithm>
#include <string>

#include <imgui.h>

#include "PaletteMetrics.h"
#include "PathComplete.h"
#include "UiMarkdown.h"

namespace pie::gui {

// Unified input callback backing state.instrText. It handles three events:
//   CallbackResize    - ImGui wants the buffer to hold BufTextLen bytes; grow
//                       the std::string and hand back a writable, null-\n
//                       terminated pointer (multiline exceeds a stack buffer).
//   CallbackEdit      - text changed; recompute the `@` mention candidate list
//                       against state.workDir.
//   CallbackCompletion- Tab pressed; cycle the highlighted candidate and insert
//                       it into the buffer, or fall back to a literal tab when
//                       there is no active mention / no candidate (preserving
//                       the previous AllowTabInput behavior).
//
// NOTE: with AllowTabInput removed, ImGui forbids combining it with
// CallbackCompletion (asserted in imgui_widgets.cpp), so the completion event
// owns the Tab key. The candidate list is recomputed on CallbackEdit; after a
// Tab insertion we sync instrText back from the callback buffer so the render
// height calc and the submit read the current text.
static int instructionInputCallback(ImGuiInputTextCallbackData* data) {
    auto* state = static_cast<InstructionPaletteState*>(data->UserData);

    if (data->EventFlag == ImGuiInputTextFlags_CallbackResize) {
        state->instrText.resize(static_cast<size_t>(data->BufTextLen));
        data->Buf = const_cast<char*>(state->instrText.data());
        data->BufSize = static_cast<int>(state->instrText.size()) + 1;
        return 0;
    }

    std::string buf(data->Buf, static_cast<size_t>(data->BufTextLen));
    const int cursor = data->CursorPos;

    if (data->EventFlag == ImGuiInputTextFlags_CallbackEdit) {
        const MentionContext ctx = findMention(buf, cursor);
        state->mentionCandidates =
            ctx.active ? completePaths(state->workDir, ctx.query)
                       : std::vector<std::string>{};
        state->mentionActiveIndex = -1;
        return 0;
    }

    if (data->EventFlag == ImGuiInputTextFlags_CallbackCompletion) {
        const MentionContext ctx = findMention(buf, cursor);
        if (!ctx.active || state->mentionCandidates.empty()) {
            // No candidate to complete: keep the previous behavior where a
            // Tab inserts a literal tab character.
            data->InsertChars(cursor, "\t");
            data->CursorPos = cursor + 1;
            data->BufDirty = true;
            return 0;
        }
        const int n = static_cast<int>(state->mentionCandidates.size());
        const int next = (state->mentionActiveIndex + 1) % n;
        const int start = ctx.ampPos + 1;
        // Replace the query region [ampPos+1, cursor) with the next candidate.
        // applyMention mirrors DeleteChars/InsertChars (which are the ImGui-
        // sanctioned buffer edits that keep BufTextLen/undo history correct).
        const MentionCompletion mc =
            applyMention(buf, ctx, state->mentionCandidates, next);
        if (static_cast<int>(ctx.query.size()) > 0)
            data->DeleteChars(start, static_cast<int>(ctx.query.size()));
        data->InsertChars(start, state->mentionCandidates[static_cast<size_t>(next)].c_str());
        data->CursorPos = mc.cursor;
        state->mentionActiveIndex = next;
        data->BufDirty = true;
        // Keep the external std::string in sync with the callback buffer so the
        // autogrow height and the submit read the completed text.
        state->instrText.assign(data->Buf, static_cast<size_t>(data->BufTextLen));
        return 0;
    }

    return 0;
}

void renderInstructionPalette(bool& open, InstructionPaletteState& state,
                              const pie::gui::NativeGuiModel& m, bool canSend,
                              InstructionSender send) {
    if (!open) return;

    // Close on Escape BEFORE rendering the input widget. The focused
    // InputTextMultiline would otherwise see the Escape and run its
    // is_cancel/revert_edit path (EscapeClearsAll is not set), which reverts
    // instrText to the pre-edit snapshot (TextToRevertTo) and discards the
    // user's un-submitted typing. Handling Escape here keeps the caller-owned
    // instrText intact so re-opening (Cmd/Ctrl-T) restores the draft.
    if (ImGui::IsKeyPressed(ImGuiKey_Escape, false)) { open = false; return; }

    // Growable instruction text. Enter inserts a newline (no EnterReturnsTrue);
    // submission is via Cmd/Ctrl+Enter (macOS Cmd, elsewhere Ctrl) so a
    // multiline instruction is preserved end to end and serializeInstructionCommand
    // keeps the newline inside the JSON message on the way to the runtime client.
    std::string& instrBuf = state.instrText;
    auto& io = ImGui::GetIO();

    // Fixed geometry: centered in the app at a quarter of its area (1/2 width x
    // 1/2 height), undecorated (no title bar), and not user-resizable/movable.
    const ImVec2 d = ImGui::GetIO().DisplaySize;
    const ImVec2 winSize(d.x * 0.5f, d.y * 0.5f);
    const ImVec2 winPos((d.x - winSize.x) * 0.5f, (d.y - winSize.y) * 0.5f);
    ImGui::SetNextWindowSize(winSize, ImGuiCond_Always);
    ImGui::SetNextWindowPos(winPos, ImGuiCond_Always);
    bool close = false;
    const ImGuiWindowFlags flags = ImGuiWindowFlags_NoTitleBar | ImGuiWindowFlags_NoResize |
                                   ImGuiWindowFlags_NoMove | ImGuiWindowFlags_NoCollapse;
    state.workDir = m.session();
    if (ImGui::Begin("User Instruction", &close, flags)) {
        // Keep the input box focused the entire time the window is visible so the
        // user can keep typing without clicking.
        ImGui::SetKeyboardFocusHere();

        ImGui::TextUnformatted(">");
        ImGui::SameLine();
        ImGui::SetNextItemWidth(-1.0f);

        // Auto-grow the input height as the text wraps past the available width.
        // Measure the wrapped height of the current buffer at the widget width.
        const float framePad = ImGui::GetStyle().FramePadding.y * 2.0f;
        const float widgetW = ImGui::GetContentRegionAvail().x;
        const float innerW = widgetW - ImGui::GetStyle().FramePadding.x * 2.0f;
        const float lineH = ImGui::GetTextLineHeight();
        const ImVec2 wrapped = ImGui::CalcTextSize(instrBuf.c_str(), nullptr, false, innerW);
        // Reserve one extra line when the buffer ends in a newline (the cursor
        // sits on a fresh empty line that CalcTextSize.y does not count).
        const int extraLines = paletteTrailingEmptyLines(instrBuf.c_str());
        const float inputH = paletteInputBoxHeight(wrapped.y, lineH, framePad, extraLines);
        // Clamp so the input can't consume the entire panel; the in-message area
        // keeps the rest.
        const float maxInputH = winSize.y * 0.5f;
        ImGui::InputTextMultiline("##instruction", instrBuf.data(), static_cast<int>(instrBuf.size()) + 1,
                                  ImVec2(-1.0f, std::min(inputH, maxInputH)),
                                  ImGuiInputTextFlags_CallbackResize | ImGuiInputTextFlags_CallbackEdit |
                                      ImGuiInputTextFlags_CallbackCompletion | ImGuiInputTextFlags_WordWrap,
                                  instructionInputCallback, &state);

        // `@` mention candidate list. Tab (handled in the completion callback)
        // cycles the active index and inserts the candidate; here we only render
        // the list and highlight the active entry. Clicking sets the active
        // index but does not insert (Tab is the select mechanism).
        if (ImGui::IsItemActive() && !state.mentionCandidates.empty()) {
            const int n = static_cast<int>(state.mentionCandidates.size());
            const float rowH = ImGui::GetTextLineHeightWithSpacing();
            const float maxListH = std::min(winSize.y * 0.30f, rowH * std::min(n, 8));
            if (ImGui::BeginChild("mention_list", ImVec2(0, maxListH), true)) {
                for (int i = 0; i < n; ++i) {
                    const bool sel = (i == state.mentionActiveIndex);
                    if (ImGui::Selectable(state.mentionCandidates[static_cast<size_t>(i)].c_str(), sel)) {
                        state.mentionActiveIndex = i;
                    }
                }
            }
            ImGui::EndChild();
        }

        // Submit via Cmd/Ctrl+Enter (macOS Cmd, elsewhere Ctrl) so Enter still
        // inserts a newline and a multiline instruction is preserved end to end.
        // The input does not use EnterReturnsTrue, so plain Enter is consumed by
        // the widget as a newline while the Cmd/Ctrl+Enter chord is not, so this
        // check cannot hijack newline input. In live mode this goes through
        // serializeInstructionCommand, which keeps the newline in the JSON.
        if ((io.KeySuper || io.KeyCtrl) && ImGui::IsKeyPressed(ImGuiKey_Enter, false)) {
            std::string instr = instrBuf;
            instrBuf.clear();
            if (canSend && send && !instr.empty()) {
                send(instr);  // reverse path: instruction -> runtime client
            }
        }

        // in-message (the assistant's streaming reply). Rendered below the input
        // box and filling the remaining panel space, auto-scrolling to the bottom
        // as it grows. Only live mode feeds message_start/message_update/message_end;
        // in demo mode this stays empty.
        ImGui::Separator();
        ImGui::BeginChild("in_message", ImVec2(0, 0), true);

        // Cmd/Ctrl+Up/Down scroll the incoming message area one page at a time.
        // The chord is read while the in_message child is the active window so
        // GetScrollY/SetScrollY target this child (not the input box).
        {
            const float maxScroll = ImGui::GetScrollMaxY();
            // Page step = the child's visible height (a full page of message).
            const float pageStep = std::max(ImGui::GetContentRegionAvail().y, 1.0f);
            if ((io.KeySuper || io.KeyCtrl) && ImGui::IsKeyPressed(ImGuiKey_DownArrow, false)) {
                const float y = paletteScrollByPage(ImGui::GetScrollY(), pageStep, maxScroll, +1);
                ImGui::SetScrollY(y);
                // Re-pin to the bottom once the user scrolls down to the end.
                if (paletteScrollAtBottom(y, maxScroll)) state.inMessagePinned = true;
            }
            if ((io.KeySuper || io.KeyCtrl) && ImGui::IsKeyPressed(ImGuiKey_UpArrow, false)) {
                const float y = paletteScrollByPage(ImGui::GetScrollY(), pageStep, maxScroll, -1);
                ImGui::SetScrollY(y);
                // Scrolling up unpins so streaming content no longer yanks the
                // view back to the bottom; stay pinned only when there is no
                // content above to scroll back through.
                if (maxScroll > 0.0f) state.inMessagePinned = false;
            }
        }

        if (!m.inMessage().empty()) {
            // Render the incoming assistant reply (including the finalReport
            // conclusion, which reaches this same buffer) as Markdown. During
            // the thinking phase the model still accumulates reasoning deltas
            // into inMessage_, so render that content rather than hiding it.
            renderMarkdownMessage(m.inMessage());
        } else if (m.inMessageThinking()) {
            // No content yet but the live message is still thinking.
            ImGui::TextDisabled("thinking");
        } else {
            ImGui::TextDisabled("(waiting for a live message...)");
        }
        // Auto-scroll to the bottom on new content only while pinned to the
        // bottom; if the user scrolled up we leave the view where it is. On a
        // fresh message (or after re-pinning) this snaps back to the tail.
        if (m.inMessage().size() != state.lastInMessageLength && state.inMessagePinned) {
            ImGui::SetScrollHereY(1.0f);
        }
        state.lastInMessageLength = m.inMessage().size();
        ImGui::EndChild();
    }
    ImGui::End();

    if (close) { open = false; }
    ImGui::SetNextFrameWantCaptureKeyboard(true);
}

} // namespace pie::gui
