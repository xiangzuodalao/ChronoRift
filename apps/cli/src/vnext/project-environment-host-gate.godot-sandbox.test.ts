import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  asProjectEnvironmentTaskId,
  asSha256DigestV1,
} from "@chronorift/domain";
import {
  DEFAULT_PROJECT_ENVIRONMENT_SIDECAR_TARGETS_V1,
  loadProjectAdapterPackageV1,
} from "@chronorift/godot-adapter";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import type { SecurityEventV1 } from "./contracts.js";
import { preflightManagedGodotProjectEnvironmentRuntimeV1 } from "./managed-godot-project-environment-runtime-preflight.js";
import { createProjectEnvironmentConformanceDriverV1 } from "./project-environment-conformance-driver.js";
import {
  ProjectEnvironmentHostConfigV1Schema,
  resolveProjectEnvironmentGodotToolchainV1,
} from "./project-environment-host-config.js";
import { GodotProjectEnvironmentSidecarPortV1 } from "./project-environment-sidecar-port.js";
import { createDuplexBwrapCgroupTaskSandbox } from "./sandbox-broker.js";
import { createSandboxPolicyV2 } from "./sandbox-policy.js";
import { preflightSandboxHost } from "./sandbox-preflight.js";
import { inspectSandboxToolchain } from "./sandbox-toolchain.js";
import { preflightCleanProjectEnvironmentV1 } from "./source-preflight.js";
import { createProjectEnvironmentTaskDirectoryLayout } from "./task-paths.js";
import { materializePrivateTaskWorkspace } from "./workspace-materializer.js";

const execFileAsync = promisify(execFile);
const temporaryRoots = new Set<string>();

