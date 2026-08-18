import { createHash, randomUUID } from "node:crypto";
import { lstat, readdir, realpath, rmdir } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";

import {
  validateProjectEnvironmentGameToolInputV1,
  validateProjectEnvironmentGameToolOutputV1,
  type ProjectEnvironmentGameCapturePinInputV1,
  type ProjectEnvironmentGameCapturePinOutputV1,
  type ProjectEnvironmentGameLaunchInputV1,
  type ProjectEnvironmentGameLaunchOutputV1,
  type ProjectEnvironmentGameQueryInputV1,
  type ProjectEnvironmentGameQueryOutputV1,
  type ProjectEnvironmentGameStopInputV1,
  type ProjectEnvironmentGameStopOutputV1,
} from "@chronorift/agent-protocol";
import {
  JsonValueSchema,
  ProjectAdapterRevisionV1Schema,
  ProjectEnvironmentPinnedCaptureV1Schema,
  ProjectEnvironmentRuntimeObservationReceiptV1Schema,
  ProjectToolchainReceiptV1Schema,
  VNextBuildV1Schema,
  asProjectEnvironmentTaskId,
  asProjectToolchainReceiptId,
  asSha256DigestV1,
  asTaskId,
  asWorkspaceId,
  type JsonValue,
  type ProjectAdapterRevisionV1,
  type ProjectEnvironmentPinnedCaptureV1,
  type ProjectEnvironmentRuntimeObservationReceiptV1,
  type Sha256DigestV1,
} from "@chronorift/domain";
import {
  GodotProjectEnvironmentFingerprintV1Schema,
  GodotProjectEnvironmentObservationRecordV1Schema,
  type GodotProjectEnvironmentFingerprintV1,
} from "@chronorift/godot-protocol";
import {
  loadProjectAdapterPackageFilesV1,
  type LoadedProjectAdapterPackageV1,
  type ProjectAdapterPackageBytesV1,
} from "@chronorift/godot-adapter";
import {
  ProjectEnvironmentTaskStoreV1,
  canonicalJson,
  contentHash,
} from "@chronorift/json-artifacts";
import type { ProjectEnvironmentGameToolPort } from "@chronorift/pi-harness";

import {
  M6ExactBuildRuntimeIdentityV1Schema,
  prepareM6ExactGodotBuildV1,
  type PreparedM6ExactGodotBuildV1,
} from "./m6-exact-godot-build.js";
import { preflightManagedGodotProjectEnvironmentRuntimeV1 } from "./managed-godot-project-environment-runtime-preflight.js";
import type { ManagedGodotProjectEnvironmentRuntimePreflightResultV1 } from "./managed-godot-project-environment-runtime-preflight.js";
/*
 * The imported seal constructor names its narrow provenance explicitly. It
 * summarizes pinned-capture record bytes and is not a RuntimeStore seal.
 */
import {
  createM7R3HostDerivedCaptureRecordSealV1,
  type M7R3HostDerivedCaptureRecordSealV1,
  type M7R3NoAgentProjectEnvironmentPreflightPortV1,
  type M7R3NoAgentProjectEnvironmentObservationV1,
  type M7R3NoAgentPublicObservationRequestV1,
} from "./m7-r3-case-preflight-runner.js";
import { M7_PATROL_TRAJECTORY_CLASSIFIER_CONFIG_V1 } from "./m7-patrol-trajectory.js";
import {
  ProjectEnvironmentGameRuntimeV1,
  type ProjectEnvironmentGameRuntimeOptionsV1,
} from "./project-environment-game-runtime.js";
import {
  readProjectEnvironmentHostConfigV1,
  resolveProjectEnvironmentGodotToolchainV1,
  type ProjectEnvironmentToolchainReceiptV1,
} from "./project-environment-host-config.js";
import { GodotProjectEnvironmentSidecarPortV1 } from "./project-environment-sidecar-port.js";
import {
  createDuplexBwrapCgroupTaskSandbox,
  type DuplexTaskSandboxBrokerV1,
} from "./sandbox-broker.js";
import { createSandboxPolicyV2 } from "./sandbox-policy.js";
import {
  SANDBOX_TASK_STORAGE_MINIMUM_HEADROOM_BYTES_V1,
  SANDBOX_TASK_STORAGE_MINIMUM_HEADROOM_INODES_V1,
  assertSandboxTaskStorageHeadroomV1,
  createSandboxTaskRuntimeRoot,
  preflightSandboxHost,
  type SandboxTaskStorageHeadroomV1,
} from "./sandbox-preflight.js";
import { inspectSandboxToolchain } from "./sandbox-toolchain.js";
import type { VerifiedProjectEnvironmentSourceV1 } from "./source-preflight.js";
import {
  createProjectEnvironmentTaskDirectoryLayout,
  type ProjectEnvironmentTaskDirectoryLayout,
} from "./task-paths.js";
import {
  materializePrivateTaskWorkspace,
  type MaterializedProjectEnvironmentWorkspaceV1,
} from "./workspace-materializer.js";
import {
  SandboxCleanupReceiptV1Schema,
  SecurityEventV1Schema,
  type SandboxCleanupReceiptV1,
  type SecurityEventV1,
} from "./contracts.js";

type Subject = "pristine" | "mutant";

const STATE_QUERY_COUNT = 6;
const STATE_QUERY_INTERVAL_MS = 1_000;
const MINIMUM_DISTINCT_STATE_SAMPLES =
  M7_PATROL_TRAJECTORY_CLASSIFIER_CONFIG_V1.sustainedGroundedSampleCountMinimum;

export interface M7R3NoAgentAdapterPackageIdentityV1 {
  readonly schemaVersion: 1;
  readonly packageSha256: Sha256DigestV1;
  readonly manifestSha256: Sha256DigestV1;
  readonly implementationSha256: Sha256DigestV1;
  readonly observationSchemaSha256: Sha256DigestV1;
  readonly adapterId: string;
  readonly contentByteLength: number;
  readonly contentFileCount: number;
}

const digestJson = (value: unknown): Sha256DigestV1 =>
  asSha256DigestV1(contentHash(JsonValueSchema.parse(value)));

const sameJson = (left: unknown, right: unknown): boolean =>
  canonicalJson(JsonValueSchema.parse(left)) ===
  canonicalJson(JsonValueSchema.parse(right));

const asError = (value: unknown, fallback: string): Error =>
  value instanceof Error ? value : new Error(fallback, { cause: value });

const waitForStateSampleInterval = (): Promise<void> =>
  new Promise((resolveWait) => {
    setTimeout(resolveWait, STATE_QUERY_INTERVAL_MS);
  });

const distinctStateSampleCount = (
  queries: readonly {
    readonly output: ProjectEnvironmentGameQueryOutputV1;
  }[],
): number => {
  const sequences = new Set<number>();
  for (const query of queries) {
    for (const row of query.output.rows) {
      const record = GodotProjectEnvironmentObservationRecordV1Schema.safeParse(
        row.value,
      );
      if (record.success && record.data.kind === "state_sample") {
        sequences.add(record.data.recordSequence);
      }
    }
  }
  return sequences.size;
};

