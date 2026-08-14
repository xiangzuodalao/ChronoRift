import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PROJECT_CAPABILITY_MODULE_NAMES_V1,
  PROJECT_READY_REQUIRED_MODULE_NAMES_V1,
  asAdapterId,
  asProjectAdapterCandidateId,
  asProjectEnvironmentId,
  asProjectEnvironmentOperationId,
  asProjectEnvironmentTaskId,
  asProjectInitializationAttemptId,
  asProjectToolchainReceiptId,
  asSha256DigestV1,
  asSourceId,
} from "@chronorift/domain";
import {
  PROJECT_ADAPTER_MANIFEST_KIND_V1,
  PROJECT_ADAPTER_SCHEMA_DIALECT_V1,
  PROJECT_ADAPTER_SDK_ID_V1,
  canonicalProjectAdapterValueV1,
} from "@chronorift/godot-protocol";
import {
  contentHash,
  projectEnvironmentPackageContentDigestV1,
} from "@chronorift/json-artifacts";

import {
  validateProjectAdapterCandidateV1,
  type ProjectEnvironmentConformanceDriverV1,
  type ProjectEnvironmentInstrumentedObservationV1,
  type ProjectEnvironmentProcessObservationV1,
} from "./project-environment-conformance.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const sha256 = async (bytes: Uint8Array): Promise<string> => {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(bytes).digest("hex");
};

const createCandidate = async (options?: {
  readonly optionalClaim?: {
    readonly module: "alignment" | "input_control";
    readonly status: "implemented" | "degraded";
  };
  readonly checkpointDisposition?: "captured" | "uncontrolled";
  readonly placeholderSemantics?: boolean;
}) => {
  const root = await mkdtemp(join(tmpdir(), "chronorift-pe-conformance-"));
  roots.push(root);
  await Promise.all([mkdir(join(root, "src")), mkdir(join(root, "schemas"))]);
  const schemas = {
    launch: {
      schemaVersion: 1,
      dialect: PROJECT_ADAPTER_SCHEMA_DIALECT_V1,
      schemaId: "launch.params",
      root: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
    },
    entity: {
      schemaVersion: 1,
      dialect: PROJECT_ADAPTER_SCHEMA_DIALECT_V1,
      schemaId: options?.placeholderSemantics
        ? "entity.scene-root"
        : "entity.main",
      root: {
        type: "object",
        properties: { name: { type: "string", maxLength: 128 } },
        required: ["name"],
        additionalProperties: false,
      },
    },
    state: {
      schemaVersion: 1,
      dialect: PROJECT_ADAPTER_SCHEMA_DIALECT_V1,
      schemaId: options?.placeholderSemantics ? "state.project" : "state.world",
      root: {
        type: "object",
        properties: { active: { type: "boolean" } },
        required: ["active"],
        additionalProperties: false,
      },
    },
  } as const;
  const schemaFiles = await Promise.all(
    Object.entries(schemas).map(async ([name, schema]) => {
      const path = `schemas/${name}.json`;
      const bytes = Buffer.from(JSON.stringify(schema), "utf8");
      await writeFile(join(root, path), bytes);
      return { schemaId: schema.schemaId, path, sha256: await sha256(bytes) };
    }),
  );
  await writeFile(
    join(root, "src", "adapter.gd"),
    "extends ChronoRiftProjectAdapterV1\nfunc create_modules(): return {}\n",
  );
  const modules = {
    schemaVersion: 1,
    modules: PROJECT_CAPABILITY_MODULE_NAMES_V1.map((module) => {
      const required = PROJECT_READY_REQUIRED_MODULE_NAMES_V1.includes(
        module as (typeof PROJECT_READY_REQUIRED_MODULE_NAMES_V1)[number],
      );
      const optionalStatus =
        options?.optionalClaim?.module === module
          ? options.optionalClaim.status
          : "unsupported";
      const status = required ? "implemented" : optionalStatus;
      return {
        schemaVersion: 1,
        module,
        status,
        protocolVersion:
          status === "implemented" || status === "degraded"
            ? "project-module:v1"
            : null,
        limitations:
          status === "implemented"
            ? []
            : status === "degraded"
              ? ["claimed without PE-A conformance"]
              : ["not declared"],
      };
    }),
  };
  const manifest = {
    schemaVersion: 1,
    manifestKind: PROJECT_ADAPTER_MANIFEST_KIND_V1,
    adapterId: "adapter.pe-a",
    adapterVersion: "1.0.0",
    sdk: { id: PROJECT_ADAPTER_SDK_ID_V1, version: 1 },
    engine: { id: "godot", versionRequirement: "4.7.x", language: "gdscript" },
    entryScript: "src/adapter.gd",
    schemas: schemaFiles.map((schema) => ({ schemaVersion: 1, ...schema })),
    launchTargets: [
      {
        schemaVersion: 1,
        targetId: "main",
        scene: "res://main.tscn",
        default: true,
        parametersSchemaId: "launch.params",
        renderer: "headless",
        requiredModules: [...PROJECT_READY_REQUIRED_MODULE_NAMES_V1],
      },
    ],
    modules,
    entityTypes: [
      {
        schemaVersion: 1,
        entityTypeId: options?.placeholderSemantics
          ? "scene-root"
          : "entity.main",
        schemaId: options?.placeholderSemantics
          ? "entity.scene-root"
          : "entity.main",
        identityStrategy: "authored",
      },
    ],
    stateDomains: [
      {
        schemaVersion: 1,
        stateDomainId: options?.placeholderSemantics
          ? "project"
          : "state.world",
        schemaId: options?.placeholderSemantics
          ? "state.project"
          : "state.world",
        checkpointDisposition: options?.checkpointDisposition ?? "uncontrolled",
      },
    ],
    eventTypes: [],
    smoke: {
      schemaVersion: 1,
      targetId: "main",
      timeoutMs: 10_000,
      minimumStateSamples: 1,
      minimumEntityLifecycleRecords: 1,
      requiredStateDomainIds: [
        options?.placeholderSemantics ? "project" : "state.world",
      ],
      requiredCustomEventTypeIds: [],
    },
  };
  await writeFile(join(root, "manifest.json"), JSON.stringify(manifest));
  const { loadProjectAdapterPackageV1 } =
    await import("@chronorift/godot-adapter");
  const loaded = await loadProjectAdapterPackageV1(root);
  const candidateDigest = asSha256DigestV1(
    contentHash({
      schemaVersion: 1,
      files: loaded.files
        .map((file) => ({
          path: file.path,
          byteLength: file.bytes,
          sha256: file.sha256,
        }))
        .sort((left, right) => left.path.localeCompare(right.path)),
    }),
  );
  const candidateFiles = await Promise.all(
    loaded.files.map(async (file) => ({
      path: file.path,
      bytes: Uint8Array.from(await readFile(join(root, file.path))),
    })),
  );
  return { root, loaded, candidateDigest, candidateFiles };
};

