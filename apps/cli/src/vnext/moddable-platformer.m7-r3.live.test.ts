import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rm,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { PROJECT_ENVIRONMENT_GAME_TOOL_DEFINITIONS_V1 } from "@chronorift/agent-protocol";
import {
  AdapterConformanceReceiptV1Schema,
  JsonValueSchema,
  ProjectAdapterRevisionV1Schema,
  Sha256DigestV1Schema,
  asSha256DigestV1,
  type JsonValue,
  type Sha256DigestV1,
} from "@chronorift/domain";
import { canonicalJson } from "@chronorift/json-artifacts";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { collectCandidateGodotSourceV1 } from "./candidate-godot-build.js";
import {
  ExternalHiddenFixPublicTaskSpecV1Schema,
  prepareExternalHiddenFixAssignmentV1,
  type ExternalHiddenFixPublicTaskSpecV1,
} from "./external-hidden-fix-assignment.js";
import {
  BwrapExternalHiddenFixEvaluatorProcessV1,
  LocalExternalHiddenFixFreshCopyRunnerV1,
  LocalExternalHiddenFixPatchStoreV1,
  type ExternalHiddenFixEvaluatorProcessPortV1,
} from "./external-hidden-fix-evaluator.js";
import {
  prepareM6ProjectEnvironmentOneTurnTaskV1,
  type M6PublicExecutionClassifierV1,
} from "./m6-project-environment-one-turn.js";
import {
  M7R3TrajectoryClassifierFreezeV1Schema,
  createM7R3MutationRegistrationV1,
  openM7R3CaseConstructionStoreV1,
  projectM7R3ClassifierFreezeToPortfolioV1,
  projectM7R3ConstructionToPortfolioCaseV1,
  type M7R3CaseConstructionReceiptV1,
  type M7R3CaseConstructionStoreV1,
  type M7R3TrajectoryClassifierFreezeV1,
} from "./m7-r3-case-construction.js";
import {
  createM7R3NaturalUserPromptV1,
  createM7R3PairedCaseContractV1,
  type M7R3PairedCaseContractV1,
} from "./m7-r3-paired-agent.js";
import {
  M7R3PairedPublicTaskContractV1Schema,
  createM7R3PairedPublicTaskContractV1,
  encodeM7R3PairedPublicTaskContractV1,
} from "./m7-r3-public-task.js";
import {
  M7_R3_NEUTRAL_ENVIRONMENT_INSTRUCTIONS_SHA256_V1,
  prepareM7R3ProjectEnvironmentPairedAgentPortV1,
} from "./m7-r3-project-environment-paired-agent.js";
import {
  prepareM7R3ProjectEnvironmentInfrastructureV1,
  type M7R3PreparedProjectEnvironmentInfrastructureV1,
} from "./m7-r3-project-environment-preparation.js";
import {
  M7R3CampaignInfrastructureFailureInputV1Schema,
  asM7R3TwoCaseLocalPortfolioStorePortV1,
  runM7R3TwoCaseLocalPortfolioV1,
  type M7R3PreparedLocalCaseCampaignV1,
  type M7R3TwoCaseLocalCasePlanV1,
} from "./m7-r3-two-case-local-portfolio.js";
import {
  createM7R3OperationalHostConfigsOnceV1,
  m7R3OperationalHostConfigPathsForCaseV1,
  sealM7R3RealizedCgroupTopologyOnceV1,
  type M7R3PreparedOperationalHostConfigsV1,
  type M7R3RealizedCgroupTopologyReceiptV1,
} from "./m7-r3-live-operational-config.js";
import {
  runM7R3TwoCasePreflightV1,
  type M7R3HiddenEvaluatorPreflightPortV1,
  type M7R3HiddenEvaluatorPreflightRequestV1,
  type M7R3TwoCasePreflightRunResultV1,
} from "./m7-r3-case-preflight-runner.js";
import {
  prepareM7R3NoAgentProjectEnvironmentPreflightPortV1,
  type PreparedM7R3NoAgentProjectEnvironmentPreflightPortV1,
} from "./m7-r3-project-environment-preflight.js";
import {
  createM7R3LocalHiddenEvaluatorPortV1,
  M7R3RuntimeUseLocalEvidenceStoreV1,
} from "./m7-r3-runtime-use-local-gate.js";
import {
  createM7R3TwoCasePortfolioFreezeV1,
  openM7R3TwoCasePortfolioStoreV1,
  type CreateM7R3TwoCasePortfolioFreezeV1Input,
  type M7R3TwoCasePortfolioFreezeV1,
} from "./m7-r3-two-case-portfolio.js";
import { openM7R3CaseCampaignAdmissionStoreV1 } from "./m7-r3-case-admission.js";
import {
  M7_PATROL_TRAJECTORY_CLASSIFIER_CONFIG_V1,
  M7R3PatrolTrajectoryCaseSpecV1Schema,
} from "./m7-patrol-trajectory.js";
import {
  M7SensorFreezeRecordV1Schema,
  type M7SensorFreezeRecordV1,
} from "./m7-patrol-sensor.js";
import { M7RuntimeUseLocalMutationStoreV1 } from "./m7-runtime-use-local-gate.js";
import {
  createM7CampaignSensorBindingV1,
  createM7MutationRegistrationV1,
  deriveM7BuildSourceIdentitySha256V1,
  openM7RuntimeUseCampaignStoreV1,
  type M7MutationRegistrationV1,
} from "./m7-runtime-use-campaign.js";
import {
  readProjectEnvironmentHostConfigV1,
  type ProjectEnvironmentHostConfigV1,
} from "./project-environment-host-config.js";
import { selectedTreeSha256 } from "./selected-tree.js";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MAX_JSON_BYTES = 16 * 1024 * 1024;

const EXACT_PROMPTS = [
  "Patrolling enemies move inconsistently on sloped terrain: their pace changes with the incline and they can lose contact on descents. Fix the behavior without changing the level layout or the meaning of enemies configured to fall from edges. Leave a reviewable candidate change.",
  "Some patrolling enemies eventually stop moving and never resume even though the game is still running. Investigate and fix the behavior without changing their configured speeds or the level layout. Leave a reviewable candidate change.",
] as const;

const digest = (bytes: string | Uint8Array): Sha256DigestV1 =>
  asSha256DigestV1(createHash("sha256").update(bytes).digest("hex"));
const digestJson = (value: unknown): Sha256DigestV1 =>
  digest(canonicalJson(JsonValueSchema.parse(value)));
const sameJson = (left: unknown, right: unknown): boolean =>
  canonicalJson(JsonValueSchema.parse(left)) ===
  canonicalJson(JsonValueSchema.parse(right));
const asError = (value: unknown, message: string): Error =>
  value instanceof Error ? value : new Error(message, { cause: value });

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

const manifestBasisSchema = z
  .object({
    schemaVersion: z.literal(1),
    recordKind: z.literal("m7-r3-live-material-manifest"),
    frozenBeforeAnyAgent: z.literal(true),
    frozenAt: z.string().datetime({ offset: true }),
    common: z
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
      .strict(),
    cases: z.tuple([caseManifestSchema, caseManifestSchema]),
  })
  .strict();

const liveManifestSchema = manifestBasisSchema
  .extend({ recordContentSha256: Sha256DigestV1Schema })
  .strict()
  .superRefine((value, context) => {
    const { recordContentSha256, ...basis } = value;
    if (recordContentSha256 !== digestJson(basis)) {
      context.addIssue({
        code: "custom",
        path: ["recordContentSha256"],
        message: "R3 live material manifest content hash does not match",
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
        message: "R3 live cases must remain in fixed order 1 then 2",
      });
    }
  });
type LiveManifest = z.infer<typeof liveManifestSchema>;

const preflightImplementationManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    recordKind: z.literal("m7-r3-preflight-implementation-manifest"),
    runnerImplementationSha256: Sha256DigestV1Schema,
    projectEnvironmentImplementationSha256: Sha256DigestV1Schema,
    recordContentSha256: Sha256DigestV1Schema,
  })
  .strict()
  .superRefine((value, context) => {
    const { recordContentSha256, ...basis } = value;
    if (recordContentSha256 !== digestJson(basis)) {
      context.addIssue({
        code: "custom",
        path: ["recordContentSha256"],
        message: "preflight implementation manifest hash does not match",
      });
    }
  });

const requiredEnvironment = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`M7 R3 live infrastructure requires ${name}`);
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
    throw new Error("M7 R3 live infrastructure requires Unix ownership");
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
  if (before.size < 1 || before.size > MAX_JSON_BYTES) {
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
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw new Error(`${label} is not valid UTF-8 JSON`, { cause: error });
  }
  return { bytes, value: schema.parse(raw) };
};

