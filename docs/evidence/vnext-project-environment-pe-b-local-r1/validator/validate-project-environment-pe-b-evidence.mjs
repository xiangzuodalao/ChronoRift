#!/usr/bin/env node

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { resolve } from "node:path";

const SCHEMA_ID =
  "https://chronorift.invalid/evidence/project-environment-pe-b-bundle.v2.schema.json";
const SCHEMA_RAW_SHA256 =
  "ad5a003c23588f19fa75932ad9138809b98b85dcc62e38327d6581a283d84ccb";
const MAX_SCHEMA_BYTES = 64 * 1024;
const MAX_EVIDENCE_BYTES = 32 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/u;
const fail = (message) => {
  throw new Error(`invalid PE-B evidence bundle: ${message}`);
};
const object = (value, label) => {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    fail(`${label} must be a plain object`);
  return value;
};
const exactKeys = (value, keys, label) => {
  const actual = Object.keys(object(value, label)).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    fail(`${label} has missing or unknown fields: ${actual.join(",")}`);
};
const canonicalJson = (value) => {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0))
      fail("non-canonical number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const item = object(value, "canonical value");
  return `{${Object.keys(item)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(item[key])}`)
    .join(",")}}`;
};
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const contentHash = (value) =>
  sha256(Buffer.from(canonicalJson(value), "utf8"));
const digest = (value, label) => {
  if (typeof value !== "string" || !SHA256.test(value))
    fail(`${label} is not SHA-256`);
  return value;
};
const string = (value, label, max = 4096) => {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > max ||
    value.includes("\0")
  )
    fail(`${label} is not bounded text`);
  return value;
};
const integer = (value, min, label) => {
  if (!Number.isSafeInteger(value) || value < min)
    fail(`${label} is not a bounded integer`);
  return value;
};
const exact = (actual, expected, label) => {
  if (canonicalJson(actual) !== canonicalJson(expected))
    fail(`${label} differs`);
};
const safePath = (value, label) => {
  string(value, label, 1024);
  if (
    value.startsWith("/") ||
    value.includes("\\") ||
    value
      .split("/")
      .some((part) => part === "" || part === "." || part === "..")
  )
    fail(`${label} is not package-relative`);
  return value;
};
const decodeBase64 = (value, label, max = 16 * 1024 * 1024) => {
  if (
    typeof value !== "string" ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      value,
    )
  )
    fail(`${label} is not canonical base64`);
  const bytes = Buffer.from(value, "base64");
  if (bytes.length > max || bytes.toString("base64") !== value)
    fail(`${label} base64 exceeds bounds`);
  return bytes;
};
const readPinnedRegular = async (path, maximum) => {
  const before = await lstat(path);
  if (
    !before.isFile() ||
    before.nlink !== 1 ||
    before.size < 1 ||
    before.size > maximum
  )
    fail(`${path} is not a bounded single-link regular file`);
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs
    )
      fail(`${path} changed while read`);
    return bytes;
  } finally {
    await handle.close();
  }
};
const parseJson = (bytes, label) => {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return fail(`${label} is not strict UTF-8 JSON`);
  }
};
const fileMap = (environment) => {
  const files = object(environment, "environment").files;
  if (!Array.isArray(files) || files.length < 7 || files.length > 300)
    fail("environment.files count is invalid");
  const result = new Map();
  for (const [index, raw] of files.entries()) {
    const file = object(raw, `environment.files[${index}]`);
    exactKeys(
      file,
      ["path", "byteLength", "sha256", "canonicalBase64"],
      `environment.files[${index}]`,
    );
    const path = safePath(file.path, `environment.files[${index}].path`);
    if (result.has(path)) fail(`duplicate revision path ${path}`);
    const bytes = decodeBase64(file.canonicalBase64, path);
    exact(
      integer(file.byteLength, 1, `${path}.byteLength`),
      bytes.length,
      `${path}.byteLength`,
    );
    exact(
      digest(file.sha256, `${path}.sha256`),
      sha256(bytes),
      `${path}.sha256`,
    );
    result.set(path, bytes);
  }
  return result;
};
const parseCanonicalFile = (files, path) => {
  const bytes = files.get(path);
  if (bytes === undefined) fail(`missing revision file ${path}`);
  const value = parseJson(bytes, path);
  exact(
    bytes.toString("utf8"),
    `${canonicalJson(value)}\n`,
    `${path} canonical bytes`,
  );
  return value;
};
const parsePackageJsonFile = (files, path) => {
  const bytes = files.get(path);
  if (bytes === undefined) fail(`missing revision file ${path}`);
  return parseJson(bytes, path);
};
const declarations = (manifest) => ({
  entities: new Map(
    manifest.entityTypes.map((entry) => [entry.entityTypeId, entry]),
  ),
  states: new Map(
    manifest.stateDomains.map((entry) => [entry.stateDomainId, entry]),
  ),
  events: new Map(
    manifest.eventTypes.map((entry) => [entry.eventTypeId, entry]),
  ),
  schemas: new Map(manifest.schemas.map((entry) => [entry.schemaId, entry])),
});
const walkRefs = (value, visit) => {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value))
    return value.forEach((child) => walkRefs(child, visit));
  if (value.$type === "entity_ref") visit(value);
  Object.values(value).forEach((child) => walkRefs(child, visit));
};
const replay = (manifest, records, expectedExecution, label) => {
  if (!Array.isArray(records) || records.length < 9)
    fail(`${label} has fewer than 9 records`);
  const declared = declarations(manifest);
  const active = new Map();
  const previous = new Map();
  let clock;
  let next = 0;
  const validateRef = (ref) => {
    const item = object(ref, `${label}.entityRef`);
    if (item.schemaVersion !== 2 || item.executionId !== expectedExecution)
      fail(`${label} entity ref crossed Execution`);
    const state = active.get(item.entityId);
    if (state === undefined || state.incarnation !== item.incarnation)
      fail(`${label} stale or inactive entity ref`);
    return state;
  };
  for (const raw of records) {
    const record = object(raw, `${label}.record`);
    if (
      record.schemaVersion !== 2 ||
      record.executionId !== expectedExecution ||
      record.recordSequence !== next
    )
      fail(`${label} sequence/Execution binding failed`);
    next += 1;
    const currentClock = object(record.clock, `${label}.clock`);
    for (const key of ["processFrame", "physicsTick", "simulationTimeUs"]) {
      integer(currentClock[key], 0, `${label}.clock.${key}`);
      if (clock !== undefined && currentClock[key] < clock[key])
        fail(`${label} clock moved backwards`);
    }
    clock = currentClock;
    const payload = object(record.payload, `${label}.payload`);
    if (record.kind === "entity_lifecycle") {
      const declaration = declared.entities.get(payload.entityTypeId);
      if (declaration === undefined) fail(`${label} undeclared entity type`);
      const ref = object(payload.entity, `${label}.lifecycle.entity`);
      if (ref.executionId !== expectedExecution)
        fail(`${label} lifecycle crossed Execution`);
      const prior = previous.get(ref.entityId);
      if (payload.phase === "appeared") {
        if (
          active.has(ref.entityId) ||
          ref.incarnation !== (prior === undefined ? 1 : prior.incarnation + 1)
        )
          fail(`${label} invalid incarnation transition`);
        if (
          payload.identityScope !== declaration.identityStrategy ||
          payload.projection === null
        )
          fail(`${label} lifecycle declaration mismatch`);
        const state = {
          incarnation: ref.incarnation,
          entityTypeId: payload.entityTypeId,
        };
        active.set(ref.entityId, state);
        previous.set(ref.entityId, state);
      } else {
        const state = validateRef(ref);
        if (state.entityTypeId !== payload.entityTypeId)
          fail(`${label} entity type drift`);
        if (payload.phase === "disappeared") {
          if (payload.projection !== null)
            fail(`${label} disappeared projection is nonnull`);
          active.delete(ref.entityId);
        }
      }
    } else if (
      record.kind === "state_sample" ||
      record.kind === "adapter_event"
    ) {
      const isState = record.kind === "state_sample";
      const declaration = isState
        ? declared.states.get(payload.stateDomainId)
        : declared.events.get(payload.eventTypeId);
      if (declaration === undefined) fail(`${label} undeclared state/event`);
      const scope = isState ? declaration.subject : declaration.source;
      const ref = isState ? payload.subjectEntity : payload.sourceEntity;
      if ((scope.kind === "project") !== (ref === null))
        fail(`${label} project/entity scope mismatch`);
      if (ref !== null) {
        const state = validateRef(ref);
        if (!scope.allowedEntityTypeIds.includes(state.entityTypeId))
          fail(`${label} entity type is outside scope allowlist`);
      }
      walkRefs(payload.value, validateRef);
    } else if (record.kind === "capture_loss")
      fail(`${label} declares capture loss`);
  }
  const traces = manifest.smoke.requiredDynamicTraces.map((required) => {
    for (const entityId of previous.keys()) {
      const values = records.filter((record) => {
        const ref =
          record.kind === "entity_lifecycle"
            ? record.payload.entity
            : record.kind === "state_sample"
              ? record.payload.subjectEntity
              : record.kind === "adapter_event"
                ? record.payload.sourceEntity
                : null;
        return ref?.entityId === entityId;
      });
      let p = 0;
      let inc = 0;
      let first = 0;
      let firstState = "";
      const seq = [];
      for (const record of values) {
        const ref =
          record.kind === "entity_lifecycle"
            ? record.payload.entity
            : record.kind === "state_sample"
              ? record.payload.subjectEntity
              : record.kind === "adapter_event"
                ? record.payload.sourceEntity
                : null;
        const appeared =
          record.kind === "entity_lifecycle" &&
          record.payload.phase === "appeared" &&
          record.payload.entityTypeId === required.entityTypeId;
        const disappeared =
          record.kind === "entity_lifecycle" &&
          record.payload.phase === "disappeared";
        const state =
          record.kind === "state_sample" &&
          record.payload.stateDomainId === required.stateDomainId;
        const event =
          record.kind === "adapter_event" &&
          record.payload.eventTypeId === required.eventTypeId;
        const take = () => {
          seq.push(record.recordSequence);
          p += 1;
        };
        if (p === 0 && appeared) {
          first = ref.incarnation;
          inc = first;
          take();
        } else if ((p === 1 || p === 6) && state && ref.incarnation === inc) {
          firstState = canonicalJson(record.payload.value);
          take();
        } else if ((p === 2 || p === 7) && event && ref.incarnation === inc)
          take();
        else if (
          (p === 3 || p === 8) &&
          state &&
          ref.incarnation === inc &&
          canonicalJson(record.payload.value) !== firstState
        )
          take();
        else if (p === 4 && disappeared && ref.incarnation === inc) take();
        else if (p === 5 && appeared && ref.incarnation === inc + 1) {
          inc = ref.incarnation;
          take();
        }
        if (p === 9 && inc === first + 1)
          return {
            schemaVersion: 2,
            traceId: required.traceId,
            entityId,
            firstIncarnation: first,
            lastIncarnation: inc,
            recordSequences: seq,
          };
      }
    }
    return fail(`${label} required dynamic trace was not found`);
  });
  return traces;
};
const validateCapture = (session, manifest, label) => {
  const capture = object(session.capture, `${label}.capture`);
  const payload = object(capture.payload, `${label}.capture.payload`);
  if (payload.schemaVersion !== 2 || payload.observationProtocolVersion !== 2)
    fail(`${label} capture is not V2`);
  const bytes = decodeBase64(
    capture.recordsCanonicalBase64,
    `${label}.capture.records`,
    16 * 1024 * 1024,
  );
  const records = parseJson(bytes, `${label}.capture.records`);
  exact(
    bytes.toString("utf8"),
    `${canonicalJson(records)}\n`,
    `${label}.capture canonical bytes`,
  );
  exact(payload.recordCount, records.length, `${label}.capture recordCount`);
  exact(
    payload.contentDigest,
    contentHash({
      schemaVersion: 1,
      files: [
        {
          path: "records.json",
          byteLength: bytes.length,
          sha256: sha256(bytes),
        },
      ],
    }),
    `${label}.capture contentDigest`,
  );
  exact(payload.taskId, session.taskId, `${label}.capture taskId`);
  exact(
    payload.executionId,
    session.runtime.executionId,
    `${label}.capture executionId`,
  );
  exact(payload.buildId, session.runtime.buildId, `${label}.capture buildId`);
  const traces = replay(
    manifest,
    records,
    payload.executionId,
    `${label}.capture.records`,
  );
  exact(payload.dynamicTraces, traces, `${label}.capture traces`);
  exact(session.runtime.dynamicTraces, traces, `${label}.runtime traces`);
  exact(
    session.compatibility.dynamicTraces,
    traces,
    `${label}.compatibility traces`,
  );
  if (
    session.runtime.outcome !== "succeeded" ||
    session.compatibility.outcome !== "compatible" ||
    session.runtime.loss.length !== 0 ||
    session.compatibility.failures.length !== 0
  )
    fail(`${label} runtime/compatibility did not succeed losslessly`);
  if (!session.runtime.captureWindowIds.includes(payload.captureWindowId))
    fail(`${label} runtime does not bind capture`);
  for (const coverage of [
    ...session.runtime.coverage,
    ...session.compatibility.coverage,
    ...payload.coverage,
  ])
    if (
      coverage.status !== "complete" ||
      coverage.droppedRecords !== 0 ||
      coverage.overwrittenRecords !== 0
    )
      fail(`${label} coverage is incomplete`);
  for (const key of [
    "processTreeTerminated",
    "runtimeExited",
    "bridgeExited",
    "isolationGroupEmpty",
    "scopeRemoved",
    "scratchRemoved",
    "storageReconciled",
  ])
    if (
      session.runtime.cleanup[key] !== true ||
      session.compatibility.cleanup[key] !== true
    )
      fail(`${label} cleanup is incomplete`);
  return {
    captureWindowId: payload.captureWindowId,
    executionId: payload.executionId,
    traces,
  };
};
const main = async () => {
  if (process.argv.length !== 4)
    fail("usage: validator schema.json evidence.json");
  const schemaBytes = await readPinnedRegular(
    resolve(process.argv[2]),
    MAX_SCHEMA_BYTES,
  );
  exact(sha256(schemaBytes), SCHEMA_RAW_SHA256, "frozen schema SHA-256");
  const schema = parseJson(schemaBytes, "schema");
  exact(schema.$id, SCHEMA_ID, "schema ID");
  const evidenceBytes = await readPinnedRegular(
    resolve(process.argv[3]),
    MAX_EVIDENCE_BYTES,
  );
  const evidence = object(parseJson(evidenceBytes, "evidence"), "evidence");
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
      "publication",
      "initializationAttempt",
      "first",
      "reuse",
      "limitations",
      "bundleContentHash",
    ],
    "evidence",
  );
  exact(evidence.schemaVersion, 2, "schemaVersion");
  exact(
    evidence.evidenceKind,
    "chronorift-project-environment-pe-b-evidence",
    "evidenceKind",
  );
  exact(
    evidence.evidenceProfile,
    "dynamic-projection-two-session-v2",
    "evidenceProfile",
  );
  const body = Object.fromEntries(
    Object.entries(evidence).filter(([key]) => key !== "bundleContentHash"),
  );
  exact(
    digest(evidence.bundleContentHash, "bundleContentHash"),
    contentHash(body),
    "bundle content hash",
  );
  const files = fileMap(evidence.environment);
  const manifest = parsePackageJsonFile(files, "adapter/manifest.json");
  exact(manifest, evidence.adapter.manifest, "adapter manifest");
  exact(manifest.schemaVersion, 2, "manifest schemaVersion");
  exact(manifest.sdk.version, 2, "SDK version");
  for (const declaration of manifest.schemas) {
    const bytes = files.get(`adapter/${declaration.path}`);
    if (bytes === undefined) fail(`missing adapter schema ${declaration.path}`);
    exact(sha256(bytes), declaration.sha256, `${declaration.path} sha256`);
  }
  const fileManifest = [...files]
    .map(([path, bytes]) => ({
      path,
      byteLength: bytes.length,
      sha256: sha256(bytes),
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
  exact(
    evidence.environment.revision.contentDigest,
    contentHash({ schemaVersion: 1, files: fileManifest }),
    "revision contentDigest",
  );
  const conformance = parseCanonicalFile(
    files,
    "records/conformance-receipt.v2.json",
  );
  const chain = parseCanonicalFile(
    files,
    "records/dynamic-projection-chain.v2.json",
  );
  const rawBytes = files.get("records/dynamic-projection-conformance.v2.json");
  if (rawBytes === undefined) fail("missing conformance raw chain");
  exact(
    sha256(rawBytes),
    conformance.rawObservationChainSha256,
    "conformance raw digest",
  );
  exact(
    chain.recordsSha256,
    conformance.rawObservationChainSha256,
    "chain receipt digest",
  );
  const raw = parseJson(rawBytes, "conformance raw chain");
  exact(
    rawBytes.toString("utf8"),
    `${canonicalJson(raw)}\n`,
    "conformance raw canonical bytes",
  );
  const conformanceTraces = replay(
    manifest,
    raw,
    chain.executionId,
    "conformance",
  );
  exact(chain.traces, conformanceTraces, "conformance chain traces");
  exact(
    conformance.dynamicTraces,
    conformanceTraces,
    "conformance receipt traces",
  );
  if (conformance.outcome !== "conformed" || chain.lossless !== true)
    fail("conformance is not lossless/conformed");
  const first = validateCapture(evidence.first, manifest, "first");
  const reuse = validateCapture(evidence.reuse, manifest, "reuse");
  if (
    evidence.first.taskId === evidence.reuse.taskId ||
    evidence.first.sessionId === evidence.reuse.sessionId ||
    first.executionId === reuse.executionId
  )
    fail("first/reuse are not independent Task/Session/Executions");
  if (
    evidence.reuse.reuseReceipt?.outcome !== "reused" ||
    evidence.reuse.reuseReceipt?.environmentRevisionId !==
      evidence.environment.revision.environmentRevisionId
  )
    fail("reuse receipt did not bind the exact revision");
  process.stdout.write(
    `${JSON.stringify({ schemaVersion: 2, bundleContentHash: evidence.bundleContentHash, environmentRevisionId: evidence.environment.revision.environmentRevisionId, adapterRevisionId: evidence.environment.revision.adapterRevisionId, firstExecutionId: first.executionId, reuseExecutionId: reuse.executionId, conformanceTraceIds: conformanceTraces.map((trace) => trace.traceId), firstCaptureWindowId: first.captureWindowId, reuseCaptureWindowId: reuse.captureWindowId })}\n`,
  );
};
await main();
