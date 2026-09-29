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
# M2: the model layer is the v7 fold. Json.cpp is the DOM every wire line is
# parsed with; DomainEvents.cpp owns the event vocabulary; Model.cpp owns the
# state and the appliers.
#
# M3 added the adapter: EventQueue.cpp is the framing + parse-on-read + budgeted
# drain, Bootstrap.cpp is the connect sequence, ModelDump/SnapshotWriter are the
# replay tool's two output forms (a text dump, and a `get_domain_snapshot`
# response line that a reconnect can be replayed against).
#
# M6-M8 added what the panels render: BeliefListModel.cpp (belief rows),
# TraceModel.cpp (dispatch-trace rows), FormulationView.cpp (the Frame pane's
# content). All three are pure derivations over the model, so a panel's whole
# content is testable without a window — which is why they live in this library
# and not next to the ImGui that draws them.
add_library(pi_gui_model STATIC
    src/Model.cpp
    src/DomainEvents.cpp
    src/Json.cpp
    src/EventQueue.cpp
    src/Bootstrap.cpp
    src/ModelDump.cpp
    src/SnapshotWriter.cpp
    src/BeliefListModel.cpp
    src/TraceModel.cpp
    src/FormulationView.cpp
    src/FileList.cpp
)
target_include_directories(pi_gui_model PUBLIC src)

# ---------------------------------------------------------------------------
# Graph layer: headless projection + layout + link geometry + caches.
#
# ImGui-free on purpose — only GraphView.cpp touches ImGui, and it is not here.
# It depends on pi_gui_model because the projection reads the v7 records.
# ---------------------------------------------------------------------------
add_library(pi_gui_graph STATIC
    src/graph/GraphModel.cpp
    src/graph/PieGraphLayout.cpp
    src/graph/GraphRouting.cpp
    src/graph/GraphInteraction.cpp
    src/graph/GraphCache.cpp
    src/graph/GraphNavigation.cpp
    src/graph/GraphLive.cpp
)
target_link_libraries(pi_gui_graph PUBLIC pi_gui_model)
target_include_directories(pi_gui_graph PUBLIC src)

# ---------------------------------------------------------------------------
# Model unit tests (headless; no window, no SDK).
# ---------------------------------------------------------------------------
enable_testing()

# M0: the JSON DOM. Every later milestone reads wire events through it, so its
# fixtures are real `get_domain_snapshot` / domain-event payloads.
add_executable(pi_gui_json_test src/Json.test.cpp)
target_link_libraries(pi_gui_json_test PRIVATE pi_gui_model)
target_include_directories(pi_gui_json_test PRIVATE src)
add_test(NAME pi_gui_json_test COMMAND pi_gui_json_test)

# M2: the v7 domain fold. Replaces the v1-era pi_gui_model_test.
add_executable(pi_gui_domain_test src/Domain.test.cpp)
target_link_libraries(pi_gui_domain_test PRIVATE pi_gui_model)
target_include_directories(pi_gui_domain_test PRIVATE src)
add_test(NAME pi_gui_domain_test COMMAND pi_gui_domain_test)

# M3: the connect sequence — buffering, the two-order answer to `get_state`,
# ReplayIssues, and the three orderings that must reach the same terminal state.
add_executable(pi_gui_bootstrap_test src/Bootstrap.test.cpp)
target_link_libraries(pi_gui_bootstrap_test PRIVATE pi_gui_model)
target_include_directories(pi_gui_bootstrap_test PRIVATE src)
add_test(NAME pi_gui_bootstrap_test COMMAND pi_gui_bootstrap_test)

# M3: the headless transcript replay tool (docs/milestones.md §10). Not a test —
# it is how a real session transcript is run through the live pipeline without a
# window. M9 made the same entry point reachable as `pie_gui --replay <file>`, so
# this binary exists for the case that one cannot: a build with
# PIE_GUI_BUILD_APP=OFF, which is what a machine without the platform SDK has.
add_executable(pie_gui_replay src/ReplayTool.cpp)
target_link_libraries(pie_gui_replay PRIVATE pi_gui_model)
target_include_directories(pie_gui_replay PRIVATE src)
target_compile_definitions(pie_gui_replay PRIVATE PIE_GUI_REPLAY_STANDALONE)

# The tool's own smoke run: the built-in demo stream through the real bootstrap,
# asserting on the derived values rather than on an exit code alone.
add_test(NAME pi_gui_replay_test COMMAND pie_gui_replay --demo)
set_tests_properties(pi_gui_replay_test PROPERTIES
    PASS_REGULAR_EXPRESSION "task task-1 status=completed")

# The same stream read back from a checked-in transcript file. The `--demo` test
# above proves the pipeline; this one proves the FILE path — framing, a trailing
# newline, and a transcript on disk rather than in memory, which is how the tool
# is actually used. Regenerate the fixture with:
#   ./build/debug/pie_gui_replay --demo-lines > tests/fixtures/demo-session.jsonl
add_test(NAME pi_gui_replay_file_test
    COMMAND pie_gui_replay --replay ${CMAKE_CURRENT_SOURCE_DIR}/tests/fixtures/demo-session.jsonl)