const privatePackageBytes = async (root: string): Promise<Uint8Array> => {
  await canonicalDirectory(root, "R3 Adapter package", true);
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
        throw new Error("R3 Adapter package contains a symlink");
      }
      if (metadata.isDirectory()) {
        await canonicalDirectory(path, "R3 Adapter package directory", true);
        pending.push(path);
      } else {
        await canonicalFile(path, "R3 Adapter package file", true);
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

const loadPublicExecutionClassifier = async (input: {
  readonly publicRoot: string;
  readonly implementationPath: string;
  readonly publicTask: ExternalHiddenFixPublicTaskSpecV1;
}): Promise<M6PublicExecutionClassifierV1> => {
  if (!pathWithinOrEqual(input.publicRoot, input.implementationPath)) {
    throw new Error("R3 public execution classifier escaped the public root");
  }
  const bytes = await readStableBytes(
    input.implementationPath,
    "R3 public execution classifier",
  );
  const implementationSha256 = digest(bytes);
  if (
    implementationSha256 !==
    input.publicTask.publicExecutionClassifier.implementationSha256
  ) {
    throw new Error("R3 public execution classifier bytes changed");
  }
  const loaded: unknown = await import(
    `${pathToFileURL(input.implementationPath).href}?sha256=${implementationSha256}`
  );
  const classify =
    typeof loaded === "object" &&
    loaded !== null &&
    "classifyM6PublicExecutionV1" in loaded
      ? loaded.classifyM6PublicExecutionV1
      : undefined;
  if (typeof classify !== "function") {
    throw new Error(
      "R3 public classifier must export classifyM6PublicExecutionV1",
    );
  }
  return Object.freeze({
    identity: input.publicTask.publicExecutionClassifier,
    classify: async (
      classifierInput: Parameters<M6PublicExecutionClassifierV1["classify"]>[0],
    ) => {
      const output: unknown = await Reflect.apply(classify, undefined, [
        classifierInput,
      ]);
      if (
        typeof output !== "object" ||
        output === null ||
        !("publicSymptomObserved" in output) ||
        typeof output.publicSymptomObserved !== "boolean" ||
        !("observation" in output)
      ) {
        throw new Error("R3 public classifier returned an invalid M6 view");
      }
      return Object.freeze({
        publicSymptomObserved: output.publicSymptomObserved,
        observation: JsonValueSchema.parse(output.observation),
      });
    },
  });
};

interface CaseMaterials {
  readonly ordinal: 1 | 2;
  readonly slug: "case-01" | "case-02";
  readonly manifest: z.infer<typeof caseManifestSchema>;
  readonly publicRoot: string;
  readonly privateRoot: string;
  readonly assignmentRoot: string;
  readonly pristineProjectRoot: string;
  readonly mutantProjectRoot: string;
  readonly prompt: string;
  readonly runtimeTaskPath: string;
  readonly runtimeTask: ExternalHiddenFixPublicTaskSpecV1;
  readonly codeOnlyTaskPath: string;
  readonly codeOnlyTask: ExternalHiddenFixPublicTaskSpecV1;
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
  readonly campaignRoot: string;
  readonly evidenceRoot: string;
  readonly preflightEvaluatorTemporaryRoot: string;
  readonly runtimePatchRoot: string;
  readonly codeOnlyPatchRoot: string;
  readonly runtimeEvaluatorTemporaryRoot: string;
  readonly codeOnlyEvaluatorTemporaryRoot: string;
  readonly runtimeAgentResourceRoot: string;
  readonly codeOnlyAgentResourceRoot: string;
  readonly runtimeDurableRecordRoot: string;
  readonly codeOnlyDurableRecordRoot: string;
}

interface LiveMaterials {
  readonly mode: "pre-agent-dry-run" | "r3-live";
  readonly manifest: LiveManifest;
  readonly publicRoot: string;
  readonly staticHostOnlyRoot: string;
  readonly constructionRoot: string;
  readonly sensorRoot: string;
  readonly runsRoot: string;
  readonly adapterPackageRoot: string;
  readonly adapterRevisionPath: string;
  readonly adapterConformancePath: string;
  readonly sensorFreezePath: string;
  readonly adapterRevision: ReturnType<
    typeof ProjectAdapterRevisionV1Schema.parse
  >;
  readonly sensorFreeze: M7SensorFreezeRecordV1;
  readonly classifierFreeze: M7R3TrajectoryClassifierFreezeV1;
  readonly classifierImplementationBytes: Uint8Array;
  readonly preflightImplementationManifestBytes: Uint8Array;
  readonly publicClassifierPath: string;
  readonly pairedAgentProtocolImplementationSha256: Sha256DigestV1;
  readonly hostConfig: ProjectEnvironmentHostConfigV1;
  readonly operationalHostConfigs: M7R3PreparedOperationalHostConfigsV1;
  readonly realizedCgroupTopology: {
    readonly receiptPath: string;
    readonly receiptFileSha256: Sha256DigestV1;
    readonly receipt: M7R3RealizedCgroupTopologyReceiptV1;
  };
  readonly hostModelRuntimeConfigSha256: Sha256DigestV1;
  readonly portfolioRoot: string;
  readonly cases: readonly [CaseMaterials, CaseMaterials];
}

const verifyLiveMaterials = async (): Promise<LiveMaterials> => {
  const mode = z
    .enum(["pre-agent-dry-run", "r3-live"])
    .parse(process.env.CHRONORIFT_M7_R3_LIVE_MODE);
  const publicRoot = await canonicalDirectory(
    requiredEnvironment("CHRONORIFT_TEST_M7_R3_PUBLIC_ROOT"),
    "R3 public root",
    true,
  );
  const staticHostOnlyRoot = await canonicalDirectory(
    requiredEnvironment("CHRONORIFT_TEST_M7_R3_STATIC_HOST_ONLY_ROOT"),
    "R3 static Host-only root",
    true,
  );
  const constructionRoot = await canonicalDirectory(
    requiredEnvironment("CHRONORIFT_TEST_M7_R3_CONSTRUCTION_ROOT"),
    "R3 construction root",
    true,
  );
  const sensorRoot = await canonicalDirectory(
    requiredEnvironment("CHRONORIFT_TEST_M7_R3_SENSOR_ROOT"),
    "R3 sensor root",
    true,
  );
  const staticCommonRoot = await canonicalDirectory(
    join(staticHostOnlyRoot, "common"),
    "R3 static common root",
    true,
  );
  const [staticCommonIdentity, sensorAuthorityIdentity] = await Promise.all([
    lstat(staticCommonRoot),
    lstat(sensorRoot),
  ]);
  if (
    staticCommonIdentity.dev !== sensorAuthorityIdentity.dev ||
    staticCommonIdentity.ino !== sensorAuthorityIdentity.ino
  ) {
    throw new Error("R3 common sensor authority mount changed");
  }
  const runsRoot = await canonicalDirectory(
    requiredEnvironment("CHRONORIFT_TEST_M7_R3_RUNS_ROOT"),
    "R3 runs root",
    true,
  );
  const operationalConfigRoot = await canonicalDirectory(
    requiredEnvironment("CHRONORIFT_TEST_M7_R3_OPERATIONAL_CONFIG_ROOT"),
    "R3 operational config root",
    true,
  );
  const manifestPath = requiredEnvironment("CHRONORIFT_TEST_M7_R3_MANIFEST");
  const manifestFile = await readJson(
    manifestPath,
    "R3 live material manifest",
    liveManifestSchema,
    true,
  );
  const manifest = manifestFile.value;
  const classifierImplementationPath = requiredEnvironment(
    "CHRONORIFT_TEST_M7_R3_CLASSIFIER_IMPLEMENTATION",
  );
  const pairedAgentImplementationPath = requiredEnvironment(
    "CHRONORIFT_TEST_M7_R3_PAIRED_AGENT_IMPLEMENTATION",
  );
  const projectEnvironmentPreparationImplementationPath = requiredEnvironment(
    "CHRONORIFT_TEST_M7_R3_PREPARATION_IMPLEMENTATION",
  );
  const preflightImplementationPath = requiredEnvironment(
    "CHRONORIFT_TEST_M7_R3_PREFLIGHT_IMPLEMENTATION",
  );
  const preflightImplementationManifestPath = requiredEnvironment(
    "CHRONORIFT_TEST_M7_R3_PREFLIGHT_IMPLEMENTATION_MANIFEST",
  );
  const hostConfigPath = requiredEnvironment(
    "CHRONORIFT_TEST_M7_R3_HOST_CONFIG",
  );
  const orchestrationSourcePaths = Object.freeze([
    Object.freeze({
      sourceKind: "container-entrypoint" as const,
      sourcePath: requiredEnvironment(
        "CHRONORIFT_TEST_M7_R3_CONTAINER_ENTRYPOINT",
      ),
    }),
    Object.freeze({
      sourceKind: "run-wrapper" as const,
      sourcePath: requiredEnvironment("CHRONORIFT_TEST_M7_R3_RUN_WRAPPER"),
    }),
    Object.freeze({
      sourceKind: "static-admission" as const,
      sourcePath: requiredEnvironment("CHRONORIFT_TEST_M7_R3_STATIC_ADMISSION"),
    }),
    Object.freeze({
      sourceKind: "run-control" as const,
      sourcePath: requiredEnvironment("CHRONORIFT_TEST_M7_R3_RUN_CONTROL"),
    }),
    Object.freeze({
      sourceKind: "live-test-config" as const,
      sourcePath: requiredEnvironment("CHRONORIFT_TEST_M7_R3_LIVE_TEST_CONFIG"),
    }),
    Object.freeze({
      sourceKind: "live-composer" as const,
      sourcePath: requiredEnvironment("CHRONORIFT_TEST_M7_R3_LIVE_COMPOSER"),
    }),
    Object.freeze({
      sourceKind: "operational-config-composer" as const,
      sourcePath: requiredEnvironment(
        "CHRONORIFT_TEST_M7_R3_OPERATIONAL_CONFIG_COMPOSER",
      ),
    }),
  ] as const);
  const adapterPackageRoot = await canonicalDirectory(
    requiredEnvironment("CHRONORIFT_TEST_M7_R3_ADAPTER_PACKAGE"),
    "R3 Adapter package",
    true,
  );
  const adapterRevisionPath = requiredEnvironment(
    "CHRONORIFT_TEST_M7_R3_ADAPTER_REVISION",
  );
  const adapterConformancePath = requiredEnvironment(
    "CHRONORIFT_TEST_M7_R3_ADAPTER_CONFORMANCE",
  );
  const sensorFreezePath = requiredEnvironment(
    "CHRONORIFT_TEST_M7_R3_SENSOR_FREEZE",
  );
  const classifierFreezePath = join(
    constructionRoot,
    "m7-r3.trajectory-classifier-freeze.json",
  );
  const publicClassifierPath = join(publicRoot, "common", "classifier.mjs");
  const observationEntitySchemaPath = join(
    adapterPackageRoot,
    "schemas/entity.patrol-agent.json",
  );
  const observationStateSchemaPath = join(
    adapterPackageRoot,
    "schemas/state.patrol-motion.json",
  );
  const [
    classifierFreezeFile,
    classifierImplementationBytes,
    pairedAgentImplementationBytes,
    projectEnvironmentPreparationImplementationBytes,
    preflightImplementationBytes,
    preflightManifestFile,
    publicClassifierBytes,
    adapterRevisionFile,
    adapterConformanceFile,
    sensorFreezeFile,
    adapterRawBytes,
    observationSchemaBytes,
    hostConfigBytes,
  ] = await Promise.all([
    readJson(
      classifierFreezePath,
      "R3 classifier freeze",
      M7R3TrajectoryClassifierFreezeV1Schema,
      true,
    ),
    readStableBytes(
      classifierImplementationPath,
      "R3 trajectory classifier implementation",
    ),
    readStableBytes(
      pairedAgentImplementationPath,
      "R3 paired Agent implementation",
    ),
    readStableBytes(
      projectEnvironmentPreparationImplementationPath,
      "R3 Project Environment preparation implementation",
    ),
    readStableBytes(
      preflightImplementationPath,
      "R3 PE preflight implementation",
    ),
    readJson(
      preflightImplementationManifestPath,
      "R3 preflight implementation manifest",
      preflightImplementationManifestSchema,
      true,
    ),
    readStableBytes(publicClassifierPath, "R3 public execution classifier"),
    readJson(
      adapterRevisionPath,
      "R3 AdapterRevision",
      ProjectAdapterRevisionV1Schema,
      true,
    ),
    readJson(
      adapterConformancePath,
      "R3 Adapter conformance receipt",
      AdapterConformanceReceiptV1Schema,
      true,
    ),
    readJson(
      sensorFreezePath,
      "R3 sensor freeze",
      M7SensorFreezeRecordV1Schema,
      true,
    ),
    privatePackageBytes(adapterPackageRoot),
    Promise.all([
      readStableBytes(
        observationEntitySchemaPath,
        "R3 patrol entity observation schema",
        true,
      ),
      readStableBytes(
        observationStateSchemaPath,
        "R3 patrol state observation schema",
        true,
      ),
    ]).then(([entitySchema, stateSchema]) =>
      Buffer.concat([entitySchema, Buffer.from([0]), stateSchema]),
    ),
    readStableBytes(hostConfigPath, "R3 Host configuration"),
  ]);
  const classifierFreeze = classifierFreezeFile.value;
  const adapterRevision = adapterRevisionFile.value;
  const adapterConformance = adapterConformanceFile.value;
  const sensorFreeze = sensorFreezeFile.value;
  const preflightImplementationManifest = preflightManifestFile.value;
  const common = manifest.common;
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
    digest(projectEnvironmentPreparationImplementationBytes) !==
      common.projectEnvironmentPreparationImplementationSha256 ||
    digest(preflightImplementationBytes) !==
      common.preflightProjectEnvironmentImplementationSha256 ||
    digest(preflightManifestFile.bytes) !==
      common.preflightImplementationManifestFileSha256 ||
    preflightImplementationManifest.projectEnvironmentImplementationSha256 !==
      common.preflightProjectEnvironmentImplementationSha256 ||
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
    sensorFreeze.sensor.adapterPackageSha256 !==
      common.adapterPackageRawAggregateSha256 ||
    sensorFreeze.sensor.observationSchemaSha256 !==
      common.sensorObservationSchemaRawSha256 ||
    classifierFreeze.authoritativeAdapter.adapterRevisionId !==
      adapterRevision.adapterRevisionId ||
    classifierFreeze.authoritativeAdapter.adapterRevisionRecordSha256 !==
      digestJson(adapterRevision) ||
    classifierFreeze.authoritativeAdapter.adapterId !==
      adapterRevision.adapterId ||
    classifierFreeze.authoritativeAdapter.packageSha256 !==
      adapterRevision.packageDigest ||
    classifierFreeze.authoritativeAdapter.observationSchemaSha256 !==
      adapterRevision.payloadSchemaDigest ||
    classifierFreeze.authoritativeAdapter.implementationSha256 !==
      adapterRevision.implementationDigest ||
    classifierFreeze.authoritativeAdapter.manifestSha256 !==
      adapterRevision.manifestDigest ||
    classifierFreeze.authoritativeAdapter.sdkSha256 !==
      adapterRevision.sdkDigest ||
    classifierFreeze.authoritativeAdapter.bridgeSha256 !==
      adapterRevision.bridgeDigest ||
    adapterRevision.conformanceReceiptId !== adapterConformance.receiptId ||
    adapterRevision.sourceId !== adapterConformance.sourceId ||
    classifierFreeze.authoritativeSensorFreezeId !==
      sensorFreeze.sensorFreezeId ||
    classifierFreeze.authoritativeSensorFreezeRecordSha256 !==
      sensorFreeze.recordSha256 ||
    !sameJson(classifierFreeze.pristineSubject, sensorFreeze.pristineSubject) ||
    sensorFreeze.sensor.adapterRevisionId !==
      adapterRevision.adapterRevisionId ||
    sensorFreeze.sensor.pristineConformanceReceiptId !==
      adapterConformance.receiptId ||
    sensorFreeze.sensor.pristineConformanceReceiptSha256 !==
      digest(adapterConformanceFile.bytes) ||
    classifierFreeze.authoritativeAdapter.pristineConformanceReceiptId !==
      adapterConformance.receiptId ||
    classifierFreeze.authoritativeAdapter.pristineConformanceReceiptSha256 !==
      digest(adapterConformanceFile.bytes) ||
    classifierFreeze.authoritativeAdapter.pristineSourceId !==
      adapterConformance.sourceId ||
    classifierFreeze.pristineSubject.sourceId !== adapterConformance.sourceId ||
    digest(hostConfigBytes) !== common.hostConfigSha256
  ) {
    throw new Error(
      "R3 common frozen material or Adapter/sensor digest domain changed",
    );
  }
  const hostConfig = await readProjectEnvironmentHostConfigV1(hostConfigPath);
  const portfolioRoot = await canonicalDirectory(
    join(runsRoot, "portfolio"),
    "R3 portfolio root",
    true,
  );
  const cases: CaseMaterials[] = [];
  for (const ordinal of [1, 2] as const) {
    const slug = `case-0${String(ordinal)}` as "case-01" | "case-02";
    const record = ordinal === 1 ? manifest.cases[0] : manifest.cases[1];
    const publicCaseRoot = await canonicalDirectory(
      join(publicRoot, slug),
      `${slug} public root`,
      true,
    );
    const staticPrivateCaseRoot = await canonicalDirectory(
      join(staticHostOnlyRoot, slug),
      `${slug} static Host-only root`,
      true,
    );
    const privateRoot = await canonicalDirectory(
      `/m7-r3-private/${slug}`,
      `${slug} combined Host-only assignment root`,
      true,
    );
    const privateMaterialRoot = await canonicalDirectory(
      join(privateRoot, "materials"),
      `${slug} mounted Host-only material root`,
      true,
    );
    const privateSensorRoot = await canonicalDirectory(
      join(privateRoot, "sensor"),
      `${slug} mounted R3 common sensor root`,
      true,
    );
    const [staticMaterialIdentity, mountedMaterialIdentity] = await Promise.all(
      [lstat(staticPrivateCaseRoot), lstat(privateMaterialRoot)],
    );
    const [commonSensorIdentity, mountedSensorIdentity] = await Promise.all([
      lstat(sensorRoot),
      lstat(privateSensorRoot),
    ]);
    if (
      staticMaterialIdentity.dev !== mountedMaterialIdentity.dev ||
      staticMaterialIdentity.ino !== mountedMaterialIdentity.ino ||
      commonSensorIdentity.dev !== mountedSensorIdentity.dev ||
      commonSensorIdentity.ino !== mountedSensorIdentity.ino
    ) {
      throw new Error(
        `${slug} combined Host-only material/sensor mount changed`,
      );
    }
    const pristineProjectRoot = await canonicalDirectory(
      requiredEnvironment(
        `CHRONORIFT_TEST_M7_R3_CASE_0${String(ordinal)}_PRISTINE`,
      ),
      `${slug} pristine authority clone`,
    );
    const mutantProjectRoot = await canonicalDirectory(
      requiredEnvironment(
        `CHRONORIFT_TEST_M7_R3_CASE_0${String(ordinal)}_MUTANT`,
      ),
      `${slug} mutant authority clone`,
    );
    const promptPath = join(publicCaseRoot, "prompt.txt");
    const runtimeTaskPath = join(publicCaseRoot, "task-runtime.json");
    const codeOnlyTaskPath = join(publicCaseRoot, "task-code-only.json");
    const pairedTaskContractPath = join(
      publicCaseRoot,
      "paired-task-contract.json",
    );
    const trajectoryCaseSpecPath = join(
      privateMaterialRoot,
      "trajectory-case-spec.json",
    );
    const mutationPath = join(privateMaterialRoot, "mutation.patch");
    const evaluatorImplementationPath = join(
      privateMaterialRoot,
      "evaluator.mjs",
    );
    const evaluatorBundlePath = join(
      privateMaterialRoot,
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
      readStableBytes(promptPath, `${slug} natural prompt`),
      readJson(
        runtimeTaskPath,
        `${slug} runtime public Task`,
        ExternalHiddenFixPublicTaskSpecV1Schema,
      ),
      readJson(
        codeOnlyTaskPath,
        `${slug} code-only public Task`,
        ExternalHiddenFixPublicTaskSpecV1Schema,
      ),
      readJson(
        pairedTaskContractPath,
        `${slug} paired public Task contract`,
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
    const promptWithNewline = new TextDecoder("utf-8", { fatal: true }).decode(
      promptBytes,
    );
    const prompt = ordinal === 1 ? EXACT_PROMPTS[0] : EXACT_PROMPTS[1];
    const recreatedContract = createM7R3PairedPublicTaskContractV1({
      caseOrdinal: ordinal,
      subjectRepository: pairedTaskContractFile.value.subjectRepository,
      naturalPrompt: prompt,
      runtimeTaskSpecBytes: runtimeTaskFile.bytes,
      codeOnlyTaskSpecBytes: codeOnlyTaskFile.bytes,
    });
    const pristineTree = selectedTreeSha256(pristineEntries);
    const mutantTree = selectedTreeSha256(mutantEntries);
    if (
      promptWithNewline !== `${prompt}\n` ||
      digest(promptBytes) !== record.promptFileSha256 ||
      digest(runtimeTaskFile.bytes) !== record.runtimeTaskSpecSha256 ||
      digest(codeOnlyTaskFile.bytes) !== record.codeOnlyTaskSpecSha256 ||
      digest(pairedTaskContractFile.bytes) !==
        record.pairedTaskContractFileSha256 ||
      pairedTaskContractFile.value.recordContentSha256 !==
        record.pairedTaskContractContentSha256 ||
      !Buffer.from(
        encodeM7R3PairedPublicTaskContractV1(recreatedContract),
      ).equals(Buffer.from(pairedTaskContractFile.bytes)) ||
      runtimeTaskFile.value.publicExecutionClassifier.implementationSha256 !==
        common.publicExecutionClassifierSha256 ||
      digest(trajectoryCaseSpecFile.bytes) !==
        record.trajectoryCaseSpecFileSha256 ||
      trajectoryCaseSpecFile.value.caseSpecSha256 !==
        record.trajectoryCaseSpecSha256 ||
      trajectoryCaseSpecFile.value.classifierImplementationSha256 !==
        common.classifierImplementationSha256 ||
      !sameJson(
        trajectoryCaseSpecFile.value.classifierId,
        classifierFreeze.classifierId,
      ) ||
      digest(mutationBytes) !== record.mutationSha256 ||
      mutationBytes.byteLength !== record.mutationByteLength ||
      digest(evaluatorImplementationBytes) !==
        record.evaluatorImplementationSha256 ||
      evaluatorImplementationBytes.byteLength !==
        record.evaluatorImplementationByteLength ||
      digest(evaluatorBundleBytes) !== record.evaluatorBundleSha256 ||
      evaluatorBundleBytes.byteLength !== record.evaluatorBundleByteLength ||
      pristineTree !== record.pristineSelectedTreeSha256 ||
      mutantTree !== record.mutatedSelectedTreeSha256 ||
      pristineTree === mutantTree ||
      pristineTree !== classifierFreeze.pristineSubject.selectedTreeSha256 ||
      record.pristineCommit !== classifierFreeze.pristineSubject.revision ||
      runtimeTaskFile.value.subjectCommit !== record.pristineCommit ||
      codeOnlyTaskFile.value.subjectCommit !== record.pristineCommit ||
      runtimeTaskFile.value.goal !== prompt ||
      codeOnlyTaskFile.value.goal !== prompt ||
      runtimeTaskFile.value.agentBudget.provider !== "openai-codex" ||
      runtimeTaskFile.value.agentBudget.model !== "gpt-5.6-luna" ||
      runtimeTaskFile.value.agentBudget.thinkingLevel !== "max" ||
      runtimeTaskFile.value.agentBudget.toolCallsMaximum !== 128 ||
      runtimeTaskFile.value.agentBudget.wallTimeMsMaximum !== 900_000 ||
      codeOnlyTaskFile.value.agentBudget.provider !== "openai-codex" ||
      codeOnlyTaskFile.value.agentBudget.model !== "gpt-5.6-luna" ||
      codeOnlyTaskFile.value.agentBudget.thinkingLevel !== "max" ||
      codeOnlyTaskFile.value.agentBudget.toolCallsMaximum !== 128 ||
      codeOnlyTaskFile.value.agentBudget.wallTimeMsMaximum !== 900_000 ||
      record.ordinal !== ordinal ||
      record.slug !== slug
    ) {
      throw new Error(`${slug} frozen bytes, source, or natural task changed`);
    }
    cases.push({
      ordinal,
      slug,
      manifest: record,
      publicRoot: publicCaseRoot,
      privateRoot,
      assignmentRoot: privateRoot,
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
      campaignRoot: await canonicalDirectory(
        join(runsRoot, "campaigns", slug),
        `${slug} campaign root`,
        true,
      ),
      evidenceRoot: await canonicalDirectory(
        join(runsRoot, "evidence", slug),
        `${slug} evidence root`,
        true,
      ),
      preflightEvaluatorTemporaryRoot: await canonicalDirectory(
        join(runsRoot, "evaluator-temp", slug, "preflight"),
        `${slug} preflight evaluator temporary root`,
        true,
      ),
      runtimePatchRoot: await canonicalDirectory(
        join(runsRoot, "patches", slug, "runtime-enabled"),
        `${slug} runtime patch root`,
        true,
      ),
      codeOnlyPatchRoot: await canonicalDirectory(
        join(runsRoot, "patches", slug, "code-only"),
        `${slug} code-only patch root`,
        true,
      ),
      runtimeEvaluatorTemporaryRoot: await canonicalDirectory(
        join(runsRoot, "evaluator-temp", slug, "runtime-enabled"),
        `${slug} runtime evaluator temporary root`,
        true,
      ),
      codeOnlyEvaluatorTemporaryRoot: await canonicalDirectory(
        join(runsRoot, "evaluator-temp", slug, "code-only"),
        `${slug} code-only evaluator temporary root`,
        true,
      ),
      runtimeAgentResourceRoot: await canonicalDirectory(
        join(runsRoot, "agent-resources", slug, "runtime-enabled"),
        `${slug} runtime Agent resource root`,
        true,
      ),
      codeOnlyAgentResourceRoot: await canonicalDirectory(
        join(runsRoot, "agent-resources", slug, "code-only"),
        `${slug} code-only Agent resource root`,
        true,
      ),
      runtimeDurableRecordRoot: await canonicalDirectory(
        join(runsRoot, "durable", slug, "runtime-enabled"),
        `${slug} runtime durable root`,
        true,
      ),
      codeOnlyDurableRecordRoot: await canonicalDirectory(
        join(runsRoot, "durable", slug, "code-only"),
        `${slug} code-only durable root`,
        true,
      ),
    });
  }
  if (
    cases.length !== 2 ||
    cases[0]?.ordinal !== 1 ||
    cases[1]?.ordinal !== 2
  ) {
    throw new Error("R3 requires exactly the two frozen cases");
  }
  await canonicalFile(
    "/pi-agent/auth.json",
    "R3 Host-only Pi credential source",
    true,
  );
  const [modelsFileBytes, modelsStoreFileBytes, settingsFileBytes] =
    await Promise.all([
      readStableBytes("/pi-agent/models.json", "R3 Host models file"),
      readStableBytes(
        "/pi-agent/models-store.json",
        "R3 Host models store file",
      ),
      readStableBytes("/pi-agent/settings.json", "R3 Host settings file"),
    ]);
  const hostSelections = cases.flatMap((candidate) => [
    {
      provider: candidate.runtimeTask.agentBudget.provider,
      model: candidate.runtimeTask.agentBudget.model,
      thinkingLevel: candidate.runtimeTask.agentBudget.thinkingLevel,
    },
    {
      provider: candidate.codeOnlyTask.agentBudget.provider,
      model: candidate.codeOnlyTask.agentBudget.model,
      thinkingLevel: candidate.codeOnlyTask.agentBudget.thinkingLevel,
    },
  ]);
  const hostSelection = hostSelections[0];
  if (
    hostSelection === undefined ||
    hostSelections.length !== 4 ||
    hostSelections.some((selection) => !sameJson(selection, hostSelection))
  ) {
    throw new Error("R3 Host model selection differs across cases or arms");
  }
  const realizedHostModelRuntimeConfigSha256 = digestJson({
    schemaVersion: 1,
    runtime: "pi-sdk-host-model-runtime",
    ...hostSelection,
    modelsFileSha256: digest(modelsFileBytes),
    modelsStoreFileSha256: digest(modelsStoreFileBytes),
    settingsFileSha256: digest(settingsFileBytes),
    credentialSource: {
      kind: "host-only-pi-agent-auth",
      mountTarget: "/pi-agent/auth.json",
      requiredMode: 384,
      contentNotPersisted: true,
    },
  });
  if (
    realizedHostModelRuntimeConfigSha256 !== common.hostModelRuntimeConfigSha256
  ) {
    throw new Error("R3 Host model runtime configuration changed");
  }
  const orchestrationSourceBytes = (await Promise.all(
    orchestrationSourcePaths.map((source) =>
      readStableBytes(
        source.sourcePath,
        `R3 ${source.sourceKind} orchestration source`,
      ),
    ),
  )) as unknown as readonly [
    Uint8Array,
    Uint8Array,
    Uint8Array,
    Uint8Array,
    Uint8Array,
    Uint8Array,
    Uint8Array,
  ];
  const operationalHostConfigs = await createM7R3OperationalHostConfigsOnceV1({
    operationalRoot: operationalConfigRoot,
    runMode: mode,
    liveMaterialManifestPath: manifestPath,
    liveMaterialManifestBytes: manifestFile.bytes,
    liveMaterialManifestRecordContentSha256: manifest.recordContentSha256,
    baseHostConfigPath: hostConfigPath,
    baseHostConfigBytes: hostConfigBytes,
    baseHostConfig: hostConfig,
    orchestrationSources: [
      {
        ...orchestrationSourcePaths[0],
        sourceFileSha256: digest(orchestrationSourceBytes[0]),
      },
      {
        ...orchestrationSourcePaths[1],
        sourceFileSha256: digest(orchestrationSourceBytes[1]),
      },
      {
        ...orchestrationSourcePaths[2],
        sourceFileSha256: digest(orchestrationSourceBytes[2]),
      },
      {
        ...orchestrationSourcePaths[3],
        sourceFileSha256: digest(orchestrationSourceBytes[3]),
      },
      {
        ...orchestrationSourcePaths[4],
        sourceFileSha256: digest(orchestrationSourceBytes[4]),
      },
      {
        ...orchestrationSourcePaths[5],
        sourceFileSha256: digest(orchestrationSourceBytes[5]),
      },
      {
        ...orchestrationSourcePaths[6],
        sourceFileSha256: digest(orchestrationSourceBytes[6]),
      },
    ],
    sealedAt: new Date().toISOString(),
  });
  const realizedCgroupTopology = await sealM7R3RealizedCgroupTopologyOnceV1({
    operationalRoot: operationalConfigRoot,
    operational: operationalHostConfigs,
    observedAt: new Date().toISOString(),
  });
  process.stdout.write(
    `${canonicalJson(
      JsonValueSchema.parse({
        schemaVersion: 1,
        receiptKind: "m7-r3-operational-infrastructure-seal",
        mode,
        operationalManifestPath: operationalHostConfigs.manifestPath,
        operationalManifestFileSha256:
          operationalHostConfigs.manifestFileSha256,
        operationalManifestRecordContentSha256:
          operationalHostConfigs.manifest.recordContentSha256,
        realizedTopologyReceiptPath: realizedCgroupTopology.receiptPath,
        realizedTopologyReceiptFileSha256:
          realizedCgroupTopology.receiptFileSha256,
        realizedTopologyReceiptRecordContentSha256:
          realizedCgroupTopology.receipt.recordContentSha256,
        agentLaunchCount: 0,
        providerInvocationCount: 0,
        piSessionCount: 0,
      }),
    )}\n`,
  );
  return {
    mode,
    manifest,
    publicRoot,
    staticHostOnlyRoot,
    constructionRoot,
    sensorRoot,
    runsRoot,
    adapterPackageRoot,
    adapterRevisionPath,
    adapterConformancePath,
    sensorFreezePath,
    adapterRevision,
    sensorFreeze,
    classifierFreeze,
    classifierImplementationBytes,
    preflightImplementationManifestBytes: preflightManifestFile.bytes,
    publicClassifierPath,
    pairedAgentProtocolImplementationSha256:
      common.pairedAgentProtocolImplementationSha256,
    hostConfig,
    operationalHostConfigs,
    realizedCgroupTopology,
    hostModelRuntimeConfigSha256: common.hostModelRuntimeConfigSha256,
    portfolioRoot,
    cases: cases as unknown as readonly [CaseMaterials, CaseMaterials],
  };
};

interface PreparedCasePhaseOne {
  readonly materials: CaseMaterials;
  readonly assignment: Awaited<
    ReturnType<typeof prepareExternalHiddenFixAssignmentV1>
  >;
  readonly runtimePatchStore: LocalExternalHiddenFixPatchStoreV1;
  readonly codeOnlyPatchStore: LocalExternalHiddenFixPatchStoreV1;
  readonly adapterFiles: readonly {
    readonly path: string;
    readonly bytes: Uint8Array;
  }[];
  readonly infrastructure: M7R3PreparedProjectEnvironmentInfrastructureV1;
}

const prepareCasePhaseOne = async (input: {
  readonly live: LiveMaterials;
  readonly materials: CaseMaterials;
  readonly now: () => string;
}): Promise<PreparedCasePhaseOne> => {
  const { live, materials } = input;
  const operationalHostConfig = m7R3OperationalHostConfigPathsForCaseV1(
    live.operationalHostConfigs,
    materials.ordinal,
  );
  const agentExposedRoots = [
    live.publicRoot,
    live.hostConfig.taskStorageRoot,
    ...live.cases.flatMap((candidate) => [
      candidate.runtimeAgentResourceRoot,
      candidate.codeOnlyAgentResourceRoot,
    ]),
  ];
  const [runtimePatchStore, codeOnlyPatchStore] = await Promise.all([
    LocalExternalHiddenFixPatchStoreV1.open({
      root: materials.runtimePatchRoot,
      exposedRoots: agentExposedRoots,
    }),
    LocalExternalHiddenFixPatchStoreV1.open({
      root: materials.codeOnlyPatchRoot,
      exposedRoots: agentExposedRoots,
    }),
  ]);
  const privateSensorRoot = join(materials.privateRoot, "sensor");
  const assignment = await prepareExternalHiddenFixAssignmentV1({
    pristineProjectRoot: materials.pristineProjectRoot,
    mutatedProjectRoot: materials.mutantProjectRoot,
    expectedSubjectCommit: materials.manifest.pristineCommit,
    publicTaskSpecPath: materials.runtimeTaskPath,
    publicTaskSpecBytePolicy: {
      kind: "frozen-exact-v1",
      expectedSha256: materials.manifest.runtimeTaskSpecSha256,
    },
    adapterPackageRoot: join(privateSensorRoot, "package"),
    adapterRevisionPath: join(privateSensorRoot, "adapter-revision.v1.json"),
    adapterConformanceReceiptPath: join(
      privateSensorRoot,
      "conformance-receipt.v1.json",
    ),
    mutationPath: materials.mutationPath,
    evaluatorImplementationPath: materials.evaluatorImplementationPath,
    evaluatorBundlePath: materials.evaluatorBundlePath,
    hostOnlyRoot: materials.assignmentRoot,
    agentExposedRoots,
    createdAt: input.now(),
  });
  if (
    assignment.assignment.mutationSha256 !==
      materials.manifest.mutationSha256 ||
    assignment.assignment.evaluatorImplementationSha256 !==
      materials.manifest.evaluatorImplementationSha256 ||
    assignment.assignment.evaluatorBundleSha256 !==
      materials.manifest.evaluatorBundleSha256 ||
    assignment.assignment.mutatedBaselineSelectedTreeSha256 !==
      materials.manifest.mutatedSelectedTreeSha256 ||
    assignment.agentProjection.publicTask.sha256 !==
      materials.manifest.runtimeTaskSpecSha256
  ) {
    throw new Error(`${materials.slug} assignment crossed frozen bytes`);
  }
  const publicClassifier = await loadPublicExecutionClassifier({
    publicRoot: live.publicRoot,
    implementationPath: live.publicClassifierPath,
    publicTask: materials.runtimeTask,
  });
  const mountedAdapterPackageRoot = resolve(privateSensorRoot, "package");
  const adapterFiles = await Promise.all(
    assignment.adapterPackage.files.map(async (file) => {
      const path = resolve(mountedAdapterPackageRoot, file.path);
      if (!pathWithinOrEqual(mountedAdapterPackageRoot, path)) {
        throw new Error("R3 Adapter file escaped its frozen package root");
      }
      return { path: file.path, bytes: await readFile(path) };
    }),
  );
  const runtimeTask = await prepareM6ProjectEnvironmentOneTurnTaskV1({
    assignment,
    adapterFiles,
    patchStore: runtimePatchStore,
    publicExecutionClassifier: publicClassifier,
    hostAdmittedGameToolNames: PROJECT_ENVIRONMENT_GAME_TOOL_DEFINITIONS_V1.map(
      (tool) => tool.name,
    ),
    hostConfigPath: operationalHostConfig.runtime,
    agentDir: materials.runtimeAgentResourceRoot,
    now: input.now,
  });
  const infrastructure = await prepareM7R3ProjectEnvironmentInfrastructureV1({
    runtimeTask,
    codeOnlyPublicTask: materials.codeOnlyTask,
    codeOnlyPublicTaskSpecSha256: materials.manifest.codeOnlyTaskSpecSha256,
    codeOnlyPatchStore,
    runtimeAgentResourceDirectory: materials.runtimeAgentResourceRoot,
    codeOnlyAgentResourceDirectory: materials.codeOnlyAgentResourceRoot,
    runtimeDurableRecordRoot: materials.runtimeDurableRecordRoot,
    codeOnlyDurableRecordRoot: materials.codeOnlyDurableRecordRoot,
    trajectoryClassifierConfig: M7_PATROL_TRAJECTORY_CLASSIFIER_CONFIG_V1,
    trajectoryCaseSpec: materials.trajectoryCaseSpec,
    hostModelRuntimeConfigSha256: live.hostModelRuntimeConfigSha256,
    additionalCodingSandboxSentinelForbiddenPaths: [
      join(materials.privateRoot, "materials"),
      materials.mutationPath,
      materials.evaluatorImplementationPath,
      materials.evaluatorBundlePath,
      join(live.runsRoot, "operational-config"),
    ],
    hostConfigPath: operationalHostConfig.codeOnly,
  });
  const registration = infrastructure.registrationInputs;
  if (
    registration.baselineSelectedTreeSha256 !==
      materials.manifest.mutatedSelectedTreeSha256 ||
    registration.runtimeArmPublicTaskSpecSha256 !==
      materials.manifest.runtimeTaskSpecSha256 ||
    registration.codeOnlyArmPublicTaskSpecSha256 !==
      materials.manifest.codeOnlyTaskSpecSha256 ||
    registration.hostModelRuntimeConfigSha256 !==
      live.hostModelRuntimeConfigSha256 ||
    registration.pristineAdapterConformanceReceiptSha256 !==
      live.classifierFreeze.authoritativeAdapter
        .pristineConformanceReceiptSha256
  ) {
    await infrastructure.abortPreparation();
    throw new Error(`${materials.slug} phase-one registration crossed inputs`);
  }
  return {
    materials,
    assignment,
    runtimePatchStore,
    codeOnlyPatchStore,
    adapterFiles,
    infrastructure,
  };
};

const compatibilityCleanupProven = (
  receipt: PreparedCasePhaseOne["infrastructure"]["registrationInputs"]["adapterMutantCompatibilityReceipt"],
): boolean =>
  receipt.outcome === "compatible" &&
  receipt.cleanup.processTreeTerminated &&
  receipt.cleanup.isolationGroupEmpty &&
  receipt.cleanup.scopeRemoved &&
  receipt.cleanup.storageReconciled === true;

const createConstructions = async (input: {
  readonly live: LiveMaterials;
  readonly store: M7R3CaseConstructionStoreV1;
  readonly prepared: readonly [PreparedCasePhaseOne, PreparedCasePhaseOne];
  readonly now: () => string;
}): Promise<
  readonly [M7R3CaseConstructionReceiptV1, M7R3CaseConstructionReceiptV1]
> => {
  const freeze = await input.store.readClassifierFreeze();
  if (!sameJson(freeze, input.live.classifierFreeze)) {
    throw new Error("R3 construction store classifier freeze changed");
  }
  const records: M7R3CaseConstructionReceiptV1[] = [];
  for (const ordinal of [1, 2] as const) {
    const prepared = ordinal === 1 ? input.prepared[0] : input.prepared[1];
    const registrationInputs = prepared.infrastructure.registrationInputs;
    const mutation = createM7R3MutationRegistrationV1({
      trajectoryClassifierFreeze: freeze,
      mutationBytes: prepared.materials.mutationBytes,
      mutatedBuild: registrationInputs.baselineBuild,
      registeredAt: input.now(),
    });
    const compatibility = registrationInputs.adapterMutantCompatibilityReceipt;
    const cleanupProven = compatibilityCleanupProven(compatibility);
    const construction = await input.store.createConstructionOnce({
      ordinal,
      mutationRegistration: mutation,
      mutatedBuild: registrationInputs.baselineBuild,
      naturalPrompt: prepared.materials.prompt,
      trajectoryCaseSpec: prepared.materials.trajectoryCaseSpec,
      adapterMutantCompatibilityReceipt: compatibility,
      pairedPublicTaskContractBytes: prepared.materials.pairedTaskContractBytes,
      preflightImplementationBytes:
        input.live.preflightImplementationManifestBytes,
      evaluatorImplementationBytes:
        prepared.materials.evaluatorImplementationBytes,
      evaluatorBundleBytes: prepared.materials.evaluatorBundleBytes,
      cleanup: {
        proven: cleanupProven,
        receiptSha256: cleanupProven ? digestJson(compatibility.cleanup) : null,
      },
      constructedAt: input.now(),
    });
    records.push(construction);
  }
  const [first, second] = records;
  if (first === undefined || second === undefined) {
    throw new Error("R3 did not create exactly two construction receipts");
  }
  return [first, second];
};

const derivedAgentBudget = (task: ExternalHiddenFixPublicTaskSpecV1) => ({
  schemaVersion: 1 as const,
  attemptsMaximum: 1 as const,
  userTurnsPerAttemptMaximum: 1 as const,
  toolCallsMaximum: task.agentBudget.toolCallsMaximum,
  wallTimeMsMaximum: task.agentBudget.wallTimeMsMaximum,
  taskSandboxNetworkMode: "denied" as const,
  taskCredentialMountCountMaximum: 0 as const,
});

const createPortfolioInput = (input: {
  readonly live: LiveMaterials;
  readonly prepared: readonly [PreparedCasePhaseOne, PreparedCasePhaseOne];
  readonly constructions: readonly [
    M7R3CaseConstructionReceiptV1,
    M7R3CaseConstructionReceiptV1,
  ];
  readonly frozenAt: string;
}): CreateM7R3TwoCasePortfolioFreezeV1Input => {
  const [firstRegistration, secondRegistration] = input.prepared.map(
    (value) => value.infrastructure.registrationInputs,
  ) as [
    PreparedCasePhaseOne["infrastructure"]["registrationInputs"],
    PreparedCasePhaseOne["infrastructure"]["registrationInputs"],
  ];
  const firstTask = input.live.cases[0].runtimeTask;
  const secondTask = input.live.cases[1].runtimeTask;
  if (
    firstRegistration.validatedGameToolSetSha256 !==
      secondRegistration.validatedGameToolSetSha256 ||
    firstRegistration.codingToolSetSha256 !==
      secondRegistration.codingToolSetSha256 ||
    firstRegistration.sandboxPolicySha256 !==
      secondRegistration.sandboxPolicySha256 ||
    firstTask.agentBudget.provider !== secondTask.agentBudget.provider ||
    firstTask.agentBudget.model !== secondTask.agentBudget.model ||
    firstTask.agentBudget.thinkingLevel !==
      secondTask.agentBudget.thinkingLevel ||
    !sameJson(derivedAgentBudget(firstTask), derivedAgentBudget(secondTask))
  ) {
    throw new Error("R3 two-case common Agent/runtime configuration differs");
  }
  return {
    commonRuntimeMaterials: {
      ...projectM7R3ClassifierFreezeToPortfolioV1(input.live.classifierFreeze),
      validatedGameToolSetSha256: firstRegistration.validatedGameToolSetSha256,
      commonEnvironmentInstructionsSha256:
        M7_R3_NEUTRAL_ENVIRONMENT_INSTRUCTIONS_SHA256_V1,
      hostModelRuntimeConfigSha256: input.live.hostModelRuntimeConfigSha256,
    },
    agentConfiguration: {
      provider: firstTask.agentBudget.provider,
      model: firstTask.agentBudget.model,
      thinkingLevel: firstTask.agentBudget.thinkingLevel,
      agentBudgetSha256: digestJson(derivedAgentBudget(firstTask)),
      codingToolSetSha256: firstRegistration.codingToolSetSha256,
      sandboxPolicySha256: firstRegistration.sandboxPolicySha256,
    },
    pairedAttemptPlan: {
      armOrder: ["runtime_enabled", "code_only"],
      attemptsPerArm: 1,
      retriesAllowed: false,
      userTurnsPerArm: 1,
    },
    evaluationPlan: {
      scenarioClassOrder: [
        "public_reproduction",
        "hidden_variant",
        "regression_control",
      ],
      repetitionsPerScenarioClass: 3,
      expectedFreshCopyRunCount: 9,
      freshCopyPerRun: true,
    },
    cases: [
      projectM7R3ConstructionToPortfolioCaseV1(input.constructions[0]),
      projectM7R3ConstructionToPortfolioCaseV1(input.constructions[1]),
    ],
    frozenAt: input.frozenAt,
  };
};

interface DirectoryIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly uid: number;
  readonly mode: number;
}

const isNodeError = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error && "code" in error;

const capturePrivateDirectoryIdentity = async (
  path: string,
  label: string,
): Promise<DirectoryIdentity> => {
  await canonicalDirectory(path, label, true);
  const metadata = await lstat(path);
  return {
    dev: metadata.dev,
    ino: metadata.ino,
    uid: metadata.uid,
    mode: metadata.mode,
  };
};

const removeFreshDirectory = async (
  path: string,
  expected: DirectoryIdentity,
): Promise<boolean> => {
  try {
    const metadata = await lstat(path);
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      metadata.dev !== expected.dev ||
      metadata.ino !== expected.ino ||
      metadata.uid !== expected.uid ||
      metadata.mode !== expected.mode ||
      (await realpath(path)) !== path
    ) {
      return false;
    }
    await rm(path, { recursive: true, force: false });
    try {
      await lstat(path);
      return false;
    } catch (error) {
      return isNodeError(error) && error.code === "ENOENT";
    }
  } catch {
    return false;
  }
};

