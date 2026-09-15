**Godot Single / Multi 四路复测，2026-09-13**

本轮固定配置协议全部满足，四次调查均结束，四份最终补丁各通过两次独立验收。
在这两个案例的单次对照中，**Multi 没有带来验收收益，Host 耗时分别增加 39.5% 和 62.1%，
已上报 SDK 估算费用分别为 Single 的 4.94 倍和 4.17 倍**。这说明当前固定三个 worker 的配置在这两个小任务上成本较高，
不能据此推广为所有 Godot 任务或所有 Multi 策略的结论。

| 任务                      | 模式   | Host 耗时 | 调查耗时  | Tokens（含缓存读取） | SDK 估算费用 / USD | 独立验收   |
| ------------------------- | ------ | --------- | --------- | -------------------- | ------------------ | ---------- |
| GN-1 平台触发范围         | Single | 163.337 s | 158.956 s | 377,159              | 0.02486124         | 2 / 2 通过 |
| GN-1 平台触发范围         | Multi  | 227.816 s | 223.581 s | 2,529,053            | 0.12279988         | 2 / 2 通过 |
| City Builder 空闲预览重建 | Single | 157.069 s | 148.719 s | 818,421              | 0.03335560         | 2 / 2 通过 |
| City Builder 空闲预览重建 | Multi  | 254.643 s | 246.567 s | 3,030,077            | 0.13907080         | 2 / 2 通过 |

总计 **6,754,710 tokens，SDK 估算 0.32008752 USD**。四个 worker 取消时留下零用量的 aborted 尾记录，
可能存在未上报的在途请求用量；两组 Multi 都正确标记 `usageIncomplete:true`。费用及倍数只针对已记录的 SDK 估算，
不是 provider 账单，不能解释为完整实际支出。Host 耗时不含表外的独立验收。

[结果 JSON](codex-v2-retest/summary.json)、[CSV](codex-v2-retest/results.csv)、
[固定输入](codex-v2-retest/inputs.json)和[审计摘录](codex-v2-retest/audit.json)保留数值、配置和证据 hash。
原始 Session、模型输出及完整运行记录留在仓库外的本地私有目录。

本轮与[首次 V2 实测](codex-v2-single-multi-pilot.md)分别保存。首次实测的 effort 与身份数偏离仍判为协议无效，
未用本轮替换历史数据，也未将两轮合并计算平均数。

本轮只执行了一次四路并发调查。四个 Host 于 `11:16:15.814 UTC` 同时开始，启动偏差为 0 ms，
共同调查区间为 148.710 秒。两个案例各跑一次 Single 和一次 Multi；每组 Multi 恰好创建三个直接 worker，
三次 spawn 均成功，没有替代身份或更深层代理。GN-1 三个初始 worker 任务共同存续 146.774 秒，City 为 115.548 秒；
这是任务生命周期重叠，不是持续模型计算时间。

所有 10 个实际 Session 从开始到结束均使用 `openai-codex/gpt-5.6-luna/max`。
Host 私有 `spawnPolicy` 锁定 provider、model 和 effort，限制累计身份数为三、深度为一；
启动前检查了 Root 工具 schema，实际 worker schema 也不提供配置覆盖参数。
Host 只施加约束，分工、工具选择和调查策略仍由 Pi 决定。
六个 worker 均显式选择 `fork_turns:all`，各继承一条最初的父任务，来源和 Session 归属均核对成功，
没有重复计入父 Session 的历史用量。这只实测了初始任务继承，没有覆盖省略参数时的默认值、数字窗口或复杂历史筛选。

项目 revision、问题、模型元数据和验收器均与前轮一致：GN-1 为 `endlessm/moddable-platformer` 的
`e78b339500dec8e480b33723c4156bf9b74cd25c`，City 为 `KenneyNL/Starter-Kit-City-Builder` 的
`4535092b740b378b700efd9df9e27a631815b84a`。运行时产品身份为
`7583e209854ab941a35ac5d9aeae6df588eb61e63612244e116c2aec916b9711`，所含 385 个产品文件在调查结束时逐项核对未变。
固定 Node 22.23.1、Pi 0.83.0、SRT 0.0.74、Godot 4.7.1。每个 Root 调查上限 20 分钟，worker 每轮上限
10 分钟、64 次执行工具调用；Multi 共享上限 256 次，本轮分别使用 188 和 128 次。
10 个被观测模型进程都带 IPv4 优先参数，结束后无已观测进程存活；未采集实际连接地址族。

