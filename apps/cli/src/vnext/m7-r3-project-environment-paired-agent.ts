import { createHash, randomUUID } from "node:crypto";
import { lstat, readdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import {
  AdapterCompatibilityReceiptIdSchema,
  BuildIdSchema,
  ExecutionIdSchema,
  JsonValueSchema,
  M6AdapterBuildCompatibilityReceiptV1Schema,
  ProjectAdapterRevisionIdSchema,
  ProjectAdapterRevisionV1Schema,
  ProjectEnvironmentRuntimeObservationReceiptV1Schema,
  RuntimeIdSchema,
  Sha256DigestV1Schema,
  SourceIdSchema,
  TaskIdSchema,
  asSha256DigestV1,
  asTaskId,
  projectRuntimeCleanupCompleteV1,
  type JsonValue,
  type ProjectEnvironmentRuntimeObservationReceiptV1,
  type ProjectAdapterRevisionV1,
  type Sha256DigestV1,
} from "@chronorift/domain";
import { canonicalJson } from "@chronorift/json-artifacts";
import {
  VNEXT_ENVIRONMENT_APPENDIX,
  createProjectEnvironmentGameToolDefinitions,
  createProjectEnvironmentToolCallAdmissionV1,
  createVNextCodingToolDefinitions,
  runVNextPiTurnWithSdk,
  type ProjectEnvironmentGameToolPort,
  type ProjectEnvironmentGameToolPortRequestV1,
  type RunVNextPiSdkTurnOptions,
} from "@chronorift/pi-harness";
import { z } from "zod";

import { collectCandidateGodotSourceV1 } from "./candidate-godot-build.js";
import {
  SandboxCleanupReceiptV1Schema,
  type SandboxExecutionRequestV1,
} from "./contracts.js";
import {
  ExternalHiddenFixHostSourceObservationV1Schema,
  ExternalHiddenFixPublicExecutionEvidenceV1Schema,
  type ExternalHiddenFixHostSourceObservationV1,
  type ExternalHiddenFixPublicExecutionEvidenceV1,
} from "./external-hidden-fix-workflow.js";
import {
  ExternalHiddenFixPatchIdentityV1Schema,
  ExternalHiddenFixPatchReferenceV1Schema,
} from "./external-hidden-fix.js";
import type { ExternalHiddenFixEvaluatorHeadroomObserverV1 } from "./external-hidden-fix-evaluator.js";
import {
  createM7CodingToolSurfaceV1,
  type M7AgentGameToolExchangeV1,
  type M7ArmPatchHandoffV1,
} from "./m7-project-environment-paired-agent.js";
import {
  M7AgentAttemptPiStatsV1Schema,
  createM7AgentVisibleGameToolExchangeHashV1,
  type M7AgentArmIsolationV1,
  type M7AgentAttemptCleanupEvidenceV1,
  type M7AgentAttemptEvidenceStageV1,
  type M7AgentAttemptPiStatsV1,
  type M7CodingToolSurfaceEntryV1,
  type M7PairedAgentCleanupResultV1,
  type M7RuntimeResourceMapV1,
} from "./m7-paired-agent.js";
import {
  M7PatrolTrajectoryClassifierConfigV1Schema,
  M7R3PatrolTrajectoryCaseSpecV1Schema,
  createM7R3PatrolTrajectoryExecutionSummaryV1,
  type M7PatrolTrajectoryClassifierConfigV1,
  type M7R3PatrolTrajectoryCaseSpecV1,
  type M7R3PatrolTrajectoryExecutionSummaryV1,
} from "./m7-patrol-trajectory.js";
import {
  M7R3AgentDeliveryTraceV1Schema,
  createM7R3AgentDeliveryTrackerV1,
  type M7R3AgentDeliveryTraceV1,
  type M7R3AgentDeliveryTrackerV1,
} from "./m7-r3-agent-delivery.js";
import {
  M7R3PairedAgentArmRequestV1Schema,
  createM7R3AgentAttemptEvidenceSidecarV1,
  createM7R3NeutralRuntimeResourceAppendixV1,
  createM7R3PairedAgentArmResultV1,
  runM7R3PairedAgentArmOnceV1,
  type M7R3AgentAttemptEvidenceSidecarV1,
  type M7R3PairedAgentArmRequestV1,
  type M7R3PairedAgentArmResultV1,
  type M7R3PairedAgentAttemptRecordV1,
  type M7R3PairedAgentPortV1,
} from "./m7-r3-paired-agent.js";
import { classifyM7R3EarliestAgentVisibleTrajectoryPrefixV1 } from "./m7-r3-trajectory-delivery.js";
import { extractTaskPatch, type ExtractedTaskPatch } from "./patch-handoff.js";
import { SandboxPiCodingToolPort } from "./pi-coding-tool-port.js";
import {
  SANDBOX_TASK_STORAGE_MINIMUM_HEADROOM_BYTES_V1,
  SANDBOX_TASK_STORAGE_MINIMUM_HEADROOM_INODES_V1,
  type SandboxTaskStorageHeadroomV1,
} from "./sandbox-preflight.js";
import type { TaskSandboxBrokerV1 } from "./sandbox-broker.js";
import { selectedTreeSha256 } from "./selected-tree.js";

const MAX_SOURCE_OBSERVATIONS = 1_000;

const digestJson = (value: unknown): Sha256DigestV1 =>
  asSha256DigestV1(
    createHash("sha256")
      .update(canonicalJson(JsonValueSchema.parse(value)))
      .digest("hex"),
  );

export const M7_R3_NEUTRAL_ENVIRONMENT_INSTRUCTIONS_SHA256_V1 = digestJson(
  VNEXT_ENVIRONMENT_APPENDIX,
);

export const createM7R3CodingToolSurfaceV1 = createM7CodingToolSurfaceV1;

const sameSet = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((entry) => right.includes(entry));

const sameJson = (left: unknown, right: unknown): boolean =>
  canonicalJson(JsonValueSchema.parse(left)) ===
  canonicalJson(JsonValueSchema.parse(right));

const pathWithinOrEqual = (parent: string, candidate: string): boolean => {
  const difference = relative(parent, candidate);
  return (
    difference === "" ||
    (difference !== ".." &&
      !difference.startsWith(`..${sep}`) &&
      !isAbsolute(difference))
  );
};

const canonicalDirectory = async (
  inputPath: string,
  label: string,
  requireEmpty: boolean,
): Promise<string> => {
  const absolute = resolve(inputPath);
  if (inputPath !== absolute) {
    throw new TypeError(`${label} must be a normalized absolute path`);
  }
  const metadata = await lstat(absolute);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new TypeError(`${label} must be a real directory`);
  }
  if ((await realpath(absolute)) !== absolute) {
    throw new TypeError(`${label} must contain no symbolic-link component`);
  }
  if (requireEmpty && (await readdir(absolute)).length !== 0) {
    throw new TypeError(`${label} must be fresh and empty`);
  }
  return absolute;
};

const assertDisjointDirectories = (
  entries: readonly { readonly label: string; readonly path: string }[],
): void => {
  for (const [index, left] of entries.entries()) {
    for (const right of entries.slice(index + 1)) {
      if (
        pathWithinOrEqual(left.path, right.path) ||
        pathWithinOrEqual(right.path, left.path)
      ) {
        throw new TypeError(
          `${left.label} and ${right.label} must be disjoint arm resources`,
        );
      }
    }
  }
};

const positiveSafeIntegerSchema = z
  .number()
  .int()
  .min(1)
  .max(Number.MAX_SAFE_INTEGER);
const nonnegativeSafeIntegerSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
const timestampSchema = z.string().datetime({ offset: true });
const toolCallIdSchema = z.string().min(1).max(256);
const gameToolNameSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^game_[a-z0-9_]+$/u);
const hostIdentitySchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:+-]*$/u);

export const M7R3TaskStorageHeadroomV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    availableBytes: nonnegativeSafeIntegerSchema,
    availableInodes: nonnegativeSafeIntegerSchema,
    requiredAvailableBytes: z.literal(
      SANDBOX_TASK_STORAGE_MINIMUM_HEADROOM_BYTES_V1,
    ),
    requiredAvailableInodes: z.literal(
      SANDBOX_TASK_STORAGE_MINIMUM_HEADROOM_INODES_V1,
    ),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.availableBytes < value.requiredAvailableBytes) {
      context.addIssue({
        code: "custom",
        path: ["availableBytes"],
        message: "Task-storage byte headroom is below its required bound",
      });
    }
    if (value.availableInodes < value.requiredAvailableInodes) {
      context.addIssue({
        code: "custom",
        path: ["availableInodes"],
        message: "Task-storage inode headroom is below its required bound",
      });
    }
  });

const taskStorageHeadroomReceiptBasisSchema = z
  .object({
    schemaVersion: z.literal(1),
    recordKind: z.literal("m7-r3-task-storage-headroom"),
    campaignId: hostIdentitySchema,
    portfolioId: hostIdentitySchema,
    caseId: hostIdentitySchema,
    pairedCaseContractContentSha256: Sha256DigestV1Schema,
    arm: z.enum(["runtime_enabled", "code_only"]),
    taskId: TaskIdSchema,
    attemptBindingContentSha256: Sha256DigestV1Schema,
    boundary: z.literal("pre_pi"),
    availableBytes: nonnegativeSafeIntegerSchema,
    availableInodes: nonnegativeSafeIntegerSchema,
    requiredAvailableBytes: z.literal(
      SANDBOX_TASK_STORAGE_MINIMUM_HEADROOM_BYTES_V1,
    ),
    requiredAvailableInodes: z.literal(
      SANDBOX_TASK_STORAGE_MINIMUM_HEADROOM_INODES_V1,
    ),
    observedAt: timestampSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.availableBytes < value.requiredAvailableBytes) {
      context.addIssue({
        code: "custom",
        path: ["availableBytes"],
        message: "Task-storage byte headroom is below its required bound",
      });
    }
    if (value.availableInodes < value.requiredAvailableInodes) {
      context.addIssue({
        code: "custom",
        path: ["availableInodes"],
        message: "Task-storage inode headroom is below its required bound",
      });
    }
  });

export const M7R3TaskStorageHeadroomReceiptV1Schema =
  taskStorageHeadroomReceiptBasisSchema
    .extend({ recordContentSha256: Sha256DigestV1Schema })
    .strict()
    .superRefine((value, context) => {
      const { recordContentSha256, ...basis } = value;
      if (recordContentSha256 !== digestJson(basis)) {
        context.addIssue({
          code: "custom",
          path: ["recordContentSha256"],
          message: "R3 task-storage headroom receipt hash does not match",
        });
      }
    });
export type M7R3TaskStorageHeadroomReceiptV1 = z.infer<
  typeof M7R3TaskStorageHeadroomReceiptV1Schema
>;

export const createM7R3TaskStorageHeadroomReceiptV1 = (
  input: Omit<
    z.input<typeof taskStorageHeadroomReceiptBasisSchema>,
    "schemaVersion" | "recordKind" | "boundary"
  >,
): M7R3TaskStorageHeadroomReceiptV1 => {
  const basis = taskStorageHeadroomReceiptBasisSchema.parse({
    schemaVersion: 1,
    recordKind: "m7-r3-task-storage-headroom",
    boundary: "pre_pi",
    ...input,
  });
  return Object.freeze(
    M7R3TaskStorageHeadroomReceiptV1Schema.parse({
      ...basis,
      recordContentSha256: digestJson(basis),
    }),
  );
};