set_tests_properties(pi_gui_replay_file_test PROPERTIES
    PASS_REGULAR_EXPRESSION "belief B1 \\[refuted\\]")

# M4: the v7 graph projection (nodes/edges) and the dot+rail+row layout. Replaces
# the v1-era pi_gui_graph_test (projection) and pi_gui_graph_m456_test (geometry,
# link routing, dependency emphasis, live stability, cache).
add_executable(pi_gui_graph_projection_test src/graph/GraphModel.test.cpp)
target_link_libraries(pi_gui_graph_projection_test PRIVATE pi_gui_graph)
target_include_directories(pi_gui_graph_projection_test PRIVATE src)
add_test(NAME pi_gui_graph_projection_test COMMAND pi_gui_graph_projection_test)

add_executable(pi_gui_graph_edges_test src/graph/GraphEdges.test.cpp)
target_link_libraries(pi_gui_graph_edges_test PRIVATE pi_gui_graph)
target_include_directories(pi_gui_graph_edges_test PRIVATE src)
add_test(NAME pi_gui_graph_edges_test COMMAND pi_gui_graph_edges_test)

# M5: canvas geometry + the style aggregate's literal-type promise, and the live
# canvas at scale. Replace pi_gui_graph_label_layout_test and pi_gui_graph_m789_test.
add_executable(pi_gui_graph_geometry_test src/graph/GraphGeometry.test.cpp)
target_link_libraries(pi_gui_graph_geometry_test PRIVATE pi_gui_graph)
target_include_directories(pi_gui_graph_geometry_test PRIVATE src)
add_test(NAME pi_gui_graph_geometry_test COMMAND pi_gui_graph_geometry_test)

add_executable(pi_gui_graph_live_test src/graph/GraphLive.test.cpp)
target_link_libraries(pi_gui_graph_live_test PRIVATE pi_gui_graph)
target_include_directories(pi_gui_graph_live_test PRIVATE src)
add_test(NAME pi_gui_graph_live_test COMMAND pi_gui_graph_live_test)

# M6: the belief list rows — labels, derived status, the supersession chain and
# the review obligations the panel surfaces.
add_executable(pi_gui_belief_list_test src/BeliefList.test.cpp)
target_link_libraries(pi_gui_belief_list_test PRIVATE pi_gui_model)
target_include_directories(pi_gui_belief_list_test PRIVATE src)
add_test(NAME pi_gui_belief_list_test COMMAND pi_gui_belief_list_test)

# M7: the dispatch trace — one row per stage window, every column attributed to
# its source, and the em-dash wherever a source is missing.
add_executable(pi_gui_trace_test src/Trace.test.cpp)
target_link_libraries(pi_gui_trace_test PRIVATE pi_gui_model)
target_include_directories(pi_gui_trace_test PRIVATE src)
add_test(NAME pi_gui_trace_test COMMAND pi_gui_trace_test)

# M9: the shell geometry that lays the panels out, replacing pi_gui_layout_test.
add_executable(pi_gui_shell_layout_test src/ShellLayout.test.cpp)
target_include_directories(pi_gui_shell_layout_test PRIVATE src)
add_test(NAME pi_gui_shell_layout_test COMMAND pi_gui_shell_layout_test)

# M8: the Frame view — the banner's exactly-one derivation, the auto-open edge,
# the source chips and the changed-field markers.
add_executable(pi_gui_formulation_test src/Formulation.test.cpp)
target_link_libraries(pi_gui_formulation_test PRIVATE pi_gui_model)
target_include_directories(pi_gui_formulation_test PRIVATE src)
add_test(NAME pi_gui_formulation_test COMMAND pi_gui_formulation_test)

# The correction-mode state transitions (pure logic; headless, no window).
add_executable(pi_gui_frame_pane_test src/FramePane.test.cpp)
target_link_libraries(pi_gui_frame_pane_test PRIVATE pi_gui_model)
target_include_directories(pi_gui_frame_pane_test PRIVATE src)
add_test(NAME pi_gui_frame_pane_test COMMAND pi_gui_frame_pane_test)

# The Frame pane's render wiring (Esc cancels the correction MODE, not the pane;
# a click on `Correction` enters the mode). Bare ImGui context, no OS window.
add_executable(pi_gui_frame_pane_render_test
    src/FramePane.render.test.cpp
    src/FramePane.cpp
    src/Theme.cpp
    src/UiMarkdown.cpp
)
target_link_libraries(pi_gui_frame_pane_render_test PRIVATE pi_gui_model imgui_backend)
target_include_directories(pi_gui_frame_pane_render_test PRIVATE
    src ${imgui_SOURCE_DIR} ${CMAKE_CURRENT_SOURCE_DIR}/include/imgui_markdown)
