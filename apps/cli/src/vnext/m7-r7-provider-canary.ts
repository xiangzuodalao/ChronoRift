import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  stat,
  statfs,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { JsonValueSchema, Sha256DigestV1Schema } from "@chronorift/domain";
import { canonicalJson } from "@chronorift/json-artifacts";
import {
  createVNextCodingToolDefinitions,
  parseVNextPiHostHttpTransportObservationV1,
  projectVNextPiFailureV1,
  runVNextPiTurnWithSdk,
  VNEXT_PI_FAILURE_CATEGORIES,
  VNEXT_PI_FAILURE_STAGES,
  VNEXT_PI_LIFECYCLE_STAGES,
  VNextPiTurnFailure,
  type BrokerToolResult,
  type RunVNextPiSdkTurnOptions,
  type VNextCodingToolPort,
  type VNextPiFailureProjectionV1,
  type VNextPiHostHttpTransportObservationV1,
  type VNextPiLifecycleEventV1,
  type VNextPiSdkTurnResult,
} from "@chronorift/pi-harness";
import { z } from "zod";

import { publishPrivateFileOnceV1 } from "./private-atomic-publication.js";

const PROVIDER = "openai-codex" as const;
const MODEL = "gpt-5.6-luna" as const;
const THINKING_LEVEL = "max" as const;
const RECEIPT_FILENAME = "provider-canary.v1.json";
const TMPFS_MAGIC = 0x01021994;
const PRIVATE_DIRECTORY_MODE = 0o700;
const CANARY_TIMEOUT_MS = 180_000;

const sha256 = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

const digestJson = (value: unknown): string =>
  sha256(canonicalJson(JsonValueSchema.parse(value)));

const lifecycleEventSchema = z
  .object({
    schemaVersion: z.literal(1),
    ordinal: z.number().int().min(1).max(VNEXT_PI_LIFECYCLE_STAGES.length),
    stage: z.enum(VNEXT_PI_LIFECYCLE_STAGES),
  })
  .strict();

const lifecycleSchema = z
  .array(lifecycleEventSchema)
  .max(8)
  .superRefine((events, context) => {
    for (const [index, event] of events.entries()) {
      if (
        event.ordinal !== index + 1 ||
        event.stage !== VNEXT_PI_LIFECYCLE_STAGES[index]
      ) {
        context.addIssue({
          code: "custom",
          message: "provider canary lifecycle is not an ordered prefix",
        });
        return;
      }
    }
  });

const failureProjectionSchema = z
  .object({
    schemaVersion: z.literal(1),
    stage: z.enum(VNEXT_PI_FAILURE_STAGES),
    category: z.enum(VNEXT_PI_FAILURE_CATEGORIES),
    errorName: z.string().min(1).max(128),
    platformCode: z.string().min(1).max(128).nullable(),
    syscall: z.string().min(1).max(128).nullable(),
    messageSha256: Sha256DigestV1Schema,
    causeSha256s: z.array(Sha256DigestV1Schema).max(8),
  })
  .strict();

const transportObservationSchema = z.unknown().transform((value, context) => {
  try {
    return parseVNextPiHostHttpTransportObservationV1(value);
  } catch {
    context.addIssue({
      code: "custom",
      message: "provider canary transport observation is invalid",
    });
    return z.NEVER;
  }
});

const observationsSchema = z
  .object({
    requestedThinkingLevel: z.literal(THINKING_LEVEL),
    realizedThinkingLevel: z.literal(THINKING_LEVEL).nullable(),
    observedTurnCount: z.union([z.literal(0), z.literal(1)]),
    eventsObserved: z.number().int().nonnegative(),
    toolCallCount: z.number().int().nonnegative(),
    brokerObservationCount: z.number().int().nonnegative(),
    totalTokenCount: z.number().int().nonnegative(),
    nonceSha256: Sha256DigestV1Schema,
    assistantObservedNonce: z.boolean(),
    sessionFileObserved: z.boolean(),
    sessionCleanupProven: z.boolean(),
    hostHttpTransportObservation: transportObservationSchema.nullable(),
  })
  .strict();

const failureSchema = z
  .object({
    stage: z.enum(VNEXT_PI_FAILURE_STAGES),
    primaryFailure: failureProjectionSchema.nullable(),
    cleanupFailures: z.array(failureProjectionSchema).max(4),
  })
  .strict();

