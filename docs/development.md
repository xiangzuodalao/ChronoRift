# Development and conformance

This guide contains developer commands and Host-bound conformance setup. It is operational documentation, not a
claim that a Gate has run or passed. Product boundaries live in [architecture.md](architecture.md), current status
lives in the [README](../README.md) and Architecture Section 21, and frozen results live under `docs/evidence/` and
`docs/benchmarks/`.

## Toolchain

- Node.js `>=22.19`; `.nvmrc` pins `22.23.1` for repository Gate evidence.
- pnpm `11.20.0`, invoked as `corepack pnpm` when no global pnpm is installed.
- The managed installer pins official Godot `4.7.1` for Linux x86_64.
- `apps/cli` pins `@anthropic-ai/sandbox-runtime` to exactly `0.0.74`; upgrades require an explicit compatibility
  change and Host conformance run.
- Live Pi paths use the repository-pinned Pi packages. Provider/model must be supplied at the command boundary;
  `--thinking` currently defaults to `max` when omitted.

```bash
nvm use
corepack pnpm install
corepack pnpm godot:install
corepack pnpm godot:doctor
```

## Local gates

The default, offline Gate is:

```bash
corepack pnpm check
```

It runs lint, formatting, strict TypeScript checking, and deterministic credential-free tests. Godot-related changes
also require:

```bash
corepack pnpm test:godot
```

`test:godot` covers the legacy suites, retained lifecycle/semantic Addons and fixed-case runtimes, and the generic
inspection observer/wire integration. It does not exercise the Linux namespace or SRT filesystem boundary.

## Host-bound sandbox gates

Host conformance is explicit and never silently skipped. The Linux SRT gate requires Node `22.23.1`, Godot `4.7.1`,
Bubblewrap, `socat`, and ripgrep. Unprivileged user namespaces must be enabled; on Ubuntu 24.04 this normally means:

```bash
sudo apt-get install bubblewrap socat ripgrep fontconfig xdg-user-dirs
sudo sysctl --write kernel.unprivileged_userns_clone=1
sudo sysctl --write kernel.apparmor_restrict_unprivileged_userns=0
```

Install Godot with `corepack pnpm godot:install`, then run:

```bash
.github/scripts/run-srt-sandbox-conformance.sh
```

The wrapper verifies Linux x86_64 and the installed SRT package version, checks the required executables, exercises a
real Bubblewrap user namespace, selects the repository-pinned Godot binary when `GODOT_BIN` is unset, and runs the
single `corepack pnpm test:sandbox` suite for coding and real Godot/Preview integration. It does not require root, delegated
cgroups, a bounded-storage mount, immutable toolchain copies, or a Host-config file. SRT initialization failures are
test failures; the product must never fall back to an unsandboxed process.

The sandbox deliberately has two modes. Agent coding commands can read and write their private physical candidate
workspace plus private home/temp/artifact directories. A Godot validation first copies the candidate to a disjoint
Host stage, adds only managed overlays, and runs with project source read-only; only `.godot/`, home, temp, and
artifacts are writable. The mutable candidate is denied to that process, and the stage source SHA-256 is compared
before and after launch. Both modes use SRT's strict empty network allowlist. This is a practical single-user project
boundary, not a claim of cgroup resource quotas, storage accounting, or external attestation.

## Project Environment Preview

The development route is explicit and remains experimental:

```text
corepack pnpm project preview -- [GOAL] \
  --provider PROVIDER \
  --model MODEL \
  [--thinking LEVEL] \
  [--state-root PATH] \
  [--godot-bin PATH] \
  [--project-root RELATIVE_PATH] \
  [--include-untracked RELATIVE_FILE]... \
  [--timeout-ms MILLISECONDS] \
  [--agent-dir PATH] \
  [--json]
```

`--project-root` is relative to the enclosing Git root. `--include-untracked` names one exact selected-project-relative
file and must be repeated on every fresh Preview invocation. Tracked source uses its current working-tree bytes,
including staged/unstaged changes; ignored files and unselected untracked files stay outside the source closure.
The existing source-admission limits still apply. Preview always launches the candidate's configured default main
scene and rejects the removed `--launch-target` flag.

