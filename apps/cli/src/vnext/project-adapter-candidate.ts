import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  opendir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

import { z } from "zod";

import {
  Sha256DigestV1Schema,
  TaskIdSchema,
  asSha256DigestV1,
  type AdapterId,
  type Sha256DigestV1,
  type TaskId,
} from "@chronorift/domain";
import {
  PROJECT_ADAPTER_SDK_FILES_V1,
  PROJECT_ADAPTER_SDK_FILES_V2,
} from "@chronorift/godot-adapter";
import { contentHash } from "@chronorift/json-artifacts";

import { M1Error } from "./errors.js";
import { NodeHostGitPort, type HostGitPort } from "./host-git.js";
import { createProjectAdapterReferenceTemplateFilesV1 } from "./project-adapter-reference-template.js";
import { createProjectAdapterReferenceTemplateFilesV2 } from "./project-adapter-reference-template-v2.js";

export const PROJECT_ADAPTER_CANDIDATE_RELATIVE_ROOT =
  ".chronorift/adapter-candidate" as const;
export const PROJECT_ADAPTER_CANDIDATE_MARKER =
  ".chronorift-project-adapter-candidate-v1.json" as const;
export const PROJECT_ADAPTER_REFERENCE_RELATIVE_ROOT =
  ".chronorift/adapter-sdk-v1" as const;
export const PROJECT_ADAPTER_REFERENCE_RELATIVE_ROOT_V2 =
  ".chronorift/adapter-sdk-v2" as const;
export const PROJECT_ADAPTER_CANDIDATE_MAX_FILES = 256;
export const PROJECT_ADAPTER_CANDIDATE_MAX_BYTES = 8 * 1024 * 1024;
export const PROJECT_ADAPTER_CANDIDATE_MAX_FILE_BYTES = 1024 * 1024;

export const ProjectAdapterCandidateMarkerV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    markerKind: z.literal("chronorift-project-adapter-candidate"),
    taskId: TaskIdSchema,
    projectSourceIdentity: Sha256DigestV1Schema,
  })
  .strict();

export type ProjectAdapterCandidateMarkerV1 = z.infer<
  typeof ProjectAdapterCandidateMarkerV1Schema
>;

export interface FrozenProjectAdapterCandidateFileV1 {
  readonly relativePath: string;
  readonly byteLength: number;
  readonly sha256: Sha256DigestV1;
  readonly bytes: Uint8Array;
}

export interface FrozenProjectAdapterCandidateV1 {
  readonly schemaVersion: 1;
  readonly taskId: TaskId;
  readonly projectSourceIdentity: Sha256DigestV1;
  readonly candidateSha256: Sha256DigestV1;
  readonly fileCount: number;
  readonly byteLength: number;
  readonly files: readonly FrozenProjectAdapterCandidateFileV1[];
}

const isNodeError = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error && "code" in error;

const contained = (root: string, candidate: string): boolean => {
  const difference = relative(root, candidate);
  return (
    difference === "" ||
    (difference !== ".." &&
      !difference.startsWith(`..${sep}`) &&
      !difference.startsWith("/"))
  );
};

const assertCanonicalDirectory = async (
  root: string,
  expectedParent?: string,
): Promise<void> => {
  const metadata = await lstat(root);
  if (
    metadata.isSymbolicLink() ||
    !metadata.isDirectory() ||
    (await realpath(root)) !== root ||
    (expectedParent !== undefined && !contained(expectedParent, root))
  ) {
    throw new M1Error(
      "path_denied",
      "ProjectAdapter candidate directory crossed its Task workspace boundary",
    );
  }
};

const canonicalMarkerBytes = (
  marker: ProjectAdapterCandidateMarkerV1,
): Buffer => Buffer.from(`${JSON.stringify(marker)}\n`, "utf8");

