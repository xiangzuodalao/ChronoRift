import { z } from "zod";

import { MicrosecondsSchema, type Microseconds } from "./time.js";

export const RuntimeCapabilitySchema = z.enum([
  "observe.signal_allowlist",
  "observe.property_sampling",
  "control.input_event_action",
  "clock.process_frame",
  "clock.physics_tick",
  "launch.fixed_fps",
  "checkpoint.l0_restart",
  "checkpoint.fixture_semantic",
  "observe.entity_lifecycle",
  "observe.pending_effect",
  "observe.dynamic_property_registry",
  "control.physics_ticks_per_second",
  "control.fixture_allowlist",
]);

export type RuntimeCapability = z.infer<typeof RuntimeCapabilitySchema>;

export interface RuntimeFingerprintV1 {
  readonly schemaVersion: 1;
  readonly engine: string;
  readonly engineVersion: string;
  readonly adapterVersion: string;
  readonly protocolVersion: 1 | 2;
  readonly platform: string;
  readonly renderer: string;
  readonly physicsTicksPerSecond: number;
  readonly fixedFps: number;
  readonly projectHash: string;
  readonly addonHash: string;
  readonly capabilities: readonly RuntimeCapability[];
}

export const RuntimeFingerprintV1Schema: z.ZodType<RuntimeFingerprintV1> = z
  .object({
    schemaVersion: z.literal(1),
    engine: z.string().min(1),
    engineVersion: z.string().min(1),
    adapterVersion: z.string().min(1),
    protocolVersion: z.union([z.literal(1), z.literal(2)]),
    platform: z.string().min(1),
    renderer: z.string().min(1),
    physicsTicksPerSecond: z.number().int().positive(),
    fixedFps: z.number().int().positive(),
    projectHash: z.string().regex(/^[a-f0-9]{64}$/u),
    addonHash: z.string().regex(/^[a-f0-9]{64}$/u),
    capabilities: z.array(RuntimeCapabilitySchema),
  })
  .strict()
  .superRefine((value, context) => {
    const unique = new Set(value.capabilities);
    if (unique.size !== value.capabilities.length) {
      context.addIssue({
        code: "custom",
        message: "Runtime capabilities must be unique",
        path: ["capabilities"],
      });
    }
  });

export interface ObservationHealthV1 {
  readonly schemaVersion: 1;
  readonly emittedEvents: number;
  readonly droppedEvents: number;
  readonly truncatedEvents: number;
  readonly bufferedBytes: number;
  readonly backpressure: boolean;
  readonly probeOverheadUs: Microseconds;
}

export const ObservationHealthV1Schema: z.ZodType<ObservationHealthV1> = z
  .object({
    schemaVersion: z.literal(1),
    emittedEvents: z.number().int().nonnegative(),
    droppedEvents: z.number().int().nonnegative(),
    truncatedEvents: z.number().int().nonnegative(),
    bufferedBytes: z.number().int().nonnegative(),
    backpressure: z.boolean(),
    probeOverheadUs: MicrosecondsSchema,
  })
  .strict();

export interface RuntimeInputApplicationV1 {
  readonly order: number;
  readonly eventsInjected: 2;
  readonly pressed: true;
  readonly released: true;
}

export const RuntimeInputApplicationV1Schema: z.ZodType<RuntimeInputApplicationV1> =
  z
    .object({
      order: z.number().int().nonnegative(),
      eventsInjected: z.literal(2),
      pressed: z.literal(true),
      released: z.literal(true),
    })
    .strict();

export interface RuntimeStepReceiptV1 {
  readonly schemaVersion: 1;
  readonly phase: "process_frame_start";
  readonly idleFramesExecuted: number;
  readonly physicsTicksExecuted: number;
  readonly actualIdleDeltasUs: readonly Microseconds[];
  readonly actualPhysicsDeltasUs: readonly Microseconds[];
  readonly engineProcessFrame: number;
  readonly enginePhysicsFrame: number;
  readonly hostMonotonicStartUs: Microseconds;
  readonly hostMonotonicEndUs: Microseconds;
  readonly inputApplications: readonly RuntimeInputApplicationV1[];
  readonly observationHealth: ObservationHealthV1;
}

