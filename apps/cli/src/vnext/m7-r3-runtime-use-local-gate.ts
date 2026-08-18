import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import {
  isAbsolute,
  parse as parsePath,
  relative,
  resolve,
  sep,
} from "node:path";

import {
  BuildIdSchema,
  JsonValueSchema,
  Sha256DigestV1Schema,
  SourceIdSchema,
  asSha256DigestV1,
  type JsonValue,
  type Sha256DigestV1,
} from "@chronorift/domain";
import { canonicalJson } from "@chronorift/json-artifacts";
import { z } from "zod";

import {
  ExternalHiddenFixFreshRunReceiptV1Schema,
  type ExternalHiddenFixFreshCopyRunInputV1,
  type ExternalHiddenFixFreshCopyRunnerV1,
  type ExternalHiddenFixPatchReferenceV1,
} from "./external-hidden-fix.js";
import { ExternalHiddenFixFreshCopyInfrastructureErrorV1 } from "./external-hidden-fix-evaluator.js";
import {
  M7LocalMutationMaterialsV1Schema,
  type M7LocalMutationMaterialsV1,
} from "./m7-runtime-use-local-gate.js";
import { publishPrivateFileOnceV1 } from "./private-atomic-publication.js";
import {
  M7PairedAgentCleanupResultV1Schema,
  createM7AgentVisibleGameToolExchangeHashV1,
} from "./m7-paired-agent.js";
import {
  M7R3AgentAttemptFailureReceiptV1Schema,
  M7R3AgentAttemptEvidenceSidecarV1Schema,
  M7R3PairedAgentArmResultV1Schema,
  M7R3PairedAgentAttemptBindingV1Schema,
  M7R3PairedCaseContractV1Schema,
  type M7R3AgentAttemptFailureReceiptV1,
  type M7R3AgentAttemptEvidenceSidecarV1,
  type M7R3PairedAgentArmResultV1,
  type M7R3PairedAgentAttemptRecordV1,
  type M7R3PairedCaseContractV1,
} from "./m7-r3-paired-agent.js";
import {
  M7R3AgentDeliveryTraceV1Schema,
  type M7R3AgentDeliveryTraceV1,
} from "./m7-r3-agent-delivery.js";
import {
  M7R3CaseCampaignAdmissionV1Schema,
  type M7R3CaseCampaignAdmissionV1,
} from "./m7-r3-case-admission.js";
import {
  createM7R3PatrolTrajectoryExecutionSummaryV1,
  M7R3PatrolTrajectoryUseEvidenceV1Schema,
  deriveM7R3PatrolTrajectoryUseEvidenceV1,
  type M7R3PatrolTrajectoryExecutionSummaryV1,
  type M7R3PatrolTrajectoryUseEvidenceV1,
} from "./m7-patrol-trajectory.js";
import type { M7AgentGameToolExchangeV1 } from "./m7-project-environment-paired-agent.js";
import {
  M7R3RuntimeEvidenceReceiptV1Schema,
  type M7R3RuntimeEvidenceReceiptV1,
} from "./m7-r3-project-environment-paired-agent.js";
import { classifyM7R3EarliestAgentVisibleTrajectoryPrefixV1 } from "./m7-r3-trajectory-delivery.js";
import {
  M7ArmV1Schema,
  createM7ArmResultV1,
  type M7ArmClaimV1,
  type M7ArmResultV1,
  type M7ArmV1,
  type M7CampaignTerminalRecordV1,
  type M7CandidatePatchV1,
  type M7MutationRegistrationV1,
  type M7RuntimeUseCampaignStoreV1,
} from "./m7-runtime-use-campaign.js";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const RECORD_BYTE_LIMIT = 16 * 1024 * 1024;

const campaignIdSchema = z.string().regex(/^m7-campaign:[a-f0-9]{24}$/u);
const opaqueIdSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:+-]*$/u);
const thinkingLevelSchema = z.enum([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

const digest = (bytes: string | Uint8Array): Sha256DigestV1 =>
  asSha256DigestV1(createHash("sha256").update(bytes).digest("hex"));

const digestJson = (value: unknown): Sha256DigestV1 =>
  digest(canonicalJson(JsonValueSchema.parse(value)));

const sameJson = (left: unknown, right: unknown): boolean =>
  canonicalJson(JsonValueSchema.parse(left)) ===
  canonicalJson(JsonValueSchema.parse(right));

const addIssue = (
  context: z.RefinementCtx,
  path: readonly (string | number)[],
  message: string,
): void => context.addIssue({ code: "custom", path: [...path], message });

const isNodeError = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error && "code" in error;

const pathWithinOrEqual = (parent: string, candidate: string): boolean => {
  const difference = relative(parent, candidate);
  return (
    difference === "" ||
    (difference !== ".." &&
      !difference.startsWith(`..${sep}`) &&
      !isAbsolute(difference))
  );
};

const requireEffectiveUserId = (): number => {
  const uid = process.geteuid?.();
  if (uid === undefined) {
    throw new Error(
      "M7 R3 local Gate requires effective-user ownership checks",
    );
  }
  return uid;
};

interface DirectoryIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly uid: number;
  readonly mode: number;
}

const requireCanonicalDirectory = async (
  inputPath: string,
  label: string,
): Promise<{ readonly path: string; readonly identity: DirectoryIdentity }> => {
  const path = resolve(inputPath);
  if (path === parsePath(path).root) {
    throw new Error(`${label} must not be a filesystem root`);
  }
  const metadata = await lstat(path);
  if (
    metadata.isSymbolicLink() ||
    !metadata.isDirectory() ||
    (await realpath(path)) !== path
  ) {
    throw new Error(`${label} must be a canonical real directory`);
  }
  return {
    path,
    identity: {
      dev: metadata.dev,
      ino: metadata.ino,
      uid: metadata.uid,
      mode: metadata.mode,
    },
  };
};

const requirePrivateDirectory = async (
  inputPath: string,
  label: string,
): Promise<{ readonly path: string; readonly identity: DirectoryIdentity }> => {
  const directory = await requireCanonicalDirectory(inputPath, label);
  if (
    directory.identity.uid !== requireEffectiveUserId() ||
    (directory.identity.mode & 0o7777) !== PRIVATE_DIRECTORY_MODE
  ) {
    throw new Error(`${label} must be current-user owned with mode 0700`);
  }
  return directory;
};

const requireDirectoryIdentity = async (
  path: string,
  identity: DirectoryIdentity,
): Promise<void> => {
  const current = await requirePrivateDirectory(path, "M7 R3 evidence root");
  if (
    current.identity.dev !== identity.dev ||
    current.identity.ino !== identity.ino ||
    current.identity.uid !== identity.uid ||
    current.identity.mode !== identity.mode
  ) {
    throw new Error("M7 R3 evidence root identity changed");
  }
};

const claimInputSchema = z
  .object({
    campaignId: campaignIdSchema,
    arm: M7ArmV1Schema,
    binding: z
      .object({
        publicTaskSpecSha256: Sha256DigestV1Schema,
        provider: z.string().min(1).max(256),
        model: z.string().min(1).max(256),
        thinkingLevel: thinkingLevelSchema,
        agentBudgetSha256: Sha256DigestV1Schema,
        workspaceBaselineSelectedTreeSha256: Sha256DigestV1Schema,
        codingToolSetSha256: Sha256DigestV1Schema,
        sandboxPolicySha256: Sha256DigestV1Schema,
      })
      .strict(),
    taskId: opaqueIdSchema,
    sessionIdentitySha256: Sha256DigestV1Schema,
    workspaceIdentitySha256: Sha256DigestV1Schema,
    cacheIdentitySha256: Sha256DigestV1Schema,
    startedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export const M7R3LocalArmAdmissionV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    recordKind: z.literal("m7-r3-local-arm-admission"),
    arm: M7ArmV1Schema,
    caseCampaignAdmissionRecordSha256: Sha256DigestV1Schema,
    pairedCaseContractContentSha256: Sha256DigestV1Schema,
    pairedAttemptBindingContentSha256: Sha256DigestV1Schema,
    pairedAttemptBinding: M7R3PairedAgentAttemptBindingV1Schema,
    claim: claimInputSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.arm !== value.claim.arm) {
      addIssue(context, ["claim", "arm"], "R3 admission crossed its arm");
    }
    if (
      value.pairedAttemptBindingContentSha256 !==
        value.pairedAttemptBinding.bindingContentSha256 ||
      value.arm !== value.pairedAttemptBinding.arm
    ) {
      addIssue(
        context,
        ["pairedAttemptBinding"],
        "R3 admission crossed its exact paired attempt binding",
      );
    }
  });
export type M7R3LocalArmAdmissionV1 = z.infer<
  typeof M7R3LocalArmAdmissionV1Schema
>;

const pairedAttemptRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    recordKind: z.literal("m7-r3-paired-agent-attempt-record"),
    arm: M7ArmV1Schema,
    binding: M7R3PairedAgentAttemptBindingV1Schema,
    result: M7R3PairedAgentArmResultV1Schema.nullable(),
    infrastructureFailureCode: z
      .enum(["runner_threw", "runner_result_invalid"])
      .nullable(),
    cleanup: M7PairedAgentCleanupResultV1Schema,
    cleanupInfrastructureFailure: z.boolean(),
    attemptEvidence: M7R3AgentAttemptEvidenceSidecarV1Schema,
    failureReceipt:
      M7R3AgentAttemptFailureReceiptV1Schema.nullable().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const resultHash = value.result?.recordContentSha256 ?? null;
    if (
      value.arm !== value.binding.arm ||
      value.arm !== value.cleanup.arm ||
      value.cleanup.attemptBindingContentSha256 !==
        value.binding.bindingContentSha256 ||
      value.attemptEvidence.arm !== value.arm ||
      value.attemptEvidence.campaignId !== value.binding.campaignId ||
      value.attemptEvidence.attemptBindingContentSha256 !==
        value.binding.bindingContentSha256 ||
      value.attemptEvidence.resultRecordContentSha256 !== resultHash ||
      (value.result !== null &&
        value.attemptEvidence.agentDeliveryTraceRecordSha256 !==
          value.result.agentDeliveryTraceRecordSha256) ||
      (value.result !== null &&
        (value.result.arm !== value.arm ||
          value.result.attemptBindingContentSha256 !==
            value.binding.bindingContentSha256))
    ) {
      addIssue(
        context,
        ["binding"],
        "R3 attempt crossed its arm, binding, result, or sidecar",
      );
    }
    if (
      value.failureReceipt !== undefined &&
      value.failureReceipt !== null &&
      (value.failureReceipt.campaignId !== value.binding.campaignId ||
        value.failureReceipt.arm !== value.arm ||
        value.failureReceipt.attemptBindingContentSha256 !==
          value.binding.bindingContentSha256 ||
        value.failureReceipt.attemptEvidenceRecordSha256 !==
          value.attemptEvidence.recordContentSha256 ||
        value.failureReceipt.piTurnStarted !==
          value.attemptEvidence.piTurnStarted)
    ) {
      addIssue(
        context,
        ["failureReceipt"],
        "R3 failure receipt crossed its attempt evidence",
      );
    }
    if (
      (value.infrastructureFailureCode === null) !==
      (value.result !== null)
    ) {
      addIssue(
        context,
        ["infrastructureFailureCode"],
        "R3 attempt failure and result presence disagree",
      );
    }
    if (
      value.cleanupInfrastructureFailure &&
      (value.cleanup.proven || value.cleanup.receiptSha256 !== null)
    ) {
      addIssue(
        context,
        ["cleanup"],
        "cleanup infrastructure failure cannot retain a cleanup proof",
      );
    }
    if (value.result?.arm === "runtime_enabled") {
      if (
        !sameJson(
          value.attemptEvidence.agentVisibleGameToolExchanges,
          value.result.agentVisibleGameToolExchanges,
        ) ||
        !sameJson(
          value.attemptEvidence.trajectorySummarySha256s,
          value.result.trajectorySummaries.map(
            (summary) => summary.summarySha256,
          ),
        ) ||
        value.attemptEvidence.runtimeEvidenceReceiptSha256 !==
          value.result.runtimeEvidenceReceiptSha256
      ) {
        addIssue(
          context,
          ["attemptEvidence"],
          "R3 runtime sidecar crossed its retained result evidence",
        );
      }
    }
  })
  .transform((value) => value as M7R3PairedAgentAttemptRecordV1);