两组 Multi 都选择由三个 worker 调查、Root 修改源码。GN-1 分为触发逻辑、场景几何和验证，City 分为代码定位、
运行验证和架构审阅；六个初始 worker 任务均不允许改码。每组一个 worker 自然完成，完成通知被父代理消费；
GN-1 另两个在 Root 收尾时取消，City 另两个由 Root 显式 `interrupt_agent` 取消。
因此结果描述的是“三个并行调查者加 Root 改码”的实际策略，不能作为多个 worker 并行编码收益的测量。

流程审计确认：

- 10 个不同 Session 的逐条用量总和、最终快照和团队汇总一致。四个 Root 首次停止答复后均无额外 assistant 完成响应。
  普通邮件和收尾通知没有再次启动已经结束的 Root。
- 两组共 33 条 task/message/completion 记录，31 条已消费，其中普通邮件 21 条、完成通知 4 条、初始任务 6 条。
  25 条已消费的非任务消息均与实际收件 Session 逐 ID、逐目标对应一次。GN-1 的两条收尾取消通知未消费，
  没有记录到投递错误。这不能证明故障恢复下的 exactly-once，也不能证明消息对修复产生了因果贡献。
- 两组各有 2 个 cancelled worker，`reportedUsage.incomplete` 与状态一致。没有 provider error、compaction 或
  Root retry 记录；worker IPC 不提供完整重试事件流，worker 重试总数未知。
  [summary.json](codex-v2-retest/summary.json) 中的 `providerRetries:0` 仅表示已观测的 Root 重试事件。
  调查中共记录 7 条 `isError` 工具结果：4 次 read offset 参数错误、1 次 game_query executionId 参数错误，
  以及 2 次取消 worker 导致的 wait_agent 中断；均未阻断最终独立验收。
- 四份补丁均通过逐次 edit 重放及最终 unified patch 独立内存重放，与最终 candidate 文件一致。
  Root 最终游戏启动均发生在最后成功源码编辑之后，之后未再发现源码写入；四个原始 checkout 均未改变。
  18 次调查内 Godot 执行的源码完整性检查全部通过，每个 Multi 最多同时存在 4 次 Godot 执行。
- 本轮没有多个代理并发写源码，也没有源码编辑与旧 Godot stage 运行重叠；不能把完整性检查通过扩展为这两类压力场景的实测。
  stage hash 含 overlay/import 元数据，与补丁 hash 不同；原生导入元数据清理后没有重新构造整个最终 stage hash。

模型启动前运行了 15 项验收器对照：两个原版和两个参考修复各重复三次，加上三个错误修复，结果全部符合预期。
模型结束后，四份最终补丁各在独立副本执行两次验收，共 8 次通过。
GN-1 两组逐字节交付相同补丁，在修改大小前复制平台的 Shape；City 两组也相同，以索引变化为条件更新建筑预览。

GN-1 验收覆盖四个平台的初始几何、精灵与 Shape 身份，未模拟完整玩家触发或下落时序。
City 覆盖初始化、120 次 process 空闲窗口、15 个模型双向切换、回绕、双键抵消和旋转；每次 66 个相关断言不代表
66 次独立实验。`completed` 只表示调查 Loop 结束，以上独立验收也不等于完整玩法通过。
本轮没有调用 `followup_task`，没有实测 LRU 重载、TUI 或复杂 fork；不能宣称完整 V2 生命周期都已由本次在线实验验证。

本轮未修改运行时代码。实测前的既有验证为 1006 项离线测试、20 项 Godot 测试、10 项 sandbox wrapper 测试及
10 项 pilot 脚本回归通过；本轮新增验证为 15 项对照、8 次最终验收、配置/用量/行为审计，以及报告格式与数据一致性检查。
没有为了改善结果追加模型轮次。

面向求职，可据此说明：实现了固定配置的 Single / Multi 对照、可核对的 Session 计量及独立 Godot 验收，
发现固定三个 worker 在两个小型修复任务中耗时增加约 39%–62%、已记录估算费用达到约 4.2–4.9 倍。
样本量为每组一次，四路共享机器和 provider 容量，任务又是已知的小型局部修复；这些是描述性结果。
后续若评估并行开发收益，应另选存在可独立实现子任务的案例，重新预设协议，不把本轮负结果包装成性能提升。
