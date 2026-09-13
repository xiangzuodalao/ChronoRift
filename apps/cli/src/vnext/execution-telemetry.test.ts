import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import {
  ExecutionTelemetry,
  type ExecutionTiming,
} from "./execution-telemetry.js";

it("preserves failures and records no fictitious lock for Single, freezing once", async () => {
  const root = await mkdtemp(join(tmpdir(), "execution-telemetry-"));
  try {
    const telemetry = new ExecutionTelemetry();
    const failure = new Error("private input must not be persisted");
    await expect(
      telemetry.measure("read", "call1", async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    const path = join(root, "performance.v1.json");
    await telemetry.save(path);
    await telemetry.save(path);
    const bytes = await readFile(path, "utf8");
    expect(bytes).not.toContain(failure.message);
    const saved = JSON.parse(bytes) as { records: ExecutionTiming[] };
    expect(saved.records).toHaveLength(1);
    expect(saved.records[0]).toMatchObject({
      toolCallId: "call1",
      name: "read",
      lockRequestedAt: null,
      lockAcquiredAt: null,
      workspaceLockWaitMs: 0,
      outcome: "threw",
    });
    expect(saved.records[0]!.requestedAt).toBeTypeOf("string");
    expect(saved.records[0]!.finishedAt).toBeTypeOf("string");
    expect(saved.records[0]!.durationMs).toBeTypeOf("number");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
