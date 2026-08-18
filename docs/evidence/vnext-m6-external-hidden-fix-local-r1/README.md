# vNext M6 external hidden-fix local r1 evidence

This directory preserves the sanitized result of the **only formal M6 live attempt** for this frozen assignment.
The local run used one real `openai-codex/gpt-5.6-luna/max` Agent turn against the mutated
`endlessm/moddable-platformer` subject and ended as **`workflow_rejected`**. This is a retained failed attempt, not a
passed Gate.

## Observed result

- Assignment: `m6-assignment:346413c0071fb0492b6f4368`; attempt ordinal `1`; one user turn.
- Frozen mutated selected tree:
  `57d93349c41eb47917f4d361300151a1703e4260679bcef87cd977adfbc077fc`.
- The Agent left a 476-byte, one-file GDScript patch with SHA-256
  `750cd0dbc8a694d14c0288416bba6836606821e5525ec993b79119db4bac0230`. Patch round-trip was verified, and its
  candidate selected tree `3e8bd6478d53586284010da38959005e2a377ef6277b2a838ecb1538abc096e8` exactly equals the frozen pristine
  selected tree.
- The public workflow accepted `single_agent_turn`, `candidate_patch_frozen`, and `patch_round_trip_verified`.
  It rejected `baseline_execution_before_host_observed_source_change`, `candidate_rerun_observed`,
  `execution_lineage_valid`, and `cleanup_proven`.
- The candidate-execution evidence hash is the canonical empty-array digest, so the workflow had zero qualifying
  candidate executions. The baseline check shows that the Host observed a source-identity change without first
  finding a fully qualifying baseline execution.
- The create-once terminal was written with outcome `workflow_rejected` and a non-null Task cleanup-receipt hash;
  it was not `cleanup_failed`. The workflow-level cleanup check remained false because the required qualifying
  execution set was incomplete. The retained hashes do not support a more detailed runtime diagnosis.
- Because workflow verification failed, the **formal** hidden evaluator was never started: evaluator records `0`,
  evaluator processes `0`, executed fresh-copy runs `0/9`, and `evaluatorReceiptSha256=null`.
- The formal command exited `1` after Vitest compared the durable terminal outcome with the live test's required
  `accepted` outcome. After exit there were no matching live containers, the evaluator temporary root was empty,
  and both pristine and mutated source authorities remained Git-clean.

The patch reaching the pristine selected-tree identity is useful evidence that the Agent produced the expected
source delta. It is **not** hidden-evaluator acceptance: the required public runtime workflow did not qualify, so
the fresh-copy oracle was correctly not invoked. This run therefore does not prove that ChronoRift can complete
the target investigation → runtime observation → modification → rerun → hidden acceptance loop.

## Post-terminal patch diagnostic — not Gate acceptance

After the create-once formal terminal was frozen, the Operator ran one evaluator-only diagnostic against the same
frozen assignment baseline, patch, candidate-tree identity, evaluator implementation, bundle, and 3×3 plan. The
diagnostic is explicitly classified `diagnostic_not_gate_acceptance`; it did not relaunch the Agent and did not
create a formal evaluator request or result before or after the diagnostic.

The diagnostic completed nine unique fresh copies: `public_reproduction × 3`, `hidden_variant × 3`, and
`regression_control × 3`. Every receipt records a fresh workspace, import cache, and evaluator process; all nine
outcomes passed, all nine cleanup flags are true, the evaluator temporary root ended empty, and the diagnostic
terminal records `cleanupProven=true`. Its content hash is
`02661e9ed60719b0e6f485e0a8a56e2506b2a816a99d17ac34c13d45092c4748`; the exact private source terminal's raw
SHA-256 is `0b45ff0ef2961051d442a5de5cca4268fd3765b07def150e9e4e607ec903191f`.

This supports the narrow statement that the Agent's frozen patch passed the same local oracle in a later isolated
diagnostic. It cannot retroactively supply the missing Agent runtime workflow, change the immutable formal terminal,
or establish M6 Gate acceptance. The formal result remains **`workflow_rejected`, evaluator `0/9`**.

## Archive scope and limitation

`attempt.json`, `workflow.json`, `terminal.json`, `public-task.json`, `public-classifier.mjs`, and `candidate.patch`
are byte-exact copies of the retained source artifacts. `assignment-summary.v1.json` deliberately omits Host-only
absolute paths while retaining the original assignment file/content hashes and the identities of private inputs.
`post-terminal-diagnostic-summary.v1.json` is a path-free projection of the separately frozen diagnostic terminal;
it retains all nine receipt identities/outcomes and binds the exact source terminal by content and raw SHA-256.
The hidden mutation, evaluator implementation/bundle, their preflight bytes, Pi session, model request, credentials,
assistant prose, and raw operator log are not included.

The Agent Task/runtime records lived in the formal container's tmpfs task storage and disappeared when the
`--rm` container exited. Consequently this archive preserves the workflow booleans and their evidence hashes, but
cannot reconstruct the exact runtime predicate that disqualified each execution. This is an evidence-retention
limitation of this local attempt. The archive also does not preserve a clean ChronoRift product-subject commit.

This is a local, unprotected Operator archive. SHA-256 values bind bytes and detect corruption; they are not
signatures, external attestations, or proof that the Operator could not alter the run.

## Local validation

From this directory:

```bash
sha256sum --check SHA256SUMS

node -e '
  const fs = require("node:fs");
  const terminal = JSON.parse(fs.readFileSync("terminal.json", "utf8"));
  const workflow = JSON.parse(fs.readFileSync("workflow.json", "utf8"));
  const diagnostic = JSON.parse(
    fs.readFileSync("post-terminal-diagnostic-summary.v1.json", "utf8"),
  );
  if (terminal.outcome !== "workflow_rejected") process.exit(1);
  if (terminal.evaluatorReceiptSha256 !== null) process.exit(1);
  if (workflow.outcome !== "rejected") process.exit(1);
  if (workflow.patchIdentity.patchSha256 !== terminal.patchSha256) process.exit(1);
  if (diagnostic.classification !== "diagnostic_not_gate_acceptance") process.exit(1);
  if (diagnostic.formalTerminalOutcome !== "workflow_rejected") process.exit(1);
  if (diagnostic.runs.length !== 9 || !diagnostic.allEvaluatorOutcomesPassed)
    process.exit(1);
  if (!diagnostic.cleanupProven || diagnostic.agentRelaunched) process.exit(1);
'
```

The hidden mutation is intentionally absent, so this public archive alone cannot rematerialize the mutant or rerun
the evaluator. The frozen assignment remains consumed; this archive is not authorization to launch another Agent
attempt for it.
