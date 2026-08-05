# v0.3.2-luna-r4 evidence workspace

> **当前状态：canary-011 已 `ready/hardened`，r4 machine spec 已生成；formal 必须等 annotated
> freeze tag 精确指向包含本目录的干净 commit 后才可 first-select。**

r4 是 r3 的独立后继 identity。r3 的 spec、tag、selection 和 `invalid` ledger 保持不可变；r4 不恢复、
拼接或重写 r3。它只修复 r3 真实执行暴露的两个 Harness 边界问题：跨 investigation proposal 在 scoped
submit tool 被错误接受，以及 public case receipt projection 丢失 `schemaVersion`。

## 冻结 identity

| 字段             | 值                                                                                      |
| ---------------- | --------------------------------------------------------------------------------------- |
| campaign         | `v0.3.2-luna-r4`                                                                        |
| canary           | `v0.3.2-luna-canary-011`                                                                |
| order seed       | `chronorift-v0.3.2-luna-r4-formal-1`                                                    |
| annotated tag    | `v0.3.2-luna-r4-benchmark-freeze`                                                       |
| suite            | `benchmark-suite:9c0aacb26cd7e9cf187a1a2b8e52ae3a132913ffb0a84503ef7c0d8b9048712f`      |
| definition       | `benchmark-definition:61a0cf9b8240945d61d8c614baf91f2e8da440794a33ca8dee657cd78552210f` |
| subject hash     | `314958f7037241fbdb0a4c02f9b7e5bf617f7e1fd4eccd253449e18843e9066a`                      |
| runner hash      | `87a0d0351e981c41fda51ad5c1f48c3a1612424c7ae2a14a85c935ae6d1edcf0`                      |
| preselected case | case 03 / `chronorift-full` / repetition 1                                              |

Machine-readable values are in [benchmark-spec.v3.json](benchmark-spec.v3.json). The matrix, model, budgets,
retry policy, metric set and product Gate remain the r3 values: 4 fixtures × 3 arms × 3 repetitions, Luna Max,
single concurrency, and 36 terminal cells required for a complete pipeline.

## Canary-011 hardened evidence

Both reports bind implementation commit `14ca0dd6f6316c06d5398da65d804c3b09a39f59`, source hash
`9e0c0e5ac43b34b7fd4e6fbc02ea4971f216124f49743dd327ac4b18c8bcaa33`, 139 source files and a clean
source worktree:

- [C0 report](canary-c0-ready-011.json):
  `f3f4bdd5d0b65a9b7af74398d84161f3cc518997d5b298e18811a91377e71279`;
- [C1 report](canary-c1-ready-011.json):
  `edb6afa7e444e1983ee7512f40ca50f030c88c51f480bd6a9ed6c0173e4606d3`, with an exact C0
  prerequisite hash.

| Stage | Arm             | Verdict        | Tools | Game runs |  Tokens |
| ----- | --------------- | -------------- | ----: | --------: | ------: |
| C0    | generic         | `confirmed`    |     7 |         3 |  63,262 |
| C0    | evidence-only   | `inconclusive` |     5 |         2 |  31,418 |
| C0    | chronorift-full | `confirmed`    |     8 |         3 |  75,145 |
| C1    | generic         | `inconclusive` |     7 |         3 |  90,509 |
| C1    | evidence-only   | `inconclusive` |     5 |         2 |  47,323 |
| C1    | chronorift-full | `inconclusive` |     8 |         3 | 107,527 |

All six cells are `scored`, mechanism-correct, and have zero incorrect confirmation, tool error and consecutive
non-progress result. Canary readiness validates the real Pi/Godot path; it is not a 36-cell treatment result.

## Boundary fixes

- `V03ToolFlow.submit` now requires proposal `runId` and `fixtureId` to match the parsed Failure Brief. A typo is
  `INVALID_DIAGNOSIS`, which the formal classifier seals as cell-level `invalid_proposal`.
- Receipt coverage gaps remain canonical scored `inconclusive`; Harness does not auto-cite missing receipts.
- Unknown, forged, cross-investigation, lineage-invalid or corrupted artifacts remain fail-closed downstream.
- Public case sanitization preserves receipt `schemaVersion: 1`, while continuing to exclude sessions, prompts,
  credentials, source text, provider payloads and host paths.

See [protocol.md](protocol.md) for the freeze and success rules and [reproduction.md](reproduction.md) for the two
exact regressions. The r3 incident is preserved in [the r3 workspace](../v0.3.2-luna-r3/README.md).

## Claims deliberately withheld before formal publication

- no 36/36 completion, aggregate, verifier or product Gate result;
- no claim that `chronorift-full` beats the generic arm;
- no comparison against Claude Code, Codex or another product;
- no generalization beyond the four calibrated Godot fixtures and frozen Luna Max protocol.
