# v0.3.2-luna-r2 evidence workspace

本目录承载与历史 `v0.3.2-luna-r1` 分离的后继 evidence identity。r1 的 spec、tag、ledger 和已发布
`invalid` 报告保持不可变；本目录中的 008、009 与 r2 machine spec 使用独立 lineage。

## 当前状态

| 项目                  | 状态                         | 可验证事实                                         |
| --------------------- | ---------------------------- | -------------------------------------------------- |
| Canary 008 C0         | `not_ready` / `not_eligible` | 三个 cells 已封存；存在两个独立 readiness blockers |
| Canary 008 C1         | **未启动**                   | C0 未满足前置；没有 C1 report                      |
| Canary 009 C0/C1      | `ready` / `hardened`         | 六个 cells 均 scored、mechanism correct、无违规    |
| r2 machine spec / tag | **已生成 / 本地冻结**        | annotated tag 固定包含 spec 的 freeze commit       |
| r2 formal execution   | **未运行**                   | `selected=false`；`executionId=null`               |

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
提升为 `ready`。008 C1 从未启动。008 的 C0 report 和 identity 均不得覆盖、恢复或拼接；后继使用全新
009 identity，其结果单独记录如下。

### Partial-failure 可观测性审计

008 的不可变公开 generic cell 还少报了一组已经发生的事实：它记录 `sessionPersisted=false` 且全部
flow counts 为 0，但本地持久化 JSONL 证明 FailureBrief、raw baseline、replay 与 experiment catalog
均已成功产生 receipt。这是独立的 partial-failure observability 缺陷，并非 `invalid_tool_flow` 的成因；
生成的 008 report 不作修改。后继实现已加入 typed partial-observation callback，并以一字符 baseline ID
损坏回归验证 Session、receipt、replay 与 `4/4/1/revision 3` 进度均能在原错误不变时保留；该修复不属于
008 implementation receipt，只能由新 identity 验证。

## Canary 009 hardened 前置

009 C0/C1 绑定同一份干净 implementation receipt：

- commit：`9217764b2dceb16ca8a5d1604c0bb7767d42b157`；
- source hash：`740ce58c6c566b2a6bd575b0597eaebfe63b9342fdb37e3e539b6099abba51f7`。

[C0-009](canary-c0-ready-009.json) report hash 为
`8282c8610149b1f7f1d2e96f68ab9c084afeb738472e4e50305981d33c1db544`；
[C1-009](canary-c1-ready-009.json) report hash 为
`ba6fb7183aea42e6b95687a65a94c5f5cacb0ef36a398dc990ccea78bede147e`，其
`prerequisiteReportHash` 精确等于上述 C0 hash。两份 verifier 均返回 readiness `ready` 与
`prerequisiteEligibility=hardened`。

六个 cells 均为 `scored`、mechanism correct、零 tool errors、零连续无语义进展结果、零 incorrect
confirmations，且每个 cell 都有 2 个 source receipts：

| Stage | Arm             | Verdict        | Tool calls | Game executions | Total tokens |
| ----- | --------------- | -------------- | ---------- | --------------- | ------------ |
| C0    | generic         | `confirmed`    | 7          | 3               | 63,799       |
| C0    | evidence-only   | `inconclusive` | 5          | 2               | 31,522       |
| C0    | chronorift-full | `confirmed`    | 8          | 3               | 74,071       |
| C1    | generic         | `inconclusive` | 7          | 3               | 94,825       |
| C1    | evidence-only   | `inconclusive` | 5          | 2               | 50,667       |
| C1    | chronorift-full | `inconclusive` | 8          | 3               | 107,345      |

这些结果满足 r2 的 hardened canary 前置，但不等同于 36-cell treatment aggregate 或产品 Gate。

## R2 freeze

[benchmark-spec.v3.json](benchmark-spec.v3.json) 固定：

- suite：`benchmark-suite:bbd73dedf76964618d0746e11609caa6d78dabe87eae26b7e3caf0ce8ae9d8e1`；
- definition：
  `benchmark-definition:6c073ede350ba0ceb902353b6dd701eae589453b2a0717b59e357ac9be26eb09`；
- subject hash：`5558e9e3582d38885d9f512583473ab07b849568141ee8d43df469489b8a8470`；
- runner hash：`8a154f3ddc1581cbd3917d6c87620475e0103b9918f2a679b2425eda6dd243fd`；
- campaign：`v0.3.2-luna-r2`；
- order seed：`chronorift-v0.3.2-luna-r2-formal-1`；
- local annotated freeze tag：`v0.3.2-luna-r2-benchmark-freeze`。

该本地 tag 固定包含 implementation、009 evidence、machine spec 与重建测试的 freeze commit。当前
`benchmark:status` 为 `selected=false`、`executionId=null`：formal execution 尚未运行，因此没有
aggregate、scoring proofs 或产品 Gate 结论。

## 不变性边界

- 历史 r1 仍是已发布、完整性可验证但 aggregate 为 `null` 的 `invalid` 负结果；008 不改写它。
- `not_ready` 是 canary 前置结论，不是三组 treatment 的效果比较。
- 单个 `confirmed` verdict 不会覆盖缺失 source receipt，也不会使整个 canary 获得资格。
- 009 的 `ready` / `hardened` 只证明 canary 前置；freeze 只固定 protocol，不证明 formal 或 Gate 已完成。
