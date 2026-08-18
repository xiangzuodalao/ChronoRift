import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import {
  isAbsolute,
  parse as parsePath,
  relative,
  resolve,
  sep,
} from "node:path";

import {
  JsonValueSchema,
  Sha256DigestV1Schema,
  TaskIdSchema,
  asSha256DigestV1,
  type Sha256DigestV1,
} from "@chronorift/domain";
import { canonicalJson } from "@chronorift/json-artifacts";
import { z } from "zod";

import {
  M7_R3_PREFLIGHT_API_BLOCKER_CODES_V1,
  M7R3PreflightApiBlockerErrorV1,
} from "./m7-r3-case-preflight-runner.js";
import { M7R3TwoCasePortfolioFreezeV1Schema } from "./m7-r3-two-case-portfolio.js";
import {
  SandboxCleanupReceiptV1Schema,
  SandboxOperationIdV1Schema,
  SecurityEventV1Schema,
  type SandboxCleanupReceiptV1,
  type SecurityEventV1,
} from "./contracts.js";
import { publishPrivateFileOnceV1 } from "./private-atomic-publication.js";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const RECORD_BYTE_LIMIT = 2 * 1024 * 1024;
const STARTED_RECORD_NAME = "preflight-started.v1.json";
const TERMINAL_RECORD_NAME = "preflight-terminal.v1.json";

const timestampSchema = z.string().datetime({ offset: true });
const caseOrdinalSchema = z.union([z.literal(1), z.literal(2)]);
const subjectSchema = z.enum(["pristine", "mutant"]);
const caseIdSchema = z.string().regex(/^m7-r3-case:[a-f0-9]{24}$/u);
const blockerCodeSchema = z.enum(M7_R3_PREFLIGHT_API_BLOCKER_CODES_V1);
const counterSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);

const digestJson = (value: unknown): Sha256DigestV1 =>
  asSha256DigestV1(
    createHash("sha256")
      .update(canonicalJson(JsonValueSchema.parse(value)), "utf8")
      .digest("hex"),
  );

const sameJson = (left: unknown, right: unknown): boolean =>
  canonicalJson(JsonValueSchema.parse(left)) ===
  canonicalJson(JsonValueSchema.parse(right));

const addIssue = (
  context: z.RefinementCtx,
  path: readonly (string | number)[],
  message: string,
): void => {
  context.addIssue({ code: "custom", path: [...path], message });
};

const validateContentHash = (
  value: Readonly<Record<string, unknown>> & {
    readonly recordContentSha256: Sha256DigestV1;
  },
  context: z.RefinementCtx,
): void => {
  const { recordContentSha256, ...basis } = value;
  if (recordContentSha256 !== digestJson(basis)) {
    addIssue(
      context,
      ["recordContentSha256"],
      "record content hash does not match its canonical bytes",
    );
  }
};

const startedCaseSchema = z
  .object({
    caseOrdinal: caseOrdinalSchema,
    caseId: caseIdSchema,
  })
  .strict();

const startedCasesSchema = z
  .tuple([startedCaseSchema, startedCaseSchema])
  .superRefine((value, context) => {
    if (value[0].caseOrdinal !== 1 || value[1].caseOrdinal !== 2) {
      addIssue(
        context,
        ["cases"],
        "started cases must remain in ordinal order 1 then 2",
      );
    }
    if (value[0].caseId === value[1].caseId) {
      addIssue(context, ["cases", 1, "caseId"], "case IDs must be distinct");
    }
  });

const startedBasisSchema = z
  .object({
    schemaVersion: z.literal(1),
    recordKind: z.literal("m7-r4-no-agent-preflight-started"),
    portfolioId: M7R3TwoCasePortfolioFreezeV1Schema.shape.portfolioId,
    portfolioFreezeRecordSha256: Sha256DigestV1Schema,
    cases: startedCasesSchema,
    agentLaunchCount: z.literal(0),
    piSessionCount: z.literal(0),
    providerInvocationCount: z.literal(0),
    startedAt: timestampSchema,
  })
  .strict();

