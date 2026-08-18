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
  SourceIdSchema,
  asSha256DigestV1,
  type Sha256DigestV1,
} from "@chronorift/domain";
import { canonicalJson } from "@chronorift/json-artifacts";
import { z } from "zod";

import { collectCandidateGodotSourceV1 } from "./candidate-godot-build.js";
import {
  ExternalHiddenFixFreshRunReceiptV1Schema,
  type ExternalHiddenFixFreshCopyRunInputV1,
  type ExternalHiddenFixFreshCopyRunnerV1,
  type ExternalHiddenFixPatchReferenceV1,
} from "./external-hidden-fix.js";
import { publishPrivateFileOnceV1 } from "./private-atomic-publication.js";
import {
  BwrapExternalHiddenFixEvaluatorProcessV1,
  ExternalHiddenFixFreshCopyInfrastructureErrorV1,
  LocalExternalHiddenFixFreshCopyRunnerV1,
  LocalExternalHiddenFixPatchStoreV1,
  type ExternalHiddenFixEvaluatorRuntimeMountV1,
} from "./external-hidden-fix-evaluator.js";
import {
  M7AgentAttemptEvidenceSidecarV1Schema,
  M7PairedAgentArmResultV1Schema,
  M7PairedAgentAttemptBindingV1Schema,
  M7PairedAgentCleanupResultV1Schema,
  M7RuntimeUseExecutionSummaryV1Schema,
  type M7AgentAttemptEvidenceSidecarV1,
  type M7PairedAgentAttemptRecordV1,
  type M7RuntimeUseExecutionSummaryV1,
} from "./m7-paired-agent.js";
import { M7FrozenPatrolClassifierOutputV1Schema as M7AuthoritativeFrozenPatrolClassifierOutputV1Schema } from "./m7-patrol-sensor.js";
import {
  M7ArmV1Schema,
  createM7ArmResultV1,
  deriveM7BuildSourceIdentitySha256V1,
  type M7ArmClaimV1,
  type M7ArmResultV1,
  type M7ArmV1,
  type M7CampaignSensorBindingV1,
  type M7CandidatePatchV1,
  type M7CampaignTerminalRecordV1,
  type M7MutationRegistrationV1,
  type M7RuntimeUseCampaignStoreV1,
} from "./m7-runtime-use-campaign.js";
import { selectedTreeSha256 } from "./selected-tree.js";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const RECORD_BYTE_LIMIT = 1024 * 1024;
const BASELINE_ENTRY_LIMIT = 50_000;

const campaignIdSchema = z.string().regex(/^m7-campaign:[a-f0-9]{24}$/u);
const sensorFreezeIdSchema = z
  .string()
  .regex(/^m7-sensor-freeze:[a-f0-9]{24}$/u);
const campaignSensorBindingIdSchema = z
  .string()
  .regex(/^m7-campaign-sensor-binding:[a-f0-9]{24}$/u);
const opaqueIdSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:+-]*$/u);
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
    throw new Error("M7 local Gate requires effective-user ownership checks");
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
    throw new Error(
      `${label} must be owned by the current user with mode 0700`,
    );
  }
  return directory;
};

const requireDirectoryIdentity = async (
  path: string,
  expected: DirectoryIdentity,
  label: string,
): Promise<void> => {
  const directory = await requireCanonicalDirectory(path, label);
  if (
    directory.identity.dev !== expected.dev ||
    directory.identity.ino !== expected.ino ||
    directory.identity.uid !== expected.uid ||
    directory.identity.mode !== expected.mode ||
    (directory.identity.mode & 0o7777) !== PRIVATE_DIRECTORY_MODE
  ) {
    throw new Error(`${label} identity changed`);
  }
};

const requirePrivateFile = async (input: {
  readonly root: string;
  readonly path: string;
  readonly expectedSha256: Sha256DigestV1;
  readonly label: string;
}): Promise<string> => {
  const path = resolve(input.path);
  if (!pathWithinOrEqual(input.root, path) || path === input.root) {
    throw new Error(`${input.label} must remain inside the Host-only root`);
  }
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
      pathMetadata.isSymbolicLink() ||
      pathMetadata.dev !== metadata.dev ||
      pathMetadata.ino !== metadata.ino ||
      canonical !== path ||
      metadata.size > RECORD_BYTE_LIMIT
    ) {
      throw new Error(`${input.label} is not its frozen private file`);
    }
    if (digest(await handle.readFile()) !== input.expectedSha256) {
      throw new Error(`${input.label} content hash changed`);
    }
  } finally {
    await handle.close();
  }
  return path;
};

const requireProtectedBaseline = async (rootInput: string): Promise<string> => {
  const { path: root } = await requirePrivateDirectory(
    rootInput,
    "M7 Host-only mutated baseline",
  );
  const pending = [root];
  let entries = 0;
  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined) break;
    const names = await readdir(directory, { encoding: "utf8" });
    for (const name of names) {
      entries += 1;
      if (entries > BASELINE_ENTRY_LIMIT) {
        throw new Error("M7 protected baseline exceeds its entry limit");
      }
      const path = resolve(directory, name);
      if (!pathWithinOrEqual(root, path)) {
        throw new Error("M7 protected baseline entry escaped its root");
      }
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) {
        throw new Error("M7 protected baseline must not contain symlinks");
      }
      if (metadata.isDirectory()) pending.push(path);
      else if (!metadata.isFile() || metadata.nlink !== 1) {
        throw new Error(
          "M7 protected baseline entries must be one-link regular files",
        );
      }
    }
  }
  return root;
};

const selectedSourceIdentity = async (
  workspaceRoot: string,
): Promise<Sha256DigestV1> =>
  selectedTreeSha256(
    await collectCandidateGodotSourceV1(
      workspaceRoot,
      "project-environment",
      "tracked-tool-scripts-v1",
    ),
  );

const localMaterialsBaseSchema = z.object({
  schemaVersion: z.literal(1),
  recordKind: z.literal("m7-local-mutation-materials"),
  campaignId: campaignIdSchema,
  mutationRegistrationSha256: Sha256DigestV1Schema,
  evaluatorAssignmentId: z.string().regex(/^m6-assignment:[a-f0-9]{24}$/u),
  baselineRoot: absolutePathSchema,
  baselineSelectedTreeSha256: Sha256DigestV1Schema,
  evaluatorImplementationPath: absolutePathSchema,
  evaluatorImplementationSha256: Sha256DigestV1Schema,
  evaluatorBundlePath: absolutePathSchema,
  evaluatorBundleSha256: Sha256DigestV1Schema,
  registeredAt: z.string().datetime(),
  recordContentSha256: Sha256DigestV1Schema,
});

export const M7LocalMutationMaterialsV1Schema = localMaterialsBaseSchema
  .strict()
  .superRefine((value, context) => {
    const expectedAssignmentId = `m6-assignment:${digest(
      `m7-local-evaluator\0${value.campaignId}`,
    ).slice(0, 24)}`;
    if (value.evaluatorAssignmentId !== expectedAssignmentId) {
      addIssue(
        context,
        ["evaluatorAssignmentId"],
        "local evaluator assignment ID must derive from the campaign",
      );
    }
    const { recordContentSha256, ...basis } = value;
    if (recordContentSha256 !== digestJson(basis)) {
      addIssue(
        context,
        ["recordContentSha256"],
        "local mutation-material record hash does not match",
      );
    }
  });
export type M7LocalMutationMaterialsV1 = z.infer<
  typeof M7LocalMutationMaterialsV1Schema
>;

const recordFilename = (campaignId: string): string =>
  `${digest(campaignId)}.m7-local-mutation-materials.json`;

/**
 * Host-only resolver for the baseline and oracle bytes. The formal Gate takes
 * this store object, never a baseline/evaluator path supplied by an Agent arm.
 */
export class M7RuntimeUseLocalMutationStoreV1 {
  readonly #root: string;
  readonly #identity: DirectoryIdentity;

  private constructor(root: string, identity: DirectoryIdentity) {
    this.#root = root;
    this.#identity = identity;
  }

  public static async open(input: {
    readonly root: string;
    readonly exposedRoots: readonly string[];
  }): Promise<M7RuntimeUseLocalMutationStoreV1> {
    const root = await requirePrivateDirectory(
      input.root,
      "M7 local mutation-material root",
    );
    for (const [index, exposedInput] of input.exposedRoots.entries()) {
      const exposed = await requireCanonicalDirectory(
        exposedInput,
        `M7 Agent-exposed root ${index + 1}`,
      );
      if (
        pathWithinOrEqual(root.path, exposed.path) ||
        pathWithinOrEqual(exposed.path, root.path)
      ) {
        throw new Error(
          "M7 local mutation-material root must be disjoint from Agent roots",
        );
      }
    }
    return new M7RuntimeUseLocalMutationStoreV1(root.path, root.identity);
  }

  public get root(): string {
    return this.#root;
  }

