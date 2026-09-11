# Framing beliefs (removed)

> **Status: removed.** This file records why `domain: "framing"` no longer exists.

PIE previously represented statements such as “the final answer must establish X” as beliefs.
That mixed acceptance criteria and workflow control with evidence-revisable claims about the
world. It also created framing-discharge links, coverage obligations, and fast-path handoff
protocols that models could satisfy ceremonially without improving the answer.

The current epistemic boundary is narrower:

> A belief is a provisional, evidence-revisable relational judgment about code, product behavior,
> a user requirement, or a relevant convention. Its record is retained across tasks as history;
> the task's focus — which beliefs it acts on — is the task-local part.

The original user request is already stored as the task `Target`. It supplies the objective used by
propose and finalReport; it is not copied into the belief set as an obligation. `conclude` remains
an explicit control action, gated by proposed world beliefs *in the task's declared focus* (plus one
cheap check for an obvious material uncertainty) and required to record what was actually delivered
and how it was verified. The focus slice carries the task's own scope; it is control metadata, so
narrowing it drops a question from the task's attention without inventing a belief to represent the
narrowing.

Routing is likewise separate control metadata in `RoutingSet`, written through `route_task` rather
than `declare_belief`.

## Reframing without framing beliefs

Reframing remains possible, but it comes from world evidence:

1. Distill adjudicates the tested beliefs using all relevant evidence.
2. It inspects the residual for observations the current belief set does not explain.
3. If the residual reveals a materially different mechanism or referent boundary, distill refines
   or splits the relevant world belief and may create directly implied candidate beliefs.
4. Propose decides whether the resulting uncertainty can materially change the task outcome.

This keeps the useful behavior—changing the model when evidence reveals that “one bug” is actually
two—without persisting completion checklists as epistemic primitives.
