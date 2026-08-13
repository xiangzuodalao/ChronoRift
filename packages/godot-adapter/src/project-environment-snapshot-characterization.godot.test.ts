import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Socket } from "node:net";

import {
  PROJECT_ADAPTER_REQUIRED_MODULES_V1,
  type ProjectAdapterCapabilityModuleV1,
} from "@chronorift/godot-protocol";
import { afterEach, describe, expect, it } from "vitest";

import { createSocketGodotTransport } from "./godot-wire-client.js";
import { loadProjectAdapterPackageV1 } from "./project-adapter-package.js";
import {
  GODOT_PROJECT_ENVIRONMENT_OVERRIDE_SOURCE_V1,
  PROJECT_ADAPTER_SDK_FILES_V1,
  PROJECT_ENVIRONMENT_BRIDGE_FILES_V1,
} from "./project-environment-runtime-assets.js";
import { characterizeGodotProjectEnvironmentSnapshotV1 } from "./project-environment-snapshot-characterization.js";
import { connectGodotProjectEnvironmentRuntimeV1 } from "./project-environment-wire-client.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const waitForExit = (
  child: ReturnType<typeof spawn>,
): Promise<{ readonly code: number | null; readonly signal: string | null }> =>
  new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });

const listen = (server: ReturnType<typeof createServer>): Promise<number> =>
  new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListen);
      const address = server.address();
      if (address === null || typeof address === "string") {
        rejectListen(new Error("Snapshot test server has no TCP port"));
        return;
      }
      resolveListen(address.port);
    });
  });

const acceptOne = (server: ReturnType<typeof createServer>): Promise<Socket> =>
  new Promise((resolveSocket, rejectSocket) => {
    const timer = setTimeout(
      () => rejectSocket(new Error("Snapshot fixture did not connect")),
      15_000,
    );
    server.once("connection", (socket) => {
      clearTimeout(timer);
      resolveSocket(socket);
    });
    server.once("error", (error) => {
      clearTimeout(timer);
      rejectSocket(error);
    });
  });

