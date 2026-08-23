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
)
target_include_directories(imgui_backend PUBLIC
    ${imgui_SOURCE_DIR}
    ${imgui_SOURCE_DIR}/backends
)
target_link_libraries(imgui_backend PUBLIC glfw)

find_package(OpenGL REQUIRED)

add_executable(pi_gui main.cpp)
target_include_directories(pi_gui PRIVATE ${imgui_SOURCE_DIR} ${imgui_SOURCE_DIR}/backends)
target_link_libraries(pi_gui PRIVATE imgui_backend OpenGL::GL)

if(APPLE)
    target_compile_definitions(pi_gui PRIVATE GL_SILENCE_DEPRECATION)
endif()

# SDK entry: repo root is one level above this gui/ dir.
add_compile_definitions(
    PI_CLI="${CMAKE_SOURCE_DIR}/../packages/pie/dist/cli.js"
)
