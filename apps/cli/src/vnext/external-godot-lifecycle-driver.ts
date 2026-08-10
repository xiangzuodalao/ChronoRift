import { createHash } from "node:crypto";

import type { LifecycleRuntimeFactsV2 } from "@chronorift/agent-protocol";
import {
  VNextBoundedStreamReceiptV1Schema,
  VNextCaptureCoverageV1Schema,
  VNextCaptureLossV1Schema,
  VNextLifecycleCleanupReceiptV1Schema,
  VNextLifecycleObservationV1Schema,
  VNextLifecyclePhaseReceiptV1Schema,
  asSha256DigestV1,
  lifecycleCleanupProven,
  type VNextBoundedStreamReceiptV1,
  type VNextCaptureCoverageV1,
  type VNextCaptureLossV1,
  type VNextClockPositionV1,
  type VNextLifecycleCleanupReceiptV1,
  type VNextLifecycleObservationV1,
  type VNextLifecyclePhaseReceiptV1,
} from "@chronorift/domain";
import {
  connectGodotLifecycleRuntime,
  type GodotLifecycleRuntimeClient,
  type GodotLifecycleStatusReceiptV1,
} from "@chronorift/godot-adapter";
import {
  GodotLifecycleSidecarLaunchV1Schema,
  GodotLifecycleVanillaSmokeLaunchV1Schema,
  type GodotLifecycleProcessReceiptV1,
  type GodotLifecycleSidecarDiagnosticV1,
  type GodotLifecycleStatusSampleV1,
  type GodotLifecycleStreamReceiptV1,
  type GodotLifecycleVanillaSmokeDiagnosticV1,
} from "@chronorift/godot-protocol";
import { z } from "zod";

import type {
  ExternalGodotLifecycleDriverSnapshotV1,
  ExternalGodotLifecycleDriverStopV1,
  ExternalGodotLifecycleDriverV1,
  ExternalGodotLifecycleSessionV1,
} from "./external-godot-lifecycle-coordinator.js";
import type {
  GodotLifecycleSidecarPortV1,
  LifecycleDiagnosticFactsV1,
} from "./godot-lifecycle-sidecar-port.js";
import type { ManagedGodotLifecycleRuntimeCapabilityV1 } from "./managed-godot-lifecycle-runtime.js";
import type { SandboxExecutionResultV1 } from "./sandbox-broker.js";

const EMPTY_SHA256 = asSha256DigestV1(
  createHash("sha256").update(Buffer.alloc(0)).digest("hex"),
);

const DEFAULT_DIAGNOSTIC_LIMITS = Object.freeze({
  diagnosticFrameMaxBytes: 64 * 1024,
  diagnosticTotalMaxBytes: 1024 * 1024,
  diagnosticMaxCount: 128,
  outputCaptureMaxBytes: 256 * 1024,
} as const);

const LaunchResourceIdSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u)
  .refine((value) => !value.includes(".."));

export const ExternalGodotLifecycleDiagnosticChunkV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    phase: z.enum(["import", "vanilla", "managed"]),
    stream: z.enum(["stdout", "stderr"]),
    offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    byteLength: z
      .number()
      .int()
      .positive()
      .max(64 * 1024),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    bytesBase64: z
      .string()
      .min(1)
      .max(2 * 1024 * 1024),
  })
  .strict()
  .superRefine((value, context) => {
    const bytes = Buffer.from(value.bytesBase64, "base64");
    if (bytes.toString("base64") !== value.bytesBase64) {
      context.addIssue({
        code: "custom",
        path: ["bytesBase64"],
        message: "diagnostic chunk must use canonical base64",
      });
      return;
    }
    if (bytes.byteLength !== value.byteLength) {
      context.addIssue({
        code: "custom",
        path: ["byteLength"],
        message: "diagnostic chunk byte length does not match its bytes",
      });
    }
    if (createHash("sha256").update(bytes).digest("hex") !== value.sha256) {
      context.addIssue({
        code: "custom",
        path: ["sha256"],
        message: "diagnostic chunk digest does not match its bytes",
      });
    }
  });

export type ExternalGodotLifecycleDiagnosticChunkV1 = Readonly<
  z.infer<typeof ExternalGodotLifecycleDiagnosticChunkV1Schema>
>;

export const ExternalGodotLifecycleLaunchFailureReceiptV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    stage: z.enum([
      "vanilla_import",
      "vanilla_smoke",
      "managed_open",
      "managed_handshake",
    ]),
    taskId: LaunchResourceIdSchema,
    buildId: LaunchResourceIdSchema,
    runtimeId: LaunchResourceIdSchema,
    executionId: LaunchResourceIdSchema,
    message: z
      .string()
      .min(1)
      .max(4_096)
      .refine(
        (value) =>
          !value.includes("\0") &&
          !value.includes("\r") &&
          !value.includes("\n"),
      ),
    phases: z.array(VNextLifecyclePhaseReceiptV1Schema).max(8),
    diagnostics: z
      .array(ExternalGodotLifecycleDiagnosticChunkV1Schema)
      .max(256),
    coverage: z.array(VNextCaptureCoverageV1Schema).max(16),
    loss: z.array(VNextCaptureLossV1Schema).max(64),
    cleanup: VNextLifecycleCleanupReceiptV1Schema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    for (const [index, phase] of value.phases.entries()) {
      if (phase.sequence !== index) {
        context.addIssue({
          code: "custom",
          path: ["phases", index, "sequence"],
          message: "launch-failure phase sequences must be contiguous",
        });
      }
    }
    const offsets = new Map<string, number>();
    let diagnosticBytes = 0;
    for (const [index, chunk] of value.diagnostics.entries()) {
      diagnosticBytes += chunk.byteLength;
      const key = `${chunk.phase}\0${chunk.stream}`;
      const expected = offsets.get(key) ?? 0;
      if (chunk.offset !== expected) {
        context.addIssue({
          code: "custom",
          path: ["diagnostics", index, "offset"],
          message:
            "launch-failure diagnostic chunk offsets must be contiguous per phase and stream",
        });
      }
      offsets.set(key, chunk.offset + chunk.byteLength);
    }
    if (diagnosticBytes > 2 * 1024 * 1024) {
      context.addIssue({
        code: "custom",
        path: ["diagnostics"],
        message:
          "combined vanilla and managed diagnostic chunks exceed the aggregate byte bound",
      });
    }
  });

export type ExternalGodotLifecycleLaunchFailureReceiptV1 = Readonly<
  Omit<
    z.infer<typeof ExternalGodotLifecycleLaunchFailureReceiptV1Schema>,
    "phases" | "diagnostics" | "coverage" | "loss"
  > & {
    readonly phases: readonly VNextLifecyclePhaseReceiptV1[];
    readonly diagnostics: readonly ExternalGodotLifecycleDiagnosticChunkV1[];
    readonly coverage: readonly VNextCaptureCoverageV1[];
    readonly loss: readonly VNextCaptureLossV1[];
  }
>;

export class ExternalGodotLifecycleLaunchFailureV1 extends Error {
  public override readonly name = "ExternalGodotLifecycleLaunchFailureV1";
  public readonly receipt: ExternalGodotLifecycleLaunchFailureReceiptV1;

  public constructor(
    receipt: ExternalGodotLifecycleLaunchFailureReceiptV1,
    options?: ErrorOptions,
  ) {
    const parsed =
      ExternalGodotLifecycleLaunchFailureReceiptV1Schema.parse(receipt);
    super(parsed.message, options);
    this.receipt = Object.freeze({
      ...parsed,
      phases: Object.freeze([...parsed.phases]),
      diagnostics: Object.freeze([...parsed.diagnostics]),
      coverage: Object.freeze([...parsed.coverage]),
      loss: Object.freeze([...parsed.loss]),
    });
  }
}

const nowMonotonicUs = (): number => Math.floor(performance.now() * 1_000);

interface StreamView {
  readonly totalBytes: number;
  readonly totalSha256: string;
  readonly retainedBytes: number;
  readonly retainedSha256: string;
  readonly truncated: boolean;
  readonly droppedBytes: number;
  readonly final: boolean;
}

interface DiagnosticViews {
  readonly stdout: StreamView;
  readonly stderr: StreamView;
}

const emptyStreamView = (final: boolean): StreamView => ({
  totalBytes: 0,
  totalSha256: EMPTY_SHA256,
  retainedBytes: 0,
  retainedSha256: EMPTY_SHA256,
  truncated: false,
  droppedBytes: 0,
  final,
});

const decodedOutput = (
  records: readonly {
    readonly kind: string;
    readonly phase?: string | undefined;
    readonly stream?: string | undefined;
    readonly offset?: number | undefined;
    readonly bytesBase64?: string | undefined;
  }[],
  phase: "import" | "vanilla" | "managed",
  stream: "stdout" | "stderr",
): Buffer => {
  const chunks: Buffer[] = [];
  let expectedOffset = 0;
  for (const record of records) {
    if (
      record.kind !== "process_output" ||
      record.phase !== phase ||
      record.stream !== stream ||
      record.offset === undefined ||
      record.bytesBase64 === undefined
    ) {
      continue;
    }
    if (record.offset !== expectedOffset) {
      throw new Error(
        `lifecycle ${phase} ${stream} diagnostics have a non-contiguous retained offset`,
      );
    }
    const chunk = Buffer.from(record.bytesBase64, "base64");
    if (chunk.toString("base64") !== record.bytesBase64) {
      throw new Error(
        `lifecycle ${phase} ${stream} diagnostic is not canonical base64`,
      );
    }
    chunks.push(chunk);
    expectedOffset += chunk.byteLength;
  }
  return Buffer.concat(chunks);
};

