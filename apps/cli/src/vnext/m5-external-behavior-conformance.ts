import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdtemp,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { SEMANTIC_GAME_TOOL_NAMES_V1 } from "@chronorift/agent-protocol";
import {
  Sha256DigestV1Schema,
  TaskPatchIdentityV1Schema,
  VNextBuildV1Schema,
  VNextSemanticExecutionRecordV1Schema,
  VNextSemanticObservationEventV1Schema,
  VNextSemanticRuntimeRecordV1Schema,
  type Sha256DigestV1,
  type TaskId,
  type TaskPatchIdentityV1,
  type VNextBuildV1,
  type VNextSemanticObservationEventV1,
  taskNamespaceDigestV1,
} from "@chronorift/domain";
import {
  VNextRuntimeStore,
  VNextTaskStore,
  canonicalJson,
  contentHash,
  runtimeResourceNamespaceDigestV1,
  type RuntimeExecutionSealV1,
} from "@chronorift/json-artifacts";
import { z } from "zod";

import {
  PatchExportReceiptV1Schema,
  SandboxCleanupReceiptV1Schema,
  SandboxOperationRecordV1Schema,
  SandboxPolicySchema,
  type PatchExportReceiptV1,
  type SandboxCleanupReceiptV1,
} from "./contracts.js";
import { VNextAgentTurnV1Schema } from "./task-agent-contracts.js";

export const M5_BEHAVIOR_THRESHOLDS_V1 = Object.freeze({
  baselineTimerMaximumSeconds: 0.01,
  candidateTimerMinimumSeconds: 0.9,
  candidateTimerMaximumSeconds: 1.1,
  candidateEarlyNoSpawnMaximumUs: 250_000,
  candidateLaterSpawnMinimumUs: 900_000,
});

// Raw-file identities are updated only with an intentional M5 freeze change.
// The live Gate checks them before contacting the Provider.
export const M5_TASK_SPEC_RAW_SHA256_V1: Sha256DigestV1 =
  Sha256DigestV1Schema.parse(
    "c9cb447748b7d4cbd81554fa67c0432e84a9761781de8d7355e5533f16ffb199",
  );
export const M5_EVIDENCE_SCHEMA_RAW_SHA256_V1: Sha256DigestV1 =
  Sha256DigestV1Schema.parse(
    "365ab2b008978e4d3eb987012fdad5411bb658d570770501405d242ef73bfd76",
  );

export const M5_CLAIMS_EXCLUDED_V1 = Object.freeze([
  "correctness",
  "independent_acceptance",
  "intelligent_diagnosis",
  "causality",
  "generalization",
  "reliability",
  "success_rate",
  "relative_advantage",
  "arbitrary_project_support",
  "root_cause_correctness",
] as const);

export const M5_TASK_PROMPT_V1 =
  "Work on the pinned external Godot project. Reproduce the public behavior problem in res://components/spawner/enemy_spawner_broken.tscn: enemies spawn much sooner than its configured one-second interval. Mandatory evidence checkpoint: game_capabilities or a build response alone is not a baseline execution. Before the first source-file write, actually launch and observe the untouched initial workspace. That unchanged-source execution must record a Timer wait time at or below 0.01 seconds and a spawn-present observation endpoint. It must ultimately be sealed and cleanup-proven; turn-completion cleanup may do so. It cannot be reconstructed after editing, and the Gate rejects candidate-only runs. Investigate the project and independently modify actual tracked GDScript to change this behavior; do not assume a particular cause or edit from this task text. From the final changed source, run a candidate that records a Timer wait time from 0.9 through 1.1 seconds, spawn-absent ready and early observation endpoints through 0.25 seconds, and a spawn-present later observation endpoint at or after 0.9 seconds. These are observation endpoint states, not exact spawn timestamps; there is no upper endpoint deadline tied to Agent response latency. Once both observations and the tracked change exist, finish promptly; turn-completion cleanup may seal active runtimes. Do not add or modify addons, generated caches, or native extensions. Leave reviewable candidate changes for patch export, with both required executions sealed by turn completion.";

const exactOrderedStrings = <
  const Values extends readonly [string, ...string[]],
>(
  values: Values,
) =>
  z
    .array(z.enum(values))
    .length(values.length)
    .superRefine((actual, context) => {
      if (actual.some((value, index) => value !== values[index])) {
        context.addIssue({
          code: "custom",
          message: "ordered frozen values do not match",
          input: actual,
        });
      }
    });

const SemanticToolNamesV1Schema = exactOrderedStrings(
  SEMANTIC_GAME_TOOL_NAMES_V1,
);
const M5ClaimsExcludedV1Schema = exactOrderedStrings(M5_CLAIMS_EXCLUDED_V1);

export const M5TaskSpecV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    specKind: z.literal("chronorift-m5-public-exposed-behavior-change-task"),
    taskClassification: z.literal("public_exposed_behavior_change_conformance"),
    source: z
      .object({
        declaredUrl: z.literal(
          "https://github.com/endlessm/moddable-platformer",
        ),
        headCommit: z.literal("3e793f53598a131c53fb82555191cc14b8db07ff"),
        gitTreeObjectId: z.literal("a013bd677c712dbf354e8e2f6e8ff7c53d5684c6"),
        selectedTreeSha256: z.literal(
          "3e8bd6478d53586284010da38959005e2a377ef6277b2a838ecb1538abc096e8",
        ),
        descriptorRawSha256: z.literal(
          "534dcd8aa14aeea74685059f8d66e44e5bebe21742b7a702ee7d78e91e1a955e",
        ),
        projectCapabilitySha256: z.literal(
          "5fcb49b2a8dc64e7f38af7c26e630dec67799bf0dd1a713310baefac32c58836",
        ),
      })
      .strict(),
    semanticProfile: z
      .object({
        taskProfile: z.literal("godot-external-semantic-v1"),
        protocolProfile: z.literal("chronorift-godot-semantic-v1"),
        adapterProfileRawSha256: z.literal(
          "1ca17b9f3fff8556d5fa260331929126ba54e18518de2d2386562b230327238b",
        ),
        adapterProfileCanonicalSha256: z.literal(
          "2600ae0d42a463d78a7c74b987799e74e7391c254f806ddbcc86b2256591f0e4",
        ),
        targetScene: z.literal(
          "res://components/spawner/enemy_spawner_broken.tscn",
        ),
        toolNames: SemanticToolNamesV1Schema,
      })
      .strict(),
    agentBudget: z
      .object({
        provider: z.literal("openai-codex"),
        model: z.literal("gpt-5.6-luna"),
        thinkingLevel: z.literal("max"),
        attemptsMaximum: z.literal(1),
        turnsPerAttemptMaximum: z.literal(1),
        toolCallsMaximum: z.literal(128),
        wallTimeMsMaximum: z.literal(900_000),
        taskSandboxNetworkMode: z.literal("denied"),
        hostModelNetworkAuthorization: z.literal("provider_only"),
        taskCredentialMountCountMaximum: z.literal(0),
      })
      .strict(),
    toolchain: z
      .object({
        nodeVersion: z.literal("v22.23.1"),
        godotVersion: z.literal("4.7.1.stable.official.a13da4feb"),
      })
      .strict(),
    prompt: z.literal(M5_TASK_PROMPT_V1),
    behaviorContract: z
      .object({
        baseline: z
          .object({
            timerWaitTimeSecondsMaximum: z.literal(0.01),
            minimumObservedSpawnOrdinal: z.literal(1),
          })
          .strict(),
        candidate: z
          .object({
            timerWaitTimeSecondsMinimum: z.literal(0.9),
            timerWaitTimeSecondsMaximum: z.literal(1.1),
            earlyObservationWindowUs: z.literal(250_000),
            maximumEarlyTimeoutOrdinal: z.literal(0),
            laterObservationMinimumUs: z.literal(900_000),
            minimumLaterTimeoutOrdinal: z.literal(1),
          })
          .strict(),
      })
      .strict(),
    patchContract: z
      .object({
        requiredChangedSuffix: z.literal(".gd"),
        requireNonempty: z.literal(true),
        requireFullIndexBinaryRoundTrip: z.literal(true),
        forbiddenPathPrefixes: z.tuple([
          z.literal(".chronorift/"),
          z.literal(".godot/"),
          z.literal("addons/"),
        ]),
      })
      .strict(),
    claimsExcluded: M5ClaimsExcludedV1Schema,
  })
  .strict();
