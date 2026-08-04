# ChronoRift v0.3 Evidence Package

本目录用于发布 ChronoRift v0.3 的冻结评测定义、可审计报告和预先选定的案例。它不会把离线
fake-model smoke 当作真实模型结果，也不会在正式报告生成前声称 ChronoRift 优于通用 Agent。

## 当前状态

**机器 spec：pending。正式 GLM-5.2 结果：pending。**

代码与协议可以在没有 provider 凭据时接受离线验证；36-cell 正式执行需要用户级 Pi 凭据和网络，
不属于 `corepack pnpm check`。正式运行无论得到正面、负面还是 incomplete 结果，都应原样发布，
不得通过重跑普通诊断失败来筛选样本。

证据包文件约定：

| 文件                                                               | 产生方式                               | 当前含义                                                               |
| ------------------------------------------------------------------ | -------------------------------------- | ---------------------------------------------------------------------- |
| `benchmark-spec.v2.json`                                           | 最终实现检查后生成并随 freeze tag 提交 | 当前 pending；冻结 36-cell suite、metric、预算、模型、Gate 与三类 hash |
| [protocol.md](protocol.md)                                         | 人工维护                               | 公平性、评分、重试、恢复和退出码协议                                   |
| `benchmark-report.v2.json`                                         | `benchmark:publish` 生成               | sanitized `BenchmarkReportV2`；正式执行前不存在                        |
| `results.md`                                                       | `benchmark:publish` 生成               | 按 arm/Fixture 展开的可读结果；正式执行前不存在                        |
| `case-physics-tunneling-full-r1.json`                              | `benchmark:publish` 生成               | 预选 cell 的脱敏 case bundle；正式执行前不存在                         |
| [case-study-physics-tunneling.md](case-study-physics-tunneling.md) | 预注册模板，结果后补值                 | 不允许事后挑选的案例叙事                                               |
| [reproduction.md](reproduction.md)                                 | 人工维护                               | 从 freeze checkout 到 publish/verify/Gate 的命令                       |

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

它不支持：

- 与 Claude Code 或其他模型/产品的比较；
- 统计显著性或跨 Godot 项目的泛化结论；
- 对任意未插桩项目的即插即用能力声明；
- provider 执行真实性、请求内容或远端 sampling 的密码学证明；
- 自动修复、视觉、多 Agent 或完整确定性的能力声明。

`benchmark:verify` 证明报告内部可按仓库规则重算，不是外部 attestation。只有
`benchmark:gate` 判断预注册产品门槛；完整性有效的负面/incomplete 报告仍然是应发布的有效证据。
