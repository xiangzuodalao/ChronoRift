import {
  parseResourceHandleV1,
  type DiagnosisProposalDraftV1,
  type ResourceHandleV1,
} from "@chronorift/agent-protocol";
import {
  asBranchId,
  asCapsuleId,
  asComparisonId,
  asEventId,
  asExecutionId,
  asFixtureId,
  asInterventionId,
  asInvestigationId,
  asRunId,
  type EvidenceAccessReceiptV2,
  type EvidenceCapsuleV2,
  type ExperimentCandidateV1,
  type JsonValue,
  type V03ExecutionComparison,
  type V03ExecutionLog,
  type V03TelemetryEvent,
} from "@chronorift/domain";
import {
  v04ClaimPolicyManifestFor,
  v04ContentHash,
  v04EvidenceAccessReceiptIdFor,
  type ClaimPolicyAgentDescriptor,
} from "@chronorift/gamebranch";
import type { RestrictedSourceAccess } from "@chronorift/pi-harness";
import { describe, expect, it, vi } from "vitest";

import {
  V04InvestigationApi,
  V04InvestigationApiError,
} from "./v04-investigation-api.js";
import type { V04RunContext } from "./v04-runtime.js";

const runId = asRunId("run:v04:api-test");
const investigationId = asInvestigationId("investigation:v1:api-test");
const fixtureId = asFixtureId("fixture:api-test");
const baselineExecutionId = asExecutionId("execution:v04:baseline");
const replayExecutionId = asExecutionId("execution:v04:replay");
const candidateExecutionId = asExecutionId("execution:v04:candidate");
const capsuleId = asCapsuleId("capsule:v04:api-test");
const comparisonId = asComparisonId("comparison:v04:api-test");
const interventionOneId = asInterventionId("intervention:v04:one");
const interventionTwoId = asInterventionId("intervention:v04:two");
const digest = "a".repeat(64);
const issuedAt = "2026-08-06T01:02:03.000Z";

const eventFor = (
  suffix: string,
  executionId: ReturnType<typeof asExecutionId>,
): V03TelemetryEvent =>
  ({
    schemaVersion: 2,
    eventId: asEventId(`event:v04:${suffix}`),
    executionId,
    runId,
    branchId: asBranchId(`branch:v04:${suffix}`),
    seq: 0,
    tick: 1,
    simTimeUs: 16_667,
    kind: "log",
    level: "info",
    source: "fixture",
    message: suffix,
    fields: {},
  }) as V03TelemetryEvent;

const executionFor = (
  suffix: string,
  executionId: ReturnType<typeof asExecutionId>,
): V03ExecutionLog =>
  ({
    schemaVersion: 2,
    executionId,
    runId,
    fixtureId,
    events: [eventFor(suffix, executionId)],
    timelineDigest: digest,
  }) as unknown as V03ExecutionLog;

const interventionOne: ExperimentCandidateV1 = {
  schemaVersion: 1,
  interventionId: interventionOneId,
  label: "connect the receiver first",
  intervention: {
    kind: "set_fixture_control",
    name: "connect_before_emit",
    value: true,
  },
};

const interventionTwo: ExperimentCandidateV1 = {
  schemaVersion: 1,
  interventionId: interventionTwoId,
  label: "unrelated timing control",
  intervention: {
    kind: "set_runtime_control",
    name: "fixed_fps",
    value: 30,
  },
};

const claimPolicyAgentDescriptor: ClaimPolicyAgentDescriptor = {
  policyId: "test.receiver-order",
  policyVersion: "1.0.0",
  mechanismId: "signal.receiver_order",
  assertionSchemaId: "chronorift.test.receiver-order.v1",
  mechanismDescription:
    "A signal is emitted before its intended receiver is connected.",
  additionalProperties: false,
  assertionFields: [
    {
      name: "signal",
      type: "string",
      required: true,
      description: "Observed signal name.",
    },
    {
      name: "expectedReceiver",
      type: "string",
      required: true,
      description: "Intended receiver name.",
    },
  ],
  evidenceRequirements: [
    "Cite the baseline signal, failed delivery, and later connection events.",
    "Cite the candidate signal, successful delivery, and expected state-change events.",
  ],
};

interface FakeApiHarness {
  readonly api: V04InvestigationApi;
  readonly context: V04RunContext;
  readonly persistedReceipts: EvidenceAccessReceiptV2[];
  readonly gameBranch: {
    readonly replayExecution: ReturnType<typeof vi.fn>;
    readonly listClaimPolicyContracts: ReturnType<typeof vi.fn>;
    readonly listInterventions: ReturnType<typeof vi.fn>;
    readonly runIntervention: ReturnType<typeof vi.fn>;
    readonly compareExecutions: ReturnType<typeof vi.fn>;
  };
}