const runtimeArmEnvelopeSchema = z
  .object({
    schemaVersion: z.literal(1),
    recordKind: z.literal("m7-r3-local-arm-run-envelope"),
    arm: z.literal("runtime_enabled"),
    attempt: pairedAttemptRecordSchema,
    deliveryTrace: M7R3AgentDeliveryTraceV1Schema.nullable(),
    runtimeEvidenceReceipt: M7R3RuntimeEvidenceReceiptV1Schema.nullable(),
  })
  .strict();

const codeOnlyArmEnvelopeSchema = z
  .object({
    schemaVersion: z.literal(1),
    recordKind: z.literal("m7-r3-local-arm-run-envelope"),
    arm: z.literal("code_only"),
    attempt: pairedAttemptRecordSchema,
    deliveryTrace: M7R3AgentDeliveryTraceV1Schema.nullable(),
    runtimeEvidenceReceipt: z.null(),
  })
  .strict();

export const M7R3LocalArmRunEnvelopeV1Schema = z
  .discriminatedUnion("arm", [
    runtimeArmEnvelopeSchema,
    codeOnlyArmEnvelopeSchema,
  ])
  .superRefine((value, context) => {
    if (value.arm !== value.attempt.arm) {
      addIssue(context, ["attempt", "arm"], "R3 envelope crossed its arm");
    }
    if (
      value.attempt.result !== null &&
      (value.deliveryTrace === null ||
        value.attempt.result.agentDeliveryTraceRecordSha256 !==
          value.deliveryTrace.recordContentSha256 ||
        value.attempt.attemptEvidence.agentDeliveryTraceRecordSha256 !==
          value.deliveryTrace.recordContentSha256)
    ) {
      addIssue(
        context,
        ["deliveryTrace"],
        "R3 envelope crossed its full Pi delivery trace",
      );
    }
    if (
      value.attempt.result === null &&
      value.attempt.attemptEvidence.agentDeliveryTraceRecordSha256 !==
        (value.deliveryTrace?.recordContentSha256 ?? null)
    ) {
      addIssue(
        context,
        ["deliveryTrace"],
        "R3 failed attempt crossed its retained Pi delivery trace",
      );
    }
    const resultRuntimeReceiptSha256 =
      value.attempt.result?.arm === "runtime_enabled"
        ? value.attempt.result.runtimeEvidenceReceiptSha256
        : null;
    if (
      value.arm === "runtime_enabled" &&
      resultRuntimeReceiptSha256 !==
        (value.runtimeEvidenceReceipt?.recordContentSha256 ?? null)
    ) {
      addIssue(
        context,
        ["runtimeEvidenceReceipt"],
        "R3 envelope crossed its exact Host runtime-evidence receipt",
      );
    }
    if (
      value.arm === "runtime_enabled" &&
      value.runtimeEvidenceReceipt !== null &&
      (value.deliveryTrace === null ||
        !sameJson(
          value.runtimeEvidenceReceipt.agentDeliveryTrace,
          value.deliveryTrace,
        ))
    ) {
      addIssue(
        context,
        ["runtimeEvidenceReceipt", "agentDeliveryTrace"],
        "R3 runtime receipt crossed its full Pi delivery trace",
      );
    }
    if (
      value.arm === "runtime_enabled" &&
      value.deliveryTrace !== null &&
      value.deliveryTrace.integrityFailures.length > 0 &&
      value.attempt.result?.arm === "runtime_enabled" &&
      value.attempt.result.trajectorySummaries.length > 0
    ) {
      addIssue(
        context,
        ["attempt", "result", "trajectorySummaries"],
        "an integrity-failed delivery trace cannot publish trajectory summaries",
      );
    }
  });
export type M7R3LocalArmRunEnvelopeV1 = z.infer<
  typeof M7R3LocalArmRunEnvelopeV1Schema
>;

export interface M7R3RuntimeUsePairedArmPortV1 {
  readonly getArmAdmission: (arm: M7ArmV1) => Promise<unknown>;
  readonly runArmOnce: (input: {
    readonly schemaVersion: 1;
    readonly campaignId: string;
    readonly arm: M7ArmV1;
    readonly campaignClaimContentSha256: Sha256DigestV1;
    readonly pairedAttemptBindingContentSha256: Sha256DigestV1;
    readonly caseCampaignAdmissionRecordSha256: Sha256DigestV1;
    readonly pairedCaseContractContentSha256: Sha256DigestV1;
  }) => Promise<unknown>;
}

const freshPlan = (input: {
  readonly campaignId: string;
  readonly arm: M7ArmV1;
  readonly assignmentId: string;
}): readonly ExternalHiddenFixFreshCopyRunInputV1["plan"][] => {
  const result: ExternalHiddenFixFreshCopyRunInputV1["plan"][] = [];
  let ordinal = 1;
  for (const scenarioClass of [
    "public_reproduction",
    "hidden_variant",
    "regression_control",
  ] as const) {
    for (const repetition of [1, 2, 3] as const) {
      const identity = digest(
        `${input.campaignId}\0${input.arm}\0${scenarioClass}\0${String(repetition)}`,
      );
      result.push({
        schemaVersion: 1,
        assignmentId: input.assignmentId,
        freshCopyId: `m6-fresh-copy:${identity.slice(0, 24)}`,
        ordinal,
        scenarioClass,
        repetition,
        requiresFreshWorkspace: true,
        requiresFreshImportCache: true,
        requiresFreshProcess: true,
      });
      ordinal += 1;
    }
  }
  return Object.freeze(result);
};

const evaluatorEvidenceBasisSchema = z
  .object({
    schemaVersion: z.literal(1),
    recordKind: z.literal("m7-r3-arm-evaluator-evidence"),
    campaignId: campaignIdSchema,
    arm: M7ArmV1Schema,
    caseCampaignAdmissionRecordSha256: Sha256DigestV1Schema,
    mutationRegistrationRecordSha256: Sha256DigestV1Schema,
    attemptBindingContentSha256: Sha256DigestV1Schema,
    evaluatorAssignmentId: z.string().regex(/^m6-assignment:[a-f0-9]{24}$/u),
    baselineSelectedTreeSha256: Sha256DigestV1Schema,
    candidateSelectedTreeSha256: Sha256DigestV1Schema,
    patchSha256: Sha256DigestV1Schema,
    outcome: z.enum(["accepted", "rejected", "infrastructure_failed"]),
    infrastructureFailureCode: z
      .enum([
        "assignment_mismatch",
        "fresh_copy_failed",
        "candidate_tree_mismatch",
        "runner_failed",
        "cleanup_failed",
        "invalid_runner_receipt",
        "agent_cleanup_not_proven",
      ])
      .nullable(),
    cleanupProven: z.boolean(),
    runs: z.array(ExternalHiddenFixFreshRunReceiptV1Schema).max(9),
  })
  .strict();

export const M7R3ArmEvaluatorEvidenceV1Schema = evaluatorEvidenceBasisSchema
  .extend({ recordContentSha256: Sha256DigestV1Schema })
  .strict()
  .superRefine((value, context) => {
    const expectedAssignmentId = `m6-assignment:${digest(
      `m7-local-evaluator\0${value.campaignId}`,
    ).slice(0, 24)}`;
    if (value.evaluatorAssignmentId !== expectedAssignmentId) {
      addIssue(
        context,
        ["evaluatorAssignmentId"],
        "R3 evaluator assignment crossed the frozen local mutation materials",
      );
    }
    const plan = freshPlan({
      campaignId: value.campaignId,
      arm: value.arm,
      assignmentId: value.evaluatorAssignmentId,
    });
    value.runs.forEach((run, index) => {
      const expected = plan[index];
      if (
        expected === undefined ||
        run.assignmentId !== value.evaluatorAssignmentId ||
        run.freshCopyId !== expected.freshCopyId ||
        run.ordinal !== expected.ordinal ||
        run.scenarioClass !== expected.scenarioClass ||
        run.repetition !== expected.repetition ||
        run.baselineSelectedTreeSha256 !== value.baselineSelectedTreeSha256 ||
        run.candidateSelectedTreeSha256 !== value.candidateSelectedTreeSha256 ||
        run.patchSha256 !== value.patchSha256
      ) {
        addIssue(
          context,
          ["runs", index],
          "R3 evaluator run crossed its canonical 3x3 plan or candidate",
        );
      }
    });
    const outcome =
      value.infrastructureFailureCode !== null || value.runs.length !== 9
        ? "infrastructure_failed"
        : value.runs.every((run) => run.outcome === "passed")
          ? "accepted"
          : "rejected";
    if (value.outcome !== outcome) {
      addIssue(
        context,
        ["outcome"],
        "R3 evaluator outcome must derive from all nine retained runs",
      );
    }
    if (
      (value.outcome === "infrastructure_failed") !==
      (value.infrastructureFailureCode !== null)
    ) {
      addIssue(
        context,
        ["infrastructureFailureCode"],
        "R3 evaluator infrastructure outcome requires its failure code",
      );
    }
    if (
      value.outcome !== "infrastructure_failed" &&
      (!value.cleanupProven || value.runs.some((run) => !run.cleanupProven))
    ) {
      addIssue(
        context,
        ["cleanupProven"],
        "R3 evaluated outcome requires cleanup from every fresh run",
      );
    }
    const { recordContentSha256, ...basis } = value;
    if (recordContentSha256 !== digestJson(basis)) {
      addIssue(
        context,
        ["recordContentSha256"],
        "R3 evaluator evidence hash does not match",
      );
    }
  });
export type M7R3ArmEvaluatorEvidenceV1 = z.infer<
  typeof M7R3ArmEvaluatorEvidenceV1Schema
>;

const createEvaluatorEvidence = (
  input: Omit<
    z.input<typeof evaluatorEvidenceBasisSchema>,
    "schemaVersion" | "recordKind"
  >,
): M7R3ArmEvaluatorEvidenceV1 => {
  const basis = evaluatorEvidenceBasisSchema.parse({
    schemaVersion: 1,
    recordKind: "m7-r3-arm-evaluator-evidence",
    ...input,
  });
  return M7R3ArmEvaluatorEvidenceV1Schema.parse({
    ...basis,
    recordContentSha256: digestJson(basis),
  });
};