const evaluatorHeadroomReceiptBasisSchema = z
  .object({
    schemaVersion: z.literal(1),
    recordKind: z.literal("m7-r3-evaluator-headroom"),
    campaignId: hostIdentitySchema,
    portfolioId: hostIdentitySchema,
    caseId: hostIdentitySchema,
    pairedCaseContractContentSha256: Sha256DigestV1Schema,
    arm: z.enum(["runtime_enabled", "code_only"]),
    taskId: TaskIdSchema,
    attemptBindingContentSha256: Sha256DigestV1Schema,
    boundary: z.literal("evaluator_pre_run"),
    runOrdinal: positiveSafeIntegerSchema.max(1_000),
    taskStorage: M7R3TaskStorageHeadroomV1Schema,
    evaluatorStorage: M7R3TaskStorageHeadroomV1Schema,
    observedAt: timestampSchema,
  })
  .strict();

export const M7R3EvaluatorHeadroomReceiptV1Schema =
  evaluatorHeadroomReceiptBasisSchema
    .extend({ recordContentSha256: Sha256DigestV1Schema })
    .strict()
    .superRefine((value, context) => {
      const { recordContentSha256, ...basis } = value;
      if (recordContentSha256 !== digestJson(basis)) {
        context.addIssue({
          code: "custom",
          path: ["recordContentSha256"],
          message: "R3 evaluator headroom receipt hash does not match",
        });
      }
    });
export type M7R3EvaluatorHeadroomReceiptV1 = z.infer<
  typeof M7R3EvaluatorHeadroomReceiptV1Schema
>;

export const createM7R3EvaluatorHeadroomReceiptV1 = (
  input: Omit<
    z.input<typeof evaluatorHeadroomReceiptBasisSchema>,
    "schemaVersion" | "recordKind" | "boundary"
  >,
): M7R3EvaluatorHeadroomReceiptV1 => {
  const basis = evaluatorHeadroomReceiptBasisSchema.parse({
    schemaVersion: 1,
    recordKind: "m7-r3-evaluator-headroom",
    boundary: "evaluator_pre_run",
    ...input,
  });
  return Object.freeze(
    M7R3EvaluatorHeadroomReceiptV1Schema.parse({
      ...basis,
      recordContentSha256: digestJson(basis),
    }),
  );
};

const asRecord = (
  value: JsonValue,
): Readonly<Record<string, JsonValue>> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value
    : null;

const jsonRoundTrip = (value: unknown, label: string): JsonValue => {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new TypeError(`${label} is undefined`);
    return JsonValueSchema.parse(JSON.parse(encoded));
  } catch (error) {
    throw new TypeError(`${label} is not a JSON-roundtrip value`, {
      cause: error,
    });
  }
};

const trajectoryLineageSchema = z
  .object({
    taskId: TaskIdSchema,
    executionId: ExecutionIdSchema,
    runtimeId: RuntimeIdSchema,
    buildId: BuildIdSchema,
    sourceId: SourceIdSchema,
    sourceSha256: Sha256DigestV1Schema,
    adapterRevisionId: ProjectAdapterRevisionIdSchema,
    adapterCompatibilityReceiptId: AdapterCompatibilityReceiptIdSchema,
    adapterCompatibilityReceiptSha256: Sha256DigestV1Schema,
  })
  .strict();

const trajectoryLossSchema = z
  .object({
    historyLossObserved: z.boolean(),
    droppedRecordCount: nonnegativeSafeIntegerSchema,
    overwrittenRecordCount: nonnegativeSafeIntegerSchema,
    unavailableHistoryObserved: z.boolean(),
    lossReceiptSha256: Sha256DigestV1Schema,
  })
  .strict()
  .superRefine((value, context) => {
    const observed =
      value.droppedRecordCount > 0 ||
      value.overwrittenRecordCount > 0 ||
      value.unavailableHistoryObserved;
    if (value.historyLossObserved !== observed) {
      context.addIssue({
        code: "custom",
        path: ["historyLossObserved"],
        message: "R3 raw trajectory loss flag disagrees with retained counts",
      });
    }
  });

const trajectoryCleanupSchema = z
  .object({
    proven: z.boolean(),
    cleanupReceiptSha256: Sha256DigestV1Schema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.proven !== (value.cleanupReceiptSha256 !== null)) {
      context.addIssue({
        code: "custom",
        path: ["cleanupReceiptSha256"],
        message: "R3 raw trajectory cleanup proof requires one receipt hash",
      });
    }
  });

const runtimeCoverageComplete = (
  receipt: ProjectEnvironmentRuntimeObservationReceiptV1,
): boolean =>
  receipt.coverage.every(
    (entry) =>
      entry.status === "complete" &&
      entry.observedRecords > 0 &&
      entry.droppedRecords === 0 &&
      entry.overwrittenRecords === 0,
  );

const runtimeLossProjection = (
  receipt: ProjectEnvironmentRuntimeObservationReceiptV1,
): z.input<typeof trajectoryLossSchema> => ({
  historyLossObserved:
    receipt.coverage.some(
      (entry) => entry.droppedRecords > 0 || entry.overwrittenRecords > 0,
    ) || receipt.loss.some((entry) => entry.kind === "unavailable"),
  droppedRecordCount: receipt.coverage.reduce(
    (total, entry) => total + entry.droppedRecords,
    0,
  ),
  overwrittenRecordCount: receipt.coverage.reduce(
    (total, entry) => total + entry.overwrittenRecords,
    0,
  ),
  unavailableHistoryObserved: receipt.loss.some(
    (entry) => entry.kind === "unavailable",
  ),
  lossReceiptSha256: digestJson({
    coverage: receipt.coverage,
    loss: receipt.loss,
  }),
});

const runtimeCleanupProjection = (
  receipt: ProjectEnvironmentRuntimeObservationReceiptV1,
): z.input<typeof trajectoryCleanupSchema> => {
  const proven = projectRuntimeCleanupCompleteV1(receipt.cleanup);
  return {
    proven,
    cleanupReceiptSha256: proven ? digestJson(receipt.cleanup) : null,
  };
};

const runtimeExecutionSealSha256 = (
  receipt: ProjectEnvironmentRuntimeObservationReceiptV1,
): Sha256DigestV1 =>
  digestJson({
    schemaVersion: 1,
    recordKind: "m7-r3-runtime-execution-seal-projection",
    receiptSha256: digestJson(receipt),
    status: receipt.status,
    outcome: receipt.outcome,
    completedAt: receipt.completedAt,
  });

/** Raw Host evidence needed to project a summary from Agent-visible bytes. */
export const M7R3RuntimeTrajectoryExecutionMaterialV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    recordKind: z.literal("m7-r3-runtime-trajectory-execution-material"),
    lineage: trajectoryLineageSchema,
    buildRole: z.enum(["assignment_baseline", "candidate"]),
    baselineSourceHash: Sha256DigestV1Schema,
    adapterBuildCompatibilityReceipt:
      M6AdapterBuildCompatibilityReceiptV1Schema,
    runtimeObservationReceipt:
      ProjectEnvironmentRuntimeObservationReceiptV1Schema,
    startedAt: timestampSchema,
    endedAt: timestampSchema,
    sealed: z.boolean(),
    executionSealSha256: Sha256DigestV1Schema.nullable(),
    runtimeObservationReceiptSha256: Sha256DigestV1Schema,
    coverageComplete: z.boolean(),
    coverageReceiptSha256: Sha256DigestV1Schema,
    loss: trajectoryLossSchema,
    cleanup: trajectoryCleanupSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (Date.parse(value.endedAt) < Date.parse(value.startedAt)) {
      context.addIssue({
        code: "custom",
        path: ["endedAt"],
        message: "R3 raw trajectory material cannot end before it starts",
      });
    }
    if (value.sealed !== (value.executionSealSha256 !== null)) {
      context.addIssue({
        code: "custom",
        path: ["executionSealSha256"],
        message: "R3 sealed execution material requires one seal hash",
      });
    }
    const runtimeReceiptSha256 = digestJson(value.runtimeObservationReceipt);
    const expectedCoverageReceiptSha256 = digestJson(
      value.runtimeObservationReceipt.coverage,
    );
    const expectedLoss = runtimeLossProjection(value.runtimeObservationReceipt);
    const expectedCleanup = runtimeCleanupProjection(
      value.runtimeObservationReceipt,
    );
    const expectedSealSha256 = runtimeExecutionSealSha256(
      value.runtimeObservationReceipt,
    );
    if (
      value.runtimeObservationReceiptSha256 !== runtimeReceiptSha256 ||
      value.coverageComplete !==
        runtimeCoverageComplete(value.runtimeObservationReceipt) ||
      value.coverageReceiptSha256 !== expectedCoverageReceiptSha256 ||
      !sameJson(value.loss, expectedLoss) ||
      !sameJson(value.cleanup, expectedCleanup) ||
      !value.sealed ||
      value.executionSealSha256 !== expectedSealSha256
    ) {
      context.addIssue({
        code: "custom",
        path: ["runtimeObservationReceipt"],
        message:
          "R3 runtime material facts do not derive from its exact typed observation receipt",
      });
    }
    const compatibility = value.adapterBuildCompatibilityReceipt;
    const compatibilityLineage = compatibility.lineage;
    const compatibilityBuild = compatibilityLineage.build;
    if (
      value.lineage.adapterCompatibilityReceiptId !==
        AdapterCompatibilityReceiptIdSchema.parse(compatibility.receiptId) ||
      value.lineage.adapterCompatibilityReceiptSha256 !==
        digestJson(compatibility) ||
      value.buildRole !== compatibilityLineage.buildRole ||
      value.baselineSourceHash !== compatibilityLineage.baselineSourceHash ||
      compatibilityBuild.taskId !== value.lineage.taskId ||
      compatibilityBuild.buildId !== value.lineage.buildId ||
      compatibilityBuild.sourceId !== value.lineage.sourceId ||
      compatibilityBuild.sourceHash !== value.lineage.sourceSha256 ||
      compatibilityLineage.adapterRevision.adapterRevisionId !==
        value.lineage.adapterRevisionId ||
      compatibility.outcome !== "compatible" ||
      value.runtimeObservationReceipt.taskId !== compatibilityBuild.taskId ||
      value.runtimeObservationReceipt.executionId !==
        value.lineage.executionId ||
      value.runtimeObservationReceipt.runtimeId !== value.lineage.runtimeId ||
      value.runtimeObservationReceipt.buildId !== compatibilityBuild.buildId ||
      value.runtimeObservationReceipt.adapterRevisionId !==
        compatibilityLineage.adapterRevision.adapterRevisionId ||
      value.startedAt !== value.runtimeObservationReceipt.startedAt ||
      value.endedAt !== value.runtimeObservationReceipt.completedAt
    ) {
      context.addIssue({
        code: "custom",
        path: ["adapterBuildCompatibilityReceipt"],
        message:
          "R3 runtime material crossed its exact Build/Source/Adapter compatibility lineage",
      });
    }
  });
export type M7R3RuntimeTrajectoryExecutionMaterialV1 = z.infer<
  typeof M7R3RuntimeTrajectoryExecutionMaterialV1Schema
>;

