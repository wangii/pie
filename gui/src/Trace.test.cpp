// M7: the dispatch trace (docs/milestones.md §7.3), replacing the v1-era idea of
// showing a raw JSONL dump.
//
// The pane's whole value is honesty about where a number came from, so the
// assertions here are about PROVENANCE rather than formatting: which column reads
// which source, what a missing source renders as, and that a derived badge is
// never promoted to a fact the GUI cannot observe.
//
// Fixture-driven, as §7.3 asks: every case below feeds WIRE LINES through
// `applyRpcLine`, so what is tested is the whole path — parse, record, fold —
// and not a fold fed by a hand-built struct. The one exception is the
// `model≠role` case, which states the telemetry outright because a real provider
// cannot be asked to switch models on cue.

#include <cstdio>
#include <string>
#include <vector>

#include "DomainEvents.h"
#include "Model.h"
#include "TraceModel.h"

using namespace pie::gui;

static int failures = 0;
static void check(bool cond, const char* what) {
    if (!cond) {
        std::fprintf(stderr, "FAIL: %s\n", what);
        ++failures;
    } else {
        std::printf("ok: %s\n", what);
    }
}

// The demo fixture's opening, in wire form: a task, one round, one plan. Enough
// to have a routing stage, a proposing stage and a closed round.
static const char* kTaskOpened =
    R"({"type":"TaskOpened","schemaVersion":7,"eventId":"e1","timestamp":"2026-01-01T00:00:00.000Z","taskId":"task-1","initialPrompt":{"id":"prompt-1","original":"Is pytest available?","effective":"Is pytest available?"},"inheritedBeliefs":[]})";
static const char* kEpisodeOpened =
    R"({"type":"EpisodeOpened","schemaVersion":7,"eventId":"e2","timestamp":"2026-01-01T00:00:01.000Z","taskId":"task-1","episodeId":"episode-1","ordinal":1})";
static const char* kCursorRouting =
    R"({"type":"CursorChanged","schemaVersion":7,"eventId":"e3","timestamp":"2026-01-01T00:00:01.100Z","taskId":"task-1","episodeId":"episode-1","stage":"routing"})";
static const char* kRoutingDecided =
    R"({"type":"RoutingDecided","schemaVersion":7,"eventId":"e4","timestamp":"2026-01-01T00:00:02.000Z","taskId":"task-1","episodeId":"episode-1","routing":{"id":"routing-1","statement":"probe it","decision":"belief-loop","suitabilityProbability":0.8,"successProbability":0.7,"estimatedSteps":2,"difficulty":"low","reason":"cheap"}})";
static const char* kBodySelected =
    R"({"type":"EpisodeBodySelected","schemaVersion":7,"eventId":"e5","timestamp":"2026-01-01T00:00:02.100Z","taskId":"task-1","episodeId":"episode-1","body":"belief-loop","openBeliefsAtStart":[]})";
static const char* kPlanProduced =
    R"({"type":"PlanProduced","schemaVersion":7,"eventId":"e6","timestamp":"2026-01-01T00:00:03.000Z","taskId":"task-1","episodeId":"episode-1","plan":{"id":"plan-1","selectedToExplore":[],"intent":"probe quietly","formulation":{"kind":"unformed"}}})";

// One assistant turn, from start to end, as the runtime emits it.
static std::vector<std::string> turn(const std::string& model, const std::string& provider,
                                     const std::string& thinking, long input, long cacheRead,
                                     long cacheWrite, const std::string& stopReason,
                                     const std::string& startAt, const std::string& endAt) {
    const std::string modelJson = "{\"id\":\"" + model + "\",\"provider\":\"" + provider + "\"}";
    const std::string usageJson = "{\"input\":" + std::to_string(input) + ",\"output\":10,\"cacheRead\":" +
                                  std::to_string(cacheRead) + ",\"cacheWrite\":" +
                                  std::to_string(cacheWrite) + "}";
    return {
        "{\"type\":\"message_start\",\"timestamp\":\"" + startAt +
            "\",\"message\":{\"role\":\"assistant\",\"model\":" + modelJson +
            ",\"providerThinkingLevel\":\"" + thinking + "\",\"usage\":" + usageJson +
            ",\"content\":[{\"type\":\"text\",\"text\":\"working\"}]}}",
        "{\"type\":\"message_end\",\"timestamp\":\"" + endAt +
            "\",\"message\":{\"role\":\"assistant\",\"model\":" + modelJson + ",\"usage\":" + usageJson +
            ",\"stopReason\":\"" + stopReason + "\"}}",
    };
}

