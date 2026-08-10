import {
  VNextIndexedEntityV1Schema,
  VNextRawRuntimeEventV1Schema,
  VNextRuntimeStateQueryResultV1Schema,
  VNextRuntimeStateQueryV1Schema,
  VNextRuntimeStateRowV1Schema,
  asCheckpointId,
  type AdapterId,
  type BuildId,
  type CaptureWindowId,
  type CheckpointId,
  type ExecutionId,
  type JsonValue,
  type ProbeId,
  type RuntimeId,
  type RuntimeStateIndexId,
  type Sha256DigestV1,
  type SourceId,
  type TaskId,
  type VNextCaptureCoverageV1,
  type VNextCaptureLossV1,
  type VNextClockPositionV1,
  type VNextClockRangeV1,
  type VNextIndexedEntityV1,
  type VNextRawRuntimeEventV1,
  type VNextRuntimeStateQueryResultV1,
  type VNextRuntimeStateQueryV1,
  type VNextRuntimeStateRowV1,
} from "@chronorift/domain";

export interface VNextRuntimeStateIndexRebuildRequest {
  readonly taskId: TaskId;
  readonly indexId: RuntimeStateIndexId;
  readonly executionId: ExecutionId;
  readonly runtimeId: RuntimeId;
  readonly sourceId: SourceId;
  readonly buildId: BuildId;
  readonly adapterId: AdapterId;
  readonly probeIds: readonly ProbeId[];
  readonly captureWindowIds: readonly CaptureWindowId[];
  readonly rawRecordHash: Sha256DigestV1;
  readonly records: readonly VNextRawRuntimeEventV1[];
  readonly coverage: readonly VNextCaptureCoverageV1[];
  readonly loss: readonly VNextCaptureLossV1[];
}

const isObject = (
  value: JsonValue | undefined,
): value is { [key: string]: JsonValue } =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const indexedEntity = (
  event: VNextRawRuntimeEventV1,
): VNextIndexedEntityV1 | null => {
  const value = event.payload["entity"];
  if (!isObject(value)) return null;
  const stableId = value["stableId"];
  const incarnation = value["incarnation"];
  const sceneId = value["sceneId"];
  const parentStableId = value["parentStableId"];
  const ownerStableId = value["ownerStableId"];
  if (
    typeof stableId !== "string" ||
    stableId.length === 0 ||
    typeof incarnation !== "number" ||
    !Number.isInteger(incarnation) ||
    incarnation <= 0 ||
    typeof sceneId !== "string" ||
    sceneId.length === 0 ||
    (parentStableId !== null && typeof parentStableId !== "string") ||
    (ownerStableId !== null && typeof ownerStableId !== "string")
  ) {
    return null;
  }
  return VNextIndexedEntityV1Schema.parse({
    schemaVersion: 1,
    stableId,
    incarnation,
    sceneId,
    parentStableId,
    ownerStableId,
  });
};

const checkpointId = (event: VNextRawRuntimeEventV1): CheckpointId | null => {
  const value = event.payload["checkpointId"];
  if (typeof value !== "string" || value.length === 0) return null;
  return asCheckpointId(value);
};

const rowKind = (
  event: VNextRawRuntimeEventV1,
): VNextRuntimeStateRowV1["kind"] => {
  switch (event.kind) {
    case "input":
      return "input";
    case "state":
      return "state";
    case "entity_lifecycle":
      return "lifecycle";
    case "relation":
      return "relation";
    case "log":
      return "log";
    case "error":
    case "crash":
    case "capture_loss":
      return "error";
    case "rng":
      return "rng";
    case "clock":
      return "clock";
    case "checkpoint":
      return "checkpoint";
    case "signal":
    case "probe":
    case "restore":
    case "control":
      return "event";
  }
};

const rowValue = (event: VNextRawRuntimeEventV1): JsonValue => {
  if (event.kind === "state") {
    return event.payload["value"] ?? event.payload;
  }
  if (event.kind === "entity_lifecycle") {
    return event.payload["lifecycle"] ?? event.payload;
  }
  return event.payload;
};