/**
 * Host-only fresh-copy adapter used only by the no-Agent preflight. It runs
 * the frozen evaluator directly against a copy of the selected pristine or
 * mutant source; it receives no Agent patch, Task records, or Pi surface.
 */
const createNoAgentHiddenEvaluatorPreflightPort = (input: {
  readonly materials: CaseMaterials;
  readonly construction: M7R3CaseConstructionReceiptV1;
  readonly caseId: string;
  readonly evaluator: ExternalHiddenFixEvaluatorProcessPortV1;
}): M7R3HiddenEvaluatorPreflightPortV1 => {
  let invocation = 0;
  return Object.freeze({
    async runFresh(request: M7R3HiddenEvaluatorPreflightRequestV1) {
      invocation += 1;
      const expectedSource =
        request.subject === "pristine"
          ? {
              root: input.materials.pristineProjectRoot,
              sourceId: `source:${input.materials.manifest.pristineSelectedTreeSha256}`,
              selectedTreeSha256:
                input.materials.manifest.pristineSelectedTreeSha256,
            }
          : {
              root: input.materials.mutantProjectRoot,
              sourceId: input.construction.mutatedBuild.sourceId,
              selectedTreeSha256:
                input.materials.manifest.mutatedSelectedTreeSha256,
            };
      if (
        request.ordinal !== input.materials.ordinal ||
        request.caseId !== input.caseId ||
        request.evaluatorImplementationSha256 !==
          input.materials.manifest.evaluatorImplementationSha256 ||
        request.evaluatorBundleSha256 !==
          input.materials.manifest.evaluatorBundleSha256 ||
        request.source.sourceId !== expectedSource.sourceId ||
        request.source.sourceSha256 !== expectedSource.selectedTreeSha256 ||
        request.source.selectedTreeSha256 !== expectedSource.selectedTreeSha256
      ) {
        throw new TypeError(
          `${input.materials.slug} hidden preflight crossed frozen source or evaluator identity`,
        );
      }
      const selectedBefore = selectedTreeSha256(
        await collectCandidateGodotSourceV1(
          expectedSource.root,
          "project-environment",
          "tracked-tool-scripts-v1",
        ),
      );
      if (selectedBefore !== expectedSource.selectedTreeSha256) {
        throw new Error(
          `${input.materials.slug} hidden preflight source changed before fresh copy`,
        );
      }
      await canonicalDirectory(
        input.materials.preflightEvaluatorTemporaryRoot,
        `${input.materials.slug} hidden preflight temporary root`,
        true,
      );
      const runRoot = await mkdtemp(
        join(
          input.materials.preflightEvaluatorTemporaryRoot,
          `run-${String(invocation).padStart(2, "0")}-`,
        ),
      );
      await chmod(runRoot, PRIVATE_DIRECTORY_MODE);
      const runIdentity = await capturePrivateDirectoryIdentity(
        runRoot,
        `${input.materials.slug} hidden preflight run root`,
      );
      const workspaceRoot = join(runRoot, "workspace");
      const importCacheRoot = join(runRoot, "import-cache");
      const workspaceIdentity = `m7-r3-preflight-workspace:${randomUUID()}`;
      const importCacheIdentity = `m7-r3-preflight-import-cache:${randomUUID()}`;
      const processIdentity = `m7-r3-preflight-process:${randomUUID()}`;
      let result:
        | Awaited<
            ReturnType<ExternalHiddenFixEvaluatorProcessPortV1["evaluate"]>
          >
        | undefined;
      let primaryFailure: unknown;
      try {
        await cp(expectedSource.root, workspaceRoot, {
          recursive: true,
          dereference: false,
          errorOnExist: true,
          force: false,
          preserveTimestamps: false,
        });
        await mkdir(importCacheRoot, { mode: PRIVATE_DIRECTORY_MODE });
        const copiedTree = selectedTreeSha256(
          await collectCandidateGodotSourceV1(
            workspaceRoot,
            "project-environment",
            "tracked-tool-scripts-v1",
          ),
        );
        if (copiedTree !== expectedSource.selectedTreeSha256) {
          throw new Error(
            `${input.materials.slug} hidden preflight fresh source mismatched`,
          );
        }
        result = await input.evaluator.evaluate({
          evaluatorImplementationPath:
            input.materials.evaluatorImplementationPath,
          evaluatorBundlePath: input.materials.evaluatorBundlePath,
          workspaceRoot,
          importCacheRoot,
          freshCopyId: `m7-r3-preflight:${input.materials.ordinal}:${request.subject}:${request.scenario.scenarioId}:${randomUUID()}`,
          scenarioClass: request.scenario.scenarioClass,
          repetition: request.scenario.repetition,
        });
        const selectedAfter = selectedTreeSha256(
          await collectCandidateGodotSourceV1(
            workspaceRoot,
            "project-environment",
            "tracked-tool-scripts-v1",
          ),
        );
        if (selectedAfter !== copiedTree) {
          throw new Error(
            `${input.materials.slug} hidden evaluator changed fresh source`,
          );
        }
      } catch (error) {
        primaryFailure = error;
      }
      const directoryCleanupProven = await removeFreshDirectory(
        runRoot,
        runIdentity,
      );
      if (primaryFailure !== undefined) {
        if (!directoryCleanupProven) {
          throw new AggregateError(
            [
              primaryFailure,
              new Error("hidden preflight fresh directory cleanup failed"),
            ],
            `${input.materials.slug} hidden preflight failed without cleanup proof`,
          );
        }
        throw asError(primaryFailure, "R3 hidden preflight failed");
      }
      if (result === undefined) {
        throw new Error(
          `${input.materials.slug} hidden preflight produced no evaluator result`,
        );
      }
      const observationReceipt = JsonValueSchema.parse({
        schemaVersion: 1,
        outcome: result.outcome,
        observationSha256: result.observationSha256,
      });
      return Object.freeze({
        schemaVersion: 1 as const,
        subject: request.subject,
        scenarioId: request.scenario.scenarioId,
        observation:
          result.outcome === "passed"
            ? ("expected_motion_observed" as const)
            : ("expected_motion_not_observed" as const),
        observationReceipt,
        workspace: Object.freeze({
          created: true,
          identity: workspaceIdentity,
          creationReceipt: JsonValueSchema.parse({
            schemaVersion: 1,
            identity: workspaceIdentity,
            selectedTreeSha256: expectedSource.selectedTreeSha256,
            sourceId: expectedSource.sourceId,
          }),
        }),
        importCache: Object.freeze({
          created: true,
          identity: importCacheIdentity,
          creationReceipt: JsonValueSchema.parse({
            schemaVersion: 1,
            identity: importCacheIdentity,
          }),
        }),
        process: Object.freeze({
          started: result.processStarted,
          identity: processIdentity,
          startReceipt: JsonValueSchema.parse({
            schemaVersion: 1,
            identity: processIdentity,
            processStarted: result.processStarted,
            processCleanupProven: result.processCleanupProven,
            observationSha256: result.observationSha256,
          }),
        }),
        cleanup: Object.freeze({
          proven:
            directoryCleanupProven && result.processCleanupProven === true,
          receipt: JsonValueSchema.parse({
            schemaVersion: 1,
            processCleanupProven: result.processCleanupProven,
            freshDirectoryCleanupProven: directoryCleanupProven,
          }),
        }),
        agentLaunchCount: 0 as const,
        providerInvocationCount: 0 as const,
        piSessionCount: 0 as const,
      });
    },
  });
};

