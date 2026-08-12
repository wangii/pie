# PIE extension

# Proposal: Fork Pi at the Context Boundary

## Building an Epistemic-State-Driven Coding Agent Harness

## 1. Motivation

当前 coding agent harness 的基本结构通常是：

```text
conversation / tool history
        ↓
compaction / summarization
        ↓
LLM context
        ↓
LLM
        ↓
tool call
        ↓
tool result
        └──────────────→ history
```

这一结构隐含了一个非常强的假设：

> **agent 的 cognition 主要存在于 transcript 中；context management 的主要问题是如何保存、压缩和恢复 transcript。**

Pi 也是以这一模式工作：随着 trajectory 增长，旧内容经过 compaction，形成一个面向后续执行的 narrative summary，再与近期 history 一起构成下一轮 LLM context。

此前已经尝试过两条 extension 路线：

* Observation
* Reframe

实践效果均不理想。

一个重要原因可能不是 Observation / Reframe 本身无效，而是：

> **extension 正在与 Pi 已有的 compaction epistemology 争夺 context ownership。**

extension 可以增加结构化对象，但 Pi 默认 compaction 仍会不断把 trajectory 重构为诸如：

```text
Goal
Progress
Key Decisions
Next Steps
Critical Context
```

这样的 narrative。

因此即使 extension 保存了：

```text
Frame F7
Observation O12
```

下一次 LLM 实际面对的 cognition substrate 仍然主要可能是：

```text
"我们已经调查了 X，
决定继续 Y，
下一步做 Z。"
```

这会使显式 epistemic objects 降级为 transcript 旁边的 annotation。

本项目因此调整方向：

> **不再从 Pi extension 层增加新的 cognition mechanism；而是在 context boundary 处 fork Pi，接管 context lifecycle。**

Pi 保留为 execution chassis。

我们重新定义：

```text
what is state
what is history
what enters context
```

---

# 2. Core Hypothesis

本项目的核心假设不是：

> 更好的 compaction 可以提高 coding agent 能力。

而是：

> **conversation transcript 不应该是 agent cognition 的 canonical state。**

新的基本关系应当是：

```text
Raw Event Log
       +
Epistemic State
       ↓
Context Compiler
       ↓
LLM Context
```

即：

[
C_t = Compile(S_t, H_t, B)
]

其中：

* (S_t)：当前 epistemic state；
* (H_t)：raw event/history log；
* (B)：本轮 context budget；
* (C_t)：真正发送给模型的 working context。

而不是：

[
C_t = Compact(H_{\le t})
]

核心转换是：

> **从 history compression 转向 state-to-context compilation。**

---

# 3. Architectural Principle

整个项目最重要的一条原则：

> **The transcript is an event log, not the agent's mind.**

Raw transcript 可以完整保存：

```text
user messages
assistant outputs
tool calls
tool results
execution errors
retries
temporary experiments
```

但它不自动拥有进入下一轮 LLM context 的权利。

它是 archive / provenance。

真正决定模型当前看到什么的是：

```text
ContextCompiler
```

---

# 4. System Boundary

Pi 不需要被整体重写。

保留 Pi 已经成熟的部分：

```text
Pi
────────────────────────────
model provider abstraction
streaming
authentication
read
write
edit
bash
terminal UI
tool implementation
raw event/session persistence
```

新的 experimental core 负责：

```text
Experimental Core
────────────────────────────
epistemic state
context construction
context budgeting
epistemic loop
action episodes
observation escalation
```

整体结构：

```text
┌─────────────────────────────────┐
│      Experimental Core          │
│                                 │
│ EpistemicState                  │
│ ContextCompiler                 │
│ EpistemicLoop                   │
│ ActionEpisodeController         │
└────────────────┬────────────────┘
                 │
                 │ compiled context
                 ▼
┌─────────────────────────────────┐
│              Pi                 │
│                                 │
│ Model / streaming               │
│ read / edit / write / bash      │
│ providers / auth                │
│ TUI                             │
│ raw persistence                 │
└─────────────────────────────────┘
```

