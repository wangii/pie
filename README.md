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

# Pi Agent Harness（Pi 智能体框架）

Pi 是一个极简的终端编码智能体框架（agent harness），也是本项目自我扩展的编码智能体（self-extensible coding agent）的家园。它保持核心小巧，用 TypeScript 扩展（Extensions）、技能（Skills）、提示词模板（Prompt Templates）与主题（Themes）来适配你的工作流，而不是反过来。Pi 以交互式、打印/JSON、RPC 与 SDK 四种模式运行。

Pi is a minimal terminal coding agent harness and the home of our self-extensible coding agent. It stays small at the core and adapts to your workflow — not the other way around — through TypeScript extensions, skills, prompt templates, and themes. Pi runs in four modes: interactive, print/JSON, RPC for process integration, and an SDK for embedding in your own apps.

## 项目思想：四阶段信念循环（The project idea: the four-phase belief loop）

Pi 在本次迭代中的核心思想，是把"智能体如何回答问题"显式建模为一个四阶段信念循环（belief loop）。该状态机由 coding-agent 包（`packages/coding-agent`）实现并默认启用（`enableBeliefSet` 默认为 true，`declare_belief` 默认加入工具面）；其余工作区为它提供支撑能力（统一 LLM API、智能体运行时、终端 UI 等），而非各自运行同一状态机。四个阶段由 `packages/coding-agent/src/core/role-specs.ts` 中的 `ROLE_SPECS` 与 `TRANSITION_STEERS` 集中声明，提示词、工具面、模型选择与消息投影共享同一权威来源，不会各自漂移：

| 阶段 | 职责 |
|------|------|
| `propose`（提议） | 决定测试什么；提出信念（statement/expectation/evidence）与框架义务（framing obligation） |
| `execution`（执行） | 探测代码或产品，报告一句原始观察，不做分析 |
| `distill`（蒸馏） | 做预测误差蒸馏（prediction-error distillation）：先用既有信念解释观察，再只对残差更新信念 |
| `finalAnswer`（终答） | 依据注入的信念快照写出结论，无工具 |

信念按指称类型打标签：`[code]`（实现）、`[prod]`（产品行为或文档声明）、`[user]`（用户意图/需求）、`[convention]`（仓库惯例）。信念本身用中文书写。`/bs` 命令可查看当前信念集，`/thinking` 可设置思考级别。详见 [belief-loop-roles.md](packages/coding-agent/docs/belief-loop-roles.md)。

The core idea of Pi in this iteration is to model "how the agent answers a question" explicitly as a four-phase belief loop. The state machine is implemented and enabled by default in the coding-agent package (`packages/coding-agent`) — `enableBeliefSet` defaults to true and `declare_belief` is added to the default tool surface; the other workspaces provide supporting capabilities (unified LLM API, agent runtime, terminal UI, …) rather than each running the same state machine. The four phases are declared centrally by `ROLE_SPECS` and `TRANSITION_STEERS` in `packages/coding-agent/src/core/role-specs.ts`, so prompts, tool surfaces, model selection, and message projections share one authoritative source:

| Phase | Job |
|-------|-----|
| `propose` | Decides what to test; proposes beliefs (statement/expectation/evidence) and framing obligations |
| `execution` | Probes the code/product and reports one raw observation sentence, no analysis |
| `distill` | Performs prediction-error distillation: explains the observation with current beliefs first, then updates only on the residual |
| `finalAnswer` | Writes the conclusion from the injected belief snapshot; no tools |

Beliefs tag their referents by kind — `[code]` (implementation), `[prod]` (product behavior or documented claim), `[user]` (user intent/requirement), `[convention]` (repo idiom/naming/pattern) — and are written in Chinese. Use `/bs` to view the current belief set and `/thinking` to set the thinking level. See [belief-loop-roles.md](packages/coding-agent/docs/belief-loop-roles.md).

## 设计原则（Design principles）

Pi 刻意保持内核最小、攻击性可扩展，把决策权交给你，而不是反过来让你适配它。

Pi is aggressively extensible so it doesn't have to dictate your workflow. Features other tools bake in can be built with extensions, skills, or installed from third-party pi packages, keeping the core minimal:

