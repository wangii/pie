// TracePane: the dispatch trace panel (docs/milestones.md §7.3).
//
// The renderer only. Which role ran, on what model, and what that model's
// provenance is come from TraceModel; this file decides colour and layout and
// nothing else.
//
// Two rules from §7.3 and §10 are encoded here rather than left to the caller:
//
//   * A COLUMN WITH NO SOURCE RENDERS THE EM-DASH. Never a blank, and never a
//     carried-over value: "no session_status" must not display as a mismatch, and
//     it must not display as the propose model either.
//   * `model≠role` IS THE BADGE'S NAME. Not `degraded`: `roleModelFor` returns the
//     fallback model directly once a role is downgraded, so a true degradation is
//     not observable from this side of the RPC. The badge says exactly what was
//     seen — the model that ran differs from the model the role resolves to — and
//     the tooltip says what it does NOT mean.

#pragma once

#include <string>

#include "Model.h"

namespace pie::gui {

struct TracePaneState {
    // The second tab: every domain event, plus the ReplayIssue table. §7.3 calls
    // it optional; §5.3 is why it is here anyway — the issue count in the status
    // bar needs somewhere the details can actually be read.
    bool showEvents = false;
    // The row whose detail list is expanded, or -1. Only one at a time: the pane
    // is a fixed-width list, and two expansions push the rows apart.
    int expandedRow = -1;
    // While pinned, new rows scroll into view. Scrolling up unpins, the same rule
    // the Frame pane's reply area uses.
    bool followTail = true;
    size_t lastRowCount = 0;
    // Transient feedback for the copy button ("copied"), cleared on the next row.
    double copiedAt = -1.0;
};

// Render into the CURRENT ImGui child (the shell owns the panel rectangle, §7.4).
void renderDispatchTrace(const pie::gui::NativeGuiModel& m, TracePaneState& state);

} // namespace pie::gui
