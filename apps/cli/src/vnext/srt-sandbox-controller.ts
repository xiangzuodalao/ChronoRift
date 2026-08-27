import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { isAbsolute, join, relative } from "node:path";
import { performance } from "node:perf_hooks";
import type { Readable, Writable } from "node:stream";

import {
  getDefaultWritePaths,
  SandboxManager,
  type SandboxRuntimeConfig,
  type WrapWithSandboxOptions,
} from "@anthropic-ai/sandbox-runtime";

const DEFAULT_PATH = "/usr/local/bin:/usr/bin:/bin";
const DEFAULT_OUTPUT_LIMIT_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;
const POSIX_ENV = "/usr/bin/env";
const POSIX_SHELL = "/bin/bash";
const DEFAULT_DENY_READ_PATHS = [
  "/home",
  "/root",
  "/run/user",
  "/tmp",
  "/var/tmp",
] as const;
// SRT always adds its compatibility write paths. Device files remain usable,
// but Host temp/log directories are carved back out so Task writes stay in the
// explicit per-command roots below.
const DEFAULT_DENY_WRITE_PATHS = getDefaultWritePaths().filter(
  (path) => !path.startsWith("/dev/"),
);

export interface SrtFacade {
  initialize(
    config: SandboxRuntimeConfig,
    askCallback?: undefined,
    enableLogMonitor?: boolean,
  ): Promise<void>;
  wrapWithSandboxArgv(
    command: string,
    binShell?: string,
    customConfig?: Partial<SandboxRuntimeConfig>,
    signal?: AbortSignal,
    cwd?: string,
    options?: WrapWithSandboxOptions,
  ): Promise<{ readonly argv: string[]; readonly env: NodeJS.ProcessEnv }>;
  cleanupAfterCommand(): void;
  reset(): Promise<void>;
}

export interface SrtSandboxControllerOptions {
  /** Host paths that no sandboxed command may read, such as credential roots. */
  readonly protectedReadPaths?: readonly string[] | undefined;
  readonly path?: string | undefined;
  readonly shellPath?: string | undefined;
  readonly envExecutable?: string | undefined;
  readonly outputLimitBytes?: number | undefined;
  readonly defaultTimeoutMs?: number | undefined;
  readonly facade?: SrtFacade | undefined;
}

interface SrtCommonRequest {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly homePath: string;
  readonly tempPath: string;
  readonly artifactsPath: string;
  /** Explicit Task/runtime variables only. Host process.env is never inherited. */
  readonly environment?: Readonly<Record<string, string>> | undefined;
  readonly timeoutMs?: number | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface SrtCodingRequest extends SrtCommonRequest {
  readonly workspacePath: string;
  readonly stdin?: string | Uint8Array | undefined;
  /** Live combined stdout/stderr updates for Pi's Bash tool UI. */
  readonly onOutput?: ((chunk: Uint8Array) => void) | undefined;
}

export interface SrtGodotRequest extends SrtCommonRequest {
  /** Immutable Host-prepared project copy used for this validation run. */
  readonly projectStagePath: string;
  /** Mutable candidate tree, hidden from the validation process. */
  readonly mutableWorkspacePath: string;
  /** Physical Host tool directories required by the managed Node/Godot path. */
  readonly readOnlyPaths?: readonly string[] | undefined;
}

export type SrtCommandStatus = "exited" | "timed_out" | "cancelled";

export interface SrtCommandResult {
  readonly status: SrtCommandStatus;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
}

export interface SrtDuplexHandle {
  readonly pid: number | undefined;
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  wait(): Promise<SrtCommandResult>;
  stop(): Promise<SrtCommandResult>;
}

interface InternalProcess extends SrtDuplexHandle {
  cancel(status: Extract<SrtCommandStatus, "timed_out" | "cancelled">): void;
}

class PrefixCapture {
  readonly #chunks: Buffer[] = [];
  #capturedBytes = 0;
  #totalBytes = 0;

  public constructor(readonly limitBytes: number) {}

