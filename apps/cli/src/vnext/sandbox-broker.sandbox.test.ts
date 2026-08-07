import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { asTaskId } from "@chronorift/domain";
import { describe, expect, it } from "vitest";

import { createBwrapCgroupTaskSandbox } from "./sandbox-broker.js";
import { preflightSandboxHost } from "./sandbox-preflight.js";
import { createSandboxPolicyV1 } from "./sandbox-policy.js";
import { createTaskDirectoryLayout } from "./task-paths.js";

describe("real Task-bound sandbox broker", () => {
  it("keeps Host paths isolated, drains bounded output, and clears timeout descendants", async () => {
    const delegatedCgroupRoot = process.env.CHRONORIFT_TEST_CGROUP_ROOT;
    if (delegatedCgroupRoot === undefined || delegatedCgroupRoot === "") {
      throw new Error(
        "CHRONORIFT_TEST_CGROUP_ROOT is required for sandbox conformance",
      );
    }
    const preflight = await preflightSandboxHost({
      delegatedCgroupRoot,
      bwrapPath: "/usr/bin/bwrap",
      prlimitPath: "/usr/bin/prlimit",
      busyboxPath: "/usr/bin/busybox",
    });
    if (preflight.kind !== "supported") {
      throw new Error(JSON.stringify(preflight.receipt.blockers));
    }

    const runtimeRoot = await mkdtemp(
      join(tmpdir(), "chronorift-broker-runtime-"),
    );
    const sourceRoot = await mkdtemp(
      join(tmpdir(), "chronorift-broker-source-"),
    );
    const hostSentinel = join(sourceRoot, "host-sentinel");
    await writeFile(hostSentinel, "host-only\n");
    const taskId = asTaskId(`sandbox-broker:${Date.now()}`);
    const layout = await createTaskDirectoryLayout({
      runtimeRoot,
      sourceRepositoryRoot: sourceRoot,
      taskId,
    });
    const broker = await createBwrapCgroupTaskSandbox({
      taskId,
      capability: preflight.capability,
      hostBinding: preflight.binding,
      policy: createSandboxPolicyV1(preflight.capability.runtimeIdentity),
      layout,
      securityEvents: async () => undefined,
    });

    try {
      const isolation = await broker.execute({
        schemaVersion: 1,
        operationId: "isolation",
        profile: "coding-default",
        argv: [
          "/bin/busybox",
          "sh",
          "-c",
          [
            "echo workspace >/workspace/value",
            "echo temporary >/tmp/value",
            "echo artifact >/artifacts/value",
            `test ! -e ${JSON.stringify(hostSentinel)}`,
            "test ! -e /sys",
            "test ! -e /home",
            "if echo forbidden >>/bin/busybox 2>/dev/null; then exit 9; fi",
          ].join("; "),
        ],
        cwd: "/workspace",
        environment: {},
      });
      expect(isolation).toMatchObject({
        kind: "executed",
        receipt: { status: "succeeded" },
      });
      await expect(
        readFile(join(layout.workspaceDirectory, "value"), "utf8"),
      ).resolves.toBe("workspace\n");
      await expect(
        readFile(join(layout.sandboxTemporaryDirectory, "value"), "utf8"),
      ).resolves.toBe("temporary\n");
      await expect(
        readFile(join(layout.sandboxArtifactScratchDirectory, "value"), "utf8"),
      ).resolves.toBe("artifact\n");

      const output = await broker.execute({
        schemaVersion: 1,
        operationId: "bounded-output",
        profile: "coding-default",
        argv: ["/bin/busybox", "head", "-c", "16777217", "/dev/zero"],
        cwd: "/workspace",
        environment: {},
      });
      expect(output).toMatchObject({
        kind: "executed",
        receipt: {
          status: "succeeded",
          stdout: {
            totalBytes: 16_777_217,
            capturedBytes: 16_777_216,
            truncated: true,
          },
        },
      });

      const timeout = await broker.execute({
        schemaVersion: 1,
        operationId: "timeout-descendant",
        profile: "coding-default",
        argv: [
          "/bin/busybox",
          "sh",
          "-c",
          'trap "" TERM; (trap "" TERM; sleep 600) & wait',
        ],
        cwd: "/workspace",
        environment: {},
        timeoutMs: 50,
      });
      expect(timeout).toMatchObject({
        kind: "executed",
        receipt: {
          status: "timed_out",
          cleanup: {
            cgroupPopulated: false,
            termSent: true,
            scopeRemoved: true,
          },
        },
      });
    } finally {
      await broker.cleanup();
      await rm(runtimeRoot, { recursive: true, force: true });
      await rm(sourceRoot, { recursive: true, force: true });
    }
  });
});
