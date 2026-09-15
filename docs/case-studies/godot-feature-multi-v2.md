**兼容性修复后的真实 Godot 功能比较，2026-09-14**

运行兼容性已打通到完整 PR180，但本轮没有得到可用于完整 acceptance 胜负比较的样本。PR498、PR332 仍因参考实现缺陷及运行诊断 blocked；PR180 按冻结协议完成 Single、Adaptive 各一次，两者都触及 20 分钟预算。Single 的独立检查暴露了验收器对参考场景结构的额外假设，结论不确定；Adaptive 的候选存在明确的 GDScript 解析错误。旧负结果保留，没有调策略或增加模型重跑。

| PR180 指标                           |                                     Single |                             Adaptive |
| ------------------------------------ | -----------------------------------------: | -----------------------------------: |
| 冻结 evaluator outcome，两次一致     |                            requires_review |                      requires_review |
| 独立检查的实际含义                   | 13 项通过，24 项未观测；验收器结构假设阻断 | 候选导入出现解析错误，行为断言未运行 |
| Root 完成状态                        |                           budget cancelled |                     budget cancelled |
| 端到端耗时，包含启动及清理           |                                1,204.035 s |                          1,204.407 s |
| SDK 已报告团队 tokens，含缓存        |                                  7,721,471 |                           12,498,421 |
| SDK 已报告估算费用，USD              |                                 0.25225964 |                           0.39651564 |
| SDK 已报告 Root tokens               |                                  7,721,471 |                           10,045,146 |
| SDK 已报告 Worker tokens             |                                          0 |                            2,453,275 |
| 实际 worker / 峰值同时活动           |                                      0 / 0 |                                3 / 2 |
| Root 工具调用，含失败与协作          |                                        163 |                                  165 |
| Worker 工具调用，含失败与协作        |                                          0 |                                  158 |
| Root / Worker coding 工具调用        |                                    142 / 0 |                            143 / 147 |
| 累计 workspace lock wait             |                                        0 s |                             22.620 s |
| 其中 Root / Worker 等锁              |                                    0 / 0 s |                     8.045 / 14.575 s |
| worker 自然完成 / cancelled / failed |                                  0 / 0 / 0 |                            3 / 0 / 0 |
| worker turns，含 followup            |                                          0 |                      6，全 completed |
| Root / Worker 模型请求               |                                     82 / 0 |                             111 / 64 |
| 独立离线验收总耗时，不计入模型耗时   |                                   15.134 s |                             10.684 s |

表中的费用与 tokens 是**已报告的小计**。两组 Root 最后一个请求都取消且 usage 为零：Single 已输出部分内容，存在明确未计量消耗；Multi 的最后请求只持续约 7.65 ms，未见部分内容，不能推断其收费。会话归属、累计 usage 去重及 SDK 费率重算一致，不代表计量完整；完整 tokens、完整估算费用和实际账单均未知。已报告小计比率为团队 tokens **1.62×**、费用 **1.57×**、Root tokens **1.30×**，不能把这些比率当作完整账单比率。

两组耗时均被共同截止时间截断，不能据此说自然完成速度相同。也没有证据证明协作加速：Root 工具调用未减少，Root tokens 增加，且必要的最终验证没有完成。

**独立验收暴露的限制**

Single 的完整候选正常导入，通用存储、版本元数据、typed key、磁盘 roundtrip、计数/进度及 reset 的 13 项观测均通过。两个 scene family 的后续检查在 `%ColorPickerButton` 查找处中断，24 项没有观测。离线复核确认：baseline 没有此控件，reference 新增控件并设置 `unique_name_in_owner`；公开合同没有要求这个标记，且允许不同实现结构。Single 已新增控件、背景与颜色信号连接，只是没有 reference 的 unique 标记。因此这属于**验收器耦合参考结构导致的不确定结果**，不能将未观测项写成 Single 功能失败，也不能宣称它已全面通过。

这是准备端的遗漏：reference 和三个语义错误变体通过预检，并未证明检查器可接受不同结构的正确实现。冻结输入与四份最终验收记录原样保留，本批没有改检查器补分；结构无关的正向控制仍未覆盖。后续使用该 case 前需要修正并重新预检验收器，本报告不追认新的分数。

Adaptive 的 `LevelListLoader` 直接对类调用非静态 `GameLevelLog.callv()`，Godot 4.3 导入记录为 parse/compile error。两次独立检查均在此停止，未运行行为断言。进程 exit code 为零没有覆盖错误日志，严格 evaluator 保持 `requires_review`；这是候选代码的已证实问题。

**Worker 是否替代了 Root 工作**

Adaptive 自主创建两个调查 worker，后续又创建第三个；工具和合同允许 worker 写代码，但本次实际交付集中于流程清单、状态 API 建议及后续诊断，没有 worker 写入候选代码。Root 完成全部实现和测试脚本修改。Single 最终补丁涉及 29 个文件；Adaptive 涉及 138 个文件，其中有 96 个 `.uid`、6 个 `.import`、2 个 `.translation` 和 3 个临时诊断脚本，不能将这个文件数视为有效交付量。两个初始调查存在 24 个相同读取路径；Root 在各自首次报告前也已读过其中大量文件。路径重叠本身不能证明调查目的完全相同，但结合交付内容与 Root 后续继续设计、实现和验证，没有形成可证实的必要代码交付并行。