  async #requireRoot(): Promise<void> {
    await requireDirectoryIdentity(
      this.#root,
      this.#identity,
      "M7 local mutation-material root",
    );
  }

  #recordPath(campaignIdInput: string): string {
    const campaignId = campaignIdSchema.parse(campaignIdInput);
    return resolve(this.#root, recordFilename(campaignId));
  }

  async #writeOnce(record: M7LocalMutationMaterialsV1): Promise<void> {
    await this.#requireRoot();
    const filename = recordFilename(record.campaignId);
    const bytes = Buffer.from(`${canonicalJson(record)}\n`);
    try {
      await publishPrivateFileOnceV1({
        root: this.#root,
        filename,
        bytes,
      });
    } catch (error) {
      if (isNodeError(error) && error.code === "EEXIST") {
        throw new Error(
          "M7 local mutation materials already exist; replacement is forbidden",
          { cause: error },
        );
      }
      throw error;
    }
  }

  async #read(campaignId: string): Promise<M7LocalMutationMaterialsV1> {
    await this.#requireRoot();
    const path = this.#recordPath(campaignId);
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
        throw new Error("M7 local mutation-material record identity changed");
      }
      return M7LocalMutationMaterialsV1Schema.parse(
        JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            await handle.readFile(),
          ),
        ) as unknown,
      );
    } finally {
      await handle.close();
    }
  }

  public async registerOnce(input: {
    readonly registration: M7MutationRegistrationV1;
    readonly baselineRoot: string;
    readonly evaluatorImplementationPath: string;
    readonly evaluatorBundlePath: string;
    readonly registeredAt: string;
  }): Promise<M7LocalMutationMaterialsV1> {
    await this.#requireRoot();
    const baselineRoot = await requireProtectedBaseline(input.baselineRoot);
    if (
      !pathWithinOrEqual(this.#root, baselineRoot) ||
      baselineRoot === this.#root
    ) {
      throw new Error("M7 mutated baseline must be below the Host-only root");
    }
    const [evaluatorImplementationPath, evaluatorBundlePath] =
      await Promise.all([
        requirePrivateFile({
          root: this.#root,
          path: input.evaluatorImplementationPath,
          expectedSha256: input.registration.evaluatorImplementationSha256,
          label: "M7 hidden evaluator implementation",
        }),
        requirePrivateFile({
          root: this.#root,
          path: input.evaluatorBundlePath,
          expectedSha256: input.registration.evaluatorBundleSha256,
          label: "M7 hidden evaluator bundle",
        }),
      ]);
    if (
      pathWithinOrEqual(baselineRoot, evaluatorImplementationPath) ||
      pathWithinOrEqual(baselineRoot, evaluatorBundlePath)
    ) {
      throw new Error("M7 hidden evaluator files must be outside the baseline");
    }
    const baselineSelectedTreeSha256 =
      await selectedSourceIdentity(baselineRoot);
    if (
      baselineSelectedTreeSha256 !==
      input.registration.mutatedBaselineSelectedTreeSha256
    ) {
      throw new Error("M7 Host-only baseline does not match the mutation");
    }
    const recordBasis = {
      schemaVersion: 1 as const,
      recordKind: "m7-local-mutation-materials" as const,
      campaignId: input.registration.campaignId,
      mutationRegistrationSha256: input.registration.recordContentSha256,
      evaluatorAssignmentId: `m6-assignment:${digest(
        `m7-local-evaluator\0${input.registration.campaignId}`,
      ).slice(0, 24)}`,
      baselineRoot,
      baselineSelectedTreeSha256,
      evaluatorImplementationPath,
      evaluatorImplementationSha256:
        input.registration.evaluatorImplementationSha256,
      evaluatorBundlePath,
      evaluatorBundleSha256: input.registration.evaluatorBundleSha256,
      registeredAt: z.string().datetime().parse(input.registeredAt),
    };
    const record = M7LocalMutationMaterialsV1Schema.parse({
      ...recordBasis,
      recordContentSha256: digestJson(recordBasis),
    });
    await this.#writeOnce(record);
    return record;
  }

  public async resolve(
    campaignIdInput: string,
    registrationInput: M7MutationRegistrationV1,
  ): Promise<M7LocalMutationMaterialsV1> {
    const campaignId = campaignIdSchema.parse(campaignIdInput);
    const record = await this.#read(campaignId);
    if (
      record.campaignId !== registrationInput.campaignId ||
      record.mutationRegistrationSha256 !==
        registrationInput.recordContentSha256 ||
      record.baselineSelectedTreeSha256 !==
        registrationInput.mutatedBaselineSelectedTreeSha256 ||
      record.evaluatorImplementationSha256 !==
        registrationInput.evaluatorImplementationSha256 ||
      record.evaluatorBundleSha256 !== registrationInput.evaluatorBundleSha256
    ) {
      throw new Error("M7 local materials crossed their campaign mutation");
    }
    const baselineRoot = await requireProtectedBaseline(record.baselineRoot);
    if (
      !pathWithinOrEqual(this.#root, baselineRoot) ||
      (await selectedSourceIdentity(baselineRoot)) !==
        record.baselineSelectedTreeSha256
    ) {
      throw new Error("M7 Host-only baseline identity changed");
    }
    await Promise.all([
      requirePrivateFile({
        root: this.#root,
        path: record.evaluatorImplementationPath,
        expectedSha256: record.evaluatorImplementationSha256,
        label: "M7 hidden evaluator implementation",
      }),
      requirePrivateFile({
        root: this.#root,
        path: record.evaluatorBundlePath,
        expectedSha256: record.evaluatorBundleSha256,
        label: "M7 hidden evaluator bundle",
      }),
    ]);
    return record;
  }
}

const thinkingLevelSchema = z.enum([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

const campaignArmClaimInputSchema = z
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
    taskId: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:+-]*$/u),
    sessionIdentitySha256: Sha256DigestV1Schema,
    workspaceIdentitySha256: Sha256DigestV1Schema,
    cacheIdentitySha256: Sha256DigestV1Schema,
    startedAt: z.string().datetime(),
  })
  .strict();

export const M7LocalArmAdmissionV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    arm: M7ArmV1Schema,
    claim: campaignArmClaimInputSchema,
    pairedAttemptBindingContentSha256: Sha256DigestV1Schema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.arm !== value.claim.arm) {
      addIssue(context, ["claim", "arm"], "admission crossed its arm");
    }
  });
export type M7LocalArmAdmissionV1 = z.infer<typeof M7LocalArmAdmissionV1Schema>;

const runtimeUseRejectionReasonSchema = z.enum([
  "no_runtime_summaries",
  "runtime_record_receipt_missing",
  "classifier_identity_mismatch",
  "classifier_output_not_frozen",
  "source_change_missing",
  "source_change_inconsistent",
  "no_baseline_fall_witness",
  "baseline_build_mismatch",
  "baseline_not_exchange_bound",
  "baseline_incomplete_or_lossy",
  "baseline_not_before_source_change",
]);

const runtimeUseEvidenceBaseSchema = z.object({
  schemaVersion: z.literal(1),
  recordKind: z.literal("m7-runtime-use-evidence"),
  campaignId: campaignIdSchema,
  arm: z.literal("runtime_enabled"),
  mutationRegistrationSha256: Sha256DigestV1Schema,
  attemptBindingContentSha256: Sha256DigestV1Schema,
  campaignSensorBindingId: campaignSensorBindingIdSchema,
  campaignSensorBindingRecordSha256: Sha256DigestV1Schema,
  authoritativeSensorFreezeId: sensorFreezeIdSchema,
  authoritativeSensorFreezeRecordSha256: Sha256DigestV1Schema,
  classifierImplementationSha256: Sha256DigestV1Schema,
  mutatedBaselineSelectedTreeSha256: Sha256DigestV1Schema,
  mutatedBaselineBuildId: opaqueIdSchema.nullable(),
  candidateSelectedTreeSha256: Sha256DigestV1Schema.nullable(),
  sourceRuntimeEvidenceReceiptSha256: Sha256DigestV1Schema.nullable(),
  summaries: z.array(M7RuntimeUseExecutionSummaryV1Schema).max(1_000),
  baselineSummary: M7RuntimeUseExecutionSummaryV1Schema.nullable(),
  candidateSummary: M7RuntimeUseExecutionSummaryV1Schema.nullable(),
  baselineAgentVisibleInputSha256: Sha256DigestV1Schema.nullable(),
  candidateAgentVisibleInputSha256: Sha256DigestV1Schema.nullable(),
  baselineFallWitnessCount: z.number().int().nonnegative().max(4_096),
  baselineFallWitnessSha256: Sha256DigestV1Schema.nullable(),
  candidateRecoveryWitnessCount: z.number().int().nonnegative().max(4_096),
  candidateRecoveryWitnessSha256: Sha256DigestV1Schema.nullable(),
  firstHostObservedSourceChangeOrdinal: z
    .number()
    .int()
    .min(1)
    .max(Number.MAX_SAFE_INTEGER)
    .nullable(),
  firstHostObservedSourceChangeAt: z.string().datetime().nullable(),
  outcome: z.enum(["verified", "rejected", "missing", "infrastructure_failed"]),
  infrastructureFailureCode: z.enum(["paired_attempt_unavailable"]).nullable(),
  rejectionReasons: z.array(runtimeUseRejectionReasonSchema),
  recordContentSha256: Sha256DigestV1Schema,
});

