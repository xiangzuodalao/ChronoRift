# vNext Sandbox-First Walking Skeleton 设计

> 状态：方案已批准，书面规格待复核
>
> 日期：2026-08-06
>
> 范围：ChronoRift vNext 的第一个用户可见 release slice，也是目标架构 §20 的第一段基础交付；不代表
> §20 整体完成

## 1. 决策摘要

架构重构后的第一步是交付一个 **sandbox-first 的端到端 walking skeleton**：真实 Pi Agent 在受控任务
workspace 中使用正常 coding tools，自主调查、修改并运行 `fixtures/godot-frame-input-window`，最后留下
普通 assistant 结果、候选 patch 和实际执行记录。

这是一个用户可见的 umbrella release slice，内部按三个独立 implementation milestone 降低风险：先证明
workspace/sandbox，再证明 Pi Session 与 coding tools，最后接入 Godot sidecar 与真实模型 acceptance。只有
三段全部通过才可宣称本 release slice 完成；中间产物都不是缩水版 vNext 产品。

本设计冻结以下决定：

- 首版只支持 Linux x86_64，并使用 bubblewrap、unprivileged user namespace 与 delegated cgroup v2；
- 缺少上述任一隔离或资源控制能力时返回 `unsupported`，绝不回退到 Host 直接执行；
- 采用混合生命周期：普通 coding operation 使用短生命周期 bwrap，Godot 与 runtime sidecar 使用持续到
  Execution 结束的 bwrap 进程树；
- Pi Session 与模型调用留在可信 Host；模型凭据和 provider 网络不进入工具或 Godot sandbox；
- 首个迁移对象只有 `godot-frame-input-window`；source 必须是 clean、已提交的 Git revision；
- public preflight 只接受内置 supported-fixture catalog 能验证的 `FixtureManifestV1` 与 baseline tree，不把
  “包含 project.godot”误当成任意 Godot project 支持；
- 首版只支持 diff、patch export、同一 Task 继续对话和显式 discard；不支持 apply、merge、commit 或 push
  回用户仓库；
- vNext 不新增 deterministic faux/scripted Agent。真实 release acceptance 固定使用
  `openai-codex/gpt-5.6-luna`，thinking level 为 `max`；
- 历史 v0.1-v0.4 的 faux tests、schema、artifact 和 workflow 保持兼容，但不得进入 vNext 默认路径；
- 本里程碑不实现 rolling capture、mid-run checkpoint、fork/replay、Runtime State Index 或 compare。

## 2. 背景与依据

当前 v0.4 已经有可复用的真实基础：

- 通过 Pi SDK 创建真实 `AgentSession`，并保存 Session；
- Godot Addon/Autoload、Protocol v2、capability handshake、typed telemetry、requested/realized controls、
  participant snapshot/restore 和进程清理；
- `frame-input-window` Fixture 的真实输入时序 Bug、FPS/TPS controls、probe 和 checkpoint participant；
- strict schema、canonical hash、run-scoped artifact 和路径防护模式。

但 v0.4 仍覆盖 Pi 默认 prompt，禁用 `read/bash/edit/write`，强制 Capsule、replay、intervention、compare、
Proposal 和 Verdict 的固定流程。Godot 也由 Host 直接 spawn，并通过 Host loopback TCP 通信。它不能安全地
让 Agent 修改候选代码，因此继续先做 checkpoint 或 compare 会把新的 runtime 能力建立在旧 workflow 和
Host 执行模型上。

本里程碑优先验证两个最高风险边界：

1. Pi 的正常 coding tools 能否全部通过真实 OS sandbox 执行；
2. Godot 进入独立 network namespace 后，现有 Protocol v2 能否通过 sandbox 内 sidecar 继续工作。

## 3. 目标与非目标

### 3.1 目标

1. 创建与用户 checkout 隔离、可继续、可审阅、可丢弃的 Task workspace。
2. 让 Pi 保留默认 coding-agent 行为、项目 `AGENTS.md`、skills、Session history 和自然 turn 终止。
3. 将 `read`、`bash`、`edit`、`write` 的实际操作绑定到 Sandbox Broker。
4. 让 Godot、runtime sidecar 和候选代码在同一声明过的 sandbox policy 下真实运行。
5. 保存实际 tool calls、security decisions、Godot Execution、assistant text、diff 和 patch。
6. 让同一 Task 可以继续 prompt，并在每个 turn 后清理游戏和残留子进程。
7. 用真实 GPT-5.6 Luna 完成一次 release acceptance，同时保持 Harness 不产生 fix verdict。