const openEvaluatorProcess = async (input: {
  readonly live: LiveMaterials;
  readonly materials: CaseMaterials;
}): Promise<BwrapExternalHiddenFixEvaluatorProcessV1> => {
  const toolchain = input.live.hostConfig.godotToolchains[0];
  if (toolchain === undefined) {
    throw new Error("R3 Host configuration omitted its Godot toolchain");
  }
  return BwrapExternalHiddenFixEvaluatorProcessV1.open({
    bwrapPath: input.live.hostConfig.bwrapPath,
    nodePath: input.live.hostConfig.nodePath,
    runtimeMounts: [
      {
        source: toolchain.executablePath,
        target: "/runtime/assets/godot",
      },
    ],
    forbiddenRoots: [
      input.live.publicRoot,
      input.live.hostConfig.taskStorageRoot,
      join(input.live.runsRoot, "operational-config"),
      ...input.live.cases.flatMap((candidate) => [
        candidate.runtimeAgentResourceRoot,
        candidate.codeOnlyAgentResourceRoot,
      ]),
    ],
    timeoutMs:
      input.materials.runtimeTask.evaluatorBudget.wallTimeMsPerRunMaximum,
  });
};

interface PreparedNoAgentPreflightCase {
  readonly preparation: PreparedM7R3NoAgentProjectEnvironmentPreflightPortV1;
  readonly hiddenEvaluator: M7R3HiddenEvaluatorPreflightPortV1;
}

