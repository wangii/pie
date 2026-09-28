// PIE Native GUI - the Frame's floating prompt window (opened with ':', closed
// with Esc).
//
// The half of the FramePane that carries what the user wants to SAY. The content
// half (what the reading IS) is `renderFramePaneContent` below, rendered into the
// shell's frame child.
//
// Untouched from the v1 palette, because these are orthogonal to the Frame and
// already tested: multiline input submitted with Cmd/Ctrl+Enter, `@` mention
// completion, prompt history on Up/Down, archived-reply paging, and the streaming
// markdown reply. What changed is the submit button, whose label now says what
// sending does NOT do (docs/milestones.md §7.2): a plain prompt never releases the
// pause, and the user must not be able to mistake it for consent.
//
// Interaction state is held in a FramePaneState owned by the caller, so the
// render function is otherwise pure (no function-local statics).
#include "FramePane.h"

#include <algorithm>
#include <string>

#include <imgui.h>

#include "PaletteMetrics.h"
#include "PathComplete.h"
#include "Theme.h"
#include "UiMarkdown.h"

namespace pie::gui {

// Unified input callback backing state.promptText. It handles three events:
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
// Tab insertion we sync promptText back from the callback buffer so the render
// height calc and the submit read the current text.
static int promptInputCallback(ImGuiInputTextCallbackData* data) {
    auto* state = static_cast<FramePaneState*>(data->UserData);

    if (data->EventFlag == ImGuiInputTextFlags_CallbackResize) {
        state->promptText.resize(static_cast<size_t>(data->BufTextLen));
        data->Buf = const_cast<char*>(state->promptText.data());
        data->BufSize = static_cast<int>(state->promptText.size()) + 1;
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
        state->promptText.assign(data->Buf, static_cast<size_t>(data->BufTextLen));
        return 0;
    }

    return 0;
}

void renderFramePane(bool& open, FramePaneState& state,
                          const pie::gui::NativeGuiModel& m, bool canSend,
                          bool historyNavigationEnabled, PromptSender send) {
    if (!open) return;

    // Close on Escape BEFORE rendering the input widget. The focused
    // InputTextMultiline would otherwise see the Escape and run its
    // is_cancel/revert_edit path (EscapeClearsAll is not set), which reverts
    // promptText to the pre-edit snapshot (TextToRevertTo) and discards the
    // user's un-submitted typing. Handling Escape here keeps the caller-owned
    // promptText intact so re-opening (':') restores the draft.
    if (ImGui::IsKeyPressed(ImGuiKey_Escape, false)) { open = false; return; }

    // Growable prompt text. Enter inserts a newline (no EnterReturnsTrue);
    // submission is via Cmd/Ctrl+Enter (macOS Cmd, elsewhere Ctrl) so a
    // multiline prompt is preserved end to end and serializePromptCommand
    // keeps the newline inside the JSON message on the way to the runtime client.
    std::string& promptBuf = state.promptText;
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
    if (ImGui::Begin("User Prompt", &close, flags)) {
        // Focus the input when the palette (re)appears so the user can type
        // immediately. Requesting focus every frame kept re-issuing a nav/active
        // id request that swallowed the pager arrow buttons' press/release, so
        // clicks on them never fired. Plain Up/Down browse submitted prompts;
        // modified arrows remain available for editor/message scrolling.
        if (ImGui::IsWindowAppearing()) ImGui::SetKeyboardFocusHere();

        // Cmd/Ctrl+Left/Right page through the archived in-message replies, the
        // same steps as the arrow buttons. io.KeyCtrl is the platform's primary
        // shortcut modifier (ImGuiMod_Ctrl means Cmd on macOS and Ctrl on the
        // other platforms), so this yields Cmd+Left/Right on macOS and
        // Ctrl+Left/Right elsewhere. Read with the default (Any) key owner: the
        // focused InputText owns the arrow keys, so an owner-scoped Shortcut()
        // would never route, while IsKeyPressed() with Any still observes the
        // chord.
        const bool pageMod = io.KeyCtrl;
        const bool shortcutPrev = pageMod && ImGui::IsKeyPressed(ImGuiKey_LeftArrow, false);
        const bool shortcutNext = pageMod && ImGui::IsKeyPressed(ImGuiKey_RightArrow, false);
        if (historyNavigationEnabled && !io.KeyCtrl && !io.KeySuper && !io.KeyAlt && !io.KeyShift) {
            if (ImGui::IsKeyPressed(ImGuiKey_UpArrow, false) && !state.promptHistory.empty()) {
                if (state.promptHistoryIndex < 0) {
                    state.promptHistoryDraft = promptBuf;
                    state.promptHistoryIndex = static_cast<int>(state.promptHistory.size()) - 1;
                } else if (state.promptHistoryIndex > 0) {
                    --state.promptHistoryIndex;
                }
                promptBuf = state.promptHistory[static_cast<size_t>(state.promptHistoryIndex)];
            } else if (ImGui::IsKeyPressed(ImGuiKey_DownArrow, false) && state.promptHistoryIndex >= 0) {
                if (state.promptHistoryIndex + 1 < static_cast<int>(state.promptHistory.size())) {
                    ++state.promptHistoryIndex;
                    promptBuf = state.promptHistory[static_cast<size_t>(state.promptHistoryIndex)];
                } else {
                    state.promptHistoryIndex = -1;
                    promptBuf = state.promptHistoryDraft;
                    state.promptHistoryDraft.clear();
                }
            }
        }

        ImGui::SetNextItemWidth(-1.0f);

        // Auto-grow the input height as the text wraps past the available width.
        // Measure the wrapped height of the current buffer at the widget width.
        const float framePad = ImGui::GetStyle().FramePadding.y * 2.0f;
        const float widgetW = ImGui::GetContentRegionAvail().x;
        const float innerW = widgetW - ImGui::GetStyle().FramePadding.x * 2.0f;
        const float lineH = ImGui::GetTextLineHeight();
        const ImVec2 wrapped = ImGui::CalcTextSize(promptBuf.c_str(), nullptr, false, innerW);
        // Reserve one extra line when the buffer ends in a newline (the cursor
        // sits on a fresh empty line that CalcTextSize.y does not count).
        const int extraLines = paletteTrailingEmptyLines(promptBuf.c_str());
        const float inputH = paletteInputBoxHeight(wrapped.y, lineH, framePad, extraLines);
        // Clamp so the input can't consume the entire panel; the in-message area
        // keeps the rest.
        const float maxInputH = winSize.y * 0.5f;
        ImGui::InputTextMultiline("##prompt", promptBuf.data(), static_cast<int>(promptBuf.size()) + 1,
                                  ImVec2(-1.0f, std::min(inputH, maxInputH)),
                                  ImGuiInputTextFlags_CallbackResize | ImGuiInputTextFlags_CallbackEdit |
                                      ImGuiInputTextFlags_CallbackCompletion | ImGuiInputTextFlags_WordWrap,
                                  promptInputCallback, &state);

        // Any typing/editing after loading a history entry starts a fresh draft.
        if (state.promptHistoryIndex >= 0 &&
            promptBuf != state.promptHistory[static_cast<size_t>(state.promptHistoryIndex)]) {
            state.promptHistoryIndex = -1;
            state.promptHistoryDraft.clear();
        }

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
        // inserts a newline and a multiline prompt is preserved end to end.
        // The input does not use EnterReturnsTrue, so plain Enter is consumed by
        // the widget as a newline while the Cmd/Ctrl+Enter chord is not, so this
        // check cannot hijack newline input. In live mode this goes through
        // serializePromptCommand, which keeps the newline in the JSON.
        bool submit = (io.KeySuper || io.KeyCtrl) && ImGui::IsKeyPressed(ImGuiKey_Enter, false);
        // The visible button, so the rule is readable rather than only discoverable:
        // §7.2 requires the submit control to say that sending is NOT approving the
        // Frame. The label is the whole reason this button exists next to a working
        // keyboard chord.
        ImGui::BeginDisabled(!canSend || promptBuf.empty());
        if (ImGui::Button("Send (does not approve the Frame)")) submit = true;
        ImGui::EndDisabled();
        if (submit) {
            std::string prompt = promptBuf;
            promptBuf.clear();
            state.promptHistoryIndex = -1;
            state.promptHistoryDraft.clear();
            if (historyNavigationEnabled && canSend && send && !prompt.empty()) {
                state.promptHistory.push_back(prompt);
                send(prompt);  // reverse path: user prompt -> runtime client
            }
        }

        // in-message (the assistant's streaming reply). Rendered below the input
        // box and filling the remaining panel space, auto-scrolling to the bottom
        // as it grows. Only live mode feeds message_start/message_update/message_end;
        // in demo mode this stays empty.
        ImGui::Separator();

        // Archived-reply pager: -1 is the live/latest reply; 0..N-1 index into
        // NativeGuiModel::inMessageHistory() (oldest first). History indices are
        // append-only, so browsing an old reply is not disturbed by new messages.
        const auto& inHistory = m.inMessageHistory();
        if (state.inMessageHistoryIndex >= static_cast<int>(inHistory.size()))
            state.inMessageHistoryIndex = -1;
        const int navPage = state.inMessageHistoryIndex;
        const bool navLive = navPage < 0;
        const bool canPrev = navLive ? !inHistory.empty() : navPage > 0;
        const bool canNext = !navLive;
        ImGui::BeginDisabled(!canPrev);
        const bool clickPrev = ImGui::ArrowButton("in_msg_prev", ImGuiDir_Left);
        ImGui::EndDisabled();
        ImGui::SameLine();
        ImGui::BeginDisabled(!canNext);
        const bool clickNext = ImGui::ArrowButton("in_msg_next", ImGuiDir_Right);
        ImGui::EndDisabled();
        ImGui::SameLine();
        // Buttons and keyboard chords share one step so a click plus a held chord
        // cannot advance two pages in one frame.
        if ((clickPrev || shortcutPrev) && canPrev)
            state.inMessageHistoryIndex = navLive ? static_cast<int>(inHistory.size()) - 1 : navPage - 1;
        else if ((clickNext || shortcutNext) && canNext)
            state.inMessageHistoryIndex =
                (navPage + 1 < static_cast<int>(inHistory.size())) ? navPage + 1 : -1;
        // Read the page AFTER the buttons so a click this frame selects the page
        // rendered below; using the pre-click index would lag the content/scroll
        // bookkeeping by one frame.
        const int page = state.inMessageHistoryIndex;
        const bool livePage = page < 0;
        if (livePage) {
            ImGui::TextDisabled("latest");
        } else {
            ImGui::TextDisabled("history %d/%d", page + 1, static_cast<int>(inHistory.size()));
        }

        ImGui::BeginChild("in_message", ImVec2(0, 0), true);

        // The selected page's text/error flag. Only the live page streams and
        // auto-scrolls; archived pages render their frozen text.
        const std::string& shownText =
            livePage ? m.inMessage() : inHistory[static_cast<size_t>(page)].text;
        const bool shownError =
            livePage ? m.inMessageError() : inHistory[static_cast<size_t>(page)].error;

        // Cmd/Ctrl+Up/Down scroll the current page one page at a time. The chord
        // is read while the in_message child is the active window so
        // GetScrollY/SetScrollY target this child (not the input box).
        {
            const float maxScroll = ImGui::GetScrollMaxY();
            // Page step = the child's visible height (a full page of message).
            const float pageStep = std::max(ImGui::GetContentRegionAvail().y, 1.0f);
            if ((io.KeySuper || io.KeyCtrl) && ImGui::IsKeyPressed(ImGuiKey_DownArrow, false)) {
                const float y = paletteScrollByPage(ImGui::GetScrollY(), pageStep, maxScroll, +1);
                ImGui::SetScrollY(y);
                // Re-pin to the bottom once the user scrolls down to the end.
                if (livePage && paletteScrollAtBottom(y, maxScroll)) state.inMessagePinned = true;
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

        if (!shownText.empty()) {
            // Render RPC failures in red; normal assistant replies retain the
            // markdown renderer's default text color.
            if (shownError) ImGui::PushStyleColor(ImGuiCol_Text, kRed);
            renderMarkdownMessage(shownText);
            if (shownError) ImGui::PopStyleColor();
        } else if (livePage && m.inMessageThinking()) {
            // No content yet but the live message is still thinking.
            ImGui::TextDisabled("thinking");
        } else {
            ImGui::TextDisabled(livePage ? "(waiting for a live message...)"
                                         : "(empty archived message)");
        }
        // On a page switch, jump to the start of an archived reply. Returning to
        // the live page jumps to the tail and re-pins: otherwise the length-based
        // auto-scroll below would not fire (the live length is unchanged) and the
        // latest reply would stay stuck at the top and unpinned.
        if (state.lastInMessagePage != page) {
            state.lastInMessagePage = page;
            if (livePage) {
                state.inMessagePinned = true;
                ImGui::SetScrollHereY(1.0f);
            } else {
                state.inMessagePinned = false;
                ImGui::SetScrollY(0.0f);
            }
        }
        // Auto-scroll to the bottom on new content only for the live page while
        // pinned to the bottom; browsing an archived page never moves.
        if (livePage && m.inMessage().size() != state.lastInMessageLength && state.inMessagePinned) {
            ImGui::SetScrollHereY(1.0f);
        }
        state.lastInMessageLength = m.inMessage().size();
        ImGui::EndChild();
    }
    ImGui::End();

    if (close) { open = false; }
    ImGui::SetNextFrameWantCaptureKeyboard(true);
}

// ---------------------------------------------------------------------------
// The Frame's content half (§7.2)
// ---------------------------------------------------------------------------
namespace {

// The correction box's buffer is a std::string, so it needs the same
// CallbackResize contract the prompt box uses: ImGui asks for a buffer of the
// length it wants and the callback re-points it. A fixed char array would cap the
// objection at an arbitrary size, which is exactly the wrong thing to cap.
int correctionResizeCallback(ImGuiInputTextCallbackData* data) {
    if (data->EventFlag == ImGuiInputTextFlags_CallbackResize) {
        auto* text = static_cast<std::string*>(data->UserData);
        text->resize(static_cast<size_t>(data->BufTextLen));
        data->Buf = const_cast<char*>(text->data());
        data->BufSize = static_cast<int>(text->size()) + 1;
    }
    return 0;
}

// A source chip. Clickable only where the pane has somewhere to send the click: a
// belief opens the belief pane and an execution or a distillation centres the
// canvas, while a prompt or an intervention has no node to point at and is
// rendered as plain text rather than as a link that does nothing.
void renderChips(const ProblemFormulationVersion& version, const NativeGuiModel& m,
                 const FrameChipHandler& onChip) {
    const std::vector<FormulationChip> chips = formulationChips(m, version);
    if (chips.empty()) return;
    ImGui::TextDisabled("sources");
    ImGui::SameLine();
    for (size_t i = 0; i < chips.size(); ++i) {
        const FormulationChip& chip = chips[i];
        if (i != 0) ImGui::SameLine();
        const bool clickable = chip.opensBeliefs || chip.centresCanvas;
        if (!clickable) {
            ImGui::TextDisabled("%s", chip.label.c_str());
            continue;
        }
        ImGui::PushID(static_cast<int>(i));
        if (ImGui::SmallButton(chip.label.c_str()) && onChip) onChip(chip);
        if (ImGui::IsItemHovered()) {
            ImGui::SetTooltip(chip.opensBeliefs ? "open %s in the belief list" : "centre the canvas on %s",
                              chip.label.c_str());
        }
        ImGui::PopID();
    }
}

// One labelled paragraph. The optional fields (alternative, tension) are rendered
// ONLY when present: §7.2 asks for them in a grey block, and a heading with
// nothing under it would read as an empty field rather than an absent one.
void fieldBlock(const char* label, const std::string& text, bool dim = false) {
    if (text.empty()) return;
    if (dim) ImGui::PushStyleColor(ImGuiCol_Text, kGray);
    ImGui::TextDisabled("%s", label);
    ImGui::TextWrapped("%s", text.c_str());
    if (dim) ImGui::PopStyleColor();
}

void renderVersionBody(const ProblemFormulationVersion& version, const NativeGuiModel& m,
                       const FrameChipHandler& onChip) {
    ImGui::Text("v%llu", static_cast<unsigned long long>(version.ordinal));
    ImGui::SameLine();
    ImGui::TextDisabled("%s  %s", version.recordedAt.c_str(), version.origin.c_str());
    fieldBlock("interpretation", version.content.interpretation);
    fieldBlock("focus", version.content.focus);
    fieldBlock("implication", version.content.implication);
    // Optional and, when present, deliberately quieter: an alternative the agent
    // considered is not part of the position it is taking.
    fieldBlock("alternative", version.content.alternative.value_or(std::string{}), true);
    fieldBlock("tension", version.content.tension.value_or(std::string{}), true);
    fieldBlock("reason", version.reason);
    renderChips(version, m, onChip);
}

void renderBanner(const FormulationView& view, FramePaneState& state, bool canAct,
                  const FrameApprover& approve, const FrameCorrector& correct) {
    if (view.banner == FrameBanner::None) return;

    // The paused case is the only one where the user has an act to perform, so it
    // is the only one that gets a colour of its own. Everything else is
    // informational, and colouring it the same way would make every round look
    // like it needs an answer.
    const bool actionable = view.banner == FrameBanner::AwaitingResponse;
    const ImVec4 colour = actionable ? kAccent : kGray;
    ImGui::PushStyleColor(ImGuiCol_Text, colour);
    if (view.banner == FrameBanner::ApprovalFailed) {
        ImGui::TextWrapped("%s: %s", frameBannerText(view.banner),
                           view.bannerDetail.empty() ? "(no reason given)" : view.bannerDetail.c_str());
    } else if (view.banner == FrameBanner::RecheckOwed) {
        if (view.recheckEpisodeOrdinal.has_value()) {
            ImGui::Text("%s of episode #%llu", frameBannerText(view.banner),
                        static_cast<unsigned long long>(*view.recheckEpisodeOrdinal));
        } else {
            ImGui::TextUnformatted(frameBannerText(view.banner));
        }
    } else {
        ImGui::TextUnformatted(frameBannerText(view.banner));
    }
    ImGui::PopStyleColor();

    if (!actionable) return;

    // Approve is the ONLY primary button in the GUI, and it is offered only while
    // the run is paused on this version. Its id is the review's: `approve_frame`
    // validates the version, and sending anything else would be refused.
    ImGui::BeginDisabled(!canAct);
    if (ImGui::Button("Approve") && approve) approve(view.reviewVersionId);
    ImGui::EndDisabled();
    if (ImGui::IsItemHovered()) {
        ImGui::SetTooltip(
            "Approve the reading under review (%s) and let the run continue.\n"
            "This is the only action that releases the pause. A prompt does not.",
            view.reviewVersionId.c_str());
    }

    // Correct: its own input, because an objection is not an approval and must not
    // be typed into the same box as a prompt.
    ImGui::SameLine();
    ImGui::TextDisabled("or object:");
    ImGui::SameLine();
    ImGui::SetNextItemWidth(-90.0f);
    ImGui::InputTextWithHint("##correction", "what the reading gets wrong", state.correctionText.data(),
                             state.correctionText.size() + 1, ImGuiInputTextFlags_CallbackResize,
                             correctionResizeCallback, &state.correctionText);
    ImGui::SameLine();
    ImGui::BeginDisabled(!canAct || state.correctionText.empty());
    if (ImGui::Button("Submit objection")) {
        if (correct) correct(state.correctionText);
        state.correctionText.clear();
    }
    ImGui::EndDisabled();
}

} // namespace

void renderFramePaneContent(const FormulationView& view, const NativeGuiModel& m,
                            FramePaneState& state, bool canAct, FrameApprover approve,
                            FrameCorrector correct, FrameChipHandler onChip) {
    if (!view.hasTask) {
        ImGui::TextDisabled("no task: there is no Frame to show");
        return;
    }

    renderBanner(view, state, canAct, approve, correct);
    ImGui::Separator();

    // --- the current Frame -------------------------------------------------
    // The version being read is the one the history list selected, or the current
    // one. A historical version is shown by the SAME renderer, so what the user
    // compares is one layout rather than two.
    const ProblemFormulationVersion* shown = view.current;
    bool showingHistory = false;
    if (!state.viewedVersionId.empty() && view.current != nullptr &&
        state.viewedVersionId != view.current->id) {
        for (const ProblemFormulationVersion* version : view.history) {
            if (version->id == state.viewedVersionId) {
                shown = version;
                showingHistory = true;
            }
        }
    }
    if (shown == nullptr) {
        ImGui::TextDisabled("no reading published yet");
    } else {
        if (showingHistory) {
            ImGui::PushStyleColor(ImGuiCol_Text, kAmber);
            ImGui::TextUnformatted("reading a previous version (read-only)");
            ImGui::PopStyleColor();
            ImGui::SameLine();
            if (ImGui::SmallButton("back to current")) state.viewedVersionId.clear();
        }
        renderVersionBody(*shown, m, onChip);
    }

    // --- the deferral ------------------------------------------------------
    if (view.deferral != nullptr && state.showDeferral) {
        ImGui::Separator();
        ImGui::TextDisabled("deferred");
        fieldBlock("missing", view.deferral->missingInformation);
        fieldBlock("reason", view.deferral->reason);
        ImGui::TextDisabled("deferred at %s", view.deferral->deferredAt.c_str());
    }

    // --- corrections -------------------------------------------------------
    if (!view.corrections.empty() && state.showCorrections) {
        ImGui::Separator();
        ImGui::TextDisabled("your corrections");
        for (const FormulationCorrection* correction : view.corrections) {
            const bool pending = correction->status == FormulationCorrectionStatus::Pending;
            // Pending first, and marked: an objection nobody has answered is the
            // one the user is waiting on.
            if (pending) ImGui::PushStyleColor(ImGuiCol_Text, kAccent);
            ImGui::TextWrapped("[%s] %s", toString(correction->status), correction->original.c_str());
            if (pending) ImGui::PopStyleColor();
            if (correction->response.has_value()) {
                ImGui::Indent();
                ImGui::PushStyleColor(ImGuiCol_Text, kGray);
                ImGui::TextWrapped("answered: %s", correction->response->c_str());
                ImGui::PopStyleColor();
                if (correction->recordedVersionId.has_value()) {
                    ImGui::TextDisabled("recorded as %s", correction->recordedVersionId->c_str());
                }
                ImGui::Unindent();
            }
        }
    }

    // --- the review's outstanding beliefs ----------------------------------
    // These block the conclusion, and no other surface shows them (§7.2 item 5).
    if (!view.pendingApplicability.empty() || !view.unrevalidated.empty()) {
        ImGui::Separator();
        ImGui::TextDisabled("review obligations");
        for (const BeliefId& id : view.pendingApplicability) {
            ImGui::PushStyleColor(ImGuiCol_Text, kAmber);
            ImGui::Text("needs a decision: %s", m.beliefLabel(id).c_str());
            ImGui::PopStyleColor();
        }
        for (const BeliefId& id : view.unrevalidated) {
            ImGui::PushStyleColor(ImGuiCol_Text, kGray);
            ImGui::Text("awaiting revalidation: %s", m.beliefLabel(id).c_str());
            ImGui::PopStyleColor();
        }
    }

    // --- the last reconsideration ------------------------------------------
    if (view.recheck != nullptr) {
        ImGui::Separator();
        ImGui::Text("recheck: %s", toString(view.recheck->verdict));
        ImGui::SameLine();
        ImGui::TextDisabled("%s  episode %s", view.recheck->recordedAt.c_str(),
                            view.recheck->episodeId.c_str());
        fieldBlock("why", view.recheck->reason);
        if (view.recheck->versionId.has_value()) {
            ImGui::TextDisabled("revised as %s", view.recheck->versionId->c_str());
        }
    }

    // --- the version history -----------------------------------------------
    if (view.history.size() > 1) {
        ImGui::Separator();
        ImGui::TextDisabled("history");
        for (size_t i = 0; i < view.history.size(); ++i) {
            const ProblemFormulationVersion& version = *view.history[i];
            ImGui::PushID(static_cast<int>(i));
            const bool selected = shown == &version;
            if (ImGui::Selectable(("v" + std::to_string(version.ordinal) + "  " + version.recordedAt + "  " +
                                   version.reason)
                                      .c_str(),
                                  selected)) {
                state.viewedVersionId = (view.current == &version) ? std::string{} : version.id;
            }
            // The CHANGED FIELDS, not a text diff: §7.2 rules the diff out as
            // inference and asks for the field markers instead. The first version
            // has no predecessor, so the marker line belongs to the revisions.
            if (i > 0) {
                const std::vector<std::string> changed =
                    formulationChangedFields(*view.history[i - 1], version);
                ImGui::SameLine();
                if (changed.empty()) {
                    ImGui::TextDisabled("(same fields)");
                } else {
                    std::string joined;
                    for (size_t k = 0; k < changed.size(); ++k) {
                        if (k != 0) joined += ", ";
                        joined += changed[k];
                    }
                    ImGui::TextDisabled("\xce\x94 %s", joined.c_str());  // Δ
                }
            }
            ImGui::PopID();
        }
    }
}

} // namespace pie::gui
