// pie_gui_replay: headless transcript replays (docs/milestones.md §10).
//
//   pie_gui_replay --replay <session.jsonl>          print the derived model
//   pie_gui_replay --replay <session.jsonl> --dump <out.txt>
//   pie_gui_replay --replay <session.jsonl> --task <taskId>
//
// §10 names the JSON parser's correctness against REAL payloads as the highest
// risk in the plan, because a parser bug shares its mental model with the unit
// tests written for it — "the fixtures are wrong in the same way the parser is".
// A saved session transcript is the only fixture that does not. This runs one
// through the exact pipeline the live GUI uses: the same Bootstrap, the same
// command ids, the same buffer-and-replay, the same appliers. It is not a
// separate replay path, so it cannot pass while the GUI fails.
//
// It is reachable two ways, and both call the same function: as its own headless
// binary (`pie_gui_replay`, which is what a machine without the platform SDK can
// build and run), and as `pie_gui --replay <file>` (which M3 could not do because
// the app binary was parked until M5). The flags that only the tool understands
// are what tell the two modes apart in `pie_gui`'s main.
//
// Exit status: 0 when the transcript replayed, 1 when it could not be read.
// ReplayIssues are NOT a failure — an issue is a fact about the log, and the
// point of the tool is to show them.

#include <cstdio>
#include <cstring>
#include <fstream>
#include <string>
#include <string_view>
#include <vector>

#include "Bootstrap.h"
#include "ReplayTool.h"
#include "DemoEvents.h"
#include "EventQueue.h"
#include "ModelDump.h"
#include "SnapshotWriter.h"

namespace {

void usage() {
    std::fprintf(stderr,
                 "usage: pie_gui_replay (--replay <session.jsonl> | --demo)\n"
                 "                        [--task <taskId>] [--dump <out>] [--dump-snapshot <out>]\n"
                 "\n"
                 "  --replay <file>  a saved RPC transcript (one JSON record per line)\n"
                 "  --demo           the built-in scripted v7 stream, no file needed\n"
                 "  --demo-lines     print that stream as a transcript and exit\n"
                 "  --task <id>      print only this task's subtree\n"
                 "  --dump <file>    also write the text dump to <file>\n"
                 "  --dump-snapshot <file>\n"
                 "                   also write a `get_domain_snapshot` response line for\n"
                 "                   the final state, so the run can be replayed as a\n"
                 "                   reconnect (docs/milestones.md §5.3)\n");
}

// A fake clock for the replay. Nothing here waits: the tool feeds every line and
// then advances the clock past the snapshot deadline, so a transcript without a
// snapshot response replays as event-only instead of hanging or being special-
// cased.
int64_t g_nowMs = 0;
int64_t fakeNow() { return g_nowMs; }

} // namespace

