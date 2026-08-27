import { createHash } from "node:crypto";

import {
  Sha256DigestV1Schema,
  asSha256DigestV1,
  type JsonValue,
  type Sha256DigestV1,
} from "@chronorift/domain";
import {
  GODOT_PROJECT_ENVIRONMENT_OVERRIDE_SOURCE_V1,
  PROJECT_ADAPTER_SDK_FILES_V1,
  PROJECT_ENVIRONMENT_BRIDGE_FILES_V1,
  PROJECT_ENVIRONMENT_RUNTIME_PROFILE_V1,
} from "@chronorift/godot-adapter";
import { contentHash } from "@chronorift/json-artifacts";
import { z } from "zod";

import { ManagedRuntimeFileV1Schema } from "./managed-runtime-file.js";

const sha256 = (bytes: Uint8Array): Sha256DigestV1 =>
  asSha256DigestV1(createHash("sha256").update(bytes).digest("hex"));

const treeHash = (
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
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath)),
);
const managedFileIdentities = Object.freeze(
  managedFiles.map((file) => ({
    relativePath: file.relativePath,
    byteLength: file.bytes.byteLength,
    sha256: sha256(file.bytes),
  })),
);

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
  overlayHash: Sha256DigestV1Schema,
  addonHash: Sha256DigestV1Schema,
  addonFiles: z.array(ManagedRuntimeFileV1Schema).min(2).max(32),
  adapterHash: Sha256DigestV1Schema,
  adapterFiles: z.array(ManagedRuntimeFileV1Schema).min(2).max(256),
} as const;

const ContentSchema = z.object(contentShape).strict();
export type ManagedGodotProjectEnvironmentRuntimeCapabilityContentV1 = z.infer<
  typeof ContentSchema
>;

const matchesManagedFiles = (
  actual: readonly z.infer<typeof ManagedRuntimeFileV1Schema>[],
): boolean =>
  actual.length === managedFileIdentities.length &&
  actual.every((file, index) => {
    const expected = managedFileIdentities[index];
    return (
      expected !== undefined &&
      file.relativePath === expected.relativePath &&
      file.byteLength === expected.byteLength &&
      file.sha256 === expected.sha256
    );
  });

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
    const expectedId = `managed-godot-project-environment:v1:${contentHash(
      content as unknown as JsonValue,
    )}`;
    if (managedRuntimeId !== expectedId) {
      context.addIssue({
        code: "custom",
        path: ["managedRuntimeId"],
        message: "managedRuntimeId must match the PE runtime content",
      });
    }
    if (
      value.overlayHash !== sha256(overlayBytes) ||
      value.addonHash !== treeHash(managedFiles) ||
      !matchesManagedFiles(value.addonFiles)
    ) {
      context.addIssue({
        code: "custom",
        path: ["addonHash"],
        message: "managed bridge, SDK, or overlay bytes changed",
      });
    }
  });
export type ManagedGodotProjectEnvironmentRuntimeCapabilityV1 = z.infer<
  typeof ManagedGodotProjectEnvironmentRuntimeCapabilityV1Schema
>;

export interface ManagedGodotProjectEnvironmentRuntimeBindingV1 {
  readonly managedRuntimeId: string;
  readonly addonFiles: readonly {
    readonly relativePath: string;
    readonly bytes: Uint8Array;
  }[];
  readonly adapterFiles: readonly {
    readonly relativePath: string;
    readonly bytes: Uint8Array;
  }[];
  readonly overlayBytes: Uint8Array;
}

export const createManagedGodotProjectEnvironmentRuntimeV1 = (input: {
  readonly doctorVersion: string;
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
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  const content = ContentSchema.parse({
    schemaVersion: 1,
    runtimeProfile: PROJECT_ENVIRONMENT_RUNTIME_PROFILE_V1,
    engine: "godot",
    doctorVersion: input.doctorVersion,
    engineVersion: "4.7.1-stable (official)",
    protocolProfile: "chronorift-godot-project-environment-v1",
    protocolVersion: 1,
    overlayHash: sha256(overlayBytes),
    addonHash: treeHash(managedFiles),
    addonFiles: managedFileIdentities,
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
    addonFiles: managedFiles,
    adapterFiles: Object.freeze(adapterFiles),
    overlayBytes: Uint8Array.from(overlayBytes),
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
    sha256(binding.overlayBytes) !== capability.overlayHash ||
    treeHash(binding.addonFiles) !== capability.addonHash ||
    treeHash(binding.adapterFiles) !== capability.adapterHash
  ) {
    throw new TypeError("managed Project Environment runtime binding mismatch");
  }
  for (const [declared, files] of [
    [capability.addonFiles, binding.addonFiles],
    [capability.adapterFiles, binding.adapterFiles],
  ] as const) {
    if (declared.length !== files.length) {
      throw new TypeError("managed Project Environment file count mismatch");
    }
    for (const [index, file] of files.entries()) {
      const expected = declared[index];
      if (
        expected === undefined ||
        expected.relativePath !== file.relativePath ||
        expected.byteLength !== file.bytes.byteLength ||
        expected.sha256 !== sha256(file.bytes)
      ) {
        throw new TypeError(
          "managed Project Environment file identity mismatch",
        );
      }
    }
  }
};
