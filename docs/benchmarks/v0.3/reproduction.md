# v0.3 Reproduction Protocol

本流程把“代码/协议验证”和“需要付费 provider 的正式执行”分开。不要把 explore 或 fake-model
结果复制成 formal report。`benchmark-spec.v2.json` 已与 `v0.3.0-benchmark-freeze` 冻结；首个正式
report 已发布并通过完整性验证，但 Gate 失败。下述 spec/freeze 步骤记录维护者已执行的流程，不应在
普通复现中重新生成，也不得删除 first-execution selection 后另跑同一定义来替换负结果。

## 1. 维护者准备 machine spec 与 freeze

在最终实现通过检查后，先生成机器 spec：

```bash
corepack pnpm check
corepack pnpm test:godot
corepack pnpm benchmark
corepack pnpm --silent benchmark:spec \
  > docs/benchmarks/v0.3/benchmark-spec.v2.json
```

人工复核 spec 中 suite/subject/runner hash、模型、预算、矩阵、metric 和 Gate，再将实现与 spec 一起
commit。只有该 commit 干净且检查通过后，才创建并推送 `v0.3.0-benchmark-freeze` tag。不要先打 tag 再
生成或修改 spec；`benchmark:spec` 的输出是冻结定义，不是模型结果。

离线 `benchmark` 是 legacy `BenchmarkReportV1` deterministic smoke，只验证基本 Agent 工具流、权限、
预算、矩阵和 Gate 编排；它不经过 formal v2 selection/recovery ledger。formal v2 的 selection、progress、
retry/recovery 与发布状态机由 `corepack pnpm check` 中的离线测试覆盖。

## 2. 从冻结版本验证本地环境

正式执行必须从干净的 `v0.3.0-benchmark-freeze` checkout 开始：

```bash
git checkout v0.3.0-benchmark-freeze
git status --short
nvm use
corepack pnpm install --frozen-lockfile
corepack pnpm check
corepack pnpm godot:doctor
corepack pnpm test:godot
corepack pnpm benchmark
```

`git status --short` 必须为空。不要在复现 checkout 中重新运行 `benchmark:spec` 或修改已提交 spec。

## 3. 配置用户级 Pi credential

credential 只能进入 Pi 的用户级 store，不得写入仓库、`.env`、artifact 或报告：

```bash
read -rsp 'Volcengine Coding Plan API key: ' ARK_CODING_PLAN_API_KEY && echo
export ARK_CODING_PLAN_API_KEY
corepack pnpm auth:volcengine
unset ARK_CODING_PLAN_API_KEY

corepack pnpm models -- --provider volcengine-coding-plan
```

模型列表必须能解析 `glm-5.2`。formal preflight 会另外读取 Pi model metadata，验证 1M context、
128K max tokens 与 `max` thinking 映射，并在不匹配时 fail closed。

## 4. 可选 provider infrastructure smoke

如果 Pi path 本轮有变化，可先运行仓库约定的 live smoke：

```bash
corepack pnpm test:live
```

不得使用四个正式 Fixture 进行额外 live prompt/tool 调优；这会在同一校准集上继续过拟合。需要调试
runner 时使用 fake benchmark 或与正式 evidence package 隔离的 exploratory execution。

## 5. 启动或恢复正式执行

先读取 durable selection，不调用 provider：

```bash
corepack pnpm benchmark:status -- \
  --spec docs/benchmarks/v0.3/benchmark-spec.v2.json
```

若 `selected=false`，启动唯一的新执行：

```bash
corepack pnpm benchmark:formal -- \
  --spec docs/benchmarks/v0.3/benchmark-spec.v2.json
```

selection 会在输出 `executionId` 前持久化并回读。若终端输出丢失，再运行 `benchmark:status` 找回 ID；
若已经 `selected=true`，不要再次执行不带 `--resume` 的 formal 命令。只恢复该 ID：

```bash
corepack pnpm benchmark:formal -- \
  --spec docs/benchmarks/v0.3/benchmark-spec.v2.json \
  --resume EXECUTION_ID
```

若 selection 已写但 execution `started.json` 尚未写入，这个 resume 会启动初始周期，不消耗 recovery。
初始周期使用 ordinal 1–3；只有无 Agent/model/tool/game progress 的 closed infra failure 可自动重试。
首轮耗尽返回 exit `2` 且 JSON 为 `recoverable=true`，此时未写 `completed.json`、不可 publish；对同一 ID
resume 后打开唯一 recovery cycle（ordinal 4–6）。若恢复进程再次中断，可继续同一 ID 直到这个周期
耗尽，但不能开启第二个 recovery cycle 或超过六次绝对上限。

progress journal 的三个阶段是 `baseline_completed_unvalidated`、`fixture_material_validated` 和
`agent_progress`。baseline 阶段已发生的游戏执行会计入 metrics；Fixture binding 未验证便中断会封存为
invalid。只有 material 已验证且尚无 Agent progress 的允许类 infra failure 才可重试；观察到 token、
tool 或额外游戏进展后，中断属于 terminal diagnostic failure，不能重采样。

formal 返回 `0` 表示 36 cells 完整，不表示 Gate 通过。exit `2` 且
`recoverable=false,status=incomplete` 表示 recovery 已耗尽、execution 已封存并可发布。exit `1` 若
stdout JSON 为 `status=invalid`，表示 sealed invalid execution；没有该 JSON 时通常是命令或全局
preflight error，可能尚未分配 execution。

## 6. 发布、验证与 Gate

发布同一个已封存 execution：可以是正面、负面、invalid 或
`recoverable=false,status=incomplete`；不得发布首轮 `recoverable=true` incomplete：

```bash
corepack pnpm benchmark:publish -- \
  --execution EXECUTION_ID \
  --output docs/benchmarks/v0.3

corepack pnpm benchmark:verify -- \
  --report docs/benchmarks/v0.3/benchmark-report.v2.json

corepack pnpm benchmark:gate -- \
  --report docs/benchmarks/v0.3/benchmark-report.v2.json
```

发布器是 write-once；已有路径不同内容会失败。`verify=0` 只表示报告完整性有效。只有 `gate=0`
表示冻结门槛通过；`gate=2` 是有效负面或不可评估结果，应保留而不是重跑筛除。

## 7. 发布后的人工核对

在提交 evidence package 前确认：

- report 的 commit/tag/dirty、lockfile、Pi/Node/pnpm/Godot 与 model metadata 正确；
- provenance 含 `godotExecutableHash`、`requestedThinkingLevel` 与 `mappedThinkingLevel`；
- 36 个 canonical cell 或 incomplete/invalid 原因完整可见；
- attempt 链包含所有 retry、recovery 和 interrupted 记录；
- definition 下的 `selection.json`、attempt progress journal 与 completed/sealed 状态一致；
- `results.md` 数值与 JSON aggregate 一致；
- 预选 physics cell bundle 对应 full arm repetition 1，而非事后挑选；
- case bundle 明示 `evidenceCompleteness=complete|partial|unavailable`；partial/unavailable 时只保留已发布
  的计数和原因，不补写不存在的工具或 receipt 顺序；
- 没有 prompt、源码正文、Session 目录、用户名、主机路径、API key 或 credential 内容；
- README、CHANGELOG 与 case study 使用与 Gate 状态相符的措辞。
