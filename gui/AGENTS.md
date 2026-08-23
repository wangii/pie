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

## Architecture and file responsibilities

The source is split into three layers. Keep new code in the matching layer.

- **Model (headless, no ImGui)** — `src/Model.h`, `src/Model.cpp`. The
  `NativeGuiModel` consumes the runtime event/state stream and holds the belief
  snapshot, active loop frame, frame history, execution trace, and frame cursor.
  This layer must stay ImGui-free so it can be unit-tested without a window.
- **Runtime client (transport)** — in `src/App.cpp`. Spawns the PI CLI in RPC
  mode, reads JSONL events, and writes instructions back. It must not mutate the
  model directly except by feeding events through `NativeGuiModel`, and must not
  infer epistemic meaning.
- **UI (ImGui)** — `src/App.cpp` render functions (the three lanes, status bar,
  navigator, summary, instruction palette). The UI reads model state; it never
  decides stage, cursor, or belief semantics.

Supporting files: `src/DemoEvents.h` (event fixture), `src/InstructionCmd.h`
(instruction serialization, inline and unit-testable), and the test files
`src/Model.test.cpp`, `src/InstructionCmd.test.cpp`.

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

## Tech stack and the SDL3 note

The current backend is GLFW + Dear ImGui (v1.92.5, `glfw`/`opengl3` backends) +
OpenGL, built with CMake (FetchContent vendors GLFW 3.4 and ImGui). Per the spec
§25, SDL3/SDL_GPU is recommended but is a future option, not a requirement. Do
not migrate the backend without an explicit request, and preserve the
macOS/Windows/Linux conditional compile path.

## Font asset and FreeType / TTC constraint

The global UI font is the Sarasa Term SC Nerd collection at
`assets/SarasaTermSCNerd.ttc`. It is a TrueType Collection (TTC) with 10 faces,
so it requires FreeType (`IMGUI_ENABLE_FREETYPE`) to be compiled in and linked
(`find_package(Freetype)` + `imgui_freetype.cpp` in the ImGui backend).

- The path is supplied as the `PI_FONT_PATH` compile definition (absolute path
  to the repo asset), not a relative path from the working directory.
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
- The instruction palette is a floating overlay window toggled by ⌘T/Ctrl-T,
  independent of the main workspace layout. When open it is rendered as its own
  ImGui window; it does not reserve any band in the layout, so it never overlaps
  the status bar, navigator, lanes, or summary. The geometry of the remaining
  (status bar, navigator, lanes, summary) regions is computed by `LayoutMetrics`
  (`computeLayout`/`laneRects`) and covered by the headless `pi_gui_layout_test`.
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
cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Debug

# Build all targets
cmake --build build -j

# Run all CTest tests
cd build && ctest --output-on-failure

# Run the model test (headless)
./build/pi_gui_model_test

# Run the instruction serialization + pipe test
./build/pi_gui_instruction_test
```

Notes:

- The root `npm run check` covers JS/TS packages only and does not gate this
  C++/CMake workspace. Use the commands above.
- `PI_CLI` is a compile definition pointing at
  `../packages/pie/dist/cli.js`; it must be defined or the build fails.
- `PI_FONT_PATH` is a compile definition pointing at the Sarasa TTC asset; it
  must be defined or the font cannot be located. After font/layout changes,
  rebuild and run `./build/pi_gui` and confirm there is no
  "Could not load font file" / font warning.

## Font / layout change checklist

- Reconfigure CMake after changing `CMakeLists.txt` (new `find_package`).
- `cmake --build build -j` must succeed.
- Launch `./build/pi_gui` (demo mode) and verify: no crash, no "Could not load
  font file" warning, status/navigator/lanes/summary do not overlap.
- Optionally test a narrow/small window (via `PI_GUI_SIZE=WxH`, e.g.
  `PI_GUI_SIZE=320x500 ./build/pi_gui`) to confirm the stacked-lane fallback
  triggers instead of overlapping.

## Change checklist

- Read files in full before wide-ranging or cross-layer changes; do not rely on
  grep snippets for broad edits.
- Keep the model layer ImGui-free and the UI layer free of model mutation.
- After code (not doc) changes, build and run both headless tests
  (`pi_gui_model_test`, `pi_gui_instruction_test`); iterate until they pass.
- Do not delete intended functionality without asking. In particular, the
  tracked legacy `gui/main.cpp` (an older standalone viewer) is retained and NOT
  part of the `pi_gui` target; it is kept to avoid removing intentional code.
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
