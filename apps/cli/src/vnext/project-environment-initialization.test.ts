import { describe, expect, it, vi } from "vitest";

import {
  AdapterConformanceReceiptV1Schema,
  EnvironmentBindingEpochV1Schema,
  EnvironmentPublicationIntentV1Schema,
  EnvironmentPublicationReceiptV1Schema,
  PROJECT_CAPABILITY_MODULE_NAMES_V1,
  PROJECT_READY_REQUIRED_MODULE_NAMES_V1,
  ProjectAdapterCandidateReferenceV1Schema,
  ProjectAdapterRevisionV1Schema,
  ProjectEnvironmentRevisionV1Schema,
  ProjectTurnBudgetV1Schema,
  ProjectTurnUsageV1Schema,
  asAdapterConformanceReceiptId,
  asAdapterId,
  asEnvironmentBindingEpochId,
  asEnvironmentPublicationReceiptId,
  asObserverEffectReceiptId,
  asProjectAdapterCandidateId,
  asProjectAdapterRevisionId,
  asProjectEnvironmentId,
  asProjectEnvironmentOperationId,
  asProjectEnvironmentRevisionId,
  asProjectEnvironmentTaskId,
  asProjectEnvironmentTurnId,
  asProjectInitializationAttemptEventId,
  asProjectInitializationAttemptId,
  asProjectSessionId,
  asProjectToolchainReceiptId,
  asSha256DigestV1,
  asSourceId,
  type ProjectEnvironmentTurnV1,
  type ProjectInitializationAttemptEventV1,
} from "@chronorift/domain";

import {
  composeProjectEnvironmentInitializationPromptV1,
  composeProjectEnvironmentInitializationPromptV2,
  enforceProjectEnvironmentTurnBudgetV1,
  initializeProjectEnvironmentV1,
  projectEnvironmentTurnTimeoutMsV1,
  type InitializeProjectEnvironmentV1Request,
  type ProjectEnvironmentInitializationPortV1,
  type ProjectEnvironmentPiTurnResultV1,
} from "./project-environment-initialization.js";

const digest = (character: string) => asSha256DigestV1(character.repeat(64));

const ids = {
  taskId: asProjectEnvironmentTaskId("task:pe-a"),
  attemptId: asProjectInitializationAttemptId("attempt:pe-a"),
  sessionId: asProjectSessionId("session:pe-a"),
  sourceId: asSourceId("source:pe-a"),
  candidateId: asProjectAdapterCandidateId("candidate:pe-a"),
  adapterId: asAdapterId("adapter:pe-a"),
  adapterRevisionId: asProjectAdapterRevisionId("adapter-revision:pe-a"),
  environmentId: asProjectEnvironmentId("environment:pe-a"),
  environmentRevisionId: asProjectEnvironmentRevisionId(
    "environment-revision:pe-a",
  ),
  operationId: asProjectEnvironmentOperationId("operation:pe-a"),
  conformanceId: asAdapterConformanceReceiptId("conformance:pe-a"),
  toolchainId: asProjectToolchainReceiptId("toolchain:pe-a"),
  observerId: asObserverEffectReceiptId("observer:pe-a"),
  publicationId: asEnvironmentPublicationReceiptId("publication:pe-a"),
  bindingId: asEnvironmentBindingEpochId("binding:pe-a"),
};

const budget = ProjectTurnBudgetV1Schema.parse({
  schemaVersion: 1,
  wallTimeMs: 1_800_000,
  toolCallLimit: 256,
  runtimeTimeMs: 600_000,
  tokenPolicy: "observe_only",
  tokenLimit: null,
  storageByteLimit: 1_073_741_824,
  storageInodeLimit: 131_072,
});

const usage = ProjectTurnUsageV1Schema.parse({
  schemaVersion: 1,
  wallTimeMs: 100,
  toolCalls: 2,
  runtimeTimeMs: 0,
  inputTokens: 10,
  outputTokens: 20,
  storageBytes: 1_024,
  storageInodes: 4,
});

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
      protocolVersion: required ? "project-module:v1" : null,
      limitations: required ? [] : ["not declared"],
    };
  }),
};

