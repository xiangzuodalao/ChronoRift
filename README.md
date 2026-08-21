# ChronoRift

ChronoRift 的目标是成为一个 **Codex 式的 game-native Agent Harness**：它用 Pi SDK 驱动正常的 coding-agent
Loop，同时提供隔离 workspace、受控 Godot runtime，以及 checkpoint、fork、replay、query 和 compare 等游戏运行时
原语。

> 当前公开 release 仍是 **v0.4.0 legacy diagnosis slice**。Project Environment V1 是实验性 vNext 基础：PE-A
> 与 PE-B 已达到 `implementation present + local Gate passed`；PE-C Narrow Source/Import Closure 已通过固定外部项目的
> CI Host Gate 并封版，但尚未晋升默认入口。当前下一切片是 **GN-1 External Project Runtime Observation**：
> 专用命令已支持 matched `coding-only` / `chronorift` 消融。2026-08-20 的一个本地 R2 pair
> 产生了一次窄的正结果，但未冻结为仓库 evidence 或 Gate；原 PC-1 全闭环已延期。

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
以及 default/selected launch target。固定外部项目上的窄 CI Host Gate 已通过；它仍是实验性 Preview 能力，不是默认
入口或任意 Godot 项目支持声明。
首次 Session 由 Agent 生成唯一 ProjectAdapter；Harness 冻结 candidate，执行
vanilla/bridge-only/instrumented conformance，完整发布 immutable revision 后，再在同一 Session 的下一 turn 处理用户
目标。后续 Task 可以复用匹配的 revision。

Agent 修改位于 Task-owned `/workspace`，不会直接写用户 checkout。Project Environment revision 保存在项目根的
local-only `.chronorift/`，Session、candidate 和 runtime artifacts 位于仓库外 bounded Task storage。自动 commit、merge、
push 或直接 apply 都不是完成条件。

完整的 Project Environment contract、状态机、能力模块和 Gate 见
[Project Environment V1 RFC](docs/project-environment-v1.md)。Host 配置和 conformance 操作见
[开发与验证指南](docs/development.md)。

## 实验性 GN-1 外部项目运行时观察

GN-1 不走上述 Preview 初始化/publication/reuse 流程。它固定真实第三方项目
`endlessm/moddable-platformer@e78b339500dec8e480b33723c4156bf9b74cd25c`（tree
`9941cb045b3cd73c4554ca1de337a341b383590b`），并将同一个中性调试任务拆成两个独立 fresh arm。
两个 arm 使用相同的 exact source、prompt、`coding` environment profile、`gpt-5.6-luna`/`max`、600
秒 timeout 和共享工具 `read`/`bash`/`edit`/`write`/`grep`/`find`/`ls`/`godot_run`；每个 fresh Task 只有
自己的 `taskId` 不同。`chronorift` arm 的唯一工具面增量是 `game_capabilities`、`game_launch`、
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

`--host-config PATH` 与 `--timeout-ms 600000` 可显式传入。每条命令只运行一个 arm；standalone evaluator
验证配置、Task/workspace/Session 隔离、tool/Build/Execution lineage、candidate diff、runtime observation、
cleanup 和 Agent-invisible Host geometry/identity oracle，但不选择 winner。Godot 仍只在 execution-private staging 中运行：admitted
source 只读，`.godot/` import cache 可写。完整 Host 前置条件见 [开发与验证指南](docs/development.md)。

2026-08-20 的本地 R2 matched pair 使用 `openai-codex/gpt-5.6-luna`、`max`。`coding-only` 产生了
非空 candidate，但 candidate geometry mismatch，Host oracle 为 `false`。`chronorift` 在修改前成功
launch 并查询了绑定该 Execution 的 `platform_geometry`；candidate 上的四个 Area Shape identity 互不相同，
宽度分别为 256/128/384/768px，runtime-error rows 为空，该 arm 的窄 oracle 为 `true`。较早的 R1
表征暴露了 query contract 不匹配：Agent 自主选择了 game tools，但因 capabilities 没有说明 V1 不支持
filters/cursor，未成功取得 semantic state，当次 evaluator 正确拒绝通过；R2 是修正该 affordance 后的
fresh pair。更早的 `gpt-5.6-sol`/`medium` 单 arm demo 只是路由/lifecycle characterization，不再作为当前最强证据。
两个 arm 的每次 managed Godot import 也都有 1412-byte stderr，精确 bytes/digest 在 stop receipt 中；
它们是只读 admitted source/旧项目 importer metadata 边界下的 diagnostics。scene 和 adapter query 成功，
但 `runtime_errors` rows 为空不表示完全没有 diagnostics。

这仍然只是一个项目、一个 exact revision、一个 prompt 和一个 pair。它不证明 ChronoRift 的通用
superiority，不证明 game-tool observation 对所有修复都具有因果性，也不估计成功率或任意项目泛化。两个
arm 的 JSON、Session 和 evaluator output 仅保留在 local-only `.chronorift/`；没有冻结 bundle、Gate、自动
verdict 或 apply。

## 实现状态