const basisSchema = z
  .object({
    schemaVersion: z.literal(1),
    recordKind: z.literal("m7-r7-preflight-probe"),
    mode: z.literal("provider-canary"),
    status: z.enum(["passed", "failed"]),
    provider: z.literal(PROVIDER),
    model: z.literal(MODEL),
    lifecycle: lifecycleSchema,
    observations: observationsSchema,
    failure: failureSchema.nullable(),
    startedAt: z.string().datetime({ offset: true }),
    completedAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((value, context) => {
    const passed = value.status === "passed";
    const transport = value.observations.hostHttpTransportObservation;
    if (passed !== (value.failure === null)) {
      context.addIssue({
        code: "custom",
        message: "provider canary status and failure disagree",
      });
    }
    if (
      passed &&
      (value.lifecycle.length !== VNEXT_PI_LIFECYCLE_STAGES.length ||
        value.observations.realizedThinkingLevel !== THINKING_LEVEL ||
        value.observations.observedTurnCount !== 1 ||
        value.observations.eventsObserved < 1 ||
        value.observations.toolCallCount < 1 ||
        value.observations.brokerObservationCount < 1 ||
        value.observations.totalTokenCount < 1 ||
        !value.observations.assistantObservedNonce ||
        !value.observations.sessionFileObserved ||
        !value.observations.sessionCleanupProven ||
        transport === null ||
        transport.requestStartedCount < 1 ||
        transport.requestStartedCount !== transport.responseHeadersCount ||
        transport.requestStartedCount !==
          transport.responseCompleteCount + transport.requestErrorCount)
    ) {
      context.addIssue({
        code: "custom",
        message: "passed provider canary lacks realized production evidence",
      });
    }
  });

export const M7R7ProviderCanaryReceiptV1Schema = basisSchema
  .extend({ recordContentSha256: Sha256DigestV1Schema })
  .strict()
  .superRefine((value, context) => {
    const { recordContentSha256, ...basis } = value;
    if (recordContentSha256 !== digestJson(basis)) {
      context.addIssue({
        code: "custom",
        path: ["recordContentSha256"],
        message: "provider canary content hash does not match",
      });
    }
  });
export type M7R7ProviderCanaryReceiptV1 = z.infer<
  typeof M7R7ProviderCanaryReceiptV1Schema
>;

interface M7R7ProviderCanaryTurnInputV1 {
  readonly resourceWorkspaceDirectory: string;
  readonly sessionDirectory: string;
  readonly newSessionId: string;
  readonly agentDir: string;
  readonly transport: "sse";
  readonly port: VNextCodingToolPort;
  readonly onLifecycleEvent: (event: VNextPiLifecycleEventV1) => void;
}

export interface M7R7ProviderCanaryDependenciesV1 {
  readonly runTurn: (
    input: M7R7ProviderCanaryTurnInputV1,
  ) => Promise<VNextPiSdkTurnResult>;
  readonly uuid: () => string;
  readonly now: () => string;
  readonly requireTaskStorageTmpfs: (root: string) => Promise<void>;
}

const requireOwnedPrivateDirectory = async (
  input: string,
  label: string,
): Promise<string> => {
  const path = resolve(input);
  const [metadata, canonical] = await Promise.all([
    lstat(path),
    realpath(path),
  ]);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== process.geteuid?.() ||
    (metadata.mode & 0o7777) !== PRIVATE_DIRECTORY_MODE ||
    canonical !== path
  ) {
    throw new Error(`${label} must be an owned private directory`);
  }
  return path;
};

const defaultDependencies: M7R7ProviderCanaryDependenciesV1 = {
  runTurn: async (input) => {
    const tools = createVNextCodingToolDefinitions(input.port).filter(
      (tool) => tool.name === "read",
    );
    if (tools.length !== 1) {
      throw new Error("provider canary did not select exactly one read tool");
    }
    const options: RunVNextPiSdkTurnOptions = {
      resourceWorkspaceDirectory: input.resourceWorkspaceDirectory,
      sessionDirectory: input.sessionDirectory,
      newSessionId: input.newSessionId,
      agentDir: input.agentDir,
      provider: PROVIDER,
      model: MODEL,
      thinkingLevel: THINKING_LEVEL,
      transport: input.transport,
      prompt:
        "Use the read tool exactly once on canary.txt, then report its exact contents. This is a neutral transport readiness check; do not infer or modify anything.",
      tools,
      timeoutMs: CANARY_TIMEOUT_MS,
      additionalEnvironmentInstructions:
        "Only the virtual canary.txt resource is authorized for this readiness check.",
      onLifecycleEvent: input.onLifecycleEvent,
    };
    return runVNextPiTurnWithSdk(options);
  },
  uuid: randomUUID,
  now: () => new Date().toISOString(),
  requireTaskStorageTmpfs: async (root) => {
    if ((await statfs(root)).type !== TMPFS_MAGIC) {
      throw new Error("provider canary task storage is not tmpfs");
    }
  },
};

const toolResult = (
  status: BrokerToolResult["status"],
  stdout: string,
  nonceSha256: string,
): BrokerToolResult => ({
  stdout: Buffer.from(stdout, "utf8"),
  stderr: new Uint8Array(),
  exitCode: status === "succeeded" ? 0 : 1,
  status,
  receipt: Object.freeze({
    schemaVersion: 1,
    kind: "m7-r7-provider-canary-tool",
    nonceSha256,
  }),
});

const projectFailure = (
  error: unknown,
  fallbackStage: (typeof VNEXT_PI_FAILURE_STAGES)[number] = "agent_turn",
): {
  readonly stage: (typeof VNEXT_PI_FAILURE_STAGES)[number];
  readonly primaryFailure: VNextPiFailureProjectionV1 | null;
  readonly cleanupFailures: readonly VNextPiFailureProjectionV1[];
  readonly lifecycle: readonly VNextPiLifecycleEventV1[];
  readonly transport: VNextPiHostHttpTransportObservationV1 | null;
} => {
  if (error instanceof VNextPiTurnFailure) {
    return {
      stage: error.receipt.stage,
      primaryFailure: error.receipt.primaryFailure,
      cleanupFailures: error.receipt.cleanupFailures,
      lifecycle: error.receipt.lifecycle,
      transport:
        error.receipt.hostHttpTransportObservation === undefined
          ? null
          : parseVNextPiHostHttpTransportObservationV1(
              error.receipt.hostHttpTransportObservation,
            ),
    };
  }
  const failure = projectVNextPiFailureV1(error, fallbackStage);
  return {
    stage: failure.stage,
    primaryFailure: failure,
    cleanupFailures: [],
    lifecycle: [],
    transport: null,
  };
};

const canonicalReceiptBytes = (receipt: M7R7ProviderCanaryReceiptV1): Buffer =>
  Buffer.from(`${canonicalJson(JsonValueSchema.parse(receipt))}\n`, "utf8");

export const parseM7R7ProviderCanaryReceiptBytesV1 = (
  bytes: Uint8Array,
): M7R7ProviderCanaryReceiptV1 => {
  const text = new TextDecoder("utf8", { fatal: true }).decode(bytes);
  const receipt = M7R7ProviderCanaryReceiptV1Schema.parse(
    JSON.parse(text) as unknown,
  );
  if (!Buffer.from(bytes).equals(canonicalReceiptBytes(receipt))) {
    throw new Error("provider canary receipt is not canonical JSON with LF");
  }
  return receipt;
};

export const runM7R7ProviderCanaryOnceV1 = async (
  input: {
    readonly receiptPath: string;
    readonly taskStorageRoot: string;
    readonly agentDir: string;
  },
  dependencies: Partial<M7R7ProviderCanaryDependenciesV1> = {},
): Promise<M7R7ProviderCanaryReceiptV1> => {
  const deps = { ...defaultDependencies, ...dependencies };
  const receiptPath = resolve(input.receiptPath);
  if (
    !isAbsolute(input.receiptPath) ||
    receiptPath !== join(dirname(receiptPath), RECEIPT_FILENAME)
  ) {
    throw new Error("provider canary receipt path changed");
  }
  const [receiptRoot, taskStorageRoot, agentDir] = await Promise.all([
    requireOwnedPrivateDirectory(
      dirname(receiptPath),
      "provider canary receipt root",
    ),
    requireOwnedPrivateDirectory(
      input.taskStorageRoot,
      "provider canary task storage",
    ),
    requireOwnedPrivateDirectory(input.agentDir, "provider canary Pi root"),
  ]);
  await deps.requireTaskStorageTmpfs(taskStorageRoot);

  const startedAt = deps.now();
  const nonce = `chronorift-r7-canary-${deps.uuid()}`;
  const nonceSha256 = sha256(nonce);
  const root = await mkdtemp(join(taskStorageRoot, "m7-r7-provider-canary-"));
  await open(
    root,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  ).then(async (handle) => {
    try {
      await handle.chmod(PRIVATE_DIRECTORY_MODE);
      await handle.sync();
    } finally {
      await handle.close();
    }
  });
  const workspace = join(root, "workspace");
  const sessions = join(root, "sessions");
  await Promise.all([
    mkdir(workspace, { mode: PRIVATE_DIRECTORY_MODE }),
    mkdir(sessions, { mode: PRIVATE_DIRECTORY_MODE }),
  ]);

  let brokerObservationCount = 0;
  const denied = (): Promise<BrokerToolResult> => {
    brokerObservationCount += 1;
    return Promise.resolve(toolResult("denied", "", nonceSha256));
  };
  const port: VNextCodingToolPort = {
    read: (path) => {
      brokerObservationCount += 1;
      return Promise.resolve(
        path === "canary.txt"
          ? toolResult("succeeded", `${nonce}\n`, nonceSha256)
          : toolResult("denied", "", nonceSha256),
      );
    },
    bash: denied,
    write: denied,
    grep: denied,
    find: denied,
    ls: denied,
  };

  let result: VNextPiSdkTurnResult | undefined;
  let failure: ReturnType<typeof projectFailure> | undefined;
  let validationError: unknown;
  const lifecycle: VNextPiLifecycleEventV1[] = [];
  let transport: VNextPiHostHttpTransportObservationV1 | null = null;
  let sessionFileObserved = false;
  let sessionCleanupProven = false;
  try {
    result = await deps.runTurn({
      resourceWorkspaceDirectory: workspace,
      sessionDirectory: sessions,
      newSessionId: `m7-r7-provider-canary-${deps.uuid()}`,
      agentDir,
      transport: "sse",
      port,
      onLifecycleEvent: (event) => lifecycle.push(event),
    });
    const sessionFile = resolve(result.sessionFile);
    const sessionMetadata = await stat(sessionFile);
    sessionFileObserved =
      sessionFile.startsWith(`${sessions}/`) &&
      sessionMetadata.isFile() &&
      sessionMetadata.uid === process.geteuid?.() &&
      sessionMetadata.nlink === 1;
    transport = parseVNextPiHostHttpTransportObservationV1(
      result.hostHttpTransportObservation,
    );
    if (
      result.status !== "completed" ||
      result.provider !== PROVIDER ||
      result.model !== MODEL ||
      result.requestedThinkingLevel !== THINKING_LEVEL ||
      result.realizedThinkingLevel !== THINKING_LEVEL ||
      result.observedTurnCount !== 1 ||
      result.eventsObserved < 1 ||
      result.stats.toolCalls < 1 ||
      result.stats.tokens.total < 1 ||
      brokerObservationCount < 1 ||
      !result.assistantText.includes(nonce) ||
      result.activeTools.length !== 1 ||
      result.activeTools[0] !== "read" ||
      !sessionFileObserved ||
      transport.requestStartedCount < 1 ||
      transport.requestStartedCount !== transport.responseHeadersCount ||
      transport.requestStartedCount !==
        transport.responseCompleteCount + transport.requestErrorCount
    ) {
      throw new Error(
        "provider canary did not satisfy its fixed success boundary",
      );
    }
  } catch (error) {
    validationError = error;
    failure = projectFailure(error);
  } finally {
    try {
      await rm(root, { recursive: true });
      try {
        await lstat(root);
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "ENOENT"
        ) {
          sessionCleanupProven = true;
        } else {
          throw error;
        }
      }
    } catch (error) {
      validationError ??= error;
      if (failure === undefined) {
        failure = projectFailure(error, "session_cleanup");
      } else {
        failure = {
          ...failure,
          cleanupFailures: [
            ...failure.cleanupFailures,
            projectVNextPiFailureV1(error, "session_cleanup"),
          ].slice(0, 4),
        };
      }
    }
  }

  transport ??= failure?.transport ?? null;
  if (!sessionCleanupProven && validationError === undefined) {
    validationError = new Error(
      "provider canary session cleanup was not proven",
    );
    failure = projectFailure(validationError);
  }
  const passed = validationError === undefined;
  const basis = basisSchema.parse({
    schemaVersion: 1,
    recordKind: "m7-r7-preflight-probe",
    mode: "provider-canary",
    status: passed ? "passed" : "failed",
    provider: PROVIDER,
    model: MODEL,
    lifecycle:
      result === undefined && (failure?.lifecycle.length ?? 0) > 0
        ? failure!.lifecycle
        : lifecycle,
    observations: {
      requestedThinkingLevel: THINKING_LEVEL,
      realizedThinkingLevel: result?.realizedThinkingLevel ?? null,
      observedTurnCount: result?.observedTurnCount ?? 0,
      eventsObserved: result?.eventsObserved ?? 0,
      toolCallCount: result?.stats.toolCalls ?? 0,
      brokerObservationCount,
      totalTokenCount: result?.stats.tokens.total ?? 0,
      nonceSha256,
      assistantObservedNonce: result?.assistantText.includes(nonce) ?? false,
      sessionFileObserved,
      sessionCleanupProven,
      hostHttpTransportObservation: transport,
    },
    failure: passed
      ? null
      : failure === undefined
        ? {
            stage: "agent_turn",
            primaryFailure: projectVNextPiFailureV1(
              validationError,
              "agent_turn",
            ),
            cleanupFailures: [],
          }
        : {
            stage: failure.stage,
            primaryFailure: failure.primaryFailure,
            cleanupFailures: failure.cleanupFailures,
          },
    startedAt,
    completedAt: deps.now(),
  });
  const receipt = M7R7ProviderCanaryReceiptV1Schema.parse({
    ...basis,
    recordContentSha256: digestJson(basis),
  });
  await publishPrivateFileOnceV1({
    root: receiptRoot,
    filename: RECEIPT_FILENAME,
    bytes: canonicalReceiptBytes(receipt),
  });
  const retained = parseM7R7ProviderCanaryReceiptBytesV1(
    await readFile(receiptPath),
  );
  if (!passed) {
    throw new Error("M7 R7 provider canary failed", {
      cause: validationError,
    });
  }
  return retained;
};