### 3.2 非目标

- 不支持 arbitrary external Godot projects、dirty checkout、submodule、Git LFS 或非 Git source。
- 不支持 macOS、Windows、Docker/Podman backend 或图形/GPU 模式。
- 不实现完整 syscall audit，也不把不可观测的内核失败虚构成具体安全原因。
- 不实现 dependency install、联网构建或把 provider credential 传给 task。
- 不实现 rolling black box、capture policy、mid-run checkpoint、fork、phase-aware replay、query 或 compare。
- 不修复或推广现有 Fixture snapshot adapter；尤其不能把当前未捕获 `window_open` 的 snapshot 描述成可靠
  的中途等价恢复。
- 不自动接受 patch，也不生成 `confirmed`、`verified`、`fixed` 或任何 canonical verdict。

## 4. 用户入口与成功语义

新路径使用独立 CLI namespace，legacy 命令保持原义：

```text
chronorift task start --project <path> --goal <text> --provider <id> --model <id> --thinking <level>
chronorift task continue <task-id> --prompt <text>
chronorift task show <task-id>
chronorift task export <task-id> --output <path>
chronorift task discard <task-id>
```

`task start` 完成 preflight、workspace 物化、Pi Session 创建和首个 prompt。一次 `session.prompt()` 返回只
结束当前 turn；Task 随后进入可审阅 idle 状态。`task continue` 复用同一 workspace、Session 和 artifacts。
首版的 `--project` 必须指向包含 `project.godot` 的 Godot project root；它可以是 Git worktree 根，也可以是
其中一个完全 tracked 的子目录。source revision 固定为 enclosing repository 的 `HEAD`，首版没有
`--revision` 或 dirty-overlay 语义。该目录还必须通过 §6.1 的 supported Fixture identity 校验。
`task show` 展示 assistant text、diff、patch、实际 command/game Execution、安全拒绝和资源记录。
`task export` 是用户发起的 Host-side 操作：从 sealed task patch 创建一个新的普通文件。`--output` 必须是
相对于调用时 Host cwd 的路径；absolute path、`..`、symlink 与 canonical escape 都被拒绝。输出 parent
必须已存在，目标必须不存在，首版不提供 overwrite/force。写入使用 create-new 语义，完成后记录 patch
hash、目标 canonical path 和导出结果；目标路径不能来自 Agent 或 game data。
`task discard` 显式终止残留进程并删除 workspace、Session 和 task-local artifacts；已显式导出到 Task 外的
patch 不由 discard 回收。首版没有自动 expiry。

CLI 对一次 turn 报告 `completed` 只表示 Pi Loop 正常结束并让 Task 进入 `idle_reviewable`，不表示候选修复
正确。release acceptance 可以从产品外部运行 Fixture oracle 决定该里程碑是否通过，但该结果不写成
Harness Verdict。

## 5. 总体架构

```text
Trusted Host Control Plane
  CLI Task Coordinator
    ├── Workspace Materializer
    ├── Bwrap Sandbox Broker
    ├── Pi Session Host ── model credential/network
    ├── Godot Host Bridge
    └── Task Record Store

Typed tool request / framed stdio
             │
             ▼
Untrusted task execution
  short-lived bwrap process          Execution-lived bwrap process tree
    read/bash/edit/write               runtime sidecar ⇄ local TCP ⇄ Godot
             │                                      │
             └──────── shared task mounts ──────────┘
                    /workspace /tmp /artifacts
```

### 5.1 Host Control Plane

Host 只负责：

- 解析用户输入与显式 provider/model selection；
- 创建和恢复 Task；
- 生成、验证并应用 sandbox policy；
- 调用 Pi provider，并持有用户 Pi credential store；
- 接收 tool/runtime 的真实输出，追加记录并显示结果；
- 终止进程组、保留或显式清理 Task。

Host 不解释 Bug 原因、不替 Agent选择实验、不决定 patch 正确性，也不把 game/runtime 内容当作 policy。

### 5.2 混合生命周期 Sandbox

