import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { PROJECT_ENVIRONMENT_GAME_TOOL_DEFINITIONS_V1 } from "@chronorift/agent-protocol";
import {
  JsonValueSchema,
  Sha256DigestV1Schema,
  asSha256DigestV1,
  type JsonValue,
  type Sha256DigestV1,
} from "@chronorift/domain";
import { canonicalJson } from "@chronorift/json-artifacts";
import { z } from "zod";

import {
  prepareExternalHiddenFixAssignmentV1,
  type ExternalHiddenFixPublicTaskSpecV1,
} from "./external-hidden-fix-assignment.js";
import {
  CgroupBwrapExternalHiddenFixEvaluatorProcessV1,
  type ExternalHiddenFixEvaluatorHeadroomObserverV1,
  LocalExternalHiddenFixFreshCopyRunnerV1,
  LocalExternalHiddenFixPatchStoreV1,
} from "./external-hidden-fix-evaluator.js";
import { openM7R3CaseCampaignAdmissionStoreV1 } from "./m7-r3-case-admission.js";
import {
  prepareM6ProjectEnvironmentOneTurnTaskV1,
  type M6PublicExecutionClassifierV1,
} from "./m6-project-environment-one-turn.js";
import {
  createM7R3MutationRegistrationV1,
  openM7R3CaseConstructionStoreV1,
  projectM7R3ClassifierFreezeToPortfolioV1,
  projectM7R3ConstructionToPortfolioCaseV1,
  type M7R3CaseConstructionReceiptV1,
  type M7R3CaseConstructionStoreV1,
  type M7R3CasePreflightReceiptV1,
} from "./m7-r3-case-construction.js";
import type { M7R3CasePreflightEvidencePersistencePortV1 } from "./m7-r3-case-preflight-runner.js";
import {
  createM7R3NaturalUserPromptV1,
  createM7R3PairedCaseContractV1,
  type M7R3PairedCaseContractV1,
} from "./m7-r3-paired-agent.js";
import {
  M7_R3_NEUTRAL_ENVIRONMENT_INSTRUCTIONS_SHA256_V1,
  prepareM7R3ProjectEnvironmentPairedAgentPortV1,
} from "./m7-r3-project-environment-paired-agent.js";
import {
  M7R3ProjectEnvironmentPreparationInfrastructureErrorV1,
  prepareM7R3ProjectEnvironmentInfrastructureV1,
  type M7R3BoundProjectEnvironmentPreparationV1,
  type M7R3PreparationCleanupTruthV1,
  type M7R3PreparedProjectEnvironmentInfrastructureV1,
} from "./m7-r3-project-environment-preparation.js";
import { ProjectEnvironmentPreparationInfrastructureErrorV1 } from "./preparation-resource-owner.js";
import { m7R3OperationalHostConfigPathsForCaseV1 } from "./m7-r3-live-operational-config.js";
import {
  M7R3ResidualCleanupResultV1Schema,
  M7R3CampaignInfrastructureFailureInputV1Schema,
  asM7R3TwoCaseLocalPortfolioStorePortV1,
  runM7R3TwoCaseLocalPortfolioV1,
  type M7R3ResidualCleanupResultV1,
  type M7R3TwoCaseLocalPortfolioRunV1,
  type M7R3PreparedLocalCaseCampaignV1,
  type M7R3TwoCaseLocalCasePlanV1,
} from "./m7-r3-two-case-local-portfolio.js";
import {
  createM7R3LocalHiddenEvaluatorPortV1,
  M7R3RuntimeUseLocalEvidenceStoreV1,
} from "./m7-r3-runtime-use-local-gate.js";
import {
  runM7R4NoAgentLivePreflightForDesignV1,
  runAndRetainM7R4NoAgentPreflightOnceV1,
  type M7R4NoAgentLiveResultV1,
  type M7R4RetainedNoAgentPreflightResultV1,
} from "./m7-r4-no-agent-live.js";
import { publishPrivateFileOnceV1 } from "./private-atomic-publication.js";
import type {
  M7R4NoAgentPreflightAttemptStoreV1,
  M7R4NoAgentPreflightTerminalV1,
} from "./m7-r4-no-agent-preflight-attempt.js";
import {
  createM7R3TwoCasePortfolioFreezeV1,
  M7R3TwoCasePortfolioFreezeV1Schema,
  openM7R3TwoCasePortfolioStoreV1,
  type CreateM7R3TwoCasePortfolioFreezeV1Input,
  type M7R3TwoCasePortfolioFreezeV1,
  type M7R3TwoCasePortfolioStoreV1,
} from "./m7-r3-two-case-portfolio.js";
import type {
  M7R4VerifiedCaseMaterialsV1,
  M7R4VerifiedLiveMaterialsV1,
} from "./m7-r4-live-materials.js";
import { readProjectEnvironmentHostConfigV1 } from "./project-environment-host-config.js";
import { M7_PATROL_TRAJECTORY_CLASSIFIER_CONFIG_V1 } from "./m7-patrol-trajectory.js";
import {
  createM7CampaignSensorBindingV1,
  createM7MutationRegistrationV1,
  deriveM7BuildSourceIdentitySha256V1,
  openM7RuntimeUseCampaignStoreV1,
  type M7MutationRegistrationV1,
} from "./m7-runtime-use-campaign.js";
import { M7RuntimeUseLocalMutationStoreV1 } from "./m7-runtime-use-local-gate.js";

const digestJson = (value: unknown): Sha256DigestV1 =>
  asSha256DigestV1(
    createHash("sha256")
      .update(canonicalJson(JsonValueSchema.parse(value)), "utf8")
      .digest("hex"),
  );

const digest = (bytes: string | Uint8Array): Sha256DigestV1 =>
  asSha256DigestV1(createHash("sha256").update(bytes).digest("hex"));

const sameJson = (left: unknown, right: unknown): boolean =>
  canonicalJson(JsonValueSchema.parse(left)) ===
  canonicalJson(JsonValueSchema.parse(right));

const unprovenCleanup = (): M7R3ResidualCleanupResultV1 => ({
  cleanupProven: false,
  cleanupReceiptSha256: null,
  sandboxSafetyFailure: false,
  sandboxSafetyReceiptSha256: null,
});

export const summarizeM7R4PhaseOneCleanupV1 = (
  untrustedReceipts: readonly M7R3ResidualCleanupResultV1[],
): M7R3ResidualCleanupResultV1 => {
  const receipts = untrustedReceipts.map((value) =>
    M7R3ResidualCleanupResultV1Schema.parse(value),
  );
  const cleanupProven =
    receipts.length === 2 && receipts.every((value) => value.cleanupProven);
  const sandboxSafetyFailure = receipts.some(
    (value) => value.sandboxSafetyFailure,
  );
  return M7R3ResidualCleanupResultV1Schema.parse({
    cleanupProven,
    cleanupReceiptSha256: cleanupProven ? digestJson(receipts) : null,
    sandboxSafetyFailure,
    sandboxSafetyReceiptSha256: sandboxSafetyFailure
      ? digestJson(receipts.map((value) => value.sandboxSafetyReceiptSha256))
      : null,
  });
};

export type M7R4PhaseOneCleanupSlotV1 =
  | Readonly<{ ordinal: 1 | 2; state: "not_started" }>
  | Readonly<{ ordinal: 1 | 2; state: "preparation_started" }>
  | Readonly<{
      ordinal: 1 | 2;
      state: "cleanup_observed";
      cleanup: M7R3PreparationCleanupTruthV1;
    }>
  | Readonly<{
      ordinal: 1 | 2;
      state: "prepared";
      abortPreparation: () => Promise<M7R3PreparationCleanupTruthV1>;
    }>;

const M7R3PreparationCleanupTruthV1Schema = z
  .object({
    cleanupProven: z.boolean(),
    cleanupReceiptSha256: Sha256DigestV1Schema.nullable(),
    sandboxSafetyFailure: z.boolean(),
    sandboxSafetyReceiptSha256: Sha256DigestV1Schema.nullable(),
  })
  .strict();

/**
 * Projects the preparation's informational sentinel-summary hash into the
 * residual-cleanup DTO, where the safety hash is specifically failure proof.
 */
export const projectM7R4PhaseOneCleanupV1 = (
  untrusted: M7R3PreparationCleanupTruthV1,
): M7R3ResidualCleanupResultV1 => {
  const cleanup = M7R3PreparationCleanupTruthV1Schema.parse(untrusted);
  return M7R3ResidualCleanupResultV1Schema.parse({
    cleanupProven: cleanup.cleanupProven,
    cleanupReceiptSha256: cleanup.cleanupReceiptSha256,
    sandboxSafetyFailure: cleanup.sandboxSafetyFailure,
    sandboxSafetyReceiptSha256: cleanup.sandboxSafetyFailure
      ? cleanup.sandboxSafetyReceiptSha256
      : null,
  });
};

/** Accepts only typed preparation failures that carry an observed cleanup. */
export const projectM7R4KnownPreparationFailureCleanupV1 = (
  error: unknown,
): M7R3PreparationCleanupTruthV1 | null => {
  if (error instanceof M7R3ProjectEnvironmentPreparationInfrastructureErrorV1) {
    return M7R3PreparationCleanupTruthV1Schema.parse(error.cleanup);
  }
  if (error instanceof ProjectEnvironmentPreparationInfrastructureErrorV1) {
    const cleanup = JsonValueSchema.parse(error.cleanup);
    return M7R3PreparationCleanupTruthV1Schema.parse({
      cleanupProven: error.cleanup.cleanupProven,
      cleanupReceiptSha256: error.cleanup.cleanupProven
        ? digestJson(cleanup)
        : null,
      sandboxSafetyFailure: false,
      sandboxSafetyReceiptSha256: null,
    });
  }
  return null;
};

/** Adapts preparation cleanup truth to the portfolio's residual-cleanup hook. */
export const createM7R4ResidualCleanupCallbackV1 =
  (
    cleanup: () => Promise<M7R3PreparationCleanupTruthV1>,
  ): M7R3PreparedLocalCaseCampaignV1["cleanupRemainingAfterFailure"] =>
  async () =>
    projectM7R4PhaseOneCleanupV1(await cleanup());

const noOwnedPhaseOneResourcesCleanup = (
  ordinal: 1 | 2,
): M7R3ResidualCleanupResultV1 =>
  M7R3ResidualCleanupResultV1Schema.parse({
    cleanupProven: true,
    cleanupReceiptSha256: digestJson({
      schemaVersion: 1,
      recordKind: "m7-r4-phase-one-not-started-cleanup",
      caseOrdinal: ordinal,
      ownedResourceCount: 0,
    }),
    sandboxSafetyFailure: false,
    sandboxSafetyReceiptSha256: null,
  });

