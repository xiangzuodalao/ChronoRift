#!/usr/bin/env node

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCHEMA_ID =
  "https://chronorift.invalid/evidence/project-environment-pe-a-bundle.v1.schema.json";
const SCHEMA_RAW_SHA256 =
  "80701e52594f8924356a136b1d37fdde21f7d34647e4e6c4eb187bb928223b42";
const MAX_SCHEMA_BYTES = 256 * 1024;
const MAX_EVIDENCE_BYTES = 8 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/u;
const GIT_OBJECT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u;
const SAFE_STABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const REQUIRED_MODULES = Object.freeze([
  "lifecycle",
  "clock",
  "runtime_error",
  "entity_projection",
  "state_projection",
  "event_projection",
  "capture",
]);
const ALL_MODULES = Object.freeze([
  ...REQUIRED_MODULES,
  "input_control",
  "snapshot",
  "restore",
  "render_capture",
  "alignment",
]);

const fail = (message) => {
  throw new Error(`invalid PE-A evidence bundle: ${message}`);
};

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
  const object = plainObject(value, "canonical JSON value");
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
};

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const contentHash = (value) =>
  sha256(Buffer.from(canonicalJson(value), "utf8"));

const exactKeys = (value, keys, label) => {
  const actual = Object.keys(plainObject(value, label)).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(
      `${label} contains a missing or unknown field (actual ${actual.join(",")}; expected ${expected.join(",")})`,
    );
  }
};

const exact = (actual, expected, label) => {
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    fail(`${label} does not equal its required value`);
  }
};

const bool = (value, label) => {
  if (typeof value !== "boolean") fail(`${label} must be boolean`);
  return value;
};

const integer = (value, minimum, maximum, label) => {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail(`${label} is outside its integer bounds`);
  }
  return value;
};

const string = (value, label, maximum = 4096) => {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    value.includes("\0") ||
    value.includes("\r") ||
    value.includes("\n")
  ) {
    fail(`${label} must be bounded single-line text`);
  }
  return value;
};

const digest = (value, label) => {
  if (typeof value !== "string" || !SHA256.test(value)) {
    fail(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
};

const id = (value, label) => {
  if (
    typeof value !== "string" ||
    !SAFE_ID.test(value) ||
    value.includes("..") ||
    value.includes("/") ||
    value.includes("\\")
  ) {
    fail(`${label} must be a bounded opaque ID`);
  }
  return value;
};

const stableId = (value, label) => {
  if (typeof value !== "string" || !SAFE_STABLE_ID.test(value)) {
    fail(`${label} must be a bounded stable ID`);
  }
  return value;
};

const timestamp = (value, label) => {
  string(value, label, 64);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)) {
    fail(`${label} must be an ISO UTC timestamp`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    fail(`${label} must be a canonical ISO UTC timestamp`);
  }
  return parsed;
};

const resourcePath = (value, label) => {
  string(value, label, 1024);
  if (
    !value.startsWith("res://") ||
    value.includes("\\") ||
    value
      .slice("res://".length)
      .split("/")
      .some((part) => part === "" || part === "." || part === "..")
  ) {
    fail(`${label} must be a contained res:// path`);
  }
  return value;
};

const packagePath = (value, label) => {
  string(value, label, 1024);
  if (
    value.startsWith("/") ||
    value.includes("\\") ||
    value
      .split("/")
      .some(
        (part) =>
          part === "" ||
          part === "." ||
          part === ".." ||
          !/^(?:[A-Za-z0-9]|\.[A-Za-z0-9])[A-Za-z0-9._-]*$/u.test(part),
      )
  ) {
    fail(`${label} must be a safe package-relative path`);
  }
  return value;
};

const schemaVersion = (value, label) =>
  exact(value, 1, `${label}.schemaVersion`);

const verifyOwnHash = (value, label) => {
  const object = plainObject(value, label);
  const claimed = digest(object.recordHash, `${label}.recordHash`);
  const basis = Object.fromEntries(
    Object.entries(object).filter(([key]) => key !== "recordHash"),
  );
  exact(claimed, contentHash(basis), `${label} canonical record hash`);
};

const decodeCanonicalBase64 = (encoded, label, maximumBytes) => {
  if (
    typeof encoded !== "string" ||
    encoded.length > Math.ceil((maximumBytes * 4) / 3) + 8 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      encoded,
    )
  ) {
    fail(`${label} must be canonical base64`);
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.byteLength > maximumBytes || bytes.toString("base64") !== encoded) {
    fail(`${label} is non-canonical or exceeds its byte bound`);
  }
  return bytes;
};

const assertUnique = (values, key, label) => {
  const seen = new Set();
  for (const value of values) {
    const identity = key(value);
    if (seen.has(identity)) fail(`${label} contains duplicate ${identity}`);
    seen.add(identity);
  }
};

const assertNoDuplicateObjectKeys = (text, label) => {
  let index = 0;
  const whitespace = () => {
    while (/\s/u.test(text[index] ?? "")) index += 1;
  };
  const parseString = () => {
    const start = index;
    index += 1;
    while (index < text.length) {
      if (text[index] === "\\") {
        index += 2;
        continue;
      }
      index += 1;
      if (text[index - 1] === '"') return JSON.parse(text.slice(start, index));
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
        const key = parseString();
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
      parseString();
      return;
    }
    const start = index;
    while (index < text.length && !/[\s,\]}]/u.test(text[index] ?? ""))
      index += 1;
    if (start === index) fail(`${label} contains an invalid JSON value`);
  };
  parseValue();
  whitespace();
  if (index !== text.length) fail(`${label} contains trailing JSON data`);
};

const readPinnedJson = async (path, label, maximumBytes) => {
  const before = await lstat(path, { bigint: true }).catch((error) =>
    fail(`${label} cannot be inspected: ${String(error)}`),
  );
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) {
    fail(`${label} must be one unaliased regular file`);
  }
  if (before.size < 1n || before.size > BigInt(maximumBytes)) {
    fail(`${label} byte length is outside its bound`);
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
    const bytes = Buffer.from(await handle.readFile());
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
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      assertNoDuplicateObjectKeys(text, label);
      return { bytes, value: JSON.parse(text) };
    } catch (error) {
      fail(`${label} is not strict UTF-8 JSON: ${String(error)}`);
    }
  } finally {
    await handle.close();
  }
};

const validateFileManifest = (files, label) => {
  if (!Array.isArray(files) || files.length < 1 || files.length > 512) {
    fail(`${label} must contain 1..512 files`);
  }
  const parsed = files.map((file, index) => {
    const itemLabel = `${label}[${index}]`;
    exactKeys(file, ["path", "byteLength", "sha256"], itemLabel);
    return {
      path: packagePath(file.path, `${itemLabel}.path`),
      byteLength: integer(
        file.byteLength,
        1,
        64 * 1024 * 1024,
        `${itemLabel}.byteLength`,
      ),
      sha256: digest(file.sha256, `${itemLabel}.sha256`),
    };
  });
  assertUnique(parsed, (file) => file.path, label);
  const sorted = [...parsed].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
  exact(parsed, sorted, `${label} canonical path order`);
  return parsed;
};

const packageDigest = (files) => contentHash({ schemaVersion: 1, files });

const validatePackageSeal = (seal, expected, label) => {
  exactKeys(
    seal,
    [
      "schemaVersion",
      "ownerId",
      "resourceId",
      "operationId",
      "recordHash",
      "files",
      "packageByteLength",
      "packageHash",
    ],
    label,
  );
  schemaVersion(seal.schemaVersion, label);
  exact(
    id(seal.ownerId, `${label}.ownerId`),
    expected.ownerId,
    `${label}.ownerId`,
  );
  exact(
    id(seal.resourceId, `${label}.resourceId`),
    expected.resourceId,
    `${label}.resourceId`,
  );
  exact(seal.operationId, expected.operationId, `${label}.operationId`);
  exact(
    digest(seal.recordHash, `${label}.recordHash`),
    expected.recordHash,
    `${label}.recordHash`,
  );
  const files = validateFileManifest(seal.files, `${label}.files`);
  exact(files, expected.files, `${label}.files`);
  const packageByteLength = files.reduce(
    (total, file) => total + file.byteLength,
    0,
  );
  exact(
    integer(
      seal.packageByteLength,
      1,
      512 * 1024 * 1024,
      `${label}.packageByteLength`,
    ),
    packageByteLength,
    `${label}.packageByteLength`,
  );
  const basis = {
    schemaVersion: 1,
    ownerId: seal.ownerId,
    resourceId: seal.resourceId,
    operationId: seal.operationId,
    recordHash: seal.recordHash,
    files,
    packageByteLength,
  };
  exact(
    digest(seal.packageHash, `${label}.packageHash`),
    contentHash(basis),
    `${label}.packageHash`,
  );
};

const adapterPackageDigest = (files) => {
  const identity = createHash("sha256");
  for (const file of files) {
    identity.update(file.path);
    identity.update("\0");
    identity.update(file.sha256);
    identity.update("\0");
  }
  return identity.digest("hex");
};

const validateModules = (modules, label) => {
  if (!Array.isArray(modules) || modules.length !== ALL_MODULES.length) {
    fail(`${label} must contain all twelve capability modules`);
  }
  modules.forEach((module, index) => {
    const itemLabel = `${label}[${index}]`;
    exactKeys(
      module,
      ["schemaVersion", "module", "status", "protocolVersion", "limitations"],
      itemLabel,
    );
    schemaVersion(module.schemaVersion, itemLabel);
    exact(
      module.module,
      ALL_MODULES[index],
      `${itemLabel}.module canonical order`,
    );
    if (
      ![
        "implemented",
        "unsupported",
        "unavailable_by_policy",
        "unavailable_by_environment",
        "degraded",
      ].includes(module.status)
    ) {
      fail(`${itemLabel}.status is unsupported`);
    }
    if (
      REQUIRED_MODULES.includes(module.module) &&
      module.status !== "implemented"
    ) {
      fail(`${itemLabel} is a required Ready module but is not implemented`);
    }
    if (module.status === "implemented" || module.status === "degraded") {
      string(module.protocolVersion, `${itemLabel}.protocolVersion`, 256);
    } else if (module.protocolVersion !== null) {
      fail(`${itemLabel}.protocolVersion must be null when unavailable`);
    }
    if (!Array.isArray(module.limitations) || module.limitations.length > 64) {
      fail(`${itemLabel}.limitations is not bounded`);
    }
    module.limitations.forEach((value, limitationIndex) =>
      string(value, `${itemLabel}.limitations[${limitationIndex}]`),
    );
    if (
      !["implemented"].includes(module.status) &&
      module.limitations.length === 0
    ) {
      fail(`${itemLabel} must explain its non-implemented state`);
    }
  });
  return modules;
};

const validateCleanup = (cleanup, label) => {
  exactKeys(
    cleanup,
    [
      "schemaVersion",
      "processTreeTerminated",
      "runtimeExited",
      "bridgeExited",
      "isolationGroupEmpty",
      "scopeRemoved",
      "scratchRemoved",
      "storageReconciled",
    ],
    label,
  );
  schemaVersion(cleanup.schemaVersion, label);
  for (const key of Object.keys(cleanup).filter(
    (key) => key !== "schemaVersion",
  )) {
    bool(cleanup[key], `${label}.${key}`);
    exact(cleanup[key], true, `${label}.${key}`);
  }
  return cleanup;
};

const validateCompleteCoverage = (coverage, label) => {
  if (
    !Array.isArray(coverage) ||
    coverage.length < 1 ||
    coverage.length > 256
  ) {
    fail(`${label} must contain 1..256 channels`);
  }
  coverage.forEach((entry, index) => {
    const itemLabel = `${label}[${index}]`;
    exactKeys(
      entry,
      [
        "schemaVersion",
        "channelId",
        "status",
        "observedRecords",
        "droppedRecords",
        "overwrittenRecords",
        "limitations",
      ],
      itemLabel,
    );
    schemaVersion(entry.schemaVersion, itemLabel);
    stableId(entry.channelId, `${itemLabel}.channelId`);
    exact(entry.status, "complete", `${itemLabel}.status`);
    integer(
      entry.observedRecords,
      1,
      Number.MAX_SAFE_INTEGER,
      `${itemLabel}.observedRecords`,
    );
    exact(
      integer(entry.droppedRecords, 0, 0, `${itemLabel}.droppedRecords`),
      0,
      `${itemLabel}.droppedRecords`,
    );
    exact(
      integer(
        entry.overwrittenRecords,
        0,
        0,
        `${itemLabel}.overwrittenRecords`,
      ),
      0,
      `${itemLabel}.overwrittenRecords`,
    );
    exact(entry.limitations, [], `${itemLabel}.limitations`);
  });
  assertUnique(coverage, (entry) => entry.channelId, label);
  return coverage;
};

const validateSource = (source) => {
  const label = "$evidence.source";
  exactKeys(
    source,
    [
      "schemaVersion",
      "sourceId",
      "projectSourceIdentity",
      "sourceKind",
      "headCommit",
      "selectedTreeSha256",
      "mainScene",
      "requestedGodotVersion",
      "clean",
      "rootCount",
      "projectCount",
      "credentialLikePathCount",
      "recordHash",
    ],
    label,
  );
  schemaVersion(source.schemaVersion, label);
  exact(
    source.sourceKind,
    "project-environment-v1-clean-git",
    `${label}.sourceKind`,
  );
  if (
    typeof source.headCommit !== "string" ||
    !GIT_OBJECT.test(source.headCommit)
  ) {
    fail(`${label}.headCommit must be a Git object ID`);
  }
  digest(source.selectedTreeSha256, `${label}.selectedTreeSha256`);
  resourcePath(source.mainScene, `${label}.mainScene`);
  exact(
    source.requestedGodotVersion,
    "4.7.1",
    `${label}.requestedGodotVersion`,
  );
  exact(bool(source.clean, `${label}.clean`), true, `${label}.clean`);
  exact(
    integer(source.rootCount, 1, 1, `${label}.rootCount`),
    1,
    `${label}.rootCount`,
  );
  exact(
    integer(source.projectCount, 1, 1, `${label}.projectCount`),
    1,
    `${label}.projectCount`,
  );
  exact(
    integer(
      source.credentialLikePathCount,
      0,
      0,
      `${label}.credentialLikePathCount`,
    ),
    0,
    `${label}.credentialLikePathCount`,
  );
  const identity = contentHash({
    schemaVersion: 1,
    sourceKind: source.sourceKind,
    headCommit: source.headCommit,
    selectedTreeSha256: source.selectedTreeSha256,
    mainScene: source.mainScene,
    requestedGodotVersion: source.requestedGodotVersion,
  });
  exact(
    digest(source.projectSourceIdentity, `${label}.projectSourceIdentity`),
    identity,
    `${label}.projectSourceIdentity`,
  );
  exact(
    id(source.sourceId, `${label}.sourceId`),
    `source:v1:${identity}`,
    `${label}.sourceId`,
  );
  verifyOwnHash(source, label);
};

