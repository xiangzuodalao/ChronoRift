import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  asAdapterConformanceReceiptId,
  type ProjectAdapterLaunchTargetValidationV1,
} from "@chronorift/domain";
import {
  loadProjectAdapterPackageFilesV2,
  type ProjectAdapterPackageBytesV2,
  type ProjectAdapterLaunchTargetV2,
} from "@chronorift/godot-adapter";
import type { GodotProjectEnvironmentObservationRecordV2 } from "@chronorift/godot-protocol";

import { createProjectAdapterReferenceTemplateFilesV2 } from "./project-adapter-reference-template-v2.js";
import {
  runProjectAdapterLaunchTargetConformanceV2,
  type ProjectEnvironmentConformanceDriverV2,
  type ProjectEnvironmentInstrumentedObservationV2,
} from "./project-environment-conformance-driver-v2.js";
import { projectAdapterObservationFailuresV2 } from "./project-environment-conformance-v2.js";
import {
  assertReusableProjectEnvironmentRuntimeDigestsV2,
  resolveReusableProjectEnvironmentLaunchTargetV2,
} from "./project-environment-reuse-v2.js";

const candidateFiles = (
  secondParametersSchemaId = "launch.params",
): readonly ProjectAdapterPackageBytesV2[] => {
  const files = createProjectAdapterReferenceTemplateFilesV2({
    adapterId: "adapter.multi-target" as never,
    mainScene: "res://main.tscn",
  }).map((file) => ({
    path: file.relativePath.replace(/^templates\/minimal\//u, ""),
    bytes: Uint8Array.from(file.bytes),
  }));
  return files.map((file) => {
    if (file.path !== "manifest.json") return file;
    const manifest = JSON.parse(Buffer.from(file.bytes).toString("utf8")) as {
      launchTargets: Record<string, unknown>[];
    };
    manifest.launchTargets.push({
      schemaVersion: 2,
      targetId: "secondary",
      scene: "res://secondary.tscn",
      default: false,
      parametersSchemaId: secondParametersSchemaId,
      renderer: "headless",
      requiredModules: [],
    });
    return {
      path: file.path,
      bytes: Buffer.from(`${JSON.stringify(manifest)}\n`, "utf8"),
    };
  });
};

const processObservation = () => ({
  launched: true,
  importSucceeded: true,
  stableWindowObserved: true,
  exitCode: 0,
  signal: null,
  timedOut: false,
  stdoutSha256: createHash("sha256").update("stdout").digest("hex") as never,
  stderrSha256: createHash("sha256").update("stderr").digest("hex") as never,
  stdoutTruncated: false,
  stderrTruncated: false,
  elapsedMonotonicMs: 1,
  resourceUsage: {
    cpuUsageUsec: 1,
    memoryPeakBytes: 1,
    pidsPeak: 1,
  },
  sourceIdentityReverified: true,
  processTreeTerminated: true,
  isolationGroupEmpty: true,
  scopeRemoved: true,
  scratchRemoved: true,
  storageReconciled: true,
});

const instrumentedObservation =
  (): ProjectEnvironmentInstrumentedObservationV2 => ({
    ...processObservation(),
    bridgeHandshakeCount: 1,
    entityLifecycleRecords: 1,
    stateSamples: 1,
    queries: 3,
    observedCustomEventTypeIds: [],
    captures: 1,
    stateDomainIds: [],
    transportRecords: 1,
    droppedRecords: 0,
    overwrittenRecords: 0,
    semanticCoverage: "declared",
    runtimeFailures: [],
    bridgeExited: true,
    rawRecords: [] as GodotProjectEnvironmentObservationRecordV2[],
    dynamicTraces: [],
  });

describe("PE-C launch-target validation", () => {
  it("accepts a complete state-only observation and rejects vacuous coverage", () => {
    const loaded = loadProjectAdapterPackageFilesV2(candidateFiles(), {
      expectedMainScene: "res://main.tscn",
      requireEmptyLaunchParameters: true,
    });
    const manifest = {
      ...loaded.manifest,
      eventTypes: [],
      smoke: {
        ...loaded.manifest.smoke,
        minimumStateSamples: 1,
        minimumEntityLifecycleRecords: 1,
        requiredCustomEventTypeIds: [],
        requiredDynamicTraces: [],
      },
    };
    const complete = {
      ...instrumentedObservation(),
      stateDomainIds: ["dynamic-placeholder-state"],
    };

    expect(
      projectAdapterObservationFailuresV2("target main", manifest, complete),
    ).toEqual([]);
    expect(
      projectAdapterObservationFailuresV2("target main", manifest, {
        ...complete,
        entityLifecycleRecords: 0,
        stateSamples: 0,
        stateDomainIds: [],
      }),
    ).toEqual([
      "target main minimum entity lifecycle records were not observed",
      "target main minimum state samples were not observed",
      "target main required state domain dynamic-placeholder-state was not observed",
    ]);
  });

  it("still requires declared events, dynamic traces, and lossless records", () => {
    const loaded = loadProjectAdapterPackageFilesV2(candidateFiles(), {
      expectedMainScene: "res://main.tscn",
      requireEmptyLaunchParameters: true,
    });
    const failures = projectAdapterObservationFailuresV2(
      "target main",
      loaded.manifest,
      {
        ...instrumentedObservation(),
        stateDomainIds: ["dynamic-placeholder-state"],
        droppedRecords: 1,
      },
    );

    expect(failures).toEqual([
      "target main minimum entity lifecycle records were not observed",
      "target main minimum state samples were not observed",
      "target main required event type dynamic-placeholder-event was not observed",
      "target main required dynamic trace was not observed",
      "target main dynamic projection was not lossless and declared",
    ]);
  });

  it.each(["sdkDigest", "bridgeDigest", "policyProfileDigest"] as const)(
    "requires review when the reusable %s changes",
    (changed) => {
      const expected = {
        sdkDigest: "1".repeat(64),
        bridgeDigest: "2".repeat(64),
        policyProfileDigest: "3".repeat(64),
      };
      let failure: unknown;
      try {
        assertReusableProjectEnvironmentRuntimeDigestsV2({
          revision: expected as never,
          ...expected,
          [changed]: "4".repeat(64),
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ code: "review_required" });
    },
  );

  it("resolves a selected target while preserving the unique default", () => {
    const loaded = loadProjectAdapterPackageFilesV2(candidateFiles(), {
      selectedLaunchTargetId: "secondary",
      expectedMainScene: "res://main.tscn",
      requireEmptyLaunchParameters: true,
    });

    expect(loaded.launchTargetSelection).toMatchObject({
      defaultTarget: { targetId: "main", default: true },
      selectedTarget: { targetId: "secondary", default: false },
    });
    expect(
      loaded.launchTargetSelection.targetsToValidate.map(
        (target) => target.targetId,
      ),
    ).toEqual(["main", "secondary"]);
  });

  it("allows a multi-target publication to validate only default when selection is omitted", () => {
    const loaded = loadProjectAdapterPackageFilesV2(candidateFiles(), {
      expectedMainScene: "res://main.tscn",
      requireEmptyLaunchParameters: true,
    });

    expect(loaded.launchTargetSelection.selectedTarget.targetId).toBe("main");
    expect(
      loaded.launchTargetSelection.targetsToValidate.map(
        (target) => target.targetId,
      ),
    ).toEqual(["main"]);
  });

  it("keeps the legacy single-target boundary when no PE-C selection is supplied", () => {
    expect(() =>
      loadProjectAdapterPackageFilesV2(candidateFiles(), {
        requireSingleLaunchTarget: true,
      }),
    ).toThrow(/exactly one launch target/u);
  });

  it("requires empty parameters for every declared launch target", () => {
    expect(() =>
      loadProjectAdapterPackageFilesV2(
        candidateFiles("entity.dynamic-placeholder"),
        {
          selectedLaunchTargetId: "secondary",
          requireEmptyLaunchParameters: true,
        },
      ),
    ).toThrow(/strict empty launch parameters.*secondary/u);
  });

  it("returns a stable code for a selected target absent from the manifest", () => {
    let failure: unknown;
    try {
      loadProjectAdapterPackageFilesV2(candidateFiles(), {
        selectedLaunchTargetId: "missing",
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: "target_not_validated" });
  });

  it("runs all three stages for default and a distinct selected target only", async () => {
    const loaded = loadProjectAdapterPackageFilesV2(candidateFiles(), {
      selectedLaunchTargetId: "secondary",
      expectedMainScene: "res://main.tscn",
      requireEmptyLaunchParameters: true,
    });
    const calls: string[] = [];
    const driver: ProjectEnvironmentConformanceDriverV2 = {
      runVanilla: vi.fn(async (target?: ProjectAdapterLaunchTargetV2) => {
        calls.push(`vanilla:${target?.targetId}`);
        return processObservation();
      }),
      runBridgeOnly: vi.fn(async (target?: ProjectAdapterLaunchTargetV2) => {
        calls.push(`bridge:${target?.targetId}`);
        return processObservation();
      }),
      runInstrumented: vi.fn(
        async (_package, target?: ProjectAdapterLaunchTargetV2) => {
          calls.push(`instrumented:${target?.targetId}`);
          return instrumentedObservation();
        },
      ),
    };

    const runs = await runProjectAdapterLaunchTargetConformanceV2(
      loaded,
      driver,
    );

    expect(runs.map((run) => run.target.targetId)).toEqual([
      "main",
      "secondary",
    ]);
    expect(calls).toEqual([
      "vanilla:main",
      "bridge:main",
      "instrumented:main",
      "vanilla:secondary",
      "bridge:secondary",
      "instrumented:secondary",
    ]);
  });

  it("rejects reuse of a declared but unvalidated target with a stable code", () => {
    const loaded = loadProjectAdapterPackageFilesV2(candidateFiles(), {
      selectedLaunchTargetId: "main",
      expectedMainScene: "res://main.tscn",
      requireEmptyLaunchParameters: true,
    });
    const receiptId = asAdapterConformanceReceiptId("conformance:multi-target");
    const validation: ProjectAdapterLaunchTargetValidationV1 = {
      schemaVersion: 1,
      recordKind: "chronorift-project-adapter-launch-target-validation",
      defaultTargetId: "main",
      selectedTargetId: "main",
      targets: [
        {
          schemaVersion: 1,
          targetId: "main",
          status: "validated",
          conformanceReceiptId: receiptId,
        },
        {
          schemaVersion: 1,
          targetId: "secondary",
          status: "declared_unvalidated",
          conformanceReceiptId: null,
        },
      ],
    };

    const error = (() => {
      try {
        resolveReusableProjectEnvironmentLaunchTargetV2(
          loaded,
          validation,
          "secondary",
          receiptId,
        );
      } catch (caught) {
        return caught;
      }
      return undefined;
    })();
    expect(error).toMatchObject({ code: "target_not_validated" });
  });
});