const diagnosticChunks = (
  records: readonly {
    readonly kind: string;
    readonly phase?: string | undefined;
    readonly stream?: string | undefined;
    readonly offset?: number | undefined;
    readonly bytesBase64?: string | undefined;
  }[],
): readonly ExternalGodotLifecycleDiagnosticChunkV1[] =>
  records.flatMap((record) => {
    if (
      record.kind !== "process_output" ||
      (record.phase !== "import" &&
        record.phase !== "vanilla" &&
        record.phase !== "managed") ||
      (record.stream !== "stdout" && record.stream !== "stderr") ||
      record.offset === undefined ||
      record.bytesBase64 === undefined
    ) {
      return [];
    }
    const bytes = Buffer.from(record.bytesBase64, "base64");
    return [
      ExternalGodotLifecycleDiagnosticChunkV1Schema.parse({
        schemaVersion: 1,
        phase: record.phase,
        stream: record.stream,
        offset: record.offset,
        byteLength: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bytesBase64: record.bytesBase64,
      }),
    ];
  });

const streamView = (
  summary: GodotLifecycleStreamReceiptV1 | undefined,
  retained: Buffer,
): StreamView => {
  const retainedSha256 = createHash("sha256").update(retained).digest("hex");
  if (summary === undefined) {
    return {
      totalBytes: retained.byteLength,
      totalSha256: retainedSha256,
      retainedBytes: retained.byteLength,
      retainedSha256,
      truncated: false,
      droppedBytes: 0,
      final: false,
    };
  }
  if (summary.retainedBytes !== retained.byteLength) {
    throw new Error("lifecycle stream summary does not match retained bytes");
  }
  if (!summary.truncated && summary.sha256 !== retainedSha256) {
    throw new Error(
      "fully retained lifecycle stream summary does not match retained bytes",
    );
  }
  return {
    totalBytes: summary.totalBytes,
    totalSha256: summary.sha256,
    retainedBytes: summary.retainedBytes,
    retainedSha256,
    truncated: summary.truncated,
    droppedBytes: summary.totalBytes - summary.retainedBytes,
    final: true,
  };
};

const boundedStream = (view: StreamView): VNextBoundedStreamReceiptV1 =>
  VNextBoundedStreamReceiptV1Schema.parse({
    schemaVersion: 1,
    totalBytes: view.totalBytes,
    totalSha256: view.totalSha256,
    retainedBytes: view.retainedBytes,
    retainedSha256: view.retainedSha256,
    truncated: view.truncated,
    droppedBytes: view.droppedBytes,
  });

const viewsForVanillaPhase = (
  records: readonly GodotLifecycleVanillaSmokeDiagnosticV1[],
  phase: "import" | "vanilla",
  receipt: GodotLifecycleProcessReceiptV1,
): DiagnosticViews => ({
  stdout: streamView(receipt.stdout, decodedOutput(records, phase, "stdout")),
  stderr: streamView(receipt.stderr, decodedOutput(records, phase, "stderr")),
});

const viewsForManaged = (
  records: readonly GodotLifecycleSidecarDiagnosticV1[],
): DiagnosticViews => {
  const stdoutSummary = records.find(
    (record) => record.kind === "stream_summary" && record.stream === "stdout",
  );
  const stderrSummary = records.find(
    (record) => record.kind === "stream_summary" && record.stream === "stderr",
  );
  return {
    stdout: streamView(
      stdoutSummary?.kind === "stream_summary"
        ? stdoutSummary.receipt
        : undefined,
      decodedOutput(records, "managed", "stdout"),
    ),
    stderr: streamView(
      stderrSummary?.kind === "stream_summary"
        ? stderrSummary.receipt
        : undefined,
      decodedOutput(records, "managed", "stderr"),
    ),
  };
};

const sourceVerificationsMatch = (
  records: readonly {
    readonly kind: string;
    readonly phase?: string | undefined;
    readonly candidateSourceHash?: string | undefined;
    readonly fileCount?: number | undefined;
    readonly byteLength?: number | undefined;
  }[],
  phases: readonly ("import" | "vanilla" | "managed")[],
  expected: {
    readonly candidateSourceHash: string;
    readonly fileCount: number;
    readonly byteLength: number;
  },
): boolean => {
  const verifications = records.filter(
    (record) => record.kind === "source_verified",
  );
  return (
    verifications.length === phases.length &&
    phases.every(
      (phase) =>
        verifications.filter(
          (record) =>
            record.phase === phase &&
            record.candidateSourceHash === expected.candidateSourceHash &&
            record.fileCount === expected.fileCount &&
            record.byteLength === expected.byteLength,
        ).length === 1,
    )
  );
};

const terminalDiagnosticsFailed = (
  facts: LifecycleDiagnosticFactsV1<GodotLifecycleSidecarDiagnosticV1>,
  expectedSource: {
    readonly candidateSourceHash: string;
    readonly fileCount: number;
    readonly byteLength: number;
  },
): boolean => {
  const exits = facts.records.filter((record) => record.kind === "godot_exit");
  const stdoutSummaries = facts.records.filter(
    (record) => record.kind === "stream_summary" && record.stream === "stdout",
  );
  const stderrSummaries = facts.records.filter(
    (record) => record.kind === "stream_summary" && record.stream === "stderr",
  );
  const exit = exits[0];
  return (
    facts.status !== "complete" ||
    facts.failure !== null ||
    facts.records.some((record) => record.kind === "sidecar_error") ||
    exits.length !== 1 ||
    stdoutSummaries.length !== 1 ||
    stderrSummaries.length !== 1 ||
    !sourceVerificationsMatch(facts.records, ["managed"], expectedSource) ||
    exit?.kind !== "godot_exit" ||
    exit.timedOut ||
    exit.exitCode !== 0 ||
    exit.signal !== null
  );
};

const aggregateView = (left: StreamView, right: StreamView): StreamView => {
  // A concatenated digest cannot be recovered from two final digests. Hashes
  // here identify the deterministic pair of source receipts, while byte
  // counts preserve the actual aggregate coverage.
  const totalSha256 = createHash("sha256")
    .update(left.totalSha256)
    .update("\0")
    .update(right.totalSha256)
    .digest("hex");
  const retainedSha256 = createHash("sha256")
    .update(left.retainedSha256)
    .update("\0")
    .update(right.retainedSha256)
    .digest("hex");
  return {
    totalBytes: left.totalBytes + right.totalBytes,
    totalSha256,
    retainedBytes: left.retainedBytes + right.retainedBytes,
    retainedSha256,
    truncated: left.truncated || right.truncated,
    droppedBytes: left.droppedBytes + right.droppedBytes,
    final: left.final && right.final,
  };
};

const cleanupFromSandbox = (
  result: Extract<SandboxExecutionResultV1, { readonly kind: "executed" }>,
): VNextLifecycleCleanupReceiptV1 => {
  const cleanup = result.receipt.cleanup;
  const storageReconciled =
    result.receipt.realizedMechanisms.aggregateStorage !== undefined &&
    result.receipt.resourceUsage.aggregateStorage !== undefined;
  return VNextLifecycleCleanupReceiptV1Schema.parse({
    schemaVersion: 1,
    processGroupTerminated: cleanup.processGroupTerminated,
    godotExited: cleanup.processGroupTerminated,
    sidecarExited: cleanup.processGroupTerminated,
    cgroupEmpty: !cleanup.cgroupPopulated,
    scopeRemoved: cleanup.scopeRemoved,
    // The broker publishes scopeRemoved only after its operation scratch has
    // also been removed; an unremoved scratch keeps this false.
    scratchRemoved: cleanup.scopeRemoved,
    storageReconciled,
  });
};

const viewsFromSandbox = (
  result: Extract<SandboxExecutionResultV1, { readonly kind: "executed" }>,
): DiagnosticViews => {
  const convert = (stream: typeof result.receipt.stdout): StreamView => ({
    totalBytes: stream.totalBytes,
    totalSha256: stream.sha256,
    retainedBytes: stream.capturedBytes,
    retainedSha256: stream.capturedSha256,
    truncated: stream.truncated,
    droppedBytes: stream.totalBytes - stream.capturedBytes,
    final: true,
  });
  return {
    stdout: convert(result.receipt.stdout),
    stderr: convert(result.receipt.stderr),
  };
};

const failureOutcome = (
  timedOut: boolean,
): VNextLifecyclePhaseReceiptV1["outcome"] =>
  timedOut ? "timed_out" : "failed";

const boundedFailureMessage = (error: unknown, fallback: string): string => {
  const raw = error instanceof Error ? error.message : fallback;
  return (
    raw
      .replace(/[\0\r\n]/gu, " ")
      .slice(0, 4_096)
      .trim() || fallback
  );
};

