# ChronoRift

ChronoRift 是一个基于 Pi SDK 的 **game-native Agent Harness**。它把游戏运行时 Bug 转换成可恢复、
可干预、可重放、可比较的实验，并由 Harness 根据运行时证据裁决结论，而不是相信模型置信度。

> 当前版本：**v0.3 benchmark evidence release**。v0.1 Mock 与 v0.2 switch-door 命令继续兼容；
> v0.3 已实现可冻结的三组对照协议、可审计执行账本与报告完整性/Gate 分离。机器权威
> `benchmark-spec.v2.json` 与正式 GLM-5.2 36-cell 结果尚未生成；在 spec 冻结、报告发布前，
> 本仓库不声称 benchmark 优势。

[Target Architecture](docs/architecture.md) 是长期演进北极星，不是一次性实现清单。当前 Godot
边界见 [Godot Protocol v2](docs/godot-protocol-v2.md)。

## v0.3 做到了什么

四个 Fixture 分别覆盖游戏调试中不同于普通代码 Agent 的运行时机制：

| Fixture              | 冻结 Contract                       | 故障机制                                                   | 可证伪干预           |
| -------------------- | ----------------------------------- | ---------------------------------------------------------- | -------------------- |
| `signal-ordering`    | Signal 后门应在 1 tick 内打开       | Signal 早于 receiver connection                            | 输入延后 1 tick      |
| `frame-input-window` | 离开平台后输入应触发 jump           | 用 frame count 表示时间窗口，受 FPS 影响                   | fixed FPS 120 → 60   |
| `physics-tunneling`  | projectile fired 后 target 应被击中 | 低 physics TPS 下离散采样穿透                              | physics TPS 30 → 120 |
| `entity-reuse`       | respawn 后 health 应保持 100        | incarnation 1 的延迟 effect 在复用后错误命中 incarnation 2 | 关闭 Fixture pooling |

每次完整诊断执行：

```text
冻结 Contract + 初始 checkpoint + 输入 trace
→ baseline 复现失败并封存 Execution Log
→ 编译状态差分、事件链、delivery/lifecycle/spatial 异常证据
→ 真实 Pi Session/Agent Loop 调用受限工具
→ strict replay 验证相同语义 timeline
→ 从同一 checkpoint 运行一个候选单变量 intervention
→ 比较 lineage、realized controls、结果和首个 divergence
→ Agent 提交 DiagnosisProposal v3 及实际读取过的 receipt ID
→ Harness 重验引用、receipt、replay、候选执行、比较、事件健康与机制条件
→ confirmed，或带 blockers 的 inconclusive
```

deterministic fake model 通过真实 Pi `createAgentSession`、Agent Loop、工具调度与持久化 Session，
但不访问网络。它从事件形态选择实验，不读取 Fixture ID 或 benchmark oracle。`FailureBriefV1`
向三组提供相同的冻结失败描述；每次证据与源码访问产生 content-addressed
`EvidenceAccessReceiptV1`。`confidence=0` 的完整证据仍可 confirmed；`confidence=1` 缺少可验证
引用时仍只能 inconclusive。

`entity-reuse` 不再用同步扣血模拟问题。tick 0 调度一个目标为 incarnation 1、due tick 1 的 effect；
tick 1 先回收实体并生成 incarnation 2，Buggy resolver 再按 stable ID 把旧 effect 错误应用到新实体。
关闭 pooling 时 effect 以 `owner_destroyed` 丢弃且 Contract 通过；只提高 FPS 仍失败。checkpoint 会
捕获 pending effect 与 sequence，Evidence Capsule 会把 Contract 窗口之前的调度事件作为因果祖先
纳入证据。

## 三组 benchmark arm

| Arm               | Agent 可见能力                                                                  |
| ----------------- | ------------------------------------------------------------------------------- |
| `generic`         | 原始 baseline/replay、allowlisted experiment、受限源码工具                      |
| `evidence-only`   | Evidence Capsule、strict replay、受限源码工具                                   |
| `chronorift-full` | Capsule、strict replay、allowlisted experiment、canonical compare、受限源码工具 |

三组收到 byte-identical system/user prompt 与 `FailureBriefV1`，prompt 不包含 arm 名称；差别只在
active tool set。三组均无 shell、任意文件读取、写文件、Contract 修改或源码修改能力，共享
baseline 1、replay 1、intervention 2、source call 4、总游戏执行 4 的冻结上限，工具不可用不会转换为
额外权限。源码只通过中性的虚拟路径 `case/main.gd` 暴露，真实文件、项目、场景与 UI 名称不会进入
Agent 视图。隐藏 oracle 只在提交后用于评分，不会进入 prompt、工具结果或 Capsule。

正式矩阵为 4 Fixture × 3 arm × 3 repetition，共 36 cells。固定 seed
`chronorift-v0.3-formal-1` 确定 Fixture/repetition block 顺序及每个 block 内的 arm 顺序；provider
不提供 sampling seed。Pi 固定 `volcengine-coding-plan/glm-5.2`、`thinkingLevel=max`、并发 1、每 cell
600 秒。运行前必须验证模型 metadata 为 1,000,000 context window、128,000 max tokens，且 `max`
映射为 `max`。

