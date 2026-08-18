import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rm,
  type FileHandle,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  AdapterConformanceReceiptV1Schema,
  JsonValueSchema,
  ProjectAdapterRevisionIdSchema,
  ProjectAdapterRevisionV1Schema,
  ProjectCapabilitySetV1Schema,
  Sha256DigestV1Schema,
  asSha256DigestV1,
  asTaskId,
  type ProjectAdapterRevisionV1,
  type AdapterConformanceReceiptV1,
  type Sha256DigestV1,
} from "@chronorift/domain";
import {
  PROJECT_ADAPTER_PACKAGE_LIMITS_V1,
  loadProjectAdapterPackageV1,
  type LoadedProjectAdapterPackageV1,
  type ProjectAdapterPackageBytesV1,
} from "@chronorift/godot-adapter";
import {
  canonicalJson,
  projectEnvironmentPackageContentDigestV1,
} from "@chronorift/json-artifacts";
import { z } from "zod";

import {
  ExternalHiddenFixAssignmentV1Schema,
  openExternalHiddenFixAssignmentStoreV1,
  type ExternalHiddenFixAssignmentV1,
} from "./external-hidden-fix.js";
import { NodeHostGitPort, type HostGitRepositoryContext } from "./host-git.js";
import {
  preflightCleanProjectEnvironmentV1,
  type VerifiedGitTreeEntry,
  type VerifiedProjectEnvironmentSourceV1,
} from "./source-preflight.js";
import { readTrustedSelectedTree } from "./selected-tree.js";
import { createProjectEnvironmentTaskDirectoryLayout } from "./task-paths.js";
import {
  ProjectEnvironmentWorkspaceMaterializationReceiptV1Schema,
  materializePrivateTaskWorkspace,
  type MaterializedProjectEnvironmentWorkspaceV1,
} from "./workspace-materializer.js";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const PUBLIC_TASK_MAX_BYTES = 128 * 1024;
const PRIVATE_ARTIFACT_MAX_BYTES = 512 * 1024 * 1024;
const MAX_ADAPTER_TREE_ENTRIES = 512;

const assignmentIdSchema = z.string().regex(/^m6-assignment:[a-f0-9]{24}$/u);
const gitCommitSchema = z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u);
const opaqueTaskIdSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:+-]*$/u)
  .refine((value) => !value.includes(".."));
const modelTokenSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/u)
  .refine((value) => !value.includes(".."));

const digest = (bytes: string | Uint8Array): Sha256DigestV1 =>
  asSha256DigestV1(createHash("sha256").update(bytes).digest("hex"));

const digestJson = (value: unknown): Sha256DigestV1 =>
  digest(canonicalJson(JsonValueSchema.parse(value)));

const pathWithinOrEqual = (parent: string, candidate: string): boolean => {
  const difference = relative(parent, candidate);
  return (
    difference === "" ||
    (difference !== ".." &&
      !difference.startsWith(`..${sep}`) &&
      !isAbsolute(difference))
  );
};

const assertDisjoint = (left: string, right: string, message: string): void => {
  if (pathWithinOrEqual(left, right) || pathWithinOrEqual(right, left)) {
    throw new Error(message);
  }
};

const currentUserId = (): number => {
  const userId = process.geteuid?.();
  if (userId === undefined) {
    throw new Error("M6 assignment preparation requires ownership checks");
  }
  return userId;
};

const canonicalDirectory = async (
  inputPath: string,
  label: string,
): Promise<string> => {
  const absolutePath = resolve(inputPath);
  const metadata = await lstat(absolutePath);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`${label} must be a real directory`);
  }
  const canonicalPath = await realpath(absolutePath);
  if (canonicalPath !== absolutePath) {
    throw new Error(`${label} must be canonical and contain no symlink`);
  }
  return canonicalPath;
};

const canonicalFile = async (
  inputPath: string,
  label: string,
): Promise<string> => {
  const absolutePath = resolve(inputPath);
  const metadata = await lstat(absolutePath);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`${label} must be a real regular file`);
  }
  const canonicalPath = await realpath(absolutePath);
  if (canonicalPath !== absolutePath) {
    throw new Error(`${label} must be canonical and contain no symlink`);
  }
  return canonicalPath;
};

const requirePrivateDirectory = async (
  inputPath: string,
  label: string,
): Promise<string> => {
  const path = await canonicalDirectory(inputPath, label);
  const metadata = await lstat(path);
  if (
    metadata.uid !== currentUserId() ||
    (metadata.mode & 0o7777) !== PRIVATE_DIRECTORY_MODE
  ) {
    throw new Error(`${label} must be owned by the Host user with mode 0700`);
  }
  return path;
};

const sameFileIdentity = (
  left: Awaited<ReturnType<FileHandle["stat"]>>,
  right: Awaited<ReturnType<FileHandle["stat"]>>,
): boolean =>
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.mode === right.mode &&
  left.nlink === right.nlink &&
  left.size === right.size &&
  left.mtimeMs === right.mtimeMs &&
  left.ctimeMs === right.ctimeMs;