const storedDeliveryTraceBasisSchema = z
  .object({
    schemaVersion: z.literal(1),
    recordKind: z.literal("m7-r3-gate-delivery-trace"),
    campaignId: campaignIdSchema,
    arm: M7ArmV1Schema,
    caseCampaignAdmissionRecordSha256: Sha256DigestV1Schema,
    attemptBindingContentSha256: Sha256DigestV1Schema,
    attemptEvidenceRecordSha256: Sha256DigestV1Schema.nullable(),
    availability: z.enum(["retained", "unavailable"]),
    unavailableReason: z
      .enum(["attempt_envelope_unavailable", "delivery_trace_unavailable"])
      .nullable(),
    trace: M7R3AgentDeliveryTraceV1Schema.nullable(),
  })
  .strict();

export const M7R3StoredDeliveryTraceV1Schema = storedDeliveryTraceBasisSchema
  .extend({ recordContentSha256: Sha256DigestV1Schema })
  .strict()
  .superRefine((value, context) => {
    const retained = value.trace !== null;
    if (
      retained !== (value.availability === "retained") ||
      retained !== (value.unavailableReason === null) ||
      (retained && value.attemptEvidenceRecordSha256 === null)
    ) {
      addIssue(
        context,
        ["availability"],
        "R3 delivery availability must match its trace and attempt sidecar",
      );
    }
    const { recordContentSha256, ...basis } = value;
    if (recordContentSha256 !== digestJson(basis)) {
      addIssue(
        context,
        ["recordContentSha256"],
        "R3 stored delivery trace hash does not match",
      );
    }
  });
export type M7R3StoredDeliveryTraceV1 = z.infer<
  typeof M7R3StoredDeliveryTraceV1Schema
>;

const createStoredDeliveryTrace = (input: {
  readonly campaignId: string;
  readonly arm: M7ArmV1;
  readonly caseCampaignAdmissionRecordSha256: Sha256DigestV1;
  readonly attemptBindingContentSha256: Sha256DigestV1;
  readonly attemptEvidenceRecordSha256: Sha256DigestV1 | null;
  readonly unavailableReason:
    "attempt_envelope_unavailable" | "delivery_trace_unavailable" | null;
  readonly trace: M7R3AgentDeliveryTraceV1 | null;
}): M7R3StoredDeliveryTraceV1 => {
  const basis = storedDeliveryTraceBasisSchema.parse({
    schemaVersion: 1,
    recordKind: "m7-r3-gate-delivery-trace",
    campaignId: input.campaignId,
    arm: input.arm,
    caseCampaignAdmissionRecordSha256: input.caseCampaignAdmissionRecordSha256,
    attemptBindingContentSha256: input.attemptBindingContentSha256,
    attemptEvidenceRecordSha256: input.attemptEvidenceRecordSha256,
    availability: input.trace === null ? "unavailable" : "retained",
    unavailableReason: input.unavailableReason,
    trace: input.trace,
  });
  return M7R3StoredDeliveryTraceV1Schema.parse({
    ...basis,
    recordContentSha256: digestJson(basis),
  });
};

export interface M7R3RuntimeUseEvidenceWriterV1 {
  readonly putAttemptOnce: (
    receipt: M7R3AgentAttemptEvidenceSidecarV1,
  ) => Promise<M7R3AgentAttemptEvidenceSidecarV1>;
  readonly putAttemptFailureOnce: (
    receipt: M7R3AgentAttemptFailureReceiptV1,
  ) => Promise<M7R3AgentAttemptFailureReceiptV1>;
  readonly putDeliveryTraceOnce: (
    receipt: M7R3StoredDeliveryTraceV1,
  ) => Promise<M7R3StoredDeliveryTraceV1>;
  readonly putRuntimeEvidenceOnce: (
    campaignId: string,
    receipt: M7R3RuntimeEvidenceReceiptV1,
  ) => Promise<M7R3RuntimeEvidenceReceiptV1>;
  readonly putTrajectoryUseOnce: (
    receipt: M7R3PatrolTrajectoryUseEvidenceV1,
  ) => Promise<M7R3PatrolTrajectoryUseEvidenceV1>;
  readonly putEvaluatorOnce: (
    receipt: M7R3ArmEvaluatorEvidenceV1,
  ) => Promise<M7R3ArmEvaluatorEvidenceV1>;
}

type EvidenceKind =
  | "runtime-attempt"
  | "code-only-attempt"
  | "runtime-attempt-failure"
  | "code-only-attempt-failure"
  | "runtime-delivery"
  | "code-only-delivery"
  | "runtime-evidence"
  | "runtime-trajectory-use"
  | "runtime-evaluator"
  | "code-only-evaluator";

const evidenceFile = (campaignId: string, kind: EvidenceKind): string =>
  `${digest(`${campaignId}\0${kind}`)}.${kind}.json`;

/** Strict create-once Host-only R3 evidence retention. */
export class M7R3RuntimeUseLocalEvidenceStoreV1 implements M7R3RuntimeUseEvidenceWriterV1 {
  readonly #root: string;
  readonly #identity: DirectoryIdentity;

  private constructor(root: string, identity: DirectoryIdentity) {
    this.#root = root;
    this.#identity = identity;
  }

  public static async open(input: {
    readonly root: string;
    readonly exposedRoots: readonly string[];
  }): Promise<M7R3RuntimeUseLocalEvidenceStoreV1> {
    const root = await requirePrivateDirectory(
      input.root,
      "M7 R3 local evidence root",
    );
    for (const [index, exposedRoot] of input.exposedRoots.entries()) {
      const exposed = await requireCanonicalDirectory(
        exposedRoot,
        `M7 R3 Agent-exposed root ${index + 1}`,
      );
      if (
        pathWithinOrEqual(root.path, exposed.path) ||
        pathWithinOrEqual(exposed.path, root.path)
      ) {
        throw new Error(
          "M7 R3 evidence root must be disjoint from Agent-exposed roots",
        );
      }
    }
    return new M7R3RuntimeUseLocalEvidenceStoreV1(root.path, root.identity);
  }

  public get root(): string {
    return this.#root;
  }

  async #writeOnce(
    campaignIdInput: string,
    kind: EvidenceKind,
    value: JsonValue,
  ): Promise<void> {
    const campaignId = campaignIdSchema.parse(campaignIdInput);
    await requireDirectoryIdentity(this.#root, this.#identity);
    const filename = evidenceFile(campaignId, kind);
    const bytes = Buffer.from(`${canonicalJson(value)}\n`);
    try {
      await publishPrivateFileOnceV1({
        root: this.#root,
        filename,
        bytes,
      });
    } catch (error) {
      if (isNodeError(error) && error.code === "EEXIST") {
        throw new Error(`M7 R3 ${kind} already exists; retry is forbidden`, {
          cause: error,
        });
      }
      throw error;
    }
    const rootHandle = await open(
      this.#root,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      await rootHandle.sync();
    } finally {
      await rootHandle.close();
    }
  }

  async #read(campaignIdInput: string, kind: EvidenceKind): Promise<unknown> {
    const campaignId = campaignIdSchema.parse(campaignIdInput);
    await requireDirectoryIdentity(this.#root, this.#identity);
    const path = resolve(this.#root, evidenceFile(campaignId, kind));
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const [metadata, pathMetadata, canonical] = await Promise.all([
        handle.stat(),
        lstat(path),
        realpath(path),
      ]);
      if (
        !metadata.isFile() ||
        metadata.nlink !== 1 ||
        metadata.uid !== requireEffectiveUserId() ||
        (metadata.mode & 0o7777) !== PRIVATE_FILE_MODE ||
        metadata.size > RECORD_BYTE_LIMIT ||
        pathMetadata.isSymbolicLink() ||
        pathMetadata.dev !== metadata.dev ||
        pathMetadata.ino !== metadata.ino ||
        canonical !== path
      ) {
        throw new Error("M7 R3 evidence identity changed");
      }
      return JSON.parse(
        new TextDecoder("utf8", { fatal: true }).decode(
          await handle.readFile(),
        ),
      ) as unknown;
    } finally {
      await handle.close();
    }
  }

  public async putAttemptOnce(
    receiptInput: M7R3AgentAttemptEvidenceSidecarV1,
  ): Promise<M7R3AgentAttemptEvidenceSidecarV1> {
    const receipt = M7R3AgentAttemptEvidenceSidecarV1Schema.parse(receiptInput);
    await this.#writeOnce(
      receipt.campaignId,
      receipt.arm === "runtime_enabled"
        ? "runtime-attempt"
        : "code-only-attempt",
      JsonValueSchema.parse(receipt),
    );
    return receipt;
  }

  public async putAttemptFailureOnce(
    receiptInput: M7R3AgentAttemptFailureReceiptV1,
  ): Promise<M7R3AgentAttemptFailureReceiptV1> {
    const receipt = M7R3AgentAttemptFailureReceiptV1Schema.parse(receiptInput);
    await this.#writeOnce(
      receipt.campaignId,
      receipt.arm === "runtime_enabled"
        ? "runtime-attempt-failure"
        : "code-only-attempt-failure",
      JsonValueSchema.parse(receipt),
    );
    return receipt;
  }

  public async putDeliveryTraceOnce(
    receiptInput: M7R3StoredDeliveryTraceV1,
  ): Promise<M7R3StoredDeliveryTraceV1> {
    const receipt = M7R3StoredDeliveryTraceV1Schema.parse(receiptInput);
    await this.#writeOnce(
      receipt.campaignId,
      receipt.arm === "runtime_enabled"
        ? "runtime-delivery"
        : "code-only-delivery",
      JsonValueSchema.parse(receipt),
    );
    return receipt;
  }

  public async putTrajectoryUseOnce(
    receiptInput: M7R3PatrolTrajectoryUseEvidenceV1,
  ): Promise<M7R3PatrolTrajectoryUseEvidenceV1> {
    const receipt = M7R3PatrolTrajectoryUseEvidenceV1Schema.parse(receiptInput);
    await this.#writeOnce(
      receipt.campaignId,
      "runtime-trajectory-use",
      JsonValueSchema.parse(receipt),
    );
    return receipt;
  }

  public async putRuntimeEvidenceOnce(
    campaignId: string,
    receiptInput: M7R3RuntimeEvidenceReceiptV1,
  ): Promise<M7R3RuntimeEvidenceReceiptV1> {
    const receipt = M7R3RuntimeEvidenceReceiptV1Schema.parse(receiptInput);
    await this.#writeOnce(
      campaignId,
      "runtime-evidence",
      JsonValueSchema.parse(receipt),
    );
    return receipt;
  }

  public async putEvaluatorOnce(
    receiptInput: M7R3ArmEvaluatorEvidenceV1,
  ): Promise<M7R3ArmEvaluatorEvidenceV1> {
    const receipt = M7R3ArmEvaluatorEvidenceV1Schema.parse(receiptInput);
    await this.#writeOnce(
      receipt.campaignId,
      receipt.arm === "runtime_enabled"
        ? "runtime-evaluator"
        : "code-only-evaluator",
      JsonValueSchema.parse(receipt),
    );
    return receipt;
  }

  public async readAttempt(
    campaignId: string,
    arm: M7ArmV1,
  ): Promise<M7R3AgentAttemptEvidenceSidecarV1> {
    return M7R3AgentAttemptEvidenceSidecarV1Schema.parse(
      await this.#read(
        campaignId,
        arm === "runtime_enabled" ? "runtime-attempt" : "code-only-attempt",
      ),
    );
  }

  public async readAttemptFailure(
    campaignId: string,
    arm: M7ArmV1,
  ): Promise<M7R3AgentAttemptFailureReceiptV1> {
    return M7R3AgentAttemptFailureReceiptV1Schema.parse(
      await this.#read(
        campaignId,
        arm === "runtime_enabled"
          ? "runtime-attempt-failure"
          : "code-only-attempt-failure",
      ),
    );
  }

  public async readDeliveryTrace(
    campaignId: string,
    arm: M7ArmV1 = "runtime_enabled",
  ): Promise<M7R3StoredDeliveryTraceV1> {
    return M7R3StoredDeliveryTraceV1Schema.parse(
      await this.#read(
        campaignId,
        arm === "runtime_enabled" ? "runtime-delivery" : "code-only-delivery",
      ),
    );
  }

  public async readTrajectoryUse(
    campaignId: string,
  ): Promise<M7R3PatrolTrajectoryUseEvidenceV1> {
    return M7R3PatrolTrajectoryUseEvidenceV1Schema.parse(
      await this.#read(campaignId, "runtime-trajectory-use"),
    );
  }

  public async readRuntimeEvidence(
    campaignId: string,
  ): Promise<M7R3RuntimeEvidenceReceiptV1> {
    return M7R3RuntimeEvidenceReceiptV1Schema.parse(
      await this.#read(campaignId, "runtime-evidence"),
    );
  }

  public async readEvaluator(
    campaignId: string,
    arm: M7ArmV1,
  ): Promise<M7R3ArmEvaluatorEvidenceV1> {
    return M7R3ArmEvaluatorEvidenceV1Schema.parse(
      await this.#read(
        campaignId,
        arm === "runtime_enabled" ? "runtime-evaluator" : "code-only-evaluator",
      ),
    );
  }
}