主指标是 `groundedSuccess = mechanism correct && Harness verdict confirmed`。冻结 Gate 为：

- `chronorift-full` grounded success 至少 9/12；
- `chronorift-full - generic` grounded-success rate 至少 +0.20；
- `chronorift-full` incorrect confirmations 为 0。

其他 arm 的 incorrect confirmations、mechanism accuracy、source grounding、token、工具/游戏调用和
wall time 均报告，但不改变该 Gate。模型 confidence 不参与评分。

离线 `benchmark` 是保留的 V1 deterministic smoke，验证 Agent 工具流、权限、预算、基本矩阵和
Gate 编排，不作为产品优势数据。formal v2 selection、progress journal、retry/recovery 与 ledger
由 `corepack pnpm check` 中的离线测试验证。正式结果状态与复现实验协议见
[v0.3 evidence package](docs/benchmarks/v0.3/README.md)。

## 项目结构

依赖方向保持为 `domain ← gamebranch ← adapters ← CLI composition root`。

```text
apps/cli                         参数解析、v0.3 composition、exploratory/formal benchmark runner
packages/domain                  engine-neutral ID、DTO、strict Zod schema
packages/gamebranch              replay、experiment、evidence、compare、Gate、评分
packages/godot-protocol          versioned wire DTO、hash、TCP framing
packages/godot-adapter           Godot 进程、能力协商、Fixture registry、runtime port
packages/json-artifacts          v0.1 兼容 store + v0.3 run store + append-only benchmark ledger
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

# 离线 deterministic smoke；不声称模型优势
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

真实 provider 的探索运行与冻结正式运行是两个不同入口。`benchmark:explore` 允许调整参数，仅用于
调试基础设施；`benchmark:formal` 只接受冻结 spec、可选的同 execution 恢复 ID 与 Godot 二进制路径，
不接受 provider、model、thinking、seed、repetition 或 artifact-root 覆盖。formal、status 与 publish 固定使用
仓库下的 `.chronorift/`：

```bash
corepack pnpm benchmark:explore -- \
  --provider volcengine-coding-plan \
  --model glm-5.2 \
  --thinking max

# 维护者在最终实现通过检查后生成机器 spec；精确 JSON 必须与 freeze commit/tag 一起提交
corepack pnpm --silent benchmark:spec \
  > docs/benchmarks/v0.3/benchmark-spec.v2.json

# 正式 36-cell；新执行时不要传 --resume
corepack pnpm benchmark:formal -- \
  --spec docs/benchmarks/v0.3/benchmark-spec.v2.json

# 从 durable first-execution selection 找回 ID，不调用 provider
corepack pnpm benchmark:status -- \
  --spec docs/benchmarks/v0.3/benchmark-spec.v2.json

# 只恢复已选中的同一 execution，不创建或拼接另一个 suite
corepack pnpm benchmark:formal -- \
  --spec docs/benchmarks/v0.3/benchmark-spec.v2.json \
  --resume BENCHMARK_EXECUTION_ID

corepack pnpm benchmark:publish -- \
  --execution BENCHMARK_EXECUTION_ID \
  --output docs/benchmarks/v0.3

corepack pnpm benchmark:verify -- \
  --report docs/benchmarks/v0.3/benchmark-report.v2.json

corepack pnpm benchmark:gate -- \
  --report docs/benchmarks/v0.3/benchmark-report.v2.json
