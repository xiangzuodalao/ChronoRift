import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  asTaskId,
  taskNamespaceDigestV1,
  type TaskId,
} from "@chronorift/domain";
import {
  DEFAULT_RUNTIME_SIDECAR_TARGETS,
  createRuntimeSidecarSource,
} from "@chronorift/godot-adapter";
import { VNextTaskStore } from "@chronorift/json-artifacts";
import { describe, expect, it } from "vitest";

import { WorkspaceMaterializationReceiptV1Schema } from "./contracts.js";
import {
  cleanupFrameInputWindowEvaluatorOwnershipV1,
  cleanupFrameInputWindowReleaseRootV1,
  cleanupFrameInputWindowRetainedOwnershipV1,
  createFrameInputWindowGameToolScenarioRunnerV1,
  type FrameInputWindowEvaluatorTaskFactoryV1,
} from "./frame-input-window-game-tool-runner.js";
import {
  collectM3LiveTaskEvidenceV1,
  createM3LiveAcceptanceSummaryV1,
  planM3LiveAcceptanceAttemptV1,
  runM3BoundedEvaluatorOnlyAcceptanceV1,
  type FrameInputWindowReleaseAcceptanceV1,
} from "./frame-input-window-release-acceptance.js";
import { M1Error } from "./errors.js";
import {
  discardM1Task,
  getM1TaskHostContext,
  getM1TaskGameRuntimeContext,
  prepareM1TaskEnvironment,
  resumeM1TaskEnvironment,
  type M1TaskEnvironment,
  type PrepareM1TaskEnvironmentRequest,
} from "./m1-task-environment.js";
import { SandboxBrokerSetupCleanupError } from "./sandbox-broker.js";
import {
  exportVNextAgentTaskPatch,
  startVNextAgentTask,
} from "./task-agent.js";
import { createVNextGodotRuntimeCoordinator } from "./vnext-godot-runtime-coordinator.js";

const execFileAsync = promisify(execFile);

const requiredEnvironment = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`M3 live infrastructure requires ${name}`);
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
      GIT_AUTHOR_NAME: "ChronoRift M3 Live",
      GIT_AUTHOR_EMAIL: "m3-live@chronorift.invalid",
      GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
      GIT_COMMITTER_NAME: "ChronoRift M3 Live",
      GIT_COMMITTER_EMAIL: "m3-live@chronorift.invalid",
      GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
    },
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return result.stdout;
};

const initializeFixtureRepository = async (
  project: string,
  trustedFixtureRoot: string,
): Promise<void> => {
  await mkdir(project);
  await cp(trustedFixtureRoot, project, { recursive: true });
  await git(project, ["init", "--quiet", "--initial-branch=main"]);
  await git(project, ["add", "--all"]);
  await git(project, ["commit", "--quiet", "-m", "frozen fixture"]);
};

interface M3HostRuntime {
  readonly sandboxHost: PrepareM1TaskEnvironmentRequest["sandboxHost"] & {
    readonly taskStorageRoot: string;
  };
  readonly sandboxToolchain: NonNullable<
    PrepareM1TaskEnvironmentRequest["sandboxToolchain"]
  >;
  readonly managedGodotRuntime: NonNullable<
    PrepareM1TaskEnvironmentRequest["managedGodotRuntime"]
  >;
}

