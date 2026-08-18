import {
  M6AdapterBuildCompatibilityBindingV1Schema,
  M6AdapterBuildCompatibilityLineageV1Schema,
  M6AdapterBuildCompatibilityReceiptV1Schema,
  ProjectAdapterRevisionV1Schema,
  ProjectObservationCoverageV1Schema,
  ProjectObservationLossV1Schema,
  ProjectRuntimeCleanupReceiptV1Schema,
  ProjectToolchainReceiptIdSchema,
  Sha256DigestV1Schema,
  VNextBuildV1Schema,
  asM6AdapterBuildBindingId,
  asM6AdapterBuildCompatibilityReceiptId,
  projectRuntimeCleanupCompleteV1,
  type M6AdapterBuildCompatibilityBindingV1,
  type M6AdapterBuildCompatibilityLineageV1,
  type M6AdapterBuildCompatibilityReceiptV1,
  type ProjectObservationCoverageV1,
  type ProjectObservationLossV1,
  type ProjectRuntimeCleanupReceiptV1,
  type ProjectToolchainReceiptId,
  type Sha256DigestV1,
} from "@chronorift/domain";
import { contentHash } from "@chronorift/json-artifacts";

import type { ProjectEnvironmentGameRuntimeV1 } from "./project-environment-game-runtime.js";

type CompatibilityRuntimeV1 = Pick<
  ProjectEnvironmentGameRuntimeV1,
  "adapterBuildCompatibilityIdentity" | "invoke" | "close"
>;

class M6AdapterBuildCompatibilityIdentityError extends Error {
  public override readonly name = "M6AdapterBuildCompatibilityIdentityError";
}

const unavailableCleanup = (): ProjectRuntimeCleanupReceiptV1 =>
  ProjectRuntimeCleanupReceiptV1Schema.parse({
    schemaVersion: 1,
    processTreeTerminated: false,
    runtimeExited: false,
    bridgeExited: false,
    isolationGroupEmpty: false,
    scopeRemoved: false,
    scratchRemoved: false,
    storageReconciled: false,
  });

const unavailableCoverage = (): readonly ProjectObservationCoverageV1[] => [
  ProjectObservationCoverageV1Schema.parse({
    schemaVersion: 1,
    channelId: "project_adapter_observations",
    status: "unavailable",
    observedRecords: 0,
    droppedRecords: 0,
    overwrittenRecords: 0,
    limitations: ["Compatibility smoke did not return capture coverage."],
  }),
];

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const errorMessage = (value: unknown, fallback: string): string => {
  const response = record(value);
  const error = record(response?.error);
  return typeof error?.message === "string" && error.message.length > 0
    ? error.message.slice(0, 4_096)
    : fallback;
};

const hashValue = (value: unknown): string =>
  contentHash(JSON.parse(JSON.stringify(value)) as never);

const assertRuntimeIdentity = (
  runtime: CompatibilityRuntimeV1,
  lineage: M6AdapterBuildCompatibilityLineageV1,
): void => {
  const identity = runtime.adapterBuildCompatibilityIdentity();
  if (
    identity.taskId !== lineage.build.taskId ||
    identity.buildId !== lineage.build.buildId ||
    identity.sourceClosureId !== lineage.build.sourceId ||
    identity.candidateSourceHash !== lineage.build.sourceHash ||
    identity.adapterRevisionId !== lineage.adapterRevision.adapterRevisionId ||
    identity.adapterPackageSha256 !== lineage.adapterRevision.packageDigest ||
    identity.adapterManifestSha256 !== lineage.adapterRevision.manifestDigest ||
    identity.sdkSha256 !== lineage.adapterRevision.sdkDigest ||
    identity.bridgeSha256 !== lineage.adapterRevision.bridgeDigest ||
    identity.toolchainSha256 !== lineage.toolchain.artifactDigest
  ) {
    throw new M6AdapterBuildCompatibilityIdentityError(
      "M6 runtime closure crossed its exact adapter, Build, SDK, bridge, or toolchain lineage",
    );
  }
};

