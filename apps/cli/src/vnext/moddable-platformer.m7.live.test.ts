import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { PROJECT_ENVIRONMENT_GAME_TOOL_DEFINITIONS_V1 } from "@chronorift/agent-protocol";
import {
  AdapterConformanceReceiptV1Schema,
  JsonValueSchema,
  M6AdapterBuildCompatibilityReceiptV1Schema,
  ProjectAdapterRevisionV1Schema,
  Sha256DigestV1Schema,
  VNextBuildV1Schema,
  asSha256DigestV1,
  type Sha256DigestV1,
} from "@chronorift/domain";
import { canonicalJson, contentHash } from "@chronorift/json-artifacts";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  ExternalHiddenFixPublicTaskSpecV1Schema,
  prepareExternalHiddenFixAssignmentV1,
} from "./external-hidden-fix-assignment.js";
import { LocalExternalHiddenFixPatchStoreV1 } from "./external-hidden-fix-evaluator.js";
import { createM6AdmittedGameToolsV1 } from "./m6-one-turn-agent.js";
import {
  prepareM6ProjectEnvironmentOneTurnTaskV1,
  type M6PublicExecutionClassifierV1,
} from "./m6-project-environment-one-turn.js";
import {
  M7_NATURAL_USER_PROMPT_V1,
  M7PairedAgentBudgetFileV1Schema,
  createM7PairedAgentProtocolV1,
  normalizeM7PairedAgentBudgetV1,
  runM7PairedAgentArmOnceV1,
  type M7PairedAgentArmV1,
  type M7PairedAgentPortV1,
  type M7PairedAgentProtocolV1,
} from "./m7-paired-agent.js";
import {
  M7HiddenMutationRegistrationV1Schema,
  M7PatrolPreflightResultV1Schema,
  M7SensorFreezeRecordV1Schema,
  assertExactM7HiddenMutationBytesV1,
} from "./m7-patrol-sensor.js";
import { prepareM7ProjectEnvironmentPairedAgentPortV1 } from "./m7-project-environment-paired-agent.js";
import {
  prepareM7PairedInfrastructureFromM6RuntimeTaskV1,
  type M7BoundPairedProjectEnvironmentV1,
  type M7PreparedPairedProjectEnvironmentInfrastructureV1,
} from "./m7-project-environment-paired-preparation.js";
import {
  M7RuntimeUseLocalEvidenceStoreV1,
  M7RuntimeUseLocalMutationStoreV1,
  runM7RuntimeUseLocalCampaignGateV1,
  type M7LocalArmAdmissionV1,
  M7LocalArmAdmissionV1Schema,
  type M7RuntimeUsePairedArmResultPortV1,
} from "./m7-runtime-use-local-gate.js";
import {
  createM7CampaignSensorBindingV1,
  createM7MutationRegistrationV1,
  deriveM7BuildSourceIdentitySha256V1,
  M7CampaignTerminalRecordV1Schema,
  openM7RuntimeUseCampaignStoreV1,
  type M7CampaignSensorBindingV1,
  type M7BuildSourceIdentitySha256V1,
  type M7MutationRegistrationV1,
  type M7RuntimeUseCampaignStoreV1,
} from "./m7-runtime-use-campaign.js";
import {
  readProjectEnvironmentHostConfigV1,
  type ProjectEnvironmentHostConfigV1,
} from "./project-environment-host-config.js";
import { SandboxCleanupReceiptV1Schema } from "./contracts.js";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MAX_JSON_BYTES = 32 * 1024 * 1024;

const pairedTaskSchema = z
  .object({
    schemaVersion: z.literal(1),
    taskKind: z.literal("m7-runtime-use-ablation"),
    goal: z.literal(M7_NATURAL_USER_PROMPT_V1),
    modelSelection: z
      .object({
        provider: z.string().min(1).max(256),
        model: z.string().min(1).max(256),
        thinkingLevel: z.enum([
          "off",
          "minimal",
          "low",
          "medium",
          "high",
          "xhigh",
          "max",
        ]),
      })
      .strict(),
    agentBudget: M7PairedAgentBudgetFileV1Schema,
    armOrder: z.tuple([z.literal("runtime_enabled"), z.literal("code_only")]),
    treatmentDifference: z.literal("chronorift_runtime_surface"),
    runtimeUseNotRequiredByPrompt: z.literal(true),
  })
  .strict();

const mutantAdmissionSchema = z
  .object({
    schemaVersion: z.literal(1),
    receiptKind: z.literal("m7-mutant-admission"),
    admissionId: z.string().regex(/^m7-mutant-admission:[a-f0-9]{24}$/u),
    agentStarted: z.literal(false),
    providerUsed: z.literal(false),
    sensorFreezeId: z.string().regex(/^m7-sensor-freeze:[a-f0-9]{24}$/u),
    mutationRegistrationId: z.string().regex(/^m7-mutation:[a-f0-9]{24}$/u),
    adapterRevisionId: z.string().min(1).max(512),
    pristineAdapterSourceId: z.string().min(1).max(512),
    mutantBuild: VNextBuildV1Schema,
    compatibilityReceipt: M6AdapterBuildCompatibilityReceiptV1Schema,
    compatibilityReceiptSha256: Sha256DigestV1Schema,
    genericClassifier: z
      .object({
        classifierId: z.string().min(1).max(256),
        implementationSha256: Sha256DigestV1Schema,
        inputSha256: Sha256DigestV1Schema,
        outputSha256: Sha256DigestV1Schema,
        output: JsonValueSchema,
        mutantFallWitnessObserved: z.literal(true),
      })
      .strict(),
    publicRuntime: z
      .object({
        receiptId: z.string().min(1).max(512),
        receiptSha256: Sha256DigestV1Schema,
        outcome: z.literal("succeeded"),
        coverageComplete: z.literal(true),
        lossCount: z.literal(0),
        pinnedCaptureCount: z.number().int().positive(),
        pinnedRecordCount: z.number().int().positive(),
        toolSequence: z.array(z.string().min(1).max(256)).min(1).max(10_000),
      })
      .strict(),
    sandboxCleanup: SandboxCleanupReceiptV1Schema,
    securityEventCount: z.literal(0),
    completedAt: z.string().datetime({ offset: true }),
    receiptContentSha256: Sha256DigestV1Schema,
  })
  .strict()
  .superRefine((value, context) => {
    const { receiptContentSha256, ...basis } = value;
    if (receiptContentSha256 !== jsonDigest(basis)) {
      context.addIssue({
        code: "custom",
        path: ["receiptContentSha256"],
        message: "mutant admission content hash does not match",
      });
    }
    const expectedAdmissionId = `m7-mutant-admission:${jsonDigest({
      schemaVersion: 1,
      sensorFreezeId: value.sensorFreezeId,
      mutationRegistrationId: value.mutationRegistrationId,
      buildId: value.mutantBuild.buildId,
      classifierSha256: value.genericClassifier.implementationSha256,
    }).slice(0, 24)}`;
    if (value.admissionId !== expectedAdmissionId) {
      context.addIssue({
        code: "custom",
        path: ["admissionId"],
        message: "mutant admission identity does not match",
      });
    }
    if (
      value.compatibilityReceiptSha256 !==
      jsonDigest(value.compatibilityReceipt)
    ) {
      context.addIssue({
        code: "custom",
        path: ["compatibilityReceiptSha256"],
        message: "mutant compatibility receipt hash does not match",
      });
    }
    const output = value.genericClassifier.output;
    if (
      typeof output !== "object" ||
      output === null ||
      Array.isArray(output) ||
      output.classification !== "fell_without_reversing" ||
      typeof output.fallWitnessCount !== "number" ||
      output.fallWitnessCount < 1 ||
      output.reversalWitnessCount !== 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["genericClassifier", "output"],
        message: "mutant admission lacks the frozen generic fall witness",
      });
    }
  });