const cleanupComplete = (receipt: SandboxCleanupReceiptV1): boolean =>
  receipt.processGroupTerminated &&
  !receipt.cgroupPopulated &&
  receipt.scopeRemoved &&
  receipt.storageReconciled === true;

const managedRuntimeTargets = (
  runtime: ManagedGodotProjectEnvironmentRuntimePreflightResultV1,
): readonly string[] => [
  ...runtime.capability.toolchain.files.map((file) => file.target),
  runtime.capability.fontconfigTarget,
  runtime.capability.addonParentTarget,
  runtime.capability.addonTarget,
  runtime.capability.overlayTarget,
  runtime.capability.adapterParentTarget,
  runtime.capability.adapterTarget,
];

const hashText = (value: string): Sha256DigestV1 =>
  asSha256DigestV1(createHash("sha256").update(value).digest("hex"));

const loadedAdapterIdentity = (
  loaded: LoadedProjectAdapterPackageV1,
): M7R3NoAgentAdapterPackageIdentityV1 =>
  Object.freeze({
    schemaVersion: 1,
    packageSha256: asSha256DigestV1(loaded.candidateSha256),
    manifestSha256: asSha256DigestV1(loaded.manifestSha256),
    implementationSha256: hashText(
      `project-adapter-implementation-v1\0${loaded.files
        .filter((file) => file.path.endsWith(".gd"))
        .map((file) => `${file.path}:${file.sha256}`)
        .join("\n")}`,
    ),
    observationSchemaSha256: hashText(
      `project-adapter-payload-schemas-v1\0${loaded.manifest.schemas
        .map((schema) => `${schema.schemaId}:${schema.sha256}`)
        .join("\n")}`,
    ),
    adapterId: loaded.manifest.adapterId,
    contentByteLength: loaded.totalBytes,
    contentFileCount: loaded.files.length,
  });

const toolchainReceipt = (
  toolchain: ProjectEnvironmentToolchainReceiptV1,
  requestedVersion: VerifiedProjectEnvironmentSourceV1["requestedGodotVersion"],
  observedAt: string,
) => {
  const identity = {
    schemaVersion: 1 as const,
    requested: {
      schemaVersion: 1 as const,
      engineFamily: "godot" as const,
      versionRequirement: requestedVersion,
      platform: "linux-x86_64",
      requiredFeatures: [...toolchain.buildFeatures],
    },
    status: "realized" as const,
    realized: {
      schemaVersion: 1 as const,
      engineFamily: "godot" as const,
      version: toolchain.realizedVersion,
      platform: toolchain.platform,
      artifactDigest: toolchain.executableSha256,
      features: [...toolchain.buildFeatures],
      renderer: toolchain.renderer,
    },
    limitations: [] as const,
  };
  return ProjectToolchainReceiptV1Schema.parse({
    ...identity,
    receiptId: asProjectToolchainReceiptId(
      `toolchain-receipt:v1:${contentHash(identity as never)}`,
    ),
    observedAt,
  });
};

interface M7R3NoAgentRuntimeV1 extends ProjectEnvironmentGameToolPort {
  activeFingerprint(): GodotProjectEnvironmentFingerprintV1;
  close(): Promise<void>;
}

export interface M7R3PreparedNoAgentProjectEnvironmentSubjectV1 {
  readonly subject: Subject;
  readonly taskId: string;
  readonly workspaceId: string;
  readonly sourceSelectedTreeSha256: Sha256DigestV1;
  readonly exactBuild: PreparedM6ExactGodotBuildV1;
  readonly adapterRevision: ProjectAdapterRevisionV1;
  readonly adapterPackageIdentity: M7R3NoAgentAdapterPackageIdentityV1;
  readonly environmentRevisionId: string;
  readonly launchTargetId: string;
  readonly assertTaskStorageHeadroom: () => Promise<SandboxTaskStorageHeadroomV1>;
  readonly createRuntimeOnce: (input: {
    readonly persistPinnedCapture: (
      capture: ProjectEnvironmentPinnedCaptureV1,
      records: readonly JsonValue[],
    ) => Promise<void>;
    readonly persistRuntimeObservation: (
      receipt: ProjectEnvironmentRuntimeObservationReceiptV1,
    ) => Promise<void>;
  }) => M7R3NoAgentRuntimeV1;
  readonly cleanupTask: () => Promise<unknown>;
  readonly readSecurityEvents: () => readonly SecurityEventV1[];
}

export interface M7R3NoAgentProjectEnvironmentPreflightCleanupV1 {
  readonly schemaVersion: 1;
  readonly cleanupProven: boolean;
  readonly subjects: Readonly<
    Record<
      Subject,
      {
        readonly attempted: boolean;
        readonly cleanupProven: boolean;
        readonly cleanupReceipt: SandboxCleanupReceiptV1 | null;
        readonly cleanupReceiptSha256: Sha256DigestV1 | null;
        readonly securityEvents: readonly SecurityEventV1[];
        readonly securityEventsSha256: Sha256DigestV1;
      }
    >
  >;
}

export interface PreparedM7R3NoAgentProjectEnvironmentPreflightPortV1 {
  readonly configuredMainScene: string;
  readonly assertTaskStorageHeadroom: () => Promise<SandboxTaskStorageHeadroomV1>;
  readonly projectEnvironment: Omit<
    M7R3NoAgentProjectEnvironmentPreflightPortV1,
    "observeConfiguredMainScene"
  > & {
    observeConfiguredMainScene(
      request: M7R3NoAgentPublicObservationRequestV1,
    ): Promise<M7R3NoAgentProjectEnvironmentObservationV1>;
  };
  cleanup(): Promise<M7R3NoAgentProjectEnvironmentPreflightCleanupV1>;
}

const responseRecord = (value: unknown): Readonly<Record<string, unknown>> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("M7 R3 Project Environment tool response is invalid");
  }
  return value as Readonly<Record<string, unknown>>;
};

const exactToolInput = <Input>(
  toolName: "game_launch" | "game_query" | "game_capture_pin" | "game_stop",
  value: unknown,
): Input => {
  if (!validateProjectEnvironmentGameToolInputV1(toolName, value)) {
    throw new TypeError(`M7 R3 ${toolName} input is invalid`);
  }
  return value as Input;
};

const invokeExact = async <Input, Output>(input: {
  readonly runtime: M7R3NoAgentRuntimeV1;
  readonly toolCallId: string;
  readonly toolName:
    "game_launch" | "game_query" | "game_capture_pin" | "game_stop";
  readonly request: Input;
}): Promise<Output> => {
  if (
    !validateProjectEnvironmentGameToolInputV1(input.toolName, input.request)
  ) {
    throw new TypeError(`M7 R3 ${input.toolName} input is invalid`);
  }
  const response = responseRecord(
    await input.runtime.invoke({
      schemaVersion: 1,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      input: input.request,
    }),
  );
  if (
    response.schemaVersion !== 1 ||
    response.toolCallId !== input.toolCallId ||
    response.outcome !== "success" ||
    !validateProjectEnvironmentGameToolOutputV1(input.toolName, response.output)
  ) {
    throw new Error(`M7 R3 ${input.toolName} did not return exact success`);
  }
  return response.output as Output;
};