add_test(NAME pi_gui_frame_pane_render_test COMMAND pi_gui_frame_pane_render_test)

# ---------------------------------------------------------------------------
# Where the v1 targets went (the rewrite's transition record; the parked-target
# table that stood here between M2 and M9 is now this list):
#
#   pi_gui_model_test              -> pi_gui_domain_test            (M2)
#   pi_gui_graph_test              -> pi_gui_graph_projection_test  (M4)
#   pi_gui_graph_m456_test         -> pi_gui_graph_edges_test       (M4)
#   pi_gui_graph_m789_test         -> pi_gui_graph_live_test        (M5)
#   pi_gui_graph_label_layout_test -> pi_gui_graph_geometry_test    (M5)
#   pi_gui_layout_test             -> pi_gui_shell_layout_test      (M9)
#
# The app binary was parked from M2 to M5 (docs/milestones.md §2) and relinked at
# M5, the milestone whose gate needs it; M9 rewrote App.cpp as a flat panel
# sequence over ShellLayout. Nothing is parked now: the whole suite is the gate.
# ---------------------------------------------------------------------------

# User prompt command serialization + outbound pipe test (headless).
add_executable(pi_gui_prompt_test src/PromptCmd.test.cpp)
target_include_directories(pi_gui_prompt_test PRIVATE src)
add_test(NAME pi_gui_prompt_test COMMAND pi_gui_prompt_test)

# User prompt palette input autogrow height (pure logic; headless).
add_executable(pi_gui_palette_metrics_test src/PaletteMetrics.test.cpp)
target_include_directories(pi_gui_palette_metrics_test PRIVATE src)
add_test(NAME pi_gui_palette_metrics_test COMMAND pi_gui_palette_metrics_test)

# "@" mention parsing + path completion (pure logic; headless).
add_executable(pi_gui_path_complete_test src/PathComplete.test.cpp)
target_include_directories(pi_gui_path_complete_test PRIVATE src)
add_test(NAME pi_gui_path_complete_test COMMAND pi_gui_path_complete_test)

# ---------------------------------------------------------------------------
# GUI app: UI + runtime client, links the graph layer + model layer + ImGui backend.
#
# M9 rewrote App.cpp as a flat sequence over `computeShellLayout` (docs/milestones.md
# §7.4): header, canvas, the open docked panels, footer, plus the two floating
# windows. The four panels are wired here as sources — BeliefPane (M6 rows), TracePane
# (M7), FramePane (M8, which also grew out of PromptPalette) — and ShellLayout.h is
# header-only, so it has no source to list.
#
# The node graph is the workspace: the three-lane text workspace (BeliefLane /
# CognitiveLane / ExecutionLane / LogListBox / Summary / UiShared) was removed in
# the v7 rewrite (docs/milestones.md §1.4, M1), and LayoutMetrics was deleted in M9.
# ---------------------------------------------------------------------------
set(PIE_GUI_BUILD_APP ON CACHE BOOL "Build the pie_gui app binary")
if(PIE_GUI_BUILD_APP)
add_executable(pie_gui
    src/App.cpp
    src/ReplayTool.cpp
    src/StatusBar.cpp
    src/Footer.cpp
    src/FramePane.cpp
    src/BeliefPane.cpp
    src/TracePane.cpp
    src/FileListWindow.cpp
    src/Theme.cpp
    src/UiMarkdown.cpp
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
target_link_libraries(pie_gui PRIVATE pi_gui_graph pi_gui_model imgui_backend)
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
endif()  # PIE_GUI_BUILD_APP

# Requirement 1 (footer active-slot colour+bold) and requirement 3 (the frame
# sections as tabs) at the render layer, in a bare ImGui context. Footer.cpp is
# #included by the test (its helpers are file-local), so it is NOT a source here.
add_executable(pi_gui_render_wiring_test
    src/RenderWiring.test.cpp
    src/FramePane.cpp
    src/Theme.cpp
    src/UiMarkdown.cpp
)
target_link_libraries(pi_gui_render_wiring_test PRIVATE pi_gui_model imgui_backend)
target_include_directories(pi_gui_render_wiring_test PRIVATE
    src ${imgui_SOURCE_DIR} ${CMAKE_CURRENT_SOURCE_DIR}/include/imgui_markdown)
add_test(NAME pi_gui_render_wiring_test COMMAND pi_gui_render_wiring_test)

# openTurn() contract + the footer's turn -> active-slot derivation.
add_executable(pi_gui_open_turn_test src/OpenTurn.test.cpp src/Footer.cpp src/Theme.cpp)
target_link_libraries(pi_gui_open_turn_test PRIVATE pi_gui_model imgui_backend)
target_include_directories(pi_gui_open_turn_test PRIVATE
    src ${imgui_SOURCE_DIR} ${CMAKE_CURRENT_SOURCE_DIR}/include/imgui_markdown)
add_test(NAME pi_gui_open_turn_test COMMAND pi_gui_open_turn_test)
