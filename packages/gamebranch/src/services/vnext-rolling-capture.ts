import {
  VNextCaptureLossV1Schema,
  VNextCapturePolicyV1Schema,
  VNextCaptureProfileV1Schema,
  VNextCaptureWindowV1Schema,
  VNextRawRuntimeEventV1Schema,
  type AdapterId,
  type BuildId,
  type CaptureWindowId,
  type ExecutionId,
  type JsonObject,
  type ProbeId,
  type RuntimeId,
  type SourceId,
  type TaskId,
  type VNextCaptureChannelV1,
  type VNextCaptureCoverageV1,
  type VNextCaptureLossV1,
  type VNextCapturePolicyV1,
  type VNextCaptureProfileV1,
  type VNextCaptureWindowV1,
  type VNextClockPositionV1,
  type VNextClockRangeV1,
  type VNextObservedRelationV1,
  type VNextRawRuntimeEventV1,
} from "@chronorift/domain";

import type { VNextRuntimeEventIdPort } from "../ports/vnext-runtime.js";

export const VNEXT_DEFAULT_ROLLING_RETENTION_US = 10_000_000;
export const VNEXT_DEFAULT_ROLLING_RETENTION_TICKS = 600;
export const VNEXT_MAX_PINNED_EVENTS = 2_000;
export const VNEXT_MAX_CAPTURE_LOSS_RECORDS = 2_000;
export const VNEXT_MAX_ROLLING_RECORDS = 10_000;
export const VNEXT_MAX_ROLLING_BUFFER_BYTES = 64 * 1024 * 1024;
export const VNEXT_MAX_ROLLING_WRITTEN_BYTES = 128 * 1024 * 1024;
export const VNEXT_MAX_CAPTURE_RECORD_BYTES = 1024 * 1024;

export class VNextCaptureCapacityError extends Error {
  public readonly code = "capture_capacity_exhausted";

  public constructor(message: string) {
    super(message);
    this.name = "VNextCaptureCapacityError";
  }
}

export interface VNextRollingCaptureConfig {
  readonly taskId: TaskId;
  readonly executionId: ExecutionId;
  readonly runtimeId: RuntimeId;
  readonly sourceId: SourceId;
  readonly buildId: BuildId;
  readonly adapterId: AdapterId;
  readonly probeIds: readonly ProbeId[];
  readonly policy: VNextCapturePolicyV1;
  readonly eventIds: VNextRuntimeEventIdPort;
}

export interface VNextCaptureAppendRequest {
  readonly channel: VNextCaptureChannelV1;
  readonly kind: VNextRawRuntimeEventV1["kind"];
  readonly clock: VNextClockPositionV1;
  readonly payload: JsonObject;
  readonly observedRelations: readonly VNextObservedRelationV1[];
  readonly recordedBytes: number;
  readonly observerEffectUs: number;
  readonly mainThreadBlockUs: number;
  readonly overheadRatio: number;
}

export interface VNextPinCaptureRequest {
  readonly captureWindowId: CaptureWindowId;
  readonly requestedRange: VNextClockRangeV1;
  readonly frozenBy: VNextCaptureWindowV1["frozenBy"];
  readonly pinnedAt: string;
  readonly firstVisibleAnomalyEventId?:
    VNextRawRuntimeEventV1["eventId"] | null | undefined;
}

export interface VNextCapturePinResult {
  readonly code: "pinned" | "history_window_unavailable";
  readonly window: VNextCaptureWindowV1;
  readonly events: readonly VNextRawRuntimeEventV1[];
}

interface BufferedRecord {
  readonly event: VNextRawRuntimeEventV1;
  readonly bytes: number;
  readonly marker: boolean;
  readonly retentionTick: number;
  readonly retentionUs: number;
}

interface RecordedLoss {
  readonly loss: VNextCaptureLossV1;
  readonly recordedAt: VNextClockPositionV1;
}

interface ChannelStatistics {
  attempted: number;
  emitted: number;
  dropped: number;
  overwritten: number;
  observerEffectUs: number;
}

