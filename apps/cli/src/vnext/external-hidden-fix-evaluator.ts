import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rm,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";

import {
  JsonValueSchema,
  Sha256DigestV1Schema,
  asSha256DigestV1,
  asTaskId,
  type Sha256DigestV1,
} from "@chronorift/domain";
import { canonicalJson } from "@chronorift/json-artifacts";
import { z } from "zod";

import {
  ExternalHiddenFixFreshRunReceiptV1Schema,
  ExternalHiddenFixPatchReferenceV1Schema,
  runExternalHiddenFixEvaluatorOnceV1,
  type ExternalHiddenFixAssignmentStoreV1,
  type ExternalHiddenFixEvaluationRequestV1,
  type ExternalHiddenFixFreshCopyRunInputV1,
  type ExternalHiddenFixFreshCopyAcceptanceReceiptV1,
  type ExternalHiddenFixFreshCopyFailureCodeV1,
  type ExternalHiddenFixFreshCopyRunFailureV1,
  type ExternalHiddenFixFreshCopyRunnerV1,
  type ExternalHiddenFixPatchReferenceV1,
} from "./external-hidden-fix.js";
import { publishPrivateFileOnceV1 } from "./private-atomic-publication.js";
import { collectCandidateGodotSourceV1 } from "./candidate-godot-build.js";
import { selectedTreeSha256 } from "./selected-tree.js";
import {
  CgroupSetupCleanupErrorV1,
  CgroupV2Controller,
  waitForCgroupEmpty,
  type CgroupEnforcementLimitsV1,
  type ExecutionCgroupScope,
} from "./cgroup-v2.js";
import {
  startSandboxBootstrap,
  type SandboxBootstrapSession,
} from "./sandbox-bootstrap.js";
import {
  SANDBOX_TASK_STORAGE_MINIMUM_HEADROOM_BYTES_V1,
  SANDBOX_TASK_STORAGE_MINIMUM_HEADROOM_INODES_V1,
  assertSandboxTaskStorageHeadroomV1,
  inspectSandboxTaskStorageRoot,
  type SandboxTaskStorageInspection,
  type SandboxTaskStorageInspectionPort,
  type SandboxTaskStorageHeadroomV1,
} from "./sandbox-preflight.js";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const PATCH_BYTE_LIMIT = 512 * 1024 * 1024;
const PROCESS_OUTPUT_BYTE_LIMIT = 1024 * 1024;
const DEFAULT_EVALUATOR_TIMEOUT_MS = 120_000;
const EVALUATOR_FILE_SIZE_MAX_BYTES = 1024 * 1024 * 1024;

export const EXTERNAL_HIDDEN_FIX_EVALUATOR_LIMITS_V1 = Object.freeze({
  cpuMax: "200000 100000",
  memoryMaxBytes: 1024 * 1024 * 1024,
  memorySwapMaxBytes: 0,
  pidsMax: 128,
} satisfies CgroupEnforcementLimitsV1);

const evaluatorResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    outcome: z.enum(["passed", "failed"]),
    observation: JsonValueSchema,
  })
  .strict();

export type ExternalHiddenFixEvaluatorProcessResultV1 = Readonly<{
  processStarted: true;
  processCleanupProven: true;
  outcome: "passed" | "failed";
  observationSha256: Sha256DigestV1;
}>;

export interface ExternalHiddenFixEvaluatorProcessInputV1 {
  readonly evaluatorImplementationPath: string;
  readonly evaluatorBundlePath: string;
  readonly workspaceRoot: string;
  readonly importCacheRoot: string;
  readonly freshCopyId: string;
  readonly scenarioClass:
    "public_reproduction" | "hidden_variant" | "regression_control";
  readonly repetition: 1 | 2 | 3;
}

/**
 * This is the only oracle-facing port. Its input intentionally contains no
 * ProjectAdapter, Agent Task/session, workflow receipt, or runtime record.
 */
export interface ExternalHiddenFixEvaluatorProcessPortV1 {
  evaluate(
    input: ExternalHiddenFixEvaluatorProcessInputV1,
    signal?: AbortSignal,
  ): Promise<ExternalHiddenFixEvaluatorProcessResultV1>;
}

/** Host-only evidence emitted immediately before evaluator cache/process work. */
export interface ExternalHiddenFixEvaluatorHeadroomObservationV1 {
  readonly runOrdinal: number;
  readonly taskStorage: SandboxTaskStorageHeadroomV1;
  readonly evaluatorStorage: SandboxTaskStorageHeadroomV1;
  readonly observedAt?: string | undefined;
}

export type ExternalHiddenFixEvaluatorHeadroomObserverV1 = (
  observation: ExternalHiddenFixEvaluatorHeadroomObservationV1,
) => Promise<unknown>;

const taskStorageHeadroomSchema = z
  .object({
    schemaVersion: z.literal(1),
    availableBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    availableInodes: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER),
    requiredAvailableBytes: z.literal(
      SANDBOX_TASK_STORAGE_MINIMUM_HEADROOM_BYTES_V1,
    ),
    requiredAvailableInodes: z.literal(
      SANDBOX_TASK_STORAGE_MINIMUM_HEADROOM_INODES_V1,
    ),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.availableBytes < value.requiredAvailableBytes) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["availableBytes"],
        message: "Task-storage byte headroom is below its required bound",
      });
    }
    if (value.availableInodes < value.requiredAvailableInodes) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["availableInodes"],
        message: "Task-storage inode headroom is below its required bound",
      });
    }
  });

const parseTaskStorageHeadroom = (
  value: unknown,
): SandboxTaskStorageHeadroomV1 =>
  Object.freeze(taskStorageHeadroomSchema.parse(value));

/** Carries truthful pre-process failure and cleanup state to a Host composer. */
export class ExternalHiddenFixFreshCopyInfrastructureErrorV1
  extends Error
  implements ExternalHiddenFixFreshCopyRunFailureV1
{
  public readonly failureCode: ExternalHiddenFixFreshCopyFailureCodeV1;
  public readonly cleanupProven: boolean;

  public constructor(input: {
    readonly failureCode: ExternalHiddenFixFreshCopyFailureCodeV1;
    readonly cleanupProven: boolean;
    readonly message: string;
    readonly cause?: unknown;
  }) {
    super(input.message, { cause: input.cause });
    this.name = "ExternalHiddenFixFreshCopyInfrastructureErrorV1";
    this.failureCode = input.failureCode;
    this.cleanupProven = input.cleanupProven;
  }
}

class ExternalHiddenFixEvaluatorProcessInfrastructureErrorV1 extends Error {
  public readonly processStarted: boolean;
  public readonly cleanupProven: boolean;

  public constructor(input: {
    readonly processStarted: boolean;
    readonly cleanupProven: boolean;
    readonly message: string;
    readonly cause?: unknown;
  }) {
    super(input.message, { cause: input.cause });
    this.name = "ExternalHiddenFixEvaluatorProcessInfrastructureErrorV1";
    this.processStarted = input.processStarted;
    this.cleanupProven = input.cleanupProven;
  }
}

const digest = (bytes: string | Uint8Array): Sha256DigestV1 =>
  asSha256DigestV1(createHash("sha256").update(bytes).digest("hex"));

const digestJson = (value: unknown): Sha256DigestV1 =>
  digest(canonicalJson(JsonValueSchema.parse(value)));

const projectEnvironmentSourceIdentity = async (
  workspaceRoot: string,
): Promise<Sha256DigestV1> =>
  selectedTreeSha256(
    await collectCandidateGodotSourceV1(
      workspaceRoot,
      "project-environment",
      "tracked-tool-scripts-v1",
    ),
  );

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

const assertDisjoint = (left: string, right: string, message: string): void => {
  if (pathWithinOrEqual(left, right) || pathWithinOrEqual(right, left)) {
    throw new Error(message);
  }
};

const effectiveUserId = (): number => {
  const uid = process.geteuid?.();
  if (uid === undefined) {
    throw new Error(
      "M6 local evaluator requires effective-user ownership checks",
    );
  }
  return uid;
};

interface DirectoryIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly uid: number;
  readonly mode: number;
}

