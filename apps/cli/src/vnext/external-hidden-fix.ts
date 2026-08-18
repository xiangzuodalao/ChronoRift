import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import {
  isAbsolute,
  parse as parsePath,
  relative,
  resolve,
  sep,
} from "node:path";

import {
  JsonValueSchema,
  Sha256DigestV1Schema,
  asSha256DigestV1,
  type Sha256DigestV1,
} from "@chronorift/domain";
import { canonicalJson } from "@chronorift/json-artifacts";
import { z } from "zod";

import { publishPrivateFileOnceV1 } from "./private-atomic-publication.js";

const RECORD_BYTE_LIMIT = 1024 * 1024;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

const assignmentIdSchema = z.string().regex(/^m6-assignment:[a-f0-9]{24}$/u);
const artifactIdSchema = z.string().regex(/^m6-artifact:[a-f0-9]{64}$/u);
const freshCopyIdSchema = z.string().regex(/^m6-fresh-copy:[a-f0-9]{24}$/u);
const absolutePathSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine((value) => isAbsolute(value) && resolve(value) === value, {
    message: "Host-only paths must be normalized absolute paths",
  });

const digest = (bytes: string | Uint8Array): Sha256DigestV1 =>
  asSha256DigestV1(createHash("sha256").update(bytes).digest("hex"));

const digestJson = (value: unknown): Sha256DigestV1 =>
  digest(canonicalJson(JsonValueSchema.parse(value)));

const addHashMismatch = (
  context: z.RefinementCtx,
  path: readonly (string | number)[],
  message: string,
): void => {
  context.addIssue({ code: "custom", path: [...path], message });
};

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
  const effectiveUserId = process.geteuid?.();
  if (effectiveUserId === undefined) {
    throw new Error(
      "M6 Host-only evidence requires a platform with effective-user ownership checks",
    );
  }
  return effectiveUserId;
};

const canonicalRealPath = async (
  inputPath: string,
  kind: "directory" | "file",
  label: string,
): Promise<string> => {
  const absolutePath = resolve(inputPath);
  if (absolutePath === parsePath(absolutePath).root) {
    throw new Error(`${label} must not be a filesystem root`);
  }
  const metadata = await lstat(absolutePath);
  if (
    metadata.isSymbolicLink() ||
    (kind === "directory" ? !metadata.isDirectory() : !metadata.isFile())
  ) {
    throw new Error(`${label} must be a real ${kind}`);
  }
  const canonicalPath = await realpath(absolutePath);
  if (canonicalPath !== absolutePath) {
    throw new Error(
      `${label} must be canonical and contain no symbolic-link component`,
    );
  }
  return canonicalPath;
};

const requirePrivateDirectory = async (
  inputPath: string,
  label: string,
): Promise<string> => {
  const canonicalPath = await canonicalRealPath(inputPath, "directory", label);
  const metadata = await lstat(canonicalPath);
  if (
    metadata.uid !== requireEffectiveUserId() ||
    (metadata.mode & 0o7777) !== PRIVATE_DIRECTORY_MODE
  ) {
    throw new Error(
      `${label} must be owned by the current user with mode 0700`,
    );
  }
  return canonicalPath;
};

const BASELINE_ENTRY_LIMIT = 50_000;

/**
 * Validates only the protected baseline tree selected by its assignment. It
 * never follows links or scans elsewhere for aliases. Project file modes are
 * preserved; privacy comes from the mode-0700 Host-only parent.
 */
const requireProtectedBaselineTree = async (
  rootInput: string,
): Promise<string> => {
  const root = await requirePrivateDirectory(
    rootInput,
    "M6 protected mutated baseline root",
  );
  const pending = [root];
  let entries = 0;
  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined) break;
    const names = await readdir(directory, { encoding: "utf8" });
    names.sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
    for (const name of names) {
      entries += 1;
      if (entries > BASELINE_ENTRY_LIMIT) {
        throw new Error(
          "M6 protected baseline exceeds the bounded entry count",
        );
      }
      const path = resolve(directory, name);
      if (!pathWithinOrEqual(root, path)) {
        throw new Error("M6 protected baseline entry escaped its root");
      }
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) {
        throw new Error(
          "M6 protected baseline must not contain symbolic links",
        );
      }
      if (metadata.isDirectory()) {
        pending.push(path);
      } else if (!metadata.isFile() || metadata.nlink !== 1) {
        throw new Error(
          "M6 protected baseline entries must be one-link regular files or real directories",
        );
      }
    }
  }
  return root;
};

const requirePrivateRegularFile = async (input: {
  readonly root: string;
  readonly path: string;
  readonly label: string;
  readonly expectedSha256?: Sha256DigestV1 | undefined;
}): Promise<string> => {
  const canonicalPath = await canonicalRealPath(
    input.path,
    "file",
    input.label,
  );
  if (!pathWithinOrEqual(input.root, canonicalPath)) {
    throw new Error(`${input.label} must remain inside the Host-only root`);
  }
  const handle = await open(
    canonicalPath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const metadata = await handle.stat();
    const pathMetadata = await lstat(canonicalPath);
    if (
      !metadata.isFile() ||
      metadata.nlink !== 1 ||
      metadata.uid !== requireEffectiveUserId() ||
      (metadata.mode & 0o7777) !== PRIVATE_FILE_MODE ||
      pathMetadata.dev !== metadata.dev ||
      pathMetadata.ino !== metadata.ino ||
      pathMetadata.nlink !== 1
    ) {
      throw new Error(
        `${input.label} must be an owned mode-0600 regular file with one link`,
      );
    }
    if (metadata.size > RECORD_BYTE_LIMIT) {
      throw new Error(`${input.label} exceeds the bounded private-file size`);
    }
    if (input.expectedSha256 !== undefined) {
      const bytes = await handle.readFile();
      if (digest(bytes) !== input.expectedSha256) {
        throw new Error(`${input.label} content hash changed`);
      }
    }
  } finally {
    await handle.close();
  }
  return canonicalPath;
};

const assertDisjoint = (left: string, right: string, message: string): void => {
  if (pathWithinOrEqual(left, right) || pathWithinOrEqual(right, left)) {
    throw new Error(message);
  }
};

const validateHostOnlyRoot = async (input: {
  readonly root: string;
  readonly exposedRoots: readonly string[];
}): Promise<string> => {
  const root = await requirePrivateDirectory(input.root, "M6 Host-only root");
  const exposedRoots = await Promise.all(
    input.exposedRoots.map((path, index) =>
      canonicalRealPath(path, "directory", `M6 exposed root ${index + 1}`),
    ),
  );
  for (const exposed of exposedRoots) {
    assertDisjoint(
      root,
      exposed,
      "M6 Host-only root must be outside every Agent-exposed root",
    );
  }
  return root;
};

export const ExternalHiddenFixPatchReferenceV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    artifactId: artifactIdSchema,
    rawSha256: Sha256DigestV1Schema,
    byteLength: z
      .number()
      .int()
      .min(1)
      .max(512 * 1024 * 1024),
  })
  .strict();
export type ExternalHiddenFixPatchReferenceV1 = z.infer<
  typeof ExternalHiddenFixPatchReferenceV1Schema
>;

/** Public workflow-only patch identity. It is deliberately not part of the
 * hidden evaluator request, whose baseline comes from the assignment store. */
export const ExternalHiddenFixPatchIdentityV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    baselineSelectedTreeSha256: Sha256DigestV1Schema,
    candidateSelectedTreeSha256: Sha256DigestV1Schema,
    patchSha256: Sha256DigestV1Schema,
    byteLength: z
      .number()
      .int()
      .min(1)
      .max(512 * 1024 * 1024),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.baselineSelectedTreeSha256 === value.candidateSelectedTreeSha256
    ) {
      addHashMismatch(
        context,
        ["candidateSelectedTreeSha256"],
        "candidate tree must differ from the mutated baseline",
      );
    }
  });
export type ExternalHiddenFixPatchIdentityV1 = z.infer<
  typeof ExternalHiddenFixPatchIdentityV1Schema
