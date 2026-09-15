# Godot Capacity Multi v1：提高预算后的真实功能对照

2026-09-14。预算提高后，PR180 的 Single 与当前 Adaptive 都自然完成，独立验收均为 **37/37**，两次离线评分一致。Single 用时 **40 分 52.522 秒**，Adaptive **41 分 29.541 秒**，相差 **+37.019 秒（+1.51%）**。本次没有证明协作加速。

Adaptive 创建了 3 个 worker，但 Root 自行将三项任务都限定为只读调查。Worker 没有写入源码，Root 完成全部实现，coding 调用 **220→218**，记录 Root tokens 反而增加 **10.5%**。团队记录 tokens 为 Single 的 **2.17 倍**，SDK 已报告费用为 **1.86 倍**。Worker 提供了有用的 review 线索，但没有接走一个完整实现范围。大预算解决了这次截止取消问题，当前分工没有把任务的并行交付空间转化成速度优势。

筛选了 18 个现有 PR，只有 PR180 通过完整资格检查。因此“多个可靠任务”和新 holdout 尚未实现；本批仅 **2 次模型运行**，没有根据结果追加重跑或改变策略。其他候选的阻塞和证据边界见下表。旧实验的失败与不确定结果保留，不参与本轮耗时基线。

| 指标                                             |                          Single |                       Adaptive |
| ------------------------------------------------ | ------------------------------: | -----------------------------: |
| 独立验收（每份最终候选两次，无模型调用）         |                   37/37，均通过 |                  37/37，均通过 |
| Root 结束状态                                    |                       completed |                      completed |
| 端到端耗时                                       |                      2452.522 s |                     2489.541 s |
| SDK investigation 区间                           |                      2438.294 s |                     2475.023 s |
| 团队记录 tokens（含 cache read）                 |                      29,432,255 |                     63,908,975 |
| Root / Worker 记录 tokens                        |                  29,432,255 / 0 |        32,528,048 / 31,380,927 |
| input / output / cache read tokens               | 1,065,339 / 90,180 / 28,276,736 | 959,695 / 169,888 / 62,779,392 |
| SDK 已报告费用，USD                              |                0.886819，不完整 |       1.651392，观察范围内完整 |
| Root / Worker SDK 已报告费用，USD                |                    0.886819 / 0 |            0.840207 / 0.811185 |
| 实际 worker 数 / worker turns                    |                           0 / 0 |                          3 / 3 |
| Worker 自然完成 / 取消 / 超时                    |                       0 / 0 / 0 |                      3 / 0 / 0 |
| Root 工具调用（coding / game / collaboration）   |             317（220 / 97 / 0） |            283（218 / 57 / 8） |
| Worker 工具调用（coding / game / collaboration） |                               0 |          543（395 / 25 / 123） |
| Root 成功 edit/write 调用                        |                              97 |                            114 |
| Worker 成功源码写入 / 最终代码文件               |                           0 / 0 |                          0 / 0 |
| Root 最终修改文件数                              |                              23 |                             32 |
| 团队执行预算使用量                               |             281，telemetry 重建 |    664，与 supervisor 计数一致 |
| workspace lock wait 总和 / 单次最大值            |                        0 / 0 ms |           1147.155 / 47.117 ms |
| Root / Worker lock wait 总和                     |                        0 / 0 ms |           289.884 / 857.271 ms |
| Root / Worker model requests                     |                         239 / 0 |                      230 / 337 |
| Root / Worker model request 区间总和             |                  2196.677 / 0 s |          2340.256 / 1918.623 s |
| Root game_launch 领域成功 / 失败                 |                          36 / 8 |                         20 / 2 |
| 性能时间记录完整                                 |                              是 |                             是 |
| SDK usage 对账成功 / 观察范围内完整              |                         是 / 否 |                        是 / 是 |

Single 有一次 provider error：请求持续 **36.814 秒**，已经产生 459 个 thinking 字符，却报告零 tokens/费用。它随后在原 trial 内恢复并完成，未取消或重新启动 trial。因此 Single 完整 tokens/费用记为 `null`，上表只列 SDK 已报告小计；2.17×、1.86×不是实际总用量或账单比例。两组均未观测到 compaction/branch summary，不能把这一缺口归因于压缩。SDK 价格表逐条重算与所有 5 个 Session 的归属/末次快照对账一致，也不能补出未报告的 usage。