const failureCoverageAndLoss = (
  phases: readonly VNextLifecyclePhaseReceiptV1[],
  diagnostics: readonly ExternalGodotLifecycleDiagnosticChunkV1[],
): {
  readonly coverage: readonly VNextCaptureCoverageV1[];
  readonly loss: readonly VNextCaptureLossV1[];
} => {
  const first = phases[0];
  const last = phases.at(-1);
  const hostRange =
    first === undefined || last === undefined
      ? null
      : {
          schemaVersion: 1 as const,
          from: {
            schemaVersion: 1 as const,
            processFrame: 0,
            physicsTick: 0,
            simulationTimeUs: 0,
            hostMonotonicUs: first.hostMonotonicStartUs,
            renderFrame: null,
          },
          through: {
            schemaVersion: 1 as const,
            processFrame: 0,
            physicsTick: 0,
            simulationTimeUs: 0,
            hostMonotonicUs: last.hostMonotonicEndUs,
            renderFrame: null,
          },
        };
  const coverage: VNextCaptureCoverageV1[] = [];
  const loss: VNextCaptureLossV1[] = [];
  for (const channel of ["clock", "probe"] as const) {
    coverage.push(
      VNextCaptureCoverageV1Schema.parse({
        schemaVersion: 1,
        channel,
        status: "unavailable",
        availableRange: null,
        requestedSampleEvery: 1,
        realizedSampleEvery: null,
        emittedRecords: 0,
        droppedRecords: 0,
        overwrittenRecords: 0,
        observerEffectUs: 0,
        limitations: [
          "launch failed before an admitted readiness and status sample was available",
          "candidate source identity is revalidated at lifecycle endpoints, not continuously across the observation window",
        ],
      }),
    );
    loss.push(
      VNextCaptureLossV1Schema.parse({
        schemaVersion: 1,
        sequence: loss.length,
        channel,
        kind: "unavailable",
        count: 0,
        firstClock: null,
        lastClock: null,
        reason:
          "launch failed before the lifecycle probe negotiated endpoint sampling",
      }),
    );
  }
  const physicalOperationObserved = phases.some(
    (phase) => phase.operationState === "started",
  );
  const physicalOperationUnknown = phases.some(
    (phase) => phase.operationState === "unknown",
  );
  for (const [channel, streamName] of [
    ["log", "stdout"],
    ["error", "stderr"],
  ] as const) {
    const streams = phases.map((phase) => phase[streamName]);
    const droppedBytes = streams.reduce(
      (total, stream) => total + stream.droppedBytes,
      0,
    );
    const retainedBytes = streams.reduce(
      (total, stream) => total + stream.retainedBytes,
      0,
    );
    const streamChunks = diagnostics.filter(
      (chunk) => chunk.stream === streamName,
    );
    const persistedBytes = streamChunks.reduce(
      (total, chunk) => total + chunk.byteLength,
      0,
    );
    if (!physicalOperationObserved || hostRange === null) {
      coverage.push(
        VNextCaptureCoverageV1Schema.parse({
          schemaVersion: 1,
          channel,
          status: "unavailable",
          availableRange: null,
          requestedSampleEvery: 1,
          realizedSampleEvery: null,
          emittedRecords: 0,
          droppedRecords: 0,
          overwrittenRecords: 0,
          observerEffectUs: 0,
          limitations: [
            physicalOperationUnknown
              ? "sidecar failure left physical process output availability unknown"
              : "physical process execution was not started",
          ],
        }),
      );
      loss.push(
        VNextCaptureLossV1Schema.parse({
          schemaVersion: 1,
          sequence: loss.length,
          channel,
          kind: "unavailable",
          count: 0,
          firstClock: null,
          lastClock: null,
          reason: physicalOperationUnknown
            ? "sidecar failure left stream capture completion unknown"
            : "no process stream existed before sandbox policy denial",
        }),
      );
      continue;
    }
    coverage.push(
      VNextCaptureCoverageV1Schema.parse({
        schemaVersion: 1,
        channel,
        status: "partial",
        availableRange: hostRange,
        requestedSampleEvery: 1,
        realizedSampleEvery: 1,
        emittedRecords: streamChunks.length,
        droppedRecords: streams.filter((stream) => stream.truncated).length,
        overwrittenRecords: 0,
        observerEffectUs: 0,
        limitations: [
          "retained stream bytes are persisted as chunks with phase offsets but without per-chunk runtime clocks",
          "candidate source identity is revalidated at lifecycle endpoints, not continuously across the observation window",
        ],
      }),
    );
    const retainedMismatch = persistedBytes !== retainedBytes;
    const coverageIndex = coverage.length - 1;
    coverage[coverageIndex] = VNextCaptureCoverageV1Schema.parse({
      ...coverage[coverageIndex],
      status:
        droppedBytes > 0 || retainedMismatch || physicalOperationUnknown
          ? "partial"
          : "full",
    });
    if (droppedBytes > 0 || retainedMismatch || physicalOperationUnknown) {
      loss.push(
        VNextCaptureLossV1Schema.parse({
          schemaVersion: 1,
          sequence: loss.length,
          channel,
          kind: droppedBytes > 0 ? "dropped" : "unavailable",
          count:
            droppedBytes > 0
              ? droppedBytes
              : Math.abs(retainedBytes - persistedBytes),
          firstClock: hostRange.from,
          lastClock: hostRange.through,
          reason:
            droppedBytes > 0
              ? "sidecar output retention byte bound was reached"
              : physicalOperationUnknown
                ? "managed process output completion is unknown after the sidecar port failed"
                : "retained stream summaries did not match persisted diagnostic chunks",
        }),
      );
    }
  }
  return { coverage, loss };
};

const launchFailure = (input: {
  readonly request: Parameters<ExternalGodotLifecycleDriverV1["launch"]>[0];
  readonly stage: ExternalGodotLifecycleLaunchFailureReceiptV1["stage"];
  readonly message: string;
  readonly phases: readonly VNextLifecyclePhaseReceiptV1[];
  readonly diagnostics?:
    readonly ExternalGodotLifecycleDiagnosticChunkV1[] | undefined;
  readonly coverage?: readonly VNextCaptureCoverageV1[] | undefined;
  readonly loss?: readonly VNextCaptureLossV1[] | undefined;
  readonly cleanup: VNextLifecycleCleanupReceiptV1 | null;
  readonly cause?: unknown;
}): ExternalGodotLifecycleLaunchFailureV1 =>
  (() => {
    const diagnostics = [...(input.diagnostics ?? [])];
    const capture = failureCoverageAndLoss(input.phases, diagnostics);
    return new ExternalGodotLifecycleLaunchFailureV1(
      {
        schemaVersion: 1,
        stage: input.stage,
        taskId: input.request.taskId,
        buildId: input.request.prepared.build.buildId,
        runtimeId: input.request.runtimeId,
        executionId: input.request.executionId,
        message: boundedFailureMessage(input.cause, input.message),
        phases: [...input.phases],
        diagnostics,
        coverage: [...(input.coverage ?? capture.coverage)],
        loss: [...(input.loss ?? capture.loss)],
        cleanup: input.cleanup,
      },
      input.cause === undefined ? undefined : { cause: input.cause },
    );
  })();

const terminalStatusFromSandbox = (
  result: SandboxExecutionResultV1,
): LifecycleRuntimeFactsV2["status"] => {
  if (result.kind !== "executed") return "crashed";
  if (!lifecycleCleanupProven(cleanupFromSandbox(result))) {
    return "cleanup_pending";
  }
  return result.receipt.status === "succeeded" ? "stopped" : "crashed";
};

const phaseReceipt = (input: {
  readonly sequence: number;
  readonly phase: VNextLifecyclePhaseReceiptV1["phase"];
  readonly operationId: string;
  readonly operationState?:
    VNextLifecyclePhaseReceiptV1["operationState"] | undefined;
  readonly timingFidelity?:
    VNextLifecyclePhaseReceiptV1["timingFidelity"] | undefined;
  readonly processDurationMs?: number | null | undefined;
  readonly stabilityObservedMs?: number | null | undefined;
  readonly outcome: VNextLifecyclePhaseReceiptV1["outcome"];
  readonly startedAt: string;
  readonly endedAt: string;
  readonly hostMonotonicStartUs: number;
  readonly hostMonotonicEndUs: number;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly views?: DiagnosticViews | undefined;
  readonly observation?: VNextLifecycleObservationV1 | null | undefined;
  readonly cleanup?: VNextLifecycleCleanupReceiptV1 | null | undefined;
  readonly knownSideEffects: readonly string[];
}): VNextLifecyclePhaseReceiptV1 => {
  const views = input.views ?? {
    stdout: emptyStreamView(false),
    stderr: emptyStreamView(false),
  };
  return VNextLifecyclePhaseReceiptV1Schema.parse({
    schemaVersion: 1,
    sequence: input.sequence,
    phase: input.phase,
    operationId: input.operationId,
    operationState: input.operationState ?? "started",
    timingFidelity: input.timingFidelity ?? "host_observed_bounds",
    processDurationMs: input.processDurationMs ?? null,
    stabilityObservedMs: input.stabilityObservedMs ?? null,
    outcome: input.outcome,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    hostMonotonicStartUs: input.hostMonotonicStartUs,
    hostMonotonicEndUs: input.hostMonotonicEndUs,
    exitCode: input.exitCode,
    signal: input.signal,
    stdout: boundedStream(views.stdout),
    stderr: boundedStream(views.stderr),
    observation: input.observation ?? null,
    cleanup: input.cleanup ?? null,
    knownSideEffects: [...input.knownSideEffects],
  });
};