const runtimeFingerprintMatches = (input: {
  readonly fingerprint: GodotProjectEnvironmentFingerprintV1;
  readonly subject: M7R3PreparedNoAgentProjectEnvironmentSubjectV1;
  readonly launch: ProjectEnvironmentGameLaunchOutputV1;
}): boolean => {
  const { fingerprint, subject, launch } = input;
  const build = subject.exactBuild.build;
  return (
    fingerprint.configuredMainScene ===
      subject.exactBuild.configuredMainScene &&
    fingerprint.identity.taskId === subject.taskId &&
    fingerprint.identity.sourceClosureId === build.sourceId &&
    fingerprint.identity.environmentRevisionId ===
      subject.environmentRevisionId &&
    fingerprint.identity.adapterRevisionId ===
      subject.adapterRevision.adapterRevisionId &&
    fingerprint.identity.buildId === build.buildId &&
    fingerprint.identity.runtimeId === launch.runtimeId &&
    fingerprint.identity.executionId === launch.executionId &&
    fingerprint.identity.candidateSourceHash === build.sourceHash &&
    fingerprint.identity.adapterManifestSha256 ===
      subject.adapterRevision.manifestDigest &&
    fingerprint.identity.sdkSha256 === subject.adapterRevision.sdkDigest &&
    fingerprint.identity.bridgeSha256 ===
      subject.adapterRevision.bridgeDigest &&
    fingerprint.identity.toolchainSha256 ===
      subject.exactBuild.toolchainArtifactDigest
  );
};

interface CleanupAttempt {
  readonly attempted: boolean;
  readonly cleanupProven: boolean;
  readonly cleanupReceipt: SandboxCleanupReceiptV1 | null;
  readonly cleanupReceiptSha256: Sha256DigestV1 | null;
  readonly securityEvents: readonly SecurityEventV1[];
  readonly securityEventsSha256: Sha256DigestV1;
  readonly error: Error | null;
}

/**
 * Creates the strict one-case port from two already isolated Host subjects.
 * This seam is also what focused offline tests fake; production preparation
 * below creates both subjects from separate clean Task namespaces.
 */
