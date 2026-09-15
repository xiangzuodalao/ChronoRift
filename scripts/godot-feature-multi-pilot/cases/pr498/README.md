# PR #498: Input hints

This case prepares Maaack/Godot-Game-Template's input-hint feature for offline controls. The case-local evaluator snapshots ordinary source, imports in the existing SRT sandbox, and only starts a read-only staged behavior check after import succeeds. It preserves the upstream `override.cfg`; no managed override is injected by this standalone evaluator. Product source admission remains unchanged.

The frozen English task, exact source identities, hidden GDScript and all control outputs live in the private preparation directory named by `manifest.json`. The hidden file is supplied through `evaluator.options.checkerPath` and listed in `evaluator.frozenPaths`; it must never enter a model workspace.

```sh
node --import tsx scripts/godot-feature-multi-pilot/cases/pr498/check.mjs \
  --project BASE_OR_REFERENCE --godot-bin GODOT \
  --checker PRIVATE_CHECKER --output NEW_DIRECTORY
node --import tsx --test scripts/godot-feature-multi-pilot/cases/pr498/check.test.mjs
```

The initial preparation is blocked: the runtime rejects the tracked root `override.cfg`, and ordinary full-project native import reports missing translation resources and a plugin HTTP failure in the network-isolated sandbox. Behavior assertions and feature mutants are therefore unobserved. A suspected combined keyboard/mouse cycling defect is only a source-review concern, not a measured failure. No files or requirements are removed to make this case eligible.
