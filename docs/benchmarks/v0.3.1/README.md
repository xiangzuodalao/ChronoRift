# ChronoRift v0.3.1 Evidence Package

本目录用于 v0.3.1 provider-recovery campaign。它是 v0.3 之后的一次新 first-selection，不替换、覆盖或
重新解释 [v0.3 已发布的负结果](../v0.3/README.md)。

## 当前状态

**实现与 machine spec：已通过 pre-freeze gate。provider smoke：已验证。正式 execution：尚未开始。
report 与 Gate：尚不可用。**

v0.3.1 保持 v0.3 的四个 Fixture、三个 arm、byte-identical prompt/Failure Brief、预算、GLM-5.2
配置、评分和 Gate 不变。campaign 的唯一预注册变化是：

- freeze tag 为 `v0.3.1-benchmark-freeze`；
- block order seed 为 `chronorift-v0.3.1-formal-1`；
- suite 中带有严格的 `campaignId=v0.3.1`，从而产生新的 suite/definition identity；
- generated evidence 只能写入 `docs/benchmarks/v0.3.1/`。

新 execution 启动前，必须在正式 Fixture 外连续两次通过真实 `pi:smoke`，再通过 `test:live`。smoke
只证明本地凭据、网络、Pi Session/Agent Loop、工具调用和 Harness verdict 链路可工作，不是 formal
benchmark 数据。

2026-08-05 的 pre-freeze 验证连续两次成功：两次均持久化 Session、执行 5 次工具调用并由 Harness
confirmed，total tokens 分别为 33,562 和 43,087；随后 `test:live` 通过。输出经过 CLI 摘要脱敏，且这些
数值不进入 formal aggregate。`corepack pnpm check`、`test:godot`、离线 benchmark 和历史 v0.3 report
回归验证也已通过。

正式执行一旦产生 durable selection，只能恢复同一 execution。无论结果正面、负面、invalid 或 recovery
耗尽后的 incomplete，都按 [reproduction protocol](reproduction.md) 原样发布；不得删除 selection、重跑
同一定义或选择更好结果。

计划中的 evidence 文件：

| 文件                                                               | 状态                         | 含义                                            |
| ------------------------------------------------------------------ | ---------------------------- | ----------------------------------------------- |
| [benchmark-spec.v2.json](benchmark-spec.v2.json)                   | 已生成，待随 commit/tag 冻结 | v0.3.1 machine-authoritative suite              |
| `benchmark-report.v2.json`                                         | 待正式执行                   | sanitized report                                |
| `results.md`                                                       | 待正式执行                   | publisher 生成的可读汇总                        |
| `case-physics-tunneling-full-r1.json`                              | 待正式执行                   | 运行前预选的 case bundle                        |
| [case-study-physics-tunneling.md](case-study-physics-tunneling.md) | 已预注册模板                 | 不因结果替换案例                                |
| [protocol.md](protocol.md)                                         | 已定义                       | 与 v0.3 相同的 treatment/评分，加 campaign 隔离 |
| [reproduction.md](reproduction.md)                                 | 已定义                       | smoke、freeze、执行和发布顺序                   |

在 report 尚未生成并验证前，本目录不支持任何模型质量、treatment 优势或 Gate 结论。