With a goal, source preparation leads directly to the ordinary Pi Loop. Without a goal, stdin and stdout must be
interactive TTYs and `--json` must be absent; otherwise Preview returns `goal_required`. Each invocation gets a new
private candidate and Session. No Adapter generation, conformance, publication, revision binding, or environment
reuse runs, and old `.chronorift/` environment state is neither loaded nor migrated or removed.

`--state-root` selects private ChronoRift state. If omitted, resolution is `CHRONORIFT_STATE_ROOT`, then
`$XDG_STATE_HOME/chronorift`, then `~/.local/state/chronorift`. `--godot-bin` selects the executable; if omitted,
`GODOT_BIN` and then the repository-managed Godot are tried. Paths are canonicalized, the state directory must be
writable, and Godot must report an exact official 4.7.1 Linux x86_64 build. Project-supplied environment variables do
not configure sandbox policy.

With that Host boundary provisioned, an executable Preview invocation is:

```bash
corepack pnpm project preview -- "Investigate the intermittent jump input" \
  --provider openai-codex \
  --model gpt-5.6-luna
```

The Agent receives its ordinary coding tools and exactly three inspection tools, with versioned V1 inputs:

| Tool          | Implemented behavior                                                                                                                                        |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `game_launch` | Import and run the current candidate's default main scene; return execution/source identity, engine version, and scene root. At most one execution is live. |
| `game_query`  | Read current `children`, `properties`, or named `values` from a scene-relative path or execution-local `objectRef`. Omitted target means the main scene.    |
| `game_stop`   | Stop the specified execution and return the saved execution record; repeated stop returns that same result.                                                 |

Children and property descriptions use `offset`/`limit` pagination (default 100, maximum 200); values accepts 1–32
exact property names. Object and Resource values return references that can be queried again without discarding
identity. For example, query a collision node's `shape`, then query the returned reference's `size`; this needs no
project Adapter. Queries report actual process-frame/physics-tick counters and separate Host receipt time. They are
not atomic snapshots: the game continues running, pages can change, and project getters may have side effects.

The managed observer occupies `addons/chronorift_inspection/` and its reserved autoload name. Project source cannot
replace those overlays. Each launch stages the then-current candidate; editing the candidate does not alter an
existing execution. Weak object references expire when the runtime object disappears and do not retain resources or
bind a replacement object. Unsupported values, missing properties, truncation, and process failures stay explicit.

`--json` returns Preview `schemaVersion: 2`, including Session state, candidate patch, and execution-record paths.
Records retain actual import/run outcomes, bounded stdout/stderr, timeout/cancellation, and staged-source integrity.
`completed` means the Pi Loop delivered reviewable output, not that it used a game tool or proved a fix. There are no
Preview probes, history windows, pause/step/input controls, replay, query database, or evidence publication. Temporal
investigation remains a future product slice; GN-1 and Mob continue to use their original fixed-case contracts.

PE-A and PE-B real-model evidence producers have been retired. Their frozen historical bytes and original trust limits
remain in the [PE-A archive](evidence/vnext-project-environment-pe-a-local-r1/README.md) and
[PE-B archive](evidence/vnext-project-environment-pe-b-local-r1/README.md); current HEAD does not regenerate or validate
those bundles.

## GN-1 external-project matched ablation

GN-1 is a separate experimental implementation, not a Project Environment Preview or Gate. Provision a local clone
of `endlessm/moddable-platformer` at exact commit `e78b339500dec8e480b33723c4156bf9b74cd25c` and tree
`9941cb045b3cd73c4554ca1de337a341b383590b`. The checkout must be clean and must not contain `.chronorift/`; each
command validates these facts and does not clone, fetch, alter, or apply a patch to the source checkout.

Use the same fail-closed SRT prerequisites described above. Run each arm with a fresh private workspace and save
its versioned JSON separately:

