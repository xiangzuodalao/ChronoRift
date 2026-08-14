# Development and conformance

This guide contains developer commands and Host-bound conformance setup. It is operational documentation, not a
claim that a Gate has run or passed. Product boundaries live in [architecture.md](architecture.md), current status
lives in the [README](../README.md) and Architecture Section 21, and frozen results live under `docs/evidence/`.

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

Godot and external-project gates additionally require:

- a fresh, user-owned, mode `0700` Task-storage mount, no larger than 1 GiB and 131072 inodes. Product preflight accepts
  exact `tmpfs`, `ext4`, or `xfs`; the checked-in Godot-sandbox, M4/E2 external, and PE-C external wrappers further
  require exact `tmpfs`;
- immutable Host paths for Node `22.23.1`, Godot `4.7.1`, bubblewrap, prlimit, static BusyBox, bash, ripgrep, GNU
  `find`/`ls`, `ldd`, `fc-match`, and `xdg-user-dir`;
- the exact managed Addon root required by the selected profile.

The Task `runtimeRoot` must be a canonical strict child of the storage mount, never the mount itself, the source tree,
or a symlink path. All tasks, runtimes, evaluator work, scratch space, and artifacts on that filesystem share the
aggregate limit.

Use the checked-in wrappers as the executable specification for provisioning and cleanup:

| Boundary                             | Command / wrapper                                                                                                                                       |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Coding sandbox                       | `corepack pnpm test:sandbox` / `.github/scripts/run-sandbox-conformance.sh`                                                                             |
| Godot + sidecar + sandbox Host paths | `corepack pnpm test:vnext:godot-sandbox` / `.github/scripts/run-vnext-godot-sandbox-conformance.sh`                                                     |
| M4 and E2 external project           | `corepack pnpm test:vnext:external-project`, `corepack pnpm test:vnext:external-semantic` / `.github/scripts/run-vnext-external-project-conformance.sh` |
| PE-C narrow external-project slice   | `corepack pnpm test:vnext:project-environment-pe-c-host` / `.github/scripts/run-vnext-project-environment-pe-c-conformance.sh`                          |

The wrappers create or validate the exact test boundary, require fresh storage, and check cleanup. Do not use lazy
unmount or a reused storage directory to turn residual state into an apparent success. M4/E2 provisioning may fetch
the frozen checkout before the Gate; the Gate itself runs without external network access and never clones or fetches.

The PE-C wrapper takes a clean, operator-provisioned `endlessm/moddable-platformer` checkout at commit
`3e793f53598a131c53fb82555191cc14b8db07ff` (tree `a013bd677c712dbf354e8e2f6e8ff7c53d5684c6`) through
`CHRONORIFT_TEST_PE_C_EXTERNAL_PROJECT_ROOT`. It makes and removes a dedicated `RUNNER_TEMP` clone, then adds the
tracked dirty, explicit untracked, nested-project, addon/`@tool`, and secondary-target overlay declared in
[`testdata/vnext/pe-c`](../testdata/vnext/pe-c/README.md). It never changes the M4/E2 checkout or frozen evidence.
The wrapper invokes the fixed PE-C Host test and fails if that test is absent or fails; fixture setup alone is not a
successful Gate. It must itself run below `systemd-run` with `Delegate=yes` and `PrivateNetwork=yes`; the underlying
pnpm test refuses to mutate a project unless it is the wrapper-marked disposable clone. PE-C external-project
verification remains pending until actual Host Gate output is retained.

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
and `--launch-target` selects a declared target (the default is used when omitted). They are branch-under-test
interfaces until the PE-C Gate produces actual output.

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

PE-A and PE-B real-model Gates are opt-in and require explicit Host model-network and credential authorization:

```bash
corepack pnpm test:vnext:project-environment-pe-a-live
corepack pnpm test:vnext:project-environment-pe-b-live
```

Each live Gate requires its corresponding `CHRONORIFT_TEST_PE_A_*` or `CHRONORIFT_TEST_PE_B_*` Host config, model,
agent directory, enable flag, and create-new evidence output directory. Without the explicit enable flag the test is
skipped and produces no evidence; once enabled, missing inputs or Host boundaries fail closed. Exact archived
revalidation commands and trust limits are documented with the
[PE-A evidence](evidence/vnext-project-environment-pe-a-local-r1/README.md) and
[PE-B evidence](evidence/vnext-project-environment-pe-b-local-r1/README.md).

## Other explicit live paths

| Command                             | Scope                                                                    |
| ----------------------------------- | ------------------------------------------------------------------------ |
| `corepack pnpm test:vnext:pi-live`  | Real Pi Session/tool smoke; no Godot and not release acceptance          |
| `corepack pnpm test:vnext:live`     | M3 single-Agent-turn plus external 13-scenario evaluator; not default CI |
| `corepack pnpm diagnose:v04 -- ...` | Legacy v0.4 real-provider diagnosis                                      |
| `corepack pnpm test:live`           | Historical v0.1 provider smoke                                           |

Only `*.live.test.ts` and explicit live commands may contact a provider. Pi credentials remain in the Host credential
store and must never enter the repository, evidence, Task command environment, or Godot process. A live success is
reportable only when its required execution, artifact, and cleanup records were actually produced and retained.

## Evidence and historical paths

```text
corepack pnpm validate:project-environment:pe-a -- SCHEMA EVIDENCE
corepack pnpm validate:project-environment:pe-b -- SCHEMA EVIDENCE
corepack pnpm benchmark:verify -- --spec PATH --report PATH
corepack pnpm benchmark:gate -- --spec PATH --report PATH
```

Content hashes validate bytes and internal binding; they are not signatures or external attestation. Historical
v0.1-v0.4 artifacts and frozen benchmark conclusions keep their original semantics and must not be rewritten as vNext
product evidence.
