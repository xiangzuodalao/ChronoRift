import { describe, expect, it } from "vitest";

import { ProjectAdapterLaunchTargetConformanceEvidenceV1Schema } from "../src/index.js";

const digest = (character: string): string => character.repeat(64);

const selectedEvidence = {
  schemaVersion: 1 as const,
  targetId: "secondary",
  vanillaDigest: digest("1"),
  bridgeOnlyDigest: digest("2"),
  instrumentedDigest: digest("3"),
  rawObservationRecordsPath:
    "records/dynamic-projection-conformance.v2.json" as const,
  rawObservationRecordsSha256: digest("4"),
  rawObservationChainPath: "records/dynamic-projection-chain.v2.json" as const,
  rawObservationChainSha256: digest("5"),
};

const defaultEvidence = {
  ...selectedEvidence,
  targetId: "main",
  rawObservationRecordsPath:
    "records/dynamic-projection-conformance.default.v2.json" as const,
  rawObservationChainPath:
    "records/dynamic-projection-chain.default.v2.json" as const,
};

const record = {
  schemaVersion: 1 as const,
  recordKind: "chronorift-project-adapter-launch-target-conformance" as const,
  conformanceReceiptId: "conformance:v2:launch-targets",
  defaultTargetId: "main",
  selectedTargetId: "secondary",
  targets: [defaultEvidence, selectedEvidence],
};

describe("Project Environment V2 launch-target conformance evidence", () => {
  it("binds unique default and selected targets to the two retained path pairs", () => {
    expect(
      ProjectAdapterLaunchTargetConformanceEvidenceV1Schema.parse(record),
    ).toMatchObject({
      defaultTargetId: "main",
      selectedTargetId: "secondary",
      targets: [{ targetId: "main" }, { targetId: "secondary" }],
    });
  });

  it("rejects crossed path pairs, duplicate paths, and missing target references", () => {
    expect(() =>
      ProjectAdapterLaunchTargetConformanceEvidenceV1Schema.parse({
        ...record,
        targets: [
          {
            ...selectedEvidence,
            rawObservationChainPath:
              "records/dynamic-projection-chain.default.v2.json",
          },
        ],
        defaultTargetId: "secondary",
        selectedTargetId: "secondary",
      }),
    ).toThrow(/same path pair/u);

    expect(() =>
      ProjectAdapterLaunchTargetConformanceEvidenceV1Schema.parse({
        ...record,
        targets: [
          selectedEvidence,
          { ...selectedEvidence, targetId: "another-target" },
        ],
        defaultTargetId: "another-target",
      }),
    ).toThrow(/artifact paths must be unique/u);

    expect(() =>
      ProjectAdapterLaunchTargetConformanceEvidenceV1Schema.parse({
        ...record,
        selectedTargetId: "missing-target",
      }),
    ).toThrow(/selectedTargetId/u);
  });
});
