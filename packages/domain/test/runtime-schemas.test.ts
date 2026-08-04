import {
  CheckpointCertificateV1Schema,
  RuntimeStepReceiptV1Schema,
} from "../src/index.js";
import { describe, expect, it } from "vitest";

const fingerprint = {
  schemaVersion: 1,
  engine: "godot",
  engineVersion: "4.7.1-stable (official)",
  adapterVersion: "0.2.0",
  protocolVersion: 1,
  platform: "Linux",
  renderer: "gl_compatibility",
  physicsTicksPerSecond: 60,
  fixedFps: 60,
  projectHash: "a".repeat(64),
  addonHash: "b".repeat(64),
  capabilities: ["clock.process_frame"],
} as const;

describe("v0.2 runtime evidence schemas", () => {
  it("validates explicit checkpoint coverage and missing domains", () => {
    expect(
      CheckpointCertificateV1Schema.parse({
        schemaVersion: 1,
        level: "fixture_semantic_l2",
        captureConsistencyModel: "frame_end_barrier",
        adapterSemanticBarrier: "chronorift.frame_end_deferred",
        environmentFingerprint: fingerprint,
        coveredStateDomains: ["fixture.switch_state"],
        missingStateDomains: ["godot.physics_internal"],
        externalDependencies: [],
        rngDomains: [],
        pendingAsyncOperations: ["untracked_deferred_calls"],
        restoreRecipeHash: "c".repeat(64),
        restoreValidation: [],
        portability: "same_build_only",
        limitations: ["fixture only"],
      }).missingStateDomains,
    ).toContain("godot.physics_internal");
  });

  it("rejects inconsistent clock-domain receipt counts", () => {
    expect(() =>
      RuntimeStepReceiptV1Schema.parse({
        schemaVersion: 1,
        phase: "process_frame_start",
        idleFramesExecuted: 1,
        physicsTicksExecuted: 1,
        actualIdleDeltasUs: [],
        actualPhysicsDeltasUs: [],
        engineProcessFrame: 1,
        enginePhysicsFrame: 1,
        hostMonotonicStartUs: 10,
        hostMonotonicEndUs: 9,
        inputApplications: [],
        observationHealth: {
          schemaVersion: 1,
          emittedEvents: 0,
          droppedEvents: 0,
          truncatedEvents: 0,
          bufferedBytes: 0,
          backpressure: false,
          probeOverheadUs: 0,
        },
      }),
    ).toThrow();
  });
});
