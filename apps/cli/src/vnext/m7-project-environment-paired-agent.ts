import { createHash, randomUUID } from "node:crypto";
import { lstat, readdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import {
  JsonValueSchema,
  ProjectAdapterRevisionV1Schema,
  asSha256DigestV1,
  asTaskId,
  type JsonValue,
  type ProjectAdapterRevisionV1,
  type Sha256DigestV1,
} from "@chronorift/domain";
import { canonicalJson } from "@chronorift/json-artifacts";
import {
  VNEXT_ENVIRONMENT_APPENDIX,
  createProjectEnvironmentGameToolDefinitions,
  createProjectEnvironmentToolCallAdmissionV1,
  createVNextCodingToolDefinitions,
  runVNextPiTurnWithSdk,
  type BrokerToolResult,
  type ProjectEnvironmentGameToolPort,
  type ProjectEnvironmentGameToolPortRequestV1,
  type RunVNextPiSdkTurnOptions,
  type VNextCodingToolPort,
} from "@chronorift/pi-harness";

import { collectCandidateGodotSourceV1 } from "./candidate-godot-build.js";
import {
  SandboxCleanupReceiptV1Schema,
  type SandboxExecutionRequestV1,
} from "./contracts.js";
import {
  ExternalHiddenFixHostSourceObservationV1Schema,
  ExternalHiddenFixPublicExecutionEvidenceV1Schema,
  type ExternalHiddenFixHostSourceObservationV1,
  type ExternalHiddenFixPublicExecutionEvidenceV1,
} from "./external-hidden-fix-workflow.js";
import {
  ExternalHiddenFixPatchIdentityV1Schema,
  ExternalHiddenFixPatchReferenceV1Schema,
  type ExternalHiddenFixPatchReferenceV1,
} from "./external-hidden-fix.js";
import {
  M7HostObservedSourceChangeBoundaryV1Schema,
  M7_NATURAL_USER_PROMPT_V1,
  M7AgentAttemptPiStatsV1Schema,
  M7RuntimeUseExecutionSummaryV1Schema,
  createM7AgentAttemptEvidenceSidecarV1,
  createM7AgentVisibleGameToolExchangeHashV1,
  createM7NeutralRuntimeResourceAppendixV1,
  runM7PairedAgentArmsV1,
  type M7AgentArmIsolationV1,
  type M7AgentAttemptCleanupEvidenceV1,
  type M7AgentAttemptEvidenceStageV1,
  type M7AgentAttemptPiStatsV1,
  type M7CodingToolSurfaceEntryV1,
  type M7PairedAgentArmRequestV1,
  type M7PairedAgentArmResultV1,
  type M7PairedAgentInputV1,
  type M7PairedAgentPortV1,
  type M7PairedAgentRunResultV1,
  type M7RuntimeResourceMapV1,
  type M7RuntimeUseExecutionSummaryV1,
} from "./m7-paired-agent.js";
import { extractTaskPatch, type ExtractedTaskPatch } from "./patch-handoff.js";
import { SandboxPiCodingToolPort } from "./pi-coding-tool-port.js";
import type { TaskSandboxBrokerV1 } from "./sandbox-broker.js";
import { selectedTreeSha256 } from "./selected-tree.js";

const MAX_SOURCE_OBSERVATIONS = 1_000;

const digestJson = (value: unknown): Sha256DigestV1 =>
  asSha256DigestV1(
    createHash("sha256")
      .update(canonicalJson(JsonValueSchema.parse(value)))
      .digest("hex"),
  );

export const M7_NEUTRAL_ENVIRONMENT_INSTRUCTIONS_SHA256_V1 = digestJson(
  VNEXT_ENVIRONMENT_APPENDIX,
);

const sameSet = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((entry) => right.includes(entry));

const pathWithinOrEqual = (parent: string, candidate: string): boolean => {
  const difference = relative(parent, candidate);
  return (
    difference === "" ||
    (difference !== ".." &&
      !difference.startsWith(`..${sep}`) &&
      !isAbsolute(difference))
  );
};

const canonicalDirectory = async (
  inputPath: string,
  label: string,
  requireEmpty: boolean,
): Promise<string> => {
  const absolutePath = resolve(inputPath);
  if (inputPath !== absolutePath) {
    throw new TypeError(`${label} must be a normalized absolute path`);
  }
  const metadata = await lstat(absolutePath);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new TypeError(`${label} must be a real directory`);
  }
  const canonicalPath = await realpath(absolutePath);
  if (canonicalPath !== absolutePath) {
    throw new TypeError(`${label} must contain no symbolic-link component`);
  }
  if (requireEmpty && (await readdir(canonicalPath)).length !== 0) {
    throw new TypeError(`${label} must be fresh and empty`);
  }
  return canonicalPath;
};

const assertDisjointDirectories = (
  entries: readonly { readonly label: string; readonly path: string }[],
): void => {
  for (const [index, left] of entries.entries()) {
    for (const right of entries.slice(index + 1)) {
      if (
        pathWithinOrEqual(left.path, right.path) ||
        pathWithinOrEqual(right.path, left.path)
      ) {
        throw new TypeError(
          `${left.label} and ${right.label} must be disjoint arm resources`,
        );
      }
    }
  }
};

const codingToolFingerprint = (
  tool: ReturnType<typeof createVNextCodingToolDefinitions>[number],
): M7CodingToolSurfaceEntryV1 => ({
  schemaVersion: 1,
  family: "coding",
  name: tool.name,
  definitionSha256: digestJson({
    schemaVersion: 1,
    name: tool.name,
    label: tool.label,
    description: tool.description,
    ...(tool.promptSnippet === undefined
      ? {}
      : { promptSnippet: tool.promptSnippet }),
    ...(tool.promptGuidelines === undefined
      ? {}
      : { promptGuidelines: tool.promptGuidelines }),
    parameters: JsonValueSchema.parse(tool.parameters),
    ...(tool.constrainedSampling === undefined
      ? {}
      : { constrainedSampling: tool.constrainedSampling }),
    ...(tool.renderShell === undefined
      ? {}
      : { renderShell: tool.renderShell }),
    ...(tool.executionMode === undefined
      ? {}
      : { executionMode: tool.executionMode }),
  }),
});

/** Describes the actual Pi coding definitions without invoking the broker. */
export const createM7CodingToolSurfaceV1 = (
  broker: TaskSandboxBrokerV1,
): readonly M7CodingToolSurfaceEntryV1[] =>
  Object.freeze(
    createVNextCodingToolDefinitions(new SandboxPiCodingToolPort(broker)).map(
      codingToolFingerprint,
    ),
  );

const sourceHash = async (workspaceDirectory: string) =>
  selectedTreeSha256(
    await collectCandidateGodotSourceV1(
      workspaceDirectory,
      "project-environment",
      "tracked-tool-scripts-v1",
    ),
  );

