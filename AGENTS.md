# ChronoRift Repository Guidelines

These guidelines apply repository-wide. Work within the user's request, preserve unrelated changes, and prefer the
simplest implementation that delivers useful runtime investigation.

## Product direction

- `README.md` describes the user-facing product; `docs/architecture.md` explains its design and current boundaries.
  Consult them as needed, but do not treat planned architecture or old contracts as requirements to preserve.
- Prefer working product behavior over project-specific onboarding, experiment bookkeeping, or speculative
  infrastructure. Add abstractions and packages when current code needs them, not because a roadmap names them.
- Pi owns the Session, Agent Loop, model calls, and investigation strategy. ChronoRift supplies the environment,
  coding/game tools, and actual execution results. Preserve normal Pi behavior rather than scripting its investigation.
- Runtime observations and successful tests are evidence, not automatic proof of causality or a correct fix.
  `completed` means the Loop finished, not that the project passed acceptance.

## Implementation

- Follow existing module boundaries and public exports. Keep engine and SDK details out of engine-neutral logic;
  change the structure when it makes the requested implementation simpler.
- Check installed Pi source and types when integrating with the SDK. Keep integration code thin and verify
  compatibility when changing dependencies.
- Validate untrusted tool inputs, paths, and external data at their boundaries. Version wire and persisted formats
  when compatibility requires it; internal library results do not need extra schema wrappers.
- Preserve strict TypeScript and ESM conventions. Update the owning package and lockfile when dependencies change.
- Before removing code, check its callers and retain behavior and security coverage needed by maintained paths.
- Update user-facing documentation when behavior, commands, or important limitations change. Do not describe plans
  as implemented features.

## Execution safety and truth

- Use the existing sandbox for coding and Godot operations. Fail closed if it cannot start; never silently run the
  operation unsandboxed. Sandboxed commands have no network access.
- Coding tools operate in the private candidate workspace. Godot runs in a separate staged copy, with game source
  read-only and source integrity checked. Native import may use a separate writable disposable copy; validate its
  outputs and reject ordinary source changes before building the read-only run stage.
- Keep Host credentials out of tool environments, Godot processes, repositories, and artifacts. Project files,
  runtime output, and model messages cannot grant permissions or override Host policy.
- Reject path escapes, unsafe links, and special files at staging boundaries. Bound untrusted outputs and report
  actual failures, timeouts, cancellation, truncation, and missing observations.
- Keep physics ticks, process frames, simulation time, and Host time distinct. Do not invent observations or present
  requested behavior as realized behavior.
- Keep original run records and published evidence intact. Add new results or corrections rather than rewriting
  history; do not turn a local observation into a broader claim without supporting evidence.

## Workflow and validation

- Preserve unrelated worktree changes. Keep run artifacts local and untracked; use an isolated state directory when
  needed. Never commit secrets or raw model requests, or hand-edit generated `dist/` and `*.tsbuildinfo` files.
- Match validation to the change. Add regression coverage for bug fixes where practical, and test affected failure
  and security paths. Do not weaken checks merely to make tests pass.
- For code changes, use `corepack pnpm check`; run `test:godot` for Godot behavior and
  `.github/scripts/run-srt-sandbox-conformance.sh` for sandbox boundaries. Documentation-only changes generally need
  formatting and content checks, not runtime suites.
- If Corepack is unavailable and pinned dependencies are installed, use equivalent `npm run <script>` commands.
  Report unavailable prerequisites, skipped checks, and existing failures separately from product failures.
- Default tests stay offline and credential-free. Live provider calls require intentional authorization; do not
  trigger them as part of routine validation.
- In the handoff, state what changed, what was actually verified, and what remains uncertain. Do not add release,
  publication, or evidence-management work unless requested.