const prepareNoAgentPreflightCase = async (input: {
  readonly live: LiveMaterials;
  readonly prepared: PreparedCasePhaseOne;
  readonly construction: M7R3CaseConstructionReceiptV1;
  readonly caseId: string;
  readonly now: () => string;
}): Promise<PreparedNoAgentPreflightCase> => {
  const evaluator = await openEvaluatorProcess({
    live: input.live,
    materials: input.prepared.materials,
  });
  const preparation = await prepareM7R3NoAgentProjectEnvironmentPreflightPortV1(
    {
      ordinal: input.prepared.materials.ordinal,
      pristineSource: input.prepared.assignment.pristineSource,
      mutantSource: input.prepared.assignment.mutatedSource,
      adapterFiles: input.prepared.adapterFiles,
      adapterRevision: input.live.adapterRevision,
      hostConfigPath: m7R3OperationalHostConfigPathsForCaseV1(
        input.live.operationalHostConfigs,
        input.prepared.materials.ordinal,
      ).noAgentPreflight,
      now: input.now,
    },
  );
  return {
    preparation,
    hiddenEvaluator: createNoAgentHiddenEvaluatorPreflightPort({
      materials: input.prepared.materials,
      construction: input.construction,
      caseId: input.caseId,
      evaluator,
    }),
  };
};

