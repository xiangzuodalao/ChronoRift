# v0.3.2-luna-r4 evidence workspace

> **当前状态：唯一一次 r4 formal execution 已从 annotated freeze tag 完整运行至 36/36，公开证据经
> independent verifier 验证无完整性问题；冻结 product Gate 为 `fail`。**

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

## Formal result

Freeze commit `c03237bea8c9767aa8a956d4e3db9a17e680ad94` was tagged with
`v0.3.2-luna-r4-benchmark-freeze`. The first and only selection produced:

- execution `benchmark-execution:22c2dee9-e508-41fe-b0db-2e90de8a2b7b`;
- selection hash `fd5faf448e71cbd8156ca4c202f70dc9074b67b32830634f796ba722e463eaf0`;
- report hash `7aef5376cca43bfd01bdef8ca46b73357c9d5608c83295ba9812de80dd897b2f`;
- `status=complete`, 36/36 terminal and score-eligible cells, 30 `scored` cells and six local
  `diagnostic_failure` cells;
- zero `infra_unavailable`, campaign-level `invalid`, and incorrect confirmation cells;
- independent verifier `issues=[]`.

Five local failures were `invalid_proposal`; one was `invalid_tool_flow`. They remain score-eligible zeros in
the frozen metric and did not terminate the campaign. This is the direct evidence that the r2/r3 Harness
continuation defect is fixed.

| Arm             | Eligible | Diagnostic failures | Grounded success | Mechanism correct | Incorrect confirmation | Game runs | Tools |    Tokens |
| --------------- | -------: | ------------------: | ---------------: | ----------------: | ---------------------: | --------: | ----: | --------: |
| generic         |    12/12 |                   1 |             6/12 |             11/12 |                      0 |        36 |    85 | 1,103,071 |
| evidence-only   |    12/12 |                   2 |             0/12 |             10/12 |                      0 |        24 |    60 |   540,781 |
| chronorift-full |    12/12 |                   3 |             6/12 |              9/12 |                      0 |        36 |    94 | 1,213,944 |

The frozen Gate is **`fail`**: full grounded success is 6/12 instead of the required 9/12, and full minus
generic is 0.00 instead of at least 0.20. The zero-incorrect-confirmation condition passed. Pipeline completion,
artifact integrity and product performance are therefore three separate results: the first two passed; the
third did not.

Published evidence:

- [canonical benchmark report](benchmark-report.v3.json);
- [generated aggregate table](results.md);
- [preselected case 03/full/r1 bundle](case-physics-tunneling-full-r1.json).

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

## Interpretation boundary

- `generic` is the same Pi Session/Agent Loop under a restricted tool-availability arm. It is an internal
  Harness ablation, not Claude Code, Codex, or another complete coding-agent product.
- This run does not show a ChronoRift treatment advantage: full and generic both reached 6/12 grounded success.
- The four fixtures were also used during calibration, there are only three repetitions per cell, and no claim
  of statistical significance or cross-project generalization is made.
- A complete, verifier-clean benchmark is useful engineering evidence even though its frozen product Gate
  failed; the failure is retained rather than rerolled.