class M7ObservingCodingPortV1 implements VNextCodingToolPort {
  public constructor(
    private readonly delegate: VNextCodingToolPort,
    private readonly observeReturn: () => Promise<void>,
  ) {}

  private async observed(
    operation: () => Promise<BrokerToolResult>,
  ): Promise<BrokerToolResult> {
    try {
      return await operation();
    } finally {
      // Failed commands can still change source before their Host-visible tool
      // boundary, so observation belongs in finally.
      await this.observeReturn();
    }
  }

  public read(path: string, signal?: AbortSignal): Promise<BrokerToolResult> {
    return this.observed(() => this.delegate.read(path, signal));
  }

  public bash(
    command: string,
    options: Parameters<VNextCodingToolPort["bash"]>[1],
  ): Promise<BrokerToolResult> {
    return this.observed(() => this.delegate.bash(command, options));
  }

  public write(
    path: string,
    content: Uint8Array,
    signal?: AbortSignal,
  ): Promise<BrokerToolResult> {
    return this.observed(() => this.delegate.write(path, content, signal));
  }

  public grep(
    request: Parameters<VNextCodingToolPort["grep"]>[0],
    signal?: AbortSignal,
  ): Promise<BrokerToolResult> {
    return this.observed(() => this.delegate.grep(request, signal));
  }

  public find(
    request: Parameters<VNextCodingToolPort["find"]>[0],
    signal?: AbortSignal,
  ): Promise<BrokerToolResult> {
    return this.observed(() => this.delegate.find(request, signal));
  }

  public ls(
    request: Parameters<VNextCodingToolPort["ls"]>[0],
    signal?: AbortSignal,
  ): Promise<BrokerToolResult> {
    return this.observed(() => this.delegate.ls(request, signal));
  }
}

export interface M7AgentGameToolExchangeV1 {
  readonly schemaVersion: 1;
  readonly ordinal: number;
  readonly toolCallId: string;
  readonly toolName: ProjectEnvironmentGameToolPortRequestV1["toolName"];
  readonly input: JsonValue;
  readonly response: JsonValue;
  readonly observedAt: string;
  /** Unified across coding and game-tool returns within this arm. */
  readonly hostToolReturnOrdinal: number;
}

/**
 * Capture only a successfully constructed final Pi tool result. Recording at
 * the lower runtime-port boundary would be too early: the public game-tool
 * definition still has to validate the tool-specific output before the Agent
 * can receive it. A response rejected by that validation is not evidence the
 * Agent saw its bytes.
 */
const captureM7AgentVisibleGameToolDefinitionsV1 = (input: {
  readonly definitions: ReturnType<
    typeof createProjectEnvironmentGameToolDefinitions
  >;
  readonly exchanges: M7AgentGameToolExchangeV1[];
  readonly now: () => string;
  readonly nextHostToolReturnOrdinal: () => number;
}): ReturnType<typeof createProjectEnvironmentGameToolDefinitions> =>
  Object.freeze(
    input.definitions.map((definition) =>
      Object.freeze({
        ...definition,
        execute: async (
          ...arguments_: Parameters<typeof definition.execute>
        ): ReturnType<typeof definition.execute> => {
          const result = await definition.execute(...arguments_);
          const [toolCallId, toolInput] = arguments_;
          const response = JsonValueSchema.parse(result.details);
          input.exchanges.push(
            Object.freeze({
              schemaVersion: 1,
              ordinal: input.exchanges.length + 1,
              toolCallId,
              toolName:
                definition.name as ProjectEnvironmentGameToolPortRequestV1["toolName"],
              input: JsonValueSchema.parse(toolInput),
              response,
              observedAt: input.now(),
              hostToolReturnOrdinal: input.nextHostToolReturnOrdinal(),
            }),
          );
          return result;
        },
      }),
    ),
  );

export interface M7RuntimeAgentEvidenceSnapshotV1 {
  readonly sourceObservations: readonly ExternalHiddenFixHostSourceObservationV1[];
  readonly executions: readonly ExternalHiddenFixPublicExecutionEvidenceV1[];
  readonly runtimeUseSummaries: readonly M7RuntimeUseExecutionSummaryV1[];
  /** Durable Host record containing the actual exchanges and runtime records. */
  readonly receiptSha256: Sha256DigestV1;
}

export interface M7RuntimeArmSurfaceV1 {
  readonly pristineAdapterRevision: ProjectAdapterRevisionV1;
  readonly resourceMap: M7RuntimeResourceMapV1;
  readonly gameToolPort: ProjectEnvironmentGameToolPort;
  /** Idempotent close/seal of the runtime owned by this fresh arm. */
  close(): Promise<void>;
  /**
   * Reads already-persisted evidence created by the Agent's actual game calls.
   * The composer never asks this port to launch, query, or rerun on its behalf.
   */
  readAgentEvidence(input: {
    readonly exchanges: readonly M7AgentGameToolExchangeV1[];
    readonly exchangeTranscriptSha256: Sha256DigestV1;
    readonly baselineSelectedTreeSha256: Sha256DigestV1;
    readonly hostSourceChangeBoundaries: readonly {
      readonly schemaVersion: 1;
      readonly hostToolReturnOrdinal: number;
      readonly boundary: "coding_tool_return";
      readonly sourceSha256: Sha256DigestV1;
      readonly buildId: null;
      readonly observedAt: string;
    }[];
  }): Promise<M7RuntimeAgentEvidenceSnapshotV1>;
}

export interface M7ArmPatchHandoffV1 {
  readonly hostBaselineGitDirectory: string;
  readonly hostBaselineCommit: string;
  readonly hostOperationTemporaryDirectory: string;
  readonly ignoredCachePaths: readonly string[];
  readonly patchStore: {
    publishOnce(bytes: Uint8Array): Promise<ExternalHiddenFixPatchReferenceV1>;
  };
}

interface M7PreparedArmCommonV1 {
  readonly arm: "runtime_enabled" | "code_only";
  readonly isolation: M7AgentArmIsolationV1;
  readonly workspaceDirectory: string;
  readonly sessionDirectory: string;
  readonly agentResourceDirectory: string;
  readonly broker: TaskSandboxBrokerV1;
  /** Host-prepared targets that must all be absent from coding-default. */
  readonly codingSandboxSentinelForbiddenPaths: readonly string[];
  readonly patchHandoff: M7ArmPatchHandoffV1;
  readonly now: () => string;
  readonly persistCleanupReceiptOnce: (
    record: JsonValue,
  ) => Promise<Sha256DigestV1>;
  readonly persistSandboxSentinelReceiptOnce: (
    record: JsonValue,
  ) => Promise<Sha256DigestV1>;
  /** Shared preparation latch used to forbid abort-after-Agent-start. */
  readonly markAgentStartedOnce: () => void;
}