明确不再让以下机制决定 model-facing cognition：

```text
Pi default compaction semantics
Pi default summary schema
transcript-as-primary-context
```

---

# 5. Minimal Epistemic State

第一阶段不要继续扩展 ontology。

只保留四个 candidate primitives：

```text
Anchor
Frame
Action
Observation
```

但更重要的是：

> **第一阶段甚至不立即启用全部四个。**

应该首先证明新的 context architecture 本身能够稳定运行。

完整 epistemic state 最终可以表示为：

[
S_t =
(
G,
\mathcal F_t,
\mathcal A_t,
\mathcal O_t
)
]

其中：

```text
G     Anchor

F     versioned Frames

A     epistemic Actions

O     durable Observations
```

Raw execution trace 不属于该 state。

---

# 6. Raw Log vs Epistemic State

必须严格区分：

## Raw Event Log

完整记录实际发生过什么：

```text
user request
assistant output
tool call
tool result
wrong grep command
retry
patch failure
compiler output
temporary test
...
```

性质：

```text
append-oriented
high volume
provenance source
debuggable
not normally model-visible
```

---

## Epistemic State

只记录 investigation state 中真正有持续意义的对象：

```text
Anchor
Frames
Actions
Observations
```

性质：

```text
low volume
durable identity
versioned
context-addressable
used for cognition
```

二者不能再混为：

```text
"everything useful eventually becomes chat history"
```

---

# 7. ContextCompiler

ContextCompiler 是本项目第一优先级组件。

其职责不是 summarize history，而是：

> **根据当前 epistemic state 和 context budget，为这一轮 cognition 构造一个有目的的 working view。**

基本接口：

```python
compile_context(
    epistemic_state,
    raw_log,
    context_budget,
) -> AgentMessages
```

第一版甚至可以非常朴素：

```text
ANCHOR

CURRENT FRAME

RELEVANT OBSERVATIONS

CURRENT ACTION

RECENT EXECUTION WINDOW
```

例如：

```text
[ANCHOR]
Logout 后旧 session 不得继续授权。

[CURRENT FRAME]
Worker-local state may survive the logout boundary.

[OBSERVATIONS]
O17: middleware reads worker-local cache.
O21: logout deletes Redis session.
O23: worker cache TTL is 30 seconds.

[CURRENT ACTION]
Determine whether logout invalidates worker-local cache.

[RECENT EXECUTION]
...only the last small window necessary to continue...
```

---

# 8. Context Budgeting

当 context budget 不够时，不再触发：

```text
summarize everything old
```

而应该缩小 projection。

一个可能的优先级：

```text
1. Anchor                 never drop

2. Current Frame          normally retain

3. Current Action         retain

4. Frame-relevant Observations

5. Anchor-relevant Observations

6. Recent execution details

7. Previous Frames

8. Old Actions

9. unrelated historical execution
```

因此：

```text
context overflow
```

触发的是：

```text
projection reduction
```

而不是：

```text
historical narrative rewriting
```

Canonical state 保持不变。

---

# 9. Why Fork Rather Than Extension

这一选择不是因为 extension 开发困难。

而是因为实验对象本身就是：

> **谁拥有 context construction policy。**

如果仍然采用：

```text
Pi compaction
       +
epistemic extension
```

则实际 architecture 是：

```text
canonical-ish transcript
        ↓
Pi cognition policy
        ↓
extension modification
```

extension 永远处于 guest position。

而我们真正需要实验的是：

```text
epistemic state
        ↓
our cognition policy
        ↓
LLM
```

因此 context lifecycle 属于必须 fork 的 architecture boundary。

这与普通 feature extension 根本不同。

---

# 10. Development Strategy

开发顺序应当与此前完全相反。

