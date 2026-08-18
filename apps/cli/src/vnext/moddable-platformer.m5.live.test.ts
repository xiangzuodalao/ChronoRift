import { execFile } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { asTaskId, taskNamespaceDigestV1 } from "@chronorift/domain";
import {
  DEFAULT_SEMANTIC_SIDECAR_TARGETS,
  createSemanticRuntimeSidecarSource,
  createSemanticVanillaSmokeSidecarSource,
} from "@chronorift/godot-adapter";
import { describe, expect, it } from "vitest";

import { readGodotProjectDescriptorSnapshotV1 } from "./godot-project-descriptor.js";
import {
  M5_TASK_SPEC_RAW_SHA256_V1,
  M5_EVIDENCE_SCHEMA_RAW_SHA256_V1,
  collectM5ExecutionEvidenceV1,
  createM5CleanupReceiptV1,
  createM5EvidenceManifestV1,
  createM5EvidenceSummaryV1,
  createM5OwnedTemporaryDirectoryV1,
  createM5StagingRootV1,
  exportM5RuntimeArtifactsV1,
  finalizeM5OwnershipV1,
  publishM5StagingRootV1,
  readM5AgentEvidenceV1,
  readM5ExportedPatchV1,
  readM5PatchIdentityV1,
  readM5SandboxRealizationV1,
  readM5TaskSpecV1,
  removeM5OwnedTemporaryDirectoryV1,
  removeM5StagingRootV1,
  requireM5PostDiscardIsolationV1,
  requireM5PatchExportV1,
  requireM5TrackedGdPathsV1,
  sha256Bytes,
  writeM5CanonicalArtifactV1,
  type M5ArtifactReferenceV1,
  type M5OwnedTemporaryDirectoryV1,
  type M5ProductSubjectV1,
  type M5StagingOwnershipV1,
} from "./m5-external-behavior-conformance.js";
import {
  parseGodotSemanticAdapterProfileSnapshotV1,
  readGodotSemanticAdapterProfileSnapshotV1,
} from "./semantic-adapter-profile.js";
import {
  discardVNextAgentTask,
  exportVNextAgentTaskPatch,
  startVNextAgentTask,
} from "./task-agent.js";

const execFileAsync = promisify(execFile);

const requiredEnvironment = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`M5 live infrastructure requires ${name}`);
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
    },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return result.stdout;
};

interface GitSnapshotV1 {
  readonly commit: string;
  readonly tree: string;
  readonly status: string;
}

const gitSnapshot = async (
  root: string,
  includeIgnored: boolean,
): Promise<GitSnapshotV1> => {
  const [commit, tree, status] = await Promise.all([
    git(root, ["rev-parse", "HEAD"]),
    git(root, ["rev-parse", "HEAD^{tree}"]),
    git(root, [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
      ...(includeIgnored ? ["--ignored=matching"] : []),
    ]),
  ]);
  return Object.freeze({
    commit: commit.trim(),
    tree: tree.trim(),
    status,
  });
};

const sameSnapshot = (left: GitSnapshotV1, right: GitSnapshotV1): boolean =>
  left.commit === right.commit &&
  left.tree === right.tree &&
  left.status === right.status;

const productSubject = (snapshot: GitSnapshotV1): M5ProductSubjectV1 => {
  if (
    !/^[a-f0-9]{40}$/u.test(snapshot.commit) ||
    !/^[a-f0-9]{40}$/u.test(snapshot.tree) ||
    snapshot.status !== ""
  ) {
    throw new Error("M5 product subject must be a clean pinned Git checkout");
  }
  return {
    repositoryCommit: snapshot.commit,
    repositoryTree: snapshot.tree,
    clean: true,
  };
};

const changedPathsFromPatch = async (
  sourceRoot: string,
  patchPath: string,
): Promise<readonly string[]> => {
  const output = await git(sourceRoot, ["apply", "--numstat", "-z", patchPath]);
  const records = output.split("\0").filter((entry) => entry.length > 0);
  const paths = records.map((record) => {
    const first = record.indexOf("\t");
    const second = first < 0 ? -1 : record.indexOf("\t", first + 1);
    if (first < 1 || second < first + 2 || second === record.length - 1) {
      throw new Error("M5 patch numstat output is malformed");
    }
    return record.slice(second + 1);
  });
  if (paths.length === 0) throw new Error("M5 patch changed no paths");
  return Object.freeze([...new Set(paths)].sort());
};

