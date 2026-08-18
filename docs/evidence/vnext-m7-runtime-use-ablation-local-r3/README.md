# vNext M7 runtime-use ablation local R3 failure evidence

This directory preserves a path-free, sanitized projection of the **only formal R3 command** observed for the
frozen two-case M7 design. The command failed before either Agent arm, while preparing the shared no-Agent
preflight. Its retained classification is **`failed_before_agent_in_shared_no_agent_preflight`**. This is a formal
command failure, not a campaign terminal and not evidence that the runtime-use or runtime-advantage claim passed.

## Retained result

- Run-control attempt 1 started at `2026-08-15T07:45:59.377Z` and ended at
  `2026-08-15T07:48:59.753Z` with `status=failed` and exit code `1`. No retry or reroll was performed.
- Two case-construction receipts and one two-case portfolio freeze were persisted. No preflight receipt, case
  reference, campaign record, campaign terminal, arm claim, arm result, candidate patch, runtime-use evidence, or
  evaluator evidence was persisted.
- The retained count projection is Agent launches `0`, Pi Sessions `0`, and provider invocations `0`. The
  operational manifest and realized cgroup topology independently bind those counts only at their pre-Agent seal
  and observation. The later interval has no independent continuous lifecycle attestation; its zero-count
  classification is the narrower Operator projection supported by the failure location and retained filesystem
  inventory.
- Exactly two compatibility-only Godot launches produced compatible receipts, one per case. Both record an
  instrumented launch, bridge handshake, complete zero-loss observation coverage, and scoped cleanup fields. They
  do not constitute public behavior reproduction, a completed no-Agent preflight, Agent runtime observation, a
  repair, or evaluator acceptance.
- The exact number of no-Agent public launches is unknown within the retained `0..2` bound; zero preflight receipts
  do not prove that no launch began. Hidden-evaluator process count `0` has narrower evidence: both case-scoped
  preflight evaluator-temporary directories were empty and their mtimes predated the formal command, while the
  evaluator path must create a fresh temporary directory before starting its process. This does not attest every
  other action after the pre-Agent seal.
- Per-case preparation cleanup summaries and all four unstarted-arm cleanup receipts record scoped cleanup as
  proven. Cleanup and sandbox-security closure for the shared no-Agent preflight remain unknown. Four empty
  `root:root`, mode-`0755`, link-count-2 mountpoint stubs remain at the two cases' `materials` and `sensor` relative
  scopes. They prevent an overall cleanup-proven claim; an unknown result does not by itself establish that a
  cleanup or security violation occurred.

## Claim boundary and R2 counterevidence

R3 provides no evidence that an Agent saw or used ChronoRift runtime information: neither arm started, no runtime
evidence or patch was retained, and no paired comparison completed. It therefore does not support the target
runtime-use or relative runtime-advantage claim.

R3 also does not erase the R2 result. The separate R2 archive retains a code-only candidate accepted by its formal
hidden evaluator 9/9 under the R2 frozen design. That remains counterevidence to the intended relative-advantage
claim for that earlier mutation/run, while R2's runtime arm infrastructure failure prevents the opposite general
conclusion. Read the two archives together:

- [R2 retained campaign evidence](../vnext-m7-runtime-use-ablation-local-r2/README.md)
- this R3 pre-Agent formal command failure

Neither result supports a general claim about Agent capability, success rate, reliability, or arbitrary Godot
projects.

## Archive scope and limitations

`failure-payload.v1.json` is the sanitized evidence projection. `freeze-record.v1.json` binds its bytes and the
private source-record hashes used for the projection. The private run-control, operational, construction,
portfolio, compatibility, cleanup, and forensic source records are deliberately not copied, so this checkout
cannot independently recompute those source hashes or strengthen the projection beyond its stated boundary.

The archive excludes hidden mutation and evaluator bytes, absolute private paths, credentials and authentication
material, model requests, assistant prose, Pi Session data, and private source records. It contains no candidate or
evaluator payload. SHA-256 values detect changes to bytes; they are not signatures, external attestations, or proof
that the local Operator could not alter the archive. This archive records the consumed attempt and does not
authorize another R3 Agent attempt.

## Local validation

From this directory:

```bash
sha256sum --check SHA256SUMS

node -e '
  const fs = require("node:fs");
  const crypto = require("node:crypto");
  const normalize = (value) => Array.isArray(value)
    ? value.map(normalize)
    : value && typeof value === "object"
      ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalize(value[key])]))
      : value;
  for (const name of ["failure-payload.v1.json", "freeze-record.v1.json"]) {
    const record = JSON.parse(fs.readFileSync(name, "utf8"));
    const expected = record.recordContentSha256;
    delete record.recordContentSha256;
    const actual = crypto.createHash("sha256")
      .update(JSON.stringify(normalize(record)))
      .digest("hex");
    if (actual !== expected) process.exit(1);
  }
  const payload = JSON.parse(fs.readFileSync("failure-payload.v1.json", "utf8"));
  if (payload.formalFailure.outcome !== "failed_before_agent_in_shared_no_agent_preflight") process.exit(1);
  if (payload.persistenceInventory.constructionReceiptCount !== 2) process.exit(1);
  if (payload.persistenceInventory.portfolioFreezeCount !== 1) process.exit(1);
  if (payload.persistenceInventory.preflightReceiptCount !== 0) process.exit(1);
  if (payload.persistenceInventory.caseReferenceCount !== 0) process.exit(1);
  if (payload.persistenceInventory.campaignRecordCount !== 0) process.exit(1);
  if (payload.persistenceInventory.armClaimCount !== 0) process.exit(1);
  if (payload.executionCounts.agentLaunchCount !== 0) process.exit(1);
  if (payload.executionCounts.piSessionCount !== 0) process.exit(1);
  if (payload.executionCounts.providerInvocationCount !== 0) process.exit(1);
  if (payload.executionCounts.compatibilityGodotInvocationCount !== 2) process.exit(1);
  if (payload.executionCounts.noAgentPublicLaunchCount.minimum !== 0) process.exit(1);
  if (payload.executionCounts.noAgentPublicLaunchCount.maximum !== 2) process.exit(1);
  if (payload.executionCounts.noAgentPublicLaunchCount.exact !== null) process.exit(1);
  if (payload.executionCounts.hiddenEvaluatorInvocationCount !== 0) process.exit(1);
  if (payload.cleanupBoundary.retainedMountpointStubs.length !== 4) process.exit(1);
  if (payload.cleanupBoundary.sharedNoAgentPreflightCleanupProven !== null) process.exit(1);
  if (payload.cleanupBoundary.sharedNoAgentPreflightSecurityProven !== null) process.exit(1);
  if (!payload.claimAssessment.r2CounterevidenceStillApplies) process.exit(1);
'
```

The hidden inputs and raw private records are intentionally absent, so this archive cannot rematerialize either
case, rerun the no-Agent preflight, start an Agent, or execute the evaluator.
