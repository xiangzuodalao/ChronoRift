import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rmdir,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { Sha256DigestV1, TaskId } from "@chronorift/domain";

import { collectCandidateGodotSourceV1 } from "./candidate-godot-build.js";
import {
  NodeHostGitPort,
  type HostGitPort,
  type HostGitRepositoryContext,
} from "./host-git.js";
import { extractTaskPatch } from "./patch-handoff.js";
import {
  selectedTreeSha256,
  type SelectedTreeEntryV1,
} from "./selected-tree.js";

export interface AgentWorkspaceBinding {
  readonly agentId: string;
  readonly workspaceDirectory: string;
  readonly resourceDirectory: string;
  readonly recordsDirectory: string;
  readonly hostBaselineGitDirectory: string;
  readonly hostOperationTemporaryDirectory: string;
  readonly baseSourceHash: Sha256DigestV1;
}

export interface AgentWorkspaceTurnResult {
  readonly agentId: string;
  readonly turnId: number;
  readonly baseSourceHash: Sha256DigestV1;
  readonly candidateSourceHash: Sha256DigestV1;
  readonly patchHash: Sha256DigestV1;
  readonly patchByteLength: number;
  readonly patchPath: string;
  readonly roundTripVerified: true;
}

export interface AgentWorkspaceApplyResult {
  readonly status: "applied" | "no_op" | "conflict" | "stale";
  readonly conflicts: readonly string[];
  readonly rootSourceHash?: Sha256DigestV1;
}

export interface AgentWorkspaceManagerOptions {
  readonly rootWorkspaceDirectory: string;
  /** Host-owned parent; create() appends the validated agent identity. */
  readonly resourceRootDirectory: string;
  readonly recordsDirectory: string;
  readonly taskId: TaskId;
}

export interface AgentWorkspaceManagerDependencies {
  readonly git?: HostGitPort;
  /** Fault-injection boundary for verifying partial application and rollback. */
  readonly transactionStep?: (
    phase: "apply" | "rollback",
    path: string,
  ) => void | Promise<void>;
}

export class AgentWorkspaceRollbackError extends Error {
  public readonly code = "workspace_rollback_failed";
  public constructor(cause: unknown) {
    super("Agent patch rollback failed; Root workspace is unavailable", {
      cause,
    });
    this.name = "AgentWorkspaceRollbackError";
  }
}

interface Snapshot {
  readonly directory: string;
  readonly hash: Sha256DigestV1;
}

interface Turn {
  readonly metadata: AgentWorkspaceTurnResult;
  readonly candidate: Snapshot;
  readonly base: Snapshot;
}

interface AgentWorkspaceState {
  readonly binding: AgentWorkspaceBinding;
  readonly turns: Map<number, Turn>;
  mergeBase: Snapshot;
  baselineCommit: string;
  latestTurnId: number;
  appliedTurnId: number;
}

const isErrorCode = (error: unknown, code: string): boolean =>
  error instanceof Error && "code" in error && error.code === code;

