# EpistemicView skeleton — the belief set

> **Status: superseded by implementation.** This is an aspirational design sketch written
> before the belief set was built. The implemented object is `Belief` in `belief-set.ts` —
> a free-text `statement` + `domain: "product" | "code" | "framing"` + `expectation` +
> `evidenceRounds`, with `status` derived from append-only provenance — not the
> `subject`/`relation`/`object` triplets and `EpistemicDecision`/`Anchor` types below.
> The companion `research-epistemic-vs-execution.md` and the `pie-agent-loop.ts` FSM it
> references no longer exist; see `framing-belief.md` for the current framing design.

Draft only. Defines the *shape* and the *derivation* of a belief set that gives the
epistemic loop a grip; it does not touch implementation. Companion to
`framing-belief.md` (the current framing design).

## The problem this fixes

The epistemic controller's input today is a 16-kind FSM menu over bookkeeping
primitives (`pie-agent-loop.ts:41-87`): `create/revise/replace/advance/falsify/kill_frame`,
`revise_anchor`, `explore`, `ask`, `decompose`, `authorize/continue/complete/unresolvable/escalate_action`,
`authorize_final`, `report_inability`. **None of these kinds is a belief about product or
code.** They are transitions between accounting objects, so the controller has nothing
concrete to maintain — it either over-thinks/rule-games or rubber-stamps.

The epistemic loop's actual job is three verbs:

1. **update-belief** — reclassify the current belief set from a new execution result;
2. **dispatch** — turn the belief set into the next execution episode (via Frame);
3. **ask** — clarify the user's ask when the belief set cannot advance.

This doc defines the object those verbs mutate: a **compiled set of live relational
assertions about product + code**, each with provenance and a status. Frame becomes the
bridge that dispatches one belief into execution; Observation becomes one belief's settled
status. Neither was ever "the current model of the world" — the belief set is.

## Hard constraint: no new primitive

The belief set is a **compiled view** over the existing append-only delta log. It is not a
new persisted entry type and not a knowledge graph. Referents drift across an investigation
("Auth" is a module on turn 1, a middleware on turn 10), so the durable layer stays
*frozen statements + provenance*, and the belief set is *re-derived* each restore — exactly
the "only a current belief exists in the compiled projection" rule from Phase 11.5.

---

## Types

### 1. One belief

```ts
export type BeliefStatus = "proposed" | "supported" | "refuted" | "superseded";

/** product = the product's observable behavior; code = the code's behavior/structure. */
export type BeliefDomain = "product" | "code";

export interface BeliefProvenance {
  /** Entry id (frame_revision or observation) that first asserted this belief. */
  assertedBy: string;
  /** sourceEventIds of execution results that support it (empty while `proposed`). */
  supportedBy: string[];
  /** sourceEventIds of execution results that contradict it. */
  refutedBy?: string[];
  /** id of the belief that superseded this one (a `refined` replacement). */
  supersededBy?: string;
}

/**
 * One live cognition about product or code: a named relation assertion.
 * subject/relation/object are AUTHOR-DECLARED at proposal time (not extracted later —
 * extraction drifts), so they never need re-resolution.
 */
export interface EpistemicBelief {
  /** Compiled id: the entry id that asserted it. Stable, not persisted separately. */
  id: string;
  subject: string;   // one identifiable referent (symbol/type/file/module/config/product behavior)
  relation: string;  // free predicate, not a closed enum
  object: string;    // one identifiable referent or named result
  domain: BeliefDomain;
  /** Frozen rendered form: `${subject} ${relation} ${object}`. */
  statement: string;
  status: BeliefStatus;
  provenance: BeliefProvenance;
  /** Frame revision this belief was proposed under, if any. */
  frameRevisionEntryId?: string;
}
```

### 2. The view

```ts
export interface EpistemicView {
  /** Normative success semantics. NOT a belief — this is what counts as done. */
  anchor?: Anchor;
  /** Full belief set: everything currently believed about product + code, refuted negatives included. */
  beliefs: readonly EpistemicBelief[];
  /**
   * Beliefs still actionable for dispatch: status ∈ {proposed, supported}, not
   * superseded, and (if proposed) still under a live admissible Frame.
   */
  openBeliefs: readonly EpistemicBelief[];
  /** The current admissible commitment = the open belief currently under test (the bridge). */
  frame?: Frame;
  /** The active execution episode, if any. */
  action?: Action;
  /** Established evidence (kept for provenance parity; each is also a belief). */
  observations?: readonly Observation[];
}
```

`observations` and `beliefs` are two projections of the same deltas: `observations` is the
"established fact" view, `beliefs` the "current belief state" view. A material Observation
*is* a belief whose status just became `supported`/`refuted`.

### 3. The epistemic decision (16 kinds → 3 verbs + 2 terminals)

```ts
export type EpistemicDecision =
  | { verb: "update_belief"; delta: BeliefDelta }
  | { verb: "dispatch"; delta: DispatchDelta }
  | { verb: "ask"; question: string }
  | { verb: "final"; reason: string }          // Anchor satisfied by openBeliefs
  | { verb: "inability"; reason: string };     // execution-level terminal, not epistemic

type BeliefDelta =
  | { op: "propose"; subject: string; relation: string; object: string; domain: BeliefDomain }
  | { op: "support"; beliefId: string; sourceEventIds: string[] }
  | { op: "refute"; beliefId: string; sourceEventIds: string[] }
  | { op: "refine"; beliefId: string; replacement: { subject: string; relation: string; object: string; domain: BeliefDomain } }
  | { op: "retract"; beliefId: string; reason: string };

type DispatchDelta =
  | { op: "test"; beliefId: string; expectation: string; horizon: number }  // → frame + authorize_action
  | { op: "explore"; intent: string; completionCondition: string; expectation: string } // pre-Frame, Anchor-bound
  | { op: "continue"; actionContractId: string };
```

