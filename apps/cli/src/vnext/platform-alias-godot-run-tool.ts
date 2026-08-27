import { randomUUID } from "node:crypto";

import { z } from "zod";

import type { GodotLifecycleVanillaSmokeDiagnosticV1 } from "@chronorift/godot-protocol";
import {
  createVNextGodotRunToolDefinitionV1,
  type ProjectEnvironmentToolCallAdmissionV1,
  type VNextGodotRunToolPortV1,
} from "@chronorift/pi-harness";

import type { PreparedProjectEnvironmentDebugBuildV1 } from "./candidate-godot-build.js";
import type { ManagedGodotProjectEnvironmentRuntimeCapabilityV1 } from "./managed-godot-project-environment-runtime.js";
import type { ManagedGodotProjectEnvironmentRuntimeCapabilityV2 } from "./managed-godot-project-environment-runtime-v2.js";
import type { GodotProjectEnvironmentSidecarPortV1 } from "./project-environment-sidecar-port.js";
import type { GodotProjectEnvironmentSidecarPortV2 } from "./project-environment-sidecar-port-v2.js";

const OUTPUT_MAX_BYTES = 64 * 1024;
const LIMITS = Object.freeze({
  diagnosticFrameMaxBytes: 64 * 1024,
  diagnosticTotalMaxBytes: 1024 * 1024,
  diagnosticMaxCount: 256,
  outputCaptureMaxBytes: OUTPUT_MAX_BYTES,
  importTimeoutMs: 120_000,
  vanillaTimeoutMs: 10_000,
  stabilityWindowMs: 2_000,
});

const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const ResourceIdSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u)
  .refine((value) => !value.includes(".."));
const StreamReceiptSchema = z
  .object({
    totalBytes: z.number().int().nonnegative(),
    sha256: DigestSchema,
    retainedBytes: z.number().int().min(0).max(OUTPUT_MAX_BYTES),
    truncated: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.retainedBytes > value.totalBytes) {
      context.addIssue({
        code: "custom",
        path: ["retainedBytes"],
        message: "retained bytes must not exceed total bytes",
      });
    }
    if (value.truncated !== value.retainedBytes < value.totalBytes) {
      context.addIssue({
        code: "custom",
        path: ["truncated"],
        message: "truncation must match retained coverage",
      });
    }
  });
const ProcessReceiptSchema = z
  .object({
    exitCode: z.number().int().nullable(),
    signal: z.string().min(1).max(64).nullable(),
    timedOut: z.boolean(),
    durationMs: z.number().int().min(0).max(600_000),
    stdout: StreamReceiptSchema,
    stderr: StreamReceiptSchema,
  })
  .strict();
const BuildIdentitySchema = z
  .object({
    buildId: ResourceIdSchema,
    sourceClosureId: ResourceIdSchema,
    candidateSourceHash: DigestSchema,
  })
  .strict();
const ExecutionReceiptSchema = z
  .object({
    sandboxStatus: z.enum([
      "succeeded",
      "failed",
      "timed_out",
      "cancelled",
      "launch_failed",
    ]),
    sandboxExitCode: z.number().int().nullable(),
    sandboxSignal: z.string().min(1).max(64).nullable(),
    elapsedMonotonicMs: z.number().min(0).max(600_000),
    sourceIdentityReverified: z.boolean(),
    import: ProcessReceiptSchema.nullable(),
    vanilla: ProcessReceiptSchema.nullable(),
  })
  .strict();
const CaptureSchema = z
  .object({
    stdout: z.string().max(OUTPUT_MAX_BYTES),
    stderr: z.string().max(OUTPUT_MAX_BYTES),
    stdoutTruncated: z.boolean(),
    stderrTruncated: z.boolean(),
  })
  .strict();
const ErrorSchema = z
  .object({
    code: z.enum(["prepare_failed", "denied", "execution_failed"]),
    message: z.string().min(1).max(4_096),
    recoverable: z.boolean(),
  })
  .strict();

export const PlatformAliasGodotRunResultV1Schema = z.discriminatedUnion(
  "outcome",
  [
    z
      .object({
        schemaVersion: z.literal(1),
        outcome: z.literal("success"),
        build: BuildIdentitySchema,
        receipt: ExecutionReceiptSchema,
        capture: CaptureSchema,
      })
      .strict(),
    z
      .object({
        schemaVersion: z.literal(1),
        outcome: z.literal("error"),
        error: ErrorSchema,
        build: BuildIdentitySchema.optional(),
        receipt: ExecutionReceiptSchema.optional(),
        capture: CaptureSchema.optional(),
      })
      .strict(),
  ],
);