interface RuntimeUseDerivation {
  readonly baselineSummary: M7RuntimeUseExecutionSummaryV1 | null;
  readonly candidateSummary: M7RuntimeUseExecutionSummaryV1 | null;
  readonly baselineAgentVisibleInputSha256: Sha256DigestV1 | null;
  readonly candidateAgentVisibleInputSha256: Sha256DigestV1 | null;
  readonly baselineFallWitnessCount: number;
  readonly baselineFallWitnessSha256: Sha256DigestV1 | null;
  readonly candidateRecoveryWitnessCount: number;
  readonly candidateRecoveryWitnessSha256: Sha256DigestV1 | null;
  readonly firstHostObservedSourceChangeOrdinal: number | null;
  readonly firstHostObservedSourceChangeAt: string | null;
  readonly outcome:
    "verified" | "rejected" | "missing" | "infrastructure_failed";
  readonly rejectionReasons: readonly z.infer<
    typeof runtimeUseRejectionReasonSchema
  >[];
}

const usableExecutionSummary = (
  summary: M7RuntimeUseExecutionSummaryV1,
): boolean =>
  summary.sealed &&
  summary.coverageComplete &&
  !summary.historyLossObserved &&
  summary.cleanupProven;

const runtimeWitnesses = (
  summary: M7RuntimeUseExecutionSummaryV1 | null,
  outcome: "fell_without_reversing" | "reversed_while_grounded",
) =>
  summary?.classificationOutput.witnesses.filter(
    (entry) => entry.outcome === outcome,
  ) ?? [];

const deriveRuntimeUseEvidence = (input: {
  readonly summaries: readonly M7RuntimeUseExecutionSummaryV1[];
  readonly classifierImplementationSha256: Sha256DigestV1;
  readonly mutatedBaselineBuildId: string | null;
  readonly sourceRuntimeEvidenceReceiptSha256: Sha256DigestV1 | null;
  readonly mutatedBaselineSelectedTreeSha256: Sha256DigestV1;
  readonly candidateSelectedTreeSha256: Sha256DigestV1 | null;
  readonly infrastructureFailed: boolean;
}): RuntimeUseDerivation => {
  const summaries = input.summaries;
  const baselineSummary =
    summaries.find(
      (summary) =>
        summary.sourceSha256 === input.mutatedBaselineSelectedTreeSha256 &&
        summary.classification === "fell_without_reversing",
    ) ?? null;
  const candidateSummary =
    input.candidateSelectedTreeSha256 === null
      ? null
      : (summaries.find(
          (summary) =>
            summary.sourceSha256 === input.candidateSelectedTreeSha256 &&
            summary.classification === "reversed_while_grounded",
        ) ?? null);
  const fallWitnesses = runtimeWitnesses(
    baselineSummary,
    "fell_without_reversing",
  );
  const recoveryWitnesses = runtimeWitnesses(
    candidateSummary,
    "reversed_while_grounded",
  );
  const boundaries = summaries
    .map((summary) => summary.firstHostObservedSourceChange)
    .filter((boundary) => boundary !== null);
  const distinctBoundaries = new Map(
    boundaries.map((boundary) => [canonicalJson(boundary), boundary]),
  );
  const firstBoundary = baselineSummary?.firstHostObservedSourceChange ?? null;
  const reasons = new Set<z.infer<typeof runtimeUseRejectionReasonSchema>>();
  if (summaries.length === 0) reasons.add("no_runtime_summaries");
  if (input.sourceRuntimeEvidenceReceiptSha256 === null) {
    reasons.add("runtime_record_receipt_missing");
  }
  if (
    baselineSummary !== null &&
    baselineSummary.classifierImplementationSha256 !==
      input.classifierImplementationSha256
  ) {
    reasons.add("classifier_identity_mismatch");
  }
  if (
    baselineSummary !== null &&
    !M7AuthoritativeFrozenPatrolClassifierOutputV1Schema.safeParse(
      baselineSummary.classificationOutput,
    ).success
  ) {
    reasons.add("classifier_output_not_frozen");
  }
  if (firstBoundary === null) reasons.add("source_change_missing");
  if (
    distinctBoundaries.size > 1 ||
    (firstBoundary !== null &&
      boundaries.some(
        (boundary) => canonicalJson(boundary) !== canonicalJson(firstBoundary),
      ))
  ) {
    reasons.add("source_change_inconsistent");
  }
  if (baselineSummary === null) reasons.add("no_baseline_fall_witness");
  else {
    if (
      input.mutatedBaselineBuildId === null ||
      baselineSummary.buildId !== input.mutatedBaselineBuildId
    ) {
      reasons.add("baseline_build_mismatch");
    }
    if (baselineSummary.classificationHostToolReturnOrdinal === null) {
      reasons.add("baseline_not_exchange_bound");
    }
    if (!usableExecutionSummary(baselineSummary)) {
      reasons.add("baseline_incomplete_or_lossy");
    }
    if (
      firstBoundary === null ||
      baselineSummary.classificationHostToolReturnOrdinal === null ||
      baselineSummary.classificationHostToolReturnOrdinal >=
        firstBoundary.hostToolReturnOrdinal
    ) {
      reasons.add("baseline_not_before_source_change");
    }
  }
  const rejectionReasons = runtimeUseRejectionReasonSchema.options.filter(
    (reason) => reasons.has(reason),
  );
  const outcome = input.infrastructureFailed
    ? ("infrastructure_failed" as const)
    : summaries.length === 0
      ? ("missing" as const)
      : rejectionReasons.length === 0
        ? ("verified" as const)
        : ("rejected" as const);
  return {
    baselineSummary,
    candidateSummary,
    baselineAgentVisibleInputSha256:
      baselineSummary?.classifierInputSha256 ?? null,
    candidateAgentVisibleInputSha256:
      candidateSummary?.classifierInputSha256 ?? null,
    baselineFallWitnessCount: fallWitnesses.length,
    baselineFallWitnessSha256:
      fallWitnesses.length === 0 ? null : digestJson(fallWitnesses),
    candidateRecoveryWitnessCount: recoveryWitnesses.length,
    candidateRecoveryWitnessSha256:
      recoveryWitnesses.length === 0 ? null : digestJson(recoveryWitnesses),
    firstHostObservedSourceChangeOrdinal:
      firstBoundary?.hostToolReturnOrdinal ?? null,
    firstHostObservedSourceChangeAt: firstBoundary?.observedAt ?? null,
    outcome,
    rejectionReasons,
  };
};

export const M7RuntimeUseEvidenceReceiptV1Schema = runtimeUseEvidenceBaseSchema
  .strict()
  .superRefine((value, context) => {
    const expected = deriveRuntimeUseEvidence({
      summaries: value.summaries,
      classifierImplementationSha256: value.classifierImplementationSha256,
      mutatedBaselineBuildId: value.mutatedBaselineBuildId,
      sourceRuntimeEvidenceReceiptSha256:
        value.sourceRuntimeEvidenceReceiptSha256,
      mutatedBaselineSelectedTreeSha256:
        value.mutatedBaselineSelectedTreeSha256,
      candidateSelectedTreeSha256: value.candidateSelectedTreeSha256,
      infrastructureFailed: value.infrastructureFailureCode !== null,
    });
    for (const [field, actual, wanted] of [
      ["baselineSummary", value.baselineSummary, expected.baselineSummary],
      ["candidateSummary", value.candidateSummary, expected.candidateSummary],
      [
        "baselineAgentVisibleInputSha256",
        value.baselineAgentVisibleInputSha256,
        expected.baselineAgentVisibleInputSha256,
      ],
      [
        "candidateAgentVisibleInputSha256",
        value.candidateAgentVisibleInputSha256,
        expected.candidateAgentVisibleInputSha256,
      ],
      [
        "baselineFallWitnessCount",
        value.baselineFallWitnessCount,
        expected.baselineFallWitnessCount,
      ],
      [
        "baselineFallWitnessSha256",
        value.baselineFallWitnessSha256,
        expected.baselineFallWitnessSha256,
      ],
      [
        "candidateRecoveryWitnessCount",
        value.candidateRecoveryWitnessCount,
        expected.candidateRecoveryWitnessCount,
      ],
      [
        "candidateRecoveryWitnessSha256",
        value.candidateRecoveryWitnessSha256,
        expected.candidateRecoveryWitnessSha256,
      ],
      [
        "firstHostObservedSourceChangeOrdinal",
        value.firstHostObservedSourceChangeOrdinal,
        expected.firstHostObservedSourceChangeOrdinal,
      ],
      [
        "firstHostObservedSourceChangeAt",
        value.firstHostObservedSourceChangeAt,
        expected.firstHostObservedSourceChangeAt,
      ],
      ["outcome", value.outcome, expected.outcome],
      ["rejectionReasons", value.rejectionReasons, expected.rejectionReasons],
    ] as const) {
      if (
        canonicalJson(JsonValueSchema.parse(actual)) !==
        canonicalJson(JsonValueSchema.parse(wanted))
      ) {
        addIssue(
          context,
          [field],
          "runtime-use receipt field does not derive from typed Host summaries",
        );
      }
    }
    const { recordContentSha256, ...basis } = value;
    if (recordContentSha256 !== digestJson(basis)) {
      addIssue(
        context,
        ["recordContentSha256"],
        "runtime-use receipt content hash does not match",
      );
    }
  });
