# Phase 1 — Add Anchor only

Introduce one durable statement of task success semantics.

### Scope

- Create, persist, restore, and explicitly revise an Anchor.
- Always retain the current Anchor in compiled context.
- Keep all other selection behavior identical to Phase 0.
- Record Anchor revisions with provenance; do not silently overwrite them.

### Evaluation

Run matched long-horizon tasks with Anchor enabled and disabled. Include tasks where a useful local proxy can diverge from the original request.

Measure:

- final-task success;
- goal-drift incidents;
- Anchor token cost;
- unnecessary resistance to legitimate user goal changes.

**Gate:** retain Anchor only if it measurably reduces goal drift without a material task-completion regression. Otherwise remove it and reconsider the hypothesis.
