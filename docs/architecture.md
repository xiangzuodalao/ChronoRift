# ChronoRift 架构

## 设计目标

ChronoRift 的核心不是“把全部游戏日志发给模型”，而是建立一条确定、可恢复、可比较的
实验管线：运行时遥测先被归一化，再编译为状态差分、事件链和异常证据；Agent 通过窄
接口选择实验、创建分支并 replay，最后用稳定 ID 引用观察结果。

Phase 1 使用 Mock Game Environment 验证这条管线，同时保持未来 Godot adapter 可以替换
Mock，而无需改写 timeline、评测或 Agent 工具协议。

## 依赖规则

```text
domain ← gamebranch ← adapters ← CLI
```

箭头表示依赖方向，因此实际读取顺序是 `CLI → adapters → gamebranch → domain`。

### domain

`packages/domain` 是最内层，只包含无 I/O 的领域语言与契约，例如：

- environment state、tick、input、Signal 和 property change；
- checkpoint reference、input trace 和 replay options；
- timeline/branch ID 与 lineage；
- state diff、event chain、invariant violation 和 evidence；
- run manifest、model/session reference 和 `DiagnosisReport`；
- Game Environment、artifact repository 等端口接口。

该层不认识 JSON 文件布局、Pi SDK、CLI 或 Godot API。

### gamebranch

`packages/gamebranch` 是应用核心，负责：

- 从环境创建与恢复 checkpoint；
- 在确定性时钟上执行输入并收集遥测；
- 从 checkpoint 创建 timeline 子分支；
- 在相同 seed 和 input trace 下 replay；
- 评测时序不变量；
- 把原始遥测编译成紧凑的 diff、event chain 和 evidence；
- 比较多个实验分支并保留 lineage。

它只通过 domain 端口使用游戏环境与 artifact store，不直接读取文件，也不调用 Pi。

### adapters

适配器实现核心端口，并把第三方或基础设施细节隔离在外层：

- `packages/mock-game`：进程内确定性开关/门场景、虚拟 tick 和 checkpoint codec。
- `packages/json-artifacts`：版本化 JSON/JSONL artifact store，提供跨进程恢复。
- `packages/pi-harness`：基于当前 `@earendil-works` scope 的 Pi SDK 建立 Session，注册
  GameBranch 工具与受限只读源码工具，并解析结构化诊断报告。旧
  `@mariozechner` scope 已迁移，不应出现在新增代码中。

适配器可以依赖 `gamebranch` 与 `domain`，但核心层不能反向导入适配器。

### CLI

`apps/cli` 是 composition root。它负责解析参数、选择 artifact 路径、装配 Mock 环境、
GameBranch、Pi harness 和输出格式。业务判断不应放进 CLI handler。

## Phase 1 执行链

```text
创建 run/manifest
  ↓
恢复或创建 checkpoint
  ↓
记录输入：activate-switch
  ↓
环境 tick → Signal + property changes + logs
  ↓
评测“开关激活后两 tick 内门打开”
  ↓
失败 → state diff + event chain + evidence
  ↓
Agent 读取 evidence，并从同一 checkpoint 创建实验分支
  ↓
使用不同 frame duration replay 相同输入 trace
  ↓
比较分支 → DiagnosisReport
```

Agent 能做的动作应通过明确、可审计的工具暴露，例如读取证据、读取 trace 摘要、创建
分支、replay、比较结果和读取受限源码。Phase 1 不暴露写文件、任意 shell 或源码修改
工具。

## Mock 时序故障

开关被激活时会发出 Signal，开关自身状态也从 inactive 变为 active；门订阅到事件并
开始等待。故意植入的错误是用“elapsed time 精确等于目标延迟”作为开门条件。

离散帧时钟不保证命中任意目标时间。Phase 1 的目标延迟为 `32,000µs`：

| frame duration | elapsed 序列片段 | 结果               |
| -------------- | ---------------- | ------------------ |
| 16,000 µs      | 16,000 → 32,000  | 命中等号，门打开   |
| 16,667 µs      | 16,667 → 33,334  | 越过目标，门不打开 |

具体数值只是对故障机制的说明。关键实验约束是：两个分支来自相同 checkpoint，使用相同
seed 和输入 trace，只覆盖 frame duration。这样结果差异才能归因于帧步进敏感性。