Worker 初始两轮完成后正常结束，没有循环 `wait_agent` 保持在线；后续工作由 Root 调用 followup。三个 worker 分别调用工具 78、77、3 次，完成 3、2、1 轮；候选 edit 共尝试 3 次，全部被共享预算拒绝。实际 3 个 worker 的 6 轮均自然结束，取消请求针对的是已完成 worker，没有活动 worker 被强制取消。自然结束解决了旧的 worker 空等问题，却不自动代表协作有效。

两个初始 worker 各用满 64 次执行额度，合计占团队预算的一半。最后一个获准的 coding 命令于 17:19:51.278 UTC 请求、17:20:11.316 UTC 结束；首次明确预算拒绝是 17:20:17.935 UTC 的 Root edit。没有独立 counter 增量事件，不能把首次拒绝时间当作精确耗尽时刻。Root 已发现解析错误，修复请求却被预算拒绝；之后的 followup、等待及第三 worker 也没有恢复执行能力，直到整体截止。工具调用表含被拒请求、协作和清理，因此总数可以超过 256；它不表示执行预算被绕过。首次拒绝后还持续 314.151 s，其中 Root 模型请求区间合计 215.698 s、`wait_agent` 97.302 s；后续 31 个请求新增已报告 3,554,001 tokens、SDK $0.08538204。这个已观测的预算耗尽及后续无效循环，比共享锁更值得关注。累计等锁只有 22.620 s，其中 Root 8.045 s，最大单次 14.533 s；跨 Agent 等待可能重叠，不能全部加到关键路径。本批保留共享锁，没有基于结果继续优化策略。

Root 第一次 write/edit 请求出现在 Single 开始后 387.170 s、Adaptive 开始后 291.353 s。更早动手没有转化为更早完成：Single 随后花费较多模型时间扩充自测与复核，最终仍未给出 final response；Adaptive 在解析错误未修复时失去执行预算。两者 final response 时间均为空。

Single 最后一次成功 Preview launch 位于 17:04:47.205 UTC，但启动成功不等于完整功能验证；该次运行仍有 10 条错误观测，自测期间的 headless 键位 API 等错误全部保留。Adaptive 的三次 Preview launch 均未成功，未观测到最终有效验证。Adaptive Root 与一个 worker 还通过 coding bash 使用了沙箱中可见的默认 Godot 4.7.1 做自测，和任务固定的 4.3 不同；这些结果不能作为 4.3 验证证据。两组暴露的 coding 环境与工具定义相同，真实 Preview 和最终 evaluator 始终使用冻结的 4.3，但这次版本使用偏离进一步限制了验证结论。

[固定输入](godot-feature-multi-v2/inputs.json)、[结果](godot-feature-multi-v2/summary.json)、[CSV](godot-feature-multi-v2/results.csv)和[审计](godot-feature-multi-v2/audit.json)记录本轮范围。此前[三个任务全部 blocked 的准备报告](godot-feature-multi-v1.md)与[Adaptive 小任务负结果](adaptive-multi-v1.md)保持原样。

**兼容性修复与仍有的限制**

普通 `override.cfg` 现在随完整源码保留，在暂存副本中与 Host inspection 设置合并。InputMap、覆盖后的主场景和用户 autoload 均有实际 SRT 回归；受管 autoload、自定义 override 链、禁用 override 和 `project.binary` 绕过继续拒绝。可选 `.cs` 源文件可以作为惰性数据保留，显式 .NET/native 依赖仍被拒绝；实际动态 C# 加载错误不能当作成功。

原生 CSV 翻译导入会在 CSV 同目录生成资源。现在仅允许原始 CSV 表头、导入声明、locale 和路径共同绑定的 data-only Translation / OptimizedTranslation；已 tracked 的派生资源须同时验证原声明与原二进制才可重新生成。普通源码、未知派生文件、链接、特殊文件及超限产物继续拒绝。当前只支持经过测试的 RSRC 5/6 数据格式和规范 locale，复杂别名和 RSCC 容器仍 fail closed。

导入使用 Host 空编辑器场景，以及只存在于一次性副本的插件/翻译加载设置；最终运行副本恢复原配置。自定义 EditorImportPlugin 仍不支持。Godot 4.2 冷扫描提前读取 editor texture metadata 时，只允许在源码完整性检查后进行一次复查，两次进程共享同一超时。首轮日志保存在 `importBootstrap`；其他错误、复查错误、截断、超时和取消都阻止成功。清理失败也保留真实导入进程和原错误。