export interface M7R3HiddenEvaluatorRequestV1 {
  readonly schemaVersion: 1;
  readonly campaignId: string;
  readonly arm: M7ArmV1;
  readonly caseCampaignAdmissionRecordSha256: Sha256DigestV1;
  readonly mutationRegistrationRecordSha256: Sha256DigestV1;
  readonly baselineLookup: {
    readonly schemaVersion: 1;
    readonly campaignId: string;
    readonly mutationRegistrationRecordSha256: Sha256DigestV1;
  };
  readonly patch: ExternalHiddenFixPatchReferenceV1;
  readonly expectedCandidateSelectedTreeSha256: Sha256DigestV1;
  readonly plan: ExternalHiddenFixFreshCopyRunInputV1["plan"];
}

export interface M7R3HiddenEvaluatorPortV1 {
  readonly runFreshCopy: (
    request: M7R3HiddenEvaluatorRequestV1,
    signal?: AbortSignal,
  ) => Promise<unknown>;
}

export interface M7R3HostMutationResolverV1 {
  readonly resolve: (
    campaignId: string,
    registration: M7MutationRegistrationV1,
  ) => Promise<M7LocalMutationMaterialsV1>;
}

/**
 * Production adapter around the existing local fresh-copy runner. Baseline
 * paths and hidden evaluator paths are resolved inside this Host closure and
 * never enter the Gate's public evaluator request.
 */
export const createM7R3LocalHiddenEvaluatorPortV1 = (input: {
  readonly campaignId: string;
  readonly registration: M7MutationRegistrationV1;
  readonly mutationResolver: M7R3HostMutationResolverV1;
  readonly runner: ExternalHiddenFixFreshCopyRunnerV1;
}): M7R3HiddenEvaluatorPortV1 => {
  const campaignId = campaignIdSchema.parse(input.campaignId);
  let resolved: Promise<M7LocalMutationMaterialsV1> | null = null;
  const materials = async (): Promise<M7LocalMutationMaterialsV1> => {
    resolved ??= input.mutationResolver
      .resolve(campaignId, input.registration)
      .then((value) => M7LocalMutationMaterialsV1Schema.parse(value));
    const record = await resolved;
    if (
      record.campaignId !== campaignId ||
      record.mutationRegistrationSha256 !==
        input.registration.recordContentSha256 ||
      record.baselineSelectedTreeSha256 !==
        input.registration.mutatedBaselineSelectedTreeSha256 ||
      record.evaluatorImplementationSha256 !==
        input.registration.evaluatorImplementationSha256 ||
      record.evaluatorBundleSha256 !== input.registration.evaluatorBundleSha256
    ) {
      throw new Error("R3 evaluator materials crossed their campaign");
    }
    return record;
  };
  return Object.freeze({
    async runFreshCopy(
      request: M7R3HiddenEvaluatorRequestV1,
      signal?: AbortSignal,
    ): Promise<unknown> {
      if (
        request.campaignId !== campaignId ||
        request.baselineLookup.campaignId !== campaignId ||
        request.mutationRegistrationRecordSha256 !==
          input.registration.recordContentSha256 ||
        request.baselineLookup.mutationRegistrationRecordSha256 !==
          input.registration.recordContentSha256
      ) {
        throw new Error("R3 hidden evaluator request crossed its campaign");
      }
      const record = await materials();
      return input.runner.runFreshCopy(
        {
          assignmentId: record.evaluatorAssignmentId,
          baselineRoot: record.baselineRoot,
          baselineSelectedTreeSha256: record.baselineSelectedTreeSha256,
          evaluatorImplementationPath: record.evaluatorImplementationPath,
          evaluatorImplementationSha256: record.evaluatorImplementationSha256,
          evaluatorBundlePath: record.evaluatorBundlePath,
          evaluatorBundleSha256: record.evaluatorBundleSha256,
          patch: request.patch,
          expectedCandidateSelectedTreeSha256:
            request.expectedCandidateSelectedTreeSha256,
          plan: request.plan,
        },
        signal,
      );
    },
  });
};

interface EvaluatorRunResult {
  readonly evidence: M7R3ArmEvaluatorEvidenceV1;
}

type EvaluatorFailure = NonNullable<
  M7R3ArmEvaluatorEvidenceV1["infrastructureFailureCode"]
>;

const runEvaluator = async (input: {
  readonly campaignId: string;
  readonly arm: M7ArmV1;
  readonly admission: M7R3CaseCampaignAdmissionV1;
  readonly registration: M7MutationRegistrationV1;
  readonly attemptBindingContentSha256: Sha256DigestV1;
  readonly candidate: M7CandidatePatchV1;
  readonly patch: ExternalHiddenFixPatchReferenceV1;
  readonly evaluator: M7R3HiddenEvaluatorPortV1;
  readonly signal?: AbortSignal | undefined;
}): Promise<EvaluatorRunResult> => {
  const assignmentId = `m6-assignment:${digest(
    `m7-local-evaluator\0${input.campaignId}`,
  ).slice(0, 24)}`;
  const plan = freshPlan({
    campaignId: input.campaignId,
    arm: input.arm,
    assignmentId,
  });
  const runs: z.infer<typeof ExternalHiddenFixFreshRunReceiptV1Schema>[] = [];
  let infrastructureFailureCode: EvaluatorFailure | null = null;
  let cleanupProven = true;
  for (const entry of plan) {
    try {
      const run = ExternalHiddenFixFreshRunReceiptV1Schema.parse(
        await input.evaluator.runFreshCopy(
          {
            schemaVersion: 1,
            campaignId: input.campaignId,
            arm: input.arm,
            caseCampaignAdmissionRecordSha256:
              input.admission.recordContentSha256,
            mutationRegistrationRecordSha256:
              input.registration.recordContentSha256,
            baselineLookup: {
              schemaVersion: 1,
              campaignId: input.campaignId,
              mutationRegistrationRecordSha256:
                input.registration.recordContentSha256,
            },
            patch: input.patch,
            expectedCandidateSelectedTreeSha256:
              input.candidate.candidateSelectedTreeSha256,
            plan: entry,
          },
          input.signal,
        ),
      );
      if (
        run.assignmentId !== assignmentId ||
        run.freshCopyId !== entry.freshCopyId ||
        run.ordinal !== entry.ordinal ||
        run.scenarioClass !== entry.scenarioClass ||
        run.repetition !== entry.repetition ||
        run.baselineSelectedTreeSha256 !==
          input.registration.mutatedBaselineSelectedTreeSha256 ||
        run.candidateSelectedTreeSha256 !==
          input.candidate.candidateSelectedTreeSha256 ||
        run.patchSha256 !== input.candidate.patchSha256
      ) {
        infrastructureFailureCode = "invalid_runner_receipt";
        cleanupProven &&= run.cleanupProven;
        break;
      }
      runs.push(run);
      cleanupProven &&= run.cleanupProven;
      if (!run.cleanupProven) {
        infrastructureFailureCode = "cleanup_failed";
        break;
      }
    } catch (error) {
      infrastructureFailureCode =
        error instanceof ExternalHiddenFixFreshCopyInfrastructureErrorV1
          ? error.failureCode
          : error instanceof z.ZodError
            ? "invalid_runner_receipt"
            : "runner_failed";
      cleanupProven &&=
        error instanceof ExternalHiddenFixFreshCopyInfrastructureErrorV1
          ? error.cleanupProven
          : false;
      break;
    }
  }
  const outcome =
    infrastructureFailureCode !== null || runs.length !== 9
      ? "infrastructure_failed"
      : runs.every((run) => run.outcome === "passed")
        ? "accepted"
        : "rejected";
  return {
    evidence: createEvaluatorEvidence({
      campaignId: input.campaignId,
      arm: input.arm,
      caseCampaignAdmissionRecordSha256: input.admission.recordContentSha256,
      mutationRegistrationRecordSha256: input.registration.recordContentSha256,
      attemptBindingContentSha256: input.attemptBindingContentSha256,
      evaluatorAssignmentId: assignmentId,
      baselineSelectedTreeSha256:
        input.registration.mutatedBaselineSelectedTreeSha256,
      candidateSelectedTreeSha256: input.candidate.candidateSelectedTreeSha256,
      patchSha256: input.candidate.patchSha256,
      outcome,
      infrastructureFailureCode,
      cleanupProven,
      runs,
    }),
  };
};