export type M5TaskSpecV1 = z.infer<typeof M5TaskSpecV1Schema>;

export async function readM5TaskSpecV1(path: string): Promise<{
  readonly spec: M5TaskSpecV1;
  readonly rawSha256: Sha256DigestV1;
}> {
  const bytes = await readBoundedRegularFile(resolve(path), 1024 * 1024);
  let decoded: unknown;
  try {
    decoded = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
  } catch (error) {
    throw new Error("M5 task spec must be UTF-8 JSON", { cause: error });
  }
  return Object.freeze({
    spec: M5TaskSpecV1Schema.parse(decoded),
    rawSha256: sha256Bytes(bytes),
  });
}

type SemanticRuntimeRecordV1 = z.infer<
  typeof VNextSemanticRuntimeRecordV1Schema
>;
type SemanticExecutionRecordV1 = z.infer<
  typeof VNextSemanticExecutionRecordV1Schema
>;

export interface M5ExecutionEvidenceInputV1 {
  readonly build: VNextBuildV1;
  readonly runtime: SemanticRuntimeRecordV1;
  readonly execution: SemanticExecutionRecordV1;
  readonly events: readonly VNextSemanticObservationEventV1[];
  readonly seal: RuntimeExecutionSealV1;
}

export interface M5BehaviorObservationV1 {
  readonly executionId: string;
  readonly runtimeId: string;
  readonly buildId: string;
  readonly sourceHash: Sha256DigestV1;
  readonly timerWaitTimeSeconds: number;
  readonly firstSequence: number;
  readonly firstSimulationTimeUs: number;
  readonly decisiveSequence: number;
  readonly decisiveSimulationTimeUs: number;
  readonly decisiveRelativeSimulationTimeUs: number;
  readonly decisiveSpawnOrdinal: number;
  readonly decisiveEntityCount: number;
}

export interface M5SelectedExecutionEvidenceV1 {
  readonly baseline: M5ExecutionEvidenceInputV1;
  readonly candidate: M5ExecutionEvidenceInputV1;
  readonly baselineObservation: M5BehaviorObservationV1;
  readonly candidateEarlyObservation: M5BehaviorObservationV1;
  readonly candidateLaterObservation: M5BehaviorObservationV1;
  readonly totalExecutionCount: number;
}

const sameJson = (left: unknown, right: unknown): boolean =>
  contentHash(left as never) === contentHash(right as never);

const requireExecutionIntegrityChain = (
  taskId: TaskId,
  spec: M5TaskSpecV1,
  input: M5ExecutionEvidenceInputV1,
): void => {
  const build = VNextBuildV1Schema.parse(input.build);
  const runtime = VNextSemanticRuntimeRecordV1Schema.parse(input.runtime);
  const execution = VNextSemanticExecutionRecordV1Schema.parse(input.execution);
  const events = input.events.map((event) =>
    VNextSemanticObservationEventV1Schema.parse(event),
  );
  if (
    build.taskId !== taskId ||
    runtime.taskId !== taskId ||
    execution.taskId !== taskId ||
    input.seal.taskId !== taskId
  ) {
    throw new Error("M5 runtime evidence belongs to a different Task");
  }
  if (
    runtime.executionId !== execution.executionId ||
    runtime.runtimeId !== execution.runtimeId ||
    runtime.buildId !== execution.buildId ||
    build.buildId !== execution.buildId ||
    build.sourceId !== execution.sourceId ||
    build.workspaceId !== execution.workspaceId ||
    build.sourceId !== `source:${build.sourceHash}` ||
    build.workspaceDiffHash !==
      contentHash({
        schemaVersion: 1,
        baselineSourceHash: spec.source.selectedTreeSha256,
        candidateSourceHash: build.sourceHash,
      }) ||
    runtime.adapterId !== execution.adapterId ||
    runtime.adapterProfileSha256 !== execution.adapterProfileSha256 ||
    runtime.adapterProfileSha256 !==
      spec.semanticProfile.adapterProfileCanonicalSha256 ||
    execution.targetScene !== spec.semanticProfile.targetScene ||
    input.seal.executionId !== execution.executionId ||
    !sameJson(input.seal, execution.executionSeal)
  ) {
    throw new Error(
      "M5 build/runtime/execution/seal identity chain is detached",
    );
  }
  if (
    runtime.cleanupProven !== true ||
    execution.eventCount !== events.length ||
    input.seal.count !== events.length ||
    events.length < 1
  ) {
    throw new Error("M5 requires a cleanup-proven, sealed execution chain");
  }
  if (
    events[0]?.source !== "ready" ||
    events.slice(0, -1).some((event) => event.source === "shutdown")
  ) {
    throw new Error(
      "M5 semantic execution must start ready and may only end with shutdown",
    );
  }
  for (const [sequence, event] of events.entries()) {
    const previous = events[sequence - 1];
    if (
      event.taskId !== taskId ||
      event.executionId !== execution.executionId ||
      event.runtimeId !== execution.runtimeId ||
      event.buildId !== execution.buildId ||
      event.sequence !== sequence ||
      event.hostMonotonicStartUs > event.hostMonotonicEndUs ||
      (previous !== undefined &&
        event.hostMonotonicStartUs < previous.hostMonotonicEndUs) ||
      event.projectionSha256 !== contentHash(event.projection)
    ) {
      throw new Error(
        "M5 semantic event lineage or projection hash is invalid",
      );
    }
  }
  const finalEvent = events.at(-1)!;
  if (
    runtime.finalProjectionSha256 !== contentHash(runtime.finalProjection) ||
    !sameJson(runtime.finalProjection, finalEvent.projection)
  ) {
    throw new Error(
      "M5 runtime final projection is detached from its raw ledger",
    );
  }
};

const isStoppedExecutionChain = (input: M5ExecutionEvidenceInputV1): boolean =>
  input.runtime.status === "stopped" &&
  input.events.length >= 2 &&
  input.events[0]?.source === "ready" &&
  input.events.at(-1)?.source === "shutdown" &&
  input.events.slice(0, -1).every((event) => event.source !== "shutdown");

const relativeSimulationTimeUs = (
  first: VNextSemanticObservationEventV1,
  event: VNextSemanticObservationEventV1,
): number =>
  event.projection.capturedAt.simulationTimeUs -
  first.projection.capturedAt.simulationTimeUs;

const hasSpawn = (event: VNextSemanticObservationEventV1): boolean =>
  event.projection.nextSpawnOrdinal > 0 || event.projection.entities.length > 0;

const hasMonotonicSimulationClock = (
  input: M5ExecutionEvidenceInputV1,
): boolean =>
  input.events.every((event, index) => {
    const previous = input.events[index - 1];
    return (
      previous === undefined ||
      (event.projection.capturedAt.simulationTimeUs >=
        previous.projection.capturedAt.simulationTimeUs &&
        event.projection.capturedAt.processFrame >=
          previous.projection.capturedAt.processFrame &&
        event.projection.capturedAt.physicsTick >=
          previous.projection.capturedAt.physicsTick)
    );
  });

const observation = (
  input: M5ExecutionEvidenceInputV1,
  event: VNextSemanticObservationEventV1,
): M5BehaviorObservationV1 => {
  const first = input.events[0]!;
  return Object.freeze({
    executionId: input.execution.executionId,
    runtimeId: input.runtime.runtimeId,
    buildId: input.build.buildId,
    sourceHash: input.build.sourceHash,
    timerWaitTimeSeconds: event.projection.timer.waitTimeSeconds,
    firstSequence: first.sequence,
    firstSimulationTimeUs: first.projection.capturedAt.simulationTimeUs,
    decisiveSequence: event.sequence,
    decisiveSimulationTimeUs: event.projection.capturedAt.simulationTimeUs,
    decisiveRelativeSimulationTimeUs: relativeSimulationTimeUs(first, event),
    decisiveSpawnOrdinal: event.projection.nextSpawnOrdinal,
    decisiveEntityCount: event.projection.entities.length,
  });
};

