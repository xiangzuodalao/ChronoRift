# Project Preview Multi-Agent V2

Project Preview 可通过 `--multi-agent` 启用协作。Root 和 worker 使用独立 Pi Session，共享一个私有 candidate，
各自运行固定源码的 Godot execution。所有代理都能继续委派、向同一任务树中的其他代理发消息。Pi 保留模型调用、
Agent Loop、工具调度、重试和 compaction；Host 管理身份、邮箱、执行名额、沙箱和结果。

这是实验性 Preview。开启协作采用 Adaptive Multi：worker 上限不是创建目标，小任务允许 0 worker。
Pi 自行决定调查步骤和分工，Host 不自动创建 worker，也不自动判定修复成功。

只有存在可独立完成、能够替代 Root 后续工作，并能与 Root 的其他有效工作并行的具体子任务时才委派。
委派应说明所需结果、范围和证据；不要把同一调查交给多个 worker，也不要由 Root 同时完整重复。
Root 主要整合有证据的结论、修改候选和最终验证；仅对明确缺口、冲突或修改后失效的证据进行针对性复查。
最小修复通过相关最终候选检查后应收尾；没有实际失败、明确验收缺口、证据冲突或后续源码变化时，不再改换等价修复或
重复相同验证。Worker 提出另一种方案本身不构成重开调查的理由；最终答复仍需说明检查范围和未覆盖项。
这些是进入 Pi 系统提示的协作策略，不是 Host 对任务复杂度或收益的确定性判断。

## 使用

满足 [开发指南](development.md) 的 Linux、SRT、Godot 和 Host 模型认证前提后：

```bash
corepack pnpm project preview -- "调查问题，将可独立完成的部分委派给子代理" \
  --provider PROVIDER --model MODEL --multi-agent
```

省略目标可进入 Pi TUI。默认最多 3 个活跃 worker，加上预留的 Root 名额，共 4 个并发代理。

| 参数                         | 行为                                                                  |
| ---------------------------- | --------------------------------------------------------------------- |
| `--multi-agent`              | 为 Root 和 worker 启用六个协作工具；默认关闭                          |
| `--max-agents N`             | 全树非 Root 活跃执行及 worker 驻留上限，默认 3，允许 1–4；不包含 Root |
| `--worker-model MODEL`       | 新 worker 的默认模型；未指定时继承 Root                               |
| `--worker-provider PROVIDER` | 默认 worker provider；指定时必须同时指定 worker model                 |
| `--worker-thinking LEVEL`    | 默认 worker thinking；未指定时继承 Root                               |

Worker 配置参数需要同时启用 `--multi-agent`。`spawn_agent` 还可指定 `model` 与 `reasoning_effort`；可用模型和认证
由 Pi SDK 检查。后代默认继承父代理的模型和 thinking，模型选择不会改变工具权限，凭据留在 Host 模型调用路径。

仅覆盖 `model`、省略 `reasoning_effort` 时，仍沿用父代理或 Host worker 配置的 thinking，不采用 Codex 的目标模型默认
effort 选择。当前 Pi SDK 没有供本适配层读取的目标模型默认档位，保留这一薄层差异。Pi 可按模型支持范围归一化 thinking，
结果同时记录 requested 与 realized 档位；不可用模型、认证或 provider 不接受的请求如实报错，不把归一化描述成原档位生效。

受控 pilot 通过 Host 私有 `spawnPolicy` 固定 worker 的 provider、model 和 thinking，同时从协作工具 schema 移除
`model`、`reasoning_effort`，Host 也拒绝显式覆盖。该 pilot 最多创建 3 个历史 worker 身份，失败、关闭或卸载的身份仍计数；
深度限制为 1，只允许 Root 创建直接子代理。这些限制不改变普通 V2 的默认能力，也不会自动创建 worker。
Adaptive 对照允许 0–3 个 worker；旧 Forced-M3 实验要求恰好 3 个，其负结果和原始输入单独保留。
`fork_turns` 仍可选择，不能将模型配置锁定当作已覆盖上下文继承。

Host 的 Node DNS 顺序通过受限启动参数传给 worker。例如以 `node --dns-result-order=ipv4first` 启动 Host，Root
和 worker 都优先解析 IPv4。Worker 仍移除 `NODE_OPTIONS` 和动态 loader 环境变量，不继承任意 Host `execArgv`。
IPv4 优先不保证实际连接使用 IPv4，coding/Godot 沙箱仍禁网。