export interface M7PreparedRuntimeArmV1 extends M7PreparedArmCommonV1 {
  readonly arm: "runtime_enabled";
  readonly runtime: M7RuntimeArmSurfaceV1;
}

export interface M7PreparedCodeOnlyArmV1 extends M7PreparedArmCommonV1 {
  readonly arm: "code_only";
  readonly runtime?: never;
}

export interface PrepareM7ProjectEnvironmentPairedAgentPortV1Input {
  readonly runtimeArm: M7PreparedRuntimeArmV1;
  readonly codeOnlyArm: M7PreparedCodeOnlyArmV1;
}

export interface M7PreparedProjectEnvironmentPairedAgentPortV1 extends M7PairedAgentPortV1 {
  /**
   * Runs one arm's coding-sandbox sentinel without starting Pi. The bound Host
   * preparation owns the runtime -> cleanup -> code-only dry-run sequence.
   */
  runPreAgentSandboxSentinelOnce(
    arm: "runtime_enabled" | "code_only",
  ): Promise<Sha256DigestV1>;
}

interface M7ProjectEnvironmentPairedAgentDependenciesV1 {
  readonly runPiTurn: typeof runVNextPiTurnWithSdk;
  readonly extractPatch: typeof extractTaskPatch;
  readonly inspectSourceHash: typeof sourceHash;
  readonly newSessionId: (arm: "runtime_enabled" | "code_only") => string;
}

interface M7AttemptAuditStateV1 {
  stage: M7AgentAttemptEvidenceStageV1;
  piTurnStarted: boolean;
  piResultObserved: boolean;
  piStats: M7AgentAttemptPiStatsV1 | null;
  readonly exchanges: M7AgentGameToolExchangeV1[];
  readonly sourceObservations: ExternalHiddenFixHostSourceObservationV1[];
  runtimeEvidenceReceiptSha256: Sha256DigestV1 | null;
  cleanup: M7AgentAttemptCleanupEvidenceV1;
  sealed: boolean;
}

const createAttemptAuditState = (
  arm: "runtime_enabled" | "code_only",
): M7AttemptAuditStateV1 => ({
  stage: "pre_agent_sentinel",
  piTurnStarted: false,
  piResultObserved: false,
  piStats: null,
  exchanges: [],
  sourceObservations: [],
  runtimeEvidenceReceiptSha256: null,
  cleanup: {
    schemaVersion: 1,
    runtimeCloseRequired: arm === "runtime_enabled",
    runtimeCloseAttempted: false,
    runtimeCloseCompleted: arm === "code_only",
    sandboxCleanupAttempted: false,
    sandboxCleanupReceiptObserved: false,
    processGroupTerminated: null,
    cgroupPopulated: null,
    termSent: null,
    killSent: null,
    scopeRemoved: null,
    storageReconciliationObserved: false,
    storageReconciled: null,
    cleanupResultValid: false,
    cleanupProven: false,
    cleanupReceiptSha256: null,
    cleanupInfrastructureFailure: false,
  },
  sealed: false,
});

const projectPiStats = (
  result: Awaited<ReturnType<typeof runVNextPiTurnWithSdk>>,
): M7AgentAttemptPiStatsV1 | null => {
  const parsed = M7AgentAttemptPiStatsV1Schema.safeParse({
    schemaVersion: 1,
    eventsObserved: result.eventsObserved,
    userMessages: result.stats.userMessages,
    assistantMessages: result.stats.assistantMessages,
    toolCalls: result.stats.toolCalls,
    toolResults: result.stats.toolResults,
    totalMessages: result.stats.totalMessages,
    inputTokens: result.stats.tokens.input,
    outputTokens: result.stats.tokens.output,
    cacheReadTokens: result.stats.tokens.cacheRead,
    cacheWriteTokens: result.stats.tokens.cacheWrite,
    totalTokens: result.stats.tokens.total,
    cost: result.stats.cost,
  });
  return parsed.success ? parsed.data : null;
};

const DEFAULT_DEPENDENCIES: M7ProjectEnvironmentPairedAgentDependenciesV1 = {
  runPiTurn: runVNextPiTurnWithSdk,
  extractPatch: extractTaskPatch,
  inspectSourceHash: sourceHash,
  newSessionId: (arm) => `m7-${arm}-${randomUUID()}`,
};

const runCodingSandboxSentinel = async (
  arm: M7PreparedRuntimeArmV1 | M7PreparedCodeOnlyArmV1,
): Promise<Sha256DigestV1> => {
  const targets = [...arm.codingSandboxSentinelForbiddenPaths];
  if (
    targets.length === 0 ||
    new Set(targets).size !== targets.length ||
    targets.some((target) => !isAbsolute(target) || resolve(target) !== target)
  ) {
    throw new TypeError(
      `M7 ${arm.arm} coding sandbox sentinel targets are invalid`,
    );
  }
  // Forbidden Host/runtime paths travel over stdin so the sandbox broker can
  // admit the probe without treating those paths as requested filesystem
  // capabilities. Only the inner mount namespace interprets the bytes.
  const sentinelInput = Buffer.concat(
    targets.flatMap((target) => [
      Buffer.from(target, "utf8"),
      Buffer.from([0]),
    ]),
  );
  const request: SandboxExecutionRequestV1 = {
    schemaVersion: 1,
    operationId: `m7-sentinel:${randomUUID()}`,
    profile: "coding-default",
    argv: [
      "/bin/bash",
      "-c",
      'index=0; while IFS= read -r -d "" target; do if [ -e "$target" ] || [ -r "$target" ] || [ -w "$target" ]; then printf "%s\\n" "$index"; exit 23; fi; index=$((index + 1)); done',
      "m7-coding-sentinel",
    ],
    cwd: "/workspace",
    environment: {},
    stdin: {
      byteLength: sentinelInput.byteLength,
      sha256: asSha256DigestV1(
        createHash("sha256").update(sentinelInput).digest("hex"),
      ),
    },
  };
  const result = await arm.broker.execute(request, { stdin: sentinelInput });
  if (
    result.kind !== "executed" ||
    result.receipt.status !== "succeeded" ||
    result.receipt.exitCode !== 0
  ) {
    const failureDetail = (() => {
      if (result.kind === "denied") {
        return `${result.securityEvent.code}:${result.securityEvent.target}`;
      }
      const stdout = new TextDecoder("utf-8", { fatal: false })
        .decode(result.stdout)
        .trim();
      const stderr = new TextDecoder("utf-8", { fatal: false })
        .decode(result.stderr)
        .trim()
        .slice(0, 256);
      return canonicalJson(
        JsonValueSchema.parse({
          status: result.receipt.status,
          exitCode: result.receipt.exitCode,
          stdout,
          stderr,
          cleanup: result.receipt.cleanup,
        }),
      );
    })();
    throw new TypeError(
      `M7 ${arm.arm} coding sandbox sentinel failed (${failureDetail})`,
    );
  }
  const record = JsonValueSchema.parse({
    schemaVersion: 1,
    recordKind: "m7-coding-sandbox-sentinel",
    arm: arm.arm,
    taskId: arm.isolation.taskId,
    profile: "coding-default",
    forbiddenPathsSha256: digestJson(targets),
    operationId: result.receipt.operationId,
    status: result.receipt.status,
    exitCode: result.receipt.exitCode,
    checkedAt: arm.now(),
  });
  return arm.persistSandboxSentinelReceiptOnce(record);
};

