# ChronoRift

ChronoRift 是一个基于 Pi SDK 的 **game-native Agent Harness**。它把游戏运行时 Bug 转换成可恢复、
可干预、可重放、可比较的实验，并由 Harness 根据运行时证据裁决结论，而不是相信模型置信度。

> 当前开发版本：**v0.3.2**。v0.1 Mock 与 v0.2 switch-door 命令继续兼容。v0.3.1-r2 已完成唯一的
> 36-cell 正式 execution 并发布可验证报告；报告完整性通过，但冻结 Gate 失败。32 个 cells 的本地
> manifest 记录底层 `Connection error`，另外 2 个为 `invalid_tool_flow`、2 个为
> `progress_timeout`。因此该 execution 验收了 cache-aware ledger、fail-closed 封存与负结果发布，
> 不能证明 GLM-5.2 的诊断质量，也不能证明 ChronoRift 相对 generic arm 的优势。
> 当前交互诊断、real-Pi smoke 与 `test:live` 已迁移到
> `openai-codex/gpt-5.6-luna`、`thinkingLevel=max`。Benchmark V3 的 typed provider failure、结构化
> progress、串行零错误工具预算、receipt handle、严格 terminal manifest、sealed ledger 与
> 3+3 recovery 已落地；两次 Luna smoke（各 5 次工具调用，30,828 / 30,039 total tokens）和
> `test:live` 已通过。C0-001/002/003 均为 `not_ready`；历史 C0/C1-004 JSON 的 readiness
> 字段均为 `ready`，但它们缺少 V2 implementation receipt，强化 verifier 将其前置资格分类为
> `legacy_only`。它们不会被改写，也不能授权新的 hardened C1 或 freeze。新身份 005 的
> implementation-bound C0/C1 均已 `ready`，verifier 返回 `prerequisiteEligibility=hardened`，且
> C1 精确绑定已发布 C0 report hash。V3 machine spec 已生成并纳入
> `v0.3.2-luna-benchmark-freeze`。原 identity 的唯一 execution 写入了 36 组 started/finished/cell，
> 但因 3 个 unresolved proposal event references 未能写入 completed 或 report，因此不可发布；后续
> formal 使用独立 r1 identity。006 C1 暴露的 canary parser 缺陷已作为 interrupted 负证据保留；新
> 007 C0/C1 均为 `ready` / `hardened`，r1 machine spec 已生成并由
> `v0.3.2-luna-r1-benchmark-freeze` 固定。r1 已封存并发布真实负结果：3 cells 中 2 scored、1 invalid
> `harness_failure`，aggregate 为 `null`；verifier 通过，Gate 为 `not_evaluated` / exit 2；
> 后继 008 C0 也已原样封存为 `not_ready` / `not_eligible`：generic 因错误复制 baseline ID 产生一次
> tool error，full 缺少 source receipt。008 C1 未启动，008 不得复用。全新 009 C0/C1 均为
> `ready` / `hardened`：六个 cells 均 scored、mechanism correct、零工具/无进展/错误确认，且各有 2 个
> source receipts。r2 machine spec 已生成并由本地 annotated tag
> `v0.3.2-luna-r2-benchmark-freeze` 固定；formal 状态仍为 `selected=false` / `executionId=null`，尚未运行。
> 历史 V2、r1 与 008 证据不会被改写。

[Target Architecture](docs/architecture.md) 是长期演进北极星，不是一次性实现清单。当前 Godot
边界见 [Godot Protocol v2](docs/godot-protocol-v2.md)；面向简历/面试的事实摘要见
[v0.3.2 中文作品集](docs/portfolio-v0.3.2.md)。

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

### 首次正式结果（负结果）

[已验证报告](docs/benchmarks/v0.3/benchmark-report.v2.json)对应一个 `complete` execution：36/36 cells
均完成并封存，但全部是 `diagnostic_failure/proposal_missing`。每个 cell 只完成 1 次 baseline；三组
分别为 0/12 grounded success，总计 token 0、工具调用 0、游戏执行 36，incorrect confirmation 为 0。
因此完整性 verifier 通过，而预注册 Gate 失败。可读汇总与预选案例分别见
[results.md](docs/benchmarks/v0.3/results.md)和
[physics case study](docs/benchmarks/v0.3/case-study-physics-tunneling.md)。