export function createM7R3NoAgentProjectEnvironmentPreflightPortV1(input: {
  readonly ordinal: 1 | 2;
  readonly pristine: M7R3PreparedNoAgentProjectEnvironmentSubjectV1;
  readonly mutant: M7R3PreparedNoAgentProjectEnvironmentSubjectV1;
}): PreparedM7R3NoAgentProjectEnvironmentPreflightPortV1 {
  const pristineBuild = VNextBuildV1Schema.parse(
    input.pristine.exactBuild.build,
  );
  const mutantBuild = VNextBuildV1Schema.parse(input.mutant.exactBuild.build);
  if (
    input.pristine.subject !== "pristine" ||
    input.mutant.subject !== "mutant" ||
    input.pristine.taskId === input.mutant.taskId ||
    input.pristine.workspaceId === input.mutant.workspaceId ||
    pristineBuild.sourceId === mutantBuild.sourceId ||
    pristineBuild.sourceHash === mutantBuild.sourceHash ||
    pristineBuild.buildId === mutantBuild.buildId ||
    input.pristine.environmentRevisionId ===
      input.mutant.environmentRevisionId ||
    !sameJson(input.pristine.adapterRevision, input.mutant.adapterRevision) ||
    !sameJson(
      input.pristine.adapterPackageIdentity,
      input.mutant.adapterPackageIdentity,
    ) ||
    input.pristine.exactBuild.toolchainArtifactDigest !==
      input.mutant.exactBuild.toolchainArtifactDigest ||
    !sameJson(
      input.pristine.exactBuild.runtimeIdentity,
      input.mutant.exactBuild.runtimeIdentity,
    ) ||
    input.pristine.exactBuild.policyProfileDigest !==
      input.mutant.exactBuild.policyProfileDigest ||
    input.pristine.exactBuild.configuredMainScene !==
      input.mutant.exactBuild.configuredMainScene
  ) {
    throw new TypeError(
      "M7 R3 preflight requires distinct pristine/mutant Source, Build, Task, runtime namespace with one exact Adapter, toolchain, runtime, policy, and main scene",
    );
  }
  const subjects = {
    pristine: input.pristine,
    mutant: input.mutant,
  } as const;
  const expectedOrder = ["pristine", "mutant"] as const;
  let nextSubject = 0;
  const cleanupAttempts: Record<Subject, Promise<CleanupAttempt> | null> = {
    pristine: null,
    mutant: null,
  };
  const cleanupSubject = (subject: Subject): Promise<CleanupAttempt> => {
    cleanupAttempts[subject] ??= (async () => {
      let securityEvents: readonly SecurityEventV1[];
      try {
        securityEvents = Object.freeze(
          subjects[subject]
            .readSecurityEvents()
            .map((event) => SecurityEventV1Schema.parse(event)),
        );
      } catch (error) {
        return Object.freeze({
          attempted: true,
          cleanupProven: false,
          cleanupReceipt: null,
          cleanupReceiptSha256: null,
          securityEvents: Object.freeze([]),
          securityEventsSha256: digestJson([]),
          error: asError(
            error,
            "M7 R3 no-Agent security-event audit read failed",
          ),
        });
      }
      const securityEventsSha256 = digestJson(securityEvents);
      try {
        const receipt = SandboxCleanupReceiptV1Schema.parse(
          await subjects[subject].cleanupTask(),
        );
        return Object.freeze({
          attempted: true,
          cleanupProven: cleanupComplete(receipt),
          cleanupReceipt: receipt,
          cleanupReceiptSha256: digestJson(receipt),
          securityEvents,
          securityEventsSha256,
          error: null,
        });
      } catch (error) {
        return Object.freeze({
          attempted: true,
          cleanupProven: false,
          cleanupReceipt: null,
          cleanupReceiptSha256: null,
          securityEvents,
          securityEventsSha256,
          error: asError(error, "M7 R3 no-Agent Task cleanup failed"),
        });
      }
    })();
    return cleanupAttempts[subject];
  };

  const observeSubject = async (
    request: M7R3NoAgentPublicObservationRequestV1,
  ): Promise<M7R3NoAgentProjectEnvironmentObservationV1> => {
    const expectedSubject = expectedOrder[nextSubject];
    if (
      request.schemaVersion !== 1 ||
      request.ordinal !== input.ordinal ||
      request.subject !== expectedSubject
    ) {
      throw new TypeError(
        "M7 R3 Project Environment preflight must run pristine then mutant exactly once",
      );
    }
    const subject = subjects[request.subject];
    const build = VNextBuildV1Schema.parse(subject.exactBuild.build);
    if (
      request.buildRole !==
        (request.subject === "pristine"
          ? "pristine_control"
          : "assignment_baseline") ||
      request.configuredMainScene !== subject.exactBuild.configuredMainScene ||
      request.expectedSource.sourceId !== build.sourceId ||
      request.expectedSource.sourceSha256 !== build.sourceHash ||
      request.expectedSource.selectedTreeSha256 !==
        subject.sourceSelectedTreeSha256 ||
      (request.expectedSource.buildId !== null &&
        request.expectedSource.buildId !== build.buildId) ||
      build.taskId !== subject.taskId ||
      build.workspaceId !== subject.workspaceId ||
      subject.sourceSelectedTreeSha256 !== build.sourceHash ||
      subject.exactBuild.adapterRevision.adapterRevisionId !==
        subject.adapterRevision.adapterRevisionId
    ) {
      throw new TypeError(
        "M7 R3 Project Environment subject crossed its exact Source, Build, Task, or Adapter lineage",
      );
    }

    const captures: Array<{
      readonly manifest: ProjectEnvironmentPinnedCaptureV1;
      readonly records: readonly JsonValue[];
    }> = [];
    const runtimeReceipts: ProjectEnvironmentRuntimeObservationReceiptV1[] = [];
    let runtime: M7R3NoAgentRuntimeV1 | undefined;
    let runtimeEvidence:
      | Omit<
          M7R3NoAgentProjectEnvironmentObservationV1,
          | "taskCleanupReceipt"
          | "taskCleanupReceiptSha256"
          | "sandboxSecurityEvents"
          | "sandboxSecurityEventsSha256"
        >
      | undefined;
    let primaryFailure: Error | undefined;
    try {
      await subject.assertTaskStorageHeadroom();
      runtime = subject.createRuntimeOnce({
        persistPinnedCapture: (captureInput, recordInputs) => {
          const manifest =
            ProjectEnvironmentPinnedCaptureV1Schema.parse(captureInput);
          const records = recordInputs.map((record) =>
            JsonValueSchema.parse(record),
          );
          captures.push(
            Object.freeze({ manifest, records: Object.freeze(records) }),
          );
          return Promise.resolve();
        },
        persistRuntimeObservation: (receiptInput) => {
          runtimeReceipts.push(
            ProjectEnvironmentRuntimeObservationReceiptV1Schema.parse(
              receiptInput,
            ),
          );
          return Promise.resolve();
        },
      });
      const launchInput: ProjectEnvironmentGameLaunchInputV1 = {
        schemaVersion: 1,
        taskId: subject.taskId,
        buildId: build.buildId,
        launchTargetId: subject.launchTargetId,
        parameters: {},
      };
      const launchOutput = await invokeExact<
        ProjectEnvironmentGameLaunchInputV1,
        ProjectEnvironmentGameLaunchOutputV1
      >({
        runtime,
        toolCallId: `m7-r3-preflight-${input.ordinal}-${request.subject}-launch`,
        toolName: "game_launch",
        request: launchInput,
      });
      const fingerprint = GodotProjectEnvironmentFingerprintV1Schema.parse(
        runtime.activeFingerprint(),
      );
      if (
        launchOutput.taskId !== subject.taskId ||
        launchOutput.buildId !== build.buildId ||
        launchOutput.environmentRevisionId !== subject.environmentRevisionId ||
        launchOutput.adapterRevisionId !==
          subject.adapterRevision.adapterRevisionId ||
        !runtimeFingerprintMatches({
          fingerprint,
          subject,
          launch: launchOutput,
        })
      ) {
        throw new TypeError(
          "M7 R3 launch or handshake fingerprint crossed exact subject lineage",
        );
      }

      await invokeExact<
        ProjectEnvironmentGameQueryInputV1,
        ProjectEnvironmentGameQueryOutputV1
      >({
        runtime,
        toolCallId: `m7-r3-preflight-${input.ordinal}-${request.subject}-query-entities`,
        toolName: "game_query",
        request: exactToolInput<ProjectEnvironmentGameQueryInputV1>(
          "game_query",
          {
            schemaVersion: 1,
            taskId: subject.taskId,
            executionId: launchOutput.executionId,
            select: "entities",
            limit: 200,
          },
        ),
      });
      const stateQueries: Array<{
        readonly input: ProjectEnvironmentGameQueryInputV1;
        readonly output: ProjectEnvironmentGameQueryOutputV1;
      }> = [];
      for (
        let queryOrdinal = 1;
        queryOrdinal <= STATE_QUERY_COUNT;
        queryOrdinal += 1
      ) {
        if (queryOrdinal > 1) {
          await waitForStateSampleInterval();
        }
        const queryInput = exactToolInput<ProjectEnvironmentGameQueryInputV1>(
          "game_query",
          {
            schemaVersion: 1,
            taskId: subject.taskId,
            executionId: launchOutput.executionId,
            select: "state",
            limit: 200,
          },
        );
        const queryOutput = await invokeExact<
          ProjectEnvironmentGameQueryInputV1,
          ProjectEnvironmentGameQueryOutputV1
        >({
          runtime,
          toolCallId: `m7-r3-preflight-${input.ordinal}-${request.subject}-query-state-${queryOrdinal}`,
          toolName: "game_query",
          request: queryInput,
        });
        stateQueries.push({ input: queryInput, output: queryOutput });
      }
      if (
        distinctStateSampleCount(stateQueries) < MINIMUM_DISTINCT_STATE_SAMPLES
      ) {
        throw new Error(
          `M7 R3 fixed public observation window exposed fewer than ${MINIMUM_DISTINCT_STATE_SAMPLES} distinct state samples`,
        );
      }
      const pinInput: ProjectEnvironmentGameCapturePinInputV1 = {
        schemaVersion: 1,
        taskId: subject.taskId,
        runtimeId: launchOutput.runtimeId,
        anchor: { kind: "now" },
        before: 0,
        after: 0,
      };
      const pinOutput = await invokeExact<
        ProjectEnvironmentGameCapturePinInputV1,
        ProjectEnvironmentGameCapturePinOutputV1
      >({
        runtime,
        toolCallId: `m7-r3-preflight-${input.ordinal}-${request.subject}-pin`,
        toolName: "game_capture_pin",
        request: pinInput,
      });
      const stopInput: ProjectEnvironmentGameStopInputV1 = {
        schemaVersion: 1,
        taskId: subject.taskId,
        runtimeId: launchOutput.runtimeId,
      };
      const stopOutput = await invokeExact<
        ProjectEnvironmentGameStopInputV1,
        ProjectEnvironmentGameStopOutputV1
      >({
        runtime,
        toolCallId: `m7-r3-preflight-${input.ordinal}-${request.subject}-stop`,
        toolName: "game_stop",
        request: stopInput,
      });
      if (
        captures.length !== 1 ||
        runtimeReceipts.length !== 1 ||
        captures[0]!.manifest.captureWindowId !== pinOutput.captureWindowId
      ) {
        throw new Error(
          "M7 R3 preflight did not durably retain one exact capture and runtime receipt",
        );
      }
      const runtimeReceipt = runtimeReceipts[0]!;
      const captureRecordSeal: M7R3HostDerivedCaptureRecordSealV1 =
        createM7R3HostDerivedCaptureRecordSealV1({
          taskId: subject.taskId,
          executionId: launchOutput.executionId,
          records: captures.flatMap((capture) => capture.records),
        });
      runtimeEvidence = {
        schemaVersion: 1,
        configuredMainScene: subject.exactBuild.configuredMainScene,
        build,
        selectedTreeSha256: subject.sourceSelectedTreeSha256,
        adapterRevision: subject.adapterRevision,
        adapterPackageIdentity: subject.adapterPackageIdentity,
        fingerprint,
        launch: { input: launchInput, output: launchOutput },
        stateQueries,
        capturePins: [{ input: pinInput, output: pinOutput }],
        pinnedCaptures: captures.map((capture) => ({
          manifest: capture.manifest,
          records: capture.records,
        })),
        stop: { input: stopInput, output: stopOutput },
        runtimeObservationReceipt: runtimeReceipt,
        captureRecordSeal,
        agentLaunchCount: 0,
        providerInvocationCount: 0,
        piSessionCount: 0,
      };
    } catch (error) {
      primaryFailure = asError(
        error,
        "M7 R3 no-Agent Project Environment observation failed",
      );
    }
    if (runtime !== undefined) {
      try {
        await runtime.close();
      } catch (error) {
        primaryFailure =
          primaryFailure === undefined
            ? asError(error, "M7 R3 no-Agent runtime close failed")
            : new AggregateError(
                [
                  primaryFailure,
                  asError(error, "M7 R3 no-Agent runtime close failed"),
                ],
                "M7 R3 preflight operation and runtime close both failed",
              );
      }
    }
    const taskCleanup = await cleanupSubject(request.subject);
    if (!taskCleanup.cleanupProven) {
      const cleanupFailure =
        taskCleanup.error ??
        new Error(
          "M7 R3 no-Agent subject Task cleanup was not proven (receipt incomplete)",
        );
      primaryFailure =
        primaryFailure === undefined
          ? cleanupFailure
          : new AggregateError(
              [primaryFailure, cleanupFailure],
              "M7 R3 preflight operation and Task cleanup both failed",
            );
    }
    if (primaryFailure !== undefined) throw primaryFailure;
    if (runtimeEvidence === undefined || taskCleanup.cleanupReceipt === null) {
      throw new Error("M7 R3 preflight observation was not produced");
    }
    nextSubject += 1;
    return Object.freeze({
      ...runtimeEvidence,
      taskCleanupReceipt: taskCleanup.cleanupReceipt,
      taskCleanupReceiptSha256: taskCleanup.cleanupReceiptSha256,
      sandboxSecurityEvents: taskCleanup.securityEvents,
      sandboxSecurityEventsSha256: taskCleanup.securityEventsSha256,
    });
  };

  let terminalized = false;
  let activeObservation: Promise<M7R3NoAgentProjectEnvironmentObservationV1> | null =
    null;
  let cleanupPromise: Promise<M7R3NoAgentProjectEnvironmentPreflightCleanupV1> | null =
    null;
  const observe = (
    request: M7R3NoAgentPublicObservationRequestV1,
  ): Promise<M7R3NoAgentProjectEnvironmentObservationV1> => {
    if (terminalized) {
      return Promise.reject(
        new Error("M7 R3 no-Agent preflight is already terminalized"),
      );
    }
    if (activeObservation !== null) {
      return Promise.reject(
        new Error("M7 R3 no-Agent preflight observations cannot overlap"),
      );
    }
    const pending = observeSubject(request);
    activeObservation = pending;
    return pending.finally(() => {
      if (activeObservation === pending) activeObservation = null;
    });
  };
  const cleanup =
    (): Promise<M7R3NoAgentProjectEnvironmentPreflightCleanupV1> => {
      terminalized = true;
      cleanupPromise ??= (async () => {
        const active = activeObservation;
        if (active !== null) {
          try {
            await active;
          } catch {
            // The observation's own failure remains authoritative to its caller.
          }
        }
        const pristine = await cleanupSubject("pristine");
        const mutant = await cleanupSubject("mutant");
        return Object.freeze({
          schemaVersion: 1,
          cleanupProven: pristine.cleanupProven && mutant.cleanupProven,
          subjects: Object.freeze({
            pristine: Object.freeze({
              attempted: pristine.attempted,
              cleanupProven: pristine.cleanupProven,
              cleanupReceipt: pristine.cleanupReceipt,
              cleanupReceiptSha256: pristine.cleanupReceiptSha256,
              securityEvents: pristine.securityEvents,
              securityEventsSha256: pristine.securityEventsSha256,
            }),
            mutant: Object.freeze({
              attempted: mutant.attempted,
              cleanupProven: mutant.cleanupProven,
              cleanupReceipt: mutant.cleanupReceipt,
              cleanupReceiptSha256: mutant.cleanupReceiptSha256,
              securityEvents: mutant.securityEvents,
              securityEventsSha256: mutant.securityEventsSha256,
            }),
          }),
        });
      })();
      return cleanupPromise;
    };

  return Object.freeze({
    configuredMainScene: input.pristine.exactBuild.configuredMainScene,
    assertTaskStorageHeadroom: async () => {
      const [pristine, mutant] = await Promise.all([
        input.pristine.assertTaskStorageHeadroom(),
        input.mutant.assertTaskStorageHeadroom(),
      ]);
      return Object.freeze({
        schemaVersion: 1,
        availableBytes: Math.min(
          pristine.availableBytes,
          mutant.availableBytes,
        ),
        availableInodes: Math.min(
          pristine.availableInodes,
          mutant.availableInodes,
        ),
        requiredAvailableBytes: SANDBOX_TASK_STORAGE_MINIMUM_HEADROOM_BYTES_V1,
        requiredAvailableInodes:
          SANDBOX_TASK_STORAGE_MINIMUM_HEADROOM_INODES_V1,
      });
    },
    projectEnvironment: Object.freeze({
      observeConfiguredMainScene: observe,
    }),
    cleanup,
  });
}