const requirePrivateDirectory = async (
  inputPath: string,
  label: string,
): Promise<{ readonly path: string; readonly identity: DirectoryIdentity }> => {
  const path = resolve(inputPath);
  const metadata = await lstat(path);
  if (
    metadata.isSymbolicLink() ||
    !metadata.isDirectory() ||
    (metadata.mode & 0o7777) !== PRIVATE_DIRECTORY_MODE ||
    metadata.uid !== effectiveUserId() ||
    (await realpath(path)) !== path
  ) {
    throw new Error(`${label} must be a canonical owned mode-0700 directory`);
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

const requireDirectoryIdentity = async (
  path: string,
  expected: DirectoryIdentity,
  label: string,
): Promise<void> => {
  const metadata = await lstat(path);
  if (
    metadata.isSymbolicLink() ||
    !metadata.isDirectory() ||
    metadata.dev !== expected.dev ||
    metadata.ino !== expected.ino ||
    metadata.uid !== expected.uid ||
    metadata.mode !== expected.mode ||
    (metadata.mode & 0o7777) !== PRIVATE_DIRECTORY_MODE ||
    (await realpath(path)) !== path
  ) {
    throw new Error(`${label} identity changed`);
  }
};

const requireCanonicalDirectory = async (
  inputPath: string,
  label: string,
): Promise<string> => {
  const path = resolve(inputPath);
  const metadata = await lstat(path);
  if (
    metadata.isSymbolicLink() ||
    !metadata.isDirectory() ||
    (await realpath(path)) !== path
  ) {
    throw new Error(`${label} must be a canonical real directory`);
  }
  return path;
};

const readPrivateFile = async (input: {
  readonly root: string;
  readonly path: string;
  readonly expectedSha256: Sha256DigestV1;
  readonly expectedByteLength: number;
}): Promise<Uint8Array> => {
  if (!pathWithinOrEqual(input.root, input.path)) {
    throw new Error("M6 protected patch path escaped its root");
  }
  const handle = await open(
    input.path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const metadata = await handle.stat();
    const pathMetadata = await lstat(input.path);
    if (
      !metadata.isFile() ||
      metadata.nlink !== 1 ||
      metadata.uid !== effectiveUserId() ||
      (metadata.mode & 0o7777) !== PRIVATE_FILE_MODE ||
      metadata.size !== input.expectedByteLength ||
      metadata.size > PATCH_BYTE_LIMIT ||
      metadata.dev !== pathMetadata.dev ||
      metadata.ino !== pathMetadata.ino ||
      pathMetadata.isSymbolicLink() ||
      (await realpath(input.path)) !== input.path
    ) {
      throw new Error("M6 protected patch is not its frozen private file");
    }
    const bytes = await handle.readFile();
    if (
      bytes.byteLength !== input.expectedByteLength ||
      digest(bytes) !== input.expectedSha256
    ) {
      throw new Error("M6 protected patch bytes changed");
    }
    return bytes;
  } finally {
    await handle.close();
  }
};

const requireFrozenEvaluatorFile = async (input: {
  readonly path: string;
  readonly expectedSha256: Sha256DigestV1;
  readonly label: string;
}): Promise<void> => {
  const path = resolve(input.path);
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const metadata = await handle.stat();
    const pathMetadata = await lstat(path);
    if (
      !metadata.isFile() ||
      metadata.nlink !== 1 ||
      metadata.uid !== effectiveUserId() ||
      (metadata.mode & 0o7777) !== PRIVATE_FILE_MODE ||
      metadata.size > PROCESS_OUTPUT_BYTE_LIMIT ||
      pathMetadata.isSymbolicLink() ||
      metadata.dev !== pathMetadata.dev ||
      metadata.ino !== pathMetadata.ino ||
      (await realpath(path)) !== path
    ) {
      throw new Error(`${input.label} is not its frozen private file`);
    }
    if (digest(await handle.readFile()) !== input.expectedSha256) {
      throw new Error(`${input.label} hash changed`);
    }
  } finally {
    await handle.close();
  }
};

const patchFilename = (reference: ExternalHiddenFixPatchReferenceV1): string =>
  `${reference.artifactId.slice("m6-artifact:".length)}.patch`;

/** Host-only content-addressed patch storage used by the evaluator process. */
export class LocalExternalHiddenFixPatchStoreV1 {
  readonly #root: string;
  readonly #rootIdentity: DirectoryIdentity;

  private constructor(root: string, rootIdentity: DirectoryIdentity) {
    this.#root = root;
    this.#rootIdentity = rootIdentity;
  }

  public static async open(input: {
    readonly root: string;
    readonly exposedRoots: readonly string[];
  }): Promise<LocalExternalHiddenFixPatchStoreV1> {
    const root = await requirePrivateDirectory(
      input.root,
      "M6 protected patch root",
    );
    for (const [index, exposedInput] of input.exposedRoots.entries()) {
      const exposed = await requireCanonicalDirectory(
        exposedInput,
        `M6 Agent-exposed root ${index + 1}`,
      );
      assertDisjoint(
        root.path,
        exposed,
        "M6 protected patch root must be outside Agent-exposed roots",
      );
    }
    return new LocalExternalHiddenFixPatchStoreV1(root.path, root.identity);
  }

  async #requireRoot(): Promise<void> {
    await requireDirectoryIdentity(
      this.#root,
      this.#rootIdentity,
      "M6 protected patch root",
    );
  }

  #path(referenceInput: ExternalHiddenFixPatchReferenceV1): string {
    const reference =
      ExternalHiddenFixPatchReferenceV1Schema.parse(referenceInput);
    return join(this.#root, patchFilename(reference));
  }

  public async publishOnce(
    patchBytesInput: Uint8Array,
  ): Promise<ExternalHiddenFixPatchReferenceV1> {
    if (
      !(patchBytesInput instanceof Uint8Array) ||
      patchBytesInput.byteLength < 1 ||
      patchBytesInput.byteLength > PATCH_BYTE_LIMIT
    ) {
      throw new Error("M6 patch bytes exceed the supported nonempty range");
    }
    await this.#requireRoot();
    const rawSha256 = digest(patchBytesInput);
    const reference = ExternalHiddenFixPatchReferenceV1Schema.parse({
      schemaVersion: 1,
      artifactId: `m6-artifact:${rawSha256}`,
      rawSha256,
      byteLength: patchBytesInput.byteLength,
    });
    const path = await publishPrivateFileOnceV1({
      root: this.#root,
      filename: patchFilename(reference),
      bytes: patchBytesInput,
    });
    await readPrivateFile({
      root: this.#root,
      path,
      expectedSha256: reference.rawSha256,
      expectedByteLength: reference.byteLength,
    });
    return reference;
  }

  public async read(
    referenceInput: ExternalHiddenFixPatchReferenceV1,
  ): Promise<Uint8Array> {
    await this.#requireRoot();
    const reference =
      ExternalHiddenFixPatchReferenceV1Schema.parse(referenceInput);
    return readPrivateFile({
      root: this.#root,
      path: this.#path(reference),
      expectedSha256: reference.rawSha256,
      expectedByteLength: reference.byteLength,
    });
  }
}

interface BoundedProcessResult {
  readonly processStarted: boolean;
  readonly processGroupCleanupProven: boolean;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly aborted: boolean;
  readonly outputExceeded: boolean;
}

export interface EvaluatorCgroupControllerPortV1 {
  createExecutionScope(
    operationId: string,
    limits: CgroupEnforcementLimitsV1,
  ): Promise<ExecutionCgroupScope>;
  cleanup(): Promise<void>;
}

export interface ExternalHiddenFixEvaluatorResourceCleanupTruthV1 {
  readonly schemaVersion: 1;
  readonly runCount: number;
  readonly activeRunCount: number;
  readonly cleanupProven: boolean;
}

export interface ExternalHiddenFixEvaluatorCgroupDependenciesV1 {
  readonly createController: (input: {
    readonly delegatedCgroupRoot: string;
    readonly taskId: ReturnType<typeof asTaskId>;
  }) => Promise<EvaluatorCgroupControllerPortV1>;
  readonly startBootstrap: typeof startSandboxBootstrap;
  readonly waitForEmpty: typeof waitForCgroupEmpty;
}

