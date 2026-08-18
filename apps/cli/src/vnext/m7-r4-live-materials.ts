import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  AdapterConformanceReceiptV1Schema,
  JsonValueSchema,
  ProjectAdapterRevisionV1Schema,
  Sha256DigestV1Schema,
  asSha256DigestV1,
  type Sha256DigestV1,
} from "@chronorift/domain";
import { canonicalJson } from "@chronorift/json-artifacts";
import { z } from "zod";

import { collectCandidateGodotSourceV1 } from "./candidate-godot-build.js";
import { ExternalHiddenFixPublicTaskSpecV1Schema } from "./external-hidden-fix-assignment.js";
import {
  M7R3CaseConstructionReceiptV1Schema,
  M7R3CasePreflightReceiptV1Schema,
  M7R3TrajectoryClassifierFreezeV1Schema,
} from "./m7-r3-case-construction.js";
import {
  M7R3PairedPublicTaskContractV1Schema,
  createM7R3PairedPublicTaskContractV1,
  encodeM7R3PairedPublicTaskContractV1,
} from "./m7-r3-public-task.js";
import {
  createM7R3OperationalHostConfigsOnceV1,
  sealM7R3RealizedCgroupTopologyOnceV1,
  type M7R3PreparedOperationalHostConfigsV1,
  type M7R3RealizedCgroupTopologyReceiptV1,
} from "./m7-r3-live-operational-config.js";
import { M7R3PatrolTrajectoryCaseSpecV1Schema } from "./m7-patrol-trajectory.js";
import { M7SensorFreezeRecordV1Schema } from "./m7-patrol-sensor.js";
import {
  readProjectEnvironmentHostConfigV1,
  type ProjectEnvironmentHostConfigV1,
} from "./project-environment-host-config.js";
import { selectedTreeSha256 } from "./selected-tree.js";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MAX_FILE_BYTES = 16 * 1024 * 1024;

const digest = (bytes: string | Uint8Array): Sha256DigestV1 =>
  asSha256DigestV1(createHash("sha256").update(bytes).digest("hex"));
const digestJson = (value: unknown): Sha256DigestV1 =>
  digest(canonicalJson(JsonValueSchema.parse(value)));
const sameJson = (left: unknown, right: unknown): boolean =>
  canonicalJson(JsonValueSchema.parse(left)) ===
  canonicalJson(JsonValueSchema.parse(right));

const caseManifestSchema = z
  .object({
    ordinal: z.union([z.literal(1), z.literal(2)]),
    slug: z.enum(["case-01", "case-02"]),
    pristineCommit: z.string().regex(/^[a-f0-9]{40}$/u),
    mutantCommit: z.string().regex(/^[a-f0-9]{40}$/u),
    pristineSelectedTreeSha256: Sha256DigestV1Schema,
    mutatedSelectedTreeSha256: Sha256DigestV1Schema,
    promptFileSha256: Sha256DigestV1Schema,
    runtimeTaskSpecSha256: Sha256DigestV1Schema,
    codeOnlyTaskSpecSha256: Sha256DigestV1Schema,
    pairedTaskContractFileSha256: Sha256DigestV1Schema,
    pairedTaskContractContentSha256: Sha256DigestV1Schema,
    mutationSha256: Sha256DigestV1Schema,
    mutationByteLength: z
      .number()
      .int()
      .positive()
      .max(4 * 1024 * 1024),
    trajectoryCaseSpecFileSha256: Sha256DigestV1Schema,
    trajectoryCaseSpecSha256: Sha256DigestV1Schema,
    evaluatorImplementationSha256: Sha256DigestV1Schema,
    evaluatorImplementationByteLength: z
      .number()
      .int()
      .positive()
      .max(4 * 1024 * 1024),
    evaluatorBundleSha256: Sha256DigestV1Schema,
    evaluatorBundleByteLength: z
      .number()
      .int()
      .positive()
      .max(4 * 1024 * 1024),
  })
  .strict();

const commonManifestSchema = z
  .object({
    classifierFreezeFileSha256: Sha256DigestV1Schema,
    classifierFreezeRecordContentSha256: Sha256DigestV1Schema,
    classifierImplementationSha256: Sha256DigestV1Schema,
    pairedAgentProtocolImplementationSha256: Sha256DigestV1Schema,
    projectEnvironmentPreparationImplementationSha256: Sha256DigestV1Schema,
    preflightProjectEnvironmentImplementationSha256: Sha256DigestV1Schema,
    preflightImplementationManifestFileSha256: Sha256DigestV1Schema,
    publicExecutionClassifierSha256: Sha256DigestV1Schema,
    adapterRevisionFileSha256: Sha256DigestV1Schema,
    adapterConformanceFileSha256: Sha256DigestV1Schema,
    sensorFreezeFileSha256: Sha256DigestV1Schema,
    adapterPackageRawAggregateSha256: Sha256DigestV1Schema,
    adapterPackageCanonicalIdentitySha256: Sha256DigestV1Schema,
    sensorObservationSchemaRawSha256: Sha256DigestV1Schema,
    adapterPayloadSchemaCanonicalIdentitySha256: Sha256DigestV1Schema,
    hostConfigSha256: Sha256DigestV1Schema,
    hostModelRuntimeConfigSha256: Sha256DigestV1Schema,
  })
  .strict();

const implementationManifestSchema = z
  .object({
    casePreflightRunnerSha256: Sha256DigestV1Schema,
    preflightProjectEnvironmentSha256: Sha256DigestV1Schema,
    gameRuntimeSha256: Sha256DigestV1Schema,
    wireClientSha256: Sha256DigestV1Schema,
    attemptRetentionImplementationSha256: Sha256DigestV1Schema,
    formalDriverImplementationSha256: Sha256DigestV1Schema,
    liveMaterialsVerifierSha256: Sha256DigestV1Schema,
    noAgentLiveImplementationSha256: Sha256DigestV1Schema,
  })
  .strict();

const orchestrationManifestSchema = z
  .object({
    containerEntrypointSha256: Sha256DigestV1Schema,
    runWrapperSha256: Sha256DigestV1Schema,
    staticAdmissionSha256: Sha256DigestV1Schema,
    runControlSha256: Sha256DigestV1Schema,
    liveTestConfigSha256: Sha256DigestV1Schema,
    liveComposerSha256: Sha256DigestV1Schema,
    operationalConfigComposerSha256: Sha256DigestV1Schema,
  })
  .strict();