const readStableFile = async (input: {
  readonly path: string;
  readonly label: string;
  readonly maximumBytes: number;
  readonly privateRoot?: string | undefined;
}): Promise<{ readonly path: string; readonly bytes: Uint8Array }> => {
  const path = await canonicalFile(input.path, input.label);
  if (
    input.privateRoot !== undefined &&
    !pathWithinOrEqual(input.privateRoot, path)
  ) {
    throw new Error(`${input.label} must remain in the Host-only root`);
  }
  const pathMetadata = await lstat(path);
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.dev !== pathMetadata.dev ||
      before.ino !== pathMetadata.ino ||
      before.nlink !== pathMetadata.nlink ||
      before.size < 1 ||
      before.size > input.maximumBytes
    ) {
      throw new Error(`${input.label} has unsupported or unstable metadata`);
    }
    if (
      input.privateRoot !== undefined &&
      (before.uid !== currentUserId() ||
        before.nlink !== 1 ||
        (before.mode & 0o7777) !== PRIVATE_FILE_MODE)
    ) {
      throw new Error(
        `${input.label} must be an owned one-link mode-0600 private file`,
      );
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (bytes.byteLength !== before.size || !sameFileIdentity(before, after)) {
      throw new Error(`${input.label} changed while it was read`);
    }
    return Object.freeze({ path, bytes: Uint8Array.from(bytes) });
  } finally {
    await handle.close();
  }
};

const requireFrozenPrivateAdapterTree = async (
  rootInput: string,
  hostOnlyRoot: string,
): Promise<string> => {
  const root = await requirePrivateDirectory(
    rootInput,
    "M6 frozen ProjectAdapter package root",
  );
  if (!pathWithinOrEqual(hostOnlyRoot, root) || root === hostOnlyRoot) {
    throw new Error(
      "M6 frozen ProjectAdapter package must be a child of the Host-only root",
    );
  }
  const pending = [root];
  let entries = 0;
  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined) break;
    const names = await readdir(directory);
    names.sort((left, right) =>
      Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8")),
    );
    for (const name of names) {
      entries += 1;
      if (entries > MAX_ADAPTER_TREE_ENTRIES) {
        throw new Error("M6 frozen ProjectAdapter package is too large");
      }
      const path = join(directory, name);
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) {
        throw new Error("M6 frozen ProjectAdapter package contains a symlink");
      }
      if (metadata.isDirectory()) {
        if (
          metadata.uid !== currentUserId() ||
          (metadata.mode & 0o7777) !== PRIVATE_DIRECTORY_MODE
        ) {
          throw new Error(
            "M6 frozen ProjectAdapter directories must be owned mode-0700 directories",
          );
        }
        pending.push(path);
      } else if (
        !metadata.isFile() ||
        metadata.uid !== currentUserId() ||
        metadata.nlink !== 1 ||
        (metadata.mode & 0o7777) !== PRIVATE_FILE_MODE
      ) {
        throw new Error(
          "M6 frozen ProjectAdapter files must be owned one-link mode-0600 files",
        );
      }
    }
  }
  return root;
};

const readFrozenPrivateAdapterPackageFiles = async (
  root: string,
  loaded: LoadedProjectAdapterPackageV1,
): Promise<readonly ProjectAdapterPackageBytesV1[]> =>
  Object.freeze(
    await Promise.all(
      loaded.files.map(async (expected) => {
        const file = await readStableFile({
          path: join(root, expected.path),
          label: `M6 frozen ProjectAdapter package file ${expected.path}`,
          maximumBytes: PROJECT_ADAPTER_PACKAGE_LIMITS_V1.maximumFileBytes,
          privateRoot: root,
        });
        if (
          file.bytes.byteLength !== expected.bytes ||
          digest(file.bytes) !== expected.sha256
        ) {
          throw new Error(
            "M6 frozen ProjectAdapter package changed after validation",
          );
        }
        return Object.freeze({ path: expected.path, bytes: file.bytes });
      }),
    ),
  );

const ensureSnapshotParents = async (
  root: string,
  relativePath: string,
): Promise<void> => {
  const segments = relativePath.split("/");
  if (
    segments.length === 0 ||
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        segment === ".git",
    ) ||
    relativePath.startsWith("/") ||
    relativePath.includes("\\") ||
    relativePath.includes("\0")
  ) {
    throw new Error("M6 selected source contains an unsafe baseline path");
  }
  let directory = root;
  for (const segment of segments.slice(0, -1)) {
    directory = join(directory, segment);
    try {
      await mkdir(directory, { mode: PRIVATE_DIRECTORY_MODE });
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "EEXIST"
      )) {
        throw error;
      }
    }
    const metadata = await lstat(directory);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error("M6 baseline parent changed type during materialization");
    }
    await chmod(directory, PRIVATE_DIRECTORY_MODE);
  }
};

const writeChunk = async (
  destination: FileHandle,
  chunk: Uint8Array,
  position: number,
): Promise<number> => {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const result = await destination.write(
      chunk,
      offset,
      chunk.byteLength - offset,
      position + offset,
    );
    if (result.bytesWritten === 0) {
      throw new Error("M6 baseline materialization write made no progress");
    }
    offset += result.bytesWritten;
  }
  return position + offset;
};