const requiredAbsoluteEnvironment = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || !isAbsolute(value) || resolve(value) !== value) {
    throw new Error(`${name} must be a normalized absolute path`);
  }
  return value;
};

/**
 * Keeps provider, credential, and response failures behind the sanitized
 * receipt boundary. Node's default unhandled-rejection formatting includes a
 * cause chain, so the executable must never let the in-memory provider error
 * escape to stderr.
 */
export const executeM7R7ProviderCanaryProgramBoundaryV1 = async (
  operation: () => Promise<void>,
  writeFailure: (message: string) => void = (message) =>
    process.stderr.write(message),
): Promise<0 | 1> => {
  try {
    await operation();
    return 0;
  } catch {
    writeFailure(
      "M7 R7 provider canary failed; inspect its sanitized receipt\n",
    );
    return 1;
  }
};

const invokedAsProgram =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (invokedAsProgram) {
  process.exitCode = await executeM7R7ProviderCanaryProgramBoundaryV1(
    async () => {
      const command = process.argv[2] ?? "--run";
      const receipt =
        command === "--validate-receipt" && process.argv.length === 4
          ? parseM7R7ProviderCanaryReceiptBytesV1(
              await readFile(resolve(process.argv[3]!)),
            )
          : command === "--run" &&
              (process.argv.length === 2 || process.argv.length === 3)
            ? await runM7R7ProviderCanaryOnceV1({
                receiptPath: requiredAbsoluteEnvironment(
                  "CHRONORIFT_M7_R7_PROVIDER_CANARY_RECEIPT_PATH",
                ),
                taskStorageRoot: "/task-storage",
                agentDir: requiredAbsoluteEnvironment("PI_CODING_AGENT_DIR"),
              })
            : (() => {
                throw new Error(
                  "usage: m7-r7-provider-canary.ts --run | --validate-receipt PATH",
                );
              })();
      process.stdout.write(
        `${canonicalJson(
          JsonValueSchema.parse({
            status: receipt.status,
            recordContentSha256: receipt.recordContentSha256,
            hostHttpTransportObservation:
              receipt.observations.hostHttpTransportObservation,
          }),
        )}\n`,
      );
    },
  );
}
