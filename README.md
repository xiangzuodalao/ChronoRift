# ChronoRift

ChronoRift 的目标是成为一个 **Codex 式的 game-native Agent Harness**：它用 Pi SDK 驱动正常的 coding-agent
Loop，同时提供隔离 workspace、受控 Godot runtime，以及 checkpoint、fork、replay、query 和 compare 等游戏运行时
原语。

> 当前公开 release 仍是 **v0.4.0 legacy diagnosis slice**。Project Environment V1 是实验性 vNext 基础；PE-A 至
> PE-C 的历史 characterization 已归档，但专用 live/evidence Gate 已退役。实验性 **GN-1 External Project Runtime
> Observation** 保留 matched `coding-only` / `chronorift` 消融。旧的全闭环 evidence campaign 已退役，后续产品
> 切片尚未确定。

## 产品边界

ChronoRift 负责真实执行与记录，不替 Agent 或用户宣布 Bug 已修复：

| 参与者                           | 职责                                                                          |
| -------------------------------- | ----------------------------------------------------------------------------- |
| ChronoRift Harness               | workspace、sandbox、授权工具执行、runtime receipts、coverage、loss 和 lineage |
| Pi                               | Session、模型调用、Agent Loop、工具调度、消息历史、compaction 和普通终止      |
| Agent                            | 读码、形成假设、修改代码、选择验证手段并解释结果                              |
| 用户、项目 CI、review、外部 Eval | 接受或拒绝候选修改                                                            |

`completed` 只表示 Loop 正常结束并留下可审阅候选和执行记录，不等于 `verified`、`fixed` 或逻辑证明。diff、命令
输出、game tool result 和 raw runtime record 高于 Agent 最终叙述。vNext 不产生 canonical diagnosis、fix verdict
或固定调查流程。

ChronoRift 相对基础 Godot 工具的目标价值，是把运行时变成有 identity、history、coverage 和 lineage 的可分支状态
系统。完整契约与边界见 [目标架构](docs/architecture.md)。

## 快速开始：当前 v0.4 legacy

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
```

仓库管理的 Godot installer 固定官方 Godot `4.7.1`，当前只支持 Linux x86_64；legacy 命令也接受自备二进制的
`GODOT_BIN` 或 `--godot-bin`。v0.4 使用四个显式插桩的校准 Fixture 和固定诊断 workflow；它不是任意 Godot
项目 runner，也不代表 vNext 产品契约。

真实 provider 路径要求通过 flag 或对应环境变量给出 provider/model，不允许 silent fallback；`--thinking` 可省略，
当前默认值为 `max`。凭据由仓库固定版本的 Pi CLI 管理，不得复制或提交：

```bash
corepack pnpm pi --no-session
corepack pnpm models -- --provider openai-codex

corepack pnpm diagnose:v04 -- \
  --fixture frame-input-window \
  --provider openai-codex \
  --model gpt-5.6-luna \
  --thinking max
```

## 实验性 Project Environment Preview

在 Godot 项目根运行当前显式开发入口；下列是 usage 形式，其中方括号表示可选参数：

```text
corepack pnpm project preview -- [GOAL] \
  --provider PROVIDER \
  --model MODEL \
  [--thinking LEVEL] \
  [--host-config PATH] \
  [--project-root RELATIVE_PATH] \
  [--include-untracked RELATIVE_FILE]... \
  [--launch-target TARGET_ID]
```

PE-C 把该入口扩展为 tracked dirty 自动纳入、untracked 逐次显式选择、多个 `project.godot` 时显式选择 project root，
以及 default/selected launch target。该行为曾在固定外部项目上 characterization；专用 Gate 已退役。它仍是实验性
Preview 能力，不是默认入口或任意 Godot 项目支持声明。
首次 Session 由 Agent 生成唯一 ProjectAdapter；Harness 冻结 candidate，执行
vanilla/bridge-only/instrumented conformance，完整发布 immutable revision 后，再在同一 Session 的下一 turn 处理用户
目标。后续 Task 可以复用匹配的 revision。

Agent 修改位于 Task-owned `/workspace`，不会直接写用户 checkout。Project Environment revision 保存在项目根的
local-only `.chronorift/`，Session、candidate 和 runtime artifacts 位于仓库外 bounded Task storage。自动 commit、merge、
push 或直接 apply 都不是完成条件。

完整的 Project Environment contract、状态机、能力模块和验证原则见
[Project Environment V1 RFC](docs/project-environment-v1.md)。Host 配置和 conformance 操作见
[开发与验证指南](docs/development.md)。

## 实验性 GN-1 外部项目运行时观察

GN-1 不走上述 Preview 初始化/publication/reuse 流程。它固定真实第三方项目
`endlessm/moddable-platformer@e78b339500dec8e480b33723c4156bf9b74cd25c`（tree
`9941cb045b3cd73c4554ca1de337a341b383590b`），把同一个中性调试任务拆成两个 fresh arm。两者共享 exact
source、prompt、model 和 coding/raw-Godot tools；`chronorift` arm 只增加 `game_capabilities`、`game_launch`、
`game_stop` 和 `game_query`。

准备一个位于精确 commit/tree、工作树 clean 且不含 `.chronorift/` 的本地 checkout；命令不会 clone、fetch、修改或
apply 回原 checkout：

```bash
corepack pnpm demo:platform-alias-ablation -- \
  --arm coding-only \
  --project /absolute/path/to/moddable-platformer \
  --provider openai-codex \
  --model gpt-5.6-luna \
  --thinking max \
  --json > coding-only.json

