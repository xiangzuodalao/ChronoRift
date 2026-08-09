import { describe, expect, it } from "vitest";

import {
  asPatchId,
  asSha256DigestV1,
  asTaskId,
  type JsonValue,
} from "@chronorift/domain";
import { contentHash } from "@chronorift/json-artifacts";

import {
  FixtureManifestV1Schema,
  M1TaskEventV1Schema,
  PatchExportEventV1Schema,
  PatchExportReceiptV1Schema,
  SandboxBwrapCapabilityV1Schema,
  SandboxExecutionReceiptV1Schema,
  SandboxExecutionRequestV1Schema,
  SecurityEventV1Schema,
  TaskFixtureCapabilityContentV1Schema,
  TaskFixtureCapabilityV1Schema,
  WorkspaceMaterializationReceiptV1Schema,
} from "./contracts.js";
import { sanitizeM1Diagnostic } from "./errors.js";

const digest = asSha256DigestV1("a".repeat(64));

const fixtureControls = {
  fixedFps: { default: 120, allowed: [60, 120] },
  physicsTicksPerSecond: { default: 60, allowed: [60, 120] },
  maxTicks: { default: 10, minimum: 1, maximum: 600 },
} as const;

describe("M1 contracts", () => {
  it("redacts Host paths, credentials, and control characters", () => {
    const checkout = "/home/user/private/project";
    const runtime = "/var/lib/chronorift/tasks/private";
    const token = "fake-provider-token";
    const sanitized = sanitizeM1Diagnostic(
      `at ${checkout} in ${runtime}\nAUTH_TOKEN=${token} https://user:pass@example.test/x\u0000`,
      [checkout, runtime, token],
    );
    expect(sanitized).not.toContain(checkout);
    expect(sanitized).not.toContain(runtime);
    expect(sanitized).not.toContain(token);
    expect(sanitized).not.toContain("user:pass");
    expect(sanitized).not.toContain("\u0000");
    expect(
      Buffer.byteLength(sanitizeM1Diagnostic("界".repeat(2_000), [])),
    ).toBeLessThanOrEqual(4096);
  });

  it("rejects tool versions that could persist Host paths or multiline data", () => {
    const capability = {
      identity: digest,
      version: "bubblewrap 1.0",
      features: ["block-fd", "json-status-fd", "bind-fd", "ro-bind-fd"],
    } as const;
    expect(SandboxBwrapCapabilityV1Schema.parse(capability).version).toBe(
      "bubblewrap 1.0",
    );
    expect(
      SandboxBwrapCapabilityV1Schema.parse({
        ...capability,
        features: [...capability.features, "remount-ro"],
      }).features,
    ).toEqual([...capability.features, "remount-ro"]);
    expect(() =>
      SandboxBwrapCapabilityV1Schema.parse({
        ...capability,
        features: ["block-fd", "json-status-fd", "bind-fd"],
      }),
    ).toThrow();
    expect(() =>
      SandboxBwrapCapabilityV1Schema.parse({
        ...capability,
        version: "bubblewrap from /opt/private/bin",
      }),
    ).toThrow(/path separators/u);
    expect(() =>
      SandboxBwrapCapabilityV1Schema.parse({
        ...capability,
        version: "bubblewrap 1.0\nsecret",
      }),
    ).toThrow(/printable ASCII line/u);
  });

  it("rejects Host paths and unknown request fields", () => {
    expect(() =>
      SandboxExecutionRequestV1Schema.parse({
        schemaVersion: 1,
        operationId: "operation_1",
        profile: "coding-default",
        argv: ["/bin/busybox", "true"],
        cwd: "/workspace",
        environment: {},
        hostWorkspace: "/home/user/project",
      }),
    ).toThrow();
    expect(() =>
      SandboxExecutionRequestV1Schema.parse({
        schemaVersion: 1,
        operationId: "operation_1",
        profile: "coding-default",
        argv: ["/bin/busybox", "true"],
        cwd: "/workspace",
        environment: {},
        timeoutMs: undefined,
      }),
    ).toThrow(/omitted/u);
    expect(() =>
      SandboxExecutionRequestV1Schema.parse({
        schemaVersion: 1,
        operationId: "operation_1",
        profile: "coding-default",
        argv: ["/bin/busybox", "true"],
        cwd: "/workspace",
        environment: {},
        stdin: {
          byteLength: 16 * 1024 * 1024 + 1,
          sha256: digest,
        },
      }),
    ).toThrow();
    expect(() =>
      SandboxExecutionRequestV1Schema.parse({
        schemaVersion: 1,
        operationId: "operation_1",
        profile: "coding-default",
        argv: ["/bin/busybox", "true"],
        cwd: "/workspace",
        environment: {},
        stdin: undefined,
      }),
    ).toThrow(/omitted/u);
    expect(() =>
      SandboxExecutionRequestV1Schema.parse({
        schemaVersion: 1,
        operationId: "operation_1",
        profile: "coding-default",
        argv: ["/bin/busybox", "bad\0argument"],
        cwd: "/workspace",
        environment: {},
      }),
    ).toThrow(/NUL/u);
    expect(() =>
      SandboxExecutionRequestV1Schema.parse({
        schemaVersion: 1,
        operationId: "operation_1",
        profile: "coding-default",
        argv: ["/bin/busybox", "x".repeat(256 * 1024 + 1)],
        cwd: "/workspace",
        environment: {},
      }),
    ).toThrow();
  });

  it("distinguishes a pre-spawn denial from command failure", () => {
    expect(
      SecurityEventV1Schema.parse({
        schemaVersion: 1,
        eventId: "security_1",
        taskId: "task_1",
        operationId: "operation_1",
        decision: "denied",
        code: "capability_denied",
        message: "executable is not allowed",
        occurredAt: "2026-08-06T00:00:00.000Z",
        target: "/bin/curl",
        sideEffectStarted: false,
      }).sideEffectStarted,
    ).toBe(false);
  });

  it("freezes exact fixture controls and validates capability content hashes", () => {
    const manifest = FixtureManifestV1Schema.parse({
      schemaVersion: 1,
      fixtureId: "frame-input-window",
      engine: "godot",
      projectFile: "project.godot",
      startupScene: "res://frame_input_window.tscn",
      protocolVersion: 2,
      runtimeProfile: "chronorift-godot-protocol-v2",
      inputActions: ["attempt_jump"],
      controls: fixtureControls,
      ignoredCachePaths: [".godot"],
    });
    expect(manifest.controls.fixedFps.allowed).toEqual([60, 120]);
    expect(() =>
      FixtureManifestV1Schema.parse({
        ...manifest,
        controls: {
          ...manifest.controls,
          fixedFps: { default: 120, allowed: [60, 120, 240] },
        },
      }),
    ).toThrow();

    const content = TaskFixtureCapabilityContentV1Schema.parse({
      schemaVersion: 1,
      fixtureId: "frame-input-window",
      trustedManifestSha256: digest,
      baselineSelectedTreeSha256: digest,
      startupScene: "res://frame_input_window.tscn",
      protocolVersion: 2,
      runtimeProfile: "chronorift-godot-protocol-v2",
      inputActions: ["attempt_jump"],
      controls: fixtureControls,
      ignoredCachePaths: [".godot"],
    });
    const capabilitySha256 = asSha256DigestV1(
      contentHash(content as unknown as JsonValue),
    );
    expect(
      TaskFixtureCapabilityV1Schema.parse({ ...content, capabilitySha256 }),
    ).toMatchObject({ capabilitySha256 });
    expect(() =>
      TaskFixtureCapabilityV1Schema.parse({
        ...content,
        baselineSelectedTreeSha256: asSha256DigestV1("b".repeat(64)),
        capabilitySha256,
      }),
    ).toThrow(/capabilitySha256/u);
  });

  it("rejects unsafe export paths and malformed Git identities", () => {
    expect(() =>
      PatchExportReceiptV1Schema.parse({
        schemaVersion: 1,
        taskId: asTaskId("task_1"),
        patchId: asPatchId(`patch:v1:${digest}`),
        patchSha256: digest,
        outputPath: "../candidate.diff",
        byteLength: 1,
        exportedAt: "2026-08-06T00:00:00.000Z",
        status: "completed",
      }),
    ).toThrow(/outputPath/u);

    const workspaceReceipt = {
      schemaVersion: 1,
      taskId: asTaskId("task_1"),
      repositoryIdentity: digest,
      sourceRevision: "b".repeat(40),
      projectPrefix: "fixtures/godot-frame-input-window",
      selectedTreeSha256: digest,
      agentBaselineCommit: "c".repeat(40),
      hostBaselineCommit: "d".repeat(40),
      copyRule: "git-object-plumbing-v1",
      excludedCachePaths: [".godot"],
      fixtureCapabilitySha256: digest,
    } as const;
    expect(
      WorkspaceMaterializationReceiptV1Schema.parse(workspaceReceipt)
        .projectPrefix,
    ).toBe("fixtures/godot-frame-input-window");
    expect(() =>
      WorkspaceMaterializationReceiptV1Schema.parse({
        ...workspaceReceipt,
        sourceRevision: "HEAD",
      }),
    ).toThrow();
    expect(() =>
      WorkspaceMaterializationReceiptV1Schema.parse({
        ...workspaceReceipt,
        projectPrefix: "fixtures/../secret",
      }),
    ).toThrow(/projectPrefix/u);
  });

  it("checks stream accounting and monotonic execution order", () => {
    const request = {
      schemaVersion: 1,
      operationId: "operation_1",
      profile: "coding-default",
      argv: ["/bin/busybox", "true"],
      cwd: "/workspace",
      environment: {},
    } as const;
    const receipt = {
      schemaVersion: 1,
      taskId: asTaskId("task_1"),
      operationId: "operation_1",
      policyId: `sandbox-policy:v1:${digest}`,
      sandboxCapabilitySha256: digest,
      sandboxBackend: "bwrap-direct-cgroup-v2",
      status: "succeeded",
      requested: request,
      realizedResources: {
        cpuMax: "200000 100000",
        memoryMaxBytes: 2_147_483_648,
        memorySwapMaxBytes: 0,
        pidsMax: 128,
        nofile: 1024,
        fileSizeMaxBytes: 536_870_912,
        stdoutMaxBytes: 16_777_216,
        stderrMaxBytes: 16_777_216,
        timeoutMs: 120_000,
      },
      realizedMechanisms: {
        cpu: "cgroup-v2",
        memory: "cgroup-v2",
        processCount: "cgroup-v2",
        openFiles: "rlimit-nofile",
        fileSize: "rlimit-fsize",
        wallTimeout: "host-monotonic-timer",
        unavailable: [],
      },
      resourceUsage: {
        cpuUsageUsec: 0,
        memoryPeakBytes: null,
        pidsPeak: null,
      },
      stdout: {
        totalBytes: 1,
        capturedBytes: 1,
        sha256: digest,
        capturedSha256: digest,
        truncated: false,
      },
      stderr: {
        totalBytes: 0,
        capturedBytes: 0,
        sha256: digest,
        capturedSha256: digest,
        truncated: false,
      },
      exitCode: 0,
      signal: null,
      startedAtMonotonicMs: 10,
      endedAtMonotonicMs: 11,
      cleanup: {
        processGroupTerminated: true,
        cgroupPopulated: false,
        termSent: false,
        killSent: false,
        scopeRemoved: true,
      },
    } as const;
    const historical = SandboxExecutionReceiptV1Schema.parse(receipt);
    expect(historical.exitCode).toBe(0);
    expect(historical.realizedMechanisms.aggregateStorage).toBeUndefined();
    expect(historical.realizedMechanisms.unavailable).toEqual([]);

    const unavailableAggregateStorage = SandboxExecutionReceiptV1Schema.parse({
      ...receipt,
      realizedMechanisms: {
        ...receipt.realizedMechanisms,
        unavailable: ["aggregate-storage"],
      },
    });
    expect(unavailableAggregateStorage.realizedMechanisms.unavailable).toEqual([
      "aggregate-storage",
    ]);

    const boundedAggregateStorage = SandboxExecutionReceiptV1Schema.parse({
      ...receipt,
      realizedMechanisms: {
        ...receipt.realizedMechanisms,
        aggregateStorage: "dedicated-capacity-bounded-filesystem-v1",
      },
      resourceUsage: {
        ...receipt.resourceUsage,
        aggregateStorage: { usedBytes: 4_096, usedInodes: 12 },
      },
    });
    expect(boundedAggregateStorage.resourceUsage.aggregateStorage).toEqual({
      usedBytes: 4_096,
      usedInodes: 12,
    });
    expect(() =>
      SandboxExecutionReceiptV1Schema.parse({
        ...receipt,
        realizedMechanisms: {
          ...receipt.realizedMechanisms,
          aggregateStorage: "dedicated-capacity-bounded-filesystem-v1",
        },
      }),
    ).toThrow(/aggregate storage usage/iu);
    expect(() =>
      SandboxExecutionReceiptV1Schema.parse({
        ...receipt,
        stdout: { ...receipt.stdout, capturedBytes: 2 },
      }),
    ).toThrow(/capturedBytes/u);
    expect(() =>
      SandboxExecutionReceiptV1Schema.parse({
        ...receipt,
        stdout: {
          ...receipt.stdout,
          totalBytes: 2,
          capturedBytes: 1,
          truncated: false,
        },
      }),
    ).toThrow(/truncated/u);
    expect(() =>
      SandboxExecutionReceiptV1Schema.parse({
        ...receipt,
        stdout: {
          ...receipt.stdout,
          capturedSha256: asSha256DigestV1("b".repeat(64)),
        },
      }),
    ).toThrow(/capturedSha256/u);
    expect(() =>
      SandboxExecutionReceiptV1Schema.parse({
        ...receipt,
        startedAtMonotonicMs: 12,
      }),
    ).toThrow(/startedAtMonotonicMs/u);
    expect(() =>
      SandboxExecutionReceiptV1Schema.parse({
        ...receipt,
        exitCode: 7,
      }),
    ).toThrow(/status/u);
    expect(() =>
      SandboxExecutionReceiptV1Schema.parse({
        ...receipt,
        status: "failed",
        exitCode: 7,
        signal: "SIGTERM",
      }),
    ).toThrow(/status/u);
    expect(() =>
      SandboxExecutionReceiptV1Schema.parse({
        ...receipt,
        cleanup: {
          ...receipt.cleanup,
          cgroupPopulated: true,
        },
      }),
    ).toThrow(/cgroup/u);
  });

  it("validates task and export lineage records without Host paths", () => {
    const taskId = asTaskId("task_1");
    const patchId = asPatchId(`patch:v1:${digest}`);
    expect(
      M1TaskEventV1Schema.parse({
        schemaVersion: 1,
        taskId,
        kind: "ready",
        occurredAt: "2026-08-07T00:00:00.000Z",
        policyId: `sandbox-policy:v1:${digest}`,
        baselineSourceHash: digest,
      }),
    ).toMatchObject({ kind: "ready" });

    const receipt = PatchExportReceiptV1Schema.parse({
      schemaVersion: 1,
      taskId,
      patchId,
      patchSha256: digest,
      outputPath: "candidate.patch",
      byteLength: 1,
      exportedAt: "2026-08-07T00:00:00.000Z",
      status: "completed",
    });
    expect(
      PatchExportEventV1Schema.parse({
        schemaVersion: 1,
        taskId,
        kind: "completed",
        receipt,
        occurredAt: "2026-08-07T00:00:01.000Z",
      }),
    ).toMatchObject({ kind: "completed" });
    expect(() =>
      PatchExportEventV1Schema.parse({
        schemaVersion: 1,
        taskId: asTaskId("other_task"),
        kind: "completed",
        receipt,
        occurredAt: "2026-08-07T00:00:01.000Z",
      }),
    ).toThrow(/taskId/u);
  });

  it("requires persisted failure messages to be sanitized", () => {
    expect(() =>
      M1TaskEventV1Schema.parse({
        schemaVersion: 1,
        taskId: asTaskId("task_1"),
        kind: "setup_failed",
        occurredAt: "2026-08-07T00:00:00.000Z",
        code: "sandbox_preflight_failed",
        message: "AUTH_TOKEN=secret",
      }),
    ).toThrow(/sanitized/u);
  });
});
