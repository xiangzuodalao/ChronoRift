import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, readFile, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  JsonValueSchema,
  ProjectEnvironmentRuntimeObservationReceiptV1Schema,
  Sha256DigestV1Schema,
  VNextBuildV1Schema,
  type JsonValue,
} from "@chronorift/domain";
import { canonicalJson } from "@chronorift/json-artifacts";
import {
  parseVNextPiHostHttpTransportObservationV1,
  type VNextPiHostHttpTransportObservationV1,
} from "@chronorift/pi-harness";
import { z } from "zod";

import { SandboxCleanupReceiptV1Schema } from "./contracts.js";
import { ExternalHiddenFixPatchReferenceV1Schema } from "./external-hidden-fix.js";
import { M7R3AgentDeliveryTraceV1Schema } from "./m7-r3-agent-delivery.js";
import {
  M7R3AgentAttemptEvidenceSidecarV1Schema,
  M7R3AgentAttemptFailureReceiptV1Schema,
} from "./m7-r3-paired-agent.js";
import {
  M7R3PortfolioCaseReferenceV1Schema,
  M7R3TwoCasePortfolioFreezeV1Schema,
  M7R3TwoCasePortfolioSummaryV1Schema,
} from "./m7-r3-two-case-portfolio.js";
import {
  M7R3CampaignInfrastructureFailureInputV1Schema,
  type M7R3TwoCaseLocalPortfolioRunV1,
} from "./m7-r3-two-case-local-portfolio.js";
import {
  M7PatrolScenarioV1Schema,
  M7_PATROL_SCENARIO_PLAN_V1,
} from "./m7-patrol-sensor.js";
import { M7R3PatrolTrajectoryUseEvidenceV1Schema } from "./m7-patrol-trajectory.js";
import { M7R3CasePreflightEvidenceRecordV1Schema } from "./m7-r3-case-preflight-runner.js";
import {
  M7R3CaseConstructionReceiptV1Schema,
  M7R3CasePreflightReceiptV1Schema,
  projectM7R3ConstructionToPortfolioCaseV1,
} from "./m7-r3-case-construction.js";
import {
  M7R3EvaluatorHeadroomReceiptV1Schema,
  M7R3TaskStorageHeadroomReceiptV1Schema,
} from "./m7-r3-project-environment-paired-agent.js";
import {
  M7R3ArmEvaluatorEvidenceV1Schema,
  M7R3LocalArmRunEnvelopeV1Schema,
  M7R3StoredDeliveryTraceV1Schema,
} from "./m7-r3-runtime-use-local-gate.js";
import { M7R4FormalOuterFailureReceiptV1Schema } from "./m7-r4-formal-live.js";
import { M7R4NoAgentPreflightTerminalV1Schema } from "./m7-r4-no-agent-preflight-attempt.js";
import {
  M7R7EvaluatorHeadroomEvidenceV1Schema,
  repairM7R7PreflightEvidencePublicationsV1,
} from "./m7-r7-preflight-evidence.js";
import {
  m7R7PrivatePublicationRootForPathV1,
  publishM7R7PrivateFileOnceV1,
  repairM7R7PrivatePublicationsV1,
} from "./m7-r7-private-publication.js";
import { repairPrivatePublicationsV1 } from "./private-atomic-publication.js";
import {
  M7ArmResultV1Schema,
  M7CampaignTerminalRecordV1Schema,
} from "./m7-runtime-use-campaign.js";
import {
  SANDBOX_TASK_STORAGE_MINIMUM_HEADROOM_BYTES_V1,
  SANDBOX_TASK_STORAGE_MINIMUM_HEADROOM_INODES_V1,
} from "./sandbox-preflight.js";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MAX_EVIDENCE_FILE_BYTES = 64 * 1024 * 1024;
const FORMAL_OUTER_FAILURE_FILENAME =
  "m7-r4.formal-outer-failure.json" as const;
const FORMAL_OUTER_FAILURE_RELATIVE_PATH =
  `runs/run-control/${FORMAL_OUTER_FAILURE_FILENAME}` as const;

const sha256 = (bytes: string | Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

const isNodeError = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error && "code" in error;

const digestJson = (value: unknown): string =>
  sha256(canonicalJson(JsonValueSchema.parse(value)));

const sameJson = (left: unknown, right: unknown): boolean =>
  canonicalJson(JsonValueSchema.parse(left)) ===
  canonicalJson(JsonValueSchema.parse(right));

const repairPreflightEvidencePublications = async (
  runsRoot: string,
): Promise<void> => {
  await Promise.all(
    ([1, 2] as const).map(async (ordinal) => {
      try {
        await repairM7R7PreflightEvidencePublicationsV1(
          join(runsRoot, "preflight-evidence", `case-0${ordinal}`),
        );
      } catch (error) {
        if (!isNodeError(error) || error.code !== "ENOENT") throw error;
      }
    }),
  );
};

const relativeEvidencePathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (value) =>
      !isAbsolute(value) &&
      value !== ".." &&
      !value.startsWith(`..${sep}`) &&
      !value.split(sep).includes(".."),
    "formal evidence path must remain relative",
  );

export const M7R7FormalDispositionV1Schema = z.enum([
  "campaigns_completed",
  "infrastructure_failure",
  "incomplete",
]);
export type M7R7FormalDispositionV1 = z.infer<
  typeof M7R7FormalDispositionV1Schema
>;

export const M7R7FormalEvidenceFileReferenceV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    scope: z.enum([
      "construction",
      "portfolio",
      "campaign",
      "arm_evidence",
      "arm_durable",
      "preflight_evidence",
      "agent_session",
      "patch",
      "formal_control",
    ]),
    relativePath: relativeEvidencePathSchema,
    byteLength: z.number().int().nonnegative().max(MAX_EVIDENCE_FILE_BYTES),
    fileSha256: Sha256DigestV1Schema,
    recordKind: z.string().min(1).max(128).nullable(),
    recordContentSha256: Sha256DigestV1Schema.nullable(),
  })
  .strict();
export type M7R7FormalEvidenceFileReferenceV1 = z.infer<
  typeof M7R7FormalEvidenceFileReferenceV1Schema
>;

const caseEvidenceSchema = z
  .object({
    schemaVersion: z.literal(1),
    ordinal: z.union([z.literal(1), z.literal(2)]),
    caseId: z.string().min(1).max(256),
    caseReferenceRecordSha256: Sha256DigestV1Schema,
    disposition: z.enum([
      "construction_failed",
      "preflight_failed",
      "campaign_terminal",
      "campaign_infrastructure_failure",
      "not_started_safety_stop",
    ]),
    campaignId: z.string().min(1).max(256).nullable(),
    campaignInfrastructureReceiptSha256: Sha256DigestV1Schema.nullable(),
    campaignTerminalRecordSha256: Sha256DigestV1Schema.nullable(),
    campaignOutcome: M7CampaignTerminalRecordV1Schema.shape.outcome.nullable(),
    campaignReason: M7CampaignTerminalRecordV1Schema.shape.reason.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    const terminalFieldsPresent =
      value.campaignTerminalRecordSha256 !== null &&
      value.campaignOutcome !== null &&
      value.campaignReason !== null;
    const terminalFieldsAbsent =
      value.campaignTerminalRecordSha256 === null &&
      value.campaignOutcome === null &&
      value.campaignReason === null;
    const infrastructureFailure =
      value.disposition === "campaign_infrastructure_failure";
    if (
      (!terminalFieldsPresent && !terminalFieldsAbsent) ||
      (value.disposition !== "campaign_terminal" && terminalFieldsPresent)
    ) {
      context.addIssue({
        code: "custom",
        path: ["campaignTerminalRecordSha256"],
        message:
          "campaign terminal fields must be retained together and only on a campaign_terminal reference",
      });
    }
    if (
      infrastructureFailure !==
      (value.campaignInfrastructureReceiptSha256 !== null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["campaignInfrastructureReceiptSha256"],
        message:
          "only campaign_infrastructure_failure may retain its infrastructure receipt",
      });
    }
  });

const formalEvidenceBasisSchema = z
  .object({
    schemaVersion: z.literal(1),
    recordKind: z.literal("m7-r7-formal-evidence-manifest"),
    portfolioId: z.string().min(1).max(256).nullable(),
    portfolioFreezeRecordSha256: Sha256DigestV1Schema.nullable(),
    portfolioSummaryRecordSha256: Sha256DigestV1Schema.nullable(),
    preflightTerminalRecordSha256: Sha256DigestV1Schema.nullable(),
    outerFailureRecordSha256: Sha256DigestV1Schema.nullable(),
    formalDisposition: M7R7FormalDispositionV1Schema,
    cases: z.array(caseEvidenceSchema).max(2),
    records: z.array(M7R7FormalEvidenceFileReferenceV1Schema).max(4096),
    requiredRecordGaps: z.array(z.string().min(1).max(512)).max(256),
    sealedAt: z.string().datetime(),
  })
  .strict();

