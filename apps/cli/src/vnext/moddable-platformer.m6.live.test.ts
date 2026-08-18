import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { PROJECT_ENVIRONMENT_GAME_TOOL_DEFINITIONS_V1 } from "@chronorift/agent-protocol";
import { JsonValueSchema } from "@chronorift/domain";
import { canonicalJson } from "@chronorift/json-artifacts";
import { describe, expect, it } from "vitest";

import {
  prepareExternalHiddenFixAssignmentV1,
  type ExternalHiddenFixPublicTaskSpecV1,
} from "./external-hidden-fix-assignment.js";
import {
  LocalExternalHiddenFixPatchStoreV1,
  type ExternalHiddenFixEvaluatorRuntimeMountV1,
} from "./external-hidden-fix-evaluator.js";
import { openExternalHiddenFixAssignmentStoreV1 } from "./external-hidden-fix.js";
import { runM6ExternalHiddenFixLocalGateV1 } from "./m6-external-hidden-fix-local-gate.js";
import {
  prepareM6ProjectEnvironmentOneTurnTaskV1,
  type M6PublicExecutionClassifierV1,
} from "./m6-project-environment-one-turn.js";
import { readProjectEnvironmentHostConfigV1 } from "./project-environment-host-config.js";

const MODDABLE_PLATFORMER_COMMIT = "3e793f53598a131c53fb82555191cc14b8db07ff";

const requiredEnvironment = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`M6 live infrastructure requires ${name}`);
  }
  return value;
};

const canonicalDirectory = async (name: string): Promise<string> => {
  const path = resolve(requiredEnvironment(name));
  const [canonical, metadata] = await Promise.all([
    realpath(path),
    lstat(path),
  ]);
  if (
    canonical !== path ||
    !metadata.isDirectory() ||
    metadata.isSymbolicLink()
  ) {
    throw new Error(`${name} must be a canonical real directory`);
  }
  return canonical;
};

