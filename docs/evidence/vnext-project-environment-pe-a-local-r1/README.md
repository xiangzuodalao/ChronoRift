# Project Environment PE-A local Gate freeze r1

This directory is a self-contained, local Operator archive of the successful PE-A real-Pi Gate run against
ChronoRift product commit `5d98857a0c5423d050615b93d6fa0dfd6f109a5b` (tree
`bad52d21f3f3a315ad1e5c5e57785da9c6183d6a`). The run used
`openai-codex / gpt-5.6-luna / max`, Godot 4.7.1, and two distinct Pi Sessions: initialization plus the first
user goal, followed by new-Session adapter reuse and another observed candidate Build.

The evidence bundle is the authoritative execution record. `freeze-record.v1.json` binds its exact bytes to the
locally observed product subject, Gate interfaces, environment identity, validation output, and claim boundary.
The archived schema and validator can validate the bundle without importing ChronoRift product TypeScript.

## Revalidation

From this directory, with Node v22.23.1 available:

```sh
test "$(node --version)" = "v22.23.1"
sha256sum --strict -c SHA256SUMS
node validator/validate-project-environment-pe-a-evidence.mjs \
  schema/pe-a-evidence-bundle.schema.v1.json \
  evidence/pe-a-evidence.v1.json | cmp - validator/validator-result.v1.json
```

The evidence file has raw SHA-256
`93bde03db2d71cff53a63c55c0b04cddca7423657b2da4a78b54e44f66226590`, byte length `130988`, and canonical
`bundleContentHash` `ad53d152a05017c21f9ee64580fcba96bbe99febab0ec00b33ec6a0c7c7e2f2f`.

The intended freeze anchor is the annotated tag
`vnext-project-environment-pe-a-local-gate-r1-freeze`. The outer local `run.sh` is deliberately not archived
because it embeds an Operator-specific absolute Host path; its exact SHA-256 is recorded in
`freeze-record.v1.json`. The container entrypoint and Host config used by the Gate are archived under `gate/`.

## Trust boundary

This is a local, unprotected Operator archive. Content hashes detect corruption; they are not signatures,
external provenance, or attestation that the recorded product commit produced the run. The archive contains no
Git bundle or complete product tree, so inspection of the product subject still requires that exact Git object.

A bounded custom scanner covered the evidence JSON strings and keys plus all 12 declared adapter/ledger/capture
base64 fields. It compared two Pi credential fields in memory without persisting their values or hashes and found
zero generic findings and zero exact credential matches. A separate generic/path pass also covered the archived
interfaces and found no Host path in the evidence. Neither pass was a specialist secret-scanner or entropy scan,
so the result is not proof that no sensitive value exists.

The result covers one frozen clean/single-root fixture. It does not establish arbitrary Godot-project support,
adapter semantic correctness, equivalent snapshot/restore, fix correctness, reliability, success rate,
generalization, independent acceptance, complete Project Environment V1 conformance, or exact model-weight
identity.
