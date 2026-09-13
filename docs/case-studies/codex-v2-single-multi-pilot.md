**Codex V2 设计适配后的 Godot 四路实验，2026-09-13**

V2 协作实现已落地，四次调查都结束，四个最终补丁各通过两次独立验收。
但本轮 **不构成有效的同配置 Single / Multi 对照**：实验脚本只提供默认配置，Root 显式把六个 worker 的
thinking 从要求的 `max` 改成了 `high`；GN-1 还在一次启动失败后创建替代身份，累计四个 worker 身份。
这些原始结果全部保留，没有补跑来替换。它们可用于检查协作流程，不能用于声称 Multi 或 V2 提升了多少性能。

| 任务                      | 模式   | Host 耗时 | 调查耗时  | Tokens（含缓存读取） | SDK 估算费用 / USD | 最终补丁验收 | 对照协议           |
| ------------------------- | ------ | --------- | --------- | -------------------- | ------------------ | ------------ | ------------------ |
| GN-1 平台触发范围         | Single | 199.572 s | 194.594 s | 666,223              | 0.03375036         | 两次通过     | 满足               |
| GN-1 平台触发范围         | Multi  | 248.144 s | 243.459 s | 2,650,822            | 0.14358640         | 两次通过     | effort、身份数偏离 |
| City Builder 空闲预览重建 | Single | 208.202 s | 199.126 s | 582,222              | 0.04160424         | 两次通过     | 满足               |
| City Builder 空闲预览重建 | Multi  | 203.435 s | 194.080 s | 2,381,938            | 0.12794508         | 两次通过     | effort 偏离        |

总计 **6,281,205 tokens，SDK 估算 0.34688608 USD**。两组 Multi 的 worker 最后都被取消，可能有未上报的
取消中用量；这不是完整 provider 账单。表中数值是实际记录，不能把 City 的接近耗时解释成受控的加速效果。
[结果 JSON](codex-v2-single-multi-pilot/summary.json)、[CSV](codex-v2-single-multi-pilot/results.csv)、
[固定输入](codex-v2-single-multi-pilot/inputs.json)和[独立审计摘录](codex-v2-single-multi-pilot/audit.json)
不包含原始模型消息、thinking 文本或凭据。

**实现与本轮配置**

本次采用 [V2 协作设计](../multi-agent.md)：六个协作工具、任务树和 peer 消息、普通邮件不启动闲置轮、
busy followup、筛选后的上下文 fork、全树名额、空闲进程 LRU 与 Session 重载。全体代理共享一个私有 candidate；
coding 操作和 Godot 源码捕获使用同一把锁，每次游戏执行仍使用独立固定 stage。
实现适配 Pi 原生响应/工具批次边界，没有复制 Codex 的 streaming 抢占实现。

两个项目 revision、问题和验收器与[旧实验](single-multi-pilot.md)相同。GN-1 使用
`endlessm/moddable-platformer` 的 `e78b339500dec8e480b33723c4156bf9b74cd25c`，City 使用
`KenneyNL/Starter-Kit-City-Builder` 的 `4535092b740b378b700efd9df9e27a631815b84a`。
固定 Node 22.23.1、Pi 0.83.0、SRT 0.0.74、Godot 4.7.1；每路 Root 调查上限 20 分钟，worker 保留每轮
10 分钟和 64 次执行工具调用限制，团队共享 256 次执行调用上限。

四个 Root 实际均为 `openai-codex/gpt-5.6-luna/max`，六个成功启动的 worker 为同模型的 `high`。
它们全部显式选择 `fork_turns:none`，因此本轮没有实测默认 `all` 或数字 fork。
GN-1 首个 worker 使用无效字面模型名 `inherit`，在 Session 创建前失败；同名重试因路径保留而失败，之后创建了
另一个身份。最终 GN-1 有四个历史身份、三个实际 worker Session；City 有三个身份与三个 Session。

四个 Host 于 `10:38:33.627 UTC` 同时启动，共同调查重叠 191.274 秒。两组 Multi 都实际出现三个活跃 worker；
GN-1 的身份协议未满足，不能用“峰值为三”替代“全组只创建三个”。Host 耗时包含准备、调查和清理，不含独立验收；
调查耗时包围 SDK 调用。四路共享机器及 provider 容量，且每组仅一次。

**流程、计费和证据**

- 实际发现 10 个不同 Session，每个 Session 的逐条用量重算都与最后快照一致；两个 Multi 的已上报总和也一致。
  GN-1 的额外失败身份没有 Session，因此总体 `usageReconciled:false` 保留了缺失记录，不能误读成已有 Session
  的 token 相加错误。`fork:none` 没有继承来源，任务父节点与用量的 fork 父节点分开核对。
