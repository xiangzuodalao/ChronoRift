import { createHash } from "node:crypto";

import type { ProjectEnvironmentGameQueryOutputV1 } from "@chronorift/agent-protocol";
import {
  PROJECT_CAPABILITY_MODULE_NAMES_V1,
  ProjectAdapterRevisionV1Schema,
  ProjectEnvironmentPinnedCaptureV1Schema,
  ProjectEnvironmentRuntimeObservationReceiptV1Schema,
  VNextBuildV1Schema,
  asProjectToolchainReceiptId,
  asSha256DigestV1,
  type JsonValue,
  type Sha256DigestV1,
} from "@chronorift/domain";
import { GodotProjectEnvironmentObservationRecordV1Schema } from "@chronorift/godot-protocol";
import {
  canonicalJson,
  projectEnvironmentPackageContentDigestV1,
} from "@chronorift/json-artifacts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PreparedM6ExactGodotBuildV1 } from "./m6-exact-godot-build.js";
import type { M7R3NoAgentPublicObservationRequestV1 } from "./m7-r3-case-preflight-runner.js";
import {
  createM7R3NoAgentProjectEnvironmentPreflightPortV1,
  prepareM7R3NoAgentProjectEnvironmentPreflightPortV1,
  type M7R3PreparedNoAgentProjectEnvironmentSubjectV1,
  type PrepareM7R3NoAgentProjectEnvironmentSubjectV1Input,
} from "./m7-r3-project-environment-preflight.js";
import type { VerifiedProjectEnvironmentSourceV1 } from "./source-preflight.js";

const sha = (value: string): Sha256DigestV1 =>
  asSha256DigestV1(createHash("sha256").update(value).digest("hex"));

const capabilitySet = {
  schemaVersion: 1 as const,
  modules: PROJECT_CAPABILITY_MODULE_NAMES_V1.map((module) => ({
    schemaVersion: 1 as const,
    module,
    status: "implemented" as const,
    protocolVersion: "project-environment-v1",
    limitations: [],
  })),
};

const adapterRevision = ProjectAdapterRevisionV1Schema.parse({
  schemaVersion: 1,
  adapterRevisionId: "adapter-revision:r3-preflight:v1",
  adapterId: "adapter:r3-preflight",
  sourceId: "source:r3-pristine",
  packageDigest: sha("adapter-package"),
  manifestDigest: sha("adapter-manifest"),
  implementationDigest: sha("adapter-implementation"),
  payloadSchemaDigest: sha("adapter-payload-schema"),
  sdkDigest: sha("adapter-sdk"),
  bridgeDigest: sha("adapter-bridge"),
  capabilitySet,
  conformanceReceiptId: "adapter-conformance:r3-preflight:v1",
  contentByteLength: 1_024,
  contentFileCount: 4,
});

const cleanup = {
  schemaVersion: 1 as const,
  processTreeTerminated: true,
  runtimeExited: true,
  bridgeExited: true,
  isolationGroupEmpty: true,
  scopeRemoved: true,
  scratchRemoved: true,
  storageReconciled: true,
};

const taskCleanup = {
  processGroupTerminated: true,
  cgroupPopulated: false,
  termSent: false,
  killSent: false,
  scopeRemoved: true,
  storageReconciled: true,
};

const coverage = [
  {
    schemaVersion: 1 as const,
    channelId: "project_adapter_observations",
    status: "complete" as const,
    observedRecords: 3,
    droppedRecords: 0,
    overwrittenRecords: 0,
    limitations: [],
  },
];

const clock = {
  schemaVersion: 1 as const,
  processFrame: 3,
  physicsTick: 3,
  simulationTimeUs: 50_001,
  renderFrame: null,
  hostMonotonicUs: 100_000,
};

