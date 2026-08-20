# Pie: Pi + Epistemology

PIE is an experimental coding-agent harness that makes the epistemic process itself an explicit runtime object. Rather than allowing one model invocation to freely mix hypothesis formation, investigation, interpretation and answer generation, PIE separates these cognitive operations and controls the information allowed to cross between them.

Pie 是一个以四阶段信念循环为核心、默认启用的可自我扩展编码智能体；其余 workspace 只提供通用支撑能力。
Pie is a self-extensible coding agent whose core is a default-enabled four-phase belief loop; the other workspaces only provide generic support.


- **四阶段信念循环（Four-phase belief loop）**：propose → execution → distill → finalAnswer，由 ROLE_SPECS/TRANSITION_STEERS 单一权威源驱动，默认启用（`enableBeliefSet` 默认为 true）。The four phases are driven by the single source of truth ROLE_SPECS/TRANSITION_STEERS and are enabled by default (`enableBeliefSet` defaults to true).
- **角色级隔离（Role-level isolation）**：每阶段的指令、工具面、模型选择与消息投影互相隔离，越权工具调用会被纠正。Each phase keeps its instruction, tool surface, model choice, and message projection isolated; out-of-surface tool calls are steered back.
- **证据水位线（Evidence watermark）**：原始证据只向蒸馏角色展示一次，随后被掩码，抑制上下文污染。Raw evidence is shown to the distill role exactly once, then masked, curbing context pollution.
- **执行租约（Execution lease）**：探测帧有工具轮次上限（ceil(Σ证据轮数×1.3)），先提醒后强制返回。Each probe frame has a tool-call budget (ceil(Σ evidence rounds × 1.3)); it nudges once, then forces the return.
- **结论门控（Conclusion gating）**：conclude 在开放信念或框架义务未清时被阻止，终局前执行一次性覆盖性反思。`conclude` is blocked while beliefs or framing obligations stay open; a one-time reflection runs before the terminal handoff.
- **终局快照（Terminal snapshot）**：finalAnswer 无工具，仅凭注入的 `<final_answer_context>` 信念快照作答。The finalAnswer role has no tools and answers solely from the injected `<final_answer_context>` belief snapshot.

Built on top of Pi: https://pi.dev

<p align="center">
  <a href="https://pi.dev">
    <img alt="pi logo" src="https://pi.dev/logo-auto.svg" width="128">
  </a>
</p>
<p align="center">
  <a href="https://discord.com/invite/3cU7Bz4UPx"><img alt="Discord" src="https://img.shields.io/badge/discord-community-5865F2?style=flat-square&logo=discord&logoColor=white" /></a>
  <a href="https://www.npmjs.com/package/@earendil-works/pi-coding-agent"><img alt="npm" src="https://img.shields.io/npm/v/@earendil-works/pi-coding-agent?style=flat-square" /></a>
</p>

> New issues and PRs from new contributors are auto-closed by default. Maintainers review auto-closed issues daily. See [CONTRIBUTING.md](CONTRIBUTING.md).

## 项目思想：四阶段信念循环（The project idea: the four-phase belief loop）

Pie 在本次迭代中的核心思想，是把"智能体如何回答问题"显式建模为一个四阶段信念循环（belief loop）。该状态机由 coding-agent 包（`packages/coding-agent`）实现并默认启用（`enableBeliefSet` 默认为 true，`declare_belief` 默认加入工具面）；其余工作区为它提供支撑能力（统一 LLM API、智能体运行时、终端 UI 等），而非各自运行同一状态机。四个阶段由 `packages/coding-agent/src/core/role-specs.ts` 中的 `ROLE_SPECS` 与 `TRANSITION_STEERS` 集中声明，提示词、工具面、模型选择与消息投影共享同一权威来源，不会各自漂移：

| 阶段 | 职责 |
|------|------|
| `propose`（提议） | 决定测试什么；提出信念（statement/expectation/evidence）与框架义务（framing obligation） |
| `execution`（执行） | 探测代码或产品，报告一句原始观察，不做分析 |
| `distill`（蒸馏） | 做预测误差蒸馏（prediction-error distillation）：先用既有信念解释观察，再只对残差更新信念 |
| `finalAnswer`（终答） | 依据注入的信念快照写出结论，无工具 |

信念按指称类型打标签：`[code]`（实现）、`[prod]`（产品行为或文档声明）、`[user]`（用户意图/需求）、`[convention]`（仓库惯例）。信念本身用中文书写。`/bs` 命令可查看当前信念集，`/thinking` 可设置思考级别。详见 [belief-loop-roles.md](packages/coding-agent/docs/belief-loop-roles.md)。

The core idea of Pie in this iteration is to model "how the agent answers a question" explicitly as a four-phase belief loop. The state machine is implemented and enabled by default in the coding-agent package (`packages/coding-agent`) — `enableBeliefSet` defaults to true and `declare_belief` is added to the default tool surface; the other workspaces provide supporting capabilities (unified LLM API, agent runtime, terminal UI, …) rather than each running the same state machine. The four phases are declared centrally by `ROLE_SPECS` and `TRANSITION_STEERS` in `packages/coding-agent/src/core/role-specs.ts`, so prompts, tool surfaces, model selection, and message projections share one authoritative source:

