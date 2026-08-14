import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  access,
  appendFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import {
  asSha256DigestV1,
  asTaskId,
  taskNamespaceDigestV1,
  type JsonValue,
  type Sha256DigestV1,
  type TaskId,
} from "@chronorift/domain";
import {
  DEFAULT_LIFECYCLE_SIDECAR_TARGETS,
  DEFAULT_RUNTIME_SIDECAR_TARGETS,
  DEFAULT_SEMANTIC_SIDECAR_TARGETS,
  createLifecycleRuntimeSidecarSource,
  createLifecycleVanillaSmokeSidecarSource,
  createRuntimeSidecarSource,
  createSemanticRuntimeSidecarSource,
  createSemanticVanillaSmokeSidecarSource,
} from "@chronorift/godot-adapter";
import {
  VNextRuntimeStore,
  VNextTaskStore,
  canonicalJson,
  contentHash,
  runtimeResourceNamespaceDigestV1,
  type TaskLedgerEnvelopeV1,
  type VNextTaskJsonSlot,
  type VNextTaskLedgerSlot,
} from "@chronorift/json-artifacts";
import { afterEach, describe, expect, it } from "vitest";

import {
  M1TaskEventV1Schema,
  SandboxExecutionReceiptV1Schema,
  SandboxHostCapabilityV1Schema,
  SandboxOperationRecordV1Schema,
  SandboxToolchainCapabilityV1Schema,
  SecurityEventV1Schema,
  SupportedSandboxPreflightReceiptV1Schema,
  UnsupportedSandboxPreflightReceiptV1Schema,
  type SandboxHostCapabilityV1,
  type SecurityEventV1,
} from "./contracts.js";
import { M1Error } from "./errors.js";
import {
  discardM1Task,
  createM1ManagedGodotSidecarPort,
  executeAndRecordM1Command,
  exportM1Patch,
  extractAndPersistM1Patch,
  getM1TaskHostContext,
  getM1TaskDuplexSandboxPort,
  getM1TaskGameRuntimeContext,
  getM1TaskExternalGodotRuntimeContext,
  getM1TaskExternalGodotSemanticRuntimeContext,
  prepareM1TaskEnvironment,
  resumeM1TaskEnvironment,
  suspendM1Task,
} from "./m1-task-environment.js";
import { createManagedGodotLifecycleRuntimeV1 } from "./managed-godot-lifecycle-runtime.js";
import { createManagedGodotSemanticRuntimeV1 } from "./managed-godot-semantic-runtime.js";
import { readGodotProjectDescriptorSnapshotV1 } from "./godot-project-descriptor.js";
import { readGodotSemanticAdapterProfileSnapshotV1 } from "./semantic-adapter-profile.js";
import {
  ManagedGodotRuntimeCapabilityV1Schema,
  createManagedGodotRuntimeV1,
} from "./managed-godot-runtime.js";
import { materializePrivateTaskWorkspace } from "./workspace-materializer.js";
import { resolveResourceLimitsV1 } from "./sandbox-policy.js";
import {
  SandboxBrokerSetupCleanupError,
  type DuplexTaskSandboxBrokerV1,
  type SandboxExecutionResultV1,
  type TaskSandboxBrokerV1,
} from "./sandbox-broker.js";
import type { SandboxHostPreflightRequest } from "./sandbox-preflight.js";
import { preflightCleanExternalGodotProject } from "./source-preflight.js";

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
const currentCapability = SandboxHostCapabilityV1Schema.parse({
  ...capability,
  bwrap: {
    ...capability.bwrap,
    features: [
      "block-fd",
      "json-status-fd",
      "bind-fd",
      "ro-bind-fd",
      "remount-ro",
    ],
  },
});
const taskStorageCapability = {
  kind: "dedicated-capacity-bounded-filesystem-v1" as const,
  filesystem: "tmpfs" as const,
  totalBytes: 4_194_304,
  totalInodes: 1_024,
  rootIdentitySha256: digest,
};
const managedSandboxCapability = SandboxHostCapabilityV1Schema.parse({
  ...currentCapability,
  taskStorage: taskStorageCapability,
});
const toolchainContent = {
  schemaVersion: 1 as const,
  files: [{ target: "/bin/bash", sha256: digest, command: true }],
};
const toolchainCapability = SandboxToolchainCapabilityV1Schema.parse({
  ...toolchainContent,
  toolchainId: `sandbox-toolchain:v1:${contentHash(toolchainContent)}`,
});
const managedToolchainContent = {
  schemaVersion: 1 as const,
  files: [
    {
      target: DEFAULT_RUNTIME_SIDECAR_TARGETS.shellExecutable,
      sha256: digest,
      command: false,
    },
    {
      target: "/lib/x86_64-linux-gnu/libfontconfig.so.1",
      sha256: digest,
      command: false,
    },
    {
      target: DEFAULT_RUNTIME_SIDECAR_TARGETS.godotExecutable,
      sha256: digest,
      command: true,
    },
    {
      target: DEFAULT_RUNTIME_SIDECAR_TARGETS.nodeExecutable,
      sha256: digest,
      command: true,
    },
    {
      target: DEFAULT_RUNTIME_SIDECAR_TARGETS.xdgUserDirExecutable,
      sha256: digest,
      command: false,
    },
  ],
};
const managedToolchainCapability = SandboxToolchainCapabilityV1Schema.parse({
  ...managedToolchainContent,
  toolchainId: `sandbox-toolchain:v1:${contentHash(managedToolchainContent)}`,
});
const productionSidecarSource = createRuntimeSidecarSource({
  godotExecutable: DEFAULT_RUNTIME_SIDECAR_TARGETS.godotExecutable,
  workspaceRoot: DEFAULT_RUNTIME_SIDECAR_TARGETS.workspaceRoot,
  runtimeRoot: DEFAULT_RUNTIME_SIDECAR_TARGETS.runtimeRoot,
});
const managedRuntime = createManagedGodotRuntimeV1({
  doctorVersion: "4.7.1.stable.official.a13da4feb",
  nodeTarget: DEFAULT_RUNTIME_SIDECAR_TARGETS.nodeExecutable,
  godotTarget: DEFAULT_RUNTIME_SIDECAR_TARGETS.godotExecutable,
  toolchain: {
    capability: managedToolchainCapability,
    binding: {
      toolchainId: managedToolchainCapability.toolchainId,
      files: [
        {
          target: DEFAULT_RUNTIME_SIDECAR_TARGETS.shellExecutable,
          hostPath: "/trusted/dash",
        },
        {
          target: "/lib/x86_64-linux-gnu/libfontconfig.so.1",
          hostPath: "/trusted/libfontconfig.so.1",
        },
        {
          target: DEFAULT_RUNTIME_SIDECAR_TARGETS.godotExecutable,
          hostPath: "/trusted/godot",
        },
        {
          target: DEFAULT_RUNTIME_SIDECAR_TARGETS.nodeExecutable,
          hostPath: "/trusted/node",
        },
        {
          target: DEFAULT_RUNTIME_SIDECAR_TARGETS.xdgUserDirExecutable,
          hostPath: "/trusted/xdg-user-dir",
        },
      ],
    },
  },
  sidecarSource: productionSidecarSource,
  addonFiles: [
    { relativePath: "plugin.cfg", bytes: Buffer.from("[plugin]\n") },
  ],
});
const managedRuntimeInput = {
  nodePath: "/trusted/node",
  godotPath: "/trusted/godot",
  lddPath: "/trusted/ldd",
  addonRoot: "/trusted/project/addons/chronorift",
  sidecarSource: productionSidecarSource,
} as const;
const lifecycleSidecarOptions = {
  godotExecutable: DEFAULT_LIFECYCLE_SIDECAR_TARGETS.godotExecutable,
  workspaceRoot: DEFAULT_LIFECYCLE_SIDECAR_TARGETS.workspaceRoot,
  runtimeRoot: DEFAULT_LIFECYCLE_SIDECAR_TARGETS.runtimeRoot,
} as const;
const lifecycleVanillaSidecarSource = createLifecycleVanillaSmokeSidecarSource(
  lifecycleSidecarOptions,
);
const lifecycleRuntimeSidecarSource = createLifecycleRuntimeSidecarSource(
  lifecycleSidecarOptions,
);
const managedLifecycleRuntime = createManagedGodotLifecycleRuntimeV1({
  doctorVersion: "4.7.1.stable.official.a13da4feb",
  nodeTarget: DEFAULT_LIFECYCLE_SIDECAR_TARGETS.nodeExecutable,
  godotTarget: DEFAULT_LIFECYCLE_SIDECAR_TARGETS.godotExecutable,
  toolchain: {
    capability: managedToolchainCapability,
    binding: managedRuntime.binding.toolchain,
  },
  vanillaSidecarSource: lifecycleVanillaSidecarSource,
  lifecycleSidecarSource: lifecycleRuntimeSidecarSource,
  addonFiles: [
    {
      relativePath: "lifecycle_probe.gd",
      bytes: Buffer.from("extends Node\n", "utf8"),
    },
  ],
});
const managedLifecycleRuntimeInput = {
  nodePath: "/trusted/node",
  godotPath: "/trusted/godot",
  lddPath: "/trusted/ldd",
  addonRoot: "/trusted/addons/chronorift_lifecycle",
  vanillaSidecarSource: lifecycleVanillaSidecarSource,
  lifecycleSidecarSource: lifecycleRuntimeSidecarSource,
} as const;
const semanticSidecarOptions = {
  godotExecutable: DEFAULT_SEMANTIC_SIDECAR_TARGETS.godotExecutable,
  workspaceRoot: DEFAULT_SEMANTIC_SIDECAR_TARGETS.workspaceRoot,
  runtimeRoot: DEFAULT_SEMANTIC_SIDECAR_TARGETS.runtimeRoot,
} as const;
const semanticVanillaSidecarSource = createSemanticVanillaSmokeSidecarSource(
  semanticSidecarOptions,
);
const semanticRuntimeSidecarSource = createSemanticRuntimeSidecarSource(
  semanticSidecarOptions,
);
const managedSemanticRuntime = createManagedGodotSemanticRuntimeV1({
  doctorVersion: "4.7.1.stable.official.a13da4feb",
  nodeTarget: DEFAULT_SEMANTIC_SIDECAR_TARGETS.nodeExecutable,
  godotTarget: DEFAULT_SEMANTIC_SIDECAR_TARGETS.godotExecutable,
  toolchain: {
    capability: managedToolchainCapability,
    binding: managedRuntime.binding.toolchain,
  },
  vanillaSidecarSource: semanticVanillaSidecarSource,
  semanticSidecarSource: semanticRuntimeSidecarSource,
  addonFiles: [
    {
      relativePath: "semantic_probe.gd",
      bytes: Buffer.from("extends Node\n", "utf8"),
    },
  ],
});
const managedSemanticRuntimeInput = {
  nodePath: "/trusted/node",
  godotPath: "/trusted/godot",
  lddPath: "/trusted/ldd",
  addonRoot: "/trusted/addons/chronorift_semantic",
  vanillaSidecarSource: semanticVanillaSidecarSource,
  semanticSidecarSource: semanticRuntimeSidecarSource,
} as const;