export const RuntimeStepReceiptV1Schema: z.ZodType<RuntimeStepReceiptV1> = z
  .object({
    schemaVersion: z.literal(1),
    phase: z.literal("process_frame_start"),
    idleFramesExecuted: z.number().int().positive(),
    physicsTicksExecuted: z.number().int().nonnegative(),
    actualIdleDeltasUs: z.array(MicrosecondsSchema),
    actualPhysicsDeltasUs: z.array(MicrosecondsSchema),
    engineProcessFrame: z.number().int().nonnegative(),
    enginePhysicsFrame: z.number().int().nonnegative(),
    hostMonotonicStartUs: MicrosecondsSchema,
    hostMonotonicEndUs: MicrosecondsSchema,
    inputApplications: z.array(RuntimeInputApplicationV1Schema),
    observationHealth: ObservationHealthV1Schema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.hostMonotonicEndUs < value.hostMonotonicStartUs) {
      context.addIssue({
        code: "custom",
        message: "Host monotonic interval is reversed",
        path: ["hostMonotonicEndUs"],
      });
    }
    if (value.actualIdleDeltasUs.length !== value.idleFramesExecuted) {
      context.addIssue({
        code: "custom",
        message: "Idle delta count must match idleFramesExecuted",
        path: ["actualIdleDeltasUs"],
      });
    }
    if (value.actualPhysicsDeltasUs.length !== value.physicsTicksExecuted) {
      context.addIssue({
        code: "custom",
        message: "Physics delta count must match physicsTicksExecuted",
        path: ["actualPhysicsDeltasUs"],
      });
    }
  });

export interface CheckpointValidationV1 {
  readonly participantId: string;
  readonly status: "pass" | "fail";
  readonly stateHash: string;
  readonly message?: string | undefined;
}

export const CheckpointValidationV1Schema: z.ZodType<CheckpointValidationV1> = z
  .object({
    participantId: z.string().min(1),
    status: z.enum(["pass", "fail"]),
    stateHash: z.string().regex(/^[a-f0-9]{64}$/u),
    message: z.string().min(1).optional(),
  })
  .strict();

export interface CheckpointCertificateV1 {
  readonly schemaVersion: 1;
  readonly level: "l0_restart" | "fixture_semantic_l2";
  readonly captureConsistencyModel: "fresh_scene" | "frame_end_barrier";
  readonly adapterSemanticBarrier: string;
  readonly environmentFingerprint: RuntimeFingerprintV1;
  readonly coveredStateDomains: readonly string[];
  readonly missingStateDomains: readonly string[];
  readonly externalDependencies: readonly string[];
  readonly rngDomains: readonly string[];
  readonly pendingAsyncOperations: readonly string[];
  readonly restoreRecipeHash: string;
  readonly restoreValidation: readonly CheckpointValidationV1[];
  readonly portability: "same_build_only";
  readonly limitations: readonly string[];
}

export const CheckpointCertificateV1Schema: z.ZodType<CheckpointCertificateV1> =
  z
    .object({
      schemaVersion: z.literal(1),
      level: z.enum(["l0_restart", "fixture_semantic_l2"]),
      captureConsistencyModel: z.enum(["fresh_scene", "frame_end_barrier"]),
      adapterSemanticBarrier: z.string().min(1),
      environmentFingerprint: RuntimeFingerprintV1Schema,
      coveredStateDomains: z.array(z.string().min(1)),
      missingStateDomains: z.array(z.string().min(1)),
      externalDependencies: z.array(z.string().min(1)),
      rngDomains: z.array(z.string().min(1)),
      pendingAsyncOperations: z.array(z.string().min(1)),
      restoreRecipeHash: z.string().regex(/^[a-f0-9]{64}$/u),
      restoreValidation: z.array(CheckpointValidationV1Schema),
      portability: z.literal("same_build_only"),
      limitations: z.array(z.string().min(1)),
    })
    .strict();

export interface RestoreValidationV1 {
  readonly schemaVersion: 1;
  readonly level: "l0_restart" | "fixture_semantic_l2";
  readonly semanticStateHash: string;
  readonly validations: readonly CheckpointValidationV1[];
}

export const RestoreValidationV1Schema: z.ZodType<RestoreValidationV1> = z
  .object({
    schemaVersion: z.literal(1),
    level: z.enum(["l0_restart", "fixture_semantic_l2"]),
    semanticStateHash: z.string().regex(/^[a-f0-9]{64}$/u),
    validations: z.array(CheckpointValidationV1Schema),
  })
  .strict();
