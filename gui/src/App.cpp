// PIE Native GUI - cognitive feedback loop workbench (P0).
//
// Application orchestration only: window/ImGui/GLFW setup, the runtime RPC
// child (--live) or DemoEvents fixture (--demo), and the main loop that lays
// out the status bar / lanes / summary and routes each region's render to the
// extracted UI components. Region rendering lives in
// StatusBar/BeliefLane/CognitiveLane/ExecutionLane/Summary/InstructionPalette;
// theme/markdown/shared helpers in Theme/UiMarkdown/UiShared; the SDK transport
// in RuntimeClient; platform paths in Paths. This file only wires them together.
//
// Modes:
//   default   --live: spawns `node <PI_CLI> -ne --mode rpc` and applies its JSONL.
//   --demo    injects the formal DemoEvents.h scripted event stream.
//   --live    explicit; wins if both --demo and --live are supplied.
// GL_SILENCE_DEPRECATION is supplied as an APPLE compile definition in CMake.

#include <imgui.h>
#include <imgui_impl_glfw.h>
#include <imgui_impl_opengl3.h>
#include <GLFW/glfw3.h>

#include <algorithm>
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
#include "InstructionCmd.h"
#include "LayoutMetrics.h"
#include "StatusBar.h"
#include "BeliefLane.h"
#include "CognitiveLane.h"
#include "ExecutionLane.h"
#include "Summary.h"
#include "Footer.h"
#include "InstructionPalette.h"
#include "Theme.h"
#include "Paths.h"
#include "RuntimeClient.h"

#ifndef PI_CLI
#error "PI_CLI must be defined (absolute path to packages/pie/dist/cli.js)"
#endif

using namespace pie::gui;

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

    glfwSetErrorCallback([](int e, const char* d) { std::fprintf(stderr, "GLFW error %d: %s\n", e, d); });
    if (!glfwInit()) return 1;

#if defined(__APPLE__)
    const char* glslVersion = "#version 150";
    glfwWindowHint(GLFW_CONTEXT_VERSION_MAJOR, 3);
    glfwWindowHint(GLFW_CONTEXT_VERSION_MINOR, 2);
    glfwWindowHint(GLFW_OPENGL_PROFILE, GLFW_OPENGL_CORE_PROFILE);
    glfwWindowHint(GLFW_OPENGL_FORWARD_COMPAT, GLFW_TRUE);
#else
    const char* glslVersion = "#version 130";
    glfwWindowHint(GLFW_CONTEXT_VERSION_MAJOR, 3);
    glfwWindowHint(GLFW_CONTEXT_VERSION_MINOR, 0);
