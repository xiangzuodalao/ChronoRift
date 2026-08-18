import {
  Sha256DigestV1Schema,
  asSha256DigestV1,
  type Sha256DigestV1,
} from "@chronorift/domain";
import { canonicalJson, contentHash } from "@chronorift/json-artifacts";
import { z } from "zod";

import {
  ExternalHiddenFixPatchIdentityV1Schema,
  ExternalHiddenFixWorkflowEvidenceReceiptV1Schema,
  createExternalHiddenFixWorkflowEvidenceReceiptV1,
  type ExternalHiddenFixWorkflowEvidenceReceiptV1,
} from "./external-hidden-fix.js";

const assignmentIdSchema = z.string().regex(/^m6-assignment:[a-f0-9]{24}$/u);
const opaqueIdSchema = z.string().min(1).max(512);
const timestampSchema = z.string().datetime();

export const ExternalHiddenFixHostSourceObservationV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    boundary: z.enum([
      "initial_materialization",
      "coding_tool_return",
      "game_build_freeze",
      "patch_freeze",
    ]),
    sourceSha256: Sha256DigestV1Schema,
    buildId: opaqueIdSchema.nullable(),
    observedAt: timestampSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.boundary === "game_build_freeze") !== (value.buildId !== null)) {
      context.addIssue({
        code: "custom",
        path: ["buildId"],
        message:
          "only a game Build-freeze source observation carries its Build identity",
      });
    }
  });
export type ExternalHiddenFixHostSourceObservationV1 = z.infer<
  typeof ExternalHiddenFixHostSourceObservationV1Schema
>;

export const ExternalHiddenFixPublicExecutionEvidenceV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    executionId: opaqueIdSchema,
    buildId: opaqueIdSchema,
    sourceSha256: Sha256DigestV1Schema,
    startedAt: timestampSchema,
    endedAt: timestampSchema,
    sealed: z.boolean(),
    coverageComplete: z.boolean(),
    cleanupProven: z.boolean(),
    publicSymptomObserved: z.boolean(),
    publicObservationSha256: Sha256DigestV1Schema,
  })
  .strict()
  .superRefine((value, context) => {
    if (Date.parse(value.endedAt) < Date.parse(value.startedAt)) {
      context.addIssue({
        code: "custom",
        path: ["endedAt"],
        message: "public execution cannot end before it starts",
      });
    }
  });
export type ExternalHiddenFixPublicExecutionEvidenceV1 = z.infer<
  typeof ExternalHiddenFixPublicExecutionEvidenceV1Schema
>;

export const ExternalHiddenFixWorkflowInputV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    assignmentId: assignmentIdSchema,
    agentTurnCount: z.number().int().min(0).max(16),
    agentLoopStatus: z.enum([
      "completed",
      "provider_failure",
      "timed_out",
      "aborted",
    ]),
    baselineSelectedTreeSha256: Sha256DigestV1Schema,
    patchIdentity: ExternalHiddenFixPatchIdentityV1Schema,
    patchObservedAt: timestampSchema,
    patchAdmissible: z.boolean(),
    patchRoundTripVerified: z.boolean(),
    sourceObservations: z
      .array(ExternalHiddenFixHostSourceObservationV1Schema)
      .max(1_000),
    executions: z
      .array(ExternalHiddenFixPublicExecutionEvidenceV1Schema)
      .max(1_000),
    taskCleanupProven: z.boolean(),
  })
  .strict();
export type ExternalHiddenFixWorkflowInputV1 = z.infer<
  typeof ExternalHiddenFixWorkflowInputV1Schema
>;

const workflowEvidenceDigest = (value: unknown): Sha256DigestV1 =>
  asSha256DigestV1(contentHash(value as never));

/**
 * Checks public Task/runtime facts only. In particular, the ordering fact is
 * bounded to source identities observed by the Host at tool boundaries; it
 * cannot detect a transient edit/run/revert performed inside one coding-tool
 * invocation.
 */
