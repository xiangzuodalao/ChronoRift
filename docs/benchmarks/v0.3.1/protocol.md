# ChronoRift v0.3.1 Formal Benchmark Protocol

v0.3.1 完整继承 [v0.3 protocol](../v0.3/protocol.md) 的 treatment、盲化、Fixture、预算、模型、评分、
Gate、attempt/recovery、ledger、发布、验证与退出码语义。本文件只冻结新 campaign 的差异；未列出的
字段不得改变。

## 不变项

- 4 Fixture × 3 arm × 3 repetition，共 36 cells；
- `volcengine-coding-plan/glm-5.2`，context 1,000,000，max tokens 128,000，thinking `max`；
- byte-identical system/user prompt 与 `FailureBriefV1`，tool availability 是唯一 treatment；
- baseline 1、replay 1、intervention 2、source call 4、总游戏执行 4、并发 1、每 cell 600 秒；
- `groundedSuccess = mechanismCorrect && canonical verdict == confirmed`；
- full ≥ 9/12、full − generic ≥ 0.20、full incorrect confirmations = 0；
- physics-tunneling / chronorift-full / repetition 1 是运行前预选案例；
- first-formal-execution-wins、append-only attempts、closed retry classifier 与一次 recovery cycle。

Agent confidence 仍不参与 canonical verdict。证据不足、引用无效、restore/replay/control/comparison 不可比
时必须 `inconclusive`。

## campaign 身份

v0.3.1 machine spec 必须同时包含：

```text
campaignId = v0.3.1
freezeTag = v0.3.1-benchmark-freeze
orderSeed = chronorift-v0.3.1-formal-1
```

schema 拒绝 campaign/tag/seed 错配。suite identity 包含 campaign，因此不会复用 v0.3 的 definition 或
selection。正式 provenance 必须来自干净且精确位于 `v0.3.1-benchmark-freeze` 的 checkout。publisher
只允许三个 generated artifacts 出现在 `docs/benchmarks/v0.3.1/`，不能写入 v0.3 目录。

新 order seed 是预注册的新执行顺序，不改变 cell 集合或 treatment。provider 不提供 sampling seed，三次
repetition 仍不能解释为完全可复现的独立样本。

## provider recovery 前置门

正式 freeze 前在 v0.1 Mock 上连续运行两次 `corepack pnpm pi:smoke`，并运行一次
`corepack pnpm test:live`。每个 `pi:smoke` 只有同时满足以下条件才成功：

- 使用真实 Pi Session/Agent Loop 与固定 provider/model；
- Session 文件已持久化；
- total tokens > 0；
- tool calls > 0；
- Harness canonical verdict 为 `confirmed`。

这些 smoke 不进入 suite、report 或 aggregate，也不能替代正式 preflight。它们的目的仅是阻止已知
`Connection error` 在零 token 状态下再次污染整轮正式执行。

## 结果承诺

第一次 v0.3.1 selection 产生后，不根据中间结果改变 prompt、预算、顺序、Gate 或代码。只允许协议规定
的同 execution resume。最终 sealed 结果无论 Gate pass/fail、invalid 或 recovery-exhausted incomplete
都发布；`benchmark:verify` 与 `benchmark:gate` 继续分开解释。
