import { createHash } from "node:crypto";

import {
  ProjectAdapterRevisionV1Schema,
  ProjectToolchainReceiptIdSchema,
  Sha256DigestV1Schema,
  VNextBuildV1Schema,
  asBuildId,
  asSha256DigestV1,
  asSourceId,
  type ProjectAdapterRevisionV1,
  type ProjectToolchainReceiptId,
  type Sha256DigestV1,
  type TaskId,
  type VNextBuildV1,
  type WorkspaceId,
} from "@chronorift/domain";
import { contentHash } from "@chronorift/json-artifacts";
import { z } from "zod";

import { collectCandidateGodotSourceV1 } from "./candidate-godot-build.js";
import { selectedTreeSha256 } from "./selected-tree.js";

const opaqueIdentity = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:+-]*$/u)
  .refine((value) => !value.includes(".."));

export const M6ExactBuildRuntimeIdentityV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    managedRuntimeId: opaqueIdentity,
    engineVersion: z.string().min(1).max(128),
    runtimeArtifactDigest: Sha256DigestV1Schema,
    overlayDigest: Sha256DigestV1Schema,
  })
  .strict();
export type M6ExactBuildRuntimeIdentityV1 = z.infer<
  typeof M6ExactBuildRuntimeIdentityV1Schema
>;

export interface PreparedM6ExactGodotBuildV1 {
  readonly build: VNextBuildV1;
  readonly configuredMainScene: string;
  readonly projectHash: Sha256DigestV1;
  readonly adapterRevision: ProjectAdapterRevisionV1;
  readonly toolchainReceiptId: ProjectToolchainReceiptId;
  readonly toolchainArtifactDigest: Sha256DigestV1;
  readonly runtimeIdentity: M6ExactBuildRuntimeIdentityV1;
  readonly policyProfileDigest: Sha256DigestV1;
  readonly fileCount: number;
  readonly byteLength: number;
}

const configuredMainScene = (
  projectBytes: Uint8Array,
  entries: readonly {
    readonly relativePath: string;
    readonly content: Uint8Array;
  }[],
): string => {
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(projectBytes);
  } catch (error) {
    throw new TypeError("M6 project.godot is not valid UTF-8", {
      cause: error,
    });
  }
  if (
    /^\s*ChronoRiftLifecycle\s*=/mu.test(source) ||
    /^\s*ChronoRiftSemantic\s*=/mu.test(source) ||
    /^\s*ChronoRiftProjectEnvironment\s*=/mu.test(source)
  ) {
    throw new TypeError(
      "M6 project.godot collides with a reserved ChronoRift autoload",
    );
  }
  const matches = [
    ...source.matchAll(
      /^\s*run\/main_scene\s*=\s*"((?:res|uid):\/\/[^"\r\n]+)"\s*$/gmu,
    ),
  ];
  const scene = matches[0]?.[1];
  if (matches.length !== 1 || scene === undefined || scene.length > 2_048) {
    throw new TypeError(
      "M6 project.godot must configure exactly one bounded res:// or uid:// main scene",
    );
  }
  const selectedPaths = new Set(entries.map((entry) => entry.relativePath));
  if (scene.startsWith("uid://")) {
    if (!/^uid:\/\/[a-z0-9]{1,128}$/u.test(scene)) {
      throw new TypeError("M6 configured main-scene UID is invalid");
    }
    const uidMatches: string[] = [];
    for (const entry of entries) {
      if (!entry.relativePath.endsWith(".tscn")) continue;
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(entry.content);
      } catch (error) {
        throw new TypeError(
          `M6 selected scene ${entry.relativePath} is not valid UTF-8`,
          { cause: error },
        );
      }
      const firstLineEnd = text.search(/[\r\n]/u);
      const header = firstLineEnd < 0 ? text : text.slice(0, firstLineEnd);
      const declaredUid =
        header.startsWith("[gd_scene ") && header.endsWith("]")
          ? /(?:^|\s)uid="(uid:\/\/[a-z0-9]{1,128})"(?:\s|\]$)/u.exec(
              header,
            )?.[1]
          : undefined;
      if (declaredUid === scene) uidMatches.push(entry.relativePath);
    }
    if (uidMatches.length !== 1) {
      throw new TypeError(
        uidMatches.length === 0
          ? "M6 configured main-scene UID is missing from selected .tscn entries"
          : "M6 configured main-scene UID is ambiguous in selected .tscn entries",
      );
    }
    return `res://${uidMatches[0]}`;
  }
  const relativeScene = scene.slice("res://".length);
  if (
    relativeScene.length === 0 ||
    (!relativeScene.endsWith(".tscn") && !relativeScene.endsWith(".scn")) ||
    !selectedPaths.has(relativeScene)
  ) {
    throw new TypeError(
      "M6 configured main scene must be an exact file in the selected source tree",
    );
  }
  return scene;
};

