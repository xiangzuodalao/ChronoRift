# Changelog

## v0.2.0 — 2026-08-04

ChronoRift v0.2 adds the first real Godot vertical slice while preserving the deterministic v0.1 Mock
workflow.

### Highlights

- Added a Godot 4.7.1 Addon/Autoload and a visual, headless-compatible switch-door Fixture.
- Added a strict, versioned loopback TCP protocol with length framing, payload hashes, sequence checks,
  single-run authentication, capability negotiation, and bounded process lifecycle.
- Added real `InputEventAction` injection and separate logical, process, physics, simulation, and host
  monotonic receipts.
- Added L0 fresh-scene and fixture-specific L2 checkpoint/restore with participant validation, coverage,
  missing-state descriptors, and runtime fingerprints.
- Reused the v0.1 baseline replay, one-tick intervention, Evidence Capsule, Pi Agent Loop, typed
  DiagnosisProposal, and Conclusion Gate against real Godot executions.
- Added observation health and Gate rejection for dropped, truncated, backpressured, or insufficient
  runtime evidence.
- Added deterministic offline tests, real Godot integration tests, managed Godot installation/doctor
  commands, and GitHub Actions coverage.

### Verified release path

- Baseline: Signal emitted before the door receiver connects; Contract fails.
- Strict replay: reproduces the same semantic timeline and failure.
- Intervention: delays only the same input by one logical tick; Signal is delivered and the door opens.
- Deterministic Pi model: Harness returns `confirmed` even with Agent confidence `0`.
- Volcengine Coding Plan `glm-5.2`: manual real-provider smoke test returns a Harness-confirmed diagnosis.

### Known limitations

- Only the explicitly instrumented switch-door Fixture is supported.
- L2 restores registered participant state, not complete Godot engine or process state.
- No global Signal/property interception, complete Determinism Certificate, automatic source changes,
  visual Agent, multi-Agent orchestration, or OS/container sandbox is claimed.