export const M7R7FormalEvidenceManifestV1Schema = formalEvidenceBasisSchema
  .extend({ recordContentSha256: Sha256DigestV1Schema })
  .strict()
  .superRefine((value, context) => {
    const { recordContentSha256, ...basis } = value;
    if (recordContentSha256 !== digestJson(basis)) {
      context.addIssue({
        code: "custom",
        path: ["recordContentSha256"],
        message: "formal evidence manifest content hash does not match",
      });
    }
    const paths = new Set<string>();
    for (const [index, record] of value.records.entries()) {
      if (paths.has(record.relativePath)) {
        context.addIssue({
          code: "custom",
          path: ["records", index, "relativePath"],
          message: "formal evidence record paths must be unique",
        });
      }
      paths.add(record.relativePath);
    }
    const portfolioIdentities = [
      value.portfolioId,
      value.portfolioFreezeRecordSha256,
      value.portfolioSummaryRecordSha256,
    ];
    if (
      portfolioIdentities.some((entry) => entry === null) &&
      portfolioIdentities.some((entry) => entry !== null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["portfolioId"],
        message: "formal portfolio identities must be retained together",
      });
    }
    if (
      value.outerFailureRecordSha256 !== null &&
      value.formalDisposition !== "incomplete"
    ) {
      context.addIssue({
        code: "custom",
        path: ["outerFailureRecordSha256"],
        message:
          "an outer failure may annotate only incomplete evidence; it cannot rewrite a completed evidence disposition",
      });
    }
    for (const [index, entry] of value.cases.entries()) {
      if (entry.ordinal !== index + 1) {
        context.addIssue({
          code: "custom",
          path: ["cases", index, "ordinal"],
          message: "formal evidence cases must remain in ordinal order",
        });
      }
    }
    const caseRecordsComplete = value.cases.every(
      (entry) =>
        entry.disposition !== "campaign_terminal" ||
        (entry.campaignTerminalRecordSha256 !== null &&
          entry.campaignOutcome !== null &&
          entry.campaignReason !== null),
    );
    if (
      value.formalDisposition === "campaigns_completed" &&
      (value.portfolioId === null ||
        value.preflightTerminalRecordSha256 === null ||
        value.cases.length !== 2 ||
        !caseRecordsComplete ||
        value.requiredRecordGaps.length !== 0 ||
        value.cases.some(
          (entry) =>
            entry.disposition !== "campaign_terminal" ||
            entry.campaignOutcome === "infrastructure_failure" ||
            entry.campaignOutcome === "cleanup_failed",
        ))
    ) {
      context.addIssue({
        code: "custom",
        path: ["formalDisposition"],
        message:
          "campaigns_completed requires two non-infrastructure terminals and no evidence gaps",
      });
    }
    const hasInfrastructureFailure = value.cases.some(
      (entry) =>
        entry.disposition === "campaign_infrastructure_failure" ||
        entry.disposition === "construction_failed" ||
        entry.disposition === "preflight_failed" ||
        entry.campaignOutcome === "infrastructure_failure" ||
        entry.campaignOutcome === "cleanup_failed",
    );
    if (
      value.formalDisposition === "infrastructure_failure" &&
      (value.portfolioId === null ||
        value.preflightTerminalRecordSha256 === null ||
        value.cases.length !== 2 ||
        !caseRecordsComplete ||
        value.requiredRecordGaps.length !== 0 ||
        !hasInfrastructureFailure)
    ) {
      context.addIssue({
        code: "custom",
        path: ["formalDisposition"],
        message:
          "infrastructure_failure requires a complete two-case portfolio with an explicit failure",
      });
    }
    if (
      value.formalDisposition === "incomplete" &&
      value.portfolioId !== null &&
      value.preflightTerminalRecordSha256 !== null &&
      value.cases.length === 2 &&
      caseRecordsComplete &&
      value.requiredRecordGaps.length === 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["formalDisposition"],
        message: "complete formal evidence cannot be labeled incomplete",
      });
    }
  });
export type M7R7FormalEvidenceManifestV1 = z.infer<
  typeof M7R7FormalEvidenceManifestV1Schema
>;

interface EvidenceRoot {
  readonly scope: M7R7FormalEvidenceFileReferenceV1["scope"];
  readonly path: string;
  readonly prefix: string;
  readonly optional?: boolean;
}

interface CollectedEvidenceFile {
  readonly reference: M7R7FormalEvidenceFileReferenceV1;
  /** Null is retained for opaque/non-JSON files; it can never close a gap. */
  readonly json: JsonValue | null;
  readonly canonicalJsonLine: boolean;
}

const pathWithinOrEqual = (parent: string, candidate: string): boolean => {
  const difference = relative(parent, candidate);
  return (
    difference === "" ||
    (difference !== ".." &&
      !difference.startsWith(`..${sep}`) &&
      !isAbsolute(difference))
  );
};

const requirePrivateDirectory = async (pathInput: string): Promise<string> => {
  const path = resolve(pathInput);
  const [metadata, canonical] = await Promise.all([
    lstat(path),
    realpath(path),
  ]);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== process.geteuid?.() ||
    (metadata.mode & 0o7777) !== PRIVATE_DIRECTORY_MODE ||
    canonical !== path
  ) {
    throw new Error(
      "formal evidence root must be canonical, owned, and private",
    );
  }
  return path;
};

const optionalPrivateDirectory = async (
  path: string,
): Promise<string | null> => {
  try {
    return await requirePrivateDirectory(path);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }
};

const parseJsonValue = (bytes: Uint8Array): JsonValue | null => {
  try {
    return JsonValueSchema.parse(
      JSON.parse(
        new TextDecoder("utf8", { fatal: true }).decode(bytes),
      ) as unknown,
    );
  } catch {
    return null;
  }
};

const isCanonicalJsonLine = (
  bytes: Uint8Array,
  value: JsonValue | null,
): boolean =>
  value !== null &&
  Buffer.from(bytes).equals(Buffer.from(`${canonicalJson(value)}\n`, "utf8"));

const requireCanonicalJsonLine = (bytes: Uint8Array): void => {
  const value = parseJsonValue(bytes);
  if (!isCanonicalJsonLine(bytes, value)) {
    throw new Error("private atomic publication is not canonical JSON+LF");
  }
};

const requireContentAddressedPatch = (
  filename: string,
  bytes: Uint8Array,
): void => {
  const match = /^(?<sha256>[a-f0-9]{64})\.patch$/u.exec(filename);
  const digest = sha256(bytes);
  if (match?.groups?.sha256 !== digest) {
    throw new Error("private patch publication filename hash changed");
  }
  ExternalHiddenFixPatchReferenceV1Schema.parse({
    schemaVersion: 1,
    artifactId: `m6-artifact:${digest}`,
    rawSha256: digest,
    byteLength: bytes.byteLength,
  });
};

const jsonIdentity = (
  value: JsonValue | null,
): { recordKind: string | null; recordContentSha256: string | null } => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { recordKind: null, recordContentSha256: null };
  }
  const object = value as Record<string, JsonValue>;
  return {
    recordKind:
      typeof object.recordKind === "string" ? object.recordKind : null,
    recordContentSha256:
      typeof object.recordContentSha256 === "string" &&
      Sha256DigestV1Schema.safeParse(object.recordContentSha256).success
        ? object.recordContentSha256
        : null,
  };
};

const repairAtomicPublicationsAtRoot = async (
  rootInput: string,
  validatePublishedBytes: (
    filename: string,
    bytes: Uint8Array,
  ) => Promise<void> | void = (_filename, bytes) => {
    requireCanonicalJsonLine(bytes);
  },
): Promise<string> => {
  const root = await requirePrivateDirectory(rootInput);
  await repairPrivatePublicationsV1({
    root,
    validatePublishedBytes,
  });
  return root;
};