const candidate = ProjectAdapterCandidateReferenceV1Schema.parse({
  schemaVersion: 1,
  taskId: ids.taskId,
  attemptId: ids.attemptId,
  candidateId: ids.candidateId,
  adapterId: ids.adapterId,
  sourceId: ids.sourceId,
  contentDigest: digest("a"),
  fileCount: 3,
  byteLength: 1_024,
  frozenAt: "2026-08-12T00:00:02.000Z",
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

const conformance = AdapterConformanceReceiptV1Schema.parse({
  schemaVersion: 1,
  receiptId: ids.conformanceId,
  taskId: ids.taskId,
  attemptId: ids.attemptId,
  sourceId: ids.sourceId,
  candidateId: ids.candidateId,
  candidateDigest: candidate.contentDigest,
  toolchainReceiptId: ids.toolchainId,
  capabilitySet,
  stateDomains: [
    {
      schemaVersion: 1,
      domainId: "state:world",
      disposition: "captured",
      schemaDigest: digest("b"),
      limitations: [],
    },
  ],
  observations: {
    schemaVersion: 1,
    bridgeHandshakes: 1,
    entityLifecycleRecords: 1,
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
      observedRecords: 3,
      droppedRecords: 0,
      overwrittenRecords: 0,
      limitations: [],
    },
  ],
  cleanup,
  outcome: "conformed",
  failures: [],
  startedAt: "2026-08-12T00:00:03.000Z",
  completedAt: "2026-08-12T00:00:04.000Z",
});

const adapterRevision = ProjectAdapterRevisionV1Schema.parse({
  schemaVersion: 1,
  adapterRevisionId: ids.adapterRevisionId,
  adapterId: ids.adapterId,
  sourceId: ids.sourceId,
  packageDigest: candidate.contentDigest,
  manifestDigest: digest("c"),
  implementationDigest: digest("d"),
  payloadSchemaDigest: digest("e"),
  sdkDigest: digest("f"),
  bridgeDigest: digest("1"),
  capabilitySet,
  conformanceReceiptId: ids.conformanceId,
  contentByteLength: candidate.byteLength,
  contentFileCount: candidate.fileCount,
});

const publicationIntent = EnvironmentPublicationIntentV1Schema.parse({
  schemaVersion: 1,
  operationId: ids.operationId,
  taskId: ids.taskId,
  attemptId: ids.attemptId,
  environmentId: ids.environmentId,
  candidateId: ids.candidateId,
  sourceId: ids.sourceId,
  targetEnvironmentRevisionId: ids.environmentRevisionId,
  targetAdapterRevisionId: ids.adapterRevisionId,
  expectedCurrentRevisionId: null,
  targetContentDigest: digest("2"),
  createdAt: "2026-08-12T00:00:05.000Z",
});

const environmentRevision = ProjectEnvironmentRevisionV1Schema.parse({
  schemaVersion: 1,
  environmentId: ids.environmentId,
  environmentRevisionId: ids.environmentRevisionId,
  sourceId: ids.sourceId,
  adapterRevisionId: ids.adapterRevisionId,
  sdkDigest: adapterRevision.sdkDigest,
  bridgeDigest: adapterRevision.bridgeDigest,
  toolchainReceiptId: ids.toolchainId,
  conformanceReceiptId: ids.conformanceId,
  observerEffectReceiptId: ids.observerId,
  policyProfileDigest: digest("3"),
  publicationOperationId: ids.operationId,
  contentDigest: publicationIntent.targetContentDigest,
  publishedAt: "2026-08-12T00:00:06.000Z",
});

const publication = EnvironmentPublicationReceiptV1Schema.parse({
  schemaVersion: 1,
  receiptId: ids.publicationId,
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
  completedAt: "2026-08-12T00:00:07.000Z",
});

const request = (
  queuedGoal: string | null,
): InitializeProjectEnvironmentV1Request => ({
  taskId: ids.taskId,
  sessionId: ids.sessionId,
  sourceId: ids.sourceId,
  adapterId: ids.adapterId,
  sourceIdentity: digest("4"),
  mainScene: "res://main.tscn",
  requestedGodotVersion: "4.7.1",
  providerId: "provider:test",
  modelId: "model:test",
  thinkingLevel: "high",
  budget,
  queuedGoal,
  ids: {
    attemptId: ids.attemptId,
    initializationTurnId: asProjectEnvironmentTurnId("turn:init"),
    goalTurnId: asProjectEnvironmentTurnId("turn:goal"),
    bindingEpochId: ids.bindingId,
    attemptEventId: (sequence) =>
      asProjectInitializationAttemptEventId(`attempt-event:${sequence}`),
  },
});

const completed = (): ProjectEnvironmentPiTurnResultV1 => ({
  status: "completed",
  sessionId: ids.sessionId,
  usageStatus: "observed",
  usage,
  errorCode: null,
  errorMessage: null,
});

const makePort = () => {
  const attemptEvents: ProjectInitializationAttemptEventV1[] = [];
  const turns: ProjectEnvironmentTurnV1[] = [];
  const appendAttemptEvent = vi.fn(
    async (event: ProjectInitializationAttemptEventV1): Promise<void> => {
      attemptEvents.push(event);
    },
  );
  const putTurn = vi.fn(
    async (turn: ProjectEnvironmentTurnV1): Promise<void> => {
      turns.push(turn);
    },
  );
  const runTurn = vi.fn<ProjectEnvironmentInitializationPortV1["runTurn"]>(
    async () => completed(),
  );
  const freezeCandidate = vi.fn(async () => candidate);
  const validateCandidate = vi.fn(async () => ({
    candidate,
    conformance,
    adapterRevision,
    environmentRevision,
    publicationIntent,
    revisionFiles: [{ path: "record.json", bytes: Buffer.from("{}") }],
  }));
  const publish = vi.fn(async () => publication);
  const resolvePublication = vi.fn(async () => undefined);
  const bind = vi.fn(async () =>
    EnvironmentBindingEpochV1Schema.parse({
      schemaVersion: 1,
      bindingEpochId: ids.bindingId,
      taskId: ids.taskId,
      ordinal: 0,
      state: "bound",
      attemptId: ids.attemptId,
      environment: {
        schemaVersion: 1,
        environmentId: ids.environmentId,
        environmentRevisionId: ids.environmentRevisionId,
        sourceId: ids.sourceId,
        adapterRevisionId: ids.adapterRevisionId,
        sdkDigest: adapterRevision.sdkDigest,
        bridgeDigest: adapterRevision.bridgeDigest,
        toolchainReceiptId: ids.toolchainId,
        conformanceReceiptId: ids.conformanceId,
        observerEffectReceiptId: ids.observerId,
        policyProfileDigest: environmentRevision.policyProfileDigest,
        contentDigest: environmentRevision.contentDigest,
      },
      publicationOperationId: ids.operationId,
      publicationReceiptId: ids.publicationId,
      createdAt: "2026-08-12T00:00:08.000Z",
      boundAt: "2026-08-12T00:00:08.000Z",
    }),
  );
  const port: ProjectEnvironmentInitializationPortV1 = {
    appendAttemptEvent,
    putTurn,
    runTurn,
    assertGameSourceUnchanged: vi.fn(async () => undefined),
    freezeCandidate,
    validateCandidate,
    publish,
    bind,
    resolvePublication,
  };
  return {
    port,
    attemptEvents,
    turns,
    runTurn,
    freezeCandidate,
    validateCandidate,
    publish,
    bind,
    resolvePublication,
  };
};

const monotonicClock = () => {
  let tick = 0;
  return () => `2026-08-12T00:01:${String(tick++).padStart(2, "0")}.000Z`;
};

describe("PE-A initialization sequencing", () => {
  it("clamps any command timeout override to the declared turn wall-time budget", () => {
    expect(projectEnvironmentTurnTimeoutMsV1(undefined, budget)).toBe(
      budget.wallTimeMs,
    );
    expect(projectEnvironmentTurnTimeoutMsV1(10, budget)).toBe(10);
    expect(
      projectEnvironmentTurnTimeoutMsV1(budget.wallTimeMs + 1, budget),
    ).toBe(budget.wallTimeMs);
  });

  it("leaves unavailable usage counters null instead of assuming budget compliance facts", () => {
    const partial = enforceProjectEnvironmentTurnBudgetV1(
      {
        ...completed(),
        usageStatus: "partial",
        usage: ProjectTurnUsageV1Schema.parse({
          ...usage,
          runtimeTimeMs: null,
          storageBytes: null,
          storageInodes: null,
        }),
      },
      budget,
    );
    expect(partial).toMatchObject({
      status: "completed",
      usageStatus: "partial",
      usage: {
        runtimeTimeMs: null,
        storageBytes: null,
        storageInodes: null,
      },
    });
  });

  it("forces a budget-exhausted terminal result when active tool admission rejects a call", () => {
    const terminal = enforceProjectEnvironmentTurnBudgetV1(
      completed(),
      budget,
      { toolCallAdmissionExhausted: true },
    );
    expect(terminal).toMatchObject({
      status: "failed",
      errorCode: "budget_exhausted",
      usage: { toolCalls: usage.toolCalls },
    });
    expect(terminal.errorMessage).toContain(
      `${budget.toolCallLimit} admitted call(s)`,
    );
  });

  it("seals an observed initialization budget excess and never publishes", async () => {
    const fixture = makePort();
    fixture.runTurn.mockResolvedValueOnce({
      ...completed(),
      usageStatus: "observed",
      usage: ProjectTurnUsageV1Schema.parse({
        ...usage,
        toolCalls: budget.toolCallLimit + 1,
      }),
    });

    const result = await initializeProjectEnvironmentV1(
      request("must remain queued"),
      fixture.port,
      monotonicClock(),
    );

    expect(result.attempt).toMatchObject({
      state: "failed",
      terminalCode: "budget_exhausted",
    });
    expect(result.initializationTurn).toMatchObject({
      status: "failed",
      terminalCode: "budget_exhausted",
      usage: { toolCalls: budget.toolCallLimit + 1 },
    });
    expect(fixture.freezeCandidate).not.toHaveBeenCalled();
    expect(fixture.publish).not.toHaveBeenCalled();
    expect(result.goalDelivered).toBe(false);
  });

  it("keeps the queued goal out of initialization and delivers it only after publication binding", async () => {
    const fixture = makePort();
    const result = await initializeProjectEnvironmentV1(
      request("Add a pause menu"),
      fixture.port,
      monotonicClock(),
    );

    expect(result.attempt.state).toBe("succeeded");
    expect(result.goalDelivered).toBe(true);
    expect(fixture.runTurn).toHaveBeenCalledTimes(2);
    const initializationCall = fixture.runTurn.mock.calls[0]?.[0];
    const goalCall = fixture.runTurn.mock.calls[1]?.[0];
    expect(initializationCall?.prompt).not.toContain("Add a pause menu");
    expect(initializationCall).toMatchObject({
      purpose: "environment_initialization",
      bindingEpochId: null,
    });
    expect(goalCall).toMatchObject({
      purpose: "user_goal",
      prompt: "Add a pause menu",
      sessionId: ids.sessionId,
      bindingEpochId: ids.bindingId,
    });
    expect(fixture.attemptEvents.map((event) => event.eventKind)).toEqual([
      "created",
      "agent_running",
      "candidate_frozen",
      "validating",
      "publishing",
      "publication_committed",
      "binding",
      "succeeded",
    ]);
    expect(fixture.turns.map((turn) => turn.purpose)).toEqual([
      "environment_initialization",
      "user_goal",
    ]);
  });

  it("never freezes or publishes after a failed Agent turn", async () => {
    const fixture = makePort();
    fixture.runTurn.mockResolvedValueOnce({
      ...completed(),
      status: "failed",
      errorCode: "provider_failure",
      errorMessage: "provider stopped",
    });
    const result = await initializeProjectEnvironmentV1(
      request("queued work"),
      fixture.port,
      monotonicClock(),
    );

    expect(result.attempt).toMatchObject({
      state: "failed",
      terminalCode: "provider_failure",
    });
    expect(fixture.freezeCandidate).not.toHaveBeenCalled();
    expect(fixture.publish).not.toHaveBeenCalled();
    expect(fixture.runTurn).toHaveBeenCalledTimes(1);
    expect(result.goalDelivered).toBe(false);
  });

  it("seals a thrown Pi initialization failure without fabricating usage", async () => {
    const fixture = makePort();
    fixture.runTurn.mockRejectedValueOnce(
      Object.assign(
        new Error("Pi model provider:test/model:test is not registered"),
        { code: "MODEL_NOT_FOUND" },
      ),
    );

    const result = await initializeProjectEnvironmentV1(
      request("must remain queued"),
      fixture.port,
      monotonicClock(),
    );

    expect(result.attempt).toMatchObject({
      state: "failed",
      terminalCode: "MODEL_NOT_FOUND",
      terminalMessage: "Pi model provider:test/model:test is not registered",
    });
    expect(result.initializationTurn).toMatchObject({
      status: "failed",
      usageStatus: "unavailable",
      usage: null,
      terminalCode: "MODEL_NOT_FOUND",
      terminalMessage: "Pi model provider:test/model:test is not registered",
    });
    expect(fixture.turns).toEqual([result.initializationTurn]);
    expect(result.binding).toBeNull();
    expect(result.goalTurn).toBeNull();
    expect(result.goalDelivered).toBe(false);
    expect(fixture.freezeCandidate).not.toHaveBeenCalled();
    expect(fixture.publish).not.toHaveBeenCalled();
  });

  it("seals an aborted Pi initialization throw as cancelled", async () => {
    const fixture = makePort();
    const aborted = new Error("Pi turn was aborted by the caller");
    aborted.name = "AbortError";
    fixture.runTurn.mockRejectedValueOnce(aborted);

    const result = await initializeProjectEnvironmentV1(
      request(null),
      fixture.port,
      monotonicClock(),
    );

    expect(result.attempt).toMatchObject({
      state: "cancelled",
      terminalCode: "cancelled",
    });
    expect(result.initializationTurn).toMatchObject({
      status: "cancelled",
      usageStatus: "unavailable",
      usage: null,
      terminalCode: "cancelled",
    });
  });

  it("records an initialization timeout as terminal and never publishes", async () => {
    const fixture = makePort();
    fixture.runTurn.mockResolvedValueOnce({
      ...completed(),
      status: "failed",
      errorCode: "turn_timeout",
      errorMessage: "initialization wall-time budget expired",
    });
    const result = await initializeProjectEnvironmentV1(
      request("must remain queued"),
      fixture.port,
      monotonicClock(),
    );

    expect(result.attempt).toMatchObject({
      state: "failed",
      terminalCode: "turn_timeout",
    });
    expect(result.initializationTurn.status).toBe("failed");
    expect(result.binding).toBeNull();
    expect(result.goalTurn).toBeNull();
    expect(result.goalDelivered).toBe(false);
    expect(fixture.freezeCandidate).not.toHaveBeenCalled();
    expect(fixture.publish).not.toHaveBeenCalled();
  });

  it("keeps a committed environment bound when the queued goal fails and reports goal-not-delivered", async () => {
    const fixture = makePort();
    fixture.runTurn.mockResolvedValueOnce(completed()).mockResolvedValueOnce({
      ...completed(),
      status: "failed",
      errorCode: "goal_tool_failure",
      errorMessage: "the goal turn could not complete",
    });
    const result = await initializeProjectEnvironmentV1(
      request("change the project"),
      fixture.port,
      monotonicClock(),
    );

    expect(result.attempt.state).toBe("succeeded");
    expect(result.binding?.state).toBe("bound");
    expect(result.goalTurn).toMatchObject({
      purpose: "user_goal",
      status: "failed",
    });
    expect(result.goalDelivered).toBe(false);
    expect(fixture.publish).toHaveBeenCalledTimes(1);
  });

  it("keeps publication bound when the queued goal Pi call throws", async () => {
    const fixture = makePort();
    fixture.runTurn
      .mockResolvedValueOnce(completed())
      .mockRejectedValueOnce(
        new Error(
          "Pi model provider:test/model:test has no usable Host authentication",
        ),
      );

    const result = await initializeProjectEnvironmentV1(
      request("change the project"),
      fixture.port,
      monotonicClock(),
    );

    expect(result.attempt.state).toBe("succeeded");
    expect(result.binding?.state).toBe("bound");
    expect(result.goalTurn).toMatchObject({
      purpose: "user_goal",
      status: "failed",
      usageStatus: "unavailable",
      usage: null,
      terminalCode: "pi_turn_exception",
      terminalMessage:
        "Pi model provider:test/model:test has no usable Host authentication",
    });
    expect(result.goalDelivered).toBe(false);
    expect(fixture.turns).toEqual([result.initializationTurn, result.goalTurn]);
    expect(fixture.publish).toHaveBeenCalledTimes(1);
  });

  it("treats validation as authoritative and leaves the environment uninitialized on rejection", async () => {
    const fixture = makePort();
    fixture.validateCandidate.mockRejectedValueOnce(
      Object.assign(new Error("schema did not match"), {
        code: "adapter_rejected",
      }),
    );
    const result = await initializeProjectEnvironmentV1(
      request(null),
      fixture.port,
      monotonicClock(),
    );

    expect(result.attempt).toMatchObject({
      state: "failed",
      terminalCode: "adapter_rejected",
    });
    expect(fixture.publish).not.toHaveBeenCalled();
    expect(fixture.attemptEvents.at(-1)?.eventKind).toBe("failed");
  });

  it("seals a post-publication Task-store failure as binding_failed without undoing current", async () => {
    const fixture = makePort();
    fixture.bind.mockRejectedValueOnce(
      Object.assign(new Error("Task binding ledger unavailable"), {
        code: "binding_store_failed",
      }),
    );
    const result = await initializeProjectEnvironmentV1(
      request("must not run"),
      fixture.port,
      monotonicClock(),
    );

    expect(result.attempt).toMatchObject({
      state: "binding_failed",
      environmentRevisionId: ids.environmentRevisionId,
      terminalCode: "binding_store_failed",
    });
    expect(result.publication?.outcome).toBe("committed");
    expect(fixture.runTurn).toHaveBeenCalledTimes(1);
  });

  it("uses a normal prompt contract instead of a hidden submit or fixed investigation script", () => {
    const prompt = composeProjectEnvironmentInitializationPromptV1({
      adapterId: ids.adapterId,
      mainScene: "res://main.tscn",
      requestedGodotVersion: "4.7.1",
      sourceIdentity: digest("5"),
    });
    expect(prompt).toContain("no required tool order");
    expect(prompt).not.toMatch(/submit|phase 1|step 1/iu);
  });

  it("tells V2 authors to edit the scaffold and leave conformance to Host", () => {
    const prompt = composeProjectEnvironmentInitializationPromptV2({
      adapterId: ids.adapterId,
      mainScene: "res://main.tscn",
      requestedGodotVersion: "4.7.1",
      sourceIdentity: digest("5"),
    });
    expect(prompt).toContain("Edit the pre-created ProjectAdapter scaffold");
    expect(prompt).toContain("replace every dynamic-placeholder identifier");
    expect(prompt).toContain(
      "call project_adapter_finalize_v2 until it succeeds once",
    );
    expect(prompt).toContain("protocol literal 4.7.x");
    expect(prompt).toContain("do not rename them or leave extra schema files");
    expect(prompt).toContain(
      "Do not run Godot or perform conformance yourself",
    );
    expect(prompt).not.toContain("Create the one ProjectAdapter candidate");
  });
});
