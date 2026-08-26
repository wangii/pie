// PIE Native GUI - platform abstraction.
//
// The GUI split is: the platform layer (this directory) owns the OS window,
// the event pump, the ImGui platform/renderer backend init, the per-frame
// begin/present, the exit condition, and teardown. The common App code (in
// ../App.cpp) only supplies the ImGui setup, the app session/runtime, and a
// per-frame draw callback. Neither side references the other's types: the App
// never includes GLFW/Cocoa/OpenGL/Metal headers, and a platform implementation
// never touches the model/RPC/lane rendering directly.
#pragma once

#include <functional>
#include <string>

namespace pie::gui {

// Window/init parameters supplied by the common App. Platform-neutral.
struct AppConfig {
    int width = 1440;
    int height = 900;
    std::string title = "PIE Native GUI";
    int minWidth = 0;   // layout-derived minimum (see LayoutMetrics.h)
    int minHeight = 0;
    int live = 1;       // 1 = spawn the RPC runtime child; 0 = use demo events
};

// Common App behavior handed to a platform backend. The platform owns window
// creation, backend init, the frame pump, present, and teardown; it calls these
// callbacks to set up the app and draw each frame. All callbacks run on the main
// thread.
struct AppLogic {
    // Create the ImGui context, IO flags, style, and load fonts. Called once by
    // the platform before it creates the window/backends.
    std::function<void()> setupImGui;

    // Create the app model / spawn the runtime (RPC child or demo events). Called
    // once after the window and backends exist. Return false to abort startup.
    std::function<bool()> setupApp;

    // Once per frame, after ImGui::NewFrame() and before drawing. Drains the RPC
    // event queue, applies auto-open of the user prompt pane, and handles ⌘T.
    std::function<void()> onFrameStart;

    // Build one ImGui frame's widgets (status bar, lanes, summary, footer,
    // user prompt palette). Called each frame after onFrameStart(). The platform
    // calls ImGui::Render() and presents afterwards.
    std::function<void()> onDraw;

    // Tear down the app runtime (join the reader thread, clean the SDK child).
    // Called once after the frame loop ends, before backend/window teardown.
    std::function<void()> onExit;
};

// Run the platform main loop and return the process exit code.
int runPlatform(const AppConfig& cfg, AppLogic logic);

} // namespace pie::gui
