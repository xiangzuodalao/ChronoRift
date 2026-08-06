import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  access,
  appendFile,
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
import { promisify } from "node:util";

import {
  asSha256DigestV1,
  asTaskId,
  taskNamespaceDigestV1,
  type JsonValue,
  type TaskId,
} from "@chronorift/domain";
import { VNextTaskStore, contentHash } from "@chronorift/json-artifacts";
import { afterEach, describe, expect, it } from "vitest";

import {
  M1TaskEventV1Schema,
  SandboxExecutionReceiptV1Schema,
  SandboxHostCapabilityV1Schema,
  SandboxOperationRecordV1Schema,
  SecurityEventV1Schema,
  SupportedSandboxPreflightReceiptV1Schema,
  UnsupportedSandboxPreflightReceiptV1Schema,
  type SandboxHostCapabilityV1,
  type SecurityEventV1,
} from "./contracts.js";
import { M1Error } from "./errors.js";
import {
  discardM1Task,
  executeAndRecordM1Command,
  exportM1Patch,
  extractAndPersistM1Patch,
  prepareM1TaskEnvironment,
} from "./m1-task-environment.js";
import { materializePrivateTaskWorkspace } from "./workspace-materializer.js";
import type {
  SandboxExecutionResultV1,
  TaskSandboxBrokerV1,
} from "./sandbox-broker.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const now = "2026-08-07T00:00:00.000Z";
const digest = asSha256DigestV1("a".repeat(64));
const trustedFixtureRoot = join(
  process.cwd(),
  "fixtures/godot-frame-input-window",
);

const capability: SandboxHostCapabilityV1 = SandboxHostCapabilityV1Schema.parse(
  {
    schemaVersion: 1,
    platform: "linux",
    architecture: "x64",
    bwrap: {
      identity: digest,
      version: "bubblewrap test",
      features: ["block-fd", "json-status-fd", "bind-fd", "ro-bind-fd"],
    },
    prlimitIdentity: digest,
    runtimeIdentity: digest,
    delegatedCgroupRootIdentity: digest,
    controllers: ["cpu", "memory", "pids"],
    cgroupNamespaceUnshared: true,
    activeProbeSha256: digest,
  },
);
const capabilitySha256 = asSha256DigestV1(
  contentHash(capability as unknown as JsonValue),
);

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

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
      GIT_AUTHOR_NAME: "ChronoRift Test",
      GIT_AUTHOR_EMAIL: "test@chronorift.invalid",
      GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
      GIT_COMMITTER_NAME: "ChronoRift Test",
      GIT_COMMITTER_EMAIL: "test@chronorift.invalid",
      GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
    },
    encoding: "utf8",
  });
  return result.stdout;
};

const createHarnessRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "chronorift-m1-environment-"));
  roots.push(root);
  return root;
};

const createCleanFixtureRepository = async (root: string): Promise<string> => {
  const project = join(root, "source");
  await mkdir(project);
  await cp(trustedFixtureRoot, project, { recursive: true });
  await git(project, ["init", "--quiet", "--initial-branch=main"]);
  await git(project, ["add", "--all"]);
  await git(project, ["commit", "--quiet", "-m", "fixture"]);
  return project;
};

const supportedPreflight = () =>
  Promise.resolve({
    kind: "supported" as const,
    capability,
    binding: {
      delegatedCgroupRoot: "/test/cgroup",
      bwrapPath: "/test/bwrap",
      prlimitPath: "/test/prlimit",
      busyboxPath: "/test/busybox",
    },
    receipt: SupportedSandboxPreflightReceiptV1Schema.parse({
      schemaVersion: 1,
      status: "supported",
      checkedAt: now,
      capabilitySha256,
      blockers: [],
    }),
  });

const streamReceipt = (bytes: Uint8Array) => ({
  totalBytes: bytes.byteLength,
  capturedBytes: bytes.byteLength,
  sha256: asSha256DigestV1(createHash("sha256").update(bytes).digest("hex")),
  capturedSha256: asSha256DigestV1(
    createHash("sha256").update(bytes).digest("hex"),
  ),
  truncated: false,
});

