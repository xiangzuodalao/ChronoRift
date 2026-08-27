# GN-1：共享 Area Shape 的外部项目回顾

GN-1 是一次基于 2026-08-20 本地运行、固定项目、固定源码、单个 matched pair 的回顾性案例。它展示 ChronoRift 的 Agent 如何把源码假设与 Godot 运行时几何、资源 identity 和候选 Build 关联起来；它不是通用修复率实验，也不证明某种工具配置总体更优。

> **先读证据边界：** 本页事后选择已有本地运行中的 R2 作为定性案例。R1 的 treatment arm 发出了 PE-A 不支持的筛选式查询，四次查询均返回 `unsupported_capability`；Agent 因而没有取得成功的 `platform_geometry` 语义观察，`semanticObservationUsed=false`，case-level `oraclePassed=false`。R2 省略了可选的 `filters` 和 cursor 字段，而不是发送空筛选对象。这个选择不是预注册实验，存在选择偏差，不能估计成功率、稳定性、因果关系或总体优势。

## 问题与边界

上游项目的 falling platform 可能在玩家仍位于可见宽度之外时被激活。GN-1 的 Host adapter 观察四个平台的 configured width、sprite 数量、solid collision width、Area collision width 和 Godot Shape identity。Agent 可以自行选择读代码、运行命令、编辑和验证顺序；Host 在 Agent 结束后用同一个项目专用观察面检查候选 Build，但该 postflight 不对 Agent 可见。

本案例没有上游 CI、maintainer 审阅或独立人工验收记录。下文的 `oraclePassed` 只是已检入 evaluator 对这一对运行记录的 case-level 布尔输出，不能翻译成“已修复”。

## 固定输入