```

`benchmark:live` 暂保留为 `benchmark:explore` 的兼容别名，但已弃用。每个 definition 在固定本地
ledger 中使用 `first-formal-execution-wins-v1`；selection 持久化后才输出 `executionId`，之后不得创建
第二个 non-resume execution。终端输出丢失时用 `benchmark:status` 找回该 ID。这是可审计的本地防
cherry-pick 规则，不是外部签名；拥有同一用户文件权限的人仍可删除整个本地 ledger。

每个 attempt 持久化 `baseline_completed_unvalidated → fixture_material_validated → agent_progress`
阶段。只有未观察到 Agent/model/tool/game 进展的中断或 closed classifier 明确列出的 infrastructure
failure 可以继续；一旦记录 `agent_progress`，超时、provider 错误或进程中断都是 terminal
diagnostic，不会通过重试筛选模型回答。

`benchmark:verify` 只验证 schema、canonical cell identity、attempt hash chain、oracle 重算、聚合与
report hash；有效的负面或 incomplete 报告仍是完整性有效。`benchmark:gate` 单独解释产品 Gate。
这不是 provider attestation，也不能证明模型请求确由声明供应商执行。正式 benchmark 需要网络与
用户凭据，不是默认 CI gate。

## 常用命令

| 命令                              | 作用                                   |
| --------------------------------- | -------------------------------------- |
| `corepack pnpm check`             | lint、格式、strict typecheck、离线测试 |
| `corepack pnpm test:godot`        | 四 Fixture v0.3 + v0.2 兼容集成测试    |
| `corepack pnpm demo:v03`          | 单 Fixture 离线完整诊断                |
| `corepack pnpm diagnose:v03`      | 单 Fixture 真实 provider 诊断          |
| `corepack pnpm benchmark`         | deterministic fake-model smoke         |
| `corepack pnpm benchmark:explore` | 可配置的真实 provider 探索运行         |
| `corepack pnpm benchmark:spec`    | 生成待提交的 formal v2 机器 spec       |
| `corepack pnpm benchmark:formal`  | 冻结 spec 的可恢复 36-cell 正式执行    |
| `corepack pnpm benchmark:status`  | 查询 durable first-execution selection |
| `corepack pnpm benchmark:publish` | 从 ledger 生成 sanitized evidence 包   |
| `corepack pnpm benchmark:verify`  | 仅重验 report 完整性与可重算字段       |
| `corepack pnpm benchmark:gate`    | 单独评估 grounded-success Gate         |
| `corepack pnpm benchmark:live`    | 已弃用的 `benchmark:explore` 兼容别名  |
| `corepack pnpm demo`              | v0.1 Mock 兼容路径                     |
| `corepack pnpm demo:godot`        | v0.2 switch-door 兼容路径              |
| `corepack pnpm test:live`         | v0.1 真实 provider smoke test          |

## Artifact 与可信边界

单次诊断 artifact 位于 `.chronorift/v0.3/runs/<run-id>/`：

```text
contracts/     checkpoints/   traces/       branches/
executions/    capsules/      comparisons/  proposals/  verdicts/
pi-sessions/
```

外部与持久化 DTO 都带显式 `schemaVersion` 并经过 strict runtime validation。Contract 与 trace
content-addressed；BranchSpec immutable；Execution/event sealed；v0.3 repository write-once，并拒绝
absolute path、`..`、symlink/canonical path escape 和不同内容覆盖。requested control 只有获得匹配
realized receipt 后才能用于比较与 Gate。

正式 benchmark 使用独立的 append-only ledger：

```text
.chronorift/v0.3/benchmarks/definitions/<definition-id>/
  definition.json
  selection.json
  executions/<execution-id>/
    started.json
    attempts/<cell-id>/<ordinal>-<attempt-id>/
      started.json
      progress/<sequence>.json
      finished.json
    cells/<cell-id>.json
    completed.json
```

每个文件以 create-only 方式写入；attempt 通过 previous hash 串联。`completed.json` 只存在于已封存
execution；首轮可恢复的 incomplete 尚未封存，不能 publish。发布器只导出 allowlisted、脱敏字段，
不导出 prompt、源码正文、Pi Session 路径、API key 或 credential store。历史 ledger 与
`.chronorift/` 仍是本地状态，不提交 Git。

正式命令退出码约定：

| 命令               | `0`                             | `1`                                   | `2`                   |
| ------------------ | ------------------------------- | ------------------------------------- | --------------------- |
| `benchmark:formal` | 完整执行（无论 Gate 通过与否）  | 已封存 invalid，或命令/preflight 失败 | incomplete            |
| `benchmark:verify` | 完整性有效，包括负面/incomplete | 篡改、无效或命令失败                  | —                     |
| `benchmark:gate`   | Gate 通过                       | 篡改、无效或命令失败                  | Gate 未通过或不可评估 |

`benchmark:formal` 的 JSON 中 `recoverable=true` 表示 exit `2` 仍是未封存首轮，必须对同一 ID
`--resume`；`recoverable=false,status=incomplete` 表示 recovery 已用尽且报告已封存，应原样发布。

## 当前限制

v0.3 是四个小型、显式插桩 Fixture 的诊断 benchmark，不是任意 Godot 项目即插即用的 debugger：

- Addon 使用 allowlist 和注册式 property/entity/lifecycle/spatial probe，不声称全局拦截。
- checkpoint 只恢复注册 participant；physics internals、Timer/Tween/coroutine、线程、未注册 RNG、
  caches、网络和外部服务仍标为 missing state。
- matching replay 是当前 Fixture 的确认条件，不是完整 Determinism Certificate。
- 没有自动修复、Git worktree、通用 World Graph、Experiment DAG、视觉、多 Agent、容器 sandbox、
  复杂 artifact 服务或 UI。
- suite 在同一四个 Fixture 上校准，不能用于统计显著性、跨项目泛化或与 Claude Code 的比较。
- provider 没有 sampling seed；三次 repetition 不是独立、可复现实验随机样本。
- report verifier 是本地可重算的完整性检查，不是签名、CI attestation 或 provider attestation。
- benchmark 只有生成、发布并通过 sanitized formal report 后才构成这四个 Fixture 上的正面证据；
  当前正式结果仍为 pending。

下一步是先按冻结 spec 运行并如实发布 formal report（无论正面、负面或 incomplete），再接入一个
仓库外真实 Godot 项目，验证 Addon API、checkpoint coverage 与源码根边界是否足够；不会因为
四个校准 Fixture 跑通就直接外推完整 Target Architecture。