const PROJECT_ADAPTER_CONTRACT_REFERENCE_V1 = `# ProjectAdapter V1 reference

The Host validates the candidate after the Agent turn. These files are a
Task-local reference only; the Godot runtime receives separately pinned SDK
bytes.

Package: manifest.json, one entryScript below src/, one or more canonical JSON
schemas below schemas/, and optional README.md. No other paths are accepted.

manifest.json is a strict object with: schemaVersion=1,
manifestKind="chronorift-project-adapter", adapterId (the exact value supplied
in the initialization prompt), semantic adapterVersion, sdk={id:
"chronorift-project-adapter-sdk",version:1}, engine={id:"godot",
versionRequirement:"4.7.x",language:"gdscript"}, entryScript, schemas,
launchTargets, modules, entityTypes, stateDomains, eventTypes, and smoke.

Declare exactly one default headless launch target for the realized main
scene, with an empty strict parameters schema. The modules object contains
schemaVersion=1 and exactly twelve module records: lifecycle, clock,
runtime_error, entity_projection, state_projection, event_projection,
capture, input_control, snapshot, restore, render_capture, and alignment.
Each module record contains schemaVersion=1, module, status, protocolVersion,
and limitations. Ready requires the first seven modules to be implemented.
Unsupported optional modules use status="unsupported", protocolVersion=null,
and a non-empty limitations array.

Each schema declaration contains schemaVersion=1, schemaId, path, and the
lowercase SHA-256 of the exact schema file bytes. Entity types contain
entityTypeId, schemaId, and identityStrategy. State domains contain
stateDomainId, schemaId, and checkpointDisposition. Event types contain
eventTypeId and schemaId. smoke contains targetId, timeoutMs,
minimumStateSamples>=1, minimumEntityLifecycleRecords>=1,
requiredStateDomainIds (non-empty), and requiredCustomEventTypeIds.

The minimal template identifiers scene-root/entity.scene-root and
project/state.project are reserved placeholders. Author at least one actual
project-specific entity type and state domain; the Host rejects publication
when either side is still only the structural placeholder.
`;

const writeReferenceFile = async (
  root: string,
  relativePath: string,
  bytes: Uint8Array,
): Promise<void> => {
  const target = join(root, ...relativePath.split("/"));
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const handle = await open(
    target,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o400,
  );
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
};

export async function initializeProjectAdapterCandidateWorkspaceV1(input: {
  readonly workspaceDirectory: string;
  readonly taskId: TaskId;
  readonly projectSourceIdentity: Sha256DigestV1;
  readonly adapterId: AdapterId;
  readonly mainScene: string;
}): Promise<{ readonly candidateDirectory: string }> {
  const workspaceDirectory = resolve(input.workspaceDirectory);
  await assertCanonicalDirectory(workspaceDirectory);
  const managedRoot = join(workspaceDirectory, ".chronorift");
  const candidateDirectory = join(
    workspaceDirectory,
    PROJECT_ADAPTER_CANDIDATE_RELATIVE_ROOT,
  );
  const referenceDirectory = join(
    workspaceDirectory,
    PROJECT_ADAPTER_REFERENCE_RELATIVE_ROOT,
  );
  try {
    await mkdir(managedRoot, { mode: 0o700 });
    await chmod(managedRoot, 0o700);
    await mkdir(candidateDirectory, { mode: 0o700 });
    await chmod(candidateDirectory, 0o700);
    await mkdir(referenceDirectory, { mode: 0o700 });
  } catch (error) {
    if (!isNodeError(error) || error.code !== "EEXIST") {
      throw new M1Error(
        "artifact_write_failed",
        "unable to create ProjectAdapter candidate workspace",
        error,
      );
    }
    throw new M1Error(
      "artifact_write_failed",
      "ProjectAdapter candidate workspace already exists",
      error,
    );
  }
  await Promise.all([
    assertCanonicalDirectory(managedRoot, workspaceDirectory),
    assertCanonicalDirectory(candidateDirectory, workspaceDirectory),
    assertCanonicalDirectory(referenceDirectory, workspaceDirectory),
  ]);
  for (const file of PROJECT_ADAPTER_SDK_FILES_V1) {
    await writeReferenceFile(referenceDirectory, file.relativePath, file.bytes);
  }
  for (const file of createProjectAdapterReferenceTemplateFilesV1(input)) {
    await writeReferenceFile(referenceDirectory, file.relativePath, file.bytes);
  }
  await writeReferenceFile(
    referenceDirectory,
    "CONTRACT.md",
    Buffer.from(PROJECT_ADAPTER_CONTRACT_REFERENCE_V1, "utf8"),
  );
  const marker = ProjectAdapterCandidateMarkerV1Schema.parse({
    schemaVersion: 1,
    markerKind: "chronorift-project-adapter-candidate",
    taskId: input.taskId,
    projectSourceIdentity: input.projectSourceIdentity,
  });
  // Keep the Task-ownership marker next to, rather than inside, the adapter
  // package. The strict package loader must see only publishable bytes.
  const markerPath = join(managedRoot, PROJECT_ADAPTER_CANDIDATE_MARKER);
  const markerHandle = await open(
    markerPath,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o400,
  );
  try {
    await markerHandle.writeFile(canonicalMarkerBytes(marker));
    await markerHandle.sync();
  } finally {
    await markerHandle.close();
  }

  // This is a Task-private Git repository. Excluding the managed view keeps
  // ordinary game diffs honest without modifying the user's checkout metadata.
  const excludePath = join(workspaceDirectory, ".git", "info", "exclude");
  await mkdir(dirname(excludePath), { recursive: true, mode: 0o700 });
  const existingExclude = await readFile(excludePath, "utf8").catch(
    (error: unknown) => {
      if (isNodeError(error) && error.code === "ENOENT") return "";
      throw error;
    },
  );
  if (!existingExclude.split("\n").includes("/.chronorift/")) {
    await writeFile(excludePath, `${existingExclude}/.chronorift/\n`, {
      flag: existingExclude.length === 0 ? "wx" : "w",
      mode: 0o600,
    });
  }
  return Object.freeze({ candidateDirectory });
}