const requiredEnvironment = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`M7 live infrastructure requires ${name}`);
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
    throw new Error("M7 live infrastructure requires Unix ownership checks");
  }
  return uid;
};

const canonicalDirectory = async (
  name: string,
  options: {
    readonly privateDirectory?: boolean;
    readonly empty?: boolean;
  } = {},
): Promise<string> => {
  const path = requiredEnvironment(name);
  const [canonical, metadata] = await Promise.all([
    realpath(path),
    lstat(path),
  ]);
  if (
    canonical !== path ||
    metadata.isSymbolicLink() ||
    !metadata.isDirectory()
  ) {
    throw new Error(`${name} must be a canonical real directory`);
  }
  if (
    options.privateDirectory === true &&
    (metadata.uid !== currentUserId() ||
      (metadata.mode & 0o7777) !== PRIVATE_DIRECTORY_MODE)
  ) {
    throw new Error(`${name} must be owned by this user with mode 0700`);
  }
  if (options.empty === true && (await readdir(path)).length !== 0) {
    throw new Error(`${name} must be fresh and empty`);
  }
  return path;
};

const canonicalFile = async (
  name: string,
  options: { readonly privateFile?: boolean } = {},
): Promise<string> => {
  const path = requiredEnvironment(name);
  const [canonical, metadata] = await Promise.all([
    realpath(path),
    lstat(path),
  ]);
  if (canonical !== path || metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`${name} must be a canonical regular file`);
  }
  if (
    metadata.nlink !== 1 ||
    (options.privateFile === true &&
      (metadata.uid !== currentUserId() ||
        (metadata.mode & 0o7777) !== PRIVATE_FILE_MODE))
  ) {
    throw new Error(
      `${name} must be a one-link${options.privateFile === true ? " owned mode-0600" : ""} file`,
    );
  }
  return path;
};

const rawDigest = (bytes: Uint8Array): Sha256DigestV1 =>
  asSha256DigestV1(createHash("sha256").update(bytes).digest("hex"));

const jsonDigest = (value: unknown): Sha256DigestV1 =>
  asSha256DigestV1(contentHash(JsonValueSchema.parse(value)));

const loadJson = async <T>(
  path: string,
  schema: z.ZodType<T>,
): Promise<{ readonly value: T; readonly bytes: Uint8Array }> => {
  const bytes = await readFile(path);
  if (bytes.byteLength > MAX_JSON_BYTES) {
    throw new Error(`M7 live JSON exceeds its byte limit: ${path}`);
  }
  const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const json = JsonValueSchema.parse(JSON.parse(decoded) as unknown);
  return { value: schema.parse(json), bytes };
};

const collectFrozenAdapterPackageBytes = async (
  packageRoot: string,
): Promise<Uint8Array> => {
  const paths: string[] = [];
  const pending = [packageRoot];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined) break;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (!pathWithinOrEqual(packageRoot, path)) {
        throw new Error("M7 Adapter package entry escaped its root");
      }
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) paths.push(path);
      else throw new Error("M7 Adapter package contains a non-regular entry");
    }
  }
  paths.sort((left, right) =>
    relative(packageRoot, left).localeCompare(
      relative(packageRoot, right),
      "en",
    ),
  );
  const chunks: Buffer[] = [];
  for (const path of paths) {
    const metadata = await lstat(path);
    if (
      metadata.isSymbolicLink() ||
      !metadata.isFile() ||
      metadata.nlink !== 1 ||
      metadata.uid !== currentUserId() ||
      (metadata.mode & 0o7777) !== PRIVATE_FILE_MODE
    ) {
      throw new Error("M7 Adapter package bytes are no longer private/frozen");
    }
    chunks.push(Buffer.from(relative(packageRoot, path), "utf8"));
    chunks.push(Buffer.from([0]));
    chunks.push(await readFile(path));
    chunks.push(Buffer.from([0]));
  }
  return Buffer.concat(chunks);
};

const loadPublicExecutionClassifier = async (input: {
  readonly publicRoot: string;
  readonly implementationPath: string;
  readonly publicTask: z.infer<typeof ExternalHiddenFixPublicTaskSpecV1Schema>;
}): Promise<M6PublicExecutionClassifierV1> => {
  if (!pathWithinOrEqual(input.publicRoot, input.implementationPath)) {
    throw new Error("M7 public classifier escaped its Agent-visible root");
  }
  const bytes = await readFile(input.implementationPath);
  const implementationSha256 = rawDigest(bytes);
  if (
    implementationSha256 !==
    input.publicTask.publicExecutionClassifier.implementationSha256
  ) {
    throw new Error("M7 public classifier changed after admission");
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
      "M7 public classifier must export classifyM6PublicExecutionV1(input)",
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
        throw new Error("M7 public classifier returned an invalid M6 view");
      }
      return Object.freeze({
        publicSymptomObserved: output.publicSymptomObserved,
        observation: JsonValueSchema.parse(output.observation),
      });
    },
  });
};

interface M7VerifiedLiveMaterials {
  readonly publicRoot: string;
  readonly hostOnlyRoot: string;
  readonly campaignRoot: string;
  readonly evidenceRoot: string;
  readonly runtimePatchRoot: string;
  readonly codeOnlyPatchRoot: string;
  readonly evaluatorTemporaryRoot: string;
  readonly pristineProjectRoot: string;
  readonly mutantProjectRoot: string;
  readonly adapterPackageRoot: string;
  readonly adapterRevisionPath: string;
  readonly adapterConformancePath: string;
  readonly sensorFreezePath: string;
  readonly mutationRegistrationPath: string;
  readonly mutationPath: string;
  readonly preflightPath: string;
  readonly mutantAdmissionPath: string;
  readonly evaluatorImplementationPath: string;
  readonly evaluatorBundlePath: string;
  readonly publicClassifierPath: string;
  readonly pairedTaskPath: string;
  readonly runtimeTaskPath: string;
  readonly codeOnlyTaskPath: string;
  readonly hostConfigPath: string;
  readonly assignmentRoot: string;
  readonly runtimeAgentResourceRoot: string;
  readonly codeOnlyAgentResourceRoot: string;
  readonly hostModelAgentDir: string;
  readonly sensorFreeze: z.infer<typeof M7SensorFreezeRecordV1Schema>;
  readonly mutationRegistration: z.infer<
    typeof M7HiddenMutationRegistrationV1Schema
  >;
  readonly preflight: z.infer<typeof M7PatrolPreflightResultV1Schema>;
  readonly mutantAdmission: z.infer<typeof mutantAdmissionSchema>;
  readonly adapterRevision: z.infer<typeof ProjectAdapterRevisionV1Schema>;
  readonly pairedTask: z.infer<typeof pairedTaskSchema>;
  readonly hostConfig: ProjectEnvironmentHostConfigV1;
  readonly runtimeTask: z.infer<typeof ExternalHiddenFixPublicTaskSpecV1Schema>;
  readonly codeOnlyTask: z.infer<
    typeof ExternalHiddenFixPublicTaskSpecV1Schema
  >;
  readonly publicTaskSpecSha256: Sha256DigestV1;
  readonly runtimeTaskSpecSha256: Sha256DigestV1;
  readonly codeOnlyTaskSpecSha256: Sha256DigestV1;
  readonly adapterRevisionFileSha256: Sha256DigestV1;
  readonly admittedGameToolsSha256: Sha256DigestV1;
  readonly evaluatorImplementationSha256: Sha256DigestV1;
  readonly evaluatorBundleSha256: Sha256DigestV1;
  readonly mutatedBuildSourceIdentitySha256: M7BuildSourceIdentitySha256V1;
  readonly hostModelRuntimeConfigSha256: Sha256DigestV1;
}

