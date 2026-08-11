#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);

const validateFreezeAnchorState = ({
  githubRefType,
  githubRefName,
  githubRef,
  tagName,
  tagObjectType,
  tagCommit,
  checkoutCommit,
}) => {
  const isTargetTagPush = githubRefType === "tag" && githubRefName === tagName;
  if (!isTargetTagPush) return "working_tree";
  if (githubRef !== undefined && githubRef !== `refs/tags/${tagName}`) {
    throw new Error("freeze anchor GitHub ref does not match the target tag");
  }
  if (tagObjectType === undefined) {
    throw new Error("freeze anchor tag is missing");
  }
  if (tagObjectType !== "tag") {
    throw new Error("freeze anchor must be an annotated tag object");
  }
  if (tagCommit === undefined || checkoutCommit === undefined) {
    throw new Error("freeze anchor commit identity is unavailable");
  }
  if (tagCommit !== checkoutCommit) {
    throw new Error("freeze anchor does not target the checked-out commit");
  }
  return "target_tag";
};

const [recordPath, contractPath, interfacePath, m4Path, e2Path, ...extra] =
  process.argv.slice(2);

const fail = (message) => {
  throw new Error(`invalid vNext E2 freeze: ${message}`);
};

if (
  recordPath === undefined ||
  contractPath === undefined ||
  interfacePath === undefined ||
  m4Path === undefined ||
  e2Path === undefined ||
  extra.length !== 0
) {
  fail(
    "expected FREEZE_RECORD EVALUATION_CONTRACT INTERFACE_SCHEMA M4_EVIDENCE E2_EVIDENCE",
  );
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const assertNoDuplicateObjectKeys = (text, label) => {
  let index = 0;
  const whitespace = () => {
    while (/\s/u.test(text[index] ?? "")) index += 1;
  };
  const parseStringToken = () => {
    const start = index;
    index += 1;
    while (index < text.length) {
      const character = text[index];
      if (character === "\\") {
        index += 2;
        continue;
      }
      index += 1;
      if (character === '"') {
        return JSON.parse(text.slice(start, index));
      }
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
    while (index < text.length && !/[\s,\]}]/u.test(text[index] ?? "")) {
      index += 1;
    }
  };
  parseValue();
  whitespace();
  if (index !== text.length) fail(`${label} contains trailing JSON data`);
};

const readJson = async (path, label, maximumBytes = 131_072) => {
  const bytes = await readFile(path);
  if (bytes.byteLength < 2 || bytes.byteLength > maximumBytes) {
    fail(`${label} byte length is out of bounds`);
  }
  let value;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    value = JSON.parse(text);
    assertNoDuplicateObjectKeys(text, label);
  } catch (error) {
    fail(`${label} is not strict UTF-8 JSON: ${String(error)}`);
  }
  return { bytes, value };
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
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${label} does not equal its frozen value`);
  }
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
  const entry = object(value, "canonical JSON value");
  return `{${Object.keys(entry)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(entry[key])}`)
    .join(",")}}`;
};

const git = (args) => {
  try {
    return execFileSync("git", args, {
      cwd: REPOSITORY_ROOT,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        LANG: "C",
        LC_ALL: "C",
        HOME: REPOSITORY_ROOT,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
    });
  } catch (error) {
    fail(`Git identity lookup failed: ${String(error)}`);
  }
};

const gitOptional = (args) => {
  try {
    return execFileSync("git", args, {
      cwd: REPOSITORY_ROOT,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        LANG: "C",
        LC_ALL: "C",
        HOME: REPOSITORY_ROOT,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
    });
  } catch {
    return undefined;
  }
};

const gitBytes = (commit, path) =>
  Buffer.from(git(["show", `${commit}:${path}`]), "utf8");

const recordInput = await readJson(recordPath, "freeze record");
const contractInput = await readJson(contractPath, "evaluation contract");
const interfaceInput = await readJson(interfacePath, "evaluator interface");
const m4Input = await readJson(m4Path, "M4 evidence", 65_536);
const e2Input = await readJson(e2Path, "E2 evidence", 65_536);
const record = object(recordInput.value, "freeze record");
const contract = object(contractInput.value, "evaluation contract");
const evaluatorInterface = object(interfaceInput.value, "evaluator interface");

