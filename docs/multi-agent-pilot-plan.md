**Godot Single / Multi 四路并发 Pilot 执行计划**

状态：本计划已于 2026-09-13 实施，四次模型调查及独立验收已完成。
实际结果、费用与未覆盖路径见 [Pilot 结果](case-studies/single-multi-pilot.md)；下文保留预先确定的执行设计。
本轮目标是验证真实项目上的并发执行、协作、用量汇总和独立验收。四次结果只用于流程验证与个案比较，
不能估计一般修复率或证明 Multi 普遍优于 Single。

**1. 固定两个任务与四次运行**

| Run ID        | 项目 / 任务                          | 配置              | 模型调查次数 |
| ------------- | ------------------------------------ | ----------------- | ------------ |
| `gn1-single`  | GN-1：平台触发区域宽于可见平台       | 1 Root            | 1            |
| `gn1-multi`   | 相同 GN-1 源码与问题                 | 1 Root + 3 worker | 1            |
| `city-single` | City Builder：空闲时重复重建建筑预览 | 1 Root            | 1            |
| `city-multi`  | 相同 City Builder 源码与问题         | 1 Root + 3 worker | 1            |

四个 Run 同时启动，各自拥有独立 Host 进程、state root、candidate、Session 和日志。
配置峰值为 4 个 Root + 6 个 worker，共 10 个模型会话；不是 4 个会话，也不是四次串行运行。
worker 是所属 Run 内的协作会话，不另算一次独立修复实验。

选择 GN-1 和 City 是因为两者已经有当前无 Adapter Preview 的真实调查记录及可复用检查器。
两题都是原始开源项目中的已有问题，本次不注入故障。仓库材料没有给出两题对应的上游已接受修复，
因此不将它们标成“两个经上游确认的历史 bug”。两题修复都较局部，适合发现协作开销和流程缺陷，
没有预设 Multi 必须获胜。Mob 留作后续备选，本轮不新增其 Preview 接入与验收适配。