const createFakeBroker = (input: {
  readonly taskId: TaskId;
  readonly policyId: string;
  readonly cleanup?: () => Promise<{
    readonly processGroupTerminated: boolean;
    readonly cgroupPopulated: boolean;
    readonly termSent: boolean;
    readonly killSent: boolean;
    readonly scopeRemoved: boolean;
  }>;
}): TaskSandboxBrokerV1 => ({
  async execute(request): Promise<SandboxExecutionResultV1> {
    const stdout = Buffer.from("ok\n");
    const stderr = Buffer.alloc(0);
    return {
      kind: "executed",
      receipt: SandboxExecutionReceiptV1Schema.parse({
        schemaVersion: 1,
        taskId: input.taskId,
        operationId: request.operationId,
        policyId: input.policyId,
        sandboxCapabilitySha256: capabilitySha256,
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
          cpuUsageUsec: 1,
          memoryPeakBytes: 2,
          pidsPeak: 1,
        },
        stdout: streamReceipt(stdout),
        stderr: streamReceipt(stderr),
        exitCode: 0,
        signal: null,
        startedAtMonotonicMs: 1,
        endedAtMonotonicMs: 2,
        cleanup: {
          processGroupTerminated: true,
          cgroupPopulated: false,
          termSent: false,
          killSent: false,
          scopeRemoved: true,
        },
      }),
      stdout,
      stderr,
    };
  },
  cleanup:
    input.cleanup ??
    (() =>
      Promise.resolve({
        processGroupTerminated: true,
        cgroupPopulated: false,
        termSent: false,
        killSent: false,
        scopeRemoved: true,
      })),
});

const prepareReadyEnvironment = async (input: {
  readonly root: string;
  readonly taskId: TaskId;
  readonly cleanup?: Parameters<typeof createFakeBroker>[0]["cleanup"];
  readonly storeFactory?: NonNullable<
    Parameters<typeof prepareM1TaskEnvironment>[1]
  >["createStore"];
  readonly brokerFactory?:
    | ((
        taskId: TaskId,
        policyId: string,
        securityEvents: (event: SecurityEventV1) => Promise<void>,
      ) => TaskSandboxBrokerV1)
    | undefined;
}) => {
  const project = await createCleanFixtureRepository(input.root);
  const runtimeRoot = join(input.root, "runtime");
  await mkdir(runtimeRoot);
  const environment = await prepareM1TaskEnvironment(
    {
      taskId: input.taskId,
      projectPath: project,
      trustedFixtureRoot,
      runtimeRoot,
      sandboxHost: {
        delegatedCgroupRoot: "/test/cgroup",
        bwrapPath: "/test/bwrap",
        prlimitPath: "/test/prlimit",
        busyboxPath: "/test/busybox",
      },
    },
    {
      now: () => now,
      preflightSandbox: supportedPreflight,
      assertSandboxBinding: async () => undefined,
      ...(input.storeFactory === undefined
        ? {}
        : { createStore: input.storeFactory }),
      createBroker: async (options) =>
        input.brokerFactory?.(
          options.taskId,
          options.policy.policyId,
          options.securityEvents,
        ) ??
        createFakeBroker({
          taskId: options.taskId,
          policyId: options.policy.policyId,
          ...(input.cleanup === undefined ? {} : { cleanup: input.cleanup }),
        }),
    },
  );
  const taskRoot = join(
    runtimeRoot,
    "tasks",
    taskNamespaceDigestV1(input.taskId),
  );
  return { environment, project, runtimeRoot, taskRoot };
};