export type M7RuntimeUseEvidenceReceiptV1 = z.infer<
  typeof M7RuntimeUseEvidenceReceiptV1Schema
>;

const createM7RuntimeUseEvidenceReceiptV1 = (input: {
  readonly campaignId: string;
  readonly registration: M7MutationRegistrationV1;
  readonly sensorBinding: M7CampaignSensorBindingV1;
  readonly classifierImplementationSha256: Sha256DigestV1;
  readonly mutatedBaselineBuildId: string | null;
  readonly attemptBindingContentSha256: Sha256DigestV1;
  readonly candidateSelectedTreeSha256: Sha256DigestV1 | null;
  readonly sourceRuntimeEvidenceReceiptSha256: Sha256DigestV1 | null;
  readonly summaries: readonly M7RuntimeUseExecutionSummaryV1[];
  readonly infrastructureFailed: boolean;
}): M7RuntimeUseEvidenceReceiptV1 => {
  if (
    input.classifierImplementationSha256 !==
      input.sensorBinding.publicPatrolClassifierSha256 ||
    input.registration.campaignSensorBindingId !==
      input.sensorBinding.campaignSensorBindingId ||
    input.registration.campaignSensorBindingRecordSha256 !==
      input.sensorBinding.recordContentSha256 ||
    input.registration.sensorFreezeId !==
      input.sensorBinding.authoritativeSensorFreezeId ||
    input.registration.sensorFreezeRecordSha256 !==
      input.sensorBinding.authoritativeSensorFreezeRecordSha256
  ) {
    throw new Error(
      "M7 runtime-use checker is detached from the authoritative sensor binding",
    );
  }
  const summaries = input.summaries.map((summary) =>
    M7RuntimeUseExecutionSummaryV1Schema.parse(summary),
  );
  const derived = deriveRuntimeUseEvidence({
    summaries,
    classifierImplementationSha256: input.classifierImplementationSha256,
    mutatedBaselineBuildId: input.mutatedBaselineBuildId,
    sourceRuntimeEvidenceReceiptSha256:
      input.sourceRuntimeEvidenceReceiptSha256,
    mutatedBaselineSelectedTreeSha256:
      input.registration.mutatedBaselineSelectedTreeSha256,
    candidateSelectedTreeSha256: input.candidateSelectedTreeSha256,
    infrastructureFailed: input.infrastructureFailed,
  });
  const basis = {
    schemaVersion: 1 as const,
    recordKind: "m7-runtime-use-evidence" as const,
    campaignId: campaignIdSchema.parse(input.campaignId),
    arm: "runtime_enabled" as const,
    mutationRegistrationSha256: input.registration.recordContentSha256,
    attemptBindingContentSha256: input.attemptBindingContentSha256,
    campaignSensorBindingId: input.sensorBinding.campaignSensorBindingId,
    campaignSensorBindingRecordSha256: input.sensorBinding.recordContentSha256,
    authoritativeSensorFreezeId:
      input.sensorBinding.authoritativeSensorFreezeId,
    authoritativeSensorFreezeRecordSha256:
      input.sensorBinding.authoritativeSensorFreezeRecordSha256,
    classifierImplementationSha256: input.classifierImplementationSha256,
    mutatedBaselineSelectedTreeSha256:
      input.registration.mutatedBaselineSelectedTreeSha256,
    mutatedBaselineBuildId: input.mutatedBaselineBuildId,
    candidateSelectedTreeSha256: input.candidateSelectedTreeSha256,
    sourceRuntimeEvidenceReceiptSha256:
      input.sourceRuntimeEvidenceReceiptSha256,
    summaries,
    ...derived,
    infrastructureFailureCode: input.infrastructureFailed
      ? ("paired_attempt_unavailable" as const)
      : null,
  };
  return M7RuntimeUseEvidenceReceiptV1Schema.parse({
    ...basis,
    recordContentSha256: digestJson(basis),
  });
};

const pairedAttemptRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    arm: M7ArmV1Schema,
    binding: M7PairedAgentAttemptBindingV1Schema,
    result: M7PairedAgentArmResultV1Schema.nullable(),
    infrastructureFailureCode: z
      .enum(["runner_threw", "runner_result_invalid"])
      .nullable(),
    cleanup: M7PairedAgentCleanupResultV1Schema,
    cleanupInfrastructureFailure: z.boolean(),
    attemptEvidence: M7AgentAttemptEvidenceSidecarV1Schema,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.arm !== value.binding.arm ||
      value.arm !== value.cleanup.arm ||
      value.cleanup.attemptBindingContentSha256 !==
        value.binding.bindingContentSha256 ||
      (value.result !== null &&
        (value.result.arm !== value.arm ||
          value.result.attemptBindingContentSha256 !==
            value.binding.bindingContentSha256)) ||
      value.attemptEvidence.arm !== value.arm ||
      value.attemptEvidence.campaignId !== value.binding.campaignId ||
      value.attemptEvidence.attemptBindingContentSha256 !==
        value.binding.bindingContentSha256
    ) {
      addIssue(
        context,
        ["binding"],
        "paired Agent attempt record crossed its arm or binding",
      );
    }
    if (
      (value.infrastructureFailureCode === null) !==
      (value.result !== null)
    ) {
      addIssue(
        context,
        ["infrastructureFailureCode"],
        "paired infrastructure failure and result presence disagree",
      );
    }
    if (
      value.cleanupInfrastructureFailure &&
      (value.cleanup.proven || value.cleanup.receiptSha256 !== null)
    ) {
      addIssue(
        context,
        ["cleanup"],
        "cleanup infrastructure failure cannot claim cleanup proof",
      );
    }
  });

/**
 * A prepared paired-arm source. The Gate claims each campaign arm before
 * calling `runArmOnce`; the port never receives Host-only baseline/oracle
 * material. Runtime-use is derived by the Gate from the strict typed summaries
 * in the result; this port has no Boolean/prose verdict hook.
 */
export interface M7RuntimeUsePairedArmResultPortV1 {
  readonly getArmAdmission: (arm: M7ArmV1) => Promise<unknown>;
  readonly runArmOnce: (input: {
    readonly schemaVersion: 1;
    readonly campaignId: string;
    readonly arm: M7ArmV1;
    readonly campaignClaimContentSha256: Sha256DigestV1;
    readonly pairedAttemptBindingContentSha256: Sha256DigestV1;
  }) => Promise<unknown>;
}

/** Explicit test-only seam; the production entry point cannot accept it. */
export type M7FreshCopyRunnerTestingV1 = ExternalHiddenFixFreshCopyRunnerV1;

/** Explicit test-only Host resolver seam; production requires the concrete store. */
export interface M7LocalMutationResolverTestingV1 {
  readonly resolve: (
    campaignId: string,
    registration: M7MutationRegistrationV1,
  ) => Promise<M7LocalMutationMaterialsV1>;
}

const validateAttemptAgainstAdmission = (input: {
  readonly campaignId: string;
  readonly arm: M7ArmV1;
  readonly registration: M7MutationRegistrationV1;
  readonly admission: M7LocalArmAdmissionV1;
  readonly claim: M7ArmClaimV1;
  readonly attempt: M7PairedAgentAttemptRecordV1;
}): void => {
  const { admission, attempt, claim, registration } = input;
  const binding = attempt.binding;
  if (
    admission.arm !== input.arm ||
    admission.claim.campaignId !== input.campaignId ||
    admission.pairedAttemptBindingContentSha256 !==
      binding.bindingContentSha256 ||
    binding.campaignId !== input.campaignId ||
    binding.arm !== input.arm ||
    binding.attemptOrdinal !== 1 ||
    binding.userTurnsMaximum !== 1 ||
    binding.pairedTaskSpecSha256 !== claim.binding.publicTaskSpecSha256 ||
    binding.provider !== claim.binding.provider ||
    binding.model !== claim.binding.model ||
    binding.thinkingLevel !== claim.binding.thinkingLevel ||
    binding.agentBudgetSha256 !== claim.binding.agentBudgetSha256 ||
    binding.baselineSelectedTreeSha256 !==
      registration.mutatedBaselineSelectedTreeSha256 ||
    binding.codingToolSetSha256 !== claim.binding.codingToolSetSha256 ||
    binding.sandboxProfileSha256 !== claim.binding.sandboxPolicySha256 ||
    binding.isolation.taskId !== claim.taskId ||
    binding.isolation.sessionInstanceSha256 !== claim.sessionIdentitySha256 ||
    binding.isolation.workspaceInstanceSha256 !==
      claim.workspaceIdentitySha256 ||
    binding.isolation.cacheInstanceSha256 !== claim.cacheIdentitySha256 ||
    binding.isolation.workspaceBaselineSelectedTreeSha256 !==
      registration.mutatedBaselineSelectedTreeSha256 ||
    (input.arm === "runtime_enabled"
      ? binding.runtimeSurface === null ||
        binding.runtimeSurface.admittedGameToolSetSha256 !==
          registration.runtimeGameToolSetSha256 ||
        deriveM7BuildSourceIdentitySha256V1({
          sourceId: SourceIdSchema.parse(
            binding.runtimeSurface.runtimeResourceMap.baselineSourceId,
          ),
          sourceHash: registration.mutatedBaselineSelectedTreeSha256,
        }) !== registration.mutatedBuildSourceIdentitySha256
      : binding.runtimeSurface !== null)
  ) {
    throw new Error(
      "M7 paired Agent result crossed its campaign admission or frozen surface",
    );
  }
};

