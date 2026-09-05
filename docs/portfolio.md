# ChronoRift 工程设计导览

这份导览面向希望快速审阅 Agent Runtime / Harness / Environment 工程能力的读者。它不复述完整 RFC，而是解释当前
代码里最重要的设计取舍、可以核对的实现入口，以及没有被包装成“已解决”的问题。

## 问题定义

普通 coding agent 可以读写文件、运行命令，但游戏调试还需要回答一组运行时问题：这次 observation 属于哪个 Build
和 Execution？请求的帧率或输入是否真的实现？采样覆盖是否完整？运行时是否丢过事件？candidate 与 baseline 是否来自
可比较的起点？工具是否越过了用户授权的项目和 Host 边界？

ChronoRift 的目标不是替 Agent 编写固定诊断脚本，而是提供一个 **Agent 可以自由使用、Host 可以严格约束、reviewer
可以事后核查** 的运行环境。当前实现包含 legacy v0.4、无需 Adapter 的实验性对象检查 Preview 和固定项目案例。旧
Task CLI 与 M3/M4/E2 实现已从 current HEAD 删除，只能从历史 tag/归档复现；[目标架构](architecture.md) 中的完整
runtime primitive 集合并非当前功能清单。

## 五个关键设计决定

### 1. Pi 拥有 Loop，ChronoRift 拥有 Harness

ChronoRift 直接使用固定版本的 Pi SDK 创建 `AgentSession`，保留 Pi 对模型调用、消息历史、tool scheduling、compaction
和普通终止的所有权。Harness 只增加受控 coding/game tools 与一段简短环境说明，不把 Loop 改写成固定调查顺序。

这条边界带来两个结果：

- Agent 可以根据源码和观察自行决定先读码、运行、编辑还是验证；
- Harness 只对真实执行事实负责，不从 Agent prose 推导 canonical diagnosis 或 fix verdict。

`completed` 因此只表示 turn 结束并留下 assistant output、候选 diff 和执行记录。它不等于项目已经接受候选。

### 2. coding 可写，Godot 验证源码只读

当前 vNext Host 只保留一层薄封装：Linux x86_64 上精确固定
`@anthropic-ai/sandbox-runtime@0.0.74`。Agent 的 coding command 在私有物理 candidate workspace 中拥有读写权限，
否则无法修 bug。Godot 验证不直接运行该可写树：Host 递归复制普通文件、拒绝 symlink/特殊文件和路径逃逸，叠加受管
overlay 后，把 stage 项目源码只读交给 SRT；只有 `.godot/`、home、tmp 和 artifacts 可写，并在运行前后比较 source
SHA-256。两种模式都使用 strict empty network allowlist，Pi 凭据不进入 command environment。

这次 cutover 退役了自研 sandbox broker、cgroup/storage ledger、Host-config schema 和复杂 receipt framework。当前边界适合
单人作品项目，但不宣称 CPU/memory/PID/容量 quota 或外部 attestation。v0.4 Host process 也没有这一 SRT 隔离保证。

### 3. 工具输入、能力与资源归属都在边界处验证

Agent 看到的 game tools 来自显式 `ToolDefinition` metadata 和精确 input schema。当前维护路径会验证：

- tool name 是否属于当前暴露 surface；
- input/output 是否符合严格、版本化 schema；
- project-relative path 是否越界、指向 symlink/特殊文件或占用受管 overlay；
- `taskId`、Build 和 Execution 等当前 operation 使用的引用是否真实且属于同一运行；
- timeout、cancellation、输出上限和 runtime lifecycle 是否允许当前操作。

不支持的能力、resource mismatch 或 runtime crash 返回明确结果；不会通过猜测资源、吞掉缺口或伪造成功来维持流程。

### 4. 记录 observation，不制造结论

当前 SRT process result 保留 exit/timeout/cancellation、stdout/stderr 截断和 duration；Godot runner 另外返回 stage
source 的启动前与完成后 SHA-256 以及 `sourceUnchanged`。Preview 的对象查询与固定案例的 Adapter observation
分别记录运行时实际报告的内容，不能
宣布因果关系或修复正确。

同一原则延伸到 candidate：实际 diff、process output 和 runtime observation 高于 Agent prose。Hash 用于绑定 bytes 和
检测变化，不是签名或外部 attestation。最终 acceptance 属于用户、项目 CI、独立 Eval 或人工 review；当前实现不为此
新建 receipt/index/compare framework。

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

2. [`packages/pi-harness/src/inspection-game-tools.ts`](../packages/pi-harness/src/inspection-game-tools.ts)

   将 canonical inspection schema 派生的 metadata 绑定为三个 Pi tools：launch、query、stop。它严格检查
   input/output 与 Execution 归属、执行 budget admission，并保留显式错误；不引入项目 Adapter 或固定调查流程。

3. [`apps/cli/src/vnext/srt-sandbox-controller.ts`](../apps/cli/src/vnext/srt-sandbox-controller.ts)

   Host 隔离边界的薄适配：把明确的 argv、空白环境、读写目录、timeout/cancellation 和输出上限交给 SRT。coding
   workspace 可写；Godot source stage 只读并拒绝 mutable candidate。相邻的
   [`godot-validation-stage.ts`](../apps/cli/src/vnext/godot-validation-stage.ts) 负责安全复制、managed overlay 和运行前后
   source hash，而不是重新实现 namespace/cgroup sandbox。