const repairInnerAtomicPublications = async (
  rootInput: string,
  validatePublishedBytes?: (
    filename: string,
    bytes: Uint8Array,
  ) => Promise<void> | void,
): Promise<void> => {
  const root = await repairAtomicPublicationsAtRoot(
    rootInput,
    validatePublishedBytes,
  );
  const entries = await readdir(root, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
  for (const entry of entries) {
    const path = resolve(root, entry.name);
    if (entry.isSymbolicLink() || !pathWithinOrEqual(root, path)) {
      throw new Error("inner evidence repair path escaped through a link");
    }
    if (entry.isDirectory()) {
      await repairInnerAtomicPublications(path, validatePublishedBytes);
    }
  }
};

const repairDeclaredInnerAtomicPublications = async (input: {
  readonly runsRoot: string;
  readonly constructionRoot: string;
}): Promise<void> => {
  await Promise.all(
    [
      input.constructionRoot,
      join(input.runsRoot, "portfolio"),
      join(input.runsRoot, "campaigns"),
      join(input.runsRoot, "evidence"),
      join(input.runsRoot, "durable"),
      join(input.runsRoot, "run-control", "formal-preflight-attempt"),
    ].map((root) => repairInnerAtomicPublications(root)),
  );
  await repairInnerAtomicPublications(
    join(input.runsRoot, "patches"),
    requireContentAddressedPatch,
  );
  await Promise.all([
    repairAtomicPublicationsAtRoot(
      join(input.runsRoot, "assignments", "case-01"),
    ),
    repairAtomicPublicationsAtRoot(
      join(input.runsRoot, "assignments", "case-02"),
    ),
    repairAtomicPublicationsAtRoot(join(input.runsRoot, "operational-config")),
  ]);
  await repairPrivatePublicationsV1({
    root: join(input.runsRoot, "run-control"),
    filenames: [FORMAL_OUTER_FAILURE_FILENAME],
    validatePublishedBytes: (_filename, bytes) => {
      const value = parseJsonValue(bytes);
      if (!isCanonicalJsonLine(bytes, value)) {
        throw new Error("formal outer failure is not canonical JSON+LF");
      }
      M7R4FormalOuterFailureReceiptV1Schema.parse(value);
    },
  });
};

const collectEvidenceFile = async (input: {
  readonly path: string;
  readonly scope: M7R7FormalEvidenceFileReferenceV1["scope"];
  readonly relativePath: string;
}): Promise<CollectedEvidenceFile> => {
  const handle = await open(
    input.path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const [opened, linked, canonical] = await Promise.all([
      handle.stat(),
      lstat(input.path),
      realpath(input.path),
    ]);
    if (
      !opened.isFile() ||
      opened.uid !== process.geteuid?.() ||
      (opened.mode & 0o7777) !== PRIVATE_FILE_MODE ||
      opened.nlink !== 1 ||
      opened.size > MAX_EVIDENCE_FILE_BYTES ||
      linked.isSymbolicLink() ||
      linked.dev !== opened.dev ||
      linked.ino !== opened.ino ||
      canonical !== input.path
    ) {
      throw new Error("formal evidence file identity changed");
    }
    const bytes = await handle.readFile();
    const json = parseJsonValue(bytes);
    const identity = jsonIdentity(json);
    return {
      reference: M7R7FormalEvidenceFileReferenceV1Schema.parse({
        schemaVersion: 1,
        scope: input.scope,
        relativePath: input.relativePath,
        byteLength: bytes.byteLength,
        fileSha256: sha256(bytes),
        ...identity,
      }),
      json,
      canonicalJsonLine: isCanonicalJsonLine(bytes, json),
    };
  } finally {
    await handle.close();
  }
};

const collectRoot = async (
  rootInput: EvidenceRoot,
): Promise<CollectedEvidenceFile[]> => {
  const root = rootInput.optional
    ? await optionalPrivateDirectory(rootInput.path)
    : await requirePrivateDirectory(rootInput.path);
  if (root === null) return [];
  const result: CollectedEvidenceFile[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      if (!pathWithinOrEqual(root, path) || entry.isSymbolicLink()) {
        throw new Error("formal evidence path escaped through a link");
      }
      if (entry.isDirectory()) {
        await requirePrivateDirectory(path);
        await visit(path);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(
          "formal evidence roots may contain only files and directories",
        );
      }
      result.push(
        await collectEvidenceFile({
          path,
          scope: rootInput.scope,
          relativePath: join(rootInput.prefix, relative(root, path)),
        }),
      );
    }
  };
  await visit(root);
  return result;
};

const collectFixedOuterFailure = async (
  runsRoot: string,
): Promise<CollectedEvidenceFile | null> => {
  const root = await requirePrivateDirectory(join(runsRoot, "run-control"));
  const path = join(root, FORMAL_OUTER_FAILURE_FILENAME);
  try {
    return await collectEvidenceFile({
      path,
      scope: "formal_control",
      relativePath: FORMAL_OUTER_FAILURE_RELATIVE_PATH,
    });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw error;
  }
};

const publicPreflightRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    ordinal: z.union([z.literal(1), z.literal(2)]),
    caseId: z.string().min(1).max(256),
    subject: z.enum(["pristine", "mutant"]),
    buildRole: z.enum(["pristine_control", "assignment_baseline"]),
    expectedSource: z
      .object({
        sourceId: z.string().min(1).max(16_384),
        sourceSha256: Sha256DigestV1Schema,
        selectedTreeSha256: Sha256DigestV1Schema,
        buildId: z.string().min(1).max(16_384).nullable(),
      })
      .strict(),
    configuredMainScene: z.string().min(1).max(2_048),
  })
  .strict();

const hiddenPreflightRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    ordinal: z.union([z.literal(1), z.literal(2)]),
    caseId: z.string().min(1).max(256),
    subject: z.enum(["pristine", "mutant"]),
    scenario: M7PatrolScenarioV1Schema,
    source: z
      .object({
        sourceId: z.string().min(1).max(16_384),
        sourceSha256: Sha256DigestV1Schema,
        selectedTreeSha256: Sha256DigestV1Schema,
      })
      .strict(),
    evaluatorImplementationSha256: Sha256DigestV1Schema,
    evaluatorBundleSha256: Sha256DigestV1Schema,
  })
  .strict();

const hiddenPreflightResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    subject: z.enum(["pristine", "mutant"]),
    scenarioId: M7PatrolScenarioV1Schema.shape.scenarioId,
    observation: z.enum([
      "expected_motion_observed",
      "expected_motion_not_observed",
      "infrastructure_failure",
    ]),
    observationReceipt: JsonValueSchema.nullable(),
    workspace: z
      .object({
        created: z.boolean(),
        identity: z.string().min(1).max(16_384),
        creationReceipt: JsonValueSchema,
      })
      .strict(),
    importCache: z
      .object({
        created: z.boolean(),
        identity: z.string().min(1).max(16_384),
        creationReceipt: JsonValueSchema,
      })
      .strict(),
    process: z
      .object({
        started: z.boolean(),
        identity: z.string().min(1).max(16_384),
        startReceipt: JsonValueSchema,
      })
      .strict(),
    cleanup: z
      .object({ proven: z.boolean(), receipt: JsonValueSchema })
      .strict(),
    agentLaunchCount: z.literal(0),
    providerInvocationCount: z.literal(0),
    piSessionCount: z.literal(0),
  })
  .strict();

const publicPreflightResultBindingSchema = z
  .object({
    schemaVersion: z.literal(1),
    build: VNextBuildV1Schema,
    selectedTreeSha256: Sha256DigestV1Schema,
    runtimeObservationReceipt:
      ProjectEnvironmentRuntimeObservationReceiptV1Schema,
    agentLaunchCount: z.literal(0),
    providerInvocationCount: z.literal(0),
    piSessionCount: z.literal(0),
  })
  .passthrough();

const gateRunRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    campaignId: z.string().min(1).max(256),
    arm: z.enum(["runtime_enabled", "code_only"]),
    campaignClaimContentSha256: Sha256DigestV1Schema,
    pairedAttemptBindingContentSha256: Sha256DigestV1Schema,
    caseCampaignAdmissionRecordSha256: Sha256DigestV1Schema,
    pairedCaseContractContentSha256: Sha256DigestV1Schema,
  })
  .strict();

const durableCleanupSchema = z
  .object({
    schemaVersion: z.literal(1),
    recordKind: z.literal("m7-r3-paired-arm-cleanup"),
    arm: z.enum(["runtime_enabled", "code_only"]),
    taskId: z.string().min(1).max(16_384),
    attemptBindingContentSha256: Sha256DigestV1Schema,
    sandboxCleanup: SandboxCleanupReceiptV1Schema,
    proven: z.boolean(),
    failures: z.array(z.string().min(1).max(256)).max(64),
    completedAt: z.string().datetime({ offset: true }),
  })
  .strict();

const sandboxSentinelSchema = z
  .object({
    schemaVersion: z.literal(1),
    recordKind: z.literal("m7-r3-coding-sandbox-sentinel"),
    arm: z.enum(["runtime_enabled", "code_only"]),
    taskId: z.string().min(1).max(16_384),
    forbiddenPathsSha256: Sha256DigestV1Schema,
    operationId: z.string().min(1).max(16_384),
    status: z.literal("succeeded"),
    exitCode: z.literal(0),
    checkedAt: z.string().datetime({ offset: true }),
  })
  .strict();

const qualified = <Output>(
  record: CollectedEvidenceFile | undefined,
  schema: z.ZodType<Output>,
): Output | null => {
  if (
    record === undefined ||
    record.json === null ||
    !record.canonicalJsonLine
  ) {
    return null;
  }
  const parsed = schema.safeParse(record.json);
  return parsed.success ? parsed.data : null;
};

const exactRecord = (
  records: readonly CollectedEvidenceFile[],
  relativePath: string,
): CollectedEvidenceFile | undefined =>
  records.find((record) => record.reference.relativePath === relativePath);

const expectedSourceFor = (
  portfolioCase: z.infer<
    typeof M7R3TwoCasePortfolioFreezeV1Schema
  >["cases"][number],
  subject: "pristine" | "mutant",
) =>
  subject === "pristine"
    ? {
        sourceId: `source:${portfolioCase.subject.pristineSelectedTreeSha256}`,
        sourceSha256: portfolioCase.subject.pristineSelectedTreeSha256,
        selectedTreeSha256: portfolioCase.subject.pristineSelectedTreeSha256,
      }
    : {
        sourceId: portfolioCase.mutant.mutatedBuildSourceId,
        sourceSha256: portfolioCase.mutant.mutatedBuildSourceSha256,
        selectedTreeSha256:
          portfolioCase.mutant.mutatedBaselineSelectedTreeSha256,
      };

