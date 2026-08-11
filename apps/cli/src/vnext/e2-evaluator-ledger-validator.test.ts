import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

type JsonObject = Record<string, unknown>;

type ArtifactReference = {
  readonly relativePath: string;
  readonly rawSha256: string;
};

type AgentOutcome =
  "budget_exceeded" | "candidate_produced" | "no_candidate" | "provider_failed";

type FixtureOptions = {
  readonly agentOutcome?: AgentOutcome;
  readonly baselineOnlyScenario?: boolean;
  readonly dirtyNoCandidate?: boolean;
  readonly evaluatorBudgetExceeded?: boolean;
  readonly evaluatorOverBudgetAccepted?: boolean;
  readonly hiddenRuntimeArtifactOnRetry?: boolean;
  readonly infrastructureRetry?: boolean;
  readonly infrastructureRetryProgress?: boolean;
  readonly invalidProjection?: boolean;
  readonly largeToolOverrun?: boolean;
  readonly orphanRuntimeArtifact?: boolean;
  readonly invalidCandidate?: boolean;
  readonly overBudget?: boolean;
  readonly partialAccepted?: boolean;
  readonly patchMismatch?: boolean;
  readonly runtimeCaptureLoss?: boolean;
  readonly spoofedFullIndex?: boolean;
  readonly symlinkedArtifact?: boolean;
  readonly tamperedSeal?: boolean;
  readonly unsafeArtifactPath?: boolean;
};

type EvaluationFixture = {
  readonly agentWorkspaceRoot: string;
  readonly artifactRoot: string;
  readonly baselineRoot: string;
  readonly contractPath: string;
  readonly evaluatorBundleRoot: string;
  readonly evaluatorImplementationRoot: string;
  readonly freezeRecordPath: string;
  readonly interfacePath: string;
  readonly ledgerPath: string;
  readonly validatorPath: string;
  readonly validatorRepositoryRoot: string;
};

type AssignmentIdentity = {
  readonly assignmentContentSha256: string;
  readonly assignmentId: string;
  readonly baselineSourceSha256: string;
  readonly contractSha256: string;
  readonly evaluationId: string;
  readonly evaluatorBundleSha256: string;
  readonly evaluatorImplementationSha256: string;
  readonly productCommit: string;
  readonly promptSha256: string;
  readonly taskSpecSha256: string;
};

type EvaluatorIdentity = {
  readonly assignmentId: string;
  readonly baselineSourceSha256: string;
  readonly candidatePatchSha256: string;
  readonly candidateSourceSha256: string;
  readonly contractSha256: string;
  readonly evaluationId: string;
  readonly evaluatorBundleSha256: string;
  readonly evaluatorImplementationSha256: string;
  readonly productCommit: string;
  readonly promptSha256: string;
  readonly taskSpecSha256: string;
};

const execFileAsync = promisify(execFile);
const validatorPath = resolve(
  ".github/scripts/validate-vnext-e2-evaluator-ledger.mjs",
);
const sourceFreezeRecordPath = resolve(
  "docs/evidence/vnext-e2-public-exposed-r1/freeze-record.v1.json",
);
const sourceContractPath = resolve(
  "testdata/vnext/external-project/moddable-platformer.e2-evaluation-contract.v1.json",
);
const sourceInterfacePath = resolve(
  "testdata/vnext/external-project/e2-evaluator-interface.schema.v1.json",
);
const temporaryRoots: string[] = [];

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  const record = value as JsonObject;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
};

const canonicalBytes = (value: unknown): Buffer =>
  Buffer.from(`${canonicalJson(value)}\n`, "utf8");

const sha256 = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("hex");

const contentHash = (value: unknown): string =>
  sha256(Buffer.from(canonicalJson(value), "utf8"));

const withContentHash = (value: JsonObject, field: string): JsonObject => {
  const basis = Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== field),
  );
  return { ...value, [field]: contentHash(basis) };
};

const writeCanonicalJson = async (
  path: string,
  value: unknown,
): Promise<Buffer> => {
  const bytes = canonicalBytes(value);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
  return bytes;
};

const writeOrderedJson = async (
  path: string,
  value: unknown,
): Promise<Buffer> => {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  await writeFile(path, bytes);
  return bytes;
};

const selectedTreeSha256 = async (
  root: string,
  skipSourceCaches = false,
): Promise<string> => {
  const entries: Array<{
    readonly bytes: Buffer;
    readonly mode: "100644" | "100755";
    readonly relativePath: string;
  }> = [];

  const walk = async (directory: string, prefix: string): Promise<void> => {
    const names = await readdir(directory);
    names.sort((left, right) =>
      Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")),
    );
    for (const name of names) {
      if (
        prefix.length === 0 &&
        skipSourceCaches &&
        (name === ".git" || name === ".godot")
      ) {
        continue;
      }
      const relativePath = prefix.length === 0 ? name : `${prefix}/${name}`;
      const path = join(directory, name);
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) {
        throw new Error(
          `fixture tree contains a symbolic link: ${relativePath}`,
        );
      }
      if (metadata.isDirectory()) {
        await walk(path, relativePath);
        continue;
      }
      if (!metadata.isFile()) {
        throw new Error(`fixture tree contains a non-file: ${relativePath}`);
      }
      entries.push({
        bytes: await readFile(path),
        mode: (metadata.mode & 0o111) === 0 ? "100644" : "100755",
        relativePath,
      });
    }
  };

  await walk(root, "");
  entries.sort((left, right) =>
    Buffer.compare(
      Buffer.from(left.relativePath, "utf8"),
      Buffer.from(right.relativePath, "utf8"),
    ),
  );
  const hash = createHash("sha256").update("chronorift-selected-tree-v1\0");
  for (const entry of entries) {
    const pathBytes = Buffer.from(entry.relativePath, "utf8");
    hash.update(`${pathBytes.byteLength}:`);
    hash.update(pathBytes);
    hash.update(`\0${entry.mode}\0${entry.bytes.byteLength}:`);
    hash.update(entry.bytes);
    hash.update("\0");
  }
  return hash.digest("hex");
};

const git = async (
  cwd: string,
  arguments_: readonly string[],
): Promise<string> => {
  const result = await execFileAsync("git", [...arguments_], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      LANG: "C",
      LC_ALL: "C",
    },
    maxBuffer: 16 * 1024 * 1024,
  });
  return result.stdout;
};

const artifactWriter = (root: string) => {
  const write = async (
    relativePath: string,
    bytes: Buffer,
  ): Promise<ArtifactReference> => {
    const path = join(root, ...relativePath.split("/"));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
    return { relativePath, rawSha256: sha256(bytes) };
  };
  return {
    bytes: write,
    json: (relativePath: string, value: unknown) =>
      write(relativePath, canonicalBytes(value)),
  };
};

