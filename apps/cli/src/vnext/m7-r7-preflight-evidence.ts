import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  JsonValueSchema,
  Sha256DigestV1Schema,
  TaskIdSchema,
} from "@chronorift/domain";
import { canonicalJson } from "@chronorift/json-artifacts";
import { z } from "zod";

import {
  M7R3CasePreflightEvidenceRecordV1Schema,
  type M7R3CasePreflightEvidencePersistencePortV1,
  type M7R3CasePreflightEvidenceRecordV1,
} from "./m7-r3-case-preflight-runner.js";
import {
  publishM7R7PrivateFileOnceV1,
  repairM7R7PrivatePublicationsV1,
} from "./m7-r7-private-publication.js";
import {
  SANDBOX_TASK_STORAGE_MINIMUM_HEADROOM_BYTES_V1,
  SANDBOX_TASK_STORAGE_MINIMUM_HEADROOM_INODES_V1,
} from "./sandbox-preflight.js";
import type { ExternalHiddenFixEvaluatorHeadroomObservationV1 } from "./external-hidden-fix-evaluator.js";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

const sha256 = (bytes: string | Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

const digestJson = (value: unknown): string =>
  sha256(canonicalJson(JsonValueSchema.parse(value)));

const headroomSchema = z
  .object({
    schemaVersion: z.literal(1),
    availableBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    availableInodes: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER),
    requiredAvailableBytes: z.literal(
      SANDBOX_TASK_STORAGE_MINIMUM_HEADROOM_BYTES_V1,
    ),
    requiredAvailableInodes: z.literal(
      SANDBOX_TASK_STORAGE_MINIMUM_HEADROOM_INODES_V1,
    ),
  })
  .strict();