const processObservation = (): ProjectEnvironmentProcessObservationV1 => ({
  launched: true,
  importSucceeded: true,
  stableWindowObserved: true,
  exitCode: 0,
  signal: null,
  timedOut: false,
  stdoutSha256: asSha256DigestV1("1".repeat(64)),
  stderrSha256: asSha256DigestV1("2".repeat(64)),
  stdoutTruncated: false,
  stderrTruncated: false,
  elapsedMonotonicMs: 100,
  resourceUsage: {
    cpuUsageUsec: 10,
    memoryPeakBytes: 1_024,
    pidsPeak: 2,
  },
  sourceIdentityReverified: true,
  processTreeTerminated: true,
  isolationGroupEmpty: true,
  scopeRemoved: true,
  scratchRemoved: true,
  storageReconciled: true,
});

const instrumentedObservation =
  (): ProjectEnvironmentInstrumentedObservationV1 => ({
    ...processObservation(),
    bridgeHandshakeCount: 1,
    entityLifecycleRecords: 1,
    stateSamples: 1,
    queries: 2,
    observedCustomEventTypeIds: [],
    captures: 1,
    stateDomainIds: ["state.world"],
    transportRecords: 4,
    droppedRecords: 0,
    overwrittenRecords: 0,
    semanticCoverage: "declared",
    runtimeFailures: [],
    bridgeExited: true,
  });

const driver = (): ProjectEnvironmentConformanceDriverV1 => ({
  runVanilla: async () => processObservation(),
  runBridgeOnly: async () => processObservation(),
  runInstrumented: async () => instrumentedObservation(),
});

