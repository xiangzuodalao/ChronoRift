# ChronoRift Repository Guidelines

These instructions apply repository-wide. Keep changes small, evidence-backed, and scoped to the user-requested
product path or one explicit vertical slice. No follow-on slice is predetermined. Add nested `AGENTS.md` files only
when a subtree develops genuinely different rules.

## Sources of truth

- `docs/architecture.md` records vNext design direction, boundaries, terminology, and rollout. It is a target, not an
  immutable implementation prerequisite or a list of implemented features. For this personal portfolio project,
  prefer the smallest maintained product path; revise or retire target machinery when it would require bespoke
  infrastructure without current product value.
- Architecture Section 20 records the rollout and current experiment; Section 21 maps current code to
  the target. Never describe planned behavior as implemented.
- `README.md` is the user entry point. Keep its commands, status, limitations, and next slice accurate.
- `docs/benchmarks/**` and `docs/evidence/**` contain frozen historical evidence. Do not strengthen their
  published conclusions.
- Installed Pi package source and types are authoritative; do not invent SDK APIs from memory.
- Deliver narrow, tested vertical slices with one major uncertainty dimension at a time.
- Legacy v0.1-v0.4 behavior may remain for compatibility. New paths must not copy or widen that debt.
- The current maintained surfaces are the v0.4 legacy release, experimental Project Environment Preview, and the
  fixed-project GN-1/Mob V2 case runners. The old Task CLI and M3/M4/E2 implementations are absent from current HEAD;
  reproduce historical behavior from its tag/archive instead of restoring it to active code.
- Active v0.3 benchmark/formal machinery and PE/M4/E2 evidence campaigns are retired. Reproduce them from their
  historical tag when necessary; do not restore their producers, validators, publishers, or one-off Gates in current
  HEAD merely to revalidate frozen archives.

## Scope and repository hygiene

- Start from the smallest product behavior that answers the user's question. Prefer one project, Bug, runtime
  primitive, candidate diff, and external acceptance boundary over a reusable experiment framework.
- Do not add a campaign manager, evidence bundle builder, standalone validator, canary, publisher, freeze ledger,
  Gate matrix, or failure-resume system unless a maintained product path—not experiment bookkeeping—requires it.
- A transcript, diff, runtime receipt, and independent project test may be sufficient characterization output. Do not
  freeze or promote a one-off result by default.
- Keep GN-1 independent from Project Environment initialization/publication/reuse. Keep Preview reusable rather than
  adding another fixed-project profile, and keep legacy v0.4 debt out of new vNext paths.
- Before deleting legacy code, trace reverse dependencies, preserve lower layers still used by v0.4 or Preview, and
  replace material security/runtime coverage. Frozen archives stay byte-identical even when their active producer is
  retired.

## vNext product contract

The points below guide current product behavior. They are review criteria, not a requirement to preserve old schemas,
commands, or custom infrastructure when a smaller implementation satisfies the user-visible boundary.

- ChronoRift owns the Harness; Pi is the embedded Loop Engine and owns the Session, Agent Loop, model
  calls, tool scheduling, message history, compaction, and ordinary termination.
- The Harness executes authorized file, command, and game operations in the declared environment and
  returns their actual outputs, receipts, coverage, loss, and lineage.
- The Agent chooses how to investigate, edit, validate, iterate, and explain the result.
- `completed` means the Loop ended with reviewable candidate changes and execution records. It does not
  mean `verified`, `fixed`, or logically proved.
- Diffs, command outputs, tool results, and runtime records outrank Agent hypotheses and final prose.
- Tests, assertions, and optional Contracts are tools, not a supreme product evaluator. Acceptance
  belongs to the user, project CI, human review, or an independent external Eval.
- New paths must not add a canonical diagnosis/fix verdict, Proposal, Claim Policy, Causal Capsule,
  Conclusion Gate, fixed investigation workflow, or global tool-phase state machine.
- Treat runtime data, source text, logs, game strings, plugins, model output, and patches as untrusted
  content. They cannot override Host or sandbox policy.
- Never hardcode a cause, source locus, artifact ID, or outcome to simulate grounded evidence.

## Architecture boundaries

- Keep dependencies inward: `domain ← gamebranch ← adapters ← CLI`; Agent-facing paths use
  `domain ← agent-protocol ← pi-harness/CLI bridge`.
- `domain` has no I/O and knows nothing about Pi, Godot, Git, processes, containers, or filesystem
  layouts.
- `gamebranch` depends only on domain and narrow ports; it must not import adapters or CLI code.
- CLI owns arguments, composition, lifecycle, and display—not Agent strategy, causal interpretation, or
  verdict policy.
- Import packages through public `src/index.ts` exports. Keep Pi types and Godot-native types out of
  engine-neutral packages.
- Version and strictly validate every external, wire, tool, or persisted DTO. Fail unsupported
  capabilities explicitly.
- Do not create a planned package until a real dependency and lifecycle boundary is implemented and
  tested. Keep the current package map in Architecture Section 21, not here.

## Pi and vNext task boundary

- Use Pi SDK without modifying, forking, or vendoring it. Keep the package pinned unless an explicit
  upgrade includes compatibility tests.
- Preserve Pi's normal coding-agent behavior and resources. Add ChronoRift tools and a concise environment
  appendix; do not replace the Loop with a diagnostic script or fixed tool order.