exactKeys(
  record,
  [
    "schemaVersion",
    "recordKind",
    "recordTiming",
    "classification",
    "freezeAnchor",
    "freezeValidationPlumbing",
    "productSubject",
    "productInterfaces",
    "externalSource",
    "semanticAdapter",
    "evaluationContract",
    "gateInterfaces",
    "gateEvidence",
    "observedExternalMetadata",
    "trustBoundary",
  ],
  "freeze record",
);
exact(
  {
    schemaVersion: record.schemaVersion,
    recordKind: record.recordKind,
    recordTiming: record.recordTiming,
    classification: record.classification,
  },
  {
    schemaVersion: 1,
    recordKind: "chronorift-vnext-e2-post-gate-freeze",
    recordTiming: "post_gate",
    classification: "public_exposed_plumbing_conformance",
  },
  "freeze record identity",
);

exact(
  record.freezeAnchor,
  {
    tagName: "vnext-e2-public-exposed-conformance-r1-freeze",
    requiredObjectType: "tag",
    targetKind: "freeze_record_commit",
    productSubjectMustBeAncestor: true,
    validationMode: "required_on_tag_push",
  },
  "freeze anchor",
);
exactKeys(
  record.freezeValidationPlumbing,
  ["workflowSha256", "hostWrapperSha256", "freezeValidatorSha256"],
  "freeze-validation plumbing",
);
exact(
  {
    workflowSha256: record.freezeValidationPlumbing?.workflowSha256,
    hostWrapperSha256: record.freezeValidationPlumbing?.hostWrapperSha256,
  },
  {
    workflowSha256:
      "105b211b4ab87f16788ae68a651070dfeefabf980680e631f946f3de79df8b51",
    hostWrapperSha256:
      "08305f46413b348abc62b709ef4f829b66328ee15bd93241fbdad2315ee383a5",
  },
  "freeze-validation plumbing identity",
);
const product = object(record.productSubject, "product subject");
exactKeys(
  product,
  [
    "repositoryCommit",
    "repositoryTree",
    "branchAtGate",
    "workflowSha256",
    "hostWrapperSha256",
  ],
  "product subject",
);
exact(
  product,
  {
    repositoryCommit: "f8ccb183eb7db21c1737b60a9f4970dce5ff17f0",
    repositoryTree: "1dc3372dc68132b2b3452fa3127f8f7fcdcb583c",
    branchAtGate: "feat/m4-external-project",
    workflowSha256:
      "06b63c83b46680ec721c57567e07ad889ea03dde427eeb6314e66530f9dbe7c2",
    hostWrapperSha256:
      "e1fd268332411d622fd5640477cb3d4392af88cfd95dda9e30f88d5fd490b13c",
  },
  "product subject",
);
const productTree = git([
  "show",
  "-s",
  "--format=%T",
  product.repositoryCommit,
]).trim();
exact(productTree, product.repositoryTree, "product Git tree");

const anchorTagRef = `refs/tags/${record.freezeAnchor.tagName}`;
const tagPushRequiresAnchor =
  process.env.GITHUB_REF_TYPE === "tag" &&
  process.env.GITHUB_REF_NAME === record.freezeAnchor.tagName;
