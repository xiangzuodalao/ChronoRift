import { createHash } from "node:crypto";

import {
  Sha256DigestV1Schema,
  asSha256DigestV1,
  type JsonValue,
  type Sha256DigestV1,
} from "@chronorift/domain";
import {
  DEFAULT_RUNTIME_SIDECAR_TARGETS,
  MANAGED_FONTCONFIG_SOURCE,
} from "@chronorift/godot-adapter";
import { contentHash } from "@chronorift/json-artifacts";
import { z } from "zod";

import {
  SandboxToolchainCapabilityV1Schema,
  SandboxToolchainTargetV1Schema,
  type SandboxToolchainCapabilityV1,
} from "./contracts.js";
import type { SandboxToolchainBindingV1 } from "./sandbox-toolchain.js";

const normalizedRelativePath = (value: string): boolean =>
  !value.startsWith("/") &&
  !value.includes("\\") &&
  !value.includes("\0") &&
  value
    .split("/")
    .every((segment) => segment !== "" && segment !== "." && segment !== "..");

const MANAGED_FONTCONFIG_BYTES = Buffer.from(MANAGED_FONTCONFIG_SOURCE, "utf8");
const MANAGED_FONTCONFIG_SHA256 = asSha256DigestV1(
  createHash("sha256").update(MANAGED_FONTCONFIG_BYTES).digest("hex"),
);

export interface ManagedGodotAddonFileV1 {
  readonly relativePath: string;
  readonly byteLength: number;
  readonly sha256: Sha256DigestV1;
}

export const ManagedGodotAddonFileV1Schema: z.ZodType<ManagedGodotAddonFileV1> =
  z
    .object({
      relativePath: z
        .string()
        .min(1)
        .max(256)
        .refine(
          normalizedRelativePath,
          "managed addon path must be normalized and relative",
        ),
      byteLength: z
        .number()
        .int()
        .min(1)
        .max(1024 * 1024),
      sha256: Sha256DigestV1Schema,
    })
    .strict();

export interface ManagedGodotRuntimeCapabilityV1 {
  readonly schemaVersion: 1;
  readonly managedRuntimeId: string;
  readonly engine: "godot";
  readonly doctorVersion: string;
  readonly engineVersion: string;
  readonly adapterVersion: "0.4.0";
  readonly protocolVersion: 2;
  readonly nodeTarget: string;
  readonly godotTarget: string;
  readonly toolchain: SandboxToolchainCapabilityV1;
  readonly sidecarSourceSha256: Sha256DigestV1;
  readonly fontconfigTarget: typeof DEFAULT_RUNTIME_SIDECAR_TARGETS.fontconfigFile;
  readonly fontconfigByteLength: number;
  readonly fontconfigSha256: Sha256DigestV1;
  readonly addonParentTarget: typeof DEFAULT_RUNTIME_SIDECAR_TARGETS.managedAddonParent;
  readonly addonTarget: typeof DEFAULT_RUNTIME_SIDECAR_TARGETS.managedAddonRoot;
  readonly addonHash: Sha256DigestV1;
  readonly addonFiles: readonly ManagedGodotAddonFileV1[];
}

export type ManagedGodotRuntimeCapabilityContentV1 = Omit<
  ManagedGodotRuntimeCapabilityV1,
  "managedRuntimeId"
>;

const managedRuntimeContentShape = {
  schemaVersion: z.literal(1),
  engine: z.literal("godot"),
  doctorVersion: z
    .string()
    .min(29)
    .max(128)
    .regex(
      /^4\.7\.1\.stable\.official\.[a-f0-9]{7,64}$/u,
      "managed Godot doctor version must identify the supported official stable build",
    ),
  engineVersion: z.literal("4.7.1-stable (official)"),
  adapterVersion: z.literal("0.4.0"),
  protocolVersion: z.literal(2),
  nodeTarget: SandboxToolchainTargetV1Schema,
  godotTarget: SandboxToolchainTargetV1Schema,
  toolchain: SandboxToolchainCapabilityV1Schema,
  sidecarSourceSha256: Sha256DigestV1Schema,
  fontconfigTarget: z.literal(DEFAULT_RUNTIME_SIDECAR_TARGETS.fontconfigFile),
  fontconfigByteLength: z.number().int().min(1).max(4096),
  fontconfigSha256: Sha256DigestV1Schema,
  addonParentTarget: z.literal(
    DEFAULT_RUNTIME_SIDECAR_TARGETS.managedAddonParent,
  ),
  addonTarget: z.literal(DEFAULT_RUNTIME_SIDECAR_TARGETS.managedAddonRoot),
  addonHash: Sha256DigestV1Schema,
  addonFiles: z.array(ManagedGodotAddonFileV1Schema).min(1).max(32),
} as const;