**Worker 实际交付与关键路径**

| Worker        | Root 实际委派                             | 已审阅 bash | 源码写入 | 首个主要结论后 wait_agent | 等待区间之和 |
| ------------- | ----------------------------------------- | ----------: | -------: | ------------------------: | -----------: |
| architecture  | 架构、两份示例路径清单，只读              |           7 |        0 |                         4 |     40.014 s |
| api_research  | 菜单/关卡 API 清单，后续状态 review，只读 |          60 |        0 |                        20 |    200.051 s |
| test_strategy | 元数据/测试清单，后续受管运行观察，只读   |          44 |        0 |                        22 |    220.055 s |

冻结合同和实际 worker 工具配置都允许 `write`/`edit`，没有实验端统一只读限制。逐条检查全部 **171 条 bash**（Single 32、Multi Root 28、Worker 111），确认 Worker 的 bash 也没有隐含源码写入。最终 Multi 的 32 个文件全部由 Root 编写。两组临时自测文件与主场景切换都未留在最终 patch。

Root 在消费首批 worker 结果之前已经读过 34 个不同文件，这 34 个文件 worker 也读过。这是并发发生的重复调查，不能描述成 Root 收到完整交付后又完整重做。三次 `followup_task` 均送入仍在运行的原 turn，没有产生新的 worker turn。46 次 wait 都出现在首个主要结论之后；其中 27 次在首个 followup 消费前，19 次在后，API worker 的最后 8 次又发生在针对性 review 结论之后。还有 45 条严格的文件状态监视命令，不含混合代码/diff review。

Worker 后续确有必要的新工作，不能将首个结果到 settled 的整段时间都算浪费。两条具体有用链路可从消息、Root 修改和最终 patch 对应起来：一是示例复制后原路径判断失效的警告，随后 Root 为 loader 和两份 GameUI 显式设置状态 namespace；二是首次启动缺少存档的 ResourceLoader 错误，随后 Root 增加文件存在判断。后者两个 worker 的探测彼此重复。证据支持 review 影响了修改，不支持排他的因果判断或节省了多少分钟。

所有 worker 结束后，Root 仍执行 **126 次工具调用、54 次 edit/write**，直到 final response 又经过 **22 分 29.761 秒**。存在与 Root 实现重叠的有用 review 和运行观察，但没有独立完成的并行代码交付。Root 总工具数降低主要来自 game 调用下降；coding 调用几乎不变，不能用较少 Root 工具数宣称实现工作被替代。

共享锁累计等待约 1.15 秒，最大的单次等待约 47 毫秒。Root model request 区间累计约 39 分钟，是主要时间组成；它包括 provider 传输/排队，不能等同纯推理。当前最有证据的协作问题是未交接实现工作及重复调查/驻留，而不是锁竞争。46 次 wait 的 460.120 秒是跨 worker 的 Session 时间戳代理总和，彼此可能重叠，不能从端到端耗时直接扣除。本批未修改锁、prompt 或策略后再刷分。

**自验与独立验收的区别**

实际受管运行记录均使用 Godot 4.3；worker 找到过 4.7.1 路径，但没有执行它。Single 8 次 launch 失败中有 7 次导入失败、1 次 busy；Multi Root 有 2 次失败，Worker 也保留了中间导入/运行错误。领域操作成功只是该次操作完成，不证明整个功能正确。

两组自测都覆盖部分状态落盘、计数和颜色行为，也有缺口：Single 的 Play 计数探针清空目标场景路径，没有验证场景交接；reset 元数据探针可能优先选择重置前数据。Multi 的菜单自测在打印通过标记时伴有 null-tree/process-frame 错误，不能当作完整菜单流程通过；最后 reset 修改发生在最后状态语义测试之后，最后干净启动也没有重新覆盖 reset 语义。两组都没有证明完整的实体 UI 操作或独立应用进程重启持久化。