const qualifiesPreflightEvidence = (input: {
  readonly record: CollectedEvidenceFile | undefined;
  readonly ordinal: 1 | 2;
  readonly portfolioCase: z.infer<
    typeof M7R3TwoCasePortfolioFreezeV1Schema
  >["cases"][number];
  readonly subject: "pristine" | "mutant";
  readonly scenario: z.infer<typeof M7PatrolScenarioV1Schema> | null;
}): boolean => {
  const evidence = qualified(
    input.record,
    M7R3CasePreflightEvidenceRecordV1Schema,
  );
  if (
    evidence === null ||
    evidence.ordinal !== input.ordinal ||
    evidence.caseId !== input.portfolioCase.caseId ||
    evidence.subject !== input.subject ||
    (input.scenario === null) !==
      (evidence.evidenceKind === "public_observation") ||
    evidence.scenarioId !== (input.scenario?.scenarioId ?? null)
  ) {
    return false;
  }
  const expectedSource = expectedSourceFor(input.portfolioCase, input.subject);
  if (input.scenario === null) {
    const request = publicPreflightRequestSchema.safeParse(evidence.request);
    const result = publicPreflightResultBindingSchema.safeParse(
      evidence.evidence,
    );
    if (!request.success || !result.success) return false;
    return (
      request.data.ordinal === input.ordinal &&
      request.data.caseId === input.portfolioCase.caseId &&
      request.data.subject === input.subject &&
      request.data.buildRole ===
        (input.subject === "pristine"
          ? "pristine_control"
          : "assignment_baseline") &&
      sameJson(
        {
          sourceId: request.data.expectedSource.sourceId,
          sourceSha256: request.data.expectedSource.sourceSha256,
          selectedTreeSha256: request.data.expectedSource.selectedTreeSha256,
        },
        expectedSource,
      ) &&
      (input.subject !== "pristine" ||
        request.data.expectedSource.buildId === null) &&
      result.data.build.sourceId === expectedSource.sourceId &&
      result.data.build.sourceHash === expectedSource.sourceSha256 &&
      result.data.selectedTreeSha256 === expectedSource.selectedTreeSha256 &&
      result.data.build.taskId ===
        result.data.runtimeObservationReceipt.taskId &&
      result.data.build.buildId ===
        result.data.runtimeObservationReceipt.buildId
    );
  }
  const request = hiddenPreflightRequestSchema.safeParse(evidence.request);
  const result = hiddenPreflightResultSchema.safeParse(evidence.evidence);
  return (
    request.success &&
    result.success &&
    request.data.ordinal === input.ordinal &&
    request.data.caseId === input.portfolioCase.caseId &&
    request.data.subject === input.subject &&
    sameJson(request.data.scenario, input.scenario) &&
    sameJson(request.data.source, expectedSource) &&
    request.data.evaluatorImplementationSha256 ===
      input.portfolioCase.evaluatorImplementationSha256 &&
    request.data.evaluatorBundleSha256 ===
      input.portfolioCase.evaluatorBundleSha256 &&
    result.data.subject === input.subject &&
    result.data.scenarioId === input.scenario.scenarioId
  );
};

const headroomAtLeastRequired = (headroom: {
  readonly availableBytes: number;
  readonly availableInodes: number;
  readonly requiredAvailableBytes: number;
  readonly requiredAvailableInodes: number;
}): boolean =>
  headroom.requiredAvailableBytes ===
    SANDBOX_TASK_STORAGE_MINIMUM_HEADROOM_BYTES_V1 &&
  headroom.requiredAvailableInodes ===
    SANDBOX_TASK_STORAGE_MINIMUM_HEADROOM_INODES_V1 &&
  headroom.availableBytes >= headroom.requiredAvailableBytes &&
  headroom.availableInodes >= headroom.requiredAvailableInodes;

const durableRecord = (input: {
  readonly records: readonly CollectedEvidenceFile[];
  readonly directoryPrefix: string;
  readonly kind: string;
}): CollectedEvidenceFile | undefined => {
  const prefix = `${input.directoryPrefix}${input.kind}-`;
  const matches = input.records.filter((record) =>
    record.reference.relativePath.startsWith(prefix),
  );
  if (matches.length !== 1) return undefined;
  const match = matches[0]!;
  if (match.json === null || !match.canonicalJsonLine) return undefined;
  const fullCanonicalSha256 = digestJson(match.json);
  const embedded = jsonIdentity(match.json).recordContentSha256;
  const logicalSha256 = embedded ?? fullCanonicalSha256;
  return basename(match.reference.relativePath) ===
    `${input.kind}-${logicalSha256}-${fullCanonicalSha256}.json`
    ? match
    : undefined;
};

const evidencePath = (
  ordinal: 1 | 2,
  campaignId: string,
  kind:
    | "runtime-attempt"
    | "code-only-attempt"
    | "runtime-attempt-failure"
    | "code-only-attempt-failure"
    | "runtime-delivery"
    | "code-only-delivery"
    | "runtime-trajectory-use"
    | "runtime-evaluator"
    | "code-only-evaluator",
): string =>
  `runs/evidence/case-0${ordinal}/${sha256(
    `${campaignId}\0${kind}`,
  )}.${kind}.json`;

interface M7R7AgentTransportAttemptProjectionV1 {
  readonly result: {
    readonly hostHttpTransportObservation?: unknown;
  } | null;
  readonly attemptEvidence: {
    readonly piTurnStarted: boolean;
  };
  readonly failureReceipt?: {
    readonly lifecycle: readonly { readonly stage: string }[];
    readonly hostHttpTransportObservation?: unknown;
  } | null;
}

const strictHostHttpTransportObservation = (
  value: unknown,
): VNextPiHostHttpTransportObservationV1 | null => {
  if (value === null || value === undefined) return null;
  try {
    return parseVNextPiHostHttpTransportObservationV1(value);
  } catch {
    return null;
  }
};

export const m7R7AgentTransportObservationIsCompleteV1 = (
  attempt: M7R7AgentTransportAttemptProjectionV1,
): boolean => {
  if (attempt.result !== null) {
    const observation = strictHostHttpTransportObservation(
      attempt.result.hostHttpTransportObservation,
    );
    return observation !== null && observation.requestStartedCount >= 1;
  }
  const failureReceipt = attempt.failureReceipt ?? null;
  const piSdkStarted =
    failureReceipt?.lifecycle.some(
      (event) => event.stage === "sdk_call_started",
    ) === true;
  if (!attempt.attemptEvidence.piTurnStarted && !piSdkStarted) return true;
  return (
    strictHostHttpTransportObservation(
      failureReceipt?.hostHttpTransportObservation,
    ) !== null
  );
};

