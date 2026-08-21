# ChronoRift 工程设计导览

这份导览面向希望快速审阅 Agent Runtime / Harness / Environment 工程能力的读者。它不复述完整 RFC，而是解释当前
代码里最重要的设计取舍、可以核对的实现入口，以及没有被包装成“已解决”的问题。

## 问题定义

普通 coding agent 可以读写文件、运行命令，但游戏调试还需要回答一组运行时问题：这次 observation 属于哪个 Build
和 Execution？请求的帧率或输入是否真的实现？采样覆盖是否完整？运行时是否丢过事件？candidate 与 baseline 是否来自
可比较的起点？工具是否越过了用户授权的项目和 Host 边界？

ChronoRift 的目标不是替 Agent 编写固定诊断脚本，而是提供一个 **Agent 可以自由使用、Host 可以严格约束、reviewer
可以事后核查** 的运行环境。当前实现包含 legacy v0.4、实验性 Project Environment Preview、固定项目 GN-1，以及若干
兼容/历史路径；[目标架构](architecture.md) 中的完整 runtime primitive 集合并非都已进入当前产品路径。

## 五个关键设计决定

### 1. Pi 拥有 Loop，ChronoRift 拥有 Harness

ChronoRift 直接使用固定版本的 Pi SDK 创建 `AgentSession`，保留 Pi 对模型调用、消息历史、tool scheduling、compaction
和普通终止的所有权。Harness 只增加受控 coding/game tools 与一段简短环境说明，不把 Loop 改写成固定调查顺序。

这条边界带来两个结果：

- Agent 可以根据源码和观察自行决定先读码、运行、编辑还是验证；
- Harness 只对真实执行事实负责，不从 Agent prose 推导 canonical diagnosis 或 fix verdict。

`completed` 因此只表示 turn 结束并留下 assistant output、候选 diff 和执行记录。它不等于项目已经接受候选。

### 2. `cwd` 不是 sandbox，Git worktree 也不是权限边界

Pi 的 workspace 指向 `/workspace`，但真正的隔离由 Host broker 建立。当前 Linux Host 路径在显式 provision 后使用
bubblewrap namespace、delegated cgroup、bounded Task storage、冻结的 executable identity 和 read-only runtime/source
mount；网络、Host 路径、凭据、端口、设备、display、audio 和 GPU 默认拒绝。

请求的 policy 只有通过 Host preflight、资源绑定和 operation-time revalidation 后才是 realized fact。结构化 security
event、cleanup receipt 和实际 process output 比“sandbox 已开启”的配置声明更可信。v0.4 Host process 没有这一 OS
隔离保证，不能把 vNext 边界反向写到 legacy 路径上。

### 3. 工具输入、能力与资源归属都在边界处验证

Agent 看到的 game tools 来自显式 `ToolDefinition` metadata 和精确 input schema。Harness 会验证：

- tool name 是否属于当前暴露 surface；
- input/output 是否符合严格、版本化 schema；
- capability module 是 `implemented`、`degraded` 还是不可用；
- `taskId`、Build、Execution、checkpoint 等引用是否真实存在且属于同一 Task；
- budget、并发、runtime lifecycle 和 cleanup 是否允许当前操作。

不支持的能力、resource mismatch、history gap 或 runtime crash 返回结构化结果；不会通过猜测资源、吞掉缺口或伪造
成功来维持流程。

### 4. 记录 observation，不制造结论

runtime receipt 区分 requested 与 realized control，也保留 clock、quantization、coverage、loss、overwrite、observer effect
和 nondeterminism。raw events 是事实来源，Runtime State Index 只是可重建查询视图；compare 可以报告 observable
difference 和 confounder，但不能宣布因果关系。

同一原则延伸到 candidate：source identity、diff bytes、Build、Execution、tool call 和 cleanup 通过 lineage 连接。Hash
用于绑定 bytes 和检测损坏，不是签名或外部 attestation。最终 acceptance 属于用户、项目 CI、独立 Eval 或人工 review。

### 5. 用窄 vertical slice 消除一个主要不确定性

项目没有把每次实验升级成 campaign manager 或 evidence pipeline。GN-1 只问一个窄问题：在一个真实第三方 Godot
项目中，Agent 是否实际使用了与 launch Execution 绑定的 semantic runtime observation，并留下可与 coding-only arm
比较的候选记录。

两个 arm 固定 source、prompt、model/thinking、timeout 和共享工具；treatment 只增加四个 game tools 及其现有 metadata。
公开的 [GN-1 案例](case-studies/gn1-platform-alias.md) 同时保留正向 observation、control 的非通过结果和 retrospective
选择偏差。一个 pair 不被写成成功率、通用优势或修复证明。

## 五个代码入口

如果只审阅五个文件，建议按以下顺序：

1. [`packages/pi-harness/src/vnext-session.ts`](../packages/pi-harness/src/vnext-session.ts)

   Pi 集成的最窄入口。这里创建/恢复 `AgentSession`，选择 environment appendix，绑定明确的 model/thinking/tools，
   并把 session status、实际工具面、assistant text、events 和 stats 返回给调用方。可以直接看到“保留正常 Pi Loop”和
   “完成不证明修复”的边界。

2. [`packages/pi-harness/src/project-environment-game-tools.ts`](../packages/pi-harness/src/project-environment-game-tools.ts)

   SDK-neutral game-tool contract 到 Pi `ToolDefinition` 的桥。它按 capability 选择工具、严格检查 input/output、维持
   `toolCallId` 绑定、执行 budget admission，并把 unsupported/budget/runtime failure 保留为结构化结果。

