import { createHash } from "node:crypto";

import {
  validateProjectEnvironmentGameToolInputV1,
  validateProjectEnvironmentGameToolOutputV1,
  type ProjectEnvironmentGameCapturePinInputV1,
  type ProjectEnvironmentGameCapturePinOutputV1,
  type ProjectEnvironmentGameLaunchInputV1,
  type ProjectEnvironmentGameLaunchOutputV1,
  type ProjectEnvironmentGameQueryInputV1,
  type ProjectEnvironmentGameQueryOutputV1,
  type ProjectEnvironmentGameStopInputV1,
  type ProjectEnvironmentGameStopOutputV1,
} from "@chronorift/agent-protocol";
import {
  ExecutionIdSchema,
  JsonValueSchema,
  ProjectAdapterRevisionV1Schema,
  ProjectEnvironmentPinnedCaptureV1Schema,
  ProjectEnvironmentRuntimeObservationReceiptV1Schema,
  Sha256DigestV1Schema,
  TaskIdSchema,
  VNextBuildV1Schema,
  asSha256DigestV1,
  projectRuntimeCleanupCompleteV1,
  type JsonValue,
  type Sha256DigestV1,
  type VNextBuildV1,
} from "@chronorift/domain";
import {
  GodotProjectEnvironmentFingerprintV1Schema,
  GodotProjectEnvironmentObservationRecordV1Schema,
} from "@chronorift/godot-protocol";
import {
  canonicalJson,
  projectEnvironmentPackageContentDigestV1,
} from "@chronorift/json-artifacts";
import { z } from "zod";

import {
  M7PatrolEntityStateV1Schema,
  M7PatrolStateTimelineV1Schema,
  M7_PATROL_SCENARIO_PLAN_V1,
  createM7PatrolPreflightResultV1,
  type M7PatrolPreflightRunReceiptV1,
  type M7PatrolStateTimelineV1,
  type M7PatrolScenarioV1,
} from "./m7-patrol-sensor.js";
import {
  SandboxCleanupReceiptV1Schema,
  SecurityEventV1Schema,
  type SandboxCleanupReceiptV1,
  type SecurityEventV1,
} from "./contracts.js";
import {
  M7R3CaseConstructionReceiptV1Schema,
  M7R3CasePreflightReceiptV1Schema,
  M7R3TrajectoryClassifierFreezeV1Schema,
  createM7R3CasePreflightReceiptV1,
  projectM7R3ClassifierFreezeToPortfolioV1,
  projectM7R3ConstructionToPortfolioCaseV1,
  type CreateM7R3PublicTrajectoryPreflightObservationV1Input,
  type M7R3CaseConstructionReceiptV1,
  type M7R3CasePreflightReceiptV1,
  type M7R3EvaluatorFreshRunInputV1,
  type M7R3TrajectoryClassifierFreezeV1,
} from "./m7-r3-case-construction.js";
import {
  M7R3TwoCasePortfolioFreezeV1Schema,
  type M7R3TwoCasePortfolioFreezeV1,
} from "./m7-r3-two-case-portfolio.js";

const timestampSchema = z.string().datetime({ offset: true });
const subjectSchema = z.enum(["pristine", "mutant"]);
const opaqueIdentitySchema = z
  .string()
  .min(1)
  .max(16_384)
  .refine((value) => !value.includes("\0"), "identity cannot contain NUL");
const configuredMainSceneSchema = z
  .string()
  .min(7)
  .max(2_048)
  .regex(/^res:\/\/[A-Za-z0-9_./ -]+\.(?:tscn|scn)$/u)
  .refine((value) => !value.includes(".."));

const adapterPackageIdentitySchema = z
  .object({
    schemaVersion: z.literal(1),
    packageSha256: Sha256DigestV1Schema,
    manifestSha256: Sha256DigestV1Schema,
    implementationSha256: Sha256DigestV1Schema,
    observationSchemaSha256: Sha256DigestV1Schema,
    adapterId: ProjectAdapterRevisionV1Schema.shape.adapterId,
    contentByteLength: z.number().int().positive(),
    contentFileCount: z.number().int().positive(),
  })
  .strict();

/**
 * Host-derived seal over the exact record bytes reopened from pinned captures.
 * This is deliberately not represented as a native RuntimeStore execution
 * seal: the no-Agent PE path persists immutable capture packages instead of a
 * vNext RuntimeStore event ledger.
 */
const hostDerivedCaptureRecordSealSchema = z
  .object({
    schemaVersion: z.literal(1),
    sealKind: z.literal("host_derived_pinned_capture_records"),
    taskId: TaskIdSchema,
    executionId: ExecutionIdSchema,
    count: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    headHash: Sha256DigestV1Schema.nullable(),
    byteLength: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    contentHash: Sha256DigestV1Schema,
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.count === 0) !== (value.headHash === null)) {
      context.addIssue({
        code: "custom",
        path: ["headHash"],
        message:
          "capture-record seal head presence must agree with its record count",
      });
    }
  });

export type M7R3HostDerivedCaptureRecordSealV1 = z.infer<
  typeof hostDerivedCaptureRecordSealSchema
>;

/**
 * Derives a reproducible integrity summary from exact pinned-capture record
 * bytes. It does not claim that a vNext RuntimeStore event ledger existed.
 */
export const createM7R3HostDerivedCaptureRecordSealV1 = (input: {
  readonly taskId: string;
  readonly executionId: string;
  readonly records: readonly unknown[];
}): M7R3HostDerivedCaptureRecordSealV1 => {
  if (input.records.length === 0) {
    throw new Error("M7 R3 cannot seal an empty pinned-capture record set");
  }
  const records = input.records.map((record) => JsonValueSchema.parse(record));
  const chunks = records.map((record) =>
    Buffer.from(`${canonicalJson(record)}\n`, "utf8"),
  );
  let headHash: Sha256DigestV1 | null = null;
  for (const chunk of chunks) {
    const hash = createHash("sha256").update(
      "m7-r3-preflight-capture-record-v1\0",
    );
    if (headHash !== null) hash.update(headHash);
    headHash = asSha256DigestV1(hash.update("\0").update(chunk).digest("hex"));
  }
  const bytes = Buffer.concat(chunks);
  return hostDerivedCaptureRecordSealSchema.parse({
    schemaVersion: 1,
    sealKind: "host_derived_pinned_capture_records",
    taskId: input.taskId,
    executionId: input.executionId,
    count: records.length,
    headHash,
    byteLength: bytes.byteLength,
    contentHash: asSha256DigestV1(
      createHash("sha256").update(bytes).digest("hex"),
    ),
  });
};

const hiddenEvaluatorResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    subject: subjectSchema,
    scenarioId: z.string().regex(/^m7-scenario:[a-z_]+:[1-3]$/u),
    observation: z.enum([
      "expected_motion_observed",
      "expected_motion_not_observed",
      "infrastructure_failure",
    ]),
    observationReceipt: JsonValueSchema.nullable(),
    workspace: z
      .object({
        created: z.boolean(),
        identity: opaqueIdentitySchema,
        creationReceipt: JsonValueSchema,
      })
      .strict(),
    importCache: z
      .object({
        created: z.boolean(),
        identity: opaqueIdentitySchema,
        creationReceipt: JsonValueSchema,
      })
      .strict(),
    process: z
      .object({
        started: z.boolean(),
        identity: opaqueIdentitySchema,
        startReceipt: JsonValueSchema,
      })
      .strict(),
    cleanup: z
      .object({
        proven: z.boolean(),
        receipt: JsonValueSchema,
      })
      .strict(),
    agentLaunchCount: z.literal(0),
    providerInvocationCount: z.literal(0),
    piSessionCount: z.literal(0),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.observation === "infrastructure_failure") !==
      (value.observationReceipt === null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["observationReceipt"],
        message:
          "only an infrastructure failure may omit the evaluator observation receipt",
      });
    }
  });

