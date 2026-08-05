# v0.3.2-luna-r3 evidence workspace

> **当前状态：r3 已冻结并运行，但唯一 formal execution 在 16/36 cells 后成为不可恢复的
> `invalid`。** Canary-010 与 machine spec 保持有效；r3 没有 aggregate 或可解释的产品 Gate 结果。
> 冻结版本的 publisher 还暴露出 case projection schema 缺陷，因此本目录没有伪造或绕过 checkout
> 生成的 formal publication artifact。

r3 是 `v0.3.2-luna-r2` 的独立后继 identity。r2 的 spec、tag、selection、ledger 与已发布的
`invalid` 报告保持不可变；r3 不恢复、拼接或重新解释 r2。r3 只增加一个主要不确定性维度：统一
Conclusion Gate 与 formal terminal validator 对 receipt coverage 缺口的分类。

## 预注册 identity

| 字段               | 预注册值                             | 当前状态                   |
| ------------------ | ------------------------------------ | -------------------------- |
| campaign           | `v0.3.2-luna-r3`                     | 已冻结                     |
| canary             | `v0.3.2-luna-canary-010`             | C0/C1 `ready` / `hardened` |
| formal order seed  | `chronorift-v0.3.2-luna-r3-formal-1` | 已用于唯一 selection       |
| local freeze tag   | `v0.3.2-luna-r3-benchmark-freeze`    | annotated，指向 `6d75448…` |
| suite / definition | `01efdcdc…` / `9e49b4ac…`            | machine spec 已冻结        |
| subject / runner   | `e9f5a659…` / `79702dc0…`            | machine spec 已冻结        |
| formal execution   | `benchmark-execution:9f28a0d8-…`     | `invalid`，不可恢复，16/36 |

selection hash 为 `61f47b0a428c15c4c652740f1a0ae45370318809980c255dd29fc9954e6a872b`；sealed
report hash 为 `09d0af63c9355c637490ff3aacd005f4de3024e4401a1cf7b73d67821bbdbf76`。这些 hash
描述本地不可变 ledger；由于 publisher 缺陷，没有把它们表述为仓库内已发布报告。

## 当前状态

| 工作项                    | 状态         | 完成条件                                                             |
| ------------------------- | ------------ | -------------------------------------------------------------------- |
| r2 failure reproduction   | **已完成**   | 离线测试精确复现 receipt coverage 的错误终态分类                     |
| receipt coverage 分类修复 | **已完成**   | 缺失 coverage 得到 canonical `inconclusive`，不升级 Harness 故障     |
| Canary 010 C0             | **ready**    | 三个 arm 均 scored；verifier prerequisite `hardened`                 |
| Canary 010 C1             | **ready**    | 三个 arm 均 scored；精确绑定 C0 report hash                          |
| r3 machine spec           | **已冻结**   | committed rebuild test 与冻结 commit 一致                            |
| r3 annotated tag          | **已创建**   | 精确指向 `6d754488a00991411c8d171fd21ec9437f1d75cc`                  |
| r3 36-cell formal         | **invalid**  | 16 terminal cells 后停止；11 scored、4 diagnostic、1 Harness invalid |
| aggregate / 产品 Gate     | **不可评估** | aggregate `null`；不得得出 treatment 结论                            |
| formal publication        | **未生成**   | 冻结 publisher 的 receipt projection schema 错误 fail closed         |

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

## R3 formal 终态与第二个 Harness 缺陷

唯一 execution 共封存 16 个 terminal cells：11 `scored`、4 `diagnostic_failure`、1
`invalid/harness_failure`。前 15 个 score-eligible cells 证明 r2 的 receipt coverage 缺口不再使 campaign
停跑；第 16 格（case 03 / generic / repetition 3）则暴露了不同边界缺陷：模型把 scoped `runId` 的一个
字符从 `e` 抄成 `a`，但 `submit_diagnosis_proposal` 当时只校验 Capsule 与 baseline ID，没有校验
`runId/fixtureId`。

Conclusion Gate 对跨 investigation receipts 正确返回 `inconclusive` blockers。随后 terminal manifest
integrity 才发现 proposal 与真实 run 不一致，并将其封为 `invalid/harness_failure`；executor 按 fail-closed
规则停止，execution `recoverable=false`。后继修复必须在 Pi scoped tool 边界拒绝该 proposal，并把它作为
Agent 的 `invalid_proposal` 记为 cell 级 diagnostic failure，不能放宽 manifest integrity。

尝试按冻结 checkout 发布该负向 execution 时，publisher 又因 sanitized receipt 缺少
`schemaVersion: 1` 而在 strict public-case schema 处拒绝写入。没有使用测试 seam 或绕过 provenance 生成
artifact；该投影缺陷与 scope 修复一起进入新的 r4 identity。

## R3 machine spec

[benchmark-spec.v3.json](benchmark-spec.v3.json) 当前固定：

- suite：`benchmark-suite:01efdcdc0e90aa7fbcd64ecc6cc91571f7a9636c7990c444c42adb83e015a875`；
- definition：`benchmark-definition:9e49b4acd9ac304f91b88cbadc464f765cbd966ad9e4d7d5b5556415474425c0`；
- subject hash：`e9f5a65912fa23a605004b9fa18da92faa3b2ad36def1da0fd719a0f839b0e2d`；
- runner hash：`79702dc079aec3fd2179dc95ab4f49ab5cd1955db32b404d32bccdf6fa9457e3`。

这些值已由 committed-spec Godot test 重建，并由 annotated tag 固定在上述 freeze commit。r3 tag 不会因
后继修复或 r4 结果移动。

## 不提前声称的内容

- r3 已完成 36 cells、存在 aggregate 或通过产品 Gate；
- 未生成的 r3 publication artifact 或独立 verifier 结果；
- r3 是否优于 generic arm、通用代码 Agent 或其他产品；
- 四个校准 Fixture 之外的泛化能力。

无论 canary 或 formal 得到正面、负面、incomplete 还是 invalid 结果，都必须按实际状态写入新的
write-once artifact；不得通过覆盖文件、复用 identity 或选择性发布来改变结论。