const digestFileHandle = async (
  handle: FileHandle,
): Promise<Sha256DigestV1> => {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let position = 0;
  while (true) {
    const result = await handle.read(buffer, 0, buffer.byteLength, position);
    if (result.bytesRead === 0) break;
    hash.update(buffer.subarray(0, result.bytesRead));
    position += result.bytesRead;
  }
  return asSha256DigestV1(hash.digest("hex"));
};

const materializeSelectedOnlyBaseline = async (input: {
  readonly sourceWorkspace: string;
  readonly destinationRoot: string;
  readonly entries: readonly VerifiedGitTreeEntry[];
  readonly expectedSelectedTreeSha256: Sha256DigestV1;
}): Promise<string> => {
  await mkdir(input.destinationRoot, { mode: PRIVATE_DIRECTORY_MODE });
  await chmod(input.destinationRoot, PRIVATE_DIRECTORY_MODE);
  const root = await requirePrivateDirectory(
    input.destinationRoot,
    "M6 selected-only mutated baseline root",
  );
  for (const entry of input.entries) {
    await ensureSnapshotParents(root, entry.relativePath);
    const sourcePath = join(input.sourceWorkspace, entry.relativePath);
    const sourceMetadata = await lstat(sourcePath);
    if (sourceMetadata.isSymbolicLink() || !sourceMetadata.isFile()) {
      throw new Error("M6 materialized source entry changed type");
    }
    const source = await open(
      sourcePath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const destination = await open(
      join(root, entry.relativePath),
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      PRIVATE_FILE_MODE,
    );
    try {
      const before = await source.stat();
      if (
        !before.isFile() ||
        before.dev !== sourceMetadata.dev ||
        before.ino !== sourceMetadata.ino ||
        before.size !== entry.byteLength
      ) {
        throw new Error("M6 materialized source entry identity changed");
      }
      let written = 0;
      for await (const rawChunk of source.createReadStream({
        autoClose: false,
        start: 0,
      })) {
        const chunk = Buffer.isBuffer(rawChunk)
          ? rawChunk
          : Buffer.from(rawChunk);
        written = await writeChunk(destination, chunk, written);
        if (written > entry.byteLength) {
          throw new Error("M6 materialized source entry exceeded its size");
        }
      }
      const after = await source.stat();
      if (written !== entry.byteLength || !sameFileIdentity(before, after)) {
        throw new Error("M6 materialized source entry changed while copied");
      }
      await destination.chmod(entry.mode === "100755" ? 0o755 : 0o644);
      await destination.sync();
    } finally {
      await Promise.all([source.close(), destination.close()]);
    }
  }
  if (
    (await readTrustedSelectedTree(root)) !== input.expectedSelectedTreeSha256
  ) {
    throw new Error(
      "M6 selected-only baseline does not reproduce the mutant tree",
    );
  }
  return root;
};

const verifyMutationRoundTrip = async (input: {
  readonly hostOnlyRoot: string;
  readonly pristine: VerifiedProjectEnvironmentSourceV1;
  readonly mutatedSelectedTreeSha256: Sha256DigestV1;
  readonly mutationPath: string;
  readonly mutationSha256: Sha256DigestV1;
}): Promise<void> => {
  const taskId = asTaskId(
    `m6-mutation-check:${digestJson({
      schemaVersion: 1,
      pristineSelectedTreeSha256: input.pristine.selectedTreeSha256,
      mutatedSelectedTreeSha256: input.mutatedSelectedTreeSha256,
      mutationSha256: input.mutationSha256,
    }).slice(0, 32)}`,
  );
  const layout = await createProjectEnvironmentTaskDirectoryLayout({
    runtimeRoot: input.hostOnlyRoot,
    sourceRepositoryRoot: input.pristine.repositoryRoot,
    taskId,
  });
  const taskRootIdentity = await lstat(layout.taskRootDirectory);
  let operationError: unknown;
  try {
    const pristineBaseline = await materializePrivateTaskWorkspace({
      taskId,
      source: input.pristine,
      layout,
    });
    const verificationRoot = await materializeSelectedOnlyBaseline({
      sourceWorkspace: pristineBaseline.workspaceDirectory,
      destinationRoot: join(
        layout.hostOperationTemporaryDirectory,
        "mutation-verification",
      ),
      entries: input.pristine.entries,
      expectedSelectedTreeSha256: input.pristine.selectedTreeSha256,
    });
    const patch = await open(
      input.mutationPath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      if ((await digestFileHandle(patch)) !== input.mutationSha256) {
        throw new Error("M6 mutation artifact changed before round-trip");
      }
      const context: HostGitRepositoryContext = {
        cwd: verificationRoot,
        gitDirectory: join(pristineBaseline.workspaceDirectory, ".git"),
        workTree: verificationRoot,
      };
      const git = new NodeHostGitPort();
      await git.applyPatch({ context, patch, checkOnly: true });
      await git.applyPatch({ context, patch, checkOnly: false });
      if (
        (await readTrustedSelectedTree(verificationRoot)) !==
        input.mutatedSelectedTreeSha256
      ) {
        throw new Error(
          "M6 hidden mutation does not reproduce the frozen mutated source tree",
        );
      }
      if ((await digestFileHandle(patch)) !== input.mutationSha256) {
        throw new Error("M6 mutation artifact changed during round-trip");
      }
    } finally {
      await patch.close();
    }
  } catch (error) {
    operationError = error;
  }
  let cleanupError: unknown;
  try {
    const current = await lstat(layout.taskRootDirectory);
    if (
      current.isSymbolicLink() ||
      !current.isDirectory() ||
      current.dev !== taskRootIdentity.dev ||
      current.ino !== taskRootIdentity.ino
    ) {
      throw new Error("M6 mutation verification root identity changed");
    }
    await rm(layout.taskRootDirectory, { recursive: true, force: false });
  } catch (error) {
    cleanupError = error;
  }
  if (operationError !== undefined) {
    throw new Error(
      `M6 mutation round-trip verification failed: ${
        operationError instanceof Error
          ? operationError.message
          : "unknown error"
      }`,
      { cause: operationError },
    );
  }
  if (cleanupError !== undefined) {
    throw new Error("M6 mutation verification cleanup failed", {
      cause: cleanupError,
    });
  }
};

const decodeUtf8 = (bytes: Uint8Array, label: string): string => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(`${label} must contain strict UTF-8`, { cause: error });
  }
};