Preview 另接受已验证的官方标准 Godot `4.2.2.stable.official.15073afe3`、`4.3.stable.official.77dcf97d8`，默认安装器及 legacy 路径继续使用 4.7.1。实际版本和二进制 hash 写入记录；预检、二次冻结和每次 launch 的 `.godot-version` 校验一致。没有调整协作 prompt、委派策略、共享 candidate 锁或模型参数。

**重新预检的完整任务**

| 任务                                                                         | 完整源码与资源导入                                                                 | 行为验收与决定                                                                                                                                                                                                 |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Game Template #498](https://github.com/Maaack/Godot-Game-Template/pull/498) | base/reference 导入与短暂 launch/query/stop 成功，源码未变                         | baseline 缺少目标；reference 的 11 项中观察到 10 真、1 假，并有 headless 键位转换错误，整体 `requires_review`。独立无错误选择诊断确认混合键鼠轮换漏掉第二个键盘绑定。**blocked**。                             |
| [Game Template #180](https://github.com/Maaack/Godot-Game-Template/pull/180) | 完整 base 的真实 Preview 工具成功，Godot 4.3，观察期间 import/run 无错误，源码未变 | 隔离 Xvfb 中 reference **37/37** 通过；baseline 因缺少状态 API 失败；三个错误变体分别 34/37、36/37、23/37，通过的参考断言出现新增失败。**ready**。                                                             |
| [Beehave #332](https://github.com/bitbrain/beehave/pull/332)                 | 保留全部 537 个原文件，包括可选 C#；资源导入复查通过                               | 完整 reference 观察到 72/74 通过，有限重复耗尽后等待主节点终止的两个结果仍错误；独立脚本退出另有 capture 错误。正常 Preview 工具返回 success，但运行日志有四条无活动调试器错误，因此仍需 review。**blocked**。 |

上表明确区分工具领域返回、进程诊断与完整功能 acceptance。未通过完整验收的观测不会转成通过样本；#332 旧组件投影不代替完整项目。没有修改 reference、删除原始源文件或收窄功能合同。

PR180 的完整菜单检查会调用 headless DisplayServer 不支持的键位转换 API。为保留真实菜单需求，独立验收改用固定 Xvfb 与 Godot 4.3：两者运行在同一个原有 SRT 网络命名空间，以内部 loopback TCP 通信，Unix socket 限制、外部禁网、凭据隔离及只读 source 均不变。Xvfb 未安装到系统，未连接 Host 显示；可执行文件、启动脚本及 832 个库/键盘/字体依赖文件已固定 hash。

该显示环境只用于独立验收，两组受测 Agent 仍使用相同的 headless Preview 工具。它不是新 Runtime 显示能力，也不保证任意菜单或窗口 API 可在 Preview 中运行。Xvfb/VSync 与原项目空 action 的非错误 warning 原样保留。没有进行渲染像素对比、导出打包、独立应用进程重启、损坏存档或迁移验收；菜单场景请求通过原有 SceneLoader debug 模式观察。

**冻结的比较协议**

开发 HEAD 为 `d19d7ccd8e0b9f116b8940efdc2aacadb5e313ac`。兼容性改动经离线验证后，在 `2026-09-13T16:44:52.877Z` 冻结，408 个产品文件的组合 hash 为 `fc6c07fcf80d2c6eaafa1bc23d5da5f1d1b9e7ddc3a50098e85ddfb589ef9253`。957 个准备输入、验收依赖与资源文件一并冻结。只有 PR180 入选，顺序为 Single → Adaptive，每组一次；没有采用旧并发实验的 Single 耗时。

两组均为 `openai-codex/gpt-5.6-luna/max`，20 分钟整体调查预算、团队 256 次执行调用，使用全新 Session、candidate 和 state。Adaptive 最多 3 个 worker、允许 0 个，每轮仍有 10 分钟/64 次限制。两组共享任务合同和通用 coding/停止/验证指令；Multi 仅增加当前协作能力和必要的共享写入说明。Worker 可实现明确范围的代码，未固定人数、角色或分工。

全部 writer 停止后才评分最终候选，每份候选独立验收两次检查确定性；这些离线检查不是额外模型样本。实验期间不修改产品、策略或验收输入，也不按输赢重跑。费用来自 SDK 估算，实际账单未知；团队总 tokens 包含 cache reads，不能直接视为输出代码规模。累计模型请求耗时、跨代理锁等待和重叠区间不能简单相加当作关键路径。

**工程验证**

`corepack pnpm check` 通过 lint、格式、类型检查及 **134 个文件/1130 项测试**；Godot 回归 **13 个文件/20 项**、SRT conformance **6 个文件/11 项**、实验脚本 **40 项**全部通过。还执行了三个原始项目的实际离线 Preview 冒烟、CSV 4.3/4.7.1 导入与只读加载、guarded/实际 C# 加载控制及 case 行为正负对照。校验日志 hash 见 audit。

所有旧失败及本轮准备失败都保留，包括 editor 忽略导入副本 override 设置、已 tracked 翻译最初未被识别为派生产物、二次冻结丢失版本导致的误报 source drift，以及不兼容的 headless /替代版本试探。它们不是受测模型结果。