describe("internal M1 Task environment", () => {
  it("fails sandbox preflight before source inspection or Task creation", async () => {
    const root = await createHarnessRoot();
    const runtimeRoot = join(root, "runtime");
    await mkdir(runtimeRoot);
    let sourceInspected = false;
    const preparing = prepareM1TaskEnvironment(
      {
        taskId: asTaskId("task_preflight_failure"),
        projectPath: join(root, "missing-source"),
        trustedFixtureRoot,
        runtimeRoot,
        sandboxHost: {
          delegatedCgroupRoot: "/secret/cgroup",
          bwrapPath: "/secret/bwrap",
          prlimitPath: "/secret/prlimit",
          busyboxPath: "/secret/busybox",
        },
      },
      {
        preflightSandbox: async () => ({
          kind: "unsupported",
          receipt: UnsupportedSandboxPreflightReceiptV1Schema.parse({
            schemaVersion: 1,
            status: "unsupported",
            checkedAt: now,
            capabilitySha256: null,
            blockers: [
              {
                code: "sandbox_preflight_failed",
                message: "/secret/cgroup is not delegated",
              },
            ],
          }),
        }),
        preflightSource: async () => {
          sourceInspected = true;
          throw new Error("must not inspect source");
        },
      },
    );
    await expect(preparing).rejects.toMatchObject({
      code: "sandbox_preflight_failed",
      message: "[REDACTED] is not delegated",
    });
    const failure = await preparing.catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(M1Error);
    expect(JSON.stringify((failure as M1Error).storedCause)).not.toContain(
      "/secret",
    );
    expect(JSON.stringify((failure as Error).cause)).not.toContain("/secret");
    expect(sourceInspected).toBe(false);
    await expect(access(join(runtimeRoot, "tasks"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("sanitizes a thrown sandbox preflight failure before returning it", async () => {
    const root = await createHarnessRoot();
    const runtimeRoot = join(root, "runtime");
    await mkdir(runtimeRoot);
    const delegatedCgroupRoot = join(root, "private-cgroup");
    await expect(
      prepareM1TaskEnvironment(
        {
          taskId: asTaskId("task_thrown_preflight_failure"),
          projectPath: join(root, "source"),
          trustedFixtureRoot,
          runtimeRoot,
          sandboxHost: {
            delegatedCgroupRoot,
            bwrapPath: "/test/bwrap",
            prlimitPath: "/test/prlimit",
            busyboxPath: "/test/busybox",
          },
        },
        {
          preflightSandbox: async () => {
            throw new Error(`failed at ${delegatedCgroupRoot}`);
          },
        },
      ),
    ).rejects.toMatchObject({
      code: "sandbox_preflight_failed",
      message: "failed at [REDACTED]",
    });
    await expect(access(join(runtimeRoot, "tasks"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("records execution, verifies a patch, exports once, and discards only its Task", async () => {
    const root = await createHarnessRoot();
    const taskId = asTaskId("task_ready_lifecycle");
    const { environment, project, runtimeRoot, taskRoot } =
      await prepareReadyEnvironment({ root, taskId });
    expect(JSON.stringify(environment)).not.toContain(root);
    expect(Object.isFrozen(environment)).toBe(true);
    expect(Object.isFrozen(environment.sandboxCapability.bwrap)).toBe(true);

    const store = new VNextTaskStore(runtimeRoot);
    await expect(
      store.readJson(taskId, "sandbox-capability.json", (value) =>
        SandboxHostCapabilityV1Schema.parse(value),
      ),
    ).resolves.toEqual(capability);

    await executeAndRecordM1Command(environment, {
      schemaVersion: 1,
      operationId: "operation_true",
      profile: "coding-default",
      argv: ["/bin/busybox", "true"],
      cwd: "/workspace",
      environment: {},
    });
    await expect(
      store.readLedger(taskId, "sandbox-operations.jsonl", (value) =>
        SandboxOperationRecordV1Schema.parse(value),
      ),
    ).resolves.toHaveLength(1);

    await appendFile(
      join(taskRoot, "workspace", "project.godot"),
      "\n# candidate\n",
    );
    const extracted = await extractAndPersistM1Patch(environment);
    expect(extracted.roundTripVerified).toBe(true);
    expect(extracted.identity.patchHash).toBe(
      createHash("sha256").update(extracted.patchBytes).digest("hex"),
    );

    const exportRoot = join(root, "exports");
    await mkdir(exportRoot);
    const mutatedBytes = Uint8Array.from(extracted.patchBytes);
    if (mutatedBytes.byteLength > 0) {
      mutatedBytes[0] = mutatedBytes[0]! ^ 0xff;
    }
    await expect(
      exportM1Patch(
        environment,
        { ...extracted, patchBytes: mutatedBytes },
        { hostCwd: exportRoot, outputPath: "mutated.patch" },
      ),
    ).rejects.toMatchObject({ code: "artifact_write_failed" });
    await expect(
      access(join(exportRoot, "mutated.patch")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    const receipt = await exportM1Patch(environment, extracted, {
      hostCwd: exportRoot,
      outputPath: "candidate.patch",
    });
    expect(await readFile(join(exportRoot, receipt.outputPath))).toEqual(
      Buffer.from(extracted.patchBytes),
    );
    expect(await git(project, ["status", "--porcelain"])).toBe("");

    const nonUtf8WorkspaceEntry = Buffer.concat([
      Buffer.from(`${join(taskRoot, "workspace")}/`, "utf8"),
      Buffer.from([0xff]),
    ]);
    await writeFile(nonUtf8WorkspaceEntry, "disposable\n");

    await discardM1Task(environment);
    await expect(access(taskRoot)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      access(join(exportRoot, "candidate.patch")),
    ).resolves.toBeUndefined();
  });

  it("retains write-once records and removes mutable state after setup failure", async () => {
    const root = await createHarnessRoot();
    const project = await createCleanFixtureRepository(root);
    const runtimeRoot = join(root, "runtime");
    await mkdir(runtimeRoot);
    const taskId = asTaskId("task_setup_failure");
    await expect(
      prepareM1TaskEnvironment(
        {
          taskId,
          projectPath: project,
          trustedFixtureRoot,
          runtimeRoot,
          sandboxHost: {
            delegatedCgroupRoot: "/test/cgroup",
            bwrapPath: "/test/bwrap",
            prlimitPath: "/test/prlimit",
            busyboxPath: "/test/busybox",
          },
        },
        {
          now: () => now,
          preflightSandbox: supportedPreflight,
          assertSandboxBinding: async () => undefined,
          createBroker: async (options) => {
            throw new M1Error(
              "sandbox_launch_failed",
              `${options.layout.taskRootDirectory}/broker failed`,
            );
          },
        },
      ),
    ).rejects.toMatchObject({
      code: "sandbox_launch_failed",
      message: "[REDACTED]/broker failed",
    });

    const taskRoot = join(runtimeRoot, "tasks", taskNamespaceDigestV1(taskId));
    expect(await readdir(taskRoot)).toEqual(["records"]);
    const store = new VNextTaskStore(runtimeRoot);
    const events = await store.readLedger(
      taskId,
      "task-events.jsonl",
      (value) => M1TaskEventV1Schema.parse(value),
    );
    expect(events.map((event) => event.kind)).toEqual([
      "creating",
      "setup_failed",
    ]);
    expect(events.at(-1)).toMatchObject({
      message: "[REDACTED]/broker failed",
    });
    expect(await git(project, ["status", "--porcelain"])).toBe("");
  });

  it("rejects a materialization receipt detached from the verified Task source", async () => {
    const root = await createHarnessRoot();
    const project = await createCleanFixtureRepository(root);
    const runtimeRoot = join(root, "runtime");
    await mkdir(runtimeRoot);
    await expect(
      prepareM1TaskEnvironment(
        {
          taskId: asTaskId("task_forged_materialization"),
          projectPath: project,
          trustedFixtureRoot,
          runtimeRoot,
          sandboxHost: {
            delegatedCgroupRoot: "/test/cgroup",
            bwrapPath: "/test/bwrap",
            prlimitPath: "/test/prlimit",
            busyboxPath: "/test/busybox",
          },
        },
        {
          now: () => now,
          preflightSandbox: supportedPreflight,
          materializeWorkspace: async (request) => {
            const materialized = await materializePrivateTaskWorkspace(request);
            return {
              ...materialized,
              receipt: {
                ...materialized.receipt,
                taskId: asTaskId("task_different_materialization"),
              },
            };
          },
        },
      ),
    ).rejects.toMatchObject({ code: "artifact_write_failed" });
  });

  it("retains the complete Task when sandbox cleanup cannot be proven", async () => {
    const root = await createHarnessRoot();
    const taskId = asTaskId("task_cleanup_unproven");
    let cleanupAttempts = 0;
    const { environment, taskRoot } = await prepareReadyEnvironment({
      root,
      taskId,
      cleanup: async () => {
        cleanupAttempts += 1;
        return cleanupAttempts === 1
          ? {
              processGroupTerminated: false,
              cgroupPopulated: true,
              termSent: true,
              killSent: true,
              scopeRemoved: false,
            }
          : {
              processGroupTerminated: true,
              cgroupPopulated: false,
              termSent: true,
              killSent: true,
              scopeRemoved: true,
            };
      },
    });
    await expect(discardM1Task(environment)).rejects.toMatchObject({
      code: "artifact_write_failed",
    });
    expect(await readdir(taskRoot)).toContain("records");
    await expect(discardM1Task(environment)).resolves.toMatchObject({
      cgroupPopulated: false,
      scopeRemoved: true,
    });
    expect(cleanupAttempts).toBe(2);
    await expect(access(taskRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retries Task-root removal without repeating a completed records discard", async () => {
    const root = await createHarnessRoot();
    const taskId = asTaskId("task_root_removal_retry");
    let storeDiscardAttempts = 0;
    let foreignPath = "";
    const { environment, taskRoot } = await prepareReadyEnvironment({
      root,
      taskId,
      storeFactory: (runtimeRoot) => {
        const backing = new VNextTaskStore(runtimeRoot);
        return {
          create: backing.create.bind(backing),
          putJsonOnce: backing.putJsonOnce.bind(backing),
          readJson: backing.readJson.bind(backing),
          putBytesOnce: backing.putBytesOnce.bind(backing),
          readBytes: backing.readBytes.bind(backing),
          append: backing.append.bind(backing),
          discard: async (discardedTaskId) => {
            storeDiscardAttempts += 1;
            await backing.discard(discardedTaskId);
            foreignPath = join(
              runtimeRoot,
              "tasks",
              taskNamespaceDigestV1(discardedTaskId),
              "foreign-after-records",
            );
            await mkdir(foreignPath);
          },
        };
      },
    });

    await expect(discardM1Task(environment)).rejects.toMatchObject({
      code: "path_denied",
    });
    expect(storeDiscardAttempts).toBe(1);
    await rm(foreignPath, { recursive: true, force: false });
    await expect(discardM1Task(environment)).resolves.toMatchObject({
      scopeRemoved: true,
    });
    expect(storeDiscardAttempts).toBe(1);
    await expect(access(taskRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an execution receipt detached from the requested lineage", async () => {
    const root = await createHarnessRoot();
    const taskId = asTaskId("task_forged_execution_receipt");
    const { environment, runtimeRoot } = await prepareReadyEnvironment({
      root,
      taskId,
      brokerFactory: (createdTaskId, policyId) => {
        const honest = createFakeBroker({
          taskId: createdTaskId,
          policyId,
        });
        return {
          cleanup: () => honest.cleanup(),
          execute: async (request, options) => {
            const result = await honest.execute(request, options);
            if (result.kind !== "executed") return result;
            return {
              ...result,
              receipt: {
                ...result.receipt,
                operationId: "different-operation",
              },
            };
          },
        };
      },
    });
    await expect(
      executeAndRecordM1Command(environment, {
        schemaVersion: 1,
        operationId: "expected-operation",
        profile: "coding-default",
        argv: ["/bin/busybox", "true"],
        cwd: "/workspace",
        environment: {},
      }),
    ).rejects.toMatchObject({ code: "artifact_write_failed" });
    const store = new VNextTaskStore(runtimeRoot);
    await expect(
      store.readLedger(taskId, "sandbox-operations.jsonl", (value) =>
        SandboxOperationRecordV1Schema.parse(value),
      ),
    ).resolves.toEqual([]);
    await discardM1Task(environment);
  });

  it("rejects realized resources detached from the requested frozen profile", async () => {
    const root = await createHarnessRoot();
    const taskId = asTaskId("task_forged_realized_resources");
    const { environment } = await prepareReadyEnvironment({ root, taskId });
    await expect(
      executeAndRecordM1Command(environment, {
        schemaVersion: 1,
        operationId: "operation_custom_timeout",
        profile: "coding-default",
        argv: ["/bin/busybox", "true"],
        cwd: "/workspace",
        environment: {},
        timeoutMs: 1,
      }),
    ).rejects.toMatchObject({ code: "artifact_write_failed" });
    await expect(extractAndPersistM1Patch(environment)).rejects.toMatchObject({
      code: "command_cancelled",
    });
    await discardM1Task(environment);
  });

  it("persists only a matching denial and redacts known Host paths", async () => {
    const root = await createHarnessRoot();
    const taskId = asTaskId("task_security_event_redaction");
    const runtimeRoot = join(root, "runtime");
    const { environment } = await prepareReadyEnvironment({
      root,
      taskId,
      brokerFactory: (createdTaskId, policyId, securityEvents) => {
        const honest = createFakeBroker({ taskId: createdTaskId, policyId });
        return {
          cleanup: () => honest.cleanup(),
          execute: async (request) => {
            const event = SecurityEventV1Schema.parse({
              schemaVersion: 1,
              eventId: "security_host_path",
              taskId: createdTaskId,
              operationId: request.operationId,
              decision: "denied",
              code: "path_denied",
              message: `blocked ${runtimeRoot}`,
              occurredAt: now,
              target: runtimeRoot,
              sideEffectStarted: false,
            });
            await securityEvents(event);
            return { kind: "denied", securityEvent: event };
          },
        };
      },
    });

    const result = await executeAndRecordM1Command(environment, {
      schemaVersion: 1,
      operationId: "operation_host_path_denied",
      profile: "coding-default",
      argv: ["/bin/busybox", "true"],
      cwd: "/workspace",
      environment: {},
    });
    expect(result.kind).toBe("denied");
    expect(JSON.stringify(result)).not.toContain(runtimeRoot);
    const store = new VNextTaskStore(runtimeRoot);
    const events = await store.readLedger(taskId, "security.jsonl", (value) =>
      SecurityEventV1Schema.parse(value),
    );
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain(runtimeRoot);
    await discardM1Task(environment);
  });

  it("rejects a callback event for a different operation without persisting it", async () => {
    const root = await createHarnessRoot();
    const taskId = asTaskId("task_security_wrong_operation");
    const { environment, runtimeRoot } = await prepareReadyEnvironment({
      root,
      taskId,
      brokerFactory: (createdTaskId, policyId, securityEvents) => {
        const honest = createFakeBroker({ taskId: createdTaskId, policyId });
        return {
          cleanup: () => honest.cleanup(),
          execute: async () => {
            await securityEvents(
              SecurityEventV1Schema.parse({
                schemaVersion: 1,
                eventId: "security_wrong_operation",
                taskId: createdTaskId,
                operationId: "operation_not_active",
                decision: "denied",
                code: "capability_denied",
                message: "wrong operation",
                occurredAt: now,
                target: "/bin/busybox",
                sideEffectStarted: false,
              }),
            );
            throw new Error("unreachable");
          },
        };
      },
    });
    await expect(
      executeAndRecordM1Command(environment, {
        schemaVersion: 1,
        operationId: "operation_active_security",
        profile: "coding-default",
        argv: ["/bin/busybox", "true"],
        cwd: "/workspace",
        environment: {},
      }),
    ).rejects.toMatchObject({ code: "artifact_write_failed" });
    const store = new VNextTaskStore(runtimeRoot);
    await expect(
      store.readLedger(taskId, "security.jsonl", (value) =>
        SecurityEventV1Schema.parse(value),
      ),
    ).resolves.toEqual([]);
    await discardM1Task(environment);
  });

  it("rejects callback/result payload drift before appending the denial", async () => {
    const root = await createHarnessRoot();
    const taskId = asTaskId("task_security_payload_drift");
    const { environment, runtimeRoot } = await prepareReadyEnvironment({
      root,
      taskId,
      brokerFactory: (createdTaskId, policyId, securityEvents) => {
        const honest = createFakeBroker({ taskId: createdTaskId, policyId });
        return {
          cleanup: () => honest.cleanup(),
          execute: async (request) => {
            const event = SecurityEventV1Schema.parse({
              schemaVersion: 1,
              eventId: "security_payload_drift",
              taskId: createdTaskId,
              operationId: request.operationId,
              decision: "denied",
              code: "path_denied",
              message: "callback payload",
              occurredAt: now,
              target: "/workspace/a",
              sideEffectStarted: false,
            });
            await securityEvents(event);
            return {
              kind: "denied",
              securityEvent: { ...event, message: "different result payload" },
            };
          },
        };
      },
    });
    await expect(
      executeAndRecordM1Command(environment, {
        schemaVersion: 1,
        operationId: "operation_payload_drift",
        profile: "coding-default",
        argv: ["/bin/busybox", "true"],
        cwd: "/workspace",
        environment: {},
      }),
    ).rejects.toMatchObject({ code: "artifact_write_failed" });
    const store = new VNextTaskStore(runtimeRoot);
    await expect(
      store.readLedger(taskId, "security.jsonl", (value) =>
        SecurityEventV1Schema.parse(value),
      ),
    ).resolves.toEqual([]);
    await discardM1Task(environment);
  });

  it("records an execution with unproven cleanup and then closes the Task gate", async () => {
    const root = await createHarnessRoot();
    const taskId = asTaskId("task_execution_cleanup_unproven");
    const { environment, runtimeRoot } = await prepareReadyEnvironment({
      root,
      taskId,
      brokerFactory: (createdTaskId, policyId) => {
        const honest = createFakeBroker({ taskId: createdTaskId, policyId });
        return {
          cleanup: () => honest.cleanup(),
          execute: async (request, options) => {
            const result = await honest.execute(request, options);
            if (result.kind !== "executed") return result;
            return {
              ...result,
              receipt: {
                ...result.receipt,
                cleanup: {
                  processGroupTerminated: false,
                  cgroupPopulated: true,
                  termSent: true,
                  killSent: true,
                  scopeRemoved: false,
                },
              },
            };
          },
        };
      },
    });

    await expect(
      executeAndRecordM1Command(environment, {
        schemaVersion: 1,
        operationId: "operation_unproven_cleanup",
        profile: "coding-default",
        argv: ["/bin/busybox", "true"],
        cwd: "/workspace",
        environment: {},
      }),
    ).resolves.toMatchObject({ kind: "executed" });
    const store = new VNextTaskStore(runtimeRoot);
    await expect(
      store.readLedger(taskId, "sandbox-operations.jsonl", (value) =>
        SandboxOperationRecordV1Schema.parse(value),
      ),
    ).resolves.toHaveLength(1);
    await expect(extractAndPersistM1Patch(environment)).rejects.toMatchObject({
      code: "command_cancelled",
    });
    await discardM1Task(environment);
  });

  it("closes the Task gate when the broker rejects after invocation", async () => {
    const root = await createHarnessRoot();
    const taskId = asTaskId("task_broker_rejected");
    const { environment } = await prepareReadyEnvironment({
      root,
      taskId,
      brokerFactory: (createdTaskId, policyId) => {
        const honest = createFakeBroker({ taskId: createdTaskId, policyId });
        return {
          cleanup: () => honest.cleanup(),
          execute: async () => {
            throw new Error("broker outcome is uncertain");
          },
        };
      },
    });
    await expect(
      executeAndRecordM1Command(environment, {
        schemaVersion: 1,
        operationId: "operation_broker_rejected",
        profile: "coding-default",
        argv: ["/bin/busybox", "true"],
        cwd: "/workspace",
        environment: {},
      }),
    ).rejects.toMatchObject({ code: "artifact_write_failed" });
    await expect(extractAndPersistM1Patch(environment)).rejects.toMatchObject({
      code: "command_cancelled",
    });
    await discardM1Task(environment);
  });

  it("cancels queued work, drains the active receipt, then discards", async () => {
    const root = await createHarnessRoot();
    const taskId = asTaskId("task_concurrent_discard");
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolvePromise) => {
      resolveStarted = resolvePromise;
    });
    let resolveExecution!:
      ((result: SandboxExecutionResultV1) => void) | undefined;
    let capturedRequest:
      Parameters<TaskSandboxBrokerV1["execute"]>[0] | undefined;
    let brokerTaskId: TaskId | undefined;
    let brokerPolicyId: string | undefined;
    const { environment, taskRoot } = await prepareReadyEnvironment({
      root,
      taskId,
      brokerFactory: (createdTaskId, policyId) => {
        brokerTaskId = createdTaskId;
        brokerPolicyId = policyId;
        return {
          execute: (request) => {
            capturedRequest = request;
            resolveStarted();
            return new Promise((resolvePromise) => {
              resolveExecution = resolvePromise;
            });
          },
          cleanup: async () => {
            if (
              capturedRequest === undefined ||
              brokerTaskId === undefined ||
              brokerPolicyId === undefined ||
              resolveExecution === undefined
            ) {
              throw new Error("active fake execution was not captured");
            }
            resolveExecution(
              await createFakeBroker({
                taskId: brokerTaskId,
                policyId: brokerPolicyId,
              }).execute(capturedRequest),
            );
            return {
              processGroupTerminated: true,
              cgroupPopulated: false,
              termSent: true,
              killSent: true,
              scopeRemoved: true,
            };
          },
        };
      },
    });

    const active = executeAndRecordM1Command(environment, {
      schemaVersion: 1,
      operationId: "operation_active",
      profile: "coding-default",
      argv: ["/bin/busybox", "true"],
      cwd: "/workspace",
      environment: {},
    });
    await started;
    const queuedPatch = extractAndPersistM1Patch(environment);
    const discarded = discardM1Task(environment);

    await expect(active).resolves.toMatchObject({ kind: "executed" });
    await expect(queuedPatch).rejects.toMatchObject({
      code: "command_cancelled",
    });
    await expect(discarded).resolves.toMatchObject({
      cgroupPopulated: false,
      scopeRemoved: true,
    });
    await expect(access(taskRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
