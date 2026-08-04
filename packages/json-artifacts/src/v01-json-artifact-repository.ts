import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, win32 } from "node:path";

import {
  BranchSpecSchema,
  CheckpointContentSchema,
  CheckpointSchema,
  DiagnosisProposalSchema,
  DiagnosisVerdictSchema,
  EvidenceCapsuleSchema,
  ExecutionComparisonSchema,
  ExecutionLogSchema,
  FrozenContractSchema,
  InputTraceSchema,
  V01CheckpointArtifactSchema,
  asCheckpointId,
  asInputTraceId,
  type BranchId,
  type BranchSpec,
  type CapsuleId,
  type Checkpoint,
  type CheckpointContent,
  type CheckpointId,
  type ComparisonId,
  type ContractId,
  type DiagnosisProposal,
  type DiagnosisVerdict,
  type EvidenceCapsule,
  type ExecutionComparison,
  type ExecutionId,
  type ExecutionLog,
  type FrozenContract,
  type InputTrace,
  type InputTraceId,
  type JsonValue,
  type ProposalId,
  type RunId,
  type VerdictId,
} from "@chronorift/domain";
import {
  isFrozenContractAuthentic,
  type V01ArtifactRepositoryPort,
} from "@chronorift/gamebranch";

import { canonicalJson, contentHash } from "./canonical-json.js";
import {
  ArtifactCorruptionError,
  ArtifactNotFoundError,
} from "./json-artifact-repository.js";

export class ImmutableArtifactConflictError extends Error {
  constructor(readonly artifactPath: string) {
    super(
      `Immutable artifact already exists with different content: ${artifactPath}`,
    );
    this.name = "ImmutableArtifactConflictError";
  }
}

export class ArtifactPathSecurityError extends Error {
  constructor(
    readonly artifactPath: string,
    reason = "path contains a symbolic link, a non-directory, or escapes the repository root",
  ) {
    super(`Artifact path rejected: ${artifactPath} (${reason})`);
    this.name = "ArtifactPathSecurityError";
  }
}

export class ArtifactIntegrityError extends Error {
  constructor(readonly artifactId: string) {
    super(
      `Artifact content does not match its content-addressed identity: ${artifactId}`,
    );
    this.name = "ArtifactIntegrityError";
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
}

interface ArtifactParentIdentity {
  readonly root: FileIdentity;
  readonly parent: FileIdentity;
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function fileIdentity(value: {
  readonly dev: number;
  readonly ino: number;
}): FileIdentity {
  return { dev: value.dev, ino: value.ino };
}

function assertSafeArtifactId(id: string): void {
  const containsParentSegment = id
    .split(/[\\/]+/u)
    .some((segment) => segment === "..");
  if (
    id.length === 0 ||
    id.includes("\0") ||
    isAbsolute(id) ||
    win32.isAbsolute(id) ||
    containsParentSegment
  ) {
    throw new ArtifactPathSecurityError(
      id,
      "artifact IDs must be non-empty relative values without parent-directory segments",
    );
  }
}

const artifactSegment = (id: string): string => {
  assertSafeArtifactId(id);
  try {
    return encodeURIComponent(id).replaceAll(".", "%2E");
  } catch (error) {
    throw new ArtifactPathSecurityError(
      id,
      error instanceof Error ? error.message : "artifact ID cannot be encoded",
    );
  }
};

const checkpointIdFor = (content: CheckpointContent): CheckpointId =>
  asCheckpointId(`checkpoint_${contentHash(content as unknown as JsonValue)}`);

const inputTraceIdFor = (trace: InputTrace): InputTraceId =>
  asInputTraceId(
    `trace:sha256:${contentHash({
      schemaVersion: trace.schemaVersion,
      scheduleBasis: trace.scheduleBasis,
      inputs: trace.inputs,
    } as unknown as JsonValue)}`,
  );

/**
 * Write-once repository for the v0.1 vertical slice.
 *
 * It intentionally lives beside the Phase 1 repository instead of changing
 * legacy artifacts in place. Every read and write crosses a strict schema
 * boundary, while hard-link publication makes concurrent creation atomic.
 */
export class V01JsonArtifactRepository implements V01ArtifactRepositoryPort {
  readonly rootDirectory: string;
  private canonicalRootPromise: Promise<string> | undefined;

