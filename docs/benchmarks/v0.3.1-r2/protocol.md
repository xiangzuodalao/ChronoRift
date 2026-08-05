# ChronoRift v0.3.1-r2 Protocol

r2 继承 [v0.3 protocol](../v0.3/protocol.md) 和 [v0.3.1 campaign protocol](../v0.3.1/protocol.md) 的
全部 treatment 与 Gate。它不是按模型结果选择的 rerun，而是 v0.3.1 第一个 cell 发现 Harness schema/
封存缺陷后的独立新 definition。

不变项：4 × 3 × 3 cells、`volcengine-coding-plan/glm-5.2`、thinking max、byte-identical prompt、工具
treatment、执行预算、grounded-success score、full 9/12 与 +0.20 Gate、full 零错误确认，以及运行前
预选 physics/full/repetition-1。

r2 冻结以下 token 语义：

```text
total = input + output + cacheRead + cacheWrite
```

新正式 attempt 总是持久化四个字段。历史 v0.3/v0.3.1 artifact 没有 cache 字段时仍按零 cache 解析，
canonical JSON 不被迁移或改写。若 provider/adapter 返回不满足 schema 的 metrics，Harness 以最后一条
已验证 progress 生成 invalid attempt/cell 并封存 execution，不允许异常越过 ledger 边界。

r2 身份固定为 `v0.3.1-r2-benchmark-freeze` 与 `chronorift-v0.3.1-r2-formal-1`，发布目录固定为
`docs/benchmarks/v0.3.1-r2/`。首次 selection 后只允许同 execution resume；所有 sealed 结果都发布。