type Subject = z.infer<typeof subjectSchema>;
type CaseOrdinal = 1 | 2;
type HiddenEvaluatorResult = z.infer<typeof hiddenEvaluatorResultSchema>;

const digestJson = (value: unknown): Sha256DigestV1 =>
  asSha256DigestV1(
    createHash("sha256")
      .update(canonicalJson(JsonValueSchema.parse(value)))
      .digest("hex"),
  );

const sameJson = (left: unknown, right: unknown): boolean =>
  canonicalJson(JsonValueSchema.parse(left)) ===
  canonicalJson(JsonValueSchema.parse(right));

const asRecord = (value: unknown): Readonly<Record<string, unknown>> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;

export const M7_R3_PREFLIGHT_API_BLOCKER_CODES_V1 = [
  "invalid_frozen_inputs",
  "project_environment_port_failed",
  "invalid_project_environment_evidence",
  "configured_main_scene_not_observed",
  "project_environment_lineage_mismatch",
  "pinned_capture_content_mismatch",
  "patrol_motion_payload_invalid",
  "patrol_motion_query_capture_conflict",
  "patrol_motion_timeline_unavailable",
  "public_observation_cleanup_not_proven",
  "hidden_evaluator_port_failed",
  "invalid_hidden_evaluator_evidence",
  "preflight_persistence_failed",
  "preflight_persistence_substitution",
  "preflight_evidence_persistence_failed",
  "preflight_evidence_persistence_substitution",
] as const;

export type M7R3PreflightApiBlockerCodeV1 =
  (typeof M7_R3_PREFLIGHT_API_BLOCKER_CODES_V1)[number];

/**
 * A path-free orchestration blocker. The underlying exception is retained as
 * `cause` for the Host, but its possibly sensitive message is never copied to
 * the public error text or a preflight receipt.
 */
export class M7R3PreflightApiBlockerErrorV1 extends Error {
  public override readonly name = "M7R3PreflightApiBlockerErrorV1";

  public constructor(
    public readonly code: M7R3PreflightApiBlockerCodeV1,
    public readonly ordinal: CaseOrdinal | null,
    public readonly subject: Subject | null,
    options?: ErrorOptions,
  ) {
    super(
      `M7 R3 no-Agent preflight blocked: ${code} (case ${ordinal ?? "none"}, subject ${subject ?? "none"})`,
      options,
    );
  }
}

const blocked = (
  code: M7R3PreflightApiBlockerCodeV1,
  ordinal: CaseOrdinal | null,
  subject: Subject | null,
  cause?: unknown,
): never => {
  throw new M7R3PreflightApiBlockerErrorV1(code, ordinal, subject, {
    ...(cause === undefined ? {} : { cause }),
  });
};

export interface M7R3NoAgentPublicObservationRequestV1 {
  readonly schemaVersion: 1;
  readonly ordinal: 1 | 2;
  readonly caseId: string;
  readonly subject: "pristine" | "mutant";
  readonly buildRole: "pristine_control" | "assignment_baseline";
  readonly expectedSource: {
    readonly sourceId: string;
    readonly sourceSha256: Sha256DigestV1;
    readonly selectedTreeSha256: Sha256DigestV1;
    readonly buildId: string | null;
  };
  readonly configuredMainScene: string;
}

export interface M7R3NoAgentProjectEnvironmentObservationV1 {
  readonly schemaVersion: 1;
  readonly configuredMainScene: string;
  readonly build: unknown;
  readonly selectedTreeSha256: string;
  readonly adapterRevision: unknown;
  readonly adapterPackageIdentity: unknown;
  readonly fingerprint: unknown;
  readonly launch: {
    readonly input: unknown;
    readonly output: unknown;
  };
  readonly stateQueries: readonly {
    readonly input: unknown;
    readonly output: unknown;
  }[];
  readonly capturePins: readonly {
    readonly input: unknown;
    readonly output: unknown;
  }[];
  readonly pinnedCaptures: readonly {
    readonly manifest: unknown;
    readonly records: readonly unknown[];
  }[];
  readonly stop: {
    readonly input: unknown;
    readonly output: unknown;
  };
  readonly runtimeObservationReceipt: unknown;
  readonly taskCleanupReceipt: unknown;
  readonly taskCleanupReceiptSha256: unknown;
  readonly sandboxSecurityEvents: readonly unknown[];
  readonly sandboxSecurityEventsSha256: unknown;
  readonly captureRecordSeal: unknown;
  readonly agentLaunchCount: number;
  readonly providerInvocationCount: number;
  readonly piSessionCount: number;
}

/** High-level Host port; implementations invoke only ordinary PE operations. */
export interface M7R3NoAgentProjectEnvironmentPreflightPortV1 {
  observeConfiguredMainScene(
    request: M7R3NoAgentPublicObservationRequestV1,
  ): Promise<unknown>;
}

export interface M7R3HiddenEvaluatorPreflightRequestV1 {
  readonly schemaVersion: 1;
  readonly ordinal: 1 | 2;
  readonly caseId: string;
  readonly subject: "pristine" | "mutant";
  readonly scenario: M7PatrolScenarioV1;
  readonly source: {
    readonly sourceId: string;
    readonly sourceSha256: Sha256DigestV1;
    readonly selectedTreeSha256: Sha256DigestV1;
  };
  readonly evaluatorImplementationSha256: Sha256DigestV1;
  readonly evaluatorBundleSha256: Sha256DigestV1;
}

/** The port owns evaluator invocation; this runner never interprets game rules. */
export interface M7R3HiddenEvaluatorPreflightPortV1 {
  runFresh(request: M7R3HiddenEvaluatorPreflightRequestV1): Promise<unknown>;
}

/** A write-once port must return the exact record read back from Host storage. */
export interface M7R3CasePreflightPersistencePortV1 {
  persistPreflightOnce(receipt: M7R3CasePreflightReceiptV1): Promise<unknown>;
}

const preflightEvidenceBasisSchema = z
  .object({
    schemaVersion: z.literal(1),
    recordKind: z.literal("m7-r3-case-preflight-evidence"),
    evidenceKind: z.enum(["public_observation", "hidden_evaluator_run"]),
    ordinal: z.union([z.literal(1), z.literal(2)]),
    caseId: z.string().min(1).max(256),
    subject: subjectSchema,
    scenarioId: z.string().min(1).max(256).nullable(),
    request: JsonValueSchema,
    evidence: JsonValueSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.evidenceKind === "hidden_evaluator_run") !==
      (value.scenarioId !== null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["scenarioId"],
        message: "only hidden evaluator evidence has a scenario ID",
      });
    }
  });

