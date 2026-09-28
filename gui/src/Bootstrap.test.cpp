// M3: the connect sequence (docs/milestones.md §5.3).
//
// The bootstrap is where the snapshot and the live stream are reconciled, and it
// is the only place in the GUI that can silently get the state wrong: a snapshot
// applied in the wrong order, a buffer that drops the wrong end, a `get_state`
// that overwrites what the runtime actually attested. None of that shows up as a
// crash — it shows up as a panel that is subtly wrong after a reconnect.
//
// So the tests here are about ORDER and CONVERGENCE, not about parsing:
//
//   * the two commands go out snapshot-first,
//   * nothing is applied while the snapshot is outstanding,
//   * `get_state` is held across the snapshot and applied after it,
//   * the buffer's caps drop the OLDEST lines,
//   * the deadline degrades to event-only rather than blocking,
//   * and the three orderings — events alone, snapshot-then-events,
//     snapshot-then-every-event-again — reach the same terminal state.

#include <cstdio>
#include <string>
#include <vector>

#include "Bootstrap.h"
#include "DemoEvents.h"
#include "DomainEvents.h"
#include "EventQueue.h"
#include "ModelDump.h"
#include "SnapshotWriter.h"

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

// --- helpers ----------------------------------------------------------------

// A monotonic fake clock. Every bootstrap entry point takes `nowMs`, so nothing
// here sleeps.
static int64_t g_now = 0;
static int64_t nowMs() { return g_now; }

static void feedAll(Bootstrap& bootstrap, NativeGuiModel& model,
                    const std::vector<std::string>& lines) {
    for (const std::string& line : lines) bootstrap.ingestRaw(line, model, nowMs());
}

// A minimal snapshot response, built by the writer from a model — so the
// "recorded transcript" in these tests is produced by the same code that a
// user's `--dump-snapshot` produces, not by a hand-typed imitation that could
// disagree with the reader.
static std::string snapshotLineFor(const NativeGuiModel& model) {
    return writeDomainSnapshotLine(model, "req_snapshot");
}

static std::string stateLine(const std::string& body) {
    return "{\"type\":\"response\",\"id\":\"req_state\",\"command\":\"get_state\",\"success\":true,"
           "\"data\":" +
           body + "}";
}