>;

const assignmentIdentityBasisSchema = z
  .object({
    schemaVersion: z.literal(1),
    subjectProjectSha256: Sha256DigestV1Schema,
    pristineSelectedTreeSha256: Sha256DigestV1Schema,
    mutatedBaselineSelectedTreeSha256: Sha256DigestV1Schema,
    publicTaskSpecSha256: Sha256DigestV1Schema,
    taskBlindAdapterSha256: Sha256DigestV1Schema,
    mutationSha256: Sha256DigestV1Schema,
    evaluatorImplementationSha256: Sha256DigestV1Schema,
    evaluatorBundleSha256: Sha256DigestV1Schema,
  })
  .strict();

const assignmentRecordSchemaBase = assignmentIdentityBasisSchema.extend({
  recordKind: z.literal("external-hidden-fix-assignment"),
  assignmentId: assignmentIdSchema,
  baselineRoot: absolutePathSchema,
  mutationPath: absolutePathSchema,
  evaluatorImplementationPath: absolutePathSchema,
  evaluatorBundlePath: absolutePathSchema,
  createdAt: z.string().datetime(),
  recordContentSha256: Sha256DigestV1Schema,
});

export const ExternalHiddenFixAssignmentV1Schema = assignmentRecordSchemaBase
  .strict()
  .superRefine((value, context) => {
    const identityBasis = assignmentIdentityBasisSchema.parse({
      schemaVersion: value.schemaVersion,
      subjectProjectSha256: value.subjectProjectSha256,
      pristineSelectedTreeSha256: value.pristineSelectedTreeSha256,
      mutatedBaselineSelectedTreeSha256:
        value.mutatedBaselineSelectedTreeSha256,
      publicTaskSpecSha256: value.publicTaskSpecSha256,
      taskBlindAdapterSha256: value.taskBlindAdapterSha256,
      mutationSha256: value.mutationSha256,
      evaluatorImplementationSha256: value.evaluatorImplementationSha256,
      evaluatorBundleSha256: value.evaluatorBundleSha256,
    });
    const identitySha256 = digestJson(identityBasis);
    if (value.assignmentId !== `m6-assignment:${identitySha256.slice(0, 24)}`) {
      addHashMismatch(
        context,
        ["assignmentId"],
        "assignment ID must derive from the frozen assignment identities",
      );
    }
    const { recordContentSha256, ...recordBasis } = value;
    if (recordContentSha256 !== digestJson(recordBasis)) {
      addHashMismatch(
        context,
        ["recordContentSha256"],
        "assignment content hash does not match its record",
      );
    }
  });
export type ExternalHiddenFixAssignmentV1 = z.infer<
  typeof ExternalHiddenFixAssignmentV1Schema
>;

export interface CreateExternalHiddenFixAssignmentV1Input extends z.input<
  typeof assignmentIdentityBasisSchema
> {
  readonly baselineRoot: string;
  readonly mutationPath: string;
  readonly evaluatorImplementationPath: string;
  readonly evaluatorBundlePath: string;
  readonly createdAt: string;
}

export const ExternalHiddenFixEvaluationRequestV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    requestKind: z.literal("external-hidden-fix-evaluation"),
    assignmentId: assignmentIdSchema,
    patch: ExternalHiddenFixPatchReferenceV1Schema,
    expectedCandidateSelectedTreeSha256: Sha256DigestV1Schema,
    requestContentSha256: Sha256DigestV1Schema,
  })
  .strict()
  .superRefine((value, context) => {
    const { requestContentSha256, ...requestBasis } = value;
    if (requestContentSha256 !== digestJson(requestBasis)) {
      addHashMismatch(
        context,
        ["requestContentSha256"],
        "evaluation request content hash does not match",
      );
    }
  });
export type ExternalHiddenFixEvaluationRequestV1 = z.infer<
  typeof ExternalHiddenFixEvaluationRequestV1Schema
>;

export const createExternalHiddenFixEvaluationRequestV1 = (input: {
  readonly assignmentId: string;
  readonly patch: ExternalHiddenFixPatchReferenceV1;
  readonly expectedCandidateSelectedTreeSha256: Sha256DigestV1;
}): ExternalHiddenFixEvaluationRequestV1 => {
  const requestBasis = {
    schemaVersion: 1 as const,
    requestKind: "external-hidden-fix-evaluation" as const,
    assignmentId: assignmentIdSchema.parse(input.assignmentId),
    patch: ExternalHiddenFixPatchReferenceV1Schema.parse(input.patch),
    expectedCandidateSelectedTreeSha256: Sha256DigestV1Schema.parse(
      input.expectedCandidateSelectedTreeSha256,
    ),
  };
  return ExternalHiddenFixEvaluationRequestV1Schema.parse({
    ...requestBasis,
    requestContentSha256: digestJson(requestBasis),
  });
};

export const ExternalHiddenFixScenarioClassV1Schema = z.enum([
  "public_reproduction",
  "hidden_variant",
  "regression_control",
]);
export type ExternalHiddenFixScenarioClassV1 = z.infer<
  typeof ExternalHiddenFixScenarioClassV1Schema
>;

export const ExternalHiddenFixFreshPlanEntryV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    assignmentId: assignmentIdSchema,
    freshCopyId: freshCopyIdSchema,
    ordinal: z.number().int().min(1).max(9),
    scenarioClass: ExternalHiddenFixScenarioClassV1Schema,
    repetition: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    requiresFreshWorkspace: z.literal(true),
    requiresFreshImportCache: z.literal(true),
    requiresFreshProcess: z.literal(true),
  })
  .strict();
export type ExternalHiddenFixFreshPlanEntryV1 = z.infer<
  typeof ExternalHiddenFixFreshPlanEntryV1Schema
>;

export const createExternalHiddenFixFreshEvaluationPlanV1 = (
  assignmentIdInput: string,
): readonly ExternalHiddenFixFreshPlanEntryV1[] => {
  const assignmentId = assignmentIdSchema.parse(assignmentIdInput);
  const scenarioClasses = ExternalHiddenFixScenarioClassV1Schema.options;
  const plan: ExternalHiddenFixFreshPlanEntryV1[] = [];
  let ordinal = 1;
  for (const scenarioClass of scenarioClasses) {
    for (const repetition of [1, 2, 3] as const) {
      const idHash = digest(
        `${assignmentId}\0${scenarioClass}\0${String(repetition)}`,
      );
      plan.push(
        ExternalHiddenFixFreshPlanEntryV1Schema.parse({
          schemaVersion: 1,
          assignmentId,
          freshCopyId: `m6-fresh-copy:${idHash.slice(0, 24)}`,
          ordinal,
          scenarioClass,
          repetition,
          requiresFreshWorkspace: true,
          requiresFreshImportCache: true,
          requiresFreshProcess: true,
        }),
      );
      ordinal += 1;
    }
  }
  return Object.freeze(plan);
};

export const ExternalHiddenFixWorkflowCheckV1Schema = z.enum([
  "single_agent_turn",
  "baseline_execution_before_host_observed_source_change",
  "candidate_patch_frozen",
  "patch_round_trip_verified",
  "candidate_rerun_observed",
  "execution_lineage_valid",
  "cleanup_proven",
]);
export type ExternalHiddenFixWorkflowCheckV1 = z.infer<
  typeof ExternalHiddenFixWorkflowCheckV1Schema
>;

const workflowCheckResultSchema = z
  .object({
    check: ExternalHiddenFixWorkflowCheckV1Schema,
    satisfied: z.boolean(),
    evidenceSha256: Sha256DigestV1Schema.nullable(),
  })
  .strict();

const workflowOutcomeSchema = z.enum([
  "verified",
  "rejected",
  "infrastructure_failed",
]);

const workflowReceiptBaseSchema = z.object({
  schemaVersion: z.literal(1),
  receiptKind: z.literal("external-hidden-fix-workflow-evidence"),
  assignmentId: assignmentIdSchema,
  patchIdentity: ExternalHiddenFixPatchIdentityV1Schema,
  outcome: workflowOutcomeSchema,
  checks: z.array(workflowCheckResultSchema).length(7),
  infrastructureFailureCode: z
    .enum(["task_records_unavailable", "checker_failed", "persistence_failed"])
    .nullable(),
  receiptContentSha256: Sha256DigestV1Schema,
});