export function createM6AdapterBuildCompatibilityLineageV1(input: {
  readonly adapterRevision: unknown;
  readonly build: unknown;
  readonly baselineSourceHash: Sha256DigestV1 | string;
  readonly buildRole: "assignment_baseline" | "candidate";
  readonly toolchainReceiptId: ProjectToolchainReceiptId | string;
  readonly toolchainArtifactDigest: Sha256DigestV1 | string;
}): M6AdapterBuildCompatibilityLineageV1 {
  const adapterRevision = ProjectAdapterRevisionV1Schema.parse(
    input.adapterRevision,
  );
  const build = VNextBuildV1Schema.parse(input.build);
  return M6AdapterBuildCompatibilityLineageV1Schema.parse({
    schemaVersion: 1,
    buildRole: input.buildRole,
    baselineSourceHash: Sha256DigestV1Schema.parse(input.baselineSourceHash),
    adapterRevision: {
      schemaVersion: 1,
      adapterRevisionId: adapterRevision.adapterRevisionId,
      adapterId: adapterRevision.adapterId,
      sourceId: adapterRevision.sourceId,
      packageDigest: adapterRevision.packageDigest,
      manifestDigest: adapterRevision.manifestDigest,
      implementationDigest: adapterRevision.implementationDigest,
      payloadSchemaDigest: adapterRevision.payloadSchemaDigest,
      sdkDigest: adapterRevision.sdkDigest,
      bridgeDigest: adapterRevision.bridgeDigest,
      conformanceReceiptId: adapterRevision.conformanceReceiptId,
    },
    build,
    toolchain: {
      schemaVersion: 1,
      toolchainReceiptId: ProjectToolchainReceiptIdSchema.parse(
        input.toolchainReceiptId,
      ),
      artifactDigest: Sha256DigestV1Schema.parse(input.toolchainArtifactDigest),
    },
  });
}

export function createPendingM6AdapterBuildBindingV1(input: {
  readonly lineage: unknown;
  readonly now: string;
}): Extract<
  M6AdapterBuildCompatibilityBindingV1,
  { readonly compatibilityStatus: "pending" }
> {
  const lineage = M6AdapterBuildCompatibilityLineageV1Schema.parse(
    input.lineage,
  );
  return M6AdapterBuildCompatibilityBindingV1Schema.parse({
    schemaVersion: 1,
    bindingId: asM6AdapterBuildBindingId(
      `m6-adapter-build-binding:v1:${hashValue(lineage)}`,
    ),
    lineage,
    compatibilityStatus: "pending",
    compatibilityReceiptId: null,
    createdAt: input.now,
    completedAt: null,
  }) as Extract<
    M6AdapterBuildCompatibilityBindingV1,
    { readonly compatibilityStatus: "pending" }
  >;
}

interface SuccessfulLaunchV1 {
  readonly runtimeId: string;
  readonly executionId: string;
}

const validateLaunchIdentity = (
  value: unknown,
  lineage: M6AdapterBuildCompatibilityLineageV1,
): SuccessfulLaunchV1 | null => {
  const response = record(value);
  if (response?.outcome !== "success") return null;
  const output = record(response.output);
  if (output === null) return null;
  if (
    output.taskId !== lineage.build.taskId ||
    output.buildId !== lineage.build.buildId
  ) {
    throw new M6AdapterBuildCompatibilityIdentityError(
      "M6 compatibility runtime crossed its Task or exact Build binding",
    );
  }
  if (output.adapterRevisionId !== lineage.adapterRevision.adapterRevisionId) {
    throw new M6AdapterBuildCompatibilityIdentityError(
      "M6 compatibility runtime crossed its AdapterRevision binding",
    );
  }
  if (
    typeof output.runtimeId !== "string" ||
    typeof output.executionId !== "string"
  ) {
    throw new M6AdapterBuildCompatibilityIdentityError(
      "M6 compatibility launch omitted runtime identities",
    );
  }
  return {
    runtimeId: output.runtimeId,
    executionId: output.executionId,
  };
};

const queryRows = (
  value: unknown,
  input: {
    readonly lineage: M6AdapterBuildCompatibilityLineageV1;
    readonly executionId: string;
    readonly kind: "entity" | "state";
  },
): number | null => {
  const response = record(value);
  if (response?.outcome !== "success") return null;
  const output = record(response.output);
  if (output === null) return null;
  if (
    output.taskId !== input.lineage.build.taskId ||
    output.executionId !== input.executionId
  ) {
    throw new M6AdapterBuildCompatibilityIdentityError(
      `M6 ${input.kind} query crossed its Task or Execution binding`,
    );
  }
  if (!Array.isArray(output.rows)) {
    throw new M6AdapterBuildCompatibilityIdentityError(
      `M6 ${input.kind} query omitted bounded rows`,
    );
  }
  return output.rows.filter((value) => record(value)?.kind === input.kind)
    .length;
};

