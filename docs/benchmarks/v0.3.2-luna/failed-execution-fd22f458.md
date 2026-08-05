# v0.3.2-luna execution fd22f458 failure record

> 状态：**非规范的历史工程记录；不可作为 formal report 发布。** 本文不是
> `BenchmarkReportV3`、不是 publisher 产物，也不能作为 verifier 或产品 Gate 的输入。它只记录
> 本地 append-only ledger 的失败形态，不对任何 arm 的诊断能力作结论。

## 冻结身份

- campaign：`v0.3.2-luna`；
- suite：`benchmark-suite:13623e49239ac6b6b0f654bbefb39725efeb149e569814109f29ff4ad4d07c31`；
- definition：`benchmark-definition:65e996ccf9b7a08bc914cc55593d190c572b45f4ae95febab804da38d223c4ed`；
- execution：`benchmark-execution:fd22f458-5640-4379-a290-a180dedb1c66`；
- selection hash：`667d1e0c1f7d1401398ac1a20283139898b79ae1b43d0eac32527d0a4a9d866a`；
- freeze commit/tag：`9aa2c9e26e5c2b36ef8fa11f7260c02712103109` /
  `v0.3.2-luna-benchmark-freeze`。

`benchmark-spec.v3.json`、上述 tag、definition、selection 和本地 ledger 都保持原样。不得移动 tag、
删除 selection、修改历史记录或恢复该 execution 来拼出一个可发布结果。

## Ledger 事实

只读审计得到以下数量：

| 记录类型                    | 数量 |
| --------------------------- | ---: |
| attempt `started`           |   36 |
| attempt `finished`          |   36 |
| terminal cell               |   36 |
| execution `completed`       |    0 |
| canonical report / reportId |    0 |

execution 自身有一条 root `started` 记录；表中的 36 条 `started` 专指 cell attempts。由于没有
execution `completed`，`benchmark:status` 会显示 selection 已存在、execution 已开始但
`reportHash=null`。这不等于一个 incomplete formal report；它表示 execution 没有通过终态封存。

## 失败边界

完成 36 个 cell 后，终态完整性检查发现 3 个 proposal event references 无法在各自 cell 的
Capsule、replay 或 candidate 事件集合中解析：

- `godot-runtime-case-01` / `chronorift-full` / repetition 3；
- `godot-runtime-case-02` / `evidence-only` / repetition 1；
- `godot-runtime-case-01` / `generic` / repetition 3。

这三个引用是不可信模型输出的一部分。本文不复制其原始字符串，也不把时间相邻或模型置信度当作
grounding。引用完整性失败意味着相关 raw manifests 不能进入 canonical aggregate；Harness 因而没有
写入 execution `completed`，publisher 也没有生成 `benchmark-report.v3.json`、results 或 case bundle。
不得从 36 个 cell 记录自行计算或发布 arm 指标，也不得运行产品 Gate。

## 后续边界

修复必须在 proposal 接收边界和 cell 封存边界拒绝 unresolved event references，并通过离线回归后，
使用独立的 `v0.3.2-luna-r1` campaign/spec/freeze tag/definition 创建新的 first selection。旧 ledger 与
`v0.3.2-luna-benchmark-freeze` 继续作为不可改写的历史事实保留。

r1 后续已用独立身份冻结并发布一份 `invalid` 负结果；它不改变本文记录的旧 selection。r1 只有 3
cells、aggregate `null`，verifier 通过但 Gate `not_evaluated`。详见
[r1 evidence workspace](../v0.3.2-luna-r1/README.md)；不得将其解释为 treatment 结论。
