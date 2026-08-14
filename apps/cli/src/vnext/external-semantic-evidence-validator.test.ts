import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const valid = {
  schemaVersion: 1,
  evidenceKind: "chronorift-e2-public-exposed-semantic-conformance",
  sourceCommit: "3e793f53598a131c53fb82555191cc14b8db07ff",
  sourceSelectedTreeSha256:
    "3e8bd6478d53586284010da38959005e2a377ef6277b2a838ecb1538abc096e8",
  adapterProfileSha256:
    "2600ae0d42a463d78a7c74b987799e74e7391c254f806ddbcc86b2256591f0e4",
  protocolProfile: "chronorift-godot-semantic-v1",
  toolNames: [
    "game_capabilities",
    "game_launch",
    "game_status",
    "game_stop",
    "game_query",
    "game_checkpoint_create",
    "game_checkpoint_restore",
    "game_fork",
    "game_trace_create",
    "game_trace_replay",
    "game_compare",
  ],
  executionCount: 2,
  allExecutionsSealed: true,
  fidelity: "descriptive_only",
  taskClassification: "public_exposed_plumbing_conformance",
  claimsExcluded: [
    "intelligent_diagnosis",
    "independent_acceptance",
    "equivalent_checkpoint_restore",
    "causality",
    "generalization",
  ],
};

const validate = async (value: unknown) => {
  const root = await mkdtemp(join(tmpdir(), "chronorift-e2-evidence-"));
  roots.push(root);
  const path = join(root, "evidence.json");
  await writeFile(path, JSON.stringify(value));
  return execFileAsync(
    process.execPath,
    [
      join(
        process.cwd(),
        ".github/scripts/validate-vnext-external-semantic-evidence.mjs",
      ),
      path,
    ],
    { encoding: "utf8" },
  );
};

describe("external semantic evidence validator", () => {
  it("accepts only the frozen, claim-bounded summary", async () => {
    await expect(validate(valid)).resolves.toMatchObject({ stderr: "" });
    const unknownField = await validate({ ...valid, accepted: true }).catch(
      (error: unknown) => error,
    );
    expect(
      String(
        typeof unknownField === "object" &&
          unknownField !== null &&
          "stderr" in unknownField
          ? unknownField.stderr
          : unknownField,
      ),
    ).toContain("missing or unknown");
    const strongerClaim = await validate({
      ...valid,
      fidelity: "equivalent",
    }).catch((error: unknown) => error);
    expect(
      String(
        typeof strongerClaim === "object" &&
          strongerClaim !== null &&
          "stderr" in strongerClaim
          ? strongerClaim.stderr
          : strongerClaim,
      ),
    ).toContain("fidelity is not frozen");
  });
});
