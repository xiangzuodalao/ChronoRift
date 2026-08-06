import { asSha256DigestV1 } from "@chronorift/domain";
import { describe, expect, it } from "vitest";

import { M1Error } from "./errors.js";
import {
  assertTrustedHostExecutablePath,
  preflightSandboxHost,
  type SandboxHostPathTrustPort,
  type SandboxHostProbeEvidence,
  type SandboxHostProbePort,
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
