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
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const [
  freezeRecordPath,
  contractPath,
  interfacePath,
  ledgerPath,
  artifactRootPath,
  baselineRootPath,
  agentWorkspaceRootPath,
  evaluatorImplementationRootPath,
  evaluatorBundleRootPath,
  ...extra
] = process.argv.slice(2);

const fail = (message) => {
  throw new Error(`invalid vNext E2 evaluator ledger: ${message}`);
};

if (
  freezeRecordPath === undefined ||
  contractPath === undefined ||
  interfacePath === undefined ||
  ledgerPath === undefined ||
  artifactRootPath === undefined ||
  baselineRootPath === undefined ||
  agentWorkspaceRootPath === undefined ||
  evaluatorImplementationRootPath === undefined ||
  evaluatorBundleRootPath === undefined ||
  extra.length !== 0
) {
  fail(
    "expected FREEZE_RECORD EVALUATION_CONTRACT INTERFACE_SCHEMA EVALUATION_LEDGER ARTIFACT_ROOT BASELINE_SOURCE_ROOT AGENT_WORKSPACE_ROOT EVALUATOR_IMPLEMENTATION_ROOT EVALUATOR_BUNDLE_ROOT",
  );
}

const MAX_JSON_BYTES = 8 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
const MAX_TREE_FILES = 10_000;
const MAX_TREE_BYTES = 512 * 1024 * 1024;
const MAX_EVENT_BYTES = 1024 * 1024;
const MAX_EVENT_LEDGER_BYTES = 64 * 1024 * 1024;
// Measurement bounds keep malformed ledgers finite. Eligibility is evaluated
// separately against the frozen 1 GiB / 131072-inode aggregate Task budget so
// an over-budget assignment remains representable in the denominator.
const MAX_RETAINED_STORAGE_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_RETAINED_STORAGE_INODES = 1_048_576;
const TARGET_TAG = "vnext-e2-public-exposed-conformance-r2-freeze";
const RECORD_REPOSITORY_PATH =
  "docs/evidence/vnext-e2-public-exposed-r1/freeze-record.v1.json";
const CONTRACT_REPOSITORY_PATH =
  "testdata/vnext/external-project/moddable-platformer.e2-evaluation-contract.v1.json";
const INTERFACE_REPOSITORY_PATH =
  "testdata/vnext/external-project/e2-evaluator-interface.schema.v1.json";
const VALIDATOR_REPOSITORY_PATH =
  ".github/scripts/validate-vnext-e2-evaluator-ledger.mjs";
const REPOSITORY_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

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

const exact = (actual, expected, label) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${label} does not equal its required value`);
  }
};

const exactKeys = (value, keys, label) => {
  const actual = Object.keys(object(value, label)).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${label} contains a missing or unknown field`);
  }
};

