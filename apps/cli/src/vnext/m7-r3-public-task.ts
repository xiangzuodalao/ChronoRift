import { createHash } from "node:crypto";

import {
  JsonValueSchema,
  Sha256DigestV1Schema,
  asSha256DigestV1,
} from "@chronorift/domain";
import { canonicalJson } from "@chronorift/json-artifacts";
import { z } from "zod";

import {
  ExternalHiddenFixPublicTaskSpecV1Schema,
  type ExternalHiddenFixPublicTaskSpecV1,
} from "./external-hidden-fix-assignment.js";
import {
  M7R3NaturalUserPromptV1Schema,
  createM7R3NaturalUserPromptV1,
} from "./m7-r3-paired-agent.js";

const digest = (bytes: string | Uint8Array) =>
  asSha256DigestV1(createHash("sha256").update(bytes).digest("hex"));
const digestJson = (value: unknown) =>
  digest(canonicalJson(JsonValueSchema.parse(value)));
const sameJson = (left: unknown, right: unknown): boolean =>
  canonicalJson(JsonValueSchema.parse(left)) ===
  canonicalJson(JsonValueSchema.parse(right));

const taskReferenceSchema = z
  .object({
    taskId: ExternalHiddenFixPublicTaskSpecV1Schema.shape.taskId,
    rawByteLength: z
      .number()
      .int()
      .min(1)
      .max(4 * 1024 * 1024),
    rawSha256: Sha256DigestV1Schema,
  })
  .strict();

const basisSchema = z
  .object({
    schemaVersion: z.literal(1),
    recordKind: z.literal("m7-r3-paired-public-task-contract"),
    caseOrdinal: z.union([z.literal(1), z.literal(2)]),
    subjectRepository: z.string().url().max(2_048),
    subjectCommit: ExternalHiddenFixPublicTaskSpecV1Schema.shape.subjectCommit,
    naturalPrompt: M7R3NaturalUserPromptV1Schema,
    armOrder: z.tuple([z.literal("runtime_enabled"), z.literal("code_only")]),
    treatmentDifference: z.literal("chronorift_runtime_surface"),
    runtimeUseNotRequiredByPrompt: z.literal(true),
    runtimeTask: taskReferenceSchema,
    codeOnlyTask: taskReferenceSchema,
    publicExecutionClassifier:
      ExternalHiddenFixPublicTaskSpecV1Schema.shape.publicExecutionClassifier,
    agentConfiguration:
      ExternalHiddenFixPublicTaskSpecV1Schema.shape.agentBudget,
    evaluatorPlan:
      ExternalHiddenFixPublicTaskSpecV1Schema.shape.evaluatorBudget,
  })
  .strict();

export const M7R3PairedPublicTaskContractV1Schema = basisSchema
  .extend({ recordContentSha256: Sha256DigestV1Schema })
  .strict()
  .superRefine((value, context) => {
    if (value.runtimeTask.taskId === value.codeOnlyTask.taskId) {
      context.addIssue({
        code: "custom",
        path: ["codeOnlyTask", "taskId"],
        message: "R3 paired public Tasks require distinct Task identities",
      });
    }
    const { recordContentSha256, ...basis } = value;
    if (recordContentSha256 !== digestJson(basis)) {
      context.addIssue({
        code: "custom",
        path: ["recordContentSha256"],
        message: "R3 paired public Task contract hash does not match",
      });
    }
  });
export type M7R3PairedPublicTaskContractV1 = z.infer<
  typeof M7R3PairedPublicTaskContractV1Schema
>;

const parseCanonicalTaskBytes = (
  bytesInput: string | Uint8Array,
  label: string,
): {
  readonly bytes: Uint8Array;
  readonly spec: ExternalHiddenFixPublicTaskSpecV1;
} => {
  const bytes =
    typeof bytesInput === "string"
      ? new TextEncoder().encode(bytesInput)
      : Uint8Array.from(bytesInput);
  if (bytes.byteLength < 1 || bytes.byteLength > 4 * 1024 * 1024) {
    throw new TypeError(`${label} has an unsupported byte length`);
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw new TypeError(`${label} must be UTF-8 JSON`, { cause: error });
  }
  const spec = ExternalHiddenFixPublicTaskSpecV1Schema.parse(value);
  if (
    !Buffer.from(bytes).equals(
      Buffer.from(canonicalJson(JsonValueSchema.parse(spec)), "utf8"),
    )
  ) {
    throw new TypeError(`${label} must use exact canonical JSON bytes`);
  }
  return { bytes, spec };
};

export const createM7R3PairedPublicTaskContractV1 = (input: {
  readonly caseOrdinal: 1 | 2;
  readonly subjectRepository: string;
  readonly naturalPrompt: string;
  readonly runtimeTaskSpecBytes: string | Uint8Array;
  readonly codeOnlyTaskSpecBytes: string | Uint8Array;
}): M7R3PairedPublicTaskContractV1 => {
  const runtime = parseCanonicalTaskBytes(
    input.runtimeTaskSpecBytes,
    "R3 runtime public Task",
  );
  const codeOnly = parseCanonicalTaskBytes(
    input.codeOnlyTaskSpecBytes,
    "R3 code-only public Task",
  );
  const naturalPrompt = createM7R3NaturalUserPromptV1(input.naturalPrompt);
  if (
    runtime.spec.taskId === codeOnly.spec.taskId ||
    runtime.spec.subjectCommit !== codeOnly.spec.subjectCommit ||
    runtime.spec.goal !== naturalPrompt.text ||
    codeOnly.spec.goal !== naturalPrompt.text ||
    !sameJson(
      runtime.spec.publicExecutionClassifier,
      codeOnly.spec.publicExecutionClassifier,
    ) ||
    !sameJson(runtime.spec.agentBudget, codeOnly.spec.agentBudget) ||
    !sameJson(runtime.spec.evaluatorBudget, codeOnly.spec.evaluatorBudget)
  ) {
    throw new TypeError(
      "R3 paired public Tasks may differ only by their fresh Task identity",
    );
  }
  const basis = basisSchema.parse({
    schemaVersion: 1,
    recordKind: "m7-r3-paired-public-task-contract",
    caseOrdinal: input.caseOrdinal,
    subjectRepository: input.subjectRepository,
    subjectCommit: runtime.spec.subjectCommit,
    naturalPrompt,
    armOrder: ["runtime_enabled", "code_only"],
    treatmentDifference: "chronorift_runtime_surface",
    runtimeUseNotRequiredByPrompt: true,
    runtimeTask: {
      taskId: runtime.spec.taskId,
      rawByteLength: runtime.bytes.byteLength,
      rawSha256: digest(runtime.bytes),
    },
    codeOnlyTask: {
      taskId: codeOnly.spec.taskId,
      rawByteLength: codeOnly.bytes.byteLength,
      rawSha256: digest(codeOnly.bytes),
    },
    publicExecutionClassifier: runtime.spec.publicExecutionClassifier,
    agentConfiguration: runtime.spec.agentBudget,
    evaluatorPlan: runtime.spec.evaluatorBudget,
  });
  return M7R3PairedPublicTaskContractV1Schema.parse({
    ...basis,
    recordContentSha256: digestJson(basis),
  });
};

export const encodeM7R3PairedPublicTaskContractV1 = (
  contract: M7R3PairedPublicTaskContractV1,
): Uint8Array =>
  new TextEncoder().encode(
    canonicalJson(M7R3PairedPublicTaskContractV1Schema.parse(contract)),
  );