const verifyPreexistingM7LiveMaterials =
  async (): Promise<M7VerifiedLiveMaterials> => {
    const publicRoot = await canonicalDirectory(
      "CHRONORIFT_TEST_M7_PUBLIC_ROOT",
    );
    const hostOnlyRoot = await canonicalDirectory(
      "CHRONORIFT_TEST_M7_HOST_ONLY_ROOT",
      { privateDirectory: true },
    );
    const [
      campaignRoot,
      evidenceRoot,
      runtimePatchRoot,
      codeOnlyPatchRoot,
      evaluatorTemporaryRoot,
      assignmentRoot,
      runtimeAgentResourceRoot,
      codeOnlyAgentResourceRoot,
      hostModelAgentDir,
    ] = await Promise.all([
      canonicalDirectory("CHRONORIFT_TEST_M7_CAMPAIGN_ROOT", {
        privateDirectory: true,
        empty: true,
      }),
      canonicalDirectory("CHRONORIFT_TEST_M7_EVIDENCE_ROOT", {
        privateDirectory: true,
        empty: true,
      }),
      canonicalDirectory("CHRONORIFT_TEST_M7_RUNTIME_PATCH_ROOT", {
        privateDirectory: true,
        empty: true,
      }),
      canonicalDirectory("CHRONORIFT_TEST_M7_CODE_ONLY_PATCH_ROOT", {
        privateDirectory: true,
        empty: true,
      }),
      canonicalDirectory("CHRONORIFT_TEST_M7_EVALUATOR_TEMP_ROOT", {
        privateDirectory: true,
        empty: true,
      }),
      canonicalDirectory("CHRONORIFT_TEST_M7_ASSIGNMENT_ROOT", {
        privateDirectory: true,
        empty: true,
      }),
      canonicalDirectory("CHRONORIFT_TEST_M7_RUNTIME_AGENT_RESOURCES", {
        privateDirectory: true,
        empty: true,
      }),
      canonicalDirectory("CHRONORIFT_TEST_M7_CODE_ONLY_AGENT_RESOURCES", {
        privateDirectory: true,
        empty: true,
      }),
      canonicalDirectory("PI_CODING_AGENT_DIR", {
        privateDirectory: true,
      }),
    ]);
    const directoryEntries = [
      { label: "public", path: publicRoot },
      { label: "campaign", path: campaignRoot },
      { label: "evidence", path: evidenceRoot },
      { label: "runtime patch", path: runtimePatchRoot },
      { label: "code-only patch", path: codeOnlyPatchRoot },
      { label: "evaluator temporary", path: evaluatorTemporaryRoot },
      { label: "assignment", path: assignmentRoot },
      { label: "runtime Agent resources", path: runtimeAgentResourceRoot },
      { label: "code-only Agent resources", path: codeOnlyAgentResourceRoot },
      { label: "Host model Agent config", path: hostModelAgentDir },
    ];
    for (const [index, left] of directoryEntries.entries()) {
      for (const right of directoryEntries.slice(index + 1)) {
        if (
          pathWithinOrEqual(left.path, right.path) ||
          pathWithinOrEqual(right.path, left.path)
        ) {
          throw new Error(
            `M7 ${left.label} and ${right.label} roots must be disjoint`,
          );
        }
      }
    }
    if (
      pathWithinOrEqual(publicRoot, hostOnlyRoot) ||
      pathWithinOrEqual(hostOnlyRoot, publicRoot)
    ) {
      throw new Error("M7 public and Host-only roots must be disjoint");
    }
    for (const agentResourceRoot of [
      runtimeAgentResourceRoot,
      codeOnlyAgentResourceRoot,
    ]) {
      if (
        pathWithinOrEqual(hostOnlyRoot, agentResourceRoot) ||
        pathWithinOrEqual(agentResourceRoot, hostOnlyRoot)
      ) {
        throw new Error(
          "M7 per-arm Agent resources must remain outside Host-only storage",
        );
      }
    }
    for (const entry of [
      { label: "campaign", path: campaignRoot },
      { label: "evidence", path: evidenceRoot },
      { label: "assignment", path: assignmentRoot },
    ]) {
      if (!pathWithinOrEqual(hostOnlyRoot, entry.path)) {
        throw new Error(
          `${entry.label} root must remain below Host-only storage`,
        );
      }
    }

    const [
      adapterRevisionPath,
      adapterConformancePath,
      sensorFreezePath,
      mutationRegistrationPath,
      mutationPath,
      preflightPath,
      mutantAdmissionPath,
      evaluatorImplementationPath,
      evaluatorBundlePath,
    ] = await Promise.all([
      canonicalFile("CHRONORIFT_TEST_M7_ADAPTER_REVISION", {
        privateFile: true,
      }),
      canonicalFile("CHRONORIFT_TEST_M7_ADAPTER_CONFORMANCE", {
        privateFile: true,
      }),
      canonicalFile("CHRONORIFT_TEST_M7_SENSOR_FREEZE", { privateFile: true }),
      canonicalFile("CHRONORIFT_TEST_M7_MUTATION_REGISTRATION", {
        privateFile: true,
      }),
      canonicalFile("CHRONORIFT_TEST_M7_MUTATION", { privateFile: true }),
      canonicalFile("CHRONORIFT_TEST_M7_PREFLIGHT", { privateFile: true }),
      canonicalFile("CHRONORIFT_TEST_M7_MUTANT_ADMISSION", {
        privateFile: true,
      }),
      canonicalFile("CHRONORIFT_TEST_M7_EVALUATOR_IMPLEMENTATION", {
        privateFile: true,
      }),
      canonicalFile("CHRONORIFT_TEST_M7_EVALUATOR_BUNDLE", {
        privateFile: true,
      }),
    ]);
    for (const path of [
      adapterRevisionPath,
      adapterConformancePath,
      sensorFreezePath,
      mutationRegistrationPath,
      mutationPath,
      preflightPath,
      mutantAdmissionPath,
      evaluatorImplementationPath,
      evaluatorBundlePath,
    ]) {
      if (!pathWithinOrEqual(hostOnlyRoot, path)) {
        throw new Error("M7 private material escaped the Host-only root");
      }
    }

    const [
      publicClassifierPath,
      pairedTaskPath,
      runtimeTaskPath,
      codeOnlyTaskPath,
      hostConfigPath,
    ] = await Promise.all([
      canonicalFile("CHRONORIFT_TEST_M7_PUBLIC_CLASSIFIER"),
      canonicalFile("CHRONORIFT_TEST_M7_PAIRED_TASK_SPEC"),
      canonicalFile("CHRONORIFT_TEST_M7_RUNTIME_TASK_SPEC"),
      canonicalFile("CHRONORIFT_TEST_M7_CODE_ONLY_TASK_SPEC"),
      canonicalFile("CHRONORIFT_TEST_M7_HOST_CONFIG"),
    ]);
    const hostConfig = await readProjectEnvironmentHostConfigV1(hostConfigPath);
    for (const path of [
      publicClassifierPath,
      pairedTaskPath,
      runtimeTaskPath,
      codeOnlyTaskPath,
    ]) {
      if (!pathWithinOrEqual(publicRoot, path)) {
        throw new Error("M7 public material escaped the Agent-visible root");
      }
    }
    for (const hiddenPath of [
      hostOnlyRoot,
      evidenceRoot,
      runtimePatchRoot,
      codeOnlyPatchRoot,
      evaluatorTemporaryRoot,
      runtimeAgentResourceRoot,
      codeOnlyAgentResourceRoot,
      hostModelAgentDir,
    ]) {
      if (
        pathWithinOrEqual(hostConfig.taskStorageRoot, hiddenPath) ||
        pathWithinOrEqual(hiddenPath, hostConfig.taskStorageRoot) ||
        pathWithinOrEqual(publicRoot, hiddenPath) ||
        pathWithinOrEqual(hiddenPath, publicRoot)
      ) {
        throw new Error(
          "M7 hidden/model/evaluator roots must be disjoint from Agent-exposed storage",
        );
      }
    }

    const [pristineProjectRoot, mutantProjectRoot, adapterPackageRoot] =
      await Promise.all([
        canonicalDirectory("CHRONORIFT_TEST_M7_PRISTINE_PROJECT"),
        canonicalDirectory("CHRONORIFT_TEST_M7_MUTATED_PROJECT"),
        canonicalDirectory("CHRONORIFT_TEST_M7_ADAPTER_PACKAGE", {
          privateDirectory: true,
        }),
      ]);
    if (!pathWithinOrEqual(hostOnlyRoot, adapterPackageRoot)) {
      throw new Error("M7 Adapter package escaped the Host-only root");
    }
    const agentExposedRoots = [
      publicRoot,
      hostConfig.taskStorageRoot,
      runtimeAgentResourceRoot,
      codeOnlyAgentResourceRoot,
    ];
    for (const [label, projectRoot] of [
      ["pristine project", pristineProjectRoot],
      ["mutated project", mutantProjectRoot],
    ] as const) {
      for (const exposedRoot of agentExposedRoots) {
        if (
          pathWithinOrEqual(exposedRoot, projectRoot) ||
          pathWithinOrEqual(projectRoot, exposedRoot)
        ) {
          throw new Error(
            `M7 ${label} source must remain outside Agent-exposed storage`,
          );
        }
      }
    }
    if (
      pathWithinOrEqual(pristineProjectRoot, mutantProjectRoot) ||
      pathWithinOrEqual(mutantProjectRoot, pristineProjectRoot) ||
      pathWithinOrEqual(adapterPackageRoot, pristineProjectRoot) ||
      pathWithinOrEqual(pristineProjectRoot, adapterPackageRoot) ||
      pathWithinOrEqual(adapterPackageRoot, mutantProjectRoot) ||
      pathWithinOrEqual(mutantProjectRoot, adapterPackageRoot)
    ) {
      throw new Error(
        "M7 pristine, mutated, and frozen Adapter source roots must be disjoint",
      );
    }

    const [
      sensor,
      mutation,
      preflight,
      admission,
      adapter,
      conformance,
      paired,
      runtimeTask,
      codeOnlyTask,
      mutationBytes,
      classifierBytes,
      evaluatorImplementationBytes,
      evaluatorBundleBytes,
      adapterPackageBytes,
    ] = await Promise.all([
      loadJson(sensorFreezePath, M7SensorFreezeRecordV1Schema),
      loadJson(mutationRegistrationPath, M7HiddenMutationRegistrationV1Schema),
      loadJson(preflightPath, M7PatrolPreflightResultV1Schema),
      loadJson(mutantAdmissionPath, mutantAdmissionSchema),
      loadJson(adapterRevisionPath, ProjectAdapterRevisionV1Schema),
      loadJson(adapterConformancePath, AdapterConformanceReceiptV1Schema),
      loadJson(pairedTaskPath, pairedTaskSchema),
      loadJson(runtimeTaskPath, ExternalHiddenFixPublicTaskSpecV1Schema),
      loadJson(codeOnlyTaskPath, ExternalHiddenFixPublicTaskSpecV1Schema),
      readFile(mutationPath),
      readFile(publicClassifierPath),
      readFile(evaluatorImplementationPath),
      readFile(evaluatorBundlePath),
      collectFrozenAdapterPackageBytes(adapterPackageRoot),
    ]);
    assertExactM7HiddenMutationBytesV1(mutationBytes);
    const observationSchemaBytes = Buffer.concat([
      await readFile(
        resolve(adapterPackageRoot, "schemas/entity.patrol-agent.json"),
      ),
      Buffer.from([0]),
      await readFile(
        resolve(adapterPackageRoot, "schemas/state.patrol-motion.json"),
      ),
    ]);

    const freeze = sensor.value;
    const mutationRegistration = mutation.value;
    const mutantAdmission = admission.value;
    const adapterRevision = adapter.value;
    const conformanceReceipt = conformance.value;
    const preflightResult = preflight.value;
    if (
      rawDigest(adapterPackageBytes) !== freeze.sensor.adapterPackageSha256 ||
      rawDigest(observationSchemaBytes) !==
        freeze.sensor.observationSchemaSha256 ||
      rawDigest(classifierBytes) !==
        freeze.sensor.classifierImplementationSha256 ||
      rawDigest(conformance.bytes) !==
        freeze.sensor.pristineConformanceReceiptSha256 ||
      rawDigest(mutationBytes) !== mutationRegistration.mutationSha256 ||
      mutationBytes.byteLength !== mutationRegistration.mutationByteLength ||
      evaluatorImplementationBytes.byteLength === 0 ||
      evaluatorBundleBytes.byteLength === 0
    ) {
      throw new Error("M7 frozen sensor, mutation, or evaluator bytes changed");
    }
    if (
      mutationRegistration.sensorFreezeId !== freeze.sensorFreezeId ||
      preflightResult.sensorFreezeId !== freeze.sensorFreezeId ||
      preflightResult.mutationRegistrationId !==
        mutationRegistration.mutationRegistrationId ||
      mutantAdmission.sensorFreezeId !== freeze.sensorFreezeId ||
      mutantAdmission.mutationRegistrationId !==
        mutationRegistration.mutationRegistrationId ||
      mutantAdmission.adapterRevisionId !== adapterRevision.adapterRevisionId ||
      mutantAdmission.pristineAdapterSourceId !== adapterRevision.sourceId ||
      mutantAdmission.mutantBuild.sourceHash !==
        mutationRegistration.mutatedSelectedTreeSha256 ||
      mutantAdmission.mutantBuild.sourceId !==
        `source:${mutationRegistration.mutatedSelectedTreeSha256}` ||
      mutantAdmission.compatibilityReceipt.outcome !== "compatible" ||
      !mutantAdmission.compatibilityReceipt.cleanup.processTreeTerminated ||
      !mutantAdmission.compatibilityReceipt.cleanup.isolationGroupEmpty ||
      !mutantAdmission.compatibilityReceipt.cleanup.scopeRemoved ||
      mutantAdmission.compatibilityReceipt.cleanup.storageReconciled !== true ||
      !mutantAdmission.sandboxCleanup.processGroupTerminated ||
      mutantAdmission.sandboxCleanup.cgroupPopulated ||
      !mutantAdmission.sandboxCleanup.scopeRemoved ||
      mutantAdmission.sandboxCleanup.storageReconciled !== true ||
      mutantAdmission.compatibilityReceipt.lineage.build.sourceHash !==
        mutationRegistration.mutatedSelectedTreeSha256 ||
      mutantAdmission.genericClassifier.classifierId !==
        freeze.sensor.classifierId ||
      mutantAdmission.genericClassifier.implementationSha256 !==
        freeze.sensor.classifierImplementationSha256 ||
      adapterRevision.adapterRevisionId !== freeze.sensor.adapterRevisionId ||
      adapterRevision.sourceId !== freeze.pristineSubject.sourceId ||
      adapterRevision.conformanceReceiptId !== conformanceReceipt.receiptId ||
      conformanceReceipt.receiptId !==
        freeze.sensor.pristineConformanceReceiptId ||
      conformanceReceipt.outcome !== "conformed" ||
      preflightResult.outcome !== "passed" ||
      preflightResult.summary.pristineExpectedMotionObserved !== 9 ||
      preflightResult.summary.mutantPublicExpectedMotionObserved !== 0 ||
      preflightResult.summary.mutantHiddenExpectedMotionObserved !== 0 ||
      preflightResult.summary.mutantRegressionExpectedMotionObserved !== 3 ||
      Date.parse(freeze.frozenAt) >
        Date.parse(mutationRegistration.registeredAt) ||
      Date.parse(mutationRegistration.registeredAt) >
        Date.parse(preflightResult.completedAt) ||
      Date.parse(preflightResult.completedAt) >
        Date.parse(mutantAdmission.completedAt)
    ) {
      throw new Error("M7 pre-existing admission lineage is inconsistent");
    }
    const pairedTask = paired.value;
    for (const task of [runtimeTask.value, codeOnlyTask.value]) {
      if (
        task.subjectCommit !== freeze.pristineSubject.revision ||
        task.goal !== pairedTask.goal ||
        task.agentBudget.provider !== pairedTask.modelSelection.provider ||
        task.agentBudget.model !== pairedTask.modelSelection.model ||
        task.agentBudget.thinkingLevel !==
          pairedTask.modelSelection.thinkingLevel ||
        canonicalJson({
          schemaVersion: 1,
          attemptsMaximum: task.agentBudget.attemptsMaximum,
          userTurnsPerAttemptMaximum:
            task.agentBudget.userTurnsPerAttemptMaximum,
          toolCallsMaximum: task.agentBudget.toolCallsMaximum,
          wallTimeMsMaximum: task.agentBudget.wallTimeMsMaximum,
          taskSandboxNetworkMode: task.agentBudget.taskSandboxNetworkMode,
          taskCredentialMountCountMaximum:
            task.agentBudget.taskCredentialMountCountMaximum,
        }) !==
          canonicalJson(
            normalizeM7PairedAgentBudgetV1(pairedTask.agentBudget),
          ) ||
        task.publicExecutionClassifier.classifierId !==
          freeze.sensor.classifierId ||
        task.publicExecutionClassifier.implementationSha256 !==
          freeze.sensor.classifierImplementationSha256
      ) {
        throw new Error("M7 paired public task surfaces are not identical");
      }
    }
    if (runtimeTask.value.taskId === codeOnlyTask.value.taskId) {
      throw new Error("M7 paired arms require distinct task identities");
    }
    if (
      canonicalJson(runtimeTask.value.evaluatorBudget) !==
      canonicalJson(codeOnlyTask.value.evaluatorBudget)
    ) {
      throw new Error("M7 paired arms must share the exact evaluator budget");
    }
    const admittedGameTools = createM6AdmittedGameToolsV1({
      adapterRevision,
      hostAdmittedToolNames: PROJECT_ENVIRONMENT_GAME_TOOL_DEFINITIONS_V1.map(
        (tool) => tool.name,
      ),
    });

    return {
      publicRoot,
      hostOnlyRoot,
      campaignRoot,
      evidenceRoot,
      runtimePatchRoot,
      codeOnlyPatchRoot,
      evaluatorTemporaryRoot,
      pristineProjectRoot,
      mutantProjectRoot,
      adapterPackageRoot,
      adapterRevisionPath,
      adapterConformancePath,
      sensorFreezePath,
      mutationRegistrationPath,
      mutationPath,
      preflightPath,
      mutantAdmissionPath,
      evaluatorImplementationPath,
      evaluatorBundlePath,
      publicClassifierPath,
      pairedTaskPath,
      runtimeTaskPath,
      codeOnlyTaskPath,
      hostConfigPath,
      assignmentRoot,
      runtimeAgentResourceRoot,
      codeOnlyAgentResourceRoot,
      hostModelAgentDir,
      sensorFreeze: freeze,
      mutationRegistration,
      preflight: preflightResult,
      mutantAdmission,
      adapterRevision,
      pairedTask,
      hostConfig,
      runtimeTask: runtimeTask.value,
      codeOnlyTask: codeOnlyTask.value,
      publicTaskSpecSha256: rawDigest(paired.bytes),
      runtimeTaskSpecSha256: rawDigest(runtimeTask.bytes),
      codeOnlyTaskSpecSha256: rawDigest(codeOnlyTask.bytes),
      adapterRevisionFileSha256: rawDigest(adapter.bytes),
      admittedGameToolsSha256: jsonDigest(admittedGameTools),
      evaluatorImplementationSha256: rawDigest(evaluatorImplementationBytes),
      evaluatorBundleSha256: rawDigest(evaluatorBundleBytes),
      mutatedBuildSourceIdentitySha256: deriveM7BuildSourceIdentitySha256V1({
        sourceId: mutantAdmission.mutantBuild.sourceId,
        sourceHash: mutantAdmission.mutantBuild.sourceHash,
      }),
      hostModelRuntimeConfigSha256: jsonDigest({
        schemaVersion: 1,
        runtime: "pi-sdk-host-model-runtime",
        provider: pairedTask.modelSelection.provider,
        model: pairedTask.modelSelection.model,
        thinkingLevel: pairedTask.modelSelection.thinkingLevel,
        agentDirIdentity: await (async () => {
          const metadata = await lstat(hostModelAgentDir);
          return {
            device: metadata.dev,
            inode: metadata.ino,
            uid: metadata.uid,
            mode: metadata.mode & 0o7777,
          };
        })(),
      }),
    };
  };