const readFrozenAdapterRevision = async (input: {
  readonly path: string;
  readonly hostOnlyRoot: string;
}): Promise<{
  readonly revision: ProjectAdapterRevisionV1;
  readonly rawSha256: Sha256DigestV1;
}> => {
  const file = await readStableFile({
    path: input.path,
    label: "M6 frozen ProjectAdapter revision",
    maximumBytes: 1024 * 1024,
    privateRoot: input.hostOnlyRoot,
  });
  let raw: unknown;
  try {
    raw = JSON.parse(
      decodeUtf8(file.bytes, "M6 frozen ProjectAdapter revision"),
    );
  } catch (error) {
    throw new Error("M6 frozen ProjectAdapter revision is not JSON", {
      cause: error,
    });
  }
  const revision = ProjectAdapterRevisionV1Schema.parse(raw);
  const canonicalBytes = Buffer.from(
    `${canonicalJson(raw as never)}\n`,
    "utf8",
  );
  if (!Buffer.from(file.bytes).equals(canonicalBytes)) {
    throw new Error("M6 frozen ProjectAdapter revision is not canonical JSON");
  }
  return Object.freeze({ revision, rawSha256: digest(file.bytes) });
};

const readFrozenAdapterConformance = async (input: {
  readonly path: string;
  readonly hostOnlyRoot: string;
}): Promise<{
  readonly receipt: AdapterConformanceReceiptV1;
  readonly rawSha256: Sha256DigestV1;
}> => {
  const file = await readStableFile({
    path: input.path,
    label: "M6 frozen ProjectAdapter conformance receipt",
    maximumBytes: 1024 * 1024,
    privateRoot: input.hostOnlyRoot,
  });
  let raw: unknown;
  try {
    raw = JSON.parse(
      decodeUtf8(file.bytes, "M6 frozen ProjectAdapter conformance receipt"),
    );
  } catch (error) {
    throw new Error(
      "M6 frozen ProjectAdapter conformance receipt is not JSON",
      { cause: error },
    );
  }
  const receipt = AdapterConformanceReceiptV1Schema.parse(raw);
  if (
    !Buffer.from(file.bytes).equals(
      Buffer.from(`${canonicalJson(raw as never)}\n`, "utf8"),
    )
  ) {
    throw new Error(
      "M6 frozen ProjectAdapter conformance receipt is not canonical JSON",
    );
  }
  return Object.freeze({ receipt, rawSha256: digest(file.bytes) });
};

const labeledDigest = (label: string, value: string): Sha256DigestV1 =>
  asSha256DigestV1(
    createHash("sha256").update(label).update("\0").update(value).digest("hex"),
  );

const validateAdapterProvenance = (input: {
  readonly pristine: VerifiedProjectEnvironmentSourceV1;
  readonly loaded: LoadedProjectAdapterPackageV1;
  readonly files: readonly ProjectAdapterPackageBytesV1[];
  readonly revision: ProjectAdapterRevisionV1;
  readonly conformance: AdapterConformanceReceiptV1;
}): void => {
  const expectedSourceId = `source:v1:${input.pristine.projectSourceIdentity}`;
  const expectedImplementationDigest = labeledDigest(
    "project-adapter-implementation-v1",
    input.loaded.files
      .filter((file) => file.path.endsWith(".gd"))
      .map((file) => `${file.path}:${file.sha256}`)
      .join("\n"),
  );
  const expectedPayloadSchemaDigest = labeledDigest(
    "project-adapter-payload-schemas-v1",
    input.loaded.manifest.schemas
      .map((schema) => `${schema.schemaId}:${schema.sha256}`)
      .join("\n"),
  );
  const expectedCapabilitySet = ProjectCapabilitySetV1Schema.parse({
    schemaVersion: 1,
    modules: input.loaded.manifest.modules.modules.map((module) => ({
      ...module,
    })),
  });
  const expectedCandidateContentDigest = asSha256DigestV1(
    projectEnvironmentPackageContentDigestV1(input.files),
  );
  if (
    input.revision.sourceId !== expectedSourceId ||
    input.revision.adapterId !== input.loaded.manifest.adapterId ||
    input.revision.adapterRevisionId !==
      `adapter-revision:v1:${input.loaded.candidateSha256}` ||
    input.revision.packageDigest !== input.loaded.candidateSha256 ||
    input.revision.manifestDigest !== input.loaded.manifestSha256 ||
    input.revision.implementationDigest !== expectedImplementationDigest ||
    input.revision.payloadSchemaDigest !== expectedPayloadSchemaDigest ||
    input.revision.contentByteLength !== input.loaded.totalBytes ||
    input.revision.contentFileCount !== input.loaded.files.length ||
    canonicalJson(input.revision.capabilitySet) !==
      canonicalJson(expectedCapabilitySet) ||
    input.conformance.outcome !== "conformed" ||
    input.conformance.receiptId !== input.revision.conformanceReceiptId ||
    input.conformance.sourceId !== input.revision.sourceId ||
    input.conformance.candidateDigest !== expectedCandidateContentDigest ||
    canonicalJson(input.conformance.capabilitySet) !==
      canonicalJson(input.revision.capabilitySet)
  ) {
    throw new Error(
      "M6 frozen ProjectAdapter bytes or revision do not match pristine-source provenance",
    );
  }
};