const ManagedGodotRuntimeCapabilityContentV1Schema: z.ZodType<ManagedGodotRuntimeCapabilityContentV1> =
  z
    .object(managedRuntimeContentShape)
    .strict()
    .superRefine((value, context) => {
      if (value.nodeTarget === value.godotTarget) {
        context.addIssue({
          code: "custom",
          path: ["godotTarget"],
          message: "managed Node and Godot targets must be distinct",
        });
      }
      const commands = value.toolchain.files
        .filter((file) => file.command)
        .map((file) => file.target);
      if (
        commands.length !== 2 ||
        !commands.includes(value.nodeTarget) ||
        !commands.includes(value.godotTarget)
      ) {
        context.addIssue({
          code: "custom",
          path: ["toolchain", "files"],
          message:
            "managed runtime toolchain must expose exactly Node and Godot commands",
        });
      }
      const runtimeFiles = new Map(
        value.toolchain.files.map((file) => [file.target, file]),
      );
      if (
        runtimeFiles.get(DEFAULT_RUNTIME_SIDECAR_TARGETS.shellExecutable)
          ?.command !== false ||
        runtimeFiles.get(DEFAULT_RUNTIME_SIDECAR_TARGETS.xdgUserDirExecutable)
          ?.command !== false ||
        !value.toolchain.files.some(
          (file) =>
            file.command === false &&
            file.target.endsWith("/libfontconfig.so.1"),
        )
      ) {
        context.addIssue({
          code: "custom",
          path: ["toolchain", "files"],
          message:
            "managed runtime must freeze non-command shell, xdg-user-dir, and fontconfig dependencies",
        });
      }
      if (
        value.fontconfigByteLength !== MANAGED_FONTCONFIG_BYTES.byteLength ||
        value.fontconfigSha256 !== MANAGED_FONTCONFIG_SHA256
      ) {
        context.addIssue({
          code: "custom",
          path: ["fontconfigSha256"],
          message: "managed fontconfig must match the frozen ChronoRift source",
        });
      }
      const paths = value.addonFiles.map((file) => file.relativePath);
      if (
        new Set(paths).size !== paths.length ||
        paths.some((path, index) => index > 0 && path <= paths[index - 1]!)
      ) {
        context.addIssue({
          code: "custom",
          path: ["addonFiles"],
          message: "managed addon files must be unique in lexical order",
        });
      }
    });

export const ManagedGodotRuntimeCapabilityV1Schema: z.ZodType<ManagedGodotRuntimeCapabilityV1> =
  z
    .object({
      managedRuntimeId: z
        .string()
        .regex(/^managed-godot-runtime:v1:[a-f0-9]{64}$/u),
      ...managedRuntimeContentShape,
    })
    .strict()
    .superRefine((value, context) => {
      const { managedRuntimeId: _managedRuntimeId, ...rawContent } = value;
      void _managedRuntimeId;
      const content =
        ManagedGodotRuntimeCapabilityContentV1Schema.safeParse(rawContent);
      if (!content.success) {
        for (const issue of content.error.issues) {
          context.addIssue({
            code: "custom",
            path: issue.path,
            message: issue.message,
          });
        }
        return;
      }
      if (
        value.managedRuntimeId !==
        `managed-godot-runtime:v1:${contentHash(content.data as unknown as JsonValue)}`
      ) {
        context.addIssue({
          code: "custom",
          path: ["managedRuntimeId"],
          message: "managedRuntimeId must match the canonical capability",
        });
      }
    });

export interface ManagedGodotRuntimeBindingV1 {
  readonly managedRuntimeId: string;
  readonly toolchain: SandboxToolchainBindingV1;
  readonly addonFiles: readonly {
    readonly relativePath: string;
    readonly bytes: Uint8Array;
  }[];
  readonly fontconfigBytes: Uint8Array;
}

const sha256 = (bytes: Uint8Array): Sha256DigestV1 =>
  asSha256DigestV1(createHash("sha256").update(bytes).digest("hex"));