const validateToolchain = (toolchain) => {
  const label = "$evidence.toolchain";
  exactKeys(
    toolchain,
    [
      "schemaVersion",
      "receiptId",
      "requested",
      "status",
      "realized",
      "limitations",
      "observedAt",
      "recordHash",
    ],
    label,
  );
  schemaVersion(toolchain.schemaVersion, label);
  id(toolchain.receiptId, `${label}.receiptId`);
  exactKeys(
    toolchain.requested,
    [
      "schemaVersion",
      "engineFamily",
      "versionRequirement",
      "platform",
      "requiredFeatures",
    ],
    `${label}.requested`,
  );
  schemaVersion(toolchain.requested.schemaVersion, `${label}.requested`);
  exact(
    toolchain.requested.engineFamily,
    "godot",
    `${label}.requested.engineFamily`,
  );
  exact(
    toolchain.requested.versionRequirement,
    "4.7.1",
    `${label}.requested.versionRequirement`,
  );
  const platform = stableId(
    toolchain.requested.platform,
    `${label}.requested.platform`,
  );
  if (
    !Array.isArray(toolchain.requested.requiredFeatures) ||
    toolchain.requested.requiredFeatures.length > 64
  ) {
    fail(`${label}.requested.requiredFeatures is not bounded`);
  }
  toolchain.requested.requiredFeatures.forEach((value, index) =>
    stableId(value, `${label}.requested.requiredFeatures[${index}]`),
  );
  assertUnique(
    toolchain.requested.requiredFeatures,
    (value) => value,
    `${label}.requested.requiredFeatures`,
  );
  exact(toolchain.status, "realized", `${label}.status`);
  exactKeys(
    toolchain.realized,
    [
      "schemaVersion",
      "engineFamily",
      "version",
      "platform",
      "artifactDigest",
      "features",
      "renderer",
    ],
    `${label}.realized`,
  );
  schemaVersion(toolchain.realized.schemaVersion, `${label}.realized`);
  exact(
    toolchain.realized.engineFamily,
    "godot",
    `${label}.realized.engineFamily`,
  );
  exact(toolchain.realized.version, "4.7.1", `${label}.realized.version`);
  exact(toolchain.realized.platform, platform, `${label}.realized.platform`);
  digest(toolchain.realized.artifactDigest, `${label}.realized.artifactDigest`);
  if (
    !Array.isArray(toolchain.realized.features) ||
    toolchain.realized.features.length > 64
  ) {
    fail(`${label}.realized.features is not bounded`);
  }
  toolchain.realized.features.forEach((value, index) =>
    stableId(value, `${label}.realized.features[${index}]`),
  );
  assertUnique(
    toolchain.realized.features,
    (value) => value,
    `${label}.realized.features`,
  );
  for (const feature of toolchain.requested.requiredFeatures) {
    if (!toolchain.realized.features.includes(feature)) {
      fail(`${label}.realized.features omitted requested ${feature}`);
    }
  }
  stableId(toolchain.realized.renderer, `${label}.realized.renderer`);
  exact(toolchain.limitations, [], `${label}.limitations`);
  timestamp(toolchain.observedAt, `${label}.observedAt`);
  const identity = {
    schemaVersion: 1,
    requested: toolchain.requested,
    status: toolchain.status,
    realized: toolchain.realized,
    limitations: toolchain.limitations,
  };
  exact(
    toolchain.receiptId,
    `toolchain-receipt:v1:${contentHash({ schemaVersion: 1, label: "toolchain-receipt", value: identity })}`,
    `${label}.receiptId`,
  );
  verifyOwnHash(toolchain, label);
};

const validateEmbeddedJsonDocument = (document, expected, label) => {
  exactKeys(
    document,
    ["path", "byteLength", "sha256", "canonicalBase64"],
    label,
  );
  exact(
    packagePath(document.path, `${label}.path`),
    expected.path,
    `${label}.path`,
  );
  const bytes = decodeCanonicalBase64(
    document.canonicalBase64,
    `${label}.canonicalBase64`,
    256 * 1024,
  );
  exact(
    integer(document.byteLength, 1, 256 * 1024, `${label}.byteLength`),
    bytes.byteLength,
    `${label}.byteLength`,
  );
  exact(
    digest(document.sha256, `${label}.sha256`),
    expected.sha256,
    `${label}.sha256`,
  );
  exact(sha256(bytes), expected.sha256, `${label} raw SHA-256`);
  let value;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    assertNoDuplicateObjectKeys(text, label);
    value = JSON.parse(text);
  } catch (error) {
    fail(`${label} is not strict UTF-8 JSON: ${String(error)}`);
  }
  return plainObject(value, label);
};

const validateAdapterDocuments = (documents, adapter, label) => {
  exactKeys(
    documents,
    ["schemaVersion", "manifest", "payloadSchemas", "recordHash"],
    label,
  );
  schemaVersion(documents.schemaVersion, label);
  const manifestFile = adapter.packageFiles.find(
    (file) => file.path === "manifest.json",
  );
  if (manifestFile === undefined)
    fail(`${label} adapter package omitted manifest.json`);
  const manifest = validateEmbeddedJsonDocument(
    documents.manifest,
    manifestFile,
    `${label}.manifest`,
  );
  exactKeys(
    manifest,
    [
      "schemaVersion",
      "manifestKind",
      "adapterId",
      "adapterVersion",
      "sdk",
      "engine",
      "entryScript",
      "schemas",
      "launchTargets",
      "modules",
      "entityTypes",
      "stateDomains",
      "eventTypes",
      "smoke",
    ],
    `${label}.manifest.value`,
  );
  schemaVersion(manifest.schemaVersion, `${label}.manifest.value`);
  exact(
    manifest.manifestKind,
    "chronorift-project-adapter",
    `${label}.manifest.value.manifestKind`,
  );
  exact(
    manifest.adapterId,
    adapter.adapterId,
    `${label}.manifest.value.adapterId`,
  );
  if (
    !Array.isArray(manifest.schemas) ||
    manifest.schemas.length !== adapter.payloadSchemas.length
  ) {
    fail(`${label}.manifest.value.schemas does not match adapter declarations`);
  }
  if (
    !Array.isArray(documents.payloadSchemas) ||
    documents.payloadSchemas.length !== adapter.payloadSchemas.length
  ) {
    fail(`${label}.payloadSchemas does not contain all declared schema bytes`);
  }
  const schemaValues = new Map();
  adapter.payloadSchemas.forEach((declared, index) => {
    const manifestDeclaration = manifest.schemas[index];
    exactKeys(
      manifestDeclaration,
      ["schemaVersion", "schemaId", "path", "sha256"],
      `${label}.manifest.value.schemas[${index}]`,
    );
    schemaVersion(
      manifestDeclaration.schemaVersion,
      `${label}.manifest.value.schemas[${index}]`,
    );
    exact(
      manifestDeclaration.schemaId,
      declared.schemaId,
      `${label}.manifest.value.schemas[${index}].schemaId`,
    );
    exact(
      manifestDeclaration.path,
      declared.path,
      `${label}.manifest.value.schemas[${index}].path`,
    );
    exact(
      manifestDeclaration.sha256,
      declared.sha256,
      `${label}.manifest.value.schemas[${index}].sha256`,
    );
    const value = validateEmbeddedJsonDocument(
      documents.payloadSchemas[index],
      declared,
      `${label}.payloadSchemas[${index}]`,
    );
    exactKeys(
      value,
      ["schemaVersion", "dialect", "schemaId", "root"],
      `${label}.payloadSchemas[${index}].value`,
    );
    schemaVersion(
      value.schemaVersion,
      `${label}.payloadSchemas[${index}].value`,
    );
    exact(
      value.dialect,
      "chronorift://schemas/project-adapter-payload/v1",
      `${label}.payloadSchemas[${index}].value.dialect`,
    );
    exact(
      value.schemaId,
      declared.schemaId,
      `${label}.payloadSchemas[${index}].value.schemaId`,
    );
    schemaValues.set(declared.schemaId, value);
  });
  for (const declarationName of ["entityTypes", "stateDomains", "eventTypes"]) {
    if (
      !Array.isArray(manifest[declarationName]) ||
      manifest[declarationName].length > 256
    ) {
      fail(`${label}.manifest.value.${declarationName} is not bounded`);
    }
  }
  verifyOwnHash(documents, label);
  return { manifest, schemas: schemaValues };
};

const validateAdapter = (adapter, source) => {
  const label = "$evidence.adapter";
  exactKeys(
    adapter,
    [
      "schemaVersion",
      "adapterRevisionId",
      "adapterId",
      "sourceId",
      "packageFiles",
      "packageDigest",
      "manifestDigest",
      "implementationDigest",
      "payloadSchemas",
      "payloadSchemaDigest",
      "sdkDigest",
      "bridgeDigest",
      "conformanceReceiptId",
      "modules",
      "contentByteLength",
      "contentFileCount",
      "documents",
      "recordHash",
    ],
    label,
  );
  schemaVersion(adapter.schemaVersion, label);
  id(adapter.adapterRevisionId, `${label}.adapterRevisionId`);
  stableId(adapter.adapterId, `${label}.adapterId`);
  exact(
    id(adapter.sourceId, `${label}.sourceId`),
    source.sourceId,
    `${label}.sourceId`,
  );
  const files = validateFileManifest(
    adapter.packageFiles,
    `${label}.packageFiles`,
  );
  const expectedPackageDigest = adapterPackageDigest(files);
  exact(
    digest(adapter.packageDigest, `${label}.packageDigest`),
    expectedPackageDigest,
    `${label}.packageDigest`,
  );
  exact(
    adapter.adapterRevisionId,
    `adapter-revision:v1:${expectedPackageDigest}`,
    `${label}.adapterRevisionId`,
  );
  const manifest = files.find((file) => file.path === "manifest.json");
  if (manifest === undefined)
    fail(`${label}.packageFiles is missing manifest.json`);
  exact(
    digest(adapter.manifestDigest, `${label}.manifestDigest`),
    manifest.sha256,
    `${label}.manifestDigest`,
  );
  const scripts = files.filter((file) => file.path.endsWith(".gd"));
  if (scripts.length < 1)
    fail(`${label}.packageFiles contains no GDScript implementation`);
  const implementationDigest = sha256(
    Buffer.from(
      `project-adapter-implementation-v1\0${scripts.map((file) => `${file.path}:${file.sha256}`).join("\n")}`,
      "utf8",
    ),
  );
  exact(
    digest(adapter.implementationDigest, `${label}.implementationDigest`),
    implementationDigest,
    `${label}.implementationDigest`,
  );
  if (
    !Array.isArray(adapter.payloadSchemas) ||
    adapter.payloadSchemas.length < 1 ||
    adapter.payloadSchemas.length > 256
  ) {
    fail(`${label}.payloadSchemas must contain 1..256 schemas`);
  }
  adapter.payloadSchemas.forEach((schema, index) => {
    const schemaLabel = `${label}.payloadSchemas[${index}]`;
    exactKeys(schema, ["schemaId", "path", "sha256"], schemaLabel);
    stableId(schema.schemaId, `${schemaLabel}.schemaId`);
    packagePath(schema.path, `${schemaLabel}.path`);
    digest(schema.sha256, `${schemaLabel}.sha256`);
    const file = files.find((candidate) => candidate.path === schema.path);
    if (file === undefined || file.sha256 !== schema.sha256) {
      fail(`${schemaLabel} does not match a package file`);
    }
  });
  assertUnique(
    adapter.payloadSchemas,
    (schema) => schema.schemaId,
    `${label}.payloadSchemas schema IDs`,
  );
  assertUnique(
    adapter.payloadSchemas,
    (schema) => schema.path,
    `${label}.payloadSchemas paths`,
  );
  const payloadSchemaDigest = sha256(
    Buffer.from(
      `project-adapter-payload-schemas-v1\0${adapter.payloadSchemas.map((schema) => `${schema.schemaId}:${schema.sha256}`).join("\n")}`,
      "utf8",
    ),
  );
  exact(
    digest(adapter.payloadSchemaDigest, `${label}.payloadSchemaDigest`),
    payloadSchemaDigest,
    `${label}.payloadSchemaDigest`,
  );
  digest(adapter.sdkDigest, `${label}.sdkDigest`);
  digest(adapter.bridgeDigest, `${label}.bridgeDigest`);
  id(adapter.conformanceReceiptId, `${label}.conformanceReceiptId`);
  validateModules(adapter.modules, `${label}.modules`);
  exact(
    integer(adapter.contentFileCount, 1, 512, `${label}.contentFileCount`),
    files.length,
    `${label}.contentFileCount`,
  );
  exact(
    integer(
      adapter.contentByteLength,
      1,
      256 * 1024 * 1024,
      `${label}.contentByteLength`,
    ),
    files.reduce((total, file) => total + file.byteLength, 0),
    `${label}.contentByteLength`,
  );
  const documents = validateAdapterDocuments(
    adapter.documents,
    adapter,
    `${label}.documents`,
  );
  verifyOwnHash(adapter, label);
  return documents;
};

