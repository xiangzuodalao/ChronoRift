import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type {
  RunVNextPiSdkTurnOptions,
  VNextPiTurnResult,
} from "@chronorift/pi-harness";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as PatchHandoffModule from "./patch-handoff.js";
import type * as RuntimeConfigModule from "./srt-runtime-config.js";

const mocks = vi.hoisted(() => ({
  runtimeConfig: vi.fn(),
  extractPatch: vi.fn(),
}));
vi.mock("./srt-runtime-config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeConfigModule>()),
  resolveSrtRuntimeConfig: mocks.runtimeConfig,
}));
vi.mock("./patch-handoff.js", async (importOriginal) => {
  const actual = await importOriginal<typeof PatchHandoffModule>();
  mocks.extractPatch.mockImplementation(actual.extractTaskPatch);
  return { ...actual, extractTaskPatch: mocks.extractPatch };
});

import { GodotInspectionRuntime } from "./godot-inspection-runtime.js";
import { createProjectMultiAgentEnvironment } from "./project-multi-agent.js";
import { runProjectEnvironmentPreviewV2 } from "./project-environment-preview.js";
import { SrtSandboxController } from "./srt-sandbox-controller.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const cleanups: (() => Promise<unknown>)[] = [];
beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "chronorift-preview-cleanup-"));
  roots.push(root);
  const source = join(root, "source");
  await mkdir(source);
  await mkdir(join(root, "state"));
  await writeFile(
    join(source, "project.godot"),
    '[application]\nrun/main_scene="res://main.tscn"\n',
  );
  await writeFile(
    join(source, "main.tscn"),
    '[gd_scene format=3]\n[node name="Main" type="Node"]\n',
  );
  await writeFile(join(source, "note.txt"), "original source\n");
  const git = (args: string[]) =>
    execFileAsync("/usr/bin/git", args, {
      cwd: source,
      env: {
        PATH: "/usr/bin:/bin",
        HOME: root,
        LANG: "C",
        LC_ALL: "C",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_AUTHOR_NAME: "Cleanup fixture",
        GIT_AUTHOR_EMAIL: "cleanup@chronorift.invalid",
        GIT_COMMITTER_NAME: "Cleanup fixture",
        GIT_COMMITTER_EMAIL: "cleanup@chronorift.invalid",
      },
    });
  await git(["init", "--quiet", "--initial-branch=main"]);
  await git(["add", "--all"]);
  await git(["commit", "--quiet", "-m", "fixture"]);
  mocks.runtimeConfig.mockResolvedValue({
    stateRoot: join(root, "state"),
    nodePath: process.execPath,
    godot: {
      receipt: {},
      binding: { executablePath: "/unused/offline-godot" },
    },
  });
  return source;
};

const completedPi = async (
  options: RunVNextPiSdkTurnOptions,
): Promise<VNextPiTurnResult> => {
  const sessionId = options.newSessionId;
  if (sessionId === undefined)
    throw new Error("Preview did not allocate its Session identity");
  // Represents an edit already made before shutdown; cleanup failure must not
  // turn these mutable bytes into a published, supposedly final candidate.
  await writeFile(
    join(options.resourceWorkspaceDirectory, "note.txt"),
    "candidate edit\n",
  );
  const sessionFile = join(options.sessionDirectory, `${sessionId}.jsonl`);
  await writeFile(
    sessionFile,
    JSON.stringify({ type: "session", id: sessionId }) + "\n",
  );
  return {
    schemaVersion: 1,
    status: "completed",
    sessionId,
    sessionFile,
    provider: options.provider,
    model: options.model,
    requestedThinkingLevel: options.thinkingLevel,
    realizedThinkingLevel: options.thinkingLevel,
    activeTools: options.tools.map((tool) => tool.name),
    assistantText: "Offline fixture completed its loop.",
    errorMessage: null,
    eventsObserved: 0,
    stats: {
      sessionId,
      sessionFile,
      userMessages: 1,
      assistantMessages: 1,
      toolCalls: 0,
      toolResults: 0,
      totalMessages: 2,
      tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
      cost: 0,
    },
  };
};