const requireM3HostRuntime = (): M3HostRuntime => {
  const sidecarSource = createRuntimeSidecarSource({
    godotExecutable: DEFAULT_RUNTIME_SIDECAR_TARGETS.godotExecutable,
    workspaceRoot: DEFAULT_RUNTIME_SIDECAR_TARGETS.workspaceRoot,
    runtimeRoot: DEFAULT_RUNTIME_SIDECAR_TARGETS.runtimeRoot,
  });
  return Object.freeze({
    sandboxHost: {
      delegatedCgroupRoot: requiredEnvironment("CHRONORIFT_TEST_CGROUP_ROOT"),
      bwrapPath: requiredEnvironment("CHRONORIFT_TEST_BWRAP_BIN"),
      prlimitPath: requiredEnvironment("CHRONORIFT_TEST_PRLIMIT_BIN"),
      busyboxPath: requiredEnvironment("CHRONORIFT_TEST_BUSYBOX_BIN"),
      taskStorageRoot: requiredEnvironment("CHRONORIFT_TEST_TASK_STORAGE_ROOT"),
    },
    sandboxToolchain: {
      lddPath: requiredEnvironment("CHRONORIFT_TEST_LDD_BIN"),
      commands: [
        {
          target: "/bin/bash",
          hostPath: requiredEnvironment("CHRONORIFT_TEST_BASH_BIN"),
        },
        {
          target: "/usr/bin/find",
          hostPath: requiredEnvironment("CHRONORIFT_TEST_FIND_BIN"),
        },
        {
          target: "/usr/bin/ls",
          hostPath: requiredEnvironment("CHRONORIFT_TEST_LS_BIN"),
        },
        {
          target: "/usr/bin/rg",
          hostPath: requiredEnvironment("CHRONORIFT_TEST_RG_BIN"),
        },
      ],
    },
    managedGodotRuntime: {
      nodePath: requiredEnvironment("CHRONORIFT_TEST_NODE_BIN"),
      godotPath: requiredEnvironment("CHRONORIFT_TEST_GODOT_BIN"),
      fontconfigProbePath: requiredEnvironment(
        "CHRONORIFT_TEST_FONTCONFIG_PROBE_BIN",
      ),
      shellPath: requiredEnvironment("CHRONORIFT_TEST_BUSYBOX_BIN"),
      xdgUserDirPath: requiredEnvironment("CHRONORIFT_TEST_XDG_USER_DIR_BIN"),
      lddPath: requiredEnvironment("CHRONORIFT_TEST_LDD_BIN"),
      addonRoot: requiredEnvironment("CHRONORIFT_TEST_GODOT_ADDON_ROOT"),
      sidecarSource,
    },
  });
};

const taskRuntimeRequest = (input: {
  readonly taskId: TaskId;
  readonly projectPath: string;
  readonly trustedFixtureRoot: string;
  readonly runtimeRoot: string;
  readonly host: M3HostRuntime;
}) => ({
  taskId: input.taskId,
  projectPath: input.projectPath,
  trustedFixtureRoot: input.trustedFixtureRoot,
  runtimeRoot: input.runtimeRoot,
  sandboxHost: input.host.sandboxHost,
  sandboxToolchain: input.host.sandboxToolchain,
  managedGodotRuntime: input.host.managedGodotRuntime,
});

class M3LiveInfrastructureError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "M3LiveInfrastructureError";
  }
}

const retainedSetupCleanupOwner = (
  error: unknown,
): SandboxBrokerSetupCleanupError | undefined => {
  const pending: unknown[] = [error];
  const visited = new Set<unknown>();
  while (pending.length > 0 && visited.size < 16) {
    const current = pending.shift();
    if (current === undefined || visited.has(current)) continue;
    visited.add(current);
    if (current instanceof SandboxBrokerSetupCleanupError) return current;
    if (current instanceof M1Error && current.storedCause !== undefined) {
      pending.push(current.storedCause);
    }
    if (current instanceof AggregateError) {
      pending.push(...(current.errors as readonly unknown[]));
    }
  }
  return undefined;
};

