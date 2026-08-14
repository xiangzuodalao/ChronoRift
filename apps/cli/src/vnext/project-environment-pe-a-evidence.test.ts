import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { asBuildId } from "@chronorift/domain";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildProjectEnvironmentPeATestInput,
  cleanupProjectEnvironmentPeATestInputs,
} from "./project-environment-pe-a-evidence-test-fixture.js";
import { buildProjectEnvironmentPeAEvidenceV1 } from "./project-environment-pe-a-evidence.js";

const validatorPath = resolve(
  ".github/scripts/validate-project-environment-pe-a-evidence.mjs",
);
const schemaPath = resolve(
  "testdata/vnext/project-environment/pe-a-evidence-bundle.schema.v1.json",
);
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all([
    cleanupProjectEnvironmentPeATestInputs(),
    ...temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  ]);
});

describe("buildProjectEnvironmentPeAEvidenceV1", () => {
  it("projects real product DTOs into a bundle accepted by the independent validator", async () => {
    const evidence = buildProjectEnvironmentPeAEvidenceV1(
      await buildProjectEnvironmentPeATestInput(),
    );
    const root = await mkdtemp(join(tmpdir(), "chronorift-pe-a-builder-"));
    temporaryRoots.push(root);
    const evidencePath = join(root, "evidence.json");
    await writeFile(evidencePath, `${JSON.stringify(evidence)}\n`, "utf8");

    const validated = spawnSync(
      process.execPath,
      [validatorPath, schemaPath, evidencePath],
      { encoding: "utf8" },
    );

    expect(validated.stderr).toBe("");
    expect(validated.status).toBe(0);
    expect(JSON.parse(validated.stdout)).toMatchObject({
      schemaVersion: 1,
      bundleContentHash: evidence.bundleContentHash,
      buildId: evidence.candidateBuild.buildId,
    });
    expect(JSON.stringify(evidence)).not.toContain("path-must-not-be-exported");
  });

  it("fails closed before export when the goal or durable runtime binding is absent", async () => {
    const goalMissing = await buildProjectEnvironmentPeATestInput();
    const runtimeMismatch = await buildProjectEnvironmentPeATestInput();

    expect(() =>
      buildProjectEnvironmentPeAEvidenceV1({
        ...goalMissing,
        goalDelivered: false,
      }),
    ).toThrow(/goal was not delivered/u);
    expect(() =>
      buildProjectEnvironmentPeAEvidenceV1({
        ...runtimeMismatch,
        runtime: {
          ...runtimeMismatch.runtime,
          buildId: asBuildId("build:foreign"),
        },
      }),
    ).toThrow(/runtime observation/u);
  });
});