const exactBuild = (
  subject: "pristine" | "mutant",
): PreparedM6ExactGodotBuildV1 => {
  const sourceHash = sha(`${subject}-source`);
  const taskId = `task:r3-preflight:${subject}`;
  return {
    build: VNextBuildV1Schema.parse({
      schemaVersion: 1,
      taskId,
      workspaceId: `workspace:r3-preflight:${subject}`,
      sourceId: `source:${sourceHash}`,
      buildId: `build:r3-preflight:${subject}`,
      sourceHash,
      workspaceDiffHash: sha(`${subject}-diff`),
      buildConfigurationHash: sha(`${subject}-config`),
      outputHash: sha(`${subject}-output`),
      createdAt: "2026-08-16T02:00:00.000Z",
    }),
    configuredMainScene: "res://scenes/main.tscn",
    projectHash: sha(`${subject}-project`),
    adapterRevision,
    toolchainReceiptId: asProjectToolchainReceiptId(
      `toolchain-receipt:r3:${subject}`,
    ),
    toolchainArtifactDigest: sha("toolchain"),
    runtimeIdentity: {
      schemaVersion: 1,
      managedRuntimeId: "managed-runtime:r3:shared",
      engineVersion: "4.7.1",
      runtimeArtifactDigest: sha("shared-runtime"),
      overlayDigest: sha("shared-overlay"),
    },
    policyProfileDigest: sha("shared-policy"),
    fileCount: 3,
    byteLength: 1_000,
  };
};

interface SubjectOptions {
  readonly cleanupProven?: boolean;
  readonly headroomFailure?: boolean;
  readonly availableBytes?: number | undefined;
  readonly availableInodes?: number | undefined;
  readonly failAtTool?: "game_query" | undefined;
  readonly retainSecurityDenial?: boolean;
  readonly stateSampleSequencesByQuery?: readonly (readonly number[])[];
}