const priorityRank = {
  low: 0,
  normal: 1,
  high: 2,
  protected: 3,
} as const;

const utf8ByteLength = (value: string): number => {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    bytes +=
      codePoint <= 0x7f
        ? 1
        : codePoint <= 0x7ff
          ? 2
          : codePoint <= 0xffff
            ? 3
            : 4;
  }
  return bytes;
};

const withinRange = (
  position: VNextClockPositionV1,
  range: VNextClockRangeV1,
): boolean =>
  position.processFrame >= range.from.processFrame &&
  position.processFrame <= range.through.processFrame &&
  position.physicsTick >= range.from.physicsTick &&
  position.physicsTick <= range.through.physicsTick &&
  position.simulationTimeUs >= range.from.simulationTimeUs &&
  position.simulationTimeUs <= range.through.simulationTimeUs &&
  position.hostMonotonicUs >= range.from.hostMonotonicUs &&
  position.hostMonotonicUs <= range.through.hostMonotonicUs;

const startsBefore = (
  requested: VNextClockPositionV1,
  available: VNextClockPositionV1,
): boolean =>
  requested.processFrame < available.processFrame ||
  requested.physicsTick < available.physicsTick ||
  requested.simulationTimeUs < available.simulationTimeUs ||
  requested.hostMonotonicUs < available.hostMonotonicUs;

const endsAfter = (
  requested: VNextClockPositionV1,
  available: VNextClockPositionV1,
): boolean =>
  requested.processFrame > available.processFrame ||
  requested.physicsTick > available.physicsTick ||
  requested.simulationTimeUs > available.simulationTimeUs ||
  requested.hostMonotonicUs > available.hostMonotonicUs;

const boundingClockRange = (
  clocks: readonly VNextClockPositionV1[],
): VNextClockRangeV1 => {
  if (clocks.length === 0) {
    throw new Error("cannot build a clock range without observations");
  }
  const renderFrames = clocks.flatMap((clock) =>
    clock.renderFrame === null ? [] : [clock.renderFrame],
  );
  return {
    schemaVersion: 1,
    from: {
      schemaVersion: 1,
      processFrame: Math.min(...clocks.map((clock) => clock.processFrame)),
      physicsTick: Math.min(...clocks.map((clock) => clock.physicsTick)),
      simulationTimeUs: Math.min(
        ...clocks.map((clock) => clock.simulationTimeUs),
      ),
      hostMonotonicUs: Math.min(
        ...clocks.map((clock) => clock.hostMonotonicUs),
      ),
      renderFrame:
        renderFrames.length === clocks.length
          ? Math.min(...renderFrames)
          : null,
    },
    through: {
      schemaVersion: 1,
      processFrame: Math.max(...clocks.map((clock) => clock.processFrame)),
      physicsTick: Math.max(...clocks.map((clock) => clock.physicsTick)),
      simulationTimeUs: Math.max(
        ...clocks.map((clock) => clock.simulationTimeUs),
      ),
      hostMonotonicUs: Math.max(
        ...clocks.map((clock) => clock.hostMonotonicUs),
      ),
      renderFrame:
        renderFrames.length === clocks.length
          ? Math.max(...renderFrames)
          : null,
    },
  };
};

export class VNextRollingCapture {
  private readonly buffered: BufferedRecord[] = [];
  private readonly recordedLoss: RecordedLoss[] = [];
  private readonly realizedSampling = new Map<VNextCaptureChannelV1, number>();
  private readonly attempts = new Map<VNextCaptureChannelV1, number>();
  private readonly statistics = new Map<
    VNextCaptureChannelV1,
    ChannelStatistics
  >();
  private readonly degradationReasons = new Set<string>();
  private nextSequence = 0;
  private currentBytes = 0;
  private peakMemoryBytes = 0;
  private writtenBytes = 0;
  private overheadTotal = 0;
  private appendCount = 0;
  private maxMainThreadBlockUs = 0;
  private budgetExceeded = false;
  private latestClock: VNextClockPositionV1 | null = null;
  private lastObservedClock: VNextClockPositionV1 | null = null;
  private retentionTickOffset = 0;
  private retentionUsOffset = 0;
  private currentRetentionTick = 0;
  private currentRetentionUs = 0;