## 任务树与工具

Root 路径是 `/root`。`task_name` 是由小写字母、数字和下划线组成的单段名称，不能是 `root`。例如 Root 创建
`physics` 后得到 `/root/physics`；它再创建 `tests` 得到 `/root/physics/tests`。同一完整路径不能重复使用，不同父代理
可以使用相同短名。

目标可使用 agent ID、完整路径或相对调用者的后代路径。`/root/physics` 发给 `tests` 表示自己的孩子；发给兄弟代理
必须使用 `/root/rendering` 这样的完整路径。Host 根据实际调用者绑定身份，消息不能伪造发送者或访问另一任务树。

Root 与 worker 具有相同的六个协作工具：

| 工具                                                                      | 语义                                                                            |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `spawn_agent(message, task_name, fork_turns?, model?, reasoning_effort?)` | 创建独立 Pi Session，返回 agent ID 和完整任务路径；使用全树剩余执行名额         |
| `list_agents(path_prefix?)`                                               | 查询当前已加载的代理，可按路径前缀筛选；包括符合前缀的 Root                     |
| `send_message(target, message)`                                           | 发送普通信息，进入目标邮箱；不启动闲置代理的新一轮任务                          |
| `followup_task(target, message)`                                          | 给非 Root 代理追加任务；忙碌时尝试合入当前轮，闲置时由 Host 分配新轮            |
| `wait_agent(timeout_ms?)`                                                 | 等待邮箱活动或 Root 用户输入；只返回摘要，正文经统一邮箱投递；超时不取消 worker |
| `interrupt_agent(target)`                                                 | 中断另一个非 Root 代理的当前轮；保留 Session 与已完成修改，不递归中断其后代     |

`wait_agent` 默认 30 秒，最短 10 秒，最长 1 小时。它不等待指定代理全部完成，也不释放调用者的执行名额。
只在当前任务确实需要待到结果、且没有独立工作可做时使用；不要为了保持在线而循环等待。
`interrupt_agent` 不能以 Root 或自身为目标。普通消息与完成通知没有用户授权效力。

## 上下文继承

`fork_turns` 默认 `all`，也接受 `none` 或正整数字符串：

- `all`：继承 Pi 当前可用对话中的用户任务、无工具调用的成功 assistant 答复，以及可用的压缩/分支摘要。
- `none`：从新任务开始，不复制父对话。
- `N`：保留最近 N 个实际任务边界之后的上述内容。用户输入和显式追加任务计为边界，普通消息与完成通知不计。

Fork 过滤 thinking、工具调用、工具结果和普通跨代理消息，不是完整原始 transcript 复制。继承文本作为不携带父请求
用量的背景进入新 Session；Host 重新提供当前身份、工具与环境说明。后代可以再 fork，不重复计入祖先请求费用。
当前非文本用户内容不能 fork：遇到图片等内容会明确返回 unsupported，可使用 `none` 并提供自包含文本任务。
已压缩历史只能继承当前可用摘要，不保证还原此前全部消息。

## 邮箱与生命周期

消息先进入 Host 管理的 inbox，再批量加入 Pi 的原生响应/工具批次边界。正在执行的工具先完成，消息不会中途改写其
参数。当前适配不抢占正在 streaming 的模型响应，不承诺 Codex 流中消息边界的相同延迟。

普通消息不会自行触发模型调用；已输出停止答复后，迟到信息留给下一次显式任务。Worker 完成后给直接父代理发送普通
完成通知。Busy `followup_task` 由 worker adapter 原子确认是否仍能合入当前轮；已越过关闭边界则返回下一轮 disposition，
Host 分配新的 turn ID 和预算后启动，避免相位通知与消息到达的竞争。

Worker 完成所分配任务后，应在 final 中简洁给出结论、具体证据引用和未覆盖项，然后结束当前 turn。
Final 会自动送达父代理，不必再发送一份同样的普通消息，也不应在完成后循环 `wait_agent`。
后续有具体工作时由 Root 用 `followup_task` 恢复；自然结束会释放执行名额，保留 Session 供后续使用。

Pi 单条 error 消息或 `agent_end` 之后仍可能重试/压缩恢复。Host 以 `agent_settled` 为这一轮结束依据，不另建模型重试
循环。普通邮箱内容不会把已结束的 Root 自动唤回。消费确认表示消息已进入 Session 上下文，不保证模型已理解或采纳。

