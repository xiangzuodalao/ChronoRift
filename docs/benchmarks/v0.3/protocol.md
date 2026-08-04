# ChronoRift v0.3 Formal Benchmark Protocol

本文档冻结 v0.3 的正式评测语义。与 freeze commit/tag 一起提交的
`benchmark-spec.v2.json`（strict `BenchmarkSuiteSpecV2`）是机器权威；本文解释其设计，不替代
strict schema 或 Harness 重算。首个正式 execution 已完成并发布：report integrity 通过，但 36/36
cells 均为 `proposal_missing`，预注册 Gate 失败；详见 [results.md](results.md)。

## 评测问题与范围

评测使用同一个 `volcengine-coding-plan/glm-5.2` 模型，比较三种 runtime-evidence treatment 能否
对四个受控、显式插桩的 Godot Bug 产生 grounded diagnosis。四个机制为：

1. Signal 在 receiver connection 之前发出；
2. 用 frame count 表示输入时间窗口；
3. 低 physics TPS 下的离散采样穿透；
4. 延迟 effect 跨越 stable entity incarnation。

这些 Fixture 同时用于实现校准，因此 spec 明示
`calibrationStatus=calibrated_on_same_fixtures`。本评测是作品证据，不是独立 held-out 学术实验。

## 冻结身份与来源

`BenchmarkSuiteSpecV2` 分离三个变化维度：

- `suiteHash`：Fixture、Contract、input、intervention、oracle、opaque alias、预算、模型、指标和
  Gate 的语义定义；
- `subjectHash`：Evidence compiler 与 Pi tool flow 等被比较实现；
- `runnerHash`：formal scheduler、retry/resume、ledger 与 publisher 实现。

三者共同生成 `definitionId`。每个 definition 在固定 `.chronorift/` ledger 中使用
`first-formal-execution-wins-v1`，第一次持久化的 `selection.json` 唯一选择一个 `executionId`。Harness
会在输出 ID 前回读 selection；终端输出丢失时可用 `benchmark:status` 找回。恢复只能继续同一
`definitionId/executionId`，不能创建第二个 execution 或把不同实现或 suite 的 cell 拼成一份报告。
主指标定义另由冻结的 `metricSet=grounded-diagnosis-v2` 命名并进入 suite hash。

provenance 至少包含干净 Git commit、`v0.3.0-benchmark-freeze` tag、lockfile hash、Pi package、
Node/pnpm/Godot 版本、`godotExecutableHash`、操作系统/架构，以及解析后的 model name、context
window、max tokens、`requestedThinkingLevel` 与 Pi metadata 映射出的 `mappedThinkingLevel`。Session
实际生效的 thinking level 属于 per-attempt fail-closed audit，不冒充可持久化的 provider attestation。

## 盲化与三组 treatment

三组 Agent 接收 byte-identical system prompt、user prompt 和 `FailureBriefV1`。prompt 不出现 arm
名称；Fixture 与 intervention 使用 opaque ID。唯一自变量是 active tool set：

| Arm               | Active runtime evidence tools                                     |
| ----------------- | ----------------------------------------------------------------- |
| `generic`         | raw baseline、raw replay、allowlisted experiment                  |
| `evidence-only`   | Evidence Capsule v2、strict replay                                |
| `chronorift-full` | Capsule、strict replay、allowlisted experiment、canonical compare |

三组都有相同的 neutral source read/search 与 proposal submission。源码只以 `case/main.gd` 暴露；
真实文件、项目、scene、UI 和 Fixture 名不进入 Agent-facing view。所有 evidence/source access 都生成
content-addressed `EvidenceAccessReceiptV1`，proposal 只能引用当前 investigation 中实际返回的 receipt。
源码位置只有在 receipt 精确覆盖被评分 symbol 时才计入 source-grounded 次级指标。

三组均没有 shell、写文件、源码修改、Contract/evaluator 修改、任意 artifact 查询或超出当前
Fixture 的文件访问。请求的 control 只有获得 matching realized receipt 后才算实验事实。

## 预算与矩阵

冻结上限是：baseline 1、replay 1、intervention 2、总游戏执行 4、source call 4、并发 1、每 cell
600 秒。arm 没有某项工具时，不会把该预算兑换成其他权限。

矩阵为 4 Fixture × 3 arm × 3 repetition，共 36 cells。固定 order seed
`chronorift-v0.3-formal-1` 确定 Fixture/repetition block 顺序及每个 block 内的 arm 顺序，防止某一 arm
总在固定 provider 时段运行。provider 不提供 sampling seed，所以 repetition 不是可完全复现的独立
随机样本。

