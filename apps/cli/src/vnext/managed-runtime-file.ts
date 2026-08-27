import { Sha256DigestV1Schema, type Sha256DigestV1 } from "@chronorift/domain";
import { z } from "zod";

export interface ManagedRuntimeFileV1 {
  readonly relativePath: string;
  readonly byteLength: number;
  readonly sha256: Sha256DigestV1;
}

export const ManagedRuntimeFileV1Schema: z.ZodType<ManagedRuntimeFileV1> = z
  .object({
    relativePath: z
      .string()
      .min(1)
      .max(256)
      .refine(
        (value) =>
          !value.startsWith("/") &&
          !value.includes("\\") &&
          !value.includes("\0") &&
          value
            .split("/")
            .every(
              (segment) =>
                segment.length > 0 && segment !== "." && segment !== "..",
            ),
        "managed runtime path must be normalized and relative",
      ),
    byteLength: z
      .number()
      .int()
      .min(1)
      .max(1024 * 1024),
    sha256: Sha256DigestV1Schema,
  })
  .strict();