export const PlatformAliasGodotRunCallV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    toolCallId: z.string().min(1).max(256),
    result: PlatformAliasGodotRunResultV1Schema,
  })
  .strict();
export type PlatformAliasGodotRunCallV1 = z.infer<
  typeof PlatformAliasGodotRunCallV1Schema
>;

type CompletedVanillaResult = Extract<
  Awaited<ReturnType<GodotProjectEnvironmentSidecarPortV1["runVanilla"]>>,
  { readonly kind: "completed" }
>["result"];

const boundedMessage = (value: unknown): string => {
  const raw = value instanceof Error ? value.message : String(value);
  return raw.replace(/[\r\n\0]+/gu, " ").slice(0, 4_096) || "operation failed";
};

const buildIdentity = (prepared: PreparedProjectEnvironmentDebugBuildV1) =>
  BuildIdentitySchema.parse({
    buildId: prepared.build.buildId,
    sourceClosureId: prepared.build.sourceClosureId,
    candidateSourceHash: prepared.build.candidateSourceHash,
  });

const terminalReceipt = (
  diagnostics: readonly GodotLifecycleVanillaSmokeDiagnosticV1[],
): {
  readonly import: z.infer<typeof ProcessReceiptSchema> | null;
  readonly vanilla: z.infer<typeof ProcessReceiptSchema> | null;
} => {
  const terminal = diagnostics.findLast(
    (record) =>
      record.kind === "smoke_complete" || record.kind === "smoke_failed",
  );
  if (
    terminal === undefined ||
    (terminal.kind !== "smoke_complete" && terminal.kind !== "smoke_failed")
  ) {
    return { import: null, vanilla: null };
  }
  return {
    import: ProcessReceiptSchema.parse(terminal.import),
    vanilla:
      terminal.vanilla === null
        ? null
        : ProcessReceiptSchema.parse(terminal.vanilla),
  };
};

const processOutput = (
  diagnostics: readonly GodotLifecycleVanillaSmokeDiagnosticV1[],
  stream: "stdout" | "stderr",
): { readonly text: string; readonly truncated: boolean } => {
  const chunks: Buffer[] = [];
  for (const record of diagnostics) {
    if (record.kind === "process_output" && record.stream === stream) {
      chunks.push(Buffer.from(record.bytesBase64, "base64"));
    }
  }
  const retained = Buffer.concat(chunks);
  const bounded = retained.subarray(0, OUTPUT_MAX_BYTES);
  const terminal = terminalReceipt(diagnostics);
  const receiptTruncated = [terminal.import, terminal.vanilla].some(
    (receipt) => receipt?.[stream].truncated === true,
  );
  return {
    text: new TextDecoder("utf-8").decode(bounded),
    truncated: receiptTruncated || bounded.byteLength < retained.byteLength,
  };
};

const capture = (
  diagnostics: readonly GodotLifecycleVanillaSmokeDiagnosticV1[],
) => {
  const stdout = processOutput(diagnostics, "stdout");
  const stderr = processOutput(diagnostics, "stderr");
  return CaptureSchema.parse({
    stdout: stdout.text,
    stderr: stderr.text,
    stdoutTruncated: stdout.truncated,
    stderrTruncated: stderr.truncated,
  });
};

const executionReceipt = (result: CompletedVanillaResult) => {
  const terminal = terminalReceipt(result.diagnostics);
  const process = result.sandbox.process;
  const status =
    process.process.status === "timed_out"
      ? "timed_out"
      : process.process.status === "cancelled"
        ? "cancelled"
        : process.process.exitCode === 0
          ? "succeeded"
          : "failed";
  return ExecutionReceiptSchema.parse({
    sandboxStatus: status,
    sandboxExitCode: process.process.exitCode,
    sandboxSignal: process.process.signal,
    elapsedMonotonicMs: process.process.durationMs,
    sourceIdentityReverified: process.sourceUnchanged,
    ...terminal,
  });
};

const sidecarFailureMessage = (
  diagnostics: readonly GodotLifecycleVanillaSmokeDiagnosticV1[],
): string => {
  const failure = diagnostics.findLast(
    (record) => record.kind === "sidecar_error",
  );
  return failure?.kind === "sidecar_error"
    ? boundedMessage(failure.message)
    : "Godot did not complete the headless run";
};

