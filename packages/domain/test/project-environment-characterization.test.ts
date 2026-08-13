import { describe, expect, it } from "vitest";

import { ProjectSnapshotCharacterizationReceiptV1Schema } from "../src/index.js";

const digest = (character: string): string => character.repeat(64);

const domain = {
  schemaVersion: 1 as const,
  domainId: "world",
  disposition: "captured" as const,
  expectedHash: digest("a"),
  mutatedHash: digest("b"),
  actualHash: digest("a"),
  mutationObserved: true,
  restoreStatus: "written" as const,
  missing: false,
  mismatch: false,
  limitations: [],
};

const receipt = {
  schemaVersion: 1 as const,
  receiptId: "snapshot-characterization:fixture:1",
  taskId: "task:pe-a:snapshot",
  adapterRevisionId: "adapter-revision:pe-a:snapshot",
  buildId: "build:pe-a:snapshot",
  runtimeId: "runtime:pe-a:snapshot",
  executionId: "execution:pe-a:snapshot",
  initialSnapshotId: "snapshot:0",
  mutationSnapshotId: "snapshot:1",
  readBackSnapshotId: "snapshot:2",
  mutationId: "mutation:set-counter",
  requestedBarrierId: "process_frame_end",
  initialRealizedBarrierId: "process_frame_end",
  mutationRealizedBarrierId: "process_frame_end",
  restoreRealizedBarrierId: "process_frame_end",
  readBackRealizedBarrierId: "process_frame_end",
  controlledMutationObserved: true,
  domains: [domain],
  firstDivergence: null,
  conclusion: "descriptive_only" as const,
  limitations: ["Only Adapter-declared snapshot projections were compared."],
};

describe("PE-A snapshot characterization receipt", () => {
  it("accepts mutation and matching read-back evidence only as descriptive", () => {
    const parsed =
      ProjectSnapshotCharacterizationReceiptV1Schema.parse(receipt);

    expect(parsed.controlledMutationObserved).toBe(true);
    expect(parsed.domains[0]).toMatchObject({
      mutationObserved: true,
      missing: false,
      mismatch: false,
    });
    expect(parsed.firstDivergence).toBeNull();
    expect(parsed.conclusion).toBe("descriptive_only");
  });

  it("requires missing and mismatch booleans to follow digest evidence", () => {
    expect(() =>
      ProjectSnapshotCharacterizationReceiptV1Schema.parse({
        ...receipt,
        domains: [{ ...domain, actualHash: null, missing: false }],
      }),
    ).toThrow(/missing must report an absent read-back digest/u);

    expect(() =>
      ProjectSnapshotCharacterizationReceiptV1Schema.parse({
        ...receipt,
        domains: [
          {
            ...domain,
            actualHash: digest("c"),
            mismatch: false,
          },
        ],
      }),
    ).toThrow(/mismatch must match/u);
  });

  it("requires first divergence to identify the first differing domain", () => {
    const mismatched = {
      ...domain,
      actualHash: digest("c"),
      mismatch: true,
      limitations: ["read-back differs"],
    };
    expect(() =>
      ProjectSnapshotCharacterizationReceiptV1Schema.parse({
        ...receipt,
        domains: [mismatched],
        firstDivergence: null,
      }),
    ).toThrow(/firstDivergence/u);

    expect(
      ProjectSnapshotCharacterizationReceiptV1Schema.parse({
        ...receipt,
        domains: [mismatched],
        firstDivergence: {
          schemaVersion: 1,
          domainId: "world",
          kind: "mismatch",
          expectedHash: digest("a"),
          actualHash: digest("c"),
          observation: "post_restore_read_back",
          description: "World differs at read-back.",
        },
      }).firstDivergence,
    ).toMatchObject({ domainId: "world", kind: "mismatch" });
  });

  it("does not compare uncontrolled state domains", () => {
    expect(
      ProjectSnapshotCharacterizationReceiptV1Schema.parse({
        ...receipt,
        domains: [
          domain,
          {
            schemaVersion: 1,
            domainId: "engine.runtime",
            disposition: "uncontrolled",
            expectedHash: null,
            mutatedHash: null,
            actualHash: null,
            mutationObserved: false,
            restoreStatus: "uncontrolled",
            missing: false,
            mismatch: false,
            limitations: ["Engine runtime state is not captured."],
          },
        ],
      }).domains[1],
    ).toMatchObject({
      disposition: "uncontrolled",
      expectedHash: null,
      actualHash: null,
    });
  });
});