/**
 * Freezes one exact M6 assignment-baseline or candidate Build. The
 * ProjectAdapterRevision remains provenance from the pristine source on which
 * it was authored; the Build source identity is always the selected bytes in
 * the supplied task workspace.
 */
export async function prepareM6ExactGodotBuildV1(input: {
  readonly taskId: TaskId;
  readonly workspaceId: WorkspaceId;
  readonly workspaceDirectory: string;
  readonly baselineSourceHash: Sha256DigestV1 | string;
  readonly adapterRevision: unknown;
  readonly toolchainReceiptId: ProjectToolchainReceiptId | string;
  readonly toolchainArtifactDigest: Sha256DigestV1 | string;
  readonly runtimeIdentity: unknown;
  readonly policyProfileDigest: Sha256DigestV1 | string;
  readonly now: string;
}): Promise<PreparedM6ExactGodotBuildV1> {
  const adapterRevision = ProjectAdapterRevisionV1Schema.parse(
    input.adapterRevision,
  );
  const toolchainReceiptId = ProjectToolchainReceiptIdSchema.parse(
    input.toolchainReceiptId,
  );
  const toolchainArtifactDigest = Sha256DigestV1Schema.parse(
    input.toolchainArtifactDigest,
  );
  const runtimeIdentity = M6ExactBuildRuntimeIdentityV1Schema.parse(
    input.runtimeIdentity,
  );
  const policyProfileDigest = Sha256DigestV1Schema.parse(
    input.policyProfileDigest,
  );
  const baselineSourceHash = Sha256DigestV1Schema.parse(
    input.baselineSourceHash,
  );
  const entries = await collectCandidateGodotSourceV1(
    input.workspaceDirectory,
    "project-environment",
    "tracked-tool-scripts-v1",
  );
  const project = entries.find(
    (entry) => entry.relativePath === "project.godot",
  );
  if (project === undefined) {
    throw new TypeError("M6 Godot source is missing project.godot");
  }
  const mainScene = configuredMainScene(project.content, entries);
  const sourceHash = selectedTreeSha256(entries);
  const sourceId = asSourceId(`source:${sourceHash}`);
  const workspaceDiffHash = asSha256DigestV1(
    contentHash({
      schemaVersion: 1,
      baselineSourceHash,
      candidateSourceHash: sourceHash,
    }),
  );
  const buildConfigurationHash = asSha256DigestV1(
    contentHash({
      schemaVersion: 1,
      profile: "m6-external-hidden-fix-v1",
      gdscriptPolicy: "tracked-tool-scripts-v1",
      configuredMainScene: mainScene,
      adapter: {
        schemaVersion: 1,
        adapterRevisionId: adapterRevision.adapterRevisionId,
        pristineSourceId: adapterRevision.sourceId,
        packageDigest: adapterRevision.packageDigest,
        manifestDigest: adapterRevision.manifestDigest,
        implementationDigest: adapterRevision.implementationDigest,
        payloadSchemaDigest: adapterRevision.payloadSchemaDigest,
        sdkDigest: adapterRevision.sdkDigest,
        bridgeDigest: adapterRevision.bridgeDigest,
        conformanceReceiptId: adapterRevision.conformanceReceiptId,
      },
      toolchain: {
        schemaVersion: 1,
        toolchainReceiptId,
        artifactDigest: toolchainArtifactDigest,
      },
      runtimeIdentity,
      policyProfileDigest,
    }),
  );
  const projectHash = asSha256DigestV1(
    createHash("sha256")
      .update("chronorift-m6-exact-godot-build-v1\0")
      .update(sourceHash)
      .update("\0")
      .update(buildConfigurationHash)
      .digest("hex"),
  );
  const build = VNextBuildV1Schema.parse({
    schemaVersion: 1,
    taskId: input.taskId,
    workspaceId: input.workspaceId,
    sourceId,
    buildId: asBuildId(
      `build:${contentHash({
        schemaVersion: 1,
        sourceHash,
        projectHash,
        buildConfigurationHash,
        outputHash: projectHash,
      })}`,
    ),
    sourceHash,
    workspaceDiffHash,
    buildConfigurationHash,
    outputHash: projectHash,
    createdAt: input.now,
  });
  return Object.freeze({
    build,
    configuredMainScene: mainScene,
    projectHash,
    adapterRevision,
    toolchainReceiptId,
    toolchainArtifactDigest,
    runtimeIdentity,
    policyProfileDigest,
    fileCount: entries.length,
    byteLength: entries.reduce(
      (total, entry) => total + entry.content.byteLength,
      0,
    ),
  });
}
