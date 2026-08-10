# ChronoRift

ChronoRift 的目标是成为一个 **Codex 式的 game-native Agent Harness**：它托管受控的代码 workspace 和
Godot 运行环境，用 Pi SDK 驱动自主 Agent Loop，并为 Agent 提供普通游戏工具难以可靠实现的运行时
checkpoint、fork、replay、query 和 compare 原语。

> **产品方向、实验性 vNext 路径与 legacy release 必须分开阅读。**
> 当前 release 仍是 **v0.4.0 legacy diagnosis slice**。仓库源码另外包含一个只面向
> `frame-input-window` 的实验性 **M3 vNext vertical slice**：`task start/continue/show/export/discard`、真实 Pi
> `AgentSession`、隔离 workspace、broker-backed coding tools、16 个 Godot game tools、runtime sidecar、
> rolling capture、checkpoint/restore、fork/replay/query/compare 和 patch handoff 已接线。它不是新的公开
> release，也不证明候选修复正确或能力可泛化到任意 Godot 项目；本文不会把尚未实际运行的 Gate 或 live
> acceptance 写成已通过。
>
> 仓库还定义实验性 **M4 external-project lifecycle-only slice**：Operator 提供本地 clean Git checkout 和
> strict descriptor，Agent 只获得 capabilities/launch/status/stop 四项生命周期能力。M4 的代码入口和 required Host Gate
> 即使已经存在，也必须以 `test:vnext:external-project` 的实际输出为准；没有该输出时只能写“已实现路径”，
> 不能写成外部项目接入已经得到证明。
>
> 源码还包含实验性 **E2 external semantic slice**：它在 M4 source/sandbox 基础上增加独立 Task V4、独立
> semantic wire/Addon、data-only adapter profile，以及 Timer + spawned-entity 的 query/checkpoint/restore/fork/
> trace/replay/compare。所有状态操作都明确是 `descriptive_only`；public exposed task Gate 只验证 plumbing，
> 不证明智能诊断、等价恢复、修复正确性、独立验收或泛化。

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

| 维度       | v0.4 legacy                           | 实验性 M3 vNext slice                                                       | 未覆盖或后续方向                            |
| ---------- | ------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------- |
| Pi         | 真实 Session，但服务固定诊断 workflow | 官方 SDK、默认 Loop/compaction/skills/AGENTS、持久化 Session                | 外部项目和更多 Fixture                      |
| Agent 工具 | 受限诊断工具与一次 Proposal           | 7 个 broker-backed coding tools + 16 个 strict、无阶段 game tools           | 按任务授权更多项目能力                      |
| Workspace  | Fixture staging，不产生候选修改       | 私有 `/workspace`、suspend/resume、显式 patch export/discard                | 长期保留与用户 apply UX                     |
| OS sandbox | opaque handle，不是进程隔离           | bwrap namespace、cgroup v2、rlimit、默认禁网/Host/credential                | 图形、音频、GPU 等显式授权                  |
| Godot      | 四个显式插桩 Fixture                  | 单一 Fixture、Godot 4.7.1、Protocol v2、managed runtime sidecar             | 任意项目、其他 Fixture、视觉/音频           |
| Capture    | 执行期 typed telemetry                | 有界 rolling buffer、手动 pin、coverage/degradation/loss receipt            | 自动 capture trigger 当前明确拒绝           |
| Checkpoint | Fixture participant snapshot          | manifest、逐域 hash、restore receipt；只恢复声明的 Fixture/Host 状态        | engine internals 与跨不兼容 build 恢复      |
| Replay     | Fixture 控制与 legacy replay          | requested/realized tick/phase trace、same-build restore、跨 build fresh run | 不承诺 bit-exact 或完整等价起点             |
| Query      | typed event 与 legacy Capsule         | raw records + 可重建 Runtime State Index                                    | 更广的项目 probe                            |
| Compare    | 服务于 verdict Gate                   | 只比较 sealed Execution，报告差异、ambiguity、coverage gap、confounder      | 不判断因果、假设或修复正确性                |
| Artifacts  | legacy run/proposal/verdict store     | 10 类 runtime resource、raw event hash chain、physical execution seal       | 外部签名/attestation                        |
| 结果       | Proposal → Harness Verdict            | assistant result + diff + 真实 tool/runtime/security/lineage records        | acceptance 仍归用户、CI、review 或独立 Eval |

当前 v0.4 中的 `FrozenContractBundleV3`、`ClaimEvidencePolicyRegistry`、opaque handles、
`DiagnosisProposalV4`、`DiagnosisVerdictV3` 和固定 replay/intervention flow 是 legacy 可执行事实，不是
vNext 产品 API。

### 实验性 M3 vNext 入口

仓库当前包含以下窄切片实现；是否满足完成门槛必须以本节后列出的实际测试输出为准：