export const M7R4NoAgentPreflightStartedV1Schema = startedBasisSchema
  .extend({ recordContentSha256: Sha256DigestV1Schema })
  .strict()
  .superRefine((value, context) => validateContentHash(value, context));
export type M7R4NoAgentPreflightStartedV1 = z.infer<
  typeof M7R4NoAgentPreflightStartedV1Schema
>;

const preflightReceiptReferenceSchema = z
  .object({
    caseOrdinal: caseOrdinalSchema,
    caseId: caseIdSchema,
    preflightReceiptSha256: Sha256DigestV1Schema,
  })
  .strict();

const completedPreflightReceiptsSchema = z
  .array(preflightReceiptReferenceSchema)
  .max(2)
  .superRefine((value, context) => {
    value.forEach((reference, index) => {
      if (reference.caseOrdinal !== index + 1) {
        addIssue(
          context,
          [index, "caseOrdinal"],
          "completed preflight receipts must be a unique ordinal prefix",
        );
      }
    });
  });

const passedPreflightReceiptsSchema = z
  .tuple([preflightReceiptReferenceSchema, preflightReceiptReferenceSchema])
  .superRefine((value, context) => {
    if (value[0].caseOrdinal !== 1 || value[1].caseOrdinal !== 2) {
      addIssue(
        context,
        ["preflightReceipts"],
        "passed terminal must bind case receipts in order 1 then 2",
      );
    }
  });

export const M7R4NoAgentPreflightStageV1Schema = z.enum([
  "prepare",
  "public_observation",
  "hidden_evaluation",
  "receipt_persistence",
  "cleanup",
]);
export type M7R4NoAgentPreflightStageV1 = z.infer<
  typeof M7R4NoAgentPreflightStageV1Schema
>;

const failureSchema = z
  .object({
    stage: M7R4NoAgentPreflightStageV1Schema,
    caseOrdinal: caseOrdinalSchema.nullable(),
    subject: subjectSchema.nullable(),
    blockerCode: blockerCodeSchema.nullable(),
    errorClassSha256: Sha256DigestV1Schema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.blockerCode === null) === (value.errorClassSha256 === null)) {
      addIssue(
        context,
        ["blockerCode"],
        "failure requires exactly one typed blocker code or error-class hash",
      );
    }
    if (value.subject !== null && value.caseOrdinal === null) {
      addIssue(
        context,
        ["caseOrdinal"],
        "a subject-scoped failure requires a case ordinal",
      );
    }
    switch (value.stage) {
      case "prepare":
      case "cleanup":
        break;
      case "public_observation":
      case "hidden_evaluation":
        if (value.caseOrdinal === null || value.subject === null) {
          addIssue(
            context,
            ["stage"],
            `${value.stage} requires an exact case and subject`,
          );
        }
        break;
      case "receipt_persistence":
        if (value.caseOrdinal === null || value.subject !== null) {
          addIssue(
            context,
            ["stage"],
            "receipt_persistence requires one case and no subject",
          );
        }
        break;
    }
  });

const cleanupComplete = (receipt: SandboxCleanupReceiptV1): boolean =>
  receipt.processGroupTerminated &&
  !receipt.cgroupPopulated &&
  receipt.scopeRemoved &&
  receipt.storageReconciled === true;

const cleanupEvidenceSchema = z
  .object({
    attempted: z.boolean(),
    cleanupProven: z.boolean(),
    receipt: SandboxCleanupReceiptV1Schema.nullable(),
    receiptSha256: Sha256DigestV1Schema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.receipt === null) !== (value.receiptSha256 === null)) {
      addIssue(
        context,
        ["receiptSha256"],
        "cleanup receipt and hash presence must agree",
      );
    }
    if (
      value.receipt !== null &&
      value.receiptSha256 !== digestJson(value.receipt)
    ) {
      addIssue(
        context,
        ["receiptSha256"],
        "cleanup receipt hash must derive from the strict embedded receipt",
      );
    }
    if (!value.attempted && value.receipt !== null) {
      addIssue(
        context,
        ["attempted"],
        "an unattempted cleanup cannot have a receipt",
      );
    }
    const expectedProven =
      value.attempted &&
      value.receipt !== null &&
      cleanupComplete(value.receipt);
    if (value.cleanupProven !== expectedProven) {
      addIssue(
        context,
        ["cleanupProven"],
        "cleanup truth must derive from the strict embedded receipt",
      );
    }
  });