export interface PrepareM7R3NoAgentProjectEnvironmentSubjectV1Input {
  readonly subject: Subject;
  readonly ordinal: 1 | 2;
  readonly source: VerifiedProjectEnvironmentSourceV1;
  readonly adapterFiles: readonly ProjectAdapterPackageBytesV1[];
  readonly adapterRevision: ProjectAdapterRevisionV1;
  readonly hostConfigPath?: string | undefined;
  readonly now: () => string;
}

export interface M7R3NoAgentProjectEnvironmentPreflightDependenciesV1 {
  readonly prepareSubject: (
    input: PrepareM7R3NoAgentProjectEnvironmentSubjectV1Input,
  ) => Promise<M7R3PreparedNoAgentProjectEnvironmentSubjectV1>;
}

const removeFreshEmptyTaskLayout = async (input: {
  readonly runtimeRoot: string;
  readonly layout: ProjectEnvironmentTaskDirectoryLayout;
}): Promise<SandboxCleanupReceiptV1> => {
  const runtimeRoot = await realpath(resolve(input.runtimeRoot));
  const taskRoot = await realpath(resolve(input.layout.taskRootDirectory));
  const difference = relative(runtimeRoot, taskRoot);
  if (
    difference === "" ||
    difference === ".." ||
    difference.startsWith(`..${sep}`) ||
    isAbsolute(difference) ||
    !/^tasks\/[a-f0-9]{64}$/u.test(difference.split(sep).join("/"))
  ) {
    throw new Error(
      "M7 R3 refused to clean a fresh Task layout outside its exact runtime namespace",
    );
  }
  const rootMetadata = await lstat(taskRoot);
  if (
    !rootMetadata.isDirectory() ||
    rootMetadata.isSymbolicLink() ||
    (rootMetadata.mode & 0o7777) !== 0o700
  ) {
    throw new Error("M7 R3 fresh Task root identity changed before cleanup");
  }
  const children = [
    input.layout.taskRecordDirectory,
    input.layout.runtimeRecordDirectory,
    input.layout.workspaceDirectory,
    input.layout.sandboxTemporaryDirectory,
    input.layout.sandboxArtifactScratchDirectory,
    input.layout.piSessionDirectory,
    input.layout.hostBaselineGitDirectory,
    input.layout.hostOperationTemporaryDirectory,
    input.layout.projectEnvironmentRecordDirectory,
  ].sort();
  const expectedNames = children.map((path) => basename(path)).sort();
  const actualNames = (await readdir(taskRoot)).sort();
  if (!sameJson(actualNames, expectedNames)) {
    throw new Error(
      "M7 R3 fresh Task layout gained unexpected resources before broker creation",
    );
  }
  for (const child of children) {
    const canonical = await realpath(resolve(child));
    const metadata = await lstat(canonical);
    if (
      relative(taskRoot, canonical) !== basename(canonical) ||
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      (metadata.mode & 0o7777) !== 0o700 ||
      (await readdir(canonical)).length !== 0
    ) {
      throw new Error(
        "M7 R3 fresh Task child changed before broker-creation cleanup",
      );
    }
  }
  for (const child of children) await rmdir(child);
  await rmdir(taskRoot);
  return SandboxCleanupReceiptV1Schema.parse({
    processGroupTerminated: true,
    cgroupPopulated: false,
    termSent: false,
    killSent: false,
    scopeRemoved: true,
    storageReconciled: true,
  });
};

