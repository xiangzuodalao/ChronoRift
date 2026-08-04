import { constants } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import {
  CheckpointContentSchema,
  CheckpointSchema,
  DiagnosisProposalV2Schema,
  DiagnosisProposalV3Schema,
  DiagnosisVerdictV2Schema,
  EvidenceCapsuleV2Schema,
  FrozenContractV2Schema,
  InputTraceV2Schema,
  V03BranchSpecSchema,
  V03ExecutionComparisonSchema,
  V03ExecutionLogSchema,
  asCheckpointId,
  type BranchId,
  type CapsuleId,
  type Checkpoint,
  type CheckpointContent,
  type CheckpointId,
  type ComparisonId,
  type ContractId,
  type DiagnosisProposalV2,
  type DiagnosisProposalV3,
  type DiagnosisVerdictV2,
  type EvidenceCapsuleV2,
  type ExecutionId,
  type FrozenContractV2,
  type InputTraceId,
  type InputTraceV2,
  type JsonValue,
  type ProposalId,
  type RunId,
  type V03BranchSpec,
  type V03ExecutionComparison,
  type V03ExecutionLog,
  type VerdictId,
} from "@chronorift/domain";
import type { V03ArtifactRepositoryPort } from "@chronorift/gamebranch";
import { canonicalJson, contentHash } from "./canonical-json.js";
import {
  ArtifactIntegrityError,
  ArtifactPathSecurityError,
  ImmutableArtifactConflictError,
} from "./v01-json-artifact-repository.js";

const safeSegment = (value: string): string => {
  if (
    value.length === 0 ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\") ||
    value.includes("\0") ||
    isAbsolute(value)
  ) {
    throw new ArtifactPathSecurityError(`Unsafe artifact ID: ${value}`);
  }
  return encodeURIComponent(value);
};

const isContained = (root: string, candidate: string): boolean => {
  const path = relative(root, candidate);
  return (
    path === "" ||
    (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))
  );
};

interface RuntimeSchema<T> {
  parse(value: unknown): T;
}

export class V03JsonArtifactRepository implements V03ArtifactRepositoryPort {
  public readonly runDirectory: string;
  private readonly artifactDirectory: string;
  private readonly storageDirectory: string;

  public constructor(
    artifactRoot: string,
    public readonly runId: RunId,
  ) {
    this.artifactDirectory = resolve(artifactRoot);
    this.storageDirectory = resolve(this.artifactDirectory, "v0.3");
    this.runDirectory = resolve(
      this.storageDirectory,
      "runs",
      safeSegment(runId),
    );
    if (!isContained(this.storageDirectory, this.runDirectory)) {
      throw new ArtifactPathSecurityError(
        "Run directory escapes artifact root",
      );
    }
  }