const validateCampaignBindings = (input: {
  readonly campaignId: string;
  readonly registration: M7MutationRegistrationV1;
  readonly admission: M7R3CaseCampaignAdmissionV1;
  readonly contract: M7R3PairedCaseContractV1;
  readonly authoritativeSensorFreezeRecordSha256: Sha256DigestV1;
}): void => {
  const { admission, contract, registration } = input;
  if (
    admission.campaignId !== input.campaignId ||
    admission.mutationRegistrationRecordSha256 !==
      registration.recordContentSha256 ||
    admission.mutant.mutationSha256 !== registration.mutationSha256 ||
    admission.mutant.mutatedBaselineSelectedTreeSha256 !==
      registration.mutatedBaselineSelectedTreeSha256 ||
    admission.mutant.mutatedBuildSourceSha256 !==
      registration.mutatedBaselineSelectedTreeSha256 ||
    admission.mutant.mutatedBuildSourceIdentitySha256 !==
      registration.mutatedBuildSourceIdentitySha256 ||
    admission.adapterMutantCompatibilityReceiptSha256 !==
      registration.adapterMutantCompatibilityReceiptSha256 ||
    admission.authoritativeSensorFreezeRecordSha256 !==
      input.authoritativeSensorFreezeRecordSha256 ||
    admission.portfolioId !== contract.portfolioId ||
    admission.caseId !== contract.caseId ||
    admission.pairedProtocol.pairedCaseContractContentSha256 !==
      contract.pairedCaseContractContentSha256 ||
    admission.pairedProtocol.pairedPublicTaskContractSha256 !==
      contract.pairedPublicTaskContractSha256 ||
    admission.pairedProtocol.runtimeArmPublicTaskSpecSha256 !==
      contract.runtimeArmPublicTaskSpecSha256 ||
    admission.pairedProtocol.codeOnlyArmPublicTaskSpecSha256 !==
      contract.codeOnlyArmPublicTaskSpecSha256 ||
    admission.prompt.utf8Sha256 !== contract.naturalPrompt.utf8Sha256 ||
    admission.prompt.canonicalJsonSha256 !==
      contract.naturalPrompt.canonicalJsonSha256 ||
    admission.trajectory.classifierFreezeRecordSha256 !==
      contract.commonRuntimeMaterials.trajectoryClassifierFreezeRecordSha256 ||
    admission.trajectory.classifierImplementationSha256 !==
      contract.trajectoryCaseSpec.classifierImplementationSha256 ||
    admission.trajectory.classifierConfigSha256 !==
      contract.trajectoryCaseSpec.classifierConfigSha256 ||
    admission.trajectory.caseSpecId !== contract.trajectoryCaseSpec.caseId ||
    admission.trajectory.caseSpecSha256 !==
      contract.trajectoryCaseSpec.caseSpecSha256 ||
    registration.publicTaskSpecSha256 !==
      contract.pairedPublicTaskContractSha256 ||
    registration.provider !== contract.agentConfiguration.provider ||
    registration.model !== contract.agentConfiguration.model ||
    registration.thinkingLevel !== contract.agentConfiguration.thinkingLevel ||
    registration.agentBudgetSha256 !==
      contract.agentConfiguration.agentBudgetSha256 ||
    registration.codingToolSetSha256 !==
      contract.agentConfiguration.codingToolSetSha256 ||
    registration.sandboxPolicySha256 !==
      contract.agentConfiguration.sandboxPolicySha256 ||
    registration.runtimeGameToolSetSha256 !==
      contract.commonRuntimeMaterials.validatedGameToolSetSha256
  ) {
    throw new Error("M7 R3 Gate crossed its admitted case campaign");
  }
};

const validateAttempt = (input: {
  readonly arm: M7ArmV1;
  readonly claim: M7ArmClaimV1;
  readonly admission: M7R3LocalArmAdmissionV1;
  readonly caseAdmission: M7R3CaseCampaignAdmissionV1;
  readonly contract: M7R3PairedCaseContractV1;
  readonly registration: M7MutationRegistrationV1;
  readonly envelope: M7R3LocalArmRunEnvelopeV1;
}): void => {
  const binding = input.envelope.attempt.binding;
  const expectedTaskSpec =
    input.arm === "runtime_enabled"
      ? input.contract.runtimeArmPublicTaskSpecSha256
      : input.contract.codeOnlyArmPublicTaskSpecSha256;
  if (
    input.envelope.arm !== input.arm ||
    input.admission.arm !== input.arm ||
    input.admission.caseCampaignAdmissionRecordSha256 !==
      input.caseAdmission.recordContentSha256 ||
    input.admission.pairedCaseContractContentSha256 !==
      input.contract.pairedCaseContractContentSha256 ||
    input.admission.pairedAttemptBindingContentSha256 !==
      binding.bindingContentSha256 ||
    !sameJson(input.admission.pairedAttemptBinding, binding) ||
    binding.campaignId !== input.claim.campaignId ||
    binding.arm !== input.arm ||
    binding.attemptOrdinal !== 1 ||
    binding.userTurnsMaximum !== 1 ||
    binding.caseCampaignAdmissionRecordSha256 !==
      input.caseAdmission.recordContentSha256 ||
    binding.pairedCaseContractContentSha256 !==
      input.contract.pairedCaseContractContentSha256 ||
    binding.promptUtf8Sha256 !== input.contract.naturalPrompt.utf8Sha256 ||
    binding.promptCanonicalJsonSha256 !==
      input.contract.naturalPrompt.canonicalJsonSha256 ||
    binding.publicTaskSpecSha256 !== expectedTaskSpec ||
    binding.pairedPublicTaskContractSha256 !==
      input.claim.binding.publicTaskSpecSha256 ||
    binding.provider !== input.claim.binding.provider ||
    binding.model !== input.claim.binding.model ||
    binding.thinkingLevel !== input.claim.binding.thinkingLevel ||
    binding.agentBudgetSha256 !== input.claim.binding.agentBudgetSha256 ||
    binding.baselineSelectedTreeSha256 !==
      input.registration.mutatedBaselineSelectedTreeSha256 ||
    binding.codingToolSetSha256 !== input.claim.binding.codingToolSetSha256 ||
    binding.commonEnvironmentInstructionsSha256 !==
      input.contract.commonRuntimeMaterials
        .commonEnvironmentInstructionsSha256 ||
    binding.hostModelRuntimeConfigSha256 !==
      input.contract.commonRuntimeMaterials.hostModelRuntimeConfigSha256 ||
    binding.sandboxProfileSha256 !== input.claim.binding.sandboxPolicySha256 ||
    binding.isolation.taskId !== input.claim.taskId ||
    binding.isolation.sessionInstanceSha256 !==
      input.claim.sessionIdentitySha256 ||
    binding.isolation.workspaceInstanceSha256 !==
      input.claim.workspaceIdentitySha256 ||
    binding.isolation.cacheInstanceSha256 !== input.claim.cacheIdentitySha256 ||
    binding.isolation.workspaceBaselineSelectedTreeSha256 !==
      input.registration.mutatedBaselineSelectedTreeSha256
  ) {
    throw new Error("M7 R3 attempt crossed its arm admission or claim");
  }
  if (input.arm === "runtime_enabled") {
    const surface = binding.runtimeSurface;
    if (
      surface === null ||
      surface.sensorFreezeRecordSha256 !==
        input.caseAdmission.authoritativeSensorFreezeRecordSha256 ||
      surface.pristineAdapterRevisionSha256 !==
        input.contract.commonRuntimeMaterials.adapterRevisionSha256 ||
      surface.pristineAdapterPackageSha256 !==
        input.contract.commonRuntimeMaterials.adapterPackageSha256 ||
      surface.pristineAdapterConformanceReceiptSha256 !==
        input.contract.commonRuntimeMaterials
          .pristineAdapterConformanceReceiptSha256 ||
      surface.admittedGameToolSetSha256 !==
        input.registration.runtimeGameToolSetSha256 ||
      surface.runtimeResourceMap.baselineSourceId !==
        input.caseAdmission.mutant.mutatedBuildSourceId ||
      surface.trajectory.classifierFreezeRecordSha256 !==
        input.caseAdmission.trajectory.classifierFreezeRecordSha256 ||
      surface.trajectory.classifierImplementationSha256 !==
        input.caseAdmission.trajectory.classifierImplementationSha256 ||
      surface.trajectory.classifierConfigSha256 !==
        input.caseAdmission.trajectory.classifierConfigSha256 ||
      surface.trajectory.caseSpecId !==
        input.caseAdmission.trajectory.caseSpecId ||
      surface.trajectory.caseSpecSha256 !==
        input.caseAdmission.trajectory.caseSpecSha256
    ) {
      throw new Error("M7 R3 runtime surface crossed its frozen identities");
    }
  } else if (binding.runtimeSurface !== null) {
    throw new Error("M7 R3 code-only attempt received a runtime surface");
  }
};

const candidateFromAttempt = (input: {
  readonly registration: M7MutationRegistrationV1;
  readonly attempt: M7R3PairedAgentAttemptRecordV1;
}): Readonly<{
  outcome: "no_candidate" | "invalid_candidate" | "valid_candidate";
  candidate: M7CandidatePatchV1 | null;
  patch: ExternalHiddenFixPatchReferenceV1 | null;
}> => {
  const patch = input.attempt.result?.candidatePatch ?? null;
  if (patch === null) {
    return { outcome: "no_candidate", candidate: null, patch: null };
  }
  if (!patch.admissible || !patch.roundTripVerified) {
    return { outcome: "invalid_candidate", candidate: null, patch: null };
  }
  if (
    patch.patchIdentity.baselineSelectedTreeSha256 !==
      input.registration.mutatedBaselineSelectedTreeSha256 ||
    patch.patchIdentity.patchSha256 !== patch.patch.rawSha256 ||
    patch.patchIdentity.byteLength !== patch.patch.byteLength
  ) {
    throw new Error("M7 R3 candidate patch crossed its baseline or bytes");
  }
  return {
    outcome: "valid_candidate",
    patch: patch.patch,
    candidate: {
      schemaVersion: 1,
      baselineSelectedTreeSha256:
        patch.patchIdentity.baselineSelectedTreeSha256,
      candidateSelectedTreeSha256:
        patch.patchIdentity.candidateSelectedTreeSha256,
      patchSha256: patch.patchIdentity.patchSha256,
      byteLength: patch.patchIdentity.byteLength,
      roundTripVerified: true,
    },
  };
};

