import { createHash } from "node:crypto";

import type { JsonValue } from "@chronorift/domain";

export const canonicalStringify = (value: JsonValue): string => {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalStringify).join(",")}]`;
  }
  const fields = Object.keys(value)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalStringify(value[key] as JsonValue)}`,
    );
  return `{${fields.join(",")}}`;
};

export const digestJson = (value: JsonValue): string =>
  `sha256:${createHash("sha256").update(canonicalStringify(value)).digest("hex")}`;

export const jsonEqual = (left: JsonValue, right: JsonValue): boolean =>
  canonicalStringify(left) === canonicalStringify(right);