let anchorCommit;
let anchorMode = "working_tree";
if (tagPushRequiresAnchor) {
  const anchorObjectType = gitOptional([
    "cat-file",
    "-t",
    anchorTagRef,
  ])?.trim();
  let checkoutCommit;
  if (anchorObjectType === "tag") {
    anchorCommit = git(["rev-parse", `${anchorTagRef}^{commit}`]).trim();
    checkoutCommit = git(["rev-parse", "HEAD^{commit}"]).trim();
  }
  try {
    anchorMode = validateFreezeAnchorState({
      githubRefType: process.env.GITHUB_REF_TYPE,
      githubRefName: process.env.GITHUB_REF_NAME,
      githubRef: process.env.GITHUB_REF,
      tagName: record.freezeAnchor.tagName,
      tagObjectType: anchorObjectType,
      tagCommit: anchorCommit,
      checkoutCommit,
    });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  const productIsAncestor =
    gitOptional([
      "merge-base",
      "--is-ancestor",
      product.repositoryCommit,
      anchorCommit,
    ]) !== undefined;
  exact(productIsAncestor, true, "freeze anchor product ancestry");
  const frozenRecordBytes = gitBytes(
    anchorCommit,
    "docs/evidence/vnext-e2-public-exposed-r1/freeze-record.v1.json",
  );
  exact(
    sha256(frozenRecordBytes),
    sha256(recordInput.bytes),
    "freeze anchor record bytes",
  );
}
const freezeFileBytes = async (path) =>
  anchorCommit === undefined
    ? await readFile(resolve(REPOSITORY_ROOT, path))
    : gitBytes(anchorCommit, path);
exact(
  sha256(await freezeFileBytes(".github/workflows/ci.yml")),
  record.freezeValidationPlumbing.workflowSha256,
  "freeze-validation workflow bytes",
);
exact(
  sha256(
    await freezeFileBytes(
      ".github/scripts/run-vnext-external-project-conformance.sh",
    ),
  ),
  record.freezeValidationPlumbing.hostWrapperSha256,
  "freeze-validation Host wrapper bytes",
);
exact(
  sha256(await freezeFileBytes(".github/scripts/validate-vnext-e2-freeze.mjs")),
  record.freezeValidationPlumbing.freezeValidatorSha256,
  "freeze validator bytes",
);

const expectedProductInterfaces = [
  [
    "packages/domain/src/vnext-semantic-runtime.ts",
    "d9b88e56dcff7577418252b890f38ef39d9f426bdcb8b651295131f4149e6918",
  ],
  [
    "packages/agent-protocol/src/vnext-semantic-game-tools.ts",
    "580be6023660164119da0c6583ba04354f84605844b50d4b208aa578395af962",
  ],
  [
    "packages/godot-protocol/src/semantic-messages.ts",
    "a4a966665052795bae7636a93bd29eb58c84d2d7372c57a75eb063273ca426b3",
  ],
  [
    "packages/godot-protocol/src/semantic-sidecar.ts",
    "e1d8835ee8c8aa83f681117d41d75e52546c8a9a6d57d51d2bd7f4ae0b0c1b3f",
  ],
  [
    "packages/godot-adapter/src/semantic-wire-client.ts",
    "b585240b1074694c3c64924928936a359abeac5c89ea8d0228cd3f76178f3ea3",
  ],
  [
    "apps/cli/src/vnext/semantic-adapter-profile.ts",
    "0c54b9a00759024f7cba302a649a40837d601776891496a5daaf3815d31e8799",
  ],
  [
    "apps/cli/src/vnext/managed-godot-semantic-runtime.ts",
    "fb06105de86a9ddd84cd15c0815a793fb17a2c3721d57a0bfbf48dac9c8a7d43",
  ],
  [
    "apps/cli/src/vnext/godot-semantic-sidecar-port.ts",
    "e2a8d5b2d929f541f571e647e9ffe212f35581706ead7ddf19683bc106bc2eed",
  ],
  [
    "apps/cli/src/vnext/external-godot-semantic-coordinator.ts",
    "f2da30bf49ce94d54e86a65ff6a101fec16993d728105c4196a90bc87c09100b",
  ],
  [
    "apps/cli/src/vnext/task-agent-contracts.ts",
    "dae3f658729f757afbda2746f1687093c61636ae145fcd94d92a5351a3815617",
  ],
  [
    "packages/pi-harness/src/vnext-game-tools.ts",
    "bb01dd0a1b3b219a147a5b20a7b3ce6bf86ad24bf6d98735d24ed540ea591cc4",
  ],
];
exact(
  record.productInterfaces,
  expectedProductInterfaces.map(([path, digest]) => ({ path, sha256: digest })),
  "product interface inventory",
);
for (const [path, digest] of expectedProductInterfaces) {
  exact(
    sha256(gitBytes(product.repositoryCommit, path)),
    digest,
    `frozen product interface ${path}`,
  );
}
exact(
  sha256(gitBytes(product.repositoryCommit, ".github/workflows/ci.yml")),
  product.workflowSha256,
  "frozen workflow",
);
exact(
  sha256(
    gitBytes(
      product.repositoryCommit,
      ".github/scripts/run-vnext-external-project-conformance.sh",
    ),
  ),
  product.hostWrapperSha256,
  "frozen Host wrapper",
);

exact(
  record.externalSource,
  {
    declaredUrl: "https://github.com/endlessm/moddable-platformer",
    headCommit: "3e793f53598a131c53fb82555191cc14b8db07ff",
    gitTreeObjectId: "a013bd677c712dbf354e8e2f6e8ff7c53d5684c6",
    selectedTreeSha256:
      "3e8bd6478d53586284010da38959005e2a377ef6277b2a838ecb1538abc096e8",
    descriptorRawSha256:
      "534dcd8aa14aeea74685059f8d66e44e5bebe21742b7a702ee7d78e91e1a955e",
  },
  "external source",
);

const profilePath =
  "testdata/vnext/external-project/moddable-platformer.semantic-adapter.v1.json";
const addonPath = "godot/addons/chronorift_semantic/semantic_probe.gd";
const profileBytes = gitBytes(product.repositoryCommit, profilePath);
const addonBytes = gitBytes(product.repositoryCommit, addonPath);
const profile = JSON.parse(profileBytes.toString("utf8"));
const addonTree = createHash("sha256")
  .update("semantic_probe.gd")
  .update("\0")
  .update(addonBytes)
  .update("\0")
  .digest("hex");
exact(
  record.semanticAdapter,
  {
    profileRawSha256:
      "1ca17b9f3fff8556d5fa260331929126ba54e18518de2d2386562b230327238b",
    profileCanonicalSha256:
      "2600ae0d42a463d78a7c74b987799e74e7391c254f806ddbcc86b2256591f0e4",
    projectCapabilitySha256:
      "5fcb49b2a8dc64e7f38af7c26e630dec67799bf0dd1a713310baefac32c58836",
    addonFileSha256:
      "f325e1df0e1d97b786eab281b202dc198638e08b5233330789b118e2d823f2e5",
    addonTreeSha256:
      "119627e7013fd3ba31de2c41caed97bd3cfa985741179507c733c6a0d4cadbfa",
    vanillaSidecarSha256:
      "52caf732e8c26b2ed1bb2ce8d5ecc8449cf065bd6c6c3312aaec57ef026b4a2f",
    semanticSidecarSha256:
      "a222b33ff22ad2f39350d8b46bf4abe996b6e642ec275ff9fb549aa9d1b76824",
    overlaySha256:
      "310593cf4b12c86aca2fd52d79f302fa0ade81d49b2dcf3c4e6ea221a9ca05f9",
  },
  "semantic adapter",
);
exact(
  sha256(profileBytes),
  record.semanticAdapter.profileRawSha256,
  "profile bytes",
);
exact(
  sha256(Buffer.from(canonicalJson(profile), "utf8")),
  record.semanticAdapter.profileCanonicalSha256,
  "canonical profile",
);
exact(sha256(addonBytes), record.semanticAdapter.addonFileSha256, "addon file");
exact(addonTree, record.semanticAdapter.addonTreeSha256, "addon tree");

exactKeys(
  contract,
  [
    "schemaVersion",
    "contractKind",
    "contractTiming",
    "contractStatus",
    "productSubject",
    "externalSource",
    "semanticAdapter",
    "evaluationScope",
    "identityAlgorithms",
    "runtimeBudgets",
    "sharedTaskStorageBudget",
    "agentBudget",
    "evaluatorBudget",
    "retryPolicy",
    "taskSelection",
    "evaluatorInterface",
    "claimBoundary",
  ],
  "evaluation contract",
);
exact(
  {
    schemaVersion: contract.schemaVersion,
    contractKind: contract.contractKind,
    contractTiming: contract.contractTiming,
    contractStatus: contract.contractStatus,
  },
  {
    schemaVersion: 1,
    contractKind: "chronorift-e2-external-evaluation-contract",
    contractTiming: "post_product_gate_pre_holdout_selection",
    contractStatus: "interface_frozen_holdout_unselected",
  },
  "evaluation contract identity",
);
exact(
  contract.productSubject,
  {
    repositoryCommit: product.repositoryCommit,
    repositoryTree: product.repositoryTree,
    taskProfile: "godot-external-semantic-v1",
    protocolProfile: "chronorift-godot-semantic-v1",
    protocolVersion: 1,
    gateRunId: 31416348238,
    gateRunAttempt: 1,
    gateConclusion: "success",
  },
  "evaluation product subject",
);
exact(
  contract.externalSource,
  {
    ...record.externalSource,
    projectCapabilitySha256: record.semanticAdapter.projectCapabilitySha256,
  },
  "evaluation external source",
);
exact(
  contract.semanticAdapter,
  {
    profilePath,
    profileRawSha256: record.semanticAdapter.profileRawSha256,
    profileCanonicalSha256: record.semanticAdapter.profileCanonicalSha256,
    addonPath,
    addonFileSha256: record.semanticAdapter.addonFileSha256,
    addonTreeSha256: record.semanticAdapter.addonTreeSha256,
    addonTreeHashAlgorithm: "sorted-relative-path-nul-bytes-nul-sha256-v1",
    targetScene: "res://components/spawner/enemy_spawner_broken.tscn",
    checkpointBarrier: "adapter_process_tail",
  },
  "evaluation semantic adapter",
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
  contract.identityAlgorithms,
  {
    assignmentContent: "canonical-json-assignment-basis-sha256-v1",
    assignmentId:
      "sha256-chronorift-e2-assignment-id-v1-nul-assignment-hash-prefix24",
    evaluationId:
      "sha256-chronorift-e2-evaluation-id-v1-nul-assignment-hash-prefix24",
    taskSpec: "canonical-json-plus-one-lf-sha256-v1",
    prompt: "raw-utf8-bytes-sha256-v1",
    scenarioDefinition: "raw-evaluator-bundle-file-bytes-sha256-v1",
    scenarioId:
      "sha256-chronorift-e2-scenario-id-v1-nul-definition-hash-prefix24",
    scenarioPlan: "canonical-json-ordered-scenario-array-sha256-v1",
    baselineSource: "chronorift-selected-tree-v1",
    agentWorkspaceSource: "chronorift-selected-tree-v1",
    candidateSource: "chronorift-selected-tree-v1",
    candidatePatch: "raw-git-binary-full-index-bytes-sha256-v1",
    evaluatorImplementation: "chronorift-selected-tree-v1",
    evaluatorBundle: "chronorift-selected-tree-v1",
    evaluationArtifacts: "chronorift-selected-tree-v1",
    runtimeResourceEnvelope: "chronorift-vnext-runtime-resource-envelope-v1",
    runtimeEventLedger: "chronorift-vnext-runtime-event-ledger-v1",
    runtimeExecutionSealFile: "canonical-json-plus-one-lf-raw-bytes-sha256-v1",
    messageArtifact: "canonical-json-plus-one-lf-sha256-v1",
    messageContent: "canonical-json-omit-own-content-hash-sha256-v1",
  },
  "evaluation identity algorithms",
);
exact(
  contract.runtimeBudgets,
  {
    activeRuntimesMaximum: 2,
    launchesPerTurnMaximum: 8,
    entityMaximum: 256,
    eventMaximum: 4096,
    rawSemanticBytesMaximum: 2_097_152,
    checkpointBytesMaximum: 1_048_576,
    traceSamplesMaximum: 32,
    traceTicksMaximum: 600,
    queryRowsMaximum: 200,
  },
  "runtime budgets",
);
exact(
  contract.runtimeBudgets,
  profile.limits,
  "profile/runtime budget binding",
);
exact(
  contract.sharedTaskStorageBudget,
  {
    scope: "single_evaluation_task_aggregate",
    bytesMaximum: 1_073_741_824,
    inodesMaximum: 131_072,
  },
  "shared Task storage budget",
);
exact(
  contract.agentBudget,
  {
    provider: "openai-codex",
    model: "gpt-5.6-luna",
    thinkingLevel: "max",
    attemptsMaximum: 1,
    turnsPerAttemptMaximum: 1,
    wallTimeMsPerAttemptMaximum: 600_000,
    totalToolCallsPerAttemptMaximum: 128,
    gameToolCallsPerAttemptMaximum: 64,
    piAgentAutoRetriesPerCycleMaximum: 2,
    piAgentAutoRetriesTotalEligibilityMaximum: 8,
    providerSdkRetriesPerCallMaximum: 0,
    toolAndRetryLimitEnforcement: "evaluator_eligibility_posthoc",
    wallTimeEnforcement: "harness_timeout",
    taskSandboxNetworkMode: "denied",
    hostModelNetworkAuthorization: "provider_only",
    gitRemoteMode: "absent",
  },
  "Agent budget",
);
exact(
  contract.evaluatorBudget,
  {
    attemptsMaximum: 2,
    sameCandidateInfrastructureRetriesMaximum: 1,
    wallTimeMsPerAttemptMaximum: 600_000,
    scenarioCountMaximum: 64,
  },
  "evaluator budget",
);
exact(
  contract.retryPolicy,
  {
    sameCandidateRetryAllowedOnlyAfter: "infrastructure_failure",
    sameCandidateRetryRequiresCleanupProven: true,
    sameCandidateRetryRequiresSourceUnchanged: true,
    evaluatedOutcomeRequiresNewCandidate: true,
    newCandidateRequiresNewSourceIdentity: true,
    originalAttemptIsRetained: true,
  },
  "retry policy",
);
exact(
  contract.taskSelection,
  {
    status: "unselected",
    selectionAuthority: "isolated_curator",
    selectionMustOccurAfterThisContractFreeze: true,
    taskSpecSha256Required: true,
    promptSha256Required: true,
    agentReceivesGitRemote: false,
    agentReceivesFutureHistory: false,
    agentReceivesEvaluatorOracle: false,
  },
  "task selection boundary",
);
exact(
  contract.evaluatorInterface,
  {
    interfaceId: "chronorift-e2-external-evaluator-v1",
    schemaPath: record.evaluationContract.interfaceSchemaPath,
    schemaRawSha256: record.evaluationContract.interfaceSchemaRawSha256,
    messageValidatorPath: record.evaluationContract.messageValidatorPath,
    messageValidatorRawSha256:
      record.evaluationContract.messageValidatorRawSha256,
    contentHashAlgorithm: "canonical-json-omit-own-content-hash-sha256-v1",
    artifactBundleRequired: true,
    executionArtifactValidationRequired: true,
    validatorInputs: [
      "freeze_record",
      "evaluation_contract",
      "interface_schema",
      "evaluation_ledger",
      "evaluation_artifact_root",
      "baseline_source_root",
      "agent_workspace_root",
      "evaluator_implementation_root",
      "evaluator_bundle_root",
    ],
    agentUsageReceiptRequired: true,
    productSubjectReceiptRequired: true,
    singleAssignmentUniquenessEnforcement:
      "external_create_only_store_required_not_implemented",
    implementationStatus: "not_implemented",
    acceptanceAuthority: "external_evaluator",
    writesProductTaskVerdict: false,
    allAttemptsRetained: true,
    resultOutcomes: [
      "accepted",
      "rejected",
      "invalid_candidate",
      "infrastructure_failure",
      "agent_provider_failed",
      "agent_aborted",
      "agent_timed_out",
      "agent_no_candidate",
      "agent_budget_exceeded",
      "agent_sandbox_failed",
      "agent_patch_handoff_failed",
    ],
  },
  "evaluator interface contract",
);
exact(
  contract.claimBoundary,
  {
    publicGateClassification: "public_exposed_plumbing_conformance",
    independentAcceptanceEstablished: false,
    claimsExcluded: [
      "intelligent_diagnosis",
      "independent_acceptance",
      "equivalent_checkpoint_restore",
      "causality",
      "generalization",
      "reliability",
      "relative_advantage",
    ],
  },
  "contract claim boundary",
);

// FINAL_HASH_STAMP: update these three byte digests only after the contract,
// interface schema, and evaluator validator are stable.
exact(
  record.evaluationContract,
  {
    path: "testdata/vnext/external-project/moddable-platformer.e2-evaluation-contract.v1.json",
    rawSha256:
      "7e7d872e424977db6cd1a74517996449835eb428e76b40f35c0ea4891f332a42",
    interfaceSchemaPath:
      "testdata/vnext/external-project/e2-evaluator-interface.schema.v1.json",
    interfaceSchemaRawSha256:
      "92ba865ae04fd2776ad67da13edf1d278194bef54d489b2afb3e9640e6f8d77f",
    messageValidatorPath:
      ".github/scripts/validate-vnext-e2-evaluator-ledger.mjs",
    messageValidatorRawSha256:
      "33e3380dfd85bf7a4fd7feda66beca06f0b0219d62758c1ee1a928ee186077c7",
    holdoutSelectionStatus: "unselected",
    evaluatorImplementationStatus: "not_implemented",
  },
  "evaluation contract record",
);
exact(
  sha256(contractInput.bytes),
  record.evaluationContract.rawSha256,
  "evaluation contract bytes",
);
exact(
  sha256(interfaceInput.bytes),
  record.evaluationContract.interfaceSchemaRawSha256,
  "evaluator interface bytes",
);
const evaluatorMessageValidatorBytes = await freezeFileBytes(
  record.evaluationContract.messageValidatorPath,
);
exact(
  sha256(evaluatorMessageValidatorBytes),
  record.evaluationContract.messageValidatorRawSha256,
  "evaluator message validator bytes",
);
exactKeys(
  evaluatorInterface,
  ["$schema", "$id", "title", "oneOf", "$defs"],
  "evaluator interface schema",
);
exact(
  evaluatorInterface.$id,
  "https://chronorift.invalid/eval/e2-external-evaluator-interface.v1.schema.json",
  "evaluator interface schema identity",
);
exact(
  evaluatorInterface.$defs?.relativePath?.pattern,
  "^(?!/)(?!.*//)(?!.*\\/$)(?!.*(?:^|/)(?:\\.|\\.\\.|\\.git)(?:/|$))[A-Za-z0-9._/-]{1,256}$",
  "evaluator artifact relative-path grammar",
);
exact(
  Object.keys(
    object(evaluatorInterface.$defs, "evaluator interface definitions"),
  ).sort(),
  [
    "agentAttemptReceipt",
    "evaluatedResult",
    "agentUsage",
    "artifactReference",
    "assignmentId",
    "cleanupReceipt",
    "evaluatorAttemptEntry",
    "evaluationLedger",
    "evaluationId",
    "evaluationRequest",
    "evaluatorUsage",
    "executionArtifact",
    "gitCommit",
    "infrastructureFailureResult",
    "invalidCandidateReceipt",
    "opaqueId",
    "productInterface",
    "productSubjectReceipt",
    "relativePath",
    "scenarioId",
    "scenarioResult",
    "sha256",
    "taskScenario",
    "taskSpec",
  ].sort(),
  "evaluator interface definition catalog",
);
for (const definition of [
  "evaluationRequest",
  "evaluatedResult",
  "infrastructureFailureResult",
  "evaluationLedger",
  "agentUsage",
  "evaluatorUsage",
  "agentAttemptReceipt",
  "cleanupReceipt",
  "evaluatorAttemptEntry",
  "executionArtifact",
  "invalidCandidateReceipt",
  "productInterface",
  "productSubjectReceipt",
  "scenarioResult",
  "taskScenario",
  "taskSpec",
]) {
  exact(
    evaluatorInterface.$defs[definition].additionalProperties,
    false,
    `${definition} strictness`,
  );
}

const expectedGateInterfaces = [
  [
    "apps/cli/src/vnext/moddable-platformer.external-semantic.test.ts",
    "public_exposed_evidence_producer",
    "6e7dac1946eb2e115145e8e91a82a4dc34dfd84cf3e9adae5a078c8a4097fa05",
  ],
  [
    ".github/scripts/validate-vnext-external-semantic-evidence.mjs",
    "evidence_shape_validation_only",
    "6b31a5039b2c1b78529c9971f5f8ba4b0df45360dfc6e4be9e5acb83fc2ff732",
  ],
  [
    "vitest.external-semantic.config.ts",
    "public_exposed_test_budget",
    "8e4c20da53bb28d5a546c1f85bfe3795c36f18ffb5919d2bc38f4a2a396fbb18",
  ],
  [
    ".github/scripts/validate-vnext-external-project-evidence.mjs",
    "m4_evidence_shape_validation_only",
    "a2ab63f371f4fab9369d05c096aac9424223f5eb54ff265ccff244e801b90291",
  ],
  [
    "testdata/vnext/external-project/evidence-summary.schema.v1.json",
    "m4_evidence_schema",
    "a2b82d334206b02c515b98e88183d22653093f96de3acd697bcaa0f758314c96",
  ],
];
exact(
  record.gateInterfaces,
  expectedGateInterfaces.map(([path, role, digest]) => ({
    path,
    role,
    sha256: digest,
  })),
  "Gate interface inventory",
);
for (const [path, , digest] of expectedGateInterfaces) {
  exact(
    sha256(gitBytes(product.repositoryCommit, path)),
    digest,
    `frozen Gate interface ${path}`,
  );
}

exact(
  record.gateEvidence,
  {
    runId: 31416348238,
    runAttempt: 1,
    jobId: 93546182624,
    headCommit: product.repositoryCommit,
    conclusion: "success",
    artifactId: 9073633655,
    artifactName: "chronorift-external-project-31416348238-1",
    artifactArchiveDigest:
      "sha256:65e947f6e222ea4c17999fb600a9f6f9b5cdac15d331a93f2d14e042fc4a0ab5",
    m4EvidencePath:
      "docs/evidence/vnext-e2-public-exposed-r1/chronorift-m4-external-project-evidence.json",
    m4EvidenceSha256:
      "b9b6d124a776dfe9f8c7dff88b8a57d1244826e505b7495f7a76cc0c0812cb5d",
    e2EvidencePath:
      "docs/evidence/vnext-e2-public-exposed-r1/chronorift-e2-external-semantic-evidence.json",
    e2EvidenceSha256:
      "a68fbb78a376ba8d2047bf07f655a5de1ed95941a64dd55b62ba1ff8bb2fa699",
    e2ExecutionCount: 2,
    e2AllExecutionsSealed: true,
    m4SourceUnchanged: true,
    m4CleanupAndStorageEmpty: true,
  },
  "Gate evidence record",
);
exact(
  record.observedExternalMetadata,
  {
    source: "github_actions_api_observation",
    repository: "xiangzuodalao/ChronoRift",
    workflowName: "CI",
    runUrl:
      "https://github.com/xiangzuodalao/ChronoRift/actions/runs/31416348238",
    jobName: "vnext-external-project",
    jobUrl:
      "https://github.com/xiangzuodalao/ChronoRift/actions/runs/31416348238/job/93546182624",
    artifactCreatedAt: "2026-08-10T17:56:45Z",
    artifactExpiresAt: "2026-09-09T17:56:45Z",
    artifactSizeBytes: 2845,
    archiveDigestLocallyReproducible: false,
  },
  "observed external Gate metadata",
);
exact(
  sha256(m4Input.bytes),
  record.gateEvidence.m4EvidenceSha256,
  "M4 evidence bytes",
);
exact(
  sha256(e2Input.bytes),
  record.gateEvidence.e2EvidenceSha256,
  "E2 evidence bytes",
);
exact(
  {
    headCommit: m4Input.value.source?.headCommit,
    unchangedAfterTask: m4Input.value.source?.unchangedAfterTask,
    cleanup: m4Input.value.cleanup,
  },
  {
    headCommit: record.externalSource.headCommit,
    unchangedAfterTask: true,
    cleanup: {
      taskDiscarded: true,
      taskProcessesEmpty: true,
      taskCgroupsEmpty: true,
      taskStorageEmpty: true,
    },
  },
  "M4 source and cleanup evidence",
);
exact(
  {
    sourceCommit: e2Input.value.sourceCommit,
    adapterProfileSha256: e2Input.value.adapterProfileSha256,
    executionCount: e2Input.value.executionCount,
    allExecutionsSealed: e2Input.value.allExecutionsSealed,
    fidelity: e2Input.value.fidelity,
    taskClassification: e2Input.value.taskClassification,
  },
  {
    sourceCommit: record.externalSource.headCommit,
    adapterProfileSha256: record.semanticAdapter.profileCanonicalSha256,
    executionCount: 2,
    allExecutionsSealed: true,
    fidelity: "descriptive_only",
    taskClassification: "public_exposed_plumbing_conformance",
  },
  "E2 sealed execution evidence",
);

exact(
  record.trustBoundary,
  {
    tagAndHashesAreSignatures: false,
    independentAttestation: false,
    independentAcceptance: false,
    preRegistration: false,
    crossAssignmentDenominatorIntegrity: false,
    usageReceiptOriginAttested: false,
    publicTaskExposed: true,
    claimsExcluded: [
      "intelligent_diagnosis",
      "independent_acceptance",
      "equivalent_checkpoint_restore",
      "causality",
      "generalization",
      "reliability",
      "relative_advantage",
    ],
  },
  "freeze trust boundary",
);

process.stdout.write(
  `[chronorift-e2-freeze] ${JSON.stringify({
    schemaVersion: 1,
    anchorMode,
  })}\n`,
);