export const createM7R3RuntimeTrajectoryExecutionMaterialV1 = (input: {
  readonly adapterBuildCompatibilityReceipt: z.input<
    typeof M6AdapterBuildCompatibilityReceiptV1Schema
  >;
  readonly runtimeObservationReceipt: z.input<
    typeof ProjectEnvironmentRuntimeObservationReceiptV1Schema
  >;
}): M7R3RuntimeTrajectoryExecutionMaterialV1 => {
  const compatibility = M6AdapterBuildCompatibilityReceiptV1Schema.parse(
    input.adapterBuildCompatibilityReceipt,
  );
  const runtime = ProjectEnvironmentRuntimeObservationReceiptV1Schema.parse(
    input.runtimeObservationReceipt,
  );
  const runtimeObservationReceiptSha256 = digestJson(runtime);
  const cleanup = runtimeCleanupProjection(runtime);
  const compatibilityLineage = compatibility.lineage;
  const compatibilityBuild = compatibilityLineage.build;
  return M7R3RuntimeTrajectoryExecutionMaterialV1Schema.parse({
    schemaVersion: 1,
    recordKind: "m7-r3-runtime-trajectory-execution-material",
    lineage: {
      taskId: compatibilityBuild.taskId,
      executionId: runtime.executionId,
      runtimeId: runtime.runtimeId,
      buildId: compatibilityBuild.buildId,
      sourceId: compatibilityBuild.sourceId,
      sourceSha256: compatibilityBuild.sourceHash,
      adapterRevisionId: compatibilityLineage.adapterRevision.adapterRevisionId,
      adapterCompatibilityReceiptId: AdapterCompatibilityReceiptIdSchema.parse(
        compatibility.receiptId,
      ),
      adapterCompatibilityReceiptSha256: digestJson(compatibility),
    },
    buildRole: compatibilityLineage.buildRole,
    baselineSourceHash: compatibilityLineage.baselineSourceHash,
    adapterBuildCompatibilityReceipt: compatibility,
    runtimeObservationReceipt: runtime,
    startedAt: runtime.startedAt,
    endedAt: runtime.completedAt,
    sealed: true,
    executionSealSha256: runtimeExecutionSealSha256(runtime),
    runtimeObservationReceiptSha256,
    coverageComplete: runtimeCoverageComplete(runtime),
    coverageReceiptSha256: digestJson(runtime.coverage),
    loss: runtimeLossProjection(runtime),
    cleanup,
  });
};

const gameToolOutputIdentitySchema = z
  .object({
    taskId: TaskIdSchema.nullable(),
    executionId: ExecutionIdSchema.nullable(),
    runtimeId: RuntimeIdSchema.nullable(),
    buildId: BuildIdSchema.nullable(),
  })
  .strict();

const gameExchangeReceiptBasisSchema = z
  .object({
    schemaVersion: z.literal(1),
    recordKind: z.literal("m7-r3-agent-visible-game-tool-exchange-receipt"),
    ordinal: positiveSafeIntegerSchema,
    toolCallId: toolCallIdSchema,
    toolName: gameToolNameSchema,
    input: JsonValueSchema,
    responseDetails: JsonValueSchema,
    responseDetailsSha256: Sha256DigestV1Schema,
    finalToolResult: JsonValueSchema,
    finalToolResultSha256: Sha256DigestV1Schema,
    outputIdentity: gameToolOutputIdentitySchema.nullable(),
    observedAt: timestampSchema,
    hostToolReturnOrdinal: positiveSafeIntegerSchema,
  })
  .strict();

/** Exact JSON bytes returned by one validated PE ToolDefinition boundary. */
export const M7R3AgentVisibleGameToolExchangeReceiptV1Schema =
  gameExchangeReceiptBasisSchema
    .extend({ recordContentSha256: Sha256DigestV1Schema })
    .strict()
    .superRefine((value, context) => {
      const response = asRecord(value.responseDetails);
      const result = asRecord(value.finalToolResult);
      const details = result === null ? null : result.details;
      const output =
        response === null ? null : asRecord(response.output ?? null);
      const expectedIdentity =
        response?.outcome === "success" && output !== null
          ? {
              taskId: typeof output.taskId === "string" ? output.taskId : null,
              executionId:
                typeof output.executionId === "string"
                  ? output.executionId
                  : null,
              runtimeId:
                typeof output.runtimeId === "string" ? output.runtimeId : null,
              buildId:
                typeof output.buildId === "string" ? output.buildId : null,
            }
          : null;
      if (
        response === null ||
        response.schemaVersion !== 1 ||
        response.toolCallId !== value.toolCallId ||
        (response.outcome !== "success" && response.outcome !== "error") ||
        details === null ||
        !sameJson(details, value.responseDetails) ||
        value.responseDetailsSha256 !== digestJson(value.responseDetails) ||
        value.finalToolResultSha256 !== digestJson(value.finalToolResult) ||
        !sameJson(value.outputIdentity, expectedIdentity)
      ) {
        context.addIssue({
          code: "custom",
          path: ["responseDetails"],
          message:
            "R3 exchange receipt crossed its PE envelope, ToolResult details, or structured output identity",
        });
      }
      const { recordContentSha256, ...basis } = value;
      if (recordContentSha256 !== digestJson(basis)) {
        context.addIssue({
          code: "custom",
          path: ["recordContentSha256"],
          message: "R3 exchange-receipt content hash does not match",
        });
      }
    });
export type M7R3AgentVisibleGameToolExchangeReceiptV1 = z.infer<
  typeof M7R3AgentVisibleGameToolExchangeReceiptV1Schema
>;

const createGameToolExchangeReceipt = (
  input: z.input<typeof gameExchangeReceiptBasisSchema>,
): M7R3AgentVisibleGameToolExchangeReceiptV1 => {
  const basis = gameExchangeReceiptBasisSchema.parse(input);
  return M7R3AgentVisibleGameToolExchangeReceiptV1Schema.parse({
    ...basis,
    recordContentSha256: digestJson(basis),
  });
};

const runtimeEvidenceReceiptBasisSchema = z
  .object({
    schemaVersion: z.literal(1),
    recordKind: z.literal("m7-r3-runtime-agent-evidence-receipt"),
    campaignId: z.string().min(1).max(256),
    portfolioId: z.string().min(1).max(256),
    caseId: z.string().min(1).max(256),
    caseCampaignAdmissionRecordSha256: Sha256DigestV1Schema,
    pairedCaseContractContentSha256: Sha256DigestV1Schema,
    attemptBindingContentSha256: Sha256DigestV1Schema,
    arm: z.literal("runtime_enabled"),
    attemptOrdinal: z.literal(1),
    baselineSelectedTreeSha256: Sha256DigestV1Schema,
    backendProjectionReceiptSha256: Sha256DigestV1Schema,
    exchangeTranscriptSha256: Sha256DigestV1Schema,
    exchanges: z
      .array(M7R3AgentVisibleGameToolExchangeReceiptV1Schema)
      .min(1)
      .max(100_000),
    agentDeliveryTrace: M7R3AgentDeliveryTraceV1Schema,
    sourceObservations: z
      .array(ExternalHiddenFixHostSourceObservationV1Schema)
      .max(1_000),
    executions: z
      .array(ExternalHiddenFixPublicExecutionEvidenceV1Schema)
      .max(1_000),
    trajectoryMaterials: z
      .array(M7R3RuntimeTrajectoryExecutionMaterialV1Schema)
      .max(1_000),
  })
  .strict();

/**
 * Strict Host-only receipt behind runtimeEvidenceReceiptSha256. It retains the
 * complete delivery trace and JSON-roundtrip exchange bytes so a Gate can
 * independently recompute every Agent-visible trajectory prefix.
 */
export const M7R3RuntimeEvidenceReceiptV1Schema =
  runtimeEvidenceReceiptBasisSchema
    .extend({ recordContentSha256: Sha256DigestV1Schema })
    .strict()
    .superRefine((value, context) => {
      const exchanges = value.exchanges.map((entry) => ({
        schemaVersion: 1 as const,
        ordinal: entry.ordinal,
        toolCallId: entry.toolCallId,
        toolName: entry.toolName,
        input: entry.input,
        response: entry.responseDetails,
        observedAt: entry.observedAt,
        hostToolReturnOrdinal: entry.hostToolReturnOrdinal,
      }));
      if (
        value.exchangeTranscriptSha256 !== digestJson(exchanges) ||
        value.exchanges.some(
          (entry, index) =>
            entry.ordinal !== index + 1 ||
            (index > 0 &&
              entry.hostToolReturnOrdinal <=
                (value.exchanges[index - 1]?.hostToolReturnOrdinal ?? 0)),
        ) ||
        value.trajectoryMaterials.length !== value.executions.length ||
        new Set(
          value.trajectoryMaterials.map((entry) => entry.lineage.executionId),
        ).size !== value.trajectoryMaterials.length ||
        value.executions.some(
          (execution) =>
            !value.trajectoryMaterials.some(
              (material) =>
                material.lineage.executionId === execution.executionId,
            ),
        )
      ) {
        context.addIssue({
          code: "custom",
          path: ["exchanges"],
          message:
            "R3 runtime receipt crossed its raw transcript or execution materials",
        });
      }
      const { recordContentSha256, ...basis } = value;
      if (recordContentSha256 !== digestJson(basis)) {
        context.addIssue({
          code: "custom",
          path: ["recordContentSha256"],
          message: "R3 runtime-evidence receipt content hash does not match",
        });
      }
    });
export type M7R3RuntimeEvidenceReceiptV1 = z.infer<
  typeof M7R3RuntimeEvidenceReceiptV1Schema
>;

export const createM7R3RuntimeEvidenceReceiptV1 = (
  input: z.input<typeof runtimeEvidenceReceiptBasisSchema>,
): M7R3RuntimeEvidenceReceiptV1 => {
  const basis = runtimeEvidenceReceiptBasisSchema.parse(input);
  return M7R3RuntimeEvidenceReceiptV1Schema.parse({
    ...basis,
    recordContentSha256: digestJson(basis),
  });
};

export interface M7R3RuntimeAgentEvidenceSnapshotV1 {
  readonly sourceObservations: readonly ExternalHiddenFixHostSourceObservationV1[];
  readonly executions: readonly ExternalHiddenFixPublicExecutionEvidenceV1[];
  readonly trajectoryMaterials: readonly M7R3RuntimeTrajectoryExecutionMaterialV1[];
  /** Must be the content identity of the exact persisted Pi delivery trace. */
  readonly agentDeliveryTraceRecordSha256: Sha256DigestV1;
  /** Durable Host receipt for this read-only evidence projection. */
  readonly receiptSha256: Sha256DigestV1;
}

export interface M7R3RuntimeArmSurfaceV1 {
  readonly pristineAdapterRevision: ProjectAdapterRevisionV1;
  readonly pristineAdapterConformanceReceiptSha256: Sha256DigestV1;
  readonly adapterMutantCompatibilityReceiptSha256: Sha256DigestV1;
  readonly resourceMap: M7RuntimeResourceMapV1;
  readonly gameToolPort: ProjectEnvironmentGameToolPort;
  /** Persists the exact strict receipt later referenced by result/sidecar. */
  readonly persistRuntimeEvidenceReceiptOnce: (
    record: M7R3RuntimeEvidenceReceiptV1,
  ) => Promise<Sha256DigestV1>;
  close(): Promise<void>;
  /**
   * Reads evidence already produced by the Agent's actual game calls. It must
   * not launch, query, or rerun the game, and it receives no hidden evaluator.
   */
  readAgentEvidence(input: {
    readonly exchanges: readonly M7AgentGameToolExchangeV1[];
    readonly exchangeTranscriptSha256: Sha256DigestV1;
    readonly deliveryTrace: M7R3AgentDeliveryTraceV1;
    readonly agentDeliveryTraceRecordSha256: Sha256DigestV1;
    readonly baselineSelectedTreeSha256: Sha256DigestV1;
  }): Promise<M7R3RuntimeAgentEvidenceSnapshotV1>;
}