const validateEnvironment = (environment, source, adapter) => {
  const label = "$evidence.environment";
  exactKeys(
    environment,
    [
      "schemaVersion",
      "environmentId",
      "environmentRevisionId",
      "sourceId",
      "adapterRevisionId",
      "sdkDigest",
      "bridgeDigest",
      "toolchainReceiptId",
      "conformanceReceiptId",
      "observerEffectReceiptId",
      "policyProfileDigest",
      "publicationOperationId",
      "revisionFiles",
      "contentDigest",
      "publishedAt",
      "revisionPackage",
      "recordHash",
    ],
    label,
  );
  schemaVersion(environment.schemaVersion, label);
  id(environment.environmentId, `${label}.environmentId`);
  id(environment.environmentRevisionId, `${label}.environmentRevisionId`);
  exact(
    id(environment.sourceId, `${label}.sourceId`),
    source.sourceId,
    `${label}.sourceId`,
  );
  exact(
    id(environment.adapterRevisionId, `${label}.adapterRevisionId`),
    adapter.adapterRevisionId,
    `${label}.adapterRevisionId`,
  );
  exact(
    digest(environment.sdkDigest, `${label}.sdkDigest`),
    adapter.sdkDigest,
    `${label}.sdkDigest`,
  );
  exact(
    digest(environment.bridgeDigest, `${label}.bridgeDigest`),
    adapter.bridgeDigest,
    `${label}.bridgeDigest`,
  );
  id(environment.toolchainReceiptId, `${label}.toolchainReceiptId`);
  exact(
    id(environment.conformanceReceiptId, `${label}.conformanceReceiptId`),
    adapter.conformanceReceiptId,
    `${label}.conformanceReceiptId`,
  );
  id(environment.observerEffectReceiptId, `${label}.observerEffectReceiptId`);
  digest(environment.policyProfileDigest, `${label}.policyProfileDigest`);
  id(environment.publicationOperationId, `${label}.publicationOperationId`);
  const revisionFiles = validateFileManifest(
    environment.revisionFiles,
    `${label}.revisionFiles`,
  );
  for (const adapterFile of adapter.packageFiles) {
    const stored = revisionFiles.find(
      (file) => file.path === `adapter/${adapterFile.path}`,
    );
    if (
      stored === undefined ||
      stored.byteLength !== adapterFile.byteLength ||
      stored.sha256 !== adapterFile.sha256
    ) {
      fail(
        `${label}.revisionFiles does not preserve adapter/${adapterFile.path}`,
      );
    }
  }
  for (const requiredRecord of [
    "records/adapter-revision.v1.json",
    "records/conformance-receipt.v1.json",
    "records/observer-effect-receipt.v1.json",
  ]) {
    if (!revisionFiles.some((file) => file.path === requiredRecord)) {
      fail(`${label}.revisionFiles is missing ${requiredRecord}`);
    }
  }
  const contentDigest = packageDigest(revisionFiles);
  exact(
    digest(environment.contentDigest, `${label}.contentDigest`),
    contentDigest,
    `${label}.contentDigest`,
  );
  const identityBasis = {
    schemaVersion: 1,
    environmentId: environment.environmentId,
    sourceId: environment.sourceId,
    adapterRevisionId: environment.adapterRevisionId,
    sdkDigest: environment.sdkDigest,
    bridgeDigest: environment.bridgeDigest,
    toolchainReceiptId: environment.toolchainReceiptId,
    conformanceReceiptId: environment.conformanceReceiptId,
    observerEffectReceiptId: environment.observerEffectReceiptId,
    policyProfileDigest: environment.policyProfileDigest,
    publicationOperationId: environment.publicationOperationId,
    contentDigest,
  };
  exact(
    environment.environmentRevisionId,
    `environment-revision:v1:${contentHash(identityBasis)}`,
    `${label}.environmentRevisionId`,
  );
  const revisionPackage = environment.revisionPackage;
  exactKeys(
    revisionPackage,
    ["schemaVersion", "payloadHash", "packageSeal", "recordHash"],
    `${label}.revisionPackage`,
  );
  schemaVersion(revisionPackage.schemaVersion, `${label}.revisionPackage`);
  const payload = Object.fromEntries(
    Object.entries(environment).filter(
      ([key]) =>
        key !== "revisionFiles" &&
        key !== "revisionPackage" &&
        key !== "recordHash",
    ),
  );
  // The immutable store payload is ProjectEnvironmentRevisionV1; its files
  // and physical seal are represented separately in this evidence view.
  exact(
    digest(revisionPackage.payloadHash, `${label}.revisionPackage.payloadHash`),
    contentHash(payload),
    `${label}.revisionPackage.payloadHash`,
  );
  const envelopeBasis = {
    schemaVersion: 1,
    ownerId: environment.environmentId,
    resourceId: environment.environmentRevisionId,
    payload,
    payloadHash: revisionPackage.payloadHash,
  };
  validatePackageSeal(
    revisionPackage.packageSeal,
    {
      ownerId: environment.environmentId,
      resourceId: environment.environmentRevisionId,
      operationId: environment.publicationOperationId,
      recordHash: contentHash(envelopeBasis),
      files: revisionFiles,
    },
    `${label}.revisionPackage.packageSeal`,
  );
  verifyOwnHash(revisionPackage, `${label}.revisionPackage`);
  timestamp(environment.publishedAt, `${label}.publishedAt`);
  verifyOwnHash(environment, label);
};

const validatePublishedRecord = (entry, expectedFile, label) => {
  exactKeys(
    entry,
    ["schemaVersion", "path", "byteLength", "sha256", "receipt", "recordHash"],
    label,
  );
  schemaVersion(entry.schemaVersion, label);
  exact(entry.path, expectedFile.path, `${label}.path`);
  exact(entry.byteLength, expectedFile.byteLength, `${label}.byteLength`);
  exact(entry.sha256, expectedFile.sha256, `${label}.sha256`);
  const bytes = Buffer.from(`${canonicalJson(entry.receipt)}\n`, "utf8");
  exact(
    bytes.byteLength,
    expectedFile.byteLength,
    `${label} canonical byte length`,
  );
  exact(sha256(bytes), expectedFile.sha256, `${label} canonical SHA-256`);
  verifyOwnHash(entry, label);
};

const validatePublishedReceipts = (published, environment, adapter) => {
  const label = "$evidence.publishedReceipts";
  exactKeys(
    published,
    ["schemaVersion", "conformance", "observerEffect", "recordHash"],
    label,
  );
  schemaVersion(published.schemaVersion, label);
  const conformanceFile = environment.revisionFiles.find(
    (file) => file.path === "records/conformance-receipt.v1.json",
  );
  const observerFile = environment.revisionFiles.find(
    (file) => file.path === "records/observer-effect-receipt.v1.json",
  );
  if (conformanceFile === undefined || observerFile === undefined) {
    fail(`${label} referenced records are absent from the revision manifest`);
  }
  validatePublishedRecord(
    published.conformance,
    conformanceFile,
    `${label}.conformance`,
  );
  validatePublishedRecord(
    published.observerEffect,
    observerFile,
    `${label}.observerEffect`,
  );
  const conformance = published.conformance.receipt;
  exactKeys(
    conformance,
    [
      "schemaVersion",
      "receiptId",
      "taskId",
      "attemptId",
      "sourceId",
      "candidateId",
      "candidateDigest",
      "toolchainReceiptId",
      "capabilitySet",
      "stateDomains",
      "observations",
      "coverage",
      "cleanup",
      "outcome",
      "failures",
      "startedAt",
      "completedAt",
    ],
    `${label}.conformance.receipt`,
  );
  schemaVersion(conformance.schemaVersion, `${label}.conformance.receipt`);
  exact(
    conformance.receiptId,
    environment.conformanceReceiptId,
    `${label}.conformance.receipt.receiptId`,
  );
  exact(
    conformance.sourceId,
    environment.sourceId,
    `${label}.conformance.receipt.sourceId`,
  );
  exact(
    conformance.toolchainReceiptId,
    environment.toolchainReceiptId,
    `${label}.conformance.receipt.toolchainReceiptId`,
  );
  digest(
    conformance.candidateDigest,
    `${label}.conformance.receipt.candidateDigest`,
  );
  exactKeys(
    conformance.capabilitySet,
    ["schemaVersion", "modules"],
    `${label}.conformance.receipt.capabilitySet`,
  );
  schemaVersion(
    conformance.capabilitySet.schemaVersion,
    `${label}.conformance.receipt.capabilitySet`,
  );
  validateModules(
    conformance.capabilitySet.modules,
    `${label}.conformance.receipt.capabilitySet.modules`,
  );
  exact(
    conformance.capabilitySet.modules,
    adapter.modules,
    `${label}.conformance receipt modules`,
  );
  if (
    !Array.isArray(conformance.stateDomains) ||
    conformance.stateDomains.length < 1 ||
    conformance.stateDomains.length > 256
  ) {
    fail(
      `${label}.conformance.receipt.stateDomains must be nonempty and bounded`,
    );
  }
  conformance.stateDomains.forEach((domain, index) => {
    const item = `${label}.conformance.receipt.stateDomains[${index}]`;
    exactKeys(
      domain,
      [
        "schemaVersion",
        "domainId",
        "disposition",
        "schemaDigest",
        "limitations",
      ],
      item,
    );
    schemaVersion(domain.schemaVersion, item);
    stableId(domain.domainId, `${item}.domainId`);
    if (
      ![
        "captured",
        "reset",
        "externally_controlled",
        "unsupported",
        "uncontrolled",
      ].includes(domain.disposition)
    )
      fail(`${item}.disposition is unsupported`);
    if (domain.disposition === "captured")
      digest(domain.schemaDigest, `${item}.schemaDigest`);
    else if (domain.schemaDigest !== null)
      fail(`${item}.schemaDigest must be null when not captured`);
    if (!Array.isArray(domain.limitations) || domain.limitations.length > 64)
      fail(`${item}.limitations is not bounded`);
    domain.limitations.forEach((value, limitationIndex) =>
      string(value, `${item}.limitations[${limitationIndex}]`),
    );
    if (domain.disposition !== "captured" && domain.limitations.length === 0)
      fail(`${item} requires a limitation`);
  });
  assertUnique(
    conformance.stateDomains,
    (domain) => domain.domainId,
    `${label}.conformance.receipt.stateDomains`,
  );
  exactKeys(
    conformance.observations,
    [
      "schemaVersion",
      "bridgeHandshakes",
      "entityLifecycleRecords",
      "stateSamples",
      "queries",
      "declaredCustomEventTypes",
      "observedCustomEventTypes",
      "captures",
    ],
    `${label}.conformance.receipt.observations`,
  );
  schemaVersion(
    conformance.observations.schemaVersion,
    `${label}.conformance.receipt.observations`,
  );
  for (const key of [
    "bridgeHandshakes",
    "entityLifecycleRecords",
    "stateSamples",
    "queries",
    "captures",
  ])
    integer(
      conformance.observations[key],
      1,
      Number.MAX_SAFE_INTEGER,
      `${label}.conformance.receipt.observations.${key}`,
    );
  integer(
    conformance.observations.declaredCustomEventTypes,
    0,
    Number.MAX_SAFE_INTEGER,
    `${label}.conformance.receipt.observations.declaredCustomEventTypes`,
  );
  exact(
    conformance.observations.observedCustomEventTypes,
    conformance.observations.declaredCustomEventTypes,
    `${label}.conformance custom event coverage`,
  );
  validateCompleteCoverage(
    conformance.coverage,
    `${label}.conformance.receipt.coverage`,
  );
  validateCleanup(conformance.cleanup, `${label}.conformance.receipt.cleanup`);
  exact(
    conformance.outcome,
    "conformed",
    `${label}.conformance.receipt.outcome`,
  );
  exact(conformance.failures, [], `${label}.conformance.receipt.failures`);
  timestamp(conformance.startedAt, `${label}.conformance.receipt.startedAt`);
  timestamp(
    conformance.completedAt,
    `${label}.conformance.receipt.completedAt`,
  );
  const observer = published.observerEffect.receipt;
  exactKeys(
    observer,
    [
      "schemaVersion",
      "receiptId",
      "taskId",
      "attemptId",
      "sourceId",
      "candidateId",
      "status",
      "differences",
      "alignmentGaps",
      "unknowns",
      "observedAt",
    ],
    `${label}.observerEffect.receipt`,
  );
  schemaVersion(observer.schemaVersion, `${label}.observerEffect.receipt`);
  exact(
    observer.receiptId,
    environment.observerEffectReceiptId,
    `${label}.observerEffect.receipt.receiptId`,
  );
  exact(
    observer.taskId,
    conformance.taskId,
    `${label}.observerEffect.receipt.taskId`,
  );
  exact(
    observer.attemptId,
    conformance.attemptId,
    `${label}.observerEffect.receipt.attemptId`,
  );
  exact(
    observer.sourceId,
    conformance.sourceId,
    `${label}.observerEffect.receipt.sourceId`,
  );
  exact(
    observer.candidateId,
    conformance.candidateId,
    `${label}.observerEffect.receipt.candidateId`,
  );
  exact(observer.status, "measured", `${label}.observerEffect.receipt.status`);
  for (const arrayName of ["alignmentGaps", "unknowns"]) {
    if (!Array.isArray(observer[arrayName]) || observer[arrayName].length > 256)
      fail(`${label}.observerEffect.receipt.${arrayName} is not bounded`);
    observer[arrayName].forEach((value, index) =>
      string(value, `${label}.observerEffect.receipt.${arrayName}[${index}]`),
    );
  }
  if (!Array.isArray(observer.differences) || observer.differences.length > 256)
    fail(`${label}.observerEffect.receipt.differences is not bounded`);
  observer.differences.forEach((difference, index) => {
    const item = `${label}.observerEffect.receipt.differences[${index}]`;
    exactKeys(
      difference,
      [
        "schemaVersion",
        "comparison",
        "dimension",
        "baselineDigest",
        "instrumentedDigest",
        "description",
      ],
      item,
    );
    schemaVersion(difference.schemaVersion, item);
    if (
      !["vanilla_to_bridge", "bridge_to_instrumented"].includes(
        difference.comparison,
      )
    )
      fail(`${item}.comparison is unsupported`);
    stableId(difference.dimension, `${item}.dimension`);
    if (difference.baselineDigest !== null)
      digest(difference.baselineDigest, `${item}.baselineDigest`);
    if (difference.instrumentedDigest !== null)
      digest(difference.instrumentedDigest, `${item}.instrumentedDigest`);
    string(difference.description, `${item}.description`);
  });
  timestamp(observer.observedAt, `${label}.observerEffect.receipt.observedAt`);
  verifyOwnHash(published, label);
  return { conformance, observer };
};

const validatePublication = (publication, environment) => {
  const label = "$evidence.publication";
  exactKeys(
    publication,
    [
      "schemaVersion",
      "receiptId",
      "operationId",
      "taskId",
      "attemptId",
      "environmentId",
      "targetEnvironmentRevisionId",
      "expectedCurrentRevisionId",
      "observedCurrentRevisionId",
      "realizedCurrentRevisionId",
      "revisionMaterialized",
      "pointerCommitted",
      "outcome",
      "failures",
      "completedAt",
      "recordHash",
    ],
    label,
  );
  schemaVersion(publication.schemaVersion, label);
  id(publication.receiptId, `${label}.receiptId`);
  exact(
    id(publication.operationId, `${label}.operationId`),
    environment.publicationOperationId,
    `${label}.operationId`,
  );
  id(publication.taskId, `${label}.taskId`);
  id(publication.attemptId, `${label}.attemptId`);
  exact(
    id(publication.environmentId, `${label}.environmentId`),
    environment.environmentId,
    `${label}.environmentId`,
  );
  exact(
    id(
      publication.targetEnvironmentRevisionId,
      `${label}.targetEnvironmentRevisionId`,
    ),
    environment.environmentRevisionId,
    `${label}.targetEnvironmentRevisionId`,
  );
  exact(
    publication.expectedCurrentRevisionId,
    null,
    `${label}.expectedCurrentRevisionId`,
  );
  exact(
    publication.observedCurrentRevisionId,
    null,
    `${label}.observedCurrentRevisionId`,
  );
  exact(
    publication.realizedCurrentRevisionId,
    environment.environmentRevisionId,
    `${label}.realizedCurrentRevisionId`,
  );
  exact(
    bool(publication.revisionMaterialized, `${label}.revisionMaterialized`),
    true,
    `${label}.revisionMaterialized`,
  );
  exact(
    bool(publication.pointerCommitted, `${label}.pointerCommitted`),
    true,
    `${label}.pointerCommitted`,
  );
  exact(publication.outcome, "committed", `${label}.outcome`);
  exact(publication.failures, [], `${label}.failures`);
  timestamp(publication.completedAt, `${label}.completedAt`);
  const receiptBasis = Object.fromEntries(
    Object.entries(publication).filter(
      ([key]) => key !== "receiptId" && key !== "recordHash",
    ),
  );
  exact(
    publication.receiptId,
    `publication-receipt:v1:${contentHash(receiptBasis)}`,
    `${label}.receiptId`,
  );
  verifyOwnHash(publication, label);
};

