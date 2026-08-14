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

import { afterEach, describe, expect, it } from "vitest";

import { createSocketGodotTransport } from "./godot-wire-client.js";
import {
  ProjectAdapterObservationExecutionValidatorV2,
  recognizeProjectAdapterDynamicTracesV2,
} from "./project-adapter-observation-v2.js";
import {
  loadProjectAdapterPackageFilesV2,
  type ProjectAdapterPackageBytesV2,
} from "./project-adapter-package-v2.js";
import { connectGodotProjectEnvironmentRuntimeV2 } from "./project-environment-wire-client-v2.js";
import {
  GODOT_PROJECT_ENVIRONMENT_OVERRIDE_SOURCE_V2,
  PROJECT_ADAPTER_SDK_FILES_V2,
  PROJECT_ENVIRONMENT_BRIDGE_FILES_V2,
} from "./project-environment-runtime-assets-v2.js";

const roots: string[] = [];
afterEach(async () =>
  Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  ),
);
const waitForExit = (child: ReturnType<typeof spawn>) =>
  new Promise<{ code: number | null; signal: string | null }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    },
  );
const listen = (server: ReturnType<typeof createServer>) =>
  new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string")
        reject(new Error("missing address"));
      else resolve(address.port);
    });
  });
const acceptOne = (server: ReturnType<typeof createServer>) =>
  new Promise<Socket>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("V2 bridge did not connect")),
      15_000,
    );
    server.once("connection", (socket) => {
      clearTimeout(timer);
      resolve(socket);
    });
    server.once("error", reject);
  });
const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const testAdapterFiles = async (): Promise<ProjectAdapterPackageBytesV2[]> => {
  const root = join(
    process.cwd(),
    "testdata/vnext/project-environment/pe-b-dynamic-adapter",
  );
  const files: ProjectAdapterPackageBytesV2[] = [];
  const walk = async (relative = ""): Promise<void> => {
    for (const entry of await readdir(join(root, relative), {
      withFileTypes: true,
    })) {
      const path = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) await walk(path);
      else files.push({ path, bytes: await readFile(join(root, path)) });
    }
  };
  await walk();
  return files;
};

describe("Godot Project Environment V2 dynamic projection", () => {
  it("captures a lossless create/signal/change/destroy/recreate lineage", async () => {
    const godotPath =
      process.env.CHRONORIFT_TEST_GODOT_BIN ??
      join(
        process.cwd(),
        ".tools/godot/4.7.1/Godot_v4.7.1-stable_linux.x86_64",
      );
    const root = await mkdtemp(join(tmpdir(), "chronorift-pe-b-godot-"));
    roots.push(root);
    await cp(
      join(process.cwd(), "fixtures/godot-project-environment-dynamic"),
      root,
      { recursive: true },
    );
    const addonRoot = join(root, "addons/chronorift_project_environment");
    const adapterRoot = join(root, ".chronorift/project-adapter");
    await mkdir(addonRoot, { recursive: true });
    for (const file of [
      ...PROJECT_ENVIRONMENT_BRIDGE_FILES_V2,
      ...PROJECT_ADAPTER_SDK_FILES_V2,
    ]) {
      const target = join(addonRoot, file.relativePath);
      await mkdir(join(target, ".."), { recursive: true });
      await writeFile(target, file.bytes);
    }
    const adapterFiles = await testAdapterFiles();
    for (const file of adapterFiles) {
      const target = join(adapterRoot, file.path);
      await mkdir(join(target, ".."), { recursive: true });
      await writeFile(target, file.bytes);
    }
    await writeFile(
      join(root, "override.cfg"),
      GODOT_PROJECT_ENVIRONMENT_OVERRIDE_SOURCE_V2,
    );
    const imported = spawn(
      godotPath,
      ["--headless", "--path", root, "--import"],
      {
        cwd: root,
        env: {
          HOME: root,
          PATH: "/usr/bin:/bin",
          LANG: "C.UTF-8",
          LC_ALL: "C.UTF-8",
        },
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
    const executionId = "execution.pe-b.real-godot";
    const manifest = adapterFiles.find(
      (file) => file.path === "manifest.json",
    )!;
    const identity = {
      taskId: "task.pe-b.real-godot",
      sourceClosureId: "source.pe-b.real-godot",
      environmentRevisionId: "environment-revision.pe-b.real-godot",
      adapterRevisionId: "adapter-revision.pe-b.real-godot",
      buildId: "build.pe-b.real-godot",
      runtimeId: "runtime.pe-b.real-godot",
      executionId,
      instrumentationMode: "instrumented" as const,
      candidateSourceHash: "1".repeat(64),
      adapterManifestSha256: hash(manifest.bytes),
      sdkSha256: "2".repeat(64),
      bridgeSha256: "3".repeat(64),
      toolchainSha256: "4".repeat(64),
      observationProtocolVersion: 2 as const,
      adapterSdkVersion: 2 as const,
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
          HOME: root,
          PATH: "/usr/bin:/bin",
          LANG: "C.UTF-8",
          LC_ALL: "C.UTF-8",
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
          `${String(error)}\n${Buffer.concat(stdout).toString("utf8")}\n${Buffer.concat(stderr).toString("utf8")}`,
        );
      });
      server.close();
      const runtime = await connectGodotProjectEnvironmentRuntimeV2(
        createSocketGodotTransport(socket),
        {
          schemaVersion: 2,
          token,
          expectedIdentity: identity,
          expectedEngineVersion: "4.7.1-stable (official)",
          expectedPlatform: "Linux",
          expectedMainScene: "res://main.tscn",
          expectedAdapterManifestSha256: identity.adapterManifestSha256,
          observationWindowBatches: 8,
          handshakeTimeoutMs: 15_000,
        },
      );
      const loaded = loadProjectAdapterPackageFilesV2(adapterFiles);
      const validator = new ProjectAdapterObservationExecutionValidatorV2(
        loaded,
        executionId,
      );
      const records = [];
      const deadline = performance.now() + 15_000;
      while (performance.now() < deadline) {
        const batch = await runtime.nextObservationBatch(2_000);
        records.push(
          ...batch.records.map((record) => validator.validate(record)),
        );
        await runtime.acknowledgeObservationBatch(batch, 8);
        try {
          const traces = recognizeProjectAdapterDynamicTracesV2(
            loaded,
            records,
          );
          expect(traces[0]).toMatchObject({
            entityId: "dynamic.actor",
            firstIncarnation: 1,
            lastIncarnation: 2,
          });
          break;
        } catch {
          /* keep collecting */
        }
      }
      expect(
        recognizeProjectAdapterDynamicTracesV2(loaded, records),
      ).toHaveLength(1);
      const status = await runtime.status();
      expect(status.coverage).toMatchObject({
        status: "complete",
        semanticCoverage: "declared",
        droppedRecordCount: 0,
        overwriteCount: 0,
      });
      await runtime.shutdown();
      await expect(waitForExit(child)).resolves.toEqual({
        code: 0,
        signal: null,
      });
      expect(Buffer.concat(stderr).toString("utf8")).not.toContain(
        "SCRIPT ERROR",
      );
    } finally {
      server.close();
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await waitForExit(child).catch(() => undefined);
      }
    }
  }, 60_000);
});
