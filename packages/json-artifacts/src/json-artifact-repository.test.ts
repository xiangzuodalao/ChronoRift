import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  asBranchId,
  asCheckpointId,
  asEventId,
  asInputTraceId,
  asRunId,
  type CheckpointContent,
  type InputTrace,
  type TelemetryEvent,
} from "@chronorift/domain";
import { describe, expect, it } from "vitest";

import {
  ArtifactCorruptionError,
  JsonArtifactRepository,
} from "./json-artifact-repository.js";

const checkpointContent: CheckpointContent = {
  schemaVersion: 1,
  environment: {
    adapter: "test",
    adapterVersion: "1",
    scene: "fixture",
  },
  nextTick: 0,
  simTimeUs: 0,
  snapshot: {
    state: { values: { "/door/open": false } },
    runtimeState: {},
    rngState: { seed: "7" },
    pendingEffects: [],
  },
};

describe("JsonArtifactRepository", () => {
  it("restores content-addressed checkpoints and traces across instances", async () => {
    const root = await mkdtemp(join(tmpdir(), "chronorift-artifacts-"));
    const first = new JsonArtifactRepository(root);
    const checkpoint = await first.putCheckpoint(checkpointContent);
    const again = await first.putCheckpoint(checkpointContent);
    expect(again.checkpointId).toBe(checkpoint.checkpointId);

    const trace: InputTrace = {
      schemaVersion: 1,
      inputTraceId: asInputTraceId("trace_fixture"),
      scheduleBasis: "relative_tick",
      inputs: [],
    };
    await first.putInputTrace(trace);

    const reopened = new JsonArtifactRepository(root);
    await expect(
      reopened.getCheckpoint(checkpoint.checkpointId),
    ).resolves.toEqual(checkpoint);
    await expect(reopened.getInputTrace(trace.inputTraceId)).resolves.toEqual(
      trace,
    );
  });

  it("reads valid JSONL and ignores only an incomplete final record", async () => {
    const root = await mkdtemp(join(tmpdir(), "chronorift-artifacts-"));
    const repository = new JsonArtifactRepository(root);
    const branchId = asBranchId("branch_fixture");
    const event: TelemetryEvent = {
      schemaVersion: 1,
      eventId: asEventId("event_1"),
      runId: asRunId("run_fixture"),
      branchId,
      seq: 0,
      tick: 0,
      simTimeUs: 0,
      kind: "input",
      action: "interact",
      payload: {},
    };
    await repository.appendTelemetry(branchId, [event]);
    const path = join(
      root,
      "branches",
      encodeURIComponent(branchId),
      "events.jsonl",
    );
    await writeFile(
      path,
      `${JSON.stringify(event)}\n{\"schemaVersion\":`,
      "utf8",
    );
    await expect(repository.readTelemetry(branchId)).resolves.toEqual([event]);
  });

  it("rejects corruption before an incomplete tail", async () => {
    const root = await mkdtemp(join(tmpdir(), "chronorift-artifacts-"));
    const repository = new JsonArtifactRepository(root);
    const branchId = asBranchId("branch_corrupt");
    const path = join(
      root,
      "branches",
      encodeURIComponent(branchId),
      "events.jsonl",
    );
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, 'not-json\n{"incomplete":', "utf8");
    await expect(repository.readTelemetry(branchId)).rejects.toBeInstanceOf(
      ArtifactCorruptionError,
    );
  });

  it("does not accept a caller-provided checkpoint identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "chronorift-artifacts-"));
    const repository = new JsonArtifactRepository(root);
    const checkpoint = await repository.putCheckpoint(checkpointContent);
    expect(checkpoint.checkpointId).not.toBe(asCheckpointId("caller_value"));
  });
});
