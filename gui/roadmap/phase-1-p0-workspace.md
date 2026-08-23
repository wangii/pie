# Phase 1 — P0 Workspace

The main three-lane cognitive workbench. This is the "must implement" set from
the spec's P0 priority.

## Purpose

Turn the belief-driven cognitive feedback loop into an inspectable, understandable
and interceptable work interface, framed around the `LoopFrame`.

## Spec sections

1 (Purpose), 2-3 (LoopFrame: definition, boundary, overall cognitive model),
5 (Main Window), 6 (Global Status Bar), 7 (Frame Cursor), 8 (Left Lane — Belief
Set), 9 (Selected Beliefs), 10 (Middle Lane — Cognitive Process), 11 (Planner
Section), 12 (Execution Lane), 13 (Distillation Section), 14 (Proposal Section),
15 (Proposal vs Belief Update), 16 (Feedback Loop Visualization), 17 (Current
Execution Locus), 18 (Current Frame Summary), 21 (Historical Frame Behavior),
22 (User Instruction Palette), 23 (Command Palette Role), 29 (Initial
Implementation Priority), 31 (Design Principle).

## Delivered artifacts

| P0 item | Implementation |
|---------|----------------|
| Main three-lane layout | `src/App.cpp` (BELIEF SET / COGNITIVE PROCESS / EXECUTION) |
| Belief list | `renderBeliefLane` |
| Selected belief highlighting | accent bar + SELECTED badge (from `frame.selectedBeliefs`) |
| Planner output | `renderCognitiveLane` PLAN section |
| Execution trace | `renderExecutionLane` |
| Tool call expand/collapse | `ImGui::TreeNode` per tool (tool/command/result/warning/status) |
| Distillation output | `renderCognitiveLane` DISTILLATION section |
| Proposal output | `renderCognitiveLane` PROPOSALS section (`+`/`~`/`-`/`?`) |
| Current frame indicator | `renderStatusBar` (Frame # + stage from cursor) |
| Current item indicator | `renderStatusBar` / `renderExecutionLane` CURRENT |
| Frame history navigator | `renderNavigator` |
| Historical frame inspection | `viewId` frame lookup + `back to current` |
| Cmd/Ctrl+T instruction box | `renderInstructionPalette` (Cmd/Ctrl+T on `ImGuiKey_T`) |

## Key elements

### Main window (spec 5)

Top: Global Status / Frame Navigator / User Instruction.
Middle: three lanes (BELIEF SET | COGNITIVE PROCESS | EXECUTION).
Bottom: Current Frame Summary. The three lanes are three readable views of the
same `LoopFrame`, not three subsystems.

### Layout invariant: components must not overlap

- Vertical regions (status bar, navigator, lanes, summary) are laid out
  sequentially and never overlap. Heights derive from
  `ImGui::GetFrameHeightWithSpacing()` (tracking font size), not hardcoded
  pixel constants.
- The lane region has a minimum height and the window a minimum lane width.
  Below the minimum width the three lanes stack vertically inside a scrollable
  region instead of overlapping.
- The instruction palette is NOT a floating overlay: it is a docked child band
  rendered between the navigator and the lanes. When open it reserves a vertical
  band (deducted from the lane region) so it never overlaps the status bar,
  navigator, lanes, or summary.
- The window enforces a minimum size via `glfwSetWindowSizeLimits`, using the
  single-source constants `kMinWindowWidth`/`kMinWindowHeight` from
  `LayoutMetrics.h`, so resizing can never yield negative or out-of-work-area
  regions.
- The geometry is computed by `LayoutMetrics` (`computeLayout`/`laneRects`) and
  covered by the headless `pi_gui_layout_test` (non-negative, contained, and
  pairwise-disjoint across supported window sizes).

### Font

All components use a single global font (Sarasa Term SC Nerd, Regular face via
`FontNo = 7`, CJK ranges) loaded once into the ImGui context; there are no
per-component `PushFont` calls.

### LoopFrame boundary (spec 2.2)

A frame is a complete epistemic transaction, not a tool call, LLM turn, execution
step, or time window. It can span multiple execution actions and closes only when
distillation produces a proposal.

### Selected beliefs (spec 9)

The plan's selected beliefs are visually distinct: accent left bar, SELECTED
badge, stronger background. Unselected open beliefs render normally, so the user
sees what the planner picked.

### Command palette role (spec 23)

The instruction palette is the entry point to a Universal Intervention
Interface. The implemented submit path (live mode) serializes the user
instruction as an RPC `prompt` command (`serializeInstructionCommand`), which is
not itself a belief mutation. Commands like
`inspect B42`, `explain frame 128`, `compare frame 124 128`, `replay frame 126`,
and `open execution E91` are forward-looking uses of that interface: the
instruction emission is in place (Phase 1), while the domain-specific compare
and replay handling is future work (Phase 2/3).

### Historical frame behavior (spec 21)

A closed frame is immutable. Later evidence does not modify it; instead a new
frame is opened that references the contradiction. This is what keeps the frame
history usable as provenance. (See also the Phase 2 navigation doc.)

### Proposal vs belief update (spec 15)

`Proposal != BeliefUpdate`. A frame produces proposals; belief management later
accepts/rejects/merges/supersedes them. In this GUI implementation:
`ProposalCreated` appends to `frame.proposals`; only `BeliefUpdated` mutates the
belief registry. Closed frames are immutable.

### Current execution locus (spec 17)

The current lane, stage, and item are explicit: `CURRENT` badge + accent
highlight derived from the model cursor, not a decorative timeline.

### Design principle (spec 31)

The information unit is Belief, LoopFrame, Execution Trajectory, Distillation,
Proposal — not tokens, turns, or tool calls. Clarity over visual novelty; no
animation.

## Dependency (from Phase 1 to Phase 2)

Phase 2 (navigation/inspection) reads the frame history and the P0 workspace to
add proposal-to-source jump, frame comparison, and provenance inspection.

## Verification

- `pi_gui` builds/links.
- GUI starts without crash (sustained event loop, empty stderr).
- Structural proof each P0 region has explicit render code.
- Model semantics proven by `pi_gui_model_test` (37/37) and
  `pi_gui_instruction_test` (8/8).
