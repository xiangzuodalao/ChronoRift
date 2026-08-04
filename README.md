# ChronoRift

ChronoRift 是一个基于 Pi SDK 的 **game-native Agent Harness**。它把游戏运行时 Bug 转换成可恢复、
可干预、可重放、可比较的实验，并由 Harness 根据运行时证据裁决结论，而不是相信模型置信度。

> 当前版本：**v0.3 benchmark-first Godot diagnostic harness**。v0.1 Mock 与 v0.2 switch-door
> 命令继续兼容；v0.3 新路径使用四个真实 Godot Fixture、Protocol v2、Evidence Capsule v2、
> 两个候选单变量实验和三组 Agent arm。

[Target Architecture](docs/architecture.md) 是长期演进北极星，不是一次性实现清单。当前 Godot
边界见 [Godot Protocol v2](docs/godot-protocol-v2.md)。

## v0.3 做到了什么

四个 Fixture 分别覆盖游戏调试中不同于普通代码 Agent 的运行时机制：

| Fixture              | 冻结 Contract                       | 故障机制                                  | 可证伪干预           |
| -------------------- | ----------------------------------- | ----------------------------------------- | -------------------- |
| `signal-ordering`    | Signal 后门应在 1 tick 内打开       | Signal 早于 receiver connection           | 输入延后 1 tick      |
| `frame-input-window` | 离开平台后输入应触发 jump           | 用 frame count 表示时间窗口，受 FPS 影响  | fixed FPS 120 → 60   |
| `physics-tunneling`  | projectile fired 后 target 应被击中 | 低 physics TPS 下离散采样穿透             | physics TPS 30 → 120 |
| `entity-reuse`       | respawn 后 health 应保持 100        | 旧 incarnation 的延迟 effect 污染复用实体 | 关闭 Fixture pooling |

每次完整诊断执行：

```text
冻结 Contract + 初始 checkpoint + 输入 trace
→ baseline 复现失败并封存 Execution Log
→ 编译状态差分、事件链、delivery/lifecycle/spatial 异常证据
→ 真实 Pi Session/Agent Loop 调用受限工具
→ strict replay 验证相同语义 timeline
→ 从同一 checkpoint 运行一个候选单变量 intervention
→ 比较 lineage、realized controls、结果和首个 divergence
→ Agent 提交 DiagnosisProposal v2
→ Harness 重验引用、replay、比较、事件健康与机制条件
→ confirmed，或带 blockers 的 inconclusive
```

deterministic fake model 通过真实 Pi `createAgentSession`、Agent Loop、工具调度与持久化 Session，
但不访问网络。它从事件形态选择实验，不读取 Fixture ID 或 benchmark oracle。`confidence=0` 的完整
证据仍可 confirmed；`confidence=1` 缺少 replay/干预证据仍只能 inconclusive。

## 三组 benchmark arm

| Arm               | Agent 可见能力                                             | 最大游戏预算 |
| ----------------- | ---------------------------------------------------------- | ------------ |
| `generic`         | 原始 baseline/replay、两个实验、受限源码 read/search       | baseline + 3 |
| `evidence-only`   | Evidence Capsule、strict replay、受限源码 read/search      | baseline + 3 |
| `chronorift-full` | Capsule、strict replay、两个实验、结构化 compare、源码工具 | baseline + 3 |

三组均无 shell、任意文件读取、写文件、Contract 修改或源码修改能力；源码根固定为当前 Fixture，调用
预算相同。Agent-facing Fixture/Intervention 前缀使用 opaque case ID，不从名称泄漏机制；Live matrix
对所有 arm 固定 `thinkingLevel=low`。隐藏 oracle 只在 Agent 提交后用于评测 mechanism 和可选 source location，不会进入 prompt、
工具结果或 artifact Capsule。

正式矩阵为 4 Fixture × 3 arm × 3 repetition，共 36 cells，并以 seed 打乱顺序。每个成功 cell 的
原始 manifest 写入被忽略的 `.chronorift/`，中断后可恢复；suite source hash 变化会自动开启新 run，
不会混用旧 cell。仓库只允许发布不含 prompt、源码内容、Session 路径和凭据的 sanitized report。
优势门槛为：

- `chronorift-full` mechanism accuracy ≥ 75%；
- incorrect confirmations = 0；
- 相比 `generic` 至少 +20 percentage points。

离线 fake benchmark 只验证矩阵编排、权限、预算、schema 和 Gate，不作为产品优势数据。

## 项目结构

依赖方向保持为 `domain ← gamebranch ← adapters ← CLI composition root`。

```text
apps/cli                         参数解析、v0.3 composition、benchmark runner
packages/domain                  engine-neutral ID、DTO、strict Zod schema
packages/gamebranch              replay、experiment、evidence、compare、Gate、评分
packages/godot-protocol          versioned wire DTO、hash、TCP framing
packages/godot-adapter           Godot 进程、能力协商、Fixture registry、runtime port
packages/json-artifacts          v0.1 兼容 store + v0.3 run-scoped write-once store
packages/pi-harness              真实 Pi Session/Loop、三组受限工具、fake/production model
packages/mock-game               v0.1 deterministic switch-door Mock
godot/addons/chronorift           EditorPlugin + ChronoProbe Autoload
fixtures/godot-*                 四个显式插桩的真实 Godot Fixture
```