describe("Shared candidate Preview cleanup", () => {
  it.each(["collaboration", "runtime", "controller", "none"] as const)(
    "publishes a candidate only after every writer cleanup succeeds: %s",
    async (failed) => {
      const source = await fixture();
      const runPiTurn = vi.fn(completedPi);
      const forbidden = () => {
        throw new Error("Offline cleanup fixture must not start a sandbox");
      };
      const coding = vi
        .spyOn(SrtSandboxController.prototype, "runCoding")
        .mockImplementation(forbidden);
      const game = vi
        .spyOn(SrtSandboxController.prototype, "openGodot")
        .mockImplementation(forbidden);
      const importing = vi
        .spyOn(SrtSandboxController.prototype, "openGodotImport")
        .mockImplementation(forbidden);
      if (failed === "runtime")
        vi.spyOn(
          GodotInspectionRuntime.prototype,
          "close",
        ).mockRejectedValueOnce(new Error("runtime cleanup unconfirmed"));
      const output = await runProjectEnvironmentPreviewV2(
        {
          projectPath: source,
          provider: "offline-fixture",
          model: "offline-fixture",
          thinkingLevel: "off",
          goal: "Inspect the candidate",
          multiAgent: {},
        },
        {
          runPiTurn,
          createMultiAgentEnvironment: async (options) => {
            const environment =
              await createProjectMultiAgentEnvironment(options);
            cleanups.push(
              () => options.controller.close(),
              () => environment.close(),
            );
            if (failed === "collaboration")
              vi.spyOn(environment, "close").mockRejectedValueOnce(
                new Error("collaboration cleanup unconfirmed"),
              );
            if (failed === "controller")
              vi.spyOn(options.controller, "close").mockRejectedValueOnce(
                new Error("controller cleanup unconfirmed"),
              );
            return environment;
          },
        },
      );
      expect(runPiTurn).toHaveBeenCalledOnce();
      expect(coding).not.toHaveBeenCalled();
      expect(game).not.toHaveBeenCalled();
      expect(importing).not.toHaveBeenCalled();
      expect(output).toMatchObject({
        schemaVersion: 4,
        goalDelivered: true,
        workspaceMode: "shared",
      });
      if (output.schemaVersion !== 4)
        throw new Error("Expected shared candidate Preview");
      expect(await readFile(join(source, "note.txt"), "utf8")).toBe(
        "original source\n",
      );
      expect(
        await readFile(join(output.workspaceDirectory, "note.txt"), "utf8"),
      ).toBe("candidate edit\n");
      expect(output.agents).not.toBeNull();
      const summary = JSON.parse(
        await readFile(output.agents!.recordPath, "utf8"),
      ) as { rootStats: { tokens: { total: number } } };
      expect(summary.rootStats.tokens.total).toBe(2);
      if (failed === "none") {
        expect(output.status).toBe("completed");
        expect(output.candidateSourceChanged).toBe(true);
        expect(mocks.extractPatch).toHaveBeenCalledOnce();
        expect(output.candidatePatch?.byteLength).toBeGreaterThan(0);
        expect(await readFile(output.candidatePatch!.path, "utf8")).toContain(
          "candidate edit",
        );
      } else {
        expect(output.status).toBe("failed");
        expect(output.failureMessage).toContain(
          `${failed} cleanup unconfirmed`,
        );
        expect(output.limitations.join("\n")).toContain(
          "writer cleanup was not confirmed",
        );
        expect(mocks.extractPatch).not.toHaveBeenCalled();
        expect(output.candidatePatch).toBeNull();
        expect(output.candidateSourceChanged).toBeNull();
        expect(
          await readdir(join(output.taskDirectory, "records")),
        ).not.toContain("candidate.patch");
      }
      const published = JSON.parse(
        await readFile(
          join(output.taskDirectory, "records", "preview.v4.json"),
          "utf8",
        ),
      ) as unknown;
      expect(published).toEqual(output);
    },
  );
});