export function checkExternalHiddenFixWorkflowV1(
  untrustedInput: ExternalHiddenFixWorkflowInputV1,
): ExternalHiddenFixWorkflowEvidenceReceiptV1 {
  const input = ExternalHiddenFixWorkflowInputV1Schema.parse(untrustedInput);
  const baselineHash = input.baselineSelectedTreeSha256;
  const candidateHash = input.patchIdentity.candidateSelectedTreeSha256;
  const changedObservations = input.sourceObservations
    .filter((entry) => entry.sourceSha256 !== baselineHash)
    .sort(
      (left, right) =>
        Date.parse(left.observedAt) - Date.parse(right.observedAt),
    );
  const firstChangedObservation = changedObservations[0];

  const buildObservationById = new Map(
    input.sourceObservations
      .filter(
        (entry): entry is typeof entry & { readonly buildId: string } =>
          entry.boundary === "game_build_freeze" && entry.buildId !== null,
      )
      .map((entry) => [entry.buildId, entry]),
  );
  const lineageExecutions = input.executions.filter((execution) => {
    const build = buildObservationById.get(execution.buildId);
    return (
      build !== undefined &&
      build.sourceSha256 === execution.sourceSha256 &&
      Date.parse(build.observedAt) <= Date.parse(execution.startedAt)
    );
  });
  const baselineExecutions = lineageExecutions.filter(
    (execution) =>
      execution.sourceSha256 === baselineHash &&
      execution.publicSymptomObserved &&
      execution.sealed &&
      execution.coverageComplete &&
      execution.cleanupProven &&
      firstChangedObservation !== undefined &&
      Date.parse(execution.endedAt) <
        Date.parse(firstChangedObservation.observedAt),
  );
  const candidateExecutions = lineageExecutions.filter(
    (execution) =>
      execution.sourceSha256 === candidateHash &&
      execution.sealed &&
      execution.coverageComplete &&
      execution.cleanupProven &&
      Date.parse(execution.endedAt) <= Date.parse(input.patchObservedAt),
  );

  const checks = {
    single_agent_turn: {
      satisfied:
        input.agentTurnCount === 1 && input.agentLoopStatus === "completed",
      evidenceSha256: workflowEvidenceDigest({
        agentTurnCount: input.agentTurnCount,
        agentLoopStatus: input.agentLoopStatus,
      }),
    },
    baseline_execution_before_host_observed_source_change: {
      satisfied: baselineExecutions.length > 0,
      evidenceSha256:
        firstChangedObservation === undefined
          ? null
          : workflowEvidenceDigest({
              boundary: firstChangedObservation,
              baselineExecutions,
              limitation:
                "Host tool-boundary ordering does not inspect transient source changes inside one coding-tool invocation.",
            }),
    },
    candidate_patch_frozen: {
      satisfied:
        input.patchAdmissible &&
        input.patchIdentity.byteLength > 0 &&
        input.patchIdentity.baselineSelectedTreeSha256 === baselineHash,
      evidenceSha256: workflowEvidenceDigest({
        patchIdentity: input.patchIdentity,
        patchAdmissible: input.patchAdmissible,
        patchObservedAt: input.patchObservedAt,
      }),
    },
    patch_round_trip_verified: {
      satisfied: input.patchRoundTripVerified,
      evidenceSha256: workflowEvidenceDigest({
        patchIdentity: input.patchIdentity,
        patchRoundTripVerified: input.patchRoundTripVerified,
      }),
    },
    candidate_rerun_observed: {
      satisfied: candidateExecutions.length > 0,
      evidenceSha256: workflowEvidenceDigest(candidateExecutions),
    },
    execution_lineage_valid: {
      satisfied:
        lineageExecutions.length === input.executions.length &&
        baselineExecutions.length > 0 &&
        candidateExecutions.length > 0,
      evidenceSha256: workflowEvidenceDigest({
        sourceObservations: input.sourceObservations,
        executions: input.executions,
      }),
    },
    cleanup_proven: {
      satisfied:
        input.taskCleanupProven &&
        baselineExecutions.some((execution) => execution.cleanupProven) &&
        candidateExecutions.some((execution) => execution.cleanupProven),
      evidenceSha256: workflowEvidenceDigest({
        taskCleanupProven: input.taskCleanupProven,
        executionCleanup: input.executions.map((execution) => ({
          executionId: execution.executionId,
          cleanupProven: execution.cleanupProven,
        })),
      }),
    },
  } as const;

  return createExternalHiddenFixWorkflowEvidenceReceiptV1({
    assignmentId: input.assignmentId,
    patchIdentity: input.patchIdentity,
    checks,
    infrastructureFailureCode: null,
  });
}

const workflowAuditBindingSchema = z
  .object({
    schemaVersion: z.literal(1),
    assignmentId: assignmentIdSchema,
    patchIdentity: ExternalHiddenFixPatchIdentityV1Schema,
    workflowInputContentSha256: Sha256DigestV1Schema,
    workflowReceiptContentSha256: Sha256DigestV1Schema,
  })
  .strict();