公开的 sanitized report 只能证明没有形成 proposal，不能单独证明 provider 侧的具体根因。本地忽略的
raw ledger 在 36 个 finished manifests 中均记录 `PiHarnessError/PROPOSAL_MISSING: Connection error.`；
相同环境下两次独立 `corepack pnpm test:live` 也返回 `Connection error`。这些本地观测一致并强烈指向
连接路径，但不应改写为公开 report 已证明的 provider 归因。当前结果不能用于评价 GLM-5.2 的诊断
质量或比较三种 arm 的效果。

离线 `benchmark` 是保留的 V1 deterministic smoke，验证 Agent 工具流、权限、预算、基本矩阵和
Gate 编排，不作为产品优势数据。formal v2 selection、progress journal、retry/recovery 与 ledger
由 `corepack pnpm check` 中的离线测试验证。正式结果状态与复现实验协议见
[v0.3 evidence package](docs/benchmarks/v0.3/README.md)。

### v0.3.1-r2 provider-recovery 结果（负结果）

[r2 已验证报告](docs/benchmarks/v0.3.1-r2/benchmark-report.v2.json)对应唯一、完整的 36-cell
execution。三组 grounded success 仍均为 0/12，incorrect confirmation 为 0，Gate 因 full 未达到
9/12 且 full − generic 未达到 +0.20 而失败。与 v0.3 的零用量报告不同，本轮记录到 2,527,181
tokens、146 次工具调用和 36 次 baseline 游戏执行；非零用量集中在 4 个 cells。

本地 write-once ledger 进一步显示：32 个 `proposal_missing` 的底层错误为 `Connection error.`，2 个
cells 因 Pi 发起并发诊断工具调用而得到 `invalid_tool_flow`，2 个有持续进度但在 600 秒达到
`progress_timeout`。sanitized report 不导出底层错误文本，所以公开证据只能把前 32 个解释为 proposal
缺失；不能把这轮 aggregate 当作有效的 arm 能力对比。完整边界、汇总和预选案例见
[v0.3.1-r2 evidence package](docs/benchmarks/v0.3.1-r2/README.md)、
[results](docs/benchmarks/v0.3.1-r2/results.md)与
[case study](docs/benchmarks/v0.3.1-r2/case-study-physics-tunneling.md)。

### v0.3.2-luna 可靠性与 Benchmark V3（进行中）

V3 不改写 V2 artifact、hash 或 verifier。它把 provider 失败保留为 typed cause（阶段、错误
code、HTTP status 与 retry class），并持久化 model/tool/game/proposal 的单调 progress。只有
发生在诊断进展之前的 transient infrastructure failure 才可进入最多 3 次 initial attempts；
一次 recovery cycle 再提供最多 3 次 attempts。已观察到 model output、工具开始、诊断性
游戏执行或 proposal 后的基础设施故障不重试、不计分；证据不足仍由 Harness 输出
`inconclusive`，模型 confidence 不决定 confirmed。

诊断工具由 Pi 以 `executionMode=sequential` 调度，每 cell 最多 12 次工具调用、
0 次工具错误、0 个连续无语义进展结果。工具返回 `@rN` 短 receipt handle，提交时
由 Harness 解析回本 Session 中的精确 content-addressed receipt ID，不放宽引用完整性。

score-eligible attempt 必须封存 strict terminal raw manifest；manifest 精确绑定 suite/execution/cell/
attempt lineage、冻结 Fixture material、prompt audit、terminal progress/metrics、证据、receipt、proposal、
verdict 与 oracle。账本要求 terminal progress、finished attempt、cell 和 completed report 彼此精确对应，
finish 后拒绝追加 progress。Harness 按冻结的 baseline/replay/intervention/source/tool/game/time 等预算
重新校验，其中 replay、intervention 与 source 的 per-kind 用量从 canonical receipts 计算；超预算结果
不能成为 scored cell。公开报告不复制完整 raw manifest 或模型散文，只嵌入可独立重算分数的 sanitized
`scoringProofs`，并在封存时逐项核对其来自账本中被选中的 terminal manifest。