4. [`apps/cli/src/vnext/godot-inspection-runtime.ts`](../apps/cli/src/vnext/godot-inspection-runtime.ts)

   新 Preview 的运行时边界：从当前 candidate 创建独立 stage、启动正常主场景、查询公共 observer 暴露的对象与属性，
   并在停止、超时或失败时保存实际记录。Object/Resource 引用保留执行内身份，产品没有硬编码项目节点或 Bug 字段。

5. [`apps/cli/src/vnext/platform-alias-demo.ts`](../apps/cli/src/vnext/platform-alias-demo.ts)

   GN-1 的端到端 composition：冻结精确外部 source，建立 private candidate workspace，选择 matched tool surface，
   运行正常 Pi turn，生成 candidate Build，执行 Host-staged postflight，并记录 diff、process/runtime result 和 checkout
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
- **部分案例编排仍偏大。** 旧 sandbox broker、Task CLI 与 M3/M4/E2 coordinators 已删除；Preview、GN-1 和 Mob V2
  composition 仍聚集较多 lifecycle 分支，应只在真实 ownership seam 出现时继续拆分。
- **通用检查不等于理解任意项目。** Preview 已移除 author/publish/reuse，通过 Godot 原生对象与属性检查工作；有意义的
  路径、字段仍需 Agent 调查。GN-1/Mob 保留 checked-in 项目 Adapter，其案例结果不能外推到新 Preview 或任意项目。
- **平台范围窄。** 当前受支持 Host 是 Linux，runtime 是官方 Godot 4.7.1 GDScript；C#、native extension、macOS、
  Windows、visual/audio/GPU 都未覆盖。
- **时间调查尚未实现。** Preview 只能读取存活执行的当前状态；没有 probe、采集窗口或历史回看，查询不是原子快照且
  getter 可能有副作用。也没有完整 engine snapshot、bit-exact replay 或第三方 telemetry attestation。
- **协作与交付不在当前范围。** 通用 source migration、多人并发编辑、自动 apply/merge 和长期 retention 都不是这个
  单人作品项目的已承诺路线。

这些缺口是产品路线输入，不是让当前窄 slice 宣称更多能力的理由。架构 §20/§21 是 rollout 和当前映射的权威来源。

## 外部项目上的一次实际复用

[City Builder 案例](case-studies/city-builder-preview.md)使用未参与接口设计的第三方项目，ChronoRift 产品源码、
工具和协议均未增加专属逻辑。案例脚本复用 Preview 的现有依赖入口，两组共享模型、目标、预算和沙箱，
coding-only 仅去掉三个游戏工具及其说明。两组首次产出的 patch 相同，独立检查均为 66/66。

这次运行中，Agent 先从源码定位并修改，再用已有查询检查候选：同一执行相隔 1120 个 process frames 的两个采样
返回同一预览对象。完整空闲重建计数和切换行为由会话外检查器验证，不能归给当前只读 query。
案例也保留了 Agent 最终退出码描述与实际 SIGTERM 记录不一致的纠正，说明为什么执行事实应高于最终文字。

它支持“现有工具可以在这个外部项目上复用”的结论，没有显示修复结果优势，也没有测量整体性能或跨项目成功率。
[简历要点与三分钟讲稿](case-studies/city-builder-preview/interview.md)按这些实际边界组织。

## 验证入口

| 层级                 | 命令                                          | 回答的问题                                                                 |
| -------------------- | --------------------------------------------- | -------------------------------------------------------------------------- |
| 默认离线 Gate        | `corepack pnpm check`                         | lint、format、strict typecheck 和 deterministic tests 是否通过             |
| Godot integration    | `corepack pnpm test:godot`                    | Addon、protocol、Project Environment 与 Godot integration 是否通过         |
| SRT Host integration | `corepack pnpm test:sandbox`                  | coding RW、Godot staged RO、禁网和真实 Preview integration 是否成立        |
| Live Pi              | `corepack pnpm test:live` 或显式 live command | 在有意提供 provider/network/credential 时，真实 Session 路径留下了什么记录 |

Host suite 通过 `.github/scripts/run-srt-sandbox-conformance.sh` 运行；非 Linux x86_64、SRT 不是精确 `0.0.74`、缺少
Bubblewrap/`socat`/ripgrep/Godot 或 user namespace 不可用都属于 precondition failure。默认 tests 使用 fake，不接触
provider；只有 `*.live.test.ts` 和显式 live 命令可以联系 provider，sandboxed commands 仍默认禁网。

进一步阅读：

- [README](../README.md)：当前公开入口、命令和限制。
- [目标架构](architecture.md)：产品契约、信任边界、rollout 和 package ownership。
- [Project Environment V1 RFC](project-environment-v1.md)：已被新 Preview 替代的历史接入、状态机和 DTO/wire 设计。
- [开发与验证指南](development.md)：可执行的 Host provisioning 与 conformance 前置条件。
- [GN-1 案例](case-studies/gn1-platform-alias.md)：固定 pair 的公开材料和局限。