export const M7R3CasePreflightEvidenceRecordV1Schema =
  preflightEvidenceBasisSchema
    .extend({ recordContentSha256: Sha256DigestV1Schema })
    .strict()
    .superRefine((value, context) => {
      const { recordContentSha256, ...basis } = value;
      if (recordContentSha256 !== digestJson(basis)) {
        context.addIssue({
          code: "custom",
          path: ["recordContentSha256"],
          message: "preflight evidence content hash does not match",
        });
      }
    });
export type M7R3CasePreflightEvidenceRecordV1 = z.infer<
  typeof M7R3CasePreflightEvidenceRecordV1Schema
>;

export interface M7R3CasePreflightEvidencePersistencePortV1 {
  persistEvidenceOnce(
    evidence: M7R3CasePreflightEvidenceRecordV1,
  ): Promise<unknown>;
}

export interface M7R3CasePreflightHostPortsV1 {
  readonly ordinal: 1 | 2;
  readonly configuredMainScene: string;
  readonly projectEnvironment: M7R3NoAgentProjectEnvironmentPreflightPortV1;
  readonly hiddenEvaluator: M7R3HiddenEvaluatorPreflightPortV1;
  readonly persistence: M7R3CasePreflightPersistencePortV1;
  /** Optional for historical callers; R7 formal composition requires it. */
  readonly evidencePersistence?:
    M7R3CasePreflightEvidencePersistencePortV1 | undefined;
}

export interface RunM7R3TwoCasePreflightV1Input {
  readonly trajectoryClassifierFreeze: unknown;
  readonly constructionReceipts: readonly [unknown, unknown];
  readonly portfolioFreeze: unknown;
  readonly cases: readonly [
    M7R3CasePreflightHostPortsV1,
    M7R3CasePreflightHostPortsV1,
  ];
  readonly now: () => string;
}

export interface M7R3TwoCasePreflightCompletedV1 {
  readonly schemaVersion: 1;
  readonly status: "completed";
  readonly agentLaunchCount: 0;
  readonly providerInvocationCount: 0;
  readonly piSessionCount: 0;
  readonly receipts: readonly [
    M7R3CasePreflightReceiptV1,
    M7R3CasePreflightReceiptV1,
  ];
}

export interface M7R3TwoCasePreflightSafetyStoppedV1 {
  readonly schemaVersion: 1;
  readonly status: "safety_stopped";
  readonly reason: "hidden_evaluator_cleanup_not_proven";
  readonly stoppedAfter: {
    readonly ordinal: 1 | 2;
    readonly subject: "pristine" | "mutant";
    readonly scenarioId: string;
  };
  readonly agentLaunchCount: 0;
  readonly providerInvocationCount: 0;
  readonly piSessionCount: 0;
  readonly receipts: readonly M7R3CasePreflightReceiptV1[];
}

export type M7R3TwoCasePreflightRunResultV1 =
  M7R3TwoCasePreflightCompletedV1 | M7R3TwoCasePreflightSafetyStoppedV1;

interface ParsedPublicEvidence {
  readonly configuredMainScene: string;
  readonly build: VNextBuildV1;
  readonly selectedTreeSha256: Sha256DigestV1;
  readonly adapterRevision: z.infer<typeof ProjectAdapterRevisionV1Schema>;
  readonly adapterPackageIdentity: z.infer<typeof adapterPackageIdentitySchema>;
  readonly fingerprint: z.infer<
    typeof GodotProjectEnvironmentFingerprintV1Schema
  >;
  readonly launch: {
    readonly input: ProjectEnvironmentGameLaunchInputV1;
    readonly output: ProjectEnvironmentGameLaunchOutputV1;
  };
  readonly stateQueries: readonly {
    readonly input: ProjectEnvironmentGameQueryInputV1;
    readonly output: ProjectEnvironmentGameQueryOutputV1;
  }[];
  readonly capturePins: readonly {
    readonly input: ProjectEnvironmentGameCapturePinInputV1;
    readonly output: ProjectEnvironmentGameCapturePinOutputV1;
  }[];
  readonly pinnedCaptures: readonly {
    readonly manifest: z.infer<typeof ProjectEnvironmentPinnedCaptureV1Schema>;
    readonly records: readonly JsonValue[];
  }[];
  readonly stop: {
    readonly input: ProjectEnvironmentGameStopInputV1;
    readonly output: ProjectEnvironmentGameStopOutputV1;
  };
  readonly runtimeObservationReceipt: z.infer<
    typeof ProjectEnvironmentRuntimeObservationReceiptV1Schema
  >;
  readonly taskCleanupReceipt: SandboxCleanupReceiptV1;
  readonly taskCleanupReceiptSha256: Sha256DigestV1;
  readonly sandboxSecurityEvents: readonly SecurityEventV1[];
  readonly sandboxSecurityEventsSha256: Sha256DigestV1;
  readonly captureRecordSeal: z.infer<
    typeof hostDerivedCaptureRecordSealSchema
  >;
}

const parseToolCall = <
  Name extends "game_launch" | "game_query" | "game_capture_pin" | "game_stop",
  Input,
  Output,
>(
  toolName: Name,
  input: unknown,
  output: unknown,
  ordinal: CaseOrdinal,
  subject: Subject,
): { readonly input: Input; readonly output: Output } => {
  if (
    !validateProjectEnvironmentGameToolInputV1(toolName, input) ||
    !validateProjectEnvironmentGameToolOutputV1(toolName, output)
  ) {
    return blocked("invalid_project_environment_evidence", ordinal, subject);
  }
  return { input: input as Input, output: output as Output };
};