const validateBuild = (
  build,
  source,
  adapter,
  environment,
  compatibility,
  options = {},
) => {
  const label = options.label ?? "$evidence.candidateBuild";
  exactKeys(
    build,
    [
      "schemaVersion",
      "taskId",
      "workspaceId",
      "sourceId",
      "buildId",
      "baselineSourceHash",
      "sourceHash",
      "workspaceDiffHash",
      "buildConfigurationHash",
      "projectHash",
      "outputHash",
      "bindingEpochId",
      "environmentRevisionId",
      "adapterRevisionId",
      "payloadSchemaDigest",
      "sdkDigest",
      "bridgeDigest",
      "toolchainReceiptId",
      "compatibilityReceiptId",
      "createdAt",
      "recordHash",
    ],
    label,
  );
  schemaVersion(build.schemaVersion, label);
  id(build.taskId, `${label}.taskId`);
  id(build.workspaceId, `${label}.workspaceId`);
  digest(build.baselineSourceHash, `${label}.baselineSourceHash`);
  digest(build.sourceHash, `${label}.sourceHash`);
  exact(
    build.baselineSourceHash,
    source.selectedTreeSha256,
    `${label}.baselineSourceHash`,
  );
  if (
    (options.requireChange ?? true) &&
    build.sourceHash === build.baselineSourceHash
  ) {
    fail(
      `${label} does not contain the required non-empty candidate source change`,
    );
  }
  if (
    !(options.requireChange ?? true) &&
    build.sourceHash !== build.baselineSourceHash
  ) {
    fail(`${label} reuse Build changed the baseline source`);
  }
  exact(
    id(build.sourceId, `${label}.sourceId`),
    `source:${build.sourceHash}`,
    `${label}.sourceId`,
  );
  const workspaceDiffHash = contentHash({
    schemaVersion: 1,
    baselineSourceHash: build.baselineSourceHash,
    candidateSourceHash: build.sourceHash,
  });
  exact(
    digest(build.workspaceDiffHash, `${label}.workspaceDiffHash`),
    workspaceDiffHash,
    `${label}.workspaceDiffHash`,
  );
  digest(build.buildConfigurationHash, `${label}.buildConfigurationHash`);
  digest(build.projectHash, `${label}.projectHash`);
  exact(
    build.projectHash,
    sha256(
      Buffer.from(
        `chronorift-project-environment-build-v1\0${build.sourceHash}\0${build.buildConfigurationHash}`,
        "utf8",
      ),
    ),
    `${label}.projectHash`,
  );
  exact(
    digest(build.outputHash, `${label}.outputHash`),
    build.projectHash,
    `${label}.outputHash`,
  );
  exact(
    id(build.buildId, `${label}.buildId`),
    `build:${contentHash({ schemaVersion: 1, projectHash: build.projectHash, buildConfigurationHash: build.buildConfigurationHash, outputHash: build.outputHash })}`,
    `${label}.buildId`,
  );
  id(build.bindingEpochId, `${label}.bindingEpochId`);
  exact(
    id(build.environmentRevisionId, `${label}.environmentRevisionId`),
    environment.environmentRevisionId,
    `${label}.environmentRevisionId`,
  );
  exact(
    id(build.adapterRevisionId, `${label}.adapterRevisionId`),
    adapter.adapterRevisionId,
    `${label}.adapterRevisionId`,
  );
  exact(
    digest(build.payloadSchemaDigest, `${label}.payloadSchemaDigest`),
    adapter.payloadSchemaDigest,
    `${label}.payloadSchemaDigest`,
  );
  exact(
    digest(build.sdkDigest, `${label}.sdkDigest`),
    environment.sdkDigest,
    `${label}.sdkDigest`,
  );
  exact(
    digest(build.bridgeDigest, `${label}.bridgeDigest`),
    environment.bridgeDigest,
    `${label}.bridgeDigest`,
  );
  exact(
    id(build.toolchainReceiptId, `${label}.toolchainReceiptId`),
    environment.toolchainReceiptId,
    `${label}.toolchainReceiptId`,
  );
  exact(
    id(build.compatibilityReceiptId, `${label}.compatibilityReceiptId`),
    compatibility.receiptId,
    `${label}.compatibilityReceiptId`,
  );
  timestamp(build.createdAt, `${label}.createdAt`);
  verifyOwnHash(build, label);
};

const compatibilityProductBody = (compatibility, adapter) => ({
  schemaVersion: compatibility.schemaVersion,
  receiptId: compatibility.receiptId,
  taskId: compatibility.taskId,
  buildId: compatibility.buildId,
  sourceId: compatibility.sourceId,
  environmentRevisionId: compatibility.environmentRevisionId,
  adapterRevisionId: compatibility.adapterRevisionId,
  toolchainReceiptId: compatibility.toolchainReceiptId,
  bridgeHandshakeObserved: compatibility.bridgeHandshakeObserved,
  instrumentedLaunchObserved: compatibility.instrumentedLaunchObserved,
  queryObservations: compatibility.queryObservations,
  coverage: compatibility.coverage,
  capabilitySet: { schemaVersion: 1, modules: adapter.modules },
  cleanup: compatibility.cleanup,
  outcome: compatibility.outcome,
  failures: compatibility.failures,
  observedAt: compatibility.observedAt,
});

const compatibilityProductFromStoredReceipt = (
  stored,
  adapter,
  environment,
  label,
) => {
  plainObject(stored, label);
  exactKeys(
    stored,
    [
      "schemaVersion",
      "receiptId",
      "taskId",
      "buildId",
      "sourceId",
      "environmentRevisionId",
      "adapterRevisionId",
      "toolchainReceiptId",
      "bridgeHandshakeObserved",
      "instrumentedLaunchObserved",
      "queryObservations",
      "coverage",
      "capabilitySet",
      "cleanup",
      "outcome",
      "failures",
      "observedAt",
    ],
    label,
  );
  plainObject(stored.capabilitySet, `${label}.capabilitySet`);
  exactKeys(
    stored.capabilitySet,
    ["schemaVersion", "modules"],
    `${label}.capabilitySet`,
  );
  schemaVersion(
    stored.capabilitySet.schemaVersion,
    `${label}.capabilitySet.schemaVersion`,
  );
  exact(
    stored.capabilitySet.modules,
    adapter.modules,
    `${label}.capabilitySet.modules`,
  );
  const { receiptId, ...content } = stored;
  exact(
    receiptId,
    `compatibility:v1:${contentHash(content)}`,
    `${label}.receiptId`,
  );
  const productBasis = {
    schemaVersion: stored.schemaVersion,
    receiptId: stored.receiptId,
    taskId: stored.taskId,
    buildId: stored.buildId,
    sourceId: stored.sourceId,
    environmentRevisionId: stored.environmentRevisionId,
    adapterRevisionId: stored.adapterRevisionId,
    toolchainReceiptId: stored.toolchainReceiptId,
    bridgeHandshakeObserved: stored.bridgeHandshakeObserved,
    instrumentedLaunchObserved: stored.instrumentedLaunchObserved,
    queryObservations: stored.queryObservations,
    coverage: stored.coverage,
    modules: stored.capabilitySet.modules,
    cleanup: stored.cleanup,
    outcome: stored.outcome,
    failures: stored.failures,
    observedAt: stored.observedAt,
  };
  const product = { ...productBasis, recordHash: contentHash(productBasis) };
  validateCompatibility(product, adapter, environment, `${label}.product`);
  exact(
    stored,
    compatibilityProductBody(product, adapter),
    `${label}.canonical stored body`,
  );
  return product;
};

const validateCompatibility = (
  compatibility,
  adapter,
  environment,
  selectedLabel,
) => {
  const label = selectedLabel ?? "$evidence.compatibility";
  exactKeys(
    compatibility,
    [
      "schemaVersion",
      "receiptId",
      "taskId",
      "buildId",
      "sourceId",
      "environmentRevisionId",
      "adapterRevisionId",
      "toolchainReceiptId",
      "bridgeHandshakeObserved",
      "instrumentedLaunchObserved",
      "queryObservations",
      "coverage",
      "modules",
      "cleanup",
      "outcome",
      "failures",
      "observedAt",
      "recordHash",
    ],
    label,
  );
  schemaVersion(compatibility.schemaVersion, label);
  id(compatibility.receiptId, `${label}.receiptId`);
  id(compatibility.taskId, `${label}.taskId`);
  id(compatibility.buildId, `${label}.buildId`);
  id(compatibility.sourceId, `${label}.sourceId`);
  exact(
    compatibility.environmentRevisionId,
    environment.environmentRevisionId,
    `${label}.environmentRevisionId`,
  );
  exact(
    compatibility.adapterRevisionId,
    adapter.adapterRevisionId,
    `${label}.adapterRevisionId`,
  );
  exact(
    compatibility.toolchainReceiptId,
    environment.toolchainReceiptId,
    `${label}.toolchainReceiptId`,
  );
  exact(
    bool(
      compatibility.bridgeHandshakeObserved,
      `${label}.bridgeHandshakeObserved`,
    ),
    true,
    `${label}.bridgeHandshakeObserved`,
  );
  exact(
    bool(
      compatibility.instrumentedLaunchObserved,
      `${label}.instrumentedLaunchObserved`,
    ),
    true,
    `${label}.instrumentedLaunchObserved`,
  );
  exactKeys(
    compatibility.queryObservations,
    [
      "schemaVersion",
      "entityQueryObserved",
      "stateQueryObserved",
      "entityRows",
      "stateRows",
    ],
    `${label}.queryObservations`,
  );
  schemaVersion(
    compatibility.queryObservations.schemaVersion,
    `${label}.queryObservations`,
  );
  exact(
    bool(
      compatibility.queryObservations.entityQueryObserved,
      `${label}.queryObservations.entityQueryObserved`,
    ),
    true,
    `${label}.queryObservations.entityQueryObserved`,
  );
  exact(
    bool(
      compatibility.queryObservations.stateQueryObserved,
      `${label}.queryObservations.stateQueryObserved`,
    ),
    true,
    `${label}.queryObservations.stateQueryObserved`,
  );
  integer(
    compatibility.queryObservations.entityRows,
    1,
    Number.MAX_SAFE_INTEGER,
    `${label}.queryObservations.entityRows`,
  );
  integer(
    compatibility.queryObservations.stateRows,
    1,
    Number.MAX_SAFE_INTEGER,
    `${label}.queryObservations.stateRows`,
  );
  if (
    !Array.isArray(compatibility.coverage) ||
    compatibility.coverage.length < 1 ||
    compatibility.coverage.length > 256
  ) {
    fail(`${label}.coverage must contain 1..256 channels`);
  }
  compatibility.coverage.forEach((entry, index) => {
    const coverageLabel = `${label}.coverage[${index}]`;
    exactKeys(
      entry,
      [
        "schemaVersion",
        "channelId",
        "status",
        "observedRecords",
        "droppedRecords",
        "overwrittenRecords",
        "limitations",
      ],
      coverageLabel,
    );
    schemaVersion(entry.schemaVersion, coverageLabel);
    stableId(entry.channelId, `${coverageLabel}.channelId`);
    exact(entry.status, "complete", `${coverageLabel}.status`);
    integer(
      entry.observedRecords,
      1,
      Number.MAX_SAFE_INTEGER,
      `${coverageLabel}.observedRecords`,
    );
    exact(
      integer(entry.droppedRecords, 0, 0, `${coverageLabel}.droppedRecords`),
      0,
      `${coverageLabel}.droppedRecords`,
    );
    exact(
      integer(
        entry.overwrittenRecords,
        0,
        0,
        `${coverageLabel}.overwrittenRecords`,
      ),
      0,
      `${coverageLabel}.overwrittenRecords`,
    );
    exact(entry.limitations, [], `${coverageLabel}.limitations`);
  });
  assertUnique(
    compatibility.coverage,
    (entry) => entry.channelId,
    `${label}.coverage`,
  );
  validateModules(compatibility.modules, `${label}.modules`);
  exact(compatibility.modules, adapter.modules, `${label}.modules`);
  validateCleanup(compatibility.cleanup, `${label}.cleanup`);
  exact(compatibility.outcome, "compatible", `${label}.outcome`);
  exact(compatibility.failures, [], `${label}.failures`);
  timestamp(compatibility.observedAt, `${label}.observedAt`);
  const compatibilityContent = {
    schemaVersion: 1,
    taskId: compatibility.taskId,
    buildId: compatibility.buildId,
    sourceId: compatibility.sourceId,
    environmentRevisionId: compatibility.environmentRevisionId,
    adapterRevisionId: compatibility.adapterRevisionId,
    toolchainReceiptId: compatibility.toolchainReceiptId,
    bridgeHandshakeObserved: compatibility.bridgeHandshakeObserved,
    instrumentedLaunchObserved: compatibility.instrumentedLaunchObserved,
    queryObservations: compatibility.queryObservations,
    coverage: compatibility.coverage,
    capabilitySet: { schemaVersion: 1, modules: compatibility.modules },
    cleanup: compatibility.cleanup,
    outcome: compatibility.outcome,
    failures: compatibility.failures,
    observedAt: compatibility.observedAt,
  };
  exact(
    compatibility.receiptId,
    `compatibility:v1:${contentHash(compatibilityContent)}`,
    `${label}.receiptId`,
  );
  verifyOwnHash(compatibility, label);
};

const validateBinding = (binding, publication, environment, compatibility) => {
  const label = "$evidence.binding";
  exactKeys(
    binding,
    [
      "schemaVersion",
      "bindingEpochId",
      "taskId",
      "ordinal",
      "state",
      "attemptId",
      "environment",
      "publicationOperationId",
      "publicationReceiptId",
      "compatibilityReceiptId",
      "createdAt",
      "boundAt",
      "recordHash",
    ],
    label,
  );
  schemaVersion(binding.schemaVersion, label);
  id(binding.bindingEpochId, `${label}.bindingEpochId`);
  exact(
    id(binding.taskId, `${label}.taskId`),
    publication.taskId,
    `${label}.taskId`,
  );
  exact(
    integer(binding.ordinal, 0, 0, `${label}.ordinal`),
    0,
    `${label}.ordinal`,
  );
  exact(binding.state, "bound", `${label}.state`);
  exact(
    id(binding.attemptId, `${label}.attemptId`),
    publication.attemptId,
    `${label}.attemptId`,
  );
  const reference = binding.environment;
  exactKeys(
    reference,
    [
      "schemaVersion",
      "environmentId",
      "environmentRevisionId",
      "sourceId",
      "adapterRevisionId",
      "sdkDigest",
      "bridgeDigest",
      "toolchainReceiptId",
      "conformanceReceiptId",
      "observerEffectReceiptId",
      "policyProfileDigest",
      "contentDigest",
    ],
    `${label}.environment`,
  );
  schemaVersion(reference.schemaVersion, `${label}.environment`);
  const expectedReference = Object.fromEntries(
    [
      "schemaVersion",
      "environmentId",
      "environmentRevisionId",
      "sourceId",
      "adapterRevisionId",
      "sdkDigest",
      "bridgeDigest",
      "toolchainReceiptId",
      "conformanceReceiptId",
      "observerEffectReceiptId",
      "policyProfileDigest",
      "contentDigest",
    ].map((key) => [key, environment[key]]),
  );
  exact(reference, expectedReference, `${label}.environment`);
  exact(
    binding.publicationOperationId,
    publication.operationId,
    `${label}.publicationOperationId`,
  );
  exact(
    binding.publicationReceiptId,
    publication.receiptId,
    `${label}.publicationReceiptId`,
  );
  exact(
    binding.compatibilityReceiptId,
    compatibility.receiptId,
    `${label}.compatibilityReceiptId`,
  );
  timestamp(binding.createdAt, `${label}.createdAt`);
  timestamp(binding.boundAt, `${label}.boundAt`);
  verifyOwnHash(binding, label);
};