两次独立 Luna smoke 均以 5 次工具调用获得 Harness `confirmed`，total tokens 分别为
30,828 和 30,039；`corepack pnpm test:live` 随后通过。已发布的 C0-001、C0-002 和 C0-003
均为 `not_ready` 并作为负向工程证据原样保留。历史 C0-004 与 C1-004 报告的 readiness 字段
均为 `ready`，六个 cells 为零 tool errors、零无进展违规、零 incorrect confirmation；但二者是
缺少 implementation receipt 的 V1 linkage，强化 verifier 返回 `prerequisiteEligibility=legacy_only`。
新 identity 005 已完成 implementation-bound V2 C0/C1：[C0](docs/benchmarks/v0.3.2-luna/canary-c0-ready-005.json)
与 [C1](docs/benchmarks/v0.3.2-luna/canary-c1-ready-005.json) 均为 `ready`，verifier 的
`prerequisiteEligibility` 均为 `hardened`，C1 精确绑定 C0 report hash
`0c5ef20c0e8f16ee9d93175b36cb7b1fb85f9514c6d06e5267b3c9f7974545c1`。两阶段六个 cells
均 mechanism correct，并保持零 tool errors、零无进展违规、零 incorrect confirmation；C0 verdict
为 `confirmed`/`inconclusive`/`confirmed`，C1 三组均为 `inconclusive`。正式冻结的 canary 前置
现已满足；machine spec 已生成并由 `v0.3.2-luna-benchmark-freeze` 固定。原 36-cell execution 因
3 个 unresolved event references 未通过终态封存，没有 canonical report。修复后运行的 007 C0/C1
均为 `ready` / `hardened`，r1 spec 已冻结。r1 report 已以 `invalid` 发布：3 cells 中 2 scored、1
`harness_failure`，2 个 scoring proofs、aggregate `null`；verifier 通过，Gate 未评估。详见
[历史 v0.3.2-luna workspace](docs/benchmarks/v0.3.2-luna/README.md) 与
[r1 evidence workspace](docs/benchmarks/v0.3.2-luna-r1/README.md)。独立后继 008 C0 的两个 readiness
blockers 分别是 generic 的 `invalid_tool_flow` 和 full 的 `source_receipt_missing`，因此报告为
`not_ready`、前置资格为 `not_eligible`；C1 从未启动，008 不得复用。全新 009 C0/C1 已分别验证为
`ready` / `hardened`，C1 精确绑定 C0 report hash；六个 cells 均 scored、mechanism correct，且每个
cell 有 2 个 source receipts。r2 [machine spec](docs/benchmarks/v0.3.2-luna-r2/benchmark-spec.v3.json)
已生成，definition 为
`benchmark-definition:6c073ede350ba0ceb902353b6dd701eae589453b2a0717b59e357ac9be26eb09`，并由本地 annotated
freeze tag 固定；当前仍为 `selected=false` / `executionId=null`，没有 formal aggregate 或 Gate。原始
report hash、逐 arm 用量与边界见
[r2 evidence workspace](docs/benchmarks/v0.3.2-luna-r2/README.md)。

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

## 使用 ChatGPT OAuth / GPT-5.6 Luna Max

Pi 依赖固定为 `@earendil-works/pi-coding-agent@0.83.0` 与
`@earendil-works/pi-ai@0.83.0`，不修改、fork 或 vendor。凭据只写入 Pi 用户级 credential store，
不会复制进仓库、Session Capsule 或 benchmark report。该版本 Pi 的 `openai-codex` provider 使用
ChatGPT Plus/Pro OAuth；其目录为 Luna 声明 272,000 context、128,000 max output，并把 `max` 映射为
真实的 `max` reasoning effort。

```bash
# 首次登录：启动 Pi 后执行 /login openai-codex，并在浏览器完成 ChatGPT 登录
corepack pnpm pi \
  --no-session \
  --provider openai-codex \
  --model gpt-5.6-luna \
  --thinking max

# 登录后验证用户级凭据可解析的模型目录
corepack pnpm models -- --provider openai-codex

corepack pnpm diagnose:v03 -- \
  --fixture physics-tunneling \
  --provider openai-codex \
  --model gpt-5.6-luna \
  --thinking max
```

Pi OAuth 凭据保存在 `~/.pi/agent/auth.json`。不要复制或提交该文件。`corepack pnpm pi:smoke` 与
`corepack pnpm test:live` 默认使用上述 Luna Max 组合；diagnose 命令仍可通过参数或
`CHRONORIFT_PI_PROVIDER`、`CHRONORIFT_PI_MODEL` 显式选择 provider/model。此前
Volcengine/GLM-5.2 只保留为历史 campaign 事实和兼容代码，不再是当前运行默认值。

真实 provider 的探索运行与冻结正式运行是两个不同入口。`benchmark:explore` 允许调整参数，仅用于
调试基础设施；`benchmark:formal` 只接受冻结 spec、可选的同 execution 恢复 ID 与 Godot 二进制路径，
不接受 provider、model、thinking、seed、repetition 或 artifact-root 覆盖。formal、status 与 publish 固定使用
仓库下的 `.chronorift/`：