## Phase 0 — Fork at the Context Boundary

目标：

> 不增加任何新的 epistemic primitive。

完成：

```text
disable/bypass default compaction

preserve raw Pi session/event log

introduce ContextCompiler

construct model context ourselves
```

此时：

```text
EpistemicState = {}
```

ContextCompiler 可以简单从 recent history 中选择内容。

目的只是证明：

> 一个不依赖 Pi default compaction 的 coding agent 能稳定运行。

这是新的 baseline。

---

## Phase 1 — Baseline Context Compiler

不要立刻做 Frame。

先比较：

```text
Pi default agent
```

与：

```text
Pi fork
+
our ContextCompiler
+
no epistemic objects
```

测试：

* task completion；
* token usage；
* long-session stability；
* repeated context overflow；
* recovery after tool noise；
* information loss。

如果这个 baseline 本身明显更差，应优先解决 context ownership，而不是继续加 epistemic machinery。

---

## Phase 2 — Add Anchor Only

状态变成：

```text
EpistemicState {
    Anchor
}
```

测试：

> 单独让 task success semantics 成为 durable state，是否能减少 goal drift？

不增加 Frame。

Context：

```text
Anchor
+
selected raw/recent context
```

重点测试长任务中的：

```text
original task
→ local proxy
→ proxy optimization
→ original goal forgotten
```

---

## Phase 3 — Add Frame

状态：

```text
Anchor
Frame
```

Frame 必须是显式、有限寿命的 epistemic commitment，而不是 descriptive scratchpad。

第一阶段先不追求复杂 frame mechanics。

只要求：

```text
Frame has identity
Frame is versioned
Frame cannot silently mutate
Frame can die / expire
```

测试核心只有一个：

> Frame 是否对下一步 Action distribution 产生可测 causal effect？

如果没有：

```text
Frame = metadata
```

应停止继续复杂化。

---

## Phase 4 — Introduce Action Episodes

把：

```text
tool call
```

与：

```text
epistemic Action
```

分开。

例如：

```text
Action:
determine whether logout invalidates
worker-local authorization state
```

下面可能运行：

```text
rg
read
wrong command
retry
run test
repair
run again
```

这些属于 action-local loop。

目标是：

> 把高频 execution noise 从 epistemic loop 和 LLM-visible history 中移出去。

---

## Phase 5 — Add Observation

Observation 只有在 execution result：

```text
changes Frame admissibility
or
changes Anchor satisfaction
```

时才 materialize。

例如：

```text
Observation:
worker-local cache survives logout
```

而不是：

```text
Observation:
bash returned exit code 2
```

Observation 必须保留 raw provenance。

Frame 可以 project observations，但不能拥有、删除或重写 Observation identity。

---

# 11. Two-Loop Architecture

最终系统运行在两个时间尺度上。

## Epistemic Loop

```text
Anchor
  ↓
Frame
  ↓
Action
  ↓
Observation
  ↓
Frame survives / dies / changes
```

处理：

```text
Why are we doing this?
What do we currently believe?
What would change our mind?
Did we solve the original task?
```

---

## Action-Local Loop

```text
Action
 ↓
attempt
 ↓
error
 ↓
repair
 ↓
attempt
 ↓
result
```

处理：

```text
How do I competently execute
the already-authorized Action?
```

普通 execution failure 不进入 epistemic loop。

只有当 result 揭示关于 repository / runtime / current Frame 的信息时才 escalation。

核心原则：

> **Epistemic loop owns commitments.
> Action-local loop owns competence.**

## Why an Imperfect Boundary Is Sufficient

两层 loop 不依赖系统准确判断每一次失败究竟是 execution problem，还是 epistemic evidence。这样的分类在真实任务中通常无法立即完成。架构真正需要保证的是：

> **一次错误的边界判断不能无限期持续。**

这不是简单的“thinking vs execution”分工，而是一个逐层收窄自由度的层级：

