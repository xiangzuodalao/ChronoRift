# r4 Harness boundary regressions

## Proposal scope regression

The r3 failure is reproduced with a strict `DiagnosisProposalV3` whose Capsule and baseline IDs are correct but
whose `runId` differs by one character from the Failure Brief. Before r4, `V03ToolFlow.submit` accepted it;
Conclusion Gate produced cross-investigation blockers; terminal integrity later rejected the manifest as a
Harness failure and stopped the campaign.

The r4 oracle is:

- wrong `runId` or `fixtureId` throws `PiHarnessError("INVALID_DIAGNOSIS")`;
- no proposal is latched and no accepted terminal proposal is exposed;
- the formal classifier maps the error to `diagnostic_failure/invalid_proposal`;
- the next scheduled benchmark cell still runs;
- downstream manifest integrity remains strict.

Focused coverage is in `packages/pi-harness/tests/v03-tool-flow.test.ts`; campaign continuation is covered in
`apps/cli/src/v03-formal-execution-v3.test.ts`.

## Public receipt projection regression

The frozen r3 publisher parsed a real non-empty `EvidenceAccessReceiptV1`, then reconstructed its public allowlist
without `schemaVersion`. The strict public case schema therefore rejected the projection before any output file
was written.

The r4 regression feeds a completed V3 terminal manifest with one Failure Brief receipt through
`sanitizeFormalCaseEvidence`. The result must contain the same canonical receipt fields plus
`schemaVersion: 1`; forbidden session, credential, request, source-text and host-path fields remain rejected. This
is tested in `apps/cli/src/v03-formal-publication-v3.test.ts`.

Neither fix changes the receipt-gap policy: a resolvable event with missing coverage remains a canonical
`inconclusive` blocker, while unknown or cross-investigation receipt IDs still fail closed.
