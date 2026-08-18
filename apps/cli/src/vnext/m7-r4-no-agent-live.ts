import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rm,
} from "node:fs/promises";
import { join } from "node:path";

import {
  JsonValueSchema,
  Sha256DigestV1Schema,
  asSha256DigestV1,
  type Sha256DigestV1,
} from "@chronorift/domain";
import { canonicalJson } from "@chronorift/json-artifacts";

import { collectCandidateGodotSourceV1 } from "./candidate-godot-build.js";
import {
  CgroupBwrapExternalHiddenFixEvaluatorProcessV1,
  type ExternalHiddenFixEvaluatorHeadroomObserverV1,
  type ExternalHiddenFixEvaluatorResourceCleanupTruthV1,
  type ExternalHiddenFixEvaluatorProcessPortV1,
} from "./external-hidden-fix-evaluator.js";
import {
  M7R3PreflightApiBlockerErrorV1,
  runM7R3TwoCasePreflightV1,
  type M7R3CasePreflightEvidencePersistencePortV1,
  type M7R3HiddenEvaluatorPreflightPortV1,
  type M7R3HiddenEvaluatorPreflightRequestV1,
  type M7R3TwoCasePreflightRunResultV1,
} from "./m7-r3-case-preflight-runner.js";
import {
  projectM7R3ConstructionToPortfolioCaseV1,
  type M7R3CaseConstructionReceiptV1,
  type M7R3CaseConstructionStoreV1,
  type M7R3CasePreflightReceiptV1,
  type M7R3PortfolioCaseConstructionProjectionV1,
} from "./m7-r3-case-construction.js";
import { m7R3OperationalHostConfigPathsForCaseV1 } from "./m7-r3-live-operational-config.js";
import {
  prepareM7R3NoAgentProjectEnvironmentPreflightPortV1,
  type M7R3NoAgentProjectEnvironmentPreflightCleanupV1,
  type PreparedM7R3NoAgentProjectEnvironmentPreflightPortV1,
} from "./m7-r3-project-environment-preflight.js";
import {
  M7R3TwoCasePortfolioFreezeV1Schema,
  type M7R3TwoCasePortfolioFreezeV1,
} from "./m7-r3-two-case-portfolio.js";
import { readProjectEnvironmentHostConfigV1 } from "./project-environment-host-config.js";
import { selectedTreeSha256 } from "./selected-tree.js";
import type {
  M7R4FreshTwoCaseDesignV1,
  M7R4PreparedCasePhaseOneV1,
} from "./m7-r4-formal-live.js";
import type {
  M7R4NoAgentPreflightAttemptStoreV1,
  M7R4NoAgentPreflightReceiptReferenceV1,
  M7R4NoAgentPreflightSubjectEvidenceInputV1,
  M7R4NoAgentPreflightTerminalV1,
} from "./m7-r4-no-agent-preflight-attempt.js";
import type {
  M7R4VerifiedCaseMaterialsV1,
  M7R4VerifiedLiveMaterialsV1,
} from "./m7-r4-live-materials.js";

const PRIVATE_DIRECTORY_MODE = 0o700;

const digestJson = (value: unknown): Sha256DigestV1 =>
  asSha256DigestV1(
    createHash("sha256")
      .update(canonicalJson(JsonValueSchema.parse(value)))
      .digest("hex"),
  );

const isNodeError = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error && "code" in error;

interface DirectoryIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly uid: number;
  readonly mode: number;
}

const capturePrivateDirectoryIdentity = async (
  path: string,
  label: string,
): Promise<DirectoryIdentity> => {
  const metadata = await lstat(path);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== process.geteuid?.() ||
    (metadata.mode & 0o7777) !== PRIVATE_DIRECTORY_MODE ||
    (await realpath(path)) !== path
  ) {
    throw new Error(`${label} must be an owned canonical mode-0700 directory`);
  }
  return {
    dev: metadata.dev,
    ino: metadata.ino,
    uid: metadata.uid,
    mode: metadata.mode,
  };
};

const removeFreshDirectory = async (
  path: string,
  expected: DirectoryIdentity,
): Promise<boolean> => {
  try {
    const metadata = await lstat(path);
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      metadata.dev !== expected.dev ||
      metadata.ino !== expected.ino ||
      metadata.uid !== expected.uid ||
      metadata.mode !== expected.mode ||
      (await realpath(path)) !== path
    ) {
      return false;
    }
    await rm(path, { recursive: true, force: false });
    try {
      await lstat(path);
      return false;
    } catch (error) {
      return isNodeError(error) && error.code === "ENOENT";
    }
  } catch {
    return false;
  }
};

const sameJson = (left: unknown, right: unknown): boolean =>
  canonicalJson(JsonValueSchema.parse(left)) ===
  canonicalJson(JsonValueSchema.parse(right));

/**
 * Matches construction-owned fields without treating derived case metadata
 * as construction input.
 */
