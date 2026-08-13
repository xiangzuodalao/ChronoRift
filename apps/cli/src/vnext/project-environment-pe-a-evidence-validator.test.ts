import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { contentHash } from "@chronorift/json-artifacts";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildProjectEnvironmentPeATestInput,
  cleanupProjectEnvironmentPeATestInputs,
} from "./project-environment-pe-a-evidence-test-fixture.js";
import {
  buildProjectEnvironmentPeAEvidenceV1,
  type ProjectEnvironmentPeAEvidenceBundleV1,
} from "./project-environment-pe-a-evidence.js";

const validatorPath = resolve(
  ".github/scripts/validate-project-environment-pe-a-evidence.mjs",
);
const schemaPath = resolve(
  "testdata/vnext/project-environment/pe-a-evidence-bundle.schema.v1.json",
);
const roots: string[] = [];

type Mutable<T> = T extends readonly (infer U)[]
  ? Mutable<U>[]
  : T extends object
    ? { -readonly [K in keyof T]: Mutable<T[K]> }
    : T;
type MutableEvidence = Mutable<ProjectEnvironmentPeAEvidenceBundleV1>;

const jsonValue = (value: unknown): Parameters<typeof contentHash>[0] =>
  JSON.parse(JSON.stringify(value)) as Parameters<typeof contentHash>[0];

const freshEvidence = async (): Promise<MutableEvidence> =>
  structuredClone(
    buildProjectEnvironmentPeAEvidenceV1(
      await buildProjectEnvironmentPeATestInput(),
    ),
  ) as unknown as MutableEvidence;

const resealRecord = (value: { recordHash: string }): void => {
  value.recordHash = contentHash(
    jsonValue(
      Object.fromEntries(
        Object.entries(value).filter(([key]) => key !== "recordHash"),
      ),
    ),
  );
};

const resealBundle = (value: MutableEvidence): void => {
  value.bundleContentHash = contentHash(
    jsonValue(
      Object.fromEntries(
        Object.entries(value).filter(([key]) => key !== "bundleContentHash"),
      ),
    ),
  );
};

afterEach(async () => {
  await Promise.all([
    cleanupProjectEnvironmentPeATestInputs(),
    ...roots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  ]);
});

const runValidator = async (
  evidence: unknown,
  options?: { readonly raw?: string; readonly schemaBytes?: string },
) => {
  const root = await mkdtemp(join(tmpdir(), "chronorift-pe-a-validator-"));
  roots.push(root);
  const evidencePath = join(root, "evidence.json");
  const selectedSchemaPath =
    options?.schemaBytes === undefined ? schemaPath : join(root, "schema.json");
  if (options?.schemaBytes !== undefined) {
    await writeFile(selectedSchemaPath, options.schemaBytes, "utf8");
  }
  await writeFile(
    evidencePath,
    options?.raw ?? `${JSON.stringify(evidence)}\n`,
    "utf8",
  );
  return spawnSync(
    process.execPath,
    [validatorPath, selectedSchemaPath, evidencePath],
    { encoding: "utf8" },
  );
};

