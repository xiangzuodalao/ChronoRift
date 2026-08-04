# ChronoRift 路线图

## 当前里程碑：v0.3 benchmark-first Godot harness（已实现）

- 四个真实 Godot runtime-Bug Fixture 与 Protocol v2；
- Contract/Execution/Evidence/Proposal v2、checkpoint/replay、两个候选单变量实验与 Conclusion Gate；
- generic、evidence-only、chronorift-full 三组同预算 Pi Agent arm；
- 离线 fake-model matrix 与可恢复的 36-cell live benchmark；
- sanitized report 的完整性与优势门槛验证。

v0.1 Mock 与 v0.2 switch-door 路径继续作为兼容回归。下一步不是直接实现完整 Target
Architecture，而是先发布真实模型报告，再用一个仓库外真实 Godot 项目验证 Addon 接入成本、
checkpoint coverage 和 probe API。

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
