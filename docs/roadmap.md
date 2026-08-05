# ChronoRift 路线图

## 当前里程碑：GPT-5.6 Luna provider migration（实现中）

v0.3.1-r2 已完成并原样发布负结果。当前 real-Pi smoke、`test:live` 与探索诊断迁移到 Pi
`openai-codex/gpt-5.6-luna`、`thinkingLevel=max`，认证复用 ChatGPT Plus/Pro 的用户级 OAuth store。
迁移只改变当前 canary/探索路径；v0.3、v0.3.1 与 v0.3.1-r2 的冻结 spec、ledger 和报告仍保留原
Volcengine/GLM-5.2 事实。新正式矩阵必须先修复已知工具串行与基础设施分类问题，通过小规模 canary，
再使用新的 campaign identity、freeze tag、order seed 和发布目录。

## 已发布里程碑：v0.3.1-r2 provider recovery（负结果）

v0.3.1 不改写 v0.3 的正式负结果，也不改变 Fixture、arm、prompt、预算、模型或 Gate。它新增一个不接触
正式 Fixture 的真实 Pi smoke，要求持久化 Session、非零 token、至少一次工具调用与 Harness confirmed；
只有连续两次 smoke 和 `test:live` 通过后，才冻结新的 campaign identity、tag 与 order seed，执行新的
36-cell first-selection。结果无论正面、负面或 incomplete 都原样发布到 `docs/benchmarks/v0.3.1/`。

2026-08-05 已连续两次通过 smoke（均为 5 次工具调用，total tokens 33,562 / 43,087，Harness
confirmed）并通过 `test:live`；pre-freeze 的 `check`、Godot、fake benchmark 与历史 report 验证也已
通过。下一步是提交 machine spec、创建 freeze tag，再启动唯一 formal execution。

首个 v0.3.1 formal execution 在第一 cell 的真实 Pi 工具流后暴露 token-accounting schema 缺陷：Pi
total 包含 cache read/write，而 Harness 只校验 input + output；异常又越过 attempt 封存边界。原 freeze
tag 与 selection 已保留且不恢复拼接。r2 将 cache read/write 纳入严格总和，并为非法 provider metrics
增加 fail-closed 封存回归；它使用新的 campaign/tag/seed/output directory，再执行新的唯一 selection。

### v0.3.1 交付顺序

1. 保持 v0.3 spec/report verifier 兼容，并隔离 v0.3.1 campaign、seed、tag 与发布目录；
2. `corepack pnpm check`、`test:godot`、离线 benchmark 与旧报告重验；
3. 修复仓库外 provider 网络路径，连续两次 `pi:smoke` 与一次 `test:live` 取得非零真实用量；
4. 生成 v0.3.1 spec，与实现一起冻结在 `v0.3.1-benchmark-freeze`；
5. 运行唯一 36-cell execution，按既有 recovery 规则封存并发布，不 cherry-pick 或替换结果；
6. verifier 与 Gate 分开报告，再以 artifact 支持的措辞更新案例和 release notes。

## 已发布里程碑：v0.3 evidence release（正式负结果已发布）

本里程碑先修复评测有效性，再运行真实 provider：

- 保留四个真实 Godot runtime-Bug Fixture 与 Protocol v2；`entity-reuse` 改为真正跨 tick 的
  pending-effect / incarnation 污染，并覆盖 checkpoint/restore 与因果祖先证据；
- 新增 `FailureBriefV1`、`EvidenceAccessReceiptV1`、`DiagnosisProposalV3` 和 Benchmark spec/cell/
  report v2；Harness 重验所有引用，confidence 不参与 verdict；
- generic、evidence-only、chronorift-full 接收 byte-identical prompt 和 Failure Brief，只通过 active
  tools 区分；源码使用 neutral `case/main.gd` view 与 content-addressed receipt；
- 冻结 4 × 3 × 3、GLM-5.2 `max`、并发 1、block-randomized order、预算、retry/resume 和
  grounded-success Gate；