const manifestBasisSchema = z
  .object({
    schemaVersion: z.literal(1),
    recordKind: z.literal("m7-r4-live-material-manifest"),
    frozenBeforeAnyAgent: z.literal(true),
    frozenAt: z.string().datetime({ offset: true }),
    sourceEligibility: z
      .object({
        replacementConstructionReceiptFileSha256: Sha256DigestV1Schema,
        replacementConstructionReceiptContentSha256: Sha256DigestV1Schema,
        replacementNoAgentPreflightReceiptFileSha256: Sha256DigestV1Schema,
        replacementNoAgentPreflightReceiptContentSha256: Sha256DigestV1Schema,
        replacementMaterialManifestFileSha256: Sha256DigestV1Schema,
        replacementMaterialManifestContentSha256: Sha256DigestV1Schema,
        r3SourceMaterialManifestContentSha256: Sha256DigestV1Schema,
      })
      .strict(),
    common: commonManifestSchema,
    implementation: implementationManifestSchema,
    orchestration: orchestrationManifestSchema,
    cases: z.tuple([caseManifestSchema, caseManifestSchema]),
  })
  .strict();

export const M7R4LiveMaterialManifestV1Schema = manifestBasisSchema
  .extend({ recordContentSha256: Sha256DigestV1Schema })
  .strict()
  .superRefine((value, context) => {
    const { recordContentSha256, ...basis } = value;
    if (recordContentSha256 !== digestJson(basis)) {
      context.addIssue({
        code: "custom",
        path: ["recordContentSha256"],
        message: "R4 live material manifest content hash does not match",
      });
    }
    if (
      value.cases[0].ordinal !== 1 ||
      value.cases[0].slug !== "case-01" ||
      value.cases[1].ordinal !== 2 ||
      value.cases[1].slug !== "case-02"
    ) {
      context.addIssue({
        code: "custom",
        path: ["cases"],
        message: "R4 live cases must remain in fixed order 1 then 2",
      });
    }
  });
export type M7R4LiveMaterialManifestV1 = z.infer<
  typeof M7R4LiveMaterialManifestV1Schema
>;

const preflightImplementationBasisSchema = z
  .object({
    schemaVersion: z.literal(1),
    recordKind: z.literal("m7-r3-preflight-implementation-manifest"),
    runnerImplementationSha256: Sha256DigestV1Schema,
    projectEnvironmentImplementationSha256: Sha256DigestV1Schema,
  })
  .strict();

export const M7R4PreflightImplementationManifestV1Schema =
  preflightImplementationBasisSchema
    .extend({ recordContentSha256: Sha256DigestV1Schema })
    .strict()
    .superRefine((value, context) => {
      const { recordContentSha256, ...basis } = value;
      if (recordContentSha256 !== digestJson(basis)) {
        context.addIssue({
          code: "custom",
          path: ["recordContentSha256"],
          message: "R4 preflight implementation manifest hash does not match",
        });
      }
    });

export const M7R4LiveModeV1Schema = z.enum([
  "pre-agent-dry-run",
  "no-agent-preflight",
  "r4-live",
]);
export type M7R4LiveModeV1 = z.infer<typeof M7R4LiveModeV1Schema>;

export const m7R4RunOutputRootsForModeV1 = (input: {
  readonly mode: M7R4LiveModeV1;
  readonly declaredConstructionRoot: string;
  readonly declaredPreflightAttemptRoot: string;
  readonly runsRoot: string;
}): {
  readonly constructionRoot: string;
  readonly portfolioRoot: string;
  readonly preflightAttemptRoot: string;
} =>
  input.mode === "no-agent-preflight"
    ? Object.freeze({
        constructionRoot: join(
          input.runsRoot,
          "no-agent-preflight",
          "construction",
        ),
        portfolioRoot: join(input.runsRoot, "no-agent-preflight", "portfolio"),
        preflightAttemptRoot: input.declaredPreflightAttemptRoot,
      })
    : Object.freeze({
        constructionRoot: input.declaredConstructionRoot,
        portfolioRoot: join(input.runsRoot, "portfolio"),
        preflightAttemptRoot:
          input.mode === "r4-live"
            ? join(input.runsRoot, "run-control", "formal-preflight-attempt")
            : input.declaredPreflightAttemptRoot,
      });

export const assertM7R4NoAgentHostConfigBindingsV1 = (input: {
  readonly operationalHostConfigs: Pick<
    M7R3PreparedOperationalHostConfigsV1,
    "noAgentPreflightHostConfigPaths"
  >;
  readonly cases: readonly [
    { readonly ordinal: 1 | 2; readonly noAgentHostConfigPath: string },
    { readonly ordinal: 1 | 2; readonly noAgentHostConfigPath: string },
  ];
}): void => {
  for (const [index, candidate] of input.cases.entries()) {
    if (
      candidate.ordinal !== index + 1 ||
      candidate.noAgentHostConfigPath !==
        input.operationalHostConfigs.noAgentPreflightHostConfigPaths[index]
    ) {
      throw new TypeError(
        "R4 no-Agent Host config crossed its fixed case ordinal",
      );
    }
  }
};

const requiredEnvironment = (
  environment: NodeJS.ProcessEnv,
  name: string,
): string => {
  const value = environment[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`M7 R4 live infrastructure requires ${name}`);
  }
  if (!isAbsolute(value) || resolve(value) !== value) {
    throw new Error(`${name} must be a normalized absolute path`);
  }
  return value;
};

const pathWithinOrEqual = (parent: string, candidate: string): boolean => {
  const difference = relative(parent, candidate);
  return (
    difference === "" ||
    (difference !== ".." &&
      !difference.startsWith(`..${sep}`) &&
      !isAbsolute(difference))
  );
};

const currentUserId = (): number => {
  const uid = process.geteuid?.();
  if (uid === undefined) {
    throw new Error("M7 R4 live infrastructure requires Unix ownership");
  }
  return uid;
};

const canonicalDirectory = async (
  path: string,
  label: string,
  privateDirectory = false,
): Promise<string> => {
  const [canonical, metadata] = await Promise.all([
    realpath(path),
    lstat(path),
  ]);
  if (
    canonical !== path ||
    metadata.isSymbolicLink() ||
    !metadata.isDirectory()
  ) {
    throw new Error(`${label} must be a canonical real directory`);
  }
  if (
    privateDirectory &&
    (metadata.uid !== currentUserId() ||
      (metadata.mode & 0o7777) !== PRIVATE_DIRECTORY_MODE)
  ) {
    throw new Error(`${label} must be an owned mode-0700 directory`);
  }
  return path;
};

const canonicalFile = async (
  path: string,
  label: string,
  privateFile = false,
): Promise<string> => {
  const [canonical, metadata] = await Promise.all([
    realpath(path),
    lstat(path),
  ]);
  if (
    canonical !== path ||
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    metadata.nlink !== 1 ||
    (privateFile &&
      (metadata.uid !== currentUserId() ||
        (metadata.mode & 0o7777) !== PRIVATE_FILE_MODE))
  ) {
    throw new Error(`${label} must be a canonical one-link regular file`);
  }
  return path;
};

