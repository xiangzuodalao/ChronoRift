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
> 仓库还定义已冻结完成的实验性 **M4 external-project lifecycle-only slice**：Operator 提供本地 clean Git
> checkout 和 strict descriptor，Agent 只获得 capabilities/launch/status/stop 四项生命周期能力。冻结 product subject
> `f8ccb183eb7db21c1737b60a9f4970dce5ff17f0` 已在 run `31416348238` 通过 required Host Gate；归档证据绑定
> 固定 `moddable-platformer` checkout、candidate patch round-trip、Host source unchanged 与完整 cleanup。它只证明
> 该 lifecycle-only conformance，不证明真实 provider Agent 能修复游戏、支持任意项目或已经形成公开 release。
>
> 源码还包含实验性 **E2 external semantic slice**：它在 M4 source/sandbox 基础上增加独立 Task V4、独立
> semantic wire/Addon、data-only adapter profile，以及 Timer + spawned-entity 的 query/checkpoint/restore/fork/
> trace/replay/compare。所有状态操作都明确是 `descriptive_only`；public exposed task Gate 只验证 plumbing，
> 不证明智能诊断、等价恢复、修复正确性、独立验收或泛化。
>
> 实验性 **M5 public-exposed behavior-change conformance** 复用 M4 sandbox/lifecycle 与
> E2 semantic tools，让一次真实 Luna/max Agent turn 在固定 `enemy_spawner_broken` 上记录 baseline、修改实际
> `.gd` 游戏代码、运行不同 source identity 的 candidate、导出非空 round-trip patch，并保留最小原始 runtime
> evidence 与 cleanup receipt。该公开问题不能证明独立验收、修复正确性、可靠性、泛化或任意项目支持。
> 2026-08-12 的本地 `r8` 真实 Luna/max Gate 已通过，15-file sanitized bundle 与可恢复 product subject 保存在
> `docs/evidence/vnext-m5-public-exposed-local-r1/` 并经 standalone validator 复验；它是未受保护的本地 Operator
> archive，不替代 protected-ref workflow artifact，因此仓库状态仍是 **M5 implementation present + local Gate
> passed**，不是永久的 **M5 conformance passed**。
>
> 源码现还包含实验性 **M6 external hidden-fix local Gate**：固定第三方
> `moddable-platformer@3e793f53598a131c53fb82555191cc14b8db07ff`，在 Host-only assignment 中冻结 mutation、
> evaluator 与 pristine 上已 conformed 的 ProjectAdapter；一次真实 Pi Agent turn 结束后冻结唯一 patch，再由
> 3 类 × 3 次全新 workspace/cache/evaluator process 的本地隐藏 oracle 验收。正式入口已经接线；2026-08-15 的唯一
> 正式 Luna/max attempt 留下了 round-trip patch，candidate selected tree 精确等于 pristine，但公开 workflow 缺少合格的
> baseline/candidate runtime evidence，终态为 `workflow_rejected`，formal hidden evaluator 未启动（`0/9`）。失败证据保存在
> [`docs/evidence/vnext-m6-external-hidden-fix-local-r1/`](docs/evidence/vnext-m6-external-hidden-fix-local-r1/README.md)。
> terminal 冻结后，一次不重启 Agent、不写 formal evaluator records 的 `diagnostic_not_gate_acceptance` 对同一 patch
> 取得 3×3 fresh-copy `9/9` 与完整 cleanup；它只说明 patch 后来通过了 oracle，不能补回缺失的 Agent runtime workflow
> 或改写正式终态。
> 当前准确状态是 **M6 implementation present + one retained failed live attempt; local Gate not passed**，不是“修复能力
> 已通过”或通用项目支持。
>
> 源码还包含实验性 **M7 runtime-use paired ablation local Gate**：两臂获得相同的自然用户需求、mutated
> baseline、Provider/model/thinking/budget、coding surface 与 sandbox profile；唯一预期 treatment 是
> runtime-enabled 臂获得 mutation 选择前已冻结的通用 patrol runtime surface，code-only 臂不获得 game tools 或
> runtime access。2026-08-15 的唯一正式 R2 campaign 按 `runtime-enabled → cleanup → code-only` 执行并保留
> create-once claim/result/terminal，但终态是 **`infrastructure_failure / arm_infrastructure_failed`**。runtime-enabled
> 臂没有保留 runtime summary、baseline witness 或冻结 candidate，因此不能证明 Agent 看见或利用了 runtime 信息；反而
> code-only 臂在同一自然 prompt 下产生了 patch，并由正式 hidden evaluator 以 3 类 × 3 次 fresh-copy `9/9`
> accepted。因此这个 mutation/run **不支持 runtime-use 或相对 code-only 优势的目标 claim**。R2 的 `exit 0` 只表示
> wrapper 完成并持久化 terminal，不表示实验通过。sanitized evidence 见
> [`docs/evidence/vnext-m7-runtime-use-ablation-local-r2/`](docs/evidence/vnext-m7-runtime-use-ablation-local-r2/README.md)；
> R1 仅留下两次 pre-Agent failure、`agentLaunchCount=0`，没有被 R2 改写。
>
> 同日唯一正式 **R3** 两例 portfolio command 也没有进入 Agent：它在 shared no-Agent preflight 准备阶段以
> `failed_before_agent_in_shared_no_agent_preflight` 失败，留下 2 个 construction receipt 和 1 个 portfolio freeze，
> 但 preflight/case reference/campaign/arm records 均为 0；Agent/Pi/provider 计数均为 0。两次 compatibility-only
> Godot launch 已有 receipt，scoped preparation/unstarted-arm cleanup 已证明；shared no-Agent preflight 的 cleanup 与
> sandbox-security closure 未证明，且留下 4 个空的 `root:root` mode-`0755` mountpoint stub。R3 没有形成 runtime-use
> evidence、candidate 或 paired comparison，不能支持目标 claim，也不改变 R2 code-only formal 9/9 的反证。脱敏归档见
> [`docs/evidence/vnext-m7-runtime-use-ablation-local-r3/`](docs/evidence/vnext-m7-runtime-use-ablation-local-r3/README.md)。
>
> 唯一正式 **R4** command 的 `exit 0` 也只表示 workflow 完成：shared no-Agent preflight 为 `2/2 passed`，但两例随后都在
> `campaign_gate`、claim/Agent 前记为 `campaign_infrastructure_failure`；Agent/Pi/provider、arm claim/result、candidate、
> trajectory-use 与 candidate-evaluator evidence 均为 0。cleanup 均 proven、事后活动残留为 0，同时保留 4 个空的 `root:root`
> mode-`0755` mountpoint stub。静态 repair diff 把根因定位为 preparation 曾把 claim 的 paired-public-contract hash
> 错填为 arm-specific Task hash；retained failure 本身只保存 `Error` 类 hash，不能独立给出该归因。R4 没有形成 paired
> differential，不支持目标 claim，也不覆盖 R2/R3。脱敏归档见
> [`docs/evidence/vnext-m7-runtime-use-ablation-local-r4/`](docs/evidence/vnext-m7-runtime-use-ablation-local-r4/README.md)。
>
> 唯一正式 **R5** command 先通过 `2/2` formal no-Agent preflight，并让 case-01 正确持久化绑定 paired public
> contract 的 runtime claim；但 Pi wrapper 边界后没有可观察 Pi result/event/Agent turn/delivery 或持久 Session，原始
> 异常与 provider 是否实际调用不可恢复。`runner_result_invalid` 是 trace/sidecar matcher 的二次错配；真实 arm cleanup
> `eaba88bb…` 已 proven，但无效 envelope 让 Gate/terminal 错记 `cleanup_failed`，随后 residual safety-summary DTO 错配又
> 产生 `ZodError`。case-02 safety-stop、两例 code-only 均未启动，也没有 candidate、patch、post-Agent candidate evaluator
> 或 paired comparison。因此 R5 不支持目标 claim；`exit 0` 只表示 workflow 已终结并持久化。脱敏归档见
> [`docs/evidence/vnext-m7-runtime-use-ablation-local-r5/`](docs/evidence/vnext-m7-runtime-use-ablation-local-r5/README.md)。
> R5 之后的离线修复只收窄两处记录边界：failed attempt 可保留并由 envelope 严格绑定已持久化 trace，formal
> cleanup callback 复用既有 preparation→residual projector。对应全仓离线 Gate 已通过；没有运行新的 live，也不改写 R5。
> 唯一正式 **R6** command 已成功写入 create-once `formal.started`，因此该科学轮次已永久消费。此前的 freeze、
> admission、dry 与 `2/2` no-Agent preflight 均通过，但它们本身不是消费点；四个正式 arm 都在 Pi turn 边界保留
> `runner_threw / operation_threw`，没有可观察 Pi event、Agent turn、result、delivery 或持久
> Session；provider 是否实际调用不可从留存记录判定。两例 terminal 均为 `infrastructure_failure / arm_infrastructure_failed`，
> 四臂 cleanup 与两例 aggregate cleanup 均 proven，因此 R6 仍没有 candidate、paired differential 或 runtime-use 证据。
> 事后静态审计定位到 writable-state 边界：Pi 读取 auth/model store 时也需要同目录 lock，而 R6 把整个 `/pi-agent`
> 只读挂载；该归因来自实现审计，不是 formal failure record 内生的错误文本。
>
> **R7 infrastructure revision 已冻结，但首次 admission 在 Docker create 前因 frozen wrapper 的非法 bind-mount
> `,rw` 选项失败；dry、no-Agent、provider canary 与 formal live 均未启动。** 旧 Operator 当时没有重试该 revision，
> 其 frozen bytes 与失败事实仍保持不可变；但它没有 create-once `formal.started` 或正式实验 provider request，按当前
> 边界只是 pre-formal infrastructure attempt，并未消费科学意义上的 R7 round。它使用只含目标
> provider/model 的私有可写 credential projection（Host 凭据仍只读且不进入 Task/Godot），并增加 atomic one-shot lease/
> result 与 crash repair、冻结 workspace、真实 Pi lifecycle/failure receipt、prepare acquisition owner、pre-Pi storage headroom
> receipt、按 arm 的 evaluator cgroup+tmpfs、R7 outer/R4 inner 双 manifest，以及 create-once
> admission→dry→no-Agent→provider-canary attestation chain。每阶段的 command-result、原始 work tree
> 与 strict terminal 都持久保留并在后继阶段重读；published freeze 损坏时只 fail-closed，不由 repair 删除。
> 源码已移除该 mount 选项，但不会改写 R7 的历史 revision。这是基础设施结果，
> 不是新的实验结果，也不追认 R3–R6。
>
> 目标 lifecycle 把 **scientific round** 与 **immutable infrastructure revision** 分离。freeze 只发布不可覆盖的 build
> artifact，不消费 round；qualification、admission、dry、no-Agent 与 provider canary 都是 pre-formal infrastructure
> evidence。只有成功以 `O_EXCL` 创建 `formal.started`，或首个承载实验内容的正式 provider request 开始（二者取先），
> 才永久消费 round；provider canary 是非实验 readiness probe，不在这个边界内。消费后无论成功、失败、崩溃、超时或
> 网络错误都不得 retry/reroll。消费前的基础设施失败必须原样追加保留；修复只能发布新的、完整重做 qualification 的
> infrastructure revision，并保持 case、prompt、seed、provider/model、evaluator、budget 等实验设计绑定逐字节不变。
> 当前 Operator 已实现独立于 revision state 的 round authority：legacy flat revision 只读 adoption，successor
> reservation/seal append-only，唯一 consumption marker 位于 round scope。已有 R7/R8 state 本身仍不是重试授权；只有
> authority 中 sealed、unconsumed 的 head revision 才可运行。
>
> 后续 round 不应承担集成测试职责。仓库现在提供不占用 round namespace 的 formal-exact rehearsal：每次从当前
> 源码生成 disposable freeze，并复用正式 Docker 参数、mount、entrypoint、目标 provider/model 的私有 credential
> projection、Pi bootstrap、cgroup、四份 source clone 与 formal-evidence writer，但任务固定为 `modelInvocations=0`。
> 2026-08-16 已完成两次连续正常演练，以及 half-write、credential-lock、storage-exhaustion、TERM、SIGKILL 五种
> 故障演练；全部通过且无容器、凭据 tmpfs、cgroup、进程或 Host-state 残留。它只证明当前基础设施链可重复，
> 不是实验结果。事后审计确认这份 qualification 覆盖共享 inner R7 operator，却没有真实重走冻结后的薄 round wrapper
> 与复制 descriptor；因此不能把它单独当作下一 revision 的完整 freeze prerequisite。每个 revision 的 freeze bytes 仍不可
> 修改；若 pre-formal 修复导致新 revision，必须重新完成包含 frozen thin-wrapper re-entry 的 qualification。
> 正常演练必须通过真实、无凭据的 bridge DNS/TLS probe；TERM/SIGKILL 专项在相同 storage、Pi-bootstrap、containment
> 之后隔离该外部探针，避免第三方 TLS 波动掩盖 owner/evidence recovery 的故障结论。
> 八步固定资格序列会把 strict raw evidence 持久保存在非 round readiness store，并要求最后两步是连续 normal；
> future freeze 必须绑定同一 workspace aggregate 与 Docker-layout digest 的资格记录。
>
> **R8 infrastructure revision 1 已冻结，但首次 admission 在薄 wrapper 校验冻结 workspace descriptor 时失败：snapshot
> 将该副本保存为 mode `0644`，identity reader 要求 `0600`。** 失败发生在任何 admission-stage lease、Docker create、Pi/
> Agent、provider request 与 `formal.started` 之前；revision 1 保持不可变，没有产生实验结果，也没有消费科学 R8 round。
> revision-rollover authority 与 frozen thin-wrapper qualification binding 现已实现并有离线测试。revision 2 随后以相同
> scientific subject 完成 freeze/seal，但没有运行 admission、dry、no-Agent、canary 或 formal；它保持 sealed-but-unused，
> 也不是实验结果。当前源码又收窄了 authority atomic publication 与 Docker created-only recovery，并把 qualification
> 升级为八步 outer-wrapper lifecycle；这些新 bytes 必须取得新的 matching qualification 并发布 successor revision，不能
> 回写或继续使用 revision 2。
>
> **Project Environment V1 / PE-A Preview 已达到 implementation present + local Gate passed；当前下一实现切片是
> PE-B Dynamic Projection（planned，尚未实现）**。PE-A 在 Godot 4.7
> GDScript 项目目录启动 ChronoRift，由同一个可见 Pi Session 生成、验证并发布唯一 ProjectAdapter，然后直接进入
> 用户工作。Harness 只提供 bridge、协议、Adapter SDK、sandbox、loader、validator 和 publication broker；项目
> entity/state/event/capture 与可选 snapshot/restore 语义由 Agent 生成。源码现在包含显式 `project preview` 路由、
> SDK/wire/loader、Task/project store、三阶段 conformance、publication/binding、跨命令 publication crash reconciliation、同 Session goal turn、post-edit exact
> Build、new-Session reuse、durable runtime evidence、snapshot characterization、独立 evidence validator、官方 Pi TUI
> 和 Task-bound runtime tools。本地默认离线 Gate 与真实 Godot 4.7.1 bridge/SDK/observation/snapshot 测试已通过；
> 下层 Linux sandbox/Godot Host conformance，以及 deterministic fake-Pi 驱动的完整 Preview（初始化、publication、
> 同 Session goal 与新 Session reuse）已在本地隔离容器实际通过。2026-08-13 的本地真实
> `openai-codex/gpt-5.6-luna/max` Gate 也在冻结 product subject
> `5d98857a0c5423d050615b93d6fa0dfd6f109a5b` 上通过；create-new bundle content hash 为
> `ad53d152a05017c21f9ee64580fcba96bbe99febab0ec00b33ec6a0c7c7e2f2f`，并由 standalone validator 复验和
> [local r1 archive](docs/evidence/vnext-project-environment-pe-a-local-r1/README.md) 冻结。该 archive 不是
> protected-ref artifact、签名或外部 attestation，也只覆盖一个冻结 clean/single-root fixture；因此仍不能描述成
> 已经支持通用外部项目或默认入口。
>
> **E3.1 Campaign Denominator Conformance 当前暂停在 implementation-only。** event、registrar port/client、
> projector、独立 validator 与显式 live 入口已经存在，但没有真实独立 registrar/trust root 的归档 live evidence；
> 它不是当前产品主线，也不能被描述成 hidden acceptance 已建立。

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
用户在包含 project.godot 的目录启动 ChronoRift，可同时提供目标
→ ChronoRift 自动发现项目、冻结 source closure，并创建 managed workspace 与 sandbox
→ 使用 Pi SDK 创建或恢复一个可见 AgentSession
→ 首次进入时，Agent 在独立初始化 turn 中读取项目并生成唯一 ProjectAdapter
→ 初始化 turn 正常返回后，Harness 冻结并验证 candidate，在 revision 完整落盘后原子切换 current pointer
→ 在同一 Session 的下一 turn 处理已排队目标
→ Pi Agent Loop 自主调查、修改和验证
→ 模型输出普通最终结果，当前 turn 结束
→ ChronoRift 展示 diff、实际工具记录、Execution lineage 和资源/安全记录
→ 回收游戏进程与临时授权，保留 Session、workspace 和 artifacts
```

Agent 的 `cwd` 目标为任务 sandbox 内的 `/workspace`，来自受管的临时代码视图，而不是用户正在编辑的
checkout。coding tools 和 Godot 进程运行在无特权容器或等价 Linux namespace 中；网络、宿主文件、
凭据、设备和显示代理默认关闭，越界动作在执行前拒绝并形成结构化安全事件。模型侧 Pi Host 可以使用用户
自己的 Pi credential store，但工具和游戏进程不能继承这些凭据。

这个流程已有显式、实验性的 Preview 入口；它不是默认产品命令：

```text
pnpm project preview -- [GOAL] --provider PROVIDER --model MODEL [--thinking LEVEL --host-config PATH]
```

每次 Preview 都先检查 project-local、path-free publication recovery authority，并只通过已验证 Host runtime root
按 opaque Task ID 派生原 Task store。若发现上次命令中断在 revision/current/receipt/binding 之间，本次命令只做
幂等 reconciliation 后非零返回，不恢复旧 Pi Session，也不投递旧 queued goal；即使恢复成功也需用户再次显式运行
Preview 才开始新工作。Authority 或 pointer transaction 若只留下完全空或严格可识别的内部 stage 残留，reopen 会
保留到独立 quarantine 后继续；含未知 bytes、链接或名字的目录仍 fail closed。

它仅接受 clean、repository-root、单 `project.godot`、单默认 launch target 的 Godot 4.7.1 GDScript 项目，要求
Linux sandbox 与严格 Host toolchain registry 配置；交互终端会进入官方 Pi TUI，`--json` 则只输出结果。当前可执行
vNext 入口还包括后文列出的实验性 `pnpm task -- start/continue/show/export/discard`；默认 `chronorift [goal]` 只有
全部 Preview 和晋升 Gate 通过后才能对外发布。

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

### 下一产品切片：Project Environment V1 / PE-B Dynamic Projection

Project Environment V1 不再为每个外部项目新增 lifecycle/semantic product profile。目标模型是：

- 一个 `project.godot` 对应一个 project-local environment；
- 常规入口自动冻结 dirty Git source closure 与 realized project descriptor；
- 同一个可见 Pi Session 首次生成唯一的 manifest + GDScript ProjectAdapter；
- Adapter 通过只读 managed overlay 注入，和游戏 source/probe 分别记录 identity；
- Harness 固定 game tools 和 versioned capability modules，Agent 定义项目 entity/state/event/capture 语义；
- Ready 至少要求可启动、可观察、可捕获；input、snapshot/restore、alignment 和 render 可明确 unsupported；
- candidate 只有在初始化 turn 正常返回、并通过 vanilla/bridge-only/instrumented smoke、严格 schema、runtime 和
  cleanup conformance 后，才能由 Host broker完整落盘为 local-only `.chronorift/` revision，再原子切换 current pointer；
- 后续 Task pin 已验证 revision；源码变化由 Agent 增量审阅，普通 candidate Build 使用 compatibility receipt；
- 游戏 patch 通过显式 review/apply 回到 Host，adapter publication 不混入游戏 patch。

首版范围是 Linux + Godot 4.7 官方 GDScript runtime。C#、GDExtension、native plugin、audio 和其他 Host 平台不
在范围内。完整契约、数据模型、状态机、信任边界和 Gate 见
[Project Environment V1 RFC](docs/project-environment-v1.md)。当前源码已有 PE-A 的 DTO、SDK、loader、wire、
bounded stores、初始化协调、三阶段 conformance、publication/binding、broker-only 跨命令 publication reconciliation、post-edit exact Build compatibility、new-Session
reuse、durable runtime evidence、snapshot characterization、独立 validator、显式 CLI、官方 Pi TUI 与 Task-bound core
runtime tools。精确 baseline product tree 已取得 create-new real-Pi bundle 并由 standalone validator 复验，状态是
`implementation present + local Gate passed`；该 local archive 不是 protected-ref conformance 或默认入口晋升。

初始化 workspace 中的 minimal package 只是结构参考；权威 validator 要求 candidate 至少声明一个非
`scene-root` placeholder 的项目 entity type 和一个非 `project` placeholder 的状态域。原样复制模板、只改
README 或只增加未引用文件都不能发布为 ready revision。

首个实现进一步收窄为 **PE-A / Author → Validate → Publish → Use**：clean、single-root、单默认 launch target、
headless/no-network 项目，证明同一 Pi Session 能初始化 adapter、在下一 turn 处理目标，对候选 Build 运行 quick
compatibility smoke，并由新 Session 复用。PE-A 同时用一个冻结 characterization adapter 做 snapshot/restore
read-back，只证明 optional contract 可执行，不把 snapshot 设为外部项目 Ready 要求。Dirty/multi-source、通用 failed-attempt/Session resume、
source/adapter migration、并发 publication、Host refresh/apply、bundle和网络模板都是后续独立切片。

当前实现会在 game tool 首次使用和 source 变化后重新冻结 workspace diff，为**精确 candidate Build**执行 compatibility
smoke，并只让后续 runtime 使用该 Build；新 Task/Session 对 unchanged source 会重验已发布 bytes 和 quick smoke 后复用，
不会伪造本 Task publication。冻结 characterization fixture 也已完成 snapshot → mutation → restore → read-back。
下层 Linux sandbox/Godot Host conformance 与 deterministic fake-Pi 完整 Preview Host integration 已在本地隔离容器
实际通过。2026-08-13 的精确 baseline Luna/max Gate 完成双 Session、published receipt、raw pinned capture、Task
ledger/inventory 与 physical seal：初始化 Agent turn 为 348.638 秒，含 authoritative conformance/publication 的
attempt ready 为 363.322 秒，完整 case 为 505.21 秒。证据见
[local r1 archive](docs/evidence/vnext-project-environment-pe-a-local-r1/README.md)。仍未完成的是 protected-ref 长期证据
artifact、更多结构类别，以及 PE-B 的动态节点、自定义 Signal 与状态变化投影。Dirty/untracked、
materialized dependency、addon/import 和 multi-target source closure 属于后续 PE-C，不混入 PE-B。

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

### 实验性 M4 external-project lifecycle-only 入口（冻结完成）

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

M4 冻结范围还包括一次真实 Provider Agent handoff：Agent 留下候选修改，Harness 完成非空 patch
export/round-trip，并在 discard 后保留 cleanup receipt。M4 没有要求 Agent 复现公开 gameplay 行为或运行修改后
candidate，所以该 handoff 不能写成 Bug 已修复；这正是 M5 新增的单一行为闭环。

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

post-Gate r1 freeze 将通过 Host Gate 的产品 subject 固定为
`f8ccb183eb7db21c1737b60a9f4970dce5ff17f0`，并在
`docs/evidence/vnext-e2-public-exposed-r1/` 保存 Operator 从 run `31416348238` artifact 下载、并在归档时与下载
副本逐字节核对的两份 sanitized inner bytes。仓库可重算内层文件 hash，但离线 validator 无法重建即将过期的
ZIP，也不能独立证明 ZIP 到这两份 inner bytes 的来源链路。
首次发布的 `vnext-e2-public-exposed-conformance-r1-freeze` tag 保持不可变；其 tag CI 因
`actions/checkout` 将本地 annotated-tag ref 覆盖为 commit ref 而 fail-closed。后继
`vnext-e2-public-exposed-conformance-r2-freeze` 只修复 checkout 后的 tag-object 恢复与验证，不改变 product
subject、归档 evidence、evaluator 状态或能力主张。
`moddable-platformer.e2-evaluation-contract.v1.json` 另冻结 runtime、Agent 与 evaluator 预算、只允许 infrastructure
failure 对同一 candidate 在零场景、零 oracle、零 Execution 进度且 cleanup-proven 后重试一次的规则，以及不向
产品 Task 写 verdict 的 strict V1 evaluator artifact/ledger interface。validator 要求唯一 Agent 终态（包括 provider
失败、超时和无候选）进入单 assignment ledger，结果完整覆盖冻结的有序 scenario plan，并对所引用的 build、
runtime、raw event ledger 与 physical seal 原始文件重算身份和 hash chain；candidate 还必须从 baseline 用 exact
binary/full-index patch round-trip 到目标 selected tree。assignment/evaluation ID 来自同一份 canonical assignment
basis，scenario ID 来自 evaluator bundle 中 definition 的原始 bytes，消息自身 hash 则排除自己的 content-hash
字段；这些是确定性 identity/checksum 算法，不是签名。ledger 还必须带一个绑定冻结 commit/tree/interface 清单的
product-subject checkout receipt；`invalid_candidate` 只有在保留并绑定 candidate admission rejection receipt 时才
成立，不能由结果字段自行宣称。

1 GiB/131072 inode 是 Agent、evaluator、runtime 和 evaluation artifact 共用的单 Task aggregate 上限，不是每个
阶段各一份额度。Pi Agent auto retry 是 Loop Engine 每个 retry cycle 最多 2 次、全 Agent attempt 观测总数最多
8 次的 eligibility 计数；provider SDK 每个 model call 的配置上限是 0，两者也都不同于 evaluator 对同一 candidate
的一次 infrastructure retry。usage、cleanup、product-subject 与 invalid-candidate receipt 仍由未来 Host/evaluator
产生并保留；validator 只能验证内容、绑定和相互一致性，不能独立证明 receipt 来源或测量真实性。工具、retry 和
storage 观测上限是 evaluator 的事后 eligibility，产品 subject 只强制已有的 timeout、sandbox、storage 与 runtime
profile 上限。
holdout 仍未选择，外部 evaluator 实现也不存在；E2 V1 里跨 assignment create-only denominator store 的
`not_implemented` 字段保持冻结字节和当时语义。这个 V1 只描述一个确定性 single-assignment bundle，不能证明
没有另一份 assignment 被替换，也不是独立 preregistration、签名、acceptance、完整 denominator、成功率或泛化
证据。后续 E3.1 使用独立 namespace 实现 campaign registrar conformance，不修改或重解释该 E2 artifact。

### 实验性 M5 public-exposed behavior-change conformance

M5 只增加“真实外部项目行为修改闭环”这一条不确定性轴。它复用 M4 的外部 source、隔离
workspace、sandbox、lifecycle、patch 与 cleanup，也复用 E2 的 `godot-external-semantic-v1` profile、11-tool
catalog 和 Timer/spawn 投影；不新增 Task profile、Godot wire、semantic adapter、固定调查流程或产品 verdict。
冻结分类是 `public_exposed_behavior_change_conformance`。

首个任务继续固定 `moddable-platformer` checkout 和公开的 `enemy_spawner_broken`。一次
`openai-codex/gpt-5.6-luna/max` Agent attempt 只允许一个 turn、最多 900 秒，并必须在该 turn 内：

- 产生一次 baseline-source execution，投影保持不超过 0.01 s 的 Timer，且某个采样端点呈现 spawn；
- 修改 tracked `.gd` 游戏代码，再产生一次不同 source identity 的 candidate execution，投影约 1 s Timer、
  ready/记录到的 0.25 s 内端点不呈现 spawn，且至少 0.9 s 后的某个后续端点呈现 spawn；
- 导出非空 full-index/binary patch，至少包含一个 tracked `.gd` 文件，并从冻结 baseline 精确 round-trip 到
  final candidate selected tree；
- 保留引用所需 build/runtime/execution envelopes、raw event ledgers、physical seals、patch/export receipt 与
  path-free cleanup receipt，证明 Host checkout 未变化且 discard 后 Task process/cgroup/storage 均为空。

M5 evidence 先写 create-new staging bundle，再由不导入产品 TypeScript 的独立 validator 重算 patch/tree、resource
identity、raw hash chain、seal、baseline/candidate 观测、引用闭包和 cleanup binding；validator 还拒绝 symlink、
额外文件、孤儿资源与覆盖写。只有验证和 cleanup 都成功才原子发布 sanitized success bundle。bundle 不保留 Pi
session、prompt、assistant prose、Host path、provider request 或 credential。M5 外层 orchestrator 不在 Agent turn 后补调
semantic game tool；若 turn 结束时仍有 active runtime，沿用的 Task turn cleanup 负责停止并封口，因此 Gate 验证的是
baseline/candidate 的持久化效果，而不是一条固定的 `game_stop` 调用序列。

```bash
corepack pnpm test:vnext:external-behavior-live
```

这是需要显式 Provider/network/Host 授权的非默认 Gate，不属于 `corepack pnpm check`。`M5 implementation
present` 只表示入口、严格 schema、behavior/patch/staging/cleanup 与独立 validator 的离线覆盖已经接线；只有该真实 Gate 取得成功输出并另行
归档、逐字节复验后，才能写 `M5 conformance passed`。2026-08-12 的本地 `r8` 已取得一次真实成功输出，原始
15-file bundle、freeze record 与可恢复 product subject 保存在
[`docs/evidence/vnext-m5-public-exposed-local-r1/`](docs/evidence/vnext-m5-public-exposed-local-r1/README.md)，并由
standalone validator 逐字节复验；因为它不是 protected-ref workflow artifact，只能写 **local Gate passed**，不能
升级为永久的 `M5 conformance passed`。该输出支持的最强结论只是在这个固定公开任务的一次真实
Luna/max turn 中，Agent 先在 unchanged source 观察到短 Timer 与 spawn-present 投影，留下实际 `.gd` 修改，并让
final-source Godot execution 满足冻结的一秒 Timer 与 spawn-absence/presence 端点契约。它不证明精确 spawn 时刻、
根因、一般逻辑 correctness、独立 acceptance、可靠性、成功率、泛化、相对产品优势或任意项目支持。

仓库内的手动 workflow 只接受 protected ref，并绑定 checkout 到 `github.sha`；Operator 还必须在仓库外为
`vnext-m5-live` environment 配置 deployment branch/tag rule 与 required reviewers，并只在授权窗口开放专用
self-hosted runner。仓库侧检查不能替代这些外部控制。

### 实验性 M6 external hidden-fix local Gate

M6 只回答一个窄问题：在固定的真实第三方 Godot 项目和一次预登记的隐藏 mutation 上，ChronoRift 能否让一个
真实 Agent 自主调查公开症状、修改代码、重跑，并让冻结 patch 在干净副本中通过 Agent 看不到的本地 evaluator。
它不引入云服务、签名、独立账号或外部 trust root。

assignment 在 Agent 启动前 create-once 冻结：固定 commit、mutated selected-tree、公开 task/model/budget、pristine
ProjectAdapterRevision 及其 conformance receipt、mutation hash、evaluator implementation/bundle hash。身份链明确是
`pristine AdapterRevision → exact Build compatibility → mutant/candidate Build(source:<selected-tree hash>)`；运行时协议
内部需要的 Adapter-overlay namespace 不作为 mutant EnvironmentRevision。Agent 只获得冻结 Adapter 声明且 Host
admitted 的 game tools，数量不写死。

正式 Gate 只有一个 assignment、一个 Agent attempt、一个 user turn 和一个 candidate，不 retry、不 reroll。公开
workflow checker 只读普通 Task/runtime 与 Host 工具边界证据，要求 baseline Execution 在 Host 首次观察到 source
identity 改变前完成，并要求 candidate rerun、patch round-trip、lineage 与 cleanup；它不声称看见单次 coding/bash
调用内部的“修改 → 运行 → 改回”。task-specific public classifier 的 identity 和 implementation hash 属于公开 task，
它只负责标记公开症状，不参与最终 acceptance。

workflow 通过后，evaluator request 只携带 `assignmentId + frozen patch ref + expected candidate tree`。evaluator 自己从
Host-only store 取得 mutated baseline；正式入口只允许 bubblewrap oracle，它看不到 Agent Task/runtime records、
ProjectAdapter、mutation diff 或 Host credentials。固定计划是 `public_reproduction`、`hidden_variant`、
`regression_control` 各 3 次；每次只创建新的 evaluator workspace/import cache/process，绝不再次启动 Agent，且
candidate 必须 9/9。workflow、request、receipt 与 terminal 均绑定同一 patch/tree；终态严格只有
`accepted | no_candidate | agent_failed | workflow_rejected | evaluator_rejected | infrastructure_failed | cleanup_failed`。

```bash
corepack pnpm test:vnext:external-hidden-fix-live
```

这是显式、非默认、fail-closed 的真实 Provider/Godot Gate。它要求 Operator 提供四类仓库外输入：pristine/mutated
clean checkout；公开 task root/spec/classifier；Host-only Adapter revision/conformance/package、mutation 与 evaluator
bytes；以及 private assignment/patch/evaluator-temp roots 和 Project Environment Host config。具体环境变量名以
`moddable-platformer.m6.live.test.ts` 中的 `CHRONORIFT_TEST_M6_*` 为准。失败记录不会换 mutation 重跑；create-once
store 也拒绝第二次 Agent/evaluator/terminal。2026-08-15 已对冻结 assignment 执行唯一一次正式 live：Agent 留下的
476-byte GDScript patch 通过 round-trip，candidate selected tree 等于 pristine；但 workflow 的合格 baseline、candidate
rerun、execution lineage 与 execution-level cleanup 检查未形成完整闭包，终态为 `workflow_rejected`。因此 formal
evaluator 没有启动，fresh-copy 结果是 `0/9`，不能写 local Gate passed；失败记录见
[`docs/evidence/vnext-m6-external-hidden-fix-local-r1/`](docs/evidence/vnext-m6-external-hidden-fix-local-r1/README.md)。同一
assignment 不会重启 Agent 或换 mutation 重跑。正式 terminal 之后，Operator 另用同一 frozen patch 和 evaluator 做了
一次明确标为 `diagnostic_not_gate_acceptance` 的 3×3 检查：不重启 Agent、不创建 formal evaluator request/result，9 个
全新 workspace/cache/process 均 PASS 且 cleanup 成立。这是“patch 本身后来通过 oracle”的旁证，不是正式 Gate 的
evaluator `9/9`，也不能补回 Agent turn 中缺失的 runtime workflow。未来若用新的预登记 assignment 取得单次正式 9/9，
它也只证明该 assignment 的本地 conformance，不证明成功率、可靠性、泛化、任意项目支持、第三方独立验收或防
ChronoRift 作者篡改；content hash 不是签名。

### 实验性 M7 runtime-use paired ablation local Gate

M7 把问题收窄到一项 treatment：在相同的真实第三方 Godot mutation 和自然用户需求下，runtime-enabled Agent 是否
实际看见并使用 ChronoRift runtime 信息，而 code-only Agent 是否难以仅靠源码完成同一修复。两臂不收到“必须先复现”
或“修改后必须验证”之类不对称提示。通用 patrol sensor contract、ProjectAdapter 与 freeze record 在 mutation 选择前
冻结；mutation 和 hidden evaluator 保持 Host-only，不能被 Agent 的 read/find/bash 访问。

正式 campaign 在任何 Agent 启动前绑定 sensor、mutation、18-run preflight、公共 task 与 paired attempt。两臂共享
mutated baseline、自然 prompt、Provider/model/thinking、单 turn budget、coding tools 与 sandbox profile；runtime-enabled
臂额外获得冻结 ProjectAdapter 声明并验证通过的 game tools，code-only 臂没有 managed runtime、game tools 或 runtime
resources。顺序固定为 `runtime-enabled → cleanup barrier → code-only`；每臂 claim 都在对应 Agent 前 create-once
持久化，失败不换 mutation、不重试 Agent。候选 patch 分臂冻结，最终 acceptance 由 Host-only baseline 与固定
bubblewrap evaluator 在 fresh copy 中执行 `public_reproduction | hidden_variant | regression_control` 各 3 次。

```bash
corepack pnpm test:vnext:runtime-use-ablation-live
```

这是显式、非默认、需要仓库外冻结输入和 Host model 授权的 live 入口。2026-08-15 的唯一正式 R2 campaign 没有完成
有效 paired comparison：runtime-enabled 臂以 `paired_attempt_unavailable` 结束，保留零 runtime summary、零 baseline
fall witness、没有可验证的 source-change evidence，也没有冻结 candidate；cleanup 成立。code-only 臂明确记录
`runtimeAccessEnabled=false`，却在
相同自然 prompt 下产生 1,519-byte round-trip patch
`728f68f8b4e0c3bec94e4cd974618aa1c5b2d676d42165cb264bfcc4f3998be5`。正式 hidden evaluator 对该 candidate 的
3×3 九个独立 fresh workspace/cache/process 全部 PASS，结果为 `accepted`，evaluator 与 arm cleanup 均成立。

campaign terminal 因 runtime-enabled 基础设施失败而是
`infrastructure_failure / arm_infrastructure_failed`。这次运行支持“code-only patch 修复了冻结 hidden bug”这一窄结论，
但不支持“runtime Agent 看见/利用了 runtime 信息”，也不支持 runtime treatment 相对 code-only 的优势；这个 mutation
没有形成预期区分度。wrapper 的 `exit 0` 只表示正式 failure 被完整 terminalize。R2 的 byte-exact records、sanitized
summary、freeze record 和 SHA-256 清单保存在
[`docs/evidence/vnext-m7-runtime-use-ablation-local-r2/`](docs/evidence/vnext-m7-runtime-use-ablation-local-r2/README.md)。
R1 的 initial/recovery 两次 invocation 都在 Agent 与 campaign 前失败，`agentLaunchCount=0`；其四个 run-control
record 保持原字节，没有被 R2 重写。该 archive 是本地未受保护的 Operator evidence，不是签名、外部 attestation 或
对一般 Agent 能力的证明。

R3 把 design 扩为两个预先冻结的 case，但 2026-08-15 的唯一正式 R3 command 在任何 Agent 前即失败。它完成并保留
2 个 construction receipt、1 个 portfolio freeze 和 2 次 compatibility-only Godot receipt；shared no-Agent preflight
准备随后失败，故 preflight receipt、case reference、campaign terminal、arm claim/result、runtime-use evidence、patch
和 evaluator evidence 均为 0，Agent/Pi/provider 计数也均为 0。pre-Agent operational/topology seal 只对各自观测时点
作证；其后的零计数是由失败位置和 retained filesystem inventory 支持的较窄 Operator projection，不是连续 lifecycle
attestation。no-Agent public launch 的精确次数未知，只能保留 `0..2`；hidden evaluator process 则可收窄为 0，因为
两个 preflight evaluator-temp 目录为空且 mtime 早于 formal command，而 evaluator 路径必须先创建 fresh temp directory。

两例 preparation cleanup summary 与四个 unstarted-arm cleanup receipt 都把 scoped cleanup 记为 proven；这不能补成
shared no-Agent preflight 的 cleanup 或 sandbox-security closure。事后仍有 4 个空的 `root:root` mode-`0755`
mountpoint stub，所以整体 cleanup/security 保持 unknown，而不是擅自写成通过或违规。R3 没有启动任何一臂，也没有
形成 paired comparison，因而同样不支持 runtime-use/advantage claim；R2 code-only formal evaluator 9/9 的反证仍须并列
保留。R3 的 path-free sanitized projection、freeze record 与 SHA-256 清单在
[`docs/evidence/vnext-m7-runtime-use-ablation-local-r3/`](docs/evidence/vnext-m7-runtime-use-ablation-local-r3/README.md)。

formal terminal 之后，一次不启动 Agent/Pi/provider、也不调用 hidden evaluator 的 disposable public-observation diagnostic
复现了 `patrol_motion_timeline_unavailable`：`game_query` 与随后 zero-window pin 消费相邻 transport batch，旧 validator 却要求
至少两个相同 `recordSequence`。现在 trajectory 只使用 Agent 实际可见的 query rows；pinned batch 继续独立接受 schema、
lineage、content seal 与 cleanup 校验。focused 回归与真实 pristine/mutant public observation 均越过该 blocker，并在 synthetic
hidden boundary 停止；这项事后诊断不改写 R3 formal failure，也不授权重跑它。

随后一次独立、完整的 no-Agent smoke 使用固定 5 秒/6-query 公共观察窗，并修正了 observation ACK 的 credit：每消费
1 个 batch 只补 1 个 credit，避免积压批次在 pin 后放大并撞上 256 KiB queue bound。四次 public runtime 的
coverage/loss/cleanup 均成立，Agent/Pi/provider 仍为 0；case-02 的 public `grounded_stall` 与 9/0/0/3 hidden matrix
通过。case-01 的 hidden matrix 也为 9/0/0/3，但 public pristine/mutant 都只有 `direction_recovery` 与
`sustained_grounded_motion`，没有冻结 case spec 要求的 `ground_contact_loss`/`grounded_speed_deviation`，所以它被判为
`preflight_failed`。这说明 case-01 不适合作为下一次 runtime-use case；不能事后收紧通用 classifier 来制造区分度。

case-01 随后被一个新案例替换：自然 prompt 只描述巡逻敌人不能维持配置速度，hidden mutation 把每 tick 的水平速度赋值改成
随 `delta` 累加；它不改 Adapter、classifier、关卡、ray 或 wall 行为。替换材料通过了同一套完整 disposable no-Agent
preflight：mutant public observation 在固定 5 秒窗口内产生预先声明的 `grounded_speed_deviation`，pristine 没有该
witness；fresh hidden matrix 为 pristine 9/9、mutant public+hidden 0/6、mutant regression 3/3。case-02 同轮继续通过，
36/36 hidden runs 都是 fresh workspace/cache/process 且 cleanup proven，四次 public observation 都 complete、loss-free、
security event count 为 0；Agent/Pi/provider 为 0，formal Gate 未调用。这只证明替换案例具备进入下一轮的构造条件，不是
新的 formal paired-Agent 结果，也不改写 R2/R3 结论。

该 portfolio 的唯一 R4 formal command 后来完成 `2/2` no-Agent preflight，却在两例 `campaign_gate` 中都于 claim/Agent
前保留 infrastructure failure；两臂均无 result/candidate/trajectory/candidate-evaluator evidence，所以 `exit 0` 只是 workflow
完成，不是实验 verdict。pre-fix preparation 把 claim 所需的 paired public contract hash 错映射成 arm-specific Task
hash；这个精确归因来自静态 repair diff，retained record 只含 `Error` 类 hash。cleanup proven、活动残留为 0，另有 4 个
空 root-owned mode-0755 stub。R4 归档见
[`docs/evidence/vnext-m7-runtime-use-ablation-local-r4/`](docs/evidence/vnext-m7-runtime-use-ablation-local-r4/README.md)；R2
code-only 9/9 与 R3 pre-Agent failure 仍须并列保留。

### 实验性 E3.1 Campaign Denominator Conformance

E3.1 把“已分配但被遗漏的运行”收进一个独立的 campaign lifecycle，不增加新的产品 verdict。当前状态是
**E3.1 implementation present**：源码已实现严格 event/schema、窄 `registrar-port`、验证 TLS/签名/proof 的
`registrar-client`、由原始事件重建的 projector、独立 artifact validator 和显式 live conformance 入口；离线
故障测试使用 fake registrar，仓库没有本地 registrar server 或 denominator store。六类事件为
`registrar_assignment_registered`、
`conformance_actor_started`、`conformance_actor_finished`、`conformance_cleanup_proven`、
`registrar_deadline_elapsed` 与 `registrar_primary_closed`；registrar-owned event 不能由被测 actor 自报。
projector 只产生 `conformance_complete`、`incomplete_unknown` 或 `cleanup_unproven` lifecycle 终态，不推断
Agent、候选或场景失败的原因。

primary journal/head/outcome/计数与截止时间在 closure 时永久封存；deadline 后证据只能进入以 `closureHash` 为根、
不改写 primary outcome 或指标的 revision chain。签名 closure 同时保留 `appendAttemptCount`、
`rejectionCount` 与 `idempotentReplayCount`；独立 closure-key 签名的 revision checkpoint 再绑定 latest-known
revision head/count/as-of，删掉晚到证据会使验证失败。独立 validator 不导入产品 TypeScript：它严格检查 UTF-8/JSON、
字段与预算，重算 identity、event/head/closure/revision hash，检查 ACL、ordinal/previous-hash chain、Ed25519 role
signatures，并验证 campaign-registration leaf 的 RFC 6962 inclusion proof、closure leaf 的 inclusion proof，以及
registration checkpoint 到 closure checkpoint 的 consistency proof。这些机制验证给定证据的绑定；没有真实外部
registrar 的运行输出时，不能据此声称原子提交、可信 deadline、cleanup 测量或 transparency publication 已发生。
early-complete 的 response-loss wrapper 只观察 inner transport 首次真实返回 `unavailable` 和 client 随后的完整
transport request bytes 相同；它不丢弃成功响应或自行制造故障，并要求已验签 closure 的
`idempotentReplayCount=1` 与该观测一致。
client 也能验证 registrar clock/closure 双签名的 public pending-status feed，但该 feed 只提供可观察的发布状态，
绝不替代 closure transparency inclusion/consistency proof。

untrusted registration proposal 还携带
`artifactSinkMode=configured_external_ci_artifact_directory_v1`、`artifactSinkId` 与内容寻址的
`artifactSinkCommitment`。preflight 会先把空的仓库外 evidence 目录解析为 canonical absolute path，再以
namespace、lease ID、sink ID、该路径和固定 evidence 文件名重算 commitment；不一致时在 campaign 登记前
fail closed。opaque create-only registration capability 只允许外部 registrar 接受其预授权的精确 manifest；
成功后由签名 registration receipt 和 transparency proof 绑定包含 sink commitment 的 campaign ID。manifest 与
sanitized summary 只保留 mode、ID 和 commitment，不公开 Host 路径。这个机制只证明 runner 使用了 registrar
接受的 configured sink binding；它不是 Host attestation，也不证明目录位于独立 mount、CI operator 无法控制该
目录或 artifact storage 具有物理独立性。receipt key 不签 proposal，也没有扩张其 append-receipt ACL。

```bash
corepack pnpm test:vnext:e3-campaign-live
```

这是必须显式配置的非默认 live registrar conformance，不属于 `corepack pnpm check`。正式脚本只调用固定路径且由
sealed config 绑定 SHA-256 的独立 Host launcher；launcher 打开 FD 3–15 后直接启动仓库内单进程 Node CLI，不让
descriptor 经过 package lifecycle 或 Vitest worker。缺少该独立 Host 部署时命令会 fail closed。runner 只接受固定路径
`testdata/vnext/e3/registrar-trust-root.v1.json` 和
`testdata/vnext/e3/registrar-trust-root.v1.freeze.json`；CI 只能选择该 root 预授权的 service ID/namespace，不能注入
trust-root bytes、CA、hostname、SPKI 或角色 key。当前两个固定文件尚未由独立评估方发布，contract 对应状态为
`trustRootStatus=unselected`、`trustRootFreezeStatus=absent`、`externalTrustRootPinStatus=unselected`、
`liveMatrixStatus=full_matrix_v1`、`independentRegistrarStatus=not_configured` 与
`archivedEvidenceStatus=absent`，所以缺少前提时 fail closed；当前 live 命令也会在登记 campaign 前拒绝把
仓库侧编排冒充已经由外部 Host fault controller 完成的故障矩阵。`full_matrix_v1` 只表示三 campaign、两类故障和
四类篡改的 runner 编排已接通，不表示任何外部依赖已配置或 Gate 已通过。V1 freeze record 仅接受
`predecessor=null` 的初始
threshold root；轮换尚未实现，必须由后续新 policy/schema 验证旧、新 threshold root 交叉签名及生效区间，并且
只能作用于固定新 trust-root version 的新 campaign，不能重解释旧 evidence。
发布 root 的 release 还必须把其文件 SHA-256 固定为不可由 CI/env/argv 覆盖的 external pin；freeze record、固定
root bytes 与该 pin 三者不一致时 runner 和独立 validator 都 fail closed。

仓库侧已有三 campaign 正向编排：先保留 early closure、server-side `incomplete_unknown`、
`cleanup_unproven` 与 late-cleanup revision，再对同一 pending suite bytes 分别进行 journal、signature、
inclusion 与 consistency 最小篡改；独立 validator 必须逐一拒绝后才允许无覆盖发布最终文件。正向编排之前还
要求 FD 15 上的外部 fault controller 返回 registrar-unreachable 与 log-unavailable 子进程非零退出、无 final
evidence、无 success summary 的 receipt。receipt 由 threshold-root 预授权且与 registrar/actor keys 分离的
Ed25519 fault key 签名，并通过签名 `requestId` 绑定本次 canonical request、evidence sink 与文件名，禁止跨运行
replay。严格有界的双工协议与完整 matrix runner 已实现；固定 fault-control policy、独立 Host controller 部署、
该命令对独立 trust-root registrar 的成功输出和冻结 artifact 仍不存在。因此当前只能写
**E3.1 implementation present**，不能写
**E3.1 live registrar conformance passed**。该 synthetic
campaign 固定
`claimEligible=false`、`modelCalls=0`、`evaluatorRuns=0`，不启动真实 Agent，不生成或选择候选，也不执行 hidden
scenario；它明确排除 model-call gating、oracle blindness、candidate production、hidden evaluation、independent
acceptance、success rate、reliability、generalization、root-cause correctness 与 relative product advantage 等
claim。

E3.1 live 阶段已延期，不是当前下一切片；恢复时才需要独立 registrar/trust root 和归档 conformance evidence。
E3.2 才计划增加 model capability broker、`IsolationClosureReceipt`、泄漏 canary 与 Host attestation。
**E3.3 holdout evaluator not implemented；independent acceptance not established。**

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

| 命令                                                                                            | 当前作用                                                                                                      |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `corepack pnpm check`                                                                           | lint、格式、strict typecheck 和离线测试                                                                       |
| `corepack pnpm test:godot`                                                                      | legacy Godot 集成与 M3 Fixture checkpoint characterization                                                    |
| `corepack pnpm test:sandbox`                                                                    | 真实 Host coding sandbox conformance；需要 delegated cgroup                                                   |
| `corepack pnpm test:vnext:godot-sandbox`                                                        | M3 Godot + sidecar + sandbox 联合 conformance                                                                 |
| `corepack pnpm test:vnext:external-project`                                                     | M4 冻结外部项目 lifecycle-only Host conformance                                                               |
| `corepack pnpm test:vnext:external-semantic`                                                    | E2 Timer/spawn 11-tool public-exposed Host conformance                                                        |
| `corepack pnpm test:vnext:external-behavior-live`                                               | M5 真实 Luna/max 的公开行为修改闭环；显式、非默认                                                             |
| `corepack pnpm test:vnext:external-hidden-fix-live`                                             | M6 单次 Agent + 本地隐藏 3×3 Gate；formal workflow rejected；事后 patch diagnostic 9/9，不是 acceptance       |
| `corepack pnpm test:vnext:runtime-use-ablation-live`                                            | M7 runtime/code-only paired Gate；R2 infrastructure failure，code-only formal 9/9，目标 claim 不成立          |
| `corepack pnpm test:vnext:runtime-use-ablation-r3-live`                                         | M7 两例 R3 Gate；唯一 formal command 在 shared no-Agent preflight、Agent 前失败，未形成 paired comparison     |
| `corepack pnpm test:vnext:runtime-use-ablation-r4-static`                                       | M7 R4 Operator shell 的离线静态检查                                                                           |
| `corepack pnpm test:vnext:runtime-use-ablation-r4-live`                                         | M7 两例 R4 一次性 formal entry；唯一 command 已保留两例 pre-Agent campaign infrastructure failure             |
| `corepack pnpm test:vnext:runtime-use-ablation-r5-static`                                       | M7 R5 独立 one-shot Operator shell、outer manifest 与 run-control 的离线静态检查                              |
| `corepack pnpm test:vnext:runtime-use-ablation-r5-live`                                         | M7 两例 R5 一次性 formal entry；仅在 freeze、admission、dry 与 no-Agent preflight 分别通过后执行              |
| `corepack pnpm test:vnext:runtime-use-ablation-r6-static`                                       | M7 R6 独立 Operator、修复后 source binding 与 run-control 的离线静态检查；不创建 Host state                   |
| `corepack pnpm test:vnext:runtime-use-ablation-r6-live`                                         | M7 两例 R6 一次性 formal entry；唯一 command 已保留四臂 Pi-boundary infrastructure failure                    |
| `corepack pnpm test:vnext:runtime-use-ablation-r7-static`                                       | M7 R7 freezer、dual manifest、atomic operator、credential/workspace 与阶段链的离线检查                        |
| `corepack pnpm test:vnext:runtime-use-ablation-r7-live`                                         | 历史 R7 live wrapper；admission 在 Docker 前失败并保留，未触发 scientific-round consumption                   |
| `corepack pnpm test:vnext:runtime-use-ablation-r8-static`                                       | R8 descriptor、freezer、dual manifest、thin wrapper 与 Operator 的离线静态检查                                |
| `corepack pnpm adopt:vnext:runtime-use-ablation-r8`                                             | 只读导入 legacy flat revision 1 到独立 round authority；不修改旧 state，也不消费 round                        |
| `corepack pnpm prepare:vnext:runtime-use-ablation-r8`                                           | 在 unconsumed authority 下 create-once 预留 successor physical root；保持 scientific subject 不变             |
| `CHRONORIFT_M7_INFRASTRUCTURE_REVISION_ID=… corepack pnpm freeze:vnext:runtime-use-ablation-r8` | 将匹配 qualification 的 prepared successor 原子 freeze、验证并 seal；不覆盖 revision 1                        |
| `corepack pnpm inspect:vnext:runtime-use-ablation-r8`                                           | 严格重读 revision/consumption authority；不运行 Docker、Pi、Agent 或 provider                                 |
| `corepack pnpm test:vnext:runtime-use-ablation-r8-live`                                         | R8 sealed successor entry；revision 1 的 pre-formal failure 保留且永不作为执行入口                            |
| `corepack pnpm rehearse:vnext:runtime-use-formal-exact -- 2`                                    | 不占 round 的 Docker/Pi-bootstrap/cgroup/evidence 无模型连续演练；旧资格未覆盖 frozen thin wrapper            |
| `corepack pnpm qualify:vnext:runtime-use-formal-exact`                                          | 八步 durable readiness qualification；每次均从 frozen thin wrapper 进入共享 outer lifecycle并绑定 raw receipt |
| `corepack pnpm fault:vnext:runtime-use-formal-exact -- <fault>`                                 | 半写、凭据锁、存储耗尽、TERM 或 SIGKILL 的 disposable 故障演练                                                |
| `corepack pnpm test:vnext:e3-campaign-live`                                                     | E3.1 外部 registrar live conformance；显式、非默认、尚无证据                                                  |
| `corepack pnpm test:vnext:pi-live`                                                              | 真实 Luna/max 的 vNext Pi Session/tool smoke；非 release Gate                                                 |
| `corepack pnpm test:vnext:live`                                                                 | release-only Luna/max + 外部 13 场景 acceptance；非默认 CI                                                    |
| `corepack pnpm demo:v04`                                                                        | v0.4 固定 workflow 的离线完整诊断                                                                             |
| `corepack pnpm diagnose:v04`                                                                    | v0.4 固定 workflow 的真实 provider 诊断                                                                       |
| `corepack pnpm demo:v03` / `diagnose:v03`                                                       | v0.3 兼容路径                                                                                                 |
| `corepack pnpm fixtures`                                                                        | 列出当前 Fixture                                                                                              |
| `corepack pnpm godot:install` / `godot:doctor`                                                  | 安装或检查 Godot                                                                                              |
| `corepack pnpm pi` / `models`                                                                   | 启动固定版本 Pi CLI 或查询模型目录                                                                            |
| `corepack pnpm benchmark`                                                                       | deterministic fake-model smoke；不代表产品优势                                                                |
| `corepack pnpm benchmark:verify` / `benchmark:gate`                                             | 重验历史报告完整性或冻结 Gate                                                                                 |
| `corepack pnpm test:live`                                                                       | v0.1 Mock switch-door 真实 provider smoke；不属于默认 Gate                                                    |

Formal benchmark 的冻结命令、退出码、恢复规则和证据 identity 不再复制到产品入口；见
[r4 reproduction](docs/benchmarks/v0.3.2-luna-r4/reproduction.md)。

## Artifact、历史与安全边界

当前 v0.4 单次运行写入 `.chronorift/v0.4/runs/<run-id>/`；v0.3 兼容路径写入
`.chronorift/v0.3/runs/<run-id>/`。`.chronorift/` 是本地运行状态，不得提交 Git。

Project Environment V1 的 PE-A Preview 已在独立 local-only namespace 中保存 immutable environment/adapter revisions，
且不修改根 `.gitignore` 或 Git metadata；Task Session、candidate 和 runtime artifact 留在仓库外 bounded storage。
该 namespace 不替代或重解释现有 v0.3/v0.4 store；dirty/multi-source、retention 与后续 publication 语义仍按 RFC
中的后续窄切片推进。

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

- Project Environment V1 的 PE-A Preview 已有显式项目目录初始化、Agent-generated ProjectAdapter、环境
  revision/CAS publication、通用 entity/state/event/capture SDK、交互 Session、post-edit exact Build、new-Session reuse、
  snapshot characterization 与 durable runtime evidence，并已有一个冻结 clean/single-root fixture 的 local-only
  real-Pi r1 archive；尚无 protected-ref artifact、PE-B dynamic projection、PE-C source/import closure 或 Host
  refresh/apply。`chronorift [goal]`
  仍不是当前可执行入口。
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
- M5 只在同一个公开 `enemy_spawner_broken` 上要求真实 Agent 留下 baseline/candidate 行为观测和非空 `.gd`
  patch。文件名、注释与 FIXME 已暴露问题，行为变化也不等于独立验收或 correctness；单次 attempt 不能外推
  成可靠性、成功率、泛化、任意项目支持或相对产品优势。spawn 是在 semantic tool response 时采样，而非连续
  记录其发生瞬间；baseline/candidate 的 spawn-present observation 都只证明采样时已经 spawn，不能推出精确
  first-spawn latency。
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
不声称另起 CLI 进程或单独证明 CLI argv parsing。冻结 subject 的实际通过输出已归档在
`docs/evidence/vnext-e2-public-exposed-r1/`；本文列出命令本身不证明其他 checkout 或任意外部项目也会通过。
clock/probe 当前只保留 lifecycle endpoint samples，并明确记录中间位置
未采样及 observer effect 未知；健康运行不能被描述成逐帧完整观测。
E2 evidence 另固定标注 `public_exposed_plumbing_conformance` 和排除的五类 claim；该 evidence 同样不是签名、
外部 attestation、修复验收或跨项目能力证明。

M5 live Gate 复用同一 frozen checkout、descriptor、semantic Addon/profile、精确 toolchain、delegated cgroup 和
fresh bounded storage，但改用一次真实 Luna/max Agent turn，并要求不同 source identity 的 baseline/candidate
sealed executions、非空 `.gd` patch、独立验证的最小 runtime bundle 和最终 cleanup：

```bash
corepack pnpm test:vnext:external-behavior-live
```

该命令必须显式授权 Host model path 使用 Provider network/credential；Task coding/Godot sandbox 仍保持禁网且
不继承凭据。失败、超时、没有合格 candidate、行为观测不完整、patch round-trip 失败或 cleanup 未证明时均不得
发布 success bundle。2026-08-12 的本地 `r8` 已运行通过并发布一份经独立复验的 local Operator archive；它证明
该次本地 Gate，而不证明 protected workflow 已通过。取得并冻结 protected-ref artifact 前仍只能声明
`M5 implementation present + local Gate passed`，不能声明永久的 `M5 conformance passed`。

Godot、checkpoint、replay、schema、canonicalization、branching 或 storage 变更还应运行相应成功、失败、
corruption、reference-integrity 和 determinism/nondeterminism 覆盖；需要本机 Godot 的改动再运行
`corepack pnpm test:godot`。legacy provider smoke 使用 `corepack pnpm test:live`；M3 release-only live 路径
使用 `corepack pnpm test:vnext:live`，两者都必须显式运行。

- [Target Architecture](docs/architecture.md)：vNext 产品契约、边界和迁移计划；
- [Godot Protocol v2](docs/godot-protocol-v2.md)：当前 runtime wire contract；
- [r4 benchmark evidence](docs/benchmarks/v0.3.2-luna-r4/README.md)：冻结历史报告与复现协议；
- [v0.3.2 portfolio](docs/portfolio-v0.3.2.md)：旧垂直切片的事实摘要。