const parseStop = (
  value: unknown,
  input: {
    readonly lineage: M6AdapterBuildCompatibilityLineageV1;
    readonly runtimeId: string;
    readonly executionId: string;
  },
): {
  readonly cleanup: ProjectRuntimeCleanupReceiptV1;
  readonly coverage: readonly ProjectObservationCoverageV1[];
  readonly loss: readonly ProjectObservationLossV1[];
} | null => {
  const response = record(value);
  if (response?.outcome !== "success") return null;
  const output = record(response.output);
  if (output === null) return null;
  if (
    output.taskId !== input.lineage.build.taskId ||
    output.runtimeId !== input.runtimeId ||
    output.executionId !== input.executionId
  ) {
    throw new M6AdapterBuildCompatibilityIdentityError(
      "M6 compatibility stop crossed its Task, Runtime, or Execution binding",
    );
  }
  if (!Array.isArray(output.coverage) || !Array.isArray(output.loss)) {
    throw new M6AdapterBuildCompatibilityIdentityError(
      "M6 compatibility stop omitted coverage or loss",
    );
  }
  return {
    cleanup: ProjectRuntimeCleanupReceiptV1Schema.parse(output.cleanup),
    coverage: output.coverage.map((entry) =>
      ProjectObservationCoverageV1Schema.parse(entry),
    ),
    loss: output.loss.map((entry) =>
      ProjectObservationLossV1Schema.parse(entry),
    ),
  };
};

/**
 * Runs the existing Task-bound ProjectAdapter runtime against one exact Build,
 * then projects only adapter/build/toolchain lineage into the M6 receipt. Any
 * EnvironmentRevision identity carried internally by the PE-A runtime is not
 * adopted as the mutant or candidate source identity.
 */