const readStableBytes = async (
  path: string,
  label: string,
  privateFile = false,
): Promise<Uint8Array> => {
  await canonicalFile(path, label, privateFile);
  const before = await lstat(path);
  if (before.size < 1 || before.size > MAX_FILE_BYTES) {
    throw new Error(`${label} byte length is unsupported`);
  }
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const opened = await handle.stat();
    if (
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.nlink !== 1
    ) {
      throw new Error(`${label} identity changed while opening`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      after.nlink !== 1
    ) {
      throw new Error(`${label} changed while reading`);
    }
    return Uint8Array.from(bytes);
  } finally {
    await handle.close();
  }
};

const readJson = async <T>(
  path: string,
  label: string,
  schema: z.ZodType<T>,
  privateFile = false,
): Promise<{ readonly bytes: Uint8Array; readonly value: T }> => {
  const bytes = await readStableBytes(path, label, privateFile);
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw new Error(`${label} is not valid UTF-8 JSON`, { cause: error });
  }
  return { bytes, value: schema.parse(value) };
};

const privatePackageBytes = async (root: string): Promise<Uint8Array> => {
  await canonicalDirectory(root, "R4 Adapter package", true);
  const files: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined) break;
    const names = await readdir(directory);
    names.sort((left, right) =>
      Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8")),
    );
    for (const name of names) {
      const path = join(directory, name);
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) {
        throw new Error("R4 Adapter package contains a symlink");
      }
      if (metadata.isDirectory()) {
        await canonicalDirectory(path, "R4 Adapter package directory", true);
        pending.push(path);
      } else {
        await canonicalFile(path, "R4 Adapter package file", true);
        files.push(path);
      }
    }
  }
  files.sort((left, right) =>
    relative(root, left).localeCompare(relative(root, right), "en"),
  );
  const chunks: Uint8Array[] = [];
  for (const path of files) {
    chunks.push(Buffer.from(relative(root, path), "utf8"));
    chunks.push(Buffer.from([0]));
    chunks.push(await readFile(path));
    chunks.push(Buffer.from([0]));
  }
  return Buffer.concat(chunks);
};

export interface M7R4VerifiedCaseMaterialsV1 {
  readonly ordinal: 1 | 2;
  readonly slug: "case-01" | "case-02";
  readonly manifest: z.infer<typeof caseManifestSchema>;
  readonly publicRoot: string;
  readonly privateRoot: string;
  readonly pristineProjectRoot: string;
  readonly mutantProjectRoot: string;
  readonly prompt: string;
  readonly runtimeTaskPath: string;
  readonly runtimeTask: z.infer<typeof ExternalHiddenFixPublicTaskSpecV1Schema>;
  readonly codeOnlyTaskPath: string;
  readonly codeOnlyTask: z.infer<
    typeof ExternalHiddenFixPublicTaskSpecV1Schema
  >;
  readonly pairedTaskContractBytes: Uint8Array;
  readonly trajectoryCaseSpec: z.infer<
    typeof M7R3PatrolTrajectoryCaseSpecV1Schema
  >;
  readonly mutationPath: string;
  readonly mutationBytes: Uint8Array;
  readonly evaluatorImplementationPath: string;
  readonly evaluatorImplementationBytes: Uint8Array;
  readonly evaluatorBundlePath: string;
  readonly evaluatorBundleBytes: Uint8Array;
  readonly preflightEvaluatorTemporaryRoot: string;
  readonly noAgentHostConfigPath: string;
}

export interface M7R4VerifiedLiveMaterialsV1 {
  readonly mode: M7R4LiveModeV1;
  readonly manifestPath: string;
  readonly manifestBytes: Uint8Array;
  readonly manifest: M7R4LiveMaterialManifestV1;
  readonly publicRoot: string;
  readonly staticHostOnlyRoot: string;
  readonly constructionRoot: string;
  readonly sensorRoot: string;
  readonly runsRoot: string;
  readonly adapterRevision: z.infer<typeof ProjectAdapterRevisionV1Schema>;
  readonly adapterPackageRoot: string;
  readonly adapterRevisionPath: string;
  readonly adapterConformancePath: string;
  readonly sensorFreezePath: string;
  readonly sensorFreeze: z.infer<typeof M7SensorFreezeRecordV1Schema>;
  readonly classifierFreeze: z.infer<
    typeof M7R3TrajectoryClassifierFreezeV1Schema
  >;
  readonly classifierFreezeBytes: Uint8Array;
  readonly hostConfig: ProjectEnvironmentHostConfigV1;
  readonly preflightImplementationManifestBytes: Uint8Array;
  readonly publicClassifierPath: string;
  readonly pairedAgentProtocolImplementationSha256: Sha256DigestV1;
  readonly hostModelRuntimeConfigSha256: Sha256DigestV1;
  readonly portfolioRoot: string;
  readonly preflightAttemptRoot: string;
  readonly operationalHostConfigs: M7R3PreparedOperationalHostConfigsV1;
  readonly realizedCgroupTopology: {
    readonly receiptPath: string;
    readonly receiptFileSha256: Sha256DigestV1;
    readonly receipt: M7R3RealizedCgroupTopologyReceiptV1;
  };
  readonly cases: readonly [
    M7R4VerifiedCaseMaterialsV1,
    M7R4VerifiedCaseMaterialsV1,
  ];
}

const orchestrationEnvironment = [
  [
    "containerEntrypointSha256",
    "CHRONORIFT_TEST_M7_R4_CONTAINER_ENTRYPOINT",
    "container-entrypoint",
  ],
  ["runWrapperSha256", "CHRONORIFT_TEST_M7_R4_RUN_WRAPPER", "run-wrapper"],
  [
    "staticAdmissionSha256",
    "CHRONORIFT_TEST_M7_R4_STATIC_ADMISSION",
    "static-admission",
  ],
  ["runControlSha256", "CHRONORIFT_TEST_M7_R4_RUN_CONTROL", "run-control"],
  [
    "liveTestConfigSha256",
    "CHRONORIFT_TEST_M7_R4_LIVE_TEST_CONFIG",
    "live-test-config",
  ],
  [
    "liveComposerSha256",
    "CHRONORIFT_TEST_M7_R4_LIVE_COMPOSER",
    "live-composer",
  ],
  [
    "operationalConfigComposerSha256",
    "CHRONORIFT_TEST_M7_R4_OPERATIONAL_CONFIG_COMPOSER",
    "operational-config-composer",
  ],
] as const;