const canonicalFreshPlan = (input: {
  readonly campaignId: string;
  readonly evaluatorAssignmentId: string;
  readonly arm: M7ArmV1;
}) => {
  const result: Array<ExternalHiddenFixFreshCopyRunInputV1["plan"]> = [];
  let ordinal = 1;
  for (const scenarioClass of [
    "public_reproduction",
    "hidden_variant",
    "regression_control",
  ] as const) {
    for (const repetition of [1, 2, 3] as const) {
      const id = digest(
        `${input.campaignId}\0${input.arm}\0${scenarioClass}\0${String(repetition)}`,
      );
      result.push({
        schemaVersion: 1,
        assignmentId: input.evaluatorAssignmentId,
        freshCopyId: `m6-fresh-copy:${id.slice(0, 24)}`,
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

const evaluatorEvidenceBaseSchema = z.object({
  schemaVersion: z.literal(1),
  recordKind: z.literal("m7-arm-evaluator-evidence"),
  campaignId: campaignIdSchema,
  arm: M7ArmV1Schema,
  mutationRegistrationSha256: Sha256DigestV1Schema,
  evaluatorAssignmentId: z.string().regex(/^m6-assignment:[a-f0-9]{24}$/u),
  baselineSelectedTreeSha256: Sha256DigestV1Schema,
  candidateSelectedTreeSha256: Sha256DigestV1Schema,
  patchSha256: Sha256DigestV1Schema,
  evaluatorImplementationSha256: Sha256DigestV1Schema,
  evaluatorBundleSha256: Sha256DigestV1Schema,
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
  recordContentSha256: Sha256DigestV1Schema,
});

export const M7ArmEvaluatorEvidenceV1Schema = evaluatorEvidenceBaseSchema
  .strict()
  .superRefine((value, context) => {
    const plan = canonicalFreshPlan({
      campaignId: value.campaignId,
      evaluatorAssignmentId: value.evaluatorAssignmentId,
      arm: value.arm,
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
          "evaluator evidence run crossed its canonical 3x3 plan or arm candidate",
        );
      }
    });
    const expectedOutcome =
      value.infrastructureFailureCode !== null || value.runs.length !== 9
        ? "infrastructure_failed"
        : value.runs.every((run) => run.outcome === "passed")
          ? "accepted"
          : "rejected";
    if (value.outcome !== expectedOutcome) {
      addIssue(
        context,
        ["outcome"],
        "evaluator outcome must derive from all retained fresh runs",
      );
    }
    if (
      (value.outcome === "infrastructure_failed") !==
      (value.infrastructureFailureCode !== null)
    ) {
      addIssue(
        context,
        ["infrastructureFailureCode"],
        "evaluator infrastructure outcome requires its explicit failure code",
      );
    }
    if (
      value.outcome !== "infrastructure_failed" &&
      (!value.cleanupProven || value.runs.some((run) => !run.cleanupProven))
    ) {
      addIssue(
        context,
        ["cleanupProven"],
        "accepted/rejected evidence requires cleanup from every run",
      );
    }
    const { recordContentSha256, ...basis } = value;
    if (recordContentSha256 !== digestJson(basis)) {
      addIssue(
        context,
        ["recordContentSha256"],
        "evaluator evidence content hash does not match",
      );
    }
  });
export type M7ArmEvaluatorEvidenceV1 = z.infer<
  typeof M7ArmEvaluatorEvidenceV1Schema
>;

const createM7ArmEvaluatorEvidenceV1 = (
  input: Omit<
    z.input<typeof evaluatorEvidenceBaseSchema>,
    "schemaVersion" | "recordKind" | "recordContentSha256"
  >,
): M7ArmEvaluatorEvidenceV1 => {
  const basis = {
    schemaVersion: 1 as const,
    recordKind: "m7-arm-evaluator-evidence" as const,
    ...input,
  };
  return M7ArmEvaluatorEvidenceV1Schema.parse({
    ...basis,
    recordContentSha256: digestJson(basis),
  });
};

export interface M7RuntimeUseEvidenceWriterTestingV1 {
  readonly putAgentAttemptOnce: (
    receipt: M7AgentAttemptEvidenceSidecarV1,
  ) => Promise<M7AgentAttemptEvidenceSidecarV1>;
  readonly putRuntimeUseOnce: (
    receipt: M7RuntimeUseEvidenceReceiptV1,
  ) => Promise<M7RuntimeUseEvidenceReceiptV1>;
  readonly putEvaluatorOnce: (
    receipt: M7ArmEvaluatorEvidenceV1,
  ) => Promise<M7ArmEvaluatorEvidenceV1>;
}

type EvidenceKind =
  | "runtime-agent-attempt"
  | "code-only-agent-attempt"
  | "runtime-use"
  | "runtime-evaluator"
  | "code-only-evaluator";

/** Create-once Host-only retention for Agent-attempt, runtime, and Eval evidence. */
export class M7RuntimeUseLocalEvidenceStoreV1 implements M7RuntimeUseEvidenceWriterTestingV1 {
  readonly #root: string;
  readonly #identity: DirectoryIdentity;

  private constructor(root: string, identity: DirectoryIdentity) {
    this.#root = root;
    this.#identity = identity;
  }

  public static async open(input: {
    readonly root: string;
    readonly exposedRoots: readonly string[];
  }): Promise<M7RuntimeUseLocalEvidenceStoreV1> {
    const root = await requirePrivateDirectory(
      input.root,
      "M7 local evidence root",
    );
    for (const [index, exposedInput] of input.exposedRoots.entries()) {
      const exposed = await requireCanonicalDirectory(
        exposedInput,
        `M7 Agent-exposed root ${index + 1}`,
      );
      if (
        pathWithinOrEqual(root.path, exposed.path) ||
        pathWithinOrEqual(exposed.path, root.path)
      ) {
        throw new Error(
          "M7 local evidence root must be disjoint from Agent-exposed roots",
        );
      }
    }
    return new M7RuntimeUseLocalEvidenceStoreV1(root.path, root.identity);
  }

  public get root(): string {
    return this.#root;
  }

  async #requireRoot(): Promise<void> {
    await requireDirectoryIdentity(
      this.#root,
      this.#identity,
      "M7 local evidence root",
    );
  }

  #path(campaignIdInput: string, kind: EvidenceKind): string {
    const campaignId = campaignIdSchema.parse(campaignIdInput);
    return resolve(this.#root, `${digest(campaignId)}.${kind}.json`);
  }

  async #writeOnce(input: {
    readonly campaignId: string;
    readonly kind: EvidenceKind;
    readonly value: unknown;
  }): Promise<void> {
    await this.#requireRoot();
    const filename = `${digest(campaignIdSchema.parse(input.campaignId))}.${input.kind}.json`;
    const bytes = Buffer.from(
      `${canonicalJson(JsonValueSchema.parse(input.value))}\n`,
    );
    if (bytes.byteLength > 64 * 1024 * 1024) {
      throw new Error("M7 retained evidence exceeds its byte limit");
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
          `M7 ${input.kind} evidence already exists; overwrite is forbidden`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  async #read<T>(input: {
    readonly campaignId: string;
    readonly kind: EvidenceKind;
    readonly parse: (value: unknown) => T;
  }): Promise<T> {
    await this.#requireRoot();
    const path = this.#path(input.campaignId, input.kind);
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
        metadata.size > 64 * 1024 * 1024 ||
        pathMetadata.isSymbolicLink() ||
        pathMetadata.dev !== metadata.dev ||
        pathMetadata.ino !== metadata.ino ||
        canonical !== path
      ) {
        throw new Error("M7 retained evidence identity changed");
      }
      return input.parse(
        JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            await handle.readFile(),
          ),
        ) as unknown,
      );
    } finally {
      await handle.close();
    }
  }

  public async putRuntimeUseOnce(
    receiptInput: M7RuntimeUseEvidenceReceiptV1,
  ): Promise<M7RuntimeUseEvidenceReceiptV1> {
    const receipt = M7RuntimeUseEvidenceReceiptV1Schema.parse(receiptInput);
    await this.#writeOnce({
      campaignId: receipt.campaignId,
      kind: "runtime-use",
      value: receipt,
    });
    return this.#read({
      campaignId: receipt.campaignId,
      kind: "runtime-use",
      parse: (value) => M7RuntimeUseEvidenceReceiptV1Schema.parse(value),
    });
  }

  public async putAgentAttemptOnce(
    receiptInput: M7AgentAttemptEvidenceSidecarV1,
  ): Promise<M7AgentAttemptEvidenceSidecarV1> {
    const receipt = M7AgentAttemptEvidenceSidecarV1Schema.parse(receiptInput);
    const kind =
      receipt.arm === "runtime_enabled"
        ? "runtime-agent-attempt"
        : "code-only-agent-attempt";
    await this.#writeOnce({
      campaignId: receipt.campaignId,
      kind,
      value: receipt,
    });
    return this.#read({
      campaignId: receipt.campaignId,
      kind,
      parse: (value) => M7AgentAttemptEvidenceSidecarV1Schema.parse(value),
    });
  }

  public async putEvaluatorOnce(
    receiptInput: M7ArmEvaluatorEvidenceV1,
  ): Promise<M7ArmEvaluatorEvidenceV1> {
    const receipt = M7ArmEvaluatorEvidenceV1Schema.parse(receiptInput);
    const kind =
      receipt.arm === "runtime_enabled"
        ? "runtime-evaluator"
        : "code-only-evaluator";
    await this.#writeOnce({
      campaignId: receipt.campaignId,
      kind,
      value: receipt,
    });
    return this.#read({
      campaignId: receipt.campaignId,
      kind,
      parse: (value) => M7ArmEvaluatorEvidenceV1Schema.parse(value),
    });
  }

  public readRuntimeUse(
    campaignId: string,
  ): Promise<M7RuntimeUseEvidenceReceiptV1> {
    return this.#read({
      campaignId,
      kind: "runtime-use",
      parse: (value) => M7RuntimeUseEvidenceReceiptV1Schema.parse(value),
    });
  }

  public readAgentAttempt(
    campaignId: string,
    arm: M7ArmV1,
  ): Promise<M7AgentAttemptEvidenceSidecarV1> {
    return this.#read({
      campaignId,
      kind:
        arm === "runtime_enabled"
          ? "runtime-agent-attempt"
          : "code-only-agent-attempt",
      parse: (value) => M7AgentAttemptEvidenceSidecarV1Schema.parse(value),
    });
  }

  public readEvaluator(
    campaignId: string,
    arm: M7ArmV1,
  ): Promise<M7ArmEvaluatorEvidenceV1> {
    return this.#read({
      campaignId,
      kind:
        arm === "runtime_enabled" ? "runtime-evaluator" : "code-only-evaluator",
      parse: (value) => M7ArmEvaluatorEvidenceV1Schema.parse(value),
    });
  }
}

