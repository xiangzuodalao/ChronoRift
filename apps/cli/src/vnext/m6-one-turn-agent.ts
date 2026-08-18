import {
  PROJECT_ENVIRONMENT_GAME_TOOL_DEFINITIONS_V1,
  type ProjectEnvironmentGameToolCapabilityV1,
  type ProjectEnvironmentGameToolNameV1,
} from "@chronorift/agent-protocol";
import {
  M6AdapterBuildCompatibilityReceiptV1Schema,
  ProjectAdapterRevisionV1Schema,
  Sha256DigestV1Schema,
  type M6AdapterBuildCompatibilityLineageV1,
  type M6AdapterBuildCompatibilityReceiptV1,
  type ProjectAdapterRevisionV1,
  type ProjectCapabilityModuleNameV1,
  type Sha256DigestV1,
  type TaskId,
  type VNextBuildV1,
  type WorkspaceId,
} from "@chronorift/domain";
import { contentHash } from "@chronorift/json-artifacts";
import { z } from "zod";

import {
  ExternalHiddenFixPatchIdentityV1Schema,
  ExternalHiddenFixPatchReferenceV1Schema,
  type ExternalHiddenFixPatchIdentityV1,
  type ExternalHiddenFixPatchReferenceV1,
} from "./external-hidden-fix.js";
import {
  ExternalHiddenFixHostSourceObservationV1Schema,
  ExternalHiddenFixPublicExecutionEvidenceV1Schema,
  ExternalHiddenFixWorkflowInputV1Schema,
  type ExternalHiddenFixHostSourceObservationV1,
  type ExternalHiddenFixPublicExecutionEvidenceV1,
  type ExternalHiddenFixWorkflowInputV1,
} from "./external-hidden-fix-workflow.js";
import { createM6AdapterBuildCompatibilityLineageV1 } from "./m6-adapter-build-compatibility.js";
import {
  prepareM6ExactGodotBuildV1,
  type PreparedM6ExactGodotBuildV1,
} from "./m6-exact-godot-build.js";

export interface M6AdmittedGameToolV1 {
  readonly schemaVersion: 1;
  readonly name: ProjectEnvironmentGameToolNameV1;
  readonly capability: ProjectEnvironmentGameToolCapabilityV1;
  readonly availabilityModule: ProjectCapabilityModuleNameV1 | null;
  readonly adapterModuleStatus:
    | "implemented"
    | "unsupported"
    | "unavailable_by_policy"
    | "unavailable_by_environment"
    | "degraded"
    | null;
  readonly adapterProtocolVersion: string | null;
}

/**
 * Intersects Host admission with the protocol tools backed by the frozen,
 * schema-valid AdapterRevision capability declaration. The result size is
 * deliberately derived rather than fixed by M6.
 */
export function createM6AdmittedGameToolsV1(input: {
  readonly adapterRevision: unknown;
  readonly hostAdmittedToolNames: readonly string[];
}): readonly M6AdmittedGameToolV1[] {
  const adapterRevision = ProjectAdapterRevisionV1Schema.parse(
    input.adapterRevision,
  );
  if (
    input.hostAdmittedToolNames.length === 0 ||
    new Set(input.hostAdmittedToolNames).size !==
      input.hostAdmittedToolNames.length
  ) {
    throw new TypeError(
      "M6 Host-admitted game tool names must be nonempty and unique",
    );
  }
  const catalogByName = new Map(
    PROJECT_ENVIRONMENT_GAME_TOOL_DEFINITIONS_V1.map((tool) => [
      tool.name,
      tool,
    ]),
  );
  for (const name of input.hostAdmittedToolNames) {
    if (!catalogByName.has(name as ProjectEnvironmentGameToolNameV1)) {
      throw new TypeError(`M6 Host admitted an unknown game tool: ${name}`);
    }
  }
  const admitted = new Set(input.hostAdmittedToolNames);
  const modules = new Map(
    adapterRevision.capabilitySet.modules.map((module) => [
      module.module,
      module,
    ]),
  );
  return Object.freeze(
    PROJECT_ENVIRONMENT_GAME_TOOL_DEFINITIONS_V1.filter((tool) =>
      admitted.has(tool.name),
    ).map((tool) => {
      const module =
        tool.availabilityModule === null
          ? undefined
          : modules.get(tool.availabilityModule);
      if (tool.availabilityModule !== null && module === undefined) {
        throw new TypeError(
          `AdapterRevision omitted ${tool.availabilityModule} for ${tool.name}`,
        );
      }
      return Object.freeze({
        schemaVersion: 1 as const,
        name: tool.name,
        capability: tool.capability,
        availabilityModule: tool.availabilityModule,
        adapterModuleStatus: module?.status ?? null,
        adapterProtocolVersion: module?.protocolVersion ?? null,
      });
    }),
  );
}