const auditArmEvidence = (input: {
  readonly records: readonly CollectedEvidenceFile[];
  readonly ordinal: 1 | 2;
  readonly portfolio: z.infer<typeof M7R3TwoCasePortfolioFreezeV1Schema>;
  readonly reference: z.infer<typeof M7R3PortfolioCaseReferenceV1Schema> & {
    readonly disposition: "campaign_terminal";
  };
  readonly arm: "runtime_enabled" | "code_only";
  readonly result: z.infer<typeof M7ArmResultV1Schema> | null;
  readonly gaps: string[];
}): void => {
  const armDirectory = input.arm.replace("_", "-");
  const directoryPrefix = `runs/durable/case-0${input.ordinal}/${armDirectory}/`;
  const requireKind = (kind: string): CollectedEvidenceFile | undefined => {
    const record = durableRecord({
      records: input.records,
      directoryPrefix,
      kind,
    });
    if (record === undefined) input.gaps.push(`${directoryPrefix}${kind}-*`);
    return record;
  };
  const envelopeRecord = requireKind("local-arm-envelope");
  const envelope = qualified(envelopeRecord, M7R3LocalArmRunEnvelopeV1Schema);
  const frozenCase = input.portfolio.cases[input.ordinal - 1]!;
  const binding = envelope?.attempt.binding;
  const envelopeBound =
    envelope !== null &&
    envelope !== undefined &&
    envelope.arm === input.arm &&
    binding?.campaignId === input.reference.campaignId &&
    binding.portfolioId === input.portfolio.portfolioId &&
    binding.caseId === frozenCase.caseId &&
    binding.caseCampaignAdmissionRecordSha256 ===
      input.reference.caseCampaignAdmissionRecordSha256 &&
    binding.pairedCaseContractContentSha256 ===
      frozenCase.pairedPublicTaskContractSha256 &&
    binding.baselineSelectedTreeSha256 ===
      frozenCase.mutant.mutatedBaselineSelectedTreeSha256;
  if (!envelopeBound && envelopeRecord !== undefined) {
    input.gaps.push(`${directoryPrefix}local-arm-envelope-binding`);
  }

  const gateRecord = requireKind("gate-run-request");
  const gate = qualified(gateRecord, gateRunRequestSchema);
  if (
    !envelopeBound ||
    gate === null ||
    gate.campaignId !== input.reference.campaignId ||
    gate.arm !== input.arm ||
    gate.caseCampaignAdmissionRecordSha256 !==
      input.reference.caseCampaignAdmissionRecordSha256 ||
    gate.pairedCaseContractContentSha256 !==
      frozenCase.pairedPublicTaskContractSha256 ||
    gate.pairedAttemptBindingContentSha256 !== binding.bindingContentSha256
  ) {
    if (gateRecord !== undefined)
      input.gaps.push(`${directoryPrefix}gate-run-request-binding`);
  }

  const attemptRecord = requireKind("attempt-record");
  if (
    attemptRecord !== undefined &&
    (!envelopeBound || !sameJson(attemptRecord.json, envelope.attempt))
  ) {
    input.gaps.push(`${directoryPrefix}attempt-record-binding`);
  }
  const sidecarRecord = requireKind("attempt-sidecar");
  const sidecar = qualified(
    sidecarRecord,
    M7R3AgentAttemptEvidenceSidecarV1Schema,
  );
  if (
    sidecarRecord !== undefined &&
    (!envelopeBound ||
      sidecar === null ||
      !sameJson(sidecar, envelope.attempt.attemptEvidence))
  ) {
    input.gaps.push(`${directoryPrefix}attempt-sidecar-binding`);
  }
  const deliveryRecord = requireKind("agent-delivery-trace");
  const delivery = qualified(deliveryRecord, M7R3AgentDeliveryTraceV1Schema);
  if (
    deliveryRecord !== undefined &&
    (!envelopeBound ||
      delivery === null ||
      envelope.deliveryTrace === null ||
      !sameJson(delivery, envelope.deliveryTrace))
  ) {
    input.gaps.push(`${directoryPrefix}agent-delivery-trace-binding`);
  }

  if (envelopeBound) {
    const attempt = envelope.attempt;
    if (!m7R7AgentTransportObservationIsCompleteV1(attempt)) {
      input.gaps.push(`${directoryPrefix}host-http-transport-observation`);
    }
  }

  const taskHeadroomRecord = requireKind("task-storage-headroom");
  const taskHeadroom = qualified(
    taskHeadroomRecord,
    M7R3TaskStorageHeadroomReceiptV1Schema,
  );
  if (
    taskHeadroomRecord !== undefined &&
    (!envelopeBound ||
      taskHeadroom === null ||
      taskHeadroom.campaignId !== input.reference.campaignId ||
      taskHeadroom.portfolioId !== input.portfolio.portfolioId ||
      taskHeadroom.caseId !== frozenCase.caseId ||
      taskHeadroom.arm !== input.arm ||
      taskHeadroom.taskId !== binding.isolation.taskId ||
      taskHeadroom.attemptBindingContentSha256 !==
        binding.bindingContentSha256 ||
      !headroomAtLeastRequired(taskHeadroom))
  ) {
    input.gaps.push(`${directoryPrefix}task-storage-headroom-binding`);
  }

  const cleanupRecord = requireKind("cleanup");
  const cleanup = qualified(cleanupRecord, durableCleanupSchema);
  if (
    cleanupRecord !== undefined &&
    (!envelopeBound ||
      cleanup === null ||
      cleanup.arm !== input.arm ||
      cleanup.taskId !== binding.isolation.taskId ||
      cleanup.attemptBindingContentSha256 !== binding.bindingContentSha256 ||
      cleanup.proven !== envelope.attempt.cleanup.proven ||
      envelope.attempt.cleanup.receiptSha256 !== digestJson(cleanup))
  ) {
    input.gaps.push(`${directoryPrefix}cleanup-binding`);
  }
  const sentinelRecord = requireKind("sandbox-sentinel");
  const sentinel = qualified(sentinelRecord, sandboxSentinelSchema);
  if (
    sentinelRecord !== undefined &&
    (!envelopeBound ||
      sentinel === null ||
      sentinel.arm !== input.arm ||
      sentinel.taskId !== binding.isolation.taskId)
  ) {
    input.gaps.push(`${directoryPrefix}sandbox-sentinel-binding`);
  }

  if (
    input.result === null ||
    input.result.campaignId !== input.reference.campaignId ||
    input.result.arm !== input.arm ||
    !envelopeBound ||
    input.result.cleanupReceiptSha256 !== envelope.attempt.cleanup.receiptSha256
  ) {
    input.gaps.push(
      `runs/campaigns/case-0${input.ordinal}/m7.${armDirectory}-result.json`,
    );
  }

  const attemptPath = evidencePath(
    input.ordinal,
    input.reference.campaignId,
    input.arm === "runtime_enabled" ? "runtime-attempt" : "code-only-attempt",
  );
  const retainedAttempt = qualified(
    exactRecord(input.records, attemptPath),
    M7R3AgentAttemptEvidenceSidecarV1Schema,
  );
  if (sidecar === null || !sameJson(retainedAttempt, sidecar)) {
    input.gaps.push(attemptPath);
  }
  if (envelopeBound) {
    const failureReceipt = envelope.attempt.failureReceipt ?? null;
    const failurePath = evidencePath(
      input.ordinal,
      input.reference.campaignId,
      input.arm === "runtime_enabled"
        ? "runtime-attempt-failure"
        : "code-only-attempt-failure",
    );
    const retainedFailure = qualified(
      exactRecord(input.records, failurePath),
      M7R3AgentAttemptFailureReceiptV1Schema,
    );
    if (
      (failureReceipt !== null && !sameJson(retainedFailure, failureReceipt)) ||
      (failureReceipt === null && retainedFailure !== null)
    ) {
      input.gaps.push(failurePath);
    }
  }
  const deliveryPath = evidencePath(
    input.ordinal,
    input.reference.campaignId,
    input.arm === "runtime_enabled" ? "runtime-delivery" : "code-only-delivery",
  );
  const retainedDelivery = qualified(
    exactRecord(input.records, deliveryPath),
    M7R3StoredDeliveryTraceV1Schema,
  );
  if (
    !envelopeBound ||
    retainedDelivery === null ||
    retainedDelivery.campaignId !== input.reference.campaignId ||
    retainedDelivery.arm !== input.arm ||
    retainedDelivery.caseCampaignAdmissionRecordSha256 !==
      input.reference.caseCampaignAdmissionRecordSha256 ||
    retainedDelivery.attemptBindingContentSha256 !==
      binding.bindingContentSha256 ||
    !sameJson(retainedDelivery.trace, envelope.deliveryTrace)
  ) {
    input.gaps.push(deliveryPath);
  }

  if (input.result !== null && input.result.evaluatorReceiptSha256 !== null) {
    const evaluatorPath = evidencePath(
      input.ordinal,
      input.reference.campaignId,
      input.arm === "runtime_enabled"
        ? "runtime-evaluator"
        : "code-only-evaluator",
    );
    const evaluator = qualified(
      exactRecord(input.records, evaluatorPath),
      M7R3ArmEvaluatorEvidenceV1Schema,
    );
    const candidate = input.result?.candidate ?? null;
    if (
      !envelopeBound ||
      evaluator === null ||
      evaluator.recordContentSha256 !== input.result.evaluatorReceiptSha256 ||
      evaluator.campaignId !== input.reference.campaignId ||
      evaluator.arm !== input.arm ||
      evaluator.caseCampaignAdmissionRecordSha256 !==
        input.reference.caseCampaignAdmissionRecordSha256 ||
      evaluator.mutationRegistrationRecordSha256 !==
        input.reference.mutationRegistrationRecordSha256 ||
      evaluator.attemptBindingContentSha256 !== binding.bindingContentSha256 ||
      evaluator.baselineSelectedTreeSha256 !==
        frozenCase.mutant.mutatedBaselineSelectedTreeSha256 ||
      candidate === null ||
      evaluator.candidateSelectedTreeSha256 !==
        candidate.candidateSelectedTreeSha256 ||
      evaluator.patchSha256 !== candidate.patchSha256 ||
      evaluator.outcome !== input.result.evaluatorOutcome ||
      !sameJson(
        input.result.freshRunReferences,
        evaluator.runs.map((run) => ({
          schemaVersion: 1,
          ordinal: run.ordinal,
          scenarioClass: run.scenarioClass,
          repetition: run.repetition,
          receiptSha256: digestJson(run),
        })),
      )
    ) {
      input.gaps.push(evaluatorPath);
    }
  }

  const evaluatorHeadroomPrefix = `${directoryPrefix}evaluator-headroom-`;
  const realizedEvaluatorHeadrooms = input.records.filter((record) =>
    record.reference.relativePath.startsWith(evaluatorHeadroomPrefix),
  );
  const expectedEvaluatorRuns =
    input.result?.evaluatorOutcome === "accepted" ||
    input.result?.evaluatorOutcome === "rejected"
      ? 9
      : input.result?.evaluatorOutcome.startsWith("not_run_") === true
        ? 0
        : null;
  const expectedObservedCount =
    expectedEvaluatorRuns ?? realizedEvaluatorHeadrooms.length;
  const evaluatorHeadrooms = Array.from(
    { length: expectedObservedCount },
    (_unused, index) =>
      durableRecord({
        records: input.records,
        directoryPrefix,
        kind: `evaluator-headroom-${String(index + 1).padStart(6, "0")}`,
      }),
  );
  const evaluatorHeadroomsValid =
    envelopeBound &&
    realizedEvaluatorHeadrooms.length === expectedObservedCount &&
    evaluatorHeadrooms.every((record, index) => {
      const headroom = qualified(record, M7R3EvaluatorHeadroomReceiptV1Schema);
      const runOrdinal = index + 1;
      return (
        headroom !== null &&
        headroom.campaignId === input.reference.campaignId &&
        headroom.portfolioId === input.portfolio.portfolioId &&
        headroom.caseId === frozenCase.caseId &&
        headroom.arm === input.arm &&
        headroom.taskId === binding.isolation.taskId &&
        headroom.attemptBindingContentSha256 === binding.bindingContentSha256 &&
        headroom.runOrdinal === runOrdinal &&
        headroomAtLeastRequired(headroom.taskStorage) &&
        headroomAtLeastRequired(headroom.evaluatorStorage)
      );
    }) &&
    (expectedEvaluatorRuns === null ||
      realizedEvaluatorHeadrooms.length === expectedEvaluatorRuns);
  if (!evaluatorHeadroomsValid) {
    input.gaps.push(`${directoryPrefix}evaluator-headroom-binding`);
  }
};

