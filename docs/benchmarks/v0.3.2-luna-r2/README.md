# v0.3.2-luna-r2 evidence workspace

本目录承载与历史 `v0.3.2-luna-r1` 分离的后继 evidence identity。r1 的 spec、tag、ledger 和已发布
`invalid` 报告保持不可变；本目录中的 008 也只记录已经发生的 canary，不授权 formal freeze。

## 当前状态

| 项目                     | 状态                         | 可验证事实                                          |
| ------------------------ | ---------------------------- | --------------------------------------------------- |
| Canary 008 C0            | `not_ready` / `not_eligible` | 三个 cells 已封存；存在两个独立 readiness blockers  |
| Canary 008 C1            | **未启动**                   | C0 未满足前置；没有 C1 report                       |
| r2 machine spec / tag    | **未冻结**                   | 008 不能授权 freeze                                 |
| r2 formal execution      | **未运行**                   | 没有可评价的 treatment aggregate 或 Gate            |
| 下一可用 canary identity | **009（尚未创建或运行）**    | 仅能在修复经过测试后使用新的 identity；不得复用 008 |

## Canary 008 C0 负结果

[C0-008](canary-c0-not-ready-008.json) 绑定干净的 implementation receipt：

- commit：`e00cba6cbe3e87e0e768af02284bdc2edb24a77a`；
- source hash：`a2c504f3e8a784b01ec1b880365bcb2f1690fbdbe3b6d19c45ecd9e77308a738`；
- report hash：`d1461034624816e2946a9e0f617c18a4ce9c76818230472d7faf5c96a7217caf`；
- readiness：`not_ready`；
- verifier prerequisite eligibility：`not_eligible`。

readiness 精确保留两个原因：

- `generic:failure:invalid_tool_flow`：generic 错误复制了 baseline execution ID，产生一次 tool error，
  没有形成可计分 proposal；
- `chronorift-full:source_receipt_missing`：full 没有调用 source tool，因此即使该 cell 的 Harness verdict
  为 `confirmed`，也不满足 canary 的 source-grounding 前置。

evidence-only cell 正常计分并输出 `inconclusive`；这不能抵消另外两个 arm 的前置失败，也不能把 C0
提升为 `ready`。008 C1 从未启动。008 的 C0 report 和 identity 均不得覆盖、恢复或拼接；后继只能在
针对上述行为的修复通过测试后使用新的 009 identity。009 尚未创建或运行，因此当前没有新的 hardened
C0/C1、machine spec、freeze tag、formal execution 或产品 Gate 结果。

### Partial-failure 可观测性审计

008 的不可变公开 generic cell 还少报了一组已经发生的事实：它记录 `sessionPersisted=false` 且全部
flow counts 为 0，但本地持久化 JSONL 证明 FailureBrief、raw baseline、replay 与 experiment catalog
均已成功产生 receipt。这是独立的 partial-failure observability 缺陷，并非 `invalid_tool_flow` 的成因；
生成的 008 report 不作修改。后继实现已加入 typed partial-observation callback，并以一字符 baseline ID
损坏回归验证 Session、receipt、replay 与 `4/4/1/revision 3` 进度均能在原错误不变时保留；该修复不属于
008 implementation receipt，只能由新 identity 验证。

## 不变性边界

- 历史 r1 仍是已发布、完整性可验证但 aggregate 为 `null` 的 `invalid` 负结果；008 不改写它。
- `not_ready` 是 canary 前置结论，不是三组 treatment 的效果比较。
- 单个 `confirmed` verdict 不会覆盖缺失 source receipt，也不会使整个 canary 获得资格。
- 009 只是下一候选 identity；只有实际生成、运行和验证后，才能更新其状态。
