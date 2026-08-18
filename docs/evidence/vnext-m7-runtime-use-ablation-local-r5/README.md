# vNext M7 runtime-use ablation local R5 failure evidence

This directory preserves a path-free, sanitized projection of the **only formal R5 command**. Its `exit 0` means
only that the wrapper terminalized the workflow and retained records; it is not a successful experiment or verdict.

## Retained result

- Formal shared no-Agent preflight passed `2/2`; Agent, Pi Session, and provider counts were `0` in that preflight
  scope.
- Case 01 persisted a runtime-enabled claim whose Task binding equals the paired public-contract file hash, crossing
  the R4 blocker. The attempt then marked the Pi wrapper boundary but retained no Pi result/event, Agent turn,
  delivery, persisted Pi Session, source change, qualifying runtime evidence, candidate, or patch. The original
  exception and whether a provider request occurred after preflight are unrecoverable.
- `runner_result_invalid` is a secondary trace/sidecar matcher failure. The runner persisted a valid empty trace,
  but the failed-attempt matcher incorrectly required a null trace when `result=null`; its fallback discarded the
  trace hash and replaced the original failure. The resulting envelope mismatch made delivery unavailable to the
  Gate.
- Actual arm cleanup `eaba88bb…` is `proven=true` (process group terminated, cgroup unpopulated, scope removed,
  storage reconciled). The invalid envelope made the Gate discard that truth and emit terminal `cleanup_failed`;
  this is not evidence of an active residual.
- A second recording mismatch paired `sandboxSafetyFailure=false` with a non-null informational safety-summary
  hash where the residual DTO required null. Strict validation raised `ZodError` and retained a conservative
  residual-cleanup failure.
- Case 02 was `not_started_safety_stop`. Code-only never started in either case. There is no candidate, patch,
  post-Agent candidate-evaluator invocation, or paired comparison, so R5 does not support runtime use or runtime
  advantage and
  does not replace R2's code-only formal 9/9 counterevidence.

## Evidence boundary

Post-exit read-only inspection found no matching active container, process, mount, populated protocol cgroup, or
disposable root. The sandbox sentinel succeeded, the safety flag is false, and the empty trace has no integrity
failure. The strongest valid statement is “no safety failure was observed”: complete runtime-broker security-event
retention was unavailable under the inherited legacy M6 boundary.

The attribution uses retained records and matching source control flow that predates the command. The R5 manifest
binds the generic paired-Agent validator, local Gate, formal driver, and preparation implementation, but not the
concrete project-environment paired composer. That source must join any future freeze; this archive does not present
it as cryptographically bound R5 input.

## Validation

`failure-payload.v1.json` is the sanitized projection; `freeze-record.v1.json` binds it. Hidden bytes, private paths,
credentials, prompts, model requests, assistant prose, Pi Sessions, and raw private records are excluded. Hashes
detect byte changes; they are not signatures or external attestations.

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
    const actual = crypto.createHash("sha256").update(JSON.stringify(normalize(record))).digest("hex");
    if (actual !== expected) process.exit(1);
  }
  const payload = JSON.parse(fs.readFileSync("failure-payload.v1.json", "utf8"));
  if (payload.formalNoAgentPreflight.passedCaseCount !== 2) process.exit(1);
  if (payload.formalNoAgentPreflight.countScope !== "formal_preflight_only") process.exit(1);
  if (!payload.case01.runtimeEnabledClaim.pairedContractBindingMatches) process.exit(1);
  if (!payload.case01.piBoundary.piTurnStartedFlag || payload.case01.piBoundary.piResultObserved) process.exit(1);
  if (payload.case01.piBoundary.observedPiEventCount !== 0) process.exit(1);
  if (payload.case01.piBoundary.observedAgentTurnCount !== 0) process.exit(1);
  if (payload.case01.piBoundary.deliveryCount !== 0) process.exit(1);
  if (payload.case01.piBoundary.providerInvocationStatus !== "unknown_unrecoverable") process.exit(1);
  if (payload.case01.attemptRecordingFailure.retainedCodeIsOriginalRunnerFailure) process.exit(1);
  if (!payload.case01.cleanupTruth.actualArmCleanupProven) process.exit(1);
  if (payload.case01.cleanupTruth.gateRecordedCleanupProven) process.exit(1);
  if (payload.case01.cleanupTruth.campaignTerminalOutcome !== "cleanup_failed") process.exit(1);
  if (payload.case01.residualRecordingFailure.errorClass !== "ZodError") process.exit(1);
  if (payload.case02.portfolioDisposition !== "not_started_safety_stop") process.exit(1);
  if (payload.persistenceInventory.candidateCount !== 0) process.exit(1);
  if (payload.persistenceInventory.patchCount !== 0) process.exit(1);
  if (payload.persistenceInventory.postAgentCandidateEvaluatorInvocationCount !== 0) process.exit(1);
  if (payload.persistenceInventory.pairedComparisonCount !== 0) process.exit(1);
  if (payload.postExitBoundary.activeResidualCount !== 0) process.exit(1);
  if (payload.postExitBoundary.fullRuntimeBrokerSecurityHistoryAvailable) process.exit(1);
  if (payload.claimAssessment.targetClaimSupportedByR5) process.exit(1);
'
```

This archive cannot recover the original Pi exception, decide whether a provider request occurred, rematerialize a
hidden case, start an Agent, or run the evaluator.
