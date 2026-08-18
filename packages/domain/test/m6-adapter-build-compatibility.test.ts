import { describe, expect, it } from "vitest";

import {
  M6AdapterBuildCompatibilityBindingV1Schema,
  M6AdapterBuildCompatibilityLineageV1Schema,
  M6AdapterBuildCompatibilityReceiptV1Schema,
} from "../src/index.js";

const sha = (character: string): string => character.repeat(64);

const lineage = {
  schemaVersion: 1 as const,
  buildRole: "assignment_baseline" as const,
  baselineSourceHash: sha("b"),
  adapterRevision: {
    schemaVersion: 1 as const,
    adapterRevisionId: "adapter-revision:m6:pristine",
    adapterId: "adapter:m6",
    sourceId: "source:v1:pristine",
    packageDigest: sha("1"),
    manifestDigest: sha("2"),
    implementationDigest: sha("3"),
    payloadSchemaDigest: sha("4"),
    sdkDigest: sha("5"),
    bridgeDigest: sha("6"),
    conformanceReceiptId: "conformance:m6:pristine",
  },
  build: {
    schemaVersion: 1 as const,
    taskId: "task:m6",
    workspaceId: "workspace:m6",
    sourceId: `source:${sha("b")}`,
    buildId: "build:m6:mutant",
    sourceHash: sha("b"),
    workspaceDiffHash: sha("7"),
    buildConfigurationHash: sha("8"),
    outputHash: sha("9"),
    createdAt: "2026-08-14T00:00:00.000Z",
  },
  toolchain: {
    schemaVersion: 1 as const,
    toolchainReceiptId: "toolchain:m6",
    artifactDigest: sha("a"),
  },
};

const completeCoverage = [
  {
    schemaVersion: 1 as const,
    channelId: "project_adapter_observations",
    status: "complete" as const,
    observedRecords: 2,
    droppedRecords: 0,
    overwrittenRecords: 0,
    limitations: [],
  },
];

const completeCleanup = {
  schemaVersion: 1 as const,
  processTreeTerminated: true,
  runtimeExited: true,
  bridgeExited: true,
  isolationGroupEmpty: true,
  scopeRemoved: true,
  scratchRemoved: true,
  storageReconciled: true,
};

describe("M6 AdapterRevision to exact Build compatibility", () => {
  it("keeps pristine AdapterRevision source separate from assignment Build source", () => {
    const parsed = M6AdapterBuildCompatibilityLineageV1Schema.parse(lineage);

    expect(parsed.adapterRevision.sourceId).toBe("source:v1:pristine");
    expect(parsed.adapterRevision.sdkDigest).toBe(sha("5"));
    expect(parsed.adapterRevision.bridgeDigest).toBe(sha("6"));
    expect(parsed.build.sourceId).toBe(`source:${sha("b")}`);
    expect(parsed.toolchain.toolchainReceiptId).toBe("toolchain:m6");
    expect(parsed.toolchain.artifactDigest).toBe(sha("a"));
    expect(parsed).not.toHaveProperty("environmentRevisionId");
    expect(parsed.adapterRevision).not.toHaveProperty("environmentRevisionId");
    expect(parsed.build).not.toHaveProperty("environmentRevisionId");
  });

  it("rejects an EnvironmentRevision identity and an inexact Build source identity", () => {
    expect(() =>
      M6AdapterBuildCompatibilityLineageV1Schema.parse({
        ...lineage,
        environmentRevisionId: "environment-revision:must-not-appear",
      }),
    ).toThrow();
    expect(() =>
      M6AdapterBuildCompatibilityLineageV1Schema.parse({
        ...lineage,
        build: { ...lineage.build, sourceId: "source:not-the-tree-hash" },
      }),
    ).toThrow(/sourceId/u);
  });

  it("distinguishes the assignment baseline from a changed candidate", () => {
    expect(() =>
      M6AdapterBuildCompatibilityLineageV1Schema.parse({
        ...lineage,
        buildRole: "candidate",
      }),
    ).toThrow(/candidate/u);

    const candidateHash = sha("c");
    const candidate = M6AdapterBuildCompatibilityLineageV1Schema.parse({
      ...lineage,
      buildRole: "candidate",
      build: {
        ...lineage.build,
        sourceId: `source:${candidateHash}`,
        sourceHash: candidateHash,
        buildId: "build:m6:candidate",
      },
    });
    expect(candidate.build.sourceHash).toBe(candidateHash);
  });

  it("requires compatibility outcome to match runtime facts and binding state", () => {
    const receipt = {
      schemaVersion: 1 as const,
      receiptId: "m6-compatibility:receipt:1",
      lineage,
      bridgeHandshakeObserved: true,
      instrumentedLaunchObserved: true,
      queryObservations: {
        schemaVersion: 1 as const,
        entityQueryObserved: true,
        stateQueryObserved: true,
        entityRows: 1,
        stateRows: 1,
      },
      coverage: completeCoverage,
      loss: [],
      cleanup: completeCleanup,
      outcome: "compatible" as const,
      failures: [],
      observedAt: "2026-08-14T00:00:01.000Z",
    };
    expect(
      M6AdapterBuildCompatibilityReceiptV1Schema.parse(receipt).outcome,
    ).toBe("compatible");
    expect(() =>
      M6AdapterBuildCompatibilityReceiptV1Schema.parse({
        ...receipt,
        bridgeHandshakeObserved: false,
      }),
    ).toThrow(/outcome/u);

    expect(
      M6AdapterBuildCompatibilityBindingV1Schema.parse({
        schemaVersion: 1,
        bindingId: "m6-adapter-build-binding:1",
        lineage,
        compatibilityStatus: "compatible",
        compatibilityReceiptId: receipt.receiptId,
        createdAt: "2026-08-14T00:00:00.000Z",
        completedAt: "2026-08-14T00:00:01.000Z",
      }).compatibilityReceiptId,
    ).toBe(receipt.receiptId);
    expect(() =>
      M6AdapterBuildCompatibilityBindingV1Schema.parse({
        schemaVersion: 1,
        bindingId: "m6-adapter-build-binding:1",
        lineage,
        compatibilityStatus: "pending",
        compatibilityReceiptId: receipt.receiptId,
        createdAt: "2026-08-14T00:00:00.000Z",
        completedAt: null,
      }),
    ).toThrow(/expected null/u);
  });
});