  public constructor(private readonly config: VNextRollingCaptureConfig) {
    VNextCapturePolicyV1Schema.parse(config.policy);
    for (const channel of config.policy.channels) {
      this.realizedSampling.set(channel.channel, channel.sampleEvery);
      this.statistics.set(channel.channel, {
        attempted: 0,
        emitted: 0,
        dropped: 0,
        overwritten: 0,
        observerEffectUs: 0,
      });
    }
  }

  public append(
    request: VNextCaptureAppendRequest,
  ): VNextRawRuntimeEventV1 | null {
    this.assertAppendRequest(request);
    if (request.recordedBytes > VNEXT_MAX_CAPTURE_RECORD_BYTES) {
      throw new VNextCaptureCapacityError(
        `capture record exceeds the ${VNEXT_MAX_CAPTURE_RECORD_BYTES}-byte Host bound`,
      );
    }
    this.advanceRetentionClock(request.clock);
    this.latestClock = request.clock;
    this.appendCount += 1;
    this.overheadTotal += request.overheadRatio;
    this.maxMainThreadBlockUs = Math.max(
      this.maxMainThreadBlockUs,
      request.mainThreadBlockUs,
    );
    const statistics = this.channelStatistics(request.channel);
    statistics.attempted += 1;
    statistics.observerEffectUs += request.observerEffectUs;

    this.prepareBudget(request);

    const attempt = (this.attempts.get(request.channel) ?? 0) + 1;
    this.attempts.set(request.channel, attempt);
    const sampleEvery = this.realizedSampling.get(request.channel) ?? 1;
    if ((attempt - 1) % sampleEvery !== 0) {
      statistics.dropped += 1;
      this.recordLoss(
        request.channel,
        "sampled",
        1,
        request.clock,
        request.clock,
        `realized sampling interval is ${sampleEvery}`,
        request.clock,
      );
      return null;
    }

    if (this.wouldExceedBudget(request) && !this.isProtected(request.channel)) {
      statistics.dropped += 1;
      this.degradationReasons.add(
        `${request.channel} record dropped to preserve capture budget`,
      );
      this.recordLoss(
        request.channel,
        "dropped",
        1,
        request.clock,
        request.clock,
        "capture budget remained exhausted after priority degradation",
        request.clock,
      );
      return null;
    }

    if (this.wouldExceedBudget(request) && this.isProtected(request.channel)) {
      this.budgetExceeded = true;
      this.degradationReasons.add(
        `protected ${request.channel} data exceeded capture budget`,
      );
    }

    this.assertRecordCapacity(request.recordedBytes);
    const event = this.materializeEvent(request);
    this.buffered.push({
      event,
      bytes: request.recordedBytes,
      marker: false,
      retentionTick: this.currentRetentionTick,
      retentionUs: this.currentRetentionUs,
    });
    this.currentBytes += request.recordedBytes;
    this.writtenBytes += request.recordedBytes;
    this.peakMemoryBytes = Math.max(this.peakMemoryBytes, this.currentBytes);
    statistics.emitted += 1;
    this.evictExpired();
    return event;
  }

  public records(): readonly VNextRawRuntimeEventV1[] {
    return this.buffered.map((record) => record.event);
  }

  public loss(): readonly VNextCaptureLossV1[] {
    return this.recordedLoss.map((entry) => entry.loss);
  }

  public profile(): VNextCaptureProfileV1 {
    const averageOverheadRatio =
      this.appendCount === 0 ? 0 : this.overheadTotal / this.appendCount;
    const budgetStatus = this.budgetExceeded
      ? "exceeded"
      : this.degradationReasons.size > 0
        ? "degraded"
        : "within_budget";
    return VNextCaptureProfileV1Schema.parse({
      schemaVersion: 1,
      requested: this.config.policy,
      realizedRetentionUs: this.config.policy.requestedRetentionUs,
      realizedRetentionTicks: this.config.policy.requestedRetentionTicks,
      peakMemoryBytes: this.peakMemoryBytes,
      writtenBytes: this.writtenBytes,
      averageOverheadRatio,
      maxMainThreadBlockUs: this.maxMainThreadBlockUs,
      budgetStatus,
      degradationReasons: [...this.degradationReasons].sort(),
      gameplayPausedForCapture: false,
    });
  }