普通 coding operation 每次通过同一个 policy template 启动短生命周期 bwrap。Godot Execution 启动一个
独立 bwrap 进程树，内部先启动 runtime sidecar，再由 sidecar 启动 Godot。sidecar 与 Godot 在同一
network namespace 中通过现有 loopback TCP 协议通信；Host 与 sidecar 只通过继承的 stdin/stdout 使用
versioned framed RPC，不开放 Host TCP 端口。

首版不建立通用常驻 Task Supervisor。只有当后续 Session resume、并发或 capture 生命周期产生真实共享
状态需求时，才评估把两个执行路径合并为常驻 supervisor。

## 6. Workspace 物化

### 6.1 Preflight

在创建 Task 前必须验证：

- Host 是 Linux x86_64；bubblewrap、unprivileged user namespace、delegated cgroup v2 及所需 controller
  可用；
- `--project` 是 enclosing Git worktree 内包含已 tracked `project.godot` 的 canonical directory，整个
  enclosing worktree 必须没有 tracked 或 unignored untracked 变化，`HEAD` 必须解析为 commit；source set
  恰好是 `HEAD` 中 project subtree 的 tracked entries，ignored cache 不进入 Task；
- project subtree 包含 strict、tracked 的 `FixtureManifestV1`；其 `fixtureId`、schema/protocol version、启动
  scene、允许 controls 和必要 managed runtime 必须与 CLI 内置的 supported-fixture catalog 匹配。Host
  另行计算包含 manifest 在内的 selected-tree hash，并与 catalog 的 expected baseline hash 比较。首版 catalog
  只有 `frame-input-window`；未知、伪造或 hash 不匹配都返回 `source_feature_unsupported`；
- source 不包含 submodule、Git LFS pointer 或逃逸 source root 的 symlink；
- Godot binary、固定 Node/pnpm toolchain 和首版所需预装依赖可读；
- artifact、task temp 和 workspace roots 经过 canonical containment，彼此不重叠用户 checkout；
- provider/model selection 存在；任何会调用 `session.prompt()` 的 `task start` 或 `task continue` 都要求
  对应 Host credential 可用。纯离线 component/port tests 不经过这两个 CLI 路径。

任一条件不满足都在产生 Agent side effect 前返回结构化 `unsupported` 或 `denied`。

Preflight 成功后，Host 把 catalog resolution、verified manifest fields、control allowlist、启动场景、managed
runtime identities 和 baseline tree hash 封成不可变 `TaskFixtureCapabilityV1`。后续 project text 不能重新
协商或扩大这份 capability；所有 `game_run` 授权只读取该 frozen record。

### 6.2 Materialization

1. Host 在 Task 临时根下从 enclosing repository 的 `HEAD` 创建 detached staging worktree。
2. 只复制 `--project` 相对 repository root 的 tracked subtree，并去掉该 prefix，使 Godot project root 成为
   task-owned `/workspace`；不复制 staging worktree 的 `.git` 文件，也不带入 subtree 外的 repository 文件。
3. 在 task workspace 中创建独立 Git metadata 和 baseline commit。
4. 记录 Host repository identity、source revision、project prefix、selected-tree hash、task baseline hash 和
   复制规则。
5. 移除 staging worktree；Host repository refs、worktree metadata 和 Git config 从不挂载进 sandbox。

Agent 在 sandbox 内看到的 `/workspace` 是 task-owned private repository，因此可以使用普通 Git read/diff
命令而不能修改 Host refs。ChronoRift 从 private baseline 生成 binary-safe `patch.diff`。每次 `game_run`
使用当前 workspace 的 candidate snapshot，而不要求文件已 commit；snapshot 排除 private `.git` 与声明的
cache，并产生独立 source identity。

### 6.3 首版依赖供应

首版不联网安装依赖。最小 Linux runtime、固定 Node、pnpm/corepack 和本仓库已安装依赖按 profile 以显式
只读 mount 提供；Godot binary、Addon 与 sidecar 只出现在 `godot-headless` Execution，不暴露给普通
sandboxed bash 直接启动。需要写缓存的工具只能写 task temp。任何缺失依赖都返回 preflight failure，而
不是临时开放 Host home、包管理器 credential 或网络。

## 7. Sandbox Policy

每个 Task 生成 canonical、可哈希的 `SandboxPolicyV1`。所有 coding 和 Godot operation 都引用同一 policy
identity，但可以声明不同的 resource profile。

