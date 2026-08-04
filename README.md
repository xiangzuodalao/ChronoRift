# ChronoRift

ChronoRift 是一个基于 Pi SDK 的 **game-native Agent Harness**。它不只把游戏日志交给模型，
而是把运行时 Bug 变成可恢复、可干预、可重放、可比较并由 Harness 裁决的实验。

> 当前版本：**v0.1 Mock 垂直闭环**。仓库已跑通真实 Pi Session/Agent Loop、确定性 fake
> model、switch-door Fixture、checkpoint/replay、单变量 intervention、Evidence Capsule、
> DiagnosisProposal 和 Conclusion Gate。Godot Adapter、自动修复、视觉、多 Agent 等仍未实现。

长期目标与当前实现的边界见 [Target Architecture](docs/architecture.md)。该文档是演进目标，
不是要求一次性实现的功能清单。

## v0.1 跑通了什么

```text
冻结 Contract：switch.activated 后 1 tick 内 door.open == true
→ 从 Mock checkpoint 执行 tick-0 开关输入
→ Signal 已发出，但 door receiver 尚未连接，delivery=false
→ receiver 随后连接，Signal 不会补发，door.open 仍为 false
→ 生成 closed Evidence Capsule
→ Agent 调用 baseline replay，产生新的 sealed Execution
→ Agent 只延迟同一输入 1 tick，其他控制保持一致
→ receiver 先连接，Signal delivery=true，door.open=true
→ Agent 比较 replay 与 intervention，提交 DiagnosisProposal
→ Harness Conclusion Gate 重验所有引用与事实，输出 confirmed/inconclusive
```

`pnpm demo` 会执行这条完整链路。它使用 Pi 官方 `fauxProvider` 注入确定性模型，但仍通过真实
的 `createAgentSession`、Agent Loop、工具调度和持久化 Session；默认不读取凭据、不访问网络。

## 为什么它不是普通代码 Agent 演示

v0.1 的差异点在 Harness，而不是自然语言回答：

- `BranchSpec` 与 `ExecutionLog` 分离；一次 replay 会产生新的 immutable Execution。
- checkpoint restore、每一步控制和输入都必须有 runtime realized receipt。
- `signal_delivery` 是类型化遥测，能区分 Signal emission 与 receiver delivery。
- Agent 只能读取 Capsule、replay、运行一个允许的 intervention、compare 和提交 Proposal。
- Agent 没有 shell、源码读取、文件写入或修改 Contract 的工具。
- Proposal 是不可信假设；机制声明必须包含可机器校验的 `mechanismCode` 与 structured
  assertion，只有 Harness 能生成 verdict。
- Agent confidence 不参与 Gate。离线 fake model 对正确诊断故意报告 `confidence=0`，结果仍由
  证据得到 `confirmed`。
- 缺少 replay、干预未实际生效、digest 漂移、证据丢失或引用不完整时，Gate 返回带 blocker
  和下一实验的 `inconclusive`；伪造或跨 run 引用会被拒绝。

## 架构边界

依赖方向保持为：

```text
domain ← gamebranch ← adapters ← CLI composition root
```

- `packages/domain`：engine-neutral ID、DTO 与严格 Zod schema。
- `packages/gamebranch`：Contract、执行、replay、intervention、comparison、Capsule 和 Gate。
- `packages/mock-game`：确定性 switch-door 环境及故意植入的 receiver-order Bug。
- `packages/json-artifacts`：v0.1 write-once JSON repository；读取与写入均校验 schema、hash 和
  路径边界。
- `packages/pi-harness`：Pi SDK Session/Agent Loop、五个受限工具、fake/真实模型入口。
- `apps/cli`：依赖装配和命令解析，不拥有 verdict 策略。

旧 Phase 1 类型暂时保留兼容，但 v0.1 新路径使用独立的 `FrozenContract`、`BranchSpec`、
`ExecutionLog`、`EvidenceCapsule`、`ExecutionComparison`、`DiagnosisProposal` 与
`DiagnosisVerdict`。

## 快速开始

要求 Node.js `>=22.19`。仓库的 `.nvmrc` 固定为 Node.js `22.23.1`，pnpm 固定为
`11.20.0`。