  constructor(rootDirectory: string) {
    this.rootDirectory = resolve(rootDirectory);
  }

  async putCheckpoint(content: CheckpointContent): Promise<Checkpoint> {
    const parsed = CheckpointContentSchema.parse(content);
    const checkpoint = CheckpointSchema.parse({
      checkpointId: checkpointIdFor(parsed),
      content: parsed,
    });
    await this.writeImmutable(
      this.artifactPath("checkpoints", checkpoint.checkpointId, true),
      { schemaVersion: 1, checkpoint },
      V01CheckpointArtifactSchema,
    );
    return checkpoint;
  }

  async getCheckpoint(checkpointId: CheckpointId): Promise<Checkpoint> {
    const artifact = await this.readJson(
      this.artifactPath("checkpoints", checkpointId, false),
      V01CheckpointArtifactSchema,
    );
    if (
      artifact.checkpoint.checkpointId !== checkpointId ||
      checkpointIdFor(artifact.checkpoint.content) !== checkpointId
    ) {
      throw new ArtifactIntegrityError(checkpointId);
    }
    return artifact.checkpoint;
  }

  async putInputTrace(trace: InputTrace): Promise<void> {
    const parsed = InputTraceSchema.parse(trace);
    if (inputTraceIdFor(parsed) !== parsed.inputTraceId) {
      throw new ArtifactIntegrityError(parsed.inputTraceId);
    }
    await this.writeImmutable(
      this.artifactPath("input-traces", parsed.inputTraceId, true),
      parsed,
      InputTraceSchema,
    );
  }

  async getInputTrace(inputTraceId: InputTraceId): Promise<InputTrace> {
    const trace = await this.readJson(
      this.artifactPath("input-traces", inputTraceId, false),
      InputTraceSchema,
    );
    if (
      trace.inputTraceId !== inputTraceId ||
      inputTraceIdFor(trace) !== inputTraceId
    ) {
      throw new ArtifactIntegrityError(inputTraceId);
    }
    return trace;
  }

  async putFrozenContract(contract: FrozenContract): Promise<void> {
    if (!isFrozenContractAuthentic(contract)) {
      throw new ArtifactIntegrityError(contract.contractId);
    }
    await this.writeImmutable(
      this.artifactPath("contracts", contract.contractId, true),
      contract,
      FrozenContractSchema,
    );
  }

  async getFrozenContract(contractId: ContractId): Promise<FrozenContract> {
    const contract = await this.readJson(
      this.artifactPath("contracts", contractId, false),
      FrozenContractSchema,
    );
    if (
      contract.contractId !== contractId ||
      !isFrozenContractAuthentic(contract)
    ) {
      throw new ArtifactIntegrityError(contractId);
    }
    return contract;
  }

  async putBranchSpec(branch: BranchSpec): Promise<void> {
    await this.writeImmutable(
      this.artifactPath("branch-specs", branch.branchId, true),
      branch,
      BranchSpecSchema,
    );
  }

  async getBranchSpec(branchId: BranchId): Promise<BranchSpec> {
    const branch = await this.readJson(
      this.artifactPath("branch-specs", branchId, false),
      BranchSpecSchema,
    );
    if (branch.branchId !== branchId) {
      throw new ArtifactIntegrityError(branchId);
    }
    return branch;
  }

  async putExecutionLog(execution: ExecutionLog): Promise<void> {
    await this.writeImmutable(
      this.artifactPath("executions", execution.executionId, true),
      execution,
      ExecutionLogSchema,
    );
  }