describe("independent PE-A evidence validator", () => {
  it("accepts a strict canonical-hash-linked two-Session product bundle", async () => {
    const evidence = await freshEvidence();
    const result = await runValidator(evidence);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      schemaVersion: 1,
      bundleContentHash: evidence.bundleContentHash,
      environmentRevisionId: evidence.environment.environmentRevisionId,
      buildId: evidence.candidateBuild.buildId,
      compatibilityReceiptId: evidence.compatibility.receiptId,
      reuseTaskId: evidence.reuse.receipt.taskId,
      reuseSessionId: evidence.reuse.receipt.sessionId,
      reuseReceiptId: evidence.reuse.receipt.receiptId,
      reuseBuildId: evidence.reuse.candidateBuild.buildId,
      reuseCompatibilityReceiptId: evidence.reuse.compatibility.receiptId,
      reuseRuntimeObservationReceiptId: evidence.reuse.runtime.receiptId,
    });
    expect(result.stderr).toBe("");
  });

  it("rejects unknown keys, duplicate keys, and frozen-schema drift", async () => {
    const unknown = await freshEvidence();
    const unknownRecord = unknown as MutableEvidence & {
      agentConclusion?: string;
    };
    unknownRecord.agentConclusion = "passed";
    resealBundle(unknown);
    const unknownResult = await runValidator(unknown);

    const duplicate = `${JSON.stringify(await freshEvidence()).replace(
      /^\{/u,
      '{"schemaVersion":1,',
    )}\n`;
    const duplicateResult = await runValidator({}, { raw: duplicate });

    const schemaBytes = await readFile(schemaPath, "utf8");
    const schemaResult = await runValidator(await freshEvidence(), {
      schemaBytes: `${schemaBytes}\n`,
    });

    expect(unknownResult.status).not.toBe(0);
    expect(unknownResult.stderr).toContain("missing or unknown field");
    expect(duplicateResult.status).not.toBe(0);
    expect(duplicateResult.stderr).toContain(
      "duplicate object key schemaVersion",
    );
    expect(schemaResult.status).not.toBe(0);
    expect(schemaResult.stderr).toContain("schema raw SHA-256");
  });

  it("rejects published receipt and raw pinned-capture tampering", async () => {
    const published = await freshEvidence();
    published.publishedReceipts.conformance.receipt.outcome = "rejected";
    resealRecord(published.publishedReceipts.conformance);
    resealRecord(published.publishedReceipts);
    resealBundle(published);
    const publishedResult = await runValidator(published);

    const capture = await freshEvidence();
    capture.pinnedCaptures[0]!.recordsCanonicalBase64 = Buffer.from(
      "[]\n",
      "utf8",
    ).toString("base64");
    resealRecord(capture.pinnedCaptures[0]!);
    resealBundle(capture);
    const captureResult = await runValidator(capture);

    expect(publishedResult.status).not.toBe(0);
    expect(publishedResult.stderr).toMatch(/conformance|outcome/u);
    expect(captureResult.status).not.toBe(0);
    expect(captureResult.stderr).toMatch(/pinnedCaptures|canonical/u);
  });

  it("rejects reuse Session, physical inventory, and complete-history tampering", async () => {
    const session = await freshEvidence();
    session.reuse.receipt.sessionId = session.turns[0]!.sessionId;
    resealRecord(session.reuse.receipt);
    resealRecord(session.reuse);
    resealBundle(session);
    const sessionResult = await runValidator(session);

    const inventory = await freshEvidence();
    inventory.reuse.taskInventory.candidatePackages.push({
      resourceId: "candidate:unexpected",
      resourceDigest: "0".repeat(64),
    });
    resealRecord(inventory.reuse.taskInventory);
    resealRecord(inventory.reuse);
    resealBundle(inventory);
    const inventoryResult = await runValidator(inventory);

    const history = await freshEvidence();
    const runtimeRecord = history.taskInventory.records.find(
      (record) => record.recordKind === "runtime-observation-receipt",
    );
    expect(runtimeRecord).toBeDefined();
    history.taskInventory.records.push({
      ...runtimeRecord!,
      resourceId: "runtime-observation-receipt.v1.hidden",
    });
    resealRecord(history.taskInventory);
    resealBundle(history);
    const historyResult = await runValidator(history);

    expect(sessionResult.status).not.toBe(0);
    expect(sessionResult.stderr).toContain("new Session");
    expect(inventoryResult.status).not.toBe(0);
    expect(inventoryResult.stderr).toContain("candidatePackages");
    expect(historyResult.status).not.toBe(0);
    expect(historyResult.stderr).toMatch(
      /inventory|runtime history|resourceDigest/u,
    );
  });
});