/** Aggregates two explicit acquisition states without treating an in-flight failure as clean. */
export async function cleanupM7R4PhaseOneSlotsV1(
  slots: readonly [M7R4PhaseOneCleanupSlotV1, M7R4PhaseOneCleanupSlotV1],
): Promise<M7R3ResidualCleanupResultV1> {
  if (slots[0].ordinal !== 1 || slots[1].ordinal !== 2) {
    throw new TypeError("R4 phase-one cleanup slots crossed case order");
  }
  const settled = await Promise.allSettled(
    slots.map(async (slot): Promise<M7R3ResidualCleanupResultV1> => {
      if (slot.state === "not_started") {
        return noOwnedPhaseOneResourcesCleanup(slot.ordinal);
      }
      if (slot.state === "preparation_started") {
        return unprovenCleanup();
      }
      if (slot.state === "cleanup_observed") {
        return projectM7R4PhaseOneCleanupV1(slot.cleanup);
      }
      return projectM7R4PhaseOneCleanupV1(await slot.abortPreparation());
    }),
  );
  const failures = settled.filter(
    (value): value is PromiseRejectedResult => value.status === "rejected",
  );
  if (failures.length > 0) {
    throw new AggregateError(
      failures.map((value) => value.reason as unknown),
      "R4 phase-one residual cleanup failed",
    );
  }
  return summarizeM7R4PhaseOneCleanupV1(
    settled.map(
      (value) =>
        (value as PromiseFulfilledResult<M7R3ResidualCleanupResultV1>).value,
    ),
  );
}

class M7R4FreshDesignMaterializationErrorV1 extends Error {
  public override readonly name = "M7R4FreshDesignMaterializationErrorV1";
  public readonly cleanup: M7R3ResidualCleanupResultV1;

  public constructor(cleanup: M7R3ResidualCleanupResultV1, cause: unknown) {
    super("M7 R4 fresh design materialization failed", { cause });
    this.cleanup = M7R3ResidualCleanupResultV1Schema.parse(cleanup);
  }
}

/** Cleanup-and-throw seam shared by the real materializer and offline tests. */
export async function failM7R4FreshDesignAfterCleanupV1(input: {
  readonly error: unknown;
  readonly cleanup: () => Promise<unknown>;
}): Promise<never> {
  let cleanup = unprovenCleanup();
  let cleanupFailure: unknown;
  try {
    cleanup = M7R3ResidualCleanupResultV1Schema.parse(await input.cleanup());
    const outcomeFailures: Error[] = [];
    if (!cleanup.cleanupProven) {
      outcomeFailures.push(
        new Error("R4 fresh design residual cleanup was not proven"),
      );
    }
    if (cleanup.sandboxSafetyFailure) {
      outcomeFailures.push(
        new Error("R4 fresh design residual sandbox safety failure"),
      );
    }
    if (outcomeFailures.length > 0) {
      cleanupFailure = new AggregateError(
        outcomeFailures,
        "R4 fresh design cleanup returned a failing outcome",
      );
    }
  } catch (error) {
    cleanupFailure = error;
  }
  throw new M7R4FreshDesignMaterializationErrorV1(
    cleanup,
    cleanupFailure === undefined
      ? input.error
      : new AggregateError(
          [input.error, cleanupFailure],
          "R4 fresh design materialization and cleanup failed",
        ),
  );
}

const pathWithinOrEqual = (parent: string, candidate: string): boolean => {
  const difference = relative(parent, candidate);
  return (
    difference === "" ||
    (difference !== ".." &&
      !difference.startsWith(`..${sep}`) &&
      !isAbsolute(difference))
  );
};

const writeExactOnce = async (
  root: string,
  name: string,
  bytes: Uint8Array,
): Promise<void> => {
  const path = resolve(root, name);
  if (!pathWithinOrEqual(root, path)) {
    throw new Error("R4 formal design seed escaped its construction root");
  }
  await publishPrivateFileOnceV1({ root, filename: name, bytes });
};

const CLASSIFIER_FREEZE_RECORD =
  "m7-r3.trajectory-classifier-freeze.json" as const;

const ensureClassifierOnlyConstructionRoot = async (input: {
  readonly root: string;
  readonly classifierFreezeBytes: Uint8Array;
}): Promise<void> => {
  const entries = (await readdir(input.root)).sort();
  if (entries.length === 0) {
    await writeExactOnce(
      input.root,
      CLASSIFIER_FREEZE_RECORD,
      input.classifierFreezeBytes,
    );
    return;
  }
  if (
    entries.length !== 1 ||
    entries[0] !== CLASSIFIER_FREEZE_RECORD ||
    !Buffer.from(
      await readFile(resolve(input.root, CLASSIFIER_FREEZE_RECORD)),
    ).equals(Buffer.from(input.classifierFreezeBytes))
  ) {
    throw new Error(
      "R4 formal construction root must contain only the exact frozen classifier",
    );
  }
};

const loadPublicExecutionClassifier = async (input: {
  readonly publicRoot: string;
  readonly implementationPath: string;
  readonly publicTask: ExternalHiddenFixPublicTaskSpecV1;
}): Promise<M6PublicExecutionClassifierV1> => {
  if (!pathWithinOrEqual(input.publicRoot, input.implementationPath)) {
    throw new Error("R4 public execution classifier escaped the public root");
  }
  const implementationSha256 = digest(await readFile(input.implementationPath));
  if (
    implementationSha256 !==
    input.publicTask.publicExecutionClassifier.implementationSha256
  ) {
    throw new Error("R4 public execution classifier bytes changed");
  }
  const loaded: unknown = await import(
    `${pathToFileURL(input.implementationPath).href}?sha256=${implementationSha256}`
  );
  const classify =
    typeof loaded === "object" &&
    loaded !== null &&
    "classifyM6PublicExecutionV1" in loaded
      ? loaded.classifyM6PublicExecutionV1
      : undefined;
  if (typeof classify !== "function") {
    throw new Error(
      "R4 public classifier must export classifyM6PublicExecutionV1",
    );
  }
  return Object.freeze({
    identity: input.publicTask.publicExecutionClassifier,
    classify: async (
      classifierInput: Parameters<M6PublicExecutionClassifierV1["classify"]>[0],
    ) => {
      const output: unknown = await Reflect.apply(classify, undefined, [
        classifierInput,
      ]);
      if (
        typeof output !== "object" ||
        output === null ||
        !("publicSymptomObserved" in output) ||
        typeof output.publicSymptomObserved !== "boolean" ||
        !("observation" in output)
      ) {
        throw new Error("R4 public classifier returned an invalid M6 view");
      }
      return Object.freeze({
        publicSymptomObserved: output.publicSymptomObserved,
        observation: JsonValueSchema.parse(output.observation),
      });
    },
  });
};

export interface M7R4FormalCaseRunRootsV1 {
  readonly assignmentRoot: string;
  readonly runtimePatchRoot: string;
  readonly codeOnlyPatchRoot: string;
  readonly runtimeAgentResourceRoot: string;
  readonly codeOnlyAgentResourceRoot: string;
  readonly runtimeDurableRecordRoot: string;
  readonly codeOnlyDurableRecordRoot: string;
  readonly campaignRoot: string;
  readonly evidenceRoot: string;
  readonly runtimeEvaluatorTemporaryRoot: string;
  readonly codeOnlyEvaluatorTemporaryRoot: string;
}

export interface M7R4PhaseOneAssignmentInputsV1 {
  readonly hostOnlyRoot: string;
  readonly adapterPackageRoot: string;
  readonly adapterRevisionPath: string;
  readonly adapterConformanceReceiptPath: string;
}

/**
 * Resolves the case-local bind of the frozen sensor authority. M6 receives
 * child paths of the same Host-only root it uses for assignment state.
 */
export async function resolveM7R4PhaseOneAssignmentInputsV1(input: {
  readonly assignmentRoot: string;
  readonly authoritativeSensorRoot: string;
}): Promise<M7R4PhaseOneAssignmentInputsV1> {
  if (
    !isAbsolute(input.assignmentRoot) ||
    resolve(input.assignmentRoot) !== input.assignmentRoot ||
    !isAbsolute(input.authoritativeSensorRoot) ||
    resolve(input.authoritativeSensorRoot) !== input.authoritativeSensorRoot
  ) {
    throw new TypeError("R4 phase-one Host inputs must be canonical paths");
  }
  const mountedSensorRoot = join(input.assignmentRoot, "sensor");
  const [mounted, authoritative] = await Promise.all([
    lstat(mountedSensorRoot),
    lstat(input.authoritativeSensorRoot),
  ]);
  if (
    mounted.isSymbolicLink() ||
    authoritative.isSymbolicLink() ||
    !mounted.isDirectory() ||
    !authoritative.isDirectory() ||
    mounted.dev !== authoritative.dev ||
    mounted.ino !== authoritative.ino ||
    !pathWithinOrEqual(input.assignmentRoot, mountedSensorRoot) ||
    mountedSensorRoot === input.assignmentRoot
  ) {
    throw new Error("R4 case-local sensor authority mount changed");
  }
  return Object.freeze({
    hostOnlyRoot: input.assignmentRoot,
    adapterPackageRoot: join(mountedSensorRoot, "package"),
    adapterRevisionPath: join(mountedSensorRoot, "adapter-revision.v1.json"),
    adapterConformanceReceiptPath: join(
      mountedSensorRoot,
      "conformance-receipt.v1.json",
    ),
  });
}

const caseRunRoots = (input: {
  readonly live: M7R4VerifiedLiveMaterialsV1;
  readonly materials: M7R4VerifiedCaseMaterialsV1;
}): M7R4FormalCaseRunRootsV1 => {
  const { runsRoot } = input.live;
  const { slug, privateRoot } = input.materials;
  const derived = {
    assignmentRoot: privateRoot,
    runtimePatchRoot: join(runsRoot, "patches", slug, "runtime-enabled"),
    codeOnlyPatchRoot: join(runsRoot, "patches", slug, "code-only"),
    runtimeAgentResourceRoot: join(
      runsRoot,
      "agent-resources",
      slug,
      "runtime-enabled",
    ),
    codeOnlyAgentResourceRoot: join(
      runsRoot,
      "agent-resources",
      slug,
      "code-only",
    ),
    runtimeDurableRecordRoot: join(
      runsRoot,
      "durable",
      slug,
      "runtime-enabled",
    ),
    codeOnlyDurableRecordRoot: join(runsRoot, "durable", slug, "code-only"),
    campaignRoot: join(runsRoot, "campaigns", slug),
    evidenceRoot: join(runsRoot, "evidence", slug),
    runtimeEvaluatorTemporaryRoot: join(
      runsRoot,
      "evaluator-temp",
      slug,
      "runtime-enabled",
    ),
    codeOnlyEvaluatorTemporaryRoot: join(
      runsRoot,
      "evaluator-temp",
      slug,
      "code-only",
    ),
  } satisfies M7R4FormalCaseRunRootsV1;
  for (const [name, path] of Object.entries(derived)) {
    if (
      name !== "assignmentRoot" &&
      (!isAbsolute(path) ||
        resolve(path) !== path ||
        !pathWithinOrEqual(runsRoot, path))
    ) {
      throw new TypeError(`${slug} ${name} escaped the R4 runs root`);
    }
  }
  return Object.freeze(derived);
};