afterEach(async () => {
  await Promise.all(
    [...temporaryRoots].map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
  temporaryRoots.clear();
});

const requiredEnvironment = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is required for PE Host Gate conformance`);
  }
  return value;
};

const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

const git = async (cwd: string, args: readonly string[]): Promise<void> => {
  await execFileAsync("/usr/bin/git", args, {
    cwd,
    env: {
      PATH: "/usr/bin:/bin",
      LANG: "C",
      LC_ALL: "C",
      HOME: cwd,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "ChronoRift PE Host Gate",
      GIT_AUTHOR_EMAIL: "pe-host-gate@chronorift.invalid",
      GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
      GIT_COMMITTER_NAME: "ChronoRift PE Host Gate",
      GIT_COMMITTER_EMAIL: "pe-host-gate@chronorift.invalid",
      GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
    },
    encoding: "utf8",
  });
};

const managedRuntimeTargets = (runtime: {
  readonly capability: {
    readonly toolchain: {
      readonly files: readonly { readonly target: string }[];
    };
    readonly fontconfigTarget: string;
    readonly addonParentTarget: string;
    readonly addonTarget: string;
    readonly overlayTarget: string;
    readonly adapterParentTarget: string;
    readonly adapterTarget: string;
  };
}): readonly string[] => [
  ...runtime.capability.toolchain.files.map((file) => file.target),
  runtime.capability.fontconfigTarget,
  runtime.capability.addonParentTarget,
  runtime.capability.addonTarget,
  runtime.capability.overlayTarget,
  runtime.capability.adapterParentTarget,
  runtime.capability.adapterTarget,
];

const MountProbeResultSchema = z
  .object({
    hashes: z.record(z.string(), z.string()),
    writesDenied: z.record(z.string(), z.boolean()),
    absent: z.record(z.string(), z.boolean()),
    credentialEnvironmentVisible: z.boolean(),
    deviceCreateDenied: z.boolean(),
    nullDeviceWritable: z.boolean(),
  })
  .strict();

describe("PE-A integrated Godot sandbox Host Gate", () => {
  it("runs the real managed PE conformance under readonly overlays and a bounded isolated sandbox", async () => {
    const delegatedCgroupRoot = requiredEnvironment(
      "CHRONORIFT_TEST_CGROUP_ROOT",
    );
    const nodePath = requiredEnvironment("CHRONORIFT_TEST_NODE_BIN");
    const godotPath = requiredEnvironment("CHRONORIFT_TEST_GODOT_BIN");
    const taskStorageRoot = requiredEnvironment(
      "CHRONORIFT_TEST_TASK_STORAGE_ROOT",
    );
    const bwrapPath = requiredEnvironment("CHRONORIFT_TEST_BWRAP_BIN");
    const prlimitPath = requiredEnvironment("CHRONORIFT_TEST_PRLIMIT_BIN");
    const busyboxPath = requiredEnvironment("CHRONORIFT_TEST_BUSYBOX_BIN");
    const lddPath = requiredEnvironment("CHRONORIFT_TEST_LDD_BIN");
    const fontconfigProbePath = requiredEnvironment(
      "CHRONORIFT_TEST_FONTCONFIG_PROBE_BIN",
    );
    const xdgUserDirPath = requiredEnvironment(
      "CHRONORIFT_TEST_XDG_USER_DIR_BIN",
    );
    const bashPath = requiredEnvironment("CHRONORIFT_TEST_BASH_BIN");
    const rgPath = requiredEnvironment("CHRONORIFT_TEST_RG_BIN");
    const findPath = requiredEnvironment("CHRONORIFT_TEST_FIND_BIN");
    const lsPath = requiredEnvironment("CHRONORIFT_TEST_LS_BIN");

    const sourceRoot = await mkdtemp(
      join(tmpdir(), "chronorift-pe-host-gate-source-"),
    );
    const runtimeRoot = await mkdtemp(
      join(taskStorageRoot, "chronorift-pe-host-gate-runtime-"),
    );
    temporaryRoots.add(sourceRoot);
    temporaryRoots.add(runtimeRoot);
    const fixtureRoot = join(
      process.cwd(),
      "fixtures/godot-project-environment-snapshot-characterization",
    );
    const adapterRoot = join(fixtureRoot, "adapter");
    for (const relativePath of [
      "project.godot",
      "main.gd",
      "main.gd.uid",
      "main.tscn",
    ]) {
      await writeFile(
        join(sourceRoot, relativePath),
        await readFile(join(fixtureRoot, relativePath)),
      );
    }
    await git(sourceRoot, ["init", "--quiet", "--initial-branch=main"]);
    await git(sourceRoot, ["add", "--all"]);
    await git(sourceRoot, ["commit", "--quiet", "-m", "frozen fixture"]);

    const adapterPackage = await loadProjectAdapterPackageV1(adapterRoot, {
      requireSingleLaunchTarget: true,
      expectedMainScene: "res://main.tscn",
      requireEmptyLaunchParameters: true,
    });
    const adapterFiles = await Promise.all(
      adapterPackage.files.map(async (file) => ({
        relativePath: file.path,
        bytes: Uint8Array.from(await readFile(join(adapterRoot, file.path))),
      })),
    );
    const godotSha256 = asSha256DigestV1(sha256(await readFile(godotPath)));
    const hostConfig = ProjectEnvironmentHostConfigV1Schema.parse({
      schemaVersion: 1,
      configKind: "chronorift-project-environment-host",
      taskStorageRoot,
      runtimeRoot,
      delegatedCgroupRoot,
      bwrapPath,
      prlimitPath,
      busyboxPath,
      fontconfigProbePath,
      xdgUserDirPath,
      nodePath,
      bashPath,
      rgPath,
      findPath,
      lsPath,
      lddPath,
      godotToolchains: [
        {
          schemaVersion: 1,
          key: "godot-4.7.1-linux-x86_64-official",
          version: "4.7.1",
          platform: "linux-x86_64",
          channel: "stable-official",
          executablePath: godotPath,
          executableSha256: godotSha256,
          buildFeatures: ["gdscript", "headless"],
          renderer: "gl_compatibility",
        },
      ],
    });

    const sandbox = await preflightSandboxHost({
      delegatedCgroupRoot,
      bwrapPath,
      prlimitPath,
      busyboxPath,
      taskStorageRoot,
    });
    if (sandbox.kind !== "supported") {
      throw new Error(JSON.stringify(sandbox.receipt.blockers));
    }
    expect(sandbox.capability).toMatchObject({
      cgroupNamespaceUnshared: true,
      controllers: ["cpu", "memory", "pids"],
      taskStorage: {
        kind: "dedicated-capacity-bounded-filesystem-v1",
      },
    });
    const source = await preflightCleanProjectEnvironmentV1({
      projectPath: sourceRoot,
      sourceRepositoryExclusionRoots: [taskStorageRoot],
    });
    const godot = await resolveProjectEnvironmentGodotToolchainV1(
      hostConfig,
      source.requestedGodotVersion,
    );
    const taskId = asProjectEnvironmentTaskId(`pe-host-gate.${randomUUID()}`);
    const layout = await createProjectEnvironmentTaskDirectoryLayout({
      runtimeRoot,
      sourceRepositoryRoot: source.repositoryRoot,
      taskId,
    });
    await materializePrivateTaskWorkspace({ taskId, source, layout });
    const codingToolchain = await inspectSandboxToolchain({
      lddPath,
      commands: [
        { target: "/bin/bash", hostPath: bashPath },
        { target: "/usr/bin/rg", hostPath: rgPath },
        { target: "/usr/bin/find", hostPath: findPath },
        { target: "/usr/bin/ls", hostPath: lsPath },
      ],
    });
    const managedRuntime =
      await preflightManagedGodotProjectEnvironmentRuntimeV1({
        hostConfig,
        godot,
        adapterFiles,
      });
    const policy = createSandboxPolicyV2(sandbox.capability.runtimeIdentity, {
      coding: {
        toolchainId: codingToolchain.capability.toolchainId,
        targets: codingToolchain.capability.files.map((file) => file.target),
      },
      godot: {
        toolchainId: managedRuntime.capability.toolchain.toolchainId,
        managedRuntimeId: managedRuntime.capability.managedRuntimeId,
        targets: managedRuntimeTargets(managedRuntime),
      },
    });
    const securityEvents: SecurityEventV1[] = [];
    const broker = await createDuplexBwrapCgroupTaskSandbox({
      taskId,
      capability: sandbox.capability,
      hostBinding: sandbox.binding,
      policy,
      toolchain: codingToolchain,
      managedRuntime,
      layout,
      securityEvents: (event) => {
        securityEvents.push(event);
        return Promise.resolve();
      },
    });

    try {
      const bridgePath = `${managedRuntime.capability.addonTarget}/bridge.gd`;
      const sdkPath = `${managedRuntime.capability.addonTarget}/sdk/snapshot_v1.gd`;
      const adapterPath = `${managedRuntime.capability.adapterTarget}/manifest.json`;
      const readonlyPaths = [
        "/workspace/project.godot",
        bridgePath,
        sdkPath,
        managedRuntime.capability.overlayTarget,
        adapterPath,
      ];
      const absentPaths = [
        "/root",
        "/root/.aws/credentials",
        "/home",
        "/run/secrets",
        "/credentials",
        "/dev/dri",
        "/dev/snd",
        "/dev/input",
        "/dev/kvm",
      ];
      const mountProbeSource = [
        "const fs=require('node:fs')",
        "const crypto=require('node:crypto')",
        `const readonlyPaths=${JSON.stringify(readonlyPaths)}`,
        `const absentPaths=${JSON.stringify(absentPaths)}`,
        "process.stdin.resume()",
        "process.stdin.once('end',()=>{",
        " const hashes={}; const writesDenied={}; const absent={}",
        " for(const path of readonlyPaths){",
        "  hashes[path]=crypto.createHash('sha256').update(fs.readFileSync(path)).digest('hex')",
        "  try{fs.appendFileSync(path,Buffer.from('forbidden'));writesDenied[path]=false}catch{writesDenied[path]=true}",
        " }",
        " for(const path of absentPaths) absent[path]=!fs.existsSync(path)",
        " let deviceCreateDenied=false",
        " try{fs.writeFileSync('/dev/chronorift-host-gate','forbidden')}catch{deviceCreateDenied=true}",
        " let nullDeviceWritable=true",
        " try{fs.writeFileSync('/dev/null','ok')}catch{nullDeviceWritable=false}",
        " process.stdout.write(JSON.stringify({hashes,writesDenied,absent,credentialEnvironmentVisible:process.env.CHRONORIFT_HOST_GATE_CREDENTIAL_SENTINEL!==undefined,deviceCreateDenied,nullDeviceWritable}))",
        "})",
      ].join("\n");
      process.env.CHRONORIFT_HOST_GATE_CREDENTIAL_SENTINEL = "host-only-secret";
      let mountProbe;
      try {
        mountProbe = await broker.openDuplex({
          schemaVersion: 1,
          operationId: "pe-host-gate-readonly-overlays",
          profile: "godot-headless",
          argv: [
            managedRuntime.capability.nodeTarget,
            "--input-type=commonjs",
            "--eval",
            mountProbeSource,
          ],
          cwd: "/workspace",
          environment: {},
          timeoutMs: 10_000,
        });
      } finally {
        delete process.env.CHRONORIFT_HOST_GATE_CREDENTIAL_SENTINEL;
      }
      if (mountProbe.kind !== "opened") {
        throw new Error(`PE mount probe did not open: ${mountProbe.kind}`);
      }
      await mountProbe.handle.endInput();
      const mountProbeCompletion = await mountProbe.handle.completion;
      expect(mountProbeCompletion).toMatchObject({
        kind: "executed",
        receipt: {
          status: "succeeded",
          sandboxBackend: "bwrap-direct-cgroup-v2",
          mountAdmission: {
            evidenceBasis: "validated-process-plan",
            profile: "godot-headless",
            workspaceAccess: "read-only",
            operationPrivateWritableTargets: ["/run/chronorift"],
            credentialTargetCount: 0,
          },
          cleanup: {
            processGroupTerminated: true,
            cgroupPopulated: false,
            scopeRemoved: true,
          },
        },
      });
      if (mountProbeCompletion.kind !== "executed") {
        throw new Error("PE mount probe was denied");
      }
      const probe = MountProbeResultSchema.parse(
        JSON.parse(
          Buffer.from(mountProbeCompletion.stdout).toString("utf8"),
        ) as unknown,
      );
      const expectedHashes: Readonly<Record<string, string>> = {
        "/workspace/project.godot": sha256(
          await readFile(join(layout.workspaceDirectory, "project.godot")),
        ),
        [bridgePath]:
          managedRuntime.capability.addonFiles.find(
            (file) => file.relativePath === "bridge.gd",
          )?.sha256 ?? "missing",
        [sdkPath]:
          managedRuntime.capability.addonFiles.find(
            (file) => file.relativePath === "sdk/snapshot_v1.gd",
          )?.sha256 ?? "missing",
        [managedRuntime.capability.overlayTarget]:
          managedRuntime.capability.overlayHash,
        [adapterPath]: adapterPackage.manifestSha256,
      };
      expect(probe.hashes).toEqual(expectedHashes);
      expect(probe.writesDenied).toEqual(
        Object.fromEntries(readonlyPaths.map((path) => [path, true])),
      );
      expect(probe.absent).toEqual(
        Object.fromEntries(absentPaths.map((path) => [path, true])),
      );
      expect(probe).toMatchObject({
        credentialEnvironmentVisible: false,
        deviceCreateDenied: true,
        nullDeviceWritable: true,
      });

      const externalNetwork = await broker.execute({
        schemaVersion: 1,
        operationId: "pe-host-gate-no-external-network",
        profile: "godot-headless",
        argv: [
          managedRuntime.capability.nodeTarget,
          "--eval",
          [
            "const net=require('node:net')",
            "const socket=net.createConnection({host:'1.1.1.1',port:80})",
            "const timer=setTimeout(()=>process.exit(7),1000)",
            "socket.on('connect',()=>process.exit(8))",
            "socket.on('error',(error)=>{clearTimeout(timer);process.exit(['ENETUNREACH','EHOSTUNREACH','EACCES'].includes(error.code)?0:9)})",
          ].join("\n"),
        ],
        cwd: "/workspace",
        environment: {},
        timeoutMs: 5_000,
      });
      expect(externalNetwork).toMatchObject({
        kind: "executed",
        receipt: { status: "succeeded" },
      });

      const credentialRequest = await broker.execute({
        schemaVersion: 1,
        operationId: "pe-host-gate-deny-credential-environment",
        profile: "godot-headless",
        argv: [
          managedRuntime.capability.nodeTarget,
          "--eval",
          "process.exit(0)",
        ],
        cwd: "/workspace",
        environment: { AWS_SECRET_ACCESS_KEY: "must-not-enter-sandbox" },
      });
      expect(credentialRequest).toMatchObject({
        kind: "denied",
        securityEvent: {
          decision: "denied",
          code: "capability_denied",
          sideEffectStarted: false,
        },
      });
      expect(securityEvents).toHaveLength(1);
      expect(securityEvents[0]).toMatchObject({
        operationId: "pe-host-gate-deny-credential-environment",
        sideEffectStarted: false,
      });

      const boundedOutput = await broker.execute({
        schemaVersion: 1,
        operationId: "pe-host-gate-bounded-output-store",
        profile: "godot-headless",
        argv: [
          "/bin/busybox",
          "sh",
          "-c",
          "/bin/busybox head -c 65536 /dev/zero >/artifacts/store-probe && /bin/busybox head -c 16777217 /dev/zero",
        ],
        cwd: "/workspace",
        environment: {},
      });
      expect(boundedOutput).toMatchObject({
        kind: "executed",
        receipt: {
          status: "succeeded",
          realizedMechanisms: {
            aggregateStorage: "dedicated-capacity-bounded-filesystem-v1",
            unavailable: [],
          },
          stdout: {
            totalBytes: 16_777_217,
            capturedBytes: 16_777_216,
            truncated: true,
          },
        },
      });
      if (boundedOutput.kind !== "executed") {
        throw new Error("PE bounded output/store probe was denied");
      }
      expect(
        boundedOutput.receipt.resourceUsage.aggregateStorage?.usedBytes,
      ).toBeGreaterThanOrEqual(65_536);
      expect(
        boundedOutput.receipt.resourceUsage.aggregateStorage?.usedInodes,
      ).toBeGreaterThanOrEqual(1);
      await expect(
        stat(join(layout.sandboxArtifactScratchDirectory, "store-probe")),
      ).resolves.toMatchObject({ size: 65_536 });

      const driver = createProjectEnvironmentConformanceDriverV1({
        sidecar: new GodotProjectEnvironmentSidecarPortV1({
          broker,
          managedRuntime,
        }),
        managedRuntime: managedRuntime.capability,
        taskId,
        sourceClosureId: `source.v1.${source.projectSourceIdentity}`,
        environmentRevisionId: "environment-revision.v1.host-gate",
        adapterRevisionId: "adapter-revision.v1.host-gate",
        buildId: `build.v1.${source.selectedTreeSha256.slice(0, 48)}`,
        candidateSourceHash: source.selectedTreeSha256,
        expectedMainScene: source.mainScene,
        adapterManifestSha256: adapterPackage.manifestSha256,
        sdkSha256: managedRuntime.sdkDigest,
        bridgeSha256: managedRuntime.bridgeDigest,
        toolchainSha256: godot.receipt.executableSha256,
        engineVersion: managedRuntime.capability.engineVersion,
      });
      const vanilla = await driver.runVanilla();
      const bridgeOnly = await driver.runBridgeOnly();
      const instrumented = await driver.runInstrumented(adapterPackage);
      for (const observation of [vanilla, bridgeOnly, instrumented]) {
        expect(observation).toMatchObject({
          launched: true,
          importSucceeded: true,
          stableWindowObserved: true,
          sourceIdentityReverified: true,
          processTreeTerminated: true,
          isolationGroupEmpty: true,
          scopeRemoved: true,
          scratchRemoved: true,
          storageReconciled: true,
        });
      }
      expect(instrumented).toMatchObject({
        bridgeHandshakeCount: 1,
        captures: 1,
        queries: 2,
        semanticCoverage: "declared",
        bridgeExited: true,
        runtimeFailures: [],
      });
      expect(instrumented.entityLifecycleRecords).toBeGreaterThanOrEqual(1);
      expect(instrumented.stateSamples).toBeGreaterThanOrEqual(1);
      expect(instrumented.stateDomainIds).toContain("world");
    } finally {
      try {
        expect(await broker.cleanup()).toMatchObject({
          processGroupTerminated: true,
          cgroupPopulated: false,
          scopeRemoved: true,
          storageReconciled: true,
        });
      } finally {
        await rm(runtimeRoot, { recursive: true, force: true });
        await rm(sourceRoot, { recursive: true, force: true });
        temporaryRoots.delete(runtimeRoot);
        temporaryRoots.delete(sourceRoot);
      }
    }
    expect(managedRuntime.capability.addonTarget).toBe(
      DEFAULT_PROJECT_ENVIRONMENT_SIDECAR_TARGETS_V1.managedAddonRoot,
    );
  });
});
