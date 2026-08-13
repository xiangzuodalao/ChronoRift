# Project Environment PE-B local Gate freeze r1

This directory is a self-contained, local Operator archive of the successful PE-B Dynamic Projection Gate run
against ChronoRift product commit `0731eb13b0c103dbcb61bd0e2d967962838324a4` (tree
`10fe9ac15cb751febe5d2bb47838aaf6e101689d`). The run used
`openai-codex / gpt-5.6-luna / max`, the exact managed Godot 4.7.1 binary, and two distinct Pi Sessions.

The first Session authored and finalized a V2 adapter, passed authoritative dynamic conformance, published it,
and then used game tools against the exact Build. A new Task and Session reused the same environment revision and
observed a second independent dynamic trace without generating another adapter candidate. Both pinned captures
contain the lossless nine-record sequence from incarnation 1 through incarnation 2.

The evidence bundle is the authoritative execution record. `freeze-record.v1.json` binds its exact bytes to the
locally observed product subject, Gate interfaces, environment identity, validation output, and claim boundary.
The archived schema and standalone validator validate the bundle without importing ChronoRift product
TypeScript.

## Revalidation

From this directory, with Node v22.23.1 available:

```sh
test "$(node --version)" = "v22.23.1"
sha256sum --strict -c SHA256SUMS
node validator/validate-project-environment-pe-b-evidence.mjs \
  schema/pe-b-evidence-bundle.schema.v2.json \
  evidence/pe-b-evidence.v2.json | cmp - validator/validator-result.v2.json
```

The evidence file has raw SHA-256
`b23ecf61df74af7c04e784cd36a90351107e8c354726e068a764e3174491e6aa`, byte length `78823`, and canonical
`bundleContentHash` `df1388507271901602fb8371d50087ddc17c528270459f73d6493bbc6a981bf1`.

The freeze anchor is the annotated tag
`vnext-project-environment-pe-b-local-gate-r1-freeze`. The Operator-specific outer runners are deliberately not
archived; their hashes are recorded in `freeze-record.v1.json`. The container entrypoint and Host config used by
the model Gate are archived under `gate/`.

## Measured timings

- Adapter finalizer succeeded at 254393 ms after the initialization turn began.
- The complete initialization model turn took 260037 ms.
- The real-model live test took 387718 ms; the complete Vitest process took 392250 ms.
- The final default Gate took 102330 ms, the Godot Gate 80810 ms, and the privileged Host/sandbox test 72333 ms.

These are one-run observations, not latency guarantees or a success-rate claim.

## Trust boundary

This is a local, unprotected Operator archive. Content hashes detect corruption; they are not signatures,
external provenance, or attestation that the recorded product commit produced the run. The archive contains no
Git bundle or complete product tree, so inspection of the product subject still requires that exact Git object.

The bounded archive scan traversed evidence JSON strings and keys plus every declared `canonicalBase64` and
`recordsCanonicalBase64` field. It also compared credential values from the local Pi auth store in memory without
persisting or printing their values or hashes. The scan is not a specialist secret scanner or entropy scan and is
not proof that no sensitive value exists.

The result proves only one frozen clean, single-root, single-target dynamic Godot structure. It does not establish
arbitrary Godot-project support, adapter semantic correctness, Signal causality, complete Signal/property
interception, snapshot equivalence, reliability, success rate, generalization, independent acceptance, complete
Project Environment V1 conformance, or exact model-weight identity. The default `chronorift [goal]` entry point
remains unpromoted; the next slice is PE-C Source/Import Closure.
