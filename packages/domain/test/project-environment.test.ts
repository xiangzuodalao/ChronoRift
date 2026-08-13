import { describe, expect, it } from "vitest";

import {
  AdapterConformanceReceiptV1Schema,
  CanonicalAdapterValueV1Schema,
  EnvironmentPublicationReceiptV1Schema,
  PROJECT_CAPABILITY_MODULE_NAMES_V1,
  PROJECT_READY_REQUIRED_MODULE_NAMES_V1,
  ProjectCapabilitySetV1Schema,
  ProjectEnvironmentBuildBindingV1Schema,
  ProjectEnvironmentIdSchema,
  ProjectEnvironmentTaskIdSchema,
  ProjectEnvironmentTurnV1Schema,
  ProjectEnvironmentV1Schema,
  asCanonicalAdapterValueV1,
  foldProjectInitializationAttemptV1,
} from "../src/index.js";

const timestamp = (second: number): string =>
  `2026-08-12T00:00:${String(second).padStart(2, "0")}.000Z`;
const digest = (value: string): string => value.repeat(64);

const ids = {
  taskId: "task:pe-a:test",
  attemptId: "attempt:pe-a:test",
  sessionId: "session:pe-a:test",
  sourceId: "source:pe-a:test",
  candidateId: "candidate:pe-a:test",
  adapterId: "adapter:pe-a:test",
  operationId: "operation:pe-a:test",
  environmentId: "environment:pe-a:test",
  environmentRevisionId: "environment-revision:pe-a:test",
  adapterRevisionId: "adapter-revision:pe-a:test",
  publicationReceiptId: "publication-receipt:pe-a:test",
  bindingEpochId: "binding:pe-a:test",
};

const budget = {
  schemaVersion: 1 as const,
  wallTimeMs: 1_800_000,
  toolCallLimit: 256,
  runtimeTimeMs: 600_000,
  tokenPolicy: "observe_only" as const,
  tokenLimit: null,
  storageByteLimit: 1_073_741_824,
  storageInodeLimit: 131_072,
};

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

const capabilitySet = {
  schemaVersion: 1 as const,
  modules: PROJECT_CAPABILITY_MODULE_NAMES_V1.map((module) => {
    const required = PROJECT_READY_REQUIRED_MODULE_NAMES_V1.includes(
      module as (typeof PROJECT_READY_REQUIRED_MODULE_NAMES_V1)[number],
    );
    return {
      schemaVersion: 1 as const,
      module,
      status: required ? ("implemented" as const) : ("unsupported" as const),
      protocolVersion: required ? "chronorift.project-module:v1" : null,
      limitations: required ? [] : ["not supplied by this adapter"],
    };
  }),
};

const createdEvent = {
  schemaVersion: 1 as const,
  eventId: "attempt-event:pe-a:0",
  attemptId: ids.attemptId,
  taskId: ids.taskId,
  sequence: 0,
  occurredAt: timestamp(0),
  eventKind: "created" as const,
  predecessorAttemptId: null,
  sessionId: ids.sessionId,
  sourceId: ids.sourceId,
  providerId: "provider:test",
  modelId: "model:test",
  thinkingLevel: "high",
  budget,
};

