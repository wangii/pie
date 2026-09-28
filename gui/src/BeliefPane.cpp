#include "BeliefPane.h"

#include <imgui.h>

#include <string>

#include "Theme.h"

namespace pie::gui {

namespace {

const char* domainName(BeliefDomain domain) {
    switch (domain) {
        case BeliefDomain::Product: return "product";
        case BeliefDomain::Code: return "code";
        case BeliefDomain::Unknown: return "?";
    }
    return "?";
}

// The evidence column: S/R/I counts. A zero is not shown: "no refutations" is the
// normal state of a live belief, and three zeros per row is noise that hides the
// one count that is not zero.
std::string evidenceCell(const BeliefRow& row) {
    std::string out;
    if (row.supportCount != 0) out += "S" + std::to_string(row.supportCount);
    if (row.refuteCount != 0) {
        if (!out.empty()) out += " ";
        out += "R" + std::to_string(row.refuteCount);
    }
    if (row.inconclusiveCount != 0) {
        if (!out.empty()) out += " ";
        out += "I" + std::to_string(row.inconclusiveCount);
    }
    return out.empty() ? "\xe2\x80\x94" : out;
}

void renderTooltip(const BeliefRow& row, const NativeGuiModel& m) {
    const Belief& belief = *row.record;
    if (!belief.expectation.empty()) {
        ImGui::TextDisabled("expectation");
        ImGui::TextWrapped("%s", belief.expectation.c_str());
    }
    // The raw evidence strings, which the columns summarise only as counts: the
    // count says how much, the strings say what.
    for (const std::string& evidence : belief.supportedBy) {
        ImGui::PushStyleColor(ImGuiCol_Text, kGreen);
        ImGui::TextWrapped("+ %s", evidence.c_str());
        ImGui::PopStyleColor();
    }
    for (const std::string& evidence : belief.refutedBy) {
        ImGui::PushStyleColor(ImGuiCol_Text, kRed);
        ImGui::TextWrapped("- %s", evidence.c_str());
        ImGui::PopStyleColor();
    }
    for (const std::string& evidence : belief.inconclusiveBy) {
        ImGui::PushStyleColor(ImGuiCol_Text, kGray);
        ImGui::TextWrapped("~ %s", evidence.c_str());
        ImGui::PopStyleColor();
    }
    if (row.introducedByThisTask) {
        ImGui::TextDisabled("introduced by this task (%zu task(s) carry it)", row.taskCount);
    } else {
        ImGui::TextDisabled("inherited (%zu task(s) carry it)", row.taskCount);
    }
    if (row.applicability.has_value()) {
        ImGui::TextDisabled("review: %s%s", toString(*row.applicability),
                            row.applicabilityStale ? " (stale: the scope moved on)" : "");
    }
    // The record's own id beside the derived label, so "B4" on the row and
    // `belief-4` in the log are visibly the same belief — which is what makes a
    // citation in the Frame pane traceable back to the runtime's own ids.
    ImGui::TextDisabled("id: %s  (shown as %s)", belief.id.c_str(), m.beliefLabel(belief.id).c_str());
}

void renderToolbar(BeliefSort& sort, BeliefFilter& filter, const BeliefListModel& list) {
    ImGui::SetNextItemWidth(140.0f);
    int current = static_cast<int>(sort);
    const char* sorts[] = {"record order", "status", "domain", "evidence rounds"};
    if (ImGui::Combo("sort", &current, sorts, IM_ARRAYSIZE(sorts))) {
        sort = static_cast<BeliefSort>(current);
    }

    ImGui::Checkbox("in focus", &filter.focusOnly);
    ImGui::SameLine();
    ImGui::Checkbox("hide superseded", &filter.hideSuperseded);
    ImGui::SameLine();
    ImGui::SetNextItemWidth(160.0f);
    // The filter needs a resizable buffer; a fixed one would cap the query, which
    // is a search box whose limit nobody can see.
    static char query[128] = "";
    if (ImGui::InputTextWithHint("##query", "filter text", query, sizeof(query))) {
        filter.query = query;
    }

    // What the list is showing. "declared and empty" and "never declared" filter
    // to the same rows and are different facts, so the panel says which it is.
    ImGui::SameLine();
    if (filter.focusOnly && !list.focusDeclared) {
        ImGui::PushStyleColor(ImGuiCol_Text, kAmber);
        ImGui::TextUnformatted("no focus declared: nothing is in scope");
        ImGui::PopStyleColor();
    } else {
        ImGui::TextDisabled("%zu of %zu%s", list.rows.size(), list.totalCount,
                            list.hiddenSupersededCount != 0 ? " (superseded hidden)" : "");
    }
}

} // namespace

void renderBeliefList(const BeliefListModel& list, const pie::gui::NativeGuiModel& m,
                      BeliefSort& sort, BeliefFilter& filter) {
    renderToolbar(sort, filter, list);
    ImGui::Separator();

    if (list.rows.empty()) {
        // A filter that hides everything is not an empty session, so the two get
        // different sentences rather than one "no beliefs".
        if (list.filterActive) {
            ImGui::TextDisabled("no belief matches the filter");
        } else {
            ImGui::TextDisabled("no beliefs yet");
        }
        return;
    }

    for (const BeliefRow& row : list.rows) {
        ImGui::PushID(row.id.c_str());

        // Two lines per row, not one. A docked panel is often 300px wide, and the
        // columns plus a long statement on ONE line leaves the statement two
        // characters of width — which wraps it one glyph per line, the exact
        // failure this layout exists to avoid. The columns get the first line, the
        // statement the second, so the width the statement needs is the panel's
        // width rather than whatever the columns left over.
        const BeliefStatus shown =
            row.supersededChain.size() > 1 ? row.lineageStatus : row.status;
        ImGui::PushStyleColor(ImGuiCol_Text, beliefStatusColor(shown));
        ImGui::Text("%-4s %-10s %-8s", row.label.c_str(), toString(row.status),
                    domainName(row.record->domain));
        ImGui::PopStyleColor();
        ImGui::SameLine();
        ImGui::TextDisabled("%s", evidenceCell(row).c_str());
        if (row.inFocus) {
            ImGui::SameLine();
            ImGui::PushStyleColor(ImGuiCol_Text, kFocusAccent);
            ImGui::TextUnformatted("*");
            ImGui::PopStyleColor();
        }
        // The two obligations that block a conclusion arrive as a badge on the
        // first line, where the status is, because they qualify it.
        if (row.owesDecision) {
            ImGui::SameLine();
            ImGui::PushStyleColor(ImGuiCol_Text, kAmber);
            ImGui::TextUnformatted("needs a decision");
            ImGui::PopStyleColor();
        } else if (row.awaitsRevalidation) {
            ImGui::SameLine();
            ImGui::PushStyleColor(ImGuiCol_Text, kGray);
            ImGui::TextUnformatted("needs revalidation");
            ImGui::PopStyleColor();
        }

        // The statement owns the rest of the row's width.
        ImGui::Indent();
        ImGui::TextWrapped("%s", row.record->statement.c_str());
        if (row.chainTruncated) {
            ImGui::PushStyleColor(ImGuiCol_Text, kRed);
            ImGui::TextWrapped("supersession chain truncated: the log contains a cycle");
            ImGui::PopStyleColor();
        }
        // The supersession chain, inline: "B7 → B12 → B19". Without it a superseded
        // row looks like a claim that simply stopped being true, rather than one
        // that was replaced by something the user can go and read.
        if (row.supersededChain.size() > 1) {
            std::string chain;
            for (size_t i = 0; i < row.supersededChain.size(); ++i) {
                if (i != 0) chain += " \xe2\x86\x92 ";
                chain += m.beliefLabel(row.supersededChain[i]);
            }
            ImGui::PushStyleColor(ImGuiCol_Text, kGray);
            ImGui::TextWrapped("%s  (head: %s)", chain.c_str(), toString(row.lineageStatus));
            ImGui::PopStyleColor();
        }
        ImGui::Unindent();

        // The tooltip hangs off the STATEMENT, which is the last item of the row,
        // so hovering the row's text is what reveals the evidence behind it.
        if (ImGui::IsItemHovered()) renderTooltip(row, m);
        ImGui::Separator();
        ImGui::PopID();
    }
}

} // namespace pie::gui
