import { Type, type Static } from "typebox";
import { Check } from "typebox/value";

/**
 * An opaque, Session-scoped reference. Its meaning is resolved by the Harness;
 * the value must never be interpreted as an artifact ID or filesystem path.
 */
export const ResourceHandleV1Schema = Type.String({
  minLength: 11,
  maxLength: 67,
  pattern: "^rh_[A-Za-z0-9][A-Za-z0-9_-]{7,63}$",
  description: "Opaque Session-scoped resource handle",
});

export type ResourceHandleV1 = Static<typeof ResourceHandleV1Schema>;

export function isResourceHandleV1(value: unknown): value is ResourceHandleV1 {
  return Check(ResourceHandleV1Schema, value);
}

export function parseResourceHandleV1(value: unknown): ResourceHandleV1 {
  if (!isResourceHandleV1(value)) {
    throw new TypeError("Invalid ResourceHandleV1");
  }
  return value;
}