export const ExternalHiddenFixAgentAssignmentProjectionV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    projectionKind: z.literal("external-hidden-fix-agent-assignment"),
    assignmentId: assignmentIdSchema,
    subjectCommit: gitCommitSchema,
    baselineSelectedTreeSha256: Sha256DigestV1Schema,
    publicTask: z
      .object({
        sha256: Sha256DigestV1Schema,
        spec: z.lazy(() => ExternalHiddenFixPublicTaskSpecV1Schema),
      })
      .strict(),
    adapter: z
      .object({
        adapterRevisionId: ProjectAdapterRevisionIdSchema,
        revisionSha256: Sha256DigestV1Schema,
        packageSha256: Sha256DigestV1Schema,
        conformanceReceiptSha256: Sha256DigestV1Schema,
        capabilitySet: ProjectCapabilitySetV1Schema,
      })
      .strict(),
    projectionContentSha256: Sha256DigestV1Schema,
  })
  .strict()
  .superRefine((value, context) => {
    const { projectionContentSha256, ...basis } = value;
    if (projectionContentSha256 !== digestJson(basis)) {
      context.addIssue({
        code: "custom",
        path: ["projectionContentSha256"],
        message: "Agent assignment projection content hash does not match",
      });
    }
  });
export type ExternalHiddenFixAgentAssignmentProjectionV1 = z.infer<
  typeof ExternalHiddenFixAgentAssignmentProjectionV1Schema
>;

/**
 * The assignment file is public, but strict and byte-frozen. It preregisters
 * the exact formal Task identity and model boundary, plus the single Agent
 * attempt/user-turn and evaluator 3x3 resource ceilings. Ordinary Pi model
 * calls and tool scheduling within that one user turn remain Agent-owned.
 */
export const ExternalHiddenFixPublicTaskSpecV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    taskKind: z.literal("external-hidden-fix"),
    taskId: opaqueTaskIdSchema,
    subjectCommit: gitCommitSchema,
    goal: z
      .string()
      .min(1)
      .max(64 * 1024),
    publicExecutionClassifier: z
      .object({
        schemaVersion: z.literal(1),
        classifierId: z
          .string()
          .min(1)
          .max(256)
          .regex(/^[A-Za-z0-9][A-Za-z0-9._:+-]*$/u),
        implementationSha256: Sha256DigestV1Schema,
      })
      .strict(),
    agentBudget: z
      .object({
        provider: modelTokenSchema,
        model: modelTokenSchema,
        thinkingLevel: z.enum([
          "off",
          "minimal",
          "low",
          "medium",
          "high",
          "xhigh",
          "max",
        ]),
        attemptsMaximum: z.literal(1),
        userTurnsPerAttemptMaximum: z.literal(1),
        toolCallsMaximum: z.number().int().min(1).max(10_000),
        wallTimeMsMaximum: z.number().int().min(1_000).max(86_400_000),
        taskSandboxNetworkMode: z.literal("denied"),
        taskCredentialMountCountMaximum: z.literal(0),
      })
      .strict(),
    evaluatorBudget: z
      .object({
        scenarioClasses: z.tuple([
          z.literal("public_reproduction"),
          z.literal("hidden_variant"),
          z.literal("regression_control"),
        ]),
        repetitionsPerScenario: z.literal(3),
        plannedRunCount: z.literal(9),
        evaluatorProcessAttemptsPerRunMaximum: z.literal(1),
        freshWorkspacePerRun: z.literal(true),
        freshImportCachePerRun: z.literal(true),
        freshEvaluatorProcessPerRun: z.literal(true),
        agentRelaunchCountMaximum: z.literal(0),
        wallTimeMsPerRunMaximum: z.number().int().min(1_000).max(3_600_000),
      })
      .strict(),
  })
  .strict();
export type ExternalHiddenFixPublicTaskSpecV1 = z.infer<
  typeof ExternalHiddenFixPublicTaskSpecV1Schema
>;

