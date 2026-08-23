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

# ---------------------------------------------------------------------------
# GUI app: UI + runtime client, links the model layer + ImGui backend.
# ---------------------------------------------------------------------------
add_executable(pi_gui src/App.cpp)
target_include_directories(pi_gui PRIVATE src ${imgui_SOURCE_DIR} ${imgui_SOURCE_DIR}/backends)
target_link_libraries(pi_gui PRIVATE pi_gui_model imgui_backend OpenGL::GL)

if(APPLE)
    target_compile_definitions(pi_gui PRIVATE GL_SILENCE_DEPRECATION)
endif()

# SDK entry: repo root is one level above this gui/ dir.
add_compile_definitions(
    PI_CLI="${CMAKE_SOURCE_DIR}/../packages/pie/dist/cli.js"
)

# Global font asset (absolute path so it resolves regardless of the working dir).
add_compile_definitions(
    PI_FONT_PATH="${CMAKE_SOURCE_DIR}/assets/SarasaTermSCNerd.ttc"
)