export const m7R4PortfolioCaseMatchesConstructionProjectionV1 = (input: {
  readonly projection: M7R3PortfolioCaseConstructionProjectionV1;
  readonly frozenCase: M7R3TwoCasePortfolioFreezeV1["cases"][number];
}): boolean =>
  Object.entries(input.projection).every(([key, value]) =>
    sameJson(input.frozenCase[key as keyof typeof input.projection], value),
  );

const createHiddenEvaluatorPort = (input: {
  readonly materials: M7R4VerifiedCaseMaterialsV1;
  readonly construction: M7R3CaseConstructionReceiptV1;
  readonly caseId: string;
  readonly evaluator: ExternalHiddenFixEvaluatorProcessPortV1;
}): M7R3HiddenEvaluatorPreflightPortV1 => {
  let invocation = 0;
  return Object.freeze({
    async runFresh(request: M7R3HiddenEvaluatorPreflightRequestV1) {
      invocation += 1;
      const expectedSource =
        request.subject === "pristine"
          ? {
              root: input.materials.pristineProjectRoot,
              sourceId: `source:${input.materials.manifest.pristineSelectedTreeSha256}`,
              selectedTreeSha256:
                input.materials.manifest.pristineSelectedTreeSha256,
            }
          : {
              root: input.materials.mutantProjectRoot,
              sourceId: input.construction.mutatedBuild.sourceId,
              selectedTreeSha256:
                input.materials.manifest.mutatedSelectedTreeSha256,
            };
      if (
        request.ordinal !== input.materials.ordinal ||
        request.caseId !== input.caseId ||
        request.evaluatorImplementationSha256 !==
          input.materials.manifest.evaluatorImplementationSha256 ||
        request.evaluatorBundleSha256 !==
          input.materials.manifest.evaluatorBundleSha256 ||
        request.source.sourceId !== expectedSource.sourceId ||
        request.source.sourceSha256 !== expectedSource.selectedTreeSha256 ||
        request.source.selectedTreeSha256 !== expectedSource.selectedTreeSha256
      ) {
        throw new TypeError(
          `${input.materials.slug} hidden preflight crossed frozen identity`,
        );
      }
      const selectedBefore = selectedTreeSha256(
        await collectCandidateGodotSourceV1(
          expectedSource.root,
          "project-environment",
          "tracked-tool-scripts-v1",
        ),
      );
      if (selectedBefore !== expectedSource.selectedTreeSha256) {
        throw new Error(
          `${input.materials.slug} source changed before hidden fresh copy`,
        );
      }
      const runRoot = await mkdtemp(
        join(
          input.materials.preflightEvaluatorTemporaryRoot,
          `run-${String(invocation).padStart(2, "0")}-`,
        ),
      );
      await chmod(runRoot, PRIVATE_DIRECTORY_MODE);
      const runIdentity = await capturePrivateDirectoryIdentity(
        runRoot,
        `${input.materials.slug} hidden run root`,
      );
      const workspaceRoot = join(runRoot, "workspace");
      const importCacheRoot = join(runRoot, "import-cache");
      const workspaceIdentity = `m7-r4-preflight-workspace:${randomUUID()}`;
      const importCacheIdentity = `m7-r4-preflight-import-cache:${randomUUID()}`;
      const processIdentity = `m7-r4-preflight-process:${randomUUID()}`;
      let result:
        | Awaited<
            ReturnType<ExternalHiddenFixEvaluatorProcessPortV1["evaluate"]>
          >
        | undefined;
      let failure: unknown;
      try {
        await cp(expectedSource.root, workspaceRoot, {
          recursive: true,
          dereference: false,
          errorOnExist: true,
          force: false,
          preserveTimestamps: false,
        });
        await mkdir(importCacheRoot, { mode: PRIVATE_DIRECTORY_MODE });
        const copiedTree = selectedTreeSha256(
          await collectCandidateGodotSourceV1(
            workspaceRoot,
            "project-environment",
            "tracked-tool-scripts-v1",
          ),
        );
        if (copiedTree !== expectedSource.selectedTreeSha256) {
          throw new Error(
            `${input.materials.slug} hidden fresh source mismatched`,
          );
        }
        result = await input.evaluator.evaluate({
          evaluatorImplementationPath:
            input.materials.evaluatorImplementationPath,
          evaluatorBundlePath: input.materials.evaluatorBundlePath,
          workspaceRoot,
          importCacheRoot,
          freshCopyId: `m7-r4-preflight:${input.materials.ordinal}:${request.subject}:${request.scenario.scenarioId}:${randomUUID()}`,
          scenarioClass: request.scenario.scenarioClass,
          repetition: request.scenario.repetition,
        });
        if (
          selectedTreeSha256(
            await collectCandidateGodotSourceV1(
              workspaceRoot,
              "project-environment",
              "tracked-tool-scripts-v1",
            ),
          ) !== copiedTree
        ) {
          throw new Error(
            `${input.materials.slug} hidden evaluator changed source`,
          );
        }
      } catch (error) {
        failure = error;
      }
      const directoryCleanupProven = await removeFreshDirectory(
        runRoot,
        runIdentity,
      );
      if (failure !== undefined || result === undefined) {
        throw new AggregateError(
          [
            failure ?? new Error("hidden evaluator returned no result"),
            ...(directoryCleanupProven
              ? []
              : [new Error("hidden fresh directory cleanup failed")]),
          ],
          `${input.materials.slug} hidden preflight failed`,
        );
      }
      const processCleanupProven = result.processCleanupProven === true;
      return Object.freeze({
        schemaVersion: 1 as const,
        subject: request.subject,
        scenarioId: request.scenario.scenarioId,
        observation:
          result.outcome === "passed"
            ? ("expected_motion_observed" as const)
            : ("expected_motion_not_observed" as const),
        observationReceipt: JsonValueSchema.parse({
          schemaVersion: 1,
          outcome: result.outcome,
          observationSha256: result.observationSha256,
        }),
        workspace: Object.freeze({
          created: true,
          identity: workspaceIdentity,
          creationReceipt: JsonValueSchema.parse({
            schemaVersion: 1,
            identity: workspaceIdentity,
            selectedTreeSha256: expectedSource.selectedTreeSha256,
            sourceId: expectedSource.sourceId,
          }),
        }),
        importCache: Object.freeze({
          created: true,
          identity: importCacheIdentity,
          creationReceipt: JsonValueSchema.parse({
            schemaVersion: 1,
            identity: importCacheIdentity,
          }),
        }),
        process: Object.freeze({
          started: result.processStarted,
          identity: processIdentity,
          startReceipt: JsonValueSchema.parse({
            schemaVersion: 1,
            identity: processIdentity,
            processStarted: result.processStarted,
            processCleanupProven,
            observationSha256: result.observationSha256,
          }),
        }),
        cleanup: Object.freeze({
          proven: directoryCleanupProven && processCleanupProven,
          receipt: JsonValueSchema.parse({
            schemaVersion: 1,
            processCleanupProven,
            freshDirectoryCleanupProven: directoryCleanupProven,
          }),
        }),
        agentLaunchCount: 0 as const,
        providerInvocationCount: 0 as const,
        piSessionCount: 0 as const,
      });
    },
  });
};