const parsePublicEvidence = (
  raw: unknown,
  ordinal: CaseOrdinal,
  subject: Subject,
): ParsedPublicEvidence => {
  const record = asRecord(raw);
  if (
    record === null ||
    record.schemaVersion !== 1 ||
    record.agentLaunchCount !== 0 ||
    record.providerInvocationCount !== 0 ||
    record.piSessionCount !== 0 ||
    typeof record.configuredMainScene !== "string" ||
    !Array.isArray(record.stateQueries) ||
    record.stateQueries.length < 1 ||
    !Array.isArray(record.capturePins) ||
    record.capturePins.length < 1 ||
    !Array.isArray(record.pinnedCaptures) ||
    record.pinnedCaptures.length < 1
  ) {
    return blocked("invalid_project_environment_evidence", ordinal, subject);
  }
  try {
    const launchRecord = asRecord(record.launch);
    const stopRecord = asRecord(record.stop);
    if (launchRecord === null || stopRecord === null) {
      return blocked("invalid_project_environment_evidence", ordinal, subject);
    }
    const launch = parseToolCall<
      "game_launch",
      ProjectEnvironmentGameLaunchInputV1,
      ProjectEnvironmentGameLaunchOutputV1
    >("game_launch", launchRecord.input, launchRecord.output, ordinal, subject);
    const stop = parseToolCall<
      "game_stop",
      ProjectEnvironmentGameStopInputV1,
      ProjectEnvironmentGameStopOutputV1
    >("game_stop", stopRecord.input, stopRecord.output, ordinal, subject);
    const stateQueries = record.stateQueries.map((entry) => {
      const call = asRecord(entry);
      if (call === null) {
        return blocked(
          "invalid_project_environment_evidence",
          ordinal,
          subject,
        );
      }
      return parseToolCall<
        "game_query",
        ProjectEnvironmentGameQueryInputV1,
        ProjectEnvironmentGameQueryOutputV1
      >("game_query", call.input, call.output, ordinal, subject);
    });
    const capturePins = record.capturePins.map((entry) => {
      const call = asRecord(entry);
      if (call === null) {
        return blocked(
          "invalid_project_environment_evidence",
          ordinal,
          subject,
        );
      }
      return parseToolCall<
        "game_capture_pin",
        ProjectEnvironmentGameCapturePinInputV1,
        ProjectEnvironmentGameCapturePinOutputV1
      >("game_capture_pin", call.input, call.output, ordinal, subject);
    });
    const pinnedCaptures = record.pinnedCaptures.map((entry) => {
      const capture = asRecord(entry);
      if (capture === null || !Array.isArray(capture.records)) {
        return blocked(
          "invalid_project_environment_evidence",
          ordinal,
          subject,
        );
      }
      return {
        manifest: ProjectEnvironmentPinnedCaptureV1Schema.parse(
          capture.manifest,
        ),
        records: capture.records.map((value) => JsonValueSchema.parse(value)),
      };
    });
    return {
      configuredMainScene: configuredMainSceneSchema.parse(
        record.configuredMainScene,
      ),
      build: VNextBuildV1Schema.parse(record.build),
      selectedTreeSha256: Sha256DigestV1Schema.parse(record.selectedTreeSha256),
      adapterRevision: ProjectAdapterRevisionV1Schema.parse(
        record.adapterRevision,
      ),
      adapterPackageIdentity: adapterPackageIdentitySchema.parse(
        record.adapterPackageIdentity,
      ),
      fingerprint: GodotProjectEnvironmentFingerprintV1Schema.parse(
        record.fingerprint,
      ),
      launch,
      stateQueries,
      capturePins,
      pinnedCaptures,
      stop,
      runtimeObservationReceipt:
        ProjectEnvironmentRuntimeObservationReceiptV1Schema.parse(
          record.runtimeObservationReceipt,
        ),
      taskCleanupReceipt: SandboxCleanupReceiptV1Schema.parse(
        record.taskCleanupReceipt,
      ),
      taskCleanupReceiptSha256: Sha256DigestV1Schema.parse(
        record.taskCleanupReceiptSha256,
      ),
      sandboxSecurityEvents: z
        .array(SecurityEventV1Schema)
        .max(1_000)
        .parse(record.sandboxSecurityEvents),
      sandboxSecurityEventsSha256: Sha256DigestV1Schema.parse(
        record.sandboxSecurityEventsSha256,
      ),
      captureRecordSeal: hostDerivedCaptureRecordSealSchema.parse(
        record.captureRecordSeal,
      ),
    };
  } catch (error) {
    if (error instanceof M7R3PreflightApiBlockerErrorV1) throw error;
    return blocked(
      "invalid_project_environment_evidence",
      ordinal,
      subject,
      error,
    );
  }
};

interface PatrolSample {
  readonly sequence: number;
  readonly entities: z.infer<typeof M7PatrolEntityStateV1Schema>[];
  readonly canonical: string;
}

const collectPatrolSamples = (
  records: readonly unknown[],
  ordinal: CaseOrdinal,
  subject: Subject,
): ReadonlyMap<number, PatrolSample> => {
  const samples = new Map<number, PatrolSample>();
  for (const raw of records) {
    let record: z.infer<
      typeof GodotProjectEnvironmentObservationRecordV1Schema
    >;
    try {
      record = GodotProjectEnvironmentObservationRecordV1Schema.parse(raw);
    } catch (error) {
      return blocked("patrol_motion_payload_invalid", ordinal, subject, error);
    }
    if (
      record.kind !== "state_sample" ||
      record.payload.stateDomainId !== "patrol.motion"
    ) {
      continue;
    }
    if (record.payload.semanticCoverage !== "declared") {
      return blocked("patrol_motion_payload_invalid", ordinal, subject);
    }
    const value = z
      .object({
        agents: z.array(M7PatrolEntityStateV1Schema).min(1).max(4_096),
      })
      .strict()
      .safeParse(record.payload.value);
    if (!value.success) {
      return blocked(
        "patrol_motion_payload_invalid",
        ordinal,
        subject,
        value.error,
      );
    }
    const canonical = canonicalJson(
      JsonValueSchema.parse({
        recordSequence: record.recordSequence,
        entities: value.data.agents,
      }),
    );
    const prior = samples.get(record.recordSequence);
    if (prior !== undefined && prior.canonical !== canonical) {
      return blocked("patrol_motion_query_capture_conflict", ordinal, subject);
    }
    samples.set(record.recordSequence, {
      sequence: record.recordSequence,
      entities: value.data.agents,
      canonical,
    });
    if (samples.size > 100_000) {
      return blocked("patrol_motion_timeline_unavailable", ordinal, subject);
    }
  }
  return samples;
};

const timelineFromExactQueryAndCapture = (
  evidence: ParsedPublicEvidence,
  ordinal: CaseOrdinal,
  subject: Subject,
): M7PatrolStateTimelineV1 => {
  const queryRecords = evidence.stateQueries.flatMap(({ input, output }) => {
    if (
      input.select !== "state" ||
      output.nextCursor !== null ||
      output.rows.some((row) => row.kind !== "state")
    ) {
      return blocked("invalid_project_environment_evidence", ordinal, subject);
    }
    return output.rows.map((row) => row.value);
  });
  const captureRecords = evidence.pinnedCaptures.flatMap(
    (capture) => capture.records,
  );
  const queried = collectPatrolSamples(queryRecords, ordinal, subject);
  const captured = collectPatrolSamples(captureRecords, ordinal, subject);
  for (const sample of queried.values()) {
    const capture = captured.get(sample.sequence);
    if (capture !== undefined && capture.canonical !== sample.canonical) {
      return blocked("patrol_motion_query_capture_conflict", ordinal, subject);
    }
  }
  // game_query and the later zero-window game_capture_pin consume successive
  // transport batches. The query rows are the Agent-visible trajectory; the
  // pinned batch is independently retained and lineage-checked above.
  const visible = [...queried.values()].sort(
    (left, right) => left.sequence - right.sequence,
  );
  if (visible.length < 2 || captured.size < 1) {
    return blocked("patrol_motion_timeline_unavailable", ordinal, subject);
  }
  try {
    return M7PatrolStateTimelineV1Schema.parse({
      schemaVersion: 1,
      execution_id: evidence.runtimeObservationReceipt.executionId,
      frames: visible.map((sample) => ({
        sample_ordinal: sample.sequence,
        entities: sample.entities,
      })),
    });
  } catch (error) {
    return blocked(
      "patrol_motion_timeline_unavailable",
      ordinal,
      subject,
      error,
    );
  }
};

const completeCoverage = (coverage: readonly unknown[]): boolean =>
  coverage.every((raw) => {
    const value = asRecord(raw);
    return (
      value !== null &&
      value.status === "complete" &&
      typeof value.observedRecords === "number" &&
      value.observedRecords > 0 &&
      value.droppedRecords === 0 &&
      value.overwrittenRecords === 0
    );
  });

