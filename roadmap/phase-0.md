# Phase 0 — Own the context boundary

**Initial phase. Do not add epistemic primitives.** Use an empty epistemic state and establish a stable non-compaction baseline first.

### 0.1 Characterize the current path

- Trace a new prompt, tool continuation, retry, resume, branch switch, manual compaction, threshold compaction, and overflow recovery from persisted entry to provider payload.
- Add a test seam that captures the exact model-facing messages without using a real provider.
- Record baseline task behavior, visible token count, raw-log completeness, and overflow behavior.
- Identify every path that can insert a compaction or branch summary into model context.

**Deliverable:** boundary tests that fail if an unobserved path bypasses context compilation.

### 0.2 Introduce `ContextCompiler`

Define one explicit compiler interface whose inputs include:

- raw events or an uncompressed branch view;
- current epistemic state, empty in Phase 0;
- model context budget;
- request/runtime data needed to produce valid provider messages.

Its output should include the selected `AgentMessage[]` and a machine-readable selection manifest for diagnostics and evaluation. The baseline compiler must be deterministic and must not call an LLM.

Invoke it once for each model request, immediately before provider conversion. Persistence and session reconstruction must not consume compiler output as canonical history.

### 0.3 Separate persistence from projection

- Continue append-oriented persistence of all raw events.
- Restore sessions from raw entries rather than from a previously compiled projection.
- Keep event identities stable enough for later provenance references.
- Ensure retries and branches select raw events without deleting the abandoned trace.
- Treat existing compaction and branch-summary entries as historical artifacts, not privileged cognition.

**Invariant test:** reducing the model-visible context must not reduce the raw event count.

### 0.4 Remove default compaction from Pie cognition

- Disable threshold and overflow paths that summarize history for subsequent model requests.
- Ensure manual compaction cannot silently restore Pi's narrative context policy.
- Replace overflow recovery with a stricter compiler budget and projection reduction.
- Bound retries. If the minimum valid projection still overflows, return an actionable error instead of entering a summarize/retry loop.
- Preserve any archival information needed to inspect sessions; removing model-facing compaction does not require deleting provenance.

### 0.5 Implement the baseline projection

The first compiler uses only structural selection, not semantic epistemic objects:

1. required system/runtime content;
2. the current user request or continuation;
3. the newest coherent execution window that fits;
4. tool calls paired with their results;
5. older raw events only while budget remains.

Do not split provider-required message/tool-call groups. Do not generate a prose account of omitted events. The selection manifest may identify omitted event ranges, but it is diagnostic metadata and is not model cognition.

### 0.6 Make resume and recovery reliable

Cover:

- normal multi-turn sessions;
- repeated tool failures and retries;
- process restart and session resume;
- branch navigation;
- queued steering and follow-up messages;
- model changes with different context windows;
- repeated forced overflow under a small synthetic budget.

### 0.7 Establish the baseline gate

Phase 0 passes only when:

- ordinary short tasks behave like Pi when the full transcript fits;
- every model request is compiler-produced;
- forced budget pressure drops selected events without creating a narrative summary;
- raw logs remain complete and resumable after projection reduction;
- provider message ordering and tool-call/result constraints remain valid;
- overflow recovery is bounded and does not loop;
- compiler inputs, selected event IDs, omissions, and token estimates are observable;
- no Anchor, Frame, Action, or Observation implementation exists.

Compare task completion, model-visible tokens, execution-noise ratio, overflow recovery, and information loss against unmodified Pi. If the baseline materially regresses and a simple projection policy cannot repair it, stop before Phase 1.