export async function initializeProjectAdapterCandidateWorkspaceV2(input: {
  readonly workspaceDirectory: string;
  readonly taskId: TaskId;
  readonly projectSourceIdentity: Sha256DigestV1;
  readonly adapterId: AdapterId;
  readonly mainScene: string;
}): Promise<{ readonly candidateDirectory: string }> {
  const result = await initializeProjectAdapterCandidateWorkspaceV1(input);
  const v1Reference = join(
    resolve(input.workspaceDirectory),
    PROJECT_ADAPTER_REFERENCE_RELATIVE_ROOT,
  );
  const v2Reference = join(
    resolve(input.workspaceDirectory),
    PROJECT_ADAPTER_REFERENCE_RELATIVE_ROOT_V2,
  );
  await mkdir(v2Reference, { mode: 0o700 });
  await assertCanonicalDirectory(
    v2Reference,
    resolve(input.workspaceDirectory),
  );
  for (const file of PROJECT_ADAPTER_SDK_FILES_V2)
    await writeReferenceFile(v2Reference, file.relativePath, file.bytes);
  for (const file of createProjectAdapterReferenceTemplateFilesV2(input))
    await writeReferenceFile(v2Reference, file.relativePath, file.bytes);
  await writeReferenceFile(
    v2Reference,
    "CONTRACT.md",
    Buffer.from(
      "# ProjectAdapter V2 reference\n\nUse manifest/schemaVersion 2 and SDK 2. Emit all dynamic observations through ChronoRiftObservationContextV2. Entity-scoped state and events require the exact active EntityRefV2. A publishable candidate must replace all dynamic-placeholder identifiers and demonstrate appeared, initial state, declared event, changed state, disappeared, and the same stable entity ID at exactly the next incarnation. Harness does not infer node names, Signal names, properties, or causality.\n",
      "utf8",
    ),
  );
  await rm(v1Reference, { recursive: true });
  return result;
}

const validCandidateRelativePath = (relativePath: string): boolean =>
  relativePath.length >= 1 &&
  relativePath.length <= 1_024 &&
  !relativePath.includes("\\") &&
  !relativePath.includes("\0") &&
  !relativePath.startsWith("/") &&
  relativePath
    .split("/")
    .every(
      (segment) =>
        segment.length >= 1 &&
        segment !== "." &&
        segment !== ".." &&
        /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(segment),
    );

