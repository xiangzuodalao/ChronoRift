import {
  AdapterConformanceReceiptV1Schema,
  ObserverEffectReceiptV1Schema,
  ProjectAdapterRevisionV1Schema,
  EnvironmentBindingEpochV1Schema,
  ProjectEnvironmentReuseReceiptV1Schema,
  ProjectEnvironmentTurnV1Schema,
  asProjectEnvironmentReuseReceiptId,
  type AdapterConformanceReceiptV1,
  type AdapterId,
  type ObserverEffectReceiptV1,
  type ProjectAdapterRevisionV1,
  type AdapterCompatibilityReceiptV1,
  type AdapterCompatibilityReceiptV2,
  type EnvironmentBindingEpochId,
  type EnvironmentBindingEpochV1,
  type ProjectEnvironmentRevisionV1,
  type ProjectEnvironmentReuseReceiptV1,
  type ProjectEnvironmentTurnId,
  type ProjectEnvironmentTurnV1,
  type ProjectSessionId,
  type ProjectTurnBudgetV1,
  type ProjectToolchainReceiptId,
  type SourceId,
  type TaskId,
} from "@chronorift/domain";
import {
  loadProjectAdapterPackageFilesV1,
  type LoadedProjectAdapterPackageV1,
} from "@chronorift/godot-adapter";
import {
  canonicalJson,
  contentHash,
  type ProjectEnvironmentPackageFileInputV1,
  type ProjectEnvironmentTaskStoreV1,
} from "@chronorift/json-artifacts";

import {
  enforceProjectEnvironmentTurnBudgetV1,
  projectEnvironmentPiTurnExceptionResultV1,
  projectEnvironmentPiTurnTerminalFailureV1,
  type ProjectEnvironmentPiTurnResultV1,
} from "./project-environment-initialization.js";

export interface InspectedReusableProjectEnvironmentV1 {
  readonly revision: ProjectEnvironmentRevisionV1;
  readonly adapterRevision: ProjectAdapterRevisionV1;
  readonly conformance: AdapterConformanceReceiptV1;
  readonly observerEffect: ObserverEffectReceiptV1;
  readonly adapterPackage: LoadedProjectAdapterPackageV1;
  readonly adapterFiles: readonly {
    readonly relativePath: string;
    readonly bytes: Uint8Array;
  }[];
}

const recordBytes = (
  files: readonly ProjectEnvironmentPackageFileInputV1[],
  path: string,
): Uint8Array => {
  const matches = files.filter((file) => file.path === path);
  if (matches.length !== 1 || matches[0] === undefined) {
    throw new Error(`published Project Environment is missing ${path}`);
  }
  return matches[0].bytes;
};

const parseCanonicalRecord = <T>(
  files: readonly ProjectEnvironmentPackageFileInputV1[],
  path: string,
  parse: (value: unknown) => T,
): T => {
  const bytes = recordBytes(files, path);
  let value: unknown;
  try {
    value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ) as unknown;
  } catch (error) {
    throw new Error(`published Project Environment has invalid ${path}`, {
      cause: error,
    });
  }
  const parsed = parse(value);
  if (
    !Buffer.from(bytes).equals(
      Buffer.from(`${canonicalJson(value as never)}\n`),
    )
  ) {
    throw new Error(
      `published Project Environment record is not canonical: ${path}`,
    );
  }
  return parsed;
};

const sameValue = (left: unknown, right: unknown): boolean =>
  canonicalJson(left as never) === canonicalJson(right as never);

/**
 * Revalidates the path-free evidence closure and adapter bytes from a current
 * immutable revision. This does not decide SDK/bridge/policy reuse; those
 * identities depend on the newly realized managed runtime and are checked by
 * the Preview composition after this inspection.
 */
