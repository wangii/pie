// PIE Native GUI - GLFW + OpenGL3 platform backend (non-Apple).
//
// Wraps the existing window/event/ImGui-GLFW/OpenGL3 lifecycle behind the
// platform interface. GLFW owns the window and event pump; ImGui_ImplGlfw is
// the ImGui platform backend and ImGui_ImplOpenGL3 is the renderer.
#include "plats/Platform.h"

#include <GLFW/glfw3.h>
#include <imgui.h>
#include <imgui_impl_glfw.h>
#include <imgui_impl_opengl3.h>

#include <cstdio>

#ifndef PI_CLI
#error "PI_CLI must be defined (absolute path to packages/pie/dist/cli.js)"
#endif

namespace pie::gui {

int runPlatform(const AppConfig& cfg, AppLogic logic) {
    glfwSetErrorCallback([](int e, const char* d) { std::fprintf(stderr, "GLFW error %d: %s\n", e, d); });
    if (!glfwInit()) return 1;

    const char* glslVersion = "#version 130";
    glfwWindowHint(GLFW_CONTEXT_VERSION_MAJOR, 3);
    glfwWindowHint(GLFW_CONTEXT_VERSION_MINOR, 0);

    GLFWwindow* window = glfwCreateWindow(cfg.width, cfg.height, cfg.title.c_str(), nullptr, nullptr);
    if (!window) { glfwTerminate(); return 1; }
    glfwMakeContextCurrent(window);
    glfwSwapInterval(1);
    glfwSetWindowSizeLimits(window,
                            static_cast<unsigned int>(cfg.minWidth),
                            static_cast<unsigned int>(cfg.minHeight),
                            GLFW_DONT_CARE, GLFW_DONT_CARE);

    // ImGui context, style, fonts (common).
    logic.setupImGui();

    // Platform + renderer backends.
    ImGui_ImplGlfw_InitForOpenGL(window, true);
    ImGui_ImplOpenGL3_Init(glslVersion);

    // App session / runtime; abort on failure.
    if (!logic.setupApp()) {
        ImGui_ImplOpenGL3_Shutdown(); ImGui_ImplGlfw_Shutdown(); ImGui::DestroyContext();
        glfwDestroyWindow(window); glfwTerminate();
        return 1;
    }

    // Fullscreen toggle state (Ctrl+Super+F).
    bool fullscreen = false;
    bool prevFPressed = false;
    int savedX = 0, savedY = 0, savedW = 0, savedH = 0;

    while (!glfwWindowShouldClose(window)) {
        glfwPollEvents();
        // Ctrl+Super+F toggles fullscreen (Super is the non-mac OS/"cmd" key).
        // Edge-triggered so a held F doesn't flip repeatedly. Keyboard focus is
        // captured by ImGui_ImplGlfw, but polling here is symmetric with the
        // macOS Ctrl+Cmd+F handling in MetalBackend.mm.
        bool ctrl = glfwGetKey(window, GLFW_KEY_LEFT_CONTROL) == GLFW_PRESS ||
                    glfwGetKey(window, GLFW_KEY_RIGHT_CONTROL) == GLFW_PRESS;
        bool super = glfwGetKey(window, GLFW_KEY_LEFT_SUPER) == GLFW_PRESS ||
                     glfwGetKey(window, GLFW_KEY_RIGHT_SUPER) == GLFW_PRESS;
        bool f = glfwGetKey(window, GLFW_KEY_F) == GLFW_PRESS;
        if (f && ctrl && super && !prevFPressed) {
            if (fullscreen) {
                glfwSetWindowMonitor(window, nullptr, savedX, savedY, savedW, savedH, 0);
            } else {
                glfwGetWindowPos(window, &savedX, &savedY);
                glfwGetWindowSize(window, &savedW, &savedH);
                GLFWmonitor* mon = glfwGetPrimaryMonitor();
                const GLFWvidmode* mode = glfwGetVideoMode(mon);
                glfwSetWindowMonitor(window, mon, 0, 0, mode->width, mode->height, mode->refreshRate);
            }
            fullscreen = !fullscreen;
        }
        prevFPressed = f;

        ImGui_ImplOpenGL3_NewFrame();
        ImGui_ImplGlfw_NewFrame();
        ImGui::NewFrame();
        logic.onFrameStart();
        logic.onDraw();
        ImGui::Render();
        int dw = 0, dh = 0;
        glfwGetFramebufferSize(window, &dw, &dh);
        glViewport(0, 0, dw, dh);
        glClearColor(0.055f, 0.065f, 0.08f, 1.0f);
        glClear(GL_COLOR_BUFFER_BIT);
        ImGui_ImplOpenGL3_RenderDrawData(ImGui::GetDrawData());
        glfwSwapBuffers(window);
    }

    logic.onExit();
    ImGui_ImplOpenGL3_Shutdown();
    ImGui_ImplGlfw_Shutdown();
    ImGui::DestroyContext();
    glfwDestroyWindow(window);
    glfwTerminate();
    return 0;
}

} // namespace pie::gui
