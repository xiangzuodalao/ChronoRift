import { lstat, mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { asSha256DigestV1 } from "@chronorift/domain";
import { describe, expect, it } from "vitest";

import type { ExecutionCgroupScope } from "./cgroup-v2.js";
import { M1Error } from "./errors.js";
import type { SandboxBootstrapSession } from "./sandbox-bootstrap.js";
import {
  SANDBOX_TASK_STORAGE_MINIMUM_HEADROOM_BYTES_V1,
  SANDBOX_TASK_STORAGE_MINIMUM_HEADROOM_INODES_V1,
  assertSandboxTaskStorageHeadroomV1,
  assertSandboxTaskStorageBindingMatches,
  assertSandboxTaskStorageLayoutMatches,
  assertRequiredBubblewrapFeatures,
  assertTrustedHostExecutablePath,
  cleanupActiveProbe,
  createSandboxTaskRuntimeRoot,
  inspectSandboxTaskStorageRoot,
  preflightSandboxHost,
  type SandboxHostPathTrustPort,
  type SandboxHostProbeEvidence,
  type SandboxHostProbePort,
  type SandboxTaskStorageInspectionPort,
} from "./sandbox-preflight.js";

const digest = asSha256DigestV1("a".repeat(64));
const request = {
  delegatedCgroupRoot: "/sys/fs/cgroup/delegated",
  bwrapPath: "/usr/bin/bwrap",
  prlimitPath: "/usr/bin/prlimit",
  busyboxPath: "/usr/bin/busybox",
} as const;

const evidence: SandboxHostProbeEvidence = {
  binding: request,
  bwrapIdentity: digest,
  bwrapVersion: "bubblewrap 1.0",
  prlimitIdentity: digest,
  runtimeIdentity: digest,
  delegatedCgroupRootIdentity: digest,
  cgroupNamespaceUnshared: true,
  activeProbeSha256: digest,
};

const boundedStorageRoot = "/bounded-task-storage";
const TMPFS_MAGIC = 0x01021994n;
const FUSE_MAGIC = 0x65735546n;

const taskStoragePort = (
  overrides: {
    readonly currentUid?: number | undefined;
    readonly canonicalRoot?: string;
    readonly rootDevice?: bigint;
    readonly rootInode?: bigint;
    readonly rootUid?: number;
    readonly rootMode?: number;
    readonly parentDevice?: bigint;
    readonly filesystemName?: string;
    readonly filesystemType?: bigint;
    readonly blockSize?: bigint;
    readonly totalBlocks?: bigint;
    readonly freeBlocks?: bigint;
    readonly totalInodes?: bigint;
    readonly freeInodes?: bigint;
  } = {},
): SandboxTaskStorageInspectionPort => ({
  currentUid: () => ("currentUid" in overrides ? overrides.currentUid : 1_000),
  canonicalize: () =>
    Promise.resolve(overrides.canonicalRoot ?? boundedStorageRoot),
  inspectPath: (path) =>
    Promise.resolve(
      path === boundedStorageRoot
        ? {
            kind: "directory" as const,
            device: overrides.rootDevice ?? 2n,
            inode: overrides.rootInode ?? 10n,
            uid: overrides.rootUid ?? 1_000,
            mode: overrides.rootMode ?? 0o40700,
          }
        : {
            kind: "directory" as const,
            device: overrides.parentDevice ?? 1n,
            inode: 1n,
            uid: 0,
            mode: 0o40755,
          },
    ),
  inspectFileSystem: () =>
    Promise.resolve({
      name: overrides.filesystemName ?? "tmpfs",
      type: overrides.filesystemType ?? TMPFS_MAGIC,
      blockSize: overrides.blockSize ?? 4_096n,
      totalBlocks: overrides.totalBlocks ?? 1_024n,
      freeBlocks: overrides.freeBlocks ?? 512n,
      totalInodes: overrides.totalInodes ?? 1_024n,
      freeInodes: overrides.freeInodes ?? 1_000n,
    }),
});

const actualTaskStoragePort = async (
  root: string,
): Promise<SandboxTaskStorageInspectionPort> => {
  const rootStatistics = await lstat(root, { bigint: true });
  return {
    currentUid: () => process.geteuid?.(),
    canonicalize: (path) => realpath(path),
    inspectPath: async (path) => {
      const statistics = await lstat(path, { bigint: true });
      return {
        kind: statistics.isSymbolicLink()
          ? "symbolic-link"
          : statistics.isDirectory()
            ? "directory"
            : "other",
        device:
          path === dirname(root) ? rootStatistics.dev + 1n : statistics.dev,
        inode: statistics.ino,
        uid: Number(statistics.uid),
        mode: Number(statistics.mode),
      };
    },
    inspectFileSystem: () =>
      Promise.resolve({
        name: "tmpfs",
        type: TMPFS_MAGIC,
        blockSize: 4_096n,
        totalBlocks: 1_024n,
        freeBlocks: 512n,
        totalInodes: 1_024n,
        freeInodes: 1_000n,
      }),
  };
};

const fakeProbe = (
  result: SandboxHostProbeEvidence | Error,
): SandboxHostProbePort => ({
  now: () => "2026-08-07T00:00:00.000Z",
  probe: () =>
    result instanceof Error ? Promise.reject(result) : Promise.resolve(result),
});

const trustedPathPort = (
  overrides: {
    readonly uid?: number | undefined;
    readonly writable?: ReadonlySet<string>;
    readonly entries?: Readonly<
      Record<
        string,
        {
          readonly kind: "directory" | "file" | "other" | "symbolic-link";
          readonly mode: number;
          readonly uid: number;
        }
      >
    >;
  } = {},
): SandboxHostPathTrustPort => {
  const entries =
    overrides.entries ??
    ({
      "/": { kind: "directory", mode: 0o755, uid: 0 },
      "/usr": { kind: "directory", mode: 0o755, uid: 0 },
      "/usr/bin": { kind: "directory", mode: 0o755, uid: 0 },
      "/usr/bin/bwrap": { kind: "file", mode: 0o755, uid: 0 },
    } as const);
  return {
    currentUid: () => overrides.uid ?? 1000,
    canonicalize: (path) => Promise.resolve(path),
    inspect: (path) => {
      const entry = entries[path];
      return entry === undefined
        ? Promise.reject(new Error(`missing ${path}`))
        : Promise.resolve(entry);
    },
    canWrite: (path) => Promise.resolve(overrides.writable?.has(path) === true),
  };
};

describe("preflightSandboxHost", () => {
  it("freezes and requires bubblewrap remount-ro support", async () => {
    const result = await preflightSandboxHost(request, fakeProbe(evidence));
    expect(result).toMatchObject({
      kind: "supported",
      capability: {
        bwrap: {
          features: [
            "block-fd",
            "json-status-fd",
            "bind-fd",
            "ro-bind-fd",
            "remount-ro",
          ],
        },
      },
    });
    expect(() =>
      assertRequiredBubblewrapFeatures(
        "--block-fd --json-status-fd --bind-fd --ro-bind-fd",
      ),
    ).toThrow(/remount-ro/u);
    expect(() =>
      assertRequiredBubblewrapFeatures(
        "--block-fd --json-status-fd --bind-fd --ro-bind-fd --remount-ro",
      ),
    ).not.toThrow();
  });

  it("freezes a bounded real task-storage mount without persisting its Host path", async () => {
    const result = await preflightSandboxHost(
      { ...request, taskStorageRoot: boundedStorageRoot },
      fakeProbe(evidence),
      taskStoragePort(),
    );

    expect(result.kind).toBe("supported");
    if (result.kind !== "supported")
      throw new Error("expected supported result");
    expect(result.capability.taskStorage).toMatchObject({
      kind: "dedicated-capacity-bounded-filesystem-v1",
      filesystem: "tmpfs",
      totalBytes: 4_194_304,
      totalInodes: 1_024,
    });
    expect(result.capability.taskStorage?.rootIdentitySha256).toMatch(
      /^[a-f0-9]{64}$/u,
    );
    expect(result.binding.taskStorageRoot).toBe(boundedStorageRoot);
    expect(JSON.stringify(result.capability)).not.toContain(boundedStorageRoot);
  });

  it("rejects an ordinary directory, FUSE, and oversized block or inode capacity", async () => {
    for (const inspection of [
      taskStoragePort({ rootDevice: 1n, parentDevice: 1n }),
      taskStoragePort({ filesystemType: FUSE_MAGIC }),
      taskStoragePort({ totalBlocks: 262_145n }),
      taskStoragePort({ totalInodes: 131_073n }),
      taskStoragePort({ totalBlocks: 0n }),
      taskStoragePort({ totalInodes: 0n }),
    ]) {
      await expect(
        preflightSandboxHost(
          { ...request, taskStorageRoot: boundedStorageRoot },
          fakeProbe(evidence),
          inspection,
        ),
      ).resolves.toMatchObject({
        kind: "unsupported",
        receipt: {
          blockers: [{ code: "resource_limit_unavailable" }],
        },
      });
    }
  });

  it("rechecks byte and inode headroom at the execution boundary", async () => {
    const admittedPort = taskStoragePort({
      totalBlocks: 262_144n,
      freeBlocks: 131_072n,
      totalInodes: 131_072n,
      freeInodes: 32_768n,
    });
    const admitted = await inspectSandboxTaskStorageRoot(
      boundedStorageRoot,
      admittedPort,
    );

    await expect(
      assertSandboxTaskStorageHeadroomV1(
        admitted.capability,
        boundedStorageRoot,
        admittedPort,
      ),
    ).resolves.toEqual({
      schemaVersion: 1,
      availableBytes: 512 * 1024 * 1024,
      availableInodes: 32_768,
      requiredAvailableBytes: SANDBOX_TASK_STORAGE_MINIMUM_HEADROOM_BYTES_V1,
      requiredAvailableInodes: SANDBOX_TASK_STORAGE_MINIMUM_HEADROOM_INODES_V1,
    });

    for (const exhausted of [
      taskStoragePort({
        totalBlocks: 262_144n,
        freeBlocks: 65_535n,
        totalInodes: 131_072n,
        freeInodes: 32_768n,
      }),
      taskStoragePort({
        totalBlocks: 262_144n,
        freeBlocks: 131_072n,
        totalInodes: 131_072n,
        freeInodes: 16_383n,
      }),
    ]) {
      await expect(
        assertSandboxTaskStorageHeadroomV1(
          admitted.capability,
          boundedStorageRoot,
          exhausted,
        ),
      ).rejects.toMatchObject({ code: "resource_limit_unavailable" });
    }
  });

  it("rejects an unknown or root Host uid and a storage mount with non-private ownership", async () => {
    for (const inspection of [
      taskStoragePort({ currentUid: undefined }),
      taskStoragePort({ currentUid: 0 }),
      taskStoragePort({ rootUid: 2_000 }),
      taskStoragePort({ rootMode: 0o40750 }),
      taskStoragePort({ rootMode: 0o41777 }),
    ]) {
      await expect(
        preflightSandboxHost(
          { ...request, taskStorageRoot: boundedStorageRoot },
          fakeProbe(evidence),
          inspection,
        ),
      ).resolves.toMatchObject({
        kind: "unsupported",
        receipt: {
          blockers: [{ code: "resource_limit_unavailable" }],
        },
      });
    }
  });

  it("requires an exact allowlisted mountinfo filesystem that matches statfs magic", async () => {
    for (const inspection of [
      taskStoragePort({ filesystemName: "ext2", filesystemType: 0xef53n }),
      taskStoragePort({ filesystemName: "ext3", filesystemType: 0xef53n }),
      taskStoragePort({ filesystemName: "ext4", filesystemType: TMPFS_MAGIC }),
      taskStoragePort({ filesystemName: "tmpfs", filesystemType: 0xef53n }),
      taskStoragePort({ filesystemName: "fuse", filesystemType: FUSE_MAGIC }),
    ]) {
      await expect(
        preflightSandboxHost(
          { ...request, taskStorageRoot: boundedStorageRoot },
          fakeProbe(evidence),
          inspection,
        ),
      ).resolves.toMatchObject({ kind: "unsupported" });
    }

    for (const [filesystemName, filesystemType, expected] of [
      ["tmpfs", TMPFS_MAGIC, "tmpfs"],
      ["ext4", 0xef53n, "ext4"],
      ["xfs", 0x58465342n, "xfs"],
    ] as const) {
      const result = await preflightSandboxHost(
        { ...request, taskStorageRoot: boundedStorageRoot },
        fakeProbe(evidence),
        taskStoragePort({ filesystemName, filesystemType }),
      );
      expect(result).toMatchObject({
        kind: "supported",
        capability: { taskStorage: { filesystem: expected } },
      });
    }
  });

  it("rejects task-storage binding identity drift", async () => {
    const inspected = await inspectSandboxTaskStorageRoot(
      boundedStorageRoot,
      taskStoragePort(),
    );

    await expect(
      assertSandboxTaskStorageBindingMatches(
        inspected.capability,
        inspected.binding.taskStorageRoot,
        taskStoragePort({ rootInode: 11n }),
      ),
    ).rejects.toThrow(/no longer matches/iu);
  });

  it("rejects a nested layout mount that escapes the bounded filesystem", async () => {
    const inspected = await inspectSandboxTaskStorageRoot(
      boundedStorageRoot,
      taskStoragePort(),
    );
    const base = taskStoragePort();
    const escapedLayoutPort: SandboxTaskStorageInspectionPort = {
      ...base,
      canonicalize: (path) => Promise.resolve(path),
      inspectPath: (path) =>
        path.startsWith(`${boundedStorageRoot}/`)
          ? Promise.resolve({
              kind: "directory",
              device: 3n,
              inode: 20n,
              uid: 1_000,
              mode: 0o40700,
            })
          : base.inspectPath(path),
    };

    await expect(
      assertSandboxTaskStorageLayoutMatches(
        inspected.capability,
        boundedStorageRoot,
        [`${boundedStorageRoot}/runtime/tasks/task`],
        escapedLayoutPort,
      ),
    ).rejects.toThrow(/layout no longer matches/iu);
  });

  it("walks runtime-root components through pinned no-follow descriptors", async () => {
    const container = await mkdtemp(join(tmpdir(), "chronorift-runtime-root-"));
    try {
      const storage = join(container, "storage");
      const outside = join(container, "outside");
      await Promise.all([
        mkdir(storage, { mode: 0o700 }),
        mkdir(outside, { mode: 0o700 }),
      ]);
      await symlink(outside, join(storage, "link"));
      const inspection = await actualTaskStoragePort(storage);

      await expect(
        createSandboxTaskRuntimeRoot(
          storage,
          join(storage, "link", "new"),
          inspection,
        ),
      ).rejects.toThrow(/inside admitted task storage/iu);
      await expect(lstat(join(outside, "new"))).rejects.toMatchObject({
        code: "ENOENT",
      });

      const runtimeRoot = join(storage, "nested", "runtime");
      await expect(
        createSandboxTaskRuntimeRoot(storage, runtimeRoot, inspection),
      ).resolves.toBe(runtimeRoot);
      expect((await lstat(runtimeRoot)).isDirectory()).toBe(true);
    } finally {
      await rm(container, { recursive: true, force: true });
    }
  });

  it("fails closed when active-probe process or cgroup cleanup is unproven", async () => {
    const attempted: string[] = [];
    const session = {
      terminate: () => {
        attempted.push("terminate");
        return new Promise<void>(() => undefined);
      },
      waitForBootstrapExit: () => {
        attempted.push("waitForBootstrapExit");
        return Promise.reject(new Error("exit unproven"));
      },
    } as Pick<SandboxBootstrapSession, "terminate" | "waitForBootstrapExit">;
    const scope: ExecutionCgroupScope = {
      scopeIdentity: "test-scope",
      attach: () => Promise.resolve(),
      verifyAttached: () => Promise.resolve(),
      usage: () =>
        Promise.resolve({
          cpuUsageUsec: 0,
          memoryPeakBytes: 0,
          pidsPeak: 0,
        }),
      kill: () => {
        attempted.push("kill");
        return Promise.reject(new Error("kill failed"));
      },
      populated: () => {
        attempted.push("populated");
        return Promise.reject(new Error("population unproven"));
      },
      remove: () => {
        attempted.push("remove");
        return Promise.reject(new Error("remove failed"));
      },
    };
    const controller = {
      cleanup: () => {
        attempted.push("controller.cleanup");
        return Promise.reject(new Error("controller cleanup failed"));
      },
    };

    await expect(
      cleanupActiveProbe({
        session,
        scope,
        controller,
        bootstrapExitTimeoutMs: 10,
        cleanupOperationTimeoutMs: 10,
      }),
    ).rejects.toMatchObject({ code: "resource_limit_unavailable" });
    expect(attempted).toEqual([
      "terminate",
      "kill",
      "populated",
      "remove",
      "controller.cleanup",
      "waitForBootstrapExit",
    ]);
  });

  it("returns a content-addressed capability and keeps binding in memory only", async () => {
    const result = await preflightSandboxHost(request, fakeProbe(evidence));
    expect(result.kind).toBe("supported");
    if (result.kind !== "supported")
      throw new Error("expected supported result");
    expect(result.capability).toMatchObject({
      platform: "linux",
      architecture: "x64",
      controllers: ["cpu", "memory", "pids"],
      cgroupNamespaceUnshared: true,
    });
    expect(result.receipt.capabilitySha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(result.capability)).not.toContain("/sys/fs/cgroup");
    expect(result.binding).toEqual(request);
  });

  it("returns a structured unsupported receipt without a physical binding", async () => {
    const result = await preflightSandboxHost(
      request,
      fakeProbe(
        new M1Error(
          "resource_limit_unavailable",
          `delegation failed at ${request.delegatedCgroupRoot}`,
        ),
      ),
    );
    expect(result).toEqual({
      kind: "unsupported",
      receipt: {
        schemaVersion: 1,
        status: "unsupported",
        checkedAt: "2026-08-07T00:00:00.000Z",
        capabilitySha256: null,
        blockers: [
          {
            code: "resource_limit_unavailable",
            message: "delegation failed at [REDACTED]",
          },
        ],
      },
    });
  });

  it("classifies unknown probe failures as sandbox preflight failures", async () => {
    const result = await preflightSandboxHost(
      request,
      fakeProbe(new Error("unexpected")),
    );
    expect(result).toMatchObject({
      kind: "unsupported",
      receipt: {
        blockers: [{ code: "sandbox_preflight_failed", message: "unexpected" }],
      },
    });
  });

  it("normalizes a short printable version and rejects path or control injection", async () => {
    const normalized = await preflightSandboxHost(
      request,
      fakeProbe({ ...evidence, bwrapVersion: "  bubblewrap 1.0\n" }),
    );
    expect(normalized).toMatchObject({
      kind: "supported",
      capability: { bwrap: { version: "bubblewrap 1.0" } },
    });

    for (const bwrapVersion of [
      "bubblewrap /home/runner/private",
      "bubblewrap\t1.0",
      "x".repeat(129),
    ]) {
      await expect(
        preflightSandboxHost(request, fakeProbe({ ...evidence, bwrapVersion })),
      ).resolves.toMatchObject({
        kind: "unsupported",
        receipt: {
          blockers: [{ code: "sandbox_preflight_failed" }],
        },
      });
    }
  });
});

describe("trusted Host executable paths", () => {
  it("accepts only a root-owned, non-writable executable and ancestor chain", async () => {
    await expect(
      assertTrustedHostExecutablePath("/usr/bin/bwrap", trustedPathPort()),
    ).resolves.toBe("/usr/bin/bwrap");
  });

  it("rejects a root Host process before inspecting a candidate", async () => {
    await expect(
      assertTrustedHostExecutablePath(
        "/usr/bin/bwrap",
        trustedPathPort({ uid: 0 }),
      ),
    ).rejects.toThrow(/non-root/u);
  });

  it("rejects user ownership and mode or ACL-style write access", async () => {
    const userOwned = trustedPathPort({
      entries: {
        "/": { kind: "directory", mode: 0o755, uid: 0 },
        "/usr": { kind: "directory", mode: 0o755, uid: 0 },
        "/usr/bin": { kind: "directory", mode: 0o755, uid: 0 },
        "/usr/bin/bwrap": { kind: "file", mode: 0o755, uid: 1000 },
      },
    });
    await expect(
      assertTrustedHostExecutablePath("/usr/bin/bwrap", userOwned),
    ).rejects.toThrow(/root-owned/u);

    await expect(
      assertTrustedHostExecutablePath(
        "/usr/bin/bwrap",
        trustedPathPort({ writable: new Set(["/usr/bin"]) }),
      ),
    ).rejects.toThrow(/write access/u);

    const modeWritable = trustedPathPort({
      entries: {
        "/": { kind: "directory", mode: 0o755, uid: 0 },
        "/usr": { kind: "directory", mode: 0o755, uid: 0 },
        "/usr/bin": { kind: "directory", mode: 0o775, uid: 0 },
        "/usr/bin/bwrap": { kind: "file", mode: 0o755, uid: 0 },
      },
    });
    await expect(
      assertTrustedHostExecutablePath("/usr/bin/bwrap", modeWritable),
    ).rejects.toThrow(/group or world writable/u);
  });

  it("rejects a symbolic-link ancestor even if canonicalization lies", async () => {
    const symlinked = trustedPathPort({
      entries: {
        "/": { kind: "directory", mode: 0o755, uid: 0 },
        "/usr": { kind: "symbolic-link", mode: 0o777, uid: 0 },
        "/usr/bin": { kind: "directory", mode: 0o755, uid: 0 },
        "/usr/bin/bwrap": { kind: "file", mode: 0o755, uid: 0 },
      },
    });
    await expect(
      assertTrustedHostExecutablePath("/usr/bin/bwrap", symlinked),
    ).rejects.toThrow(/symbolic link/u);
  });
});