const DEFAULT_EVALUATOR_CGROUP_DEPENDENCIES: ExternalHiddenFixEvaluatorCgroupDependenciesV1 =
  {
    createController: ({ delegatedCgroupRoot, taskId }) =>
      CgroupV2Controller.create(delegatedCgroupRoot, taskId),
    startBootstrap: startSandboxBootstrap,
    waitForEmpty: waitForCgroupEmpty,
  };

const readBoundedBootstrapStream = (
  stream: NodeJS.ReadableStream,
  onExceeded: () => void,
): Promise<Uint8Array> =>
  new Promise((resolveOutput, rejectOutput) => {
    const chunks: Buffer[] = [];
    let byteLength = 0;
    stream.on("data", (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      byteLength += bytes.byteLength;
      if (byteLength > PROCESS_OUTPUT_BYTE_LIMIT) {
        onExceeded();
        return;
      }
      chunks.push(Buffer.from(bytes));
    });
    stream.once("end", () => resolveOutput(Buffer.concat(chunks)));
    stream.once("error", rejectOutput);
  });

class ExternalHiddenFixEvaluatorCgroupOwnerV1 {
  #closed = false;
  #runCount = 0;
  #cleanupFailures = 0;
  readonly #active = new Map<AbortController, Promise<void>>();

  public constructor(
    private readonly delegatedCgroupRoot: string,
    private readonly taskId: ReturnType<typeof asTaskId>,
    private readonly dependencies: ExternalHiddenFixEvaluatorCgroupDependenciesV1,
  ) {}

  public async run(input: {
    readonly command: string;
    readonly args: readonly string[];
    readonly cwd: string;
    readonly timeoutMs: number;
    readonly signal?: AbortSignal | undefined;
  }): Promise<BoundedProcessResult> {
    if (this.#closed) {
      throw new ExternalHiddenFixEvaluatorProcessInfrastructureErrorV1({
        processStarted: false,
        cleanupProven: true,
        message: "M6 evaluator resource owner is closed",
      });
    }
    if (this.#active.size > 0) {
      throw new ExternalHiddenFixEvaluatorProcessInfrastructureErrorV1({
        processStarted: false,
        cleanupProven: true,
        message: "M6 evaluator resource owner does not allow concurrent runs",
      });
    }
    input.signal?.throwIfAborted();
    const localAbort = new AbortController();
    let resolveActive!: () => void;
    const activeDone = new Promise<void>((resolveDone) => {
      resolveActive = resolveDone;
    });
    this.#active.set(localAbort, activeDone);
    this.#runCount += 1;
    const runOrdinal = this.#runCount;
    const onExternalAbort = (): void => localAbort.abort(input.signal?.reason);
    input.signal?.addEventListener("abort", onExternalAbort, { once: true });

    let controller: EvaluatorCgroupControllerPortV1 | undefined;
    let scope: ExecutionCgroupScope | undefined;
    let session: SandboxBootstrapSession | undefined;
    let processStarted = false;
    let bootstrapExited = false;
    let timedOut = false;
    let aborted = false;
    let outputExceeded = false;
    let stdout: Uint8Array = new Uint8Array();
    let stderr: Uint8Array = new Uint8Array();
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    let primaryError: unknown;
    const requestStop = (): void => {
      if (session !== undefined)
        void session.terminate().catch(() => undefined);
      if (scope !== undefined) void scope.kill().catch(() => undefined);
    };
    const onAbort = (): void => {
      aborted = true;
      requestStop();
    };
    localAbort.signal.addEventListener("abort", onAbort, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      localAbort.abort(new Error("M6 evaluator cgroup run timed out"));
    }, input.timeoutMs);
    timeout.unref();
    let stdoutDrain: Promise<Uint8Array> | undefined;
    let stderrDrain: Promise<Uint8Array> | undefined;

    try {
      controller = await this.dependencies.createController({
        delegatedCgroupRoot: this.delegatedCgroupRoot,
        taskId: this.taskId,
      });
      if (localAbort.signal.aborted) throw localAbort.signal.reason;
      scope = await controller.createExecutionScope(
        `hidden-evaluator-${String(runOrdinal)}`,
        EXTERNAL_HIDDEN_FIX_EVALUATOR_LIMITS_V1,
      );
      if (localAbort.signal.aborted) throw localAbort.signal.reason;
      session = await this.dependencies.startBootstrap({
        cwd: input.cwd,
        inheritedFds: [],
      });
      stdoutDrain = readBoundedBootstrapStream(session.stdout, () => {
        outputExceeded = true;
        localAbort.abort(new Error("M6 evaluator stdout exceeded its bound"));
      });
      stderrDrain = readBoundedBootstrapStream(session.stderr, () => {
        outputExceeded = true;
        localAbort.abort(new Error("M6 evaluator stderr exceeded its bound"));
      });
      await scope.attach(session.pid);
      await scope.verifyAttached(await session.inspectCgroupMembership());
      if (localAbort.signal.aborted) throw localAbort.signal.reason;
      await session.launch({ executable: input.command, args: input.args });
      await Promise.all([
        session.waitForChildStarted().then(() => {
          processStarted = true;
        }),
        session.waitForSandboxStatus(),
      ]);
      if (localAbort.signal.aborted) throw localAbort.signal.reason;
      await session.authorize();
      await session.endStdin();
      const childExit = await session.waitForChildExit();
      exitCode = childExit.exitCode;
      exitSignal = childExit.signal;
      await session.waitForBootstrapExit();
      bootstrapExited = true;
    } catch (error) {
      primaryError = error;
    } finally {
      clearTimeout(timeout);
      localAbort.signal.removeEventListener("abort", onAbort);
      input.signal?.removeEventListener("abort", onExternalAbort);
      requestStop();
    }