```text
Anchor
  ↓ defines success
Frame
  ↓ authorizes an investigation
Action
  ↓ freezes local intent and completion
Execution attempts
  ↓ interact with
World result
```

每一层只能在上层给定的约束内调整。Action-local loop 可以更换工具、命令、路径和执行策略，但不能自行改写 Action 的目标。

为此，Frame 有两个硬约束：

```text
falsifier   什么结果会使当前 Frame 不再成立
horizon     最多允许当前承诺持续到何时
```

`falsifier` 防止系统把任何反证都重新解释成支持当前 Frame；`horizon` 防止调查无限延长。即使某个具有 epistemic meaning 的失败暂时被误判为普通 execution noise，Frame 也必须在 falsifier 被触发或 horizon 到达时接受重新审查。

Action 则需要一个最小 contract：

```text
intent
completion_condition
```

执行期间可以自由修复局部方法，但 `completion_condition` 保持冻结。执行 loop 不能为了宣称成功而降低或替换完成标准。如果在当前约束下无法满足它，Action 必须返回：

```text
UNRESOLVABLE
```

并把控制权交还 epistemic loop，而不是继续无限重试或暗中 reframing。

因此这里所需的假设很弱：

> **只需在一个有限的 execution episode 内，暂时冻结一个局部 epistemic intent。**

系统不必预先知道失败属于哪一层。现实持续拒绝当前执行路径时，`UNRESOLVABLE`、falsifier 或 horizon 会迫使控制权上移，重新评估 Frame 或 Action。

`horizon` 因而类似 distributed system 中的 timeout：timeout 不需要诊断请求为何没有完成，只需要保证一个 commitment 不能永久挂起。它定义了 action-local loop 与 epistemic loop 之间的有界等待，使边界分类可以不完美，但错误不能无界存活。

---

# 12. Minimal Runtime Sketch

```python
def run(request):

    state = EpistemicState()
    raw_log = RawLog()

    state.anchor = maybe_create_anchor(request)

    while not done(state):

        context = ContextCompiler.compile(
            state=state,
            raw_log=raw_log,
            budget=model_context_budget,
        )

        decision = llm(context)

        if decision.creates_frame:
            state.add_frame(decision.frame)

        if decision.proposes_action:

            action = state.authorize(decision.action)

            result = execute_action_episode(
                action,
                raw_log,
            )

            if is_epistemically_material(
                result,
                state.anchor,
                state.current_frame,
            ):
                observation = materialize_observation(
                    action,
                    result,
                )

                state.add_observation(observation)
                state.adjudicate(observation)

    return final_answer(state)
```

这里最重要的是：

```text
raw_log
```

从未自动变成：

```text
next_context
```

所有 model-visible context 都必须通过：

```text
ContextCompiler
```

---

# 13. Research Questions

第一阶段不研究“大而全”的 epistemic architecture。

只回答几个非常基础的问题。

### Q1 — Context ownership

不使用 transcript compaction，而采用 state-to-context compilation，能否稳定支撑 coding agent？

---

### Q2 — Anchor

显式 Anchor 是否减少 long-horizon goal drift？

---

### Q3 — Frame

Frame 是否真正改变 Agent behavior？

必须使用 counterfactual 检验：

```text
with Frame
vs
without Frame
```

如果 Action distribution 没有明显区别，Frame 不具有 causal value。

---

### Q4 — Action episodes

把多个 tool calls 封装成一次 epistemic Action 是否减少：

```text
context pollution
cognitive thrashing
tool-call-level replanning
```

---

### Q5 — Observation

独立、durable Observation 是否能让错误 Frame 更容易被推翻，而不是被后续 summary/narrative 吞掉？

---

# 14. Evaluation

除了 SWE-Bench 等最终成功率，更应关注过程指标。

## Context efficiency

```text
model-visible tokens / solved task
```

以及：

