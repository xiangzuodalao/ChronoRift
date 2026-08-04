# ChronoRift

ChronoRift 是一个基于 Pi SDK 的 **game-native Agent Harness**。它把游戏运行时 Bug 转换成可恢复、
可干预、可重放、可比较，并最终由 Harness 而不是模型置信度裁决的实验。

> 当前版本：**v0.2 真实 Godot 垂直闭环**。仓库保留 v0.1 Mock 路径，并已用 Godot 4.7.1、
> Addon/Autoload、版本化 TCP 协议、L0/L2 checkpoint 和独立 Godot 进程跑通同一个
> switch-door 诊断链。

长期目标与当前实现边界见 [Target Architecture](docs/architecture.md)。该文档是演进北极星，
不是要求一次性实现的功能清单。Godot wire 细节见 [Godot Protocol v1](docs/godot-protocol-v1.md)。

## v0.2 垂直闭环

```text
冻结 Contract：switch.activated 后 1 tick 内 door.open == true
→ 从带 coverage certificate 的 Godot checkpoint 执行 tick-0 输入
→ InputEventAction 进入真实 Godot 输入阶段
→ Signal 已发出，但 door receiver 尚未连接
→ receiver 随后连接，错过的 Signal 不会补发，door.open=false
→ 编译 closed Evidence Capsule
→ Agent 调用 baseline replay，产生新的 sealed Execution
→ Agent 只把同一输入延迟 1 tick
→ receiver 先连接，Signal delivery=true，door.open=true
→ Agent compare 并提交 DiagnosisProposal
→ Harness 重验 lineage、receipt、certificate、引用和机制事实
→ 输出 confirmed 或带 blocker/下一实验的 inconclusive
```

`corepack pnpm demo:godot` 会让 baseline、strict replay 和 intervention 分别启动新的 Godot
进程。deterministic model 仍通过真实 Pi `createAgentSession`、Agent Loop、工具调度和持久化
Session；它不需要凭据或网络。`corepack pnpm demo` 继续提供快速 Mock 路径。

## 为什么它不是普通代码 Agent 演示

- `BranchSpec` 与 `ExecutionLog` 分离；每次 replay 都产生新的 immutable Execution。
- requested control 不是事实，只有 runtime 返回的 realized receipt 才能进入证据。
- Godot receipt 区分 logical tick、process frame、physics tick、simulation delta 和 host monotonic
  time，不把 Mock `deltaUs` 伪装成引擎精确单步。
- `signal_delivery` 区分 Signal emission 与 receiver delivery。
- Addon 只采集 Contract 相关 allowlist；每一步记录 dropped/truncated event、backpressure 和 probe
  overhead。
- L0/L2 checkpoint 都携带 consistency、semantic barrier、coverage、missing domains 和 restore
  validation；未覆盖的引擎内部状态保持显式。
- Agent 只有 Capsule、replay、单一 intervention、compare 和 proposal 五类工具，没有 shell、
  源码读取、文件写入或修改 Contract 的能力。
- Proposal 是不可信假设。即使 Agent `confidence=0`，证据充分时 Gate 仍可 `confirmed`；高置信度
  但证据不足时只能 `inconclusive`。

## 项目结构

依赖方向保持为：

```text
domain ← gamebranch ← adapters ← CLI composition root
```

```text
apps/cli                      # 参数解析与 composition root
packages/domain               # engine-neutral DTO、ID、strict Zod schema
packages/gamebranch           # experiment、replay、evidence、comparison、Gate
packages/godot-protocol       # wire DTO、payload hash、TCP length framing
packages/godot-adapter        # TCP Host、进程监督、能力协商、runtime port
packages/mock-game            # deterministic switch-door Mock
packages/json-artifacts       # write-once 本地 artifact adapter
packages/pi-harness           # Pi Session/Loop 与五个受限工具
godot/addons/chronorift       # 最小 EditorPlugin + ChronoProbe Autoload
fixtures/godot-switch-door    # 可视 2D / headless Godot Fixture
```

Pi 与 Godot 类型不会进入 domain/gamebranch。运行时会把 Addon 与 Fixture 复制到被忽略的
`.chronorift/godot-projects/`，不依赖 symlink，也不提交生成项目。

## 快速开始

要求 Node.js `>=22.19`。`.nvmrc` 固定 Node.js `22.23.1`，pnpm 固定 `11.20.0`。

```bash
nvm use
corepack pnpm install
corepack pnpm check

# 快速 Mock 闭环
corepack pnpm demo

# 真实 Godot v0.2
corepack pnpm godot:install
corepack pnpm godot:doctor
corepack pnpm demo:godot
corepack pnpm test:godot
```

无需全局安装 pnpm。系统找不到 `pnpm` 时使用 `corepack pnpm <command>`；若 `corepack` 不在
当前 Node 版本，可先 `nvm use` 切换到仓库固定版本。

成功的 Godot demo 会显示：

```text
ChronoRift v0.2 — confirmed
Original baseline: ... (fail)
Strict replay:     ... (fail)
Intervention:      ... (pass)
Agent confidence:  0 (advisory; ignored by the Gate)
```