const publicObservationInput = (input: {
  readonly ordinal: CaseOrdinal;
  readonly subject: Subject;
  readonly request: M7R3NoAgentPublicObservationRequestV1;
  readonly evidence: ParsedPublicEvidence;
  readonly classifierFreeze: M7R3TrajectoryClassifierFreezeV1;
}): CreateM7R3PublicTrajectoryPreflightObservationV1Input => {
  const { ordinal, subject, request, evidence, classifierFreeze } = input;
  const runtime = evidence.runtimeObservationReceipt;
  const identity = evidence.fingerprint.identity;
  const expectedBuildId = request.expectedSource.buildId;
  const launch = evidence.launch;
  const stop = evidence.stop;
  const queryRowCount = evidence.stateQueries.reduce(
    (count, query) => count + query.output.rows.length,
    0,
  );
  const captureIds = evidence.pinnedCaptures.map(
    (capture) => capture.manifest.captureWindowId,
  );
  let expectedCaptureRecordSeal: M7R3HostDerivedCaptureRecordSealV1;
  try {
    expectedCaptureRecordSeal = createM7R3HostDerivedCaptureRecordSealV1({
      taskId: runtime.taskId,
      executionId: runtime.executionId,
      records: evidence.pinnedCaptures.flatMap((capture) => capture.records),
    });
  } catch (error) {
    return blocked("pinned_capture_content_mismatch", ordinal, subject, error);
  }
  const pinIds = evidence.capturePins.map(
    (capture) => capture.output.captureWindowId,
  );
  const sameCaptureIds =
    new Set(captureIds).size === captureIds.length &&
    new Set(pinIds).size === pinIds.length &&
    sameJson([...captureIds].sort(), [...pinIds].sort()) &&
    sameJson([...captureIds].sort(), [...runtime.captureWindowIds].sort());
  const expectedAdapter = classifierFreeze.authoritativeAdapter;
  if (!sameJson(evidence.captureRecordSeal, expectedCaptureRecordSeal)) {
    return blocked("pinned_capture_content_mismatch", ordinal, subject);
  }
  if (
    evidence.taskCleanupReceiptSha256 !==
      digestJson(evidence.taskCleanupReceipt) ||
    !evidence.taskCleanupReceipt.processGroupTerminated ||
    evidence.taskCleanupReceipt.cgroupPopulated ||
    !evidence.taskCleanupReceipt.scopeRemoved ||
    evidence.taskCleanupReceipt.storageReconciled !== true
  ) {
    return blocked("public_observation_cleanup_not_proven", ordinal, subject);
  }
  if (
    evidence.sandboxSecurityEventsSha256 !==
      digestJson(evidence.sandboxSecurityEvents) ||
    new Set(evidence.sandboxSecurityEvents.map((event) => event.eventId))
      .size !== evidence.sandboxSecurityEvents.length ||
    evidence.sandboxSecurityEvents.some(
      (event) => event.taskId !== runtime.taskId,
    )
  ) {
    return blocked("invalid_project_environment_evidence", ordinal, subject);
  }
  if (evidence.sandboxSecurityEvents.length !== 0) {
    return blocked("project_environment_port_failed", ordinal, subject);
  }
  const revision = evidence.adapterRevision;
  const packageIdentity = evidence.adapterPackageIdentity;
  const adapterIdentityMatches =
    digestJson(revision) === expectedAdapter.adapterRevisionRecordSha256 &&
    revision.adapterRevisionId === expectedAdapter.adapterRevisionId &&
    revision.adapterId === expectedAdapter.adapterId &&
    revision.sourceId === expectedAdapter.pristineSourceId &&
    revision.packageDigest === expectedAdapter.packageSha256 &&
    revision.manifestDigest === expectedAdapter.manifestSha256 &&
    revision.implementationDigest === expectedAdapter.implementationSha256 &&
    revision.payloadSchemaDigest === expectedAdapter.observationSchemaSha256 &&
    revision.sdkDigest === expectedAdapter.sdkSha256 &&
    revision.bridgeDigest === expectedAdapter.bridgeSha256 &&
    revision.conformanceReceiptId ===
      expectedAdapter.pristineConformanceReceiptId &&
    packageIdentity.packageSha256 === expectedAdapter.packageSha256 &&
    packageIdentity.manifestSha256 === expectedAdapter.manifestSha256 &&
    packageIdentity.implementationSha256 ===
      expectedAdapter.implementationSha256 &&
    packageIdentity.observationSchemaSha256 ===
      expectedAdapter.observationSchemaSha256 &&
    packageIdentity.adapterId === expectedAdapter.adapterId &&
    packageIdentity.contentByteLength === revision.contentByteLength &&
    packageIdentity.contentFileCount === revision.contentFileCount;
  const lineageMatches =
    adapterIdentityMatches &&
    evidence.configuredMainScene === request.configuredMainScene &&
    evidence.fingerprint.configuredMainScene === request.configuredMainScene &&
    evidence.build.sourceId === request.expectedSource.sourceId &&
    evidence.build.sourceHash === request.expectedSource.sourceSha256 &&
    evidence.selectedTreeSha256 === request.expectedSource.selectedTreeSha256 &&
    (expectedBuildId === null || evidence.build.buildId === expectedBuildId) &&
    evidence.build.taskId === runtime.taskId &&
    evidence.build.buildId === runtime.buildId &&
    identity.taskId === runtime.taskId &&
    identity.sourceClosureId === evidence.build.sourceId &&
    identity.runtimeId === runtime.runtimeId &&
    identity.executionId === runtime.executionId &&
    identity.buildId === runtime.buildId &&
    identity.candidateSourceHash === evidence.build.sourceHash &&
    identity.environmentRevisionId === runtime.environmentRevisionId &&
    identity.adapterRevisionId === runtime.adapterRevisionId &&
    identity.instrumentationMode === "instrumented" &&
    identity.adapterManifestSha256 === expectedAdapter.manifestSha256 &&
    identity.sdkSha256 === expectedAdapter.sdkSha256 &&
    identity.bridgeSha256 === expectedAdapter.bridgeSha256 &&
    runtime.adapterRevisionId === expectedAdapter.adapterRevisionId &&
    launch.input.taskId === runtime.taskId &&
    launch.input.buildId === runtime.buildId &&
    launch.output.taskId === runtime.taskId &&
    launch.output.runtimeId === runtime.runtimeId &&
    launch.output.executionId === runtime.executionId &&
    launch.output.buildId === runtime.buildId &&
    launch.output.environmentRevisionId === runtime.environmentRevisionId &&
    launch.output.adapterRevisionId === runtime.adapterRevisionId &&
    launch.output.requested.launchTargetId === launch.input.launchTargetId &&
    launch.output.realized.launchTargetId === launch.input.launchTargetId &&
    runtime.launchTargetId === launch.input.launchTargetId &&
    stop.input.taskId === runtime.taskId &&
    stop.input.runtimeId === runtime.runtimeId &&
    stop.output.taskId === runtime.taskId &&
    stop.output.runtimeId === runtime.runtimeId &&
    stop.output.executionId === runtime.executionId &&
    evidence.captureRecordSeal.taskId === runtime.taskId &&
    evidence.captureRecordSeal.executionId === runtime.executionId &&
    evidence.captureRecordSeal.count > 0 &&
    evidence.stateQueries.every(
      (query) =>
        query.input.taskId === runtime.taskId &&
        query.input.executionId === runtime.executionId &&
        query.output.taskId === runtime.taskId &&
        query.output.executionId === runtime.executionId,
    ) &&
    evidence.capturePins.every(
      (capture) =>
        capture.input.taskId === runtime.taskId &&
        capture.input.runtimeId === runtime.runtimeId &&
        capture.output.taskId === runtime.taskId &&
        capture.output.runtimeId === runtime.runtimeId &&
        sameJson(capture.input.anchor, capture.output.anchor.requested),
    ) &&
    evidence.pinnedCaptures.every(
      (capture) =>
        capture.manifest.taskId === runtime.taskId &&
        capture.manifest.runtimeId === runtime.runtimeId &&
        capture.manifest.executionId === runtime.executionId &&
        capture.manifest.buildId === runtime.buildId &&
        capture.manifest.environmentRevisionId ===
          runtime.environmentRevisionId &&
        capture.manifest.adapterRevisionId === runtime.adapterRevisionId,
    ) &&
    runtime.queryObservations.stateQueryCount >= evidence.stateQueries.length &&
    runtime.queryObservations.stateRows >= queryRowCount &&
    sameCaptureIds &&
    sameJson(stop.output.cleanup, runtime.cleanup) &&
    sameJson(stop.output.coverage, runtime.coverage) &&
    sameJson(stop.output.loss, runtime.loss);
  if (!lineageMatches) {
    return blocked("project_environment_lineage_mismatch", ordinal, subject);
  }
  for (const capture of evidence.pinnedCaptures) {
    const bytes = Buffer.from(
      `${canonicalJson(JsonValueSchema.parse(capture.records))}\n`,
      "utf8",
    );
    if (
      capture.manifest.recordCount !== capture.records.length ||
      capture.manifest.contentDigest !==
        projectEnvironmentPackageContentDigestV1([
          { path: "records.json", bytes },
        ])
    ) {
      return blocked("pinned_capture_content_mismatch", ordinal, subject);
    }
  }
  const timeline = timelineFromExactQueryAndCapture(evidence, ordinal, subject);
  const cleanupProven = projectRuntimeCleanupCompleteV1(runtime.cleanup);
  if (!cleanupProven) {
    return blocked("public_observation_cleanup_not_proven", ordinal, subject);
  }
  const allCoverage = [
    ...runtime.coverage,
    ...evidence.stateQueries.flatMap((query) => query.output.coverage),
    ...evidence.capturePins.flatMap((capture) => capture.output.coverage),
    ...evidence.pinnedCaptures.flatMap((capture) => capture.manifest.coverage),
    ...stop.output.coverage,
  ];
  const allLoss = [
    ...runtime.loss,
    ...evidence.stateQueries.flatMap((query) => query.output.loss),
    ...evidence.capturePins.flatMap((capture) => capture.output.loss),
    ...evidence.pinnedCaptures.flatMap((capture) => capture.manifest.loss),
    ...stop.output.loss,
  ];
  const droppedRecordCount = allCoverage.reduce(
    (count, coverage) => count + coverage.droppedRecords,
    0,
  );
  const overwrittenRecordCount = allCoverage.reduce(
    (count, coverage) => count + coverage.overwrittenRecords,
    0,
  );
  const unavailableHistoryObserved = allLoss.some((loss) => {
    const value = asRecord(loss);
    return value?.kind === "unavailable";
  });
  const coverageMaterial = {
    runtime: runtime.coverage,
    queries: evidence.stateQueries.map((query) => query.output.coverage),
    capturePins: evidence.capturePins.map((capture) => capture.output.coverage),
    pinnedCaptures: evidence.pinnedCaptures.map(
      (capture) => capture.manifest.coverage,
    ),
    stop: stop.output.coverage,
  };
  const lossMaterial = {
    runtime: runtime.loss,
    queries: evidence.stateQueries.map((query) => query.output.loss),
    capturePins: evidence.capturePins.map((capture) => capture.output.loss),
    pinnedCaptures: evidence.pinnedCaptures.map(
      (capture) => capture.manifest.loss,
    ),
    stop: stop.output.loss,
  };
  return {
    subject,
    trajectoryClassifierFreeze: classifierFreeze,
    build: evidence.build,
    selectedTreeSha256: evidence.selectedTreeSha256,
    runtimeId: runtime.runtimeId,
    executionId: runtime.executionId,
    configuredMainScene: evidence.configuredMainScene,
    mainSceneLaunchObserved:
      evidence.fingerprint.configuredMainScene === request.configuredMainScene,
    runtimeObservationReceiptSha256: digestJson(runtime),
    adapterRevisionRecordSha256: digestJson(revision),
    adapterPackageIdentitySha256: digestJson(packageIdentity),
    taskCleanup: {
      proven: true,
      receipt: evidence.taskCleanupReceipt,
      receiptSha256: evidence.taskCleanupReceiptSha256,
    },
    sandboxSecurityEvents: {
      count: evidence.sandboxSecurityEvents.length,
      receiptSha256: evidence.sandboxSecurityEventsSha256,
    },
    captureRecordSealSha256: digestJson(evidence.captureRecordSeal),
    timeline,
    coverageComplete:
      runtime.outcome === "succeeded" &&
      completeCoverage(allCoverage) &&
      allLoss.length === 0,
    coverageReceiptSha256: digestJson(coverageMaterial),
    loss: {
      droppedRecordCount,
      overwrittenRecordCount,
      unavailableHistoryObserved,
      receiptSha256: digestJson({
        coverage: coverageMaterial,
        loss: lossMaterial,
      }),
    },
    cleanup: {
      proven: true,
      receiptSha256: digestJson(runtime.cleanup),
    },
    observedAt: runtime.observedAt,
  };
};

