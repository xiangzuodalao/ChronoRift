import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  asCapsuleId,
  asContractId,
  asExecutionId,
  asFixtureId,
  asProposalId,
  asRunId,
  type DiagnosisProposalV2,
  type DiagnosisProposalV3,
  type FrozenContractV2,
} from "@chronorift/domain";
import { describe, expect, it } from "vitest";

import {
  ArtifactIntegrityError,
  ArtifactPathSecurityError,
  ImmutableArtifactConflictError,
} from "./v01-json-artifact-repository.js";
import { V03JsonArtifactRepository } from "./v03-json-artifact-repository.js";

const contract: FrozenContractV2 = {
  schemaVersion: 2,
  contractId: asContractId("contract:v03:test"),
  fixtureId: asFixtureId("fixture"),
  authority: { status: "frozen", approvedBy: "test" },
  rule: {
    trigger: { kind: "signal", source: "source", name: "activated" },
    expectation: {
      kind: "property_equals",
      path: "door.open",
      value: true,
    },
    withinTicks: 1,
    inclusive: true,
  },
};

describe("V03JsonArtifactRepository", () => {
  it("round-trips a strict write-once Contract", async () => {
    const root = await mkdtemp(join(tmpdir(), "chronorift-v03-artifacts-"));
    const repository = new V03JsonArtifactRepository(root, asRunId("run:test"));
    await repository.putContract(contract);
    await expect(repository.getContract(contract.contractId)).resolves.toEqual(
      contract,
    );
    await expect(repository.putContract(contract)).resolves.toBeUndefined();
    await expect(
      repository.putContract({
        ...contract,
        rule: { ...contract.rule, withinTicks: 2 },
      }),
    ).rejects.toBeInstanceOf(ImmutableArtifactConflictError);
  });

  it("rejects a corrupted persisted DTO", async () => {
    const root = await mkdtemp(join(tmpdir(), "chronorift-v03-corrupt-"));
    const repository = new V03JsonArtifactRepository(root, asRunId("run:test"));
    await repository.putContract(contract);
    const path = join(
      repository.runDirectory,
      "contracts",
      `${encodeURIComponent(contract.contractId)}.json`,
    );
    const existing = JSON.parse(await readFile(path, "utf8")) as Record<
      string,
      unknown
    >;
    await writeFile(path, JSON.stringify({ ...existing, schemaVersion: 99 }));
    await expect(
      repository.getContract(contract.contractId),
    ).rejects.toBeInstanceOf(ArtifactIntegrityError);
  });

  it("rejects a schema-valid artifact stored under the wrong requested ID", async () => {
    const root = await mkdtemp(join(tmpdir(), "chronorift-v03-wrong-id-"));
    const repository = new V03JsonArtifactRepository(root, asRunId("run:test"));
    await repository.putContract(contract);
    const path = join(
      repository.runDirectory,
      "contracts",
      `${encodeURIComponent(contract.contractId)}.json`,
    );
    await writeFile(
      path,
      JSON.stringify({ ...contract, contractId: "contract:v03:other" }),
    );

    await expect(
      repository.getContract(contract.contractId),
    ).rejects.toBeInstanceOf(ArtifactIntegrityError);
  });

  it("stores V2 and V3 proposals independently without replacement", async () => {
    const root = await mkdtemp(join(tmpdir(), "chronorift-v03-proposals-"));
    const runId = asRunId("run:test");
    const repository = new V03JsonArtifactRepository(root, runId);
    const proposalId = asProposalId("proposal:same-id");
    const base = {
      proposalId,
      runId,
      fixtureId: contract.fixtureId,
      capsuleId: asCapsuleId("capsule:test"),
      baselineExecutionId: asExecutionId("execution:baseline"),
      comparisonIds: [],
      mechanismCode: "unknown" as const,
      summary: "Evidence is not yet sufficient",
      evidenceEventIds: [],
      blockers: ["missing experiment"],
      nextExperiment: "run one intervention",
      confidence: 1,
    };
    const v2: DiagnosisProposalV2 = { schemaVersion: 2, ...base };
    const v3: DiagnosisProposalV3 = {
      schemaVersion: 3,
      ...base,
      candidateExecutionIds: [],
      accessReceiptIds: [],
    };

    await repository.putProposal(v2);
    await repository.putProposalV3(v3);

    await expect(repository.getProposal(proposalId)).resolves.toEqual(v2);
    await expect(repository.getProposalV3(proposalId)).resolves.toEqual(v3);
    await expect(
      repository.putProposalV3({ ...v3, summary: "different content" }),
    ).rejects.toBeInstanceOf(ImmutableArtifactConflictError);

    const v3Path = join(
      repository.runDirectory,
      "proposals-v3",
      `${encodeURIComponent(proposalId)}.json`,
    );
    await writeFile(v3Path, JSON.stringify({ ...v3, schemaVersion: 2 }));
    await expect(repository.getProposalV3(proposalId)).rejects.toBeInstanceOf(
      ArtifactIntegrityError,
    );
    await expect(repository.getProposal(proposalId)).resolves.toEqual(v2);
  });

  it("rejects path-like run IDs", () => {
    expect(
      () =>
        new V03JsonArtifactRepository("/tmp/chronorift", asRunId("../escape")),
    ).toThrow(ArtifactPathSecurityError);
  });

  it("rejects an intermediate symlink without writing through it", async () => {
    const root = await mkdtemp(join(tmpdir(), "chronorift-v03-symlink-"));
    const outside = await mkdtemp(join(tmpdir(), "chronorift-v03-outside-"));
    await mkdir(root, { recursive: true });
    await symlink(outside, join(root, "v0.3"), "dir");
    const repository = new V03JsonArtifactRepository(root, asRunId("run:test"));
    await expect(repository.putContract(contract)).rejects.toBeInstanceOf(
      ArtifactPathSecurityError,
    );
    await expect(access(join(outside, "runs"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