const validateTurnBudget = (budget, label) => {
  exactKeys(
    budget,
    [
      "schemaVersion",
      "wallTimeMs",
      "toolCallLimit",
      "runtimeTimeMs",
      "tokenPolicy",
      "tokenLimit",
      "storageByteLimit",
      "storageInodeLimit",
    ],
    label,
  );
  schemaVersion(budget.schemaVersion, label);
  for (const key of [
    "wallTimeMs",
    "toolCallLimit",
    "runtimeTimeMs",
    "storageByteLimit",
    "storageInodeLimit",
  ])
    integer(budget[key], 1, Number.MAX_SAFE_INTEGER, `${label}.${key}`);
  if (!["observe_only", "hard_limit"].includes(budget.tokenPolicy))
    fail(`${label}.tokenPolicy is unsupported`);
  if (budget.tokenPolicy === "observe_only")
    exact(budget.tokenLimit, null, `${label}.tokenLimit`);
  else
    integer(
      budget.tokenLimit,
      1,
      Number.MAX_SAFE_INTEGER,
      `${label}.tokenLimit`,
    );
};

const validateTurnUsage = (status, usage, label) => {
  if (!["observed", "partial", "unavailable"].includes(status))
    fail(`${label}.usageStatus is unsupported`);
  if (status === "unavailable") {
    exact(usage, null, `${label}.usage`);
    return;
  }
  exactKeys(
    usage,
    [
      "schemaVersion",
      "wallTimeMs",
      "toolCalls",
      "runtimeTimeMs",
      "inputTokens",
      "outputTokens",
      "storageBytes",
      "storageInodes",
    ],
    `${label}.usage`,
  );
  schemaVersion(usage.schemaVersion, `${label}.usage`);
  let observed = 0;
  for (const key of [
    "wallTimeMs",
    "toolCalls",
    "runtimeTimeMs",
    "inputTokens",
    "outputTokens",
    "storageBytes",
    "storageInodes",
  ]) {
    if (usage[key] !== null) {
      integer(usage[key], 0, Number.MAX_SAFE_INTEGER, `${label}.usage.${key}`);
      observed += 1;
    }
  }
  if (observed === 0) fail(`${label}.usage must contain an observed counter`);
  if (status === "observed" && observed !== 7)
    fail(`${label}.observed usage must contain every counter`);
  if (status === "partial" && observed === 7)
    fail(`${label}.partial usage must leave at least one counter unavailable`);
};

const validateTurns = (turns, binding, publication) => {
  const label = "$evidence.turns";
  if (!Array.isArray(turns) || turns.length !== 2) {
    fail(`${label} must contain exactly initialization and user-goal turns`);
  }
  const expectedPurposes = ["environment_initialization", "user_goal"];
  turns.forEach((turn, index) => {
    const itemLabel = `${label}[${index}]`;
    exactKeys(
      turn,
      [
        "schemaVersion",
        "sequence",
        "turnId",
        "taskId",
        "sessionId",
        "purpose",
        "attemptId",
        "bindingEpochId",
        "promptDigest",
        "queuedGoalDigest",
        "budget",
        "usageStatus",
        "usage",
        "status",
        "terminalCode",
        "terminalMessage",
        "startedAt",
        "endedAt",
        "recordHash",
      ],
      itemLabel,
    );
    schemaVersion(turn.schemaVersion, itemLabel);
    exact(
      integer(turn.sequence, index, index, `${itemLabel}.sequence`),
      index,
      `${itemLabel}.sequence`,
    );
    id(turn.turnId, `${itemLabel}.turnId`);
    exact(
      id(turn.taskId, `${itemLabel}.taskId`),
      publication.taskId,
      `${itemLabel}.taskId`,
    );
    id(turn.sessionId, `${itemLabel}.sessionId`);
    exact(turn.purpose, expectedPurposes[index], `${itemLabel}.purpose`);
    digest(turn.promptDigest, `${itemLabel}.promptDigest`);
    validateTurnBudget(turn.budget, `${itemLabel}.budget`);
    validateTurnUsage(turn.usageStatus, turn.usage, itemLabel);
    exact(turn.status, "completed", `${itemLabel}.status`);
    exact(turn.terminalCode, null, `${itemLabel}.terminalCode`);
    exact(turn.terminalMessage, null, `${itemLabel}.terminalMessage`);
    timestamp(turn.startedAt, `${itemLabel}.startedAt`);
    timestamp(turn.endedAt, `${itemLabel}.endedAt`);
    if (Date.parse(turn.endedAt) < Date.parse(turn.startedAt)) {
      fail(`${itemLabel} ended before it started`);
    }
    verifyOwnHash(turn, itemLabel);
  });
  const [initialization, goal] = turns;
  exact(
    initialization.attemptId,
    publication.attemptId,
    `${label}[0].attemptId`,
  );
  exact(initialization.bindingEpochId, null, `${label}[0].bindingEpochId`);
  digest(initialization.queuedGoalDigest, `${label}[0].queuedGoalDigest`);
  exact(goal.attemptId, null, `${label}[1].attemptId`);
  exact(
    goal.bindingEpochId,
    binding.bindingEpochId,
    `${label}[1].bindingEpochId`,
  );
  exact(goal.queuedGoalDigest, null, `${label}[1].queuedGoalDigest`);
  exact(
    goal.promptDigest,
    initialization.queuedGoalDigest,
    `${label} queued goal delivery`,
  );
  exact(
    goal.sessionId,
    initialization.sessionId,
    `${label} same visible Session`,
  );
  if (
    Date.parse(publication.completedAt) < Date.parse(initialization.endedAt)
  ) {
    fail(`${label} publication preceded initialization completion`);
  }
  if (Date.parse(binding.boundAt) < Date.parse(publication.completedAt)) {
    fail(`${label} binding preceded publication commit`);
  }
  if (Date.parse(goal.startedAt) < Date.parse(binding.boundAt)) {
    fail(`${label} user goal started before binding`);
  }
  return { initialization, goal };
};

const validateRuntime = (runtime, build, compatibility, selectedLabel) => {
  const label = selectedLabel ?? "$evidence.runtime";
  exactKeys(
    runtime,
    [
      "schemaVersion",
      "receiptId",
      "taskId",
      "runtimeId",
      "executionId",
      "buildId",
      "environmentRevisionId",
      "adapterRevisionId",
      "launchTargetId",
      "instrumentationMode",
      "status",
      "bridgeHandshakeCount",
      "clock",
      "queryObservations",
      "captureCount",
      "captureWindowIds",
      "coverage",
      "loss",
      "cleanup",
      "outcome",
      "failures",
      "startedAt",
      "observedAt",
      "completedAt",
      "recordHash",
    ],
    label,
  );
  schemaVersion(runtime.schemaVersion, label);
  id(runtime.receiptId, `${label}.receiptId`);
  exact(runtime.taskId, build.taskId, `${label}.taskId`);
  id(runtime.runtimeId, `${label}.runtimeId`);
  id(runtime.executionId, `${label}.executionId`);
  exact(runtime.buildId, build.buildId, `${label}.buildId`);
  exact(
    runtime.environmentRevisionId,
    build.environmentRevisionId,
    `${label}.environmentRevisionId`,
  );
  exact(
    runtime.adapterRevisionId,
    build.adapterRevisionId,
    `${label}.adapterRevisionId`,
  );
  stableId(runtime.launchTargetId, `${label}.launchTargetId`);
  exact(
    runtime.instrumentationMode,
    "instrumented",
    `${label}.instrumentationMode`,
  );
  exact(runtime.status, "stopped", `${label}.status`);
  integer(runtime.bridgeHandshakeCount, 1, 64, `${label}.bridgeHandshakeCount`);
  if (runtime.clock === null)
    fail(`${label}.clock is required for a succeeded observation`);
  exactKeys(
    runtime.clock,
    [
      "schemaVersion",
      "processFrame",
      "physicsTick",
      "simulationTimeUs",
      "renderFrame",
      "hostMonotonicUs",
    ],
    `${label}.clock`,
  );
  schemaVersion(runtime.clock.schemaVersion, `${label}.clock`);
  for (const key of [
    "processFrame",
    "physicsTick",
    "simulationTimeUs",
    "hostMonotonicUs",
  ]) {
    integer(
      runtime.clock[key],
      0,
      Number.MAX_SAFE_INTEGER,
      `${label}.clock.${key}`,
    );
  }
  if (runtime.clock.renderFrame !== null) {
    integer(
      runtime.clock.renderFrame,
      0,
      Number.MAX_SAFE_INTEGER,
      `${label}.clock.renderFrame`,
    );
  }
  exactKeys(
    runtime.queryObservations,
    [
      "schemaVersion",
      "entityQueryCount",
      "entityRows",
      "stateQueryCount",
      "stateRows",
    ],
    `${label}.queryObservations`,
  );
  schemaVersion(
    runtime.queryObservations.schemaVersion,
    `${label}.queryObservations`,
  );
  integer(
    runtime.queryObservations.entityQueryCount,
    1,
    Number.MAX_SAFE_INTEGER,
    `${label}.queryObservations.entityQueryCount`,
  );
  integer(
    runtime.queryObservations.entityRows,
    1,
    Number.MAX_SAFE_INTEGER,
    `${label}.queryObservations.entityRows`,
  );
  integer(
    runtime.queryObservations.stateQueryCount,
    1,
    Number.MAX_SAFE_INTEGER,
    `${label}.queryObservations.stateQueryCount`,
  );
  integer(
    runtime.queryObservations.stateRows,
    1,
    Number.MAX_SAFE_INTEGER,
    `${label}.queryObservations.stateRows`,
  );
  integer(
    runtime.captureCount,
    1,
    Number.MAX_SAFE_INTEGER,
    `${label}.captureCount`,
  );
  if (
    !Array.isArray(runtime.captureWindowIds) ||
    runtime.captureWindowIds.length !== runtime.captureCount
  ) {
    fail(`${label}.captureWindowIds must name every pinned capture`);
  }
  runtime.captureWindowIds.forEach((value, index) =>
    id(value, `${label}.captureWindowIds[${index}]`),
  );
  assertUnique(
    runtime.captureWindowIds,
    (value) => value,
    `${label}.captureWindowIds`,
  );
  if (
    !Array.isArray(runtime.coverage) ||
    runtime.coverage.length < 1 ||
    runtime.coverage.length > 64
  ) {
    fail(`${label}.coverage must contain 1..64 channels`);
  }
  runtime.coverage.forEach((entry, index) => {
    const coverageLabel = `${label}.coverage[${index}]`;
    exactKeys(
      entry,
      [
        "schemaVersion",
        "channelId",
        "status",
        "observedRecords",
        "droppedRecords",
        "overwrittenRecords",
        "limitations",
      ],
      coverageLabel,
    );
    schemaVersion(entry.schemaVersion, coverageLabel);
    stableId(entry.channelId, `${coverageLabel}.channelId`);
    exact(entry.status, "complete", `${coverageLabel}.status`);
    integer(
      entry.observedRecords,
      1,
      Number.MAX_SAFE_INTEGER,
      `${coverageLabel}.observedRecords`,
    );
    exact(
      integer(entry.droppedRecords, 0, 0, `${coverageLabel}.droppedRecords`),
      0,
      `${coverageLabel}.droppedRecords`,
    );
    exact(
      integer(
        entry.overwrittenRecords,
        0,
        0,
        `${coverageLabel}.overwrittenRecords`,
      ),
      0,
      `${coverageLabel}.overwrittenRecords`,
    );
    exact(entry.limitations, [], `${coverageLabel}.limitations`);
  });
  assertUnique(
    runtime.coverage,
    (entry) => entry.channelId,
    `${label}.coverage`,
  );
  exact(runtime.loss, [], `${label}.loss`);
  validateCleanup(runtime.cleanup, `${label}.cleanup`);
  exact(runtime.outcome, "succeeded", `${label}.outcome`);
  exact(runtime.failures, [], `${label}.failures`);
  const startedAt = timestamp(runtime.startedAt, `${label}.startedAt`);
  const observedAt = timestamp(runtime.observedAt, `${label}.observedAt`);
  const completedAt = timestamp(runtime.completedAt, `${label}.completedAt`);
  if (observedAt < startedAt || completedAt < observedAt) {
    fail(`${label} timestamps are not monotonic`);
  }
  if (startedAt < Date.parse(compatibility.observedAt)) {
    fail(
      `${label} candidate observation started before compatibility completed`,
    );
  }
  verifyOwnHash(runtime, label);
};

const validatePayloadNode = (node, value, path, depth = 0) => {
  if (depth > 16) fail(`${path} payload schema depth exceeded`);
  plainObject(node, `${path} schema`);
  if (Object.hasOwn(node, "$ref")) {
    exactKeys(node, ["$ref"], `${path} schema`);
    string(node.$ref, `${path} schema.$ref`, 256);
    plainObject(value, path);
    return;
  }
  if (typeof node.type !== "string") fail(`${path} schema type is missing`);
  const optionalScalarKeys = [
    "minimum",
    "maximum",
    "const",
    "enum",
    "minLength",
    "maxLength",
  ];
  if (node.type === "null") {
    exactKeys(node, ["type"], `${path} schema`);
    if (value !== null) fail(`${path} expected null`);
    return;
  }
  if (["boolean", "integer", "number", "string"].includes(node.type)) {
    const allowed = [
      "type",
      ...optionalScalarKeys.filter((key) => Object.hasOwn(node, key)),
    ];
    exactKeys(node, allowed, `${path} schema`);
    if (node.type === "boolean" && typeof value !== "boolean")
      fail(`${path} expected boolean`);
    if (
      (node.type === "integer" || node.type === "number") &&
      (typeof value !== "number" ||
        !Number.isFinite(value) ||
        Object.is(value, -0))
    )
      fail(`${path} expected canonical number`);
    if (node.type === "integer" && !Number.isSafeInteger(value))
      fail(`${path} expected safe integer`);
    if (node.type === "string" && typeof value !== "string")
      fail(`${path} expected string`);
    if (node.minimum !== undefined && value < node.minimum)
      fail(`${path} is below minimum`);
    if (node.maximum !== undefined && value > node.maximum)
      fail(`${path} exceeds maximum`);
    if (node.minLength !== undefined && [...value].length < node.minLength)
      fail(`${path} is shorter than minLength`);
    if (node.maxLength !== undefined && [...value].length > node.maxLength)
      fail(`${path} exceeds maxLength`);
    if (node.const !== undefined && value !== node.const)
      fail(`${path} does not match const`);
    if (
      node.enum !== undefined &&
      (!Array.isArray(node.enum) || !node.enum.includes(value))
    )
      fail(`${path} is not in enum`);
    return;
  }
  if (node.type === "array") {
    const keys = [
      "type",
      "items",
      "maxItems",
      ...(Object.hasOwn(node, "minItems") ? ["minItems"] : []),
    ];
    exactKeys(node, keys, `${path} schema`);
    if (!Array.isArray(value)) fail(`${path} expected array`);
    integer(node.maxItems, 0, 16_384, `${path} schema.maxItems`);
    if (node.minItems !== undefined)
      integer(node.minItems, 0, node.maxItems, `${path} schema.minItems`);
    if (
      value.length > node.maxItems ||
      (node.minItems !== undefined && value.length < node.minItems)
    )
      fail(`${path} array length is outside schema bounds`);
    value.forEach((entry, index) =>
      validatePayloadNode(node.items, entry, `${path}[${index}]`, depth + 1),
    );
    return;
  }
  if (node.type !== "object") fail(`${path} schema type is unsupported`);
  const keys = [
    "type",
    "properties",
    "required",
    "additionalProperties",
    ...(Object.hasOwn(node, "minProperties") ? ["minProperties"] : []),
    ...(Object.hasOwn(node, "maxProperties") ? ["maxProperties"] : []),
  ];
  exactKeys(node, keys, `${path} schema`);
  exact(
    node.additionalProperties,
    false,
    `${path} schema.additionalProperties`,
  );
  const properties = plainObject(node.properties, `${path} schema.properties`);
  if (
    Object.keys(properties).length > 256 ||
    !Array.isArray(node.required) ||
    node.required.length > 256
  )
    fail(`${path} object schema is not bounded`);
  node.required.forEach((key, index) =>
    stableId(key, `${path} schema.required[${index}]`),
  );
  assertUnique(node.required, (key) => key, `${path} schema.required`);
  const object = plainObject(value, path);
  for (const required of node.required)
    if (!Object.hasOwn(object, required))
      fail(`${path} missing required ${required}`);
  for (const [key, entry] of Object.entries(object)) {
    if (!Object.hasOwn(properties, key))
      fail(`${path}.${key} is an additional property`);
    validatePayloadNode(properties[key], entry, `${path}.${key}`, depth + 1);
  }
};

