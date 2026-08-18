import { createHash } from "node:crypto";

import { PROJECT_ENVIRONMENT_GAME_TOOL_NAMES_V1 } from "@chronorift/agent-protocol";
import {
  PROJECT_CAPABILITY_MODULE_NAMES_V1,
  ProjectAdapterRevisionV1Schema,
  asSha256DigestV1,
} from "@chronorift/domain";
import { describe, expect, it, vi } from "vitest";

import {
  M7_NATURAL_USER_PROMPT_V1,
  M7PairedAgentBudgetFileV1Schema,
  createM7PairedAgentProtocolV1,
  createM7RuntimeResourceMapV1,
  normalizeM7PairedAgentBudgetV1,
  runM7PairedAgentArmOnceV1,
  runM7PairedAgentArmsV1,
  type M7AgentArmIsolationV1,
  type M7PairedAgentArmRequestV1,
  type M7PairedAgentCleanupResultV1,
  type M7PairedAgentInputV1,
  type M7PairedAgentPortV1,
} from "./m7-paired-agent.js";

const digest = (value: string) =>
  asSha256DigestV1(createHash("sha256").update(value).digest("hex"));

const adapterRevision = ProjectAdapterRevisionV1Schema.parse({
  schemaVersion: 1,
  adapterRevisionId: "adapter-revision:m7:generic-patrol-v1",
  adapterId: "adapter:m7:generic-patrol",
  sourceId: `source:v1:${digest("pristine project")}`,
  packageDigest: digest("generic patrol adapter package"),
  manifestDigest: digest("generic patrol adapter manifest"),
  implementationDigest: digest("generic patrol adapter implementation"),
  payloadSchemaDigest: digest("generic patrol adapter payload schemas"),
  sdkDigest: digest("project adapter sdk"),
  bridgeDigest: digest("project adapter bridge"),
  capabilitySet: {
    schemaVersion: 1,
    modules: PROJECT_CAPABILITY_MODULE_NAMES_V1.map((module) => ({
      schemaVersion: 1,
      module,
      status: "implemented" as const,
      protocolVersion: "project-environment-v1",
      limitations: [],
    })),
  },
  conformanceReceiptId: "conformance:m7:generic-patrol-v1",
  contentByteLength: 4096,
  contentFileCount: 4,
});

const surfaces = (runtimeEnabled: boolean) => ({
  chronoriftGameTools: runtimeEnabled,
  publicRuntimeRecordsThroughGameTools: runtimeEnabled,
  projectAdapterPackage: false as const,
  rawGodotExecutable: false as const,
  hiddenAssignmentStore: false as const,
  hiddenMutationOrEvaluator: false as const,
  otherArmPatchOrRecords: false as const,
});

const isolation = (
  arm: "runtime_enabled" | "code_only",
): M7AgentArmIsolationV1 => ({
  schemaVersion: 1,
  arm,
  taskId: `task:m7:${arm}`,
  workspaceHandle: `workspace:m7:${arm}`,
  workspaceInstanceSha256: digest(`${arm} workspace instance`),
  sessionInstanceSha256: digest(`${arm} session instance`),
  cacheInstanceSha256: digest(`${arm} cache instance`),
  sandboxInstanceSha256: digest(`${arm} sandbox instance`),
  sandboxProfileSha256: digest("same sandbox profile"),
  workspaceBaselineSelectedTreeSha256: digest("mutated baseline"),
  readableSurfaces: surfaces(arm === "runtime_enabled"),
});