export interface M7R4PreparedCasePhaseOneV1 {
  readonly materials: M7R4VerifiedCaseMaterialsV1;
  readonly roots: M7R4FormalCaseRunRootsV1;
  readonly assignment: Awaited<
    ReturnType<typeof prepareExternalHiddenFixAssignmentV1>
  >;
  readonly runtimePatchStore: LocalExternalHiddenFixPatchStoreV1;
  readonly codeOnlyPatchStore: LocalExternalHiddenFixPatchStoreV1;
  readonly adapterFiles: readonly {
    readonly path: string;
    readonly bytes: Uint8Array;
  }[];
  readonly infrastructure: M7R3PreparedProjectEnvironmentInfrastructureV1;
}

export const assertM7R4PhaseOneAssignmentMatchesV1 = (input: {
  readonly assignment: Awaited<
    ReturnType<typeof prepareExternalHiddenFixAssignmentV1>
  >;
  readonly materials: M7R4VerifiedCaseMaterialsV1;
}): void => {
  const { assignment, materials } = input;
  if (
    assignment.assignment.mutationSha256 !==
      materials.manifest.mutationSha256 ||
    assignment.assignment.evaluatorImplementationSha256 !==
      materials.manifest.evaluatorImplementationSha256 ||
    assignment.assignment.evaluatorBundleSha256 !==
      materials.manifest.evaluatorBundleSha256 ||
    assignment.assignment.mutatedBaselineSelectedTreeSha256 !==
      materials.manifest.mutatedSelectedTreeSha256 ||
    assignment.agentProjection.publicTask.sha256 !==
      materials.manifest.runtimeTaskSpecSha256 ||
    assignment.mutatedSource.headCommit !== materials.manifest.mutantCommit
  ) {
    throw new Error(`${materials.slug} R4 phase-one assignment crossed bytes`);
  }
};

/** Transfers cleanup ownership before validating the created infrastructure. */
export const retainAndValidateM7R4PreparedPhaseOneV1 = (input: {
  readonly prepared: M7R4PreparedCasePhaseOneV1[];
  readonly candidate: M7R4PreparedCasePhaseOneV1;
  readonly live: M7R4VerifiedLiveMaterialsV1;
}): void => {
  input.prepared.push(input.candidate);
  const { materials, infrastructure } = input.candidate;
  const registration = infrastructure.registrationInputs;
  if (
    registration.baselineSelectedTreeSha256 !==
      materials.manifest.mutatedSelectedTreeSha256 ||
    registration.runtimeArmPublicTaskSpecSha256 !==
      materials.manifest.runtimeTaskSpecSha256 ||
    registration.codeOnlyArmPublicTaskSpecSha256 !==
      materials.manifest.codeOnlyTaskSpecSha256 ||
    registration.hostModelRuntimeConfigSha256 !==
      input.live.hostModelRuntimeConfigSha256 ||
    registration.pristineAdapterConformanceReceiptSha256 !==
      input.live.classifierFreeze.authoritativeAdapter
        .pristineConformanceReceiptSha256
  ) {
    throw new Error(
      `${materials.slug} R4 phase-one registration crossed inputs`,
    );
  }
};

const prepareCasePhaseOne = async (input: {
  readonly live: M7R4VerifiedLiveMaterialsV1;
  readonly materials: M7R4VerifiedCaseMaterialsV1;
  readonly allRoots: readonly [
    M7R4FormalCaseRunRootsV1,
    M7R4FormalCaseRunRootsV1,
  ];
  readonly assignmentInputs: M7R4PhaseOneAssignmentInputsV1;
  readonly now: () => string;
}): Promise<M7R4PreparedCasePhaseOneV1> => {
  const { live, materials } = input;
  const roots = materials.ordinal === 1 ? input.allRoots[0] : input.allRoots[1];
  const operational = m7R3OperationalHostConfigPathsForCaseV1(
    live.operationalHostConfigs,
    materials.ordinal,
  );
  const agentExposedRoots = [
    live.publicRoot,
    live.hostConfig.taskStorageRoot,
    ...input.allRoots.flatMap((candidate) => [
      candidate.runtimeAgentResourceRoot,
      candidate.codeOnlyAgentResourceRoot,
    ]),
  ];
  const [runtimePatchStore, codeOnlyPatchStore] = await Promise.all([
    LocalExternalHiddenFixPatchStoreV1.open({
      root: roots.runtimePatchRoot,
      exposedRoots: agentExposedRoots,
    }),
    LocalExternalHiddenFixPatchStoreV1.open({
      root: roots.codeOnlyPatchRoot,
      exposedRoots: agentExposedRoots,
    }),
  ]);
  const assignment = await prepareExternalHiddenFixAssignmentV1({
    pristineProjectRoot: materials.pristineProjectRoot,
    mutatedProjectRoot: materials.mutantProjectRoot,
    expectedSubjectCommit: materials.manifest.pristineCommit,
    publicTaskSpecPath: materials.runtimeTaskPath,
    publicTaskSpecBytePolicy: {
      kind: "frozen-exact-v1",
      expectedSha256: materials.manifest.runtimeTaskSpecSha256,
    },
    adapterPackageRoot: input.assignmentInputs.adapterPackageRoot,
    adapterRevisionPath: input.assignmentInputs.adapterRevisionPath,
    adapterConformanceReceiptPath:
      input.assignmentInputs.adapterConformanceReceiptPath,
    mutationPath: materials.mutationPath,
    evaluatorImplementationPath: materials.evaluatorImplementationPath,
    evaluatorBundlePath: materials.evaluatorBundlePath,
    hostOnlyRoot: input.assignmentInputs.hostOnlyRoot,
    agentExposedRoots,
    createdAt: input.now(),
  });
  assertM7R4PhaseOneAssignmentMatchesV1({ assignment, materials });
  const publicClassifier = await loadPublicExecutionClassifier({
    publicRoot: live.publicRoot,
    implementationPath: live.publicClassifierPath,
    publicTask: materials.runtimeTask,
  });
  const adapterFiles = await Promise.all(
    assignment.adapterPackage.files.map(async (file) => {
      const path = resolve(
        input.assignmentInputs.adapterPackageRoot,
        file.path,
      );
      if (!pathWithinOrEqual(input.assignmentInputs.adapterPackageRoot, path)) {
        throw new Error("R4 Adapter file escaped its frozen package root");
      }
      return { path: file.path, bytes: await readFile(path) };
    }),
  );
  const runtimeTask = await prepareM6ProjectEnvironmentOneTurnTaskV1({
    assignment,
    adapterFiles,
    patchStore: runtimePatchStore,
    publicExecutionClassifier: publicClassifier,
    hostAdmittedGameToolNames: PROJECT_ENVIRONMENT_GAME_TOOL_DEFINITIONS_V1.map(
      (tool) => tool.name,
    ),
    hostConfigPath: operational.runtime,
    agentDir: roots.runtimeAgentResourceRoot,
    now: input.now,
  });
  const infrastructure = await prepareM7R3ProjectEnvironmentInfrastructureV1({
    runtimeTask,
    codeOnlyPublicTask: materials.codeOnlyTask,
    codeOnlyPublicTaskSpecSha256: materials.manifest.codeOnlyTaskSpecSha256,
    codeOnlyPatchStore,
    runtimeAgentResourceDirectory: roots.runtimeAgentResourceRoot,
    codeOnlyAgentResourceDirectory: roots.codeOnlyAgentResourceRoot,
    runtimeDurableRecordRoot: roots.runtimeDurableRecordRoot,
    codeOnlyDurableRecordRoot: roots.codeOnlyDurableRecordRoot,
    trajectoryClassifierConfig: M7_PATROL_TRAJECTORY_CLASSIFIER_CONFIG_V1,
    trajectoryCaseSpec: materials.trajectoryCaseSpec,
    hostModelRuntimeConfigSha256: live.hostModelRuntimeConfigSha256,
    additionalCodingSandboxSentinelForbiddenPaths: [
      roots.assignmentRoot,
      materials.mutationPath,
      materials.evaluatorImplementationPath,
      materials.evaluatorBundlePath,
      join(live.runsRoot, "operational-config"),
    ],
    hostConfigPath: operational.codeOnly,
  });
  return Object.freeze({
    materials,
    roots,
    assignment,
    runtimePatchStore,
    codeOnlyPatchStore,
    adapterFiles,
    infrastructure,
  });
};

const compatibilityCleanupProven = (
  receipt: M7R4PreparedCasePhaseOneV1["infrastructure"]["registrationInputs"]["adapterMutantCompatibilityReceipt"],
): boolean =>
  receipt.outcome === "compatible" &&
  receipt.cleanup.processTreeTerminated &&
  receipt.cleanup.isolationGroupEmpty &&
  receipt.cleanup.scopeRemoved &&
  receipt.cleanup.storageReconciled === true;

const derivedAgentBudget = (task: ExternalHiddenFixPublicTaskSpecV1) => ({
  schemaVersion: 1 as const,
  attemptsMaximum: 1 as const,
  userTurnsPerAttemptMaximum: 1 as const,
  toolCallsMaximum: task.agentBudget.toolCallsMaximum,
  wallTimeMsMaximum: task.agentBudget.wallTimeMsMaximum,
  taskSandboxNetworkMode: "denied" as const,
  taskCredentialMountCountMaximum: 0 as const,
});

