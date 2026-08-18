import { createHash } from "node:crypto";
import {
  access,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rmdir,
  statfs,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import type { TaskId } from "@chronorift/domain";

import type { ObservedResourceUsageV1 } from "./contracts.js";
import { M1Error } from "./errors.js";

const REQUIRED_CONTROLLERS = ["cpu", "memory", "pids"] as const;
const CGROUP2_SUPER_MAGIC = 0x63677270;

export interface CgroupRootIdentity {
  readonly canonicalPath: string;
  readonly device: bigint;
  readonly inode: bigint;
}

export interface CgroupFsPort {
  rootIdentity(path: string): Promise<CgroupRootIdentity>;
  readText(path: string): Promise<string>;
  writeText(path: string, value: string): Promise<void>;
  createDirectory(path: string): Promise<void>;
  removeDirectory(path: string): Promise<void>;
  pathExists(path: string): Promise<boolean>;
  childDirectories(path: string): Promise<readonly string[]>;
}

export interface CgroupEnforcementLimitsV1 {
  readonly cpuMax: string;
  readonly memoryMaxBytes: number;
  readonly memorySwapMaxBytes: number;
  readonly pidsMax: number;
}

export type CgroupUsageV1 = ObservedResourceUsageV1;

export interface ExecutionCgroupScope {
  readonly scopeIdentity: string;
  attach(pid: number): Promise<void>;
  verifyAttached(reportedCgroupPath: string): Promise<void>;
  usage(): Promise<CgroupUsageV1>;
  kill(): Promise<boolean>;
  populated(): Promise<boolean>;
  remove(): Promise<void>;
}

export async function waitForCgroupEmpty(
  scope: ExecutionCgroupScope,
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (await scope.populated()) {
    if (performance.now() >= deadline) {
      throw resourceError(
        "execution cgroup remained populated after termination",
      );
    }
    await delay(10);
  }
}

const resourceError = (message: string, cause?: unknown): M1Error =>
  new M1Error("resource_limit_unavailable", message, cause);

/** A cgroup directory was acquired but its rollback is not yet proven. */
export class CgroupSetupCleanupErrorV1 extends AggregateError {
  public readonly cleanupProven = false;

  public constructor(
    public readonly primaryError: unknown,
    cleanupError: unknown,
    private readonly retry: () => Promise<void>,
  ) {
    super(
      [primaryError, cleanupError],
      "cgroup setup failed without proven resource cleanup",
    );
    this.name = "CgroupSetupCleanupErrorV1";
  }

  public retryCleanup(): Promise<void> {
    return this.retry();
  }
}

const rethrowAfterCgroupSetupCleanup = async (
  primaryError: unknown,
  cleanup: () => Promise<void>,
): Promise<never> => {
  let lastCleanupError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await cleanup();
    } catch (error) {
      lastCleanupError = error;
      continue;
    }
    throw primaryError;
  }
  throw new CgroupSetupCleanupErrorV1(primaryError, lastCleanupError, cleanup);
};

const parseWords = (value: string): ReadonlySet<string> =>
  new Set(
    value
      .trim()
      .split(/\s+/u)
      .filter((word) => word.length > 0)
      .map((word) => word.replace(/^\+/u, "")),
  );

const requireControllers = (value: string, name: string): void => {
  const available = parseWords(value);
  const missing = REQUIRED_CONTROLLERS.filter(
    (controller) => !available.has(controller),
  );
  if (missing.length > 0) {
    throw resourceError(
      `${name} lacks required controllers: ${missing.join(", ")}`,
    );
  }
};

const opaqueSegment = (kind: "task" | "execution", value: string): string =>
  `${kind}-${createHash("sha256")
    .update(`chronorift-cgroup-${kind}-v1\0`)
    .update(value)
    .digest("hex")}`;

const parseNonnegativeInteger = (value: string, field: string): number => {
  if (!/^\d+$/u.test(value.trim())) {
    throw resourceError(`${field} is not a nonnegative integer`);
  }
  const parsed = Number(value.trim());
  if (!Number.isSafeInteger(parsed)) {
    throw resourceError(`${field} exceeds the supported integer range`);
  }
  return parsed;
};

const parseOptionalPeak = (value: string, field: string): number | null =>
  value.trim() === "max" ? null : parseNonnegativeInteger(value, field);

const populatedFromEvents = (events: string): boolean => {
  const match = /^populated\s+([01])$/mu.exec(events);
  if (match?.[1] === undefined) {
    throw resourceError(
      "cgroup.events does not contain a valid populated field",
    );
  }
  return match[1] === "1";
};

