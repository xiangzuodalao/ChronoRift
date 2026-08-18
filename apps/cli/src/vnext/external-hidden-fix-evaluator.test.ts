import { createHash } from "node:crypto";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { asSha256DigestV1 } from "@chronorift/domain";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createExternalHiddenFixEvaluationRequestV1,
  createExternalHiddenFixFreshEvaluationPlanV1,
  openExternalHiddenFixAssignmentStoreV1,
  type CreateExternalHiddenFixAssignmentV1Input,
  type ExternalHiddenFixAssignmentStoreV1,
  type ExternalHiddenFixAssignmentV1,
} from "./external-hidden-fix.js";
import {
  ExternalHiddenFixWorkflowAuditV1Schema,
  checkExternalHiddenFixWorkflowV1,
  createExternalHiddenFixWorkflowAuditV1,
} from "./external-hidden-fix-workflow.js";
import {
  BwrapExternalHiddenFixEvaluatorProcessV1,
  CgroupBwrapExternalHiddenFixEvaluatorProcessV1,
  EXTERNAL_HIDDEN_FIX_EVALUATOR_LIMITS_V1,
  LocalExternalHiddenFixFreshCopyRunnerV1,
  LocalExternalHiddenFixPatchStoreV1,
  NodeExternalHiddenFixEvaluatorProcessV1,
  runLocalExternalHiddenFixEvaluatorOnceV1,
  type ExternalHiddenFixEvaluatorProcessInputV1,
  type ExternalHiddenFixEvaluatorProcessPortV1,
  type ExternalHiddenFixFreshCopyInfrastructureErrorV1,
} from "./external-hidden-fix-evaluator.js";
import { collectCandidateGodotSourceV1 } from "./candidate-godot-build.js";
import { CgroupSetupCleanupErrorV1 } from "./cgroup-v2.js";
import {
  assertSandboxTaskStorageHeadroomV1,
  inspectSandboxTaskStorageRoot,
} from "./sandbox-preflight.js";
import { selectedTreeSha256 } from "./selected-tree.js";

const digest = (value: string | Uint8Array) =>
  asSha256DigestV1(createHash("sha256").update(value).digest("hex"));

const verifiedWorkflow = (input: {
  readonly assignmentId: string;
  readonly baselineSelectedTreeSha256: ReturnType<typeof digest>;
}) => {
  const candidateSelectedTreeSha256 = expectedCandidateTree();
  const patchIdentity = {
    schemaVersion: 1 as const,
    baselineSelectedTreeSha256: input.baselineSelectedTreeSha256,
    candidateSelectedTreeSha256,
    patchSha256: digest(patchBytes),
    byteLength: patchBytes.byteLength,
  };
  const workflowInput = {
    schemaVersion: 1 as const,
    assignmentId: input.assignmentId,
    agentTurnCount: 1,
    agentLoopStatus: "completed" as const,
    baselineSelectedTreeSha256: input.baselineSelectedTreeSha256,
    patchIdentity,
    patchObservedAt: "2026-08-14T00:00:05.000Z",
    patchAdmissible: true,
    patchRoundTripVerified: true,
    sourceObservations: [
      {
        schemaVersion: 1 as const,
        boundary: "game_build_freeze" as const,
        sourceSha256: input.baselineSelectedTreeSha256,
        buildId: "build.baseline",
        observedAt: "2026-08-14T00:00:01.000Z",
      },
      {
        schemaVersion: 1 as const,
        boundary: "coding_tool_return" as const,
        sourceSha256: candidateSelectedTreeSha256,
        buildId: null,
        observedAt: "2026-08-14T00:00:03.000Z",
      },
      {
        schemaVersion: 1 as const,
        boundary: "game_build_freeze" as const,
        sourceSha256: candidateSelectedTreeSha256,
        buildId: "build.candidate",
        observedAt: "2026-08-14T00:00:03.100Z",
      },
    ],
    executions: [
      {
        schemaVersion: 1 as const,
        executionId: "execution.baseline",
        buildId: "build.baseline",
        sourceSha256: input.baselineSelectedTreeSha256,
        startedAt: "2026-08-14T00:00:01.100Z",
        endedAt: "2026-08-14T00:00:02.000Z",
        sealed: true,
        coverageComplete: true,
        cleanupProven: true,
        publicSymptomObserved: true,
        publicObservationSha256: digest("baseline observation"),
      },
      {
        schemaVersion: 1 as const,
        executionId: "execution.candidate",
        buildId: "build.candidate",
        sourceSha256: candidateSelectedTreeSha256,
        startedAt: "2026-08-14T00:00:03.200Z",
        endedAt: "2026-08-14T00:00:04.000Z",
        sealed: true,
        coverageComplete: true,
        cleanupProven: true,
        publicSymptomObserved: false,
        publicObservationSha256: digest("candidate observation"),
      },
    ],
    taskCleanupProven: true,
  };
  const receipt = checkExternalHiddenFixWorkflowV1(workflowInput);
  return {
    receipt,
    audit: createExternalHiddenFixWorkflowAuditV1({
      workflowInput,
      workflowReceipt: receipt,
    }),
  };
};