const event = <Kind extends string>(
  sequence: number,
  eventKind: Kind,
  fields: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> => ({
  schemaVersion: 1,
  eventId: `attempt-event:pe-a:${sequence}`,
  attemptId: ids.attemptId,
  taskId: ids.taskId,
  sequence,
  occurredAt: timestamp(sequence),
  eventKind,
  ...fields,
});

const candidate = {
  schemaVersion: 1 as const,
  taskId: ids.taskId,
  attemptId: ids.attemptId,
  candidateId: ids.candidateId,
  adapterId: ids.adapterId,
  sourceId: ids.sourceId,
  contentDigest: digest("a"),
  fileCount: 3,
  byteLength: 1_024,
  frozenAt: timestamp(2),
};

const successfulEvents = [
  createdEvent,
  event(1, "agent_running"),
  event(2, "candidate_frozen", { candidate }),
  event(3, "validating"),
  event(4, "publishing", { operationId: ids.operationId }),
  event(5, "publication_committed", {
    operationId: ids.operationId,
    environmentRevisionId: ids.environmentRevisionId,
    adapterRevisionId: ids.adapterRevisionId,
    publicationReceiptId: ids.publicationReceiptId,
  }),
  event(6, "binding"),
  event(7, "succeeded", { bindingEpochId: ids.bindingEpochId }),
];

describe("Project Environment opaque identities", () => {
  it("rejects path-shaped identities and unknown DTO keys", () => {
    expect(() => ProjectEnvironmentIdSchema.parse("../../environment")).toThrow(
      /opaque|traversal/u,
    );
    expect(() => ProjectEnvironmentTaskIdSchema.parse("/host/task")).toThrow();
    expect(() =>
      ProjectCapabilitySetV1Schema.parse({ ...capabilitySet, extra: true }),
    ).toThrow();
  });
});

describe("canonical adapter values", () => {
  it("accepts bounded maps, arrays, references, and numeric tags", () => {
    const value = asCanonicalAdapterValueV1({
      player: { $type: "entity_ref", entityId: "entity:player" },
      transform: { $type: "transform2d", values: [1, 0, 0, 1, 4, 8] },
      inventory: ["key", null, true, 2.5],
    });
    expect(value).toMatchObject({ inventory: ["key", null, true, 2.5] });
  });

  it.each([
    Number.NaN,
    Number.POSITIVE_INFINITY,
    -0,
    Number.MAX_SAFE_INTEGER + 1,
  ])("rejects non-canonical number %s", (value) => {
    expect(() => CanonicalAdapterValueV1Schema.parse(value)).toThrow(
      /canonical adapter numbers/u,
    );
  });

  it("rejects cycles, unknown tags, and excessive depth", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => CanonicalAdapterValueV1Schema.parse(cyclic)).toThrow(
      /cycles/u,
    );
    expect(() =>
      CanonicalAdapterValueV1Schema.parse({ $type: "object", value: 1 }),
    ).toThrow(/unknown tag/u);
    let deep: unknown = null;
    for (let index = 0; index < 34; index += 1) {
      deep = [deep];
    }
    expect(() => CanonicalAdapterValueV1Schema.parse(deep)).toThrow(/depth/u);
  });
});

describe("Project Environment capability and receipt facts", () => {
  it("requires every capability module exactly once and explicit limitations", () => {
    expect(
      ProjectCapabilitySetV1Schema.parse(capabilitySet).modules,
    ).toHaveLength(12);
    expect(() =>
      ProjectCapabilitySetV1Schema.parse({
        ...capabilitySet,
        modules: capabilitySet.modules.slice(1),
      }),
    ).toThrow(/every module exactly once|too_small/u);
    expect(() =>
      ProjectCapabilitySetV1Schema.parse({
        ...capabilitySet,
        modules: capabilitySet.modules.map((module) =>
          module.module === "snapshot"
            ? { ...module, limitations: [] }
            : module,
        ),
      }),
    ).toThrow(/explicit limitation/u);
  });

  it("accepts conformance with observed state even when snapshot is unsupported", () => {
    const receipt = {
      schemaVersion: 1,
      receiptId: "conformance:pe-a:test",
      taskId: ids.taskId,
      attemptId: ids.attemptId,
      sourceId: ids.sourceId,
      candidateId: ids.candidateId,
      candidateDigest: digest("a"),
      toolchainReceiptId: "toolchain:pe-a:test",
      capabilitySet,
      stateDomains: [
        {
          schemaVersion: 1,
          domainId: "state:world",
          disposition: "uncontrolled",
          schemaDigest: null,
          limitations: ["Snapshot and restore are not implemented."],
        },
      ],
      observations: {
        schemaVersion: 1,
        bridgeHandshakes: 1,
        entityLifecycleRecords: 2,
        stateSamples: 1,
        queries: 1,
        declaredCustomEventTypes: 0,
        observedCustomEventTypes: 0,
        captures: 1,
      },
      coverage: [
        {
          schemaVersion: 1,
          channelId: "capture:runtime",
          status: "complete",
          observedRecords: 4,
          droppedRecords: 0,
          overwrittenRecords: 0,
          limitations: [],
        },
      ],
      cleanup,
      outcome: "conformed",
      failures: [],
      startedAt: timestamp(0),
      completedAt: timestamp(9),
    };
    expect(AdapterConformanceReceiptV1Schema.parse(receipt).outcome).toBe(
      "conformed",
    );
    expect(() =>
      AdapterConformanceReceiptV1Schema.parse({
        ...receipt,
        observations: { ...receipt.observations, stateSamples: 0 },
      }),
    ).toThrow(/conformance outcome/u);
    expect(() =>
      AdapterConformanceReceiptV1Schema.parse({
        ...receipt,
        stateDomains: [],
      }),
    ).toThrow(/conformance outcome/u);
    expect(() =>
      AdapterConformanceReceiptV1Schema.parse({
        ...receipt,
        coverage: [
          {
            ...receipt.coverage[0],
            status: "incomplete",
            limitations: ["Adapter declared partial semantic coverage."],
          },
        ],
      }),
    ).toThrow(/conformance outcome/u);
  });
});

