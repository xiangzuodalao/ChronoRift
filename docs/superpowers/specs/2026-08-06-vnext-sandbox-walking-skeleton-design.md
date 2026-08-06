# vNext Sandbox-First Walking Skeleton 设计

> 状态：已批准，待实施
>
> 日期：2026-08-06
>
> 范围：ChronoRift vNext 的第一个实现里程碑

## 1. 决策摘要

架构重构后的第一步是交付一个 **sandbox-first 的端到端 walking skeleton**：真实 Pi Agent 在受控任务
workspace 中使用正常 coding tools，自主调查、修改并运行 `fixtures/godot-frame-input-window`，最后留下
普通 assistant 结果、候选 patch 和实际执行记录。

本设计冻结以下决定：

- 首版只支持 Linux x86_64，并使用 bubblewrap 与 unprivileged user namespace；
- 缺少 bubblewrap 或 user namespace 时返回 `unsupported`，绝不回退到 Host 直接执行；
- 采用混合生命周期：普通 coding operation 使用短生命周期 bwrap，Godot 与 runtime sidecar 使用持续到
  Execution 结束的 bwrap 进程树；
- Pi Session 与模型调用留在可信 Host；模型凭据和 provider 网络不进入工具或 Godot sandbox；
- 首个迁移对象只有 `godot-frame-input-window`；source 必须是 clean、已提交的 Git revision；
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
chronorift task discard <task-id>
```

`task start` 完成 preflight、workspace 物化、Pi Session 创建和首个 prompt。一次 `session.prompt()` 返回只
结束当前 turn；Task 随后进入可审阅 idle 状态。`task continue` 复用同一 workspace、Session 和 artifacts。
`task show` 展示 assistant text、diff、patch、实际验证、Execution、安全拒绝和资源记录。`task discard`
显式终止残留进程并删除临时 workspace；已导出的 patch 不由 discard 回收。

产品级 `completed` 只表示 Pi Loop 正常结束并留下可审阅交付物，不表示候选修复正确。release
acceptance 可以从产品外部运行 Fixture oracle 决定该里程碑是否通过，但该结果不写成 Harness Verdict。

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

- Host 是 Linux x86_64；bubblewrap 和 unprivileged user namespace 可用；
- source 是 clean Git repository，目标 revision 可解析且工作区无 tracked/untracked 变化；
- source 不包含 submodule、Git LFS pointer 或逃逸 source root 的 symlink；
- Godot binary、固定 Node/pnpm toolchain 和首版所需预装依赖可读；
- artifact、task temp 和 workspace roots 经过 canonical containment，彼此不重叠用户 checkout；
- provider/model selection 存在；只有 live acceptance 还要求 Host credential 可用。

任一条件不满足都在产生 Agent side effect 前返回结构化 `unsupported` 或 `denied`。

### 6.2 Materialization

1. Host 在 Task 临时根下从目标 revision 创建 detached staging worktree。
2. 只把 tracked tree 复制到 task-owned workspace，不复制 staging worktree 的 `.git` 文件。
3. 在 task workspace 中创建独立 Git metadata 和 baseline commit。
4. 记录 Host repository identity、source revision、tracked-tree hash、task baseline hash 和复制规则。
5. 移除 staging worktree；Host repository refs、worktree metadata 和 Git config 从不挂载进 sandbox。

Agent 在 sandbox 内看到的 `/workspace` 是 task-owned private repository，因此可以使用普通 Git read/diff
命令而不能修改 Host refs。ChronoRift 从 private baseline 生成 binary-safe `patch.diff`。

### 6.3 首版依赖供应

首版不联网安装依赖。固定 Node、pnpm/corepack、Godot binary、最小 Linux runtime 和本仓库已安装依赖以
显式只读 mount 提供。需要写缓存的工具只能写 task temp。任何缺失依赖都返回 preflight failure，而不是
临时开放 Host home、包管理器 credential 或网络。

## 7. Sandbox Policy

每个 Task 生成 canonical、可哈希的 `SandboxPolicyV1`。所有 coding 和 Godot operation 都引用同一 policy
identity，但可以声明不同的 resource profile。

### 7.1 Mount 与 namespace

- sandbox root 使用 tmpfs 或最小构造 root；Host `/` 不整体挂载；
- `/workspace`、task `/tmp` 和 task `/artifacts` 是仅有的可写 mount；
- Linux runtime、固定 toolchain、Godot 和预装依赖只读挂载；
- `/proc` 与 `/dev` 使用 bwrap 提供的隔离视图；
- unshare mount、PID、IPC、UTS、cgroup 视平台能力执行，并始终 unshare network；
- Godot profile 只在自己的 network namespace 内启用 loopback；不建立外部 route；
- Host checkout、home、SSH Agent、浏览器数据、云 token、Pi auth 和无关环境变量均不存在。

### 7.2 进程与资源

- 每次执行有独立进程组，并由 Host wall-clock timeout 和取消信号控制；
- CPU、address-space/memory、process count、file size 和 open-file limits 使用可用的 Linux 原语设置；
- receipt 记录请求限制、实际采用的机制、无法采用的限制和可观测 resource usage；
- 资源限制无法按 policy 建立时 fail closed，不以“尽力而为”继续；
- turn 结束、取消、失败和 discard 都遍历并终止对应进程组。

### 7.3 安全拒绝与诚实边界

- typed file tools 在 spawn 或文件操作前做 capability、absolute/relative path、`..`、symlink 和 canonical
  containment 校验；拒绝时不产生目标副作用，并写 `SecurityEventV1`；
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
- Agent-visible cwd 与工具路径规范化为 `/workspace`。Host loader 只读取 task-owned materialization，并
  映射或隐藏 Host 物理 task path；
- 用户项目内容不能改变 Host policy、mount、credential 或 capability。

### 8.2 Coding tools

首版启用 Pi 语义兼容的 `read`、`bash`、`edit`、`write`。使用 Pi 公开 tool factory 和 pluggable
operations，将实际文件与进程操作绑定到 Sandbox Broker；custom definitions 覆盖同名 local builtin，
不得 deep-import Pi 私有实现。

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

参数与结果尽量保持 Pi 默认工具语义；新增 sandbox metadata 通过 tool details/records 提供，不把用户可见
文本变成唯一真实来源。

### 9.2 `game_run`

`game_run` 是唯一新增 game tool。它允许 Agent 在任意时点重复运行，不依赖其他工具调用历史。

首版输入包括：

- 固定允许值 `fixture: "frame-input-window"`；
- 可选 input trace，默认使用 Fixture 的已知失败 trace；
- 可选 `fixedFps`、`physicsTicksPerSecond` 和 `maxTicks`，严格限制在 manifest 声明范围；
- 可选 timeout。

调用时必须从当前 workspace 计算 source identity，创建 execution-specific build/staging identity，再在 Godot
sandbox 中运行。返回：

- `executionId`、source/build/runtime identities；
- requested/realized controls 与时钟位置；
- process result、stdout/stderr refs；
- typed events、最终已注册状态和 observation coverage；
- dropped/truncated events、协议错误与清理状态；
- artifact refs。

它不返回 causal explanation、root cause、fix verdict 或预设下一实验。

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
    └── setup_failed     turn_failed      └── discarded / expired
```