interface TestRuntimeRecord {
  readonly schemaVersion: 1;
  readonly taskId: TaskId;
  readonly label: string;
}

interface TestRuntimeEvent extends TestRuntimeRecord {
  readonly executionId: string;
  readonly sequence: number;
}

const parseTestRuntimeRecord = (input: unknown): TestRuntimeRecord => {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).sort().join("\0") !==
      ["label", "schemaVersion", "taskId"].join("\0") ||
    !("schemaVersion" in input) ||
    input.schemaVersion !== 1 ||
    !("taskId" in input) ||
    typeof input.taskId !== "string" ||
    !("label" in input) ||
    typeof input.label !== "string"
  ) {
    throw new Error("invalid test runtime record");
  }
  return {
    schemaVersion: 1,
    taskId: asTaskId(input.taskId),
    label: input.label,
  };
};

const parseTestRuntimeEvent = (input: unknown): TestRuntimeEvent => {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).sort().join("\0") !==
      ["executionId", "label", "schemaVersion", "sequence", "taskId"].join(
        "\0",
      ) ||
    !("schemaVersion" in input) ||
    input.schemaVersion !== 1 ||
    !("taskId" in input) ||
    typeof input.taskId !== "string" ||
    !("executionId" in input) ||
    typeof input.executionId !== "string" ||
    !("sequence" in input) ||
    typeof input.sequence !== "number" ||
    !Number.isSafeInteger(input.sequence) ||
    input.sequence < 0 ||
    !("label" in input) ||
    typeof input.label !== "string"
  ) {
    throw new Error("invalid test runtime event");
  }
  return {
    schemaVersion: 1,
    taskId: asTaskId(input.taskId),
    executionId: input.executionId,
    sequence: input.sequence,
    label: input.label,
  };
};

class FailingTaskEventStore extends VNextTaskStore {
  public constructor(
    runtimeRoot: string,
    private readonly failedKinds: ReadonlySet<string>,
  ) {
    super(runtimeRoot);
  }

  public override append<T>(
    taskId: TaskId,
    slot: VNextTaskLedgerSlot,
    payload: T,
    parse: (input: unknown) => T,
  ): Promise<TaskLedgerEnvelopeV1> {
    const candidate: unknown = payload;
    if (
      slot === "task-events.jsonl" &&
      candidate !== null &&
      typeof candidate === "object" &&
      "kind" in candidate &&
      typeof candidate.kind === "string" &&
      this.failedKinds.has(candidate.kind)
    ) {
      return Promise.reject(new Error(`failed to append ${candidate.kind}`));
    }
    return super.append(taskId, slot, payload, parse);
  }
}

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