const clockPosition = (
  sample: GodotLifecycleStatusSampleV1,
  hostMonotonicUs: number,
): VNextClockPositionV1 => ({
  schemaVersion: 1,
  processFrame: sample.processFrames,
  physicsTick: sample.physicsFrames,
  simulationTimeUs: sample.processTimeUs,
  hostMonotonicUs,
  renderFrame: null,
});

const observation = (input: {
  readonly runtime: GodotLifecycleRuntimeClient;
  readonly sample: GodotLifecycleStatusSampleV1;
  readonly hostMonotonicUs: number;
  readonly now: string;
}): VNextLifecycleObservationV1 => {
  const baseline = input.runtime.ready.baseline;
  return VNextLifecycleObservationV1Schema.parse({
    schemaVersion: 1,
    engineVersion: input.runtime.fingerprint.engineVersion,
    engineBuild:
      input.runtime.fingerprint.engineBuildHash ||
      input.runtime.fingerprint.engineVersion,
    platform: input.runtime.fingerprint.platform,
    renderer: input.runtime.fingerprint.renderer,
    audioDriver: input.runtime.fingerprint.audioDriver,
    headless:
      input.runtime.fingerprint.displayServer.toLowerCase() === "headless",
    configuredScene: input.runtime.fingerprint.configuredMainScene,
    currentScene: input.sample.currentScene ?? "unavailable",
    clock: clockPosition(input.sample, input.hostMonotonicUs),
    processFrameDelta: input.sample.processFrames - baseline.processFrames,
    physicsTickDelta: input.sample.physicsFrames - baseline.physicsFrames,
    observedAt: input.now,
  });
};

const coverageAndLoss = (input: {
  readonly samples: readonly {
    readonly sample: GodotLifecycleStatusSampleV1;
    readonly hostMonotonicUs: number;
  }[];
  readonly streamViews: DiagnosticViews;
  readonly streamStartUs: number;
  readonly outputRecordCount: Readonly<Record<"stdout" | "stderr", number>>;
}): {
  readonly coverage: readonly VNextCaptureCoverageV1[];
  readonly loss: readonly VNextCaptureLossV1[];
} => {
  const firstSample = input.samples[0];
  const lastSample = input.samples.at(-1);
  if (firstSample === undefined || lastSample === undefined) {
    throw new Error("lifecycle coverage requires at least one clock sample");
  }
  const from = clockPosition(firstSample.sample, firstSample.hostMonotonicUs);
  const through = clockPosition(lastSample.sample, lastSample.hostMonotonicUs);
  const availableRange = { schemaVersion: 1 as const, from, through };
  const streamAvailableRange = {
    schemaVersion: 1 as const,
    from: {
      schemaVersion: 1 as const,
      processFrame: 0,
      physicsTick: 0,
      simulationTimeUs: 0,
      hostMonotonicUs: input.streamStartUs,
      renderFrame: null,
    },
    through,
  };
  const endpointSamples = input.samples.length;
  let largestEndpointGap = 1;
  for (let index = 1; index < input.samples.length; index += 1) {
    const previous = input.samples[index - 1];
    const current = input.samples[index];
    if (previous === undefined || current === undefined) continue;
    largestEndpointGap = Math.max(
      largestEndpointGap,
      current.sample.processFrames - previous.sample.processFrames,
      current.sample.physicsFrames - previous.sample.physicsFrames,
    );
  }
  const uniqueProcessPositions = new Set(
    input.samples.map((entry) => entry.sample.processFrames),
  ).size;
  const uniquePhysicsPositions = new Set(
    input.samples.map((entry) => entry.sample.physicsFrames),
  ).size;
  const unsampledPositions = Math.max(
    0,
    lastSample.sample.processFrames -
      firstSample.sample.processFrames +
      1 -
      uniqueProcessPositions,
    lastSample.sample.physicsFrames -
      firstSample.sample.physicsFrames +
      1 -
      uniquePhysicsPositions,
  );
  const coverage: VNextCaptureCoverageV1[] = [
    VNextCaptureCoverageV1Schema.parse({
      schemaVersion: 1,
      channel: "clock",
      status: "sampled",
      availableRange,
      requestedSampleEvery: 1,
      realizedSampleEvery: largestEndpointGap,
      emittedRecords: endpointSamples,
      droppedRecords: 0,
      overwrittenRecords: 0,
      observerEffectUs: 0,
      limitations: [
        "coverage counts the baseline, readiness, and each realized status or shutdown endpoint",
        "render frame is unavailable in the headless profile",
        "observer effect was not measured; zero is only the known lower bound",
        "candidate source identity is revalidated at lifecycle endpoints, not continuously across the observation window",
      ],
    }),
    VNextCaptureCoverageV1Schema.parse({
      schemaVersion: 1,
      channel: "probe",
      status: "sampled",
      availableRange,
      requestedSampleEvery: 1,
      realizedSampleEvery: largestEndpointGap,
      emittedRecords: endpointSamples,
      droppedRecords: 0,
      overwrittenRecords: 0,
      observerEffectUs: 0,
      limitations: [
        "probe state is sampled only at the baseline, readiness, status, and shutdown endpoints",
        "probe and candidate execute in the same Godot process",
        "observer effect was not measured; zero is only the known lower bound",
        "candidate source identity is revalidated at lifecycle endpoints, not continuously across the observation window",
      ],
    }),
  ];
  const loss: VNextCaptureLossV1[] = [];
  for (const channel of ["clock", "probe"] as const) {
    loss.push(
      VNextCaptureLossV1Schema.parse({
        schemaVersion: 1,
        sequence: loss.length,
        channel,
        kind: "sampled",
        count: unsampledPositions,
        firstClock: from,
        lastClock: through,
        reason:
          "lifecycle-only readiness records endpoints, not every intervening frame or tick",
      }),
      VNextCaptureLossV1Schema.parse({
        schemaVersion: 1,
        sequence: loss.length + 1,
        channel,
        kind: "observer_effect",
        count: 0,
        firstClock: from,
        lastClock: through,
        reason:
          "probe observer overhead is unavailable in the lifecycle-only profile",
      }),
    );
  }
  for (const [channel, view] of [
    ["log", input.streamViews.stdout],
    ["error", input.streamViews.stderr],
  ] as const) {
    coverage.push(
      VNextCaptureCoverageV1Schema.parse({
        schemaVersion: 1,
        channel,
        status: view.final && !view.truncated ? "full" : "partial",
        availableRange: streamAvailableRange,
        requestedSampleEvery: 1,
        realizedSampleEvery: 1,
        emittedRecords:
          input.outputRecordCount[channel === "log" ? "stdout" : "stderr"],
        droppedRecords: view.truncated ? 1 : 0,
        overwrittenRecords: 0,
        observerEffectUs: 0,
        limitations: [
          view.final
            ? "raw process output is retained under a byte bound"
            : "final process-output byte total is pending process exit",
          "candidate source identity is revalidated at lifecycle endpoints, not continuously across the observation window",
        ],
      }),
    );
    if (!view.final || view.truncated) {
      loss.push(
        VNextCaptureLossV1Schema.parse({
          schemaVersion: 1,
          sequence: loss.length,
          channel,
          kind: view.truncated ? "dropped" : "unavailable",
          count: view.droppedBytes,
          firstClock: view.truncated ? streamAvailableRange.from : null,
          lastClock: view.truncated ? streamAvailableRange.through : null,
          reason: view.truncated
            ? "sidecar output retention byte bound was reached"
            : "final stream summary is unavailable while Godot is running",
        }),
      );
    }
  }
  return { coverage, loss };
};

const diagnosticsFacts = (
  vanilla: DiagnosticViews,
  managed: DiagnosticViews,
): LifecycleRuntimeFactsV2["diagnostics"] => {
  const stdout = aggregateView(vanilla.stdout, managed.stdout);
  const stderr = aggregateView(vanilla.stderr, managed.stderr);
  return {
    stdoutTotalBytes: stdout.totalBytes,
    stdoutRetainedBytes: Math.min(stdout.retainedBytes, 1_048_576),
    stdoutTruncated: stdout.truncated,
    stderrTotalBytes: stderr.totalBytes,
    stderrRetainedBytes: Math.min(stderr.retainedBytes, 1_048_576),
    stderrTruncated: stderr.truncated,
  };
};