预先选定的公开案例是 `physics-tunneling / chronorift-full / repetition 1`。选择发生在运行前；结果
不好也不更换案例。

## 全局 preflight 与 per-attempt audit

正式入口先在分配 `executionId`、写 selection/ledger 之前执行全局 preflight，fail closed 地确认：

- committed machine spec 可由当前实现精确重建；
- provider 为 `volcengine-coding-plan`、model ID 为 `glm-5.2`；
- resolved context window 为 `1,000,000`、resolved max tokens 为 `128,000`；
- Pi metadata 中 `thinkingLevelMap.max` 为 `max`；
- checkout 干净且精确位于 freeze tag；
- lockfile、Pi/Node/pnpm/Godot 版本、Godot binary hash、平台和请求配置可写入 provenance。

这些全局检查失败属于命令/preflight error：退出 `1`，不分配 execution，也不会伪造一个 `invalid`
execution。它不能降级到其他模型、thinking level 或 token 上限。

每个 attempt 创建真实 Pi Session 后、第一次 `session.prompt` 前，还会检查 Session effective thinking
level 为 `max`，并通过 in-memory settings 禁用 Pi SDK 自动 retry。此时 selection、execution 和 attempt
已经开始，因此不匹配会被如实封存为 `invalid` attempt/execution，而不是抹掉已发生的正式尝试。

## 评分与 canonical verdict

Agent 输出 `DiagnosisProposalV3`：机制、evidence event、baseline/replay、候选执行、comparison、访问
receipt、可选 source locus、blocker、下一实验和 confidence。Agent 只提交 proposal；Harness 对引用
归属、event、receipt、lineage、checkpoint/replay、realized controls、candidate 与 comparison 重新
验证并产生 canonical `confirmed|inconclusive`。

`generic` 的 compare 不需要由 Agent 工具直接返回：提交后，Harness 只为 proposal 实际引用的
candidate 生成 canonical compare 再裁决。`chronorift-full` 必须引用其实际读取的 candidate 与 compare。
`evidence-only` 没有 intervention，因此证据达不到机制确认条件时必须得到 `inconclusive`。

主 cell 指标定义为：

```text
groundedSuccess = mechanismCorrect && verdict == confirmed
incorrectConfirmation = !mechanismCorrect && verdict == confirmed
```

模型 confidence 不参与 verdict、主指标或 Gate。mechanism accuracy、source grounding、tokens、工具
调用、游戏执行和 wall time 都是次级描述指标。

完整 36-cell report 的冻结 Gate 同时要求：

- `chronorift-full` grounded successes ≥ 9/12；
- `chronorift-full` grounded-success rate − `generic` rate ≥ 0.20；
- `chronorift-full` incorrect confirmations = 0。

其他 arm 的 incorrect confirmations 会报告，但不否决这一个预注册 Gate。incomplete 或 invalid
report 没有 aggregate，Gate 状态为 not evaluated。

## Attempt、重试与恢复

每个 attempt 在调用前写 `started.json`，完成后写 `finished.json`；attempt 以 ordinal 和 previous hash
形成不可变链。cell 只在得到 terminal outcome 后写入。进程崩溃留下的 started-only attempt 在恢复时
被封存为 `interrupted`，不能假装没有发生。

attempt 的 append-only progress journal 区分三个阶段：

1. `baseline_completed_unvalidated`：baseline 已实际执行，游戏执行成本计入 metrics，但 Fixture material
   尚未通过 hash/binding 检查；若在这里中断，恢复会封存为 Harness invalid，不能重采样；
2. `fixture_material_validated`：Contract/input/intervention/oracle/source binding 已验证，baseline 成本保留；
   若 Agent 尚无任何进展便中断，可进入 closed infra retry；
3. `agent_progress`：已观察到模型 token、Agent 工具或额外游戏执行进展；此后中断、timeout 或 provider
   故障都是 terminal diagnostic failure，不能以重试换取另一份模型样本。

因此 closed classifier 只允许在尚未观察到 Agent/model/tool/game progress 时重试 connection error、HTTP
408、429、5xx、timeout，以及同阶段可恢复的 process interruption。初始 execution 中，每个 cell 是
initial 加最多两次 infra retry，backoff 为 1 秒、3 秒（ordinal 1–3）；三次仍为 infra failure 时返回
`status=incomplete,recoverable=true`，execution 保持未封存，不能 publish。

