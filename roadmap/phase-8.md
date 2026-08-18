# Phase 8 — Derive leases from serial evidence rounds

**Status: IN PROGRESS.** The minimal production path now replaces bare-number Frame horizon estimation with an inspectable model-response lease derived from provisional Action contracts and their serial evidence rounds. This phase changes planning and lease calculation only; it does not add a persisted epistemic primitive or a task-specific decision-tree schema.

### Problem to correct

Phase 7 asks the controller to estimate one `horizon` number while the runtime counts every completed model response under the Frame. Real dogfood showed that values such as 18 or 20 are not grounded in the work's serial structure: authorization, execution, and terminal adjudication all consume the same lease, while tool calls that can run in parallel need not consume separate model responses.

A larger fixed default only makes the guess more conservative. It does not establish why the lease is sufficient or whether an Action is small enough to remain a finite episode.

### 8.1 Plan provisional Action contracts before calculating the Frame lease

When creating or revising a Frame, the controller must enumerate the currently expected bounded Actions. Each candidate contains only the existing Action contract plus transient budgeting metadata:

```text
intent
completionCondition
expectedEvidenceRounds
budgetReason
```

The list is a provisional lease calculation, not canonical cognitive state and not a mandatory execution plan. It is compiler/controller data and must not be persisted as a fifth primitive. New evidence may cause later Actions to be replaced or omitted through normal epistemic reconsideration.

The model no longer supplies a bare Frame `horizon`. The harness validates the candidates and derives the persisted numeric horizon.

### 8.2 Define one serial evidence round

One serial evidence round is:

```text
model chooses the next evidence-producing probe
        ↓
independent permitted tool calls execute, concurrently where safe
        ↓
model reads the finalized world results and decides what follows
```

Tool-call count is not evidence-round count. Multiple independent `read`, `grep`, `find`, or `ls` calls emitted in one response count as one round. A later round is justified only when its probe depends on a result unavailable before the preceding round.

Examples:

```text
Locate a symbol with rg
→ read the paths returned by rg
→ establish the exact definition
```

This contains serial dependence. By contrast, reading four already-known files is one round when the existing tool contracts permit those reads to run together.

### 8.3 Constrain Action estimates structurally

For automatic production Actions:

- `expectedEvidenceRounds` must be a bounded positive integer, initially `1–5`;
- `budgetReason` must name the serial dependency that requires each later round;
- task complexity, uncertainty, file count, or tool-call count alone cannot justify a larger estimate;
- independent read-only probes must be batched when their execution contracts permit it;
- if required source locations are unknown, authorize a discovery-only Action before a source-reading or comparison Action;
- an Action requiring more than five serial evidence rounds must narrow its completion condition or split into multiple Actions;
- malformed, circular, bundled, or unjustified estimates receive bounded repair and must not silently receive the maximum;
- the estimate is an upper lease, not a quota: establishing the completion condition early returns control immediately;
- exhausting the accepted estimate cannot automatically extend the Action. Control returns as `UNRESOLVABLE` or through explicit escalation/reconsideration.

The harness must validate the number and explanation together. It must not rely on the LLM's number alone.

### 8.4 Derive Frame horizon deterministically

After accepting the provisional Action contracts, the harness computes the Frame lease from explicit costs:

```text
Frame horizon
  = initial/renewal control allowance
  + Σ(Action authorization
      + expected serial evidence rounds
      + terminal Action adjudication)
  + final Frame adjudication allowance
```

The exact constants are runtime policy and must be surfaced in diagnostics. The calculation must use the same response-counting semantics as `restoreEpistemicState`; no hidden request class may consume the lease without appearing in the formula.

The harness must clamp the number of planned Actions and the resulting total lease. If the total exceeds the configured Frame bound, the controller must narrow the Frame commitment or choose a smaller first set of Actions rather than truncate the derived lease silently.

Persist only the resulting existing Frame `horizon`. Record the transient calculation in compiler diagnostics or a non-cognitive selection manifest so a dogfood trace can explain, for example:

```text
Frame responses 9/17
budget: 3 Actions; evidence rounds 2 + 3 + 2; control allowance 10
```

### 8.5 Keep Action decision points generic

Every finalized world-result boundary uses the same runtime decision:

```text
completion condition established?
  ├─ yes                 → complete_action
  ├─ impossible under current constraints
  │                     → unresolvable_action
  ├─ challenges Frame or Anchor
  │                     → escalate_action
  └─ no, with justified serial dependency remaining
                        → continue_action
```