  public pin(request: VNextPinCaptureRequest): VNextCapturePinResult {
    const data = this.buffered.filter((record) => !record.marker);
    const allSelectedData = data
      .filter((record) =>
        withinRange(record.event.clock, request.requestedRange),
      )
      .sort((left, right) => left.event.sequence - right.event.sequence);
    const omittedData = allSelectedData.slice(
      0,
      Math.max(0, allSelectedData.length - VNEXT_MAX_PINNED_EVENTS),
    );
    const selectedData = allSelectedData.slice(-VNEXT_MAX_PINNED_EVENTS);

    if (selectedData.length === 0) {
      const loss = this.normalizeWindowLoss(
        this.ensureUnavailableLoss(request.requestedRange),
      );
      const window = VNextCaptureWindowV1Schema.parse({
        schemaVersion: 1,
        taskId: this.config.taskId,
        captureWindowId: request.captureWindowId,
        executionId: this.config.executionId,
        runtimeId: this.config.runtimeId,
        sourceId: this.config.sourceId,
        buildId: this.config.buildId,
        adapterId: this.config.adapterId,
        probeIds: [...this.config.probeIds],
        status: "unavailable",
        requestedRange: request.requestedRange,
        realizedRange: null,
        captureProfile: this.profile(),
        coverage: this.unavailableCoverage(loss),
        loss,
        frozenBy: request.frozenBy,
        pinnedAt: request.pinnedAt,
        firstVisibleAnomalyEventId: request.firstVisibleAnomalyEventId ?? null,
      });
      return {
        code: "history_window_unavailable",
        window,
        events: [],
      };
    }

    const selectedClocks = selectedData.map((record) => record.event.clock);
    if (selectedClocks.length === 0) {
      throw new Error("capture selection unexpectedly lost its boundaries");
    }
    const realizedRange = boundingClockRange(selectedClocks);
    const first = realizedRange.from;
    const last = realizedRange.through;
    const missingBoundary =
      startsBefore(request.requestedRange.from, first) ||
      endsAfter(request.requestedRange.through, last);
    let relevantLoss = this.relevantLoss(
      request.requestedRange,
      missingBoundary,
    );
    if (omittedData.length > 0) {
      const omittedByChannel = new Map<
        VNextCaptureChannelV1,
        BufferedRecord[]
      >();
      for (const record of omittedData) {
        const records = omittedByChannel.get(record.event.channel) ?? [];
        records.push(record);
        omittedByChannel.set(record.event.channel, records);
      }
      for (const [channel, records] of omittedByChannel) {
        const omittedRange = boundingClockRange(
          records.map((record) => record.event.clock),
        );
        relevantLoss.push(
          VNextCaptureLossV1Schema.parse({
            schemaVersion: 1,
            sequence: relevantLoss.length,
            channel,
            kind: "unavailable",
            count: records.length,
            firstClock: omittedRange.from,
            lastClock: omittedRange.through,
            reason: `pinned event output is capped at ${VNEXT_MAX_PINNED_EVENTS} records`,
          }),
        );
      }
    }
    if (missingBoundary) {
      relevantLoss = this.ensureBoundaryLoss(
        request.requestedRange,
        relevantLoss,
      );
    }
    relevantLoss = this.normalizeWindowLoss(relevantLoss);
    const status =
      missingBoundary || relevantLoss.length > 0 ? "partial" : "available";
    const events = selectedData.map((record) => record.event);
    const window = VNextCaptureWindowV1Schema.parse({
      schemaVersion: 1,
      taskId: this.config.taskId,
      captureWindowId: request.captureWindowId,
      executionId: this.config.executionId,
      runtimeId: this.config.runtimeId,
      sourceId: this.config.sourceId,
      buildId: this.config.buildId,
      adapterId: this.config.adapterId,
      probeIds: [...this.config.probeIds],
      status,
      requestedRange: request.requestedRange,
      realizedRange,
      captureProfile: this.profile(),
      coverage: this.coverageFor(realizedRange, relevantLoss, selectedData),
      loss: relevantLoss,
      frozenBy: request.frozenBy,
      pinnedAt: request.pinnedAt,
      firstVisibleAnomalyEventId: request.firstVisibleAnomalyEventId ?? null,
    });
    return { code: "pinned", window, events };
  }