const patchBytes = Buffer.from(
  [
    "diff --git a/scripts/player.gd b/scripts/player.gd",
    "--- a/scripts/player.gd",
    "+++ b/scripts/player.gd",
    "@@ -1 +1 @@",
    "-extends Node",
    "+extends CharacterBody2D",
    "",
  ].join("\n"),
);

const evaluatorImplementation = `
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const workspace = process.env.CHRONORIFT_M6_WORKSPACE;
const cache = process.env.CHRONORIFT_M6_IMPORT_CACHE;
const bundlePath = process.env.CHRONORIFT_M6_EVALUATOR_BUNDLE;
const scenario = process.env.CHRONORIFT_M6_SCENARIO_CLASS;
const repetition = Number(process.env.CHRONORIFT_M6_REPETITION);
const marker = join(cache, "oracle-used");
const bundle = JSON.parse(readFileSync(bundlePath, "utf8"));
let forbiddenPathHidden = true;
if (typeof bundle.forbiddenPath === "string") {
  try {
    readFileSync(bundle.forbiddenPath);
    forbiddenPathHidden = false;
  } catch (error) {
    forbiddenPathHidden = error && error.code === "ENOENT";
  }
}
const sourceMatches =
  readFileSync(join(workspace, "scripts", "player.gd"), "utf8") ===
  "extends CharacterBody2D\\n";
const cacheWasFresh = !existsSync(marker);
writeFileSync(marker, String(process.pid), { flag: "wx", mode: 0o600 });
mkdirSync(join(workspace, ".godot"), { recursive: true });
writeFileSync(join(workspace, ".godot", "oracle-cache"), scenario);
const passed =
  sourceMatches && cacheWasFresh && forbiddenPathHidden &&
  bundle.failScenario !== scenario;
process.stdout.write(JSON.stringify({
  schemaVersion: 1,
  outcome: passed ? "passed" : "failed",
  observation: {
    pid: process.pid,
    scenario,
    repetition,
    workspace,
    cache
  }
}));
`;

interface Fixture {
  readonly parent: string;
  readonly hiddenRoot: string;
  readonly exposedRoot: string;
  readonly baselineRoot: string;
  readonly temporaryRoot: string;
  readonly evaluatorImplementationPath: string;
  readonly evaluatorBundlePath: string;
  readonly store: ExternalHiddenFixAssignmentStoreV1;
  readonly patchStore: LocalExternalHiddenFixPatchStoreV1;
  readonly assignment: ExternalHiddenFixAssignmentV1;
}

const fixtureParents: string[] = [];