const buildTaskSpec = (input: {
  readonly baselineSourceSha256: string;
  readonly definition: ArtifactReference;
  readonly productCommit: string;
  readonly promptSha256: string;
  readonly scenarioId: string;
  readonly sourceRole: "baseline" | "candidate";
}): JsonObject => {
  const scenarios = [
    {
      scenarioId: input.scenarioId,
      ordinal: 1,
      category: "behavior",
      sourceRole: input.sourceRole,
      definition: input.definition,
      timeoutMs: 30_000,
    },
  ];
  return {
    schemaVersion: 1,
    specKind: "chronorift-e2-holdout-task",
    curatorTaskKeySha256: sha256("fixture-curator-task-key"),
    productCommit: input.productCommit,
    baselineSourceSha256: input.baselineSourceSha256,
    promptSha256: input.promptSha256,
    scenarioPlanSha256: contentHash({ schemaVersion: 1, scenarios }),
    scenarios,
  };
};

const buildCleanupReceipt = (input: {
  readonly assignmentId: string;
  readonly attemptOrdinal: number;
  readonly evaluationId: string;
  readonly scope: "agent_attempt" | "evaluator_attempt";
}): JsonObject =>
  withContentHash(
    {
      schemaVersion: 1,
      receiptKind: "evaluation_cleanup",
      assignmentId: input.assignmentId,
      evaluationId: input.evaluationId,
      scope: input.scope,
      attemptOrdinal: input.attemptOrdinal,
      taskProcessesEmpty: true,
      taskCgroupsEmpty: true,
      taskStorageEmpty: true,
      sourceUnchanged: true,
      receiptContentSha256: "",
    },
    "receiptContentSha256",
  );

const buildAgentAttempt = (input: {
  readonly cleanupReceipt: ArtifactReference;
  readonly identity: AssignmentIdentity;
  readonly outcome: AgentOutcome;
  readonly largeToolOverrun: boolean;
  readonly overBudget: boolean;
  readonly workspacePatch: ArtifactReference;
  readonly workspaceSourceSha256: string;
}): JsonObject => {
  const candidateProduced = input.outcome === "candidate_produced";
  return withContentHash(
    {
      schemaVersion: 1,
      receiptKind: "agent_attempt",
      assignmentContentSha256: input.identity.assignmentContentSha256,
      assignmentId: input.identity.assignmentId,
      evaluationId: input.identity.evaluationId,
      contractSha256: input.identity.contractSha256,
      taskSpecSha256: input.identity.taskSpecSha256,
      promptSha256: input.identity.promptSha256,
      baselineSourceSha256: input.identity.baselineSourceSha256,
      outcome: input.outcome,
      workspaceSourceSha256: input.workspaceSourceSha256,
      workspacePatch: input.workspacePatch,
      candidateSourceSha256: candidateProduced
        ? input.workspaceSourceSha256
        : null,
      candidatePatch: candidateProduced ? input.workspacePatch : null,
      usage: {
        provider: "openai-codex",
        model: "gpt-5.6-luna",
        thinkingLevel: "max",
        attemptOrdinal: 1,
        turnCount: 1,
        hostMonotonicStartMs: 1_000,
        hostMonotonicEndMs: 2_000,
        totalToolCalls: input.largeToolOverrun ? 2_048 : 5,
        gameToolCalls: input.largeToolOverrun ? 1_024 : 2,
        piAgentAutoRetryCount: 0,
        piAgentAutoRetriesMaximumInOneCycle: 0,
        providerSdkRetriesPerCallConfiguredMaximum: 0,
        maxObservedAggregateStorageBytes: input.overBudget
          ? 1024 * 1024 * 1024 + 1
          : 1024,
        maxObservedAggregateStorageInodes: 16,
        taskSandboxNetworkMode: "denied",
        hostModelNetworkAuthorization: "provider_only",
        gitRemoteMode: "absent",
        loopStatus:
          input.outcome === "provider_failed" ? "provider_failed" : "completed",
      },
      cleanupReceipt: input.cleanupReceipt,
      receiptContentSha256: "",
    },
    "receiptContentSha256",
  );
};

const buildEvaluationRequest = (input: {
  readonly agentAttemptReceipt: ArtifactReference;
  readonly evaluatorAttemptOrdinal: number;
  readonly identity: AssignmentIdentity & EvaluatorIdentity;
  readonly previousResultContentSha256: string | null;
  readonly scenarioIds: readonly string[];
}): JsonObject =>
  withContentHash(
    {
      schemaVersion: 1,
      messageKind: "evaluation_request",
      assignmentContentSha256: input.identity.assignmentContentSha256,
      assignmentId: input.identity.assignmentId,
      evaluationId: input.identity.evaluationId,
      contractSha256: input.identity.contractSha256,
      taskSpecSha256: input.identity.taskSpecSha256,
      promptSha256: input.identity.promptSha256,
      productCommit: input.identity.productCommit,
      baselineSourceSha256: input.identity.baselineSourceSha256,
      candidateSourceSha256: input.identity.candidateSourceSha256,
      candidatePatchSha256: input.identity.candidatePatchSha256,
      evaluatorImplementationSha256:
        input.identity.evaluatorImplementationSha256,
      evaluatorBundleSha256: input.identity.evaluatorBundleSha256,
      plannedScenarioIds: input.scenarioIds,
      agentAttemptReceipt: input.agentAttemptReceipt,
      agentAttemptOrdinal: 1,
      evaluatorAttemptOrdinal: input.evaluatorAttemptOrdinal,
      previousResultContentSha256: input.previousResultContentSha256,
      requestContentSha256: "",
    },
    "requestContentSha256",
  );

const evaluatorResultIdentity = (identity: EvaluatorIdentity): JsonObject => ({
  assignmentId: identity.assignmentId,
  evaluationId: identity.evaluationId,
  contractSha256: identity.contractSha256,
  taskSpecSha256: identity.taskSpecSha256,
  promptSha256: identity.promptSha256,
  candidateSourceSha256: identity.candidateSourceSha256,
  candidatePatchSha256: identity.candidatePatchSha256,
  evaluatorImplementationSha256: identity.evaluatorImplementationSha256,
  evaluatorBundleSha256: identity.evaluatorBundleSha256,
});

const evaluatorUsage = (ordinal: number, overBudget = false): JsonObject => ({
  hostMonotonicStartMs: ordinal * 10_000,
  hostMonotonicEndMs: ordinal * 10_000 + 1_000,
  maxObservedAggregateStorageBytes: overBudget ? 1024 * 1024 * 1024 + 1 : 4096,
  maxObservedAggregateStorageInodes: 32,
});