interface M7R3PreparedArmCommonV1 {
  readonly arm: "runtime_enabled" | "code_only";
  readonly isolation: M7AgentArmIsolationV1;
  readonly workspaceDirectory: string;
  readonly sessionDirectory: string;
  readonly agentResourceDirectory: string;
  readonly broker: TaskSandboxBrokerV1;
  readonly codingSandboxSentinelForbiddenPaths: readonly string[];
  readonly patchHandoff: M7ArmPatchHandoffV1;
  readonly now: () => string;
  readonly persistCleanupReceiptOnce: (
    record: JsonValue,
  ) => Promise<Sha256DigestV1>;
  readonly persistSandboxSentinelReceiptOnce: (
    record: JsonValue,
  ) => Promise<Sha256DigestV1>;
  readonly persistAgentDeliveryTraceOnce: (
    record: M7R3AgentDeliveryTraceV1,
  ) => Promise<Sha256DigestV1>;
  /** Fails closed before Host model work when task storage lacks headroom. */
  readonly assertTaskStorageHeadroom: () => Promise<SandboxTaskStorageHeadroomV1>;
  /** Create-once Host receipt written after the pre-Pi guard and before Pi. */
  readonly persistTaskStorageHeadroomReceiptOnce: (
    record: M7R3TaskStorageHeadroomReceiptV1,
  ) => Promise<Sha256DigestV1>;
  /** Direct Host-only callback for the independent evaluator process owner. */
  readonly persistEvaluatorHeadroomObservation: ExternalHiddenFixEvaluatorHeadroomObserverV1;
  readonly markAgentStartedOnce: () => void;
}

export interface M7R3PreparedRuntimeArmV1 extends M7R3PreparedArmCommonV1 {
  readonly arm: "runtime_enabled";
  readonly runtime: M7R3RuntimeArmSurfaceV1;
  readonly trajectoryClassifierConfig: M7PatrolTrajectoryClassifierConfigV1;
  readonly trajectoryCaseSpec: M7R3PatrolTrajectoryCaseSpecV1;
}

export interface M7R3PreparedCodeOnlyArmV1 extends M7R3PreparedArmCommonV1 {
  readonly arm: "code_only";
  readonly runtime?: never;
}

export interface PrepareM7R3ProjectEnvironmentPairedAgentPortV1Input {
  readonly runtimeArm: M7R3PreparedRuntimeArmV1;
  readonly codeOnlyArm: M7R3PreparedCodeOnlyArmV1;
}

export interface M7R3PreparedProjectEnvironmentPairedAgentPortV1 extends M7R3PairedAgentPortV1 {
  runPreAgentSandboxSentinelOnce(
    arm: "runtime_enabled" | "code_only",
  ): Promise<Sha256DigestV1>;
}

interface M7R3ProjectEnvironmentPairedAgentDependenciesV1 {
  readonly runPiTurn: typeof runVNextPiTurnWithSdk;
  readonly extractPatch: typeof extractTaskPatch;
  readonly inspectSourceHash: (
    workspaceDirectory: string,
  ) => Promise<Sha256DigestV1>;
  readonly newSessionId: (arm: "runtime_enabled" | "code_only") => string;
}

interface M7R3AttemptAuditStateV1 {
  stage: M7AgentAttemptEvidenceStageV1;
  piTurnStarted: boolean;
  piResultObserved: boolean;
  piStats: M7AgentAttemptPiStatsV1 | null;
  readonly exchanges: M7AgentGameToolExchangeV1[];
  readonly exchangeReceipts: M7R3AgentVisibleGameToolExchangeReceiptV1[];
  readonly sourceObservations: ExternalHiddenFixHostSourceObservationV1[];
  runtimeEvidenceReceiptSha256: Sha256DigestV1 | null;
  agentDeliveryTraceRecordSha256: Sha256DigestV1 | null;
  trajectorySummarySha256s: Sha256DigestV1[];
  resultRecordContentSha256: Sha256DigestV1 | null;
  cleanup: M7AgentAttemptCleanupEvidenceV1;
  sealed: boolean;
}

const createAttemptAuditState = (
  arm: "runtime_enabled" | "code_only",
): M7R3AttemptAuditStateV1 => ({
  stage: "pre_agent_sentinel",
  piTurnStarted: false,
  piResultObserved: false,
  piStats: null,
  exchanges: [],
  exchangeReceipts: [],
  sourceObservations: [],
  runtimeEvidenceReceiptSha256: null,
  agentDeliveryTraceRecordSha256: null,
  trajectorySummarySha256s: [],
  resultRecordContentSha256: null,
  cleanup: {
    schemaVersion: 1,
    runtimeCloseRequired: arm === "runtime_enabled",
    runtimeCloseAttempted: false,
    runtimeCloseCompleted: arm === "code_only",
    sandboxCleanupAttempted: false,
    sandboxCleanupReceiptObserved: false,
    processGroupTerminated: null,
    cgroupPopulated: null,
    termSent: null,
    killSent: null,
    scopeRemoved: null,
    storageReconciliationObserved: false,
    storageReconciled: null,
    cleanupResultValid: false,
    cleanupProven: false,
    cleanupReceiptSha256: null,
    cleanupInfrastructureFailure: false,
  },
  sealed: false,
});

const sourceHash = async (
  workspaceDirectory: string,
): Promise<Sha256DigestV1> =>
  selectedTreeSha256(
    await collectCandidateGodotSourceV1(
      workspaceDirectory,
      "project-environment",
      "tracked-tool-scripts-v1",
    ),
  );

const DEFAULT_DEPENDENCIES: M7R3ProjectEnvironmentPairedAgentDependenciesV1 = {
  runPiTurn: runVNextPiTurnWithSdk,
  extractPatch: extractTaskPatch,
  inspectSourceHash: sourceHash,
  newSessionId: (arm) => `m7-r3-${arm}-${randomUUID()}`,
};

const projectPiStats = (
  result: Awaited<ReturnType<typeof runVNextPiTurnWithSdk>>,
): M7AgentAttemptPiStatsV1 | null => {
  const parsed = M7AgentAttemptPiStatsV1Schema.safeParse({
    schemaVersion: 1,
    eventsObserved: result.eventsObserved,
    userMessages: result.stats.userMessages,
    assistantMessages: result.stats.assistantMessages,
    toolCalls: result.stats.toolCalls,
    toolResults: result.stats.toolResults,
    totalMessages: result.stats.totalMessages,
    inputTokens: result.stats.tokens.input,
    outputTokens: result.stats.tokens.output,
    cacheReadTokens: result.stats.tokens.cacheRead,
    cacheWriteTokens: result.stats.tokens.cacheWrite,
    totalTokens: result.stats.tokens.total,
    cost: result.stats.cost,
  });
  return parsed.success ? parsed.data : null;
};

const addSourceObservation = (
  target: ExternalHiddenFixHostSourceObservationV1[],
  value: ExternalHiddenFixHostSourceObservationV1,
): void => {
  if (target.length >= MAX_SOURCE_OBSERVATIONS) {
    throw new Error("M7 R3 Host source-observation budget exhausted");
  }
  target.push(ExternalHiddenFixHostSourceObservationV1Schema.parse(value));
};

const closeRuntimeOnce = (
  runtime: M7R3RuntimeArmSurfaceV1,
): (() => Promise<void>) => {
  let promise: Promise<void> | undefined;
  return () => {
    promise ??= runtime.close();
    return promise;
  };
};

const codingToolFingerprint = (
  tool: ReturnType<typeof createVNextCodingToolDefinitions>[number],
): M7CodingToolSurfaceEntryV1 => ({
  schemaVersion: 1,
  family: "coding",
  name: tool.name,
  definitionSha256: digestJson({
    schemaVersion: 1,
    name: tool.name,
    label: tool.label,
    description: tool.description,
    ...(tool.promptSnippet === undefined
      ? {}
      : { promptSnippet: tool.promptSnippet }),
    ...(tool.promptGuidelines === undefined
      ? {}
      : { promptGuidelines: tool.promptGuidelines }),
    parameters: JsonValueSchema.parse(tool.parameters),
    ...(tool.constrainedSampling === undefined
      ? {}
      : { constrainedSampling: tool.constrainedSampling }),
    ...(tool.renderShell === undefined
      ? {}
      : { renderShell: tool.renderShell }),
    ...(tool.executionMode === undefined
      ? {}
      : { executionMode: tool.executionMode }),
  }),
});

const exactCodingSurface = (
  actual: readonly M7CodingToolSurfaceEntryV1[],
  expected: readonly M7CodingToolSurfaceEntryV1[],
): boolean => sameJson(actual, expected);

const wrapCodingTools = (input: {
  readonly definitions: ReturnType<typeof createVNextCodingToolDefinitions>;
  readonly tracker: M7R3AgentDeliveryTrackerV1;
  readonly nextHostToolReturnOrdinal: () => number;
  readonly observeSource: (input: {
    readonly toolCallId: string;
    readonly toolName: string;
    readonly hostToolReturnOrdinal: number;
  }) => Promise<void>;
}): ReturnType<typeof createVNextCodingToolDefinitions> =>
  Object.freeze(
    input.definitions.map((definition) =>
      Object.freeze({
        ...definition,
        execute: async (
          ...arguments_: Parameters<typeof definition.execute>
        ): ReturnType<typeof definition.execute> => {
          const [toolCallId] = arguments_;
          let hostToolReturnOrdinal: number | null = null;
          try {
            const result = await definition.execute(...arguments_);
            hostToolReturnOrdinal = input.nextHostToolReturnOrdinal();
            input.tracker.recordFinalToolResult({
              toolCallId,
              toolName: definition.name,
              toolKind: "coding",
              hostToolReturnOrdinal,
              finalResult: result,
            });
            return result;
          } finally {
            hostToolReturnOrdinal ??= input.nextHostToolReturnOrdinal();
            await input.observeSource({
              toolCallId,
              toolName: definition.name,
              hostToolReturnOrdinal,
            });
          }
        },
      }),
    ),
  );

const wrapGameTools = (input: {
  readonly definitions: ReturnType<
    typeof createProjectEnvironmentGameToolDefinitions
  >;
  readonly tracker: M7R3AgentDeliveryTrackerV1;
  readonly exchanges: M7AgentGameToolExchangeV1[];
  readonly exchangeReceipts: M7R3AgentVisibleGameToolExchangeReceiptV1[];
  readonly nextHostToolReturnOrdinal: () => number;
  readonly now: () => string;
}): ReturnType<typeof createProjectEnvironmentGameToolDefinitions> =>
  Object.freeze(
    input.definitions.map((definition) =>
      Object.freeze({
        ...definition,
        execute: async (
          ...arguments_: Parameters<typeof definition.execute>
        ): ReturnType<typeof definition.execute> => {
          const result = await definition.execute(...arguments_);
          const [toolCallId, toolInput] = arguments_;
          const response = JsonValueSchema.parse(result.details);
          const responseRecord = asRecord(response);
          const output =
            responseRecord?.outcome === "success"
              ? asRecord(responseRecord.output ?? null)
              : null;
          const finalToolResult = jsonRoundTrip(
            result,
            `M7 R3 ${definition.name} final ToolResult`,
          );
          const hostToolReturnOrdinal = input.nextHostToolReturnOrdinal();
          const ordinal = input.exchanges.length + 1;
          const observedAt = input.now();
          const toolName =
            definition.name as ProjectEnvironmentGameToolPortRequestV1["toolName"];
          const exchange = Object.freeze({
            schemaVersion: 1 as const,
            ordinal,
            toolCallId,
            toolName,
            input: JsonValueSchema.parse(toolInput),
            response,
            observedAt,
            hostToolReturnOrdinal,
          });
          const receipt = createGameToolExchangeReceipt({
            schemaVersion: 1,
            recordKind: "m7-r3-agent-visible-game-tool-exchange-receipt",
            ordinal,
            toolCallId,
            toolName,
            input: exchange.input,
            responseDetails: response,
            responseDetailsSha256: digestJson(response),
            finalToolResult,
            finalToolResultSha256: digestJson(finalToolResult),
            outputIdentity:
              output === null
                ? null
                : {
                    taskId:
                      typeof output.taskId === "string" ? output.taskId : null,
                    executionId:
                      typeof output.executionId === "string"
                        ? output.executionId
                        : null,
                    runtimeId:
                      typeof output.runtimeId === "string"
                        ? output.runtimeId
                        : null,
                    buildId:
                      typeof output.buildId === "string"
                        ? output.buildId
                        : null,
                  },
            observedAt,
            hostToolReturnOrdinal,
          });
          input.exchanges.push(exchange);
          input.exchangeReceipts.push(receipt);
          input.tracker.recordFinalToolResult({
            toolCallId,
            toolName: definition.name,
            toolKind: "game",
            hostToolReturnOrdinal,
            finalResult: result,
          });
          return result;
        },
      }),
    ),
  );