const createPortfolioInput = (input: {
  readonly live: M7R4VerifiedLiveMaterialsV1;
  readonly prepared: readonly [
    M7R4PreparedCasePhaseOneV1,
    M7R4PreparedCasePhaseOneV1,
  ];
  readonly constructions: readonly [
    M7R3CaseConstructionReceiptV1,
    M7R3CaseConstructionReceiptV1,
  ];
  readonly frozenAt: string;
}): CreateM7R3TwoCasePortfolioFreezeV1Input => {
  const firstRegistration = input.prepared[0].infrastructure.registrationInputs;
  const secondRegistration =
    input.prepared[1].infrastructure.registrationInputs;
  const firstTask = input.live.cases[0].runtimeTask;
  const secondTask = input.live.cases[1].runtimeTask;
  if (
    firstRegistration.validatedGameToolSetSha256 !==
      secondRegistration.validatedGameToolSetSha256 ||
    firstRegistration.codingToolSetSha256 !==
      secondRegistration.codingToolSetSha256 ||
    firstRegistration.sandboxPolicySha256 !==
      secondRegistration.sandboxPolicySha256 ||
    firstTask.agentBudget.provider !== secondTask.agentBudget.provider ||
    firstTask.agentBudget.model !== secondTask.agentBudget.model ||
    firstTask.agentBudget.thinkingLevel !==
      secondTask.agentBudget.thinkingLevel ||
    !sameJson(derivedAgentBudget(firstTask), derivedAgentBudget(secondTask))
  ) {
    throw new Error("R4 two-case common Agent/runtime configuration differs");
  }
  return {
    commonRuntimeMaterials: {
      ...projectM7R3ClassifierFreezeToPortfolioV1(input.live.classifierFreeze),
      validatedGameToolSetSha256: firstRegistration.validatedGameToolSetSha256,
      commonEnvironmentInstructionsSha256:
        M7_R3_NEUTRAL_ENVIRONMENT_INSTRUCTIONS_SHA256_V1,
      hostModelRuntimeConfigSha256: input.live.hostModelRuntimeConfigSha256,
    },
    agentConfiguration: {
      provider: firstTask.agentBudget.provider,
      model: firstTask.agentBudget.model,
      thinkingLevel: firstTask.agentBudget.thinkingLevel,
      agentBudgetSha256: digestJson(derivedAgentBudget(firstTask)),
      codingToolSetSha256: firstRegistration.codingToolSetSha256,
      sandboxPolicySha256: firstRegistration.sandboxPolicySha256,
    },
    pairedAttemptPlan: {
      armOrder: ["runtime_enabled", "code_only"],
      attemptsPerArm: 1,
      retriesAllowed: false,
      userTurnsPerArm: 1,
    },
    evaluationPlan: {
      scenarioClassOrder: [
        "public_reproduction",
        "hidden_variant",
        "regression_control",
      ],
      repetitionsPerScenarioClass: 3,
      expectedFreshCopyRunCount: 9,
      freshCopyPerRun: true,
    },
    cases: [
      projectM7R3ConstructionToPortfolioCaseV1(input.constructions[0]),
      projectM7R3ConstructionToPortfolioCaseV1(input.constructions[1]),
    ],
    frozenAt: input.frozenAt,
  };
};

const createCaseContract = (input: {
  readonly live: M7R4VerifiedLiveMaterialsV1;
  readonly portfolio: M7R3TwoCasePortfolioFreezeV1;
  readonly construction: M7R3CaseConstructionReceiptV1;
  readonly prepared: M7R4PreparedCasePhaseOneV1;
}): M7R3PairedCaseContractV1 => {
  const frozenCase = input.portfolio.cases[input.construction.ordinal - 1];
  if (
    frozenCase === undefined ||
    frozenCase.ordinal !== input.construction.ordinal
  ) {
    throw new Error("R4 portfolio omitted a fixed case ordinal");
  }
  return createM7R3PairedCaseContractV1({
    portfolioId: input.portfolio.portfolioId,
    caseOrdinal: input.construction.ordinal,
    caseId: frozenCase.caseId,
    mutatedBaselineSelectedTreeSha256:
      input.construction.mutatedBuild.selectedTreeSha256,
    naturalPrompt: createM7R3NaturalUserPromptV1(
      input.prepared.materials.prompt,
    ),
    pairedAgentProtocolImplementationSha256:
      input.live.pairedAgentProtocolImplementationSha256,
    pairedPublicTaskContractSha256:
      input.construction.pairedPublicTaskContract.sha256,
    runtimeArmPublicTaskSpecSha256:
      input.prepared.infrastructure.registrationInputs
        .runtimeArmPublicTaskSpecSha256,
    codeOnlyArmPublicTaskSpecSha256:
      input.prepared.infrastructure.registrationInputs
        .codeOnlyArmPublicTaskSpecSha256,
    adapterMutantCompatibilityReceiptSha256:
      input.construction.adapterMutantCompatibility.receiptRecordSha256,
    commonRuntimeMaterials: input.portfolio.commonRuntimeMaterials,
    agentConfiguration: input.portfolio.agentConfiguration,
    trajectoryClassifierConfig: input.live.classifierFreeze.classifierConfig,
    trajectoryCaseSpec: input.prepared.materials.trajectoryCaseSpec,
  });
};

export interface M7R4FreshTwoCaseDesignV1 {
  readonly constructionStore: M7R3CaseConstructionStoreV1;
  readonly portfolioStore: M7R3TwoCasePortfolioStoreV1;
  readonly preparedPair: readonly [
    M7R4PreparedCasePhaseOneV1,
    M7R4PreparedCasePhaseOneV1,
  ];
  readonly constructions: readonly [
    M7R3CaseConstructionReceiptV1,
    M7R3CaseConstructionReceiptV1,
  ];
  readonly portfolioFreezeInput: CreateM7R3TwoCasePortfolioFreezeV1Input;
  /** Deterministic preview only; the selected caller creates it exactly once. */
  readonly expectedPortfolio: M7R3TwoCasePortfolioFreezeV1;
  readonly contracts: readonly [
    M7R3PairedCaseContractV1,
    M7R3PairedCaseContractV1,
  ];
  readonly cleanup: () => Promise<M7R3ResidualCleanupResultV1>;
}

/**
 * Shared production materializer for the disposable no-Agent check and the
 * one formal run. It creates new receipts from raw frozen material; it never
 * imports or converts an earlier case construction or portfolio receipt.
 */
export async function prepareM7R4FreshTwoCaseDesignV1(input: {
  readonly live: M7R4VerifiedLiveMaterialsV1;
  readonly constructionRoot?: string | undefined;
  readonly portfolioRoot?: string | undefined;
  readonly now?: (() => string) | undefined;
}): Promise<M7R4FreshTwoCaseDesignV1> {
  const now = input.now ?? (() => new Date().toISOString());
  const constructionRoot =
    input.constructionRoot ?? input.live.constructionRoot;
  const portfolioRoot = input.portfolioRoot ?? input.live.portfolioRoot;
  await ensureClassifierOnlyConstructionRoot({
    root: constructionRoot,
    classifierFreezeBytes: input.live.classifierFreezeBytes,
  });
  if ((await readdir(portfolioRoot)).length !== 0) {
    throw new Error("R4 portfolio store must be fresh and empty");
  }
  const roots = [
    caseRunRoots({ live: input.live, materials: input.live.cases[0] }),
    caseRunRoots({ live: input.live, materials: input.live.cases[1] }),
  ] as const;
  const agentExposedRoots = [
    input.live.publicRoot,
    input.live.hostConfig.taskStorageRoot,
    ...roots.flatMap((candidate) => [
      candidate.runtimeAgentResourceRoot,
      candidate.codeOnlyAgentResourceRoot,
    ]),
  ];
  const [constructionStore, portfolioStore] = await Promise.all([
    openM7R3CaseConstructionStoreV1({
      root: constructionRoot,
      exposedRoots: agentExposedRoots,
    }),
    openM7R3TwoCasePortfolioStoreV1({
      root: portfolioRoot,
      exposedRoots: agentExposedRoots,
    }),
  ]);
  const storedFreeze = await constructionStore.readClassifierFreeze();
  if (!sameJson(storedFreeze, input.live.classifierFreeze)) {
    throw new Error("R4 construction store classifier freeze changed");
  }
  const prepared: M7R4PreparedCasePhaseOneV1[] = [];
  const cleanupSlots: [M7R4PhaseOneCleanupSlotV1, M7R4PhaseOneCleanupSlotV1] = [
    { ordinal: 1, state: "not_started" },
    { ordinal: 2, state: "not_started" },
  ];
  let cleanupPromise: Promise<M7R3ResidualCleanupResultV1> | null = null;
  const cleanup = (): Promise<M7R3ResidualCleanupResultV1> => {
    cleanupPromise ??= cleanupM7R4PhaseOneSlotsV1(cleanupSlots);
    return cleanupPromise;
  };
  try {
    for (const materials of input.live.cases) {
      const slotIndex: 0 | 1 = materials.ordinal === 1 ? 0 : 1;
      const assignmentInputs = await resolveM7R4PhaseOneAssignmentInputsV1({
        assignmentRoot: roots[slotIndex].assignmentRoot,
        authoritativeSensorRoot: input.live.sensorRoot,
      });
      cleanupSlots[slotIndex] = {
        ordinal: materials.ordinal,
        state: "preparation_started",
      };
      let candidate: M7R4PreparedCasePhaseOneV1;
      try {
        candidate = await prepareCasePhaseOne({
          live: input.live,
          materials,
          allRoots: roots,
          assignmentInputs,
          now,
        });
      } catch (error) {
        const observedCleanup =
          projectM7R4KnownPreparationFailureCleanupV1(error);
        if (observedCleanup !== null) {
          cleanupSlots[slotIndex] = {
            ordinal: materials.ordinal,
            state: "cleanup_observed",
            cleanup: observedCleanup,
          };
        }
        throw error;
      }
      cleanupSlots[slotIndex] = {
        ordinal: materials.ordinal,
        state: "prepared",
        abortPreparation: () => candidate.infrastructure.abortPreparation(),
      };
      retainAndValidateM7R4PreparedPhaseOneV1({
        prepared,
        candidate,
        live: input.live,
      });
    }
    const firstPrepared = prepared[0];
    const secondPrepared = prepared[1];
    if (firstPrepared === undefined || secondPrepared === undefined) {
      throw new Error("R4 did not prepare exactly two phase-one cases");
    }
    const preparedPair = [firstPrepared, secondPrepared] as const;
    const constructions: M7R3CaseConstructionReceiptV1[] = [];
    for (const ordinal of [1, 2] as const) {
      const phaseOne = ordinal === 1 ? preparedPair[0] : preparedPair[1];
      const registration = phaseOne.infrastructure.registrationInputs;
      const mutation = createM7R3MutationRegistrationV1({
        trajectoryClassifierFreeze: storedFreeze,
        mutationBytes: phaseOne.materials.mutationBytes,
        mutatedBuild: registration.baselineBuild,
        registeredAt: now(),
      });
      const compatibility = registration.adapterMutantCompatibilityReceipt;
      const cleanupProven = compatibilityCleanupProven(compatibility);
      constructions.push(
        await constructionStore.createConstructionOnce({
          ordinal,
          mutationRegistration: mutation,
          mutatedBuild: registration.baselineBuild,
          naturalPrompt: phaseOne.materials.prompt,
          trajectoryCaseSpec: phaseOne.materials.trajectoryCaseSpec,
          adapterMutantCompatibilityReceipt: compatibility,
          pairedPublicTaskContractBytes:
            phaseOne.materials.pairedTaskContractBytes,
          preflightImplementationBytes:
            input.live.preflightImplementationManifestBytes,
          evaluatorImplementationBytes:
            phaseOne.materials.evaluatorImplementationBytes,
          evaluatorBundleBytes: phaseOne.materials.evaluatorBundleBytes,
          cleanup: {
            proven: cleanupProven,
            receiptSha256: cleanupProven
              ? digestJson(compatibility.cleanup)
              : null,
          },
          constructedAt: now(),
        }),
      );
    }
    const firstConstruction = constructions[0];
    const secondConstruction = constructions[1];
    if (
      firstConstruction === undefined ||
      secondConstruction === undefined ||
      firstConstruction.outcome !== "passed" ||
      secondConstruction.outcome !== "passed"
    ) {
      throw new Error("R4 retained a construction failure before preflight");
    }
    const constructionPair = [firstConstruction, secondConstruction] as const;
    const portfolioFreezeInput = createPortfolioInput({
      live: input.live,
      prepared: preparedPair,
      constructions: constructionPair,
      frozenAt: now(),
    });
    const expectedPortfolio =
      createM7R3TwoCasePortfolioFreezeV1(portfolioFreezeInput);
    const contracts = [
      createCaseContract({
        live: input.live,
        portfolio: expectedPortfolio,
        construction: constructionPair[0],
        prepared: preparedPair[0],
      }),
      createCaseContract({
        live: input.live,
        portfolio: expectedPortfolio,
        construction: constructionPair[1],
        prepared: preparedPair[1],
      }),
    ] as const;
    return Object.freeze({
      constructionStore,
      portfolioStore,
      preparedPair,
      constructions: constructionPair,
      portfolioFreezeInput,
      expectedPortfolio,
      contracts,
      cleanup,
    });
  } catch (error) {
    return failM7R4FreshDesignAfterCleanupV1({ error, cleanup });
  }
}