| Phase | Job |
|-------|-----|
| `propose` | Decides what to test; proposes beliefs (statement/expectation/evidence) and framing obligations |
| `execution` | Probes the code/product and reports one raw observation sentence, no analysis |
| `distill` | Performs prediction-error distillation: explains the observation with current beliefs first, then updates only on the residual |
| `finalAnswer` | Writes the conclusion from the injected belief snapshot; no tools |

Beliefs tag their referents by kind — `[code]` (implementation), `[prod]` (product behavior or documented claim), `[user]` (user intent/requirement), `[convention]` (repo idiom/naming/pattern) — and are written in Chinese. Use `/bs` to view the current belief set and `/thinking` to set the thinking level. See [belief-loop-roles.md](packages/coding-agent/docs/belief-loop-roles.md).


### 角色模型配置（Role model configuration）

信念循环允许为两个角色单独配置模型（仅在信念集启用时生效，`enableBeliefSet` 默认开启）：

- `executionModel`：execution（探测）角色使用的模型，仅对该角色覆盖会话模型，适合用便宜模型跑工具探测。
- `distillationModel`：distill（蒸馏/残差归纳）角色使用的模型，默认回退到 `defaultModel`，保证探测用便宜模型时蒸馏仍跑在强默认模型上。

propose 与 finalAnswer 始终使用会话主模型（`defaultModel`）。模型字符串使用 `provider/modelId` 格式，配置在全局 `~/.pi/agent/settings.json` 或项目 `.pi/settings.json`：

```json
{
  "defaultModel": "provider/defaultModel",
  "executionModel": "provider/probeModel",
  "distillationModel": "provider/strongModel"
}
```

回退链：`executionModel` 未配置或解析失败时，execution 回退到会话主模型；`distillationModel` 未配置时先回退 `defaultModel`，仍未解析再回退会话主模型——模型名解析失败时两者最终都使用会话主模型。

The belief loop lets two roles run on separately configured models (only while the belief set is enabled — `enableBeliefSet` defaults to true):

- `executionModel`: the model for the execution (probe) role; overrides the session model for that role only — use a cheaper model for probing.
- `distillationModel`: the model for the distill (prediction-error) role; defaults to `defaultModel` so distillation stays on the strong default model even when probing runs on a cheaper one.

The propose and finalAnswer roles always use the session's main model (`defaultModel`). Model strings use the `provider/modelId` format and live in the global `~/.pi/agent/settings.json` or the project `.pi/settings.json` (see the example above).

Fallbacks: if `executionModel` is unset or fails to resolve, execution falls back to the session's main model; if `distillationModel` is unset it falls back to `defaultModel` first — either way, an unresolvable model name ends up on the session's main model.

## 最小上手路径（Quick start）

Platform notes: [Windows](packages/coding-agent/docs/windows.md) | [Termux (Android)](packages/coding-agent/docs/termux.md) | [tmux](packages/coding-agent/docs/tmux.md) | [Terminal setup](packages/coding-agent/docs/terminal-setup.md) | [Shell aliases](packages/coding-agent/docs/shell-aliases.md).

## 完整工作区（Workspace）

| Package | Description（描述） |
|---------|---------------------|
| **[@earendil-works/pi-coding-agent](packages/coding-agent)** | 交互式编码智能体 CLI（Interactive coding agent CLI） |
| **[@earendil-works/pi-agent-core](packages/agent)** | 带工具调用与状态管理的智能体运行时（Agent runtime with tool calling and state management） |
| **[@earendil-works/pi-ai](packages/ai)** | 统一多提供商 LLM API：OpenAI、Anthropic、Google 等（Unified multi-provider LLM API） |
| **[@earendil-works/pi-tui](packages/tui)** | 带差分渲染的终端 UI 库（Terminal UI library with differential rendering） |
| **[@earendil-works/pi-telemetry](packages/telemetry)** | 供应商中立的遥测契约、参考适配器与类型化 schema（Vendor-neutral telemetry contracts and typed schemas） |
| **[@earendil-works/pi-client](packages/client)** | 远程 pi 会话的传输中立客户端（Transport-neutral client for remote pi sessions） |
| **[@earendil-works/pi-protocol](packages/protocol)** | 实验性 pi 协议的运行时中立 schema、CBOR 编码与字节流框架（Runtime-neutral schemas and CBOR framing for the pi protocol） |
| **[@earendil-works/pi-server](packages/server)** | 实验性 pi 服务器包（Experimental server package for pi） |
| **[@earendil-works/pi-evals](packages/evals)** | 基于模型的行为化 Pi 工作流评估（Behavioral, model-backed checks for Pi workflows） |
| **[@earendil-works/pi-session-backend-sqlite-node](packages/session-backends/sqlite-node)** | Agent 会话的 Node sqlite 会话后端（Node sqlite session backend） |

## 开发命令（Development commands）

```bash
npm install --ignore-scripts  # 安装全部依赖，不运行生命周期脚本
npm run build         # 刷新模型数据后构建所有包
npm run build:offline # 用既有模型数据离线重建
npm run check         # 检查：lint、格式、类型、固定依赖、shrinkwrap 等
./test.sh             # 运行测试（无 API 密钥时跳过依赖 LLM 的测试）
./pie.sh          # 从源码运行 pi（可在任意目录执行）
```
## License
MIT

<p align="center">
  <a href="https://pi.dev">pi.dev</a> domain graciously donated by
  <br /><br />
  <a href="https://exe.dev"><img src="packages/coding-agent/docs/images/exy.png" alt="Exy mascot" width="48" /><br />exe.dev</a>
</p>