  async getExecutionLog(executionId: ExecutionId): Promise<ExecutionLog> {
    const execution = await this.readJson(
      this.artifactPath("executions", executionId, false),
      ExecutionLogSchema,
    );
    if (execution.executionId !== executionId) {
      throw new ArtifactIntegrityError(executionId);
    }
    return execution;
  }

  async putEvidenceCapsule(capsule: EvidenceCapsule): Promise<void> {
    await this.writeImmutable(
      this.artifactPath("capsules", capsule.capsuleId, true),
      capsule,
      EvidenceCapsuleSchema,
    );
  }

  async getEvidenceCapsule(capsuleId: CapsuleId): Promise<EvidenceCapsule> {
    const capsule = await this.readJson(
      this.artifactPath("capsules", capsuleId, false),
      EvidenceCapsuleSchema,
    );
    if (capsule.capsuleId !== capsuleId) {
      throw new ArtifactIntegrityError(capsuleId);
    }
    return capsule;
  }

  async putExecutionComparison(comparison: ExecutionComparison): Promise<void> {
    await this.writeImmutable(
      this.artifactPath("comparisons", comparison.comparisonId, true),
      comparison,
      ExecutionComparisonSchema,
    );
  }

  async getExecutionComparison(
    comparisonId: ComparisonId,
  ): Promise<ExecutionComparison> {
    const comparison = await this.readJson(
      this.artifactPath("comparisons", comparisonId, false),
      ExecutionComparisonSchema,
    );
    if (comparison.comparisonId !== comparisonId) {
      throw new ArtifactIntegrityError(comparisonId);
    }
    return comparison;
  }

  async putDiagnosisProposal(proposal: DiagnosisProposal): Promise<void> {
    await this.writeImmutable(
      this.artifactPath("proposals", proposal.proposalId, true),
      proposal,
      DiagnosisProposalSchema,
    );
  }

  async getDiagnosisProposal(
    proposalId: ProposalId,
  ): Promise<DiagnosisProposal> {
    const proposal = await this.readJson(
      this.artifactPath("proposals", proposalId, false),
      DiagnosisProposalSchema,
    );
    if (proposal.proposalId !== proposalId) {
      throw new ArtifactIntegrityError(proposalId);
    }
    return proposal;
  }

  async putDiagnosisVerdict(verdict: DiagnosisVerdict): Promise<void> {
    await this.writeImmutable(
      this.artifactPath("verdicts", verdict.verdictId, true),
      verdict,
      DiagnosisVerdictSchema,
    );
  }

  async getDiagnosisVerdict(verdictId: VerdictId): Promise<DiagnosisVerdict> {
    const verdict = await this.readJson(
      this.artifactPath("verdicts", verdictId, false),
      DiagnosisVerdictSchema,
    );
    if (verdict.verdictId !== verdictId) {
      throw new ArtifactIntegrityError(verdictId);
    }
    return verdict;
  }

  async resolveRunDirectory(runId: RunId): Promise<string> {
    const segments = ["v0.1", "runs", artifactSegment(runId)] as const;
    const runDirectory = await this.secureDirectory(segments, true);
    await this.secureDirectory([...segments, "pi-sessions"], true);
    return runDirectory;
  }

  private async artifactPath(
    collection: string,
    id: string,
    createParent: boolean,
  ): Promise<string> {
    assertSafeArtifactId(id);
    const parent = await this.secureDirectory(
      ["v0.1", collection],
      createParent,
    );
    return join(parent, `${artifactSegment(id)}.json`);
  }