export const ExternalHiddenFixWorkflowEvidenceReceiptV1Schema =
  workflowReceiptBaseSchema.strict().superRefine((value, context) => {
    const expectedChecks = ExternalHiddenFixWorkflowCheckV1Schema.options;
    if (
      value.checks.some((entry, index) => entry.check !== expectedChecks[index])
    ) {
      addHashMismatch(
        context,
        ["checks"],
        "workflow checks must contain the complete canonical ordered set",
      );
    }
    const derivedOutcome =
      value.infrastructureFailureCode !== null
        ? "infrastructure_failed"
        : value.checks.every((entry) => entry.satisfied)
          ? "verified"
          : "rejected";
    if (value.outcome !== derivedOutcome) {
      addHashMismatch(
        context,
        ["outcome"],
        "workflow outcome must derive from public workflow checks only",
      );
    }
    const { receiptContentSha256, ...receiptBasis } = value;
    if (receiptContentSha256 !== digestJson(receiptBasis)) {
      addHashMismatch(
        context,
        ["receiptContentSha256"],
        "workflow receipt content hash does not match",
      );
    }
  });
export type ExternalHiddenFixWorkflowEvidenceReceiptV1 = z.infer<
  typeof ExternalHiddenFixWorkflowEvidenceReceiptV1Schema
>;

export const createExternalHiddenFixWorkflowEvidenceReceiptV1 = (input: {
  readonly assignmentId: string;
  readonly patchIdentity: ExternalHiddenFixPatchIdentityV1;
  readonly checks: Readonly<
    Record<
      ExternalHiddenFixWorkflowCheckV1,
      {
        readonly satisfied: boolean;
        readonly evidenceSha256: Sha256DigestV1 | null;
      }
    >
  >;
  readonly infrastructureFailureCode:
    "task_records_unavailable" | "checker_failed" | "persistence_failed" | null;
}): ExternalHiddenFixWorkflowEvidenceReceiptV1 => {
  const checks = ExternalHiddenFixWorkflowCheckV1Schema.options.map((check) =>
    workflowCheckResultSchema.parse({ check, ...input.checks[check] }),
  );
  const receiptBasis = {
    schemaVersion: 1 as const,
    receiptKind: "external-hidden-fix-workflow-evidence" as const,
    assignmentId: assignmentIdSchema.parse(input.assignmentId),
    patchIdentity: ExternalHiddenFixPatchIdentityV1Schema.parse(
      input.patchIdentity,
    ),
    outcome:
      input.infrastructureFailureCode !== null
        ? ("infrastructure_failed" as const)
        : checks.every((entry) => entry.satisfied)
          ? ("verified" as const)
          : ("rejected" as const),
    checks,
    infrastructureFailureCode: input.infrastructureFailureCode,
  };
  return ExternalHiddenFixWorkflowEvidenceReceiptV1Schema.parse({
    ...receiptBasis,
    receiptContentSha256: digestJson(receiptBasis),
  });
};

export const ExternalHiddenFixFreshRunReceiptV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    assignmentId: assignmentIdSchema,
    freshCopyId: freshCopyIdSchema,
    ordinal: z.number().int().min(1).max(9),
    scenarioClass: ExternalHiddenFixScenarioClassV1Schema,
    repetition: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    baselineSelectedTreeSha256: Sha256DigestV1Schema,
    candidateSelectedTreeSha256: Sha256DigestV1Schema,
    patchSha256: Sha256DigestV1Schema,
    freshWorkspaceCreated: z.literal(true),
    freshImportCacheCreated: z.literal(true),
    freshProcessStarted: z.literal(true),
    outcome: z.enum(["passed", "failed"]),
    observationSha256: Sha256DigestV1Schema,
    cleanupProven: z.boolean(),
  })
  .strict();
export type ExternalHiddenFixFreshRunReceiptV1 = z.infer<
  typeof ExternalHiddenFixFreshRunReceiptV1Schema
>;

const evaluatorOutcomeSchema = z.enum([
  "accepted",
  "rejected",
  "infrastructure_failed",
]);

const evaluatorReceiptBaseSchema = z.object({
  schemaVersion: z.literal(1),
  receiptKind: z.literal("external-hidden-fix-fresh-copy-acceptance"),
  assignmentId: assignmentIdSchema,
  requestContentSha256: Sha256DigestV1Schema,
  baselineSelectedTreeSha256: Sha256DigestV1Schema,
  expectedCandidateSelectedTreeSha256: Sha256DigestV1Schema,
  patchSha256: Sha256DigestV1Schema,
  evaluatorImplementationSha256: Sha256DigestV1Schema,
  evaluatorBundleSha256: Sha256DigestV1Schema,
  outcome: evaluatorOutcomeSchema,
  completedRuns: z.array(ExternalHiddenFixFreshRunReceiptV1Schema).max(9),
  plannedRunCount: z.literal(9),
  infrastructureFailureCode: z
    .enum([
      "assignment_mismatch",
      "fresh_copy_failed",
      "candidate_tree_mismatch",
      "runner_failed",
      "cleanup_failed",
      "persistence_failed",
    ])
    .nullable(),
  cleanupProven: z.boolean(),
  receiptContentSha256: Sha256DigestV1Schema,
});

export const ExternalHiddenFixFreshCopyAcceptanceReceiptV1Schema =
  evaluatorReceiptBaseSchema.strict().superRefine((value, context) => {
    const expectedPlan = createExternalHiddenFixFreshEvaluationPlanV1(
      value.assignmentId,
    );
    for (const [index, run] of value.completedRuns.entries()) {
      const expected = expectedPlan[index];
      if (
        expected === undefined ||
        run.assignmentId !== value.assignmentId ||
        run.freshCopyId !== expected.freshCopyId ||
        run.ordinal !== expected.ordinal ||
        run.scenarioClass !== expected.scenarioClass ||
        run.repetition !== expected.repetition ||
        run.baselineSelectedTreeSha256 !== value.baselineSelectedTreeSha256 ||
        run.candidateSelectedTreeSha256 !==
          value.expectedCandidateSelectedTreeSha256 ||
        run.patchSha256 !== value.patchSha256
      ) {
        addHashMismatch(
          context,
          ["completedRuns", index],
          "fresh-copy run is detached from the canonical 3x3 plan or candidate identity",
        );
      }
    }
    const allRunsCompleted =
      value.completedRuns.length === value.plannedRunCount;
    const derivedOutcome =
      value.infrastructureFailureCode !== null ||
      !value.cleanupProven ||
      !allRunsCompleted
        ? "infrastructure_failed"
        : value.completedRuns.every((entry) => entry.outcome === "passed")
          ? "accepted"
          : "rejected";
    if (value.outcome !== derivedOutcome) {
      addHashMismatch(
        context,
        ["outcome"],
        "fresh-copy outcome must derive only from evaluator-owned runs",
      );
    }
    if (
      (value.outcome === "accepted" || value.outcome === "rejected") &&
      value.completedRuns.some((entry) => !entry.cleanupProven)
    ) {
      addHashMismatch(
        context,
        ["cleanupProven"],
        "an evaluated outcome requires cleanup proof from every fresh run",
      );
    }
    const { receiptContentSha256, ...receiptBasis } = value;
    if (receiptContentSha256 !== digestJson(receiptBasis)) {
      addHashMismatch(
        context,
        ["receiptContentSha256"],
        "fresh-copy receipt content hash does not match",
      );
    }
  });
export type ExternalHiddenFixFreshCopyAcceptanceReceiptV1 = z.infer<
  typeof ExternalHiddenFixFreshCopyAcceptanceReceiptV1Schema
>;