- `setup_failed` 发生在 Agent 启动前，保留 preflight 与安全记录；
- `turn_failed` 只表示当前 provider/Host/显式超时导致 turn 未正常结束；已有 workspace 和 records 保留；
- 普通 tool error 不自动改变 Task 状态或终止 turn；
- 每个 turn 结束都清理 Godot、sidecar 和残留 command process；
- `idle_reviewable` 可以继续 prompt、show 或 discard；
- Task 状态不表示调查阶段，也不限制工具顺序；
- destructive discard 只在用户显式请求或明确保留期到期时执行。

## 12. 错误模型

首版至少区分：

- `unsupported_platform`
- `sandbox_preflight_failed`
- `source_not_clean`
- `source_feature_unsupported`
- `path_denied`
- `capability_denied`
- `sandbox_launch_failed`
- `resource_limit_unavailable`
- `command_failed`
- `command_timed_out`
- `command_cancelled`
- `godot_protocol_failed`
- `godot_crashed`
- `provider_unavailable`
- `model_configuration_mismatch`
- `turn_timed_out`
- `artifact_write_failed`

错误记录保留实际 cause chain，但返回 Agent 或用户的内容必须移除 credential 和未授权 Host path。所有
recoverable tool error 都作为 tool result 回到 Pi Loop；只有用户取消、显式 turn timeout、不可恢复的
provider failure 或 Host 自身失败终止 turn。

## 13. 测试设计

### 13.1 离线工程 Gate

`corepack pnpm check` 保持 credential-free 和 provider-network-free，覆盖：

- Task、workspace、policy、receipt、SecurityEvent、Execution 和 patch schema；
- canonicalization、identity、lineage、append/seal 和 corruption；
- clean source、unsupported source feature 和 private Git baseline；
- path traversal、absolute path、symlink 和 canonical escape；
- real bubblewrap mount/network/env isolation、timeout、取消、资源和残留进程清理；
- Godot sidecar framed RPC、Protocol v2 handshake、真实 sandboxed Fixture execution 和 crash cleanup；
- Pi host composition 通过 port-level stubs 验证 active tools、resource loader、prompt appendix 和 Session
  restore，但不运行 scripted/faux Agent；