const createCampaignFailureWriter = (input: {
  readonly prepared: M7R4PreparedCasePhaseOneV1;
}): M7R3PreparedLocalCaseCampaignV1["persistInfrastructureFailureOnce"] => {
  let invoked = false;
  return async (untrusted): Promise<Sha256DigestV1> => {
    if (invoked) {
      throw new Error(
        `${input.prepared.materials.slug} campaign failure may be retained only once`,
      );
    }
    invoked = true;
    const failure =
      M7R3CampaignInfrastructureFailureInputV1Schema.parse(untrusted);
    if (failure.caseOrdinal !== input.prepared.materials.ordinal) {
      throw new TypeError("R4 campaign failure crossed its case ordinal");
    }
    const bytes = Buffer.from(
      `${canonicalJson(JsonValueSchema.parse(failure))}\n`,
      "utf8",
    );
    await writeExactOnce(
      input.prepared.roots.campaignRoot,
      "m7-r3.campaign-infrastructure-failure.json",
      bytes,
    );
    const stored = await readFile(
      join(
        input.prepared.roots.campaignRoot,
        "m7-r3.campaign-infrastructure-failure.json",
      ),
    );
    if (!stored.equals(bytes)) {
      throw new Error("R4 campaign failure changed during persistence");
    }
    return digestJson(failure);
  };
};

const sensorBindingInput = (input: {
  readonly live: M7R4VerifiedLiveMaterialsV1;
  readonly contract: M7R3PairedCaseContractV1;
  readonly boundAt: string;
}) => ({
  schemaVersion: 1 as const,
  authoritativeSensorFreezeId: input.live.sensorFreeze.sensorFreezeId,
  authoritativeSensorFreezeRecordSha256: input.live.sensorFreeze.recordSha256,
  subjectProjectSha256:
    input.live.sensorFreeze.pristineSubject.subjectProjectSha256,
  pristineProjectRevision: input.live.sensorFreeze.pristineSubject.revision,
  pristineSelectedTreeSha256:
    input.live.sensorFreeze.pristineSubject.selectedTreeSha256,
  pristineAdapterRevisionSha256:
    input.contract.commonRuntimeMaterials.adapterRevisionSha256,
  adapterPackageSha256: input.live.sensorFreeze.sensor.adapterPackageSha256,
  adapterObservationSchemaSha256:
    input.live.sensorFreeze.sensor.observationSchemaSha256,
  publicPatrolClassifierSha256:
    input.live.sensorFreeze.sensor.classifierImplementationSha256,
  pristineConformanceReceiptSha256:
    input.live.sensorFreeze.sensor.pristineConformanceReceiptSha256,
  validatedGameToolSetSha256:
    input.contract.commonRuntimeMaterials.validatedGameToolSetSha256,
  boundAt: input.boundAt,
});

const openEvaluatorProcesses = async (input: {
  readonly live: M7R4VerifiedLiveMaterialsV1;
  readonly prepared: M7R4PreparedCasePhaseOneV1;
  readonly bound: M7R3BoundProjectEnvironmentPreparationV1;
  readonly preparedPair: readonly [
    M7R4PreparedCasePhaseOneV1,
    M7R4PreparedCasePhaseOneV1,
  ];
}): Promise<
  readonly [
    CgroupBwrapExternalHiddenFixEvaluatorProcessV1,
    CgroupBwrapExternalHiddenFixEvaluatorProcessV1,
  ]
> => {
  const toolchain = input.live.hostConfig.godotToolchains[0];
  if (toolchain === undefined) {
    throw new Error("R4 Host configuration omitted its Godot toolchain");
  }
  const operational = m7R3OperationalHostConfigPathsForCaseV1(
    input.live.operationalHostConfigs,
    input.prepared.materials.ordinal,
  );
  const [runtimeHostConfig, codeOnlyHostConfig] = await Promise.all([
    readProjectEnvironmentHostConfigV1(operational.runtime),
    readProjectEnvironmentHostConfigV1(operational.codeOnly),
  ]);
  const forbiddenRoots = [
    input.live.publicRoot,
    input.live.hostConfig.taskStorageRoot,
    join(input.live.runsRoot, "operational-config"),
    ...input.preparedPair.flatMap((candidate) => [
      candidate.roots.runtimeAgentResourceRoot,
      candidate.roots.codeOnlyAgentResourceRoot,
    ]),
  ];
  const common = {
    bwrapPath: input.live.hostConfig.bwrapPath,
    nodePath: input.live.hostConfig.nodePath,
    prlimitPath: input.live.hostConfig.prlimitPath,
    taskStorageRoot: input.live.hostConfig.taskStorageRoot,
    runtimeMounts: [
      { source: toolchain.executablePath, target: "/runtime/assets/godot" },
    ],
    forbiddenRoots,
    timeoutMs:
      input.prepared.materials.runtimeTask.evaluatorBudget
        .wallTimeMsPerRunMaximum,
  } as const;
  const [runtimeEvaluator, codeOnlyEvaluator] = await Promise.all([
    CgroupBwrapExternalHiddenFixEvaluatorProcessV1.open({
      ...common,
      delegatedCgroupRoot: runtimeHostConfig.delegatedCgroupRoot,
      taskId: input.bound.runtimeArm.isolation.taskId,
      assertTaskStorageHeadroom:
        input.bound.runtimeArm.assertTaskStorageHeadroom,
      onHeadroomObserved:
        input.bound.runtimeArm.persistEvaluatorHeadroomObservation,
      evaluatorTemporaryRoot:
        input.prepared.roots.runtimeEvaluatorTemporaryRoot,
    }),
    CgroupBwrapExternalHiddenFixEvaluatorProcessV1.open({
      ...common,
      delegatedCgroupRoot: codeOnlyHostConfig.delegatedCgroupRoot,
      taskId: input.bound.codeOnlyArm.isolation.taskId,
      assertTaskStorageHeadroom:
        input.bound.codeOnlyArm.assertTaskStorageHeadroom,
      onHeadroomObserved:
        input.bound.codeOnlyArm.persistEvaluatorHeadroomObservation,
      evaluatorTemporaryRoot:
        input.prepared.roots.codeOnlyEvaluatorTemporaryRoot,
    }),
  ]);
  return Object.freeze([runtimeEvaluator, codeOnlyEvaluator] as const);
};