const securityEventProjectionSchema = z
  .object({
    eventId: SandboxOperationIdV1Schema,
    taskId: TaskIdSchema,
    operationId: SandboxOperationIdV1Schema,
    code: z.enum(["path_denied", "capability_denied"]),
    occurredAt: timestampSchema,
    sideEffectStarted: z.literal(false),
  })
  .strict();

const securityEvidenceSchema = z
  .object({
    available: z.boolean(),
    events: z.array(securityEventProjectionSchema).max(1_000),
    eventsSha256: Sha256DigestV1Schema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.available !== (value.eventsSha256 !== null)) {
      addIssue(
        context,
        ["eventsSha256"],
        "security-event availability and strict-list hash presence must agree",
      );
    }
    if (!value.available && value.events.length !== 0) {
      addIssue(
        context,
        ["events"],
        "unavailable security events cannot have projected entries",
      );
    }
  });

const subjectEvidenceEntrySchema = z
  .object({
    caseOrdinal: caseOrdinalSchema,
    caseId: caseIdSchema,
    subject: subjectSchema,
    cleanup: cleanupEvidenceSchema,
    security: securityEvidenceSchema,
  })
  .strict();

const subjectEvidenceSchema = z
  .tuple([
    subjectEvidenceEntrySchema,
    subjectEvidenceEntrySchema,
    subjectEvidenceEntrySchema,
    subjectEvidenceEntrySchema,
  ])
  .superRefine((value, context) => {
    const expected = [
      [1, "pristine"],
      [1, "mutant"],
      [2, "pristine"],
      [2, "mutant"],
    ] as const;
    value.forEach((entry, index) => {
      const identity = expected[index]!;
      if (entry.caseOrdinal !== identity[0] || entry.subject !== identity[1]) {
        addIssue(
          context,
          [index],
          "subject evidence must cover case 1 then case 2, pristine then mutant",
        );
      }
    });
  });

const terminalCommonSchema = z.object({
  schemaVersion: z.literal(1),
  recordKind: z.literal("m7-r4-no-agent-preflight-terminal"),
  portfolioId: M7R3TwoCasePortfolioFreezeV1Schema.shape.portfolioId,
  portfolioFreezeRecordSha256: Sha256DigestV1Schema,
  startedRecordContentSha256: Sha256DigestV1Schema,
  completedAt: timestampSchema,
});

const passedTerminalBasisSchema = terminalCommonSchema
  .extend({
    status: z.literal("passed"),
    preflightReceipts: passedPreflightReceiptsSchema,
    agentLaunchCount: z.literal(0),
    piSessionCount: z.literal(0),
    providerInvocationCount: z.literal(0),
  })
  .strict();

const failedTerminalBasisSchema = terminalCommonSchema
  .extend({
    status: z.literal("failed"),
    preflightReceipts: completedPreflightReceiptsSchema,
    failure: failureSchema,
    agentLaunchCount: counterSchema,
    piSessionCount: counterSchema,
    providerInvocationCount: counterSchema,
    subjectEvidence: subjectEvidenceSchema,
  })
  .strict();

export const M7R4NoAgentPreflightTerminalV1Schema = z
  .discriminatedUnion("status", [
    passedTerminalBasisSchema.extend({
      recordContentSha256: Sha256DigestV1Schema,
    }),
    failedTerminalBasisSchema.extend({
      recordContentSha256: Sha256DigestV1Schema,
    }),
  ])
  .superRefine((value, context) => validateContentHash(value, context));
export type M7R4NoAgentPreflightTerminalV1 = z.infer<
  typeof M7R4NoAgentPreflightTerminalV1Schema
>;