const buildAcceptedResult = (input: {
  readonly cleanupReceipt: ArtifactReference;
  readonly evaluatorAttemptOrdinal: number;
  readonly executionArtifacts: JsonObject;
  readonly identity: EvaluatorIdentity;
  readonly overBudget: boolean;
  readonly partialAccepted: boolean;
  readonly requestContentSha256: string;
  readonly runtimeCaptureLoss: boolean;
  readonly scenarioId: string;
}): JsonObject =>
  withContentHash(
    {
      schemaVersion: 1,
      messageKind: "evaluation_result",
      ...evaluatorResultIdentity(input.identity),
      evaluatorAttemptOrdinal: input.evaluatorAttemptOrdinal,
      requestContentSha256: input.requestContentSha256,
      outcome: "accepted",
      invalidCandidateReason: null,
      invalidCandidateReceipt: null,
      scenarioResults: [
        {
          scenarioId: input.scenarioId,
          outcome: "passed",
          failureKind: null,
          notRunReason: null,
          executionArtifacts: [input.executionArtifacts],
          coverage: input.partialAccepted ? "degraded" : "complete",
          lossObserved: input.runtimeCaptureLoss,
        },
      ],
      evaluatorUsage: evaluatorUsage(
        input.evaluatorAttemptOrdinal,
        input.overBudget,
      ),
      cleanupReceipt: input.cleanupReceipt,
      resultContentSha256: "",
    },
    "resultContentSha256",
  );

const buildInfrastructureResult = (input: {
  readonly cleanupReceipt: ArtifactReference;
  readonly evaluatorAttemptOrdinal: number;
  readonly failureCode: "evaluator_budget_exceeded" | "storage_unavailable";
  readonly identity: EvaluatorIdentity;
  readonly overBudget: boolean;
  readonly progress: boolean;
  readonly requestContentSha256: string;
  readonly retryable: boolean;
  readonly scenarioIds: readonly string[];
}): JsonObject =>
  withContentHash(
    {
      schemaVersion: 1,
      messageKind: "evaluation_result",
      ...evaluatorResultIdentity(input.identity),
      evaluatorAttemptOrdinal: input.evaluatorAttemptOrdinal,
      requestContentSha256: input.requestContentSha256,
      outcome: "infrastructure_failure",
      failureAttribution: "host_or_evaluator_infrastructure",
      stage: "persistence",
      failureCode: input.failureCode,
      retryable: input.retryable,
      completedScenarioResults: [],
      remainingScenarioIds: input.scenarioIds,
      scenarioStartedCount: input.progress ? 1 : 0,
      oracleComparisonCount: 0,
      executionCount: 0,
      evaluatorUsage: evaluatorUsage(
        input.evaluatorAttemptOrdinal,
        input.overBudget,
      ),
      cleanupReceipt: input.cleanupReceipt,
      resultContentSha256: "",
    },
    "resultContentSha256",
  );

const buildInvalidCandidateResult = (input: {
  readonly cleanupReceipt: ArtifactReference;
  readonly evaluatorAttemptOrdinal: number;
  readonly identity: EvaluatorIdentity;
  readonly invalidCandidateReceipt: ArtifactReference;
  readonly requestContentSha256: string;
  readonly scenarioId: string;
}): JsonObject =>
  withContentHash(
    {
      schemaVersion: 1,
      messageKind: "evaluation_result",
      ...evaluatorResultIdentity(input.identity),
      evaluatorAttemptOrdinal: input.evaluatorAttemptOrdinal,
      requestContentSha256: input.requestContentSha256,
      outcome: "invalid_candidate",
      invalidCandidateReason: "candidate_admission_rejected",
      invalidCandidateReceipt: input.invalidCandidateReceipt,
      scenarioResults: [
        {
          scenarioId: input.scenarioId,
          outcome: "not_run",
          failureKind: null,
          notRunReason: "invalid_candidate",
          executionArtifacts: [],
          coverage: "unavailable",
          lossObserved: false,
        },
      ],
      evaluatorUsage: evaluatorUsage(input.evaluatorAttemptOrdinal),
      cleanupReceipt: input.cleanupReceipt,
      resultContentSha256: "",
    },
    "resultContentSha256",
  );

const buildLedger = (input: {
  readonly agentAttempt: JsonObject;
  readonly agentAttemptReceipt: ArtifactReference;
  readonly assignment: AssignmentIdentity;
  readonly artifactTreeSha256: string;
  readonly evaluatorAttempts: readonly JsonObject[];
  readonly finalOutcome: string;
  readonly prompt: ArtifactReference;
  readonly productSubjectReceipt: ArtifactReference;
  readonly taskSpec: ArtifactReference;
}): JsonObject =>
  withContentHash(
    {
      schemaVersion: 1,
      messageKind: "evaluation_ledger",
      assignmentContentSha256: input.assignment.assignmentContentSha256,
      assignmentId: input.assignment.assignmentId,
      evaluationId: input.assignment.evaluationId,
      contractSha256: input.assignment.contractSha256,
      taskSpec: input.taskSpec,
      prompt: input.prompt,
      productCommit: input.assignment.productCommit,
      productSubjectReceipt: input.productSubjectReceipt,
      baselineSourceSha256: input.assignment.baselineSourceSha256,
      agentAttempt: input.agentAttempt,
      agentAttemptReceipt: input.agentAttemptReceipt,
      evaluatorImplementationSha256:
        input.assignment.evaluatorImplementationSha256,
      evaluatorBundleSha256: input.assignment.evaluatorBundleSha256,
      evaluationArtifactsSha256: input.artifactTreeSha256,
      evaluatorAttempts: input.evaluatorAttempts,
      finalOutcome: input.finalOutcome,
      allAttemptsRetained: true,
      ledgerContentSha256: "",
    },
    "ledgerContentSha256",
  );

const runtimeResourceDigest = (
  taskId: string,
  kind: string,
  resourceId: string,
): string =>
  sha256(
    Buffer.from(
      `chronorift-vnext-runtime-resource-v1\0${taskId}\0${kind}\0${resourceId}`,
      "utf8",
    ),
  );

const buildResourceEnvelope = (input: {
  readonly payload: JsonObject;
  readonly resourceId: string;
  readonly resourceKind: "build" | "execution" | "runtime";
  readonly taskId: string;
}): JsonObject => {
  const basis = {
    schemaVersion: 1,
    taskId: input.taskId,
    resourceKind: input.resourceKind,
    resourceId: input.resourceId,
    resourceDigest: runtimeResourceDigest(
      input.taskId,
      input.resourceKind,
      input.resourceId,
    ),
    payload: input.payload,
    payloadHash: contentHash(input.payload),
  };
  return { ...basis, recordHash: contentHash(basis) };
};