```text
execution-noise tokens / total context
```

---

## Goal drift

最终行为与原始 Anchor 的偏离程度。

---

## Frame persistence

错误 Frame 在出现反证后继续存活多少 epistemic steps。

---

## Recovery cost

进入错误 investigation branch 后：

```text
tokens
tool calls
epistemic steps
```

需要多少才能恢复。

---

## Cognitive thrashing

同一个稳定 investigation intent 是否反复发生：

```text
LLM
tool
LLM
tool
LLM
tool
```

式低层重新规划。

---

## Context interference

旧 narrative、历史 summary 或低层 execution noise 是否持续影响与当前 Frame 无关的 reasoning。

---

# 15. Primary Risks

## Risk 1 — ContextCompiler 重新变成另一种 compactor

如果最后写成：

```text
LLM summarize relevant history
```

那么只是重新实现 Pi compaction。

必须坚持：

> projection from durable state, not summary of transcript.

---

## Risk 2 — Epistemic state information loss

Raw transcript 中可能存在尚未被提升为 Observation、但未来重要的信息。

因此 raw log 必须永久可回溯。

Epistemic state 不等于完整 truth database。

---

## Risk 3 — Frame becomes structured scratchpad

Frame 只是：

```text
LLM thinks normally
→ writes nice Frame
→ continues normally
```

则没有 causal value。

---

## Risk 4 — Over-engineering

如果为了 ContextCompiler 很快加入：

```text
claims
questions
hypotheses
dependencies
confidence
belief scores
```

系统会重新变成手工 symbolic architecture。

第一阶段必须坚持四个对象上限。

---

## Risk 5 — Action abstraction hides important anomalies

Action-local loop如果把真正具有 epistemic meaning 的失败也当作普通 execution noise，会损害 reasoning。

因此 raw trace必须保留，并允许 escalation。

---

# 16. Kill Criteria

项目需要主动允许自己失败。

### Kill 1

不经过 Pi compaction 的 ContextCompiler baseline 明显降低 coding performance，并且无法通过简单 projection policy 修复。

### Kill 2

Anchor 不产生可测的 goal-drift 改善。

### Kill 3

Frame 对 Action selection 没有 causal effect。

### Kill 4

Action episode abstraction节省 context，却明显降低 debugging adaptability。

### Kill 5

Observation 必须依赖越来越多 task-specific schema 才有价值。

### Kill 6

最终系统重新演化成：

```text
another transcript summary mechanism
```

如果出现 Kill 6，整个 architecture 方向应重新审视。

---

# 17. Immediate Development Scope

第一轮开发只完成：

```text
1. Fork Pi

2. Bypass default model-facing compaction

3. Preserve raw session/event history

4. Introduce ContextCompiler

5. Make session history != model context

6. Reproduce normal Pi coding behavior
   without epistemic primitives
```

这一阶段**不要实现 Frame、Observation 或复杂 Action loop**。

成功标准只有一个：

> **证明 Pi 可以作为 execution chassis，而 model cognition 完全由我们自己的 context compiler 驱动。**

完成这一点之后，再依次加入：

```text
Anchor
→ Frame
→ Action Episode
→ Observation
```

每增加一个 primitive 都必须有独立 ablation。

---

# 18. Central Thesis

这个项目表面上是在研究：

> epistemic primitives for coding agents.

但更基础的 architecture thesis 是：

> **Before epistemic objects can become first-class, transcript history must stop being the first-class cognitive state.**

因此第一刀不是设计更好的 Frame。

而是：

```text
transcript
    ↓
demote to event log
```

并把：

```text
epistemic state
    ↓
promote to context source
```

最终目标不是：

> 更聪明地总结 agent 做过什么。

而是：

> **由 harness 显式决定：基于当前任务、认识状态和执行阶段，模型此刻究竟应该看到什么。**

这就是本项目与传统 compaction / memory / RAG 路线最根本的区别。
