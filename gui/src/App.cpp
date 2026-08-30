// PIE Native GUI - cognitive feedback loop workbench (P0).
//
// Application orchestration only. Window/event/ImGui-backend/present lifecycle
// is owned by the platform layer in `plats/` and driven through `runPlatform()`;
// this file only provides the common ImGui setup, the app session/runtime, and
// the per-frame UI callbacks (status bar / lanes / summary / user prompt
// palette). Platform-specific types (GLFW, Cocoa, Metal, OpenGL) never appear
// here.
//
// Modes:
//   default   --live: spawns `node <PI_CLI> -ne --mode rpc` and applies its JSONL.
//   --demo    injects the formal DemoEvents.h scripted event stream.
//   --live    explicit; wins if both --demo and --live are supplied.

#include <imgui.h>

#include <atomic>
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
#include "DemoEvents.h"
#include "PromptCmd.h"
#include "LayoutMetrics.h"
#include "StatusBar.h"
#include "LogListBox.h"
#include "Summary.h"
#include "Footer.h"
#include "PromptPalette.h"
#include "FileListWindow.h"
#include "Theme.h"
#include "Paths.h"
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

// App session state threaded through the callbacks. Lives for the duration of
// runPlatform().
struct AppSession {
    NativeGuiModel model;
    SdkProcess sdk;
    EventQueue queue;
    std::atomic<bool> stopReader{false};
    std::thread reader;
    bool live = true;
    std::string viewId;  // empty = follow the active frame
    bool promptOpen = false;
    PromptPaletteState promptState;
    bool fileListOpen = false;
    // Global font zoom (Cmd/Ctrl + plus/minus). Persisted across the session;
    // applied to style.FontScaleMain (the 1.92+ replacement for io.FontGlobalScale).
    float fontScale = 1.0f;
    static constexpr float kMinFontScale = 0.5f;
    static constexpr float kMaxFontScale = 4.0f;
    // Phase 2 (M0) Graph View: a Text<->Graph switch beside the three-lane
    // workspace. The graph session state (pan/zoom/selection) is preserved
    // across toggles within a session.
    bool graphOpen = true;  // default view: Node Graph View (Cmd/Ctrl+G toggles to Text View)
    GraphViewState graphView;
    // Phase 2 (M6): persistent live-layout state so closed-frame / belief nodes
    // stay frozen while the active frame relays out.
    GraphLiveState graphLive;
};

