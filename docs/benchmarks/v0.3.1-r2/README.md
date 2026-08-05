# ChronoRift v0.3.1-r2 Evidence Package

本目录是 [v0.3.1 中止记录](../v0.3.1/README.md)之后的 Harness-fix rerun。它不删除或替换原 freeze、
selection 或 progress journal。

## 当前状态

**token-accounting fix：已实现并回归。provider smoke：已复验。machine spec 与 freeze：已完成。
唯一 formal execution：已封存并发布。report integrity：通过。产品 Gate：失败。**

r2 保持四个 Fixture、三个 arm、prompt/Failure Brief、模型、thinking、预算、评分、Gate 和预选案例
不变。预注册差异只有：

- token metrics 显式记录 `input/output/cacheRead/cacheWrite/total`，total 必须是四项之和；
- 任意非法 attempt metrics 使用最后一条有效 progress fail closed 封存，不得留下 running execution；
- campaign/tag/seed 分别为 `v0.3.1-r2`、`v0.3.1-r2-benchmark-freeze`、
  `chronorift-v0.3.1-r2-formal-1`；
- generated artifacts 只能写入本目录。

由于 Pi path 发生变化，freeze 前重新连续运行两次 `pi:smoke` 和一次 `test:live`。第一次 r2 selection
产生后仍遵守 first-formal-execution-wins；结果无论好坏都发布。

修复后两次 smoke 均为 5 次工具调用与 confirmed。第一次 usage 为 11,248 input、4,759 output、17,024
cache read、0 cache write、33,031 total；第二次为 8,926、4,386、19,456、0、32,768。两组四项总和
精确匹配，随后 `test:live` 通过。这些是 preflight 事实，不进入 formal aggregate。

## 正式结果

- execution：`benchmark-execution:e16b8aa7-2f63-444b-9aec-bfcc3aeb426d`；
- report hash：`cfb29c7878500dcbd7ac0cbd3683fdf52362088ea26d7bf55573e11227f4457a`；
- 36/36 cells 封存，report verifier 通过；
- generic、evidence-only、chronorift-full grounded success 均为 0/12；
- incorrect confirmations 为 0；Gate 因 full < 9/12 且 full − generic < +0.20 失败；
- 总计 36 次 baseline、146 次工具调用、2,527,181 tokens。

terminal code 为 `proposal_missing` 32 次、`invalid_tool_flow` 2 次、`progress_timeout` 2 次。本地 raw
ledger 显示 32 个 `proposal_missing` 的底层 `PiHarnessError` message 均为 `Connection error.`；公开
sanitized report 不含该 message，因此公开报告只证明 proposal 缺失。非零用量集中于 4 个 cells，不能
把本轮 arm aggregate 解释为模型能力差异或 ChronoRift 优势。

本轮仍有真实价值：cache token 四项守恒，非法 metrics 不再留下 running execution，有进度超时与工具
流违规都 fail closed，唯一 execution 的负结果可以原样发布和独立重算。它同时给出下一轮明确的工程
输入：typed provider cause、诊断工具串行化、Agent 完成/预算终止策略与 formal 前小规模 canary。

| 文件                                                                       | 当前状态                 |
| -------------------------------------------------------------------------- | ------------------------ |
| [benchmark-spec.v2.json](benchmark-spec.v2.json)                           | 已由 freeze tag 固定     |
| [benchmark-report.v2.json](benchmark-report.v2.json)                       | 已发布，完整性验证通过   |
| [results.md](results.md)                                                   | 已由 publisher 生成      |
| [case-physics-tunneling-full-r1.json](case-physics-tunneling-full-r1.json) | 已发布的预选 case bundle |
| [protocol.md](protocol.md)                                                 | 已预注册                 |
| [reproduction.md](reproduction.md)                                         | 已补全精确复验命令       |
| [case-study-physics-tunneling.md](case-study-physics-tunneling.md)         | 已按预选 case 填写       |