const declaration = (values, key, idValue, label) => {
  const result = values.find((value) => value[key] === idValue);
  if (result === undefined) fail(`${label} references undeclared ${idValue}`);
  return result;
};

const validateObservationRecord = (record, adapterDocuments, label) => {
  const baseKeys = [
    "schemaVersion",
    "recordSequence",
    "clock",
    "kind",
    "payload",
  ];
  exactKeys(record, baseKeys, label);
  schemaVersion(record.schemaVersion, label);
  integer(
    record.recordSequence,
    0,
    Number.MAX_SAFE_INTEGER,
    `${label}.recordSequence`,
  );
  exactKeys(
    record.clock,
    ["processFrame", "physicsTick", "simulationTimeUs", "renderFrame"],
    `${label}.clock`,
  );
  for (const key of ["processFrame", "physicsTick", "simulationTimeUs"])
    integer(
      record.clock[key],
      0,
      Number.MAX_SAFE_INTEGER,
      `${label}.clock.${key}`,
    );
  if (record.clock.renderFrame !== null)
    integer(
      record.clock.renderFrame,
      0,
      Number.MAX_SAFE_INTEGER,
      `${label}.clock.renderFrame`,
    );
  const payload = plainObject(record.payload, `${label}.payload`);
  if (record.kind === "clock") {
    exactKeys(payload, [], `${label}.payload`);
    return;
  }
  if (record.kind === "runtime_error") {
    exactKeys(
      payload,
      ["channel", "severity", "code", "message"],
      `${label}.payload`,
    );
    if (!["engine", "script", "bridge", "process"].includes(payload.channel))
      fail(`${label}.payload.channel is unsupported`);
    if (!["warning", "error", "fatal"].includes(payload.severity))
      fail(`${label}.payload.severity is unsupported`);
    if (payload.code !== null) stableId(payload.code, `${label}.payload.code`);
    string(payload.message, `${label}.payload.message`, 2048);
    return;
  }
  if (record.kind === "entity_lifecycle") {
    exactKeys(
      payload,
      [
        "phase",
        "entityId",
        "entityTypeId",
        "incarnation",
        "identityScope",
        "projection",
      ],
      `${label}.payload`,
    );
    if (!["appeared", "updated", "disappeared"].includes(payload.phase))
      fail(`${label}.payload.phase is unsupported`);
    id(payload.entityId, `${label}.payload.entityId`);
    stableId(payload.entityTypeId, `${label}.payload.entityTypeId`);
    integer(
      payload.incarnation,
      1,
      Number.MAX_SAFE_INTEGER,
      `${label}.payload.incarnation`,
    );
    const declared = declaration(
      adapterDocuments.manifest.entityTypes,
      "entityTypeId",
      payload.entityTypeId,
      `${label}.payload.entityTypeId`,
    );
    exact(
      payload.identityScope,
      declared.identityStrategy,
      `${label}.payload.identityScope`,
    );
    if (payload.phase !== "disappeared") {
      const schema = adapterDocuments.schemas.get(declared.schemaId);
      if (schema === undefined) fail(`${label} entity schema is missing`);
      validatePayloadNode(
        schema.root,
        payload.projection,
        `${label}.payload.projection`,
      );
    }
    return;
  }
  if (record.kind === "state_sample") {
    exactKeys(
      payload,
      ["stateDomainId", "value", "semanticCoverage"],
      `${label}.payload`,
    );
    stableId(payload.stateDomainId, `${label}.payload.stateDomainId`);
    exact(
      payload.semanticCoverage,
      "declared",
      `${label}.payload.semanticCoverage`,
    );
    const declared = declaration(
      adapterDocuments.manifest.stateDomains,
      "stateDomainId",
      payload.stateDomainId,
      `${label}.payload.stateDomainId`,
    );
    const schema = adapterDocuments.schemas.get(declared.schemaId);
    if (schema === undefined) fail(`${label} state schema is missing`);
    validatePayloadNode(schema.root, payload.value, `${label}.payload.value`);
    return;
  }
  if (record.kind === "adapter_event") {
    exactKeys(
      payload,
      ["eventTypeId", "sourceEntityId", "value"],
      `${label}.payload`,
    );
    stableId(payload.eventTypeId, `${label}.payload.eventTypeId`);
    if (payload.sourceEntityId !== null)
      id(payload.sourceEntityId, `${label}.payload.sourceEntityId`);
    const declared = declaration(
      adapterDocuments.manifest.eventTypes,
      "eventTypeId",
      payload.eventTypeId,
      `${label}.payload.eventTypeId`,
    );
    const schema = adapterDocuments.schemas.get(declared.schemaId);
    if (schema === undefined) fail(`${label} event schema is missing`);
    validatePayloadNode(schema.root, payload.value, `${label}.payload.value`);
    return;
  }
  if (record.kind === "capture_loss")
    fail(`${label} reports capture loss in a lossless Gate bundle`);
  fail(`${label}.kind is unsupported`);
};

const validatePinnedCaptures = (captures, runtime, adapterDocuments, label) => {
  if (
    !Array.isArray(captures) ||
    captures.length !== runtime.captureWindowIds.length
  )
    fail(`${label} must contain every runtime capture window`);
  const byId = new Map();
  captures.forEach((capture, index) => {
    const item = `${label}[${index}]`;
    exactKeys(
      capture,
      [
        "schemaVersion",
        "manifest",
        "recordsCanonicalBase64",
        "payloadHash",
        "packageSeal",
        "recordHash",
      ],
      item,
    );
    schemaVersion(capture.schemaVersion, item);
    const manifest = plainObject(capture.manifest, `${item}.manifest`);
    exactKeys(
      manifest,
      [
        "schemaVersion",
        "captureWindowId",
        "taskId",
        "runtimeId",
        "executionId",
        "buildId",
        "environmentRevisionId",
        "adapterRevisionId",
        "recordCount",
        "contentDigest",
        "anchorClock",
        "coverage",
        "loss",
        "createdAt",
      ],
      `${item}.manifest`,
    );
    schemaVersion(manifest.schemaVersion, `${item}.manifest`);
    id(manifest.captureWindowId, `${item}.manifest.captureWindowId`);
    exact(manifest.taskId, runtime.taskId, `${item}.manifest.taskId`);
    exact(manifest.runtimeId, runtime.runtimeId, `${item}.manifest.runtimeId`);
    exact(
      manifest.executionId,
      runtime.executionId,
      `${item}.manifest.executionId`,
    );
    exact(manifest.buildId, runtime.buildId, `${item}.manifest.buildId`);
    exact(
      manifest.environmentRevisionId,
      runtime.environmentRevisionId,
      `${item}.manifest.environmentRevisionId`,
    );
    exact(
      manifest.adapterRevisionId,
      runtime.adapterRevisionId,
      `${item}.manifest.adapterRevisionId`,
    );
    validateCompleteCoverage(manifest.coverage, `${item}.manifest.coverage`);
    exact(manifest.loss, [], `${item}.manifest.loss`);
    timestamp(manifest.createdAt, `${item}.manifest.createdAt`);
    const bytes = decodeCanonicalBase64(
      capture.recordsCanonicalBase64,
      `${item}.recordsCanonicalBase64`,
      4 * 1024 * 1024,
    );
    if (!bytes.toString("utf8").endsWith("\n"))
      fail(`${item} raw records omitted final newline`);
    let records;
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      assertNoDuplicateObjectKeys(text, item);
      records = JSON.parse(text);
    } catch (error) {
      fail(`${item} raw records are invalid JSON: ${String(error)}`);
    }
    if (
      !Array.isArray(records) ||
      records.length < 1 ||
      records.length !== manifest.recordCount
    )
      fail(`${item}.manifest.recordCount does not match raw records`);
    if (!bytes.equals(Buffer.from(`${canonicalJson(records)}\n`, "utf8")))
      fail(`${item} raw records are not canonical JSON bytes`);
    records.forEach((record, recordIndex) =>
      validateObservationRecord(
        record,
        adapterDocuments,
        `${item}.records[${recordIndex}]`,
      ),
    );
    const file = {
      path: "records.json",
      byteLength: bytes.byteLength,
      sha256: sha256(bytes),
    };
    exact(
      manifest.contentDigest,
      packageDigest([file]),
      `${item}.manifest.contentDigest`,
    );
    exact(
      digest(capture.payloadHash, `${item}.payloadHash`),
      contentHash(manifest),
      `${item}.payloadHash`,
    );
    const envelope = {
      schemaVersion: 1,
      ownerId: manifest.taskId,
      resourceId: manifest.captureWindowId,
      payload: manifest,
      payloadHash: capture.payloadHash,
    };
    validatePackageSeal(
      capture.packageSeal,
      {
        ownerId: manifest.taskId,
        resourceId: manifest.captureWindowId,
        operationId: null,
        recordHash: contentHash(envelope),
        files: [file],
      },
      `${item}.packageSeal`,
    );
    verifyOwnHash(capture, item);
    if (byId.has(manifest.captureWindowId))
      fail(`${label} contains duplicate capture IDs`);
    byId.set(manifest.captureWindowId, capture);
  });
  exact(
    [...byId.keys()],
    runtime.captureWindowIds,
    `${label} canonical runtime order`,
  );
};

const resourceDigest = (kind, ownerId, resourceId) =>
  sha256(`${kind}\0${ownerId}\0${resourceId}`);

const validateTaskInventory = (inventory, expected, label) => {
  exactKeys(
    inventory,
    [
      "schemaVersion",
      "taskId",
      "candidatePackages",
      "captureWindowPackages",
      "records",
      "ledgers",
      "inventoryHash",
      "recordHash",
    ],
    label,
  );
  schemaVersion(inventory.schemaVersion, label);
  exact(
    id(inventory.taskId, `${label}.taskId`),
    expected.taskId,
    `${label}.taskId`,
  );
  const validatePackages = (packages, kind, packageLabel) => {
    if (!Array.isArray(packages) || packages.length > 256)
      fail(`${packageLabel} is not bounded`);
    packages.forEach((entry, index) => {
      const item = `${packageLabel}[${index}]`;
      exactKeys(entry, ["resourceId", "resourceDigest"], item);
      id(entry.resourceId, `${item}.resourceId`);
      exact(
        digest(entry.resourceDigest, `${item}.resourceDigest`),
        resourceDigest(kind, inventory.taskId, entry.resourceId),
        `${item}.resourceDigest`,
      );
    });
    assertUnique(packages, (entry) => entry.resourceId, packageLabel);
  };
  validatePackages(
    inventory.candidatePackages,
    "chronorift-project-adapter-candidate-v1",
    `${label}.candidatePackages`,
  );
  validatePackages(
    inventory.captureWindowPackages,
    "chronorift-project-environment-pinned-capture-v1",
    `${label}.captureWindowPackages`,
  );
  exact(
    inventory.candidatePackages.length,
    expected.candidateCount,
    `${label}.candidatePackages length`,
  );
  exact(
    inventory.captureWindowPackages.map((entry) => entry.resourceId),
    expected.captureWindowIds,
    `${label}.captureWindowPackages IDs`,
  );
  if (!Array.isArray(inventory.records) || inventory.records.length > 256)
    fail(`${label}.records is not bounded`);
  const records = new Map();
  inventory.records.forEach((record, index) => {
    const item = `${label}.records[${index}]`;
    exactKeys(
      record,
      [
        "schemaVersion",
        "taskId",
        "recordKind",
        "resourceId",
        "resourceDigest",
        "payload",
        "payloadHash",
        "recordHash",
      ],
      item,
    );
    schemaVersion(record.schemaVersion, item);
    exact(record.taskId, inventory.taskId, `${item}.taskId`);
    if (
      ![
        "initialization-attempt",
        "publication-intent",
        "publication-receipt",
        "toolchain-receipt",
        "conformance-receipt",
        "observer-effect-receipt",
        "compatibility-receipt",
        "reuse-receipt",
        "runtime-observation-receipt",
        "build",
        "build-binding",
      ].includes(record.recordKind)
    )
      fail(`${item}.recordKind is unsupported`);
    id(record.resourceId, `${item}.resourceId`);
    exact(
      record.resourceDigest,
      resourceDigest(record.recordKind, inventory.taskId, record.resourceId),
      `${item}.resourceDigest`,
    );
    exact(
      record.payloadHash,
      contentHash(record.payload),
      `${item}.payloadHash`,
    );
    const basis = {
      schemaVersion: 1,
      taskId: record.taskId,
      recordKind: record.recordKind,
      resourceId: record.resourceId,
      resourceDigest: record.resourceDigest,
      payload: record.payload,
      payloadHash: record.payloadHash,
    };
    exact(record.recordHash, contentHash(basis), `${item}.recordHash`);
    const key = `${record.recordKind}\0${record.resourceId}`;
    if (records.has(key)) fail(`${label}.records contains duplicate ${key}`);
    records.set(key, record.payload);
  });
  if (!Array.isArray(inventory.ledgers) || inventory.ledgers.length !== 3)
    fail(`${label}.ledgers must contain all three ledgers`);
  const ledgerPayloads = new Map();
  inventory.ledgers.forEach((ledger, ledgerIndex) => {
    const item = `${label}.ledgers[${ledgerIndex}]`;
    exactKeys(ledger, ["kind", "canonicalBase64", "envelopes", "seal"], item);
    if (!["attempt-events", "binding-epochs", "turns"].includes(ledger.kind))
      fail(`${item}.kind is unsupported`);
    const bytes = decodeCanonicalBase64(
      ledger.canonicalBase64,
      `${item}.canonicalBase64`,
      16 * 1024 * 1024,
    );
    if (!Array.isArray(ledger.envelopes) || ledger.envelopes.length > 4096)
      fail(`${item}.envelopes is not bounded`);
    let previous = null;
    const lines = [];
    ledger.envelopes.forEach((envelope, sequence) => {
      const envelopeLabel = `${item}.envelopes[${sequence}]`;
      exactKeys(
        envelope,
        [
          "schemaVersion",
          "ownerId",
          "sequence",
          "previousRecordHash",
          "payload",
          "recordHash",
        ],
        envelopeLabel,
      );
      schemaVersion(envelope.schemaVersion, envelopeLabel);
      exact(envelope.ownerId, inventory.taskId, `${envelopeLabel}.ownerId`);
      exact(envelope.sequence, sequence, `${envelopeLabel}.sequence`);
      exact(
        envelope.previousRecordHash,
        previous,
        `${envelopeLabel}.previousRecordHash`,
      );
      const basis = {
        schemaVersion: 1,
        ownerId: inventory.taskId,
        sequence,
        previousRecordHash: previous,
        payload: envelope.payload,
      };
      exact(
        envelope.recordHash,
        contentHash(basis),
        `${envelopeLabel}.recordHash`,
      );
      previous = envelope.recordHash;
      lines.push(canonicalJson(envelope));
    });
    const expectedBytes = Buffer.from(
      lines.length === 0 ? "" : `${lines.join("\n")}\n`,
      "utf8",
    );
    if (!bytes.equals(expectedBytes))
      fail(`${item} raw bytes do not match canonical envelopes`);
    exactKeys(
      ledger.seal,
      [
        "schemaVersion",
        "ownerId",
        "recordCount",
        "finalRecordHash",
        "ledgerByteLength",
        "ledgerSha256",
      ],
      `${item}.seal`,
    );
    schemaVersion(ledger.seal.schemaVersion, `${item}.seal`);
    exact(ledger.seal.ownerId, inventory.taskId, `${item}.seal.ownerId`);
    exact(
      ledger.seal.recordCount,
      ledger.envelopes.length,
      `${item}.seal.recordCount`,
    );
    exact(
      ledger.seal.finalRecordHash,
      previous,
      `${item}.seal.finalRecordHash`,
    );
    exact(
      ledger.seal.ledgerByteLength,
      bytes.byteLength,
      `${item}.seal.ledgerByteLength`,
    );
    exact(ledger.seal.ledgerSha256, sha256(bytes), `${item}.seal.ledgerSha256`);
    ledgerPayloads.set(
      ledger.kind,
      ledger.envelopes.map((envelope) => envelope.payload),
    );
  });
  assertUnique(inventory.ledgers, (ledger) => ledger.kind, `${label}.ledgers`);
  const basis = {
    schemaVersion: 1,
    taskId: inventory.taskId,
    candidatePackages: inventory.candidatePackages,
    captureWindowPackages: inventory.captureWindowPackages,
    records: inventory.records,
    ledgers: inventory.ledgers,
  };
  exact(inventory.inventoryHash, contentHash(basis), `${label}.inventoryHash`);
  verifyOwnHash(inventory, label);
  return { records, ledgers: ledgerPayloads };
};