const baselineBehavior = (
  input: M5ExecutionEvidenceInputV1,
  contract: M5TaskSpecV1["behaviorContract"]["baseline"],
): M5BehaviorObservationV1 | undefined => {
  if (!hasMonotonicSimulationClock(input)) return undefined;
  if (
    input.events.some(
      (event) =>
        event.projection.timer.waitTimeSeconds >
        contract.timerWaitTimeSecondsMaximum,
    )
  ) {
    return undefined;
  }
  const decisive = input.events.find(
    (event) =>
      event.projection.nextSpawnOrdinal >=
        contract.minimumObservedSpawnOrdinal && hasSpawn(event),
  );
  return decisive === undefined ? undefined : observation(input, decisive);
};

const candidateBehavior = (
  input: M5ExecutionEvidenceInputV1,
  contract: M5TaskSpecV1["behaviorContract"]["candidate"],
):
  | {
      readonly early: M5BehaviorObservationV1;
      readonly later: M5BehaviorObservationV1;
    }
  | undefined => {
  if (!hasMonotonicSimulationClock(input)) return undefined;
  if (
    input.events.some((event) => {
      const waitTime = event.projection.timer.waitTimeSeconds;
      return (
        waitTime < contract.timerWaitTimeSecondsMinimum ||
        waitTime > contract.timerWaitTimeSecondsMaximum
      );
    })
  ) {
    return undefined;
  }
  const first = input.events[0]!;
  const earlyEvents = input.events.filter(
    (event) =>
      relativeSimulationTimeUs(first, event) <=
      contract.earlyObservationWindowUs,
  );
  if (
    earlyEvents.length === 0 ||
    earlyEvents.some(
      (event) =>
        event.projection.nextSpawnOrdinal >
          contract.maximumEarlyTimeoutOrdinal || hasSpawn(event),
    )
  ) {
    return undefined;
  }
  const later = input.events.find((event) => {
    const relative = relativeSimulationTimeUs(first, event);
    return (
      relative >= contract.laterObservationMinimumUs &&
      event.projection.nextSpawnOrdinal >=
        contract.minimumLaterTimeoutOrdinal &&
      hasSpawn(event)
    );
  });
  if (later === undefined) return undefined;
  return {
    early: observation(input, earlyEvents.at(-1)!),
    later: observation(input, later),
  };
};

const evidenceOrder = (
  left: M5ExecutionEvidenceInputV1,
  right: M5ExecutionEvidenceInputV1,
): number => {
  const hostDifference =
    left.events[0]!.hostMonotonicStartUs -
    right.events[0]!.hostMonotonicStartUs;
  return hostDifference !== 0
    ? hostDifference
    : left.execution.executionId.localeCompare(right.execution.executionId);
};

export function selectM5ExecutionEvidenceV1(input: {
  readonly taskId: TaskId;
  readonly taskSpec: M5TaskSpecV1;
  readonly patchIdentity: TaskPatchIdentityV1;
  readonly executions: readonly M5ExecutionEvidenceInputV1[];
}): M5SelectedExecutionEvidenceV1 {
  const patch = TaskPatchIdentityV1Schema.parse(input.patchIdentity);
  const spec = M5TaskSpecV1Schema.parse(input.taskSpec);
  if (patch.taskId !== input.taskId || patch.byteLength <= 0) {
    throw new Error("M5 requires a non-empty patch bound to the current Task");
  }
  if (patch.baselineSourceHash !== spec.source.selectedTreeSha256) {
    throw new Error("M5 patch baseline is detached from the frozen source");
  }
  if (patch.baselineSourceHash === patch.candidateSourceHash) {
    throw new Error("M5 candidate source identity must differ from baseline");
  }
  if (input.executions.length < 2) {
    throw new Error("M5 requires baseline and candidate executions");
  }
  // A real coding turn may contain sealed failed launches while the Agent
  // iterates. Every persisted execution must still have an intact, Task-bound
  // raw chain; only stopped ready→shutdown executions are behavior candidates.
  for (const execution of input.executions) {
    requireExecutionIntegrityChain(input.taskId, spec, execution);
    if (
      execution.runtime.status === "stopped" &&
      !isStoppedExecutionChain(execution)
    ) {
      throw new Error(
        "M5 stopped semantic execution does not end with shutdown",
      );
    }
  }
  const successfulExecutions = input.executions.filter(isStoppedExecutionChain);
  const baselineMatches = successfulExecutions
    .filter(
      (execution) =>
        execution.build.sourceHash === patch.baselineSourceHash &&
        baselineBehavior(execution, spec.behaviorContract.baseline) !==
          undefined,
    )
    .sort(evidenceOrder);
  const candidateMatches = successfulExecutions
    .filter(
      (execution) =>
        execution.build.sourceHash === patch.candidateSourceHash &&
        candidateBehavior(execution, spec.behaviorContract.candidate) !==
          undefined,
    )
    .sort(evidenceOrder);
  if (baselineMatches.length === 0) {
    throw new Error(
      "M5 has no sealed baseline execution with an approximately 1 ms Timer and a spawned-entity observation",
    );
  }
  if (candidateMatches.length === 0) {
    throw new Error(
      "M5 has no sealed final-candidate execution with an approximately 1 s Timer, spawn-absent ready/early endpoints, and a spawn-present later endpoint",
    );
  }
  const orderedPair = baselineMatches
    .map((baseline) => {
      const baselineObservation = baselineBehavior(
        baseline,
        spec.behaviorContract.baseline,
      )!;
      const decisiveBaselineEvent =
        baseline.events[baselineObservation.decisiveSequence]!;
      const candidate = candidateMatches.find(
        (execution) =>
          execution.events[0]!.hostMonotonicStartUs >
          decisiveBaselineEvent.hostMonotonicEndUs,
      );
      return candidate === undefined
        ? undefined
        : { baseline, baselineObservation, candidate };
    })
    .find((pair) => pair !== undefined);
  if (orderedPair === undefined) {
    throw new Error(
      "M5 selected candidate must begin after the selected baseline behavior reproduction",
    );
  }
  const { baseline, baselineObservation, candidate } = orderedPair;
  if (
    baseline.build.workspaceId !== candidate.build.workspaceId ||
    baseline.execution.workspaceId !== candidate.execution.workspaceId ||
    baseline.execution.adapterId !== candidate.execution.adapterId
  ) {
    throw new Error(
      "M5 baseline and candidate must share one workspace and semantic adapter",
    );
  }
  const candidateObservations = candidateBehavior(
    candidate,
    spec.behaviorContract.candidate,
  )!;
  return Object.freeze({
    baseline,
    candidate,
    baselineObservation,
    candidateEarlyObservation: candidateObservations.early,
    candidateLaterObservation: candidateObservations.later,
    totalExecutionCount: input.executions.length,
  });
}

export async function collectM5ExecutionEvidenceV1(input: {
  readonly taskId: TaskId;
  readonly runtimeRoot: string;
  readonly taskSpec: M5TaskSpecV1;
  readonly patchIdentity: TaskPatchIdentityV1;
}): Promise<M5SelectedExecutionEvidenceV1> {
  const store = new VNextRuntimeStore(input.runtimeRoot);
  await store.open(input.taskId);
  const summary = await store.summarize(input.taskId);
  if (
    summary.executions.length < 2 ||
    summary.executions.some((execution) => !execution.sealed)
  ) {
    throw new Error(
      "M5 requires every persisted semantic execution to be sealed",
    );
  }
  const executions = await Promise.all(
    summary.executions.map(async ({ executionId }) => {
      const execution = await store.readResource(
        input.taskId,
        "execution",
        executionId,
        (value) => VNextSemanticExecutionRecordV1Schema.parse(value),
      );
      const [build, runtime, events, seal] = await Promise.all([
        store.readResource(input.taskId, "build", execution.buildId, (value) =>
          VNextBuildV1Schema.parse(value),
        ),
        store.readResource(
          input.taskId,
          "runtime",
          execution.runtimeId,
          (value) => VNextSemanticRuntimeRecordV1Schema.parse(value),
        ),
        store.readExecutionEvents(input.taskId, executionId, (value) =>
          VNextSemanticObservationEventV1Schema.parse(value),
        ),
        store.readExecutionSeal(input.taskId, executionId),
      ]);
      return { build, runtime, execution, events, seal };
    }),
  );
  return selectM5ExecutionEvidenceV1({
    taskId: input.taskId,
    taskSpec: input.taskSpec,
    patchIdentity: input.patchIdentity,
    executions,
  });
}