export const createExternalHiddenFixFreshCopyAcceptanceReceiptV1 = (input: {
  readonly assignmentId: string;
  readonly requestContentSha256: Sha256DigestV1;
  readonly baselineSelectedTreeSha256: Sha256DigestV1;
  readonly expectedCandidateSelectedTreeSha256: Sha256DigestV1;
  readonly patchSha256: Sha256DigestV1;
  readonly evaluatorImplementationSha256: Sha256DigestV1;
  readonly evaluatorBundleSha256: Sha256DigestV1;
  readonly completedRuns: readonly ExternalHiddenFixFreshRunReceiptV1[];
  readonly infrastructureFailureCode:
    | "assignment_mismatch"
    | "fresh_copy_failed"
    | "candidate_tree_mismatch"
    | "runner_failed"
    | "cleanup_failed"
    | "persistence_failed"
    | null;
  readonly cleanupProven: boolean;
}): ExternalHiddenFixFreshCopyAcceptanceReceiptV1 => {
  const allRunsCompleted = input.completedRuns.length === 9;
  const outcome =
    input.infrastructureFailureCode !== null ||
    !input.cleanupProven ||
    !allRunsCompleted
      ? ("infrastructure_failed" as const)
      : input.completedRuns.every((entry) => entry.outcome === "passed")
        ? ("accepted" as const)
        : ("rejected" as const);
  const receiptBasis = {
    schemaVersion: 1 as const,
    receiptKind: "external-hidden-fix-fresh-copy-acceptance" as const,
    assignmentId: assignmentIdSchema.parse(input.assignmentId),
    requestContentSha256: input.requestContentSha256,
    baselineSelectedTreeSha256: input.baselineSelectedTreeSha256,
    expectedCandidateSelectedTreeSha256:
      input.expectedCandidateSelectedTreeSha256,
    patchSha256: input.patchSha256,
    evaluatorImplementationSha256: input.evaluatorImplementationSha256,
    evaluatorBundleSha256: input.evaluatorBundleSha256,
    outcome,
    completedRuns: [...input.completedRuns],
    plannedRunCount: 9 as const,
    infrastructureFailureCode: input.infrastructureFailureCode,
    cleanupProven: input.cleanupProven,
  };
  return ExternalHiddenFixFreshCopyAcceptanceReceiptV1Schema.parse({
    ...receiptBasis,
    receiptContentSha256: digestJson(receiptBasis),
  });
};

export const ExternalHiddenFixTerminalOutcomeV1Schema = z.enum([
  "accepted",
  "no_candidate",
  "agent_failed",
  "workflow_rejected",
  "evaluator_rejected",
  "infrastructure_failed",
  "cleanup_failed",
]);
export type ExternalHiddenFixTerminalOutcomeV1 = z.infer<
  typeof ExternalHiddenFixTerminalOutcomeV1Schema
>;

const primaryOutcomeSchema = z.enum([
  "accepted",
  "no_candidate",
  "agent_failed",
  "workflow_rejected",
  "evaluator_rejected",
  "infrastructure_failed",
]);

const terminalRecordBaseSchema = z.object({
  schemaVersion: z.literal(1),
  recordKind: z.literal("external-hidden-fix-terminal"),
  assignmentId: assignmentIdSchema,
  attemptOrdinal: z.literal(1),
  outcome: ExternalHiddenFixTerminalOutcomeV1Schema,
  agentFailureCode: z
    .enum(["provider_failure", "timed_out", "aborted"])
    .nullable(),
  noCandidateReason: z
    .enum(["no_patch", "empty_patch", "inadmissible_patch"])
    .nullable(),
  primaryOutcome: primaryOutcomeSchema.nullable(),
  patchSha256: Sha256DigestV1Schema.nullable(),
  workflowReceiptSha256: Sha256DigestV1Schema.nullable(),
  evaluatorReceiptSha256: Sha256DigestV1Schema.nullable(),
  cleanupReceiptSha256: Sha256DigestV1Schema.nullable(),
  completedAt: z.string().datetime(),
  recordContentSha256: Sha256DigestV1Schema,
});

export const ExternalHiddenFixTerminalRecordV1Schema = terminalRecordBaseSchema
  .strict()
  .superRefine((value, context) => {
    const retainsAgentFailure =
      value.outcome === "agent_failed" ||
      (value.outcome === "cleanup_failed" &&
        value.primaryOutcome === "agent_failed");
    if (retainsAgentFailure !== (value.agentFailureCode !== null)) {
      addHashMismatch(
        context,
        ["agentFailureCode"],
        "agent failure code must survive cleanup failure of agent_failed",
      );
    }
    const mayRetainNoCandidateReason =
      value.outcome === "no_candidate" ||
      (value.outcome === "cleanup_failed" &&
        value.primaryOutcome === "no_candidate");
    if (mayRetainNoCandidateReason !== (value.noCandidateReason !== null)) {
      addHashMismatch(
        context,
        ["noCandidateReason"],
        "no-candidate reason must describe no_candidate and survive its cleanup failure",
      );
    }
    if (
      (value.outcome === "cleanup_failed") !==
      (value.primaryOutcome !== null)
    ) {
      addHashMismatch(
        context,
        ["primaryOutcome"],
        "cleanup_failed must retain exactly one primary outcome",
      );
    }
    if (
      value.outcome === "accepted" &&
      (value.patchSha256 === null ||
        value.workflowReceiptSha256 === null ||
        value.evaluatorReceiptSha256 === null ||
        value.cleanupReceiptSha256 === null)
    ) {
      addHashMismatch(
        context,
        ["outcome"],
        "accepted requires patch, workflow, evaluator, and cleanup evidence",
      );
    }
    if (
      value.outcome !== "cleanup_failed" &&
      value.cleanupReceiptSha256 === null
    ) {
      addHashMismatch(
        context,
        ["cleanupReceiptSha256"],
        "a completed M6 terminal outcome requires its cleanup receipt",
      );
    }
    if (
      value.outcome === "workflow_rejected" &&
      value.workflowReceiptSha256 === null
    ) {
      addHashMismatch(
        context,
        ["workflowReceiptSha256"],
        "workflow_rejected requires its public workflow receipt",
      );
    }
    if (
      value.outcome === "evaluator_rejected" &&
      (value.workflowReceiptSha256 === null ||
        value.evaluatorReceiptSha256 === null)
    ) {
      addHashMismatch(
        context,
        ["evaluatorReceiptSha256"],
        "evaluator_rejected requires both independent receipts",
      );
    }
    const { recordContentSha256, ...recordBasis } = value;
    if (recordContentSha256 !== digestJson(recordBasis)) {
      addHashMismatch(
        context,
        ["recordContentSha256"],
        "terminal record content hash does not match",
      );
    }
  });
export type ExternalHiddenFixTerminalRecordV1 = z.infer<
  typeof ExternalHiddenFixTerminalRecordV1Schema
>;

export const createExternalHiddenFixTerminalRecordV1 = (
  input: Omit<
    z.input<typeof terminalRecordBaseSchema>,
    "schemaVersion" | "recordKind" | "attemptOrdinal" | "recordContentSha256"
  >,
): ExternalHiddenFixTerminalRecordV1 => {
  const recordBasis = {
    schemaVersion: 1 as const,
    recordKind: "external-hidden-fix-terminal" as const,
    assignmentId: input.assignmentId,
    attemptOrdinal: 1 as const,
    outcome: input.outcome,
    agentFailureCode: input.agentFailureCode,
    noCandidateReason: input.noCandidateReason,
    primaryOutcome: input.primaryOutcome,
    patchSha256: input.patchSha256,
    workflowReceiptSha256: input.workflowReceiptSha256,
    evaluatorReceiptSha256: input.evaluatorReceiptSha256,
    cleanupReceiptSha256: input.cleanupReceiptSha256,
    completedAt: input.completedAt,
  };
  return ExternalHiddenFixTerminalRecordV1Schema.parse({
    ...recordBasis,
    recordContentSha256: digestJson(recordBasis),
  });
};