`--max-agents N` 保持 CLI 的“非 Root 数量”含义。Root 始终预留一个名额，全树最多 N 个活跃 worker，包括正在等待的
worker。满额时 spawn 或闲置 worker 新任务立即返回资源不足，不排队等未来名额。任务结束/中断释放活跃名额，身份与
Session 仍可保留。

Worker 驻留进程也受 N 限制。需要加载新代理时，Host 可按 LRU 卸载无当前任务、无待投递邮箱或 IPC 请求的闲置 worker，
随后沿原身份和 Session 重载。模型可见 `list_agents` 只列已加载代理，Host 历史记录保留已卸载身份。这是本次 Host
生命周期内的恢复，不是通用跨命令 Task resume 或 Host 崩溃恢复。

每个 worker 轮默认最多 10 分钟、64 次执行工具调用；Root 与全树共享 256 次执行工具调用上限。协作控制和 `game_stop`
不消耗执行预算。Token/cost 是记录值，不是硬 token、费用、CPU、内存或磁盘配额。
Single Preview 的 256 次执行预算同样豁免 `game_stop`，耗尽执行预算后仍可请求清理。

Headless 在 Root 完成后关闭新任务入口、中断剩余 worker，并等待资源清理，再冻结最终 candidate；不会等所有 worker
自然完成后自动续跑 Root。未完成 worker 如实标记中断，其已写入共享 candidate 的修改不会自动回滚。

TUI 中 Root 闲置后，worker 可继续运行，普通邮件留到后续用户轮。`/agents` 查看状态，`/agents stop` 停止全团队当前工作。
Esc 保留 Pi 编辑器自身中断行为，后台 worker 结果仍保留。正常退出通过 Pi `session_shutdown` 等待清理与结果保存。
Root 的答复不证明它已检查后台 worker 此后完成的修改。

## 共享 candidate 与 Godot 证据

```text
ChronoRift Host
├── AgentSupervisor：任务树、邮箱、执行名额、驻留与独立用量
├── Root Pi Session + worker Pi Sessions / processes
│   └── 相同 coding / game / collaboration tools
├── 一个私有 candidate：全体代理共享，用户 checkout 不变
│   └── coding 操作与 launch 源码捕获共用 Host 锁
└── 每代理独立执行范围
    ├── IPC tools → Host broker → 现有 SRT controller
    ├── 临时目录、执行记录、取消范围
    └── 启动时固定源码的 Godot stage
```

所有代理完成的修改立即对其他代理可见，没有 agent-owned candidate 或显式 patch 导入步骤。Coding 工具在共享 candidate
锁下串行执行，launch 源码捕获使用同一把锁，避免边复制边被其他工具修改。模型请求和各自 Godot execution 可并行；
长 coding 命令也占用共享锁。锁不保证多次 read/edit 间的业务事务，也不自动解决覆盖冲突，仍须协调写入范围。

每次 `game_launch` 固定当时源码并使用独立 stage。Native import 可在另一个一次性可写副本中进行；输出校验后才构建
源码只读的运行 stage。源码完整性、路径/链接检查、禁网与 Host 凭据隔离保持生效，沙箱失败不会降级为非沙箱执行。
每个代理只能控制自己绑定的 execution 与临时资源。

已启动游戏不会随共享 candidate 后续修改而更新。Observation 只属于记录的 source/build/execution；验证新修改需要
新建 execution。每代理同时最多一个存活 Godot execution，团队可同时运行多个。`completed` 仅表示 Pi Loop 结束，
共享修改和成功测试都不自动构成最终修复结论。

## 结果与验证边界

普通 Preview 输出 `preview.v2.json`；当前多代理输出 `preview.v4.json`，包含 `workspaceMode: "shared"` 与 `agents`
摘要。私有 Task 目录保留：

- `records/agents.v2.json`：任务树、各轮结果、邮箱投递/消费记录、最后可用 Session 统计、用量归属与共享工具调用量。
- `records/agents/<agentId>/`：worker Pi Session、各轮 `result-<turnId>.json` 与自身 runtime records。
- `records/candidate.patch`：全体 writer 停止后提取的最终共享 patch，经过 round-trip 校验。

