# v0.3.2-luna Preflight Record

本文只记录截至 2026-08-05 已实际发生的前置事实。它不包含凭据、prompt、Session ID、
本地路径或未脱敏 provider 错误正文。

## 模型与真实 Pi 链路

当前目标为 `openai-codex/gpt-5.6-luna`、`thinkingLevel=max`。Pi 模型目录声明 272,000
context window、128,000 max output，`max` 映射为真实 `max` reasoning effort。

| 检查         | 结果 | 工具调用   | Total tokens | Harness verdict |
| ------------ | ---- | ---------- | ------------ | --------------- |
| Luna smoke 1 | 通过 | 5          | 30,828       | `confirmed`     |
| Luna smoke 2 | 通过 | 5          | 30,039       | `confirmed`     |
| `test:live`  | 通过 | 由测试断言 | 非发布指标   | 诊断回归通过    |

两次 smoke 使用 v0.1 Mock switch-door，只证明用户级 OAuth、模型请求、Pi Session/Agent
Loop、工具调度与 Harness verdict 这条链路在当时可用。它们不进入 36-cell aggregate，
也不能证明三个 benchmark arm 的相对效果。

## C0 canary 记录

| Canary | 状态                               | generic               | evidence-only         | chronorift-full          |
| ------ | ---------------------------------- | --------------------- | --------------------- | ------------------------ |
| 001    | `not_ready`                        | `invalid_tool_flow`   | `invalid_tool_flow`   | `provider_error_unknown` |
| 002    | `not_ready`                        | `invalid_tool_flow`   | scored                | `invalid_tool_flow`      |
| 003    | `not_ready`                        | scored                | `invalid_tool_flow`   | scored                   |
| 004 C0 | historical `ready` / `legacy_only` | true / `inconclusive` | true / `inconclusive` | true / `confirmed`       |
| 004 C1 | historical `ready` / `legacy_only` | true / `inconclusive` | true / `inconclusive` | true / `inconclusive`    |

原始 sanitized reports：

- [canary-c0-attempt-001.json](canary-c0-attempt-001.json)
- [canary-c0-attempt-002.json](canary-c0-attempt-002.json)
- [canary-c0-attempt-003.json](canary-c0-attempt-003.json)
- [canary-c0-ready-004.json](canary-c0-ready-004.json)
- [canary-c1-ready-004.json](canary-c1-ready-004.json)

每份 report 都对 spec、cell 和 report 持有 content hash。这三份负结果已保留，不会因某个 arm
在后续 attempt 成功而被覆盖。`invalid_tool_flow` 表明当次诊断流未满足冻结工具规则；
`provider_error_unknown` 表明 typed classifier 没有足够事实将当次 provider failure 归为
transient 或 permanent。两者都不允许被自信度或其他 arm 的成功抵消。

C0-004 的 report hash 为
`78915077d2881d1b0eed232e34abc3b16a894b4bd8a51841c73f3004f698dc07`。generic、evidence-only、
chronorift-full 分别使用 7/5/8 次工具调用和 62,667/31,150/73,722 total tokens；机制均正确，
verdict 分别为 `inconclusive`/`inconclusive`/`confirmed`。

C1-004 的 report hash 为
`9526f486d9dea9619a748a867757861c588c77e90e58f43c4327dd0820195e3b`。generic、evidence-only、
chronorift-full 分别使用 7/5/8 次工具调用，3/2/3 次游戏执行，92,310/49,464/111,558 total
tokens，wall time 为 71,340/50,490/57,534 ms。机制均正确且 verdict 均为 `inconclusive`；full 完成
matching replay、一项 intervention、一次 comparison 与 proposal。两个 ready stages 的六个 cells
都是零 tool errors、零无进展违规、零 incorrect confirmation。

004 报告缺少 V2 implementation receipt，强化 verifier 因此只将其 linkage 归为
`legacy_only`。这些数值仍是有效历史事实，但不能授权 implementation-bound C1 或 freeze；005 尚未运行。

## 尚未完成

- `docs/benchmarks/v0.3.2-luna/benchmark-spec.v3.json`：pending；
- implementation-bound C0/C1-005：pending；
- `v0.3.2-luna-benchmark-freeze`：pending；
- 唯一 36-cell first-selection 与 formal execution：pending；
- V3 sanitized report、results、case bundle、integrity verification 和 Gate：pending。

因此当前可以声称“V3 可靠性边界已实现、真实 Pi 链路已通过 smoke、历史负向与 004 canary 已
原样保留”，不能声称“hardened canary 已通过”、“V3 formal 已发布”、“Gate 已通过”或
“ChronoRift 已证明优于 generic Agent”。