interface PreparedCase {
  readonly ordinal: 1 | 2;
  readonly projectEnvironment: PreparedM7R3NoAgentProjectEnvironmentPreflightPortV1;
  readonly evaluator: CgroupBwrapExternalHiddenFixEvaluatorProcessV1;
  readonly hiddenEvaluator: M7R3HiddenEvaluatorPreflightPortV1;
}

export async function cleanupM7R4NoAgentPreparedResourcesV1(input: {
  readonly evaluator: {
    cleanup(): Promise<ExternalHiddenFixEvaluatorResourceCleanupTruthV1>;
  };
  readonly projectEnvironment: {
    cleanup(): Promise<M7R3NoAgentProjectEnvironmentPreflightCleanupV1>;
  };
}): Promise<M7R3NoAgentProjectEnvironmentPreflightCleanupV1> {
  const failures: unknown[] = [];
  try {
    const evaluatorCleanup = await input.evaluator.cleanup();
    if (!evaluatorCleanup.cleanupProven) {
      failures.push(
        new Error("R4 no-Agent evaluator cleanup was not proven", {
          cause: evaluatorCleanup,
        }),
      );
    }
  } catch (error) {
    failures.push(error);
  }

  let projectEnvironmentCleanup:
    M7R3NoAgentProjectEnvironmentPreflightCleanupV1 | undefined;
  try {
    projectEnvironmentCleanup = await input.projectEnvironment.cleanup();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length > 0 || projectEnvironmentCleanup === undefined) {
    throw new AggregateError(
      failures,
      "R4 no-Agent evaluator or Project Environment cleanup was not proven",
    );
  }
  return projectEnvironmentCleanup;
}

