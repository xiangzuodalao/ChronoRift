import { createHash } from "node:crypto";

import {
  Sha256DigestV1Schema,
  asSha256DigestV1,
  type JsonValue,
  type Sha256DigestV1,
} from "@chronorift/domain";
import {
  DEFAULT_PROJECT_ENVIRONMENT_SIDECAR_TARGETS_V1,
  GODOT_PROJECT_ENVIRONMENT_OVERRIDE_SOURCE_V2,
  LIFECYCLE_MANAGED_FONTCONFIG_SOURCE,
  PROJECT_ADAPTER_SDK_FILES_V2,
  PROJECT_ENVIRONMENT_BRIDGE_FILES_V2,
  PROJECT_ENVIRONMENT_RUNTIME_PROFILE_V2,
} from "@chronorift/godot-adapter";
import { contentHash } from "@chronorift/json-artifacts";
import { z } from "zod";

import {
  SandboxToolchainCapabilityV1Schema,
  SandboxToolchainTargetV1Schema,
  type SandboxToolchainCapabilityV1,
} from "./contracts.js";
import { ManagedGodotAddonFileV1Schema } from "./managed-godot-runtime.js";
import type { SandboxToolchainBindingV1 } from "./sandbox-toolchain.js";

const sha256 = (bytes: Uint8Array): Sha256DigestV1 =>
  asSha256DigestV1(createHash("sha256").update(bytes).digest("hex"));
export const projectEnvironmentRuntimeTreeHashV2 = (
  files: readonly {
    readonly relativePath: string;
    readonly bytes: Uint8Array;
  }[],
): Sha256DigestV1 => {
  const hash = createHash("sha256");
  for (const file of [...files].sort((a, b) =>
    a.relativePath.localeCompare(b.relativePath),
  )) {
    hash.update(file.relativePath).update("\0").update(file.bytes).update("\0");
  }
  return asSha256DigestV1(hash.digest("hex"));
};

const fontconfigBytes = Buffer.from(
  LIFECYCLE_MANAGED_FONTCONFIG_SOURCE,
  "utf8",
);
const overlayBytes = Buffer.from(
  GODOT_PROJECT_ENVIRONMENT_OVERRIDE_SOURCE_V2,
  "utf8",
);
const managedFiles = Object.freeze(
  [...PROJECT_ENVIRONMENT_BRIDGE_FILES_V2, ...PROJECT_ADAPTER_SDK_FILES_V2]
    .map((file) => ({
      relativePath: file.relativePath,
      bytes: Uint8Array.from(file.bytes),
    }))
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath)),
);
const contentShape = {
  schemaVersion: z.literal(2),
  runtimeProfile: z.literal(PROJECT_ENVIRONMENT_RUNTIME_PROFILE_V2),
  engine: z.literal("godot"),
  doctorVersion: z
    .string()
    .regex(/^4\.7\.1\.stable\.official\.[a-f0-9]{7,64}$/u),
  engineVersion: z.literal("4.7.1-stable (official)"),
  protocolProfile: z.literal("chronorift-godot-project-environment-v2"),
  protocolVersion: z.literal(2),
  nodeTarget: SandboxToolchainTargetV1Schema,
  godotTarget: SandboxToolchainTargetV1Schema,
  toolchain: SandboxToolchainCapabilityV1Schema,
  vanillaSidecarSourceSha256: Sha256DigestV1Schema,
  projectEnvironmentSidecarSourceSha256: Sha256DigestV1Schema,
  fontconfigTarget: z.literal(
    DEFAULT_PROJECT_ENVIRONMENT_SIDECAR_TARGETS_V1.fontconfigFile,
  ),
  fontconfigByteLength: z.number().int().positive().max(4_096),
  fontconfigSha256: Sha256DigestV1Schema,
  overlayTarget: z.literal(
    DEFAULT_PROJECT_ENVIRONMENT_SIDECAR_TARGETS_V1.managedOverrideFile,
  ),
  overlayByteLength: z.number().int().positive().max(4_096),
  overlayHash: Sha256DigestV1Schema,
  addonParentTarget: z.literal(
    DEFAULT_PROJECT_ENVIRONMENT_SIDECAR_TARGETS_V1.managedAddonParent,
  ),
  addonTarget: z.literal(
    DEFAULT_PROJECT_ENVIRONMENT_SIDECAR_TARGETS_V1.managedAddonRoot,
  ),
  addonHash: Sha256DigestV1Schema,
  addonFiles: z.array(ManagedGodotAddonFileV1Schema).min(3).max(32),
  adapterParentTarget: z.literal(
    DEFAULT_PROJECT_ENVIRONMENT_SIDECAR_TARGETS_V1.managedAdapterParent,
  ),
  adapterTarget: z.literal(
    DEFAULT_PROJECT_ENVIRONMENT_SIDECAR_TARGETS_V1.managedAdapterRoot,
  ),
  adapterHash: Sha256DigestV1Schema,
  adapterFiles: z.array(ManagedGodotAddonFileV1Schema).min(2).max(256),
} as const;
const ContentSchema = z.object(contentShape).strict();