export class NodeCgroupFs implements CgroupFsPort {
  public async rootIdentity(path: string): Promise<CgroupRootIdentity> {
    const normalized = resolve(path);
    if (!isAbsolute(path) || normalized !== path) {
      throw resourceError(
        "delegated cgroup root must be an absolute normalized path",
      );
    }
    const canonicalPath = await realpath(path);
    if (canonicalPath !== path) {
      throw resourceError(
        "delegated cgroup root must not contain symbolic links",
      );
    }
    const belowMount = relative("/sys/fs/cgroup", canonicalPath);
    if (
      belowMount === "" ||
      belowMount === ".." ||
      belowMount.startsWith("../") ||
      isAbsolute(belowMount)
    ) {
      throw resourceError("delegated cgroup root must be below /sys/fs/cgroup");
    }
    const filesystem = await statfs(canonicalPath);
    if (Number(filesystem.type) !== CGROUP2_SUPER_MAGIC) {
      throw resourceError(
        "delegated cgroup root is not on a cgroup v2 filesystem",
      );
    }
    const stats = await lstat(canonicalPath, { bigint: true });
    if (!stats.isDirectory()) {
      throw resourceError("delegated cgroup root is not a directory");
    }
    return {
      canonicalPath,
      device: stats.dev,
      inode: stats.ino,
    };
  }

  public readText(path: string): Promise<string> {
    return readFile(path, "utf8");
  }

  public writeText(path: string, value: string): Promise<void> {
    return writeFile(path, value, "utf8");
  }

  public async createDirectory(path: string): Promise<void> {
    await mkdir(path, { mode: 0o700 });
  }

  public async removeDirectory(path: string): Promise<void> {
    await rmdir(path);
  }

  public async pathExists(path: string): Promise<boolean> {
    try {
      await access(path);
      return true;
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        return false;
      }
      throw error;
    }
  }

  public async childDirectories(path: string): Promise<readonly string[]> {
    const entries = await readdir(path, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  }
}

class DirectExecutionCgroupScope implements ExecutionCgroupScope {
  #removed = false;

  public constructor(
    readonly scopeIdentity: string,
    private readonly directory: string,
    private readonly fs: CgroupFsPort,
    private readonly onRemove: () => void,
  ) {}

  public async attach(pid: number): Promise<void> {
    this.assertActive();
    if (!Number.isInteger(pid) || pid <= 0) {
      throw resourceError("cgroup attach pid must be a positive integer");
    }
    await this.fs.writeText(join(this.directory, "cgroup.procs"), `${pid}\n`);
  }

  public async verifyAttached(reportedCgroupPath: string): Promise<void> {
    this.assertActive();
    const segments = reportedCgroupPath.split("/").filter(Boolean);
    const expectedSuffix = [
      basename(dirname(this.directory)),
      basename(this.directory),
    ];
    if (
      !reportedCgroupPath.startsWith("/") ||
      segments.some((segment) => segment === "." || segment === "..") ||
      segments.slice(-2).join("/") !== expectedSuffix.join("/") ||
      !(await this.populated())
    ) {
      throw resourceError(
        "bootstrap process did not report the expected execution cgroup",
      );
    }
  }

  public async usage(): Promise<CgroupUsageV1> {
    this.assertActive();
    const cpuStat = await this.fs.readText(join(this.directory, "cpu.stat"));
    const usageMatch = /^usage_usec\s+(\d+)$/mu.exec(cpuStat);
    if (usageMatch?.[1] === undefined) {
      throw resourceError("cpu.stat does not contain usage_usec");
    }
    const [memoryPeak, pidsPeak] = await Promise.all([
      this.fs.readText(join(this.directory, "memory.peak")),
      this.fs.readText(join(this.directory, "pids.peak")),
    ]);
    return {
      cpuUsageUsec: parseNonnegativeInteger(usageMatch[1], "cpu usage"),
      memoryPeakBytes: parseOptionalPeak(memoryPeak, "memory peak"),
      pidsPeak: parseOptionalPeak(pidsPeak, "pids peak"),
    };
  }

  public async kill(): Promise<boolean> {
    this.assertActive();
    if (!(await this.populated())) return false;
    const killPath = join(this.directory, "cgroup.kill");
    if (!(await this.fs.pathExists(killPath))) {
      throw resourceError("atomic cgroup.kill is unavailable");
    }
    await this.fs.writeText(killPath, "1\n");
    return true;
  }

  public async populated(): Promise<boolean> {
    this.assertActive();
    return populatedFromEvents(
      await this.fs.readText(join(this.directory, "cgroup.events")),
    );
  }

  public async remove(): Promise<void> {
    this.assertActive();
    if (await this.populated()) {
      throw resourceError("cannot remove a populated execution cgroup");
    }
    await this.fs.removeDirectory(this.directory);
    this.#removed = true;
    this.onRemove();
  }

  private assertActive(): void {
    if (this.#removed) throw resourceError("execution cgroup has been removed");
  }
}

export class CgroupV2Controller {
  readonly #scopes = new Map<string, DirectExecutionCgroupScope>();
  #cleaned = false;