export const ExternalHiddenFixAgentAttemptBindingV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    assignmentId: assignmentIdSchema,
    agentProjectionContentSha256: Sha256DigestV1Schema,
    publicTaskSpecSha256: Sha256DigestV1Schema,
    taskId: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:+-]*$/u),
    provider: z.string().min(1).max(256),
    model: z.string().min(1).max(256),
    thinkingLevel: z.enum([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]),
    agentBudgetSha256: Sha256DigestV1Schema,
    workspaceBaselineSelectedTreeSha256: Sha256DigestV1Schema,
    taskBlindAdapterSha256: Sha256DigestV1Schema,
    admittedToolSetSha256: Sha256DigestV1Schema,
    sandboxRealizationSha256: Sha256DigestV1Schema,
  })
  .strict();
export type ExternalHiddenFixAgentAttemptBindingV1 = z.infer<
  typeof ExternalHiddenFixAgentAttemptBindingV1Schema
>;

const attemptClaimBaseSchema = z.object({
  schemaVersion: z.literal(1),
  recordKind: z.literal("external-hidden-fix-attempt-claim"),
  assignmentId: assignmentIdSchema,
  binding: ExternalHiddenFixAgentAttemptBindingV1Schema,
  attemptOrdinal: z.literal(1),
  startedAt: z.string().datetime(),
  recordContentSha256: Sha256DigestV1Schema,
});

export const ExternalHiddenFixAttemptClaimV1Schema = attemptClaimBaseSchema
  .strict()
  .superRefine((value, context) => {
    if (value.assignmentId !== value.binding.assignmentId) {
      addHashMismatch(
        context,
        ["binding", "assignmentId"],
        "attempt binding must belong to the claimed assignment",
      );
    }
    const { recordContentSha256, ...recordBasis } = value;
    if (recordContentSha256 !== digestJson(recordBasis)) {
      addHashMismatch(
        context,
        ["recordContentSha256"],
        "attempt claim content hash does not match",
      );
    }
  });
export type ExternalHiddenFixAttemptClaimV1 = z.infer<
  typeof ExternalHiddenFixAttemptClaimV1Schema
>;

const createAttemptClaim = (input: {
  readonly binding: ExternalHiddenFixAgentAttemptBindingV1;
  readonly startedAt: string;
}): ExternalHiddenFixAttemptClaimV1 => {
  const recordBasis = {
    schemaVersion: 1 as const,
    recordKind: "external-hidden-fix-attempt-claim" as const,
    assignmentId: input.binding.assignmentId,
    binding: ExternalHiddenFixAgentAttemptBindingV1Schema.parse(input.binding),
    attemptOrdinal: 1 as const,
    startedAt: z.string().datetime().parse(input.startedAt),
  };
  return ExternalHiddenFixAttemptClaimV1Schema.parse({
    ...recordBasis,
    recordContentSha256: digestJson(recordBasis),
  });
};

interface PrivateRootIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly uid: number;
  readonly mode: number;
}

const privateRootIdentity = async (
  root: string,
): Promise<PrivateRootIdentity> => {
  const metadata = await lstat(root);
  return Object.freeze({
    dev: metadata.dev,
    ino: metadata.ino,
    uid: metadata.uid,
    mode: metadata.mode,
  });
};

const sameRootIdentity = (
  expected: PrivateRootIdentity,
  metadata: Awaited<ReturnType<typeof lstat>>,
): boolean =>
  metadata.isDirectory() &&
  !metadata.isSymbolicLink() &&
  metadata.dev === expected.dev &&
  metadata.ino === expected.ino &&
  metadata.uid === expected.uid &&
  metadata.mode === expected.mode &&
  (metadata.mode & 0o7777) === PRIVATE_DIRECTORY_MODE;

const privateRecordName = (
  assignmentId: string,
  kind:
    | "assignment"
    | "attempt"
    | "workflow-audit"
    | "workflow"
    | "evaluator-request"
    | "evaluator-result"
    | "terminal",
): string => `${digest(assignmentId)}.${kind}.json`;

/** The store reads only the public binding envelope; the workflow module owns
 * the complete audit schema and checker and supplies the strict parser. */
const workflowAuditStoreBindingSchema = z
  .object({
    schemaVersion: z.literal(1),
    recordKind: z.literal("external-hidden-fix-workflow-audit"),
    assignmentId: assignmentIdSchema,
    patchIdentity: ExternalHiddenFixPatchIdentityV1Schema,
    workflowReceiptContentSha256: Sha256DigestV1Schema,
  })
  .passthrough();

export class ExternalHiddenFixAssignmentStoreV1 {
  readonly #root: string;
  readonly #rootIdentity: PrivateRootIdentity;

  private constructor(root: string, rootIdentity: PrivateRootIdentity) {
    this.#root = root;
    this.#rootIdentity = rootIdentity;
  }

  public static async open(input: {
    readonly root: string;
    readonly exposedRoots: readonly string[];
  }): Promise<ExternalHiddenFixAssignmentStoreV1> {
    const root = await validateHostOnlyRoot(input);
    return new ExternalHiddenFixAssignmentStoreV1(
      root,
      await privateRootIdentity(root),
    );
  }

  public get root(): string {
    return this.#root;
  }