const pairedInput = (): M7PairedAgentInputV1 => ({
  schemaVersion: 1,
  campaignId: "m7-campaign:0123456789abcdef01234567",
  publicTaskSpecSha256: digest("frozen natural public task"),
  runtimeArmPublicTaskSpecSha256: digest("runtime bootstrap task"),
  codeOnlyArmPublicTaskSpecSha256: digest("code-only bootstrap task"),
  prompt: M7_NATURAL_USER_PROMPT_V1,
  provider: "openai-codex",
  model: "gpt-5.6-luna",
  thinkingLevel: "max",
  agentBudget: {
    schemaVersion: 1,
    attemptsMaximum: 1,
    userTurnsPerAttemptMaximum: 1,
    toolCallsMaximum: 64,
    wallTimeMsMaximum: 900_000,
    taskSandboxNetworkMode: "denied",
    taskCredentialMountCountMaximum: 0,
  },
  baselineSelectedTreeSha256: digest("mutated baseline"),
  commonEnvironmentInstructionsSha256: digest("standard environment appendix"),
  hostModelRuntimeConfigSha256: digest("shared Host model runtime config"),
  codingTools: ["read", "bash", "edit", "write"].map((name) => ({
    schemaVersion: 1 as const,
    family: "coding" as const,
    name,
    definitionSha256: digest(`coding tool ${name}`),
  })),
  sensorFreezeRecordSha256: digest("pre-mutation generic sensor freeze"),
  pristineAdapterRevision: adapterRevision,
  hostAdmittedGameToolNames: [
    PROJECT_ENVIRONMENT_GAME_TOOL_NAMES_V1.capabilities,
    PROJECT_ENVIRONMENT_GAME_TOOL_NAMES_V1.query,
  ],
  runtimeResourceMap: createM7RuntimeResourceMapV1({
    schemaVersion: 1,
    taskId: "task:m7:runtime_enabled",
    baselineBuildId: "build:m7:mutant-baseline",
    baselineSourceId: "source:m7:mutant-baseline",
    launchTargetId: "launch:m7:default",
  }),
  runtimeIsolation: isolation("runtime_enabled"),
  codeOnlyIsolation: isolation("code_only"),
});

const candidatePatch = {
  schemaVersion: 1 as const,
  patch: {
    schemaVersion: 1 as const,
    artifactId: `m6-artifact:${digest("runtime patch bytes")}`,
    rawSha256: digest("runtime patch bytes"),
    byteLength: 123,
  },
  patchIdentity: {
    schemaVersion: 1 as const,
    baselineSelectedTreeSha256: digest("mutated baseline"),
    candidateSelectedTreeSha256: digest("runtime candidate"),
    patchSha256: digest("runtime patch bytes"),
    byteLength: 123,
  },
  admissible: true,
  roundTripVerified: true,
};

const armResult = (
  request: M7PairedAgentArmRequestV1,
  options: {
    readonly status?:
      "completed" | "provider_failure" | "timed_out" | "aborted";
    readonly extraActiveTool?: string;
    readonly withRuntimeCandidate?: boolean;
  } = {},
) => ({
  schemaVersion: 1 as const,
  arm: request.arm,
  attemptOrdinal: 1 as const,
  userTurnCount: 1 as const,
  status: options.status ?? "completed",
  realizedProvider: request.provider,
  realizedModel: request.model,
  realizedThinkingLevel: request.thinkingLevel,
  activeToolNames: [
    ...request.codingTools.map((tool) => tool.name),
    ...request.gameTools.map((tool) => tool.name),
    ...(options.extraActiveTool === undefined ? [] : [options.extraActiveTool]),
  ],
  attemptBindingContentSha256: request.attemptBinding.bindingContentSha256,
  candidatePatch: options.withRuntimeCandidate === true ? candidatePatch : null,
  sourceObservations: [],
  executions: [],
  runtimeUseSummaries: [],
  runtimeEvidenceReceiptSha256: null,
});

const cleanupResult = (
  request: Parameters<M7PairedAgentPortV1["cleanupArm"]>[0],
  proven = true,
): M7PairedAgentCleanupResultV1 => ({
  schemaVersion: 1,
  arm: request.arm,
  attemptBindingContentSha256: request.attemptBindingContentSha256,
  proven,
  receiptSha256: proven ? digest(`${request.arm} cleanup`) : null,
});

