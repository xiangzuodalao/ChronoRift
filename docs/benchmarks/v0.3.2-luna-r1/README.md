# v0.3.2-luna-r1 evidence workspace

本目录用于独立的 `v0.3.2-luna-r1` formal identity。它不改写原
`v0.3.2-luna-benchmark-freeze`、旧 selection 或历史 ledger。

## 当前状态

| 项目                         | 状态                     | 可验证事实                                                         |
| ---------------------------- | ------------------------ | ------------------------------------------------------------------ |
| Canary 006 C0                | `ready` / `hardened`     | C0 report 已封存并公开                                             |
| Canary 006 C1                | **interrupted**          | parser 计数语义缺陷；只有 generic cell，无 C1 report；禁止恢复     |
| Canary 007 C0/C1             | `ready` / `hardened`     | 六个 cells 均 scored、mechanism correct、零 incorrect confirmation |
| r1 machine spec / freeze tag | **已冻结**               | definition `75d8a1b7…`；本地 tag 固定当前 spec                     |
| r1 formal report             | **已发布负结果**         | 3 cells：2 scored、1 invalid；aggregate `null`                     |
| verifier / Gate              | `true` / `not_evaluated` | verifier exit 0；Gate exit 2；无 treatment 结论                    |

## R1 freeze

[benchmark-spec.v3.json](benchmark-spec.v3.json) 固定：

- suite：`benchmark-suite:a365f378c28b59ea18215434dd435f10be6cf4785fcf07deb2f6aaedcc22c4e4`；
- definition：
  `benchmark-definition:75d8a1b7e330ce11b8df1f7c3eb70708a0efc7f4d78bdab65fe7e6dc7da91802`；
- subject hash：`1ce7b053665eb65b0593b6ef6c7dc2ea5c075f6ebf5ea84d001ce27193bf7d82`；
- runner hash：`134421294496a8262491228e648abdd04ded78f007a9614eff68d4254f90cd9e`；
- freeze tag：`v0.3.2-luna-r1-benchmark-freeze`。

该 spec 保留 4 fixtures × 3 arms × 3 repetitions、Luna Max、单并发、冻结预算与预注册 Gate。旧
`v0.3.2-luna` definition 和 selection 不参与 r1 聚合。

## Canary 007

007 绑定以下干净 implementation receipt：

- commit：`4f64637bdd5964b9e42e1b5e6bc53f355b491c06`；
- source hash：`7a91bb9d3c21f54c6f50a4ef9e4b54a8ab1929518562a06d00b946e23240b0bd`；
- source files：139；
- `sourceWorktreeDirty=false`。

[C0-007](canary-c0-ready-007.json) report hash 为
`3e281489da8678242e5583d0af159960faa8e150c3744158991a7b7c009de608`；
[C1-007](canary-c1-ready-007.json) report hash 为
`d11a455e404473930241a3c8cdca438c7d591c25964fe69037b3e966eacd3e98`，并精确绑定上述 C0 hash。
两份独立 verifier 均返回 `prerequisiteEligibility=hardened`。

六个 cells 均为 `scored`、mechanism correct、零 tool errors、零连续无语义进展结果、零 incorrect
confirmation。C0 的 generic/evidence-only/chronorift-full verdict 依次为
`confirmed` / `inconclusive` / `confirmed`；C1 三组均为 `inconclusive`。C0/C1 各记录 20 次工具调用、
8 次游戏执行；token total 分别为 169,576 与 244,105。

这些事实只证明当前实现满足 hardened canary 前置，不证明正式 36-cell treatment 优势或产品 Gate
通过。

## R1 formal 结果

[benchmark-report.v3.json](benchmark-report.v3.json) 对应 execution
`benchmark-execution:3207d7d4-9e14-40bc-bca0-840897416739`，selection hash 为
`c869f64755c7cd1a871ba05263d7d75aa4acee786653d9976b8ef6624442c6e3`，report hash 为
`ef08aa6a727093ce8b9741d188a5b0b2bdbb0240e82a6a39d1265cb42e28b77d`。execution 以 `invalid`
封存并发布：3 attempts / 3 cells，其中 2 个 `scored`、1 个 `invalid` / `harness_failure`；公开报告含
2 个 scoring proofs，aggregate 为 `null`。完整性 verifier 返回 `verified=true`；产品 Gate 为
`not_evaluated`，命令 exit 2。

本地 ledger 表明 invalid cell 中，Harness 正确拒绝了引用 ungrounded event 的 proposal，并形成
diagnostic `invalid_proposal` 与一次 tool error；但预算校验 allowlist 漏掉 `invalid_proposal`，随后将其
升级为 `harness_failure`。因此这是 Harness 分类缺陷暴露出的有效负结果，不能用于比较 treatment。
可读汇总见 [results.md](results.md)；预选 case bundle 为 `absent` / `raw_manifest_unavailable`。

## Canary 006

[C0-006](canary-c0-ready-006.json) 已合法封存为 `ready` / `hardened`。C1 随后暴露 canary parser
将 failed 工具调用重复计数的缺陷，并在写入 failure cell 前中断。完整边界见
[canary-006-interrupted.md](canary-006-interrupted.md)。006 不得恢复，也不能与 007 拼接。
