# Pie: Pi + Epistemology

PIE is an experimental coding-agent harness that makes task-local epistemic state explicit.
It separates choosing uncertainty, contacting the world, adjudicating evidence, and writing the
answer so evidence can change the agent's working model without turning the investigation into a
workflow ceremony.

Pie 是一个显式维护任务内暂时认识的编码智能体。它分离“选择值得减少的不确定性、接触 world、依据证据更新认识、生成最终回答”，但不把 routing、workflow、coverage 或 ontology bookkeeping 伪装成 belief。

Built on top of Pi: https://pi.dev

## Belief loop

```text
BELIEF STATE
    |
    v
PROPOSE / NEXT
选择当前最值得减少的 uncertainty
    |
    v
EXECUTION
与 world 接触，返回 raw evidence
    |
    v
DISTILL
adjudicate existing beliefs, identify residual, refine epistemic state
    |
    +---- unresolved material uncertainty ---> PROPOSE
    |
    +---- epistemically sufficient ----------> FINAL REPORT
```

The cognitive roles are:

| role | responsibility |
|---|---|
| `propose` | choose the coherent experiment with the highest expected task-relevant information gain relative to cost, risk, side effects, and dependencies |
| `execution` | observe or minimally intervene, then report every materially distinct raw observation with sources or command results |
| `distill` | first adjudicate tested beliefs from all relevant evidence, then inspect residual for missing beliefs or reframing |
| `finalReport` | synthesize settled evidence, preserve uncertainty, and answer the user |

Routing, leases, and domain plans are implementation helpers, not cognitive phases. The former
planner role was removed because selecting `Batch: ids` added no evidence; beliefs proposed together
now define one coherent execution episode.

核心规则：

1. Beliefs are provisional and task-local.
2. Beliefs describe evidence-revisable relations about code, product behavior, user requirements,
   or relevant conventions.
3. Names are provisional pointers, not ontological commitments. Internal structure is refined only
   when evidence makes it task-relevant.
4. Execution observes or intervenes; distill owns epistemic interpretation.
5. Evidence settles existing beliefs. Residual exposes missing beliefs or reframing.
6. Do not investigate uncertainty that cannot materially change the task outcome.

Mandatory scope discovery, atomicity proofs, referent type tags, framing beliefs, coverage
reflection, and conjunction-completeness checks have been removed. Review consistency checks remain
heuristics used when evidence suggests drift or hidden scope.

`/bs` displays the current belief set. `pie.beliefLang` controls the language used for belief
content.

See [PIE-specific documentation](docs/README.md). General CLI, SDK, extension, provider, RPC, and
TUI documentation is shared with [`packages/coding-agent/docs`](../coding-agent/docs/).

## Fast path

`route_task` records routing in a separate `RoutingSet`; routing is not a belief. Fast path requires
epistemic closure: no unresolved belief may remain that could materially change the action or its
safety. Operational simplicity alone is insufficient.

Fast-path terminal ownership is unique:

```text
fast-path execution -> user
```

Execution writes the user answer. A hidden distillation summary preserves completed actions and
blockers for continuity, but distill and finalReport do not write duplicate terminal answers. A
failed fast path returns to propose.

## Role model configuration

Pie-specific settings live in global `~/.pi/agent/settings-pie.json` or project
`.pi/settings-pie.json`; project fields override global fields.

```json
{
  "defaultModel": "provider/strongModel",
  "defaultThinkingLevel": "medium",
  "executionModel": "provider/probeModel",
  "executionThinkingLevel": "minimal",
  "distillationModel": "provider/strongModel",
  "distillationThinkingLevel": "low",
  "fastPathModel": "provider/fastModel",
  "fastPathThinkingLevel": "max",
  "beliefLang": "English"
}
```

- `defaultModel`: propose and finalReport. Final synthesis deliberately does not use the cheap
  fast-path model.
- `executionModel`: normal evidence gathering.
- `distillationModel`: evidence adjudication and world-model refinement; defaults to
  `defaultModel`.
- `fastPathModel`: epistemically closed direct execution only.
- `distillationThinkingLevel`: defaults to `low`.

Unset role models fall back to the session model. Fast-path summaries use `distillationModel` when
configured; otherwise they use the global default model setting or the session model.

## Development commands

```bash
npm install --ignore-scripts
npm run check
./test.sh
./pie.sh
```

Pie is a source fork of Pi and intentionally shares `~/.pi/agent`, project `.pi/` state, sessions,
credentials, and `PI_*` environment variables. Pie is private and is run from source with
`./pie.sh`.

## License

MIT
