import { createHash } from "node:crypto";

import {
  Sha256DigestV1Schema,
  asSha256DigestV1,
  type JsonValue,
  type Sha256DigestV1,
} from "@chronorift/domain";
import {
  GODOT_PROJECT_ENVIRONMENT_OVERRIDE_SOURCE_V2,
  PROJECT_ADAPTER_SDK_FILES_V2,
  PROJECT_ENVIRONMENT_BRIDGE_FILES_V2,
  PROJECT_ENVIRONMENT_RUNTIME_PROFILE_V2,
} from "@chronorift/godot-adapter";
import { contentHash } from "@chronorift/json-artifacts";
import { z } from "zod";

import { ManagedRuntimeFileV1Schema } from "./managed-runtime-file.js";

const sha256 = (bytes: Uint8Array): Sha256DigestV1 =>
  asSha256DigestV1(createHash("sha256").update(bytes).digest("hex"));

export const projectEnvironmentRuntimeTreeHashV2 = (
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
  GODOT_PROJECT_ENVIRONMENT_OVERRIDE_SOURCE_V2,
  "utf8",
);
const managedFiles = Object.freeze(
  [...PROJECT_ENVIRONMENT_BRIDGE_FILES_V2, ...PROJECT_ADAPTER_SDK_FILES_V2]
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
  schemaVersion: z.literal(2),
  runtimeProfile: z.literal(PROJECT_ENVIRONMENT_RUNTIME_PROFILE_V2),
  engine: z.literal("godot"),
  doctorVersion: z
    .string()
    .regex(/^4\.7\.1\.stable\.official\.[a-f0-9]{7,64}$/u),
  engineVersion: z.literal("4.7.1-stable (official)"),
  protocolProfile: z.literal("chronorift-godot-project-environment-v2"),
  protocolVersion: z.literal(2),
  overlayHash: Sha256DigestV1Schema,
  addonHash: Sha256DigestV1Schema,
  addonFiles: z.array(ManagedRuntimeFileV1Schema).min(3).max(32),
  adapterHash: Sha256DigestV1Schema,
  adapterFiles: z.array(ManagedRuntimeFileV1Schema).min(2).max(256),
} as const;
const ContentSchema = z.object(contentShape).strict();

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
      `managed-godot-project-environment:v2:${contentHash(
        content as unknown as JsonValue,
      )}`
    ) {
      context.addIssue({
        code: "custom",
        path: ["managedRuntimeId"],
        message: "managed V2 runtime identity mismatch",
      });
    }
    if (
      value.overlayHash !== sha256(overlayBytes) ||
      value.addonHash !== projectEnvironmentRuntimeTreeHashV2(managedFiles) ||
      !matchesManagedFiles(value.addonFiles)
    ) {
      context.addIssue({
        code: "custom",
        path: ["addonHash"],
        message: "managed V2 bridge, SDK, or overlay bytes changed",
      });
    }
  });
export type ManagedGodotProjectEnvironmentRuntimeCapabilityV2 = z.infer<
  typeof ManagedGodotProjectEnvironmentRuntimeCapabilityV2Schema
>;

export interface ManagedGodotProjectEnvironmentRuntimeBindingV2 {
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

export const createManagedGodotProjectEnvironmentRuntimeV2 = (input: {
  readonly doctorVersion: string;
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
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  const content = ContentSchema.parse({
    schemaVersion: 2,
    runtimeProfile: PROJECT_ENVIRONMENT_RUNTIME_PROFILE_V2,
    engine: "godot",
    doctorVersion: input.doctorVersion,
    engineVersion: "4.7.1-stable (official)",
    protocolProfile: "chronorift-godot-project-environment-v2",
    protocolVersion: 2,
    overlayHash: sha256(overlayBytes),
    addonHash: projectEnvironmentRuntimeTreeHashV2(managedFiles),
    addonFiles: managedFileIdentities,
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
      managedRuntimeId: `managed-godot-project-environment:v2:${contentHash(
        content as unknown as JsonValue,
      )}`,
    });
  const binding = Object.freeze({
    managedRuntimeId: capability.managedRuntimeId,
    addonFiles: managedFiles,
    adapterFiles: Object.freeze(adapterFiles),
    overlayBytes: Uint8Array.from(overlayBytes),
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
    sha256(binding.overlayBytes) !== capability.overlayHash ||
    projectEnvironmentRuntimeTreeHashV2(binding.addonFiles) !==
      capability.addonHash ||
    projectEnvironmentRuntimeTreeHashV2(binding.adapterFiles) !==
      capability.adapterHash
  ) {
    throw new TypeError(
      "managed V2 Project Environment runtime binding mismatch",
    );
  }
  for (const [declared, files] of [
    [capability.addonFiles, binding.addonFiles],
    [capability.adapterFiles, binding.adapterFiles],
  ] as const) {
    if (declared.length !== files.length) {
      throw new TypeError("managed V2 Project Environment file count mismatch");
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
          "managed V2 Project Environment file identity mismatch",
        );
      }
    }
  }
};