export interface PlatformAliasGodotRunToolOptionsV1 {
  readonly sidecar: Pick<GodotProjectEnvironmentSidecarPortV1, "runVanilla">;
  readonly managedRuntime: ManagedGodotProjectEnvironmentRuntimeCapabilityV1;
  readonly taskId: string;
  readonly prepareBuild: () => Promise<PreparedProjectEnvironmentDebugBuildV1>;
  readonly onCall?:
    ((call: PlatformAliasGodotRunCallV1) => void | Promise<void>) | undefined;
  readonly toolCallAdmission?:
    ProjectEnvironmentToolCallAdmissionV1 | undefined;
}

const createPort = (
  options: PlatformAliasGodotRunToolOptionsV1,
): VNextGodotRunToolPortV1 => ({
  async run(signal) {
    let prepared: PreparedProjectEnvironmentDebugBuildV1;
    try {
      prepared = await options.prepareBuild();
    } catch (error) {
      return PlatformAliasGodotRunResultV1Schema.parse({
        schemaVersion: 1,
        outcome: "error",
        error: {
          code: "prepare_failed",
          message: boundedMessage(error),
          recoverable: true,
        },
      });
    }
    const build = buildIdentity(prepared);
    let run: Awaited<ReturnType<typeof options.sidecar.runVanilla>>;
    try {
      const nonce = randomUUID();
      run = await options.sidecar.runVanilla(
        {
          schemaVersion: 1,
          runtimeProfile: "chronorift-managed-godot-project-environment-v1",
          taskId: options.taskId,
          buildId: build.buildId,
          runtimeId: `runtime:godot-run:${nonce}`,
          executionId: `execution:godot-run:${nonce}`,
          managedRuntimeId: options.managedRuntime.managedRuntimeId,
          candidateSourceHash: build.candidateSourceHash,
          diagnosticFrameMaxBytes: LIMITS.diagnosticFrameMaxBytes,
          diagnosticTotalMaxBytes: LIMITS.diagnosticTotalMaxBytes,
          diagnosticMaxCount: LIMITS.diagnosticMaxCount,
          outputCaptureMaxBytes: LIMITS.outputCaptureMaxBytes,
          operation: "vanilla_smoke",
          importTimeoutMs: LIMITS.importTimeoutMs,
          vanillaTimeoutMs: LIMITS.vanillaTimeoutMs,
          stabilityWindowMs: LIMITS.stabilityWindowMs,
        },
        signal,
      );
    } catch (error) {
      return PlatformAliasGodotRunResultV1Schema.parse({
        schemaVersion: 1,
        outcome: "error",
        error: {
          code: "execution_failed",
          message: boundedMessage(error),
          recoverable: true,
        },
        build,
      });
    }
    if (run.kind === "denied") {
      return PlatformAliasGodotRunResultV1Schema.parse({
        schemaVersion: 1,
        outcome: "error",
        error: {
          code: "denied",
          message: "The task sandbox denied the Godot execution",
          recoverable: false,
        },
        build,
      });
    }
    const receipt = executionReceipt(run.result);
    const rawCapture = capture(run.result.diagnostics);
    const completed = run.result.diagnostics.some(
      (record) =>
        record.kind === "smoke_complete" &&
        record.candidateSourceHash === build.candidateSourceHash,
    );
    if (
      run.result.sandbox.process.process.status !== "exited" ||
      run.result.sandbox.process.process.exitCode !== 0 ||
      !completed ||
      !receipt.sourceIdentityReverified
    ) {
      return PlatformAliasGodotRunResultV1Schema.parse({
        schemaVersion: 1,
        outcome: "error",
        error: {
          code: "execution_failed",
          message: sidecarFailureMessage(run.result.diagnostics),
          recoverable: true,
        },
        build,
        receipt,
        capture: rawCapture,
      });
    }
    return PlatformAliasGodotRunResultV1Schema.parse({
      schemaVersion: 1,
      outcome: "success",
      build,
      receipt,
      capture: rawCapture,
    });
  },
});

export const createPlatformAliasGodotRunToolV1 = (
  options: PlatformAliasGodotRunToolOptionsV1,
) => {
  const onCall = options.onCall;
  return createVNextGodotRunToolDefinitionV1(createPort(options), {
    toolCallAdmission: options.toolCallAdmission,
    onCall:
      onCall === undefined
        ? undefined
        : (call) => onCall(PlatformAliasGodotRunCallV1Schema.parse(call)),
  });
};

