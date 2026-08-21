# Development and conformance

This guide contains developer commands and Host-bound conformance setup. It is operational documentation, not a
claim that a Gate has run or passed. Product boundaries live in [architecture.md](architecture.md), current status
lives in the [README](../README.md) and Architecture Section 21, and frozen results live under `docs/evidence/` and
`docs/benchmarks/`.

## Toolchain

- Node.js `>=22.19`; `.nvmrc` pins `22.23.1` for repository Gate evidence.
- pnpm `11.20.0`, invoked as `corepack pnpm` when no global pnpm is installed.
- The managed installer pins official Godot `4.7.1` for Linux x86_64.
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

`test:godot` covers the legacy suites plus current lifecycle/semantic Addons, Project Environment snapshot/runtime,
and PE-B V2 Godot integration. It does not exercise the Linux namespace, cgroup, bounded-storage, sidecar, or
read-only-mount boundary.

## Host-bound sandbox gates

Host conformance is explicit and never silently skipped. The standalone coding-sandbox wrapper needs an empty
delegated cgroup v2 parent with `cpu`, `memory`, and `pids` controllers; it does not require Project Environment Task
storage, Godot, or an Addon.

The Godot Host gate additionally requires:

- a fresh, user-owned, mode `0700` Task-storage mount, no larger than 1 GiB and 131072 inodes. Product preflight accepts
  exact `tmpfs`, `ext4`, or `xfs`; the checked-in Godot-sandbox wrapper further requires exact `tmpfs`;
- immutable Host paths for Node `22.23.1`, Godot `4.7.1`, bubblewrap, prlimit, static BusyBox, bash, ripgrep, GNU
  `find`/`ls`, `ldd`, `fc-match`, and `xdg-user-dir`;
- the exact managed Addon root required by the selected profile.

The Task `runtimeRoot` must be a canonical strict child of the storage mount, never the mount itself, the source tree,
or a symlink path. All tasks, runtimes, evaluator work, scratch space, and artifacts on that filesystem share the
aggregate limit.

Use the checked-in wrappers as the executable specification for provisioning and cleanup:

| Boundary                             | Command / wrapper                                                                                   |
| ------------------------------------ | --------------------------------------------------------------------------------------------------- |
| Coding sandbox                       | `corepack pnpm test:sandbox` / `.github/scripts/run-sandbox-conformance.sh`                         |
| Godot + sidecar + sandbox Host paths | `corepack pnpm test:vnext:godot-sandbox` / `.github/scripts/run-vnext-godot-sandbox-conformance.sh` |

The wrappers create or validate the exact test boundary, require fresh storage, and check cleanup. Do not use lazy
unmount or a reused storage directory to turn residual state into an apparent success. The retired PE-A/PE-B/M4/E2/
PE-C evidence producers and one-off Host Gate wrappers are available only through Git history and their frozen
archives; current HEAD does not present them as supported validation commands.

## Project Environment Preview

The development route is explicit and remains experimental:

```text
corepack pnpm project preview -- [GOAL] \
  --provider PROVIDER \
  --model MODEL \
  [--thinking LEVEL] \
  [--host-config PATH] \
  [--project-root RELATIVE_PATH] \
  [--include-untracked RELATIVE_FILE]... \
  [--launch-target TARGET_ID]
```

The three PE-C flags are fail-closed: `--project-root` is relative to the enclosing Git root,
`--include-untracked` names one exact selected-project-relative file and must be repeated on every Preview/reuse,
and `--launch-target` selects a declared target (the default is used when omitted). They remain experimental Preview
interfaces; the historical narrow characterization did not promote the default command or establish arbitrary-project
support.

The default Host config is `$XDG_CONFIG_HOME/chronorift/project-environment-host.v1.json`, or
`~/.config/chronorift/project-environment-host.v1.json` when `XDG_CONFIG_HOME` is unset. Its strict field schema lives
in [project-environment-host-config.ts](../apps/cli/src/vnext/project-environment-host-config.ts); the frozen PE-B
archive contains a [sanitized complete example](evidence/vnext-project-environment-pe-b-local-r1/gate/host-config.v1.json).
Replace every path and the Godot digest with facts from the current Host, or pass a canonical file via `--host-config`.
Unknown fields are rejected. The config and preflight, rather than project-supplied environment variables, select the
sandbox, toolchain, storage, Godot binary, and managed overlay.

With that Host boundary provisioned, an executable Preview invocation is:

