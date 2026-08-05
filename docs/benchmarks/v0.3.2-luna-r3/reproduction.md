# Receipt coverage 分类缺陷复现协议

> 当前状态：r3 修复与对应离线回归已经落地并通过；本文仍只描述复现与验证协议，不替代正式 report。

## 1. 已观察到的 r2 事实

r2 的不可变公开证据位于 [../v0.3.2-luna-r2](../v0.3.2-luna-r2/README.md)：

- execution：`benchmark-execution:0d6c17c8-03f1-441b-aadd-83ed2623aa9b`；
- selection hash：`906bea23e579fc37b6edab31df5570c7075a25477bb644033851944fbd2f8a96`；
- report hash：`116a57fcc24c7e1e9493a466b6613de9cac7082648d8219575c75d3b2c84353d`；
- terminal：5/36 cells，其中 4 `scored`、1 `harness_failure`；execution `invalid`、aggregate `null`。

触发 cell 是 case 02 / generic / repetition 3。它完成了 7 次成功工具调用，proposal 被工具接受，且
`mechanismCode` 与 frozen oracle 一致。proposal 引用了 baseline events，但 `accessReceiptIds` 没有包含
覆盖它们的 `@r1` raw baseline receipt。该缺口不是 provider、Godot、工具执行或 ID 解析故障；post-run
manifest integrity 将其升级为 `harness_failure`，并使 execution 不可恢复地失效。

## 2. 最小离线复现

回归 fixture 应完全离线、确定性且不需要 Pi provider 或 Godot 进程：

1. 构造同一 investigation 的 Failure Brief、baseline execution、baseline raw receipt、Capsule、proposal
   与冻结 oracle；
2. proposal 使用真实、可解析的 baseline event IDs，并保持正确 `mechanismCode`；
3. proposal 引用 Failure Brief 及其他所需 receipts，但故意遗漏覆盖 baseline events 的 raw/Capsule
   receipt；
4. 让 Conclusion Gate 产生“cited baseline events are not covered”这一 canonical blocker 与
   `inconclusive` verdict；
5. 将完全相同的 proposal、receipt 集和 verdict 送入 raw-manifest seal 与 scoring-proof builder。

修复前的复现 oracle 是：步骤 4 已安全弃权，但步骤 5 再次以 receipt coverage 错误拒绝 manifest，最终
得到 `terminalCode=harness_failure`，而不是保留 Agent 的证据不足结果。测试必须先证明该症状，不能靠
放宽断言直接让测试变绿。

## 3. 修复后的正向 oracle

对相同输入，修复后的期望是：

- event IDs 和 receipt IDs 仍全部按真实 investigation 解析；
- coverage 缺口保留为 canonical blocker；
- Harness verdict 固定为 `inconclusive`，无论 proposal confidence 或 mechanism correctness；
- cell 作为可计分的 terminal 负向诊断结果封存，`mechanismCorrect=true`、
  `groundedSuccess=false`；
- raw manifest、sanitized scoring proof 和 verifier 对 blocker、receipt 集、verdict 与分数得出相同结论；
- 不生成 `harness_failure`，也不使整个 execution 因这一诊断缺口成为 `invalid`；
- Harness 不替 Agent 自动补入遗漏 receipt。

这项 oracle 只修复分类一致性，不把缺少 coverage 的 diagnosis 升级为 grounded 或 confirmed。

## 4. 必须保留的反例

回归至少覆盖：

| 输入                                                     | 期望结果                                        |
| -------------------------------------------------------- | ----------------------------------------------- |
| 完整 raw/Capsule coverage，其他证据也充分                | 保持现有 canonical verdict 与 scoring 行为      |
| 可解析 event、遗漏覆盖 receipt                           | scored + `inconclusive`；grounded success false |
| coverage 缺失但 verdict 被伪造成 `confirmed`             | manifest/verifier fail closed                   |
| event 或 receipt ID 未知                                 | invalid proposal；不得进入 scored proof         |
| receipt 属于另一 investigation                           | reference-integrity failure                     |
| receipt resource/content hash 不匹配                     | reference-integrity failure                     |
| manifest 删除 canonical blocker                          | seal/verifier 拒绝                              |
| sanitized proof 改写 receipt、verdict 或 grounded status | verifier 报告 issue                             |
| 合法 `invalid_proposal` 仅有一次预期 tool error          | 保持既有预算分类，不回归为 Harness failure      |

## 5. 计划验证命令

实现和测试落地后，至少运行：

```bash
corepack pnpm exec vitest run --config vitest.config.ts \
  packages/gamebranch/test/v03-benchmark-v3-service.test.ts \
  apps/cli/src/v03-formal-execution-v3.test.ts \
  packages/pi-harness/tests/v03-tool-flow.test.ts

corepack pnpm check
```

若改动触及 Godot runtime/material 边界，再运行 `corepack pnpm test:godot`。只有这些离线门槛通过后，
才进入 canary-010；`test:live`、canary 或 formal 的未来结果必须由各自 write-once artifact 证明，不能在
本文预填。