    let cleanupProven = true;
    const cleanupFailures: unknown[] = [];
    if (primaryError instanceof CgroupSetupCleanupErrorV1) {
      let setupCleanupProven = false;
      let setupCleanupError: unknown = primaryError;
      for (let attempt = 0; attempt < 3 && !setupCleanupProven; attempt += 1) {
        try {
          await primaryError.retryCleanup();
          setupCleanupProven = true;
        } catch (error) {
          setupCleanupError = error;
        }
      }
      if (!setupCleanupProven) cleanupFailures.push(setupCleanupError);
    }
    if (session !== undefined && !bootstrapExited) {
      try {
        await session.terminate();
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    if (scope !== undefined) {
      try {
        await scope.kill();
        await this.dependencies.waitForEmpty(scope);
        await scope.remove();
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    if (controller !== undefined) {
      try {
        await controller.cleanup();
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    if (session !== undefined && !bootstrapExited) {
      try {
        await session.waitForBootstrapExit();
        bootstrapExited = true;
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    try {
      [stdout, stderr] = await Promise.all([
        stdoutDrain ?? Promise.resolve(new Uint8Array()),
        stderrDrain ?? Promise.resolve(new Uint8Array()),
      ]);
    } catch (error) {
      cleanupFailures.push(error);
    }
    cleanupProven =
      cleanupFailures.length === 0 &&
      (session === undefined || bootstrapExited);
    if (!cleanupProven) this.#cleanupFailures += 1;
    this.#active.delete(localAbort);
    resolveActive();

    if (primaryError !== undefined) {
      throw new ExternalHiddenFixEvaluatorProcessInfrastructureErrorV1({
        processStarted,
        cleanupProven,
        message: "M6 evaluator cgroup execution failed",
        cause:
          cleanupFailures.length === 0
            ? primaryError
            : new AggregateError(
                [primaryError, ...cleanupFailures],
                "M6 evaluator execution and cleanup failed",
              ),
      });
    }
    return {
      processStarted,
      processGroupCleanupProven: cleanupProven,
      stdout,
      stderr,
      exitCode,
      signal: exitSignal,
      timedOut,
      aborted,
      outputExceeded,
    };
  }

  public async cleanup(): Promise<ExternalHiddenFixEvaluatorResourceCleanupTruthV1> {
    this.#closed = true;
    const active = [...this.#active.entries()];
    for (const [controller] of active) controller.abort();
    await Promise.all(active.map(([, done]) => done));
    return Object.freeze({
      schemaVersion: 1,
      runCount: this.#runCount,
      activeRunCount: this.#active.size,
      cleanupProven: this.#active.size === 0 && this.#cleanupFailures === 0,
    });
  }
}

const processGroupExists = (processGroupId: number): boolean => {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ESRCH") return false;
    return true;
  }
};

const terminateProcessGroup = (processGroupId: number): void => {
  try {
    process.kill(-processGroupId, "SIGKILL");
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ESRCH") throw error;
  }
};

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolvePromise) => {
    setTimeout(resolvePromise, milliseconds);
  });

const proveProcessGroupGone = async (
  processGroupId: number | undefined,
): Promise<boolean> => {
  if (processGroupId === undefined) return true;
  for (let check = 0; check < 40; check += 1) {
    if (!processGroupExists(processGroupId)) return true;
    try {
      terminateProcessGroup(processGroupId);
    } catch {
      return false;
    }
    await delay(25);
  }
  return !processGroupExists(processGroupId);
};

const runBoundedProcess = async (input: {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly stdin?: Uint8Array | undefined;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal | undefined;
}): Promise<BoundedProcessResult> => {
  if (process.platform !== "linux") {
    throw new Error(
      "M6 local evaluator requires Linux process-group isolation",
    );
  }
  if (input.signal?.aborted === true) {
    throw new Error("M6 evaluator process was aborted before spawn");
  }
  const child = spawn(input.command, [...input.args], {
    cwd: input.cwd,
    env: { ...input.environment },
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
    windowsHide: true,
    detached: true,
  });
  const processGroupId = child.pid;
  let processStarted = false;
  let timedOut = false;
  let aborted = false;
  let outputExceeded = false;
  let stdoutBytes = 0;
  let stderrBytes = 0;
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];

  const stop = (): void => {
    if (
      child.exitCode === null &&
      child.signalCode === null &&
      processGroupId !== undefined
    ) {
      try {
        terminateProcessGroup(processGroupId);
      } catch {
        child.kill("SIGKILL");
      }
    }
  };
  const timeout = setTimeout(() => {
    timedOut = true;
    stop();
  }, input.timeoutMs);
  timeout.unref();
  const abort = (): void => {
    aborted = true;
    stop();
  };
  input.signal?.addEventListener("abort", abort, { once: true });

  child.once("spawn", () => {
    processStarted = true;
  });
  child.stdout.on("data", (chunk: Buffer) => {
    stdoutBytes += chunk.byteLength;
    if (stdoutBytes > PROCESS_OUTPUT_BYTE_LIMIT) {
      outputExceeded = true;
      stop();
      return;
    }
    stdout.push(Buffer.from(chunk));
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.byteLength;
    if (stderrBytes > PROCESS_OUTPUT_BYTE_LIMIT) {
      outputExceeded = true;
      stop();
      return;
    }
    stderr.push(Buffer.from(chunk));
  });
  child.stdin.on("error", () => {
    // A failed or early-exiting child is classified from close/error below.
  });
  if (input.stdin === undefined) child.stdin.end();
  else child.stdin.end(input.stdin);

  try {
    const closed = await new Promise<{
      readonly exitCode: number | null;
      readonly signal: NodeJS.Signals | null;
      readonly spawnError: Error | undefined;
    }>((resolvePromise) => {
      child.once("error", (error) => {
        resolvePromise({ exitCode: null, signal: null, spawnError: error });
      });
      child.once("close", (exitCode, signal) => {
        resolvePromise({ exitCode, signal, spawnError: undefined });
      });
    });
    const processGroupCleanupProven = await proveProcessGroupGone(
      processStarted ? processGroupId : undefined,
    );
    if (closed.spawnError !== undefined) {
      throw new ExternalHiddenFixEvaluatorProcessInfrastructureErrorV1({
        processStarted,
        cleanupProven: processGroupCleanupProven,
        message: "M6 evaluator-owned process could not be spawned",
        cause: closed.spawnError,
      });
    }
    return {
      processStarted,
      processGroupCleanupProven,
      stdout: Buffer.concat(stdout),
      stderr: Buffer.concat(stderr),
      exitCode: closed.exitCode,
      signal: closed.signal,
      timedOut,
      aborted,
      outputExceeded,
    };
  } finally {
    clearTimeout(timeout);
    input.signal?.removeEventListener("abort", abort);
  }
};

const minimalPathEnvironment = (): Readonly<Record<string, string>> => {
  const path = process.env["PATH"];
  return path === undefined ? {} : { PATH: path };
};

const parseEvaluatorProcessResult = (
  result: BoundedProcessResult,
): ExternalHiddenFixEvaluatorProcessResultV1 => {
  if (
    !result.processStarted ||
    !result.processGroupCleanupProven ||
    result.exitCode !== 0 ||
    result.signal !== null ||
    result.timedOut ||
    result.aborted ||
    result.outputExceeded
  ) {
    throw new Error("M6 evaluator process did not complete cleanly");
  }
  const decoded = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(result.stdout),
  ) as unknown;
  const evaluatorResult = evaluatorResultSchema.parse(decoded);
  return {
    processStarted: true,
    processCleanupProven: true,
    outcome: evaluatorResult.outcome,
    observationSha256: digestJson({
      schemaVersion: 1,
      evaluatorResult,
      stderrSha256: digest(result.stderr),
    }),
  };
};

const prepareEvaluatorCache = async (root: string) => {
  const xdgConfig = join(root, "config");
  const xdgData = join(root, "data");
  const xdgState = join(root, "state");
  await Promise.all([
    mkdir(xdgConfig, { mode: 0o700 }),
    mkdir(xdgData, { mode: 0o700 }),
    mkdir(xdgState, { mode: 0o700 }),
  ]);
  return Object.freeze({ xdgConfig, xdgData, xdgState });
};

/**
 * Starts the frozen JavaScript evaluator in a new Node process for every call.
 * It deliberately does not inherit the Host environment or model credentials.
 */
export class NodeExternalHiddenFixEvaluatorProcessV1 implements ExternalHiddenFixEvaluatorProcessPortV1 {
  readonly #timeoutMs: number;

  public constructor(input?: { readonly timeoutMs?: number | undefined }) {
    this.#timeoutMs = z
      .number()
      .int()
      .min(1)
      .max(10 * 60_000)
      .parse(input?.timeoutMs ?? DEFAULT_EVALUATOR_TIMEOUT_MS);
  }

  public async evaluate(
    input: ExternalHiddenFixEvaluatorProcessInputV1,
    signal?: AbortSignal,
  ): Promise<ExternalHiddenFixEvaluatorProcessResultV1> {
    let result: BoundedProcessResult | undefined;
    try {
      const { xdgConfig, xdgData, xdgState } = await prepareEvaluatorCache(
        input.importCacheRoot,
      );
      result = await runBoundedProcess({
        command: process.execPath,
        args: [input.evaluatorImplementationPath],
        cwd: input.workspaceRoot,
        environment: {
          ...minimalPathEnvironment(),
          LANG: "C.UTF-8",
          LC_ALL: "C.UTF-8",
          XDG_CACHE_HOME: input.importCacheRoot,
          XDG_CONFIG_HOME: xdgConfig,
          XDG_DATA_HOME: xdgData,
          XDG_STATE_HOME: xdgState,
          CHRONORIFT_M6_WORKSPACE: input.workspaceRoot,
          CHRONORIFT_M6_IMPORT_CACHE: input.importCacheRoot,
          CHRONORIFT_M6_EVALUATOR_BUNDLE: input.evaluatorBundlePath,
          CHRONORIFT_M6_FRESH_COPY_ID: input.freshCopyId,
          CHRONORIFT_M6_SCENARIO_CLASS: input.scenarioClass,
          CHRONORIFT_M6_REPETITION: String(input.repetition),
        },
        timeoutMs: this.#timeoutMs,
        signal,
      });
      return parseEvaluatorProcessResult(result);
    } catch (error) {
      if (
        error instanceof ExternalHiddenFixEvaluatorProcessInfrastructureErrorV1
      ) {
        throw error;
      }
      throw new ExternalHiddenFixEvaluatorProcessInfrastructureErrorV1({
        processStarted: result?.processStarted ?? false,
        cleanupProven: result?.processGroupCleanupProven ?? true,
        message: "M6 evaluator process did not produce a valid clean result",
        cause: error,
      });
    }
  }
}

export interface ExternalHiddenFixEvaluatorRuntimeMountV1 {
  readonly source: string;
  /** A single private name below /runtime/assets inside the namespace. */
  readonly target: `/runtime/assets/${string}`;
}

const evaluatorBwrapArguments = (input: {
  readonly nodePath: string;
  readonly runtimeMounts: readonly ExternalHiddenFixEvaluatorRuntimeMountV1[];
  readonly process: ExternalHiddenFixEvaluatorProcessInputV1;
  readonly authorizeWithBootstrap: boolean;
}): readonly string[] => {
  const runtimeArgs = input.runtimeMounts.flatMap((mount) => [
    "--ro-bind",
    mount.source,
    mount.target,
  ]);
  return [
    "--unshare-all",
    "--die-with-parent",
    "--new-session",
    "--clearenv",
    "--ro-bind",
    "/lib",
    "/lib",
    "--ro-bind",
    "/lib64",
    "/lib64",
    "--ro-bind",
    "/usr/lib",
    "/usr/lib",
    "--dir",
    "/runtime",
    "--dir",
    "/runtime/assets",
    "--dir",
    "/evaluator",
    "--ro-bind",
    input.nodePath,
    "/runtime/node",
    "--bind",
    input.process.workspaceRoot,
    "/workspace",
    "--bind",
    input.process.importCacheRoot,
    "/cache",
    "--ro-bind",
    input.process.evaluatorImplementationPath,
    "/evaluator/evaluator.mjs",
    "--ro-bind",
    input.process.evaluatorBundlePath,
    "/evaluator/bundle.json",
    ...runtimeArgs,
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    ...(input.authorizeWithBootstrap
      ? ["--bind", input.process.importCacheRoot, "/tmp"]
      : ["--tmpfs", "/tmp"]),
    "--chdir",
    "/workspace",
    "--setenv",
    "LANG",
    "C.UTF-8",
    "--setenv",
    "LC_ALL",
    "C.UTF-8",
    "--setenv",
    "XDG_CACHE_HOME",
    "/cache",
    "--setenv",
    "XDG_CONFIG_HOME",
    "/cache/config",
    "--setenv",
    "XDG_DATA_HOME",
    "/cache/data",
    "--setenv",
    "XDG_STATE_HOME",
    "/cache/state",
    "--setenv",
    "CHRONORIFT_M6_WORKSPACE",
    "/workspace",
    "--setenv",
    "CHRONORIFT_M6_IMPORT_CACHE",
    "/cache",
    "--setenv",
    "CHRONORIFT_M6_EVALUATOR_BUNDLE",
    "/evaluator/bundle.json",
    "--setenv",
    "CHRONORIFT_M6_FRESH_COPY_ID",
    input.process.freshCopyId,
    "--setenv",
    "CHRONORIFT_M6_SCENARIO_CLASS",
    input.process.scenarioClass,
    "--setenv",
    "CHRONORIFT_M6_REPETITION",
    String(input.process.repetition),
    ...(input.authorizeWithBootstrap
      ? ["--block-fd", "3", "--json-status-fd", "4"]
      : []),
    "--",
    "/runtime/node",
    "/evaluator/evaluator.mjs",
  ];
};

/**
 * Gate-facing evaluator process. Unlike the low-level Node process above, it
 * gives the oracle a private mount namespace containing only its fresh
 * workspace/cache, its two frozen files, the selected Node/runtime assets,
 * and system libraries. Agent Task/runtime stores and Host credentials are
 * absent rather than merely omitted from argv.
 */
export class BwrapExternalHiddenFixEvaluatorProcessV1 implements ExternalHiddenFixEvaluatorProcessPortV1 {
  readonly #bwrapPath: string;
  readonly #nodePath: string;
  readonly #runtimeMounts: readonly ExternalHiddenFixEvaluatorRuntimeMountV1[];
  readonly #timeoutMs: number;

  private constructor(input: {
    readonly bwrapPath: string;
    readonly nodePath: string;
    readonly runtimeMounts: readonly ExternalHiddenFixEvaluatorRuntimeMountV1[];
    readonly timeoutMs: number;
  }) {
    this.#bwrapPath = input.bwrapPath;
    this.#nodePath = input.nodePath;
    this.#runtimeMounts = input.runtimeMounts;
    this.#timeoutMs = input.timeoutMs;
  }

  public static async open(input: {
    readonly bwrapPath: string;
    readonly nodePath: string;
    readonly runtimeMounts?:
      readonly ExternalHiddenFixEvaluatorRuntimeMountV1[] | undefined;
    readonly forbiddenRoots: readonly string[];
    readonly timeoutMs?: number | undefined;
  }): Promise<BwrapExternalHiddenFixEvaluatorProcessV1> {
    const [bwrapPath, nodePath, ...forbiddenRoots] = await Promise.all([
      realpath(resolve(input.bwrapPath)),
      realpath(resolve(input.nodePath)),
      ...input.forbiddenRoots.map((path) => realpath(resolve(path))),
    ]);
    for (const [path, label] of [
      [bwrapPath, "bwrap"],
      [nodePath, "Node"],
    ] as const) {
      const metadata = await lstat(path);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new Error(`M6 evaluator ${label} must be a canonical real file`);
      }
    }
    const mounts = await Promise.all(
      (input.runtimeMounts ?? []).map(async (mount) => {
        if (!/^\/runtime\/assets\/[A-Za-z0-9._-]{1,128}$/u.test(mount.target)) {
          throw new Error("M6 evaluator runtime mount target is not bounded");
        }
        const source = await realpath(resolve(mount.source));
        if (
          forbiddenRoots.some(
            (root) =>
              pathWithinOrEqual(root, source) ||
              pathWithinOrEqual(source, root),
          )
        ) {
          throw new Error(
            "M6 evaluator runtime mount overlaps an Agent Task/runtime root",
          );
        }
        return Object.freeze({ source, target: mount.target });
      }),
    );
    if (new Set(mounts.map((mount) => mount.target)).size !== mounts.length) {
      throw new Error("M6 evaluator runtime mount targets must be unique");
    }
    return new BwrapExternalHiddenFixEvaluatorProcessV1({
      bwrapPath,
      nodePath,
      runtimeMounts: Object.freeze(mounts),
      timeoutMs: z
        .number()
        .int()
        .min(1)
        .max(10 * 60_000)
        .parse(input.timeoutMs ?? DEFAULT_EVALUATOR_TIMEOUT_MS),
    });
  }

  public async evaluate(
    input: ExternalHiddenFixEvaluatorProcessInputV1,
    signal?: AbortSignal,
  ): Promise<ExternalHiddenFixEvaluatorProcessResultV1> {
    let result: BoundedProcessResult | undefined;
    try {
      await prepareEvaluatorCache(input.importCacheRoot);
      result = await runBoundedProcess({
        command: this.#bwrapPath,
        args: evaluatorBwrapArguments({
          nodePath: this.#nodePath,
          runtimeMounts: this.#runtimeMounts,
          process: input,
          authorizeWithBootstrap: false,
        }),
        cwd: input.workspaceRoot,
        environment: { LANG: "C", LC_ALL: "C" },
        timeoutMs: this.#timeoutMs,
        signal,
      });
      return parseEvaluatorProcessResult(result);
    } catch (error) {
      if (
        error instanceof ExternalHiddenFixEvaluatorProcessInfrastructureErrorV1
      ) {
        throw error;
      }
      throw new ExternalHiddenFixEvaluatorProcessInfrastructureErrorV1({
        processStarted: result?.processStarted ?? false,
        cleanupProven: result?.processGroupCleanupProven ?? true,
        message: "M6 sandboxed evaluator did not produce a valid clean result",
        cause: error,
      });
    }
  }
}

export interface CgroupBwrapExternalHiddenFixEvaluatorProcessOpenDependenciesV1 {
  readonly storageInspection?: SandboxTaskStorageInspectionPort | undefined;
  readonly cgroup?:
    Partial<ExternalHiddenFixEvaluatorCgroupDependenciesV1> | undefined;
}

/**
 * Formal evaluator process owner. Every invocation rechecks both the shared
 * Task-storage headroom and its per-arm 1 GiB tmpfs, attaches a blocked
 * bootstrap to the arm's delegated cgroup before authorizing bubblewrap, and
 * removes that cgroup again before returning.
 */
export class CgroupBwrapExternalHiddenFixEvaluatorProcessV1 implements ExternalHiddenFixEvaluatorProcessPortV1 {
  readonly #bwrapPath: string;
  readonly #nodePath: string;
  readonly #prlimitPath: string;
  readonly #runtimeMounts: readonly ExternalHiddenFixEvaluatorRuntimeMountV1[];
  readonly #timeoutMs: number;
  readonly #assertTaskStorageHeadroom: () => Promise<SandboxTaskStorageHeadroomV1>;
  readonly #onHeadroomObserved: ExternalHiddenFixEvaluatorHeadroomObserverV1;
  readonly #now: () => string;
  readonly #evaluatorStorage: SandboxTaskStorageInspection;
  readonly #storageInspection: SandboxTaskStorageInspectionPort | undefined;
  readonly #owner: ExternalHiddenFixEvaluatorCgroupOwnerV1;
  #closed = false;
  #headroomObservationCount = 0;
  #activeEvaluation:
    | {
        readonly abort: AbortController;
        readonly done: Promise<void>;
        readonly resolveDone: () => void;
      }
    | undefined;

  private constructor(input: {
    readonly bwrapPath: string;
    readonly nodePath: string;
    readonly prlimitPath: string;
    readonly runtimeMounts: readonly ExternalHiddenFixEvaluatorRuntimeMountV1[];
    readonly timeoutMs: number;
    readonly assertTaskStorageHeadroom: () => Promise<SandboxTaskStorageHeadroomV1>;
    readonly onHeadroomObserved: ExternalHiddenFixEvaluatorHeadroomObserverV1;
    readonly now: () => string;
    readonly evaluatorStorage: SandboxTaskStorageInspection;
    readonly storageInspection?: SandboxTaskStorageInspectionPort | undefined;
    readonly owner: ExternalHiddenFixEvaluatorCgroupOwnerV1;
  }) {
    this.#bwrapPath = input.bwrapPath;
    this.#nodePath = input.nodePath;
    this.#prlimitPath = input.prlimitPath;
    this.#runtimeMounts = input.runtimeMounts;
    this.#timeoutMs = input.timeoutMs;
    this.#assertTaskStorageHeadroom = input.assertTaskStorageHeadroom;
    this.#onHeadroomObserved = input.onHeadroomObserved;
    this.#now = input.now;
    this.#evaluatorStorage = input.evaluatorStorage;
    this.#storageInspection = input.storageInspection;
    this.#owner = input.owner;
  }

  public static async open(
    input: {
      readonly bwrapPath: string;
      readonly nodePath: string;
      readonly prlimitPath: string;
      readonly delegatedCgroupRoot: string;
      readonly taskId: string;
      /** Exact frozen Task-storage guard owned by this arm's preparation. */
      readonly assertTaskStorageHeadroom: () => Promise<SandboxTaskStorageHeadroomV1>;
      readonly onHeadroomObserved: ExternalHiddenFixEvaluatorHeadroomObserverV1;
      readonly now?: (() => string) | undefined;
      readonly taskStorageRoot: string;
      /** Must itself be the root mount of a private capacity-bounded tmpfs. */
      readonly evaluatorTemporaryRoot: string;
      readonly runtimeMounts?:
        readonly ExternalHiddenFixEvaluatorRuntimeMountV1[] | undefined;
      readonly forbiddenRoots: readonly string[];
      readonly timeoutMs?: number | undefined;
    },
    overrides: CgroupBwrapExternalHiddenFixEvaluatorProcessOpenDependenciesV1 = {},
  ): Promise<CgroupBwrapExternalHiddenFixEvaluatorProcessV1> {
    const [bwrapPath, nodePath, prlimitPath, ...forbiddenRoots] =
      await Promise.all([
        realpath(resolve(input.bwrapPath)),
        realpath(resolve(input.nodePath)),
        realpath(resolve(input.prlimitPath)),
        ...input.forbiddenRoots.map((path) => realpath(resolve(path))),
      ]);
    for (const [path, label] of [
      [bwrapPath, "bwrap"],
      [nodePath, "Node"],
      [prlimitPath, "prlimit"],
    ] as const) {
      const metadata = await lstat(path);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new Error(`M6 evaluator ${label} must be a canonical real file`);
      }
    }
    const mounts = await Promise.all(
      (input.runtimeMounts ?? []).map(async (mount) => {
        if (!/^\/runtime\/assets\/[A-Za-z0-9._-]{1,128}$/u.test(mount.target)) {
          throw new Error("M6 evaluator runtime mount target is not bounded");
        }
        const source = await realpath(resolve(mount.source));
        if (
          forbiddenRoots.some(
            (root) =>
              pathWithinOrEqual(root, source) ||
              pathWithinOrEqual(source, root),
          )
        ) {
          throw new Error(
            "M6 evaluator runtime mount overlaps an Agent Task/runtime root",
          );
        }
        return Object.freeze({ source, target: mount.target });
      }),
    );
    if (new Set(mounts.map((mount) => mount.target)).size !== mounts.length) {
      throw new Error("M6 evaluator runtime mount targets must be unique");
    }
    const evaluatorStorage = await inspectSandboxTaskStorageRoot(
      input.evaluatorTemporaryRoot,
      overrides.storageInspection,
    );
    assertDisjoint(
      evaluatorStorage.binding.taskStorageRoot,
      input.taskStorageRoot,
      "M6 evaluator tmpfs and Task storage must be distinct mounts",
    );
    const dependencies = {
      ...DEFAULT_EVALUATOR_CGROUP_DEPENDENCIES,
      ...overrides.cgroup,
    };
    return new CgroupBwrapExternalHiddenFixEvaluatorProcessV1({
      bwrapPath,
      nodePath,
      prlimitPath,
      runtimeMounts: Object.freeze(mounts),
      timeoutMs: z
        .number()
        .int()
        .min(1)
        .max(10 * 60_000)
        .parse(input.timeoutMs ?? DEFAULT_EVALUATOR_TIMEOUT_MS),
      assertTaskStorageHeadroom: input.assertTaskStorageHeadroom,
      onHeadroomObserved: input.onHeadroomObserved,
      now: input.now ?? (() => new Date().toISOString()),
      evaluatorStorage,
      ...(overrides.storageInspection === undefined
        ? {}
        : { storageInspection: overrides.storageInspection }),
      owner: new ExternalHiddenFixEvaluatorCgroupOwnerV1(
        input.delegatedCgroupRoot,
        asTaskId(input.taskId),
        dependencies,
      ),
    });
  }

  public async evaluate(
    input: ExternalHiddenFixEvaluatorProcessInputV1,
    signal?: AbortSignal,
  ): Promise<ExternalHiddenFixEvaluatorProcessResultV1> {
    if (
      !pathWithinOrEqual(
        this.#evaluatorStorage.binding.taskStorageRoot,
        resolve(input.workspaceRoot),
      ) ||
      !pathWithinOrEqual(
        this.#evaluatorStorage.binding.taskStorageRoot,
        resolve(input.importCacheRoot),
      )
    ) {
      throw new ExternalHiddenFixEvaluatorProcessInfrastructureErrorV1({
        processStarted: false,
        cleanupProven: true,
        message: "M6 evaluator writable roots escaped their bounded tmpfs",
      });
    }
    if (this.#closed) {
      throw new ExternalHiddenFixEvaluatorProcessInfrastructureErrorV1({
        processStarted: false,
        cleanupProven: true,
        message: "M6 resource-bounded evaluator is closed",
      });
    }
    if (this.#activeEvaluation !== undefined) {
      throw new ExternalHiddenFixEvaluatorProcessInfrastructureErrorV1({
        processStarted: false,
        cleanupProven: true,
        message: "M6 resource-bounded evaluator does not allow concurrent runs",
      });
    }
    signal?.throwIfAborted();
    const evaluationAbort = new AbortController();
    let resolveEvaluation!: () => void;
    const evaluationDone = new Promise<void>((resolveDone) => {
      resolveEvaluation = resolveDone;
    });
    this.#activeEvaluation = {
      abort: evaluationAbort,
      done: evaluationDone,
      resolveDone: resolveEvaluation,
    };
    const evaluationSignal =
      signal === undefined
        ? evaluationAbort.signal
        : AbortSignal.any([signal, evaluationAbort.signal]);
    let result: BoundedProcessResult | undefined;
    try {
      const [taskStorageResult, evaluatorStorageResult] = await Promise.all([
        this.#assertTaskStorageHeadroom(),
        assertSandboxTaskStorageHeadroomV1(
          this.#evaluatorStorage.capability,
          this.#evaluatorStorage.binding.taskStorageRoot,
          this.#storageInspection,
        ),
      ]);
      evaluationSignal.throwIfAborted();
      const taskStorage = parseTaskStorageHeadroom(taskStorageResult);
      const evaluatorStorage = parseTaskStorageHeadroom(evaluatorStorageResult);
      const runOrdinal = this.#headroomObservationCount + 1;
      const observedAt = z
        .string()
        .datetime({ offset: true })
        .parse(this.#now());
      this.#headroomObservationCount = runOrdinal;
      await this.#onHeadroomObserved(
        Object.freeze({
          runOrdinal,
          taskStorage,
          evaluatorStorage,
          observedAt,
        }),
      );
      evaluationSignal.throwIfAborted();
      await prepareEvaluatorCache(input.importCacheRoot);
      evaluationSignal.throwIfAborted();
      result = await this.#owner.run({
        command: this.#prlimitPath,
        args: [
          "--nofile=1024:1024",
          `--fsize=${String(EVALUATOR_FILE_SIZE_MAX_BYTES)}:${String(EVALUATOR_FILE_SIZE_MAX_BYTES)}`,
          "--core=0:0",
          "--",
          this.#bwrapPath,
          ...evaluatorBwrapArguments({
            nodePath: this.#nodePath,
            runtimeMounts: this.#runtimeMounts,
            process: input,
            authorizeWithBootstrap: true,
          }),
        ],
        cwd: input.workspaceRoot,
        timeoutMs: this.#timeoutMs,
        signal: evaluationSignal,
      });
      return parseEvaluatorProcessResult(result);
    } catch (error) {
      if (
        error instanceof ExternalHiddenFixEvaluatorProcessInfrastructureErrorV1
      ) {
        throw error;
      }
      throw new ExternalHiddenFixEvaluatorProcessInfrastructureErrorV1({
        processStarted: result?.processStarted ?? false,
        cleanupProven: result?.processGroupCleanupProven ?? true,
        message: "M6 resource-bounded evaluator did not produce a clean result",
        cause: error,
      });
    } finally {
      const active = this.#activeEvaluation;
      this.#activeEvaluation = undefined;
      active?.resolveDone();
    }
  }

  public async cleanup(): Promise<ExternalHiddenFixEvaluatorResourceCleanupTruthV1> {
    this.#closed = true;
    const active = this.#activeEvaluation;
    active?.abort.abort(new Error("M6 evaluator cleanup requested"));
    await active?.done;
    return this.#owner.cleanup();
  }
}

