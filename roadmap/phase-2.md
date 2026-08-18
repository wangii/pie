# Phase 2 — Add Frame

A Frame is a finite-lived investigation commitment, not a structured scratchpad.

### Scope

- Give each Frame stable identity and an explicit version.
- Require a falsifier that states what result makes the Frame inadmissible.
- Require a finite horizon after which the Frame must be reconsidered even if failure classification remains ambiguous.
- Make replacement, revision, death, falsification, and expiry visible state transitions.
- Prevent silent mutation or reinterpretation of the falsifier and horizon.
- Compile only the current admissible Frame by default.
- Do not add confidence scores, claim graphs, question graphs, or hidden subtypes.

The horizon is an epistemic timeout, analogous to a distributed-system timeout. It need not diagnose why progress stopped; it guarantees that the current investigation commitment cannot hang indefinitely.

### Evaluation

For the same state and task, compare action selection with and without the Frame. Use cases where competing explanations authorize different next actions, including cases where relevant evidence is initially mistaken for routine execution failure.

Measure:

- change in next-action distribution;
- recovery cost from an incorrect Frame;
- persistence after contradictory evidence;
- whether falsifiers terminate Frames rather than trigger repeated reinterpretation;
- whether horizons force bounded reconsideration under ambiguous failure;
- context and state-management overhead.

**Gate:** retain Frame only if it causally improves useful action selection and incorrect commitments terminate under their falsifier or horizon. Otherwise remove it rather than enriching its schema.