const prepareCase = async (input: {
  readonly live: M7R4VerifiedLiveMaterialsV1;
  readonly phaseOne: M7R4PreparedCasePhaseOneV1;
  readonly preparedPair: M7R4FreshTwoCaseDesignV1["preparedPair"];
  readonly construction: M7R3CaseConstructionReceiptV1;
  readonly caseId: string;
  readonly evaluatorHeadroomObserver?:
    ExternalHiddenFixEvaluatorHeadroomObserverV1 | undefined;
  readonly now: () => string;
}): Promise<PreparedCase> => {
  const materials = input.phaseOne.materials;
  const assignment = input.phaseOne.assignment;
  const toolchain = input.live.hostConfig.godotToolchains[0];
  if (toolchain === undefined) {
    throw new Error("R4 Host config omitted its Godot toolchain");
  }
  const noAgentHostConfigPath = m7R3OperationalHostConfigPathsForCaseV1(
    input.live.operationalHostConfigs,
    materials.ordinal,
  ).noAgentPreflight;
  const projectEnvironment =
    await prepareM7R3NoAgentProjectEnvironmentPreflightPortV1({
      ordinal: materials.ordinal,
      pristineSource: assignment.pristineSource,
      mutantSource: assignment.mutatedSource,
      adapterFiles: input.phaseOne.adapterFiles,
      adapterRevision: input.live.adapterRevision,
      hostConfigPath: noAgentHostConfigPath,
      now: input.now,
    });
  let evaluator: CgroupBwrapExternalHiddenFixEvaluatorProcessV1;
  try {
    const noAgentHostConfig = await readProjectEnvironmentHostConfigV1(
      noAgentHostConfigPath,
    );
    evaluator = await CgroupBwrapExternalHiddenFixEvaluatorProcessV1.open({
      bwrapPath: noAgentHostConfig.bwrapPath,
      nodePath: input.live.hostConfig.nodePath,
      prlimitPath: noAgentHostConfig.prlimitPath,
      delegatedCgroupRoot: noAgentHostConfig.delegatedCgroupRoot,
      taskId: `task:m7-r4:no-agent-evaluator:case-0${String(materials.ordinal)}`,
      assertTaskStorageHeadroom: projectEnvironment.assertTaskStorageHeadroom,
      onHeadroomObserved:
        input.evaluatorHeadroomObserver ?? (() => Promise.resolve(undefined)),
      taskStorageRoot: noAgentHostConfig.taskStorageRoot,
      evaluatorTemporaryRoot: materials.preflightEvaluatorTemporaryRoot,
      runtimeMounts: [
        { source: toolchain.executablePath, target: "/runtime/assets/godot" },
      ],
      forbiddenRoots: [
        input.live.publicRoot,
        noAgentHostConfig.taskStorageRoot,
        join(input.live.runsRoot, "operational-config"),
        ...input.preparedPair.flatMap((candidate) => [
          candidate.roots.runtimeAgentResourceRoot,
          candidate.roots.codeOnlyAgentResourceRoot,
        ]),
      ],
      timeoutMs: materials.runtimeTask.evaluatorBudget.wallTimeMsPerRunMaximum,
    });
  } catch (error) {
    let cleanupFailure: unknown;
    try {
      const cleanup = await projectEnvironment.cleanup();
      if (!cleanup.cleanupProven) {
        cleanupFailure = new Error(
          "R4 no-Agent Project Environment cleanup was not proven after evaluator setup failure",
          { cause: cleanup },
        );
      }
    } catch (cleanupError) {
      cleanupFailure = cleanupError;
    }
    if (cleanupFailure !== undefined) {
      throw new AggregateError(
        [error, cleanupFailure],
        "R4 no-Agent evaluator setup and Project Environment cleanup failed",
      );
    }
    throw error;
  }
  return {
    ordinal: materials.ordinal,
    projectEnvironment,
    evaluator,
    hiddenEvaluator: createHiddenEvaluatorPort({
      materials,
      construction: input.construction,
      caseId: input.caseId,
      evaluator,
    }),
  };
};

export interface M7R4NoAgentLiveResultV1 {
  readonly result: M7R3TwoCasePreflightRunResultV1;
  readonly completedReceipts: readonly M7R3CasePreflightReceiptV1[];
  readonly subjectEvidence: readonly M7R4NoAgentPreflightSubjectEvidenceInputV1[];
}

export class M7R4NoAgentLiveErrorV1 extends Error {
  public override readonly name = "M7R4NoAgentLiveErrorV1";

  public constructor(
    public readonly stage:
      | "prepare"
      | "public_observation"
      | "hidden_evaluation"
      | "receipt_persistence"
      | "cleanup",
    public readonly caseOrdinal: 1 | 2 | null,
    public readonly subject: "pristine" | "mutant" | null,
    public readonly completedReceipts: readonly M7R3CasePreflightReceiptV1[],
    public readonly subjectEvidence: readonly M7R4NoAgentPreflightSubjectEvidenceInputV1[],
    cause: unknown,
  ) {
    super("M7 R4 no-Agent live preflight failed", { cause });
  }
}

const stageForError = (error: unknown): M7R4NoAgentLiveErrorV1["stage"] => {
  if (!(error instanceof M7R3PreflightApiBlockerErrorV1)) return "prepare";
  if (error.code.startsWith("hidden_")) return "hidden_evaluation";
  if (error.code === "public_observation_cleanup_not_proven") return "cleanup";
  if (
    error.code.startsWith("preflight_persistence_") ||
    error.code.startsWith("preflight_evidence_persistence_")
  ) {
    return "receipt_persistence";
  }
  return error.code === "invalid_frozen_inputs"
    ? "prepare"
    : "public_observation";
};

export const m7R4NoAgentRetentionErrorV1 = (
  error: M7R4NoAgentLiveErrorV1,
): unknown => {
  const underlying = error.cause;
  return underlying instanceof M7R3PreflightApiBlockerErrorV1 &&
    stageForError(underlying) === error.stage &&
    underlying.ordinal === error.caseOrdinal &&
    underlying.subject === error.subject
    ? underlying
    : error;
};

interface M7R4CompletedReceiptReadResultV1 {
  readonly receipts: readonly M7R3CasePreflightReceiptV1[];
  readonly failure: M7R3PreflightApiBlockerErrorV1 | null;
}

