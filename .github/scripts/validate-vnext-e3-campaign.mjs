#!/usr/bin/env node

import {
  createHash,
  createPublicKey,
  verify as verifySignature,
} from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [evidencePath, ...extraArguments] = process.argv.slice(2);

const fail = (message) => {
  throw new Error(`invalid vNext E3.1 campaign evidence: ${message}`);
};

if (evidencePath === undefined || extraArguments.length !== 0) {
  fail("expected exactly one E3_CAMPAIGN_EVIDENCE path");
}

const MAX_EVIDENCE_BYTES = 8 * 1024 * 1024;
const MAX_DEPTH = 40;
const MAX_VALUES = 100_000;
const ZERO_HASH = "0".repeat(64);
const DIGEST = /^[a-f0-9]{64}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const NAMESPACE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;
const SIGNATURE = /^[A-Za-z0-9_-]{86}$/u;
const FORBIDDEN_VOCABULARY =
  /(?:candidate|scenario|accepted|rejected|acceptance)/iu;
const ARTIFACT_SINK_MODE = "configured_external_ci_artifact_directory_v1";

// Release tooling replaces this fail-closed sentinel only when the independently
// published trust-root bytes have also been pinned outside CI. It is deliberately
// not configurable through argv or the environment.
const PINNED_EXTERNAL_TRUST_ROOT_SHA256 = null;
const TRUST_ROOT_RELATIVE_PATH =
  "testdata/vnext/e3/registrar-trust-root.v1.json";
const TRUST_ROOT_FREEZE_RELATIVE_PATH =
  "testdata/vnext/e3/registrar-trust-root.v1.freeze.json";
const TRUST_ROOT_FREEZE_SCHEMA = "chronorift.e3.registrar-trust-root-freeze";
const FAULT_CONTROL_POLICY_RELATIVE_PATH =
  "testdata/vnext/e3/registrar-fault-control-policy.v1.json";
const FAULT_CONTROL_POLICY_SCHEMA =
  "chronorift.e3.registrar-fault-control-policy";
const FAULT_CONTROL_POLICY_SIGNATURE_DOMAIN =
  "chronorift-e3-registrar-fault-control-policy-v1";
const FAULT_RECEIPT_SIGNATURE_DOMAIN =
  "chronorift-e3-conformance-fault-receipt-signature-v1";

const SCHEMA = {
  appendReceipt: "chronorift.e3.append-receipt",
  campaignEvidence: "chronorift.e3.campaign-conformance-evidence",
  campaignFaultReceipt: "chronorift.e3.campaign-conformance-fault-receipt",
  campaignSuiteEvidence: "chronorift.e3.campaign-conformance-suite-evidence",
  campaignSuiteSummary: "chronorift.e3.campaign-conformance-suite-summary",
  campaignManifest: "chronorift.e3.campaign-manifest",
  eventEnvelope: "chronorift.e3.event-envelope",
  journal: "chronorift.e3.journal",
  primaryClosure: "chronorift.e3.primary-closure",
  publicationProof: "chronorift.e3.publication-proof",
  registrationProof: "chronorift.e3.registration-proof",
  revisionEnvelope: "chronorift.e3.revision-envelope",
  revisionJournalCheckpoint: "chronorift.e3.revision-journal-checkpoint",
  sanitizedSummary: "chronorift.e3.sanitized-summary",
  trustRoot: "chronorift.e3.registrar-trust-root",
};

const EVENT_ACL = {
  registrar_assignment_registered: [
    "registrar",
    "chronorift.e3.payload.registrar-assignment-registered",
  ],
  conformance_actor_started: [
    "conformance_actor",
    "chronorift.e3.payload.conformance-actor-started",
  ],
  conformance_actor_finished: [
    "conformance_actor",
    "chronorift.e3.payload.conformance-actor-finished",
  ],
  conformance_cleanup_proven: [
    "cleanup_actor",
    "chronorift.e3.payload.conformance-cleanup-proven",
  ],
  registrar_deadline_elapsed: [
    "registrar",
    "chronorift.e3.payload.registrar-deadline-elapsed",
  ],
  registrar_primary_closed: [
    "registrar",
    "chronorift.e3.payload.registrar-primary-closed",
  ],
};

