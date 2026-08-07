import { execFile } from "node:child_process";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { asTaskId, taskNamespaceDigestV1 } from "@chronorift/domain";
import { VNextTaskStore } from "@chronorift/json-artifacts";
import { createVNextCodingToolDefinitions } from "@chronorift/pi-harness";
import { describe, expect, it } from "vitest";

import { SandboxOperationRecordV1Schema } from "./contracts.js";
import {
  discardM1Task,
  executeAndRecordM1Command,
  exportM1Patch,
  extractAndPersistM1Patch,
  prepareM1TaskEnvironment,
  type M1TaskEnvironment,
} from "./m1-task-environment.js";
import { SandboxPiCodingToolPort } from "./pi-coding-tool-port.js";

const execFileAsync = promisify(execFile);

const git = async (cwd: string, args: readonly string[]): Promise<string> => {
  const result = await execFileAsync("/usr/bin/git", args, {
    cwd,
    env: {
      PATH: "/usr/bin:/bin",
      LANG: "C",
      LC_ALL: "C",
      HOME: cwd,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "ChronoRift Sandbox Test",
      GIT_AUTHOR_EMAIL: "sandbox@chronorift.invalid",
      GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
      GIT_COMMITTER_NAME: "ChronoRift Sandbox Test",
      GIT_COMMITTER_EMAIL: "sandbox@chronorift.invalid",
      GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
    },
    encoding: "utf8",
  });
  return result.stdout;
};

describe("real internal M1 walking skeleton", () => {
  it("isolates a clean Fixture, executes, exports a verified patch, and discards", async () => {
    const delegatedCgroupRoot = process.env.CHRONORIFT_TEST_CGROUP_ROOT;
    if (delegatedCgroupRoot === undefined || delegatedCgroupRoot === "") {
      throw new Error(
        "CHRONORIFT_TEST_CGROUP_ROOT is required for sandbox conformance",
      );
    }

    const root = await mkdtemp(join(tmpdir(), "chronorift-m1-sandbox-"));
    const project = join(root, "source");
    const runtimeRoot = join(root, "runtime");
    const exportRoot = join(root, "exports");
    const trustedFixtureRoot = join(
      process.cwd(),
      "fixtures/godot-frame-input-window",
    );
    await mkdir(project);
    await mkdir(runtimeRoot);
    await mkdir(exportRoot);
    await cp(trustedFixtureRoot, project, { recursive: true });
    await git(project, ["init", "--quiet", "--initial-branch=main"]);
    await git(project, ["add", "--all"]);
    await git(project, ["commit", "--quiet", "-m", "fixture"]);

    const original = {
      head: await git(project, ["rev-parse", "HEAD"]),
      refs: await git(project, ["show-ref"]),
      status: await git(project, ["status", "--porcelain"]),
      projectBytes: await readFile(join(project, "project.godot")),
    };
    const taskId = asTaskId(`m1-sandbox:${Date.now()}`);
    const taskRoot = join(runtimeRoot, "tasks", taskNamespaceDigestV1(taskId));
    let environment: M1TaskEnvironment | undefined;
    let discarded = false;
    try {
      environment = await prepareM1TaskEnvironment({
        taskId,
        projectPath: project,
        trustedFixtureRoot,
        runtimeRoot,
        sandboxHost: {
          delegatedCgroupRoot,
          bwrapPath: "/usr/bin/bwrap",
          prlimitPath: "/usr/bin/prlimit",
          busyboxPath: "/usr/bin/busybox",
        },
        sandboxToolchain: {
          lddPath: "/usr/bin/ldd",
          commands: [
            { target: "/bin/bash", hostPath: "/usr/bin/bash" },
            { target: "/usr/bin/find", hostPath: "/usr/bin/find" },
            { target: "/usr/bin/ls", hostPath: "/usr/bin/ls" },
            { target: "/usr/bin/rg", hostPath: "/usr/bin/rg" },
          ],
        },
      });
      const tools = createVNextCodingToolDefinitions(
        new SandboxPiCodingToolPort({
          execute: (request, options) =>
            executeAndRecordM1Command(environment!, request, options),
          cleanup: () => discardM1Task(environment!),
        }),
      );
      const call = async (
        name: string,
        parameters: Record<string, unknown>,
      ) => {
        const tool = tools.find((candidate) => candidate.name === name);
        if (tool === undefined) throw new Error(`missing Pi tool ${name}`);
        return tool.execute(
          "sandbox-conformance",
          parameters,
          undefined,
          undefined,
          {} as never,
        );
      };
      await call("write", {
        path: "agent-note.txt",
        content: "before\nneedle\n",
      });
      await call("edit", {
        path: "agent-note.txt",
        edits: [{ oldText: "before", newText: "after" }],
      });
      await expect(
        call("read", { path: "agent-note.txt" }),
      ).resolves.toMatchObject({
        content: [{ type: "text", text: "after\nneedle\n" }],
      });
      await call("bash", {
        command: "/usr/bin/rg --fixed-strings needle agent-note.txt",
      });
      await call("grep", { pattern: "needle", path: "." });
      await call("find", { pattern: "*.txt", path: "." });
      await call("ls", { path: "." });
      const execution = await executeAndRecordM1Command(environment, {
        schemaVersion: 1,
        operationId: "write-candidate",
        profile: "coding-default",
        argv: [
          "/bin/busybox",
          "sh",
          "-c",
          "printf '\\n# M1 candidate\\n' >>project.godot && printf artifact >/artifacts/probe.txt",
        ],
        cwd: "/workspace",
        environment: {},
      });
      expect(execution).toMatchObject({
        kind: "executed",
        receipt: {
          status: "succeeded",
          cleanup: {
            cgroupPopulated: false,
            scopeRemoved: true,
          },
        },
      });
      await expect(
        readFile(join(taskRoot, "sandbox-artifacts", "probe.txt"), "utf8"),
      ).resolves.toBe("artifact");

      const extracted = await extractAndPersistM1Patch(environment);
      const exportReceipt = await exportM1Patch(environment, extracted, {
        hostCwd: exportRoot,
        outputPath: "candidate.patch",
      });
      expect(
        await readFile(join(exportRoot, exportReceipt.outputPath)),
      ).toEqual(Buffer.from(extracted.patchBytes));

      const store = new VNextTaskStore(runtimeRoot);
      const operationRecords = await store.readLedger(
        taskId,
        "sandbox-operations.jsonl",
        (value) => SandboxOperationRecordV1Schema.parse(value),
      );
      expect(operationRecords).toHaveLength(9);
      const recordNames = await readdir(join(taskRoot, "records"));
      for (const recordName of recordNames) {
        const path = join(taskRoot, "records", recordName);
        const bytes = await readFile(path);
        expect(bytes.includes(Buffer.from(root))).toBe(false);
      }

      expect(await git(project, ["rev-parse", "HEAD"])).toBe(original.head);
      expect(await git(project, ["show-ref"])).toBe(original.refs);
      expect(await git(project, ["status", "--porcelain"])).toBe(
        original.status,
      );
      expect(await readFile(join(project, "project.godot"))).toEqual(
        original.projectBytes,
      );

      const cleanup = await discardM1Task(environment);
      discarded = true;
      expect(cleanup).toMatchObject({
        processGroupTerminated: true,
        cgroupPopulated: false,
        scopeRemoved: true,
      });
      await expect(access(taskRoot)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        access(join(exportRoot, "candidate.patch")),
      ).resolves.toBeUndefined();
    } finally {
      if (environment !== undefined && !discarded) {
        await discardM1Task(environment).catch(() => undefined);
      }
      await rm(root, { recursive: true, force: true });
    }
  });
});