const createM7LocalGateArmPort = (input: {
  readonly campaignStore: M7RuntimeUseCampaignStoreV1;
  readonly protocol: M7PairedAgentProtocolV1;
  readonly agentPort: M7PairedAgentPortV1;
  readonly now: () => string;
}): M7RuntimeUsePairedArmResultPortV1 => {
  const requestFor = (arm: M7PairedAgentArmV1) =>
    arm === "runtime_enabled"
      ? input.protocol.runtimeRequest
      : input.protocol.codeOnlyRequest;

  const createAdmission = (
    arm: M7PairedAgentArmV1,
    startedAt: string,
  ): M7LocalArmAdmissionV1 => {
    const request = requestFor(arm);
    const binding = request.attemptBinding;
    return Object.freeze({
      schemaVersion: 1 as const,
      arm,
      claim: Object.freeze({
        campaignId: binding.campaignId,
        arm,
        binding: Object.freeze({
          publicTaskSpecSha256: binding.pairedTaskSpecSha256,
          provider: binding.provider,
          model: binding.model,
          thinkingLevel: binding.thinkingLevel,
          agentBudgetSha256: binding.agentBudgetSha256,
          workspaceBaselineSelectedTreeSha256:
            binding.baselineSelectedTreeSha256,
          codingToolSetSha256: binding.codingToolSetSha256,
          sandboxPolicySha256: binding.sandboxProfileSha256,
        }),
        taskId: binding.isolation.taskId,
        sessionIdentitySha256: binding.isolation.sessionInstanceSha256,
        workspaceIdentitySha256: binding.isolation.workspaceInstanceSha256,
        cacheIdentitySha256: binding.isolation.cacheInstanceSha256,
        startedAt,
      }),
      pairedAttemptBindingContentSha256: binding.bindingContentSha256,
    });
  };
  // Parse both immutable admission surfaces before campaign registration, but
  // do not claim either arm's start time until the Gate actually releases it.
  for (const arm of ["runtime_enabled", "code_only"] as const) {
    M7LocalArmAdmissionV1Schema.parse(
      createAdmission(arm, "1970-01-01T00:00:00.000Z"),
    );
  }
  const deliveredAdmissions = new Map<
    M7PairedAgentArmV1,
    M7LocalArmAdmissionV1
  >();
  const attempts = new Set<M7PairedAgentArmV1>();
  let runtimeAttemptCleanupProven = false;

  return Object.freeze({
    getArmAdmission: async (arm: M7PairedAgentArmV1) => {
      if (deliveredAdmissions.has(arm)) {
        throw new Error(`M7 ${arm} admission may be read only once`);
      }
      if (arm === "code_only" && !runtimeAttemptCleanupProven) {
        throw new Error(
          "M7 code-only admission requires the completed runtime cleanup barrier",
        );
      }
      const admission = M7LocalArmAdmissionV1Schema.parse(
        createAdmission(arm, input.now()),
      );
      deliveredAdmissions.set(arm, admission);
      return admission;
    },
    runArmOnce: async (request: {
      readonly schemaVersion: 1;
      readonly campaignId: string;
      readonly arm: M7PairedAgentArmV1;
      readonly campaignClaimContentSha256: Sha256DigestV1;
      readonly pairedAttemptBindingContentSha256: Sha256DigestV1;
    }) => {
      if (attempts.has(request.arm)) {
        throw new Error(`M7 ${request.arm} Agent attempt may run only once`);
      }
      const admission = deliveredAdmissions.get(request.arm);
      const armRequest = requestFor(request.arm);
      if (
        admission === undefined ||
        request.campaignId !== armRequest.campaignId ||
        request.pairedAttemptBindingContentSha256 !==
          armRequest.attemptBinding.bindingContentSha256 ||
        request.pairedAttemptBindingContentSha256 !==
          admission.pairedAttemptBindingContentSha256
      ) {
        throw new Error("M7 Agent attempt crossed its preclaimed admission");
      }
      const claim = await input.campaignStore.readArmClaim(request.arm);
      if (
        claim.recordContentSha256 !== request.campaignClaimContentSha256 ||
        canonicalJson(admission.claim) !==
          canonicalJson({
            campaignId: claim.campaignId,
            arm: claim.arm,
            binding: claim.binding,
            taskId: claim.taskId,
            sessionIdentitySha256: claim.sessionIdentitySha256,
            workspaceIdentitySha256: claim.workspaceIdentitySha256,
            cacheIdentitySha256: claim.cacheIdentitySha256,
            startedAt: claim.startedAt,
          })
      ) {
        throw new Error("M7 Agent attempt did not follow its persisted claim");
      }
      attempts.add(request.arm);
      const attempt = await runM7PairedAgentArmOnceV1({
        request: armRequest,
        port: input.agentPort,
      });
      if (request.arm === "runtime_enabled") {
        runtimeAttemptCleanupProven =
          !attempt.cleanupInfrastructureFailure && attempt.cleanup.proven;
      }
      return attempt;
    },
  });
};