export async function runM6AdapterBuildCompatibilityV1(input: {
  readonly lineage: unknown;
  readonly runtime: CompatibilityRuntimeV1;
  readonly launchTargetId: string;
  readonly now?: () => string;
}): Promise<{
  readonly pendingBinding: Extract<
    M6AdapterBuildCompatibilityBindingV1,
    { readonly compatibilityStatus: "pending" }
  >;
  readonly receipt: M6AdapterBuildCompatibilityReceiptV1;
  readonly binding: Extract<
    M6AdapterBuildCompatibilityBindingV1,
    { readonly compatibilityStatus: "compatible" | "incompatible" }
  >;
}> {
  const lineage = M6AdapterBuildCompatibilityLineageV1Schema.parse(
    input.lineage,
  );
  assertRuntimeIdentity(input.runtime, lineage);
  const now = input.now ?? (() => new Date().toISOString());
  const pendingBinding = createPendingM6AdapterBuildBindingV1({
    lineage,
    now: now(),
  });
  const failures: string[] = [];
  let bridgeHandshakeObserved = false;
  let instrumentedLaunchObserved = false;
  let entityRows = 0;
  let stateRows = 0;
  let entityQueryObserved = false;
  let stateQueryObserved = false;
  let cleanup = unavailableCleanup();
  let coverage = unavailableCoverage();
  let loss: readonly ProjectObservationLossV1[] = [];
  let identityFailure: M6AdapterBuildCompatibilityIdentityError | undefined;
  let launched: SuccessfulLaunchV1 | null = null;

  try {
    let launch: unknown;
    try {
      launch = await input.runtime.invoke({
        schemaVersion: 1,
        toolCallId: "m6-compatibility-launch",
        toolName: "game_launch",
        input: {
          schemaVersion: 1,
          taskId: lineage.build.taskId,
          buildId: lineage.build.buildId,
          launchTargetId: input.launchTargetId,
          parameters: {},
        },
      });
      launched = validateLaunchIdentity(launch, lineage);
      bridgeHandshakeObserved = launched !== null;
      instrumentedLaunchObserved = launched !== null;
      if (launched === null) {
        failures.push(
          errorMessage(launch, "Instrumented compatibility launch failed."),
        );
      }
    } catch (error) {
      if (error instanceof M6AdapterBuildCompatibilityIdentityError)
        identityFailure = error;
      else
        failures.push(
          error instanceof Error
            ? error.message.slice(0, 4_096)
            : "Instrumented compatibility launch failed.",
        );
    }

    if (launched !== null && identityFailure === undefined) {
      try {
        const entities = await input.runtime.invoke({
          schemaVersion: 1,
          toolCallId: "m6-compatibility-query-entities",
          toolName: "game_query",
          input: {
            schemaVersion: 1,
            taskId: lineage.build.taskId,
            executionId: launched.executionId,
            select: "entities",
            limit: 200,
          },
        });
        const rows = queryRows(entities, {
          lineage,
          executionId: launched.executionId,
          kind: "entity",
        });
        entityQueryObserved = rows !== null;
        entityRows = rows ?? 0;
        if (rows === null || rows === 0) {
          failures.push(
            errorMessage(
              entities,
              "Instrumented compatibility entity query returned no rows.",
            ),
          );
        }
      } catch (error) {
        if (error instanceof M6AdapterBuildCompatibilityIdentityError)
          identityFailure = error;
        else
          failures.push(
            error instanceof Error
              ? error.message.slice(0, 4_096)
              : "Instrumented compatibility entity query failed.",
          );
      }

      if (identityFailure === undefined) {
        try {
          const state = await input.runtime.invoke({
            schemaVersion: 1,
            toolCallId: "m6-compatibility-query-state",
            toolName: "game_query",
            input: {
              schemaVersion: 1,
              taskId: lineage.build.taskId,
              executionId: launched.executionId,
              select: "state",
              limit: 200,
            },
          });
          const rows = queryRows(state, {
            lineage,
            executionId: launched.executionId,
            kind: "state",
          });
          stateQueryObserved = rows !== null;
          stateRows = rows ?? 0;
          if (rows === null || rows === 0) {
            failures.push(
              errorMessage(
                state,
                "Instrumented compatibility state query returned no rows.",
              ),
            );
          }
        } catch (error) {
          if (error instanceof M6AdapterBuildCompatibilityIdentityError)
            identityFailure = error;
          else
            failures.push(
              error instanceof Error
                ? error.message.slice(0, 4_096)
                : "Instrumented compatibility state query failed.",
            );
        }
      }

      try {
        const stopped = await input.runtime.invoke({
          schemaVersion: 1,
          toolCallId: "m6-compatibility-stop",
          toolName: "game_stop",
          input: {
            schemaVersion: 1,
            taskId: lineage.build.taskId,
            runtimeId: launched.runtimeId,
          },
        });
        const parsed = parseStop(stopped, {
          lineage,
          runtimeId: launched.runtimeId,
          executionId: launched.executionId,
        });
        if (parsed === null) {
          failures.push(
            errorMessage(stopped, "Instrumented compatibility cleanup failed."),
          );
        } else {
          cleanup = parsed.cleanup;
          coverage = parsed.coverage;
          loss = parsed.loss;
        }
      } catch (error) {
        if (error instanceof M6AdapterBuildCompatibilityIdentityError)
          identityFailure = error;
        else
          failures.push(
            error instanceof Error
              ? error.message.slice(0, 4_096)
              : "Instrumented compatibility cleanup failed.",
          );
      }
    }
  } finally {
    try {
      await input.runtime.close();
    } catch (error) {
      failures.push(
        error instanceof Error
          ? `Runtime close failed: ${error.message}`.slice(0, 4_096)
          : "Runtime close failed.",
      );
    }
  }

  if (identityFailure !== undefined) throw identityFailure;
  if (!projectRuntimeCleanupCompleteV1(cleanup)) {
    failures.push("Instrumented compatibility cleanup was incomplete.");
  }
  if (
    !coverage.every(
      (entry) =>
        entry.status === "complete" &&
        entry.observedRecords > 0 &&
        entry.droppedRecords === 0 &&
        entry.overwrittenRecords === 0,
    )
  ) {
    failures.push("Instrumented compatibility coverage was incomplete.");
  }
  if (loss.length > 0) {
    failures.push(
      "Instrumented compatibility runtime reported observation loss.",
    );
  }
  const uniqueFailures = [...new Set(failures)];
  const observedAt = now();
  const receiptContent = {
    schemaVersion: 1 as const,
    lineage,
    bridgeHandshakeObserved,
    instrumentedLaunchObserved,
    queryObservations: {
      schemaVersion: 1 as const,
      entityQueryObserved,
      stateQueryObserved,
      entityRows,
      stateRows,
    },
    coverage,
    loss,
    cleanup,
    outcome:
      uniqueFailures.length === 0
        ? ("compatible" as const)
        : ("incompatible" as const),
    failures: uniqueFailures,
    observedAt,
  };
  const receipt = M6AdapterBuildCompatibilityReceiptV1Schema.parse({
    ...receiptContent,
    receiptId: asM6AdapterBuildCompatibilityReceiptId(
      `m6-adapter-build-compatibility:v1:${hashValue(receiptContent)}`,
    ),
  });
  const binding = M6AdapterBuildCompatibilityBindingV1Schema.parse({
    ...pendingBinding,
    compatibilityStatus: receipt.outcome,
    compatibilityReceiptId: receipt.receiptId,
    completedAt: observedAt,
  }) as Extract<
    M6AdapterBuildCompatibilityBindingV1,
    { readonly compatibilityStatus: "compatible" | "incompatible" }
  >;
  return Object.freeze({ pendingBinding, receipt, binding });
}