static void apply(NativeGuiModel& model, const std::string& line) {
    const RpcApplyResult result = applyRpcLine(model, line);
    (void)result;
}

int main() {
    // ---------------------------------------------------------------------
    // No telemetry at all: the "—" case, which must never read as a mismatch
    // ---------------------------------------------------------------------
    {
        NativeGuiModel model;
        apply(model, kTaskOpened);
        apply(model, kEpisodeOpened);
        apply(model, kCursorRouting);
        apply(model, kRoutingDecided);
        apply(model, kBodySelected);
        apply(model, kPlanProduced);
        check(model.issues().empty(), "a domain-event-only stream folds without issues");

        const TraceModel trace = buildDispatchTrace(model);
        check(!trace.hasTelemetry, "a stream with no message_*/session_status reports no telemetry");
        check(trace.rows.size() == 1, "the one cursor move opened one row");
        if (!trace.rows.empty()) {
            const TraceRow& row = trace.rows.front();
            check(row.role == DispatchRole::Routing, "the routing stage is its own role");
            check(row.turnCount == 0, "the routing row observed no turn");
            check(row.dispatchedModel.empty(), "no turn means no dispatched model");
            // The three "—" cases, asserted as the em-dash rather than as an
            // empty string: the pane renders these, and an empty column would
            // read as a value that happens to be blank.
            check(formatTraceDuration(row.durationMs) == "\xe2\x80\x94", "a duration with no timestamps is em-dash");
            check(formatTraceCache(row.cacheHitRate, false) == "\xe2\x80\x94", "a rate with no source is em-dash");
            check(row.roleModel.empty(), "the routing stage has no role-model slot");
            check(!row.modelComparisonKnown,
                  "model≠role is not claimed when neither side is known");
            check(!row.modelDiffersFromRole, "an unknown comparison is not a mismatch");
            // The detail column is the domain event the stage opened with.
            check(row.detail.find("routing: belief-loop") != std::string::npos,
                  "the row's detail is the routing decision, rendered from the event's own fields");
            check(row.details.size() == 4, "every event of the window is kept for the expansion");
            check(row.details[2].find("body: belief-loop") != std::string::npos,
                  "the body selection is one of the window's details");
            check(row.details[3].find("Plan plan-1 selects nothing") != std::string::npos,
                  "the plan detail names the plan and what it selected");
            check(row.details[0].find("cursor") != std::string::npos,
                  "the cursor move that opened the window is kept in the expansion");
        }
        check(trace.events.size() == 6, "every domain event is listed for the Events tab");
    }

    // ---------------------------------------------------------------------
    // The full path: a turn enriches the row it ran in
    // ---------------------------------------------------------------------
    {
        NativeGuiModel model;
        apply(model, kTaskOpened);
        apply(model, kEpisodeOpened);
        apply(model, kCursorRouting);
        for (const std::string& line : turn("claude-propose", "anthropic", "high", 100, 300, 0, "ok",
                                            "2026-01-01T00:00:02.000Z", "2026-01-01T00:00:06.200Z")) {
            apply(model, line);
        }
        apply(model, kRoutingDecided);
        apply(model,
              R"({"type":"session_status","roleStatus":{"epistemic":{"model":{"id":"claude-propose"},"latestCacheHitRate":75},"distillation":{"model":{"id":"claude-distill"},"latestCacheHitRate":12.5}},"roleUsage":{"epistemic":{"tokens":1000,"contextWindow":200000,"percent":0.5}},"cost":0.01})");

        const TraceModel trace = buildDispatchTrace(model);
        check(trace.hasTelemetry, "a turn and a status make the trace telemetry-bearing");
        check(trace.rows.size() == 1, "the turn did not open a second row");
        if (!trace.rows.empty()) {
            const TraceRow& row = trace.rows.front();
            check(row.role == DispatchRole::Routing, "the turn ran in the routing stage");
            check(row.turnCount == 1, "one turn in the window");
            check(row.dispatchedModel == "claude-propose", "the dispatched model is the one that ran");
            check(row.dispatchedProvider == "anthropic", "the provider comes from the same message");
            // The routing stage has no slot in session_status, so even though a
            // status arrived while this row was open, the column stays empty:
            // borrowing the propose model would state a resolution the runtime
            // never made for this role.
            check(row.roleModel.empty(), "the routing row takes no role-model slot");
            check(!row.modelDiffersFromRole, "a matching model is not a mismatch");
            check(row.thinkingLevel == "high" && row.thinkingFromTurn,
                  "the thinking level comes from the turn that reported one");
            // The routing row takes no role slot, so the telemetry's 75% is not
            // the value it shows; the turn's own usage is, and 300/(100+300+0) is
            // 75% — the same number, because TurnUsage mirrors the runtime's
            // formula. The provenance is what differs, and it is what the mark says.
            check(row.cacheHitRate > 74.9f && row.cacheHitRate < 75.1f, "the cache rate is 75%");
            check(row.cacheFromTurnUsage, "derived from the turn, because routing has no telemetry slot");
            check(formatTraceCache(row.cacheHitRate, row.cacheFromTurnUsage) == "75%*",
                  "and the mark on the row says so");
            check(row.durationMs == 4200, "the duration spans message_start to message_end");
            check(formatTraceDuration(row.durationMs) == "4.2s", "the duration renders in seconds");
            check(row.status == "ok", "the status is the turn's stop reason");
        }
        check(trace.events.size() == 4, "the domain events are still listed in arrival order");
    }

    // ---------------------------------------------------------------------
    // The row after the status carries the ROLE model, and the badge is derived
    // ---------------------------------------------------------------------
    {
        NativeGuiModel model;
        apply(model, kTaskOpened);
        apply(model, kEpisodeOpened);
        apply(model, kCursorRouting);
        for (const std::string& line : turn("claude-session", "anthropic", "", 10, 0, 0, "ok",
                                            "2026-01-01T00:00:02.000Z", "2026-01-01T00:00:03.000Z")) {
            apply(model, line);
        }
        apply(model,
              R"({"type":"session_status","roleStatus":{"epistemic":{"model":{"id":"claude-propose"},"latestCacheHitRate":40}}})");
        // The cursor moves to proposing; the next turn runs on the session model
        // rather than the role's configured one. That is the ONLY thing the pane
        // can see, and it is what the badge reports.
        apply(model,
              R"({"type":"CursorChanged","schemaVersion":7,"eventId":"e7","timestamp":"2026-01-01T00:00:04.000Z","taskId":"task-1","episodeId":"episode-1","stage":"proposing"})");
        for (const std::string& line : turn("claude-session", "anthropic", "low", 10, 10, 0, "ok",
                                            "2026-01-01T00:00:05.000Z", "2026-01-01T00:00:05.500Z")) {
            apply(model, line);
        }

        const TraceModel trace = buildDispatchTrace(model);
        check(trace.rows.size() == 2, "two cursor moves make two rows");
        if (trace.rows.size() == 2) {
            const TraceRow& routing = trace.rows[0];
            const TraceRow& propose = trace.rows[1];
            check(routing.role == DispatchRole::Routing && propose.role == DispatchRole::Propose,
                  "the rows are the stages the cursor passed through");
            check(propose.roleModel == "claude-propose", "the propose row reads the epistemic slot");
            check(propose.dispatchedModel == "claude-session", "the dispatched model is the session one");
            check(propose.modelComparisonKnown && propose.modelDiffersFromRole,
                  "the derived badge fires when the two differ");
            // The routing row took no slot even though a status had arrived before
            // it closed: session_status has no routing slot, and borrowing the
            // propose model would state a resolution nobody made.
            check(routing.dispatchedModel == "claude-session", "the routing row still names its turn");
            check(!routing.modelDiffersFromRole, "and does not claim a mismatch it cannot support");
            check(propose.thinkingFromTurn && propose.thinkingLevel == "low",
                  "each row's thinking level is its own turn's");
            // A blank providerThinkingLevel falls back to the session level only
            // when get_state supplied one; nothing did here, so the routing row
            // keeps the em-dash rather than inventing "high".
            check(!routing.thinkingFromTurn && routing.thinkingLevel.empty(),
                  "a turn with no thinking level and no get_state leaves the column blank");
            // The routing turn read nothing from cache (cacheRead 0 of 10 prompt
            // tokens): a measured zero, which is a rate, and marked as derived
            // because no slot describes the routing role.
            check(formatTraceCache(routing.cacheHitRate, routing.cacheFromTurnUsage) == "0%*",
                  "a measured zero hit rate is shown as a rate, not as the em-dash");
            check(propose.cacheHitRate == 40.0f && !propose.cacheFromTurnUsage,
                  "the propose role's telemetry rate wins over the turn's own derivation");
        }
    }

    // ---------------------------------------------------------------------
    // A derived rate: no telemetry at all, so the turn's usage is used and MARKED
    // ---------------------------------------------------------------------
    {
        NativeGuiModel model;
        apply(model, kTaskOpened);
        apply(model, kEpisodeOpened);
        for (const std::string& line : turn("claude-x", "anthropic", "medium", 100, 300, 100, "ok",
                                            "2026-01-01T00:00:01.000Z", "2026-01-01T00:00:02.000Z")) {
            apply(model, line);
        }
        const TraceModel trace = buildDispatchTrace(model);
        check(trace.rows.size() == 1, "a turn with no cursor move still gets a row");
        if (!trace.rows.empty()) {
            const TraceRow& row = trace.rows.front();
            check(row.stage == EpisodeStage::Unknown, "the row records the cursor stage it actually saw");
            check(row.role == DispatchRole::Unknown, "an unknown stage is an unknown role");
            check(std::string(dispatchRoleName(row.role)) == "unknown", "and it names itself honestly");
            // 300 / (100 + 300 + 100) — the runtime's own formula, so this cannot
            // disagree with the telemetry it stands in for.
            check(row.cacheHitRate > 59.9f && row.cacheHitRate < 60.1f, "the derived rate uses the runtime's formula");
            check(row.cacheFromTurnUsage, "and is marked as derived");
            check(formatTraceCache(row.cacheHitRate, row.cacheFromTurnUsage) == "60%*",
                  "the derived rate carries the mark that says so");
            check(row.roleModel.empty(), "no session_status means no role model");
        }
    }

    // ---------------------------------------------------------------------
    // A turn that never ends is visible as such
    // ---------------------------------------------------------------------
    {
        NativeGuiModel model;
        apply(model, kTaskOpened);
        apply(model, kEpisodeOpened);
        apply(model,
              R"({"type":"message_start","timestamp":"2026-01-01T00:00:01.000Z","message":{"role":"assistant","model":{"id":"claude-x","provider":"anthropic"},"content":[]}})");
        const TraceModel trace = buildDispatchTrace(model);
        check(trace.rows.size() == 1 && trace.rows[0].turnCount == 1, "the open turn is a row");
        check(!trace.rows[0].turns[0].ended, "an unclosed turn is reported as unclosed");
        check(trace.rows[0].durationMs < 0, "and has no duration, rather than a zero one");
        check(formatTraceDuration(trace.rows[0].durationMs) == "\xe2\x80\x94",
              "which renders as the em-dash, not as 0ms");

        // A message_end with no message_start adds nothing: inventing a turn for
        // it would put a dispatch in the trace that never ran.
        apply(model,
              R"({"type":"message_end","timestamp":"2026-01-01T00:00:02.000Z","message":{"role":"assistant","stopReason":"ok"}})");
        const TraceModel after = buildDispatchTrace(model);
        check(after.rows[0].turnCount == 1, "a stray message_end opens no second row");

        // The real end closes the turn it belongs to.
        apply(model,
              R"({"type":"message_end","timestamp":"2026-01-01T00:00:02.000Z","message":{"role":"assistant","stopReason":"ok"}})");
        const TraceModel closed = buildDispatchTrace(model);
        check(closed.rows[0].turns[0].ended, "the turn closes when its message_end arrives");
        check(closed.rows[0].durationMs == 1000, "and then has a duration");
    }

    // ---------------------------------------------------------------------
    // Two turns in one stage are two turns, not one averaged row
    // ---------------------------------------------------------------------
    {
        NativeGuiModel model;
        apply(model, kTaskOpened);
        apply(model, kEpisodeOpened);
        apply(model, kCursorRouting);
        for (const std::string& line : turn("claude-a", "anthropic", "high", 10, 0, 0, "ok",
                                            "2026-01-01T00:00:01.000Z", "2026-01-01T00:00:02.000Z")) {
            apply(model, line);
        }
        for (const std::string& line : turn("claude-b", "anthropic", "high", 10, 0, 0, "ok",
                                            "2026-01-01T00:00:03.000Z", "2026-01-01T00:00:04.000Z")) {
            apply(model, line);
        }
        const TraceModel trace = buildDispatchTrace(model);
        check(trace.rows.size() == 1, "a second turn in the same stage does not open a second row");
        if (!trace.rows.empty()) {
            check(trace.rows[0].turnCount == 2, "the row reports both turns");
            check(trace.rows[0].turns.size() == 2, "and keeps them, so a second model run is not hidden");
            check(trace.rows[0].turns[0].model == "claude-a" && trace.rows[0].turns[1].model == "claude-b",
                  "in arrival order");
            check(trace.rows[0].dispatchedModel == "claude-a", "the columns summarise the first turn");
            check(trace.rows[0].durationMs == 2000, "the span runs from the first start to the last end");
        }
    }

    // ---------------------------------------------------------------------
    // Closing the episode is what moves the cursor to the final report
    // ---------------------------------------------------------------------
    {
        NativeGuiModel model;
        apply(model, kTaskOpened);
        apply(model, kEpisodeOpened);
        apply(model, kCursorRouting);
        apply(model, kBodySelected);
        apply(model, kPlanProduced);
        apply(model,
              R"({"type":"CursorChanged","schemaVersion":7,"eventId":"e8","timestamp":"2026-01-01T00:00:04.000Z","taskId":"task-1","episodeId":"episode-1","stage":"distilling"})");
        // The controller emits NO CursorChanged for the final-report role: it
        // closes the episode, and the fold moves the cursor to `closed`. A trace
        // that only watched CursorChanged would end at `distilling` and lose the
        // conclusion entirely.
        apply(model,
              R"({"type":"EpisodeClosed","schemaVersion":7,"eventId":"e9","timestamp":"2026-01-01T00:00:05.000Z","taskId":"task-1","episodeId":"episode-1"})");
        const TraceModel trace = buildDispatchTrace(model);
        // Three windows: the routing at task open, the distilling the round
        // reached, and the close. The `closed` window is the one a trace that only
        // watched `CursorChanged` would never have.
        check(trace.rows.size() == 3, "each cursor move opened a window, including the close");
        if (trace.rows.size() == 3) {
            const TraceRow& last = trace.rows.back();
            check(last.role == DispatchRole::FinalReport, "the closed stage is the final report role");
            check(last.stage == EpisodeStage::Closed, "and it says the episode closed rather than that a turn ran");
            check(std::string(dispatchRoleName(last.role)) == "finalReport",
                  "the role is named finalReport, which the pane renders as `finalReport (closed)`");
            check(!last.fastPath, "a belief-loop round is not marked fast-path");
            check(last.detail == "episode closed", "the detail is the event that moved the cursor");
        }

        // A cursor move the fold REFUSES — it names an episode that does not
        // exist — must not open a row: reading the cursor back is what keeps the
        // trace from showing a stage that never happened.
        apply(model,
              R"({"type":"CursorChanged","schemaVersion":7,"eventId":"e10","timestamp":"2026-01-01T00:00:06.000Z","taskId":"task-1","episodeId":"episode-404","stage":"executing"})");
        check(!model.issues().empty(), "the fold refused the cursor move");
        const TraceModel after = buildDispatchTrace(model);
        check(after.rows.size() == 3, "a refused cursor move does not open a fourth row");
        check(!after.issues.empty(), "and the refusal reaches the trace's issue table");
    }

    // ---------------------------------------------------------------------
    // Issues reach the trace, which is where §5.3 says they must be readable
    // ---------------------------------------------------------------------
    {
        NativeGuiModel model;
        apply(model, kTaskOpened);
        // A duplicate TaskOpened is a SILENT no-op, not an issue: the snapshot and
        // the live stream necessarily overlap, and reporting an identical replay
        // would bury the real problems. A cursor move onto an episode that does
        // not exist is a genuine refusal, and is the kind of thing the table is for.
        apply(model, kTaskOpened);
        check(model.issues().empty(), "an identical replay is silent, not an issue");
        apply(model,
              R"({"type":"CursorChanged","schemaVersion":7,"eventId":"e11","timestamp":"2026-01-01T00:00:01.000Z","taskId":"task-1","episodeId":"nope","stage":"executing"})");

        const TraceModel trace = buildDispatchTrace(model);
        check(!trace.issues.empty(), "the trace carries the fold's issues for its table");
        check(trace.issues.front().eventType == "CursorChanged", "each issue names the event it refused");
        check(trace.issues.front().message.find("nope") != std::string::npos,
              "and says what it could not resolve");
        check(trace.rows.empty(), "a refused event is not a dispatch, so it opens no row");
    }

    // ---------------------------------------------------------------------
    // The formatting helpers
    // ---------------------------------------------------------------------
    {
        check(formatTraceDuration(0) == "0ms", "a zero duration is a measured zero, and says so");
        check(formatTraceDuration(999) == "999ms", "sub-second durations are milliseconds");
        check(formatTraceDuration(1000) == "1.0s", "a second and up is seconds");
        check(formatTraceDuration(-1) == "\xe2\x80\x94", "unreadable is the em-dash, never 0");
        check(formatTraceCache(0.0f, false) == "0%", "a measured zero rate is a rate");
        check(formatTraceCache(-1.0f, false) == "\xe2\x80\x94", "an unknown rate is the em-dash");
        check(formatTraceCache(62.4f, true) == "62%*", "the derived mark is part of the value");
    }

    // ---------------------------------------------------------------------
    // Timestamp parsing: the duration column depends on it, so it is asserted
    // ---------------------------------------------------------------------
    {
        check(parseIso8601Millis("1970-01-01T00:00:00.000Z") == 0, "the epoch parses as zero");
        check(parseIso8601Millis("1970-01-01T00:00:01.500Z") == 1500, "fractional seconds are milliseconds");
        check(parseIso8601Millis("2026-01-01T00:00:02.000Z") > 0, "a real date parses");
        // Ordering is what the duration needs, so assert it rather than the value.
        check(parseIso8601Millis("2026-01-01T00:00:06.200Z") - parseIso8601Millis("2026-01-01T00:00:02.000Z") == 4200,
              "two timestamps differ by their real gap");
        check(parseIso8601Millis("2026-01-01T01:00:00.000Z") - parseIso8601Millis("2026-01-01T00:00:00.000Z") == 3600000,
              "an hour is an hour, across the day boundary's arithmetic");
        check(parseIso8601Millis("2026-03-01T00:00:00.000Z") - parseIso8601Millis("2026-02-28T00:00:00.000Z") == 86400000,
              "a month boundary is not a leap-second trap in a non-leap year");
        check(parseIso8601Millis("2024-03-01T00:00:00.000Z") - parseIso8601Millis("2024-02-28T00:00:00.000Z") ==
                  2 * 86400000,
              "and a leap year has its extra day");
        check(parseIso8601Millis("2026-01-01T01:00:00.000+01:00") == parseIso8601Millis("2026-01-01T00:00:00.000Z"),
              "an explicit offset is honoured");
        // Refusals: a bare local time cannot be ordered against another machine's.
        check(parseIso8601Millis("") == -1, "an empty string is not a timestamp");
        check(parseIso8601Millis("2026-01-01T00:00:00") == -1, "a timestamp with no zone is refused");
        check(parseIso8601Millis("yesterday") == -1, "and so is prose");
        check(parseIso8601Millis("1735689600000") == 1735689600000LL, "a bare epoch-millisecond number is accepted");
    }

    // ---------------------------------------------------------------------
    // Column padding: the row line is fixed-width text in a monospaced font
    // ---------------------------------------------------------------------
    {
        check(traceDisplayWidth("plan") == 4, "ASCII counts one cell per character");
        check(traceDisplayWidth("\xe4\xb8\xad\xe6\x96\x87") == 4, "a CJK glyph counts as two cells");
        check(traceDisplayWidth("") == 0, "an empty cell is zero wide");

        check(traceCell("ab", 4) == "ab  ", "a short cell is padded with spaces");
        check(traceCell("abcd", 4) == "abcd", "an exact cell is left alone");
        check(traceCell("abcdef", 4) == "abcd", "an over-long cell is cut to its width");
        // A cut never lands mid-glyph: two CJK glyphs are four cells, and a
        // three-cell budget must drop the second glyph whole rather than emit a
        // truncated UTF-8 sequence.
        check(traceCell("\xe4\xb8\xad\xe6\x96\x87", 3) == "\xe4\xb8\xad",
              "a wide glyph that does not fit is dropped whole");
        check(traceCell("\xe4\xb8\xad", 3) == "\xe4\xb8\xad ", "and a wide glyph that fits is padded by cells");
        check(traceCell("anything", 0).empty(), "a zero-width cell renders nothing");
    }

    if (failures == 0) {
        std::printf("ALL PASS\n");
    } else {
        std::printf("%d FAILURES\n", failures);
    }
    return failures == 0 ? 0 : 1;
}