const runGitApply = async (input: {
  readonly workspaceRoot: string;
  readonly patchBytes: Uint8Array;
  readonly checkOnly: boolean;
  readonly gitBinary: string;
  readonly signal?: AbortSignal | undefined;
}): Promise<void> => {
  const result = await runBoundedProcess({
    command: input.gitBinary,
    args: [
      "apply",
      ...(input.checkOnly ? ["--check"] : []),
      "--binary",
      "--whitespace=nowarn",
      "-",
    ],
    cwd: input.workspaceRoot,
    environment: {
      ...minimalPathEnvironment(),
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CEILING_DIRECTORIES: input.workspaceRoot,
    },
    stdin: input.patchBytes,
    timeoutMs: 60_000,
    signal: input.signal,
  });
  if (
    !result.processStarted ||
    !result.processGroupCleanupProven ||
    result.exitCode !== 0 ||
    result.signal !== null ||
    result.timedOut ||
    result.aborted ||
    result.outputExceeded
  ) {
    throw new ExternalHiddenFixEvaluatorProcessInfrastructureErrorV1({
      processStarted: result.processStarted,
      cleanupProven: result.processGroupCleanupProven,
      message: input.checkOnly
        ? "M6 frozen patch failed fresh-copy check"
        : "M6 frozen patch failed fresh-copy apply",
    });
  }
};

