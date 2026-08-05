# Canary 006 interrupted C1 record

> 状态：**负向运行记录；不是 C1 report，也不能授权 formal freeze。** 本文只记录 append-only
> canary ledger 与公开 C0 report 的可验证边界，不补写或改写中断的 C1 artifact。

## 已封存事实

- identity：`v0.3.2-luna-canary-006`；
- implementation commit：`7b9dd6679fc742fa5e39a899bc474f570015295e`；
- implementation source hash：
  `61c359031dd27cc27075d7fbd2211e78fe03d8fb032b415dd332e8f3417fb1a3`；
- C0：三组 arm 均已封存，readiness 为 `ready`；
- C0 report hash：
  `103c43d8763aad74f7c8862b190d2494a0b0daff7de4fe809b86219499f4fdc2`；
- C0 verifier 前置资格：`hardened`。

公开 C0 见 [canary-c0-ready-006.json](canary-c0-ready-006.json)。

## C1 中断边界

C1 ledger 已有 `started`，并写入一个 `generic` terminal cell；该 cell 为 `scored`、verdict
`inconclusive`、`incorrectConfirmation=false`。在处理 `evidence-only` 的工具失败终态时，canary
parser 错把 `failed` 当成与 `completed` 互斥的计数，使用了
`completed + failed <= started`。实际 Session guard 中 `completed` 表示全部已终止调用，`failed` 是其
子集，正确关系应为 `failed <= completed <= started`。合法失败进度因此被 parser 拒绝。

结果是：

- `evidence-only` 与 `chronorift-full` cell 均未写入；
- C1 `report.json` 未写入；
- 006 没有 C1 readiness、report hash 或 verifier 结论；
- 006 不能作为完整 hardened C0/C1 前置。

006 的 retry policy 是 `single-attempt-no-resume-v1`。已有 started 且没有 report 的 stage 必须由 Harness
拒绝恢复，因此不得重跑 006 C1、手工补 cell 或拼接 report。修复 parser 并加入失败子集回归后，只能用
绑定新 implementation receipt 的后续 identity 从 C0 重新开始。
