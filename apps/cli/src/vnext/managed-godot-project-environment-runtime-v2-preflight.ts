import { asSha256DigestV1, type Sha256DigestV1 } from "@chronorift/domain";
import {
  DEFAULT_PROJECT_ENVIRONMENT_SIDECAR_TARGETS_V1,
  PROJECT_ADAPTER_SDK_FILES_V2,
  PROJECT_ENVIRONMENT_BRIDGE_FILES_V2,
  createProjectEnvironmentRuntimeSidecarSourceV2,
  createProjectEnvironmentVanillaSmokeSidecarSourceV2,
} from "@chronorift/godot-adapter";

import {
  createManagedGodotProjectEnvironmentRuntimeV2,
  projectEnvironmentRuntimeTreeHashV2,
  type ManagedGodotProjectEnvironmentRuntimeBindingV2,
  type ManagedGodotProjectEnvironmentRuntimeCapabilityV2,
} from "./managed-godot-project-environment-runtime-v2.js";
import type { SrtGodotToolchainReceipt } from "./srt-runtime-config.js";

const roleDigest = (
  files: readonly {
    readonly relativePath: string;
    readonly bytes: Uint8Array;
  }[],
): Sha256DigestV1 =>
  asSha256DigestV1(projectEnvironmentRuntimeTreeHashV2(files));

export interface ManagedGodotProjectEnvironmentRuntimePreflightResultV2 {
  readonly capability: ManagedGodotProjectEnvironmentRuntimeCapabilityV2;
  readonly binding: ManagedGodotProjectEnvironmentRuntimeBindingV2;
  readonly vanillaSidecarSource: string;
  readonly projectEnvironmentSidecarSource: string;
  readonly sdkDigest: Sha256DigestV1;
  readonly bridgeDigest: Sha256DigestV1;
}

export function preflightManagedGodotProjectEnvironmentRuntimeV2(input: {
  readonly godotReceipt: SrtGodotToolchainReceipt;
  readonly adapterFiles: readonly {
    readonly relativePath: string;
    readonly bytes: Uint8Array;
  }[];
}): ManagedGodotProjectEnvironmentRuntimePreflightResultV2 {
  const sourceOptions = {
    godotExecutable:
      DEFAULT_PROJECT_ENVIRONMENT_SIDECAR_TARGETS_V1.godotExecutable,
    workspaceRoot: DEFAULT_PROJECT_ENVIRONMENT_SIDECAR_TARGETS_V1.workspaceRoot,
    runtimeRoot: DEFAULT_PROJECT_ENVIRONMENT_SIDECAR_TARGETS_V1.runtimeRoot,
  };
  const vanillaSidecarSource =
    createProjectEnvironmentVanillaSmokeSidecarSourceV2(sourceOptions);
  const projectEnvironmentSidecarSource =
    createProjectEnvironmentRuntimeSidecarSourceV2(sourceOptions);
  return Object.freeze({
    ...createManagedGodotProjectEnvironmentRuntimeV2({
      doctorVersion: input.godotReceipt.realizedVersionOutput,
      adapterFiles: input.adapterFiles,
    }),
    vanillaSidecarSource,
    projectEnvironmentSidecarSource,
    sdkDigest: roleDigest(PROJECT_ADAPTER_SDK_FILES_V2),
    bridgeDigest: roleDigest(PROJECT_ENVIRONMENT_BRIDGE_FILES_V2),
  });
}
