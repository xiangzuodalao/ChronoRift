# ChronoRift

[中文](README.md) · [Engineering walkthrough](docs/portfolio.md) · [GN-1 case study](docs/case-studies/gn1-platform-alias.md)

[![CI](https://github.com/xiangzuodalao/ChronoRift/actions/workflows/ci.yml/badge.svg)](https://github.com/xiangzuodalao/ChronoRift/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

**A secure, evidence-preserving Agent Runtime Harness for Godot, built on the Pi SDK.**

Pi owns the Session and Agent Loop. ChronoRift owns the task workspace, sandboxed execution, versioned game-tool
boundary, and runtime records. The Agent chooses how to investigate and validate; project CI, an external Eval, or a
human reviewer decides whether to accept the candidate.

> **Status on 2026-08-21:** `v0.4.0` is the current legacy diagnosis release. Project Environment is an experimental
> Preview. GN-1 is one retrospective matched pair on one pinned external project. A default `chronorift [goal]`,
> arbitrary-project support, and automatic “fixed” verdicts do not exist yet.

![ChronoRift concept art showing an isolated Godot runtime, baseline and candidate executions, and runtime records](docs/assets/chronorift-hero.jpg)

_Concept art for the product theme; not a UI screenshot, runtime capture, or piece of experimental evidence. [Open the 2560×1280 master](docs/assets/chronorift-hero-master.jpg)._

## Architecture at a glance

![ChronoRift architecture overview: the Pi Loop reaches an isolated Task sandbox through a tool broker and leaves records for external acceptance](docs/assets/chronorift-architecture.png)

`completed` means the Loop ended with reviewable candidate changes and execution records. It does not mean
`verified`, `fixed`, or logically proved. Diffs, command output, tool results, and raw runtime records outrank the
Agent's final prose. See the [target architecture](docs/architecture.md) for the full contract; it is not a list of
implemented features.

## What exists today

| Surface                     | Current implementation                                                                                                                  | Boundary                                                                               |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| v0.4 legacy                 | Four calibrated fixtures, a real Pi Session, and a fixed diagnosis workflow                                                             | Not the vNext free Loop and not an arbitrary-project runner                            |
| Project Environment Preview | Explicit `project preview`; experimental source closure, sandbox, adapter publication/binding, and reuse                                | Narrow historical characterization; not the default command or general project support |
| GN-1                        | One exact third-party revision, one project-specific adapter, two matched arms, public candidate patches, and a Host postflight summary | One project, prompt, revision, and pair; raw live outputs remain local-only            |
| Host sandbox                | Linux bubblewrap, cgroup, bounded Task storage, and pinned toolchain/Godot paths                                                        | Requires explicit Host provisioning; `cwd` or a Git worktree is not isolation          |
| M3/M4/E2                    | Compatibility implementations and frozen historical archives remain                                                                     | Not templates for new product slices; their dedicated producers and Gates are retired  |

Not yet available: a default `chronorift [goal]`, arbitrary Godot projects, general adapter authoring/migration,
cross-platform Hosts, automatic acceptance, or generally available checkpoint/fork/replay on the current product
path. The M3 compatibility path implements some runtime primitives for one fixed fixture only.

## GN-1: a reviewable N=1 case

GN-1 pins `endlessm/moddable-platformer` to one exact commit/tree. Both fresh arms receive the same neutral prompt,
model, thinking level, timeout, source, and shared tools. The `chronorift` arm adds only four game tools and their
existing concise metadata.

| Arm           | Additional Agent-visible runtime surface                      | Candidate Host observation                                                       | Case oracle |
| ------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------- | ----------- |
| `coding-only` | None                                                          | All four area widths were 682 px and still shared one resource identity          | `false`     |
| `chronorift`  | `game_capabilities`, `game_launch`, `game_stop`, `game_query` | Area widths matched 128/256/384/768 px solid widths and identities were distinct | `true`      |

This pair was selected retrospectively from existing local runs. It was not preregistered and cannot establish
success rate, causality, general superiority, candidate acceptance, or arbitrary-project support. The public case
contains the exact setup, both candidate patches, and the existing evaluator's exact summary output—not full
transcripts, Host paths, or raw Task/Session identifiers.

[Review the GN-1 Platform Alias case study →](docs/case-studies/gn1-platform-alias.md)

## Review paths

1. **No install:** read the [GN-1 case](docs/case-studies/gn1-platform-alias.md), the
   [engineering walkthrough](docs/portfolio.md), and the
   [CI jobs](https://github.com/xiangzuodalao/ChronoRift/actions/workflows/ci.yml).
2. **Offline:** use Node.js `>=22.19` (`.nvmrc` pins `22.23.1`) and pnpm `11.20.0`:

   ```bash
   nvm use
   corepack pnpm install
   corepack pnpm check
   ```

   The default Gate runs lint, formatting checks, strict TypeScript checking, and deterministic credential-free tests.

3. **Provisioned Host:** follow the [development guide](docs/development.md) for the Linux namespace/cgroup,
   bounded-storage, immutable-toolchain, Godot, external-checkout, and provider prerequisites required by Project
   Environment Preview or GN-1.

The explicit experimental entry points are:

```text
corepack pnpm project preview -- [GOAL] --provider PROVIDER --model MODEL
corepack pnpm demo:platform-alias-ablation -- --arm coding-only|chronorift ...
```

They operate on a Task-owned `/workspace`, do not modify or apply changes to the source checkout, and do not
automatically commit, merge, push, or declare a fix.

## Trust boundary

- Project code, runtime data, adapters, plugins, model output, patches, and tool output are untrusted content.
- Coding and game operations pass through the Task sandbox broker; network, credentials, Host paths, ports, devices,
  display, audio, and GPU are denied by default.
- Pi credentials stay on the Host model path and must not enter the repository, artifacts, Task command environment,
  or Godot process.
- External, wire, tool, and persisted DTOs are explicitly versioned and strictly validated at runtime.
- Runtime records expose coverage, loss, overwrite, fidelity, and clock limitations rather than hiding them.
- Content hashes bind bytes and detect corruption; they are not signatures, attestation, or proof of correctness.
- The v0.4 Host process does not provide the vNext OS sandbox guarantee.

## Documentation

- [Engineering walkthrough](docs/portfolio.md): design decisions, a five-file code tour, and known debt.
- [GN-1 case study](docs/case-studies/gn1-platform-alias.md): a checkable but non-generalizable runtime-observation pair.
- [Target architecture](docs/architecture.md): vNext contract, rollout, and current implementation map (§20/§21).
- [Project Environment V1 RFC](docs/project-environment-v1.md): data model, publication state machine, and wire contract.
- [Development and conformance](docs/development.md): local, Godot, Host sandbox, and live-provider prerequisites.
- [`docs/evidence/`](docs/evidence/) and [`docs/benchmarks/`](docs/benchmarks/): immutable historical archives whose
  conclusions do not automatically apply to current HEAD.

ChronoRift-owned code is licensed under [Apache License 2.0](LICENSE). The GN-1 candidate patches derive from an MIT
licensed upstream project; attribution is recorded in [Third-Party Notices](THIRD_PARTY_NOTICES.md) and the case directory.