  async #requireRoot(): Promise<void> {
    const metadata = await lstat(this.#root);
    if (
      !sameRootIdentity(this.#rootIdentity, metadata) ||
      (await realpath(this.#root)) !== this.#root
    ) {
      throw new Error("M6 Host-only assignment root identity changed");
    }
  }

  #recordPath(
    assignmentIdInput: string,
    kind: Parameters<typeof privateRecordName>[1],
  ): string {
    const assignmentId = assignmentIdSchema.parse(assignmentIdInput);
    return resolve(this.#root, privateRecordName(assignmentId, kind));
  }

  async #writeOnce(input: {
    readonly assignmentId: string;
    readonly kind: Parameters<typeof privateRecordName>[1];
    readonly value: unknown;
  }): Promise<void> {
    await this.#requireRoot();
    const filename = privateRecordName(
      assignmentIdSchema.parse(input.assignmentId),
      input.kind,
    );
    const bytes = Buffer.from(
      `${canonicalJson(JsonValueSchema.parse(input.value))}\n`,
    );
    if (bytes.byteLength > RECORD_BYTE_LIMIT) {
      throw new Error("M6 private record exceeds its byte limit");
    }
    try {
      await publishPrivateFileOnceV1({
        root: this.#root,
        filename,
        bytes,
      });
    } catch (error) {
      if (isNodeError(error) && error.code === "EEXIST") {
        throw new Error(
          `M6 ${input.kind} already exists; assignment reruns and overwrites are forbidden`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  async #read<T>(input: {
    readonly assignmentId: string;
    readonly kind: Parameters<typeof privateRecordName>[1];
    readonly parse: (value: unknown) => T;
  }): Promise<T> {
    await this.#requireRoot();
    const path = this.#recordPath(input.assignmentId, input.kind);
    const canonicalPath = await requirePrivateRegularFile({
      root: this.#root,
      path,
      label: `M6 ${input.kind} record`,
    });
    const handle = await open(
      canonicalPath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const metadata = await handle.stat();
      if (metadata.size > RECORD_BYTE_LIMIT) {
        throw new Error("M6 private record exceeds its byte limit");
      }
      const bytes = await handle.readFile();
      let value: unknown;
      try {
        value = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        );
      } catch (error) {
        throw new Error("M6 private record is not valid UTF-8 JSON", {
          cause: error,
        });
      }
      return input.parse(value);
    } finally {
      await handle.close();
    }
  }

  public async createAssignment(
    input: CreateExternalHiddenFixAssignmentV1Input,
  ): Promise<ExternalHiddenFixAssignmentV1> {
    await this.#requireRoot();
    const identityBasis = assignmentIdentityBasisSchema.parse({
      schemaVersion: 1,
      subjectProjectSha256: input.subjectProjectSha256,
      pristineSelectedTreeSha256: input.pristineSelectedTreeSha256,
      mutatedBaselineSelectedTreeSha256:
        input.mutatedBaselineSelectedTreeSha256,
      publicTaskSpecSha256: input.publicTaskSpecSha256,
      taskBlindAdapterSha256: input.taskBlindAdapterSha256,
      mutationSha256: input.mutationSha256,
      evaluatorImplementationSha256: input.evaluatorImplementationSha256,
      evaluatorBundleSha256: input.evaluatorBundleSha256,
    });
    if (
      identityBasis.pristineSelectedTreeSha256 ===
      identityBasis.mutatedBaselineSelectedTreeSha256
    ) {
      throw new Error(
        "M6 holdout mutation must change the selected source tree",
      );
    }
    const assignmentIdentitySha256 = digestJson(identityBasis);
    const assignmentId = `m6-assignment:${assignmentIdentitySha256.slice(0, 24)}`;
    const baselineRoot = await requireProtectedBaselineTree(input.baselineRoot);
    if (
      !pathWithinOrEqual(this.#root, baselineRoot) ||
      baselineRoot === this.#root
    ) {
      throw new Error(
        "M6 protected baseline must be inside the Host-only root",
      );
    }
    const [mutationPath, evaluatorImplementationPath, evaluatorBundlePath] =
      await Promise.all([
        requirePrivateRegularFile({
          root: this.#root,
          path: input.mutationPath,
          label: "M6 mutation artifact",
          expectedSha256: identityBasis.mutationSha256,
        }),
        requirePrivateRegularFile({
          root: this.#root,
          path: input.evaluatorImplementationPath,
          label: "M6 evaluator implementation",
          expectedSha256: identityBasis.evaluatorImplementationSha256,
        }),
        requirePrivateRegularFile({
          root: this.#root,
          path: input.evaluatorBundlePath,
          label: "M6 evaluator bundle",
          expectedSha256: identityBasis.evaluatorBundleSha256,
        }),
      ]);
    for (const protectedFile of [
      mutationPath,
      evaluatorImplementationPath,
      evaluatorBundlePath,
    ]) {
      assertDisjoint(
        baselineRoot,
        protectedFile,
        "M6 mutation and evaluator files must be outside the baseline copied to the Agent",
      );
    }
    const recordBasis = {
      ...identityBasis,
      recordKind: "external-hidden-fix-assignment" as const,
      assignmentId,
      baselineRoot,
      mutationPath,
      evaluatorImplementationPath,
      evaluatorBundlePath,
      createdAt: z.string().datetime().parse(input.createdAt),
    };
    const assignment = ExternalHiddenFixAssignmentV1Schema.parse({
      ...recordBasis,
      recordContentSha256: digestJson(recordBasis),
    });
    await this.#writeOnce({
      assignmentId,
      kind: "assignment",
      value: assignment,
    });
    return assignment;
  }

  public async readAssignment(
    assignmentId: string,
  ): Promise<ExternalHiddenFixAssignmentV1> {
    const assignment = await this.#read({
      assignmentId,
      kind: "assignment",
      parse: (value) => ExternalHiddenFixAssignmentV1Schema.parse(value),
    });
    const baselineRoot = await requireProtectedBaselineTree(
      assignment.baselineRoot,
    );
    if (
      !pathWithinOrEqual(this.#root, baselineRoot) ||
      baselineRoot === this.#root
    ) {
      throw new Error("M6 assignment baseline escaped the Host-only root");
    }
    await Promise.all([
      requirePrivateRegularFile({
        root: this.#root,
        path: assignment.mutationPath,
        label: "M6 mutation artifact",
        expectedSha256: assignment.mutationSha256,
      }),
      requirePrivateRegularFile({
        root: this.#root,
        path: assignment.evaluatorImplementationPath,
        label: "M6 evaluator implementation",
        expectedSha256: assignment.evaluatorImplementationSha256,
      }),
      requirePrivateRegularFile({
        root: this.#root,
        path: assignment.evaluatorBundlePath,
        label: "M6 evaluator bundle",
        expectedSha256: assignment.evaluatorBundleSha256,
      }),
    ]);
    return assignment;
  }

