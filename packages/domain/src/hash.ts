import { createHash } from "node:crypto";

import { z } from "zod";

import type { TaskId } from "./ids.js";

declare const sha256Brand: unique symbol;
export type Sha256DigestV1 = string & {
  readonly [sha256Brand]: "Sha256DigestV1";
};

export const Sha256DigestV1Schema = z
  .string()
  .regex(/^[a-f0-9]{64}$/u) as unknown as z.ZodType<Sha256DigestV1>;

export const asSha256DigestV1 = (value: string): Sha256DigestV1 =>
  Sha256DigestV1Schema.parse(value);

export const taskNamespaceDigestV1 = (taskId: TaskId): Sha256DigestV1 =>
  asSha256DigestV1(
    createHash("sha256")
      .update("chronorift-task-namespace-v1\0")
      .update(taskId)
      .digest("hex"),
  );
