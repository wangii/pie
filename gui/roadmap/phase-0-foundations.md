# Phase 0 — Foundations / Boundary

Contains the GUI architecture boundary, the technology stack decision, the
harness/GUI contract, and the runtime data model that Phase 1 builds on.

## Purpose

Establish the boundary between the PIE harness runtime and the native GUI, and
the event/state interface between them. The GUI is a viewer/interactor; it does
not do planning, distillation, belief update, or stage inference.

## Spec sections

4 (GUI Layer Responsibilities), 24 (GUI Architecture), 25 (Technology Stack),
26 (Harness / GUI Boundary), 27 (Suggested Runtime Data Model), 28 (Frame Status).

## Delivered artifacts

| Artifact | File | Status |
|----------|------|--------|
| NativeGuiModel (runtime data model + event ingestion) | `src/Model.h`, `src/Model.cpp` | Implemented |
| Runtime client (payload transport, spawn CLI in RPC mode) | `src/App.cpp` | Implemented |
| Event contract (parser branches, fixture, model mutations) | `src/Model.cpp`, `src/DemoEvents.h` | Implemented |
| Instruction command serialization + pipe test | `src/InstructionCmd.h`, `src/InstructionCmd.test.cpp` | Implemented |
| CMake target boundary (model lib / UI app / tests) | `CMakeLists.txt` | Implemented |

## Key elements

### GUI responsibilities (spec 4)

The GUI is responsible for: displaying the current belief state; showing the
active loop frame; rendering the planner/execution/distillation feedback flow;
marking the current execution position; supporting historical loop-frame
inspection; showing execution tool calls and output; accepting user instruction
input; and allowing inspection of a belief, frame, trajectory, or proposal.

The GUI is NOT responsible for: doing planning, distillation, or belief update;
deciding the current execution stage; or maintaining epistemic semantics. All
of that state is explicitly provided by the harness runtime via the event
stream.

### Architecture (spec 24)

```text
PIE Harness Runtime
      |  event / state stream
      v
Native GUI Model
      |  BeliefStoreView, ActiveLoopFrame, FrameHistory, ExecutionTrace, FrameCursor
      v
Dear ImGui
      v
GLFW / OpenGL (current); SDL3/SDL_GPU (future)
```

### Technology stack (spec 25)

- Language: C++20.
- GUI: Dear ImGui (v1.92.9).
- ImGui platform backend: on macOS the official `imgui_impl_osx` backend; on
  other platforms the `glfw` backend.
- ImGui renderer: on macOS `imgui_impl_metal`; on other platforms `imgui_impl_opengl3`.
- Window / input: on macOS a native NSWindow + MTKView; on other platforms GLFW.
- Build: CMake (FetchContent vendors GLFW 3.4 and ImGui). Platform sources live
  in `src/plats/` (macOS Metal backend, GLFW backend), selected by APPLE.
- macOS is the primary target; Windows/Linux are kept cross-platform via the
  conditional compile path.

### Font asset and FreeType (foundational)

The global UI font is the Sarasa Term SC Nerd collection, a TrueType Collection
(TTC) with 10 faces, so it requires FreeType: `find_package(Freetype)` is linked into the ImGui
backend, `imgui_freetype.cpp` is compiled in, and `IMGUI_ENABLE_FREETYPE` is
defined. The font is downloaded at build time from a pinned
Sarasa-Term-SC-Nerd v2.3.1 release and placed next to `pie_gui`.

Implementation notes for building with FreeType:

- `gui/CMakeLists.txt` adds `imgui_freetype.cpp` to `imgui_backend`, defines
  `IMGUI_ENABLE_FREETYPE`, and links `Freetype::Freetype`.
- `gui/src/App.cpp` loads `fontCfg.FontNo = 7` (Regular; face 0 is Bold) with
  `GetGlyphRangesChineseFull()` into the single ImGui context.
- The layout heights are derived from `ImGui::GetFrameHeightWithSpacing()` and
  the lanes clamp to a minimum width/height.

## Dependency (from Phase 0 to Phase 1)

### Harness / GUI boundary (spec 26)

The GUI and the harness communicate through an explicit event/state interface.
First version uses JSONL over stdin/stdout (see the runtime client). The GUI
defaults to `--live` (spawns the RPC child; the ⌘T pane submits instructions, with
  Cmd/Ctrl+Enter).
`--demo` instead applies the `DemoEvents.h` fixture via `applyLine` on the
non-live path, whose recognized
event types are `FrameOpened`, `BeliefsSelected`, `PlanProduced`,
`ExecutionStarted`, `ToolCalled`, `ToolReturned`, `ExecutionCompleted`,
`DistillationStarted`, `DistillationProduced`, `ProposalCreated`, `FrameClosed`,
`BeliefUpdated`, `CursorChanged`. In live (`--live`) mode `applyRpcLine` adapts
the real RPC `AgentSessionEvent` stream into the same model (agent/turn →
`LoopFrame`, `tool_execution_start/end` → trajectory, message text → summary),
without fabricating Belief/Proposal/Distillation events the runtime does not
emit. MessagePack/protobuf are future transport options.

### Runtime data model (spec 27) and frame status (spec 28)

`LoopFrame` carries id, status/stage, selected beliefs, plan, execution
trajectory, distillation, proposals, and open/close timestamps. `FrameStage`
covers PLANNING / EXECUTING / DISTILLING / PROPOSING / CLOSED. `FrameStatus`
additionally includes OPEN and FAILED.

## Dependency (from Phase 0 to Phase 1)

Phase 1 consumes the runtime data model and the runtime-client boundary. The
`pi_gui_model` library is the model layer, and `pie_gui` is the UI app that links
it, the ImGui backend, and OpenGL.

## Verification

- `cmake --build .` succeeds.
- `pi_gui_model_test` (headless) passes 37/37 assertions.
- `pi_gui_instruction_test` (serialization + pipe write) passes 8/8.
- `ctest` passes 2/2.