```bash
nvm use
corepack pnpm install
corepack pnpm check
corepack pnpm demo
```

无需全局安装 pnpm。如果系统找不到 `pnpm`，始终使用 `corepack pnpm <command>` 即可；也可
选择启用 shim：

```bash
corepack enable
corepack prepare pnpm@11.20.0 --activate
```

成功的 demo 会显示三个不同 Execution：

```text
ChronoRift v0.1 — confirmed
Original baseline: ... (fail)
Strict replay:     ... (fail)
Intervention:      ... (pass)
Agent confidence:  0 (advisory; ignored by the Gate)
Pi model:          chronorift-faux/switch-door-v0.1
```

需要完整机器可读结果时：

```bash
corepack pnpm demo -- --json
corepack pnpm demo -- --artifacts /tmp/chronorift-demo --json
```

## 常用命令

| 命令                                               | 作用                                      |
| -------------------------------------------------- | ----------------------------------------- |
| `corepack pnpm check`                              | lint、格式、严格类型检查、全部离线测试    |
| `corepack pnpm demo`                               | 运行真实 Pi Loop + 确定性 fake model 闭环 |
| `corepack pnpm demo -- --json`                     | 输出完整 v0.1 artifacts 与 verdict        |
| `corepack pnpm replay -- --execution ID`           | 从磁盘 checkpoint 重放一个已有 Execution  |
| `corepack pnpm diagnose -- --provider P --model M` | 使用真实 Pi provider 运行同一套工具闭环   |
| `corepack pnpm models -- --provider P`             | 列出 Pi 当前认证可用的模型                |
| `corepack pnpm auth:volcengine`                    | 持久化火山 Coding Plan 用户级 API key     |
| `corepack pnpm test:live`                          | 运行真实 provider live test               |

`--artifacts PATH` 或 `CHRONORIFT_ARTIFACT_ROOT` 可更改 artifact 根目录。默认目录是
`.chronorift/`，已被 Git 忽略。

## 使用真实 Pi 模型

Pi 依赖固定为 `@earendil-works/pi-coding-agent@0.83.0` 和
`@earendil-works/pi-ai@0.83.0`，不修改、不 fork、不 vendor Pi 源码。真实模型复用 Pi 的
用户级 credential store，凭据不会复制到仓库或 artifact。

以火山 Coding Plan 的 `glm-5.2` 为例，先持久化 key：

```bash
read -rsp 'Volcengine Coding Plan API key: ' ARK_CODING_PLAN_API_KEY && echo
export ARK_CODING_PLAN_API_KEY
corepack pnpm auth:volcengine
unset ARK_CODING_PLAN_API_KEY
```

确认模型注册与认证状态：

```bash
corepack pnpm models -- --provider volcengine-coding-plan
```

运行真实诊断：

```bash
corepack pnpm diagnose -- \
  --provider volcengine-coding-plan \
  --model glm-5.2

# 或使用环境变量
CHRONORIFT_PI_PROVIDER=volcengine-coding-plan \
CHRONORIFT_PI_MODEL=glm-5.2 \
corepack pnpm diagnose
```

真实模型仍只能使用 v0.1 的五个受限工具。测试不固定自然语言措辞，只验证 schema、真实 ID、
工具顺序、runtime receipts、引用完整性和 Harness verdict。

## Artifact 与 replay

v0.1 artifact 位于 `.chronorift/v0.1/`：

```text
contracts/       # content-addressed frozen Contract
checkpoints/     # 显式版本 envelope 的 Mock 语义 checkpoint
input-traces/    # content-addressed 输入轨迹
branch-specs/    # immutable baseline/intervention 规格
executions/      # sealed 执行日志、typed events、receipts 与 digest
capsules/        # closed Evidence Capsule
comparisons/     # replay/intervention 可比性与结果
proposals/       # Agent 输出；不含 canonical verdict
verdicts/        # Harness Conclusion Gate 输出
runs/<run-id>/pi-sessions/  # Pi JSONL Session
```