- 对唯一受支持的 `frame-input-window` Fixture 执行 strict manifest、整仓 clean Git preflight、literal
  subtree 选择和 selected-tree identity 校验；
- 从 Git raw objects 创建任务私有 workspace、Agent 可写 Git 与 Host-only baseline Git，不 checkout、
  不执行项目 filter/hook，也不修改用户 checkout；
- 通过 bubblewrap、独立 namespace、固定 FD binding、哈希冻结的精确 GNU toolchain、cgroup v2、rlimit、
  bounded stdin/output 和结构化 receipt/security event 执行受控命令；
- managed Godot Task 的 `runtimeRoot` 必须是 Host 预置 `taskStorageRoot` 的 canonical 严格子目录；后者是
  独立的 `tmpfs`、`ext4` 或 `xfs` mount，总容量不超过 1 GiB、总 inode 不超过 131072。Agent Task 与外部
  evaluator 可以在同一个 mount 下使用不同 runtime root，并共同受这一 aggregate hard cap 约束；
- 通过 Pi 官方 SDK 建立 `/workspace` Session，保留默认 Loop、compaction、skills 和 `AGENTS.md`，禁用项目
  executable extensions，并用七个自定义 tool definition 覆盖会落到 Host 的内置实现；
- 同一个自由 Loop 还获得 16 个 strict game tools；每个 Runtime 由一份不跨 Runtime 复用的 sidecar 托管，
  sidecar 与 Godot 子进程位于同一 bwrap/network/PID/cgroup 边界，内部仅使用 loopback TCP，Host 只通过有界
  framed stdio 与 sidecar 通信；
- coding profile 对 `/workspace` 可写；`godot-headless` profile 对 `/workspace` 只读。受管 Addon 由 Host
  预检并冻结的字节重建后只读挂载到 runtime，候选源码中的整个 `addons/**` 当前一律拒绝，避免遮蔽受管
  mount；
- `task start/continue/show/export/discard` 保存 Task config、Agent turn、Session basename、真实 Loop 状态和
  execution records；`suspend` 清理 sandbox 进程而保留 workspace，`continue` 重新验证冻结 capability；
- 从 Host baseline 提取 binary/full-index patch，重新应用并比对 selected-tree 后才标记
  `roundTripVerified`；显式 export 使用 create-new/no-overwrite 发布，Task store 支持受身份约束的 discard；
- 为 workspace/patch/tool/security/resource DTO 提供 strict versioned contracts，并实现独立 vNext Task
  namespace、append/seal、write-once 与 records-only discard 存储原语；runtime store 保存 build、runtime、
  execution、capture window、checkpoint、trace、branch、index、comparison 和 tool-call 十类资源，raw event
  ledger 使用 hash chain 并由独立 physical seal 封口。

这仍是实验性入口，没有发布 vNext 版本。它实现的是单一 Fixture 的 game-task 闭环，不应被描述成任意
Godot 项目的通用支持、Bug 修复证明或 provider attestation。

### 实验性 M4 external-project lifecycle-only 入口

M4 在 M3 之外新增一个独立、严格版本化的 profile，不放宽 `frame-input-window` 的 manifest、Protocol v2、
16 工具 catalog、runtime artifacts 或 evaluator 语义。Operator 在 Host 侧预置外部项目的 clean checkout，
再通过 `--project-descriptor` 提供项目入口、精确 runtime、cache 和 bridge 声明；ChronoRift 不 clone、fetch
或把 URL 当作可信 provenance。descriptor 中的 HTTPS URL 只是 Operator 声明的元数据，执行事实仍是实际
读取的 Git HEAD、selected-tree、descriptor、overlay、Addon、runtime 和 build identity。

这个 profile 只向 Agent 暴露 `game_capabilities`、`game_launch`、`game_status` 和 `game_stop`。Agent catalog
中不存在 input、step、query、capture、checkpoint、restore、fork、replay 和 compare；内部 coordinator 若收到
这类请求则报告 `unsupported_capability`，不能从 M3 实现中继承出一个表面可用的 optional API。Godot
vanilla import/smoke 与受管 overlay import/launch 都执行在同一类 task sandbox、bounded storage 和 cleanup/seal
边界内；两个 operation 各自在 fresh stage 中 import，避免把 cache 当作可跨隔离边界复用的输入，并使 UID main
scene 在 managed launch 前可解析。Host checkout 不挂入 sandbox，Task-owned 只读 `/workspace`、writable
operation-stage、各自的 import cache 与 managed overlay 彼此分离，Host checkout 不运行也不修改。当前实现会在
两次 import、vanilla stop 和 managed stop 的边界重验 staged selected-tree，并在隔离
PID namespace 中拒绝 phase 结束后仍存活的额外进程；它没有把 staged tree 物理挂成只读，因此这些 identity
是 admission/endpoint facts，不是运行窗口内每一时刻执行字节都未被 mutate-and-restore 的证明。
回溯写入的 phase 和 process-output raw event 使用写入前最近一次真实 engine sample，并在 payload 中标记
`last_sample_before_ingest`；process output 另记录 operation envelope。它们不是每个日志 chunk 的发生时钟。