| 固定项   | GN-1                                                                            | City Builder                                                                              |
| -------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| 上游     | [endlessm/moddable-platformer](https://github.com/endlessm/moddable-platformer) | [KenneyNL/Starter-Kit-City-Builder](https://github.com/KenneyNL/Starter-Kit-City-Builder) |
| Commit   | `e78b339500dec8e480b33723c4156bf9b74cd25c`                                      | `4535092b740b378b700efd9df9e27a631815b84a`                                                |
| Tree     | `9941cb045b3cd73c4554ca1de337a341b383590b`                                      | `528433a6580c8f48c9a1fcd7ddcae251a6f75c00`                                                |
| 运行场景 | 默认 `main.tscn`，保留 Global autoload                                          | 默认 `scenes/main.tscn`，保留 Audio autoload                                              |
| 独立验收 | 4 个平台的 sprite 数、solid / Area 尺寸、Area Shape 身份                        | 初始化、空闲 120 次 process、15 个模型双向切换和回绕、双键抵消、旋转和身份稳定            |
| 结论边界 | 初始几何与资源身份通过；不代表玩家触发及下落时序已验证                          | 66 个相关场景断言；不代表 66 次独立实验，也不衡量 FPS / CPU 或完整玩法                    |

来源与已有证据见 [GN-1 Preview](case-studies/gn1-preview.md)、
[City Builder Preview](case-studies/city-builder-preview.md)。它们是已知案例，本轮不声称盲测或未知项目泛化。

**2. 冻结任务输入与比较设置**

GN-1 两组共同目标，沿用现有案例原文：

> A falling platform can activate while the player is still outside its visible width. Investigate the project, make the smallest appropriate fix, and validate the candidate. You choose the investigation, edit, and validation strategy.

City 两组共同目标，沿用现有案例原文：

> 建筑预览在空闲时似乎反复重建。请调查并作最小合理修复：选中建筑不变时避免重复重建，同时保留初始化显示、前后切换及首尾循环时的正确更新。自行选择调查、修改和验证方式，并说明实际验证结果与未覆盖部分。

仅 Multi 附加以下协作要求；不提供原因、修改位置、参考答案或固定角色分工：

> 本次使用一个 Root 和三个 worker。开始调查时先创建恰好三个 worker，并让三个初始任务并行开展；由你决定分工和后续协作。可继续与这三个 worker 交流，不新建替代 worker。你负责最终候选的整合和验证；需要采用 worker 的修改时显式导入，并在最终候选上重新运行验证。

这比较的是“Single”与“要求使用三个 worker 的 Multi 工作方式”，包含协作工具和上述指令增量，
不是纯粹增加工具可用性的消融。Pi 仍决定调查、分工、消息、修改与整合，Host 不脚本化修复步骤。

| 配置                        | 本轮取值                                                                                                        |
| --------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Provider / model / thinking | 沿用案例的 `openai-codex / gpt-5.6-luna / max`，启动前验证本地模型注册与配置                                    |
| Worker 模型                 | 与 Root 完全相同，显式记录 resolved provider、model、thinking                                                   |
| Godot / SRT / Node          | 官方 Linux x86_64 Godot `4.7.1`、SRT `0.0.74`、Node `22.23.1`                                                   |
| Host 网络                   | 四组统一优先 IPv4；Root 与 worker 在模型客户端初始化前使用 `ipv4first` DNS 顺序                                 |
| 每个 Run 的调查时限         | 20 分钟，显式 `timeoutMs: 1200000`（CLI：`--timeout-ms 1200000`）；Root、worker、等待与 Root 续轮共用该调查期限 |
| 每个 Run 的执行工具上限     | 现有共享上限 256；Multi 的 worker 每轮另受 64 次执行调用上限约束                                                |
| Multi 配置                  | `maxAgents: 3`；CLI 等价为 `--multi-agent --max-agents 3`                                                       |
| 工具与工作区                | 两组均使用完整 Preview coding / game tools，各有私有 candidate 与独立只读 Godot stage                           |
| 运行方式                    | 全新 headless Session；无人工续轮、无跨 Run 消息或候选交换、无自动追加修复 Run                                  |
| Provider 重试               | 保留同一版本 Pi 的正常重试，记录请求失败、等待与用量；重试不当作新实验                                          |

Single 不使用旧案例的 `coding-only` arm，因为该 arm 会移除 game tools，混入第二个比较变量。
`maxAgents: 3` 仅限制同时存活 worker 数，不能证明实际启动三个；后处理检查实际创建数和初始任务的重叠区间。
未实现 1+3 的 Run 保留结果，标记拓扑要求未满足，不追加运行寻找合格样本。

时限不覆盖所有源准备、Session 创建、patch 导出与清理。分别记录 Host 端总耗时和调查时间。
本轮没有硬 token / 金额配额，固定时间不等于固定计算成本。

**3. 执行前只补四个小缺口**

第一，增加 case-local 薄 runner。单个子进程调用现有 `runProjectEnvironmentPreviewV2`，通过现有
`runPiTurn` 注入点保存 Root 的完整返回统计和必要事件，仍由 `runVNextPiTurnWithSdk` 执行真实 Loop。
参考 [City 旧 runner](case-studies/city-builder-preview/run.mjs) 的统计采集方式，
但不复用其删除 game tools 的 arm 逻辑，也不改写历史脚本或已有结果。Multi 正常使用现有 worker 进程。

第二，增加一个薄启动与汇总脚本：用 `child_process.spawn` 同时创建四个独立 Node Host 进程，
收集四个结束结果后运行验收和统计。不能在一个 Node 进程里 `Promise.all(runPreview × 4)`：
现有 SRT controller 默认使用进程内共享的 `SandboxManager`，一个 controller 的 reset 可能影响其他 Run。
等待四个子进程可用 `Promise.allSettled`，单个失败不取消其他正常运行。脚本不嵌入调查策略。

第三，GN-1 的 Godot 检查已通过 SRT，但保存候选检查器目前用 Host Git 应用候选 patch。
执行前将这一小段候选准备改为复用 City 检查器已有的 `controller.runCoding` 沙箱路径，保留原有断言、
输出和错误分类。无须创建新验收框架。City 检查器保持现有逻辑。

第四，落实用户要求的 IPv4 优先。四个 Root 进程显式使用 Node
`--dns-result-order=ipv4first`，并在创建 Pi Session 前检查 `dns.getDefaultResultOrder()`。
当前 [worker 启动器](../apps/cli/src/vnext/agent-worker-client.ts) 使用固定 argv，
不继承父进程 `execArgv`，且主动移除 `NODE_OPTIONS`；仅在外层设置环境变量会遗漏 worker。
在这个既有启动器中，只把 Host 已选定的受限 DNS 顺序转换为 worker 的显式 Node 启动参数，
继续禁止继承任意 loader、`NODE_OPTIONS` 或整组 `execArgv`。不让项目文件或模型消息决定网络策略。
用真实离线子进程检查 Root / worker 的 DNS 顺序一致，并保留现有环境净化测试。

IPv4 优先属于 Host 模型请求的连接设置，适用于四组，不改变 coding / Godot 沙箱的禁网策略，
也不修改系统级 IPv6 配置。`ipv4first` 是解析顺序偏好，不等于禁止所有 IPv6 连接；
若客户端或代理选择其他地址族，应记录实际可观察的连接信息，缺失时标为未知，不能宣称全程 IPv4。
若仍出现连接错误，单列 DNS / IPv6 路径问题、限流与 provider 错误，保存重试次数和等待时间。
外部源码与 Godot 下载在模型运行前完成；使用 curl 下载时显式 `-4`。

Single 的 `preview.v2.json` 当前不含 Root stats；Multi 的 `preview.v3.json` 指向
`records/agents.v1.json`，其中含 Root / worker 统计。薄 runner 负责统一保存、汇总，
不为本轮增加新的产品 wire schema、数据库、dashboard 或长期任务管理功能。

**4. 离线预检通过后，释放四路启动屏障**

准备两个固定版本的干净 checkout，放在 ChronoRift 工作树外，确认 source closure 不包含参考补丁、
检查器、旧调查记录或其他 Run 输出。冻结产品 commit 与实际源码 hash、两个 source hash、prompt、
checker hash、依赖版本和模型配置。审查 Root 与 worker 实际加载的 Pi 项目指令、skills 和 prompt 资源；
空 `agentDir` 不能单独证明没有继承全局 skills。

离线检查顺序如下：

1. 在固定 Node 下检查安装版本、Godot、SRT 和 namespace 前提；运行匹配改动的离线检查。
   代码准备好后运行一次 `corepack pnpm check`；候选准备边界调整后运行 `test:godot` 和
   `.github/scripts/run-srt-sandbox-conformance.sh`。不额外调用 live smoke。
   同时检查所有模型进程的 IPv4 优先设置，以及 worker 仍拒绝任意 Node loader 环境变量。
2. 每题分别对原版和已知正确补丁做 3 次独立验收，预期原版稳定失败、参考补丁稳定通过。
   这些是无模型的检查器控制，不增加模型调查次数；GN-1 原版只需满足其预期失败范围。
3. 复核错误修复能被拒绝，例如 GN-1 仅改变配置宽度、City 缺失初始化或切换更新。
   保留现有断言，检查器不能因本轮候选失败而被放宽。
4. 四个 Host 子进程完成只读配置检查后等待同一启动信号。四次 `runPreview` 入口目标偏差不超过 5 秒；
   同时记录实际进入模型 Loop 的时刻。若准备时间导致实际未重叠，报告并发未实现，不把配置当观察。

运行期间只采集必要的开始/结束事件、worker 轮次区间、模型失败/限流、Host CPU / 内存及 Godot 进程数。
四路共享机器和 provider 配额，因此本轮耗时属于并发负载下的观察；不能当作互不干扰的加速比。
保留已有沙箱禁网、最小环境、源完整性检查和取消清理。某一 Run 超时即正常取消该 Run；
若清理卡住则记录并处置其进程，不将超时后的补跑计作原始尝试。

本轮规划时已确认机器有 16 个逻辑 CPU、约 62.6 GiB RAM，固定 Godot 与 Node 二进制存在；
这些不证明十会话满负载已通过，也不证明 provider 支持十个同时在途请求。
当前 shell 是 Node 26.5，Corepack 不在默认 PATH；切换到
`~/.nvm/versions/node/v22.23.1/bin` 后可使用其已安装 Corepack。
Host 有相应认证配置，但服务端有效性尚未由本计划的 live 调用验证。

**5. 四路全部结束后，再验收最终 Root 候选**

独立验收使用 Preview 导出的最终 `candidatePatch`，先核对实际 bytes、SHA-256 和
`roundTripVerified`，在固定 baseline 的新副本重建候选。checker 与参考答案始终在 Agent 可读目录外，
不得把上一组或隐藏验收结果反馈给另一组。每个候选独立验收两次，检查结论是否一致。
两个验收同时运行时也使用两个独立 Node 进程；最多两个 checker 并行，且不与本轮模型调查重叠。

| 项目 | 已有入口                                                                                                                                           | 取结果的方式                                                                  |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| GN-1 | `check:gn1-preview --project PATH --godot-bin PATH --candidate-patch PATH`                                                                         | 读取返回的新 `.chronorift/gn1-preview-check-*` 目录；目前没有 `--output` 参数 |
| City | `node --import tsx docs/case-studies/city-builder-preview/check.mjs --project PATH --godot-bin PATH --candidate-patch PATH --output NEW_DIRECTORY` | 读取独立目录的 `result.json`、进程和完整性记录                                |

独立保留以下三个维度，不能用单一退出码覆盖全部含义：

- 流程：正常结束、超时、取消、provider 失败、工具/基础设施失败、结果缺失。
- 协作：实际 worker 数、任务重叠、消息/结果读取、patch 应用及冲突、Root 对新 candidate 的重新运行。
  没有发生 patch 导入时，该路径标记“未覆盖”；worker 可以只做调查，不强制制造多个 patch。
- 验收：`passed`、`assertions_failed`、`requires_review`；重复检查不一致单独标记不稳定。
  `completed`、worker 检查通过或 `applied` 均不能替代最终候选验收。

若候选删除必要场景导致 checker 报结构错误，保留 checker 原始 `requires_review`，
另根据实际 diff 和日志说明是候选回归还是环境问题。缺失 patch 或超时留下的中间 patch 不能算完成交付，
但可记录其可复查结果；本轮不以隐藏 checker 从多个 worker 候选中挑选最优者。

**6. 用量与费用逐会话对账**

记录每个 Session 的 input、output、cache read、cache write、total tokens 及 SDK reported cost；
保存实际解析的 model pricing metadata 与 hash，不保存认证内容。Root 续轮和 worker follow-up 的统计是累计值，
每个 Session 只取最后可用快照一次，Multi 总量为 Root 加三个 worker，不累加各轮累计值。

以安装版 Pi 的 `getSessionStats()` 语义从原始 Session 记录独立核对。不能只累加 assistant usage：
还要覆盖 compaction、branch summary 和带 usage 的 tool result，避免上下文压缩费用漏计。
按请求核查费用与适用定价档位，不能把整个 Session 的累计 token 一次乘以单价。

以下结果分开报告：

- **可核对的已上报用量**：Session 记录与最后累计 stats 一致，四路总量等于所有唯一 Session 之和。
- **SDK 估算费用**：来自本地模型价格 metadata，含缓存和可能的上下文定价档；不是 provider 账单。
- **可能缺失的用量**：provider 错误、取消、超时及无返回请求。即使 V3 的 `incomplete` 为 false，
  也要结合这些状态标记缺口；有 token 而价格为零时，不能解释成免费。
- **实际支付费用**：仅在有可对应的 provider 账单数据时填写；否则为不可核对。
  `openai-codex` 的订阅认证不能仅凭 SDK cost 推导实际扣费，本轮首先验证用量与估算的一致性。

金额对账采用预先固定的浮点容差；缺失的 token / cost 用 `null` 与原因表示，不补零。
不从模型最终回答中提取或相信费用。

**7. 完成标准与交付**

本轮模型运行严格为四次，不因 Single / Multi 谁赢而增加次数或更换任务。
所有条件通过才称“流程验证通过”；若某条路径未触发，明确标记覆盖不足：

- 四个独立 Run 有可核对的源码、配置、开始/结束时刻和互相重叠的调查区间；原 checkout 未变。
- 四个 Root 与六个 worker 均有 IPv4 优先配置的核对记录；实际地址族未观察到时明确标为未知。
- 两个 Multi 各实际创建三个 worker，并记录初始任务的并行区间；权限与运行记录按 Run / agent 隔离。
- 四个最终 Root 候选的 patch / 终态可追溯；已启动 Godot 与 worker 的清理结果完整。
- 两题原版与参考控制稳定，四个候选的独立验收均有实际结果或明确失败原因；重复检查结论一致。
- 用量汇总与独立核对一致，费用估算有价格来源，无法核对的请求与实际账单缺口明确。

交付一个简短结果页及 CSV，四行分别列：case、arm、终态、实际 worker 数、峰值活动 worker 数、
Host 总耗时、调查耗时、验收耗时、tokens、SDK 估算费用、用量完整性、候选验收、patch hash 和失败原因。
分别给出两个任务的配对结果；不做小样本显著性声明，不把运行记录整理成未经实现的性能承诺。
若候选验收失败但运行、用量与失败分类可靠，可报告流程对应部分通过和候选未通过。

原始 Session、请求、stderr 和运行材料留在四个私有本地目录，新增结果不覆盖已有案例或历史证据。
本轮只做上述薄脚本、必要的候选准备修正、四次运行与结果表，不增加发布、部署或大型 benchmark 管理工作。
