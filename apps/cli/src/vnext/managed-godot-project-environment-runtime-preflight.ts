import { createHash } from "node:crypto";

import { asSha256DigestV1, type Sha256DigestV1 } from "@chronorift/domain";
import {
  DEFAULT_PROJECT_ENVIRONMENT_SIDECAR_TARGETS_V1,
  PROJECT_ADAPTER_SDK_FILES_V1,
  PROJECT_ENVIRONMENT_BRIDGE_FILES_V1,
  createProjectEnvironmentRuntimeSidecarSource,
  createProjectEnvironmentVanillaSmokeSidecarSource,
} from "@chronorift/godot-adapter";

import {
  createManagedGodotProjectEnvironmentRuntimeV1,
  type ManagedGodotProjectEnvironmentRuntimeBindingV1,
  type ManagedGodotProjectEnvironmentRuntimeCapabilityV1,
} from "./managed-godot-project-environment-runtime.js";
import type { SrtGodotToolchainReceipt } from "./srt-runtime-config.js";

const roleDigest = (
  files: readonly {
    readonly relativePath: string;
    readonly bytes: Uint8Array;
  }[],
): Sha256DigestV1 => {
  const hash = createHash("sha256");
  for (const file of [...files].sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  )) {
    hash.update(file.relativePath).update("\0").update(file.bytes).update("\0");
  }
  return asSha256DigestV1(hash.digest("hex"));
};

export interface ManagedGodotProjectEnvironmentRuntimePreflightResultV1 {
  readonly capability: ManagedGodotProjectEnvironmentRuntimeCapabilityV1;
  readonly binding: ManagedGodotProjectEnvironmentRuntimeBindingV1;
  readonly vanillaSidecarSource: string;
  readonly projectEnvironmentSidecarSource: string;
  readonly sdkDigest: Sha256DigestV1;
  readonly bridgeDigest: Sha256DigestV1;
}

export function preflightManagedGodotProjectEnvironmentRuntimeV1(input: {
  readonly godotReceipt: SrtGodotToolchainReceipt;
  readonly adapterFiles: readonly {
    readonly relativePath: string;
    readonly bytes: Uint8Array;
  }[];
}): ManagedGodotProjectEnvironmentRuntimePreflightResultV1 {
  const sourceOptions = {
    godotExecutable:
      DEFAULT_PROJECT_ENVIRONMENT_SIDECAR_TARGETS_V1.godotExecutable,
    workspaceRoot: DEFAULT_PROJECT_ENVIRONMENT_SIDECAR_TARGETS_V1.workspaceRoot,
    runtimeRoot: DEFAULT_PROJECT_ENVIRONMENT_SIDECAR_TARGETS_V1.runtimeRoot,
  };
  const vanillaSidecarSource =
    createProjectEnvironmentVanillaSmokeSidecarSource(sourceOptions);
  const projectEnvironmentSidecarSource =
    createProjectEnvironmentRuntimeSidecarSource(sourceOptions);
  const runtime = createManagedGodotProjectEnvironmentRuntimeV1({
    doctorVersion: input.godotReceipt.realizedVersionOutput,
    adapterFiles: input.adapterFiles,
  });
  return Object.freeze({
    ...runtime,
    vanillaSidecarSource,
    projectEnvironmentSidecarSource,
    sdkDigest: roleDigest(PROJECT_ADAPTER_SDK_FILES_V1),
    bridgeDigest: roleDigest(PROJECT_ENVIRONMENT_BRIDGE_FILES_V1),
  });
}
