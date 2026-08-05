# ChronoRift v0.3.2-luna Evidence Workspace

本目录记录 GPT-5.6 Luna 下的 Benchmark V3 可靠性改造、历史 canary 与后续
正式 campaign。它是进行中的 evidence workspace，不是已通过的 formal release report。

## 当前状态

| 项目                                    | 状态                         | 可验证事实                                               |
| --------------------------------------- | ---------------------------- | -------------------------------------------------------- |
| Benchmark V3 可靠性实现                 | 已实现                       | typed provider/progress、3+3 recovery、sequential tools  |
| Luna smoke × 2                          | 已通过                       | 各 5 tool calls；30,828 / 30,039 total tokens；confirmed |
| `corepack pnpm test:live`               | 已通过                       | 真实 Pi Session/Agent Loop 回归                          |
| C0-001 / C0-002 / C0-003                | 已封存，均 `not_ready`       | 三份 JSON 原样保留                                       |
| C0/C1-004                               | 历史 `ready` / `legacy_only` | 原报告不改写，但缺少 V2 implementation receipt           |
| Hardened C0/C1-005                      | **已通过**                   | 均 `ready`；verifier 前置资格为 `hardened`               |
| `benchmark-spec.v3.json` / freeze tag   | **pending**                  | hardened canary 前置已满足，尚未生成/冻结                |
| 36-cell formal report / verifier / Gate | **pending**                  | 尚无 Luna treatment 优势结论                             |

## V3 改变了什么

V3 保持 `domain ← gamebranch ← adapters ← CLI` 依赖方向，并将 V2 中暴露的评测
基础设施问题收敛到独立的版本化边界：

- provider 错误保留 request/response-stream 阶段、typed code、HTTP status 与 retry class；
- progress 分开 fixture、model、tool、game 与 proposal，并验证序列单调性；
- 只有诊断进展之前的 transient infrastructure failure 可重试：最多 3 次 initial
  attempts，加一个最多 3 次 attempts 的 recovery cycle；
- 一旦观察到 model output、工具开始、诊断性游戏执行或 proposal，后续基础设施故障
  不重试、不计分；
- Pi 工具强制 sequential；每 cell 最多 12 次工具调用、0 次工具错误、0 个连续
  无语义进展结果；
- 工具向 Agent 返回 Session-local `@rN` receipt handle，Harness 在 proposal 边界解析回
  精确 content-addressed receipt ID 并重验引用完整性。
- score-eligible attempt 使用 strict terminal manifest，绑定全部冻结 Fixture material、终态
  progress/metrics、canonical Failure Brief receipt、proposal、verdict 与 oracle；账本将公开的
  prose-free `scoringProofs` 逐项回投到选中 raw manifest，并重算 replay/intervention/source 细分预算；
- finish 写入中断时，恢复器只在 terminal manifest 的 lineage、预算和评分全部重验后重建结果，
  非终态进度才进入 process-interrupted 分类。

模型只提交 proposal。Harness 仍独立评估 Contract、replay、candidate、comparison、lineage 与
receipt；confidence 永远不能决定 `confirmed`，证据不足时必须输出 `inconclusive`。

## 已保留的 canary 证据

| 报告                                 | 结果                    | 未就绪原因                                                       |
| ------------------------------------ | ----------------------- | ---------------------------------------------------------------- |
| [C0-001](canary-c0-attempt-001.json) | `not_ready`             | generic/evidence-only `invalid_tool_flow`；full provider unknown |
| [C0-002](canary-c0-attempt-002.json) | `not_ready`             | generic/full `invalid_tool_flow`                                 |
| [C0-003](canary-c0-attempt-003.json) | `not_ready`             | evidence-only `invalid_tool_flow`                                |
| [C0-004](canary-c0-ready-004.json)   | `ready` / `legacy_only` | 三 arm 均 mechanism correct；不能授权 hardened C1                |
| [C1-004](canary-c1-ready-004.json)   | `ready` / `legacy_only` | 历史 linkage 可重验；不能授权 freeze                             |
| [C0-005](canary-c0-ready-005.json)   | `ready` / `hardened`    | implementation-bound；三个 arm 均 mechanism correct              |
| [C1-005](canary-c1-ready-005.json)   | `ready` / `hardened`    | 精确绑定 C0-005 report hash；三个 arm 均 mechanism correct       |

C0 只有在 generic、evidence-only 和 chronorift-full 三个 arm 都满足冻结 readiness 条件时
才是 `ready`。某些 arm 单独得到 `confirmed` 不能将整个 stage 改写为 ready，也不允许删除
其他 arm 的失败。004 的 readiness 字段仍是历史事实，但它们没有 V2 implementation receipt；
强化 verifier 输出 `prerequisiteEligibility=legacy_only`。新 identity 005 已完成
implementation-bound C0/C1，强化 verifier 对两份报告均输出 `prerequisiteEligibility=hardened`。
C0 report hash 为 `0c5ef20c0e8f16ee9d93175b36cb7b1fb85f9514c6d06e5267b3c9f7974545c1`；C1 report hash 为
`b28560f66e6ef6c073e9029a993ad3636e8530f2c13decf47e52b7c60e710dfb`，并精确绑定该 C0。两阶段
六个 cells 均为零 tool errors、零无进展违规、零 incorrect confirmation。这已解锁 V3 freeze 的
canary 前置，但不等于 formal Gate 通过。

## 文档导航

- [protocol.md](protocol.md)：V3 冻结语义、retry/score 边界与 Gate。
- [preflight.md](preflight.md)：已执行真实链路和 canary 的事实记录。
- [reproduction.md](reproduction.md)：已执行 canary、待执行 freeze/formal/publish/verify 顺序。
- [中文作品集](../../portfolio-v0.3.2.md)：面向简历和面试的 evidence-backed 项目摘要。

目录中尚不存在 `benchmark-spec.v3.json`、`benchmark-report.v3.json`、V3 results 或 case
bundle；这些文件只能由后续实际执行产生，不得预先描述为已发布。