```bash
corepack pnpm demo:platform-alias-ablation -- \
  --arm coding-only \
  --project /absolute/path/to/moddable-platformer \
  --provider openai-codex \
  --model gpt-5.6-luna \
  --thinking max \
  --timeout-ms 600000 \
  --state-root /absolute/path/to/chronorift-state \
  --godot-bin /absolute/path/to/Godot_v4.7.1-stable_linux.x86_64 \
  --json > coding-only.json

corepack pnpm demo:platform-alias-ablation -- \
  --arm chronorift \
  --project /absolute/path/to/moddable-platformer \
  --provider openai-codex \
  --model gpt-5.6-luna \
  --thinking max \
  --timeout-ms 600000 \
  --state-root /absolute/path/to/chronorift-state \
  --godot-bin /absolute/path/to/Godot_v4.7.1-stable_linux.x86_64 \
  --json > chronorift.json

node scripts/evaluate-platform-alias-ablation.mjs coding-only.json chronorift.json
```

`--state-root` and `--godot-bin` are optional under the lookup described above. The matched command fixes provider/model to
`openai-codex/gpt-5.6-luna`, thinking to `max`, and the default timeout to 600 seconds; mismatching values fail closed.
There is no fake-model fallback. Each arm receives the same exact source, neutral symptom prompt, `coding`
environment profile, and task-id-only environment instruction profile. It receives the same `read`, `bash`, `edit`,
`write`, `grep`, `find`, `ls`, and raw `godot_run` tools. The treatment's only tool-surface addition is
`game_capabilities`, `game_launch`, `game_stop`, and `game_query`; the common prompt does not name ChronoRift, a game
tool, `platform_geometry`, a cause, a patch, or a required tool order. The two runs intentionally have distinct
fresh-run namespaces, physical workspaces, and Pi Session identities.

Each command materializes a private candidate workspace, records the Agent's candidate diff, and performs a Host-only
candidate observation on the resulting Build. The treatment may additionally launch and query ProjectAdapter V1
during its normal Pi Loop. Every Godot launch copies the exact Build into an execution-private tree, seals admitted
source read-only, and leaves only `.godot/` writable for import cache. Runtime/tool results bind the fresh run, Build,
runtime, Execution, and tool-call identities. Cleanup receipts and the untouched source-checkout status are retained.

The standalone evaluator is independent of product TypeScript. It strictly validates both result envelopes, matched
configuration, distinct run identities, tool surface and calls, patch byte length/hash, Build/Execution lineage,
cleanup, runtime errors, and the project-specific geometry/identity oracle. A successful treatment semantic-use check
requires a successful `platform_geometry` state query bound to a prior successful launch; merely calling a game tool
is insufficient. The evaluator reports both arm outcomes and has no winner or general-superiority field.

This path deliberately bypasses Project Environment initialization/publication/reuse, V2 history, capture/pin,
checkpoint/replay, evidence packaging, verdicts, and apply. Outputs remain local-only unless separately archived;
the command does not create a frozen repository bundle or Gate. One project, revision, prompt, and pair cannot
establish candidate acceptance, general superiority, universal causality, success rate, or arbitrary-project support.

## Godot demo Mob-orientation V2 slice

This case is separate from GN-1 and uses the public ProjectAdapter V2 loader/runtime with a checked-in, prevalidated,
state-only Adapter. Prepare a clean clone of `godotengine/godot-demo-projects` at commit
`711822a319c4333a8740522f3c71e97783199fb0`, then pass its `3d/squash_the_creeps` directory. Run exactly one fresh arm
at a time, in the frozen order shown here:

