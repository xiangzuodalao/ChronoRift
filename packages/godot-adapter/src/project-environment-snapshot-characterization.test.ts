import { describe, expect, it } from "vitest";

import {
  characterizeGodotProjectEnvironmentSnapshotV1,
  type GodotProjectEnvironmentSnapshotCharacterizationRuntimeV1,
} from "./project-environment-snapshot-characterization.js";

type ReadBackMode = "match" | "mismatch" | "missing";

const clock = {
  processFrame: 1,
  physicsTick: 1,
  simulationTimeUs: 16_667,
  renderFrame: null,
};

class FakeCharacterizationRuntime {
  public value = 7;
  public snapshotCount = 0;

  public constructor(private readonly readBackMode: ReadBackMode) {}

  public async snapshot(
    request: Parameters<
      GodotProjectEnvironmentSnapshotCharacterizationRuntimeV1["snapshot"]
    >[0],
  ) {
    const snapshotIndex = this.snapshotCount;
    this.snapshotCount += 1;
    const readBack = snapshotIndex === 2;
    const world =
      readBack && this.readBackMode === "missing"
        ? {
            schemaVersion: 1 as const,
            stateDomainId: "world",
            disposition: "unsupported" as const,
            schemaId: null,
            value: null,
            limitations: ["read-back omitted world"],
          }
        : {
            schemaVersion: 1 as const,
            stateDomainId: "world",
            disposition: "captured" as const,
            schemaId: "state.world",
            value: {
              counter:
                readBack && this.readBackMode === "mismatch" ? 8 : this.value,
            },
            limitations: [],
          };
    return {
      snapshotId: `snapshot:${snapshotIndex}`,
      requestedBarrier: request.requestedBarrier,
      realizedBarrier: request.requestedBarrier,
      clock,
      quantizationDelayUs: 0,
      domains: [
        world,
        {
          schemaVersion: 1 as const,
          stateDomainId: "engine.runtime",
          disposition: "uncontrolled" as const,
          schemaId: "state.engine",
          value: null,
          limitations: ["engine state is uncontrolled"],
        },
      ],
    };
  }

  public async restore(
    request: Parameters<
      GodotProjectEnvironmentSnapshotCharacterizationRuntimeV1["restore"]
    >[0],
  ) {
    this.value = 7;
    return {
      snapshotId: request.snapshotId,
      requestedBarrier: request.requestedBarrier,
      realizedBarrier: request.requestedBarrier,
      clock,
      quantizationDelayUs: 0,
      domains: [
        {
          schemaVersion: 1 as const,
          stateDomainId: "world",
          status: "written" as const,
          reportedValue: { counter: 7 },
          knownSideEffects: [],
          limitations: [],
        },
        {
          schemaVersion: 1 as const,
          stateDomainId: "engine.runtime",
          status: "uncontrolled" as const,
          reportedValue: null,
          knownSideEffects: [],
          limitations: ["engine state is uncontrolled"],
        },
      ],
    };
  }

  public async setControls(
    request: Parameters<
      GodotProjectEnvironmentSnapshotCharacterizationRuntimeV1["setControls"]
    >[0],
  ) {
    const control = request.controls[0];
    if (
      control?.controlId !== "characterization.set_counter" ||
      typeof control.parameters !== "object" ||
      control.parameters === null ||
      Array.isArray(control.parameters)
    ) {
      throw new Error("unexpected characterization control");
    }
    this.value = Number(Reflect.get(control.parameters, "counter"));
    return {
      realizedControls: [
        {
          controlId: control.controlId,
          active: true,
          realizedParameters: control.parameters,
        },
      ],
      requestedBarrier: request.requestedBarrier,
      realizedBarrier: request.requestedBarrier,
      clock,
      quantizationDelayUs: 0,
    };
  }
}

const run = async (mode: ReadBackMode) => {
  const runtime = new FakeCharacterizationRuntime(mode);
  const receipt = await characterizeGodotProjectEnvironmentSnapshotV1(runtime, {
    receiptId: `snapshot-characterization:${mode}`,
    taskId: "task:pe-a:snapshot",
    adapterRevisionId: "adapter-revision:pe-a:snapshot",
    buildId: "build:pe-a:snapshot",
    runtimeId: "runtime:pe-a:snapshot",
    executionId: "execution:pe-a:snapshot",
    mutationId: "mutation:set-counter-99",
    requestedBarrier: "process_frame_end",
    applyControlledMutation: async (client) => {
      await client.setControls({
        controls: [
          {
            controlId: "characterization.set_counter",
            parameters: { counter: 99 },
            active: true,
          },
        ],
        requestedBarrier: "process_frame_end",
      });
    },
  });
  return { receipt, runtime };
};

describe("Godot Project Environment snapshot characterization", () => {
  it("records snapshot, controlled mutation, restore, and matching read-back", async () => {
    const { receipt, runtime } = await run("match");
    const world = receipt.domains.find((domain) => domain.domainId === "world");

    expect(runtime.snapshotCount).toBe(3);
    expect(world).toMatchObject({
      disposition: "captured",
      mutationObserved: true,
      restoreStatus: "written",
      missing: false,
      mismatch: false,
    });
    expect(world?.expectedHash).toBe(world?.actualHash);
    expect(world?.mutatedHash).not.toBe(world?.expectedHash);
    expect(receipt.controlledMutationObserved).toBe(true);
    expect(receipt.firstDivergence).toBeNull();
    expect(receipt.conclusion).toBe("descriptive_only");
  });

  it("preserves the first read-back mismatch with expected and actual hashes", async () => {
    const { receipt } = await run("mismatch");
    const world = receipt.domains.find((domain) => domain.domainId === "world");

    expect(world).toMatchObject({ missing: false, mismatch: true });
    expect(world?.expectedHash).not.toBe(world?.actualHash);
    expect(receipt.firstDivergence).toMatchObject({
      domainId: "world",
      kind: "mismatch",
      observation: "post_restore_read_back",
    });
  });

  it("preserves a missing read-back without treating uncontrolled domains as missing", async () => {
    const { receipt } = await run("missing");
    const world = receipt.domains.find((domain) => domain.domainId === "world");
    const engine = receipt.domains.find(
      (domain) => domain.domainId === "engine.runtime",
    );

    expect(world).toMatchObject({
      actualHash: null,
      missing: true,
      mismatch: false,
    });
    expect(engine).toMatchObject({
      disposition: "uncontrolled",
      missing: false,
      mismatch: false,
    });
    expect(receipt.firstDivergence).toMatchObject({
      domainId: "world",
      kind: "missing",
      actualHash: null,
    });
  });
});
