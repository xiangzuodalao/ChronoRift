import { createHash } from "node:crypto";

import type { JsonValue } from "@chronorift/domain";

function normalize(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map((item) => normalize(item));
  }

  if (value !== null && typeof value === "object") {
    const normalized: Record<string, JsonValue> = {};
    for (const key of Object.keys(value).sort()) {
      const item = value[key];
      if (item !== undefined) {
        normalized[key] = normalize(item);
      }
    }
    return normalized;
  }

  return value;
}

export function canonicalJson(value: JsonValue): string {
  return JSON.stringify(normalize(value));
}

export function contentHash(value: JsonValue): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