- vNext artifact 中不存在 Proposal、Claim Policy、Capsule Gate 或 Verdict。

如果默认 CI 环境不能提供本里程碑声明支持的 bubblewrap/user namespace/Godot，相关 real conformance
测试必须显式失败或由单独的必需 CI job 执行；不得以静默 skip 冒充通过。

### 13.2 真实 Agent Release Acceptance

真实 acceptance 命令为：

```bash
corepack pnpm test:vnext:live -- \
  --provider openai-codex \
  --model gpt-5.6-luna \
  --thinking max
```

该 Gate：

1. fail closed 校验实际 model identity、context/max-token metadata、requested/effective thinking；
2. 使用用户 Pi credential store，仅让 Pi Host 访问 provider；
3. 创建真实 Task、private workspace 和 bubblewrap sandbox；
4. 让真实 Agent 自主调查 `frame-input-window`，不提供固定工具步骤或预期 source locus；
5. 要求产生至少一次真实 baseline game Execution、候选修改、后续实际验证和 reviewable patch；
6. 保存完整 provider/tool/runtime/patch lineage、token 和耗时；
7. 由产品外部 acceptance oracle 在 Task 结束后运行已声明 Fixture 行为检查；
8. 不把 oracle 结果写回产品 Verdict，也不把 hidden answer 注入 Agent prompt/tool output；
9. provider failure 记为 infrastructure failure，不换模型、不使用 scripted fallback；
10. 不断言 exact tool order、exact patch 或 assistant prose。

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

- `packages/domain`：纯 Task/Policy/receipt/Execution DTO、IDs 和 strict schemas；不含 process 或路径实现；
- `packages/pi-harness`：薄 vNext Pi host、broker-backed tool binding、Session events 和 prompt appendix；
- `packages/godot-adapter`：可注入 process launcher、sandbox sidecar binding 和当前 Protocol v2 复用；
- `packages/json-artifacts`：新 `.chronorift/tasks/` namespace 与 append/seal adapters；
- `apps/cli`：Task lifecycle、workspace materializer、concrete bwrap broker、composition 与显示；
- `fixtures/godot-frame-input-window`：唯一 vNext Fixture；不迁移其 legacy oracle 到产品结果。

`domain ← adapters ← CLI` 与 `domain ← agent-protocol ← pi-harness/CLI bridge` 的方向保持不变。Sandbox
Broker 的 concrete implementation 首版留在 CLI；只有其依赖、生命周期和跨 consumer port 经测试稳定后，
才评估拆出 `execution-sandbox` 或 `worktree-manager` package。

## 15. 实施顺序与后续里程碑

本设计只规定依赖顺序，不替代后续 implementation plan：

1. Task/Policy/receipt schemas 与 preflight；
2. clean Git materialization、private workspace 和 patch extraction；
3. bwrap broker 与真实 security conformance；
4. broker-backed Pi tools、默认 resources 和可恢复 Session；
5. Godot sidecar、`game_run` 与 sandboxed Fixture execution；
6. Task CLI、records、show/continue/discard 和 cleanup；
7. 离线 Gate 与真实 GPT-5.6 Luna release acceptance。

该 walking skeleton 通过后，下一独立设计从无阶段 game tools 继续到 rolling capture、pin/trigger 和预算退化；
随后才设计具有诚实 manifest/fidelity 的 mid-run checkpoint 与 replay。

## 16. 主要风险与控制

| 风险                                     | 控制                                                                                  |
| ---------------------------------------- | ------------------------------------------------------------------------------------- |
| Host Git refs 暴露给 Agent               | staging worktree 只用于 Host 物化；sandbox 使用 private task Git metadata             |
| Pi builtin 绕过 broker                   | 同名 custom tools 覆盖并做 active-tool compatibility test；未知 builtin fail closed   |
| Godot 无法跨 network namespace 连接 Host | runtime sidecar 与 Godot 同 namespace 使用 local TCP；Host 只走 stdio RPC             |
| toolchain 或依赖泄露 Host home           | 只读精确 mount 与 env allowlist；缺失依赖 preflight failure                           |
| 任意 bash 的失败被错误解释为安全事件     | 保留原始 result 与 policy；只报告可验证 denial，不从 stderr 推断 syscall 原因         |
| 真实模型 Gate 波动或产生费用             | 与离线 Gate 分层，固定 model metadata，完整记录 provenance，不自动 fallback           |
| 新路径再次演化为 workflow                | 无 phase state、无固定顺序、无 submit tool、无 Proposal/Verdict；测试只断言效果与记录 |
| walking skeleton 被误称为 runtime moat   | 完成声明明确排除 rolling capture、checkpoint/fork、query 和 compare                   |