这些缺口与独立评分分开报告。所有 writer 停止后，冻结候选分别接受预先固定的 37 项行为验收，两次均通过。最终 patch SHA256：Single `dc5102a2aa29690a5cfdf91b9e7d7811213eb136c90ffe319ecf31a55d90cc0d`；Adaptive `96e314ec2f103421b6ac9d51aaad78b6d86a4600dd4464269d17b707a3e9adeb`。

**预算与实现**

本轮将实验配置从每题 20 分钟/团队 256 次执行调用提高为 **90 分钟/2048 次**，worker 每轮从 10 分钟/64 次提高为 **45 分钟/512 次**。两组保持 `openai-codex/gpt-5.6-luna/max`，共享相同任务、coding/game 工具和团队资源上限；Adaptive 额外启用当前协作能力，最多创建 3 个直接 worker，允许 0 个，worker 可以实现明确范围的代码。没有固定人数、角色或分工，也没有在本批根据模型结果修改策略、工具或验收器。

这些上限由 Host 显式设置并写入 Preview V5；不传新选项时保持原默认值。整体截止从父 Host 调用开始，包含子进程启动，SDK investigation 是更窄的区间。截止后的清理计入端到端耗时，但不是额外调查额度；超出 3 分钟清理宽限会请求终止，必要时再强制停止。更大预算增加完成机会，不保证任意任务都能完成。

另修复了 Single 清理失败仍可能提取补丁的问题。现在任一模式的 writer 未确认停止，都不能导出最终候选；四个回归分别覆盖 runtime/controller 清理失败与 V2/V5。该修复在模型启动前完成，没有调整共享 candidate 锁或扩展协作架构。

**入选任务与验收资格**

PR180 是完整的状态持久化功能：通用 typed Resource 存储、应用打开元数据、游戏次数与关卡进度、每关颜色，以及已安装项目和打包模板两份菜单/loader/reset 流程。存储层、游戏状态层、菜单与关卡接入存在可分别交付的代码范围；它们最终需要接口集成，是否真正并行由本次交付记录判断，不能仅凭任务体量推断。

使用完整合并前基线 `eea63dab5d96901cdae451473b446d56d7fcea85` 与参考 `e4549ad6e1bb32ecdfd1dfc24fd0e131ed4116be`，固定官方 Godot `4.3.stable.official.77dcf97d8`。受测输入是 259 个原文件的完整基线，Git 只有无父提交的快照、无 remote，299 个对象全部属于 HEAD 闭包。参考补丁、隐藏验收器和后续历史保留在准备端，未作为模型输入。

基线能正常导入，但首项行为检查因缺少公共状态 API 失败，其余 36 项未观测。参考实现 **37/37** 通过。修正旧验收器依赖参考控件名称/unique 标记的问题后，移动/重命名颜色控件、取消 unique 标记及将背景 ColorRect 换成 Polygon2D 的正向控制仍 **37/37**。四个语义错误变体分别只通过 **34/37、36/37、23/37、35/37**，覆盖遗漏游戏计数、进度不落盘、reset 保留状态、背景不随颜色更新。旧候选没有重新评分，旧不确定结果仍保留。

行为验收在原有 SRT 内使用固定 Xvfb 和 Godot 4.3，检查磁盘重新加载、状态隔离、计数/进度、真实场景信号及 reset。两组受测 Agent 的 Preview 仍为相同的 headless 工具。验收支持唯一的原生颜色选择控件及 ColorRect/Polygon2D 背景，其他或歧义结构需要 review；不以猜测判失败。观察的是原生属性与场景信号，未做像素比较、实体键鼠操作、导出打包、独立应用进程重启、损坏存档或迁移验证。

**候选筛选与限制**

本轮预筛选 18 个现有 PR：1 个 ready、13 个 blocked、1 个未完成匹配版本预检、3 个未入选。最终只有 PR180 进入模型名单。未能得到多个可靠任务，因此本批无法完成跨任务比较，也没有新的 holdout；筛选结果不能计作 Single/Multi 失败率或性能样本。