const createCleanExternalRepository = async (
  root: string,
): Promise<{
  readonly project: string;
  readonly descriptorPath: string;
}> => {
  const project = join(root, "source");
  await mkdir(project);
  await cp(trustedFixtureRoot, project, { recursive: true });
  await unlink(join(project, "chronorift.fixture.json"));
  await git(project, ["init", "--quiet", "--initial-branch=main"]);
  await git(project, ["add", "--all"]);
  await git(project, ["commit", "--quiet", "-m", "external"]);
  const descriptorPath = join(root, "external-project.json");
  await writeFile(
    descriptorPath,
    `${JSON.stringify({
      schemaVersion: 1,
      descriptorKind: "chronorift-godot-external-project",
      declaredSourceUrl: "https://github.com/endlessm/moddable-platformer",
      projectFile: "project.godot",
      runtime: {
        engineVersion: "4.7.1-stable (official)",
        scripting: "gdscript",
        renderer: "gl_compatibility",
        executionMode: "headless",
      },
      launch: { scene: "project-main-scene" },
      cache: { ignoredPaths: [".godot"] },
      bridge: { mode: "managed-runtime-overlay", protocolVersion: 1 },
    })}\n`,
  );
  return { project, descriptorPath };
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

const supportedPreflightForCapability = (
  sandboxCapability: SandboxHostCapabilityV1,
  taskStorageRoot?: string,
) =>
  Promise.resolve({
    kind: "supported" as const,
    capability: sandboxCapability,
    binding: {
      delegatedCgroupRoot: "/test/cgroup",
      bwrapPath: "/test/bwrap",
      prlimitPath: "/test/prlimit",
      busyboxPath: "/test/busybox",
      ...(sandboxCapability.taskStorage === undefined
        ? {}
        : { taskStorageRoot }),
    },
    receipt: SupportedSandboxPreflightReceiptV1Schema.parse({
      schemaVersion: 1,
      status: "supported",
      checkedAt: now,
      capabilitySha256: asSha256DigestV1(
        contentHash(sandboxCapability as unknown as JsonValue),
      ),
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
  readonly sandboxCapabilitySha256?: Sha256DigestV1;
  readonly aggregateStorageUsage?:
    { readonly usedBytes: number; readonly usedInodes: number } | undefined;
  readonly cleanup?: () => Promise<{
    readonly processGroupTerminated: boolean;
    readonly cgroupPopulated: boolean;
    readonly termSent: boolean;
    readonly killSent: boolean;
    readonly scopeRemoved: boolean;
  }>;
}): DuplexTaskSandboxBrokerV1 => {
  const execute: DuplexTaskSandboxBrokerV1["execute"] = async (request) => {
    const stdout = Buffer.from("ok\n");
    const stderr = Buffer.alloc(0);
    return {
      kind: "executed",
      receipt: SandboxExecutionReceiptV1Schema.parse({
        schemaVersion: 1,
        taskId: input.taskId,
        operationId: request.operationId,
        policyId: input.policyId,
        sandboxCapabilitySha256:
          input.sandboxCapabilitySha256 ??
          (input.policyId.startsWith("sandbox-policy:v2:")
            ? asSha256DigestV1(
                contentHash(managedSandboxCapability as unknown as JsonValue),
              )
            : capabilitySha256),
        sandboxBackend: "bwrap-direct-cgroup-v2",
        status: "succeeded",
        requested: request,
        realizedResources:
          request.profile === "godot-headless"
            ? resolveResourceLimitsV1(request.profile, request.timeoutMs)
            : resolveResourceLimitsV1(request.profile, undefined),
        realizedMechanisms: {
          cpu: "cgroup-v2",
          memory: "cgroup-v2",
          processCount: "cgroup-v2",
          openFiles: "rlimit-nofile",
          fileSize: "rlimit-fsize",
          wallTimeout: "host-monotonic-timer",
          ...(input.policyId.startsWith("sandbox-policy:v2:")
            ? {
                aggregateStorage:
                  "dedicated-capacity-bounded-filesystem-v1" as const,
                unavailable: [] as const,
              }
            : { unavailable: ["aggregate-storage"] as const }),
        },
        resourceUsage: {
          cpuUsageUsec: 1,
          memoryPeakBytes: 2,
          pidsPeak: 1,
          ...(input.policyId.startsWith("sandbox-policy:v2:")
            ? {
                aggregateStorage: input.aggregateStorageUsage ?? {
                  usedBytes: 4_096,
                  usedInodes: 12,
                },
              }
            : {}),
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
  };
  return {
    execute,
    openDuplex: (request) => execute(request),
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
  };
};

const prepareReadyEnvironment = async (input: {
  readonly root: string;
  readonly taskId: TaskId;
  readonly cleanup?: Parameters<typeof createFakeBroker>[0]["cleanup"];
  readonly storeFactory?: NonNullable<
    Parameters<typeof prepareM1TaskEnvironment>[1]
  >["createStore"];
  readonly runtimeStoreFactory?: NonNullable<
    Parameters<typeof prepareM1TaskEnvironment>[1]
  >["createRuntimeStore"];
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
      ...(input.runtimeStoreFactory === undefined
        ? {}
        : { createRuntimeStore: input.runtimeStoreFactory }),
      createBroker: async (options) => {
        const broker =
          input.brokerFactory?.(
            options.taskId,
            options.policy.policyId,
            options.securityEvents,
          ) ??
          createFakeBroker({
            taskId: options.taskId,
            policyId: options.policy.policyId,
            sandboxCapabilitySha256: asSha256DigestV1(
              contentHash(options.capability as unknown as JsonValue),
            ),
            ...(input.cleanup === undefined ? {} : { cleanup: input.cleanup }),
          });
        const duplex = broker as Partial<DuplexTaskSandboxBrokerV1>;
        return {
          ...broker,
          openDuplex:
            typeof duplex.openDuplex === "function"
              ? duplex.openDuplex.bind(broker)
              : (request, duplexOptions) =>
                  broker.execute(request, duplexOptions),
        };
      },
    },
  );
  const taskRoot = join(
    runtimeRoot,
    "tasks",
    taskNamespaceDigestV1(input.taskId),
  );
  return { environment, project, runtimeRoot, taskRoot };
};

const managedEnvironmentOverrides = (input?: {
  readonly frozenRuntime?: typeof managedRuntime | undefined;
  readonly sandboxCapability?: SandboxHostCapabilityV1 | undefined;
  readonly createBroker?: NonNullable<
    Parameters<typeof prepareM1TaskEnvironment>[1]
  >["createBroker"];
}) => ({
  now: () => now,
  preflightSandbox: (request: SandboxHostPreflightRequest) =>
    supportedPreflightForCapability(
      input?.sandboxCapability ?? managedSandboxCapability,
      request.taskStorageRoot,
    ),
  inspectToolchain: async () => ({
    capability: toolchainCapability,
    binding: {
      toolchainId: toolchainCapability.toolchainId,
      files: [{ target: "/bin/bash", hostPath: "/bin/bash" }],
    },
  }),
  preflightManagedRuntime: async () => input?.frozenRuntime ?? managedRuntime,
  assertSandboxBinding: async () => undefined,
  assertTaskStorageLayout: async () => ({ usedBytes: 0, usedInodes: 0 }),
  createBroker:
    input?.createBroker ??
    (async (options) =>
      createFakeBroker({
        taskId: options.taskId,
        policyId: options.policy.policyId,
        sandboxCapabilitySha256: asSha256DigestV1(
          contentHash(options.capability as unknown as JsonValue),
        ),
      })),
});

const prepareManagedReadyEnvironment = async (input: {
  readonly root: string;
  readonly taskId: TaskId;
  readonly createBroker?: NonNullable<
    Parameters<typeof prepareM1TaskEnvironment>[1]
  >["createBroker"];
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
        taskStorageRoot: input.root,
      },
      sandboxToolchain: {
        lddPath: "/usr/bin/ldd",
        commands: [{ target: "/bin/bash", hostPath: "/bin/bash" }],
      },
      managedGodotRuntime: managedRuntimeInput,
    },
    managedEnvironmentOverrides({
      ...(input.createBroker === undefined
        ? {}
        : { createBroker: input.createBroker }),
    }),
  );
  const taskRoot = join(
    runtimeRoot,
    "tasks",
    taskNamespaceDigestV1(input.taskId),
  );
  return { environment, project, runtimeRoot, taskRoot };
};

const prepareExternalReadyEnvironment = async (input: {
  readonly root: string;
  readonly taskId: TaskId;
}) => {
  const { project, descriptorPath } = await createCleanExternalRepository(
    input.root,
  );
  const descriptorSnapshot =
    await readGodotProjectDescriptorSnapshotV1(descriptorPath);
  const runtimeRoot = join(input.root, "runtime");
  await mkdir(runtimeRoot);
  const environment = await prepareM1TaskEnvironment(
    {
      taskId: input.taskId,
      projectPath: project,
      externalProjectDescriptor: descriptorSnapshot,
      runtimeRoot,
      sandboxHost: {
        delegatedCgroupRoot: "/test/cgroup",
        bwrapPath: "/test/bwrap",
        prlimitPath: "/test/prlimit",
        busyboxPath: "/test/busybox",
        taskStorageRoot: input.root,
      },
      sandboxToolchain: {
        lddPath: "/usr/bin/ldd",
        commands: [{ target: "/bin/bash", hostPath: "/bin/bash" }],
      },
      managedGodotLifecycleRuntime: managedLifecycleRuntimeInput,
    },
    {
      ...managedEnvironmentOverrides(),
      preflightManagedLifecycleRuntime: async () => managedLifecycleRuntime,
    },
  );
  const taskRoot = join(
    runtimeRoot,
    "tasks",
    taskNamespaceDigestV1(input.taskId),
  );
  return {
    descriptorPath,
    descriptorSnapshot,
    environment,
    project,
    runtimeRoot,
    taskRoot,
  };
};

const prepareSemanticReadyEnvironment = async (input: {
  readonly root: string;
  readonly taskId: TaskId;
}) => {
  const { project, descriptorPath } = await createCleanExternalRepository(
    input.root,
  );
  const descriptorSnapshot =
    await readGodotProjectDescriptorSnapshotV1(descriptorPath);
  const runtimeRoot = join(input.root, "runtime");
  await mkdir(runtimeRoot);
  const verified = await preflightCleanExternalGodotProject({
    projectPath: project,
    descriptorSnapshot,
    sourceRepositoryExclusionRoots: [runtimeRoot],
  });
  const adapterPath = join(input.root, "semantic-adapter.json");
  await writeFile(
    adapterPath,
    JSON.stringify({
      schemaVersion: 1,
      profileKind: "chronorift-godot-semantic-adapter",
      adapterKind: "timer_spawn_v1",
      projectCapabilitySha256: verified.projectCapability.capabilitySha256,
      targetScene: "res://main.tscn",
      spawnIntervalSeconds: 1,
      checkpointBarrier: "adapter_process_tail",
      limits: {
        activeRuntimesMaximum: 2,
        launchesPerTurnMaximum: 8,
        entityMaximum: 256,
        eventMaximum: 4096,
        rawSemanticBytesMaximum: 2_097_152,
        checkpointBytesMaximum: 1_048_576,
        traceSamplesMaximum: 32,
        traceTicksMaximum: 600,
        queryRowsMaximum: 200,
      },
    }),
  );
  const semanticAdapterProfile =
    await readGodotSemanticAdapterProfileSnapshotV1(adapterPath);
  const environment = await prepareM1TaskEnvironment(
    {
      taskId: input.taskId,
      projectPath: project,
      externalProjectDescriptor: descriptorSnapshot,
      semanticAdapterProfile,
      runtimeRoot,
      sandboxHost: {
        delegatedCgroupRoot: "/test/cgroup",
        bwrapPath: "/test/bwrap",
        prlimitPath: "/test/prlimit",
        busyboxPath: "/test/busybox",
        taskStorageRoot: input.root,
      },
      sandboxToolchain: {
        lddPath: "/usr/bin/ldd",
        commands: [{ target: "/bin/bash", hostPath: "/bin/bash" }],
      },
      managedGodotSemanticRuntime: managedSemanticRuntimeInput,
    },
    {
      ...managedEnvironmentOverrides(),
      preflightManagedSemanticRuntime: async () => managedSemanticRuntime,
    },
  );
  return {
    adapterPath,
    descriptorPath,
    environment,
    project,
    runtimeRoot,
  };
};

describe("internal M1 Task environment", () => {
  it("persists and resumes an external lifecycle Task without rereading the Host descriptor", async () => {
    const root = await createHarnessRoot();
    const taskId = asTaskId("task_external_lifecycle");
    const prepared = await prepareExternalReadyEnvironment({ root, taskId });
    if (prepared.environment.sourceKind !== "godot-external-lifecycle-v1") {
      throw new Error("expected an external Godot Task environment");
    }
    expect(prepared.environment.workspace.schemaVersion).toBe(2);
    expect(
      prepared.environment.managedLifecycleRuntimeCapability.managedRuntimeId,
    ).toBe(managedLifecycleRuntime.capability.managedRuntimeId);
    const context = getM1TaskExternalGodotRuntimeContext(prepared.environment);
    expect(context.projectCapability.capabilitySha256).toBe(
      prepared.environment.projectCapability.capabilitySha256,
    );
    expect(context.sidecarPort).toBeDefined();

    const store = new VNextTaskStore(prepared.runtimeRoot);
    await expect(
      store.readBytes(taskId, "project-descriptor.json"),
    ).resolves.toEqual(prepared.descriptorSnapshot.bytes);
    await expect(
      store.readJson(
        taskId,
        "managed-lifecycle-runtime.json",
        (value) => value,
      ),
    ).resolves.toMatchObject({
      managedRuntimeId: managedLifecycleRuntime.capability.managedRuntimeId,
    });

    await writeFile(
      join(context.workspaceDirectory, "CHRONORIFT_ONBOARDING_SMOKE.md"),
      "external candidate\n",
    );
    const extracted = await extractAndPersistM1Patch(prepared.environment);
    expect(Buffer.from(extracted.patchBytes).toString("utf8")).toContain(
      "CHRONORIFT_ONBOARDING_SMOKE.md",
    );
    expect(await git(prepared.project, ["status", "--porcelain"])).toBe("");

    await suspendM1Task(prepared.environment);
    await unlink(prepared.descriptorPath);
    const resumed = await resumeM1TaskEnvironment(
      {
        taskId,
        runtimeRoot: prepared.runtimeRoot,
        sandboxHost: {
          delegatedCgroupRoot: "/test/cgroup",
          bwrapPath: "/test/bwrap",
          prlimitPath: "/test/prlimit",
          busyboxPath: "/test/busybox",
          taskStorageRoot: root,
        },
        sandboxToolchain: {
          lddPath: "/usr/bin/ldd",
          commands: [{ target: "/bin/bash", hostPath: "/bin/bash" }],
        },
        managedGodotLifecycleRuntime: managedLifecycleRuntimeInput,
      },
      {
        ...managedEnvironmentOverrides(),
        preflightManagedLifecycleRuntime: async () => managedLifecycleRuntime,
      },
    );
    expect(resumed.sourceKind).toBe("godot-external-lifecycle-v1");
    expect(
      getM1TaskExternalGodotRuntimeContext(resumed).baselineSourceHash,
    ).toBe(prepared.environment.workspace.selectedTreeSha256);
    await discardM1Task(resumed);
  });

  it("persists and resumes a semantic Task from frozen descriptor and adapter bytes", async () => {
    const root = await createHarnessRoot();
    const taskId = asTaskId("task_external_semantic");
    const prepared = await prepareSemanticReadyEnvironment({ root, taskId });
    if (prepared.environment.sourceKind !== "godot-external-semantic-v1") {
      throw new Error("expected a semantic Godot Task environment");
    }
    const context = getM1TaskExternalGodotSemanticRuntimeContext(
      prepared.environment,
    );
    expect(context.semanticAdapterProfile.profile.projectCapabilitySha256).toBe(
      context.projectCapability.capabilitySha256,
    );
    expect(context.managedSemanticRuntime.managedRuntimeId).toBe(
      managedSemanticRuntime.capability.managedRuntimeId,
    );
    const store = new VNextTaskStore(prepared.runtimeRoot);
    await expect(
      store.readJson(taskId, "semantic-adapter-profile.json", (value) => value),
    ).resolves.toMatchObject({
      adapterProfileSha256: context.semanticAdapterProfile.adapterProfileSha256,
    });

    await suspendM1Task(prepared.environment);
    await Promise.all([
      unlink(prepared.descriptorPath),
      unlink(prepared.adapterPath),
    ]);
    const resumed = await resumeM1TaskEnvironment(
      {
        taskId,
        runtimeRoot: prepared.runtimeRoot,
        sandboxHost: {
          delegatedCgroupRoot: "/test/cgroup",
          bwrapPath: "/test/bwrap",
          prlimitPath: "/test/prlimit",
          busyboxPath: "/test/busybox",
          taskStorageRoot: root,
        },
        sandboxToolchain: {
          lddPath: "/usr/bin/ldd",
          commands: [{ target: "/bin/bash", hostPath: "/bin/bash" }],
        },
        managedGodotSemanticRuntime: managedSemanticRuntimeInput,
      },
      {
        ...managedEnvironmentOverrides(),
        preflightManagedSemanticRuntime: async () => managedSemanticRuntime,
      },
    );
    expect(resumed.sourceKind).toBe("godot-external-semantic-v1");
    expect(
      getM1TaskExternalGodotSemanticRuntimeContext(resumed)
        .semanticAdapterProfile.adapterProfileSha256,
    ).toBe(context.semanticAdapterProfile.adapterProfileSha256);
    await discardM1Task(resumed);
  });

  it("fails M3 closed before source inspection without an in-bounds storage root", async () => {
    const root = await createHarnessRoot();
    const project = await createCleanFixtureRepository(root);
    const runtimeRoot = join(root, "runtime");
    const otherStorageRoot = join(root, "other-storage");
    await Promise.all([mkdir(runtimeRoot), mkdir(otherStorageRoot)]);
    let sourceInspected = false;
    const baseRequest = {
      taskId: asTaskId("task_storage_preflight"),
      projectPath: project,
      trustedFixtureRoot,
      runtimeRoot,
      sandboxToolchain: {
        lddPath: "/usr/bin/ldd",
        commands: [{ target: "/bin/bash", hostPath: "/bin/bash" }],
      },
      managedGodotRuntime: managedRuntimeInput,
    } as const;
    const overrides = {
      ...managedEnvironmentOverrides(),
      preflightSource: async () => {
        sourceInspected = true;
        throw new Error("source inspection must not run");
      },
    };

    await expect(
      prepareM1TaskEnvironment(
        {
          ...baseRequest,
          sandboxHost: {
            delegatedCgroupRoot: "/test/cgroup",
            bwrapPath: "/test/bwrap",
            prlimitPath: "/test/prlimit",
            busyboxPath: "/test/busybox",
          },
        },
        overrides,
      ),
    ).rejects.toMatchObject({ code: "resource_limit_unavailable" });
    await expect(
      prepareM1TaskEnvironment(
        {
          ...baseRequest,
          sandboxHost: {
            delegatedCgroupRoot: "/test/cgroup",
            bwrapPath: "/test/bwrap",
            prlimitPath: "/test/prlimit",
            busyboxPath: "/test/busybox",
            taskStorageRoot: otherStorageRoot,
          },
        },
        overrides,
      ),
    ).rejects.toMatchObject({ code: "sandbox_preflight_failed" });
    expect(sourceInspected).toBe(false);
  });

  it("rejects a nested runtime filesystem before source inspection or materialization", async () => {
    const root = await createHarnessRoot();
    const project = await createCleanFixtureRepository(root);
    const runtimeRoot = join(root, "runtime");
    await mkdir(runtimeRoot);
    let sourceInspected = false;
    let materialized = false;

    await expect(
      prepareM1TaskEnvironment(
        {
          taskId: asTaskId("task_nested_storage_prepare"),
          projectPath: project,
          trustedFixtureRoot,
          runtimeRoot,
          sandboxHost: {
            delegatedCgroupRoot: "/test/cgroup",
            bwrapPath: "/test/bwrap",
            prlimitPath: "/test/prlimit",
            busyboxPath: "/test/busybox",
            taskStorageRoot: root,
          },
          sandboxToolchain: {
            lddPath: "/usr/bin/ldd",
            commands: [{ target: "/bin/bash", hostPath: "/bin/bash" }],
          },
          managedGodotRuntime: managedRuntimeInput,
        },
        {
          ...managedEnvironmentOverrides(),
          assertTaskStorageLayout: async () => {
            throw new M1Error(
              "sandbox_preflight_failed",
              "runtime root crossed the bounded filesystem",
            );
          },
          preflightSource: async () => {
            sourceInspected = true;
            throw new Error("source inspection must not run");
          },
          materializeWorkspace: async () => {
            materialized = true;
            throw new Error("materialization must not run");
          },
        },
      ),
    ).rejects.toMatchObject({ code: "sandbox_preflight_failed" });
    expect(sourceInspected).toBe(false);
    expect(materialized).toBe(false);
    await expect(access(join(runtimeRoot, "tasks"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("freezes an inspected toolchain into Task records, policy, and broker composition", async () => {
    const root = await createHarnessRoot();
    const project = await createCleanFixtureRepository(root);
    const runtimeRoot = join(root, "runtime");
    await mkdir(runtimeRoot);
    const taskId = asTaskId("task_with_toolchain");
    let brokerReceivedToolchain = false;
    const environment = await prepareM1TaskEnvironment(
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
        sandboxToolchain: {
          lddPath: "/usr/bin/ldd",
          commands: [{ target: "/bin/bash", hostPath: "/bin/bash" }],
        },
      },
      {
        now: () => now,
        preflightSandbox: supportedPreflight,
        inspectToolchain: async () => ({
          capability: toolchainCapability,
          binding: {
            toolchainId: toolchainCapability.toolchainId,
            files: [{ target: "/bin/bash", hostPath: "/bin/bash" }],
          },
        }),
        assertSandboxBinding: async () => undefined,
        createBroker: async (options) => {
          brokerReceivedToolchain =
            options.toolchain?.capability.toolchainId ===
            toolchainCapability.toolchainId;
          return createFakeBroker({
            taskId: options.taskId,
            policyId: options.policy.policyId,
          });
        },
      },
    );

    expect(brokerReceivedToolchain).toBe(true);
    expect(environment.toolchainCapability).toEqual(toolchainCapability);
    expect(environment.policy).toMatchObject({
      toolchainId: toolchainCapability.toolchainId,
      readonlyTargets: ["/bin/bash", "/bin/busybox"],
    });
    const store = new VNextTaskStore(runtimeRoot);
    await expect(
      store.readJson(taskId, "sandbox-toolchain.json", (value) =>
        SandboxToolchainCapabilityV1Schema.parse(value),
      ),
    ).resolves.toEqual(toolchainCapability);
    await discardM1Task(environment);
  });

  it("persists a Policy V2 managed runtime and rebuilds a stable Host game context on resume", async () => {
    const root = await createHarnessRoot();
    const taskId = asTaskId("task_managed_runtime_resume");
    let receivedManagedRuntimeId: string | undefined;
    const prepared = await prepareManagedReadyEnvironment({
      root,
      taskId,
      createBroker: async (options) => {
        receivedManagedRuntimeId =
          options.managedRuntime?.capability.managedRuntimeId;
        return createFakeBroker({
          taskId: options.taskId,
          policyId: options.policy.policyId,
        });
      },
    });

    expect(receivedManagedRuntimeId).toBe(
      managedRuntime.capability.managedRuntimeId,
    );
    expect(prepared.environment.policy).toMatchObject({
      schemaVersion: 2,
      profileBindings: {
        "coding-default": {
          toolchainId: toolchainCapability.toolchainId,
          managedRuntimeId: null,
          workspaceAccess: "read-write",
          readonlyTargets: ["/bin/bash", "/bin/busybox"],
        },
        "godot-headless": {
          toolchainId: managedToolchainCapability.toolchainId,
          managedRuntimeId: managedRuntime.capability.managedRuntimeId,
          workspaceAccess: "read-only",
        },
      },
    });
    if (prepared.environment.policy.schemaVersion !== 2) {
      throw new Error("managed runtime must persist Sandbox Policy V2");
    }
    expect(
      prepared.environment.policy.profileBindings["coding-default"]
        .readonlyTargets,
    ).not.toEqual(
      expect.arrayContaining([
        DEFAULT_RUNTIME_SIDECAR_TARGETS.shellExecutable,
        "/lib/x86_64-linux-gnu/libfontconfig.so.1",
        DEFAULT_RUNTIME_SIDECAR_TARGETS.xdgUserDirExecutable,
        DEFAULT_RUNTIME_SIDECAR_TARGETS.fontconfigFile,
      ]),
    );
    expect(
      prepared.environment.policy.profileBindings["godot-headless"]
        .readonlyTargets,
    ).toEqual(
      expect.arrayContaining([
        DEFAULT_RUNTIME_SIDECAR_TARGETS.shellExecutable,
        "/lib/x86_64-linux-gnu/libfontconfig.so.1",
        DEFAULT_RUNTIME_SIDECAR_TARGETS.xdgUserDirExecutable,
        DEFAULT_RUNTIME_SIDECAR_TARGETS.fontconfigFile,
      ]),
    );
    const store = new VNextTaskStore(prepared.runtimeRoot);
    await expect(
      store.readJson(
        taskId,
        "managed-runtime.json" as VNextTaskJsonSlot,
        (value) => ManagedGodotRuntimeCapabilityV1Schema.parse(value),
      ),
    ).resolves.toEqual(managedRuntime.capability);
    expect(
      await readFile(
        join(prepared.taskRoot, "records", "managed-runtime.json"),
        "utf8",
      ),
    ).not.toContain("/trusted/");
    const firstContext = getM1TaskGameRuntimeContext(prepared.environment);
    expect(firstContext.workspaceDirectory).toBe(
      getM1TaskHostContext(prepared.environment).workspaceDirectory,
    );
    expect(firstContext.managedRuntime).toEqual(managedRuntime.capability);
    expect(createM1ManagedGodotSidecarPort(prepared.environment)).toBeDefined();

    await suspendM1Task(prepared.environment);
    const resumed = await resumeM1TaskEnvironment(
      {
        taskId,
        runtimeRoot: prepared.runtimeRoot,
        sandboxHost: {
          delegatedCgroupRoot: "/test/cgroup",
          bwrapPath: "/test/bwrap",
          prlimitPath: "/test/prlimit",
          busyboxPath: "/test/busybox",
          taskStorageRoot: dirname(prepared.runtimeRoot),
        },
        sandboxToolchain: {
          lddPath: "/usr/bin/ldd",
          commands: [{ target: "/bin/bash", hostPath: "/bin/bash" }],
        },
        managedGodotRuntime: managedRuntimeInput,
      },
      managedEnvironmentOverrides(),
    );
    const resumedContext = getM1TaskGameRuntimeContext(resumed);
    expect(resumedContext.workspaceId).toBe(firstContext.workspaceId);
    expect(resumedContext.fixtureCapability).toEqual(
      firstContext.fixtureCapability,
    );
    await discardM1Task(resumed);
  });

  it("rejects aggregate storage usage above the frozen filesystem capacity", async () => {
    const root = await createHarnessRoot();
    const taskId = asTaskId("task_storage_usage_over_cap");
    const prepared = await prepareManagedReadyEnvironment({
      root,
      taskId,
      createBroker: async (options) =>
        createFakeBroker({
          taskId: options.taskId,
          policyId: options.policy.policyId,
          sandboxCapabilitySha256: asSha256DigestV1(
            contentHash(options.capability as unknown as JsonValue),
          ),
          aggregateStorageUsage: {
            usedBytes: taskStorageCapability.totalBytes + 1,
            usedInodes: 12,
          },
        }),
    });

    await expect(
      executeAndRecordM1Command(prepared.environment, {
        schemaVersion: 1,
        operationId: "forged_storage_usage",
        profile: "coding-default",
        argv: ["/bin/busybox", "true"],
        cwd: "/workspace",
        environment: {},
      }),
    ).rejects.toMatchObject({ code: "artifact_write_failed" });
    await discardM1Task(prepared.environment);
  });

  it("accepts a fresh delegation and active probe while preserving stable sandbox identity", async () => {
    const root = await createHarnessRoot();
    const taskId = asTaskId("task_active_probe_resume");
    const prepared = await prepareManagedReadyEnvironment({ root, taskId });
    await suspendM1Task(prepared.environment);
    const freshProbeCapability = SandboxHostCapabilityV1Schema.parse({
      ...managedSandboxCapability,
      delegatedCgroupRootIdentity: asSha256DigestV1("c".repeat(64)),
      activeProbeSha256: asSha256DigestV1("b".repeat(64)),
    });

    const resumed = await resumeM1TaskEnvironment(
      {
        taskId,
        runtimeRoot: prepared.runtimeRoot,
        sandboxHost: {
          delegatedCgroupRoot: "/test/cgroup",
          bwrapPath: "/test/bwrap",
          prlimitPath: "/test/prlimit",
          busyboxPath: "/test/busybox",
          taskStorageRoot: dirname(prepared.runtimeRoot),
        },
        sandboxToolchain: {
          lddPath: "/usr/bin/ldd",
          commands: [{ target: "/bin/bash", hostPath: "/bin/bash" }],
        },
        managedGodotRuntime: managedRuntimeInput,
      },
      managedEnvironmentOverrides({
        sandboxCapability: freshProbeCapability,
      }),
    );

    expect(resumed.sandboxCapability).toEqual(freshProbeCapability);
    await executeAndRecordM1Command(resumed, {
      schemaVersion: 1,
      operationId: "after_ephemeral_capability_resume",
      profile: "coding-default",
      argv: ["/bin/busybox", "true"],
      cwd: "/workspace",
      environment: {},
    });
    const store = new VNextTaskStore(prepared.runtimeRoot);
    const preflightRecords = await store.readLedger(
      taskId,
      "sandbox-preflight.jsonl",
      (value) => SupportedSandboxPreflightReceiptV1Schema.parse(value),
    );
    expect(preflightRecords.at(-1)?.capabilitySha256).toBe(
      asSha256DigestV1(
        contentHash(freshProbeCapability as unknown as JsonValue),
      ),
    );
    const operationRecords = await store.readLedger(
      taskId,
      "sandbox-operations.jsonl",
      (value) => SandboxOperationRecordV1Schema.parse(value),
    );
    expect(operationRecords.at(-1)?.receipt.sandboxCapabilitySha256).toBe(
      asSha256DigestV1(
        contentHash(freshProbeCapability as unknown as JsonValue),
      ),
    );
    await suspendM1Task(resumed);
    const driftedBwrapCapability = SandboxHostCapabilityV1Schema.parse({
      ...freshProbeCapability,
      bwrap: {
        ...freshProbeCapability.bwrap,
        identity: asSha256DigestV1("d".repeat(64)),
      },
    });
    const resumeRequest = {
      taskId,
      runtimeRoot: prepared.runtimeRoot,
      sandboxHost: {
        delegatedCgroupRoot: "/test/cgroup",
        bwrapPath: "/test/bwrap",
        prlimitPath: "/test/prlimit",
        busyboxPath: "/test/busybox",
        taskStorageRoot: dirname(prepared.runtimeRoot),
      },
      sandboxToolchain: {
        lddPath: "/usr/bin/ldd",
        commands: [{ target: "/bin/bash", hostPath: "/bin/bash" }],
      },
      managedGodotRuntime: managedRuntimeInput,
    } as const;
    await expect(
      resumeM1TaskEnvironment(
        resumeRequest,
        managedEnvironmentOverrides({
          sandboxCapability: driftedBwrapCapability,
        }),
      ),
    ).rejects.toMatchObject({ code: "sandbox_preflight_failed" });
    const recovered = await resumeM1TaskEnvironment(
      resumeRequest,
      managedEnvironmentOverrides({
        sandboxCapability: freshProbeCapability,
      }),
    );
    await suspendM1Task(recovered);
    const driftedStorageCapability = SandboxHostCapabilityV1Schema.parse({
      ...freshProbeCapability,
      taskStorage: {
        ...taskStorageCapability,
        rootIdentitySha256: asSha256DigestV1("e".repeat(64)),
      },
    });
    await expect(
      resumeM1TaskEnvironment(
        resumeRequest,
        managedEnvironmentOverrides({
          sandboxCapability: driftedStorageCapability,
        }),
      ),
    ).rejects.toMatchObject({ code: "sandbox_preflight_failed" });
    const storageRecovered = await resumeM1TaskEnvironment(
      resumeRequest,
      managedEnvironmentOverrides({
        sandboxCapability: freshProbeCapability,
      }),
    );
    await discardM1Task(storageRecovered);
  });

  it("rejects a nested runtime filesystem before opening or mutating a resumed M3 Task", async () => {
    const root = await createHarnessRoot();
    const taskId = asTaskId("task_nested_storage_resume");
    const prepared = await prepareManagedReadyEnvironment({ root, taskId });
    await suspendM1Task(prepared.environment);
    const preflightPath = join(
      prepared.taskRoot,
      "records",
      "sandbox-preflight.jsonl",
    );
    const preflightBefore = await readFile(preflightPath);
    let layoutOpened = false;

    const request = {
      taskId,
      runtimeRoot: prepared.runtimeRoot,
      sandboxHost: {
        delegatedCgroupRoot: "/test/cgroup",
        bwrapPath: "/test/bwrap",
        prlimitPath: "/test/prlimit",
        busyboxPath: "/test/busybox",
        taskStorageRoot: dirname(prepared.runtimeRoot),
      },
      sandboxToolchain: {
        lddPath: "/usr/bin/ldd",
        commands: [{ target: "/bin/bash", hostPath: "/bin/bash" }],
      },
      managedGodotRuntime: managedRuntimeInput,
    } as const;
    await expect(
      resumeM1TaskEnvironment(request, {
        ...managedEnvironmentOverrides(),
        assertTaskStorageLayout: async () => {
          throw new M1Error(
            "sandbox_preflight_failed",
            "runtime root crossed the bounded filesystem",
          );
        },
        openLayout: async () => {
          layoutOpened = true;
          throw new Error("Task layout must not be opened");
        },
      }),
    ).rejects.toMatchObject({ code: "sandbox_preflight_failed" });
    expect(layoutOpened).toBe(false);
    await expect(readFile(preflightPath)).resolves.toEqual(preflightBefore);

    const recovered = await resumeM1TaskEnvironment(
      request,
      managedEnvironmentOverrides(),
    );
    await discardM1Task(recovered);
  });

  it("migrates an exact pre-M3 V1 layout to an empty runtime store on resume", async () => {
    const root = await createHarnessRoot();
    const taskId = asTaskId("task_legacy_runtime_store_resume");
    const prepared = await prepareReadyEnvironment({ root, taskId });
    await suspendM1Task(prepared.environment);
    await rm(join(prepared.taskRoot, "runtime-records"), {
      recursive: true,
      force: false,
    });

    const resumed = await resumeM1TaskEnvironment(
      {
        taskId,
        runtimeRoot: prepared.runtimeRoot,
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
        createBroker: async (options) =>
          createFakeBroker({
            taskId: options.taskId,
            policyId: options.policy.policyId,
            sandboxCapabilitySha256: asSha256DigestV1(
              contentHash(options.capability as unknown as JsonValue),
            ),
          }),
      },
    );
    await executeAndRecordM1Command(resumed, {
      schemaVersion: 1,
      operationId: "after_legacy_runtime_store_migration",
      profile: "coding-default",
      argv: ["/bin/busybox", "true"],
      cwd: "/workspace",
      environment: {},
    });
    await expect(resumed.runtimeStore.summarize()).resolves.toMatchObject({
      taskId,
      executions: [],
    });
    await discardM1Task(resumed);
  });

  it("rejects a missing runtime store for a frozen M3 V2 Task", async () => {
    const root = await createHarnessRoot();
    const taskId = asTaskId("task_m3_missing_runtime_store");
    const prepared = await prepareManagedReadyEnvironment({ root, taskId });
    const taskRoot = prepared.taskRoot;
    await suspendM1Task(prepared.environment);
    await rm(join(taskRoot, "runtime-records"), {
      recursive: true,
      force: false,
    });
    let brokerCreated = false;

    await expect(
      resumeM1TaskEnvironment(
        {
          taskId,
          runtimeRoot: prepared.runtimeRoot,
          sandboxHost: {
            delegatedCgroupRoot: "/test/cgroup",
            bwrapPath: "/test/bwrap",
            prlimitPath: "/test/prlimit",
            busyboxPath: "/test/busybox",
            taskStorageRoot: dirname(prepared.runtimeRoot),
          },
          sandboxToolchain: {
            lddPath: "/usr/bin/ldd",
            commands: [{ target: "/bin/bash", hostPath: "/bin/bash" }],
          },
          managedGodotRuntime: managedRuntimeInput,
        },
        managedEnvironmentOverrides({
          createBroker: async (options) => {
            brokerCreated = true;
            return createFakeBroker({
              taskId: options.taskId,
              policyId: options.policy.policyId,
            });
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "artifact_write_failed" });
    expect(brokerCreated).toBe(false);
    await expect(
      lstat(join(taskRoot, "runtime-records")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails resume closed when a frozen managed runtime is missing or changes identity", async () => {
    const root = await createHarnessRoot();
    const changedTaskId = asTaskId("task_managed_runtime_changed");
    const changed = await prepareManagedReadyEnvironment({
      root,
      taskId: changedTaskId,
    });
    await suspendM1Task(changed.environment);
    const driftedRuntime = createManagedGodotRuntimeV1({
      doctorVersion: "4.7.1.stable.official.b13da4feb",
      nodeTarget: DEFAULT_RUNTIME_SIDECAR_TARGETS.nodeExecutable,
      godotTarget: DEFAULT_RUNTIME_SIDECAR_TARGETS.godotExecutable,
      toolchain: {
        capability: managedToolchainCapability,
        binding: managedRuntime.binding.toolchain,
      },
      sidecarSource: productionSidecarSource,
      addonFiles: managedRuntime.binding.addonFiles,
    });
    const resumeRequest = {
      taskId: changedTaskId,
      runtimeRoot: changed.runtimeRoot,
      sandboxHost: {
        delegatedCgroupRoot: "/test/cgroup",
        bwrapPath: "/test/bwrap",
        prlimitPath: "/test/prlimit",
        busyboxPath: "/test/busybox",
        taskStorageRoot: dirname(changed.runtimeRoot),
      },
      sandboxToolchain: {
        lddPath: "/usr/bin/ldd",
        commands: [{ target: "/bin/bash", hostPath: "/bin/bash" }],
      },
      managedGodotRuntime: managedRuntimeInput,
    } as const;
    await expect(
      resumeM1TaskEnvironment(
        resumeRequest,
        managedEnvironmentOverrides({ frozenRuntime: driftedRuntime }),
      ),
    ).rejects.toMatchObject({ code: "sandbox_preflight_failed" });
    const recovered = await resumeM1TaskEnvironment(
      resumeRequest,
      managedEnvironmentOverrides(),
    );
    await discardM1Task(recovered);

    const missingRoot = await createHarnessRoot();
    const missingTaskId = asTaskId("task_managed_runtime_missing");
    const missing = await prepareManagedReadyEnvironment({
      root: missingRoot,
      taskId: missingTaskId,
    });
    await suspendM1Task(missing.environment);
    await unlink(join(missing.taskRoot, "records", "managed-runtime.json"));
    await expect(
      resumeM1TaskEnvironment(
        {
          ...resumeRequest,
          taskId: missingTaskId,
          runtimeRoot: missing.runtimeRoot,
          sandboxHost: {
            ...resumeRequest.sandboxHost,
            taskStorageRoot: dirname(missing.runtimeRoot),
          },
        },
        managedEnvironmentOverrides(),
      ),
    ).rejects.toMatchObject({ code: "sandbox_preflight_failed" });
  });

  it("terminates an active duplex runtime on suspend and records its real completion", async () => {
    const root = await createHarnessRoot();
    const taskId = asTaskId("task_duplex_runtime_cleanup");
    let cleanupCalls = 0;
    let capturedRequest:
      Parameters<DuplexTaskSandboxBrokerV1["openDuplex"]>[0] | undefined;
    let complete!: (result: SandboxExecutionResultV1) => void;
    const completion = new Promise<SandboxExecutionResultV1>((resolve) => {
      complete = resolve;
    });
    const prepared = await prepareManagedReadyEnvironment({
      root,
      taskId,
      createBroker: async (options) => {
        const honest = createFakeBroker({
          taskId: options.taskId,
          policyId: options.policy.policyId,
        });
        return {
          execute: (request, executeOptions) =>
            honest.execute(request, executeOptions),
          openDuplex: async (request) => {
            capturedRequest = request;
            return {
              kind: "opened" as const,
              handle: {
                write: async () => undefined,
                endInput: async () => undefined,
                terminate: async () => undefined,
                completion,
              },
            };
          },
          cleanup: async () => {
            cleanupCalls += 1;
            if (capturedRequest !== undefined) {
              const executed = await honest.execute(capturedRequest);
              if (executed.kind !== "executed") {
                throw new Error("fake duplex completion was denied");
              }
              complete({
                ...executed,
                receipt: SandboxExecutionReceiptV1Schema.parse({
                  ...executed.receipt,
                  status: "cancelled",
                  exitCode: null,
                  signal: null,
                  cleanup: {
                    processGroupTerminated: true,
                    cgroupPopulated: false,
                    termSent: true,
                    killSent: false,
                    scopeRemoved: true,
                  },
                }),
              });
            }
            return {
              processGroupTerminated: true,
              cgroupPopulated: false,
              termSent: true,
              killSent: false,
              scopeRemoved: true,
            };
          },
        };
      },
    });
    const port = getM1TaskDuplexSandboxPort(prepared.environment);
    const opened = await port.openDuplex({
      schemaVersion: 1,
      operationId: "game-runtime:cleanup",
      profile: "godot-headless",
      argv: [DEFAULT_RUNTIME_SIDECAR_TARGETS.nodeExecutable, "--version"],
      cwd: "/workspace",
      environment: {},
    });
    if (opened.kind !== "opened") {
      throw new Error("fake duplex runtime did not open");
    }
    await suspendM1Task(prepared.environment);
    await expect(opened.handle.completion).resolves.toMatchObject({
      kind: "executed",
      receipt: { status: "cancelled" },
    });
    expect(cleanupCalls).toBe(1);
    const store = new VNextTaskStore(prepared.runtimeRoot);
    await expect(
      store.readLedger(taskId, "sandbox-operations.jsonl", (value) =>
        SandboxOperationRecordV1Schema.parse(value),
      ),
    ).resolves.toMatchObject([
      { receipt: { operationId: "game-runtime:cleanup", status: "cancelled" } },
    ]);
    await discardM1Task(prepared.environment);
  });

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
    await environment.runtimeStore.putResourceOnce(
      "build",
      "build_lifecycle",
      { schemaVersion: 1, taskId, label: "lifecycle" },
      parseTestRuntimeRecord,
    );
    await expect(
      environment.runtimeStore.readResource(
        "build",
        "build_lifecycle",
        parseTestRuntimeRecord,
      ),
    ).resolves.toMatchObject({ label: "lifecycle" });

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

  it("suspends and resumes the same workspace with a newly verified sandbox binding", async () => {
    const root = await createHarnessRoot();
    const taskId = asTaskId("task_suspend_resume");
    const { environment, runtimeRoot, taskRoot } =
      await prepareReadyEnvironment({
        root,
        taskId,
      });
    const context = getM1TaskHostContext(environment);
    expect(context).toEqual({
      workspaceDirectory: join(taskRoot, "workspace"),
      piSessionDirectory: join(taskRoot, "pi-sessions"),
    });
    await writeFile(
      join(context.workspaceDirectory, "resume-marker.txt"),
      "kept\n",
    );
    const executionId = "execution_suspend_resume";
    await environment.runtimeStore.putResourceOnce(
      "execution",
      executionId,
      { schemaVersion: 1, taskId, label: "running" },
      parseTestRuntimeRecord,
    );
    await environment.runtimeStore.appendExecutionEvent(
      executionId,
      {
        schemaVersion: 1,
        taskId,
        executionId,
        sequence: 0,
        label: "before-suspend",
      },
      parseTestRuntimeEvent,
    );
    const runtimeSeal =
      await environment.runtimeStore.sealExecution(executionId);

    await suspendM1Task(environment);
    await expect(access(taskRoot)).resolves.toBeUndefined();
    await expect(
      executeAndRecordM1Command(environment, {
        schemaVersion: 1,
        operationId: "after_suspend",
        profile: "coding-default",
        argv: ["/bin/busybox", "true"],
        cwd: "/workspace",
        environment: {},
      }),
    ).rejects.toMatchObject({ code: "command_cancelled" });

    const resumed = await resumeM1TaskEnvironment(
      {
        taskId,
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
        createBroker: async (options) =>
          createFakeBroker({
            taskId: options.taskId,
            policyId: options.policy.policyId,
          }),
      },
    );
    expect(
      await readFile(
        join(
          getM1TaskHostContext(resumed).workspaceDirectory,
          "resume-marker.txt",
        ),
        "utf8",
      ),
    ).toBe("kept\n");
    await expect(
      resumed.runtimeStore.readResource(
        "execution",
        executionId,
        parseTestRuntimeRecord,
      ),
    ).resolves.toMatchObject({ label: "running" });
    await expect(
      resumed.runtimeStore.readExecutionEvents(
        executionId,
        parseTestRuntimeEvent,
      ),
    ).resolves.toMatchObject([{ label: "before-suspend", sequence: 0 }]);
    await expect(
      resumed.runtimeStore.sealExecution(executionId),
    ).resolves.toEqual(runtimeSeal);
    await expect(resumed.runtimeStore.summarize()).resolves.toMatchObject({
      schemaVersion: 1,
      taskId,
      executions: [{ executionId, sealed: true }],
    });
    await executeAndRecordM1Command(resumed, {
      schemaVersion: 1,
      operationId: "after_resume",
      profile: "coding-default",
      argv: ["/bin/busybox", "true"],
      cwd: "/workspace",
      environment: {},
    });
    const store = new VNextTaskStore(runtimeRoot);
    const events = await store.readLedger(
      taskId,
      "task-events.jsonl",
      (value) => M1TaskEventV1Schema.parse(value),
    );
    expect(events.map((event) => event.kind)).toEqual([
      "creating",
      "ready",
      "suspended",
      "resumed",
    ]);
    await discardM1Task(resumed);
  });

  it("resumes and executes a legacy four-feature Policy V1 Task only after a fresh remount-ro preflight", async () => {
    const root = await createHarnessRoot();
    const taskId = asTaskId("task_legacy_bwrap_feature_resume");
    const { environment, runtimeRoot } = await prepareReadyEnvironment({
      root,
      taskId,
    });
    expect(environment.sandboxCapability.bwrap.features).toEqual([
      "block-fd",
      "json-status-fd",
      "bind-fd",
      "ro-bind-fd",
    ]);
    await suspendM1Task(environment);

    const resumed = await resumeM1TaskEnvironment(
      {
        taskId,
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
        preflightSandbox: () =>
          supportedPreflightForCapability(currentCapability),
        assertSandboxBinding: async () => undefined,
        createBroker: async (options) =>
          createFakeBroker({
            taskId: options.taskId,
            policyId: options.policy.policyId,
            sandboxCapabilitySha256: asSha256DigestV1(
              contentHash(options.capability as unknown as JsonValue),
            ),
          }),
      },
    );
    expect(resumed.sandboxCapability.bwrap.features).toEqual([
      "block-fd",
      "json-status-fd",
      "bind-fd",
      "ro-bind-fd",
      "remount-ro",
    ]);
    await expect(
      executeAndRecordM1Command(resumed, {
        schemaVersion: 1,
        operationId: "after_remount_feature_upgrade",
        profile: "coding-default",
        argv: ["/bin/busybox", "true"],
        cwd: "/workspace",
        environment: {},
      }),
    ).resolves.toMatchObject({ kind: "executed" });
    await discardM1Task(resumed);
  });

  it("rejects corrupted runtime records before mutating resume ledgers or launching a broker", async () => {
    const root = await createHarnessRoot();
    const taskId = asTaskId("task_runtime_resume_corrupt");
    const { environment, runtimeRoot, taskRoot } =
      await prepareReadyEnvironment({ root, taskId });
    const indexId = "index_resume_corrupt";
    await environment.runtimeStore.putResourceOnce(
      "index",
      indexId,
      { schemaVersion: 1, taskId, label: "before" },
      parseTestRuntimeRecord,
    );
    await suspendM1Task(environment);
    const preflightPath = join(taskRoot, "records", "sandbox-preflight.jsonl");
    const preflightBefore = await readFile(preflightPath);
    const recordPath = join(
      taskRoot,
      "runtime-records",
      "indexes",
      runtimeResourceNamespaceDigestV1(taskId, "index", indexId),
      "record.json",
    );
    const envelope = JSON.parse(await readFile(recordPath, "utf8")) as {
      payload: { label: string };
    };
    envelope.payload.label = "tampered";
    await writeFile(
      recordPath,
      `${canonicalJson(envelope as unknown as JsonValue)}\n`,
    );
    let brokerCreated = false;

    await expect(
      resumeM1TaskEnvironment(
        {
          taskId,
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
            brokerCreated = true;
            return createFakeBroker({
              taskId: options.taskId,
              policyId: options.policy.policyId,
            });
          },
        },
      ),
    ).rejects.toMatchObject({ code: "artifact_write_failed" });
    expect(brokerCreated).toBe(false);
    await expect(readFile(preflightPath)).resolves.toEqual(preflightBefore);
  });

  it("rejects a foreign runtime-records child on resume without leaking a broker", async () => {
    const root = await createHarnessRoot();
    const taskId = asTaskId("task_runtime_resume_foreign");
    const { environment, runtimeRoot, taskRoot } =
      await prepareReadyEnvironment({ root, taskId });
    await suspendM1Task(environment);
    await writeFile(join(taskRoot, "runtime-records", "foreign"), "foreign\n");
    let brokerCreated = false;

    await expect(
      resumeM1TaskEnvironment(
        {
          taskId,
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
            brokerCreated = true;
            return createFakeBroker({
              taskId: options.taskId,
              policyId: options.policy.policyId,
            });
          },
        },
      ),
    ).rejects.toMatchObject({ code: "artifact_write_failed" });
    expect(brokerCreated).toBe(false);
    await expect(
      readFile(join(taskRoot, "runtime-records", "foreign"), "utf8"),
    ).resolves.toBe("foreign\n");
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
    expect((await readdir(taskRoot)).sort()).toEqual(
      ["records", "runtime-records"].sort(),
    );
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

  it("retries retained broker setup ownership and preserves mutable Task state on permanent failure", async () => {
    const run = async (permanent: boolean) => {
      const root = await createHarnessRoot();
      const project = await createCleanFixtureRepository(root);
      const runtimeRoot = join(root, "runtime");
      await mkdir(runtimeRoot);
      const taskId = asTaskId(
        permanent ? "task_setup_owner_permanent" : "task_setup_owner_transient",
      );
      let retryCalls = 0;
      let caught: unknown;
      try {
        await prepareM1TaskEnvironment(
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
            createBroker: async () => {
              throw new SandboxBrokerSetupCleanupError(
                new M1Error(
                  "sandbox_launch_failed",
                  "broker post-bind validation failed",
                ),
                new Error("initial cleanup attempts failed"),
                async () => {
                  retryCalls += 1;
                  if (permanent || retryCalls === 1) {
                    throw new Error("retained cleanup still failed");
                  }
                },
              );
            },
          },
        );
      } catch (error) {
        caught = error;
      }
      const taskRoot = join(
        runtimeRoot,
        "tasks",
        taskNamespaceDigestV1(taskId),
      );
      return { caught, retryCalls, taskRoot };
    };

    const transient = await run(false);
    expect(transient.caught).toMatchObject({
      code: "sandbox_launch_failed",
      message: "broker post-bind validation failed",
    });
    expect(transient.retryCalls).toBe(2);
    expect((await readdir(transient.taskRoot)).sort()).toEqual(
      ["records", "runtime-records"].sort(),
    );

    const permanent = await run(true);
    expect(permanent.retryCalls).toBe(3);
    expect(permanent.caught).toBeInstanceOf(M1Error);
    if (!(permanent.caught instanceof M1Error)) {
      throw new Error("expected retained M1 setup error");
    }
    expect(permanent.caught.code).toBe("artifact_write_failed");
    expect(permanent.caught.message).toMatch(/Task state was retained/u);
    expect(permanent.caught.storedCause).toBeInstanceOf(
      SandboxBrokerSetupCleanupError,
    );
    await expect(
      access(join(permanent.taskRoot, "workspace")),
    ).resolves.toBeUndefined();
  });

  it("retains a permanently unclean broker through prepare and resume record failures", async () => {
    const unprovenCleanup = (calls: { value: number }) => async () => {
      calls.value += 1;
      return {
        processGroupTerminated: false,
        cgroupPopulated: true,
        termSent: true,
        killSent: true,
        scopeRemoved: false,
      } as const;
    };

    const prepareRoot = await createHarnessRoot();
    const prepareProject = await createCleanFixtureRepository(prepareRoot);
    const prepareRuntimeRoot = join(prepareRoot, "runtime");
    await mkdir(prepareRuntimeRoot);
    const prepareTaskId = asTaskId("task_broker_cleanup_prepare_retained");
    const prepareCleanupCalls = { value: 0 };
    let prepareError: unknown;
    try {
      await prepareM1TaskEnvironment(
        {
          taskId: prepareTaskId,
          projectPath: prepareProject,
          trustedFixtureRoot,
          runtimeRoot: prepareRuntimeRoot,
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
          createStore: (runtimeRoot) =>
            new FailingTaskEventStore(runtimeRoot, new Set(["ready"])),
          createBroker: async (options) =>
            createFakeBroker({
              taskId: options.taskId,
              policyId: options.policy.policyId,
              cleanup: unprovenCleanup(prepareCleanupCalls),
            }),
        },
      );
    } catch (error) {
      prepareError = error;
    }
    expect(prepareCleanupCalls.value).toBe(6);
    expect(prepareError).toBeInstanceOf(M1Error);
    if (!(prepareError instanceof M1Error)) {
      throw new Error("expected retained prepare cleanup error");
    }
    expect(prepareError.storedCause).toBeInstanceOf(
      SandboxBrokerSetupCleanupError,
    );
    const prepareTaskRoot = join(
      prepareRuntimeRoot,
      "tasks",
      taskNamespaceDigestV1(prepareTaskId),
    );
    await expect(
      access(join(prepareTaskRoot, "workspace")),
    ).resolves.toBeUndefined();

    const resumeRoot = await createHarnessRoot();
    const resumeTaskId = asTaskId("task_broker_cleanup_resume_retained");
    const prepared = await prepareReadyEnvironment({
      root: resumeRoot,
      taskId: resumeTaskId,
    });
    await suspendM1Task(prepared.environment);
    const resumeCleanupCalls = { value: 0 };
    let resumeError: unknown;
    try {
      await resumeM1TaskEnvironment(
        {
          taskId: resumeTaskId,
          runtimeRoot: prepared.runtimeRoot,
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
          createStore: (runtimeRoot) =>
            new FailingTaskEventStore(
              runtimeRoot,
              new Set(["resumed", "resume_failed"]),
            ),
          createBroker: async (options) =>
            createFakeBroker({
              taskId: options.taskId,
              policyId: options.policy.policyId,
              cleanup: unprovenCleanup(resumeCleanupCalls),
            }),
        },
      );
    } catch (error) {
      resumeError = error;
    }
    expect(resumeCleanupCalls.value).toBe(6);
    expect(resumeError).toBeInstanceOf(M1Error);
    if (!(resumeError instanceof M1Error)) {
      throw new Error("expected retained resume cleanup error");
    }
    expect(resumeError.storedCause).toBeInstanceOf(AggregateError);
    if (!(resumeError.storedCause instanceof AggregateError)) {
      throw new Error("expected aggregate retained resume cause");
    }
    expect(
      resumeError.storedCause.errors.some(
        (cause) => cause instanceof SandboxBrokerSetupCleanupError,
      ),
    ).toBe(true);
    await expect(
      access(join(prepared.taskRoot, "workspace")),
    ).resolves.toBeUndefined();
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

  it("retries Task cleanup when storage reconciliation is explicitly unproven", async () => {
    const root = await createHarnessRoot();
    const taskId = asTaskId("task_storage_cleanup_unproven");
    let cleanupAttempts = 0;
    const { environment, taskRoot } = await prepareReadyEnvironment({
      root,
      taskId,
      cleanup: async () => {
        cleanupAttempts += 1;
        return {
          processGroupTerminated: true,
          cgroupPopulated: false,
          termSent: false,
          killSent: false,
          scopeRemoved: true,
          storageReconciled: cleanupAttempts > 1,
        };
      },
    });
    await expect(discardM1Task(environment)).rejects.toMatchObject({
      code: "artifact_write_failed",
    });
    expect(await readdir(taskRoot)).toContain("records");
    await expect(discardM1Task(environment)).resolves.toMatchObject({
      scopeRemoved: true,
      storageReconciled: true,
    });
    expect(cleanupAttempts).toBe(2);
    await expect(access(taskRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retries Task cleanup when bootstrap lifecycle ownership remains", async () => {
    const root = await createHarnessRoot();
    const taskId = asTaskId("task_bootstrap_cleanup_owner");
    let cleanupAttempts = 0;
    const { environment, taskRoot } = await prepareReadyEnvironment({
      root,
      taskId,
      cleanup: async () => {
        cleanupAttempts += 1;
        return cleanupAttempts === 1
          ? {
              processGroupTerminated: false,
              cgroupPopulated: false,
              termSent: false,
              killSent: true,
              scopeRemoved: false,
            }
          : {
              processGroupTerminated: true,
              cgroupPopulated: false,
              termSent: false,
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
      processGroupTerminated: true,
      cgroupPopulated: false,
      scopeRemoved: true,
    });
    expect(cleanupAttempts).toBe(2);
    await expect(access(taskRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("discards runtime records before Task records and does not repeat a completed runtime discard", async () => {
    const root = await createHarnessRoot();
    const taskId = asTaskId("task_runtime_discard_order");
    let runtimeDiscardAttempts = 0;
    let foreignPath = "";
    const { environment, runtimeRoot, taskRoot } =
      await prepareReadyEnvironment({
        root,
        taskId,
        runtimeStoreFactory: (createdRuntimeRoot) =>
          new (class extends VNextRuntimeStore {
            public override async discard(
              discardedTaskId: TaskId,
            ): Promise<void> {
              runtimeDiscardAttempts += 1;
              await super.discard(discardedTaskId);
              foreignPath = join(
                createdRuntimeRoot,
                "tasks",
                taskNamespaceDigestV1(discardedTaskId),
                "foreign-after-runtime-records",
              );
              await mkdir(foreignPath);
            }
          })(createdRuntimeRoot),
      });
    await environment.runtimeStore.putResourceOnce(
      "build",
      "build_discard_order",
      { schemaVersion: 1, taskId, label: "discard-order" },
      parseTestRuntimeRecord,
    );

    await expect(discardM1Task(environment)).rejects.toMatchObject({
      code: "path_denied",
    });
    expect(runtimeDiscardAttempts).toBe(1);
    await expect(
      access(join(taskRoot, "runtime-records")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(taskRoot, "records"))).resolves.toBeUndefined();

    await rm(foreignPath, { recursive: true, force: false });
    await expect(discardM1Task(environment)).resolves.toMatchObject({
      scopeRemoved: true,
    });
    expect(runtimeDiscardAttempts).toBe(1);
    await expect(access(taskRoot)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(runtimeRoot)).resolves.toBeUndefined();
  });

  it("retries runtime discard after a foreign child is removed without partially deleting records", async () => {
    const root = await createHarnessRoot();
    const taskId = asTaskId("task_runtime_foreign_retry");
    const { environment, taskRoot } = await prepareReadyEnvironment({
      root,
      taskId,
    });
    const buildId = "build_foreign_retry";
    await environment.runtimeStore.putResourceOnce(
      "build",
      buildId,
      { schemaVersion: 1, taskId, label: "must-survive-first-attempt" },
      parseTestRuntimeRecord,
    );
    const resourceDirectory = join(
      taskRoot,
      "runtime-records",
      "builds",
      runtimeResourceNamespaceDigestV1(taskId, "build", buildId),
    );
    const foreignPath = join(resourceDirectory, "foreign");
    await writeFile(foreignPath, "foreign\n");

    await expect(discardM1Task(environment)).rejects.toMatchObject({
      code: "artifact_write_failed",
    });
    await expect(
      access(join(resourceDirectory, "record.json")),
    ).resolves.toBeUndefined();
    await expect(access(join(taskRoot, "records"))).resolves.toBeUndefined();

    await unlink(foreignPath);
    await expect(discardM1Task(environment)).resolves.toMatchObject({
      scopeRemoved: true,
    });
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
      Parameters<DuplexTaskSandboxBrokerV1["execute"]>[0] | undefined;
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