```bash
corepack pnpm pi:smoke

corepack pnpm benchmark:explore -- \
  --provider openai-codex \
  --model gpt-5.6-luna \
  --thinking max

# 历史 004 报告保持原字节；重验会显示 prerequisiteEligibility=legacy_only
corepack pnpm benchmark:canary:verify -- \
  --report docs/benchmarks/v0.3.2-luna/canary-c0-ready-004.json
corepack pnpm benchmark:canary:verify -- \
  --report docs/benchmarks/v0.3.2-luna/canary-c1-ready-004.json \
  --c0-report docs/benchmarks/v0.3.2-luna/canary-c0-ready-004.json

# 005 C0/C1 均为 ready/hardened；重验 C1 时必须提供它实际绑定的精确 C0 报告
corepack pnpm benchmark:canary:verify -- \
  --report docs/benchmarks/v0.3.2-luna/canary-c0-ready-005.json
corepack pnpm benchmark:canary:verify -- \
  --report docs/benchmarks/v0.3.2-luna/canary-c1-ready-005.json \
  --c0-report docs/benchmarks/v0.3.2-luna/canary-c0-ready-005.json

# r1 hardened 007；006 C1 是不可恢复的 interrupted 负证据
corepack pnpm benchmark:canary:verify -- \
  --report docs/benchmarks/v0.3.2-luna-r1/canary-c0-ready-007.json
corepack pnpm benchmark:canary:verify -- \
  --report docs/benchmarks/v0.3.2-luna-r1/canary-c1-ready-007.json \
  --c0-report docs/benchmarks/v0.3.2-luna-r1/canary-c0-ready-007.json

# r1 machine spec 已冻结；可重建测试会拒绝实现与 spec 漂移
corepack pnpm --silent benchmark:spec -- \
  --campaign v0.3.2-luna-r1 \
  > /tmp/chronorift-v0.3.2-luna-r1-spec.json

# 只读查看旧 identity 的 durable selection；不要再次运行或恢复它
corepack pnpm benchmark:status -- \
  --spec docs/benchmarks/v0.3.2-luna/benchmark-spec.v3.json

# 查看 r1 first-selection 状态
corepack pnpm benchmark:status -- \
  --spec docs/benchmarks/v0.3.2-luna-r1/benchmark-spec.v3.json

# 查看 r2 冻结 definition；formal 运行前预期 selected=false / executionId=null
corepack pnpm benchmark:status -- \
  --spec docs/benchmarks/v0.3.2-luna-r2/benchmark-spec.v3.json

corepack pnpm benchmark:verify -- \
  --spec docs/benchmarks/v0.3.2-luna-r1/benchmark-spec.v3.json \
  --report docs/benchmarks/v0.3.2-luna-r1/benchmark-report.v3.json

# 预期 exit 2：报告有效，但 execution invalid，Gate not_evaluated
corepack pnpm benchmark:gate -- \
  --spec docs/benchmarks/v0.3.2-luna-r1/benchmark-spec.v3.json \
  --report docs/benchmarks/v0.3.2-luna-r1/benchmark-report.v3.json
```

旧 selection `benchmark-execution:fd22f458-5640-4379-a290-a180dedb1c66` 没有 completed/report，不能
publish、verify 或运行 Gate。r1 必须使用新 spec、tag、definition 和 first selection，不得复用上述旧
spec 或 ID。

`pi:smoke` 使用 Luna Max、v0.1 Mock switch-door 与真实 Pi Session/Agent Loop，但不接触四个正式 Fixture；只有
Session 文件已持久化、token 和 tool call 均非零且 Harness verdict 为 `confirmed` 才返回成功。输出仅含
provider/model、thinking、用量与 verdict，不含 credential、prompt、Session ID 或本地路径。本轮 V3
campaign 的完整命令、冻结顺序和发布边界见
[v0.3.2-luna reproduction protocol](docs/benchmarks/v0.3.2-luna/reproduction.md)；历史证据目录不可覆盖。

`benchmark:live` 暂保留为 `benchmark:explore` 的兼容别名，但已弃用。每个 definition 在固定本地
ledger 中使用 `first-formal-execution-wins-v1`；selection 持久化后才输出 `executionId`，之后不得创建
第二个 non-resume execution。终端输出丢失时用 `benchmark:status` 找回该 ID。这是可审计的本地防
cherry-pick 规则，不是外部签名；拥有同一用户文件权限的人仍可删除整个本地 ledger。