const projectRow = (event: VNextRawRuntimeEventV1): VNextRuntimeStateRowV1 => {
  const entity = indexedEntity(event);
  const statePath = event.payload["statePath"];
  if (
    (event.kind === "state" || event.kind === "entity_lifecycle") &&
    entity === null
  ) {
    throw new Error(
      `${event.kind} raw record ${event.eventId} lacks a valid normalized entity identity`,
    );
  }
  if (
    event.kind === "state" &&
    (typeof statePath !== "string" || statePath.length === 0)
  ) {
    throw new Error(`state raw record ${event.eventId} lacks a statePath`);
  }
  return VNextRuntimeStateRowV1Schema.parse({
    schemaVersion: 1,
    rawEventId: event.eventId,
    rawSequence: event.sequence,
    clock: event.clock,
    kind: rowKind(event),
    entity,
    statePath:
      typeof statePath === "string" && statePath.length > 0 ? statePath : null,
    value: rowValue(event),
    observedRelations: event.observedRelations,
    checkpointId: checkpointId(event),
  });
};

const inClockRange = (
  clock: VNextClockPositionV1,
  range: VNextClockRangeV1 | null,
): boolean =>
  range === null ||
  (clock.processFrame >= range.from.processFrame &&
    clock.processFrame <= range.through.processFrame &&
    clock.physicsTick >= range.from.physicsTick &&
    clock.physicsTick <= range.through.physicsTick &&
    clock.simulationTimeUs >= range.from.simulationTimeUs &&
    clock.simulationTimeUs <= range.through.simulationTimeUs &&
    clock.hostMonotonicUs >= range.from.hostMonotonicUs &&
    clock.hostMonotonicUs <= range.through.hostMonotonicUs);

export class VNextRuntimeStateIndex {
  private constructor(
    private readonly source: VNextRuntimeStateIndexRebuildRequest,
    private readonly rows: readonly VNextRuntimeStateRowV1[],
  ) {}

  public static rebuild(
    request: VNextRuntimeStateIndexRebuildRequest,
  ): VNextRuntimeStateIndex {
    const eventIds = new Set<string>();
    const records = [...request.records].sort(
      (left, right) => left.sequence - right.sequence,
    );
    for (const recordInput of records) {
      const record = VNextRawRuntimeEventV1Schema.parse(recordInput);
      if (
        record.taskId !== request.taskId ||
        record.executionId !== request.executionId ||
        record.runtimeId !== request.runtimeId ||
        record.buildId !== request.buildId
      ) {
        throw new Error("raw record provenance does not match index identity");
      }
      if (eventIds.has(record.eventId)) {
        throw new Error(`duplicate raw event ID: ${record.eventId}`);
      }
      eventIds.add(record.eventId);
    }
    return new VNextRuntimeStateIndex(request, records.map(projectRow));
  }

  public query(
    input: VNextRuntimeStateQueryV1,
  ): VNextRuntimeStateQueryResultV1 {
    const query = VNextRuntimeStateQueryV1Schema.parse(input);
    if (
      query.taskId !== this.source.taskId ||
      query.executionId !== this.source.executionId
    ) {
      throw new Error("Runtime State Index query task/execution mismatch");
    }
    const offset = query.cursor === null ? 0 : Number(query.cursor);
    if (!Number.isInteger(offset) || offset < 0) {
      throw new Error(
        "Runtime State Index cursor must be a non-negative integer",
      );
    }

    const filtered = this.rows.filter((row) => {
      if (
        query.entityIds.length > 0 &&
        (row.entity === null || !query.entityIds.includes(row.entity.stableId))
      ) {
        return false;
      }
      if (query.eventKinds.length > 0 && !query.eventKinds.includes(row.kind)) {
        return false;
      }
      if (
        query.statePaths.length > 0 &&
        (row.statePath === null || !query.statePaths.includes(row.statePath))
      ) {
        return false;
      }
      return inClockRange(row.clock, query.clockRange);
    });
    const selected = filtered.slice(offset, offset + query.limit);
    const nextOffset = offset + selected.length;
    const nextCursor = nextOffset < filtered.length ? String(nextOffset) : null;
    const incomplete =
      nextCursor !== null ||
      this.source.loss.length > 0 ||
      this.source.coverage.some((entry) => entry.status !== "full");
    return VNextRuntimeStateQueryResultV1Schema.parse({
      schemaVersion: 1,
      taskId: this.source.taskId,
      indexId: this.source.indexId,
      executionId: this.source.executionId,
      runtimeId: this.source.runtimeId,
      sourceId: this.source.sourceId,
      buildId: this.source.buildId,
      adapterId: this.source.adapterId,
      probeIds: [...this.source.probeIds],
      captureWindowIds: [...this.source.captureWindowIds],
      rawRecordHash: this.source.rawRecordHash,
      query,
      rows: selected,
      coverage: [...this.source.coverage],
      loss: [...this.source.loss],
      incomplete,
      nextCursor,
    });
  }
}