describe("Project initialization durable state", () => {
  it("folds the complete publication and binding lifecycle into a sealed attempt", () => {
    const attempt = foldProjectInitializationAttemptV1(successfulEvents);
    expect(attempt).toMatchObject({
      state: "succeeded",
      candidateId: ids.candidateId,
      environmentRevisionId: ids.environmentRevisionId,
      adapterRevisionId: ids.adapterRevisionId,
      bindingEpochId: ids.bindingEpochId,
      eventCount: 8,
      sealedAt: timestamp(7),
    });
  });

  it("seals a pre-publication failure without inventing a candidate or binding", () => {
    const attempt = foldProjectInitializationAttemptV1([
      createdEvent,
      event(1, "agent_running"),
      event(2, "failed", {
        failureCode: "provider_failure",
        message: "provider stopped the turn",
      }),
    ]);
    expect(attempt).toMatchObject({
      state: "failed",
      candidateId: null,
      environmentRevisionId: null,
      bindingEpochId: null,
      terminalCode: "provider_failure",
    });
  });

  it("rejects gaps, ownership changes, invalid transitions, and terminal mutation", () => {
    expect(() =>
      foldProjectInitializationAttemptV1([
        createdEvent,
        { ...event(2, "agent_running") },
      ]),
    ).toThrow(/contiguous/u);
    expect(() =>
      foldProjectInitializationAttemptV1([
        createdEvent,
        { ...event(1, "agent_running"), taskId: "task:other" },
      ]),
    ).toThrow(/ownership/u);
    expect(() =>
      foldProjectInitializationAttemptV1([
        createdEvent,
        event(1, "validating"),
      ]),
    ).toThrow(/Invalid project initialization transition/u);
    expect(() =>
      foldProjectInitializationAttemptV1([
        createdEvent,
        event(1, "failed", {
          failureCode: "timeout",
          message: "budget ended",
        }),
        event(2, "agent_running"),
      ]),
    ).toThrow(/Invalid project initialization transition/u);
  });

  it("does not turn a committed publication into an ordinary failure", () => {
    expect(() =>
      foldProjectInitializationAttemptV1([
        ...successfulEvents.slice(0, 6),
        event(6, "reconciling", { operationId: ids.operationId }),
        event(7, "failed", {
          failureCode: "task_store_failure",
          message: "binding could not be written",
        }),
      ]),
    ).toThrow(/committed publication/u);
  });
});