const publicRequest = (input: {
  readonly construction: M7R3CaseConstructionReceiptV1;
  readonly portfolio: M7R3TwoCasePortfolioFreezeV1;
  readonly subject: Subject;
  readonly configuredMainScene: string;
}): M7R3NoAgentPublicObservationRequestV1 => {
  const { construction, portfolio, subject } = input;
  const pristineSha = construction.pristineSubject.selectedTreeSha256;
  return {
    schemaVersion: 1,
    ordinal: construction.ordinal,
    caseId: portfolio.cases[construction.ordinal - 1]!.caseId,
    subject,
    buildRole:
      subject === "pristine" ? "pristine_control" : "assignment_baseline",
    expectedSource:
      subject === "pristine"
        ? {
            sourceId: `source:${pristineSha}`,
            sourceSha256: pristineSha,
            selectedTreeSha256: pristineSha,
            buildId: null,
          }
        : {
            sourceId: construction.mutatedBuild.sourceId,
            sourceSha256: construction.mutatedBuild.sourceSha256,
            selectedTreeSha256: construction.mutatedBuild.selectedTreeSha256,
            buildId: construction.mutatedBuild.buildId,
          },
    configuredMainScene: input.configuredMainScene,
  };
};

const createPreflightEvidenceRecord = (input: {
  readonly evidenceKind: "public_observation" | "hidden_evaluator_run";
  readonly ordinal: 1 | 2;
  readonly caseId: string;
  readonly subject: Subject;
  readonly scenarioId: string | null;
  readonly request: unknown;
  readonly evidence: unknown;
}): M7R3CasePreflightEvidenceRecordV1 => {
  const basis = preflightEvidenceBasisSchema.parse({
    schemaVersion: 1,
    recordKind: "m7-r3-case-preflight-evidence",
    evidenceKind: input.evidenceKind,
    ordinal: input.ordinal,
    caseId: input.caseId,
    subject: input.subject,
    scenarioId: input.scenarioId,
    request: JsonValueSchema.parse(input.request),
    evidence: JsonValueSchema.parse(input.evidence),
  });
  return M7R3CasePreflightEvidenceRecordV1Schema.parse({
    ...basis,
    recordContentSha256: digestJson(basis),
  });
};