export interface M6AgentTurnRequestV1 {
  readonly schemaVersion: 1;
  readonly prompt: string;
  readonly workspaceDirectory: string;
  readonly baselineBuild: VNextBuildV1;
  readonly pristineAdapterRevision: ProjectAdapterRevisionV1;
  readonly codingToolNames: readonly string[];
  readonly gameTools: readonly M6AdmittedGameToolV1[];
}

export interface M6AgentTurnResultV1 {
  readonly schemaVersion: 1;
  readonly status: "completed" | "provider_failure" | "timed_out" | "aborted";
  readonly activeToolNames: readonly string[];
  /** Host source observations emitted after coding tools or at game Build freeze. */
  readonly sourceObservations: readonly ExternalHiddenFixHostSourceObservationV1[];
  /** Public task execution records only; never hidden evaluator records. */
  readonly executions: readonly ExternalHiddenFixPublicExecutionEvidenceV1[];
}

const m6AgentTurnResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    status: z.enum(["completed", "provider_failure", "timed_out", "aborted"]),
    activeToolNames: z.array(z.string().min(1).max(256)).max(512),
    sourceObservations: z
      .array(ExternalHiddenFixHostSourceObservationV1Schema)
      .max(1_000),
    executions: z
      .array(ExternalHiddenFixPublicExecutionEvidenceV1Schema)
      .max(1_000),
  })
  .strict();

const frozenPatchResultSchema = z
  .object({
    patch: ExternalHiddenFixPatchReferenceV1Schema,
    patchIdentity: ExternalHiddenFixPatchIdentityV1Schema,
    admissible: z.boolean(),
    roundTripVerified: z.boolean(),
  })
  .strict();

const cleanupResultSchema = z
  .object({
    proven: z.boolean(),
    receiptSha256: Sha256DigestV1Schema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.proven && value.receiptSha256 === null) {
      context.addIssue({
        code: "custom",
        path: ["receiptSha256"],
        message: "proven M6 Task cleanup requires its durable receipt",
      });
    }
  });

export interface M6OneTurnAgentPortV1 {
  runCompatibility(input: {
    readonly schemaVersion: 1;
    readonly phase: "assignment_baseline" | "candidate";
    readonly lineage: M6AdapterBuildCompatibilityLineageV1;
  }): Promise<M6AdapterBuildCompatibilityReceiptV1>;
  runAgentTurn(input: M6AgentTurnRequestV1): Promise<M6AgentTurnResultV1>;
  freezePatch(input: {
    readonly schemaVersion: 1;
    readonly baselineBuild: VNextBuildV1;
    readonly candidateBuild: VNextBuildV1;
  }): Promise<{
    readonly patch: ExternalHiddenFixPatchReferenceV1;
    readonly patchIdentity: ExternalHiddenFixPatchIdentityV1;
    readonly admissible: boolean;
    readonly roundTripVerified: boolean;
  }>;
  cleanupTask(): Promise<{
    readonly proven: boolean;
    readonly receiptSha256: Sha256DigestV1 | null;
  }>;
}

interface M6OneTurnCommonResultV1 {
  readonly schemaVersion: 1;
  readonly baseline: PreparedM6ExactGodotBuildV1;
  readonly baselineCompatibility: M6AdapterBuildCompatibilityReceiptV1;
  readonly admittedGameTools: readonly M6AdmittedGameToolV1[];
  readonly agentLoopStatus: M6AgentTurnResultV1["status"];
  readonly agentTurnCount: 1;
  readonly taskCleanupProven: boolean;
  readonly taskCleanupReceiptSha256: Sha256DigestV1 | null;
}

export interface M6OneTurnAgentFailedResultV1 extends M6OneTurnCommonResultV1 {
  readonly status: "agent_failed";
  readonly candidate: null;
  readonly workflowInput: null;
}