  public async beginAttemptOnce(input: {
    readonly binding: ExternalHiddenFixAgentAttemptBindingV1;
    readonly startedAt: string;
  }): Promise<ExternalHiddenFixAttemptClaimV1> {
    const binding = ExternalHiddenFixAgentAttemptBindingV1Schema.parse(
      input.binding,
    );
    const assignment = await this.readAssignment(binding.assignmentId);
    if (
      binding.publicTaskSpecSha256 !== assignment.publicTaskSpecSha256 ||
      binding.workspaceBaselineSelectedTreeSha256 !==
        assignment.mutatedBaselineSelectedTreeSha256 ||
      binding.taskBlindAdapterSha256 !== assignment.taskBlindAdapterSha256
    ) {
      throw new Error(
        "M6 Agent attempt binding crossed its frozen assignment identities",
      );
    }
    const claim = createAttemptClaim(input);
    await this.#writeOnce({
      assignmentId: binding.assignmentId,
      kind: "attempt",
      value: claim,
    });
    return claim;
  }

  public readAttempt(
    assignmentId: string,
  ): Promise<ExternalHiddenFixAttemptClaimV1> {
    return this.#read({
      assignmentId,
      kind: "attempt",
      parse: (value) => ExternalHiddenFixAttemptClaimV1Schema.parse(value),
    });
  }

  public async putWorkflowAuditOnce<T>(input: {
    readonly assignmentId: string;
    readonly audit: unknown;
    readonly parse: (value: unknown) => T;
  }): Promise<void> {
    const audit = input.parse(input.audit);
    const jsonAudit = JsonValueSchema.parse(audit);
    const binding = workflowAuditStoreBindingSchema.parse(jsonAudit);
    const assignmentId = assignmentIdSchema.parse(input.assignmentId);
    if (binding.assignmentId !== assignmentId) {
      throw new Error("M6 public workflow audit crossed its assignment");
    }
    await this.readAttempt(assignmentId);
    const assignment = await this.readAssignment(assignmentId);
    if (
      binding.patchIdentity.baselineSelectedTreeSha256 !==
      assignment.mutatedBaselineSelectedTreeSha256
    ) {
      throw new Error(
        "M6 public workflow audit crossed its frozen assignment baseline",
      );
    }
    await this.#writeOnce({
      assignmentId,
      kind: "workflow-audit",
      value: jsonAudit,
    });
  }

  public readWorkflowAudit<T>(
    assignmentId: string,
    parse: (value: unknown) => T,
  ): Promise<T> {
    return this.#read({
      assignmentId,
      kind: "workflow-audit",
      parse: (value) => {
        const audit = parse(value);
        const binding = workflowAuditStoreBindingSchema.parse(
          JsonValueSchema.parse(audit),
        );
        if (binding.assignmentId !== assignmentId) {
          throw new Error("M6 public workflow audit crossed its assignment");
        }
        return audit;
      },
    });
  }

  public async putWorkflowReceiptOnce<T>(
    receiptInput: ExternalHiddenFixWorkflowEvidenceReceiptV1,
    parseWorkflowAudit?: (value: unknown) => T,
  ): Promise<void> {
    const receipt =
      ExternalHiddenFixWorkflowEvidenceReceiptV1Schema.parse(receiptInput);
    await this.readAttempt(receipt.assignmentId);
    const assignment = await this.readAssignment(receipt.assignmentId);
    if (
      receipt.patchIdentity.baselineSelectedTreeSha256 !==
      assignment.mutatedBaselineSelectedTreeSha256
    ) {
      throw new Error(
        "M6 public workflow receipt crossed its frozen assignment baseline",
      );
    }
    if (receipt.infrastructureFailureCode === null) {
      if (parseWorkflowAudit === undefined) {
        throw new Error(
          "M6 public workflow receipt requires its strict retained audit parser",
        );
      }
      const audit = await this.readWorkflowAudit(
        receipt.assignmentId,
        parseWorkflowAudit,
      );
      const binding = workflowAuditStoreBindingSchema.parse(
        JsonValueSchema.parse(audit),
      );
      if (
        binding.workflowReceiptContentSha256 !== receipt.receiptContentSha256 ||
        canonicalJson(binding.patchIdentity) !==
          canonicalJson(receipt.patchIdentity)
      ) {
        throw new Error(
          "M6 public workflow receipt does not match its retained workflow audit",
        );
      }
    }
    await this.#writeOnce({
      assignmentId: receipt.assignmentId,
      kind: "workflow",
      value: receipt,
    });
  }

  public readWorkflowReceipt(
    assignmentId: string,
  ): Promise<ExternalHiddenFixWorkflowEvidenceReceiptV1> {
    return this.#read({
      assignmentId,
      kind: "workflow",
      parse: (value) =>
        ExternalHiddenFixWorkflowEvidenceReceiptV1Schema.parse(value),
    });
  }

  public async claimEvaluatorRequestOnce(
    requestInput: ExternalHiddenFixEvaluationRequestV1,
  ): Promise<ExternalHiddenFixAssignmentV1> {
    const request =
      ExternalHiddenFixEvaluationRequestV1Schema.parse(requestInput);
    await this.readAttempt(request.assignmentId);
    let workflow: ExternalHiddenFixWorkflowEvidenceReceiptV1;
    try {
      workflow = await this.readWorkflowReceipt(request.assignmentId);
    } catch (error) {
      throw new Error(
        "M6 hidden evaluator requires a stored verified public workflow receipt",
        { cause: error },
      );
    }
    if (workflow.outcome !== "verified") {
      throw new Error(
        "M6 hidden evaluator requires a stored verified public workflow receipt",
      );
    }
    const assignment = await this.readAssignment(request.assignmentId);
    if (
      workflow.patchIdentity.baselineSelectedTreeSha256 !==
        assignment.mutatedBaselineSelectedTreeSha256 ||
      workflow.patchIdentity.candidateSelectedTreeSha256 !==
        request.expectedCandidateSelectedTreeSha256 ||
      workflow.patchIdentity.patchSha256 !== request.patch.rawSha256 ||
      workflow.patchIdentity.byteLength !== request.patch.byteLength
    ) {
      throw new Error(
        "M6 evaluator request crossed the candidate verified by the public workflow",
      );
    }
    await this.#writeOnce({
      assignmentId: request.assignmentId,
      kind: "evaluator-request",
      value: request,
    });
    return assignment;
  }

  public readEvaluatorRequest(
    assignmentId: string,
  ): Promise<ExternalHiddenFixEvaluationRequestV1> {
    return this.#read({
      assignmentId,
      kind: "evaluator-request",
      parse: (value) => ExternalHiddenFixEvaluationRequestV1Schema.parse(value),
    });
  }

  public async putEvaluatorReceiptOnce(
    receiptInput: ExternalHiddenFixFreshCopyAcceptanceReceiptV1,
  ): Promise<void> {
    const receipt =
      ExternalHiddenFixFreshCopyAcceptanceReceiptV1Schema.parse(receiptInput);
    const request = await this.readEvaluatorRequest(receipt.assignmentId);
    const assignment = await this.readAssignment(receipt.assignmentId);
    if (
      request.requestContentSha256 !== receipt.requestContentSha256 ||
      receipt.baselineSelectedTreeSha256 !==
        assignment.mutatedBaselineSelectedTreeSha256 ||
      receipt.expectedCandidateSelectedTreeSha256 !==
        request.expectedCandidateSelectedTreeSha256 ||
      receipt.patchSha256 !== request.patch.rawSha256 ||
      receipt.evaluatorImplementationSha256 !==
        assignment.evaluatorImplementationSha256 ||
      receipt.evaluatorBundleSha256 !== assignment.evaluatorBundleSha256
    ) {
      throw new Error(
        "M6 evaluator receipt is detached from its assignment or claimed request",
      );
    }
    await this.#writeOnce({
      assignmentId: receipt.assignmentId,
      kind: "evaluator-result",
      value: receipt,
    });
  }

  public readEvaluatorReceipt(
    assignmentId: string,
  ): Promise<ExternalHiddenFixFreshCopyAcceptanceReceiptV1> {
    return this.#read({
      assignmentId,
      kind: "evaluator-result",
      parse: (value) =>
        ExternalHiddenFixFreshCopyAcceptanceReceiptV1Schema.parse(value),
    });
  }

  public async putTerminalOnce(
    terminalInput: ExternalHiddenFixTerminalRecordV1,
  ): Promise<void> {
    const terminal =
      ExternalHiddenFixTerminalRecordV1Schema.parse(terminalInput);
    await this.readAttempt(terminal.assignmentId);
    const workflow =
      terminal.workflowReceiptSha256 === null
        ? null
        : await this.readWorkflowReceipt(terminal.assignmentId);
    if (
      workflow !== null &&
      workflow.receiptContentSha256 !== terminal.workflowReceiptSha256
    ) {
      throw new Error("M6 terminal workflow receipt hash does not match");
    }
    const evaluator =
      terminal.evaluatorReceiptSha256 === null
        ? null
        : await this.readEvaluatorReceipt(terminal.assignmentId);
    if (
      evaluator !== null &&
      evaluator.receiptContentSha256 !== terminal.evaluatorReceiptSha256
    ) {
      throw new Error("M6 terminal evaluator receipt hash does not match");
    }
    const effectiveOutcome =
      terminal.outcome === "cleanup_failed"
        ? terminal.primaryOutcome
        : terminal.outcome;
    if (
      effectiveOutcome === "accepted" &&
      (workflow?.outcome !== "verified" || evaluator?.outcome !== "accepted")
    ) {
      throw new Error(
        "M6 accepted terminal requires its stored verified workflow and accepted evaluator receipts",
      );
    }
    if (
      effectiveOutcome === "workflow_rejected" &&
      workflow?.outcome !== "rejected"
    ) {
      throw new Error(
        "M6 workflow_rejected terminal requires its stored rejected workflow receipt",
      );
    }
    if (
      effectiveOutcome === "evaluator_rejected" &&
      (workflow?.outcome !== "verified" || evaluator?.outcome !== "rejected")
    ) {
      throw new Error(
        "M6 evaluator_rejected terminal requires verified workflow and rejected evaluator receipts",
      );
    }
    if (evaluator !== null && terminal.patchSha256 !== evaluator.patchSha256) {
      throw new Error("M6 terminal patch hash crossed its evaluator receipt");
    }
    if (
      workflow !== null &&
      terminal.patchSha256 !== workflow.patchIdentity.patchSha256
    ) {
      throw new Error("M6 terminal patch hash crossed its workflow receipt");
    }
    await this.#writeOnce({
      assignmentId: terminal.assignmentId,
      kind: "terminal",
      value: terminal,
    });
  }

  public readTerminal(
    assignmentId: string,
  ): Promise<ExternalHiddenFixTerminalRecordV1> {
    return this.#read({
      assignmentId,
      kind: "terminal",
      parse: (value) => ExternalHiddenFixTerminalRecordV1Schema.parse(value),
    });
  }
}

export const openExternalHiddenFixAssignmentStoreV1 = (
  input: Parameters<typeof ExternalHiddenFixAssignmentStoreV1.open>[0],
): Promise<ExternalHiddenFixAssignmentStoreV1> =>
  ExternalHiddenFixAssignmentStoreV1.open(input);

export interface ExternalHiddenFixFreshCopyRunInputV1 {
  readonly assignmentId: string;
  readonly baselineRoot: string;
  readonly baselineSelectedTreeSha256: Sha256DigestV1;
  readonly evaluatorImplementationPath: string;
  readonly evaluatorImplementationSha256: Sha256DigestV1;
  readonly evaluatorBundlePath: string;
  readonly evaluatorBundleSha256: Sha256DigestV1;
  readonly patch: ExternalHiddenFixPatchReferenceV1;
  readonly expectedCandidateSelectedTreeSha256: Sha256DigestV1;
  readonly plan: ExternalHiddenFixFreshPlanEntryV1;
}

