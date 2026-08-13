import { describe, expect, it } from "vitest";

import type { GodotProjectEnvironmentObservationBatchV2 } from "@chronorift/godot-protocol";
import type { LoadedProjectAdapterPackageV2 } from "@chronorift/godot-adapter";

import { ProjectEnvironmentValidatedRingV2 } from "./project-environment-validated-ring-v2.js";

const loaded = {
  schemaVersion: 2,
  manifest: {
    smoke: { requiredDynamicTraces: [] },
    entityTypes: [
      {
        entityTypeId: "enemy",
        schemaId: "entity",
        identityStrategy: "spawn_lineage",
      },
    ],
    stateDomains: [],
    eventTypes: [],
  },
  schemas: [
    {
      schemaVersion: 2,
      dialect: "chronorift://schemas/project-adapter-payload/v2",
      schemaId: "entity",
      root: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
    },
  ],
} as unknown as LoadedProjectAdapterPackageV2;
const executionId = "execution.v2.ring";
const batch = (
  sequence: number,
  phase: "appeared" | "disappeared",
  incarnation = 1,
): GodotProjectEnvironmentObservationBatchV2 => ({
  schemaVersion: 2,
  executionId,
  batchId: `batch.v2.${sequence}`,
  firstRecordSequence: sequence,
  lastRecordSequence: sequence,
  records: [
    {
      schemaVersion: 2,
      executionId,
      recordSequence: sequence,
      clock: {
        processFrame: sequence,
        physicsTick: sequence,
        simulationTimeUs: sequence,
        renderFrame: null,
      },
      kind: "entity_lifecycle",
      payload: {
        phase,
        entity: {
          schemaVersion: 2,
          executionId,
          entityId: "enemy",
          incarnation,
        },
        entityTypeId: "enemy",
        identityScope: "spawn_lineage",
        projection: phase === "disappeared" ? null : {},
      },
    },
  ],
  coverage: {
    status: "complete",
    firstAvailableRecordSequence: 0,
    lastAvailableRecordSequence: sequence,
    droppedRecordCount: 0,
    overwriteCount: 0,
    semanticCoverage: "declared",
  },
});

describe("ProjectEnvironmentValidatedRingV2", () => {
  it("ACKs only validated records and serves its local query view", async () => {
    const batches = [batch(0, "appeared"), batch(1, "disappeared")];
    const acknowledged: number[] = [];
    const ring = new ProjectEnvironmentValidatedRingV2(loaded, executionId);
    ring.start({
      nextObservationBatch: async () =>
        batches.shift() ??
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error("poll timeout")), 10);
        }),
      acknowledgeObservationBatch: async (value) => {
        acknowledged.push(value.lastRecordSequence);
      },
    });
    await ring.waitFor((records) => records.length === 2, 1_000);
    expect(acknowledged).toEqual([0, 1]);
    expect(ring.query("entities", 10)).toHaveLength(2);
    await ring.stop();
    expect(ring.poisoned).toBe(false);
  });

  it("drains an outstanding bounded poll before shutdown without poisoning", async () => {
    let releasePoll: (() => void) | undefined;
    const ring = new ProjectEnvironmentValidatedRingV2(loaded, executionId);
    ring.start({
      nextObservationBatch: () =>
        new Promise<never>((_resolve, reject) => {
          releasePoll = () => reject(new Error("poll timeout"));
        }),
      acknowledgeObservationBatch: async () => undefined,
    });
    while (releasePoll === undefined) await Promise.resolve();
    const stopping = ring.stop();
    let stopped = false;
    void stopping.then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    releasePoll();
    await stopping;
    expect(ring.poisoned).toBe(false);
  });

  it("poisons on a later duplicate and never ACKs it", async () => {
    const batches = [batch(0, "appeared"), batch(1, "appeared")];
    const acknowledged: number[] = [];
    const ring = new ProjectEnvironmentValidatedRingV2(loaded, executionId);
    ring.start({
      nextObservationBatch: async () =>
        batches.shift() ?? new Promise<never>(() => undefined),
      acknowledgeObservationBatch: async (value) => {
        acknowledged.push(value.lastRecordSequence);
      },
    });
    await expect(
      ring.waitFor((records) => records.length === 2, 1_000),
    ).rejects.toThrow(/duplicate/u);
    expect(ring.poisoned).toBe(true);
    expect(acknowledged).toEqual([0]);
  });

  it("poisons on declared loss before ACK", async () => {
    const lossy = {
      ...batch(0, "appeared"),
      coverage: {
        ...batch(0, "appeared").coverage,
        status: "partial" as const,
        droppedRecordCount: 1,
      },
    };
    let ack = false;
    const ring = new ProjectEnvironmentValidatedRingV2(loaded, executionId);
    ring.start({
      nextObservationBatch: async () => lossy,
      acknowledgeObservationBatch: async () => {
        ack = true;
      },
    });
    await expect(
      ring.waitFor((records) => records.length > 0, 1_000),
    ).rejects.toThrow(/coverage/u);
    expect(ack).toBe(false);
  });

  it.each([
    [
      "sequence gap",
      {
        ...batch(0, "appeared"),
        records: [
          {
            ...batch(0, "appeared").records[0]!,
            recordSequence: 1,
          },
        ],
      },
    ],
    [
      "cross Execution record",
      {
        ...batch(0, "appeared"),
        records: [
          {
            ...batch(0, "appeared").records[0]!,
            executionId: "execution.v2.foreign",
          },
        ],
      },
    ],
  ])("poisons and withholds ACK for %s", async (_label, invalid) => {
    let ack = false;
    const ring = new ProjectEnvironmentValidatedRingV2(loaded, executionId);
    ring.start({
      nextObservationBatch: async () => invalid,
      acknowledgeObservationBatch: async () => {
        ack = true;
      },
    });
    await expect(
      ring.waitFor((records) => records.length > 0, 1_000),
    ).rejects.toThrow();
    expect(ring.poisoned).toBe(true);
    expect(ack).toBe(false);
  });

  it("poisons before overwriting its bounded validated history", async () => {
    const ring = new ProjectEnvironmentValidatedRingV2(
      loaded,
      executionId,
      128,
    );
    let sequence = 0;
    ring.start({
      nextObservationBatch: async () => {
        const value = batch(
          sequence,
          sequence % 2 === 0 ? "appeared" : "disappeared",
          Math.floor(sequence / 2) + 1,
        );
        sequence += 1;
        return value;
      },
      acknowledgeObservationBatch: async () => undefined,
    });
    await expect(
      ring.waitFor((records) => records.length > 128, 2_000),
    ).rejects.toThrow(/overwrite/u);
    expect(ring.poisoned).toBe(true);
  });
});