export const verifyM7R4PromptTaskContractV1 = (input: {
  readonly ordinal: 1 | 2;
  readonly promptBytes: Uint8Array;
  readonly runtimeTaskBytes: Uint8Array;
  readonly codeOnlyTaskBytes: Uint8Array;
  readonly pairedTaskContractBytes: Uint8Array;
}): {
  readonly prompt: string;
  readonly runtimeTask: z.infer<typeof ExternalHiddenFixPublicTaskSpecV1Schema>;
  readonly codeOnlyTask: z.infer<
    typeof ExternalHiddenFixPublicTaskSpecV1Schema
  >;
} => {
  const decode = (bytes: Uint8Array, label: string): string => {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error) {
      throw new TypeError(`${label} must be UTF-8`, { cause: error });
    }
  };
  const promptWithNewline = decode(input.promptBytes, "R4 natural prompt");
  if (
    !promptWithNewline.endsWith("\n") ||
    promptWithNewline.slice(0, -1).length === 0 ||
    promptWithNewline.slice(0, -1).includes("\n")
  ) {
    throw new TypeError("R4 natural prompt must be one line plus one newline");
  }
  const prompt = promptWithNewline.slice(0, -1);
  const parseTask = (bytes: Uint8Array, label: string) => {
    let value: unknown;
    try {
      value = JSON.parse(decode(bytes, label));
    } catch (error) {
      throw new TypeError(`${label} must be JSON`, { cause: error });
    }
    return ExternalHiddenFixPublicTaskSpecV1Schema.parse(value);
  };
  const runtimeTask = parseTask(input.runtimeTaskBytes, "R4 runtime Task");
  const codeOnlyTask = parseTask(input.codeOnlyTaskBytes, "R4 code-only Task");
  let suppliedContract: unknown;
  try {
    suppliedContract = JSON.parse(
      decode(input.pairedTaskContractBytes, "R4 paired Task contract"),
    );
  } catch (error) {
    throw new TypeError("R4 paired Task contract must be JSON", {
      cause: error,
    });
  }
  const parsedContract =
    M7R3PairedPublicTaskContractV1Schema.parse(suppliedContract);
  const recreated = createM7R3PairedPublicTaskContractV1({
    caseOrdinal: input.ordinal,
    subjectRepository: parsedContract.subjectRepository,
    naturalPrompt: prompt,
    runtimeTaskSpecBytes: input.runtimeTaskBytes,
    codeOnlyTaskSpecBytes: input.codeOnlyTaskBytes,
  });
  if (
    !Buffer.from(encodeM7R3PairedPublicTaskContractV1(recreated)).equals(
      Buffer.from(input.pairedTaskContractBytes),
    ) ||
    runtimeTask.goal !== prompt ||
    codeOnlyTask.goal !== prompt
  ) {
    throw new TypeError("R4 prompt, Tasks, and paired contract disagree");
  }
  return Object.freeze({ prompt, runtimeTask, codeOnlyTask });
};

/**
 * Verifies the complete R4 byte graph without interpreting either prompt.
 * R4 reuses the M7R3 protocol DTOs; only the physical/operator namespace is
 * new. In particular, receipt-bound `m7-r3-*` identities are not rewritten.
 */
