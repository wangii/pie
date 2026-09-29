// PIE Native GUI - cognitive feedback loop debugger.
//
// Application orchestration only. Window/event/ImGui-backend/present lifecycle
// is owned by the platform layer in `plats/` and driven through `runPlatform()`;
// this file only provides the common ImGui setup, the app session/runtime, and
// the per-frame UI callbacks.
//
// M9: the workspace is a flat sequence of bands and panels (docs/milestones.md
// §7.4). `computeShellLayout` decides every rectangle from the window size and the
// open panels, and this file draws into them in order — header, canvas, the open
// panels, footer. There is no early return and no `graphOpen` branch: opening a
// panel changes a rectangle, not the code path, which is what makes "the panels
// never overlap" a property of one function rather than of a set of ifs.
//
// Modes:
//   default   --live: spawns `node <PI_CLI> -ne --mode rpc`, runs the M3 connect
//             sequence (see Bootstrap), and applies its JSONL.
//   --demo    injects the DemoEvents.h scripted stream through the SAME bootstrap
//             path, so the demo cannot pass while live mode fails. A scripted
//             stream has no runtime to answer `get_domain_snapshot`, so the demo
//             correctly reports itself event-only — and its trace, which needs
//             message_start/session_status, correctly reports no telemetry.
//   --live    explicit; wins if both --demo and --live are supplied.
//
// Panels: Cmd/Ctrl+B belief list, Cmd/Ctrl+T dispatch trace, Cmd/Ctrl+F file list.
// ':' or Enter opens the Frame pane, which is one floating window carrying the
// Frame (and Approve / the objection box) above the prompt box. Cmd/Ctrl+= / -
// zoom the font. `Cmd/Ctrl+G` is gone with the text workspace it toggled (§4).

#include <imgui.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <functional>
#include <string>
#include <thread>

#include <signal.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

#include "Model.h"
#include "Bootstrap.h"
#include "DemoEvents.h"
#include "PromptCmd.h"
#include "ShellLayout.h"
#include "StatusBar.h"
#include "Footer.h"
#include "FramePane.h"
#include "FileListWindow.h"
#include "BeliefListModel.h"
#include "BeliefPane.h"
#include "FormulationView.h"
#include "Theme.h"
#include "TracePane.h"
#include "Paths.h"
#include "ReplayTool.h"
#include "RuntimeClient.h"
#include "graph/GraphModel.h"
#include "graph/PieGraphLayout.h"
#include "graph/GraphView.h"
#include "graph/GraphLive.h"
#include "plats/Platform.h"

#ifndef PI_CLI
#error "PI_CLI must be defined (absolute path to packages/pie/dist/cli.js)"
#endif

using namespace pie::gui;

namespace {

// A monotonic millisecond clock for the bootstrap's snapshot deadline. Injected
// rather than read inside Bootstrap so the sequence is testable without a clock;
// here it is a steady_clock read, which cannot go backwards when the wall clock
// is adjusted mid-session.
int64_t nowMs() {
    using namespace std::chrono;
    return duration_cast<milliseconds>(steady_clock::now().time_since_epoch()).count();
}

} // namespace

// App session state threaded through the callbacks. Lives for the duration of
// runPlatform().
struct AppSession {
    NativeGuiModel model;
    // The M3 connect sequence. Owns the snapshot buffering, the two-command
    // handshake and the event-only degradation; App only drives it.
    Bootstrap bootstrap;
    SdkProcess sdk;
    EventQueue queue;
    std::atomic<bool> stopReader{false};
    std::thread reader;
    bool live = true;
    // Which panels the user has open, and how much width each asks for. The
    // geometry is derived from it every frame by computeShellLayout.
    PanelState panels;
    // The Frame pane's prompt window: opened by ':' or Enter, closed by Esc. Set
    // by the auto-open edge below, which is the only thing that opens it without
    // the user asking.
    bool promptOpen = false;
    FramePaneState frameState;
    // The version the auto-open edge last fired for. §7.2's latch: a reconnect
    // re-delivers `get_state`, and without it the pane would pop up again for a
    // state the user has already seen.
    FormulationVersionId frameLatchVersionId;
    // The Frame view as of the previous frame, for the edge test. Held rather than
    // recomputed so the comparison is against what the user actually saw.
    FormulationView prevFormulation;
    BeliefListModel beliefList;
    BeliefSort beliefSort = BeliefSort::RecordOrder;
    BeliefFilter beliefFilter;
    TracePaneState tracePane;
    // Global font zoom (Cmd/Ctrl + plus/minus). Persisted across the session;
    // applied to style.FontScaleMain (the 1.92+ replacement for io.FontGlobalScale).
    float fontScale = 1.0f;
    static constexpr float kMinFontScale = 0.5f;
    static constexpr float kMaxFontScale = 4.0f;
    // Node graph session state (pan/zoom/selection), kept for the session.
    GraphViewState graphView;
    // Persistent live-layout state, so a closed episode's row stays frozen while
    // the active one relays out.
    GraphLiveState graphLive;
};