  private assertAppendRequest(request: VNextCaptureAppendRequest): void {
    if (!Number.isInteger(request.recordedBytes) || request.recordedBytes < 0) {
      throw new Error("recordedBytes must be a non-negative integer");
    }
    if (
      !Number.isInteger(request.observerEffectUs) ||
      request.observerEffectUs < 0
    ) {
      throw new Error("observerEffectUs must be a non-negative integer");
    }
    if (
      !Number.isInteger(request.mainThreadBlockUs) ||
      request.mainThreadBlockUs < 0
    ) {
      throw new Error("mainThreadBlockUs must be a non-negative integer");
    }
    if (!Number.isFinite(request.overheadRatio) || request.overheadRatio < 0) {
      throw new Error("overheadRatio must be finite and non-negative");
    }
    if (
      !this.config.policy.channels.some(
        (channel) => channel.channel === request.channel,
      )
    ) {
      throw new Error(`capture channel ${request.channel} was not requested`);
    }
  }

  private materializeEvent(
    request: VNextCaptureAppendRequest,
  ): VNextRawRuntimeEventV1 {
    const event = VNextRawRuntimeEventV1Schema.parse({
      schemaVersion: 1,
      eventId: this.config.eventIds.nextEventId(),
      taskId: this.config.taskId,
      executionId: this.config.executionId,
      runtimeId: this.config.runtimeId,
      buildId: this.config.buildId,
      sequence: this.nextSequence,
      channel: request.channel,
      kind: request.kind,
      clock: request.clock,
      payload: request.payload,
      observedRelations: [...request.observedRelations],
    });
    this.nextSequence += 1;
    return event;
  }

  private materializeLossMarker(
    loss: VNextCaptureLossV1,
    at: VNextClockPositionV1,
  ): VNextRawRuntimeEventV1 {
    const marker = VNextRawRuntimeEventV1Schema.parse({
      schemaVersion: 1,
      eventId: this.config.eventIds.nextEventId(),
      taskId: this.config.taskId,
      executionId: this.config.executionId,
      runtimeId: this.config.runtimeId,
      buildId: this.config.buildId,
      sequence: this.nextSequence,
      channel: loss.channel,
      kind: "capture_loss",
      clock: at,
      payload: {
        schemaVersion: 1,
        lossSequence: loss.sequence,
        channel: loss.channel,
        kind: loss.kind,
        count: loss.count,
        reason: loss.reason,
      },
      observedRelations: [],
    });
    this.nextSequence += 1;
    return marker;
  }

