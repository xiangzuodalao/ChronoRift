# 有限 physics watch：一次真实 Agent 对照

2026-09-06（Asia/Shanghai）在 `feat/finite-physics-watch` 的
`b56d94e3253c8967bc2be6d36fe4db425aa31ee2` 上运行一次 A/B 对照。
**两组最终候选都通过独立验收。** B 在修改前通过 watch 取得了 A 没有取得的瞬时越界证据；
这没有转化为本次案例的成功率差异。B 用时较短，但工具调用更多，Pi 报告的 token 和 cost 明显更高。

本目录只增加案例源码、运行脚本、独立检查器及其离线测试。产品实现没有改动，旧案例和冻结记录没有改写。
原始运行资料保留在本机仓库外，未提交原始 Session 或模型请求：
`/home/vm/chronorift-case-runs/finite-physics-watch-20260905T190251Z`。
详细本地证据入口是该目录的 `report.md`。

**Bug 与观察顺序。** [project/capacitor.gd](project/capacitor.gd) 是专门编写的简单自动充能演示，
每 120 个 physics tick 放电，随后每 tick 加 7，容量为 100，无需输入。
原代码先判断是否充满，再执行累加：第 16 次节点 physics 回调把 98 加到 105，
第 17 次回调才恢复为 100。因此每个周期都有一个 tick 的越界，之后长时间正常。
这不是随机挑选的外部项目，也不是通过 getter 或工具调用才触发的故障。

[witness.mjs](witness.mjs) 在 Agent 运行前独立验证严格顺序：注册 256 条采样窗口 →
等待窗口实际停止 → 按 16 KiB 预算取完 9 页 → 查询到更晚 tick 的正常值。
它不调用模型，其结果没有交给任何一组 Agent。实际原始窗口记录了：

| sequence | physicsTick | processFrame | charge | elapsed_ticks |
| -------: | ----------: | -----------: | -----: | ------------: |
|       15 |          17 |           40 |    105 |            16 |
|      135 |         137 |          330 |    105 |           136 |
|      255 |         257 |          620 |    105 |           256 |

之后的 `game_query` 在 physicsTick 268、processFrame 648 返回
`charge=100, capacity=100, phase=ready`，对象身份相同；正常停止后完整保留 256 条记录，源码完整性检查通过。
watch 的实际阶段是 `physics_frame_signal_before_node_physics_process`：信号触发于节点 physics 回调之前，
此处看到上一轮回调留下的状态，**不是帧末采样**。sequence、节点自有计数、physicsTick、processFrame 和 Host 耗时各自保留。
等待依赖实际状态、序号和 tick 条件，有超时边界，没有用固定 sleep 猜测事件时机。

**对照约束。** [run.mjs](run.mjs) 组合现有 Preview 和真实 Pi SDK；调查策略由 Pi Agent 自行决定。
A 保留 `read/bash/edit/write/grep/find/ls` 与 `game_launch/game_query/game_stop`；B 只额外注册 `game_watch`。
两组可自由改代码、添加日志和测试。没有为 A 脚本化调查步骤，也没有禁用它的 coding tools。

两组从同一干净 Git fixture 启动独立 candidate、Session 和 agent 目录，先 A 后 B，各一次，
没有人工追问、结果筛选或失败重跑。共同配置为：

| 项目                 | 两组共同值                                                         |
| -------------------- | ------------------------------------------------------------------ |
| Provider / 模型      | `openai-codex/gpt-5.6-luna`                                        |
| 请求 / 实际 thinking | `max` / `max`                                                      |
| 每组预算             | 600,000 ms；现有 Preview 的 256 次共同工具准入上限                 |
| 初始源码 SHA-256     | `d1b6c6f1b78f7c58f77c8fb5e0f709145c383fedaab0de22cba4bb55bce386da` |
| Fixture commit       | `db3646e92ebb5015b9747cc659222763c158543f`                         |
| User prompt SHA-256  | `01aa8708b1061c0bdf91fb9df43408b9dc8c3f80677498dd56b34e7868a141f0` |
| 环境                 | Node 22.23.1；Godot 4.7.1；现有 SRT 沙箱                           |

没有额外设置 token 或金额上限；预算指相同的时间和工具准入限制，不代表实际花费相同。
初始 candidate 字节、共享工具定义、环境说明、coding appendix、Pi 加载资源及其哈希均记录并比对一致。
两组共同环境说明都移除了 watch 的说明行；B 通过额外的工具定义得知其能力。
模型访问只在 Host；coding 和 Godot 继续使用无网络沙箱、独立导入及只读运行副本。

相同 prompt 原文：

> 这个自动充能演示有时会短暂显示超过满容量的数值，稍后检查又正常。请调查并做最小合理修复，保证充能过程中始终 0 <= charge <= capacity，同时保留自动放电、按配置速率重新充能和满电保持行为；容量与速率可以配置。自行选择调查、修改和验证方式，允许添加日志或测试，并说明实际验证结果及未覆盖部分。