export interface M6OneTurnNoCandidateResultV1 extends M6OneTurnCommonResultV1 {
  readonly status: "no_candidate";
  readonly agentLoopStatus: "completed";
  readonly reason: "source_unchanged";
  readonly candidate: null;
  readonly workflowInput: null;
}

export interface M6OneTurnWorkflowReadyResultV1 extends M6OneTurnCommonResultV1 {
  readonly status: "workflow_ready";
  readonly agentLoopStatus: "completed";
  readonly candidate: PreparedM6ExactGodotBuildV1;
  readonly candidateCompatibility: M6AdapterBuildCompatibilityReceiptV1;
  readonly patch: ExternalHiddenFixPatchReferenceV1;
  readonly patchIdentity: ExternalHiddenFixPatchIdentityV1;
  readonly workflowInput: ExternalHiddenFixWorkflowInputV1;
}

export type M6OneTurnAgentResultV1 =
  | M6OneTurnAgentFailedResultV1
  | M6OneTurnNoCandidateResultV1
  | M6OneTurnWorkflowReadyResultV1;

const uniqueToolNames = (
  label: string,
  values: readonly string[],
): string[] => {
  const parsed = values.map((value) => {
    const name = value.trim();
    if (name.length === 0 || name.length > 256) {
      throw new TypeError(`${label} contains an invalid tool name`);
    }
    return name;
  });
  if (new Set(parsed).size !== parsed.length) {
    throw new TypeError(`${label} contains duplicate tool names`);
  }
  return parsed;
};

const sameSet = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((entry) => right.includes(entry));

const assertCompatibility = (
  untrusted: M6AdapterBuildCompatibilityReceiptV1,
  lineage: M6AdapterBuildCompatibilityLineageV1,
): M6AdapterBuildCompatibilityReceiptV1 => {
  const receipt = M6AdapterBuildCompatibilityReceiptV1Schema.parse(untrusted);
  if (
    receipt.outcome !== "compatible" ||
    contentHash(receipt.lineage) !== contentHash(lineage)
  ) {
    throw new TypeError(
      "M6 exact Build did not receive a compatible receipt for its own lineage",
    );
  }
  return receipt;
};

const sourceObservation = (input: {
  readonly boundary:
    "initial_materialization" | "game_build_freeze" | "patch_freeze";
  readonly build: VNextBuildV1;
  readonly observedAt: string;
}): ExternalHiddenFixHostSourceObservationV1 =>
  ExternalHiddenFixHostSourceObservationV1Schema.parse({
    schemaVersion: 1,
    boundary: input.boundary,
    sourceSha256: input.build.sourceHash,
    buildId:
      input.boundary === "game_build_freeze" ? input.build.buildId : null,
    observedAt: input.observedAt,
  });

const buildInput = (input: M6OneTurnAgentRequestV1, now: string) => ({
  taskId: input.taskId,
  workspaceId: input.workspaceId,
  workspaceDirectory: input.workspaceDirectory,
  baselineSourceHash: input.baselineSourceHash,
  adapterRevision: input.pristineAdapterRevision,
  toolchainReceiptId: input.toolchainReceiptId,
  toolchainArtifactDigest: input.toolchainArtifactDigest,
  runtimeIdentity: input.runtimeIdentity,
  policyProfileDigest: input.policyProfileDigest,
  now,
});

export interface M6OneTurnAgentRequestV1 {
  readonly assignmentId: string;
  readonly taskId: TaskId;
  readonly workspaceId: WorkspaceId;
  readonly workspaceDirectory: string;
  readonly baselineSourceHash: Sha256DigestV1;
  readonly pristineAdapterRevision: unknown;
  readonly toolchainReceiptId: string;
  readonly toolchainArtifactDigest: Sha256DigestV1;
  readonly runtimeIdentity: unknown;
  readonly policyProfileDigest: Sha256DigestV1;
  readonly hostCodingToolNames: readonly string[];
  readonly hostAdmittedGameToolNames: readonly string[];
  readonly prompt: string;
  readonly now?: (() => string) | undefined;
}