const preparedSubject = (
  subject: "pristine" | "mutant",
  events: string[],
  options: SubjectOptions = {},
): M7R3PreparedNoAgentProjectEnvironmentSubjectV1 => {
  const prepared = exactBuild(subject);
  const environmentRevisionId = `environment-revision:r3:${subject}`;
  let runtimeCreated = false;
  return {
    subject,
    taskId: prepared.build.taskId,
    workspaceId: prepared.build.workspaceId,
    sourceSelectedTreeSha256: prepared.build.sourceHash,
    exactBuild: prepared,
    adapterRevision,
    adapterPackageIdentity: {
      schemaVersion: 1,
      packageSha256: adapterRevision.packageDigest,
      manifestSha256: adapterRevision.manifestDigest,
      implementationSha256: adapterRevision.implementationDigest,
      observationSchemaSha256: adapterRevision.payloadSchemaDigest,
      adapterId: adapterRevision.adapterId,
      contentByteLength: adapterRevision.contentByteLength,
      contentFileCount: adapterRevision.contentFileCount,
    },
    environmentRevisionId,
    launchTargetId: "main",
    assertTaskStorageHeadroom: async () => {
      events.push(`${subject}:headroom`);
      if (options.headroomFailure === true) {
        throw new Error("task storage headroom exhausted");
      }
      return {
        schemaVersion: 1,
        availableBytes: options.availableBytes ?? 256 * 1024 * 1024,
        availableInodes: options.availableInodes ?? 16_384,
        requiredAvailableBytes: 256 * 1024 * 1024,
        requiredAvailableInodes: 16_384,
      };
    },
    createRuntimeOnce: (persistence) => {
      if (runtimeCreated) throw new Error("runtime repeated");
      runtimeCreated = true;
      events.push(`${subject}:runtime-created`);
      let runtimeId: string | null = null;
      let executionId: string | null = null;
      let stateQueryCount = 0;
      let stateRowCount = 0;
      const observationRecord = (recordSequence: number): JsonValue => ({
        schemaVersion: 1,
        recordSequence,
        clock: {
          processFrame: recordSequence,
          physicsTick: recordSequence,
          simulationTimeUs: recordSequence * 16_667,
          renderFrame: null,
        },
        kind: "state_sample",
        payload: {
          stateDomainId: "patrol.motion",
          value: { agents: [{ entity_id: "enemy:1" }] },
          semanticCoverage: "declared",
        },
      });
      const observationRecords: JsonValue[] = [observationRecord(1)];
      return {
        activeFingerprint: () => ({
          schemaVersion: 1,
          protocolProfile: "chronorift-godot-project-environment-v1",
          protocolVersion: 1,
          engine: "godot",
          engineVersion: "4.7.1",
          engineBuildHash: "test",
          platform: "linux",
          renderer: "headless",
          displayServer: "headless",
          audioDriver: "Dummy",
          physicsTicksPerSecond: 60,
          configuredMainScene: prepared.configuredMainScene,
          modules: capabilitySet,
          identity: {
            taskId: prepared.build.taskId,
            sourceClosureId: prepared.build.sourceId,
            environmentRevisionId,
            adapterRevisionId: adapterRevision.adapterRevisionId,
            buildId: prepared.build.buildId,
            runtimeId: runtimeId!,
            executionId: executionId!,
            instrumentationMode: "instrumented",
            candidateSourceHash: prepared.build.sourceHash,
            adapterManifestSha256: adapterRevision.manifestDigest,
            sdkSha256: adapterRevision.sdkDigest,
            bridgeSha256: adapterRevision.bridgeDigest,
            toolchainSha256: sha("toolchain"),
          },
        }),
        invoke: async (request) => {
          events.push(`${subject}:${request.toolName}`);
          if (
            options.failAtTool === request.toolName &&
            request.toolName === "game_query"
          ) {
            throw new Error("query failed");
          }
          const success = (output: unknown) => ({
            schemaVersion: 1 as const,
            toolCallId: request.toolCallId,
            outcome: "success" as const,
            output,
          });
          switch (request.toolName) {
            case "game_launch": {
              runtimeId = `runtime:r3:${subject}`;
              executionId = `execution:r3:${subject}`;
              return success({
                schemaVersion: 1,
                taskId: prepared.build.taskId,
                runtimeId,
                executionId,
                buildId: prepared.build.buildId,
                environmentRevisionId,
                adapterRevisionId: adapterRevision.adapterRevisionId,
                launchReceiptId: `launch-receipt:r3:${subject}`,
                requested: { launchTargetId: "main", parameters: {} },
                realized: {
                  launchTargetId: "main",
                  parameters: {},
                  renderer: "headless",
                  clock,
                },
                status: "running",
                modules: capabilitySet.modules,
                limitations: [],
              });
            }
            case "game_query": {
              const query = request.input as { readonly select: string };
              const stateSequences =
                query.select === "state"
                  ? (options.stateSampleSequencesByQuery?.[stateQueryCount] ?? [
                      1, 2, 3,
                    ])
                  : [1];
              if (query.select === "state") {
                stateQueryCount += 1;
                stateRowCount += stateSequences.length;
              }
              return success({
                schemaVersion: 1,
                taskId: prepared.build.taskId,
                executionId,
                rows: stateSequences.map((recordSequence) => ({
                  schemaVersion: 1,
                  rowId: `query-row:r3:${subject}:${query.select}:${recordSequence}`,
                  kind: query.select === "entities" ? "entity" : "state",
                  clock,
                  value: observationRecord(recordSequence),
                })),
                nextCursor: null,
                coverage,
                loss: [],
                limitations: [],
              });
            }
            case "game_capture_pin": {
              const captureWindowId = `capture-window:r3:${subject}`;
              const bytes = Buffer.from(
                `${canonicalJson(observationRecords)}\n`,
                "utf8",
              );
              const manifest = ProjectEnvironmentPinnedCaptureV1Schema.parse({
                schemaVersion: 1,
                captureWindowId,
                taskId: prepared.build.taskId,
                runtimeId: runtimeId!,
                executionId: executionId!,
                buildId: prepared.build.buildId,
                environmentRevisionId,
                adapterRevisionId: adapterRevision.adapterRevisionId,
                recordCount: observationRecords.length,
                contentDigest: projectEnvironmentPackageContentDigestV1([
                  { path: "records.json", bytes },
                ]),
                anchorClock: clock,
                coverage,
                loss: [],
                createdAt: "2026-08-16T02:01:00.000Z",
              });
              await persistence.persistPinnedCapture(
                manifest,
                observationRecords,
              );
              return success({
                schemaVersion: 1,
                taskId: prepared.build.taskId,
                runtimeId,
                captureWindowId,
                anchor: {
                  requested: { kind: "now" },
                  realized: clock,
                  quantized: true,
                },
                coverage,
                loss: [],
                limitations: [],
              });
            }
            case "game_stop": {
              const receipt =
                ProjectEnvironmentRuntimeObservationReceiptV1Schema.parse({
                  schemaVersion: 1,
                  receiptId: `runtime-observation:r3:${subject}`,
                  taskId: prepared.build.taskId,
                  runtimeId: runtimeId!,
                  executionId: executionId!,
                  buildId: prepared.build.buildId,
                  environmentRevisionId,
                  adapterRevisionId: adapterRevision.adapterRevisionId,
                  launchTargetId: "main",
                  instrumentationMode: "instrumented",
                  status: "stopped",
                  bridgeHandshakeCount: 1,
                  clock,
                  queryObservations: {
                    schemaVersion: 1,
                    entityQueryCount: 1,
                    entityRows: 1,
                    stateQueryCount,
                    stateRows: stateRowCount,
                  },
                  captureCount: 1,
                  captureWindowIds: [`capture-window:r3:${subject}`],
                  coverage,
                  loss: [],
                  cleanup,
                  outcome: "succeeded",
                  failures: [],
                  startedAt: "2026-08-16T02:00:00.000Z",
                  observedAt: "2026-08-16T02:01:00.000Z",
                  completedAt: "2026-08-16T02:02:00.000Z",
                });
              await persistence.persistRuntimeObservation(receipt);
              return success({
                schemaVersion: 1,
                taskId: prepared.build.taskId,
                runtimeId,
                executionId,
                status: "stopped",
                cleanup,
                coverage,
                loss: [],
                limitations: [],
              });
            }
            default:
              throw new Error(`unexpected ${request.toolName}`);
          }
        },
        close: async () => {
          events.push(`${subject}:runtime-close`);
        },
      };
    },
    cleanupTask: async () => {
      events.push(`${subject}:task-cleanup`);
      return options.cleanupProven === false
        ? {
            ...taskCleanup,
            processGroupTerminated: false,
            cgroupPopulated: true,
            scopeRemoved: false,
          }
        : taskCleanup;
    },
    readSecurityEvents: () =>
      options.retainSecurityDenial === true
        ? [
            {
              schemaVersion: 1,
              eventId: `security:r3:${subject}`,
              taskId: prepared.build.taskId,
              operationId: `operation:r3:${subject}`,
              decision: "denied",
              code: "capability_denied",
              message: "sandbox operation denied",
              occurredAt: "2026-08-16T02:01:30.000Z",
              target: "sandbox-request",
              sideEffectStarted: false,
            },
          ]
        : [],
  };
};