int main(int argc, char** argv) {
    // Default: --live (spawn the RPC child). Pass --demo to opt into the
    // formal DemoEvents.h fixture instead. --live is explicit and wins if both
    // flags are supplied.
    bool live = true;
    bool demo = false;
    for (int i = 1; i < argc; ++i) {
        if (std::string(argv[i]) == "--live") { live = true; demo = false; }
        else if (std::string(argv[i]) == "--demo") { demo = true; live = false; }
    }

    AppSession app;
    app.live = live;

    char buf[256];
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
        } else {
            for (auto& line : pie::gui::demoEvents()) app.model.applyLine(line);
        }
        return true;
    };

    // Once per frame, after ImGui::NewFrame(), before drawing.
    logic.onFrameStart = [&]() {
        if (app.live) {
            std::string line;
            while (app.queue.popIfAny(line)) applyRpcLine(app.model, line);
            if (app.model.consumeAutoOpenPrompt()) app.promptOpen = true;
        }
        auto& io = ImGui::GetIO();
        // ':' (Shift+Semicolon) opens the user prompt palette when it is closed.
        // Esc closes it inside renderPromptPalette. Only open when the palette is
        // closed so a ':' the user types into the palette input is unaffected.
        if (!app.promptOpen && io.KeyShift && ImGui::IsKeyPressed(ImGuiKey_Semicolon, false))
            app.promptOpen = true;
        if ((io.KeySuper || io.KeyCtrl) && ImGui::IsKeyPressed(ImGuiKey_F, false))
            app.fileListOpen = !app.fileListOpen;
        if ((io.KeySuper || io.KeyCtrl) && ImGui::IsKeyPressed(ImGuiKey_G, false))
            app.graphOpen = !app.graphOpen;
        // Cmd/Ctrl + plus/minus zoom the global font by 10% per press, clamped to
        // a usable range. Uses the same modifier convention as the toggles above.
        // On the main keyboard the '+' glyph is Shift+Equal, so the primary plus
        // branch requires io.KeyShift; the numeric-keypad Add key is a bare '+' and
        // needs no Shift. Minus is a bare key on the main keyboard and also on the
        // keypad. The key is read from io directly, so the chord does not depend on
        // widget focus.
        if (io.KeySuper || io.KeyCtrl) {
            if ((io.KeyShift && ImGui::IsKeyPressed(ImGuiKey_Equal, false)) || ImGui::IsKeyPressed(ImGuiKey_KeypadAdd, false))
                app.fontScale = std::clamp(app.fontScale * 1.10f, AppSession::kMinFontScale, AppSession::kMaxFontScale);
            else if (ImGui::IsKeyPressed(ImGuiKey_Minus, false) || ImGui::IsKeyPressed(ImGuiKey_KeypadSubtract, false))
                app.fontScale = std::clamp(app.fontScale * 0.90f, AppSession::kMinFontScale, AppSession::kMaxFontScale);
            ImGui::GetStyle().FontScaleMain = app.fontScale;
        }
    };

    // Build one ImGui frame's widgets.
    logic.onDraw = [&]() {
        auto& io = ImGui::GetIO();
        ImGui::SetNextWindowPos(ImVec2(0, 0));
        ImGui::SetNextWindowSize(io.DisplaySize);
        ImGui::Begin("PIE Native GUI", nullptr,
                     ImGuiWindowFlags_NoTitleBar | ImGuiWindowFlags_NoResize |
                     ImGuiWindowFlags_NoMove | ImGuiWindowFlags_NoCollapse |
                     ImGuiWindowFlags_NoScrollbar);

        // The floating overlays (user prompt palette, file list) are independent
        // ImGui windows and must render in BOTH the text workspace and the Graph
        // View mode. They are drawn before the Graph View early-return so that
        // GraphView mode never affects them.
        renderPromptPalette(app.promptOpen, app.promptState, app.model, app.live, app.graphOpen,
                            [&app](const std::string& msg) {
                                writeCommand(app.sdk, serializePromptCommand(nextPromptId(), msg));
                            });
        renderFileList(app.fileListOpen, app.model);

        // Phase 2 (M0) Graph View: when active, render the projected node graph
        // instead of the three-lane text workspace. Cmd+G toggles back.
        if (app.graphOpen) {
            GraphTaskState graphState = projectGraphTask(app.model);
            PieGraphLayout freshLayout = computeGraphLayout(graphState);
            // M6: freeze settled (closed-frame / belief) nodes across live
            // updates; active frame takes fresh positions.
            PieGraphLayout layout = stabilizeLiveLayout(graphState, freshLayout, app.graphLive);
            ImGui::Text("Node Graph View — (Cmd/Ctrl+G to return to Text View)");
            // Reserve a single-row footer at the very bottom of the screen; the
            // canvas child takes the remaining height so its content never
            // overlaps the footer row. Only the role context is passed to the
            // graph view; the per-phase model/CH telemetry lives in the footer.
            float graphFooterH = ImGui::GetFrameHeightWithSpacing() * 1.2f;
            ImGui::BeginChild("graph-canvas", ImVec2(0, -graphFooterH), false);
            renderGraphView(app.graphView, graphState, layout, app.model.cursor().stage,
                            app.model.session());
            ImGui::EndChild();
            ImGui::BeginChild("graph-footer", ImVec2(0, graphFooterH), true);
            renderGraphFooter(app.model);
            ImGui::EndChild();
            ImGui::End();
            return;
        }

        float winW = io.DisplaySize.x;
        float winH = io.DisplaySize.y;
        float pad = 8.0f;

        float rowH = ImGui::GetFrameHeightWithSpacing();
        LayoutMetrics lm = computeLayout(io.DisplaySize.x, winH, rowH);
        float headerH = lm.headerH;
        float summaryH = lm.summaryH;
        float footerH = lm.footerH;
        float laneH = lm.laneH;

        ImGui::BeginChild("top", ImVec2(0, headerH), false);
        renderStatusBar(app.model);
        ImGui::EndChild();

        ImGui::BeginChild("lanes", ImVec2(0, laneH), false);
        renderLogListBox(app.model, app.viewId);
        ImGui::EndChild();

        ImGui::BeginChild("summary", ImVec2(0, summaryH), false);
        renderSummary(app.model, app.viewId);
        ImGui::EndChild();

        ImGui::BeginChild("footer", ImVec2(0, footerH), true);
        renderFooter(app.model);
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