const readCompletedReceipts = async (
  store: M7R3CaseConstructionStoreV1,
): Promise<M7R4CompletedReceiptReadResultV1> => {
  const receipts: M7R3CasePreflightReceiptV1[] = [];
  for (const ordinal of [1, 2] as const) {
    try {
      receipts.push(await store.readPreflight(ordinal));
    } catch (error) {
      return Object.freeze({
        receipts: Object.freeze([...receipts]),
        failure:
          isNodeError(error) && error.code === "ENOENT"
            ? null
            : new M7R3PreflightApiBlockerErrorV1(
                "preflight_persistence_failed",
                ordinal,
                null,
                { cause: error },
              ),
      });
    }
  }
  return Object.freeze({
    receipts: Object.freeze([...receipts]),
    failure: null,
  });
};

export interface M7R4NoAgentPreflightCoreCaseV1<Prepared> {
  readonly ordinal: 1 | 2;
  readonly caseId: string;
  readonly prepare: () => Promise<Prepared>;
  readonly cleanup: (
    prepared: Prepared,
  ) => Promise<M7R3NoAgentProjectEnvironmentPreflightCleanupV1>;
}

/** Dependency seam for deterministic offline lifecycle coverage. */
export async function runM7R4NoAgentPreflightCoreV1<Prepared>(input: {
  readonly cases: readonly [
    M7R4NoAgentPreflightCoreCaseV1<Prepared>,
    M7R4NoAgentPreflightCoreCaseV1<Prepared>,
  ];
  readonly runPrepared: (
    prepared: readonly [Prepared, Prepared],
  ) => Promise<M7R3TwoCasePreflightRunResultV1>;
  readonly readCompletedReceipts: () => Promise<M7R4CompletedReceiptReadResultV1>;
}): Promise<M7R4NoAgentLiveResultV1> {
  if (input.cases[0].ordinal !== 1 || input.cases[1].ordinal !== 2) {
    throw new TypeError("R4 no-Agent core cases must remain in ordinal order");
  }
  const prepared: {
    readonly spec: M7R4NoAgentPreflightCoreCaseV1<Prepared>;
    readonly value: Prepared;
  }[] = [];
  const subjectEvidence: M7R4NoAgentPreflightSubjectEvidenceInputV1[] =
    input.cases.flatMap((candidate) =>
      (["pristine", "mutant"] as const).map((subject) => ({
        caseOrdinal: candidate.ordinal,
        caseId: candidate.caseId,
        subject,
        cleanupAttempted: false,
        cleanupProven: false,
        cleanupReceipt: null,
        cleanupReceiptSha256: null,
        securityEvents: null,
        securityEventsSha256: null,
      })),
    );
  let result: M7R3TwoCasePreflightRunResultV1 | undefined;
  let primaryFailure: unknown;
  let activePrepareOrdinal: 1 | 2 | null = null;
  try {
    for (const candidate of input.cases) {
      activePrepareOrdinal = candidate.ordinal;
      prepared.push({ spec: candidate, value: await candidate.prepare() });
    }
    activePrepareOrdinal = null;
    const first = prepared[0];
    const second = prepared[1];
    if (first === undefined || second === undefined) {
      throw new Error("R4 did not prepare exactly two preflight cases");
    }
    result = await input.runPrepared([first.value, second.value]);
  } catch (error) {
    primaryFailure = error;
  }
  let cleanupFailed = false;
  let cleanupFailureCause: unknown;
  let cleanupFailureContext:
    | {
        readonly ordinal: 1 | 2;
        readonly subject: "pristine" | "mutant" | null;
      }
    | undefined;
  for (const candidate of prepared) {
    try {
      const cleanup = await candidate.spec.cleanup(candidate.value);
      for (const subject of ["pristine", "mutant"] as const) {
        const receipt = cleanup.subjects[subject];
        const evidenceIndex =
          (candidate.spec.ordinal - 1) * 2 + (subject === "pristine" ? 0 : 1);
        subjectEvidence[evidenceIndex] = {
          ...subjectEvidence[evidenceIndex]!,
          cleanupAttempted: receipt.attempted,
          cleanupProven: receipt.cleanupProven,
          cleanupReceipt: receipt.cleanupReceipt,
          cleanupReceiptSha256: receipt.cleanupReceiptSha256,
          securityEvents: receipt.securityEvents,
          securityEventsSha256: receipt.securityEventsSha256,
        };
        if (!receipt.cleanupProven) {
          cleanupFailed = true;
          cleanupFailureContext ??= {
            ordinal: candidate.spec.ordinal,
            subject,
          };
        }
      }
    } catch (error) {
      cleanupFailed = true;
      cleanupFailureContext ??= {
        ordinal: candidate.spec.ordinal,
        subject: null,
      };
      cleanupFailureCause ??= error;
      for (const offset of [0, 1] as const) {
        const evidenceIndex = (candidate.spec.ordinal - 1) * 2 + offset;
        subjectEvidence[evidenceIndex] = {
          ...subjectEvidence[evidenceIndex]!,
          cleanupAttempted: true,
        };
      }
    }
  }
  let completedReceiptRead: M7R4CompletedReceiptReadResultV1;
  try {
    completedReceiptRead = await input.readCompletedReceipts();
  } catch (error) {
    completedReceiptRead = {
      receipts: [],
      failure: new M7R3PreflightApiBlockerErrorV1(
        "preflight_persistence_failed",
        1,
        null,
        { cause: error },
      ),
    };
  }
  const completedReceipts = completedReceiptRead.receipts;
  let receiptReadFailure = completedReceiptRead.failure;
  if (receiptReadFailure === null && result?.status === "completed") {
    if (completedReceipts.length !== 2) {
      receiptReadFailure = new M7R3PreflightApiBlockerErrorV1(
        "preflight_persistence_failed",
        completedReceipts.length === 0 ? 1 : 2,
        null,
      );
    } else {
      const mismatchedIndex = [0, 1].find(
        (index) => !sameJson(completedReceipts[index], result.receipts[index]),
      );
      if (mismatchedIndex !== undefined) {
        receiptReadFailure = new M7R3PreflightApiBlockerErrorV1(
          "preflight_persistence_substitution",
          (mismatchedIndex + 1) as 1 | 2,
          null,
        );
      }
    }
  }
  if (
    primaryFailure !== undefined ||
    cleanupFailed ||
    receiptReadFailure !== null ||
    result === undefined
  ) {
    const blocker =
      primaryFailure instanceof M7R3PreflightApiBlockerErrorV1
        ? primaryFailure
        : primaryFailure === undefined &&
            !cleanupFailed &&
            receiptReadFailure !== null
          ? receiptReadFailure
          : null;
    const stage =
      primaryFailure !== undefined
        ? stageForError(primaryFailure)
        : cleanupFailed
          ? "cleanup"
          : receiptReadFailure === null
            ? "prepare"
            : "receipt_persistence";
    throw new M7R4NoAgentLiveErrorV1(
      stage,
      blocker?.ordinal ??
        activePrepareOrdinal ??
        cleanupFailureContext?.ordinal ??
        null,
      blocker?.subject ?? cleanupFailureContext?.subject ?? null,
      completedReceipts,
      subjectEvidence,
      primaryFailure ??
        cleanupFailureCause ??
        receiptReadFailure ??
        new Error("R4 no-Agent preflight returned no result"),
    );
  }
  return Object.freeze({
    result,
    completedReceipts,
    subjectEvidence: Object.freeze([...subjectEvidence]),
  });
}