const request = (
  ordinal: 1 | 2,
  subject: "pristine" | "mutant",
  prepared: M7R3PreparedNoAgentProjectEnvironmentSubjectV1,
): M7R3NoAgentPublicObservationRequestV1 => ({
  schemaVersion: 1,
  ordinal,
  caseId: `m7-r3-case:${sha(`case-${ordinal}`).slice(0, 24)}`,
  subject,
  buildRole:
    subject === "pristine" ? "pristine_control" : "assignment_baseline",
  expectedSource: {
    sourceId: prepared.exactBuild.build.sourceId,
    sourceSha256: prepared.exactBuild.build.sourceHash,
    selectedTreeSha256: prepared.sourceSelectedTreeSha256,
    buildId: subject === "pristine" ? null : prepared.exactBuild.build.buildId,
  },
  configuredMainScene: prepared.exactBuild.configuredMainScene,
});

const completeObservationWindow = async <Result>(
  active: Promise<Result>,
): Promise<Result> => {
  await vi.advanceTimersByTimeAsync(5_000);
  return active;
};

describe("M7 R3 concrete no-Agent Project Environment preflight", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("gates shared evaluator and public observation work on current Task-storage headroom", async () => {
    const events: string[] = [];
    const pristine = preparedSubject("pristine", events, {
      headroomFailure: true,
    });
    const mutant = preparedSubject("mutant", events);
    const prepared = createM7R3NoAgentProjectEnvironmentPreflightPortV1({
      ordinal: 1,
      pristine,
      mutant,
    });

    await expect(prepared.assertTaskStorageHeadroom()).rejects.toThrow(
      /headroom exhausted/u,
    );
    await expect(
      prepared.projectEnvironment.observeConfiguredMainScene(
        request(1, "pristine", pristine),
      ),
    ).rejects.toThrow(/headroom exhausted/u);
    expect(events).not.toContain("pristine:runtime-created");
    expect(events).toContain("pristine:task-cleanup");
    await expect(prepared.cleanup()).resolves.toMatchObject({
      cleanupProven: true,
    });
  });

  it("returns the conservative shared Task-storage headroom observation", async () => {
    const events: string[] = [];
    const pristine = preparedSubject("pristine", events, {
      availableBytes: 300_000_000,
      availableInodes: 20_000,
    });
    const mutant = preparedSubject("mutant", events, {
      availableBytes: 400_000_000,
      availableInodes: 18_000,
    });
    const prepared = createM7R3NoAgentProjectEnvironmentPreflightPortV1({
      ordinal: 1,
      pristine,
      mutant,
    });

    await expect(prepared.assertTaskStorageHeadroom()).resolves.toEqual({
      schemaVersion: 1,
      availableBytes: 300_000_000,
      availableInodes: 18_000,
      requiredAvailableBytes: 268_435_456,
      requiredAvailableInodes: 16_384,
    });
    expect(events.filter((event) => event.endsWith(":headroom"))).toEqual([
      "pristine:headroom",
      "mutant:headroom",
    ]);
    await expect(prepared.cleanup()).resolves.toMatchObject({
      cleanupProven: true,
    });
  });

  it("runs the same six-query five-second state window when the third frame arrives later", async () => {
    const events: string[] = [];
    const delayedThirdFrame = {
      stateSampleSequencesByQuery: [
        [1],
        [1],
        [1, 2],
        [1, 2, 3],
        [1, 2, 3],
        [1, 2, 3],
      ],
    } as const;
    const pristine = preparedSubject("pristine", events, delayedThirdFrame);
    const mutant = preparedSubject("mutant", events);
    const prepared = createM7R3NoAgentProjectEnvironmentPreflightPortV1({
      ordinal: 1,
      pristine,
      mutant,
    });

    const active = prepared.projectEnvironment.observeConfiguredMainScene(
      request(1, "pristine", pristine),
    );
    await vi.advanceTimersByTimeAsync(4_999);
    expect(
      events.filter((event) => event === "pristine:game_query"),
    ).toHaveLength(6);
    expect(events).not.toContain("pristine:game_capture_pin");
    await vi.advanceTimersByTimeAsync(1);
    const observation = await active;
    const observedSequences = new Set(
      observation.stateQueries.flatMap((query) => {
        const output = query.output as ProjectEnvironmentGameQueryOutputV1;
        return output.rows.flatMap((row) => {
          const record = GodotProjectEnvironmentObservationRecordV1Schema.parse(
            row.value,
          );
          return record.kind === "state_sample" ? [record.recordSequence] : [];
        });
      }),
    );

    expect(observation.stateQueries).toHaveLength(6);
    expect([...observedSequences].sort((left, right) => left - right)).toEqual([
      1, 2, 3,
    ]);
    await expect(prepared.cleanup()).resolves.toMatchObject({
      cleanupProven: true,
    });
  });

  it("fails closed after the full window when state frames never advance", async () => {
    const events: string[] = [];
    const oneFrameOnly = {
      stateSampleSequencesByQuery: Array.from(
        { length: 6 },
        () => [1] as const,
      ),
    } as const;
    const pristine = preparedSubject("pristine", events, oneFrameOnly);
    const mutant = preparedSubject("mutant", events);
    const prepared = createM7R3NoAgentProjectEnvironmentPreflightPortV1({
      ordinal: 1,
      pristine,
      mutant,
    });

    const active = prepared.projectEnvironment.observeConfiguredMainScene(
      request(1, "pristine", pristine),
    );
    const rejected = expect(active).rejects.toThrow(
      /fewer than 3 distinct state samples/iu,
    );
    await vi.advanceTimersByTimeAsync(5_000);
    await rejected;

    expect(
      events.filter((event) => event === "pristine:game_query"),
    ).toHaveLength(7);
    expect(events).not.toContain("pristine:game_capture_pin");
    expect(events).not.toContain("pristine:game_stop");
    expect(events).toContain("pristine:runtime-close");
    expect(events).toContain("pristine:task-cleanup");
    await expect(prepared.cleanup()).resolves.toMatchObject({
      cleanupProven: true,
    });
  });

  it("uses distinct subjects in pristine→mutant order and retains exact launch/query/pin/stop evidence", async () => {
    const events: string[] = [];
    const pristine = preparedSubject("pristine", events);
    const mutant = preparedSubject("mutant", events);
    const prepared = createM7R3NoAgentProjectEnvironmentPreflightPortV1({
      ordinal: 1,
      pristine,
      mutant,
    });

    const pristineEvidence = await completeObservationWindow(
      prepared.projectEnvironment.observeConfiguredMainScene(
        request(1, "pristine", pristine),
      ),
    );
    const mutantEvidence = await completeObservationWindow(
      prepared.projectEnvironment.observeConfiguredMainScene(
        request(1, "mutant", mutant),
      ),
    );
    const cleanupTruth = await prepared.cleanup();

    expect(pristineEvidence).toMatchObject({
      agentLaunchCount: 0,
      providerInvocationCount: 0,
      piSessionCount: 0,
      captureRecordSeal: {
        sealKind: "host_derived_pinned_capture_records",
        count: 1,
      },
    });
    expect(mutantEvidence).toMatchObject({
      agentLaunchCount: 0,
      providerInvocationCount: 0,
      piSessionCount: 0,
      captureRecordSeal: {
        sealKind: "host_derived_pinned_capture_records",
        count: 1,
      },
    });
    expect(cleanupTruth.cleanupProven).toBe(true);
    expect(cleanupTruth.subjects.pristine.cleanupReceipt).toEqual(taskCleanup);
    expect(cleanupTruth.subjects.mutant.cleanupReceipt).toEqual(taskCleanup);
    expect(cleanupTruth.subjects.pristine.cleanupReceiptSha256).toMatch(
      /^[a-f0-9]{64}$/u,
    );
    await expect(prepared.cleanup()).resolves.toBe(cleanupTruth);
    await expect(
      prepared.projectEnvironment.observeConfiguredMainScene(
        request(1, "pristine", pristine),
      ),
    ).rejects.toThrow(/terminalized/iu);
    expect(events).toEqual([
      "pristine:headroom",
      "pristine:runtime-created",
      "pristine:game_launch",
      "pristine:game_query",
      "pristine:game_query",
      "pristine:game_query",
      "pristine:game_query",
      "pristine:game_query",
      "pristine:game_query",
      "pristine:game_query",
      "pristine:game_capture_pin",
      "pristine:game_stop",
      "pristine:runtime-close",
      "pristine:task-cleanup",
      "mutant:headroom",
      "mutant:runtime-created",
      "mutant:game_launch",
      "mutant:game_query",
      "mutant:game_query",
      "mutant:game_query",
      "mutant:game_query",
      "mutant:game_query",
      "mutant:game_query",
      "mutant:game_query",
      "mutant:game_capture_pin",
      "mutant:game_stop",
      "mutant:runtime-close",
      "mutant:task-cleanup",
    ]);
  });

  it("rejects overlapping observations and terminalizes cleanup around an active one", async () => {
    const events: string[] = [];
    const pristine = preparedSubject("pristine", events);
    const mutant = preparedSubject("mutant", events);
    const prepared = createM7R3NoAgentProjectEnvironmentPreflightPortV1({
      ordinal: 1,
      pristine,
      mutant,
    });

    const active = prepared.projectEnvironment.observeConfiguredMainScene(
      request(1, "pristine", pristine),
    );
    await expect(
      prepared.projectEnvironment.observeConfiguredMainScene(
        request(1, "mutant", mutant),
      ),
    ).rejects.toThrow(/cannot overlap/iu);
    const cleanupDuringObservation = prepared.cleanup();
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(active).resolves.toMatchObject({
      agentLaunchCount: 0,
    });
    await expect(cleanupDuringObservation).resolves.toMatchObject({
      cleanupProven: true,
    });
    await expect(
      prepared.projectEnvironment.observeConfiguredMainScene(
        request(1, "mutant", mutant),
      ),
    ).rejects.toThrow(/terminalized/iu);
    expect(events.filter((entry) => entry.endsWith(":task-cleanup"))).toEqual([
      "pristine:task-cleanup",
      "mutant:task-cleanup",
    ]);
  });

  it("retains structured sandbox denials in both observation and cleanup audit output", async () => {
    const events: string[] = [];
    const pristine = preparedSubject("pristine", events, {
      retainSecurityDenial: true,
    });
    const mutant = preparedSubject("mutant", events);
    const prepared = createM7R3NoAgentProjectEnvironmentPreflightPortV1({
      ordinal: 1,
      pristine,
      mutant,
    });

    const observation = await completeObservationWindow(
      prepared.projectEnvironment.observeConfiguredMainScene(
        request(1, "pristine", pristine),
      ),
    );
    const cleanupTruth = await prepared.cleanup();

    expect(observation.sandboxSecurityEvents).toHaveLength(1);
    expect(observation.sandboxSecurityEvents[0]).toMatchObject({
      decision: "denied",
      code: "capability_denied",
      sideEffectStarted: false,
    });
    expect(cleanupTruth.subjects.pristine.securityEvents).toEqual(
      observation.sandboxSecurityEvents,
    );
    expect(cleanupTruth.subjects.pristine.securityEventsSha256).toBe(
      observation.sandboxSecurityEventsSha256,
    );
  });

  it("rejects crossed source lineage before runtime creation and still cleans both Tasks", async () => {
    const events: string[] = [];
    const pristine = preparedSubject("pristine", events);
    const mutant = preparedSubject("mutant", events);
    const prepared = createM7R3NoAgentProjectEnvironmentPreflightPortV1({
      ordinal: 1,
      pristine,
      mutant,
    });
    const crossed = request(1, "pristine", pristine);

    await expect(
      prepared.projectEnvironment.observeConfiguredMainScene({
        ...crossed,
        expectedSource: {
          ...crossed.expectedSource,
          sourceSha256: sha("crossed-source"),
        },
      }),
    ).rejects.toThrow(/Source, Build, Task, or Adapter lineage/iu);
    await expect(prepared.cleanup()).resolves.toMatchObject({
      cleanupProven: true,
    });
    expect(events).toEqual(["pristine:task-cleanup", "mutant:task-cleanup"]);
  });

  it("rejects a pristine/mutant subject pair that reuses one source identity", () => {
    const events: string[] = [];
    const pristine = preparedSubject("pristine", events);
    const mutant = preparedSubject("mutant", events);
    const crossedBuild = VNextBuildV1Schema.parse({
      ...mutant.exactBuild.build,
      sourceId: pristine.exactBuild.build.sourceId,
      sourceHash: pristine.exactBuild.build.sourceHash,
    });

    expect(() =>
      createM7R3NoAgentProjectEnvironmentPreflightPortV1({
        ordinal: 1,
        pristine,
        mutant: {
          ...mutant,
          sourceSelectedTreeSha256: pristine.sourceSelectedTreeSha256,
          exactBuild: { ...mutant.exactBuild, build: crossedBuild },
        },
      }),
    ).toThrow(/distinct pristine\/mutant Source/iu);
    expect(events).toEqual([]);
  });

  it("rejects a pair whose exact runtime material is confounded", () => {
    const events: string[] = [];
    const pristine = preparedSubject("pristine", events);
    const mutant = preparedSubject("mutant", events);

    expect(() =>
      createM7R3NoAgentProjectEnvironmentPreflightPortV1({
        ordinal: 1,
        pristine,
        mutant: {
          ...mutant,
          exactBuild: {
            ...mutant.exactBuild,
            runtimeIdentity: {
              ...mutant.exactBuild.runtimeIdentity,
              runtimeArtifactDigest: sha("confounded-runtime"),
            },
          },
        },
      }),
    ).toThrow(/exact Adapter, toolchain, runtime, policy/iu);
    expect(events).toEqual([]);
  });

  it("does not admit the mutant runtime after pristine Task cleanup is unproven", async () => {
    const events: string[] = [];
    const pristine = preparedSubject("pristine", events, {
      cleanupProven: false,
    });
    const mutant = preparedSubject("mutant", events);
    const prepared = createM7R3NoAgentProjectEnvironmentPreflightPortV1({
      ordinal: 2,
      pristine,
      mutant,
    });

    const active = prepared.projectEnvironment.observeConfiguredMainScene(
      request(2, "pristine", pristine),
    );
    const rejected = expect(active).rejects.toThrow(/cleanup was not proven/iu);
    await vi.advanceTimersByTimeAsync(5_000);
    await rejected;
    expect(events).not.toContain("mutant:runtime-created");
    const cleanupTruth = await prepared.cleanup();
    expect(cleanupTruth.cleanupProven).toBe(false);
    expect(
      events.filter((entry) => entry === "pristine:task-cleanup"),
    ).toHaveLength(1);
    expect(
      events.filter((entry) => entry === "mutant:task-cleanup"),
    ).toHaveLength(1);
  });

  it("prepares the two dedicated source Tasks sequentially and cleans pristine if mutant preparation fails", async () => {
    const events: string[] = [];
    const pristinePrepared = preparedSubject("pristine", events);
    const pristineSource = source("pristine");
    const mutantSource = source("mutant");
    const prepareSubject = vi.fn(
      async (input: PrepareM7R3NoAgentProjectEnvironmentSubjectV1Input) => {
        events.push(`prepare:${input.subject}`);
        if (input.subject === "mutant")
          throw new Error("mutant preparation failed");
        return pristinePrepared;
      },
    );

    await expect(
      prepareM7R3NoAgentProjectEnvironmentPreflightPortV1(
        {
          ordinal: 1,
          pristineSource,
          mutantSource,
          adapterFiles: [],
          adapterRevision,
        },
        { prepareSubject },
      ),
    ).rejects.toThrow("mutant preparation failed");
    expect(events).toEqual([
      "prepare:pristine",
      "prepare:mutant",
      "pristine:task-cleanup",
    ]);
  });

  it("cleans both prepared Tasks if final subject binding fails", async () => {
    const events: string[] = [];
    const pristine = preparedSubject("pristine", events);
    const mutant = preparedSubject("mutant", events);
    const prepareSubject = vi.fn(
      async (input: PrepareM7R3NoAgentProjectEnvironmentSubjectV1Input) => {
        events.push(`prepare:${input.subject}`);
        return input.subject === "pristine"
          ? pristine
          : {
              ...mutant,
              environmentRevisionId: pristine.environmentRevisionId,
            };
      },
    );

    await expect(
      prepareM7R3NoAgentProjectEnvironmentPreflightPortV1(
        {
          ordinal: 2,
          pristineSource: source("pristine"),
          mutantSource: source("mutant"),
          adapterFiles: [],
          adapterRevision,
        },
        { prepareSubject },
      ),
    ).rejects.toThrow(/distinct pristine\/mutant Source/iu);
    expect(events).toEqual([
      "prepare:pristine",
      "prepare:mutant",
      "mutant:task-cleanup",
      "pristine:task-cleanup",
    ]);
  });
});

const source = (
  subject: "pristine" | "mutant",
): VerifiedProjectEnvironmentSourceV1 => ({
  sourceKind: "project-environment-v1-clean-git",
  repositoryRoot: `/host/${subject}/repository`,
  projectRoot: `/host/${subject}/repository`,
  projectPrefix: "",
  headCommit: subject === "pristine" ? "1".repeat(40) : "2".repeat(40),
  selectedTreeSha256: sha(`${subject}-source`),
  projectSourceIdentity: sha(`${subject}-identity`),
  entries: [],
  mainScene: "res://scenes/main.tscn",
  requestedGodotVersion: "4.7.1",
});
