#include "TracePane.h"

#include <imgui.h>

#include <cstdio>

#include "Theme.h"
#include "TraceModel.h"

namespace pie::gui {

namespace {

// The columns of the row line, in order. Fixed widths in DISPLAY CELLS: the UI
// font is Sarasa Term, which is monospaced for ASCII, so padding with spaces
// lines the columns up. `traceCell` counts a wide (CJK) glyph as two cells, so a
// model id or an error message that is not ASCII does not shift the row.
//
// The widths are sized for a panel docked BESIDE the canvas — a third of the
// window, not the whole of it. The detail column is last and is the one that
// clips; clicking the row expands every detail at full width, which is why
// clipping it costs a glance rather than any information.
constexpr int kRoleWidth = 13;      // "finalReport"
constexpr int kFlagWidth = 9;       // "closed fp"
constexpr int kModelWidth = 20;
constexpr int kThinkingWidth = 5;
constexpr int kCacheWidth = 7;
constexpr int kDurationWidth = 7;
constexpr int kStatusWidth = 7;

using pie::gui::traceCell;

// The role column, and the stage marker beside it. §7.3 asks for
// `finalReport (closed)` because the stage conflates "the final report ran" with
// "the round closed"; the marker is its own column so the role column stays wide
// enough for the longest role name rather than being sized for the longest
// SUFFIX, and the fast-path marker — which comes from the episode's body kind —
// joins it.
std::string roleCell(const TraceRow& row) { return dispatchRoleName(row.role); }

std::string flagCell(const TraceRow& row) {
    std::string text;
    if (row.stage == EpisodeStage::Closed) text = "closed";
    if (row.fastPath) text += text.empty() ? "fp" : " fp";
    return text;
}

// A row's own model, coloured when it is not the role's: amber for the derived
// badge, plain otherwise. The colour is decoration; the badge is the label.
ImVec4 modelColor(const TraceRow& row) {
    if (row.modelDiffersFromRole) return kAmber;
    return ImGui::GetStyleColorVec4(ImGuiCol_Text);
}

void columnHeader() {
    ImGui::PushStyleColor(ImGuiCol_Text, kGray);
    ImGui::TextUnformatted((traceCell("role", kRoleWidth) + traceCell("stage", kFlagWidth) +
                            traceCell("model", kModelWidth) + traceCell("thk", kThinkingWidth) +
                            traceCell("cache", kCacheWidth) + traceCell("time", kDurationWidth) +
                            traceCell("status", kStatusWidth) + "detail")
                               .c_str());
    ImGui::PopStyleColor();
}

void renderDispatchRows(const TraceModel& trace, TracePaneState& state) {
    columnHeader();
    ImGui::Separator();

    for (size_t i = 0; i < trace.rows.size(); ++i) {
        const TraceRow& row = trace.rows[i];
        ImGui::PushID(static_cast<int>(i));

        // The whole line is the click target: §7.3 expands a row's detail, and a
        // row is a line of text rather than a set of widgets.
        const bool expanded = state.expandedRow == static_cast<int>(i);
        const std::string line =
            traceCell(roleCell(row), kRoleWidth) + traceCell(flagCell(row), kFlagWidth) +
            traceCell(row.dispatchedModel, kModelWidth) +
            traceCell(row.thinkingLevel, kThinkingWidth) +
            traceCell(formatTraceCache(row.cacheHitRate, row.cacheFromTurnUsage), kCacheWidth) +
            traceCell(formatTraceDuration(row.durationMs), kDurationWidth) +
            traceCell(row.status, kStatusWidth) + row.detail;

        ImGui::PushStyleColor(ImGuiCol_Text, modelColor(row));
        // Selectable so the row highlights and takes the click; a full-width hit
        // box is what makes "click the row" true rather than "click the text".
        if (ImGui::Selectable(line.c_str(), expanded, ImGuiSelectableFlags_SpanAllColumns)) {
            state.expandedRow = expanded ? -1 : static_cast<int>(i);
        }
        ImGui::PopStyleColor();
        // The columns clip in a narrow panel, so the whole row is available on
        // hover as well as in the expansion.
        if (ImGui::IsItemHovered()) {
            ImGui::SetTooltip("%s%s%s%s%s%s%s", roleCell(row).c_str(),
                              row.detail.empty() ? "" : "  |  ", row.detail.c_str(),
                              row.roleModel.empty() ? "" : "\nrole model: ",
                              row.roleModel.c_str(),
                              row.turnCount > 1 ? "\n(several turns: click to expand)" : "",
                              row.modelDiffersFromRole ? "\nmodel\xe2\x89\xa0role" : "");
        }

        // The badge, named for what it says and nothing more. §7.3 forbids calling
        // it `degraded`: roleModelFor returns the fallback model directly, so the
        // GUI cannot observe a downgrade, and claiming one would be exactly the
        // overreach §11 rules out.
        if (row.modelDiffersFromRole) {
            ImGui::SameLine();
            ImGui::PushStyleColor(ImGuiCol_Text, kAmber);
            ImGui::TextUnformatted("model\xe2\x89\xa0role");
            ImGui::PopStyleColor();
            if (ImGui::IsItemHovered()) {
                ImGui::SetTooltip(
                    "the model that ran (%s) differs from the model this role resolves to (%s).\n"
                    "This is NOT a degraded flag: a role that falls back to the session model is\n"
                    "resolved before it is reported, so a real downgrade is not observable here.",
                    row.dispatchedModel.c_str(), row.roleModel.c_str());
            }
        }
        if (row.turnCount > 1) {
            // A second model call inside one stage must not be averaged into the
            // columns, so the count is on the row and the expansion lists them.
            ImGui::SameLine();
            ImGui::TextDisabled("(%zu turns)", row.turnCount);
        }

        if (expanded) {
            ImGui::Indent();
            for (const TraceTurn& turn : row.turns) {
                ImGui::TextDisabled("turn %s  %s  %s  %s", turn.model.empty() ? "\xe2\x80\x94" : turn.model.c_str(),
                                    formatTraceDuration(turn.durationMs).c_str(),
                                    turn.ended ? "ended" : "unterminated",
                                    turn.stopReason.empty() ? "\xe2\x80\x94" : turn.stopReason.c_str());
            }
            for (const std::string& detail : row.details) {
                ImGui::TextWrapped("%s", detail.c_str());
            }
            if (ImGui::SmallButton("copy row")) {
                // The raw text, one field per line, so a pasted row stays readable
                // in an issue report.
                std::string text = line + "\n";
                for (const std::string& detail : row.details) text += "  " + detail + "\n";
                ImGui::SetClipboardText(text.c_str());
                state.copiedAt = ImGui::GetTime();
            }
            ImGui::Unindent();
        }
        ImGui::PopID();
    }

    // Follow the tail: new rows scroll into view while pinned, and scrolling up
    // unpins so a running session cannot yank the view away from what is being
    // read.
    if (state.followTail && trace.rows.size() != state.lastRowCount) {
        ImGui::SetScrollHereY(1.0f);
    }
    state.lastRowCount = trace.rows.size();
    if (ImGui::GetScrollY() < ImGui::GetScrollMaxY() - 1.0f) state.followTail = false;
}

void renderEventsTab(const TraceModel& trace) {
    ImGui::TextDisabled("%zu domain events, %zu replay issues", trace.events.size(), trace.issues.size());
    ImGui::Separator();

    if (!trace.issues.empty()) {
        // The issues come first: they are the reason the tab exists (§5.3), and a
        // reader who has to scroll to find them will not.
        ImGui::PushStyleColor(ImGuiCol_Text, kRed);
        ImGui::TextUnformatted("replay issues");
        ImGui::PopStyleColor();
        if (ImGui::BeginTable("trace_issues", 3,
                              ImGuiTableFlags_RowBg | ImGuiTableFlags_SizingFixedFit | ImGuiTableFlags_Borders)) {
            ImGui::TableSetupColumn("event");
            ImGui::TableSetupColumn("eventId");
            ImGui::TableSetupColumn("what the fold refused");
            ImGui::TableHeadersRow();
            for (const ReplayIssue& issue : trace.issues) {
                ImGui::TableNextRow();
                ImGui::TableNextColumn();
                ImGui::TextUnformatted(issue.eventType.c_str());
                ImGui::TableNextColumn();
                ImGui::TextUnformatted(issue.eventId.empty() ? "\xe2\x80\x94" : issue.eventId.c_str());
                ImGui::TableNextColumn();
                ImGui::TextWrapped("%s", issue.message.c_str());
            }
            ImGui::EndTable();
        }
        ImGui::Separator();
    }

    for (const TraceEventRow& event : trace.events) {
        ImGui::TextDisabled("%s", event.type.c_str());
        ImGui::SameLine();
        ImGui::TextWrapped("%s", event.text.c_str());
    }
}

} // namespace

void renderDispatchTrace(const pie::gui::NativeGuiModel& m, TracePaneState& state) {
    const TraceModel trace = buildDispatchTrace(m);

    if (ImGui::SmallButton("dispatch")) state.showEvents = false;
    ImGui::SameLine();
    if (ImGui::SmallButton("events")) state.showEvents = true;
    ImGui::SameLine();
    ImGui::Checkbox("follow", &state.followTail);
    ImGui::SameLine();
    if (state.copiedAt >= 0.0 && ImGui::GetTime() - state.copiedAt < 2.0) {
        ImGui::TextDisabled("copied");
    } else {
        ImGui::TextDisabled("%zu rows", trace.rows.size());
    }
    ImGui::Separator();

    // The one thing the pane must never do is let "no telemetry" read as "no
    // problem": a demo run and a bootstrap that could not read a snapshot both
    // land here, and the row of em-dashes below is the honest rendering of it.
    if (!trace.hasTelemetry) {
        ImGui::PushStyleColor(ImGuiCol_Text, kAmber);
        ImGui::TextWrapped(
            "no telemetry: this session sent no message_start or session_status, so the model, "
            "thinking, cache and timing columns have no source.");
        ImGui::PopStyleColor();
        ImGui::Separator();
    }

    if (ImGui::BeginChild("trace_body", ImVec2(0, 0), false)) {
        if (state.showEvents) {
            renderEventsTab(trace);
        } else {
            renderDispatchRows(trace, state);
        }
    }
    ImGui::EndChild();
}

} // namespace pie::gui