/** Runs public observations and the hidden 3x3 matrices without a Pi surface. */
export async function runM7R4NoAgentLivePreflightForDesignV1(input: {
  readonly live: M7R4VerifiedLiveMaterialsV1;
  readonly design: M7R4FreshTwoCaseDesignV1;
  readonly portfolioFreeze: M7R4FreshTwoCaseDesignV1["expectedPortfolio"];
  readonly evidencePersistence?:
    | readonly [
        M7R3CasePreflightEvidencePersistencePortV1,
        M7R3CasePreflightEvidencePersistencePortV1,
      ]
    | undefined;
  readonly evaluatorHeadroomObservers?:
    | readonly [
        ExternalHiddenFixEvaluatorHeadroomObserverV1,
        ExternalHiddenFixEvaluatorHeadroomObserverV1,
      ]
    | undefined;
  readonly now?: (() => string) | undefined;
}): Promise<M7R4NoAgentLiveResultV1> {
  if (
    input.live.mode !== "no-agent-preflight" &&
    input.live.mode !== "r4-live"
  ) {
    throw new TypeError("R4 no-Agent preflight is not available in dry mode");
  }
  const now = input.now ?? (() => new Date().toISOString());
  const {
    constructionStore,
    preparedPair,
    constructions: [firstConstruction, secondConstruction],
    expectedPortfolio,
  } = input.design;
  const classifierFreeze = input.live.classifierFreeze;
  const portfolio = input.portfolioFreeze;
  if (
    !sameJson(portfolio, expectedPortfolio) ||
    firstConstruction.outcome !== "passed" ||
    secondConstruction.outcome !== "passed" ||
    preparedPair[0].materials.ordinal !== 1 ||
    preparedPair[1].materials.ordinal !== 2 ||
    !sameJson(
      preparedPair[0].materials.manifest,
      input.live.cases[0].manifest,
    ) ||
    !sameJson(
      preparedPair[1].materials.manifest,
      input.live.cases[1].manifest,
    ) ||
    !m7R4PortfolioCaseMatchesConstructionProjectionV1({
      projection: projectM7R3ConstructionToPortfolioCaseV1(firstConstruction),
      frozenCase: portfolio.cases[0],
    }) ||
    !m7R4PortfolioCaseMatchesConstructionProjectionV1({
      projection: projectM7R3ConstructionToPortfolioCaseV1(secondConstruction),
      frozenCase: portfolio.cases[1],
    })
  ) {
    throw new M7R4NoAgentLiveErrorV1(
      "prepare",
      null,
      null,
      [],
      [],
      new Error("R4 frozen construction or portfolio graph changed"),
    );
  }
  return runM7R4NoAgentPreflightCoreV1<PreparedCase>({
    cases: [
      {
        ordinal: 1,
        caseId: portfolio.cases[0].caseId,
        prepare: () =>
          prepareCase({
            live: input.live,
            phaseOne: preparedPair[0],
            preparedPair,
            construction: firstConstruction,
            caseId: portfolio.cases[0].caseId,
            ...(input.evaluatorHeadroomObservers === undefined
              ? {}
              : {
                  evaluatorHeadroomObserver:
                    input.evaluatorHeadroomObservers[0],
                }),
            now,
          }),
        cleanup: (candidate) =>
          cleanupM7R4NoAgentPreparedResourcesV1(candidate),
      },
      {
        ordinal: 2,
        caseId: portfolio.cases[1].caseId,
        prepare: () =>
          prepareCase({
            live: input.live,
            phaseOne: preparedPair[1],
            preparedPair,
            construction: secondConstruction,
            caseId: portfolio.cases[1].caseId,
            ...(input.evaluatorHeadroomObservers === undefined
              ? {}
              : {
                  evaluatorHeadroomObserver:
                    input.evaluatorHeadroomObservers[1],
                }),
            now,
          }),
        cleanup: (candidate) =>
          cleanupM7R4NoAgentPreparedResourcesV1(candidate),
      },
    ],
    runPrepared: ([first, second]) =>
      runM7R3TwoCasePreflightV1({
        trajectoryClassifierFreeze: classifierFreeze,
        constructionReceipts: [firstConstruction, secondConstruction],
        portfolioFreeze: portfolio,
        cases: [
          {
            ordinal: 1,
            configuredMainScene: first.projectEnvironment.configuredMainScene,
            projectEnvironment: first.projectEnvironment.projectEnvironment,
            hiddenEvaluator: first.hiddenEvaluator,
            persistence: constructionStore,
            ...(input.evidencePersistence === undefined
              ? {}
              : { evidencePersistence: input.evidencePersistence[0] }),
          },
          {
            ordinal: 2,
            configuredMainScene: second.projectEnvironment.configuredMainScene,
            projectEnvironment: second.projectEnvironment.projectEnvironment,
            hiddenEvaluator: second.hiddenEvaluator,
            persistence: constructionStore,
            ...(input.evidencePersistence === undefined
              ? {}
              : { evidencePersistence: input.evidencePersistence[1] }),
          },
        ],
        now,
      }),
    readCompletedReceipts: () => readCompletedReceipts(constructionStore),
  });
}

