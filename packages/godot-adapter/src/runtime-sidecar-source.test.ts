import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  RuntimeSidecarDiagnosticV1Schema,
  RuntimeSidecarLaunchV1Schema,
  WireFrameDecoder,
  encodeWireFrame,
} from "@chronorift/godot-protocol";

import { fingerprintGodotSourceTrees } from "./fixture.js";
import { createRuntimeSidecarSource } from "./runtime-sidecar-source.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

const digest = (value: Uint8Array | string): string =>
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

const waitForExit = (
  child: ReturnType<typeof spawn>,
): Promise<{ readonly code: number | null; readonly signal: string | null }> =>
  new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });

const decodeDiagnostics = (
  bytes: Uint8Array,
): readonly ReturnType<typeof RuntimeSidecarDiagnosticV1Schema.parse>[] => {
  const decoder = new WireFrameDecoder();
  const records = decoder
    .push(bytes)
    .map((json) => RuntimeSidecarDiagnosticV1Schema.parse(JSON.parse(json)));
  decoder.end();
  return records;
};

describe("runtime sidecar source", () => {
  it("stages an immutable candidate around the mounted managed addon and relays bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "chronorift-sidecar-"));
    roots.push(root);
    const workspace = join(root, "workspace");
    const runtime = join(root, "runtime");
    const addon = join(runtime, "project", "addons", "chronorift");
    await Promise.all([mkdir(workspace), mkdir(addon, { recursive: true })]);
    const projectBytes = Buffer.from("[application]\n");
    const sceneBytes = Buffer.from("extends Node\n");
    await writeFile(join(workspace, "project.godot"), projectBytes);
    await writeFile(join(workspace, "scene.gd"), sceneBytes);
    await writeFile(join(addon, "chrono_probe.gd"), "extends Node\n");
    const fingerprint = await fingerprintGodotSourceTrees({
      fixtureSource: workspace,
      addonSource: addon,
    });
    const fakeGodot = join(root, "fake-godot.cjs");
    await writeFile(
      fakeGodot,
      [
        'const net = require("node:net");',
        "process.stdout.write(Buffer.alloc(100000, 0x78));",
        "const socket = net.connect(Number(process.env.CHRONORIFT_PORT), process.env.CHRONORIFT_HOST);",
        'socket.on("data", (chunk) => socket.write(chunk));',
        'socket.on("end", () => { socket.end(); process.exitCode = 0; });',
      ].join("\n"),
    );
    const source = createRuntimeSidecarSource({
      godotExecutable: process.execPath,
      godotArgsPrefix: [fakeGodot],
      workspaceRoot: workspace,
      runtimeRoot: runtime,
    });
    expect(source).not.toContain("a".repeat(64));
    expect(source).toContain('PATH: "/usr/bin:/bin"');
    expect(source).toContain(
      'FONTCONFIG_FILE: "/opt/chronorift/etc/fontconfig/fonts.conf"',
    );
    expect(source).not.toContain("process.env.PATH");
    const sidecar = spawn(
      process.execPath,
      ["--input-type=commonjs", "--eval", source],
      {
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    sidecar.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    sidecar.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    const launch = RuntimeSidecarLaunchV1Schema.parse({
      schemaVersion: 1,
      taskId: `t${"a".repeat(255)}`,
      buildId: "build:test",
      runtimeId: "runtime:test",
      executionId: "execution:test",
      candidateSourceHash: selectedTreeDigest([
        {
          relativePath: "project.godot",
          mode: "100644",
          bytes: projectBytes,
        },
        { relativePath: "scene.gd", mode: "100644", bytes: sceneBytes },
      ]),
      fixtureHash: fingerprint.fixtureHash,
      projectHash: fingerprint.projectHash,
      addonHash: fingerprint.addonHash,
      protocolVersion: 2,
      token: "a".repeat(64),
      fixedFps: 120,
      physicsTicksPerSecond: 60,
      fixtureControls: {},
      startupTimeoutMs: 5_000,
      executionTimeoutMs: 10_000,
      diagnosticFrameMaxBytes: 65_536,
      diagnosticTotalMaxBytes: 1024 * 1024,
      diagnosticMaxCount: 128,
    });
    const payload = Buffer.from("godot-wire-bytes");
    sidecar.stdin.write(
      Buffer.concat([encodeWireFrame(JSON.stringify(launch)), payload]),
    );
    await new Promise<void>((resolveEcho, rejectEcho) => {
      const timer = setTimeout(
        () => rejectEcho(new Error("sidecar echo timed out")),
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
    const diagnostics = decodeDiagnostics(Buffer.concat(stderr));
    expect(diagnostics.map(({ kind }) => kind)).toEqual(
      expect.arrayContaining([
        "stage_ready",
        "godot_started",
        "godot_stdout",
        "godot_exit",
      ]),
    );
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ kind: "godot_stdout", truncated: true }),
    );
    await expect(
      readFile(
        join(runtime, "project", "addons", "chronorift", "chrono_probe.gd"),
        "utf8",
      ),
    ).resolves.toBe("extends Node\n");
  });

  it("emits a source-bound process failure fact instead of trusting candidate stderr text", async () => {
    const root = await mkdtemp(join(tmpdir(), "chronorift-sidecar-failure-"));
    roots.push(root);
    const workspace = join(root, "workspace");
    const runtime = join(root, "runtime");
    const addon = join(runtime, "project", "addons", "chronorift");
    await Promise.all([mkdir(workspace), mkdir(addon, { recursive: true })]);
    const projectBytes = Buffer.from("[application]\n");
    const addonBytes = Buffer.from("extends Node\n");
    await Promise.all([
      writeFile(join(workspace, "project.godot"), projectBytes),
      writeFile(join(addon, "probe.gd"), addonBytes),
    ]);
    const fingerprint = await fingerprintGodotSourceTrees({
      fixtureSource: workspace,
      addonSource: addon,
    });
    const fakeGodot = join(root, "candidate-exit.cjs");
    await writeFile(
      fakeGodot,
      [
        'const net = require("node:net");',
        "const socket = net.connect(Number(process.env.CHRONORIFT_PORT), process.env.CHRONORIFT_HOST);",
        'socket.on("connect", () => {',
        '  process.stderr.write("SCRIPT ERROR: candidate-controlled text\\n");',
        "  socket.end();",
        "  process.exitCode = 7;",
        "});",
      ].join("\n"),
    );
    const candidateSourceHash = selectedTreeDigest([
      {
        relativePath: "project.godot",
        mode: "100644",
        bytes: projectBytes,
      },
    ]);
    const source = createRuntimeSidecarSource({
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
    sidecar.stdin.end(
      encodeWireFrame(
        JSON.stringify(
          RuntimeSidecarLaunchV1Schema.parse({
            schemaVersion: 1,
            taskId: "task:test",
            buildId: "build:test",
            runtimeId: "runtime:test",
            executionId: "execution:test",
            candidateSourceHash,
            fixtureHash: fingerprint.fixtureHash,
            projectHash: fingerprint.projectHash,
            addonHash: fingerprint.addonHash,
            protocolVersion: 2,
            token: "e".repeat(64),
            fixedFps: 120,
            physicsTicksPerSecond: 60,
            fixtureControls: {},
            startupTimeoutMs: 5_000,
            executionTimeoutMs: 10_000,
            diagnosticFrameMaxBytes: 65_536,
            diagnosticTotalMaxBytes: 1024 * 1024,
            diagnosticMaxCount: 128,
          }),
        ),
      ),
    );
    await expect(waitForExit(sidecar)).resolves.toEqual({
      code: 1,
      signal: null,
    });
    const diagnostics = decodeDiagnostics(Buffer.concat(stderr));
    expect(diagnostics).toContainEqual({
      schemaVersion: 1,
      kind: "candidate_process_failure",
      candidateSourceHash,
      phase: "runtime_connected",
      reason: "nonzero_exit",
      exitCode: 7,
    });
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        kind: "godot_stderr",
      }),
    );
  });

  it("reserves a terminal frame so a sidecar diagnostic overflow remains observable", async () => {
    const root = await mkdtemp(join(tmpdir(), "chronorift-sidecar-limit-"));
    roots.push(root);
    const workspace = join(root, "workspace");
    const runtime = join(root, "runtime");
    const addon = join(runtime, "project", "addons", "chronorift");
    await Promise.all([mkdir(workspace), mkdir(addon, { recursive: true })]);
    const projectBytes = Buffer.from("[application]\n");
    const addonBytes = Buffer.from("extends Node\n");
    await Promise.all([
      writeFile(join(workspace, "project.godot"), projectBytes),
      writeFile(join(addon, "probe.gd"), addonBytes),
    ]);
    const fingerprint = await fingerprintGodotSourceTrees({
      fixtureSource: workspace,
      addonSource: addon,
    });
    const source = createRuntimeSidecarSource({
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
        JSON.stringify(
          RuntimeSidecarLaunchV1Schema.parse({
            schemaVersion: 1,
            taskId: "task:test",
            buildId: "build:test",
            runtimeId: "runtime:test",
            executionId: "execution:test",
            candidateSourceHash: selectedTreeDigest([
              {
                relativePath: "project.godot",
                mode: "100644",
                bytes: projectBytes,
              },
            ]),
            fixtureHash: fingerprint.fixtureHash,
            projectHash: fingerprint.projectHash,
            addonHash: fingerprint.addonHash,
            protocolVersion: 2,
            token: "d".repeat(64),
            fixedFps: 120,
            physicsTicksPerSecond: 60,
            fixtureControls: {},
            startupTimeoutMs: 5_000,
            executionTimeoutMs: 10_000,
            diagnosticFrameMaxBytes: 1_024,
            diagnosticTotalMaxBytes: 4_096,
            diagnosticMaxCount: 1,
          }),
        ),
      ),
    );
    await expect(waitForExit(sidecar)).resolves.toEqual({
      code: 1,
      signal: null,
    });
    expect(decodeDiagnostics(Buffer.concat(stderr))).toEqual([
      expect.objectContaining({
        kind: "sidecar_error",
        code: "DIAGNOSTIC_LIMIT_EXCEEDED",
      }),
    ]);
  });

  it("fails closed before spawning when any candidate addon could hide the managed mount", async () => {
    const root = await mkdtemp(join(tmpdir(), "chronorift-sidecar-collision-"));
    roots.push(root);
    const workspace = join(root, "workspace");
    const runtime = join(root, "runtime");
    await mkdir(join(workspace, "addons", "third_party"), { recursive: true });
    await mkdir(join(runtime, "project", "addons", "chronorift"), {
      recursive: true,
    });
    await writeFile(join(workspace, "project.godot"), "[application]\n");
    await writeFile(
      join(workspace, "addons", "third_party", "foreign.gd"),
      "bad\n",
    );
    const source = createRuntimeSidecarSource({
      godotExecutable: process.execPath,
      workspaceRoot: workspace,
      runtimeRoot: runtime,
    });
    const sidecar = spawn(
      process.execPath,
      ["--input-type=commonjs", "--eval", source],
      {
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const stderr: Buffer[] = [];
    sidecar.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    const launch = {
      schemaVersion: 1,
      taskId: "task:test",
      buildId: "build:test",
      runtimeId: "runtime:test",
      executionId: "execution:test",
      candidateSourceHash: digest("candidate"),
      fixtureHash: digest("fixture"),
      projectHash: digest("project"),
      addonHash: digest("addon"),
      protocolVersion: 2,
      token: "b".repeat(64),
      fixedFps: 120,
      physicsTicksPerSecond: 60,
      fixtureControls: {},
      startupTimeoutMs: 5_000,
      executionTimeoutMs: 10_000,
      diagnosticFrameMaxBytes: 65_536,
      diagnosticTotalMaxBytes: 1024 * 1024,
      diagnosticMaxCount: 128,
    };
    sidecar.stdin.end(encodeWireFrame(JSON.stringify(launch)));
    await expect(waitForExit(sidecar)).resolves.toEqual({
      code: 1,
      signal: null,
    });
    const diagnostic = decodeDiagnostics(Buffer.concat(stderr))[0];
    expect(diagnostic).toMatchObject({
      kind: "sidecar_error",
      code: "MANAGED_RUNTIME_COLLISION",
    });
  });

  it("fails closed when the Host candidate source identity does not match the staged bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "chronorift-sidecar-identity-"));
    roots.push(root);
    const workspace = join(root, "workspace");
    const runtime = join(root, "runtime");
    const addon = join(runtime, "project", "addons", "chronorift");
    await Promise.all([mkdir(workspace), mkdir(addon, { recursive: true })]);
    await writeFile(join(workspace, "project.godot"), "[application]\n");
    await writeFile(join(addon, "probe.gd"), "extends Node\n");
    const fingerprint = await fingerprintGodotSourceTrees({
      fixtureSource: workspace,
      addonSource: addon,
    });
    const source = createRuntimeSidecarSource({
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
          schemaVersion: 1,
          taskId: "task:test",
          buildId: "build:test",
          runtimeId: "runtime:test",
          executionId: "execution:test",
          candidateSourceHash: digest("not-the-staged-source"),
          fixtureHash: fingerprint.fixtureHash,
          projectHash: fingerprint.projectHash,
          addonHash: fingerprint.addonHash,
          protocolVersion: 2,
          token: "c".repeat(64),
          fixedFps: 120,
          physicsTicksPerSecond: 60,
          fixtureControls: {},
          startupTimeoutMs: 5_000,
          executionTimeoutMs: 10_000,
          diagnosticFrameMaxBytes: 65_536,
          diagnosticTotalMaxBytes: 1024 * 1024,
          diagnosticMaxCount: 128,
        }),
      ),
    );
    await expect(waitForExit(sidecar)).resolves.toEqual({
      code: 1,
      signal: null,
    });
    const diagnostic = decodeDiagnostics(Buffer.concat(stderr))[0];
    expect(diagnostic).toMatchObject({
      kind: "sidecar_error",
      code: "BUILD_IDENTITY_MISMATCH",
    });
  });

  it("does not follow a candidate ancestor replaced by a symlink after inspection", async () => {
    const root = await mkdtemp(join(tmpdir(), "chronorift-sidecar-race-"));
    roots.push(root);
    const workspace = join(root, "workspace");
    const victim = join(workspace, "victim");
    const parked = join(workspace, "victim-parked");
    const outside = join(root, "outside");
    const runtime = join(root, "runtime");
    const addon = join(runtime, "project", "addons", "chronorift");
    await Promise.all([
      mkdir(victim, { recursive: true }),
      mkdir(outside),
      mkdir(addon, { recursive: true }),
    ]);
    const projectBytes = Buffer.from("[application]\n");
    const localBytes = Buffer.from("extends Node\n");
    await Promise.all([
      writeFile(join(workspace, "project.godot"), projectBytes),
      writeFile(join(victim, "local.gd"), localBytes),
      writeFile(join(outside, "host-secret.gd"), "host secret\n"),
      writeFile(join(addon, "probe.gd"), "extends Node\n"),
    ]);
    const fingerprint = await fingerprintGodotSourceTrees({
      fixtureSource: workspace,
      addonSource: addon,
    });
    const source = createRuntimeSidecarSource({
      godotExecutable: process.execPath,
      workspaceRoot: workspace,
      runtimeRoot: runtime,
    });
    const preload = join(root, "swap-after-lstat.cjs");
    await writeFile(
      preload,
      [
        '"use strict";',
        'const fs = require("node:fs");',
        'const fsp = require("node:fs/promises");',
        'const path = require("node:path");',
        "const originalLstat = fsp.lstat.bind(fsp);",
        "let swapped = false;",
        "fsp.lstat = async (...args) => {",
        "  const stat = await originalLstat(...args);",
        '  if (!swapped && path.basename(args[0].toString()) === "victim") {',
        "    swapped = true;",
        "    fs.renameSync(process.env.CHRONORIFT_RACE_SOURCE, process.env.CHRONORIFT_RACE_PARKED);",
        '    fs.symlinkSync(process.env.CHRONORIFT_RACE_OUTSIDE, process.env.CHRONORIFT_RACE_SOURCE, "dir");',
        "  }",
        "  return stat;",
        "};",
      ].join("\n"),
    );
    const sidecar = spawn(
      process.execPath,
      ["--require", preload, "--input-type=commonjs", "--eval", source],
      {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          CHRONORIFT_RACE_SOURCE: victim,
          CHRONORIFT_RACE_PARKED: parked,
          CHRONORIFT_RACE_OUTSIDE: outside,
        },
      },
    );
    const stderr: Buffer[] = [];
    sidecar.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    sidecar.stdin.end(
      encodeWireFrame(
        JSON.stringify({
          schemaVersion: 1,
          taskId: "task:test",
          buildId: "build:test",
          runtimeId: "runtime:test",
          executionId: "execution:test",
          candidateSourceHash: selectedTreeDigest([
            {
              relativePath: "project.godot",
              mode: "100644",
              bytes: projectBytes,
            },
            {
              relativePath: "victim/local.gd",
              mode: "100644",
              bytes: localBytes,
            },
          ]),
          fixtureHash: fingerprint.fixtureHash,
          projectHash: fingerprint.projectHash,
          addonHash: fingerprint.addonHash,
          protocolVersion: 2,
          token: "e".repeat(64),
          fixedFps: 120,
          physicsTicksPerSecond: 60,
          fixtureControls: {},
          startupTimeoutMs: 5_000,
          executionTimeoutMs: 10_000,
          diagnosticFrameMaxBytes: 65_536,
          diagnosticTotalMaxBytes: 1024 * 1024,
          diagnosticMaxCount: 128,
        }),
      ),
    );
    await expect(waitForExit(sidecar)).resolves.toEqual({
      code: 1,
      signal: null,
    });
    expect(decodeDiagnostics(Buffer.concat(stderr))[0]).toMatchObject({
      kind: "sidecar_error",
      code: "INVALID_LAUNCH",
    });
    await expect(readFile(join(parked, "local.gd"), "utf8")).resolves.toBe(
      "extends Node\n",
    );
    await expect(
      readFile(join(runtime, "project", "victim", "host-secret.gd")),
    ).rejects.toThrow();
  });
});