const closeRuntimeOnce = (
  runtime: M7RuntimeArmSurfaceV1,
): (() => Promise<void>) => {
  let promise: Promise<void> | undefined;
  return () => {
    promise ??= runtime.close();
    return promise;
  };
};

const addSourceObservation = (
  target: ExternalHiddenFixHostSourceObservationV1[],
  value: ExternalHiddenFixHostSourceObservationV1,
): void => {
  if (target.length >= MAX_SOURCE_OBSERVATIONS) {
    throw new Error("M7 Host source-observation budget exhausted");
  }
  target.push(ExternalHiddenFixHostSourceObservationV1Schema.parse(value));
};

const evidenceLinkedToExchanges = (
  execution: ExternalHiddenFixPublicExecutionEvidenceV1,
  exchanges: readonly M7AgentGameToolExchangeV1[],
): boolean =>
  exchanges.some((exchange) => {
    const bytes = canonicalJson(
      JsonValueSchema.parse({
        input: exchange.input,
        response: exchange.response,
      }),
    );
    return bytes.includes(execution.executionId);
  });

const validateRuntimeEvidence = (input: {
  readonly snapshot: M7RuntimeAgentEvidenceSnapshotV1;
  readonly exchanges: readonly M7AgentGameToolExchangeV1[];
  readonly baselineSelectedTreeSha256: Sha256DigestV1;
  readonly hostSourceChangeBoundaries: readonly {
    readonly schemaVersion: 1;
    readonly hostToolReturnOrdinal: number;
    readonly boundary: "coding_tool_return";
    readonly sourceSha256: Sha256DigestV1;
    readonly buildId: null;
    readonly observedAt: string;
  }[];
}): M7RuntimeAgentEvidenceSnapshotV1 => {
  if (!/^[a-f0-9]{64}$/u.test(input.snapshot.receiptSha256)) {
    throw new TypeError("M7 runtime evidence omitted its durable Host receipt");
  }
  const sourceObservations = input.snapshot.sourceObservations.map((entry) => {
    const parsed = ExternalHiddenFixHostSourceObservationV1Schema.parse(entry);
    if (parsed.boundary !== "game_build_freeze") {
      throw new TypeError(
        "M7 runtime evidence may add source identity only at actual game Build freezes",
      );
    }
    return parsed;
  });
  const executions = input.snapshot.executions.map((entry) =>
    ExternalHiddenFixPublicExecutionEvidenceV1Schema.parse(entry),
  );
  const runtimeUseSummaries = input.snapshot.runtimeUseSummaries.map((entry) =>
    M7RuntimeUseExecutionSummaryV1Schema.parse(entry),
  );
  if (
    input.exchanges.length === 0 ||
    executions.some(
      (execution) =>
        !evidenceLinkedToExchanges(execution, input.exchanges) ||
        !sourceObservations.some(
          (observation) =>
            observation.buildId === execution.buildId &&
            observation.sourceSha256 === execution.sourceSha256,
        ),
    )
  ) {
    throw new TypeError(
      "M7 runtime evidence was not linked to an actual Agent game-tool exchange",
    );
  }
  if (runtimeUseSummaries.length !== executions.length) {
    throw new TypeError(
      "M7 runtime evidence omitted a typed summary for an Agent execution",
    );
  }
  const gameSourceChanges = sourceObservations
    .filter(
      (observation) =>
        observation.sourceSha256 !== input.baselineSelectedTreeSha256,
    )
    .map((observation) => {
      const exchange = input.exchanges
        .filter(
          (candidate) =>
            observation.buildId !== null &&
            canonicalJson({
              input: candidate.input,
              response: candidate.response,
            }).includes(observation.buildId),
        )
        .sort(
          (left, right) =>
            left.hostToolReturnOrdinal - right.hostToolReturnOrdinal,
        )[0];
      if (exchange === undefined) {
        throw new TypeError(
          "M7 game Build source change has no Agent game-tool return boundary",
        );
      }
      return M7HostObservedSourceChangeBoundaryV1Schema.parse({
        ...observation,
        hostToolReturnOrdinal: exchange.hostToolReturnOrdinal,
      });
    });
  const expectedFirstSourceChange = [
    ...input.hostSourceChangeBoundaries
      .filter(
        (boundary) =>
          boundary.sourceSha256 !== input.baselineSelectedTreeSha256,
      )
      .map((boundary) =>
        M7HostObservedSourceChangeBoundaryV1Schema.parse(boundary),
      ),
    ...gameSourceChanges,
  ].sort(
    (left, right) => left.hostToolReturnOrdinal - right.hostToolReturnOrdinal,
  )[0];
  for (const [index, execution] of executions.entries()) {
    const summary = runtimeUseSummaries[index];
    if (
      summary === undefined ||
      summary.executionId !== execution.executionId ||
      summary.buildId !== execution.buildId ||
      summary.sourceSha256 !== execution.sourceSha256 ||
      summary.startedAt !== execution.startedAt ||
      summary.endedAt !== execution.endedAt ||
      summary.sealed !== execution.sealed ||
      summary.coverageComplete !== execution.coverageComplete ||
      summary.cleanupProven !== execution.cleanupProven ||
      canonicalJson(summary.firstHostObservedSourceChange) !==
        canonicalJson(expectedFirstSourceChange ?? null)
    ) {
      throw new TypeError(
        "M7 typed runtime-use summary crossed its execution or first Host source-change boundary",
      );
    }
    if (summary.sealHostToolReturnOrdinal !== null) {
      const sealExchange = input.exchanges.find(
        (exchange) =>
          exchange.hostToolReturnOrdinal ===
            summary.sealHostToolReturnOrdinal &&
          exchange.toolName === "game_stop" &&
          canonicalJson({
            input: exchange.input,
            response: exchange.response,
          }).includes(execution.executionId),
      );
      if (sealExchange === undefined) {
        throw new TypeError(
          "M7 runtime-use seal ordinal is not an actual Agent game_stop return",
        );
      }
    }
    if (summary.classificationHostToolReturnOrdinal !== null) {
      const classificationExchange = input.exchanges.find(
        (exchange) =>
          exchange.hostToolReturnOrdinal ===
            summary.classificationHostToolReturnOrdinal &&
          canonicalJson({
            input: exchange.input,
            response: exchange.response,
          }).includes(execution.executionId),
      );
      if (classificationExchange === undefined) {
        throw new TypeError(
          "M7 classification boundary is not an actual Agent-visible game-tool return",
        );
      }
    }
  }
  return Object.freeze({
    sourceObservations: Object.freeze(sourceObservations),
    executions: Object.freeze(executions),
    runtimeUseSummaries: Object.freeze(runtimeUseSummaries),
    receiptSha256: input.snapshot.receiptSha256,
  });
};