Pi 与 Godot 原生类型不会进入 domain/gamebranch。Addon 与 Fixture 会复制到被忽略的
`.chronorift/godot-projects/`；源码树中的 symlink 会被拒绝。

## 快速开始

要求 Node.js `>=22.19`；`.nvmrc` 固定 `22.23.1`，pnpm 固定 `11.20.0`。

```bash
nvm use
corepack pnpm install
corepack pnpm check

corepack pnpm godot:install
corepack pnpm godot:doctor
corepack pnpm fixtures

# 一个真实 Godot Fixture + 真实 Pi Loop + 离线 fake model
corepack pnpm demo:v03 -- --fixture signal-ordering

# 四个 Fixture、三个 arm、一次 repetition；离线模型，不声称优势
corepack pnpm benchmark -- --seed local-smoke

# 固定 Godot 的完整集成测试
corepack pnpm test:godot
```

系统没有全局 `pnpm` 时始终使用 `corepack pnpm <command>`。

## 使用火山 Coding Plan / GLM-5.2

Pi 依赖固定为 `@earendil-works/pi-coding-agent@0.83.0` 与
`@earendil-works/pi-ai@0.83.0`，不修改、fork 或 vendor。凭据只写入 Pi 用户级 credential store，
不会复制进仓库、Session Capsule 或 benchmark report。

```bash
read -rsp 'Volcengine Coding Plan API key: ' ARK_CODING_PLAN_API_KEY && echo
export ARK_CODING_PLAN_API_KEY
corepack pnpm auth:volcengine
unset ARK_CODING_PLAN_API_KEY

corepack pnpm models -- --provider volcengine-coding-plan

corepack pnpm diagnose:v03 -- \
  --fixture physics-tunneling \
  --provider volcengine-coding-plan \
  --model glm-5.2
```

运行可恢复的 36-cell live benchmark：

```bash
corepack pnpm benchmark:live -- \
  --provider volcengine-coding-plan \
  --model glm-5.2 \
  --repetitions 3 \
  --seed chronorift-v0.3 \
  --report docs/benchmarks/v0.3-live.json

corepack pnpm benchmark:verify -- \
  --report docs/benchmarks/v0.3-live.json
```

`benchmark:verify` 会重验 strict report schema、完整 36-cell matrix、cell provenance、聚合结果和
优势门槛；门槛未满足时以失败退出。Live benchmark 需要网络与用户凭据，不是默认 CI gate。

## 常用命令

| 命令                             | 作用                                   |
| -------------------------------- | -------------------------------------- |
| `corepack pnpm check`            | lint、格式、strict typecheck、离线测试 |
| `corepack pnpm test:godot`       | 四 Fixture v0.3 + v0.2 兼容集成测试    |
| `corepack pnpm demo:v03`         | 单 Fixture 离线完整诊断                |
| `corepack pnpm diagnose:v03`     | 单 Fixture 真实 provider 诊断          |
| `corepack pnpm benchmark`        | fake model 离线矩阵                    |
| `corepack pnpm benchmark:live`   | 可恢复的真实 provider 矩阵             |
| `corepack pnpm benchmark:verify` | 重验 sanitized report 与优势门槛       |
| `corepack pnpm demo`             | v0.1 Mock 兼容路径                     |
| `corepack pnpm demo:godot`       | v0.2 switch-door 兼容路径              |
| `corepack pnpm test:live`        | v0.1 真实 provider smoke test          |

## Artifact 与可信边界

v0.3 artifact 位于 `.chronorift/v0.3/runs/<run-id>/`：

```text
contracts/     checkpoints/   traces/       branches/
executions/    capsules/      comparisons/  proposals/  verdicts/
pi-sessions/
```

外部与持久化 DTO 都带显式 `schemaVersion` 并经过 strict runtime validation。Contract 与 trace
content-addressed；BranchSpec immutable；Execution/event sealed；v0.3 repository write-once，并拒绝
absolute path、`..`、symlink/canonical path escape 和不同内容覆盖。requested control 只有获得匹配
realized receipt 后才能用于比较与 Gate。

## 当前限制

v0.3 是四个小型、显式插桩 Fixture 的诊断 benchmark，不是任意 Godot 项目即插即用的 debugger：

- Addon 使用 allowlist 和注册式 property/entity/lifecycle/spatial probe，不声称全局拦截。
- checkpoint 只恢复注册 participant；physics internals、Timer/Tween/coroutine、线程、未注册 RNG、
  caches、网络和外部服务仍标为 missing state。
- matching replay 是当前 Fixture 的确认条件，不是完整 Determinism Certificate。
- 没有自动修复、Git worktree、通用 World Graph、Experiment DAG、视觉、多 Agent、容器 sandbox、
  复杂 artifact 服务或 UI。
- benchmark 只有发布并通过 sanitized live report 后才构成真实模型优势证据。

下一步是用 live report 校准工具描述和 Fixture 难度，然后接入一个仓库外真实 Godot 项目，验证
Addon API、checkpoint coverage 与源码根边界是否足够；不会因为 v0.3 跑通就直接实现完整 Target
Architecture。
