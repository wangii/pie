# PIE Native GUI — Development Rules

This file scopes the repo-root `AGENTS.md` to the C++/CMake/ImGui native GUI in
`gui/`. The repo-root rules still apply; this file adds (and does not duplicate or
conflict with) gui-specific guidance. Where they might overlap, the repo-root
rules are authoritative.

## Scope

`gui/` is a native C++20 workspace that renders the PIE belief-based harness as a
cognitive feedback-loop debugger. It is NOT the harness runtime: it does no
planning, distillation, belief update, or epistemic inference. All such state is
provided explicitly by the runtime through the event stream.

## Terminology
Terminologies are documented in `terminology.md`

## Architecture and file responsibilities

The source is split into three layers. Keep new code in the matching layer.

- **Model (headless, no ImGui)** — `src/Model.h`, `src/Model.cpp`. The
  `NativeGuiModel` consumes the runtime event/state stream and holds the belief
  snapshot, active loop frame, frame history, execution trace, and frame cursor.
  This layer must stay ImGui-free so it can be unit-tested without a window.
- **Runtime client (transport + RPC event adapter)** — in `src/App.cpp` + `src/Model.cpp`. Spawns the PI CLI in RPC mode, reads JSONL events, writes user prompts back as a `prompt` command via `serializePromptCommand`, and in live mode feeds each event line through `applyRpcLine` into `NativeGuiModel`. It must not mutate the model directly except by feeding events through `NativeGuiModel`, and must not infer epistemic meaning.
- **UI (ImGui)** — `src/App.cpp` render functions (the three lanes, status bar,
  navigator, summary, user prompt palette). The UI reads model state; it never
  decides stage, cursor, or belief semantics.

Supporting files: `src/DemoEvents.h` (event fixture), `src/PromptCmd.h`
(user prompt serialization, inline and unit-testable), and the test files
`src/Model.test.cpp`, `src/PromptCmd.test.cpp`.

## Runtime/model/UI boundary invariants

- **Explicit cursor / event semantics**: the GUI never computes `FrameStage`,
  the frame cursor, or epistemic meaning from a generic log. Stage and cursor
  are set only by explicit runtime events (e.g. `CursorChanged`, `FrameClosed`,
  or the frame-lifecycle events). In `NativeGuiModel`, the only belief-state
  mutator is `BeliefUpdated`.
- **Proposal != BeliefUpdate**: `ProposalCreated` appends a proposal to the
  frame; it never mutates the belief registry. Closing a frame (or any later
  event) must not rewrite an already-closed frame's proposals or trajectory.
- **Immutable history**: a closed frame is immutable. New evidence opens a new
  frame rather than editing a historical one.
- **No animation**: follow the spec's `clarity > visual novelty`. Do not add
  animation, transitions, or decorative motion. Keep highlighting simple and
  static (accent bars, badges, calm backgrounds).
  - **Exception (user-approved)**: the stage-indicating Pane background (the
    PLAN / DISTILLATION / PROPOSALS paragraphs, or the execution lane for
    EXECUTING) may animate between black and kPaneBgDark using a sinusoidal
    time relationship — see `paneBg()` in `src/App.cpp`. This narrow exception
    does not permit other animation, transitions, or decorative motion.

## Tech stack and the SDL3 note

The GUI is split into a platform layer under `src/plats/` and a common App in
`src/App.cpp`. On macOS the platform uses a native Cocoa shell (NSApp/NSWindow
with an MTKView), `imgui_impl_osx` as the ImGui platform backend and
`imgui_impl_metal` as the renderer. On other platforms it uses the `glfw`/
`opengl3` backends. Dear ImGui is v1.92.9 (FetchContent vendors GLFW 3.4 and
ImGui). Per the spec §25, SDL3/SDL_GPU is recommended but is a future option,
not a requirement. Do not migrate the backend without an explicit request, and
preserve the macOS/Windows/Linux conditional compile path.

## Font asset and FreeType / TTC constraint

The global UI font is the Sarasa Term SC Nerd collection, a TrueType Collection
(TTC) with 10 faces, so it requires FreeType (`IMGUI_ENABLE_FREETYPE`) to be
compiled in and linked (`find_package(Freetype)` + `imgui_freetype.cpp` in the
ImGui backend).

- The font is NOT stored in the repo. `gui/cmake/FetchSarasaFont.cmake` downloads
  a pinned Sarasa-Term-SC-Nerd v2.3.1 release at build time, verifies it against
  its archive SHA256, extracts `SarasaTermSCNerd.ttc` into the build font dir, and
  copies it next to the `pie_gui` binary (`$<TARGET_FILE_DIR:pie_gui>`).
- The app resolves the font relative to its own executable directory
  (`executableDirectory()` in `src/App.cpp`), not the working directory.
- `ImFontConfig::FontNo = 7` selects the Regular face (face 0 is Bold), and the
  CJK glyph range comes from `GetGlyphRangesChineseFull()`. The font is loaded
  once into the single `ImGui` context and applied globally, so no component
  uses `PushFont`/`PopFont`.