const createHarness = (
  maxInterventions = 2,
  sourceOverride?: RestrictedSourceAccess,
  activeClaimPolicy: ClaimPolicyAgentDescriptor = claimPolicyAgentDescriptor,
  replayMatches = true,
): FakeApiHarness => {
  const baselineExecution = executionFor("baseline", baselineExecutionId);
  const replayExecution = {
    ...executionFor("replay", replayExecutionId),
    timelineDigest: replayMatches ? digest : "c".repeat(64),
  };
  const candidateExecution = executionFor("candidate", candidateExecutionId);
  const capsule: EvidenceCapsuleV2 = {
    schemaVersion: 2,
    capsuleId,
    runId,
    fixtureId,
    contractId: "contract:v3:".concat("b".repeat(64)) as never,
    baselineExecutionId,
    checkpointId: "checkpoint:v04:test" as never,
    eventChain: baselineExecution.events,
    evidenceLinks: [
      { role: "runtime_log", eventId: baselineExecution.events[0]!.eventId },
    ],
    expected: { kind: "property_equals", path: "door.open", value: true },
    actual: { present: true, value: false },
    violationSummary: "activated was emitted but the door stayed closed",
    timelineDigest: digest,
    eventLossDetected: false,
    knownLimitations: [],
  };
  const comparison: V03ExecutionComparison = {
    schemaVersion: 2,
    comparisonId,
    runId,
    fixtureId,
    contractId: capsule.contractId,
    baselineExecutionId,
    candidateExecutionId,
    interventionId: interventionOneId,
    intervention: interventionOne.intervention,
    baselineOutcome: "fail",
    candidateOutcome: "pass",
    comparable: true,
    blockers: [],
    firstDivergenceTick: 1,
  };
  const persistedReceipts: EvidenceAccessReceiptV2[] = [];
  const gameBranch = {
    listClaimPolicyContracts: vi.fn(() => [activeClaimPolicy]),
    replayExecution: vi.fn(async () => ({
      execution: replayExecution,
      matches: replayMatches,
      sourceDigest: digest,
      replayDigest: replayExecution.timelineDigest,
    })),
    listInterventions: vi.fn(() => [interventionOne, interventionTwo]),
    runIntervention: vi.fn(async () => ({ execution: candidateExecution })),
    compareExecutions: vi.fn(async () => comparison),
  };
  const repository = {
    putEvidenceAccessReceipt: vi.fn(
      async (receipt: EvidenceAccessReceiptV2): Promise<void> => {
        persistedReceipts.push(structuredClone(receipt));
      },
    ),
  };
  const source: RestrictedSourceAccess =
    sourceOverride ??
    ({
      root: "/virtual/source",
      read: async () => ({
        path: "case/main.gd",
        content: "func _on_activated():\n    door.open = true",
        startLine: 10,
        endLine: 11,
        totalLines: 20,
        truncated: false,
      }),
      search: async (request) => ({
        query: request.query,
        matches: [
          {
            path: "case/main.gd",
            line: 10,
            column: 1,
            text: "func _on_activated():",
          },
        ],
        scannedFiles: 1,
        truncated: false,
      }),
    } satisfies RestrictedSourceAccess);
  const context = {
    runId,
    investigationId,
    investigation: {
      experimentBudget: { maxInterventions },
      interventions: [interventionOne, interventionTwo],
      claimPolicyManifest: v04ClaimPolicyManifestFor([
        claimPolicyAgentDescriptor,
      ]),
    },
    repository,
    gameBranch,
    baselineExecution,
    evidenceCapsule: capsule,
  } as unknown as V04RunContext;
  let handleSequence = 0;
  const api = new V04InvestigationApi(context, {
    source,
    nowIso: () => issuedAt,
    nextProposalId: () => "proposal:v04:api-test",
    nextHandle: () => {
      handleSequence += 1;
      return `rh_test_${String(handleSequence).padStart(8, "0")}`;
    },
  });
  return { api, context, persistedReceipts, gameBranch };
};

const expectApiError = async (
  promise: Promise<unknown>,
  code: V04InvestigationApiError["code"],
): Promise<void> => {
  try {
    await promise;
    throw new Error("Expected V04InvestigationApiError");
  } catch (error) {
    expect(error).toBeInstanceOf(V04InvestigationApiError);
    expect(error).toMatchObject({ code });
  }
};

