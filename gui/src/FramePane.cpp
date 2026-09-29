// PIE Native GUI - the Frame pane (the v1 user-prompt palette, now carrying the
// reading as well as the reply).
//
// One window, read top to bottom: the banner and the acts it can offer, the
// Frame body (scrolling), then the prompt box and the assistant's streaming
// reply. See FramePane.h for why the reading and the reply are one surface and
// not two.
//
// The prompt half is untouched from the v1 palette, because these are orthogonal
// to the Frame and already tested: multiline input submitted with Cmd/Ctrl+Enter,
// `@` mention completion, prompt history on Up/Down, archived-reply paging, and
// the streaming markdown reply. What changed is the submit button, whose label now
// says what sending does NOT do (docs/milestones.md §7.2): a plain prompt never
// releases the pause, and the user must not be able to mistake it for consent.
//
// Interaction state is held in a FramePaneState owned by the caller, so the
// render function is otherwise pure (no function-local statics).
#include "FramePane.h"

#include <algorithm>
#include <string>
#include <vector>

#include <imgui.h>

#include "PaletteMetrics.h"
#include "PathComplete.h"
#include "Theme.h"
#include "UiMarkdown.h"

namespace pie::gui {

namespace {

// Why acts are unavailable in a session that has no runtime. Named once so
// the disabled control and the line explaining it cannot drift apart.
//
// Short on purpose: this window is 72% of the app's width, so on a small window it
// is ~270px wide, and a sentence here wraps to seven lines and pushes the controls
// off the top of the pane. The reason has to survive the narrowest window the
// layout allows, or it hides the very buttons it is explaining.
constexpr const char* kNoRuntimeReason = "read-only: no runtime (--demo)";

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
int promptInputCallback(ImGuiInputTextCallbackData* data) {
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
        if (state->correctionMode) {
            // A correction is prose: there is no path to complete and no mention
            // to highlight, so the candidate list stays empty in this mode.
            state->mentionCandidates.clear();
            state->mentionActiveIndex = -1;
            return 0;
        }
        const MentionContext ctx = findMention(buf, cursor);
        state->mentionCandidates =
            ctx.active ? completePaths(state->workDir, ctx.query)
                       : std::vector<std::string>{};
        state->mentionActiveIndex = -1;
        return 0;
    }