export interface M5ArtifactReferenceV1 {
  readonly relativePath: string;
  readonly rawSha256: Sha256DigestV1;
}

export interface M5RuntimeArtifactReferencesV1 {
  readonly build: M5ArtifactReferenceV1;
  readonly runtime: M5ArtifactReferenceV1;
  readonly execution: M5ArtifactReferenceV1;
  readonly events: M5ArtifactReferenceV1;
  readonly executionSeal: M5ArtifactReferenceV1;
}

const runtimeArtifactPaths = (
  role: "baseline" | "candidate",
): Record<keyof M5RuntimeArtifactReferencesV1, string> =>
  Object.freeze({
    build: `runtime-records/${role}/build.json`,
    runtime: `runtime-records/${role}/runtime.json`,
    execution: `runtime-records/${role}/execution.json`,
    events: `runtime-records/${role}/events.jsonl`,
    executionSeal: `runtime-records/${role}/execution-seal.json`,
  });

const readBoundedRegularFile = async (
  path: string,
  maximumBytes = 64 * 1024 * 1024,
): Promise<Buffer> => {
  const metadata = await lstat(path);
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    metadata.nlink !== 1 ||
    metadata.size > maximumBytes
  ) {
    throw new Error("M5 source artifact must be a bounded single-link file");
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.dev !== metadata.dev ||
      before.ino !== metadata.ino ||
      before.size !== metadata.size
    ) {
      throw new Error("M5 source artifact changed before it was read");
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      bytes.byteLength !== before.size
    ) {
      throw new Error("M5 source artifact changed while it was read");
    }
    return bytes;
  } finally {
    await handle.close();
  }
};

const writeCreateNew = async (
  path: string,
  bytes: Uint8Array,
): Promise<void> => {
  await writeFile(path, bytes, { flag: "wx", mode: 0o400 });
};

const physicalRuntimeResourceRoot = (input: {
  readonly runtimeRoot: string;
  readonly taskId: TaskId;
  readonly kind: "build" | "runtime" | "execution";
  readonly resourceId: string;
}): string =>
  join(
    resolve(input.runtimeRoot),
    "tasks",
    taskNamespaceDigestV1(input.taskId),
    "runtime-records",
    input.kind === "build"
      ? "builds"
      : input.kind === "runtime"
        ? "runtimes"
        : "executions",
    runtimeResourceNamespaceDigestV1(
      input.taskId,
      input.kind,
      input.resourceId,
    ),
  );

const exportExecutionArtifacts = async (input: {
  readonly role: "baseline" | "candidate";
  readonly taskId: TaskId;
  readonly runtimeRoot: string;
  readonly stagingRoot: string;
  readonly evidence: M5ExecutionEvidenceInputV1;
}): Promise<M5RuntimeArtifactReferencesV1> => {
  const paths = runtimeArtifactPaths(input.role);
  const outputRoot = join(input.stagingRoot, "runtime-records", input.role);
  await mkdir(outputRoot, { recursive: true, mode: 0o700 });
  const buildRoot = physicalRuntimeResourceRoot({
    runtimeRoot: input.runtimeRoot,
    taskId: input.taskId,
    kind: "build",
    resourceId: input.evidence.build.buildId,
  });
  const runtimeRoot = physicalRuntimeResourceRoot({
    runtimeRoot: input.runtimeRoot,
    taskId: input.taskId,
    kind: "runtime",
    resourceId: input.evidence.runtime.runtimeId,
  });
  const executionRoot = physicalRuntimeResourceRoot({
    runtimeRoot: input.runtimeRoot,
    taskId: input.taskId,
    kind: "execution",
    resourceId: input.evidence.execution.executionId,
  });
  const copies = [
    [join(buildRoot, "record.json"), join(input.stagingRoot, paths.build)],
    [join(runtimeRoot, "record.json"), join(input.stagingRoot, paths.runtime)],
    [
      join(executionRoot, "record.json"),
      join(input.stagingRoot, paths.execution),
    ],
    [
      join(executionRoot, "events.jsonl"),
      join(input.stagingRoot, paths.events),
    ],
    [
      join(executionRoot, "events.seal.json"),
      join(input.stagingRoot, paths.executionSeal),
    ],
  ] as const;
  const hashes = new Map<string, Sha256DigestV1>();
  for (const [source, target] of copies) {
    const bytes = await readBoundedRegularFile(source);
    await writeCreateNew(target, bytes);
    hashes.set(target, sha256Bytes(bytes));
  }
  const reference = (key: keyof M5RuntimeArtifactReferencesV1) => {
    const relativePath = paths[key];
    const rawSha256 = hashes.get(join(input.stagingRoot, relativePath));
    if (rawSha256 === undefined) throw new Error("M5 artifact hash is missing");
    return Object.freeze({ relativePath, rawSha256 });
  };
  return Object.freeze({
    build: reference("build"),
    runtime: reference("runtime"),
    execution: reference("execution"),
    events: reference("events"),
    executionSeal: reference("executionSeal"),
  });
};

export async function exportM5RuntimeArtifactsV1(input: {
  readonly taskId: TaskId;
  readonly runtimeRoot: string;
  readonly stagingRoot: string;
  readonly selection: M5SelectedExecutionEvidenceV1;
}): Promise<{
  readonly baseline: M5RuntimeArtifactReferencesV1;
  readonly candidate: M5RuntimeArtifactReferencesV1;
}> {
  const [baseline, candidate] = await Promise.all([
    exportExecutionArtifacts({
      role: "baseline",
      taskId: input.taskId,
      runtimeRoot: input.runtimeRoot,
      stagingRoot: input.stagingRoot,
      evidence: input.selection.baseline,
    }),
    exportExecutionArtifacts({
      role: "candidate",
      taskId: input.taskId,
      runtimeRoot: input.runtimeRoot,
      stagingRoot: input.stagingRoot,
      evidence: input.selection.candidate,
    }),
  ]);
  return Object.freeze({ baseline, candidate });
}

export const sha256Bytes = (bytes: Uint8Array): Sha256DigestV1 =>
  Sha256DigestV1Schema.parse(createHash("sha256").update(bytes).digest("hex"));

export function requireM5PatchExportV1(input: {
  readonly taskId: TaskId;
  readonly identity: TaskPatchIdentityV1;
  readonly receipt: PatchExportReceiptV1;
  readonly bytes: Uint8Array;
}): void {
  const identity = TaskPatchIdentityV1Schema.parse(input.identity);
  const receipt = PatchExportReceiptV1Schema.parse(input.receipt);
  const patchHash = sha256Bytes(input.bytes);
  if (
    identity.taskId !== input.taskId ||
    receipt.taskId !== input.taskId ||
    identity.byteLength <= 0 ||
    identity.byteLength !== input.bytes.byteLength ||
    receipt.byteLength !== input.bytes.byteLength ||
    identity.patchHash !== patchHash ||
    receipt.patchSha256 !== patchHash ||
    identity.patchId !== receipt.patchId ||
    receipt.outputPath !== "candidate.patch"
  ) {
    throw new Error(
      "M5 patch bytes, identity, and export receipt are detached",
    );
  }
  const text = Buffer.from(input.bytes).toString("utf8");
  const indexLines = text.match(/^index [^\n]+$/gmu) ?? [];
  if (
    !text.startsWith("diff --git ") ||
    indexLines.length === 0 ||
    indexLines.some(
      (line) =>
        !/^index [a-f0-9]{40}\.\.[a-f0-9]{40}(?: [0-7]{6})?$/u.test(line),
    )
  ) {
    throw new Error("M5 patch is not a full-index Git patch");
  }
}

