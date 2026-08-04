# Changelog

## v0.3.0 — 2026-08-04

ChronoRift v0.3 turns the single Godot demo into a benchmark-first diagnostic harness while preserving
the v0.1 Mock and v0.2 switch-door paths.

### Highlights

- Added four real Godot runtime Bug Fixtures: Signal/receiver ordering, frame-count input windows,
  discrete-physics tunneling, and stale effects crossing pooled entity incarnations.
- Added Protocol v2 dynamic property registration, entity/incarnation lifecycle evidence, spatial
  samples, physics-TPS controls, and allowlisted Fixture controls.
- Added versioned Contract/InputTrace/Execution/Evidence Capsule/DiagnosisProposal DTOs, run-scoped
  write-once artifacts, strict replay, two-candidate single-variable experiments, comparisons, and a
  mechanism-specific Conclusion Gate.
- Added three Pi benchmark arms with equal source and game budgets. The full arm uses Capsule, replay,
  experiment, and compare tools; no arm receives shell or write access.
- Added deterministic Pi fake-model coverage and a resumable 4 × 3 × 3 live benchmark runner with strict
  sanitized reports and a 75% / zero-false-confirmation / +20pp advantage Gate.

### Known limitations

- The four Fixtures are explicit instrumentation, not general Godot project support.
- The deterministic benchmark validates orchestration and does not claim model advantage.
- No automatic patching, general World Graph, Experiment DAG, complete Determinism Certificate, visual
  input, multi-Agent orchestration, container sandbox, or complex artifact service is implemented.

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