- **无 MCP（No MCP）**：构建带 README 的 CLI 工具（见 Skills），或用扩展自行添加 MCP 支持。
- **无子代理（No sub-agents）**：通过 tmux 派生 Pi 实例，或用扩展自己实现。
- **无权限弹窗（No permission popups）**：在容器中运行，或用扩展按你的环境与安全要求实现确认流程。
- **无计划模式（No plan mode）**：把计划写进文件，或用扩展实现。
- **无内置待办（No built-in to-dos）**：用 TODO.md 文件，或用扩展实现。
- **无后台 bash（No background bash）**：使用 tmux，保持完全可观测、可直接交互。

## 最小上手路径（Quick start）

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

`--ignore-scripts` 在安装时禁用依赖生命周期脚本；正常 npm 安装不需要 Pi 的安装脚本。安装器替代方案：

```bash
curl -fsSL https://pi.dev/install.sh | sh
```

用 API 密钥认证：

```bash
export ANTHROPIC_API_KEY=sk-ant-...
pi
```

或使用你已有的订阅：

```bash
pi
/login  # 然后选择提供商
```

然后直接与 pi 对话即可。平台说明：[Windows](packages/coding-agent/docs/windows.md) | [Termux (Android)](packages/coding-agent/docs/termux.md) | [tmux](packages/coding-agent/docs/tmux.md) | [终端设置](packages/coding-agent/docs/terminal-setup.md) | [Shell 别名](packages/coding-agent/docs/shell-aliases.md)。

Install the CLI globally, then authenticate and talk to pi:

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
curl -fsSL https://pi.dev/install.sh | sh   # installer alternative
export ANTHROPIC_API_KEY=sk-ant-...          # or run `pi` then `/login` for a subscription
pi
```

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
./pi-test.sh          # 从源码运行 pi（可在任意目录执行）
```

```bash
npm install --ignore-scripts  # Install all dependencies without running lifecycle scripts
npm run build         # Refresh model data, then build all packages
npm run build:offline # Rebuild using existing model data without network access
npm run check         # Lint, format, type check, pinned deps, shrinkwrap
./test.sh             # Run tests (skips LLM-dependent tests without API keys)
./pi-test.sh          # Run pi from sources (can be run from any directory)
```

## 文档入口（Documentation）

- 编码智能体完整文档：[packages/coding-agent/README.md](packages/coding-agent/README.md) 与 [packages/coding-agent/docs/index.md](packages/coding-agent/docs/index.md)
- 快速上手：[quickstart.md](packages/coding-agent/docs/quickstart.md)
- 四阶段信念循环：[belief-loop-roles.md](packages/coding-agent/docs/belief-loop-roles.md)
- 提供商与模型：[providers.md](packages/coding-agent/docs/providers.md) · [models.md](packages/coding-agent/docs/models.md) · [custom-provider.md](packages/coding-agent/docs/custom-provider.md)
- 扩展与技能：[extensions.md](packages/coding-agent/docs/extensions.md) · [skills.md](packages/coding-agent/docs/skills.md)
- 会话与压缩：[sessions.md](packages/coding-agent/docs/sessions.md) · [compaction.md](packages/coding-agent/docs/compaction.md)
- 设置与环境变量：[settings.md](packages/coding-agent/docs/settings.md) · [environment-variables.md](packages/coding-agent/docs/environment-variables.md)
- 开发者指南：[development.md](packages/coding-agent/docs/development.md)

- Full coding-agent docs: [packages/coding-agent/README.md](packages/coding-agent/README.md) and [packages/coding-agent/docs/index.md](packages/coding-agent/docs/index.md)
- Quickstart: [quickstart.md](packages/coding-agent/docs/quickstart.md)
- The four-phase belief loop: [belief-loop-roles.md](packages/coding-agent/docs/belief-loop-roles.md)
- Providers & models: [providers.md](packages/coding-agent/docs/providers.md) · [models.md](packages/coding-agent/docs/models.md) · [custom-provider.md](packages/coding-agent/docs/custom-provider.md)
- Extensions & skills: [extensions.md](packages/coding-agent/docs/extensions.md) · [skills.md](packages/coding-agent/docs/skills.md)
- Sessions & compaction: [sessions.md](packages/coding-agent/docs/sessions.md) · [compaction.md](packages/coding-agent/docs/compaction.md)
- Settings & environment variables: [settings.md](packages/coding-agent/docs/settings.md) · [environment-variables.md](packages/coding-agent/docs/environment-variables.md)
- Developer guide: [development.md](packages/coding-agent/docs/development.md)