const validationRequest = (
  fixture: Awaited<ReturnType<typeof createCandidate>>,
) => ({
  candidateDirectory: fixture.root,
  candidateFiles: fixture.candidateFiles,
  candidate: {
    schemaVersion: 1 as const,
    taskId: asProjectEnvironmentTaskId("task:pe"),
    attemptId: asProjectInitializationAttemptId("attempt:pe"),
    candidateId: asProjectAdapterCandidateId("candidate:pe"),
    adapterId: asAdapterId("adapter.pe-a"),
    sourceId: asSourceId("source:pe"),
    contentDigest: fixture.candidateDigest,
    fileCount: fixture.loaded.files.length,
    byteLength: fixture.loaded.totalBytes,
    frozenAt: "2026-08-12T00:00:00.000Z",
  },
  adapterId: asAdapterId("adapter.pe-a"),
  environmentId: asProjectEnvironmentId("environment:pe"),
  publicationOperationId: asProjectEnvironmentOperationId("publication:pe"),
  toolchainReceiptId: asProjectToolchainReceiptId("toolchain:pe"),
  expectedMainScene: "res://main.tscn",
  sdkDigest: asSha256DigestV1("3".repeat(64)),
  bridgeDigest: asSha256DigestV1("4".repeat(64)),
  policyProfileDigest: asSha256DigestV1("5".repeat(64)),
});

