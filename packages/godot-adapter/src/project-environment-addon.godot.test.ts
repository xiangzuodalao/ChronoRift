import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Socket } from "node:net";

import {
  PROJECT_ADAPTER_CAPABILITY_MODULES_V1,
  PROJECT_ADAPTER_REQUIRED_MODULES_V1,
  PROJECT_ADAPTER_SCHEMA_DIALECT_V1,
} from "@chronorift/godot-protocol";
import { afterEach, describe, expect, it } from "vitest";

import { createSocketGodotTransport } from "./godot-wire-client.js";
import { connectGodotProjectEnvironmentRuntimeV1 } from "./project-environment-wire-client.js";
import {
  GODOT_PROJECT_ENVIRONMENT_OVERRIDE_SOURCE_V1,
  PROJECT_ADAPTER_SDK_FILES_V1,
  PROJECT_ENVIRONMENT_BRIDGE_FILES_V1,
} from "./project-environment-runtime-assets.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const listen = (server: ReturnType<typeof createServer>): Promise<number> =>
  new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListen);
      const address = server.address();
      if (address === null || typeof address === "string") {
        rejectListen(new Error("Project Environment test server has no port"));
        return;
      }
      resolveListen(address.port);
    });
  });

const acceptOne = (server: ReturnType<typeof createServer>): Promise<Socket> =>
  new Promise((resolveSocket, rejectSocket) => {
    const timer = setTimeout(
      () =>
        rejectSocket(new Error("Project Environment bridge did not connect")),
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

const waitForExit = (
  child: ReturnType<typeof spawn>,
): Promise<{ readonly code: number | null; readonly signal: string | null }> =>
  new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });

const hash = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

const payloadSchema = (schemaId: string) =>
  JSON.stringify({
    schemaVersion: 1,
    dialect: PROJECT_ADAPTER_SCHEMA_DIALECT_V1,
    schemaId,
    root: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  });

describe("Godot Project Environment bridge", () => {
  it("loads managed SDK module bases and emits identity-bound entity/state observations", async () => {
    const godotPath =
      process.env.CHRONORIFT_TEST_GODOT_BIN ??
      join(
        process.cwd(),
        ".tools/godot/4.7.1/Godot_v4.7.1-stable_linux.x86_64",
      );
    const root = await mkdtemp(join(tmpdir(), "chronorift-pe-godot-"));
    roots.push(root);
    const addonRoot = join(root, "addons", "chronorift_project_environment");
    const adapterRoot = join(root, ".chronorift", "project-adapter");
    await Promise.all([
      mkdir(addonRoot, { recursive: true }),
      mkdir(join(adapterRoot, "src"), { recursive: true }),
      mkdir(join(adapterRoot, "schemas"), { recursive: true }),
    ]);
    for (const file of [
      ...PROJECT_ENVIRONMENT_BRIDGE_FILES_V1,
      ...PROJECT_ADAPTER_SDK_FILES_V1,
    ]) {
      const target = join(addonRoot, file.relativePath);
      await mkdir(join(target, ".."), { recursive: true });
      await writeFile(target, file.bytes);
    }
    const schemas = ["launch.params", "entity.node", "state.world"].map(
      (schemaId) => ({ schemaId, bytes: payloadSchema(schemaId) }),
    );
    const modules = {
      schemaVersion: 1,
      modules: PROJECT_ADAPTER_CAPABILITY_MODULES_V1.map((module) => {
        const implemented = PROJECT_ADAPTER_REQUIRED_MODULES_V1.includes(
          module as (typeof PROJECT_ADAPTER_REQUIRED_MODULES_V1)[number],
        );
        return {
          schemaVersion: 1,
          module,
          status: implemented ? "implemented" : "unsupported",
          protocolVersion: implemented ? "project-adapter-module:v1" : null,
          limitations: implemented ? [] : ["not implemented by this adapter"],
        };
      }),
    };
    const manifest = JSON.stringify({
      schemaVersion: 1,
      manifestKind: "chronorift-project-adapter",
      adapterId: "adapter.real-godot",
      adapterVersion: "1.0.0",
      sdk: { id: "chronorift-project-adapter-sdk", version: 1 },
      engine: {
        id: "godot",
        versionRequirement: "4.7.x",
        language: "gdscript",
      },
      entryScript: "src/project_adapter.gd",
      schemas: schemas.map((schema) => ({
        schemaVersion: 1,
        schemaId: schema.schemaId,
        path: `schemas/${schema.schemaId}.json`,
        sha256: hash(schema.bytes),
      })),
      launchTargets: [
        {
          schemaVersion: 1,
          targetId: "main",
          scene: "res://main.tscn",
          default: true,
          parametersSchemaId: "launch.params",
          renderer: "headless",
          requiredModules: [...PROJECT_ADAPTER_REQUIRED_MODULES_V1],
        },
      ],
      modules,
      entityTypes: [
        {
          schemaVersion: 1,
          entityTypeId: "node",
          schemaId: "entity.node",
          identityStrategy: "execution_local",
        },
      ],
      stateDomains: [
        {
          schemaVersion: 1,
          stateDomainId: "world",
          schemaId: "state.world",
          checkpointDisposition: "uncontrolled",
        },
      ],
      eventTypes: [],
      smoke: {
        schemaVersion: 1,
        targetId: "main",
        timeoutMs: 30_000,
        minimumStateSamples: 1,
        minimumEntityLifecycleRecords: 1,
        requiredStateDomainIds: ["world"],
        requiredCustomEventTypeIds: [],
      },
    });
    const adapterSource = `extends ChronoRiftProjectAdapterV1

class EntityProjection extends ChronoRiftEntityProjectionV1:
\tfunc sample(current_scene: Node) -> Array:
\t\treturn [{"entityId": "scene.root", "entityTypeId": "node", "incarnation": 1, "identityScope": "execution_local", "projection": {"name": str(current_scene.name)}}]

class StateProjection extends ChronoRiftStateProjectionV1:
\tfunc sample(current_scene: Node) -> Array:
\t\tvar semantic_coverage := OS.get_environment("CHRONORIFT_TEST_SEMANTIC_COVERAGE")
\t\tif semantic_coverage.is_empty():
\t\t\tsemantic_coverage = "declared"
\t\treturn [{"stateDomainId": "world", "value": {"ready": current_scene != null}, "semanticCoverage": semantic_coverage}]

class EventProjection extends ChronoRiftEventProjectionV1:
\tfunc drain(_current_scene: Node) -> Array:
\t\treturn []

func create_modules() -> Dictionary:
\treturn {"entity_projection": EntityProjection.new(), "state_projection": StateProjection.new(), "event_projection": EventProjection.new()}
`;
    await Promise.all([
      writeFile(
        join(root, "project.godot"),
        [
          "config_version=5",
          "",
          "[application]",
          'config/name="ChronoRiftProjectEnvironmentCharacterization"',
          'run/main_scene="res://main.tscn"',
          "",
          "[rendering]",
          'renderer/rendering_method="gl_compatibility"',
          'renderer/rendering_method.mobile="gl_compatibility"',
          "",
        ].join("\n"),
      ),
      writeFile(
        join(root, "override.cfg"),
        GODOT_PROJECT_ENVIRONMENT_OVERRIDE_SOURCE_V1,
      ),
      writeFile(
        join(root, "main.tscn"),
        '[gd_scene format=3]\n\n[node name="Main" type="Node"]\n',
      ),
      writeFile(join(adapterRoot, "manifest.json"), manifest),
      writeFile(join(adapterRoot, "src", "project_adapter.gd"), adapterSource),
      ...schemas.map((schema) =>
        writeFile(
          join(adapterRoot, "schemas", `${schema.schemaId}.json`),
          schema.bytes,
        ),
      ),
    ]);

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
    const importExit = await waitForExit(imported);
    expect(importExit, Buffer.concat(importStderr).toString("utf8")).toEqual({
      code: 0,
      signal: null,
    });

    const server = createServer();
    const port = await listen(server);
    const socketPromise = acceptOne(server);
    const identity = {
      taskId: "task.pe.real-godot",
      sourceClosureId: "source.pe.real-godot",
      environmentRevisionId: "environment-revision.pe.real-godot",
      adapterRevisionId: "adapter-revision.pe.real-godot",
      buildId: "build.pe.real-godot",
      runtimeId: "runtime.pe.real-godot",
      executionId: "execution.pe.real-godot",
      instrumentationMode: "instrumented" as const,
      candidateSourceHash: "1".repeat(64),
      adapterManifestSha256: hash(manifest),
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
          requiredModules: PROJECT_ADAPTER_REQUIRED_MODULES_V1,
          observationWindowBatches: 8,
          handshakeTimeoutMs: 15_000,
        },
      );
      expect(runtime.ready.coverage.semanticCoverage).toBe("declared");
      const configured = await runtime.configureCapture({
        channels: ["entity", "state", "event", "runtime_error"],
        rollingRecordLimit: 1,
      });
      expect(configured).toEqual({
        channels: [
          "entity",
          "state",
          "event",
          "runtime_error",
          "clock",
          "capture_loss",
        ],
        realizedRollingRecordLimit: 1,
      });
      const observed = new Set<string>();
      const runtimeErrors: string[] = [];
      const deadline = performance.now() + 15_000;
      while (
        performance.now() < deadline &&
        (!observed.has("entity_lifecycle") || !observed.has("state_sample"))
      ) {
        const batch = await runtime.nextObservationBatch(2_000);
        for (const record of batch.records) {
          observed.add(record.kind);
          if (record.kind === "runtime_error") {
            runtimeErrors.push(record.payload.message);
          }
        }
        await runtime.acknowledgeObservationBatch(batch, 8);
      }
      expect([...observed], runtimeErrors.join("; ")).toContain(
        "entity_lifecycle",
      );
      expect([...observed]).toContain("state_sample");
      const current = await runtime.status();
      expect(current.coverage).toMatchObject({
        status: "partial",
        semanticCoverage: "declared",
      });
      expect(current.coverage.overwriteCount).toBeGreaterThan(0);
      await runtime.shutdown();
      await expect(waitForExit(child)).resolves.toEqual({
        code: 0,
        signal: null,
      });
      expect(Buffer.concat(stderr).toString("utf8")).not.toContain(
        "SCRIPT ERROR",
      );

      const partialServer = createServer();
      const partialPort = await listen(partialServer);
      const partialSocketPromise = acceptOne(partialServer);
      const partialIdentity = {
        ...identity,
        runtimeId: "runtime.pe.real-godot.partial",
        executionId: "execution.pe.real-godot.partial",
      };
      const partialToken = "6".repeat(64);
      const partialChild = spawn(
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
            CHRONORIFT_PORT: String(partialPort),
            CHRONORIFT_TOKEN: partialToken,
            CHRONORIFT_TASK_ID: partialIdentity.taskId,
            CHRONORIFT_SOURCE_CLOSURE_ID: partialIdentity.sourceClosureId,
            CHRONORIFT_ENVIRONMENT_REVISION_ID:
              partialIdentity.environmentRevisionId,
            CHRONORIFT_ADAPTER_REVISION_ID: partialIdentity.adapterRevisionId,
            CHRONORIFT_BUILD_ID: partialIdentity.buildId,
            CHRONORIFT_RUNTIME_ID: partialIdentity.runtimeId,
            CHRONORIFT_EXECUTION_ID: partialIdentity.executionId,
            CHRONORIFT_INSTRUMENTATION_MODE:
              partialIdentity.instrumentationMode,
            CHRONORIFT_CANDIDATE_SOURCE_HASH:
              partialIdentity.candidateSourceHash,
            CHRONORIFT_ADAPTER_MANIFEST_HASH:
              partialIdentity.adapterManifestSha256,
            CHRONORIFT_SDK_HASH: partialIdentity.sdkSha256,
            CHRONORIFT_BRIDGE_HASH: partialIdentity.bridgeSha256,
            CHRONORIFT_TOOLCHAIN_HASH: partialIdentity.toolchainSha256,
            CHRONORIFT_EXPECTED_MAIN_SCENE: "res://main.tscn",
            CHRONORIFT_TEST_SEMANTIC_COVERAGE: "partial",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const partialStderr: Buffer[] = [];
      partialChild.stderr.on("data", (chunk: Buffer) =>
        partialStderr.push(chunk),
      );
      try {
        const partialSocket = await partialSocketPromise;
        partialServer.close();
        await expect(
          connectGodotProjectEnvironmentRuntimeV1(
            createSocketGodotTransport(partialSocket),
            {
              schemaVersion: 1,
              token: partialToken,
              expectedIdentity: partialIdentity,
              expectedEngineVersion: "4.7.1-stable (official)",
              expectedPlatform: "Linux",
              expectedMainScene: "res://main.tscn",
              expectedAdapterManifestSha256:
                partialIdentity.adapterManifestSha256,
              requiredModules: PROJECT_ADAPTER_REQUIRED_MODULES_V1,
              observationWindowBatches: 8,
              handshakeTimeoutMs: 15_000,
            },
          ),
        ).rejects.toThrow(
          /ADAPTER_FAILURE.*readiness requires at least one state sample and declared semantic coverage/u,
        );
        await expect(waitForExit(partialChild)).resolves.toEqual({
          code: 2,
          signal: null,
        });
        expect(Buffer.concat(partialStderr).toString("utf8")).not.toContain(
          "SCRIPT ERROR",
        );
      } finally {
        partialServer.close();
        if (
          partialChild.exitCode === null &&
          partialChild.signalCode === null
        ) {
          partialChild.kill("SIGKILL");
          await waitForExit(partialChild).catch(() => undefined);
        }
      }
    } finally {
      server.close();
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await waitForExit(child).catch(() => undefined);
      }
    }
  }, 60_000);
});
