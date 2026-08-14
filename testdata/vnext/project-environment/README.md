# PE-A evidence bundle

`pe-a-evidence-bundle.schema.v1.json` is the minimum stable producer contract for an independently
reviewable Project Environment PE-A evidence bundle. The validator is a standalone Node program and
does not import ChronoRift product TypeScript:

```sh
npm run validate:project-environment:pe-a -- \
  testdata/vnext/project-environment/pe-a-evidence-bundle.schema.v1.json \
  /path/to/frozen-pe-a-evidence.json
```

The schema file is byte-pinned by the validator. Changing it requires an intentional validator and
test update, not an in-place reinterpretation of old evidence. Every embedded record also has a
canonical content hash, and `bundleContentHash` seals the complete bundle except for that field.

This directory does **not** contain a real passing PE-A evidence bundle. The synthetic bundle in the
validator test proves validator behavior only; it is not execution evidence, and its passing result
must not be reported as the PE-A Gate passing.

## Implemented producer boundary

The PE-A live Gate assembles this manifest only from already sealed records, after both the initial
user-goal turn and the new-Session reuse runtime cleanup have finished:

- Take `source` from successful clean-source preflight, without reconstructing its identity from prose.
- Take `adapter`, `environment`, and `publication` from the authoritative candidate validation,
  immutable revision materialization, and committed publication receipt.
- Take `candidateBuild` and `compatibility` from the post-edit Build resolver and its exact compatibility
  receipt. A baseline-only Build is not admissible.
- Take `binding` and both ordered turns from the first Task store. They must identify one Session, with
  publication and binding completed before the queued user goal starts.
- Take `runtime` only from a durable `ProjectEnvironmentRuntimeObservationReceiptV1` read through the
  Task store after the Agent has queried non-empty entity and state projections, pinned a capture, and
  stopped the exact candidate Build. The runtime port supplies its runtime/execution identities, final
  clock (including nullable render frame), query row counts, coverage, structured loss, and cleanup;
  the exporter must not synthesize any of them.
- Include the folded initialization attempt, exact toolchain receipt, full immutable revision package seal,
  all three sealed Task ledgers, immutable-record inventory, and exact raw pinned-capture packages.
- Include the second Task's reuse receipt, distinct Session, binding, exact compatible Build, goal turn,
  runtime receipt, raw pinned capture, and complete sealed inventory. It must not contain a generated
  Adapter candidate or initialization turn.
- Set each `goalDelivered` only from the corresponding sealed user-goal turn outcome. Agent prose is not
  evidence for it.

The live Gate requires a canonical, explicitly configured
`CHRONORIFT_TEST_PE_A_EVIDENCE_OUTPUT_DIR`, writes the fixed
`pe-a-evidence.v1.json` name with create-new semantics, and invokes the independent validator on that
frozen file and the repository-pinned schema. It does not manufacture missing records or translate
validator success into a product acceptance verdict. Without an actual retained real-Pi output, PE-A's
status remains implementation-present rather than Gate-passed.