const evidenceGaps = (input: {
  readonly records: readonly CollectedEvidenceFile[];
  readonly portfolio: z.infer<typeof M7R3TwoCasePortfolioFreezeV1Schema>;
  readonly references: readonly [
    z.infer<typeof M7R3PortfolioCaseReferenceV1Schema>,
    z.infer<typeof M7R3PortfolioCaseReferenceV1Schema>,
  ];
  readonly summary: z.infer<typeof M7R3TwoCasePortfolioSummaryV1Schema>;
  readonly preflightTerminalRecordSha256: string;
}): string[] => {
  const gaps: string[] = [];
  if (
    exactRecord(input.records, FORMAL_OUTER_FAILURE_RELATIVE_PATH) !== undefined
  ) {
    gaps.push(FORMAL_OUTER_FAILURE_RELATIVE_PATH);
  }
  const requireExact = <Output>(
    path: string,
    schema: z.ZodType<Output>,
    expected: Output,
  ): void => {
    const retained = qualified(exactRecord(input.records, path), schema);
    if (retained === null || !sameJson(retained, expected)) gaps.push(path);
  };
  requireExact(
    "runs/portfolio/m7-r3.portfolio-freeze.json",
    M7R3TwoCasePortfolioFreezeV1Schema,
    input.portfolio,
  );
  requireExact(
    "runs/portfolio/m7-r3.case-01-reference.json",
    M7R3PortfolioCaseReferenceV1Schema,
    input.references[0],
  );
  requireExact(
    "runs/portfolio/m7-r3.case-02-reference.json",
    M7R3PortfolioCaseReferenceV1Schema,
    input.references[1],
  );
  requireExact(
    "runs/portfolio/m7-r3.portfolio-summary.json",
    M7R3TwoCasePortfolioSummaryV1Schema,
    input.summary,
  );

  const preflightPath =
    "runs/run-control/formal-preflight-attempt/preflight-terminal.v1.json";
  const preflight = qualified(
    exactRecord(input.records, preflightPath),
    M7R4NoAgentPreflightTerminalV1Schema,
  );
  if (
    preflight === null ||
    preflight.status !== "passed" ||
    preflight.recordContentSha256 !== input.preflightTerminalRecordSha256 ||
    preflight.portfolioId !== input.portfolio.portfolioId ||
    preflight.portfolioFreezeRecordSha256 !==
      input.portfolio.recordContentSha256 ||
    preflight.preflightReceipts.some(
      (receipt, index) =>
        receipt.caseOrdinal !== index + 1 ||
        receipt.caseId !== input.portfolio.cases[index]!.caseId,
    )
  ) {
    gaps.push(preflightPath);
  }

  for (const [index, reference] of input.references.entries()) {
    const ordinal = (index + 1) as 1 | 2;
    const frozenCase = input.portfolio.cases[index]!;
    const constructionPath = `construction/m7-r3.case-0${ordinal}-construction.json`;
    const retainedConstruction = qualified(
      exactRecord(input.records, constructionPath),
      M7R3CaseConstructionReceiptV1Schema,
    );
    let constructionMatchesPortfolio = false;
    if (
      retainedConstruction !== null &&
      retainedConstruction.ordinal === ordinal &&
      retainedConstruction.outcome === "passed"
    ) {
      const frozenProjection: Record<string, unknown> = { ...frozenCase };
      delete frozenProjection.schemaVersion;
      delete frozenProjection.ordinal;
      delete frozenProjection.caseId;
      try {
        constructionMatchesPortfolio = sameJson(
          projectM7R3ConstructionToPortfolioCaseV1(retainedConstruction),
          frozenProjection,
        );
      } catch {
        constructionMatchesPortfolio = false;
      }
    }
    if (!constructionMatchesPortfolio) gaps.push(constructionPath);

    const retainedPreflightPath = `construction/m7-r3.case-0${ordinal}-preflight.json`;
    const retainedPreflight = qualified(
      exactRecord(input.records, retainedPreflightPath),
      M7R3CasePreflightReceiptV1Schema,
    );
    const terminalPreflightReference = preflight?.preflightReceipts[index];
    if (
      retainedPreflight === null ||
      retainedConstruction === null ||
      retainedPreflight.ordinal !== ordinal ||
      retainedPreflight.outcome !== "passed" ||
      retainedPreflight.recordContentSha256 !==
        terminalPreflightReference?.preflightReceiptSha256 ||
      retainedPreflight.portfolio.caseId !== frozenCase.caseId ||
      !sameJson(retainedPreflight.portfolioFreeze, input.portfolio) ||
      retainedPreflight.constructionReceiptSha256 !==
        retainedConstruction.recordContentSha256 ||
      !sameJson(retainedPreflight.constructionReceipt, retainedConstruction)
    ) {
      gaps.push(retainedPreflightPath);
    }

    const preflightPrefix = `runs/preflight-evidence/case-0${ordinal}/`;
    for (const subject of ["pristine", "mutant"] as const) {
      const publicPath = `${preflightPrefix}public-${subject}.json`;
      if (
        !qualifiesPreflightEvidence({
          record: exactRecord(input.records, publicPath),
          ordinal,
          portfolioCase: frozenCase,
          subject,
          scenario: null,
        })
      ) {
        gaps.push(publicPath);
      }
      for (const scenario of M7_PATROL_SCENARIO_PLAN_V1) {
        const hiddenPath = `${preflightPrefix}hidden-${subject}-${sha256(
          scenario.scenarioId,
        )}.json`;
        if (
          !qualifiesPreflightEvidence({
            record: exactRecord(input.records, hiddenPath),
            ordinal,
            portfolioCase: frozenCase,
            subject,
            scenario,
          })
        ) {
          gaps.push(hiddenPath);
        }
      }
    }
    const headroomTaskId = `task:m7-r4:no-agent-evaluator:case-0${ordinal}`;
    const expectedHeadroomCount = M7_PATROL_SCENARIO_PLAN_V1.length * 2;
    for (
      let runOrdinal = 1;
      runOrdinal <= expectedHeadroomCount;
      runOrdinal += 1
    ) {
      const path = `${preflightPrefix}evaluator-headroom-${String(
        runOrdinal,
      ).padStart(6, "0")}.json`;
      const headroom = qualified(
        exactRecord(input.records, path),
        M7R7EvaluatorHeadroomEvidenceV1Schema,
      );
      if (
        headroom === null ||
        headroom.caseOrdinal !== ordinal ||
        headroom.caseId !== frozenCase.caseId ||
        headroom.taskId !== headroomTaskId ||
        headroom.runOrdinal !== runOrdinal ||
        !headroomAtLeastRequired(headroom.taskStorage) ||
        !headroomAtLeastRequired(headroom.evaluatorStorage)
      ) {
        gaps.push(path);
      }
    }
    const realizedHeadroomPaths = input.records
      .map((record) => record.reference.relativePath)
      .filter((path) =>
        path.startsWith(`${preflightPrefix}evaluator-headroom-`),
      );
    if (realizedHeadroomPaths.length !== expectedHeadroomCount) {
      gaps.push(`${preflightPrefix}evaluator-headroom-cardinality`);
    }

    if (reference.disposition === "campaign_infrastructure_failure") {
      const path = `runs/campaigns/case-0${ordinal}/m7-r3.campaign-infrastructure-failure.json`;
      const record = exactRecord(input.records, path);
      const failure = qualified(
        record,
        M7R3CampaignInfrastructureFailureInputV1Schema,
      );
      if (
        failure === null ||
        failure.portfolioId !== input.portfolio.portfolioId ||
        failure.caseOrdinal !== ordinal ||
        failure.caseId !== frozenCase.caseId ||
        failure.campaignId !== reference.campaignId ||
        digestJson(failure) !== reference.campaignInfrastructureReceiptSha256
      ) {
        gaps.push(path);
      }
      continue;
    }
    if (reference.disposition !== "campaign_terminal") continue;
    const terminalPath = `runs/campaigns/case-0${ordinal}/m7.terminal.json`;
    const terminal = qualified(
      exactRecord(input.records, terminalPath),
      M7CampaignTerminalRecordV1Schema,
    );
    if (
      terminal === null ||
      terminal.recordContentSha256 !== reference.campaignTerminalRecordSha256 ||
      terminal.campaignId !== reference.campaignId
    ) {
      gaps.push(terminalPath);
    }
    const armResults = (["runtime_enabled", "code_only"] as const).map(
      (arm) => {
        const armDirectory = arm.replace("_", "-");
        const path = `runs/campaigns/case-0${ordinal}/m7.${armDirectory}-result.json`;
        const result = qualified(
          exactRecord(input.records, path),
          M7ArmResultV1Schema,
        );
        const expectedHash =
          arm === "runtime_enabled"
            ? reference.runtimeEnabledResultRecordSha256
            : reference.codeOnlyResultRecordSha256;
        if (
          result === null ||
          result.campaignId !== reference.campaignId ||
          result.arm !== arm ||
          result.recordContentSha256 !== expectedHash ||
          (terminal !== null &&
            result.recordContentSha256 !==
              (arm === "runtime_enabled"
                ? terminal.runtimeEnabledResultSha256
                : terminal.codeOnlyResultSha256))
        ) {
          gaps.push(path);
          return null;
        }
        return result;
      },
    );
    const runtimeResult = armResults[0] ?? null;
    const codeOnlyResult = armResults[1] ?? null;
    auditArmEvidence({
      records: input.records,
      ordinal,
      portfolio: input.portfolio,
      reference,
      arm: "runtime_enabled",
      result: runtimeResult,
      gaps,
    });
    auditArmEvidence({
      records: input.records,
      ordinal,
      portfolio: input.portfolio,
      reference,
      arm: "code_only",
      result: codeOnlyResult,
      gaps,
    });

    const trajectoryPath = evidencePath(
      ordinal,
      reference.campaignId,
      "runtime-trajectory-use",
    );
    const trajectory = qualified(
      exactRecord(input.records, trajectoryPath),
      M7R3PatrolTrajectoryUseEvidenceV1Schema,
    );
    if (
      trajectory === null ||
      trajectory.campaignId !== reference.campaignId ||
      trajectory.recordContentSha256 !==
        reference.trajectoryUseEvidenceRecordSha256 ||
      trajectory.caseSpec.caseId !== frozenCase.trajectoryCaseSpecId ||
      trajectory.caseSpec.caseSpecSha256 !==
        frozenCase.trajectoryCaseSpecSha256 ||
      trajectory.baselineIdentity.sourceId !==
        frozenCase.mutant.mutatedBuildSourceId ||
      trajectory.baselineIdentity.sourceSha256 !==
        frozenCase.mutant.mutatedBuildSourceSha256 ||
      (runtimeResult !== null &&
        runtimeResult.runtimeUseReceiptSha256 !==
          trajectory.recordContentSha256)
    ) {
      gaps.push(trajectoryPath);
    }
  }
  return [...new Set(gaps)].sort((left, right) =>
    left.localeCompare(right, "en"),
  );
};