const baseExchangeFromReceipt = (
  receipt: M7R3AgentVisibleGameToolExchangeReceiptV1,
): M7AgentGameToolExchangeV1 => ({
  schemaVersion: 1,
  ordinal: receipt.ordinal,
  toolCallId: receipt.toolCallId,
  toolName:
    receipt.toolName as ProjectEnvironmentGameToolPortRequestV1["toolName"],
  input: receipt.input,
  response: receipt.responseDetails,
  observedAt: receipt.observedAt,
  hostToolReturnOrdinal: receipt.hostToolReturnOrdinal,
});

const executionExchangeReceipts = (input: {
  readonly executionId: string;
  readonly receipts: readonly M7R3AgentVisibleGameToolExchangeReceiptV1[];
}): readonly M7R3AgentVisibleGameToolExchangeReceiptV1[] =>
  input.receipts.filter(
    (receipt) => receipt.outputIdentity?.executionId === input.executionId,
  );

const projectTrajectorySummaries = (input: {
  readonly snapshot: M7R3RuntimeAgentEvidenceSnapshotV1;
  readonly exchanges: readonly M7AgentGameToolExchangeV1[];
  readonly exchangeReceipts: readonly M7R3AgentVisibleGameToolExchangeReceiptV1[];
  readonly deliveryTrace: M7R3AgentDeliveryTraceV1;
  readonly baselineSelectedTreeSha256: Sha256DigestV1;
  readonly classifierImplementationSha256: Sha256DigestV1;
  readonly classifierConfig: M7PatrolTrajectoryClassifierConfigV1;
  readonly caseSpec: M7R3PatrolTrajectoryCaseSpecV1;
  readonly adapterMutantCompatibilityReceiptSha256: Sha256DigestV1;
  readonly expectedTaskId: string;
  readonly expectedAdapterRevisionId: string;
}): {
  readonly sourceObservations: readonly ExternalHiddenFixHostSourceObservationV1[];
  readonly executions: readonly ExternalHiddenFixPublicExecutionEvidenceV1[];
  readonly trajectorySummaries: readonly M7R3PatrolTrajectoryExecutionSummaryV1[];
  readonly trajectoryMaterials: readonly M7R3RuntimeTrajectoryExecutionMaterialV1[];
  readonly receiptSha256: Sha256DigestV1;
} => {
  if (!/^[a-f0-9]{64}$/u.test(input.snapshot.receiptSha256)) {
    throw new TypeError("M7 R3 runtime evidence omitted its Host receipt");
  }
  if (
    input.snapshot.agentDeliveryTraceRecordSha256 !==
    input.deliveryTrace.recordContentSha256
  ) {
    throw new TypeError("M7 R3 runtime evidence crossed its Pi delivery trace");
  }
  const sourceObservations = input.snapshot.sourceObservations.map((entry) => {
    const parsed = ExternalHiddenFixHostSourceObservationV1Schema.parse(entry);
    if (parsed.boundary !== "game_build_freeze") {
      throw new TypeError(
        "M7 R3 runtime reader may add source identity only at Build freeze",
      );
    }
    return parsed;
  });
  const exchangesFromReceipts = input.exchangeReceipts.map((entry) =>
    baseExchangeFromReceipt(
      M7R3AgentVisibleGameToolExchangeReceiptV1Schema.parse(entry),
    ),
  );
  if (!sameJson(exchangesFromReceipts, input.exchanges)) {
    throw new TypeError(
      "M7 R3 runtime projection crossed its exact ToolResult exchange receipts",
    );
  }
  const executions = input.snapshot.executions.map((entry) =>
    ExternalHiddenFixPublicExecutionEvidenceV1Schema.parse(entry),
  );
  const materials = input.snapshot.trajectoryMaterials.map((entry) =>
    M7R3RuntimeTrajectoryExecutionMaterialV1Schema.parse(entry),
  );
  if (
    materials.length !== executions.length ||
    new Set(materials.map((entry) => entry.lineage.executionId)).size !==
      materials.length ||
    executions.some(
      (execution) =>
        !materials.some(
          (material) => material.lineage.executionId === execution.executionId,
        ),
    )
  ) {
    throw new TypeError(
      "M7 R3 trajectory materials must cover every execution exactly once",
    );
  }
  if (
    new Set(executions.map((execution) => execution.executionId)).size !==
      executions.length ||
    executions.some((execution) => {
      const material = materials.find(
        (entry) => entry.lineage.executionId === execution.executionId,
      );
      const linkedQueryReceipt = input.exchangeReceipts.find(
        (receipt) =>
          receipt.toolName === "game_query" &&
          receipt.outputIdentity?.executionId === execution.executionId &&
          receipt.outputIdentity.taskId === material?.lineage.taskId &&
          (receipt.outputIdentity.runtimeId === null ||
            receipt.outputIdentity.runtimeId === material.lineage.runtimeId) &&
          (receipt.outputIdentity.buildId === null ||
            receipt.outputIdentity.buildId === material.lineage.buildId),
      );
      return (
        material === undefined ||
        linkedQueryReceipt === undefined ||
        !sourceObservations.some(
          (observation) =>
            observation.buildId === execution.buildId &&
            observation.sourceSha256 === execution.sourceSha256,
        )
      );
    })
  ) {
    throw new TypeError(
      "M7 R3 runtime execution lacks its structured Agent-visible query and Build freeze",
    );
  }
  const trajectorySummaries: M7R3PatrolTrajectoryExecutionSummaryV1[] = [];
  for (const material of materials) {
    const execution = executions.find(
      (entry) => entry.executionId === material.lineage.executionId,
    );
    if (
      execution === undefined ||
      execution.buildId !== material.lineage.buildId ||
      execution.sourceSha256 !== material.lineage.sourceSha256 ||
      execution.startedAt !== material.startedAt ||
      execution.endedAt !== material.endedAt ||
      execution.coverageComplete !== material.coverageComplete ||
      execution.cleanupProven !== material.cleanup.proven ||
      execution.sealed !== material.sealed ||
      material.lineage.taskId !== input.expectedTaskId ||
      material.lineage.adapterRevisionId !== input.expectedAdapterRevisionId ||
      material.baselineSourceHash !== input.baselineSelectedTreeSha256 ||
      (execution.sourceSha256 === input.baselineSelectedTreeSha256
        ? material.buildRole !== "assignment_baseline" ||
          material.lineage.adapterCompatibilityReceiptSha256 !==
            input.adapterMutantCompatibilityReceiptSha256
        : material.buildRole !== "candidate" ||
          material.lineage.adapterCompatibilityReceiptSha256 ===
            input.adapterMutantCompatibilityReceiptSha256)
    ) {
      throw new TypeError(
        "M7 R3 trajectory material crossed its public execution or admitted baseline compatibility",
      );
    }
    if (!execution.sealed) continue;
    if (material.executionSealSha256 === null) {
      throw new TypeError("M7 R3 sealed execution omitted its seal hash");
    }
    const expectedWitnessKinds =
      execution.sourceSha256 === input.baselineSelectedTreeSha256
        ? input.caseSpec.expectedBaselineWitnessKinds
        : input.caseSpec.expectedRecoveryWitnessKinds;
    const linkedExchanges = executionExchangeReceipts({
      executionId: execution.executionId,
      receipts: input.exchangeReceipts,
    }).map(baseExchangeFromReceipt);
    const prefix = classifyM7R3EarliestAgentVisibleTrajectoryPrefixV1({
      executionId: execution.executionId,
      exchanges: linkedExchanges,
      deliveryTrace: input.deliveryTrace,
      expectedWitnessKinds,
      classifierConfig: input.classifierConfig,
    });
    if (prefix === null) continue;
    const classifiedReceipt = input.exchangeReceipts.find(
      (receipt) =>
        receipt.toolCallId === prefix.agentVisibleFinalToolResult.toolCallId &&
        receipt.outputIdentity?.executionId === execution.executionId,
    );
    if (
      classifiedReceipt === undefined ||
      classifiedReceipt.finalToolResultSha256 !==
        prefix.agentVisibleFinalToolResult.finalResultSha256 ||
      classifiedReceipt.responseDetailsSha256 !==
        prefix.agentVisibleResponseDetailsSha256
    ) {
      throw new TypeError(
        "M7 R3 classified response crossed its exact final Pi ToolResult",
      );
    }
    trajectorySummaries.push(
      createM7R3PatrolTrajectoryExecutionSummaryV1({
        lineage: material.lineage,
        startedAt: material.startedAt,
        endedAt: material.endedAt,
        executionSealSha256: material.executionSealSha256,
        runtimeObservationReceiptSha256:
          material.runtimeObservationReceiptSha256,
        classifierImplementationSha256: input.classifierImplementationSha256,
        classifierConfig: input.classifierConfig,
        agentVisibleTimeline: prefix.timeline,
        agentVisibleAtHostToolReturnOrdinal:
          prefix.agentVisibleAtHostToolReturnOrdinal,
        agentVisibleExchangeTranscriptSha256:
          prefix.agentVisibleExchangeTranscriptSha256,
        agentVisibleExchangeReceiptSha256:
          prefix.agentVisibleExchangeReceiptSha256,
        agentVisibleDeliveryResponseSha256:
          prefix.agentVisibleDeliveryResponseSha256,
        agentVisibleResponseDetailsSha256:
          prefix.agentVisibleResponseDetailsSha256,
        agentVisibleFinalToolResult: prefix.agentVisibleFinalToolResult,
        firstHostObservedSourceChange:
          input.deliveryTrace.firstHostObservedSourceChange,
        coverageComplete: material.coverageComplete,
        coverageReceiptSha256: material.coverageReceiptSha256,
        loss: material.loss,
        cleanup: material.cleanup,
      }),
    );
  }
  return Object.freeze({
    sourceObservations: Object.freeze(sourceObservations),
    executions: Object.freeze(executions),
    trajectorySummaries: Object.freeze(trajectorySummaries),
    trajectoryMaterials: Object.freeze(materials),
    receiptSha256: input.snapshot.receiptSha256,
  });
};