This generic decision point is required, but task-specific decision points are not persisted on the Action. Do not add decision graphs, question graphs, branches, confidence values, or planned-result schemas. The transient `budgetReason` explains only why another model/world interaction is sequentially necessary.

### 8.6 Diagnostics and recovery

Expose, without making the TUI a context owner:

- expected and consumed evidence rounds for the active Action;
- the accepted serial-dependency explanation;
- provisional Action count used for the current Frame lease;
- derived authorization, execution, terminal-adjudication, and Frame-adjudication costs;
- unused lease returned by early Action completion;
- the exact reason an estimate was rejected, split, exhausted, or reconsidered.

Restart and branch restoration continue from persisted Frame and Action state. They must never recreate or execute a transient plan automatically. If the original calculation is unavailable in a legacy session, preserve its numeric horizon and mark the derivation as unavailable rather than inventing one.

### 8.7 Deterministic coverage

Add faux-provider tests proving:

- the controller cannot directly choose an arbitrary Frame horizon;
- the same Action contracts and round estimates always derive the same horizon;
- three parallel reads consume one evidence round, while a read whose path depends on a preceding search requires another;
- unsupported large estimates are rejected rather than clamped silently;
- an Action estimated above five rounds must split or narrow its completion condition;
- early completion returns control without consuming the remaining estimate;
- estimate exhaustion returns bounded control without automatic renewal;
- recalculating a renewed Frame creates an append-only Frame revision with provenance;
- all execution, control, and final-answer responses charged by runtime restoration are represented in the lease formula;
- restart and branch behavior preserve canonical state without treating transient plans as events;
- no new persisted primitive or task-specific decision graph is introduced.

### Implementation checkpoint — 2026-08-13

**Status: IN PROGRESS. The minimal production path is implemented; the natural-task calibration gate has not been run.**

Implemented in this checkpoint:

- production Frame decisions now provide provisional Action contracts with `expectedEvidenceRounds` and a serial-dependency `budgetReason`; direct model-supplied horizons are rejected;
- the harness validates `1–5` rounds, rejects complexity/tool-count justifications and oversized estimates without silent clamping, and derives the persisted existing Frame horizon from explicit model-response costs;
- Action authorization must match an unused provisional contract exactly, parallel tool calls in one assistant response consume one evidence round, exhaustion returns bounded control, and early completion reports unused rounds;
- the transient calculation remains process-local rather than a persisted primitive; restart preserves the numeric horizon and reports derivation unavailable instead of recreating a plan;
- `/pie` and the persistent status expose model-response lease costs, expected/consumed rounds, serial dependency, and unused rounds;
- focused Phase 5–8 persistence, compiler-boundary, production-loop, Frame, and Action coverage passes 53/53, diagnostics UI coverage passes, and `npm run check` passes.

The Phase 8 gate remains open pending matched `deepseek/deepseek-v4-flash` natural-task evaluation and estimate calibration by buckets 1–5. Phase 7's required clean real-model rerun also remains independently blocked by the recorded account-balance failure.

### 8.8 Evaluation

Use natural coding tasks with unknown source locations, already-known independent files, dependent runtime probes, mutation, and verification. Compare Phase 8 against Phase 7 using:

- Frame expiry before explicit adjudication;
- Action `UNRESOLVABLE` caused only by budget exhaustion;
- estimated versus consumed serial evidence rounds;
- unnecessary model responses used for progress narration;
- safe read-only tool-call parallelism;
- number of sequential Actions completed per Frame;
- token, latency, and cost overhead;
- task success and debugging adaptability.

Include calibration reporting by estimate bucket (`1` through `5`) rather than only aggregate error. A system that avoids expiry by always requesting five rounds fails the calibration objective even if tasks complete.

### Phase 8 gate

Phase 8 passes only when:

- production Frame leases are deterministically derived from accepted Action contracts and serial evidence rounds rather than an LLM-supplied total;
- every additional estimated round has an inspectable serial dependency;
- safe parallel probes do not inflate the estimate;
- oversized Actions are split or narrowed instead of receiving arbitrary larger budgets;
- early completion, estimate exhaustion, escalation, and Frame reconsideration remain distinct bounded paths;
- natural-task evaluation materially reduces budget-caused `UNRESOLVABLE` and accidental Frame expiry without material task-completion regression;
- estimates are calibrated rather than converging on the maximum;
- persistence, branching, compiler ownership, raw provenance, and legacy-session behavior remain valid;
- no new epistemic primitive, decision graph, task-specific ontology, old-loop fallback, or transcript summary is added.
