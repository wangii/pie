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

- **Model (headless, no ImGui)** — `src/Model.h`, `src/Model.cpp` (the v7 state
  and its appliers), `src/DomainEvents.h`, `src/DomainEvents.cpp` (the event
  vocabulary and its wire parsing), and `src/Json.h`, `src/Json.cpp` (the
  dependency-free JSON DOM every wire line is parsed with). `NativeGuiModel`
  consumes the runtime event stream and holds the `AgentSessionSnapshot` mirror,
  the `SessionState` runtime mirror, and the RPC telemetry. This layer must stay
  ImGui-free so it can be unit-tested without a window;
  `target_include_directories(pi_gui_model PUBLIC src)` plus the link graph
  enforce that boundary.
  - **Read the APPLIER CONTRACT at the top of `src/Model.h` before adding or
    changing an applier.** The domain snapshot and the live stream necessarily
    overlap, so every applier must be a pure `f(state, event)` keyed on the record
    id it writes, and the issue/no-op/silent split described there is
    load-bearing. So is the rule that a DUPLICATE event still reconciles the state
    its applier derives: a replayed `ExperimentSelected` can put a selection back
    after the snapshot already held the plan, and only the duplicate path's reset
    keeps the terminal state order-independent.
- **Bootstrap + transport (headless)** — `src/Bootstrap.h/.cpp` (the connect
  sequence: snapshot first, buffer everything until it lands, hold `get_state`
  until after it, degrade to event-only on a deadline), `src/EventQueue.h/.cpp`
  (line framing, parse-on-the-reader-thread, the per-frame drain budget), and
  `src/RuntimeClient.h/.cpp` (fork/exec, pipes, the reader thread — the only part
  that needs a process). **Do not apply an inbound line outside `Bootstrap`**: the
  ordering rules in `docs/milestones.md` §5.3 are the difference between a
  reconnect that converges and one that silently rewinds the cursor.
- **Runtime client (transport + RPC event adapter)** — spawns `node <PI_CLI> -ne
  --mode rpc`, reads JSONL events, writes commands back (`serializePromptCommand`,
  and the four domain-state serializers in the same header). It must not mutate
  the model directly except by feeding events through `NativeGuiModel`, and must
  not infer epistemic meaning.
- **Graph projection + layout (headless, no ImGui)** — `src/graph/GraphModel.*`
  (the v7 projection: nodes and edges, every one read off an explicit field),
  `PieGraphLayout.*` (deterministic dot + rail + episode-row geometry),
  `GraphRouting.*`, `GraphInteraction.*`, `GraphCache.*`, `GraphLive.*` (the
  closed-episode freeze), and `GraphStyle.h`. Known as `pi_gui_graph`, linked only
  to `pi_gui_model`.
  - **The projection decides meaning; the renderer decides colour and position.**
    If a node or an edge is not in `GraphModel.cpp`, it is not on the canvas — and
    anything the projection invents is a claim the runtime never made. The fast
    path is the standing example: it has no `Plan`, so no plan node and no
    `plan -> execution` edge may be drawn for it.
