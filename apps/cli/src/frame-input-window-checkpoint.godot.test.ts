import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { asBranchId, asExecutionId, asRunId } from "@chronorift/domain";
import {
  GodotGameEnvironmentFactory,
  prepareV03GodotFixture,
} from "@chronorift/godot-adapter";
import { beforeAll, describe, expect, it } from "vitest";

const cwd = resolve(import.meta.dirname, "../../..");

beforeAll(() => {
  process.env.GODOT_BIN ??= resolve(
    cwd,
    ".tools/godot/4.7.1/Godot_v4.7.1-stable_linux.x86_64",
  );
});

describe("frame-input-window checkpoint fidelity", () => {
  it("restores an open input window in a fresh Godot process", async () => {
    const artifactRoot = await mkdtemp(
      join(tmpdir(), "chronorift-frame-window-checkpoint-"),
    );
    const prepared = await prepareV03GodotFixture("frame-input-window", {
      cwd,
      artifactRoot,
    });
    const factory = new GodotGameEnvironmentFactory({
      binary: prepared.doctor.binary,
      projectDirectory: prepared.projectDirectory,
      runtimeRoot: resolve(artifactRoot, "godot-runtime"),
    });
    let executionSequence = 0;
    const createEnvironment = () =>
      factory.create({
        environment: prepared.environment,
        runId: asRunId("run:frame-window-checkpoint"),
        branchId: asBranchId("branch:frame-window-checkpoint"),
        executionId: asExecutionId(
          `execution:frame-window-checkpoint:${executionSequence++}`,
        ),
        controls: prepared.fixture.baselineControls,
        requiredCapabilities:
          prepared.environment.runtimeFingerprint?.capabilities ?? [],
        probePlan: {
          schemaVersion: 1,
          signals: [{ source: "player", name: "player.left_ledge" }],
          properties: prepared.fixture.probeProperties,
        },
      });

    const source = await createEnvironment();
    let captured: Awaited<ReturnType<typeof source.snapshot>>;
    let simTimeUs = 0;
    try {
      await source.restore({
        snapshot: prepared.initialCheckpointContent.snapshot,
        certificate: prepared.initialCheckpointContent.certificate,
        nextTick: 0,
        simTimeUs: 0,
      });
      const opened = await source.step({
        tick: 0,
        simTimeUs: 0,
        deltaUs: prepared.fixture.baselineControls.deltaUs,
        inputs: [],
      });
      expect(opened.state.values["player.window_open"]).toBe(true);
      simTimeUs = opened.receipt.realizedDeltaUs;
      captured = await source.snapshot();
    } finally {
      await source.dispose();
    }

    expect(captured.snapshot.runtimeState).toMatchObject({
      nextTick: 1,
      participants: {
        "case-02-state": {
          windowOpen: true,
        },
      },
    });

    const restored = await createEnvironment();
    try {
      await restored.restore({
        snapshot: captured.snapshot,
        certificate: captured.certificate,
        nextTick: 1,
        simTimeUs,
      });
      const jumped = await restored.step({
        tick: 1,
        simTimeUs,
        deltaUs: prepared.fixture.baselineControls.deltaUs,
        inputs: [
          {
            localId: "input:1:0",
            order: 0,
            action: "attempt_jump",
            target: "player",
            payload: {},
          },
        ],
      });
      expect(jumped.state.values["player.jumping"]).toBe(true);
    } finally {
      await restored.dispose();
    }
  });
});