export function requireM5TrackedGdPathsV1(
  paths: readonly string[],
  contract: M5TaskSpecV1["patchContract"],
  trackedPaths: readonly string[] = paths,
): readonly string[] {
  const normalized = [...new Set(paths)].sort();
  const normalizedTracked = new Set(trackedPaths);
  if (
    normalized.length === 0 ||
    normalized.some(
      (path) =>
        path.length === 0 ||
        path.length > 512 ||
        !/^[A-Za-z0-9._/-]+$/u.test(path) ||
        path.startsWith("/") ||
        path.includes("\\") ||
        path.includes("\0") ||
        path
          .split("/")
          .some(
            (segment) =>
              segment === "" ||
              segment === "." ||
              segment === ".." ||
              segment === ".git",
          ),
    ) ||
    normalized.some((path) =>
      contract.forbiddenPathPrefixes.some((prefix) => path.startsWith(prefix)),
    ) ||
    !normalized.some(
      (path) =>
        normalizedTracked.has(path) &&
        path.endsWith(contract.requiredChangedSuffix),
    )
  ) {
    throw new Error("M5 patch must modify at least one tracked .gd file");
  }
  return Object.freeze(normalized);
}

interface M5DirectoryIdentityV1 {
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
  readonly uid: number;
  readonly birthtimeMs: number;
}

const statNumber = (value: number | bigint, label: string): number => {
  const parsed = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`M5 ${label} is outside the safe integer range`);
  }
  return parsed;
};

const statTimestamp = (value: number | bigint, label: string): number => {
  const parsed = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`M5 ${label} is outside its finite range`);
  }
  return parsed;
};

export interface M5StagingOwnershipV1 {
  readonly stagingRoot: string;
  readonly finalRoot: string;
  readonly parent: M5DirectoryIdentityV1;
  readonly staging: M5DirectoryIdentityV1;
}

const isMissing = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

const sameDirectoryIdentity = (
  expected: M5DirectoryIdentityV1,
  observed: Awaited<ReturnType<typeof lstat>>,
): boolean =>
  observed.isDirectory() &&
  !observed.isSymbolicLink() &&
  observed.dev === expected.dev &&
  observed.ino === expected.ino &&
  observed.mode === expected.mode &&
  observed.uid === expected.uid &&
  observed.birthtimeMs === expected.birthtimeMs;

const directoryIdentity = (
  metadata: Awaited<ReturnType<typeof lstat>>,
): M5DirectoryIdentityV1 => ({
  dev: statNumber(metadata.dev, "directory device identity"),
  ino: statNumber(metadata.ino, "directory inode identity"),
  mode: statNumber(metadata.mode, "directory mode"),
  uid: statNumber(metadata.uid, "directory owner"),
  birthtimeMs: statTimestamp(metadata.birthtimeMs, "directory birth time"),
});

export interface M5OwnedTemporaryDirectoryV1 {
  readonly root: string;
  readonly role: "runtime" | "agent";
  readonly parent: M5DirectoryIdentityV1;
  readonly directory: M5DirectoryIdentityV1;
}

const temporaryDirectoryPrefix = (
  role: M5OwnedTemporaryDirectoryV1["role"],
): string => `chronorift-m5-${role}-`;

export async function createM5OwnedTemporaryDirectoryV1(
  parentRoot: string,
  role: M5OwnedTemporaryDirectoryV1["role"],
): Promise<M5OwnedTemporaryDirectoryV1> {
  const parent = resolve(parentRoot);
  const parentMetadata = await lstat(parent);
  if (
    parent === dirname(parent) ||
    parentMetadata.isSymbolicLink() ||
    !parentMetadata.isDirectory() ||
    resolve(await realpath(parent)) !== parent
  ) {
    throw new Error("M5 temporary parent must be a canonical real directory");
  }
  const root = await mkdtemp(join(parent, temporaryDirectoryPrefix(role)));
  const metadata = await lstat(root);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error("M5 temporary directory could not be bound after creation");
  }
  return Object.freeze({
    root,
    role,
    parent: directoryIdentity(parentMetadata),
    directory: directoryIdentity(metadata),
  });
}

const requireOwnedTemporaryDirectory = async (
  ownership: M5OwnedTemporaryDirectoryV1,
): Promise<void> => {
  const root = resolve(ownership.root);
  const parent = dirname(root);
  if (
    parent === dirname(parent) ||
    !basename(root).startsWith(temporaryDirectoryPrefix(ownership.role))
  ) {
    throw new Error("M5 temporary ownership path is not narrowly scoped");
  }
  const [parentMetadata, directoryMetadata] = await Promise.all([
    lstat(parent),
    lstat(root),
  ]);
  if (
    !sameDirectoryIdentity(ownership.parent, parentMetadata) ||
    !sameDirectoryIdentity(ownership.directory, directoryMetadata)
  ) {
    throw new Error("M5 temporary directory ownership identity changed");
  }
};