const buildExecutionArtifacts = async (input: {
  readonly artifact: ReturnType<typeof artifactWriter>;
  readonly attemptOrdinal: number;
  readonly candidatePatchSha256: string;
  readonly candidateSourceSha256: string;
  readonly contract: JsonObject;
  readonly invalidProjection: boolean;
  readonly runtimeCaptureLoss: boolean;
  readonly tamperedSeal: boolean;
}): Promise<JsonObject> => {
  const suffix = String(input.attemptOrdinal);
  const taskId = `task:e2-fixture:${suffix}`;
  const runtimeId = `runtime:e2-fixture:${suffix}`;
  const executionId = `execution:e2-fixture:${suffix}`;
  const outputHash = sha256(`build-output-${suffix}`);
  const buildConfigurationHash = sha256("fixture-build-configuration");
  const buildId = `build:${contentHash({
    schemaVersion: 1,
    projectHash: outputHash,
    buildConfigurationHash,
    outputHash,
  })}`;
  const workspaceId = "workspace:e2-fixture";
  const adapterId = "adapter:e2-fixture";
  const semanticAdapter = input.contract["semanticAdapter"] as JsonObject;

  const buildPayload = {
    schemaVersion: 1,
    taskId,
    workspaceId,
    sourceId: `source:${input.candidateSourceSha256}`,
    buildId,
    sourceHash: input.candidateSourceSha256,
    workspaceDiffHash: contentHash({
      schemaVersion: 1,
      baselineSourceHash: input.contract["externalSource"]
        ? (input.contract["externalSource"] as JsonObject)["selectedTreeSha256"]
        : null,
      candidateSourceHash: input.candidateSourceSha256,
    }),
    buildConfigurationHash,
    outputHash,
    createdAt: "2026-08-11T00:00:00.000Z",
  };
  const buildRecord = await input.artifact.json(
    `runtime/${suffix}/build.json`,
    buildResourceEnvelope({
      payload: buildPayload,
      resourceId: buildId,
      resourceKind: "build",
      taskId,
    }),
  );

  const projectionFor = (spawned: boolean): JsonObject => ({
    schemaVersion: 1,
    stateSchemaVersion: "chronorift.timer-spawn:v1",
    subject: {
      stableId: "semantic:subject",
      incarnation: 1,
      targetScene: input.invalidProjection
        ? "res://wrong-scene.tscn"
        : semanticAdapter["targetScene"],
      spawnIntervalSeconds: 1,
      spawnScene: "res://enemy.tscn",
    },
    timer: {
      stableId: "semantic:timer",
      incarnation: 1,
      waitTimeSeconds: 1,
      timeLeftSeconds: spawned ? 0.5 : 1,
      paused: false,
      stopped: false,
      oneShot: false,
      autostart: true,
      processCallback: "idle",
      ignoreTimeScale: false,
      timeoutOrdinal: spawned ? 1 : 0,
    },
    entities: spawned
      ? [
          {
            stableId: "semantic:spawn:0",
            incarnation: 1,
            spawnOrdinal: 0,
            scene: "res://enemy.tscn",
            parentStableId: "semantic:harness",
            transform: {
              position: { x: 0, y: 0 },
              rotation: 0,
              scale: { x: 1, y: 1 },
            },
            visible: true,
            processMode: 0,
            velocity: { x: 0, y: 0 },
          },
        ]
      : [],
    nextSpawnOrdinal: spawned ? 1 : 0,
    capturedAt: {
      processFrame: spawned ? 2 : 1,
      physicsTick: spawned ? 2 : 1,
      simulationTimeUs: spawned ? 2_000 : 1_000,
      hostMonotonicUs: spawned ? 1_002_000 : 1_001_000,
      renderFrame: null,
    },
  });
  const readyProjection = projectionFor(false);
  const projection = projectionFor(true);
  const events: JsonObject[] = [];
  let previousHash: string | null = null;
  for (const [sequence, entry] of [
    { source: "ready", projection: readyProjection },
    { source: "shutdown", projection },
  ].entries()) {
    const eventPayload = {
      schemaVersion: 1,
      eventKind: "semantic_observation",
      taskId,
      executionId,
      runtimeId,
      buildId,
      sequence,
      source: entry.source,
      hostMonotonicStartUs: 1_000_000 + sequence * 1_000,
      hostMonotonicEndUs: 1_000_100 + sequence * 1_000,
      projectionSha256: contentHash(entry.projection),
      projection: entry.projection,
    };
    const eventBasis = {
      schemaVersion: 1,
      taskId,
      executionId,
      sequence,
      previousHash,
      payload: eventPayload,
      payloadHash: contentHash(eventPayload),
    };
    const event = { ...eventBasis, recordHash: contentHash(eventBasis) };
    events.push(event);
    previousHash = event.recordHash as string;
  }
  const eventBytes = Buffer.from(
    events.map((event) => `${canonicalJson(event)}\n`).join(""),
    "utf8",
  );
  const eventLedger = await input.artifact.bytes(
    `runtime/${suffix}/events.jsonl`,
    eventBytes,
  );
  const seal = {
    schemaVersion: 1,
    taskId,
    executionId,
    count: events.length,
    headHash: input.tamperedSeal ? "f".repeat(64) : previousHash,
    byteLength: eventBytes.byteLength,
    contentHash: sha256(eventBytes),
  };
  const executionSeal = await input.artifact.json(
    `runtime/${suffix}/execution-seal.json`,
    seal,
  );

  const coverage = [
    {
      channel: "state",
      status: input.runtimeCaptureLoss ? "partial" : "full",
      emittedRecords: events.length,
      droppedRecords: 0,
      limitations: input.runtimeCaptureLoss
        ? ["Intermediate state transitions are not captured."]
        : [],
    },
  ];
  const loss: JsonObject[] = input.runtimeCaptureLoss
    ? [
        {
          channel: "state",
          kind: "observer_effect",
          count: 0,
          reason: "Endpoint-only observation omits intermediate state.",
        },
      ]
    : [];
  const runtimePayload = {
    schemaVersion: 1,
    runtimeKind: "godot_external_semantic",
    taskId,
    runtimeId,
    executionId,
    buildId,
    adapterId,
    adapterProfileSha256: semanticAdapter["profileCanonicalSha256"],
    status: "stopped",
    finalProjectionSha256: contentHash(projection),
    finalProjection: projection,
    coverage,
    loss,
    cleanupProven: true,
  };
  const runtimeRecord = await input.artifact.json(
    `runtime/${suffix}/runtime.json`,
    buildResourceEnvelope({
      payload: runtimePayload,
      resourceId: runtimeId,
      resourceKind: "runtime",
      taskId,
    }),
  );

  const executionPayload = {
    schemaVersion: 1,
    executionKind: "godot_external_semantic",
    taskId,
    executionId,
    runtimeId,
    workspaceId,
    sourceId: buildPayload.sourceId,
    buildId,
    adapterId,
    adapterProfileSha256: semanticAdapter["profileCanonicalSha256"],
    targetScene: semanticAdapter["targetScene"],
    stateSchemaVersion: "chronorift.timer-spawn:v1",
    fidelity: "descriptive_only",
    equivalentForkEligible: false,
    eventCount: events.length,
    coverage,
    loss,
    executionSeal: seal,
  };
  const executionRecord = await input.artifact.json(
    `runtime/${suffix}/execution.json`,
    buildResourceEnvelope({
      payload: executionPayload,
      resourceId: executionId,
      resourceKind: "execution",
      taskId,
    }),
  );

  return {
    runtimeTaskId: taskId,
    buildId,
    runtimeId,
    executionId,
    buildRecord,
    runtimeRecord,
    executionRecord,
    eventLedger,
    executionSeal,
  };
};