export type M7R4NoAgentPreflightReceiptReferenceV1 = z.infer<
  typeof preflightReceiptReferenceSchema
>;

export interface M7R4NoAgentPreflightSubjectEvidenceInputV1 {
  readonly caseOrdinal: 1 | 2;
  readonly caseId: string;
  readonly subject: "pristine" | "mutant";
  readonly cleanupAttempted: boolean;
  readonly cleanupProven: boolean;
  readonly cleanupReceipt: SandboxCleanupReceiptV1 | null;
  readonly cleanupReceiptSha256: Sha256DigestV1 | null;
  /** Null means that the strict security-event list was unavailable. */
  readonly securityEvents: readonly SecurityEventV1[] | null;
  readonly securityEventsSha256: Sha256DigestV1 | null;
}

const isNodeError = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error && "code" in error;

const effectiveUserId = (): number => {
  const uid = process.geteuid?.();
  if (uid === undefined) {
    throw new Error("M7 R4 preflight retention requires effective-user checks");
  }
  return uid;
};

const pathWithinOrEqual = (parent: string, candidate: string): boolean => {
  const difference = relative(parent, candidate);
  return (
    difference === "" ||
    (difference !== ".." &&
      !difference.startsWith(`..${sep}`) &&
      !isAbsolute(difference))
  );
};

interface RootIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly uid: number;
  readonly mode: number;
}

const canonicalDirectory = async (
  inputPath: string,
  label: string,
  requirePrivate: boolean,
): Promise<{ readonly path: string; readonly identity: RootIdentity }> => {
  if (
    !isAbsolute(inputPath) ||
    resolve(inputPath) !== inputPath ||
    inputPath === parsePath(inputPath).root
  ) {
    throw new TypeError(`${label} must be a canonical non-root absolute path`);
  }
  const metadata = await lstat(inputPath);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (await realpath(inputPath)) !== inputPath
  ) {
    throw new TypeError(`${label} must be a canonical real directory`);
  }
  if (
    requirePrivate &&
    (metadata.uid !== effectiveUserId() ||
      (metadata.mode & 0o7777) !== PRIVATE_DIRECTORY_MODE)
  ) {
    throw new TypeError(`${label} must be current-user owned with mode 0700`);
  }
  return {
    path: inputPath,
    identity: {
      dev: metadata.dev,
      ino: metadata.ino,
      uid: metadata.uid,
      mode: metadata.mode,
    },
  };
};

const errorClassSha256 = (error: unknown): Sha256DigestV1 => {
  let errorClass: string = typeof error;
  try {
    if (error instanceof Error) {
      const prototype = Object.getPrototypeOf(error) as {
        constructor?: { name?: unknown };
      } | null;
      const constructorName = prototype?.constructor?.name;
      errorClass =
        typeof constructorName === "string" && constructorName.length > 0
          ? constructorName
          : "Error";
    }
  } catch {
    errorClass = "ErrorLike";
  }
  return asSha256DigestV1(
    createHash("sha256").update(errorClass, "utf8").digest("hex"),
  );
};

const blockerStage = (
  code: (typeof M7_R3_PREFLIGHT_API_BLOCKER_CODES_V1)[number],
): M7R4NoAgentPreflightStageV1 => {
  switch (code) {
    case "invalid_frozen_inputs":
      return "prepare";
    case "project_environment_port_failed":
    case "invalid_project_environment_evidence":
    case "configured_main_scene_not_observed":
    case "project_environment_lineage_mismatch":
    case "pinned_capture_content_mismatch":
    case "patrol_motion_payload_invalid":
    case "patrol_motion_query_capture_conflict":
    case "patrol_motion_timeline_unavailable":
      return "public_observation";
    case "public_observation_cleanup_not_proven":
      return "cleanup";
    case "hidden_evaluator_port_failed":
    case "invalid_hidden_evaluator_evidence":
      return "hidden_evaluation";
    case "preflight_persistence_failed":
    case "preflight_persistence_substitution":
    case "preflight_evidence_persistence_failed":
    case "preflight_evidence_persistence_substitution":
      return "receipt_persistence";
  }
};