const runCodingSandboxSentinel = async (
  arm: M7R3PreparedRuntimeArmV1 | M7R3PreparedCodeOnlyArmV1,
): Promise<Sha256DigestV1> => {
  const targets = [...arm.codingSandboxSentinelForbiddenPaths];
  if (
    targets.length === 0 ||
    new Set(targets).size !== targets.length ||
    targets.some((target) => !isAbsolute(target) || resolve(target) !== target)
  ) {
    throw new TypeError(`M7 R3 ${arm.arm} sandbox sentinel is invalid`);
  }
  const sentinelInput = Buffer.concat(
    targets.flatMap((target) => [
      Buffer.from(target, "utf8"),
      Buffer.from([0]),
    ]),
  );
  const request: SandboxExecutionRequestV1 = {
    schemaVersion: 1,
    operationId: `m7-r3-sentinel:${randomUUID()}`,
    profile: "coding-default",
    argv: [
      "/bin/bash",
      "-c",
      'index=0; while IFS= read -r -d "" target; do if [ -e "$target" ] || [ -r "$target" ] || [ -w "$target" ]; then printf "%s\\n" "$index"; exit 23; fi; index=$((index + 1)); done',
      "m7-r3-coding-sentinel",
    ],
    cwd: "/workspace",
    environment: {},
    stdin: {
      byteLength: sentinelInput.byteLength,
      sha256: asSha256DigestV1(
        createHash("sha256").update(sentinelInput).digest("hex"),
      ),
    },
  };
  const result = await arm.broker.execute(request, { stdin: sentinelInput });
  if (
    result.kind !== "executed" ||
    result.receipt.status !== "succeeded" ||
    result.receipt.exitCode !== 0
  ) {
    throw new TypeError(`M7 R3 ${arm.arm} coding sandbox sentinel failed`);
  }
  return arm.persistSandboxSentinelReceiptOnce(
    JsonValueSchema.parse({
      schemaVersion: 1,
      recordKind: "m7-r3-coding-sandbox-sentinel",
      arm: arm.arm,
      taskId: arm.isolation.taskId,
      forbiddenPathsSha256: digestJson(targets),
      operationId: result.receipt.operationId,
      status: result.receipt.status,
      exitCode: result.receipt.exitCode,
      checkedAt: arm.now(),
    }),
  );
};

const validateArmRequest = (input: {
  readonly request: M7R3PairedAgentArmRequestV1;
  readonly arm: M7R3PreparedRuntimeArmV1 | M7R3PreparedCodeOnlyArmV1;
}): void => {
  const parsed = M7R3PairedAgentArmRequestV1Schema.parse(input.request);
  if (
    parsed.arm !== input.arm.arm ||
    parsed.prompt !== parsed.promptIdentity.text ||
    parsed.commonEnvironmentInstructionsSha256 !==
      M7_R3_NEUTRAL_ENVIRONMENT_INSTRUCTIONS_SHA256_V1 ||
    parsed.isolation.taskId !== input.arm.isolation.taskId ||
    parsed.isolation.workspaceHandle !== input.arm.isolation.workspaceHandle ||
    !sameJson(parsed.isolation, input.arm.isolation)
  ) {
    throw new TypeError(
      "M7 R3 Pi request crossed its natural prompt or prepared isolation",
    );
  }
};

/**
 * Binds R3 protocol requests to actual Pi definitions and isolated sandboxes.
 * It performs no game operation except those selected by the Agent itself.
 */