| 候选                                                                                   | 决定及证据边界                                                                                                                                        |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Template #180](https://github.com/Maaack/Godot-Game-Template/pull/180)                | ready；完整参考、结构变化正对照及四个负对照通过资格检查。                                                                                             |
| [Template #163](https://github.com/Maaack/Godot-Game-Template/pull/163)                | blocked；原参考在合法的加载完成/消费交错下替换整个游戏及 loader。9 项观察中 1 项失败；未测自然发生频率。早期 60/60 记录保留。                         |
| [GLoot #222](https://github.com/peter-kish/gloot/pull/222)                             | blocked；扁平继承数据 roundtrip 丢失属性，配对基线 3/3、参考 2/3。两边另有退出资源错误，不能把运行整体写成通过。                                      |
| [GLoot #99](https://github.com/peter-kish/gloot/pull/99)                               | blocked；4.0/4.0.4/4.2.2 诊断未得到完整参考导入正对照，未作功能胜负判断。                                                                             |
| [Pandora #114](https://github.com/bitbrain/pandora/pull/114)                           | blocked；完整原始项目在 4.2.2 与 4.1.1 私有诊断中仍有类型/自动加载错误；未进入目标功能验收。                                                          |
| [Template #192](https://github.com/Maaack/Godot-Game-Template/pull/192)                | blocked；实测替换主绑定会丢失原次绑定，2 项观察中 1 项失败。                                                                                          |
| [Template #228](https://github.com/Maaack/Godot-Game-Template/pull/228)                | 未就绪；声明 4.4，只有 4.3 诊断，不能据此判定匹配版本的参考功能失败。                                                                                 |
| [Statecharts #183](https://github.com/derkork/godot-statecharts/pull/183)              | blocked；完整项目有显式 .NET 依赖，当前 Runtime 不支持，静态准入排除。                                                                                |
| [Beehave #276](https://github.com/bitbrain/beehave/pull/276)                           | 未入选；生产修改范围较小。没有完整行为合格/失败结论。                                                                                                 |
| [Beehave #126](https://github.com/bitbrain/beehave/pull/126)                           | 未入选；静态生命周期合同与验收独立性存在疑点，未用 Godot 证实。                                                                                       |
| [Beehave #206](https://github.com/bitbrain/beehave/pull/206)                           | blocked；完整项目在 4.2.2 下有旧 GraphEdit/测试及示例类型错误；未完成声明 4.1 的完整预检，不作目标功能判定。                                          |
| [Dialogue Manager #764](https://github.com/nathanhoad/godot_dialogue_manager/pull/764) | blocked；显式 .NET 与自定义 EditorImportPlugin 超出当前 Runtime 支持范围，未执行功能测试。                                                            |
| [Template #302](https://github.com/Maaack/Godot-Game-Template/pull/302)                | blocked；静态检查发现 credits 链接信号接入被移除；另有 Timer 重复触发风险，未作动态因果确认。                                                         |
| [Template #67](https://github.com/Maaack/Godot-Game-Template/pull/67)                  | blocked；4.2.2 冷导入失败，另发现显示列表与持久化索引不一致的静态反例；没有完整行为套件。                                                             |
| [GLoot #313](https://github.com/peter-kish/gloot/pull/313)                             | blocked；完整 base/reference 在 4.7.1 导入通过，但参考忽略查询排除项，删除成功却返回 false，8 项观察中 2 项失败。                                     |
| [Truck Town #1295](https://github.com/godotengine/godot-demo-projects/pull/1295)       | blocked，功能结论不确定；4.7.1 完整导入通过，图形菜单流程两次超时；headless 菜单未进入 town，frame_post_draw 等待是可能原因。环境音静态疑点未被证实。 |
| [Physics Tests #1331](https://github.com/godotengine/godot-demo-projects/pull/1331)    | blocked；4.7.1 配对实际 UI 操作中，参考忽略 time scale 更新 TPS，基线符合原有语义。项目声明 4.6，未测试该版本；solver 参数没有物理效果因果结论。      |
| [Control Gallery #1315](https://github.com/godotengine/godot-demo-projects/pull/1315)  | 未入选；实现量主要是展示场景，生产脚本范围较小，未作完整运行预检。                                                                                    |

没有修改参考实现使其过关，没有拼接不相关功能，也没有把静态疑点写成已测得的运行缺陷。筛选的原始决定均在模型启动前形成；最终汇总表稍后整理既有证据，没有依据模型输赢增删名单。对应完整身份、证据级别及 hash 见 inputs/audit。

**冻结与结果口径**

开发 HEAD 为 `d19d7ccd8e0b9f116b8940efdc2aacadb5e313ac`。在 `2026-09-14T03:54:18.462Z` 冻结 414 个产品文件，组合 hash 为 `e0d0ec7fd482a19ea5648cdb243a3170d81112980dd596a0c0167fc29441c2bc`，并固定 982 个准备输入与依赖文件。HEAD 单独不能标识这些尚未提交的改动；报告同时保留组合 hash。顺序固定为 PR180 Single → Adaptive，各一次、全新 Session/candidate/state，未使用旧并发实验的 Single 耗时。仅有一题，无法在本批实现跨题组别顺序平衡。

独立验收在所有观察到的 writer 停止后，对每份最终候选运行两次检查确定性。这些检查不调用受测模型，不增加实验样本数。SRT 保持 fail closed、禁外网与凭据隔离；原始 checkout 保持不变，游戏操作按领域 outcome 统计。

SDK tokens 包含缓存读取；SDK 估算费用不是实际账单。Session 归属与累计值对账、计量完整性分别报告；取消或缺失 usage 不能靠成功对账补齐。模型请求区间包括传输和服务端等待，不等同纯推理耗时；跨 Agent 模型耗时、锁等待与重叠时长不能简单相加当作关键路径。准备过程及本次工程助手的模型消耗不包含在受测 Pi 团队统计中，实际总账单未知。

**工程检查与后处理修复**

最终 `corepack pnpm check` 通过 lint、format、typecheck 和 **135 文件/1164 测试**；真实离线 Godot 回归 **13 文件/20 测试**通过。实验脚本在稳定产品树上 **42/42**通过；更早一次冻结测试因准备时产品树变动失败的记录仍保留。最后针对报告入口修复运行了另一个范围的 **34/34** Node 脚本测试。两次 Preview V5 的真实 game_launch/query/stop smoke 也通过，使用 faux provider，没有受测模型调用。预算调整、writer 清理与后处理没有改变沙箱边界，本轮未重复跑 SRT conformance；之前兼容性轮的 conformance 结果保持独立。

模型与四次独立评分结束后，报告 CLI 暴露出共享 pilot 遗漏 `summarize` import 的错误。先保存实际失败与两个失败回归，再用原有直接汇总器写入新的派生目录；随后补 import 和两个 CLI 回归。没有重新运行模型或验收。评分后的产品 hash 仍等于冻结值；最终只有这两个脚本文件在评分后变化，新产品组合 hash 为 `2d841979cb5cf5671b1f47bcfadfadd5a259a7ae7c24d7eb4ef8b94fae5a3337`。982 个冻结准备输入仍全部未变，15 份旧公开报告/数据及用户 AGENTS.md 均未改写。

下一批最值得检验的是明确实现范围能否真正交给 worker 并替代 Root 后续代码工作；本批没有测试这一策略变化。可靠任务池仍是限制：继续选择存在独立实现接口、参考全流程通过且语义负对照可拒绝的真实功能 PR，比单纯增加文件数或强制 worker 数更有信息量。应在新批次启动前重新冻结任务和策略，沿用足以完成的资源上限，不将当前失败样本改写为成功，也不把单次约 1.5% 的差异视为稳定性能结论。

本报告的公开数据为 [inputs.json](godot-capacity-multi-v1/inputs.json)、[summary.json](godot-capacity-multi-v1/summary.json)、[results.csv](godot-capacity-multi-v1/results.csv) 和 [audit.json](godot-capacity-multi-v1/audit.json)。Audit 包含每个 Agent 的模型请求/执行/锁时间、worker 生命周期、交付范围、评分断言、预算回执和证据 hash；不包含原始模型请求、命令参数、参考补丁、隐藏验收器或凭据。原始记录保留在私有实验目录。

历史记录：[Adaptive Multi 小任务实验](adaptive-multi-v1.md)、[真实功能预检 v1](godot-feature-multi-v1.md)、[兼容性与 20 分钟实验 v2](godot-feature-multi-v2.md)。这些记录没有作为本轮 Single 时间或费用基线。