const registerCampaignWithoutAgent = async (input: {
  readonly live: M7R4VerifiedLiveMaterialsV1;
  readonly design: M7R4FreshTwoCaseDesignV1;
  readonly prepared: M7R4PreparedCasePhaseOneV1;
  readonly construction: M7R3CaseConstructionReceiptV1;
  readonly preflight: M7R3CasePreflightReceiptV1;
  readonly contract: M7R3PairedCaseContractV1;
  readonly now: () => string;
  readonly failureWriter: M7R3PreparedLocalCaseCampaignV1["persistInfrastructureFailureOnce"];
}): Promise<M7R3PreparedLocalCaseCampaignV1> => {
  const { prepared, construction, contract } = input;
  const agentExposedRoots = [
    input.live.publicRoot,
    input.live.hostConfig.taskStorageRoot,
    ...input.design.preparedPair.flatMap((candidate) => [
      candidate.roots.runtimeAgentResourceRoot,
      candidate.roots.codeOnlyAgentResourceRoot,
    ]),
  ];
  const [campaignStore, admissionStore, mutationStore, evidenceStore] =
    await Promise.all([
      openM7RuntimeUseCampaignStoreV1({
        root: prepared.roots.campaignRoot,
        exposedRoots: agentExposedRoots,
      }),
      openM7R3CaseCampaignAdmissionStoreV1({
        root: prepared.roots.campaignRoot,
        exposedRoots: agentExposedRoots,
      }),
      M7RuntimeUseLocalMutationStoreV1.open({
        root: prepared.roots.assignmentRoot,
        exposedRoots: agentExposedRoots,
      }),
      M7R3RuntimeUseLocalEvidenceStoreV1.open({
        root: prepared.roots.evidenceRoot,
        exposedRoots: agentExposedRoots,
      }),
    ]);
  const registeredAt = input.now();
  const bindingInput = sensorBindingInput({
    live: input.live,
    contract,
    boundAt: registeredAt,
  });
  const expectedSensorBinding = createM7CampaignSensorBindingV1(bindingInput);
  const sensorBinding =
    await campaignStore.bindCampaignSensorOnce(bindingInput);
  if (!sameJson(sensorBinding, expectedSensorBinding)) {
    throw new Error("R4 campaign sensor binding changed");
  }
  const registrationInput = {
    mutationSha256: construction.mutation.mutationSha256,
    mutatedBaselineSelectedTreeSha256:
      construction.mutatedBuild.selectedTreeSha256,
    mutatedBuildSourceIdentitySha256: deriveM7BuildSourceIdentitySha256V1({
      sourceId: construction.mutatedBuild.sourceId,
      sourceHash: construction.mutatedBuild.sourceSha256,
    }),
    adapterMutantCompatibilityReceiptSha256:
      construction.adapterMutantCompatibility.receiptRecordSha256,
    publicTaskSpecSha256: contract.pairedPublicTaskContractSha256,
    evaluatorImplementationSha256: construction.evaluatorImplementation.sha256,
    evaluatorBundleSha256: construction.evaluatorBundle.sha256,
    provider: contract.agentConfiguration.provider,
    model: contract.agentConfiguration.model,
    thinkingLevel: contract.agentConfiguration.thinkingLevel,
    agentBudgetSha256: contract.agentConfiguration.agentBudgetSha256,
    codingToolSetSha256: contract.agentConfiguration.codingToolSetSha256,
    sandboxPolicySha256: contract.agentConfiguration.sandboxPolicySha256,
    registeredAt,
  };
  const expectedRegistration = createM7MutationRegistrationV1({
    sensorBinding: expectedSensorBinding,
    registration: registrationInput,
  });
  const registration =
    await campaignStore.registerMutationOnce(registrationInput);
  if (!sameJson(registration, expectedRegistration)) {
    throw new Error("R4 campaign registration changed");
  }
  const mutantWitnessKinds = new Set(
    input.preflight.publicTrajectoryObservations[1].selectedWitnesses.map(
      (witness) => witness.kind,
    ),
  );
  const hiddenSummary = input.preflight.hiddenEvaluator.matrix.summary;
  const cleanupProven =
    input.preflight.publicTrajectoryObservations.every(
      (observation) => observation.cleanup.proven,
    ) &&
    input.preflight.hiddenEvaluator.matrix.runs.every(
      (run) => run.cleanupProven,
    );
  const campaignPreflight = await campaignStore.putPreflightOnce({
    pristinePassCount: hiddenSummary.pristineExpectedMotionObserved,
    mutantPublicAndHiddenPassCount:
      hiddenSummary.mutantPublicExpectedMotionObserved +
      hiddenSummary.mutantHiddenExpectedMotionObserved,
    mutantRegressionPassCount:
      hiddenSummary.mutantRegressionExpectedMotionObserved,
    genericClassifierMutantWitnessObserved:
      construction.trajectoryCaseSpec.expectedBaselineWitnessKinds.every(
        (kind) => mutantWitnessKinds.has(kind),
      ),
    pristineAdapterConformancePassed: construction.outcome === "passed",
    mutantBuildCompatibilityPassed:
      construction.adapterMutantCompatibility.outcome === "compatible",
    cleanupProven,
    infrastructureFailureCode: null,
    completedAt: input.now(),
  });
  if (
    input.preflight.outcome !== "passed" ||
    campaignPreflight.outcome !== "passed"
  ) {
    throw new Error("R4 case did not pass no-Agent campaign admission");
  }
  const admission = await admissionStore.createAdmissionOnce({
    portfolioFreeze: input.design.expectedPortfolio,
    caseOrdinal: prepared.materials.ordinal,
    campaignId: registration.campaignId,
    mutationRegistrationRecordSha256: registration.recordContentSha256,
    naturalPromptCanonicalJsonSha256:
      contract.naturalPrompt.canonicalJsonSha256,
    pairedAgentProtocolImplementationSha256:
      contract.pairedAgentProtocolImplementationSha256,
    pairedCaseContractContentSha256: contract.pairedCaseContractContentSha256,
    runtimeArmPublicTaskSpecSha256: contract.runtimeArmPublicTaskSpecSha256,
    codeOnlyArmPublicTaskSpecSha256: contract.codeOnlyArmPublicTaskSpecSha256,
    admittedAt: input.now(),
  });
  const bound = await prepared.infrastructure.bindCaseOnce({
    caseContract: contract,
    caseCampaignAdmission: admission,
  });
  await mutationStore.registerOnce({
    registration,
    baselineRoot: prepared.assignment.protectedBaselineRoot,
    evaluatorImplementationPath: prepared.materials.evaluatorImplementationPath,
    evaluatorBundlePath: prepared.materials.evaluatorBundlePath,
    registeredAt: input.now(),
  });
  const [runtimeEvaluatorProcess, codeOnlyEvaluatorProcess] =
    await openEvaluatorProcesses({
      live: input.live,
      prepared,
      bound,
      preparedPair: input.design.preparedPair,
    });
  const [runtimeRunner, codeOnlyRunner] = await Promise.all([
    LocalExternalHiddenFixFreshCopyRunnerV1.open({
      temporaryRoot: prepared.roots.runtimeEvaluatorTemporaryRoot,
      exposedRoots: agentExposedRoots,
      patchStore: prepared.runtimePatchStore,
      evaluator: runtimeEvaluatorProcess,
      gitBinary: "/usr/bin/git",
    }),
    LocalExternalHiddenFixFreshCopyRunnerV1.open({
      temporaryRoot: prepared.roots.codeOnlyEvaluatorTemporaryRoot,
      exposedRoots: agentExposedRoots,
      patchStore: prepared.codeOnlyPatchStore,
      evaluator: codeOnlyEvaluatorProcess,
      gitBinary: "/usr/bin/git",
    }),
  ]);
  const mutationResolver = {
    resolve: (campaignId: string, registered: M7MutationRegistrationV1) =>
      mutationStore.resolve(campaignId, registered),
  };
  const failedSentinelSha256 = async (): Promise<Sha256DigestV1 | null> => {
    const sentinels = await Promise.all([
      bound.retainedEvidence.readSandboxSentinelReceipt("runtime_enabled"),
      bound.retainedEvidence.readSandboxSentinelReceipt("code_only"),
    ]);
    for (const sentinel of sentinels) {
      if (
        sentinel !== null &&
        (typeof sentinel !== "object" ||
          Array.isArray(sentinel) ||
          sentinel.status !== "succeeded" ||
          sentinel.exitCode !== 0)
      ) {
        return digestJson(sentinel);
      }
    }
    return null;
  };
  let residualCleanup: Promise<M7R3ResidualCleanupResultV1> | null = null;
  const cleanupRemainingAfterFailure =
    (): Promise<M7R3ResidualCleanupResultV1> => {
      residualCleanup ??= (async () => {
        const evaluatorResults = await Promise.all(
          [runtimeEvaluatorProcess, codeOnlyEvaluatorProcess].map(
            async (evaluator) => {
              try {
                return Object.freeze({
                  status: "fulfilled" as const,
                  receipt: await evaluator.cleanup(),
                  errorClassSha256: null,
                });
              } catch (error) {
                return Object.freeze({
                  status: "rejected" as const,
                  receipt: null,
                  errorClassSha256: errorClassSha256(error),
                });
              }
            },
          ),
        );
        let phaseOneCleanup: M7R3ResidualCleanupResultV1 | null = null;
        let phaseOneErrorClassSha256: Sha256DigestV1 | null = null;
        try {
          phaseOneCleanup = projectM7R4PhaseOneCleanupV1(
            await bound.cleanupRemainingAfterFailure(),
          );
        } catch (error) {
          phaseOneErrorClassSha256 = errorClassSha256(error);
        }
        const cleanupProven =
          phaseOneCleanup?.cleanupProven === true &&
          evaluatorResults.every(
            (entry) =>
              entry.status === "fulfilled" && entry.receipt.cleanupProven,
          );
        const basis = JsonValueSchema.parse({
          schemaVersion: 1,
          recordKind: "m7-r4-formal-evaluator-residual-cleanup",
          caseOrdinal: prepared.materials.ordinal,
          phaseOneCleanup,
          phaseOneErrorClassSha256,
          evaluators: {
            runtimeEnabled: evaluatorResults[0],
            codeOnly: evaluatorResults[1],
          },
          cleanupProven,
          sandboxSafetyFailure: phaseOneCleanup?.sandboxSafetyFailure ?? false,
          observedAt: input.now(),
        });
        const record = JsonValueSchema.parse({
          ...(basis as Record<string, JsonValue>),
          recordContentSha256: digestJson(basis),
        });
        await writeExactOnce(
          prepared.roots.campaignRoot,
          "m7-r4.evaluator-residual-cleanup.json",
          Buffer.from(`${canonicalJson(record)}\n`, "utf8"),
        );
        return M7R3ResidualCleanupResultV1Schema.parse({
          cleanupProven,
          cleanupReceiptSha256: cleanupProven ? digestJson(basis) : null,
          sandboxSafetyFailure: phaseOneCleanup?.sandboxSafetyFailure ?? false,
          sandboxSafetyReceiptSha256:
            phaseOneCleanup?.sandboxSafetyFailure === true
              ? phaseOneCleanup.sandboxSafetyReceiptSha256
              : null,
        });
      })();
      return residualCleanup;
    };
  return Object.freeze({
    caseAdmission: admission,
    campaignStore,
    armPort: bound.armPort,
    evaluatorPorts: Object.freeze({
      runtime_enabled: createM7R3LocalHiddenEvaluatorPortV1({
        campaignId: registration.campaignId,
        registration,
        mutationResolver,
        runner: runtimeRunner,
      }),
      code_only: createM7R3LocalHiddenEvaluatorPortV1({
        campaignId: registration.campaignId,
        registration,
        mutationResolver,
        runner: codeOnlyRunner,
      }),
    }),
    evidenceStore,
    cleanupRemainingAfterFailure,
    hasAgentStarted: () => bound.hasAgentStarted(),
    persistInfrastructureFailureOnce: input.failureWriter,
    readSandboxSafetyFailureReceiptAfterGate: async () =>
      failedSentinelSha256(),
  });
};