export async function removeM5OwnedTemporaryDirectoryV1(
  ownership: M5OwnedTemporaryDirectoryV1,
): Promise<void> {
  try {
    await requireOwnedTemporaryDirectory(ownership);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  await rm(resolve(ownership.root), { recursive: true, force: false });
}

export async function createM5StagingRootV1(
  finalRoot: string,
): Promise<M5StagingOwnershipV1> {
  const absoluteFinal = resolve(finalRoot);
  const parent = dirname(absoluteFinal);
  const parentMetadata = await lstat(parent);
  if (
    parentMetadata.isSymbolicLink() ||
    !parentMetadata.isDirectory() ||
    resolve(await realpath(parent)) !== parent ||
    parent === dirname(parent) ||
    basename(absoluteFinal).length === 0
  ) {
    throw new Error("M5 evidence parent must be a canonical real directory");
  }
  try {
    await lstat(absoluteFinal);
    throw new Error("M5 final evidence root already exists");
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const stagingRoot = join(
    parent,
    `.${basename(absoluteFinal)}.staging-${randomUUID().replaceAll("-", "")}`,
  );
  await mkdir(stagingRoot, { mode: 0o700 });
  const stagingMetadata = await lstat(stagingRoot);
  if (
    stagingMetadata.isSymbolicLink() ||
    !stagingMetadata.isDirectory() ||
    stagingMetadata.nlink < 2
  ) {
    throw new Error("M5 staging root could not be bound after creation");
  }
  return Object.freeze({
    stagingRoot,
    finalRoot: absoluteFinal,
    parent: directoryIdentity(parentMetadata),
    staging: directoryIdentity(stagingMetadata),
  });
}

const requireStagingOwnership = async (
  ownership: M5StagingOwnershipV1,
): Promise<void> => {
  const stagingRoot = resolve(ownership.stagingRoot);
  const finalRoot = resolve(ownership.finalRoot);
  if (
    dirname(stagingRoot) !== dirname(finalRoot) ||
    stagingRoot === finalRoot
  ) {
    throw new Error("M5 staging publication must stay within one parent");
  }
  if (
    !basename(stagingRoot).startsWith(`.${basename(finalRoot)}.staging-`) ||
    dirname(stagingRoot) === dirname(dirname(stagingRoot))
  ) {
    throw new Error("M5 staging ownership path is not narrowly scoped");
  }
  const [parentMetadata, stagingMetadata] = await Promise.all([
    lstat(dirname(stagingRoot)),
    lstat(stagingRoot),
  ]);
  if (
    !sameDirectoryIdentity(ownership.parent, parentMetadata) ||
    !sameDirectoryIdentity(ownership.staging, stagingMetadata)
  ) {
    throw new Error("M5 staging ownership identity changed");
  }
};

export async function publishM5StagingRootV1(
  ownership: M5StagingOwnershipV1,
): Promise<void> {
  await requireStagingOwnership(ownership);
  const stagingRoot = resolve(ownership.stagingRoot);
  const finalRoot = resolve(ownership.finalRoot);
  try {
    await lstat(finalRoot);
    throw new Error("M5 final evidence root already exists");
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  await rename(stagingRoot, finalRoot);
}

export async function removeM5StagingRootV1(
  ownership: M5StagingOwnershipV1,
): Promise<void> {
  try {
    await requireStagingOwnership(ownership);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  await rm(resolve(ownership.stagingRoot), { recursive: true, force: false });
}

export interface M5OwnershipFinalizerV1 {
  readonly primaryFailure?: unknown;
  readonly taskMayExist: boolean;
  readonly taskDiscarded: boolean;
  readonly published: boolean;
  readonly discard?: (() => Promise<void>) | undefined;
  readonly removeRuntime?: (() => Promise<void>) | undefined;
  readonly removeAgent?: (() => Promise<void>) | undefined;
  readonly removeStaging?: (() => Promise<void>) | undefined;
}

/**
 * Resolves only when every applicable ownership cleanup succeeded and there was
 * no primary failure. A failed discard deliberately preserves the Task runtime,
 * but it never preserves an unpublished evidence staging directory.
 */
export async function finalizeM5OwnershipV1(
  input: M5OwnershipFinalizerV1,
): Promise<void> {
  const failures: unknown[] = [];
  if (input.primaryFailure !== undefined) failures.push(input.primaryFailure);
  let taskMayExist = input.taskMayExist;
  let taskDiscarded = input.taskDiscarded;
  if (taskMayExist && !taskDiscarded && input.discard !== undefined) {
    try {
      await input.discard();
      taskDiscarded = true;
      taskMayExist = false;
    } catch (error) {
      failures.push(error);
    }
  }
  if (input.removeAgent !== undefined) {
    try {
      await input.removeAgent();
    } catch (error) {
      failures.push(error);
    }
  }
  if ((!taskMayExist || taskDiscarded) && input.removeRuntime !== undefined) {
    try {
      await input.removeRuntime();
    } catch (error) {
      failures.push(error);
    }
  }
  if (!input.published && input.removeStaging !== undefined) {
    try {
      await input.removeStaging();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, "M5 live ownership finalization failed");
  }
}

const M5ArtifactReferenceV1Schema = z
  .object({
    relativePath: z
      .string()
      .regex(
        /^(?!\/)(?!.*\/\/)(?!.*(?:^|\/)(?:\.|\.\.|\.git)(?:\/|$))[A-Za-z0-9._/-]{1,512}$/u,
      ),
    rawSha256: Sha256DigestV1Schema,
  })
  .strict();

const M5_ACTIVE_TOOLS_V1 = Object.freeze([
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
  ...SEMANTIC_GAME_TOOL_NAMES_V1,
] as const);

export interface M5AgentEvidenceV1 {
  readonly provider: "openai-codex";
  readonly model: "gpt-5.6-luna";
  readonly thinkingLevel: "max";
  readonly attemptOrdinal: 1;
  readonly turnCount: 1;
  readonly loopStatus: "completed";
  readonly requestedTaskSandboxNetworkMode: "denied";
  readonly hostModelNetworkPolicy: "provider_only";
  readonly taskCredentialMountCountMaximum: 0;
  readonly totalToolCallCount: number;
  readonly activeTools: readonly string[];
}

export async function readM5AgentEvidenceV1(input: {
  readonly runtimeRoot: string;
  readonly taskId: TaskId;
  readonly taskSpec: M5TaskSpecV1;
}): Promise<M5AgentEvidenceV1> {
  const spec = M5TaskSpecV1Schema.parse(input.taskSpec);
  const turns = await new VNextTaskStore(input.runtimeRoot).readLedger(
    input.taskId,
    "agent-turns.jsonl",
    (value) => VNextAgentTurnV1Schema.parse(value),
  );
  const turn = turns[0];
  if (
    turns.length !== 1 ||
    turn === undefined ||
    turn.turn !== 1 ||
    turn.kind !== "start" ||
    turn.status !== "completed" ||
    turn.provider !== spec.agentBudget.provider ||
    turn.model !== spec.agentBudget.model ||
    turn.requestedThinkingLevel !== spec.agentBudget.thinkingLevel ||
    turn.realizedThinkingLevel !== spec.agentBudget.thinkingLevel ||
    turn.prompt !== spec.prompt ||
    turn.stats.toolCalls < 1 ||
    turn.stats.toolCalls > spec.agentBudget.toolCallsMaximum ||
    turn.activeTools.length !== M5_ACTIVE_TOOLS_V1.length ||
    turn.activeTools.some(
      (toolName, index) => toolName !== M5_ACTIVE_TOOLS_V1[index],
    )
  ) {
    throw new Error("M5 Agent evidence does not match its frozen single turn");
  }
  return Object.freeze({
    provider: "openai-codex",
    model: "gpt-5.6-luna",
    thinkingLevel: "max",
    attemptOrdinal: 1,
    turnCount: 1,
    loopStatus: "completed",
    requestedTaskSandboxNetworkMode: "denied",
    hostModelNetworkPolicy: "provider_only",
    taskCredentialMountCountMaximum: 0,
    totalToolCallCount: turn.stats.toolCalls,
    activeTools: Object.freeze([...turn.activeTools]),
  });
}

export interface M5SandboxRealizationV1 {
  readonly policyId: string;
  readonly operationCount: number;
}

export async function readM5SandboxRealizationV1(input: {
  readonly runtimeRoot: string;
  readonly taskId: TaskId;
}): Promise<M5SandboxRealizationV1> {
  const store = new VNextTaskStore(input.runtimeRoot);
  const [policy, operations] = await Promise.all([
    store.readJson(input.taskId, "sandbox-policy.json", (value) =>
      SandboxPolicySchema.parse(value),
    ),
    store.readLedger(input.taskId, "sandbox-operations.jsonl", (value) =>
      SandboxOperationRecordV1Schema.parse(value),
    ),
  ]);
  if (
    policy.network !== "isolated" ||
    !policy.namespaces.includes("network") ||
    policy.copiedEnvironmentKeys[0] !== "CI" ||
    policy.copiedEnvironmentKeys[1] !== "NO_COLOR" ||
    operations.length === 0 ||
    operations.some((operation) => {
      const admission = operation.receipt.mountAdmission;
      const cleanup = operation.receipt.cleanup;
      const mechanisms = operation.receipt.realizedMechanisms;
      const usage = operation.receipt.resourceUsage;
      return (
        operation.taskId !== input.taskId ||
        operation.receipt.policyId !== policy.policyId ||
        admission === undefined ||
        admission.credentialTargetCount !== 0 ||
        cleanup.processGroupTerminated !== true ||
        cleanup.cgroupPopulated !== false ||
        cleanup.scopeRemoved !== true ||
        cleanup.storageReconciled === false ||
        mechanisms.aggregateStorage !==
          "dedicated-capacity-bounded-filesystem-v1" ||
        mechanisms.unavailable.length !== 0 ||
        usage.aggregateStorage === undefined
      );
    })
  ) {
    throw new Error("M5 sandbox realization is incomplete or not isolated");
  }
  return Object.freeze({
    policyId: policy.policyId,
    operationCount: operations.length,
  });
}

export interface M5PostDiscardIsolationV1 {
  readonly boundedTaskStorageEmpty: true;
  readonly taskCgroupLeavesEmpty: true;
}

export async function requireM5PostDiscardIsolationV1(input: {
  readonly taskStorageRoot: string;
  readonly taskCgroupRoot: string;
}): Promise<M5PostDiscardIsolationV1> {
  const [storageMetadata, cgroupMetadata] = await Promise.all([
    lstat(resolve(input.taskStorageRoot)),
    lstat(resolve(input.taskCgroupRoot)),
  ]);
  if (
    storageMetadata.isSymbolicLink() ||
    !storageMetadata.isDirectory() ||
    cgroupMetadata.isSymbolicLink() ||
    !cgroupMetadata.isDirectory()
  ) {
    throw new Error("M5 cleanup roots must remain real directories");
  }
  const [storageEntries, cgroupEntries, cgroupEvents] = await Promise.all([
    readdir(resolve(input.taskStorageRoot)),
    readdir(resolve(input.taskCgroupRoot), { withFileTypes: true }),
    readFile(join(resolve(input.taskCgroupRoot), "cgroup.events"), "utf8"),
  ]);
  const populated = cgroupEvents
    .split("\n")
    .map((line) => line.trim().split(/\s+/u))
    .find(([name]) => name === "populated");
  if (
    storageEntries.length !== 0 ||
    cgroupEntries.some((entry) => entry.isDirectory()) ||
    populated?.length !== 2 ||
    populated[1] !== "0"
  ) {
    throw new Error(
      "M5 post-discard Task storage or cgroup leaves are not empty",
    );
  }
  return Object.freeze({
    boundedTaskStorageEmpty: true,
    taskCgroupLeavesEmpty: true,
  });
}

export const M5CleanupReceiptV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    receiptKind: z.literal("chronorift-m5-task-discard-cleanup"),
    taskSpecSha256: Sha256DigestV1Schema,
    taskId: z.string().min(1),
    taskNamespaceDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    patchId: z.string().startsWith("patch:v1:"),
    baselineSourceHash: Sha256DigestV1Schema,
    candidateSourceHash: Sha256DigestV1Schema,
    baselineExecutionId: z.string().min(1).max(256),
    candidateExecutionId: z.string().min(1).max(256),
    processGroupTerminated: z.literal(true),
    cgroupPopulated: z.literal(false),
    termSent: z.boolean(),
    killSent: z.boolean(),
    scopeRemoved: z.literal(true),
    storageReconciled: z.literal(true),
    taskRootRemoved: z.literal(true),
    boundedTaskStorageEmpty: z.literal(true),
    taskCgroupLeavesEmpty: z.literal(true),
    sourceUnchanged: z.literal(true),
    receiptContentSha256: Sha256DigestV1Schema,
  })
  .strict()
  .superRefine((value, context) => {
    const { receiptContentSha256, ...basis } = value;
    if (receiptContentSha256 !== contentHash(basis)) {
      context.addIssue({
        code: "custom",
        path: ["receiptContentSha256"],
        message: "cleanup receipt content hash does not match",
        input: receiptContentSha256,
      });
    }
  });
export type M5CleanupReceiptV1 = z.infer<typeof M5CleanupReceiptV1Schema>;

export function createM5CleanupReceiptV1(input: {
  readonly taskId: TaskId;
  readonly taskSpecSha256: Sha256DigestV1;
  readonly patchIdentity: TaskPatchIdentityV1;
  readonly selection: M5SelectedExecutionEvidenceV1;
  readonly cleanup: SandboxCleanupReceiptV1;
  readonly taskRootRemoved: boolean;
  readonly postDiscardIsolation: M5PostDiscardIsolationV1;
  readonly sourceUnchanged: boolean;
}): M5CleanupReceiptV1 {
  const patch = TaskPatchIdentityV1Schema.parse(input.patchIdentity);
  const cleanup = SandboxCleanupReceiptV1Schema.parse(input.cleanup);
  const basis = {
    schemaVersion: 1,
    receiptKind: "chronorift-m5-task-discard-cleanup",
    taskSpecSha256: input.taskSpecSha256,
    taskId: input.taskId,
    taskNamespaceDigest: taskNamespaceDigestV1(input.taskId),
    patchId: patch.patchId,
    baselineSourceHash: patch.baselineSourceHash,
    candidateSourceHash: patch.candidateSourceHash,
    baselineExecutionId: input.selection.baseline.execution.executionId,
    candidateExecutionId: input.selection.candidate.execution.executionId,
    processGroupTerminated: cleanup.processGroupTerminated,
    cgroupPopulated: cleanup.cgroupPopulated,
    termSent: cleanup.termSent,
    killSent: cleanup.killSent,
    scopeRemoved: cleanup.scopeRemoved,
    storageReconciled: cleanup.storageReconciled,
    taskRootRemoved: input.taskRootRemoved,
    boundedTaskStorageEmpty: input.postDiscardIsolation.boundedTaskStorageEmpty,
    taskCgroupLeavesEmpty: input.postDiscardIsolation.taskCgroupLeavesEmpty,
    sourceUnchanged: input.sourceUnchanged,
  } as const;
  return M5CleanupReceiptV1Schema.parse({
    ...basis,
    receiptContentSha256: contentHash(basis as never),
  });
}

export const M5ProductSubjectV1Schema = z
  .object({
    repositoryCommit: z.string().regex(/^[a-f0-9]{40}$/u),
    repositoryTree: z.string().regex(/^[a-f0-9]{40}$/u),
    clean: z.literal(true),
  })
  .strict();
export type M5ProductSubjectV1 = z.infer<typeof M5ProductSubjectV1Schema>;

const M5ExecutionArtifactsV1Schema = z
  .object({
    expectedSourceHash: Sha256DigestV1Schema,
    build: M5ArtifactReferenceV1Schema,
    runtime: M5ArtifactReferenceV1Schema,
    execution: M5ArtifactReferenceV1Schema,
    events: M5ArtifactReferenceV1Schema,
    executionSeal: M5ArtifactReferenceV1Schema,
  })
  .strict();

export const M5EvidenceSummaryV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    evidenceKind: z.literal(
      "chronorift-m5-public-exposed-behavior-change-conformance",
    ),
    taskClassification: z.literal("public_exposed_behavior_change_conformance"),
    taskSpecSha256: Sha256DigestV1Schema,
    taskId: z.string().min(1).max(256),
    claimsExcluded: M5ClaimsExcludedV1Schema,
    agent: z
      .object({
        provider: z.literal("openai-codex"),
        model: z.literal("gpt-5.6-luna"),
        thinkingLevel: z.literal("max"),
        attemptOrdinal: z.literal(1),
        turnCount: z.literal(1),
        loopStatus: z.literal("completed"),
        requestedTaskSandboxNetworkMode: z.literal("denied"),
        hostModelNetworkPolicy: z.literal("provider_only"),
        taskCredentialMountCountMaximum: z.literal(0),
        totalToolCallCount: z.number().int().min(1).max(128),
        activeTools: exactOrderedStrings(M5_ACTIVE_TOOLS_V1),
      })
      .strict(),
    productSubject: M5ProductSubjectV1Schema,
    toolchain: z
      .object({
        nodeVersion: z.literal("v22.23.1"),
        godotVersion: z.literal("4.7.1.stable.official.a13da4feb"),
      })
      .strict(),
    source: z
      .object({
        declaredUrl: z.string().min(1),
        headCommit: z.string().regex(/^[a-f0-9]{40}$/u),
        gitTreeObjectId: z.string().regex(/^[a-f0-9]{40}$/u),
        baselineSelectedTreeSha256: Sha256DigestV1Schema,
        hostUnchangedAfterTask: z.literal(true),
      })
      .strict(),
    semanticProfile: z
      .object({
        taskProfile: z.literal("godot-external-semantic-v1"),
        protocolProfile: z.literal("chronorift-godot-semantic-v1"),
        adapterProfileSha256: Sha256DigestV1Schema,
        targetScene: z.string().startsWith("res://"),
      })
      .strict(),
    patch: z
      .object({
        identity: TaskPatchIdentityV1Schema,
        artifact: M5ArtifactReferenceV1Schema,
        exportReceipt: M5ArtifactReferenceV1Schema,
        changedPaths: z.array(z.string().min(1).max(512)).min(1).max(10_000),
        roundTripSelectedTreeSha256: Sha256DigestV1Schema,
        roundTripVerified: z.literal(true),
      })
      .strict(),
    executions: z
      .object({
        baseline: M5ExecutionArtifactsV1Schema,
        candidate: M5ExecutionArtifactsV1Schema,
      })
      .strict(),
    cleanup: M5ArtifactReferenceV1Schema,
    summaryContentSha256: Sha256DigestV1Schema,
  })
  .strict()
  .superRefine((value, context) => {
    const { summaryContentSha256, ...basis } = value;
    if (summaryContentSha256 !== contentHash(basis as never)) {
      context.addIssue({
        code: "custom",
        path: ["summaryContentSha256"],
        message: "summary content hash does not match",
        input: summaryContentSha256,
      });
    }
  });