## 遥测与证据

原始遥测采用有序 envelope，至少需要 run/branch、tick、逻辑时间、事件类型和 payload。
同一 tick 内仍需稳定的 sequence number，避免 Signal 与属性变化在序列化后失序。

证据编译分为三类输出：

1. **状态差分**：只保留与不变量相关的实体和属性 before/after。
2. **事件链**：从输入，经 Signal 与状态变化，到预期事件缺失的因果候选链。
3. **异常证据**：规则 ID、观察窗口、相关事件 ID、diff ID、期望与实际结果。

证据只陈述可观测事实和规则违规；“根因是精确时间比较”属于 Agent 结合源码与分支实验
形成的诊断结论。

## Artifact 与 lineage

artifact store 的物理实现是版本化 JSON/JSONL。概念布局如下，具体文件名可由 adapter
演进，但每个文档都必须带 schema version 和稳定 ID：

```text
.chronorift/
├── checkpoints/<checkpoint-id>.json
├── traces/<trace-id>.json
├── branches/<branch-id>/
│   ├── branch.json
│   ├── events.jsonl
│   └── run.json
├── evaluations/<evaluation-id>.json
├── evidence/<evidence-id>.json
├── diagnoses/<report-id>.json
└── runs/<run-id>/
    ├── manifest.json
    └── pi-sessions/*.jsonl
```

### Run manifest

manifest 是一次可追溯诊断的入口，关联：

- schema/run ID 与创建时间；
- Pi Session ID、provider/model 标识；
- Git commit 与 dirty 状态；
- 环境 adapter 名称、版本或构建引用；
- 初始 checkpoint、seed 与 input trace 哈希；
- 根 timeline 和所有 branch ID；
- evidence/report ID。

Godot 尚未接入时，环境字段使用通用 Mock environment reference，不伪造 Godot 信息。

### Session 与 GameBranch

一次诊断保持一个 Pi Session。Agent 在该 Session 内创建多个 GameBranch，这些游戏分支
不会自动派生新的 Pi Session。manifest 显式记录 Session 与各 branch 的关联。

每个 branch 记录 `parentBranchId`、`forkCheckpointId`、继承的 trace/seed，以及 frame
duration 等运行参数覆盖。根 branch 没有 parent。由这些字段可以沿 lineage 回溯到共同
祖先，并检查实验是否只改变一个变量。

### Checkpoint 与 trace

checkpoint 保存恢复游戏所需的最小确定性状态，并记录 environment/schema version。
trace 是有序输入而不是自由文本，至少包含相对于 checkpoint 的 tick/时间、动作及参数。
trace hash 用于检测 replay 输入漂移。

一次 replay 的身份可表示为：

```text
checkpoint ID + environment version + seed + trace hash + replay options
```

相同身份应得到相同的规范化结果；若不相同，应被报告为确定性违规，而不是交给 Agent
猜测。

## Pi 边界

Pi SDK 负责模型选择、Agent Loop 和 Session；ChronoRift 负责游戏状态、实验与评测。
两者通过窄工具协议连接：Pi 不拥有 checkpoint 格式，GameBranch 也不理解模型消息实现。

真实诊断必须返回可解析的 `DiagnosisReport`，至少包含：

- 结论和置信度；
- 引用的 evidence ID；
- 创建或比较的实验 branch ID 与结果；
- 建议修复方向；
- 未确认的假设。

live 测试只断言 schema、引用完整性和关键实验是否出现，不快照自然语言措辞。普通测试
注入 deterministic fake agent 或直接测试核心服务，不访问模型或网络。

## 可测试性原则

- domain 类型与规则使用纯单元测试。
- gamebranch 使用 fake clock、内存环境/仓储测试分支、replay 与不变量。
- Mock bug 使用不同 frame duration 的参数化测试。
- JSON adapter 通过临时目录验证跨实例恢复与 schema 错误。
- Pi tool handler 使用 fake model/session 做离线 contract test。
- 真实模型调用只进入 `vitest.live.config.ts`。

这套分层确保未来 Godot adapter 可以通过同一套 contract tests，而不改变核心评测语义。