export interface PrepareExternalHiddenFixAssignmentV1Input {
  readonly pristineProjectRoot: string;
  readonly mutatedProjectRoot: string;
  readonly expectedSubjectCommit?: string | undefined;
  readonly publicTaskSpecPath: string;
  /**
   * Default admission requires canonical JSON. This opt-in accepts an exact
   * pre-frozen byte identity after verifying its raw digest; strict DTO
   * validation remains mandatory and the raw digest remains the assignment
   * identity.
   */
  readonly publicTaskSpecBytePolicy?:
    | Readonly<{
        kind: "frozen-exact-v1";
        expectedSha256: Sha256DigestV1;
      }>
    | undefined;
  readonly adapterPackageRoot: string;
  readonly adapterRevisionPath: string;
  readonly adapterConformanceReceiptPath: string;
  readonly mutationPath: string;
  readonly evaluatorImplementationPath: string;
  readonly evaluatorBundlePath: string;
  readonly hostOnlyRoot: string;
  readonly agentExposedRoots: readonly string[];
  readonly createdAt: string;
}

export interface PreparedExternalHiddenFixAssignmentV1 {
  readonly assignment: ExternalHiddenFixAssignmentV1;
  readonly agentProjection: ExternalHiddenFixAgentAssignmentProjectionV1;
  readonly pristineSource: VerifiedProjectEnvironmentSourceV1;
  readonly mutatedSource: VerifiedProjectEnvironmentSourceV1;
  readonly adapterRevision: ProjectAdapterRevisionV1;
  readonly adapterConformanceReceipt: AdapterConformanceReceiptV1;
  readonly adapterPackage: LoadedProjectAdapterPackageV1;
  readonly baseline: MaterializedProjectEnvironmentWorkspaceV1;
  readonly protectedBaselineRoot: string;
}

const createAgentProjection = (input: {
  readonly assignment: ExternalHiddenFixAssignmentV1;
  readonly subjectCommit: string;
  readonly publicTaskSpecSha256: Sha256DigestV1;
  readonly publicTaskSpec: ExternalHiddenFixPublicTaskSpecV1;
  readonly adapterRevision: ProjectAdapterRevisionV1;
  readonly adapterRevisionSha256: Sha256DigestV1;
  readonly adapterConformanceReceiptSha256: Sha256DigestV1;
}): ExternalHiddenFixAgentAssignmentProjectionV1 => {
  const basis = {
    schemaVersion: 1 as const,
    projectionKind: "external-hidden-fix-agent-assignment" as const,
    assignmentId: input.assignment.assignmentId,
    subjectCommit: input.subjectCommit,
    baselineSelectedTreeSha256:
      input.assignment.mutatedBaselineSelectedTreeSha256,
    publicTask: {
      sha256: input.publicTaskSpecSha256,
      spec: input.publicTaskSpec,
    },
    adapter: {
      adapterRevisionId: input.adapterRevision.adapterRevisionId,
      revisionSha256: input.adapterRevisionSha256,
      packageSha256: input.adapterRevision.packageDigest,
      conformanceReceiptSha256: input.adapterConformanceReceiptSha256,
      capabilitySet: input.adapterRevision.capabilitySet,
    },
  };
  return ExternalHiddenFixAgentAssignmentProjectionV1Schema.parse({
    ...basis,
    projectionContentSha256: digestJson(basis),
  });
};

/**
 * Prepares one create-only M6 assignment from already-local inputs. The
 * pristine and mutated repositories are source authorities only: the Agent
 * receives only the selected source bytes materialized from the mutated tree,
 * never either authority repository, Git metadata, or a pristine-to-mutant
 * diff. The task runner may establish its own parentless synthetic Git baseline
 * after copying these bytes. Hidden paths remain confined to the Host store.
 */
