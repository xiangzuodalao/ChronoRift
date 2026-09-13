**两个真实 Godot 任务的 Single / Multi 四路并发 Pilot，2026-09-13**

四次调查均正常结束，四个最终 Root 候选各通过两次独立验收。同一任务的 Single 与 Multi 补丁逐字节相同。
本轮两个局部修复任务中，Multi 没有增加验收收益，Host 耗时分别为 Single 的 **3.94 倍、4.69 倍**，
SDK 估算费用分别为 **8.12 倍、11.63 倍**。这是两个已知案例、每组一次的观察，不是总体修复率或一般性能结论。

| 任务                      | 模式            | Host 耗时 | 调查耗时  | Tokens（含缓存读取） | SDK 估算费用 / USD | 最终候选验收 |
| ------------------------- | --------------- | --------- | --------- | -------------------- | ------------------ | ------------ |
| GN-1 平台触发范围         | Single          | 165.982 s | 161.432 s | 361,948              | 0.022349           | 两次均通过   |
| GN-1 平台触发范围         | Root + 3 worker | 654.791 s | 650.292 s | 3,707,184            | 0.181429           | 两次均通过   |
| City Builder 空闲预览重建 | Single          | 125.310 s | 116.440 s | 254,705              | 0.017630           | 两次均通过   |
| City Builder 空闲预览重建 | Root + 3 worker | 587.974 s | 579.202 s | 5,012,698            | 0.205127           | 两次均通过   |

四次已上报总用量为 **9,336,535 tokens**，SDK 估算合计 **0.42653616 USD**。
估算使用实际模型 metadata 的价格，并按请求核对；采用订阅认证，**实际账单金额不可由这些记录确定**。
缓存读取已单独列在 [CSV](single-multi-pilot/results.csv) 中，token 总数不是唯一上下文的大小。
[机器可读结果](single-multi-pilot/summary.json)及[固定输入](single-multi-pilot/inputs.json)不含原始模型消息或凭据。

四次运行均使用 `openai-codex / gpt-5.6-luna / max`、Godot 4.7.1、Pi 0.83.0、SRT 0.0.74、Node 22.23.1。
每次整体调查上限 20 分钟，共享执行工具上限 256；worker 保留现有每轮 10 分钟与 64 次执行调用上限。
Single 和 Multi 都有完整 coding / game tools。Multi 额外获得协作工具和启动三个 worker 的要求，具体分工由 Pi 决定。
两个源码 revision、原始问题和比较设置见[预先设计的计划](../multi-agent-pilot-plan.md)。没有补跑模型或人工续轮。

Host 耗时从四路启动屏障释放后包围 Preview 调用，包含源码准备、调查与清理，不包含独立验收。
“调查耗时”包围 SDK 调用，也包含其 Session 创建；SDK 的 20 分钟内部计时在 Session 创建后开始。
四个 Host 的启动时间差为 **1 ms**，四个调查区间共同重叠 **116.440 s**。
它们共享机器和 provider 容量，因此这些耗时属于四路并发负载下的结果。

**实际覆盖与未覆盖**

- 两个 Multi 各实际启动三个 worker，初始三个任务的共同重叠区间分别为 **172.030 s**、**85.814 s**。
  六个 worker 都完成一轮并关闭；没有替换 worker 或多次累计相同 Session 费用。
- 四个 Root 与六个 worker 的进程记录均包含 IPv4 优先参数，真实子进程测试也验证 DNS 顺序传递。
  没有记录实际连接的地址族，不把配置解释成全程只用 IPv4。
- 10 个不同 Session 的原始记录汇总与最后累计 stats 全部一致，两个 Multi 的总用量也与 Host summary 一致。
  本次没有观察到 provider error / aborted usage，Root 的重试事件数均为零；这不能排除 provider 未上报的费用。
- 18 次 Agent 发起的 Godot 执行均报告 staged source 未变，四次运行前后两个原始 checkout 均保持不变；
  四个 Host 退出后，已观测的子进程中没有存活进程。
- 两个 Multi 都由 Root 自行修改最终源码，**没有调用 `apply_agent_patch`**。
  本轮覆盖委派、独立调查、结果汇总和 Root 重新运行，没有现场覆盖显式补丁导入或冲突处理。
- 本次会话没有产生带 usage 的 compaction / branch summary / tool result；这些统计分支由离线回归测试覆盖。
  取消、provider 失败计费等路径也不能由这四次正常完成的运行验证完整。

**为何这两次 Multi 更慢**