最小性能记录不包含工具参数或模型正文。每个代理的 Pi model request 在 SDK stream function 边界记录
`startedAt`、`finishedAt`、单调时钟耗时和结束状态，保存在 Session 的 `chronorift.model-request.v1` 条目及结果
`modelRequests` 中。这是 Pi 请求边界，不是每次内部 HTTP 重试或纯模型计算时间；未结束的请求保留空结束时间。
Worker turn 的 `settledAt` 是 Host 收到 Pi 结束结果的时间，`finishedAt` 还包含该轮资源清理。

Coding 工具记录 `requestedAt`、`lockRequestedAt`、`lockAcquiredAt`、`finishedAt` 和单调时钟
`workspaceLockWaitMs`；未拿到锁的失败或取消仍保留实际等待。Single 的文件位于 Task 的
`records/performance.v1.json`，Multi Root 位于 `runtime-records/performance.v1.json`，worker 位于
`records/agents/<agentId>/runtime/performance.v1.json`。这些记录用于量化锁等待，共享 candidate 锁继续保留。
不同代理的等待或请求时间可能重叠，不能把累计耗时直接当作关键路径耗时。

实验汇总器 `scripts/godot-multi-agent-pilot/summarize.mjs` 派生 worker spawn、首次父消息、settled，以及 Root
首次 edit/write、最终运行验证和 final response 的时间。首次消息不保证已交付完整结果；最终运行验证要求最后一次
edit/write 后的成功 `game_launch`，后续 query/stop 必须属于同一 execution 并成功，业务错误不能仅凭 SDK 工具完成
当作成功。Shell 写入需要单独审阅。可传入新的输出目录保存修正汇总，已有文件不会覆盖；原始记录继续保留。

Worker 轮结果不声称拥有独立 patch。最终共享 patch 可能包含 Root 未单独审阅的修改，仍需在精确候选上独立验收。
无法完成清理或提取最终 patch 时，V4 的 `candidateSourceChanged` 为 `null`，CLI 明确显示 candidate 未冻结，不能当作
“源码未变化”。Preview 自身不持有隐藏验收 oracle。

Pi 用量是累计值，汇总只计每个 Session 最后可用快照，卸载/重载不重复相加。继承背景不复制父请求费用；新 Session
处理背景产生的真实输入 token 仍归自己的请求。Worker 最后一轮被取消、超时或未正常完成时，即使有统计快照，worker
用量仍标记 `incomplete`；Root 未正常完成或任一 worker 不完整时，`reportedUsage.incomplete` 也为 `true`。已有快照可以
内部对账，但不能据此认定取消中的 provider 用量已经收齐。SDK cost 是模型价格表估算，不能替代 provider 账单。

离线测试以真实 Pi 与 faux provider 验证批量邮件、迟到 final、busy followup、取消重送、重试/压缩与用量归属；Host
测试覆盖任务树、名额、等待、驻留和 IPC。共享 candidate/Godot 验证覆盖修改可见性、固定 stage、独立执行与取消。
这些测试不证明在线模型会合理分工，也不证明 V2 更快或更便宜。

[Adaptive Multi 实验](case-studies/adaptive-multi-v1.md)保留两轮开发对照和一次 holdout：部分 Root 工作可被替代，
但 holdout 仍出现重复调查、延迟交付和更高耗时/费用。共享锁等待很小，没有据此移除锁。

旧 `agents.v1.json`、Preview V3 与 [Single/Multi Pilot](case-studies/single-multi-pilot.md) 属于当时的独立 candidate
实现，保留历史原记录；其耗时、费用和结论不能归到当前 V2。

## 设计来源

协作工具、任务树、queue-only/task 区分及生命周期参考了公开
[openai/codex 固定提交 `1715e55076737158ba61d43158ede504de6d4ce1`](https://github.com/openai/codex/tree/1715e55076737158ba61d43158ede504de6d4ce1/codex-rs/core/src/tools/handlers/multi_agents_v2)，
其源码采用 [Apache-2.0 许可证](https://github.com/openai/codex/blob/1715e55076737158ba61d43158ede504de6d4ce1/LICENSE)。

ChronoRift 用 TypeScript 与 Pi SDK 适配这些设计，未逐行复制 Rust Agent Loop，不声称与 Codex 产品内部实现完全等价。
Pi 完整响应/工具批次投递边界、文本 fork 限制、现有 CLI 名额参数、SRT 与 Godot staging 都是这里实际实现的边界。
显式换模型时的默认 thinking 继承也与该 Codex 提交的目标模型默认 effort 选择不同。