V3 每个 attempt 持久化结构化、单调的 fixture/model/tool/game/proposal progress，并保留
typed infrastructure cause。只有诊断进展之前的 transient infrastructure failure 可重试：首轮
最多 3 attempts，唯一 recovery cycle 再最多 3 attempts。已有诊断进展后失败不重试、
不计分，避免通过重试筛选模型回答。恢复时 Harness 会把已中断 attempt 从最后一个 durable
progress 收敛成 terminal progress、finished attempt 与 terminal cell；已完成的 attempt 不会重跑，
已封存 execution 不能继续追加。V2 的三阶段 journal 与历史 retry 语义仅用于
重验已发布 artifact，不被 V3 迁移或改写。

`benchmark:verify` 验证 schema、canonical identity、严格 terminal manifest hash、sanitized
`scoringProofs` 的引用与机制条件、冻结 material/per-kind budgets、attempt/terminal ledger 对应、
oracle、聚合与 report hash；有效的负面或 incomplete 报告仍可完整性有效。封存到本地仓库时还会
把 report proof 与原始账本逐项对照。`benchmark:gate` 单独解释产品 Gate。
这不是 provider attestation，也不能证明模型请求确由声明供应商执行。正式 benchmark 需要网络与
用户凭据，不是默认 CI gate。

## 常用命令

| 命令                              | 作用                                   |
| --------------------------------- | -------------------------------------- |
| `corepack pnpm check`             | lint、格式、strict typecheck、离线测试 |
| `corepack pnpm test:godot`        | 四 Fixture v0.3 + v0.2 兼容集成测试    |
| `corepack pnpm demo:v03`          | 单 Fixture 离线完整诊断                |
| `corepack pnpm diagnose:v03`      | 单 Fixture 真实 provider 诊断          |
| `corepack pnpm pi`                | 启动仓库所依赖的 Pi CLI                |
| `corepack pnpm pi:smoke`          | 正式 Fixture 外的真实 Pi 链路 smoke    |
| `corepack pnpm benchmark`         | deterministic fake-model smoke         |
| `corepack pnpm benchmark:explore` | 可配置的真实 provider 探索运行         |
| `corepack pnpm benchmark:canary`  | 运行分阶段 V3 Luna canary              |
| `corepack pnpm benchmark:spec`    | 生成待提交的 formal V2/V3 机器 spec    |
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

每个文件以 create-only 方式写入；attempt 通过 previous hash 串联。每个 score-eligible finished
attempt 必须带 strict terminal raw manifest，并与最后一条 terminal progress、terminal cell、冻结
Fixture material 和 canonical budgets 精确一致；finish 后不能追加 progress。`completed.json` 只存在于
已封存 execution；首轮可恢复的 incomplete 尚未封存，不能 publish。发布器只导出 allowlisted、脱敏
字段以及无模型散文的 `scoringProofs`，不导出完整 raw manifest、prompt、源码正文、Pi Session 路径、
API key 或 credential store。历史 ledger 与
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
- v0.3 与 v0.3.1-r2 两个 formal execution 都完整且通过 report integrity verification，但都未产生
  grounded success；r2 又被 32 个底层连接错误主导，不能衡量三组 treatment 或模型诊断效果。
- V3 已保留 typed provider failure、串行化诊断工具、strict terminal manifest、sealed ledger、
  sanitized scoring proof，并在 verifier 施加冻结 material 与 per-kind budget；这些机制已离线回归，
  且 005 C0/C1 已达到 `ready`、verifier 前置资格为 `hardened`。原 36-cell execution 因三个悬空
  event references 未通过终态封存，不能作为 formal 评测结果。
- C0-001/002/003 均为 `not_ready` 且已保留；历史 C0/C1-004 的 readiness 字段为 `ready`，但强化
  verifier 只将其 V1 linkage 归为 `legacy_only`。005 与 007 C0/C1 的前置资格均为 `hardened`；
  006 C1 作为 interrupted 负证据保留。r1 只产生 3 cells 且 aggregate 为 `null`，Gate
  `not_evaluated`，因此目前仍没有 Luna 下的 treatment 优势结论。

下一步是修复 `invalid_proposal` 的预算分类漏项并增加回归；r1 报告及旧 spec、tag、selection 与
ledger 保持不变。后继 campaign 尚未冻结或执行。
真实 Godot 项目接入继续作为下一条独立垂直切片。