## 权限与容器化（Permissions & containerization）

Pi 不内置权限系统来限制文件系统、进程、网络或凭证访问。默认情况下，它以启动它的用户和进程的权限运行。如需更强的边界，请将 Pi 容器化或沙箱化。见 [packages/coding-agent/docs/containerization.md](packages/coding-agent/docs/containerization.md) 中的三种模式：Gondolin 扩展（宿主机保留 pi 与提供商认证，内置工具与 `!` 命令路由进本地 Linux 微虚拟机）、普通 Docker（整个 pi 进程在本地容器中运行）、OpenShell（整个 pi 进程在策略控制的沙箱中运行）。

Pi does not include a built-in permission system for restricting filesystem, process, network, or credential access. By default, it runs with the permissions of the user and process that launched it. To enforce stronger boundaries, containerize or sandbox Pi — see [packages/coding-agent/docs/containerization.md](packages/coding-agent/docs/containerization.md) for the Gondolin extension, plain Docker, and OpenShell patterns.

## 供应链加固（Supply-chain hardening）

我们把 npm 依赖变更当作需评审的代码变更对待。直接外部依赖固定精确版本；`.npmrc` 设置 `save-exact=true` 与 `min-release-age=2`；`package-lock.json` 是依赖的 ground truth，pre-commit 默认阻止锁文件提交（除非设置 `PI_ALLOW_LOCKFILE_CHANGE=1`）；发布的 CLI 包内含 `packages/coding-agent/npm-shrinkwrap.json` 以固定传递依赖；CI 用 `npm ci --ignore-scripts` 安装，并由定时工作流运行 `npm audit`。

We treat npm dependency changes as reviewed code changes: direct external deps are pinned to exact versions, `.npmrc` sets `save-exact=true` and `min-release-age=2`, `package-lock.json` is the dependency ground truth (pre-commit blocks lockfile commits unless `PI_ALLOW_LOCKFILE_CHANGE=1`), the published CLI ships `packages/coding-agent/npm-shrinkwrap.json` to pin transitive deps, and CI installs with `npm ci --ignore-scripts` plus scheduled `npm audit`.

## 分享你的 OSS 编码智能体会话（Share your OSS coding agent sessions）

如果你用 Pi 或其他编码智能体做开源工作，请分享你的会话。公开的 OSS 会话数据有助于用真实任务改进编码智能体。完整说明见[这篇 X 帖子](https://x.com/badlogicgames/status/2037811643774652911)；发布会话请使用 [`badlogic/pi-share-hf`](https://github.com/badlogic/pi-share-hf)，只需 Hugging Face 账号与 CLI。我定期发布自己的 `pi-mono` 工作会话：[badlogicgames/pi-mono on Hugging Face](https://huggingface.co/datasets/badlogicgames/pi-mono)。

If you use Pi or other coding agents for open source work, please share your sessions. Public OSS session data helps improve coding agents with real-world tasks. For the full explanation see [this post on X](https://x.com/badlogicgames/status/2037811643774652911); to publish sessions use [`badlogic/pi-share-hf`](https://github.com/badlogic/pi-share-hf). I regularly publish my own `pi-mono` sessions at [badlogicgames/pi-mono on Hugging Face](https://huggingface.co/datasets/badlogicgames/pi-mono).

## 贡献（Contributing）

贡献指南见 [CONTRIBUTING.md](CONTRIBUTING.md)，项目特定规则（面向人与智能体）见 [AGENTS.md](AGENTS.md)。Pi 的长期规划见 [RFCs](https://rfc.earendil.com/keyword/pi/)。

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines and [AGENTS.md](AGENTS.md) for project-specific rules (for both humans and agents). Longer term plans live in [RFCs](https://rfc.earendil.com/keyword/pi/).

## License

MIT

<p align="center">
  <a href="https://pi.dev">pi.dev</a> domain graciously donated by
  <br /><br />
  <a href="https://exe.dev"><img src="packages/coding-agent/docs/images/exy.png" alt="Exy mascot" width="48" /><br />exe.dev</a>
</p>