export type M5EvidenceSummaryV1 = z.infer<typeof M5EvidenceSummaryV1Schema>;

export function createM5EvidenceSummaryV1(input: {
  readonly taskSpec: M5TaskSpecV1;
  readonly taskSpecSha256: Sha256DigestV1;
  readonly taskId: TaskId;
  readonly agent: M5AgentEvidenceV1;
  readonly productSubject: M5ProductSubjectV1;
  readonly patchIdentity: TaskPatchIdentityV1;
  readonly patchArtifact: M5ArtifactReferenceV1;
  readonly exportReceiptArtifact: M5ArtifactReferenceV1;
  readonly changedPaths: readonly string[];
  readonly runtimeArtifacts: {
    readonly baseline: M5RuntimeArtifactReferencesV1;
    readonly candidate: M5RuntimeArtifactReferencesV1;
  };
  readonly cleanupArtifact: M5ArtifactReferenceV1;
}): M5EvidenceSummaryV1 {
  const spec = M5TaskSpecV1Schema.parse(input.taskSpec);
  const patch = TaskPatchIdentityV1Schema.parse(input.patchIdentity);
  const basis = {
    schemaVersion: 1,
    evidenceKind: "chronorift-m5-public-exposed-behavior-change-conformance",
    taskClassification: spec.taskClassification,
    taskSpecSha256: input.taskSpecSha256,
    taskId: input.taskId,
    claimsExcluded: [...spec.claimsExcluded],
    agent: input.agent,
    productSubject: M5ProductSubjectV1Schema.parse(input.productSubject),
    toolchain: spec.toolchain,
    source: {
      declaredUrl: spec.source.declaredUrl,
      headCommit: spec.source.headCommit,
      gitTreeObjectId: spec.source.gitTreeObjectId,
      baselineSelectedTreeSha256: spec.source.selectedTreeSha256,
      hostUnchangedAfterTask: true,
    },
    semanticProfile: {
      taskProfile: spec.semanticProfile.taskProfile,
      protocolProfile: spec.semanticProfile.protocolProfile,
      adapterProfileSha256: spec.semanticProfile.adapterProfileCanonicalSha256,
      targetScene: spec.semanticProfile.targetScene,
    },
    patch: {
      identity: patch,
      artifact: M5ArtifactReferenceV1Schema.parse(input.patchArtifact),
      exportReceipt: M5ArtifactReferenceV1Schema.parse(
        input.exportReceiptArtifact,
      ),
      changedPaths: [...input.changedPaths],
      roundTripSelectedTreeSha256: patch.candidateSourceHash,
      roundTripVerified: true,
    },
    executions: {
      baseline: {
        expectedSourceHash: patch.baselineSourceHash,
        ...input.runtimeArtifacts.baseline,
      },
      candidate: {
        expectedSourceHash: patch.candidateSourceHash,
        ...input.runtimeArtifacts.candidate,
      },
    },
    cleanup: M5ArtifactReferenceV1Schema.parse(input.cleanupArtifact),
  } as const;
  return M5EvidenceSummaryV1Schema.parse({
    ...basis,
    summaryContentSha256: contentHash(basis as never),
  });
}