export const createM7R4FormalCasePlansV1 = (input: {
  readonly live: M7R4VerifiedLiveMaterialsV1;
  readonly design: M7R4FreshTwoCaseDesignV1;
  readonly runSharedNoAgentPreflightOnce: (
    portfolioFreeze: M7R3TwoCasePortfolioFreezeV1,
  ) => Promise<M7R4NoAgentLiveResultV1>;
  readonly now: () => string;
}): readonly [M7R3TwoCaseLocalCasePlanV1<1>, M7R3TwoCaseLocalCasePlanV1<2>] => {
  const failureWriters = [
    createCampaignFailureWriter({ prepared: input.design.preparedPair[0] }),
    createCampaignFailureWriter({ prepared: input.design.preparedPair[1] }),
  ] as const;
  const aborts: Array<Promise<M7R3ResidualCleanupResultV1> | null> = [
    null,
    null,
  ];
  const abortOnce = (index: 0 | 1): Promise<M7R3ResidualCleanupResultV1> => {
    aborts[index] ??= input.design.preparedPair[index].infrastructure
      .abortPreparation()
      .then((cleanup) => projectM7R4PhaseOneCleanupV1(cleanup));
    return aborts[index];
  };
  let preflightPromise: Promise<M7R4NoAgentLiveResultV1> | null = null;
  const sharedPreflight = (
    portfolioFreeze: M7R3TwoCasePortfolioFreezeV1,
  ): Promise<M7R4NoAgentLiveResultV1> => {
    if (!sameJson(portfolioFreeze, input.design.expectedPortfolio)) {
      throw new TypeError("R4 shared preflight received another portfolio");
    }
    preflightPromise ??= input.runSharedNoAgentPreflightOnce(portfolioFreeze);
    return preflightPromise;
  };
  const preflightFor = async (
    index: 0 | 1,
    request: Parameters<
      M7R3TwoCaseLocalCasePlanV1<1>["runAndPersistPreflightOnce"]
    >[0],
  ) => {
    if (
      !sameJson(request.portfolioFreeze, input.design.expectedPortfolio) ||
      !sameJson(
        request.constructionReceipt,
        input.design.constructions[index],
      ) ||
      !sameJson(request.trajectoryClassifierFreeze, input.live.classifierFreeze)
    ) {
      throw new TypeError("R4 preflight callback crossed frozen inputs");
    }
    const result = await sharedPreflight(request.portfolioFreeze);
    if (result.result.status !== "completed") {
      await Promise.allSettled([abortOnce(0), abortOnce(1)]);
      throw new Error("R4 shared no-Agent preflight safety-stopped");
    }
    const receipt = result.completedReceipts[index];
    if (receipt === undefined) {
      throw new Error("R4 shared no-Agent preflight omitted a case receipt");
    }
    if (receipt.outcome !== "passed") await abortOnce(index);
    return receipt;
  };
  const preparedCampaign = [false, false];
  const prepareCampaign = async (
    index: 0 | 1,
    request: Parameters<
      M7R3TwoCaseLocalCasePlanV1<1>["prepareCampaignWithoutStartingAgentOnce"]
    >[0],
  ): Promise<M7R3PreparedLocalCaseCampaignV1> => {
    if (preparedCampaign[index]) {
      throw new Error("R4 case campaign preparation may run only once");
    }
    preparedCampaign[index] = true;
    const storedPreflight = await input.design.constructionStore.readPreflight(
      (index + 1) as 1 | 2,
    );
    if (
      !sameJson(request.portfolioFreeze, input.design.expectedPortfolio) ||
      !sameJson(
        request.constructionReceipt,
        input.design.constructions[index],
      ) ||
      !sameJson(request.caseContract, input.design.contracts[index]) ||
      !sameJson(request.preflightReceipt, storedPreflight)
    ) {
      throw new TypeError("R4 campaign preparation crossed frozen inputs");
    }
    return registerCampaignWithoutAgent({
      live: input.live,
      design: input.design,
      prepared: input.design.preparedPair[index],
      construction: input.design.constructions[index],
      preflight: request.preflightReceipt,
      contract: request.caseContract,
      now: input.now,
      failureWriter: failureWriters[index],
    });
  };
  return [
    {
      ordinal: 1,
      caseContract: input.design.contracts[0],
      runAndPersistPreflightOnce: (request) => preflightFor(0, request),
      prepareCampaignWithoutStartingAgentOnce: (request) =>
        prepareCampaign(0, request),
      abortPreparation: () => abortOnce(0),
      persistInfrastructureFailureOnce: failureWriters[0],
    },
    {
      ordinal: 2,
      caseContract: input.design.contracts[1],
      runAndPersistPreflightOnce: (request) => preflightFor(1, request),
      prepareCampaignWithoutStartingAgentOnce: (request) =>
        prepareCampaign(1, request),
      abortPreparation: () => abortOnce(1),
      persistInfrastructureFailureOnce: failureWriters[1],
    },
  ];
};

const runDisposableDryCase = async (input: {
  readonly live: M7R4VerifiedLiveMaterialsV1;
  readonly design: M7R4FreshTwoCaseDesignV1;
  readonly portfolio: M7R3TwoCasePortfolioFreezeV1;
  readonly prepared: M7R4PreparedCasePhaseOneV1;
  readonly construction: M7R3CaseConstructionReceiptV1;
  readonly contract: M7R3PairedCaseContractV1;
  readonly now: () => string;
}): Promise<z.infer<typeof JsonValueSchema>> => {
  const agentExposedRoots = [
    input.live.publicRoot,
    input.live.hostConfig.taskStorageRoot,
    ...input.design.preparedPair.flatMap((candidate) => [
      candidate.roots.runtimeAgentResourceRoot,
      candidate.roots.codeOnlyAgentResourceRoot,
    ]),
  ];
  const [campaignStore, admissionStore] = await Promise.all([
    openM7RuntimeUseCampaignStoreV1({
      root: input.prepared.roots.campaignRoot,
      exposedRoots: agentExposedRoots,
    }),
    openM7R3CaseCampaignAdmissionStoreV1({
      root: input.prepared.roots.campaignRoot,
      exposedRoots: agentExposedRoots,
    }),
  ]);
  const registeredAt = input.now();
  const sensorBinding = await campaignStore.bindCampaignSensorOnce(
    sensorBindingInput({
      live: input.live,
      contract: input.contract,
      boundAt: registeredAt,
    }),
  );
  const registration = await campaignStore.registerMutationOnce({
    mutationSha256: input.construction.mutation.mutationSha256,
    mutatedBaselineSelectedTreeSha256:
      input.construction.mutatedBuild.selectedTreeSha256,
    mutatedBuildSourceIdentitySha256: deriveM7BuildSourceIdentitySha256V1({
      sourceId: input.construction.mutatedBuild.sourceId,
      sourceHash: input.construction.mutatedBuild.sourceSha256,
    }),
    adapterMutantCompatibilityReceiptSha256:
      input.construction.adapterMutantCompatibility.receiptRecordSha256,
    publicTaskSpecSha256: input.contract.pairedPublicTaskContractSha256,
    evaluatorImplementationSha256:
      input.construction.evaluatorImplementation.sha256,
    evaluatorBundleSha256: input.construction.evaluatorBundle.sha256,
    provider: input.contract.agentConfiguration.provider,
    model: input.contract.agentConfiguration.model,
    thinkingLevel: input.contract.agentConfiguration.thinkingLevel,
    agentBudgetSha256: input.contract.agentConfiguration.agentBudgetSha256,
    codingToolSetSha256: input.contract.agentConfiguration.codingToolSetSha256,
    sandboxPolicySha256: input.contract.agentConfiguration.sandboxPolicySha256,
    registeredAt,
  });
  if (
    registration.campaignSensorBindingRecordSha256 !==
    sensorBinding.recordContentSha256
  ) {
    throw new Error("R4 dry registration crossed its sensor binding");
  }
  const admission = await admissionStore.createAdmissionOnce({
    portfolioFreeze: input.portfolio,
    caseOrdinal: input.prepared.materials.ordinal,
    campaignId: registration.campaignId,
    mutationRegistrationRecordSha256: registration.recordContentSha256,
    naturalPromptCanonicalJsonSha256:
      input.contract.naturalPrompt.canonicalJsonSha256,
    pairedAgentProtocolImplementationSha256:
      input.contract.pairedAgentProtocolImplementationSha256,
    pairedCaseContractContentSha256:
      input.contract.pairedCaseContractContentSha256,
    runtimeArmPublicTaskSpecSha256:
      input.contract.runtimeArmPublicTaskSpecSha256,
    codeOnlyArmPublicTaskSpecSha256:
      input.contract.codeOnlyArmPublicTaskSpecSha256,
    admittedAt: input.now(),
  });
  const bound = await input.prepared.infrastructure.bindCaseOnce({
    caseContract: input.contract,
    caseCampaignAdmission: admission,
  });
  const dryPort = await prepareM7R3ProjectEnvironmentPairedAgentPortV1({
    runtimeArm: bound.runtimeArm,
    codeOnlyArm: bound.codeOnlyArm,
  });
  let sentinelHashes: readonly [Sha256DigestV1, Sha256DigestV1] | undefined;
  let primaryFailure: unknown;
  try {
    const runtime =
      await dryPort.runPreAgentSandboxSentinelOnce("runtime_enabled");
    const codeOnly = await dryPort.runPreAgentSandboxSentinelOnce("code_only");
    sentinelHashes = [runtime, codeOnly];
  } catch (error) {
    primaryFailure = error;
  }
  let cleanup: Awaited<ReturnType<typeof bound.cleanupRemainingAfterFailure>>;
  try {
    cleanup = await bound.cleanupRemainingAfterFailure();
  } catch (error) {
    throw new AggregateError(
      [primaryFailure, error].filter((value) => value !== undefined),
      `${input.prepared.materials.slug} R4 dry sentinel or cleanup failed`,
    );
  }
  if (primaryFailure !== undefined) {
    throw primaryFailure instanceof Error
      ? primaryFailure
      : new Error("R4 dry sentinel failed with a non-Error value");
  }
  if (
    sentinelHashes === undefined ||
    bound.hasAgentStarted() ||
    !cleanup.cleanupProven ||
    cleanup.sandboxSafetyFailure
  ) {
    throw new Error("R4 dry protocol/sandbox admission did not close cleanly");
  }
  return JsonValueSchema.parse({
    schemaVersion: 1,
    ordinal: input.prepared.materials.ordinal,
    campaignId: registration.campaignId,
    caseAdmissionRecordSha256: admission.recordContentSha256,
    pairedCaseContractContentSha256:
      input.contract.pairedCaseContractContentSha256,
    sandboxSentinelReceiptSha256s: sentinelHashes,
    cleanup,
    agentLaunchCount: 0,
    providerInvocationCount: 0,
    piSessionCount: 0,
  });
};

export async function runM7R4PreAgentDryRunV1(input: {
  readonly live: M7R4VerifiedLiveMaterialsV1;
  readonly now?: (() => string) | undefined;
}): Promise<z.infer<typeof JsonValueSchema>> {
  if (input.live.mode !== "pre-agent-dry-run") {
    throw new TypeError("R4 pre-Agent dry runner requires dry mode");
  }
  const now = input.now ?? (() => new Date().toISOString());
  const design = await prepareM7R4FreshTwoCaseDesignV1({
    live: input.live,
    now,
  });
  let primaryFailure: unknown;
  let cases: z.infer<typeof JsonValueSchema>[] | undefined;
  try {
    const portfolio = await design.portfolioStore.createPortfolioOnce(
      design.portfolioFreezeInput,
    );
    if (!sameJson(portfolio, design.expectedPortfolio)) {
      throw new Error("R4 dry portfolio changed during persistence");
    }
    cases = [];
    for (const index of [0, 1] as const) {
      cases.push(
        await runDisposableDryCase({
          live: input.live,
          design,
          portfolio,
          prepared: design.preparedPair[index],
          construction: design.constructions[index],
          contract: design.contracts[index],
          now,
        }),
      );
    }
  } catch (error) {
    primaryFailure = error;
  }
  let cleanup: M7R3ResidualCleanupResultV1 | undefined;
  let cleanupFailure: unknown;
  try {
    cleanup = await design.cleanup();
    if (!cleanup.cleanupProven || cleanup.sandboxSafetyFailure) {
      cleanupFailure = new Error("R4 dry residual cleanup was not proven");
    }
  } catch (error) {
    cleanupFailure = error;
  }
  if (primaryFailure !== undefined || cleanupFailure !== undefined) {
    throw new AggregateError(
      [primaryFailure, cleanupFailure].filter((value) => value !== undefined),
      "R4 pre-Agent dry run failed",
    );
  }
  return JsonValueSchema.parse({
    schemaVersion: 1,
    receiptKind: "m7-r4-pre-agent-dry-run",
    outcome: "passed",
    disposableConstructionAndPortfolio: true,
    publicBehaviorPreflightInvoked: false,
    hiddenEvaluatorInvoked: false,
    formalGateInvoked: false,
    agentLaunchCount: 0,
    providerInvocationCount: 0,
    piSessionCount: 0,
    cases,
    cleanup,
  });
}