const within = (parent: string, child: string): boolean => {
  const suffix = relative(parent, child);
  return (
    suffix === "" ||
    (!isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`))
  );
};

const assertId = (agentId: string): void => {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(agentId))
    throw new TypeError("Invalid agent workspace identity");
};

const assertTurn = (turnId: number): void => {
  if (!Number.isSafeInteger(turnId) || turnId < 1)
    throw new TypeError("Agent turn must be a positive safe integer");
};

const assertDirectory = async (path: string): Promise<void> => {
  if (
    !isAbsolute(path) ||
    path !== resolve(path) ||
    (await realpath(path)) !== path
  )
    throw new Error("Agent workspace path must be canonical without symlinks");
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink())
    throw new Error("Agent workspace path must be a real directory");
};

const createPrivateDirectory = async (path: string): Promise<void> => {
  await assertDirectory(dirname(path));
  await mkdir(path, { mode: 0o700 });
  await chmod(path, 0o700);
  await assertDirectory(path);
};

const ensurePrivateDirectory = async (path: string): Promise<void> => {
  try {
    await createPrivateDirectory(path);
  } catch (error) {
    if (!isErrorCode(error, "EEXIST")) throw error;
  }
  await assertDirectory(path);
  const metadata = await lstat(path);
  if (
    metadata.uid !== process.geteuid?.() ||
    (metadata.mode & 0o7777) !== 0o700
  )
    throw new Error("Agent resource directory must be private and Host-owned");
};

const fdPath = (directory: FileHandle, name = ""): string =>
  `/proc/self/fd/${directory.fd}${name === "" ? "" : `/${name}`}`;

const pinRoot = async (path: string): Promise<FileHandle> => {
  await assertDirectory(path);
  const before = await lstat(path);
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const opened = await handle.stat();
    if (opened.dev !== before.dev || opened.ino !== before.ino)
      throw new Error("Agent workspace directory changed while opening");
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
};

const assertRootBound = async (
  path: string,
  root: FileHandle,
): Promise<void> => {
  const [metadata, pinned] = await Promise.all([lstat(path), root.stat()]);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.dev !== pinned.dev ||
    metadata.ino !== pinned.ino ||
    (await realpath(path)) !== path
  )
    throw new Error("Agent workspace directory changed during operation");
};

/** Descend through pinned directory descriptors; never follow project links. */
const withParent = async <T>(
  root: FileHandle,
  path: string,
  create: boolean,
  action: (parent: FileHandle, name: string) => Promise<T>,
): Promise<T> => {
  // Reuse the selected-tree path contract even for deletion-only entries.
  selectedTreeSha256([
    { relativePath: path, mode: "100644", content: new Uint8Array() },
  ]);
  const parts = path.split("/");
  const handles: FileHandle[] = [];
  let parent = root;
  try {
    for (const part of parts.slice(0, -1)) {
      if (create) {
        try {
          await mkdir(fdPath(parent, part), { mode: 0o700 });
        } catch (error) {
          if (!isErrorCode(error, "EEXIST")) throw error;
        }
      }
      const child = await open(
        fdPath(parent, part),
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      handles.push(child);
      parent = child;
    }
    return await action(parent, parts.at(-1)!);
  } finally {
    await Promise.all(handles.reverse().map((handle) => handle.close()));
  }
};

const writeEntry = async (
  root: FileHandle,
  entry: SelectedTreeEntryV1,
): Promise<void> => {
  await withParent(root, entry.relativePath, true, async (parent, name) => {
    try {
      const existing = await lstat(fdPath(parent, name));
      if (existing.isDirectory()) await rmdir(fdPath(parent, name));
      else if (!existing.isFile() || existing.isSymbolicLink())
        throw new Error("Agent patch target must be an ordinary file");
    } catch (error) {
      if (!isErrorCode(error, "ENOENT")) throw error;
    }
    const temporary = `.chronorift-agent-${randomUUID()}`;
    const handle = await open(
      fdPath(parent, temporary),
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(entry.content);
      await handle.chmod(entry.mode === "100755" ? 0o755 : 0o644);
      await handle.sync();
      await rename(fdPath(parent, temporary), fdPath(parent, name));
      await parent.sync();
    } finally {
      await handle.close();
      await unlink(fdPath(parent, temporary)).catch((error: unknown) => {
        if (!isErrorCode(error, "ENOENT")) throw error;
      });
    }
  });
};

const removeEntry = async (root: FileHandle, path: string): Promise<void> => {
  try {
    await withParent(root, path, false, async (parent, name) => {
      const metadata = await lstat(fdPath(parent, name));
      if (metadata.isDirectory()) await rmdir(fdPath(parent, name));
      else if (metadata.isFile() && !metadata.isSymbolicLink())
        await unlink(fdPath(parent, name));
      else throw new Error("Agent patch target is not an ordinary file");
      await parent.sync();
    });
  } catch (error) {
    if (!isErrorCode(error, "ENOENT") && !isErrorCode(error, "ENOTDIR"))
      throw error;
  }
  const parts = path.split("/");
  for (let length = parts.length - 1; length > 0; length--) {
    try {
      await withParent(
        root,
        parts.slice(0, length).join("/"),
        false,
        async (parent, name) => {
          await rmdir(fdPath(parent, name));
          await parent.sync();
        },
      );
    } catch (error) {
      if (isErrorCode(error, "ENOTEMPTY") || isErrorCode(error, "EEXIST"))
        break;
      if (!isErrorCode(error, "ENOENT") && !isErrorCode(error, "ENOTDIR"))
        throw error;
    }
  }
};

const sameEntry = (
  left: SelectedTreeEntryV1 | undefined,
  right: SelectedTreeEntryV1 | undefined,
): boolean =>
  left === undefined || right === undefined
    ? left === right
    : left.mode === right.mode &&
      Buffer.from(left.content).equals(Buffer.from(right.content));

const treeConflicts = (
  files: readonly SelectedTreeEntryV1[],
): readonly string[] => {
  const names = new Map<string, string>();
  const allNames = new Map<string, string>();
  const conflicts = new Set<string>();
  for (const file of files) {
    const segments = file.relativePath.split("/");
    for (let length = 1; length <= segments.length; length++) {
      const path = segments.slice(0, length).join("/");
      const folded = path.normalize("NFC").toLocaleLowerCase("en-US");
      const previous = allNames.get(folded);
      if (previous !== undefined && previous !== path) {
        conflicts.add(previous);
        conflicts.add(path);
      }
      allNames.set(folded, path);
    }
    const key = file.relativePath.normalize("NFC").toLocaleLowerCase("en-US");
    const previous = names.get(key);
    if (previous !== undefined) {
      conflicts.add(previous);
      conflicts.add(file.relativePath);
    }
    names.set(key, file.relativePath);
  }
  for (const [key, path] of names) {
    const parts = key.split("/");
    for (let length = 1; length < parts.length; length++) {
      const ancestor = names.get(parts.slice(0, length).join("/"));
      if (ancestor !== undefined) {
        conflicts.add(ancestor);
        conflicts.add(path);
      }
    }
  }
  return [...conflicts].sort();
};

const collect = async (
  directory: string,
): Promise<readonly SelectedTreeEntryV1[]> => {
  const files = await collectCandidateGodotSourceV1(
    directory,
    "project-environment",
  );
  const hash = selectedTreeSha256(files);
  if (treeConflicts(files).length !== 0)
    throw new Error("Agent workspace contains colliding source paths");
  const observed = await collectCandidateGodotSourceV1(
    directory,
    "project-environment",
  );
  if (selectedTreeSha256(observed) !== hash)
    throw new Error("Agent source changed during snapshot");
  return files;
};

const writeSnapshot = async (
  directory: string,
  files: readonly SelectedTreeEntryV1[],
): Promise<Snapshot> => {
  await createPrivateDirectory(directory);
  const root = await pinRoot(directory);
  try {
    for (const file of files) await writeEntry(root, file);
    await assertRootBound(directory, root);
  } finally {
    await root.close();
  }
  const hash = selectedTreeSha256(files);
  if (selectedTreeSha256(await collect(directory)) !== hash)
    throw new Error("Materialized agent snapshot differs from its source");
  return { directory, hash };
};

const readSnapshot = async (
  snapshot: Snapshot,
): Promise<readonly SelectedTreeEntryV1[]> => {
  const files = await collect(snapshot.directory);
  if (selectedTreeSha256(files) !== snapshot.hash)
    throw new Error("Recorded agent snapshot was modified");
  return files;
};

const writeRecord = async (path: string, value: unknown): Promise<void> => {
  await assertDirectory(dirname(path));
  const file = await open(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
};

/**
 * Host-owned snapshots and explicit patch integration. The caller holds the
 * relevant coding/snapshot leases and has drained every sandbox writer.
 * No project Git configuration is consulted and no project code runs here.
 */
export class AgentWorkspaceManager {
  readonly #agents = new Map<string, AgentWorkspaceState>();
  readonly #git: HostGitPort;
  #operation: Promise<unknown> = Promise.resolve();
  #poisoned = false;

  public constructor(
    private readonly options: AgentWorkspaceManagerOptions,
    private readonly dependencies: AgentWorkspaceManagerDependencies = {},
  ) {
    this.#git = dependencies.git ?? new NodeHostGitPort();
    const paths = [
      options.rootWorkspaceDirectory,
      options.resourceRootDirectory,
      options.recordsDirectory,
    ];
    for (const path of paths) {
      if (!isAbsolute(path) || path !== resolve(path) || path.includes("\0"))
        throw new TypeError(
          "Agent workspace roots must be canonical absolute paths",
        );
    }
    for (let left = 0; left < paths.length; left++) {
      for (let right = left + 1; right < paths.length; right++) {
        if (
          within(paths[left]!, paths[right]!) ||
          within(paths[right]!, paths[left]!)
        )
          throw new Error(
            "Root workspace, agent resources and records must be disjoint",
          );
      }
    }
  }

  public get poisoned(): boolean {
    return this.#poisoned;
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    // Root apply and worker completion hold different tool leases. Serialize
    // their Host metadata updates so a patch cannot acquire a different base
    // identity while its extraction is in flight.
    const result = this.#operation.then(operation);
    this.#operation = result.catch(() => undefined);
    return result;
  }

  private assertAvailable(): void {
    if (this.#poisoned)
      throw new AgentWorkspaceRollbackError("Workspace remains poisoned");
  }

  private state(agentId: string): AgentWorkspaceState {
    assertId(agentId);
    const state = this.#agents.get(agentId);
    if (state === undefined) throw new Error("Unknown agent workspace");
    return state;
  }

  public getWorkspace(agentId: string): AgentWorkspaceBinding {
    const state = this.state(agentId);
    return { ...state.binding, baseSourceHash: state.mergeBase.hash };
  }

  private async commitSnapshot(
    directory: string,
    files: readonly SelectedTreeEntryV1[],
    gitDirectory: string,
    indexFile: string,
    agentHead = false,
  ): Promise<string> {
    const context: HostGitRepositoryContext = {
      cwd: gitDirectory,
      gitDirectory,
      indexFile,
      ...(agentHead ? { workTree: directory } : {}),
    };
    const entries = [];
    const root = await pinRoot(directory);
    try {
      for (const entry of files) {
        const objectId = await withParent(
          root,
          entry.relativePath,
          false,
          async (parent, name) => {
            const handle = await open(
              fdPath(parent, name),
              constants.O_RDONLY | constants.O_NOFOLLOW,
            );
            try {
              if (!(await handle.stat()).isFile())
                throw new Error("Snapshot source is not a regular file");
              return await this.#git.hashBlob({ context, source: handle });
            } finally {
              await handle.close();
            }
          },
        );
        entries.push({
          relativePath: entry.relativePath,
          mode: entry.mode,
          objectId,
        });
      }
      await assertRootBound(directory, root);
    } finally {
      await root.close();
    }
    if (
      selectedTreeSha256(await collect(directory)) !== selectedTreeSha256(files)
    )
      throw new Error("Agent snapshot changed while creating its Git baseline");
    await this.#git.readTreeEmpty(context);
    await this.#git.updateIndex({ context, entries });
    const commit = await this.#git.commitTree({
      context,
      treeId: await this.#git.writeTree(context),
    });
    if (agentHead) await this.#git.setAgentBaselineHead({ context, commit });
    return commit;
  }

  public create(agentId: string): Promise<AgentWorkspaceBinding> {
    return this.serialize(() => this.createWorkspace(agentId));
  }

  private async createWorkspace(
    agentId: string,
  ): Promise<AgentWorkspaceBinding> {
    this.assertAvailable();
    assertId(agentId);
    if (this.#agents.has(agentId))
      throw new Error("Agent workspace already exists");
    await ensurePrivateDirectory(this.options.resourceRootDirectory);
    await ensurePrivateDirectory(this.options.recordsDirectory);
    const files = await collect(this.options.rootWorkspaceDirectory);
    const resourceDirectory = join(this.options.resourceRootDirectory, agentId);
    const recordsDirectory = join(this.options.recordsDirectory, agentId);
    await createPrivateDirectory(resourceDirectory);
    await createPrivateDirectory(recordsDirectory);
    const workspaceDirectory = join(resourceDirectory, "workspace");
    const hostBaselineGitDirectory = join(
      resourceDirectory,
      "host-baseline.git",
    );
    const hostOperationTemporaryDirectory = join(resourceDirectory, "host-tmp");
    await createPrivateDirectory(hostBaselineGitDirectory);
    await createPrivateDirectory(hostOperationTemporaryDirectory);
    await createPrivateDirectory(join(resourceDirectory, "turns"));
    await createPrivateDirectory(join(recordsDirectory, "turns"));
    await createPrivateDirectory(join(recordsDirectory, "applications"));
    const mergeBase = await writeSnapshot(
      join(resourceDirectory, "initial-source"),
      files,
    );
    await writeSnapshot(workspaceDirectory, files);
    await this.#git.initializeRepository({
      directory: hostBaselineGitDirectory,
      bare: true,
    });
    await this.#git.initializeRepository({
      directory: workspaceDirectory,
      bare: false,
    });
    const baselineCommit = await this.commitSnapshot(
      mergeBase.directory,
      files,
      hostBaselineGitDirectory,
      join(hostOperationTemporaryDirectory, "baseline.index"),
    );
    await this.commitSnapshot(
      workspaceDirectory,
      files,
      join(workspaceDirectory, ".git"),
      join(workspaceDirectory, ".git", "index"),
      true,
    );
    const binding: AgentWorkspaceBinding = {
      agentId,
      workspaceDirectory,
      resourceDirectory,
      recordsDirectory,
      hostBaselineGitDirectory,
      hostOperationTemporaryDirectory,
      baseSourceHash: mergeBase.hash,
    };
    await writeRecord(join(recordsDirectory, "workspace.json"), {
      schemaVersion: 1,
      ...binding,
      baselineCommit,
    });
    this.#agents.set(agentId, {
      binding,
      turns: new Map(),
      mergeBase,
      baselineCommit,
      latestTurnId: 0,
      appliedTurnId: 0,
    });
    return binding;
  }

  public finishTurn(
    agentId: string,
    turnId: number,
  ): Promise<AgentWorkspaceTurnResult> {
    return this.serialize(() => this.captureTurn(agentId, turnId));
  }

  private async captureTurn(
    agentId: string,
    turnId: number,
  ): Promise<AgentWorkspaceTurnResult> {
    this.assertAvailable();
    assertTurn(turnId);
    const state = this.state(agentId);
    if (turnId <= state.latestTurnId)
      throw new Error("Agent turn is stale or already recorded");
    const files = await collect(state.binding.workspaceDirectory);
    const turnDirectory = join(
      state.binding.resourceDirectory,
      "turns",
      String(turnId),
    );
    const recordDirectory = join(
      state.binding.recordsDirectory,
      "turns",
      String(turnId),
    );
    await createPrivateDirectory(turnDirectory);
    await createPrivateDirectory(recordDirectory);
    const candidate = await writeSnapshot(
      join(turnDirectory, "candidate"),
      files,
    );
    await readSnapshot(state.mergeBase);
    const extracted = await extractTaskPatch(
      {
        taskId: this.options.taskId,
        sourceKind: "project-environment-v1",
        workspaceDirectory: candidate.directory,
        hostBaselineGitDirectory: state.binding.hostBaselineGitDirectory,
        hostBaselineCommit: state.baselineCommit,
        baselineSourceHash: state.mergeBase.hash,
        ignoredCachePaths: [".chronorift", ".godot"],
        hostOperationTemporaryDirectory:
          state.binding.hostOperationTemporaryDirectory,
      },
      { git: this.#git },
    );
    if (extracted.identity.candidateSourceHash !== candidate.hash)
      throw new Error("Agent patch does not match the frozen candidate");
    const patchPath = join(recordDirectory, "candidate.patch");
    const patch = await open(
      patchPath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await patch.writeFile(extracted.patchBytes);
      await patch.sync();
    } finally {
      await patch.close();
    }
    const metadata: AgentWorkspaceTurnResult = {
      agentId,
      turnId,
      baseSourceHash: state.mergeBase.hash,
      candidateSourceHash: candidate.hash,
      patchHash: extracted.identity.patchHash,
      patchByteLength: extracted.identity.byteLength,
      patchPath,
      roundTripVerified: true,
    };
    await writeRecord(join(recordDirectory, "result.json"), {
      schemaVersion: 1,
      ...metadata,
    });
    state.turns.set(turnId, { metadata, candidate, base: state.mergeBase });
    state.latestTurnId = turnId;
    return metadata;
  }

  public async readPatch(
    agentId: string,
    turnId: number,
    offset = 0,
    limit = 16_384,
  ): Promise<{
    readonly text: string;
    readonly nextOffset: number;
    readonly totalBytes: number;
    readonly truncated: boolean;
  }> {
    assertTurn(turnId);
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 65_536
    )
      throw new TypeError("Invalid patch page bounds");
    const turn = this.state(agentId).turns.get(turnId);
    if (turn === undefined) throw new Error("Unknown agent result");
    await assertDirectory(dirname(turn.metadata.patchPath));
    const file = await open(
      turn.metadata.patchPath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const metadata = await file.stat();
      if (!metadata.isFile() || metadata.size !== turn.metadata.patchByteLength)
        throw new Error("Recorded agent patch was modified");
      const hash = createHash("sha256");
      for await (const chunk of file.createReadStream({
        autoClose: false,
        start: 0,
      }))
        hash.update(chunk as Buffer);
      if (hash.digest("hex") !== turn.metadata.patchHash)
        throw new Error("Recorded agent patch was modified");
      const content = Buffer.alloc(
        Math.min(limit, Math.max(0, metadata.size - offset)),
      );
      const { bytesRead } = await file.read(content, 0, content.length, offset);
      const nextOffset = Math.min(offset + bytesRead, metadata.size);
      return {
        text: content.subarray(0, bytesRead).toString("utf8"),
        nextOffset,
        totalBytes: metadata.size,
        truncated: nextOffset < metadata.size,
      };
    } finally {
      await file.close();
    }
  }

  private async install(
    root: FileHandle,
    paths: readonly string[],
    target: ReadonlyMap<string, SelectedTreeEntryV1>,
    phase: "apply" | "rollback",
  ): Promise<void> {
    // Remove deepest paths first, supporting ordinary file/directory transitions.
    for (const path of [...paths].sort(
      (left, right) => right.split("/").length - left.split("/").length,
    )) {
      if (!target.has(path)) {
        await this.dependencies.transactionStep?.(phase, path);
        await removeEntry(root, path);
      }
    }
    for (const path of [...paths].sort()) {
      const entry = target.get(path);
      if (entry === undefined) continue;
      await this.dependencies.transactionStep?.(phase, path);
      await writeEntry(root, entry);
    }
  }

  public applyTurn(
    agentId: string,
    turnId: number,
  ): Promise<AgentWorkspaceApplyResult> {
    return this.serialize(() => this.applyRecordedTurn(agentId, turnId));
  }

  private async applyRecordedTurn(
    agentId: string,
    turnId: number,
  ): Promise<AgentWorkspaceApplyResult> {
    this.assertAvailable();
    assertTurn(turnId);
    const state = this.state(agentId);
    const turn = state.turns.get(turnId);
    if (turn === undefined) throw new Error("Unknown agent result");
    if (turnId !== state.latestTurnId || turnId < state.appliedTurnId)
      return { status: "stale", conflicts: [] };
    if (turnId === state.appliedTurnId)
      return {
        status: "no_op",
        conflicts: [],
        rootSourceHash: selectedTreeSha256(
          await collect(this.options.rootWorkspaceDirectory),
        ),
      };
    if (turn.base.hash !== state.mergeBase.hash)
      return { status: "stale", conflicts: [] };
    const base = new Map(
      (await readSnapshot(turn.base)).map((entry) => [
        entry.relativePath,
        entry,
      ]),
    );
    const workerFiles = await readSnapshot(turn.candidate);
    const worker = new Map(
      workerFiles.map((entry) => [entry.relativePath, entry]),
    );
    const rootFiles = await collect(this.options.rootWorkspaceDirectory);
    const beforeHash = selectedTreeSha256(rootFiles);
    const current = new Map(
      rootFiles.map((entry) => [entry.relativePath, entry]),
    );
    const changes = [...new Set([...base.keys(), ...worker.keys()])].filter(
      (path) => !sameEntry(base.get(path), worker.get(path)),
    );
    const conflicts = changes.filter(
      (path) =>
        !sameEntry(current.get(path), base.get(path)) &&
        !sameEntry(current.get(path), worker.get(path)),
    );
    const merged = new Map(current);
    for (const path of changes) {
      const entry = worker.get(path);
      if (entry === undefined) merged.delete(path);
      else merged.set(path, entry);
    }
    conflicts.push(...treeConflicts([...merged.values()]));
    if (conflicts.length !== 0)
      return { status: "conflict", conflicts: [...new Set(conflicts)].sort() };
    const paths = changes.filter(
      (path) => !sameEntry(current.get(path), worker.get(path)),
    );
    const afterHash = selectedTreeSha256([...merged.values()]);
    const transactionId = randomUUID();
    const transactionDirectory = join(
      state.binding.hostOperationTemporaryDirectory,
      `apply-${transactionId}`,
    );
    const recordDirectory = join(
      state.binding.recordsDirectory,
      "applications",
      transactionId,
    );
    await createPrivateDirectory(transactionDirectory);
    await createPrivateDirectory(recordDirectory);
    const before = await writeSnapshot(
      join(transactionDirectory, "before"),
      rootFiles,
    );
    const after = await writeSnapshot(join(transactionDirectory, "after"), [
      ...merged.values(),
    ]);
    const nextCommit = await this.commitSnapshot(
      turn.candidate.directory,
      workerFiles,
      state.binding.hostBaselineGitDirectory,
      join(transactionDirectory, "next-baseline.index"),
    );
    await writeRecord(join(recordDirectory, "prepared.json"), {
      schemaVersion: 1,
      agentId,
      turnId,
      paths,
      beforeSourceHash: before.hash,
      afterSourceHash: after.hash,
      beforeDirectory: before.directory,
      afterDirectory: after.directory,
    });
    const root = await pinRoot(this.options.rootWorkspaceDirectory);
    try {
      if (
        selectedTreeSha256(
          await collect(this.options.rootWorkspaceDirectory),
        ) !== beforeHash
      )
        throw new Error("Root source changed before patch application");
      try {
        await this.install(root, paths, merged, "apply");
        await assertRootBound(this.options.rootWorkspaceDirectory, root);
        if (
          selectedTreeSha256(
            await collect(this.options.rootWorkspaceDirectory),
          ) !== afterHash
        )
          throw new Error("Root source differs from the verified integration");
        await writeRecord(join(recordDirectory, "committed.json"), {
          schemaVersion: 1,
          rootSourceHash: afterHash,
        });
      } catch (error) {
        try {
          await assertRootBound(this.options.rootWorkspaceDirectory, root);
          await this.install(root, paths, current, "rollback");
          await assertRootBound(this.options.rootWorkspaceDirectory, root);
          if (
            selectedTreeSha256(
              await collect(this.options.rootWorkspaceDirectory),
            ) !== beforeHash
          )
            throw new Error(
              "Rollback did not reproduce the original Root source",
            );
          await writeRecord(join(recordDirectory, "rolled-back.json"), {
            schemaVersion: 1,
            rootSourceHash: beforeHash,
          });
        } catch (rollbackError) {
          this.#poisoned = true;
          await writeRecord(join(recordDirectory, "rollback-failed.json"), {
            schemaVersion: 1,
            code: "workspace_rollback_failed",
          }).catch(() => undefined);
          throw new AgentWorkspaceRollbackError(rollbackError);
        }
        throw error;
      }
    } finally {
      await root.close();
    }
    state.mergeBase = turn.candidate;
    state.baselineCommit = nextCommit;
    state.appliedTurnId = turnId;
    return {
      status: paths.length === 0 ? "no_op" : "applied",
      conflicts: [],
      rootSourceHash: afterHash,
    };
  }
}