const runtimeFacts = (input: {
  readonly request: Parameters<ExternalGodotLifecycleDriverV1["launch"]>[0];
  readonly runtime: GodotLifecycleRuntimeClient;
  readonly status: LifecycleRuntimeFactsV2["status"];
  readonly sample: GodotLifecycleStatusSampleV1;
  readonly hostMonotonicUs: number;
  readonly vanillaViews: DiagnosticViews;
  readonly managedViews: DiagnosticViews;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly coverage: readonly VNextCaptureCoverageV1[];
  readonly loss: readonly VNextCaptureLossV1[];
}): LifecycleRuntimeFactsV2 => {
  const baseline = input.runtime.ready.baseline;
  return {
    schemaVersion: 2,
    taskId: input.request.taskId,
    runtimeId: input.request.runtimeId,
    executionId: input.request.executionId,
    buildId: input.request.prepared.build.buildId,
    status: input.status,
    engine: {
      version: input.runtime.fingerprint.engineVersion,
      build:
        input.runtime.fingerprint.engineBuildHash ||
        input.runtime.fingerprint.engineVersion,
      platform: input.runtime.fingerprint.platform,
      renderer: input.runtime.fingerprint.renderer,
      audioDriver: input.runtime.fingerprint.audioDriver,
      headless:
        input.runtime.fingerprint.displayServer.toLowerCase() === "headless",
    },
    configuredScene: input.runtime.fingerprint.configuredMainScene,
    currentScene: input.sample.currentScene ?? "unavailable",
    clocks: {
      processFrame: input.sample.processFrames,
      physicsTick: input.sample.physicsFrames,
      simulationTimeUs: input.sample.processTimeUs,
      hostMonotonicUs: input.hostMonotonicUs,
      renderFrame: null,
      processFrameDelta: input.sample.processFrames - baseline.processFrames,
      physicsTickDelta: input.sample.physicsFrames - baseline.physicsFrames,
    },
    coverage: input.coverage.map((entry) => ({
      channel:
        entry.channel === "clock" ||
        entry.channel === "log" ||
        entry.channel === "error" ||
        entry.channel === "probe"
          ? entry.channel
          : "probe",
      status:
        entry.status === "full"
          ? "full"
          : entry.status === "unavailable"
            ? "unavailable"
            : "partial",
      emittedRecords: entry.emittedRecords,
      droppedRecords: entry.droppedRecords + entry.overwrittenRecords,
      limitations: [...entry.limitations],
    })),
    loss: input.loss.map((entry) => ({
      channel:
        entry.channel === "clock" ||
        entry.channel === "log" ||
        entry.channel === "error" ||
        entry.channel === "probe"
          ? entry.channel
          : "probe",
      kind:
        entry.kind === "unavailable" ||
        entry.kind === "sampled" ||
        entry.kind === "degraded"
          ? "unavailable"
          : entry.kind === "observer_effect"
            ? "observer_effect"
            : entry.kind === "dropped" || entry.kind === "overwritten"
              ? "dropped"
              : "truncated",
      count: entry.count,
      reason: entry.reason,
    })),
    diagnostics: diagnosticsFacts(input.vanillaViews, input.managedViews),
    startedAt: input.startedAt,
    endedAt: input.endedAt,
  };
};

const assertManagedProjection = (
  request: Parameters<ExternalGodotLifecycleDriverV1["launch"]>[0],
  capability: ManagedGodotLifecycleRuntimeCapabilityV1,
): void => {
  const projection = request.managedRuntime;
  if (
    projection.managedRuntimeId !== capability.managedRuntimeId ||
    projection.addonHash !== capability.addonHash ||
    projection.overlayHash !== capability.overlayHash ||
    projection.vanillaSidecarSourceSha256 !==
      capability.vanillaSidecarSourceSha256 ||
    projection.lifecycleSidecarSourceSha256 !==
      capability.lifecycleSidecarSourceSha256 ||
    request.prepared.addonHash !== capability.addonHash ||
    request.prepared.overlayHash !== capability.overlayHash ||
    request.prepared.vanillaSidecarHash !==
      capability.vanillaSidecarSourceSha256 ||
    request.prepared.lifecycleSidecarHash !==
      capability.lifecycleSidecarSourceSha256
  ) {
    throw new TypeError(
      "lifecycle driver request does not match the bound managed runtime",
    );
  }
  if (!/^[a-f0-9]{64}$/u.test(request.token)) {
    throw new TypeError("lifecycle driver token is invalid");
  }
};

export interface ExternalGodotLifecycleSandboxDriverOptionsV1 {
  readonly sidecarPort: Pick<
    GodotLifecycleSidecarPortV1,
    "runVanillaSmoke" | "openManaged"
  >;
  readonly managedRuntime: ManagedGodotLifecycleRuntimeCapabilityV1;
  readonly now?: (() => string) | undefined;
  readonly monotonicUs?: (() => number) | undefined;
}