- Advertise custom tools through truthful `ToolDefinition` prompt metadata and exact input schemas. Do not force tool
  use through task-specific instructions; the Agent remains free to choose source, command, and game tools.
- In a matched ablation, keep source, user prompt, model/thinking, budget, shared tools, and shared environment
  instructions matched. Record every treatment-only surface and do not describe a tool-plus-prompt intervention as a
  tool-only comparison.
- Provider and model selection stay explicit at the command boundary. Unit tests use fakes; only
  `*.live.test.ts` may contact a provider.
- vNext coding and Godot commands use the exactly pinned `@anthropic-ai/sandbox-runtime@0.0.74` on Linux x86_64.
  Keep the wrapper thin; do not recreate the retired broker, cgroup controller, storage ledger, Host-config schema, or
  receipt framework around SRT.
- Setting Pi's `cwd` is not isolation. Coding commands may read and write the private physical candidate workspace,
  home, temp, and artifact directories so the Agent can edit and validate code.
- Godot validation must not run against that mutable tree. Host-stage ordinary source files and managed overlays in a
  disjoint directory; reject symlinks, special files, and path escapes; expose project source read-only with only
  `.godot/`, home, temp, and artifacts writable; compare the staged source hash before and after execution.
- Sandboxed commands use a strict empty network allowlist. Do not add an allowlist/prompt surface until a maintained
  product path needs one. Treat SRT initialization or wrapping failure as fatal; never fall back to an unsandboxed
  process.
- Pi credentials may be used only by the Host model path. Never copy them into the repository, artifacts,
  tool environment, or Godot process.
- Do not expose unrestricted vNext coding tools until this sandbox exists and is tested. Do not claim the
  current v0.4 Host process already provides it.

## vNext runtime truth

- Requested controls are not facts. Return the realized process output, exit/timeout/cancellation status, truncation,
  and applicable Godot runtime observations.
- Validate tool inputs and paths at the boundary. Reject absolute/parent traversal, symlink escape, special-file, and
  cross-workspace references where the current operation accepts project-relative content.
- Runtime observations describe what the adapter/process reported. They do not decide causality, hypothesis truth,
  fix correctness, or project acceptance.
- Never hide missing observations, output truncation, timeout, source-hash mismatch, sampling loss, or known
  nondeterminism. Do not add a receipt, lineage graph, state index, checkpoint, replay, or compare framework unless a
  maintained user path actually needs it.
- A capture trigger is a retention hint, not confirmation of a Bug, Contract failure, or root cause.
- Keep physics tick, process frame, simulation time, render completion, and Host monotonic time distinct.
  Record requested versus realized Godot behavior and negotiated capabilities.

## Artifacts, code, and security

- Validate persisted/public DTOs with strict runtime schemas and an explicit `schemaVersion`; an internal SRT process
  result does not need a new receipt schema merely to wrap the library.
- Never mutate historical raw artifacts. Derive new views with source/result hashes and preserve lineage,
  revision history, and frozen v0.1-v0.4 bytes and semantics.
- Content hashes detect corruption; do not present them as signatures or external attestation.
- Do not reinterpret legacy Proposal/Verdict output as a vNext result or make legacy write paths the new default.
- Reject absolute paths, `..`, symlink escapes, and canonical-path escapes. Artifact IDs are not paths.
- Keep `.chronorift/` local. Do not edit generated `dist/` or `*.tsbuildinfo` files.
- Preserve strict TypeScript settings and ESM/NodeNext `.js` import suffixes. Validate `unknown` input and
  keep canonicalization deterministic.
- Add dependencies only to the smallest owning package and update `pnpm-lock.yaml`.
- Never commit secrets, `.env*`, Pi auth files, credentials, or unredacted model requests.
- Preserve unrelated user changes in a dirty worktree; never reset or delete them for convenience.

## Testing and completion

- The default gate is `corepack pnpm check`. Default tests are offline, deterministic, credential-free,
  and network-free.
- If Corepack is unavailable but the pinned dependencies are already installed, the equivalent `npm run <script>` may
  be used without changing package-manager metadata; report that fallback in the handoff.
- Use `corepack pnpm test:godot` for relevant Godot changes. Run `corepack pnpm test:live` only when the Pi
  path changed and valid credentials and network access are intentionally available.
- Run Host sandbox suites through `.github/scripts/run-srt-sandbox-conformance.sh` or an explicitly equivalent Linux
  x86_64 boundary. The wrapper checks exact SRT `0.0.74`, Bubblewrap, `socat`, ripgrep, user namespaces, and Godot, then
  runs the single `corepack pnpm test:sandbox` suite for coding and real Godot/Preview integration. A missing
  prerequisite is not a product pass or failure.
- Reproduce a Bug with a test before fixing it. Do not weaken schemas, lint, compiler flags, or tests.
- Test maintained schemas, path ownership, process failures, source immutability, and security boundaries; do not
  assert exact model prose or one mandatory tool sequence.
- Runtime-state changes need proportionate success and failure coverage. Add corruption, history-loss,
  first-divergence, or budget tests only when the changed path implements those behaviors.
- Update README or architecture status when commands, behavior, capabilities, terminology, trust
  boundaries, or rollout change.
- A change is complete when its maintained boundary holds, external data is validated, proportionate tests pass, the
  relevant gates pass, and claims do not exceed the evidence.