  private async writeImmutable<T>(
    pathPromise: Promise<string>,
    value: T,
    schema: { parse(value: unknown): T },
  ): Promise<void> {
    const parsed = schema.parse(value);
    const path = await pathPromise;
    const temporaryPath = `${path}.${randomUUID()}.tmp`;
    const serialized = `${JSON.stringify(parsed, null, 2)}\n`;
    const parentIdentity = await this.artifactParentIdentity(path);
    const temporaryHandle = await open(
      temporaryPath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    const temporaryStatus = await temporaryHandle.stat();
    if (!temporaryStatus.isFile()) {
      await temporaryHandle.close();
      throw new ArtifactPathSecurityError(
        temporaryPath,
        "temporary artifact is not a regular file",
      );
    }
    const temporaryIdentity = fileIdentity(temporaryStatus);

    try {
      await this.assertArtifactParentIdentity(path, parentIdentity);
      await temporaryHandle.writeFile(serialized, "utf8");
      await this.assertArtifactParentIdentity(path, parentIdentity);
      try {
        const linkedSource = await lstat(temporaryPath);
        if (
          !linkedSource.isFile() ||
          linkedSource.isSymbolicLink() ||
          !sameIdentity(fileIdentity(linkedSource), temporaryIdentity)
        ) {
          throw new ArtifactPathSecurityError(
            temporaryPath,
            "temporary artifact identity changed before publication",
          );
        }
        await link(temporaryPath, path);
        const publishedHandle = await this.openRegularArtifact(path);
        try {
          const publishedIdentity = fileIdentity(await publishedHandle.stat());
          if (!sameIdentity(publishedIdentity, temporaryIdentity)) {
            throw new ArtifactPathSecurityError(
              path,
              "published artifact does not match the staged inode",
            );
          }
        } finally {
          await publishedHandle.close();
        }
        await this.assertArtifactParentIdentity(path, parentIdentity);
      } catch (error) {
        if (!isNodeError(error) || error.code !== "EEXIST") throw error;
        await this.assertArtifactParentIdentity(path, parentIdentity);
        const existing = await this.readJson(path, schema);
        await this.assertArtifactParentIdentity(path, parentIdentity);
        const existingCanonical = canonicalJson(
          existing as unknown as JsonValue,
        );
        const parsedCanonical = canonicalJson(parsed as unknown as JsonValue);
        if (existingCanonical !== parsedCanonical) {
          throw new ImmutableArtifactConflictError(path);
        }
      }
    } finally {
      await temporaryHandle.close();
      await this.unlinkStagedArtifact(
        temporaryPath,
        path,
        temporaryIdentity,
        parentIdentity,
      );
    }
  }

  private async readJson<T>(
    pathPromise: Promise<string> | string,
    schema: { parse(value: unknown): T },
  ): Promise<T> {
    const path = await pathPromise;
    let text: string;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    const parentIdentity = await this.artifactParentIdentity(path);
    try {
      const before = await lstat(path);
      if (before.isSymbolicLink() || !before.isFile()) {
        throw new ArtifactPathSecurityError(
          path,
          "artifact is not a regular file",
        );
      }
      handle = await this.openRegularArtifact(path);
      const opened = await handle.stat();
      if (!sameIdentity(fileIdentity(before), fileIdentity(opened))) {
        throw new ArtifactPathSecurityError(
          path,
          "artifact identity changed while opening",
        );
      }
      text = await handle.readFile("utf8");
      await this.assertArtifactParentIdentity(path, parentIdentity);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        throw new ArtifactNotFoundError(path);
      }
      if (isNodeError(error) && error.code === "ELOOP") {
        throw new ArtifactPathSecurityError(path);
      }
      throw error;
    } finally {
      await handle?.close();
    }

    try {
      return schema.parse(JSON.parse(text));
    } catch (error) {
      throw new ArtifactCorruptionError(path, error);
    }
  }

  private canonicalRoot(): Promise<string> {
    this.canonicalRootPromise ??= (async () => {
      try {
        await mkdir(this.rootDirectory, { recursive: true });
      } catch (error) {
        if (!isNodeError(error) || error.code !== "EEXIST") throw error;
      }
      await this.canonicalDirectoryIdentity(this.rootDirectory);
      return this.rootDirectory;
    })();
    return this.canonicalRootPromise;
  }

