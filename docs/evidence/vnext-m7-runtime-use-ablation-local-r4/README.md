# vNext M7 runtime-use ablation local R4 failure evidence

This directory preserves a path-free, sanitized projection of the **only formal R4 command** observed for the
frozen two-case M7 design. The command exited `0`, but that means only that the workflow completed and retained its
results. It produced no campaign terminal or experimental verdict.

## Retained result

- The shared no-Agent preflight passed `2/2`; its Agent, Pi Session, and provider counts are all `0`.
- Both cases then retained `campaign_infrastructure_failure` at `campaign_gate`, before an arm claim or Agent start.
  Each failure records `cleanupProven=true`, `sandboxSafetyFailure=false`, and only
  `sha256("Error")=54a0e8c17ebb21a11f8a25b8042786ef7efe52441e6cc87e92c67e0c4c0c6e78` as its error class.
- Across both cases there are zero arm claims, arm results, candidates, trajectory-use records, and candidate-evaluator
  evidence records. Neither runtime-enabled nor code-only produced an experimental result, so no paired
  differential exists.
- The two preparation cleanup summaries, four unstarted-arm cleanup receipts, and both campaign failures record
  cleanup as proven. A post-exit read-only audit found zero matching active processes, mounts, containers, or
  populated protocol cgroups.
- Four empty `root:root`, mode-`0755`, link-count-2 mountpoint stubs remain at the path-free relative scopes
  `case-01/{materials,sensor}` and `case-02/{materials,sensor}`. They are filesystem entries, not activity residuals;
  activity residual zero does not mean filesystem entry count zero.

## Root cause and evidence boundary

Static inspection of the pre-fix preparation path and its repair diff identifies the exact defect: preparation
populated `claim.binding.publicTaskSpecSha256` with the arm-specific Task hash instead of the paired public contract
hash. The correct invariant is that the campaign claim binds the paired public contract, while
`pairedAttemptBinding.publicTaskSpecSha256` remains arm-specific.

That attribution is not encoded in the retained failure payload. The retained records contain only
`campaign_gate` and the `Error` class hash; they contain no raw message or stack. The exact cause therefore depends
on the static repair diff and control-flow review, not on a stronger causal claim inferred from the record alone.

## Claim boundary and prior rounds

R4 does not show that an Agent saw or used runtime information and does not establish runtime advantage. Read it
beside, rather than over, the prior results:

- [R2](../vnext-m7-runtime-use-ablation-local-r2/README.md) retained a code-only candidate accepted by its formal
  hidden evaluator 9/9, while its runtime arm failed at infrastructure level. R2 does not support runtime advantage.
- [R3](../vnext-m7-runtime-use-ablation-local-r3/README.md) failed before completing shared no-Agent preflight and
  before either Agent arm. It produced no paired comparison and does not support runtime advantage.
- R4 passed no-Agent preflight for both cases but failed both campaigns before claims or Agents. It adds no
  differential result and does not replace either earlier conclusion.

None of these rounds supports a general claim about Agent capability, success rate, reliability, or arbitrary
Godot projects.

## Archive scope and validation

`failure-payload.v1.json` is the sanitized Operator projection. `freeze-record.v1.json` binds its bytes and the
private source-record hashes used for the projection. Hidden mutation/evaluator bytes, private paths, credentials,
model requests, assistant prose, Pi Sessions, and raw private records are deliberately absent. Content hashes
detect byte changes; they are not signatures or external attestations.

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
  if (payload.formalAttempt.commandExitCode !== 0) process.exit(1);
  if (!payload.formalAttempt.workflowCompleted) process.exit(1);
  if (payload.formalAttempt.workflowCompletionIsExperimentalSuccess) process.exit(1);
  if (payload.noAgentPreflight.passedCaseCount !== 2) process.exit(1);
  if (!payload.cases.every((item) => item.campaignFailureStage === "campaign_gate")) process.exit(1);
  if (payload.persistenceInventory.armClaimCount !== 0) process.exit(1);
  if (payload.persistenceInventory.armResultCount !== 0) process.exit(1);
  if (payload.persistenceInventory.candidateCount !== 0) process.exit(1);
  if (payload.persistenceInventory.trajectoryUseEvidenceCount !== 0) process.exit(1);
  if (payload.persistenceInventory.candidateEvaluatorEvidenceCount !== 0) process.exit(1);
  if (payload.cleanupBoundary.postExitActivityResidualCount !== 0) process.exit(1);
  if (payload.cleanupBoundary.retainedEmptyMountpointStubs.length !== 4) process.exit(1);
  if (payload.claimAssessment.targetClaimSupportedByR4) process.exit(1);
'
```

This archive cannot rematerialize either hidden case, start an Agent, or run the evaluator.