export const M5EvidenceManifestV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    bundleKind: z.literal("chronorift-m5-evidence-bundle"),
    taskSpecSha256: Sha256DigestV1Schema,
    taskId: z.string().min(1).max(256),
    productSubject: M5ProductSubjectV1Schema,
    artifacts: z.array(M5ArtifactReferenceV1Schema).length(14),
    manifestContentSha256: Sha256DigestV1Schema,
  })
  .strict()
  .superRefine((value, context) => {
    const { manifestContentSha256, ...basis } = value;
    if (manifestContentSha256 !== contentHash(basis)) {
      context.addIssue({
        code: "custom",
        path: ["manifestContentSha256"],
        message: "manifest content hash does not match",
        input: manifestContentSha256,
      });
    }
  });
export type M5EvidenceManifestV1 = z.infer<typeof M5EvidenceManifestV1Schema>;

const artifactRef = (
  references: readonly M5ArtifactReferenceV1[],
  relativePath: string,
): M5ArtifactReferenceV1 => {
  const reference = references.find(
    (candidate) => candidate.relativePath === relativePath,
  );
  if (reference === undefined) {
    throw new Error(`M5 artifact reference is missing: ${relativePath}`);
  }
  return reference;
};

export function createM5EvidenceManifestV1(input: {
  readonly taskSpecSha256: Sha256DigestV1;
  readonly taskId: TaskId;
  readonly productSubject: M5ProductSubjectV1;
  readonly artifacts: readonly M5ArtifactReferenceV1[];
}): M5EvidenceManifestV1 {
  const expected = [
    "candidate.patch",
    "cleanup-receipt.json",
    "patch-export-receipt.json",
    "runtime-records/baseline/build.json",
    "runtime-records/baseline/events.jsonl",
    "runtime-records/baseline/execution-seal.json",
    "runtime-records/baseline/execution.json",
    "runtime-records/baseline/runtime.json",
    "runtime-records/candidate/build.json",
    "runtime-records/candidate/events.jsonl",
    "runtime-records/candidate/execution-seal.json",
    "runtime-records/candidate/execution.json",
    "runtime-records/candidate/runtime.json",
    "summary.json",
  ] as const;
  const ordered = expected.map((path) => artifactRef(input.artifacts, path));
  if (
    new Set(input.artifacts.map((reference) => reference.relativePath)).size !==
      expected.length ||
    input.artifacts.length !== expected.length
  ) {
    throw new Error("M5 manifest must inventory exactly fourteen artifacts");
  }
  const basis = {
    schemaVersion: 1,
    bundleKind: "chronorift-m5-evidence-bundle",
    taskSpecSha256: input.taskSpecSha256,
    taskId: input.taskId,
    productSubject: M5ProductSubjectV1Schema.parse(input.productSubject),
    artifacts: ordered,
  } as const;
  return M5EvidenceManifestV1Schema.parse({
    ...basis,
    manifestContentSha256: contentHash(basis as never),
  });
}

export async function writeM5CanonicalArtifactV1(input: {
  readonly stagingRoot: string;
  readonly relativePath: string;
  readonly value: unknown;
}): Promise<M5ArtifactReferenceV1> {
  const parsedPath = M5ArtifactReferenceV1Schema.shape.relativePath.parse(
    input.relativePath,
  );
  const bytes = Buffer.from(`${canonicalJson(input.value as never)}\n`, "utf8");
  await writeCreateNew(join(resolve(input.stagingRoot), parsedPath), bytes);
  return Object.freeze({
    relativePath: parsedPath,
    rawSha256: sha256Bytes(bytes),
  });
}

export const writeM5JsonCreateNewV1 = async (
  path: string,
  value: unknown,
): Promise<void> =>
  writeCreateNew(
    path,
    Buffer.from(`${canonicalJson(value as never)}\n`, "utf8"),
  );

export const readM5PatchIdentityV1 = async (input: {
  readonly runtimeRoot: string;
  readonly taskId: TaskId;
}): Promise<TaskPatchIdentityV1> => {
  const store = new VNextTaskStore(input.runtimeRoot);
  return store.readJson(input.taskId, "patch.json", (value) =>
    TaskPatchIdentityV1Schema.parse(value),
  );
};

export const readM5ExportedPatchV1 = (stagingRoot: string): Promise<Buffer> =>
  readBoundedRegularFile(
    join(resolve(stagingRoot), "candidate.patch"),
    512 * 1024 * 1024,
  );
