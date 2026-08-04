# Preselected Case Study: Physics Tunneling / Full / Repetition 1

> 状态：**formal execution complete；cell diagnostic failure**。本案例在运行前预先选择并提交，结果
> 来自 `case-physics-tunneling-full-r1.json` 与已验证的 `benchmark-report.v2.json`。它没有因失败而被
> 替换成其他 repetition。

## 预注册问题

冻结 Contract 要求 projectile fired 后 target 在规定 physics window 内被击中。baseline 在低 physics
TPS 下失败；隐藏 oracle 的机制标签是 `discrete_physics_tunneling`。候选单变量 intervention 中，
提高 physics TPS 是预期的机制证伪实验，改变无关 runtime control 不应修复结果。

本案例要回答：在不看到 oracle、真实 Fixture 名或真实源码路径的条件下，full arm 是否读取
Failure Brief/Capsule、执行 matching replay、选择一个单变量候选、读取 canonical comparison，最后
提交一个能被 Harness 证据门确认的正确机制？

## 运行身份

以下字段从 case bundle 原样填写：

| Field                 | Value                                                                                           |
| --------------------- | ----------------------------------------------------------------------------------------------- |
| Suite ID              | `benchmark-suite:485f541e8aac8e57da2e56de999c16319c0790248a3c644d923f994de940e7a5`              |
| Definition ID         | `benchmark-definition:91fea1ffe85a053691195e80b07f2265233a14919c71c674b9333bacf8799869`         |
| Execution ID          | `benchmark-execution:bd9b5d3a-5e3f-4e86-9d70-0098925aade5`                                      |
| Cell ID               | `benchmark-cell:7a6a5161357ff8019b09f0a0aa79db0f5b96d028203b94ab49ce2b628cb2162d`               |
| Attempt chain         | ordinal 1, `benchmark-attempt:6f4bd95deaf19c91be0ae6c90cd6e8abebc8d9a5a689c693d3615e4f5dcd01b4` |
| Freeze commit/tag     | `a27b8b7dc4a97fc399d9f687517ca6c442bff197` / `v0.3.0-benchmark-freeze`                          |
| Model metadata        | `GLM-5.2 [1M]`, context 1,000,000, max tokens 128,000, requested/mapped thinking `max`          |
| Cell status           | `diagnostic_failure / proposal_missing`                                                         |
| Evidence completeness | `partial`                                                                                       |
| Unavailable reason    | `diagnostic_attempt_has_partial_flow_evidence`                                                  |

## 冻结起点与观测

只记录 case bundle 中实际发布的值：

- baseline Contract outcome：`fail`；trigger tick 0，deadline tick 3，实际 `target.hit=false`；
- final state：`projectile.x=100`、`target.hit=false`；
- observation health：12 events，dropped/truncated events 皆为 0，backpressure 为 false；
- checkpoint 为 `fixture_semantic_l2`，覆盖注册 state provider、逻辑时钟、输入计划和
  `participant.case-03-state`；missing domains 明示 physics internals、timer/tween/coroutine、threads、
  unregistered RNG、resource caches 与 external services；
- baseline execution：`execution:formal:7babfa7cd7ec384100e9c5e4367d418fade9454891bffaa9ec236477f38882c2`；
- Capsule：`capsule:formal:aa8cf30910f424fffb785300fb236a142740058eeebc20e5d7b8b8aad316a4ea`，
  包含 11 个 causal events，`eventLossDetected=false`。没有 Capsule access receipt。

不要在这里粘贴源码正文、prompt 或未发布 Pi Session 内容。

## Agent 工具轨迹

若 case bundle 的 `evidenceCompleteness=complete`，按发布的 receipt/attempt 顺序填表，不润色或删除已
发布的无效调用。若为 `partial` 或 `unavailable`，先原样记录 marker 与 `unavailableReason`，再只列出 bundle
实际包含的 receipt/计数；不得从 prompt、模型摘要、progress count 或邻近事件重建、猜测或虚构缺失的
工具调用、顺序和 artifact ID。

本 cell 的 marker 是 `evidenceCompleteness=partial`，原因为
`diagnostic_attempt_has_partial_flow_evidence`。attempt 记录 1 次 baseline、0 tokens、0 tool calls；bundle
中的 access receipt、replay、candidate 和 comparison 都为空。没有可合法重建的 Agent 工具顺序。

| Ordinal | Tool/evidence kind | Returned artifact or receipt | Why it mattered                          |
| ------- | ------------------ | ---------------------------- | ---------------------------------------- |
| —       | No Agent tool call | None                         | 工具轨迹不存在，不能从 baseline 事件猜测 |

本次实际核对结果：

1. strict replay 未运行，无法比较 semantic digest；
2. intervention 未运行，没有 requested/realized physics TPS receipt；
3. candidate 为空，无法检查 checkpoint/trace/Contract/source/build comparability；
4. comparison 为空，没有 canonical first divergence；
5. proposal 与 access receipt 均为空，没有可重验的 Agent 引用。

## Proposal 与 Harness verdict

| Field                           | Value                                                    |
| ------------------------------- | -------------------------------------------------------- |
| Proposed mechanism              | `unknown`；proposal artifact 为 `null`                   |
| Candidate execution IDs         | `[]`                                                     |
| Comparison IDs                  | `[]`                                                     |
| Evidence access receipt IDs     | `[]`                                                     |
| Suspected virtual source/symbol | 未提供                                                   |
| Agent confidence                | `null`（仅描述，不参与裁决）                             |
| Canonical verdict               | cell score 为 `inconclusive`；verdict artifact 为 `null` |
| Gate blockers / next experiment | `proposal_missing`；没有 Agent 提交的 next experiment    |

cell 的 `groundedSuccess` 只能由 `mechanismCorrect && verdict == confirmed` 得出。若 replay、control
receipt、comparison、event health 或引用不足，即使模型 confidence 为 1 也必须记录
`inconclusive`；若机制错误却被 confirmed，必须记录 incorrect confirmation。

## 解释边界

本案例只支持 baseline 的运行时事实：projectile fired 后横跨离散 spatial samples，deadline 时
`target.hit=false`；它不包含 Agent 读取 Capsule 的 receipt、matching replay、realized intervention、
canonical comparison 或 diagnosis proposal。因此不能从本 case 审计 Agent 是否识别
`discrete_physics_tunneling`，也不能把冻结 oracle 当成 Agent 结论。

公开 cell 的 terminal code 是 `proposal_missing`。本地保留但未发布的 raw finished manifest 记录
`PiHarnessError/PROPOSAL_MISSING` 与 `Connection error.`；这能指导维护者先在 formal suite 外检查 Pi
连接路径，但不属于公开 bundle 可独立验证的 provider 根因。最小工程下一步是先用独立 live smoke
取得非零 token 的 Session；既有 first-execution selection 和本 case 不得重跑或替换。

时间相邻不是自动因果，单个 case 不能证明统计显著性、通用 Godot 支持或相对其他模型/产品的优势。

## 精确复现

使用 [reproduction.md](reproduction.md) 的 freeze checkout、formal、publish、verify 与 Gate 命令。
公开 case bundle 是脱敏审计视图；原始 run、Pi Session 和 ledger 留在被忽略的 `.chronorift/`，不提交
Git。