### 7.1 Mount 与 namespace

- sandbox root 使用 tmpfs 或最小构造 root；Host `/` 不整体挂载；
- `/workspace`、task `/tmp` 和 task `/artifacts` 是仅有的可写 mount；
- Linux runtime、固定 toolchain、Godot 和预装依赖只读挂载；
- `/proc` 与 `/dev` 使用 bwrap 提供的隔离视图；
- mount、PID、IPC、UTS 和 network namespace 都必须建立；cgroup namespace 仅在通过 conformance 的平台上
  启用并记录，但 task-scoped cgroup resource enforcement 始终是必需能力；
- Godot profile 只在自己的 network namespace 内启用 loopback；不建立外部 route；
- Host checkout、home、SSH Agent、浏览器数据、云 token、Pi auth 和无关环境变量均不存在。

### 7.2 进程与资源

- 每次执行有独立进程组，并由 Host wall-clock timeout 和取消信号控制；
- 首版固定两个 canonical profile。`coding-default` 的 wall timeout 默认为 120 秒、可请求范围为 1–600
  秒；`godot-headless` 默认为 180 秒、可请求范围同样为 1–600 秒。两者都限制最多 2 个 CPU core、2 GiB
  memory、128 个进程、1024 个 open file；单个文件上限分别为 512 MiB 和 1 GiB，stdout 与 stderr 各自
  最多保留 16 MiB，截断必须显式记录；
- wall timeout 由 Host supervisor 执行；CPU、memory 和 process count 由 task-scoped delegated cgroup v2
  执行；open-file 和 file-size 使用 rlimit。cgroup 建立、controller delegation 或 rlimit 设置任一失败都
  必须在启动目标进程前 fail closed；
- receipt 记录请求限制、实际采用的机制、无法采用的限制和可观测 resource usage；
- 资源限制无法按 policy 建立时 fail closed，不以“尽力而为”继续；
- turn 结束、取消、失败和 discard 都遍历并终止对应进程组。

### 7.3 安全拒绝与诚实边界

- typed file tools 只接受相对于 `/workspace` 的路径，并在 spawn 或文件操作前做 capability、absolute path、
  `..`、symlink 和 canonical containment 校验；拒绝时不产生目标副作用，并写 `SecurityEventV1`；
- sandbox launch、mount、device、network capability 和资源 policy 在启动前校验；
- 任意 bash 内部访问未挂载 Host 路径或外部网络时由 kernel boundary 阻止；原始 command、policy hash、
  stdout/stderr、exit/signal 和已验证的 denial information 必须保留；
- 只有 sidecar 或 kernel channel 能明确归因时才写具体 syscall denial。否则记录一般 sandbox failure，
  不从 stderr 猜测虚假的越权原因；
- 每个工具结果把结构化 denial 或原始 sandbox failure 返回 Agent，使 Pi Loop 可以继续；
- 任何错误路径都不允许改用 Host `fs`、Host shell 或 Host Godot 作为 fallback。

## 8. Pi SDK 集成

实现必须以已安装 `@earendil-works/pi-coding-agent@0.83.0` 的公开 source 和 types 为准。

### 8.1 Session 与资源

- 通过 `createAgentSession()` 创建 Session；ChronoRift 不实现第二套 Loop；
- `SessionManager` 写入 Task 的 `pi-sessions/` 并支持 `task continue`；
- `DefaultResourceLoader` 从 task-owned workspace 加载 `AGENTS.md`、skills、prompt templates 和适用资源；
- 使用 `appendSystemPrompt` 追加简短的 ChronoRift 环境说明，不使用 `systemPromptOverride` 替换 Pi 默认
  coding-agent prompt；
- project-local extension 是可执行代码，首版禁止在 Pi Host 加载；只有 Host 显式安装并授权的 extension
  factory 可以启用。`AGENTS.md`、skills 和 prompt templates 作为不可信文本加载，不能改变 Host policy；
- Agent-visible cwd 与工具路径规范化为 `/workspace`。一个薄 `TaskResourceLoader` façade 在内部使用
  `DefaultResourceLoader` 读取 task-owned materialization，并把所有暴露路径映射为 `/workspace`；
- 用户项目内容不能改变 Host policy、mount、credential 或 capability。

### 8.2 Coding tools