export const deriveM7R7FormalDispositionV1 = (input: {
  readonly cases: readonly z.input<typeof caseEvidenceSchema>[];
  readonly requiredRecordGaps: readonly string[];
}): M7R7FormalDispositionV1 => {
  const cases = input.cases.map((entry) => caseEvidenceSchema.parse(entry));
  if (
    input.requiredRecordGaps.length !== 0 ||
    cases.length !== 2 ||
    cases.some(
      (entry) =>
        entry.disposition === "campaign_terminal" &&
        (entry.campaignTerminalRecordSha256 === null ||
          entry.campaignOutcome === null ||
          entry.campaignReason === null),
    )
  ) {
    return "incomplete";
  }
  return cases.some(
    (entry) =>
      entry.disposition === "campaign_infrastructure_failure" ||
      entry.disposition === "construction_failed" ||
      entry.disposition === "preflight_failed" ||
      entry.campaignOutcome === "infrastructure_failure" ||
      entry.campaignOutcome === "cleanup_failed",
  )
    ? "infrastructure_failure"
    : cases.every((entry) => entry.disposition === "campaign_terminal")
      ? "campaigns_completed"
      : "incomplete";
};

export const collectM7R7FormalEvidenceManifestV1 = async (input: {
  readonly runsRoot: string;
  readonly constructionRoot: string;
  readonly portfolio: M7R3TwoCaseLocalPortfolioRunV1;
  readonly preflightTerminalRecordSha256: string;
  readonly sealedAt: string;
}): Promise<M7R7FormalEvidenceManifestV1> => {
  const runsRoot = await requirePrivateDirectory(input.runsRoot);
  const constructionRoot = await requirePrivateDirectory(
    input.constructionRoot,
  );
  await repairDeclaredInnerAtomicPublications({
    runsRoot,
    constructionRoot,
  });
  await repairPreflightEvidencePublications(runsRoot);
  const portfolioFreeze = M7R3TwoCasePortfolioFreezeV1Schema.parse(
    input.portfolio.portfolioFreeze,
  );
  const portfolioSummary = M7R3TwoCasePortfolioSummaryV1Schema.parse(
    input.portfolio.summary,
  );
  const caseReferences = z
    .tuple([
      M7R3PortfolioCaseReferenceV1Schema,
      M7R3PortfolioCaseReferenceV1Schema,
    ])
    .parse(input.portfolio.caseReferences);
  if (
    portfolioSummary.portfolioId !== portfolioFreeze.portfolioId ||
    portfolioSummary.portfolioFreezeRecordSha256 !==
      portfolioFreeze.recordContentSha256 ||
    caseReferences.some(
      (reference, index) =>
        reference.portfolioId !== portfolioFreeze.portfolioId ||
        reference.portfolioFreezeRecordSha256 !==
          portfolioFreeze.recordContentSha256 ||
        reference.caseOrdinal !== index + 1 ||
        reference.caseId !== portfolioFreeze.cases[index]!.caseId ||
        portfolioSummary.cases[index]!.caseReferenceRecordSha256 !==
          reference.recordContentSha256 ||
        portfolioSummary.cases[index]!.caseId !== reference.caseId ||
        portfolioSummary.cases[index]!.disposition !== reference.disposition,
    )
  ) {
    throw new Error("formal portfolio input crossed its frozen case lineage");
  }
  const roots: EvidenceRoot[] = [
    { scope: "construction", path: constructionRoot, prefix: "construction" },
    {
      scope: "portfolio",
      path: join(runsRoot, "portfolio"),
      prefix: "runs/portfolio",
    },
    {
      scope: "campaign",
      path: join(runsRoot, "campaigns"),
      prefix: "runs/campaigns",
    },
    {
      scope: "arm_evidence",
      path: join(runsRoot, "evidence"),
      prefix: "runs/evidence",
    },
    {
      scope: "arm_durable",
      path: join(runsRoot, "durable"),
      prefix: "runs/durable",
    },
    {
      scope: "preflight_evidence",
      path: join(runsRoot, "preflight-evidence"),
      prefix: "runs/preflight-evidence",
      optional: true,
    },
    {
      scope: "agent_session",
      path: join(runsRoot, "agent-resources"),
      prefix: "runs/agent-resources",
    },
    { scope: "patch", path: join(runsRoot, "patches"), prefix: "runs/patches" },
    {
      scope: "formal_control",
      path: join(runsRoot, "run-control", "formal-preflight-attempt"),
      prefix: "runs/run-control/formal-preflight-attempt",
    },
  ];
  const [rootCollections, outerFailure] = await Promise.all([
    Promise.all(roots.map((root) => collectRoot(root))),
    collectFixedOuterFailure(runsRoot),
  ]);
  const collected = [
    ...rootCollections.flat(),
    ...(outerFailure === null ? [] : [outerFailure]),
  ].sort((left, right) =>
    left.reference.relativePath.localeCompare(
      right.reference.relativePath,
      "en",
    ),
  );
  const cases = caseReferences.map((reference, index) => {
    const ordinal = (index + 1) as 1 | 2;
    const terminal =
      reference.disposition === "campaign_terminal"
        ? qualified(
            exactRecord(
              collected,
              `runs/campaigns/case-0${ordinal}/m7.terminal.json`,
            ),
            M7CampaignTerminalRecordV1Schema,
          )
        : null;
    const terminalBound =
      terminal !== null &&
      terminal.recordContentSha256 === reference.campaignTerminalRecordSha256 &&
      terminal.campaignId === reference.campaignId;
    return caseEvidenceSchema.parse({
      schemaVersion: 1,
      ordinal,
      caseId: reference.caseId,
      caseReferenceRecordSha256: reference.recordContentSha256,
      disposition: reference.disposition,
      campaignId: reference.campaignId,
      campaignInfrastructureReceiptSha256:
        reference.campaignInfrastructureReceiptSha256,
      campaignTerminalRecordSha256: terminalBound
        ? terminal.recordContentSha256
        : null,
      campaignOutcome: terminalBound ? terminal.outcome : null,
      campaignReason: terminalBound ? terminal.reason : null,
    });
  }) as [
    z.infer<typeof caseEvidenceSchema>,
    z.infer<typeof caseEvidenceSchema>,
  ];
  const preflightTerminalRecordSha256 = Sha256DigestV1Schema.parse(
    input.preflightTerminalRecordSha256,
  );
  const requiredRecordGaps = evidenceGaps({
    records: collected,
    portfolio: portfolioFreeze,
    references: caseReferences,
    summary: portfolioSummary,
    preflightTerminalRecordSha256,
  });
  const records = collected.map((record) => record.reference);
  const formalDisposition = deriveM7R7FormalDispositionV1({
    cases,
    requiredRecordGaps,
  });
  const basis = formalEvidenceBasisSchema.parse({
    schemaVersion: 1,
    recordKind: "m7-r7-formal-evidence-manifest",
    portfolioId: portfolioFreeze.portfolioId,
    portfolioFreezeRecordSha256: portfolioFreeze.recordContentSha256,
    portfolioSummaryRecordSha256: portfolioSummary.recordContentSha256,
    preflightTerminalRecordSha256,
    outerFailureRecordSha256: null,
    formalDisposition,
    cases,
    records,
    requiredRecordGaps,
    sealedAt: input.sealedAt,
  });
  return M7R7FormalEvidenceManifestV1Schema.parse({
    ...basis,
    recordContentSha256: digestJson(basis),
  });
};

/**
 * Seals what remains observable when formal composition throws before it can
 * return a complete portfolio. The missing result is explicit; this helper
 * never projects partial files into a successful or infrastructure terminal.
 */