```bash
corepack pnpm project preview -- "Investigate the intermittent jump input" \
  --provider openai-codex \
  --model gpt-5.6-luna
```

PE-A and PE-B real-model evidence producers have been retired. Their frozen historical bytes and original trust limits
remain in the [PE-A archive](evidence/vnext-project-environment-pe-a-local-r1/README.md) and
[PE-B archive](evidence/vnext-project-environment-pe-b-local-r1/README.md); current HEAD does not regenerate or validate
those bundles.

## GN-1 external-project matched ablation

GN-1 is a separate experimental implementation, not a Project Environment Preview or Gate. Provision a local clone
of `endlessm/moddable-platformer` at exact commit `e78b339500dec8e480b33723c4156bf9b74cd25c` and tree
`9941cb045b3cd73c4554ca1de337a341b383590b`. The checkout must be clean and must not contain `.chronorift/`; each
command validates these facts and does not clone, fetch, alter, or apply a patch to the source checkout.

Use the same fail-closed Host config and sandbox prerequisites described above. Run each arm as a fresh Task and save
its versioned JSON separately:

```bash
corepack pnpm demo:platform-alias-ablation -- \
  --arm coding-only \
  --project /absolute/path/to/moddable-platformer \
  --provider openai-codex \
  --model gpt-5.6-luna \
  --thinking max \
  --timeout-ms 600000 \
  --host-config /absolute/path/to/project-environment-host.v1.json \
  --json > coding-only.json

corepack pnpm demo:platform-alias-ablation -- \
  --arm chronorift \
  --project /absolute/path/to/moddable-platformer \
  --provider openai-codex \
  --model gpt-5.6-luna \
  --thinking max \
  --timeout-ms 600000 \
  --host-config /absolute/path/to/project-environment-host.v1.json \
  --json > chronorift.json

node scripts/evaluate-platform-alias-ablation.mjs coding-only.json chronorift.json
```

`--host-config` is optional under the normal Host-config lookup. The matched command fixes provider/model to
`openai-codex/gpt-5.6-luna`, thinking to `max`, and the default timeout to 600 seconds; mismatching values fail closed.
There is no fake-model fallback. Each arm receives the same exact source, neutral symptom prompt, `coding`
environment profile, and task-id-only environment instruction profile. It receives the same `read`, `bash`, `edit`,
`write`, `grep`, `find`, `ls`, and raw `godot_run` tools. The treatment's only tool-surface addition is
`game_capabilities`, `game_launch`, `game_stop`, and `game_query`; the common prompt does not name ChronoRift, a game
tool, `platform_geometry`, a cause, a patch, or a required tool order. The two runs intentionally have distinct Task,
workspace, and Pi Session identities.

Each command materializes a private Task workspace, records the Agent's candidate diff, and performs a Host-only
candidate observation on the resulting Build. The treatment may additionally launch and query ProjectAdapter V1
during its normal Pi Loop. Every Godot launch copies the exact Build into an execution-private tree, seals admitted
source read-only, and leaves only `.godot/` writable for import cache. Runtime/tool results bind the Task, Build,
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

## Other explicit live paths

| Command                                                   | Scope                                                           |
| --------------------------------------------------------- | --------------------------------------------------------------- |
| `corepack pnpm demo:platform-alias-ablation -- --arm ...` | One fresh GN-1 matched arm; pair with the standalone evaluator  |
| `corepack pnpm test:vnext:pi-live`                        | Real Pi Session/tool smoke; no Godot and not release acceptance |
| `corepack pnpm diagnose:v04 -- ...`                       | Legacy v0.4 real-provider diagnosis                             |
| `corepack pnpm test:live`                                 | All live provider smokes selected by `vitest.live.config.ts`    |

Only `*.live.test.ts` and explicit live commands may contact a provider. Pi credentials remain in the Host credential
store and must never enter the repository, evidence, Task command environment, or Godot process. A live success is
reportable only when its required execution, artifact, and cleanup records were actually produced and retained.

## Historical archives

`docs/benchmarks/**` and `docs/evidence/**` are immutable historical records. Their active benchmark campaigns,
publishers, evidence producers, standalone validators, and one-off Gate wrappers have been retired from current HEAD;
use the corresponding historical tag when reproducing that old machinery. Content hashes bind bytes but are not
signatures or external attestation, and frozen conclusions must not be rewritten as vNext product evidence.
