# ChronoRift

ChronoRift 的目标是成为一个 **Codex 式的 game-native Agent Harness**：它托管受控的代码 workspace 和
Godot 运行环境，用 Pi SDK 驱动自主 Agent Loop，并为 Agent 提供普通游戏工具难以可靠实现的运行时
checkpoint、fork、replay、query 和 compare 原语。

> **产品方向、内部基础设施与当前公开实现必须分开阅读。**
> [Target Architecture](docs/architecture.md) 描述的是 vNext 北极星，尚未成为可用产品。当前公开可执行
> 版本仍是 **v0.4.0 legacy diagnosis slice**：它只有四个受控 Fixture，禁用通用 coding tools，要求
> 固定诊断流程，并由 Harness 输出 verdict。仓库已经加入 **vNext M1 internal foundation**，但它没有公开
> Task CLI、Pi Agent Loop 或 Godot runtime 接线，也不是 release。README 中标为“目标”的能力不是当前
> 命令的承诺。

## 产品契约（vNext 目标）

> Harness 只保证 Agent 的文件、命令和游戏操作在受控环境中被真实执行，并把真实输出返回给 Agent；
> Agent 负责自主调查、修改代码、选择并运行验证手段，并根据结果迭代；任务结果由 Agent 根据实际工具
> 执行结果产生；ChronoRift 的成功表示 Agent Loop 正常完成、留下候选修改，并同时展示底层记录中的
> 实际命令、游戏操作和验证结果，不表示系统已经从逻辑上证明 Bug 必然被彻底修复。

这个契约刻意限制 Harness 的权威：

- ChronoRift 负责 workspace、sandbox、真实工具执行、requested/realized receipt、schema、lineage、
  capture coverage、资源限制和安全拒绝；
- Pi 负责 Session、模型调用、工具调度和 Agent Loop；Agent 自主读码、形成假设、修改代码和选择验证；
- Agent 最终说明可能有误，不能覆盖底层 diff、命令输出、game execution 和工具记录；
- `completed` 只是 Loop 与交付状态，不等于 `verified`、`fixed` 或“已证明”；
- 项目测试、断言和未来可选 Game Contract 都只是 Agent 可调用的验证手段；
- 用户、项目 CI、人类 review 或独立 Eval 决定是否接受候选修改；
- 产品路径不产生 `confirmed`、`probable`、`inconclusive`、canonical diagnosis 或 canonical fix verdict。

严格 schema、路径校验、权限检查和 artifact 完整性仍然保留。它们证明环境边界和执行记录是否成立，不替
Agent 证明某个根因或修复成立。

## 为什么不只是 Godot MCP

如果 ChronoRift 最终只提供启动游戏、SceneTree、输入、截图和日志，它确实只应该是一个 Godot MCP
插件。独立 Harness 的价值在于把游戏运行时变成一个带身份、历史和 lineage 的状态版本系统。

以“跳跃输入偶尔漏接”为例：失败可能只发生在两个 physics tick 之间。普通重启会同时改变帧时序、对象
状态和输入落点，Agent 很难只改变一个条件。ChronoRift 的目标是保留失败附近的历史，从同一个声明过
coverage 的 checkpoint 分叉，再分别改变输入 phase、physics tick、probe 或代码，并对齐比较各次真实
Execution。

目标环境原语包括：

- 有预算的 pre-failure rolling black box；
- 带 manifest、coverage、fidelity 和缺失域的 checkpoint/restore；
- 任意已授权 Execution/checkpoint/build/workspace 的 lineage-aware fork；
- 区分 process frame、physics tick 和输入 phase 的 trace replay；
- 可重建、可查询的 Runtime State Index；
- 跨 Execution 的实体、时钟、状态和事件语义对齐；
- 对 first divergence、uncontrolled state、数据丢失、observer effect 和混杂项的诚实报告。

这些原语只回答“实际观察到了什么”和“已知差异是什么”。ChronoRift 不生成 causal slice、候选原因、根因
结论或下一实验建议；实验设计和解释留给 Agent。

## 目标运行方式

```text
用户启动 ChronoRift 并提供项目与目标
→ ChronoRift 创建 managed task workspace 与执行 sandbox
→ ChronoRift 使用 Pi SDK 创建 AgentSession
→ 加载正常 coding tools、AGENTS.md、skills 和 Godot tools
→ session.prompt(user goal)
→ Pi Agent Loop 自主调查、修改和验证
→ 模型输出普通最终结果，当前 turn 结束
→ ChronoRift 展示 diff、实际工具记录、Execution lineage 和资源/安全记录
→ 回收游戏进程与临时授权，保留 Session、workspace 和 artifacts
```

