import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { asTaskId } from "@chronorift/domain";
import { describe, expect, it } from "vitest";

import { createBwrapCgroupTaskSandbox } from "./sandbox-broker.js";
import { createSandboxPolicyV1 } from "./sandbox-policy.js";
import { preflightSandboxHost } from "./sandbox-preflight.js";
import { inspectSandboxToolchain } from "./sandbox-toolchain.js";
import { createTaskDirectoryLayout } from "./task-paths.js";

describe("M6 hidden assignment sandbox sentinel", () => {
  it("keeps the mutation and evaluator outside bash, find, and rg", async () => {
    const delegatedCgroupRoot = process.env.CHRONORIFT_TEST_CGROUP_ROOT;
    if (delegatedCgroupRoot === undefined || delegatedCgroupRoot === "") {
      throw new Error(
        "CHRONORIFT_TEST_CGROUP_ROOT is required for M6 sandbox conformance",
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
    const toolchain = await inspectSandboxToolchain({
      lddPath: "/usr/bin/ldd",
      commands: [
        { target: "/bin/bash", hostPath: "/usr/bin/bash" },
        { target: "/usr/bin/find", hostPath: "/usr/bin/find" },
        { target: "/usr/bin/rg", hostPath: "/usr/bin/rg" },
      ],
    });

    const runtimeRoot = await mkdtemp(join(tmpdir(), "chronorift-m6-runtime-"));
    const sourceRoot = await mkdtemp(join(tmpdir(), "chronorift-m6-source-"));
    const hiddenRoot = await mkdtemp(join(tmpdir(), "chronorift-m6-hidden-"));
    await Promise.all([
      mkdir(join(sourceRoot, "visible"), { mode: 0o700 }),
      writeFile(join(hiddenRoot, "m6-hidden-sentinel"), "hidden\n", {
        mode: 0o600,
      }),
    ]);
    const hiddenSentinel = join(hiddenRoot, "m6-hidden-sentinel");
    const taskId = asTaskId(`m6-sandbox:${Date.now()}`);
    const layout = await createTaskDirectoryLayout({
      runtimeRoot,
      sourceRepositoryRoot: sourceRoot,
      taskId,
    });
    const broker = await createBwrapCgroupTaskSandbox({
      taskId,
      capability: preflight.capability,
      hostBinding: preflight.binding,
      policy: createSandboxPolicyV1(preflight.capability.runtimeIdentity, {
        toolchainId: toolchain.capability.toolchainId,
        targets: toolchain.capability.files.map((file) => file.target),
      }),
      toolchain,
      layout,
      securityEvents: async () => undefined,
    });

    try {
      const bash = await broker.execute({
        schemaVersion: 1,
        operationId: "m6-hidden-bash",
        profile: "coding-default",
        argv: [
          "/bin/bash",
          "-c",
          `test ! -e ${JSON.stringify(hiddenSentinel)}`,
        ],
        cwd: "/workspace",
        environment: {},
      });
      expect(bash).toMatchObject({
        kind: "executed",
        receipt: { status: "succeeded" },
      });

      const find = await broker.execute({
        schemaVersion: 1,
        operationId: "m6-hidden-find",
        profile: "coding-default",
        argv: [
          "/usr/bin/find",
          "/",
          "-xdev",
          "-name",
          "m6-hidden-sentinel",
          "-print",
        ],
        cwd: "/workspace",
        environment: {},
      });
      expect(find).toMatchObject({
        kind: "executed",
        receipt: { status: "succeeded", stdout: { totalBytes: 0 } },
      });

      const rg = await broker.execute({
        schemaVersion: 1,
        operationId: "m6-hidden-rg",
        profile: "coding-default",
        argv: ["/usr/bin/rg", "--fixed-strings", "hidden", hiddenSentinel],
        cwd: "/workspace",
        environment: {},
      });
      expect(rg).toMatchObject({
        kind: "executed",
        receipt: { status: "failed", stdout: { totalBytes: 0 } },
      });
    } finally {
      const cleanup = await broker.cleanup();
      expect(cleanup).toMatchObject({
        processGroupTerminated: true,
        cgroupPopulated: false,
        scopeRemoved: true,
      });
      await Promise.all([
        rm(runtimeRoot, { recursive: true, force: true }),
        rm(sourceRoot, { recursive: true, force: true }),
        rm(hiddenRoot, { recursive: true, force: true }),
      ]);
    }
  });
});