  public add(value: Uint8Array): void {
    const chunk = Buffer.from(value);
    this.#totalBytes += chunk.byteLength;
    const remaining = this.limitBytes - this.#capturedBytes;
    if (remaining <= 0) return;
    const kept = chunk.subarray(0, remaining);
    this.#chunks.push(kept);
    this.#capturedBytes += kept.byteLength;
  }

  public text(): string {
    return Buffer.concat(this.#chunks, this.#capturedBytes).toString("utf8");
  }

  public truncated(): boolean {
    return this.#capturedBytes !== this.#totalBytes;
  }
}

const assertAbsolutePath = (value: string, label: string): void => {
  if (!isAbsolute(value) || value.includes("\0")) {
    throw new TypeError(`${label} must be an absolute path without NUL bytes`);
  }
};

const isWithin = (parent: string, candidate: string): boolean => {
  const pathFromParent = relative(parent, candidate);
  return (
    pathFromParent === "" ||
    (!isAbsolute(pathFromParent) &&
      pathFromParent !== ".." &&
      !pathFromParent.startsWith("../"))
  );
};

const pathsOverlap = (left: string, right: string): boolean =>
  isWithin(left, right) || isWithin(right, left);

const unique = (values: readonly string[]): string[] => [...new Set(values)];

export const quotePosixShellArg = (value: string): string =>
  `'${value.replaceAll("'", `'"'"'`)}'`;

const assertEnvironment = (
  environment: Readonly<Record<string, string>>,
): void => {
  for (const [name, value] of Object.entries(environment)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
      throw new TypeError(`invalid environment variable name: ${name}`);
    }
    if (value.includes("\0")) {
      throw new TypeError(`environment variable ${name} contains a NUL byte`);
    }
  }
};

export const buildEnvICommand = (
  envExecutable: string,
  environment: Readonly<Record<string, string>>,
  argv: readonly string[],
): string => {
  if (argv.length === 0) throw new TypeError("argv must not be empty");
  assertEnvironment(environment);
  const assignments = Object.entries(environment)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}=${value}`);
  return [envExecutable, "-i", "--", ...assignments, ...argv]
    .map(quotePosixShellArg)
    .join(" ");
};

const killProcessTree = (child: ChildProcessWithoutNullStreams): void => {
  if (child.pid !== undefined) {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        try {
          child.kill("SIGKILL");
        } catch {
          // The process may have exited between the group and direct kill.
        }
        return;
      }
    }
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // Already exited.
  }
};

export class SrtSandboxController {
  readonly #facade: SrtFacade;
  readonly #protectedReadPaths: readonly string[];
  readonly #path: string;
  readonly #shellPath: string;
  readonly #envExecutable: string;
  readonly #outputLimitBytes: number;
  readonly #defaultTimeoutMs: number;
  readonly #children = new Set<InternalProcess>();
  readonly #startWaiters = new Set<() => void>();
  #initialization: Promise<void> | undefined;
  #initialized = false;
  #closed = false;
  #closePromise: Promise<void> | undefined;
  #startsInFlight = 0;
  #commandSequence = 0;

  public constructor(options: SrtSandboxControllerOptions = {}) {
    if (process.platform !== "linux") {
      throw new Error("ChronoRift SRT sandbox currently supports Linux only");
    }
    this.#facade = options.facade ?? SandboxManager;
    this.#path = options.path ?? DEFAULT_PATH;
    this.#shellPath = options.shellPath ?? POSIX_SHELL;
    this.#envExecutable = options.envExecutable ?? POSIX_ENV;
    this.#outputLimitBytes =
      options.outputLimitBytes ?? DEFAULT_OUTPUT_LIMIT_BYTES;
    this.#defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#protectedReadPaths = unique(options.protectedReadPaths ?? []);

    assertAbsolutePath(this.#shellPath, "shellPath");
    assertAbsolutePath(this.#envExecutable, "envExecutable");
    for (const path of this.#protectedReadPaths) {
      assertAbsolutePath(path, "protectedReadPaths entry");
    }
    if (
      !Number.isInteger(this.#outputLimitBytes) ||
      this.#outputLimitBytes < 0
    ) {
      throw new RangeError("outputLimitBytes must be a nonnegative integer");
    }
    if (
      !Number.isInteger(this.#defaultTimeoutMs) ||
      this.#defaultTimeoutMs <= 0
    ) {
      throw new RangeError("defaultTimeoutMs must be a positive integer");
    }
  }

  public async runCoding(request: SrtCodingRequest): Promise<SrtCommandResult> {
    this.#beginStart();
    let child: InternalProcess;
    try {
      this.#validateCommonRequest(request);
      assertAbsolutePath(request.workspacePath, "workspacePath");
      if (!isWithin(request.workspacePath, request.cwd)) {
        throw new TypeError("coding cwd must be inside workspacePath");
      }
      this.#validateAllowedPaths(
        [
          request.workspacePath,
          request.homePath,
          request.tempPath,
          request.artifactsPath,
        ],
        "coding writable path",
      );
      child = await this.#start({
        request,
        onOutput: request.onOutput,
        filesystem: {
          denyRead: unique([
            ...DEFAULT_DENY_READ_PATHS,
            ...this.#protectedReadPaths,
          ]),
          allowRead: unique([
            request.workspacePath,
            request.homePath,
            request.tempPath,
            request.artifactsPath,
          ]),
          allowWrite: unique([
            request.workspacePath,
            request.homePath,
            request.tempPath,
            request.artifactsPath,
          ]),
          denyWrite: DEFAULT_DENY_WRITE_PATHS,
        },
      });
    } finally {
      this.#endStart();
    }

    child.stdin.on("error", () => {
      // EPIPE is represented by the process result, not an unhandled event.
    });
    child.stdin.end(request.stdin);
    return child.wait();
  }

  public async openGodot(request: SrtGodotRequest): Promise<SrtDuplexHandle> {
    this.#beginStart();
    try {
      this.#validateCommonRequest(request);
      assertAbsolutePath(request.projectStagePath, "projectStagePath");
      assertAbsolutePath(request.mutableWorkspacePath, "mutableWorkspacePath");
      for (const path of request.readOnlyPaths ?? []) {
        assertAbsolutePath(path, "readOnlyPaths entry");
      }
      if (!isWithin(request.projectStagePath, request.cwd)) {
        throw new TypeError("Godot cwd must be inside projectStagePath");
      }
      if (
        isWithin(request.mutableWorkspacePath, request.projectStagePath) ||
        isWithin(request.projectStagePath, request.mutableWorkspacePath)
      ) {
        throw new TypeError(
          "projectStagePath must be separate from mutableWorkspacePath",
        );
      }

      const writableRuntimePaths = [
        request.homePath,
        request.tempPath,
        request.artifactsPath,
      ];
      const allowedGodotPaths = [
        request.projectStagePath,
        ...writableRuntimePaths,
        ...(request.readOnlyPaths ?? []),
      ];
      this.#validateAllowedPaths(allowedGodotPaths, "Godot allowed path");
      for (const path of allowedGodotPaths) {
        if (pathsOverlap(path, request.mutableWorkspacePath)) {
          throw new TypeError(
            "Godot allowed paths must be separate from mutableWorkspacePath",
          );
        }
      }
      for (const path of writableRuntimePaths) {
        if (pathsOverlap(path, request.projectStagePath)) {
          throw new TypeError(
            "Godot runtime writable paths must be separate from projectStagePath",
          );
        }
      }

      return await this.#start({
        request,
        filesystem: {
          denyRead: unique([
            ...DEFAULT_DENY_READ_PATHS,
            ...this.#protectedReadPaths,
            request.mutableWorkspacePath,
          ]),
          allowRead: unique([
            request.projectStagePath,
            request.homePath,
            request.tempPath,
            request.artifactsPath,
            ...(request.readOnlyPaths ?? []),
          ]),
          allowWrite: unique([
            join(request.projectStagePath, ".godot"),
            request.homePath,
            request.tempPath,
            request.artifactsPath,
          ]),
          denyWrite: DEFAULT_DENY_WRITE_PATHS,
        },
      });
    } finally {
      this.#endStart();
    }
  }

  public close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closed = true;
    this.#closePromise = (async () => {
      await this.#waitForStarts();
      await Promise.allSettled(
        [...this.#children].map(async (child) => child.stop()),
      );
      if (this.#initialization !== undefined) {
        try {
          await this.#initialization;
        } catch {
          return;
        }
        await this.#facade.reset();
      }
    })();
    return this.#closePromise;
  }

  #beginStart(): void {
    if (this.#closed) throw new Error("SRT sandbox controller is closed");
    this.#startsInFlight += 1;
  }

  #endStart(): void {
    this.#startsInFlight -= 1;
    if (this.#startsInFlight === 0) {
      for (const resolve of this.#startWaiters) resolve();
      this.#startWaiters.clear();
    }
  }

  #waitForStarts(): Promise<void> {
    if (this.#startsInFlight === 0) return Promise.resolve();
    return new Promise((resolve) => this.#startWaiters.add(resolve));
  }

  #validateCommonRequest(request: SrtCommonRequest): void {
    if (request.argv.length === 0)
      throw new TypeError("argv must not be empty");
    for (const value of request.argv) {
      if (value.includes("\0")) throw new TypeError("argv contains a NUL byte");
    }
    assertAbsolutePath(request.cwd, "cwd");
    assertAbsolutePath(request.homePath, "homePath");
    assertAbsolutePath(request.tempPath, "tempPath");
    assertAbsolutePath(request.artifactsPath, "artifactsPath");
    if (
      request.timeoutMs !== undefined &&
      (!Number.isInteger(request.timeoutMs) || request.timeoutMs <= 0)
    ) {
      throw new RangeError("timeoutMs must be a positive integer");
    }
    assertEnvironment(request.environment ?? {});
  }

  #validateAllowedPaths(paths: readonly string[], label: string): void {
    for (const path of paths) {
      // A narrow path below /home is an intentional carve-out. An allow for
      // /home (or /) would instead reopen the whole deny root.
      if (DEFAULT_DENY_READ_PATHS.some((deny) => isWithin(path, deny))) {
        throw new TypeError(`${label} must not contain a default deny root`);
      }
      if (this.#protectedReadPaths.some((deny) => pathsOverlap(path, deny))) {
        throw new TypeError(`${label} must not overlap a protected read path`);
      }
      if (DEFAULT_DENY_WRITE_PATHS.some((deny) => pathsOverlap(path, deny))) {
        throw new TypeError(
          `${label} must not overlap an SRT compatibility deny-write path`,
        );
      }
    }
  }

  #environment(request: SrtCommonRequest): Readonly<Record<string, string>> {
    const required = {
      HOME: request.homePath,
      TMPDIR: request.tempPath,
      PATH: this.#path,
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      CI: "1",
      NO_COLOR: "1",
    } as const;
    const extra = request.environment ?? {};
    for (const [name, expected] of Object.entries(required)) {
      const actual = extra[name];
      if (actual !== undefined && actual !== expected) {
        throw new TypeError(`${name} is managed by SrtSandboxController`);
      }
    }
    return { ...extra, ...required };
  }

  #initialize(): Promise<void> {
    this.#initialization ??= this.#facade
      .initialize(
        {
          network: {
            allowedDomains: [],
            deniedDomains: [],
            strictAllowlist: true,
            allowLocalBinding: true,
            allowAllUnixSockets: false,
          },
          filesystem: {
            denyRead: unique([
              ...DEFAULT_DENY_READ_PATHS,
              ...this.#protectedReadPaths,
            ]),
            allowRead: [],
            allowWrite: [],
            denyWrite: DEFAULT_DENY_WRITE_PATHS,
          },
          enableWeakerNestedSandbox: false,
        },
        undefined,
        false,
      )
      .then(() => {
        this.#initialized = true;
      });
    return this.#initialization;
  }

  async #start(input: {
    readonly request: SrtCommonRequest;
    readonly filesystem: SandboxRuntimeConfig["filesystem"];
    readonly onOutput?: ((chunk: Uint8Array) => void) | undefined;
  }): Promise<InternalProcess> {
    await this.#initialize();
    if (!this.#initialized) throw new Error("SRT sandbox did not initialize");

    const environment = this.#environment(input.request);
    const command = buildEnvICommand(
      this.#envExecutable,
      environment,
      input.request.argv,
    );
    let wrapped = false;
    try {
      const descriptor = await this.#facade.wrapWithSandboxArgv(
        command,
        this.#shellPath,
        { filesystem: input.filesystem },
        input.request.signal,
        input.request.cwd,
        {
          commandId: `chronorift-${++this.#commandSequence}`,
          commandText: command,
        },
      );
      wrapped = true;
      if (this.#closed) throw new Error("SRT sandbox controller is closed");
      if (descriptor.argv.length === 0) {
        throw new Error("SRT returned an empty spawn argv");
      }
      const child = spawn(descriptor.argv[0]!, descriptor.argv.slice(1), {
        cwd: input.request.cwd,
        env: { ...environment },
        detached: true,
        shell: false,
        stdio: "pipe",
      });
      const managed = this.#manageProcess(
        child,
        input.request.timeoutMs ?? this.#defaultTimeoutMs,
        input.request.signal,
        input.onOutput,
      );
      wrapped = false;
      this.#children.add(managed);
      return managed;
    } finally {
      if (wrapped) this.#facade.cleanupAfterCommand();
    }
  }

  #manageProcess(
    child: ChildProcessWithoutNullStreams,
    timeoutMs: number,
    signal: AbortSignal | undefined,
    onOutput: ((chunk: Uint8Array) => void) | undefined,
  ): InternalProcess {
    const stdout = new PrefixCapture(this.#outputLimitBytes);
    const stderr = new PrefixCapture(this.#outputLimitBytes);
    const startedAt = performance.now();
    let requestedStatus: Extract<
      SrtCommandStatus,
      "timed_out" | "cancelled"
    > | null = null;

    const capture = (target: PrefixCapture, chunk: Buffer): void => {
      target.add(chunk);
      if (onOutput !== undefined) {
        try {
          onOutput(Uint8Array.from(chunk));
        } catch {
          // A display/update callback must not interrupt process draining.
        }
      }
    };
    child.stdout.on("data", (chunk: Buffer) => capture(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => capture(stderr, chunk));

    const cancel = (
      status: Extract<SrtCommandStatus, "timed_out" | "cancelled">,
    ): void => {
      if (requestedStatus !== null || child.exitCode !== null) return;
      requestedStatus = status;
      killProcessTree(child);
    };
    const onAbort = (): void => cancel("cancelled");
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted === true) onAbort();

    const timer = setTimeout(() => cancel("timed_out"), timeoutMs);
    timer.unref();

    const completion = new Promise<SrtCommandResult>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (exitCode, exitSignal) => {
        const status = requestedStatus ?? "exited";
        resolve({
          status,
          exitCode,
          signal: exitSignal,
          stdout: stdout.text(),
          stderr: stderr.text(),
          durationMs: Math.max(0, performance.now() - startedAt),
          timedOut: status === "timed_out",
          cancelled: status === "cancelled",
          stdoutTruncated: stdout.truncated(),
          stderrTruncated: stderr.truncated(),
        });
      });
    }).finally(() => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      this.#children.delete(managed);
      this.#facade.cleanupAfterCommand();
    });

    const managed: InternalProcess = {
      pid: child.pid,
      stdin: child.stdin,
      stdout: child.stdout,
      stderr: child.stderr,
      wait: () => completion,
      stop: () => {
        cancel("cancelled");
        return completion;
      },
      cancel,
    };
    return managed;
  }
}