首个 conformance target 是 Operator 提供的
[`endlessm/moddable-platformer`](https://github.com/endlessm/moddable-platformer) 冻结提交
`3e793f53598a131c53fb82555191cc14b8db07ff`。这是 test-only conformance spec，不是产品项目目录或白名单。
当前窄 profile 只接受 root Godot 4.7.1 GDScript/GL Compatibility 项目，无 symlink、submodule、Git LFS、
candidate Addon、display、audio、GPU、network 或 credential 授权。

```bash
export CHRONORIFT_GODOT_LIFECYCLE_ADDON_ROOT=/path/to/chronorift/godot/addons/chronorift_lifecycle

corepack pnpm task -- start \
  --project /path/to/clean/moddable-platformer \
  --project-descriptor /path/to/operator/moddable-platformer.project.v1.json \
  --goal "Inspect the project and leave a reviewable candidate change"
```

`continue/show/export/discard` 沿用统一 Task 生命周期；M4 Task 从持久化 profile 选择 lifecycle-only runtime，
不会把旧 Task 或 M3 capability 静默迁移成新语义。

### 实验性 E2 external semantic 入口

E2 不扩展 M4 wire，而是使用 `godot-external-semantic-v1` Task profile、
`chronorift-godot-semantic-v1` wire、独立 `chronorift_semantic` Addon 和一份冻结、只含数据的 adapter profile。
当前 adapter 只声明一个 target scene 及其 Timer/spawn 投影；产品 core 不含项目名、根因、期望修复或 evaluator
oracle。Agent 获得精确 11-tool catalog：四个 lifecycle 工具，加 `game_query`、checkpoint create/restore、
fork、trace create/replay 和 compare。capture、input、step 和 controls 在该 profile 中不可用。

Checkpoint 只捕获 adapter 声明的 subject 配置、Timer 配置/运行态和已生成实体投影。scene-private state、
signals/callables、RNG、render/audio、外部状态与 pending engine work 均为 uncontrolled；restore、fork、replay、
compare 即使成功也不建立 equivalent start 或因果结论。语义事件是 command-endpoint sampling，不能冒充逐帧
历史。

```bash
export CHRONORIFT_GODOT_SEMANTIC_ADDON_ROOT=/path/to/chronorift/godot/addons/chronorift_semantic

corepack pnpm task -- start \
  --project /path/to/clean/moddable-platformer \
  --project-descriptor /path/to/moddable-platformer.project.v1.json \
  --semantic-adapter-profile /path/to/moddable-platformer.semantic-adapter.v1.json \
  --semantic-addon-root "$CHRONORIFT_GODOT_SEMANTIC_ADDON_ROOT" \
  --goal "Inspect the Timer and spawned-entity behavior"
```

首个 E2 conformance 使用上游明确暴露的 `enemy_spawner_broken` 场景。文件名、注释和 FIXME 已泄露问题，
所以它只能证明 11-tool/sandbox/lineage 管线，不是模型诊断能力证据，也不是独立 acceptance。真正的能力主张
仍需要产品与 adapter freeze 之后选取的隔离 holdout、独立 evaluator、预注册预算与全部失败结果。

Linux Host 必须先提供受委派的 cgroup v2 root，以及由当前用户拥有、mode `0700` 的独立 Task storage
mount；mount 只接受精确识别的 `tmpfs`、`ext4` 或 `xfs`，总容量不得超过 1 GiB、总 inode 不得超过 131072。
`task start` 会在该 mount 下创建缺失的 `runtimeRoot`；创建后它必须是 mount 的 canonical
严格子目录。普通目录、mount 本身、source tree 内的目录与 symlink 路径都会被拒绝。Host
还需安装 `bubblewrap`、`busybox-static`、`bash`、`ripgrep`、
GNU `find`/`ls`、`fontconfig` 与 `xdg-user-dirs`。managed runtime preflight 用 Host `fc-match` 只检查并冻结
fontconfig 动态依赖闭包，不把 `fc-match` 本体暴露给任务；Godot profile 额外只读挂载静态 BusyBox 到
`/bin/sh`、`xdg-user-dir` 到 `/usr/bin/xdg-user-dir`，以及 ChronoRift 生成的最小 fontconfig 配置到
`/opt/chronorift/etc/fontconfig/fonts.conf`。这些输入不进入 coding profile。Node 22.23.1 与官方 Godot
4.7.1 executable 必须来自不可由任务用户改写的 Host 路径，managed Addon root 必须与预检内容一致。
默认网络关闭；Pi credential 仅由 Host 模型路径读取。

M3 暴露的原子 game tool catalog 固定为：

- discovery/lifecycle：`game_capabilities`、`game_launch`、`game_status`、`game_stop`；
- capture/observation：`game_capture_configure`、`game_capture_pin`、`game_query`；
- control：`game_input`、`game_step`、`game_set_controls`；
- state/lineage：`game_checkpoint_create`、`game_checkpoint_restore`、`game_fork`；
- trace/compare：`game_trace_create`、`game_trace_replay`、`game_compare`。

这些工具没有全局 phase machine，资源依赖满足时可由 Agent 自由调用。当前 capture configure 接受有界通道、
窗口和采样请求，但任何非空自动 trigger 请求都会返回 `unsupported_capability`；已实现的保留动作是
`game_capture_pin`，不能把它写成自动异常冻结。

```bash
# CHRONORIFT_CGROUP_ROOT 必须指向当前用户可写、带 cpu/memory/pids controller 的空 delegation。
export CHRONORIFT_CGROUP_ROOT=/path/to/delegated-cgroup
# 该 mount 由 Host/operator 预先创建；ChronoRift 不负责 mount 或扩大容量。
export CHRONORIFT_TASK_STORAGE_ROOT=/mnt/chronorift-task-storage
export CHRONORIFT_RUNTIME_ROOT=/mnt/chronorift-task-storage/runtime
export CHRONORIFT_NODE_BIN=/root-owned/bin/node-22.23.1
export GODOT_BIN=/root-owned/bin/godot-4.7.1
export CHRONORIFT_GODOT_ADDON_ROOT=/path/to/chronorift/godot/addons/chronorift

corepack pnpm task -- start \
  --project /path/to/clean/frame-input-window-project \
  --goal "Investigate and fix the intermittent jump input"

corepack pnpm task -- show --task-id TASK_ID
corepack pnpm task -- continue --task-id TASK_ID --prompt "Review the diff and run another check"
corepack pnpm task -- export --task-id TASK_ID --output candidate.patch
corepack pnpm task -- discard --task-id TASK_ID
```

`--task-storage-root` / `CHRONORIFT_TASK_STORAGE_ROOT` 指定 bounded mount；`--runtime-root` /
`CHRONORIFT_RUNTIME_ROOT` 指定它下面的 Task namespace parent。二者是不同边界，不能把 mount 本身直接当作
`runtimeRoot`。

每次 sandbox operation 都在完成子挂载后将空根文件系统和 `/dev` 非递归重挂为只读；只有已声明的
workspace、`/tmp`、artifacts 与 Godot operation scratch 保持预期写权。Godot scratch 每次运行唯一，
来自 bounded mount 上不暴露给其他 sandbox 的 Host-only parent；只有 Bootstrap 退出、cgroup 为空且
scope 删除都得到证明后才回收。每个已验证 launch plan 另写 sanitized mount-admission receipt：它记录
profile 对 `/workspace` 的实际 admission、只读 target 数量/hash、credential-like target 数量和 writable
view scope，不包含 Host source path。`/tmp` 与 `/artifacts` 当前仍是 Task-global、跨 operation 共用的 writable
view；其中的残留状态可能成为顺序运行的 confounder，不能当作 operation-private 起点。只有
`/run/chronorift` project stage 是本切片的 operation-private writable view。

除 `show` 外，继续、导出和清理都会重新验证 sandbox、aggregate Task storage 与 toolchain，所以同样需要
cgroup delegation 和原来的 storage mount。当前 source preflight 只接受 clean Git 中与冻结
`frame-input-window` manifest/tree 一致的项目。

## M3：首个 vNext 垂直切片

首个且唯一的迁移 Fixture 是 `fixtures/godot-frame-input-window`。M3 源码实现让自由 Pi Agent 在该环境中
调查并修改一个真实的输入时序 Bug，并提供下列最小闭环；它仍须由对应 Gate 的实际输出验证，且不改变
v0.4 是当前 release 的事实：

1. managed workspace、OS sandbox 和安全的 coding/game tools；
2. rolling black box、手动 pin 和可见的 capture budget/loss；
3. Fixture snapshot adapter、checkpoint manifest 与 restore fidelity；
4. checkpoint fork、输入 tick/phase replay 和 first divergence；
5. Runtime State Index 与只描述差异的 compare；
6. Agent 自主修改、运行它选择的验证并留下 patch；
7. Session/workspace/artifact 可继续、handoff 或清理；
8. 新路径没有 Proposal、Claim Policy、Causal Capsule、Conclusion Gate 或 canonical verdict。

默认 `check`、Godot 与 sandbox Gate 之外，仓库还定义一个显式、release-only 的真实游戏任务
acceptance：只给 `openai-codex/gpt-5.6-luna/max` 一次 Agent attempt，冻结其候选 source identity 后，再由
产品外部 evaluator 跑 13 个场景。1 个 baseline 场景必须在 120 FPS/60 TPS、75 ms 输入下重现
`jumping=false`；candidate 在 `{60,120}×{60,120}` 四组 FPS/TPS 下，75 ms 输入必须为 `true`，250 ms
输入和无输入都必须为 `false`。这只是该 Fixture 的 release acceptance，不写回产品 Task verdict，不是
默认 CI，也不证明机制、根因、跨项目泛化或产品优势。Provider/Host 基础设施失败不是候选 acceptance
结果；候选自身造成且已证明 cleanup 的 launch/step failure 是 evaluated rejection。相同候选只有基础设施
失败可以原样重试，外部 evaluator 的 rejection 要求新的候选 source identity。

成功的 live Gate 只在 13 个场景全部接受且 Task/evaluator cleanup 已证明后，向 stdout 写一行
`[chronorift-m3-live]` JSON summary。它只含 release candidate/source identity、固定 provider/model/thinking、
一次 Agent turn、实际 evaluator attempt 数（最多两次）、场景数、`accepted` 与 `cleanupProven`；不包含
prompt、assistant prose、临时路径、原始 provider request 或 credential。该 sanitized summary 是保存 Gate
输出的便携索引，不是签名、provider attestation 或对候选正确性的产品 verdict；命令失败时不会产生成功
summary。

公开 benchmark 不作为首个切片的默认完成门槛。切片稳定后，Eval 优先使用开源、可复现 benchmark；若
现有 benchmark 缺少 checkpoint/fork 类任务，再单独公开扩展规范。

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

# legacy Godot 集成与 M3 checkpoint characterization
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

| 命令                                                | 当前作用                                                      |
| --------------------------------------------------- | ------------------------------------------------------------- |
| `corepack pnpm check`                               | lint、格式、strict typecheck 和离线测试                       |
| `corepack pnpm test:godot`                          | legacy Godot 集成与 M3 Fixture checkpoint characterization    |
| `corepack pnpm test:sandbox`                        | 真实 Host coding sandbox conformance；需要 delegated cgroup   |
| `corepack pnpm test:vnext:godot-sandbox`            | M3 Godot + sidecar + sandbox 联合 conformance                 |
| `corepack pnpm test:vnext:external-project`         | M4 冻结外部项目 lifecycle-only Host conformance               |
| `corepack pnpm test:vnext:external-semantic`        | E2 Timer/spawn 11-tool public-exposed Host conformance        |
| `corepack pnpm test:vnext:pi-live`                  | 真实 Luna/max 的 vNext Pi Session/tool smoke；非 release Gate |
| `corepack pnpm test:vnext:live`                     | release-only Luna/max + 外部 13 场景 acceptance；非默认 CI    |
| `corepack pnpm demo:v04`                            | v0.4 固定 workflow 的离线完整诊断                             |
| `corepack pnpm diagnose:v04`                        | v0.4 固定 workflow 的真实 provider 诊断                       |
| `corepack pnpm demo:v03` / `diagnose:v03`           | v0.3 兼容路径                                                 |
| `corepack pnpm fixtures`                            | 列出当前 Fixture                                              |
| `corepack pnpm godot:install` / `godot:doctor`      | 安装或检查 Godot                                              |
| `corepack pnpm pi` / `models`                       | 启动固定版本 Pi CLI 或查询模型目录                            |
| `corepack pnpm benchmark`                           | deterministic fake-model smoke；不代表产品优势                |
| `corepack pnpm benchmark:verify` / `benchmark:gate` | 重验历史报告完整性或冻结 Gate                                 |
| `corepack pnpm test:live`                           | v0.1 Mock switch-door 真实 provider smoke；不属于默认 Gate    |

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

实验性 M3 Task 的 physical namespace 是
`<runtime-root>/tasks/<task-namespace-digest>/`，不是 raw Task ID 路径；`runtimeRoot` 是 bounded
`taskStorageRoot` mount 的 canonical 严格子目录。普通 Task/turn/patch records 与 `runtime-records/` 分开；
后者拥有 build、runtime、execution、capture window、checkpoint、trace、branch、index、comparison、
tool-call 十种 task-owned resource。多个 runtime root（包括 live Agent 与 evaluator）可以共享同一个 storage
mount，因此 1 GiB/131072 inode 是该 mount 的 aggregate hard cap，而不是每个 Task 或 Execution 各自的
配额。raw execution events 在运行期 append，envelope 记录 sequence、previous hash、payload hash 和 record
hash；终止与 sidecar/sandbox cleanup 得到证明后才写独立 physical seal。sealed Execution resource 必须与
raw ledger 和 physical seal 一致；content hash 用于损坏检测，仍不是签名或外部 attestation。未完成清理的
runtime 不得借最终 assistant prose 冒充 sealed evidence。

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
apps/cli                         v0.3/v0.4 与实验性 vNext composition root
apps/cli/src/vnext               Task/workspace/sandbox/patch、Godot coordinator、sidecar、M3 acceptance
packages/domain                  engine-neutral ID、vNext runtime DTO、strict Zod schema
packages/gamebranch              legacy 服务 + vNext capture/restore/replay/index/descriptive compare
packages/agent-protocol          legacy schema + 16 个 vNext game tool strict contracts
packages/pi-harness              Pi Session/Loop adapter、coding tools 与 vNext game tool bridge
packages/godot-protocol          versioned Godot wire DTO、payload hash、TCP framing
packages/godot-adapter           Godot lifecycle、strict client、Fixture staging、runtime sidecar source
packages/json-artifacts          legacy adapter、vNext Task store 与 runtime record/seal store
packages/mock-game               deterministic switch-door legacy Fixture
godot/addons/chronorift          EditorPlugin 与 ChronoProbe Autoload
fixtures/godot-*                 四个受支持的真实 Godot Fixture
```

不要根据 Target Architecture 预先创建空的 `world-model`、`game-contracts`、`worktree-manager` 或
`execution-sandbox` package；只有真实依赖和生命周期边界落地并被测试后才拆包。

## 当前限制

- v0.4 是四个小型、显式插桩 Fixture 的诊断 workflow，不支持任意外部 Godot 项目。
- v0.4 覆盖 Pi 默认 prompt，禁用 built-in tools、skills/context，要求固定工具序列；这与 vNext 契约冲突。
- M3 只接受 clean、冻结 identity 的 `frame-input-window` 初始项目；候选 `addons/**` 当前全部拒绝。它不是
  任意外部项目 runner，也不提供视觉、音频、显示或 GPU 能力。
- M4 也不是任意外部项目 runner：它只为满足 strict descriptor 和窄 source profile 的项目提供 lifecycle-only
  onboarding。首个 Gate 只证明一个冻结 checkout；URL、commit 和 content hash 都不是签名或上游 attestation。
- M4 不提供 gameplay input/query/capture/checkpoint/fork/replay/compare，不证明候选修改正确，也不支持把单一
  conformance target 外推成跨项目兼容性或相对 coding agent 优势。
- E2 只增加声明式 Timer/spawn 投影；它仍不支持任意项目语义、input、step、capture、视觉、音频或 GPU。
  checkpoint/restore/fork/replay/compare 全部是 `descriptive_only`，public exposed spawner task 不能证明诊断能力。
- M4 不把 Host checkout 挂入 sandbox；它先物化 Task-owned candidate，Godot 对该 `/workspace` view 只读，
  再使用 writable operation-stage 容纳 import。stage 在 lifecycle
  endpoints 重验；同一 Godot 进程在窗口内修改、加载再恢复源码的行为仍不可排除，因此当前 slice 不提供
  hostile-source continuous execution identity attestation。
- M4 可在同一 Host command 内用 Task sandbox 的最终 cleanup receipt 收束未知/未证明的 operation cleanup；
  该 receipt 必须同时包含一次 fresh bounded Task-storage inspection 的成功事实；缺失或失败的 storage
  observation 会让 execution 保持 unsealed。
  若 Host 进程在 reconciliation 前突然丢失，raw ledger 会保持 unsealed，当前 slice 尚不提供跨 command 的
  open-execution recovery owner。`continue` 不会把这类历史 execution 静默标成已清理。
- M3 输入只支持 `attempt_jump`，FPS/TPS 只支持 60/120，单次控制最多 600 ticks；实际注入由 Godot 在
  `process_frame_start` 实现并报告量化位置，requested phase 不能当成 realized fact。
- M3 checkpoint 只覆盖 manifest 声明的 Fixture participant（包括 `window_open`）、logical clock 和 Host input
  schedule 等已注册域；physics internals、Timer/Tween/coroutine、线程、未注册 RNG、cache、网络和外部服务
  仍是 missing/uncontrolled state。仅 build、adapter、probe/state schema 等兼容时才 restore；跨 build fork
  使用 fresh runtime + trace replay，并标为 descriptive/confounded，不能声称等价起点。
- 当前 capture 只支持显式手动 pin；自动 crash/error/gameplay trigger 尚未实现，非空 trigger 配置会明确
  拒绝。history loss、overwrite、sampling degradation 和 observer effect 必须保留在 receipt 中。
- Addon 使用 allowlist 和显式注册；它不全局拦截任意 Signal、属性、线程或 engine internals。
- 候选脚本与 managed Addon 在同一个 Godot 进程和安全主体内运行。sidecar/Godot loopback handshake token
  只关联本次启动并拒绝意外 peer，不隔离恶意候选、也不证明 runtime telemetry 或 Addon provenance；只读
  mount、source/build hash 与 token 都不是外部 attestation。
- 普通停止、超时与可观测 crash 路径会尝试清理 execution cgroup 并记录 receipt；若 Host Harness 本身遭
  `SIGKILL`、掉电或内核级终止，它没有机会写 cleanup receipt 或删除 cgroup。delegated hierarchy 可能留下
  stale cgroup/进程，必须由 Host operator 查杀并移除；缺少 cleanup receipt 的 Execution 不能 seal。
- 当前 replay、restore validation 和 fingerprint 只说明声明维度和已观测结果，不是完整 Determinism
  Certificate；没有观察到 divergence 也不证明完整实验起点相同。
- 当前本地 report verifier 不是 provider attestation，也不证明模型报告或 Bug 修复正确。
- 历史 suite 在同四个校准 Fixture 上运行，不能支持跨项目泛化、统计显著性或产品 head-to-head。

## 开发与文档

默认完成门槛：

```bash
corepack pnpm check
corepack pnpm test:godot
```

`test:godot` 运行 legacy Godot integration/Fixture suite，以及 M3 `frame-input-window` participant
checkpoint/restore characterization；它不进入 bwrap，也不替代下面的 sidecar+sandbox 联合 Gate。

coding sandbox 还要求独立、不可跳过的真实 Host conformance：

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

M3 的 Godot profile、只读 workspace/Addon、sidecar framing、loopback 边界与 cleanup/seal 组合还要求：

```bash
# Host/operator 预先创建独立 mount；下面是 tmpfs 示例，不是 ChronoRift 自动执行的步骤。
sudo install -d -o "$(id -u)" -g "$(id -g)" -m 0700 /mnt/chronorift-m3-test
sudo mount -t tmpfs \
  -o "size=1G,nr_inodes=131072,mode=0700,uid=$(id -u),gid=$(id -g)" \
  chronorift-m3-test /mnt/chronorift-m3-test

export CHRONORIFT_TEST_CGROUP_ROOT=/sys/fs/cgroup/delegated-root
export CHRONORIFT_TEST_TASK_STORAGE_ROOT=/mnt/chronorift-m3-test
export CHRONORIFT_TEST_NODE_BIN=/root-owned/bin/node-22.23.1
export CHRONORIFT_TEST_GODOT_BIN=/root-owned/bin/godot-4.7.1
export CHRONORIFT_TEST_GODOT_ADDON_ROOT=/path/to/checkout/godot/addons/chronorift
export CHRONORIFT_TEST_BWRAP_BIN=/usr/bin/bwrap
export CHRONORIFT_TEST_PRLIMIT_BIN=/usr/bin/prlimit
export CHRONORIFT_TEST_BUSYBOX_BIN=/usr/bin/busybox
export CHRONORIFT_TEST_LDD_BIN=/usr/bin/ldd
export CHRONORIFT_TEST_FONTCONFIG_PROBE_BIN=/usr/bin/fc-match
export CHRONORIFT_TEST_XDG_USER_DIR_BIN=/usr/bin/xdg-user-dir
export CHRONORIFT_TEST_BASH_BIN=/usr/bin/bash
export CHRONORIFT_TEST_RG_BIN=/usr/bin/rg
export CHRONORIFT_TEST_FIND_BIN=/usr/bin/find
export CHRONORIFT_TEST_LS_BIN=/usr/bin/ls

corepack pnpm test:vnext:godot-sandbox
```

仓库附带的 conformance wrapper 精确要求上述 `tmpfs` 形式，因此不会把 Linux 共用 magic 的 ext2/ext3
误报成 ext4；产品 preflight 则通过 mountinfo 名称与 statfs magic 交叉验证精确的
`tmpfs|ext4|xfs`。该命令不属于默认离线 `check`；仓库 CI 的独立
`.github/scripts/run-vnext-godot-sandbox-conformance.sh` job 提供所需 Host 边界，并要求 storage mount 在开始和
清理后为空。CI 以普通 `umount` 回收 mount；不能用 lazy unmount 掩盖仍被占用的路径。真实 release
acceptance 复用上面的全部 `CHRONORIFT_TEST_*` 变量；应为 fresh run 提供一个空的独立 mount。明确授权
Host provider credential 与模型网络后，再显式运行：

```bash
corepack pnpm test:vnext:live
```

live test 在同一 `CHRONORIFT_TEST_TASK_STORAGE_ROOT` 下为 Agent Task 和 evaluator 建立不同的严格子目录；
两者共享 1 GiB/131072 inode aggregate hard cap。它只允许一次真实 Agent turn；同一 frozen candidate 最多因
evaluator infrastructure failure 再评一次。只有 acceptance 与 cleanup 都成功才输出 sanitized
`[chronorift-m3-live]` summary。该命令不是默认 CI。运行后应保存完整命令输出作为 release evidence，并只在
确认没有残留 Task/process 后正常卸载 operator-owned mount。本文列出命令不代表当前 checkout 已产生通过
输出。

M4 外部项目 Gate 复用相同的精确 toolchain、delegated cgroup 和 bounded storage 要求，但使用独立的 fresh
mount、lifecycle Addon 与 test suffix。Host/CI 必须预先提供 clean checkout 和 strict descriptor：

```bash
export CHRONORIFT_TEST_EXTERNAL_PROJECT_ROOT=/path/to/clean/moddable-platformer
export CHRONORIFT_TEST_EXTERNAL_PROJECT_DESCRIPTOR=/path/to/moddable-platformer.project.v1.json
export CHRONORIFT_TEST_EXTERNAL_PROJECT_CONFORMANCE_SPEC=/path/to/moddable-platformer.conformance.v1.json
export CHRONORIFT_TEST_EXTERNAL_PROJECT_EVIDENCE_SCHEMA=/path/to/evidence-summary.schema.v1.json
export CHRONORIFT_TEST_GODOT_LIFECYCLE_ADDON_ROOT=/path/to/chronorift/godot/addons/chronorift_lifecycle
export CHRONORIFT_TEST_GODOT_SEMANTIC_ADDON_ROOT=/path/to/chronorift/godot/addons/chronorift_semantic
export CHRONORIFT_TEST_EXTERNAL_SEMANTIC_ADAPTER_PROFILE=/path/to/moddable-platformer.semantic-adapter.v1.json
export CHRONORIFT_TEST_EVIDENCE_OUTPUT=/path/to/new/sanitized-evidence.json
export CHRONORIFT_TEST_SEMANTIC_EVIDENCE_OUTPUT=/path/to/new/sanitized-semantic-evidence.json

corepack pnpm test:vnext:external-project
corepack pnpm test:vnext:external-semantic
```

该命令自身不得 clone 或 fetch，也不会因缺少 Host 条件而 skip。CI 可以在 Host provisioning 阶段联网取得
冻结 checkout，但随后在只有 loopback 的 private network namespace 中运行 Gate。只有 Task/process/cgroup/
scratch cleanup、source checkout 不变、候选 patch round-trip 和 evidence summary 全部成功，job 才通过。
summary 必须通过 test-only strict schema；它只允许冻结 identity、数值、hash 和 cleanup facts，不包含 Host
path、prompt、assistant prose 或 credential。sandbox 字段从持久化 operation mount-admission receipts 汇总
Godot `/workspace` 只读 admission、零 credential-like mount、receipt count/hash，并显式保留
`["/tmp","/artifacts"]` 的 Task-shared scope；这些是 validated launch-plan facts，不是内核 mount
attestation。summary 也不是签名、provider attestation 或产品 verdict。本文列出命令
中的 `taskLifecycle.lifecycleOperationsObserved` 只表示 conformance 直接调用并观察到 Task service lifecycle，
不声称另起 CLI 进程或单独证明 CLI argv parsing。本文列出命令不代表当前 checkout 已产生通过输出。
clock/probe 当前只保留 lifecycle endpoint samples，并明确记录中间位置
未采样及 observer effect 未知；健康运行不能被描述成逐帧完整观测。
E2 evidence 另固定标注 `public_exposed_plumbing_conformance` 和排除的五类 claim；该 evidence 同样不是签名、
外部 attestation、修复验收或跨项目能力证明。

Godot、checkpoint、replay、schema、canonicalization、branching 或 storage 变更还应运行相应成功、失败、
corruption、reference-integrity 和 determinism/nondeterminism 覆盖；需要本机 Godot 的改动再运行
`corepack pnpm test:godot`。legacy provider smoke 使用 `corepack pnpm test:live`；M3 release-only live 路径
使用 `corepack pnpm test:vnext:live`，两者都必须显式运行。

- [Target Architecture](docs/architecture.md)：vNext 产品契约、边界和迁移计划；
- [Godot Protocol v2](docs/godot-protocol-v2.md)：当前 runtime wire contract；
- [r4 benchmark evidence](docs/benchmarks/v0.3.2-luna-r4/README.md)：冻结历史报告与复现协议；
- [v0.3.2 portfolio](docs/portfolio-v0.3.2.md)：旧垂直切片的事实摘要。