const boundedInteger = (value, minimum, maximum, label) => {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
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

const stringPattern = (value, pattern, label) => {
  if (typeof value !== "string" || !pattern.test(value)) {
    fail(`${label} has an invalid identity`);
  }
  return value;
};

const digest = (value, label) => stringPattern(value, /^[a-f0-9]{64}$/u, label);
const opaqueId = (value, label) =>
  stringPattern(value, /^(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u, label);

const canonicalJson = (value) => {
  if (value === null || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      fail("canonical JSON contains a non-finite number");
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entry = object(value, "canonical JSON value");
  return `{${Object.keys(entry)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(entry[key])}`)
    .join(",")}}`;
};

const contentHash = (value) =>
  sha256(Buffer.from(canonicalJson(value), "utf8"));

const verifyOwnContentHash = (value, field, label) => {
  const entry = object(value, label);
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
    return bytes;
  } finally {
    await handle.close();
  }
};

const readJsonFile = async (path, label, maximumBytes = MAX_JSON_BYTES) => {
  const bytes = await readPinnedFile(path, label, maximumBytes);
  return { bytes, value: parseStrictJsonBytes(bytes, label) };
};

const readCanonicalJsonFile = async (
  path,
  label,
  maximumBytes = MAX_JSON_BYTES,
) => {
  const input = await readJsonFile(path, label, maximumBytes);
  const canonicalBytes = Buffer.from(`${canonicalJson(input.value)}\n`, "utf8");
  if (!Buffer.from(input.bytes).equals(canonicalBytes)) {
    fail(`${label} is not canonical JSON plus one LF`);
  }
  return input;
};

const safeRelativePath = (value, label) => {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 256 ||
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
  if (Buffer.from(value, "utf8").toString("utf8") !== value) {
    fail(`${label} is not valid UTF-8`);
  }
  return value;
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
    fail(`${label} has a non-canonical path`);
  }
  return { absolute, metadata };
};

const containedPath = (root, relativePath, label) => {
  const safe = safeRelativePath(relativePath, label);
  const candidate = resolve(root, ...safe.split("/"));
  const difference = relative(root, candidate);
  if (
    difference === "" ||
    difference === ".." ||
    difference.startsWith(`..${sep}`) ||
    resolve(root, difference) !== candidate
  ) {
    fail(`${label} escapes its artifact root`);
  }
  return candidate;
};

const treeSnapshots = new Map();

const validateArtifactReference = async (
  input,
  root,
  label,
  maximumBytes = MAX_ARTIFACT_BYTES,
) => {
  const reference = object(input, label);
  exactKeys(reference, ["relativePath", "rawSha256"], label);
  const path = containedPath(
    root,
    reference.relativePath,
    `${label}.relativePath`,
  );
  const snapshot = treeSnapshots.get(resolve(root));
  const snapshotEntry = snapshot?.get(reference.relativePath);
  if (snapshot !== undefined && snapshotEntry === undefined) {
    fail(`${label} does not exist in its frozen tree snapshot`);
  }
  const bytes =
    snapshotEntry?.bytes ?? (await readPinnedFile(path, label, maximumBytes));
  if (bytes.byteLength > maximumBytes) {
    fail(`${label} byte length is out of bounds`);
  }
  exact(
    sha256(bytes),
    digest(reference.rawSha256, `${label}.rawSha256`),
    label,
  );
  return { bytes: Buffer.from(bytes), path, reference };
};

const scanSelectedTree = async (rootPath, label, options = {}) => {
  const root = await openRoot(rootPath, label);
  const maximumFiles = options.maximumFiles ?? MAX_TREE_FILES;
  const maximumBytes = options.maximumBytes ?? MAX_TREE_BYTES;
  const entries = [];
  let totalBytes = 0;
  const walk = async (directory, prefix) => {
    const names = await readdir(directory);
    names.sort((left, right) =>
      Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")),
    );
    for (const name of names) {
      if (
        prefix.length === 0 &&
        options.skipSourceCaches === true &&
        (name === ".git" || name === ".godot")
      ) {
        continue;
      }
      const relativePath = prefix.length === 0 ? name : `${prefix}/${name}`;
      safeRelativePath(relativePath, `${label} entry`);
      const absolutePath = join(directory, name);
      const metadata = await lstat(absolutePath, { bigint: true });
      if (metadata.dev !== root.metadata.dev) {
        fail(`${label} crosses a filesystem boundary at ${relativePath}`);
      }
      if (metadata.isSymbolicLink()) {
        fail(`${label} contains a symbolic link at ${relativePath}`);
      }
      if (metadata.isDirectory()) {
        await walk(absolutePath, relativePath);
        continue;
      }
      if (!metadata.isFile() || metadata.nlink !== 1n) {
        fail(
          `${label} contains a non-regular or aliased file at ${relativePath}`,
        );
      }
      const bytes = Buffer.from(
        await readPinnedFile(
          absolutePath,
          `${label}/${relativePath}`,
          maximumBytes,
        ),
      );
      totalBytes += bytes.byteLength;
      if (entries.length >= maximumFiles || totalBytes > maximumBytes) {
        fail(`${label} exceeds its selected-tree bounds`);
      }
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
  treeSnapshots.set(
    root.absolute,
    new Map(entries.map((entry) => [entry.relativePath, entry])),
  );
  const finalRoot = await lstat(root.absolute, { bigint: true });
  if (
    !finalRoot.isDirectory() ||
    finalRoot.isSymbolicLink() ||
    finalRoot.dev !== root.metadata.dev ||
    finalRoot.ino !== root.metadata.ino ||
    finalRoot.mode !== root.metadata.mode ||
    finalRoot.mtimeNs !== root.metadata.mtimeNs ||
    finalRoot.ctimeNs !== root.metadata.ctimeNs ||
    (await realpath(root.absolute)) !== root.absolute
  ) {
    fail(`${label} changed during its selected-tree snapshot`);
  }
  return {
    root: root.absolute,
    entries,
    byteLength: totalBytes,
    sha256: hash.digest("hex"),
  };
};

const git = (args, options = {}) => {
  try {
    return execFileSync("git", args, {
      cwd: options.cwd ?? REPOSITORY_ROOT,
      input: options.input,
      encoding: options.encoding ?? null,
      maxBuffer: 128 * 1024 * 1024,
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        LANG: "C",
        LC_ALL: "C",
        HOME: options.cwd ?? REPOSITORY_ROOT,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
        GIT_ALLOW_PROTOCOL: "file",
      },
    });
  } catch (error) {
    fail(`${options.label ?? "Git operation"} failed: ${String(error)}`);
  }
};

const verifyAnchoredInputs = async (
  recordBytes,
  contractBytes,
  interfaceBytes,
  validatorInputBytes,
  recordValue,
) => {
  const tagRef = `refs/tags/${TARGET_TAG}`;
  exact(
    Buffer.from(git(["cat-file", "-t", tagRef], { encoding: "utf8" }))
      .toString()
      .trim(),
    "tag",
    "freeze anchor object type",
  );
  const anchorCommit = Buffer.from(
    git(["rev-parse", `${tagRef}^{commit}`], { encoding: "utf8" }),
  )
    .toString()
    .trim();
  const productCommit = stringPattern(
    recordValue.productSubject?.repositoryCommit,
    /^[a-f0-9]{40}$/u,
    "frozen product commit",
  );
  const productTree = Buffer.from(
    git(["show", "-s", "--format=%T", productCommit], { encoding: "utf8" }),
  )
    .toString()
    .trim();
  exact(
    productTree,
    recordValue.productSubject?.repositoryTree,
    "frozen product tree",
  );
  git(["merge-base", "--is-ancestor", productCommit, anchorCommit], {
    label: "freeze anchor product ancestry",
  });
  for (const [path, expected, label] of [
    [RECORD_REPOSITORY_PATH, recordBytes, "freeze record"],
    [CONTRACT_REPOSITORY_PATH, contractBytes, "evaluation contract"],
    [INTERFACE_REPOSITORY_PATH, interfaceBytes, "evaluator interface"],
    [
      VALIDATOR_REPOSITORY_PATH,
      validatorInputBytes,
      "evaluator ledger validator",
    ],
  ]) {
    const anchored = Buffer.from(git(["show", `${tagRef}:${path}`]));
    if (!anchored.equals(Buffer.from(expected))) {
      fail(`${label} does not match the annotated freeze anchor`);
    }
  }
  return "annotated_tag";
};

const recordInput = await readJsonFile(
  freezeRecordPath,
  "freeze record",
  131_072,
);
const contractInput = await readJsonFile(
  contractPath,
  "evaluation contract",
  131_072,
);
const interfaceInput = await readJsonFile(
  interfacePath,
  "evaluator interface",
  262_144,
);
const ledgerInput = await readCanonicalJsonFile(
  ledgerPath,
  "evaluation ledger",
);
const record = object(recordInput.value, "freeze record");
const contract = object(contractInput.value, "evaluation contract");
const evaluatorInterface = object(interfaceInput.value, "evaluator interface");
const ledger = object(ledgerInput.value, "evaluation ledger");
const contractSha256 = sha256(contractInput.bytes);
const interfaceSha256 = sha256(interfaceInput.bytes);
const validatorBytes = await readPinnedFile(
  fileURLToPath(import.meta.url),
  "evaluator ledger validator",
  2 * 1024 * 1024,
);

const anchorMode = await verifyAnchoredInputs(
  recordInput.bytes,
  contractInput.bytes,
  interfaceInput.bytes,
  validatorBytes,
  record,
);

exact(
  {
    schemaVersion: record.schemaVersion,
    recordKind: record.recordKind,
    recordTiming: record.recordTiming,
  },
  {
    schemaVersion: 1,
    recordKind: "chronorift-vnext-e2-post-gate-freeze",
    recordTiming: "post_gate",
  },
  "freeze record identity",
);
exact(record.freezeAnchor?.tagName, TARGET_TAG, "freeze anchor tag");
const frozenInterface = object(
  record.evaluationContract,
  "freeze record evaluation contract",
);
exact(contractSha256, frozenInterface.rawSha256, "frozen contract bytes");
exact(
  interfaceSha256,
  frozenInterface.interfaceSchemaRawSha256,
  "frozen interface bytes",
);
exact(
  sha256(validatorBytes),
  frozenInterface.messageValidatorRawSha256,
  "frozen ledger validator bytes",
);
exact(contract.schemaVersion, 1, "contract schema version");
exact(
  contract.contractKind,
  "chronorift-e2-external-evaluation-contract",
  "contract kind",
);
exact(
  contract.evaluationScope,
  {
    unit: "single_holdout_task_assignment",
    assignmentCount: 1,
    campaignAggregation: "out_of_scope",
    evaluationIdDeterministic: true,
    finalLedgerMultiplicity: "exactly_one",
  },
  "evaluation scope",
);
exact(
  contract.evaluatorInterface?.interfaceId,
  "chronorift-e2-external-evaluator-v1",
  "interface ID",
);
exact(
  contract.evaluatorInterface?.schemaRawSha256,
  interfaceSha256,
  "interface hash",
);
exact(
  contract.evaluatorInterface?.messageValidatorRawSha256,
  sha256(validatorBytes),
  "ledger validator hash",
);
exact(
  contract.evaluatorInterface?.productSubjectReceiptRequired,
  true,
  "product subject receipt requirement",
);
exact(
  evaluatorInterface.$id,
  "https://chronorift.invalid/eval/e2-external-evaluator-interface.v1.schema.json",
  "interface schema ID",
);

const agentBudget = object(contract.agentBudget, "Agent budget");
const evaluatorBudget = object(contract.evaluatorBudget, "evaluator budget");
const storageBudget = object(
  contract.sharedTaskStorageBudget,
  "shared storage budget",
);
const runtimeBudgets = object(contract.runtimeBudgets, "runtime budgets");
exact(agentBudget.attemptsMaximum, 1, "Agent attempt budget");
exact(agentBudget.turnsPerAttemptMaximum, 1, "Agent turn budget");
exact(
  agentBudget.piAgentAutoRetriesPerCycleMaximum,
  2,
  "Pi retry cycle budget",
);
exact(
  agentBudget.providerSdkRetriesPerCallMaximum,
  0,
  "provider SDK retry budget",
);
exact(evaluatorBudget.attemptsMaximum, 2, "evaluator attempt budget");
exact(
  evaluatorBudget.sameCandidateInfrastructureRetriesMaximum,
  1,
  "retry budget",
);
exact(storageBudget.scope, "single_evaluation_task_aggregate", "storage scope");
exact(runtimeBudgets.eventMaximum, 4096, "semantic event budget");

const artifactTree = await scanSelectedTree(
  artifactRootPath,
  "evaluation artifacts",
  {
    maximumFiles: 4096,
    maximumBytes: MAX_ARTIFACT_BYTES,
  },
);
const baselineTree = await scanSelectedTree(
  baselineRootPath,
  "baseline source",
  {
    skipSourceCaches: true,
  },
);
const workspaceTree = await scanSelectedTree(
  agentWorkspaceRootPath,
  "Agent workspace source",
  { skipSourceCaches: true },
);
const evaluatorImplementationTree = await scanSelectedTree(
  evaluatorImplementationRootPath,
  "evaluator implementation",
  { maximumFiles: 4096, maximumBytes: MAX_ARTIFACT_BYTES },
);
const evaluatorBundleTree = await scanSelectedTree(
  evaluatorBundleRootPath,
  "evaluator bundle",
  { maximumFiles: 4096, maximumBytes: MAX_ARTIFACT_BYTES },
);

const inputRoots = [
  ["evaluation artifacts", artifactTree.root],
  ["baseline source", baselineTree.root],
  ["Agent workspace source", workspaceTree.root],
  ["evaluator implementation", evaluatorImplementationTree.root],
  ["evaluator bundle", evaluatorBundleTree.root],
];
for (const [index, [leftLabel, leftRoot]] of inputRoots.entries()) {
  for (const [rightLabel, rightRoot] of inputRoots.slice(index + 1)) {
    const leftToRight = relative(leftRoot, rightRoot);
    const rightToLeft = relative(rightRoot, leftRoot);
    const rightInsideLeft =
      leftToRight === "" ||
      (leftToRight !== ".." && !leftToRight.startsWith(`..${sep}`));
    const leftInsideRight =
      rightToLeft === "" ||
      (rightToLeft !== ".." && !rightToLeft.startsWith(`..${sep}`));
    if (rightInsideLeft || leftInsideRight) {
      fail(`${leftLabel} and ${rightLabel} roots overlap`);
    }
  }
}

exact(
  baselineTree.sha256,
  contract.externalSource?.selectedTreeSha256,
  "frozen baseline selected tree",
);

const readArtifactJson = async (reference, label) => {
  const artifact = await validateArtifactReference(
    reference,
    artifactTree.root,
    label,
    MAX_JSON_BYTES,
  );
  const value = parseStrictJsonBytes(artifact.bytes, label);
  const canonical = Buffer.from(`${canonicalJson(value)}\n`, "utf8");
  if (!artifact.bytes.equals(canonical)) {
    fail(`${label} is not canonical JSON plus one LF`);
  }
  return { ...artifact, value: object(value, label) };
};

const readBundleArtifact = (reference, label) =>
  validateArtifactReference(
    reference,
    evaluatorBundleTree.root,
    label,
    MAX_ARTIFACT_BYTES,
  );

exactKeys(
  ledger,
  [
    "schemaVersion",
    "messageKind",
    "assignmentContentSha256",
    "assignmentId",
    "evaluationId",
    "contractSha256",
    "taskSpec",
    "prompt",
    "productCommit",
    "productSubjectReceipt",
    "baselineSourceSha256",
    "agentAttempt",
    "agentAttemptReceipt",
    "evaluatorImplementationSha256",
    "evaluatorBundleSha256",
    "evaluationArtifactsSha256",
    "evaluatorAttempts",
    "finalOutcome",
    "allAttemptsRetained",
    "ledgerContentSha256",
  ],
  "evaluation ledger",
);
exact(ledger.schemaVersion, 1, "ledger schema version");
exact(ledger.messageKind, "evaluation_ledger", "ledger kind");
verifyOwnContentHash(ledger, "ledgerContentSha256", "evaluation ledger");
exact(ledger.contractSha256, contractSha256, "ledger contract");
exact(
  ledger.productCommit,
  contract.productSubject?.repositoryCommit,
  "ledger product commit",
);
exact(
  ledger.baselineSourceSha256,
  baselineTree.sha256,
  "ledger baseline source",
);
exact(
  ledger.evaluatorImplementationSha256,
  evaluatorImplementationTree.sha256,
  "evaluator implementation tree",
);
exact(
  ledger.evaluatorBundleSha256,
  evaluatorBundleTree.sha256,
  "evaluator bundle tree",
);
exact(
  ledger.evaluationArtifactsSha256,
  artifactTree.sha256,
  "evaluation artifact tree",
);
exact(ledger.allAttemptsRetained, true, "all-attempt retention");

const taskSpecArtifact = await readArtifactJson(ledger.taskSpec, "task spec");
const promptArtifact = await validateArtifactReference(
  ledger.prompt,
  artifactTree.root,
  "prompt",
  1024 * 1024,
);
decodeUtf8(promptArtifact.bytes, "prompt");
const taskSpec = taskSpecArtifact.value;
exactKeys(
  taskSpec,
  [
    "schemaVersion",
    "specKind",
    "curatorTaskKeySha256",
    "productCommit",
    "baselineSourceSha256",
    "promptSha256",
    "scenarioPlanSha256",
    "scenarios",
  ],
  "task spec",
);
exact(taskSpec.schemaVersion, 1, "task spec schema version");
exact(taskSpec.specKind, "chronorift-e2-holdout-task", "task spec kind");
digest(taskSpec.curatorTaskKeySha256, "curator Task key");
exact(taskSpec.productCommit, ledger.productCommit, "task spec product");
exact(taskSpec.baselineSourceSha256, baselineTree.sha256, "task spec baseline");
exact(taskSpec.promptSha256, sha256(promptArtifact.bytes), "task spec prompt");
const scenarios = boundedArray(
  taskSpec.scenarios,
  1,
  evaluatorBudget.scenarioCountMaximum,
  "task scenarios",
);
const scenarioIds = [];
const scenarioSourceRoles = [];
for (const [index, input] of scenarios.entries()) {
  const scenario = object(input, `scenario ${index + 1}`);
  exactKeys(
    scenario,
    [
      "scenarioId",
      "ordinal",
      "category",
      "sourceRole",
      "definition",
      "timeoutMs",
    ],
    `scenario ${index + 1}`,
  );
  exact(scenario.ordinal, index + 1, `scenario ${index + 1} ordinal`);
  if (!["behavior", "regression"].includes(scenario.category)) {
    fail(`scenario ${index + 1} has an invalid category`);
  }
  if (!["baseline", "candidate"].includes(scenario.sourceRole)) {
    fail(`scenario ${index + 1} has an invalid source role`);
  }
  boundedInteger(
    scenario.timeoutMs,
    1,
    evaluatorBudget.wallTimeMsPerAttemptMaximum,
    `scenario ${index + 1} timeout`,
  );
  const definition = await readBundleArtifact(
    scenario.definition,
    `scenario ${index + 1} definition`,
  );
  const expectedScenarioId = `scenario:${sha256(
    Buffer.concat([
      Buffer.from("chronorift-e2-scenario-id-v1\0", "utf8"),
      Buffer.from(definition.reference.rawSha256, "utf8"),
    ]),
  ).slice(0, 24)}`;
  exact(scenario.scenarioId, expectedScenarioId, `scenario ${index + 1} ID`);
  scenarioIds.push(scenario.scenarioId);
  scenarioSourceRoles.push(scenario.sourceRole);
}
if (new Set(scenarioIds).size !== scenarioIds.length) {
  fail("scenario plan contains duplicate IDs");
}
if (!scenarioSourceRoles.includes("candidate")) {
  fail("scenario plan does not exercise the candidate source");
}
const scenarioPlanSha256 = contentHash({ schemaVersion: 1, scenarios });
exact(taskSpec.scenarioPlanSha256, scenarioPlanSha256, "scenario plan hash");

const assignmentBasis = {
  schemaVersion: 1,
  contractSha256,
  productCommit: ledger.productCommit,
  baselineSourceSha256: baselineTree.sha256,
  taskSpecSha256: taskSpecArtifact.reference.rawSha256,
  promptSha256: promptArtifact.reference.rawSha256,
  scenarioPlanSha256,
  evaluatorImplementationSha256: evaluatorImplementationTree.sha256,
  evaluatorBundleSha256: evaluatorBundleTree.sha256,
};
const assignmentContentSha256 = contentHash(assignmentBasis);
exact(
  ledger.assignmentContentSha256,
  assignmentContentSha256,
  "assignment content hash",
);
const assignmentId = `e2-assignment:${sha256(
  Buffer.from(
    `chronorift-e2-assignment-id-v1\0${assignmentContentSha256}`,
    "utf8",
  ),
).slice(0, 24)}`;
const evaluationId = `e2-evaluation:${sha256(
  Buffer.from(
    `chronorift-e2-evaluation-id-v1\0${assignmentContentSha256}`,
    "utf8",
  ),
).slice(0, 24)}`;
exact(ledger.assignmentId, assignmentId, "assignment ID");
exact(ledger.evaluationId, evaluationId, "evaluation ID");

const productSubjectArtifact = await readArtifactJson(
  ledger.productSubjectReceipt,
  "product subject receipt",
);
const productSubjectReceipt = productSubjectArtifact.value;
exactKeys(
  productSubjectReceipt,
  [
    "schemaVersion",
    "receiptKind",
    "assignmentContentSha256",
    "assignmentId",
    "evaluationId",
    "repositoryCommit",
    "repositoryTree",
    "productInterfaces",
    "receiptContentSha256",
  ],
  "product subject receipt",
);
exact(productSubjectReceipt.schemaVersion, 1, "product receipt schema version");
exact(
  productSubjectReceipt.receiptKind,
  "product_subject_checkout",
  "product receipt kind",
);
exact(
  productSubjectReceipt.assignmentContentSha256,
  assignmentContentSha256,
  "product receipt assignment hash",
);
exact(
  productSubjectReceipt.assignmentId,
  assignmentId,
  "product receipt assignment",
);
exact(
  productSubjectReceipt.evaluationId,
  evaluationId,
  "product receipt evaluation",
);
exact(
  productSubjectReceipt.repositoryCommit,
  record.productSubject.repositoryCommit,
  "product receipt commit",
);
exact(
  productSubjectReceipt.repositoryTree,
  record.productSubject.repositoryTree,
  "product receipt tree",
);
exact(
  productSubjectReceipt.productInterfaces,
  record.productInterfaces,
  "product receipt interface inventory",
);
verifyOwnContentHash(
  productSubjectReceipt,
  "receiptContentSha256",
  "product subject receipt",
);

const commonIdentity = (value, label) => {
  exact(value.assignmentId, assignmentId, `${label} assignment`);
  exact(value.evaluationId, evaluationId, `${label} evaluation`);
  exact(value.contractSha256, contractSha256, `${label} contract`);
  exact(
    value.taskSpecSha256,
    taskSpecArtifact.reference.rawSha256,
    `${label} task spec`,
  );
  exact(
    value.promptSha256,
    promptArtifact.reference.rawSha256,
    `${label} prompt`,
  );
};

const validateCleanupReceipt = async (
  reference,
  expectedScope,
  ordinal,
  label,
) => {
  const artifact = await readArtifactJson(reference, label);
  const receipt = artifact.value;
  exactKeys(
    receipt,
    [
      "schemaVersion",
      "receiptKind",
      "assignmentId",
      "evaluationId",
      "scope",
      "attemptOrdinal",
      "taskProcessesEmpty",
      "taskCgroupsEmpty",
      "taskStorageEmpty",
      "sourceUnchanged",
      "receiptContentSha256",
    ],
    label,
  );
  exact(receipt.schemaVersion, 1, `${label} schema version`);
  exact(receipt.receiptKind, "evaluation_cleanup", `${label} kind`);
  exact(receipt.assignmentId, assignmentId, `${label} assignment`);
  exact(receipt.evaluationId, evaluationId, `${label} evaluation`);
  exact(receipt.scope, expectedScope, `${label} scope`);
  exact(receipt.attemptOrdinal, ordinal, `${label} ordinal`);
  for (const field of [
    "taskProcessesEmpty",
    "taskCgroupsEmpty",
    "taskStorageEmpty",
    "sourceUnchanged",
  ]) {
    if (typeof receipt[field] !== "boolean")
      fail(`${label}.${field} is not boolean`);
  }
  verifyOwnContentHash(receipt, "receiptContentSha256", label);
  return receipt;
};

const cleanupProven = (receipt) =>
  receipt.taskProcessesEmpty === true &&
  receipt.taskCgroupsEmpty === true &&
  receipt.taskStorageEmpty === true &&
  receipt.sourceUnchanged === true;

const validateAgentUsage = (usageInput) => {
  const usage = object(usageInput, "Agent usage");
  exactKeys(
    usage,
    [
      "provider",
      "model",
      "thinkingLevel",
      "attemptOrdinal",
      "turnCount",
      "hostMonotonicStartMs",
      "hostMonotonicEndMs",
      "totalToolCalls",
      "gameToolCalls",
      "piAgentAutoRetryCount",
      "piAgentAutoRetriesMaximumInOneCycle",
      "providerSdkRetriesPerCallConfiguredMaximum",
      "maxObservedAggregateStorageBytes",
      "maxObservedAggregateStorageInodes",
      "taskSandboxNetworkMode",
      "hostModelNetworkAuthorization",
      "gitRemoteMode",
      "loopStatus",
    ],
    "Agent usage",
  );
  for (const field of ["provider", "model", "thinkingLevel"]) {
    exact(usage[field], agentBudget[field], `Agent usage ${field}`);
  }
  exact(usage.attemptOrdinal, 1, "Agent attempt ordinal");
  exact(usage.turnCount, 1, "Agent turn count");
  const start = boundedInteger(
    usage.hostMonotonicStartMs,
    0,
    Number.MAX_SAFE_INTEGER,
    "Agent start time",
  );
  const end = boundedInteger(
    usage.hostMonotonicEndMs,
    0,
    Number.MAX_SAFE_INTEGER,
    "Agent end time",
  );
  if (end < start) fail("Agent Host monotonic bounds are reversed");
  boundedInteger(usage.totalToolCalls, 0, 1_000_000, "Agent tool calls");
  boundedInteger(usage.gameToolCalls, 0, 1_000_000, "Agent game tool calls");
  if (usage.gameToolCalls > usage.totalToolCalls) {
    fail("Agent game tool calls exceed total tool calls");
  }
  boundedInteger(usage.piAgentAutoRetryCount, 0, 1_000_000, "Pi auto retries");
  boundedInteger(
    usage.piAgentAutoRetriesMaximumInOneCycle,
    0,
    agentBudget.piAgentAutoRetriesPerCycleMaximum,
    "Pi retries in one cycle",
  );
  exact(
    usage.providerSdkRetriesPerCallConfiguredMaximum,
    agentBudget.providerSdkRetriesPerCallMaximum,
    "provider SDK retry configuration",
  );
  boundedInteger(
    usage.maxObservedAggregateStorageBytes,
    0,
    MAX_RETAINED_STORAGE_BYTES,
    "Agent observed storage bytes",
  );
  boundedInteger(
    usage.maxObservedAggregateStorageInodes,
    0,
    MAX_RETAINED_STORAGE_INODES,
    "Agent observed storage inodes",
  );
  for (const field of [
    "taskSandboxNetworkMode",
    "hostModelNetworkAuthorization",
    "gitRemoteMode",
  ]) {
    exact(usage[field], agentBudget[field], `Agent usage ${field}`);
  }
  if (
    !["completed", "provider_failed", "aborted", "timed_out"].includes(
      usage.loopStatus,
    )
  ) {
    fail("Agent loop status is unsupported");
  }
  return { usage, durationMs: end - start };
};

const agentArtifact = await readArtifactJson(
  ledger.agentAttemptReceipt,
  "Agent attempt receipt",
);
const agent = object(ledger.agentAttempt, "Agent attempt");
exact(agent, agentArtifact.value, "embedded Agent attempt receipt");
exactKeys(
  agent,
  [
    "schemaVersion",
    "receiptKind",
    "assignmentContentSha256",
    "assignmentId",
    "evaluationId",
    "contractSha256",
    "taskSpecSha256",
    "promptSha256",
    "baselineSourceSha256",
    "outcome",
    "workspaceSourceSha256",
    "workspacePatch",
    "candidateSourceSha256",
    "candidatePatch",
    "usage",
    "cleanupReceipt",
    "receiptContentSha256",
  ],
  "Agent attempt",
);
exact(agent.schemaVersion, 1, "Agent receipt schema version");
exact(agent.receiptKind, "agent_attempt", "Agent receipt kind");
exact(
  agent.assignmentContentSha256,
  assignmentContentSha256,
  "Agent assignment hash",
);
commonIdentity(agent, "Agent attempt");
exact(agent.baselineSourceSha256, baselineTree.sha256, "Agent baseline source");
exact(
  agent.workspaceSourceSha256,
  workspaceTree.sha256,
  "Agent workspace source",
);
verifyOwnContentHash(agent, "receiptContentSha256", "Agent attempt");
const workspacePatch = await validateArtifactReference(
  agent.workspacePatch,
  artifactTree.root,
  "Agent workspace patch",
  8 * 1024 * 1024,
);
const agentCleanup = await validateCleanupReceipt(
  agent.cleanupReceipt,
  "agent_attempt",
  1,
  "Agent cleanup receipt",
);
const { usage: agentUsage, durationMs: agentDurationMs } = validateAgentUsage(
  agent.usage,
);

const agentOutcomes = [
  "candidate_produced",
  "provider_failed",
  "aborted",
  "timed_out",
  "no_candidate",
  "budget_exceeded",
  "sandbox_failed",
  "patch_handoff_failed",
];
if (!agentOutcomes.includes(agent.outcome))
  fail("Agent outcome is unsupported");
const loopStatusByOutcome = {
  candidate_produced: "completed",
  provider_failed: "provider_failed",
  aborted: "aborted",
  timed_out: "timed_out",
  no_candidate: "completed",
  budget_exceeded: "completed",
  sandbox_failed: "completed",
  patch_handoff_failed: "completed",
};
exact(
  agentUsage.loopStatus,
  loopStatusByOutcome[agent.outcome],
  "Agent loop/outcome binding",
);
const agentBudgetExceeded =
  agentDurationMs > agentBudget.wallTimeMsPerAttemptMaximum ||
  agentUsage.totalToolCalls > agentBudget.totalToolCallsPerAttemptMaximum ||
  agentUsage.gameToolCalls > agentBudget.gameToolCallsPerAttemptMaximum ||
  agentUsage.piAgentAutoRetryCount >
    agentBudget.piAgentAutoRetriesTotalEligibilityMaximum ||
  agentUsage.maxObservedAggregateStorageBytes > storageBudget.bytesMaximum ||
  agentUsage.maxObservedAggregateStorageInodes > storageBudget.inodesMaximum;
if (agent.outcome === "budget_exceeded") {
  exact(agentBudgetExceeded, true, "Agent budget-exceeded evidence");
} else {
  exact(agentBudgetExceeded, false, "Agent eligibility budget");
}

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

const verifyPatchRoundTrip = async (patchBytes, expectedCandidateHash) => {
  if (patchBytes.byteLength === 0) fail("candidate patch is empty");
  const patchText = decodeUtf8(patchBytes, "candidate patch");
  if (!patchText.includes("diff --git "))
    fail("candidate patch is not a Git binary diff");
  const indexLines = [
    ...patchText.matchAll(/^index ([a-f0-9]+)\.\.([a-f0-9]+)(?: |$)/gmu),
  ];
  if (indexLines.length === 0) {
    fail("candidate patch has no full-index object identity");
  }
  for (const match of indexLines) {
    if (match[1].length !== 40 || match[2].length !== 40) {
      fail("candidate patch does not use full-index object IDs");
    }
  }
  const root = await mkdtemp(join(tmpdir(), "chronorift-e2-roundtrip-"));
  try {
    await copyTreeEntries(baselineTree.entries, root);
    git(["init", "--quiet"], { cwd: root, label: "patch round-trip init" });
    git(["config", "core.hooksPath", "/dev/null"], {
      cwd: root,
      label: "patch round-trip config",
    });
    git(["config", "core.autocrlf", "false"], {
      cwd: root,
      label: "patch round-trip line-ending config",
    });
    git(["config", "core.filemode", "true"], {
      cwd: root,
      label: "patch round-trip file-mode config",
    });
    git(["config", "user.name", "ChronoRift evaluator"], {
      cwd: root,
      label: "patch round-trip author config",
    });
    git(["config", "user.email", "evaluator@chronorift.invalid"], {
      cwd: root,
      label: "patch round-trip author config",
    });
    git(["add", "--all"], { cwd: root, label: "patch round-trip index" });
    git(["commit", "--quiet", "-m", "frozen baseline"], {
      cwd: root,
      label: "patch round-trip baseline commit",
    });
    git(["apply", "--check", "--binary", "--index", "-"], {
      cwd: root,
      input: patchBytes,
      label: "candidate patch check",
    });
    git(["apply", "--binary", "--index", "-"], {
      cwd: root,
      input: patchBytes,
      label: "candidate patch apply",
    });
    const regenerated = Buffer.from(
      git(
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
        { cwd: root, label: "candidate patch regeneration" },
      ),
    );
    if (!regenerated.equals(patchBytes)) {
      fail("candidate patch is not the exact reproducible full-index diff");
    }
    const changedPaths = Buffer.from(
      git(
        ["diff", "--cached", "--name-only", "-z", "--no-renames", "HEAD", "--"],
        { cwd: root, label: "candidate patch path inventory" },
      ),
    )
      .toString("utf8")
      .split("\0")
      .filter((entry) => entry.length > 0);
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
        fail("candidate patch changes a reserved or unselected project path");
      }
      if (unsupportedSuffixes.some((suffix) => normalized.endsWith(suffix))) {
        fail("candidate patch adds an unsupported native project source");
      }
    }
    const realized = await scanSelectedTree(root, "round-trip candidate", {
      skipSourceCaches: true,
    });
    exact(realized.sha256, expectedCandidateHash, "candidate patch round-trip");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

let candidatePatch;
if (agent.outcome === "candidate_produced") {
  if (agent.candidateSourceSha256 === null || agent.candidatePatch === null) {
    fail("candidate-produced Agent outcome is missing candidate identity");
  }
  exact(
    agent.candidateSourceSha256,
    workspaceTree.sha256,
    "candidate/workspace selected tree",
  );
  if (workspaceTree.sha256 === baselineTree.sha256) {
    fail("candidate-produced outcome did not change the source tree");
  }
  candidatePatch = await validateArtifactReference(
    agent.candidatePatch,
    artifactTree.root,
    "candidate patch",
    8 * 1024 * 1024,
  );
  exact(
    agent.candidatePatch,
    agent.workspacePatch,
    "candidate/workspace patch reference",
  );
  exact(
    candidatePatch.bytes,
    workspacePatch.bytes,
    "candidate/workspace patch bytes",
  );
  if (!cleanupProven(agentCleanup)) {
    fail("candidate-produced Agent attempt lacks proven cleanup");
  }
  await verifyPatchRoundTrip(candidatePatch.bytes, workspaceTree.sha256);
} else {
  exact(agent.candidateSourceSha256, null, "non-candidate source identity");
  exact(agent.candidatePatch, null, "non-candidate patch identity");
  if (agent.outcome === "no_candidate") {
    exact(
      workspaceTree.sha256,
      baselineTree.sha256,
      "no-candidate source tree",
    );
    exact(workspacePatch.bytes.byteLength, 0, "no-candidate patch bytes");
    if (!cleanupProven(agentCleanup))
      fail("no-candidate attempt lacks proven cleanup");
  }
}

const runtimeResourceDigest = (taskIdValue, kind, resourceId) =>
  sha256(
    Buffer.from(
      `chronorift-vnext-runtime-resource-v1\0${taskIdValue}\0${kind}\0${resourceId}`,
      "utf8",
    ),
  );

const runtimeResourceRecords = new Map();

const validateResourceEnvelope = async (
  reference,
  expectedKind,
  expectedTaskId,
  expectedResourceId,
  label,
) => {
  const artifact = await readArtifactJson(reference, label);
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
  exact(envelope.taskId, expectedTaskId, `${label} Task`);
  exact(envelope.resourceKind, expectedKind, `${label} kind`);
  exact(envelope.resourceId, expectedResourceId, `${label} resource ID`);
  const expectedDigest = runtimeResourceDigest(
    expectedTaskId,
    expectedKind,
    expectedResourceId,
  );
  exact(envelope.resourceDigest, expectedDigest, `${label} resource digest`);
  exact(
    envelope.payloadHash,
    contentHash(envelope.payload),
    `${label} payload hash`,
  );
  const { recordHash, ...recordBasis } = envelope;
  exact(recordHash, contentHash(recordBasis), `${label} record hash`);
  const resourceKey = `${expectedTaskId}\0${expectedKind}\0${expectedResourceId}`;
  const previousRecordHash = runtimeResourceRecords.get(resourceKey);
  if (previousRecordHash !== undefined) {
    exact(
      recordHash,
      previousRecordHash,
      `${label} create-once resource identity`,
    );
  } else {
    runtimeResourceRecords.set(resourceKey, recordHash);
  }
  return {
    artifact,
    envelope,
    payload: object(envelope.payload, `${label} payload`),
  };
};

const validateBuildPayload = (
  payload,
  taskIdValue,
  buildId,
  candidateSourceHash,
) => {
  exactKeys(
    payload,
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
    "build payload",
  );
  exact(payload.schemaVersion, 1, "build schema version");
  exact(payload.taskId, taskIdValue, "build Task");
  opaqueId(payload.workspaceId, "build workspace");
  exact(payload.sourceId, `source:${candidateSourceHash}`, "build source ID");
  exact(payload.buildId, buildId, "build ID");
  exact(payload.sourceHash, candidateSourceHash, "build source hash");
  exact(
    payload.workspaceDiffHash,
    contentHash({
      schemaVersion: 1,
      baselineSourceHash: baselineTree.sha256,
      candidateSourceHash,
    }),
    "build workspace diff hash",
  );
  for (const field of ["buildConfigurationHash", "outputHash"]) {
    digest(payload[field], `build ${field}`);
  }
  if (
    typeof payload.createdAt !== "string" ||
    !Number.isFinite(Date.parse(payload.createdAt))
  ) {
    fail("build createdAt is invalid");
  }
  const expectedBuildId = `build:${contentHash({
    schemaVersion: 1,
    projectHash: payload.outputHash,
    buildConfigurationHash: payload.buildConfigurationHash,
    outputHash: payload.outputHash,
  })}`;
  exact(buildId, expectedBuildId, "semantic build identity");
};

const finiteNumber = (value, minimum, maximum, label) => {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum
  ) {
    fail(`${label} is outside its finite bounds`);
  }
  return value;
};

const semanticResourcePath = (value, label) => {
  if (
    typeof value !== "string" ||
    value.length < 7 ||
    value.length > 512 ||
    !value.startsWith("res://") ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.split("/").includes("..")
  ) {
    fail(`${label} is not a safe semantic resource path`);
  }
  return value;
};

const validateSemanticVector2 = (input, label) => {
  const value = object(input, label);
  exactKeys(value, ["x", "y"], label);
  finiteNumber(value.x, -Number.MAX_VALUE, Number.MAX_VALUE, `${label}.x`);
  finiteNumber(value.y, -Number.MAX_VALUE, Number.MAX_VALUE, `${label}.y`);
};

const validateSemanticClock = (input, label) => {
  const value = object(input, label);
  exactKeys(
    value,
    [
      "processFrame",
      "physicsTick",
      "simulationTimeUs",
      "hostMonotonicUs",
      "renderFrame",
    ],
    label,
  );
  for (const field of ["processFrame", "physicsTick", "simulationTimeUs"]) {
    boundedInteger(
      value[field],
      0,
      Number.MAX_SAFE_INTEGER,
      `${label}.${field}`,
    );
  }
  if (value.hostMonotonicUs !== null) {
    boundedInteger(
      value.hostMonotonicUs,
      0,
      Number.MAX_SAFE_INTEGER,
      `${label}.hostMonotonicUs`,
    );
  }
  exact(value.renderFrame, null, `${label}.renderFrame`);
};

const validateTimerSpawnProjection = (input, label) => {
  const projection = object(input, label);
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
  const subject = object(projection.subject, `${label}.subject`);
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
  boundedInteger(
    subject.incarnation,
    1,
    Number.MAX_SAFE_INTEGER,
    `${label} subject incarnation`,
  );
  exact(
    semanticResourcePath(subject.targetScene, `${label} subject target scene`),
    contract.semanticAdapter?.targetScene,
    `${label} subject target scene`,
  );
  finiteNumber(
    subject.spawnIntervalSeconds,
    1,
    600,
    `${label} subject spawn interval`,
  );
  semanticResourcePath(subject.spawnScene, `${label} subject spawn scene`);

  const timer = object(projection.timer, `${label}.timer`);
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
  exact(timer.stableId, "semantic:timer", `${label} timer stable ID`);
  boundedInteger(
    timer.incarnation,
    1,
    Number.MAX_SAFE_INTEGER,
    `${label} timer incarnation`,
  );
  finiteNumber(
    timer.waitTimeSeconds,
    0,
    Number.MAX_VALUE,
    `${label} timer wait time`,
  );
  finiteNumber(
    timer.timeLeftSeconds,
    0,
    Number.MAX_VALUE,
    `${label} timer time left`,
  );
  for (const field of [
    "paused",
    "stopped",
    "oneShot",
    "autostart",
    "ignoreTimeScale",
  ]) {
    if (typeof timer[field] !== "boolean") {
      fail(`${label} timer ${field} is not boolean`);
    }
  }
  if (!["physics", "idle"].includes(timer.processCallback)) {
    fail(`${label} timer process callback is invalid`);
  }
  boundedInteger(
    timer.timeoutOrdinal,
    0,
    Number.MAX_SAFE_INTEGER,
    `${label} timer timeout ordinal`,
  );

  const entities = boundedArray(
    projection.entities,
    0,
    runtimeBudgets.entityMaximum,
    `${label}.entities`,
  );
  const ordinals = [];
  for (const [index, inputEntity] of entities.entries()) {
    const entity = object(inputEntity, `${label}.entities[${index}]`);
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
    stringPattern(
      entity.stableId,
      /^semantic:spawn:[0-9]+$/u,
      `${label} entity ${index} stable ID`,
    );
    boundedInteger(
      entity.incarnation,
      1,
      Number.MAX_SAFE_INTEGER,
      `${label} entity ${index} incarnation`,
    );
    const ordinal = boundedInteger(
      entity.spawnOrdinal,
      0,
      Number.MAX_SAFE_INTEGER,
      `${label} entity ${index} spawn ordinal`,
    );
    ordinals.push(ordinal);
    semanticResourcePath(entity.scene, `${label} entity ${index} scene`);
    exact(
      entity.parentStableId,
      "semantic:harness",
      `${label} entity ${index} parent`,
    );
    const transform = object(
      entity.transform,
      `${label}.entities[${index}].transform`,
    );
    exactKeys(
      transform,
      ["position", "rotation", "scale"],
      `${label}.entities[${index}].transform`,
    );
    validateSemanticVector2(
      transform.position,
      `${label}.entities[${index}].transform.position`,
    );
    finiteNumber(
      transform.rotation,
      -Number.MAX_VALUE,
      Number.MAX_VALUE,
      `${label} entity ${index} rotation`,
    );
    validateSemanticVector2(
      transform.scale,
      `${label}.entities[${index}].transform.scale`,
    );
    if (typeof entity.visible !== "boolean") {
      fail(`${label} entity ${index} visibility is not boolean`);
    }
    boundedInteger(
      entity.processMode,
      0,
      4,
      `${label} entity ${index} process mode`,
    );
    if (entity.velocity !== null) {
      validateSemanticVector2(
        entity.velocity,
        `${label}.entities[${index}].velocity`,
      );
    }
  }
  if (new Set(ordinals).size !== ordinals.length) {
    fail(`${label} contains duplicate spawn ordinals`);
  }
  const nextSpawnOrdinal = boundedInteger(
    projection.nextSpawnOrdinal,
    0,
    Number.MAX_SAFE_INTEGER,
    `${label}.nextSpawnOrdinal`,
  );
  if (ordinals.some((ordinal) => ordinal >= nextSpawnOrdinal)) {
    fail(`${label} next spawn ordinal does not exceed captured entities`);
  }
  validateSemanticClock(projection.capturedAt, `${label}.capturedAt`);
};

const validateEventLedger = async (
  reference,
  taskIdValue,
  executionIdValue,
  label,
) => {
  const artifact = await validateArtifactReference(
    reference,
    artifactTree.root,
    label,
    Math.min(MAX_EVENT_LEDGER_BYTES, runtimeBudgets.rawSemanticBytesMaximum),
  );
  const text = decodeUtf8(artifact.bytes, label);
  if (artifact.bytes.byteLength > 0 && !text.endsWith("\n")) {
    fail(`${label} lacks its terminal LF`);
  }
  const lines = text.length === 0 ? [] : text.slice(0, -1).split("\n");
  if (lines.length > runtimeBudgets.eventMaximum) {
    fail(`${label} exceeds the semantic event budget`);
  }
  const events = [];
  let previousHash = null;
  let previousStartUs = 0;
  let previousEndUs = 0;
  for (const [index, line] of lines.entries()) {
    const lineBytes = Buffer.from(`${line}\n`, "utf8");
    if (lineBytes.byteLength > MAX_EVENT_BYTES)
      fail(`${label} line ${index} is oversized`);
    const value = object(
      parseStrictJsonBytes(Buffer.from(line, "utf8"), `${label} line ${index}`),
      `${label} line ${index}`,
    );
    if (canonicalJson(value) !== line)
      fail(`${label} line ${index} is not canonical JSON`);
    exactKeys(
      value,
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
      `${label} line ${index}`,
    );
    exact(value.schemaVersion, 1, `${label} line ${index} schema`);
    exact(value.taskId, taskIdValue, `${label} line ${index} Task`);
    exact(
      value.executionId,
      executionIdValue,
      `${label} line ${index} execution`,
    );
    exact(value.sequence, index, `${label} line ${index} sequence`);
    exact(
      value.previousHash,
      previousHash,
      `${label} line ${index} previous hash`,
    );
    const payload = object(value.payload, `${label} line ${index} payload`);
    exact(
      value.payloadHash,
      contentHash(payload),
      `${label} line ${index} payload hash`,
    );
    const { recordHash, ...recordBasis } = value;
    exact(
      recordHash,
      contentHash(recordBasis),
      `${label} line ${index} record hash`,
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
      `${label} line ${index} payload`,
    );
    exact(payload.schemaVersion, 1, `${label} line ${index} payload schema`);
    exact(
      payload.eventKind,
      "semantic_observation",
      `${label} line ${index} event kind`,
    );
    exact(payload.taskId, taskIdValue, `${label} line ${index} payload Task`);
    exact(
      payload.executionId,
      executionIdValue,
      `${label} line ${index} payload execution`,
    );
    exact(payload.sequence, index, `${label} line ${index} payload sequence`);
    opaqueId(payload.runtimeId, `${label} line ${index} runtime`);
    opaqueId(payload.buildId, `${label} line ${index} build`);
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
      fail(`${label} line ${index} source is invalid`);
    }
    const start = boundedInteger(
      payload.hostMonotonicStartUs,
      0,
      Number.MAX_SAFE_INTEGER,
      `${label} line ${index} start`,
    );
    const end = boundedInteger(
      payload.hostMonotonicEndUs,
      0,
      Number.MAX_SAFE_INTEGER,
      `${label} line ${index} end`,
    );
    if (end < start) fail(`${label} line ${index} Host bounds are reversed`);
    if (index > 0 && (start < previousStartUs || end < previousEndUs)) {
      fail(`${label} line ${index} Host bounds are not monotonic`);
    }
    validateTimerSpawnProjection(
      payload.projection,
      `${label} line ${index} projection`,
    );
    exact(
      payload.projectionSha256,
      contentHash(payload.projection),
      `${label} line ${index} projection hash`,
    );
    previousHash = value.recordHash;
    previousStartUs = start;
    previousEndUs = end;
    events.push({ envelope: value, payload });
  }
  return { artifact, events };
};

const validateSemanticCoverageAndLoss = (coverageInput, lossInput, label) => {
  const coverage = boundedArray(coverageInput, 1, 5, `${label} coverage`);
  const loss = boundedArray(lossInput, 0, 64, `${label} loss`);
  const coverageChannels = new Set();
  for (const [index, input] of coverage.entries()) {
    const entry = object(input, `${label} coverage ${index}`);
    exactKeys(
      entry,
      ["channel", "status", "emittedRecords", "droppedRecords", "limitations"],
      `${label} coverage ${index}`,
    );
    if (
      !["clock", "state", "entity_lifecycle", "log", "error"].includes(
        entry.channel,
      )
    ) {
      fail(`${label} coverage ${index} channel is invalid`);
    }
    if (coverageChannels.has(entry.channel)) {
      fail(`${label} coverage contains duplicate channels`);
    }
    coverageChannels.add(entry.channel);
    if (!["full", "partial", "unavailable"].includes(entry.status)) {
      fail(`${label} coverage ${index} status is invalid`);
    }
    boundedInteger(
      entry.emittedRecords,
      0,
      Number.MAX_SAFE_INTEGER,
      `${label} coverage ${index} emitted records`,
    );
    boundedInteger(
      entry.droppedRecords,
      0,
      Number.MAX_SAFE_INTEGER,
      `${label} coverage ${index} dropped records`,
    );
    const limitations = boundedArray(
      entry.limitations,
      0,
      32,
      `${label} coverage ${index} limitations`,
    );
    for (const [limitationIndex, limitation] of limitations.entries()) {
      if (
        typeof limitation !== "string" ||
        limitation.length < 1 ||
        limitation.length > 4_096
      ) {
        fail(
          `${label} coverage ${index} limitation ${limitationIndex} is invalid`,
        );
      }
    }
    if (new Set(limitations).size !== limitations.length) {
      fail(`${label} coverage ${index} limitations contain duplicates`);
    }
    if (entry.status === "full" && entry.droppedRecords !== 0) {
      fail(`${label} full coverage reports dropped records`);
    }
    if (entry.status === "unavailable" && entry.emittedRecords !== 0) {
      fail(`${label} unavailable coverage reports emitted records`);
    }
  }
  for (const [index, input] of loss.entries()) {
    const entry = object(input, `${label} loss ${index}`);
    exactKeys(
      entry,
      ["channel", "kind", "count", "reason"],
      `${label} loss ${index}`,
    );
    if (
      typeof entry.channel !== "string" ||
      entry.channel.length < 1 ||
      entry.channel.length > 128
    ) {
      fail(`${label} loss ${index} channel is invalid`);
    }
    if (
      !["dropped", "truncated", "unavailable", "observer_effect"].includes(
        entry.kind,
      )
    ) {
      fail(`${label} loss ${index} kind is invalid`);
    }
    boundedInteger(
      entry.count,
      0,
      Number.MAX_SAFE_INTEGER,
      `${label} loss ${index} count`,
    );
    if (
      typeof entry.reason !== "string" ||
      entry.reason.length < 1 ||
      entry.reason.length > 4_096
    ) {
      fail(`${label} loss ${index} reason is invalid`);
    }
  }
  if (
    coverage.some((entry) => {
      const degraded = entry.status !== "full" || entry.droppedRecords > 0;
      return (
        degraded &&
        !loss.some((lossEntry) =>
          lossEntry.channel.split("/").includes(entry.channel),
        )
      );
    })
  ) {
    fail(`${label} degraded coverage lacks a channel-bound loss record`);
  }
  return {
    lossObserved:
      loss.length > 0 ||
      coverage.some(
        (entry) => entry.status !== "full" || entry.droppedRecords > 0,
      ),
  };
};

const referencedRuntimePathsByAttempt = new Map();

const registerRuntimeArtifactReferences = (
  reference,
  attemptOrdinal,
  label,
) => {
  const prefix = `runtime/${attemptOrdinal}/`;
  let paths = referencedRuntimePathsByAttempt.get(attemptOrdinal);
  if (paths === undefined) {
    paths = new Set();
    referencedRuntimePathsByAttempt.set(attemptOrdinal, paths);
  }
  for (const field of [
    "buildRecord",
    "runtimeRecord",
    "executionRecord",
    "eventLedger",
    "executionSeal",
  ]) {
    const artifactReference = object(reference[field], `${label}.${field}`);
    const relativePath = safeRelativePath(
      artifactReference.relativePath,
      `${label}.${field}.relativePath`,
    );
    if (!relativePath.startsWith(prefix)) {
      fail(`${label}.${field} is outside evaluator attempt ${attemptOrdinal}`);
    }
    paths.add(relativePath);
  }
};

const runtimeArtifactPathsForAttempt = (attemptOrdinal) => {
  const prefix = `runtime/${attemptOrdinal}/`;
  return artifactTree.entries
    .map((entry) => entry.relativePath)
    .filter((relativePath) => relativePath.startsWith(prefix))
    .sort();
};

const validateClosedRuntimeArtifactSet = (attemptOrdinal, label) => {
  const actual = runtimeArtifactPathsForAttempt(attemptOrdinal);
  const referenced = [
    ...(referencedRuntimePathsByAttempt.get(attemptOrdinal) ?? new Set()),
  ].sort();
  exact(actual, referenced, `${label} runtime artifact closure`);
};

const validateExecutionArtifact = async (
  input,
  expectedCandidateHash,
  attemptOrdinal,
  label,
) => {
  const reference = object(input, label);
  exactKeys(
    reference,
    [
      "runtimeTaskId",
      "buildId",
      "runtimeId",
      "executionId",
      "buildRecord",
      "runtimeRecord",
      "executionRecord",
      "eventLedger",
      "executionSeal",
    ],
    label,
  );
  registerRuntimeArtifactReferences(reference, attemptOrdinal, label);
  const runtimeTaskId = opaqueId(
    reference.runtimeTaskId,
    `${label} runtime Task`,
  );
  const buildId = opaqueId(reference.buildId, `${label} build`);
  const runtimeId = opaqueId(reference.runtimeId, `${label} runtime`);
  const executionId = opaqueId(reference.executionId, `${label} execution`);
  const build = await validateResourceEnvelope(
    reference.buildRecord,
    "build",
    runtimeTaskId,
    buildId,
    `${label} build record`,
  );
  validateBuildPayload(
    build.payload,
    runtimeTaskId,
    buildId,
    expectedCandidateHash,
  );
  const runtime = await validateResourceEnvelope(
    reference.runtimeRecord,
    "runtime",
    runtimeTaskId,
    runtimeId,
    `${label} runtime record`,
  );
  exactKeys(
    runtime.payload,
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
    `${label} runtime payload`,
  );
  exact(runtime.payload.schemaVersion, 1, `${label} runtime schema`);
  exact(
    runtime.payload.runtimeKind,
    "godot_external_semantic",
    `${label} runtime kind`,
  );
  exact(runtime.payload.taskId, runtimeTaskId, `${label} runtime Task`);
  exact(runtime.payload.runtimeId, runtimeId, `${label} runtime ID`);
  exact(runtime.payload.executionId, executionId, `${label} runtime execution`);
  exact(runtime.payload.buildId, buildId, `${label} runtime build`);
  opaqueId(runtime.payload.adapterId, `${label} runtime adapter`);
  exact(
    runtime.payload.adapterProfileSha256,
    contract.semanticAdapter?.profileCanonicalSha256,
    `${label} adapter profile`,
  );
  if (!["stopped", "crashed", "failed"].includes(runtime.payload.status)) {
    fail(`${label} runtime status is invalid`);
  }
  exact(
    runtime.payload.finalProjectionSha256,
    contentHash(runtime.payload.finalProjection),
    `${label} final projection hash`,
  );
  const runtimeCapture = validateSemanticCoverageAndLoss(
    runtime.payload.coverage,
    runtime.payload.loss,
    `${label} runtime`,
  );
  exact(runtime.payload.cleanupProven, true, `${label} runtime cleanup`);
  const execution = await validateResourceEnvelope(
    reference.executionRecord,
    "execution",
    runtimeTaskId,
    executionId,
    `${label} execution record`,
  );
  exactKeys(
    execution.payload,
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
    `${label} execution payload`,
  );
  exact(execution.payload.schemaVersion, 1, `${label} execution schema`);
  exact(
    execution.payload.executionKind,
    "godot_external_semantic",
    `${label} execution kind`,
  );
  exact(execution.payload.taskId, runtimeTaskId, `${label} execution Task`);
  exact(execution.payload.executionId, executionId, `${label} execution ID`);
  exact(execution.payload.runtimeId, runtimeId, `${label} execution runtime`);
  exact(
    execution.payload.sourceId,
    build.payload.sourceId,
    `${label} execution source`,
  );
  exact(
    execution.payload.workspaceId,
    build.payload.workspaceId,
    `${label} execution workspace`,
  );
  exact(execution.payload.buildId, buildId, `${label} execution build`);
  exact(
    execution.payload.adapterId,
    runtime.payload.adapterId,
    `${label} adapter ID`,
  );
  exact(
    execution.payload.adapterProfileSha256,
    runtime.payload.adapterProfileSha256,
    `${label} adapter profile`,
  );
  exact(
    execution.payload.targetScene,
    contract.semanticAdapter?.targetScene,
    `${label} target scene`,
  );
  exact(
    execution.payload.stateSchemaVersion,
    "chronorift.timer-spawn:v1",
    `${label} state schema`,
  );
  exact(execution.payload.fidelity, "descriptive_only", `${label} fidelity`);
  exact(
    execution.payload.equivalentForkEligible,
    false,
    `${label} fork eligibility`,
  );
  validateSemanticCoverageAndLoss(
    execution.payload.coverage,
    execution.payload.loss,
    `${label} execution`,
  );
  exact(
    execution.payload.coverage,
    runtime.payload.coverage,
    `${label} runtime/execution coverage`,
  );
  exact(
    execution.payload.loss,
    runtime.payload.loss,
    `${label} runtime/execution loss`,
  );
  const eventLedger = await validateEventLedger(
    reference.eventLedger,
    runtimeTaskId,
    executionId,
    `${label} event ledger`,
  );
  for (const [index, event] of eventLedger.events.entries()) {
    exact(
      event.payload.runtimeId,
      runtimeId,
      `${label} event ${index} runtime`,
    );
    exact(event.payload.buildId, buildId, `${label} event ${index} build`);
  }
  const sealArtifact = await readArtifactJson(
    reference.executionSeal,
    `${label} execution seal`,
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
    `${label} execution seal`,
  );
  exact(seal.schemaVersion, 1, `${label} seal schema`);
  exact(seal.taskId, runtimeTaskId, `${label} seal Task`);
  exact(seal.executionId, executionId, `${label} seal execution`);
  exact(seal.count, eventLedger.events.length, `${label} seal count`);
  exact(
    seal.headHash,
    eventLedger.events.at(-1)?.envelope.recordHash ?? null,
    `${label} seal head`,
  );
  exact(
    seal.byteLength,
    eventLedger.artifact.bytes.byteLength,
    `${label} seal bytes`,
  );
  exact(
    seal.contentHash,
    sha256(eventLedger.artifact.bytes),
    `${label} seal content`,
  );
  exact(
    execution.payload.eventCount,
    seal.count,
    `${label} execution event count`,
  );
  exact(
    execution.payload.executionSeal,
    seal,
    `${label} embedded execution seal`,
  );
  if (eventLedger.events.length > 0) {
    exact(
      runtime.payload.finalProjection,
      eventLedger.events.at(-1).payload.projection,
      `${label} final projection lineage`,
    );
  }
  const eventSources = eventLedger.events.map((event) => event.payload.source);
  if (eventSources.length === 0) {
    fail(`${label} has no authoritative semantic observation event`);
  }
  const hasCompleteLifecycle =
    eventSources.length >= 2 &&
    eventSources[0] === "ready" &&
    eventSources.at(-1) === "shutdown";
  if (!hasCompleteLifecycle && !runtimeCapture.lossObserved) {
    fail(`${label} incomplete lifecycle lacks explicit capture loss`);
  }
  return {
    runtimeStatus: runtime.payload.status,
    executionId,
    eventSources,
    lifecycleComplete: hasCompleteLifecycle,
    lossObserved: runtimeCapture.lossObserved || !hasCompleteLifecycle,
  };
};

const validateEvaluatorUsage = (input, label) => {
  const usage = object(input, label);
  exactKeys(
    usage,
    [
      "hostMonotonicStartMs",
      "hostMonotonicEndMs",
      "maxObservedAggregateStorageBytes",
      "maxObservedAggregateStorageInodes",
    ],
    label,
  );
  const start = boundedInteger(
    usage.hostMonotonicStartMs,
    0,
    Number.MAX_SAFE_INTEGER,
    `${label} start`,
  );
  const end = boundedInteger(
    usage.hostMonotonicEndMs,
    0,
    Number.MAX_SAFE_INTEGER,
    `${label} end`,
  );
  if (end < start) fail(`${label} Host monotonic bounds are reversed`);
  boundedInteger(
    usage.maxObservedAggregateStorageBytes,
    0,
    MAX_RETAINED_STORAGE_BYTES,
    `${label} storage bytes`,
  );
  boundedInteger(
    usage.maxObservedAggregateStorageInodes,
    0,
    MAX_RETAINED_STORAGE_INODES,
    `${label} storage inodes`,
  );
  return {
    budgetExceeded:
      end - start > evaluatorBudget.wallTimeMsPerAttemptMaximum ||
      usage.maxObservedAggregateStorageBytes > storageBudget.bytesMaximum ||
      usage.maxObservedAggregateStorageInodes > storageBudget.inodesMaximum,
  };
};

const executionIdentities = new Set();
const validateScenarioResults = async (
  inputs,
  outcome,
  candidateHash,
  attemptOrdinal,
  label,
) => {
  const results = boundedArray(
    inputs,
    scenarioIds.length,
    scenarioIds.length,
    label,
  );
  let failedIndex = -1;
  for (const [index, input] of results.entries()) {
    const result = object(input, `${label}[${index}]`);
    exactKeys(
      result,
      [
        "scenarioId",
        "outcome",
        "failureKind",
        "notRunReason",
        "executionArtifacts",
        "coverage",
        "lossObserved",
      ],
      `${label}[${index}]`,
    );
    exact(result.scenarioId, scenarioIds[index], `${label}[${index}] scenario`);
    const executions = boundedArray(
      result.executionArtifacts,
      0,
      16,
      `${label}[${index}] executions`,
    );
    if (result.outcome === "passed") {
      exact(result.failureKind, null, `${label}[${index}] failure kind`);
      exact(result.notRunReason, null, `${label}[${index}] not-run reason`);
      exact(result.coverage, "complete", `${label}[${index}] coverage`);
      if (typeof result.lossObserved !== "boolean") {
        fail(`${label}[${index}] loss is invalid`);
      }
      if (executions.length < 1) fail(`${label}[${index}] has no execution`);
    } else if (result.outcome === "failed") {
      if (
        !["oracle_mismatch", "candidate_execution_failure"].includes(
          result.failureKind,
        )
      ) {
        fail(`${label}[${index}] failure kind is invalid`);
      }
      exact(result.notRunReason, null, `${label}[${index}] not-run reason`);
      if (!["complete", "degraded"].includes(result.coverage)) {
        fail(`${label}[${index}] failed coverage is invalid`);
      }
      if (typeof result.lossObserved !== "boolean")
        fail(`${label}[${index}] loss is invalid`);
      if (executions.length < 1)
        fail(`${label}[${index}] failed without an execution`);
      if (failedIndex !== -1)
        fail(`${label} contains multiple decisive failures`);
      failedIndex = index;
    } else if (result.outcome === "not_run") {
      exact(result.failureKind, null, `${label}[${index}] failure kind`);
      exact(executions.length, 0, `${label}[${index}] execution count`);
      exact(result.coverage, "unavailable", `${label}[${index}] coverage`);
      exact(result.lossObserved, false, `${label}[${index}] loss`);
    } else {
      fail(`${label}[${index}] outcome is invalid`);
    }
    const validatedExecutions = [];
    for (const [executionIndex, executionInput] of executions.entries()) {
      const validated = await validateExecutionArtifact(
        executionInput,
        scenarioSourceRoles[index] === "baseline"
          ? baselineTree.sha256
          : candidateHash,
        attemptOrdinal,
        `${label}[${index}] execution ${executionIndex}`,
      );
      const identity = `${object(executionInput, "execution reference").runtimeTaskId}\0${validated.executionId}`;
      if (executionIdentities.has(identity))
        fail("one Execution is reused across scenario results");
      executionIdentities.add(identity);
      validatedExecutions.push(validated);
      if (result.outcome === "passed") {
        exact(
          validated.runtimeStatus,
          "stopped",
          `${label}[${index}] runtime status`,
        );
        exact(
          validated.lifecycleComplete,
          true,
          `${label}[${index}] passed execution lifecycle`,
        );
      }
    }
    if (validatedExecutions.length > 0) {
      exact(
        result.lossObserved,
        validatedExecutions.some((entry) => entry.lossObserved),
        `${label}[${index}] realized loss`,
      );
      if (result.outcome === "failed") {
        if (result.failureKind === "oracle_mismatch") {
          for (const validated of validatedExecutions) {
            exact(
              validated.runtimeStatus,
              "stopped",
              `${label}[${index}] oracle-mismatch runtime status`,
            );
            exact(
              validated.lifecycleComplete,
              true,
              `${label}[${index}] oracle-mismatch execution lifecycle`,
            );
          }
        } else {
          exact(
            result.coverage,
            "degraded",
            `${label}[${index}] failed execution coverage`,
          );
          for (const validated of validatedExecutions) {
            if (!["crashed", "failed"].includes(validated.runtimeStatus)) {
              fail(
                `${label}[${index}] candidate execution failure has a non-failed runtime`,
              );
            }
          }
        }
      }
    }
  }
  if (outcome === "accepted") {
    for (const [index, result] of results.entries()) {
      exact(result.outcome, "passed", `${label}[${index}] accepted outcome`);
    }
  } else if (outcome === "rejected") {
    if (failedIndex < 0) fail(`${label} has no decisive failed scenario`);
    if (scenarioSourceRoles[failedIndex] !== "candidate") {
      fail(
        `${label} treats a baseline scenario failure as candidate rejection`,
      );
    }
    for (const [index, result] of results.entries()) {
      if (index < failedIndex)
        exact(result.outcome, "passed", `${label}[${index}] prefix outcome`);
      if (index === failedIndex)
        exact(result.outcome, "failed", `${label}[${index}] decisive outcome`);
      if (index > failedIndex) {
        exact(
          result.outcome,
          "not_run",
          `${label}[${index}] fail-fast outcome`,
        );
        exact(
          result.notRunReason,
          "fail_fast",
          `${label}[${index}] fail-fast reason`,
        );
      }
    }
  } else if (outcome === "invalid_candidate") {
    for (const [index, result] of results.entries()) {
      exact(
        result.outcome,
        "not_run",
        `${label}[${index}] invalid-candidate outcome`,
      );
      exact(
        result.notRunReason,
        "invalid_candidate",
        `${label}[${index}] invalid-candidate reason`,
      );
    }
  }
  return results;
};

const validateCompletedInfrastructureResults = async (
  inputs,
  candidateHash,
  attemptOrdinal,
  label,
) => {
  const results = boundedArray(inputs, 0, scenarioIds.length, label);
  let executionCount = 0;
  for (const [index, input] of results.entries()) {
    const result = object(input, `${label}[${index}]`);
    exactKeys(
      result,
      [
        "scenarioId",
        "outcome",
        "failureKind",
        "notRunReason",
        "executionArtifacts",
        "coverage",
        "lossObserved",
      ],
      `${label}[${index}]`,
    );
    exact(result.scenarioId, scenarioIds[index], `${label}[${index}] scenario`);
    exact(result.outcome, "passed", `${label}[${index}] completed outcome`);
    exact(result.failureKind, null, `${label}[${index}] failure kind`);
    exact(result.notRunReason, null, `${label}[${index}] not-run reason`);
    exact(result.coverage, "complete", `${label}[${index}] coverage`);
    if (typeof result.lossObserved !== "boolean") {
      fail(`${label}[${index}] loss is invalid`);
    }
    const executions = boundedArray(
      result.executionArtifacts,
      1,
      16,
      `${label}[${index}] executions`,
    );
    let scenarioLossObserved = false;
    for (const [executionIndex, executionInput] of executions.entries()) {
      const validated = await validateExecutionArtifact(
        executionInput,
        scenarioSourceRoles[index] === "baseline"
          ? baselineTree.sha256
          : candidateHash,
        attemptOrdinal,
        `${label}[${index}] execution ${executionIndex}`,
      );
      const identity = `${object(executionInput, "execution reference").runtimeTaskId}\0${validated.executionId}`;
      if (executionIdentities.has(identity)) {
        fail("one Execution is reused across evaluator attempts or scenarios");
      }
      executionIdentities.add(identity);
      exact(
        validated.runtimeStatus,
        "stopped",
        `${label}[${index}] runtime status`,
      );
      exact(
        validated.lifecycleComplete,
        true,
        `${label}[${index}] execution lifecycle`,
      );
      scenarioLossObserved ||= validated.lossObserved;
      executionCount += 1;
    }
    exact(
      result.lossObserved,
      scenarioLossObserved,
      `${label}[${index}] realized loss`,
    );
  }
  return { results, executionCount };
};

const attempts = boundedArray(
  ledger.evaluatorAttempts,
  0,
  evaluatorBudget.attemptsMaximum,
  "evaluator attempts",
);
for (const entry of artifactTree.entries) {
  if (!entry.relativePath.startsWith("runtime/")) continue;
  const match = /^runtime\/([1-2])\//u.exec(entry.relativePath);
  if (match === null) {
    fail("runtime artifact has no bounded evaluator-attempt namespace");
  }
  const attemptOrdinal = Number(match[1]);
  if (attemptOrdinal > attempts.length) {
    fail("runtime artifact belongs to an evaluator attempt that did not run");
  }
}

const commonEvaluatorIdentity = (value, label) => {
  commonIdentity(value, label);
  exact(
    value.candidateSourceSha256,
    agent.candidateSourceSha256,
    `${label} candidate source`,
  );
  exact(
    value.candidatePatchSha256,
    candidatePatch?.reference.rawSha256,
    `${label} candidate patch`,
  );
  exact(
    value.evaluatorImplementationSha256,
    evaluatorImplementationTree.sha256,
    `${label} evaluator implementation`,
  );
  exact(
    value.evaluatorBundleSha256,
    evaluatorBundleTree.sha256,
    `${label} evaluator bundle`,
  );
};

let previousResultHash = null;
let retryAuthorized = false;
let lastOutcome;
for (const [index, attemptInput] of attempts.entries()) {
  const ordinal = index + 1;
  if (ordinal === 2 && !retryAuthorized) {
    fail("evaluator attempt 2 lacks a retryable zero-progress predecessor");
  }
  const attempt = object(attemptInput, `evaluator attempt ${ordinal}`);
  exactKeys(
    attempt,
    ["request", "requestReceipt", "result", "resultReceipt"],
    `evaluator attempt ${ordinal}`,
  );
  const requestArtifact = await readArtifactJson(
    attempt.requestReceipt,
    `evaluator attempt ${ordinal} request receipt`,
  );
  exact(
    attempt.request,
    requestArtifact.value,
    `evaluator attempt ${ordinal} embedded request`,
  );
  const request = object(
    attempt.request,
    `evaluator attempt ${ordinal} request`,
  );
  exactKeys(
    request,
    [
      "schemaVersion",
      "messageKind",
      "assignmentContentSha256",
      "assignmentId",
      "evaluationId",
      "contractSha256",
      "taskSpecSha256",
      "promptSha256",
      "productCommit",
      "baselineSourceSha256",
      "candidateSourceSha256",
      "candidatePatchSha256",
      "evaluatorImplementationSha256",
      "evaluatorBundleSha256",
      "plannedScenarioIds",
      "agentAttemptReceipt",
      "agentAttemptOrdinal",
      "evaluatorAttemptOrdinal",
      "previousResultContentSha256",
      "requestContentSha256",
    ],
    `evaluator attempt ${ordinal} request`,
  );
  exact(
    request.schemaVersion,
    1,
    `evaluator attempt ${ordinal} request schema`,
  );
  exact(
    request.messageKind,
    "evaluation_request",
    `evaluator attempt ${ordinal} request kind`,
  );
  exact(
    request.assignmentContentSha256,
    assignmentContentSha256,
    `evaluator attempt ${ordinal} assignment hash`,
  );
  commonEvaluatorIdentity(request, `evaluator attempt ${ordinal} request`);
  exact(
    request.productCommit,
    ledger.productCommit,
    `evaluator attempt ${ordinal} product`,
  );
  exact(
    request.baselineSourceSha256,
    baselineTree.sha256,
    `evaluator attempt ${ordinal} baseline`,
  );
  exact(
    request.plannedScenarioIds,
    scenarioIds,
    `evaluator attempt ${ordinal} scenario plan`,
  );
  exact(
    request.agentAttemptReceipt,
    ledger.agentAttemptReceipt,
    `evaluator attempt ${ordinal} Agent receipt`,
  );
  exact(
    request.agentAttemptOrdinal,
    1,
    `evaluator attempt ${ordinal} Agent ordinal`,
  );
  exact(
    request.evaluatorAttemptOrdinal,
    ordinal,
    `evaluator attempt ${ordinal} ordinal`,
  );
  exact(
    request.previousResultContentSha256,
    previousResultHash,
    `evaluator attempt ${ordinal} previous result`,
  );
  const requestHash = verifyOwnContentHash(
    request,
    "requestContentSha256",
    `evaluator attempt ${ordinal} request`,
  );

  const resultArtifact = await readArtifactJson(
    attempt.resultReceipt,
    `evaluator attempt ${ordinal} result receipt`,
  );
  exact(
    attempt.result,
    resultArtifact.value,
    `evaluator attempt ${ordinal} embedded result`,
  );
  const result = object(attempt.result, `evaluator attempt ${ordinal} result`);
  exact(result.schemaVersion, 1, `evaluator attempt ${ordinal} result schema`);
  exact(
    result.messageKind,
    "evaluation_result",
    `evaluator attempt ${ordinal} result kind`,
  );
  commonEvaluatorIdentity(result, `evaluator attempt ${ordinal} result`);
  exact(
    result.evaluatorAttemptOrdinal,
    ordinal,
    `evaluator attempt ${ordinal} result ordinal`,
  );
  exact(
    result.requestContentSha256,
    requestHash,
    `evaluator attempt ${ordinal} request binding`,
  );
  const evaluatorUsageValidation = validateEvaluatorUsage(
    result.evaluatorUsage,
    `evaluator attempt ${ordinal} usage`,
  );
  const resultCleanup = await validateCleanupReceipt(
    result.cleanupReceipt,
    "evaluator_attempt",
    ordinal,
    `evaluator attempt ${ordinal} cleanup receipt`,
  );

  if (result.outcome === "infrastructure_failure") {
    exactKeys(
      result,
      [
        "schemaVersion",
        "messageKind",
        "assignmentId",
        "evaluationId",
        "contractSha256",
        "taskSpecSha256",
        "promptSha256",
        "candidateSourceSha256",
        "candidatePatchSha256",
        "evaluatorImplementationSha256",
        "evaluatorBundleSha256",
        "evaluatorAttemptOrdinal",
        "requestContentSha256",
        "outcome",
        "failureAttribution",
        "stage",
        "failureCode",
        "retryable",
        "completedScenarioResults",
        "remainingScenarioIds",
        "scenarioStartedCount",
        "oracleComparisonCount",
        "executionCount",
        "evaluatorUsage",
        "cleanupReceipt",
        "resultContentSha256",
      ],
      `evaluator attempt ${ordinal} infrastructure result`,
    );
    exact(
      result.failureAttribution,
      "host_or_evaluator_infrastructure",
      `evaluator attempt ${ordinal} attribution`,
    );
    if (
      ![
        "admission",
        "baseline_reproduction",
        "observation",
        "persistence",
        "cleanup",
        "evaluator_internal",
      ].includes(result.stage)
    )
      fail(`evaluator attempt ${ordinal} infrastructure stage is invalid`);
    if (
      ![
        "host_unavailable",
        "toolchain_unavailable",
        "sandbox_unavailable",
        "storage_unavailable",
        "cleanup_failed",
        "evaluator_internal",
        "evaluator_budget_exceeded",
      ].includes(result.failureCode)
    )
      fail(`evaluator attempt ${ordinal} infrastructure code is invalid`);
    exact(
      evaluatorUsageValidation.budgetExceeded,
      result.failureCode === "evaluator_budget_exceeded",
      `evaluator attempt ${ordinal} evaluator budget outcome`,
    );
    const completed = boundedArray(
      result.completedScenarioResults,
      0,
      scenarioIds.length,
      `evaluator attempt ${ordinal} completed scenarios`,
    );
    const remaining = boundedArray(
      result.remainingScenarioIds,
      0,
      scenarioIds.length,
      `evaluator attempt ${ordinal} remaining scenarios`,
    );
    const completedValidation = await validateCompletedInfrastructureResults(
      completed,
      agent.candidateSourceSha256,
      ordinal,
      `evaluator attempt ${ordinal} completed scenario results`,
    );
    exact(
      remaining,
      scenarioIds.slice(completed.length),
      `evaluator attempt ${ordinal} remaining suffix`,
    );
    boundedInteger(
      result.scenarioStartedCount,
      completed.length,
      Math.min(completed.length + 1, scenarioIds.length),
      `evaluator attempt ${ordinal} started scenarios`,
    );
    exact(
      result.oracleComparisonCount,
      completed.length,
      `evaluator attempt ${ordinal} oracle comparisons`,
    );
    exact(
      result.executionCount,
      completedValidation.executionCount,
      `evaluator attempt ${ordinal} execution count`,
    );
    if (result.retryable === true) {
      exact(ordinal, 1, "retryable evaluator attempt ordinal");
      exact(
        completed.length,
        0,
        "retryable infrastructure completed scenarios",
      );
      exact(
        remaining,
        scenarioIds,
        "retryable infrastructure remaining scenarios",
      );
      exact(
        result.scenarioStartedCount,
        0,
        "retryable infrastructure started scenarios",
      );
      exact(
        result.oracleComparisonCount,
        0,
        "retryable infrastructure oracle comparisons",
      );
      exact(result.executionCount, 0, "retryable infrastructure executions");
      validateClosedRuntimeArtifactSet(
        ordinal,
        `evaluator attempt ${ordinal} retryable infrastructure`,
      );
      if (!cleanupProven(resultCleanup))
        fail("retryable infrastructure lacks proven cleanup");
      if (result.failureCode === "cleanup_failed")
        fail("cleanup_failed cannot be retryable");
      if (result.failureCode === "evaluator_budget_exceeded")
        fail(
          "evaluator budget exhaustion cannot authorize a same-candidate retry",
        );
      if (attempts.length !== 2)
        fail("retryable infrastructure lacks its retained retry");
      retryAuthorized = true;
    } else {
      exact(
        result.retryable,
        false,
        `evaluator attempt ${ordinal} retryable flag`,
      );
      if (
        result.failureCode === "cleanup_failed" &&
        cleanupProven(resultCleanup)
      ) {
        fail("cleanup_failed contradicts a proven cleanup receipt");
      }
      retryAuthorized = false;
    }
    lastOutcome = "infrastructure_failure";
  } else {
    exactKeys(
      result,
      [
        "schemaVersion",
        "messageKind",
        "assignmentId",
        "evaluationId",
        "contractSha256",
        "taskSpecSha256",
        "promptSha256",
        "candidateSourceSha256",
        "candidatePatchSha256",
        "evaluatorImplementationSha256",
        "evaluatorBundleSha256",
        "evaluatorAttemptOrdinal",
        "requestContentSha256",
        "outcome",
        "invalidCandidateReason",
        "invalidCandidateReceipt",
        "scenarioResults",
        "evaluatorUsage",
        "cleanupReceipt",
        "resultContentSha256",
      ],
      `evaluator attempt ${ordinal} evaluated result`,
    );
    if (
      !["accepted", "rejected", "invalid_candidate"].includes(result.outcome)
    ) {
      fail(`evaluator attempt ${ordinal} result outcome is invalid`);
    }
    exact(
      evaluatorUsageValidation.budgetExceeded,
      false,
      `evaluator attempt ${ordinal} evaluated budget eligibility`,
    );
    if (!cleanupProven(resultCleanup))
      fail(`evaluator attempt ${ordinal} evaluated cleanup is not proven`);
    await validateScenarioResults(
      result.scenarioResults,
      result.outcome,
      agent.candidateSourceSha256,
      ordinal,
      `evaluator attempt ${ordinal} scenario results`,
    );
    validateClosedRuntimeArtifactSet(
      ordinal,
      `evaluator attempt ${ordinal} evaluated result`,
    );
    if (result.outcome === "invalid_candidate") {
      exact(
        result.invalidCandidateReason,
        "candidate_admission_rejected",
        `evaluator attempt ${ordinal} invalid-candidate reason`,
      );
      if (result.invalidCandidateReceipt === null) {
        fail(`evaluator attempt ${ordinal} lacks an invalid-candidate receipt`);
      }
      const admissionArtifact = await readArtifactJson(
        result.invalidCandidateReceipt,
        `evaluator attempt ${ordinal} invalid-candidate receipt`,
      );
      const admission = admissionArtifact.value;
      exactKeys(
        admission,
        [
          "schemaVersion",
          "receiptKind",
          "assignmentId",
          "evaluationId",
          "candidateSourceSha256",
          "candidatePatchSha256",
          "evaluatorImplementationSha256",
          "evaluatorBundleSha256",
          "status",
          "reason",
          "receiptContentSha256",
        ],
        `evaluator attempt ${ordinal} invalid-candidate receipt`,
      );
      exact(admission.schemaVersion, 1, "candidate admission schema version");
      exact(
        admission.receiptKind,
        "candidate_admission",
        "candidate admission kind",
      );
      exact(
        admission.assignmentId,
        assignmentId,
        "candidate admission assignment",
      );
      exact(
        admission.evaluationId,
        evaluationId,
        "candidate admission evaluation",
      );
      exact(
        admission.candidateSourceSha256,
        agent.candidateSourceSha256,
        "candidate admission source",
      );
      exact(
        admission.candidatePatchSha256,
        candidatePatch.reference.rawSha256,
        "candidate admission patch",
      );
      exact(
        admission.evaluatorImplementationSha256,
        evaluatorImplementationTree.sha256,
        "candidate admission evaluator implementation",
      );
      exact(
        admission.evaluatorBundleSha256,
        evaluatorBundleTree.sha256,
        "candidate admission evaluator bundle",
      );
      exact(admission.status, "rejected", "candidate admission status");
      exact(
        admission.reason,
        "candidate_admission_rejected",
        "candidate admission reason",
      );
      verifyOwnContentHash(
        admission,
        "receiptContentSha256",
        `evaluator attempt ${ordinal} invalid-candidate receipt`,
      );
    } else {
      exact(
        result.invalidCandidateReason,
        null,
        `evaluator attempt ${ordinal} invalid-candidate reason`,
      );
      exact(
        result.invalidCandidateReceipt,
        null,
        `evaluator attempt ${ordinal} invalid-candidate receipt`,
      );
    }
    lastOutcome = result.outcome;
    retryAuthorized = false;
  }
  previousResultHash = verifyOwnContentHash(
    result,
    "resultContentSha256",
    `evaluator attempt ${ordinal} result`,
  );
}

const finalOutcomeByAgentOutcome = {
  provider_failed: "agent_provider_failed",
  aborted: "agent_aborted",
  timed_out: "agent_timed_out",
  no_candidate: "agent_no_candidate",
  budget_exceeded: "agent_budget_exceeded",
  sandbox_failed: "agent_sandbox_failed",
  patch_handoff_failed: "agent_patch_handoff_failed",
};
if (agent.outcome === "candidate_produced") {
  if (attempts.length < 1)
    fail("candidate-produced assignment has no evaluator attempt");
  exact(ledger.finalOutcome, lastOutcome, "candidate final outcome");
} else {
  exact(attempts.length, 0, "non-candidate evaluator attempt count");
  exact(
    ledger.finalOutcome,
    finalOutcomeByAgentOutcome[agent.outcome],
    "Agent terminal outcome",
  );
}

process.stdout.write(
  `[chronorift-e2-evaluator-ledger] ${JSON.stringify({
    schemaVersion: 1,
    assignmentId,
    evaluationId,
    agentOutcome: agent.outcome,
    evaluatorAttemptCount: attempts.length,
    finalOutcome: ledger.finalOutcome,
    artifactSetSha256: artifactTree.sha256,
    anchorMode,
  })}\n`,
);