const prepareProductionSubject = async (
  input: PrepareM7R3NoAgentProjectEnvironmentSubjectV1Input,
): Promise<M7R3PreparedNoAgentProjectEnvironmentSubjectV1> => {
  const hostConfig = await readProjectEnvironmentHostConfigV1(
    input.hostConfigPath,
  );
  const runtimeRoot = await createSandboxTaskRuntimeRoot(
    hostConfig.taskStorageRoot,
    hostConfig.runtimeRoot,
  );
  const sandbox = await preflightSandboxHost({
    delegatedCgroupRoot: hostConfig.delegatedCgroupRoot,
    bwrapPath: hostConfig.bwrapPath,
    prlimitPath: hostConfig.prlimitPath,
    busyboxPath: hostConfig.busyboxPath,
    taskStorageRoot: hostConfig.taskStorageRoot,
  });
  if (sandbox.kind !== "supported") {
    throw new Error(
      "M7 R3 no-Agent Project Environment sandbox is unavailable",
    );
  }
  if (
    sandbox.capability.taskStorage === undefined ||
    sandbox.binding.taskStorageRoot === undefined
  ) {
    throw new Error(
      "M7 R3 no-Agent Project Environment sandbox omitted bounded Task storage",
    );
  }
  const taskStorageCapability = sandbox.capability.taskStorage;
  const taskStorageRoot = sandbox.binding.taskStorageRoot;
  const godot = await resolveProjectEnvironmentGodotToolchainV1(
    hostConfig,
    input.source.requestedGodotVersion,
  );
  const codingToolchain = await inspectSandboxToolchain({
    lddPath: hostConfig.lddPath,
    commands: [
      { target: "/bin/bash", hostPath: hostConfig.bashPath },
      { target: "/usr/bin/rg", hostPath: hostConfig.rgPath },
      { target: "/usr/bin/find", hostPath: hostConfig.findPath },
      { target: "/usr/bin/ls", hostPath: hostConfig.lsPath },
    ],
  });
  const adapterPackage: LoadedProjectAdapterPackageV1 =
    loadProjectAdapterPackageFilesV1(input.adapterFiles, {
      requireSingleLaunchTarget: true,
      expectedMainScene: input.source.mainScene,
      requireEmptyLaunchParameters: true,
    });
  const adapterPackageIdentity = loadedAdapterIdentity(adapterPackage);
  if (
    adapterPackageIdentity.packageSha256 !==
      input.adapterRevision.packageDigest ||
    adapterPackageIdentity.manifestSha256 !==
      input.adapterRevision.manifestDigest ||
    adapterPackageIdentity.implementationSha256 !==
      input.adapterRevision.implementationDigest ||
    adapterPackageIdentity.observationSchemaSha256 !==
      input.adapterRevision.payloadSchemaDigest ||
    adapterPackageIdentity.adapterId !== input.adapterRevision.adapterId ||
    adapterPackageIdentity.contentByteLength !==
      input.adapterRevision.contentByteLength ||
    adapterPackageIdentity.contentFileCount !==
      input.adapterRevision.contentFileCount
  ) {
    throw new Error(
      "M7 R3 no-Agent Adapter bytes, implementation, schemas, or counts crossed the frozen AdapterRevision",
    );
  }
  const adapterFiles = input.adapterFiles.map((file) => ({
    relativePath: file.path,
    bytes: Uint8Array.from(file.bytes),
  }));
  const managedRuntime = await preflightManagedGodotProjectEnvironmentRuntimeV1(
    {
      hostConfig,
      godot,
      adapterFiles,
    },
  );
  if (
    managedRuntime.sdkDigest !== input.adapterRevision.sdkDigest ||
    managedRuntime.bridgeDigest !== input.adapterRevision.bridgeDigest
  ) {
    throw new Error(
      "M7 R3 no-Agent managed runtime crossed the frozen SDK or bridge",
    );
  }
  const policy = createSandboxPolicyV2(sandbox.capability.runtimeIdentity, {
    coding: {
      toolchainId: codingToolchain.capability.toolchainId,
      targets: codingToolchain.capability.files.map((file) => file.target),
    },
    godot: {
      toolchainId: managedRuntime.capability.toolchain.toolchainId,
      managedRuntimeId: managedRuntime.capability.managedRuntimeId,
      targets: managedRuntimeTargets(managedRuntime),
    },
  });
  const taskId = asTaskId(
    `task:m7-r3-preflight:${input.ordinal}:${input.subject}:${randomUUID()}`,
  );
  const workspaceId = asWorkspaceId(`workspace.v1.${taskId}`);
  const layout = await createProjectEnvironmentTaskDirectoryLayout({
    runtimeRoot,
    sourceRepositoryRoot: input.source.repositoryRoot,
    taskId,
  });
  const securityEvents: SecurityEventV1[] = [];
  let broker: DuplexTaskSandboxBrokerV1;
  try {
    broker = await createDuplexBwrapCgroupTaskSandbox({
      taskId,
      capability: sandbox.capability,
      hostBinding: sandbox.binding,
      policy,
      toolchain: codingToolchain,
      managedRuntime,
      layout,
      securityEvents: (eventInput) => {
        const event = SecurityEventV1Schema.parse(eventInput);
        if (event.taskId !== taskId) {
          throw new TypeError(
            "M7 R3 no-Agent sandbox denial crossed its Task identity",
          );
        }
        if (
          securityEvents.length >= 1_000 ||
          securityEvents.some((prior) => prior.eventId === event.eventId)
        ) {
          throw new Error(
            "M7 R3 no-Agent sandbox security-event audit is invalid or full",
          );
        }
        securityEvents.push(event);
        return Promise.resolve();
      },
    });
  } catch (error) {
    let cleanup: SandboxCleanupReceiptV1;
    try {
      cleanup = await removeFreshEmptyTaskLayout({ runtimeRoot, layout });
    } catch (cleanupError) {
      throw new AggregateError(
        [
          asError(error, "M7 R3 no-Agent broker creation failed"),
          asError(
            cleanupError,
            "M7 R3 fresh Task cleanup failed after broker creation failure",
          ),
        ],
        "M7 R3 no-Agent broker creation failed without cleanup proof",
      );
    }
    if (!cleanupComplete(cleanup)) {
      throw new AggregateError(
        [
          asError(error, "M7 R3 no-Agent broker creation failed"),
          new Error("M7 R3 fresh Task cleanup receipt was incomplete"),
        ],
        "M7 R3 no-Agent broker creation failed without cleanup proof",
      );
    }
    throw asError(error, "M7 R3 no-Agent broker creation failed");
  }
  try {
    const workspace: MaterializedProjectEnvironmentWorkspaceV1 =
      await materializePrivateTaskWorkspace({
        taskId,
        source: input.source,
        layout,
      });
    if (
      workspace.receipt.selectedTreeSha256 !== input.source.selectedTreeSha256
    ) {
      throw new Error("M7 R3 no-Agent workspace changed its verified source");
    }
    const taskStore = new ProjectEnvironmentTaskStoreV1({
      storeRoot: layout.projectEnvironmentRecordDirectory,
      taskId: asProjectEnvironmentTaskId(taskId),
    });
    await taskStore.create();
    const persistedToolchain = toolchainReceipt(
      godot.receipt,
      input.source.requestedGodotVersion,
      input.now(),
    );
    await taskStore.putToolchainReceiptOnce(persistedToolchain);
    const runtimeIdentity = M6ExactBuildRuntimeIdentityV1Schema.parse({
      schemaVersion: 1,
      managedRuntimeId: managedRuntime.capability.managedRuntimeId,
      engineVersion: managedRuntime.capability.engineVersion,
      runtimeArtifactDigest: digestJson(managedRuntime.capability),
      overlayDigest: managedRuntime.capability.overlayHash,
    });
    const policyProfileDigest = digestJson(policy);
    const exactBuild = await prepareM6ExactGodotBuildV1({
      taskId,
      workspaceId,
      workspaceDirectory: workspace.workspaceDirectory,
      baselineSourceHash: input.source.selectedTreeSha256,
      adapterRevision: input.adapterRevision,
      toolchainReceiptId: persistedToolchain.receiptId,
      toolchainArtifactDigest: godot.receipt.executableSha256,
      runtimeIdentity,
      policyProfileDigest,
      now: input.now(),
    });
    if (
      exactBuild.build.sourceHash !== input.source.selectedTreeSha256 ||
      exactBuild.configuredMainScene !== input.source.mainScene
    ) {
      throw new Error(
        "M7 R3 no-Agent exact Build crossed verified source bytes",
      );
    }
    const environmentRevisionId = `m7-r3-preflight-adapter-overlay:v1:${digestJson(
      {
        schemaVersion: 1,
        taskId,
        subject: input.subject,
        adapterRevisionId: input.adapterRevision.adapterRevisionId,
        managedRuntimeId: managedRuntime.capability.managedRuntimeId,
      },
    )}`;
    const launchTarget = adapterPackage.manifest.launchTargets.find(
      (candidate) => candidate.default,
    );
    if (launchTarget === undefined) {
      throw new Error("M7 R3 no-Agent Adapter has no default launch target");
    }
    let runtimeCreated = false;
    let cleanupPromise: Promise<SandboxCleanupReceiptV1> | null = null;
    const cleanupTask = (): Promise<SandboxCleanupReceiptV1> => {
      cleanupPromise ??= broker
        .cleanup()
        .then((receipt) => SandboxCleanupReceiptV1Schema.parse(receipt));
      return cleanupPromise;
    };
    return Object.freeze({
      subject: input.subject,
      taskId,
      workspaceId,
      sourceSelectedTreeSha256: input.source.selectedTreeSha256,
      exactBuild,
      adapterRevision: input.adapterRevision,
      adapterPackageIdentity,
      environmentRevisionId,
      launchTargetId: launchTarget.targetId,
      assertTaskStorageHeadroom: () =>
        assertSandboxTaskStorageHeadroomV1(
          taskStorageCapability,
          taskStorageRoot,
        ),
      createRuntimeOnce: (
        persistence: Parameters<
          M7R3PreparedNoAgentProjectEnvironmentSubjectV1["createRuntimeOnce"]
        >[0],
      ) => {
        if (runtimeCreated) {
          throw new Error("M7 R3 no-Agent subject runtime may be created once");
        }
        runtimeCreated = true;
        const options: ProjectEnvironmentGameRuntimeOptionsV1 = {
          sidecar: new GodotProjectEnvironmentSidecarPortV1({
            broker,
            managedRuntime,
          }),
          managedRuntime: managedRuntime.capability,
          adapterPackage,
          capabilitySet: input.adapterRevision.capabilitySet,
          taskId,
          sourceClosureId: exactBuild.build.sourceId,
          environmentRevisionId,
          adapterRevisionId: input.adapterRevision.adapterRevisionId,
          buildId: exactBuild.build.buildId,
          candidateSourceHash: exactBuild.build.sourceHash,
          expectedMainScene: exactBuild.configuredMainScene,
          adapterManifestSha256: input.adapterRevision.manifestDigest,
          sdkSha256: input.adapterRevision.sdkDigest,
          bridgeSha256: input.adapterRevision.bridgeDigest,
          toolchainSha256: godot.receipt.executableSha256,
          engineVersion: managedRuntime.capability.engineVersion,
          persistPinnedCapture: async (captureInput, recordInputs) => {
            const capture =
              ProjectEnvironmentPinnedCaptureV1Schema.parse(captureInput);
            const records = recordInputs.map((record) =>
              JsonValueSchema.parse(record),
            );
            if (
              capture.taskId !== taskId ||
              capture.buildId !== exactBuild.build.buildId ||
              capture.environmentRevisionId !== environmentRevisionId ||
              capture.adapterRevisionId !==
                input.adapterRevision.adapterRevisionId
            ) {
              throw new Error("M7 R3 no-Agent pinned capture crossed lineage");
            }
            await taskStore.putPinnedCaptureOnce(capture, records);
            const stored = await taskStore.readPinnedCapture(
              capture.captureWindowId,
            );
            if (
              !sameJson(stored.payload, capture) ||
              !sameJson(stored.records, records)
            ) {
              throw new Error(
                "M7 R3 no-Agent pinned capture changed during persistence",
              );
            }
            await persistence.persistPinnedCapture(
              stored.payload,
              stored.records,
            );
          },
          persistRuntimeObservation: async (receiptInput) => {
            const receipt =
              ProjectEnvironmentRuntimeObservationReceiptV1Schema.parse(
                receiptInput,
              );
            if (
              receipt.taskId !== taskId ||
              receipt.buildId !== exactBuild.build.buildId ||
              receipt.environmentRevisionId !== environmentRevisionId ||
              receipt.adapterRevisionId !==
                input.adapterRevision.adapterRevisionId
            ) {
              throw new Error("M7 R3 no-Agent runtime receipt crossed lineage");
            }
            await taskStore.putRuntimeObservationReceiptOnce(receipt);
            const stored = await taskStore.readRuntimeObservationReceipt(
              receipt.receiptId,
            );
            if (!sameJson(stored, receipt)) {
              throw new Error(
                "M7 R3 no-Agent runtime receipt changed during persistence",
              );
            }
            await persistence.persistRuntimeObservation(stored);
          },
          now: input.now,
        };
        return new ProjectEnvironmentGameRuntimeV1(options);
      },
      cleanupTask,
      readSecurityEvents: () =>
        Object.freeze(
          securityEvents.map((event) => SecurityEventV1Schema.parse(event)),
        ),
    });
  } catch (error) {
    let cleanup: SandboxCleanupReceiptV1;
    try {
      cleanup = SandboxCleanupReceiptV1Schema.parse(await broker.cleanup());
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "M7 R3 no-Agent subject preparation and cleanup both failed",
      );
    }
    if (!cleanupComplete(cleanup)) {
      throw new AggregateError(
        [error, new Error("M7 R3 no-Agent preparation cleanup was incomplete")],
        "M7 R3 no-Agent subject preparation failed without cleanup proof",
      );
    }
    throw asError(error, "M7 R3 no-Agent subject preparation failed");
  }
};

