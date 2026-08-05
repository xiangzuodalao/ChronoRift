# v0.3.2-luna-r3 evidence workspace

> **当前状态：canary-010 已 hardened；formal 尚未冻结或运行。** 本目录已有 write-once C0/C1 report，
> 但还没有 machine spec、freeze tag、formal selection、aggregate 或 Gate 结果。

r3 是 `v0.3.2-luna-r2` 的独立后继 identity。r2 的 spec、tag、selection、ledger 与已发布的
`invalid` 报告保持不可变；r3 不恢复、拼接或重新解释 r2。r3 只增加一个主要不确定性维度：统一
Conclusion Gate 与 formal terminal validator 对 receipt coverage 缺口的分类。

## 预注册 identity

| 字段               | 预注册值                                   | 当前状态                    |
| ------------------ | ------------------------------------------ | --------------------------- |
| campaign           | `v0.3.2-luna-r3`                           | 已命名，尚无 machine spec   |
| canary             | `v0.3.2-luna-canary-010`                   | C0/C1 `ready` / `hardened`  |
| formal order seed  | `chronorift-v0.3.2-luna-r3-formal-1`       | 预注册，尚未用于 selection  |
| local freeze tag   | `v0.3.2-luna-r3-benchmark-freeze`          | 保留名称，**尚未创建**      |
| suite / definition | 由最终 machine spec 的 canonical hash 派生 | 未知，不能提前填写          |
| subject / runner   | 由干净 implementation receipt 与 spec 派生 | 未知，不能提前填写          |
| formal execution   | first-selection 后由 Harness 分配          | 尚未选择；没有 execution ID |

这些名称只是预注册计划，不构成 freeze。只有 canary-010 前置通过、干净实现提交和可重建 machine spec
同时存在后，才允许创建 annotated freeze tag。

## 当前状态

| 工作项                    | 状态       | 完成条件                                                         |
| ------------------------- | ---------- | ---------------------------------------------------------------- |
| r2 failure reproduction   | **已完成** | 离线测试精确复现 receipt coverage 的错误终态分类                 |
| receipt coverage 分类修复 | **已完成** | 缺失 coverage 得到 canonical `inconclusive`，不升级 Harness 故障 |
| Canary 010 C0             | **ready**  | 三个 arm 均 scored；verifier prerequisite `hardened`             |
| Canary 010 C1             | **ready**  | 三个 arm 均 scored；精确绑定 C0 report hash                      |
| r3 machine spec           | **未生成** | 从冻结实现确定性生成、审核并通过重建测试                         |
| r3 annotated tag          | **未创建** | tag 精确指向包含实现、canary evidence 与 spec 的干净 commit      |
| r3 36-cell formal         | **未运行** | tag 后只允许一个 first-selection execution                       |
| report / verifier / Gate  | **不存在** | terminal execution 发布后才可验证和评估                          |

## 文档入口

- [protocol.md](protocol.md)：分类边界、canary-010、freeze 与 36-cell 成功判据。
- [reproduction.md](reproduction.md)：r2 缺陷的最小复现与修复后的回归 oracle。
- [r2 immutable evidence](../v0.3.2-luna-r2/README.md)：触发 r3 的已发布负结果。

## Canary 010 hardened evidence

C0 与 C1 都绑定 implementation commit `966b11fb2a02709b17192887fb80365c34942214`、source hash
`938d24259c7f3cd1a5f2ca3a952442a5479524b3c9d383369be22c47cde6260c`，且
`sourceWorktreeDirty=false`：

- [C0 report](canary-c0-ready-010.json)：report hash
  `b89f5924ed4bf360911c204c521ebd2205ddcba9d88624e1ef404e9d41ca2925`；
- [C1 report](canary-c1-ready-010.json)：report hash
  `3642bda1d2a47620b42878a10d62e105be3449ab877bb740eb86b361733d6508`，其
  `prerequisiteReportHash` 精确等于 C0 hash。

| Stage | Arm             | Verdict        | Tools | Game runs |  Tokens | Source receipts |
| ----- | --------------- | -------------- | ----: | --------: | ------: | --------------: |
| C0    | generic         | `confirmed`    |     7 |         3 |  64,450 |               2 |
| C0    | evidence-only   | `inconclusive` |     5 |         2 |  32,027 |               2 |
| C0    | chronorift-full | `confirmed`    |     8 |         3 |  75,182 |               2 |
| C1    | generic         | `inconclusive` |     7 |         3 |  92,005 |               2 |
| C1    | evidence-only   | `inconclusive` |     5 |         2 |  45,538 |               2 |
| C1    | chronorift-full | `confirmed`    |     8 |         3 | 109,425 |               2 |

六个 cells 均 `scored`、mechanism correct、无 incorrect confirmation、tool error 或连续无语义进展。
这只证明 r3 implementation 的真实 Pi/Godot 前置合格，不是 36-cell treatment 结果。

## 不提前声称的内容

- suite、definition、subject、runner、report 或 selection hash；
- 36 cells 是否完成、是否存在 aggregate、verifier 是否通过或 Gate 是否通过；
- r3 是否优于 generic arm、通用代码 Agent 或其他产品；
- 四个校准 Fixture 之外的泛化能力。

无论 canary 或 formal 得到正面、负面、incomplete 还是 invalid 结果，都必须按实际状态写入新的
write-once artifact；不得通过覆盖文件、复用 identity 或选择性发布来改变结论。