Repository 管理的领域 artifact 使用严格 schema、显式 `schemaVersion`、原子 write-once 发布和
同内容幂等写入；同 ID 的不同内容、请求 ID 与文件内 ID 不一致、Contract/trace/checkpoint
hash 不匹配或 JSON 损坏都会失败。artifact ID 在编码前会拒绝绝对路径和任何 `..` 路径段；
repository root、静态
目录和 artifact 文件上的符号链接也会 fail closed，并在文件操作前后检查目录身份。该本地
防护降低误配置和路径替换风险，但 Node 路径 API 不是抵御同一用户持续并发改写文件系统的完整
沙箱。v0.1 的 checkpoint 是 Fixture 专用语义快照，不宣称是 Godot 完整内存快照；一次
matching replay 也是本 Fixture 的最小确认门槛，不等价于完整 Determinism Certificate。

从 demo 输出复制原始 Execution ID 后，可在新进程中重放：

```bash
corepack pnpm replay -- \
  --execution 'execution:...' \
  --artifacts .chronorift
```

## 测试

```bash
corepack pnpm test       # 完全离线、确定性、无凭据、无网络
corepack pnpm check      # 默认完成门槛
corepack pnpm test:live  # 仅真实 provider；需要用户级凭据和网络
```

离线测试覆盖：

- baseline fail、typed failed delivery、checkpoint restore 与 step receipts；
- 新 Execution 的 strict replay 与 digest equality；
- 恰好一个 one-tick input intervention 和 realized receipt；
- candidate pass 与 execution comparison；
- Capsule 因果闭包、状态差分和内部引用；
- confidence 隔离、confirmed/inconclusive Gate；
- fabricated/cross-run reference、replay divergence、artifact corruption 与 symlink escape；
- 真实 Pi Session/Agent Loop 的 fake provider 调度和 Session JSONL。

## 当前明确不做

v0.1 不实现通用 World Graph、Experiment DAG、自动修复、Git worktree、完整 Determinism
Certificate、视觉、多人、多 Agent、容器沙箱、复杂 UI 或通用 artifact 平台。Agent 只诊断，
不会修改源码。

## 开发策略

ChronoRift 采用**架构导向的快速垂直迭代**：

- [Target Architecture](docs/architecture.md) 是术语、依赖方向、信任边界和长期演进的北极星，
  不是要求按章节一次性实现的 backlog。
- 每个版本只增加一个主要不确定性维度，并交付可运行、可测试、可演示的完整闭环。
- Contract、realized receipt、artifact lineage、引用完整性、confidence 隔离和 Conclusion Gate
  始终按目标架构执行，不以“原型速度”为由放宽。
- World Graph、Experiment DAG、沙箱等规划包只在真实依赖和生命周期边界出现后创建。
- 新能力必须先由 executable code 和 tests 证明，再更新为“已实现”。

## 路线图

### v0.2：真实 Godot 垂直闭环

保持现有领域模型和 Gate，不重写 Agent 流程：

1. 建立最小 Godot Addon/Autoload 与版本化协议握手。
2. 报告 capabilities；不支持的 Signal、property、step 或 checkpoint 明确失败。
3. 在 Godot 中复刻同一个 switch-door Fixture，采集 allowlisted telemetry 和 realized receipt。
4. 实现 Fixture 专用 checkpoint/restore，明确 consistency、coverage、missing state 和限制。
5. 让现有 replay、one-tick intervention、Capsule、Proposal 和 Gate 原样跑通。
6. 对 Mock 与 Godot Adapter 运行共享的 port contract tests。

### v0.3：多 Bug 与可量化优势

- 增加 2～3 个代表性 Godot Fixture，例如 Signal 初始化顺序、physics/process 时序和输入间隔
  敏感 Bug。
- 建立可重复 benchmark，对比普通日志诊断与 ChronoRift 的复现率、错误确认率、实验次数和
  证据完整性。
- 提供短演示，展示 checkpoint、timeline diff、intervention、Evidence Capsule 和 Gate verdict。

### v0.4：选择一个增量方向

- 求职/产品方向：受限 GDScript candidate patch + 验证闭环；或
- 研究/可靠性方向：重复 replay、非确定性报告和最小 Determinism Certificate。

通用 World Graph、Experiment DAG、复杂 UI、多 Agent 和完整 sandbox 继续作为长期能力，只有在
前一个垂直闭环证明需要时才进入实现。