用户随后只能对同一 selected execution 使用 `--resume`。这会打开唯一的 recovery cycle：recovery 加最多
两次 infra retry（ordinal 4–6）。若 recovery 进程本身再次中断，可以继续用同一 ID 恢复尚未耗尽的该
周期，但不能开启新的周期或超过六次绝对上限。recovery 耗尽后得到
`status=incomplete,recoverable=false`，写入 `completed.json` 并可按失败结果发布。若 selection 已写但
`started.json` 尚不存在，`--resume` 只是启动初始周期，不消耗 recovery cycle。

以下是 terminal diagnostic failure，不重试：模型已经有进展后的 timeout、没有 proposal、invalid
proposal、invalid tool flow、ID/reference 错误或预算耗尽。认证失败、模型 metadata 不兼容、其他 4xx、
Harness/Godot/schema 故障使执行 invalid。恢复会跳过已有 terminal cell，只继续未开始或仍符合上述
重试规则的 cell。

## Ledger、发布与验证

正式原始状态写到被 Git 忽略的目录：

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

写入使用 create-only 语义；相同路径只允许相同内容的幂等重试。ID 不是路径，adapter 拒绝 absolute、
`..`、分隔符、symlink 和 canonical-path escape。formal、status 与 publish 固定使用仓库内
`.chronorift/`，不接受 artifact-root 覆盖。first-selection ledger 防止普通误操作或按结果另开 execution，
但它是同一用户权限下的本地状态，不是防删除、防全量重写或第三方执行真实性的 attestation。

`completed.json` 只在 execution 已封存时存在。完整、invalid 和 recovery-exhausted incomplete 都是 sealed；
首轮 `recoverable=true` incomplete 尚未封存，必须恢复且不能 publish。

`benchmark:publish` 从一个 execution 生成 write-once sanitized report、Markdown 汇总和预选 case
bundle。`benchmark:verify` 重验 strict schema、suite/definition/cell identity、attempt hash chain、
fixture oracle、score、aggregate 与 report hash。它只回答“报告内部是否与仓库规则一致”，不回答
“Gate 是否通过”，也不构成 provider attestation。预选 case bundle 明示
`evidenceCompleteness=complete|partial|unavailable` 和 unavailable reason；中断只留下计数时，发布器不会
重建或虚构缺失的 tool/receipt 顺序。

## CLI 与退出码

```bash
corepack pnpm benchmark
corepack pnpm benchmark:explore -- --provider volcengine-coding-plan --model glm-5.2 --thinking max
corepack pnpm --silent benchmark:spec > docs/benchmarks/v0.3/benchmark-spec.v2.json
corepack pnpm benchmark:formal -- --spec docs/benchmarks/v0.3/benchmark-spec.v2.json
corepack pnpm benchmark:status -- --spec docs/benchmarks/v0.3/benchmark-spec.v2.json
corepack pnpm benchmark:formal -- --spec docs/benchmarks/v0.3/benchmark-spec.v2.json --resume EXECUTION_ID
corepack pnpm benchmark:publish -- --execution EXECUTION_ID --output docs/benchmarks/v0.3
corepack pnpm benchmark:verify -- --report docs/benchmarks/v0.3/benchmark-report.v2.json
corepack pnpm benchmark:gate -- --report docs/benchmarks/v0.3/benchmark-report.v2.json
```

| Command            | Exit `0`                             | Exit `1`                                   | Exit `2`           |
| ------------------ | ------------------------------------ | ------------------------------------------ | ------------------ |
| `benchmark:formal` | complete，不论 Gate                  | sealed invalid，或 command/preflight error | incomplete         |
| `benchmark:verify` | integrity valid，包括负面/incomplete | tampered/invalid/command error             | 不使用             |
| `benchmark:gate`   | pass                                 | tampered/invalid/command error             | fail/not evaluated |

`benchmark` 是 deterministic fake smoke。`benchmark:explore` 可以调参数但不能产出 formal claim；
`benchmark:live` 是已弃用的 explore 兼容别名。该 fake 路径仍产出 legacy `BenchmarkReportV1`，不经过
formal v2 selection/recovery ledger；formal v2 状态机由 `corepack pnpm check` 中的离线测试覆盖。
`benchmark:spec` 只是 freeze 前的维护者生成步骤，输出 spec 不是模型结果，也不意味着正式执行已发生。

formal 的 exit `2` 必须结合 stdout JSON 判断：`recoverable=true` 表示未封存、只能恢复；
`recoverable=false,status=incomplete` 表示 recovery 已耗尽并封存、可以发布。exit `1` 若有 formal JSON
且 `status=invalid`，表示已封存 invalid execution；否则是命令或全局 preflight 错误，可能根本没有
execution。