首版启用 Pi 语义兼容的 `read`、`bash`、`edit`、`write`。在实现绑定前，先针对已安装的 Pi 0.83.0 做
compatibility characterization：逐个检查 tool factory 的 argument normalization、execute、render/preview
和 error path，证明所有文件探测、文件读取和进程创建都经 Sandbox Broker。仅仅注入 pluggable operations
不能作为隔离证明；例如 factory 自身的 path resolution 或 edit preview 也可能执行 Host I/O。

通过 characterization 的 factory 才能直接使用。任何路径仍触碰 Host 时，改用 Pi 公开 `defineTool` 和
`customTools` 注册 broker-only 的语义兼容实现；不得 deep-import、fork、vendor Pi，也不得用 Host local
builtin 作 fallback。最终 active tool registry 中 `read/bash/edit/write` 必须只解析到经验证的 broker
definition，并由 conformance test 证明 execute、render 和错误路径均不产生 Host workspace I/O。

Pi 的默认 `grep/find/ls` backend 可能直接访问 Host filesystem 或 spawn Host process，因此首版不启用。
Agent 可以通过 sandboxed `bash` 使用 sandbox 内的 `rg`、`find` 和 `ls`。后续只有在对应 backend 也能
通过 broker 时才开放独立工具。

工具没有固定调用顺序、exactly-once 约束或全局阶段。只因同一文件 mutation、Godot process 或其他真实
资源冲突做局部串行化；冲突返回 recoverable `busy`/`conflict`。

### 8.3 模型路径

Pi Host 可以通过用户 credential store 调用 provider。provider/model/thinking 在 `task start` 显式选择并
记录；它们不进入 sandbox environment。vNext 不提供 scripted Agent fallback，也不在 provider failure
后静默切换模型。

普通 assistant 消息结束当前 turn。Harness 不要求 Proposal schema、submit tool 或 artifact 引用仪式。

## 9. 首版工具面

### 9.1 Coding tools

- `read(path, offset?, limit?)`
- `bash(command, timeout?)`
- `edit(path, edits)`
- `write(path, content)`

除明确的安全收缩外，参数与结果保持 Pi 默认工具语义；新增 sandbox metadata 通过 tool details/records
提供，不把用户可见文本变成唯一真实来源。

这里的“语义兼容”是可测试契约，而不是措辞目标：tool name 和 input fields、`/workspace` cwd、read 的
1-based offset/limit、edit 的唯一匹配与原子修改及 diff、write 的 parent-directory 行为、bash 的
streaming/truncation、non-zero exit、timeout 和 cancellation 都要与当前 pinned Pi 行为做 fixture 对照。
允许的收缩只有 file tool 拒绝 absolute/`..`/escape path、bash timeout 上限和 sandbox capability denial；
这些差异必须返回结构化错误。ChronoRift 可以在 tool details 中增加 receipt/artifact identity，但不能改变
模型依赖的其他核心结果语义。

### 9.2 `game_run`

`game_run` 是唯一新增 game tool。它允许 Agent 在任意时点重复运行，不依赖其他工具调用历史。

首版输入包括：

- 固定允许值 `fixture: "frame-input-window"`；
- 可选 input trace，默认使用 Fixture 的已知失败 trace；
- 可选 `fixedFps`、`physicsTicksPerSecond` 和 `maxTicks`，严格限制在 frozen
  `TaskFixtureCapabilityV1` 的允许范围；
- 可选 timeout。

调用时必须从当前 workspace 计算 source identity，并重新解析 candidate 中的 `FixtureManifestV1`。Agent 可以
修改该文件并让修改进入 diff，但它不能改变 frozen capability；security-relevant field 与 frozen record 不兼容
时返回 `source_configuration_mismatch`，不得按新值重新授权。校验通过后创建 execution-specific
build/staging identity，再在 Godot sandbox 中运行。返回：

- `executionId`、source/build/runtime identities；
- requested/realized controls 与时钟位置；
- process result、stdout/stderr refs；
- typed events、最终已注册状态和 observation coverage；
- dropped/truncated events、协议错误与清理状态；
- artifact refs。

它不返回 causal explanation、root cause、fix verdict 或预设下一实验。

### 9.3 Managed Addon 与 runtime 注入

