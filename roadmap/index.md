# Pie Roadmap

## Objective

Pie forks Pi at the context boundary. Pi remains the execution chassis for models, streaming, authentication, tools, the TUI, and raw session persistence. Pie owns the policy that decides what the model sees.

The target relation is:

```text
raw event log + epistemic state + context budget
                         ↓
                  ContextCompiler
                         ↓
                 model-facing context
```

The transcript is provenance, not canonical cognitive state. Context overflow must reduce a projection, not rewrite history into a narrative summary.

## Architectural contracts

These contracts apply to every phase:

1. **One context owner.** Every model request passes through Pie's `ContextCompiler`.
2. **Raw history remains raw.** User messages, assistant messages, tool calls, tool results, errors, retries, and temporary experiments remain recoverable from the event log.
3. **Compiled context is derived.** Compiler output is not appended back to the raw log as if it happened.
4. **No implicit visibility.** Persisted events enter model context only when selected by the compiler.
5. **Budget pressure changes projection.** It does not mutate canonical state or invoke transcript summarization.
6. **Execution remains independent.** Provider, streaming, authentication, tools, and TUI behavior should change only where the context boundary requires it.
7. **The ontology stays bounded.** The only candidate epistemic primitives are Anchor, Frame, Action, and Observation. They are introduced one at a time.
8. **Each primitive must survive ablation.** A primitive is retained only if enabling it causes a measurable improvement over the immediately preceding phase.
9. **Boundary mistakes are bounded.** The runtime need not classify every failure correctly as execution noise or epistemic evidence. It must prevent a mistaken classification or commitment from persisting indefinitely.
10. **Freedom narrows down the hierarchy.** `Anchor → Frame → Action → execution attempts → world result` is not a thinking/execution split. Each layer may adapt only within the success and completion semantics fixed above it.

Once the relevant primitives exist, bounded control transfer is mandatory: a Frame's falsifier or horizon must force epistemic reconsideration, and an Action that cannot meet its frozen completion condition must return `UNRESOLVABLE`. The weak operating assumption is only that a local epistemic intent can be frozen for one finite execution episode; perfect advance knowledge of why an attempt failed is not required.

## Current boundary to replace

The existing request path is broadly:

```text
session entries
    ↓
compaction-aware session projection
    ↓
AgentMessage[] / transformContext
    ↓
provider messages
```

Auto-compaction is also part of overflow and threshold recovery. This means a transform that receives already-compacted messages is not sufficient: Pie must compile from raw persisted events and its own durable state before default compaction semantics have determined model-visible cognition.

Initial code landmarks to validate during implementation:

- `packages/agent/src/agent-loop.ts`: final message transformation and provider request boundary.
- `packages/agent/src/harness/session/context.ts`: session-entry projection.
- `packages/coding-agent/src/core/agent-session.ts`: persistence, threshold/overflow recovery, and compaction orchestration.
- `packages/coding-agent/src/core/session-manager.ts`: coding-agent session context reconstruction.

These are investigation starting points, not a required final module layout.

## Phases

| Phase | Document | Status |
| --- | --- | --- |
| 0 — Own the context boundary | [phase-0.md](phase-0.md) | baseline (no independent gate check recorded) |
| 1 — Add Anchor only | [phase-1.md](phase-1.md) | — |
| 2 — Add Frame | [phase-2.md](phase-2.md) | — |
| 3 — Add Action episodes | [phase-3.md](phase-3.md) | gate PASS |
| 4 — Add Observation | [phase-4.md](phase-4.md) | gate PASS |
| 5 — Integrate only surviving primitives | [phase-5.md](phase-5.md) | integration gate PASS |
| 6 — Deliver a usable Pie application | [phase-6.md](phase-6.md) | IN PROGRESS |
| 7 — Restore Frame and Action semantic separation | [phase-7.md](phase-7.md) | REOPENED |
| 8 — Derive leases from serial evidence rounds | [phase-8.md](phase-8.md) | IN PROGRESS |
| 9 — Preserve failure evidence across terminal frames | [phase-9.md](phase-9.md) | IN PROGRESS |
| 10 — Route execution feedback through durable Observation | [phase-10.md](phase-10.md) | IN PROGRESS (design revised) |
| 11 — Separate epistemic knowledge from execution information | [phase-11.md](phase-11.md) | PROPOSED (design) |

Phases are sequential gates: each is introduced one at a time and must survive ablation against the immediately preceding phase before the next begins.

## Evaluation matrix

Every phase compares the new system with the immediately preceding phase and, where relevant, stock Pi.

| Dimension | Primary measure |
| --- | --- |
| Task outcome | solved tasks / attempted tasks |
| Context efficiency | model-visible tokens / solved task |
| Execution noise | execution-noise tokens / visible tokens |
| Goal drift | behavior inconsistent with original success semantics |
| Frame persistence | epistemic steps an invalid Frame survives |
| Recovery cost | tokens, tool calls, and epistemic steps after a wrong branch |
| Cognitive thrashing | LLM replans for one unchanged investigation intent |
| Context interference | irrelevant old narrative or execution affects current action |
| Provenance | selected state traceable to exact raw events |

Use deterministic faux-provider tests for context and persistence invariants. Use fixed task fixtures for behavioral comparisons. Real-model evaluation must record model, settings, prompt, budget, compiler version, and run variance.

## Out of scope until a gate requires reconsideration

- More primitives than Anchor, Frame, Action, and Observation.
- Claim, question, dependency, confidence, belief-score, or knowledge-graph schemas.
- LLM-generated transcript summaries inside `ContextCompiler`.
- RAG or vector search as a substitute for context ownership.
- Rebuilding providers, tools, authentication, streaming, or the TUI.
- Treating an extension prototype as the final architecture. Extensions may supply comparative evidence, but Pie's cognition policy belongs at the forked context boundary.

## Project-level stop conditions

Stop and reassess when any of these occurs:

1. The non-compaction baseline remains materially worse after simple projection-policy fixes.
2. Anchor does not measurably reduce goal drift.
3. Frame does not causally improve action selection.
4. Action episodes save context but materially reduce debugging adaptability.
5. Observation requires increasingly task-specific schemas.
6. The compiler evolves into another mechanism for narratively summarizing the transcript.

A failed gate is a valid research result. Do not mask it by adding ontology or exceptions.
