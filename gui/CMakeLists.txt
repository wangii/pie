cmake_minimum_required(VERSION 3.24)
project(pi_gui LANGUAGES CXX C)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

include(FetchContent)

# GLFW (system pkg-config lacks glfw3; vendor exactly like coach-desktop)
FetchContent_Declare(
    glfw
    URL https://github.com/glfw/glfw/releases/download/3.4/glfw-3.4.zip
)
set(GLFW_BUILD_DOCS OFF CACHE BOOL "" FORCE)
set(GLFW_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(GLFW_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(GLFW_INSTALL OFF CACHE BOOL "" FORCE)
FetchContent_MakeAvailable(glfw)

# Dear ImGui (glfw + opengl3 backends), exact coach-desktop version
FetchContent_Declare(
    imgui
    URL https://github.com/ocornut/imgui/archive/refs/tags/v1.92.5.zip
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
    ${imgui_SOURCE_DIR}/backends/imgui_impl_glfw.cpp
    ${imgui_SOURCE_DIR}/backends/imgui_impl_opengl3.cpp
    ${imgui_SOURCE_DIR}/misc/freetype/imgui_freetype.cpp
)
target_compile_definitions(imgui_backend PUBLIC IMGUI_ENABLE_FREETYPE)
target_include_directories(imgui_backend PUBLIC
    ${imgui_SOURCE_DIR}
    ${imgui_SOURCE_DIR}/backends
)
target_link_libraries(imgui_backend PUBLIC glfw)

# FreeType is required to load the TTC (Sarasa Term SC Nerd) font collection.
find_package(Freetype REQUIRED)
target_link_libraries(imgui_backend PUBLIC Freetype::Freetype)

find_package(OpenGL REQUIRED)

# ---------------------------------------------------------------------------
# Model layer: headless, no ImGui dependency. Unit-testable without a window.
# ---------------------------------------------------------------------------
add_library(pi_gui_model STATIC src/Model.cpp)
target_include_directories(pi_gui_model PUBLIC src)

# ---------------------------------------------------------------------------
# Model unit tests (headless; no window, no SDK).
# ---------------------------------------------------------------------------
enable_testing()
add_executable(pi_gui_model_test src/Model.test.cpp)
target_link_libraries(pi_gui_model_test PRIVATE pi_gui_model)
target_include_directories(pi_gui_model_test PRIVATE src)
add_test(NAME pi_gui_model_test COMMAND pi_gui_model_test)

# Instruction command serialization + outbound pipe test (headless).
add_executable(pi_gui_instruction_test src/InstructionCmd.test.cpp)
target_include_directories(pi_gui_instruction_test PRIVATE src)
add_test(NAME pi_gui_instruction_test COMMAND pi_gui_instruction_test)

# Layout geometry (no-overlap) test (headless).
add_executable(pi_gui_layout_test src/LayoutMetrics.test.cpp)
target_include_directories(pi_gui_layout_test PRIVATE src)
add_test(NAME pi_gui_layout_test COMMAND pi_gui_layout_test)

# Instruction palette input autogrow height (pure logic; headless).
add_executable(pi_gui_palette_metrics_test src/PaletteMetrics.test.cpp)
target_include_directories(pi_gui_palette_metrics_test PRIVATE src)
add_test(NAME pi_gui_palette_metrics_test COMMAND pi_gui_palette_metrics_test)

# ---------------------------------------------------------------------------
# GUI app: UI + runtime client, links the model layer + ImGui backend.
# ---------------------------------------------------------------------------
add_executable(pie_gui src/App.cpp)
target_include_directories(pie_gui PRIVATE src ${imgui_SOURCE_DIR} ${imgui_SOURCE_DIR}/backends)
target_link_libraries(pie_gui PRIVATE pi_gui_model imgui_backend OpenGL::GL)
target_include_directories(pie_gui PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/include/imgui_markdown)

if(APPLE)
    target_compile_definitions(pie_gui PRIVATE GL_SILENCE_DEPRECATION)
endif()

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