export const ManagedGodotProjectEnvironmentRuntimeCapabilityV2Schema = z
  .object({
    managedRuntimeId: z
      .string()
      .regex(/^managed-godot-project-environment:v2:[a-f0-9]{64}$/u),
    ...contentShape,
  })
  .strict()
  .superRefine((value, context) => {
    const { managedRuntimeId, ...content } = value;
    if (
      managedRuntimeId !==
      `managed-godot-project-environment:v2:${contentHash(content as unknown as JsonValue)}`
    )
      context.addIssue({
        code: "custom",
        path: ["managedRuntimeId"],
        message: "managed V2 runtime identity mismatch",
      });
    if (
      value.fontconfigSha256 !== sha256(fontconfigBytes) ||
      value.overlayHash !== sha256(overlayBytes) ||
      value.addonHash !== projectEnvironmentRuntimeTreeHashV2(managedFiles)
    )
      context.addIssue({
        code: "custom",
        path: ["addonHash"],
        message: "managed V2 bridge/SDK/overlay bytes changed",
      });
  });
export type ManagedGodotProjectEnvironmentRuntimeCapabilityV2 = z.infer<
  typeof ManagedGodotProjectEnvironmentRuntimeCapabilityV2Schema
>;
export interface ManagedGodotProjectEnvironmentRuntimeBindingV2 {
  readonly managedRuntimeId: string;
  readonly toolchain: SandboxToolchainBindingV1;
  readonly addonFiles: readonly {
    readonly relativePath: string;
    readonly bytes: Uint8Array;
  }[];
  readonly adapterFiles: readonly {
    readonly relativePath: string;
    readonly bytes: Uint8Array;
  }[];
  readonly overlayBytes: Uint8Array;
  readonly fontconfigBytes: Uint8Array;
}

