import { execFile } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { VNextExecutionRecordV1Schema, asTaskId } from "@chronorift/domain";
import {
  DEFAULT_RUNTIME_SIDECAR_TARGETS,
  createRuntimeSidecarSource,
} from "@chronorift/godot-adapter";
import { VNextTaskStore } from "@chronorift/json-artifacts";
import { describe, expect, it } from "vitest";

import { SandboxOperationRecordV1Schema } from "./contracts.js";
import {
  createFrameInputWindowGameToolScenarioRunnerV1,
  type FrameInputWindowEvaluatorTaskFactoryV1,
} from "./frame-input-window-game-tool-runner.js";
import { FrameInputWindowScenarioV1Schema } from "./frame-input-window-release-acceptance.js";
import {
  discardM1Task,
  executeAndRecordM1Command,
  getM1TaskGameRuntimeContext,
  getM1TaskHostContext,
  prepareM1TaskEnvironment,
  suspendM1Task,
  type M1TaskEnvironment,
} from "./m1-task-environment.js";
import { createVNextGodotRuntimeCoordinator } from "./vnext-godot-runtime-coordinator.js";

const execFileAsync = promisify(execFile);

const requiredEnvironment = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is required for Godot sandbox conformance`);
  }
  return value;
};

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
      GIT_AUTHOR_NAME: "ChronoRift M3 Conformance",
      GIT_AUTHOR_EMAIL: "m3-conformance@chronorift.invalid",
      GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
      GIT_COMMITTER_NAME: "ChronoRift M3 Conformance",
      GIT_COMMITTER_EMAIL: "m3-conformance@chronorift.invalid",
      GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
    },
    encoding: "utf8",
  });
  return result.stdout;
};

describe("real M3 Godot runtime inside the Task sandbox", () => {
  it("runs the frozen 120/60/75ms failure over loopback, isolates profiles and network, then seals and cleans up", async () => {
    const delegatedCgroupRoot = requiredEnvironment(
      "CHRONORIFT_TEST_CGROUP_ROOT",
    );
    const nodePath = requiredEnvironment("CHRONORIFT_TEST_NODE_BIN");
    const godotPath = requiredEnvironment("CHRONORIFT_TEST_GODOT_BIN");
    const addonRoot = requiredEnvironment("CHRONORIFT_TEST_GODOT_ADDON_ROOT");
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
    const taskStorageRoot = requiredEnvironment(
      "CHRONORIFT_TEST_TASK_STORAGE_ROOT",
    );

    const root = await mkdtemp(join(tmpdir(), "chronorift-m3-godot-sandbox-"));
    const project = join(root, "source");
    const runtimeRoot = await mkdtemp(
      join(taskStorageRoot, "chronorift-m3-godot-sandbox-"),
    );
    const trustedFixtureRoot = join(
      process.cwd(),
      "fixtures/godot-frame-input-window",
    );
    await mkdir(project);
    await cp(trustedFixtureRoot, project, { recursive: true });
    await git(project, ["init", "--quiet", "--initial-branch=main"]);
    await git(project, ["add", "--all"]);
    await git(project, ["commit", "--quiet", "-m", "frozen fixture"]);

    const taskId = asTaskId(`task:m3-godot-sandbox-${Date.now()}`);
    let environment: M1TaskEnvironment | undefined;
    let suspended = false;
    let discarded = false;
    try {
      environment = await prepareM1TaskEnvironment({
        taskId,
        projectPath: project,
        trustedFixtureRoot,
        runtimeRoot,
        sandboxHost: {
          delegatedCgroupRoot,
          bwrapPath,
          prlimitPath,
          busyboxPath,
          taskStorageRoot,
        },
        sandboxToolchain: {
          lddPath,
          commands: [
            { target: "/bin/bash", hostPath: bashPath },
            { target: "/usr/bin/find", hostPath: findPath },
            { target: "/usr/bin/ls", hostPath: lsPath },
            { target: "/usr/bin/rg", hostPath: rgPath },
          ],
        },
        managedGodotRuntime: {
          nodePath,
          godotPath,
          fontconfigProbePath,
          shellPath: busyboxPath,
          xdgUserDirPath,
          lddPath,
          addonRoot,
          sidecarSource: createRuntimeSidecarSource({
            godotExecutable: DEFAULT_RUNTIME_SIDECAR_TARGETS.godotExecutable,
            workspaceRoot: DEFAULT_RUNTIME_SIDECAR_TARGETS.workspaceRoot,
            runtimeRoot: DEFAULT_RUNTIME_SIDECAR_TARGETS.runtimeRoot,
          }),
        },
      });

      expect(environment.policy).toMatchObject({
        schemaVersion: 2,
        network: "isolated",
        profileBindings: {
          "coding-default": { managedRuntimeId: null },
          "godot-headless": {
            managedRuntimeId:
              environment.managedRuntimeCapability?.managedRuntimeId,
            workspaceAccess: "read-only",
          },
        },
      });
      const managedRuntime = environment.managedRuntimeCapability;
      if (
        managedRuntime === undefined ||
        environment.policy.schemaVersion !== 2
      ) {
        throw new Error(
          "managed runtime capability and policy were not realized",
        );
      }
      expect(managedRuntime.fontconfigTarget).toBe(
        DEFAULT_RUNTIME_SIDECAR_TARGETS.fontconfigFile,
      );
      expect(managedRuntime.fontconfigByteLength).toBeGreaterThan(0);
      expect(managedRuntime.fontconfigSha256).toMatch(/^[a-f0-9]{64}$/u);
      const managedRuntimeFiles = new Map(
        managedRuntime.toolchain.files.map((file) => [file.target, file]),
      );
      expect(
        managedRuntimeFiles.get(DEFAULT_RUNTIME_SIDECAR_TARGETS.shellExecutable)
          ?.command,
      ).toBe(false);
      expect(
        managedRuntimeFiles.get(
          DEFAULT_RUNTIME_SIDECAR_TARGETS.xdgUserDirExecutable,
        )?.command,
      ).toBe(false);
      expect(
        managedRuntimeFiles.has(
          DEFAULT_RUNTIME_SIDECAR_TARGETS.fontconfigProbeExecutable,
        ),
      ).toBe(false);
      const fontconfigLibrary = managedRuntime.toolchain.files.find((file) =>
        file.target.endsWith("/libfontconfig.so.1"),
      );
      expect(fontconfigLibrary?.command).toBe(false);
      if (fontconfigLibrary === undefined) {
        throw new Error("managed fontconfig dependency was not realized");
      }
      const codingReadonlyTargets =
        environment.policy.profileBindings["coding-default"].readonlyTargets;
      const godotReadonlyTargets =
        environment.policy.profileBindings["godot-headless"].readonlyTargets;
      for (const target of [
        DEFAULT_RUNTIME_SIDECAR_TARGETS.shellExecutable,
        DEFAULT_RUNTIME_SIDECAR_TARGETS.xdgUserDirExecutable,
        DEFAULT_RUNTIME_SIDECAR_TARGETS.fontconfigFile,
        fontconfigLibrary.target,
      ]) {
        expect(codingReadonlyTargets).not.toContain(target);
        expect(godotReadonlyTargets).toContain(target);
      }

      const codingIsolation = await executeAndRecordM1Command(environment, {
        schemaVersion: 1,
        operationId: "m3-coding-profile-no-godot",
        profile: "coding-default",
        argv: [
          "/bin/busybox",
          "sh",
          "-c",
          [
            "test ! -e /opt/chronorift/bin/node",
            "test ! -e /opt/chronorift/bin/godot",
            "test ! -e /opt/chronorift/bin/fc-match",
            "test ! -e /bin/sh",
            "test ! -e /usr/bin/xdg-user-dir",
            "test ! -e /opt/chronorift/etc/fontconfig/fonts.conf",
            "! /bin/busybox touch /escape 2>/dev/null",
            "! /bin/busybox touch /dev/escape 2>/dev/null",
            "printf x > /dev/null",
            "/bin/busybox touch /tmp/bounded-write",
            "/bin/busybox rm /tmp/bounded-write",
          ].join(" && "),
        ],
        cwd: "/workspace",
        environment: {},
      });
      expect(codingIsolation).toMatchObject({
        kind: "executed",
        receipt: { status: "succeeded" },
      });

      const managedNodeTarget = managedRuntime.nodeTarget;
      const externalNetwork = await executeAndRecordM1Command(environment, {
        schemaVersion: 1,
        operationId: "m3-godot-profile-no-external-network",
        profile: "godot-headless",
        argv: [
          managedNodeTarget,
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

      const hostContext = getM1TaskHostContext(environment);
      const workspaceProject = join(
        hostContext.workspaceDirectory,
        "project.godot",
      );
      const workspaceBytesBefore = await readFile(workspaceProject);
      const rejectedWorkspaceTarget = join(
        hostContext.workspaceDirectory,
        ".chronorift-godot-write-probe",
      );
      const readonlyMounts = await executeAndRecordM1Command(environment, {
        schemaVersion: 1,
        operationId: "m3-godot-profile-readonly-inputs",
        profile: "godot-headless",
        argv: [
          managedNodeTarget,
          "--eval",
          [
            "const fs=require('node:fs')",
            "const parent='/run/chronorift/project/addons'",
            "const addon='/run/chronorift/project/addons/chronorift/plugin.cfg'",
            "for(const path of ['/bin/sh','/usr/bin/xdg-user-dir','/opt/chronorift/etc/fontconfig/fonts.conf']){if(!fs.existsSync(path))process.exit(10)}",
            "if(fs.existsSync('/opt/chronorift/bin/fc-match'))process.exit(11)",
            "fs.writeFileSync('/dev/null','x')",
            "fs.writeFileSync('/run/chronorift/bounded-scratch-proof','x')",
            "const original=fs.readFileSync(addon)",
            "const attempts=[",
            "()=>fs.writeFileSync('/escape','unbounded'),",
            "()=>fs.writeFileSync('/dev/escape','unbounded'),",
            "()=>fs.writeFileSync('/workspace/project.godot','mutated'),",
            "()=>fs.writeFileSync('/workspace/.chronorift-godot-write-probe','new'),",
            "()=>fs.writeFileSync('/bin/sh','mutated'),",
            "()=>fs.writeFileSync('/usr/bin/xdg-user-dir','mutated'),",
            "()=>fs.writeFileSync('/opt/chronorift/etc/fontconfig/fonts.conf','mutated'),",
            "()=>fs.chmodSync(addon,0o600),",
            "()=>fs.writeFileSync(addon,'mutated'),",
            "()=>fs.renameSync(addon,addon+'.moved'),",
            "()=>fs.unlinkSync(addon),",
            "()=>{fs.renameSync(parent,parent+'.hidden');fs.mkdirSync(parent+'/chronorift',{recursive:true});fs.writeFileSync(addon,'fake')} ]",
            "for(let i=0;i<attempts.length;i++){try{attempts[i]();process.exit(20+i)}catch(error){if(!['EROFS','EACCES','EPERM','EBUSY'].includes(error.code))process.exit(40+i)}try{if(!fs.readFileSync(addon).equals(original))process.exit(60+i)}catch{process.exit(80+i)}}",
          ].join("\n"),
        ],
        cwd: "/workspace",
        environment: {},
        timeoutMs: 5_000,
      });
      expect(
        readonlyMounts,
        JSON.stringify({
          status:
            readonlyMounts.kind === "executed"
              ? readonlyMounts.receipt.status
              : readonlyMounts.kind,
          exitCode:
            readonlyMounts.kind === "executed"
              ? readonlyMounts.receipt.exitCode
              : null,
          stdout:
            readonlyMounts.kind === "executed"
              ? Buffer.from(readonlyMounts.stdout).toString("utf8")
              : "",
          stderr:
            readonlyMounts.kind === "executed"
              ? Buffer.from(readonlyMounts.stderr).toString("utf8")
              : "",
        }),
      ).toMatchObject({
        kind: "executed",
        receipt: { status: "succeeded" },
      });
      await expect(readFile(workspaceProject)).resolves.toEqual(
        workspaceBytesBefore,
      );
      await expect(lstat(rejectedWorkspaceTarget)).rejects.toMatchObject({
        code: "ENOENT",
      });

      const context = getM1TaskGameRuntimeContext(environment);
      const coordinator = createVNextGodotRuntimeCoordinator(context);
      let cleanupReceipt: Awaited<ReturnType<typeof suspendM1Task>> | undefined;
      const factory: FrameInputWindowEvaluatorTaskFactoryV1 = {
        create: () =>
          Promise.resolve({
            taskId,
            port: coordinator,
            close: async () => {
              await coordinator.close();
              cleanupReceipt = await suspendM1Task(environment!);
              suspended = true;
            },
          }),
      };
      const baselineScenario = FrameInputWindowScenarioV1Schema.parse({
        schemaVersion: 1,
        scenarioId: "frame-input-window:333333333333333333333333",
        subject: "baseline",
        expectedSourceHash: environment.workspace.selectedTreeSha256,
        fixedFps: 120,
        physicsTicksPerSecond: 60,
        inputTimeUs: 75_000,
        expectedJumping: false,
      });
      const observed = await createFrameInputWindowGameToolScenarioRunnerV1({
        factory,
      }).run(baselineScenario);
      expect(observed).toMatchObject({
        sourceHash: environment.workspace.selectedTreeSha256,
        realizedFixedFps: 120,
        realizedPhysicsTicksPerSecond: 60,
        requestedInputTimeUs: 75_000,
        jumping: false,
        runtimeStatus: "completed",
        protocolErrors: [],
        droppedEventCount: 0,
        observationComplete: true,
      });
      expect(observed.realizedInputTimeUs).toBeGreaterThanOrEqual(75_000);
      expect(observed.realizedInputTimeUs).toBeLessThan(83_334);
      expect(cleanupReceipt).toMatchObject({
        processGroupTerminated: true,
        cgroupPopulated: false,
        scopeRemoved: true,
      });

      const summary = await environment.runtimeStore.summarize();
      expect(summary.executions).toHaveLength(1);
      expect(summary.executions[0]).toMatchObject({ sealed: true });
      const executionId = summary.executions[0]!.executionId;
      const execution = await environment.runtimeStore.readResource(
        "execution",
        executionId,
        (value) => VNextExecutionRecordV1Schema.parse(value),
      );
      expect(execution).toMatchObject({
        taskId,
        executionId,
        buildId: execution.manifest.buildId,
        status: "stopped",
        sealed: true,
        termination: { code: "requested_stop" },
      });
      expect(execution.loss).toEqual([]);
      const godotStderr = execution.events
        .filter((event) => event.payload["kind"] === "godot_stderr")
        .map((event) => {
          const bytesBase64 = event.payload["bytesBase64"];
          if (typeof bytesBase64 !== "string") {
            throw new Error("Godot stderr diagnostic bytes were not encoded");
          }
          return Buffer.from(bytesBase64, "base64").toString("utf8");
        })
        .join("\n");
      expect(godotStderr).not.toContain(
        "libfontconfig.so.1: cannot open shared object file",
      );
      expect(godotStderr).not.toContain(
        'Cannot create pipe from command: "xdg-user-dir"',
      );
      expect(godotStderr).not.toContain("Fontconfig error");
      const windowTransition = execution.events.find(
        (event) =>
          event.kind === "state" &&
          event.payload["eventType"] === "property_changed" &&
          event.payload["statePath"] === "player.window_open" &&
          event.payload["after"] === true,
      );
      const leftLedgeSignal = execution.events.find(
        (event) =>
          event.kind === "signal" &&
          event.payload["eventType"] === "signal_emitted" &&
          event.payload["name"] === "player.left_ledge",
      );
      const leftLedgeDelivery = execution.events.find(
        (event) =>
          event.kind === "signal" &&
          event.payload["eventType"] === "signal_delivery" &&
          event.payload["name"] === "player.left_ledge",
      );
      expect(windowTransition).toMatchObject({
        channel: "probe",
        payload: {
          entity: { stableId: "player", incarnation: 1 },
          value: true,
        },
      });
      expect(leftLedgeSignal?.observedRelations).toEqual([
        {
          schemaVersion: 1,
          kind: "scheduled_by",
          targetEventId: windowTransition?.eventId,
        },
      ]);
      expect(leftLedgeDelivery).toMatchObject({
        payload: { delivered: true, receiver: "player" },
        observedRelations: [
          {
            schemaVersion: 1,
            kind: "delivery",
            targetEventId: leftLedgeSignal?.eventId,
          },
        ],
      });
      expect(
        execution.events.filter((event) => event.kind === "relation").length,
      ).toBeGreaterThanOrEqual(2);

      const operationRecords = await new VNextTaskStore(runtimeRoot).readLedger(
        taskId,
        "sandbox-operations.jsonl",
        (value) => SandboxOperationRecordV1Schema.parse(value),
      );
      const sidecarOperations = operationRecords.filter((record) =>
        record.receipt.requested.operationId.startsWith("game-runtime:"),
      );
      expect(sidecarOperations).toHaveLength(1);
      expect(sidecarOperations[0]).toMatchObject({
        receipt: {
          status: "succeeded",
          realizedMechanisms: {
            aggregateStorage: "dedicated-capacity-bounded-filesystem-v1",
            unavailable: [],
          },
          requested: {
            profile: "godot-headless",
          },
          cleanup: {
            cgroupPopulated: false,
            scopeRemoved: true,
          },
        },
      });
      expect(
        sidecarOperations[0]!.receipt.resourceUsage.aggregateStorage?.usedBytes,
      ).toBeGreaterThanOrEqual(0);
      expect(
        sidecarOperations[0]!.receipt.resourceUsage.aggregateStorage
          ?.usedInodes,
      ).toBeGreaterThanOrEqual(0);
      expect(sidecarOperations[0]!.receipt.requested.argv.slice(0, 3)).toEqual([
        managedNodeTarget,
        "--input-type=commonjs",
        "--eval",
      ]);
      expect(sidecarOperations[0]!.receipt.requested.argv).toHaveLength(4);
      // The only Host-launched managed process is the sidecar Node process.
      // Its successful authenticated Godot handshake therefore proves Godot
      // was its descendant in the same network/mount/PID sandbox, where
      // external networking above was unavailable but loopback succeeded.
      expect(
        operationRecords.some((record) =>
          record.receipt.requested.argv.includes(
            DEFAULT_RUNTIME_SIDECAR_TARGETS.godotExecutable,
          ),
        ),
      ).toBe(false);

      await discardM1Task(environment);
      discarded = true;
    } finally {
      const cleanupFailures: unknown[] = [];
      if (environment !== undefined && !discarded) {
        let suspendFailure: unknown;
        if (!suspended) {
          try {
            await suspendM1Task(environment);
          } catch (error) {
            suspendFailure = error;
          }
        }
        try {
          await discardM1Task(environment);
          discarded = true;
        } catch (error) {
          if (suspendFailure !== undefined) {
            cleanupFailures.push(suspendFailure);
          }
          cleanupFailures.push(error);
        }
      }
      if (cleanupFailures.length > 0) {
        throw new AggregateError(
          cleanupFailures,
          `M3 Godot sandbox cleanup was not proven; retained ${root} and ${runtimeRoot}`,
        );
      }
      await rm(runtimeRoot, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });
});