```bash
mkdir -p .chronorift/godot-demo-mob-orientation

corepack pnpm demo:mob-orientation-ablation -- \
  --arm coding-only \
  --project /absolute/path/to/godot-demo-projects/3d/squash_the_creeps \
  --provider openai-codex \
  --model gpt-5.6-luna \
  --thinking max \
  --timeout-ms 600000 \
  --state-root /absolute/path/to/chronorift-state \
  --godot-bin /absolute/path/to/Godot_v4.7.1-stable_linux.x86_64 \
  --json > .chronorift/godot-demo-mob-orientation/coding-only.json

corepack pnpm demo:mob-orientation-ablation -- \
  --arm chronorift-v2 \
  --project /absolute/path/to/godot-demo-projects/3d/squash_the_creeps \
  --provider openai-codex \
  --model gpt-5.6-luna \
  --thinking max \
  --timeout-ms 600000 \
  --state-root /absolute/path/to/chronorift-state \
  --godot-bin /absolute/path/to/Godot_v4.7.1-stable_linux.x86_64 \
  --json > .chronorift/godot-demo-mob-orientation/chronorift-v2.json

node scripts/evaluate-mob-orientation-ablation.mjs \
  .chronorift/godot-demo-mob-orientation/coding-only.json \
  .chronorift/godot-demo-mob-orientation/chronorift-v2.json \
  > .chronorift/godot-demo-mob-orientation/evaluation.json
```

The runner rejects a different source commit/tree, model, thinking level, timeout, or arm name. Both arms receive the
same neutral prompt, coding tools, sandboxed `godot_run`, 128-call shared admission budget, pure source materialization,
fresh-run namespace/Session, and a common environment appendix containing only the opaque run ID. The treatment receives four
public game-tool definitions and their metadata plus two concise discoverability lines: a prevalidated V2 environment
is available through `game_*`, and runtime records are observations rather than verdicts while strategy remains the
Agent's choice. This is a full product intervention, not a tool-only comparison. Host baseline and postflight
observations are not shown to the coding-only Agent. After the Agent turn, a narrow
three-invocation evaluator is materialized temporarily, run through the same Godot sandbox boundary, removed before
patch extraction, and never exposed to the Agent.

The standalone pair evaluator promotes only an exact treatment win: coding-only must fail its evaluator, treatment
must pass 3/3, treatment must have queried tilted Mob state from the exact initial Build before source mutation, and
the changed candidate Build must report upright Mobs with zero vertical velocity and configured horizontal speed.
Do not rerun, reorder, change the prompt/model/seed, or replace the Bug after seeing results. A non-win remains a
non-Hero characterization.

The fixed pair was completed on a provisioned local Host on 2026-08-24. Both candidates passed 3/3, and the treatment
used initial- and candidate-Build runtime state, so the published evaluator correctly returned a non-zero process exit
with `heroPromoted=false`: coding-only did not fail. That exit is the predeclared non-promotion outcome, not an
invalid run or cleanup failure. The exact public summary and candidate patches are in the
[case study](case-studies/godot-demo-mob-orientation.md); the raw arms remain local because they contain Host paths and
opaque runtime identities. Do not rerun the published pair to search for a different outcome.

## Other explicit live paths

| Command                                                    | Scope                                                            |
| ---------------------------------------------------------- | ---------------------------------------------------------------- |
| `corepack pnpm demo:platform-alias-ablation -- --arm ...`  | One fresh GN-1 matched arm; pair with the standalone evaluator   |
| `corepack pnpm demo:mob-orientation-ablation -- --arm ...` | One fresh Mob-orientation V2 arm; the published pair is complete |
| `corepack pnpm test:vnext:pi-live`                         | Real Pi Session/tool smoke; no Godot and not release acceptance  |
| `corepack pnpm diagnose:v04 -- ...`                        | Legacy v0.4 real-provider diagnosis                              |
| `corepack pnpm test:live`                                  | All live provider smokes selected by `vitest.live.config.ts`     |

Only `*.live.test.ts` and explicit live commands may contact a provider. Pi credentials remain in the Host credential
store and must never enter the repository, evidence, sandboxed command environment, or Godot process. A live success is
reportable only when its required execution, artifact, and cleanup records were actually produced and retained.

## Historical archives

`docs/benchmarks/**` and `docs/evidence/**` are immutable historical records. Their active benchmark campaigns,
publishers, evidence producers, standalone validators, and one-off Gate wrappers have been retired from current HEAD;
use the corresponding historical tag when reproducing that old machinery. Content hashes bind bytes but are not
signatures or external attestation, and frozen conclusions must not be rewritten as vNext product evidence.