const allowedCandidateFile = (relativePath: string): boolean =>
  relativePath.endsWith(".gd") ||
  relativePath.endsWith(".json") ||
  relativePath.endsWith(".md");

const listCandidateFiles = async (
  candidateDirectory: string,
): Promise<readonly string[]> => {
  const files: string[] = [];
  const visit = async (directory: string, prefix: string): Promise<void> => {
    const handle = await opendir(directory);
    const entries: { readonly name: string; readonly kind: "file" | "dir" }[] =
      [];
    for await (const entry of handle) {
      if (entry.isSymbolicLink()) {
        throw new M1Error(
          "path_denied",
          "ProjectAdapter candidate contains a symbolic link",
        );
      }
      if (!entry.isFile() && !entry.isDirectory()) {
        throw new M1Error(
          "source_feature_unsupported",
          "ProjectAdapter candidate contains an unsupported filesystem entry",
        );
      }
      entries.push({
        name: entry.name,
        kind: entry.isFile() ? "file" : "dir",
      });
    }
    entries.sort((left, right) =>
      Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)),
    );
    for (const entry of entries) {
      const relativePath =
        prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      if (!validCandidateRelativePath(relativePath)) {
        throw new M1Error(
          "path_denied",
          "ProjectAdapter candidate contains an unsafe relative path",
        );
      }
      const absolutePath = join(candidateDirectory, ...relativePath.split("/"));
      if (!contained(candidateDirectory, absolutePath)) {
        throw new M1Error(
          "path_denied",
          "ProjectAdapter candidate path escaped its root",
        );
      }
      if (entry.kind === "dir") {
        await visit(absolutePath, relativePath);
      } else {
        if (!allowedCandidateFile(relativePath)) {
          throw new M1Error(
            "source_feature_unsupported",
            "ProjectAdapter candidate contains an unsupported file type",
          );
        }
        files.push(relativePath);
        if (files.length > PROJECT_ADAPTER_CANDIDATE_MAX_FILES) {
          throw new M1Error(
            "resource_limit_unavailable",
            "ProjectAdapter candidate exceeds its file-count bound",
          );
        }
      }
    }
  };
  await visit(candidateDirectory, "");
  return Object.freeze(files);
};