- If `AddFontFromFileTTF` returns `nullptr`, fall back to the default font and
  print a clear warning; this only happens if FreeType is missing or the path
  is wrong.

## Layout invariant: components must not overlap

- Vertical regions (status bar, frame navigator, lanes, current-frame summary)
  are laid out sequentially and must never overlap. Heights are derived from
  `ImGui::GetFrameHeightWithSpacing()` (so they track font size) instead of
  hardcoded pixel constants, with a `pad` margin between regions.
- The lane region height is clamped to a minimum and the window is given a
  minimum lane width. When the window is too narrow for three side-by-side
  lanes, the lanes stack vertically inside a scrollable region instead of
  overlapping.
- The user prompt palette is a floating overlay window toggled by ⌘T/Ctrl-T,
  independent of the main workspace layout. When open it is rendered as its own
  ImGui window; text is submitted with Cmd/Ctrl+Enter (Enter inserts a newline,
  so a multiline prompt is preserved end to end). It does not reserve any
  band in the layout, so it never overlaps the status bar, navigator, lanes, or
  summary. The geometry of the remaining (status bar, navigator, lanes, summary)
  regions is computed by `LayoutMetrics` (`computeLayout`/`laneRects`) and
  covered by the headless `pi_gui_layout_test`.
- The window enforces a minimum size matching the layout formula via
  `glfwSetWindowSizeLimits`, using the single-source constants
  `kMinWindowWidth`/`kMinWindowHeight` from `LayoutMetrics.h`. Resizing the
  window can never produce negative or out-of-work-area region rectangles.
- When adding a new region, derive its size from the available work area and
  font metrics, respect the minimum sizes, and verify the layout under small
  and narrow window sizes (e.g. `PI_GUI_SIZE=320x500`).

## Build and test commands

From `gui/` (the CMake source dir):

```bash
# Configure (existing build dir)
cmake --preset debug

# Build all targets
cmake --build --preset debug

# Run all CTest tests
ctest --preset debug

# Release build (configure + build + test)
cmake --preset release
cmake --build --preset release
ctest --preset release

# Run the model test (headless)
./build/pi_gui_model_test

# Run the user prompt serialization + pipe test
./build/pi_gui_prompt_test
```

Notes:

- `gui/CMakePresets.json` defines the `debug` and `release` configure/build/test
  presets as a method refactor over the explicit `cmake -S . -B build/<preset>`
  with `-G Ninja -DCMAKE_BUILD_TYPE=<Debug|Release>` incantation. Run
  `cmake --list-presets` to inspect them.

- The root `npm run check` covers JS/TS packages only and does not gate this
  C++/CMake workspace. Use the commands above.
- `PI_CLI` is a compile definition pointing at
  `../packages/pie/dist/cli.js`; it must be defined or the build fails.
- The Sarasa TTC is fetched at build time and placed next to `pie_gui` (see
  `gui/cmake/FetchSarasaFont.cmake`). After font/layout changes, rebuild and run
  `./build/pie_gui` and confirm there is no "Could not load font file" / font
  warning.

## Font / layout change checklist

- Reconfigure CMake after changing `CMakeLists.txt` (new `find_package`).
- `cmake --build build -j` must succeed.
- Launch `./build/pie_gui` (default: `--live`, spawns the RPC child so the ⌘T
  pane can submit prompts) and verify: no crash, no "Could not load font
  file" warning, status/navigator/lanes/summary do not overlap.
- The demo mode is explicit: `./build/pie_gui --demo` injects the formal
  `DemoEvents.h` event stream instead of live mode.
- Optionally test a narrow/small window (via `PI_GUI_SIZE=WxH`, e.g.
  `PI_GUI_SIZE=320x500 ./build/pie_gui`) to confirm the stacked-lane fallback
  triggers instead of overlapping.

## Change checklist

- Read files in full before wide-ranging or cross-layer changes; do not rely on
  grep snippets for broad edits.
- Keep the model layer ImGui-free and the UI layer free of model mutation.
- After code (not doc) changes, build and run both headless tests
  (`pi_gui_model_test`, `pi_gui_prompt_test`); iterate until they pass.
- Do not delete intended functionality without asking. In particular, the
  tracked legacy `gui/main.cpp` (an older standalone viewer) is retained and NOT
  part of the `pie_gui` target; it is kept to avoid removing intentional code.
- Commit only files you changed in this session, with explicit paths, and use
  the repo commit-message format `{feat,fix,docs}[(ai,tui,agent,coding-agent)]`.

## Roadmap update rules

The delivery plan lives in `gui/roadmap/` (`index.md` + one doc per phase). When
you change scope:

- Update the affected phase doc's `Status` and its artifact tables.
- Keep the `index.md` phase table's `Status` column and `Implementation status`
  section in sync with the actual code.
- Never turn a "Not Current Priority" or future item into an implicit P1/P0
  requirement; record it under the appropriate phase instead.