type M7R4NoAgentPreflightAttemptStorePortV1 = Pick<
  M7R4NoAgentPreflightAttemptStoreV1,
  "createStartedOnce" | "createPassedTerminalOnce" | "createFailedTerminalOnce"
>;

const unavailableSubjectEvidence = (
  portfolio: M7R3TwoCasePortfolioFreezeV1,
): readonly M7R4NoAgentPreflightSubjectEvidenceInputV1[] =>
  portfolio.cases.flatMap((frozenCase) =>
    (["pristine", "mutant"] as const).map((subject) => ({
      caseOrdinal: frozenCase.ordinal,
      caseId: frozenCase.caseId,
      subject,
      cleanupAttempted: false,
      cleanupProven: false,
      cleanupReceipt: null,
      cleanupReceiptSha256: null,
      securityEvents: null,
      securityEventsSha256: null,
    })),
  );

const receiptReference = (
  receipt: M7R3CasePreflightReceiptV1,
): M7R4NoAgentPreflightReceiptReferenceV1 => ({
  caseOrdinal: receipt.ordinal,
  caseId: receipt.portfolio.caseId,
  preflightReceiptSha256: receipt.recordContentSha256,
});

const completedReceiptPrefix = (input: {
  readonly receipts: readonly M7R3CasePreflightReceiptV1[];
  readonly portfolio: M7R3TwoCasePortfolioFreezeV1;
}): readonly M7R4NoAgentPreflightReceiptReferenceV1[] => {
  const references: M7R4NoAgentPreflightReceiptReferenceV1[] = [];
  for (const [index, receipt] of input.receipts.entries()) {
    const expected = input.portfolio.cases[index];
    if (
      expected === undefined ||
      receipt.ordinal !== index + 1 ||
      receipt.portfolio.caseId !== expected.caseId ||
      receipt.portfolio.portfolioId !== input.portfolio.portfolioId ||
      receipt.portfolio.portfolioFreezeRecordSha256 !==
        input.portfolio.recordContentSha256
    ) {
      break;
    }
    references.push(receiptReference(receipt));
  }
  return references;
};