const completeExperiment = async (api: V04InvestigationApi) => {
  const capsule = await api.getCapsule({
    capsuleHandle: api.initialCapsuleHandle,
  });
  const replay = await api.replayExecution({
    executionHandle: capsule.baselineExecutionHandle,
  });
  const catalog = await api.listInterventions({});
  const candidate = await api.runIntervention({
    baselineExecutionHandle: capsule.baselineExecutionHandle,
    interventionHandle: catalog.interventions[0]!.interventionHandle,
  });
  const comparison = await api.compareExecutions({
    baselineExecutionHandle: capsule.baselineExecutionHandle,
    candidateExecutionHandle: candidate.executionHandle,
  });
  return { capsule, replay, catalog, candidate, comparison };
};

interface ProposalHandleOverrides {
  readonly candidateExecutionHandles?: ResourceHandleV1[];
  readonly accessReceiptHandles?: ResourceHandleV1[];
  readonly evidenceEventHandles?: ResourceHandleV1[];
}

const proposalFor = (
  flow: Awaited<ReturnType<typeof completeExperiment>>,
  overrides: ProposalHandleOverrides = {},
): DiagnosisProposalDraftV1 => ({
  schemaVersion: 1,
  capsuleHandle: flow.capsule.capsuleHandle,
  baselineExecutionHandle: flow.capsule.baselineExecutionHandle,
  replayExecutionHandle: flow.replay.executionHandle,
  candidateExecutionHandles: [flow.candidate.executionHandle],
  comparisonHandles: [flow.comparison.comparisonHandle],
  accessReceiptHandles: [
    flow.capsule.accessReceiptHandle,
    flow.replay.accessReceiptHandle,
    flow.catalog.accessReceiptHandle,
    flow.candidate.accessReceiptHandle,
    flow.comparison.accessReceiptHandle,
  ],
  claim: {
    kind: "mechanism",
    mechanismId: "signal.receiver_order",
    assertion: {
      schemaId: "chronorift.test.receiver-order.v1",
      payload: { signal: "activated", expectedReceiver: "door" },
    },
  },
  summary: "The receiver connects after the activated signal is emitted.",
  evidenceEventHandles: [
    flow.capsule.events[0]!.eventHandle,
    flow.replay.events[0]!.eventHandle,
    flow.candidate.events[0]!.eventHandle,
  ],
  blockers: [],
  nextExperiment: null,
  confidence: 0.9876,
  ...overrides,
});

