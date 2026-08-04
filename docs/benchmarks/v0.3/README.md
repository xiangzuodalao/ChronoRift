# ChronoRift v0.3 Evidence Package

本目录发布 ChronoRift v0.3 的冻结评测定义、可审计报告和预先选定的案例。它不会把离线
fake-model smoke 当作真实模型结果，也不会因为执行完整就声称 ChronoRift 优于通用 Agent。

## 当前状态

**机器 spec：已冻结。正式 execution：complete。report integrity：pass。预注册 Gate：fail。**

- Execution：`benchmark-execution:bd9b5d3a-5e3f-4e86-9d70-0098925aade5`
- Freeze：`a27b8b7dc4a97fc399d9f687517ca6c442bff197` / `v0.3.0-benchmark-freeze`
- Window：2026-08-04 18:28:41–18:32:08 UTC（北京时间 2026-08-05）
- Report hash：`d58b4b9525a370f2f13731a49df9f2dbe926f2e03c12a8687550b07d55e2d430`

首个正式 execution 的 36/36 cells 均为 `diagnostic_failure/proposal_missing`。每个 cell 只完成一次
baseline；generic、evidence-only、chronorift-full 分别为 0/12 grounded success，总计 token 0、工具调用
0、游戏执行 36，incorrect confirmation 为 0。因此报告内部可重算且完整，但没有形成可供 Harness
裁决的 Agent proposal，不能评价模型诊断质量，也不能比较 treatment 效果。

本地忽略的 raw ledger 在 36 个 finished manifests 中均记录
`PiHarnessError/PROPOSAL_MISSING: Connection error.`，同一环境的两次独立
`corepack pnpm test:live` 也返回 `Connection error`。这些本地观测强烈指向连接路径，但不属于公开
report 可独立复核的 provider 归因；sanitized report 只证明 `proposal_missing`。既有 first-execution
selection 与负结果必须保留，不能通过删除 ledger 或另跑同一定义来筛选样本。

证据包文件约定：

| 文件                                                                       | 产生方式                               | 当前含义                                                               |
| -------------------------------------------------------------------------- | -------------------------------------- | ---------------------------------------------------------------------- |
| [benchmark-spec.v2.json](benchmark-spec.v2.json)                           | 最终实现检查后生成并随 freeze tag 提交 | 已冻结 36-cell suite、metric、预算、模型、Gate 与三类 hash             |
| [protocol.md](protocol.md)                                                 | 人工维护                               | 公平性、评分、重试、恢复和退出码协议                                   |
| [benchmark-report.v2.json](benchmark-report.v2.json)                       | `benchmark:publish` 生成               | 已验证的 sanitized `BenchmarkReportV2`；complete execution / Gate fail |
| [results.md](results.md)                                                   | `benchmark:publish` 生成               | 36 cells 的负结果与 arm/Fixture 汇总                                   |
| [case-physics-tunneling-full-r1.json](case-physics-tunneling-full-r1.json) | `benchmark:publish` 生成               | 预选 cell 的 partial 脱敏 case bundle                                  |
| [case-study-physics-tunneling.md](case-study-physics-tunneling.md)         | 预注册模板，结果后补值                 | 保留失败事实且未事后替换的案例叙事                                     |
| [reproduction.md](reproduction.md)                                         | 人工维护                               | 从 freeze checkout 到 publish/verify/Gate 的命令                       |

发布器不会导出 prompt、源码正文、真实项目/场景/文件名、Pi Session 路径、API key 或 credential
store。公开 report 只包含 strict schema 允许的冻结 suite/oracle label/source symbol、provenance、
attempt/cell 状态、score、metrics、aggregate、引用 ID 与 hash。预选 case bundle 会在可用时包含 typed
evidence；中断或缺失时必须标记 `evidenceCompleteness=partial|unavailable` 与原因，只保留可验证计数，
不会重建不存在的 tool/receipt 轨迹。

离线 `corepack pnpm benchmark` 是 legacy `BenchmarkReportV1` deterministic smoke，不执行 formal v2
first-selection、progress journal 或 recovery ledger；这些 formal 状态机由 `corepack pnpm check` 的离线
测试覆盖。fake 结果与生成的 machine spec 都不是正式模型结果。

## 可以和不可以从报告得出什么

一个完整且 Gate 通过的报告只支持以下窄结论：在冻结实现、同一 GLM-5.2 配置、相同 prompt 与
预算下，`chronorift-full` 在这四个校准 Godot Fixture 上达到预注册 grounded-success 门槛，并相对
`generic` 达到预注册差值。

当前报告没有达到这个前提：虽然 execution complete 且 integrity verification 通过，但 Gate 失败，且
三个 arm 都没有 proposal 或非零 token。因此当前 evidence package 支持的是“负结果被完整封存和
复核”，而不是“某个 arm 或模型表现为 0% 的有效能力测量”。

它不支持：

- 与 Claude Code 或其他模型/产品的比较；
- 统计显著性或跨 Godot 项目的泛化结论；
- 对任意未插桩项目的即插即用能力声明；
- provider 执行真实性、请求内容或远端 sampling 的密码学证明；
- 自动修复、视觉、多 Agent 或完整确定性的能力声明。

`benchmark:verify` 证明报告内部可按仓库规则重算，不是外部 attestation。只有
`benchmark:gate` 判断预注册产品门槛；完整性有效的负面/incomplete 报告仍然是应发布的有效证据。