- 将 exploratory 与 formal runner 分开，formal 使用 durable first-execution selection、三阶段 progress
  journal 与 append-only attempt ledger；status、publish、verify 与 Gate 使用独立命令；
- evidence package 预注册 physics/full/repetition-1 案例，无论正面、负面或 incomplete 都发布。

v0.1 Mock 与 v0.2 switch-door 路径继续作为兼容回归。首个正式 execution 已完成，sanitized report
通过完整性验证，但 36/36 cells 均为 `diagnostic_failure/proposal_missing`：每个 cell 只有一次 baseline，
token 与工具调用均为 0，三组 grounded success 均为 0/12，incorrect confirmation 为 0，冻结 Gate
失败。这个负结果证明发布/验证链可以如实保留失败，**不能证明模型诊断效果或 ChronoRift 优势**。

本地 raw ledger 的 36 个 finished manifests 均记录
`PiHarnessError/PROPOSAL_MISSING: Connection error.`，同一环境两次独立 `test:live` 也返回
`Connection error`；这些本地观测强烈指向连接路径。但公开 formal report 只证明
`proposal_missing`，不能据此强行归因 provider。下一步先在正式 suite 外用 smoke 隔离连接路径，取得
非零 token 的真实 Pi Session，再用一个仓库外真实 Godot 项目验证 Addon 接入成本、checkpoint coverage
和 probe API。既有 first-execution selection 与本次负结果必须保留，不能通过删除 ledger 或另跑同一定义
来筛选结果。

### v0.3 已完成发布顺序

1. `corepack pnpm check`、`corepack pnpm test:godot` 与离线 fake benchmark；
2. 生成并人工复核 machine spec，与最终实现一起冻结在 `v0.3.0-benchmark-freeze`；
3. 从干净 freeze checkout 持久化唯一 first-execution selection 并完成 36-cell execution；
4. 发布 sealed execution 的 sanitized JSON、Markdown 表与预选 case bundle；
5. report integrity verifier 通过，独立 Gate 返回 fail；
6. 保留负结果并只使用 artifact 支持的措辞更新案例和 release notes。

## Phase 1：Mock Game 闭环

目标是用最小场景验证可恢复、可分支、可由真实 Agent 操作的诊断架构。

### 核心交付

- strict TypeScript + pnpm workspace monorepo。
- 纯 domain 契约和单向依赖边界。
- 确定性 Mock Game Environment 与开关/门时序 Bug。
- Signal、属性变化、输入、tick 和日志的规范化遥测。
- “开关激活后两 tick 内门打开”的确定性不变量。
- 状态差分、事件链和异常证据编译。
- checkpoint、timeline branch、受控 frame duration 与 replay。
- 版本化 JSON/JSONL artifact store，可跨进程恢复。
- manifest 关联 Pi Session、Git、environment、checkpoint、seed、trace 与 lineage。
- 基于 `@earendil-works` scope Pi SDK 的真实模型诊断入口。
- Agent 可读取证据、使用受限只读源码工具、创建/比较 GameBranch。
- 可解析 `DiagnosisReport`，引用 evidence 与 branch。
- 默认离线测试与独立 `test:live`。

### Phase 1 验收链

```text
开关输入
→ Signal 与 switch 状态变化被记录
→ 默认 frame duration 下门没有打开
→ 不变量失败并生成 diff/event chain/evidence
→ Agent 能读取证据
→ 从相同 checkpoint 创建 frame-duration 实验分支
→ replay 相同输入 trace
→ 比较成功/失败分支并输出结构化诊断
→ 新进程可从 artifact 恢复关键对象
```

普通 `pnpm test` 必须保持离线与确定性。`pnpm test:live` 使用真实 Pi Session 和模型，
需要外部凭据，因此不属于默认 CI 成功的前置条件。路线图中的条目是目标；只有实际命令
运行并通过后才应标记为已验证。

## Phase 1.1：边界加固

在进入 Godot 前，先稳定可演进接口：