  private constructor(
    private readonly taskDirectory: string,
    private readonly fs: CgroupFsPort,
  ) {}

  public static async preflight(
    root: string,
    fs: CgroupFsPort = new NodeCgroupFs(),
  ): Promise<CgroupRootIdentity> {
    try {
      const identity = await fs.rootIdentity(root);
      const [type, processes, controllers, subtreeControl, childDirectories] =
        await Promise.all([
          fs.readText(join(identity.canonicalPath, "cgroup.type")),
          fs.readText(join(identity.canonicalPath, "cgroup.procs")),
          fs.readText(join(identity.canonicalPath, "cgroup.controllers")),
          fs.readText(join(identity.canonicalPath, "cgroup.subtree_control")),
          fs.childDirectories(identity.canonicalPath),
        ]);
      if (type.trim() !== "domain") {
        throw resourceError("delegated cgroup root must be a domain cgroup");
      }
      if (processes.trim() !== "") {
        throw resourceError("delegated cgroup root must contain no processes");
      }
      if (childDirectories.length !== 0) {
        throw resourceError(
          "delegated cgroup root must contain no child cgroups",
        );
      }
      requireControllers(controllers, "cgroup.controllers");
      requireControllers(subtreeControl, "cgroup.subtree_control");
      return identity;
    } catch (error) {
      if (error instanceof M1Error) throw error;
      throw resourceError("delegated cgroup v2 preflight failed", error);
    }
  }

  public static async create(
    root: string,
    taskId: TaskId,
    fs: CgroupFsPort = new NodeCgroupFs(),
  ): Promise<CgroupV2Controller> {
    const identity = await CgroupV2Controller.preflight(root, fs);
    const taskDirectory = join(
      identity.canonicalPath,
      opaqueSegment("task", taskId),
    );
    try {
      await fs.createDirectory(taskDirectory);
      await fs.writeText(
        join(taskDirectory, "cgroup.subtree_control"),
        "+cpu +memory +pids\n",
      );
      requireControllers(
        await fs.readText(join(taskDirectory, "cgroup.subtree_control")),
        "task cgroup.subtree_control",
      );
      return new CgroupV2Controller(taskDirectory, fs);
    } catch (error) {
      const primaryError =
        error instanceof M1Error
          ? error
          : resourceError("failed to create the task cgroup", error);
      return rethrowAfterCgroupSetupCleanup(primaryError, async () => {
        if (await fs.pathExists(taskDirectory)) {
          await fs.removeDirectory(taskDirectory);
        }
      });
    }
  }

  public async createExecutionScope(
    operationId: string,
    limits: CgroupEnforcementLimitsV1,
  ): Promise<ExecutionCgroupScope> {
    if (this.#cleaned) throw resourceError("task cgroup is already cleaned");
    if (operationId.length === 0) {
      throw resourceError("operationId must not be empty");
    }
    const segment = opaqueSegment("execution", operationId);
    if (this.#scopes.has(segment)) {
      throw resourceError("execution cgroup already exists");
    }
    const directory = join(this.taskDirectory, segment);
    try {
      await this.fs.createDirectory(directory);
      const entries = [
        ["cpu.max", `${limits.cpuMax}\n`],
        ["memory.max", `${limits.memoryMaxBytes}\n`],
        ["memory.swap.max", `${limits.memorySwapMaxBytes}\n`],
        ["pids.max", `${limits.pidsMax}\n`],
      ] as const;
      for (const [name, value] of entries) {
        await this.fs.writeText(join(directory, name), value);
      }
      for (const [name, value] of entries) {
        const realized = await this.fs.readText(join(directory, name));
        if (realized.trim() !== value.trim()) {
          throw resourceError(
            `${name} readback does not match the requested limit`,
          );
        }
      }
      if (!(await this.fs.pathExists(join(directory, "cgroup.kill")))) {
        throw resourceError("atomic cgroup.kill is unavailable");
      }
      const scope = new DirectExecutionCgroupScope(
        segment,
        directory,
        this.fs,
        () => this.#scopes.delete(segment),
      );
      this.#scopes.set(segment, scope);
      return scope;
    } catch (error) {
      const primaryError =
        error instanceof M1Error
          ? error
          : resourceError("failed to create the execution cgroup", error);
      return rethrowAfterCgroupSetupCleanup(primaryError, async () => {
        if (await this.fs.pathExists(directory)) {
          await this.fs.removeDirectory(directory);
        }
      });
    }
  }

  public async cleanup(): Promise<void> {
    if (this.#cleaned) return;
    for (const scope of [...this.#scopes.values()]) {
      await scope.kill();
      await waitForCgroupEmpty(scope);
      await scope.remove();
    }
    await this.fs.removeDirectory(this.taskDirectory);
    this.#cleaned = true;
  }
}