当前 Fixture 的 `project.godot` 引用 `res://addons/chronorift/chrono_probe.gd`，而该 Addon 不属于用户 project
subtree。`game_run` 因此必须把 candidate snapshot 物化为 execution build root，再把与当前 ChronoRift
版本配套的 Host-approved Addon bundle 以只读 mount 注入 `res://addons/chronorift`，并以只读 mount 提供
runtime sidecar 与固定 Godot binary。workspace 中若已存在注入目标则 fail closed，不能覆盖 Agent 文件。

source identity 只覆盖 candidate workspace；build identity 还覆盖 source identity、Addon bundle hash、
sidecar hash、Godot binary identity、protocol version 和 sandbox policy identity。三类 managed dependency
都写入 build manifest，不进入 patch，也不能在 sandbox 内修改。首版若 Agent 需要额外观察逻辑，只能在
workspace 的非保留路径新增普通 game-side probe/code；可编辑 snapshot adapter 留给后续 milestone。

## 10. 记录与 Artifact

首个切片实现目标布局的最小子集：

```text
.chronorift/
└── tasks/<task-id>/
    ├── task.json
    ├── workspace.json
    ├── tool-calls.jsonl
    ├── security.jsonl
    ├── pi-sessions/
    ├── builds/<build-id>/manifest.json
    ├── executions/<execution-id>/
    │   ├── manifest.json
    │   ├── events.jsonl
    │   ├── stdout.log
    │   ├── stderr.log
    │   └── result.json
    ├── assistant/<turn-id>.json
    ├── patch.diff
    ├── exports.jsonl
    └── handoff.json
```

所有 persisted DTO 都有 strict `schemaVersion`。JSONL 在运行期间 append，终止后 seal；历史记录不原地
改写。assistant text、patch 和实际 tool/runtime records 分开保存。

每个 tool record 至少包含：

- task、turn、tool-call 和 policy identity；
- requested input 与 policy decision；
- start/end monotonic time、status、exit/signal；
- stdout/stderr refs 与 truncation；
- requested/realized resource limits；
- sandbox/backend identity；
- error 或 denial details；
- 适用时的 source/build/Execution lineage。

Hash 用于 deterministic identity 和意外损坏检测，不宣称签名或外部 attestation。

## 11. Task 生命周期

```text
creating → ready → running_turn → idle_reviewable ↺ running_turn
    │         │          │               │
    └── setup_failed     turn_failed      └── discarded
```

- `setup_failed` 发生在 Agent 启动前，保留 preflight 与安全记录；
- `turn_failed` 只表示当前 provider/Host/显式超时导致 turn 未正常结束；已有 workspace 和 records 保留；
- 普通 tool error 不自动改变 Task 状态或终止 turn；
- 每个 turn 结束都清理 Godot、sidecar 和残留 command process；
- `idle_reviewable` 可以继续 prompt、show 或 discard；
- Task 状态不表示调查阶段，也不限制工具顺序；
- 首版 destructive discard 只在用户显式请求时执行，不实现自动保留期清理。

## 12. 错误模型

首版至少区分：

- `unsupported_platform`
- `sandbox_preflight_failed`
- `source_not_clean`
- `source_feature_unsupported`
- `source_configuration_mismatch`
- `managed_runtime_collision`
- `path_denied`
- `capability_denied`
- `sandbox_launch_failed`
- `resource_limit_unavailable`
- `command_failed`
- `command_timed_out`
- `command_cancelled`
- `godot_protocol_failed`
- `godot_crashed`
- `provider_credential_unavailable`
- `provider_unavailable`
- `model_configuration_mismatch`
- `turn_timed_out`
- `artifact_write_failed`
- `patch_export_failed`

错误记录保留实际 cause chain，但返回 Agent 或用户的内容必须移除 credential 和未授权 Host path。所有
recoverable tool error 都作为 tool result 回到 Pi Loop；只有用户取消、显式 turn timeout、不可恢复的
provider failure 或 Host 自身失败终止 turn。

## 13. 测试设计

### 13.1 离线工程 Gate

`corepack pnpm check` 保持 credential-free 和 provider-network-free，覆盖：

- Task、workspace、policy、receipt、SecurityEvent、Execution 和 patch schema；
- canonicalization、identity、lineage、append/seal 和 corruption；
- clean source、unsupported source feature 和 private Git baseline；
- supported Fixture manifest/catalog、baseline tree mismatch、manifest capability escalation、managed
  injection collision 与 build identity；