| 路径     | 状态                                             | 当前证据与边界                                                                               |
| -------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| v0.4     | 当前公开 legacy release                          | 四个校准 Fixture；固定 Proposal/Verdict workflow                                             |
| M3       | 实验性实现                                       | 单一 `frame-input-window`；sandbox、正常 Pi Loop、16 个 game tools、patch 生命周期           |
| M4       | 实验性 lifecycle-only 路径                       | 冻结外部项目的 source/launch/cleanup plumbing；只有四个 lifecycle tools                      |
| E2       | 实验性 semantic 路径                             | Timer/spawn 的 11-tool public-exposed plumbing evidence；全部状态操作为 `descriptive_only`   |
| PE-A     | implementation present + local Gate passed       | Author → Validate → Publish → Use、exact Build、new-Session reuse                            |
| PE-B     | implementation present + local Gate passed       | V2 dynamic identity、Execution-bound incarnation、连续 validated ring 和 pinned captures     |
| **PE-C** | **implementation present + CI Host Gate passed** | narrow dirty closure、多项目选择、addon/import、default + selected target 与 review boundary |
| **GN-1** | **实验性实现；一个本地 R2 matched pair 完成**    | 对照 oracle false，ChronoRift oracle true；单项目/单 pair，local-only，未冻结                |
| PC-1     | 延期；尚未实现                                   | Project Environment publication/reuse、checkpoint/replay 与 evidence 全闭环                  |

PE-A/PE-B 的本地真实模型 Gate 均有 create-new bundle，并由不导入产品 TypeScript 的 standalone validator 复验：

- [PE-A local r1 evidence](docs/evidence/vnext-project-environment-pe-a-local-r1/README.md)
- [PE-B local r1 evidence](docs/evidence/vnext-project-environment-pe-b-local-r1/README.md)
- [PE-C CI r1 freeze](docs/evidence/vnext-project-environment-pe-c-ci-r1/README.md)
- [M4/E2 public-exposed evidence](docs/evidence/vnext-e2-public-exposed-r1/README.md)

这些归档支持对应的窄 conformance 事实，但不是签名、protected artifact、Provider/Host attestation、独立 acceptance
或通用项目成功率证明。

## 常用命令

| 命令                                                          | 作用                                                                    |
| ------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `corepack pnpm check`                                         | 默认离线 Gate：lint、格式、strict typecheck 和测试                      |
| `corepack pnpm test:godot`                                    | Godot Addon、protocol、Project Environment 集成与 characterization 测试 |
| `corepack pnpm demo:platform-alias -- ...`                    | GN-1 固定外部项目的专用 real-Pi 实验入口                                |
| `corepack pnpm demo:platform-alias-ablation -- --arm ...`     | GN-1 matched ablation 的一个 fresh arm；两个 JSON 另行评估              |
| `corepack pnpm project preview -- ...`                        | 实验性 Project Environment 入口                                         |
| `corepack pnpm task -- start ...`                             | M3/M4/E2 兼容实验路径；另有 `continue/show/export/discard` 子命令       |
| `corepack pnpm test:sandbox`                                  | 真实 Host coding-sandbox conformance                                    |
| `corepack pnpm test:vnext:godot-sandbox`                      | Godot sidecar、Project Environment Preview 与 sandbox Host Gate         |
| `corepack pnpm test:vnext:external-project`                   | M4 外部项目 lifecycle Host Gate                                         |
| `corepack pnpm test:vnext:external-semantic`                  | E2 semantic Host Gate                                                   |
| `corepack pnpm test:vnext:project-environment-pe-c-host`      | PE-C 窄外部项目 Host Gate；CI r1 已冻结                                 |
| `corepack pnpm demo:v04` / `diagnose:v04`                     | 当前 legacy 离线/真实 provider 路径                                     |
| `corepack pnpm benchmark:verify -- --spec PATH --report PATH` | 重验冻结历史 benchmark artifacts                                        |

Host prerequisites、live Gate、evidence validator 和完整 Gate 命令矩阵统一维护在
[开发与验证指南](docs/development.md)，不在 README 重复。

## 当前限制

- `chronorift [goal]` 尚不是默认命令；Project Environment 只能通过显式 Preview 使用，GN-1 只能通过固定项目的
  `demo:platform-alias` 或 `demo:platform-alias-ablation` 命令使用。
- GN-1 只支持上述精确 `moddable-platformer` commit/tree、一个项目特定 V1 adapter 和四个 lifecycle/query tools；它不
  支持其他项目、adapter authoring/reuse、V2 history/capture、checkpoint/replay、evidence archive 或自动 acceptance。
- PE-B 只证明一个冻结的 clean、single-root、single-target 动态项目结构；不能外推到任意 Godot 项目。
- PE-C CI r1 只证明一个冻结外部项目、deterministic fake Agent 和精确 Host boundary 上的 tracked dirty、逐次显式
  untracked、项目选择、稳定 `SourceId`、materialize 后 drift 检查、本地 addon/`@tool`、default + selected target、
  new-Session reuse，以及 source 变化时 `review_required`；它不证明 real-Pi adapter 生成或 Agent 调试成功率。
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

- [目标架构](docs/architecture.md)：vNext 产品契约、边界、GN-1 当前切片和当前实现映射。
- [Project Environment V1 RFC](docs/project-environment-v1.md)：详细数据模型、初始化/publication 状态机和 PE rollout。
- [开发与验证指南](docs/development.md)：本地、Host、live 与 evidence Gate。
- [Godot Protocol v2](docs/godot-protocol-v2.md)：已实现的 v0.3 Host ↔ Addon wire；Project Environment 使用 RFC
  所定义的独立 protocol。
- [PE-A evidence](docs/evidence/vnext-project-environment-pe-a-local-r1/README.md) 与
  [PE-B evidence](docs/evidence/vnext-project-environment-pe-b-local-r1/README.md)：本地 Gate bytes、validator 和 trust boundary。
- [PE-C CI freeze](docs/evidence/vnext-project-environment-pe-c-ci-r1/README.md)：窄外部项目 CI Host Gate 元数据与
  trust boundary；不含独立 validator 或 product-subject bundle。
- [v0.3.2-luna-r4 evidence](docs/benchmarks/v0.3.2-luna-r4/README.md)：冻结历史负结果；它不支持相对通用 coding agent
  的产品优势结论。