class CreatedEvaluatorRunRootV1 {
  readonly #identity: Promise<Pick<DirectoryIdentity, "dev" | "ino" | "uid">>;

  public constructor(readonly path: string) {
    this.#identity = lstat(path).then((metadata) => {
      if (
        metadata.isSymbolicLink() ||
        !metadata.isDirectory() ||
        metadata.uid !== effectiveUserId()
      ) {
        throw new Error("M6 evaluator run root identity is invalid");
      }
      return { dev: metadata.dev, ino: metadata.ino, uid: metadata.uid };
    });
    void this.#identity.catch(() => undefined);
  }

  public async cleanup(): Promise<boolean> {
    try {
      const expected = await this.#identity;
      const current = await lstat(this.path);
      if (
        current.isSymbolicLink() ||
        !current.isDirectory() ||
        current.dev !== expected.dev ||
        current.ino !== expected.ino ||
        current.uid !== expected.uid ||
        (await realpath(this.path)) !== this.path
      ) {
        throw new Error("M6 evaluator run root identity changed");
      }
      await rm(this.path, { recursive: true, force: false });
      try {
        await lstat(this.path);
        return false;
      } catch (error) {
        return isNodeError(error) && error.code === "ENOENT";
      }
    } catch (error) {
      return isNodeError(error) && error.code === "ENOENT";
    }
  }
}