3. [`apps/cli/src/vnext/sandbox-broker.ts`](../apps/cli/src/vnext/sandbox-broker.ts)

   Host 隔离边界的实现核心：校验 sandbox capability/policy 与 immutable binding，建立 bubblewrap/cgroup execution，
   管理 bounded scratch、duplex process、resource cleanup 和 security events。这个文件也直观展示了当前 Host 编排
   复杂度偏高的技术债。

4. [`packages/godot-adapter/src/project-adapter-package.ts`](../packages/godot-adapter/src/project-adapter-package.ts)

   把 Agent 生成的 ProjectAdapter 当作不可信 package 检查：限制文件/目录/总字节数，拒绝逃逸路径和 native binary，
   校验 manifest/schema/GDScript，并在验证后保留 defensive copies，避免运行时重新打开已变化的 candidate。

5. [`apps/cli/src/vnext/platform-alias-demo.ts`](../apps/cli/src/vnext/platform-alias-demo.ts)

   GN-1 的端到端 composition：冻结精确外部 source，建立 private Task workspace，选择 matched tool surface，运行正常
   Pi turn，生成 candidate Build，执行 Host-only postflight，并记录 diff、runtime lineage、cleanup 和 checkout
   cleanliness。它是固定项目 characterization 路径，不是可扩展 campaign framework。

依赖方向保持为 `domain ← gamebranch ← adapters ← CLI`；Agent-facing 路径是
`domain ← agent-protocol ← pi-harness/CLI bridge`。engine-neutral package 不导入 Pi 或 Godot-native 类型，包间调用通过
各自 `src/index.ts` 的 public exports。

## 如何读 GN-1，而不是只看结果表

建议按证据强度从高到低审阅：

1. 精确 source commit/tree、共同 prompt 和 matched tool surface；
2. 两个 candidate patch 的原始 bytes；
3. baseline/candidate observation 与 Build/Execution/tool-call lineage；
4. standalone evaluator 的配置匹配、cleanup、checkout cleanliness 和 case oracle；
5. Agent 的最终说明。

关键 observation 是不同宽度 Platform 实例的 `CollisionShape2D.shape` resource identity 和 realized collision width。
在 treatment baseline 中，四个 area 共享一个 shape identity，width 都为 768 px；candidate 在 resize 前 duplicate resource
后，area width 与 128/256/384/768 px 的 solid width 对齐且 identity 分离。coding-only candidate 则留下四个 682 px 的
area 和共享 identity。

这个差异只描述该项目、revision、prompt 和 pair 的 observable outcome。公开材料不包含完整 raw arm results，因此不能
独立重跑 evaluator，也不应从中推导“game tools 普遍更好”。

## 当前工程债与下一层问题

- **CLI 入口仍分裂。** v0.4 legacy、`project preview` 和 GN-1 各有显式入口，目标中的 `chronorift [goal]` 尚不存在。
- **编排文件过大。** sandbox broker、Godot runtime coordinator 和 task-environment composition 聚集了较多 lifecycle
  分支；在增加新产品行为前，应按真实 ownership/lifecycle seam 缩小，而不是提前创建空 package。
- **ProjectAdapter 尚不通用。** Preview 的 author/publish/reuse 仍是实验能力；GN-1 使用 checked-in 项目特定 V1
  adapter，不能外推到任意 Godot 项目。
- **平台范围窄。** 当前受支持 Host 是 Linux，runtime 是官方 Godot 4.7.1 GDScript；C#、native extension、macOS、
  Windows、visual/audio/GPU 都未覆盖。
- **runtime fidelity 有边界。** 自动 capture trigger、完整 engine snapshot、bit-exact replay 和第三方 telemetry
  attestation 未实现；missing state 或 first divergence 不能被静默解释为相等。
- **协作与交付仍待产品化。** 通用 source migration、multi-writer lease/CAS、conflict-safe apply、失败 Task resume、
  retention 和 adapter bundle import/export 仍是后续问题。

这些缺口是产品路线输入，不是让当前窄 slice 宣称更多能力的理由。架构 §20/§21 是 rollout 和当前映射的权威来源。

## 验证入口

| 层级                | 命令                                          | 回答的问题                                                                 |
| ------------------- | --------------------------------------------- | -------------------------------------------------------------------------- |
| 默认离线 Gate       | `corepack pnpm check`                         | lint、format、strict typecheck 和 deterministic tests 是否通过             |
| Godot integration   | `corepack pnpm test:godot`                    | Addon、protocol、Project Environment 与 Godot integration 是否通过         |
| Coding sandbox Host | `corepack pnpm test:sandbox`                  | provisioned namespace/cgroup boundary 是否满足 conformance                 |
| Godot sandbox Host  | `corepack pnpm test:vnext:godot-sandbox`      | bounded storage、sidecar、managed runtime 与 sandbox 是否共同满足 Gate     |
| Live Pi             | `corepack pnpm test:live` 或显式 live command | 在有意提供 provider/network/credential 时，真实 Session 路径留下了什么记录 |

Host suites 缺少 delegated cgroup、bounded Task storage 或固定 executable 时属于 precondition failure。默认 tests 使用
fake，不接触 provider；只有 `*.live.test.ts` 和显式 live 命令可以联网。

进一步阅读：

- [README](../README.md)：当前公开入口、命令和限制。
- [目标架构](architecture.md)：产品契约、信任边界、rollout 和 package ownership。
- [Project Environment V1 RFC](project-environment-v1.md)：完整状态机和 DTO/wire contract。
- [开发与验证指南](development.md)：可执行的 Host provisioning 与 conformance 前置条件。
- [GN-1 案例](case-studies/gn1-platform-alias.md)：固定 pair 的公开材料和局限。
