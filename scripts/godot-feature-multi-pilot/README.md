# Godot feature-task comparison

This case-local runner compares Single with the current Adaptive Multi implementation on the requested upstream PR tasks, in order: Maaack/Godot-Game-Template #498, #180, then bitbrain/beehave #332. It does not modify Runtime, cooperation tool prompts, locks, or the investigation strategy during a batch.

Prepare all three decisions offline before freezing the eligible list. Each private `prep/<caseId>/manifest.json` records complete upstream base/reference commit and tree identities, the public task/API contract, a pinned Godot binary, a hidden evaluator and its dependencies, baseline/reference/negative controls, and `ready` or `blocked`. A ready task requires a normally importing baseline that lacks the feature, a reference satisfying the complete behavior contract, and rejection of relevant incorrect implementations. Reference incompatibilities and behavioral failures block a task; they are not waived to obtain a model trial.

The model source is a clean, parentless single-commit snapshot of the complete baseline. The runner checks that it has no remote, additional commit/tag objects, or worktree changes and passes the existing public source preflight. Reference patches, later Git history, evaluator sources, and preparation records remain outside Root/Worker workspaces and prompts. Evaluators apply candidate patches inside the existing coding sandbox, import in disposable stages, and execute with read-only source and integrity checks. No model-visible repository is modified during preparation or scoring.

Both arms receive the same requirements and general coding, stopping, verification, and resource instructions. Multi adds the unchanged product collaboration tools and a short explanation of shared writes and limits. Workers may deliver bounded implementations, investigations, or validation; there is no fixed count or role assignment. The pinned provider/model/effort is `openai-codex/gpt-5.6-luna/max`, with a 20-minute overall investigation deadline, a shared 256-execution-call budget, and up to three direct workers. Existing worker limits remain 10 minutes and 64 execution calls per turn. The deadline includes Host startup; cleanup can continue after cancellation and is included in separately recorded end-to-end time.

Trials run serially with fresh Session, state, and candidate directories. The first arm alternates by eligible task: Single/Adaptive, Adaptive/Single, Single/Adaptive. The immutable batch permits one attempt per arm, at most six model trials. No automatic result-based retries or strategy revisions are provided. Product bytes, inputs, evaluator dependencies, model metadata, and baseline identities are rechecked before each trial. A surviving observed process prevents the next trial from starting. Existing Pi retries remain part of that one investigation and are recorded.

Use the pinned Node 22.23.1 environment:

```bash
node --dns-result-order=ipv4first --import tsx scripts/godot-feature-multi-pilot/run.mjs freeze --preparation /private/prep --output /private/new-batch
node --dns-result-order=ipv4first --import tsx scripts/godot-feature-multi-pilot/run.mjs run --output /private/new-batch
node --dns-result-order=ipv4first --import tsx scripts/godot-feature-multi-pilot/run.mjs evaluate --output /private/new-batch
node --dns-result-order=ipv4first --import tsx scripts/godot-feature-multi-pilot/run.mjs summarize --output /private/new-batch
```

`freeze`, `evaluate`, and `summarize` do not invoke models. `run` deliberately invokes the provider for each eligible arm. If all cases are blocked, it records zero model trials and no performance observations. Every output is append-only; an existing batch claim prevents accidental reruns.

After writers stop, each frozen final patch is independently evaluated twice for deterministic scoring consistency; these checks do not add model samples. The existing summarizer supplies per-agent usage, SDK cost estimates and incompleteness, request/tool timestamps, lock waits, lifecycle milestones, and domain-aware game outcomes. Read the private tool records to assess actual worker delivery and edit scope, evidence reuse, duplicated investigation, and necessary work that overlapped. Token reduction alone is not proof of substitution or critical-path improvement. A zero-worker result is valid but cannot demonstrate collaboration acceleration.

Raw Sessions, commands, model messages, hidden evaluators, and full process output remain local and untracked. Publish only reviewed metadata, requirements, scoped behavioral evidence, and a Markdown report with limitations. Keep all blocked cases, failed starts, unsuccessful candidates, and negative comparisons.

Offline runner regressions:

```bash
node --dns-result-order=ipv4first --import tsx --test scripts/godot-feature-multi-pilot/*.test.mjs scripts/godot-feature-multi-pilot/cases/*/*.test.mjs
```
