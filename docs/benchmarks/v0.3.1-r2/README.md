# ChronoRift v0.3.1-r2 Evidence Package

本目录是 [v0.3.1 中止记录](../v0.3.1/README.md)之后的 Harness-fix rerun。它不删除或替换原 freeze、
selection 或 progress journal。

## 当前状态

**token-accounting fix：已实现并回归。provider smoke：已复验。machine spec：已生成，待 freeze。
正式 execution：尚未开始。**

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

| 文件                                                               | 当前状态                     |
| ------------------------------------------------------------------ | ---------------------------- |
| [benchmark-spec.v2.json](benchmark-spec.v2.json)                   | 已生成，待随 commit/tag 冻结 |
| `benchmark-report.v2.json`                                         | 待 sealed execution          |
| `results.md`                                                       | 待 publisher 生成            |
| `case-physics-tunneling-full-r1.json`                              | 待 publisher 生成            |
| [protocol.md](protocol.md)                                         | 已预注册                     |
| [reproduction.md](reproduction.md)                                 | 已定义                       |
| [case-study-physics-tunneling.md](case-study-physics-tunneling.md) | 已预注册模板                 |