const object = (value, label) => {
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

const exactKeys = (value, keys, label) => {
  const actual = Object.keys(object(value, label)).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${label} contains a missing or unknown field`);
  }
};

const exact = (actual, expected, label) => {
  if (actual !== expected) fail(`${label} does not equal its required value`);
};

const stringPattern = (value, pattern, label) => {
  if (typeof value !== "string" || !pattern.test(value)) {
    fail(`${label} has an invalid value`);
  }
  return value;
};

const digest = (value, label) => stringPattern(value, DIGEST, label);
const identifier = (value, label) => stringPattern(value, IDENTIFIER, label);
const namespace = (value, label) => stringPattern(value, NAMESPACE, label);

const boundedInteger = (value, minimum, maximum, label) => {
  if (
    !Number.isSafeInteger(value) ||
    Object.is(value, -0) ||
    value < minimum ||
    value > maximum
  ) {
    fail(`${label} is outside its integer bounds`);
  }
  return value;
};

const boundedArray = (value, minimum, maximum, label) => {
  if (
    !Array.isArray(value) ||
    value.length < minimum ||
    value.length > maximum
  ) {
    fail(`${label} is outside its item bounds`);
  }
  return value;
};

const timestamp = (value, label) => {
  if (
    typeof value !== "string" ||
    value.length > 64 ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u.test(
      value,
    ) ||
    !Number.isFinite(Date.parse(value))
  ) {
    fail(`${label} is not a bounded ISO timestamp with an offset`);
  }
  return value;
};

const canonicalJson = (value) => {
  if (value === null || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
      fail("canonical JSON contains an unsafe number");
    }
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = object(value, "canonical JSON value");
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
};

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const contentHash = (value) =>
  sha256(Buffer.from(canonicalJson(value), "utf8"));

const assertNoDuplicateObjectKeys = (text, label) => {
  let index = 0;
  const whitespace = () => {
    while (/\s/u.test(text[index] ?? "")) index += 1;
  };
  const parseStringToken = () => {
    const start = index++;
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
        const key = parseStringToken();
        if (keys.has(key))
          fail(`${label} contains duplicate object key ${key}`);
        keys.add(key);
        whitespace();
        if (text[index++] !== ":")
          fail(`${label} has an invalid object separator`);
        parseValue();
        whitespace();
        if (text[index] === "}") {
          index += 1;
          return;
        }
        if (text[index++] !== ",")
          fail(`${label} has an invalid object delimiter`);
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
        if (text[index++] !== ",")
          fail(`${label} has an invalid array delimiter`);
      }
      fail(`${label} contains an unterminated array`);
    }
    if (character === '"') {
      parseStringToken();
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

const inspectJsonValue = (value, label, depth = 0, counter = { value: 0 }) => {
  counter.value += 1;
  if (counter.value > MAX_VALUES || depth > MAX_DEPTH) {
    fail(`${label} exceeds structural bounds`);
  }
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    boundedInteger(
      value,
      Number.MIN_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER,
      label,
    );
    return;
  }
  if (typeof value === "string") {
    if (
      Buffer.byteLength(value, "utf8") > 65_536 ||
      /[\uD800-\uDFFF]/u.test(value)
    ) {
      fail(`${label} contains an unsafe string`);
    }
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 10_000) fail(`${label} contains too many items`);
    value.forEach((entry, index) =>
      inspectJsonValue(entry, `${label}[${index}]`, depth + 1, counter),
    );
    return;
  }
  for (const [key, entry] of Object.entries(object(value, label))) {
    if (
      Buffer.byteLength(key, "utf8") > 256 ||
      /[\u0000\uD800-\uDFFF]/u.test(key)
    ) {
      fail(`${label} contains an unsafe object key`);
    }
    inspectJsonValue(entry, `${label}.${key}`, depth + 1, counter);
  }
};

const readStrictCanonicalJsonWithBytes = async (
  path,
  label = "evidence",
  maximumBytes = MAX_EVIDENCE_BYTES,
) => {
  const before = await lstat(path, { bigint: true }).catch((error) =>
    fail(`${label} cannot be inspected: ${String(error)}`),
  );
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) {
    fail(`${label} must be one unaliased regular file`);
  }
  if (before.size < 1n || before.size > BigInt(maximumBytes)) {
    fail(`${label} byte length is out of bounds`);
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat({ bigint: true });
    if (
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size
    ) {
      fail(`${label} changed before read`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size
    ) {
      fail(`${label} changed during read`);
    }
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error) {
      fail(`${label} is not UTF-8: ${String(error)}`);
    }
    assertNoDuplicateObjectKeys(text, label);
    let value;
    try {
      value = JSON.parse(text);
    } catch (error) {
      fail(`${label} is not JSON: ${String(error)}`);
    }
    inspectJsonValue(value, label);
    const expected = Buffer.from(`${canonicalJson(value)}\n`, "utf8");
    if (!Buffer.from(bytes).equals(expected)) {
      fail(`${label} is not canonical sorted JSON plus one LF`);
    }
    return { bytes: Buffer.from(bytes), value };
  } finally {
    await handle.close();
  }
};

const readStrictCanonicalJson = async (path) =>
  (await readStrictCanonicalJsonWithBytes(path)).value;

const pemPublicKey = (value, label) => {
  if (
    typeof value !== "string" ||
    value.length > 16 * 1024 ||
    !/^-----BEGIN PUBLIC KEY-----\n(?:[A-Za-z0-9+/=]+\n)+-----END PUBLIC KEY-----\n?$/u.test(
      value,
    )
  ) {
    fail(`${label} is not a bounded public-key PEM`);
  }
  try {
    const key = createPublicKey(value);
    if (key.asymmetricKeyType !== "ed25519") fail(`${label} is not Ed25519`);
    return key;
  } catch (error) {
    fail(`${label} cannot be decoded: ${String(error)}`);
  }
};

const keyDigest = (key) => sha256(key.export({ type: "spki", format: "der" }));

const decodeSignature = (value, label) => {
  stringPattern(value, SIGNATURE, label);
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length !== 64 || bytes.toString("base64url") !== value) {
    fail(`${label} is not canonical unpadded base64url`);
  }
  return bytes;
};

const signedBytes = (domain, schemaId, version, value) =>
  Buffer.concat([
    Buffer.from(`${domain}\0${schemaId}\0${String(version)}\0`, "utf8"),
    Buffer.from(canonicalJson(value), "utf8"),
  ]);

const verifySignedValue = ({
  domain,
  schemaId,
  value,
  signature,
  key,
  label,
}) => {
  const bytes = decodeSignature(signature, `${label}.signature`);
  if (
    !verifySignature(null, signedBytes(domain, schemaId, 1, value), key, bytes)
  ) {
    fail(`${label} has an invalid Ed25519 signature`);
  }
};

const validateRoleKey = (value, label) => {
  exactKeys(value, ["keyId", "publicKeyPem", "validFrom", "validUntil"], label);
  const key = pemPublicKey(value.publicKeyPem, `${label}.publicKeyPem`);
  exact(
    digest(value.keyId, `${label}.keyId`),
    keyDigest(key),
    `${label}.keyId`,
  );
  timestamp(value.validFrom, `${label}.validFrom`);
  timestamp(value.validUntil, `${label}.validUntil`);
  if (Date.parse(value.validFrom) >= Date.parse(value.validUntil)) {
    fail(`${label} validity interval is empty`);
  }
  return { ...value, key };
};

const assertKeyValidAt = (key, at, label) => {
  const instant = Date.parse(timestamp(at, label));
  if (
    instant < Date.parse(key.validFrom) ||
    instant >= Date.parse(key.validUntil)
  ) {
    fail(`${label} is outside the signing key validity interval`);
  }
};

const validateTrustRoot = (value) => {
  exactKeys(
    value,
    [
      "schemaId",
      "schemaVersion",
      "trustRootVersion",
      "validFrom",
      "validUntil",
      "signatureThreshold",
      "rootKeys",
      "services",
      "signatures",
    ],
    "trustRoot",
  );
  exact(value.schemaId, SCHEMA.trustRoot, "trustRoot.schemaId");
  exact(value.schemaVersion, 1, "trustRoot.schemaVersion");
  identifier(value.trustRootVersion, "trustRoot.trustRootVersion");
  timestamp(value.validFrom, "trustRoot.validFrom");
  timestamp(value.validUntil, "trustRoot.validUntil");
  if (Date.parse(value.validFrom) >= Date.parse(value.validUntil))
    fail("trustRoot validity interval is empty");
  const rootKeys = boundedArray(
    value.rootKeys,
    2,
    16,
    "trustRoot.rootKeys",
  ).map((entry, index) => {
    exactKeys(entry, ["keyId", "publicKeyPem"], `trustRoot.rootKeys[${index}]`);
    const key = pemPublicKey(
      entry.publicKeyPem,
      `trustRoot.rootKeys[${index}].publicKeyPem`,
    );
    exact(
      digest(entry.keyId, `trustRoot.rootKeys[${index}].keyId`),
      keyDigest(key),
      `trustRoot.rootKeys[${index}].keyId`,
    );
    return { ...entry, key };
  });
  if (new Set(rootKeys.map(({ keyId }) => keyId)).size !== rootKeys.length)
    fail("trustRoot root keys are not unique");
  const threshold = boundedInteger(
    value.signatureThreshold,
    2,
    rootKeys.length,
    "trustRoot.signatureThreshold",
  );
  const signatures = boundedArray(
    value.signatures,
    threshold,
    16,
    "trustRoot.signatures",
  );
  const rootBasis = { ...value, signatures: undefined };
  delete rootBasis.signatures;
  const seenSignatures = new Set();
  for (const [index, entry] of signatures.entries()) {
    const label = `trustRoot.signatures[${index}]`;
    exactKeys(entry, ["keyId", "signature"], label);
    digest(entry.keyId, `${label}.keyId`);
    if (seenSignatures.has(entry.keyId))
      fail("trustRoot signature keys are not unique");
    seenSignatures.add(entry.keyId);
    const rootKey = rootKeys.find(({ keyId }) => keyId === entry.keyId);
    if (rootKey === undefined) fail(`${label} references an unknown root key`);
    verifySignedValue({
      domain: "chronorift-e3-trust-root-v1",
      schemaId: SCHEMA.trustRoot,
      value: rootBasis,
      signature: entry.signature,
      key: rootKey.key,
      label,
    });
  }
  const services = boundedArray(
    value.services,
    1,
    16,
    "trustRoot.services",
  ).map((entry, index) => {
    const label = `trustRoot.services[${index}]`;
    exactKeys(
      entry,
      [
        "serviceId",
        "hostname",
        "port",
        "basePath",
        "caCertificatePem",
        "tlsSpkiSha256",
        "namespaces",
        "receiptKey",
        "clockKey",
        "closureKey",
        "logKey",
      ],
      label,
    );
    identifier(entry.serviceId, `${label}.serviceId`);
    stringPattern(
      entry.hostname,
      /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?))*$/u,
      `${label}.hostname`,
    );
    boundedInteger(entry.port, 1, 65_535, `${label}.port`);
    stringPattern(
      entry.basePath,
      /^\/(?!.*\/\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._~/-]{0,255}$/u,
      `${label}.basePath`,
    );
    if (
      typeof entry.caCertificatePem !== "string" ||
      entry.caCertificatePem.length < 1 ||
      entry.caCertificatePem.length > 65_536
    )
      fail(`${label}.caCertificatePem is outside bounds`);
    digest(entry.tlsSpkiSha256, `${label}.tlsSpkiSha256`);
    const namespaces = boundedArray(
      entry.namespaces,
      1,
      64,
      `${label}.namespaces`,
    ).map((item, itemIndex) =>
      namespace(item, `${label}.namespaces[${itemIndex}]`),
    );
    if (new Set(namespaces).size !== namespaces.length)
      fail(`${label}.namespaces are not unique`);
    const service = {
      ...entry,
      receiptKey: validateRoleKey(entry.receiptKey, `${label}.receiptKey`),
      clockKey: validateRoleKey(entry.clockKey, `${label}.clockKey`),
      closureKey: validateRoleKey(entry.closureKey, `${label}.closureKey`),
      logKey: validateRoleKey(entry.logKey, `${label}.logKey`),
    };
    const ids = [
      service.receiptKey.keyId,
      service.clockKey.keyId,
      service.closureKey.keyId,
      service.logKey.keyId,
    ];
    if (new Set(ids).size !== ids.length)
      fail(`${label} role keys are not distinct`);
    for (const [role, key] of [
      ["receiptKey", service.receiptKey],
      ["clockKey", service.clockKey],
      ["closureKey", service.closureKey],
      ["logKey", service.logKey],
    ]) {
      if (
        Date.parse(key.validFrom) < Date.parse(value.validFrom) ||
        Date.parse(key.validUntil) > Date.parse(value.validUntil)
      ) {
        fail(`${label}.${role} validity escapes the trust-root interval`);
      }
    }
    return service;
  });
  if (
    new Set(services.map(({ serviceId }) => serviceId)).size !== services.length
  )
    fail("trustRoot service IDs are not unique");
  const globallySeparatedKeyIds = [
    ...rootKeys.map(({ keyId }) => keyId),
    ...services.flatMap((service) => [
      service.receiptKey.keyId,
      service.clockKey.keyId,
      service.closureKey.keyId,
      service.logKey.keyId,
    ]),
  ];
  if (
    new Set(globallySeparatedKeyIds).size !== globallySeparatedKeyIds.length
  ) {
    fail(
      "threshold-root and online service role keys are not globally distinct",
    );
  }
  return { ...value, services };
};

const validateTrustRootFreeze = ({ value, trustRoot, trustRootFileHash }) => {
  exactKeys(
    value,
    [
      "schemaId",
      "schemaVersion",
      "trustRootVersion",
      "trustRootFileSha256",
      "externalChannelPinSha256",
      "signedAt",
      "predecessor",
      "signatures",
    ],
    "trustRootFreeze",
  );
  exact(value.schemaId, TRUST_ROOT_FREEZE_SCHEMA, "trustRootFreeze.schemaId");
  exact(value.schemaVersion, 1, "trustRootFreeze.schemaVersion");
  exact(
    value.trustRootVersion,
    trustRoot.trustRootVersion,
    "trustRootFreeze.trustRootVersion",
  );
  exact(
    digest(value.trustRootFileSha256, "trustRootFreeze.trustRootFileSha256"),
    trustRootFileHash,
    "trustRootFreeze.trustRootFileSha256",
  );
  exact(
    digest(
      value.externalChannelPinSha256,
      "trustRootFreeze.externalChannelPinSha256",
    ),
    trustRootFileHash,
    "trustRootFreeze.externalChannelPinSha256",
  );
  timestamp(value.signedAt, "trustRootFreeze.signedAt");
  if (
    Date.parse(value.signedAt) < Date.parse(trustRoot.validFrom) ||
    Date.parse(value.signedAt) >= Date.parse(trustRoot.validUntil)
  ) {
    fail(
      "trustRootFreeze.signedAt is outside the trust-root validity interval",
    );
  }
  exact(value.predecessor, null, "trustRootFreeze.predecessor");
  const rootKeys = new Map(
    trustRoot.rootKeys.map((entry, index) => [
      entry.keyId,
      pemPublicKey(
        entry.publicKeyPem,
        `trustRoot.rootKeys[${index}].publicKeyPem`,
      ),
    ]),
  );
  const signatures = boundedArray(
    value.signatures,
    trustRoot.signatureThreshold,
    16,
    "trustRootFreeze.signatures",
  );
  const seen = new Set();
  const basis = { ...value };
  delete basis.signatures;
  for (const [index, entry] of signatures.entries()) {
    const label = `trustRootFreeze.signatures[${index}]`;
    exactKeys(entry, ["keyId", "signature"], label);
    digest(entry.keyId, `${label}.keyId`);
    if (seen.has(entry.keyId)) {
      fail("trustRootFreeze signature keys are not unique");
    }
    seen.add(entry.keyId);
    const key = rootKeys.get(entry.keyId);
    if (key === undefined) fail(`${label} references an unknown root key`);
    verifySignedValue({
      domain: "chronorift-e3-trust-root-freeze-v1",
      schemaId: TRUST_ROOT_FREEZE_SCHEMA,
      value: basis,
      signature: entry.signature,
      key,
      label,
    });
  }
};

const validateFaultControlPolicy = ({ value, trustRoot }) => {
  exactKeys(
    value,
    [
      "schemaId",
      "schemaVersion",
      "trustRootVersion",
      "serviceId",
      "namespace",
      "faultControlId",
      "faultPlanId",
      "faultKey",
      "runnerSha256",
      "validatorSha256",
      "allowedFaultCases",
      "signatures",
    ],
    "faultControlPolicy",
  );
  exact(
    value.schemaId,
    FAULT_CONTROL_POLICY_SCHEMA,
    "faultControlPolicy.schemaId",
  );
  exact(value.schemaVersion, 1, "faultControlPolicy.schemaVersion");
  exact(
    value.trustRootVersion,
    trustRoot.trustRootVersion,
    "faultControlPolicy.trustRootVersion",
  );
  identifier(value.serviceId, "faultControlPolicy.serviceId");
  namespace(value.namespace, "faultControlPolicy.namespace");
  identifier(value.faultControlId, "faultControlPolicy.faultControlId");
  digest(value.faultPlanId, "faultControlPolicy.faultPlanId");
  digest(value.runnerSha256, "faultControlPolicy.runnerSha256");
  digest(value.validatorSha256, "faultControlPolicy.validatorSha256");
  const allowedFaultCases = boundedArray(
    value.allowedFaultCases,
    2,
    2,
    "faultControlPolicy.allowedFaultCases",
  );
  exact(
    canonicalJson(allowedFaultCases),
    canonicalJson(["registrar_unreachable", "transparency_log_unavailable"]),
    "faultControlPolicy.allowedFaultCases",
  );
  const faultKey = validateRoleKey(
    value.faultKey,
    "faultControlPolicy.faultKey",
  );
  if (
    Date.parse(faultKey.validFrom) < Date.parse(trustRoot.validFrom) ||
    Date.parse(faultKey.validUntil) > Date.parse(trustRoot.validUntil)
  ) {
    fail("faultControlPolicy.faultKey validity escapes the trust root");
  }
  const reservedKeyIds = [
    ...trustRoot.rootKeys.map(({ keyId }) => keyId),
    ...trustRoot.services.flatMap((service) => [
      service.receiptKey.keyId,
      service.clockKey.keyId,
      service.closureKey.keyId,
      service.logKey.keyId,
    ]),
  ];
  if (reservedKeyIds.includes(faultKey.keyId)) {
    fail("faultControlPolicy fault key aliases a trust-root or registrar key");
  }
  const signatures = boundedArray(
    value.signatures,
    trustRoot.signatureThreshold,
    16,
    "faultControlPolicy.signatures",
  );
  const rootKeys = new Map(
    trustRoot.rootKeys.map((entry, index) => [
      entry.keyId,
      pemPublicKey(
        entry.publicKeyPem,
        `trustRoot.rootKeys[${index}].publicKeyPem`,
      ),
    ]),
  );
  const seen = new Set();
  const basis = { ...value };
  delete basis.signatures;
  for (const [index, entry] of signatures.entries()) {
    const label = `faultControlPolicy.signatures[${index}]`;
    exactKeys(entry, ["keyId", "signature"], label);
    digest(entry.keyId, `${label}.keyId`);
    if (seen.has(entry.keyId)) {
      fail("faultControlPolicy signature keys are not unique");
    }
    seen.add(entry.keyId);
    const key = rootKeys.get(entry.keyId);
    if (key === undefined) fail(`${label} references an unknown root key`);
    verifySignedValue({
      domain: FAULT_CONTROL_POLICY_SIGNATURE_DOMAIN,
      schemaId: FAULT_CONTROL_POLICY_SCHEMA,
      value: basis,
      signature: entry.signature,
      key,
      label,
    });
  }
  return { value, faultKey };
};

const validateActorKeys = (value, manifest, trustRoot) => {
  const keys = boundedArray(value, 2, 2, "actorKeys").map((entry, index) => {
    const label = `actorKeys[${index}]`;
    exactKeys(
      entry,
      ["actorRole", "keyId", "publicKeyPem", "validFrom", "validUntil"],
      label,
    );
    if (
      entry.actorRole !== "conformance_actor" &&
      entry.actorRole !== "cleanup_actor"
    )
      fail(`${label}.actorRole is invalid`);
    const keyEntry = {
      keyId: entry.keyId,
      publicKeyPem: entry.publicKeyPem,
      validFrom: entry.validFrom,
      validUntil: entry.validUntil,
    };
    return {
      actorRole: entry.actorRole,
      ...validateRoleKey(keyEntry, label),
    };
  });
  const byRole = Object.fromEntries(
    keys.map((entry) => [entry.actorRole, entry]),
  );
  if (Object.keys(byRole).length !== 2)
    fail("actorKeys must contain one key for each actor role");
  const actorKeyIds = keys.map(({ keyId }) => keyId);
  const nonActorKeyIds = new Set([
    ...trustRoot.rootKeys.map(({ keyId }) => keyId),
    ...trustRoot.services.flatMap((service) => [
      service.receiptKey.keyId,
      service.clockKey.keyId,
      service.closureKey.keyId,
      service.logKey.keyId,
    ]),
  ]);
  if (
    new Set(actorKeyIds).size !== actorKeyIds.length ||
    actorKeyIds.some((keyId) => nonActorKeyIds.has(keyId))
  ) {
    fail(
      "actor keys must be distinct from each other, threshold-root keys, and registrar service role keys",
    );
  }
  exact(
    byRole.conformance_actor.keyId,
    manifest.assignments[0].conformanceActorKeyId,
    "conformance actor key binding",
  );
  exact(
    byRole.cleanup_actor.keyId,
    manifest.assignments[0].cleanupActorKeyId,
    "cleanup actor key binding",
  );
  return byRole;
};

const validateManifest = (value) => {
  exactKeys(
    value,
    [
      "schemaId",
      "schemaVersion",
      "campaignPurpose",
      "claimEligible",
      "modelCalls",
      "evaluatorRuns",
      "artifactSinkMode",
      "artifactSinkId",
      "artifactSinkCommitment",
      "namespace",
      "registrarServiceId",
      "trustRootVersion",
      "productSha256",
      "runnerSha256",
      "validatorSha256",
      "deadline",
      "assignmentCount",
      "assignments",
    ],
    "manifest",
  );
  exact(value.schemaId, SCHEMA.campaignManifest, "manifest.schemaId");
  exact(value.schemaVersion, 1, "manifest.schemaVersion");
  exact(
    value.campaignPurpose,
    "registrar_conformance",
    "manifest.campaignPurpose",
  );
  exact(value.claimEligible, false, "manifest.claimEligible");
  exact(value.modelCalls, 0, "manifest.modelCalls");
  exact(value.evaluatorRuns, 0, "manifest.evaluatorRuns");
  exact(
    value.artifactSinkMode,
    ARTIFACT_SINK_MODE,
    "manifest.artifactSinkMode",
  );
  identifier(value.artifactSinkId, "manifest.artifactSinkId");
  digest(value.artifactSinkCommitment, "manifest.artifactSinkCommitment");
  namespace(value.namespace, "manifest.namespace");
  identifier(value.registrarServiceId, "manifest.registrarServiceId");
  identifier(value.trustRootVersion, "manifest.trustRootVersion");
  for (const field of ["productSha256", "runnerSha256", "validatorSha256"])
    digest(value[field], `manifest.${field}`);
  timestamp(value.deadline, "manifest.deadline");
  exact(value.assignmentCount, 1, "manifest.assignmentCount");
  const [assignment] = boundedArray(
    value.assignments,
    1,
    1,
    "manifest.assignments",
  );
  exactKeys(
    assignment,
    [
      "assignmentCommitment",
      "cleanupActorKeyId",
      "conformanceActorKeyId",
      "slotOrdinal",
    ],
    "manifest.assignments[0]",
  );
  digest(
    assignment.assignmentCommitment,
    "manifest.assignments[0].assignmentCommitment",
  );
  digest(
    assignment.cleanupActorKeyId,
    "manifest.assignments[0].cleanupActorKeyId",
  );
  digest(
    assignment.conformanceActorKeyId,
    "manifest.assignments[0].conformanceActorKeyId",
  );
  exact(assignment.slotOrdinal, 0, "manifest.assignments[0].slotOrdinal");
  return value;
};

const domainHash = (domain, fields) => {
  const hash = createHash("sha256").update(domain).update("\0");
  for (const field of fields) hash.update(field).update("\0");
  return hash.digest("hex");
};

const campaignIdFor = (manifest) =>
  sha256(
    Buffer.concat([
      Buffer.from("chronorift-e3-campaign-id-v1\0", "utf8"),
      Buffer.from(canonicalJson(manifest), "utf8"),
    ]),
  );

const assignmentIdFor = (campaignId, assignment) =>
  domainHash("chronorift-e3-assignment-id-v1", [
    campaignId,
    String(assignment.slotOrdinal),
    assignment.assignmentCommitment,
  ]);
const eventIdFor = (event) =>
  domainHash("chronorift-e3-event-id-v1", [
    event.campaignId,
    event.assignmentId,
    String(event.ordinal),
    event.previousHash ?? "",
    event.eventKind,
    event.payloadHash,
  ]);
const revisionIdFor = (revision) =>
  domainHash("chronorift-e3-revision-id-v1", [
    revision.campaignId,
    revision.primaryClosureHash,
    String(revision.revisionOrdinal),
    revision.previousRevisionHash ?? "",
    revision.lateEntry.event.eventId,
  ]);

const validatePayload = (kind, value, label) => {
  if (kind === "registrar_assignment_registered") {
    exactKeys(
      value,
      ["assignmentId", "assignmentCommitment", "slotOrdinal", "registeredAt"],
      label,
    );
    digest(value.assignmentId, `${label}.assignmentId`);
    digest(value.assignmentCommitment, `${label}.assignmentCommitment`);
    exact(value.slotOrdinal, 0, `${label}.slotOrdinal`);
    timestamp(value.registeredAt, `${label}.registeredAt`);
  } else if (kind === "conformance_actor_started") {
    exactKeys(value, ["leaseId", "startedAt"], label);
    identifier(value.leaseId, `${label}.leaseId`);
    timestamp(value.startedAt, `${label}.startedAt`);
  } else if (kind === "conformance_actor_finished") {
    exactKeys(value, ["leaseId", "finishedAt"], label);
    identifier(value.leaseId, `${label}.leaseId`);
    timestamp(value.finishedAt, `${label}.finishedAt`);
  } else if (kind === "conformance_cleanup_proven") {
    exactKeys(
      value,
      [
        "leaseId",
        "observedAt",
        "processesEmpty",
        "cgroupEmpty",
        "storageEmpty",
        "networkLeaseClosed",
        "credentialLeaseRevoked",
        "observationCoverage",
      ],
      label,
    );
    identifier(value.leaseId, `${label}.leaseId`);
    timestamp(value.observedAt, `${label}.observedAt`);
    for (const field of [
      "processesEmpty",
      "cgroupEmpty",
      "storageEmpty",
      "networkLeaseClosed",
      "credentialLeaseRevoked",
    ])
      exact(value[field], true, `${label}.${field}`);
    exact(
      value.observationCoverage,
      "complete",
      `${label}.observationCoverage`,
    );
  } else if (kind === "registrar_deadline_elapsed") {
    exactKeys(value, ["deadline", "observedAt"], label);
    timestamp(value.deadline, `${label}.deadline`);
    timestamp(value.observedAt, `${label}.observedAt`);
    if (Date.parse(value.observedAt) < Date.parse(value.deadline))
      fail(`${label}.observedAt precedes deadline`);
  } else if (kind === "registrar_primary_closed") {
    exactKeys(value, ["preClosureHead", "closedAt", "primaryOutcome"], label);
    digest(value.preClosureHead, `${label}.preClosureHead`);
    timestamp(value.closedAt, `${label}.closedAt`);
    if (
      ![
        "conformance_complete",
        "incomplete_unknown",
        "cleanup_unproven",
      ].includes(value.primaryOutcome)
    )
      fail(`${label}.primaryOutcome is invalid`);
  } else {
    fail(`${label} has an unsupported event kind`);
  }
};

const payloadTimestamp = (kind, payload) =>
  ({
    registrar_assignment_registered: payload.registeredAt,
    conformance_actor_started: payload.startedAt,
    conformance_actor_finished: payload.finishedAt,
    conformance_cleanup_proven: payload.observedAt,
    registrar_deadline_elapsed: payload.observedAt,
    registrar_primary_closed: payload.closedAt,
  })[kind];

const eventSignatureBasis = (event) => {
  const basis = { ...event };
  delete basis.signature;
  return basis;
};

const receiptSignatureBasis = (receipt) => {
  const basis = { ...receipt };
  delete basis.signature;
  return basis;
};

const validateReceipt = (value, label) => {
  exactKeys(
    value,
    [
      "schemaId",
      "schemaVersion",
      "campaignId",
      "assignmentId",
      "eventId",
      "eventHash",
      "journalHead",
      "ordinal",
      "commitSequence",
      "committedAt",
      "registrarServiceId",
      "receiptKeyId",
      "signature",
    ],
    label,
  );
  exact(value.schemaId, SCHEMA.appendReceipt, `${label}.schemaId`);
  exact(value.schemaVersion, 1, `${label}.schemaVersion`);
  for (const field of [
    "campaignId",
    "assignmentId",
    "eventId",
    "eventHash",
    "journalHead",
    "receiptKeyId",
  ])
    digest(value[field], `${label}.${field}`);
  boundedInteger(value.ordinal, 1, 64, `${label}.ordinal`);
  boundedInteger(
    value.commitSequence,
    1,
    Number.MAX_SAFE_INTEGER,
    `${label}.commitSequence`,
  );
  timestamp(value.committedAt, `${label}.committedAt`);
  identifier(value.registrarServiceId, `${label}.registrarServiceId`);
  decodeSignature(value.signature, `${label}.signature`);
};

const validateJournal = ({
  journal,
  appendReceipts,
  campaignId,
  assignmentId,
  manifest,
  service,
  actorKeys,
}) => {
  exactKeys(
    journal,
    [
      "schemaId",
      "schemaVersion",
      "campaignId",
      "assignmentId",
      "events",
      "eventCount",
      "journalHead",
    ],
    "journal",
  );
  exact(journal.schemaId, SCHEMA.journal, "journal.schemaId");
  exact(journal.schemaVersion, 1, "journal.schemaVersion");
  exact(journal.campaignId, campaignId, "journal.campaignId");
  exact(journal.assignmentId, assignmentId, "journal.assignmentId");
  const entries = boundedArray(journal.events, 1, 64, "journal.events");
  exact(journal.eventCount, entries.length, "journal.eventCount");
  const receipts = boundedArray(
    appendReceipts,
    entries.length,
    entries.length,
    "appendReceipts",
  );
  let previousHash = null;
  let previousCommitSequence = 0;
  let previousCommittedAt = -Infinity;
  const kinds = [];
  let leaseId;
  let firstActorCommittedAt = null;
  let cleanupIndex;
  let deadlineObservedAt;
  let closureCommittedAt;
  const deadlineMs = Date.parse(manifest.deadline);
  for (const [index, entry] of entries.entries()) {
    const label = `journal.events[${index}]`;
    exactKeys(entry, ["event", "payload"], label);
    const event = object(entry.event, `${label}.event`);
    exactKeys(
      event,
      [
        "schemaId",
        "schemaVersion",
        "campaignId",
        "assignmentId",
        "eventId",
        "ordinal",
        "previousHash",
        "actorRole",
        "actorKeyId",
        "eventKind",
        "payloadSchemaId",
        "payloadHash",
        "signature",
      ],
      `${label}.event`,
    );
    exact(event.schemaId, SCHEMA.eventEnvelope, `${label}.event.schemaId`);
    exact(event.schemaVersion, 1, `${label}.event.schemaVersion`);
    exact(event.campaignId, campaignId, `${label}.event.campaignId`);
    exact(event.assignmentId, assignmentId, `${label}.event.assignmentId`);
    exact(event.ordinal, index + 1, `${label}.event.ordinal`);
    exact(event.previousHash, previousHash, `${label}.event.previousHash`);
    const acl = EVENT_ACL[event.eventKind];
    if (acl === undefined) fail(`${label}.event.eventKind is unsupported`);
    exact(event.actorRole, acl[0], `${label}.event.actorRole`);
    exact(event.payloadSchemaId, acl[1], `${label}.event.payloadSchemaId`);
    digest(event.actorKeyId, `${label}.event.actorKeyId`);
    validatePayload(event.eventKind, entry.payload, `${label}.payload`);
    exact(
      digest(event.payloadHash, `${label}.event.payloadHash`),
      contentHash(entry.payload),
      `${label}.event.payloadHash`,
    );
    exact(
      digest(event.eventId, `${label}.event.eventId`),
      eventIdFor(event),
      `${label}.event.eventId`,
    );
    let signingKey;
    if (event.actorRole === "registrar") {
      exact(
        event.actorKeyId,
        service.receiptKey.keyId,
        `${label}.event.actorKeyId`,
      );
      signingKey = service.receiptKey;
    } else {
      signingKey = actorKeys[event.actorRole];
      exact(event.actorKeyId, signingKey.keyId, `${label}.event.actorKeyId`);
    }
    const receipt = object(receipts[index], `appendReceipts[${index}]`);
    validateReceipt(receipt, `appendReceipts[${index}]`);
    if (
      Date.parse(receipt.committedAt) <
      Date.parse(payloadTimestamp(event.eventKind, entry.payload))
    ) {
      fail(`appendReceipts[${index}].committedAt precedes its event time`);
    }
    assertKeyValidAt(
      signingKey,
      receipt.committedAt,
      `${label}.event signing time`,
    );
    verifySignedValue({
      domain: "chronorift-e3-event-v1",
      schemaId: SCHEMA.eventEnvelope,
      value: eventSignatureBasis(event),
      signature: event.signature,
      key: signingKey.key,
      label: `${label}.event`,
    });
    const eventHash = contentHash(event);
    exact(
      receipt.campaignId,
      campaignId,
      `appendReceipts[${index}].campaignId`,
    );
    exact(
      receipt.assignmentId,
      assignmentId,
      `appendReceipts[${index}].assignmentId`,
    );
    exact(receipt.eventId, event.eventId, `appendReceipts[${index}].eventId`);
    exact(receipt.eventHash, eventHash, `appendReceipts[${index}].eventHash`);
    exact(
      receipt.journalHead,
      eventHash,
      `appendReceipts[${index}].journalHead`,
    );
    exact(receipt.ordinal, event.ordinal, `appendReceipts[${index}].ordinal`);
    if (receipt.commitSequence <= previousCommitSequence)
      fail("append receipt commitSequence is not increasing");
    if (Date.parse(receipt.committedAt) < previousCommittedAt)
      fail("append receipt committedAt is not monotonic");
    exact(
      receipt.registrarServiceId,
      service.serviceId,
      `appendReceipts[${index}].registrarServiceId`,
    );
    exact(
      receipt.receiptKeyId,
      service.receiptKey.keyId,
      `appendReceipts[${index}].receiptKeyId`,
    );
    assertKeyValidAt(
      service.receiptKey,
      receipt.committedAt,
      `appendReceipts[${index}].committedAt`,
    );
    verifySignedValue({
      domain: "chronorift-e3-append-receipt-v1",
      schemaId: SCHEMA.appendReceipt,
      value: receiptSignatureBasis(receipt),
      signature: receipt.signature,
      key: service.receiptKey.key,
      label: `appendReceipts[${index}]`,
    });
    const committedAt = Date.parse(receipt.committedAt);
    switch (event.eventKind) {
      case "registrar_assignment_registered":
      case "conformance_actor_started":
      case "conformance_actor_finished":
      case "conformance_cleanup_proven": {
        if (committedAt >= deadlineMs) {
          fail(
            `${event.eventKind} was not committed strictly before the campaign deadline`,
          );
        }
        if (firstActorCommittedAt === null && event.actorRole !== "registrar") {
          firstActorCommittedAt = receipt.committedAt;
        }
        if (event.eventKind === "conformance_cleanup_proven") {
          cleanupIndex = index;
        }
        break;
      }
      case "registrar_deadline_elapsed": {
        if (committedAt < deadlineMs) {
          fail("deadline event was committed before the campaign deadline");
        }
        deadlineObservedAt = entry.payload.observedAt;
        if (Date.parse(deadlineObservedAt) < deadlineMs) {
          fail("deadline event observedAt precedes the campaign deadline");
        }
        break;
      }
      case "registrar_primary_closed": {
        if (receipt.committedAt !== entry.payload.closedAt) {
          fail(
            "closure event payload and closure receipt must share the exact closedAt",
          );
        }
        closureCommittedAt = receipt.committedAt;
        break;
      }
    }
    if (event.eventKind === "registrar_assignment_registered") {
      exact(
        entry.payload.assignmentId,
        assignmentId,
        `${label}.payload.assignmentId`,
      );
      exact(
        entry.payload.assignmentCommitment,
        manifest.assignments[0].assignmentCommitment,
        `${label}.payload.assignmentCommitment`,
      );
    }
    if (event.eventKind === "conformance_actor_started")
      leaseId = entry.payload.leaseId;
    if (
      event.eventKind === "conformance_actor_finished" ||
      event.eventKind === "conformance_cleanup_proven"
    )
      exact(entry.payload.leaseId, leaseId, `${label}.payload.leaseId`);
    kinds.push(event.eventKind);
    previousHash = eventHash;
    previousCommitSequence = receipt.commitSequence;
    previousCommittedAt = Date.parse(receipt.committedAt);
  }
  exact(journal.journalHead, previousHash, "journal.journalHead");
  const uniqueKinds = new Set(kinds);
  if (uniqueKinds.size !== kinds.length)
    fail("journal contains a repeated event kind");
  exact(
    kinds[0],
    "registrar_assignment_registered",
    "first journal event kind",
  );
  exact(kinds.at(-1), "registrar_primary_closed", "last journal event kind");
  const position = (kind) => kinds.indexOf(kind);
  if (
    position("conformance_actor_finished") >= 0 &&
    !(
      position("conformance_actor_started") <
      position("conformance_actor_finished")
    )
  )
    fail("finished event lacks an earlier started event");
  if (
    position("conformance_cleanup_proven") >= 0 &&
    !(
      position("conformance_actor_finished") <
      position("conformance_cleanup_proven")
    )
  )
    fail("cleanup event lacks an earlier finished event");
  if (
    position("registrar_deadline_elapsed") >= 0 &&
    position("registrar_deadline_elapsed") !== kinds.length - 2
  )
    fail("deadline event must immediately precede closure");
  if (
    cleanupIndex !== undefined &&
    kinds[cleanupIndex + 1] !== "registrar_primary_closed"
  ) {
    fail("cleanup must be followed immediately by primary closure");
  }
  const closingEntry = entries.at(-1);
  const preClosureHead =
    entries.length === 1 ? ZERO_HASH : receipts.at(-2).eventHash;
  exact(
    closingEntry.payload.preClosureHead,
    preClosureHead,
    "closure event preClosureHead",
  );
  const hasFinished = uniqueKinds.has("conformance_actor_finished");
  const hasCleanup = uniqueKinds.has("conformance_cleanup_proven");
  const hasDeadline = uniqueKinds.has("registrar_deadline_elapsed");
  let outcome;
  if (hasFinished && hasCleanup) outcome = "conformance_complete";
  else if (hasDeadline && hasFinished) outcome = "cleanup_unproven";
  else if (hasDeadline) outcome = "incomplete_unknown";
  else fail("non-complete journal closed before its deadline event");
  exact(
    closingEntry.payload.primaryOutcome,
    outcome,
    "projected primary outcome",
  );
  if (hasDeadline) {
    const deadlineEntry = entries[position("registrar_deadline_elapsed")];
    exact(
      deadlineEntry.payload.deadline,
      manifest.deadline,
      "deadline event manifest binding",
    );
    if (
      deadlineObservedAt === undefined ||
      Date.parse(deadlineObservedAt) > Date.parse(closingEntry.payload.closedAt)
    ) {
      fail("deadline observation cannot occur after primary closure");
    }
  }
  if (closureCommittedAt === undefined) {
    fail("receipt-backed primary journal has no closure commit");
  }
  return {
    outcome,
    closingEntry,
    eventCount: entries.length,
    firstActorCommittedAt,
    closureCommittedAt,
  };
};

const revisionSignatureBasis = (revision) => {
  const basis = { ...revision };
  delete basis.signature;
  return basis;
};

const validateRevisions = ({
  revisions: rawRevisions,
  receipts: rawReceipts,
  campaignId,
  assignmentId,
  journal,
  closure,
  primaryReceipts,
  service,
  actorKeys,
}) => {
  const revisions = boundedArray(rawRevisions, 0, 64, "revisions");
  const receipts = boundedArray(
    rawReceipts,
    revisions.length,
    revisions.length,
    "revisionReceipts",
  );
  let previousRevisionHash = closure.closureHash;
  let previousCommitSequence = primaryReceipts.at(-1).commitSequence;
  let previousCommittedAt = Date.parse(primaryReceipts.at(-1).committedAt);
  let previousCommittedAtText = primaryReceipts.at(-1).committedAt;
  let startedLease;
  let finished = false;
  let cleanup = false;
  const eventHashesByOrdinal = new Map();
  for (const entry of journal.events) {
    const eventHash = contentHash(entry.event);
    const hashes = eventHashesByOrdinal.get(entry.event.ordinal);
    if (hashes === undefined) {
      eventHashesByOrdinal.set(entry.event.ordinal, new Set([eventHash]));
    } else {
      hashes.add(eventHash);
    }
    if (entry.event.eventKind === "conformance_actor_started") {
      startedLease = entry.payload.leaseId;
    } else if (entry.event.eventKind === "conformance_actor_finished") {
      finished = true;
    } else if (entry.event.eventKind === "conformance_cleanup_proven") {
      cleanup = true;
    }
  }
  const allowedKinds = new Set([
    "conformance_actor_started",
    "conformance_actor_finished",
    "conformance_cleanup_proven",
  ]);
  for (const [index, revision] of revisions.entries()) {
    const label = `revisions[${index}]`;
    exactKeys(
      revision,
      [
        "schemaId",
        "schemaVersion",
        "campaignId",
        "primaryClosureHash",
        "revisionId",
        "revisionOrdinal",
        "previousRevisionHash",
        "lateEntry",
        "receivedAt",
        "registrarKeyId",
        "signature",
      ],
      label,
    );
    exact(revision.schemaId, SCHEMA.revisionEnvelope, `${label}.schemaId`);
    exact(revision.schemaVersion, 1, `${label}.schemaVersion`);
    exact(revision.campaignId, campaignId, `${label}.campaignId`);
    exact(
      revision.primaryClosureHash,
      closure.closureHash,
      `${label}.primaryClosureHash`,
    );
    exact(revision.revisionOrdinal, index + 1, `${label}.revisionOrdinal`);
    exact(
      revision.previousRevisionHash,
      previousRevisionHash,
      `${label}.previousRevisionHash`,
    );
    timestamp(revision.receivedAt, `${label}.receivedAt`);
    exact(
      revision.registrarKeyId,
      service.receiptKey.keyId,
      `${label}.registrarKeyId`,
    );
    const entry = object(revision.lateEntry, `${label}.lateEntry`);
    exactKeys(entry, ["event", "payload"], `${label}.lateEntry`);
    const event = object(entry.event, `${label}.lateEntry.event`);
    exactKeys(
      event,
      [
        "schemaId",
        "schemaVersion",
        "campaignId",
        "assignmentId",
        "eventId",
        "ordinal",
        "previousHash",
        "actorRole",
        "actorKeyId",
        "eventKind",
        "payloadSchemaId",
        "payloadHash",
        "signature",
      ],
      `${label}.lateEntry.event`,
    );
    exact(
      event.schemaId,
      SCHEMA.eventEnvelope,
      `${label}.lateEntry.event.schemaId`,
    );
    exact(event.schemaVersion, 1, `${label}.lateEntry.event.schemaVersion`);
    exact(event.campaignId, campaignId, `${label}.lateEntry.event.campaignId`);
    exact(
      event.assignmentId,
      assignmentId,
      `${label}.lateEntry.event.assignmentId`,
    );
    boundedInteger(
      event.ordinal,
      1,
      Number.MAX_SAFE_INTEGER,
      `${label}.lateEntry.event.ordinal`,
    );
    if (event.previousHash === null) {
      fail(`${label}.lateEntry.event.previousHash cannot be null`);
    }
    digest(event.previousHash, `${label}.lateEntry.event.previousHash`);
    const predecessorHashes = eventHashesByOrdinal.get(event.ordinal - 1);
    if (
      predecessorHashes === undefined ||
      !predecessorHashes.has(event.previousHash)
    ) {
      fail(
        `${label}.lateEntry.event.previousHash does not bind an ordinal-${String(event.ordinal - 1)} primary or earlier revision event`,
      );
    }
    if (!allowedKinds.has(event.eventKind)) {
      fail(`${label}.lateEntry.event.eventKind is not permitted after closure`);
    }
    const acl = EVENT_ACL[event.eventKind];
    exact(event.actorRole, acl[0], `${label}.lateEntry.event.actorRole`);
    exact(
      event.payloadSchemaId,
      acl[1],
      `${label}.lateEntry.event.payloadSchemaId`,
    );
    const actorKey = actorKeys[event.actorRole];
    exact(
      event.actorKeyId,
      actorKey.keyId,
      `${label}.lateEntry.event.actorKeyId`,
    );
    validatePayload(
      event.eventKind,
      entry.payload,
      `${label}.lateEntry.payload`,
    );
    if (
      Date.parse(revision.receivedAt) <
      Date.parse(payloadTimestamp(event.eventKind, entry.payload))
    ) {
      fail(`${label}.receivedAt precedes the original late event time`);
    }
    exact(
      event.payloadHash,
      contentHash(entry.payload),
      `${label}.lateEntry.event.payloadHash`,
    );
    exact(event.eventId, eventIdFor(event), `${label}.lateEntry.event.eventId`);
    assertKeyValidAt(
      actorKey,
      revision.receivedAt,
      `${label}.lateEntry.event signing time`,
    );
    verifySignedValue({
      domain: "chronorift-e3-event-v1",
      schemaId: SCHEMA.eventEnvelope,
      value: eventSignatureBasis(event),
      signature: event.signature,
      key: actorKey.key,
      label: `${label}.lateEntry.event`,
    });
    if (event.eventKind === "conformance_actor_started") {
      if (startedLease !== undefined) {
        fail(`${label}.lateEntry contains a duplicate conformance start`);
      }
      startedLease = entry.payload.leaseId;
    } else if (event.eventKind === "conformance_actor_finished") {
      if (
        startedLease === undefined ||
        finished ||
        entry.payload.leaseId !== startedLease
      ) {
        fail(`${label}.lateEntry contains an unbound conformance finish`);
      }
      finished = true;
    } else {
      if (
        startedLease === undefined ||
        !finished ||
        cleanup ||
        entry.payload.leaseId !== startedLease
      ) {
        fail(`${label}.lateEntry contains unbound or duplicate cleanup proof`);
      }
      cleanup = true;
    }
    exact(
      digest(revision.revisionId, `${label}.revisionId`),
      revisionIdFor(revision),
      `${label}.revisionId`,
    );
    assertKeyValidAt(
      service.receiptKey,
      revision.receivedAt,
      `${label}.receivedAt`,
    );
    verifySignedValue({
      domain: "chronorift-e3-revision-envelope-v1",
      schemaId: SCHEMA.revisionEnvelope,
      value: revisionSignatureBasis(revision),
      signature: revision.signature,
      key: service.receiptKey.key,
      label,
    });
    const revisionHash = contentHash(revision);
    const receipt = object(receipts[index], `revisionReceipts[${index}]`);
    validateReceipt(receipt, `revisionReceipts[${index}]`);
    exact(
      receipt.campaignId,
      campaignId,
      `revisionReceipts[${index}].campaignId`,
    );
    exact(
      receipt.assignmentId,
      assignmentId,
      `revisionReceipts[${index}].assignmentId`,
    );
    exact(
      receipt.eventId,
      revision.revisionId,
      `revisionReceipts[${index}].eventId`,
    );
    exact(
      receipt.eventHash,
      revisionHash,
      `revisionReceipts[${index}].eventHash`,
    );
    exact(
      receipt.journalHead,
      revisionHash,
      `revisionReceipts[${index}].journalHead`,
    );
    exact(
      receipt.ordinal,
      revision.revisionOrdinal,
      `revisionReceipts[${index}].ordinal`,
    );
    if (receipt.commitSequence <= previousCommitSequence) {
      fail(
        "revision receipt commitSequence is not increasing after primary closure",
      );
    }
    if (Date.parse(receipt.committedAt) < previousCommittedAt) {
      fail(
        "revision receipt committedAt is not monotonic after primary closure",
      );
    }
    if (Date.parse(receipt.committedAt) < Date.parse(revision.receivedAt)) {
      fail(`revisionReceipts[${index}].committedAt precedes revision receipt`);
    }
    if (Date.parse(receipt.committedAt) < Date.parse(closure.closedAt)) {
      fail(
        `revisionReceipts[${index}].committedAt precedes the immutable primary closure`,
      );
    }
    exact(
      receipt.registrarServiceId,
      service.serviceId,
      `revisionReceipts[${index}].registrarServiceId`,
    );
    exact(
      receipt.receiptKeyId,
      service.receiptKey.keyId,
      `revisionReceipts[${index}].receiptKeyId`,
    );
    assertKeyValidAt(
      service.receiptKey,
      receipt.committedAt,
      `revisionReceipts[${index}].committedAt`,
    );
    verifySignedValue({
      domain: "chronorift-e3-append-receipt-v1",
      schemaId: SCHEMA.appendReceipt,
      value: receiptSignatureBasis(receipt),
      signature: receipt.signature,
      key: service.receiptKey.key,
      label: `revisionReceipts[${index}]`,
    });
    previousRevisionHash = revisionHash;
    const eventHash = contentHash(event);
    const sameOrdinalHashes = eventHashesByOrdinal.get(event.ordinal);
    if (sameOrdinalHashes === undefined) {
      eventHashesByOrdinal.set(event.ordinal, new Set([eventHash]));
    } else {
      sameOrdinalHashes.add(eventHash);
    }
    previousCommitSequence = receipt.commitSequence;
    previousCommittedAt = Date.parse(receipt.committedAt);
    previousCommittedAtText = receipt.committedAt;
  }
  return {
    revisionCount: revisions.length,
    latestKnownEventCount: closure.eventCount + revisions.length,
    revisionHead: revisions.length === 0 ? null : previousRevisionHash,
    commitSequence: previousCommitSequence,
    committedAt: previousCommittedAtText,
  };
};

const revisionCheckpointSignatureBasis = (checkpoint) => {
  const basis = { ...checkpoint };
  delete basis.signature;
  return basis;
};

const validateRevisionJournalCheckpoint = ({
  value,
  campaignId,
  closure,
  revisionProjection,
  service,
}) => {
  exactKeys(
    value,
    [
      "schemaId",
      "schemaVersion",
      "campaignId",
      "primaryClosureHash",
      "revisionHead",
      "revisionCount",
      "latestKnownEventCount",
      "commitSequence",
      "asOf",
      "registrarServiceId",
      "closureKeyId",
      "signature",
    ],
    "revisionJournalCheckpoint",
  );
  exact(
    value.schemaId,
    SCHEMA.revisionJournalCheckpoint,
    "revisionJournalCheckpoint.schemaId",
  );
  exact(value.schemaVersion, 1, "revisionJournalCheckpoint.schemaVersion");
  exact(value.campaignId, campaignId, "revisionJournalCheckpoint.campaignId");
  exact(
    value.primaryClosureHash,
    closure.closureHash,
    "revisionJournalCheckpoint.primaryClosureHash",
  );
  if (value.revisionHead !== null) {
    digest(value.revisionHead, "revisionJournalCheckpoint.revisionHead");
  }
  exact(
    value.revisionHead,
    revisionProjection.revisionHead,
    "revisionJournalCheckpoint.revisionHead",
  );
  boundedInteger(
    value.revisionCount,
    0,
    64,
    "revisionJournalCheckpoint.revisionCount",
  );
  exact(
    value.revisionCount,
    revisionProjection.revisionCount,
    "revisionJournalCheckpoint.revisionCount",
  );
  boundedInteger(
    value.latestKnownEventCount,
    1,
    Number.MAX_SAFE_INTEGER,
    "revisionJournalCheckpoint.latestKnownEventCount",
  );
  exact(
    value.latestKnownEventCount,
    revisionProjection.latestKnownEventCount,
    "revisionJournalCheckpoint.latestKnownEventCount",
  );
  boundedInteger(
    value.commitSequence,
    1,
    Number.MAX_SAFE_INTEGER,
    "revisionJournalCheckpoint.commitSequence",
  );
  exact(
    value.commitSequence,
    revisionProjection.commitSequence,
    "revisionJournalCheckpoint.commitSequence",
  );
  timestamp(value.asOf, "revisionJournalCheckpoint.asOf");
  if (
    Date.parse(value.asOf) < Date.parse(revisionProjection.committedAt) ||
    Date.parse(value.asOf) < Date.parse(closure.closedAt)
  ) {
    fail(
      "revisionJournalCheckpoint.asOf precedes its latest receipt or primary closure",
    );
  }
  exact(
    value.registrarServiceId,
    service.serviceId,
    "revisionJournalCheckpoint.registrarServiceId",
  );
  exact(
    value.closureKeyId,
    service.closureKey.keyId,
    "revisionJournalCheckpoint.closureKeyId",
  );
  assertKeyValidAt(
    service.closureKey,
    value.asOf,
    "revisionJournalCheckpoint.asOf",
  );
  verifySignedValue({
    domain: "chronorift-e3-revision-journal-checkpoint-v1",
    schemaId: SCHEMA.revisionJournalCheckpoint,
    value: revisionCheckpointSignatureBasis(value),
    signature: value.signature,
    key: service.closureKey.key,
    label: "revisionJournalCheckpoint",
  });
};

const closureHashBasis = (closure) => {
  const basis = { ...closure };
  delete basis.closureHash;
  delete basis.signature;
  return basis;
};
const closureSignatureBasis = (closure) => {
  const basis = { ...closure };
  delete basis.signature;
  return basis;
};
const clockSignatureBasis = (closure) => ({
  campaignId: closure.campaignId,
  journalHead: closure.journalHead,
  deadline: closure.deadline,
  closedAt: closure.closedAt,
  primaryOutcome: closure.primaryOutcome,
});

const validateClosure = ({
  value,
  campaignId,
  manifest,
  journal,
  projection,
  service,
  rejectionCount,
}) => {
  exactKeys(
    value,
    [
      "schemaId",
      "schemaVersion",
      "campaignId",
      "closureHash",
      "journalHead",
      "deadline",
      "closedAt",
      "primaryOutcome",
      "assignmentCount",
      "outcomeCounts",
      "eventCount",
      "appendAttemptCount",
      "rejectionCount",
      "idempotentReplayCount",
      "publicationState",
      "claimEligible",
      "modelCalls",
      "evaluatorRuns",
      "clockKeyId",
      "clockSignature",
      "closureKeyId",
      "signature",
    ],
    "primaryClosure",
  );
  exact(value.schemaId, SCHEMA.primaryClosure, "primaryClosure.schemaId");
  exact(value.schemaVersion, 1, "primaryClosure.schemaVersion");
  exact(value.campaignId, campaignId, "primaryClosure.campaignId");
  exact(value.journalHead, journal.journalHead, "primaryClosure.journalHead");
  exact(value.deadline, manifest.deadline, "primaryClosure.deadline");
  timestamp(value.closedAt, "primaryClosure.closedAt");
  exact(
    value.closedAt,
    projection.closingEntry.payload.closedAt,
    "primaryClosure.closedAt",
  );
  exact(
    value.primaryOutcome,
    projection.outcome,
    "primaryClosure.primaryOutcome",
  );
  if (
    (projection.outcome === "conformance_complete" &&
      Date.parse(value.closedAt) >= Date.parse(manifest.deadline)) ||
    (projection.outcome !== "conformance_complete" &&
      Date.parse(value.closedAt) < Date.parse(manifest.deadline))
  ) {
    fail("primaryClosure timing does not match early or deadline closure");
  }
  exact(value.assignmentCount, 1, "primaryClosure.assignmentCount");
  exactKeys(
    value.outcomeCounts,
    ["conformanceComplete", "incompleteUnknown", "cleanupUnproven"],
    "primaryClosure.outcomeCounts",
  );
  const expectedCounts = {
    conformanceComplete: 0,
    incompleteUnknown: 0,
    cleanupUnproven: 0,
  };
  expectedCounts[
    {
      conformance_complete: "conformanceComplete",
      incomplete_unknown: "incompleteUnknown",
      cleanup_unproven: "cleanupUnproven",
    }[projection.outcome]
  ] = 1;
  for (const field of Object.keys(expectedCounts))
    exact(
      value.outcomeCounts[field],
      expectedCounts[field],
      `primaryClosure.outcomeCounts.${field}`,
    );
  exact(value.eventCount, projection.eventCount, "primaryClosure.eventCount");
  boundedInteger(
    value.appendAttemptCount,
    1,
    Number.MAX_SAFE_INTEGER,
    "primaryClosure.appendAttemptCount",
  );
  boundedInteger(
    value.rejectionCount,
    0,
    Number.MAX_SAFE_INTEGER,
    "primaryClosure.rejectionCount",
  );
  boundedInteger(
    value.idempotentReplayCount,
    0,
    Number.MAX_SAFE_INTEGER,
    "primaryClosure.idempotentReplayCount",
  );
  exact(value.rejectionCount, rejectionCount, "primaryClosure.rejectionCount");
  exact(
    value.appendAttemptCount,
    value.eventCount + value.rejectionCount + value.idempotentReplayCount,
    "primaryClosure append-attempt accounting",
  );
  exact(
    value.publicationState,
    "closure_sealed_publication_pending",
    "primaryClosure.publicationState",
  );
  exact(value.claimEligible, false, "primaryClosure.claimEligible");
  exact(value.modelCalls, 0, "primaryClosure.modelCalls");
  exact(value.evaluatorRuns, 0, "primaryClosure.evaluatorRuns");
  exact(value.clockKeyId, service.clockKey.keyId, "primaryClosure.clockKeyId");
  exact(
    value.closureKeyId,
    service.closureKey.keyId,
    "primaryClosure.closureKeyId",
  );
  exact(
    digest(value.closureHash, "primaryClosure.closureHash"),
    contentHash(closureHashBasis(value)),
    "primaryClosure.closureHash",
  );
  assertKeyValidAt(
    service.clockKey,
    value.closedAt,
    "primaryClosure clock signing time",
  );
  assertKeyValidAt(
    service.closureKey,
    value.closedAt,
    "primaryClosure closure signing time",
  );
  verifySignedValue({
    domain: "chronorift-e3-clock-v1",
    schemaId: SCHEMA.primaryClosure,
    value: clockSignatureBasis(value),
    signature: value.clockSignature,
    key: service.clockKey.key,
    label: "primaryClosure.clock",
  });
  verifySignedValue({
    domain: "chronorift-e3-primary-closure-v1",
    schemaId: SCHEMA.primaryClosure,
    value: closureSignatureBasis(value),
    signature: value.signature,
    key: service.closureKey.key,
    label: "primaryClosure",
  });
};

const merkleLeafHash = (bytes) =>
  sha256(Buffer.concat([Buffer.from([0]), Buffer.from(bytes)]));
const merkleNodeHash = (left, right) =>
  sha256(
    Buffer.concat([
      Buffer.from([1]),
      Buffer.from(digest(left, "left Merkle node"), "hex"),
      Buffer.from(digest(right, "right Merkle node"), "hex"),
    ]),
  );

const verifyInclusionProof = ({ leafBytes, proof, root }) => {
  let node = merkleLeafHash(leafBytes);
  let leaf = proof.leafIndex;
  let last = proof.treeSize - 1;
  for (const sibling of proof.auditPath) {
    digest(sibling, "inclusion proof node");
    if ((leaf & 1) === 1 || leaf === last) {
      node = merkleNodeHash(sibling, node);
      while ((leaf & 1) === 0 && leaf !== 0) {
        leaf >>= 1;
        last >>= 1;
      }
    } else node = merkleNodeHash(node, sibling);
    leaf >>= 1;
    last >>= 1;
  }
  return last === 0 && node === root;
};

const verifyConsistencyProof = ({
  firstSize,
  secondSize,
  firstRoot,
  secondRoot,
  path,
}) => {
  if (firstSize === secondSize)
    return path.length === 0 && firstRoot === secondRoot;
  let first = firstSize - 1;
  let second = secondSize - 1;
  while ((first & 1) === 1) {
    first >>= 1;
    second >>= 1;
  }
  let offset = 0;
  let oldHash;
  let newHash;
  if (first === 0) oldHash = newHash = firstRoot;
  else {
    oldHash = newHash = path[offset++];
    if (oldHash === undefined) return false;
    digest(oldHash, "consistency proof node");
  }
  while (offset < path.length) {
    if (second === 0) return false;
    const sibling = path[offset++];
    digest(sibling, "consistency proof node");
    if ((first & 1) === 1 || first === second) {
      oldHash = merkleNodeHash(sibling, oldHash);
      newHash = merkleNodeHash(sibling, newHash);
      while ((first & 1) === 0 && first !== 0) {
        first >>= 1;
        second >>= 1;
      }
    } else newHash = merkleNodeHash(newHash, sibling);
    first >>= 1;
    second >>= 1;
  }
  return second === 0 && oldHash === firstRoot && newHash === secondRoot;
};

const checkpointBasis = (checkpoint) => {
  const basis = { ...checkpoint };
  delete basis.signature;
  return basis;
};

const validateCheckpoint = (value, label, service) => {
  exactKeys(
    value,
    ["logId", "treeSize", "rootHash", "issuedAt", "logKeyId", "signature"],
    label,
  );
  identifier(value.logId, `${label}.logId`);
  boundedInteger(
    value.treeSize,
    1,
    Number.MAX_SAFE_INTEGER,
    `${label}.treeSize`,
  );
  digest(value.rootHash, `${label}.rootHash`);
  timestamp(value.issuedAt, `${label}.issuedAt`);
  exact(value.logKeyId, service.logKey.keyId, `${label}.logKeyId`);
  assertKeyValidAt(service.logKey, value.issuedAt, `${label}.issuedAt`);
  verifySignedValue({
    domain: "chronorift-e3-transparency-checkpoint-v1",
    schemaId: "chronorift.e3.transparency-checkpoint",
    value: checkpointBasis(value),
    signature: value.signature,
    key: service.logKey.key,
    label,
  });
};

const validateProofShape = (proof, keys, label) => {
  exactKeys(proof, keys, label);
  for (const field of keys.filter(
    (key) => key.endsWith("Size") || key === "leafIndex",
  ))
    boundedInteger(
      proof[field],
      field === "leafIndex" ? 0 : 1,
      Number.MAX_SAFE_INTEGER,
      `${label}.${field}`,
    );
  boundedArray(proof.auditPath, 0, 64, `${label}.auditPath`).forEach(
    (node, index) => digest(node, `${label}.auditPath[${index}]`),
  );
};

const validateRegistrationProof = ({
  value,
  campaignId,
  deadline,
  service,
  registrationCommittedAt,
  firstActorCommittedAt,
}) => {
  exactKeys(
    value,
    ["schemaId", "schemaVersion", "campaignId", "checkpoint", "inclusionProof"],
    "registrationProof",
  );
  exact(value.schemaId, SCHEMA.registrationProof, "registrationProof.schemaId");
  exact(value.schemaVersion, 1, "registrationProof.schemaVersion");
  exact(value.campaignId, campaignId, "registrationProof.campaignId");
  validateCheckpoint(value.checkpoint, "registrationProof.checkpoint", service);
  if (Date.parse(value.checkpoint.issuedAt) >= Date.parse(deadline)) {
    fail("registration checkpoint was not published before campaign deadline");
  }
  if (
    Date.parse(value.checkpoint.issuedAt) < Date.parse(registrationCommittedAt)
  ) {
    fail("registration checkpoint predates the registration commit");
  }
  if (
    firstActorCommittedAt !== null &&
    Date.parse(value.checkpoint.issuedAt) > Date.parse(firstActorCommittedAt)
  ) {
    fail("registration checkpoint was published after actor execution began");
  }
  validateProofShape(
    value.inclusionProof,
    ["leafIndex", "treeSize", "auditPath"],
    "registrationProof.inclusionProof",
  );
  exact(
    value.inclusionProof.treeSize,
    value.checkpoint.treeSize,
    "registrationProof inclusion treeSize",
  );
  if (value.inclusionProof.leafIndex >= value.inclusionProof.treeSize) {
    fail("registrationProof inclusion leafIndex is outside tree");
  }
  const leafBytes = Buffer.from(
    canonicalJson({ campaignId, deadline }),
    "utf8",
  );
  if (
    !verifyInclusionProof({
      leafBytes,
      proof: value.inclusionProof,
      root: value.checkpoint.rootHash,
    })
  ) {
    fail("registration RFC6962 inclusion proof is invalid");
  }
};

const validatePublication = ({ value, campaignId, closure, service }) => {
  exactKeys(
    value,
    [
      "schemaId",
      "schemaVersion",
      "campaignId",
      "closureHash",
      "registrationCheckpoint",
      "closureCheckpoint",
      "closureInclusionProof",
      "registrationToClosureConsistencyProof",
    ],
    "publicationProof",
  );
  exact(value.schemaId, SCHEMA.publicationProof, "publicationProof.schemaId");
  exact(value.schemaVersion, 1, "publicationProof.schemaVersion");
  exact(value.campaignId, campaignId, "publicationProof.campaignId");
  exact(value.closureHash, closure.closureHash, "publicationProof.closureHash");
  validateCheckpoint(
    value.registrationCheckpoint,
    "publicationProof.registrationCheckpoint",
    service,
  );
  validateCheckpoint(
    value.closureCheckpoint,
    "publicationProof.closureCheckpoint",
    service,
  );
  exact(
    value.registrationCheckpoint.logId,
    value.closureCheckpoint.logId,
    "publication checkpoint logId",
  );
  if (
    value.registrationCheckpoint.treeSize >= value.closureCheckpoint.treeSize
  ) {
    fail("closure publication did not advance the transparency log");
  }
  if (
    Date.parse(value.closureCheckpoint.issuedAt) <
      Date.parse(value.registrationCheckpoint.issuedAt) ||
    Date.parse(value.closureCheckpoint.issuedAt) < Date.parse(closure.closedAt)
  ) {
    fail("closure checkpoint predates registration or primary closure");
  }
  validateProofShape(
    value.closureInclusionProof,
    ["leafIndex", "treeSize", "auditPath"],
    "publicationProof.closureInclusionProof",
  );
  exact(
    value.closureInclusionProof.treeSize,
    value.closureCheckpoint.treeSize,
    "closure inclusion treeSize",
  );
  if (
    value.closureInclusionProof.leafIndex >=
    value.closureInclusionProof.treeSize
  )
    fail("closure inclusion leafIndex is outside tree");
  const leafBytes = Buffer.from(
    canonicalJson({ campaignId, closureHash: closure.closureHash }),
    "utf8",
  );
  if (
    !verifyInclusionProof({
      leafBytes,
      proof: value.closureInclusionProof,
      root: value.closureCheckpoint.rootHash,
    })
  )
    fail("closure RFC6962 inclusion proof is invalid");
  const consistency = value.registrationToClosureConsistencyProof;
  validateProofShape(
    consistency,
    ["firstTreeSize", "secondTreeSize", "auditPath"],
    "publicationProof.registrationToClosureConsistencyProof",
  );
  exact(
    consistency.firstTreeSize,
    value.registrationCheckpoint.treeSize,
    "consistency firstTreeSize",
  );
  exact(
    consistency.secondTreeSize,
    value.closureCheckpoint.treeSize,
    "consistency secondTreeSize",
  );
  if (
    consistency.firstTreeSize > consistency.secondTreeSize ||
    !verifyConsistencyProof({
      firstSize: consistency.firstTreeSize,
      secondSize: consistency.secondTreeSize,
      firstRoot: value.registrationCheckpoint.rootHash,
      secondRoot: value.closureCheckpoint.rootHash,
      path: consistency.auditPath,
    })
  )
    fail("RFC6962 consistency proof is invalid");
};

const validateSummary = ({
  value,
  manifest,
  campaignId,
  assignmentId,
  journal,
  closure,
  registration,
  publication,
  revisionProjection,
  revisionJournalCheckpoint,
  service,
  rejectionCount,
  appendReceipts,
  trustRootFileHash,
  trustRootFreezeRecordHash,
  trustRootExternalPinHash,
}) => {
  exactKeys(
    value,
    [
      "schemaId",
      "schemaVersion",
      "capability",
      "campaignPurpose",
      "viewKind",
      "publicationState",
      "claimEligible",
      "modelCalls",
      "evaluatorRuns",
      "artifactSinkMode",
      "artifactSinkId",
      "artifactSinkCommitment",
      "productSha256",
      "runnerSha256",
      "validatorSha256",
      "trustRootVersion",
      "trustRootFileSha256",
      "trustRootFreezeRecordSha256",
      "trustRootExternalPinSha256",
      "registrarServiceId",
      "tlsSpkiId",
      "registrarKeyIds",
      "actorKeyIds",
      "campaignId",
      "assignmentIds",
      "assignmentCount",
      "eventCount",
      "appendAttemptCount",
      "idempotentReplayCount",
      "revisionCount",
      "latestKnownEventCount",
      "rejectionCount",
      "closureCount",
      "primaryOutcome",
      "outcomeCounts",
      "journalHead",
      "closureHash",
      "deadline",
      "closedAt",
      "cleanupReceiptHash",
      "revisionCheckpointHash",
      "registrationCheckpointRoot",
      "registrationCheckpointTreeSize",
      "registrationCheckpointIssuedAt",
      "checkpointRoot",
      "checkpointTreeSize",
      "checkpointIssuedAt",
      "registrationInclusionProofHash",
      "inclusionProofHash",
      "consistencyProofHash",
    ],
    "summary",
  );
  exact(value.schemaId, SCHEMA.sanitizedSummary, "summary.schemaId");
  exact(value.schemaVersion, 1, "summary.schemaVersion");
  exact(
    value.capability,
    "campaign_denominator_conformance",
    "summary.capability",
  );
  exact(
    value.campaignPurpose,
    "registrar_conformance",
    "summary.campaignPurpose",
  );
  exact(value.viewKind, "latest_known", "summary.viewKind");
  exact(
    value.publicationState,
    "closure_published",
    "summary.publicationState",
  );
  exact(value.claimEligible, false, "summary.claimEligible");
  exact(value.modelCalls, 0, "summary.modelCalls");
  exact(value.evaluatorRuns, 0, "summary.evaluatorRuns");
  exact(value.artifactSinkMode, ARTIFACT_SINK_MODE, "summary.artifactSinkMode");
  identifier(value.artifactSinkId, "summary.artifactSinkId");
  digest(value.artifactSinkCommitment, "summary.artifactSinkCommitment");
  for (const field of [
    "artifactSinkMode",
    "artifactSinkId",
    "artifactSinkCommitment",
  ]) {
    exact(value[field], manifest[field], `summary.${field}`);
  }
  for (const field of ["productSha256", "runnerSha256", "validatorSha256"])
    exact(value[field], manifest[field], `summary.${field}`);
  exact(
    value.trustRootVersion,
    manifest.trustRootVersion,
    "summary.trustRootVersion",
  );
  exact(
    value.trustRootFileSha256,
    trustRootFileHash,
    "summary.trustRootFileSha256",
  );
  exact(
    value.trustRootFreezeRecordSha256,
    trustRootFreezeRecordHash,
    "summary.trustRootFreezeRecordSha256",
  );
  exact(
    value.trustRootExternalPinSha256,
    trustRootExternalPinHash,
    "summary.trustRootExternalPinSha256",
  );
  exact(
    value.registrarServiceId,
    service.serviceId,
    "summary.registrarServiceId",
  );
  exact(value.tlsSpkiId, service.tlsSpkiSha256, "summary.tlsSpkiId");
  exactKeys(
    value.registrarKeyIds,
    ["receipt", "clock", "closure", "log"],
    "summary.registrarKeyIds",
  );
  for (const [role, key] of [
    ["receipt", service.receiptKey],
    ["clock", service.clockKey],
    ["closure", service.closureKey],
    ["log", service.logKey],
  ]) {
    exact(
      value.registrarKeyIds[role],
      key.keyId,
      `summary.registrarKeyIds.${role}`,
    );
  }
  if (new Set(Object.values(value.registrarKeyIds)).size !== 4) {
    fail("summary.registrarKeyIds do not bind four distinct role keys");
  }
  exactKeys(
    value.actorKeyIds,
    ["conformance", "cleanup"],
    "summary.actorKeyIds",
  );
  exact(
    value.actorKeyIds.conformance,
    manifest.assignments[0].conformanceActorKeyId,
    "summary.actorKeyIds.conformance",
  );
  exact(
    value.actorKeyIds.cleanup,
    manifest.assignments[0].cleanupActorKeyId,
    "summary.actorKeyIds.cleanup",
  );
  const summaryOperationalKeyIds = [
    ...Object.values(value.registrarKeyIds),
    ...Object.values(value.actorKeyIds),
  ];
  if (
    new Set(summaryOperationalKeyIds).size !== summaryOperationalKeyIds.length
  ) {
    fail("summary registrar and actor role keys must be distinct");
  }
  exact(value.campaignId, campaignId, "summary.campaignId");
  if (!Array.isArray(value.assignmentIds) || value.assignmentIds.length !== 1)
    fail("summary.assignmentIds must contain one assignment");
  exact(value.assignmentIds[0], assignmentId, "summary.assignmentIds[0]");
  exact(value.assignmentCount, 1, "summary.assignmentCount");
  exact(value.eventCount, journal.eventCount, "summary.eventCount");
  exact(
    value.appendAttemptCount,
    closure.appendAttemptCount,
    "summary.appendAttemptCount",
  );
  exact(
    value.idempotentReplayCount,
    closure.idempotentReplayCount,
    "summary.idempotentReplayCount",
  );
  exact(
    value.revisionCount,
    revisionProjection.revisionCount,
    "summary.revisionCount",
  );
  exact(
    value.latestKnownEventCount,
    revisionProjection.latestKnownEventCount,
    "summary.latestKnownEventCount",
  );
  exact(value.rejectionCount, rejectionCount, "summary.rejectionCount");
  exact(
    value.rejectionCount,
    closure.rejectionCount,
    "summary primary-closure rejectionCount",
  );
  exact(value.closureCount, 1, "summary.closureCount");
  exact(value.primaryOutcome, closure.primaryOutcome, "summary.primaryOutcome");
  exactKeys(
    value.outcomeCounts,
    ["conformanceComplete", "incompleteUnknown", "cleanupUnproven"],
    "summary.outcomeCounts",
  );
  for (const field of [
    "conformanceComplete",
    "incompleteUnknown",
    "cleanupUnproven",
  ]) {
    exact(
      value.outcomeCounts[field],
      closure.outcomeCounts[field],
      `summary.outcomeCounts.${field}`,
    );
  }
  exact(value.journalHead, journal.journalHead, "summary.journalHead");
  exact(value.closureHash, closure.closureHash, "summary.closureHash");
  exact(value.deadline, manifest.deadline, "summary.deadline");
  exact(value.closedAt, closure.closedAt, "summary.closedAt");
  const cleanupEventIndex = journal.events.findIndex(
    ({ event }) => event.eventKind === "conformance_cleanup_proven",
  );
  const cleanupReceiptHash =
    cleanupEventIndex < 0
      ? null
      : contentHash(appendReceipts[cleanupEventIndex]);
  exact(
    value.cleanupReceiptHash,
    cleanupReceiptHash,
    "summary.cleanupReceiptHash",
  );
  exact(
    value.revisionCheckpointHash,
    contentHash(revisionJournalCheckpoint),
    "summary.revisionCheckpointHash",
  );
  exact(
    value.registrationCheckpointRoot,
    registration.checkpoint.rootHash,
    "summary.registrationCheckpointRoot",
  );
  exact(
    value.registrationCheckpointTreeSize,
    registration.checkpoint.treeSize,
    "summary.registrationCheckpointTreeSize",
  );
  exact(
    value.registrationCheckpointIssuedAt,
    registration.checkpoint.issuedAt,
    "summary.registrationCheckpointIssuedAt",
  );
  exact(
    value.checkpointRoot,
    publication.closureCheckpoint.rootHash,
    "summary.checkpointRoot",
  );
  exact(
    value.checkpointTreeSize,
    publication.closureCheckpoint.treeSize,
    "summary.checkpointTreeSize",
  );
  exact(
    value.checkpointIssuedAt,
    publication.closureCheckpoint.issuedAt,
    "summary.checkpointIssuedAt",
  );
  exact(
    value.registrationInclusionProofHash,
    contentHash(registration.inclusionProof),
    "summary.registrationInclusionProofHash",
  );
  exact(
    value.inclusionProofHash,
    contentHash(publication.closureInclusionProof),
    "summary.inclusionProofHash",
  );
  exact(
    value.consistencyProofHash,
    contentHash(publication.registrationToClosureConsistencyProof),
    "summary.consistencyProofHash",
  );
};

const submittedEvidence = object(
  await readStrictCanonicalJson(evidencePath),
  "evidence",
);
const serializedEvidence = canonicalJson(submittedEvidence);
if (FORBIDDEN_VOCABULARY.test(serializedEvidence)) {
  fail(
    "synthetic conformance evidence contains forbidden evaluation vocabulary",
  );
}

if (PINNED_EXTERNAL_TRUST_ROOT_SHA256 === null) {
  fail("the external registrar trust-root hash has not been release-pinned");
}
const pinnedExternalTrustRootHash = digest(
  PINNED_EXTERNAL_TRUST_ROOT_SHA256,
  "pinned external trust-root hash",
);
const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const pinnedTrustRootFile = await readStrictCanonicalJsonWithBytes(
  resolve(repositoryRoot, TRUST_ROOT_RELATIVE_PATH),
  "pinned registrar trust root",
);
const pinnedFreezeFile = await readStrictCanonicalJsonWithBytes(
  resolve(repositoryRoot, TRUST_ROOT_FREEZE_RELATIVE_PATH),
  "pinned registrar trust-root freeze record",
);
const pinnedTrustRootFileHash = sha256(pinnedTrustRootFile.bytes);
const pinnedTrustRootFreezeRecordHash = sha256(pinnedFreezeFile.bytes);
exact(
  pinnedTrustRootFileHash,
  pinnedExternalTrustRootHash,
  "pinned registrar trust-root external hash",
);
const trustRoot = validateTrustRoot(
  object(pinnedTrustRootFile.value, "trustRoot"),
);
validateTrustRootFreeze({
  value: object(pinnedFreezeFile.value, "trustRootFreeze"),
  trustRoot,
  trustRootFileHash: pinnedTrustRootFileHash,
});
let pinnedFaultControlPolicyFile;
if (submittedEvidence.schemaId === SCHEMA.campaignSuiteEvidence) {
  const policyFile = await readStrictCanonicalJsonWithBytes(
    resolve(repositoryRoot, FAULT_CONTROL_POLICY_RELATIVE_PATH),
    "pinned registrar fault-control policy",
  );
  pinnedFaultControlPolicyFile = {
    sha256: sha256(policyFile.bytes),
    policy: validateFaultControlPolicy({
      value: object(policyFile.value, "faultControlPolicy"),
      trustRoot,
    }),
  };
}

const validateCampaignEvidence = (rawEvidence, label = "evidence") => {
  const evidence = object(rawEvidence, label);
  exactKeys(
    evidence,
    [
      "schemaId",
      "schemaVersion",
      "trustRoot",
      "actorKeys",
      "manifest",
      "journal",
      "appendReceipts",
      "primaryClosure",
      "revisions",
      "revisionReceipts",
      "revisionJournalCheckpoint",
      "registrationProof",
      "publicationProof",
      "rejectionCount",
      "summary",
    ],
    label,
  );
  exact(evidence.schemaId, SCHEMA.campaignEvidence, `${label}.schemaId`);
  exact(evidence.schemaVersion, 1, `${label}.schemaVersion`);
  boundedInteger(
    evidence.rejectionCount,
    0,
    Number.MAX_SAFE_INTEGER,
    `${label}.rejectionCount`,
  );
  const evidenceTrustRootBytes = Buffer.from(
    `${canonicalJson(object(evidence.trustRoot, `${label}.trustRoot`))}\n`,
    "utf8",
  );
  if (!evidenceTrustRootBytes.equals(pinnedTrustRootFile.bytes)) {
    fail(
      `${label} trustRoot does not byte-match the pinned registrar trust root`,
    );
  }
  const manifest = validateManifest(
    object(evidence.manifest, `${label}.manifest`),
  );
  exact(
    manifest.trustRootVersion,
    trustRoot.trustRootVersion,
    `${label} manifest trust-root binding`,
  );
  if (
    Date.parse(manifest.deadline) < Date.parse(trustRoot.validFrom) ||
    Date.parse(manifest.deadline) >= Date.parse(trustRoot.validUntil)
  )
    fail(`${label} manifest deadline is outside trust-root validity`);
  const service = trustRoot.services.find(
    ({ serviceId }) => serviceId === manifest.registrarServiceId,
  );
  if (service === undefined)
    fail(`${label} manifest references an unknown registrar service`);
  if (!service.namespaces.includes(manifest.namespace))
    fail(`${label} manifest namespace is not authorized by registrar service`);
  const campaignId = campaignIdFor(manifest);
  const assignmentId = assignmentIdFor(campaignId, manifest.assignments[0]);
  const actorKeys = validateActorKeys(evidence.actorKeys, manifest, trustRoot);
  const projection = validateJournal({
    journal: object(evidence.journal, `${label}.journal`),
    appendReceipts: evidence.appendReceipts,
    campaignId,
    assignmentId,
    manifest,
    service,
    actorKeys,
  });
  validateClosure({
    value: object(evidence.primaryClosure, `${label}.primaryClosure`),
    campaignId,
    manifest,
    journal: evidence.journal,
    projection,
    service,
    rejectionCount: evidence.rejectionCount,
  });
  const revisionProjection = validateRevisions({
    revisions: evidence.revisions,
    receipts: evidence.revisionReceipts,
    campaignId,
    assignmentId,
    journal: evidence.journal,
    closure: evidence.primaryClosure,
    primaryReceipts: evidence.appendReceipts,
    service,
    actorKeys,
  });
  validateRevisionJournalCheckpoint({
    value: object(
      evidence.revisionJournalCheckpoint,
      `${label}.revisionJournalCheckpoint`,
    ),
    campaignId,
    closure: evidence.primaryClosure,
    revisionProjection,
    service,
  });
  validateRegistrationProof({
    value: object(evidence.registrationProof, `${label}.registrationProof`),
    campaignId,
    deadline: manifest.deadline,
    service,
    registrationCommittedAt: evidence.appendReceipts[0].committedAt,
    firstActorCommittedAt: projection.firstActorCommittedAt,
  });
  validatePublication({
    value: object(evidence.publicationProof, `${label}.publicationProof`),
    campaignId,
    closure: evidence.primaryClosure,
    service,
  });
  exact(
    canonicalJson(evidence.publicationProof.registrationCheckpoint),
    canonicalJson(evidence.registrationProof.checkpoint),
    `${label} publicationProof registration checkpoint binding`,
  );
  validateSummary({
    value: object(evidence.summary, `${label}.summary`),
    manifest,
    campaignId,
    assignmentId,
    journal: evidence.journal,
    closure: evidence.primaryClosure,
    registration: evidence.registrationProof,
    publication: evidence.publicationProof,
    revisionProjection,
    revisionJournalCheckpoint: evidence.revisionJournalCheckpoint,
    service,
    rejectionCount: evidence.rejectionCount,
    appendReceipts: evidence.appendReceipts,
    trustRootFileHash: pinnedTrustRootFileHash,
    trustRootFreezeRecordHash: pinnedTrustRootFreezeRecordHash,
    trustRootExternalPinHash: pinnedExternalTrustRootHash,
  });
  return { evidence, manifest, service, campaignId, assignmentId };
};

const validateFaultReceipt = (
  rawReceipt,
  expectedCase,
  faultControlPolicy,
  label,
) => {
  const receipt = object(rawReceipt, label);
  exactKeys(
    receipt,
    [
      "schemaId",
      "schemaVersion",
      "receiptId",
      "requestId",
      "faultCase",
      "faultControlId",
      "faultPlanId",
      "faultKeyId",
      "registrarServiceId",
      "namespace",
      "startedAt",
      "completedAt",
      "observedRunnerExitCode",
      "observedErrorCode",
      "finalEvidencePresent",
      "successSummaryPresent",
      "signature",
    ],
    label,
  );
  exact(receipt.schemaId, SCHEMA.campaignFaultReceipt, `${label}.schemaId`);
  exact(receipt.schemaVersion, 1, `${label}.schemaVersion`);
  digest(receipt.receiptId, `${label}.receiptId`);
  digest(receipt.requestId, `${label}.requestId`);
  exact(receipt.faultCase, expectedCase, `${label}.faultCase`);
  identifier(receipt.faultControlId, `${label}.faultControlId`);
  digest(receipt.faultPlanId, `${label}.faultPlanId`);
  digest(receipt.faultKeyId, `${label}.faultKeyId`);
  identifier(receipt.registrarServiceId, `${label}.registrarServiceId`);
  namespace(receipt.namespace, `${label}.namespace`);
  timestamp(receipt.startedAt, `${label}.startedAt`);
  timestamp(receipt.completedAt, `${label}.completedAt`);
  if (Date.parse(receipt.completedAt) < Date.parse(receipt.startedAt)) {
    fail(`${label}.completedAt precedes startedAt`);
  }
  boundedInteger(
    receipt.observedRunnerExitCode,
    1,
    255,
    `${label}.observedRunnerExitCode`,
  );
  exact(
    receipt.observedErrorCode,
    "live_dependency_unavailable",
    `${label}.observedErrorCode`,
  );
  exact(receipt.finalEvidencePresent, false, `${label}.finalEvidencePresent`);
  exact(receipt.successSummaryPresent, false, `${label}.successSummaryPresent`);
  const basis = { ...receipt };
  delete basis.receiptId;
  delete basis.signature;
  exact(
    receipt.receiptId,
    sha256(
      Buffer.from(
        `chronorift-e3-conformance-fault-receipt-v1\0${canonicalJson(basis)}`,
        "utf8",
      ),
    ),
    `${label}.receiptId binding`,
  );
  exact(
    receipt.faultControlId,
    faultControlPolicy.value.faultControlId,
    `${label}.faultControlId policy binding`,
  );
  exact(
    receipt.faultPlanId,
    faultControlPolicy.value.faultPlanId,
    `${label}.faultPlanId policy binding`,
  );
  exact(
    receipt.faultKeyId,
    faultControlPolicy.faultKey.keyId,
    `${label}.faultKeyId policy binding`,
  );
  assertKeyValidAt(faultControlPolicy.faultKey, receipt.startedAt, label);
  assertKeyValidAt(faultControlPolicy.faultKey, receipt.completedAt, label);
  const signedBasis = { ...receipt };
  delete signedBasis.signature;
  verifySignedValue({
    domain: FAULT_RECEIPT_SIGNATURE_DOMAIN,
    schemaId: SCHEMA.campaignFaultReceipt,
    value: signedBasis,
    signature: receipt.signature,
    key: faultControlPolicy.faultKey.key,
    label,
  });
  return receipt;
};

const validateSuiteEvidence = (rawSuite, faultControlPolicyFile) => {
  const suite = object(rawSuite, "suiteEvidence");
  exactKeys(
    suite,
    [
      "schemaId",
      "schemaVersion",
      "faultControlPolicySha256",
      "cases",
      "faultReceipts",
      "summary",
    ],
    "suiteEvidence",
  );
  exact(suite.schemaId, SCHEMA.campaignSuiteEvidence, "suiteEvidence.schemaId");
  exact(suite.schemaVersion, 1, "suiteEvidence.schemaVersion");
  exact(
    digest(
      suite.faultControlPolicySha256,
      "suiteEvidence.faultControlPolicySha256",
    ),
    faultControlPolicyFile.sha256,
    "suiteEvidence.faultControlPolicySha256",
  );
  if (!Array.isArray(suite.cases) || suite.cases.length !== 3) {
    fail("suiteEvidence.cases must contain exactly three cases");
  }
  const expectedCaseIds = [
    "early_complete",
    "deadline_incomplete",
    "deadline_cleanup_unproven_with_late_cleanup",
  ];
  const expectedOutcomes = [
    "conformance_complete",
    "incomplete_unknown",
    "cleanup_unproven",
  ];
  const expectedEventKinds = [
    [
      "registrar_assignment_registered",
      "conformance_actor_started",
      "conformance_actor_finished",
      "conformance_cleanup_proven",
      "registrar_primary_closed",
    ],
    [
      "registrar_assignment_registered",
      "conformance_actor_started",
      "registrar_deadline_elapsed",
      "registrar_primary_closed",
    ],
    [
      "registrar_assignment_registered",
      "conformance_actor_started",
      "conformance_actor_finished",
      "registrar_deadline_elapsed",
      "registrar_primary_closed",
    ],
  ];
  const validated = suite.cases.map((rawCase, index) => {
    const entry = object(rawCase, `suiteEvidence.cases[${index}]`);
    exactKeys(entry, ["caseId", "evidence"], `suiteEvidence.cases[${index}]`);
    exact(
      entry.caseId,
      expectedCaseIds[index],
      `suiteEvidence.cases[${index}].caseId`,
    );
    const result = validateCampaignEvidence(
      entry.evidence,
      `suiteEvidence.cases[${index}].evidence`,
    );
    exact(
      result.evidence.primaryClosure.primaryOutcome,
      expectedOutcomes[index],
      `suiteEvidence.cases[${index}] primary outcome`,
    );
    exact(
      canonicalJson(
        result.evidence.journal.events.map(({ event }) => event.eventKind),
      ),
      canonicalJson(expectedEventKinds[index]),
      `suiteEvidence.cases[${index}] frozen lifecycle`,
    );
    exact(
      result.evidence.primaryClosure.rejectionCount,
      index === 0 ? 6 : 0,
      `suiteEvidence.cases[${index}] rejectionCount`,
    );
    exact(
      result.evidence.primaryClosure.idempotentReplayCount,
      index === 0 ? 1 : 0,
      `suiteEvidence.cases[${index}] idempotentReplayCount`,
    );
    if (index < 2 && result.evidence.revisions.length !== 0) {
      fail(`suiteEvidence.cases[${index}] has unexpected revisions`);
    }
    if (
      index === 2 &&
      (result.evidence.revisions.length !== 1 ||
        result.evidence.revisions[0].lateEntry.event.eventKind !==
          "conformance_cleanup_proven" ||
        Date.parse(result.evidence.revisions[0].receivedAt) <
          Date.parse(result.evidence.primaryClosure.closedAt))
    ) {
      fail(
        "suite cleanup-unproven case lacks exactly one late cleanup revision",
      );
    }
    return result;
  });
  if (
    new Set(validated.map(({ campaignId }) => campaignId)).size !== 3 ||
    new Set(validated.map(({ assignmentId }) => assignmentId)).size !== 3
  ) {
    fail("suite campaign and assignment identities must be unique");
  }
  const [reference] = validated;
  const referenceLease = reference.evidence.journal.events.find(
    ({ event }) => event.eventKind === "conformance_actor_started",
  )?.payload.leaseId;
  for (const item of validated) {
    exact(
      item.manifest.namespace,
      reference.manifest.namespace,
      "suite namespace",
    );
    exact(
      item.manifest.artifactSinkId,
      reference.manifest.artifactSinkId,
      "suite artifactSinkId",
    );
    exact(
      item.manifest.artifactSinkCommitment,
      reference.manifest.artifactSinkCommitment,
      "suite artifactSinkCommitment",
    );
    exact(item.service.serviceId, reference.service.serviceId, "suite service");
    exact(
      item.evidence.journal.events.find(
        ({ event }) => event.eventKind === "conformance_actor_started",
      )?.payload.leaseId,
      referenceLease,
      "suite cleanup lease",
    );
  }
  const rawFaultReceipts = boundedArray(
    suite.faultReceipts,
    2,
    2,
    "suiteEvidence.faultReceipts",
  );
  const faultReceipts = [
    validateFaultReceipt(
      rawFaultReceipts[0],
      "registrar_unreachable",
      faultControlPolicyFile.policy,
      "suiteEvidence.faultReceipts[0]",
    ),
    validateFaultReceipt(
      rawFaultReceipts[1],
      "transparency_log_unavailable",
      faultControlPolicyFile.policy,
      "suiteEvidence.faultReceipts[1]",
    ),
  ];
  if (faultReceipts[0].requestId === faultReceipts[1].requestId) {
    fail("suite fault receipts reuse one request identity");
  }
  for (const receipt of faultReceipts) {
    exact(
      receipt.registrarServiceId,
      reference.service.serviceId,
      "suite fault receipt service",
    );
    exact(
      receipt.namespace,
      reference.manifest.namespace,
      "suite fault receipt namespace",
    );
    exact(
      receipt.faultControlId,
      faultReceipts[0].faultControlId,
      "suite fault control",
    );
    exact(
      receipt.faultPlanId,
      faultReceipts[0].faultPlanId,
      "suite fault plan",
    );
  }
  exact(
    faultControlPolicyFile.policy.value.serviceId,
    reference.service.serviceId,
    "fault-control policy service",
  );
  exact(
    faultControlPolicyFile.policy.value.namespace,
    reference.manifest.namespace,
    "fault-control policy namespace",
  );
  exact(
    faultControlPolicyFile.policy.value.runnerSha256,
    reference.manifest.runnerSha256,
    "fault-control policy runner",
  );
  exact(
    faultControlPolicyFile.policy.value.validatorSha256,
    reference.manifest.validatorSha256,
    "fault-control policy validator",
  );
  const actorKeyIds = new Set(
    validated.flatMap(({ evidence }) =>
      evidence.actorKeys.map(({ keyId }) => keyId),
    ),
  );
  if (actorKeyIds.has(faultControlPolicyFile.policy.faultKey.keyId)) {
    fail("fault-control key aliases a campaign actor key");
  }
  const summary = object(suite.summary, "suiteEvidence.summary");
  exactKeys(
    summary,
    [
      "schemaId",
      "schemaVersion",
      "capability",
      "campaignPurpose",
      "claimEligible",
      "modelCalls",
      "evaluatorRuns",
      "campaignCount",
      "assignmentCount",
      "closureCount",
      "faultCaseCount",
      "faultControlId",
      "faultPlanId",
      "faultControlPolicySha256",
      "faultReceiptHashes",
      "productSha256",
      "runnerSha256",
      "validatorSha256",
      "trustRootVersion",
      "trustRootFileSha256",
      "trustRootFreezeRecordSha256",
      "trustRootExternalPinSha256",
      "registrarServiceId",
      "tlsSpkiId",
      "artifactSinkId",
      "artifactSinkCommitment",
      "caseIds",
      "campaignIds",
      "assignmentIds",
      "primaryOutcomes",
      "evidenceHashes",
      "caseSummaries",
      "eventCount",
      "appendAttemptCount",
      "rejectionCount",
      "idempotentReplayCount",
      "revisionCount",
    ],
    "suiteEvidence.summary",
  );
  exact(summary.schemaId, SCHEMA.campaignSuiteSummary, "suite summary schema");
  exact(summary.schemaVersion, 1, "suite summary version");
  exact(
    summary.capability,
    "campaign_denominator_conformance",
    "suite capability",
  );
  exact(summary.campaignPurpose, "registrar_conformance", "suite purpose");
  exact(summary.claimEligible, false, "suite claimEligible");
  exact(summary.modelCalls, 0, "suite modelCalls");
  exact(summary.evaluatorRuns, 0, "suite evaluatorRuns");
  exact(summary.campaignCount, 3, "suite campaignCount");
  exact(summary.assignmentCount, 3, "suite assignmentCount");
  exact(summary.closureCount, 3, "suite closureCount");
  exact(summary.faultCaseCount, 2, "suite faultCaseCount");
  exact(
    summary.faultControlId,
    faultReceipts[0].faultControlId,
    "suite faultControlId",
  );
  exact(summary.faultPlanId, faultReceipts[0].faultPlanId, "suite faultPlanId");
  exact(
    digest(
      summary.faultControlPolicySha256,
      "suite summary faultControlPolicySha256",
    ),
    suite.faultControlPolicySha256,
    "suite summary faultControlPolicySha256",
  );
  const summaries = validated.map(({ evidence }) => evidence.summary);
  const exactArray = (actual, expected, label) =>
    exact(canonicalJson(actual), canonicalJson(expected), label);
  exactArray(summary.caseIds, expectedCaseIds, "suite caseIds");
  exactArray(
    summary.campaignIds,
    validated.map(({ campaignId }) => campaignId),
    "suite campaignIds",
  );
  exactArray(
    summary.assignmentIds,
    validated.map(({ assignmentId }) => assignmentId),
    "suite assignmentIds",
  );
  exactArray(
    summary.primaryOutcomes,
    expectedOutcomes,
    "suite primaryOutcomes",
  );
  exactArray(
    summary.evidenceHashes,
    validated.map(({ evidence }) => contentHash(evidence)),
    "suite evidenceHashes",
  );
  exactArray(summary.caseSummaries, summaries, "suite caseSummaries");
  exactArray(
    summary.faultReceiptHashes,
    faultReceipts.map((receipt) => contentHash(receipt)),
    "suite faultReceiptHashes",
  );
  for (const field of [
    "productSha256",
    "runnerSha256",
    "validatorSha256",
    "trustRootVersion",
    "trustRootFileSha256",
    "trustRootFreezeRecordSha256",
    "trustRootExternalPinSha256",
    "registrarServiceId",
    "tlsSpkiId",
    "artifactSinkId",
    "artifactSinkCommitment",
  ]) {
    exact(summary[field], summaries[0][field], `suite summary ${field}`);
    for (const item of summaries)
      exact(item[field], summaries[0][field], `suite case ${field}`);
  }
  for (const field of [
    "eventCount",
    "appendAttemptCount",
    "rejectionCount",
    "idempotentReplayCount",
    "revisionCount",
  ]) {
    exact(
      summary[field],
      summaries.reduce((sum, item) => sum + item[field], 0),
      `suite summary ${field}`,
    );
  }
  return suite.summary;
};

if (submittedEvidence.schemaId === SCHEMA.campaignEvidence) {
  const validated = validateCampaignEvidence(submittedEvidence);
  process.stdout.write(
    `[chronorift-e3-campaign] ${canonicalJson(validated.evidence.summary)}\n`,
  );
} else if (submittedEvidence.schemaId === SCHEMA.campaignSuiteEvidence) {
  if (pinnedFaultControlPolicyFile === undefined) {
    fail("pinned registrar fault-control policy is unavailable");
  }
  const summary = validateSuiteEvidence(
    submittedEvidence,
    pinnedFaultControlPolicyFile,
  );
  process.stdout.write(
    `[chronorift-e3-campaign-suite] ${canonicalJson(summary)}\n`,
  );
} else {
  fail("unsupported evidence schemaId");
}
