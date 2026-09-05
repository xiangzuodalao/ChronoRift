# 真实调用导览

两组独立新会话，共同 prompt 见[案例正文](../city-builder-preview.md)。
完整工具摘录为 [coding-only](coding-only/trace.json) 和 [ChronoRift](chronorift/trace.json)，
包含所有请求和可用结果、源 Session 行号、全部助手错误及普通文字，省略 thinking 和原始模型请求。
`call.N` 是各会话中的请求顺序；一条 assistant 消息可以提出多个工具请求。

| 会话        | 请求 / 结果 | 游戏请求 | 工具拒绝 | 返回文本中的命令失败 |
| ----------- | ----------- | -------- | -------- | -------------------- |
| coding-only | 22 / 22     | 0        | 0        | 4                    |
| ChronoRift  | 35 / 35     | 10       | 2        | 3                    |

没有缺失结果或助手 provider error。命令非零退出写在工具返回文本中，不一定设置 `isError`，因此与工具拒绝分开统计。
两组都使用同一份原始源码，候选 patch 逐字节相同。

## coding-only

- `call.1–9`：发现并读取源码，检查环境中的 Godot 可执行文件。
- `call.10`（原 Session 行 18–19）：在 `scripts/builder.gd` 保存切换前的 `index`，仅净变化时更新预览。
- `call.11–22`：diff 与静态验证；`call.11/14/15/18` 命令失败，全部保留。两次静态计数断言失败后修正了检查逻辑。
- 最终回复明确没有 Godot 运行时验证。候选被会话外的固定检查器另行检查。

## ChronoRift

- `call.1–15`：自主发现并读取源码；`call.4/5` 因 `offset=0` 被拒绝，随后成功读取。
- `call.16`（原 Session 行 25–26）：完成与 coding-only 相同的修复。
- `call.17–20`：首次启动候选，查询预览容器和 `index`，随后停止。该执行不是原版复现。
- `call.21–28`：检查实际 diff；三次 Git 命令失败均保留。没有第二次源码修改。
- `call.29–35`：再次启动同一候选，重复查询，中间执行一次普通 bash 等待，然后停止。

第二次执行为 `inspection.4ad77e72-311c-4dea-bc52-3329cfd4d01e`：

| 调用      | 选择               | processFrame | physicsTick | 实际返回                               |
| --------- | ------------------ | ------------ | ----------- | -------------------------------------- |
| `call.30` | Container children | 657          | 273         | 1 个 `road-straight`，引用 `.object.3` |
| `call.31` | Builder.index      | 658          | 274         | 0                                      |
| `call.33` | Container children | 1777         | 737         | 同一 `.object.3`，仍为 1 个子节点      |
| `call.34` | Builder.index      | 1778         | 737         | 0                                      |

这支持两个采样点之间保留同一个预览对象；查询没有记录每个中间帧的事件，也没有模拟切换输入。
完整的空闲添加/移除计数及切换验收来自会话结束后的独立检查器。
不同 execution 中的 `.object.3` 不能互相比较。

## 运行状态与原文纠正

两次 `game_stop` 都真实执行；[运行 1](chronorift/runtime-records/execution-1.json)与
[运行 2](chronorift/runtime-records/execution-2.json)均显示游戏 child 的 `run.signal=SIGTERM`、`run.exitCode=null`，
源码完整性通过，无超时或输出截断。Agent 最终写的“退出码 0”不符合这两个运行记录。
记录顶层的 `exitCode=0` 属于 wrapper。公开摘录保留 Agent 原文，并在这里区分进程层级；
wrapper、导入和独立检查的退出 0 不替代 Godot 子进程的退出状态。
