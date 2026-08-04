# Preselected Case Study: Physics Tunneling / Full / Repetition 1

> 状态：**pending formal execution**。本模板在运行前预先选择并提交；结果字段只能从
> `case-physics-tunneling-full-r1.json` 与已验证的 `benchmark-report.v2.json` 填入。即使 cell 失败、
> inconclusive 或执行不完整，也不得替换成表现更好的 repetition。

## 预注册问题

冻结 Contract 要求 projectile fired 后 target 在规定 physics window 内被击中。baseline 在低 physics
TPS 下失败；隐藏 oracle 的机制标签是 `discrete_physics_tunneling`。候选单变量 intervention 中，
提高 physics TPS 是预期的机制证伪实验，改变无关 runtime control 不应修复结果。

本案例要回答：在不看到 oracle、真实 Fixture 名或真实源码路径的条件下，full arm 是否读取
Failure Brief/Capsule、执行 matching replay、选择一个单变量候选、读取 canonical comparison，最后
提交一个能被 Harness 证据门确认的正确机制？

## 运行身份

以下字段在 publish 后从 case bundle 原样填写：

| Field                 | Value   |
| --------------------- | ------- |
| Suite ID              | pending |
| Definition ID         | pending |
| Execution ID          | pending |
| Cell ID               | pending |
| Attempt chain         | pending |
| Freeze commit/tag     | pending |
| Model metadata        | pending |
| Cell status           | pending |
| Evidence completeness | pending |
| Unavailable reason    | pending |

## 冻结起点与观测

只记录 case bundle 中实际发布的值：

- baseline Contract outcome：pending；
- trigger 与 deadline：pending；
- final target state：pending；
- observation health / dropped events：pending；
- checkpoint coverage 与 missing domains：pending；
- baseline execution / Capsule receipt：pending。

不要在这里粘贴源码正文、prompt 或未发布 Pi Session 内容。

## Agent 工具轨迹

若 case bundle 的 `evidenceCompleteness=complete`，按发布的 receipt/attempt 顺序填表，不润色或删除已
发布的无效调用。若为 `partial` 或 `unavailable`，先原样记录 marker 与 `unavailableReason`，再只列出 bundle
实际包含的 receipt/计数；不得从 prompt、模型摘要、progress count 或邻近事件重建、猜测或虚构缺失的
工具调用、顺序和 artifact ID。

| Ordinal | Tool/evidence kind | Returned artifact or receipt | Why it mattered |
| ------- | ------------------ | ---------------------------- | --------------- |
| pending | pending            | pending                      | pending         |

重点核对：

1. strict replay 是否匹配 baseline semantic digest；
2. intervention 的 requested physics TPS 是否有 matching realized receipt；
3. candidate 是否与 baseline 共享冻结 checkpoint、trace、Contract、source/build 与非干预 controls；
4. first divergence 与 outcome 是否来自 canonical compare；
5. proposal 引用是否全部属于同一 investigation 且确实被 Agent 读取。

## Proposal 与 Harness verdict

| Field                           | Value                         |
| ------------------------------- | ----------------------------- |
| Proposed mechanism              | pending                       |
| Candidate execution IDs         | pending                       |
| Comparison IDs                  | pending                       |
| Evidence access receipt IDs     | pending                       |
| Suspected virtual source/symbol | pending                       |
| Agent confidence                | pending（仅描述，不参与裁决） |
| Canonical verdict               | pending                       |
| Gate blockers / next experiment | pending                       |

cell 的 `groundedSuccess` 只能由 `mechanismCorrect && verdict == confirmed` 得出。若 replay、control
receipt、comparison、event health 或引用不足，即使模型 confidence 为 1 也必须记录
`inconclusive`；若机制错误却被 confirmed，必须记录 incorrect confirmation。

## 解释边界

完成后只描述 artifact 可支持的事件链、matched intervention 与 Harness verdict。时间相邻不是自动
因果，单个 case 不能证明统计显著性、通用 Godot 支持或相对其他模型/产品的优势。若结果为失败或
inconclusive，本节应保留失败事实并写出最小下一实验，不重新挑选案例。若 evidence 为 partial 或
unavailable，本节还必须明确哪些判断因 trace/receipt 不完整而无法审计，不能把进度计数写成完整工具流。

## 精确复现

使用 [reproduction.md](reproduction.md) 的 freeze checkout、formal、publish、verify 与 Gate 命令。
公开 case bundle 是脱敏审计视图；原始 run、Pi Session 和 ledger 留在被忽略的 `.chronorift/`，不提交
Git。