export function inspectReusableProjectEnvironmentRevisionV1(input: {
  readonly revision: ProjectEnvironmentRevisionV1;
  readonly files: readonly ProjectEnvironmentPackageFileInputV1[];
  readonly expectedSourceId: SourceId;
  readonly expectedToolchainReceiptId: ProjectToolchainReceiptId;
  readonly expectedAdapterId: AdapterId;
  readonly expectedMainScene: string;
}): InspectedReusableProjectEnvironmentV1 {
  if (
    input.revision.sourceId !== input.expectedSourceId ||
    input.revision.toolchainReceiptId !== input.expectedToolchainReceiptId
  ) {
    throw new Error(
      "current Project Environment revision does not match the realized source or Godot toolchain",
    );
  }
  const allowedRecords = new Set([
    "records/adapter-revision.v1.json",
    "records/conformance-receipt.v1.json",
    "records/observer-effect-receipt.v1.json",
  ]);
  if (
    input.files.some(
      (file) =>
        !file.path.startsWith("adapter/") && !allowedRecords.has(file.path),
    )
  ) {
    throw new Error(
      "published Project Environment revision contains an unsupported package path",
    );
  }
  const adapterFiles = input.files
    .filter((file) => file.path.startsWith("adapter/"))
    .map((file) =>
      Object.freeze({
        relativePath: file.path.slice("adapter/".length),
        bytes: Uint8Array.from(file.bytes),
      }),
    );
  const adapterPackage = loadProjectAdapterPackageFilesV1(
    adapterFiles.map((file) => ({
      path: file.relativePath,
      bytes: file.bytes,
    })),
    {
      requireSingleLaunchTarget: true,
      expectedMainScene: input.expectedMainScene,
      requireEmptyLaunchParameters: true,
    },
  );
  const adapterRevision = parseCanonicalRecord(
    input.files,
    "records/adapter-revision.v1.json",
    (value) => ProjectAdapterRevisionV1Schema.parse(value),
  );
  const conformance = parseCanonicalRecord(
    input.files,
    "records/conformance-receipt.v1.json",
    (value) => AdapterConformanceReceiptV1Schema.parse(value),
  );
  const observerEffect = parseCanonicalRecord(
    input.files,
    "records/observer-effect-receipt.v1.json",
    (value) => ObserverEffectReceiptV1Schema.parse(value),
  );
  if (
    adapterRevision.adapterId !== input.expectedAdapterId ||
    adapterRevision.adapterRevisionId !== input.revision.adapterRevisionId ||
    adapterRevision.sourceId !== input.revision.sourceId ||
    adapterRevision.packageDigest !== adapterPackage.candidateSha256 ||
    adapterRevision.manifestDigest !== adapterPackage.manifestSha256 ||
    adapterRevision.sdkDigest !== input.revision.sdkDigest ||
    adapterRevision.bridgeDigest !== input.revision.bridgeDigest ||
    adapterRevision.conformanceReceiptId !==
      input.revision.conformanceReceiptId ||
    conformance.receiptId !== input.revision.conformanceReceiptId ||
    conformance.sourceId !== input.revision.sourceId ||
    conformance.toolchainReceiptId !== input.revision.toolchainReceiptId ||
    conformance.outcome !== "conformed" ||
    !sameValue(conformance.capabilitySet, adapterRevision.capabilitySet) ||
    observerEffect.receiptId !== input.revision.observerEffectReceiptId ||
    observerEffect.sourceId !== input.revision.sourceId ||
    observerEffect.status !== "measured"
  ) {
    throw new Error(
      "published Project Environment evidence closure crossed its source, adapter, toolchain, or conformance binding",
    );
  }
  return Object.freeze({
    revision: input.revision,
    adapterRevision,
    conformance,
    observerEffect,
    adapterPackage,
    adapterFiles: Object.freeze(adapterFiles),
  });
}

const revisionReference = (revision: ProjectEnvironmentRevisionV1) => ({
  schemaVersion: 1 as const,
  environmentId: revision.environmentId,
  environmentRevisionId: revision.environmentRevisionId,
  sourceId: revision.sourceId,
  adapterRevisionId: revision.adapterRevisionId,
  sdkDigest: revision.sdkDigest,
  bridgeDigest: revision.bridgeDigest,
  toolchainReceiptId: revision.toolchainReceiptId,
  conformanceReceiptId: revision.conformanceReceiptId,
  observerEffectReceiptId: revision.observerEffectReceiptId,
  policyProfileDigest: revision.policyProfileDigest,
  contentDigest: revision.contentDigest,
});