const recomputeTrajectorySummaries = (input: {
  readonly result: Extract<
    M7R3PairedAgentArmResultV1,
    { readonly arm: "runtime_enabled" }
  >;
  readonly runtimeEvidence: M7R3RuntimeEvidenceReceiptV1;
  readonly trace: M7R3AgentDeliveryTraceV1;
  readonly contract: M7R3PairedCaseContractV1;
  readonly admission: M7R3CaseCampaignAdmissionV1;
  readonly attemptBinding: z.infer<
    typeof M7R3PairedAgentAttemptBindingV1Schema
  >;
}): readonly M7R3PatrolTrajectoryExecutionSummaryV1[] => {
  const receipt = M7R3RuntimeEvidenceReceiptV1Schema.parse(
    input.runtimeEvidence,
  );
  if (
    input.trace.integrityFailures.length > 0 ||
    input.result.runtimeEvidenceReceiptSha256 !== receipt.recordContentSha256 ||
    receipt.campaignId !== input.result.campaignId ||
    receipt.portfolioId !== input.result.portfolioId ||
    receipt.caseId !== input.result.caseId ||
    receipt.caseCampaignAdmissionRecordSha256 !==
      input.admission.recordContentSha256 ||
    receipt.pairedCaseContractContentSha256 !==
      input.contract.pairedCaseContractContentSha256 ||
    receipt.attemptBindingContentSha256 !==
      input.attemptBinding.bindingContentSha256 ||
    receipt.arm !== "runtime_enabled" ||
    receipt.attemptOrdinal !== 1 ||
    input.result.agentDeliveryTraceRecordSha256 !==
      input.trace.recordContentSha256 ||
    !sameJson(receipt.agentDeliveryTrace, input.trace) ||
    receipt.baselineSelectedTreeSha256 !==
      input.admission.mutant.mutatedBaselineSelectedTreeSha256 ||
    !sameJson(receipt.executions, input.result.executions) ||
    receipt.sourceObservations.some(
      (observation) =>
        !input.result.sourceObservations.some((retained) =>
          sameJson(retained, observation),
        ),
    )
  ) {
    throw new Error(
      "M7 R3 runtime evidence crossed its result or full Pi delivery trace",
    );
  }
  const exchanges: M7AgentGameToolExchangeV1[] = receipt.exchanges.map(
    (entry) => ({
      schemaVersion: 1,
      ordinal: entry.ordinal,
      toolCallId: entry.toolCallId,
      toolName: entry.toolName as M7AgentGameToolExchangeV1["toolName"],
      input: entry.input,
      response: entry.responseDetails,
      observedAt: entry.observedAt,
      hostToolReturnOrdinal: entry.hostToolReturnOrdinal,
    }),
  );
  const publicExchangeProjection = exchanges.map((exchange) =>
    createM7AgentVisibleGameToolExchangeHashV1(exchange),
  );
  if (
    !sameJson(
      publicExchangeProjection,
      input.result.agentVisibleGameToolExchanges,
    ) ||
    receipt.exchangeTranscriptSha256 !== digestJson(exchanges)
  ) {
    throw new Error(
      "M7 R3 exact runtime exchanges crossed their public result projection",
    );
  }
  const runtimeSurface = input.attemptBinding.runtimeSurface;
  if (runtimeSurface === null) {
    throw new Error("M7 R3 runtime evidence lost its runtime surface");
  }
  const summaries: M7R3PatrolTrajectoryExecutionSummaryV1[] = [];
  for (const material of receipt.trajectoryMaterials) {
    const execution = receipt.executions.find(
      (entry) => entry.executionId === material.lineage.executionId,
    );
    const baselineMaterial =
      material.lineage.sourceSha256 ===
      input.admission.mutant.mutatedBaselineSelectedTreeSha256;
    if (
      execution === undefined ||
      material.lineage.taskId !== input.attemptBinding.isolation.taskId ||
      material.lineage.adapterRevisionId !==
        runtimeSurface.pristineAdapterRevisionId ||
      (baselineMaterial
        ? material.lineage.adapterCompatibilityReceiptSha256 !==
          input.admission.adapterMutantCompatibilityReceiptSha256
        : material.lineage.adapterCompatibilityReceiptSha256 ===
          input.admission.adapterMutantCompatibilityReceiptSha256) ||
      material.lineage.buildId !== execution.buildId ||
      material.lineage.sourceSha256 !== execution.sourceSha256 ||
      material.startedAt !== execution.startedAt ||
      material.endedAt !== execution.endedAt ||
      material.sealed !== execution.sealed ||
      material.coverageComplete !== execution.coverageComplete ||
      material.cleanup.proven !== execution.cleanupProven
    ) {
      throw new Error(
        "M7 R3 trajectory material crossed its public execution lineage",
      );
    }
    if (!material.sealed || material.executionSealSha256 === null) continue;
    const prefix = classifyM7R3EarliestAgentVisibleTrajectoryPrefixV1({
      executionId: execution.executionId,
      exchanges,
      deliveryTrace: input.trace,
      expectedWitnessKinds:
        execution.sourceSha256 ===
        input.admission.mutant.mutatedBaselineSelectedTreeSha256
          ? input.contract.trajectoryCaseSpec.expectedBaselineWitnessKinds
          : input.contract.trajectoryCaseSpec.expectedRecoveryWitnessKinds,
      classifierConfig: input.contract.trajectoryClassifierConfig,
    });
    if (prefix === null) continue;
    summaries.push(
      createM7R3PatrolTrajectoryExecutionSummaryV1({
        lineage: material.lineage,
        startedAt: material.startedAt,
        endedAt: material.endedAt,
        executionSealSha256: material.executionSealSha256,
        runtimeObservationReceiptSha256:
          material.runtimeObservationReceiptSha256,
        classifierImplementationSha256:
          input.contract.trajectoryCaseSpec.classifierImplementationSha256,
        classifierConfig: input.contract.trajectoryClassifierConfig,
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
          input.trace.firstHostObservedSourceChange,
        coverageComplete: material.coverageComplete,
        coverageReceiptSha256: material.coverageReceiptSha256,
        loss: material.loss,
        cleanup: material.cleanup,
      }),
    );
  }
  const recomputedByHash = new Map(
    summaries.map((summary) => [summary.summarySha256, summary] as const),
  );
  if (
    input.result.trajectorySummaries.some((summary) => {
      const recomputed = recomputedByHash.get(summary.summarySha256);
      return recomputed === undefined || !sameJson(recomputed, summary);
    })
  ) {
    throw new Error(
      "M7 R3 published trajectory summary disagreed with raw Host evidence",
    );
  }
  return Object.freeze(summaries);
};

const candidateSourceIdentity = (input: {
  readonly summaries: readonly M7R3PatrolTrajectoryExecutionSummaryV1[];
  readonly candidateSelectedTreeSha256: Sha256DigestV1 | null;
}): {
  readonly buildId: z.infer<typeof BuildIdSchema>;
  readonly sourceId: z.infer<typeof SourceIdSchema>;
  readonly sourceSha256: Sha256DigestV1;
} | null => {
  if (input.candidateSelectedTreeSha256 === null) return null;
  const identities = new Map<
    string,
    {
      readonly buildId: z.infer<typeof BuildIdSchema>;
      readonly sourceId: z.infer<typeof SourceIdSchema>;
      readonly sourceSha256: Sha256DigestV1;
    }
  >();
  for (const summary of input.summaries) {
    if (summary.lineage.sourceSha256 === input.candidateSelectedTreeSha256) {
      const identity = {
        buildId: summary.lineage.buildId,
        sourceId: summary.lineage.sourceId,
        sourceSha256: summary.lineage.sourceSha256,
      };
      identities.set(canonicalJson(identity), identity);
    }
  }
  return identities.size === 1 ? [...identities.values()][0]! : null;
};

const retainSame = async <T>(
  promised: Promise<T>,
  expected: T,
  label: string,
): Promise<T> => {
  const retained = await promised;
  if (!sameJson(retained, expected)) {
    throw new Error(`M7 R3 evidence writer changed ${label}`);
  }
  return retained;
};

const infrastructureResult = (input: {
  readonly campaignId: string;
  readonly arm: M7ArmV1;
  readonly claim: M7ArmClaimV1;
  readonly observedTurnCount: 0 | 1;
  readonly cleanupProven: boolean;
  readonly cleanupReceiptSha256: Sha256DigestV1 | null;
  readonly runtimeUseReceiptSha256?: Sha256DigestV1 | null;
  readonly completedAt: string;
}): M7ArmResultV1 =>
  createM7ArmResultV1({
    campaignId: input.campaignId,
    arm: input.arm,
    armClaimSha256: input.claim.recordContentSha256,
    observedTurnCount: input.observedTurnCount,
    loopOutcome: "infrastructure_failed",
    candidateOutcome: "no_candidate",
    candidate: null,
    runtimeUseOutcome:
      input.arm === "runtime_enabled"
        ? "infrastructure_failed"
        : "not_applicable",
    runtimeUseReceiptSha256:
      input.arm === "runtime_enabled"
        ? (input.runtimeUseReceiptSha256 ?? null)
        : null,
    evaluatorOutcome: "not_run_agent_failure",
    evaluatorReceiptSha256: null,
    freshRunReferences: [],
    cleanupProven: input.cleanupProven,
    cleanupReceiptSha256: input.cleanupReceiptSha256,
    completedAt: input.completedAt,
  });

const retainUnavailableTrajectoryUse = async (input: {
  readonly campaignId: string;
  readonly contract: M7R3PairedCaseContractV1;
  readonly binding: z.infer<typeof M7R3PairedAgentAttemptBindingV1Schema>;
  readonly runtimeEvidenceReceiptSha256: Sha256DigestV1 | null;
  readonly attemptEvidenceReceiptSha256: Sha256DigestV1 | null;
  readonly firstHostObservedSourceChange: M7R3AgentDeliveryTraceV1["firstHostObservedSourceChange"];
  readonly evidenceWriter: M7R3RuntimeUseEvidenceWriterV1;
  readonly now: () => string;
}): Promise<M7R3PatrolTrajectoryUseEvidenceV1> => {
  const surface = input.binding.runtimeSurface;
  if (surface === null) {
    throw new Error("R3 unavailable trajectory index lost its runtime surface");
  }
  const receipt = deriveM7R3PatrolTrajectoryUseEvidenceV1({
    campaignId: input.campaignId,
    caseSpec: input.contract.trajectoryCaseSpec,
    attemptBindingContentSha256: input.binding.bindingContentSha256,
    runtimeEvidenceReceiptSha256: input.runtimeEvidenceReceiptSha256,
    attemptEvidenceReceiptSha256: input.attemptEvidenceReceiptSha256,
    baselineIdentity: {
      buildId: BuildIdSchema.parse(surface.runtimeResourceMap.baselineBuildId),
      sourceId: SourceIdSchema.parse(
        surface.runtimeResourceMap.baselineSourceId,
      ),
      sourceSha256: input.binding.baselineSelectedTreeSha256,
    },
    candidateIdentity: null,
    firstHostObservedSourceChange: input.firstHostObservedSourceChange,
    summaries: [],
    derivedAt: input.now(),
  });
  return retainSame(
    input.evidenceWriter.putTrajectoryUseOnce(receipt),
    receipt,
    "unavailable trajectory-use receipt",
  );
};

const retainUnavailableRuntimeIndexes = async (input: {
  readonly campaignId: string;
  readonly admission: M7R3CaseCampaignAdmissionV1;
  readonly contract: M7R3PairedCaseContractV1;
  readonly localAdmission: M7R3LocalArmAdmissionV1;
  readonly evidenceWriter: M7R3RuntimeUseEvidenceWriterV1;
  readonly now: () => string;
}): Promise<M7R3PatrolTrajectoryUseEvidenceV1> => {
  const delivery = createStoredDeliveryTrace({
    campaignId: input.campaignId,
    arm: "runtime_enabled",
    caseCampaignAdmissionRecordSha256: input.admission.recordContentSha256,
    attemptBindingContentSha256:
      input.localAdmission.pairedAttemptBindingContentSha256,
    attemptEvidenceRecordSha256: null,
    unavailableReason: "attempt_envelope_unavailable",
    trace: null,
  });
  await retainSame(
    input.evidenceWriter.putDeliveryTraceOnce(delivery),
    delivery,
    "unavailable delivery record",
  );
  return retainUnavailableTrajectoryUse({
    campaignId: input.campaignId,
    contract: input.contract,
    binding: input.localAdmission.pairedAttemptBinding,
    runtimeEvidenceReceiptSha256: null,
    attemptEvidenceReceiptSha256: null,
    firstHostObservedSourceChange: null,
    evidenceWriter: input.evidenceWriter,
    now: input.now,
  });
};