- path traversal、absolute path、symlink 和 canonical escape；
- real bubblewrap mount/network/env isolation、timeout、取消、资源和残留进程清理；
- Godot sidecar framed RPC、Protocol v2 handshake、真实 sandboxed Fixture execution 和 crash cleanup；
- Pi host composition 通过 port-level stubs 验证 active tools、resource loader、prompt appendix 和 Session
  restore，但不运行 scripted/faux Agent；
- vNext artifact 中不存在 Proposal、Claim Policy、Capsule Gate 或 Verdict。

如果默认 CI 环境不能提供本里程碑声明支持的 bubblewrap、user namespace、delegated cgroup v2 controller
或 Godot，相关 real conformance 测试必须显式失败或由单独的必需 CI job 执行；不得以静默 skip 冒充通过。

### 13.2 真实 Agent Release Acceptance

真实 acceptance 命令为：

```bash
corepack pnpm test:vnext:live -- \
  --provider openai-codex \
  --model gpt-5.6-luna \
  --thinking max
```

该 Gate：

1. fail closed 校验 pinned Pi catalog 解析出的 provider/model identity；在当前 catalog 下还要求 context
   window 为 `272000`、max tokens 为 `128000`，并且 requested/effective thinking 与
   `thinkingLevelMap.max` 都是 `max`。provider response 若返回服务端 model 字段则原样记录，但 catalog
   metadata 不被描述成服务端 attestation；
2. 使用用户 Pi credential store，仅让 Pi Host 访问 provider；
3. 从受支持 Fixture source subtree 创建带匹配 manifest/hash 的独立、clean 临时 Git project；Addon 与
   runtime 只走 §9.3 的 managed injection，不进入 source repository。临时 project 不复制 benchmark spec、
   旧 oracle、预期 mechanism/source locus 或其他答案材料；
4. acceptance setup 在 Agent Loop 外、但通过同一 sandbox/build/runtime adapter 确认原始 project 能复现
   失败，并把此记录只留给外部 evaluator；
5. 创建真实 Task、private workspace 和 bubblewrap sandbox，让 Agent 自主调查，不提供固定工具步骤或
   预期 source locus；
6. 要求产生候选修改、reviewable patch，以及至少一次 source identity 等于最终候选内容的真实
   `game_run`；不要求 Agent 自己先运行 baseline，也不规定其他工具的先后顺序；
7. 保存完整 provider/tool/runtime/patch lineage、token 和耗时；
8. 由产品外部 acceptance oracle 在 Task 结束后运行已声明 Fixture 行为检查；
9. 不把 oracle 结果写回产品 Verdict，也不把 hidden answer 注入 Agent prompt/tool output；
10. provider failure 记为 infrastructure failure，不换模型、不使用 scripted fallback；
11. 不断言 exact tool order、exact patch 或 assistant prose。

真实模型没有 sampling seed，因此该 Gate 证明一次有完整 provenance 的实际 acceptance，不证明统计可靠性或
一般化能力。重复性、成功率和对照组留给后续独立开源 benchmark。

### 13.3 完成声明

里程碑完成后只允许声称：

> ChronoRift 已证明真实 GPT-5.6 Luna Agent 可以在一个真实隔离的 task workspace 中修改并运行
> `frame-input-window`，并留下真实 patch 与执行记录。

不得声称 checkpoint/fork moat 已实现，不得声称 Harness 从逻辑上证明修复正确，也不得把一次 live run
外推为跨项目可靠性。

## 14. 代码落点与依赖方向

首版优先在现有 package 中形成真实边界，不预建空 package：

- `packages/domain`：纯 Task、Turn、Execution 和 patch identity/DTO；不含 mount、namespace、device、resource
  或 filesystem-layout policy；
- `packages/pi-harness`：薄 vNext Pi host、broker-backed tool binding、Session events 和 prompt appendix；
- `packages/godot-adapter`：可注入 process launcher、sandbox sidecar binding 和当前 Protocol v2 复用；
- `packages/json-artifacts`：新 `.chronorift/tasks/` namespace 与 append/seal adapters；
- `apps/cli`：Task lifecycle、workspace materializer、`SandboxPolicyV1`、security/resource receipts、concrete
  bwrap/cgroup broker、composition 与显示；
- `fixtures/godot-frame-input-window`：唯一 vNext Fixture；不迁移其 legacy oracle 到产品结果。