/** Persists a new Task's reuse fact and append-only pin after quick smoke. */
export async function bindReusableProjectEnvironmentRevisionV1(input: {
  readonly taskStore: ProjectEnvironmentTaskStoreV1;
  readonly taskId: TaskId;
  readonly sessionId: ProjectSessionId;
  readonly bindingEpochId: EnvironmentBindingEpochId;
  readonly revision: ProjectEnvironmentRevisionV1;
  readonly observedCurrentRevisionId: ProjectEnvironmentRevisionV1["environmentRevisionId"];
  readonly compatibility:
    AdapterCompatibilityReceiptV1 | AdapterCompatibilityReceiptV2;
  readonly createdAt: string;
  readonly boundAt: string;
}): Promise<{
  readonly receipt: ProjectEnvironmentReuseReceiptV1;
  readonly binding: EnvironmentBindingEpochV1;
}> {
  if (
    input.taskStore.taskId !== input.taskId ||
    input.observedCurrentRevisionId !== input.revision.environmentRevisionId ||
    input.compatibility.taskId !== input.taskId ||
    input.compatibility.environmentRevisionId !==
      input.revision.environmentRevisionId ||
    input.compatibility.adapterRevisionId !==
      input.revision.adapterRevisionId ||
    input.compatibility.toolchainReceiptId !==
      input.revision.toolchainReceiptId ||
    input.compatibility.outcome !== "compatible"
  ) {
    throw new Error(
      "Project Environment reuse crossed its Task, current revision, source, adapter, toolchain, or quick-smoke binding",
    );
  }
  const content = {
    schemaVersion: 1 as const,
    taskId: input.taskId,
    sessionId: input.sessionId,
    sourceId: input.revision.sourceId,
    buildId: input.compatibility.buildId,
    buildSourceId: input.compatibility.sourceId,
    environmentRevisionId: input.revision.environmentRevisionId,
    adapterRevisionId: input.revision.adapterRevisionId,
    toolchainReceiptId: input.revision.toolchainReceiptId,
    sdkDigest: input.revision.sdkDigest,
    bridgeDigest: input.revision.bridgeDigest,
    policyProfileDigest: input.revision.policyProfileDigest,
    observedCurrentRevisionId: input.observedCurrentRevisionId,
    compatibilityReceiptId: input.compatibility.receiptId,
    schemaBindingValidated: true,
    adapterPackageValidated: true,
    quickSmokeCompatible: true,
    cleanup: input.compatibility.cleanup,
    outcome: "reused" as const,
    failures: [] as const,
    observedAt: input.boundAt,
  };
  const receipt = ProjectEnvironmentReuseReceiptV1Schema.parse({
    ...content,
    receiptId: asProjectEnvironmentReuseReceiptId(
      `reuse:v1:${contentHash(JSON.parse(JSON.stringify(content)) as never)}`,
    ),
  });
  const binding = EnvironmentBindingEpochV1Schema.parse({
    schemaVersion: 1,
    bindingEpochId: input.bindingEpochId,
    taskId: input.taskId,
    ordinal: 0,
    state: "reused",
    sessionId: input.sessionId,
    environment: revisionReference(input.revision),
    reuseReceiptId: receipt.receiptId,
    compatibilityReceiptId: input.compatibility.receiptId,
    createdAt: input.createdAt,
    boundAt: input.boundAt,
  });
  await input.taskStore.putReuseReceiptOnce(receipt);
  await input.taskStore.appendBindingEpoch(binding);
  return Object.freeze({ receipt, binding });
}

export type ReusedProjectEnvironmentTurnResultV1 =
  ProjectEnvironmentPiTurnResultV1;

/** Runs only the user's goal; reuse never fabricates an initialization turn. */
export async function runReusedProjectEnvironmentGoalV1(input: {
  readonly taskId: TaskId;
  readonly sessionId: ProjectSessionId;
  readonly bindingEpochId: EnvironmentBindingEpochId;
  readonly turnId: ProjectEnvironmentTurnId;
  readonly goal: string | null;
  readonly budget: ProjectTurnBudgetV1;
  readonly runTurn: (input: {
    readonly purpose: "user_goal";
    readonly prompt: string;
    readonly sessionId: ProjectSessionId;
    readonly bindingEpochId: EnvironmentBindingEpochId;
    readonly budget: ProjectTurnBudgetV1;
  }) => Promise<ReusedProjectEnvironmentTurnResultV1>;
  readonly putTurn: (turn: ProjectEnvironmentTurnV1) => Promise<void>;
  readonly now?: () => string;
}): Promise<{
  readonly turn: ProjectEnvironmentTurnV1 | null;
  readonly goalDelivered: boolean;
}> {
  if (input.goal === null) {
    return Object.freeze({ turn: null, goalDelivered: true });
  }
  if (
    input.goal.trim().length === 0 ||
    input.goal.length > 128 * 1_024 ||
    input.goal.includes("\0")
  ) {
    throw new TypeError("reuse goal must be non-empty bounded text");
  }
  const now = input.now ?? (() => new Date().toISOString());
  const startedAt = now();
  let result: ReusedProjectEnvironmentTurnResultV1;
  try {
    result = enforceProjectEnvironmentTurnBudgetV1(
      await input.runTurn({
        purpose: "user_goal",
        prompt: input.goal,
        sessionId: input.sessionId,
        bindingEpochId: input.bindingEpochId,
        budget: input.budget,
      }),
      input.budget,
    );
    if (result.sessionId !== input.sessionId) {
      throw Object.assign(
        new Error("reused goal switched away from its new Task Session"),
        { code: "session_mismatch" },
      );
    }
  } catch (error) {
    result = projectEnvironmentPiTurnExceptionResultV1(error, input.sessionId);
  }
  const endedAt = now();
  const failure = projectEnvironmentPiTurnTerminalFailureV1(result);
  const turn = ProjectEnvironmentTurnV1Schema.parse({
    schemaVersion: 1,
    turnId: input.turnId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    purpose: "user_goal",
    attemptId: null,
    bindingEpochId: input.bindingEpochId,
    promptDigest: contentHash({ schemaVersion: 1, text: input.goal }),
    queuedGoalDigest: null,
    budget: input.budget,
    usageStatus: result.usageStatus,
    usage: result.usage,
    status: result.status,
    terminalCode: failure?.failureCode ?? null,
    terminalMessage: failure?.message ?? null,
    startedAt,
    endedAt,
  });
  await input.putTurn(turn);
  return Object.freeze({
    turn,
    goalDelivered: turn.status === "completed",
  });
}
