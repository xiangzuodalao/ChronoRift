#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);

export const M5_DEFAULT_VALIDATION_PROFILE_V1 = Object.freeze({
  taskSpecRawSha256:
    "c9cb447748b7d4cbd81554fa67c0432e84a9761781de8d7355e5533f16ffb199",
  schemaRawSha256:
    "365ab2b008978e4d3eb987012fdad5411bb658d570770501405d242ef73bfd76",
  schemaPath: join(
    REPOSITORY_ROOT,
    "testdata/vnext/m5/evidence-bundle.schema.v1.json",
  ),
});

export async function validateVNextM5Evidence(argv, validationProfile = {}) {
  const [taskSpecPath, schemaPath, bundleRootPath, baselineRootPath, ...extra] =
    argv;

  const fail = (message) => {
    throw new Error(`invalid vNext M5 evidence bundle: ${message}`);
  };

  if (
    taskSpecPath === undefined ||
    schemaPath === undefined ||
    bundleRootPath === undefined ||
    baselineRootPath === undefined ||
    extra.length !== 0
  ) {
    fail("expected TASK_SPEC EVIDENCE_SCHEMA BUNDLE_ROOT BASELINE_SOURCE_ROOT");
  }

  const SCHEMA_PATH =
    validationProfile.schemaPath ?? M5_DEFAULT_VALIDATION_PROFILE_V1.schemaPath;
  const TASK_SPEC_RAW_SHA256 =
    validationProfile.taskSpecRawSha256 ??
    M5_DEFAULT_VALIDATION_PROFILE_V1.taskSpecRawSha256;
  const SCHEMA_RAW_SHA256 =
    validationProfile.schemaRawSha256 ??
    M5_DEFAULT_VALIDATION_PROFILE_V1.schemaRawSha256;
  const SCHEMA_ID =
    "https://chronorift.invalid/evidence/m5-public-exposed-behavior-change-bundle.v1.schema.json";
  const MAX_JSON_BYTES = 8 * 1024 * 1024;
  const MAX_PATCH_BYTES = 512 * 1024 * 1024;
  const MAX_EVENT_LEDGER_BYTES = 2_097_152;
  const MAX_TREE_FILES = 4_096;
  const MAX_TREE_BYTES = 256 * 1024 * 1024;
  const SHA256 = /^[a-f0-9]{64}$/u;
  const EXPECTED_FILES = Object.freeze([
    "candidate.patch",
    "cleanup-receipt.json",
    "manifest.json",
    "patch-export-receipt.json",
    "runtime-records/baseline/build.json",
    "runtime-records/baseline/events.jsonl",
    "runtime-records/baseline/execution-seal.json",
    "runtime-records/baseline/execution.json",
    "runtime-records/baseline/runtime.json",
    "runtime-records/candidate/build.json",
    "runtime-records/candidate/events.jsonl",
    "runtime-records/candidate/execution-seal.json",
    "runtime-records/candidate/execution.json",
    "runtime-records/candidate/runtime.json",
    "summary.json",
  ]);
  const EXPECTED_DIRECTORIES = Object.freeze([
    "runtime-records",
    "runtime-records/baseline",
    "runtime-records/candidate",
  ]);

  const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

  const plainObject = (value, label) => {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    ) {
      fail(`${label} must be a plain object`);
    }
    return value;
  };

  const exact = (actual, expected, label) => {
    if (canonicalJson(actual) !== canonicalJson(expected)) {
      fail(`${label} does not equal its required value`);
    }
  };

  const exactKeys = (value, keys, label) => {
    const actual = Object.keys(plainObject(value, label)).sort();
    const expected = [...keys].sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      fail(`${label} contains a missing or unknown field`);
    }
  };

  const integer = (value, minimum, maximum, label) => {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
      fail(`${label} is outside its integer bounds`);
    }
    return value;
  };

  const finite = (value, minimum, maximum, label) => {
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < minimum ||
      value > maximum
    ) {
      fail(`${label} is outside its numeric bounds`);
    }
    return value;
  };

  const digest = (value, label) => {
    if (typeof value !== "string" || !SHA256.test(value)) {
      fail(`${label} is not a SHA-256 digest`);
    }
    return value;
  };

  const nonemptyString = (value, label, maximum = 4_096) => {
    if (
      typeof value !== "string" ||
      value.length < 1 ||
      value.length > maximum ||
      value.includes("\0")
    ) {
      fail(`${label} is not a bounded string`);
    }
    return value;
  };

  const opaqueId = (value, label) => {
    if (
      typeof value !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value) ||
      value.includes("..")
    ) {
      fail(`${label} is not a bounded opaque resource ID`);
    }
    return value;
  };

  const resourcePath = (value, label) => {
    if (
      typeof value !== "string" ||
      value.length < 7 ||
      value.length > 512 ||
      !value.startsWith("res://") ||
      value.includes("\\") ||
      value.includes("\0") ||
      value.split("/").includes("..")
    ) {
      fail(`${label} is not a bounded non-traversing Godot resource path`);
    }
    return value;
  };

  const canonicalJson = (value) => {
    if (value === null || typeof value === "boolean")
      return JSON.stringify(value);
    if (typeof value === "number") {
      if (!Number.isFinite(value))
        fail("canonical JSON contains a non-finite number");
      return JSON.stringify(value);
    }
    if (typeof value === "string") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
    const entry = plainObject(value, "canonical JSON value");
    return `{${Object.keys(entry)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(entry[key])}`)
      .join(",")}}`;
  };

  const contentHash = (value) =>
    sha256(Buffer.from(canonicalJson(value), "utf8"));

  const verifyOwnContentHash = (value, field, label) => {
    const entry = plainObject(value, label);
    const claimed = digest(entry[field], `${label}.${field}`);
    const basis = Object.fromEntries(
      Object.entries(entry).filter(([key]) => key !== field),
    );
    exact(claimed, contentHash(basis), `${label} content hash`);
    return claimed;
  };

  const assertNoDuplicateObjectKeys = (text, label) => {
    let index = 0;
    const whitespace = () => {
      while (/\s/u.test(text[index] ?? "")) index += 1;
    };
    const parseStringToken = () => {
      const start = index;
      index += 1;
      while (index < text.length) {
        if (text[index] === "\\") {
          index += 2;
          continue;
        }
        index += 1;
        if (text[index - 1] === '"')
          return JSON.parse(text.slice(start, index));
      }
      fail(`${label} contains an unterminated string`);
    };
    const parseValue = () => {
      whitespace();
      const character = text[index];
      if (character === "{") {
        index += 1;
        whitespace();
        const keys = new Set();
        if (text[index] === "}") {
          index += 1;
          return;
        }
        while (index < text.length) {
          if (text[index] !== '"') fail(`${label} has an invalid object key`);
          const key = parseStringToken();
          if (keys.has(key))
            fail(`${label} contains duplicate object key ${key}`);
          keys.add(key);
          whitespace();
          if (text[index] !== ":")
            fail(`${label} has an invalid object separator`);
          index += 1;
          parseValue();
          whitespace();
          if (text[index] === "}") {
            index += 1;
            return;
          }
          if (text[index] !== ",")
            fail(`${label} has an invalid object delimiter`);
          index += 1;
          whitespace();
        }
        fail(`${label} contains an unterminated object`);
      }
      if (character === "[") {
        index += 1;
        whitespace();
        if (text[index] === "]") {
          index += 1;
          return;
        }
        while (index < text.length) {
          parseValue();
          whitespace();
          if (text[index] === "]") {
            index += 1;
            return;
          }
          if (text[index] !== ",")
            fail(`${label} has an invalid array delimiter`);
          index += 1;
        }
        fail(`${label} contains an unterminated array`);
      }
      if (character === '"') {
        parseStringToken();
        return;
      }
      const start = index;
      while (index < text.length && !/[\s,\]}]/u.test(text[index] ?? "")) {
        index += 1;
      }
      if (start === index) fail(`${label} contains an invalid JSON value`);
    };
    parseValue();
    whitespace();
    if (index !== text.length) fail(`${label} contains trailing JSON data`);
  };

  const decodeUtf8 = (bytes, label) => {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error) {
      fail(`${label} is not UTF-8: ${String(error)}`);
    }
  };

  const parseStrictJsonBytes = (bytes, label) => {
    const text = decodeUtf8(bytes, label);
    try {
      assertNoDuplicateObjectKeys(text, label);
      return JSON.parse(text);
    } catch (error) {
      fail(`${label} is not strict JSON: ${String(error)}`);
    }
  };

  const readPinnedFile = async (path, label, maximumBytes) => {
    const before = await lstat(path, { bigint: true }).catch((error) =>
      fail(`${label} cannot be inspected: ${String(error)}`),
    );
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) {
      fail(`${label} must be one unaliased regular file`);
    }
    if (before.size < 0n || before.size > BigInt(maximumBytes)) {
      fail(`${label} byte length is out of bounds`);
    }
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = await handle.stat({ bigint: true });
      if (
        opened.dev !== before.dev ||
        opened.ino !== before.ino ||
        opened.mode !== before.mode ||
        opened.size !== before.size ||
        opened.mtimeNs !== before.mtimeNs ||
        opened.ctimeNs !== before.ctimeNs
      ) {
        fail(`${label} changed before read`);
      }
      const bytes = await handle.readFile();
      const after = await handle.stat({ bigint: true });
      if (
        after.dev !== opened.dev ||
        after.ino !== opened.ino ||
        after.mode !== opened.mode ||
        after.size !== opened.size ||
        after.mtimeNs !== opened.mtimeNs ||
        after.ctimeNs !== opened.ctimeNs ||
        BigInt(bytes.byteLength) !== opened.size
      ) {
        fail(`${label} changed during read`);
      }
      return Buffer.from(bytes);
    } finally {
      await handle.close();
    }
  };

  const openRoot = async (path, label) => {
    const absolute = resolve(path);
    const metadata = await lstat(absolute, { bigint: true }).catch((error) =>
      fail(`${label} cannot be inspected: ${String(error)}`),
    );
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      fail(`${label} must be a real directory`);
    }
    if ((await realpath(absolute)) !== absolute) {
      fail(`${label} must have a canonical path`);
    }
    return { absolute, metadata };
  };

  const safeRelativePath = (value, label) => {
    if (
      typeof value !== "string" ||
      value.length < 1 ||
      value.length > 512 ||
      value.startsWith("/") ||
      /^[A-Za-z]:\//u.test(value) ||
      value.includes("\\") ||
      value.includes("\0") ||
      !/^[A-Za-z0-9._/-]+$/u.test(value)
    ) {
      fail(`${label} is not a safe relative POSIX path`);
    }
    const segments = value.split("/");
    if (
      segments.some(
        (segment) =>
          segment.length === 0 ||
          segment === "." ||
          segment === ".." ||
          segment === ".git",
      )
    ) {
      fail(`${label} is not a normalized relative path`);
    }
    return value;
  };

  if (
    resolve(schemaPath) !== SCHEMA_PATH ||
    (await realpath(resolve(schemaPath)).catch(() => null)) !== SCHEMA_PATH
  ) {
    fail("M5 evidence schema path is not the frozen repository schema");
  }
  const schemaInput = await readPinnedFile(
    schemaPath,
    "M5 evidence schema",
    262_144,
  );
  exact(sha256(schemaInput), SCHEMA_RAW_SHA256, "M5 evidence schema raw hash");
  const rootSchema = plainObject(
    parseStrictJsonBytes(schemaInput, "M5 evidence schema"),
    "M5 evidence schema",
  );
  exact(rootSchema.$id, SCHEMA_ID, "M5 evidence schema identity");

  const resolveSchemaReference = (reference) => {
    if (typeof reference !== "string" || !reference.startsWith("#/")) {
      fail(`unsupported schema reference ${String(reference)}`);
    }
    let current = rootSchema;
    for (const encoded of reference.slice(2).split("/")) {
      const segment = encoded.replaceAll("~1", "/").replaceAll("~0", "~");
      if (
        !plainObject(current, "schema reference segment") ||
        !Object.hasOwn(current, segment)
      ) {
        fail(`schema reference does not resolve: ${reference}`);
      }
      current = current[segment];
    }
    return plainObject(current, `schema reference ${reference}`);
  };

  const schemaTypeMatches = (value, type) => {
    switch (type) {
      case "object":
        return (
          typeof value === "object" &&
          value !== null &&
          !Array.isArray(value) &&
          Object.getPrototypeOf(value) === Object.prototype
        );
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

  const validateSchema = (schemaInputValue, value, location) => {
    const schema = plainObject(schemaInputValue, `${location} schema`);
    if (schema.$ref !== undefined) {
      validateSchema(resolveSchemaReference(schema.$ref), value, location);
    }
    if (schema.allOf !== undefined) {
      if (!Array.isArray(schema.allOf) || schema.allOf.length === 0) {
        fail(`${location} has an invalid allOf schema`);
      }
      for (const member of schema.allOf)
        validateSchema(member, value, location);
    }
    if (
      Object.hasOwn(schema, "const") &&
      JSON.stringify(value) !== JSON.stringify(schema.const)
    ) {
      fail(`${location} does not equal its frozen value`);
    }
    if (schema.type !== undefined && !schemaTypeMatches(value, schema.type)) {
      fail(`${location} has the wrong type`);
    }
    if (typeof value === "string") {
      if (
        schema.pattern !== undefined &&
        !new RegExp(schema.pattern, "u").test(value)
      ) {
        fail(`${location} does not match its required pattern`);
      }
      if (schema.minLength !== undefined && value.length < schema.minLength) {
        fail(`${location} is shorter than its minimum length`);
      }
      if (schema.maxLength !== undefined && value.length > schema.maxLength) {
        fail(`${location} exceeds its maximum length`);
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
          validateSchema(schema.items, entry, `${location}[${index}]`),
        );
      }
    }
    if (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) === Object.prototype
    ) {
      const properties = schema.properties ?? {};
      plainObject(properties, `${location} properties schema`);
      const required = schema.required ?? [];
      if (!Array.isArray(required))
        fail(`${location} has an invalid required schema`);
      for (const key of required) {
        if (typeof key !== "string" || !Object.hasOwn(value, key)) {
          fail(`${location}.${String(key)} is required`);
        }
      }
      for (const [key, entry] of Object.entries(value)) {
        if (Object.hasOwn(properties, key)) {
          validateSchema(properties[key], entry, `${location}.${key}`);
        } else if (schema.additionalProperties === false) {
          fail(`${location}.${key} is not allowed`);
        }
      }
    }
  };

  const taskSpecBytes = await readPinnedFile(
    taskSpecPath,
    "M5 task spec",
    131_072,
  );
  exact(
    sha256(taskSpecBytes),
    TASK_SPEC_RAW_SHA256,
    "frozen M5 task spec raw hash",
  );
  const taskSpec = plainObject(
    parseStrictJsonBytes(taskSpecBytes, "M5 task spec"),
    "M5 task spec",
  );
  exact(taskSpec.schemaVersion, 1, "M5 task spec schema version");
  exact(
    taskSpec.specKind,
    "chronorift-m5-public-exposed-behavior-change-task",
    "M5 task spec kind",
  );

  const bundleRoot = await openRoot(bundleRootPath, "M5 evidence bundle root");
  const bundleFiles = new Map();
  const bundleDirectories = [];
  let bundleBytes = 0;
  const walkBundle = async (directory, prefix) => {
    const names = await readdir(directory);
    names.sort((left, right) =>
      Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")),
    );
    for (const name of names) {
      const relativePath = prefix === "" ? name : `${prefix}/${name}`;
      safeRelativePath(relativePath, "bundle entry");
      const absolutePath = join(directory, name);
      const metadata = await lstat(absolutePath, { bigint: true });
      if (metadata.isSymbolicLink()) {
        fail(`bundle contains a symbolic link at ${relativePath}`);
      }
      if (metadata.isDirectory()) {
        bundleDirectories.push(relativePath);
        await walkBundle(absolutePath, relativePath);
        continue;
      }
      if (!metadata.isFile() || metadata.nlink !== 1n) {
        fail(
          `bundle contains a non-regular or aliased file at ${relativePath}`,
        );
      }
      const maximum =
        relativePath === "candidate.patch"
          ? MAX_PATCH_BYTES
          : relativePath.endsWith("/events.jsonl")
            ? MAX_EVENT_LEDGER_BYTES
            : MAX_JSON_BYTES;
      const bytes = await readPinnedFile(
        absolutePath,
        `bundle/${relativePath}`,
        maximum,
      );
      bundleBytes += bytes.byteLength;
      if (
        bundleBytes >
        MAX_PATCH_BYTES + 2 * MAX_EVENT_LEDGER_BYTES + 32 * MAX_JSON_BYTES
      ) {
        fail("bundle exceeds its aggregate byte bound");
      }
      bundleFiles.set(relativePath, bytes);
    }
  };
  await walkBundle(bundleRoot.absolute, "");
  exact(
    [...bundleFiles.keys()].sort(),
    [...EXPECTED_FILES],
    "bundle file allowlist",
  );
  exact(
    bundleDirectories.sort(),
    [...EXPECTED_DIRECTORIES],
    "bundle directory allowlist",
  );

  const requireBundleBytes = (relativePath) => {
    const bytes = bundleFiles.get(relativePath);
    if (bytes === undefined)
      fail(`bundle artifact is unavailable: ${relativePath}`);
    return bytes;
  };

  const parseCanonicalBundleJson = (relativePath, label) => {
    const bytes = requireBundleBytes(relativePath);
    const value = parseStrictJsonBytes(bytes, label);
    if (!bytes.equals(Buffer.from(`${canonicalJson(value)}\n`, "utf8"))) {
      fail(`${label} is not canonical JSON plus one LF`);
    }
    return { bytes, value: plainObject(value, label) };
  };

  const manifestArtifact = parseCanonicalBundleJson(
    "manifest.json",
    "bundle manifest",
  );
  const summaryArtifact = parseCanonicalBundleJson(
    "summary.json",
    "evidence summary",
  );
  const exportArtifact = parseCanonicalBundleJson(
    "patch-export-receipt.json",
    "patch export receipt",
  );
  const cleanupArtifact = parseCanonicalBundleJson(
    "cleanup-receipt.json",
    "cleanup receipt",
  );
  const manifest = manifestArtifact.value;
  const summary = summaryArtifact.value;
  const exportReceipt = exportArtifact.value;
  const cleanup = cleanupArtifact.value;

  validateSchema(rootSchema, summary, "$summary");
  validateSchema(
    resolveSchemaReference("#/$defs/manifest"),
    manifest,
    "$manifest",
  );
  validateSchema(
    resolveSchemaReference("#/$defs/patchExportReceipt"),
    exportReceipt,
    "$patchExportReceipt",
  );
  validateSchema(
    resolveSchemaReference("#/$defs/cleanupReceipt"),
    cleanup,
    "$cleanupReceipt",
  );
  verifyOwnContentHash(manifest, "manifestContentSha256", "bundle manifest");
  verifyOwnContentHash(summary, "summaryContentSha256", "evidence summary");
  verifyOwnContentHash(cleanup, "receiptContentSha256", "cleanup receipt");

  const taskSpecSha256 = sha256(taskSpecBytes);
  for (const [value, label] of [
    [manifest, "bundle manifest"],
    [summary, "evidence summary"],
    [cleanup, "cleanup receipt"],
  ]) {
    exact(value.taskSpecSha256, taskSpecSha256, `${label} task spec`);
  }
  exact(manifest.taskId, summary.taskId, "manifest/summary Task binding");
  exact(
    manifest.productSubject,
    summary.productSubject,
    "manifest/summary product subject binding",
  );
  exact(cleanup.taskId, summary.taskId, "cleanup/summary Task binding");
  exact(
    summary.claimsExcluded,
    taskSpec.claimsExcluded,
    "frozen excluded claims",
  );
  exact(
    {
      requestedTaskSandboxNetworkMode:
        summary.agent.requestedTaskSandboxNetworkMode,
      hostModelNetworkPolicy: summary.agent.hostModelNetworkPolicy,
      taskCredentialMountCountMaximum:
        summary.agent.taskCredentialMountCountMaximum,
    },
    {
      requestedTaskSandboxNetworkMode:
        taskSpec.agentBudget.taskSandboxNetworkMode,
      hostModelNetworkPolicy:
        taskSpec.agentBudget.hostModelNetworkAuthorization,
      taskCredentialMountCountMaximum:
        taskSpec.agentBudget.taskCredentialMountCountMaximum,
    },
    "summary requested sandbox/model policy",
  );
  integer(
    taskSpec.agentBudget.toolCallsMaximum,
    1,
    128,
    "M5 task spec maximum tool calls",
  );
  integer(
    summary.agent.totalToolCallCount,
    1,
    taskSpec.agentBudget.toolCallsMaximum,
    "summary total tool call count",
  );

  const verifyArtifactReference = (referenceInput, expectedPath, label) => {
    const reference = plainObject(referenceInput, label);
    exactKeys(reference, ["relativePath", "rawSha256"], label);
    exact(reference.relativePath, expectedPath, `${label} path`);
    const bytes = requireBundleBytes(expectedPath);
    exact(
      digest(reference.rawSha256, `${label} raw hash`),
      sha256(bytes),
      `${label} bytes`,
    );
    return bytes;
  };

  const expectedInventoryPaths = EXPECTED_FILES.filter(
    (relativePath) => relativePath !== "manifest.json",
  );
  exact(
    manifest.artifacts.map((reference) => reference.relativePath),
    expectedInventoryPaths,
    "manifest artifact inventory order",
  );
  for (const [index, expectedPath] of expectedInventoryPaths.entries()) {
    verifyArtifactReference(
      manifest.artifacts[index],
      expectedPath,
      `manifest artifact ${index + 1}`,
    );
  }
  verifyArtifactReference(
    summary.patch.artifact,
    "candidate.patch",
    "candidate patch reference",
  );
  verifyArtifactReference(
    summary.patch.exportReceipt,
    "patch-export-receipt.json",
    "patch export receipt reference",
  );
  verifyArtifactReference(
    summary.cleanup,
    "cleanup-receipt.json",
    "cleanup receipt reference",
  );

  exact(
    summary.source,
    {
      declaredUrl: taskSpec.source.declaredUrl,
      headCommit: taskSpec.source.headCommit,
      gitTreeObjectId: taskSpec.source.gitTreeObjectId,
      baselineSelectedTreeSha256: taskSpec.source.selectedTreeSha256,
      hostUnchangedAfterTask: true,
    },
    "summary source identity",
  );
  exact(
    summary.semanticProfile,
    {
      taskProfile: taskSpec.semanticProfile.taskProfile,
      protocolProfile: taskSpec.semanticProfile.protocolProfile,
      adapterProfileSha256:
        taskSpec.semanticProfile.adapterProfileCanonicalSha256,
      targetScene: taskSpec.semanticProfile.targetScene,
    },
    "summary semantic profile",
  );
  exact(summary.toolchain, taskSpec.toolchain, "summary realized toolchain");

  const runtimeResourceDigest = (taskId, kind, resourceId) =>
    sha256(
      Buffer.from(
        `chronorift-vnext-runtime-resource-v1\0${taskId}\0${kind}\0${resourceId}`,
        "utf8",
      ),
    );

  const parseRuntimeEnvelope = (relativePath, kind, label) => {
    const artifact = parseCanonicalBundleJson(relativePath, label);
    const envelope = artifact.value;
    exactKeys(
      envelope,
      [
        "schemaVersion",
        "taskId",
        "resourceKind",
        "resourceId",
        "resourceDigest",
        "payload",
        "payloadHash",
        "recordHash",
      ],
      label,
    );
    exact(envelope.schemaVersion, 1, `${label} schema version`);
    exact(envelope.taskId, summary.taskId, `${label} Task`);
    exact(envelope.resourceKind, kind, `${label} resource kind`);
    nonemptyString(envelope.resourceId, `${label} resource ID`, 256);
    exact(
      digest(envelope.resourceDigest, `${label} resource digest`),
      runtimeResourceDigest(summary.taskId, kind, envelope.resourceId),
      `${label} resource namespace`,
    );
    const payload = plainObject(envelope.payload, `${label} payload`);
    exact(
      digest(envelope.payloadHash, `${label} payload hash`),
      contentHash(payload),
      `${label} payload content`,
    );
    const basis = {
      schemaVersion: 1,
      taskId: envelope.taskId,
      resourceKind: kind,
      resourceId: envelope.resourceId,
      resourceDigest: envelope.resourceDigest,
      payload,
      payloadHash: envelope.payloadHash,
    };
    exact(
      digest(envelope.recordHash, `${label} record hash`),
      contentHash(basis),
      `${label} envelope content`,
    );
    return { envelope, payload };
  };

  const validateClock = (input, label) => {
    const clock = plainObject(input, label);
    exactKeys(
      clock,
      [
        "processFrame",
        "physicsTick",
        "simulationTimeUs",
        "hostMonotonicUs",
        "renderFrame",
      ],
      label,
    );
    integer(
      clock.processFrame,
      0,
      Number.MAX_SAFE_INTEGER,
      `${label}.processFrame`,
    );
    integer(
      clock.physicsTick,
      0,
      Number.MAX_SAFE_INTEGER,
      `${label}.physicsTick`,
    );
    integer(
      clock.simulationTimeUs,
      0,
      Number.MAX_SAFE_INTEGER,
      `${label}.simulationTimeUs`,
    );
    if (clock.hostMonotonicUs !== null) {
      integer(
        clock.hostMonotonicUs,
        0,
        Number.MAX_SAFE_INTEGER,
        `${label}.hostMonotonicUs`,
      );
    }
    exact(clock.renderFrame, null, `${label}.renderFrame`);
  };

  const validateProjection = (input, label) => {
    const projection = plainObject(input, label);
    exactKeys(
      projection,
      [
        "schemaVersion",
        "stateSchemaVersion",
        "subject",
        "timer",
        "entities",
        "nextSpawnOrdinal",
        "capturedAt",
      ],
      label,
    );
    exact(projection.schemaVersion, 1, `${label} schema version`);
    exact(
      projection.stateSchemaVersion,
      "chronorift.timer-spawn:v1",
      `${label} state schema`,
    );
    const subject = plainObject(projection.subject, `${label}.subject`);
    exactKeys(
      subject,
      [
        "stableId",
        "incarnation",
        "targetScene",
        "spawnIntervalSeconds",
        "spawnScene",
      ],
      `${label}.subject`,
    );
    exact(subject.stableId, "semantic:subject", `${label} subject stable ID`);
    integer(
      subject.incarnation,
      1,
      Number.MAX_SAFE_INTEGER,
      `${label} subject incarnation`,
    );
    exact(
      resourcePath(subject.targetScene, `${label} target scene`),
      taskSpec.semanticProfile.targetScene,
      `${label} target scene`,
    );
    exact(
      subject.spawnIntervalSeconds,
      1,
      `${label} configured spawn interval`,
    );
    resourcePath(subject.spawnScene, `${label} spawn scene`);

    const timer = plainObject(projection.timer, `${label}.timer`);
    exactKeys(
      timer,
      [
        "stableId",
        "incarnation",
        "waitTimeSeconds",
        "timeLeftSeconds",
        "paused",
        "stopped",
        "oneShot",
        "autostart",
        "processCallback",
        "ignoreTimeScale",
        "timeoutOrdinal",
      ],
      `${label}.timer`,
    );
    exact(timer.stableId, "semantic:timer", `${label} Timer stable ID`);
    integer(
      timer.incarnation,
      1,
      Number.MAX_SAFE_INTEGER,
      `${label} Timer incarnation`,
    );
    finite(timer.waitTimeSeconds, 0, 600, `${label} Timer wait time`);
    finite(timer.timeLeftSeconds, 0, 600, `${label} Timer time left`);
    for (const field of [
      "paused",
      "stopped",
      "oneShot",
      "autostart",
      "ignoreTimeScale",
    ]) {
      if (typeof timer[field] !== "boolean")
        fail(`${label}.timer.${field} is not boolean`);
    }
    if (!["physics", "idle"].includes(timer.processCallback)) {
      fail(`${label} Timer callback mode is unsupported`);
    }
    integer(
      timer.timeoutOrdinal,
      0,
      Number.MAX_SAFE_INTEGER,
      `${label} timeout ordinal`,
    );

    if (
      !Array.isArray(projection.entities) ||
      projection.entities.length > 256
    ) {
      fail(`${label} entities are outside their bounds`);
    }
    const ordinals = new Set();
    for (const [index, entityInput] of projection.entities.entries()) {
      const entity = plainObject(entityInput, `${label}.entities[${index}]`);
      exactKeys(
        entity,
        [
          "stableId",
          "incarnation",
          "spawnOrdinal",
          "scene",
          "parentStableId",
          "transform",
          "visible",
          "processMode",
          "velocity",
        ],
        `${label}.entities[${index}]`,
      );
      if (!/^semantic:spawn:[0-9]+$/u.test(entity.stableId)) {
        fail(`${label} entity stable ID is invalid`);
      }
      integer(
        entity.incarnation,
        1,
        Number.MAX_SAFE_INTEGER,
        `${label} entity incarnation`,
      );
      integer(
        entity.spawnOrdinal,
        0,
        Number.MAX_SAFE_INTEGER,
        `${label} entity ordinal`,
      );
      exact(
        entity.stableId,
        `semantic:spawn:${entity.spawnOrdinal}`,
        `${label} entity stable ID/ordinal binding`,
      );
      if (ordinals.has(entity.spawnOrdinal))
        fail(`${label} contains duplicate entity ordinals`);
      ordinals.add(entity.spawnOrdinal);
      resourcePath(entity.scene, `${label} entity scene`);
      exact(
        entity.parentStableId,
        "semantic:harness",
        `${label} entity parent`,
      );
      const transform = plainObject(
        entity.transform,
        `${label} entity transform`,
      );
      exactKeys(
        transform,
        ["position", "rotation", "scale"],
        `${label} entity transform`,
      );
      for (const vectorName of ["position", "scale"]) {
        const vector = plainObject(
          transform[vectorName],
          `${label} entity ${vectorName}`,
        );
        exactKeys(vector, ["x", "y"], `${label} entity ${vectorName}`);
        finite(
          vector.x,
          -Number.MAX_VALUE,
          Number.MAX_VALUE,
          `${label} entity ${vectorName}.x`,
        );
        finite(
          vector.y,
          -Number.MAX_VALUE,
          Number.MAX_VALUE,
          `${label} entity ${vectorName}.y`,
        );
      }
      finite(
        transform.rotation,
        -Number.MAX_VALUE,
        Number.MAX_VALUE,
        `${label} entity rotation`,
      );
      if (typeof entity.visible !== "boolean")
        fail(`${label} entity visibility is invalid`);
      integer(entity.processMode, 0, 4, `${label} entity process mode`);
      if (entity.velocity !== null) {
        const velocity = plainObject(
          entity.velocity,
          `${label} entity velocity`,
        );
        exactKeys(velocity, ["x", "y"], `${label} entity velocity`);
        finite(
          velocity.x,
          -Number.MAX_VALUE,
          Number.MAX_VALUE,
          `${label} velocity.x`,
        );
        finite(
          velocity.y,
          -Number.MAX_VALUE,
          Number.MAX_VALUE,
          `${label} velocity.y`,
        );
      }
      if (entity.spawnOrdinal >= projection.nextSpawnOrdinal) {
        fail(`${label} entity ordinal is not below nextSpawnOrdinal`);
      }
    }
    integer(
      projection.nextSpawnOrdinal,
      0,
      Number.MAX_SAFE_INTEGER,
      `${label}.nextSpawnOrdinal`,
    );
    validateClock(projection.capturedAt, `${label}.capturedAt`);
    return projection;
  };

  const validateCoverageAndLoss = (
    coverageInput,
    lossInput,
    eventCount,
    label,
  ) => {
    if (!Array.isArray(coverageInput) || coverageInput.length !== 5) {
      fail(`${label} coverage is not the complete five-channel record`);
    }
    const expectedChannels = [
      "clock",
      "state",
      "entity_lifecycle",
      "log",
      "error",
    ];
    for (const [index, input] of coverageInput.entries()) {
      const entry = plainObject(input, `${label}.coverage[${index}]`);
      exactKeys(
        entry,
        [
          "channel",
          "status",
          "emittedRecords",
          "droppedRecords",
          "limitations",
        ],
        `${label}.coverage[${index}]`,
      );
      exact(
        entry.channel,
        expectedChannels[index],
        `${label} coverage channel order`,
      );
      exact(
        entry.status,
        index < 3 ? "partial" : "unavailable",
        `${label} coverage fidelity`,
      );
      exact(
        entry.emittedRecords,
        index < 3 ? eventCount : 0,
        `${label} emitted records`,
      );
      integer(
        entry.droppedRecords,
        0,
        Number.MAX_SAFE_INTEGER,
        `${label} dropped records`,
      );
      if (
        !Array.isArray(entry.limitations) ||
        entry.limitations.length < 1 ||
        entry.limitations.length > 32
      ) {
        fail(`${label} degraded coverage omits its limitation`);
      }
      const limitations = new Set();
      for (const [limitationIndex, limitation] of entry.limitations.entries()) {
        nonemptyString(
          limitation,
          `${label}.coverage[${index}].limitations[${limitationIndex}]`,
        );
        if (limitations.has(limitation)) {
          fail(`${label}.coverage[${index}] repeats a limitation`);
        }
        limitations.add(limitation);
      }
    }
    if (
      !Array.isArray(lossInput) ||
      lossInput.length < 2 ||
      lossInput.length > 64
    ) {
      fail(`${label} loss inventory is incomplete`);
    }
    const kinds = new Set();
    for (const [index, input] of lossInput.entries()) {
      const entry = plainObject(input, `${label}.loss[${index}]`);
      exactKeys(
        entry,
        ["channel", "kind", "count", "reason"],
        `${label}.loss[${index}]`,
      );
      nonemptyString(entry.channel, `${label} loss channel`, 128);
      if (
        !["dropped", "truncated", "unavailable", "observer_effect"].includes(
          entry.kind,
        )
      ) {
        fail(`${label} loss kind is unsupported`);
      }
      kinds.add(entry.kind);
      integer(entry.count, 0, Number.MAX_SAFE_INTEGER, `${label} loss count`);
      nonemptyString(entry.reason, `${label} loss reason`);
    }
    if (!kinds.has("observer_effect") || !kinds.has("unavailable")) {
      fail(`${label} does not preserve observer-effect and unavailable loss`);
    }
  };

  const parseEventLedger = (relativePath, identifiers, label) => {
    const bytes = requireBundleBytes(relativePath);
    if (bytes.byteLength === 0 || bytes.at(-1) !== 0x0a) {
      fail(`${label} must be a non-empty JSONL ledger ending in LF`);
    }
    const text = decodeUtf8(bytes, label);
    const lines = text.slice(0, -1).split("\n");
    if (lines.length > 4_096 || lines.some((line) => line.length === 0)) {
      fail(`${label} has an invalid event count or empty line`);
    }
    const events = [];
    let previousHash = null;
    for (const [sequence, line] of lines.entries()) {
      const input = parseStrictJsonBytes(
        Buffer.from(line, "utf8"),
        `${label}[${sequence}]`,
      );
      const event = plainObject(input, `${label}[${sequence}]`);
      if (line !== canonicalJson(event)) {
        fail(`${label}[${sequence}] is not canonical JSON`);
      }
      exactKeys(
        event,
        [
          "schemaVersion",
          "taskId",
          "executionId",
          "sequence",
          "previousHash",
          "payload",
          "payloadHash",
          "recordHash",
        ],
        `${label}[${sequence}]`,
      );
      exact(event.schemaVersion, 1, `${label}[${sequence}] schema version`);
      exact(event.taskId, summary.taskId, `${label}[${sequence}] Task`);
      exact(
        event.executionId,
        identifiers.executionId,
        `${label}[${sequence}] execution`,
      );
      exact(event.sequence, sequence, `${label}[${sequence}] sequence`);
      exact(
        event.previousHash,
        previousHash,
        `${label}[${sequence}] previous hash`,
      );
      const payload = plainObject(
        event.payload,
        `${label}[${sequence}] payload`,
      );
      exactKeys(
        payload,
        [
          "schemaVersion",
          "eventKind",
          "taskId",
          "executionId",
          "runtimeId",
          "buildId",
          "sequence",
          "source",
          "hostMonotonicStartUs",
          "hostMonotonicEndUs",
          "projectionSha256",
          "projection",
        ],
        `${label}[${sequence}] payload`,
      );
      exact(payload.schemaVersion, 1, `${label}[${sequence}] payload schema`);
      exact(
        payload.eventKind,
        "semantic_observation",
        `${label}[${sequence}] event kind`,
      );
      exact(
        payload.taskId,
        summary.taskId,
        `${label}[${sequence}] payload Task`,
      );
      exact(
        payload.executionId,
        identifiers.executionId,
        `${label}[${sequence}] payload execution`,
      );
      exact(
        payload.runtimeId,
        identifiers.runtimeId,
        `${label}[${sequence}] payload runtime`,
      );
      exact(
        payload.buildId,
        identifiers.buildId,
        `${label}[${sequence}] payload build`,
      );
      exact(
        payload.sequence,
        sequence,
        `${label}[${sequence}] payload sequence`,
      );
      if (
        ![
          "ready",
          "status",
          "checkpoint",
          "restore",
          "trace",
          "shutdown",
        ].includes(payload.source)
      ) {
        fail(`${label}[${sequence}] observation source is unsupported`);
      }
      integer(
        payload.hostMonotonicStartUs,
        0,
        Number.MAX_SAFE_INTEGER,
        `${label}[${sequence}] Host start`,
      );
      integer(
        payload.hostMonotonicEndUs,
        payload.hostMonotonicStartUs,
        Number.MAX_SAFE_INTEGER,
        `${label}[${sequence}] Host end`,
      );
      const projection = validateProjection(
        payload.projection,
        `${label}[${sequence}] projection`,
      );
      exact(
        digest(
          payload.projectionSha256,
          `${label}[${sequence}] projection hash`,
        ),
        contentHash(projection),
        `${label}[${sequence}] projection content`,
      );
      exact(
        digest(event.payloadHash, `${label}[${sequence}] payload hash`),
        contentHash(payload),
        `${label}[${sequence}] payload content`,
      );
      const basis = {
        schemaVersion: 1,
        taskId: event.taskId,
        executionId: event.executionId,
        sequence,
        previousHash,
        payload,
        payloadHash: event.payloadHash,
      };
      exact(
        digest(event.recordHash, `${label}[${sequence}] record hash`),
        contentHash(basis),
        `${label}[${sequence}] event content`,
      );
      previousHash = event.recordHash;
      events.push({ envelope: event, payload, projection });
    }
    exact(
      events[0].payload.source,
      "ready",
      `${label} first observation source`,
    );
    for (const [index, event] of events.entries()) {
      if (
        (event.payload.source === "shutdown") !==
        (index === events.length - 1)
      ) {
        fail(`${label} shutdown observation is not uniquely terminal`);
      }
      if (index === 0) continue;
      const previous = events[index - 1];
      if (
        event.projection.capturedAt.simulationTimeUs <
          previous.projection.capturedAt.simulationTimeUs ||
        event.projection.capturedAt.processFrame <
          previous.projection.capturedAt.processFrame ||
        event.projection.capturedAt.physicsTick <
          previous.projection.capturedAt.physicsTick ||
        event.payload.hostMonotonicStartUs < previous.payload.hostMonotonicEndUs
      ) {
        fail(`${label} is not a monotonic M5 selected behavior window`);
      }
    }
    return { bytes, events, headHash: previousHash };
  };

  const validateExecutionRole = (role) => {
    const references = plainObject(
      summary.executions[role],
      `${role} execution references`,
    );
    const prefix = `runtime-records/${role}`;
    const paths = {
      build: `${prefix}/build.json`,
      runtime: `${prefix}/runtime.json`,
      execution: `${prefix}/execution.json`,
      events: `${prefix}/events.jsonl`,
      executionSeal: `${prefix}/execution-seal.json`,
    };
    for (const key of [
      "build",
      "runtime",
      "execution",
      "events",
      "executionSeal",
    ]) {
      verifyArtifactReference(
        references[key],
        paths[key],
        `${role} ${key} reference`,
      );
    }

    const buildRecord = parseRuntimeEnvelope(
      paths.build,
      "build",
      `${role} build resource`,
    );
    const build = buildRecord.payload;
    exactKeys(
      build,
      [
        "schemaVersion",
        "taskId",
        "workspaceId",
        "sourceId",
        "buildId",
        "sourceHash",
        "workspaceDiffHash",
        "buildConfigurationHash",
        "outputHash",
        "createdAt",
      ],
      `${role} build payload`,
    );
    exact(build.schemaVersion, 1, `${role} build schema version`);
    exact(build.taskId, summary.taskId, `${role} build Task`);
    exact(
      buildRecord.envelope.resourceId,
      build.buildId,
      `${role} build resource ID`,
    );
    opaqueId(build.workspaceId, `${role} workspace ID`);
    opaqueId(build.sourceId, `${role} source ID`);
    opaqueId(build.buildId, `${role} build ID`);
    exact(
      build.sourceId,
      `source:${build.sourceHash}`,
      `${role} build source ID`,
    );
    if (!/^build:[a-f0-9]{64}$/u.test(build.buildId)) {
      fail(`${role} build ID is not content-addressed`);
    }
    for (const field of [
      "sourceHash",
      "workspaceDiffHash",
      "buildConfigurationHash",
      "outputHash",
    ]) {
      digest(build[field], `${role} build ${field}`);
    }
    exact(
      build.workspaceDiffHash,
      contentHash({
        schemaVersion: 1,
        baselineSourceHash: taskSpec.source.selectedTreeSha256,
        candidateSourceHash: build.sourceHash,
      }),
      `${role} workspace diff lineage`,
    );
    exact(
      build.buildId,
      `build:${contentHash({
        schemaVersion: 1,
        projectHash: build.outputHash,
        buildConfigurationHash: build.buildConfigurationHash,
        outputHash: build.outputHash,
      })}`,
      `${role} build content identity`,
    );
    if (
      typeof build.createdAt !== "string" ||
      !Number.isFinite(Date.parse(build.createdAt))
    ) {
      fail(`${role} build creation time is invalid`);
    }
    exact(
      build.sourceHash,
      references.expectedSourceHash,
      `${role} expected source`,
    );

    const runtimeRecord = parseRuntimeEnvelope(
      paths.runtime,
      "runtime",
      `${role} runtime resource`,
    );
    const runtime = runtimeRecord.payload;
    exactKeys(
      runtime,
      [
        "schemaVersion",
        "runtimeKind",
        "taskId",
        "runtimeId",
        "executionId",
        "buildId",
        "adapterId",
        "adapterProfileSha256",
        "status",
        "finalProjectionSha256",
        "finalProjection",
        "coverage",
        "loss",
        "cleanupProven",
      ],
      `${role} runtime payload`,
    );
    exact(runtime.schemaVersion, 1, `${role} runtime schema version`);
    exact(
      runtime.runtimeKind,
      "godot_external_semantic",
      `${role} runtime kind`,
    );
    exact(runtime.taskId, summary.taskId, `${role} runtime Task`);
    exact(
      runtimeRecord.envelope.resourceId,
      runtime.runtimeId,
      `${role} runtime resource ID`,
    );
    opaqueId(runtime.runtimeId, `${role} runtime ID`);
    opaqueId(runtime.executionId, `${role} runtime execution ID`);
    opaqueId(runtime.buildId, `${role} runtime build ID`);
    opaqueId(runtime.adapterId, `${role} runtime adapter ID`);
    exact(runtime.buildId, build.buildId, `${role} runtime build`);
    exact(
      runtime.adapterProfileSha256,
      taskSpec.semanticProfile.adapterProfileCanonicalSha256,
      `${role} runtime adapter profile`,
    );
    exact(runtime.status, "stopped", `${role} runtime terminal status`);
    exact(runtime.cleanupProven, true, `${role} runtime cleanup proof`);

    const executionRecord = parseRuntimeEnvelope(
      paths.execution,
      "execution",
      `${role} execution resource`,
    );
    const execution = executionRecord.payload;
    exactKeys(
      execution,
      [
        "schemaVersion",
        "executionKind",
        "taskId",
        "executionId",
        "runtimeId",
        "workspaceId",
        "sourceId",
        "buildId",
        "adapterId",
        "adapterProfileSha256",
        "targetScene",
        "stateSchemaVersion",
        "fidelity",
        "equivalentForkEligible",
        "eventCount",
        "coverage",
        "loss",
        "executionSeal",
      ],
      `${role} execution payload`,
    );
    exact(execution.schemaVersion, 1, `${role} execution schema version`);
    exact(
      execution.executionKind,
      "godot_external_semantic",
      `${role} execution kind`,
    );
    exact(execution.taskId, summary.taskId, `${role} execution Task`);
    exact(
      executionRecord.envelope.resourceId,
      execution.executionId,
      `${role} execution resource ID`,
    );
    opaqueId(execution.executionId, `${role} execution ID`);
    opaqueId(execution.runtimeId, `${role} execution runtime ID`);
    opaqueId(execution.workspaceId, `${role} execution workspace ID`);
    opaqueId(execution.sourceId, `${role} execution source ID`);
    opaqueId(execution.buildId, `${role} execution build ID`);
    opaqueId(execution.adapterId, `${role} execution adapter ID`);
    exact(
      runtime.executionId,
      execution.executionId,
      `${role} runtime execution`,
    );
    exact(execution.runtimeId, runtime.runtimeId, `${role} execution runtime`);
    exact(
      execution.workspaceId,
      build.workspaceId,
      `${role} execution workspace`,
    );
    exact(execution.sourceId, build.sourceId, `${role} execution source`);
    exact(execution.buildId, build.buildId, `${role} execution build`);
    exact(execution.adapterId, runtime.adapterId, `${role} execution adapter`);
    exact(
      execution.adapterProfileSha256,
      runtime.adapterProfileSha256,
      `${role} execution adapter profile`,
    );
    exact(
      execution.targetScene,
      taskSpec.semanticProfile.targetScene,
      `${role} target scene`,
    );
    exact(
      execution.stateSchemaVersion,
      "chronorift.timer-spawn:v1",
      `${role} state schema`,
    );
    exact(execution.fidelity, "descriptive_only", `${role} execution fidelity`);
    exact(
      execution.equivalentForkEligible,
      false,
      `${role} equivalent-fork boundary`,
    );

    const ledger = parseEventLedger(
      paths.events,
      {
        executionId: execution.executionId,
        runtimeId: runtime.runtimeId,
        buildId: build.buildId,
      },
      `${role} raw event ledger`,
    );
    if (ledger.events.length < 2)
      fail(`${role} execution has fewer than two observations`);
    exact(
      execution.eventCount,
      ledger.events.length,
      `${role} execution event count`,
    );

    const sealArtifact = parseCanonicalBundleJson(
      paths.executionSeal,
      `${role} physical execution seal`,
    );
    const seal = sealArtifact.value;
    exactKeys(
      seal,
      [
        "schemaVersion",
        "taskId",
        "executionId",
        "count",
        "headHash",
        "byteLength",
        "contentHash",
      ],
      `${role} physical execution seal`,
    );
    exact(seal.schemaVersion, 1, `${role} seal schema version`);
    exact(seal.taskId, summary.taskId, `${role} seal Task`);
    exact(seal.executionId, execution.executionId, `${role} seal execution`);
    integer(seal.count, 0, 4_096, `${role} seal event count`);
    integer(
      seal.byteLength,
      0,
      MAX_EVENT_LEDGER_BYTES,
      `${role} seal byte length`,
    );
    exact(seal.count, ledger.events.length, `${role} seal event count`);
    exact(seal.headHash, ledger.headHash, `${role} seal head hash`);
    exact(seal.byteLength, ledger.bytes.byteLength, `${role} seal byte length`);
    exact(
      digest(seal.contentHash, `${role} seal content hash`),
      sha256(ledger.bytes),
      `${role} sealed raw ledger bytes`,
    );
    exact(
      execution.executionSeal,
      seal,
      `${role} physical/logical execution seal`,
    );
    exact(
      ledger.events.at(-1).payload.source,
      "shutdown",
      `${role} terminal observation source`,
    );
    const finalProjection = validateProjection(
      runtime.finalProjection,
      `${role} runtime final projection`,
    );
    exact(
      digest(runtime.finalProjectionSha256, `${role} final projection hash`),
      contentHash(finalProjection),
      `${role} final projection content`,
    );
    exact(
      finalProjection,
      ledger.events.at(-1).projection,
      `${role} final/raw projection binding`,
    );
    validateCoverageAndLoss(
      runtime.coverage,
      runtime.loss,
      ledger.events.length,
      `${role} runtime`,
    );
    validateCoverageAndLoss(
      execution.coverage,
      execution.loss,
      ledger.events.length,
      `${role} execution`,
    );
    exact(
      execution.coverage,
      runtime.coverage,
      `${role} runtime/execution coverage`,
    );
    exact(execution.loss, runtime.loss, `${role} runtime/execution loss`);

    return { build, runtime, execution, ledger, seal };
  };

  const baselineEvidence = validateExecutionRole("baseline");
  const candidateEvidence = validateExecutionRole("candidate");
  exact(
    baselineEvidence.build.sourceHash,
    taskSpec.source.selectedTreeSha256,
    "baseline execution source",
  );
  if (
    candidateEvidence.build.sourceHash === baselineEvidence.build.sourceHash
  ) {
    fail("candidate execution did not use a distinct source identity");
  }
  if (
    candidateEvidence.execution.executionId ===
    baselineEvidence.execution.executionId
  ) {
    fail("baseline and candidate execution identities are equal");
  }
  exact(
    candidateEvidence.build.workspaceId,
    baselineEvidence.build.workspaceId,
    "baseline/candidate workspace lineage",
  );
  exact(
    candidateEvidence.execution.adapterId,
    baselineEvidence.execution.adapterId,
    "baseline/candidate adapter lineage",
  );

  const relativeSimulationTimeUs = (first, event) =>
    event.projection.capturedAt.simulationTimeUs -
    first.projection.capturedAt.simulationTimeUs;
  const hasSpawn = (event) =>
    event.projection.nextSpawnOrdinal > 0 ||
    event.projection.entities.length > 0;
  const baselineEvents = baselineEvidence.ledger.events;
  const candidateEvents = candidateEvidence.ledger.events;
  const baselineContract = taskSpec.behaviorContract.baseline;
  const candidateContract = taskSpec.behaviorContract.candidate;
  if (
    baselineEvents.some(
      (event) =>
        event.projection.timer.waitTimeSeconds >
        baselineContract.timerWaitTimeSecondsMaximum,
    )
  ) {
    fail("baseline execution does not preserve the approximately 1 ms Timer");
  }
  const baselineFirst = baselineEvents[0];
  const decisiveBaselineEvent = baselineEvents.find(
    (event) =>
      relativeSimulationTimeUs(baselineFirst, event) >= 0 &&
      event.projection.nextSpawnOrdinal >=
        baselineContract.minimumObservedSpawnOrdinal &&
      hasSpawn(event),
  );
  if (decisiveBaselineEvent === undefined) {
    fail("baseline execution has no spawn-present observation endpoint");
  }
  if (
    decisiveBaselineEvent.payload.hostMonotonicEndUs >=
    candidateEvents[0].payload.hostMonotonicStartUs
  ) {
    fail(
      "selected candidate does not begin after the selected baseline behavior reproduction",
    );
  }
  if (
    candidateEvents.some((event) => {
      const wait = event.projection.timer.waitTimeSeconds;
      return (
        wait < candidateContract.timerWaitTimeSecondsMinimum ||
        wait > candidateContract.timerWaitTimeSecondsMaximum
      );
    })
  ) {
    fail("candidate execution does not preserve the approximately 1 s Timer");
  }
  const candidateFirst = candidateEvents[0];
  const candidateEarlyEvents = candidateEvents.filter((event) => {
    const relativeUs = relativeSimulationTimeUs(candidateFirst, event);
    return (
      relativeUs >= 0 &&
      relativeUs <= candidateContract.earlyObservationWindowUs
    );
  });
  if (
    candidateEarlyEvents.length === 0 ||
    candidateEarlyEvents.some(
      (event) =>
        event.projection.nextSpawnOrdinal >
          candidateContract.maximumEarlyTimeoutOrdinal || hasSpawn(event),
    )
  ) {
    fail("candidate ready/early observation endpoints are not spawn-absent");
  }
  if (
    !candidateEvents.some((event) => {
      const relativeUs = relativeSimulationTimeUs(candidateFirst, event);
      return (
        relativeUs >= candidateContract.laterObservationMinimumUs &&
        event.projection.nextSpawnOrdinal >=
          candidateContract.minimumLaterTimeoutOrdinal &&
        hasSpawn(event)
      );
    })
  ) {
    fail("candidate execution has no later spawned-entity observation");
  }

  const scanSelectedTree = async (rootPath, label) => {
    const root = await openRoot(rootPath, label);
    const entries = [];
    let totalBytes = 0;
    const walk = async (directory, prefix) => {
      const names = await readdir(directory);
      names.sort((left, right) =>
        Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")),
      );
      for (const name of names) {
        if (prefix === "" && (name === ".git" || name === ".godot")) continue;
        const relativePath = prefix === "" ? name : `${prefix}/${name}`;
        safeRelativePath(relativePath, `${label} entry`);
        const path = join(directory, name);
        const metadata = await lstat(path, { bigint: true });
        if (metadata.isSymbolicLink()) {
          fail(`${label} contains a symbolic link at ${relativePath}`);
        }
        if (metadata.isDirectory()) {
          await walk(path, relativePath);
          continue;
        }
        if (!metadata.isFile() || metadata.nlink !== 1n) {
          fail(
            `${label} contains a non-regular or aliased file at ${relativePath}`,
          );
        }
        if (entries.length >= MAX_TREE_FILES)
          fail(`${label} exceeds its file bound`);
        const bytes = await readPinnedFile(
          path,
          `${label}/${relativePath}`,
          MAX_TREE_BYTES,
        );
        totalBytes += bytes.byteLength;
        if (totalBytes > MAX_TREE_BYTES)
          fail(`${label} exceeds its byte bound`);
        entries.push({
          relativePath,
          mode: Number(metadata.mode & 0o111n) === 0 ? "100644" : "100755",
          bytes,
        });
      }
    };
    await walk(root.absolute, "");
    entries.sort((left, right) =>
      Buffer.compare(
        Buffer.from(left.relativePath, "utf8"),
        Buffer.from(right.relativePath, "utf8"),
      ),
    );
    const hash = createHash("sha256").update("chronorift-selected-tree-v1\0");
    for (const entry of entries) {
      const pathBytes = Buffer.from(entry.relativePath, "utf8");
      hash.update(`${pathBytes.byteLength}:`);
      hash.update(pathBytes);
      hash.update(`\0${entry.mode}\0${entry.bytes.byteLength}:`);
      hash.update(entry.bytes);
      hash.update("\0");
    }
    return { entries, byteLength: totalBytes, sha256: hash.digest("hex") };
  };

  const FIXED_GIT_CONFIG = [
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.untrackedCache=false",
    "-c",
    "commit.gpgSign=false",
    "-c",
    "tag.gpgSign=false",
    "-c",
    "diff.external=",
    "-c",
    "diff.trustExitCode=false",
    "-c",
    "protocol.allow=never",
    "-c",
    "protocol.file.allow=never",
    "-c",
    "submodule.recurse=false",
    "-c",
    "fetch.recurseSubmodules=false",
  ];

  const git = (args, options) => {
    try {
      return Buffer.from(
        execFileSync("/usr/bin/git", [...FIXED_GIT_CONFIG, ...args], {
          cwd: options.cwd,
          input: options.input,
          encoding: null,
          maxBuffer: 512 * 1024 * 1024,
          stdio: [
            options.input === undefined ? "ignore" : "pipe",
            "pipe",
            "pipe",
          ],
          env: {
            PATH: "/usr/bin:/bin",
            LANG: "C",
            LC_ALL: "C",
            HOME: options.cwd,
            XDG_CONFIG_HOME: options.cwd,
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_SYSTEM: "/dev/null",
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_ATTR_NOSYSTEM: "1",
            GIT_OPTIONAL_LOCKS: "0",
            GIT_TERMINAL_PROMPT: "0",
            GIT_ASKPASS: "/bin/false",
            SSH_ASKPASS: "/bin/false",
          },
        }),
      );
    } catch (error) {
      fail(
        `${options.label} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  const copyTreeEntries = async (entries, target) => {
    for (const entry of entries) {
      const path = join(target, ...entry.relativePath.split("/"));
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, entry.bytes, {
        flag: "wx",
        mode: entry.mode === "100755" ? 0o700 : 0o600,
      });
      await chmod(path, entry.mode === "100755" ? 0o700 : 0o600);
    }
  };

  const baselineRoot = await openRoot(
    baselineRootPath,
    "frozen baseline Git root",
  );
  const gitLine = (args, label) => {
    const text = decodeUtf8(
      git(args, { cwd: baselineRoot.absolute, label }),
      label,
    );
    if (!text.endsWith("\n") || text.slice(0, -1).includes("\n")) {
      fail(`${label} did not return exactly one LF-terminated line`);
    }
    return text.slice(0, -1);
  };
  exact(
    gitLine(["rev-parse", "--show-toplevel"], "baseline Git root lookup"),
    baselineRoot.absolute,
    "baseline Git top-level root",
  );
  exact(
    gitLine(
      ["rev-parse", "--show-object-format"],
      "baseline Git object format lookup",
    ),
    "sha1",
    "baseline Git object format",
  );
  const baselineHead = gitLine(
    ["rev-parse", "--verify", "HEAD^{commit}"],
    "baseline Git HEAD lookup",
  );
  if (!/^[a-f0-9]{40}$/u.test(baselineHead)) {
    fail("baseline Git HEAD is not a SHA-1 commit identity");
  }
  exact(baselineHead, taskSpec.source.headCommit, "frozen baseline Git HEAD");
  const baselineGitTree = gitLine(
    ["rev-parse", "--verify", "HEAD^{tree}"],
    "baseline Git tree lookup",
  );
  if (!/^[a-f0-9]{40}$/u.test(baselineGitTree)) {
    fail("baseline Git tree is not a SHA-1 tree identity");
  }
  exact(
    baselineGitTree,
    taskSpec.source.gitTreeObjectId,
    "frozen baseline Git tree",
  );
  const status = git(
    [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--ignored=matching",
      "--no-renames",
    ],
    { cwd: baselineRoot.absolute, label: "baseline Git cleanliness lookup" },
  );
  if (status.byteLength !== 0) {
    fail("frozen baseline Git root is not clean including ignored files");
  }
  const tracked = decodeUtf8(
    git(["ls-files", "--stage", "-z"], {
      cwd: baselineRoot.absolute,
      label: "baseline Git tracked-file lookup",
    }),
    "baseline Git tracked-file inventory",
  );
  const trackedEntries = tracked
    .split("\0")
    .filter((entry) => entry.length > 0);
  if (trackedEntries.length === 0 || trackedEntries.length > MAX_TREE_FILES) {
    fail("baseline Git tracked-file inventory is outside its bounds");
  }
  for (const entry of trackedEntries) {
    const match =
      /^(100644|100755|120000|160000) [a-f0-9]{40} ([0-3])\t(.+)$/u.exec(entry);
    if (match === null || match[2] !== "0") {
      fail("baseline Git index contains an unsupported or unmerged entry");
    }
    if (match[1] === "120000" || match[1] === "160000") {
      fail("baseline Git index contains a symlink or submodule");
    }
    safeRelativePath(match[3], "baseline Git tracked path");
  }
  const localConfig = decodeUtf8(
    git(["config", "--local", "--null", "--list"], {
      cwd: baselineRoot.absolute,
      label: "baseline local Git config lookup",
    }),
    "baseline local Git config",
  );
  for (const entry of localConfig
    .split("\0")
    .filter((value) => value.length > 0)) {
    const separator = entry.indexOf("\n");
    if (separator < 1) fail("baseline local Git config is malformed");
    const key = entry.slice(0, separator).toLocaleLowerCase("en-US");
    if (key.startsWith("credential.") || key.endsWith(".extraheader")) {
      fail("baseline local Git config contains credential material");
    }
  }

  const baselineTree = await scanSelectedTree(
    baselineRoot.absolute,
    "frozen baseline source",
  );
  exact(
    baselineTree.sha256,
    taskSpec.source.selectedTreeSha256,
    "frozen baseline selected-tree hash",
  );

  const patchIdentity = plainObject(
    summary.patch.identity,
    "candidate patch identity",
  );
  exact(patchIdentity.taskId, summary.taskId, "candidate patch Task");
  exact(
    patchIdentity.patchId,
    `patch:v1:${patchIdentity.patchHash}`,
    "candidate patch ID",
  );
  exact(
    patchIdentity.baselineSourceHash,
    baselineTree.sha256,
    "candidate patch baseline source",
  );
  exact(
    patchIdentity.candidateSourceHash,
    candidateEvidence.build.sourceHash,
    "candidate patch/execution source",
  );
  if (patchIdentity.candidateSourceHash === patchIdentity.baselineSourceHash) {
    fail("candidate patch did not change the selected source tree");
  }
  const patchBytes = requireBundleBytes("candidate.patch");
  if (patchBytes.byteLength === 0) fail("candidate patch is empty");
  exact(
    patchIdentity.byteLength,
    patchBytes.byteLength,
    "candidate patch byte length",
  );
  exact(
    digest(patchIdentity.patchHash, "candidate patch hash"),
    sha256(patchBytes),
    "candidate patch bytes",
  );
  exact(exportReceipt.taskId, summary.taskId, "patch export Task");
  exact(exportReceipt.patchId, patchIdentity.patchId, "patch export ID");
  exact(
    exportReceipt.patchSha256,
    patchIdentity.patchHash,
    "patch export hash",
  );
  exact(
    exportReceipt.byteLength,
    patchIdentity.byteLength,
    "patch export byte length",
  );
  exact(
    exportReceipt.outputPath,
    "candidate.patch",
    "patch export relative path",
  );
  if (!Number.isFinite(Date.parse(exportReceipt.exportedAt))) {
    fail("patch export timestamp is invalid");
  }

  const patchText = decodeUtf8(patchBytes, "candidate patch");
  if (!patchText.includes("diff --git "))
    fail("candidate patch is not a Git diff");
  const indexLines = [
    ...patchText.matchAll(/^index ([a-f0-9]+)\.\.([a-f0-9]+)(?: |$)/gmu),
  ];
  if (indexLines.length === 0)
    fail("candidate patch has no full-index object identity");
  for (const match of indexLines) {
    if (match[1].length !== 40 || match[2].length !== 40) {
      fail("candidate patch does not use full-index object IDs");
    }
  }

  const roundTripRoot = await mkdtemp(
    join(tmpdir(), "chronorift-m5-roundtrip-"),
  );
  let changedPaths;
  let roundTripTree;
  try {
    await copyTreeEntries(baselineTree.entries, roundTripRoot);
    git(["init", "--quiet", "--object-format=sha1"], {
      cwd: roundTripRoot,
      label: "patch round-trip init",
    });
    git(["config", "core.autocrlf", "false"], {
      cwd: roundTripRoot,
      label: "patch round-trip line endings",
    });
    git(["config", "core.filemode", "true"], {
      cwd: roundTripRoot,
      label: "patch round-trip file modes",
    });
    git(["config", "user.name", "ChronoRift M5 validator"], {
      cwd: roundTripRoot,
      label: "patch round-trip author",
    });
    git(["config", "user.email", "m5-validator@chronorift.invalid"], {
      cwd: roundTripRoot,
      label: "patch round-trip email",
    });
    git(["add", "--all"], {
      cwd: roundTripRoot,
      label: "patch baseline index",
    });
    git(["commit", "--quiet", "-m", "frozen baseline"], {
      cwd: roundTripRoot,
      label: "patch baseline commit",
    });
    git(["apply", "--check", "--binary", "--index", "-"], {
      cwd: roundTripRoot,
      input: patchBytes,
      label: "candidate patch check",
    });
    git(["apply", "--binary", "--index", "-"], {
      cwd: roundTripRoot,
      input: patchBytes,
      label: "candidate patch apply",
    });
    const regenerated = git(
      [
        "diff",
        "--cached",
        "--binary",
        "--full-index",
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames",
        "HEAD",
        "--",
      ],
      { cwd: roundTripRoot, label: "candidate patch regeneration" },
    );
    if (!regenerated.equals(patchBytes)) {
      fail(
        "candidate patch is not the exact reproducible full-index binary diff",
      );
    }
    const changedPathBytes = git(
      ["diff", "--cached", "--name-only", "-z", "--no-renames", "HEAD", "--"],
      { cwd: roundTripRoot, label: "candidate patch path inventory" },
    );
    const decodedPaths = decodeUtf8(
      changedPathBytes,
      "candidate patch path inventory",
    );
    changedPaths = decodedPaths.split("\0").filter((entry) => entry.length > 0);
    if (changedPaths.length === 0)
      fail("candidate patch changes no tracked path");
    const unsupportedSuffixes = [
      ".cs",
      ".csproj",
      ".dll",
      ".dylib",
      ".gdextension",
      ".gdnlib",
      ".sln",
      ".so",
    ];
    for (const changedPath of changedPaths) {
      safeRelativePath(changedPath, "candidate patch changed path");
      const normalized = changedPath.toLocaleLowerCase("en-US");
      if (
        normalized === ".godot" ||
        normalized.startsWith(".godot/") ||
        normalized === ".chronorift" ||
        normalized.startsWith(".chronorift/") ||
        normalized === "addons" ||
        normalized.startsWith("addons/") ||
        normalized === "override.cfg"
      ) {
        fail("candidate patch changes a reserved or generated project path");
      }
      if (unsupportedSuffixes.some((suffix) => normalized.endsWith(suffix))) {
        fail(
          "candidate patch adds or changes unsupported native project source",
        );
      }
    }
    const baselinePaths = new Set(
      baselineTree.entries.map((entry) => entry.relativePath),
    );
    if (
      !changedPaths.some(
        (path) =>
          path.endsWith(taskSpec.patchContract.requiredChangedSuffix) &&
          baselinePaths.has(path),
      )
    ) {
      fail("candidate patch does not modify pre-existing tracked GDScript");
    }
    roundTripTree = await scanSelectedTree(
      roundTripRoot,
      "round-trip candidate source",
    );
  } finally {
    await rm(roundTripRoot, { recursive: true, force: true });
  }
  exact(
    summary.patch.changedPaths,
    changedPaths,
    "summary changed path inventory",
  );
  exact(
    roundTripTree.sha256,
    patchIdentity.candidateSourceHash,
    "candidate patch round-trip selected tree",
  );
  exact(
    summary.patch.roundTripSelectedTreeSha256,
    roundTripTree.sha256,
    "summary patch round-trip identity",
  );

  const taskNamespaceDigest = sha256(
    Buffer.from(`chronorift-task-namespace-v1\0${summary.taskId}`, "utf8"),
  );
  exact(
    cleanup.taskNamespaceDigest,
    taskNamespaceDigest,
    "cleanup Task namespace",
  );
  exact(cleanup.patchId, patchIdentity.patchId, "cleanup patch ID");
  exact(
    cleanup.baselineSourceHash,
    patchIdentity.baselineSourceHash,
    "cleanup baseline source",
  );
  exact(
    cleanup.candidateSourceHash,
    patchIdentity.candidateSourceHash,
    "cleanup candidate source",
  );
  exact(
    cleanup.baselineExecutionId,
    baselineEvidence.execution.executionId,
    "cleanup baseline execution",
  );
  exact(
    cleanup.candidateExecutionId,
    candidateEvidence.execution.executionId,
    "cleanup candidate execution",
  );

  return "validated strict vNext M5 evidence bundle\n";
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.stdout.write(await validateVNextM5Evidence(process.argv.slice(2)));
}
