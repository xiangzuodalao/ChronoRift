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
  asContractId,
  asFixtureId,
  asRunId,
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
