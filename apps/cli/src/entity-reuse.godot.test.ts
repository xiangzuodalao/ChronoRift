import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  asBranchId,
  asExecutionId,
  asRunId,
  type EnvironmentSnapshot,
  type JsonValue,
} from "@chronorift/domain";
import { canonicalStringify } from "@chronorift/gamebranch";
import { beforeAll, describe, expect, it } from "vitest";

import {
  GodotGameEnvironmentFactory,
  prepareV03GodotFixture,
} from "@chronorift/godot-adapter";

import { createV03Run } from "./v03-runtime.js";

const cwd = resolve(import.meta.dirname, "../../..");

beforeAll(() => {
  process.env.GODOT_BIN ??= resolve(
    cwd,
    ".tools/godot/4.7.1/Godot_v4.7.1-stable_linux.x86_64",
  );
});

describe("entity-reuse stale pending effect", () => {
  it("reproduces across FPS, passes only when pooling is disabled, and replays", async () => {
    const artifactRoot = await mkdtemp(
      join(tmpdir(), "chronorift-entity-stale-"),
    );
    const context = await createV03Run({
      cwd,
      artifactRoot,
      fixture: "entity-reuse",
    });
    const baseline = context.baselineExecution;
    const input = baseline.events.find((event) => event.kind === "input");
    const scheduled = baseline.events.find(
      (event) =>
        event.kind === "pending_effect" && event.action === "scheduled",
    );
    const despawned = baseline.events.find(
      (event) =>
        event.kind === "entity_lifecycle" && event.action === "despawned",
    );
    const spawned = baseline.events.find(
      (event) =>
        event.kind === "entity_lifecycle" && event.action === "spawned",
    );
    const incarnationChanged = baseline.events.find(
      (event) =>
        event.kind === "property_changed" && event.path === "enemy.incarnation",
    );
    const respawned = baseline.events.find(
      (event) => event.kind === "signal" && event.name === "enemy.respawned",
    );
    const applied = baseline.events.find(
      (event) => event.kind === "pending_effect" && event.action === "applied",
    );
    const healthChanged = baseline.events.find(
      (event) =>
        event.kind === "property_changed" && event.path === "enemy.health",
    );

    expect(baseline.evaluation.status).toBe("fail");
    expect(baseline.finalState.values["enemy.health"]).toBe(90);
    expect(scheduled).toMatchObject({
      tick: 0,
      causedByEventId: input?.eventId,
      effectId: "damage:1",
      target: { stableId: "enemy", incarnation: 1 },
      dueTick: 1,
    });
    expect(despawned).toMatchObject({
      tick: 1,
      causedByEventId: scheduled?.eventId,
      entity: { stableId: "enemy", incarnation: 1 },
    });
    expect(spawned).toMatchObject({
      causedByEventId: despawned?.eventId,
      entity: { stableId: "enemy", incarnation: 2 },
    });
    expect(applied).toMatchObject({
      causedByEventId: incarnationChanged?.eventId,
      target: { stableId: "enemy", incarnation: 1 },
      resolvedTarget: { stableId: "enemy", incarnation: 2 },
    });
    expect(healthChanged).toMatchObject({
      causedByEventId: applied?.eventId,
      before: 100,
      after: 90,
    });
    expect(respawned).toMatchObject({
      causedByEventId: healthChanged?.eventId,
    });
    expect(context.evidenceCapsule.eventChain).toContainEqual(scheduled);

    const fixedFps = context.gameBranch
      .listExperiments()
      .find(
        (candidate) => candidate.intervention.kind === "set_runtime_control",
      );
    const poolingOff = context.gameBranch
      .listExperiments()
      .find(
        (candidate) => candidate.intervention.kind === "set_fixture_control",
      );
    expect(fixedFps).toBeDefined();
    expect(poolingOff).toBeDefined();
    if (fixedFps === undefined || poolingOff === undefined) return;

    const fixedResult = await context.gameBranch.runIntervention(
      baseline.executionId,
      fixedFps.interventionId,
    );
    const poolingResult = await context.gameBranch.runIntervention(
      baseline.executionId,
      poolingOff.interventionId,
    );
    const replay = await context.gameBranch.replayExecution(
      baseline.executionId,
    );

    expect(fixedResult.execution.evaluation.status).toBe("fail");
    expect(fixedResult.execution.finalState.values["enemy.health"]).toBe(90);
    expect(poolingResult.execution.evaluation.status).toBe("pass");
    expect(poolingResult.execution.finalState.values["enemy.health"]).toBe(100);
    expect(poolingResult.execution.events).toContainEqual(
      expect.objectContaining({
        kind: "pending_effect",
        action: "discarded",
        reason: "owner_destroyed",
        target: { stableId: "enemy", incarnation: 1 },
      }),
    );
    expect(replay.matches).toBe(true);
  });

  it("captures, restores, and validates an in-flight pending-effect queue", async () => {
    const artifactRoot = await mkdtemp(
      join(tmpdir(), "chronorift-entity-checkpoint-"),
    );
    const prepared = await prepareV03GodotFixture("entity-reuse", {
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
        runId: asRunId("run:entity-checkpoint"),
        branchId: asBranchId("branch:entity-checkpoint"),
        executionId: asExecutionId(
          `execution:entity-checkpoint:${executionSequence++}`,
        ),
        controls: prepared.fixture.baselineControls,
        requiredCapabilities:
          prepared.environment.runtimeFingerprint?.capabilities ?? [],
        probePlan: {
          schemaVersion: 1,
          signals: [{ source: "enemy", name: "enemy.respawned" }],
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
      const frame = await source.step({
        tick: 0,
        simTimeUs: 0,
        deltaUs: prepared.fixture.baselineControls.deltaUs,
        inputs: [
          {
            localId: "input:0:0",
            order: 0,
            action: "recycle_enemy",
            target: "enemy",
            payload: {},
          },
        ],
      });
      simTimeUs = frame.receipt.realizedDeltaUs;
      expect(frame.state.values).toMatchObject({
        "enemy.health": 100,
        "enemy.incarnation": 1,
        "enemy.effect_sequence": 1,
        "enemy.pending_effect_count": 1,
      });
      captured = await source.snapshot();
    } finally {
      await source.dispose();
    }

    expect(captured.snapshot.runtimeState).toMatchObject({
      nextTick: 1,
      participants: {
        "case-04-state": {
          effectSequence: 1,
          pendingEffects: [
            {
              effectId: "damage:1",
              target: { stableId: "enemy", incarnation: 1 },
              dueTick: 1,
            },
          ],
          lastProcessedTick: 0,
        },
      },
    });
    expect(captured.snapshot.pendingEffects).toMatchObject({
      participants: {
        "case-04-state": {
          effectSequence: 1,
          pendingEffects: [expect.objectContaining({ effectId: "damage:1" })],
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
      const frame = await restored.step({
        tick: 1,
        simTimeUs,
        deltaUs: prepared.fixture.baselineControls.deltaUs,
        inputs: [],
      });
      const pendingActions = frame.events
        .filter(
          (event) =>
            event.kind === "log" &&
            event.fields["chronoriftEvent"] === "pending_effect",
        )
        .map((event) => event.kind === "log" && event.fields["action"]);
      expect(pendingActions).toEqual(["restored", "applied"]);
      expect(frame.state.values["enemy.health"]).toBe(90);
      expect(frame.state.values["enemy.pending_effect_count"]).toBe(0);
    } finally {
      await restored.dispose();
    }

    const corruptSnapshot = structuredClone(
      captured.snapshot,
    ) as EnvironmentSnapshot;
    const runtimeState = corruptSnapshot.runtimeState as {
      participants: Record<string, Record<string, JsonValue>>;
    };
    delete runtimeState.participants["case-04-state"]?.["pendingEffects"];
    const corrupt = await createEnvironment();
    try {
      await expect(
        corrupt.restore({
          snapshot: corruptSnapshot,
          certificate: captured.certificate,
          nextTick: 1,
          simTimeUs,
        }),
      ).rejects.toThrow(/RESTORE_FAILED/u);
    } finally {
      await corrupt.dispose();
    }

    expect(captured.certificate).toBeDefined();
    if (captured.certificate === undefined) return;
    const omittedSnapshot = structuredClone(
      captured.snapshot,
    ) as EnvironmentSnapshot;
    const pendingState = omittedSnapshot.pendingEffects as {
      participants: Record<string, JsonValue>;
    };
    delete pendingState.participants["case-04-state"];
    const omittedCertificate = {
      ...captured.certificate,
      restoreRecipeHash: createHash("sha256")
        .update(canonicalStringify(omittedSnapshot as unknown as JsonValue))
        .digest("hex"),
    };
    const omitted = await createEnvironment();
    try {
      await expect(
        omitted.restore({
          snapshot: omittedSnapshot,
          certificate: omittedCertificate,
          nextTick: 1,
          simTimeUs,
        }),
      ).rejects.toThrow(/Missing pending-effect state/u);
    } finally {
      await omitted.dispose();
    }

    const duplicateSnapshot = structuredClone(
      captured.snapshot,
    ) as EnvironmentSnapshot;
    const duplicateRuntime = duplicateSnapshot.runtimeState as {
      participants: Record<string, Record<string, JsonValue>>;
    };
    const duplicateParticipant = duplicateRuntime.participants[
      "case-04-state"
    ] as { pendingEffects: JsonValue[] };
    duplicateParticipant.pendingEffects.push(
      structuredClone(duplicateParticipant.pendingEffects[0]!),
    );
    const duplicatePending = duplicateSnapshot.pendingEffects as {
      participants: Record<string, { pendingEffects: JsonValue[] }>;
    };
    duplicatePending.participants["case-04-state"]!.pendingEffects.push(
      structuredClone(
        duplicatePending.participants["case-04-state"]!.pendingEffects[0]!,
      ),
    );
    const duplicateCertificate = {
      ...captured.certificate,
      restoreRecipeHash: createHash("sha256")
        .update(canonicalStringify(duplicateSnapshot as unknown as JsonValue))
        .digest("hex"),
    };
    const duplicate = await createEnvironment();
    try {
      await expect(
        duplicate.restore({
          snapshot: duplicateSnapshot,
          certificate: duplicateCertificate,
          nextTick: 1,
          simTimeUs,
        }),
      ).rejects.toThrow(/RESTORE_FAILED/u);
    } finally {
      await duplicate.dispose();
    }
  });
});