- **Panel content (headless, no ImGui)** — `src/BeliefListModel.*` (belief rows),
  `src/TraceModel.*` (dispatch-trace rows), `src/FormulationView.*` (the Frame
  pane's content and its banner), and `src/ShellLayout.h` (every panel rectangle).
  Each is a pure derivation over the model, so the panels' whole content is
  testable without a window — and each is where a rule like "a column with no
  source renders `—`" or "these regions never overlap" is enforced.
- **UI (ImGui)** — `src/App.cpp`, which lays the shell out and calls one `render*`
  per region: `StatusBar`, `Footer`, `BeliefPane`, `TracePane`, `FramePane` (the
  Frame content plus the floating prompt window it grew out of `PromptPalette`),
  `FileListWindow`, and `graph/GraphView.cpp` (the only ImGui file in the graph
  layer). The UI reads model state; it never decides stage, cursor, or belief
  semantics. **App.cpp does no early return**: opening a panel changes a rectangle
  in `computeShellLayout`, not the code path.

Supporting files: `src/DemoEvents.h` (the v7 event fixture), `src/PromptCmd.h`
(command serialization, inline and unit-testable), `src/ModelDump.*` +
`src/SnapshotWriter.*` (the replay tool's two output forms), and the test files
next to the units they cover. `tests/fixtures/` holds recorded transcript files;
see its README.

> **The v7 rewrite is complete (M0–M10).** `docs/milestones.md` was the single
> delivery plan; `docs/archive/roadmap/` is the superseded roadmap and is not
> maintained. M1 removed the three-lane text workspace (the `BeliefLane` /
> `CognitiveLane` / `ExecutionLane` / `LogListBox` / `Summary` / `UiShared`
> components and the legacy standalone `gui/main.cpp`), so the node graph is the
> whole workspace. M2 replaced the model with the v7 fold. M3 added the bootstrap
> and the headless transcript replay tool. M4 rebuilt the graph projection and
> layout for v7. M5 rebuilt the canvas as dots and links, pruned `GraphStyle`, and
> relinked the app binary. M6 added the belief rows. M7 added the dispatch trace.
> M8 added the Frame view and the Frame pane. M9 added `ShellLayout` and rewrote
> `App.cpp` as a flat panel sequence (deleting `LayoutMetrics`). M10 archived the
> roadmap and synced this file and `terminology.md`. Where a section below and
> `docs/milestones.md` disagree, the milestone plan is the record of what was
> decided and the code is the record of what shipped.

## Runtime/model/UI boundary invariants

- **Explicit cursor / event semantics**: the GUI never computes an
  `EpisodeStage`, the session cursor, or epistemic meaning from a generic log.
  Stage and cursor are set only by `CursorChanged` and `EpisodeClosed`. In
  `NativeGuiModel`, the only belief-registry writer is `BeliefDeltaApplied`.
- **Episode boundaries**: only `EpisodeOpened`/`EpisodeClosed` delimit an
  episode. A second plan, or the `proposing` stage, must never serve as a
  separator.
- **Derived, never stored**: `Belief::status()` derives from provenance, and a
  belief's display label (`B1`, `B2`, …) is computed at render time from record
  order. Neither may become a stored field or an accumulator.
- **Immutable history**: a closed episode is immutable. New evidence opens a new
  episode rather than editing a historical one, and the applier refuses a write
  to a closed episode rather than trusting the runtime not to send one.
- **No animation**: follow the spec's `clarity > visual novelty`. Do not add
  animation, transitions, or decorative motion. Keep highlighting simple and
  static (rings, badges, calm backgrounds).
  - **Exception (user-approved)**: one stage-indicating background may animate
    between black and `kPaneBgDark` on a sinusoidal time relationship — see
    `paneBg()` in `src/Theme.cpp`.
  - **Where it lands moved twice.** `paneBg()`'s original callers (the cognitive
    lane's PLAN / DISTILLATION / PROPOSALS paragraphs, and the execution lane for
    EXECUTING) were removed with the text workspace in M1, so it had no caller for
    a while. M5 completed the redirect `docs/milestones.md` §6.3 called for: the
    canvas's current-node halo calls `paneBg(true)` for its pulsing ring, over the
    same black <-> `kPaneBgDark` sinusoid. `GraphView.cpp` is therefore its one
    caller now. **Do not delete `paneBg()`, do not re-animate a lane that no
    longer exists, and do not "clean up" the name**: it says "pane" because that is
    where the user approved it, and renaming it would make the redirect look like a
    second animation. This narrow exception does not permit any other animation,
    transitions, or decorative motion.

## The canvas is read-only

The user can pan, zoom, select a node, and (right click) re-pin the view to the
runtime cursor. Nothing else. There is no drag-to-connect, no node creation, no
belief editing, and no frame manipulation — the GUI replays and projects, it never
writes cognition back. A selection only changes emphasis: it highlights the
selected node's dependency set and dims the rest, and that set is computed from the
projected edges, never from a guess about relatedness.

Selection emphasis and the current-node halo are the only two visual states that
change without new data arriving, and both are functions of state the runtime
supplied.

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

- Vertical regions (status band, canvas, panels, footer) are laid out sequentially
  and must never overlap. **`src/ShellLayout.h` is the single place that decides
  them** (`computeShellLayout`), from the window size, the font row
  (`ImGui::GetFrameHeightWithSpacing()`, so heights track the font zoom rather than
  a pixel constant), and which panels are open. `App.cpp` only draws into the
  rectangles it is given.
- The main content region is clamped to a minimum size. When the window is too
  narrow to hold the canvas beside its side panels, the panels move below it
  (`ShellLayout::stacked`) instead of overlapping: the canvas takes the full row
  width back and the panels share what is left, each scrolling internally. Every
  rectangle stays inside the work area — a rect outside it is the one layout
  outcome this section forbids outright.
- The user prompt window is a floating overlay opened by `:`/Enter and closed by
  Esc, independent of the main workspace layout. It is rendered as its own ImGui
  window; text is submitted with Cmd/Ctrl+Enter (Enter inserts a newline, so a
  multiline prompt is preserved end to end). It does not reserve any band in the
  layout, so it never overlaps another panel. The Frame pane's docked half opens
  and closes with it: the panel is the reading and the window is the reply, and
  opening one without the other would ask the user to answer a question they
  cannot see.
- The window enforces a minimum size via the platform's size-limit call, using the
  single-source constants `kMinWindowWidth`/`kMinWindowHeight` from
  `ShellLayout.h`. Resizing the window can never produce negative or
  out-of-work-area region rectangles.
- When adding a new panel, derive its size from the available work area and font
  metrics, respect the minimum sizes, add it to `PanelState`/`kDockedPanels` (or
  render it as a floating window if it has no docked rectangle), and verify the
  layout under small and narrow window sizes (e.g. `PI_GUI_SIZE=320x500`).
- The shell geometry is covered by `pi_gui_shell_layout_test`, which sweeps every
  panel combination against a range of window sizes rather than asserting a
  handful of hand-picked ones — a layout bug lives at one window size, and it is
  never the one that was typed into the test.
- **The canvas's own invariants** live in `docs/milestones.md` §6 and are enforced
  by `pi_gui_graph_projection_test` / `pi_gui_graph_geometry_test`: every node has
  a positive dot radius, no two dots overlap, row bands stack without overlapping,
  the Frame rail is above the first row, the outcome band is below every row, and
  every dot is inside the canvas extent. A dot has no width or height — hit
  testing and tooltips are RADIAL, so `GraphRect` is for bands only.
- **A row's separator does not make it a container.** The v1 canvas drew titled
  boxes around each group; the v7 canvas draws a rule and an ordinal label. Do not
  reintroduce region rectangles: `GraphStyle`'s region vocabulary was pruned in M5
  on purpose (§6.3).

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

# Run one headless test (binaries live under build/<preset>/)
./build/debug/pi_gui_domain_test
```

Notes:

- The whole suite is the gate: `ctest --preset debug` covers every layer, and the
  app binary is built and linked. Nothing is parked any more — the parked-target
  table that lived in `CMakeLists.txt` during the rewrite has been replaced by a
  record of where each v1 target went.
- `PIE_GUI_BUILD_APP` (a CMake cache variable, default ON) gates the `pie_gui`
  target. Turning it off builds and tests every headless layer without the app,
  which is what a machine without the platform SDK needs.

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
- Launch `./build/pie_gui` (default: `--live`, spawns the RPC child) and verify:
  no crash, no "Could not load font file" warning, and that the status band, the
  canvas, the open panels and the footer do not overlap. Open the panels
  (`Cmd/Ctrl+B`, `Cmd/Ctrl+T`, `:` for the Frame pane) and check them both beside
  the canvas and stacked.
- The demo mode is explicit: `./build/pie_gui --demo` injects the formal
  `DemoEvents.h` event stream instead of live mode. It has no runtime, so it
  correctly reports itself event-only and its trace correctly reports no
  telemetry — those two banners are the expected reading, not a failure.
- Test a narrow/small window (via `PI_GUI_SIZE=WxH`, e.g.
  `PI_GUI_SIZE=320x500 ./build/pie_gui`) to confirm the stacked fallback triggers
  instead of overlapping.
- The headless replay tool is the same pipeline without a window:
  `./build/debug/pie_gui_replay --replay <session.jsonl>` prints the derived model
  and the trace.

## Change checklist

- Read files in full before wide-ranging or cross-layer changes; do not rely on
  grep snippets for broad edits.
- Keep the model layer ImGui-free and the UI layer free of model mutation.
- After code (not doc) changes, build and run the whole headless suite
  (`ctest --preset debug`); iterate until it is green.
- Do not delete intended functionality without asking. Deleting a component is
  legitimate only when `docs/milestones.md` names it (M1 deleted the text
  workspace and the legacy standalone `gui/main.cpp`, M9 deleted `LayoutMetrics`,
  all called out there); otherwise ask first.
- Commit only files you changed in this session, with explicit paths, and use
  the repo commit-message format `{feat,fix,docs}[(ai,tui,agent,coding-agent)]`.

## Roadmap update rules

> **The roadmap is archived.** `docs/milestones.md` was the delivery plan for the
> v7 rewrite and is now the record of what was decided; `docs/archive/roadmap/`
> is the superseded roadmap. Do not record new scope in either, and do not treat
> anything under `docs/archive/` as a current requirement. New work belongs in a
> fresh plan document, not in an archived one.
