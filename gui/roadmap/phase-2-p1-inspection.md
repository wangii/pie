# Phase 2 — P1 Inspection / Navigation

Post-P0 inspection and navigation capabilities. The spec lists these as P1
("subsequently implement"), so they are not required to satisfy the P0 scope.

## Spec sections

19 (Frame Navigator), 20 (Frame History Semantics), 30 (Key UX Questions —
Q7 "why did the belief state form"), plus the P1 list under §29.

## Scope

The P1 list from spec §29:

- belief filtering — **implemented** (open/selected/changed/all combo in the
  belief lane)
- frame search — **implemented** (case-insensitive `frameMatchesQuery` over frame display fields, wired into the navigator)
- jump from proposal -> source trajectory — **not implemented**
- jump from belief -> originating frame — **not implemented**
- jump from execution -> planner intent — **not implemented**
- compare frames — **not implemented**
- inspect provenance — partially present (belief `sourceFrames` are displayed;
  full provenance inspection/traversal is not wired)

## Status

Partial. `renderBeliefLane` provides the `open|selected|changed|all` filter and
the `source: #frame` provenance line; `renderNavigator` now filters frames by a
case-insensitive substring query (`frameMatchesQuery`). The remaining P1 items
(jumps, comparison, deep provenance) are future work.

## Frame History Semantics (spec 20)

The navigator timeline represents epistemic transaction history, not execution
event history. Recommended markers per frame:

```text
#124  #125  #126  #127  #128
 ✓     +     !     ✗     ●     current
```

(The GUI marks closed frames with `✓`/`+`/`~`/`✗`/`!` and the active frame with
`●`, derived from `LoopFrame::history`.)

## Historical frame behavior (spec 21)

A closed frame is immutable. Later evidence does not modify it; instead a new
frame is opened that references the contradiction.

## Dependency

Phase 2 depends on Phase 1 (frame history + P0 workspace). It is not a phase-gate
for P0.