/** Concrete implementation of one entry in the frozen 3x3 plan. */
export class LocalExternalHiddenFixFreshCopyRunnerV1 implements ExternalHiddenFixFreshCopyRunnerV1 {
  readonly #temporaryRoot: string;
  readonly #temporaryRootIdentity: DirectoryIdentity;
  readonly #patchStore: LocalExternalHiddenFixPatchStoreV1;
  readonly #evaluator: ExternalHiddenFixEvaluatorProcessPortV1;
  readonly #gitBinary: string;

  private constructor(input: {
    readonly temporaryRoot: string;
    readonly temporaryRootIdentity: DirectoryIdentity;
    readonly patchStore: LocalExternalHiddenFixPatchStoreV1;
    readonly evaluator: ExternalHiddenFixEvaluatorProcessPortV1;
    readonly gitBinary: string;
  }) {
    this.#temporaryRoot = input.temporaryRoot;
    this.#temporaryRootIdentity = input.temporaryRootIdentity;
    this.#patchStore = input.patchStore;
    this.#evaluator = input.evaluator;
    this.#gitBinary = input.gitBinary;
  }

  public static async open(input: {
    readonly temporaryRoot: string;
    readonly exposedRoots: readonly string[];
    readonly patchStore: LocalExternalHiddenFixPatchStoreV1;
    readonly evaluator: ExternalHiddenFixEvaluatorProcessPortV1;
    readonly gitBinary?: string | undefined;
  }): Promise<LocalExternalHiddenFixFreshCopyRunnerV1> {
    const temporary = await requirePrivateDirectory(
      input.temporaryRoot,
      "M6 evaluator temporary root",
    );
    for (const [index, exposedInput] of input.exposedRoots.entries()) {
      const exposed = await requireCanonicalDirectory(
        exposedInput,
        `M6 Agent-exposed root ${index + 1}`,
      );
      assertDisjoint(
        temporary.path,
        exposed,
        "M6 evaluator temporary root must be outside Agent-exposed roots",
      );
    }
    return new LocalExternalHiddenFixFreshCopyRunnerV1({
      temporaryRoot: temporary.path,
      temporaryRootIdentity: temporary.identity,
      patchStore: input.patchStore,
      evaluator: input.evaluator,
      gitBinary: z
        .string()
        .min(1)
        .max(4_096)
        .parse(input.gitBinary ?? "git"),
    });
  }