  private prepareBudget(request: VNextCaptureAppendRequest): void {
    const pressure = this.wouldExceedBudget(request);
    if (!pressure) return;

    const candidate = [...this.config.policy.channels]
      .filter((channel) => channel.priority !== "protected")
      .sort((left, right) => {
        const priority =
          priorityRank[left.priority] - priorityRank[right.priority];
        return priority !== 0
          ? priority
          : left.channel.localeCompare(right.channel);
      })[0];
    if (candidate === undefined) return;

    const currentSampling =
      this.realizedSampling.get(candidate.channel) ?? candidate.sampleEvery;
    const realizedSampling = currentSampling * 2;
    this.realizedSampling.set(candidate.channel, realizedSampling);
    const reason = `${candidate.channel} sampling degraded from ${currentSampling} to ${realizedSampling} under capture budget pressure`;
    this.degradationReasons.add(reason);
    this.recordLoss(
      candidate.channel,
      "degraded",
      0,
      request.clock,
      request.clock,
      reason,
      request.clock,
    );

    const removable = this.buffered
      .filter(
        (record) =>
          !record.marker && record.event.channel === candidate.channel,
      )
      .sort((left, right) => left.event.sequence - right.event.sequence);
    for (const record of removable) {
      if (!this.wouldExceedBudget(request)) break;
      this.removeBuffered(record);
      this.channelStatistics(candidate.channel).dropped += 1;
      this.recordLoss(
        candidate.channel,
        "dropped",
        1,
        record.event.clock,
        record.event.clock,
        "lower-priority buffered record removed under capture budget pressure",
        request.clock,
      );
    }
  }

  private wouldExceedBudget(request: VNextCaptureAppendRequest): boolean {
    const averageOverhead =
      this.appendCount === 0 ? 0 : this.overheadTotal / this.appendCount;
    return (
      this.currentBytes + request.recordedBytes >
        this.config.policy.memoryBudgetBytes ||
      this.writtenBytes + request.recordedBytes >
        this.config.policy.diskBudgetBytes ||
      averageOverhead > this.config.policy.maxAverageOverheadRatio ||
      request.mainThreadBlockUs > this.config.policy.maxMainThreadBlockUs
    );
  }

  private advanceRetentionClock(clock: VNextClockPositionV1): void {
    const tick = Math.max(clock.processFrame, clock.physicsTick);
    if (
      this.lastObservedClock !== null &&
      (clock.processFrame < this.lastObservedClock.processFrame ||
        clock.physicsTick < this.lastObservedClock.physicsTick ||
        clock.simulationTimeUs < this.lastObservedClock.simulationTimeUs)
    ) {
      this.retentionTickOffset = this.currentRetentionTick + 1 - tick;
      this.retentionUsOffset =
        this.currentRetentionUs + 1 - clock.simulationTimeUs;
    }
    this.currentRetentionTick = Math.max(
      this.currentRetentionTick,
      tick + this.retentionTickOffset,
    );
    this.currentRetentionUs = Math.max(
      this.currentRetentionUs,
      clock.simulationTimeUs + this.retentionUsOffset,
    );
    this.lastObservedClock = clock;
  }

  private evictExpired(): void {
    const expired: BufferedRecord[] = [];
    const retained: BufferedRecord[] = [];
    for (const record of this.buffered) {
      const outsideWindow =
        this.currentRetentionUs - record.retentionUs >
          this.config.policy.requestedRetentionUs ||
        this.currentRetentionTick - record.retentionTick >
          this.config.policy.requestedRetentionTicks;
      if (outsideWindow) expired.push(record);
      else retained.push(record);
    }
    if (expired.length === 0) return;
    this.buffered.splice(0, this.buffered.length, ...retained);
    this.currentBytes = retained.reduce(
      (total, record) => total + record.bytes,
      0,
    );
    const byChannel = new Map<
      VNextCaptureChannelV1,
      VNextRawRuntimeEventV1[]
    >();
    for (const record of expired) {
      if (record.marker) continue;
      const records = byChannel.get(record.event.channel) ?? [];
      records.push(record.event);
      byChannel.set(record.event.channel, records);
      this.channelStatistics(record.event.channel).overwritten += 1;
    }
    for (const [channel, records] of byChannel) {
      const first = records[0];
      const last = records.at(-1);
      if (first === undefined || last === undefined) continue;
      const overwrittenRange = boundingClockRange(
        records.map((record) => record.clock),
      );
      this.recordLoss(
        channel,
        "overwritten",
        records.length,
        overwrittenRange.from,
        overwrittenRange.through,
        "rolling history exceeded a requested time or tick boundary",
        this.latestClock ?? last.clock,
      );
    }
  }

  private removeBuffered(record: BufferedRecord): void {
    const index = this.buffered.indexOf(record);
    if (index < 0) return;
    this.buffered.splice(index, 1);
    this.currentBytes -= record.bytes;
  }