const requirePassedReceiptReferences = (input: {
  readonly completed: M7R4NoAgentLiveResultV1;
  readonly portfolio: M7R3TwoCasePortfolioFreezeV1;
}): readonly [
  M7R4NoAgentPreflightReceiptReferenceV1,
  M7R4NoAgentPreflightReceiptReferenceV1,
] => {
  const { completed, portfolio } = input;
  if (completed.result.status === "safety_stopped") {
    throw new M7R4NoAgentLiveErrorV1(
      "cleanup",
      completed.result.stoppedAfter.ordinal,
      completed.result.stoppedAfter.subject,
      completed.completedReceipts,
      completed.subjectEvidence,
      new Error("R4 no-Agent hidden evaluator cleanup was not proven"),
    );
  }
  const references = completedReceiptPrefix({
    receipts: completed.completedReceipts,
    portfolio,
  });
  if (
    completed.result.status !== "completed" ||
    completed.result.agentLaunchCount !== 0 ||
    completed.result.piSessionCount !== 0 ||
    completed.result.providerInvocationCount !== 0 ||
    completed.completedReceipts.length !== 2 ||
    references.length !== 2
  ) {
    throw new M7R4NoAgentLiveErrorV1(
      "prepare",
      null,
      null,
      completed.completedReceipts,
      completed.subjectEvidence,
      new Error("R4 no-Agent preflight did not complete both frozen cases"),
    );
  }
  for (const index of [0, 1] as const) {
    const receipt = completed.completedReceipts[index];
    if (
      receipt === undefined ||
      receipt.outcome !== "passed" ||
      completed.result.receipts[index].recordContentSha256 !==
        receipt.recordContentSha256
    ) {
      throw new M7R4NoAgentLiveErrorV1(
        "prepare",
        (index + 1) as 1 | 2,
        null,
        completed.completedReceipts,
        completed.subjectEvidence,
        new Error("R4 no-Agent preflight retained a non-passing case"),
      );
    }
  }
  return [references[0]!, references[1]!];
};

export interface M7R4RetainedNoAgentPreflightResultV1 {
  readonly result: M7R4NoAgentLiveResultV1;
  readonly terminal: M7R4NoAgentPreflightTerminalV1 & {
    readonly status: "passed";
  };
}

/**
 * Permanently records the one no-Agent attempt around a supplied production
 * runner. The interface contains no Agent, Pi, credential, or provider port.
 * Phase-one cleanup remains the caller's outer lifecycle responsibility.
 */
export async function runAndRetainM7R4NoAgentPreflightOnceV1(input: {
  readonly portfolioFreeze: unknown;
  readonly attemptStore: M7R4NoAgentPreflightAttemptStorePortV1;
  readonly run: () => Promise<M7R4NoAgentLiveResultV1>;
  readonly beforePassedTerminal?: (() => Promise<void>) | undefined;
  readonly now?: (() => string) | undefined;
}): Promise<M7R4RetainedNoAgentPreflightResultV1> {
  const now = input.now ?? (() => new Date().toISOString());
  const portfolio = M7R3TwoCasePortfolioFreezeV1Schema.parse(
    input.portfolioFreeze,
  );
  const started = await input.attemptStore.createStartedOnce({
    portfolioFreeze: portfolio,
    startedAt: now(),
  });
  let completed: M7R4NoAgentLiveResultV1 | undefined;
  try {
    completed = await input.run();
    const references = requirePassedReceiptReferences({
      completed,
      portfolio,
    });
    if (input.beforePassedTerminal !== undefined) {
      try {
        await input.beforePassedTerminal();
      } catch (error) {
        throw new M7R4NoAgentLiveErrorV1(
          "cleanup",
          null,
          null,
          completed.completedReceipts,
          completed.subjectEvidence,
          error,
        );
      }
    }
    let terminal: M7R4NoAgentPreflightTerminalV1 & {
      readonly status: "passed";
    };
    try {
      terminal = await input.attemptStore.createPassedTerminalOnce({
        started,
        preflightReceipts: references,
        completedAt: now(),
      });
    } catch (error) {
      throw new M7R4NoAgentLiveErrorV1(
        "receipt_persistence",
        2,
        null,
        completed.completedReceipts,
        completed.subjectEvidence,
        error,
      );
    }
    return Object.freeze({ result: completed, terminal });
  } catch (error) {
    const failure =
      error instanceof M7R4NoAgentLiveErrorV1
        ? error
        : new M7R4NoAgentLiveErrorV1(
            "prepare",
            null,
            null,
            completed?.completedReceipts ?? [],
            completed?.subjectEvidence.length === 4
              ? completed.subjectEvidence
              : unavailableSubjectEvidence(portfolio),
            error,
          );
    try {
      await input.attemptStore.createFailedTerminalOnce({
        started,
        stage: failure.stage,
        caseOrdinal: failure.caseOrdinal,
        subject: failure.subject,
        error: m7R4NoAgentRetentionErrorV1(failure),
        completedPreflightReceipts: completedReceiptPrefix({
          receipts: failure.completedReceipts,
          portfolio,
        }),
        agentLaunchCount: 0,
        piSessionCount: 0,
        providerInvocationCount: 0,
        subjectEvidence:
          failure.subjectEvidence.length === 4
            ? failure.subjectEvidence
            : unavailableSubjectEvidence(portfolio),
        completedAt: now(),
      });
    } catch (retentionFailure) {
      throw new AggregateError(
        [failure, retentionFailure],
        "R4 no-Agent preflight and terminal retention failed",
      );
    }
    throw failure;
  }
}

export const m7R4DigestJsonForTestingV1 = (value: unknown): Sha256DigestV1 =>
  Sha256DigestV1Schema.parse(digestJson(value));
