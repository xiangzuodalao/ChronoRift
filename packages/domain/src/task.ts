import { z } from "zod";

import { Sha256DigestV1Schema, type Sha256DigestV1 } from "./hash.js";
import {
  ExecutionIdSchema,
  PatchIdSchema,
  TaskIdSchema,
  type ExecutionId,
  type PatchId,
  type TaskId,
} from "./ids.js";

export interface TaskIdentityV1 {
  readonly schemaVersion: 1;
  readonly taskId: TaskId;
  readonly createdAt: string;
}

export interface TaskWorkspaceIdentityV1 {
  readonly schemaVersion: 1;
  readonly taskId: TaskId;
  readonly sourceRevision: string;
  readonly baselineSourceHash: Sha256DigestV1;
}

export interface TaskExecutionIdentityV1 {
  readonly schemaVersion: 1;
  readonly taskId: TaskId;
  readonly executionId: ExecutionId;
  readonly inputSourceHash: Sha256DigestV1;
}

export interface TaskPatchIdentityV1 {
  readonly schemaVersion: 1;
  readonly patchId: PatchId;
  readonly taskId: TaskId;
  readonly baselineSourceHash: Sha256DigestV1;
  readonly candidateSourceHash: Sha256DigestV1;
  readonly patchHash: Sha256DigestV1;
  readonly byteLength: number;
}

export const TaskIdentityV1Schema: z.ZodType<TaskIdentityV1> = z
  .object({
    schemaVersion: z.literal(1),
    taskId: TaskIdSchema,
    createdAt: z.string().datetime(),
  })
  .strict();

export const TaskWorkspaceIdentityV1Schema: z.ZodType<TaskWorkspaceIdentityV1> =
  z
    .object({
      schemaVersion: z.literal(1),
      taskId: TaskIdSchema,
      sourceRevision: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u),
      baselineSourceHash: Sha256DigestV1Schema,
    })
    .strict();

export const TaskExecutionIdentityV1Schema: z.ZodType<TaskExecutionIdentityV1> =
  z
    .object({
      schemaVersion: z.literal(1),
      taskId: TaskIdSchema,
      executionId: ExecutionIdSchema,
      inputSourceHash: Sha256DigestV1Schema,
    })
    .strict();

export const TaskPatchIdentityV1Schema: z.ZodType<TaskPatchIdentityV1> = z
  .object({
    schemaVersion: z.literal(1),
    patchId: PatchIdSchema,
    taskId: TaskIdSchema,
    baselineSourceHash: Sha256DigestV1Schema,
    candidateSourceHash: Sha256DigestV1Schema,
    patchHash: Sha256DigestV1Schema,
    byteLength: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.patchId !== `patch:v1:${value.patchHash}`) {
      context.addIssue({
        code: "custom",
        path: ["patchId"],
        message:
          "patchId must equal the patch:v1: prefix followed by patchHash",
      });
    }
  });