#endif

    int winW = 1440, winH = 900;
    if (const char* sz = std::getenv("PI_GUI_SIZE")) {
        // PI_GUI_SIZE="<width>x<height>" overrides the default window size.
        if (std::sscanf(sz, "%dx%d", &winW, &winH) == 2) {
            winW = std::max(320, winW);
            winH = std::max(160, winH);
        }
    }
    GLFWwindow* window = glfwCreateWindow(winW, winH, "PIE Native GUI", nullptr, nullptr);
    if (!window) { glfwTerminate(); return 1; }
    glfwMakeContextCurrent(window);
    glfwSwapInterval(1);
    // Enforce a minimum window size matching the layout formula so the status
    // bar, navigator, lanes, and summary always fit the work area without
    // overlap. The bounds come from the single source of truth in
    // LayoutMetrics.h so code, tests, and docs cannot drift. The instruction
    // palette is a floating window and does not participate in this layout.
    glfwSetWindowSizeLimits(window,
                            static_cast<unsigned int>(kMinWindowWidth),
                            static_cast<unsigned int>(kMinWindowHeight),
                            GLFW_DONT_CARE, GLFW_DONT_CARE);

    IMGUI_CHECKVERSION();
    ImGui::CreateContext();
    ImGui::GetIO().ConfigFlags |= ImGuiConfigFlags_NavEnableKeyboard;
    ImGui::StyleColorsDark();

    // Load the Sarasa Term SC Nerd TTC as the single global font. The asset is a
    // TrueType Collection (10 faces); FreeType (IMGUI_ENABLE_FREETYPE) must be
    // enabled to decode it. We select the Regular face and cover CJK ranges so
    // every component uses the same font without per-component PushFont.
    ImGuiIO& io = ImGui::GetIO();
    const std::string ttcPath = fontPath();
    // Select the Regular face (fc-scan index 7) of the Sarasa Term SC Nerd
    // collection. font_no 0 is Bold, so an explicit FontNo is required for a
    // regular-weight default.
    ImFontConfig fontCfg;
    fontCfg.FontNo = 7;  // Sarasa Term SC Nerd Regular
    // Global font sized up 35% (18 -> 24.3) to improve legibility. The rest of
    // the layout derives from GetFrameHeightWithSpacing()/LayoutMetrics, so it
    // tracks the larger font automatically.
    ImFont* font = io.Fonts->AddFontFromFileTTF(ttcPath.c_str(), 18.0f * 1.35f, &fontCfg, io.Fonts->GetGlyphRangesChineseFull());
    if (font == nullptr) {
        // FreeType is required for a TTC; fall back to the default font and warn.
        std::fprintf(stderr, "WARNING: failed to load %s; using default font. TTC requires FreeType.\n", ttcPath.c_str());
    }
    // Load the Italic face (fc-scan index 4) for markdown code spans/fenced blocks.
    ImFontConfig italicFontCfg;
    italicFontCfg.FontNo = 4;  // Sarasa Term SC Nerd Italic
    ImFont* codeFont = io.Fonts->AddFontFromFileTTF(ttcPath.c_str(), 18.0f * 1.35f, &italicFontCfg, io.Fonts->GetGlyphRangesChineseFull());
    if (codeFont == nullptr) {
        std::fprintf(stderr, "WARNING: failed to load italic code font (FontNo=4) from %s; code will render without italic.\n", ttcPath.c_str());
    }
    // Load the Bold face (fc-scan index 0) for markdown strong emphasis and
    // headings.
    ImFontConfig boldFontCfg;
    boldFontCfg.FontNo = 0;  // Sarasa Term SC Nerd Bold
    ImFont* boldFont = io.Fonts->AddFontFromFileTTF(ttcPath.c_str(), 18.0f * 1.35f, &boldFontCfg, io.Fonts->GetGlyphRangesChineseFull());
    if (boldFont == nullptr) {
        std::fprintf(stderr, "WARNING: failed to load bold markdown font (FontNo=0) from %s; bold text will render without bold.\n", ttcPath.c_str());
    }
    // Hand the markdown renderer its font resources; the vendor may be null (fall
    // back inside UiMarkdown) when a TTC face failed to load.
    setMarkdownFonts(codeFont, boldFont);
    // Do NOT call io.Fonts->Build() here. The vendored ImGui v1.92.5 OpenGL3
    // backend sets ImGuiBackendFlags_RendererHasTextures in ImGui_ImplOpenGL3_Init
    // (called below) and manages the font atlas lazily during ImGui::NewFrame().

    ImGui_ImplGlfw_InitForOpenGL(window, true);
    ImGui_ImplOpenGL3_Init(glslVersion);

    NativeGuiModel model;
    // The "PIE Session:" status slot shows the current working path (where this
    // GUI was launched), not a hardcoded session name.
    model.setSession(std::filesystem::current_path().string());

    SdkProcess sdk;
    EventQueue queue;
    std::atomic<bool> stopReader{false};
    std::thread reader;

    // Startup modes:
    //   default --live -> spawn the RPC child; the ⌘T pane drives the session and
    //     the runtime emits message_start/message_update/message_end on
    //     submission. Input is always sendable in live mode.
    //   --demo -> inject the formal DemoEvents.h fixture (full event stream).
    //   --demo --live together -> live wins (spawn RPC).
    if (live) {
        if (!spawnSdk(sdk)) {
            std::fprintf(stderr, "Failed to spawn SDK child\n");
            ImGui_ImplOpenGL3_Shutdown(); ImGui_ImplGlfw_Shutdown(); ImGui::DestroyContext();
            glfwDestroyWindow(window); glfwTerminate();
            return 1;
        }
        reader = std::thread(readerThread, std::ref(sdk), std::ref(queue), std::ref(stopReader));
        // No hardcoded prompt: the user drives the session via the ⌘T pane input.
    } else if (demo) {
        for (auto& line : pie::gui::demoEvents()) model.applyLine(line);
    }
    // else: default empty model.

    int viewId = -1;
    bool instructionOpen = false;
    InstructionPaletteState instrState;

    while (!glfwWindowShouldClose(window)) {
        glfwPollEvents();
        ImGui_ImplOpenGL3_NewFrame();
        ImGui_ImplGlfw_NewFrame();
        ImGui::NewFrame();

        if (live) {
            std::string line;
            while (queue.popIfAny(line)) applyRpcLine(model, line);
            // When the belief loop reaches the terminal finalAnswer role and its
            // conclusion message ends, auto-reopen the user instruction pane so the
            // user can view the answer, even if they had closed it.
            if (model.consumeAutoOpenInstruction()) instructionOpen = true;
        }

        auto& io = ImGui::GetIO();
        if ((io.KeySuper || io.KeyCtrl) && ImGui::IsKeyPressed(ImGuiKey_T, false))
            instructionOpen = !instructionOpen;

        // Main window fills the viewport.
        ImGui::SetNextWindowPos(ImVec2(0, 0));
        ImGui::SetNextWindowSize(io.DisplaySize);
        ImGui::Begin("PIE Native GUI", nullptr,
                     ImGuiWindowFlags_NoTitleBar | ImGuiWindowFlags_NoResize |
                     ImGuiWindowFlags_NoMove | ImGuiWindowFlags_NoCollapse |
                     ImGuiWindowFlags_NoScrollbar);

        float winW = io.DisplaySize.x;
        float winH = io.DisplaySize.y;
        float pad = 8.0f;

        // Derive vertical sizes from the frame height and font metrics so that
        // the layout tracks font scale instead of hardcoding pixel constants.
        float rowH = ImGui::GetFrameHeightWithSpacing();
        LayoutMetrics lm = computeLayout(io.DisplaySize.x, winH, rowH);
        float headerH = lm.headerH;   // status bar
        float summaryH = lm.summaryH; // current-frame summary
        float footerH = lm.footerH;   // bottom footer
        const float minLaneH = lm.minLaneH;
        const float minLaneW = lm.minLaneW;
        float laneH = lm.laneH;

        ImGui::BeginChild("top", ImVec2(0, headerH), false);
        renderStatusBar(model);
        ImGui::EndChild();

        // Floating instruction window (cmd/cmd-T), independent of the main layout.
        renderInstructionPalette(instructionOpen, instrState, model, live,
                                 [&sdk](const std::string& msg) {
                                     // live mode: send the instruction to the runtime client.
                                     writeCommand(sdk, serializeInstructionCommand("p-ins", msg));
                                 });

        ImGui::BeginChild("lanes", ImVec2(0, laneH), false);
        float availW = std::max(0.0f, winW - pad * 2);
        // Minimum lane width prevents the three lanes from collapsing; when the
        // window is too narrow the lane widths are clamped and the middle/right
        // lanes fall back to the available width.
        float leftW = availW * 0.27f;
        float midW = availW * 0.36f;
        float rightW = std::max(0.0f, availW - leftW - midW);
        // The right lane is the execution pane; it gets the dark-gray background
        // when the CursorChanged stage is EXECUTING (the current flow step).
        const bool execActive = model.cursor().valid() && model.cursor().stage == FrameStage::EXECUTING;
        if (availW < minLaneW * 3) {
            // Too narrow for three side-by-side lanes: stack them vertically
            // inside the scrollable region instead of overlapping.
            ImGui::BeginChild("left", ImVec2(0, 0), true);
            renderBeliefLane(model, viewId);
            ImGui::EndChild();
            ImGui::Spacing();
            ImGui::BeginChild("mid", ImVec2(0, 0), true);
            renderCognitiveLane(model, viewId);
            ImGui::EndChild();
            ImGui::Spacing();
            ImGui::PushStyleColor(ImGuiCol_ChildBg, paneBg(execActive));
            ImGui::BeginChild("right", ImVec2(0, 0), true);
            renderExecutionLane(model, viewId);
            ImGui::EndChild();
            ImGui::PopStyleColor(1);
        } else {
            ImGui::BeginChild("left", ImVec2(leftW, 0), true);
            renderBeliefLane(model, viewId);
            ImGui::EndChild();
            ImGui::SameLine();
            ImGui::BeginChild("mid", ImVec2(midW, 0), true);
            renderCognitiveLane(model, viewId);
            ImGui::EndChild();
            ImGui::SameLine();
            ImGui::PushStyleColor(ImGuiCol_ChildBg, paneBg(execActive));
            ImGui::BeginChild("right", ImVec2(rightW, 0), true);
            renderExecutionLane(model, viewId);
            ImGui::EndChild();
            ImGui::PopStyleColor(1);
        }
        ImGui::EndChild();

        ImGui::BeginChild("summary", ImVec2(0, summaryH), false);
        renderSummary(model, viewId);
        ImGui::EndChild();

        // Bottom footer pinned to the very bottom of the workspace: per-phase
        // model + cache hit rate and the accumulated session cost.
        ImGui::BeginChild("footer", ImVec2(0, footerH), true);
        renderFooter(model);
        ImGui::EndChild();

        ImGui::End();

        ImGui::Render();
        int dw = 0, dh = 0;
        glfwGetFramebufferSize(window, &dw, &dh);
        glViewport(0, 0, dw, dh);
        glClearColor(0.055f, 0.065f, 0.08f, 1.0f);
        glClear(GL_COLOR_BUFFER_BIT);
        ImGui_ImplOpenGL3_RenderDrawData(ImGui::GetDrawData());
        glfwSwapBuffers(window);
    }

    stopReader.store(true);
    if (sdk.inFd >= 0) close(sdk.inFd);
    if (sdk.outFd >= 0) close(sdk.outFd);
    if (sdk.pid > 0) { kill(sdk.pid, SIGTERM); waitpid(sdk.pid, nullptr, 0); }
    if (reader.joinable()) reader.join();

    ImGui_ImplOpenGL3_Shutdown();
    ImGui_ImplGlfw_Shutdown();
    ImGui::DestroyContext();
    glfwDestroyWindow(window);
    glfwTerminate();
    return 0;
}