const sha256 = (value: Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

describe("PE-A snapshot characterization on Godot 4.7.1", () => {
  it("captures, mutates, restores, and reads back the frozen Adapter domains", async () => {
    const godotPath =
      process.env.CHRONORIFT_TEST_GODOT_BIN ??
      join(
        process.cwd(),
        ".tools/godot/4.7.1/Godot_v4.7.1-stable_linux.x86_64",
      );
    const fixtureRoot = join(
      process.cwd(),
      "fixtures/godot-project-environment-snapshot-characterization",
    );
    const fixtureAdapterRoot = join(fixtureRoot, "adapter");
    const optionalModules = [
      "input_control",
      "snapshot",
      "restore",
    ] as const satisfies readonly ProjectAdapterCapabilityModuleV1[];
    const requiredModules = [
      ...PROJECT_ADAPTER_REQUIRED_MODULES_V1,
      ...optionalModules,
    ];
    const adapterPackage = await loadProjectAdapterPackageV1(
      fixtureAdapterRoot,
      {
        requireSingleLaunchTarget: true,
        expectedMainScene: "res://main.tscn",
        requireEmptyLaunchParameters: true,
        requiredImplementedModules: requiredModules,
      },
    );

    const root = await mkdtemp(join(tmpdir(), "chronorift-pe-snapshot-"));
    roots.push(root);
    for (const entry of await readdir(fixtureRoot)) {
      await cp(join(fixtureRoot, entry), join(root, entry), {
        recursive: true,
      });
    }
    const addonRoot = join(root, "addons", "chronorift_project_environment");
    const managedAdapterRoot = join(root, ".chronorift", "project-adapter");
    await mkdir(addonRoot, { recursive: true });
    await mkdir(join(managedAdapterRoot, ".."), { recursive: true });
    await cp(join(root, "adapter"), managedAdapterRoot, { recursive: true });
    await rm(join(root, "adapter"), { recursive: true });
    for (const file of [
      ...PROJECT_ENVIRONMENT_BRIDGE_FILES_V1,
      ...PROJECT_ADAPTER_SDK_FILES_V1,
    ]) {
      const target = join(addonRoot, file.relativePath);
      await mkdir(join(target, ".."), { recursive: true });
      await writeFile(target, file.bytes);
    }
    await writeFile(
      join(root, "override.cfg"),
      GODOT_PROJECT_ENVIRONMENT_OVERRIDE_SOURCE_V1,
    );

    const cleanEnvironment = {
      HOME: root,
      PATH: "/usr/bin:/bin",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
    };
    const imported = spawn(
      godotPath,
      ["--headless", "--path", root, "--import"],
      {
        cwd: root,
        env: cleanEnvironment,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const importStderr: Buffer[] = [];
    imported.stderr.on("data", (chunk: Buffer) => importStderr.push(chunk));
    expect(
      await waitForExit(imported),
      Buffer.concat(importStderr).toString("utf8"),
    ).toEqual({ code: 0, signal: null });

    const server = createServer();
    const port = await listen(server);
    const socketPromise = acceptOne(server);
    const identity = {
      taskId: "task.pe.snapshot-characterization",
      sourceClosureId: "source.pe.snapshot-characterization",
      environmentRevisionId:
        "environment-revision.pe.snapshot-characterization",
      adapterRevisionId: "adapter-revision.pe.snapshot-characterization",
      buildId: "build.pe.snapshot-characterization",
      runtimeId: "runtime.pe.snapshot-characterization",
      executionId: "execution.pe.snapshot-characterization",
      instrumentationMode: "instrumented" as const,
      candidateSourceHash: "1".repeat(64),
      adapterManifestSha256: adapterPackage.manifestSha256,
      sdkSha256: "2".repeat(64),
      bridgeSha256: "3".repeat(64),
      toolchainSha256: "4".repeat(64),
    };
    const token = "5".repeat(64);
    const child = spawn(
      godotPath,
      [
        "--headless",
        "--path",
        root,
        "--rendering-method",
        "gl_compatibility",
        "--audio-driver",
        "Dummy",
      ],
      {
        cwd: root,
        env: {
          ...cleanEnvironment,
          CHRONORIFT_HOST: "127.0.0.1",
          CHRONORIFT_PORT: String(port),
          CHRONORIFT_TOKEN: token,
          CHRONORIFT_TASK_ID: identity.taskId,
          CHRONORIFT_SOURCE_CLOSURE_ID: identity.sourceClosureId,
          CHRONORIFT_ENVIRONMENT_REVISION_ID: identity.environmentRevisionId,
          CHRONORIFT_ADAPTER_REVISION_ID: identity.adapterRevisionId,
          CHRONORIFT_BUILD_ID: identity.buildId,
          CHRONORIFT_RUNTIME_ID: identity.runtimeId,
          CHRONORIFT_EXECUTION_ID: identity.executionId,
          CHRONORIFT_INSTRUMENTATION_MODE: identity.instrumentationMode,
          CHRONORIFT_CANDIDATE_SOURCE_HASH: identity.candidateSourceHash,
          CHRONORIFT_ADAPTER_MANIFEST_HASH: identity.adapterManifestSha256,
          CHRONORIFT_SDK_HASH: identity.sdkSha256,
          CHRONORIFT_BRIDGE_HASH: identity.bridgeSha256,
          CHRONORIFT_TOOLCHAIN_HASH: identity.toolchainSha256,
          CHRONORIFT_EXPECTED_MAIN_SCENE: "res://main.tscn",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));

    try {
      const socket = await socketPromise.catch((error: unknown) => {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}\nstdout:\n${Buffer.concat(stdout).toString("utf8")}\nstderr:\n${Buffer.concat(stderr).toString("utf8")}`,
        );
      });
      server.close();
      const runtime = await connectGodotProjectEnvironmentRuntimeV1(
        createSocketGodotTransport(socket),
        {
          schemaVersion: 1,
          token,
          expectedIdentity: identity,
          expectedEngineVersion: "4.7.1-stable (official)",
          expectedPlatform: "Linux",
          expectedMainScene: "res://main.tscn",
          expectedAdapterManifestSha256: identity.adapterManifestSha256,
          requiredModules,
          observationWindowBatches: 8,
          handshakeTimeoutMs: 15_000,
        },
      );
      const receipt = await characterizeGodotProjectEnvironmentSnapshotV1(
        runtime,
        {
          receiptId: "snapshot-characterization:pe-a:godot-4.7.1",
          taskId: identity.taskId,
          adapterRevisionId: identity.adapterRevisionId,
          buildId: identity.buildId,
          runtimeId: identity.runtimeId,
          executionId: identity.executionId,
          mutationId: "mutation.set-counter-99",
          requestedBarrier: "process_frame_end",
          applyControlledMutation: async (client) => {
            const result = await client.setControls({
              controls: [
                {
                  controlId: "characterization.set_counter",
                  parameters: { counter: 99 },
                  active: true,
                },
              ],
              requestedBarrier: "process_frame_end",
            });
            expect(result.realizedControls).toEqual([
              {
                controlId: "characterization.set_counter",
                active: true,
                realizedParameters: { counter: 99 },
              },
            ]);
          },
        },
      );
      const world = receipt.domains.find(
        (domain) => domain.domainId === "world",
      );
      const engine = receipt.domains.find(
        (domain) => domain.domainId === "engine.runtime",
      );

      expect(world).toMatchObject({
        disposition: "captured",
        mutationObserved: true,
        restoreStatus: "written",
        missing: false,
        mismatch: false,
      });
      expect(world?.expectedHash).toBe(world?.actualHash);
      expect(world?.mutatedHash).not.toBe(world?.expectedHash);
      expect(engine).toMatchObject({
        disposition: "uncontrolled",
        expectedHash: null,
        actualHash: null,
        missing: false,
        mismatch: false,
      });
      expect(receipt).toMatchObject({
        controlledMutationObserved: true,
        firstDivergence: null,
        conclusion: "descriptive_only",
      });
      await runtime.shutdown();
      await expect(waitForExit(child)).resolves.toEqual({
        code: 0,
        signal: null,
      });
      expect(Buffer.concat(stderr).toString("utf8")).not.toContain(
        "SCRIPT ERROR",
      );
      expect(
        sha256(await readFile(join(managedAdapterRoot, "manifest.json"))),
      ).toBe(adapterPackage.manifestSha256);
    } finally {
      server.close();
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await waitForExit(child).catch(() => undefined);
      }
    }
  }, 60_000);
});