- 为 artifact 和工具 payload 建立显式 schema migration 策略。
- 对损坏、缺失、版本不兼容的 checkpoint/trace 提供可诊断错误。
- 验证 trace hash、分支单变量覆盖和 replay 确定性。
- 为 Pi 工具添加参数 schema、权限边界、调用预算与审计日志。
- 处理模型拒绝、超时、非法 JSON 和无效 evidence 引用。
- 固化 provider/model 显式选择，并继续复用 Pi 本地认证存储。
- 跟踪 `@earendil-works` 包升级；不回退到已迁移的旧 scope，也不修改 Pi 源码。

## Phase 2：Godot 最小接入

Godot 作为新 adapter 接入，核心层继续只看 Game Environment 端口。

> v0.2 已完成本节的单 Fixture 最小闭环：Godot 4.7.1 Addon/Autoload、loopback TCP v1、
> allowlisted switch-door telemetry、真实 InputEventAction、process/physics receipts、L0/L2
> checkpoint、baseline replay、one-tick intervention 和现有 Conclusion Gate。以下未被该 Fixture
> 证明的条目仍是后续路线图，不应外推为通用 Godot 支持。

### 2.1 运行时桥接

- 选择清晰的进程通信协议并进行版本握手。
- 建立稳定的 scene/node/entity ID，避免仅依赖易变 NodePath。
- 采集允许列表中的 Signal、属性变化、输入、错误与结构化日志。
- 把 Godot frame/physics tick 映射到 ChronoRift 逻辑时钟。
- 对遥测做背压、大小限制和敏感字段过滤。

### 2.2 控制与恢复

- 支持 headless 启动和受控 logical step；v0.2 不声称拥有引擎级精确 frame/physics 单步。
- 注入带时间戳的确定性输入轨迹。
- 将 Godot save/snapshot 或场景重建机制适配为 checkpoint。
- 在 manifest 中记录 Godot 版本、项目构建、平台与 adapter 版本。
- 明确引擎/物理随机种子和无法控制的非确定性来源。

### 2.3 Replay 与评测

- 用 Phase 1 的 contract suite 验证 Godot adapter。
- 从相同 checkpoint 重放相同输入，并比较规范化遥测。
- 将 engine errors、Signal 缺失和属性不变量编译为同一 evidence 模型。
- 先用一个小型 Godot fixture 场景验收，再扩展到真实项目。

## Phase 3：修复与验证闭环

只有复现、证据和 replay 稳定后，才扩大 Agent 权限：

- 在隔离 Git worktree/实验分支中提供范围受限的写代码工具。
- 将代码 patch、Git revision、checkpoint 和验证 replay 绑定到 manifest。
- 自动执行 headless 回归场景，比较修复前后 evidence。
- 对非目标行为和性能建立回归评测，避免“门开了但引入新问题”。
- 保留人工审阅、变更范围限制和可回滚边界。

这一步仍不要求多 Agent；单一 Pi Session 与多个 GameBranch 足以先验证修复闭环。

## 延后项目与非目标

以下能力不属于 Phase 1 或首次 Godot 接入：

- 截图、视频、像素差异和视觉模型；
- 多 Agent 角色分工、协商或调度；
- 复杂 Web UI、timeline 可视化编辑器或云控制台；
- 分布式 artifact store 与大规模并行仿真；
- 修改或 fork Pi SDK 源码；
- 无边界的自动代码写入、shell 或发布权限。

这些能力只有在文本遥测、确定性 replay、lineage 和结构化评测已经证明可靠后，才值得
重新评估。

## 长期演进原则

1. **先证据，后结论**：规则违规和观测事实由系统产生，根因判断由实验支持。
2. **先确定性，后规模**：不能稳定 replay 的场景不适合并行放大。
3. **单变量分支**：实验分支应明确记录变量覆盖，避免不可归因的比较。
4. **可恢复优先**：Session、Git、checkpoint、trace 和 branch lineage 必须可追溯。
5. **端口稳定、适配器可换**：Godot、存储和模型供应商都不应污染核心领域层。
6. **权限逐步扩大**：Phase 1 只读诊断，修复写权限在验证边界成熟后再引入。