export async function freezeProjectAdapterCandidateV1(input: {
  readonly workspaceDirectory: string;
  readonly taskId: TaskId;
  readonly projectSourceIdentity: Sha256DigestV1;
}): Promise<FrozenProjectAdapterCandidateV1> {
  const workspaceDirectory = resolve(input.workspaceDirectory);
  const candidateDirectory = join(
    workspaceDirectory,
    PROJECT_ADAPTER_CANDIDATE_RELATIVE_ROOT,
  );
  const managedRoot = dirname(candidateDirectory);
  const markerPath = join(managedRoot, PROJECT_ADAPTER_CANDIDATE_MARKER);
  await assertCanonicalDirectory(managedRoot, workspaceDirectory);
  await assertCanonicalDirectory(candidateDirectory, workspaceDirectory);
  const paths = await listCandidateFiles(candidateDirectory);
  if (!paths.includes("manifest.json")) {
    throw new M1Error(
      "source_configuration_mismatch",
      "ProjectAdapter candidate must contain manifest.json",
    );
  }
  const files: FrozenProjectAdapterCandidateFileV1[] = [];
  let totalBytes = 0;
  for (const relativePath of paths) {
    const path = join(candidateDirectory, ...relativePath.split("/"));
    const before = await lstat(path);
    if (
      before.isSymbolicLink() ||
      !before.isFile() ||
      before.nlink !== 1 ||
      before.size < 1 ||
      before.size > PROJECT_ADAPTER_CANDIDATE_MAX_FILE_BYTES
    ) {
      throw new M1Error(
        "path_denied",
        "ProjectAdapter candidate file has an unsafe physical identity",
      );
    }
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let bytes: Buffer;
    try {
      const opened = await handle.stat();
      if (
        opened.dev !== before.dev ||
        opened.ino !== before.ino ||
        opened.size !== before.size
      ) {
        throw new M1Error(
          "path_denied",
          "ProjectAdapter candidate changed while opening",
        );
      }
      bytes = await handle.readFile();
      const after = await handle.stat();
      if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) {
        throw new M1Error(
          "source_not_clean",
          "ProjectAdapter candidate changed while freezing",
        );
      }
    } finally {
      await handle.close();
    }
    totalBytes += bytes.byteLength;
    if (totalBytes > PROJECT_ADAPTER_CANDIDATE_MAX_BYTES) {
      throw new M1Error(
        "resource_limit_unavailable",
        "ProjectAdapter candidate exceeds its aggregate byte bound",
      );
    }
    files.push(
      Object.freeze({
        relativePath,
        byteLength: bytes.byteLength,
        sha256: asSha256DigestV1(
          createHash("sha256").update(bytes).digest("hex"),
        ),
        bytes: Uint8Array.from(bytes),
      }),
    );
  }
  const markerBefore = await lstat(markerPath);
  if (
    markerBefore.isSymbolicLink() ||
    !markerBefore.isFile() ||
    markerBefore.nlink !== 1 ||
    markerBefore.size < 1 ||
    markerBefore.size > PROJECT_ADAPTER_CANDIDATE_MAX_FILE_BYTES
  ) {
    throw new M1Error(
      "path_denied",
      "ProjectAdapter candidate ownership marker has an unsafe physical identity",
    );
  }
  const markerHandle = await open(
    markerPath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  let markerBytes: Buffer;
  try {
    const opened = await markerHandle.stat();
    if (
      opened.dev !== markerBefore.dev ||
      opened.ino !== markerBefore.ino ||
      opened.size !== markerBefore.size
    ) {
      throw new M1Error(
        "path_denied",
        "ProjectAdapter candidate ownership marker changed while opening",
      );
    }
    markerBytes = await markerHandle.readFile();
    const after = await markerHandle.stat();
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) {
      throw new M1Error(
        "source_not_clean",
        "ProjectAdapter candidate ownership marker changed while freezing",
      );
    }
  } finally {
    await markerHandle.close();
  }
  let marker: ProjectAdapterCandidateMarkerV1;
  try {
    marker = ProjectAdapterCandidateMarkerV1Schema.parse(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(markerBytes),
      ) as unknown,
    );
  } catch (error) {
    throw new M1Error(
      "source_configuration_mismatch",
      "ProjectAdapter candidate ownership marker is invalid",
      error,
    );
  }
  if (
    marker.taskId !== input.taskId ||
    marker.projectSourceIdentity !== input.projectSourceIdentity ||
    !markerBytes.equals(canonicalMarkerBytes(marker))
  ) {
    throw new M1Error(
      "path_denied",
      "ProjectAdapter candidate ownership marker does not match this Task",
    );
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    taskId: input.taskId,
    projectSourceIdentity: input.projectSourceIdentity,
    candidateSha256: asSha256DigestV1(
      contentHash({
        schemaVersion: 1,
        files: files
          .map((file) => ({
            path: file.relativePath,
            byteLength: file.byteLength,
            sha256: file.sha256,
          }))
          .sort((left, right) => left.path.localeCompare(right.path)),
      }),
    ),
    fileCount: files.length,
    byteLength: totalBytes,
    files: Object.freeze(files),
  });
}

export async function assertProjectEnvironmentInitializationSourceUnchangedV1(
  workspaceDirectory: string,
  dependencies?: { readonly git?: HostGitPort },
): Promise<void> {
  const git = dependencies?.git ?? new NodeHostGitPort();
  const status = await git.statusPorcelain(resolve(workspaceDirectory));
  if (status.byteLength !== 0) {
    throw new M1Error(
      "source_not_clean",
      "initialization turn modified game source; PE-A only publishes an adapter",
    );
  }
}
