# Project Preview Multi-Agent V1

Project Preview 可通过 `--multi-agent` 启用委派。Root 保留现有 Pi Session 和 coding/game tools；Host 管理子进程、
独立工作副本、工具权限、执行预算与结果。Pi 仍负责每个 Session 的模型调用、调查策略、工具调度和 compaction。
本功能是实验性 Preview，不改变 Godot 项目支持范围，也不自动判定修复成功。

## 使用

在满足 [开发指南](development.md) 的 Linux、SRT、Godot 和 Host 模型认证前提下：

```bash
corepack pnpm project preview -- "调查问题，将可独立验证的部分委派给子代理" \
  --provider PROVIDER --model MODEL --multi-agent
```

省略目标可进入 Pi TUI。Root 决定是否委派以及如何分工；开启模式不强制启动子代理，也不强制固定调查流程。

| 参数                         | 行为                                                |
| ---------------------------- | --------------------------------------------------- |
| `--multi-agent`              | 为 Root 添加协作工具；默认关闭                      |
| `--max-agents N`             | 同时存活的子代理数量，默认 2，允许 1–4；不包含 Root |
| `--worker-model MODEL`       | 所有新子代理使用的模型；缺省继承 Root               |
| `--worker-provider PROVIDER` | 子代理 provider；指定时必须同时指定 worker model    |
| `--worker-thinking LEVEL`    | 子代理 thinking；缺省继承 Root                      |

Worker 配置参数需要同时启用 `--multi-agent`。模型与可用认证由 Pi SDK 检查，凭据保留在 Host 模型调用路径。
未配置 worker provider 时继承 Root provider。V1 不允许模型通过委派参数修改 Host 权限或单独选择 worker 模型。

## 运行结构

```text
ChronoRift Host
├── Root Pi Session
│   ├── coding / game tools
│   └── delegation / messaging / waiting / cancellation / apply tools
├── AgentSupervisor
│   ├── worker state, queues, notifications, deadlines
│   ├── private snapshots and immutable turn results
│   └── Host tool broker → shared SRT controller
│       ├── Root execution scope → Root candidate / staged Godot
│       ├── Agent A execution scope → candidate A / staged Godot A
│       └── Agent B execution scope → candidate B / staged Godot B
├── Worker process A → persistent Pi Session → IPC proxy tools
└── Worker process B → persistent Pi Session → IPC proxy tools
```

每个子代理创建时复制 Root **当时的 candidate**，包括 Root 尚未提交的修改。后续 Root 修改不会自动同步到子代理；
子代理修改也不会自动进入 Root。Worker 保留自己的 Session 和工作副本，可接收下一轮任务。V1 只允许 Root 委派一层，
子代理不能继续创建子代理。

Worker 只通过版本化 IPC 请求 Host 工具。Host 将调用绑定到发送进程对应的工作区、执行记录与取消范围，校验参数，
再调用现有 SRT coding/Godot 路径。模型和项目内容不能指定另一个代理的工具执行目录、取得其 execution 或扩大权限。
所有执行共用一个 Host SRT controller，但每个代理拥有独立进程资源；取消一个代理不会关闭整个 controller。
工具和 Godot 无网络访问，也不继承 Host 凭据环境。

## 协作工具与生命周期

| Root 工具                                                       | 语义                                                                               |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `spawn_agent(task, context?)`                                   | 创建独立 Session，返回 `agentId` 和 `turnId`；只传显式任务与背景，不复制 Root 对话 |
| `list_agents()`                                                 | 查询存活状态、当前轮次、队列与失败信息                                             |
| `send_message(agentId, message)`                                | 向已有代理发送补充信息；不启动新一轮任务                                           |
| `followup_task(agentId, task)`                                  | 在同一 Session 和副本中排队执行下一轮任务                                          |
| `wait_agent(targets, mode?, timeoutMs?)`                        | 等待指定轮次的任意或全部结果；等待超时不取消任务                                   |
| `read_agent_result(agentId, turnId, section?, offset?, limit?)` | 分页读取 `summary`、`diff` 或 `evidence`                                           |
| `interrupt_agent(agentId)`                                      | 取消当前轮与排队任务，保留可合作停止的 Session；无法停止的进程会被终止             |
| `close_agent(agentId)`                                          | 关闭代理、释放名额；保留候选和已有结果                                             |
| `apply_agent_patch(agentId, turnId)`                            | 将指定已冻结候选显式合入 Root candidate                                            |