    if (data->EventFlag == ImGuiInputTextFlags_CallbackCompletion) {
        if (state->correctionMode) {
            // No mention is active in correction mode, so Tab keeps its old
            // literal-tab behavior rather than inserting a candidate.
            data->InsertChars(cursor, "\t");
            data->CursorPos = cursor + 1;
            data->BufDirty = true;
            return 0;
        }
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

// ---------------------------------------------------------------------------
// The reading half (§7.2)
// ---------------------------------------------------------------------------

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

    // The version's semantic fields, one tab per section. These are the sections
    // the user named as needing to be browsed item by item; the process records
    // below the version body (deferral, corrections, review obligations, recheck,
    // history) stay OUTSIDE the tabs, so changing tabs can never hide a pending
    // action. A field that is absent gets no tab: a heading over nothing would
    // read as an empty field rather than an absent one.
    struct Section {
        const char* name;
        const std::string* text;
        bool dim;
    };
    std::vector<Section> sections;
    if (!version.content.interpretation.empty())
        sections.push_back({"interpretation", &version.content.interpretation, false});
    if (!version.content.focus.empty())
        sections.push_back({"focus", &version.content.focus, false});
    if (!version.content.implication.empty())
        sections.push_back({"implication", &version.content.implication, false});
    // Optional and, when present, deliberately quieter: an alternative the agent
    // considered is not part of the position it is taking.
    if (version.content.alternative.has_value() && !version.content.alternative->empty())
        sections.push_back({"alternative", &*version.content.alternative, true});
    if (version.content.tension.has_value() && !version.content.tension->empty())
        sections.push_back({"tension", &*version.content.tension, true});
    if (!version.reason.empty()) sections.push_back({"reason", &version.reason, false});

    if (!sections.empty()) {
        if (ImGui::BeginTabBar("frame_sections")) {
            for (const Section& section : sections) {
                if (ImGui::BeginTabItem(section.name)) {
                    if (section.dim) ImGui::PushStyleColor(ImGuiCol_Text, kGray);
                    ImGui::TextWrapped("%s", section.text->c_str());
                    if (section.dim) ImGui::PopStyleColor();
                    ImGui::EndTabItem();
                }
            }
        }
        ImGui::EndTabBar();
    }
    renderChips(version, m, onChip);
}

// The banner: exactly one state, or nothing. It reports what is owed; the acts
// themselves live in `renderActions` below, which is always on screen.
void renderBanner(const FormulationView& view) {
    if (view.banner == FrameBanner::None) return;

    // The paused case is the only one where the user has an act to perform, so it is
    // the only one that gets a colour of its own. Everything else is informational,
    // and colouring it the same way would make every round look like it needs an
    // answer.
    const bool actionable = view.banner == FrameBanner::AwaitingResponse;
    ImGui::PushStyleColor(ImGuiCol_Text, actionable ? kAccent : kGray);
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
}

// The three acts, ALWAYS on screen.
//
// They used to be drawn only while the run was paused, on the argument that a
// control offered when nothing is waiting invites the confusion `approve_frame`
// exists to remove. That argument is right about the *pressing* and wrong about the
// *showing*: with the row hidden, a user who was paused saw nothing at all and had
// no way to tell "this pane has no actions" from "this pane's actions are
// elsewhere". Drawn disabled with the reason underneath, the same row says what the
// surface can do and why it cannot do it right now.
//
// The three are not variants of one act and are not interchangeable:
//   * Approve consents to the reading on screen. Live only while one is waiting.
//   * Auto-approve consents to readings that do not exist yet. Live whenever the
//     runtime has said what its current value is.
//   * The correction is neither: it is not consent, and it can be entered at any
//     time.
void renderActions(const FormulationView& view, FramePaneState& state, bool canAct,
                   const FrameApprover& approve, const FrameAutoApprover& setAutoApprove) {
    const bool approveLive = canAct && view.canApprove;
    const bool autoLive = canAct && view.autoApproveKnown;

    ImGui::BeginDisabled(!approveLive);
    if (ImGui::Button("Approve") && approve) approve(view.reviewVersionId);
    ImGui::EndDisabled();
    // AllowWhenDisabled so the disabled button still explains itself on hover. The
    // tooltip names the version, so what is being consented to is never in doubt.
    if (ImGui::IsItemHovered(ImGuiHoveredFlags_AllowWhenDisabled)) {
        if (view.canApprove) {
            ImGui::SetTooltip(
                "Approve the reading under review (%s) and let the run continue.\n"
                "This is the only action that releases the pause. A prompt does not.",
                view.reviewVersionId.c_str());
        } else {
            ImGui::SetTooltip(
                "Nothing is waiting for approval.\n"
                "Approve is live only while a reading is on the table awaiting your response.");
        }
    }

    // The session toggle. The box shows the RUNTIME's value, not the last click:
    // an optimistic tick has to be retracted when the command is refused, and a
    // refused toggle would otherwise leave the box showing a setting that is not
    // on. The cost is that the box ticks a round trip after the click, not on it.
    bool autoApprove = view.autoApproveFrame;
    ImGui::SameLine();
    ImGui::BeginDisabled(!autoLive);
    if (ImGui::Checkbox("Auto-approve", &autoApprove)) {
        if (setAutoApprove) setAutoApprove(autoApprove);
    }
    ImGui::EndDisabled();
    if (ImGui::IsItemHovered(ImGuiHoveredFlags_AllowWhenDisabled)) {
        ImGui::SetTooltip(
            "Approve every reading automatically, as the run that published it settles.\n"
            "Session-scoped and off by default.\n"
            "Turning it on approves a reading that is waiting right now: it is the same\n"
            "approval, not a preview of one.");
    }

    // The correction act, on the SAME row as the two other acts. It is not a
    // third consent (an objection is the opposite of one) and it is not a second
    // input box: pressing it turns the ONE prompt box below into the correction
    // input, so there is never a second place to type, and a half-typed prompt is
    // never consumed as an objection. The label is short, which is why it can
    // share the row the old objection submit button could not.
    ImGui::SameLine();
    ImGui::BeginDisabled(!canAct || state.correctionMode);
    if (ImGui::Button("Correction")) enterCorrectionMode(state);
    ImGui::EndDisabled();
    if (ImGui::IsItemHovered(ImGuiHoveredFlags_AllowWhenDisabled)) {
        ImGui::SetTooltip(
            "Turn the prompt box below into a correction of this reading.\n"
            "Submitting it sends `frame_correct`; it does not approve the Frame.");
    }

    // Why something above is greyed out. Three different reasons and only one of
    // them is the user's to fix, so they get three different sentences rather than
    // one "unavailable". The most fundamental wins.
    const char* reason = nullptr;
    if (!canAct) {
        reason = kNoRuntimeReason;
    } else if (!view.autoApproveKnown) {
        reason = "auto-approve: not reported by the runtime";
    } else if (!view.canApprove) {
        reason = "Approve: nothing is waiting for approval";
    }
    if (reason != nullptr) {
        ImGui::PushStyleColor(ImGuiCol_Text, kGray);
        ImGui::TextWrapped("%s", reason);
        ImGui::PopStyleColor();
    }
}

// The Frame's body: everything below the banner. Scrolled by the caller, so a long
// reading does not push the acts out of reach.
void renderFrameBody(const FormulationView& view, const NativeGuiModel& m,
                     FramePaneState& state, const FrameChipHandler& onChip) {
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

} // namespace

void renderFramePane(bool& open, FramePaneState& state, const FormulationView& view,
                     const NativeGuiModel& m, bool canSend, bool canAct,
                     bool historyNavigationEnabled, PromptSender send, FrameApprover approve,
                     FrameCorrector correct, FrameAutoApprover setAutoApprove,
                     FrameChipHandler onChip) {
    if (!open) return;

    // Close on Escape BEFORE rendering the input widget. The focused
    // InputTextMultiline would otherwise see the Escape and run its
    // is_cancel/revert_edit path (EscapeClearsAll is not set), which reverts
    // promptText to the pre-edit snapshot (TextToRevertTo) and discards the
    // user's un-submitted typing. Handling Escape here keeps the caller-owned
    // promptText intact so re-opening (':') restores the draft.
    if (ImGui::IsKeyPressed(ImGuiKey_Escape, false)) {
        if (state.correctionMode) {
            // Esc in correction mode cancels the MODE, not the pane: it restores
            // the normal prompt draft the user had before pressing Correction and
            // leaves the pane open, so entering correction never costs the user
            // their un-submitted prompt.
            cancelCorrectionMode(state);
        } else {
            open = false;
            return;
        }
    }

    // Growable prompt text. Enter inserts a newline (no EnterReturnsTrue);
    // submission is via Cmd/Ctrl+Enter (macOS Cmd, elsewhere Ctrl) so a
    // multiline prompt is preserved end to end and serializePromptCommand
    // keeps the newline inside the JSON message on the way to the runtime client.
    std::string& promptBuf = state.promptText;
    auto& io = ImGui::GetIO();

    // Fixed geometry: centered in the app, undecorated (no title bar), and not
    // user-resizable/movable. It is bigger than the v1 palette was (1/2 x 1/2)
    // because it now carries the reading as well as the reply, and a Frame read
    // through a 1/2-height keyhole is not a reading.
    const ImVec2 d = io.DisplaySize;
    const ImVec2 winSize(d.x * 0.72f, d.y * 0.82f);
    const ImVec2 winPos((d.x - winSize.x) * 0.5f, (d.y - winSize.y) * 0.5f);
    ImGui::SetNextWindowSize(winSize, ImGuiCond_Always);
    ImGui::SetNextWindowPos(winPos, ImGuiCond_Always);
    bool close = false;
    const ImGuiWindowFlags flags = ImGuiWindowFlags_NoTitleBar | ImGuiWindowFlags_NoResize |
                                   ImGuiWindowFlags_NoMove | ImGuiWindowFlags_NoCollapse;
    state.workDir = m.session();
    if (ImGui::Begin("Frame", &close, flags)) {
        // Focus is requested just before the prompt box below rather than here:
        // the window's first focusable item is now the Approve button, and
        // appearing on ':' should still land the caret in the prompt.
        const bool focusInput = ImGui::IsWindowAppearing();

        // --- the reading -----------------------------------------------------
        // The banner and the acts stay pinned, and only the body below them
        // scrolls: Approve must not be scrollable out of reach on a long Frame.
        if (!view.hasTask) {
            ImGui::TextDisabled("no task: there is no Frame to show");
        } else {
            renderBanner(view);
        }
        // The acts are drawn whether or not a task is open: the session toggle does
        // not need one, and the row's absence was itself the bug this fixes.
        renderActions(view, state, canAct, approve, setAutoApprove);
        if (view.hasTask) {
            ImGui::Separator();
            // A share of what is LEFT, not a share of the window. The banner, the
            // acts and the reason line above are pinned and their height depends on
            // how the text wraps, which depends on the width; taking the body's
            // height from the window instead let the pinned part grow until the
            // whole pane overflowed and the acts scrolled off the top of the one
            // window that is supposed to be showing them.
            ImGui::BeginChild("frame_body",
                              ImVec2(0, std::max(48.0f, ImGui::GetContentRegionAvail().y * 0.40f)),
                              true);
            renderFrameBody(view, m, state, onChip);
            ImGui::EndChild();
        }

        ImGui::Separator();

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
        // History is a prompt affordance. In correction mode it would replace the
        // correction text with an earlier prompt, so it is disabled there.
        if (historyNavigationEnabled && !state.correctionMode && !io.KeyCtrl && !io.KeySuper &&
            !io.KeyAlt && !io.KeyShift) {
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

        // Focus on appearing, and again when Correction is pressed: the button is
        // above this widget, and the flag is consumed here at the widget.
        if (focusInput || state.requestPromptFocus) {
            ImGui::SetKeyboardFocusHere();
            state.requestPromptFocus = false;
        }
        // The mode has to be visible before the user types, not only in the submit
        // button: the box is the same widget, so its meaning has to be stated.
        if (state.correctionMode) {
            ImGui::PushStyleColor(ImGuiCol_Text, kAccent);
            ImGui::TextUnformatted("correction: what the reading gets wrong (Esc cancels)");
            ImGui::PopStyleColor();
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
        // Clamp so the input can't consume the panel; the reading above and the
        // in-message area below keep their share.
        const float maxInputH = winSize.y * 0.32f;
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
        // Cmd/Ctrl+Enter is the one chord in both modes; what it submits depends on
        // the mode. A correction goes to the existing `frame_correct` callback and
        // does NOT release the pause, exactly like the button that used to be here.
        bool submit = (io.KeySuper || io.KeyCtrl) && ImGui::IsKeyPressed(ImGuiKey_Enter, false);
        if (state.correctionMode) {
            ImGui::BeginDisabled(!canAct || promptBuf.empty());
            if (ImGui::Button("Submit correction")) submit = true;
            ImGui::EndDisabled();
        } else {
            // The visible button, so the rule is readable rather than only
            // discoverable: §7.2 requires the submit control to say that sending is
            // NOT approving the Frame. The label is the whole reason this button
            // exists next to a working keyboard chord.
            ImGui::BeginDisabled(!canSend || promptBuf.empty());
            if (ImGui::Button("Send (does not approve the Frame)")) submit = true;
            ImGui::EndDisabled();
        }
        if (submit) {
            std::string text = promptBuf;
            if (state.correctionMode) {
                // Submit, then exit the mode and stay open: the answer streams into
                // this same pane, so closing it would hide the reply the correction
                // is waiting for.
                if (canAct && correct && !text.empty()) {
                    correct(text);
                    leaveCorrectionModeAfterSubmit(state);
                }
            } else {
                promptBuf.clear();
                state.promptHistoryIndex = -1;
                state.promptHistoryDraft.clear();
                if (historyNavigationEnabled && canSend && send && !text.empty()) {
                    state.promptHistory.push_back(text);
                    send(text);  // reverse path: user prompt -> runtime client
                }
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

} // namespace pie::gui