## 常用命令

| 命令                                                                   | 作用                                           |
| ---------------------------------------------------------------------- | ---------------------------------------------- |
| `corepack pnpm check`                                                  | lint、格式、严格类型检查和全部离线 Mock 测试   |
| `corepack pnpm demo`                                                   | Mock + 真实 Pi Loop + deterministic model      |
| `corepack pnpm godot:install`                                          | 安装并校验固定 Godot 4.7.1 Linux x86_64 binary |
| `corepack pnpm godot:doctor`                                           | 验证 binary、Addon、Fixture、协议和能力        |
| `corepack pnpm demo:godot`                                             | 运行真实 Godot 三 Execution 诊断闭环           |
| `corepack pnpm test:godot`                                             | 独立 Godot L0/L2 集成测试                      |
| `corepack pnpm replay -- --execution ID`                               | 按 artifact 中的 adapter 重放 Execution        |
| `corepack pnpm diagnose -- --provider P --model M`                     | 用真实 provider 诊断 Mock                      |
| `corepack pnpm diagnose -- --environment godot --provider P --model M` | 用真实 provider 诊断 Godot Fixture             |
| `corepack pnpm models -- --provider P`                                 | 列出 Pi 当前可用模型                           |
| `corepack pnpm auth:volcengine`                                        | 持久化火山 Coding Plan 用户级 API key          |
| `corepack pnpm test:live`                                              | 真实 provider live test                        |

Godot binary 查找顺序是 `--godot-bin PATH`、`GODOT_BIN`、仓库内被忽略的受管 `.tools/`。安装命令
固定 Godot 4.7.1 Linux x86_64，并同时校验仓库记录的 SHA-256 与官方 SHA-512。默认 `check` 不下载
Godot、不读取凭据，也不访问网络。

## 使用真实 Pi 模型

Pi 依赖固定为 `@earendil-works/pi-coding-agent@0.83.0` 和
`@earendil-works/pi-ai@0.83.0`，不修改、不 fork、不 vendor Pi 源码。真实模型复用 Pi 用户级
credential store，凭据不会复制到仓库或 artifact。

```bash
read -rsp 'Volcengine Coding Plan API key: ' ARK_CODING_PLAN_API_KEY && echo
export ARK_CODING_PLAN_API_KEY
corepack pnpm auth:volcengine
unset ARK_CODING_PLAN_API_KEY

corepack pnpm models -- --provider volcengine-coding-plan

corepack pnpm diagnose -- \
  --environment godot \
  --provider volcengine-coding-plan \
  --model glm-5.2
```

真实模型仍只能使用五个受限工具。发布前的真实模型 smoke test 是手动 gate，不把云端凭据放入
GitHub Actions。

## Artifact、checkpoint 与 replay

当前兼容 artifact envelope 仍位于 `.chronorift/v0.1/`：

```text
contracts/       # content-addressed frozen Contract
checkpoints/     # Mock snapshot 或带 certificate 的 Godot checkpoint
input-traces/    # content-addressed 输入轨迹
branch-specs/    # immutable baseline/intervention 规格
executions/      # sealed events、receipts、runtime fingerprint 与 digest
capsules/        # closed Evidence Capsule
comparisons/     # replay/intervention comparison
proposals/       # Agent 输出，不含 canonical verdict
verdicts/        # Harness Conclusion Gate 输出
runs/<run-id>/pi-sessions/
```

Repository 使用严格 schema、显式 `schemaVersion`、content hash、原子 write-once 发布和路径边界。
Godot L2 只恢复注册 participant；physics cache、Timer/Tween/coroutine、线程、未注册 RNG、resource
cache 和外部服务仍是 missing domains。一次 matching replay 只是当前 Fixture 的最小确认门槛，
不等价于完整 Determinism Certificate。

```bash
corepack pnpm replay -- \
  --execution 'execution:...' \
  --artifacts .chronorift
```

## 测试

```bash
corepack pnpm test       # 完全离线、确定性、无凭据、无网络
corepack pnpm check      # 默认完成门槛
corepack pnpm test:godot # 固定 Godot binary；无模型凭据
corepack pnpm test:live  # 真实 provider；需要用户级凭据和网络
```

Godot 测试验证 wire 分帧/hash/schema、真实 InputEventAction phase、process/physics receipt、L0
fresh-scene、L2 participant restore/validate、baseline fail、replay fail、intervention pass，以及
`confidence=0` 下由 Harness 得出 confirmed。

## 当前限制与路线图

v0.2 只支持一个显式插桩的 switch-door Fixture，不声称全局 Signal/property 拦截，也没有 OS
容器或网络沙箱。简单 2D 画面只用于人工演示，不进入 Agent 证据。

v0.3 计划增加 2～3 个代表性 Godot Bug Fixture，并建立普通日志诊断与 ChronoRift 在复现率、
错误确认率、实验次数和证据完整性上的可重复 benchmark。自动修复、Git worktree、World Graph、
Experiment DAG、视觉、多 Agent、完整 Determinism Certificate 和复杂 UI 继续延后，直到窄垂直
闭环证明需要它们。
