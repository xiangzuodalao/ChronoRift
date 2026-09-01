# ChronoRift

[中文](README.md) · [Engineering walkthrough](docs/portfolio.md) · [GN-1 case study](docs/case-studies/gn1-platform-alias.md) · [Godot Demo V2 slice](docs/case-studies/godot-demo-mob-orientation.md)

[![CI](https://github.com/xiangzuodalao/ChronoRift/actions/workflows/ci.yml/badge.svg)](https://github.com/xiangzuodalao/ChronoRift/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

**Move coding agents from source-level guesses to executable Godot runtime evidence.**

Pi owns the Agent Loop. ChronoRift uses an exactly pinned Anthropic Sandbox Runtime (SRT) to confine file, command,
and Godot operations and gives the Agent Build-bound runtime state, actual diffs, and tool results. The Agent chooses
its investigation and edit strategy; project CI, an independent Eval, or human review still owns final acceptance.

> **Outcome advantage — GN-1:** with source, prompt, model, thinking, timeout, and shared tools held constant, the
> coding-only candidate's geometry oracle was `false`. After querying realized platform geometry and Shape identity,
> the ChronoRift Agent produced a different candidate whose oracle was `true`.
>
> **Cross-project validation — Godot Demo V2:** on a second upstream project, the ChronoRift Agent made 13 V2
> game-tool calls and queried 14 initial plus 5 candidate Mob-state records; its candidate passed the independent
> evaluator 3/3. Coding-only also passed 3/3, so this case supports product-path reuse rather than a general efficacy
> claim.

**Status on 2026-08-27:** `v0.4.0` is the current legacy release and Project Environment is an experimental Preview.
A default `chronorift [goal]`, arbitrary-project support, and automatic “fixed” verdicts do not exist yet.

![ChronoRift concept art showing an isolated Godot runtime, baseline and candidate executions, and runtime records](docs/assets/chronorift-hero.jpg)

_Concept art for the product theme; not a UI screenshot, runtime capture, or piece of experimental evidence. [Open the 2560×1280 master](docs/assets/chronorift-hero-master.jpg)._

## Architecture in two minutes

![ChronoRift high-level architecture](docs/assets/chronorift-architecture.png)

ChronoRift does not reimplement a coding agent: Pi SDK owns models, sessions, and tool scheduling; ChronoRift provides
the surrounding workspace, sandbox, Godot execution, and runtime evidence.

- **A · Debugging loop:** the Agent edits a writable candidate, runs Godot, and iterates from runtime observations.
  Observations are debugging signals, not verdicts.
- **B · Independent validation:** Godot validation uses a separate read-only stage. For the current fixed cases, the
  evaluator runs only after the Agent and does not guide the fix. Patch round-trip and evaluation are separate checks.
- **Acceptance stays outside the Loop:** `completed` does not mean `fixed`; project CI, an external Eval, or human
  review makes the final decision.

**Core value:** consistent execution, workspace isolation, runtime evidence, and independently reviewable validation.

See the [target architecture](docs/architecture.md) for the full contract; it describes the vNext direction, not a list
of implemented features.

## What exists today

| Surface                     | Current implementation                                                                                                                  | Boundary                                                                               |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| v0.4 legacy                 | Four calibrated fixtures, a real Pi Session, and a fixed diagnosis workflow                                                             | Not the vNext free Loop and not an arbitrary-project runner                            |
| Project Environment Preview | Explicit `project preview`; experimental source closure, sandbox, adapter publication/binding, and reuse                                | Narrow historical characterization; not the default command or general project support |
| GN-1                        | One exact third-party revision, one project-specific adapter, two matched arms, public candidate patches, and a Host postflight summary | One project, prompt, revision, and pair; raw live outputs remain local-only            |
| Godot Demo Mob V2           | A second external project, state-only Adapter V2, completed fresh pair, public patches, and an independent evaluator                    | Both arms passed 3/3; not a Hero, comparative win, or automatic-onboarding claim       |
| Host sandbox                | SRT `0.0.74` exactly on Linux x86_64; writable coding workspaces and Host-staged Godot validation                                       | Network denied by default; no custom cgroup, storage-ledger, or Host-config layer      |
| M3/M4/E2                    | Implementations and commands are removed from current HEAD; frozen historical archives remain                                           | Not templates for new slices and not restored to reproduce old producers or Gates      |

Not yet available: a default `chronorift [goal]`, arbitrary Godot projects, general adapter authoring/migration,
cross-platform Hosts, automatic acceptance, or generally available checkpoint/fork/replay on the current product
path. The retired M3 implementation exists only in historical tags and archives.

## Runtime evidence changed the candidate: GN-1

In GN-1, coding-only produced a plausible width adjustment, but candidate runtime still retained a shared Shape
identity and the case-level oracle was `false`. The ChronoRift Agent queried realized geometry and resource identity;
its candidate instead isolated the shared Shape resource and the oracle was `true`.

Both fresh arms pin `endlessm/moddable-platformer` to the same commit/tree and share a neutral prompt, model, thinking
level, timeout, and ordinary tools. The `chronorift` arm adds only four game tools and their existing concise metadata.

| Arm           | Additional Agent-visible runtime surface                      | Candidate Host observation                                                       | Case oracle |
| ------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------- | ----------- |
| `coding-only` | None                                                          | All four area widths were 682 px and still shared one resource identity          | `false`     |
| `chronorift`  | `game_capabilities`, `game_launch`, `game_stop`, `game_query` | Area widths matched 128/256/384/768 px solid widths and identities were distinct | `true`      |

This pair was selected retrospectively from existing local runs. It was not preregistered and cannot establish
success rate, causality, general superiority, candidate acceptance, or arbitrary-project support. The public case
contains the exact setup, both candidate patches, and the existing evaluator's exact summary output—not full
transcripts, Host paths, or raw Task/Session identifiers.

[Review the GN-1 Platform Alias case study →](docs/case-studies/gn1-platform-alias.md)

## Reused on a second project: Godot Demo V2

The public V2 loader, managed runtime, sandbox, lineage, and game tools completed an end-to-end run against a fixed
`godot-demo-projects/3d/squash_the_creeps` revision.

| Product fact                | Formal result                                                           |
| --------------------------- | ----------------------------------------------------------------------- |
| Agent-visible runtime use   | 13 V2 game-tool calls; 14 initial and 5 candidate state records         |
| ChronoRift candidate        | Independent Godot evaluator 3/3                                         |
| Second-project runtime path | Source, Build, Execution, patch, and cleanup records are bound          |
| Comparative Hero gate       | Not promoted; coding-only produced the same semantic fix and passed 3/3 |

The full treatment delta included four game-tool definitions and their metadata plus two neutral discoverability
lines. This was not a tool-only comparison, and the outcome cannot be attributed to the game tools alone.

This run shows that ChronoRift's runtime product boundary is not confined to GN-1; it does not carry the comparative
advantage claim. The detailed page retains both original candidate patches and evaluator stdout, and summarizes time,
cost, failed tool responses retained in local raw records, and runtime limitations.

[Review the Godot Demo Mob Orientation case study →](docs/case-studies/godot-demo-mob-orientation.md)

## Review paths

1. **No install:** read the [GN-1 case](docs/case-studies/gn1-platform-alias.md), the
   [Godot Demo V2 case](docs/case-studies/godot-demo-mob-orientation.md), the
   [engineering walkthrough](docs/portfolio.md), and the
   [CI jobs](https://github.com/xiangzuodalao/ChronoRift/actions/workflows/ci.yml).
2. **Offline:** use Node.js `>=22.19` (`.nvmrc` pins `22.23.1`) and pnpm `11.20.0`:

   ```bash
   nvm use
   corepack pnpm install
   corepack pnpm check
   ```

   The default Gate runs lint, formatting checks, strict TypeScript checking, and deterministic credential-free tests.

3. **Provisioned Host:** follow the [development guide](docs/development.md) for Linux x86_64, exact SRT `0.0.74`,
   Bubblewrap/`socat`/ripgrep, Godot, external-checkout, and provider prerequisites required by Project Environment
   Preview, GN-1, or the Godot Demo slice.

   Run `.github/scripts/run-srt-sandbox-conformance.sh`; it verifies the Host prerequisites and then runs the single
   `corepack pnpm test:sandbox` suite for coding and real Godot/Preview integration.

The explicit experimental entry points are:

```text
corepack pnpm project preview -- [GOAL] --provider PROVIDER --model MODEL
corepack pnpm demo:platform-alias-ablation -- --arm coding-only|chronorift ...
corepack pnpm demo:mob-orientation-ablation -- --arm coding-only|chronorift-v2 ...
```

They do not modify or apply changes to the source checkout. The Agent can write a private physical candidate
workspace. Godot validation instead runs against a Host-copied stage whose project source is read-only; only
`.godot/`, home, temp, and artifacts are writable, and source SHA-256 is checked before and after execution. The
commands do not automatically commit, merge, push, or declare a fix.

## Trust boundary

- Project code, runtime data, adapters, plugins, model output, patches, and tool output are untrusted content.
- vNext coding and Godot processes run through SRT with a strict empty network allowlist. Coding can write the
  candidate workspace; Godot cannot see that mutable tree and can write only its declared runtime directories.
- Pi credentials stay on the Host model path and must not enter the repository, artifacts, sandboxed command
  environment, or Godot process.
- External, wire, tool, and persisted DTOs are explicitly versioned and strictly validated at runtime.
- Runtime records expose coverage, loss, overwrite, fidelity, and clock limitations rather than hiding them.
- Content hashes bind bytes and detect corruption; they are not signatures, attestation, or proof of correctness.
- The v0.4 Host process does not provide the vNext OS sandbox guarantee.

## Documentation

- [Engineering walkthrough](docs/portfolio.md): design decisions, a five-file code tour, and known debt.
- [GN-1 case study](docs/case-studies/gn1-platform-alias.md): a checkable but non-generalizable runtime-observation pair.
- [Godot Demo Mob orientation](docs/case-studies/godot-demo-mob-orientation.md): a completed second-project V2 slice that did not promote to Hero.
- [Target architecture](docs/architecture.md): vNext contract, rollout, and current implementation map (§20/§21).
- [Project Environment V1 RFC](docs/project-environment-v1.md): data model, publication state machine, and wire contract.
- [Development and conformance](docs/development.md): local, Godot, Host sandbox, and live-provider prerequisites.
- [`docs/evidence/`](docs/evidence/) and [`docs/benchmarks/`](docs/benchmarks/): immutable historical archives whose
  conclusions do not automatically apply to current HEAD.

ChronoRift-owned code is licensed under [Apache License 2.0](LICENSE). Candidate patches in both public cases derive
from MIT-licensed upstream projects; attribution is recorded in [Third-Party Notices](THIRD_PARTY_NOTICES.md) and the
case directories.