Agent 的 `cwd` 目标为任务 sandbox 内的 `/workspace`，来自受管的临时代码视图，而不是用户正在编辑的
checkout。coding tools 和 Godot 进程运行在无特权容器或等价 Linux namespace 中；网络、宿主文件、
凭据、设备和显示代理默认关闭，越界动作在执行前拒绝并形成结构化安全事件。模型侧 Pi Host 可以使用用户
自己的 Pi credential store，但工具和游戏进程不能继承这些凭据。

一次 `session.prompt()` 返回只结束当前 turn。候选 patch、Pi Session、Execution、checkpoint 和 trace
继续保留，直到用户继续对话、显式 handoff/apply、discard，或保留期到期。自动 commit、merge、push 和
直接修改用户 checkout 都不是成功条件。

具体边界、资源模型和迁移顺序见 [Target Architecture](docs/architecture.md)。Pi 集成遵循
[Pi SDK 官方文档](https://pi.dev/docs/latest/sdk)；workspace 和 sandbox 采用 Codex 式产品语义，但不
假设或复制其私有实现。

## 实现状态

下表描述 2026-08-07 的公开 v0.4 行为与最终目标；它不把内部 M1 组件写成公开命令能力。

| 维度       | 当前 v0.4                                              | vNext 目标                                                   |
| ---------- | ------------------------------------------------------ | ------------------------------------------------------------ |
| Pi         | 已使用真实 `createAgentSession` 和 Session persistence | 保留 Pi 默认 coding-agent 资源，收缩为薄 Loop host           |
| Agent 工具 | 受限诊断工具、固定 prompt/顺序、一次 Proposal          | 自主 `read/bash/edit/write/grep/find/ls` 与可组合 game tools |
| Workspace  | Fixture staging；不产生候选修复 worktree               | 隔离 `/workspace`、patch handoff 和可恢复任务                |
| OS sandbox | 尚未实现；opaque handle 不是进程隔离                   | 无特权 sandbox、默认禁网/凭据、资源限制和安全事件            |
| Godot      | Addon/Autoload、Protocol v2、四个显式插桩 Fixture      | 任意项目可注册 snapshot adapter/probe                        |
| Capture    | 有执行期 typed telemetry                               | 10 秒或 600 tick rolling buffer、pin/trigger 和预算退化      |
| Checkpoint | 只恢复 Fixture 注册的 participant                      | manifest-driven coverage、fidelity、restore receipt          |
| Replay     | 有 Fixture 输入/FPS/TPS control 与 realized receipt    | phase-aware trace、自由 fork 和 first divergence             |
| 世界查询   | typed event 与 legacy Capsule                          | 不含因果解释的 Runtime State Index                           |
| Compare    | baseline/candidate compare 服务于 verdict Gate         | 独立 descriptive compare、alignment ambiguity 和 confounders |
| 代码修改   | 不支持                                                 | sandbox 内修改、实际验证、reviewable patch                   |
| 结果       | Proposal → Harness Verdict                             | 普通 Agent 结果 + diff + 原始执行记录                        |

当前 v0.4 中的 `FrozenContractBundleV3`、`ClaimEvidencePolicyRegistry`、opaque handles、
`DiagnosisProposalV4`、`DiagnosisVerdictV3` 和固定 replay/intervention flow 是 legacy 可执行事实，不是
vNext 产品 API。

### vNext M1 internal foundation（非产品入口）

仓库当前已经实现并测试一组尚未接入公开 CLI 的 M1 内部组件与 internal composition：

- 对唯一受支持的 `frame-input-window` Fixture 执行 strict manifest、整仓 clean Git preflight、literal
  subtree 选择和 selected-tree identity 校验；
- 从 Git raw objects 创建任务私有 workspace、Agent 可写 Git 与 Host-only baseline Git，不 checkout、
  不执行项目 filter/hook，也不修改用户 checkout；
- 通过 bubblewrap、独立 namespace、固定 FD binding、cgroup v2、rlimit、输出上限和结构化 receipt/security
  event 执行受控命令；
- 从 Host baseline 提取 binary/full-index patch，重新应用并比对 selected-tree 后才标记
  `roundTripVerified`；显式 export 使用 create-new/no-overwrite 发布，Task store 支持受身份约束的 discard；
- 为 workspace/patch/tool/security/resource DTO 提供 strict versioned contracts，并实现独立 vNext Task
  namespace、append/seal、write-once 与 records-only discard 存储原语。

这些模块目前只能由测试或内部 TypeScript API 组合。仓库没有 `task start/continue/show/export/discard`
公开命令，没有把 Pi coding tools 接到 broker，没有启动 Godot，也没有发布任何 vNext 版本。M1 证明的是
workspace/sandbox/patch 边界可以成立，不证明 Agent Loop、游戏调查闭环或 Bug 修复已经成立。

## 首个 vNext 垂直切片（M1 之后）

首个且唯一的迁移 Fixture 是 `fixtures/godot-frame-input-window`。M1 只完成上述内部环境基础；后续目标是
让自由 Pi Agent 在该环境中调查并修改一个真实的输入时序 Bug，同时证明下列最小闭环：

1. managed workspace、OS sandbox 和安全的 coding/game tools；
2. rolling black box、pin 和可见的 capture budget/loss；
3. Fixture snapshot adapter、checkpoint manifest 与 restore fidelity；
4. checkpoint fork、输入 tick/phase replay 和 first divergence；
5. Runtime State Index 与只描述差异的 compare；
6. Agent 自主修改、运行它选择的验证并留下 patch；
7. Session/workspace/artifact 可继续、handoff 或清理；
8. 新路径没有 Proposal、Claim Policy、Causal Capsule、Conclusion Gate 或 canonical verdict。

真实模型 smoke 和公开 benchmark 不作为首个切片的默认完成门槛。切片稳定后，Eval 优先使用开源、可
复现 benchmark；若现有 benchmark 缺少 checkpoint/fork 类任务，再单独公开扩展规范。

## 当前 v0.4 快速开始（legacy）

要求 Node.js `>=22.19`；`.nvmrc` 固定 `22.23.1`，pnpm 固定 `11.20.0`。

```bash
nvm use
corepack pnpm install
corepack pnpm check

corepack pnpm godot:install
corepack pnpm godot:doctor
corepack pnpm fixtures

# 真实 Godot Fixture + 真实 Pi Loop + 离线 fake model
corepack pnpm demo:v04 -- --fixture frame-input-window

# 四个 Fixture 的 Godot 集成测试
corepack pnpm test:godot
```

仓库管理的 Godot installer 当前固定 Godot `4.7.1`，只支持 Linux x86_64。其他平台需要自行提供 Godot
二进制，并通过 `GODOT_BIN` 或命令支持的 `--godot-bin` 传入。系统没有全局 `pnpm` 时始终使用
`corepack pnpm <command>`。

### 真实 Pi provider（legacy）

Pi 依赖固定为 `@earendil-works/pi-coding-agent@0.83.0` 和 `@earendil-works/pi-ai@0.83.0`。已安装
package 的 source、types 和 model catalog 是本仓库实现的权威；升级必须附带兼容测试。

```bash
# 首次使用可启动仓库依赖的 Pi CLI，并在其中执行 /login <provider>
corepack pnpm pi --no-session

# 查看用户 credential store 当前可用的 provider/model
corepack pnpm models -- --provider openai-codex

# 当前历史 live 路径使用过的显式配置；不会选择“最新模型”
corepack pnpm diagnose:v04 -- \
  --fixture frame-input-window \
  --provider openai-codex \
  --model gpt-5.6-luna \
  --thinking max
```

Pi credential store 默认位于 `~/.pi/agent/auth.json`；设置 `PI_CODING_AGENT_DIR` 后会随 agent directory
改变。不要复制或提交它。当前 v0.4 还没有目标 OS sandbox，因此这里不能把“凭据不进入工具环境”描述为
已实现保证。只有 `*.live.test.ts` 和显式 live 命令可以访问 provider；默认测试离线、无凭据且无网络。

## 当前支持的 Fixture

| Fixture              | legacy 运行时 Bug                                | 可观察控制           |
| -------------------- | ------------------------------------------------ | -------------------- |
| `signal-ordering`    | Signal 在 receiver connection 之前发出           | 输入延后一个 tick    |
| `frame-input-window` | 用 frame count 表示输入时间窗口，行为受 FPS 影响 | fixed FPS 120 → 60   |
| `physics-tunneling`  | 低 physics TPS 下离散采样穿透目标                | physics TPS 30 → 120 |
| `entity-reuse`       | 延迟 effect 错误命中新 incarnation               | 关闭 Fixture pooling |

这些 Fixture 验证 Protocol v2、typed events、多时钟、realized controls 和 participant
checkpoint/restore。表中的干预是 legacy benchmark 的校准事实，不是 vNext Agent 的必选步骤，也不是通用
Godot 根因 taxonomy。

## 常用命令

| 命令                                                | 当前作用                                                   |
| --------------------------------------------------- | ---------------------------------------------------------- |
| `corepack pnpm check`                               | lint、格式、strict typecheck 和离线测试                    |
| `corepack pnpm test:godot`                          | 四个 v0.3 Fixture 加 v0.2 兼容集成测试                     |
| `corepack pnpm demo:v04`                            | v0.4 固定 workflow 的离线完整诊断                          |
| `corepack pnpm diagnose:v04`                        | v0.4 固定 workflow 的真实 provider 诊断                    |
| `corepack pnpm demo:v03` / `diagnose:v03`           | v0.3 兼容路径                                              |
| `corepack pnpm fixtures`                            | 列出当前 Fixture                                           |
| `corepack pnpm godot:install` / `godot:doctor`      | 安装或检查 Godot                                           |
| `corepack pnpm pi` / `models`                       | 启动固定版本 Pi CLI 或查询模型目录                         |
| `corepack pnpm benchmark`                           | deterministic fake-model smoke；不代表产品优势             |
| `corepack pnpm benchmark:verify` / `benchmark:gate` | 重验历史报告完整性或冻结 Gate                              |
| `corepack pnpm test:live`                           | v0.1 Mock switch-door 真实 provider smoke；不属于默认 Gate |

Formal benchmark 的冻结命令、退出码、恢复规则和证据 identity 不再复制到产品入口；见
[r4 reproduction](docs/benchmarks/v0.3.2-luna-r4/reproduction.md)。

## Artifact、历史与安全边界

当前 v0.4 单次运行写入 `.chronorift/v0.4/runs/<run-id>/`；v0.3 兼容路径写入
`.chronorift/v0.3/runs/<run-id>/`。`.chronorift/` 是本地运行状态，不得提交 Git。

当前 adapter 对外部和持久化 DTO 使用显式 `schemaVersion` 与 strict validation；执行和事件 seal 后才
作为证据；run store 拒绝 absolute path、`..`、symlink/canonical-path escape 和不同内容覆盖。requested
control 只有获得匹配 realized receipt 后才是执行事实。content hash 能发现意外损坏，但不是签名、外部
attestation 或对同一用户权限攻击者的防篡改保证。

v0.1–v0.4 的 schema、raw artifact、benchmark spec、selection、ledger、report、hash 和冻结 tag 保持原字
节与原语义。vNext 使用新的 task namespace，不覆盖历史 artifact，也不把旧 Proposal/Verdict 静默迁移成
新结果。

M1 internal foundation 已实现独立 Task namespace、workspace/patch contracts 和 tool/security/resource receipt
contracts，以及对应的基础存储原语；它尚未成为公开 Task lifecycle。Pi session、Godot
runtime/execution、capture window、checkpoint、trace、Runtime State Index 和 comparison 的目标布局仍未
实现，详见架构文档。

## 历史 benchmark 结论

冻结的 `v0.3.2-luna-r4` execution 已完成 36/36 cells，其中 30 个 `scored`、6 个
`diagnostic_failure`；独立 verifier 返回 `issues=[]`。grounded success 为 generic `6/12`、
evidence-only `0/12`、chronorift-full `6/12`，所以预注册产品 Gate 失败，full 相对 generic 的增益为
零。

这里的 `generic` 是同一个 Pi Harness 内的工具可用性消融，不是普通 Codex、Claude Code 或其他产品。
因此该结果只证明历史 benchmark/report 链路完整，并提供旧 workflow 的负向工程证据；它不支持
ChronoRift 相对通用 coding agent 的优势结论。完整证据和早期无效/中断 campaign 见
[r4 evidence workspace](docs/benchmarks/v0.3.2-luna-r4/README.md) 与
[v0.3.2 portfolio](docs/portfolio-v0.3.2.md)。

未来 Eval 从产品 Harness 外部运行完整 ChronoRift，可以持有 hidden Bug、oracle 和评分规则，但不能把
固定调查流程反向塞进产品 API。

## 当前仓库结构

依赖方向保持为 `domain ← gamebranch ← adapters ← CLI composition root`；Agent 路径为
`domain ← agent-protocol ← pi-harness/CLI bridge`。

```text
apps/cli                         当前 v0.3/v0.4 参数与 composition root
apps/cli/src/vnext               未接入公开 CLI 的 M1 workspace/sandbox/patch 内部组件
packages/domain                  engine-neutral ID、DTO、strict Zod schema
packages/gamebranch              当前 experiment/evidence/compare/verdict 服务与 ports
packages/agent-protocol          当前 capability、opaque handle、tool/proposal schema
packages/pi-harness              Pi Session/Loop adapter 与受限诊断/源码工具
packages/godot-protocol          versioned Godot wire DTO、payload hash、TCP framing
packages/godot-adapter           Godot lifecycle、Fixture staging、handshake、runtime port
packages/json-artifacts          legacy adapter 与内部 vNext Task write-once store
packages/mock-game               deterministic switch-door legacy Fixture
godot/addons/chronorift          EditorPlugin 与 ChronoProbe Autoload
fixtures/godot-*                 四个受支持的真实 Godot Fixture
```

不要根据 Target Architecture 预先创建空的 `world-model`、`game-contracts`、`worktree-manager` 或
`execution-sandbox` package；只有真实依赖和生命周期边界落地并被测试后才拆包。

## 当前限制

- v0.4 是四个小型、显式插桩 Fixture 的诊断 workflow，不支持任意外部 Godot 项目。
- v0.4 覆盖 Pi 默认 prompt，禁用 built-in tools、skills/context，要求固定工具序列；这与 vNext 契约冲突。
- 当前公开命令没有候选 workspace、OS sandbox、通用 coding tools、patch handoff 或持续任务生命周期；M1
  只提供尚未接入 CLI/Pi/Godot 的内部 workspace、sandbox 和 patch 组件。
- 当前没有 rolling black box、通用 Runtime State Index 或 vNext descriptive compare。
- checkpoint 只覆盖注册 participant；physics internals、Timer/Tween/coroutine、线程、未注册 RNG、cache、
  网络和外部服务仍是 missing/uncontrolled state。
- Addon 使用 allowlist 和显式注册；它不全局拦截任意 Signal、属性、线程或 engine internals。
- 当前 replay/fingerprint 只说明声明维度和已观测结果，不是完整 Determinism Certificate。
- 当前本地 report verifier 不是 provider attestation，也不证明模型报告或 Bug 修复正确。
- 历史 suite 在同四个校准 Fixture 上运行，不能支持跨项目泛化、统计显著性或产品 head-to-head。

## 开发与文档

默认完成门槛：

```bash
corepack pnpm check
```

M1 sandbox 还要求独立、不可跳过的真实 Host conformance：

```bash
# CHRONORIFT_TEST_CGROUP_ROOT 必须指向预先委派、空且可写的 cgroup v2 root，
# 并已启用 cpu、memory、pids controller。
CHRONORIFT_TEST_CGROUP_ROOT=/sys/fs/cgroup/<delegated-root> \
  corepack pnpm test:sandbox
```

`test:sandbox` 不属于默认离线测试，也不会因 Host 不支持而静默 skip；CI 必须通过独立 job 提供 delegated
cgroup root 并运行它。Linux 本地开发者需要等价的 cgroup delegation，以及可用的
`/usr/bin/bwrap`、`/usr/bin/prlimit` 和静态 BusyBox。仓库 CI 使用
`.github/scripts/run-sandbox-conformance.sh` 创建一次性 delegated test root。

Godot、checkpoint、replay、schema、canonicalization、branching 或 storage 变更还应运行相应成功、失败、
corruption、reference-integrity 和 determinism/nondeterminism 覆盖；需要本机 Godot 的改动再运行
`corepack pnpm test:godot`。真实 provider 验证只通过 `corepack pnpm test:live` 显式运行。

- [Target Architecture](docs/architecture.md)：vNext 产品契约、边界和迁移计划；
- [Godot Protocol v2](docs/godot-protocol-v2.md)：当前 runtime wire contract；
- [r4 benchmark evidence](docs/benchmarks/v0.3.2-luna-r4/README.md)：冻结历史报告与复现协议；
- [v0.3.2 portfolio](docs/portfolio-v0.3.2.md)：旧垂直切片的事实摘要。
