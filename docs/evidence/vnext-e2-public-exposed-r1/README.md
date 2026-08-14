# vNext E2 public-exposed r1 evidence and r2 freeze

This directory preserves the sanitized M4 and E2 inner-file bytes that the operator downloaded from the artifact of
GitHub Actions run `31416348238` for product subject commit
`f8ccb183eb7db21c1737b60a9f4970dce5ff17f0` and byte-compared when archiving. The repository validators accept both
files, and `freeze-record.v1.json` binds their hashes to the frozen source, semantic adapter, product interfaces,
task budgets, and evaluator interface contract.

The recorded GitHub artifact archive digest, URLs, and expiry are observed API metadata. The archived sanitized
inner bytes are durable and locally hash-verifiable. The offline validator does not reproduce the expiring ZIP or
independently attest the archive-to-inner-file linkage; the download and byte comparison remain operator-recorded
provenance.

The evidence establishes a deterministic public-exposed plumbing conformance result only. It records two sealed E2
executions and M4 source/cleanup facts, but it is not an independent evaluator result, a signature, an attestation,
or a preregistration. The holdout task remains unselected and the external evaluator implementation remains absent;
only its single-assignment V1 artifact interface, validator, budgets, retry rules, and result-retention contract are
frozen here. One 1 GiB/131072-inode aggregate Task-storage budget is shared by the Agent, evaluator, runtimes, and
evaluation artifacts; it is not a separate allowance for each phase. Pi Agent auto retries (at most two in one retry
cycle and at most eight observed across the Agent attempt for eligibility) are distinct from provider-SDK retries,
whose configured per-model-call maximum is zero, and from the evaluator's one eligible infrastructure retry.

The validator can recompute deterministic assignment/evaluation/scenario identities and referenced source, exact
patch, runtime-ledger, physical-seal, artifact, message, and receipt hashes. The ledger must reference a checkout
receipt binding the frozen product commit/tree/interface inventory; an `invalid_candidate` result must retain a
candidate-admission rejection receipt rather than merely label itself invalid. Those receipts, like usage and
cleanup measurements, are produced by the future Host/evaluator: their hashes validate contents and bindings, not
origin or measurement truth. Cross-assignment denominator uniqueness still requires the absent create-only store,
so one valid ledger cannot establish a complete campaign denominator or rule out omitted/replaced assignments.

The immutable `vnext-e2-public-exposed-conformance-r1-freeze` tag remains as a failed freeze attempt: its tag CI
correctly rejected the local lightweight ref that `actions/checkout` produced after fetching the annotated tag. The
`vnext-e2-public-exposed-conformance-r2-freeze` anchor restores and verifies the exact remote annotated tag object
after checkout. This r2 change repairs freeze-validation plumbing only; it does not change the product subject,
archived evidence, evaluator status, or claim boundary above.
