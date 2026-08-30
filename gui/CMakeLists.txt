cmake_minimum_required(VERSION 3.24)
# OBJC and OBJCXX are enabled ONLY on Apple (see the if(APPLE)/enable_language
# just below project()). They are the Apple-native Cocoa/Metal path: .mm sources
# compile as Objective-C++ for src/plats/macos/MetalBackend.mm and the ImGui
# OSX/Metal backends (imgui_impl_osx.mm, imgui_impl_metal.mm). On Linux/Windows
# no Objective-C compiler is required, so enabling them unconditionally would
# make cmake try to identify an Objective-C compiler that gcc lacks.
project(pi_gui LANGUAGES CXX C)

# OBJC/OBJCXX are only needed on Apple: the native Cocoa/Metal shell compiles
# src/plats/macos/MetalBackend.mm and the imgui_impl_osx/metal backends as
# Objective-C++. Enabling them unconditionally forces cmake to identify an
# Objective-C compiler on Linux (gcc lacks cc1obj/cc1objplus), which aborts
# configure before dependency discovery. Enable them only on APPLE.
if(APPLE)
    enable_language(OBJC OBJCXX)
endif()

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

include(FetchContent)

# GLFW (system pkg-config lacks glfw3; vendor exactly like coach-desktop).
# Only needed on non-Apple (the GLFW/OpenGL3 path); the Apple build is a native
# Cocoa/MTKView shell with OSX + Metal and does not use GLFW.
if(NOT APPLE)
    FetchContent_Declare(
        glfw
        URL https://github.com/glfw/glfw/releases/download/3.4/glfw-3.4.zip
    )
    set(GLFW_BUILD_DOCS OFF CACHE BOOL "" FORCE)
    set(GLFW_BUILD_TESTS OFF CACHE BOOL "" FORCE)
    set(GLFW_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
    set(GLFW_BUILD_INSTALL OFF CACHE BOOL "" FORCE)
    # Linux/other-non-Apple: GLFW 3.4 defaults GLFW_BUILD_WAYLAND to ON and
    # requires wayland-scanner at configure time. Only enable Wayland when the
    # scanner is actually available; otherwise fall back to X11 so the build
    # does not force the extra tool. (Scoped to if(NOT APPLE): macOS uses the
    # Cocoa/Metal shell and never fetches GLFW.)
    find_program(WAYLAND_SCANNER_EXECUTABLE wayland-scanner)
    if(WAYLAND_SCANNER_EXECUTABLE)
        set(GLFW_BUILD_WAYLAND ON CACHE BOOL "" FORCE)
        set(GLFW_BUILD_X11 ON CACHE BOOL "" FORCE)
    else()
        set(GLFW_BUILD_WAYLAND OFF CACHE BOOL "" FORCE)
        set(GLFW_BUILD_X11 ON CACHE BOOL "" FORCE)
    endif()
    FetchContent_MakeAvailable(glfw)
endif()

# OBJC/OBJCXX are enabled once, above, inside if(APPLE). On Apple the ImGui
# backend is the OSX + Metal pair (imgui_impl_osx.mm / imgui_impl_metal.mm) and
# pie_gui builds src/plats/macos/MetalBackend.mm as Objective-C++, all inside a
# Cocoa/MTKView shell. GLFW and the OpenGL renderer are only needed on non-Apple
# platforms (Linux uses X11/Wayland via GLFW + OpenGL3). GLFW is only fetched in
# the if(NOT APPLE) branch below, so its .m files never appear here.

# Dear ImGui (glfw + opengl3 backends, plus OSX on Apple), exact coach-desktop version
FetchContent_Declare(
    imgui
    URL https://github.com/ocornut/imgui/archive/refs/tags/v1.92.9.zip
    # Vendored single-file patch: macOS IME composition state. The OSX backend
    # never told ImGui about marked text, so Backspace during Chinese IME
    # composition was forwarded to ImGui (deleting a committed char) AND to the
    # input manager (deleting the candidate). The patch tracks marked text and
    # suppresses the Backspace/Delete key from ImGui's queue during composition.
    # Tracked so a clean build reproduces it (the imgui source is a build-time
    # FetchContent download, not stored in the repo).
    PATCH_COMMAND patch -p1 -i "${CMAKE_CURRENT_SOURCE_DIR}/cmake/imgui-ime-backspace.patch"
)
FetchContent_MakeAvailable(imgui)

# imgui_markdown: a header-only Markdown renderer for Dear ImGui (single
# imgui_markdown.h, C++11+). Vendored into gui/include/imgui_markdown and
# checked in; the pinned upstream commit is copied locally so the gui does not
# fetch it at configure time. Only its include dir is needed.

add_library(imgui_backend STATIC
    ${imgui_SOURCE_DIR}/imgui.cpp
    ${imgui_SOURCE_DIR}/imgui_draw.cpp
    ${imgui_SOURCE_DIR}/imgui_tables.cpp
    ${imgui_SOURCE_DIR}/imgui_widgets.cpp
    ${imgui_SOURCE_DIR}/misc/freetype/imgui_freetype.cpp
)
if(APPLE)
    # macOS: native Cocoa/MTKView shell; OSX is the ImGui platform backend and
    # Metal is the renderer. No GLFW/OpenGL here.
    target_sources(imgui_backend PRIVATE
        ${imgui_SOURCE_DIR}/backends/imgui_impl_osx.mm
        ${imgui_SOURCE_DIR}/backends/imgui_impl_metal.mm)
    target_link_libraries(imgui_backend PUBLIC
        "-framework Cocoa" "-framework Metal" "-framework MetalKit"
        "-framework QuartzCore" "-framework GameController" "-framework Carbon")
else()
    # Non-Apple: GLFW is the ImGui platform backend; OpenGL3 is the renderer.
    target_sources(imgui_backend PRIVATE
        ${imgui_SOURCE_DIR}/backends/imgui_impl_glfw.cpp
        ${imgui_SOURCE_DIR}/backends/imgui_impl_opengl3.cpp)
    target_link_libraries(imgui_backend PUBLIC glfw)
endif()
target_compile_definitions(imgui_backend PUBLIC IMGUI_ENABLE_FREETYPE)
target_include_directories(imgui_backend PUBLIC
    ${imgui_SOURCE_DIR}
    ${imgui_SOURCE_DIR}/backends
)

# FreeType is required to load the TTC (Sarasa Term SC Nerd) font collection.
find_package(Freetype REQUIRED)
target_link_libraries(imgui_backend PUBLIC Freetype::Freetype)

# OpenGL is only required on non-Apple (the GLFW/OpenGL3 renderer path).
if(NOT APPLE)
    find_package(OpenGL REQUIRED)
endif()

# The graph layout engine (PieGraphLayout) no longer uses Graphviz: the
# deterministic custom layout computes positions itself, so libgvc/libcgraph are
# not required (and pkg-config is not needed for this project).

# ---------------------------------------------------------------------------
# Model layer: headless, no ImGui dependency. Unit-testable without a window.
# ---------------------------------------------------------------------------
add_library(pi_gui_model STATIC src/Model.cpp src/FileList.cpp
    src/graph/GraphModel.cpp src/graph/PieGraphLayout.cpp
    src/graph/GraphRouting.cpp src/graph/GraphInteraction.cpp src/graph/GraphLive.cpp
    src/graph/GraphNavigation.cpp src/graph/GraphCache.cpp)
target_include_directories(pi_gui_model PUBLIC src)

# ---------------------------------------------------------------------------
# Model unit tests (headless; no window, no SDK).
# ---------------------------------------------------------------------------
enable_testing()
add_executable(pi_gui_model_test src/Model.test.cpp)
target_link_libraries(pi_gui_model_test PRIVATE pi_gui_model)
target_include_directories(pi_gui_model_test PRIVATE src)
add_test(NAME pi_gui_model_test COMMAND pi_gui_model_test)

# Phase 2 M1 graph projection + M3 layout test (headless).
add_executable(pi_gui_graph_test src/graph/GraphModel.test.cpp)
target_link_libraries(pi_gui_graph_test PRIVATE pi_gui_model)
target_include_directories(pi_gui_graph_test PRIVATE src)
add_test(NAME pi_gui_graph_test COMMAND pi_gui_graph_test)

# Phase 2 M4/M5/M6 routing + selection + live-stability test (headless).
add_executable(pi_gui_graph_m456_test src/graph/GraphM456.test.cpp)
target_link_libraries(pi_gui_graph_m456_test PRIVATE pi_gui_model)
target_include_directories(pi_gui_graph_m456_test PRIVATE src)
add_test(NAME pi_gui_graph_m456_test COMMAND pi_gui_graph_m456_test)

# Phase 2 M7 Focus Current navigation + M8 cache reuse/invalidation + M9 style
# structure test (headless, links pi_gui_model; no ImGui).
add_executable(pi_gui_graph_m789_test src/graph/GraphM789.test.cpp)
target_link_libraries(pi_gui_graph_m789_test PRIVATE pi_gui_model)
target_include_directories(pi_gui_graph_m789_test PRIVATE src)
add_test(NAME pi_gui_graph_m789_test COMMAND pi_gui_graph_m789_test)

# GraphView label clipping geometry regression test (headless; no ImGui).
add_executable(pi_gui_graph_label_layout_test src/graph/GraphLabelLayout.test.cpp)
target_link_libraries(pi_gui_graph_label_layout_test PRIVATE pi_gui_model)
target_include_directories(pi_gui_graph_label_layout_test PRIVATE src)
add_test(NAME pi_gui_graph_label_layout_test COMMAND pi_gui_graph_label_layout_test)

# User prompt command serialization + outbound pipe test (headless).
add_executable(pi_gui_prompt_test src/PromptCmd.test.cpp)
target_include_directories(pi_gui_prompt_test PRIVATE src)
add_test(NAME pi_gui_prompt_test COMMAND pi_gui_prompt_test)

# Layout geometry (no-overlap) test (headless).
add_executable(pi_gui_layout_test src/LayoutMetrics.test.cpp)
target_include_directories(pi_gui_layout_test PRIVATE src)
add_test(NAME pi_gui_layout_test COMMAND pi_gui_layout_test)

# User prompt palette input autogrow height (pure logic; headless).
add_executable(pi_gui_palette_metrics_test src/PaletteMetrics.test.cpp)
target_include_directories(pi_gui_palette_metrics_test PRIVATE src)
add_test(NAME pi_gui_palette_metrics_test COMMAND pi_gui_palette_metrics_test)

# "@" mention parsing + path completion (pure logic; headless).
add_executable(pi_gui_path_complete_test src/PathComplete.test.cpp)
target_include_directories(pi_gui_path_complete_test PRIVATE src)
add_test(NAME pi_gui_path_complete_test COMMAND pi_gui_path_complete_test)

# ---------------------------------------------------------------------------
# GUI app: UI + runtime client, links the model layer + ImGui backend.
# ---------------------------------------------------------------------------
add_executable(pie_gui
    src/App.cpp
    src/StatusBar.cpp
    src/BeliefLane.cpp
    src/CognitiveLane.cpp
    src/ExecutionLane.cpp
    src/LogListBox.cpp
    src/Summary.cpp
    src/Footer.cpp
    src/PromptPalette.cpp
    src/FileListWindow.cpp
    src/Theme.cpp
    src/UiMarkdown.cpp
    src/UiShared.cpp
    src/Paths.cpp
    src/RuntimeClient.cpp
    src/graph/GraphView.cpp
)
if(APPLE)
    target_sources(pie_gui PRIVATE src/plats/macos/MetalBackend.mm)
    set_source_files_properties(src/plats/macos/MetalBackend.mm PROPERTIES LANGUAGE OBJCXX)
    # Native Cocoa shell + Metal renderer: no OpenGL/GLFW on the Apple path.
    target_link_libraries(pie_gui PRIVATE
        "-framework Cocoa" "-framework Metal" "-framework MetalKit" "-framework QuartzCore")
else()
    target_sources(pie_gui PRIVATE src/plats/glfw/GLFWPlatform.cpp)
    target_link_libraries(pie_gui PRIVATE OpenGL::GL)
    target_compile_definitions(pie_gui PRIVATE GL_SILENCE_DEPRECATION)
endif()
target_include_directories(pie_gui PRIVATE src ${imgui_SOURCE_DIR} ${imgui_SOURCE_DIR}/backends)
target_link_libraries(pie_gui PRIVATE pi_gui_model imgui_backend)
target_include_directories(pie_gui PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/include/imgui_markdown)

# SDK entry: repo root is one level above this gui/ dir.
add_compile_definitions(
    PI_CLI="${CMAKE_SOURCE_DIR}/../packages/pie/dist/cli.js"
)

# ---------------------------------------------------------------------------
# Sarasa Term SC Nerd font (downloaded at build time, not stored in the repo).
#
# The font is fetched from a pinned v2.3.1 release, verified against its archive
# SHA256, extracted into the build font dir, and copied next to the pie_gui
# binary so the app can resolve it relative to its own executable path. Keeping
# the 270MB TTC out of the repo avoids the GitHub 100MB blob limit.
# ---------------------------------------------------------------------------
set(PIE_GUI_FONT_URL "https://github.com/laishulu/Sarasa-Term-SC-Nerd/releases/download/v2.3.1/SarasaTermSCNerd.ttc.tar.gz")
set(PIE_GUI_FONT_ARCHIVE_SHA256 "5a25c36d77694667f847c22475e202de352ec1128f5055081d3e82cd8a039ae2")
set(PIE_GUI_FONT_NAME "SarasaTermSCNerd.ttc")
set(PIE_GUI_FONT_CACHE_DIR "${CMAKE_BINARY_DIR}/fonts")

add_custom_command(
    OUTPUT "${PIE_GUI_FONT_CACHE_DIR}/${PIE_GUI_FONT_NAME}"
    COMMAND ${CMAKE_COMMAND}
        -DPIE_GUI_FONT_URL=${PIE_GUI_FONT_URL}
        -DPIE_GUI_FONT_ARCHIVE_SHA256=${PIE_GUI_FONT_ARCHIVE_SHA256}
        -DPIE_GUI_FONT_NAME=${PIE_GUI_FONT_NAME}
        -DPIE_GUI_FONT_CACHE_DIR=${PIE_GUI_FONT_CACHE_DIR}
        -P "${CMAKE_CURRENT_SOURCE_DIR}/cmake/FetchSarasaFont.cmake"
    COMMENT "Fetching Sarasa Term SC Nerd font (${PIE_GUI_FONT_NAME})"
    VERBATIM
)

add_custom_target(pie_gui_font DEPENDS "${PIE_GUI_FONT_CACHE_DIR}/${PIE_GUI_FONT_NAME}")

# Copy the fetched TTC next to the pie_gui executable so the app can load it via
# its own executable directory. POST_BUILD re-copies each build; the fetch itself
# is cached by the custom_command OUTPUT so it does not re-download.
add_custom_command(
    TARGET pie_gui POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
        "${PIE_GUI_FONT_CACHE_DIR}/${PIE_GUI_FONT_NAME}"
        "$<TARGET_FILE_DIR:pie_gui>/${PIE_GUI_FONT_NAME}"
    COMMENT "Copying Sarasa font next to pie_gui"
    VERBATIM
)
add_dependencies(pie_gui pie_gui_font)