const buildFixture = async (
  options: FixtureOptions = {},
): Promise<EvaluationFixture> => {
  const root = await mkdtemp(join(tmpdir(), "chronorift-e2-evaluator-"));
  temporaryRoots.push(root);
  const baselineRoot = join(root, "baseline");
  const agentWorkspaceRoot = join(root, "workspace");
  const evaluatorImplementationRoot = join(root, "evaluator-implementation");
  const evaluatorBundleRoot = join(root, "evaluator-bundle");
  const artifactRoot = join(root, "artifacts");
  await Promise.all([
    mkdir(baselineRoot),
    mkdir(evaluatorImplementationRoot),
    mkdir(evaluatorBundleRoot),
    mkdir(artifactRoot),
  ]);

  await writeFile(
    join(baselineRoot, "source.txt"),
    "baseline source\n",
    "utf8",
  );
  await git(baselineRoot, ["init", "--quiet", "--object-format=sha1"]);
  await git(baselineRoot, ["add", "--", "source.txt"]);
  await cp(baselineRoot, agentWorkspaceRoot, { recursive: true });

  const agentOutcome = options.agentOutcome ?? "candidate_produced";
  const workspaceChanged =
    agentOutcome === "candidate_produced" || options.dirtyNoCandidate === true;
  if (workspaceChanged) {
    await writeFile(
      join(agentWorkspaceRoot, "source.txt"),
      "candidate source\n",
      "utf8",
    );
  }
  let patchText = await git(agentWorkspaceRoot, [
    "diff",
    "--binary",
    "--full-index",
    "--no-ext-diff",
    "--no-textconv",
    "--",
    "source.txt",
  ]);
  if (options.patchMismatch === true) {
    await writeFile(
      join(agentWorkspaceRoot, "source.txt"),
      "different candidate source\n",
      "utf8",
    );
    patchText = await git(agentWorkspaceRoot, [
      "diff",
      "--binary",
      "--full-index",
      "--no-ext-diff",
      "--no-textconv",
      "--",
      "source.txt",
    ]);
    await writeFile(
      join(agentWorkspaceRoot, "source.txt"),
      "candidate source\n",
      "utf8",
    );
  }
  if (options.spoofedFullIndex === true) {
    patchText = patchText.replace(
      /^index ([a-f0-9]{40})\.\.([a-f0-9]{40})(.*)$/mu,
      (_line, oldObjectId: string, newObjectId: string, suffix: string) => {
        const replacementPrefix = oldObjectId.startsWith("f") ? "e" : "f";
        return `index ${replacementPrefix}${oldObjectId.slice(1)}..${newObjectId}${suffix}`;
      },
    );
  }

  await writeFile(
    join(evaluatorImplementationRoot, "evaluate.mjs"),
    "export const evaluate = () => 'fixture';\n",
    "utf8",
  );
  const definitionBytes = canonicalBytes({
    schemaVersion: 1,
    oracle: "timer eventually spawns",
  });
  await writeFile(join(evaluatorBundleRoot, "scenario.json"), definitionBytes);

  const baselineSourceSha256 = await selectedTreeSha256(baselineRoot, true);
  const workspaceSourceSha256 = await selectedTreeSha256(
    agentWorkspaceRoot,
    true,
  );
  const evaluatorImplementationSha256 = await selectedTreeSha256(
    evaluatorImplementationRoot,
  );
  const evaluatorBundleSha256 = await selectedTreeSha256(evaluatorBundleRoot);

  const interfaceBytes = await readFile(sourceInterfacePath);
  const validatorBytes = await readFile(validatorPath);
  const interfacePath = join(root, "interface.schema.json");
  await writeFile(interfacePath, interfaceBytes);
  const contract = JSON.parse(
    await readFile(sourceContractPath, "utf8"),
  ) as JsonObject;
  (contract["externalSource"] as JsonObject)["selectedTreeSha256"] =
    baselineSourceSha256;
  const contractInterface = contract["evaluatorInterface"] as JsonObject;
  contractInterface["schemaRawSha256"] = sha256(interfaceBytes);
  contractInterface["messageValidatorRawSha256"] = sha256(validatorBytes);
  const contractPath = join(root, "evaluation-contract.json");
  const contractBytes = await writeOrderedJson(contractPath, contract);
  const contractSha256 = sha256(contractBytes);

  const freezeRecord = JSON.parse(
    await readFile(sourceFreezeRecordPath, "utf8"),
  ) as JsonObject;
  const frozenInterface = freezeRecord["evaluationContract"] as JsonObject;
  frozenInterface["rawSha256"] = contractSha256;
  frozenInterface["interfaceSchemaRawSha256"] = sha256(interfaceBytes);
  frozenInterface["messageValidatorRawSha256"] = sha256(validatorBytes);
  const freezeRecordPath = join(root, "freeze-record.json");
  const freezeRecordBytes = await writeOrderedJson(
    freezeRecordPath,
    freezeRecord,
  );

  const artifact = artifactWriter(artifactRoot);
  const prompt = await artifact.bytes(
    options.unsafeArtifactPath === true
      ? "assignment/prompt with space.txt"
      : "assignment/prompt.txt",
    Buffer.from("Repair the timer-driven enemy spawn behavior.\n", "utf8"),
  );
  const definition = {
    relativePath: "scenario.json",
    rawSha256: sha256(definitionBytes),
  };
  const scenarioId = `scenario:${sha256(
    Buffer.from(
      `chronorift-e2-scenario-id-v1\0${definition.rawSha256}`,
      "utf8",
    ),
  ).slice(0, 24)}`;
  const productSubject = contract["productSubject"] as JsonObject;
  const productCommit = productSubject["repositoryCommit"] as string;
  const taskSpecValue = buildTaskSpec({
    baselineSourceSha256,
    definition,
    productCommit,
    promptSha256: prompt.rawSha256,
    scenarioId,
    sourceRole:
      options.baselineOnlyScenario === true ? "baseline" : "candidate",
  });
  const taskSpec = await artifact.json(
    "assignment/task-spec.json",
    taskSpecValue,
  );
  const scenarios = taskSpecValue["scenarios"] as JsonObject[];
  const scenarioPlanSha256 = contentHash({ schemaVersion: 1, scenarios });
  const assignmentContentSha256 = contentHash({
    schemaVersion: 1,
    contractSha256,
    productCommit,
    baselineSourceSha256,
    taskSpecSha256: taskSpec.rawSha256,
    promptSha256: prompt.rawSha256,
    scenarioPlanSha256,
    evaluatorImplementationSha256,
    evaluatorBundleSha256,
  });
  const assignmentId = `e2-assignment:${sha256(
    Buffer.from(
      `chronorift-e2-assignment-id-v1\0${assignmentContentSha256}`,
      "utf8",
    ),
  ).slice(0, 24)}`;
  const evaluationId = `e2-evaluation:${sha256(
    Buffer.from(
      `chronorift-e2-evaluation-id-v1\0${assignmentContentSha256}`,
      "utf8",
    ),
  ).slice(0, 24)}`;
  const assignment: AssignmentIdentity = {
    assignmentContentSha256,
    assignmentId,
    baselineSourceSha256,
    contractSha256,
    evaluationId,
    evaluatorBundleSha256,
    evaluatorImplementationSha256,
    productCommit,
    promptSha256: prompt.rawSha256,
    taskSpecSha256: taskSpec.rawSha256,
  };

  const frozenProductSubject = freezeRecord["productSubject"] as JsonObject;
  const productSubjectReceipt = await artifact.json(
    "assignment/product-subject-receipt.json",
    withContentHash(
      {
        schemaVersion: 1,
        receiptKind: "product_subject_checkout",
        assignmentContentSha256,
        assignmentId,
        evaluationId,
        repositoryCommit: frozenProductSubject["repositoryCommit"],
        repositoryTree: frozenProductSubject["repositoryTree"],
        productInterfaces: freezeRecord["productInterfaces"],
        receiptContentSha256: "",
      },
      "receiptContentSha256",
    ),
  );

  const workspacePatch = await artifact.bytes(
    "agent/workspace.patch",
    Buffer.from(patchText, "utf8"),
  );
  const agentCleanupValue = buildCleanupReceipt({
    assignmentId,
    attemptOrdinal: 1,
    evaluationId,
    scope: "agent_attempt",
  });
  const agentCleanup = await artifact.json(
    "agent/cleanup.json",
    agentCleanupValue,
  );
  const agentAttempt = buildAgentAttempt({
    cleanupReceipt: agentCleanup,
    identity: assignment,
    outcome: agentOutcome,
    largeToolOverrun: options.largeToolOverrun === true,
    overBudget: options.overBudget === true,
    workspacePatch,
    workspaceSourceSha256,
  });
  const agentAttemptReceipt = await artifact.json(
    "agent/attempt.json",
    agentAttempt,
  );

  const evaluatorAttempts: JsonObject[] = [];
  if (agentOutcome === "candidate_produced") {
    const evaluatorIdentity: EvaluatorIdentity = {
      assignmentId,
      baselineSourceSha256,
      candidatePatchSha256: workspacePatch.rawSha256,
      candidateSourceSha256: workspaceSourceSha256,
      contractSha256,
      evaluationId,
      evaluatorBundleSha256,
      evaluatorImplementationSha256,
      productCommit,
      promptSha256: prompt.rawSha256,
      taskSpecSha256: taskSpec.rawSha256,
    };
    let previousResultContentSha256: string | null = null;
    if (options.infrastructureRetry === true) {
      const request = buildEvaluationRequest({
        agentAttemptReceipt,
        evaluatorAttemptOrdinal: 1,
        identity: { ...assignment, ...evaluatorIdentity },
        previousResultContentSha256,
        scenarioIds: [scenarioId],
      });
      const requestReceipt = await artifact.json(
        "evaluator/1/request.json",
        request,
      );
      const cleanup = await artifact.json(
        "evaluator/1/cleanup.json",
        buildCleanupReceipt({
          assignmentId,
          attemptOrdinal: 1,
          evaluationId,
          scope: "evaluator_attempt",
        }),
      );
      const result = buildInfrastructureResult({
        cleanupReceipt: cleanup,
        evaluatorAttemptOrdinal: 1,
        failureCode: "storage_unavailable",
        identity: evaluatorIdentity,
        overBudget: false,
        progress: options.infrastructureRetryProgress === true,
        requestContentSha256: request["requestContentSha256"] as string,
        retryable: true,
        scenarioIds: [scenarioId],
      });
      const resultReceipt = await artifact.json(
        "evaluator/1/result.json",
        result,
      );
      evaluatorAttempts.push({
        request,
        requestReceipt,
        result,
        resultReceipt,
      });
      if (options.hiddenRuntimeArtifactOnRetry === true) {
        await artifact.json("runtime/1/hidden.json", {
          schemaVersion: 1,
          retainedButUnreferenced: true,
        });
      }
      previousResultContentSha256 = result["resultContentSha256"] as string;
    }

    const ordinal = evaluatorAttempts.length + 1;
    const request = buildEvaluationRequest({
      agentAttemptReceipt,
      evaluatorAttemptOrdinal: ordinal,
      identity: { ...assignment, ...evaluatorIdentity },
      previousResultContentSha256,
      scenarioIds: [scenarioId],
    });
    const requestReceipt = await artifact.json(
      `evaluator/${ordinal}/request.json`,
      request,
    );
    const cleanup = await artifact.json(
      `evaluator/${ordinal}/cleanup.json`,
      buildCleanupReceipt({
        assignmentId,
        attemptOrdinal: ordinal,
        evaluationId,
        scope: "evaluator_attempt",
      }),
    );
    let result: JsonObject;
    if (options.evaluatorBudgetExceeded === true) {
      result = buildInfrastructureResult({
        cleanupReceipt: cleanup,
        evaluatorAttemptOrdinal: ordinal,
        failureCode: "evaluator_budget_exceeded",
        identity: evaluatorIdentity,
        overBudget: true,
        progress: false,
        requestContentSha256: request["requestContentSha256"] as string,
        retryable: false,
        scenarioIds: [scenarioId],
      });
    } else if (options.invalidCandidate === true) {
      const invalidCandidateReceipt = await artifact.json(
        `evaluator/${ordinal}/invalid-candidate.json`,
        withContentHash(
          {
            schemaVersion: 1,
            receiptKind: "candidate_admission",
            assignmentId,
            evaluationId,
            candidateSourceSha256: evaluatorIdentity.candidateSourceSha256,
            candidatePatchSha256: evaluatorIdentity.candidatePatchSha256,
            evaluatorImplementationSha256,
            evaluatorBundleSha256,
            status: "rejected",
            reason: "candidate_admission_rejected",
            receiptContentSha256: "",
          },
          "receiptContentSha256",
        ),
      );
      result = buildInvalidCandidateResult({
        cleanupReceipt: cleanup,
        evaluatorAttemptOrdinal: ordinal,
        identity: evaluatorIdentity,
        invalidCandidateReceipt,
        requestContentSha256: request["requestContentSha256"] as string,
        scenarioId,
      });
    } else {
      const executionArtifacts = await buildExecutionArtifacts({
        artifact,
        attemptOrdinal: ordinal,
        candidatePatchSha256: workspacePatch.rawSha256,
        candidateSourceSha256: workspaceSourceSha256,
        contract,
        invalidProjection: options.invalidProjection === true,
        runtimeCaptureLoss: options.runtimeCaptureLoss === true,
        tamperedSeal: options.tamperedSeal === true,
      });
      result = buildAcceptedResult({
        cleanupReceipt: cleanup,
        evaluatorAttemptOrdinal: ordinal,
        executionArtifacts,
        identity: evaluatorIdentity,
        overBudget: options.evaluatorOverBudgetAccepted === true,
        partialAccepted: options.partialAccepted === true,
        requestContentSha256: request["requestContentSha256"] as string,
        runtimeCaptureLoss: options.runtimeCaptureLoss === true,
        scenarioId,
      });
    }
    const resultReceipt = await artifact.json(
      `evaluator/${ordinal}/result.json`,
      result,
    );
    evaluatorAttempts.push({
      request,
      requestReceipt,
      result,
      resultReceipt,
    });
  }

  const finalOutcome =
    agentOutcome === "candidate_produced"
      ? options.evaluatorBudgetExceeded === true
        ? "infrastructure_failure"
        : options.invalidCandidate === true
          ? "invalid_candidate"
          : "accepted"
      : agentOutcome === "provider_failed"
        ? "agent_provider_failed"
        : agentOutcome === "budget_exceeded"
          ? "agent_budget_exceeded"
          : "agent_no_candidate";
  if (options.orphanRuntimeArtifact === true) {
    await artifact.json("runtime/1/orphan.json", {
      schemaVersion: 1,
      retainedButUnowned: true,
    });
  }
  const artifactTreeSha256 = await selectedTreeSha256(artifactRoot);
  const ledger = buildLedger({
    agentAttempt,
    agentAttemptReceipt,
    assignment,
    artifactTreeSha256,
    evaluatorAttempts,
    finalOutcome,
    prompt,
    productSubjectReceipt,
    taskSpec,
  });
  const ledgerPath = join(root, "evaluation-ledger.json");
  await writeCanonicalJson(ledgerPath, ledger);

  if (options.symlinkedArtifact === true) {
    await symlink("missing-artifact", join(artifactRoot, "linked-artifact"));
  }

  const validatorRepositoryRoot = join(root, "validator-repository");
  await git(root, [
    "clone",
    "--quiet",
    "--shared",
    process.cwd(),
    validatorRepositoryRoot,
  ]);
  for (const [relativePath, bytes] of [
    [
      "docs/evidence/vnext-e2-public-exposed-r1/freeze-record.v1.json",
      freezeRecordBytes,
    ],
    [
      "testdata/vnext/external-project/moddable-platformer.e2-evaluation-contract.v1.json",
      contractBytes,
    ],
    [
      "testdata/vnext/external-project/e2-evaluator-interface.schema.v1.json",
      interfaceBytes,
    ],
    [".github/scripts/validate-vnext-e2-evaluator-ledger.mjs", validatorBytes],
  ] as const) {
    const path = join(validatorRepositoryRoot, ...relativePath.split("/"));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
  }
  await git(validatorRepositoryRoot, ["config", "user.name", "E2 test"]);
  await git(validatorRepositoryRoot, [
    "config",
    "user.email",
    "e2-test@chronorift.invalid",
  ]);
  await git(validatorRepositoryRoot, ["add", "--all"]);
  await git(validatorRepositoryRoot, [
    "commit",
    "--quiet",
    "-m",
    "fixture freeze",
  ]);
  await git(validatorRepositoryRoot, [
    "tag",
    "--force",
    "--annotate",
    "vnext-e2-public-exposed-conformance-r2-freeze",
    "--message",
    "test-only freeze anchor",
  ]);

  return {
    agentWorkspaceRoot,
    artifactRoot,
    baselineRoot,
    contractPath,
    evaluatorBundleRoot,
    evaluatorImplementationRoot,
    freezeRecordPath,
    interfacePath,
    ledgerPath,
    validatorPath: join(
      validatorRepositoryRoot,
      ".github/scripts/validate-vnext-e2-evaluator-ledger.mjs",
    ),
    validatorRepositoryRoot,
  };
};

