import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JsonValueSchema } from "@chronorift/domain";
import { canonicalJson } from "@chronorift/json-artifacts";
import { afterEach, describe, expect, it } from "vitest";

import { M7R3CasePreflightEvidenceRecordV1Schema } from "./m7-r3-case-preflight-runner.js";
import { openM7R7PreflightEvidenceStoreV1 } from "./m7-r7-preflight-evidence.js";

const roots: string[] = [];
const digestJson = (value: unknown): string =>
  createHash("sha256")
    .update(canonicalJson(JsonValueSchema.parse(value)))
    .digest("hex");

const evidence = (ordinal: 1 | 2, subject: "pristine" | "mutant") => {
  const basis = {
    schemaVersion: 1 as const,
    recordKind: "m7-r3-case-preflight-evidence" as const,
    evidenceKind: "public_observation" as const,
    ordinal,
    caseId: `case-${ordinal}`,
    subject,
    scenarioId: null,
    request: { schemaVersion: 1, subject },
    evidence: { schemaVersion: 1, cleanupProven: true },
  };
  return M7R3CasePreflightEvidenceRecordV1Schema.parse({
    ...basis,
    recordContentSha256: digestJson(basis),
  });
};

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("M7 R7 preflight evidence store", () => {
  it("persists exact private evidence once and rejects replacement", async () => {
    const root = await mkdtemp(join(tmpdir(), "m7-r7-preflight-evidence-"));
    roots.push(root);
    const caseRoot = join(root, "case-01");
    await mkdir(caseRoot, { mode: 0o700 });
    const store = await openM7R7PreflightEvidenceStoreV1({
      root: caseRoot,
      ordinal: 1,
    });
    const record = evidence(1, "pristine");
    await expect(store.persistEvidenceOnce(record)).resolves.toEqual(record);
    const path = join(caseRoot, "public-pristine.json");
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(record);
    expect((await stat(path)).mode & 0o7777).toBe(0o600);
    await expect(store.persistEvidenceOnce(record)).rejects.toThrow(
      /create-once/u,
    );
  });

  it("rejects a record from another case before writing", async () => {
    const root = await mkdtemp(join(tmpdir(), "m7-r7-preflight-evidence-"));
    roots.push(root);
    const caseRoot = join(root, "case-01");
    await mkdir(caseRoot, { mode: 0o700 });
    const store = await openM7R7PreflightEvidenceStoreV1({
      root: caseRoot,
      ordinal: 1,
    });
    await expect(
      store.persistEvidenceOnce(evidence(2, "pristine")),
    ).rejects.toThrow(/crossed/u);
  });

  it("binds each hidden-evaluator headroom receipt after public case evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "m7-r7-preflight-evidence-"));
    roots.push(root);
    const caseRoot = join(root, "case-01");
    await mkdir(caseRoot, { mode: 0o700 });
    const store = await openM7R7PreflightEvidenceStoreV1({
      root: caseRoot,
      ordinal: 1,
    });
    const observation = {
      runOrdinal: 1,
      taskStorage: {
        schemaVersion: 1 as const,
        availableBytes: 512 * 1024 * 1024,
        availableInodes: 32_768,
        requiredAvailableBytes: 256 * 1024 * 1024,
        requiredAvailableInodes: 16_384,
      },
      evaluatorStorage: {
        schemaVersion: 1 as const,
        availableBytes: 768 * 1024 * 1024,
        availableInodes: 65_536,
        requiredAvailableBytes: 256 * 1024 * 1024,
        requiredAvailableInodes: 16_384,
      },
      observedAt: "2026-08-16T08:00:00.000Z",
    } as const;
    await expect(
      store.persistEvaluatorHeadroomOnce({
        taskId: "task:m7-r4:no-agent-evaluator:case-01",
        observation,
      }),
    ).rejects.toThrow(/cannot precede/u);
    await store.persistEvidenceOnce(evidence(1, "pristine"));
    const retained = await store.persistEvaluatorHeadroomOnce({
      taskId: "task:m7-r4:no-agent-evaluator:case-01",
      observation,
    });
    expect(retained.caseId).toBe("case-1");
    expect(retained.runOrdinal).toBe(1);
    expect(
      JSON.parse(
        await readFile(
          join(caseRoot, "evaluator-headroom-000001.json"),
          "utf8",
        ),
      ),
    ).toEqual(retained);
  });
});
