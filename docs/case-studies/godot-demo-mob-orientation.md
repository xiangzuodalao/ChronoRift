# Godot Demo Mob Orientation：第二项目 runtime vertical slice（未晋级 Hero）

这次切片已经完成。它把 ChronoRift 的公共 ProjectAdapter V2 loader、managed runtime、Task sandbox、lineage 和
game tools 用在 GN-1 之外的第二个真实 Godot 项目上；Treatment Agent 在源码修改前后都实际查询了运行时状态，并产出
了连续三次通过独立 evaluator 的候选。

预声明 matched pair 的真实结果是：**coding-only 与 ChronoRift V2 都通过了 evaluator（各 3/3）**。因此本案例证明
第二项目的 runtime 产品路径跑通，但没有达到“coding-only 失败、Treatment 成功”的 README Hero 晋级条件，也不能
证明 ChronoRift 相对优势。

## 固定问题与输入

| 项目                  | 固定值                                                             |
| --------------------- | ------------------------------------------------------------------ |
| 上游项目              | `godotengine/godot-demo-projects/3d/squash_the_creeps`             |
| 父 commit             | `711822a319c4333a8740522f3c71e97783199fb0`                         |
| repository tree       | `e80cfdab1b1c2b917bd1fe65d5aeaec5cf292539`                         |
| 选中项目 tree SHA-256 | `c093f2f5a8ffebb2a7bee7b9d61e21034edeb4ad375fb41402c498cd41dca9df` |
| 对应上游修复          | `57daa67c23ffdfaf0eae8e933b8eec397441275e`                         |
| provider / model      | `openai-codex` / `gpt-5.6-luna`                                    |
| thinking / timeout    | `max` / `600000 ms`                                                |
| 共享工具预算          | 128 次 admission                                                   |

两个 arm 使用同一中性 prompt：

> Some newly spawned mobs are unexpectedly tilted, which can lead to inconsistent collision and movement behavior.
> Investigate the project, make the smallest appropriate fix, and validate the candidate. Preserve the intended
> randomized horizontal spawn direction and speed.

两组共享纯源码、prompt、模型、thinking、timeout，以及 `read`、`bash`、`edit`、`write`、`grep`、
`find`、`ls`、`godot_run`；共同 environment appendix 只含 opaque `taskId`。Treatment 的完整增量包括
`game_capabilities`、`game_launch`、`game_stop`、`game_query` 四个 tool definitions 及其 metadata，还包括两行
discoverability appendix：

> A prevalidated Project Environment V2 is available through the game_* tools.
>
> Runtime records are observations, not verdicts; choose your own investigation and validation order.

因此这是完整产品 intervention，不是 tool-only comparison，结果不能归因于单独的 game tools。运行顺序在模型调用前
固定为一次 `coding-only`，再一次 `chronorift-v2`；每组使用新的 Task、workspace 和 Pi Session。

完整输入与实现 hash 见 [`frozen-inputs.json`](./godot-demo-mob-orientation/frozen-inputs.json)。

## 落地的产品路径

- 项目专用 Adapter 通过公共 V2 manifest、loader、managed runtime 和 validated ring 运行，没有新增第二套 runtime。
- V2 manifest 允许诚实的 state-only projection；没有事件或 dynamic trace 的 Adapter 不再需要伪造记录。
- `game_query` 返回当前已验证 ring snapshot，空结果由 Agent 自行决定是否重试；不再等待与本 Adapter 不相容的固定 trace。
- `game_stop` 总是完成 runtime cleanup。缺少旧 PE-B durable capture 时，receipt 如实保留 `incomplete` 和 limitation，
  但不会把一次清理成功的 state-only execution 错判为 poisoned。
- persisted `succeeded` 仍沿用较窄的 PE-B evidence predicate；本切片证明 state-only query/stop 与 cleanup 路径，
  不宣称已完成通用 state-only evidence-success 迁移。
- Adapter 被动记录 Mob 的 `up_alignment`、`velocity_y`、`horizontal_speed` 和玩家/Mob 高度差，不修改游戏状态，
  不注入输入，也不替项目作“已修复”裁决。