const evaluatorHeadroomBasisSchema = z
  .object({
    schemaVersion: z.literal(1),
    recordKind: z.literal("m7-r7-evaluator-headroom-evidence"),
    caseOrdinal: z.union([z.literal(1), z.literal(2)]),
    caseId: z.string().min(1).max(256),
    taskId: TaskIdSchema,
    boundary: z.literal("no_agent_hidden_evaluator"),
    runOrdinal: z.number().int().min(1).max(64),
    taskStorage: headroomSchema,
    evaluatorStorage: headroomSchema,
    observedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export const M7R7EvaluatorHeadroomEvidenceV1Schema =
  evaluatorHeadroomBasisSchema
    .extend({ recordContentSha256: Sha256DigestV1Schema })
    .strict()
    .superRefine((value, context) => {
      const { recordContentSha256, ...basis } = value;
      if (recordContentSha256 !== digestJson(basis)) {
        context.addIssue({
          code: "custom",
          path: ["recordContentSha256"],
          message: "evaluator headroom evidence content hash does not match",
        });
      }
    });
export type M7R7EvaluatorHeadroomEvidenceV1 = z.infer<
  typeof M7R7EvaluatorHeadroomEvidenceV1Schema
>;

export interface M7R7PreflightEvidenceStoreV1 extends M7R3CasePreflightEvidencePersistencePortV1 {
  persistEvaluatorHeadroomOnce(input: {
    readonly taskId: string;
    readonly observation: ExternalHiddenFixEvaluatorHeadroomObservationV1;
  }): Promise<M7R7EvaluatorHeadroomEvidenceV1>;
}

const requirePrivateRoot = async (rootInput: string): Promise<string> => {
  const root = resolve(rootInput);
  const [metadata, canonical] = await Promise.all([
    lstat(root),
    realpath(root),
  ]);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== process.geteuid?.() ||
    (metadata.mode & 0o7777) !== PRIVATE_DIRECTORY_MODE ||
    canonical !== root
  ) {
    throw new Error("R7 preflight evidence root must be canonical and private");
  }
  return root;
};

const evidenceFilename = (record: M7R3CasePreflightEvidenceRecordV1): string =>
  record.evidenceKind === "public_observation"
    ? `public-${record.subject}.json`
    : `hidden-${record.subject}-${sha256(record.scenarioId ?? "")}.json`;

const parseCanonicalEvidenceBytes = (
  filename: string,
  bytes: Uint8Array,
): M7R3CasePreflightEvidenceRecordV1 => {
  const record = M7R3CasePreflightEvidenceRecordV1Schema.parse(
    JSON.parse(
      new TextDecoder("utf8", { fatal: true }).decode(bytes),
    ) as unknown,
  );
  if (
    evidenceFilename(record) !== filename ||
    !Buffer.from(bytes).equals(
      Buffer.from(`${canonicalJson(JsonValueSchema.parse(record))}\n`, "utf8"),
    )
  ) {
    throw new Error("R7 preflight evidence publication changed identity");
  }
  return record;
};

const parseCanonicalHeadroomBytes = (
  filename: string,
  bytes: Uint8Array,
): M7R7EvaluatorHeadroomEvidenceV1 => {
  const record = M7R7EvaluatorHeadroomEvidenceV1Schema.parse(
    JSON.parse(
      new TextDecoder("utf8", { fatal: true }).decode(bytes),
    ) as unknown,
  );
  const expectedFilename = `evaluator-headroom-${String(
    record.runOrdinal,
  ).padStart(6, "0")}.json`;
  if (
    filename !== expectedFilename ||
    !Buffer.from(bytes).equals(
      Buffer.from(`${canonicalJson(JsonValueSchema.parse(record))}\n`, "utf8"),
    )
  ) {
    throw new Error("R7 evaluator headroom publication changed identity");
  }
  return record;
};

export const repairM7R7PreflightEvidencePublicationsV1 = async (root: string) =>
  repairM7R7PrivatePublicationsV1({
    root,
    validatePublishedBytes: (filename, bytes) => {
      if (filename.startsWith("evaluator-headroom-")) {
        parseCanonicalHeadroomBytes(filename, bytes);
      } else {
        parseCanonicalEvidenceBytes(filename, bytes);
      }
    },
  });

export const openM7R7PreflightEvidenceStoreV1 = async (input: {
  readonly root: string;
  readonly ordinal: 1 | 2;
}): Promise<M7R7PreflightEvidenceStoreV1> => {
  const root = await requirePrivateRoot(input.root);
  let caseId: string | null = null;
  const bindCaseId = (candidate: string): void => {
    if (caseId !== null && candidate !== caseId) {
      throw new Error("R7 preflight evidence crossed its case identity");
    }
    caseId = candidate;
  };
  return Object.freeze({
    persistEvidenceOnce: async (
      evidence: M7R3CasePreflightEvidenceRecordV1,
    ): Promise<unknown> => {
      const record = M7R3CasePreflightEvidenceRecordV1Schema.parse(evidence);
      if (record.ordinal !== input.ordinal) {
        throw new Error("R7 preflight evidence crossed its case identity");
      }
      bindCaseId(record.caseId);
      const path = join(root, evidenceFilename(record));
      const bytes = Buffer.from(
        `${canonicalJson(JsonValueSchema.parse(record))}\n`,
        "utf8",
      );
      try {
        await publishM7R7PrivateFileOnceV1({
          root,
          filename: evidenceFilename(record),
          bytes,
        });
      } catch (error) {
        throw new Error("R7 preflight evidence is create-once", {
          cause: error,
        });
      }
      const [metadata, canonical, retainedBytes] = await Promise.all([
        lstat(path),
        realpath(path),
        readFile(path),
      ]);
      if (
        !metadata.isFile() ||
        metadata.isSymbolicLink() ||
        metadata.uid !== process.geteuid?.() ||
        (metadata.mode & 0o7777) !== PRIVATE_FILE_MODE ||
        metadata.nlink !== 1 ||
        canonical !== path ||
        !Buffer.from(retainedBytes).equals(bytes)
      ) {
        throw new Error("R7 preflight evidence changed during persistence");
      }
      return parseCanonicalEvidenceBytes(
        evidenceFilename(record),
        retainedBytes,
      );
    },
    persistEvaluatorHeadroomOnce: async (candidate: {
      readonly taskId: string;
      readonly observation: ExternalHiddenFixEvaluatorHeadroomObservationV1;
    }) => {
      if (caseId === null) {
        throw new Error(
          "R7 evaluator headroom cannot precede public case evidence",
        );
      }
      const observation = candidate.observation;
      const basis = evaluatorHeadroomBasisSchema.parse({
        schemaVersion: 1,
        recordKind: "m7-r7-evaluator-headroom-evidence",
        caseOrdinal: input.ordinal,
        caseId,
        taskId: candidate.taskId,
        boundary: "no_agent_hidden_evaluator",
        runOrdinal: observation.runOrdinal,
        taskStorage: observation.taskStorage,
        evaluatorStorage: observation.evaluatorStorage,
        observedAt: observation.observedAt,
      });
      const record = M7R7EvaluatorHeadroomEvidenceV1Schema.parse({
        ...basis,
        recordContentSha256: digestJson(basis),
      });
      const filename = `evaluator-headroom-${String(record.runOrdinal).padStart(
        6,
        "0",
      )}.json`;
      const bytes = Buffer.from(
        `${canonicalJson(JsonValueSchema.parse(record))}\n`,
        "utf8",
      );
      try {
        await publishM7R7PrivateFileOnceV1({ root, filename, bytes });
      } catch (error) {
        throw new Error("R7 evaluator headroom evidence is create-once", {
          cause: error,
        });
      }
      return parseCanonicalHeadroomBytes(
        filename,
        await readFile(join(root, filename)),
      );
    },
  });
};