  public async runFreshCopy(
    input: ExternalHiddenFixFreshCopyRunInputV1,
    signal?: AbortSignal,
  ): Promise<z.infer<typeof ExternalHiddenFixFreshRunReceiptV1Schema>> {
    await requireDirectoryIdentity(
      this.#temporaryRoot,
      this.#temporaryRootIdentity,
      "M6 evaluator temporary root",
    );
    const baselineRoot = await requireCanonicalDirectory(
      input.baselineRoot,
      "M6 assignment baseline",
    );
    assertDisjoint(
      this.#temporaryRoot,
      baselineRoot,
      "M6 evaluator temporary root and frozen baseline must be disjoint",
    );

    let runRoot: string | undefined;
    let runRootOwner: CreatedEvaluatorRunRootV1 | undefined;
    let processResult: ExternalHiddenFixEvaluatorProcessResultV1 | undefined;
    let failure:
      | {
          readonly code: ExternalHiddenFixFreshCopyFailureCodeV1;
          readonly cause: unknown;
        }
      | undefined;
    let baselineSelectedTreeSha256: Sha256DigestV1 | undefined;
    let candidateSelectedTreeSha256: Sha256DigestV1 | undefined;
    let activeFailureCode: ExternalHiddenFixFreshCopyFailureCodeV1 =
      "fresh_copy_failed";
    let processCleanupProven = true;

    try {
      signal?.throwIfAborted();
      runRoot = await mkdtemp(
        join(this.#temporaryRoot, `m6-${String(input.plan.ordinal)}-`),
      );
      runRootOwner = new CreatedEvaluatorRunRootV1(runRoot);
      await chmod(runRoot, PRIVATE_DIRECTORY_MODE);
      const protectedRunRoot = await requirePrivateDirectory(
        runRoot,
        "M6 evaluator run root",
      );
      runRoot = protectedRunRoot.path;
      const workspaceRoot = join(runRoot, "workspace");
      const importCacheRoot = join(runRoot, "import-cache");
      await cp(baselineRoot, workspaceRoot, {
        recursive: true,
        dereference: false,
        errorOnExist: true,
        force: false,
        preserveTimestamps: false,
      });
      await mkdir(importCacheRoot, { mode: PRIVATE_DIRECTORY_MODE });
      baselineSelectedTreeSha256 =
        await projectEnvironmentSourceIdentity(workspaceRoot);
      if (baselineSelectedTreeSha256 !== input.baselineSelectedTreeSha256) {
        throw new ExternalHiddenFixFreshCopyInfrastructureErrorV1({
          failureCode: "assignment_mismatch",
          cleanupProven: false,
          message: "M6 fresh baseline does not match the Host-only assignment",
        });
      }
      let patchBytes: Uint8Array;
      try {
        patchBytes = await this.#patchStore.read(input.patch);
      } catch (error) {
        throw new ExternalHiddenFixFreshCopyInfrastructureErrorV1({
          failureCode: "assignment_mismatch",
          cleanupProven: false,
          message: "M6 frozen patch reference could not be resolved",
          cause: error,
        });
      }
      await runGitApply({
        workspaceRoot,
        patchBytes,
        checkOnly: true,
        gitBinary: this.#gitBinary,
        signal,
      });
      await runGitApply({
        workspaceRoot,
        patchBytes,
        checkOnly: false,
        gitBinary: this.#gitBinary,
        signal,
      });
      candidateSelectedTreeSha256 =
        await projectEnvironmentSourceIdentity(workspaceRoot);
      if (
        candidateSelectedTreeSha256 !==
        input.expectedCandidateSelectedTreeSha256
      ) {
        throw new ExternalHiddenFixFreshCopyInfrastructureErrorV1({
          failureCode: "candidate_tree_mismatch",
          cleanupProven: false,
          message:
            "M6 patched fresh copy does not match the frozen candidate tree",
        });
      }
      try {
        await Promise.all([
          requireFrozenEvaluatorFile({
            path: input.evaluatorImplementationPath,
            expectedSha256: input.evaluatorImplementationSha256,
            label: "M6 evaluator implementation",
          }),
          requireFrozenEvaluatorFile({
            path: input.evaluatorBundlePath,
            expectedSha256: input.evaluatorBundleSha256,
            label: "M6 evaluator bundle",
          }),
        ]);
      } catch (error) {
        throw new ExternalHiddenFixFreshCopyInfrastructureErrorV1({
          failureCode: "assignment_mismatch",
          cleanupProven: false,
          message: "M6 frozen evaluator bytes changed before invocation",
          cause: error,
        });
      }
      activeFailureCode = "runner_failed";
      processCleanupProven = false;
      processResult = await this.#evaluator.evaluate(
        {
          evaluatorImplementationPath: input.evaluatorImplementationPath,
          evaluatorBundlePath: input.evaluatorBundlePath,
          workspaceRoot,
          importCacheRoot,
          freshCopyId: input.plan.freshCopyId,
          scenarioClass: input.plan.scenarioClass,
          repetition: input.plan.repetition,
        },
        signal,
      );
      processCleanupProven = processResult.processCleanupProven;
      if (
        (await projectEnvironmentSourceIdentity(workspaceRoot)) !==
        candidateSelectedTreeSha256
      ) {
        throw new ExternalHiddenFixFreshCopyInfrastructureErrorV1({
          failureCode: "runner_failed",
          cleanupProven: false,
          message: "M6 evaluator changed the frozen candidate source tree",
        });
      }
    } catch (error) {
      if (
        error instanceof ExternalHiddenFixEvaluatorProcessInfrastructureErrorV1
      ) {
        processCleanupProven = error.cleanupProven;
      }
      const typed =
        error instanceof ExternalHiddenFixFreshCopyInfrastructureErrorV1
          ? error
          : undefined;
      failure = {
        code:
          typed?.failureCode ??
          (signal?.aborted === true ? "runner_failed" : activeFailureCode),
        cause: error,
      };
    }

    const directoryCleanupProven =
      runRoot === undefined
        ? true
        : runRootOwner === undefined
          ? false
          : await runRootOwner.cleanup();
    const cleanupProven = directoryCleanupProven && processCleanupProven;
    if (failure !== undefined) {
      throw new ExternalHiddenFixFreshCopyInfrastructureErrorV1({
        failureCode: cleanupProven ? failure.code : "cleanup_failed",
        cleanupProven,
        message: "M6 fresh-copy evaluator run failed",
        cause: failure.cause,
      });
    }
    if (
      processResult === undefined ||
      baselineSelectedTreeSha256 === undefined ||
      candidateSelectedTreeSha256 === undefined
    ) {
      throw new ExternalHiddenFixFreshCopyInfrastructureErrorV1({
        failureCode: cleanupProven ? "runner_failed" : "cleanup_failed",
        cleanupProven,
        message: "M6 fresh-copy evaluator produced no complete observation",
      });
    }
    return ExternalHiddenFixFreshRunReceiptV1Schema.parse({
      schemaVersion: 1,
      assignmentId: input.assignmentId,
      freshCopyId: input.plan.freshCopyId,
      ordinal: input.plan.ordinal,
      scenarioClass: input.plan.scenarioClass,
      repetition: input.plan.repetition,
      baselineSelectedTreeSha256,
      candidateSelectedTreeSha256,
      patchSha256: input.patch.rawSha256,
      freshWorkspaceCreated: true,
      freshImportCacheCreated: true,
      freshProcessStarted: processResult.processStarted,
      outcome: processResult.outcome,
      observationSha256: Sha256DigestV1Schema.parse(
        processResult.observationSha256,
      ),
      cleanupProven,
    });
  }
}

/**
 * Narrow local entry point. The request supplies no baseline; the core claims
 * it once and resolves the frozen mutated tree and evaluator bytes by
 * assignmentId before invoking this fresh-copy runner nine times.
 */
export const runLocalExternalHiddenFixEvaluatorOnceV1 = (input: {
  readonly store: ExternalHiddenFixAssignmentStoreV1;
  readonly request: ExternalHiddenFixEvaluationRequestV1;
  readonly runner: LocalExternalHiddenFixFreshCopyRunnerV1;
  readonly signal?: AbortSignal | undefined;
}): Promise<ExternalHiddenFixFreshCopyAcceptanceReceiptV1> =>
  runExternalHiddenFixEvaluatorOnceV1({
    store: input.store,
    request: input.request,
    runner: input.runner,
    signal: input.signal,
  });