export interface ProjectEnvironmentGodotRunToolOptionsV2 {
  readonly sidecar: Pick<GodotProjectEnvironmentSidecarPortV2, "runVanilla">;
  readonly managedRuntime: ManagedGodotProjectEnvironmentRuntimeCapabilityV2;
  readonly taskId: string;
  readonly prepareBuild: () => Promise<PreparedProjectEnvironmentDebugBuildV1>;
  readonly onCall?:
    ((call: PlatformAliasGodotRunCallV1) => void | Promise<void>) | undefined;
  readonly toolCallAdmission?:
    ProjectEnvironmentToolCallAdmissionV1 | undefined;
}

const createPortV2 = (
  options: ProjectEnvironmentGodotRunToolOptionsV2,
): VNextGodotRunToolPortV1 => ({
  async run(signal) {
    let prepared: PreparedProjectEnvironmentDebugBuildV1;
    try {
      prepared = await options.prepareBuild();
    } catch (error) {
      return PlatformAliasGodotRunResultV1Schema.parse({
        schemaVersion: 1,
        outcome: "error",
        error: {
          code: "prepare_failed",
          message: boundedMessage(error),
          recoverable: true,
        },
      });
    }
    const build = buildIdentity(prepared);
    let run: Awaited<ReturnType<typeof options.sidecar.runVanilla>>;
    try {
      const nonce = randomUUID();
      run = await options.sidecar.runVanilla(
        {
          schemaVersion: 2,
          runtimeProfile: "chronorift-managed-godot-project-environment-v2",
          taskId: options.taskId,
          buildId: build.buildId,
          runtimeId: `runtime:godot-run:${nonce}`,
          executionId: `execution:godot-run:${nonce}`,
          managedRuntimeId: options.managedRuntime.managedRuntimeId,
          candidateSourceHash: build.candidateSourceHash,
          diagnosticFrameMaxBytes: LIMITS.diagnosticFrameMaxBytes,
          diagnosticTotalMaxBytes: LIMITS.diagnosticTotalMaxBytes,
          diagnosticMaxCount: LIMITS.diagnosticMaxCount,
          outputCaptureMaxBytes: LIMITS.outputCaptureMaxBytes,
          operation: "vanilla_smoke",
          importTimeoutMs: LIMITS.importTimeoutMs,
          vanillaTimeoutMs: LIMITS.vanillaTimeoutMs,
          stabilityWindowMs: LIMITS.stabilityWindowMs,
        },
        signal,
      );
    } catch (error) {
      return PlatformAliasGodotRunResultV1Schema.parse({
        schemaVersion: 1,
        outcome: "error",
        error: {
          code: "execution_failed",
          message: boundedMessage(error),
          recoverable: true,
        },
        build,
      });
    }
    if (run.kind === "denied") {
      return PlatformAliasGodotRunResultV1Schema.parse({
        schemaVersion: 1,
        outcome: "error",
        error: {
          code: "denied",
          message: "The task sandbox denied the Godot execution",
          recoverable: false,
        },
        build,
      });
    }
    const receipt = executionReceipt(run.result);
    const rawCapture = capture(run.result.diagnostics);
    const completed = run.result.diagnostics.some(
      (record) =>
        record.kind === "smoke_complete" &&
        record.candidateSourceHash === build.candidateSourceHash,
    );
    if (
      run.result.sandbox.process.process.status !== "exited" ||
      run.result.sandbox.process.process.exitCode !== 0 ||
      !completed ||
      !receipt.sourceIdentityReverified
    ) {
      return PlatformAliasGodotRunResultV1Schema.parse({
        schemaVersion: 1,
        outcome: "error",
        error: {
          code: "execution_failed",
          message: sidecarFailureMessage(run.result.diagnostics),
          recoverable: true,
        },
        build,
        receipt,
        capture: rawCapture,
      });
    }
    return PlatformAliasGodotRunResultV1Schema.parse({
      schemaVersion: 1,
      outcome: "success",
      build,
      receipt,
      capture: rawCapture,
    });
  },
});

export const createProjectEnvironmentGodotRunToolV2 = (
  options: ProjectEnvironmentGodotRunToolOptionsV2,
) =>
  createVNextGodotRunToolDefinitionV1(createPortV2(options), {
    toolCallAdmission: options.toolCallAdmission,
    onCall:
      options.onCall === undefined
        ? undefined
        : (call) =>
            options.onCall?.(PlatformAliasGodotRunCallV1Schema.parse(call)),
  });