const projectSubjectEvidence = (
  input: M7R4NoAgentPreflightSubjectEvidenceInputV1,
) => {
  const caseOrdinal = caseOrdinalSchema.parse(input.caseOrdinal);
  const caseId = caseIdSchema.parse(input.caseId);
  const subject = subjectSchema.parse(input.subject);
  const cleanupReceipt =
    input.cleanupReceipt === null
      ? null
      : SandboxCleanupReceiptV1Schema.parse(input.cleanupReceipt);
  const cleanupReceiptSha256 = Sha256DigestV1Schema.nullable().parse(
    input.cleanupReceiptSha256,
  );
  if (
    (cleanupReceipt === null) !== (cleanupReceiptSha256 === null) ||
    (cleanupReceipt !== null &&
      cleanupReceiptSha256 !== digestJson(cleanupReceipt))
  ) {
    throw new TypeError(
      "M7 R4 cleanup receipt crossed its supplied content hash",
    );
  }
  const cleanup = cleanupEvidenceSchema.parse({
    attempted: input.cleanupAttempted,
    cleanupProven: input.cleanupProven,
    receipt: cleanupReceipt,
    receiptSha256: cleanupReceiptSha256,
  });

  let security: z.infer<typeof securityEvidenceSchema>;
  if (input.securityEvents === null) {
    if (input.securityEventsSha256 !== null) {
      throw new TypeError(
        "M7 R4 unavailable security events cannot have a strict-list hash",
      );
    }
    security = securityEvidenceSchema.parse({
      available: false,
      events: [],
      eventsSha256: null,
    });
  } else {
    const events = z
      .array(SecurityEventV1Schema)
      .max(1_000)
      .parse(input.securityEvents);
    const eventsSha256 = Sha256DigestV1Schema.parse(input.securityEventsSha256);
    if (eventsSha256 !== digestJson(events)) {
      throw new TypeError(
        "M7 R4 security events crossed their supplied strict-list hash",
      );
    }
    security = securityEvidenceSchema.parse({
      available: true,
      events: events.map((event) => ({
        eventId: event.eventId,
        taskId: event.taskId,
        operationId: event.operationId,
        code: event.code,
        occurredAt: event.occurredAt,
        sideEffectStarted: event.sideEffectStarted,
      })),
      eventsSha256,
    });
  }
  return subjectEvidenceEntrySchema.parse({
    caseOrdinal,
    caseId,
    subject,
    cleanup,
    security,
  });
};

const assertSubjectEvidence = (
  started: M7R4NoAgentPreflightStartedV1,
  evidence: z.infer<typeof subjectEvidenceSchema>,
): void => {
  for (const entry of evidence) {
    const frozenCase = started.cases[entry.caseOrdinal - 1]!;
    if (entry.caseId !== frozenCase.caseId) {
      throw new TypeError(
        "M7 R4 subject evidence crossed its started case identity",
      );
    }
  }
};

const assertReceiptReferences = (
  started: M7R4NoAgentPreflightStartedV1,
  references: readonly M7R4NoAgentPreflightReceiptReferenceV1[],
): void => {
  for (const reference of references) {
    const frozenCase = started.cases[reference.caseOrdinal - 1]!;
    if (
      reference.caseOrdinal !== frozenCase.caseOrdinal ||
      reference.caseId !== frozenCase.caseId
    ) {
      throw new TypeError(
        "M7 R4 preflight receipt reference crossed its started case identity",
      );
    }
  }
};

const assertTerminalTime = (
  started: M7R4NoAgentPreflightStartedV1,
  completedAt: string,
): void => {
  if (Date.parse(completedAt) < Date.parse(started.startedAt)) {
    throw new TypeError("M7 R4 preflight terminal predates its started record");
  }
};

type RecordKind = "started" | "terminal";

const recordName = (kind: RecordKind): string =>
  kind === "started" ? STARTED_RECORD_NAME : TERMINAL_RECORD_NAME;

