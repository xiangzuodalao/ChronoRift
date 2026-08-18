# vNext M7 runtime-use ablation local r2 evidence

This directory preserves the sanitized result of the **only formal R2 live campaign** for the frozen M7 assignment.
The local command ran the runtime-enabled arm first and the code-only arm second under the same natural task,
`openai-codex/gpt-5.6-luna/max`, one-turn budget, coding surface, sandbox profile, and mutated baseline. The formal
campaign ended as **`infrastructure_failure / arm_infrastructure_failed`**. This is a retained experiment failure,
not evidence that runtime use or a runtime advantage was established.

## Observed result

- Campaign: `m7-campaign:c1c1494b62e725605e4f1787`; arm order `runtime_enabled → code_only`; one claimed
  attempt per arm. The retained arm records contain `observedTurnCount=1`, but the runtime arm's ephemeral Pi Session
  is absent, so that field is not treated here as independent proof that its model turn returned successfully.
- The runtime-enabled arm ended with `loopOutcome=infrastructure_failed`,
  `runtimeUseOutcome=infrastructure_failed`, and `infrastructureFailureCode=paired_attempt_unavailable`. It retained
  zero runtime summaries, no baseline fall witness, no verifiable source-change evidence, and no frozen candidate
  patch. That does not prove its ephemeral workspace was never modified. Its cleanup result is recorded as proven.
- The code-only claim explicitly records `runtimeAccessEnabled=false` and `gameToolSetSha256=null`. Under the same
  natural user request, it produced a 1,519-byte patch with SHA-256
  `728f68f8b4e0c3bec94e4cd974618aa1c5b2d676d42165cb264bfcc4f3998be5`. Patch application round-tripped from
  baseline selected tree `9299ab6bfc35072c4cc746a1ac5421c67fc2714ed5e9ec8b3a1c35ebaa24a658` to candidate selected
  tree `b9c1f673ffa9de119e5c3f7622649639f57e6206e5267b892edf284c628a7d12`.
- The code-only patch changes the patrol guard while retaining the `fall_off_edge` opt-out and changes both
  Storyvore edge RayCast collision masks from `1` to `5`.
- The formal hidden evaluator accepted the code-only candidate. It ran `public_reproduction × 3`,
  `hidden_variant × 3`, and `regression_control × 3`; all nine runs passed. Every embedded run records a unique
  fresh-copy identity, a fresh workspace/import cache/process, and `cleanupProven=true`. The evaluator and arm also
  record cleanup as proven.
- The create-once campaign terminal is `infrastructure_failure`, because the runtime-enabled arm failed without
  retaining usable runtime evidence or a frozen candidate. The wrapper command nevertheless exited `0`: that means the
  Harness completed and durably terminalized the campaign, not that the experimental claim passed.
- A post-exit read-only inspection found no matching Godot/Bwrap/Vitest/M7 process, formal container, ChronoRift
  cgroup, or R2 mount. The evaluator temporary root, runtime-enabled patch root, and both per-arm Agent-resource
  roots were empty.

## Claim boundary

The strongest supported repair statement is narrow but real: **the code-only arm's frozen patch passed the frozen
local hidden evaluator 9/9**, including all three intentional-fall regression controls. The patch also directly
changes the source configuration implicated by the public symptom.

This campaign does **not** show that the runtime-enabled Agent saw or used ChronoRift runtime information. That arm
retains no runtime summary, baseline witness, verifiable source-change evidence, or frozen candidate. It also does not show a runtime treatment
advantage: the code-only arm solved this mutation under the same natural prompt and received formal hidden-evaluator
acceptance. Consequently this mutation/run does not support the intended claim that ChronoRift runtime information
enabled a repair that a normal coding Agent would find difficult from source alone. It does not prove the opposite
general claim either, because the runtime-enabled treatment failed at infrastructure level and no valid paired
comparison was completed.

The result still exercises useful Harness plumbing: pre-registration, fixed arm order, one-shot claims, a disjoint
code-only surface, patch freezing and round-trip, nine fresh-copy evaluator processes, create-once results/terminal,
and cleanup retention all occurred in the formal campaign. Those facts are not a substitute for runtime-use
evidence.

## R1 retained history

R1 contains two failed command records: the initial invocation and one explicitly recorded pre-Agent recovery.
Both failed before campaign creation or Agent launch. R1 therefore has `agentLaunchCount=0` and no campaign result;
the local Operator projection records that its four run-control records were not rewritten or treated as an R2 retry
authority. Their exact raw hashes are retained in `run-control-summary.v1.json` and `freeze-record.v1.json`; the R1
raw records themselves are not copied into this R2 archive, so this checkout cannot independently recheck that
non-rewrite assertion from their bytes alone.

## Archive scope and limitations

The following are byte-exact copies of public or sanitized retained artifacts:

- `public/`: the paired task and code-only bootstrap task;
- `campaign/`: sensor binding, mutation registration, preflight, both claims, both results, and terminal;
- `evidence/`: runtime-use evidence and code-only evaluator evidence with all nine embedded run objects;
- `patches/code-only.patch`: the only candidate patch;
- `run-control/`: the R2 started and command-result records.

`audit-summary.v1.json` and `run-control-summary.v1.json` are path-free Operator projections produced after the
formal terminal. They do not replace the byte-exact campaign/evidence records. `freeze-record.v1.json` binds the
archive scope, source identities, result boundary, exclusions, and byte hashes.

The hidden mutation bytes, evaluator implementation/bundle bytes, private baseline, absolute private paths,
credentials, Pi session, raw model request, assistant prose, and raw runtime Task records are intentionally absent.
The arm cleanup receipt body lived in ephemeral Task storage; only its hash and the parsed `cleanupProven=true`
result remain. Evaluator run objects are embedded, but raw evaluator observations are represented only by distinct
observation hashes. Therefore this archive supports the recorded evaluator outcomes and linkages, not manual replay
of the private oracle.

This is a local, unprotected Operator archive. SHA-256 values bind bytes and detect corruption; they are not
signatures, external attestations, or proof that the Operator could not alter the run. The assignment and formal
attempt are consumed; this archive is not authorization to rerun either arm or replace the mutation.

## Local validation

From this directory:

```bash
sha256sum --check SHA256SUMS

node -e '
  const fs = require("node:fs");
  const terminal = JSON.parse(fs.readFileSync("campaign/m7.terminal.json", "utf8"));
  const runtime = JSON.parse(
    fs.readFileSync("campaign/m7.runtime-enabled-result.json", "utf8"),
  );
  const codeOnly = JSON.parse(
    fs.readFileSync("campaign/m7.code-only-result.json", "utf8"),
  );
  const evaluator = JSON.parse(
    fs.readFileSync("evidence/code-only-evaluator.json", "utf8"),
  );
  const command = JSON.parse(
    fs.readFileSync("run-control/command-result.v1.json", "utf8"),
  );
  if (terminal.outcome !== "infrastructure_failure") process.exit(1);
  if (runtime.runtimeUseOutcome !== "infrastructure_failed") process.exit(1);
  if (runtime.candidate !== null) process.exit(1);
  if (codeOnly.evaluatorOutcome !== "accepted") process.exit(1);
  if (evaluator.runs.length !== 9) process.exit(1);
  if (!evaluator.runs.every((run) => run.outcome === "passed" && run.cleanupProven))
    process.exit(1);
  if (command.exitCode !== 0 || command.status !== "completed") process.exit(1);
'
```

The hidden inputs are intentionally absent, so this public archive alone cannot rematerialize the mutant or rerun
the evaluator.