const validateInitializationAttempt = (
  attempt,
  publication,
  binding,
  turns,
  inventory,
  source,
) => {
  const label = "$evidence.initializationAttempt";
  exactKeys(
    attempt,
    [
      "schemaVersion",
      "attemptId",
      "predecessorAttemptId",
      "taskId",
      "sessionId",
      "sourceId",
      "providerId",
      "modelId",
      "thinkingLevel",
      "budget",
      "state",
      "candidateId",
      "candidateDigest",
      "publicationOperationId",
      "environmentRevisionId",
      "adapterRevisionId",
      "publicationReceiptId",
      "bindingEpochId",
      "terminalCode",
      "terminalMessage",
      "eventCount",
      "createdAt",
      "updatedAt",
      "sealedAt",
      "recordHash",
    ],
    label,
  );
  schemaVersion(attempt.schemaVersion, label);
  exact(attempt.attemptId, publication.attemptId, `${label}.attemptId`);
  exact(attempt.predecessorAttemptId, null, `${label}.predecessorAttemptId`);
  exact(attempt.taskId, publication.taskId, `${label}.taskId`);
  exact(attempt.sessionId, turns[0].sessionId, `${label}.sessionId`);
  exact(attempt.sourceId, source.sourceId, `${label}.sourceId`);
  stableId(attempt.providerId, `${label}.providerId`);
  stableId(attempt.modelId, `${label}.modelId`);
  stableId(attempt.thinkingLevel, `${label}.thinkingLevel`);
  validateTurnBudget(attempt.budget, `${label}.budget`);
  exact(attempt.budget, turns[0].budget, `${label}.budget`);
  exact(attempt.state, "succeeded", `${label}.state`);
  id(attempt.candidateId, `${label}.candidateId`);
  digest(attempt.candidateDigest, `${label}.candidateDigest`);
  exact(
    attempt.publicationOperationId,
    publication.operationId,
    `${label}.publicationOperationId`,
  );
  exact(
    attempt.environmentRevisionId,
    publication.targetEnvironmentRevisionId,
    `${label}.environmentRevisionId`,
  );
  exact(
    attempt.adapterRevisionId,
    binding.environment.adapterRevisionId,
    `${label}.adapterRevisionId`,
  );
  exact(
    attempt.publicationReceiptId,
    publication.receiptId,
    `${label}.publicationReceiptId`,
  );
  exact(
    attempt.bindingEpochId,
    binding.bindingEpochId,
    `${label}.bindingEpochId`,
  );
  exact(attempt.terminalCode, null, `${label}.terminalCode`);
  exact(attempt.terminalMessage, null, `${label}.terminalMessage`);
  const events = inventory.ledgers.get("attempt-events") ?? [];
  const expectedKinds = [
    "created",
    "agent_running",
    "candidate_frozen",
    "validating",
    "publishing",
    "publication_committed",
    "binding",
    "succeeded",
  ];
  exact(
    events.map((event) => event.eventKind),
    expectedKinds,
    `${label} event sequence`,
  );
  exact(attempt.eventCount, events.length, `${label}.eventCount`);
  events.forEach((event, index) => {
    exact(event.schemaVersion, 1, `${label}.events[${index}].schemaVersion`);
    exact(event.taskId, attempt.taskId, `${label}.events[${index}].taskId`);
    exact(
      event.attemptId,
      attempt.attemptId,
      `${label}.events[${index}].attemptId`,
    );
    exact(event.sequence, index, `${label}.events[${index}].sequence`);
    timestamp(event.occurredAt, `${label}.events[${index}].occurredAt`);
  });
  const created = events[0];
  exact(created.sessionId, attempt.sessionId, `${label} created Session`);
  exact(created.sourceId, attempt.sourceId, `${label} created source`);
  exact(created.providerId, attempt.providerId, `${label} created provider`);
  exact(created.modelId, attempt.modelId, `${label} created model`);
  exact(
    created.thinkingLevel,
    attempt.thinkingLevel,
    `${label} created thinking level`,
  );
  exact(created.budget, attempt.budget, `${label} created budget`);
  exact(
    events[2].candidate.candidateId,
    attempt.candidateId,
    `${label} candidate ID`,
  );
  exact(
    events[2].candidate.contentDigest,
    attempt.candidateDigest,
    `${label} candidate digest`,
  );
  exact(
    events[4].operationId,
    publication.operationId,
    `${label} publishing operation`,
  );
  exact(
    events[5].publicationReceiptId,
    publication.receiptId,
    `${label} publication receipt`,
  );
  exact(
    events[7].bindingEpochId,
    binding.bindingEpochId,
    `${label} succeeded binding`,
  );
  exact(attempt.createdAt, created.occurredAt, `${label}.createdAt`);
  exact(attempt.updatedAt, events.at(-1).occurredAt, `${label}.updatedAt`);
  exact(attempt.sealedAt, events.at(-1).occurredAt, `${label}.sealedAt`);
  verifyOwnHash(attempt, label);
};

const validateReuse = (reuse, context) => {
  const label = "$evidence.reuse";
  exactKeys(
    reuse,
    [
      "schemaVersion",
      "taskInventory",
      "toolchain",
      "receipt",
      "binding",
      "candidateBuild",
      "compatibility",
      "turns",
      "runtime",
      "pinnedCaptures",
      "goalDelivered",
      "recordHash",
    ],
    label,
  );
  schemaVersion(reuse.schemaVersion, label);
  validateToolchain(reuse.toolchain);
  exact(
    reuse.toolchain.receiptId,
    context.toolchain.receiptId,
    `${label}.toolchain.receiptId`,
  );
  const toolchainIdentity = (value) =>
    Object.fromEntries(
      Object.entries(value).filter(
        ([key]) => !["observedAt", "recordHash"].includes(key),
      ),
    );
  exact(
    toolchainIdentity(reuse.toolchain),
    toolchainIdentity(context.toolchain),
    `${label}.toolchain realized identity`,
  );
  const receipt = reuse.receipt;
  exactKeys(
    receipt,
    [
      "schemaVersion",
      "receiptId",
      "taskId",
      "sessionId",
      "sourceId",
      "buildId",
      "buildSourceId",
      "environmentRevisionId",
      "adapterRevisionId",
      "toolchainReceiptId",
      "sdkDigest",
      "bridgeDigest",
      "policyProfileDigest",
      "observedCurrentRevisionId",
      "compatibilityReceiptId",
      "schemaBindingValidated",
      "adapterPackageValidated",
      "quickSmokeCompatible",
      "cleanup",
      "outcome",
      "failures",
      "observedAt",
      "recordHash",
    ],
    `${label}.receipt`,
  );
  schemaVersion(receipt.schemaVersion, `${label}.receipt`);
  if (receipt.taskId === context.publication.taskId)
    fail(`${label}.receipt.taskId did not create a new Task`);
  if (receipt.sessionId === context.turns[0].sessionId)
    fail(`${label}.receipt.sessionId did not create a new Session`);
  exact(
    receipt.sourceId,
    context.environment.sourceId,
    `${label}.receipt.sourceId`,
  );
  exact(
    receipt.environmentRevisionId,
    context.environment.environmentRevisionId,
    `${label}.receipt.environmentRevisionId`,
  );
  exact(
    receipt.observedCurrentRevisionId,
    context.environment.environmentRevisionId,
    `${label}.receipt.observedCurrentRevisionId`,
  );
  exact(
    receipt.adapterRevisionId,
    context.adapter.adapterRevisionId,
    `${label}.receipt.adapterRevisionId`,
  );
  exact(
    receipt.toolchainReceiptId,
    context.environment.toolchainReceiptId,
    `${label}.receipt.toolchainReceiptId`,
  );
  exact(
    receipt.sdkDigest,
    context.environment.sdkDigest,
    `${label}.receipt.sdkDigest`,
  );
  exact(
    receipt.bridgeDigest,
    context.environment.bridgeDigest,
    `${label}.receipt.bridgeDigest`,
  );
  exact(
    receipt.policyProfileDigest,
    context.environment.policyProfileDigest,
    `${label}.receipt.policyProfileDigest`,
  );
  for (const key of [
    "schemaBindingValidated",
    "adapterPackageValidated",
    "quickSmokeCompatible",
  ])
    exact(receipt[key], true, `${label}.receipt.${key}`);
  validateCleanup(receipt.cleanup, `${label}.receipt.cleanup`);
  exact(receipt.outcome, "reused", `${label}.receipt.outcome`);
  exact(receipt.failures, [], `${label}.receipt.failures`);
  timestamp(receipt.observedAt, `${label}.receipt.observedAt`);
  const receiptBasis = Object.fromEntries(
    Object.entries(receipt).filter(
      ([key]) => key !== "receiptId" && key !== "recordHash",
    ),
  );
  exact(
    receipt.receiptId,
    `reuse:v1:${contentHash(receiptBasis)}`,
    `${label}.receipt.receiptId`,
  );
  verifyOwnHash(receipt, `${label}.receipt`);
  const binding = reuse.binding;
  exactKeys(
    binding,
    [
      "schemaVersion",
      "bindingEpochId",
      "taskId",
      "ordinal",
      "state",
      "sessionId",
      "environment",
      "reuseReceiptId",
      "compatibilityReceiptId",
      "createdAt",
      "boundAt",
      "recordHash",
    ],
    `${label}.binding`,
  );
  schemaVersion(binding.schemaVersion, `${label}.binding`);
  exact(binding.taskId, receipt.taskId, `${label}.binding.taskId`);
  exact(binding.ordinal, 0, `${label}.binding.ordinal`);
  exact(binding.state, "reused", `${label}.binding.state`);
  exact(binding.sessionId, receipt.sessionId, `${label}.binding.sessionId`);
  const expectedReference = Object.fromEntries(
    [
      "schemaVersion",
      "environmentId",
      "environmentRevisionId",
      "sourceId",
      "adapterRevisionId",
      "sdkDigest",
      "bridgeDigest",
      "toolchainReceiptId",
      "conformanceReceiptId",
      "observerEffectReceiptId",
      "policyProfileDigest",
      "contentDigest",
    ].map((key) => [key, context.environment[key]]),
  );
  exact(binding.environment, expectedReference, `${label}.binding.environment`);
  exact(
    binding.reuseReceiptId,
    receipt.receiptId,
    `${label}.binding.reuseReceiptId`,
  );
  timestamp(binding.createdAt, `${label}.binding.createdAt`);
  timestamp(binding.boundAt, `${label}.binding.boundAt`);
  verifyOwnHash(binding, `${label}.binding`);
  validateCompatibility(
    reuse.compatibility,
    context.adapter,
    context.environment,
    `${label}.compatibility`,
  );
  exact(
    binding.compatibilityReceiptId,
    reuse.compatibility.receiptId,
    `${label}.binding.compatibilityReceiptId`,
  );
  exact(
    receipt.compatibilityReceiptId,
    reuse.compatibility.receiptId,
    `${label}.receipt.compatibilityReceiptId`,
  );
  validateBuild(
    reuse.candidateBuild,
    context.source,
    context.adapter,
    context.environment,
    reuse.compatibility,
    { label: `${label}.candidateBuild`, requireChange: false },
  );
  exact(
    receipt.buildId,
    reuse.candidateBuild.buildId,
    `${label}.receipt.buildId`,
  );
  exact(
    receipt.buildSourceId,
    reuse.candidateBuild.sourceId,
    `${label}.receipt.buildSourceId`,
  );
  exact(
    reuse.candidateBuild.bindingEpochId,
    binding.bindingEpochId,
    `${label} Build binding epoch`,
  );
  if (!Array.isArray(reuse.turns) || reuse.turns.length !== 1)
    fail(`${label}.turns must contain one user-goal turn`);
  const turn = reuse.turns[0];
  exactKeys(
    turn,
    [
      "schemaVersion",
      "sequence",
      "turnId",
      "taskId",
      "sessionId",
      "purpose",
      "attemptId",
      "bindingEpochId",
      "promptDigest",
      "queuedGoalDigest",
      "budget",
      "usageStatus",
      "usage",
      "status",
      "terminalCode",
      "terminalMessage",
      "startedAt",
      "endedAt",
      "recordHash",
    ],
    `${label}.turns[0]`,
  );
  schemaVersion(turn.schemaVersion, `${label}.turns[0]`);
  exact(turn.sequence, 0, `${label}.turns[0].sequence`);
  exact(turn.taskId, receipt.taskId, `${label}.turns[0].taskId`);
  exact(turn.sessionId, receipt.sessionId, `${label}.turns[0].sessionId`);
  exact(turn.purpose, "user_goal", `${label}.turns[0].purpose`);
  exact(turn.attemptId, null, `${label}.turns[0].attemptId`);
  exact(
    turn.bindingEpochId,
    binding.bindingEpochId,
    `${label}.turns[0].bindingEpochId`,
  );
  exact(turn.queuedGoalDigest, null, `${label}.turns[0].queuedGoalDigest`);
  validateTurnBudget(turn.budget, `${label}.turns[0].budget`);
  validateTurnUsage(turn.usageStatus, turn.usage, `${label}.turns[0]`);
  exact(turn.status, "completed", `${label}.turns[0].status`);
  exact(turn.terminalCode, null, `${label}.turns[0].terminalCode`);
  exact(turn.terminalMessage, null, `${label}.turns[0].terminalMessage`);
  timestamp(turn.startedAt, `${label}.turns[0].startedAt`);
  timestamp(turn.endedAt, `${label}.turns[0].endedAt`);
  verifyOwnHash(turn, `${label}.turns[0]`);
  if (Date.parse(turn.startedAt) < Date.parse(binding.boundAt))
    fail(`${label} goal preceded reuse binding`);
  validateRuntime(
    reuse.runtime,
    reuse.candidateBuild,
    reuse.compatibility,
    `${label}.runtime`,
  );
  if (
    Date.parse(reuse.runtime.startedAt) < Date.parse(turn.startedAt) ||
    Date.parse(reuse.runtime.completedAt) > Date.parse(turn.endedAt)
  )
    fail(`${label} runtime is outside the new-Session goal turn`);
  validatePinnedCaptures(
    reuse.pinnedCaptures,
    reuse.runtime,
    context.adapterDocuments,
    `${label}.pinnedCaptures`,
  );
  const inventory = validateTaskInventory(
    reuse.taskInventory,
    {
      taskId: receipt.taskId,
      candidateCount: 0,
      captureWindowIds: reuse.runtime.captureWindowIds,
    },
    `${label}.taskInventory`,
  );
  exact(
    inventory.ledgers.get("attempt-events"),
    [],
    `${label} has no initialization attempt ledger`,
  );
  exact(
    inventory.ledgers.get("binding-epochs"),
    [
      Object.fromEntries(
        Object.entries(binding).filter(([key]) => key !== "recordHash"),
      ),
    ],
    `${label} binding raw ledger payload`,
  );
  exact(
    inventory.ledgers.get("turns"),
    [
      Object.fromEntries(
        Object.entries(turn).filter(
          ([key]) => key !== "sequence" && key !== "recordHash",
        ),
      ),
    ],
    `${label} turn raw ledger payload`,
  );
  if (
    [...inventory.records.keys()].some((key) =>
      /^(?:initialization-attempt|publication-intent|publication-receipt|conformance-receipt|observer-effect-receipt)\0/u.test(
        key,
      ),
    )
  )
    fail(`${label} inventory contains initialization/publication records`);
  const record = (kind, resourceId) =>
    inventory.records.get(`${kind}\0${resourceId}`);
  exact(
    record("toolchain-receipt", reuse.toolchain.receiptId),
    Object.fromEntries(
      Object.entries(reuse.toolchain).filter(([key]) => key !== "recordHash"),
    ),
    `${label} toolchain record body`,
  );
  exact(
    record("reuse-receipt", receipt.receiptId),
    Object.fromEntries(
      Object.entries(receipt).filter(([key]) => key !== "recordHash"),
    ),
    `${label} reuse record body`,
  );
  exact(
    record("compatibility-receipt", reuse.compatibility.receiptId),
    compatibilityProductBody(reuse.compatibility, context.adapter),
    `${label} compatibility record body`,
  );
  exact(
    record("runtime-observation-receipt", reuse.runtime.receiptId),
    Object.fromEntries(
      Object.entries(reuse.runtime).filter(([key]) => key !== "recordHash"),
    ),
    `${label} runtime record body`,
  );
  exact(
    [...inventory.records.keys()].filter((key) =>
      key.startsWith("runtime-observation-receipt\0"),
    ),
    [`runtime-observation-receipt\0${reuse.runtime.receiptId}`],
    `${label} complete runtime history`,
  );
  const compatibilityHistory = [...inventory.records.entries()]
    .filter(([key]) => key.startsWith("compatibility-receipt\0"))
    .map(([key, stored], index) => {
      const product = compatibilityProductFromStoredReceipt(
        stored,
        context.adapter,
        context.environment,
        `${label}.compatibilityHistory[${index}]`,
      );
      exact(
        key,
        `compatibility-receipt\0${product.receiptId}`,
        `${label}.compatibilityHistory[${index}] key`,
      );
      return product;
    });
  if (
    !compatibilityHistory.some(
      (entry) => entry.receiptId === reuse.compatibility.receiptId,
    )
  ) {
    fail(`${label} selected compatibility is absent from complete history`);
  }
  exact(
    bool(reuse.goalDelivered, `${label}.goalDelivered`),
    true,
    `${label}.goalDelivered`,
  );
  verifyOwnHash(reuse, label);
};

