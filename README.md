# ChronoRift

ChronoRift 是一个基于 Pi SDK 的 game-native Agent Harness。它把游戏运行时的
Signal、属性变化、输入与日志编译成紧凑的状态差分、事件链和异常证据，让 Agent
可以复现、定位并验证运行时问题，而不必直接消费大量原始帧日志。

当前仓库聚焦 Phase 1：使用一个确定性的 Mock Game Environment 跑通“开关已触发、
门却没有打开”的完整诊断链路。Pi SDK 精确锁定为
`@earendil-works/pi-coding-agent@0.83.0`；旧的 `@mariozechner` scope 已迁移，不应再用于
新增依赖。

## Phase 1 范围

Phase 1 的目标是建立边界清晰、可测试、可替换的最小闭环：

1. 从 checkpoint 启动 Mock Game Environment。
2. 执行开关输入，记录 Signal、状态变化、tick 与输入轨迹。
3. 用确定性时序不变量判断“开关激活后两 tick 内门必须打开”。
4. 在门未打开时生成状态差分、事件链和带稳定 ID 的异常证据。
5. 让真实 Pi Session 中的 Agent 通过受限工具读取证据、创建实验 timeline 分支、
   replay 并比较结果。
6. 输出可解析的 `DiagnosisReport`，引用证据和实验分支，而不是依赖自然语言快照。
7. 将 manifest、checkpoint、trace、branch lineage、evidence 与 report 持久化为版本化
   JSON/JSONL artifact，使进程退出后仍可恢复和重放。

Agent 在本阶段可以读取受限范围内的源码，但不会获得写文件或任意 shell 权限，也不
负责自动修改源码。普通测试完全离线、确定性运行；真实模型调用单独放在 live 测试中。

### 明确非目标

- 不接入真实 Godot 进程或编写完整 Godot 插件。
- 不做截图、视频理解或其他视觉能力。
- 不做多 Agent 调度。
- 不做复杂 Web/桌面 UI。
- 不修改 Pi 源码。
- 不在 Phase 1 自动编辑游戏源码或提交修复。

## Mock 时序 Bug

Mock 门逻辑故意把“延迟已到”错误地写成精确时间相等判断，而不是“大于等于”。门被
安排在 `32,000µs` 打开：`16,000µs` 的步进会精确命中目标，门能够打开；默认
`16,667µs` 的步进会从 `16,667µs` 跳到 `33,334µs`，永远不会精确命中，门保持关闭。

ChronoRift 从同一个 checkpoint 创建不同 timeline 分支，只改变 frame duration，再
重放相同输入轨迹。分支间的不同结果为“帧步进敏感的精确时间比较”提供可重复证据。

## 架构概览

依赖始终从右向左：

```text
domain ← gamebranch ← adapters ← CLI
```

- `domain`：纯类型、值对象、事件、状态差分、证据、manifest 与诊断报告契约。
- `gamebranch`：checkpoint、timeline、branch、replay、遥测归一化、规则评测与证据编译。
- `adapters`：Mock 游戏、JSON artifact store 和 Pi harness 等外部能力适配器。
- `CLI`：composition root，只负责装配依赖和暴露命令。

内层不导入外层实现；更换 Mock 环境、artifact backend 或 Agent provider 时，不需要改动
核心分支与评测逻辑。更完整的说明见
[架构文档](docs/architecture.md) 与 [路线图](docs/roadmap.md)。

## 项目结构

```text
chronorift/
├── apps/
│   └── cli/                 # demo、replay、diagnose、models 命令与依赖装配
├── packages/
│   ├── domain/              # 无 I/O 的领域契约
│   ├── gamebranch/          # timeline、checkpoint、replay 与证据编译
│   ├── mock-game/           # 确定性开关/门环境及故意植入的时序 Bug
│   ├── json-artifacts/      # 版本化 JSON/JSONL 持久化适配器
│   └── pi-harness/          # Pi Session、受限 Agent 工具与结构化诊断
├── docs/
│   ├── architecture.md
│   └── roadmap.md
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── vitest.config.ts         # 默认离线测试；排除 live
└── vitest.live.config.ts    # 仅真实 Pi 模型 smoke test
```

运行产物默认放在 `.chronorift/`，该目录不会提交到 Git。

## 环境与安装

要求 Node.js `>=22.19`。仓库提供 `.nvmrc`，当前固定为 Node `22.23.1`；pnpm 固定为
`11.20.0`。

```bash
nvm use
corepack enable
corepack prepare pnpm@11.20.0 --activate
pnpm install
```

## 常用命令

```bash
pnpm build          # 构建所有 TypeScript project references
pnpm typecheck      # 严格类型检查
pnpm test           # 离线、确定性测试，不调用模型
pnpm lint           # ESLint
pnpm format:check   # Prettier 检查
pnpm check          # lint + format + typecheck + 离线测试
pnpm demo           # 运行 Mock 失败、证据生成、分支与 replay 演示
pnpm models         # 列出当前 Pi 可用模型
pnpm replay -- --branch <branch-id> # 从磁盘 artifact 严格重放已有分支
```

本次初始化已在 Node.js `22.23.1` 下验证 `build`、`check`、`demo` 与跨进程
`replay`。`test:live` 仍取决于本机 Pi 认证。

### 真实 Pi 诊断与 live 测试

真实模型调用复用 Pi 的本地认证存储。不要把 API key 或认证文件提交到仓库。live 测试
默认使用 `volcengine-coding-plan/glm-5.2`，也可通过环境变量覆盖：

```bash
# 在持有 ARK_CODING_PLAN_API_KEY 的 shell 中执行一次；不会打印密钥
pnpm auth:volcengine

pnpm test:live

CHRONORIFT_PI_PROVIDER=<provider> \
CHRONORIFT_PI_MODEL=<model> \
pnpm test:live

pnpm diagnose -- --provider <provider> --model <model>
```

`pnpm test:live` 只运行 live 测试，需要有效的 Pi 本地凭据；缺少认证不属于默认离线测试
失败。live 测试验证结构化报告、证据 ID 引用与实验分支对比，不对模型的自然语言做固定
快照。

## 可恢复调试

一次 run 的 manifest 关联以下信息：Pi Session ID、模型标识、Git commit/dirty 状态、
环境版本、checkpoint ID、随机种子、输入 trace 哈希和 timeline lineage。一个诊断过程
使用一个 Pi Session，在该 Session 内可以创建多个 GameBranch；游戏 timeline 分支不会
隐式分叉 Pi Session。

replay 的最小身份由 checkpoint、seed、输入 trace 和运行参数共同决定。每个子分支记录
父分支、分叉 checkpoint 以及变量覆盖，因此可以从同一状态比较 frame duration 等单一
变量，而不会丢失来源链。

## 下一步

Phase 1 稳定后，将新增 Godot adapter，而不是把 Godot 细节渗入 `domain` 或
`gamebranch`。计划包括稳定的节点/属性标识、Signal 与日志采集、可控 tick、输入注入、
checkpoint 恢复、headless replay 和 Godot 版本环境引用。视觉、多 Agent 与复杂 UI 仍将
保持在后续范围之外；详见 [路线图](docs/roadmap.md)。