| 项目               | R2 配置                                                                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| 上游源码           | [`endlessm/moddable-platformer`](https://github.com/endlessm/moddable-platformer/tree/e78b339500dec8e480b33723c4156bf9b74cd25c) |
| commit             | `e78b339500dec8e480b33723c4156bf9b74cd25c`                                                                                      |
| tree               | `9941cb045b3cd73c4554ca1de337a341b383590b`                                                                                      |
| provider / model   | `openai-codex` / `gpt-5.6-luna`                                                                                                 |
| thinking / timeout | `max` / `600000 ms`                                                                                                             |
| environment        | `coding`，instruction profile `task-id-v1`                                                                                      |
| 共享工具           | `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`, `godot_run`                                                              |
| treatment 新增工具 | `game_capabilities`, `game_launch`, `game_stop`, `game_query`                                                                   |

两个 arm 使用完全相同的用户 prompt：

> A falling platform can activate while the player is still outside its visible width. Investigate the project, make the smallest appropriate fix, and validate the candidate. You choose the investigation, edit, and validation strategy.

两个 arm 使用相同形式的 coding environment appendix 和 `Task context`；按照隔离要求，它们的 Task、workspace 和 Pi Session identity 各自新建且彼此不同。公开页不披露这些 opaque ID。

### Treatment 到底增加了什么

这不是一个“只有可执行函数、没有提示差异”的 tool-only 对照。Treatment 新增了四个 Pi `ToolDefinition`，每个 definition 同时携带 label、description、capability、严格输入 schema 和这一条 prompt guideline：

> Use game tools to test source-derived hypotheses against runtime observations when conclusions depend on realized geometry, physics, timing, entity or resource identity, runtime state, or history.

| 工具                | capability               | Agent 可见语义                                                                            |
| ------------------- | ------------------------ | ----------------------------------------------------------------------------------------- |
| `game_capabilities` | `game.capabilities.read` | 返回这个 Task 的实际 environment、adapter、runtime、tool、coverage 与 limitation          |
| `game_launch`       | `game.runtime.launch`    | 为精确 candidate Build 启动 adapter 声明的 target，并返回请求值与实现值                   |
| `game_query`        | `game.state.query`       | 查询有界的 entity、state、event、clock、coverage 或 runtime-error observation，不解释原因 |
| `game_stop`         | `game.runtime.stop`      | 停止 Task-owned runtime、封存 execution records，并返回实际 cleanup facts                 |

R2 的 `game_query` 使用 `pe-a-v1-narrow` 输入 schema：只允许 `schemaVersion`、Task/Execution identity、`select` 和 `limit`，不允许 filters 或 cursor。工具实现、metadata 和 schema 可从 [`project-environment-game-tools.ts`](../../packages/pi-harness/src/project-environment-game-tools.ts) 与 [`project-environment-game-tools.ts`](../../packages/agent-protocol/src/project-environment-game-tools.ts) 交叉检查。

## Agent 选择的 Treatment 路径

记录到的 game-tool 顺序是：

```text
game_capabilities
  → game_launch (baseline)
  → game_query (entities)
  → game_query (state: platform_geometry)
  → game_query (runtime_errors)
  → game_stop
  → candidate edit
  → game_launch (candidate)
  → game_query (state: platform_geometry)
  → game_query (runtime_errors)
  → game_stop
```

ChronoRift 没有把这条顺序编码成 mandatory workflow；这是 Agent 在该次运行中选择的调用序列。

## 可观察结果

### 运行时几何

单位为 px。Baseline 在两个 arm 中相同；identity 一栏只报告相等关系，不公开运行时 resource ID。

| Platform            | configured tiles | solid width | baseline Area width | coding-only candidate | ChronoRift candidate |
| ------------------- | ---------------: | ----------: | ------------------: | --------------------: | -------------------: |
| `Platform`          |                2 |         256 |                 768 |                   682 |                  256 |
| `Platform2`         |                1 |         128 |                 768 |                   682 |                  128 |
| `Platform3`         |                3 |         384 |                 768 |                   682 |                  384 |
| `Platform4`         |                6 |         768 |                 768 |                   682 |                  768 |
| Area Shape identity |                — |           — |        四个平台相同 |          四个平台相同 |     四个平台各不相同 |

Baseline 的 visual sprite count 和 solid collision width 已随 configured width 变化，但四个 Area collision 共用同一个 Shape resource；后写入的 6-tile 宽度因而出现在所有实例上。

两个候选 diff 都原样公开：

- [coding-only candidate](./gn1-platform-alias/coding-only-candidate.patch) 引入固定的 `PLAYER_COLLISION_WIDTH = 86` 并把它从 Area width 中扣除，因此共享 resource 最终在四个平台上都表现为 682 px。diff 还包含一次无关的 `main.tscn` 文件末尾空行；这里不清理或重写它。
- [ChronoRift candidate](./gn1-platform-alias/chronorift-candidate.patch) 在 resize 前调用 `shape.duplicate()`；随后观察到 Area width 为 256/128/384/768 px，且四个 Shape identity 各不相同。

以上是源码 diff 和运行记录中的 observable facts，不是对根因或修复正确性的最终裁决。

### Evaluator 输出

[`evaluation.json`](./gn1-platform-alias/evaluation.json) 是现有 [`evaluate-platform-alias-ablation.mjs`](../../scripts/evaluate-platform-alias-ablation.mjs) 对本地 R2 两个 raw arm 的原始 stdout；没有为作品页添加新 schema、validator 或 projection。

| 检查项                              | coding-only | ChronoRift treatment |
| ----------------------------------- | ----------: | -------------------: |
| configuration matched               |        true |                 true |
| command / Agent completed           |        true |                 true |
| patch non-empty                     |        true |                 true |
| candidate observation available     |        true |                 true |
| checkout clean / cleanup complete   |        true |                 true |
| candidate Build changed             |        true |                 true |
| candidate runtime errors empty      |        true |                 true |
| Agent 使用 `platform_geometry` 观察 |       false |                 true |
| geometry matched                    |       false |                 true |
| Area identity distinct              |       false |                 true |
| case-level `oraclePassed`           |       false |                 true |

两边 candidate state observation 的 `project_adapter_observations` coverage 都是 `complete`：5 条 observed records、0 dropped、0 overwritten，且 loss 数组为空。两边 cleanup receipt 均记录 process group 已终止、cgroup 未 populated、scope 已移除、Task storage 已 reconciliation；本次 cleanup 使用 `killSent=true`、`termSent=false`。

coding-only arm 没有 security event。Treatment arm 记录了 5 次 `capability_denied`，均为 invalid sandbox request，且 `sideEffectStarted=false`。它们没有被隐去，也不被解释为成功或失败原因。

## R1 为什么没有作为主案例

R1 与 R2 的固定 prompt、模型、thinking、timeout、外部源码及 arm 工具目录相同。R1 treatment 调用了带 entity/type/domain/clock-range filters 的 `game_query`；PE-A 明确只实现无筛选的第一页，因此四次查询均返回不可恢复的 `unsupported_capability`。Host postflight 后来仍观察到 candidate geometry matched 且 Area identity distinct，但 Agent 本身没有获得成功的 semantic observation；现有 evaluator 因 `chronorift_platform_observation_not_used` 将 R1 treatment 的 `oraclePassed` 记为 false。

R2 根据工具能力边界省略 optional filters/cursor 后取得成功 observation。事后选择这一轮能展示 intended interaction，但也正是必须披露的 selection bias；R1 不能被静默当作不存在。

## 公开材料与不可复现边界

| 文件                                                                      | bytes | SHA-256                                                            |
| ------------------------------------------------------------------------- | ----: | ------------------------------------------------------------------ |
| [`evaluation.json`](./gn1-platform-alias/evaluation.json)                 |  1292 | `b53785ccfcb3d57a2f82a86b4ab0228368f97ec593ab1d299a51847998e55732` |
| [coding-only candidate](./gn1-platform-alias/coding-only-candidate.patch) |  1266 | `845c61cca7c936a1b643ff0f13985b7d2c3574593ffa1e249d0de6e25160d289` |
| [ChronoRift candidate](./gn1-platform-alias/chronorift-candidate.patch)   |   651 | `81f3453f808b7623989e8a8f28e788e0bca3383861a37d0a4659d7d574b57120` |

这些 hash 只用于检查公开副本是否与本地来源逐字节一致，不是签名或外部 attestation。

R2 raw inputs 和完整 Pi transcript 不公开，因为它们包含 Host 绝对路径、Task、workspace、Session、operation identity、完整 tool payload 与 model prose。本文也不发布 token、cost 或 latency。缺少两个 raw arm 时，公开读者不能独立重跑 evaluator；公开 `evaluation.json` 应被理解为可审阅的精简输出，而不是可独立复现实验。

候选 patch 来自 MIT-licensed upstream source。版权、许可和“不代表上游接受或背书”的说明见根目录 [`THIRD_PARTY_NOTICES.md`](../../THIRD_PARTY_NOTICES.md) 与 [上游 MIT License](./gn1-platform-alias/upstream-MIT-LICENSE.txt)。

## 可以与不可以得出的结论

可以确认：在这个固定 commit/tree 的 R2 pair 中，配置匹配；Treatment Agent 使用了项目专用 runtime observation；两个候选产生了不同的 Area geometry 和 resource-identity observations；运行、清理、coverage 和 sandbox denial 都有结构化记录。

不可以据此确认：ChronoRift 总体优于 coding-only Agent、候选 patch 已被外部验收、共享 Shape 是所有类似 Bug 的根因、该结果能推广到其他 Godot 项目，或 R2 能代表长期成功率。最终 acceptance 仍属于上游项目测试、CI、maintainer 或独立 Eval。