GN-1 的三个 worker 都被 Root 分派调查任务。前两个在约 3 分钟时交付，第三个从
08:15:43 UTC 调查到 08:23:48 UTC。Root 等待结果后，于 08:23:55 UTC 修改源码，再启动新 Godot 执行验证。
这段可观察的等待延长了本轮交付时间；不把全部时间差归因于单个因素。

City Builder 的三个 worker 在 08:18:36 UTC 前全部结束，Root 持续验证到约 08:25:07 UTC。
Root 共发起 5 次 `game_launch`，Single 为 1 次，最后却交付同一份补丁。
两例说明本轮强制三 worker 的工作方式增加了调查、等待和验证工作量；并未证明多代理在更复杂任务中无价值。

四组显式标记 `isError` 的工具结果分别为 **1 / 11 / 1 / 12**，按主表顺序排列。
其中 22 次是 `read` 的 offset 非正整数，2 次是路径格式错误，GN-1 的第三个 worker 还收到一次
每轮 64 次执行工具预算耗尽的错误，随后正常结束。两组 Multi 的共享执行预算分别使用 223/256、170/256。
这些是实际调查中的失败反馈，不是 provider 失败，也没有被从耗时或费用中扣除。
[工具错误摘录](single-multi-pilot/tool-errors.json)只统计显式 `isError`，不替代原始命令退出码和运行日志。

**验收与工程验证**

启动模型前，每题原版和参考修复各检查三次，再检查三个错误修复控制，共 15 项，结果全部符合预期。
四次模型调查全部结束后，每个最终 Root 补丁在独立副本验收两次，共 8 次，全部通过。
验收器和参考补丁不在 Agent 可读的 candidate 中，worker 的观察不作为 Root 的验收结果。

GN-1 的检查仅覆盖四个平台初始几何、sprite 数和 Shape 身份，不模拟完整玩家触发或下落时序。
City 的检查覆盖初始化、120 次 process 空闲窗口、15 个模型双向切换、回绕、双键抵消和旋转，
每次 66 个相关场景断言全部通过，不代表 66 次独立实验或完整玩法通过。

实现增加两个 Pilot 脚本，统一采集用量并用四个独立 Node Host 运行现有 Preview；
worker 只继承受限 DNS 参数，GN-1 保存候选检查器的补丁应用改用现有 SRT coding 沙箱。
首次完整 `corepack pnpm check` 通过，其中 968 项离线测试通过；`test:godot` 20 项通过，
沙箱 conformance wrapper 的 10 项测试通过，Pilot 的 6 项离线测试通过。
所有模型运行结束后，汇总脚本补充验收耗时、token 分类和 IPv4 / 清理字段；结果保留最终汇总脚本 hash，
与启动时的产品源码身份分开记录。

**复用脚本**

本页保留 V1 的实际运行记录。当前脚本已切换为 V2，并增加 Host 实验约束；新版本的实测和限制见
[V2 四路实验](codex-v2-single-multi-pilot.md)。以下入口仍可复用，但不会重建本页的旧实现。

在 ChronoRift 根目录使用固定 Node，准备两个上述 revision 的干净 checkout。
下列变量分别指向源码、固定 Godot 和新的输出目录；输出目录必须在源码与 ChronoRift 工作树之外，且父目录已存在。
`prepare` 不调用模型，`run` 会调用真实模型并同时运行四组；重复使用同一输出目录启动模型会被拒绝。

```bash
node --dns-result-order=ipv4first --import tsx scripts/godot-multi-agent-pilot/run.mjs prepare \
  --gn1 "$GN1_SOURCE" --city "$CITY_SOURCE" --godot-bin "$GODOT_BIN" --output "$PILOT_OUTPUT"
node --dns-result-order=ipv4first --import tsx scripts/godot-multi-agent-pilot/run.mjs run \
  --output "$PILOT_OUTPUT"
node --dns-result-order=ipv4first --import tsx scripts/godot-multi-agent-pilot/run.mjs evaluate \
  --output "$PILOT_OUTPUT"
node scripts/godot-multi-agent-pilot/summarize.mjs "$PILOT_OUTPUT"
```

只有前一步成功后才执行后一步。运行前还应完成[开发指南](../development.md)中的适用离线与沙箱检查。
Pilot 专用回归测试使用 `node --import tsx --test scripts/godot-multi-agent-pilot/*.test.mjs`。

本页及 CSV 是可审阅摘录。完整 Session、worker 轮次、Godot 运行和验收记录保留在本地私有状态目录，
旧案例记录未被覆盖。本轮适合作为求职中的“如何测量协作开销和识别适用边界”案例。
