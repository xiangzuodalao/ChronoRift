# PE-C external-project contract

`moddable-platformer.contract.v1.json` is a test-only Host contract for the narrow PE-C slice. It pins the same
upstream commit and tree used by M4/E2, but it does not modify or supersede their frozen descriptors, wrappers, or
evidence.

The PE-C wrapper clones a clean, operator-provisioned copy into `RUNNER_TEMP`, removes its remote, and adds a
deterministic working-tree overlay: tracked dirty bytes, staged addon/`@tool` and scene files, a source-defined
autoload runtime probe, a second `project.godot`, and one explicitly selected untracked file. The `@tool`
`EditorPlugin` writes an import marker only from its editor lifecycle. The bounded runtime probe emits its
source-owned spawn, signal/state change, removal, and respawn trace only after observing that marker; the adapter
only observes those project semantics. The product test must derive all identities from the resulting bytes; these
fixture names are not product allowlists.

The contract describes required checks, not successful evidence. Running the setup script without the fixed PE-C
Host test, or failing any product assertion, is a failed Gate.