const trackedPaths = async (
  sourceRoot: string,
  paths: readonly string[],
): Promise<readonly string[]> => {
  const tracked: string[] = [];
  for (const path of paths) {
    try {
      const output = await git(sourceRoot, [
        "ls-files",
        "--error-unmatch",
        "--",
        path,
      ]);
      if (output.trim() === path) tracked.push(path);
    } catch {
      // New files are permitted, but at least one pre-existing tracked .gd
      // path is required below.
    }
  }
  return Object.freeze(tracked.sort());
};

const taskRootWasRemoved = async (
  runtimeRoot: string,
  taskId: ReturnType<typeof asTaskId>,
): Promise<boolean> => {
  try {
    await realpath(join(runtimeRoot, "tasks", taskNamespaceDigestV1(taskId)));
    return false;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "ENOENT";
  }
};

const validateStagingBundle = async (input: {
  readonly nodePath: string;
  readonly taskSpecPath: string;
  readonly schemaPath: string;
  readonly stagingRoot: string;
  readonly baselineRoot: string;
}): Promise<void> => {
  await execFileAsync(
    input.nodePath,
    [
      join(process.cwd(), ".github/scripts/validate-vnext-m5-evidence.mjs"),
      input.taskSpecPath,
      input.schemaPath,
      input.stagingRoot,
      input.baselineRoot,
    ],
    {
      cwd: process.cwd(),
      env: {
        PATH: "/usr/bin:/bin",
        LANG: "C",
        LC_ALL: "C",
        TMPDIR: dirname(input.stagingRoot),
      },
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    },
  );
};

