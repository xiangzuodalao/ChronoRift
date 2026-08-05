# Changelog

## v0.3.1 — Unreleased

- Added a sanitized real-Pi smoke outside the formal Fixture set. It fails unless the Pi Session is
  persisted, model usage and tool calls are non-zero, and the Harness confirms the v0.1 Mock diagnosis.
- Added an isolated v0.3.1 formal campaign identity, freeze tag, order seed, provenance binding, and
  publication directory while preserving v0.3 spec/report verification and its published negative result.
- Extended Pi Session references with token, tool-call, and cost statistics so live validation checks
  actual Agent/model progress instead of accepting a zero-usage Session.
- Kept the 36-cell Fixture/arm/repetition matrix, prompts, budgets, model configuration, scoring, and Gate
  unchanged. The new campaign result will be published without rerun selection once provider recovery is
  proven.

## v0.3.0 — 2026-08-05

ChronoRift v0.3 turns the single Godot demo into a benchmark-first diagnostic harness while preserving
the v0.1 Mock and v0.2 switch-door paths.

### Highlights

- Added four real Godot runtime Bug Fixtures: Signal/receiver ordering, frame-count input windows,
  discrete-physics tunneling, and stale effects crossing pooled entity incarnations.
- Reworked entity reuse into a delayed pending effect: incarnation 1 is recycled before the effect is
  resolved, the Bug applies it to incarnation 2 by stable ID, and the pooling-off intervention discards
  it as `owner_destroyed`; checkpoint/restore preserves the in-flight effect and sequence.
- Added Protocol v2 dynamic property registration, entity/incarnation lifecycle evidence, spatial
  samples, typed pending-effect events, physics-TPS controls, and allowlisted Fixture controls.
- Added `FailureBriefV1`, content-addressed `EvidenceAccessReceiptV1`, `DiagnosisProposalV3`, and strict
  Benchmark Suite/Attempt/Cell/Report v2 contracts. The Harness revalidates candidate, comparison,
  replay, event and receipt references; model confidence remains non-authoritative.
- Made the three Pi benchmark arms blind to their treatment: byte-identical prompt/Failure Brief,
  opaque case IDs, neutral `case/main.gd` source view, fixed budgets, and differences only in active
  evidence/experiment tools. No arm receives shell or write access.
- Added deterministic fake-model coverage plus separate exploratory and frozen formal runners. Formal
  runs use GLM-5.2 `max`, a 4 × 3 × 3 block-randomized matrix, typed retry/resume, and an append-only
  attempt hash chain. A durable first-execution selection and `benchmark:status` prevent accidental
  second executions; three progress stages distinguish baseline cost, validated Fixture material, and
  non-retryable Agent progress.
- Added write-once sanitized publication, integrity-only verification, and a separate Gate based on
  grounded success: full ≥9/12, full−generic ≥0.20, and zero full-arm incorrect confirmations.

### Evidence status

- Froze and published the machine benchmark spec plus the first formal 36-cell execution. The execution
  is complete and the sanitized report passes integrity verification, but the pre-registered Gate fails.
- All 36 cells terminated as `diagnostic_failure/proposal_missing` after one baseline each. Every arm
  scored 0/12 grounded successes; the run recorded zero model tokens and zero tool calls, with zero
  incorrect confirmations. These data do not measure model diagnostic quality or treatment advantage.
- All 36 locally retained raw finished manifests recorded
  `PiHarnessError/PROPOSAL_MISSING: Connection error.`, and two separate `test:live` infrastructure
  smokes also returned `Connection error`. Those local observations strongly implicate the connection
  path, but the sanitized public report proves only `proposal_missing` and does not establish a
  provider-side root cause.
- The offline deterministic `BenchmarkReportV1` smoke validates orchestration, contracts, permission
  boundaries and basic Gate recomputation. Formal v2 selection/recovery/ledger behavior is covered by
  offline tests, not by that fake report.
- The preselected public case remains physics tunneling / full arm / repetition 1. Its partial evidence
  bundle preserves the baseline but contains no replay, candidate, comparison, access receipt or proposal;
  it was not replaced after the negative result.

### Known limitations

- The four Fixtures are explicit instrumentation, not general Godot project support.
- The suite was calibrated on these same four Fixtures, has no provider sampling seed, and cannot
  establish statistical significance or cross-project generalization.
- Report verification checks internal integrity, not provider execution or external attestation.
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