const exactCodingSurface = (
  actual: readonly M7CodingToolSurfaceEntryV1[],
  expected: readonly M7CodingToolSurfaceEntryV1[],
): boolean =>
  canonicalJson(actual as never) === canonicalJson(expected as never);

const validateArmRequest = (input: {
  readonly request: M7PairedAgentArmRequestV1;
  readonly arm: M7PreparedRuntimeArmV1 | M7PreparedCodeOnlyArmV1;
}): void => {
  if (
    input.request.arm !== input.arm.arm ||
    input.request.prompt !== M7_NATURAL_USER_PROMPT_V1 ||
    input.request.commonEnvironmentInstructionsSha256 !==
      M7_NEUTRAL_ENVIRONMENT_INSTRUCTIONS_SHA256_V1 ||
    input.request.isolation.taskId !== input.arm.isolation.taskId ||
    input.request.isolation.workspaceHandle !==
      input.arm.isolation.workspaceHandle ||
    canonicalJson(input.request.isolation) !==
      canonicalJson(input.arm.isolation)
  ) {
    throw new TypeError(
      "M7 Pi arm request crossed its frozen natural task or prepared isolation",
    );
  }
};

/**
 * Binds the paired seam to actual Pi tool definitions and task sandbox brokers.
 * Workspace materialization and runtime construction remain Host preparation
 * concerns; this function verifies their fresh, disjoint realization before
 * either model call can start.
 */