interface EvaluatorResult {
  readonly outcome: "accepted" | "rejected" | "infrastructure_failed";
  readonly evidence: M7ArmEvaluatorEvidenceV1;
}

type M7EvaluatorInfrastructureFailureCodeV1 = NonNullable<
  M7ArmEvaluatorEvidenceV1["infrastructureFailureCode"]
>;

class InvalidM7EvaluatorReceiptErrorV1 extends Error {}

const runCandidateEvaluatorOnce = async (input: {
  readonly campaignId: string;
  readonly arm: M7ArmV1;
  readonly materials: M7LocalMutationMaterialsV1;
  readonly registration: M7MutationRegistrationV1;
  readonly candidate: M7CandidatePatchV1;
  readonly patch: ExternalHiddenFixPatchReferenceV1;
  readonly runner: ExternalHiddenFixFreshCopyRunnerV1;
  readonly signal?: AbortSignal | undefined;
}): Promise<EvaluatorResult> => {
  const plan = canonicalFreshPlan({
    campaignId: input.campaignId,
    evaluatorAssignmentId: input.materials.evaluatorAssignmentId,
    arm: input.arm,
  });
  const runs: z.infer<typeof ExternalHiddenFixFreshRunReceiptV1Schema>[] = [];
  let infrastructureFailureCode: M7EvaluatorInfrastructureFailureCodeV1 | null =
    null;
  let cleanupProven = true;
  for (const entry of plan) {
    try {
      const run = ExternalHiddenFixFreshRunReceiptV1Schema.parse(
        await input.runner.runFreshCopy(
          {
            assignmentId: input.materials.evaluatorAssignmentId,
            baselineRoot: input.materials.baselineRoot,
            baselineSelectedTreeSha256:
              input.materials.baselineSelectedTreeSha256,
            evaluatorImplementationPath:
              input.materials.evaluatorImplementationPath,
            evaluatorImplementationSha256:
              input.materials.evaluatorImplementationSha256,
            evaluatorBundlePath: input.materials.evaluatorBundlePath,
            evaluatorBundleSha256: input.materials.evaluatorBundleSha256,
            patch: input.patch,
            expectedCandidateSelectedTreeSha256:
              input.candidate.candidateSelectedTreeSha256,
            plan: entry,
          },
          input.signal,
        ),
      );
      if (
        run.assignmentId !== input.materials.evaluatorAssignmentId ||
        run.freshCopyId !== entry.freshCopyId ||
        run.ordinal !== entry.ordinal ||
        run.scenarioClass !== entry.scenarioClass ||
        run.repetition !== entry.repetition ||
        run.baselineSelectedTreeSha256 !==
          input.materials.baselineSelectedTreeSha256 ||
        run.candidateSelectedTreeSha256 !==
          input.candidate.candidateSelectedTreeSha256 ||
        run.patchSha256 !== input.candidate.patchSha256
      ) {
        throw new InvalidM7EvaluatorReceiptErrorV1(
          "M7 evaluator run crossed its arm candidate or plan",
        );
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
          : error instanceof z.ZodError ||
              error instanceof InvalidM7EvaluatorReceiptErrorV1
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
      ? ("infrastructure_failed" as const)
      : runs.every((run) => run.outcome === "passed")
        ? ("accepted" as const)
        : ("rejected" as const);
  const evidence = createM7ArmEvaluatorEvidenceV1({
    campaignId: input.campaignId,
    arm: input.arm,
    mutationRegistrationSha256: input.registration.recordContentSha256,
    evaluatorAssignmentId: input.materials.evaluatorAssignmentId,
    baselineSelectedTreeSha256: input.materials.baselineSelectedTreeSha256,
    candidateSelectedTreeSha256: input.candidate.candidateSelectedTreeSha256,
    patchSha256: input.candidate.patchSha256,
    evaluatorImplementationSha256:
      input.materials.evaluatorImplementationSha256,
    evaluatorBundleSha256: input.materials.evaluatorBundleSha256,
    outcome,
    infrastructureFailureCode,
    cleanupProven,
    runs,
  });
  return {
    outcome,
    evidence,
  };
};

const candidateFromAttempt = (input: {
  readonly registration: M7MutationRegistrationV1;
  readonly attempt: M7PairedAgentAttemptRecordV1;
}): Readonly<{
  outcome: "no_candidate" | "invalid_candidate" | "valid_candidate";
  candidate: M7CandidatePatchV1 | null;
  patch: ExternalHiddenFixPatchReferenceV1 | null;
}> => {
  const result = input.attempt.result;
  if (result === null || result.candidatePatch === null) {
    return { outcome: "no_candidate", candidate: null, patch: null };
  }
  if (
    !result.candidatePatch.admissible ||
    !result.candidatePatch.roundTripVerified
  ) {
    return { outcome: "invalid_candidate", candidate: null, patch: null };
  }
  const identity = result.candidatePatch.patchIdentity;
  if (
    identity.baselineSelectedTreeSha256 !==
      input.registration.mutatedBaselineSelectedTreeSha256 ||
    identity.patchSha256 !== result.candidatePatch.patch.rawSha256 ||
    identity.byteLength !== result.candidatePatch.patch.byteLength
  ) {
    throw new Error("M7 candidate patch crossed its arm baseline or bytes");
  }
  return {
    outcome: "valid_candidate",
    patch: result.candidatePatch.patch,
    candidate: {
      schemaVersion: 1,
      baselineSelectedTreeSha256: identity.baselineSelectedTreeSha256,
      candidateSelectedTreeSha256: identity.candidateSelectedTreeSha256,
      patchSha256: identity.patchSha256,
      byteLength: identity.byteLength,
      roundTripVerified: true,
    },
  };
};

const infrastructureArmResult = (input: {
  readonly campaignId: string;
  readonly arm: M7ArmV1;
  readonly claim: M7ArmClaimV1;
  readonly runtimeUseReceiptSha256: Sha256DigestV1 | null;
  readonly completedAt: string;
}): M7ArmResultV1 =>
  createM7ArmResultV1({
    campaignId: input.campaignId,
    arm: input.arm,
    armClaimSha256: input.claim.recordContentSha256,
    observedTurnCount: 1,
    loopOutcome: "infrastructure_failed",
    candidateOutcome: "no_candidate",
    candidate: null,
    runtimeUseOutcome:
      input.arm === "runtime_enabled"
        ? "infrastructure_failed"
        : "not_applicable",
    runtimeUseReceiptSha256: input.runtimeUseReceiptSha256,
    evaluatorOutcome: "not_run_agent_failure",
    evaluatorReceiptSha256: null,
    freshRunReferences: [],
    cleanupProven: false,
    cleanupReceiptSha256: null,
    completedAt: input.completedAt,
  });

const runOneCampaignArm = async (input: {
  readonly campaignId: string;
  readonly arm: M7ArmV1;
  readonly registration: M7MutationRegistrationV1;
  readonly sensorBinding: M7CampaignSensorBindingV1;
  readonly classifierImplementationSha256: Sha256DigestV1;
  readonly materials: M7LocalMutationMaterialsV1;
  readonly campaignStore: M7RuntimeUseCampaignStoreV1;
  readonly armPort: M7RuntimeUsePairedArmResultPortV1;
  readonly evaluator: ExternalHiddenFixFreshCopyRunnerV1;
  readonly evidenceWriter: M7RuntimeUseEvidenceWriterTestingV1;
  readonly now: () => string;
  readonly signal?: AbortSignal | undefined;
}): Promise<M7ArmResultV1> => {
  const admission = M7LocalArmAdmissionV1Schema.parse(
    await input.armPort.getArmAdmission(input.arm),
  );
  if (
    admission.arm !== input.arm ||
    admission.claim.arm !== input.arm ||
    admission.claim.campaignId !== input.campaignId
  ) {
    throw new Error("M7 arm admission crossed the requested campaign arm");
  }
  const claim = await input.campaignStore.beginArmOnce(admission.claim);

  let attempt: M7PairedAgentAttemptRecordV1;
  try {
    attempt = pairedAttemptRecordSchema.parse(
      await input.armPort.runArmOnce({
        schemaVersion: 1,
        campaignId: input.campaignId,
        arm: input.arm,
        campaignClaimContentSha256: claim.recordContentSha256,
        pairedAttemptBindingContentSha256:
          admission.pairedAttemptBindingContentSha256,
      }),
    );
    const persistedAttemptEvidence =
      await input.evidenceWriter.putAgentAttemptOnce(attempt.attemptEvidence);
    if (
      canonicalJson(persistedAttemptEvidence) !==
      canonicalJson(attempt.attemptEvidence)
    ) {
      throw new Error(
        "M7 evidence writer returned different Agent-attempt evidence",
      );
    }
    validateAttemptAgainstAdmission({
      campaignId: input.campaignId,
      arm: input.arm,
      registration: input.registration,
      admission,
      claim,
      attempt,
    });
  } catch {
    let runtimeUseReceiptSha256: Sha256DigestV1 | null = null;
    if (input.arm === "runtime_enabled") {
      const receipt = createM7RuntimeUseEvidenceReceiptV1({
        campaignId: input.campaignId,
        registration: input.registration,
        sensorBinding: input.sensorBinding,
        attemptBindingContentSha256:
          admission.pairedAttemptBindingContentSha256,
        classifierImplementationSha256: input.classifierImplementationSha256,
        mutatedBaselineBuildId: null,
        candidateSelectedTreeSha256: null,
        sourceRuntimeEvidenceReceiptSha256: null,
        summaries: [],
        infrastructureFailed: true,
      });
      const persisted = await input.evidenceWriter.putRuntimeUseOnce(receipt);
      if (canonicalJson(persisted) !== canonicalJson(receipt)) {
        throw new Error(
          "M7 evidence writer returned different runtime-use evidence",
        );
      }
      runtimeUseReceiptSha256 = persisted.recordContentSha256;
    }
    const result = infrastructureArmResult({
      campaignId: input.campaignId,
      arm: input.arm,
      claim,
      runtimeUseReceiptSha256,
      completedAt: input.now(),
    });
    await input.campaignStore.putArmResultOnce(result);
    return result;
  }

  const loopOutcome =
    attempt.result === null
      ? ("infrastructure_failed" as const)
      : attempt.result.status;
  const candidate = candidateFromAttempt({
    registration: input.registration,
    attempt,
  });

  let runtimeUse: M7RuntimeUseEvidenceReceiptV1 | null = null;
  if (input.arm === "runtime_enabled") {
    const runtimeResult =
      attempt.result?.arm === "runtime_enabled" ? attempt.result : null;
    const receipt = createM7RuntimeUseEvidenceReceiptV1({
      campaignId: input.campaignId,
      registration: input.registration,
      sensorBinding: input.sensorBinding,
      attemptBindingContentSha256: attempt.binding.bindingContentSha256,
      classifierImplementationSha256: input.classifierImplementationSha256,
      mutatedBaselineBuildId:
        attempt.binding.runtimeSurface?.runtimeResourceMap.baselineBuildId ??
        null,
      candidateSelectedTreeSha256:
        candidate.candidate?.candidateSelectedTreeSha256 ?? null,
      sourceRuntimeEvidenceReceiptSha256:
        runtimeResult?.runtimeEvidenceReceiptSha256 ?? null,
      summaries: runtimeResult?.runtimeUseSummaries ?? [],
      infrastructureFailed: attempt.result === null,
    });
    const persisted = await input.evidenceWriter.putRuntimeUseOnce(receipt);
    if (canonicalJson(persisted) !== canonicalJson(receipt)) {
      throw new Error(
        "M7 evidence writer returned different runtime-use evidence",
      );
    }
    runtimeUse = persisted;
  }

  const agentCleanupProven =
    !attempt.cleanupInfrastructureFailure && attempt.cleanup.proven;
  let evaluatorOutcome: M7ArmResultV1["evaluatorOutcome"];
  let evaluatorReceiptSha256: Sha256DigestV1 | null = null;
  let freshRunReferences: M7ArmResultV1["freshRunReferences"] = [];
  let evaluatorCleanupProven = true;

  if (loopOutcome !== "completed") {
    evaluatorOutcome = "not_run_agent_failure";
  } else if (candidate.outcome === "no_candidate") {
    evaluatorOutcome = "not_run_no_candidate";
  } else if (candidate.outcome === "invalid_candidate") {
    evaluatorOutcome = "not_run_invalid_candidate";
  } else if (!agentCleanupProven) {
    const evidence = createM7ArmEvaluatorEvidenceV1({
      campaignId: input.campaignId,
      arm: input.arm,
      mutationRegistrationSha256: input.registration.recordContentSha256,
      evaluatorAssignmentId: input.materials.evaluatorAssignmentId,
      baselineSelectedTreeSha256: input.materials.baselineSelectedTreeSha256,
      candidateSelectedTreeSha256:
        candidate.candidate?.candidateSelectedTreeSha256 ??
        input.materials.baselineSelectedTreeSha256,
      patchSha256:
        candidate.candidate?.patchSha256 ?? input.registration.mutationSha256,
      evaluatorImplementationSha256:
        input.materials.evaluatorImplementationSha256,
      evaluatorBundleSha256: input.materials.evaluatorBundleSha256,
      outcome: "infrastructure_failed",
      infrastructureFailureCode: "agent_cleanup_not_proven",
      cleanupProven: false,
      runs: [],
    });
    const persisted = await input.evidenceWriter.putEvaluatorOnce(evidence);
    if (canonicalJson(persisted) !== canonicalJson(evidence)) {
      throw new Error(
        "M7 evidence writer returned different evaluator evidence",
      );
    }
    evaluatorOutcome = persisted.outcome;
    evaluatorCleanupProven = persisted.cleanupProven;
    evaluatorReceiptSha256 = persisted.recordContentSha256;
  } else {
    if (candidate.candidate === null || candidate.patch === null) {
      throw new Error("M7 valid candidate lost its patch identity");
    }
    const evaluation = await runCandidateEvaluatorOnce({
      campaignId: input.campaignId,
      arm: input.arm,
      materials: input.materials,
      registration: input.registration,
      candidate: candidate.candidate,
      patch: candidate.patch,
      runner: input.evaluator,
      signal: input.signal,
    });
    const persisted = await input.evidenceWriter.putEvaluatorOnce(
      evaluation.evidence,
    );
    if (canonicalJson(persisted) !== canonicalJson(evaluation.evidence)) {
      throw new Error(
        "M7 evidence writer returned different evaluator evidence",
      );
    }
    evaluatorOutcome = persisted.outcome;
    evaluatorReceiptSha256 = persisted.recordContentSha256;
    freshRunReferences = persisted.runs.map((run) => ({
      schemaVersion: 1,
      ordinal: run.ordinal,
      scenarioClass: run.scenarioClass,
      repetition: run.repetition,
      receiptSha256: digestJson(run),
    }));
    evaluatorCleanupProven = persisted.cleanupProven;
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
    observedTurnCount: 1,
    loopOutcome,
    candidateOutcome: candidate.outcome,
    candidate: candidate.candidate,
    runtimeUseOutcome:
      input.arm === "runtime_enabled"
        ? (runtimeUse?.outcome ?? "infrastructure_failed")
        : "not_applicable",
    runtimeUseReceiptSha256:
      input.arm === "runtime_enabled"
        ? (runtimeUse?.recordContentSha256 ?? null)
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

/**
 * Once an arm claim exists, every later controller failure is converted into
 * a durable infrastructure result. This deliberately sacrifices a positive
 * cleanup claim when the controller can no longer validate the normal result;
 * the campaign remains terminal and is never eligible for a rerun.
 */
const runOneCampaignArmWithFailureRetention = async (
  input: Parameters<typeof runOneCampaignArm>[0],
): Promise<M7ArmResultV1> => {
  try {
    return await runOneCampaignArm(input);
  } catch (error) {
    let claim: M7ArmClaimV1;
    try {
      claim = await input.campaignStore.readArmClaim(input.arm);
    } catch {
      // No durable arm claim means the Agent launch boundary was never crossed.
      // The formal composer validates both admissions before campaign start.
      throw error;
    }
    try {
      return await input.campaignStore.readArmResult(input.arm);
    } catch (readError) {
      if (!isNodeError(readError) || readError.code !== "ENOENT") {
        throw new AggregateError(
          [error, readError],
          "M7 arm failed and its durable result could not be read",
        );
      }
    }
    const retained = infrastructureArmResult({
      campaignId: input.campaignId,
      arm: input.arm,
      claim,
      runtimeUseReceiptSha256: null,
      completedAt: input.now(),
    });
    await input.campaignStore.putArmResultOnce(retained);
    return retained;
  }
};

const validateResolvedMaterials = (
  materialsInput: M7LocalMutationMaterialsV1,
  registration: M7MutationRegistrationV1,
): M7LocalMutationMaterialsV1 => {
  const materials = M7LocalMutationMaterialsV1Schema.parse(materialsInput);
  if (
    materials.campaignId !== registration.campaignId ||
    materials.mutationRegistrationSha256 !== registration.recordContentSha256 ||
    materials.baselineSelectedTreeSha256 !==
      registration.mutatedBaselineSelectedTreeSha256 ||
    materials.evaluatorImplementationSha256 !==
      registration.evaluatorImplementationSha256 ||
    materials.evaluatorBundleSha256 !== registration.evaluatorBundleSha256
  ) {
    throw new Error("M7 resolved Host-only materials crossed the campaign");
  }
  return materials;
};

const runM7RuntimeUseLocalCampaignGateCoreV1 = async (input: {
  readonly campaignId: string;
  readonly campaignStore: M7RuntimeUseCampaignStoreV1;
  readonly mutationResolver: M7LocalMutationResolverTestingV1;
  readonly armPort: M7RuntimeUsePairedArmResultPortV1;
  readonly evaluators: Readonly<
    Record<M7ArmV1, ExternalHiddenFixFreshCopyRunnerV1>
  >;
  readonly evidenceWriter: M7RuntimeUseEvidenceWriterTestingV1;
  readonly now: () => string;
  readonly signal?: AbortSignal | undefined;
}): Promise<M7CampaignTerminalRecordV1> => {
  const campaignId = campaignIdSchema.parse(input.campaignId);
  const [registration, preflight, sensorBinding] = await Promise.all([
    input.campaignStore.readMutationRegistration(),
    input.campaignStore.readPreflight(),
    input.campaignStore.readCampaignSensorBinding(),
  ]);
  if (
    registration.campaignId !== campaignId ||
    preflight.campaignId !== campaignId ||
    registration.campaignSensorBindingId !==
      sensorBinding.campaignSensorBindingId ||
    registration.campaignSensorBindingRecordSha256 !==
      sensorBinding.recordContentSha256 ||
    registration.sensorFreezeId !== sensorBinding.authoritativeSensorFreezeId ||
    registration.sensorFreezeRecordSha256 !==
      sensorBinding.authoritativeSensorFreezeRecordSha256
  ) {
    throw new Error("M7 local Gate crossed its campaign registration");
  }
  if (preflight.outcome === "preflight_failed") {
    return input.campaignStore.finalizeCampaignOnce(input.now());
  }
  const materials = validateResolvedMaterials(
    await input.mutationResolver.resolve(campaignId, registration),
    registration,
  );

  const runtime = await runOneCampaignArmWithFailureRetention({
    campaignId,
    arm: "runtime_enabled",
    registration,
    sensorBinding,
    classifierImplementationSha256: sensorBinding.publicPatrolClassifierSha256,
    materials,
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
  await runOneCampaignArmWithFailureRetention({
    campaignId,
    arm: "code_only",
    registration,
    sensorBinding,
    classifierImplementationSha256: sensorBinding.publicPatrolClassifierSha256,
    materials,
    campaignStore: input.campaignStore,
    armPort: input.armPort,
    evaluator: input.evaluators.code_only,
    evidenceWriter: input.evidenceWriter,
    now: input.now,
    signal: input.signal,
  });
  return input.campaignStore.finalizeCampaignOnce(input.now());
};

/**
 * Explicit unit seam. Its name prevents a fake or unsandboxed evaluator from
 * being mistaken for the production local Gate.
 */
export const runM7RuntimeUseLocalCampaignGateForTestingV1 = (input: {
  readonly campaignId: string;
  readonly campaignStore: M7RuntimeUseCampaignStoreV1;
  readonly mutationResolverForTesting: M7LocalMutationResolverTestingV1;
  readonly armPort: M7RuntimeUsePairedArmResultPortV1;
  readonly freshCopyRunnersForTesting: Readonly<
    Record<M7ArmV1, M7FreshCopyRunnerTestingV1>
  >;
  readonly evidenceWriterForTesting: M7RuntimeUseEvidenceWriterTestingV1;
  readonly now?: (() => string) | undefined;
  readonly signal?: AbortSignal | undefined;
}): Promise<M7CampaignTerminalRecordV1> =>
  runM7RuntimeUseLocalCampaignGateCoreV1({
    campaignId: input.campaignId,
    campaignStore: input.campaignStore,
    mutationResolver: input.mutationResolverForTesting,
    armPort: input.armPort,
    evaluators: input.freshCopyRunnersForTesting,
    evidenceWriter: input.evidenceWriterForTesting,
    now: input.now ?? (() => new Date().toISOString()),
    signal: input.signal,
  });

export interface M7RuntimeUseLocalEvaluatorV1 {
  readonly bwrapPath: string;
  readonly nodePath: string;
  readonly temporaryRoot: string;
  readonly runtimeMounts?:
    readonly ExternalHiddenFixEvaluatorRuntimeMountV1[] | undefined;
  readonly gitBinary?: string | undefined;
  readonly timeoutMs?: number | undefined;
}

/**
 * Formal local M7 entry. The evaluator implementation is fixed here to a new
 * bwrap namespace per run; callers cannot inject the low-level Node process or
 * an arbitrary evaluator runner.
 */
export async function runM7RuntimeUseLocalCampaignGateV1(input: {
  readonly campaignId: string;
  readonly campaignStore: M7RuntimeUseCampaignStoreV1;
  readonly mutationStore: M7RuntimeUseLocalMutationStoreV1;
  readonly evidenceStore: M7RuntimeUseLocalEvidenceStoreV1;
  readonly patchStoreRoots: Readonly<Record<M7ArmV1, string>>;
  readonly armPort: M7RuntimeUsePairedArmResultPortV1;
  readonly evaluator: M7RuntimeUseLocalEvaluatorV1;
  readonly agentExposedRoots: readonly string[];
  readonly now?: (() => string) | undefined;
  readonly signal?: AbortSignal | undefined;
}): Promise<M7CampaignTerminalRecordV1> {
  const [runtimePatchRoot, codeOnlyPatchRoot] = await Promise.all([
    requirePrivateDirectory(
      input.patchStoreRoots.runtime_enabled,
      "M7 runtime-enabled patch root",
    ),
    requirePrivateDirectory(
      input.patchStoreRoots.code_only,
      "M7 code-only patch root",
    ),
  ]);
  if (
    pathWithinOrEqual(runtimePatchRoot.path, codeOnlyPatchRoot.path) ||
    pathWithinOrEqual(codeOnlyPatchRoot.path, runtimePatchRoot.path)
  ) {
    throw new Error("M7 arm patch roots must be disjoint");
  }
  const [runtimePatchStore, codeOnlyPatchStore] = await Promise.all([
    LocalExternalHiddenFixPatchStoreV1.open({
      root: runtimePatchRoot.path,
      exposedRoots: input.agentExposedRoots,
    }),
    LocalExternalHiddenFixPatchStoreV1.open({
      root: codeOnlyPatchRoot.path,
      exposedRoots: input.agentExposedRoots,
    }),
  ]);
  const evaluatorProcess = await BwrapExternalHiddenFixEvaluatorProcessV1.open({
    bwrapPath: input.evaluator.bwrapPath,
    nodePath: input.evaluator.nodePath,
    forbiddenRoots: [
      ...input.agentExposedRoots,
      input.campaignStore.root,
      input.mutationStore.root,
      input.evidenceStore.root,
      runtimePatchRoot.path,
      codeOnlyPatchRoot.path,
    ],
    ...(input.evaluator.runtimeMounts === undefined
      ? {}
      : { runtimeMounts: input.evaluator.runtimeMounts }),
    ...(input.evaluator.timeoutMs === undefined
      ? {}
      : { timeoutMs: input.evaluator.timeoutMs }),
  });
  const openRunner = (patchStore: LocalExternalHiddenFixPatchStoreV1) =>
    LocalExternalHiddenFixFreshCopyRunnerV1.open({
      temporaryRoot: input.evaluator.temporaryRoot,
      exposedRoots: input.agentExposedRoots,
      patchStore,
      evaluator: evaluatorProcess,
      ...(input.evaluator.gitBinary === undefined
        ? {}
        : { gitBinary: input.evaluator.gitBinary }),
    });
  const [runtimeEvaluator, codeOnlyEvaluator] = await Promise.all([
    openRunner(runtimePatchStore),
    openRunner(codeOnlyPatchStore),
  ]);
  return runM7RuntimeUseLocalCampaignGateCoreV1({
    campaignId: input.campaignId,
    campaignStore: input.campaignStore,
    mutationResolver: input.mutationStore,
    armPort: input.armPort,
    evaluators: {
      runtime_enabled: runtimeEvaluator,
      code_only: codeOnlyEvaluator,
    },
    evidenceWriter: input.evidenceStore,
    now: input.now ?? (() => new Date().toISOString()),
    signal: input.signal,
  });
}
