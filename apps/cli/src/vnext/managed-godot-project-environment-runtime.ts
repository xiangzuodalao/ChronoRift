import { createHash } from "node:crypto";

import {
  Sha256DigestV1Schema,
  asSha256DigestV1,
  type JsonValue,
  type Sha256DigestV1,
} from "@chronorift/domain";
import {
  DEFAULT_PROJECT_ENVIRONMENT_SIDECAR_TARGETS_V1,
  GODOT_PROJECT_ENVIRONMENT_OVERRIDE_SOURCE_V1,
  LIFECYCLE_MANAGED_FONTCONFIG_SOURCE,
  PROJECT_ADAPTER_SDK_FILES_V1,
  PROJECT_ENVIRONMENT_BRIDGE_FILES_V1,
  PROJECT_ENVIRONMENT_RUNTIME_PROFILE_V1,
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

const treeHash = (
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
  GODOT_PROJECT_ENVIRONMENT_OVERRIDE_SOURCE_V1,
  "utf8",
);
const managedFiles = Object.freeze(
  [...PROJECT_ENVIRONMENT_BRIDGE_FILES_V1, ...PROJECT_ADAPTER_SDK_FILES_V1]
    .map((file) => ({
      relativePath: file.relativePath,
      bytes: Uint8Array.from(file.bytes),
    }))
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath)),
);

const PackageFileSchema = ManagedGodotAddonFileV1Schema;

const contentShape = {
  schemaVersion: z.literal(1),
  runtimeProfile: z.literal(PROJECT_ENVIRONMENT_RUNTIME_PROFILE_V1),
  engine: z.literal("godot"),
  doctorVersion: z
    .string()
    .regex(/^4\.7\.1\.stable\.official\.[a-f0-9]{7,64}$/u),
  engineVersion: z.literal("4.7.1-stable (official)"),
  protocolProfile: z.literal("chronorift-godot-project-environment-v1"),
  protocolVersion: z.literal(1),
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
  addonFiles: z.array(PackageFileSchema).min(2).max(32),
  adapterParentTarget: z.literal(
    DEFAULT_PROJECT_ENVIRONMENT_SIDECAR_TARGETS_V1.managedAdapterParent,
  ),
  adapterTarget: z.literal(
    DEFAULT_PROJECT_ENVIRONMENT_SIDECAR_TARGETS_V1.managedAdapterRoot,
  ),
  adapterHash: Sha256DigestV1Schema,
  adapterFiles: z.array(PackageFileSchema).min(2).max(256),
} as const;

const ContentSchema = z.object(contentShape).strict();
export type ManagedGodotProjectEnvironmentRuntimeCapabilityContentV1 = z.infer<
  typeof ContentSchema
>;

export const ManagedGodotProjectEnvironmentRuntimeCapabilityV1Schema = z
  .object({
    managedRuntimeId: z
      .string()
      .regex(/^managed-godot-project-environment:v1:[a-f0-9]{64}$/u),
    ...contentShape,
  })
  .strict()
  .superRefine((value, context) => {
    const { managedRuntimeId, ...content } = value;
    const expected = `managed-godot-project-environment:v1:${contentHash(
      content as unknown as JsonValue,
    )}`;
    if (managedRuntimeId !== expected) {
      context.addIssue({
        code: "custom",
        path: ["managedRuntimeId"],
        message: "managedRuntimeId must match the frozen PE runtime content",
      });
    }
    if (
      value.nodeTarget === value.godotTarget ||
      value.vanillaSidecarSourceSha256 ===
        value.projectEnvironmentSidecarSourceSha256
    ) {
      context.addIssue({
        code: "custom",
        path: ["projectEnvironmentSidecarSourceSha256"],
        message: "PE runtime commands and sidecar identities must be distinct",
      });
    }
    if (
      value.fontconfigByteLength !== fontconfigBytes.byteLength ||
      value.fontconfigSha256 !== sha256(fontconfigBytes) ||
      value.overlayByteLength !== overlayBytes.byteLength ||
      value.overlayHash !== sha256(overlayBytes) ||
      value.addonHash !== treeHash(managedFiles)
    ) {
      context.addIssue({
        code: "custom",
        path: ["addonHash"],
        message: "managed bridge, SDK, overlay, or fontconfig bytes changed",
      });
    }
  });
export type ManagedGodotProjectEnvironmentRuntimeCapabilityV1 = z.infer<
  typeof ManagedGodotProjectEnvironmentRuntimeCapabilityV1Schema