namespace pie::gui {

int runReplayCli(int argc, char** argv) {
    std::string replayPath;
    std::string dumpPath;
    std::string snapshotPath;
    std::string taskFilter;
    bool demo = false;

    for (int i = 1; i < argc; ++i) {
        const std::string arg = argv[i];
        auto next = [&](const char* name) -> const char* {
            if (i + 1 >= argc) {
                std::fprintf(stderr, "pie_gui_replay: %s needs a value\n", name);
                return nullptr;
            }
            return argv[++i];
        };
        if (arg == "--replay") {
            const char* v = next("--replay");
            if (v == nullptr) return 1;
            replayPath = v;
        } else if (arg == "--dump") {
            const char* v = next("--dump");
            if (v == nullptr) return 1;
            dumpPath = v;
        } else if (arg == "--dump-snapshot") {
            const char* v = next("--dump-snapshot");
            if (v == nullptr) return 1;
            snapshotPath = v;
        } else if (arg == "--task") {
            const char* v = next("--task");
            if (v == nullptr) return 1;
            taskFilter = v;
        } else if (arg == "--demo") {
            demo = true;
        } else if (arg == "--demo-lines") {
            // Write the scripted stream out as a transcript, so
            // `tests/fixtures/demo-session.jsonl` is reproducible from the source
            // rather than being a file someone typed once.
            for (const std::string& line : pie::gui::demoEvents()) {
                std::fputs(line.c_str(), stdout);
                std::fputc('\n', stdout);
            }
            return 0;
        } else if (arg == "-h" || arg == "--help") {
            usage();
            return 0;
        } else {
            std::fprintf(stderr, "pie_gui_replay: unknown argument '%s'\n", arg.c_str());
            usage();
            return 1;
        }
    }

    if (replayPath.empty() && !demo) {
        usage();
        return 1;
    }
    if (!replayPath.empty() && demo) {
        std::fprintf(stderr, "pie_gui_replay: --replay and --demo are mutually exclusive\n");
        return 1;
    }

    pie::gui::NativeGuiModel model;
    pie::gui::Bootstrap bootstrap;
    // The two commands the live client would write. A transcript's own `response`
    // lines are what answer them; nothing is written to a pipe here.
    const pie::gui::Bootstrap::Commands commands = bootstrap.start(fakeNow());

    size_t lines = 0;
    auto feed = [&](const std::string& line) {
        if (line.empty()) return;
        bootstrap.ingestRaw(line, model, fakeNow());
        ++lines;
    };

    if (demo) {
        for (const std::string& line : pie::gui::demoEvents()) feed(line);
    } else {
        std::ifstream in(replayPath, std::ios::binary);
        if (!in) {
            std::fprintf(stderr, "pie_gui_replay: cannot open '%s'\n", replayPath.c_str());
            return 1;
        }
        // Framed, not split on '\n' per chunk: a transcript saved from a pipe can
        // end without a trailing newline, and the framer is the same one the live
        // reader uses, so the replay exercises it too.
        pie::gui::LineFramer framer;
        std::vector<char> chunk(64 * 1024);
        while (in) {
            in.read(chunk.data(), static_cast<std::streamsize>(chunk.size()));
            const size_t got = static_cast<size_t>(in.gcount());
            if (got == 0) break;
            std::string_view view(chunk.data(), got);
            framer.feed(view, feed);
        }
        framer.flush(feed);
    }
    // Past the deadline: a transcript with no snapshot response becomes
    // event-only, exactly as the live GUI would after five seconds.
    g_nowMs += 6000;
    bootstrap.tick(model, fakeNow());

    std::string out;
    if (taskFilter.empty()) {
        out = pie::gui::dumpModel(model);
    } else {
        const pie::gui::Task* task = model.task(taskFilter);
        if (task == nullptr) {
            std::fprintf(stderr, "pie_gui_replay: no such task '%s'\n", taskFilter.c_str());
            return 1;
        }
        out = pie::gui::dumpTask(model, *task);
    }
    // The dispatch trace is session-scoped rather than part of a task, so it is
    // appended to either form. It is where a transcript's telemetry is read: the
    // demo has none, and this is what says so instead of leaving it to be guessed.
    out += pie::gui::dumpTrace(model);

    std::fputs(out.c_str(), stdout);
    std::fprintf(stderr, "-- %zu lines, %zu dropped, %zu issues%s\n", lines,
                 bootstrap.droppedLines(), model.issues().size(),
                 bootstrap.isEventOnly() ? ", event-only" : "");

    auto writeFile = [](const std::string& path, const std::string& contents) {
        std::ofstream file(path, std::ios::binary);
        if (!file) return false;
        file << contents;
        return true;
    };
    if (!dumpPath.empty() && !writeFile(dumpPath, pie::gui::dumpModel(model))) {
        std::fprintf(stderr, "pie_gui_replay: cannot write '%s'\n", dumpPath.c_str());
        return 1;
    }
    if (!snapshotPath.empty()) {
        // Written with the request id the bootstrap actually used, so the line is
        // indistinguishable from what the runtime would have answered.
        const std::string line =
            pie::gui::writeDomainSnapshotLine(model, commands.snapshot);
        if (!writeFile(snapshotPath, line + "\n")) {
            std::fprintf(stderr, "pie_gui_replay: cannot write '%s'\n", snapshotPath.c_str());
            return 1;
        }
        std::fprintf(stderr, "-- wrote snapshot (%zu bytes) to %s\n", line.size(),
                     snapshotPath.c_str());
    }
    return 0;
}

} // namespace pie::gui

#ifdef PIE_GUI_REPLAY_STANDALONE
// The standalone binary. A separate entry point rather than a weak symbol: the
// tool has exactly one main, and pie_gui calls `runReplayCli` directly.
int main(int argc, char** argv) { return pie::gui::runReplayCli(argc, argv); }
#endif
