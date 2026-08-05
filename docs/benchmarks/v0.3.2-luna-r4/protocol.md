# r4 freeze and execution protocol

## 1. Change boundary

r4 preserves r3's fixtures, arms, repetitions, prompt blinding, model, budgets, retries, metric set, case
preselection and Gate. It adds no new game capability. The implementation delta is limited to:

1. rejecting proposal `runId/fixtureId` mismatches at the Pi scoped submit boundary as `INVALID_DIAGNOSIS`;
2. preserving receipt `schemaVersion: 1` in the sanitized public case projection;
3. adding strict regressions and a new immutable campaign identity.

GameBranch raw-manifest, lineage, canonical receipt, verdict and scoring-proof checks remain unchanged. In
particular, true Harness corruption still makes the execution `invalid`; only an Agent-authored out-of-scope
proposal becomes a local diagnostic failure.

## 2. Pre-freeze gates

Before the annotated tag is created:

- the exact r2 receipt-gap fixture must seal as scored `inconclusive` with its canonical blocker;
- wrong proposal run and fixture IDs must be rejected before proposal latch;
- a completed V3 manifest with a non-empty receipt must sanitize and validate with `schemaVersion: 1` intact;
- `corepack pnpm check` and `corepack pnpm test:godot` must pass;
- canary-011 C0 and C1 must both be `ready/hardened` and bind the same clean implementation receipt;
- the committed r4 spec must rebuild identically from runtime source and fixture materials.

## 3. Formal identity and single execution

The formal identity is frozen in [benchmark-spec.v3.json](benchmark-spec.v3.json): campaign
`v0.3.2-luna-r4`, seed `chronorift-v0.3.2-luna-r4-formal-1`, tag
`v0.3.2-luna-r4-benchmark-freeze`, 36 cells, and case 03/full/r1 preselection. Formal may start only from a clean
checkout where the annotated tag resolves exactly to `HEAD`.

Only the first persisted selection is admissible. If the Harness reports `recoverable=true`, resume that exact
execution ID; otherwise never replace, splice or reroll it. Every terminal model diagnostic failure remains in the
matrix. An `invalid` Harness cell still fails closed and ends the campaign.

## 4. Completion and product Gate

Pipeline completion requires `status=complete`, 36 terminal cells, 12 per arm, non-null aggregate, exact scoring
proofs, successful publication, and independent verifier `issues=[]`. A diagnostic failure is a terminal,
score-eligible zero; `infra_unavailable` remains unscored and visible.

The frozen product Gate additionally requires all three arms to have 12 score-eligible cells, full grounded
successes at least 9/12, full-minus-generic grounded-success rate at least 0.20, and zero full incorrect
confirmations. Pipeline completion and product Gate outcome must be reported separately.

Even a passing Gate supports only this Luna Max run over four calibrated fixtures. It is not evidence of
statistical significance or superiority to general-purpose products.

## 5. Frozen execution record

The annotated freeze tag resolves to commit `c03237bea8c9767aa8a956d4e3db9a17e680ad94`. The first persisted
selection was executed exactly once as
`benchmark-execution:22c2dee9-e508-41fe-b0db-2e90de8a2b7b`, with selection hash
`fd5faf448e71cbd8156ca4c202f70dc9074b67b32830634f796ba722e463eaf0`.

The execution completed all 36 cells and sealed report hash
`7aef5376cca43bfd01bdef8ca46b73357c9d5608c83295ba9812de80dd897b2f`. Independent verification returned
`issues=[]`. The product Gate returned `fail`: full grounded success was 6/12 against 9/12 required, and the
full-minus-generic rate was 0.00 against 0.20 required; full incorrect confirmations remained zero. The six
local diagnostic failures are preserved in the report and were not retried or replaced.