afterEach(async () => {
  await Promise.all(
    fixtureParents
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

const writePrivate = async (path: string, bytes: string): Promise<void> => {
  await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
  await chmod(path, 0o600);
};

const createFixture = async (
  bundle:
    | Readonly<Record<string, unknown>>
    | ((paths: {
        readonly hiddenRoot: string;
        readonly exposedRoot: string;
      }) => unknown),
  implementation = evaluatorImplementation,
): Promise<Fixture> => {
  const parent = await mkdtemp(join(tmpdir(), "chronorift-m6-local-eval-"));
  fixtureParents.push(parent);
  await chmod(parent, 0o700);
  const hiddenRoot = join(parent, "host-only");
  const exposedRoot = join(parent, "agent-exposed");
  const baselineRoot = join(hiddenRoot, "mutated-baseline");
  const temporaryRoot = join(parent, "evaluator-temporary");
  await Promise.all([
    mkdir(hiddenRoot, { mode: 0o700 }),
    mkdir(exposedRoot, { mode: 0o700 }),
    mkdir(temporaryRoot, { mode: 0o700 }),
  ]);
  await mkdir(baselineRoot, { mode: 0o700 });
  await mkdir(join(baselineRoot, "scripts"), { mode: 0o755 });
  await writeFile(join(baselineRoot, "project.godot"), "[application]\n", {
    mode: 0o644,
  });
  await writeFile(
    join(baselineRoot, "scripts", "player.gd"),
    "extends Node\n",
    { mode: 0o644 },
  );
  const mutationBytes = "hidden mutation v1\n";
  const evaluatorBundleValue =
    typeof bundle === "function" ? bundle({ hiddenRoot, exposedRoot }) : bundle;
  const evaluatorBundle = `${JSON.stringify(evaluatorBundleValue)}\n`;
  const mutationPath = join(hiddenRoot, "mutation.patch");
  const evaluatorImplementationPath = join(hiddenRoot, "evaluator.mjs");
  const evaluatorBundlePath = join(hiddenRoot, "evaluator-bundle.json");
  await Promise.all([
    writePrivate(mutationPath, mutationBytes),
    writePrivate(evaluatorImplementationPath, implementation),
    writePrivate(evaluatorBundlePath, evaluatorBundle),
  ]);
  const store = await openExternalHiddenFixAssignmentStoreV1({
    root: hiddenRoot,
    exposedRoots: [exposedRoot],
  });
  const patchStore = await LocalExternalHiddenFixPatchStoreV1.open({
    root: hiddenRoot,
    exposedRoots: [exposedRoot],
  });
  const assignmentInput: CreateExternalHiddenFixAssignmentV1Input = {
    schemaVersion: 1,
    subjectProjectSha256: digest("subject"),
    pristineSelectedTreeSha256: digest("pristine"),
    mutatedBaselineSelectedTreeSha256: selectedTreeSha256(
      await collectCandidateGodotSourceV1(
        baselineRoot,
        "project-environment",
        "tracked-tool-scripts-v1",
      ),
    ),
    publicTaskSpecSha256: digest("public task"),
    taskBlindAdapterSha256: digest("frozen adapter"),
    mutationSha256: digest(mutationBytes),
    evaluatorImplementationSha256: digest(implementation),
    evaluatorBundleSha256: digest(evaluatorBundle),
    baselineRoot,
    mutationPath,
    evaluatorImplementationPath,
    evaluatorBundlePath,
    createdAt: "2026-08-14T00:00:00.000Z",
  };
  const assignment = await store.createAssignment(assignmentInput);
  await store.beginAttemptOnce({
    binding: {
      schemaVersion: 1,
      assignmentId: assignment.assignmentId,
      agentProjectionContentSha256: digest("projection"),
      publicTaskSpecSha256: assignment.publicTaskSpecSha256,
      taskId: "task:m6-evaluator-test",
      provider: "test-provider",
      model: "test-model",
      thinkingLevel: "max",
      agentBudgetSha256: digest("agent budget"),
      workspaceBaselineSelectedTreeSha256:
        assignment.mutatedBaselineSelectedTreeSha256,
      taskBlindAdapterSha256: assignment.taskBlindAdapterSha256,
      admittedToolSetSha256: digest("admitted tools"),
      sandboxRealizationSha256: digest("sandbox realization"),
    },
    startedAt: "2026-08-14T00:00:01.000Z",
  });
  const workflow = verifiedWorkflow({
    assignmentId: assignment.assignmentId,
    baselineSelectedTreeSha256: assignment.mutatedBaselineSelectedTreeSha256,
  });
  await store.putWorkflowAuditOnce({
    assignmentId: assignment.assignmentId,
    audit: workflow.audit,
    parse: (value) => ExternalHiddenFixWorkflowAuditV1Schema.parse(value),
  });
  await store.putWorkflowReceiptOnce(workflow.receipt, (value) =>
    ExternalHiddenFixWorkflowAuditV1Schema.parse(value),
  );
  return {
    parent,
    hiddenRoot,
    exposedRoot,
    baselineRoot,
    temporaryRoot,
    evaluatorImplementationPath,
    evaluatorBundlePath,
    store,
    patchStore,
    assignment,
  };
};

const expectedCandidateTree = () =>
  selectedTreeSha256([
    {
      relativePath: "project.godot",
      mode: "100644",
      content: Buffer.from("[application]\n"),
    },
    {
      relativePath: "scripts/player.gd",
      mode: "100644",
      content: Buffer.from("extends CharacterBody2D\n"),
    },
  ]);

const prepareEvaluation = async (value: Fixture) => {
  const patch = await value.patchStore.publishOnce(patchBytes);
  const request = createExternalHiddenFixEvaluationRequestV1({
    assignmentId: value.assignment.assignmentId,
    patch,
    expectedCandidateSelectedTreeSha256: expectedCandidateTree(),
  });
  return { patch, request };
};

const createRunner = async (
  value: Fixture,
  evaluator: ExternalHiddenFixEvaluatorProcessPortV1,
) =>
  LocalExternalHiddenFixFreshCopyRunnerV1.open({
    temporaryRoot: value.temporaryRoot,
    exposedRoots: [value.exposedRoot],
    patchStore: value.patchStore,
    evaluator,
  });

const temporaryRootIsEmpty = async (root: string): Promise<boolean> =>
  (await readdir(root)).length === 0;

const firstFreshRunInput = (
  value: Fixture,
  patch: Awaited<ReturnType<Fixture["patchStore"]["publishOnce"]>>,
  expectedCandidateSelectedTreeSha256 = expectedCandidateTree(),
) => {
  const plan = createExternalHiddenFixFreshEvaluationPlanV1(
    value.assignment.assignmentId,
  )[0];
  if (plan === undefined) throw new Error("missing M6 evaluation plan");
  return {
    assignmentId: value.assignment.assignmentId,
    baselineRoot: value.baselineRoot,
    baselineSelectedTreeSha256:
      value.assignment.mutatedBaselineSelectedTreeSha256,
    evaluatorImplementationPath: value.evaluatorImplementationPath,
    evaluatorImplementationSha256:
      value.assignment.evaluatorImplementationSha256,
    evaluatorBundlePath: value.evaluatorBundlePath,
    evaluatorBundleSha256: value.assignment.evaluatorBundleSha256,
    patch,
    expectedCandidateSelectedTreeSha256,
    plan,
  };
};

const processIsGone = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ESRCH"
    );
  }
};