corepack pnpm demo:platform-alias-ablation -- \
  --arm chronorift \
  --project /absolute/path/to/moddable-platformer \
  --provider openai-codex \
  --model gpt-5.6-luna \
  --thinking max \
  --json > chronorift.json

node scripts/evaluate-platform-alias-ablation.mjs coding-only.json chronorift.json
```

每条命令只运行一个 arm；`--host-config PATH` 与 `--timeout-ms 600000` 可显式传入。完整 Host 前置条件、matched
配置和 evaluator 检查见 [开发与验证指南](docs/development.md)。

2026-08-20 的本地 R2 pair 中，`coding-only` 的 Host geometry oracle 为 `false`，而在修改前成功取得
launch-bound `platform_geometry` observation 的 `chronorift` arm 为 `true`。这只是一个项目、一个 exact revision、
一个 prompt 和一个 pair；结果仅在 local-only `.chronorift/`，未冻结为 Gate，也不证明通用优势、普遍因果性、
成功率或任意项目泛化。

## 实现状态

| 路径     | 状态                                             | 当前证据与边界                                                                               |
| -------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| v0.4     | 当前公开 legacy release                          | 四个校准 Fixture；固定 Proposal/Verdict workflow                                             |
| M3       | 实验性实现                                       | 单一 `frame-input-window`；sandbox、正常 Pi Loop、16 个 game tools、patch 生命周期           |
| M4       | 实验性 lifecycle-only 路径                       | 冻结外部项目的 source/launch/cleanup plumbing；只有四个 lifecycle tools                      |
| E2       | 实验性 semantic 路径                             | Timer/spawn 的 11-tool public-exposed plumbing evidence；全部状态操作为 `descriptive_only`   |
| PE-A     | 实验性 Preview；历史 characterization 已归档     | Author → Validate → Publish → Use、exact Build、new-Session reuse                            |
| PE-B     | 实验性 Preview；历史 characterization 已归档     | V2 dynamic identity、Execution-bound incarnation、连续 validated ring 和 pinned captures     |
| **PE-C** | **实验性 Preview；历史 characterization 已归档** | narrow dirty closure、多项目选择、addon/import、default + selected target 与 review boundary |
| **GN-1** | **实验性固定项目消融**                           | 一个本地 pair，local-only，未冻结                                                            |

旧 PE/M4/E2 证据只作为冻结历史归档保留；当前 HEAD 不再提供其 producer、standalone validator 或专用 Gate：

- [PE-A local r1 evidence](docs/evidence/vnext-project-environment-pe-a-local-r1/README.md)
- [PE-B local r1 evidence](docs/evidence/vnext-project-environment-pe-b-local-r1/README.md)
- [PE-C CI r1 freeze](docs/evidence/vnext-project-environment-pe-c-ci-r1/README.md)
- [M4/E2 public-exposed evidence](docs/evidence/vnext-e2-public-exposed-r1/README.md)

这些归档支持对应的窄 conformance 事实，但不是签名、protected artifact、Provider/Host attestation、独立 acceptance
或通用项目成功率证明。

## 常用命令

| 命令                                                      | 作用                                                                    |
| --------------------------------------------------------- | ----------------------------------------------------------------------- |
| `corepack pnpm check`                                     | 默认离线 Gate：lint、格式、strict typecheck 和测试                      |
| `corepack pnpm test:godot`                                | Godot Addon、protocol、Project Environment 集成与 characterization 测试 |
| `corepack pnpm demo:platform-alias-ablation -- --arm ...` | GN-1 matched ablation 的一个 fresh arm；两个 JSON 另行评估              |
| `corepack pnpm project preview -- ...`                    | 实验性 Project Environment 入口                                         |
| `corepack pnpm task -- start ...`                         | M3/M4/E2 兼容实验路径；另有 `continue/show/export/discard` 子命令       |
| `corepack pnpm test:sandbox`                              | 真实 Host coding-sandbox conformance                                    |
| `corepack pnpm test:vnext:godot-sandbox`                  | Godot sidecar、Project Environment Preview 与 sandbox Host Gate         |
| `corepack pnpm demo:v04` / `diagnose:v04`                 | 当前 legacy 离线/真实 provider 路径                                     |

Host prerequisites 和当前验证命令统一维护在 [开发与验证指南](docs/development.md)，不在 README 重复。

## 当前限制

- `chronorift [goal]` 尚不是默认命令；Project Environment 只能通过显式 Preview 使用，GN-1 只能通过固定项目的
  `demo:platform-alias-ablation` 命令使用。
- GN-1 只支持上述精确 `moddable-platformer` commit/tree、一个项目特定 V1 adapter 和四个 lifecycle/query tools；它不
  支持其他项目、adapter authoring/reuse、V2 history/capture、checkpoint/replay、evidence archive 或自动 acceptance。
- PE-A 至 PE-C 的归档只记录对应冻结项目和 Host boundary 上的窄 characterization；专用 producer/validator 已退役，
  这些结果不能外推到任意 Godot 项目或 Agent 调试成功率。
- 完整 LFS、dirty/递归 submodule、directory symlink/cycle/race、内容级 secret 扫描、全量 quota matrix、所有 target
  的三阶段 conformance、独立 PE-C bundle validator 和任意 sibling/absolute source root 均延期。
- Host refresh、source/adapter migration、失败 attempt 的通用跨命令 resume、multi-writer lease/CAS、conflict-safe
  apply、bundle import/export 和项目网络模板属于 PE-D 及后续切片。
- 首版范围是 Linux + Godot 4.7 官方 GDScript runtime；C#、GDExtension、native plugin、macOS、Windows、audio、
  display 和 GPU 不在当前支持范围。
- 当前自动 capture trigger 未实现；M3 只有手动 pin。checkpoint/restore 只覆盖 manifest 声明的状态，成功 restore
  不证明 equivalent start；replay/compare 也不证明 bit-exact 或因果关系。
- ProjectAdapter、probe、项目代码和 Godot plugin 在同一不可信 runtime principal 中执行。只读 overlay、hash 和
  handshake token 不是第三方 telemetry attestation。
- 候选是否正确仍由用户、项目 CI、review 或独立 Eval 判断；本地 verifier 只能验证记录内容与绑定。

## Artifact 与安全

- `.chronorift/` 是 local-only 状态，不得提交 Git；v0.1-v0.4 的冻结 artifacts 和语义保持不变。
- 外部 DTO 和持久化数据使用 strict versioned schema；raw execution records append 后 seal，历史记录不原地改写。
- 绝对路径、`..`、symlink/canonical-path escape 和跨 Task resource reference 必须拒绝。
- vNext sandbox 路径中，Pi credential 只允许 Host 模型路径读取，不能进入 repository、artifact、Task command
  environment 或 Godot process；v0.4 Host path 不具备这一 OS-sandbox 保证。
- content hash 用于发现损坏和绑定记录，不是签名或外部 attestation。

## 文档地图

- [目标架构](docs/architecture.md)：vNext 产品契约、边界、GN-1 实验路径和当前实现映射。
- [Project Environment V1 RFC](docs/project-environment-v1.md)：详细数据模型、初始化/publication 状态机和 PE rollout。
- [开发与验证指南](docs/development.md)：当前本地、Host 与 live 验证入口。
- [Godot Protocol v2](docs/godot-protocol-v2.md)：已实现的 v0.3 Host ↔ Addon wire；Project Environment 使用 RFC
  所定义的独立 protocol。
- [PE-A evidence](docs/evidence/vnext-project-environment-pe-a-local-r1/README.md) 与
  [PE-B evidence](docs/evidence/vnext-project-environment-pe-b-local-r1/README.md)：冻结历史 bytes 与当时的 trust boundary；
  当前 HEAD 不再运行其 producer/validator。
- [PE-C CI freeze](docs/evidence/vnext-project-environment-pe-c-ci-r1/README.md)：窄外部项目 CI Host Gate 元数据与
  trust boundary；不含独立 validator 或 product-subject bundle。
- [v0.3.2-luna-r4 evidence](docs/benchmarks/v0.3.2-luna-r4/README.md)：冻结历史负结果；它不支持相对通用 coding agent
  的产品优势结论。
