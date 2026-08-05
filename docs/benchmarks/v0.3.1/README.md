# ChronoRift v0.3.1 Evidence Package

本目录用于 v0.3.1 provider-recovery campaign。它是 v0.3 之后的一次新 first-selection，不替换、覆盖或
重新解释 [v0.3 已发布的负结果](../v0.3/README.md)。

## 当前状态

**machine spec 与 freeze：已完成。provider smoke：已验证。正式 execution：因 Harness token-accounting
缺陷中止且未封存。report 与 Gate：不可用。**

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

## 正式执行中止记录

freeze commit `f260eeee9380ed54c41eab8d9a76200ab35c42fc` 与 tag
`v0.3.1-benchmark-freeze` 已推送。唯一 selection 是
`benchmark-execution:880714e8-793e-4f91-aa38-44a7da5d4d5d`。第一个 cell 已产生 baseline、2,007 total
tokens 与 3 次工具调用，随后在冻结的 600 秒 deadline 结束时触发 schema error：Harness 错误地要求
Pi `tokens.total = input + output`，但 Pi 定义的 total 还包括 cache-read/cache-write tokens。

异常又发生在 attempt 封存边界之外，所以 execution 留在 `running`，没有可发布的 sealed report。该
selection 与 freeze tag 不删除、不移动，也不会在修改后的代码下拼接恢复。修复增加 cache token 字段、
四项总和校验和非法 metrics 的 fail-closed 封存测试；新的 first-selection 使用独立
[v0.3.1-r2 campaign](../v0.3.1-r2/README.md)。这次 r2 是公开声明的 Harness 修复后重跑，不是按模型
结果 cherry-pick。

计划中的 evidence 文件：

| 文件                                                               | 状态         | 含义                                            |
| ------------------------------------------------------------------ | ------------ | ----------------------------------------------- |
| [benchmark-spec.v2.json](benchmark-spec.v2.json)                   | 已冻结       | v0.3.1 machine-authoritative suite              |
| `benchmark-report.v2.json`                                         | 待正式执行   | sanitized report                                |
| `results.md`                                                       | 待正式执行   | publisher 生成的可读汇总                        |
| `case-physics-tunneling-full-r1.json`                              | 待正式执行   | 运行前预选的 case bundle                        |
| [case-study-physics-tunneling.md](case-study-physics-tunneling.md) | 已预注册模板 | 不因结果替换案例                                |
| [protocol.md](protocol.md)                                         | 已定义       | 与 v0.3 相同的 treatment/评分，加 campaign 隔离 |
| [reproduction.md](reproduction.md)                                 | 已定义       | smoke、freeze、执行和发布顺序                   |

在 report 尚未生成并验证前，本目录不支持任何模型质量、treatment 优势或 Gate 结论。