  private assertRecordCapacity(bytes: number): void {
    if (this.buffered.length >= VNEXT_MAX_ROLLING_RECORDS) {
      throw new VNextCaptureCapacityError(
        `rolling capture reached its ${VNEXT_MAX_ROLLING_RECORDS}-record Host bound`,
      );
    }
    if (this.currentBytes + bytes > VNEXT_MAX_ROLLING_BUFFER_BYTES) {
      throw new VNextCaptureCapacityError(
        `rolling capture reached its ${VNEXT_MAX_ROLLING_BUFFER_BYTES}-byte memory bound`,
      );
    }
    if (this.writtenBytes + bytes > VNEXT_MAX_ROLLING_WRITTEN_BYTES) {
      throw new VNextCaptureCapacityError(
        `rolling capture reached its ${VNEXT_MAX_ROLLING_WRITTEN_BYTES}-byte cumulative bound`,
      );
    }
  }

  private recordLoss(
    channel: VNextCaptureChannelV1,
    kind: VNextCaptureLossV1["kind"],
    count: number,
    firstClock: VNextClockPositionV1 | null,
    lastClock: VNextClockPositionV1 | null,
    reason: string,
    recordedAt: VNextClockPositionV1,
  ): VNextCaptureLossV1 {
    if (this.recordedLoss.length >= VNEXT_MAX_CAPTURE_LOSS_RECORDS) {
      throw new VNextCaptureCapacityError(
        `capture loss ledger reached its ${VNEXT_MAX_CAPTURE_LOSS_RECORDS}-record Host bound`,
      );
    }
    const loss = VNextCaptureLossV1Schema.parse({
      schemaVersion: 1,
      sequence: this.recordedLoss.length,
      channel,
      kind,
      count,
      firstClock,
      lastClock,
      reason,
    });
    const marker = this.materializeLossMarker(loss, recordedAt);
    const markerBytes = utf8ByteLength(JSON.stringify(marker));
    this.assertRecordCapacity(markerBytes);
    this.recordedLoss.push({ loss, recordedAt });
    this.buffered.push({
      event: marker,
      bytes: markerBytes,
      marker: true,
      retentionTick: this.currentRetentionTick,
      retentionUs: this.currentRetentionUs,
    });
    this.currentBytes += markerBytes;
    this.writtenBytes += markerBytes;
    this.peakMemoryBytes = Math.max(this.peakMemoryBytes, this.currentBytes);
    if (
      this.currentBytes > this.config.policy.memoryBudgetBytes ||
      this.writtenBytes > this.config.policy.diskBudgetBytes
    ) {
      this.budgetExceeded = true;
      this.degradationReasons.add(
        "protected capture-loss markers exceeded a storage budget",
      );
    }
    return loss;
  }

  private ensureUnavailableLoss(
    requestedRange: VNextClockRangeV1,
  ): readonly VNextCaptureLossV1[] {
    const losses = this.relevantLoss(requestedRange, true);
    const at = this.latestClock ?? requestedRange.through;
    for (const requested of this.config.policy.channels) {
      if (losses.some((loss) => loss.channel === requested.channel)) continue;
      losses.push(
        this.recordLoss(
          requested.channel,
          "unavailable",
          0,
          null,
          null,
          "requested history is outside the retained rolling window",
          at,
        ),
      );
    }
    return losses.sort((left, right) => left.sequence - right.sequence);
  }

  private ensureBoundaryLoss(
    requestedRange: VNextClockRangeV1,
    existing: readonly VNextCaptureLossV1[],
  ): VNextCaptureLossV1[] {
    const result = [...existing];
    const at = this.latestClock ?? requestedRange.through;
    for (const requested of this.config.policy.channels) {
      if (result.some((loss) => loss.channel === requested.channel)) continue;
      result.push(
        this.recordLoss(
          requested.channel,
          "unavailable",
          0,
          null,
          null,
          "part of the requested range is outside retained history",
          at,
        ),
      );
    }
    return result.sort((left, right) => left.sequence - right.sequence);
  }