int main() {
    const std::vector<std::string> demo = demoEvents();

    // ---------------------------------------------------------------------
    // The two commands, in order
    // ---------------------------------------------------------------------
    {
        Bootstrap bootstrap;
        const Bootstrap::Commands commands = bootstrap.start(nowMs());
        check(commands.snapshot ==
                  "{\"type\":\"get_domain_snapshot\",\"id\":\"" + bootstrap.snapshotRequestId() +
                      "\"}",
              "the snapshot command asks for the snapshot");
        check(commands.state ==
                  "{\"type\":\"get_state\",\"id\":\"" + bootstrap.stateRequestId() + "\"}",
              "the state command asks for the state");
        check(!bootstrap.snapshotRequestId().empty() &&
                  bootstrap.snapshotRequestId() != bootstrap.stateRequestId(),
              "the two requests carry distinct ids");
        check(bootstrap.phase() == BootstrapPhase::Bootstrapping, "start() enters Bootstrapping");
    }

    // ---------------------------------------------------------------------
    // Nothing is applied while the snapshot is outstanding
    // ---------------------------------------------------------------------
    {
        Bootstrap bootstrap;
        NativeGuiModel model;
        bootstrap.start(nowMs());
        const BootstrapIngest result = bootstrap.ingestRaw(demo[0], model, nowMs());
        check(result == BootstrapIngest::Buffered, "an event during bootstrap is buffered");
        check(model.tasks().empty(), "a buffered event is not applied yet");
        check(bootstrap.bufferedLines() == 1, "the buffer holds the line");
        check(bootstrap.phase() == BootstrapPhase::Bootstrapping, "still bootstrapping");
    }

    // ---------------------------------------------------------------------
    // `get_state` is held across the snapshot and applied after it
    // ---------------------------------------------------------------------
    {
        Bootstrap bootstrap;
        NativeGuiModel model;
        bootstrap.start(nowMs());
        // The state response arrives BEFORE the snapshot: it must be held, not
        // applied, because an event-only projection must never overwrite what the
        // runtime attests about its own resume/decision state.
        const std::string state = stateLine(
            R"({"sessionId":"session-1","thinkingLevel":"high","isStreaming":false,"messageCount":3,
                "pendingMessageCount":1,"formulation":{"review":{"versionId":"formulation-1",
                "focusReviewed":true,"scopedBeliefIds":[]},"current":null,"deferral":null,
                "corrections":[],"decisionOwed":true,"recheckOwed":false,"recheck":null,
                "awaitingResponse":true,"approved":false,"pendingApplicability":[],
                "unrevalidated":[],"resume":{"versionId":"formulation-1","phase":"started"}}})");
        check(bootstrap.ingestRaw(state, model, nowMs()) == BootstrapIngest::HeldState,
              "an early get_state response is held");
        check(!model.sessionState().present, "a held get_state is not applied");

        // Now the snapshot, built from the full demo so the buffer below has a
        // consistent base to replay onto.
        NativeGuiModel prefix;
        for (size_t i = 0; i < 22; ++i) applyRpcLine(prefix, demo[i]);
        check(bootstrap.ingestRaw(snapshotLineFor(prefix), model, nowMs()) ==
                  BootstrapIngest::Snapshot,
              "the snapshot response is recognized");
        check(bootstrap.phase() == BootstrapPhase::Live, "the snapshot moves the bootstrap to Live");
        check(!bootstrap.isEventOnly(), "a successful snapshot is not event-only");
        check(model.sessionState().present, "the held get_state is applied after the snapshot");
        check(model.sessionState().thinkingLevel == "high", "the held state's fields survived");
        check(model.sessionState().formulation.has_value() &&
                  model.sessionState().formulation->awaitingResponse,
              "the runtime's own awaitingResponse survived");
        check(model.sessionState().formulation.has_value() &&
                  model.sessionState().formulation->decisionOwed,
              "the runtime's decisionOwed is carried, not derived");
        check(model.sessionState().formulation.has_value() &&
                  model.sessionState().formulation->resume.has_value() &&
                  model.sessionState().formulation->resume->phase == FormulationResumePhase::Started,
              "resume.phase reads as started");
    }

    // ---------------------------------------------------------------------
    // A `get_state` that arrives after the snapshot is applied immediately
    // ---------------------------------------------------------------------
    {
        Bootstrap bootstrap;
        NativeGuiModel model;
        bootstrap.start(nowMs());
        NativeGuiModel prefix;
        for (size_t i = 0; i < 22; ++i) applyRpcLine(prefix, demo[i]);
        bootstrap.ingestRaw(snapshotLineFor(prefix), model, nowMs());
        check(bootstrap.ingestRaw(stateLine(R"({"sessionId":"s","thinkingLevel":"low","messageCount":1})"),
                                  model, nowMs()) == BootstrapIngest::State,
              "a late get_state response is applied, not held");
        check(model.sessionState().present && model.sessionState().thinkingLevel == "low",
              "the late state landed");
        check(model.sessionState().formulation == std::nullopt,
              "`formulation: null` is the no-open-task case, distinct from an empty state");
    }

    // ---------------------------------------------------------------------
    // The caps drop the OLDEST lines, so the tail reaches the snapshot moment
    // ---------------------------------------------------------------------
    {
        BootstrapLimits limits;
        limits.maxBufferedLines = 3;
        Bootstrap bootstrap(limits);
        NativeGuiModel model;
        bootstrap.start(nowMs());
        // Four distinct FocusDeclared-ish lines is overkill; use SessionOpened-free
        // generic lines and assert on what the buffer kept. `TaskOpened` for
        // distinct tasks is the simplest line whose effect is observable.
        bootstrap.ingestRaw(R"({"type":"TaskOpened","schemaVersion":7,"eventId":"e1","taskId":"t1","initialPrompt":{"id":"p1","original":"a","effective":"a"},"inheritedBeliefs":[]})", model, nowMs());
        bootstrap.ingestRaw(R"({"type":"TaskOpened","schemaVersion":7,"eventId":"e2","taskId":"t2","initialPrompt":{"id":"p2","original":"b","effective":"b"},"inheritedBeliefs":[]})", model, nowMs());
        bootstrap.ingestRaw(R"({"type":"TaskOpened","schemaVersion":7,"eventId":"e3","taskId":"t3","initialPrompt":{"id":"p3","original":"c","effective":"c"},"inheritedBeliefs":[]})", model, nowMs());
        bootstrap.ingestRaw(R"({"type":"TaskOpened","schemaVersion":7,"eventId":"e4","taskId":"t4","initialPrompt":{"id":"p4","original":"d","effective":"d"},"inheritedBeliefs":[]})", model, nowMs());
        check(bootstrap.bufferedLines() == 3, "the line cap holds the buffer at its limit");
        check(bootstrap.droppedLines() == 1, "one line was dropped");

        // Replay the buffer and see which tasks exist. t1 was dropped, so the
        // kept window is the NEWEST three.
        bootstrap.ingestRaw(snapshotLineFor(model), model, nowMs());
        check(model.task("t1") == nullptr, "the oldest line was the one dropped");
        check(model.task("t2") != nullptr && model.task("t3") != nullptr && model.task("t4") != nullptr,
              "the newest lines survived — last-write-wins converges only if the tail does");
    }
    {
        BootstrapLimits limits;
        limits.maxBufferedBytes = 260;  // room for roughly two of the lines above
        Bootstrap bootstrap(limits);
        NativeGuiModel model;
        bootstrap.start(nowMs());
        bootstrap.ingestRaw(R"({"type":"TaskOpened","schemaVersion":7,"eventId":"e1","taskId":"t1","initialPrompt":{"id":"p1","original":"a","effective":"a"},"inheritedBeliefs":[]})", model, nowMs());
        bootstrap.ingestRaw(R"({"type":"TaskOpened","schemaVersion":7,"eventId":"e2","taskId":"t2","initialPrompt":{"id":"p2","original":"bbbbbbbbbbbbbbbbbbbb","effective":"b"},"inheritedBeliefs":[]})", model, nowMs());
        bootstrap.ingestRaw(R"({"type":"TaskOpened","schemaVersion":7,"eventId":"e3","taskId":"t3","initialPrompt":{"id":"p3","original":"cccccccccccccccccccc","effective":"c"},"inheritedBeliefs":[]})", model, nowMs());
        check(bootstrap.droppedLines() > 0, "the byte cap drops lines once it is exceeded");
        check(bootstrap.bufferedBytes() <= limits.maxBufferedBytes,
              "the byte cap is enforced, so a slow snapshot cannot grow without bound");
    }

    // ---------------------------------------------------------------------
    // The deadline degrades to event-only instead of blocking
    // ---------------------------------------------------------------------
    {
        Bootstrap bootstrap;
        NativeGuiModel model;
        g_now = 1000;
        bootstrap.start(nowMs());
        for (size_t i = 0; i < 22; ++i) bootstrap.ingestRaw(demo[i], model, nowMs());
        bootstrap.tick(model, g_now + 4999);
        check(bootstrap.phase() == BootstrapPhase::Bootstrapping, "the deadline has not passed yet");
        check(model.tasks().empty(), "still nothing applied");
        bootstrap.tick(model, g_now + 5000);
        check(bootstrap.phase() == BootstrapPhase::Live, "the deadline moves the bootstrap to Live");
        check(bootstrap.isEventOnly(), "a missed snapshot makes the run event-only");
        check(model.isEventOnly(), "the model says so too, so a panel can render it");
        check(!model.tasks().empty(), "the buffered lines were replayed, not discarded");
        check(model.task("task-1") != nullptr, "the replayed buffer built the task");
        g_now = 0;
    }
    {
        // A tick on a Live bootstrap must not change anything.
        Bootstrap bootstrap;
        NativeGuiModel model;
        bootstrap.start(nowMs());
        NativeGuiModel prefix;
        for (size_t i = 0; i < 22; ++i) applyRpcLine(prefix, demo[i]);
        bootstrap.ingestRaw(snapshotLineFor(prefix), model, nowMs());
        bootstrap.tick(model, g_now + 600000);
        check(!bootstrap.isEventOnly(), "a tick after the snapshot does not make a live run event-only");
    }

    // ---------------------------------------------------------------------
    // An error response, or an unreadable payload, degrades immediately
    // ---------------------------------------------------------------------
    {
        Bootstrap bootstrap;
        NativeGuiModel model;
        g_now = 0;
        bootstrap.start(nowMs());
        bootstrap.ingestRaw(R"({"type":"response","id":"req_snapshot","command":"get_domain_snapshot","success":false,"error":"not supported"})",
                            model, nowMs());
        check(bootstrap.phase() == BootstrapPhase::Live,
              "an error response ends the bootstrap without waiting out the deadline");
        check(bootstrap.isEventOnly(), "an error response is event-only");
    }
    {
        Bootstrap bootstrap;
        NativeGuiModel model;
        bootstrap.start(nowMs());
        bootstrap.ingestRaw(
            R"({"type":"response","id":"req_snapshot","command":"get_domain_snapshot","success":true,"data":42})",
            model, nowMs());
        check(bootstrap.isEventOnly(), "a snapshot payload that is not an object degrades to event-only");
    }

    // ---------------------------------------------------------------------
    // A line that is not JSON is an issue, not a crash and not silence
    // ---------------------------------------------------------------------
    {
        Bootstrap bootstrap;
        NativeGuiModel model;
        bootstrap.start(nowMs());
        NativeGuiModel prefix;
        for (size_t i = 0; i < 22; ++i) applyRpcLine(prefix, demo[i]);
        bootstrap.ingestRaw(snapshotLineFor(prefix), model, nowMs());
        model.clearIssues();
        bootstrap.ingestRaw("this is not json", model, nowMs());
        check(model.issues().size() == 1, "an unparsed line is recorded as an issue");
        check(!model.issues().empty() && model.issues()[0].eventType == "<unparsed>",
              "the issue names the line as unparsed");
    }

    // ---------------------------------------------------------------------
    // CONVERGENCE (docs/milestones.md §5.3, §10)
    //
    // Three orderings of the same log must reach the same terminal state:
    //   A: events alone (no snapshot at all)
    //   B: snapshot of the state after 22 events, then the remaining events
    //   C: that same snapshot, then EVERY event replayed over it
    // ---------------------------------------------------------------------
    {
        // A
        NativeGuiModel modelA;
        for (const std::string& line : demo) applyRpcLine(modelA, line);

        // B
        NativeGuiModel prefix;
        for (size_t i = 0; i < 22; ++i) applyRpcLine(prefix, demo[i]);
        const std::string snapshot = snapshotLineFor(prefix);
        std::vector<std::string> transcript;
        transcript.push_back(snapshot);
        for (size_t i = 22; i < demo.size(); ++i) transcript.push_back(demo[i]);

        Bootstrap bootstrapB;
        NativeGuiModel modelB;
        bootstrapB.start(nowMs());
        feedAll(bootstrapB, modelB, transcript);
        check(!bootstrapB.isEventOnly(), "B bootstrapped from a snapshot");
        check(modelB.issues().empty(), "a reconnect transcript raises no issues");

        // C
        Bootstrap bootstrapC;
        NativeGuiModel modelC;
        bootstrapC.start(nowMs());
        bootstrapC.ingestRaw(snapshot, modelC, nowMs());
        for (const std::string& line : demo) bootstrapC.ingestRaw(line, modelC, nowMs());

        const std::string dumpA = dumpTask(modelA, *modelA.task("task-1"));
        const std::string dumpB = dumpTask(modelB, *modelB.task("task-1"));
        const std::string dumpC = dumpTask(modelC, *modelC.task("task-1"));

        check(dumpA == dumpB,
              "events-alone and snapshot-then-events reach the same terminal state");
        check(dumpA == dumpC,
              "snapshot-then-every-event-replayed reaches the same terminal state");
        check(modelA.issues().empty() && modelB.issues().empty() && modelC.issues().empty(),
              "no ordering raises a spurious issue — the overlap is reconciled, not reported");

        // The prefix state must itself round-trip through the writer, or B and C
        // would be converging on a snapshot that lost something.
        NativeGuiModel reloaded;
        const std::string data = writeDomainSnapshotData(prefix);
        json::Value parsed;
        check(json::parse(data, parsed, nullptr), "the written snapshot is valid JSON");
        AgentSessionSnapshot state;
        check(readDomainSnapshot(parsed, state), "the written snapshot reads back");
        reloaded.applyDomainSnapshot(state);
        check(dumpTask(prefix, *prefix.task("task-1")) == dumpTask(reloaded, *reloaded.task("task-1")),
              "dump -> reload is the identity for the whole task subtree");
    }

    // ---------------------------------------------------------------------
    // LineFramer: a chunk boundary is not a line boundary
    // ---------------------------------------------------------------------
    {
        LineFramer framer;
        std::vector<std::string> got;
        auto collect = [&](std::string line) { got.push_back(std::move(line)); };
        framer.feed("{\"a\":1}\n{\"b\"", collect);
        check(got.size() == 1 && got[0] == "{\"a\":1}", "a partial tail is held, not emitted");
        check(framer.hasPending(), "the framer reports the held bytes");
        framer.feed(":2}\r\n{\"c\":3}", collect);
        check(got.size() == 2 && got[1] == "{\"b\":2}", "CRLF is stripped from the completed line");
        check(framer.pendingBytes() == 7, "a final line with no newline stays held");
        check(framer.flush(collect), "flush emits the held final line");
        check(got.size() == 3 && got[2] == "{\"c\":3}", "the final unterminated line is a line");
        check(!framer.hasPending(), "nothing is held after a flush");
        check(!framer.flush(collect), "a second flush emits nothing");
    }
    {
        // A line split across many chunks — the case a 4 KB read of a multi-MB
        // snapshot produces.
        LineFramer framer;
        std::vector<std::string> got;
        auto collect = [&](std::string line) { got.push_back(std::move(line)); };
        const std::string big = "{\"big\":\"" + std::string(5000, 'x') + "\"}";
        for (size_t i = 0; i < big.size(); i += 128) {
            framer.feed(std::string_view(big).substr(i, 128), collect);
        }
        check(got.empty(), "no line is emitted while the big line is still arriving");
        framer.feed("\n", collect);
        check(got.size() == 1 && got[0] == big, "a line split across 40 chunks arrives whole");
    }

    // ---------------------------------------------------------------------
    // The drain budget
    // ---------------------------------------------------------------------
    {
        EventQueue queue;
        for (int i = 0; i < 100; ++i) queue.push(parseInboundLine("{\"n\":" + std::to_string(i) + "}"));
        std::vector<InboundLine> out;
        const size_t taken = queue.drain(out, kDrainMaxLines, kDrainBudgetMs, [] { return int64_t{0}; });
        check(taken == kDrainMaxLines, "the line cap bounds one frame's drain");
        check(out.size() == kDrainMaxLines, "the drained vector holds exactly the budget");
        check(queue.size() == 100 - kDrainMaxLines, "the rest waits for the next frame");
        check(out.front().value.integer("n", -1) == 0, "the drain is oldest-first");
    }
    {
        EventQueue queue;
        for (int i = 0; i < 100; ++i) queue.push(parseInboundLine("{\"n\":" + std::to_string(i) + "}"));
        std::vector<InboundLine> out;
        int64_t clock = 0;
        // A clock that jumps 2ms per read: the budget stops the drain at 4ms.
        const size_t taken =
            queue.drain(out, kDrainMaxLines, kDrainBudgetMs, [&] { return clock += 2; });
        check(taken < kDrainMaxLines, "the time budget stops the drain before the line cap");
        check(taken >= 2, "at least the first lines go through, so a slow frame cannot starve the stream");
    }
    {
        EventQueue queue;
        queue.push(parseInboundLine("{\"type\":\"agent_start\"}"));
        std::vector<InboundLine> out;
        const size_t taken = queue.drain(out, kDrainMaxLines, kDrainBudgetMs, [] { return int64_t{1000000}; });
        check(taken == 1, "one line is always delivered even if the budget is already spent");
        check(out.size() == 1 && out[0].type() == "agent_start", "the delivered line kept its parsed form");
    }
    {
        InboundLine bad = parseInboundLine("{\"type\":\"x\"");
        check(!bad.parsed, "a truncated line parses as unparsed");
        check(bad.type().empty(), "an unparsed line has no type");
        InboundLine good = parseInboundLine(R"({"type":"EpisodeOpened","schemaVersion":7})");
        check(good.parsed && good.type() == "EpisodeOpened", "a parsed line exposes its type");
    }

    if (failures == 0) {
        std::printf("ALL PASS\n");
    } else {
        std::printf("%d FAILURES\n", failures);
    }
    return failures == 0 ? 0 : 1;
}