describe("M7 paired Agent composition", () => {
  it("normalizes the frozen public budget projection without changing its limits", () => {
    const publicBudget = M7PairedAgentBudgetFileV1Schema.parse({
      attemptsMaximum: 1,
      userTurnsPerAttemptMaximum: 1,
      toolCallsMaximum: 128,
      wallTimeMsMaximum: 900_000,
      taskSandboxNetworkMode: "denied",
      taskCredentialMountCountMaximum: 0,
    });

    expect(normalizeM7PairedAgentBudgetV1(publicBudget)).toEqual({
      schemaVersion: 1,
      ...publicBudget,
    });
    expect(() =>
      M7PairedAgentBudgetFileV1Schema.parse({
        schemaVersion: 1,
        ...publicBudget,
      }),
    ).toThrow();
  });

  it("freezes both admissions without starting an Agent and permits only the explicitly requested phased arm", async () => {
    const runArm = vi.fn(async (request: M7PairedAgentArmRequestV1) =>
      armResult(request),
    );
    const cleanupArm = vi.fn(
      async (request: Parameters<M7PairedAgentPortV1["cleanupArm"]>[0]) =>
        cleanupResult(request),
    );
    const protocol = createM7PairedAgentProtocolV1(pairedInput());

    expect(runArm).not.toHaveBeenCalled();
    expect(cleanupArm).not.toHaveBeenCalled();

    const runtime = await runM7PairedAgentArmOnceV1({
      request: protocol.runtimeRequest,
      port: { runArm, cleanupArm },
    });

    expect(runtime.arm).toBe("runtime_enabled");
    expect(runtime.cleanup.proven).toBe(true);
    expect(runArm).toHaveBeenCalledTimes(1);
    expect(runArm).toHaveBeenLastCalledWith(protocol.runtimeRequest);
    expect(cleanupArm).toHaveBeenCalledTimes(1);

    const codeOnly = await runM7PairedAgentArmOnceV1({
      request: protocol.codeOnlyRequest,
      port: { runArm, cleanupArm },
    });

    expect(codeOnly.arm).toBe("code_only");
    expect(runArm).toHaveBeenCalledTimes(2);
    expect(runArm).toHaveBeenLastCalledWith(protocol.codeOnlyRequest);
    expect(cleanupArm).toHaveBeenCalledTimes(2);
  });

  it("runs byte-identical natural prompts with equal coding surfaces and only the preregistered runtime treatment difference", async () => {
    const events: string[] = [];
    const requests: M7PairedAgentArmRequestV1[] = [];
    const runArm = vi.fn(async (request: M7PairedAgentArmRequestV1) => {
      events.push(`run:${request.arm}`);
      requests.push(request);
      return armResult(request, {
        withRuntimeCandidate: request.arm === "runtime_enabled",
      });
    });
    const cleanupArm = vi.fn(
      async (request: Parameters<M7PairedAgentPortV1["cleanupArm"]>[0]) => {
        events.push(`cleanup:${request.arm}`);
        return cleanupResult(request);
      },
    );
    const port: M7PairedAgentPortV1 = {
      runArm,
      cleanupArm,
    };

    const result = await runM7PairedAgentArmsV1(pairedInput(), port);

    expect(result.status).toBe("both_arms_recorded");
    expect(events).toEqual([
      "run:runtime_enabled",
      "cleanup:runtime_enabled",
      "run:code_only",
      "cleanup:code_only",
    ]);
    expect(requests).toHaveLength(2);
    const runtimeRequest = requests[0];
    const codeOnlyRequest = requests[1];
    expect(runtimeRequest?.arm).toBe("runtime_enabled");
    expect(codeOnlyRequest?.arm).toBe("code_only");
    expect(runtimeRequest?.prompt).toBe(M7_NATURAL_USER_PROMPT_V1);
    expect(codeOnlyRequest?.prompt).toBe(runtimeRequest?.prompt);
    expect(M7_NATURAL_USER_PROMPT_V1).not.toMatch(
      /\b(?:reproduce|verify|rerun|re-run|runtime|game tool)\b/iu,
    );
    expect(codeOnlyRequest?.codingTools).toEqual(runtimeRequest?.codingTools);
    expect(codeOnlyRequest?.provider).toBe(runtimeRequest?.provider);
    expect(codeOnlyRequest?.model).toBe(runtimeRequest?.model);
    expect(codeOnlyRequest?.agentBudget).toEqual(runtimeRequest?.agentBudget);
    expect(codeOnlyRequest?.baselineSelectedTreeSha256).toBe(
      runtimeRequest?.baselineSelectedTreeSha256,
    );
    expect(runtimeRequest?.gameTools.length).toBe(2);
    expect(runtimeRequest?.runtimeAccess).not.toBeNull();
    expect(codeOnlyRequest?.gameTools).toEqual([]);
    expect(codeOnlyRequest?.runtimeAccess).toBeNull();
    expect(codeOnlyRequest?.isolation.readableSurfaces).toEqual(
      surfaces(false),
    );
    expect(codeOnlyRequest?.isolation.workspaceInstanceSha256).not.toBe(
      runtimeRequest?.isolation.workspaceInstanceSha256,
    );
    const codeOnlyBytes = JSON.stringify(codeOnlyRequest);
    expect(codeOnlyBytes).not.toContain(adapterRevision.adapterRevisionId);
    expect(codeOnlyBytes).not.toContain(adapterRevision.packageDigest);
    expect(codeOnlyBytes).not.toContain(candidatePatch.patch.rawSha256);
    expect(result.surfaceEqualityProof).toMatchObject({
      declaredTreatmentDifference: "chronorift_runtime_surface",
      codeOnlyGameToolSetSha256: digest("[]"),
    });
    expect(result.runtimeArm.binding.runtimeSurface).not.toBeNull();
    expect(result.codeOnlyArm?.binding.runtimeSurface).toBeNull();
  });

  it("continues to code-only after a recorded provider failure and never retries either arm", async () => {
    const calls: string[] = [];
    const runArm = vi.fn(async (request: M7PairedAgentArmRequestV1) => {
      calls.push(request.arm);
      return armResult(request, {
        status:
          request.arm === "runtime_enabled" ? "provider_failure" : "completed",
      });
    });
    const cleanupArm = vi.fn(
      async (request: Parameters<M7PairedAgentPortV1["cleanupArm"]>[0]) =>
        cleanupResult(request),
    );
    const port: M7PairedAgentPortV1 = {
      runArm,
      cleanupArm,
    };

    const result = await runM7PairedAgentArmsV1(pairedInput(), port);

    expect(result.status).toBe("both_arms_recorded");
    expect(result.runtimeArm.result?.status).toBe("provider_failure");
    expect(calls).toEqual(["runtime_enabled", "code_only"]);
    expect(runArm).toHaveBeenCalledTimes(2);
    expect(cleanupArm).toHaveBeenCalledTimes(2);
  });

  it("stops at an unproven runtime cleanup barrier", async () => {
    const runArm = vi.fn(async (request: M7PairedAgentArmRequestV1) =>
      armResult(request),
    );
    const cleanupArm = vi.fn(
      async (request: Parameters<M7PairedAgentPortV1["cleanupArm"]>[0]) =>
        cleanupResult(request, request.arm !== "runtime_enabled"),
    );
    const port: M7PairedAgentPortV1 = {
      runArm,
      cleanupArm,
    };

    const result = await runM7PairedAgentArmsV1(pairedInput(), port);

    expect(result.status).toBe("runtime_cleanup_failed");
    expect(result.attemptedOrder).toEqual(["runtime_enabled"]);
    expect(result.codeOnlyArm).toBeNull();
    expect(runArm).toHaveBeenCalledTimes(1);
    expect(cleanupArm).toHaveBeenCalledTimes(1);
  });

  it("records a thrown runtime infrastructure failure, cleans once, and does not retry", async () => {
    const runArm = vi.fn(async () => {
      throw new Error(
        "runner unavailable secret=qwerty path=/host/private/session.jsonl",
      );
    });
    const cleanupArm = vi.fn(
      async (request: Parameters<M7PairedAgentPortV1["cleanupArm"]>[0]) =>
        cleanupResult(request),
    );
    const port: M7PairedAgentPortV1 = {
      runArm,
      cleanupArm,
    };

    const result = await runM7PairedAgentArmsV1(pairedInput(), port);

    expect(result.status).toBe("runtime_infrastructure_failure");
    expect(result.runtimeArm.infrastructureFailureCode).toBe("runner_threw");
    expect(result.runtimeArm.result).toBeNull();
    expect(result.runtimeArm.attemptEvidence).toMatchObject({
      terminalStage: "pi_turn",
      terminalCode: "operation_threw",
      piResultObserved: false,
      piStats: null,
    });
    expect(JSON.stringify(result.runtimeArm.attemptEvidence)).not.toMatch(
      /qwerty|session\.jsonl|host\/private/iu,
    );
    expect(result.codeOnlyArm).toBeNull();
    expect(runArm).toHaveBeenCalledTimes(1);
    expect(cleanupArm).toHaveBeenCalledTimes(1);
  });

  it("rejects a code-only result that reports a runtime-only active tool", async () => {
    const runArm = vi.fn(async (request: M7PairedAgentArmRequestV1) =>
      request.arm === "code_only"
        ? armResult(request, {
            extraActiveTool: PROJECT_ENVIRONMENT_GAME_TOOL_NAMES_V1.query,
          })
        : armResult(request),
    );
    const cleanupArm = vi.fn(
      async (request: Parameters<M7PairedAgentPortV1["cleanupArm"]>[0]) =>
        cleanupResult(request),
    );
    const port: M7PairedAgentPortV1 = {
      runArm,
      cleanupArm,
    };

    const result = await runM7PairedAgentArmsV1(pairedInput(), port);

    expect(result.status).toBe("code_only_infrastructure_failure");
    expect(result.codeOnlyArm?.infrastructureFailureCode).toBe(
      "runner_result_invalid",
    );
    expect(result.codeOnlyArm?.attemptEvidence).toMatchObject({
      terminalStage: "arm_result_validation",
      terminalCode: "result_invalid",
    });
    expect(runArm).toHaveBeenCalledTimes(2);
  });

  it("rejects runtime records attributed to the code-only Session", async () => {
    const runArm = vi.fn(async (request: M7PairedAgentArmRequestV1) => {
      const result = armResult(request);
      return request.arm === "code_only"
        ? {
            ...result,
            executions: [
              {
                schemaVersion: 1,
                executionId: "execution:m7:forbidden-code-only-runtime",
                buildId: "build:m7:forbidden-code-only-runtime",
                sourceSha256: digest("mutated baseline"),
                startedAt: "2026-08-15T00:00:00.000Z",
                endedAt: "2026-08-15T00:00:01.000Z",
                sealed: true,
                coverageComplete: true,
                cleanupProven: true,
                publicSymptomObserved: true,
                publicObservationSha256: digest("forbidden observation"),
              },
            ],
          }
        : result;
    });
    const cleanupArm = vi.fn(
      async (request: Parameters<M7PairedAgentPortV1["cleanupArm"]>[0]) =>
        cleanupResult(request),
    );

    const result = await runM7PairedAgentArmsV1(pairedInput(), {
      runArm,
      cleanupArm,
    });

    expect(result.status).toBe("code_only_infrastructure_failure");
    expect(result.codeOnlyArm?.infrastructureFailureCode).toBe(
      "runner_result_invalid",
    );
  });

  it("rejects shared arm workspace/session/cache/sandbox identities before either attempt", async () => {
    const input = pairedInput();
    const invalid = {
      ...input,
      codeOnlyIsolation: {
        ...input.codeOnlyIsolation,
        sessionInstanceSha256: input.runtimeIsolation.sessionInstanceSha256,
      },
    };
    const runArm = vi.fn();
    const cleanupArm = vi.fn();
    const port: M7PairedAgentPortV1 = { runArm, cleanupArm };

    await expect(runM7PairedAgentArmsV1(invalid, port)).rejects.toThrow(
      /isolated/iu,
    );
    expect(runArm).not.toHaveBeenCalled();
    expect(cleanupArm).not.toHaveBeenCalled();
  });
});
