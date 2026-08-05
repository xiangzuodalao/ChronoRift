# v0.3.2-luna-r3 evidence workspace

> **预执行状态：尚未运行，尚未冻结。** 本目录目前只包含人工编写的计划与复现协议；没有 canary
> report、machine spec、freeze tag、formal selection、ledger、aggregate 或 Gate 结果。

r3 是 `v0.3.2-luna-r2` 的独立后继 identity。r2 的 spec、tag、selection、ledger 与已发布的
`invalid` 报告保持不可变；r3 不恢复、拼接或重新解释 r2。r3 只增加一个主要不确定性维度：统一
Conclusion Gate 与 formal terminal validator 对 receipt coverage 缺口的分类。

## 预注册 identity

| 字段               | 预注册值                                   | 当前状态                    |
| ------------------ | ------------------------------------------ | --------------------------- |
| campaign           | `v0.3.2-luna-r3`                           | 已命名，尚无 machine spec   |
| canary             | `v0.3.2-luna-canary-010`                   | 尚未运行                    |
| formal order seed  | `chronorift-v0.3.2-luna-r3-formal-1`       | 预注册，尚未用于 selection  |
| local freeze tag   | `v0.3.2-luna-r3-benchmark-freeze`          | 保留名称，**尚未创建**      |
| suite / definition | 由最终 machine spec 的 canonical hash 派生 | 未知，不能提前填写          |
| subject / runner   | 由干净 implementation receipt 与 spec 派生 | 未知，不能提前填写          |
| formal execution   | first-selection 后由 Harness 分配          | 尚未选择；没有 execution ID |

这些名称只是预注册计划，不构成 freeze。只有 canary-010 前置通过、干净实现提交和可重建 machine spec
同时存在后，才允许创建 annotated freeze tag。

## 当前状态

| 工作项                    | 状态        | 完成条件                                                         |
| ------------------------- | ----------- | ---------------------------------------------------------------- |
| r2 failure reproduction   | 待固化      | 离线测试精确复现 receipt coverage 的错误终态分类                 |
| receipt coverage 分类修复 | 待实现/验收 | 缺失 coverage 得到 canonical `inconclusive`，不升级 Harness 故障 |
| Canary 010 C0             | **未运行**  | 三个 arm 的报告原样封存并通过强化 verifier                       |
| Canary 010 C1             | **未运行**  | 仅在合格 C0 后运行，并精确绑定 C0 report hash                    |
| r3 machine spec           | **未生成**  | 从冻结实现确定性生成、审核并通过重建测试                         |
| r3 annotated tag          | **未创建**  | tag 精确指向包含实现、canary evidence 与 spec 的干净 commit      |
| r3 36-cell formal         | **未运行**  | tag 后只允许一个 first-selection execution                       |
| report / verifier / Gate  | **不存在**  | terminal execution 发布后才可验证和评估                          |

## 文档入口

- [protocol.md](protocol.md)：分类边界、canary-010、freeze 与 36-cell 成功判据。
- [reproduction.md](reproduction.md)：r2 缺陷的最小复现与修复后的回归 oracle。
- [r2 immutable evidence](../v0.3.2-luna-r2/README.md)：触发 r3 的已发布负结果。

## 不提前声称的内容

- canary-010 是否 `ready` / `hardened`；
- suite、definition、subject、runner、report 或 selection hash；
- 36 cells 是否完成、是否存在 aggregate、verifier 是否通过或 Gate 是否通过；
- r3 是否优于 generic arm、通用代码 Agent 或其他产品；
- 四个校准 Fixture 之外的泛化能力。

无论 canary 或 formal 得到正面、负面、incomplete 还是 invalid 结果，都必须按实际状态写入新的
write-once artifact；不得通过覆盖文件、复用 identity 或选择性发布来改变结论。
