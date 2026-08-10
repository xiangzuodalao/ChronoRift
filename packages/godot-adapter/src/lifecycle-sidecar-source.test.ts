import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  GodotLifecycleSidecarDiagnosticV1Schema,
  GodotLifecycleSidecarLaunchV1Schema,
  GodotLifecycleVanillaSmokeDiagnosticV1Schema,
  GodotLifecycleVanillaSmokeLaunchV1Schema,
  WireFrameDecoder,
  encodeWireFrame,
} from "@chronorift/godot-protocol";
import { afterEach, describe, expect, it } from "vitest";

import {
  GODOT_LIFECYCLE_OVERRIDE_SOURCE,
  createLifecycleRuntimeSidecarSource,
  createLifecycleVanillaSmokeSidecarSource,
} from "./lifecycle-sidecar-source.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const sha256 = (value: Uint8Array | string): string =>
  createHash("sha256").update(value).digest("hex");

const selectedTreeDigest = (
  entries: readonly {
    readonly relativePath: string;
    readonly mode: "100644" | "100755";
    readonly bytes: Uint8Array;
  }[],
): string => {
  const hash = createHash("sha256").update("chronorift-selected-tree-v1\0");
  for (const entry of [...entries].sort((left, right) =>
    Buffer.compare(
      Buffer.from(left.relativePath, "utf8"),
      Buffer.from(right.relativePath, "utf8"),
    ),
  )) {
    const pathBytes = Buffer.from(entry.relativePath, "utf8");
    hash.update(`${pathBytes.byteLength}:`);
    hash.update(pathBytes);
    hash.update(`\0${entry.mode}\0${entry.bytes.byteLength}:`);
    hash.update(entry.bytes);
    hash.update("\0");
  }
  return hash.digest("hex");
};

const treeDigest = (
  entries: readonly {
    readonly relativePath: string;
    readonly bytes: Uint8Array;
  }[],
): string => {
  const hash = createHash("sha256");
  for (const entry of [...entries].sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  )) {
    hash.update(entry.relativePath);
    hash.update("\0");
    hash.update(entry.bytes);
    hash.update("\0");
  }
  return hash.digest("hex");
};

const waitForExit = (
  child: ReturnType<typeof spawn>,
): Promise<{ readonly code: number | null; readonly signal: string | null }> =>
  new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });

const decode = <T>(
  bytes: Uint8Array,
  parse: (value: unknown) => T,
): readonly T[] => {
  const decoder = new WireFrameDecoder();
  const records = decoder
    .push(bytes)
    .map((json) => parse(JSON.parse(json) as unknown));
  decoder.end();
  return records;
};

const commonLaunch = (candidateSourceHash: string) => ({
  schemaVersion: 1 as const,
  runtimeProfile: "chronorift-managed-godot-lifecycle-v1" as const,
  taskId: "task:lifecycle",
  buildId: "build:lifecycle",
  runtimeId: "runtime:lifecycle",
  executionId: "execution:lifecycle",
  managedRuntimeId: `managed-godot-runtime:v1:${"a".repeat(64)}`,
  candidateSourceHash,
  diagnosticFrameMaxBytes: 64 * 1024,
  diagnosticTotalMaxBytes: 1024 * 1024,
  diagnosticMaxCount: 128,
  outputCaptureMaxBytes: 1_024,
});