const runOneArm = async (input: {
  readonly campaignId: string;
  readonly arm: M7ArmV1;
  readonly registration: M7MutationRegistrationV1;
  readonly caseAdmission: M7R3CaseCampaignAdmissionV1;
  readonly contract: M7R3PairedCaseContractV1;
  readonly campaignStore: M7RuntimeUseCampaignStoreV1;
  readonly armPort: M7R3RuntimeUsePairedArmPortV1;
  readonly evaluator: M7R3HiddenEvaluatorPortV1;
  readonly evidenceWriter: M7R3RuntimeUseEvidenceWriterV1;
  readonly now: () => string;
  readonly signal?: AbortSignal | undefined;
}): Promise<M7ArmResultV1> => {
  const localAdmission = M7R3LocalArmAdmissionV1Schema.parse(
    await input.armPort.getArmAdmission(input.arm),
  );
  if (
    localAdmission.arm !== input.arm ||
    localAdmission.claim.campaignId !== input.campaignId ||
    localAdmission.caseCampaignAdmissionRecordSha256 !==
      input.caseAdmission.recordContentSha256 ||
    localAdmission.pairedCaseContractContentSha256 !==
      input.contract.pairedCaseContractContentSha256
  ) {
    throw new Error("M7 R3 arm admission crossed the case campaign");
  }
  const claim = await input.campaignStore.beginArmOnce(localAdmission.claim);
  let envelope: M7R3LocalArmRunEnvelopeV1 | null = null;
  let envelopeValidated = false;
  try {
    envelope = M7R3LocalArmRunEnvelopeV1Schema.parse(
      await input.armPort.runArmOnce({
        schemaVersion: 1,
        campaignId: input.campaignId,
        arm: input.arm,
        campaignClaimContentSha256: claim.recordContentSha256,
        pairedAttemptBindingContentSha256:
          localAdmission.pairedAttemptBindingContentSha256,
        caseCampaignAdmissionRecordSha256:
          input.caseAdmission.recordContentSha256,
        pairedCaseContractContentSha256:
          input.contract.pairedCaseContractContentSha256,
      }),
    );
    validateAttempt({
      arm: input.arm,
      claim,
      admission: localAdmission,
      caseAdmission: input.caseAdmission,
      contract: input.contract,
      registration: input.registration,
      envelope,
    });
    envelopeValidated = true;
    await retainSame(
      input.evidenceWriter.putAttemptOnce(envelope.attempt.attemptEvidence),
      envelope.attempt.attemptEvidence,
      "Agent attempt sidecar",
    );
    if (envelope.attempt.failureReceipt != null) {
      await retainSame(
        input.evidenceWriter.putAttemptFailureOnce(
          envelope.attempt.failureReceipt,
        ),
        envelope.attempt.failureReceipt,
        "Agent attempt failure receipt",
      );
    }
    if (envelope.deliveryTrace !== null) {
      const storedTrace = createStoredDeliveryTrace({
        campaignId: input.campaignId,
        arm: input.arm,
        caseCampaignAdmissionRecordSha256:
          input.caseAdmission.recordContentSha256,
        attemptBindingContentSha256:
          envelope.attempt.binding.bindingContentSha256,
        attemptEvidenceRecordSha256:
          envelope.attempt.attemptEvidence.recordContentSha256,
        unavailableReason: null,
        trace: envelope.deliveryTrace,
      });
      await retainSame(
        input.evidenceWriter.putDeliveryTraceOnce(storedTrace),
        storedTrace,
        "delivery trace",
      );
    } else {
      const unavailableDelivery = createStoredDeliveryTrace({
        campaignId: input.campaignId,
        arm: input.arm,
        caseCampaignAdmissionRecordSha256:
          input.caseAdmission.recordContentSha256,
        attemptBindingContentSha256:
          envelope.attempt.binding.bindingContentSha256,
        attemptEvidenceRecordSha256:
          envelope.attempt.attemptEvidence.recordContentSha256,
        unavailableReason: "delivery_trace_unavailable",
        trace: null,
      });
      await retainSame(
        input.evidenceWriter.putDeliveryTraceOnce(unavailableDelivery),
        unavailableDelivery,
        "unavailable delivery record",
      );
    }
    if (
      envelope.arm === "runtime_enabled" &&
      envelope.runtimeEvidenceReceipt !== null
    ) {
      await retainSame(
        input.evidenceWriter.putRuntimeEvidenceOnce(
          input.campaignId,
          envelope.runtimeEvidenceReceipt,
        ),
        envelope.runtimeEvidenceReceipt,
        "runtime-evidence receipt",
      );
    }
  } catch {
    const cleanup = envelopeValidated
      ? (envelope?.attempt.cleanup ?? null)
      : null;
    let runtimeUseReceiptSha256: Sha256DigestV1 | null = null;
    if (input.arm === "runtime_enabled") {
      const unavailable =
        !envelopeValidated || envelope === null
          ? await retainUnavailableRuntimeIndexes({
              campaignId: input.campaignId,
              admission: input.caseAdmission,
              contract: input.contract,
              localAdmission,
              evidenceWriter: input.evidenceWriter,
              now: input.now,
            })
          : await retainUnavailableTrajectoryUse({
              campaignId: input.campaignId,
              contract: input.contract,
              binding: localAdmission.pairedAttemptBinding,
              runtimeEvidenceReceiptSha256:
                envelope.runtimeEvidenceReceipt?.recordContentSha256 ?? null,
              attemptEvidenceReceiptSha256:
                envelope.attempt.attemptEvidence.recordContentSha256,
              firstHostObservedSourceChange:
                envelope.deliveryTrace?.firstHostObservedSourceChange ?? null,
              evidenceWriter: input.evidenceWriter,
              now: input.now,
            });
      runtimeUseReceiptSha256 = unavailable.recordContentSha256;
    }
    const cleanupProven =
      cleanup !== null &&
      !envelope?.attempt.cleanupInfrastructureFailure &&
      cleanup.proven;
    const result = infrastructureResult({
      campaignId: input.campaignId,
      arm: input.arm,
      claim,
      observedTurnCount: 0,
      cleanupProven,
      cleanupReceiptSha256: cleanupProven ? cleanup.receiptSha256 : null,
      runtimeUseReceiptSha256,
      completedAt: input.now(),
    });
    await input.campaignStore.putArmResultOnce(result);
    return result;
  }

  if (envelope === null) {
    throw new Error("M7 R3 arm envelope was not retained");
  }

  const attempt = envelope.attempt;
  const attemptResult = attempt.result;
  if (attemptResult === null) {
    const unavailable =
      input.arm === "runtime_enabled"
        ? await retainUnavailableTrajectoryUse({
            campaignId: input.campaignId,
            contract: input.contract,
            binding: localAdmission.pairedAttemptBinding,
            runtimeEvidenceReceiptSha256:
              envelope.runtimeEvidenceReceipt?.recordContentSha256 ?? null,
            attemptEvidenceReceiptSha256:
              attempt.attemptEvidence.recordContentSha256,
            firstHostObservedSourceChange:
              envelope.deliveryTrace?.firstHostObservedSourceChange ?? null,
            evidenceWriter: input.evidenceWriter,
            now: input.now,
          })
        : null;
    const result = infrastructureResult({
      campaignId: input.campaignId,
      arm: input.arm,
      claim,
      observedTurnCount: attempt.attemptEvidence.piTurnStarted ? 1 : 0,
      cleanupProven:
        !attempt.cleanupInfrastructureFailure && attempt.cleanup.proven,
      cleanupReceiptSha256:
        !attempt.cleanupInfrastructureFailure && attempt.cleanup.proven
          ? attempt.cleanup.receiptSha256
          : null,
      runtimeUseReceiptSha256: unavailable?.recordContentSha256 ?? null,
      completedAt: input.now(),
    });
    await input.campaignStore.putArmResultOnce(result);
    return result;
  }

  const candidate = candidateFromAttempt({
    registration: input.registration,
    attempt,
  });
  let trajectoryUse: M7R3PatrolTrajectoryUseEvidenceV1 | null = null;
  if (envelope.arm === "runtime_enabled") {
    const result = attemptResult;
    const deliveryTrace = envelope.deliveryTrace;
    if (result.arm !== "runtime_enabled" || deliveryTrace === null) {
      throw new Error("M7 R3 runtime envelope lost its runtime result");
    }
    let summaries: readonly M7R3PatrolTrajectoryExecutionSummaryV1[];
    try {
      summaries =
        envelope.runtimeEvidenceReceipt === null
          ? []
          : recomputeTrajectorySummaries({
              result,
              runtimeEvidence: envelope.runtimeEvidenceReceipt,
              trace: deliveryTrace,
              contract: input.contract,
              admission: input.caseAdmission,
              attemptBinding: envelope.attempt.binding,
            });
    } catch {
      const unavailable = await retainUnavailableTrajectoryUse({
        campaignId: input.campaignId,
        contract: input.contract,
        binding: envelope.attempt.binding,
        runtimeEvidenceReceiptSha256: result.runtimeEvidenceReceiptSha256,
        attemptEvidenceReceiptSha256:
          envelope.attempt.attemptEvidence.recordContentSha256,
        firstHostObservedSourceChange:
          deliveryTrace.firstHostObservedSourceChange,
        evidenceWriter: input.evidenceWriter,
        now: input.now,
      });
      const cleanupProven =
        !attempt.cleanupInfrastructureFailure && attempt.cleanup.proven;
      const failed = infrastructureResult({
        campaignId: input.campaignId,
        arm: input.arm,
        claim,
        observedTurnCount: attempt.attemptEvidence.piTurnStarted ? 1 : 0,
        cleanupProven,
        cleanupReceiptSha256: cleanupProven
          ? attempt.cleanup.receiptSha256
          : null,
        runtimeUseReceiptSha256: unavailable.recordContentSha256,
        completedAt: input.now(),
      });
      await input.campaignStore.putArmResultOnce(failed);
      return failed;
    }
    const candidateIdentity = candidateSourceIdentity({
      summaries,
      candidateSelectedTreeSha256:
        candidate.candidate?.candidateSelectedTreeSha256 ?? null,
    });
    const runtimeSurface = envelope.attempt.binding.runtimeSurface;
    if (runtimeSurface === null) {
      throw new Error("M7 R3 runtime attempt lost its runtime surface");
    }
    const receipt = deriveM7R3PatrolTrajectoryUseEvidenceV1({
      campaignId: input.campaignId,
      caseSpec: input.contract.trajectoryCaseSpec,
      attemptBindingContentSha256:
        envelope.attempt.binding.bindingContentSha256,
      runtimeEvidenceReceiptSha256: result.runtimeEvidenceReceiptSha256,
      attemptEvidenceReceiptSha256:
        envelope.attempt.attemptEvidence.recordContentSha256,
      baselineIdentity: {
        buildId: BuildIdSchema.parse(
          runtimeSurface.runtimeResourceMap.baselineBuildId,
        ),
        sourceId: SourceIdSchema.parse(
          runtimeSurface.runtimeResourceMap.baselineSourceId,
        ),
        sourceSha256: input.caseAdmission.mutant.mutatedBuildSourceSha256,
      },
      candidateIdentity,
      firstHostObservedSourceChange:
        deliveryTrace.firstHostObservedSourceChange,
      summaries,
      derivedAt: input.now(),
    });
    trajectoryUse = await retainSame(
      input.evidenceWriter.putTrajectoryUseOnce(receipt),
      receipt,
      "trajectory-use receipt",
    );
  }

  const loopOutcome = attemptResult.status;
  const agentCleanupProven =
    !attempt.cleanupInfrastructureFailure && attempt.cleanup.proven;
  let evaluatorOutcome: M7ArmResultV1["evaluatorOutcome"];
  let evaluatorReceiptSha256: Sha256DigestV1 | null = null;
  let evaluatorCleanupProven = true;
  let freshRunReferences: M7ArmResultV1["freshRunReferences"] = [];
  if (loopOutcome !== "completed") {
    evaluatorOutcome = "not_run_agent_failure";
  } else if (candidate.outcome === "no_candidate") {
    evaluatorOutcome = "not_run_no_candidate";
  } else if (candidate.outcome === "invalid_candidate") {
    evaluatorOutcome = "not_run_invalid_candidate";
  } else if (!agentCleanupProven) {
    if (candidate.candidate === null) {
      throw new Error("M7 R3 valid candidate lost its identity");
    }
    const receipt = createEvaluatorEvidence({
      campaignId: input.campaignId,
      arm: input.arm,
      caseCampaignAdmissionRecordSha256:
        input.caseAdmission.recordContentSha256,
      mutationRegistrationRecordSha256: input.registration.recordContentSha256,
      attemptBindingContentSha256: attempt.binding.bindingContentSha256,
      evaluatorAssignmentId: `m6-assignment:${digest(
        `m7-local-evaluator\0${input.campaignId}`,
      ).slice(0, 24)}`,
      baselineSelectedTreeSha256:
        input.registration.mutatedBaselineSelectedTreeSha256,
      candidateSelectedTreeSha256:
        candidate.candidate.candidateSelectedTreeSha256,
      patchSha256: candidate.candidate.patchSha256,
      outcome: "infrastructure_failed",
      infrastructureFailureCode: "agent_cleanup_not_proven",
      cleanupProven: false,
      runs: [],
    });
    const persisted = await retainSame(
      input.evidenceWriter.putEvaluatorOnce(receipt),
      receipt,
      "evaluator receipt",
    );
    evaluatorOutcome = persisted.outcome;
    evaluatorReceiptSha256 = persisted.recordContentSha256;
    evaluatorCleanupProven = false;
  } else {
    if (candidate.candidate === null || candidate.patch === null) {
      throw new Error("M7 R3 valid candidate lost its patch");
    }
    const evaluation = await runEvaluator({
      campaignId: input.campaignId,
      arm: input.arm,
      admission: input.caseAdmission,
      registration: input.registration,
      attemptBindingContentSha256: attempt.binding.bindingContentSha256,
      candidate: candidate.candidate,
      patch: candidate.patch,
      evaluator: input.evaluator,
      signal: input.signal,
    });
    const persisted = await retainSame(
      input.evidenceWriter.putEvaluatorOnce(evaluation.evidence),
      evaluation.evidence,
      "evaluator receipt",
    );
    evaluatorOutcome = persisted.outcome;
    evaluatorReceiptSha256 = persisted.recordContentSha256;
    evaluatorCleanupProven = persisted.cleanupProven;
    freshRunReferences = persisted.runs.map((run) => ({
      schemaVersion: 1,
      ordinal: run.ordinal,
      scenarioClass: run.scenarioClass,
      repetition: run.repetition,
      receiptSha256: digestJson(run),
    }));
  }

  const cleanupProven = agentCleanupProven && evaluatorCleanupProven;
  const cleanupReceiptSha256 = cleanupProven
    ? digestJson({
        schemaVersion: 1,
        campaignId: input.campaignId,
        arm: input.arm,
        agentCleanupReceiptSha256: attempt.cleanup.receiptSha256,
        evaluatorReceiptSha256,
      })
    : null;
  const result = createM7ArmResultV1({
    campaignId: input.campaignId,
    arm: input.arm,
    armClaimSha256: claim.recordContentSha256,
    observedTurnCount: attempt.attemptEvidence.piTurnStarted ? 1 : 0,
    loopOutcome,
    candidateOutcome: candidate.outcome,
    candidate: candidate.candidate,
    runtimeUseOutcome:
      input.arm === "runtime_enabled"
        ? trajectoryUse?.trajectoryUseEstablished === true
          ? "verified"
          : "rejected"
        : "not_applicable",
    runtimeUseReceiptSha256:
      input.arm === "runtime_enabled"
        ? (trajectoryUse?.recordContentSha256 ?? null)
        : null,
    evaluatorOutcome,
    evaluatorReceiptSha256,
    freshRunReferences,
    cleanupProven,
    cleanupReceiptSha256,
    completedAt: input.now(),
  });
  await input.campaignStore.putArmResultOnce(result);
  return result;
};

