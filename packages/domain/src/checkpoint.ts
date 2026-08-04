import { z } from "zod";

import { CheckpointIdSchema, type CheckpointId } from "./ids.js";
import { JsonValueSchema, type JsonValue } from "./json.js";
import { StateSnapshotSchema, type StateSnapshot } from "./telemetry.js";
import {
  MicrosecondsSchema,
  TickSchema,
  type Microseconds,
  type Tick,
} from "./time.js";

export interface EnvironmentRef {
  readonly adapter: string;
  readonly adapterVersion: string;
  readonly scene: string;
  readonly build?: string | undefined;
}

export const EnvironmentRefSchema: z.ZodType<EnvironmentRef> = z
  .object({
    adapter: z.string().min(1),
    adapterVersion: z.string().min(1),
    scene: z.string().min(1),
    build: z.string().min(1).optional(),
  })
  .strict();

/** Everything the adapter needs to restore a deterministic environment. */
export interface EnvironmentSnapshot {
  readonly state: StateSnapshot;
  readonly runtimeState: JsonValue;
  readonly rngState: JsonValue;
  readonly pendingEffects: JsonValue;
}

export const EnvironmentSnapshotSchema: z.ZodType<EnvironmentSnapshot> = z
  .object({
    state: StateSnapshotSchema,
    runtimeState: JsonValueSchema,
    rngState: JsonValueSchema,
    pendingEffects: JsonValueSchema,
  })
  .strict();

export interface CheckpointContent {
  readonly schemaVersion: 1;
  readonly environment: EnvironmentRef;
  readonly nextTick: Tick;
  readonly simTimeUs: Microseconds;
  readonly snapshot: EnvironmentSnapshot;
}

export const CheckpointContentSchema: z.ZodType<CheckpointContent> = z
  .object({
    schemaVersion: z.literal(1),
    environment: EnvironmentRefSchema,
    nextTick: TickSchema,
    simTimeUs: MicrosecondsSchema,
    snapshot: EnvironmentSnapshotSchema,
  })
  .strict();

export interface Checkpoint {
  readonly checkpointId: CheckpointId;
  readonly content: CheckpointContent;
}

export const CheckpointSchema: z.ZodType<Checkpoint> = z
  .object({
    checkpointId: CheckpointIdSchema,
    content: CheckpointContentSchema,
  })
  .strict();

/** Explicitly versioned persistence envelope used by the v0.1 repository. */
export interface V01CheckpointArtifact {
  readonly schemaVersion: 1;
  readonly checkpoint: Checkpoint;
}

export const V01CheckpointArtifactSchema: z.ZodType<V01CheckpointArtifact> = z
  .object({
    schemaVersion: z.literal(1),
    checkpoint: CheckpointSchema,
  })
  .strict();