**实际 Agent 结果。** 耗时从每组 Preview 调用前到返回后计，包括准备与清理，不包括后续独立验收。
token 包含 Pi 报告的缓存读取；cost 是 Pi 的统计字段，不是账单或额外验收指标。

| 实际指标                 |     A：query 组 |   B：增加 watch |
| ------------------------ | --------------: | --------------: |
| 独立最终候选验收         |    3/3 配置通过 |    3/3 配置通过 |
| 总耗时                   |       275.732 s |       205.773 s |
| 首次修改源码             |       109.994 s |        76.279 s |
| 工具调用 / 完整结果      |         34 / 34 |         36 / 36 |
| Godot Executions         |               5 |               4 |
| `game_watch` 调用        |               0 |               8 |
| 非成功命令结果           |               1 |               2 |
| Pi input / output tokens | 38,449 / 10,592 | 342,270 / 7,786 |
| Pi cacheRead tokens      |         342,016 |       3,743,744 |
| Pi total tokens          |         391,057 |       4,093,800 |
| Pi reported cost         |     $0.02724052 |     $0.17895744 |

A 修改前唯一一次 query 在 physics tick 212 返回正常的 `charge=100, phase=ready`。
A 随后从代码找到延迟限幅问题，将累加限幅放到判断前，使满电当 tick 进入 ready。
它自行试过容量 10、速率 7、周期 20，并编写临时 `validation.gd` 手动逐 tick 验证，
通过 game tools 执行后删除临时测试、恢复场景。最终 patch 只改 `capacitor.gd`。

B 修改前 query 在 tick 180 同样正常，随后自主 start 256 条 watch。
第一次 read 返回 135 条（当时已采样 196 条，仍在采样，分页游标 `nextSequence=135`，记录编码字节 65,236），
其中 sequence 8 / tick 377 和 sequence 128 / tick 497 的 `charge=105`。
之后的 `game_stop` 工具结果直接交给 Agent 完整 256 条记录，包括 sequence 248 / tick 617 的第三次异常。
这些都发生在第一次 edit 之前；capacity 100 来自同一未修改 Execution 的前一次 query。
B 最终只把累加改成 `clamp(charge + recharge_per_tick, 0, capacity)`，保留下一 tick 进入 ready 的时序。

B 修复后默认窗口通过 read 取得 135 条，完整 256 条由 stop 返回；
另两个配置窗口分别是容量 23 / 速率 9 / 周期 20 的 128 条，以及恢复默认的 64 条，均无越界。
不能把某页的 `deliveryComplete:true` 解释成该页已取回窗口全部记录。
B 的正常 baseline query **位于 watch 之前**，它没有在该 Execution 的异常后再 query。
严格的“watch 留下异常，事后 query 已正常”由前面的独立 witness 验证；没有把操作者的结果算作 Agent 观察。
B 的最终文字未引用 baseline 异常，工具轨迹证明它收到证据，不能据此断言证据决定了它的推理。

**独立验收。** [check.mjs](check.mjs) 和 [independent-check.gd](independent-check.gd)
在两次模型调用前冻结并记录哈希，未放进 candidate，也未向 Agent 提供；不读取最终文字作为判定。
检查器在三个独立场景实例的 `_ready` 之前设置容量 / 速率为 100/7、40/6、1/2，周期均为 120。
每组检查 360 次节点回调，共 1,080 条记录，检查真实电量上下界、配置速率、重复放电、满电保持、
完成周期数、对象身份、连续 tick 与 physics processing。
检查器的 physics priority 为 1,000,000，在待验节点回调之后读值，独立于 watch observer。
验收允许满电当 tick 或下一 tick 切换 ready，这一容差在看到最终 patch 前已固定。

开发期控制实验实际通过 SRT/Godot 执行：原始 bug 三组均失败；正确按 capacity 限幅通过；
硬编码上限 100 在非默认容量失败；禁用 physics processing 失败。
两组原始最终 candidate 随后都通过同一检查器，未人工修补。
额外对两个最终候选执行同长度的 256 条 witness 窗口，各完整取回 9 页、没有越界，
事后 query 正常，源码完整性和清理均通过。

**失败与局限一并保留。** A 一次、B 两次 bash 命令失败：两组都遇到外部 diff 命令错误（128），
B 还把 `--no-ext-diff` 放到 Git 全局选项位置导致 129；之后自行纠正。
所有 70 个 `tool_execution_end.isError` 都是 false，故 [summarize.mjs](summarize.mjs)
同时检查实际命令结果的 `[Command failed; exitCode=…]`，没有把它们计为成功。
A 的 `godot` / `godot4` PATH 探测失败，由 `|| true` 掩盖为退出 0；两组 coding PATH 相同，Godot 通过现有 game tools 可用。
A 的临时验证输出 PASS、退出 0，同时 stderr 有 ObjectDB 泄漏警告及 `1 resources still in use at exit` 错误；
该次自测存在清理问题，其最终文字未披露，不能用 PASS 替代独立验收。
B 有一次自动 compaction；两组没有 provider 重试事件、未完成工具或 Preview 调用失败。