export async function prepareM7R3ProjectEnvironmentPairedAgentPortV1(
  input: PrepareM7R3ProjectEnvironmentPairedAgentPortV1Input,
  overrides: Partial<M7R3ProjectEnvironmentPairedAgentDependenciesV1> = {},
): Promise<M7R3PreparedProjectEnvironmentPairedAgentPortV1> {
  if (input.runtimeArm.broker === input.codeOnlyArm.broker) {
    throw new TypeError("M7 R3 paired arms must not share a sandbox broker");
  }
  if (
    input.runtimeArm.patchHandoff.patchStore ===
    input.codeOnlyArm.patchHandoff.patchStore
  ) {
    throw new TypeError("M7 R3 paired arms must not share a patch store");
  }
  const prepared = await Promise.all(
    ([input.runtimeArm, input.codeOnlyArm] as const).map(async (arm) => ({
      arm,
      workspaceDirectory: await canonicalDirectory(
        arm.workspaceDirectory,
        `${arm.arm} workspace`,
        false,
      ),
      sessionDirectory: await canonicalDirectory(
        arm.sessionDirectory,
        `${arm.arm} Session directory`,
        true,
      ),
      agentResourceDirectory: await canonicalDirectory(
        arm.agentResourceDirectory,
        `${arm.arm} Agent resource directory`,
        true,
      ),
      closeRuntime:
        arm.arm === "runtime_enabled" ? closeRuntimeOnce(arm.runtime) : null,
    })),
  );
  assertDisjointDirectories(
    prepared.flatMap((arm) => [
      { label: `${arm.arm.arm} workspace`, path: arm.workspaceDirectory },
      { label: `${arm.arm.arm} Session`, path: arm.sessionDirectory },
      { label: `${arm.arm.arm} cache`, path: arm.agentResourceDirectory },
    ]),
  );
  const byArm = new Map(prepared.map((arm) => [arm.arm.arm, arm] as const));
  const audits = new Map(
    prepared.map(
      (arm) => [arm.arm.arm, createAttemptAuditState(arm.arm.arm)] as const,
    ),
  );
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
  const runCalls = new Set<string>();
  const cleanupCalls = new Set<string>();
  const sentinelCalls = new Set<string>();
  let preAgentDryRunMode = false;

  const runSentinelOnce = async (
    selected: (typeof prepared)[number],
  ): Promise<Sha256DigestV1> => {
    if (sentinelCalls.has(selected.arm.arm)) {
      throw new Error(`M7 R3 ${selected.arm.arm} sentinel may run only once`);
    }
    sentinelCalls.add(selected.arm.arm);
    return runCodingSandboxSentinel(selected.arm);
  };

  const runPreAgentSandboxSentinelOnce = (
    arm: "runtime_enabled" | "code_only",
  ): Promise<Sha256DigestV1> => {
    if (runCalls.size > 0 || cleanupCalls.size > 0) {
      throw new Error("M7 R3 pre-Agent sentinel cannot follow an attempt");
    }
    preAgentDryRunMode = true;
    const selected = byArm.get(arm);
    if (selected === undefined) {
      throw new Error(`M7 R3 ${arm} preparation is unavailable`);
    }
    return runSentinelOnce(selected);
  };

  const runArm: M7R3PairedAgentPortV1["runArm"] = async (untrustedRequest) => {
    const request = M7R3PairedAgentArmRequestV1Schema.parse(untrustedRequest);
    if (preAgentDryRunMode) {
      throw new Error("M7 R3 Agent cannot start after pre-Agent dry-run");
    }
    if (request.arm === "code_only" && !cleanupCalls.has("runtime_enabled")) {
      throw new Error(
        "M7 R3 code-only Agent cannot start before runtime cleanup",
      );
    }
    if (runCalls.has(request.arm)) {
      throw new Error(`M7 R3 ${request.arm} Pi Session may run only once`);
    }
    runCalls.add(request.arm);
    const selected = byArm.get(request.arm);
    const audit = audits.get(request.arm);
    if (selected === undefined || audit === undefined || audit.sealed) {
      throw new Error(`M7 R3 ${request.arm} preparation is unavailable`);
    }
    validateArmRequest({ request, arm: selected.arm });
    audit.stage = "pre_agent_sentinel";
    await runSentinelOnce(selected);
    audit.stage = "baseline_source_observation";
    const initialSourceHash = await dependencies.inspectSourceHash(
      selected.workspaceDirectory,
    );
    if (initialSourceHash !== request.baselineSelectedTreeSha256) {
      throw new TypeError(
        `M7 R3 ${request.arm} workspace changed from mutant baseline`,
      );
    }
    addSourceObservation(audit.sourceObservations, {
      schemaVersion: 1,
      boundary: "initial_materialization",
      sourceSha256: initialSourceHash,
      buildId: null,
      observedAt: selected.arm.now(),
    });

    let hostToolReturnOrdinal = 0;
    const nextHostToolReturnOrdinal = (): number => {
      hostToolReturnOrdinal += 1;
      return hostToolReturnOrdinal;
    };
    const tracker = createM7R3AgentDeliveryTrackerV1();
    let lastCodingSourceHash = initialSourceHash;
    let firstCodingReturnObserved = false;
    const observeSource = async (observation: {
      readonly toolCallId: string;
      readonly toolName: string;
      readonly hostToolReturnOrdinal: number;
    }): Promise<void> => {
      const observed = await dependencies.inspectSourceHash(
        selected.workspaceDirectory,
      );
      if (!firstCodingReturnObserved || observed !== lastCodingSourceHash) {
        firstCodingReturnObserved = true;
        lastCodingSourceHash = observed;
        addSourceObservation(audit.sourceObservations, {
          schemaVersion: 1,
          boundary: "coding_tool_return",
          sourceSha256: observed,
          buildId: null,
          observedAt: selected.arm.now(),
        });
      }
      tracker.recordCodingSourceObservation({
        toolCallId: observation.toolCallId,
        toolName: observation.toolName,
        hostToolReturnOrdinal: observation.hostToolReturnOrdinal,
        baselineSourceSha256: initialSourceHash,
        observedSourceSha256: observed,
        observedAt: selected.arm.now(),
      });
    };

    const toolCallAdmission = createProjectEnvironmentToolCallAdmissionV1(
      request.agentBudget.toolCallsMaximum,
    );
    const rawCodingTools = createVNextCodingToolDefinitions(
      new SandboxPiCodingToolPort(selected.arm.broker),
      { toolCallAdmission },
    );
    if (
      !exactCodingSurface(
        rawCodingTools.map(codingToolFingerprint),
        request.codingTools,
      )
    ) {
      throw new TypeError(
        `M7 R3 ${request.arm} coding definitions crossed admission`,
      );
    }
    const codingTools = wrapCodingTools({
      definitions: rawCodingTools,
      tracker,
      nextHostToolReturnOrdinal,
      observeSource,
    });

    let gameTools: ReturnType<
      typeof createProjectEnvironmentGameToolDefinitions
    > = [];
    if (request.arm === "runtime_enabled") {
      if (selected.arm.arm !== "runtime_enabled") {
        throw new TypeError("M7 R3 runtime request crossed preparation");
      }
      const adapterRevision = ProjectAdapterRevisionV1Schema.parse(
        selected.arm.runtime.pristineAdapterRevision,
      );
      if (
        request.runtimeAccess.pristineAdapterRevisionId !==
          adapterRevision.adapterRevisionId ||
        request.runtimeAccess.pristineAdapterRevisionSha256 !==
          digestJson(adapterRevision) ||
        request.runtimeAccess.pristineAdapterPackageSha256 !==
          adapterRevision.packageDigest ||
        request.runtimeAccess.pristineAdapterConformanceReceiptSha256 !==
          selected.arm.runtime.pristineAdapterConformanceReceiptSha256 ||
        !sameJson(
          request.runtimeAccess.runtimeResourceMap,
          selected.arm.runtime.resourceMap,
        ) ||
        request.runtimeAccess.runtimeResourceAppendixSha256 !==
          digestJson(
            createM7R3NeutralRuntimeResourceAppendixV1(
              selected.arm.runtime.resourceMap,
            ),
          )
      ) {
        throw new TypeError(
          "M7 R3 runtime tools crossed pristine Adapter or mutant Build surface",
        );
      }
      const admitted = new Set(request.gameTools.map((tool) => tool.name));
      gameTools = wrapGameTools({
        definitions: createProjectEnvironmentGameToolDefinitions(
          selected.arm.runtime.gameToolPort,
          adapterRevision.capabilitySet,
          { toolCallAdmission },
        ).filter((tool) => admitted.has(tool.name as never)),
        tracker,
        exchanges: audit.exchanges,
        exchangeReceipts: audit.exchangeReceipts,
        nextHostToolReturnOrdinal,
        now: selected.arm.now,
      });
      if (
        gameTools.length !== request.gameTools.length ||
        !sameSet(
          gameTools.map((tool) => tool.name),
          request.gameTools.map((tool) => tool.name),
        )
      ) {
        throw new TypeError(
          "M7 R3 runtime tools crossed Adapter-declared admission",
        );
      }
    }

    const tools = Object.freeze([...codingTools, ...gameTools]);
    let piResult: Awaited<ReturnType<typeof runVNextPiTurnWithSdk>>;
    let piFailure: unknown;
    let deliveryTrace: M7R3AgentDeliveryTraceV1 | null = null;
    const markPiTurnStarted = (): void => {
      if (audit.piTurnStarted) return;
      selected.arm.markAgentStartedOnce();
      audit.piTurnStarted = true;
    };
    try {
      audit.stage = "pi_turn";
      const taskStorageHeadroom = M7R3TaskStorageHeadroomV1Schema.parse(
        await selected.arm.assertTaskStorageHeadroom(),
      );
      const taskStorageHeadroomReceipt = createM7R3TaskStorageHeadroomReceiptV1(
        {
          campaignId: request.campaignId,
          portfolioId: request.portfolioId,
          caseId: request.caseId,
          pairedCaseContractContentSha256:
            request.pairedCaseContractContentSha256,
          arm: request.arm,
          taskId: request.isolation.taskId,
          attemptBindingContentSha256:
            request.attemptBinding.bindingContentSha256,
          availableBytes: taskStorageHeadroom.availableBytes,
          availableInodes: taskStorageHeadroom.availableInodes,
          requiredAvailableBytes: taskStorageHeadroom.requiredAvailableBytes,
          requiredAvailableInodes: taskStorageHeadroom.requiredAvailableInodes,
          observedAt: selected.arm.now(),
        },
      );
      const persistedTaskStorageHeadroomSha256 =
        await selected.arm.persistTaskStorageHeadroomReceiptOnce(
          taskStorageHeadroomReceipt,
        );
      if (
        persistedTaskStorageHeadroomSha256 !==
        taskStorageHeadroomReceipt.recordContentSha256
      ) {
        throw new Error(
          "M7 R3 task-storage headroom receipt crossed durable identity",
        );
      }
      piResult = await dependencies.runPiTurn({
        resourceWorkspaceDirectory: selected.workspaceDirectory,
        sessionDirectory: selected.sessionDirectory,
        agentDir: selected.agentResourceDirectory,
        newSessionId: dependencies.newSessionId(request.arm),
        provider: request.provider,
        model: request.model,
        thinkingLevel: request.thinkingLevel,
        prompt: request.prompt,
        tools,
        timeoutMs: request.agentBudget.wallTimeMsMaximum,
        loadProjectAdapterSkillV1: false,
        onEvent: tracker.onEvent,
        onLifecycleEvent: (event) => {
          if (event.stage === "prompt_submitted") markPiTurnStarted();
        },
        ...(request.arm === "runtime_enabled"
          ? {
              additionalEnvironmentInstructions:
                createM7R3NeutralRuntimeResourceAppendixV1(
                  request.runtimeAccess.runtimeResourceMap,
                ),
            }
          : {}),
      });
      if (piResult.observedTurnCount === 1) markPiTurnStarted();
      audit.piResultObserved = true;
      audit.piStats = projectPiStats(piResult);
    } catch (error) {
      piFailure = error;
      throw error;
    } finally {
      const finalizationFailures: unknown[] = [];
      if (selected.closeRuntime !== null) {
        audit.stage = "runtime_close";
        audit.cleanup = { ...audit.cleanup, runtimeCloseAttempted: true };
        try {
          await selected.closeRuntime();
          audit.cleanup = { ...audit.cleanup, runtimeCloseCompleted: true };
        } catch (closeError) {
          finalizationFailures.push(closeError);
        }
      }
      try {
        deliveryTrace = tracker.snapshot();
        const persisted =
          await selected.arm.persistAgentDeliveryTraceOnce(deliveryTrace);
        if (persisted !== deliveryTrace.recordContentSha256) {
          throw new TypeError(
            "M7 R3 persisted Agent delivery trace changed its identity",
          );
        }
        audit.agentDeliveryTraceRecordSha256 = persisted;
      } catch (error) {
        finalizationFailures.push(error);
      }
      if (piFailure !== undefined) audit.stage = "pi_turn";
      if (finalizationFailures.length > 0) {
        throw new AggregateError(
          [
            ...(piFailure === undefined ? [] : [piFailure]),
            ...finalizationFailures,
          ],
          "M7 R3 arm operation and finalization did not both complete",
        );
      }
    }

    audit.stage = "pi_result_validation";
    if (
      piResult.provider !== request.provider ||
      piResult.model !== request.model ||
      piResult.requestedThinkingLevel !== request.thinkingLevel ||
      piResult.realizedThinkingLevel !== request.thinkingLevel ||
      piResult.observedTurnCount !== (audit.piTurnStarted ? 1 : 0) ||
      piResult.stats.userMessages !== 1 ||
      !sameSet(
        piResult.activeTools,
        tools.map((tool) => tool.name),
      )
    ) {
      throw new TypeError(
        `M7 R3 ${request.arm} Pi result crossed one-turn/model/tool binding`,
      );
    }
    if (deliveryTrace === null) {
      throw new TypeError("M7 R3 delivery trace was not sealed");
    }

    let runtimeEvidenceReceiptSha256: Sha256DigestV1 | null = null;
    const executions: ExternalHiddenFixPublicExecutionEvidenceV1[] = [];
    const trajectorySummaries: M7R3PatrolTrajectoryExecutionSummaryV1[] = [];
    if (request.arm === "runtime_enabled" && audit.exchanges.length > 0) {
      if (selected.arm.arm !== "runtime_enabled") {
        throw new TypeError("M7 R3 runtime evidence crossed preparation");
      }
      audit.stage = "runtime_evidence_projection";
      const exchanges = Object.freeze([...audit.exchanges]);
      const classifierConfig = M7PatrolTrajectoryClassifierConfigV1Schema.parse(
        selected.arm.trajectoryClassifierConfig,
      );
      const caseSpec = M7R3PatrolTrajectoryCaseSpecV1Schema.parse(
        selected.arm.trajectoryCaseSpec,
      );
      if (
        classifierConfig.configSha256 !==
          request.runtimeAccess.trajectory.classifierConfigSha256 ||
        caseSpec.classifierId !==
          request.runtimeAccess.trajectory.classifierId ||
        caseSpec.classifierImplementationSha256 !==
          request.runtimeAccess.trajectory.classifierImplementationSha256 ||
        caseSpec.classifierConfigSha256 !== classifierConfig.configSha256 ||
        caseSpec.caseId !== request.runtimeAccess.trajectory.caseSpecId ||
        caseSpec.caseSpecSha256 !==
          request.runtimeAccess.trajectory.caseSpecSha256
      ) {
        throw new TypeError(
          "M7 R3 runtime trajectory implementation crossed its frozen case surface",
        );
      }
      const snapshot = await selected.arm.runtime.readAgentEvidence({
        exchanges,
        exchangeTranscriptSha256: digestJson(exchanges),
        deliveryTrace,
        agentDeliveryTraceRecordSha256: deliveryTrace.recordContentSha256,
        baselineSelectedTreeSha256: initialSourceHash,
      });
      const projection = projectTrajectorySummaries({
        snapshot,
        exchanges,
        exchangeReceipts: audit.exchangeReceipts,
        deliveryTrace,
        baselineSelectedTreeSha256: initialSourceHash,
        classifierImplementationSha256:
          request.runtimeAccess.trajectory.classifierImplementationSha256,
        classifierConfig,
        caseSpec,
        adapterMutantCompatibilityReceiptSha256:
          selected.arm.runtime.adapterMutantCompatibilityReceiptSha256,
        expectedTaskId: request.runtimeAccess.runtimeResourceMap.taskId,
        expectedAdapterRevisionId:
          request.runtimeAccess.pristineAdapterRevisionId,
      });
      projection.sourceObservations.forEach((entry) =>
        addSourceObservation(audit.sourceObservations, entry),
      );
      executions.push(...projection.executions);
      trajectorySummaries.push(...projection.trajectorySummaries);
      const runtimeEvidenceReceipt = createM7R3RuntimeEvidenceReceiptV1({
        schemaVersion: 1,
        recordKind: "m7-r3-runtime-agent-evidence-receipt",
        campaignId: request.campaignId,
        portfolioId: request.portfolioId,
        caseId: request.caseId,
        caseCampaignAdmissionRecordSha256:
          request.caseCampaignAdmissionRecordSha256,
        pairedCaseContractContentSha256:
          request.pairedCaseContractContentSha256,
        attemptBindingContentSha256:
          request.attemptBinding.bindingContentSha256,
        arm: "runtime_enabled",
        attemptOrdinal: 1,
        baselineSelectedTreeSha256: initialSourceHash,
        backendProjectionReceiptSha256: projection.receiptSha256,
        exchangeTranscriptSha256: digestJson(exchanges),
        exchanges: audit.exchangeReceipts,
        agentDeliveryTrace: deliveryTrace,
        sourceObservations: [...projection.sourceObservations],
        executions: [...projection.executions],
        trajectoryMaterials: [...projection.trajectoryMaterials],
      });
      const persistedRuntimeEvidenceReceiptSha256 =
        await selected.arm.runtime.persistRuntimeEvidenceReceiptOnce(
          runtimeEvidenceReceipt,
        );
      if (
        persistedRuntimeEvidenceReceiptSha256 !==
        runtimeEvidenceReceipt.recordContentSha256
      ) {
        throw new TypeError(
          "M7 R3 runtime evidence store changed the strict receipt identity",
        );
      }
      runtimeEvidenceReceiptSha256 = persistedRuntimeEvidenceReceiptSha256;
      audit.runtimeEvidenceReceiptSha256 =
        persistedRuntimeEvidenceReceiptSha256;
      audit.trajectorySummarySha256s = projection.trajectorySummaries.map(
        (summary) => summary.summarySha256,
      );
    }

    const loopStatus: M7R3PairedAgentArmResultV1["status"] =
      toolCallAdmission.exhausted
        ? "aborted"
        : piResult.status === "provider_failed"
          ? "provider_failure"
          : piResult.status;
    let candidatePatch: M7R3PairedAgentArmResultV1["candidatePatch"] = null;
    if (loopStatus === "completed") {
      audit.stage = "candidate_patch_handoff";
      const candidateSourceHash = await dependencies.inspectSourceHash(
        selected.workspaceDirectory,
      );
      if (candidateSourceHash !== initialSourceHash) {
        const extracted: ExtractedTaskPatch = await dependencies.extractPatch({
          sourceKind: "project-environment-v1",
          taskId: asTaskId(request.isolation.taskId),
          workspaceDirectory: selected.workspaceDirectory,
          hostBaselineGitDirectory:
            selected.arm.patchHandoff.hostBaselineGitDirectory,
          hostBaselineCommit: selected.arm.patchHandoff.hostBaselineCommit,
          baselineSourceHash: initialSourceHash,
          ignoredCachePaths: selected.arm.patchHandoff.ignoredCachePaths,
          hostOperationTemporaryDirectory:
            selected.arm.patchHandoff.hostOperationTemporaryDirectory,
        });
        if (
          extracted.identity.taskId !== request.isolation.taskId ||
          extracted.identity.baselineSourceHash !== initialSourceHash ||
          extracted.identity.candidateSourceHash !== candidateSourceHash ||
          extracted.identity.patchHash !==
            asSha256DigestV1(
              createHash("sha256").update(extracted.patchBytes).digest("hex"),
            ) ||
          extracted.identity.byteLength !== extracted.patchBytes.byteLength
        ) {
          throw new TypeError(
            `M7 R3 ${request.arm} patch crossed exact source trees`,
          );
        }
        const patch = ExternalHiddenFixPatchReferenceV1Schema.parse(
          await selected.arm.patchHandoff.patchStore.publishOnce(
            extracted.patchBytes,
          ),
        );
        const patchIdentity = ExternalHiddenFixPatchIdentityV1Schema.parse({
          schemaVersion: 1,
          baselineSelectedTreeSha256: initialSourceHash,
          candidateSelectedTreeSha256: candidateSourceHash,
          patchSha256: extracted.identity.patchHash,
          byteLength: extracted.identity.byteLength,
        });
        if (
          patch.rawSha256 !== patchIdentity.patchSha256 ||
          patch.byteLength !== patchIdentity.byteLength
        ) {
          throw new TypeError(`M7 R3 ${request.arm} patch store changed bytes`);
        }
        candidatePatch = {
          schemaVersion: 1,
          patch,
          patchIdentity,
          admissible: true,
          roundTripVerified: extracted.roundTripVerified,
        };
        addSourceObservation(audit.sourceObservations, {
          schemaVersion: 1,
          boundary: "patch_freeze",
          sourceSha256: candidateSourceHash,
          buildId: null,
          observedAt: selected.arm.now(),
        });
      }
    }

    audit.stage = "arm_result_validation";
    const result = createM7R3PairedAgentArmResultV1({
      schemaVersion: 1,
      recordKind: "m7-r3-paired-agent-arm-result",
      campaignId: request.campaignId,
      portfolioId: request.portfolioId,
      caseId: request.caseId,
      caseCampaignAdmissionRecordSha256:
        request.caseCampaignAdmissionRecordSha256,
      pairedCaseContractContentSha256: request.pairedCaseContractContentSha256,
      attemptOrdinal: 1,
      userTurnCount: 1,
      status: loopStatus,
      realizedProvider: piResult.provider,
      realizedModel: piResult.model,
      realizedThinkingLevel: piResult.realizedThinkingLevel,
      activeToolNames: [...piResult.activeTools],
      hostHttpTransportObservation:
        piResult.hostHttpTransportObservation ?? null,
      agentDeliveryTraceRecordSha256: deliveryTrace.recordContentSha256,
      attemptBindingContentSha256: request.attemptBinding.bindingContentSha256,
      candidatePatch,
      sourceObservations: [...audit.sourceObservations],
      ...(request.arm === "runtime_enabled"
        ? {
            arm: "runtime_enabled" as const,
            executions: [...executions],
            agentVisibleGameToolExchanges: audit.exchanges.map((exchange) =>
              createM7AgentVisibleGameToolExchangeHashV1(exchange),
            ),
            trajectorySummaries: [...trajectorySummaries],
            runtimeEvidenceReceiptSha256,
          }
        : {
            arm: "code_only" as const,
            executions: [] as const,
            agentVisibleGameToolExchanges: [] as const,
            trajectorySummaries: [] as const,
            runtimeEvidenceReceiptSha256: null,
          }),
    });
    audit.resultRecordContentSha256 = result.recordContentSha256;
    return result;
  };

  const cleanupArm: M7R3PairedAgentPortV1["cleanupArm"] = async (request) => {
    if (preAgentDryRunMode) {
      throw new Error("M7 R3 cleanup cannot follow pre-Agent dry-run");
    }
    if (cleanupCalls.has(request.arm)) {
      throw new Error(`M7 R3 ${request.arm} cleanup may run only once`);
    }
    cleanupCalls.add(request.arm);
    const selected = byArm.get(request.arm);
    const audit = audits.get(request.arm);
    if (
      selected === undefined ||
      audit === undefined ||
      audit.sealed ||
      !sameJson(request.isolation, selected.arm.isolation)
    ) {
      throw new TypeError("M7 R3 cleanup crossed prepared arm binding");
    }
    const failures: string[] = [];
    if (selected.closeRuntime !== null) {
      audit.cleanup = { ...audit.cleanup, runtimeCloseAttempted: true };
      try {
        await selected.closeRuntime();
        audit.cleanup = { ...audit.cleanup, runtimeCloseCompleted: true };
      } catch {
        failures.push("runtime_close_failed");
      }
    }
    let sandboxCleanup;
    try {
      audit.cleanup = { ...audit.cleanup, sandboxCleanupAttempted: true };
      sandboxCleanup = SandboxCleanupReceiptV1Schema.parse(
        await selected.arm.broker.cleanup(),
      );
      audit.cleanup = {
        ...audit.cleanup,
        sandboxCleanupReceiptObserved: true,
        processGroupTerminated: sandboxCleanup.processGroupTerminated,
        cgroupPopulated: sandboxCleanup.cgroupPopulated,
        termSent: sandboxCleanup.termSent,
        killSent: sandboxCleanup.killSent,
        scopeRemoved: sandboxCleanup.scopeRemoved,
        storageReconciliationObserved:
          sandboxCleanup.storageReconciled !== undefined,
        storageReconciled: sandboxCleanup.storageReconciled ?? null,
      };
    } catch {
      audit.cleanup = {
        ...audit.cleanup,
        cleanupInfrastructureFailure: true,
      };
      throw new Error(`M7 R3 ${request.arm} cleanup returned no receipt`);
    }
    const proven =
      failures.length === 0 &&
      sandboxCleanup.processGroupTerminated &&
      !sandboxCleanup.cgroupPopulated &&
      sandboxCleanup.scopeRemoved &&
      sandboxCleanup.storageReconciled === true;
    if (!proven && failures.length === 0) {
      failures.push("sandbox_cleanup_incomplete");
    }
    const receiptSha256 = await selected.arm.persistCleanupReceiptOnce(
      JsonValueSchema.parse({
        schemaVersion: 1,
        recordKind: "m7-r3-paired-arm-cleanup",
        arm: request.arm,
        taskId: request.isolation.taskId,
        attemptBindingContentSha256: request.attemptBindingContentSha256,
        sandboxCleanup,
        proven,
        failures,
        completedAt: selected.arm.now(),
      }),
    );
    audit.cleanup = {
      ...audit.cleanup,
      cleanupResultValid: true,
      cleanupProven: proven,
      cleanupReceiptSha256: receiptSha256,
      cleanupInfrastructureFailure: false,
    };
    return {
      schemaVersion: 1,
      arm: request.arm,
      attemptBindingContentSha256: request.attemptBindingContentSha256,
      proven,
      receiptSha256,
    } satisfies M7PairedAgentCleanupResultV1;
  };

  const sealAttemptEvidenceOnce: NonNullable<
    M7R3PairedAgentPortV1["sealAttemptEvidenceOnce"]
  > = (request): Promise<M7R3AgentAttemptEvidenceSidecarV1> => {
    const audit = audits.get(request.arm);
    const selected = byArm.get(request.arm);
    if (
      audit === undefined ||
      selected === undefined ||
      audit.sealed ||
      request.attemptBindingContentSha256 !==
        request.cleanup.attemptBindingContentSha256
    ) {
      throw new TypeError("M7 R3 attempt evidence crossed arm state");
    }
    audit.cleanup = {
      ...audit.cleanup,
      cleanupResultValid: request.cleanupFailureCode === null,
      cleanupProven:
        request.cleanupFailureCode === null && request.cleanup.proven,
      cleanupReceiptSha256:
        request.cleanupFailureCode === null
          ? request.cleanup.receiptSha256
          : null,
      cleanupInfrastructureFailure: request.cleanupFailureCode !== null,
    };
    const terminal =
      request.runnerFailureCode === "runner_threw"
        ? { stage: audit.stage, code: "operation_threw" as const }
        : request.runnerFailureCode === "runner_result_invalid"
          ? {
              stage: "arm_result_validation" as const,
              code: "result_invalid" as const,
            }
          : request.cleanupFailureCode === "cleanup_threw"
            ? { stage: "cleanup" as const, code: "operation_threw" as const }
            : request.cleanupFailureCode === "cleanup_result_invalid"
              ? { stage: "cleanup" as const, code: "result_invalid" as const }
              : !request.cleanup.proven
                ? {
                    stage: "cleanup" as const,
                    code: "cleanup_not_proven" as const,
                  }
                : { stage: "sealed" as const, code: "completed" as const };
    const evidence = createM7R3AgentAttemptEvidenceSidecarV1({
      campaignId: request.campaignId,
      portfolioId: request.portfolioId,
      caseId: request.caseId,
      caseCampaignAdmissionRecordSha256:
        request.caseCampaignAdmissionRecordSha256,
      pairedCaseContractContentSha256: request.pairedCaseContractContentSha256,
      arm: request.arm,
      attemptBindingContentSha256: request.attemptBindingContentSha256,
      terminalStage: terminal.stage,
      terminalCode: terminal.code,
      piTurnStarted: audit.piTurnStarted,
      piResultObserved: audit.piResultObserved,
      piStats: audit.piStats,
      agentDeliveryTraceRecordSha256: audit.agentDeliveryTraceRecordSha256,
      agentVisibleGameToolExchanges:
        request.arm === "runtime_enabled"
          ? audit.exchanges.map((exchange) =>
              createM7AgentVisibleGameToolExchangeHashV1(exchange),
            )
          : [],
      sourceObservations: audit.sourceObservations,
      resultRecordContentSha256:
        request.runnerFailureCode === null
          ? audit.resultRecordContentSha256
          : null,
      runtimeEvidenceReceiptSha256:
        request.arm === "runtime_enabled"
          ? audit.runtimeEvidenceReceiptSha256
          : null,
      trajectorySummarySha256s:
        request.arm === "runtime_enabled" ? audit.trajectorySummarySha256s : [],
      cleanup: audit.cleanup,
    });
    audit.sealed = true;
    return Promise.resolve(evidence);
  };

  return Object.freeze({
    runArm,
    cleanupArm,
    sealAttemptEvidenceOnce,
    runPreAgentSandboxSentinelOnce,
  });
}

export interface RunM7R3ProjectEnvironmentPairedAgentArmOnceV1Input extends PrepareM7R3ProjectEnvironmentPairedAgentPortV1Input {
  readonly request: M7R3PairedAgentArmRequestV1;
}

/** Convenience entry point for one arm; paired Gate code should prepare once. */
export async function runM7R3ProjectEnvironmentPairedAgentArmOnceV1(
  input: RunM7R3ProjectEnvironmentPairedAgentArmOnceV1Input,
  overrides: Partial<M7R3ProjectEnvironmentPairedAgentDependenciesV1> = {},
): Promise<M7R3PairedAgentAttemptRecordV1> {
  const port = await prepareM7R3ProjectEnvironmentPairedAgentPortV1(
    { runtimeArm: input.runtimeArm, codeOnlyArm: input.codeOnlyArm },
    overrides,
  );
  return runM7R3PairedAgentArmOnceV1({ request: input.request, port });
}

export type { RunVNextPiSdkTurnOptions };
