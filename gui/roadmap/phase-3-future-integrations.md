# Phase 3 — Future Integrations

Deferred / future-scope items. The spec marks these as "Not Current Priority"
or as future considerations, so they are not part of the P0 or P1 deliverable.
This document tracks them so the current scope is explicit.

## Spec sections

24-26 (Architecture / Tech Stack / Boundary future options), 29 (Not Current
Priority), 30 (Key UX Questions).

## Deferred items (from spec §29 "Not Current Priority")

- animation
- fancy transitions
- highly customized visual effects
- elaborate graph layout
- dashboard-style metrics
- decorative visualization

Current principle: **clarity > visual novelty**.

## Future technology considerations (spec §25)

- SDL3 / SDL_GPU (replacing or supplementing the current GLFW + OpenGL3 backend)
- A thin Objective-C++ / AppKit shell for native menus, file dialogs, window
  integration, and system shortcuts (core workspace stays ImGui)

## Future transport options (spec §26)

- MessagePack
- protobuf

## Future scope rationale

These are deferred because the spec's P0/P1 priorities and the "Not Current
Priority" list explicitly push them out of the initial deliverable. Nothing in
Phase 0 or Phase 1 depends on them.

## Status

Not started. Tracked here so future work does not silently expand the P0/P1
definition.