const canonicalFile = async (name: string): Promise<string> => {
  const path = resolve(requiredEnvironment(name));
  const [canonical, metadata] = await Promise.all([
    realpath(path),
    lstat(path),
  ]);
  if (canonical !== path || !metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${name} must be a canonical real file`);
  }
  return canonical;
};

const pathWithinOrEqual = (parent: string, candidate: string): boolean => {
  const difference = relative(parent, candidate);
  return (
    difference === "" ||
    (!difference.startsWith(`..${sep}`) &&
      difference !== ".." &&
      !isAbsolute(difference))
  );
};

const digest = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

const loadPublicClassifier = async (input: {
  readonly publicRoot: string;
  readonly implementationPath: string;
  readonly publicTask: ExternalHiddenFixPublicTaskSpecV1;
}): Promise<M6PublicExecutionClassifierV1> => {
  if (!pathWithinOrEqual(input.publicRoot, input.implementationPath)) {
    throw new Error(
      "M6 public classifier implementation must be inside the Agent-visible public root",
    );
  }
  const bytes = await readFile(input.implementationPath);
  if (
    digest(bytes) !==
    input.publicTask.publicExecutionClassifier.implementationSha256
  ) {
    throw new Error(
      "M6 public classifier bytes do not match the frozen public task",
    );
  }
  const moduleUrl = `${pathToFileURL(input.implementationPath).href}?sha256=${digest(bytes)}`;
  const loaded: unknown = await import(moduleUrl);
  const classify =
    typeof loaded === "object" &&
    loaded !== null &&
    "classifyM6PublicExecutionV1" in loaded
      ? loaded.classifyM6PublicExecutionV1
      : undefined;
  if (typeof classify !== "function") {
    throw new Error(
      "M6 public classifier module must export classifyM6PublicExecutionV1(input)",
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
        throw new Error("M6 public classifier returned an invalid result");
      }
      return Object.freeze({
        publicSymptomObserved: output.publicSymptomObserved,
        observation: JsonValueSchema.parse(output.observation),
      });
    },
  });
};

describe("M6 moddable-platformer hidden-fix local Gate", () => {
  it(
    "runs one Agent attempt and retains the 3x3 fresh-copy acceptance result",
    { timeout: 1_800_000 },
    async () => {
      const hostConfigPath = await canonicalFile(
        "CHRONORIFT_TEST_M6_HOST_CONFIG",
      );
      const hostConfig =
        await readProjectEnvironmentHostConfigV1(hostConfigPath);
      const publicRoot = await canonicalDirectory(
        "CHRONORIFT_TEST_M6_PUBLIC_ROOT",
      );
      const hostOnlyRoot = await canonicalDirectory(
        "CHRONORIFT_TEST_M6_HOST_ONLY_ROOT",
      );
      const patchRoot = await canonicalDirectory(
        "CHRONORIFT_TEST_M6_PATCH_ROOT",
      );
      const evaluatorTemporaryRoot = await canonicalDirectory(
        "CHRONORIFT_TEST_M6_EVALUATOR_TEMP_ROOT",
      );
      const publicTaskSpecPath = await canonicalFile(
        "CHRONORIFT_TEST_M6_PUBLIC_TASK_SPEC",
      );
      const publicClassifierPath = await canonicalFile(
        "CHRONORIFT_TEST_M6_PUBLIC_CLASSIFIER",
      );
      const adapterPackageRoot = await canonicalDirectory(
        "CHRONORIFT_TEST_M6_ADAPTER_PACKAGE",
      );
      const agentExposedRoots = [publicRoot, hostConfig.taskStorageRoot];

      const assignment = await prepareExternalHiddenFixAssignmentV1({
        pristineProjectRoot: await canonicalDirectory(
          "CHRONORIFT_TEST_M6_PRISTINE_PROJECT",
        ),
        mutatedProjectRoot: await canonicalDirectory(
          "CHRONORIFT_TEST_M6_MUTATED_PROJECT",
        ),
        expectedSubjectCommit: MODDABLE_PLATFORMER_COMMIT,
        publicTaskSpecPath,
        adapterPackageRoot,
        adapterRevisionPath: await canonicalFile(
          "CHRONORIFT_TEST_M6_ADAPTER_REVISION",
        ),
        adapterConformanceReceiptPath: await canonicalFile(
          "CHRONORIFT_TEST_M6_ADAPTER_CONFORMANCE",
        ),
        mutationPath: await canonicalFile("CHRONORIFT_TEST_M6_MUTATION"),
        evaluatorImplementationPath: await canonicalFile(
          "CHRONORIFT_TEST_M6_EVALUATOR_IMPLEMENTATION",
        ),
        evaluatorBundlePath: await canonicalFile(
          "CHRONORIFT_TEST_M6_EVALUATOR_BUNDLE",
        ),
        hostOnlyRoot,
        agentExposedRoots,
        createdAt: new Date().toISOString(),
      });
      const publicClassifier = await loadPublicClassifier({
        publicRoot,
        implementationPath: publicClassifierPath,
        publicTask: assignment.agentProjection.publicTask.spec,
      });
      const adapterFiles = await Promise.all(
        assignment.adapterPackage.files.map(async (file) => ({
          path: file.path,
          bytes: await readFile(resolve(adapterPackageRoot, file.path)),
        })),
      );
      const patchStore = await LocalExternalHiddenFixPatchStoreV1.open({
        root: patchRoot,
        exposedRoots: agentExposedRoots,
      });
      const task = await prepareM6ProjectEnvironmentOneTurnTaskV1({
        assignment,
        adapterFiles,
        patchStore,
        publicExecutionClassifier: publicClassifier,
        hostAdmittedGameToolNames:
          PROJECT_ENVIRONMENT_GAME_TOOL_DEFINITIONS_V1.map((tool) => tool.name),
        hostConfigPath,
      });
      const store = await openExternalHiddenFixAssignmentStoreV1({
        root: hostOnlyRoot,
        exposedRoots: agentExposedRoots,
      });
      const godotToolchain = hostConfig.godotToolchains[0];
      if (godotToolchain === undefined) {
        throw new Error("M6 host config omitted its exact Godot toolchain");
      }
      const runtimeMounts: readonly ExternalHiddenFixEvaluatorRuntimeMountV1[] =
        [
          {
            source: godotToolchain.executablePath,
            target: "/runtime/assets/godot",
          },
        ];
      const terminal = await runM6ExternalHiddenFixLocalGateV1({
        task,
        store,
        patchStore,
        evaluator: {
          bwrapPath: hostConfig.bwrapPath,
          nodePath: hostConfig.nodePath,
          temporaryRoot: evaluatorTemporaryRoot,
          runtimeMounts,
          gitBinary: "/usr/bin/git",
          timeoutMs:
            assignment.agentProjection.publicTask.spec.evaluatorBudget
              .wallTimeMsPerRunMaximum,
        },
      });

      process.stdout.write(`${canonicalJson(terminal)}\n`);
      expect(terminal.outcome).toBe("accepted");
    },
  );
});