案例准备也保留了两次失败：最初试图把检查器放进受限 overlay 被 staging 拒绝；
控制实验脚本第一次使用沙箱不可见的 nvm Node 路径，退出 127。
随后使用现有 `sourceFiles` 注入和沙箱可见的 Python 完成准备，未改产品策略或绕过沙箱。

本次 B 耗时约少 25.4%，但 token 约为 A 的 10.47 倍，reported cost 约 6.57 倍，
因此不能概括成整体效率胜出。只有一个专门编写的简单案例、每组一次、固定先 A 后 B，
模型随机性、缓存和服务延迟都未控制；没有统计显著性或因果效果估计。
A 成功说明源码分析和自主测试足以修复这个 bug；B 实际读到短暂状态说明有限窗口能增加调查证据。
它不证明 watch 是修复的必要条件，也不证明复杂项目、其他模型或未采样窗口具有同样收益。
独立验收只覆盖上述正容量、正速率配置和有限 tick；不覆盖所有配置、恶意规避检查器或回调内部更短的瞬态。
没有新增输入控制、checkpoint、replay、ProjectAdapter、历史数据库或产品接口。

**验证与复现。** 本次已运行产品 offline 949/949、Godot 20/20、SRT conformance 13/13，
独立 typecheck 通过；案例 Node 离线测试 15/15 通过。
`corepack pnpm check` 的 lint 通过，但全库 Prettier 被三个已有的无关未跟踪文件阻塞：
`docs/assets/chronorift-system-architecture.archify.json`、
`docs/assets/chronorift-system-architecture.html`、
`docs/assets/chronorift-system-architecture.visual-check.html`。未修改它们。
Godot 测试在现有 SRT coding sandbox 中运行，未使用未隔离的回退。

以下命令从 ChronoRift 根目录执行。需要已安装的固定依赖、Node 22、Godot 4.7.1、可启动的 SRT/bwrap 和 socat。
`run.mjs` **会执行两次真实模型会话**，需要主动选择运行及已有 Host 认证；离线测试和检查器不会调用模型。
输出目录必须是新的，并位于项目和 ChronoRift 仓库之外。

```bash
node --import tsx --test docs/case-studies/finite-physics-watch/*.test.mjs

# 创建独立、干净的 fixture 快照；CASE_ROOT 指向本机新建的仓库外目录。
mkdir -p "$CASE_ROOT/source"
cp -a docs/case-studies/finite-physics-watch/project/. "$CASE_ROOT/source/"
git -C "$CASE_ROOT/source" init -b main
git -C "$CASE_ROOT/source" add .
git -C "$CASE_ROOT/source" -c user.name='Case fixture' -c user.email='fixture@localhost' commit -m 'Freeze capacitor fixture'

node --import tsx docs/case-studies/finite-physics-watch/check.mjs \
  --project "$CASE_ROOT/source" --godot-bin "$GODOT_BIN" --output "$CASE_ROOT/baseline-check"
# 原始 bug 预期退出 1、assertions_failed；requires_review 不能算 bug 验证通过。

node --import tsx docs/case-studies/finite-physics-watch/run.mjs \
  --project "$CASE_ROOT/source" --godot-bin "$GODOT_BIN" --output "$CASE_ROOT/pair"
node --import tsx docs/case-studies/finite-physics-watch/summarize.mjs \
  "$CASE_ROOT/pair" "$CASE_ROOT/analysis"

# 分别使用 pair/A 和 pair/B 的 preview-result.json 中的 workspaceDirectory。
node --import tsx docs/case-studies/finite-physics-watch/check.mjs \
  --project "$CANDIDATE" --godot-bin "$GODOT_BIN" --output "$CASE_ROOT/final-check-A"
```

`witness.mjs` 导出 `captureWitness({ project, godotBin, output, expectAnomaly })`：
原始 fixture 传 `true`，最终候选传 `false`；它通过现有运行时管理启动、采样、分页、查询和清理。
`pair/{A,B}/events.jsonl` 保留全部实际事件；`analysis/{A,B}-tools.json` 提取实际工具参数、结果、耗时和失败；
`analysis/{A,B}.patch` 是原始 candidate patch 的逐字节副本；Session、Execution、import/run 输出及初始配置均在各组目录。
`baseline-check/`、`{A,B}-check/` 保存独立判定与全部采样，`*-witness/` 保存实际调用和分页，
`development/` 保留控制实验及准备失败，根目录 `*-tests.log` 和 `pnpm-check.log` 保留验证结果。
事后审查修复了汇总脚本在两边数据都缺失时误报相同的问题，补充损坏输入和不完整 trace 测试。
重新生成的 `analysis-v2/` 与原汇总的本次实际指标完全一致；原 `analysis/` 保留。
这些资料留在本机用于审查，本报告没有将私有 Session 发布为仓库证据。