export const createManagedGodotProjectEnvironmentRuntimeV2 = (input: {
  readonly doctorVersion: string;
  readonly nodeTarget: string;
  readonly godotTarget: string;
  readonly toolchain: {
    readonly capability: SandboxToolchainCapabilityV1;
    readonly binding: SandboxToolchainBindingV1;
  };
  readonly vanillaSidecarSource: string;
  readonly projectEnvironmentSidecarSource: string;
  readonly adapterFiles: readonly {
    readonly relativePath: string;
    readonly bytes: Uint8Array;
  }[];
}): {
  readonly capability: ManagedGodotProjectEnvironmentRuntimeCapabilityV2;
  readonly binding: ManagedGodotProjectEnvironmentRuntimeBindingV2;
} => {
  const adapterFiles = input.adapterFiles
    .map((file) => ({
      relativePath: file.relativePath,
      bytes: Uint8Array.from(file.bytes),
    }))
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  const content = ContentSchema.parse({
    schemaVersion: 2,
    runtimeProfile: PROJECT_ENVIRONMENT_RUNTIME_PROFILE_V2,
    engine: "godot",
    doctorVersion: input.doctorVersion,
    engineVersion: "4.7.1-stable (official)",
    protocolProfile: "chronorift-godot-project-environment-v2",
    protocolVersion: 2,
    nodeTarget: input.nodeTarget,
    godotTarget: input.godotTarget,
    toolchain: input.toolchain.capability,
    vanillaSidecarSourceSha256: sha256(Buffer.from(input.vanillaSidecarSource)),
    projectEnvironmentSidecarSourceSha256: sha256(
      Buffer.from(input.projectEnvironmentSidecarSource),
    ),
    fontconfigTarget:
      DEFAULT_PROJECT_ENVIRONMENT_SIDECAR_TARGETS_V1.fontconfigFile,
    fontconfigByteLength: fontconfigBytes.byteLength,
    fontconfigSha256: sha256(fontconfigBytes),
    overlayTarget:
      DEFAULT_PROJECT_ENVIRONMENT_SIDECAR_TARGETS_V1.managedOverrideFile,
    overlayByteLength: overlayBytes.byteLength,
    overlayHash: sha256(overlayBytes),
    addonParentTarget:
      DEFAULT_PROJECT_ENVIRONMENT_SIDECAR_TARGETS_V1.managedAddonParent,
    addonTarget:
      DEFAULT_PROJECT_ENVIRONMENT_SIDECAR_TARGETS_V1.managedAddonRoot,
    addonHash: projectEnvironmentRuntimeTreeHashV2(managedFiles),
    addonFiles: managedFiles.map((file) => ({
      relativePath: file.relativePath,
      byteLength: file.bytes.byteLength,
      sha256: sha256(file.bytes),
    })),
    adapterParentTarget:
      DEFAULT_PROJECT_ENVIRONMENT_SIDECAR_TARGETS_V1.managedAdapterParent,
    adapterTarget:
      DEFAULT_PROJECT_ENVIRONMENT_SIDECAR_TARGETS_V1.managedAdapterRoot,
    adapterHash: projectEnvironmentRuntimeTreeHashV2(adapterFiles),
    adapterFiles: adapterFiles.map((file) => ({
      relativePath: file.relativePath,
      byteLength: file.bytes.byteLength,
      sha256: sha256(file.bytes),
    })),
  });
  const capability =
    ManagedGodotProjectEnvironmentRuntimeCapabilityV2Schema.parse({
      ...content,
      managedRuntimeId: `managed-godot-project-environment:v2:${contentHash(content as unknown as JsonValue)}`,
    });
  const binding = Object.freeze({
    managedRuntimeId: capability.managedRuntimeId,
    toolchain: input.toolchain.binding,
    addonFiles: managedFiles,
    adapterFiles: Object.freeze(adapterFiles),
    overlayBytes: Uint8Array.from(overlayBytes),
    fontconfigBytes: Uint8Array.from(fontconfigBytes),
  });
  assertManagedGodotProjectEnvironmentRuntimeBindingV2(capability, binding);
  return Object.freeze({ capability, binding });
};

export const assertManagedGodotProjectEnvironmentRuntimeBindingV2 = (
  capabilityInput: ManagedGodotProjectEnvironmentRuntimeCapabilityV2,
  binding: ManagedGodotProjectEnvironmentRuntimeBindingV2,
): void => {
  const capability =
    ManagedGodotProjectEnvironmentRuntimeCapabilityV2Schema.parse(
      capabilityInput,
    );
  if (
    binding.managedRuntimeId !== capability.managedRuntimeId ||
    binding.toolchain.toolchainId !== capability.toolchain.toolchainId ||
    sha256(binding.overlayBytes) !== capability.overlayHash ||
    sha256(binding.fontconfigBytes) !== capability.fontconfigSha256 ||
    projectEnvironmentRuntimeTreeHashV2(binding.addonFiles) !==
      capability.addonHash ||
    projectEnvironmentRuntimeTreeHashV2(binding.adapterFiles) !==
      capability.adapterHash
  )
    throw new TypeError(
      "managed V2 Project Environment runtime binding mismatch",
    );
};
