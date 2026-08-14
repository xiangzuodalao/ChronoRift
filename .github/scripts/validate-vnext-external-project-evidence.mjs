#!/usr/bin/env node

import { readFile } from "node:fs/promises";

const [schemaPath, evidencePath, ...unexpectedArguments] =
  process.argv.slice(2);

const fail = (message) => {
  throw new Error(`invalid M4 external-project evidence summary: ${message}`);
};

if (schemaPath === undefined || evidencePath === undefined) {
  fail("usage: validate-vnext-external-project-evidence.mjs SCHEMA EVIDENCE");
}
if (unexpectedArguments.length !== 0) {
  fail("unexpected command-line arguments");
}

const parseJson = (bytes, label) => {
  if (bytes.includes(0)) {
    fail(`${label} contains a NUL byte`);
  }
  const text = bytes.toString("utf8");
  if (text.includes("\uFFFD")) {
    fail(`${label} is not valid UTF-8`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(`${label} is not valid JSON: ${String(error)}`);
  }
};

const schemaBytes = await readFile(schemaPath);
const evidenceBytes = await readFile(evidencePath);
if (evidenceBytes.byteLength === 0 || evidenceBytes.byteLength > 65_536) {
  fail("evidence bytes must be between 1 and 65536 bytes");
}

const rootSchema = parseJson(schemaBytes, "schema");
const evidence = parseJson(evidenceBytes, "evidence");

const isPlainObject = (value) =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

if (!isPlainObject(rootSchema)) {
  fail("schema root must be an object");
}
if (
  rootSchema.$id !==
  "https://chronorift.invalid/test-only/m4-external-project-evidence-summary.v1.schema.json"
) {
  fail("unexpected schema identity");
}

const sameJsonValue = (left, right) =>
  JSON.stringify(left) === JSON.stringify(right);

const resolveReference = (reference) => {
  if (!reference.startsWith("#/")) {
    fail(`unsupported schema reference ${reference}`);
  }
  let current = rootSchema;
  for (const encodedSegment of reference.slice(2).split("/")) {
    const segment = encodedSegment.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!isPlainObject(current) || !Object.hasOwn(current, segment)) {
      fail(`schema reference does not resolve: ${reference}`);
    }
    current = current[segment];
  }
  if (!isPlainObject(current)) {
    fail(`schema reference is not an object: ${reference}`);
  }
  return current;
};

const matchesType = (value, type) => {
  switch (type) {
    case "object":
      return isPlainObject(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "integer":
      return Number.isSafeInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      fail(`unsupported schema type ${String(type)}`);
  }
};

const validate = (schema, value, location) => {
  if (!isPlainObject(schema)) {
    fail(`${location} has a non-object schema`);
  }
  if (schema.$ref !== undefined) {
    if (typeof schema.$ref !== "string") {
      fail(`${location} has a non-string schema reference`);
    }
    validate(resolveReference(schema.$ref), value, location);
    return;
  }
  if (Object.hasOwn(schema, "const") && !sameJsonValue(value, schema.const)) {
    fail(`${location} does not equal its frozen value`);
  }
  if (schema.enum !== undefined) {
    if (!Array.isArray(schema.enum)) {
      fail(`${location} has a non-array enum schema`);
    }
    if (!schema.enum.some((entry) => sameJsonValue(entry, value))) {
      fail(`${location} is not an allowed value`);
    }
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => matchesType(value, type))) {
      fail(`${location} has the wrong type`);
    }
  }

  if (typeof value === "string") {
    if (schema.pattern !== undefined) {
      if (typeof schema.pattern !== "string") {
        fail(`${location} has a non-string pattern schema`);
      }
      if (!new RegExp(schema.pattern, "u").test(value)) {
        fail(`${location} does not match its required pattern`);
      }
    }
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      fail(`${location} is shorter than its minimum length`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      fail(`${location} is longer than its maximum length`);
    }
  }

  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      fail(`${location} is below its minimum`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      fail(`${location} exceeds its maximum`);
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      fail(`${location} has too few items`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      fail(`${location} has too many items`);
    }
    if (schema.items !== undefined) {
      value.forEach((entry, index) =>
        validate(schema.items, entry, `${location}[${index}]`),
      );
    }
  }

  if (isPlainObject(value)) {
    const properties = schema.properties ?? {};
    if (!isPlainObject(properties)) {
      fail(`${location} has a non-object properties schema`);
    }
    const required = schema.required ?? [];
    if (!Array.isArray(required)) {
      fail(`${location} has a non-array required schema`);
    }
    for (const key of required) {
      if (typeof key !== "string" || !Object.hasOwn(value, key)) {
        fail(`${location}.${String(key)} is required`);
      }
    }
    for (const [key, entry] of Object.entries(value)) {
      if (Object.hasOwn(properties, key)) {
        validate(properties[key], entry, `${location}.${key}`);
      } else if (schema.additionalProperties === false) {
        fail(`${location}.${key} is not allowed`);
      } else if (isPlainObject(schema.additionalProperties)) {
        validate(schema.additionalProperties, entry, `${location}.${key}`);
      }
    }
  }
};

validate(rootSchema, evidence, "$evidence");

for (const operation of [evidence.runtime.import, evidence.runtime.vanilla]) {
  for (const stream of [operation.stdout, operation.stderr]) {
    if (stream.retainedBytes > stream.totalBytes) {
      fail("diagnostic retainedBytes exceeds totalBytes");
    }
    if (!stream.truncated && stream.retainedBytes !== stream.totalBytes) {
      fail("a non-truncated diagnostic stream must retain every byte");
    }
    if (stream.truncated && stream.retainedBytes >= stream.totalBytes) {
      fail("a truncated diagnostic stream must omit at least one byte");
    }
  }
}

if (
  evidence.runtime.overlay.hostMonotonicEndUs <
  evidence.runtime.overlay.hostMonotonicStartUs
) {
  fail("overlay Host monotonic bounds are reversed");
}

process.stdout.write("validated strict M4 external-project evidence summary\n");