  private async ensureRealDirectory(directory: string): Promise<void> {
    let metadata;
    try {
      metadata = await lstat(directory);
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "ENOENT"
      ) {
        throw error;
      }
      await mkdir(directory);
      metadata = await lstat(directory);
    }
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new ArtifactPathSecurityError(
        `Artifact parent is not a real directory: ${directory}`,
      );
    }
  }

  private path(kind: string, id: string): string {
    const candidate = resolve(
      this.runDirectory,
      safeSegment(kind),
      `${safeSegment(id)}.json`,
    );
    if (!isContained(this.runDirectory, candidate)) {
      throw new ArtifactPathSecurityError(
        "Artifact path escapes run directory",
      );
    }
    return candidate;
  }

  private async assertSafeParents(path: string): Promise<void> {
    const parent = resolve(path, "..");
    await mkdir(this.artifactDirectory, { recursive: true });
    for (const directory of [
      this.artifactDirectory,
      this.storageDirectory,
      resolve(this.storageDirectory, "runs"),
      this.runDirectory,
      parent,
    ]) {
      await this.ensureRealDirectory(directory);
    }
    const canonicalRoot = await realpath(this.artifactDirectory);
    for (const directory of [
      this.storageDirectory,
      this.runDirectory,
      parent,
    ]) {
      const canonical = await realpath(directory);
      if (!isContained(canonicalRoot, canonical)) {
        throw new ArtifactPathSecurityError(
          `Artifact parent resolves outside artifact root: ${directory}`,
        );
      }
    }
  }

  private async assertRegularArtifact(path: string): Promise<void> {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new ArtifactPathSecurityError(
        `Artifact is not a regular file: ${path}`,
      );
    }
    const canonical = await realpath(path);
    const canonicalRun = await realpath(this.runDirectory);
    if (!isContained(canonicalRun, canonical)) {
      throw new ArtifactPathSecurityError(
        `Artifact resolves outside run directory: ${path}`,
      );
    }
  }

  private async put<T>(
    kind: string,
    id: string,
    schema: RuntimeSchema<T>,
    value: T,
  ): Promise<void> {
    const parsed = schema.parse(value);
    const path = this.path(kind, id);
    await this.assertSafeParents(path);
    const serialized = `${canonicalJson(parsed as unknown as JsonValue)}\n`;
    try {
      await writeFile(path, serialized, { encoding: "utf8", flag: "wx" });
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "EEXIST"
      ) {
        throw error;
      }
      await this.assertRegularArtifact(path);
      const existing = await readFile(path, "utf8");
      if (existing !== serialized) {
        throw new ImmutableArtifactConflictError(
          `Refusing to overwrite immutable ${kind} ${id}`,
        );
      }
    }
  }

  private async get<T>(
    kind: string,
    id: string,
    schema: RuntimeSchema<T>,
    identity: (value: T) => string,
    validateIntegrity?: (value: T) => void,
  ): Promise<T> {
    const path = this.path(kind, id);
    try {
      await access(path, constants.R_OK);
      await this.assertRegularArtifact(path);
      const parsed = schema.parse(
        JSON.parse(await readFile(path, "utf8")) as unknown,
      );
      if (identity(parsed) !== id) {
        throw new ArtifactIntegrityError(
          `${kind}:${id}: stored identity does not match requested identity`,
        );
      }
      validateIntegrity?.(parsed);
      return parsed;
    } catch (error) {
      if (
        error instanceof ArtifactPathSecurityError ||
        error instanceof ArtifactIntegrityError
      ) {
        throw error;
      }
      void error;
      throw new ArtifactIntegrityError(`${kind}:${id}`);
    }
  }

  public async putCheckpoint(content: CheckpointContent): Promise<Checkpoint> {
    const parsed = CheckpointContentSchema.parse(content);
    const checkpoint = CheckpointSchema.parse({
      checkpointId: asCheckpointId(
        `checkpoint:v03:${contentHash(parsed as unknown as JsonValue)}`,
      ),
      content: parsed,
    });
    await this.put(
      "checkpoints",
      checkpoint.checkpointId,
      CheckpointSchema,
      checkpoint,
    );
    return checkpoint;
  }

  public getCheckpoint(id: CheckpointId): Promise<Checkpoint> {
    return this.get(
      "checkpoints",
      id,
      CheckpointSchema,
      (value) => value.checkpointId,
      (value) => {
        const expected = asCheckpointId(
          `checkpoint:v03:${contentHash(value.content as unknown as JsonValue)}`,
        );
        if (value.checkpointId !== expected) {
          throw new ArtifactIntegrityError(
            `checkpoints:${id}: content-addressed identity is invalid`,
          );
        }
      },
    );
  }
  public putContract(value: FrozenContractV2): Promise<void> {
    return this.put(
      "contracts",
      value.contractId,
      FrozenContractV2Schema,
      value,
    );
  }
  public getContract(id: ContractId): Promise<FrozenContractV2> {
    return this.get(
      "contracts",
      id,
      FrozenContractV2Schema,
      (value) => value.contractId,
    );
  }
  public putInputTrace(value: InputTraceV2): Promise<void> {
    return this.put("traces", value.inputTraceId, InputTraceV2Schema, value);
  }
  public getInputTrace(id: InputTraceId): Promise<InputTraceV2> {
    return this.get(
      "traces",
      id,
      InputTraceV2Schema,
      (value) => value.inputTraceId,
    );
  }
  public putBranch(value: V03BranchSpec): Promise<void> {
    return this.put("branches", value.branchId, V03BranchSpecSchema, value);
  }
  public getBranch(id: BranchId): Promise<V03BranchSpec> {
    return this.get(
      "branches",
      id,
      V03BranchSpecSchema,
      (value) => value.branchId,
    );
  }
  public putExecution(value: V03ExecutionLog): Promise<void> {
    return this.put(
      "executions",
      value.executionId,
      V03ExecutionLogSchema,
      value,
    );
  }
  public getExecution(id: ExecutionId): Promise<V03ExecutionLog> {
    return this.get(
      "executions",
      id,
      V03ExecutionLogSchema,
      (value) => value.executionId,
    );
  }
  public putCapsule(value: EvidenceCapsuleV2): Promise<void> {
    return this.put(
      "capsules",
      value.capsuleId,
      EvidenceCapsuleV2Schema,
      value,
    );
  }
  public getCapsule(id: CapsuleId): Promise<EvidenceCapsuleV2> {
    return this.get(
      "capsules",
      id,
      EvidenceCapsuleV2Schema,
      (value) => value.capsuleId,
    );
  }
  public putComparison(value: V03ExecutionComparison): Promise<void> {
    return this.put(
      "comparisons",
      value.comparisonId,
      V03ExecutionComparisonSchema,
      value,
    );
  }
  public getComparison(id: ComparisonId): Promise<V03ExecutionComparison> {
    return this.get(
      "comparisons",
      id,
      V03ExecutionComparisonSchema,
      (value) => value.comparisonId,
    );
  }
  public putProposal(value: DiagnosisProposalV2): Promise<void> {
    return this.put(
      "proposals",
      value.proposalId,
      DiagnosisProposalV2Schema,
      value,
    );
  }
  public getProposal(id: ProposalId): Promise<DiagnosisProposalV2> {
    return this.get(
      "proposals",
      id,
      DiagnosisProposalV2Schema,
      (value) => value.proposalId,
    );
  }
  public putProposalV3(value: DiagnosisProposalV3): Promise<void> {
    return this.put(
      "proposals-v3",
      value.proposalId,
      DiagnosisProposalV3Schema,
      value,
    );
  }
  public getProposalV3(id: ProposalId): Promise<DiagnosisProposalV3> {
    return this.get(
      "proposals-v3",
      id,
      DiagnosisProposalV3Schema,
      (value) => value.proposalId,
    );
  }
  public putVerdict(value: DiagnosisVerdictV2): Promise<void> {
    return this.put(
      "verdicts",
      value.verdictId,
      DiagnosisVerdictV2Schema,
      value,
    );
  }
  public getVerdict(id: VerdictId): Promise<DiagnosisVerdictV2> {
    return this.get(
      "verdicts",
      id,
      DiagnosisVerdictV2Schema,
      (value) => value.verdictId,
    );
  }
}