const runAndPersistNoAgentPreflights = async (input: {
  readonly live: LiveMaterials;
  readonly constructionStore: M7R3CaseConstructionStoreV1;
  readonly prepared: readonly [PreparedCasePhaseOne, PreparedCasePhaseOne];
  readonly constructions: readonly [
    M7R3CaseConstructionReceiptV1,
    M7R3CaseConstructionReceiptV1,
  ];
  readonly portfolio: M7R3TwoCasePortfolioFreezeV1;
  readonly now: () => string;
}): Promise<M7R3TwoCasePreflightRunResultV1> => {
  const cases: PreparedNoAgentPreflightCase[] = [];
  let result: M7R3TwoCasePreflightRunResultV1 | undefined;
  let primaryFailure: unknown;
  try {
    for (const index of [0, 1] as const) {
      cases.push(
        await prepareNoAgentPreflightCase({
          live: input.live,
          prepared: input.prepared[index],
          construction: input.constructions[index],
          caseId: input.portfolio.cases[index].caseId,
          now: input.now,
        }),
      );
    }
    const [first, second] = cases;
    if (first === undefined || second === undefined) {
      throw new Error("R3 did not prepare exactly two no-Agent preflights");
    }
    result = await runM7R3TwoCasePreflightV1({
      trajectoryClassifierFreeze: input.live.classifierFreeze,
      constructionReceipts: input.constructions,
      portfolioFreeze: input.portfolio,
      cases: [
        {
          ordinal: 1,
          configuredMainScene: first.preparation.configuredMainScene,
          projectEnvironment: first.preparation.projectEnvironment,
          hiddenEvaluator: first.hiddenEvaluator,
          persistence: input.constructionStore,
        },
        {
          ordinal: 2,
          configuredMainScene: second.preparation.configuredMainScene,
          projectEnvironment: second.preparation.projectEnvironment,
          hiddenEvaluator: second.hiddenEvaluator,
          persistence: input.constructionStore,
        },
      ],
      now: input.now,
    });
  } catch (error) {
    primaryFailure = error;
  }
  const cleanupResults = await Promise.allSettled(
    cases.map((value) => value.preparation.cleanup()),
  );
  const cleanupFailures: unknown[] = [];
  for (const cleanup of cleanupResults) {
    if (cleanup.status === "rejected") {
      cleanupFailures.push(cleanup.reason);
      continue;
    }
    if (!cleanup.value.cleanupProven) {
      cleanupFailures.push(
        new Error("R3 no-Agent Project Environment cleanup was not proven"),
      );
    }
  }
  if (primaryFailure !== undefined || cleanupFailures.length > 0) {
    throw new AggregateError(
      [
        ...(primaryFailure === undefined ? [] : [primaryFailure]),
        ...cleanupFailures,
      ],
      "R3 no-Agent preflight or cleanup failed",
    );
  }
  if (result === undefined) {
    throw new Error("R3 no-Agent preflight returned no result");
  }
  return result;
};

const createCaseContract = (input: {
  readonly live: LiveMaterials;
  readonly portfolio: M7R3TwoCasePortfolioFreezeV1;
  readonly construction: M7R3CaseConstructionReceiptV1;
  readonly prepared: PreparedCasePhaseOne;
}): M7R3PairedCaseContractV1 => {
  const frozenCase = input.portfolio.cases[input.construction.ordinal - 1];
  if (
    frozenCase === undefined ||
    frozenCase.ordinal !== input.construction.ordinal
  ) {
    throw new Error("R3 portfolio omitted a fixed case ordinal");
  }
  return createM7R3PairedCaseContractV1({
    portfolioId: input.portfolio.portfolioId,
    caseOrdinal: input.construction.ordinal,
    caseId: frozenCase.caseId,
    mutatedBaselineSelectedTreeSha256:
      input.construction.mutatedBuild.selectedTreeSha256,
    naturalPrompt: createM7R3NaturalUserPromptV1(
      input.prepared.materials.prompt,
    ),
    pairedAgentProtocolImplementationSha256:
      input.live.pairedAgentProtocolImplementationSha256,
    pairedPublicTaskContractSha256:
      input.construction.pairedPublicTaskContract.sha256,
    runtimeArmPublicTaskSpecSha256:
      input.prepared.infrastructure.registrationInputs
        .runtimeArmPublicTaskSpecSha256,
    codeOnlyArmPublicTaskSpecSha256:
      input.prepared.infrastructure.registrationInputs
        .codeOnlyArmPublicTaskSpecSha256,
    adapterMutantCompatibilityReceiptSha256:
      input.construction.adapterMutantCompatibility.receiptRecordSha256,
    commonRuntimeMaterials: input.portfolio.commonRuntimeMaterials,
    agentConfiguration: input.portfolio.agentConfiguration,
    trajectoryClassifierConfig: input.live.classifierFreeze.classifierConfig,
    trajectoryCaseSpec: input.prepared.materials.trajectoryCaseSpec,
  });
};

const writeAll = async (
  handle: Awaited<ReturnType<typeof open>>,
  bytes: Uint8Array,
): Promise<void> => {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await handle.write(
      bytes,
      offset,
      bytes.byteLength - offset,
      offset,
    );
    if (bytesWritten === 0) {
      throw new Error("R3 durable write made no progress");
    }
    offset += bytesWritten;
  }
};

const createCampaignFailureWriter = (input: {
  readonly materials: CaseMaterials;
}): M7R3PreparedLocalCaseCampaignV1["persistInfrastructureFailureOnce"] => {
  const path = join(
    input.materials.campaignRoot,
    "m7-r3.campaign-infrastructure-failure.json",
  );
  let invoked = false;
  return async (failureInput): Promise<Sha256DigestV1> => {
    if (invoked) {
      throw new Error(
        `${input.materials.slug} campaign infrastructure failure may be retained only once`,
      );
    }
    invoked = true;
    const failure =
      M7R3CampaignInfrastructureFailureInputV1Schema.parse(failureInput);
    if (failure.caseOrdinal !== input.materials.ordinal) {
      throw new TypeError(
        `${input.materials.slug} infrastructure failure crossed its ordinal`,
      );
    }
    await canonicalDirectory(
      input.materials.campaignRoot,
      `${input.materials.slug} campaign failure root`,
      true,
    );
    if (!pathWithinOrEqual(input.materials.campaignRoot, path)) {
      throw new Error("R3 campaign failure path escaped its Host-only root");
    }
    const bytes = Buffer.from(
      `${canonicalJson(JsonValueSchema.parse(failure))}\n`,
      "utf8",
    );
    const handle = await open(
      path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      PRIVATE_FILE_MODE,
    );
    try {
      await writeAll(handle, bytes);
      await handle.sync();
      const metadata = await handle.stat();
      if (
        !metadata.isFile() ||
        metadata.nlink !== 1 ||
        metadata.uid !== currentUserId() ||
        (metadata.mode & 0o7777) !== PRIVATE_FILE_MODE ||
        metadata.size !== bytes.byteLength
      ) {
        throw new Error(
          `${input.materials.slug} infrastructure failure storage was not private`,
        );
      }
    } finally {
      await handle.close();
    }
    const reopened = await readJson(
      path,
      `${input.materials.slug} campaign infrastructure failure`,
      M7R3CampaignInfrastructureFailureInputV1Schema,
      true,
    );
    if (!sameJson(reopened.value, failure)) {
      throw new Error(
        `${input.materials.slug} infrastructure failure changed during persistence`,
      );
    }
    return digestJson(failure);
  };
};

const sensorBindingInput = (input: {
  readonly live: LiveMaterials;
  readonly contract: M7R3PairedCaseContractV1;
  readonly boundAt: string;
}) => ({
  schemaVersion: 1 as const,
  authoritativeSensorFreezeId: input.live.sensorFreeze.sensorFreezeId,
  authoritativeSensorFreezeRecordSha256: input.live.sensorFreeze.recordSha256,
  subjectProjectSha256:
    input.live.sensorFreeze.pristineSubject.subjectProjectSha256,
  pristineProjectRevision: input.live.sensorFreeze.pristineSubject.revision,
  pristineSelectedTreeSha256:
    input.live.sensorFreeze.pristineSubject.selectedTreeSha256,
  pristineAdapterRevisionSha256:
    input.contract.commonRuntimeMaterials.adapterRevisionSha256,
  // The legacy campaign record retains the R1 raw aggregate domains. The R3
  // contract separately retains the Adapter's canonical package identities.
  adapterPackageSha256: input.live.sensorFreeze.sensor.adapterPackageSha256,
  adapterObservationSchemaSha256:
    input.live.sensorFreeze.sensor.observationSchemaSha256,
  publicPatrolClassifierSha256:
    input.live.sensorFreeze.sensor.classifierImplementationSha256,
  pristineConformanceReceiptSha256:
    input.live.sensorFreeze.sensor.pristineConformanceReceiptSha256,
  validatedGameToolSetSha256:
    input.contract.commonRuntimeMaterials.validatedGameToolSetSha256,
  boundAt: input.boundAt,
});