  private async secureDirectory(
    segments: readonly string[],
    create: boolean,
  ): Promise<string> {
    let current = await this.canonicalRoot();
    await this.canonicalDirectoryIdentity(current);
    for (const segment of segments) {
      if (
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        isAbsolute(segment) ||
        win32.isAbsolute(segment) ||
        segment.includes("/") ||
        segment.includes("\\")
      ) {
        throw new ArtifactPathSecurityError(
          segment,
          "repository directory segments must be simple relative names",
        );
      }
      const next = join(current, segment);
      try {
        await this.canonicalDirectoryIdentity(next);
      } catch (error) {
        if (!isNodeError(error) || error.code !== "ENOENT") throw error;
        if (!create) throw new ArtifactNotFoundError(next);
        try {
          await mkdir(next);
        } catch (mkdirError) {
          if (!isNodeError(mkdirError) || mkdirError.code !== "EEXIST") {
            throw mkdirError;
          }
        }
        await this.canonicalDirectoryIdentity(next);
      }
      current = next;
    }
    return current;
  }

  private async canonicalDirectoryIdentity(
    path: string,
  ): Promise<FileIdentity> {
    const status = await lstat(path);
    if (status.isSymbolicLink() || !status.isDirectory()) {
      throw new ArtifactPathSecurityError(
        path,
        "expected a real directory, not a symbolic link",
      );
    }
    const canonical = await realpath(path);
    if (resolve(canonical) !== resolve(path)) {
      throw new ArtifactPathSecurityError(
        path,
        `canonical directory resolves outside its lexical path: ${canonical}`,
      );
    }
    return fileIdentity(status);
  }

  private async artifactParentIdentity(
    artifactPath: string,
  ): Promise<ArtifactParentIdentity> {
    const root = await this.canonicalRoot();
    const parent = dirname(artifactPath);
    const fromRoot = relative(root, parent);
    if (
      fromRoot === ".." ||
      fromRoot.startsWith(`..${win32.sep}`) ||
      fromRoot.startsWith("../") ||
      isAbsolute(fromRoot) ||
      win32.isAbsolute(fromRoot)
    ) {
      throw new ArtifactPathSecurityError(
        artifactPath,
        "artifact parent escapes the canonical repository root",
      );
    }
    return {
      root: await this.canonicalDirectoryIdentity(root),
      parent: await this.canonicalDirectoryIdentity(parent),
    };
  }

  private async assertArtifactParentIdentity(
    artifactPath: string,
    expected: ArtifactParentIdentity,
  ): Promise<void> {
    const actual = await this.artifactParentIdentity(artifactPath);
    if (
      !sameIdentity(actual.root, expected.root) ||
      !sameIdentity(actual.parent, expected.parent)
    ) {
      throw new ArtifactPathSecurityError(
        artifactPath,
        "repository root or artifact directory changed during I/O",
      );
    }
  }

  private async openRegularArtifact(
    path: string,
  ): Promise<Awaited<ReturnType<typeof open>>> {
    try {
      const handle = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      const status = await handle.stat();
      if (!status.isFile()) {
        await handle.close();
        throw new ArtifactPathSecurityError(
          path,
          "artifact is not a regular file",
        );
      }
      return handle;
    } catch (error) {
      if (isNodeError(error) && error.code === "ELOOP") {
        throw new ArtifactPathSecurityError(
          path,
          "symbolic-link artifact rejected by O_NOFOLLOW",
        );
      }
      throw error;
    }
  }

  private async unlinkStagedArtifact(
    temporaryPath: string,
    artifactPath: string,
    expectedFile: FileIdentity,
    expectedParent: ArtifactParentIdentity,
  ): Promise<void> {
    await this.assertArtifactParentIdentity(artifactPath, expectedParent);
    try {
      const status = await lstat(temporaryPath);
      if (
        status.isSymbolicLink() ||
        !status.isFile() ||
        !sameIdentity(fileIdentity(status), expectedFile)
      ) {
        throw new ArtifactPathSecurityError(
          temporaryPath,
          "staged artifact identity changed before cleanup",
        );
      }
      await unlink(temporaryPath);
      await this.assertArtifactParentIdentity(artifactPath, expectedParent);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return;
      throw error;
    }
  }
}