const workflowAuditBaseSchema = workflowAuditBindingSchema.extend({
  recordKind: z.literal("external-hidden-fix-workflow-audit"),
  workflowInput: ExternalHiddenFixWorkflowInputV1Schema,
  bindingContentSha256: Sha256DigestV1Schema,
  recordContentSha256: Sha256DigestV1Schema,
});

/** Host-only, public-fact-only input retained for rejected-workflow diagnosis. */
export const ExternalHiddenFixWorkflowAuditV1Schema = workflowAuditBaseSchema
  .strict()
  .superRefine((value, context) => {
    if (value.assignmentId !== value.workflowInput.assignmentId) {
      context.addIssue({
        code: "custom",
        path: ["workflowInput", "assignmentId"],
        message: "workflow audit input crossed its assignment",
      });
    }
    if (
      canonicalJson(value.patchIdentity) !==
      canonicalJson(value.workflowInput.patchIdentity)
    ) {
      context.addIssue({
        code: "custom",
        path: ["patchIdentity"],
        message: "workflow audit patch identity does not match its input",
      });
    }
    if (
      value.workflowInputContentSha256 !==
      workflowEvidenceDigest(value.workflowInput)
    ) {
      context.addIssue({
        code: "custom",
        path: ["workflowInputContentSha256"],
        message: "workflow audit input content hash does not match",
      });
    }
    const recomputedReceipt = checkExternalHiddenFixWorkflowV1(
      value.workflowInput,
    );
    if (
      value.workflowReceiptContentSha256 !==
      recomputedReceipt.receiptContentSha256
    ) {
      context.addIssue({
        code: "custom",
        path: ["workflowReceiptContentSha256"],
        message:
          "workflow audit receipt hash is not reproducible from its public input",
      });
    }
    const binding = workflowAuditBindingSchema.parse({
      schemaVersion: value.schemaVersion,
      assignmentId: value.assignmentId,
      patchIdentity: value.patchIdentity,
      workflowInputContentSha256: value.workflowInputContentSha256,
      workflowReceiptContentSha256: value.workflowReceiptContentSha256,
    });
    if (value.bindingContentSha256 !== workflowEvidenceDigest(binding)) {
      context.addIssue({
        code: "custom",
        path: ["bindingContentSha256"],
        message: "workflow audit input/receipt binding hash does not match",
      });
    }
    const { recordContentSha256, ...recordBasis } = value;
    if (recordContentSha256 !== workflowEvidenceDigest(recordBasis)) {
      context.addIssue({
        code: "custom",
        path: ["recordContentSha256"],
        message: "workflow audit record content hash does not match",
      });
    }
  });
export type ExternalHiddenFixWorkflowAuditV1 = z.infer<
  typeof ExternalHiddenFixWorkflowAuditV1Schema
>;

export const createExternalHiddenFixWorkflowAuditV1 = (input: {
  readonly workflowInput: ExternalHiddenFixWorkflowInputV1;
  readonly workflowReceipt: ExternalHiddenFixWorkflowEvidenceReceiptV1;
}): ExternalHiddenFixWorkflowAuditV1 => {
  const workflowInput = ExternalHiddenFixWorkflowInputV1Schema.parse(
    input.workflowInput,
  );
  const workflowReceipt =
    ExternalHiddenFixWorkflowEvidenceReceiptV1Schema.parse(
      input.workflowReceipt,
    );
  const recomputedReceipt = checkExternalHiddenFixWorkflowV1(workflowInput);
  if (canonicalJson(recomputedReceipt) !== canonicalJson(workflowReceipt)) {
    throw new TypeError(
      "workflow audit receipt is not reproducible from its public workflow input",
    );
  }
  const workflowInputContentSha256 = workflowEvidenceDigest(workflowInput);
  const binding = workflowAuditBindingSchema.parse({
    schemaVersion: 1,
    assignmentId: workflowInput.assignmentId,
    patchIdentity: workflowInput.patchIdentity,
    workflowInputContentSha256,
    workflowReceiptContentSha256: workflowReceipt.receiptContentSha256,
  });
  const recordBasis = {
    ...binding,
    recordKind: "external-hidden-fix-workflow-audit" as const,
    workflowInput,
    bindingContentSha256: workflowEvidenceDigest(binding),
  };
  return ExternalHiddenFixWorkflowAuditV1Schema.parse({
    ...recordBasis,
    recordContentSha256: workflowEvidenceDigest(recordBasis),
  });
};