export class M7R4NoAgentPreflightAttemptStoreV1 {
  readonly #root: string;
  readonly #rootIdentity: RootIdentity;

  private constructor(root: string, rootIdentity: RootIdentity) {
    this.#root = root;
    this.#rootIdentity = rootIdentity;
  }

  public static async open(input: {
    readonly root: string;
    readonly exposedRoots: readonly string[];
  }): Promise<M7R4NoAgentPreflightAttemptStoreV1> {
    const root = await canonicalDirectory(
      input.root,
      "M7 R4 Host-only preflight-attempt root",
      true,
    );
    for (const [index, exposedRoot] of input.exposedRoots.entries()) {
      const exposed = await canonicalDirectory(
        exposedRoot,
        `M7 R4 Agent-exposed root ${index + 1}`,
        false,
      );
      if (
        pathWithinOrEqual(root.path, exposed.path) ||
        pathWithinOrEqual(exposed.path, root.path)
      ) {
        throw new TypeError(
          "M7 R4 Host-only preflight-attempt root must be disjoint from Agent-exposed roots",
        );
      }
    }
    return new M7R4NoAgentPreflightAttemptStoreV1(root.path, root.identity);
  }

  public get root(): string {
    return this.#root;
  }

  async #requireRoot(): Promise<void> {
    const current = await canonicalDirectory(
      this.#root,
      "M7 R4 Host-only preflight-attempt root",
      true,
    );
    if (
      current.identity.dev !== this.#rootIdentity.dev ||
      current.identity.ino !== this.#rootIdentity.ino ||
      current.identity.uid !== this.#rootIdentity.uid ||
      current.identity.mode !== this.#rootIdentity.mode
    ) {
      throw new Error("M7 R4 preflight-attempt root identity changed");
    }
  }

  #path(kind: RecordKind): string {
    const path = resolve(this.#root, recordName(kind));
    if (!pathWithinOrEqual(this.#root, path)) {
      throw new Error("M7 R4 preflight-attempt record escaped its root");
    }
    return path;
  }

  async #writeOnce(kind: RecordKind, value: unknown): Promise<void> {
    await this.#requireRoot();
    const bytes = Buffer.from(
      `${canonicalJson(JsonValueSchema.parse(value))}\n`,
      "utf8",
    );
    if (bytes.byteLength > RECORD_BYTE_LIMIT) {
      throw new Error("M7 R4 preflight-attempt record exceeds its byte limit");
    }
    try {
      await publishPrivateFileOnceV1({
        root: this.#root,
        filename: recordName(kind),
        bytes,
      });
    } catch (error) {
      if (isNodeError(error) && error.code === "EEXIST") {
        throw new Error(
          `M7 R4 preflight ${kind} record already exists; overwrite and retry are forbidden`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  async #read<T>(kind: RecordKind, parse: (value: unknown) => T): Promise<T> {
    await this.#requireRoot();
    const path = this.#path(kind);
    const pathMetadata = await lstat(path);
    if (
      !pathMetadata.isFile() ||
      pathMetadata.isSymbolicLink() ||
      pathMetadata.nlink !== 1 ||
      pathMetadata.uid !== effectiveUserId() ||
      (pathMetadata.mode & 0o7777) !== PRIVATE_FILE_MODE ||
      pathMetadata.size > RECORD_BYTE_LIMIT ||
      (await realpath(path)) !== path
    ) {
      throw new Error(
        "M7 R4 preflight record must remain a canonical one-link owned mode-0600 regular file",
      );
    }
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const opened = await handle.stat();
      if (
        opened.dev !== pathMetadata.dev ||
        opened.ino !== pathMetadata.ino ||
        opened.nlink !== 1 ||
        opened.size !== pathMetadata.size
      ) {
        throw new Error(
          "M7 R4 preflight record identity changed while opening",
        );
      }
      let value: unknown;
      try {
        value = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            await handle.readFile(),
          ),
        );
      } catch (error) {
        throw new Error("M7 R4 preflight record is not valid UTF-8 JSON", {
          cause: error,
        });
      }
      const afterRead = await handle.stat();
      if (
        afterRead.dev !== opened.dev ||
        afterRead.ino !== opened.ino ||
        afterRead.nlink !== 1 ||
        afterRead.size !== opened.size
      ) {
        throw new Error("M7 R4 preflight record changed while reading");
      }
      return parse(value);
    } finally {
      await handle.close();
    }
  }

  public async createStartedOnce(input: {
    readonly portfolioFreeze: unknown;
    readonly startedAt: string;
  }): Promise<M7R4NoAgentPreflightStartedV1> {
    const portfolio = M7R3TwoCasePortfolioFreezeV1Schema.parse(
      input.portfolioFreeze,
    );
    const basis = startedBasisSchema.parse({
      schemaVersion: 1,
      recordKind: "m7-r4-no-agent-preflight-started",
      portfolioId: portfolio.portfolioId,
      portfolioFreezeRecordSha256: portfolio.recordContentSha256,
      cases: portfolio.cases.map((value) => ({
        caseOrdinal: value.ordinal,
        caseId: value.caseId,
      })),
      agentLaunchCount: 0,
      piSessionCount: 0,
      providerInvocationCount: 0,
      startedAt: input.startedAt,
    });
    const started = M7R4NoAgentPreflightStartedV1Schema.parse({
      ...basis,
      recordContentSha256: digestJson(basis),
    });
    await this.#writeOnce("started", started);
    return started;
  }

  public readStarted(): Promise<M7R4NoAgentPreflightStartedV1> {
    return this.#read("started", (value) =>
      M7R4NoAgentPreflightStartedV1Schema.parse(value),
    );
  }

  async #requireStoredStarted(
    input: unknown,
  ): Promise<M7R4NoAgentPreflightStartedV1> {
    const started = M7R4NoAgentPreflightStartedV1Schema.parse(input);
    const stored = await this.readStarted();
    if (!sameJson(started, stored)) {
      throw new TypeError(
        "M7 R4 preflight terminal crossed its stored started record",
      );
    }
    return stored;
  }

  public async createPassedTerminalOnce(input: {
    readonly started: unknown;
    readonly preflightReceipts: readonly [
      M7R4NoAgentPreflightReceiptReferenceV1,
      M7R4NoAgentPreflightReceiptReferenceV1,
    ];
    readonly completedAt: string;
  }): Promise<M7R4NoAgentPreflightTerminalV1 & { readonly status: "passed" }> {
    const started = await this.#requireStoredStarted(input.started);
    const preflightReceipts = passedPreflightReceiptsSchema.parse(
      input.preflightReceipts,
    );
    assertReceiptReferences(started, preflightReceipts);
    const completedAt = timestampSchema.parse(input.completedAt);
    assertTerminalTime(started, completedAt);
    const basis = passedTerminalBasisSchema.parse({
      schemaVersion: 1,
      recordKind: "m7-r4-no-agent-preflight-terminal",
      status: "passed",
      portfolioId: started.portfolioId,
      portfolioFreezeRecordSha256: started.portfolioFreezeRecordSha256,
      startedRecordContentSha256: started.recordContentSha256,
      preflightReceipts,
      agentLaunchCount: 0,
      piSessionCount: 0,
      providerInvocationCount: 0,
      completedAt,
    });
    const terminal = M7R4NoAgentPreflightTerminalV1Schema.parse({
      ...basis,
      recordContentSha256: digestJson(basis),
    });
    if (terminal.status !== "passed") {
      throw new TypeError("M7 R4 passed terminal changed during validation");
    }
    await this.#writeOnce("terminal", terminal);
    return terminal;
  }

  public async createFailedTerminalOnce(input: {
    readonly started: unknown;
    readonly stage: M7R4NoAgentPreflightStageV1;
    readonly caseOrdinal: 1 | 2 | null;
    readonly subject: "pristine" | "mutant" | null;
    readonly error: unknown;
    readonly completedPreflightReceipts: readonly M7R4NoAgentPreflightReceiptReferenceV1[];
    readonly agentLaunchCount: number;
    readonly piSessionCount: number;
    readonly providerInvocationCount: number;
    readonly subjectEvidence: readonly M7R4NoAgentPreflightSubjectEvidenceInputV1[];
    readonly completedAt: string;
  }): Promise<M7R4NoAgentPreflightTerminalV1 & { readonly status: "failed" }> {
    const started = await this.#requireStoredStarted(input.started);
    const preflightReceipts = completedPreflightReceiptsSchema.parse(
      input.completedPreflightReceipts,
    );
    assertReceiptReferences(started, preflightReceipts);
    const context = {
      stage: M7R4NoAgentPreflightStageV1Schema.parse(input.stage),
      caseOrdinal: caseOrdinalSchema.nullable().parse(input.caseOrdinal),
      subject: subjectSchema.nullable().parse(input.subject),
    };
    let blockerCode: z.infer<typeof blockerCodeSchema> | null = null;
    let errorClass: Sha256DigestV1 | null = null;
    if (input.error instanceof M7R3PreflightApiBlockerErrorV1) {
      blockerCode = blockerCodeSchema.parse(input.error.code);
      if (
        input.error.ordinal !== context.caseOrdinal ||
        input.error.subject !== context.subject ||
        blockerStage(blockerCode) !== context.stage
      ) {
        throw new TypeError(
          "M7 R4 typed preflight blocker crossed its supplied failure context",
        );
      }
    } else {
      errorClass = errorClassSha256(input.error);
    }
    const failure = failureSchema.parse({
      ...context,
      blockerCode,
      errorClassSha256: errorClass,
    });
    const completedAt = timestampSchema.parse(input.completedAt);
    assertTerminalTime(started, completedAt);
    const subjectEvidence = subjectEvidenceSchema.parse(
      input.subjectEvidence.map(projectSubjectEvidence),
    );
    assertSubjectEvidence(started, subjectEvidence);
    const basis = failedTerminalBasisSchema.parse({
      schemaVersion: 1,
      recordKind: "m7-r4-no-agent-preflight-terminal",
      status: "failed",
      portfolioId: started.portfolioId,
      portfolioFreezeRecordSha256: started.portfolioFreezeRecordSha256,
      startedRecordContentSha256: started.recordContentSha256,
      preflightReceipts,
      failure,
      agentLaunchCount: input.agentLaunchCount,
      piSessionCount: input.piSessionCount,
      providerInvocationCount: input.providerInvocationCount,
      subjectEvidence,
      completedAt,
    });
    const terminal = M7R4NoAgentPreflightTerminalV1Schema.parse({
      ...basis,
      recordContentSha256: digestJson(basis),
    });
    if (terminal.status !== "failed") {
      throw new TypeError("M7 R4 failed terminal changed during validation");
    }
    await this.#writeOnce("terminal", terminal);
    return terminal;
  }

  public async readTerminal(): Promise<M7R4NoAgentPreflightTerminalV1> {
    const [started, terminal] = await Promise.all([
      this.readStarted(),
      this.#read("terminal", (value) =>
        M7R4NoAgentPreflightTerminalV1Schema.parse(value),
      ),
    ]);
    if (
      terminal.portfolioId !== started.portfolioId ||
      terminal.portfolioFreezeRecordSha256 !==
        started.portfolioFreezeRecordSha256 ||
      terminal.startedRecordContentSha256 !== started.recordContentSha256
    ) {
      throw new TypeError(
        "M7 R4 preflight terminal crossed its stored started record",
      );
    }
    assertReceiptReferences(started, terminal.preflightReceipts);
    if (terminal.status === "failed") {
      assertSubjectEvidence(started, terminal.subjectEvidence);
    }
    assertTerminalTime(started, terminal.completedAt);
    return terminal;
  }
}

export const openM7R4NoAgentPreflightAttemptStoreV1 = (input: {
  readonly root: string;
  readonly exposedRoots: readonly string[];
}): Promise<M7R4NoAgentPreflightAttemptStoreV1> =>
  M7R4NoAgentPreflightAttemptStoreV1.open(input);