describe("ProjectAdapter authoritative conformance", () => {
  it("rejects the structural reference placeholder before running smoke", async () => {
    const fixture = await createCandidate({ placeholderSemantics: true });
    const runVanilla = vi.fn(async () => processObservation());

    await expect(
      validateProjectAdapterCandidateV1(validationRequest(fixture), {
        runVanilla,
        runBridgeOnly: async () => processObservation(),
        runInstrumented: async () => instrumentedObservation(),
      }),
    ).rejects.toThrow(/structural reference placeholder/u);
    expect(runVanilla).not.toHaveBeenCalled();
  });

  it("derives publishable revisions only from a package plus three successful smoke stages", async () => {
    const fixture = await createCandidate();
    const order: string[] = [];
    const orderedDriver: ProjectEnvironmentConformanceDriverV1 = {
      runVanilla: async () => {
        order.push("vanilla");
        return processObservation();
      },
      runBridgeOnly: async () => {
        order.push("bridge-only");
        return processObservation();
      },
      runInstrumented: async () => {
        order.push("instrumented");
        return instrumentedObservation();
      },
    };
    const timestamps = ["2026-08-12T00:00:01.000Z", "2026-08-12T00:00:10.000Z"];
    const result = await validateProjectAdapterCandidateV1(
      validationRequest(fixture),
      orderedDriver,
      {
        now: () => {
          order.push("clock");
          return timestamps.shift() ?? "2026-08-12T00:00:10.000Z";
        },
      },
    );

    expect(result.conformance.outcome).toBe("conformed");
    expect(result.environmentRevision.adapterRevisionId).toBe(
      result.adapterRevision.adapterRevisionId,
    );
    expect(result.conformance).toMatchObject({
      startedAt: "2026-08-12T00:00:01.000Z",
      completedAt: "2026-08-12T00:00:10.000Z",
    });
    expect(result.observerEffect).toMatchObject({
      status: "measured",
      observedAt: "2026-08-12T00:00:10.000Z",
    });
    expect(result.observerEffect.unknowns).toHaveLength(3);
    expect(order).toEqual([
      "clock",
      "vanilla",
      "bridge-only",
      "instrumented",
      "clock",
    ]);
    expect(projectEnvironmentPackageContentDigestV1(result.revisionFiles)).toBe(
      result.environmentRevision.contentDigest,
    );
  });

  it.each([
    ["entity lifecycle", { entityLifecycleRecords: 0 }],
    ["state sample", { stateSamples: 0 }],
    ["query", { queries: 0 }],
    ["transport loss", { droppedRecords: 1 }],
    ["cleanup", { isolationGroupEmpty: false }],
  ])("rejects missing %s evidence", async (_label, changed) => {
    const fixture = await createCandidate();
    const rejectedDriver: ProjectEnvironmentConformanceDriverV1 = {
      ...driver(),
      runInstrumented: async () => ({
        ...instrumentedObservation(),
        ...changed,
      }),
    };
    await expect(
      validateProjectAdapterCandidateV1(
        validationRequest(fixture),
        rejectedDriver,
      ),
    ).rejects.toThrow(/conformance rejected|outcome/u);
  });

  it.each(["implemented", "degraded"] as const)(
    "rejects an unexercised optional module declared %s",
    async (status) => {
      const fixture = await createCandidate({
        optionalClaim: { module: "alignment", status },
      });
      await expect(
        validateProjectAdapterCandidateV1(validationRequest(fixture), driver()),
      ).rejects.toThrow(
        new RegExp(
          `optional module alignment claims ${status}.*does not exercise`,
          "u",
        ),
      );
    },
  );

  it("rejects captured checkpoint state outside the fixture-only characterization path", async () => {
    const fixture = await createCandidate({
      checkpointDisposition: "captured",
    });

    await expect(
      validateProjectAdapterCandidateV1(validationRequest(fixture), driver()),
    ).rejects.toThrow(/claims captured checkpoint state.*does not exercise/u);
  });

  it("records stderr, lifecycle, and resource differences against their own digests", async () => {
    const fixture = await createCandidate();
    const vanilla = processObservation();
    const bridgeOnly = {
      ...processObservation(),
      stderrSha256: asSha256DigestV1("6".repeat(64)),
      elapsedMonotonicMs: 120,
      resourceUsage: {
        cpuUsageUsec: 20,
        memoryPeakBytes: 2_048,
        pidsPeak: 3,
      },
    };
    const instrumented = {
      ...instrumentedObservation(),
      stderrSha256: asSha256DigestV1("7".repeat(64)),
      elapsedMonotonicMs: 140,
      resourceUsage: {
        cpuUsageUsec: 30,
        memoryPeakBytes: 3_072,
        pidsPeak: 4,
      },
    };
    const result = await validateProjectAdapterCandidateV1(
      validationRequest(fixture),
      {
        runVanilla: async () => vanilla,
        runBridgeOnly: async () => bridgeOnly,
        runInstrumented: async () => instrumented,
      },
    );

    expect(result.observerEffect.status).toBe("measured");
    expect(result.observerEffect.differences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          comparison: "vanilla_to_bridge",
          dimension: "process_stderr",
          baselineDigest: vanilla.stderrSha256,
          instrumentedDigest: bridgeOnly.stderrSha256,
        }),
        expect.objectContaining({
          comparison: "bridge_to_instrumented",
          dimension: "process_stderr",
          baselineDigest: bridgeOnly.stderrSha256,
          instrumentedDigest: instrumented.stderrSha256,
        }),
        expect.objectContaining({
          comparison: "vanilla_to_bridge",
          dimension: "process_lifecycle",
        }),
        expect.objectContaining({
          comparison: "bridge_to_instrumented",
          dimension: "resource_usage",
        }),
      ]),
    );
    expect(
      result.observerEffect.differences.filter(
        (difference) => difference.dimension === "process_stdout",
      ),
    ).toEqual([]);
    expect(
      result.observerEffect.differences.find(
        (difference) =>
          difference.comparison === "bridge_to_instrumented" &&
          difference.dimension === "resource_usage",
      )?.description,
    ).toContain('"cpuUsageUsec":20');
  });

  it("marks observer-effect evidence incomplete when output or resource facts are unavailable", async () => {
    const fixture = await createCandidate();
    const result = await validateProjectAdapterCandidateV1(
      validationRequest(fixture),
      {
        ...driver(),
        runBridgeOnly: async () => ({
          ...processObservation(),
          stdoutTruncated: true,
        }),
        runInstrumented: async () => ({
          ...instrumentedObservation(),
          resourceUsage: {
            ...instrumentedObservation().resourceUsage,
            memoryPeakBytes: null,
            pidsPeak: null,
          },
        }),
      },
    );

    expect(result.observerEffect.status).toBe("incomplete");
    expect(result.observerEffect.alignmentGaps).toEqual(
      expect.arrayContaining([
        "bridge-only stdout capture was truncated.",
        "instrumented memory-peak usage was unavailable.",
        "instrumented process-peak usage was unavailable.",
      ]),
    );
    expect(result.observerEffect.unknowns).toContain(
      "Observer-effect comparison is incomplete where output or resource measurements were unavailable.",
    );
    expect(
      result.observerEffect.differences.some(
        (difference) => difference.dimension === "process_stdout",
      ),
    ).toBe(false);
  });

  it("keeps canonical adapter values JSON deterministic", () => {
    expect(canonicalProjectAdapterValueV1({ b: 2, a: 1 })).toBe(
      '{"a":1,"b":2}',
    );
  });
});