describe("M3 real game-task release acceptance", () => {
  it(
    "gives one Luna/max Agent attempt to a real Task and externally evaluates its immutable candidate",
    { timeout: 1_200_000 },
    async () => {
      const host = requireM3HostRuntime();
      const root = await mkdtemp(join(tmpdir(), "chronorift-m3-live-release-"));
      const storageRunRoot = await mkdtemp(
        join(host.sandboxHost.taskStorageRoot, "chronorift-m3-live-release-"),
      );
      const trustedFixtureRoot = join(
        process.cwd(),
        "fixtures/godot-frame-input-window",
      );
      const agentSource = join(root, "agent-source");
      const taskRuntimeRoot = join(storageRunRoot, "agent-runtime");
      const evaluatorRuntimeRoot = join(storageRunRoot, "evaluator-runtime");
      const exportRoot = join(root, "export");
      const agentDir = join(root, "clean-agent-dir");
      await Promise.all([
        initializeFixtureRepository(agentSource, trustedFixtureRoot),
        mkdir(taskRuntimeRoot),
        mkdir(evaluatorRuntimeRoot),
        mkdir(exportRoot),
        mkdir(agentDir),
      ]);
      expect(await readdir(agentDir)).toEqual([]);

      const agentTaskId = asTaskId(`task:m3-live-${Date.now()}`);
      const agentRuntimeRequest = taskRuntimeRequest({
        taskId: agentTaskId,
        projectPath: agentSource,
        trustedFixtureRoot,
        runtimeRoot: taskRuntimeRoot,
        host,
      });
      const activeEvaluatorEnvironments = new Set<M1TaskEnvironment>();
      const activeRetainedSetupCleanupOwners =
        new Set<SandboxBrokerSetupCleanupError>();
      const cleanupRetainedSetupOwners = async (): Promise<void> => {
        const results = await Promise.allSettled(
          [...activeRetainedSetupCleanupOwners].map((ownership) =>
            cleanupFrameInputWindowRetainedOwnershipV1({
              ownership,
              activeOwnerships: activeRetainedSetupCleanupOwners,
              cleanup: (owner) => owner.retryCleanup(),
            }),
          ),
        );
        const failure = results.find((result) => result.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
      };
      // Release-orchestrator state only. This deliberately lives outside all
      // product Task/runtime stores and provides no cross-process persistence.
      let productTaskCleanupRequired = false;
      let productTaskDiscarded = false;
      let productCleanupEnvironment: Promise<M1TaskEnvironment> | undefined;
      let acceptedRelease: FrameInputWindowReleaseAcceptanceV1 | undefined;
      let evaluatorAttempts = 0;
      try {
        let turn: Awaited<ReturnType<typeof startVNextAgentTask>>;
        try {
          // From this point onward start may have acquired Task/broker
          // ownership even if it rejects before returning a turn.
          productTaskCleanupRequired = true;
          turn = await startVNextAgentTask({
            ...agentRuntimeRequest,
            goal: [
              "Fix this real Godot game so its observable jump-input window is time-consistent.",
              "An attempt_jump input requested at 75,000 microseconds must leave player.jumping=true for every fixed-FPS/physics-TPS pair in {60,120}×{60,120}.",
              "The same input requested at 250,000 microseconds must leave player.jumping=false for all four pairs, and no-input runs must also remain false.",
              "Use the available coding and game tools to investigate and implement a general product fix. Do not change the fixture capability, managed instrumentation, Harness, or acceptance criteria.",
              "Before completing, launch and seal a fresh game execution against the final workspace bytes so the Task records contain final-candidate runtime evidence.",
            ].join("\n"),
            provider: "openai-codex",
            model: "gpt-5.6-luna",
            thinkingLevel: "max",
            timeoutMs: 600_000,
            agentDir,
            enableGameTools: true,
          });
        } catch (error) {
          throw new M3LiveInfrastructureError(
            "live openai-codex/gpt-5.6-luna/max Task could not run; no fallback model or synthetic evidence was used",
            { cause: error },
          );
        }
        if (turn.loopStatus !== "completed") {
          throw new M3LiveInfrastructureError(
            `live Agent Task ended with ${turn.loopStatus}; provider/timeout failure is infrastructure and was not evaluated`,
          );
        }
        expect(turn.activeTools).toEqual(
          expect.arrayContaining([
            "game_capabilities",
            "game_launch",
            "game_step",
          ]),
        );

        const patchOutputPath = "m3-candidate.patch";
        await exportVNextAgentTaskPatch({
          taskId: agentTaskId,
          runtimeRoot: taskRuntimeRoot,
          sandboxHost: host.sandboxHost,
          sandboxToolchain: host.sandboxToolchain,
          managedGodotRuntime: host.managedGodotRuntime,
          hostCwd: exportRoot,
          outputPath: patchOutputPath,
        });
        const patchPath = join(exportRoot, patchOutputPath);
        const patchBytes = await readFile(patchPath);
        expect((await stat(patchPath)).isFile()).toBe(true);
        const collected = await collectM3LiveTaskEvidenceV1({
          taskId: agentTaskId,
          runtimeRoot: taskRuntimeRoot,
        });
        const patchHash = createHash("sha256").update(patchBytes).digest("hex");
        if (
          patchHash !== collected.patchHash ||
          patchBytes.byteLength !== collected.patchByteLength
        ) {
          throw new M3LiveInfrastructureError(
            "exported candidate patch bytes did not match the immutable Task patch identity",
          );
        }
        const frozenPatchPath = join(root, "frozen-candidate.patch");
        await writeFile(frozenPatchPath, patchBytes, {
          flag: "wx",
          mode: 0o400,
        });
        const verifyFrozenPatch = async (): Promise<void> => {
          const current = await readFile(frozenPatchPath);
          const currentHash = createHash("sha256")
            .update(current)
            .digest("hex");
          if (
            currentHash !== collected.patchHash ||
            current.byteLength !== collected.patchByteLength ||
            !current.equals(patchBytes)
          ) {
            throw new M3LiveInfrastructureError(
              "frozen evaluator patch bytes changed after candidate handoff",
            );
          }
        };
        expect(collected.evidence).toMatchObject({
          provider: "openai-codex",
          model: "gpt-5.6-luna",
          thinkingLevel: "max",
          loopStatus: "completed",
          finalCandidateSourceHash: collected.candidateSourceHash,
        });
        expect(collected.evidence.gameToolCallCount).toBeGreaterThan(0);
        expect(
          planM3LiveAcceptanceAttemptV1({
            candidateSourceHash: collected.candidateSourceHash,
            history: [],
          }),
        ).toEqual({
          kind: "agent_attempt",
          candidateSourceHash: collected.candidateSourceHash,
        });
        const baselineWorkspace = await new VNextTaskStore(
          taskRuntimeRoot,
        ).readJson(agentTaskId, "workspace.json", (value) =>
          WorkspaceMaterializationReceiptV1Schema.parse(value),
        );

        const createFactory = (
          attempt: number,
        ): FrameInputWindowEvaluatorTaskFactoryV1 => ({
          create: async (scenario) => {
            const evaluatorTaskId = asTaskId(
              `task:m3-eval:a${attempt}:${scenario.scenarioId.slice("frame-input-window:".length)}`,
            );
            let environment: M1TaskEnvironment;
            try {
              environment = await prepareM1TaskEnvironment(
                taskRuntimeRequest({
                  taskId: evaluatorTaskId,
                  projectPath: agentSource,
                  trustedFixtureRoot,
                  runtimeRoot: evaluatorRuntimeRoot,
                  host,
                }),
              );
            } catch (error) {
              const retainedOwner = retainedSetupCleanupOwner(error);
              if (retainedOwner !== undefined) {
                activeRetainedSetupCleanupOwners.add(retainedOwner);
              }
              throw error;
            }
            activeEvaluatorEnvironments.add(environment);
            if (scenario.subject === "candidate") {
              try {
                await verifyFrozenPatch();
                if (patchBytes.byteLength > 0) {
                  await git(
                    getM1TaskHostContext(environment).workspaceDirectory,
                    ["apply", "--whitespace=nowarn", frozenPatchPath],
                  );
                }
              } catch (error) {
                await cleanupFrameInputWindowEvaluatorOwnershipV1({
                  ownership: environment,
                  activeOwnerships: activeEvaluatorEnvironments,
                  cleanup: discardM1Task,
                });
                throw error;
              }
            }
            const context = getM1TaskGameRuntimeContext(environment);
            const coordinator = createVNextGodotRuntimeCoordinator(context);
            return {
              taskId: evaluatorTaskId,
              port: coordinator,
              close: async () => {
                let coordinatorFailure: unknown;
                try {
                  await coordinator.close();
                } catch (error) {
                  coordinatorFailure = error;
                }
                await cleanupFrameInputWindowEvaluatorOwnershipV1({
                  ownership: environment,
                  activeOwnerships: activeEvaluatorEnvironments,
                  cleanup: discardM1Task,
                });
                if (coordinatorFailure !== undefined) {
                  throw new M3LiveInfrastructureError(
                    "external evaluator coordinator close failed after Task cleanup",
                    { cause: coordinatorFailure },
                  );
                }
              },
            };
          },
        });
        const evaluated = await runM3BoundedEvaluatorOnlyAcceptanceV1({
          baselineSourceHash: baselineWorkspace.selectedTreeSha256,
          candidateSourceHash: collected.candidateSourceHash,
          taskEvidence: collected.evidence,
          maximumAttempts: 2,
          beforeRetry: cleanupRetainedSetupOwners,
          createRunner: (attempt) =>
            createFrameInputWindowGameToolScenarioRunnerV1({
              factory: createFactory(attempt),
            }),
        });
        const acceptance = evaluated.acceptance;
        evaluatorAttempts = evaluated.attempts;
        if (acceptance.outcome === "infrastructure_failure") {
          expect(
            planM3LiveAcceptanceAttemptV1({
              candidateSourceHash: collected.candidateSourceHash,
              history: evaluated.history,
            }),
          ).toEqual({
            kind: "evaluator_retry",
            releaseCandidateId: acceptance.releaseCandidateId,
            candidateSourceHash: collected.candidateSourceHash,
          });
          throw new M3LiveInfrastructureError(
            `external game evaluator infrastructure failed: ${acceptance.message}`,
          );
        }
        if (!acceptance.accepted) {
          expect(() =>
            planM3LiveAcceptanceAttemptV1({
              candidateSourceHash: collected.candidateSourceHash,
              history: evaluated.history,
            }),
          ).toThrow(/different candidate source identity/u);
        } else {
          expect(
            planM3LiveAcceptanceAttemptV1({
              candidateSourceHash: collected.candidateSourceHash,
              history: evaluated.history,
            }),
          ).toEqual({
            kind: "complete",
            releaseCandidateId: acceptance.releaseCandidateId,
            candidateSourceHash: collected.candidateSourceHash,
          });
        }
        expect(acceptance.scenarios).toHaveLength(13);
        expect(acceptance.taskEvidenceFailures).toEqual([]);
        expect(acceptance.accepted).toBe(true);
        acceptedRelease = acceptance;

        const productRecordNames = await readdir(
          join(
            taskRuntimeRoot,
            "tasks",
            taskNamespaceDigestV1(agentTaskId),
            "records",
          ),
        );
        expect(productRecordNames.join("\n")).not.toMatch(
          /acceptance|verdict|oracle|evaluation/iu,
        );
      } finally {
        try {
          await cleanupFrameInputWindowReleaseRootV1({
            activeEvaluatorOwnerships: activeEvaluatorEnvironments,
            cleanupEvaluator: discardM1Task,
            activeRetainedCleanupOwnerships: activeRetainedSetupCleanupOwners,
            cleanupRetainedOwnership: (owner) => owner.retryCleanup(),
            ...(productTaskCleanupRequired && !productTaskDiscarded
              ? {
                  cleanupProductTask: async () => {
                    let environment: M1TaskEnvironment;
                    try {
                      productCleanupEnvironment ??= resumeM1TaskEnvironment({
                        taskId: agentTaskId,
                        runtimeRoot: taskRuntimeRoot,
                        sandboxHost: host.sandboxHost,
                        sandboxToolchain: host.sandboxToolchain,
                        managedGodotRuntime: host.managedGodotRuntime,
                      });
                      environment = await productCleanupEnvironment;
                    } catch (error) {
                      productCleanupEnvironment = undefined;
                      throw error;
                    }
                    return discardM1Task(environment);
                  },
                  onProductCleanupProven: () => {
                    productTaskDiscarded = true;
                  },
                }
              : {}),
            removeTemporaryRoot: () =>
              rm(storageRunRoot, { recursive: true, force: true }).then(() =>
                rm(root, { recursive: true, force: true }),
              ),
          });
        } catch (error) {
          throw new M3LiveInfrastructureError(
            `release cleanup was not proven; retained evidence roots ${root} and ${storageRunRoot}`,
            { cause: error },
          );
        }
      }
      if (acceptedRelease === undefined) {
        throw new M3LiveInfrastructureError(
          "accepted release evidence was unavailable after proven cleanup",
        );
      }
      const summary = createM3LiveAcceptanceSummaryV1({
        acceptance: acceptedRelease,
        evaluatorAttempts,
        cleanupProven: true,
      });
      process.stdout.write(`[chronorift-m3-live] ${JSON.stringify(summary)}\n`);
    },
  );
});