const registerCampaignWithoutAgent = async (input: {
  readonly live: LiveMaterials;
  readonly prepared: PreparedCasePhaseOne;
  readonly construction: M7R3CaseConstructionReceiptV1;
  readonly preflight: Awaited<
    ReturnType<M7R3CaseConstructionStoreV1["readPreflight"]>
  >;
  readonly portfolio: M7R3TwoCasePortfolioFreezeV1;
  readonly contract: M7R3PairedCaseContractV1;
  readonly now: () => string;
  readonly failureWriter: M7R3PreparedLocalCaseCampaignV1["persistInfrastructureFailureOnce"];
}): Promise<M7R3PreparedLocalCaseCampaignV1> => {
  const materials = input.prepared.materials;
  const agentExposedRoots = [
    input.live.publicRoot,
    input.live.hostConfig.taskStorageRoot,
    ...input.live.cases.flatMap((candidate) => [
      candidate.runtimeAgentResourceRoot,
      candidate.codeOnlyAgentResourceRoot,
    ]),
  ];
  const [campaignStore, admissionStore, mutationStore, evidenceStore] =
    await Promise.all([
      openM7RuntimeUseCampaignStoreV1({
        root: materials.campaignRoot,
        exposedRoots: agentExposedRoots,
      }),
      openM7R3CaseCampaignAdmissionStoreV1({
        root: materials.campaignRoot,
        exposedRoots: agentExposedRoots,
      }),
      M7RuntimeUseLocalMutationStoreV1.open({
        root: materials.assignmentRoot,
        exposedRoots: agentExposedRoots,
      }),
      M7R3RuntimeUseLocalEvidenceStoreV1.open({
        root: materials.evidenceRoot,
        exposedRoots: agentExposedRoots,
      }),
    ]);
  const registeredAt = input.now();
  const expectedSensorBinding = createM7CampaignSensorBindingV1(
    sensorBindingInput({
      live: input.live,
      contract: input.contract,
      boundAt: registeredAt,
    }),
  );
  const sensorBinding = await campaignStore.bindCampaignSensorOnce(
    sensorBindingInput({
      live: input.live,
      contract: input.contract,
      boundAt: registeredAt,
    }),
  );
  if (!sameJson(sensorBinding, expectedSensorBinding)) {
    throw new Error(`${materials.slug} campaign sensor binding changed`);
  }
  const registrationInput = {
    mutationSha256: input.construction.mutation.mutationSha256,
    mutatedBaselineSelectedTreeSha256:
      input.construction.mutatedBuild.selectedTreeSha256,
    mutatedBuildSourceIdentitySha256: deriveM7BuildSourceIdentitySha256V1({
      sourceId: input.construction.mutatedBuild.sourceId,
      sourceHash: input.construction.mutatedBuild.sourceSha256,
    }),
    adapterMutantCompatibilityReceiptSha256:
      input.construction.adapterMutantCompatibility.receiptRecordSha256,
    publicTaskSpecSha256: input.contract.pairedPublicTaskContractSha256,
    evaluatorImplementationSha256:
      input.construction.evaluatorImplementation.sha256,
    evaluatorBundleSha256: input.construction.evaluatorBundle.sha256,
    provider: input.contract.agentConfiguration.provider,
    model: input.contract.agentConfiguration.model,
    thinkingLevel: input.contract.agentConfiguration.thinkingLevel,
    agentBudgetSha256: input.contract.agentConfiguration.agentBudgetSha256,
    codingToolSetSha256: input.contract.agentConfiguration.codingToolSetSha256,
    sandboxPolicySha256: input.contract.agentConfiguration.sandboxPolicySha256,
    registeredAt,
  };
  const expectedRegistration = createM7MutationRegistrationV1({
    sensorBinding: expectedSensorBinding,
    registration: registrationInput,
  });
  const registration =
    await campaignStore.registerMutationOnce(registrationInput);
  if (!sameJson(registration, expectedRegistration)) {
    throw new Error(`${materials.slug} campaign registration changed`);
  }
  const mutantWitnessKinds = new Set(
    input.preflight.publicTrajectoryObservations[1].selectedWitnesses.map(
      (witness) => witness.kind,
    ),
  );
  const hiddenSummary = input.preflight.hiddenEvaluator.matrix.summary;
  const cleanupProven =
    input.preflight.publicTrajectoryObservations.every(
      (observation) => observation.cleanup.proven,
    ) &&
    input.preflight.hiddenEvaluator.matrix.runs.every(
      (run) => run.cleanupProven,
    );
  const campaignPreflight = await campaignStore.putPreflightOnce({
    pristinePassCount: hiddenSummary.pristineExpectedMotionObserved,
    mutantPublicAndHiddenPassCount:
      hiddenSummary.mutantPublicExpectedMotionObserved +
      hiddenSummary.mutantHiddenExpectedMotionObserved,
    mutantRegressionPassCount:
      hiddenSummary.mutantRegressionExpectedMotionObserved,
    genericClassifierMutantWitnessObserved:
      input.construction.trajectoryCaseSpec.expectedBaselineWitnessKinds.every(
        (kind) => mutantWitnessKinds.has(kind),
      ),
    pristineAdapterConformancePassed: input.construction.outcome === "passed",
    mutantBuildCompatibilityPassed:
      input.construction.adapterMutantCompatibility.outcome === "compatible",
    cleanupProven,
    infrastructureFailureCode: null,
    completedAt: input.now(),
  });
  if (
    input.preflight.outcome !== "passed" ||
    campaignPreflight.outcome !== "passed"
  ) {
    throw new Error(`${materials.slug} did not pass no-Agent admission`);
  }
  const admission = await admissionStore.createAdmissionOnce({
    portfolioFreeze: input.portfolio,
    caseOrdinal: materials.ordinal,
    campaignId: registration.campaignId,
    mutationRegistrationRecordSha256: registration.recordContentSha256,
    naturalPromptCanonicalJsonSha256:
      input.contract.naturalPrompt.canonicalJsonSha256,
    pairedAgentProtocolImplementationSha256:
      input.contract.pairedAgentProtocolImplementationSha256,
    pairedCaseContractContentSha256:
      input.contract.pairedCaseContractContentSha256,
    runtimeArmPublicTaskSpecSha256:
      input.contract.runtimeArmPublicTaskSpecSha256,
    codeOnlyArmPublicTaskSpecSha256:
      input.contract.codeOnlyArmPublicTaskSpecSha256,
    admittedAt: input.now(),
  });
  const bound = await input.prepared.infrastructure.bindCaseOnce({
    caseContract: input.contract,
    caseCampaignAdmission: admission,
  });
  await mutationStore.registerOnce({
    registration,
    baselineRoot: input.prepared.assignment.protectedBaselineRoot,
    evaluatorImplementationPath: materials.evaluatorImplementationPath,
    evaluatorBundlePath: materials.evaluatorBundlePath,
    registeredAt: input.now(),
  });
  const evaluatorProcess = await openEvaluatorProcess({
    live: input.live,
    materials,
  });
  const [runtimeRunner, codeOnlyRunner] = await Promise.all([
    LocalExternalHiddenFixFreshCopyRunnerV1.open({
      temporaryRoot: materials.runtimeEvaluatorTemporaryRoot,
      exposedRoots: agentExposedRoots,
      patchStore: input.prepared.runtimePatchStore,
      evaluator: evaluatorProcess,
      gitBinary: "/usr/bin/git",
    }),
    LocalExternalHiddenFixFreshCopyRunnerV1.open({
      temporaryRoot: materials.codeOnlyEvaluatorTemporaryRoot,
      exposedRoots: agentExposedRoots,
      patchStore: input.prepared.codeOnlyPatchStore,
      evaluator: evaluatorProcess,
      gitBinary: "/usr/bin/git",
    }),
  ]);
  const mutationResolver = {
    resolve: (campaignId: string, registered: M7MutationRegistrationV1) =>
      mutationStore.resolve(campaignId, registered),
  };
  const failedSentinelSha256 = async (): Promise<Sha256DigestV1 | null> => {
    const sentinels = await Promise.all([
      bound.retainedEvidence.readSandboxSentinelReceipt("runtime_enabled"),
      bound.retainedEvidence.readSandboxSentinelReceipt("code_only"),
    ]);
    for (const sentinel of sentinels) {
      if (
        sentinel !== null &&
        (typeof sentinel !== "object" ||
          Array.isArray(sentinel) ||
          sentinel.status !== "succeeded" ||
          sentinel.exitCode !== 0)
      ) {
        return digestJson(sentinel);
      }
    }
    return null;
  };
  return Object.freeze({
    caseAdmission: admission,
    campaignStore,
    armPort: bound.armPort,
    evaluatorPorts: Object.freeze({
      runtime_enabled: createM7R3LocalHiddenEvaluatorPortV1({
        campaignId: registration.campaignId,
        registration,
        mutationResolver,
        runner: runtimeRunner,
      }),
      code_only: createM7R3LocalHiddenEvaluatorPortV1({
        campaignId: registration.campaignId,
        registration,
        mutationResolver,
        runner: codeOnlyRunner,
      }),
    }),
    evidenceStore,
    cleanupRemainingAfterFailure: () => bound.cleanupRemainingAfterFailure(),
    hasAgentStarted: () => bound.hasAgentStarted(),
    persistInfrastructureFailureOnce: input.failureWriter,
    readSandboxSafetyFailureReceiptAfterGate: async () =>
      failedSentinelSha256(),
  });
};

const runDisposableDryCase = async (input: {
  readonly live: LiveMaterials;
  readonly prepared: PreparedCasePhaseOne;
  readonly construction: M7R3CaseConstructionReceiptV1;
  readonly portfolio: M7R3TwoCasePortfolioFreezeV1;
  readonly contract: M7R3PairedCaseContractV1;
  readonly now: () => string;
}): Promise<JsonValue> => {
  const materials = input.prepared.materials;
  const agentExposedRoots = [
    input.live.publicRoot,
    input.live.hostConfig.taskStorageRoot,
    ...input.live.cases.flatMap((candidate) => [
      candidate.runtimeAgentResourceRoot,
      candidate.codeOnlyAgentResourceRoot,
    ]),
  ];
  const [campaignStore, admissionStore] = await Promise.all([
    openM7RuntimeUseCampaignStoreV1({
      root: materials.campaignRoot,
      exposedRoots: agentExposedRoots,
    }),
    openM7R3CaseCampaignAdmissionStoreV1({
      root: materials.campaignRoot,
      exposedRoots: agentExposedRoots,
    }),
  ]);
  const registeredAt = input.now();
  const sensorBinding = await campaignStore.bindCampaignSensorOnce(
    sensorBindingInput({
      live: input.live,
      contract: input.contract,
      boundAt: registeredAt,
    }),
  );
  const registration = await campaignStore.registerMutationOnce({
    mutationSha256: input.construction.mutation.mutationSha256,
    mutatedBaselineSelectedTreeSha256:
      input.construction.mutatedBuild.selectedTreeSha256,
    mutatedBuildSourceIdentitySha256: deriveM7BuildSourceIdentitySha256V1({
      sourceId: input.construction.mutatedBuild.sourceId,
      sourceHash: input.construction.mutatedBuild.sourceSha256,
    }),
    adapterMutantCompatibilityReceiptSha256:
      input.construction.adapterMutantCompatibility.receiptRecordSha256,
    publicTaskSpecSha256: input.contract.pairedPublicTaskContractSha256,
    evaluatorImplementationSha256:
      input.construction.evaluatorImplementation.sha256,
    evaluatorBundleSha256: input.construction.evaluatorBundle.sha256,
    provider: input.contract.agentConfiguration.provider,
    model: input.contract.agentConfiguration.model,
    thinkingLevel: input.contract.agentConfiguration.thinkingLevel,
    agentBudgetSha256: input.contract.agentConfiguration.agentBudgetSha256,
    codingToolSetSha256: input.contract.agentConfiguration.codingToolSetSha256,
    sandboxPolicySha256: input.contract.agentConfiguration.sandboxPolicySha256,
    registeredAt,
  });
  if (
    registration.campaignSensorBindingRecordSha256 !==
      sensorBinding.recordContentSha256 ||
    registration.campaignId.length === 0
  ) {
    throw new Error(`${materials.slug} dry registration crossed its sensor`);
  }
  const admission = await admissionStore.createAdmissionOnce({
    portfolioFreeze: input.portfolio,
    caseOrdinal: materials.ordinal,
    campaignId: registration.campaignId,
    mutationRegistrationRecordSha256: registration.recordContentSha256,
    naturalPromptCanonicalJsonSha256:
      input.contract.naturalPrompt.canonicalJsonSha256,
    pairedAgentProtocolImplementationSha256:
      input.contract.pairedAgentProtocolImplementationSha256,
    pairedCaseContractContentSha256:
      input.contract.pairedCaseContractContentSha256,
    runtimeArmPublicTaskSpecSha256:
      input.contract.runtimeArmPublicTaskSpecSha256,
    codeOnlyArmPublicTaskSpecSha256:
      input.contract.codeOnlyArmPublicTaskSpecSha256,
    admittedAt: input.now(),
  });
  const bound = await input.prepared.infrastructure.bindCaseOnce({
    caseContract: input.contract,
    caseCampaignAdmission: admission,
  });
  const dryPort = await prepareM7R3ProjectEnvironmentPairedAgentPortV1({
    runtimeArm: bound.runtimeArm,
    codeOnlyArm: bound.codeOnlyArm,
  });
  let sentinelHashes: readonly [Sha256DigestV1, Sha256DigestV1] | undefined;
  let primaryFailure: unknown;
  try {
    const runtime =
      await dryPort.runPreAgentSandboxSentinelOnce("runtime_enabled");
    const codeOnly = await dryPort.runPreAgentSandboxSentinelOnce("code_only");
    sentinelHashes = [runtime, codeOnly];
  } catch (error) {
    primaryFailure = error;
  }
  let cleanup: Awaited<ReturnType<typeof bound.cleanupRemainingAfterFailure>>;
  try {
    cleanup = await bound.cleanupRemainingAfterFailure();
  } catch (error) {
    throw new AggregateError(
      [...(primaryFailure === undefined ? [] : [primaryFailure]), error],
      `${materials.slug} dry sentinel or cleanup failed`,
    );
  }
  if (primaryFailure !== undefined) {
    throw asError(primaryFailure, `${materials.slug} dry sentinel failed`);
  }
  if (
    sentinelHashes === undefined ||
    bound.hasAgentStarted() ||
    !cleanup.cleanupProven ||
    cleanup.sandboxSafetyFailure
  ) {
    throw new Error(
      `${materials.slug} dry protocol/sandbox admission did not close cleanly`,
    );
  }
  return JsonValueSchema.parse({
    schemaVersion: 1,
    ordinal: materials.ordinal,
    campaignId: registration.campaignId,
    caseAdmissionRecordSha256: admission.recordContentSha256,
    pairedCaseContractContentSha256:
      input.contract.pairedCaseContractContentSha256,
    sandboxSentinelReceiptSha256s: sentinelHashes,
    cleanup,
    agentLaunchCount: 0,
    providerInvocationCount: 0,
    piSessionCount: 0,
  });
};