`domain ← gamebranch ← adapters ← CLI` 与 `domain ← agent-protocol ← pi-harness/CLI bridge` 的方向保持
不变；本切片不需要 gamebranch policy service 的 adapter 可以直接依赖 domain 或 agent-protocol 的公开
契约。Sandbox Broker 的 concrete implementation 首版留在 CLI；只有其依赖、生命周期和跨 consumer port
经测试稳定后，才评估拆出 `execution-sandbox` 或 `worktree-manager` package。

## 15. 实施顺序与后续里程碑

本 umbrella design 不替代 implementation plan。实现必须拆为三个可单独验证、一次只引入一个主要未知量的
内部 milestone：

1. **M1 — workspace 与 sandbox conformance**：Task/Execution identity、preflight、clean Git
   materialization、private workspace、patch extraction/export、固定 resource profiles、bwrap/cgroup broker、
   receipts、security tests 与 cleanup；不接 Pi，不接 Godot。
2. **M2 — Pi task/session 与 coding tools**：Pi compatibility characterization、broker-only
   `read/bash/edit/write`、resource loading、Session start/continue、records 和 CLI show/discard；用 port-level
   fake provider 验证 composition，不新增 faux Agent 产品路径。
3. **M3 — Godot 与 release acceptance**：runtime sidecar、`game_run`、sandboxed Fixture、完整 Task CLI，先过
   离线 Gate，再用真实 GPT-5.6 Luna max 跑一次 release acceptance。

M1/M2 是内部 integration checkpoint，不可单独发布或声称端到端目标已达成。M3 通过且本设计所有 Gate
成立后，首个用户可见 release slice 才完成。书面规格获批后，第一份 implementation plan 只覆盖 M1；M1
完成并复盘实际边界后，再分别为 M2、M3 写计划，避免一次计划同时赌三个高风险接口。

该 walking skeleton 通过后，下一独立设计从无阶段 game tools 继续到 rolling capture、pin/trigger 和预算退化；
随后才设计具有诚实 manifest/fidelity 的 mid-run checkpoint 与 replay。

## 16. 主要风险与控制

| 风险                                        | 控制                                                                                  |
| ------------------------------------------- | ------------------------------------------------------------------------------------- |
| Host Git refs 暴露给 Agent                  | staging worktree 只用于 Host 物化；sandbox 使用 private task Git metadata             |
| 任意 Godot project 被误报为受支持           | strict Fixture manifest、内置 catalog 与 baseline tree hash；首版仅一个 Fixture       |
| Agent 修改 manifest 提升运行能力            | preflight 冻结 Task capability；`game_run` 只读 frozen record，不兼容修改显式失败     |
| Pi builtin 绕过 broker                      | 同名 custom tools 覆盖并做 active-tool compatibility test；未知 builtin fail closed   |
| Pi factory 的 preview/path helper 读取 Host | 先 characterization；未通过者用公开 `defineTool` 构建 broker-only 兼容实现            |
| project extension 在 Host 执行任意代码      | 禁止 project-local extension；只允许 Host 安装且显式授权的 extension factory          |
| Godot 无法跨 network namespace 连接 Host    | runtime sidecar 与 Godot 同 namespace 使用 local TCP；Host 只走 stdio RPC             |
| Fixture 缺少 subtree 外 ChronoProbe         | execution build 中只读注入 versioned Addon/runtime 并纳入 build hash；不污染 patch    |
| toolchain 或依赖泄露 Host home              | 只读精确 mount 与 env allowlist；缺失依赖 preflight failure                           |
| 任意 bash 的失败被错误解释为安全事件        | 保留原始 result 与 policy；只报告可验证 denial，不从 stderr 推断 syscall 原因         |
| 真实模型 Gate 波动或产生费用                | 与离线 Gate 分层，固定 model metadata，完整记录 provenance，不自动 fallback           |
| Fixture 文档泄露预期答案                    | live Gate 使用最小独立 project；oracle 与 benchmark material 保持在产品 Task 外       |
| 新路径再次演化为 workflow                   | 无 phase state、无固定顺序、无 submit tool、无 Proposal/Verdict；测试只断言效果与记录 |
| walking skeleton 被误称为 runtime moat      | 完成声明明确排除 rolling capture、checkpoint/fork、query 和 compare                   |