- Agent 结束后，Host 才临时物化窄 evaluator；它在同一 Godot sandbox 中连续运行三次，随后删除，且不进入 candidate patch。

为让本机 Host 满足真实边界，本次使用固定 Node 22.23.1、Godot 4.7.1、固定容器 digest、bubblewrap、cgroup v2、
private cgroup namespace、1 GiB / 131072 inode 的 Task storage，并在 Task sandbox 内拒绝网络和 Host 凭据。Pi 凭据只
挂载到 Host 模型路径，Task command 与 Godot process 均不可见。

## Evaluator 资格控制

在任何正式模型运行前，同一个 evaluator 对三种固定输入得到：

| 控制                   | 连续结果 |
| ---------------------- | -------: |
| 父提交行为             |      0/3 |
| 人工缩减的最小目标修复 |      3/3 |
| 完整上游修复行为       |      3/3 |

最小目标修复保存在 [`minimal-target-fix.patch`](./godot-demo-mob-orientation/minimal-target-fix.patch)。Evaluator 不比较
候选与上游 diff 的文本相似度；它加载真实 Godot 项目并检查初始化后 Mob 的 orientation、垂直速度与随机水平速度范围。

## Treatment 实际选择的运行路径

正式 Treatment 记录到的 game-tool 顺序是：

```text
game_capabilities
  → game_launch (initial Build)
  → game_query (entities)
  → game_query (state)
  → game_query (events; error)
  → game_query (runtime_errors; error)
  → game_stop
  → candidate edit
  → game_capabilities
  → game_launch (candidate Build)
  → game_query (state)
  → game_query (runtime_errors)
  → game_query (entities)
  → game_stop
```

这条顺序由 Agent 自己选择，不是 ChronoRift 编码的修复 workflow。修改前的 state query 观察了 14 个 Mob：
`up_alignment` 为 `0.999998748–0.999999404`；候选 Build 的 query 观察了 5 个 Mob，`up_alignment=1`。
两次查询中 `velocity_y=0`，水平速度都在项目声明的 10–18 范围内。Initial 与 candidate observation 分别绑定不同
Build/Execution，candidate patch 只相对 Task-owned 纯源码 workspace 提取。

首次 execution 的 `events` 与 `runtime_errors` 查询返回 `operation_failed`；它们没有被隐藏或改写成成功。
候选 execution 的 `runtime_errors` 查询成功且返回零行。

## 正式 matched pair 结果

| Arm           | 独立 evaluator | Agent 使用的 runtime surface              | 本机端到端 wall time | Agent tool calls | total tokens | provider-reported cost | run / cleanup    |
| ------------- | -------------: | ----------------------------------------- | -------------------: | ---------------: | -----------: | ---------------------: | ---------------- |
| coding-only   |            3/3 | 1 次 `godot_run`，无 V2 game tool         |            123.275 s |               17 |       92,210 |            $0.01077896 | valid / complete |
| ChronoRift V2 |            3/3 | 1 次 `godot_run`，13 次 V2 game-tool call |            180.381 s |               36 |      421,461 |            $0.02348772 | valid / complete |

Treatment 的 total tokens、tool calls 与 provider-reported cost 分别约为 coding-only 的 4.57×、2.12× 和 2.18×。
这些 cost 不包含本机容器或 Godot 计算成本。两组都在预算内完成、产生非空 patch、通过三次 evaluator，source checkout
保持干净，cleanup 完整，Agent 没有错误。

当前 runner 没有写入显式 `durationMs`。表中 wall time 由正式输出文件从创建到完成写入的本机 filesystem timestamps
还原，覆盖容器启动、source materialization、baseline observation、Agent turn、postflight evaluator 与 cleanup；它是
端到端近似值，不是精确的 model 或 Agent-only latency。Treatment 比 coding-only 多约 57.106 秒（46.3%）。

Treatment 另有 2 次 `capability_denied` security event，均为 invalid sandbox request，且
`sideEffectStarted=false`；coding-only 没有 security event。它们不覆盖 evaluator 结论，也不能被解释为结果差异
的原因。