describe("M6 local fresh-copy evaluator", () => {
  it("resolves one narrow request and runs nine new workspaces, caches, and processes", async () => {
    const value = await createFixture({ failScenario: null });
    const { request } = await prepareEvaluation(value);
    const observed: ExternalHiddenFixEvaluatorProcessInputV1[] = [];
    const nodeEvaluator = new NodeExternalHiddenFixEvaluatorProcessV1({
      timeoutMs: 10_000,
    });
    const evaluate = vi.fn(
      async (
        input: ExternalHiddenFixEvaluatorProcessInputV1,
        signal?: AbortSignal,
      ) => {
        observed.push(input);
        return nodeEvaluator.evaluate(input, signal);
      },
    );
    const runner = await createRunner(value, { evaluate });

    const receipt = await runLocalExternalHiddenFixEvaluatorOnceV1({
      store: value.store,
      request,
      runner,
    });

    expect(receipt.outcome).toBe("accepted");
    expect(receipt.completedRuns).toHaveLength(9);
    expect(evaluate).toHaveBeenCalledTimes(9);
    expect(new Set(observed.map((entry) => entry.workspaceRoot)).size).toBe(9);
    expect(new Set(observed.map((entry) => entry.importCacheRoot)).size).toBe(
      9,
    );
    expect(
      observed.map((entry) => [entry.scenarioClass, entry.repetition]),
    ).toEqual(
      createExternalHiddenFixFreshEvaluationPlanV1(
        value.assignment.assignmentId,
      ).map((entry) => [entry.scenarioClass, entry.repetition]),
    );
    expect(receipt.completedRuns.every((entry) => entry.cleanupProven)).toBe(
      true,
    );
    expect(await temporaryRootIsEmpty(value.temporaryRoot)).toBe(true);
    await expect(
      runLocalExternalHiddenFixEvaluatorOnceV1({
        store: value.store,
        request,
        runner,
      }),
    ).rejects.toThrow(/reruns/iu);
    expect(evaluate).toHaveBeenCalledTimes(9);
    expect(
      await value.store.readEvaluatorReceipt(request.assignmentId),
    ).toEqual(receipt);
  });

  it("keeps Agent/runtime roots absent from the evaluator mount namespace", async () => {
    const value = await createFixture(({ exposedRoot }) => ({
      failScenario: null,
      forbiddenPath: join(exposedRoot, "agent-runtime-record.json"),
    }));
    await writeFile(
      join(value.exposedRoot, "agent-runtime-record.json"),
      '{"secret":"must-not-be-readable"}\n',
      { mode: 0o600 },
    );
    const { request } = await prepareEvaluation(value);
    const evaluator = await BwrapExternalHiddenFixEvaluatorProcessV1.open({
      bwrapPath: "/usr/bin/bwrap",
      nodePath: process.execPath,
      forbiddenRoots: [value.hiddenRoot, value.exposedRoot],
      timeoutMs: 10_000,
    });
    const runner = await createRunner(value, {
      evaluate: evaluator.evaluate.bind(evaluator),
    });

    const receipt = await runLocalExternalHiddenFixEvaluatorOnceV1({
      store: value.store,
      request,
      runner,
    });

    expect(receipt.outcome).toBe("accepted");
    expect(receipt.completedRuns).toHaveLength(9);
  });

  it("keeps all nine observations when the hidden oracle rejects a scenario", async () => {
    const value = await createFixture({ failScenario: "hidden_variant" });
    const { request } = await prepareEvaluation(value);
    const nodeEvaluator = new NodeExternalHiddenFixEvaluatorProcessV1({
      timeoutMs: 10_000,
    });
    const evaluate = vi.fn(nodeEvaluator.evaluate.bind(nodeEvaluator));
    const runner = await createRunner(value, { evaluate });

    const receipt = await runLocalExternalHiddenFixEvaluatorOnceV1({
      store: value.store,
      request,
      runner,
    });

    expect(receipt.outcome).toBe("rejected");
    expect(receipt.completedRuns).toHaveLength(9);
    expect(evaluate).toHaveBeenCalledTimes(9);
    expect(
      receipt.completedRuns.filter((entry) => entry.outcome === "failed"),
    ).toHaveLength(3);
    expect(
      receipt.completedRuns
        .filter((entry) => entry.outcome === "failed")
        .every((entry) => entry.scenarioClass === "hidden_variant"),
    ).toBe(true);
    expect(await temporaryRootIsEmpty(value.temporaryRoot)).toBe(true);
  });

  it("does not start the oracle for a mismatched candidate and still cleans the fresh copy", async () => {
    const value = await createFixture({ failScenario: null });
    const { patch } = await prepareEvaluation(value);
    const evaluate = vi.fn(() => {
      throw new Error("oracle must not run");
    });
    const runner = await createRunner(value, { evaluate });

    await expect(
      runner.runFreshCopy(
        firstFreshRunInput(value, patch, digest("wrong candidate")),
      ),
    ).rejects.toMatchObject({
      failureCode: "candidate_tree_mismatch",
      cleanupProven: true,
    } satisfies Partial<ExternalHiddenFixFreshCopyInfrastructureErrorV1>);
    expect(evaluate).not.toHaveBeenCalled();
    expect(await temporaryRootIsEmpty(value.temporaryRoot)).toBe(true);

    const protectedPatchPath = join(
      value.hiddenRoot,
      `${patch.artifactId.slice("m6-artifact:".length)}.patch`,
    );
    const alias = join(value.parent, "patch-alias");
    await link(protectedPatchPath, alias);
    await expect(value.patchStore.read(patch)).rejects.toThrow(
      /private file/iu,
    );
    expect(await readFile(alias)).toEqual(patchBytes);
  });

  it("revalidates frozen evaluator bytes immediately before the oracle starts", async () => {
    const value = await createFixture({ failScenario: null });
    const { patch } = await prepareEvaluation(value);
    await writeFile(value.evaluatorBundlePath, "tampered evaluator bundle\n");
    await chmod(value.evaluatorBundlePath, 0o600);
    const evaluate = vi.fn(() => {
      throw new Error("oracle must not run with changed bytes");
    });
    const runner = await createRunner(value, { evaluate });

    await expect(
      runner.runFreshCopy(firstFreshRunInput(value, patch)),
    ).rejects.toMatchObject({
      failureCode: "assignment_mismatch",
      cleanupProven: true,
    } satisfies Partial<ExternalHiddenFixFreshCopyInfrastructureErrorV1>);
    expect(evaluate).not.toHaveBeenCalled();
    expect(await temporaryRootIsEmpty(value.temporaryRoot)).toBe(true);
  });

  it("kills the entire Linux evaluator process group on timeout or abort before reporting cleanup", async () => {
    const timeoutImplementation = `
import { writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";

const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  stdio: "ignore"
});
writeFileSync(
  join(process.env.CHRONORIFT_M6_IMPORT_CACHE, "descendant-pid"),
  String(descendant.pid),
  { flag: "wx", mode: 0o600 }
);
setInterval(() => {}, 1000);
`;
    const value = await createFixture({}, timeoutImplementation);
    for (const stopKind of ["timeout", "abort"] as const) {
      const workspaceRoot = join(value.parent, `${stopKind}-workspace`);
      const importCacheRoot = join(value.parent, `${stopKind}-cache`);
      await Promise.all([
        mkdir(workspaceRoot, { mode: 0o700 }),
        mkdir(importCacheRoot, { mode: 0o700 }),
      ]);
      const evaluator = new NodeExternalHiddenFixEvaluatorProcessV1({
        timeoutMs: stopKind === "timeout" ? 250 : 10_000,
      });
      const controller = new AbortController();
      const abortTimer =
        stopKind === "abort"
          ? setTimeout(() => {
              controller.abort();
            }, 250)
          : undefined;

      try {
        await expect(
          evaluator.evaluate(
            {
              evaluatorImplementationPath: value.evaluatorImplementationPath,
              evaluatorBundlePath: value.evaluatorBundlePath,
              workspaceRoot,
              importCacheRoot,
              freshCopyId: "m6-fresh-copy:000000000000000000000000",
              scenarioClass: "public_reproduction",
              repetition: 1,
            },
            controller.signal,
          ),
        ).rejects.toMatchObject({
          processStarted: true,
          cleanupProven: true,
        });
      } finally {
        if (abortTimer !== undefined) clearTimeout(abortTimer);
      }
      const descendantPid = Number(
        await readFile(join(importCacheRoot, "descendant-pid"), "utf8"),
      );
      expect(Number.isSafeInteger(descendantPid)).toBe(true);
      expect(processIsGone(descendantPid)).toBe(true);
    }
  });

  it("attaches the formal evaluator before authorization and enforces cgroup, tmpfs, and headroom bounds", async () => {
    const parent = await mkdtemp(
      join(tmpdir(), "chronorift-evaluator-bounds-"),
    );
    fixtureParents.push(parent);
    const taskStorageRoot = join(parent, "task-storage");
    const evaluatorTemporaryRoot = join(parent, "evaluator-storage");
    const workspaceRoot = join(evaluatorTemporaryRoot, "run", "workspace");
    const importCacheRoot = join(evaluatorTemporaryRoot, "run", "cache");
    await Promise.all([
      mkdir(taskStorageRoot, { mode: 0o700 }),
      mkdir(workspaceRoot, { recursive: true, mode: 0o700 }),
      mkdir(importCacheRoot, { recursive: true, mode: 0o700 }),
    ]);
    const filesystem = {
      name: "tmpfs",
      type: 0x01021994n,
      blockSize: 4_096n,
      totalBlocks: 262_144n,
      freeBlocks: 131_072n,
      totalInodes: 131_072n,
      freeInodes: 65_536n,
    };
    const storageInspection = {
      currentUid: () => process.geteuid?.(),
      canonicalize: (path: string) => Promise.resolve(path),
      inspectPath: (path: string) =>
        Promise.resolve({
          kind: "directory" as const,
          device:
            path === taskStorageRoot
              ? 10n
              : path === evaluatorTemporaryRoot
                ? 11n
                : 1n,
          inode: path === taskStorageRoot ? 10n : 11n,
          uid: process.geteuid?.() ?? 1_000,
          mode:
            path === taskStorageRoot || path === evaluatorTemporaryRoot
              ? 0o40700
              : 0o40755,
        }),
      inspectFileSystem: () => Promise.resolve(filesystem),
    };
    const taskStorage = await inspectSandboxTaskStorageRoot(
      taskStorageRoot,
      storageInspection,
    );
    const events: string[] = [];
    const onHeadroomObserved = vi.fn(async () => {
      events.push("headroom-observed");
    });
    let launchPlan: { executable: string; args: readonly string[] } | undefined;
    let realizedLimits: unknown;
    const scope = {
      scopeIdentity: "evaluator-scope",
      attach: vi.fn(async () => {
        events.push("attach");
      }),
      verifyAttached: vi.fn(async () => {
        events.push("verify");
      }),
      usage: vi.fn(),
      kill: vi.fn(async () => false),
      populated: vi.fn(async () => false),
      remove: vi.fn(async () => {
        events.push("scope-remove");
      }),
    };
    const controller = {
      createExecutionScope: vi.fn(async (_operationId, limits) => {
        realizedLimits = limits;
        events.push("scope-create");
        return scope;
      }),
      cleanup: vi.fn(async () => {
        events.push("controller-cleanup");
      }),
    };
    const evaluatorStdout = JSON.stringify({
      schemaVersion: 1,
      outcome: "passed",
      observation: { bounded: true },
    });
    const session = {
      pid: 4242,
      stdout: Readable.from([evaluatorStdout]),
      stderr: Readable.from([]),
      inspectCgroupMembership: vi.fn(async () => {
        events.push("inspect");
        return "/evaluator/task";
      }),
      launch: vi.fn(
        async (plan: { executable: string; args: readonly string[] }) => {
          launchPlan = plan;
          events.push("launch");
        },
      ),
      waitForChildStarted: vi.fn(async () => {
        events.push("child-started");
        return 4243;
      }),
      waitForSandboxStatus: vi.fn(async () => {
        events.push("status");
        return { "child-pid": 4243 };
      }),
      writeStdin: vi.fn(),
      endStdin: vi.fn(async () => undefined),
      provideStdin: vi.fn(),
      authorize: vi.fn(async () => {
        events.push("authorize");
      }),
      terminate: vi.fn(async () => undefined),
      waitForChildExit: vi.fn(async () => ({ exitCode: 0, signal: null })),
      waitForBootstrapExit: vi.fn(async () => ({ exitCode: 0, signal: null })),
    };
    const evaluator = await CgroupBwrapExternalHiddenFixEvaluatorProcessV1.open(
      {
        bwrapPath: process.execPath,
        nodePath: process.execPath,
        prlimitPath: process.execPath,
        delegatedCgroupRoot: "/sys/fs/cgroup/evaluator-test",
        taskId: "task:evaluator:test",
        assertTaskStorageHeadroom: () =>
          assertSandboxTaskStorageHeadroomV1(
            taskStorage.capability,
            taskStorageRoot,
            storageInspection,
          ),
        onHeadroomObserved,
        now: () => "2026-08-16T00:00:00.000Z",
        taskStorageRoot,
        evaluatorTemporaryRoot,
        forbiddenRoots: [],
      },
      {
        storageInspection,
        cgroup: {
          createController: vi.fn(async () => controller),
          startBootstrap: vi.fn(async () => session as never),
          waitForEmpty: vi.fn(async () => undefined),
        },
      },
    );

    await expect(
      evaluator.evaluate({
        evaluatorImplementationPath: join(parent, "evaluator.mjs"),
        evaluatorBundlePath: join(parent, "bundle.json"),
        workspaceRoot,
        importCacheRoot,
        freshCopyId: "m6-fresh-copy:bounded",
        scenarioClass: "hidden_variant",
        repetition: 2,
      }),
    ).resolves.toMatchObject({
      processStarted: true,
      processCleanupProven: true,
      outcome: "passed",
    });
    expect(realizedLimits).toEqual(EXTERNAL_HIDDEN_FIX_EVALUATOR_LIMITS_V1);
    expect(onHeadroomObserved).toHaveBeenCalledOnce();
    expect(onHeadroomObserved).toHaveBeenCalledWith({
      runOrdinal: 1,
      taskStorage: {
        schemaVersion: 1,
        availableBytes: 536_870_912,
        availableInodes: 65_536,
        requiredAvailableBytes: 268_435_456,
        requiredAvailableInodes: 16_384,
      },
      evaluatorStorage: {
        schemaVersion: 1,
        availableBytes: 536_870_912,
        availableInodes: 65_536,
        requiredAvailableBytes: 268_435_456,
        requiredAvailableInodes: 16_384,
      },
      observedAt: "2026-08-16T00:00:00.000Z",
    });
    expect(events.indexOf("headroom-observed")).toBeLessThan(
      events.indexOf("scope-create"),
    );
    expect(events.indexOf("attach")).toBeLessThan(events.indexOf("launch"));
    expect(events.indexOf("status")).toBeLessThan(events.indexOf("authorize"));
    expect(launchPlan?.args).toEqual(
      expect.arrayContaining([
        "--nofile=1024:1024",
        "--fsize=1073741824:1073741824",
        "--block-fd",
        "3",
        "--json-status-fd",
        "4",
      ]),
    );
    await expect(evaluator.cleanup()).resolves.toMatchObject({
      runCount: 1,
      activeRunCount: 0,
      cleanupProven: true,
    });
  });

  it("fails before cgroup or process acquisition when evaluator tmpfs headroom is exhausted", async () => {
    const parent = await mkdtemp(join(tmpdir(), "chronorift-evaluator-full-"));
    fixtureParents.push(parent);
    const taskStorageRoot = join(parent, "task-storage");
    const evaluatorTemporaryRoot = join(parent, "evaluator-storage");
    const workspaceRoot = join(evaluatorTemporaryRoot, "run", "workspace");
    const importCacheRoot = join(evaluatorTemporaryRoot, "run", "cache");
    await Promise.all([
      mkdir(taskStorageRoot, { mode: 0o700 }),
      mkdir(workspaceRoot, { recursive: true, mode: 0o700 }),
      mkdir(importCacheRoot, { recursive: true, mode: 0o700 }),
    ]);
    let evaluatorFreeBlocks = 131_072n;
    const storageInspection = {
      currentUid: () => process.geteuid?.(),
      canonicalize: (path: string) => Promise.resolve(path),
      inspectPath: (path: string) =>
        Promise.resolve({
          kind: "directory" as const,
          device:
            path === taskStorageRoot
              ? 20n
              : path === evaluatorTemporaryRoot
                ? 21n
                : 1n,
          inode: path === taskStorageRoot ? 20n : 21n,
          uid: process.geteuid?.() ?? 1_000,
          mode:
            path === taskStorageRoot || path === evaluatorTemporaryRoot
              ? 0o40700
              : 0o40755,
        }),
      inspectFileSystem: (path: string) =>
        Promise.resolve({
          name: "tmpfs",
          type: 0x01021994n,
          blockSize: 4_096n,
          totalBlocks: 262_144n,
          freeBlocks:
            path === evaluatorTemporaryRoot ? evaluatorFreeBlocks : 131_072n,
          totalInodes: 131_072n,
          freeInodes: 65_536n,
        }),
    };
    const taskStorage = await inspectSandboxTaskStorageRoot(
      taskStorageRoot,
      storageInspection,
    );
    const createController = vi.fn();
    const onHeadroomObserved = vi.fn(async () => undefined);
    const evaluator = await CgroupBwrapExternalHiddenFixEvaluatorProcessV1.open(
      {
        bwrapPath: process.execPath,
        nodePath: process.execPath,
        prlimitPath: process.execPath,
        delegatedCgroupRoot: "/sys/fs/cgroup/evaluator-test",
        taskId: "task:evaluator:full",
        assertTaskStorageHeadroom: () =>
          assertSandboxTaskStorageHeadroomV1(
            taskStorage.capability,
            taskStorageRoot,
            storageInspection,
          ),
        onHeadroomObserved,
        now: () => "2026-08-16T00:00:00.000Z",
        taskStorageRoot,
        evaluatorTemporaryRoot,
        forbiddenRoots: [],
      },
      {
        storageInspection,
        cgroup: { createController },
      },
    );
    evaluatorFreeBlocks = 65_535n;

    await expect(
      evaluator.evaluate({
        evaluatorImplementationPath: join(parent, "evaluator.mjs"),
        evaluatorBundlePath: join(parent, "bundle.json"),
        workspaceRoot,
        importCacheRoot,
        freshCopyId: "m6-fresh-copy:full",
        scenarioClass: "regression_control",
        repetition: 1,
      }),
    ).rejects.toMatchObject({
      processStarted: false,
      cleanupProven: true,
    });
    expect(createController).not.toHaveBeenCalled();
    expect(onHeadroomObserved).not.toHaveBeenCalled();

    evaluatorFreeBlocks = 131_072n;
    onHeadroomObserved.mockRejectedValueOnce(
      new Error("headroom persistence failed"),
    );
    await expect(
      evaluator.evaluate({
        evaluatorImplementationPath: join(parent, "evaluator.mjs"),
        evaluatorBundlePath: join(parent, "bundle.json"),
        workspaceRoot,
        importCacheRoot,
        freshCopyId: "m6-fresh-copy:observation-failure",
        scenarioClass: "regression_control",
        repetition: 2,
      }),
    ).rejects.toMatchObject({
      processStarted: false,
      cleanupProven: true,
    });
    expect(onHeadroomObserved).toHaveBeenCalledTimes(1);
    expect(onHeadroomObserved).toHaveBeenLastCalledWith(
      expect.objectContaining({ runOrdinal: 1 }),
    );
    expect(createController).not.toHaveBeenCalled();
    await expect(readdir(importCacheRoot)).resolves.toEqual([]);

    const retryCleanup = vi.fn(async () => undefined);
    createController.mockRejectedValueOnce(
      new CgroupSetupCleanupErrorV1(
        new Error("controller setup failed"),
        new Error("controller rollback failed"),
        retryCleanup,
      ),
    );
    await expect(
      evaluator.evaluate({
        evaluatorImplementationPath: join(parent, "evaluator.mjs"),
        evaluatorBundlePath: join(parent, "bundle.json"),
        workspaceRoot,
        importCacheRoot,
        freshCopyId: "m6-fresh-copy:setup-failure",
        scenarioClass: "regression_control",
        repetition: 3,
      }),
    ).rejects.toMatchObject({ cleanupProven: true });
    expect(onHeadroomObserved).toHaveBeenCalledTimes(2);
    expect(onHeadroomObserved).toHaveBeenLastCalledWith(
      expect.objectContaining({ runOrdinal: 2 }),
    );
    expect(retryCleanup).toHaveBeenCalledTimes(1);
    await expect(evaluator.cleanup()).resolves.toMatchObject({
      runCount: 1,
      activeRunCount: 0,
      cleanupProven: true,
    });
  });
});