export const collectM7R7IncompleteFormalEvidenceManifestV1 = async (input: {
  readonly runsRoot: string;
  readonly constructionRoot: string;
  readonly preflightTerminalRecordSha256?: string | null;
  readonly outerFailureRecordSha256?: string | null;
  readonly reason?:
    | "formal_result_unavailable"
    | "outer_infrastructure_failure"
    | "interrupted";
  readonly sealedAt: string;
}): Promise<M7R7FormalEvidenceManifestV1> => {
  const runsRoot = await requirePrivateDirectory(input.runsRoot);
  const constructionRoot = await requirePrivateDirectory(
    input.constructionRoot,
  );
  await repairDeclaredInnerAtomicPublications({
    runsRoot,
    constructionRoot,
  });
  await repairPreflightEvidencePublications(runsRoot);
  const roots: EvidenceRoot[] = [
    { scope: "construction", path: constructionRoot, prefix: "construction" },
    {
      scope: "portfolio",
      path: join(runsRoot, "portfolio"),
      prefix: "runs/portfolio",
    },
    {
      scope: "campaign",
      path: join(runsRoot, "campaigns"),
      prefix: "runs/campaigns",
    },
    {
      scope: "arm_evidence",
      path: join(runsRoot, "evidence"),
      prefix: "runs/evidence",
    },
    {
      scope: "arm_durable",
      path: join(runsRoot, "durable"),
      prefix: "runs/durable",
    },
    {
      scope: "preflight_evidence",
      path: join(runsRoot, "preflight-evidence"),
      prefix: "runs/preflight-evidence",
      optional: true,
    },
    {
      scope: "agent_session",
      path: join(runsRoot, "agent-resources"),
      prefix: "runs/agent-resources",
    },
    { scope: "patch", path: join(runsRoot, "patches"), prefix: "runs/patches" },
    {
      scope: "formal_control",
      path: join(runsRoot, "run-control", "formal-preflight-attempt"),
      prefix: "runs/run-control/formal-preflight-attempt",
    },
  ];
  const [rootCollections, outerFailure] = await Promise.all([
    Promise.all(roots.map((root) => collectRoot(root))),
    collectFixedOuterFailure(runsRoot),
  ]);
  const collected = [
    ...rootCollections.flat(),
    ...(outerFailure === null ? [] : [outerFailure]),
  ].sort((left, right) =>
    left.reference.relativePath.localeCompare(
      right.reference.relativePath,
      "en",
    ),
  );
  const requestedOuterFailureRecordSha256 =
    input.outerFailureRecordSha256 === undefined ||
    input.outerFailureRecordSha256 === null
      ? null
      : Sha256DigestV1Schema.parse(input.outerFailureRecordSha256);
  const retainedOuterFailure = qualified(
    outerFailure ?? undefined,
    M7R4FormalOuterFailureReceiptV1Schema,
  );
  const outerFailureBound =
    requestedOuterFailureRecordSha256 !== null &&
    retainedOuterFailure !== null &&
    retainedOuterFailure.recordContentSha256 ===
      requestedOuterFailureRecordSha256;
  const outerFailureMismatch =
    requestedOuterFailureRecordSha256 === null
      ? outerFailure !== null
      : !outerFailureBound;
  const records = collected.map((record) => record.reference);
  const basis = formalEvidenceBasisSchema.parse({
    schemaVersion: 1,
    recordKind: "m7-r7-formal-evidence-manifest",
    portfolioId: null,
    portfolioFreezeRecordSha256: null,
    portfolioSummaryRecordSha256: null,
    preflightTerminalRecordSha256:
      input.preflightTerminalRecordSha256 === undefined ||
      input.preflightTerminalRecordSha256 === null
        ? null
        : Sha256DigestV1Schema.parse(input.preflightTerminalRecordSha256),
    outerFailureRecordSha256:
      outerFailureBound && retainedOuterFailure !== null
        ? retainedOuterFailure.recordContentSha256
        : null,
    formalDisposition: "incomplete",
    cases: [],
    records,
    requiredRecordGaps: [
      input.reason ?? "formal_result_unavailable",
      ...(outerFailureMismatch ? [FORMAL_OUTER_FAILURE_RELATIVE_PATH] : []),
    ],
    sealedAt: input.sealedAt,
  });
  return M7R7FormalEvidenceManifestV1Schema.parse({
    ...basis,
    recordContentSha256: digestJson(basis),
  });
};

export const persistM7R7FormalEvidenceManifestOnceV1 = async (input: {
  readonly controlRoot: string;
  readonly manifest: M7R7FormalEvidenceManifestV1;
}): Promise<M7R7FormalEvidenceManifestV1> => {
  const root = await requirePrivateDirectory(input.controlRoot);
  const manifest = M7R7FormalEvidenceManifestV1Schema.parse(input.manifest);
  const path = join(root, "formal-evidence-manifest.v1.json");
  const bytes = Buffer.from(
    `${canonicalJson(JsonValueSchema.parse(manifest))}\n`,
    "utf8",
  );
  try {
    await publishM7R7PrivateFileOnceV1({
      root,
      filename: "formal-evidence-manifest.v1.json",
      bytes,
    });
  } catch (error) {
    throw new Error("formal evidence manifest is create-once", {
      cause: error,
    });
  }
  const retained = M7R7FormalEvidenceManifestV1Schema.parse(
    JSON.parse(await readFile(path, "utf8")) as unknown,
  );
  if (canonicalJson(retained) !== canonicalJson(manifest)) {
    throw new Error("formal evidence manifest changed during persistence");
  }
  return retained;
};

const parseCanonicalFormalEvidenceBytes = (
  bytes: Uint8Array,
): M7R7FormalEvidenceManifestV1 => {
  const manifest = M7R7FormalEvidenceManifestV1Schema.parse(
    JSON.parse(
      new TextDecoder("utf8", { fatal: true }).decode(bytes),
    ) as unknown,
  );
  const expected = `${canonicalJson(JsonValueSchema.parse(manifest))}\n`;
  if (!Buffer.from(bytes).equals(Buffer.from(expected, "utf8"))) {
    throw new Error("formal evidence manifest bytes are not canonical");
  }
  return manifest;
};

export const repairM7R7FormalEvidencePublicationV1 = async (
  pathInput: string,
): Promise<{
  readonly removedUnpublishedTemporaryCount: number;
  readonly repairedPublishedLinkCount: number;
}> => {
  const publication = m7R7PrivatePublicationRootForPathV1(pathInput);
  if (publication.filename !== "formal-evidence-manifest.v1.json") {
    throw new Error("formal evidence repair path is not the fixed manifest");
  }
  return repairM7R7PrivatePublicationsV1({
    root: publication.root,
    filenames: [publication.filename],
    validatePublishedBytes: (_filename, bytes) => {
      parseCanonicalFormalEvidenceBytes(bytes);
    },
  });
};

export const validateM7R7FormalEvidenceManifestFileV1 = async (
  pathInput: string,
): Promise<{
  readonly formalDisposition: M7R7FormalDispositionV1;
  readonly recordContentSha256: string;
  readonly fileSha256: string;
}> => {
  const path = resolve(pathInput);
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const [opened, linked, canonical] = await Promise.all([
      handle.stat(),
      lstat(path),
      realpath(path),
    ]);
    if (
      !opened.isFile() ||
      opened.uid !== process.geteuid?.() ||
      (opened.mode & 0o7777) !== PRIVATE_FILE_MODE ||
      opened.nlink !== 1 ||
      opened.size > MAX_EVIDENCE_FILE_BYTES ||
      linked.isSymbolicLink() ||
      linked.dev !== opened.dev ||
      linked.ino !== opened.ino ||
      canonical !== path
    ) {
      throw new Error("formal evidence manifest file identity is invalid");
    }
    const bytes = await handle.readFile();
    const manifest = parseCanonicalFormalEvidenceBytes(bytes);
    return {
      formalDisposition: manifest.formalDisposition,
      recordContentSha256: manifest.recordContentSha256,
      fileSha256: sha256(bytes),
    };
  } finally {
    await handle.close();
  }
};

const invokedAsProgram =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsProgram) {
  const runCommand = async (): Promise<void> => {
    const [command, ...arguments_] = process.argv.slice(2);
    if (command === "--validate-manifest" && arguments_.length === 1) {
      const result = await validateM7R7FormalEvidenceManifestFileV1(
        arguments_[0]!,
      );
      process.stdout.write(`${canonicalJson(JsonValueSchema.parse(result))}\n`);
      return;
    }
    if (command === "--repair-publication" && arguments_.length === 1) {
      const result = await repairM7R7FormalEvidencePublicationV1(
        arguments_[0]!,
      );
      process.stdout.write(`${canonicalJson(JsonValueSchema.parse(result))}\n`);
      return;
    }
    if (command === "--seal-operator-failure" && arguments_.length === 6) {
      const [
        runsRoot,
        constructionRoot,
        controlRoot,
        reasonInput,
        preflightHashInput,
        outerFailureHashInput,
      ] = arguments_ as [string, string, string, string, string, string];
      const reason = z
        .enum(["outer_infrastructure_failure", "interrupted"])
        .parse(reasonInput);
      const manifest = await collectM7R7IncompleteFormalEvidenceManifestV1({
        runsRoot,
        constructionRoot,
        preflightTerminalRecordSha256:
          preflightHashInput === "-" ? null : preflightHashInput,
        outerFailureRecordSha256:
          outerFailureHashInput === "-" ? null : outerFailureHashInput,
        reason,
        sealedAt: new Date().toISOString(),
      });
      const retained = await persistM7R7FormalEvidenceManifestOnceV1({
        controlRoot,
        manifest,
      });
      process.stdout.write(
        `${canonicalJson(
          JsonValueSchema.parse({
            formalDisposition: retained.formalDisposition,
            recordContentSha256: retained.recordContentSha256,
          }),
        )}\n`,
      );
      return;
    }
    throw new TypeError("unsupported M7 R7 formal evidence command");
  };
  runCommand().catch(() => {
    process.stderr.write("M7 R7 formal evidence command failed\n");
    process.exitCode = 1;
  });
}
