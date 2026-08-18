# vNext M5 public-exposed local r1 evidence

This directory preserves the exact sanitized bundle published by the successful local `r8` M5 live Gate on
2026-08-12. The Gate ran one real `openai-codex/gpt-5.6-luna/max` turn against the frozen public
`endlessm/moddable-platformer` checkout, then ran the standalone validator again after publication. The archived
`bundle/` contains exactly the 15 files accepted by that validator; no Pi session, model request, credential, Host
path, or assistant prose is retained.

This is a **local, unprotected operator archive**, not a GitHub Actions artifact from the protected M5 workflow. It
supports reporting that the local real Gate passed and that the M5 implementation is present. It does not change
the repository status to permanent `M5 conformance passed`; that stronger status still requires a protected-ref
workflow artifact to be downloaded, byte-compared, and frozen separately.

## Observed result

- Product subject: clean commit `896eac0b5f8f1dddec952f341f0fe5299d0967ad`, tree
  `892d7bedf094a3179779d614183512556d58ad2d`.
- External source: clean commit `3e793f53598a131c53fb82555191cc14b8db07ff`, tree
  `a013bd677c712dbf354e8e2f6e8ff7c53d5684c6`.
- Baseline execution: Timer wait time `0.001` seconds; a later sampled endpoint at relative simulation time
  `8,502,209` microseconds had cumulative spawn ordinal `257`. The bounded entity projection saturated at 256 and
  explicitly records one dropped entity-lifecycle ordinal.
- Candidate execution: the ready endpoint had Timer wait time `1` second and no spawn; a later sampled endpoint at
  relative simulation time `32,887,910` microseconds had cumulative spawn ordinal `32`.
- Ordering: the decisive baseline endpoint ended at Host monotonic `84,349,940` microseconds, before candidate ready
  began at `129,569,187` microseconds.
- Patch: 688 nonempty bytes, changing only the pre-existing tracked
  `components/spawner/spawner_broken.gd`; it replaces `timer.start(spawn_interval / 1000)` with
  `timer.start(spawn_interval)`. Full-index patch application round-trips from the frozen baseline to the exact
  candidate selected-tree hash.
- Cleanup: process group terminated, cgroup empty, scope removed, storage reconciled, Task root removed, bounded
  storage empty, Task cgroup leaves empty, and the Host source checkout unchanged.

These are endpoint observations, not continuous event capture. They do not establish the exact first-spawn time.
The frozen task disclosed the affected scene, symptom, and observable contract, so “found and fixed” here means the
Agent located and changed the relevant real GDScript and produced a final source-bound Godot run satisfying that
contract. It does not establish autonomous discovery of an unknown Bug, intelligent diagnosis, root-cause
correctness, independent acceptance, general correctness, reliability, success rate, generalization, or arbitrary
project support.

## Revalidation

From a checkout containing the M5 implementation, prepare an exact clean external-source checkout and run:

```bash
git clone https://github.com/endlessm/moddable-platformer /tmp/moddable-platformer-m5
git -C /tmp/moddable-platformer-m5 checkout --detach 3e793f53598a131c53fb82555191cc14b8db07ff

node .github/scripts/validate-vnext-m5-evidence.mjs \
  testdata/vnext/m5/moddable-platformer.behavior-change-task.v1.json \
  testdata/vnext/m5/evidence-bundle.schema.v1.json \
  docs/evidence/vnext-m5-public-exposed-local-r1/bundle \
  /tmp/moddable-platformer-m5
```

The product subject was created in a clean synthetic checkout because the shared development worktree contained
unrelated in-progress changes. `product-subject.gitbundle` preserves the six post-`174f20f` commits and exact
`896eac0b` object. Its SHA-256 is
`02e4d6225aa7bfa745621878a1fcf6df0e809c9a715b356284a681117073b332`; it requires prerequisite commit
`174f20f9787139ad0c6c9b1cee0c5ab82244aa7c`.

```bash
git bundle verify docs/evidence/vnext-m5-public-exposed-local-r1/product-subject.gitbundle

git clone . /tmp/chronorift-m5-product-subject
git -C /tmp/chronorift-m5-product-subject fetch \
  "$PWD/docs/evidence/vnext-m5-public-exposed-local-r1/product-subject.gitbundle" \
  refs/heads/vnext-m5-local-r8-product:refs/remotes/m5-local/r8-product
git -C /tmp/chronorift-m5-product-subject switch --detach \
  896eac0b5f8f1dddec952f341f0fe5299d0967ad
```

`freeze-record.v1.json` records the observed hashes, behavior endpoints, cleanup facts, and trust boundary. Content
hashes detect corruption and bind the records together; they are not signatures or external attestations.