const addonTreeHash = (
  files: readonly {
    readonly relativePath: string;
    readonly bytes: Uint8Array;
  }[],
): Sha256DigestV1 => {
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file.relativePath);
    hash.update("\0");
    hash.update(file.bytes);
    hash.update("\0");
  }
  return asSha256DigestV1(hash.digest("hex"));
};

export const createManagedGodotRuntimeV1 = (input: {
  readonly doctorVersion: string;
  readonly nodeTarget: string;
  readonly godotTarget: string;
  readonly toolchain: {
    readonly capability: SandboxToolchainCapabilityV1;
    readonly binding: SandboxToolchainBindingV1;
  };
  readonly sidecarSource: string;
  readonly addonFiles: readonly {
    readonly relativePath: string;
    readonly bytes: Uint8Array;
  }[];
}): {
  readonly capability: ManagedGodotRuntimeCapabilityV1;
  readonly binding: ManagedGodotRuntimeBindingV1;
} => {
  const ownedFiles = input.addonFiles
    .map((file) => ({
      relativePath: file.relativePath,
      bytes: Uint8Array.from(file.bytes),
    }))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  const content = ManagedGodotRuntimeCapabilityContentV1Schema.parse({
    schemaVersion: 1,
    engine: "godot",
    doctorVersion: input.doctorVersion,
    engineVersion: "4.7.1-stable (official)",
    adapterVersion: "0.4.0",
    protocolVersion: 2,
    nodeTarget: input.nodeTarget,
    godotTarget: input.godotTarget,
    toolchain: input.toolchain.capability,
    sidecarSourceSha256: sha256(Buffer.from(input.sidecarSource, "utf8")),
    fontconfigTarget: DEFAULT_RUNTIME_SIDECAR_TARGETS.fontconfigFile,
    fontconfigByteLength: MANAGED_FONTCONFIG_BYTES.byteLength,
    fontconfigSha256: MANAGED_FONTCONFIG_SHA256,
    addonParentTarget: DEFAULT_RUNTIME_SIDECAR_TARGETS.managedAddonParent,
    addonTarget: DEFAULT_RUNTIME_SIDECAR_TARGETS.managedAddonRoot,
    addonHash: addonTreeHash(ownedFiles),
    addonFiles: ownedFiles.map((file) => ({
      relativePath: file.relativePath,
      byteLength: file.bytes.byteLength,
      sha256: sha256(file.bytes),
    })),
  });
  const capability = ManagedGodotRuntimeCapabilityV1Schema.parse({
    ...content,
    managedRuntimeId: `managed-godot-runtime:v1:${contentHash(content as unknown as JsonValue)}`,
  });
  const binding: ManagedGodotRuntimeBindingV1 = {
    managedRuntimeId: capability.managedRuntimeId,
    toolchain: input.toolchain.binding,
    addonFiles: ownedFiles,
    fontconfigBytes: Buffer.from(MANAGED_FONTCONFIG_BYTES),
  };
  assertManagedGodotRuntimeBinding(capability, binding);
  return { capability, binding };
};

export const assertManagedGodotRuntimeBinding = (
  capabilityInput: ManagedGodotRuntimeCapabilityV1,
  binding: ManagedGodotRuntimeBindingV1,
): void => {
  const capability =
    ManagedGodotRuntimeCapabilityV1Schema.parse(capabilityInput);
  if (
    binding.managedRuntimeId !== capability.managedRuntimeId ||
    binding.toolchain.toolchainId !== capability.toolchain.toolchainId ||
    binding.addonFiles.length !== capability.addonFiles.length ||
    binding.fontconfigBytes.byteLength !== capability.fontconfigByteLength ||
    sha256(binding.fontconfigBytes) !== capability.fontconfigSha256
  ) {
    throw new TypeError("managed Godot runtime binding identity mismatch");
  }
  for (const [index, file] of binding.addonFiles.entries()) {
    const expected = capability.addonFiles[index];
    if (
      expected === undefined ||
      file.relativePath !== expected.relativePath ||
      file.bytes.byteLength !== expected.byteLength ||
      sha256(file.bytes) !== expected.sha256
    ) {
      throw new TypeError("managed Godot addon binding content mismatch");
    }
  }
  if (addonTreeHash(binding.addonFiles) !== capability.addonHash) {
    throw new TypeError("managed Godot addon tree identity mismatch");
  }
};