export async function prepareM7ProjectEnvironmentPairedAgentPortV1(
  input: PrepareM7ProjectEnvironmentPairedAgentPortV1Input,
  overrides: Partial<M7ProjectEnvironmentPairedAgentDependenciesV1> = {},
): Promise<M7PreparedProjectEnvironmentPairedAgentPortV1> {
  if (input.runtimeArm.broker === input.codeOnlyArm.broker) {
    throw new TypeError("M7 paired arms must not share a sandbox broker");
  }
  if (
    input.runtimeArm.patchHandoff.patchStore ===
    input.codeOnlyArm.patchHandoff.patchStore
  ) {
    throw new TypeError("M7 paired arms must not share an Agent patch store");
  }
  const prepared = await Promise.all(
    ([input.runtimeArm, input.codeOnlyArm] as const).map(async (arm) => ({
      arm,
      workspaceDirectory: await canonicalDirectory(
        arm.workspaceDirectory,
        `${arm.arm} workspace`,
        false,
      ),
      sessionDirectory: await canonicalDirectory(
        arm.sessionDirectory,
        `${arm.arm} Session directory`,
        true,
      ),
      agentResourceDirectory: await canonicalDirectory(
        arm.agentResourceDirectory,
        `${arm.arm} Agent resource/cache directory`,
        true,
      ),
      closeRuntime:
        arm.arm === "runtime_enabled" ? closeRuntimeOnce(arm.runtime) : null,
    })),
  );
  assertDisjointDirectories(
    prepared.flatMap((arm) => [
      { label: `${arm.arm.arm} workspace`, path: arm.workspaceDirectory },
      { label: `${arm.arm.arm} Session`, path: arm.sessionDirectory },
      { label: `${arm.arm.arm} cache`, path: arm.agentResourceDirectory },
    ]),
  );
  const byArm = new Map(prepared.map((arm) => [arm.arm.arm, arm] as const));
  const attemptAudits = new Map(
    prepared.map(
      (arm) => [arm.arm.arm, createAttemptAuditState(arm.arm.arm)] as const,
    ),
  );
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
  const runCalls = new Set<string>();
  const cleanupCalls = new Set<string>();
  const sentinelCalls = new Set<string>();
  let preAgentDryRunMode = false;

  const runSentinelOnce = async (
    preparedArm: (typeof prepared)[number],
  ): Promise<Sha256DigestV1> => {
    if (sentinelCalls.has(preparedArm.arm.arm)) {
      throw new Error(
        `M7 ${preparedArm.arm.arm} coding sentinel may run only once`,
      );
    }
    sentinelCalls.add(preparedArm.arm.arm);
    return runCodingSandboxSentinel(preparedArm.arm);
  };

  const runPreAgentSandboxSentinelOnce = (
    arm: "runtime_enabled" | "code_only",
  ) => {
    if (runCalls.size > 0 || cleanupCalls.size > 0) {
      throw new Error(
        "M7 pre-Agent sandbox sentinel cannot follow an arm attempt",
      );
    }
    preAgentDryRunMode = true;
    const preparedArm = byArm.get(arm);
    if (preparedArm === undefined) {
      throw new Error(`M7 ${arm} pre-Agent sandbox preparation is unavailable`);
    }
    return runSentinelOnce(preparedArm);
  };

  const runArm = async (
    request: M7PairedAgentArmRequestV1,
  ): Promise<M7PairedAgentArmResultV1> => {
    if (preAgentDryRunMode) {
      throw new Error("M7 Agent arm cannot start after the pre-Agent dry-run");
    }
    if (runCalls.has(request.arm)) {
      throw new Error(`M7 ${request.arm} Pi Session may run only once`);
    }
    runCalls.add(request.arm);
    const preparedArm = byArm.get(request.arm);
    if (preparedArm === undefined) {
      throw new Error(`M7 ${request.arm} preparation is unavailable`);
    }
    const audit = attemptAudits.get(request.arm);
    if (audit === undefined || audit.sealed) {
      throw new Error(`M7 ${request.arm} attempt audit is unavailable`);
    }
    validateArmRequest({ request, arm: preparedArm.arm });
    audit.stage = "pre_agent_sentinel";
    await runSentinelOnce(preparedArm);
    audit.stage = "baseline_source_observation";
    const initialSourceHash = await dependencies.inspectSourceHash(
      preparedArm.workspaceDirectory,
    );
    if (initialSourceHash !== request.baselineSelectedTreeSha256) {
      throw new TypeError(
        `M7 ${request.arm} workspace changed from the frozen mutant baseline`,
      );
    }

    const sourceObservations = audit.sourceObservations;
    let hostToolReturnOrdinal = 0;
    const nextHostToolReturnOrdinal = (): number => {
      hostToolReturnOrdinal += 1;
      return hostToolReturnOrdinal;
    };
    const hostSourceChangeBoundaries: Array<{
      readonly schemaVersion: 1;
      readonly hostToolReturnOrdinal: number;
      readonly boundary: "coding_tool_return";
      readonly sourceSha256: Sha256DigestV1;
      readonly buildId: null;
      readonly observedAt: string;
    }> = [];
    addSourceObservation(sourceObservations, {
      schemaVersion: 1,
      boundary: "initial_materialization",
      sourceSha256: initialSourceHash,
      buildId: null,
      observedAt: preparedArm.arm.now(),
    });
    let lastCodingSourceHash = initialSourceHash;
    let firstCodingReturnObserved = false;
    const observeCodingReturn = async () => {
      const returnOrdinal = nextHostToolReturnOrdinal();
      const observed = await dependencies.inspectSourceHash(
        preparedArm.workspaceDirectory,
      );
      if (firstCodingReturnObserved && observed === lastCodingSourceHash)
        return;
      firstCodingReturnObserved = true;
      lastCodingSourceHash = observed;
      const observation = ExternalHiddenFixHostSourceObservationV1Schema.parse({
        schemaVersion: 1,
        boundary: "coding_tool_return",
        sourceSha256: observed,
        buildId: null,
        observedAt: preparedArm.arm.now(),
      });
      addSourceObservation(sourceObservations, observation);
      if (observed !== initialSourceHash) {
        hostSourceChangeBoundaries.push(
          Object.freeze({
            ...observation,
            boundary: "coding_tool_return" as const,
            buildId: null,
            hostToolReturnOrdinal: returnOrdinal,
          }),
        );
      }
    };
    const admission = createProjectEnvironmentToolCallAdmissionV1(
      request.agentBudget.toolCallsMaximum,
    );
    const codingTools = createVNextCodingToolDefinitions(
      new M7ObservingCodingPortV1(
        new SandboxPiCodingToolPort(preparedArm.arm.broker),
        observeCodingReturn,
      ),
      { toolCallAdmission: admission },
    );
    if (
      !exactCodingSurface(
        codingTools.map(codingToolFingerprint),
        request.codingTools,
      )
    ) {
      throw new TypeError(
        `M7 ${request.arm} actual Pi coding tools crossed the paired admission`,
      );
    }

    const exchanges = audit.exchanges;
    let gameTools: ReturnType<
      typeof createProjectEnvironmentGameToolDefinitions
    > = [];
    if (request.arm === "runtime_enabled") {
      if (preparedArm.arm.arm !== "runtime_enabled") {
        throw new TypeError(
          "M7 runtime request resolved to code-only preparation",
        );
      }
      const adapterRevision = ProjectAdapterRevisionV1Schema.parse(
        preparedArm.arm.runtime.pristineAdapterRevision,
      );
      if (
        request.runtimeAccess.pristineAdapterRevisionId !==
          adapterRevision.adapterRevisionId ||
        request.runtimeAccess.pristineAdapterPackageSha256 !==
          adapterRevision.packageDigest ||
        canonicalJson(request.runtimeAccess.runtimeResourceMap) !==
          canonicalJson(preparedArm.arm.runtime.resourceMap) ||
        request.runtimeAccess.runtimeResourceAppendixSha256 !==
          digestJson(
            createM7NeutralRuntimeResourceAppendixV1(
              preparedArm.arm.runtime.resourceMap,
            ),
          )
      ) {
        throw new TypeError(
          "M7 runtime Pi tools crossed the frozen pristine AdapterRevision",
        );
      }
      const admitted = new Set(request.gameTools.map((tool) => tool.name));
      gameTools = captureM7AgentVisibleGameToolDefinitionsV1({
        definitions: createProjectEnvironmentGameToolDefinitions(
          preparedArm.arm.runtime.gameToolPort,
          adapterRevision.capabilitySet,
          { toolCallAdmission: admission },
        ).filter((tool) => admitted.has(tool.name as never)),
        exchanges,
        now: preparedArm.arm.now,
        nextHostToolReturnOrdinal,
      });
      if (
        gameTools.length !== request.gameTools.length ||
        !sameSet(
          gameTools.map((tool) => tool.name),
          request.gameTools.map((tool) => tool.name),
        )
      ) {
        throw new TypeError(
          "M7 runtime Pi tools crossed the Adapter-declared Host admission",
        );
      }
    } else if (gameTools.length !== 0) {
      throw new TypeError("M7 code-only arm acquired a game tool");
    }

    const tools = Object.freeze([...codingTools, ...gameTools]);
    let piResult: Awaited<ReturnType<typeof runVNextPiTurnWithSdk>>;
    let piFailure: unknown;
    try {
      audit.stage = "pi_turn";
      audit.piTurnStarted = true;
      preparedArm.arm.markAgentStartedOnce();
      piResult = await dependencies.runPiTurn({
        resourceWorkspaceDirectory: preparedArm.workspaceDirectory,
        sessionDirectory: preparedArm.sessionDirectory,
        agentDir: preparedArm.agentResourceDirectory,
        newSessionId: dependencies.newSessionId(request.arm),
        provider: request.provider,
        model: request.model,
        thinkingLevel: request.thinkingLevel,
        prompt: request.prompt,
        tools,
        timeoutMs: request.agentBudget.wallTimeMsMaximum,
        loadProjectAdapterSkillV1: false,
        ...(request.arm === "runtime_enabled"
          ? {
              additionalEnvironmentInstructions:
                createM7NeutralRuntimeResourceAppendixV1(
                  request.runtimeAccess.runtimeResourceMap,
                ),
            }
          : {}),
      });
      audit.piResultObserved = true;
      audit.piStats = projectPiStats(piResult);
    } catch (error) {
      piFailure = error;
      throw error;
    } finally {
      if (preparedArm.closeRuntime !== null) {
        audit.stage = "runtime_close";
        audit.cleanup = {
          ...audit.cleanup,
          runtimeCloseAttempted: true,
        };
        try {
          await preparedArm.closeRuntime();
          audit.cleanup = {
            ...audit.cleanup,
            runtimeCloseCompleted: true,
          };
        } catch (closeError) {
          if (piFailure !== undefined) {
            throw new AggregateError(
              [piFailure, closeError],
              "M7 Pi turn and runtime sealing both failed",
            );
          }
          throw closeError;
        }
      }
      if (piFailure !== undefined) {
        audit.stage = "pi_turn";
      }
    }
    audit.stage = "pi_result_validation";
    if (
      piResult.provider !== request.provider ||
      piResult.model !== request.model ||
      piResult.requestedThinkingLevel !== request.thinkingLevel ||
      piResult.realizedThinkingLevel !== request.thinkingLevel ||
      piResult.stats.userMessages !== 1 ||
      !sameSet(
        piResult.activeTools,
        tools.map((tool) => tool.name),
      )
    ) {
      throw new TypeError(
        `M7 ${request.arm} realized Pi Session crossed its one-turn/model/tool binding`,
      );
    }

    let runtimeEvidenceReceiptSha256: Sha256DigestV1 | null = null;
    const executions: ExternalHiddenFixPublicExecutionEvidenceV1[] = [];
    const runtimeUseSummaries: M7RuntimeUseExecutionSummaryV1[] = [];
    if (request.arm === "runtime_enabled" && exchanges.length > 0) {
      if (preparedArm.arm.arm !== "runtime_enabled") {
        throw new TypeError(
          "M7 runtime evidence resolved to code-only preparation",
        );
      }
      audit.stage = "runtime_evidence_projection";
      const frozenExchanges = Object.freeze([...exchanges]);
      const snapshot = validateRuntimeEvidence({
        snapshot: await preparedArm.arm.runtime.readAgentEvidence({
          exchanges: frozenExchanges,
          exchangeTranscriptSha256: digestJson(frozenExchanges),
          baselineSelectedTreeSha256: initialSourceHash,
          hostSourceChangeBoundaries: Object.freeze([
            ...hostSourceChangeBoundaries,
          ]),
        }),
        exchanges: frozenExchanges,
        baselineSelectedTreeSha256: initialSourceHash,
        hostSourceChangeBoundaries,
      });
      snapshot.sourceObservations.forEach((observation) =>
        addSourceObservation(sourceObservations, observation),
      );
      executions.push(...snapshot.executions);
      runtimeUseSummaries.push(...snapshot.runtimeUseSummaries);
      runtimeEvidenceReceiptSha256 = snapshot.receiptSha256;
      audit.runtimeEvidenceReceiptSha256 = snapshot.receiptSha256;
    }

    const loopStatus: M7PairedAgentArmResultV1["status"] = admission.exhausted
      ? "aborted"
      : piResult.status === "provider_failed"
        ? "provider_failure"
        : piResult.status;
    let candidatePatch: M7PairedAgentArmResultV1["candidatePatch"] = null;
    if (loopStatus === "completed") {
      audit.stage = "candidate_patch_handoff";
      const candidateSourceHash = await dependencies.inspectSourceHash(
        preparedArm.workspaceDirectory,
      );
      if (candidateSourceHash !== initialSourceHash) {
        const extracted: ExtractedTaskPatch = await dependencies.extractPatch({
          sourceKind: "project-environment-v1",
          taskId: asTaskId(request.isolation.taskId),
          workspaceDirectory: preparedArm.workspaceDirectory,
          hostBaselineGitDirectory:
            preparedArm.arm.patchHandoff.hostBaselineGitDirectory,
          hostBaselineCommit: preparedArm.arm.patchHandoff.hostBaselineCommit,
          baselineSourceHash: initialSourceHash,
          ignoredCachePaths: preparedArm.arm.patchHandoff.ignoredCachePaths,
          hostOperationTemporaryDirectory:
            preparedArm.arm.patchHandoff.hostOperationTemporaryDirectory,
        });
        if (
          extracted.identity.taskId !== request.isolation.taskId ||
          extracted.identity.baselineSourceHash !== initialSourceHash ||
          extracted.identity.candidateSourceHash !== candidateSourceHash ||
          extracted.identity.patchHash !==
            asSha256DigestV1(
              createHash("sha256").update(extracted.patchBytes).digest("hex"),
            ) ||
          extracted.identity.byteLength !== extracted.patchBytes.byteLength
        ) {
          throw new TypeError(
            `M7 ${request.arm} extracted patch crossed its exact source trees`,
          );
        }
        const patch = ExternalHiddenFixPatchReferenceV1Schema.parse(
          await preparedArm.arm.patchHandoff.patchStore.publishOnce(
            extracted.patchBytes,
          ),
        );
        const patchIdentity = ExternalHiddenFixPatchIdentityV1Schema.parse({
          schemaVersion: 1,
          baselineSelectedTreeSha256: initialSourceHash,
          candidateSelectedTreeSha256: candidateSourceHash,
          patchSha256: extracted.identity.patchHash,
          byteLength: extracted.identity.byteLength,
        });
        if (
          patch.rawSha256 !== patchIdentity.patchSha256 ||
          patch.byteLength !== patchIdentity.byteLength
        ) {
          throw new TypeError(
            `M7 ${request.arm} patch store changed the patch`,
          );
        }
        candidatePatch = {
          schemaVersion: 1,
          patch,
          patchIdentity,
          admissible: true,
          roundTripVerified: extracted.roundTripVerified,
        };
        addSourceObservation(sourceObservations, {
          schemaVersion: 1,
          boundary: "patch_freeze",
          sourceSha256: candidateSourceHash,
          buildId: null,
          observedAt: preparedArm.arm.now(),
        });
      }
    }

    audit.stage = "arm_result_validation";
    return {
      schemaVersion: 1,
      arm: request.arm,
      attemptOrdinal: 1,
      userTurnCount: 1,
      status: loopStatus,
      realizedProvider: piResult.provider,
      realizedModel: piResult.model,
      realizedThinkingLevel: piResult.realizedThinkingLevel,
      activeToolNames: Object.freeze([...piResult.activeTools]),
      attemptBindingContentSha256: request.attemptBinding.bindingContentSha256,
      candidatePatch,
      sourceObservations: Object.freeze(sourceObservations),
      executions:
        request.arm === "runtime_enabled"
          ? Object.freeze(executions)
          : ([] as const),
      runtimeUseSummaries:
        request.arm === "runtime_enabled"
          ? Object.freeze(runtimeUseSummaries)
          : ([] as const),
      runtimeEvidenceReceiptSha256:
        request.arm === "runtime_enabled" ? runtimeEvidenceReceiptSha256 : null,
    } as M7PairedAgentArmResultV1;
  };

  const cleanupArm: M7PairedAgentPortV1["cleanupArm"] = async (request) => {
    if (preAgentDryRunMode) {
      throw new Error(
        "M7 attempt-bound cleanup cannot follow the pre-Agent dry-run",
      );
    }
    if (cleanupCalls.has(request.arm)) {
      throw new Error(`M7 ${request.arm} cleanup may run only once`);
    }
    cleanupCalls.add(request.arm);
    const preparedArm = byArm.get(request.arm);
    const audit = attemptAudits.get(request.arm);
    if (
      preparedArm === undefined ||
      audit === undefined ||
      audit.sealed ||
      request.attemptBindingContentSha256.length !== 64 ||
      canonicalJson(request.isolation) !==
        canonicalJson(preparedArm.arm.isolation)
    ) {
      throw new TypeError("M7 cleanup crossed its prepared arm binding");
    }
    const failures: string[] = [];
    if (preparedArm.closeRuntime !== null) {
      audit.cleanup = {
        ...audit.cleanup,
        runtimeCloseAttempted: true,
      };
      try {
        await preparedArm.closeRuntime();
        audit.cleanup = {
          ...audit.cleanup,
          runtimeCloseCompleted: true,
        };
      } catch {
        failures.push("runtime_close_failed");
      }
    }
    let sandboxCleanup;
    try {
      audit.cleanup = {
        ...audit.cleanup,
        sandboxCleanupAttempted: true,
      };
      sandboxCleanup = SandboxCleanupReceiptV1Schema.parse(
        await preparedArm.arm.broker.cleanup(),
      );
      audit.cleanup = {
        ...audit.cleanup,
        sandboxCleanupReceiptObserved: true,
        processGroupTerminated: sandboxCleanup.processGroupTerminated,
        cgroupPopulated: sandboxCleanup.cgroupPopulated,
        termSent: sandboxCleanup.termSent,
        killSent: sandboxCleanup.killSent,
        scopeRemoved: sandboxCleanup.scopeRemoved,
        storageReconciliationObserved:
          sandboxCleanup.storageReconciled !== undefined,
        storageReconciled: sandboxCleanup.storageReconciled ?? null,
      };
    } catch {
      failures.push("sandbox_cleanup_receipt_unavailable");
      throw new Error(`M7 ${request.arm} sandbox cleanup returned no receipt`);
    }
    const proven =
      failures.length === 0 &&
      sandboxCleanup.processGroupTerminated &&
      !sandboxCleanup.cgroupPopulated &&
      sandboxCleanup.scopeRemoved &&
      sandboxCleanup.storageReconciled === true;
    if (!proven && failures.length === 0) {
      failures.push("sandbox_cleanup_incomplete");
    }
    const record = JsonValueSchema.parse({
      schemaVersion: 1,
      recordKind: "m7-paired-arm-cleanup",
      arm: request.arm,
      taskId: request.isolation.taskId,
      attemptBindingContentSha256: request.attemptBindingContentSha256,
      sandboxCleanup,
      proven,
      failures,
      completedAt: preparedArm.arm.now(),
    });
    const receiptSha256 =
      await preparedArm.arm.persistCleanupReceiptOnce(record);
    audit.cleanup = {
      ...audit.cleanup,
      cleanupResultValid: true,
      cleanupProven: proven,
      cleanupReceiptSha256: receiptSha256,
      cleanupInfrastructureFailure: false,
    };
    return {
      schemaVersion: 1,
      arm: request.arm,
      attemptBindingContentSha256: request.attemptBindingContentSha256,
      proven,
      receiptSha256,
    };
  };

  const sealAttemptEvidenceOnce: NonNullable<
    M7PairedAgentPortV1["sealAttemptEvidenceOnce"]
  > = (request) => {
    const audit = attemptAudits.get(request.arm);
    if (
      audit === undefined ||
      audit.sealed ||
      request.attemptBindingContentSha256.length !== 64
    ) {
      throw new TypeError("M7 attempt evidence seal crossed its arm state");
    }
    const preparedArm = byArm.get(request.arm);
    if (
      preparedArm === undefined ||
      request.attemptBindingContentSha256 !==
        request.cleanup.attemptBindingContentSha256
    ) {
      throw new TypeError("M7 attempt evidence seal crossed its binding");
    }
    audit.cleanup = {
      ...audit.cleanup,
      cleanupResultValid: request.cleanupFailureCode === null,
      cleanupProven:
        request.cleanupFailureCode === null && request.cleanup.proven,
      cleanupReceiptSha256:
        request.cleanupFailureCode === null
          ? request.cleanup.receiptSha256
          : null,
      cleanupInfrastructureFailure: request.cleanupFailureCode !== null,
    };
    const terminal =
      request.runnerFailureCode === "runner_threw"
        ? {
            stage: audit.stage,
            code: "operation_threw" as const,
          }
        : request.runnerFailureCode === "runner_result_invalid"
          ? {
              stage: "arm_result_validation" as const,
              code: "result_invalid" as const,
            }
          : request.cleanupFailureCode === "cleanup_threw"
            ? {
                stage: "cleanup" as const,
                code: "operation_threw" as const,
              }
            : request.cleanupFailureCode === "cleanup_result_invalid"
              ? {
                  stage: "cleanup" as const,
                  code: "result_invalid" as const,
                }
              : !request.cleanup.proven
                ? {
                    stage: "cleanup" as const,
                    code: "cleanup_not_proven" as const,
                  }
                : { stage: "sealed" as const, code: "completed" as const };
    const evidence = createM7AgentAttemptEvidenceSidecarV1({
      campaignId: request.campaignId,
      arm: request.arm,
      attemptBindingContentSha256: request.attemptBindingContentSha256,
      terminalStage: terminal.stage,
      terminalCode: terminal.code,
      piTurnStarted: audit.piTurnStarted,
      piResultObserved: audit.piResultObserved,
      piStats: audit.piStats,
      agentVisibleGameToolExchanges: audit.exchanges.map((exchange) =>
        createM7AgentVisibleGameToolExchangeHashV1(exchange),
      ),
      sourceObservations: audit.sourceObservations,
      runtimeEvidenceReceiptSha256: audit.runtimeEvidenceReceiptSha256,
      cleanup: audit.cleanup,
    });
    audit.sealed = true;
    return Promise.resolve(evidence);
  };

  return Object.freeze({
    runArm,
    cleanupArm,
    sealAttemptEvidenceOnce,
    runPreAgentSandboxSentinelOnce,
  });
}

export interface RunM7ProjectEnvironmentPairedAgentV1Input extends PrepareM7ProjectEnvironmentPairedAgentPortV1Input {
  readonly pairedInput: M7PairedAgentInputV1;
}

/** Production composition entry point. It never contacts a provider in tests
 * unless the injected `runPiTurn` implementation does so. */
export async function runM7ProjectEnvironmentPairedAgentV1(
  input: RunM7ProjectEnvironmentPairedAgentV1Input,
  overrides: Partial<M7ProjectEnvironmentPairedAgentDependenciesV1> = {},
): Promise<M7PairedAgentRunResultV1> {
  const port = await prepareM7ProjectEnvironmentPairedAgentPortV1(
    { runtimeArm: input.runtimeArm, codeOnlyArm: input.codeOnlyArm },
    overrides,
  );
  return runM7PairedAgentArmsV1(input.pairedInput, port);
}

export type { RunVNextPiSdkTurnOptions };