describe("Project Environment turn, binding, and publication contracts", () => {
  const environmentReference = {
    schemaVersion: 1 as const,
    environmentId: ids.environmentId,
    environmentRevisionId: ids.environmentRevisionId,
    sourceId: ids.sourceId,
    adapterRevisionId: ids.adapterRevisionId,
    sdkDigest: digest("1"),
    bridgeDigest: digest("2"),
    toolchainReceiptId: "toolchain:pe-a:test",
    conformanceReceiptId: "conformance:pe-a:test",
    observerEffectReceiptId: "observer-effect:pe-a:test",
    policyProfileDigest: digest("3"),
    contentDigest: digest("4"),
  };

  it("does not permit a user goal before an exact binding", () => {
    const turn = {
      schemaVersion: 1,
      turnId: "turn:pe-a:user",
      taskId: ids.taskId,
      sessionId: ids.sessionId,
      purpose: "user_goal",
      attemptId: null,
      bindingEpochId: ids.bindingEpochId,
      promptDigest: digest("5"),
      queuedGoalDigest: null,
      budget,
      usage: {
        schemaVersion: 1,
        wallTimeMs: 0,
        toolCalls: 0,
        runtimeTimeMs: 0,
        inputTokens: 0,
        outputTokens: 0,
        storageBytes: 0,
        storageInodes: 0,
      },
      usageStatus: "observed",
      status: "created",
      terminalCode: null,
      terminalMessage: null,
      startedAt: null,
      endedAt: null,
    };
    expect(ProjectEnvironmentTurnV1Schema.parse(turn).purpose).toBe(
      "user_goal",
    );
    expect(() =>
      ProjectEnvironmentTurnV1Schema.parse({ ...turn, bindingEpochId: null }),
    ).toThrow(/before an exact environment binding/u);
  });

  it("represents unavailable turn usage explicitly instead of zero-filling it", () => {
    const failedTurn = {
      schemaVersion: 1,
      turnId: "turn:pe-a:failed",
      taskId: ids.taskId,
      sessionId: ids.sessionId,
      purpose: "environment_initialization",
      attemptId: ids.attemptId,
      bindingEpochId: null,
      promptDigest: digest("6"),
      queuedGoalDigest: null,
      budget,
      usageStatus: "unavailable",
      usage: null,
      status: "failed",
      terminalCode: "MODEL_NOT_FOUND",
      terminalMessage: "the selected model was not registered",
      startedAt: timestamp(1),
      endedAt: timestamp(2),
    };

    expect(ProjectEnvironmentTurnV1Schema.parse(failedTurn)).toMatchObject({
      usageStatus: "unavailable",
      usage: null,
    });
    expect(() =>
      ProjectEnvironmentTurnV1Schema.parse({
        ...failedTurn,
        usage: {
          schemaVersion: 1,
          wallTimeMs: 0,
          toolCalls: 0,
          runtimeTimeMs: 0,
          inputTokens: 0,
          outputTokens: 0,
          storageBytes: 0,
          storageInodes: 0,
        },
      }),
    ).toThrow(/usageStatus/u);

    expect(
      ProjectEnvironmentTurnV1Schema.parse({
        ...failedTurn,
        usageStatus: "partial",
        usage: {
          schemaVersion: 1,
          wallTimeMs: 12,
          toolCalls: null,
          runtimeTimeMs: null,
          inputTokens: null,
          outputTokens: null,
          storageBytes: null,
          storageInodes: null,
        },
      }),
    ).toMatchObject({
      usageStatus: "partial",
      usage: { wallTimeMs: 12, runtimeTimeMs: null, inputTokens: null },
    });
  });

  it("binds compatibility receipts to one exact candidate Build", () => {
    const binding = {
      schemaVersion: 1,
      taskId: ids.taskId,
      workspaceId: "workspace:pe-a:test",
      sourceId: ids.sourceId,
      buildId: "build:pe-a:test",
      bindingEpochId: ids.bindingEpochId,
      environmentRevisionId: ids.environmentRevisionId,
      adapterRevisionId: ids.adapterRevisionId,
      payloadSchemaDigest: digest("6"),
      sdkDigest: digest("1"),
      bridgeDigest: digest("2"),
      toolchainReceiptId: "toolchain:pe-a:test",
      compatibilityStatus: "compatible",
      compatibilityReceiptId: "compatibility:pe-a:test",
      createdAt: timestamp(8),
    };
    expect(
      ProjectEnvironmentBuildBindingV1Schema.parse(binding).compatibilityStatus,
    ).toBe("compatible");
    expect(() =>
      ProjectEnvironmentBuildBindingV1Schema.parse({
        ...binding,
        compatibilityReceiptId: null,
      }),
    ).toThrow(/exact receipt/u);
  });

  it("derives ready state from an exact source-bound current revision", () => {
    expect(
      ProjectEnvironmentV1Schema.parse({
        schemaVersion: 1,
        environmentId: ids.environmentId,
        inspectedSourceId: ids.sourceId,
        state: "ready",
        current: environmentReference,
        reviewReasons: [],
        inspectedAt: timestamp(9),
      }).state,
    ).toBe("ready");
    expect(() =>
      ProjectEnvironmentV1Schema.parse({
        schemaVersion: 1,
        environmentId: ids.environmentId,
        inspectedSourceId: "source:changed",
        state: "ready",
        current: environmentReference,
        reviewReasons: [],
        inspectedAt: timestamp(9),
      }),
    ).toThrow(/exact source binding/u);
  });

  it("treats the pointer CAS as publication commit", () => {
    const receipt = {
      schemaVersion: 1,
      receiptId: ids.publicationReceiptId,
      operationId: ids.operationId,
      taskId: ids.taskId,
      attemptId: ids.attemptId,
      environmentId: ids.environmentId,
      targetEnvironmentRevisionId: ids.environmentRevisionId,
      expectedCurrentRevisionId: null,
      observedCurrentRevisionId: null,
      realizedCurrentRevisionId: ids.environmentRevisionId,
      revisionMaterialized: true,
      pointerCommitted: true,
      outcome: "committed",
      failures: [],
      completedAt: timestamp(5),
    };
    expect(EnvironmentPublicationReceiptV1Schema.parse(receipt).outcome).toBe(
      "committed",
    );
    expect(() =>
      EnvironmentPublicationReceiptV1Schema.parse({
        ...receipt,
        pointerCommitted: false,
      }),
    ).toThrow(/committed publication/u);
  });
});