const prepareM7LiveInfrastructure = async (
  materials: M7VerifiedLiveMaterials,
): Promise<{
  readonly assignment: Awaited<
    ReturnType<typeof prepareExternalHiddenFixAssignmentV1>
  >;
  readonly prepared: M7PreparedPairedProjectEnvironmentInfrastructureV1;
}> => {
  const agentExposedRoots = [
    materials.publicRoot,
    materials.hostConfig.taskStorageRoot,
    materials.runtimeAgentResourceRoot,
    materials.codeOnlyAgentResourceRoot,
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
  const assignment = await prepareExternalHiddenFixAssignmentV1({
    pristineProjectRoot: materials.pristineProjectRoot,
    mutatedProjectRoot: materials.mutantProjectRoot,
    expectedSubjectCommit: materials.sensorFreeze.pristineSubject.revision,
    publicTaskSpecPath: materials.runtimeTaskPath,
    publicTaskSpecBytePolicy: {
      kind: "frozen-exact-v1",
      expectedSha256: materials.runtimeTaskSpecSha256,
    },
    adapterPackageRoot: materials.adapterPackageRoot,
    adapterRevisionPath: materials.adapterRevisionPath,
    adapterConformanceReceiptPath: materials.adapterConformancePath,
    mutationPath: materials.mutationPath,
    evaluatorImplementationPath: materials.evaluatorImplementationPath,
    evaluatorBundlePath: materials.evaluatorBundlePath,
    hostOnlyRoot: materials.hostOnlyRoot,
    agentExposedRoots,
    createdAt: new Date().toISOString(),
  });
  if (
    assignment.agentProjection.publicTask.sha256 !==
      materials.runtimeTaskSpecSha256 ||
    assignment.assignment.mutationSha256 !==
      materials.mutationRegistration.mutationSha256 ||
    assignment.assignment.evaluatorImplementationSha256 !==
      materials.evaluatorImplementationSha256 ||
    assignment.assignment.evaluatorBundleSha256 !==
      materials.evaluatorBundleSha256
  ) {
    throw new Error("M7 shared assignment crossed its frozen live materials");
  }
  const publicClassifier = await loadPublicExecutionClassifier({
    publicRoot: materials.publicRoot,
    implementationPath: materials.publicClassifierPath,
    publicTask: materials.runtimeTask,
  });
  const adapterFiles = await Promise.all(
    assignment.adapterPackage.files.map(async (file) => ({
      path: file.path,
      bytes: await readFile(resolve(materials.adapterPackageRoot, file.path)),
    })),
  );
  const runtimeTask = await prepareM6ProjectEnvironmentOneTurnTaskV1({
    assignment,
    adapterFiles,
    patchStore: runtimePatchStore,
    publicExecutionClassifier: publicClassifier,
    hostAdmittedGameToolNames: PROJECT_ENVIRONMENT_GAME_TOOL_DEFINITIONS_V1.map(
      (tool) => tool.name,
    ),
    hostConfigPath: materials.hostConfigPath,
    agentDir: materials.runtimeAgentResourceRoot,
  });
  const prepared = await prepareM7PairedInfrastructureFromM6RuntimeTaskV1({
    runtimeTask,
    codeOnlyPatchStore,
    sensorFreeze: materials.sensorFreeze,
    frozenClassifierModulePath: materials.publicClassifierPath,
    codeOnlyPublicTask: materials.codeOnlyTask,
    codeOnlyPublicTaskSpecSha256: materials.codeOnlyTaskSpecSha256,
    runtimeAgentResourceDirectory: materials.runtimeAgentResourceRoot,
    codeOnlyAgentResourceDirectory: materials.codeOnlyAgentResourceRoot,
    hostModelRuntimeConfigSha256: materials.hostModelRuntimeConfigSha256,
    hostConfigPath: materials.hostConfigPath,
  });
  const registration = prepared.registrationInputs;
  if (
    registration.baselineSelectedTreeSha256 !==
      materials.mutationRegistration.mutatedSelectedTreeSha256 ||
    registration.runtimeGameToolSetSha256 !==
      materials.admittedGameToolsSha256 ||
    registration.runtimeTaskId !== materials.runtimeTask.taskId ||
    registration.codeOnlyTaskId !== materials.codeOnlyTask.taskId ||
    registration.runtimeArmPublicTaskSpecSha256 !==
      materials.runtimeTaskSpecSha256 ||
    registration.codeOnlyArmPublicTaskSpecSha256 !==
      materials.codeOnlyTaskSpecSha256 ||
    registration.hostModelRuntimeConfigSha256 !==
      materials.hostModelRuntimeConfigSha256
  ) {
    await prepared.abortPreparation();
    throw new Error("M7 prepared arm infrastructure crossed preregistration");
  }
  return { assignment, prepared };
};

const createM7SensorBindingInput = (input: {
  readonly materials: M7VerifiedLiveMaterials;
  readonly prepared: M7PreparedPairedProjectEnvironmentInfrastructureV1;
  readonly boundAt: string;
}) => ({
  schemaVersion: 1 as const,
  authoritativeSensorFreezeId: input.materials.sensorFreeze.sensorFreezeId,
  authoritativeSensorFreezeRecordSha256:
    input.materials.sensorFreeze.recordSha256,
  subjectProjectSha256:
    input.materials.sensorFreeze.pristineSubject.subjectProjectSha256,
  pristineProjectRevision:
    input.materials.sensorFreeze.pristineSubject.revision,
  pristineSelectedTreeSha256:
    input.materials.sensorFreeze.pristineSubject.selectedTreeSha256,
  pristineAdapterRevisionSha256: input.materials.adapterRevisionFileSha256,
  adapterPackageSha256:
    input.materials.sensorFreeze.sensor.adapterPackageSha256,
  adapterObservationSchemaSha256:
    input.materials.sensorFreeze.sensor.observationSchemaSha256,
  publicPatrolClassifierSha256:
    input.materials.sensorFreeze.sensor.classifierImplementationSha256,
  pristineConformanceReceiptSha256:
    input.materials.sensorFreeze.sensor.pristineConformanceReceiptSha256,
  validatedGameToolSetSha256:
    input.prepared.registrationInputs.runtimeGameToolSetSha256,
  boundAt: input.boundAt,
});

const createM7MutationRegistrationInput = (input: {
  readonly materials: M7VerifiedLiveMaterials;
  readonly prepared: M7PreparedPairedProjectEnvironmentInfrastructureV1;
  readonly registeredAt: string;
}) => ({
  mutationSha256: input.materials.mutationRegistration.mutationSha256,
  mutatedBaselineSelectedTreeSha256:
    input.materials.mutationRegistration.mutatedSelectedTreeSha256,
  mutatedBuildSourceIdentitySha256:
    input.materials.mutatedBuildSourceIdentitySha256,
  adapterMutantCompatibilityReceiptSha256:
    input.prepared.registrationInputs.mutantCompatibilityReceiptSha256,
  publicTaskSpecSha256: input.materials.publicTaskSpecSha256,
  evaluatorImplementationSha256: input.materials.evaluatorImplementationSha256,
  evaluatorBundleSha256: input.materials.evaluatorBundleSha256,
  provider: input.materials.pairedTask.modelSelection.provider,
  model: input.materials.pairedTask.modelSelection.model,
  thinkingLevel: input.materials.pairedTask.modelSelection.thinkingLevel,
  agentBudgetSha256: jsonDigest(
    normalizeM7PairedAgentBudgetV1(input.materials.pairedTask.agentBudget),
  ),
  codingToolSetSha256: input.prepared.registrationInputs.codingToolSetSha256,
  sandboxPolicySha256: input.prepared.registrationInputs.sandboxPolicySha256,
  registeredAt: input.registeredAt,
});

const deriveM7ExpectedCampaign = (input: {
  readonly materials: M7VerifiedLiveMaterials;
  readonly prepared: M7PreparedPairedProjectEnvironmentInfrastructureV1;
  readonly timestamp: string;
}): {
  readonly sensorBinding: M7CampaignSensorBindingV1;
  readonly registration: M7MutationRegistrationV1;
} => {
  const sensorBinding = createM7CampaignSensorBindingV1(
    createM7SensorBindingInput({
      ...input,
      boundAt: input.timestamp,
    }),
  );
  return {
    sensorBinding,
    registration: createM7MutationRegistrationV1({
      sensorBinding,
      registration: createM7MutationRegistrationInput({
        ...input,
        registeredAt: input.timestamp,
      }),
    }),
  };
};

const openM7LiveStores = async (materials: M7VerifiedLiveMaterials) => {
  const agentExposedRoots = [
    materials.publicRoot,
    materials.hostConfig.taskStorageRoot,
    materials.runtimeAgentResourceRoot,
    materials.codeOnlyAgentResourceRoot,
  ];
  const [campaignStore, mutationStore, evidenceStore] = await Promise.all([
    openM7RuntimeUseCampaignStoreV1({
      root: materials.campaignRoot,
      exposedRoots: agentExposedRoots,
    }),
    M7RuntimeUseLocalMutationStoreV1.open({
      root: materials.hostOnlyRoot,
      exposedRoots: agentExposedRoots,
    }),
    M7RuntimeUseLocalEvidenceStoreV1.open({
      root: materials.evidenceRoot,
      exposedRoots: agentExposedRoots,
    }),
  ]);
  return { campaignStore, mutationStore, evidenceStore, agentExposedRoots };
};

const verifyM7PairedProtocolAdmission = (input: {
  readonly materials: M7VerifiedLiveMaterials;
  readonly prepared: M7PreparedPairedProjectEnvironmentInfrastructureV1;
  readonly expectedRegistration: M7MutationRegistrationV1;
  readonly protocol: M7PairedAgentProtocolV1;
}): void => {
  const { materials, prepared, protocol } = input;
  const registration = prepared.registrationInputs;
  const proof = protocol.surfaceEqualityProof;
  const runtimeBinding = protocol.runtimeRequest.attemptBinding;
  const codeOnlyBinding = protocol.codeOnlyRequest.attemptBinding;
  if (
    proof.campaignId !== input.expectedRegistration.campaignId ||
    proof.publicTaskSpecSha256 !== materials.publicTaskSpecSha256 ||
    proof.runtimeArmPublicTaskSpecSha256 !== materials.runtimeTaskSpecSha256 ||
    proof.codeOnlyArmPublicTaskSpecSha256 !==
      materials.codeOnlyTaskSpecSha256 ||
    proof.provider !== materials.pairedTask.modelSelection.provider ||
    proof.model !== materials.pairedTask.modelSelection.model ||
    proof.thinkingLevel !== materials.pairedTask.modelSelection.thinkingLevel ||
    proof.agentBudgetSha256 !== input.expectedRegistration.agentBudgetSha256 ||
    proof.promptSha256 !== jsonDigest(M7_NATURAL_USER_PROMPT_V1) ||
    proof.baselineSelectedTreeSha256 !==
      registration.baselineSelectedTreeSha256 ||
    proof.codingToolSetSha256 !== registration.codingToolSetSha256 ||
    proof.sandboxProfileSha256 !== registration.sandboxPolicySha256 ||
    proof.runtimeGameToolSetSha256 !== registration.runtimeGameToolSetSha256 ||
    proof.runtimeResourceAppendixSha256 !==
      registration.runtimeResourceAppendixSha256 ||
    proof.hostModelRuntimeConfigSha256 !==
      registration.hostModelRuntimeConfigSha256 ||
    runtimeBinding.publicTaskSpecSha256 !== materials.runtimeTaskSpecSha256 ||
    codeOnlyBinding.publicTaskSpecSha256 !== materials.codeOnlyTaskSpecSha256 ||
    runtimeBinding.pairedTaskSpecSha256 !== materials.publicTaskSpecSha256 ||
    codeOnlyBinding.pairedTaskSpecSha256 !== materials.publicTaskSpecSha256 ||
    runtimeBinding.isolation.taskId !== registration.runtimeTaskId ||
    codeOnlyBinding.isolation.taskId !== registration.codeOnlyTaskId ||
    canonicalJson(runtimeBinding.isolation) !==
      canonicalJson(registration.runtimeIsolation) ||
    canonicalJson(codeOnlyBinding.isolation) !==
      canonicalJson(registration.codeOnlyIsolation) ||
    runtimeBinding.runtimeSurface === null ||
    runtimeBinding.runtimeSurface.sensorFreezeRecordSha256 !==
      materials.sensorFreeze.recordSha256 ||
    runtimeBinding.runtimeSurface.admittedGameToolSetSha256 !==
      registration.runtimeGameToolSetSha256 ||
    codeOnlyBinding.runtimeSurface !== null ||
    protocol.codeOnlyRequest.runtimeAccess !== null ||
    protocol.codeOnlyRequest.gameTools.length !== 0
  ) {
    throw new Error(
      "M7 paired protocol admission crossed the frozen campaign or treatment surfaces",
    );
  }
};

const preregisterM7Campaign = async (input: {
  readonly materials: M7VerifiedLiveMaterials;
  readonly assignment: Awaited<
    ReturnType<typeof prepareExternalHiddenFixAssignmentV1>
  >;
  readonly prepared: M7PreparedPairedProjectEnvironmentInfrastructureV1;
  readonly expected: {
    readonly sensorBinding: M7CampaignSensorBindingV1;
    readonly registration: M7MutationRegistrationV1;
  };
  readonly campaignStore: M7RuntimeUseCampaignStoreV1;
  readonly mutationStore: M7RuntimeUseLocalMutationStoreV1;
  readonly evidenceStore: M7RuntimeUseLocalEvidenceStoreV1;
  readonly agentExposedRoots: readonly string[];
}) => {
  const { materials, prepared } = input;
  const now = input.expected.registration.registeredAt;
  const sensorBinding = await input.campaignStore.bindCampaignSensorOnce({
    ...createM7SensorBindingInput({ materials, prepared, boundAt: now }),
  });
  const registration = await input.campaignStore.registerMutationOnce({
    ...createM7MutationRegistrationInput({
      materials,
      prepared,
      registeredAt: now,
    }),
  });
  if (
    canonicalJson(sensorBinding) !==
      canonicalJson(input.expected.sensorBinding) ||
    canonicalJson(registration) !==
      canonicalJson(input.expected.registration) ||
    registration.campaignSensorBindingId !==
      sensorBinding.campaignSensorBindingId ||
    registration.runtimeGameToolSetSha256 !==
      prepared.registrationInputs.runtimeGameToolSetSha256
  ) {
    throw new Error("M7 campaign registration crossed prepared surfaces");
  }
  const preflight = await input.campaignStore.putPreflightOnce({
    pristinePassCount:
      materials.preflight.summary.pristineExpectedMotionObserved,
    mutantPublicAndHiddenPassCount:
      materials.preflight.summary.mutantPublicExpectedMotionObserved +
      materials.preflight.summary.mutantHiddenExpectedMotionObserved,
    mutantRegressionPassCount:
      materials.preflight.summary.mutantRegressionExpectedMotionObserved,
    genericClassifierMutantWitnessObserved:
      materials.mutantAdmission.genericClassifier.mutantFallWitnessObserved,
    pristineAdapterConformancePassed: true,
    mutantBuildCompatibilityPassed: true,
    cleanupProven: true,
    infrastructureFailureCode: null,
    completedAt: now,
  });
  if (preflight.outcome !== "passed") {
    throw new Error("M7 campaign preflight did not pass admission");
  }
  await input.mutationStore.registerOnce({
    registration,
    baselineRoot: input.assignment.protectedBaselineRoot,
    evaluatorImplementationPath: materials.evaluatorImplementationPath,
    evaluatorBundlePath: materials.evaluatorBundlePath,
    registeredAt: now,
  });
  return {
    campaignStore: input.campaignStore,
    mutationStore: input.mutationStore,
    evidenceStore: input.evidenceStore,
    registration,
    agentExposedRoots: input.agentExposedRoots,
  };
};

describe("M7 moddable-platformer runtime-use ablation local Gate", () => {
  it(
    "runs the preregistered runtime-enabled and code-only arms exactly once",
    { timeout: 5_400_000 },
    async () => {
      const liveMode = z
        .enum(["pre-agent-dry-run", "r2-live"])
        .parse(process.env.CHRONORIFT_M7_LIVE_MODE);
      const materials = await verifyPreexistingM7LiveMaterials();
      expect(materials.mutantAdmission.providerUsed).toBe(false);
      const godotToolchain = materials.hostConfig.godotToolchains[0];
      if (godotToolchain === undefined) {
        throw new Error("M7 host config omitted its exact Godot toolchain");
      }

      let prepared:
        M7PreparedPairedProjectEnvironmentInfrastructureV1 | undefined;
      let bound: M7BoundPairedProjectEnvironmentV1 | undefined;
      const cleanupPrepared = async (): Promise<void> => {
        if (bound !== undefined) {
          await bound.cleanupRemainingAfterGateFailure();
        } else if (prepared !== undefined) {
          await prepared.abortPreparation();
        }
      };

      try {
        const infrastructure = await prepareM7LiveInfrastructure(materials);
        prepared = infrastructure.prepared;
        const expected = deriveM7ExpectedCampaign({
          materials,
          prepared,
          timestamp: new Date().toISOString(),
        });
        bound = prepared.bindCampaignOnce({
          campaignId: expected.registration.campaignId,
          publicTaskSpecSha256: materials.publicTaskSpecSha256,
          sensorFreezeRecordSha256: materials.sensorFreeze.recordSha256,
        });
        const protocol = createM7PairedAgentProtocolV1(bound.pairedInput);
        verifyM7PairedProtocolAdmission({
          materials,
          prepared,
          expectedRegistration: expected.registration,
          protocol,
        });

        const stores = await openM7LiveStores(materials);
        const agentPort = await prepareM7ProjectEnvironmentPairedAgentPortV1({
          runtimeArm: bound.runtimeArm,
          codeOnlyArm: bound.codeOnlyArm,
        });
        // Construction eagerly parses both arm admissions. It does not start a
        // Pi Session; the Gate exposes each cached admission only at its fixed
        // runtime -> cleanup -> code-only boundary.
        const armPort = createM7LocalGateArmPort({
          campaignStore: stores.campaignStore,
          protocol,
          agentPort,
          now: () => new Date().toISOString(),
        });
        const campaign = await preregisterM7Campaign({
          materials,
          assignment: infrastructure.assignment,
          prepared,
          expected,
          ...stores,
        });
        if (
          campaign.registration.campaignId !== expected.registration.campaignId
        ) {
          throw new Error(
            "M7 persisted campaign identity changed before Agent start",
          );
        }

        if (liveMode === "pre-agent-dry-run") {
          const sandboxDryRun =
            await bound.runPreAgentSandboxDryRunAndCleanup(agentPort);
          process.stdout.write(
            `${canonicalJson(
              JsonValueSchema.parse({
                schemaVersion: 1,
                receiptKind: "m7-pre-agent-dry-run",
                outcome: "passed",
                campaignId: campaign.registration.campaignId,
                campaignPreregisteredInDisposableRoot: true,
                pairedProtocolAdmissionValidated: true,
                armAdmissionsParsed: ["runtime_enabled", "code_only"],
                codingSandboxSentinelsPassed: true,
                formalGateInvoked: false,
                agentLaunchCount: 0,
                providerUsed: false,
                sandboxDryRun,
              }),
            )}\n`,
          );
          return;
        }

        const terminal = M7CampaignTerminalRecordV1Schema.parse(
          await runM7RuntimeUseLocalCampaignGateV1({
            campaignId: campaign.registration.campaignId,
            campaignStore: campaign.campaignStore,
            mutationStore: campaign.mutationStore,
            evidenceStore: campaign.evidenceStore,
            patchStoreRoots: {
              runtime_enabled: materials.runtimePatchRoot,
              code_only: materials.codeOnlyPatchRoot,
            },
            armPort,
            evaluator: {
              bwrapPath: materials.hostConfig.bwrapPath,
              nodePath: materials.hostConfig.nodePath,
              temporaryRoot: materials.evaluatorTemporaryRoot,
              runtimeMounts: [
                {
                  source: godotToolchain.executablePath,
                  target: "/runtime/assets/godot",
                },
              ],
              gitBinary: "/usr/bin/git",
              timeoutMs:
                materials.runtimeTask.evaluatorBudget.wallTimeMsPerRunMaximum,
            },
            agentExposedRoots: campaign.agentExposedRoots,
          }),
        );
        if (terminal.campaignId !== campaign.registration.campaignId) {
          throw new Error("M7 terminal crossed its registered campaign");
        }
        await cleanupPrepared();
        process.stdout.write(`${canonicalJson(terminal)}\n`);
      } catch (error) {
        try {
          await cleanupPrepared();
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            "M7 live failed and residual prepared-arm cleanup also failed",
          );
        }
        throw error;
      }
    },
  );
});