export async function verifyM7R4LiveMaterialsV1(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<M7R4VerifiedLiveMaterialsV1> {
  const mode = M7R4LiveModeV1Schema.parse(
    environment.CHRONORIFT_M7_R4_LIVE_MODE,
  );
  const publicRoot = await canonicalDirectory(
    requiredEnvironment(environment, "CHRONORIFT_TEST_M7_R4_PUBLIC_ROOT"),
    "R4 public root",
  );
  const staticHostOnlyRoot = await canonicalDirectory(
    requiredEnvironment(
      environment,
      "CHRONORIFT_TEST_M7_R4_STATIC_HOST_ONLY_ROOT",
    ),
    "R4 static Host-only root",
    true,
  );
  const constructionRoot = await canonicalDirectory(
    requiredEnvironment(environment, "CHRONORIFT_TEST_M7_R4_CONSTRUCTION_ROOT"),
    "R4 construction root",
    true,
  );
  const sensorRoot = await canonicalDirectory(
    requiredEnvironment(environment, "CHRONORIFT_TEST_M7_R4_SENSOR_ROOT"),
    "R4 sensor root",
    true,
  );
  const privateRoot = await canonicalDirectory(
    requiredEnvironment(environment, "CHRONORIFT_TEST_M7_R4_PRIVATE_ROOT"),
    "R4 mounted private root",
    true,
  );
  const runsRoot = await canonicalDirectory(
    requiredEnvironment(environment, "CHRONORIFT_TEST_M7_R4_RUNS_ROOT"),
    "R4 runs root",
    true,
  );
  const noAgentPortfolioRoot = await canonicalDirectory(
    join(runsRoot, "no-agent-preflight", "portfolio"),
    "R4 no-Agent portfolio root",
    true,
  );
  const noAgentConstructionRoot = await canonicalDirectory(
    join(runsRoot, "no-agent-preflight", "construction"),
    "R4 no-Agent construction root",
    true,
  );
  const declaredPreflightAttemptRoot = await canonicalDirectory(
    requiredEnvironment(
      environment,
      "CHRONORIFT_TEST_M7_R4_PREFLIGHT_CONTROL_ROOT",
    ),
    "R4 preflight attempt root",
    true,
  );
  const selectedOutputRoots = m7R4RunOutputRootsForModeV1({
    mode,
    declaredConstructionRoot: constructionRoot,
    declaredPreflightAttemptRoot,
    runsRoot,
  });
  const preflightAttemptRoot =
    selectedOutputRoots.preflightAttemptRoot === declaredPreflightAttemptRoot
      ? declaredPreflightAttemptRoot
      : await canonicalDirectory(
          selectedOutputRoots.preflightAttemptRoot,
          "R4 formal preflight attempt root",
          true,
        );
  if (
    (await readdir(noAgentConstructionRoot)).length !== 0 ||
    (await readdir(noAgentPortfolioRoot)).length !== 0 ||
    (await readdir(preflightAttemptRoot)).length !== 0
  ) {
    throw new Error("R4 no-Agent output roots must be fresh and empty");
  }
  const selectedConstructionRoot =
    selectedOutputRoots.constructionRoot === noAgentConstructionRoot
      ? noAgentConstructionRoot
      : constructionRoot;
  const portfolioRoot = await canonicalDirectory(
    selectedOutputRoots.portfolioRoot,
    "R4 selected portfolio root",
    true,
  );
  if ((await readdir(portfolioRoot)).length !== 0) {
    throw new Error("R4 selected portfolio root must be fresh and empty");
  }

  const manifestPath = requiredEnvironment(
    environment,
    "CHRONORIFT_TEST_M7_R4_MANIFEST",
  );
  const manifestFile = await readJson(
    manifestPath,
    "R4 live material manifest",
    M7R4LiveMaterialManifestV1Schema,
    true,
  );
  const manifest = manifestFile.value;

  const classifierImplementationPath = requiredEnvironment(
    environment,
    "CHRONORIFT_TEST_M7_R4_CLASSIFIER_IMPLEMENTATION",
  );
  const pairedAgentImplementationPath = requiredEnvironment(
    environment,
    "CHRONORIFT_TEST_M7_R4_PAIRED_AGENT_IMPLEMENTATION",
  );
  const preparationImplementationPath = requiredEnvironment(
    environment,
    "CHRONORIFT_TEST_M7_R4_PREPARATION_IMPLEMENTATION",
  );
  const preflightImplementationPath = requiredEnvironment(
    environment,
    "CHRONORIFT_TEST_M7_R4_PREFLIGHT_IMPLEMENTATION",
  );
  const casePreflightRunnerPath = requiredEnvironment(
    environment,
    "CHRONORIFT_TEST_M7_R4_CASE_PREFLIGHT_RUNNER",
  );
  const gameRuntimePath = requiredEnvironment(
    environment,
    "CHRONORIFT_TEST_M7_R4_GAME_RUNTIME_IMPLEMENTATION",
  );
  const wireClientPath = requiredEnvironment(
    environment,
    "CHRONORIFT_TEST_M7_R4_WIRE_CLIENT_IMPLEMENTATION",
  );
  const attemptRetentionPath = requiredEnvironment(
    environment,
    "CHRONORIFT_TEST_M7_R4_PREFLIGHT_ATTEMPT_RETENTION_IMPLEMENTATION",
  );
  const formalDriverPath = requiredEnvironment(
    environment,
    "CHRONORIFT_TEST_M7_R4_FORMAL_DRIVER_IMPLEMENTATION",
  );
  const liveMaterialsVerifierPath = requiredEnvironment(
    environment,
    "CHRONORIFT_TEST_M7_R4_LIVE_MATERIALS_IMPLEMENTATION",
  );
  const noAgentLiveImplementationPath = requiredEnvironment(
    environment,
    "CHRONORIFT_TEST_M7_R4_NO_AGENT_LIVE_IMPLEMENTATION",
  );
  const preflightManifestPath = requiredEnvironment(
    environment,
    "CHRONORIFT_TEST_M7_R4_PREFLIGHT_IMPLEMENTATION_MANIFEST",
  );
  const hostConfigPath = requiredEnvironment(
    environment,
    "CHRONORIFT_TEST_M7_R4_HOST_CONFIG",
  );
  const adapterPackageRoot = await canonicalDirectory(
    requiredEnvironment(environment, "CHRONORIFT_TEST_M7_R4_ADAPTER_PACKAGE"),
    "R4 Adapter package",
    true,
  );
  const adapterRevisionPath = requiredEnvironment(
    environment,
    "CHRONORIFT_TEST_M7_R4_ADAPTER_REVISION",
  );
  const adapterConformancePath = requiredEnvironment(
    environment,
    "CHRONORIFT_TEST_M7_R4_ADAPTER_CONFORMANCE",
  );
  const sensorFreezePath = requiredEnvironment(
    environment,
    "CHRONORIFT_TEST_M7_R4_SENSOR_FREEZE",
  );
  const classifierFreezePath = join(
    constructionRoot,
    "m7-r3.trajectory-classifier-freeze.json",
  );
  const eligibilityRoot = await canonicalDirectory(
    join(staticHostOnlyRoot, "eligibility"),
    "R4 source eligibility root",
    true,
  );
  const publicClassifierPath = join(publicRoot, "common", "classifier.mjs");

  const [
    classifierFreezeFile,
    classifierImplementationBytes,
    pairedAgentImplementationBytes,
    preparationImplementationBytes,
    preflightImplementationBytes,
    casePreflightRunnerBytes,
    gameRuntimeBytes,
    wireClientBytes,
    attemptRetentionBytes,
    formalDriverBytes,
    liveMaterialsVerifierBytes,
    noAgentLiveImplementationBytes,
    preflightManifestFile,
    publicClassifierBytes,
    adapterRevisionFile,
    adapterConformanceFile,
    sensorFreezeFile,
    adapterRawBytes,
    observationSchemaBytes,
    hostConfigBytes,
    orchestrationBytes,
    eligibilityConstruction,
    eligibilityPreflight,
    eligibilityMaterialManifest,
  ] = await Promise.all([
    readJson(
      classifierFreezePath,
      "R4 classifier freeze",
      M7R3TrajectoryClassifierFreezeV1Schema,
      true,
    ),
    readStableBytes(classifierImplementationPath, "R4 classifier source"),
    readStableBytes(pairedAgentImplementationPath, "R4 paired Agent source"),
    readStableBytes(preparationImplementationPath, "R4 preparation source"),
    readStableBytes(preflightImplementationPath, "R4 preflight PE source"),
    readStableBytes(casePreflightRunnerPath, "R4 preflight runner source"),
    readStableBytes(gameRuntimePath, "R4 game runtime source"),
    readStableBytes(wireClientPath, "R4 wire client source"),
    readStableBytes(attemptRetentionPath, "R4 preflight retention source"),
    readStableBytes(formalDriverPath, "R4 formal driver source"),
    readStableBytes(
      liveMaterialsVerifierPath,
      "R4 live-material verifier source",
    ),
    readStableBytes(noAgentLiveImplementationPath, "R4 no-Agent live source"),
    readJson(
      preflightManifestPath,
      "R4 preflight implementation manifest",
      M7R4PreflightImplementationManifestV1Schema,
      true,
    ),
    readStableBytes(publicClassifierPath, "R4 public classifier"),
    readJson(
      adapterRevisionPath,
      "R4 AdapterRevision",
      ProjectAdapterRevisionV1Schema,
      true,
    ),
    readJson(
      adapterConformancePath,
      "R4 Adapter conformance",
      AdapterConformanceReceiptV1Schema,
      true,
    ),
    readJson(
      sensorFreezePath,
      "R4 sensor freeze",
      M7SensorFreezeRecordV1Schema,
      true,
    ),
    privatePackageBytes(adapterPackageRoot),
    Promise.all([
      readStableBytes(
        join(adapterPackageRoot, "schemas/entity.patrol-agent.json"),
        "R4 entity observation schema",
        true,
      ),
      readStableBytes(
        join(adapterPackageRoot, "schemas/state.patrol-motion.json"),
        "R4 state observation schema",
        true,
      ),
    ]).then(([entity, state]) =>
      Buffer.concat([entity, Buffer.from([0]), state]),
    ),
    readStableBytes(hostConfigPath, "R4 Host config"),
    Promise.all(
      orchestrationEnvironment.map(async ([, name]) =>
        readStableBytes(requiredEnvironment(environment, name), name),
      ),
    ),
    readJson(
      join(eligibilityRoot, "case-01-construction.json"),
      "R4 replacement construction eligibility evidence",
      M7R3CaseConstructionReceiptV1Schema,
      true,
    ),
    readJson(
      join(eligibilityRoot, "case-01-no-agent-preflight.json"),
      "R4 replacement no-Agent eligibility evidence",
      M7R3CasePreflightReceiptV1Schema,
      true,
    ),
    readJson(
      join(eligibilityRoot, "disposable-live-materials.json"),
      "R4 replacement material eligibility evidence",
      z.record(z.string(), JsonValueSchema),
      true,
    ),
  ]);

  const common = manifest.common;
  const implementation = manifest.implementation;
  const preflightImplementationManifest = preflightManifestFile.value;
  const adapterRevision = adapterRevisionFile.value;
  const adapterConformance = adapterConformanceFile.value;
  const sensorFreeze = sensorFreezeFile.value;
  const classifierFreeze = classifierFreezeFile.value;
  if (
    digest(classifierFreezeFile.bytes) !== common.classifierFreezeFileSha256 ||
    classifierFreeze.recordContentSha256 !==
      common.classifierFreezeRecordContentSha256 ||
    digest(classifierImplementationBytes) !==
      common.classifierImplementationSha256 ||
    classifierFreeze.classifierImplementationSha256 !==
      common.classifierImplementationSha256 ||
    digest(pairedAgentImplementationBytes) !==
      common.pairedAgentProtocolImplementationSha256 ||
    digest(preparationImplementationBytes) !==
      common.projectEnvironmentPreparationImplementationSha256 ||
    digest(preflightImplementationBytes) !==
      common.preflightProjectEnvironmentImplementationSha256 ||
    digest(preflightManifestFile.bytes) !==
      common.preflightImplementationManifestFileSha256 ||
    digest(publicClassifierBytes) !== common.publicExecutionClassifierSha256 ||
    digest(adapterRevisionFile.bytes) !== common.adapterRevisionFileSha256 ||
    digest(adapterConformanceFile.bytes) !==
      common.adapterConformanceFileSha256 ||
    digest(sensorFreezeFile.bytes) !== common.sensorFreezeFileSha256 ||
    digest(adapterRawBytes) !== common.adapterPackageRawAggregateSha256 ||
    adapterRevision.packageDigest !==
      common.adapterPackageCanonicalIdentitySha256 ||
    digest(observationSchemaBytes) !==
      common.sensorObservationSchemaRawSha256 ||
    adapterRevision.payloadSchemaDigest !==
      common.adapterPayloadSchemaCanonicalIdentitySha256 ||
    digest(hostConfigBytes) !== common.hostConfigSha256 ||
    digest(casePreflightRunnerBytes) !==
      implementation.casePreflightRunnerSha256 ||
    digest(preflightImplementationBytes) !==
      implementation.preflightProjectEnvironmentSha256 ||
    digest(gameRuntimeBytes) !== implementation.gameRuntimeSha256 ||
    digest(wireClientBytes) !== implementation.wireClientSha256 ||
    digest(attemptRetentionBytes) !==
      implementation.attemptRetentionImplementationSha256 ||
    digest(formalDriverBytes) !==
      implementation.formalDriverImplementationSha256 ||
    digest(liveMaterialsVerifierBytes) !==
      implementation.liveMaterialsVerifierSha256 ||
    digest(noAgentLiveImplementationBytes) !==
      implementation.noAgentLiveImplementationSha256 ||
    preflightImplementationManifest.runnerImplementationSha256 !==
      implementation.casePreflightRunnerSha256 ||
    preflightImplementationManifest.projectEnvironmentImplementationSha256 !==
      implementation.preflightProjectEnvironmentSha256 ||
    sensorFreeze.sensor.adapterPackageSha256 !==
      common.adapterPackageRawAggregateSha256 ||
    sensorFreeze.sensor.observationSchemaSha256 !==
      common.sensorObservationSchemaRawSha256 ||
    classifierFreeze.authoritativeAdapter.adapterRevisionId !==
      adapterRevision.adapterRevisionId ||
    classifierFreeze.authoritativeAdapter.adapterRevisionRecordSha256 !==
      digestJson(adapterRevision) ||
    classifierFreeze.authoritativeAdapter.packageSha256 !==
      adapterRevision.packageDigest ||
    classifierFreeze.authoritativeAdapter.observationSchemaSha256 !==
      adapterRevision.payloadSchemaDigest ||
    classifierFreeze.authoritativeSensorFreezeId !==
      sensorFreeze.sensorFreezeId ||
    classifierFreeze.authoritativeSensorFreezeRecordSha256 !==
      sensorFreeze.recordSha256 ||
    adapterRevision.conformanceReceiptId !== adapterConformance.receiptId ||
    adapterRevision.sourceId !== adapterConformance.sourceId
  ) {
    throw new Error("R4 common frozen material graph changed");
  }
  for (let index = 0; index < orchestrationEnvironment.length; index += 1) {
    const [key] = orchestrationEnvironment[index]!;
    if (digest(orchestrationBytes[index]!) !== manifest.orchestration[key]) {
      throw new Error(`R4 orchestration source changed: ${key}`);
    }
  }
  const hostConfig = await readProjectEnvironmentHostConfigV1(hostConfigPath);
  const eligibilityMaterialContent =
    eligibilityMaterialManifest.value.recordContentSha256;
  if (
    eligibilityConstruction.value.ordinal !== 1 ||
    eligibilityConstruction.value.outcome !== "passed" ||
    eligibilityPreflight.value.ordinal !== 1 ||
    eligibilityPreflight.value.outcome !== "passed" ||
    eligibilityConstruction.value.recordContentSha256 !==
      manifest.sourceEligibility.replacementConstructionReceiptContentSha256 ||
    digest(eligibilityConstruction.bytes) !==
      manifest.sourceEligibility.replacementConstructionReceiptFileSha256 ||
    eligibilityPreflight.value.recordContentSha256 !==
      manifest.sourceEligibility
        .replacementNoAgentPreflightReceiptContentSha256 ||
    digest(eligibilityPreflight.bytes) !==
      manifest.sourceEligibility.replacementNoAgentPreflightReceiptFileSha256 ||
    typeof eligibilityMaterialContent !== "string" ||
    eligibilityMaterialContent !==
      manifest.sourceEligibility.replacementMaterialManifestContentSha256 ||
    digest(eligibilityMaterialManifest.bytes) !==
      manifest.sourceEligibility.replacementMaterialManifestFileSha256
  ) {
    throw new Error("R4 replacement source eligibility lineage changed");
  }
  const { recordContentSha256: eligibilityRecordHash, ...eligibilityBasis } =
    eligibilityMaterialManifest.value;
  if (eligibilityRecordHash !== digestJson(eligibilityBasis)) {
    throw new Error("R4 replacement material eligibility hash changed");
  }

  const staticCommonRoot = await canonicalDirectory(
    join(staticHostOnlyRoot, "common"),
    "R4 static common root",
    true,
  );
  const mountedSensorRoot = await canonicalDirectory(
    join(privateRoot, "sensor"),
    "R4 mounted sensor root",
    true,
  );
  const [staticCommonIdentity, sensorIdentity, mountedSensorIdentity] =
    await Promise.all([
      lstat(staticCommonRoot),
      lstat(sensorRoot),
      lstat(mountedSensorRoot),
    ]);
  if (
    staticCommonIdentity.dev !== sensorIdentity.dev ||
    staticCommonIdentity.ino !== sensorIdentity.ino ||
    mountedSensorIdentity.dev !== sensorIdentity.dev ||
    mountedSensorIdentity.ino !== sensorIdentity.ino
  ) {
    throw new Error("R4 common sensor authority mount changed");
  }

  const cases: M7R4VerifiedCaseMaterialsV1[] = [];
  for (const ordinal of [1, 2] as const) {
    const slug = `case-0${String(ordinal)}` as "case-01" | "case-02";
    const caseManifest = ordinal === 1 ? manifest.cases[0] : manifest.cases[1];
    const publicCaseRoot = await canonicalDirectory(
      join(publicRoot, slug),
      `${slug} public root`,
    );
    const staticPrivateCaseRoot = await canonicalDirectory(
      join(staticHostOnlyRoot, slug),
      `${slug} static private root`,
      true,
    );
    const mountedPrivateCaseRoot = await canonicalDirectory(
      join(privateRoot, slug),
      `${slug} mounted private root`,
      true,
    );
    const mountedMaterialRoot = await canonicalDirectory(
      join(mountedPrivateCaseRoot, "materials"),
      `${slug} mounted material root`,
      true,
    );
    const [staticIdentity, mountedIdentity] = await Promise.all([
      lstat(staticPrivateCaseRoot),
      lstat(mountedMaterialRoot),
    ]);
    if (
      staticIdentity.dev !== mountedIdentity.dev ||
      staticIdentity.ino !== mountedIdentity.ino
    ) {
      throw new Error(`${slug} private material authority mount changed`);
    }
    const pristineProjectRoot = await canonicalDirectory(
      requiredEnvironment(
        environment,
        `CHRONORIFT_TEST_M7_R4_CASE_0${String(ordinal)}_PRISTINE`,
      ),
      `${slug} pristine authority`,
    );
    const mutantProjectRoot = await canonicalDirectory(
      requiredEnvironment(
        environment,
        `CHRONORIFT_TEST_M7_R4_CASE_0${String(ordinal)}_MUTANT`,
      ),
      `${slug} mutant authority`,
    );
    const promptPath = join(publicCaseRoot, "prompt.txt");
    const runtimeTaskPath = join(publicCaseRoot, "task-runtime.json");
    const codeOnlyTaskPath = join(publicCaseRoot, "task-code-only.json");
    const pairedTaskContractPath = join(
      publicCaseRoot,
      "paired-task-contract.json",
    );
    const trajectoryCaseSpecPath = join(
      mountedMaterialRoot,
      "trajectory-case-spec.json",
    );
    const mutationPath = join(mountedMaterialRoot, "mutation.patch");
    const evaluatorImplementationPath = join(
      mountedMaterialRoot,
      "evaluator.mjs",
    );
    const evaluatorBundlePath = join(
      mountedMaterialRoot,
      "evaluator-bundle.json",
    );
    const [
      promptBytes,
      runtimeTaskFile,
      codeOnlyTaskFile,
      pairedTaskContractFile,
      trajectoryCaseSpecFile,
      mutationBytes,
      evaluatorImplementationBytes,
      evaluatorBundleBytes,
      pristineEntries,
      mutantEntries,
    ] = await Promise.all([
      readStableBytes(promptPath, `${slug} prompt`),
      readJson(
        runtimeTaskPath,
        `${slug} runtime Task`,
        ExternalHiddenFixPublicTaskSpecV1Schema,
      ),
      readJson(
        codeOnlyTaskPath,
        `${slug} code-only Task`,
        ExternalHiddenFixPublicTaskSpecV1Schema,
      ),
      readJson(
        pairedTaskContractPath,
        `${slug} paired Task contract`,
        M7R3PairedPublicTaskContractV1Schema,
      ),
      readJson(
        trajectoryCaseSpecPath,
        `${slug} trajectory case spec`,
        M7R3PatrolTrajectoryCaseSpecV1Schema,
        true,
      ),
      readStableBytes(mutationPath, `${slug} mutation`, true),
      readStableBytes(
        evaluatorImplementationPath,
        `${slug} evaluator implementation`,
        true,
      ),
      readStableBytes(evaluatorBundlePath, `${slug} evaluator bundle`, true),
      collectCandidateGodotSourceV1(
        pristineProjectRoot,
        "project-environment",
        "tracked-tool-scripts-v1",
      ),
      collectCandidateGodotSourceV1(
        mutantProjectRoot,
        "project-environment",
        "tracked-tool-scripts-v1",
      ),
    ]);
    const promptTaskBinding = verifyM7R4PromptTaskContractV1({
      ordinal,
      promptBytes,
      runtimeTaskBytes: runtimeTaskFile.bytes,
      codeOnlyTaskBytes: codeOnlyTaskFile.bytes,
      pairedTaskContractBytes: pairedTaskContractFile.bytes,
    });
    const prompt = promptTaskBinding.prompt;
    const pristineTree = selectedTreeSha256(pristineEntries);
    const mutantTree = selectedTreeSha256(mutantEntries);
    if (
      digest(promptBytes) !== caseManifest.promptFileSha256 ||
      digest(runtimeTaskFile.bytes) !== caseManifest.runtimeTaskSpecSha256 ||
      digest(codeOnlyTaskFile.bytes) !== caseManifest.codeOnlyTaskSpecSha256 ||
      digest(pairedTaskContractFile.bytes) !==
        caseManifest.pairedTaskContractFileSha256 ||
      pairedTaskContractFile.value.recordContentSha256 !==
        caseManifest.pairedTaskContractContentSha256 ||
      runtimeTaskFile.value.goal !== prompt ||
      codeOnlyTaskFile.value.goal !== prompt ||
      runtimeTaskFile.value.taskId === codeOnlyTaskFile.value.taskId ||
      runtimeTaskFile.value.publicExecutionClassifier.implementationSha256 !==
        common.publicExecutionClassifierSha256 ||
      digest(trajectoryCaseSpecFile.bytes) !==
        caseManifest.trajectoryCaseSpecFileSha256 ||
      trajectoryCaseSpecFile.value.caseSpecSha256 !==
        caseManifest.trajectoryCaseSpecSha256 ||
      trajectoryCaseSpecFile.value.classifierImplementationSha256 !==
        common.classifierImplementationSha256 ||
      trajectoryCaseSpecFile.value.classifierId !==
        classifierFreeze.classifierId ||
      digest(mutationBytes) !== caseManifest.mutationSha256 ||
      mutationBytes.byteLength !== caseManifest.mutationByteLength ||
      digest(evaluatorImplementationBytes) !==
        caseManifest.evaluatorImplementationSha256 ||
      evaluatorImplementationBytes.byteLength !==
        caseManifest.evaluatorImplementationByteLength ||
      digest(evaluatorBundleBytes) !== caseManifest.evaluatorBundleSha256 ||
      evaluatorBundleBytes.byteLength !==
        caseManifest.evaluatorBundleByteLength ||
      pristineTree !== caseManifest.pristineSelectedTreeSha256 ||
      mutantTree !== caseManifest.mutatedSelectedTreeSha256 ||
      pristineTree === mutantTree ||
      pristineTree !== classifierFreeze.pristineSubject.selectedTreeSha256 ||
      caseManifest.pristineCommit !==
        classifierFreeze.pristineSubject.revision ||
      runtimeTaskFile.value.subjectCommit !== caseManifest.pristineCommit ||
      codeOnlyTaskFile.value.subjectCommit !== caseManifest.pristineCommit ||
      caseManifest.ordinal !== ordinal ||
      caseManifest.slug !== slug ||
      !sameJson(
        runtimeTaskFile.value.agentBudget,
        codeOnlyTaskFile.value.agentBudget,
      ) ||
      !sameJson(
        runtimeTaskFile.value.evaluatorBudget,
        codeOnlyTaskFile.value.evaluatorBudget,
      )
    ) {
      throw new Error(`${slug} frozen material graph changed`);
    }
    cases.push({
      ordinal,
      slug,
      manifest: caseManifest,
      publicRoot: publicCaseRoot,
      privateRoot: mountedPrivateCaseRoot,
      pristineProjectRoot,
      mutantProjectRoot,
      prompt,
      runtimeTaskPath,
      runtimeTask: runtimeTaskFile.value,
      codeOnlyTaskPath,
      codeOnlyTask: codeOnlyTaskFile.value,
      pairedTaskContractBytes: pairedTaskContractFile.bytes,
      trajectoryCaseSpec: trajectoryCaseSpecFile.value,
      mutationPath,
      mutationBytes,
      evaluatorImplementationPath,
      evaluatorImplementationBytes,
      evaluatorBundlePath,
      evaluatorBundleBytes,
      preflightEvaluatorTemporaryRoot: await canonicalDirectory(
        join(runsRoot, "evaluator-temp", slug, "preflight"),
        `${slug} preflight evaluator temporary root`,
        true,
      ),
      noAgentHostConfigPath: requiredEnvironment(
        environment,
        `CHRONORIFT_TEST_M7_R4_CASE_0${String(ordinal)}_NO_AGENT_HOST_CONFIG`,
      ),
    });
  }
  if (cases[0] === undefined || cases[1] === undefined) {
    throw new Error("R4 requires exactly two frozen cases");
  }

  const operationalRoot = await canonicalDirectory(
    requiredEnvironment(
      environment,
      "CHRONORIFT_TEST_M7_R4_OPERATIONAL_CONFIG_ROOT",
    ),
    "R4 operational config root",
    true,
  );
  const operationalHostConfigs = await createM7R3OperationalHostConfigsOnceV1({
    operationalRoot,
    runMode: mode === "r4-live" ? "r3-live" : "pre-agent-dry-run",
    liveMaterialManifestPath: manifestPath,
    liveMaterialManifestBytes: manifestFile.bytes,
    liveMaterialManifestRecordContentSha256: manifest.recordContentSha256,
    baseHostConfigPath: hostConfigPath,
    baseHostConfigBytes: hostConfigBytes,
    baseHostConfig: hostConfig,
    orchestrationSources: [
      {
        sourceKind: "container-entrypoint",
        sourcePath: requiredEnvironment(
          environment,
          orchestrationEnvironment[0][1],
        ),
        sourceFileSha256: digest(orchestrationBytes[0]!),
      },
      {
        sourceKind: "run-wrapper",
        sourcePath: requiredEnvironment(
          environment,
          orchestrationEnvironment[1][1],
        ),
        sourceFileSha256: digest(orchestrationBytes[1]!),
      },
      {
        sourceKind: "static-admission",
        sourcePath: requiredEnvironment(
          environment,
          orchestrationEnvironment[2][1],
        ),
        sourceFileSha256: digest(orchestrationBytes[2]!),
      },
      {
        sourceKind: "run-control",
        sourcePath: requiredEnvironment(
          environment,
          orchestrationEnvironment[3][1],
        ),
        sourceFileSha256: digest(orchestrationBytes[3]!),
      },
      {
        sourceKind: "live-test-config",
        sourcePath: requiredEnvironment(
          environment,
          orchestrationEnvironment[4][1],
        ),
        sourceFileSha256: digest(orchestrationBytes[4]!),
      },
      {
        sourceKind: "live-composer",
        sourcePath: requiredEnvironment(
          environment,
          orchestrationEnvironment[5][1],
        ),
        sourceFileSha256: digest(orchestrationBytes[5]!),
      },
      {
        sourceKind: "operational-config-composer",
        sourcePath: requiredEnvironment(
          environment,
          orchestrationEnvironment[6][1],
        ),
        sourceFileSha256: digest(orchestrationBytes[6]!),
      },
    ],
    sealedAt: new Date().toISOString(),
  });
  const realizedCgroupTopology = await sealM7R3RealizedCgroupTopologyOnceV1({
    operationalRoot,
    operational: operationalHostConfigs,
    observedAt: new Date().toISOString(),
  });
  assertM7R4NoAgentHostConfigBindingsV1({
    operationalHostConfigs,
    cases: [cases[0], cases[1]],
  });
  for (const materials of cases) {
    await canonicalFile(
      materials.noAgentHostConfigPath,
      `${materials.slug} no-Agent Host config`,
      true,
    );
  }
  const verifiedCases: readonly [
    M7R4VerifiedCaseMaterialsV1,
    M7R4VerifiedCaseMaterialsV1,
  ] = Object.freeze([cases[0], cases[1]]);

  return Object.freeze({
    mode,
    manifestPath,
    manifestBytes: manifestFile.bytes,
    manifest,
    publicRoot,
    staticHostOnlyRoot,
    constructionRoot: selectedConstructionRoot,
    sensorRoot,
    runsRoot,
    adapterRevision,
    adapterPackageRoot,
    adapterRevisionPath,
    adapterConformancePath,
    sensorFreezePath,
    sensorFreeze,
    classifierFreeze,
    classifierFreezeBytes: classifierFreezeFile.bytes,
    hostConfig,
    preflightImplementationManifestBytes: preflightManifestFile.bytes,
    publicClassifierPath,
    pairedAgentProtocolImplementationSha256:
      common.pairedAgentProtocolImplementationSha256,
    hostModelRuntimeConfigSha256: common.hostModelRuntimeConfigSha256,
    portfolioRoot,
    preflightAttemptRoot,
    operationalHostConfigs,
    realizedCgroupTopology,
    cases: verifiedCases,
  });
}

export const m7R4PathWithinOrEqualForTestingV1 = pathWithinOrEqual;