const errorClassSha256 = (error: unknown): Sha256DigestV1 => {
  let errorClass: string = typeof error;
  try {
    if (error instanceof Error) {
      const prototype = Object.getPrototypeOf(error) as {
        constructor?: { name?: unknown };
      } | null;
      const name = prototype?.constructor?.name;
      errorClass = typeof name === "string" && name.length > 0 ? name : "Error";
    }
  } catch {
    errorClass = "ErrorLike";
  }
  return asSha256DigestV1(
    createHash("sha256").update(errorClass, "utf8").digest("hex"),
  );
};

export const M7R4FormalOuterFailureStageV1Schema = z.enum([
  "materialize_design",
  "no_agent_preflight",
  "portfolio_campaign",
]);
export type M7R4FormalOuterFailureStageV1 = z.infer<
  typeof M7R4FormalOuterFailureStageV1Schema
>;

const outerFailureBasisSchema = z
  .object({
    schemaVersion: z.literal(1),
    recordKind: z.literal("m7-r4-formal-outer-infrastructure-failure"),
    stage: M7R4FormalOuterFailureStageV1Schema,
    portfolioId:
      M7R3TwoCasePortfolioFreezeV1Schema.shape.portfolioId.nullable(),
    errorClassSha256: Sha256DigestV1Schema,
    cleanupProven: z.boolean(),
    cleanupReceiptSha256: Sha256DigestV1Schema.nullable(),
    sandboxSafetyFailure: z.boolean(),
    sandboxSafetyReceiptSha256: Sha256DigestV1Schema.nullable(),
    observedAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((value, context) => {
    const cleanup = M7R3ResidualCleanupResultV1Schema.safeParse({
      cleanupProven: value.cleanupProven,
      cleanupReceiptSha256: value.cleanupReceiptSha256,
      sandboxSafetyFailure: value.sandboxSafetyFailure,
      sandboxSafetyReceiptSha256: value.sandboxSafetyReceiptSha256,
    });
    if (!cleanup.success) {
      cleanup.error.issues.forEach((issue) =>
        context.addIssue({
          code: "custom",
          path: [...issue.path],
          message: issue.message,
        }),
      );
    }
  });

export const M7R4FormalOuterFailureReceiptV1Schema = outerFailureBasisSchema
  .extend({ recordContentSha256: Sha256DigestV1Schema })
  .strict()
  .superRefine((value, context) => {
    const { recordContentSha256, ...basis } = value;
    if (recordContentSha256 !== digestJson(basis)) {
      context.addIssue({
        code: "custom",
        path: ["recordContentSha256"],
        message: "R4 formal outer failure content hash does not match",
      });
    }
  });
export type M7R4FormalOuterFailureReceiptV1 = z.infer<
  typeof M7R4FormalOuterFailureReceiptV1Schema
>;

const outerFailureReceipt = (input: {
  readonly stage: M7R4FormalOuterFailureStageV1;
  readonly portfolioId: string | null;
  readonly error: unknown;
  readonly cleanup: M7R3ResidualCleanupResultV1;
  readonly observedAt: string;
}): M7R4FormalOuterFailureReceiptV1 => {
  const basis = outerFailureBasisSchema.parse({
    schemaVersion: 1,
    recordKind: "m7-r4-formal-outer-infrastructure-failure",
    stage: input.stage,
    portfolioId: input.portfolioId,
    errorClassSha256: errorClassSha256(input.error),
    ...input.cleanup,
    observedAt: input.observedAt,
  });
  return M7R4FormalOuterFailureReceiptV1Schema.parse({
    ...basis,
    recordContentSha256: digestJson(basis),
  });
};

export interface RunM7R4FormalLiveV1Input {
  readonly live: M7R4VerifiedLiveMaterialsV1;
  readonly preflightAttemptStore: M7R4NoAgentPreflightAttemptStoreV1;
  /** Persists only the sanitized record supplied here, never the raw Error. */
  readonly persistOuterFailureOnce: (
    receipt: M7R4FormalOuterFailureReceiptV1,
  ) => Promise<Sha256DigestV1>;
  readonly preflightEvidencePersistence?:
    | readonly [
        M7R3CasePreflightEvidencePersistencePortV1,
        M7R3CasePreflightEvidencePersistencePortV1,
      ]
    | undefined;
  readonly preflightEvaluatorHeadroomObservers?:
    | readonly [
        ExternalHiddenFixEvaluatorHeadroomObserverV1,
        ExternalHiddenFixEvaluatorHeadroomObserverV1,
      ]
    | undefined;
  readonly now?: (() => string) | undefined;
}

export interface M7R4FormalLiveResultV1 {
  readonly portfolio: M7R3TwoCaseLocalPortfolioRunV1;
  readonly preflightTerminal: M7R4NoAgentPreflightTerminalV1 & {
    readonly status: "passed";
  };
  readonly cleanup: M7R3ResidualCleanupResultV1;
}

/** Narrow composition seam; production defaults remain the only live path. */
export interface M7R4FormalCompositionPortsV1 {
  readonly prepareFreshDesign: typeof prepareM7R4FreshTwoCaseDesignV1;
  readonly runNoAgentPreflightForDesign: typeof runM7R4NoAgentLivePreflightForDesignV1;
  readonly runPortfolio: typeof runM7R3TwoCaseLocalPortfolioV1;
}

const productionCompositionPorts: M7R4FormalCompositionPortsV1 = Object.freeze({
  prepareFreshDesign: prepareM7R4FreshTwoCaseDesignV1,
  runNoAgentPreflightForDesign: runM7R4NoAgentLivePreflightForDesignV1,
  runPortfolio: runM7R3TwoCaseLocalPortfolioV1,
});

/**
 * The single production R4 orchestration. The full R3 coordinator alone
 * creates the portfolio, validates both construction/contract lineages, and
 * owns each case's one runtime -> cleanup -> code-only Gate.
 */
export async function runM7R4FormalLiveV1(
  input: RunM7R4FormalLiveV1Input,
  ports: M7R4FormalCompositionPortsV1 = productionCompositionPorts,
): Promise<M7R4FormalLiveResultV1> {
  const now = input.now ?? (() => new Date().toISOString());
  let stage: M7R4FormalOuterFailureStageV1 = "materialize_design";
  let design: M7R4FreshTwoCaseDesignV1 | undefined;
  let preflightTerminal:
    | (M7R4NoAgentPreflightTerminalV1 & { readonly status: "passed" })
    | undefined;
  let portfolioResult: M7R3TwoCaseLocalPortfolioRunV1 | undefined;
  let primaryFailure: unknown;
  let materializationCleanup: M7R3ResidualCleanupResultV1 | undefined;
  try {
    if (input.live.mode !== "r4-live") {
      throw new TypeError("R4 formal runner requires r4-live mode");
    }
    design = await ports.prepareFreshDesign({
      live: input.live,
      now,
    });
    stage = "portfolio_campaign";
    let retainedPreflight: Promise<M7R4RetainedNoAgentPreflightResultV1> | null =
      null;
    const runSharedNoAgentPreflightOnce = (
      portfolioFreeze: M7R3TwoCasePortfolioFreezeV1,
    ): Promise<M7R4NoAgentLiveResultV1> => {
      if (retainedPreflight === null) {
        stage = "no_agent_preflight";
        retainedPreflight = runAndRetainM7R4NoAgentPreflightOnceV1({
          portfolioFreeze,
          attemptStore: input.preflightAttemptStore,
          run: () =>
            ports.runNoAgentPreflightForDesign({
              live: input.live,
              design: design!,
              portfolioFreeze,
              ...(input.preflightEvidencePersistence === undefined
                ? {}
                : {
                    evidencePersistence: input.preflightEvidencePersistence,
                  }),
              ...(input.preflightEvaluatorHeadroomObservers === undefined
                ? {}
                : {
                    evaluatorHeadroomObservers:
                      input.preflightEvaluatorHeadroomObservers,
                  }),
              now,
            }),
          now,
        }).then((retained) => {
          preflightTerminal = retained.terminal;
          stage = "portfolio_campaign";
          return retained;
        });
      }
      return retainedPreflight.then((retained) => retained.result);
    };
    const casePlans = createM7R4FormalCasePlansV1({
      live: input.live,
      design,
      runSharedNoAgentPreflightOnce,
      now,
    });
    portfolioResult = await ports.runPortfolio({
      trajectoryClassifierFreeze: input.live.classifierFreeze,
      constructionReceipts: design.constructions,
      portfolioFreezeInput: design.portfolioFreezeInput,
      portfolioStore: asM7R3TwoCaseLocalPortfolioStorePortV1(
        design.portfolioStore,
      ),
      cases: casePlans,
      now,
    });
    if (
      !sameJson(portfolioResult.portfolioFreeze, design.expectedPortfolio) ||
      preflightTerminal === undefined
    ) {
      throw new Error("R4 formal coordinator crossed its expected portfolio");
    }
  } catch (error) {
    if (error instanceof M7R4FreshDesignMaterializationErrorV1) {
      materializationCleanup = error.cleanup;
    }
    primaryFailure = error;
  }

  let cleanup = materializationCleanup ?? unprovenCleanup();
  let cleanupFailure: unknown;
  if (design !== undefined) {
    try {
      cleanup = M7R3ResidualCleanupResultV1Schema.parse(await design.cleanup());
      if (!cleanup.cleanupProven || cleanup.sandboxSafetyFailure) {
        cleanupFailure = new Error(
          cleanup.sandboxSafetyFailure
            ? "R4 formal residual sandbox safety failure"
            : "R4 formal residual cleanup was not proven",
        );
      }
    } catch (error) {
      cleanupFailure = error;
    }
  }

  if (primaryFailure !== undefined || cleanupFailure !== undefined) {
    const receipt = outerFailureReceipt({
      stage,
      portfolioId: design?.expectedPortfolio.portfolioId ?? null,
      error: primaryFailure ?? cleanupFailure,
      cleanup,
      observedAt: now(),
    });
    let retentionFailure: unknown;
    try {
      const persisted = Sha256DigestV1Schema.parse(
        await input.persistOuterFailureOnce(receipt),
      );
      if (persisted !== receipt.recordContentSha256) {
        throw new Error("R4 formal outer failure persistence changed its hash");
      }
    } catch (error) {
      retentionFailure = error;
    }
    throw new AggregateError(
      [primaryFailure, cleanupFailure, retentionFailure].filter(
        (value) => value !== undefined,
      ),
      "R4 formal composition failed",
    );
  }

  if (portfolioResult === undefined || preflightTerminal === undefined) {
    throw new Error("R4 formal composition returned no terminal result");
  }
  return Object.freeze({
    portfolio: portfolioResult,
    preflightTerminal,
    cleanup,
  });
}