const createFormalCasePlans = (input: {
  readonly live: LiveMaterials;
  readonly constructionStore: M7R3CaseConstructionStoreV1;
  readonly prepared: readonly [PreparedCasePhaseOne, PreparedCasePhaseOne];
  readonly constructions: readonly [
    M7R3CaseConstructionReceiptV1,
    M7R3CaseConstructionReceiptV1,
  ];
  readonly expectedPortfolio: M7R3TwoCasePortfolioFreezeV1;
  readonly contracts: readonly [
    M7R3PairedCaseContractV1,
    M7R3PairedCaseContractV1,
  ];
  readonly now: () => string;
}): readonly [M7R3TwoCaseLocalCasePlanV1<1>, M7R3TwoCaseLocalCasePlanV1<2>] => {
  const failureWriters = [
    createCampaignFailureWriter({ materials: input.prepared[0].materials }),
    createCampaignFailureWriter({ materials: input.prepared[1].materials }),
  ] as const;
  const aborts: Array<Promise<unknown> | null> = [null, null];
  const abortOnce = (index: 0 | 1): Promise<unknown> => {
    aborts[index] ??= input.prepared[index].infrastructure.abortPreparation();
    return aborts[index];
  };
  let preflightPromise: Promise<M7R3TwoCasePreflightRunResultV1> | null = null;
  const runSharedPreflight = (
    portfolio: M7R3TwoCasePortfolioFreezeV1,
  ): Promise<M7R3TwoCasePreflightRunResultV1> => {
    if (!sameJson(portfolio, input.expectedPortfolio)) {
      throw new TypeError("R3 preflight received a substituted portfolio");
    }
    preflightPromise ??= runAndPersistNoAgentPreflights({
      live: input.live,
      constructionStore: input.constructionStore,
      prepared: input.prepared,
      constructions: input.constructions,
      portfolio,
      now: input.now,
    });
    return preflightPromise;
  };
  const preflightFor = async (
    index: 0 | 1,
    request: Parameters<
      M7R3TwoCaseLocalCasePlanV1<1>["runAndPersistPreflightOnce"]
    >[0],
  ) => {
    if (
      !sameJson(request.portfolioFreeze, input.expectedPortfolio) ||
      !sameJson(request.constructionReceipt, input.constructions[index]) ||
      !sameJson(request.trajectoryClassifierFreeze, input.live.classifierFreeze)
    ) {
      throw new TypeError("R3 case preflight callback crossed frozen inputs");
    }
    const result = await runSharedPreflight(request.portfolioFreeze);
    if (result.status !== "completed") {
      await Promise.allSettled([abortOnce(0), abortOnce(1)]);
      throw new Error(
        "R3 no-Agent preflight safety-stopped before both cases completed",
      );
    }
    const receipt = result.receipts[index];
    if (receipt.outcome !== "passed") await abortOnce(index);
    return receipt;
  };
  const preparedCampaign = [false, false];
  const prepareCampaign = async (
    index: 0 | 1,
    request: Parameters<
      M7R3TwoCaseLocalCasePlanV1<1>["prepareCampaignWithoutStartingAgentOnce"]
    >[0],
  ): Promise<M7R3PreparedLocalCaseCampaignV1> => {
    if (preparedCampaign[index]) {
      throw new Error("R3 case campaign preparation may run only once");
    }
    preparedCampaign[index] = true;
    if (
      !sameJson(request.portfolioFreeze, input.expectedPortfolio) ||
      !sameJson(request.constructionReceipt, input.constructions[index]) ||
      !sameJson(request.caseContract, input.contracts[index]) ||
      !sameJson(
        request.preflightReceipt,
        await input.constructionStore.readPreflight((index + 1) as 1 | 2),
      )
    ) {
      throw new TypeError(
        "R3 campaign preparation callback crossed its frozen inputs",
      );
    }
    return registerCampaignWithoutAgent({
      live: input.live,
      prepared: input.prepared[index],
      construction: input.constructions[index],
      preflight: request.preflightReceipt,
      portfolio: request.portfolioFreeze,
      contract: request.caseContract,
      now: input.now,
      failureWriter: failureWriters[index],
    });
  };
  const first: M7R3TwoCaseLocalCasePlanV1<1> = {
    ordinal: 1,
    caseContract: input.contracts[0],
    runAndPersistPreflightOnce: (request) => preflightFor(0, request),
    prepareCampaignWithoutStartingAgentOnce: (request) =>
      prepareCampaign(0, request),
    abortPreparation: () => abortOnce(0),
    persistInfrastructureFailureOnce: failureWriters[0],
  };
  const second: M7R3TwoCaseLocalCasePlanV1<2> = {
    ordinal: 2,
    caseContract: input.contracts[1],
    runAndPersistPreflightOnce: (request) => preflightFor(1, request),
    prepareCampaignWithoutStartingAgentOnce: (request) =>
      prepareCampaign(1, request),
    abortPreparation: () => abortOnce(1),
    persistInfrastructureFailureOnce: failureWriters[1],
  };
  return [first, second];
};

const monotonicNow = (): (() => string) => {
  let previous = Date.now() - 1;
  return () => {
    previous = Math.max(Date.now(), previous + 1);
    return new Date(previous).toISOString();
  };
};

describe("M7 R3 moddable-platformer runtime-use two-case local portfolio", () => {
  it(
    "admits the frozen two-case design and invokes the formal Gate only in r3-live mode",
    { timeout: 10_800_000 },
    async () => {
      const live = await verifyLiveMaterials();
      const now = monotonicNow();
      const exposedRoots = [
        live.publicRoot,
        live.hostConfig.taskStorageRoot,
        ...live.cases.flatMap((materials) => [
          materials.runtimeAgentResourceRoot,
          materials.codeOnlyAgentResourceRoot,
        ]),
      ];
      const [constructionStore, portfolioStore] = await Promise.all([
        openM7R3CaseConstructionStoreV1({
          root: live.constructionRoot,
          exposedRoots,
        }),
        openM7R3TwoCasePortfolioStoreV1({
          root: live.portfolioRoot,
          exposedRoots,
        }),
      ]);
      const prepared: PreparedCasePhaseOne[] = [];
      let primaryFailure: unknown;
      try {
        for (const materials of live.cases) {
          prepared.push(await prepareCasePhaseOne({ live, materials, now }));
        }
        const [firstPrepared, secondPrepared] = prepared;
        if (firstPrepared === undefined || secondPrepared === undefined) {
          throw new Error(
            "R3 did not prepare exactly two case infrastructures",
          );
        }
        const preparedPair = [firstPrepared, secondPrepared] as const;
        const constructions = await createConstructions({
          live,
          store: constructionStore,
          prepared: preparedPair,
          now,
        });
        if (
          constructions[0].outcome !== "passed" ||
          constructions[1].outcome !== "passed"
        ) {
          throw new Error(
            "R3 retained a construction failure; no preflight or Agent may start",
          );
        }
        const portfolioInput = createPortfolioInput({
          live,
          prepared: preparedPair,
          constructions,
          frozenAt: now(),
        });
        const expectedPortfolio =
          createM7R3TwoCasePortfolioFreezeV1(portfolioInput);
        const contracts = [
          createCaseContract({
            live,
            portfolio: expectedPortfolio,
            construction: constructions[0],
            prepared: preparedPair[0],
          }),
          createCaseContract({
            live,
            portfolio: expectedPortfolio,
            construction: constructions[1],
            prepared: preparedPair[1],
          }),
        ] as const;

        if (live.mode === "pre-agent-dry-run") {
          const portfolio =
            await portfolioStore.createPortfolioOnce(portfolioInput);
          if (!sameJson(portfolio, expectedPortfolio)) {
            throw new Error("R3 dry portfolio changed during persistence");
          }
          const dryCases: JsonValue[] = [];
          for (const index of [0, 1] as const) {
            dryCases.push(
              await runDisposableDryCase({
                live,
                prepared: preparedPair[index],
                construction: constructions[index],
                portfolio,
                contract: contracts[index],
                now,
              }),
            );
          }
          process.stdout.write(
            `${canonicalJson(
              JsonValueSchema.parse({
                schemaVersion: 1,
                receiptKind: "m7-r3-pre-agent-dry-run",
                outcome: "passed",
                disposableConstructionAndPortfolio: true,
                publicBehaviorPreflightInvoked: false,
                hiddenEvaluatorInvoked: false,
                formalGateInvoked: false,
                operationalManifestFileSha256:
                  live.operationalHostConfigs.manifestFileSha256,
                operationalManifestRecordContentSha256:
                  live.operationalHostConfigs.manifest.recordContentSha256,
                realizedTopologyReceiptFileSha256:
                  live.realizedCgroupTopology.receiptFileSha256,
                realizedTopologyReceiptRecordContentSha256:
                  live.realizedCgroupTopology.receipt.recordContentSha256,
                agentLaunchCount: 0,
                providerInvocationCount: 0,
                piSessionCount: 0,
                cases: dryCases,
              }),
            )}\n`,
          );
          return;
        }

        const casePlans = createFormalCasePlans({
          live,
          constructionStore,
          prepared: preparedPair,
          constructions,
          expectedPortfolio,
          contracts,
          now,
        });
        const terminal = await runM7R3TwoCaseLocalPortfolioV1({
          trajectoryClassifierFreeze: live.classifierFreeze,
          constructionReceipts: constructions,
          portfolioFreezeInput: portfolioInput,
          portfolioStore:
            asM7R3TwoCaseLocalPortfolioStorePortV1(portfolioStore),
          cases: casePlans,
          now,
        });
        expect(terminal.portfolioFreeze.portfolioId).toBe(
          expectedPortfolio.portfolioId,
        );
        expect(terminal.caseReferences).toHaveLength(2);
        process.stdout.write(
          `${canonicalJson(JsonValueSchema.parse(terminal))}\n`,
        );
      } catch (error) {
        primaryFailure = error;
      }
      const cleanupResults = await Promise.allSettled(
        prepared.map((value) => value.infrastructure.abortPreparation()),
      );
      const cleanupFailures: Error[] = [];
      for (const cleanup of cleanupResults) {
        if (cleanup.status === "rejected") {
          cleanupFailures.push(
            asError(cleanup.reason, "R3 residual preparation cleanup failed"),
          );
        } else if (!cleanup.value.cleanupProven) {
          cleanupFailures.push(
            new Error("R3 residual preparation cleanup was not proven"),
          );
        }
      }
      if (primaryFailure !== undefined || cleanupFailures.length > 0) {
        throw new AggregateError(
          [
            ...(primaryFailure === undefined
              ? []
              : [asError(primaryFailure, "R3 live entry failed")]),
            ...cleanupFailures,
          ],
          "R3 live entry or residual cleanup failed",
        );
      }
    },
  );
});