export const prepareExternalHiddenFixAssignmentV1 = async (
  input: PrepareExternalHiddenFixAssignmentV1Input,
): Promise<PreparedExternalHiddenFixAssignmentV1> => {
  const createdAt = z.string().datetime().parse(input.createdAt);
  const hostOnlyRoot = await requirePrivateDirectory(
    input.hostOnlyRoot,
    "M6 Host-only assignment root",
  );
  const agentExposedRoots = await Promise.all(
    input.agentExposedRoots.map((path, index) =>
      canonicalDirectory(path, `M6 Agent-exposed root ${index + 1}`),
    ),
  );
  const pristineProjectRoot = await canonicalDirectory(
    input.pristineProjectRoot,
    "M6 pristine project root",
  );
  const mutatedProjectRoot = await canonicalDirectory(
    input.mutatedProjectRoot,
    "M6 mutated project root",
  );
  assertDisjoint(
    pristineProjectRoot,
    mutatedProjectRoot,
    "M6 pristine and mutated project roots must be separate",
  );
  for (const exposedRoot of agentExposedRoots) {
    assertDisjoint(
      hostOnlyRoot,
      exposedRoot,
      "M6 Host-only and Agent-exposed roots must be disjoint",
    );
    assertDisjoint(
      pristineProjectRoot,
      exposedRoot,
      "M6 pristine source authority must not be Agent-exposed",
    );
    assertDisjoint(
      mutatedProjectRoot,
      exposedRoot,
      "M6 mutated source authority must not be Agent-exposed",
    );
  }
  assertDisjoint(
    hostOnlyRoot,
    pristineProjectRoot,
    "M6 Host-only root must be outside the pristine source repository",
  );
  assertDisjoint(
    hostOnlyRoot,
    mutatedProjectRoot,
    "M6 Host-only root must be outside the mutated source repository",
  );

  const store = await openExternalHiddenFixAssignmentStoreV1({
    root: hostOnlyRoot,
    exposedRoots: agentExposedRoots,
  });
  const sourceExclusions = [hostOnlyRoot, ...agentExposedRoots];

  // The adapter is observed and frozen against pristine source before this
  // function admits the mutated source identity into the assignment.
  const pristineSource = await preflightCleanProjectEnvironmentV1({
    projectPath: pristineProjectRoot,
    sourceRepositoryExclusionRoots: sourceExclusions,
    gdscriptPolicy: "tracked-tool-scripts-v1",
  });
  if (
    input.expectedSubjectCommit !== undefined &&
    pristineSource.headCommit !==
      gitCommitSchema.parse(input.expectedSubjectCommit)
  ) {
    throw new Error(
      "M6 pristine source does not match the fixed subject commit",
    );
  }
  const adapterPackageRoot = await requireFrozenPrivateAdapterTree(
    input.adapterPackageRoot,
    hostOnlyRoot,
  );
  const adapterPackage = await loadProjectAdapterPackageV1(adapterPackageRoot, {
    requireSingleLaunchTarget: true,
    expectedMainScene: pristineSource.mainScene,
    requireEmptyLaunchParameters: true,
  });
  const adapterPackageFiles = await readFrozenPrivateAdapterPackageFiles(
    adapterPackageRoot,
    adapterPackage,
  );
  const frozenAdapterRevision = await readFrozenAdapterRevision({
    path: input.adapterRevisionPath,
    hostOnlyRoot,
  });
  const adapterRevision = frozenAdapterRevision.revision;
  const frozenAdapterConformance = await readFrozenAdapterConformance({
    path: input.adapterConformanceReceiptPath,
    hostOnlyRoot,
  });
  validateAdapterProvenance({
    pristine: pristineSource,
    loaded: adapterPackage,
    files: adapterPackageFiles,
    revision: adapterRevision,
    conformance: frozenAdapterConformance.receipt,
  });

  const mutatedSource = await preflightCleanProjectEnvironmentV1({
    projectPath: mutatedProjectRoot,
    sourceRepositoryExclusionRoots: sourceExclusions,
    gdscriptPolicy: "tracked-tool-scripts-v1",
  });
  if (pristineSource.selectedTreeSha256 === mutatedSource.selectedTreeSha256) {
    throw new Error(
      "M6 mutation did not change the selected Godot source tree",
    );
  }
  if (
    pristineSource.mainScene !== mutatedSource.mainScene ||
    pristineSource.requestedGodotVersion !== mutatedSource.requestedGodotVersion
  ) {
    throw new Error(
      "M6 mutated source changed the frozen ProjectAdapter launch/toolchain profile",
    );
  }

  const publicTaskSpec = await readStableFile({
    path: input.publicTaskSpecPath,
    label: "M6 public task specification",
    maximumBytes: PUBLIC_TASK_MAX_BYTES,
  });
  if (
    !agentExposedRoots.some((root) =>
      pathWithinOrEqual(root, publicTaskSpec.path),
    )
  ) {
    throw new Error(
      "M6 public task specification must be inside an Agent-exposed root",
    );
  }
  const publicTaskText = decodeUtf8(
    publicTaskSpec.bytes,
    "M6 public task specification",
  );
  let publicTaskRaw: unknown;
  try {
    publicTaskRaw = JSON.parse(publicTaskText);
  } catch (error) {
    throw new Error("M6 public task specification must be JSON", {
      cause: error,
    });
  }
  const publicTask =
    ExternalHiddenFixPublicTaskSpecV1Schema.parse(publicTaskRaw);
  const publicTaskSpecSha256 = digest(publicTaskSpec.bytes);
  const canonicalSourceBytes = Buffer.from(
    `${canonicalJson(publicTaskRaw as never)}\n`,
    "utf8",
  );
  if (input.publicTaskSpecBytePolicy === undefined) {
    if (!Buffer.from(publicTaskSpec.bytes).equals(canonicalSourceBytes)) {
      throw new Error("M6 public task specification must be canonical JSON");
    }
  } else {
    const bytePolicy = z
      .object({
        kind: z.literal("frozen-exact-v1"),
        expectedSha256: Sha256DigestV1Schema,
      })
      .strict()
      .parse(input.publicTaskSpecBytePolicy);
    if (
      bytePolicy.kind !== "frozen-exact-v1" ||
      publicTaskSpecSha256 !== bytePolicy.expectedSha256
    ) {
      throw new Error(
        "M6 frozen-exact public task specification digest does not match",
      );
    }
  }
  if (publicTask.subjectCommit !== pristineSource.headCommit) {
    throw new Error(
      "M6 public task specification does not bind the fixed subject commit",
    );
  }

  const [mutation, evaluatorImplementation, evaluatorBundle] =
    await Promise.all([
      readStableFile({
        path: input.mutationPath,
        label: "M6 mutation artifact",
        maximumBytes: PRIVATE_ARTIFACT_MAX_BYTES,
        privateRoot: hostOnlyRoot,
      }),
      readStableFile({
        path: input.evaluatorImplementationPath,
        label: "M6 evaluator implementation",
        maximumBytes: PRIVATE_ARTIFACT_MAX_BYTES,
        privateRoot: hostOnlyRoot,
      }),
      readStableFile({
        path: input.evaluatorBundlePath,
        label: "M6 evaluator bundle",
        maximumBytes: PRIVATE_ARTIFACT_MAX_BYTES,
        privateRoot: hostOnlyRoot,
      }),
    ]);
  const privatePaths = [
    hostOnlyRoot,
    mutation.path,
    evaluatorImplementation.path,
    evaluatorBundle.path,
    adapterPackageRoot,
    resolve(input.adapterRevisionPath),
    resolve(input.adapterConformanceReceiptPath),
  ];
  if (privatePaths.some((path) => publicTaskText.includes(path))) {
    throw new Error("M6 public task specification exposes a Host-only path");
  }

  const identitySeed = {
    schemaVersion: 1 as const,
    subjectProjectSha256: pristineSource.projectSourceIdentity,
    pristineSelectedTreeSha256: pristineSource.selectedTreeSha256,
    mutatedBaselineSelectedTreeSha256: mutatedSource.selectedTreeSha256,
    publicTaskSpecSha256,
    taskBlindAdapterSha256: digestJson({
      schemaVersion: 1,
      adapterRevisionSha256: frozenAdapterRevision.rawSha256,
      packageSha256: Sha256DigestV1Schema.parse(adapterPackage.candidateSha256),
      conformanceReceiptSha256: frozenAdapterConformance.rawSha256,
    }),
    mutationSha256: digest(mutation.bytes),
    evaluatorImplementationSha256: digest(evaluatorImplementation.bytes),
    evaluatorBundleSha256: digest(evaluatorBundle.bytes),
  };
  await verifyMutationRoundTrip({
    hostOnlyRoot,
    pristine: pristineSource,
    mutatedSelectedTreeSha256: mutatedSource.selectedTreeSha256,
    mutationPath: mutation.path,
    mutationSha256: identitySeed.mutationSha256,
  });
  const preparationTaskId = asTaskId(
    `m6-assignment-prep:${digestJson(identitySeed).slice(0, 32)}`,
  );
  const layout = await createProjectEnvironmentTaskDirectoryLayout({
    runtimeRoot: hostOnlyRoot,
    sourceRepositoryRoot: mutatedSource.repositoryRoot,
    taskId: preparationTaskId,
  });
  const baseline = await materializePrivateTaskWorkspace({
    taskId: preparationTaskId,
    source: mutatedSource,
    layout,
  });
  ProjectEnvironmentWorkspaceMaterializationReceiptV1Schema.parse(
    baseline.receipt,
  );
  if (
    baseline.receipt.selectedTreeSha256 !== mutatedSource.selectedTreeSha256 ||
    baseline.receipt.projectSourceIdentity !==
      mutatedSource.projectSourceIdentity
  ) {
    throw new Error(
      "M6 materialized baseline detached from the mutated selected tree",
    );
  }
  const status = await new NodeHostGitPort().statusPorcelain(
    baseline.workspaceDirectory,
  );
  if (status.byteLength !== 0) {
    throw new Error("M6 materialized mutated baseline is not clean");
  }
  const protectedBaselineRoot = await materializeSelectedOnlyBaseline({
    sourceWorkspace: baseline.workspaceDirectory,
    destinationRoot: join(
      layout.hostOperationTemporaryDirectory,
      "assignment-baseline",
    ),
    entries: mutatedSource.entries,
    expectedSelectedTreeSha256: mutatedSource.selectedTreeSha256,
  });

  const assignment = ExternalHiddenFixAssignmentV1Schema.parse(
    await store.createAssignment({
      ...identitySeed,
      baselineRoot: protectedBaselineRoot,
      mutationPath: mutation.path,
      evaluatorImplementationPath: evaluatorImplementation.path,
      evaluatorBundlePath: evaluatorBundle.path,
      createdAt,
    }),
  );
  const agentProjection = createAgentProjection({
    assignment,
    subjectCommit: pristineSource.headCommit,
    publicTaskSpecSha256: identitySeed.publicTaskSpecSha256,
    publicTaskSpec: publicTask,
    adapterRevision,
    adapterRevisionSha256: frozenAdapterRevision.rawSha256,
    adapterConformanceReceiptSha256: frozenAdapterConformance.rawSha256,
  });
  const serializedProjection = canonicalJson(agentProjection);
  if (privatePaths.some((path) => serializedProjection.includes(path))) {
    throw new Error("M6 Agent projection contains a Host-only path");
  }

  return Object.freeze({
    assignment,
    agentProjection,
    pristineSource,
    mutatedSource,
    adapterRevision,
    adapterConformanceReceipt: frozenAdapterConformance.receipt,
    adapterPackage,
    baseline,
    protectedBaselineRoot,
  });
};
