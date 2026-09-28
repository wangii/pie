// TraceModel: the dispatch trace pane's rows (docs/milestones.md §7.3).
//
// The pane answers one question — *which role ran, on what model, for how long,
// and what did it produce?* — and §3.6 is why it cannot answer it the way the
// question suggests: `session_status` carries no thinking level, no timing and no
// degraded flag, and `getRoleStatus()` returns undefined until the belief set is
// usable, so early in a session the telemetry is simply absent. Therefore every
// column below names its own source, and a column whose source is missing
// renders the em-dash. **A missing value is never presented as a fact about the
// runtime** — that is the risk §10 names, and the reason `model≠role` is not
// called `degraded`.
//
// WHAT ONE ROW IS. A row is one STAGE WINDOW: opened by the event that moved the
// cursor in (`CursorChanged`, or `EpisodeClosed`, which the fold applies as
// `closed`) and closed by the next one. The role comes from the stage, the
// detail column from the domain events that arrived inside the window, and the
// model columns from the assistant turn that ran inside it. A window that
// contains more than one turn is reported as one row with `turnCount > 1` and
// every turn listed in `turns` — a second model call inside one stage is a fact
// the row must not average away, and it is why the count is on the row rather
// than in a tooltip.
//
// WHERE THE ROWS COME FROM. `NativeGuiModel::trace()` — an observation log, not a
// replay. `message_start`, `message_end` and `session_status` carry no eventId and
// appear in no snapshot, so this whole model is empty after a bootstrap that could
// not read anything but events, and the pane says so instead of rendering blank
// columns.

#pragma once

#include <cstdint>
#include <string>
#include <vector>

#include "Model.h"

namespace pie::gui {

// TS: LoopState["role"] as the trace names it, plus `Routing`: the stage the
// controller opens a task with (`beginDomainTask` emits `CursorChanged(routing)`)
// and inside which the FIRST propose turn runs. §7.3's mapping does not list
// `routing`; dropping it would delete the turn that decided the route, so it is
// kept as its own row, and its role-model column is the em-dash because
// `session_status` has no routing slot.
enum class DispatchRole { Routing, Propose, Execution, Distill, FinalReport, Unknown };
const char* dispatchRoleName(DispatchRole role);
// The role a stage belongs to. `closed` maps to FinalReport — which §7.3 notes
// conflates "the final report ran" with "the episode closed", and the row renders
// as `finalReport (closed)` rather than pretending the two are the same.
DispatchRole dispatchRoleForStage(EpisodeStage stage);

// One assistant turn observed inside a stage window.
struct TraceTurn {
    std::string model;          // the model that ACTUALLY ran (message.model.id)
    std::string provider;
    std::string thinkingLevel;  // "" when the turn did not report one
    std::string startedAt;
    std::string endedAt;
    int64_t durationMs = -1;    // -1 when either end is unreadable
    std::string stopReason;
    std::string errorMessage;
    TurnUsage usage;
    bool ended = false;         // false: no message_end was seen for this turn
};

struct TraceRow {
    DispatchRole role = DispatchRole::Unknown;
    EpisodeStage stage = EpisodeStage::Unknown;
    TaskId taskId;
    EpisodeId episodeId;
    // The episode's body kind is `fast-path`: the round had no Plan. Reported
    // beside the role because a fast-path round is a different shape of work, and
    // §7.3 asks for the marker on the `closed` row in particular.
    bool fastPath = false;

    // The turns that ran in this window, oldest first. Never empty for a window
    // that saw a message; empty for a stage that dispatched no model at all
    // (which is itself worth rendering).
    std::vector<TraceTurn> turns;
    // The columns below summarise `turns.front()`; `turnCount` is what says a
    // summary is a summary.
    size_t turnCount = 0;

    // --- model columns ------------------------------------------------
    std::string dispatchedModel;   // message.model.id — stated, not derived
    std::string dispatchedProvider;
    std::string roleModel;         // session_status.roleStatus.<slot>.model
    // DERIVED, and named for exactly what it says. `roleModelFor` returns the
    // fallback model directly once a role is degraded, so a true downgrade is
    // unobservable from here; calling this `degraded` would be the GUI claiming
    // an authority it does not have (§7.3, §11).
    bool modelDiffersFromRole = false;
    // False when either side is unknown: "different" is not a claim two missing
    // values can support.
    bool modelComparisonKnown = false;

    std::string thinkingLevel;
    bool thinkingFromTurn = false;   // false: the session-level level from get_state
    float cacheHitRate = -1.0f;
    bool cacheFromTurnUsage = false; // false: session_status telemetry

    int64_t durationMs = -1;         // first turn's start -> last turn's end
    std::string status;              // stopReason, or the error, or ""

    // The domain events observed inside the window, in arrival order, rendered
    // one line each. `detail` is the first — the event that opened the stage's
    // work — and the rest are what the row expands to.
    std::string detail;
    std::vector<std::string> details;
};

// One domain event, for the Events tab (§7.3's optional second tab, which §5.3
// requires anyway: the ReplayIssue count in the status bar needs a place where
// the details can be read).
struct TraceEventRow {
    std::string type;
    std::string text;
    std::string at;
    TaskId taskId;
    EpisodeId episodeId;
};

struct TraceModel {
    std::vector<TraceRow> rows;
    // Every domain event observed, in arrival order.
    std::vector<TraceEventRow> events;
    // The fold's ReplayIssues, unpacked for the table.
    std::vector<ReplayIssue> issues;
    // Whether ANY telemetry arrived (`message_start`/`message_end`/
    // `session_status`). False in a demo run and in a bootstrap that only ever
    // read events: the pane says "no telemetry" rather than drawing a row of
    // em-dashes as if it had measured something (§10).
    bool hasTelemetry = false;
};

TraceModel buildDispatchTrace(const NativeGuiModel& model);

// Rendering helpers, headless so the em-dash rules are testable.
//
// A duration as "4.2s" / "812ms", or the em-dash when the two timestamps could
// not be read. Never "0s": a turn whose timestamps are missing did not take no
// time.
std::string formatTraceDuration(int64_t durationMs);
// "62%" for a rate, or the em-dash when it is negative.
std::string formatTraceCache(float hitRate, bool fromTurnUsage);

// Display cells of a UTF-8 string: a codepoint in the wide (CJK) ranges counts as
// two. The row line's columns are fixed-width text in a monospaced font, so the
// padding has to be measured the way the font draws it — otherwise a model id or
// an error message in Chinese shifts every column after it.
int traceDisplayWidth(const std::string& text);
// Pad to `width` cells, or truncate to it. Truncation lands on a codepoint
// boundary, so a cut is never mid-glyph; an over-long cell is silently cut rather
// than marked, because the full value is one click away in the row's expansion.
std::string traceCell(const std::string& text, int width);

} // namespace pie::gui