export async function validateProjectEnvironmentPeAEvidence(argv) {
  const [schemaPath, evidencePath, ...unexpected] = argv;
  if (
    schemaPath === undefined ||
    evidencePath === undefined ||
    unexpected.length !== 0
  ) {
    fail(
      "usage: validate-project-environment-pe-a-evidence.mjs SCHEMA EVIDENCE",
    );
  }
  const schema = await readPinnedJson(schemaPath, "schema", MAX_SCHEMA_BYTES);
  exact(sha256(schema.bytes), SCHEMA_RAW_SHA256, "schema raw SHA-256");
  const schemaObject = plainObject(schema.value, "schema");
  exact(schemaObject.$id, SCHEMA_ID, "schema identity");
  exact(schemaObject.additionalProperties, false, "schema strict root");

  const loaded = await readPinnedJson(
    evidencePath,
    "evidence",
    MAX_EVIDENCE_BYTES,
  );
  const evidence = plainObject(loaded.value, "$evidence");
  exactKeys(
    evidence,
    [
      "schemaVersion",
      "evidenceKind",
      "evidenceProfile",
      "source",
      "toolchain",
      "adapter",
      "environment",
      "publishedReceipts",
      "publication",
      "initializationAttempt",
      "taskInventory",
      "candidateBuild",
      "compatibility",
      "binding",
      "turns",
      "runtime",
      "pinnedCaptures",
      "reuse",
      "goalDelivered",
      "bundleContentHash",
    ],
    "$evidence",
  );
  schemaVersion(evidence.schemaVersion, "$evidence");
  exact(
    evidence.evidenceKind,
    "chronorift-project-environment-pe-a-evidence",
    "$evidence.evidenceKind",
  );
  exact(
    evidence.evidenceProfile,
    "author-validate-publish-use-reuse-v1",
    "$evidence.evidenceProfile",
  );
  validateSource(evidence.source);
  validateToolchain(evidence.toolchain);
  const adapterDocuments = validateAdapter(evidence.adapter, evidence.source);
  validateEnvironment(evidence.environment, evidence.source, evidence.adapter);
  exact(
    evidence.environment.toolchainReceiptId,
    evidence.toolchain.receiptId,
    "$evidence toolchain binding",
  );
  validatePublishedReceipts(
    evidence.publishedReceipts,
    evidence.environment,
    evidence.adapter,
  );
  validatePublication(evidence.publication, evidence.environment);
  validateCompatibility(
    evidence.compatibility,
    evidence.adapter,
    evidence.environment,
  );
  validateBuild(
    evidence.candidateBuild,
    evidence.source,
    evidence.adapter,
    evidence.environment,
    evidence.compatibility,
  );
  exact(
    evidence.compatibility.taskId,
    evidence.candidateBuild.taskId,
    "$evidence compatibility Task binding",
  );
  exact(
    evidence.compatibility.buildId,
    evidence.candidateBuild.buildId,
    "$evidence compatibility Build binding",
  );
  exact(
    evidence.compatibility.sourceId,
    evidence.candidateBuild.sourceId,
    "$evidence compatibility source binding",
  );
  validateBinding(
    evidence.binding,
    evidence.publication,
    evidence.environment,
    evidence.compatibility,
  );
  exact(
    evidence.binding.bindingEpochId,
    evidence.candidateBuild.bindingEpochId,
    "$evidence Build binding epoch",
  );
  const turns = validateTurns(
    evidence.turns,
    evidence.binding,
    evidence.publication,
  );
  const buildCreatedAt = timestamp(
    evidence.candidateBuild.createdAt,
    "$evidence.candidateBuild.createdAt",
  );
  const compatibilityObservedAt = timestamp(
    evidence.compatibility.observedAt,
    "$evidence.compatibility.observedAt",
  );
  if (
    buildCreatedAt < Date.parse(turns.goal.startedAt) ||
    compatibilityObservedAt < buildCreatedAt ||
    compatibilityObservedAt > Date.parse(turns.goal.endedAt)
  ) {
    fail("candidate Build compatibility is outside the user-goal turn");
  }
  validateRuntime(
    evidence.runtime,
    evidence.candidateBuild,
    evidence.compatibility,
  );
  validatePinnedCaptures(
    evidence.pinnedCaptures,
    evidence.runtime,
    adapterDocuments,
    "$evidence.pinnedCaptures",
  );
  if (
    Date.parse(evidence.runtime.completedAt) > Date.parse(turns.goal.endedAt)
  ) {
    fail("candidate game observation completed after the user-goal turn");
  }
  exact(
    bool(evidence.goalDelivered, "$evidence.goalDelivered"),
    true,
    "$evidence.goalDelivered",
  );
  const firstInventory = validateTaskInventory(
    evidence.taskInventory,
    {
      taskId: evidence.publication.taskId,
      candidateCount: 1,
      captureWindowIds: evidence.runtime.captureWindowIds,
    },
    "$evidence.taskInventory",
  );
  validateInitializationAttempt(
    evidence.initializationAttempt,
    evidence.publication,
    evidence.binding,
    evidence.turns,
    firstInventory,
    evidence.source,
  );
  const rawBinding = Object.fromEntries(
    Object.entries(evidence.binding).filter(
      ([key]) => key !== "compatibilityReceiptId" && key !== "recordHash",
    ),
  );
  const rawTurns = evidence.turns.map((turn) =>
    Object.fromEntries(
      Object.entries(turn).filter(
        ([key]) => key !== "sequence" && key !== "recordHash",
      ),
    ),
  );
  exact(
    firstInventory.ledgers.get("binding-epochs"),
    [rawBinding],
    "$evidence first binding raw ledger payload",
  );
  exact(
    firstInventory.ledgers.get("turns"),
    rawTurns,
    "$evidence first turns raw ledger payload",
  );
  const firstRecord = (kind, resourceId) =>
    firstInventory.records.get(`${kind}\0${resourceId}`);
  exact(
    firstRecord(
      "initialization-attempt",
      evidence.initializationAttempt.attemptId,
    ),
    Object.fromEntries(
      Object.entries(evidence.initializationAttempt).filter(
        ([key]) => key !== "recordHash",
      ),
    ),
    "$evidence initialization attempt record body",
  );
  exact(
    firstRecord("toolchain-receipt", evidence.toolchain.receiptId),
    Object.fromEntries(
      Object.entries(evidence.toolchain).filter(
        ([key]) => key !== "recordHash",
      ),
    ),
    "$evidence toolchain record body",
  );
  exact(
    firstRecord("publication-receipt", evidence.publication.receiptId),
    Object.fromEntries(
      Object.entries(evidence.publication).filter(
        ([key]) => key !== "recordHash",
      ),
    ),
    "$evidence publication record body",
  );
  exact(
    firstRecord("compatibility-receipt", evidence.compatibility.receiptId),
    compatibilityProductBody(evidence.compatibility, evidence.adapter),
    "$evidence compatibility record body",
  );
  exact(
    firstRecord("runtime-observation-receipt", evidence.runtime.receiptId),
    Object.fromEntries(
      Object.entries(evidence.runtime).filter(([key]) => key !== "recordHash"),
    ),
    "$evidence runtime record body",
  );
  exact(
    [...firstInventory.records.keys()].filter((key) =>
      key.startsWith("runtime-observation-receipt\0"),
    ),
    [`runtime-observation-receipt\0${evidence.runtime.receiptId}`],
    "$evidence complete runtime history",
  );
  const firstCompatibilityHistory = [...firstInventory.records.entries()]
    .filter(([key]) => key.startsWith("compatibility-receipt\0"))
    .map(([key, stored], index) => {
      const product = compatibilityProductFromStoredReceipt(
        stored,
        evidence.adapter,
        evidence.environment,
        `$evidence compatibility history[${index}]`,
      );
      exact(
        key,
        `compatibility-receipt\0${product.receiptId}`,
        `$evidence compatibility history[${index}] key`,
      );
      return product;
    });
  if (
    !firstCompatibilityHistory.some(
      (entry) => entry.receiptId === evidence.compatibility.receiptId,
    )
  ) {
    fail("$evidence selected compatibility is absent from complete history");
  }
  validateReuse(evidence.reuse, {
    source: evidence.source,
    adapter: evidence.adapter,
    adapterDocuments,
    environment: evidence.environment,
    publication: evidence.publication,
    turns: evidence.turns,
    toolchain: evidence.toolchain,
  });
  const bundleBasis = Object.fromEntries(
    Object.entries(evidence).filter(([key]) => key !== "bundleContentHash"),
  );
  exact(
    digest(evidence.bundleContentHash, "$evidence.bundleContentHash"),
    contentHash(bundleBasis),
    "$evidence canonical bundle hash",
  );

  return Object.freeze({
    schemaVersion: 1,
    bundleContentHash: evidence.bundleContentHash,
    environmentRevisionId: evidence.environment.environmentRevisionId,
    buildId: evidence.candidateBuild.buildId,
    compatibilityReceiptId: evidence.compatibility.receiptId,
    reuseTaskId: evidence.reuse.receipt.taskId,
    reuseSessionId: evidence.reuse.receipt.sessionId,
    reuseReceiptId: evidence.reuse.receipt.receiptId,
    reuseBuildId: evidence.reuse.candidateBuild.buildId,
    reuseCompatibilityReceiptId: evidence.reuse.compatibility.receiptId,
    reuseRuntimeObservationReceiptId: evidence.reuse.runtime.receiptId,
  });
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const result = await validateProjectEnvironmentPeAEvidence(
      process.argv.slice(2),
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "invalid PE-A evidence bundle"}\n`,
    );
    process.exitCode = 1;
  }
}