const run = async (fixture: EvaluationFixture) =>
  execFileAsync(
    process.execPath,
    [
      fixture.validatorPath,
      fixture.freezeRecordPath,
      fixture.contractPath,
      fixture.interfacePath,
      fixture.ledgerPath,
      fixture.artifactRoot,
      fixture.baselineRoot,
      fixture.agentWorkspaceRoot,
      fixture.evaluatorImplementationRoot,
      fixture.evaluatorBundleRoot,
    ],
    {
      cwd: fixture.validatorRepositoryRoot,
      encoding: "utf8",
      env: {
        ...process.env,
      },
    },
  );

const expectValid = async (
  fixture: EvaluationFixture,
  finalOutcome: string,
): Promise<void> => {
  const result = await run(fixture);
  expect(result.stderr).toBe("");
  expect(result.stdout).toContain("[chronorift-e2-evaluator-ledger]");
  expect(result.stdout).toContain(`\"finalOutcome\":\"${finalOutcome}\"`);
};

const failureText = async (
  promise: ReturnType<typeof run>,
): Promise<string> => {
  const failure: unknown = await promise.catch((error: unknown) => error);
  return String(
    typeof failure === "object" && failure !== null && "stderr" in failure
      ? failure.stderr
      : failure,
  );
};

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("vNext E2 evaluator ledger validator", () => {
  it("keeps the frozen artifact-path schema normalized and ASCII-safe", async () => {
    const schema = JSON.parse(
      await readFile(sourceInterfacePath, "utf8"),
    ) as JsonObject;
    const definitions = schema["$defs"] as JsonObject;
    const relativePath = definitions["relativePath"] as JsonObject;
    const pattern = new RegExp(relativePath["pattern"] as string, "u");
    expect(pattern.test("runtime/1/events.jsonl")).toBe(true);
    for (const invalid of [
      "runtime//events.jsonl",
      "runtime/./events.jsonl",
      "runtime/../events.jsonl",
      ".git/config",
      "runtime/events.jsonl/",
      "runtime/events with space.jsonl",
      "runtime/事件.jsonl",
    ]) {
      expect(pattern.test(invalid), invalid).toBe(false);
    }
  });

  it("accepts no_candidate without invoking the evaluator", async () => {
    await expectValid(
      await buildFixture({ agentOutcome: "no_candidate" }),
      "agent_no_candidate",
    );
  });

  it("accepts a candidate with full-index patch round-trip and sealed runtime artifacts", async () => {
    await expectValid(await buildFixture(), "accepted");
  });

  it("retains explicit runtime capture loss without hiding an accepted evaluator scenario", async () => {
    await expectValid(
      await buildFixture({ runtimeCaptureLoss: true }),
      "accepted",
    );
  });

  it("retains an independently receipted invalid candidate admission", async () => {
    await expectValid(
      await buildFixture({ invalidCandidate: true }),
      "invalid_candidate",
    );
  });

  it("retains Agent provider failure without an evaluator attempt", async () => {
    await expectValid(
      await buildFixture({ agentOutcome: "provider_failed" }),
      "agent_provider_failed",
    );
  });

  it("accepts one clean zero-progress infrastructure retry", async () => {
    await expectValid(
      await buildFixture({ infrastructureRetry: true }),
      "accepted",
    );
  });

  it("retains a measured Agent storage overrun as budget_exceeded", async () => {
    await expectValid(
      await buildFixture({
        agentOutcome: "budget_exceeded",
        overBudget: true,
      }),
      "agent_budget_exceeded",
    );
  });

  it("retains a large measured Agent tool overrun instead of dropping the assignment", async () => {
    await expectValid(
      await buildFixture({
        agentOutcome: "budget_exceeded",
        largeToolOverrun: true,
      }),
      "agent_budget_exceeded",
    );
  });

  it("retains a measured evaluator storage overrun as infrastructure failure", async () => {
    await expectValid(
      await buildFixture({ evaluatorBudgetExceeded: true }),
      "infrastructure_failure",
    );
  });

  it("rejects partially covered acceptance", async () => {
    const fixture = await buildFixture({ partialAccepted: true });
    expect(await failureText(run(fixture))).toContain(
      "coverage does not equal its required value",
    );
  });

  it("rejects a scenario plan that never executes the candidate", async () => {
    const fixture = await buildFixture({ baselineOnlyScenario: true });
    expect(await failureText(run(fixture))).toContain(
      "scenario plan does not exercise the candidate source",
    );
  });

  it("rejects a seal that does not bind the event-ledger head", async () => {
    const fixture = await buildFixture({ tamperedSeal: true });
    expect(await failureText(run(fixture))).toContain(
      "seal head does not equal its required value",
    );
  });

  it("rejects a hashed runtime projection outside the frozen semantic schema", async () => {
    const fixture = await buildFixture({ invalidProjection: true });
    expect(await failureText(run(fixture))).toContain(
      "subject target scene does not equal its required value",
    );
  });

  it("rejects a patch whose round-trip tree differs from the candidate", async () => {
    const fixture = await buildFixture({ patchMismatch: true });
    expect(await failureText(run(fixture))).toContain(
      "candidate patch round-trip does not equal its required value",
    );
  });

  it("rejects spoofed full-index object identities even when the patch text realizes the candidate tree", async () => {
    const fixture = await buildFixture({ spoofedFullIndex: true });
    expect(await failureText(run(fixture))).toContain(
      "candidate patch is not the exact reproducible full-index diff",
    );
  });

  it("rejects an over-budget Agent outcome that remains eligible", async () => {
    const fixture = await buildFixture({
      agentOutcome: "no_candidate",
      overBudget: true,
    });
    expect(await failureText(run(fixture))).toContain(
      "Agent eligibility budget does not equal its required value",
    );
  });

  it("rejects a dirty workspace reported as no_candidate", async () => {
    const fixture = await buildFixture({
      agentOutcome: "no_candidate",
      dirtyNoCandidate: true,
    });
    expect(await failureText(run(fixture))).toContain(
      "no-candidate source tree does not equal its required value",
    );
  });

  it("rejects an infrastructure retry after evaluator progress", async () => {
    const fixture = await buildFixture({
      infrastructureRetry: true,
      infrastructureRetryProgress: true,
    });
    expect(await failureText(run(fixture))).toContain(
      "retryable infrastructure started scenarios does not equal its required value",
    );
  });

  it("rejects a zero-progress retry that retains an unreferenced runtime artifact", async () => {
    const fixture = await buildFixture({
      hiddenRuntimeArtifactOnRetry: true,
      infrastructureRetry: true,
    });
    expect(await failureText(run(fixture))).toContain(
      "retryable infrastructure runtime artifact closure",
    );
  });

  it("rejects runtime artifacts when no evaluator attempt ran", async () => {
    const fixture = await buildFixture({
      agentOutcome: "no_candidate",
      orphanRuntimeArtifact: true,
    });
    expect(await failureText(run(fixture))).toContain(
      "runtime artifact belongs to an evaluator attempt that did not run",
    );
  });

  it("rejects an evaluator budget overrun reported as accepted", async () => {
    const fixture = await buildFixture({ evaluatorOverBudgetAccepted: true });
    expect(await failureText(run(fixture))).toContain(
      "evaluated budget eligibility",
    );
  });

  it("rejects symbolic links in a selected input tree", async () => {
    const fixture = await buildFixture({
      agentOutcome: "no_candidate",
      symlinkedArtifact: true,
    });
    expect(await failureText(run(fixture))).toContain(
      "evaluation artifacts contains a symbolic link",
    );
  });

  it("rejects an artifact reference outside the frozen relative-path alphabet", async () => {
    const fixture = await buildFixture({
      agentOutcome: "no_candidate",
      unsafeArtifactPath: true,
    });
    expect(await failureText(run(fixture))).toContain(
      "evaluation artifacts entry is not a safe relative POSIX path",
    );
  });
});
