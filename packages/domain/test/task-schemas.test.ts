import { describe, expect, it } from "vitest";

import {
  TaskIdentityV1Schema,
  TaskPatchIdentityV1Schema,
  TaskWorkspaceIdentityV1Schema,
  asExecutionId,
  asPatchId,
  asTaskId,
  taskNamespaceDigestV1,
} from "../src/index.js";

const digest = "a".repeat(64);

describe("vNext task identities", () => {
  it("parses an engine-neutral workspace identity", () => {
    expect(
      TaskWorkspaceIdentityV1Schema.parse({
        schemaVersion: 1,
        taskId: asTaskId("task_fixture"),
        sourceRevision: "97011424618ddf590e34aa29e7929087d2929c43",
        baselineSourceHash: digest,
      }),
    ).toMatchObject({ taskId: "task_fixture", baselineSourceHash: digest });
  });

  it("rejects unknown fields and a patch id that does not match patchHash", () => {
    expect(() =>
      TaskWorkspaceIdentityV1Schema.parse({
        schemaVersion: 1,
        taskId: "task_fixture",
        sourceRevision: "97011424618ddf590e34aa29e7929087d2929c43",
        baselineSourceHash: digest,
        hostPath: "/secret",
      }),
    ).toThrow();

    expect(() =>
      TaskPatchIdentityV1Schema.parse({
        schemaVersion: 1,
        patchId: asPatchId(`patch:v1:${"b".repeat(64)}`),
        taskId: asTaskId("task_fixture"),
        baselineSourceHash: digest,
        candidateSourceHash: "c".repeat(64),
        patchHash: digest,
        byteLength: 1,
      }),
    ).toThrow(/patchId/u);
  });

  it("rejects malformed hashes, timestamps, revisions, and byte lengths", () => {
    expect(() =>
      TaskIdentityV1Schema.parse({
        schemaVersion: 1,
        taskId: asTaskId("task_fixture"),
        createdAt: "yesterday",
      }),
    ).toThrow();

    expect(() =>
      TaskWorkspaceIdentityV1Schema.parse({
        schemaVersion: 1,
        taskId: asTaskId("task_fixture"),
        sourceRevision: "head",
        baselineSourceHash: "not-a-digest",
      }),
    ).toThrow();

    expect(() =>
      TaskPatchIdentityV1Schema.parse({
        schemaVersion: 1,
        patchId: asPatchId(`patch:v1:${digest}`),
        taskId: asTaskId("task_fixture"),
        baselineSourceHash: digest,
        candidateSourceHash: "c".repeat(64),
        patchHash: digest,
        byteLength: -1,
      }),
    ).toThrow();
  });

  it("accepts an execution identity without engine details", () => {
    expect(asExecutionId("execution_fixture")).toBe("execution_fixture");
  });

  it("keeps the Task namespace digest stable across storage adapters", () => {
    expect(taskNamespaceDigestV1(asTaskId("task_fixture"))).toBe(
      "4f8cf860aa63cd75a90e141b7fa65cdf855d3a27d08e2776c724b8f4004766d1",
    );
  });
});