  private relevantLoss(
    requestedRange: VNextClockRangeV1,
    includeHistoryGaps: boolean,
  ): VNextCaptureLossV1[] {
    return this.recordedLoss
      .filter(
        (entry) =>
          withinRange(entry.recordedAt, requestedRange) ||
          (includeHistoryGaps &&
            (entry.loss.kind === "overwritten" ||
              entry.loss.kind === "unavailable")),
      )
      .map((entry) => entry.loss);
  }

  private normalizeWindowLoss(
    loss: readonly VNextCaptureLossV1[],
  ): VNextCaptureLossV1[] {
    return [...loss]
      .sort((left, right) => left.sequence - right.sequence)
      .map((entry, sequence) =>
        VNextCaptureLossV1Schema.parse({ ...entry, sequence }),
      );
  }

  private unavailableCoverage(
    loss: readonly VNextCaptureLossV1[],
  ): readonly VNextCaptureCoverageV1[] {
    return this.config.policy.channels.map((requested) => ({
      schemaVersion: 1,
      channel: requested.channel,
      status: "unavailable",
      availableRange: null,
      requestedSampleEvery: requested.sampleEvery,
      realizedSampleEvery: null,
      emittedRecords: 0,
      droppedRecords: loss
        .filter(
          (entry) =>
            entry.channel === requested.channel && entry.kind === "dropped",
        )
        .reduce((total, entry) => total + entry.count, 0),
      overwrittenRecords: loss
        .filter(
          (entry) =>
            entry.channel === requested.channel && entry.kind === "overwritten",
        )
        .reduce((total, entry) => total + entry.count, 0),
      observerEffectUs: this.channelStatistics(requested.channel)
        .observerEffectUs,
      limitations: ["requested history is unavailable"],
    }));
  }

  private coverageFor(
    realizedRange: VNextClockRangeV1,
    loss: readonly VNextCaptureLossV1[],
    selected: readonly BufferedRecord[],
  ): readonly VNextCaptureCoverageV1[] {
    return this.config.policy.channels.map((requested) => {
      const channelLoss = loss.filter(
        (entry) => entry.channel === requested.channel,
      );
      const realizedSampleEvery =
        this.realizedSampling.get(requested.channel) ?? requested.sampleEvery;
      const sampledOnly = channelLoss.every(
        (entry) => entry.kind === "sampled" || entry.kind === "degraded",
      );
      const status =
        channelLoss.length === 0 &&
        realizedSampleEvery === requested.sampleEvery
          ? "full"
          : sampledOnly
            ? "sampled"
            : "partial";
      return {
        schemaVersion: 1,
        channel: requested.channel,
        status,
        availableRange: realizedRange,
        requestedSampleEvery: requested.sampleEvery,
        realizedSampleEvery,
        emittedRecords: selected.filter(
          (record) => record.event.channel === requested.channel,
        ).length,
        droppedRecords: channelLoss
          .filter((entry) => entry.kind === "dropped")
          .reduce((total, entry) => total + entry.count, 0),
        overwrittenRecords: channelLoss
          .filter((entry) => entry.kind === "overwritten")
          .reduce((total, entry) => total + entry.count, 0),
        observerEffectUs: this.channelStatistics(requested.channel)
          .observerEffectUs,
        limitations: channelLoss.map((entry) => entry.reason),
      };
    });
  }

  private channelStatistics(channel: VNextCaptureChannelV1): ChannelStatistics {
    const current = this.statistics.get(channel);
    if (current !== undefined) return current;
    const created: ChannelStatistics = {
      attempted: 0,
      emitted: 0,
      dropped: 0,
      overwritten: 0,
      observerEffectUs: 0,
    };
    this.statistics.set(channel, created);
    return created;
  }

  private isProtected(channel: VNextCaptureChannelV1): boolean {
    return (
      this.config.policy.channels.find((entry) => entry.channel === channel)
        ?.priority === "protected"
    );
  }
}