The 16 kinds become **harness-computed outcomes**. The model declares a belief delta or a
dispatch; the harness decides which `frame_transition` / `observation` / `action_start` to
append. `decompose` folds into `test`; `advance_frame` is a `dispatch.continue` under an
unchanged belief; `report_inability` is `verb: "inability"`. The model's vocabulary shrinks
from 16 bookkeeping shapes to 5 verbs, each carrying *content* (a named belief), not a
bookkeeping instruction.

---

## Compilation outline (`compileEpistemicView(entries)`)

Walk the active branch once, chronological. The belief map is keyed by the asserting entry
id (`frame_revision.id` or `observation.id`).

```
anchor, frame, action = undefined
beliefs = Map<id, EpistemicBelief>
observations = []

for entry in entries:
  anchor_revision:
      anchor = anchorFromEntry(entry)                      // normative, never a belief

  frame_revision:
      frame = frameFromEntry(entry)
      beliefId = entry.id
      beliefs[beliefId] = {
          id: entry.id,
          subject/relation/object/domain: entry.subject/.../domain   // author-declared
              (legacy logs → undefined; statement still renders)
          statement: entry.statement,
          status: "proposed",
          provenance: { assertedBy: entry.id, supportedBy: [] },
          frameRevisionEntryId: entry.id,
      }
      // a revision of the SAME frameId refines the prior revision's belief:
      //   priorBelief.status = "superseded"; priorBelief.provenance.supersededBy = entry.id

  frame_transition:
      falsified → beliefs[entry.revisionEntryId].status = "refuted";
                  beliefs[...].provenance.refutedBy = [entry.sourceEventId]
      replaced | died | expired → frame = undefined
          // PROCESS outcomes only. They do NOT change belief truth status — see rule 1.

  action_start:       action = actionFromEntry(entry)
  action_transition:  action = undefined                     // process; belief change via observation only

  observation:
      observations.push(observationFromEntry(entry))
      sign → status:
          confirmed → "supported"   (provenance.supportedBy = entry.sourceEventIds)
          refuted   → "refuted"     (provenance.refutedBy   = entry.sourceEventIds)
          refined   → "supported",  and the frame belief it adjudicated → "superseded"
      beliefs[entry.id] = { ...from entry, status, provenance, domain: entry.domain ?? inferred }

  message:            ignored                                   // execution-local

openBeliefs = beliefs where status ∈ {proposed, supported}
              AND provenance.supersededBy == undefined
              AND (status != proposed OR frame is still live/admissible)

return { anchor, beliefs: [...beliefs], openBeliefs, frame, action, observations }
```

### Derivation rules

1. **Lease exhaustion never refutes.** `expired`/`died`/`replaced` mark a Frame dead; they do
   not change any belief's truth status. Only `falsified` or a material Observation with
   `refuted`/`refined` does. This is Phase 11.3 restated at the belief level: "we did not
   prove X in time" is execution provenance, not a refutation.
2. **Status is monotone in one direction.** `proposed → supported | refuted → superseded`.
   A frame *revision* produces a *new* belief that supersedes the old one; it never resets
   status back to `proposed`.
3. **`refined` = supersede.** The frame's proposed belief is superseded by the Observation's
   refined statement, which itself is `supported`.
4. **`domain` is author-declared at proposal time**, never inferred later. It rides as an
   optional field on `FrameRevisionEntry` / `ObservationEntry` — a *field addition*, not a new
   primitive. Legacy entries degrade to `{ statement, domain: "code" }` with no structured ref.
5. **`openBeliefs` excludes the settled.** Refuted, superseded, and proposed-under-a-dead-Frame
   beliefs are history, not dispatch candidates.

---

## The grip: `validateBelief` (mechanical rule, not prompt text)

The definition becomes binding only through a validator the model faces. Reuse the Phase 11.5
validator and add one check — the subject must be a *product/code referent*, not a probe:

```
validateBelief(subject, relation, object, domain):
  - subject, relation, object non-empty after trim
  - domain ∈ { product, code }
  - statement must not be an experiment record ("Expectation:…"), a process record
    ("we did not prove…", "budget exhausted", "the action completed"), or a bare
    confirmation token            // reuse _validateObservationStatement
  - subject must not be a tool invocation: reject probe-shaped subjects
    (command names, scripts/*.sh, *.test, "npm test", "grep -r", …)
    // direction only — Phase 7 showed regexes leak; back this with ablation + gate, per 11.8
```

This is what would have stopped the `attractive cache` trace: its Frame statements were
"npm test will print PASS" / "restart-probe.sh will emit RESULT: failure persists" —
subjects are *probes*, not referents, so `validateBelief` rejects them and forces a real
belief ("authorizationSource(1003,1001) returns stale-replica", `domain: "code"`).

Worked example of the two domains:

```text
"authorizationSource(1003,1001) returns stale-replica"   → domain: "code"
"worker-local cache survives logout for 30s"              → domain: "product"
```

---

## What changes vs today, and what does not

**Changes**

- The epistemic call's object becomes a belief set with a status machine, not a 16-kind menu.
- The decision vocabulary collapses to 3 verbs (+ 2 terminals); the 16 kinds become
  harness-computed append outcomes.
- Frame is demoted to the dispatch bridge (belief → execution); Observation is a belief's
  settled status, not a separate knowledge surface.
- `domain: product | code` makes both halves of the user's "product + code" explicit.

**Does not change**

- Append-only log; raw tool results stay execution-local; no new primitive, no graph.
- Anchor stays normative (success semantics), distinct from beliefs.
- Compiler stays deterministic and LLM-free; belief *proposals* come from the model,
  belief *materialization* from the harness.