namespace {

// The task the workspace is about: the runtime cursor's, or the most recently
// recorded one when the cursor names none. Never a user selection — there is no
// such thing in this GUI (the canvas follows the runtime).
const Task* currentTask(const NativeGuiModel& model) {
    if (const Task* task = model.task(model.cursor().taskId)) return task;
    const std::vector<const Task*> tasks = model.tasks();
    return tasks.empty() ? nullptr : tasks.back();
}

// Which panel a keystroke toggles, or nullopt. Cmd/Ctrl is the platform's primary
// shortcut modifier on both macOS and the other platforms, matching the font-zoom
// chords below.
bool panelKeyPressed(PanelId& out) {
    const ImGuiIO& io = ImGui::GetIO();
    if (!(io.KeySuper || io.KeyCtrl)) return false;
    if (ImGui::IsKeyPressed(ImGuiKey_B, false)) {
        out = PanelId::BeliefList;
        return true;
    }
    if (ImGui::IsKeyPressed(ImGuiKey_T, false)) {
        out = PanelId::DispatchTrace;
        return true;
    }
    if (ImGui::IsKeyPressed(ImGuiKey_F, false)) {
        out = PanelId::FileList;
        return true;
    }
    return false;
}

} // namespace

int main(int argc, char** argv) {
    // Default: --live (spawn the RPC child). Pass --demo to opt into the formal
    // DemoEvents.h fixture instead. `live` is the whole state: `--live` is
    // explicit and wins if both flags are supplied, so there is nothing else for a
    // separate `demo` flag to record.
    bool live = true;
    for (int i = 1; i < argc; ++i) {
        if (std::string(argv[i]) == "--live") live = true;
        else if (std::string(argv[i]) == "--demo") live = false;
    }

    // `--replay <file>` and the dump flags run the headless tool and exit
    // (docs/milestones.md §9). They are what tell the two modes apart: `--demo`
    // alone means THIS binary's demo mode, while `--demo` beside `--dump` means
    // the replay tool — so the test is on the flags only the tool understands.
    for (int i = 1; i < argc; ++i) {
        const std::string arg = argv[i];
        if (arg == "--replay" || arg == "--dump" || arg == "--dump-snapshot" || arg == "--task" ||
            arg == "--demo-lines" || arg == "-h" || arg == "--help") {
            return pie::gui::runReplayCli(argc, argv);
        }
    }

    AppSession app;
    app.live = live;

    const int minW = static_cast<int>(kMinWindowWidth);
    const int minH = static_cast<int>(kMinWindowHeight);

    AppConfig cfg;
    if (const char* sz = std::getenv("PI_GUI_SIZE")) {
        if (std::sscanf(sz, "%dx%d", &cfg.width, &cfg.height) == 2) {
            cfg.width = std::max(320, cfg.width);
            cfg.height = std::max(160, cfg.height);
        }
    }
    cfg.minWidth = minW;
    cfg.minHeight = minH;

    AppLogic logic;
    // ImGui context, IO flags, style, and fonts (common).
    logic.setupImGui = [&]() {
        IMGUI_CHECKVERSION();
        ImGui::CreateContext();
        ImGui::GetIO().ConfigFlags |= ImGuiConfigFlags_NavEnableKeyboard;
        ImGui::StyleColorsDark();

        ImGuiIO& io = ImGui::GetIO();
        const std::string ttcPath = fontPath();
        ImFontConfig fontCfg;
        fontCfg.FontNo = 7;  // Sarasa Term SC Nerd Regular
        ImFont* font = io.Fonts->AddFontFromFileTTF(ttcPath.c_str(), 18.0f * 1.35f, &fontCfg, io.Fonts->GetGlyphRangesChineseFull());
        if (font == nullptr) {
            std::fprintf(stderr, "WARNING: failed to load %s; using default font. TTC requires FreeType.\n", ttcPath.c_str());
        }
        ImFontConfig italicFontCfg;
        italicFontCfg.FontNo = 4;  // Sarasa Term SC Nerd Italic
        ImFont* codeFont = io.Fonts->AddFontFromFileTTF(ttcPath.c_str(), 18.0f * 1.35f, &italicFontCfg, io.Fonts->GetGlyphRangesChineseFull());
        if (codeFont == nullptr) {
            std::fprintf(stderr, "WARNING: failed to load italic code font (FontNo=4) from %s; code will render without italic.\n", ttcPath.c_str());
        }
        ImFontConfig boldFontCfg;
        boldFontCfg.FontNo = 0;  // Sarasa Term SC Nerd Bold
        ImFont* boldFont = io.Fonts->AddFontFromFileTTF(ttcPath.c_str(), 18.0f * 1.35f, &boldFontCfg, io.Fonts->GetGlyphRangesChineseFull());
        if (boldFont == nullptr) {
            std::fprintf(stderr, "WARNING: failed to load bold markdown font (FontNo=0) from %s; bold text will render without bold.\n", ttcPath.c_str());
        }
        setMarkdownFonts(codeFont, boldFont);

        // Global font zoom state (Cmd/Ctrl + plus/minus). FontScaleMain is the
        // 1.92+ replacement for the deprecated io.FontGlobalScale; it is read at
        // render time (imgui.cpp), so setting it here before the first frame is
        // fine and it stays applied to every font face.
        ImGui::GetStyle().FontScaleMain = app.fontScale;
    };

    // App session / runtime: init model; spawn the RPC child (live) or inject
    // the demo fixture. Returns false to abort startup.
    logic.setupApp = [&]() -> bool {
        app.model.setSession(std::filesystem::current_path().string());
        if (app.live) {
            if (!spawnSdk(app.sdk)) {
                std::fprintf(stderr, "Failed to spawn SDK child\n");
                return false;
            }
            app.reader = std::thread(readerThread, std::ref(app.sdk), std::ref(app.queue), std::ref(app.stopReader));
            // The connect sequence, snapshot first (docs/milestones.md §5.3). Every
            // line that arrives until the snapshot is applied is buffered, so the
            // snapshot and the stream are reconciled rather than raced.
            const Bootstrap::Commands commands = app.bootstrap.start(nowMs());
            writeCommand(app.sdk, commands.snapshot);
            writeCommand(app.sdk, commands.state);
        } else {
            // The demo goes through the SAME bootstrap. Nothing answers its two
            // requests, so the tick below degrades it to event-only — which is the
            // honest label for a scripted stream, and the reason the demo cannot
            // accidentally exercise a path live mode does not.
            app.bootstrap.start(nowMs());
            for (const std::string& line : pie::gui::demoEvents()) {
                app.bootstrap.ingestRaw(line, app.model, nowMs());
            }
            app.bootstrap.tick(app.model, nowMs() + 6000);
        }
        return true;
    };

    // Once per frame, after ImGui::NewFrame(), before drawing.
    logic.onFrameStart = [&]() {
        if (app.live) {
            // Drain under the §5.3 budget: at most kDrainMaxLines lines and
            // kDrainBudgetMs of work per frame, so a backlog spreads across frames
            // instead of stalling one. A multi-megabyte snapshot is parsed on the
            // reader thread, so what arrives here is already a DOM.
            std::vector<InboundLine> lines;
            app.queue.drain(lines, kDrainMaxLines, kDrainBudgetMs, nowMs);
            for (const InboundLine& line : lines) app.bootstrap.ingest(line, app.model, nowMs());
            // The deadline check runs every frame, including frames with no input:
            // a runtime that never answers must not block the UI forever.
            app.bootstrap.tick(app.model, nowMs());
            // Whether a reading is waiting travels only in a `get_state` body — no
            // event carries it — so a run boundary asks for one (see
            // NativeGuiModel::requestStateRefresh). `Bootstrap::ingest` applies a
            // get_state response in the Live phase as well as during the connect
            // sequence, so this is the same command the bootstrap already used, and
            // it is a re-read on a run boundary rather than a poll on a timer.
            if (app.model.takeStateRefreshRequest()) {
                writeCommand(app.sdk, serializeGetStateCommand(nextPromptId()));
            }
        }
        auto& io = ImGui::GetIO();

        // The Frame view is derived BEFORE the keys are read, because the
        // auto-open edge compares it with the previous frame's.
        const Task* task = currentTask(app.model);
        const FormulationView formulation = deriveFormulationView(app.model, task);
        if (app.live && autoOpenEdge(app.prevFormulation, formulation, app.frameLatchVersionId)) {
            // §7.2: only a pause, or a FAILED continuation, opens the pane by
            // itself. `decisionOwed` fires nearly every round and is a badge on the
            // banner instead — a window that grabs focus every round is one the
            // user learns to close without reading.
            app.promptOpen = true;
        }
        app.prevFormulation = formulation;

        // ':' (Shift+Semicolon) or Enter opens the Frame pane when it is closed.
        // Esc closes it inside renderFramePane. Only open when it is closed, so a
        // ':' the user types into the input is unaffected.
        if (!app.promptOpen) {
            const bool colon = io.KeyShift && ImGui::IsKeyPressed(ImGuiKey_Semicolon, false);
            // Enter opens it only when no text field owns the keyboard: otherwise
            // the newline being typed would also re-open the window.
            const bool enter = !io.WantTextInput && ImGui::IsKeyPressed(ImGuiKey_Enter, false);
            if (colon || enter) app.promptOpen = true;
        }

        // Panel toggles: Cmd/Ctrl+B belief list, Cmd/Ctrl+T dispatch trace,
        // Cmd/Ctrl+F file list. `Cmd/Ctrl+G` is gone with the text workspace.
        PanelId toggled = PanelId::Count;
        if (panelKeyPressed(toggled)) app.panels.toggle(toggled);

        // Cmd/Ctrl + plus/minus zoom the global font by 10% per press, clamped to
        // a usable range. On the main keyboard the '+' glyph is Shift+Equal, so the
        // primary plus branch requires io.KeyShift; the numeric-keypad Add key is a
        // bare '+' and needs no Shift. Minus is a bare key on the main keyboard and
        // also on the keypad. The key is read from io directly, so the chord does
        // not depend on widget focus.
        if (io.KeySuper || io.KeyCtrl) {
            if ((io.KeyShift && ImGui::IsKeyPressed(ImGuiKey_Equal, false)) || ImGui::IsKeyPressed(ImGuiKey_KeypadAdd, false))
                app.fontScale = std::clamp(app.fontScale * 1.10f, AppSession::kMinFontScale, AppSession::kMaxFontScale);
            else if (ImGui::IsKeyPressed(ImGuiKey_Minus, false) || ImGui::IsKeyPressed(ImGuiKey_KeypadSubtract, false))
                app.fontScale = std::clamp(app.fontScale * 0.90f, AppSession::kMinFontScale, AppSession::kMaxFontScale);
            ImGui::GetStyle().FontScaleMain = app.fontScale;
        }
    };

    // Build one ImGui frame's widgets. A flat sequence over shell rectangles
    // (§7.4): every region is drawn into the rectangle computeShellLayout gave it,
    // and nothing here decides geometry or model meaning.
    logic.onDraw = [&]() {
        auto& io = ImGui::GetIO();
        ImGui::SetNextWindowPos(ImVec2(0, 0));
        ImGui::SetNextWindowSize(io.DisplaySize);
        ImGui::Begin("PIE Native GUI", nullptr,
                     ImGuiWindowFlags_NoTitleBar | ImGuiWindowFlags_NoResize |
                     ImGuiWindowFlags_NoMove | ImGuiWindowFlags_NoCollapse |
                     ImGuiWindowFlags_NoScrollbar);

        const Task* task = currentTask(app.model);
        const FormulationView formulation = deriveFormulationView(app.model, task);

        // The floating windows are drawn first so they sit above the docked panels
        // and are never clipped by a child region. The Frame pane is one of them
        // and it is also the reading: it carries the Frame, Approve and the
        // objection box together with the prompt box (FramePane.h), which is why
        // there is no docked Frame rectangle in the shell any more.
        renderFramePane(
            app.promptOpen, app.frameState, formulation, app.model, /*canSend=*/app.live,
            /*canAct=*/app.live, /*historyNavigationEnabled=*/true,
            [&app](const std::string& msg) {
                writeCommand(app.sdk, serializePromptCommand(nextPromptId(), msg));
            },
            // Each act asks for a fresh `get_state` afterwards. The three change
            // runtime state the domain log does not carry — the pause, the resume
            // phase, the auto-approve toggle — so without the re-read the pane would
            // keep showing the state the act just replaced.
            [&app](const std::string& versionId) {
                writeCommand(app.sdk, serializeApproveFrameCommand(nextPromptId(), versionId));
                app.model.requestStateRefresh();
            },
            [&app](const std::string& message) {
                writeCommand(app.sdk, serializeFrameCorrectCommand(nextPromptId(), message));
                app.model.requestStateRefresh();
            },
            [&app](bool enabled) {
                writeCommand(app.sdk, serializeSetAutoApproveFrameCommand(nextPromptId(), enabled));
                app.model.requestStateRefresh();
            },
            // A chip click goes where the record lives: a belief to the belief
            // list. Opening the panel is the shell's business, not the pane's —
            // the pane reports the click and nothing else.
            [&app](const FormulationChip& chip) {
                if (chip.opensBeliefs) app.panels.setOpen(PanelId::BeliefList, true);
            });
        renderFileList(app.panels.openFlag(PanelId::FileList), app.model);

        const float rowH = ImGui::GetFrameHeightWithSpacing();
        // §4 binds ONE key (':' or Enter) to the Frame pane, and the pane is one
        // window holding both the reading and the reply — so there is no panel
        // state to sync here and no way to end up answering a question the user
        // cannot see. Esc, handled inside renderFramePane, closes it.
        const ShellLayout shell =
            computeShellLayout(io.DisplaySize.x, io.DisplaySize.y, rowH, app.panels);

        // --- header: the status band ---------------------------------------
        ImGui::SetCursorPos(ImVec2(shell.header.x, shell.header.y));
        ImGui::BeginChild("status", ImVec2(shell.header.w, shell.header.h), false);
        renderStatusBar(app.model);
        ImGui::EndChild();

        // --- canvas: the graph ---------------------------------------------
        ImGui::SetCursorPos(ImVec2(shell.canvas.x, shell.canvas.y));
        ImGui::BeginChild("canvas", ImVec2(shell.canvas.w, shell.canvas.h), false);
        {
            const GraphTaskState graphState = projectGraphTask(app.model);
            const PieGraphLayout fresh = computeGraphLayout(graphState);
            // Freeze settled (closed-episode) rows across live updates; the active
            // episode takes fresh positions.
            const PieGraphLayout layout = stabilizeLiveLayout(graphState, fresh, app.graphLive);
            renderGraphView(app.graphView, graphState, layout);
        }
        ImGui::EndChild();

        // --- the docked panels ----------------------------------------------
        // Each renders into the rectangle the layout gave it. A panel that is open
        // always HAS a non-empty rectangle: that is the property
        // pi_gui_shell_layout_test sweeps for at every window size.
        if (!shell.beliefPanel.empty()) {
            ImGui::SetCursorPos(ImVec2(shell.beliefPanel.x, shell.beliefPanel.y));
            ImGui::BeginChild("beliefs", ImVec2(shell.beliefPanel.w, shell.beliefPanel.h), true);
            app.beliefList = buildBeliefList(app.model, task, app.beliefSort, app.beliefFilter);
            renderBeliefList(app.beliefList, app.model, app.beliefSort, app.beliefFilter);
            ImGui::EndChild();
        }
        if (!shell.tracePanel.empty()) {
            ImGui::SetCursorPos(ImVec2(shell.tracePanel.x, shell.tracePanel.y));
            ImGui::BeginChild("trace", ImVec2(shell.tracePanel.w, shell.tracePanel.h), true);
            renderDispatchTrace(app.model, app.tracePane);
            ImGui::EndChild();
        }

        // --- footer: the role telemetry --------------------------------------
        ImGui::SetCursorPos(ImVec2(shell.footer.x, shell.footer.y));
        ImGui::BeginChild("footer", ImVec2(shell.footer.w, shell.footer.h), true);
        renderGraphFooter(app.model);
        ImGui::EndChild();

        ImGui::End();
    };

    // Tear down the app runtime after the frame loop ends.
    logic.onExit = [&]() {
        app.stopReader.store(true);
        if (app.sdk.inFd >= 0) close(app.sdk.inFd);
        if (app.sdk.outFd >= 0) close(app.sdk.outFd);
        if (app.sdk.pid > 0) { kill(app.sdk.pid, SIGTERM); waitpid(app.sdk.pid, nullptr, 0); }
        if (app.reader.joinable()) app.reader.join();
    };

    return runPlatform(cfg, std::move(logic));
}