两个候选是同一个语义修复的不同写法：

- [coding-only candidate](./godot-demo-mob-orientation/coding-only-candidate.patch) 先创建
  `horizontal_player_position`，再将其传给 `look_at_from_position()`。
- [ChronoRift V2 candidate](./godot-demo-mob-orientation/chronorift-v2-candidate.patch) 在调用处内联同一个水平目标。

这解释了为什么两组都通过，但它不是模型行为的因果证明。

## 为什么没有晋级 README Hero

预声明规则要求 coding-only 为 0/3、ChronoRift V2 为 3/3，并要求 Treatment 在修改前使用 initial Build 的 runtime
observation。后两项满足，第一项不满足。Standalone evaluator 的原始 stdout 保存在
[`evaluation.json`](./godot-demo-mob-orientation/evaluation.json)：

| Gate                                 |      结果 |
| ------------------------------------ | --------: |
| coding-only accepted                 |      true |
| ChronoRift V2 accepted               |      true |
| Treatment initial-Build runtime used |      true |
| Hero promoted                        | **false** |

按照运行前规则，本次没有补跑、换 Bug、改 prompt、改模型或选择另一轮。这个诚实的 non-promotion 比挑选一个胜例更能
说明证据边界，但它不是比较优势结果。

## 公开材料

| 文件                                                                                  | bytes | SHA-256                                                            |
| ------------------------------------------------------------------------------------- | ----: | ------------------------------------------------------------------ |
| [`frozen-inputs.json`](./godot-demo-mob-orientation/frozen-inputs.json)               |  3533 | `3bd092887e974eb827eddd5397b515a7f4bd241ccade87c1738eef67afc6939f` |
| [`minimal-target-fix.patch`](./godot-demo-mob-orientation/minimal-target-fix.patch)   |   465 | `c7fad26f9b5ecb461a4fa7bd1db1654861de1b10fb20a477a57af0908cfdcbd6` |
| [`evaluation.json`](./godot-demo-mob-orientation/evaluation.json)                     |   508 | `68d799d8a869a20f3582815057f05159e8dabf6ae9c006b708b54028bb6e25c8` |
| [coding-only candidate](./godot-demo-mob-orientation/coding-only-candidate.patch)     |   601 | `87468f8bbf079abdcf3c447b01b1ce4116a894395f337a2edc895b3a1e2bb693` |
| [ChronoRift V2 candidate](./godot-demo-mob-orientation/chronorift-v2-candidate.patch) |   539 | `ef227866c26b30e8baf46dd38a9363a0b9f4aabe7a1323941ee70d75cf66d177` |

这些 hash 只检查公开 bytes 与本地结果是否一致，不是签名或第三方 attestation。Raw arm 与完整 Pi transcript 保留在
本机，不公开其中的 Host 绝对路径、Task/workspace/Session/operation identity、完整 tool payload 或模型 prose；没有 raw
arm 的读者不能独立重跑 standalone evaluator。

候选 patch 派生自 MIT-licensed upstream source。版权、许可及“不代表上游接受或背书”的说明见
[`THIRD_PARTY_NOTICES.md`](../../THIRD_PARTY_NOTICES.md) 与
[上游 MIT License](./godot-demo-mob-orientation/upstream-MIT-LICENSE.md)。

## 可以与不可以得出的结论

可以确认：ChronoRift 的共享 V2 runtime/sandbox/lineage 边界已在第二个固定外部 Godot 项目上实际运行；Treatment Agent
使用了修改前后的 runtime state；候选通过独立 Godot evaluator；失败的 tool response、sandbox denial、receipt
limitation、cleanup 和成本在本地 raw records 中保留，并在本页汇总披露。

不可以确认：ChronoRift 比 coding-only 更容易修复这个 Bug、结果具有统计意义、Adapter 能自动生成、任意 Godot 项目
已经支持，或候选已获上游 CI/maintainer 接受。这个案例应作为**跨项目 runtime vertical slice**展示，而不是 README Hero
或产品优势实验。