const persistEvidenceExact = async (
  port: M7R3CasePreflightEvidencePersistencePortV1 | undefined,
  record: M7R3CasePreflightEvidenceRecordV1,
): Promise<void> => {
  if (port === undefined) return;
  let raw: unknown;
  try {
    raw = await port.persistEvidenceOnce(record);
  } catch (error) {
    return blocked(
      "preflight_evidence_persistence_failed",
      record.ordinal,
      record.subject,
      error,
    );
  }
  const parsed = M7R3CasePreflightEvidenceRecordV1Schema.safeParse(raw);
  if (
    !parsed.success ||
    parsed.data.recordContentSha256 !== record.recordContentSha256 ||
    !sameJson(parsed.data, record)
  ) {
    return blocked(
      "preflight_evidence_persistence_substitution",
      record.ordinal,
      record.subject,
      parsed.success ? undefined : parsed.error,
    );
  }
};

const observePublic = async (input: {
  readonly construction: M7R3CaseConstructionReceiptV1;
  readonly portfolio: M7R3TwoCasePortfolioFreezeV1;
  readonly classifierFreeze: M7R3TrajectoryClassifierFreezeV1;
  readonly ports: M7R3CasePreflightHostPortsV1;
  readonly subject: Subject;
}): Promise<CreateM7R3PublicTrajectoryPreflightObservationV1Input> => {
  const request = publicRequest({
    construction: input.construction,
    portfolio: input.portfolio,
    subject: input.subject,
    configuredMainScene: input.ports.configuredMainScene,
  });
  let raw: unknown;
  try {
    raw =
      await input.ports.projectEnvironment.observeConfiguredMainScene(request);
  } catch (error) {
    return blocked(
      "project_environment_port_failed",
      input.construction.ordinal,
      input.subject,
      error,
    );
  }
  const evidence = parsePublicEvidence(
    raw,
    input.construction.ordinal,
    input.subject,
  );
  if (
    evidence.configuredMainScene !== input.ports.configuredMainScene ||
    evidence.fingerprint.configuredMainScene !== input.ports.configuredMainScene
  ) {
    return blocked(
      "configured_main_scene_not_observed",
      input.construction.ordinal,
      input.subject,
    );
  }
  await persistEvidenceExact(
    input.ports.evidencePersistence,
    createPreflightEvidenceRecord({
      evidenceKind: "public_observation",
      ordinal: input.construction.ordinal,
      caseId: request.caseId,
      subject: input.subject,
      scenarioId: null,
      request,
      evidence,
    }),
  );
  return publicObservationInput({
    ordinal: input.construction.ordinal,
    subject: input.subject,
    request,
    evidence,
    classifierFreeze: input.classifierFreeze,
  });
};

const hiddenSource = (
  construction: M7R3CaseConstructionReceiptV1,
  subject: Subject,
) => {
  if (subject === "pristine") {
    const sourceSha256 = construction.pristineSubject.selectedTreeSha256;
    return {
      sourceId: `source:${sourceSha256}`,
      sourceSha256,
      selectedTreeSha256: sourceSha256,
    };
  }
  return {
    sourceId: construction.mutatedBuild.sourceId,
    sourceSha256: construction.mutatedBuild.sourceSha256,
    selectedTreeSha256: construction.mutatedBuild.selectedTreeSha256,
  };
};

const hiddenRunReceipt = (input: {
  readonly result: HiddenEvaluatorResult;
}): {
  readonly run: M7PatrolPreflightRunReceiptV1;
  readonly fresh: M7R3EvaluatorFreshRunInputV1;
} => {
  const result = input.result;
  const identity = (kind: string, value: string) =>
    digestJson({ schemaVersion: 1, kind, value });
  return {
    run: {
      schemaVersion: 1,
      subject: result.subject,
      scenarioId: result.scenarioId,
      observation: result.observation,
      freshWorkspaceCreated: result.workspace.created,
      freshImportCacheCreated: result.importCache.created,
      freshProcessStarted: result.process.started,
      agentLaunchCount: 0,
      observationSha256:
        result.observationReceipt === null
          ? null
          : digestJson(result.observationReceipt),
      cleanupProven: result.cleanup.proven,
    },
    fresh: {
      subject: result.subject,
      scenarioId: result.scenarioId,
      workspaceIdentitySha256: identity("workspace", result.workspace.identity),
      importCacheIdentitySha256: identity(
        "import-cache",
        result.importCache.identity,
      ),
      processIdentitySha256: identity("process", result.process.identity),
      workspaceCreationReceiptSha256: digestJson(
        result.workspace.creationReceipt,
      ),
      importCacheCreationReceiptSha256: digestJson(
        result.importCache.creationReceipt,
      ),
      processStartReceiptSha256: digestJson(result.process.startReceipt),
      cleanupReceiptSha256: digestJson(result.cleanup.receipt),
    },
  };
};

const runHiddenMatrix = async (input: {
  readonly construction: M7R3CaseConstructionReceiptV1;
  readonly portfolio: M7R3TwoCasePortfolioFreezeV1;
  readonly port: M7R3HiddenEvaluatorPreflightPortV1;
  readonly evidencePersistence:
    M7R3CasePreflightEvidencePersistencePortV1 | undefined;
  readonly now: () => string;
}): Promise<{
  readonly matrix: ReturnType<typeof createM7PatrolPreflightResultV1>;
  readonly fresh: readonly M7R3EvaluatorFreshRunInputV1[];
  readonly cleanupStop: {
    readonly subject: Subject;
    readonly scenarioId: string;
  } | null;
}> => {
  const runs: M7PatrolPreflightRunReceiptV1[] = [];
  const fresh: M7R3EvaluatorFreshRunInputV1[] = [];
  let cleanupStop: {
    readonly subject: Subject;
    readonly scenarioId: string;
  } | null = null;
  for (const subject of ["pristine", "mutant"] as const) {
    for (const scenario of M7_PATROL_SCENARIO_PLAN_V1) {
      const request: M7R3HiddenEvaluatorPreflightRequestV1 = {
        schemaVersion: 1,
        ordinal: input.construction.ordinal,
        caseId: input.portfolio.cases[input.construction.ordinal - 1]!.caseId,
        subject,
        scenario,
        source: hiddenSource(input.construction, subject),
        evaluatorImplementationSha256:
          input.construction.evaluatorImplementation.sha256,
        evaluatorBundleSha256: input.construction.evaluatorBundle.sha256,
      };
      let raw: unknown;
      try {
        raw = await input.port.runFresh(request);
      } catch (error) {
        return blocked(
          "hidden_evaluator_port_failed",
          input.construction.ordinal,
          subject,
          error,
        );
      }
      const parsed = hiddenEvaluatorResultSchema.safeParse(raw);
      if (
        !parsed.success ||
        parsed.data.subject !== subject ||
        parsed.data.scenarioId !== scenario.scenarioId
      ) {
        return blocked(
          "invalid_hidden_evaluator_evidence",
          input.construction.ordinal,
          subject,
          parsed.success ? undefined : parsed.error,
        );
      }
      await persistEvidenceExact(
        input.evidencePersistence,
        createPreflightEvidenceRecord({
          evidenceKind: "hidden_evaluator_run",
          ordinal: input.construction.ordinal,
          caseId: request.caseId,
          subject,
          scenarioId: scenario.scenarioId,
          request,
          evidence: parsed.data,
        }),
      );
      const converted = hiddenRunReceipt({ result: parsed.data });
      runs.push(converted.run);
      fresh.push(converted.fresh);
      if (!parsed.data.cleanup.proven) {
        cleanupStop = { subject, scenarioId: scenario.scenarioId };
        break;
      }
    }
    if (cleanupStop !== null) break;
  }
  return {
    matrix: createM7PatrolPreflightResultV1({
      sensorFreezeId: input.construction.mutation.sensorFreezeId,
      mutationRegistrationId:
        input.construction.mutation.mutationRegistrationId,
      runs,
      completedAt: timestampSchema.parse(input.now()),
    }),
    fresh,
    cleanupStop,
  };
};