const DEFAULT_DEPENDENCIES: M7R3NoAgentProjectEnvironmentPreflightDependenciesV1 =
  {
    prepareSubject: prepareProductionSubject,
  };

/**
 * Production no-Agent preflight preparation. It creates two new Task roots,
 * two workspaces, two brokers, and later two runtimes; none is reused by an
 * Agent arm and no Pi/provider capability is accepted by this API.
 */
export async function prepareM7R3NoAgentProjectEnvironmentPreflightPortV1(
  input: {
    readonly ordinal: 1 | 2;
    readonly pristineSource: VerifiedProjectEnvironmentSourceV1;
    readonly mutantSource: VerifiedProjectEnvironmentSourceV1;
    readonly adapterFiles: readonly ProjectAdapterPackageBytesV1[];
    readonly adapterRevision: unknown;
    readonly hostConfigPath?: string | undefined;
    readonly now?: (() => string) | undefined;
  },
  overrides: Partial<M7R3NoAgentProjectEnvironmentPreflightDependenciesV1> = {},
): Promise<PreparedM7R3NoAgentProjectEnvironmentPreflightPortV1> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
  const now = input.now ?? (() => new Date().toISOString());
  const adapterRevision = ProjectAdapterRevisionV1Schema.parse(
    input.adapterRevision,
  );
  if (
    input.pristineSource.sourceKind !== "project-environment-v1-clean-git" ||
    input.mutantSource.sourceKind !== "project-environment-v1-clean-git" ||
    input.pristineSource.repositoryRoot === input.mutantSource.repositoryRoot ||
    input.pristineSource.projectRoot === input.mutantSource.projectRoot ||
    input.pristineSource.selectedTreeSha256 ===
      input.mutantSource.selectedTreeSha256 ||
    input.pristineSource.requestedGodotVersion !==
      input.mutantSource.requestedGodotVersion ||
    input.pristineSource.mainScene !== input.mutantSource.mainScene
  ) {
    throw new TypeError(
      "M7 R3 preflight requires distinct verified pristine/mutant source roots with one main scene",
    );
  }
  const common = {
    ordinal: input.ordinal,
    adapterFiles: input.adapterFiles,
    adapterRevision,
    ...(input.hostConfigPath === undefined
      ? {}
      : { hostConfigPath: input.hostConfigPath }),
    now,
  } as const;
  const pristine = await dependencies.prepareSubject({
    ...common,
    subject: "pristine",
    source: input.pristineSource,
  });
  let mutant: M7R3PreparedNoAgentProjectEnvironmentSubjectV1;
  try {
    mutant = await dependencies.prepareSubject({
      ...common,
      subject: "mutant",
      source: input.mutantSource,
    });
  } catch (error) {
    let cleanup: SandboxCleanupReceiptV1;
    try {
      cleanup = SandboxCleanupReceiptV1Schema.parse(
        await pristine.cleanupTask(),
      );
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "M7 R3 mutant preflight preparation and pristine cleanup both failed",
      );
    }
    if (!cleanupComplete(cleanup)) {
      throw new AggregateError(
        [error, new Error("M7 R3 pristine cleanup was incomplete")],
        "M7 R3 mutant preflight preparation failed without pristine cleanup proof",
      );
    }
    throw asError(error, "M7 R3 mutant preflight preparation failed");
  }
  try {
    return createM7R3NoAgentProjectEnvironmentPreflightPortV1({
      ordinal: input.ordinal,
      pristine,
      mutant,
    });
  } catch (error) {
    const failures: Error[] = [
      asError(error, "M7 R3 no-Agent preflight composition failed"),
    ];
    for (const subject of [mutant, pristine]) {
      try {
        const cleanup = SandboxCleanupReceiptV1Schema.parse(
          await subject.cleanupTask(),
        );
        if (!cleanupComplete(cleanup)) {
          failures.push(
            new Error(
              `M7 R3 ${subject.subject} cleanup was incomplete after composition failure`,
            ),
          );
        }
      } catch (cleanupError) {
        failures.push(
          asError(
            cleanupError,
            `M7 R3 ${subject.subject} cleanup failed after composition failure`,
          ),
        );
      }
    }
    if (failures.length === 1) {
      throw failures[0] ?? new Error("M7 R3 no-Agent composition failed");
    }
    throw new AggregateError(
      failures,
      "M7 R3 no-Agent preflight composition failed without complete cleanup",
    );
  }
}
