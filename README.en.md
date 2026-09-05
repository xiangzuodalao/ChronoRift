# ChronoRift

[中文](README.md)

[![CI](https://github.com/xiangzuodalao/ChronoRift/actions/workflows/ci.yml/badge.svg)](https://github.com/xiangzuodalao/ChronoRift/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

**Give coding agents a view into Godot's runtime state.**

Why is a collision area wider than its visible platform? Do separate instances share the same resource? ChronoRift
gives coding agents tools to run the game, inspect objects, and validate candidate changes—connecting source analysis
with what actually happens at runtime.

An engineering portfolio project focused on **Agent Harness design and game-runtime investigation**, built with
TypeScript, Pi SDK, Godot, and Anthropic Sandbox Runtime (SRT).

![ChronoRift: isolated game execution and runtime inspection](docs/assets/chronorift-hero.jpg)

_Product concept art, not a UI screenshot or experimental record._

## What it does today

Experimental `project preview` passes the user's goal directly to Pi, keeping ordinary coding tools and adding three
game tools. The Agent chooses how to investigate, edit, and validate; no project-specific Adapter is required.

| Tool          | Purpose                                                                          |
| ------------- | -------------------------------------------------------------------------------- |
| `game_launch` | Stage the current candidate separately and launch its default main scene         |
| `game_query`  | Inspect children, properties, and identity-preserving object/resource references |
| `game_stop`   | Stop the execution and save its actual runtime record                            |

For example, the Agent can read `CollisionShape2D.shape`, then query that resource's `size` to check collision
dimensions and resource sharing. Candidate edits take effect on the next launch; they do not change an existing run.

Currently supports Linux x86_64 and Godot 4.7.1 GDScript projects, subject to project-admission limits.
**Queries read current state only**; time windows, history inspection, probes, and input controls are not implemented.
The published `v0.4.0` release is a separate legacy path, not the Preview product experience.

## Design decisions

- **Pi decides; the Harness executes.** Preserve Pi's Session, model calls, and tool scheduling instead of scripting
  a fixed investigation.
- **Separate editing from execution.** The Agent edits a private candidate. Native import uses a disposable copy;
  validated outputs feed a fresh read-only game stage. Coding and Godot operations run through SRT with network
  access denied by default; model credentials stay on the Host.
- **Deliver reviewable results.** Retain the actual patch, Session, and runtime records—including failures, timeouts,
  and truncation. `completed` does not mean fixed; project tests or human review determine acceptance.

[Explore the design tradeoffs and code →](docs/portfolio.md)

## Case studies

### Current Preview: GN-1 without an Adapter

Starting from a symptom—a falling platform activates while the player is outside its visible width—a real Pi Session
found nodes, queried Shape references and sizes, changed one line, and relaunched to inspect the candidate.
An independent check after the Session found that the baseline failed the initial geometry/resource-identity checks
and the saved candidate passed.

Public materials include actual tool-call excerpts and failures, the patch, an independent checker, and five screenshots
of a saved-session replay. A **credential-free candidate-check command** checks the saved patch; it does not rerun a model.
This is a **functional demonstration and regression case**: GN-1 informed interface design, so it is not unseen-project
generalization evidence, and it does not validate complete gameplay timing.

[Review the new Preview case, screenshots, and runnable checks →](docs/case-studies/gn1-preview.md)

### Historical GN-1: a shared collision resource

In `endlessm/moddable-platformer`, four platform trigger areas shared one Shape, making the narrower platforms'
trigger areas wider than their visible platforms. In one matched pair, the coding-only candidate retained the shared
resource. After querying runtime geometry and resource identity, the ChronoRift Agent produced a candidate that
isolated the Shape and passed the case's geometry and identity checks.

This is a retrospectively selected **N=1 qualitative case**, not evidence of general repair rates or superiority.

[Inspect the candidate patches, results, and limitations →](docs/case-studies/gn1-platform-alias.md)

### Historical Godot Demo: runtime inspection on a second project

In `squash_the_creeps`, the Agent used the shared V2 runtime path to inspect Mob orientation and velocity before and after
editing. Both ChronoRift and coding-only candidates passed the independent checks (**3/3 each**): the case demonstrates
second-project reuse, not a comparative advantage.

[Review the investigation and both outcomes →](docs/case-studies/godot-demo-mob-orientation.md)

These two historical cases used earlier project-specific Adapters. They do not establish generalization for today's
Adapter-free Preview. Public materials include candidate patches and check summaries, not complete raw Sessions.

## Explore further

- [Architecture and implementation status](docs/architecture.md): runtime boundaries, module responsibilities, and limitations.
- [Development and validation](docs/development.md): setup, Preview usage, and offline, Godot, and sandbox tests.

## License

Project code is licensed under [Apache License 2.0](LICENSE). Case-study patches derive from MIT-licensed upstream
projects; see [Third-Party Notices](THIRD_PARTY_NOTICES.md) for attribution.
