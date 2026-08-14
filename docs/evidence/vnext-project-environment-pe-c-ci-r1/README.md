# Project Environment PE-C CI Host Gate freeze r1

This directory records the successful narrow PE-C external-project Host Gate for ChronoRift product commit
`a119ec4f7a9a203d32db740b3dc4ffba7fc69ad0` (tree `17d3cadff45b3cf23826efb59f8ead94cc81ca15`).
GitHub Actions run
[`31779574638`](https://github.com/xiangzuodalao/ChronoRift/actions/runs/31779574638) completed successfully on
2026-08-14. The companion standard CI run
[`31779574707`](https://github.com/xiangzuodalao/ChronoRift/actions/runs/31779574707) also completed with all five jobs
successful.

The PE-C workflow used a deterministic fake Agent and the frozen external project
`endlessm/moddable-platformer@3e793f53598a131c53fb82555191cc14b8db07ff`. Its disposable checkout added the
declared dirty, explicit-untracked, nested-project, addon/`@tool`, and secondary-target overlay. The Host test covered
init, stable `SourceId`, default and selected target execution, new-Session environment reuse, and refusal with
`review_required` after a selected tracked byte changed.

This is deliberately a small metadata freeze. `github-actions-run.v1.json` retains the observed workflow/job facts,
and `freeze-record.v1.json` binds those facts to the product subject and checked-in interfaces. GitHub runner logs,
workflow artifacts, a product Git bundle, a standalone validator, and real-provider output are not archived here.

## Revalidation

From this directory:

```sh
sha256sum --strict -c SHA256SUMS
node -e 'for (const path of ["freeze-record.v1.json", "github-actions-run.v1.json"]) JSON.parse(require("node:fs").readFileSync(path, "utf8"))'
git merge-base --is-ancestor a119ec4f7a9a203d32db740b3dc4ffba7fc69ad0 HEAD
git cat-file -t vnext-project-environment-pe-c-ci-gate-r1-freeze | grep -x tag
```

The freeze anchor is the annotated tag `vnext-project-environment-pe-c-ci-gate-r1-freeze`. The tag targets the
documentation freeze commit; the product subject above is its ancestor.

## Trust boundary

The workflow was triggered by an ordinary branch push, not a protected release workflow. This archive copies GitHub
metadata and interface hashes but does not independently attest that the runner executed those bytes. Content hashes
detect later archive changes; they are not signatures.

The result proves only the checked-in PE-C boundary on one frozen external project, one deterministic overlay, the
exact Linux/Godot runner path, and a deterministic fake Agent. It does not prove arbitrary-project support, real-Pi
adapter generation, Agent debugging success, adapter semantic correctness, checkpoint or restore equivalence,
patch correctness, reliability, generalization, independent acceptance, complete Project Environment V1 conformance,
or external attestation. Those absent claims are not supplied by the successful standard CI run.

PE-C stops at this boundary. The next product slice is PC-1: real-Pi adapter reuse/generation through Agent debugging,
checkpoint/replay, a reviewable candidate patch, and lineage-bound evidence.