export const createExternalGodotLifecycleSandboxDriverV1 = (
  options: ExternalGodotLifecycleSandboxDriverOptionsV1,
): ExternalGodotLifecycleDriverV1 => {
  const port = options.sidecarPort;
  const now = options.now ?? (() => new Date().toISOString());
  const monotonicUs = options.monotonicUs ?? nowMonotonicUs;

  return {
    async launch(request, signal): Promise<ExternalGodotLifecycleSessionV1> {
      assertManagedProjection(request, options.managedRuntime);
      const startedAt = now();
      const vanillaLaunch = GodotLifecycleVanillaSmokeLaunchV1Schema.parse({
        schemaVersion: 1,
        runtimeProfile: "chronorift-managed-godot-lifecycle-v1",
        operation: "vanilla_smoke",
        taskId: request.taskId,
        buildId: request.prepared.build.buildId,
        runtimeId: request.runtimeId,
        executionId: request.executionId,
        managedRuntimeId: options.managedRuntime.managedRuntimeId,
        candidateSourceHash: request.prepared.build.sourceHash,
        importTimeoutMs: 120_000,
        vanillaTimeoutMs: 10_000,
        stabilityWindowMs: 2_000,
        ...DEFAULT_DIAGNOSTIC_LIMITS,
      });
      const vanillaAttemptStartUs = monotonicUs();
      const vanillaOperationId = `lifecycle-vanilla:${createHash("sha256")
        .update(
          `${request.taskId}\0${request.runtimeId}\0${request.executionId}`,
        )
        .digest("hex")
        .slice(0, 24)}`;
      let vanilla: Awaited<ReturnType<typeof port.runVanillaSmoke>>;
      try {
        vanilla = await port.runVanillaSmoke(vanillaLaunch, signal);
      } catch (error) {
        const endedUs = monotonicUs();
        throw launchFailure({
          request,
          stage: "vanilla_import",
          message: "vanilla lifecycle sidecar call failed",
          phases: [
            phaseReceipt({
              sequence: 0,
              phase: "vanilla_import",
              operationId: vanillaOperationId,
              operationState: "unknown",
              outcome: "failed",
              startedAt,
              endedAt: now(),
              hostMonotonicStartUs: vanillaAttemptStartUs,
              hostMonotonicEndUs: Math.max(vanillaAttemptStartUs, endedUs),
              exitCode: null,
              signal: null,
              knownSideEffects: [
                "the sidecar port failed before physical process admission could be observed",
              ],
            }),
          ],
          cleanup: null,
          cause: error,
        });
      }
      if (vanilla.kind !== "completed") {
        const endedUs = monotonicUs();
        throw launchFailure({
          request,
          stage: "vanilla_import",
          message: "vanilla lifecycle smoke was denied by sandbox policy",
          phases: [
            phaseReceipt({
              sequence: 0,
              phase: "vanilla_import",
              operationId: vanillaOperationId,
              operationState: "not_started",
              outcome: "failed",
              startedAt,
              endedAt: now(),
              hostMonotonicStartUs: vanillaAttemptStartUs,
              hostMonotonicEndUs: Math.max(vanillaAttemptStartUs, endedUs),
              exitCode: null,
              signal: null,
              knownSideEffects: [
                "sandbox policy denied the vanilla process before execution",
              ],
            }),
          ],
          cleanup: null,
        });
      }
      const vanillaDiagnosticChunks = diagnosticChunks(
        vanilla.result.diagnostics,
      );
      const smoke = vanilla.result.diagnostics.find(
        (record) => record.kind === "smoke_complete",
      );
      const smokeFailed = vanilla.result.diagnostics.find(
        (record) => record.kind === "smoke_failed",
      );
      const sidecarError = vanilla.result.diagnostics.find(
        (record) => record.kind === "sidecar_error",
      );
      const vanillaSandbox = vanilla.result.sandbox;
      const vanillaCleanup = cleanupFromSandbox(vanillaSandbox);
      const vanillaStartUs = Math.floor(
        vanillaSandbox.receipt.startedAtMonotonicMs * 1_000,
      );
      const vanillaEndUs = Math.floor(
        vanillaSandbox.receipt.endedAtMonotonicMs * 1_000,
      );
      if (
        smokeFailed?.kind === "smoke_failed" &&
        smokeFailed.candidateSourceHash === request.prepared.build.sourceHash &&
        smokeFailed.fileCount === request.prepared.fileCount &&
        smokeFailed.byteLength === request.prepared.byteLength &&
        ((smokeFailed.failedPhase === "import" &&
          smokeFailed.vanilla === null) ||
          (smokeFailed.failedPhase === "vanilla" &&
            smokeFailed.vanilla !== null))
      ) {
        const importViews = viewsForVanillaPhase(
          vanilla.result.diagnostics,
          "import",
          smokeFailed.import,
        );
        const importEndUs = vanillaEndUs;
        const failedPhases: VNextLifecyclePhaseReceiptV1[] = [
          phaseReceipt({
            sequence: 0,
            phase: "vanilla_import",
            operationId: vanillaSandbox.receipt.operationId,
            timingFidelity: "operation_bounds",
            processDurationMs: smokeFailed.import.durationMs,
            outcome:
              smokeFailed.failedPhase === "import"
                ? failureOutcome(smokeFailed.import.timedOut)
                : "succeeded",
            startedAt,
            endedAt: now(),
            hostMonotonicStartUs: vanillaStartUs,
            hostMonotonicEndUs: importEndUs,
            exitCode: smokeFailed.import.exitCode,
            signal: smokeFailed.import.signal,
            views: importViews,
            cleanup:
              smokeFailed.failedPhase === "import" ? vanillaCleanup : null,
            knownSideEffects: [
              "Godot import cache was confined to operation scratch",
            ],
          }),
        ];
        if (
          smokeFailed.failedPhase === "vanilla" &&
          smokeFailed.vanilla !== null
        ) {
          const failedVanilla = smokeFailed.vanilla;
          const smokeViews = viewsForVanillaPhase(
            vanilla.result.diagnostics,
            "vanilla",
            failedVanilla,
          );
          failedPhases.push(
            phaseReceipt({
              sequence: 1,
              phase: "vanilla_smoke",
              operationId: vanillaSandbox.receipt.operationId,
              outcome: failureOutcome(failedVanilla.timedOut),
              startedAt,
              endedAt: now(),
              hostMonotonicStartUs: vanillaStartUs,
              hostMonotonicEndUs: vanillaEndUs,
              timingFidelity: "operation_bounds",
              processDurationMs: failedVanilla.durationMs,
              exitCode: failedVanilla.exitCode,
              signal: failedVanilla.signal,
              views: smokeViews,
              cleanup: vanillaCleanup,
              knownSideEffects: [
                "vanilla main-scene observation ended before its stability contract",
              ],
            }),
          );
        }
        throw launchFailure({
          request,
          stage:
            smokeFailed.failedPhase === "import"
              ? "vanilla_import"
              : "vanilla_smoke",
          message:
            sidecarError?.kind === "sidecar_error"
              ? sidecarError.message
              : `vanilla ${smokeFailed.failedPhase} failed`,
          phases: failedPhases,
          diagnostics: vanillaDiagnosticChunks,
          cleanup: vanillaCleanup,
        });
      }
      if (smoke?.kind !== "smoke_complete") {
        throw launchFailure({
          request,
          stage: "vanilla_import",
          message:
            sidecarError?.kind === "sidecar_error"
              ? sidecarError.message
              : "vanilla lifecycle sidecar ended without a terminal process receipt",
          phases: [
            phaseReceipt({
              sequence: 0,
              phase: "vanilla_import",
              operationId: vanillaSandbox.receipt.operationId,
              timingFidelity: "operation_bounds",
              outcome:
                vanillaSandbox.receipt.status === "timed_out"
                  ? "timed_out"
                  : "failed",
              startedAt,
              endedAt: now(),
              hostMonotonicStartUs: vanillaStartUs,
              hostMonotonicEndUs: vanillaEndUs,
              exitCode: vanillaSandbox.receipt.exitCode,
              signal: vanillaSandbox.receipt.signal,
              views: viewsFromSandbox(vanillaSandbox),
              cleanup: vanillaCleanup,
              knownSideEffects: [
                "vanilla sidecar termination details are limited to broker receipts",
              ],
            }),
          ],
          diagnostics: vanillaDiagnosticChunks,
          cleanup: vanillaCleanup,
        });
      }
      const importViews = viewsForVanillaPhase(
        vanilla.result.diagnostics,
        "import",
        smoke.import,
      );
      const smokeViews = viewsForVanillaPhase(
        vanilla.result.diagnostics,
        "vanilla",
        smoke.vanilla,
      );
      const vanillaViews = {
        stdout: aggregateView(importViews.stdout, smokeViews.stdout),
        stderr: aggregateView(importViews.stderr, smokeViews.stderr),
      };
      const importEndUs = vanillaEndUs;
      const vanillaSmokeStartUs = vanillaStartUs;
      const initialPhases: VNextLifecyclePhaseReceiptV1[] = [
        phaseReceipt({
          sequence: 0,
          phase: "vanilla_import",
          operationId: vanillaSandbox.receipt.operationId,
          timingFidelity: "operation_bounds",
          processDurationMs: smoke.import.durationMs,
          outcome: "succeeded",
          startedAt,
          endedAt: now(),
          hostMonotonicStartUs: vanillaStartUs,
          hostMonotonicEndUs: importEndUs,
          exitCode: smoke.import.exitCode,
          signal: smoke.import.signal,
          views: importViews,
          knownSideEffects: [
            "Godot import cache was created only in operation scratch",
            "candidate source identity was revalidated at the import endpoint, not continuously",
          ],
        }),
        phaseReceipt({
          sequence: 1,
          phase: "vanilla_smoke",
          operationId: vanillaSandbox.receipt.operationId,
          timingFidelity: "operation_bounds",
          processDurationMs: smoke.vanilla.durationMs,
          stabilityObservedMs: smoke.stabilityObservedMs,
          outcome: "controlled_stop",
          startedAt,
          endedAt: now(),
          hostMonotonicStartUs: vanillaSmokeStartUs,
          hostMonotonicEndUs: vanillaEndUs,
          exitCode: smoke.vanilla.exitCode,
          signal: smoke.vanilla.signal,
          views: smokeViews,
          cleanup: vanillaCleanup,
          knownSideEffects: [
            "vanilla process was stopped after the bounded stability observation",
            "candidate source identity was revalidated after vanilla stop, not continuously during the observation window",
          ],
        }),
      ];
      if (
        smoke.candidateSourceHash !== request.prepared.build.sourceHash ||
        smoke.fileCount !== request.prepared.fileCount ||
        smoke.byteLength !== request.prepared.byteLength ||
        !sourceVerificationsMatch(
          vanilla.result.diagnostics,
          ["import", "vanilla"],
          {
            candidateSourceHash: request.prepared.build.sourceHash,
            fileCount: request.prepared.fileCount,
            byteLength: request.prepared.byteLength,
          },
        ) ||
        vanilla.result.diagnosticFacts.failure !== null ||
        vanillaSandbox.receipt.status !== "succeeded" ||
        smoke.import.exitCode !== 0 ||
        smoke.import.signal !== null ||
        smoke.import.timedOut ||
        smoke.stabilityObservedMs < 2_000 ||
        smoke.vanilla.timedOut ||
        !lifecycleCleanupProven(vanillaCleanup)
      ) {
        throw launchFailure({
          request,
          stage:
            smoke.import.exitCode !== 0 ||
            smoke.import.signal !== null ||
            smoke.import.timedOut
              ? "vanilla_import"
              : "vanilla_smoke",
          message:
            "vanilla lifecycle smoke or its physical cleanup was not proven",
          phases: initialPhases,
          diagnostics: vanillaDiagnosticChunks,
          cleanup: vanillaCleanup,
        });
      }

      const managedLaunch = GodotLifecycleSidecarLaunchV1Schema.parse({
        schemaVersion: 1,
        runtimeProfile: "chronorift-managed-godot-lifecycle-v1",
        operation: "managed_lifecycle",
        taskId: request.taskId,
        buildId: request.prepared.build.buildId,
        runtimeId: request.runtimeId,
        executionId: request.executionId,
        managedRuntimeId: options.managedRuntime.managedRuntimeId,
        candidateSourceHash: request.prepared.build.sourceHash,
        protocolProfile: "chronorift-godot-lifecycle-v1",
        protocolVersion: 1,
        token: request.token,
        overlayHash: options.managedRuntime.overlayHash,
        addonHash: options.managedRuntime.addonHash,
        expectedMainScene: request.prepared.configuredMainScene,
        startupTimeoutMs: 30_000,
        executionTimeoutMs: 600_000,
        ...DEFAULT_DIAGNOSTIC_LIMITS,
      });
      const managedStartUs = monotonicUs();
      const managedOperationId = `lifecycle-managed:${createHash("sha256")
        .update(
          `${request.taskId}\0${request.runtimeId}\0${request.executionId}`,
        )
        .digest("hex")
        .slice(0, 24)}`;
      let opened: Awaited<ReturnType<typeof port.openManaged>>;
      try {
        opened = await port.openManaged(managedLaunch, signal);
      } catch (error) {
        const endedUs = monotonicUs();
        throw launchFailure({
          request,
          stage: "managed_open",
          message: "managed lifecycle sidecar call failed",
          phases: [
            ...initialPhases,
            phaseReceipt({
              sequence: 2,
              phase: "managed_import",
              operationId: managedOperationId,
              operationState: "unknown",
              outcome: "failed",
              startedAt,
              endedAt: now(),
              hostMonotonicStartUs: managedStartUs,
              hostMonotonicEndUs: Math.max(managedStartUs, endedUs),
              exitCode: null,
              signal: null,
              knownSideEffects: [
                "the sidecar port failed before managed process admission could be observed",
              ],
            }),
          ],
          diagnostics: vanillaDiagnosticChunks,
          cleanup: null,
          cause: error,
        });
      }
      if (opened.kind !== "opened") {
        const endedUs = monotonicUs();
        const executed = opened.kind === "executed" ? opened : null;
        const managedCleanup =
          executed === null ? null : cleanupFromSandbox(executed);
        throw launchFailure({
          request,
          stage: "managed_open",
          message: "managed lifecycle sidecar was not opened",
          phases: [
            ...initialPhases,
            phaseReceipt({
              sequence: 2,
              phase: "managed_import",
              operationId: executed?.receipt.operationId ?? managedOperationId,
              operationState: executed === null ? "not_started" : "started",
              timingFidelity:
                executed === null ? "host_observed_bounds" : "operation_bounds",
              outcome:
                executed?.receipt.status === "timed_out"
                  ? "timed_out"
                  : "failed",
              startedAt,
              endedAt: now(),
              hostMonotonicStartUs:
                executed === null
                  ? managedStartUs
                  : Math.floor(executed.receipt.startedAtMonotonicMs * 1_000),
              hostMonotonicEndUs:
                executed === null
                  ? Math.max(managedStartUs, endedUs)
                  : Math.max(
                      managedStartUs,
                      Math.floor(executed.receipt.endedAtMonotonicMs * 1_000),
                    ),
              exitCode: executed?.receipt.exitCode ?? null,
              signal: executed?.receipt.signal ?? null,
              ...(executed === null
                ? {}
                : { views: viewsFromSandbox(executed) }),
              cleanup: managedCleanup,
              knownSideEffects: [
                executed === null
                  ? "sandbox policy denied the managed overlay process before execution"
                  : "managed sidecar ended before lifecycle handshake",
              ],
            }),
          ],
          diagnostics: vanillaDiagnosticChunks,
          cleanup: managedCleanup,
        });
      }
      const sidecar = opened.sidecar;
      let runtime: GodotLifecycleRuntimeClient;
      let firstStatus: GodotLifecycleStatusReceiptV1;
      try {
        runtime = await connectGodotLifecycleRuntime(sidecar.transport, {
          schemaVersion: 1,
          token: request.token,
          expectedIdentity: {
            taskId: request.taskId,
            buildId: request.prepared.build.buildId,
            runtimeId: request.runtimeId,
            executionId: request.executionId,
            managedRuntimeId: options.managedRuntime.managedRuntimeId,
            candidateSourceHash: request.prepared.build.sourceHash,
            overlayHash: options.managedRuntime.overlayHash,
            addonHash: options.managedRuntime.addonHash,
          },
          expectedEngineVersion: options.managedRuntime.engineVersion,
          expectedPlatform: "Linux",
          expectedRenderer: "gl_compatibility",
          expectedDisplayServer: "headless",
          expectedAudioDriver: "Dummy",
          expectedMainScene: request.prepared.configuredMainScene,
          handshakeTimeoutMs: 30_000,
        });
        firstStatus = await runtime.status();
        const diagnosticFacts = sidecar.diagnosticFacts();
        const stage = diagnosticFacts.records.find(
          (record) => record.kind === "stage_ready",
        );
        if (
          diagnosticFacts.failure !== null ||
          stage?.kind !== "stage_ready" ||
          stage.candidateSourceHash !== request.prepared.build.sourceHash ||
          stage.fileCount !== request.prepared.fileCount ||
          stage.byteLength !== request.prepared.byteLength ||
          stage.overlayHash !== options.managedRuntime.overlayHash ||
          stage.addonHash !== options.managedRuntime.addonHash ||
          !diagnosticFacts.records.some(
            (record) => record.kind === "godot_started",
          )
        ) {
          throw new Error(
            "managed lifecycle staging diagnostics did not match the admitted runtime",
          );
        }
      } catch (error) {
        let terminateFailure: unknown;
        try {
          await sidecar.terminate();
        } catch (terminateError) {
          terminateFailure = terminateError;
        }
        let cleanupResult: SandboxExecutionResultV1 | undefined;
        let completionFailure: unknown;
        try {
          cleanupResult = await sidecar.completion;
        } catch (completionError) {
          completionFailure = completionError;
        }
        const executedCleanup =
          cleanupResult?.kind === "executed" ? cleanupResult : null;
        const handshakeCleanup =
          executedCleanup === null ? null : cleanupFromSandbox(executedCleanup);
        let cleanupProblem: Error | undefined;
        if (completionFailure !== undefined) {
          cleanupProblem = new Error(
            "lifecycle handshake sandbox cleanup completion failed",
            { cause: completionFailure },
          );
        } else if (executedCleanup === null) {
          cleanupProblem = new Error(
            "lifecycle handshake completed without an execution cleanup receipt",
          );
        } else if (
          handshakeCleanup === null ||
          !lifecycleCleanupProven(handshakeCleanup)
        ) {
          cleanupProblem = new Error(
            "lifecycle handshake cleanup was not proven",
          );
        }
        const failureParts = [
          error,
          ...(cleanupProblem === undefined ? [] : [cleanupProblem]),
          ...(cleanupProblem !== undefined && terminateFailure !== undefined
            ? [terminateFailure]
            : []),
        ];
        const failureCause =
          failureParts.length === 1
            ? error
            : new AggregateError(
                failureParts,
                "lifecycle handshake failed with incomplete sandbox cleanup",
              );
        const diagnosticFacts = sidecar.diagnosticFacts();
        const stage = diagnosticFacts.records.find(
          (record) => record.kind === "stage_ready",
        );
        const managedStageAdmitted =
          diagnosticFacts.failure === null &&
          stage?.kind === "stage_ready" &&
          stage.candidateSourceHash === request.prepared.build.sourceHash &&
          stage.fileCount === request.prepared.fileCount &&
          stage.byteLength === request.prepared.byteLength &&
          stage.overlayHash === options.managedRuntime.overlayHash &&
          stage.addonHash === options.managedRuntime.addonHash &&
          diagnosticFacts.records.some(
            (record) => record.kind === "godot_started",
          );
        const failureStartUs =
          executedCleanup === null
            ? managedStartUs
            : Math.floor(executedCleanup.receipt.startedAtMonotonicMs * 1_000);
        const failureEndUs =
          executedCleanup === null
            ? Math.max(managedStartUs, monotonicUs())
            : Math.max(
                managedStartUs,
                Math.floor(executedCleanup.receipt.endedAtMonotonicMs * 1_000),
              );
        const managedViews = viewsForManaged(diagnosticFacts.records);
        const failedPhases: VNextLifecyclePhaseReceiptV1[] = [
          ...initialPhases,
          phaseReceipt({
            sequence: 2,
            phase: "managed_import",
            operationId:
              executedCleanup?.receipt.operationId ?? managedOperationId,
            timingFidelity:
              executedCleanup === null
                ? "host_observed_bounds"
                : "operation_bounds",
            outcome: managedStageAdmitted ? "succeeded" : "failed",
            startedAt,
            endedAt: now(),
            hostMonotonicStartUs: failureStartUs,
            hostMonotonicEndUs: failureEndUs,
            exitCode: managedStageAdmitted
              ? null
              : (executedCleanup?.receipt.exitCode ?? null),
            signal: managedStageAdmitted
              ? null
              : (executedCleanup?.receipt.signal ?? null),
            ...(managedStageAdmitted ? {} : { views: managedViews }),
            cleanup: managedStageAdmitted ? null : handshakeCleanup,
            knownSideEffects: [
              managedStageAdmitted
                ? "managed addon and override were admitted as read-only overlay inputs"
                : "managed overlay admission could not be proven",
            ],
          }),
        ];
        if (managedStageAdmitted) {
          failedPhases.push(
            phaseReceipt({
              sequence: 3,
              phase: "managed_handshake",
              operationId:
                executedCleanup?.receipt.operationId ?? managedOperationId,
              timingFidelity:
                executedCleanup === null
                  ? "host_observed_bounds"
                  : "operation_bounds",
              outcome:
                executedCleanup?.receipt.status === "timed_out"
                  ? "timed_out"
                  : "failed",
              startedAt,
              endedAt: now(),
              hostMonotonicStartUs: failureStartUs,
              hostMonotonicEndUs: failureEndUs,
              exitCode: executedCleanup?.receipt.exitCode ?? null,
              signal: executedCleanup?.receipt.signal ?? null,
              views: managedViews,
              cleanup: handshakeCleanup,
              knownSideEffects: [
                "managed lifecycle handshake ended before an admitted runtime session",
              ],
            }),
          );
        }
        throw launchFailure({
          request,
          stage: managedStageAdmitted ? "managed_handshake" : "managed_open",
          message: "managed lifecycle launch failed",
          phases: failedPhases,
          diagnostics: [
            ...vanillaDiagnosticChunks,
            ...diagnosticChunks(diagnosticFacts.records),
          ],
          cleanup: handshakeCleanup,
          cause: failureCause,
        });
      }
      const managedReadyUs = runtime.ready.hostMonotonicEndUs;
      const firstObservation = observation({
        runtime,
        sample: runtime.ready.observed,
        hostMonotonicUs: managedReadyUs,
        now: now(),
      });
      const statusObservation = observation({
        runtime,
        sample: firstStatus.sample,
        hostMonotonicUs: firstStatus.hostMonotonicEndUs,
        now: now(),
      });
      initialPhases.push(
        phaseReceipt({
          sequence: 2,
          phase: "managed_import",
          operationId: managedOperationId,
          outcome: "succeeded",
          startedAt,
          endedAt: now(),
          hostMonotonicStartUs: managedStartUs,
          hostMonotonicEndUs: runtime.ready.hostMonotonicStartUs,
          exitCode: null,
          signal: null,
          knownSideEffects: [
            "managed addon and override were admitted as read-only overlay inputs",
          ],
        }),
        phaseReceipt({
          sequence: 3,
          phase: "managed_handshake",
          operationId: managedOperationId,
          outcome: "succeeded",
          startedAt,
          endedAt: now(),
          hostMonotonicStartUs: runtime.ready.hostMonotonicStartUs,
          hostMonotonicEndUs: managedReadyUs,
          exitCode: null,
          signal: null,
          observation: firstObservation,
          knownSideEffects: [
            "managed read-only lifecycle autoload executed in the candidate process",
          ],
        }),
        phaseReceipt({
          sequence: 4,
          phase: "managed_status",
          operationId: `lifecycle-status:${request.runtimeId}`,
          outcome: "succeeded",
          startedAt,
          endedAt: now(),
          hostMonotonicStartUs: firstStatus.hostMonotonicStartUs,
          hostMonotonicEndUs: firstStatus.hostMonotonicEndUs,
          exitCode: null,
          signal: null,
          observation: statusObservation,
          knownSideEffects: [
            "status sampling observes clocks after they have advanced",
          ],
        }),
      );

      let lastStatus = firstStatus;
      const endpointSamples: Array<{
        readonly sample: GodotLifecycleStatusSampleV1;
        readonly hostMonotonicUs: number;
      }> = [
        {
          sample: runtime.ready.baseline,
          hostMonotonicUs: runtime.ready.hostMonotonicStartUs,
        },
        {
          sample: runtime.ready.observed,
          hostMonotonicUs: runtime.ready.hostMonotonicEndUs,
        },
        {
          sample: firstStatus.sample,
          hostMonotonicUs: firstStatus.hostMonotonicEndUs,
        },
      ];
      let endedAt: string | null = null;
      let stopPromise: Promise<ExternalGodotLifecycleDriverStopV1> | undefined;
      let completionResult: SandboxExecutionResultV1 | undefined;
      void sidecar.completion.then(
        (result) => {
          completionResult = result;
          endedAt ??= now();
        },
        () => undefined,
      );

      const snapshot = (
        status: LifecycleRuntimeFactsV2["status"],
      ): ExternalGodotLifecycleDriverSnapshotV1 => {
        const records = sidecar.diagnostics();
        const diagnosticFacts = sidecar.diagnosticFacts();
        const diagnosticsFailed =
          diagnosticFacts.failure !== null ||
          (status !== "running" &&
            terminalDiagnosticsFailed(diagnosticFacts, {
              candidateSourceHash: request.prepared.build.sourceHash,
              fileCount: request.prepared.fileCount,
              byteLength: request.prepared.byteLength,
            }));
        const effectiveStatus =
          diagnosticsFailed && status !== "cleanup_pending"
            ? "crashed"
            : status;
        const managedViews = viewsForManaged(records);
        const allStreamViews = {
          stdout: aggregateView(vanillaViews.stdout, managedViews.stdout),
          stderr: aggregateView(vanillaViews.stderr, managedViews.stderr),
        };
        const diagnostics = [
          ...vanillaDiagnosticChunks,
          ...diagnosticChunks(records),
        ];
        const outputRecordCount = {
          stdout: diagnostics.filter((chunk) => chunk.stream === "stdout")
            .length,
          stderr: diagnostics.filter((chunk) => chunk.stream === "stderr")
            .length,
        };
        const capture = coverageAndLoss({
          samples: endpointSamples,
          streamViews: allStreamViews,
          streamStartUs: vanillaStartUs,
          outputRecordCount,
        });
        return {
          facts: runtimeFacts({
            request,
            runtime,
            status: effectiveStatus,
            sample: lastStatus.sample,
            hostMonotonicUs: lastStatus.hostMonotonicEndUs,
            vanillaViews,
            managedViews,
            startedAt,
            endedAt,
            coverage: capture.coverage,
            loss: capture.loss,
          }),
          phases: [],
          diagnostics,
          coverage: capture.coverage,
          loss: capture.loss,
        };
      };

      const session: ExternalGodotLifecycleSessionV1 = {
        initial: {
          ...snapshot("running"),
          phases: initialPhases,
        },
        async status(): Promise<ExternalGodotLifecycleDriverSnapshotV1> {
          if (completionResult !== undefined) {
            return snapshot(terminalStatusFromSandbox(completionResult));
          }
          const next = await Promise.race([
            sidecar.completion.then((result) => ({
              kind: "completion" as const,
              result,
            })),
            runtime.status().then((status) => ({
              kind: "status" as const,
              status,
            })),
          ]);
          if (next.kind === "completion") {
            completionResult = next.result;
            endedAt ??= now();
            return snapshot(terminalStatusFromSandbox(next.result));
          }
          lastStatus = next.status;
          endpointSamples.push({
            sample: next.status.sample,
            hostMonotonicUs: next.status.hostMonotonicEndUs,
          });
          const sampled = snapshot("running");
          return {
            ...sampled,
            phases: [
              phaseReceipt({
                sequence: 0,
                phase: "managed_status",
                operationId: `lifecycle-status:${request.runtimeId}`,
                outcome: "succeeded",
                startedAt: now(),
                endedAt: now(),
                hostMonotonicStartUs: lastStatus.hostMonotonicStartUs,
                hostMonotonicEndUs: lastStatus.hostMonotonicEndUs,
                exitCode: null,
                signal: null,
                observation: observation({
                  runtime,
                  sample: lastStatus.sample,
                  hostMonotonicUs: lastStatus.hostMonotonicEndUs,
                  now: now(),
                }),
                knownSideEffects: [
                  "status sampling observes clocks after they have advanced",
                ],
              }),
            ],
          };
        },
        stop(): Promise<ExternalGodotLifecycleDriverStopV1> {
          stopPromise ??= (async () => {
            const stopStart = monotonicUs();
            const stopStartedAt = now();
            let acknowledged = false;
            try {
              lastStatus = await runtime.shutdown();
              endpointSamples.push({
                sample: lastStatus.sample,
                hostMonotonicUs: lastStatus.hostMonotonicEndUs,
              });
              acknowledged = true;
            } catch {
              await sidecar.terminate().catch(() => undefined);
            }
            const completed = completionResult ?? (await sidecar.completion);
            endedAt = now();
            if (completed.kind !== "executed") {
              throw new Error(
                "opened lifecycle sidecar completed without an execution receipt",
              );
            }
            const cleanup = cleanupFromSandbox(completed);
            const cleanupProven = lifecycleCleanupProven(cleanup);
            const diagnosticsFailed = terminalDiagnosticsFailed(
              sidecar.diagnosticFacts(),
              {
                candidateSourceHash: request.prepared.build.sourceHash,
                fileCount: request.prepared.fileCount,
                byteLength: request.prepared.byteLength,
              },
            );
            const status: LifecycleRuntimeFactsV2["status"] = !cleanupProven
              ? "cleanup_pending"
              : !diagnosticsFailed && completed.receipt.status === "succeeded"
                ? "stopped"
                : "crashed";
            const sampled = snapshot(status);
            const stopEnd = Math.floor(
              completed.receipt.endedAtMonotonicMs * 1_000,
            );
            return {
              ...sampled,
              phases: [
                phaseReceipt({
                  sequence: 0,
                  phase: "managed_stop",
                  operationId: completed.receipt.operationId,
                  outcome:
                    cleanupProven &&
                    !diagnosticsFailed &&
                    completed.receipt.status === "succeeded"
                      ? acknowledged
                        ? "controlled_stop"
                        : "succeeded"
                      : completed.receipt.status === "timed_out"
                        ? "timed_out"
                        : "failed",
                  startedAt: stopStartedAt,
                  endedAt,
                  hostMonotonicStartUs: stopStart,
                  hostMonotonicEndUs: Math.max(stopStart, stopEnd),
                  exitCode: completed.receipt.exitCode,
                  signal: completed.receipt.signal,
                  views: viewsForManaged(sidecar.diagnostics()),
                  observation: observation({
                    runtime,
                    sample: lastStatus.sample,
                    hostMonotonicUs: lastStatus.hostMonotonicEndUs,
                    now: endedAt,
                  }),
                  cleanup,
                  knownSideEffects: [
                    "controlled shutdown may advance clocks before acknowledgement",
                  ],
                }),
              ],
              cleanup,
            };
          })();
          return stopPromise;
        },
      };
      return session;
    },
  };
};