describe("M5 frozen moddable-platformer behavior-change live Gate", () => {
  it(
    "runs one Luna/max turn, retains baseline/candidate behavior, and publishes only validated cleanup-bound evidence",
    { timeout: 1_200_000 },
    async () => {
      const repositoryRoot = process.cwd();
      const taskSpecPath = await realpath(
        requiredEnvironment("CHRONORIFT_TEST_M5_TASK_SPEC"),
      );
      const schemaPath = await realpath(
        requiredEnvironment("CHRONORIFT_TEST_M5_EVIDENCE_SCHEMA"),
      );
      // This is deliberately the first M5 input consumed. A drifted prompt or
      // raw spec fails before any Provider request or Task ownership begins.
      const taskSpecSnapshot = await readM5TaskSpecV1(taskSpecPath);
      const schemaRawSha256 = sha256Bytes(await readFile(schemaPath));
      if (
        taskSpecSnapshot.rawSha256 !== M5_TASK_SPEC_RAW_SHA256_V1 ||
        schemaRawSha256 !== M5_EVIDENCE_SCHEMA_RAW_SHA256_V1
      ) {
        throw new Error(
          "M5 task spec or evidence schema raw bytes are not frozen",
        );
      }
      const spec = taskSpecSnapshot.spec;
      if (process.version !== spec.toolchain.nodeVersion) {
        throw new Error(
          "M5 live Host Node version does not match the task spec",
        );
      }

      const sourceRoot = await realpath(
        requiredEnvironment("CHRONORIFT_TEST_EXTERNAL_PROJECT_ROOT"),
      );
      const descriptorPath = await realpath(
        requiredEnvironment("CHRONORIFT_TEST_EXTERNAL_PROJECT_DESCRIPTOR"),
      );
      const adapterPath = await realpath(
        requiredEnvironment(
          "CHRONORIFT_TEST_EXTERNAL_SEMANTIC_ADAPTER_PROFILE",
        ),
      );
      const taskStorageRoot = await realpath(
        requiredEnvironment("CHRONORIFT_TEST_TASK_STORAGE_ROOT"),
      );
      const evidenceRoot = requiredEnvironment(
        "CHRONORIFT_TEST_M5_EVIDENCE_ROOT",
      );
      const nodePath = await realpath(
        requiredEnvironment("CHRONORIFT_TEST_NODE_BIN"),
      );
      const godotPath = await realpath(
        requiredEnvironment("CHRONORIFT_TEST_GODOT_BIN"),
      );
      const godotVersion = (
        await execFileAsync(godotPath, ["--version"], {
          encoding: "utf8",
          env: { LANG: "C", LC_ALL: "C" },
        })
      ).stdout.trim();
      const managedNodeVersion = (
        await execFileAsync(nodePath, ["--version"], {
          encoding: "utf8",
          env: { LANG: "C", LC_ALL: "C" },
        })
      ).stdout.trim();
      if (
        managedNodeVersion !== spec.toolchain.nodeVersion ||
        godotVersion !== spec.toolchain.godotVersion
      ) {
        throw new Error("M5 live toolchain does not match the task spec");
      }

      const [sourceBefore, productBefore, descriptorBytes, adapterBytes] =
        await Promise.all([
          gitSnapshot(sourceRoot, true),
          gitSnapshot(repositoryRoot, false),
          readFile(descriptorPath),
          readFile(adapterPath),
        ]);
      if (
        sourceBefore.commit !== spec.source.headCommit ||
        sourceBefore.tree !== spec.source.gitTreeObjectId ||
        sourceBefore.status !== "" ||
        sha256Bytes(descriptorBytes) !== spec.source.descriptorRawSha256 ||
        sha256Bytes(adapterBytes) !==
          spec.semanticProfile.adapterProfileRawSha256
      ) {
        throw new Error(
          "M5 frozen external source inputs do not match the spec",
        );
      }
      const frozenProductSubject = productSubject(productBefore);
      if (
        frozenProductSubject.repositoryCommit !==
          requiredEnvironment("CHRONORIFT_TEST_M5_PRODUCT_COMMIT") ||
        frozenProductSubject.repositoryTree !==
          requiredEnvironment("CHRONORIFT_TEST_M5_PRODUCT_TREE")
      ) {
        throw new Error("M5 wrapper and live product subjects do not match");
      }
      const descriptorSnapshot =
        await readGodotProjectDescriptorSnapshotV1(descriptorPath);
      const semanticAdapterProfile =
        await readGodotSemanticAdapterProfileSnapshotV1(adapterPath);
      const parsedSemanticAdapterProfile =
        parseGodotSemanticAdapterProfileSnapshotV1(
          semanticAdapterProfile.bytes,
        );
      if (
        parsedSemanticAdapterProfile.adapterProfileSha256 !==
        spec.semanticProfile.adapterProfileCanonicalSha256
      ) {
        throw new Error("M5 semantic adapter canonical identity drifted");
      }

      const taskId = asTaskId(`task:m5-live-${Date.now()}`);
      const taskCgroupRoot = await realpath(
        requiredEnvironment("CHRONORIFT_TEST_CGROUP_ROOT"),
      );
      const sandboxHost = {
        delegatedCgroupRoot: taskCgroupRoot,
        bwrapPath: requiredEnvironment("CHRONORIFT_TEST_BWRAP_BIN"),
        prlimitPath: requiredEnvironment("CHRONORIFT_TEST_PRLIMIT_BIN"),
        busyboxPath: requiredEnvironment("CHRONORIFT_TEST_BUSYBOX_BIN"),
        taskStorageRoot,
      };
      const sandboxToolchain = {
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
      };
      const managedGodotSemanticRuntime = {
        nodePath,
        godotPath,
        fontconfigProbePath: requiredEnvironment(
          "CHRONORIFT_TEST_FONTCONFIG_PROBE_BIN",
        ),
        shellPath: requiredEnvironment("CHRONORIFT_TEST_BUSYBOX_BIN"),
        xdgUserDirPath: requiredEnvironment("CHRONORIFT_TEST_XDG_USER_DIR_BIN"),
        lddPath: requiredEnvironment("CHRONORIFT_TEST_LDD_BIN"),
        addonRoot: requiredEnvironment(
          "CHRONORIFT_TEST_GODOT_SEMANTIC_ADDON_ROOT",
        ),
        vanillaSidecarSource: createSemanticVanillaSmokeSidecarSource({
          godotExecutable: DEFAULT_SEMANTIC_SIDECAR_TARGETS.godotExecutable,
          workspaceRoot: DEFAULT_SEMANTIC_SIDECAR_TARGETS.workspaceRoot,
          runtimeRoot: DEFAULT_SEMANTIC_SIDECAR_TARGETS.runtimeRoot,
        }),
        semanticSidecarSource: createSemanticRuntimeSidecarSource({
          godotExecutable: DEFAULT_SEMANTIC_SIDECAR_TARGETS.godotExecutable,
          workspaceRoot: DEFAULT_SEMANTIC_SIDECAR_TARGETS.workspaceRoot,
          runtimeRoot: DEFAULT_SEMANTIC_SIDECAR_TARGETS.runtimeRoot,
        }),
      };
      let staging: M5StagingOwnershipV1 | undefined;
      let runtimeOwnership: M5OwnedTemporaryDirectoryV1 | undefined;
      let agentOwnership: M5OwnedTemporaryDirectoryV1 | undefined;
      let discardTask: (() => Promise<void>) | undefined;
      let taskMayExist = false;
      let taskDiscarded = false;
      let stagingPublished = false;
      let primaryFailure: unknown;
      try {
        staging = await createM5StagingRootV1(evidenceRoot);
        runtimeOwnership = await createM5OwnedTemporaryDirectoryV1(
          taskStorageRoot,
          "runtime",
        );
        agentOwnership = await createM5OwnedTemporaryDirectoryV1(
          taskStorageRoot,
          "agent",
        );
        const runtimeRoot = runtimeOwnership.root;
        const agentDir = agentOwnership.root;
        const taskRequest = {
          taskId,
          projectPath: sourceRoot,
          externalProjectDescriptor: descriptorSnapshot,
          semanticAdapterProfile,
          runtimeRoot,
          sandboxHost,
          sandboxToolchain,
          managedGodotSemanticRuntime,
        } as const;
        discardTask = async () => {
          await discardVNextAgentTask(taskRequest);
        };
        taskMayExist = true;
        const turn = await startVNextAgentTask({
          ...taskRequest,
          goal: spec.prompt,
          provider: spec.agentBudget.provider,
          model: spec.agentBudget.model,
          thinkingLevel: spec.agentBudget.thinkingLevel,
          timeoutMs: spec.agentBudget.wallTimeMsMaximum,
          agentDir,
          enableGameTools: true,
        });
        if (turn.loopStatus !== "completed" || turn.turn !== 1) {
          throw new Error(
            `M5 Agent turn ended without a candidate: ${turn.loopStatus}`,
          );
        }
        const agentEvidence = await readM5AgentEvidenceV1({
          runtimeRoot,
          taskId,
          taskSpec: spec,
        });
        await removeM5OwnedTemporaryDirectoryV1(agentOwnership);
        agentOwnership = undefined;
        const exportReceipt = await exportVNextAgentTaskPatch({
          ...taskRequest,
          hostCwd: staging.stagingRoot,
          outputPath: "candidate.patch",
        });
        const [patchIdentity, patchBytes] = await Promise.all([
          readM5PatchIdentityV1({ runtimeRoot, taskId }),
          readM5ExportedPatchV1(staging.stagingRoot),
        ]);
        requireM5PatchExportV1({
          taskId,
          identity: patchIdentity,
          receipt: exportReceipt,
          bytes: patchBytes,
        });
        if (
          patchIdentity.baselineSourceHash !== spec.source.selectedTreeSha256
        ) {
          throw new Error("M5 patch is detached from the frozen baseline");
        }
        const changedPaths = await changedPathsFromPatch(
          sourceRoot,
          join(staging.stagingRoot, "candidate.patch"),
        );
        const tracked = await trackedPaths(sourceRoot, changedPaths);
        requireM5TrackedGdPathsV1(changedPaths, spec.patchContract, tracked);
        const selection = await collectM5ExecutionEvidenceV1({
          taskId,
          runtimeRoot,
          taskSpec: spec,
          patchIdentity,
        });
        const runtimeArtifacts = await exportM5RuntimeArtifactsV1({
          taskId,
          runtimeRoot,
          stagingRoot: staging.stagingRoot,
          selection,
        });
        const patchArtifact: M5ArtifactReferenceV1 = {
          relativePath: "candidate.patch",
          rawSha256: sha256Bytes(patchBytes),
        };
        const exportReceiptArtifact = await writeM5CanonicalArtifactV1({
          stagingRoot: staging.stagingRoot,
          relativePath: "patch-export-receipt.json",
          value: exportReceipt,
        });

        await readM5SandboxRealizationV1({ runtimeRoot, taskId });

        const cleanup = await discardVNextAgentTask(taskRequest);
        taskDiscarded = true;
        taskMayExist = false;
        const [sourceAfter, productAfter, taskRootRemoved] = await Promise.all([
          gitSnapshot(sourceRoot, true),
          gitSnapshot(repositoryRoot, false),
          taskRootWasRemoved(runtimeRoot, taskId),
        ]);
        const sourceUnchanged = sameSnapshot(sourceBefore, sourceAfter);
        if (
          !sourceUnchanged ||
          !sameSnapshot(productBefore, productAfter) ||
          productAfter.status !== "" ||
          !taskRootRemoved
        ) {
          throw new Error(
            "M5 discard did not preserve source/product identity and empty Task storage",
          );
        }
        await removeM5OwnedTemporaryDirectoryV1(runtimeOwnership);
        runtimeOwnership = undefined;
        const postDiscardIsolation = await requireM5PostDiscardIsolationV1({
          taskStorageRoot,
          taskCgroupRoot,
        });
        const cleanupReceipt = createM5CleanupReceiptV1({
          taskId,
          taskSpecSha256: taskSpecSnapshot.rawSha256,
          patchIdentity,
          selection,
          cleanup,
          taskRootRemoved,
          postDiscardIsolation,
          sourceUnchanged,
        });
        const cleanupArtifact = await writeM5CanonicalArtifactV1({
          stagingRoot: staging.stagingRoot,
          relativePath: "cleanup-receipt.json",
          value: cleanupReceipt,
        });
        const summary = createM5EvidenceSummaryV1({
          taskSpec: spec,
          taskSpecSha256: taskSpecSnapshot.rawSha256,
          taskId,
          agent: agentEvidence,
          productSubject: frozenProductSubject,
          patchIdentity,
          patchArtifact,
          exportReceiptArtifact,
          changedPaths,
          runtimeArtifacts,
          cleanupArtifact,
        });
        const summaryArtifact = await writeM5CanonicalArtifactV1({
          stagingRoot: staging.stagingRoot,
          relativePath: "summary.json",
          value: summary,
        });
        const runtimeReferences: readonly M5ArtifactReferenceV1[] = [
          runtimeArtifacts.baseline.build,
          runtimeArtifacts.baseline.runtime,
          runtimeArtifacts.baseline.execution,
          runtimeArtifacts.baseline.events,
          runtimeArtifacts.baseline.executionSeal,
          runtimeArtifacts.candidate.build,
          runtimeArtifacts.candidate.runtime,
          runtimeArtifacts.candidate.execution,
          runtimeArtifacts.candidate.events,
          runtimeArtifacts.candidate.executionSeal,
        ];
        const manifest = createM5EvidenceManifestV1({
          taskSpecSha256: taskSpecSnapshot.rawSha256,
          taskId,
          productSubject: frozenProductSubject,
          artifacts: [
            patchArtifact,
            cleanupArtifact,
            exportReceiptArtifact,
            runtimeReferences[0]!,
            runtimeReferences[1]!,
            runtimeReferences[2]!,
            runtimeReferences[3]!,
            runtimeReferences[4]!,
            runtimeReferences[5]!,
            runtimeReferences[6]!,
            runtimeReferences[7]!,
            runtimeReferences[8]!,
            runtimeReferences[9]!,
            summaryArtifact,
          ],
        });
        await writeM5CanonicalArtifactV1({
          stagingRoot: staging.stagingRoot,
          relativePath: "manifest.json",
          value: manifest,
        });

        await validateStagingBundle({
          nodePath,
          taskSpecPath,
          schemaPath,
          stagingRoot: staging.stagingRoot,
          baselineRoot: sourceRoot,
        });
        const productBeforePublish = await gitSnapshot(repositoryRoot, false);
        if (!sameSnapshot(productBefore, productBeforePublish)) {
          throw new Error("M5 product subject changed before publication");
        }
        await publishM5StagingRootV1(staging);
        stagingPublished = true;
      } catch (error) {
        primaryFailure = error;
      }

      const runtimeCleanup = runtimeOwnership;
      const agentCleanup = agentOwnership;
      const stagingCleanup = staging;
      await finalizeM5OwnershipV1({
        primaryFailure,
        taskMayExist,
        taskDiscarded,
        published: stagingPublished,
        discard: discardTask,
        removeRuntime:
          runtimeCleanup === undefined
            ? undefined
            : () => removeM5OwnedTemporaryDirectoryV1(runtimeCleanup),
        removeAgent:
          agentCleanup === undefined
            ? undefined
            : () => removeM5OwnedTemporaryDirectoryV1(agentCleanup),
        removeStaging:
          stagingCleanup === undefined
            ? undefined
            : () => removeM5StagingRootV1(stagingCleanup),
      });
      expect(stagingPublished).toBe(true);
    },
  );
});