describe("Godot lifecycle sidecar sources", () => {
  it("imports then observes an unmodified vanilla main scene for two seconds", async () => {
    const root = await mkdtemp(join(tmpdir(), "chronorift-vanilla-smoke-"));
    roots.push(root);
    const workspace = join(root, "workspace");
    const runtime = join(root, "runtime");
    await Promise.all([mkdir(workspace), mkdir(runtime)]);
    const projectBytes = Buffer.from(
      '[application]\nrun/main_scene="res://main.tscn"\n',
    );
    const sceneBytes = Buffer.from(
      '[gd_scene format=3]\n\n[node name="Main" type="Node"]\n',
    );
    const executableBytes = Buffer.from("#!/bin/sh\nexit 0\n");
    await Promise.all([
      writeFile(join(workspace, "project.godot"), projectBytes),
      writeFile(join(workspace, "main.tscn"), sceneBytes),
      writeFile(join(workspace, "tool.sh"), executableBytes),
    ]);
    await chmod(join(workspace, "tool.sh"), 0o755);
    const fakeGodot = join(root, "fake-godot.cjs");
    await writeFile(
      fakeGodot,
      [
        'const fs = require("node:fs");',
        'const path = require("node:path");',
        'const projectRoot = process.argv[process.argv.indexOf("--path") + 1];',
        'if (process.argv.includes("--import")) {',
        '  if ((fs.statSync(path.join(projectRoot, "tool.sh")).mode & 0o111) === 0) process.exit(9);',
        '  process.stdout.write("import complete\\n");',
        "  process.exit(0);",
        "}",
        "process.stdout.write(Buffer.alloc(4096, 0x76));",
        'process.on("SIGTERM", () => process.exit(0));',
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    );
    const source = createLifecycleVanillaSmokeSidecarSource({
      godotExecutable: process.execPath,
      godotArgsPrefix: [fakeGodot],
      workspaceRoot: workspace,
      runtimeRoot: runtime,
    });
    const sidecar = spawn(
      process.execPath,
      ["--input-type=commonjs", "--eval", source],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    const stderr: Buffer[] = [];
    sidecar.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    const candidateSourceHash = selectedTreeDigest([
      { relativePath: "main.tscn", mode: "100644", bytes: sceneBytes },
      {
        relativePath: "project.godot",
        mode: "100644",
        bytes: projectBytes,
      },
      {
        relativePath: "tool.sh",
        mode: "100755",
        bytes: executableBytes,
      },
    ]);
    const launch = GodotLifecycleVanillaSmokeLaunchV1Schema.parse({
      ...commonLaunch(candidateSourceHash),
      operation: "vanilla_smoke",
      importTimeoutMs: 5_000,
      vanillaTimeoutMs: 5_000,
      stabilityWindowMs: 2_000,
    });
    sidecar.stdin.end(encodeWireFrame(JSON.stringify(launch)));

    await expect(waitForExit(sidecar)).resolves.toEqual({
      code: 0,
      signal: null,
    });
    const diagnostics = decode(Buffer.concat(stderr), (value) =>
      GodotLifecycleVanillaSmokeDiagnosticV1Schema.parse(value),
    );
    const complete = diagnostics.find(
      (record) => record.kind === "smoke_complete",
    );
    expect(complete).toMatchObject({
      kind: "smoke_complete",
      candidateSourceHash,
      import: { exitCode: 0, signal: null, timedOut: false },
      vanilla: {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: { totalBytes: 4_096, retainedBytes: 1_024, truncated: true },
      },
    });
    expect(
      diagnostics
        .filter((record) => record.kind === "source_verified")
        .map((record) => record.phase),
    ).toEqual(["import", "vanilla"]);
    if (complete?.kind === "smoke_complete") {
      expect(complete.stabilityObservedMs).toBeGreaterThanOrEqual(2_000);
    }
  });

  it("rejects an import that mutates the staged candidate before vanilla launch", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "chronorift-vanilla-import-mutation-"),
    );
    roots.push(root);
    const workspace = join(root, "workspace");
    const runtime = join(root, "runtime");
    await Promise.all([mkdir(workspace), mkdir(runtime)]);
    const projectBytes = Buffer.from(
      '[application]\nrun/main_scene="res://main.tscn"\n',
    );
    const sceneBytes = Buffer.from(
      '[gd_scene format=3]\n\n[node name="Main" type="Node"]\n',
    );
    await Promise.all([
      writeFile(join(workspace, "project.godot"), projectBytes),
      writeFile(join(workspace, "main.tscn"), sceneBytes),
    ]);
    const fakeGodot = join(root, "fake-mutating-godot.cjs");
    await writeFile(
      fakeGodot,
      [
        'const fs = require("node:fs");',
        'const path = require("node:path");',
        'const projectRoot = process.argv[process.argv.indexOf("--path") + 1];',
        'if (process.argv.includes("--import")) {',
        '  fs.appendFileSync(path.join(projectRoot, "project.godot"), "\\n[editor_plugins]\\n");',
        "  process.exit(0);",
        "}",
        'fs.writeFileSync(path.join(projectRoot, "VANILLA_SHOULD_NOT_RUN"), "unexpected\\n");',
        "process.exit(0);",
      ].join("\n"),
    );
    const source = createLifecycleVanillaSmokeSidecarSource({
      godotExecutable: process.execPath,
      godotArgsPrefix: [fakeGodot],
      workspaceRoot: workspace,
      runtimeRoot: runtime,
    });
    const sidecar = spawn(
      process.execPath,
      ["--input-type=commonjs", "--eval", source],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    const stderr: Buffer[] = [];
    sidecar.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    const candidateSourceHash = selectedTreeDigest([
      { relativePath: "main.tscn", mode: "100644", bytes: sceneBytes },
      {
        relativePath: "project.godot",
        mode: "100644",
        bytes: projectBytes,
      },
    ]);
    sidecar.stdin.end(
      encodeWireFrame(
        JSON.stringify({
          ...commonLaunch(candidateSourceHash),
          operation: "vanilla_smoke",
          importTimeoutMs: 5_000,
          vanillaTimeoutMs: 5_000,
          stabilityWindowMs: 2_000,
        }),
      ),
    );

    await expect(waitForExit(sidecar)).resolves.toEqual({
      code: 1,
      signal: null,
    });
    const diagnostics = decode(Buffer.concat(stderr), (value) =>
      GodotLifecycleVanillaSmokeDiagnosticV1Schema.parse(value),
    );
    const smokeFailure = diagnostics.find(
      (diagnostic) => diagnostic.kind === "smoke_failed",
    );
    expect(smokeFailure).toMatchObject({
      kind: "smoke_failed",
      failedPhase: "import",
      candidateSourceHash,
      vanilla: null,
    });
    if (smokeFailure?.kind !== "smoke_failed") {
      throw new Error("missing terminal smoke failure diagnostic");
    }
    expect(smokeFailure.import).toMatchObject({
      exitCode: 0,
      signal: null,
      timedOut: false,
    });
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        kind: "sidecar_error",
        phase: "import",
        code: "BUILD_IDENTITY_MISMATCH",
      }),
    );
  });

  it("emits a terminal process receipt when vanilla import fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "chronorift-import-failure-"));
    roots.push(root);
    const workspace = join(root, "workspace");
    const runtime = join(root, "runtime");
    await Promise.all([mkdir(workspace), mkdir(runtime)]);
    const projectBytes = Buffer.from(
      '[application]\nrun/main_scene="res://main.tscn"\n',
    );
    const sceneBytes = Buffer.from(
      '[gd_scene format=3]\n\n[node name="Main" type="Node"]\n',
    );
    await Promise.all([
      writeFile(join(workspace, "project.godot"), projectBytes),
      writeFile(join(workspace, "main.tscn"), sceneBytes),
    ]);
    const fakeGodot = join(root, "failing-godot.cjs");
    await writeFile(
      fakeGodot,
      'process.stderr.write("import failed\\n"); process.exit(9);\n',
    );
    const source = createLifecycleVanillaSmokeSidecarSource({
      godotExecutable: process.execPath,
      godotArgsPrefix: [fakeGodot],
      workspaceRoot: workspace,
      runtimeRoot: runtime,
    });
    const sidecar = spawn(
      process.execPath,
      ["--input-type=commonjs", "--eval", source],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    const stderr: Buffer[] = [];
    sidecar.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    const candidateSourceHash = selectedTreeDigest([
      { relativePath: "main.tscn", mode: "100644", bytes: sceneBytes },
      {
        relativePath: "project.godot",
        mode: "100644",
        bytes: projectBytes,
      },
    ]);
    const launch = GodotLifecycleVanillaSmokeLaunchV1Schema.parse({
      ...commonLaunch(candidateSourceHash),
      operation: "vanilla_smoke",
      importTimeoutMs: 5_000,
      vanillaTimeoutMs: 5_000,
      stabilityWindowMs: 2_000,
    });
    sidecar.stdin.end(encodeWireFrame(JSON.stringify(launch)));

    await expect(waitForExit(sidecar)).resolves.toEqual({
      code: 1,
      signal: null,
    });
    const diagnostics = decode(Buffer.concat(stderr), (value) =>
      GodotLifecycleVanillaSmokeDiagnosticV1Schema.parse(value),
    );
    const smokeFailure = diagnostics.find(
      (diagnostic) => diagnostic.kind === "smoke_failed",
    );
    expect(smokeFailure).toMatchObject({
      kind: "smoke_failed",
      candidateSourceHash,
      failedPhase: "import",
      vanilla: null,
    });
    if (smokeFailure?.kind !== "smoke_failed") {
      throw new Error("missing terminal smoke failure diagnostic");
    }
    expect(smokeFailure.import).toMatchObject({
      exitCode: 9,
      signal: null,
      timedOut: false,
    });
    expect(smokeFailure.import?.stderr).toMatchObject({
      totalBytes: 14,
      retainedBytes: 14,
      truncated: false,
    });
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        kind: "sidecar_error",
        code: "GODOT_IMPORT_FAILED",
      }),
    );
  });

  it("stages the read-only overlay separately and relays lifecycle wire bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "chronorift-lifecycle-sidecar-"));
    roots.push(root);
    const workspace = join(root, "workspace");
    const runtime = join(root, "runtime");
    const overlayProject = join(runtime, "overlay", "project");
    const addonRoot = join(overlayProject, "addons", "chronorift_lifecycle");
    await Promise.all([
      mkdir(workspace),
      mkdir(addonRoot, { recursive: true }),
    ]);
    const projectBytes = Buffer.from(
      '[application]\nrun/main_scene="res://main.tscn"\n',
    );
    const sceneBytes = Buffer.from(
      '[gd_scene format=3]\n\n[node name="Main" type="Node"]\n',
    );
    const addonBytes = Buffer.from("extends Node\n");
    await Promise.all([
      writeFile(join(workspace, "project.godot"), projectBytes),
      writeFile(join(workspace, "main.tscn"), sceneBytes),
      writeFile(join(addonRoot, "lifecycle_probe.gd"), addonBytes),
      writeFile(
        join(overlayProject, "override.cfg"),
        GODOT_LIFECYCLE_OVERRIDE_SOURCE,
      ),
    ]);
    const fakeGodot = join(root, "fake-runtime.cjs");
    await writeFile(
      fakeGodot,
      [
        'const net = require("node:net");',
        'process.stdout.write("managed runtime\\n");',
        "const socket = net.connect(Number(process.env.CHRONORIFT_PORT), process.env.CHRONORIFT_HOST);",
        'socket.on("data", (chunk) => socket.write(chunk));',
        'socket.on("end", () => { socket.end(); process.exit(0); });',
      ].join("\n"),
    );
    const source = createLifecycleRuntimeSidecarSource({
      godotExecutable: process.execPath,
      godotArgsPrefix: [fakeGodot],
      workspaceRoot: workspace,
      runtimeRoot: runtime,
    });
    const sidecar = spawn(
      process.execPath,
      ["--input-type=commonjs", "--eval", source],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    sidecar.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    sidecar.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    const candidateSourceHash = selectedTreeDigest([
      { relativePath: "main.tscn", mode: "100644", bytes: sceneBytes },
      {
        relativePath: "project.godot",
        mode: "100644",
        bytes: projectBytes,
      },
    ]);
    const launch = GodotLifecycleSidecarLaunchV1Schema.parse({
      ...commonLaunch(candidateSourceHash),
      operation: "managed_lifecycle",
      protocolProfile: "chronorift-godot-lifecycle-v1",
      protocolVersion: 1,
      token: "e".repeat(64),
      overlayHash: sha256(GODOT_LIFECYCLE_OVERRIDE_SOURCE),
      addonHash: treeDigest([
        { relativePath: "lifecycle_probe.gd", bytes: addonBytes },
      ]),
      expectedMainScene: "res://main.tscn",
      startupTimeoutMs: 5_000,
      executionTimeoutMs: 10_000,
    });
    const payload = Buffer.from("lifecycle-wire-bytes");
    sidecar.stdin.write(
      Buffer.concat([encodeWireFrame(JSON.stringify(launch)), payload]),
    );
    await new Promise<void>((resolveEcho, rejectEcho) => {
      const timer = setTimeout(
        () => rejectEcho(new Error("lifecycle sidecar echo timed out")),
        5_000,
      );
      const check = (): void => {
        if (Buffer.concat(stdout).includes(payload)) {
          clearTimeout(timer);
          resolveEcho();
        }
      };
      sidecar.stdout.on("data", check);
      check();
    });
    sidecar.stdin.end();

    await expect(waitForExit(sidecar)).resolves.toEqual({
      code: 0,
      signal: null,
    });
    expect(Buffer.concat(stdout)).toEqual(payload);
    const diagnostics = decode(Buffer.concat(stderr), (value) =>
      GodotLifecycleSidecarDiagnosticV1Schema.parse(value),
    );
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "stage_ready",
          candidateSourceHash,
          overlayHash: launch.overlayHash,
          addonHash: launch.addonHash,
        }),
        expect.objectContaining({ kind: "godot_started" }),
        expect.objectContaining({ kind: "stream_summary", stream: "stdout" }),
        expect.objectContaining({
          kind: "godot_exit",
          exitCode: 0,
          signal: null,
          timedOut: false,
        }),
        expect.objectContaining({
          kind: "source_verified",
          phase: "managed",
          candidateSourceHash,
        }),
      ]),
    );
  });

  it("rejects candidate-owned overlay paths before spawning Godot", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "chronorift-lifecycle-collision-"),
    );
    roots.push(root);
    const workspace = join(root, "workspace");
    const runtime = join(root, "runtime");
    await Promise.all([mkdir(workspace), mkdir(runtime)]);
    await Promise.all([
      writeFile(join(workspace, "project.godot"), "[application]\n"),
      writeFile(join(workspace, "override.cfg"), "candidate controlled\n"),
    ]);
    const source = createLifecycleVanillaSmokeSidecarSource({
      godotExecutable: process.execPath,
      workspaceRoot: workspace,
      runtimeRoot: runtime,
    });
    const sidecar = spawn(
      process.execPath,
      ["--input-type=commonjs", "--eval", source],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    const stderr: Buffer[] = [];
    sidecar.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    sidecar.stdin.end(
      encodeWireFrame(
        JSON.stringify({
          ...commonLaunch("b".repeat(64)),
          operation: "vanilla_smoke",
          importTimeoutMs: 5_000,
          vanillaTimeoutMs: 5_000,
          stabilityWindowMs: 2_000,
        }),
      ),
    );

    await expect(waitForExit(sidecar)).resolves.toEqual({
      code: 1,
      signal: null,
    });
    expect(
      decode(Buffer.concat(stderr), (value) =>
        GodotLifecycleVanillaSmokeDiagnosticV1Schema.parse(value),
      ),
    ).toContainEqual(
      expect.objectContaining({
        kind: "sidecar_error",
        code: "MANAGED_RUNTIME_COLLISION",
      }),
    );
  });

  it("fails vanilla smoke if the managed overlay is physically visible", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "chronorift-vanilla-visible-overlay-"),
    );
    roots.push(root);
    const workspace = join(root, "workspace");
    const runtime = join(root, "runtime");
    await Promise.all([
      mkdir(workspace),
      mkdir(join(runtime, "overlay"), { recursive: true }),
    ]);
    await writeFile(join(workspace, "project.godot"), "[application]\n");
    const source = createLifecycleVanillaSmokeSidecarSource({
      godotExecutable: join(root, "must-not-be-spawned"),
      workspaceRoot: workspace,
      runtimeRoot: runtime,
    });
    const sidecar = spawn(
      process.execPath,
      ["--input-type=commonjs", "--eval", source],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    const stderr: Buffer[] = [];
    sidecar.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    sidecar.stdin.end(
      encodeWireFrame(
        JSON.stringify({
          ...commonLaunch("b".repeat(64)),
          operation: "vanilla_smoke",
          importTimeoutMs: 5_000,
          vanillaTimeoutMs: 5_000,
          stabilityWindowMs: 2_000,
        }),
      ),
    );

    await expect(waitForExit(sidecar)).resolves.toEqual({
      code: 1,
      signal: null,
    });
    expect(
      decode(Buffer.concat(stderr), (value) =>
        GodotLifecycleVanillaSmokeDiagnosticV1Schema.parse(value),
      ),
    ).toContainEqual(
      expect.objectContaining({
        kind: "sidecar_error",
        code: "MANAGED_RUNTIME_COLLISION",
      }),
    );
  });

  it.each([
    {
      label: "case-folded addons root",
      relativeDirectory: "Addons",
      relativeFile: "Addons/plugin.gd",
      expectedCode: "MANAGED_RUNTIME_COLLISION",
    },
    {
      label: "case-folded ChronoRift root",
      relativeDirectory: ".ChronoRift",
      relativeFile: ".ChronoRift/state.json",
      expectedCode: "MANAGED_RUNTIME_COLLISION",
    },
    {
      label: "native extension suffix",
      relativeDirectory: null,
      relativeFile: "bridge.SO",
      expectedCode: "UNSUPPORTED_SOURCE_FEATURE",
    },
  ])(
    "rejects $label before spawning Godot",
    async ({ relativeDirectory, relativeFile, expectedCode }) => {
      const root = await mkdtemp(
        join(tmpdir(), "chronorift-lifecycle-source-policy-"),
      );
      roots.push(root);
      const workspace = join(root, "workspace");
      const runtime = join(root, "runtime");
      await Promise.all([mkdir(workspace), mkdir(runtime)]);
      if (relativeDirectory !== null) {
        await mkdir(join(workspace, relativeDirectory));
      }
      await Promise.all([
        writeFile(join(workspace, "project.godot"), "[application]\n"),
        writeFile(join(workspace, relativeFile), "candidate controlled\n"),
      ]);
      const source = createLifecycleVanillaSmokeSidecarSource({
        godotExecutable: join(root, "must-not-be-spawned"),
        workspaceRoot: workspace,
        runtimeRoot: runtime,
      });
      const sidecar = spawn(
        process.execPath,
        ["--input-type=commonjs", "--eval", source],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      const stderr: Buffer[] = [];
      sidecar.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      sidecar.stdin.end(
        encodeWireFrame(
          JSON.stringify({
            ...commonLaunch("b".repeat(64)),
            operation: "vanilla_smoke",
            importTimeoutMs: 5_000,
            vanillaTimeoutMs: 5_000,
            stabilityWindowMs: 2_000,
          }),
        ),
      );

      await expect(waitForExit(sidecar)).resolves.toEqual({
        code: 1,
        signal: null,
      });
      expect(
        decode(Buffer.concat(stderr), (value) =>
          GodotLifecycleVanillaSmokeDiagnosticV1Schema.parse(value),
        ),
      ).toContainEqual(
        expect.objectContaining({
          kind: "sidecar_error",
          code: expectedCode,
        }),
      );
    },
  );
});