/**
 * Runs one formal Agent turn with no retry path. Compatibility is Host
 * admission for the baseline and final candidate only. Public runtime
 * observations and reruns come exclusively from game tools used during the
 * Agent turn; the Harness does not synthesize them before or after that turn.
 * This seam never invokes or reads a hidden evaluator. Ordering means only
 * what Host-observed tool boundaries can establish and does not claim to see
 * edit/run/revert inside one coding-tool invocation.
 */
export async function runM6OneTurnAgentV1(
  input: M6OneTurnAgentRequestV1,
  port: M6OneTurnAgentPortV1,
): Promise<M6OneTurnAgentResultV1> {
  if (input.prompt.trim().length === 0) {
    throw new TypeError("M6 Agent prompt must not be empty");
  }
  const now = input.now ?? (() => new Date().toISOString());
  const adapterRevision = ProjectAdapterRevisionV1Schema.parse(
    input.pristineAdapterRevision,
  );
  const codingToolNames = uniqueToolNames(
    "M6 Host coding tools",
    input.hostCodingToolNames,
  );
  if (codingToolNames.length === 0) {
    throw new TypeError("M6 Agent requires admitted coding tools");
  }
  const gameTools = createM6AdmittedGameToolsV1({
    adapterRevision,
    hostAdmittedToolNames: input.hostAdmittedGameToolNames,
  });
  const expectedToolNames = [
    ...codingToolNames,
    ...gameTools.map((tool) => tool.name),
  ];
  if (new Set(expectedToolNames).size !== expectedToolNames.length) {
    throw new TypeError("M6 coding and game tool names overlap");
  }

  let cleanupCalled = false;
  const cleanup = async (): Promise<z.infer<typeof cleanupResultSchema>> => {
    if (cleanupCalled) {
      throw new TypeError("M6 task cleanup was requested more than once");
    }
    cleanupCalled = true;
    return cleanupResultSchema.parse(await port.cleanupTask());
  };

  try {
    const baseline = await prepareM6ExactGodotBuildV1(buildInput(input, now()));
    if (baseline.build.sourceHash !== input.baselineSourceHash) {
      throw new TypeError(
        "M6 assignment workspace does not match its frozen mutated baseline",
      );
    }
    const sourceObservations: ExternalHiddenFixHostSourceObservationV1[] = [
      sourceObservation({
        boundary: "initial_materialization",
        build: baseline.build,
        observedAt: now(),
      }),
      sourceObservation({
        boundary: "game_build_freeze",
        build: baseline.build,
        observedAt: now(),
      }),
    ];
    const baselineLineage = createM6AdapterBuildCompatibilityLineageV1({
      adapterRevision,
      build: baseline.build,
      baselineSourceHash: input.baselineSourceHash,
      buildRole: "assignment_baseline",
      toolchainReceiptId: input.toolchainReceiptId,
      toolchainArtifactDigest: input.toolchainArtifactDigest,
    });
    const baselineCompatibility = assertCompatibility(
      await port.runCompatibility({
        schemaVersion: 1,
        phase: "assignment_baseline",
        lineage: baselineLineage,
      }),
      baselineLineage,
    );
    const agent = m6AgentTurnResultSchema.parse(
      await port.runAgentTurn({
        schemaVersion: 1,
        prompt: input.prompt,
        workspaceDirectory: input.workspaceDirectory,
        baselineBuild: baseline.build,
        pristineAdapterRevision: adapterRevision,
        codingToolNames,
        gameTools,
      }),
    );
    const activeToolNames = uniqueToolNames(
      "M6 Agent active tools",
      agent.activeToolNames,
    );
    if (!sameSet(activeToolNames, expectedToolNames)) {
      throw new TypeError(
        "M6 Agent did not receive exactly the Host-admitted coding and Adapter-backed game tools",
      );
    }
    const agentObservations = agent.sourceObservations.map((observation) => {
      const parsed =
        ExternalHiddenFixHostSourceObservationV1Schema.parse(observation);
      if (
        parsed.boundary !== "coding_tool_return" &&
        parsed.boundary !== "game_build_freeze"
      ) {
        throw new TypeError(
          "M6 Agent turn may report source identity only at coding-tool returns or game Build-freeze boundaries",
        );
      }
      return parsed;
    });
    const agentExecutions = agent.executions.map((execution) =>
      ExternalHiddenFixPublicExecutionEvidenceV1Schema.parse(execution),
    );
    sourceObservations.push(...agentObservations);
    const executions = [...agentExecutions];

    if (agent.status !== "completed") {
      const taskCleanup = await cleanup();
      return Object.freeze({
        schemaVersion: 1,
        status: "agent_failed",
        baseline,
        baselineCompatibility,
        admittedGameTools: gameTools,
        agentLoopStatus: agent.status,
        agentTurnCount: 1,
        taskCleanupProven: taskCleanup.proven,
        taskCleanupReceiptSha256: taskCleanup.receiptSha256,
        candidate: null,
        workflowInput: null,
      });
    }

    const candidate = await prepareM6ExactGodotBuildV1(
      buildInput(input, now()),
    );
    if (candidate.build.sourceHash === baseline.build.sourceHash) {
      const taskCleanup = await cleanup();
      return Object.freeze({
        schemaVersion: 1,
        status: "no_candidate",
        reason: "source_unchanged",
        baseline,
        baselineCompatibility,
        admittedGameTools: gameTools,
        agentLoopStatus: "completed",
        agentTurnCount: 1,
        taskCleanupProven: taskCleanup.proven,
        taskCleanupReceiptSha256: taskCleanup.receiptSha256,
        candidate: null,
        workflowInput: null,
      });
    }
    const candidateLineage = createM6AdapterBuildCompatibilityLineageV1({
      adapterRevision,
      build: candidate.build,
      baselineSourceHash: input.baselineSourceHash,
      buildRole: "candidate",
      toolchainReceiptId: input.toolchainReceiptId,
      toolchainArtifactDigest: input.toolchainArtifactDigest,
    });
    const candidateCompatibility = assertCompatibility(
      await port.runCompatibility({
        schemaVersion: 1,
        phase: "candidate",
        lineage: candidateLineage,
      }),
      candidateLineage,
    );
    const frozenPatch = frozenPatchResultSchema.parse(
      await port.freezePatch({
        schemaVersion: 1,
        baselineBuild: baseline.build,
        candidateBuild: candidate.build,
      }),
    );
    const patchIdentity = ExternalHiddenFixPatchIdentityV1Schema.parse(
      frozenPatch.patchIdentity,
    );
    if (
      patchIdentity.baselineSelectedTreeSha256 !== baseline.build.sourceHash ||
      patchIdentity.candidateSelectedTreeSha256 !== candidate.build.sourceHash
    ) {
      throw new TypeError(
        "M6 frozen patch crossed its exact baseline or candidate tree",
      );
    }
    if (
      frozenPatch.patch.rawSha256 !== patchIdentity.patchSha256 ||
      frozenPatch.patch.byteLength !== patchIdentity.byteLength
    ) {
      throw new TypeError(
        "M6 patch artifact reference does not match the frozen patch identity",
      );
    }
    const patchObservedAt = now();
    sourceObservations.push(
      sourceObservation({
        boundary: "patch_freeze",
        build: candidate.build,
        observedAt: patchObservedAt,
      }),
    );
    const taskCleanup = await cleanup();
    const workflowInput = ExternalHiddenFixWorkflowInputV1Schema.parse({
      schemaVersion: 1,
      assignmentId: input.assignmentId,
      agentTurnCount: 1,
      agentLoopStatus: agent.status,
      baselineSelectedTreeSha256: baseline.build.sourceHash,
      patchIdentity,
      patchObservedAt,
      patchAdmissible: frozenPatch.admissible,
      patchRoundTripVerified: frozenPatch.roundTripVerified,
      sourceObservations,
      executions,
      taskCleanupProven: taskCleanup.proven,
    });
    return Object.freeze({
      schemaVersion: 1,
      status: "workflow_ready",
      baseline,
      baselineCompatibility,
      admittedGameTools: gameTools,
      agentLoopStatus: "completed",
      agentTurnCount: 1,
      taskCleanupProven: taskCleanup.proven,
      taskCleanupReceiptSha256: taskCleanup.receiptSha256,
      candidate,
      candidateCompatibility,
      patch: frozenPatch.patch,
      patchIdentity,
      workflowInput,
    });
  } catch (error) {
    if (!cleanupCalled) {
      try {
        await cleanup();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "M6 one-turn orchestration and cleanup both failed",
        );
      }
    }
    throw error;
  }
}