export const ExternalHiddenFixFreshCopyFailureCodeV1Schema = z.enum([
  "assignment_mismatch",
  "fresh_copy_failed",
  "candidate_tree_mismatch",
  "runner_failed",
  "cleanup_failed",
]);
export type ExternalHiddenFixFreshCopyFailureCodeV1 = z.infer<
  typeof ExternalHiddenFixFreshCopyFailureCodeV1Schema
>;

/** Trusted runner failures carry the exact stage classification and whether
 * every resource created before failure was cleaned. */
export interface ExternalHiddenFixFreshCopyRunFailureV1 {
  readonly failureCode: ExternalHiddenFixFreshCopyFailureCodeV1;
  readonly cleanupProven: boolean;
}

const freshCopyRunFailure = (
  error: unknown,
): ExternalHiddenFixFreshCopyRunFailureV1 | null => {
  if (typeof error !== "object" || error === null) return null;
  const candidate = error as {
    readonly failureCode?: unknown;
    readonly cleanupProven?: unknown;
  };
  const failureCode = ExternalHiddenFixFreshCopyFailureCodeV1Schema.safeParse(
    candidate.failureCode,
  );
  return failureCode.success && typeof candidate.cleanupProven === "boolean"
    ? Object.freeze({
        failureCode: failureCode.data,
        cleanupProven: candidate.cleanupProven,
      })
    : null;
};

/**
 * The port owns fresh-copy materialization and the task-specific oracle. It is
 * intentionally incapable of receiving an Agent Task ID, runtime store,
 * workflow receipt, prompt, ProjectAdapter, or Agent workspace.
 */
export interface ExternalHiddenFixFreshCopyRunnerV1 {
  runFreshCopy(
    input: ExternalHiddenFixFreshCopyRunInputV1,
    signal?: AbortSignal,
  ): Promise<ExternalHiddenFixFreshRunReceiptV1>;
}

const createEvaluatorReceipt = (input: {
  readonly assignment: ExternalHiddenFixAssignmentV1;
  readonly request: ExternalHiddenFixEvaluationRequestV1;
  readonly completedRuns: readonly ExternalHiddenFixFreshRunReceiptV1[];
  readonly infrastructureFailureCode:
    | "assignment_mismatch"
    | "fresh_copy_failed"
    | "candidate_tree_mismatch"
    | "runner_failed"
    | "cleanup_failed"
    | "persistence_failed"
    | null;
  readonly cleanupProven: boolean;
}): ExternalHiddenFixFreshCopyAcceptanceReceiptV1 => {
  return createExternalHiddenFixFreshCopyAcceptanceReceiptV1({
    assignmentId: input.assignment.assignmentId,
    requestContentSha256: input.request.requestContentSha256,
    baselineSelectedTreeSha256:
      input.assignment.mutatedBaselineSelectedTreeSha256,
    expectedCandidateSelectedTreeSha256:
      input.request.expectedCandidateSelectedTreeSha256,
    patchSha256: input.request.patch.rawSha256,
    evaluatorImplementationSha256:
      input.assignment.evaluatorImplementationSha256,
    evaluatorBundleSha256: input.assignment.evaluatorBundleSha256,
    completedRuns: input.completedRuns,
    infrastructureFailureCode: input.infrastructureFailureCode,
    cleanupProven: input.cleanupProven,
  });
};

const sameRunAsPlan = (input: {
  readonly receipt: ExternalHiddenFixFreshRunReceiptV1;
  readonly plan: ExternalHiddenFixFreshPlanEntryV1;
  readonly assignment: ExternalHiddenFixAssignmentV1;
  readonly request: ExternalHiddenFixEvaluationRequestV1;
}):
  | { readonly matched: true }
  | {
      readonly matched: false;
      readonly failureCode: "candidate_tree_mismatch" | "fresh_copy_failed";
    } => {
  const receipt = input.receipt;
  const plan = input.plan;
  if (
    receipt.candidateSelectedTreeSha256 !==
    input.request.expectedCandidateSelectedTreeSha256
  ) {
    return { matched: false, failureCode: "candidate_tree_mismatch" };
  }
  if (
    receipt.assignmentId !== input.assignment.assignmentId ||
    receipt.freshCopyId !== plan.freshCopyId ||
    receipt.ordinal !== plan.ordinal ||
    receipt.scenarioClass !== plan.scenarioClass ||
    receipt.repetition !== plan.repetition ||
    receipt.baselineSelectedTreeSha256 !==
      input.assignment.mutatedBaselineSelectedTreeSha256 ||
    receipt.patchSha256 !== input.request.patch.rawSha256
  ) {
    return { matched: false, failureCode: "fresh_copy_failed" };
  }
  return { matched: true };
};

/**
 * Runs the hidden evaluator once for a preregistered assignment. Claiming the
 * request is the first side effect, so a crash, rejection, or infrastructure
 * failure can never cause the Agent or evaluator to be run again implicitly.
 */
export const runExternalHiddenFixEvaluatorOnceV1 = async (input: {
  readonly store: ExternalHiddenFixAssignmentStoreV1;
  readonly request: ExternalHiddenFixEvaluationRequestV1;
  readonly runner: ExternalHiddenFixFreshCopyRunnerV1;
  readonly signal?: AbortSignal | undefined;
}): Promise<ExternalHiddenFixFreshCopyAcceptanceReceiptV1> => {
  const request = ExternalHiddenFixEvaluationRequestV1Schema.parse(
    input.request,
  );
  const assignment = await input.store.claimEvaluatorRequestOnce(request);
  const completedRuns: ExternalHiddenFixFreshRunReceiptV1[] = [];
  let infrastructureFailureCode:
    | "assignment_mismatch"
    | "fresh_copy_failed"
    | "candidate_tree_mismatch"
    | "runner_failed"
    | "cleanup_failed"
    | null = null;
  let cleanupProven = true;

  if (
    request.expectedCandidateSelectedTreeSha256 ===
    assignment.mutatedBaselineSelectedTreeSha256
  ) {
    infrastructureFailureCode = "assignment_mismatch";
  } else {
    const plan = createExternalHiddenFixFreshEvaluationPlanV1(
      assignment.assignmentId,
    );
    for (const entry of plan) {
      if (input.signal?.aborted === true) {
        infrastructureFailureCode = "runner_failed";
        cleanupProven = false;
        break;
      }
      let rawReceipt: ExternalHiddenFixFreshRunReceiptV1;
      try {
        rawReceipt = ExternalHiddenFixFreshRunReceiptV1Schema.parse(
          await input.runner.runFreshCopy(
            {
              assignmentId: assignment.assignmentId,
              baselineRoot: assignment.baselineRoot,
              baselineSelectedTreeSha256:
                assignment.mutatedBaselineSelectedTreeSha256,
              evaluatorImplementationPath:
                assignment.evaluatorImplementationPath,
              evaluatorImplementationSha256:
                assignment.evaluatorImplementationSha256,
              evaluatorBundlePath: assignment.evaluatorBundlePath,
              evaluatorBundleSha256: assignment.evaluatorBundleSha256,
              patch: request.patch,
              expectedCandidateSelectedTreeSha256:
                request.expectedCandidateSelectedTreeSha256,
              plan: entry,
            },
            input.signal,
          ),
        );
      } catch (error) {
        const failure = freshCopyRunFailure(error);
        infrastructureFailureCode = failure?.failureCode ?? "runner_failed";
        cleanupProven = failure?.cleanupProven ?? false;
        break;
      }
      const match = sameRunAsPlan({
        receipt: rawReceipt,
        plan: entry,
        assignment,
        request,
      });
      if (!match.matched) {
        infrastructureFailureCode = match.failureCode;
        cleanupProven = rawReceipt.cleanupProven;
        break;
      }
      completedRuns.push(rawReceipt);
      if (!rawReceipt.cleanupProven) {
        infrastructureFailureCode = "cleanup_failed";
        cleanupProven = false;
        break;
      }
    }
  }

  const receipt = createEvaluatorReceipt({
    assignment,
    request,
    completedRuns,
    infrastructureFailureCode,
    cleanupProven,
  });
  await input.store.putEvaluatorReceiptOnce(receipt);
  return receipt;
};