const runOneArmWithFailureRetention = async (
  input: Parameters<typeof runOneArm>[0],
): Promise<M7ArmResultV1> => {
  try {
    return await runOneArm(input);
  } catch (error) {
    let claim: M7ArmClaimV1;
    try {
      claim = await input.campaignStore.readArmClaim(input.arm);
    } catch {
      throw error;
    }
    try {
      return await input.campaignStore.readArmResult(input.arm);
    } catch (readError) {
      if (!isNodeError(readError) || readError.code !== "ENOENT") {
        throw new AggregateError(
          [error, readError],
          "M7 R3 arm failed and retained result could not be read",
        );
      }
    }
    const retained = infrastructureResult({
      campaignId: input.campaignId,
      arm: input.arm,
      claim,
      observedTurnCount: 0,
      cleanupProven: false,
      cleanupReceiptSha256: null,
      completedAt: input.now(),
    });
    await input.campaignStore.putArmResultOnce(retained);
    return retained;
  }
};

const runGateCore = async (input: {
  readonly campaignId: string;
  readonly campaignStore: M7RuntimeUseCampaignStoreV1;
  readonly caseAdmission: M7R3CaseCampaignAdmissionV1;
  readonly caseContract: M7R3PairedCaseContractV1;
  readonly armPort: M7R3RuntimeUsePairedArmPortV1;
  readonly evaluators: Readonly<Record<M7ArmV1, M7R3HiddenEvaluatorPortV1>>;
  readonly evidenceWriter: M7R3RuntimeUseEvidenceWriterV1;
  readonly now: () => string;
  readonly signal?: AbortSignal | undefined;
}): Promise<M7CampaignTerminalRecordV1> => {
  const campaignId = campaignIdSchema.parse(input.campaignId);
  const caseAdmission = M7R3CaseCampaignAdmissionV1Schema.parse(
    input.caseAdmission,
  );
  const contract = M7R3PairedCaseContractV1Schema.parse(input.caseContract);
  const [registration, preflight, sensorBinding] = await Promise.all([
    input.campaignStore.readMutationRegistration(),
    input.campaignStore.readPreflight(),
    input.campaignStore.readCampaignSensorBinding(),
  ]);
  if (
    registration.campaignId !== campaignId ||
    preflight.campaignId !== campaignId ||
    registration.sensorFreezeRecordSha256 !==
      sensorBinding.authoritativeSensorFreezeRecordSha256
  ) {
    throw new Error("M7 R3 Gate crossed its campaign registration");
  }
  validateCampaignBindings({
    campaignId,
    registration,
    admission: caseAdmission,
    contract,
    authoritativeSensorFreezeRecordSha256:
      sensorBinding.authoritativeSensorFreezeRecordSha256,
  });
  if (preflight.outcome === "preflight_failed") {
    return input.campaignStore.finalizeCampaignOnce(input.now());
  }

  const runtime = await runOneArmWithFailureRetention({
    campaignId,
    arm: "runtime_enabled",
    registration,
    caseAdmission,
    contract,
    campaignStore: input.campaignStore,
    armPort: input.armPort,
    evaluator: input.evaluators.runtime_enabled,
    evidenceWriter: input.evidenceWriter,
    now: input.now,
    signal: input.signal,
  });
  if (!runtime.cleanupProven) {
    return input.campaignStore.finalizeCampaignOnce(input.now());
  }
  await runOneArmWithFailureRetention({
    campaignId,
    arm: "code_only",
    registration,
    caseAdmission,
    contract,
    campaignStore: input.campaignStore,
    armPort: input.armPort,
    evaluator: input.evaluators.code_only,
    evidenceWriter: input.evidenceWriter,
    now: input.now,
    signal: input.signal,
  });
  return input.campaignStore.finalizeCampaignOnce(input.now());
};

export const runM7R3RuntimeUseLocalCampaignGateForTestingV1 = (input: {
  readonly campaignId: string;
  readonly campaignStore: M7RuntimeUseCampaignStoreV1;
  readonly caseAdmission: M7R3CaseCampaignAdmissionV1;
  readonly caseContract: M7R3PairedCaseContractV1;
  readonly armPort: M7R3RuntimeUsePairedArmPortV1;
  readonly evaluatorPortsForTesting: Readonly<
    Record<M7ArmV1, M7R3HiddenEvaluatorPortV1>
  >;
  readonly evidenceWriterForTesting: M7R3RuntimeUseEvidenceWriterV1;
  readonly now?: (() => string) | undefined;
  readonly signal?: AbortSignal | undefined;
}): Promise<M7CampaignTerminalRecordV1> =>
  runGateCore({
    campaignId: input.campaignId,
    campaignStore: input.campaignStore,
    caseAdmission: input.caseAdmission,
    caseContract: input.caseContract,
    armPort: input.armPort,
    evaluators: input.evaluatorPortsForTesting,
    evidenceWriter: input.evidenceWriterForTesting,
    now: input.now ?? (() => new Date().toISOString()),
    signal: input.signal,
  });

/** Production composition accepts only the concrete Host-only evidence store. */
export const runM7R3RuntimeUseLocalCampaignGateV1 = (input: {
  readonly campaignId: string;
  readonly campaignStore: M7RuntimeUseCampaignStoreV1;
  readonly caseAdmission: M7R3CaseCampaignAdmissionV1;
  readonly caseContract: M7R3PairedCaseContractV1;
  readonly armPort: M7R3RuntimeUsePairedArmPortV1;
  readonly evaluatorPorts: Readonly<Record<M7ArmV1, M7R3HiddenEvaluatorPortV1>>;
  readonly evidenceStore: M7R3RuntimeUseLocalEvidenceStoreV1;
  readonly now?: (() => string) | undefined;
  readonly signal?: AbortSignal | undefined;
}): Promise<M7CampaignTerminalRecordV1> =>
  runGateCore({
    campaignId: input.campaignId,
    campaignStore: input.campaignStore,
    caseAdmission: input.caseAdmission,
    caseContract: input.caseContract,
    armPort: input.armPort,
    evaluators: input.evaluatorPorts,
    evidenceWriter: input.evidenceStore,
    now: input.now ?? (() => new Date().toISOString()),
    signal: input.signal,
  });