- 六个 worker 在 Root 停止时均留下取消状态和一条零用量 `aborted` 尾记录。取消不等于这段 provider 工作免费；
  两组 Multi 的 `usageIncomplete:true` 保留此限制。没有观察到 Root 重试或本轮 compaction。
  原始 City `agents.v2.json` 曾错误标为 `reportedUsage.incomplete:false`；原记录保留，审计汇总根据取消状态标为不完整，
  后续代码已修复这一标记。
- 两组共有 38 条 task/message/completion 记录。22 条已消费普通邮件在实际 Session 中各出现一次；
  观察到两条 GN-1 peer 消息及 City 的批量投递。这不能推广为故障恢复下的 exactly-once 保证。
- 四个 Root 在首次停止答复后均有 **0 条额外 assistant 完成响应**。六条取消完成通知留在邮箱，未再启动 Root。
  旧 Multi 记录对应为 12 和 9 条额外响应；这是可观察的生命周期差异，不能单独解释总耗时变化。
- 本轮项目源码都由 Root 修改。多个 worker 随后启动游戏，观察到与 Root 最终 stage 相同的 `sourceSha256`，包含 overlay/import 元数据；
  GN-1 另一个 worker 的旧 stage 在共享源码修改后仍保持原 hash。共享修改可见性与 stage 固定得到了实测，
  锁的串行与取消由离线回归覆盖，跨 writer 源码可见性与固定 stage 另有沙箱回归。
- 四份补丁按记录校验 hash/大小，并独立在内存中从原版重放，均匹配最终 candidate 文件。Root 最终 launch
  都发生在最后一次已记录源码修改后，未观察到之后的项目源码写入。stage 包含已清理的 native import 元数据，
  此审计没有重新构造整个 stage hash；最终补丁另经独立验收。
- 四个原始 checkout 检查都未变化；10 个被采样到的模型进程均带 IPv4 优先参数，结束后无已观测进程存活。
  未采集实际网络连接地址族，短命失败进程可能未被采样到。

本轮没有调用 `followup_task`、显式 `interrupt_agent`，也没有触发 LRU 重载或 TUI；相关路径由针对性测试覆盖。
没有成功 worker 自然完成后由父代理消费完成通知的实例，不能把普通邮件的实测扩展到该流程。

**验收覆盖**

模型启动前，原版与参考修复各重复三次，加上三个错误修复，共 15 项对照，全部符合预期。
模型结束后，四个最终补丁各在独立副本检查两次，共 8 次，全部通过。

GN-1 Single 在场景资源上设置 `resource_local_to_scene = true`，Multi 在脚本中复制 Shape 再修改大小，补丁不同。
两者都通过现有初始几何和 Shape 身份检查；验收器未模拟完整玩家触发或下落时序，不能据此断言所有动态情境等价。
City 两组交付逐字节相同的条件更新补丁，覆盖初始化、120 次 process 空闲窗口、15 个模型双向切换、回绕、
双键抵消与旋转。每次 66 个相关断言不代表 66 次独立实验或完整玩法通过。

**暴露的问题与后续修复**

运行时产品代码身份为 `40b70d5cfdb614a862cfce3432b6942d6ad8a6eeedd9056b3a9e69a21b40ccc0`。
实验结束后增加了 Host 私有 `spawnPolicy`：pilot 锁定 provider/model/effort，工具 schema 移除覆盖参数，
运行时也拒绝绕过 schema 的覆盖；最多创建三个历史身份，深度为一，检查先于身份与资源分配。
普通 V2 保留模型选择和递归能力。Host 不替 Pi 分工，也不自动创建 worker；“恰好三个且真正并发”仍由验收核对。

同时修复了进程清理失败后的引用保留与重试、未确认退出时的失败上报，以及取消但仍有快照时的 `incomplete` 标记。
不能确认 writer 停止时不发布最终补丁，Preview V4 的候选修改状态为 `null`。
这些收尾修复已加入回归测试；**本轮数据来自修复前的实验约束，不是修复后再跑的结果**。
当前脚本会拒绝拿旧准备目录启动新版本，复测需另建输出目录；本次没有额外模型调用。

实测前 `corepack pnpm check` 的 988 项离线测试、20 项 Godot 测试、完整 sandbox wrapper 的 10 项测试均通过。
收尾修复后再次运行完整 `corepack pnpm check`，1006 项离线测试以及 lint、格式和类型检查全部通过；完整 sandbox
wrapper 的 10 项测试也再次通过。Pilot 脚本的 10 项离线回归通过，覆盖运行配置偏离与计费审计。
原始 Session、执行和验收记录均保留在本地私有状态目录。

面向求职，这一案例能说明如何适配协作调度、保存可审计证据、发现实验协议失效并在 Host 层修复。
它不支持“Multi 提升修复率或节省某百分比费用”的简历结论。

后续已完成一次[固定配置复测](codex-v2-retest.md)，另存四路结果与审计；本页原始数据和协议无效判定保持不变。