const assertFrozenInputs = (input: RunM7R3TwoCasePreflightV1Input) => {
  try {
    const classifierFreeze = M7R3TrajectoryClassifierFreezeV1Schema.parse(
      input.trajectoryClassifierFreeze,
    );
    const constructions = input.constructionReceipts.map((value) =>
      M7R3CaseConstructionReceiptV1Schema.parse(value),
    ) as [M7R3CaseConstructionReceiptV1, M7R3CaseConstructionReceiptV1];
    const portfolio = M7R3TwoCasePortfolioFreezeV1Schema.parse(
      input.portfolioFreeze,
    );
    if (
      constructions[0].ordinal !== 1 ||
      constructions[1].ordinal !== 2 ||
      constructions.some(
        (construction) =>
          construction.outcome !== "passed" ||
          construction.trajectoryClassifierFreezeRecordSha256 !==
            classifierFreeze.recordContentSha256,
      ) ||
      input.cases[0].ordinal !== 1 ||
      input.cases[1].ordinal !== 2
    ) {
      return blocked("invalid_frozen_inputs", null, null);
    }
    const common = projectM7R3ClassifierFreezeToPortfolioV1(classifierFreeze);
    if (
      Object.entries(common).some(
        ([key, value]) =>
          portfolio.commonRuntimeMaterials[key as keyof typeof common] !==
          value,
      )
    ) {
      return blocked("invalid_frozen_inputs", null, null);
    }
    for (const construction of constructions) {
      const projected = projectM7R3ConstructionToPortfolioCaseV1(construction);
      const portfolioCase = portfolio.cases[construction.ordinal - 1]!;
      if (
        Object.entries(projected).some(
          ([key, value]) =>
            !sameJson(portfolioCase[key as keyof typeof projected], value),
        )
      ) {
        return blocked("invalid_frozen_inputs", null, null);
      }
    }
    return { classifierFreeze, constructions, portfolio };
  } catch (error) {
    if (error instanceof M7R3PreflightApiBlockerErrorV1) throw error;
    return blocked("invalid_frozen_inputs", null, null, error);
  }
};

const persistExact = async (
  port: M7R3CasePreflightPersistencePortV1,
  receipt: M7R3CasePreflightReceiptV1,
): Promise<void> => {
  let raw: unknown;
  try {
    raw = await port.persistPreflightOnce(receipt);
  } catch (error) {
    return blocked(
      "preflight_persistence_failed",
      receipt.ordinal,
      null,
      error,
    );
  }
  let persisted: M7R3CasePreflightReceiptV1;
  try {
    persisted = M7R3CasePreflightReceiptV1Schema.parse(raw);
  } catch (error) {
    return blocked(
      "preflight_persistence_substitution",
      receipt.ordinal,
      null,
      error,
    );
  }
  if (
    persisted.recordContentSha256 !== receipt.recordContentSha256 ||
    !sameJson(persisted, receipt)
  ) {
    return blocked("preflight_persistence_substitution", receipt.ordinal, null);
  }
};

/**
 * Runs the fixed R3 preflight order synchronously:
 * case 1 pristine -> mutant -> hidden pristine 9 -> hidden mutant 9, then
 * case 2 in the same order. No Pi or provider surface is accepted here.
 */
export const runM7R3TwoCasePreflightV1 = async (
  input: RunM7R3TwoCasePreflightV1Input,
): Promise<M7R3TwoCasePreflightRunResultV1> => {
  const { classifierFreeze, constructions, portfolio } =
    assertFrozenInputs(input);
  const receipts: M7R3CasePreflightReceiptV1[] = [];
  for (const construction of constructions) {
    const ports = input.cases[construction.ordinal - 1]!;
    const configuredMainScene = configuredMainSceneSchema.parse(
      ports.configuredMainScene,
    );
    const pristineObservation = await observePublic({
      construction,
      portfolio,
      classifierFreeze,
      ports: { ...ports, configuredMainScene },
      subject: "pristine",
    });
    const mutantObservation = await observePublic({
      construction,
      portfolio,
      classifierFreeze,
      ports: { ...ports, configuredMainScene },
      subject: "mutant",
    });
    const hidden = await runHiddenMatrix({
      construction,
      portfolio,
      port: ports.hiddenEvaluator,
      evidencePersistence: ports.evidencePersistence,
      now: input.now,
    });
    const receipt = createM7R3CasePreflightReceiptV1({
      portfolioFreeze: portfolio,
      constructionReceipt: construction,
      trajectoryClassifierFreeze: classifierFreeze,
      pristineObservation,
      mutantObservation,
      hiddenEvaluatorMatrix: hidden.matrix,
      evaluatorFreshRuns: hidden.fresh,
      completedAt: timestampSchema.parse(input.now()),
    });
    await persistExact(ports.persistence, receipt);
    receipts.push(receipt);
    if (hidden.cleanupStop !== null) {
      return Object.freeze({
        schemaVersion: 1,
        status: "safety_stopped",
        reason: "hidden_evaluator_cleanup_not_proven",
        stoppedAfter: {
          ordinal: construction.ordinal,
          ...hidden.cleanupStop,
        },
        agentLaunchCount: 0,
        providerInvocationCount: 0,
        piSessionCount: 0,
        receipts: Object.freeze([...receipts]),
      });
    }
  }
  if (receipts.length !== 2) {
    return blocked("invalid_frozen_inputs", null, null);
  }
  return Object.freeze({
    schemaVersion: 1,
    status: "completed",
    agentLaunchCount: 0,
    providerInvocationCount: 0,
    piSessionCount: 0,
    receipts: Object.freeze([receipts[0]!, receipts[1]!] as const),
  });
};