describe("V04InvestigationApi", () => {
  it("publishes every active claim contract and rejects frozen-registry drift", () => {
    const { api } = createHarness();

    expect(api.manifest.claimPolicies).toEqual([claimPolicyAgentDescriptor]);
    expect(() =>
      createHarness(2, undefined, {
        ...claimPolicyAgentDescriptor,
        mechanismId: "different_mechanism",
      }),
    ).toThrow("do not match the frozen Claim Policy manifest");
  });

  it("persists canonical, investigation-scoped receipts for returned evidence", async () => {
    const { api, context, persistedReceipts } = createHarness();

    const capsuleResult = await api.getCapsule({
      capsuleHandle: api.initialCapsuleHandle,
    });
    const sourceResult = await api.readSource({ path: "case/main.gd" });

    expect(capsuleResult.capsuleHandle).not.toBe(
      context.evidenceCapsule.capsuleId,
    );
    expect(capsuleResult.baselineExecutionHandle).not.toBe(
      context.baselineExecution.executionId,
    );
    expect(persistedReceipts).toHaveLength(2);
    expect(api.getReceipts()).toEqual(persistedReceipts);

    const capsuleReceipt = persistedReceipts[0]!;
    expect(capsuleReceipt).toMatchObject({
      schemaVersion: 2,
      runId,
      investigationId,
      accessKind: "capsule",
      resourceId: capsuleId,
      requestHash: v04ContentHash({ capsuleId }),
      contentHash: v04ContentHash(
        context.evidenceCapsule as unknown as JsonValue,
      ),
      sourceCoverage: [],
      issuedAt,
    });
    const receiptBody: Omit<EvidenceAccessReceiptV2, "receiptId" | "issuedAt"> =
      {
        schemaVersion: capsuleReceipt.schemaVersion,
        runId: capsuleReceipt.runId,
        investigationId: capsuleReceipt.investigationId,
        accessKind: capsuleReceipt.accessKind,
        resourceId: capsuleReceipt.resourceId,
        requestHash: capsuleReceipt.requestHash,
        contentHash: capsuleReceipt.contentHash,
        sourceCoverage: capsuleReceipt.sourceCoverage,
      };
    expect(capsuleReceipt.receiptId).toBe(
      v04EvidenceAccessReceiptIdFor(receiptBody),
    );

    const sourceReceipt = persistedReceipts[1]!;
    expect(sourceReceipt.requestHash).toBe(
      v04ContentHash({ path: "case/main.gd", limit: 200 }),
    );
    expect(sourceReceipt.contentHash).toBe(
      v04ContentHash({
        path: sourceResult.path,
        content: sourceResult.content,
        startLine: sourceResult.startLine,
        endLine: sourceResult.endLine,
        totalLines: sourceResult.totalLines,
        truncated: sourceResult.truncated,
      }),
    );
    expect(sourceReceipt.sourceCoverage).toEqual([
      {
        virtualPath: "case/main.gd",
        startLine: 10,
        endLine: 11,
        coveredSymbols: ["_on_activated"],
      },
    ]);

    const returned = api.getReceipts() as EvidenceAccessReceiptV2[];
    returned[0] = { ...returned[0]!, resourceId: "tampered" };
    expect(api.getReceipts()[0]!.resourceId).toBe(capsuleId);
  });

  it("returns typed errors for out-of-order, wrong-kind, and unknown handles", async () => {
    const { api } = createHarness();

    await expectApiError(
      api.replayExecution({ executionHandle: api.initialCapsuleHandle }),
      "INVALID_TOOL_FLOW",
    );
    const capsule = await api.getCapsule({
      capsuleHandle: api.initialCapsuleHandle,
    });
    await expectApiError(
      api.replayExecution({ executionHandle: api.initialCapsuleHandle }),
      "INVALID_HANDLE",
    );
    await expectApiError(
      api.replayExecution({
        executionHandle: parseResourceHandleV1("rh_external_1234"),
      }),
      "INVALID_HANDLE",
    );

    expect(capsule.baselineExecutionHandle).toMatch(/^rh_/u);
  });

  it("allows early catalog discovery but requires a successful replay before intervention", async () => {
    const { api, gameBranch } = createHarness();

    await expectApiError(api.listInterventions({}), "INVALID_TOOL_FLOW");
    const capsule = await api.getCapsule({
      capsuleHandle: api.initialCapsuleHandle,
    });
    const catalog = await api.listInterventions({});

    await expectApiError(
      api.runIntervention({
        baselineExecutionHandle: capsule.baselineExecutionHandle,
        interventionHandle: catalog.interventions[0]!.interventionHandle,
      }),
      "INVALID_TOOL_FLOW",
    );
    expect(gameBranch.runIntervention).not.toHaveBeenCalled();

    await api.replayExecution({
      executionHandle: capsule.baselineExecutionHandle,
    });
    await api.runIntervention({
      baselineExecutionHandle: capsule.baselineExecutionHandle,
      interventionHandle: catalog.interventions[0]!.interventionHandle,
    });
    expect(gameBranch.runIntervention).toHaveBeenCalledTimes(1);

    const divergent = createHarness(
      2,
      undefined,
      claimPolicyAgentDescriptor,
      false,
    );
    const divergentCapsule = await divergent.api.getCapsule({
      capsuleHandle: divergent.api.initialCapsuleHandle,
    });
    const divergentReplay = await divergent.api.replayExecution({
      executionHandle: divergentCapsule.baselineExecutionHandle,
    });
    const divergentCatalog = await divergent.api.listInterventions({});
    expect(divergentReplay.matches).toBe(false);
    await expectApiError(
      divergent.api.runIntervention({
        baselineExecutionHandle: divergentCapsule.baselineExecutionHandle,
        interventionHandle:
          divergentCatalog.interventions[0]!.interventionHandle,
      }),
      "INVALID_TOOL_FLOW",
    );
    expect(divergent.gameBranch.runIntervention).not.toHaveBeenCalled();
  });

  it("enforces replay and intervention budgets before another runtime execution", async () => {
    const replayHarness = createHarness(1);
    const replayCapsule = await replayHarness.api.getCapsule({
      capsuleHandle: replayHarness.api.initialCapsuleHandle,
    });
    await replayHarness.api.replayExecution({
      executionHandle: replayCapsule.baselineExecutionHandle,
    });
    await expectApiError(
      replayHarness.api.replayExecution({
        executionHandle: replayCapsule.baselineExecutionHandle,
      }),
      "BUDGET_EXHAUSTED",
    );
    expect(replayHarness.gameBranch.replayExecution).toHaveBeenCalledTimes(1);
    const catalogAfterRejectedReplay =
      await replayHarness.api.listInterventions({});
    expect(catalogAfterRejectedReplay.interventions).toHaveLength(2);

    const interventionHarness = createHarness(1);
    const capsule = await interventionHarness.api.getCapsule({
      capsuleHandle: interventionHarness.api.initialCapsuleHandle,
    });
    await interventionHarness.api.replayExecution({
      executionHandle: capsule.baselineExecutionHandle,
    });
    const catalog = await interventionHarness.api.listInterventions({});
    await interventionHarness.api.runIntervention({
      baselineExecutionHandle: capsule.baselineExecutionHandle,
      interventionHandle: catalog.interventions[0]!.interventionHandle,
    });
    await expectApiError(
      interventionHarness.api.runIntervention({
        baselineExecutionHandle: capsule.baselineExecutionHandle,
        interventionHandle: catalog.interventions[1]!.interventionHandle,
      }),
      "BUDGET_EXHAUSTED",
    );
    expect(
      interventionHarness.gameBranch.runIntervention,
    ).toHaveBeenCalledTimes(1);
  });

  it("normalizes source limits and rejects aggregate-budget overflow before I/O", async () => {
    const readLimits: number[] = [];
    const searchLimits: number[] = [];
    const source: RestrictedSourceAccess = {
      root: "/bounded/source",
      read: async (request) => {
        const limit = request.limit ?? 1;
        readLimits.push(limit);
        return {
          path: request.path,
          content: Array.from({ length: limit }, () => "line").join("\n"),
          startLine: 1,
          endLine: limit,
          totalLines: limit,
          truncated: false,
        };
      },
      search: async (request) => {
        const limit = request.maxResults ?? 1;
        searchLimits.push(limit);
        return {
          query: request.query,
          matches: Array.from({ length: limit }, (_, index) => ({
            path: `case/file-${String(index)}.gd`,
            line: 1,
            column: 1,
            text: "func candidate():",
          })),
          scannedFiles: limit,
          truncated: false,
        };
      },
    };

    const readApi = createHarness(2, source).api;
    await readApi.readSource({ path: "case/a.gd", limit: 400 });
    await expectApiError(
      readApi.readSource({ path: "case/overflow.gd", limit: 101 }),
      "BUDGET_EXHAUSTED",
    );
    expect(readLimits).toEqual([400]);
    await readApi.readSource({ path: "case/b.gd", limit: 100 });
    expect(readLimits).toEqual([400, 100]);
    await expectApiError(
      readApi.readSource({ path: "case/c.gd", limit: 1 }),
      "BUDGET_EXHAUSTED",
    );

    const searchApi = createHarness(2, source).api;
    await searchApi.searchSource({ query: "door", maxResults: 60 });
    await expectApiError(
      searchApi.searchSource({ query: "overflow", maxResults: 41 }),
      "BUDGET_EXHAUSTED",
    );
    expect(searchLimits).toEqual([60]);
    await searchApi.searchSource({ query: "receiver", maxResults: 40 });
    expect(searchLimits).toEqual([60, 40]);
    await expectApiError(
      searchApi.searchSource({ query: "extra", maxResults: 1 }),
      "BUDGET_EXHAUSTED",
    );
  });

  it("injects canonical scope and accepts only handles issued by this Session", async () => {
    const { api, context } = createHarness();
    const flow = await completeExperiment(api);
    const foreignHandle: ResourceHandleV1 =
      parseResourceHandleV1("rh_external_1234");

    await expectApiError(
      api.submitProposal(
        proposalFor(flow, { candidateExecutionHandles: [foreignHandle] }),
      ),
      "INVALID_HANDLE",
    );
    await expectApiError(
      api.submitProposal(
        proposalFor(flow, { accessReceiptHandles: [foreignHandle] }),
      ),
      "INVALID_HANDLE",
    );
    await expectApiError(
      api.submitProposal(
        proposalFor(flow, { evidenceEventHandles: [foreignHandle] }),
      ),
      "INVALID_HANDLE",
    );

    const result = await api.submitProposal(proposalFor(flow));
    expect(result.proposal).toMatchObject({
      schemaVersion: 4,
      proposalId: "proposal:v04:api-test",
      runId,
      investigationId,
      capsuleId: context.evidenceCapsule.capsuleId,
      baselineExecutionId: context.baselineExecution.executionId,
      replayExecutionId,
      candidateExecutionIds: [candidateExecutionId],
      comparisonIds: [comparisonId],
      confidence: 0.9876,
    });
    expect(result.proposal).not.toHaveProperty("capsuleHandle");
    expect(result.proposal).not.toHaveProperty("baselineExecutionHandle");

    await expectApiError(
      api.submitProposal(proposalFor(flow)),
      "INVALID_TOOL_FLOW",
    );
  });
});