子代理另有 `send_message(message)`，只向 Root 发送调查信息。消息是协作上下文，不具有授权效力。

一个 worker 同时执行一轮任务，最多排队 8 轮。空闲 worker 仍占一个名额，需 `close_agent` 才释放。
每轮默认最多 10 分钟，最多 64 次执行工具调用；Root 与全部子代理共享 256 次执行工具调用上限。
`game_stop`、协作控制和读取既有结果不消耗执行预算。用量记录包含 token 与 cost，但不提供硬 token、费用、CPU、
内存或磁盘配额。

Headless 模式会在 Root 当前轮结束后等待存活任务的结果，通过 Pi 原生 custom message 交回 Root，继续同一 Session。
该过程计入现有整体超时。Root 运行中收到的消息由 Pi 的 follow-up 机制接收；Host 不重写调查步骤。
每次 Root 续跑都会等待 Pi 完成其重试；最终失败会停止自动唤回和剩余子任务，并保留失败结果，后续子代理消息不会将其
覆盖为成功。

TUI 提供 `/agents` 查看代理，`/agents stop` 停止 Root 与子代理当前操作，并取消子代理队列。
Esc 保留 Pi 编辑器的原有行为，同时暂停自动唤回；后台子代理继续执行并保留结果。下一次用户输入恢复自动接收。
正常退出 TUI 时，Host 通过 Pi 的 `session_shutdown` 生命周期等待清理并写出结果。

## 候选合并与证据

每轮结束后，Host 先停止该代理的执行，再冻结候选并提取经过 round-trip 校验的 patch。后续任务不能改写旧轮结果。
Root 通过 `apply_agent_patch` 显式合入候选，用户的原始 checkout 不变。

合并按文件进行三方比较：上次导入该代理候选作为基线、当前 Root candidate、指定轮的冻结候选。首次使用创建时快照为
基线。Root 和子代理对同一文件做了不同修改时返回 conflict，整次操作不写入；不会自动按行解决冲突。只允许导入最新
完成轮，重复应用同一最新结果返回 `no_op`；已被后续结果替代的轮次或不再适用的基线返回 `stale`。二进制、文件模式、
添加和删除均参与比较；不接受路径逃逸、危险链接、特殊
文件或大小写/Unicode 路径冲突。

Host 串行化一个工作区内的工具、快照和应用操作，并保留应用事务记录。应用中途失败会回滚；若回滚失败，Root 工作区
标为不可用，后续执行拒绝继续。强制终止 Host 可能留下未提交事务；V1 不实现崩溃恢复或跨命令恢复 Session。

Godot 使用各自独立、源码只读的运行 stage。应用 patch 不会更新已经启动的游戏；Root 应重新 `game_launch` 并查询
新执行，确认合并后的实际行为。子代理的 observation 属于它自己的 source/build/execution，不能直接当作 Root 的结果。
`completed` 仅表示 Loop 结束，`applied` 仅表示候选导入成功。

## 结果与验证边界

普通 Preview 继续输出 `preview.v2.json`；启用多代理时输出 `preview.v3.json`，新增 `agents` 摘要和记录路径。
同一私有 Task 目录中保留：

- `records/agents.v1.json`：所有代理和轮次终态、Root/worker 的最后可用 Session 统计与共享工具调用量。
- `records/agents/<agentId>/`：worker Pi Session、runtime records、每轮候选 patch 与结果。
- `records/candidate.patch`：最终 Root candidate 的 patch；未显式导入的子代理修改不在其中。

Pi Session 统计是累计值，总用量只计入每个 Session 最后一次可用快照。失败或中断的 provider 请求可能未上报完整用量；
记录中的 `incomplete` 和 limitations 表明缺口，不能把它当成最终账单。

离线测试覆盖真实 worker 子进程 IPC、持续 Session 协议、调度/取消/预算、补丁合并和回滚。沙箱测试覆盖跨代理访问拒绝、
后台进程清理，以及真实 Godot 的双子代理修改、独立查询、取消、显式应用和 Root 重新验证。模型行为使用测试替身；
这些测试不验证在线模型是否会合理分工或正确修复问题。