>;

export interface ManagedGodotProjectEnvironmentRuntimeBindingV1 {
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

export const createManagedGodotProjectEnvironmentRuntimeV1 = (input: {
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
  readonly capability: ManagedGodotProjectEnvironmentRuntimeCapabilityV1;
  readonly binding: ManagedGodotProjectEnvironmentRuntimeBindingV1;
} => {
  const adapterFiles = input.adapterFiles
    .map((file) => ({
      relativePath: file.relativePath,
      bytes: Uint8Array.from(file.bytes),
    }))
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  const content = ContentSchema.parse({
    schemaVersion: 1,
    runtimeProfile: PROJECT_ENVIRONMENT_RUNTIME_PROFILE_V1,
    engine: "godot",
    doctorVersion: input.doctorVersion,
    engineVersion: "4.7.1-stable (official)",
    protocolProfile: "chronorift-godot-project-environment-v1",
    protocolVersion: 1,
    nodeTarget: input.nodeTarget,
    godotTarget: input.godotTarget,
    toolchain: input.toolchain.capability,
    vanillaSidecarSourceSha256: sha256(
      Buffer.from(input.vanillaSidecarSource, "utf8"),
    ),
    projectEnvironmentSidecarSourceSha256: sha256(
      Buffer.from(input.projectEnvironmentSidecarSource, "utf8"),
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
    addonHash: treeHash(managedFiles),
    addonFiles: managedFiles.map((file) => ({
      relativePath: file.relativePath,
      byteLength: file.bytes.byteLength,
      sha256: sha256(file.bytes),
    })),
    adapterParentTarget:
      DEFAULT_PROJECT_ENVIRONMENT_SIDECAR_TARGETS_V1.managedAdapterParent,
    adapterTarget:
      DEFAULT_PROJECT_ENVIRONMENT_SIDECAR_TARGETS_V1.managedAdapterRoot,
    adapterHash: treeHash(adapterFiles),
    adapterFiles: adapterFiles.map((file) => ({
      relativePath: file.relativePath,
      byteLength: file.bytes.byteLength,
      sha256: sha256(file.bytes),
    })),
  });
  const capability =
    ManagedGodotProjectEnvironmentRuntimeCapabilityV1Schema.parse({
      ...content,
      managedRuntimeId: `managed-godot-project-environment:v1:${contentHash(
        content as unknown as JsonValue,
      )}`,
    });
  const binding = Object.freeze({
    managedRuntimeId: capability.managedRuntimeId,
    toolchain: input.toolchain.binding,
    addonFiles: managedFiles,
    adapterFiles: Object.freeze(adapterFiles),
    overlayBytes: Uint8Array.from(overlayBytes),
    fontconfigBytes: Uint8Array.from(fontconfigBytes),
  });
  assertManagedGodotProjectEnvironmentRuntimeBinding(capability, binding);
  return Object.freeze({ capability, binding });
};

export const assertManagedGodotProjectEnvironmentRuntimeBinding = (
  capabilityInput: ManagedGodotProjectEnvironmentRuntimeCapabilityV1,
  binding: ManagedGodotProjectEnvironmentRuntimeBindingV1,
): void => {
  const capability =
    ManagedGodotProjectEnvironmentRuntimeCapabilityV1Schema.parse(
      capabilityInput,
    );
  if (
    binding.managedRuntimeId !== capability.managedRuntimeId ||
    binding.toolchain.toolchainId !== capability.toolchain.toolchainId ||
    sha256(binding.overlayBytes) !== capability.overlayHash ||
    sha256(binding.fontconfigBytes) !== capability.fontconfigSha256 ||
    treeHash(binding.addonFiles) !== capability.addonHash ||
    treeHash(binding.adapterFiles) !== capability.adapterHash
  ) {
    throw new TypeError("managed Project Environment runtime binding mismatch");
  }
  for (const [declared, file] of [
    [capability.addonFiles, binding.addonFiles],
    [capability.adapterFiles, binding.adapterFiles],
  ] as const) {
    if (declared.length !== file.length) {
      throw new TypeError("managed Project Environment file count mismatch");
    }
    for (const [index, value] of file.entries()) {
      const expected = declared[index];
      if (
        expected === undefined ||
        expected.relativePath !== value.relativePath ||
        expected.byteLength !== value.bytes.byteLength ||
        expected.sha256 !== sha256(value.bytes)
      ) {
        throw new TypeError(
          "managed Project Environment file identity mismatch",
        );
      }
    }
  }
};
