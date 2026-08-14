import { createHash } from "node:crypto";

import {
  Sha256DigestV1Schema,
  asSha256DigestV1,
  type JsonValue,
  type Sha256DigestV1,
} from "@chronorift/domain";
import {
  DEFAULT_SEMANTIC_SIDECAR_TARGETS,
  GODOT_SEMANTIC_OVERRIDE_SOURCE,
  LIFECYCLE_MANAGED_FONTCONFIG_SOURCE,
} from "@chronorift/godot-adapter";
import {
  GODOT_SEMANTIC_PROTOCOL_PROFILE_V1,
  GODOT_SEMANTIC_RUNTIME_PROFILE_V1,
} from "@chronorift/godot-protocol";
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
  for (const file of files) {
    hash.update(file.relativePath);
    hash.update("\0");
    hash.update(file.bytes);
    hash.update("\0");
  }
  return asSha256DigestV1(hash.digest("hex"));
};

const FONTCONFIG_BYTES = Buffer.from(
  LIFECYCLE_MANAGED_FONTCONFIG_SOURCE,
  "utf8",
);
const FONTCONFIG_SHA256 = sha256(FONTCONFIG_BYTES);
const OVERLAY_BYTES = Buffer.from(GODOT_SEMANTIC_OVERRIDE_SOURCE, "utf8");
const OVERLAY_HASH = sha256(OVERLAY_BYTES);

export interface ManagedGodotSemanticRuntimeCapabilityV1 {
  readonly schemaVersion: 1;
  readonly managedRuntimeId: string;
  readonly runtimeProfile: typeof GODOT_SEMANTIC_RUNTIME_PROFILE_V1;
  readonly engine: "godot";
  readonly doctorVersion: string;
  readonly engineVersion: "4.7.1-stable (official)";
  readonly adapterVersion: "0.5.0";
  readonly protocolProfile: typeof GODOT_SEMANTIC_PROTOCOL_PROFILE_V1;
  readonly protocolVersion: 1;
  readonly nodeTarget: string;
  readonly godotTarget: string;
  readonly toolchain: SandboxToolchainCapabilityV1;
  readonly vanillaSidecarSourceSha256: Sha256DigestV1;
  readonly semanticSidecarSourceSha256: Sha256DigestV1;
  readonly fontconfigTarget: typeof DEFAULT_SEMANTIC_SIDECAR_TARGETS.fontconfigFile;
  readonly fontconfigByteLength: number;
  readonly fontconfigSha256: Sha256DigestV1;
  readonly overlayTarget: typeof DEFAULT_SEMANTIC_SIDECAR_TARGETS.managedOverrideFile;
  readonly overlayByteLength: number;
  readonly overlayHash: Sha256DigestV1;
  readonly addonParentTarget: typeof DEFAULT_SEMANTIC_SIDECAR_TARGETS.managedAddonParent;
  readonly addonTarget: typeof DEFAULT_SEMANTIC_SIDECAR_TARGETS.managedAddonRoot;
  readonly addonHash: Sha256DigestV1;
  readonly addonFiles: readonly z.infer<typeof ManagedGodotAddonFileV1Schema>[];
}

export type ManagedGodotSemanticRuntimeCapabilityContentV1 = Omit<
  ManagedGodotSemanticRuntimeCapabilityV1,
  "managedRuntimeId"
>;

const contentShape = {
  schemaVersion: z.literal(1),
  runtimeProfile: z.literal(GODOT_SEMANTIC_RUNTIME_PROFILE_V1),
  engine: z.literal("godot"),
  doctorVersion: z
    .string()
    .min(29)
    .max(128)
    .regex(
      /^4\.7\.1\.stable\.official\.[a-f0-9]{7,64}$/u,
      "managed semantic Godot version must identify the supported official stable build",
    ),
  engineVersion: z.literal("4.7.1-stable (official)"),
  adapterVersion: z.literal("0.5.0"),
  protocolProfile: z.literal(GODOT_SEMANTIC_PROTOCOL_PROFILE_V1),
  protocolVersion: z.literal(1),
  nodeTarget: SandboxToolchainTargetV1Schema,
  godotTarget: SandboxToolchainTargetV1Schema,
  toolchain: SandboxToolchainCapabilityV1Schema,
  vanillaSidecarSourceSha256: Sha256DigestV1Schema,
  semanticSidecarSourceSha256: Sha256DigestV1Schema,
  fontconfigTarget: z.literal(DEFAULT_SEMANTIC_SIDECAR_TARGETS.fontconfigFile),
  fontconfigByteLength: z.number().int().min(1).max(4_096),
  fontconfigSha256: Sha256DigestV1Schema,
  overlayTarget: z.literal(
    DEFAULT_SEMANTIC_SIDECAR_TARGETS.managedOverrideFile,
  ),
  overlayByteLength: z.number().int().min(1).max(4_096),
  overlayHash: Sha256DigestV1Schema,
  addonParentTarget: z.literal(
    DEFAULT_SEMANTIC_SIDECAR_TARGETS.managedAddonParent,
  ),
  addonTarget: z.literal(DEFAULT_SEMANTIC_SIDECAR_TARGETS.managedAddonRoot),
  addonHash: Sha256DigestV1Schema,
  addonFiles: z.array(ManagedGodotAddonFileV1Schema).length(1),
} as const;

const validateContent = (
  value: ManagedGodotSemanticRuntimeCapabilityContentV1,
  context: z.RefinementCtx,
): void => {
  if (value.nodeTarget === value.godotTarget) {
    context.addIssue({
      code: "custom",
      path: ["godotTarget"],
      message: "managed semantic Node and Godot targets must be distinct",
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
        "managed semantic toolchain must expose exactly Node and Godot commands",
    });
  }
  const runtimeFiles = new Map(
    value.toolchain.files.map((file) => [file.target, file]),
  );
  if (
    runtimeFiles.get(DEFAULT_SEMANTIC_SIDECAR_TARGETS.shellExecutable)
      ?.command !== false ||
    runtimeFiles.get(DEFAULT_SEMANTIC_SIDECAR_TARGETS.xdgUserDirExecutable)
      ?.command !== false ||
    !value.toolchain.files.some(
      (file) =>
        file.command === false && file.target.endsWith("/libfontconfig.so.1"),
    )
  ) {
    context.addIssue({
      code: "custom",
      path: ["toolchain", "files"],
      message:
        "managed semantic runtime must freeze shell, xdg-user-dir, and fontconfig dependencies",
    });
  }
  if (value.vanillaSidecarSourceSha256 === value.semanticSidecarSourceSha256) {
    context.addIssue({
      code: "custom",
      path: ["semanticSidecarSourceSha256"],
      message: "vanilla and semantic sidecars must have distinct identities",
    });
  }
  if (
    value.fontconfigByteLength !== FONTCONFIG_BYTES.byteLength ||
    value.fontconfigSha256 !== FONTCONFIG_SHA256
  ) {
    context.addIssue({
      code: "custom",
      path: ["fontconfigSha256"],
      message: "managed fontconfig must match the frozen ChronoRift source",
    });
  }
  if (
    value.overlayByteLength !== OVERLAY_BYTES.byteLength ||
    value.overlayHash !== OVERLAY_HASH
  ) {
    context.addIssue({
      code: "custom",
      path: ["overlayHash"],
      message: "managed semantic override must match the frozen overlay",
    });
  }
  if (value.addonFiles[0]?.relativePath !== "semantic_probe.gd") {
    context.addIssue({
      code: "custom",
      path: ["addonFiles"],
      message: "managed semantic addon must contain only semantic_probe.gd",
    });
  }
};

const ManagedGodotSemanticRuntimeCapabilityContentV1Schema: z.ZodType<ManagedGodotSemanticRuntimeCapabilityContentV1> =
  z.object(contentShape).strict().superRefine(validateContent);

export const ManagedGodotSemanticRuntimeCapabilityV1Schema: z.ZodType<ManagedGodotSemanticRuntimeCapabilityV1> =
  z
    .object({
      managedRuntimeId: z
        .string()
        .regex(/^managed-godot-semantic-runtime:v1:[a-f0-9]{64}$/u),
      ...contentShape,
    })
    .strict()
    .superRefine((value, context) => {
      const { managedRuntimeId: _managedRuntimeId, ...rawContent } = value;
      void _managedRuntimeId;
      const content =
        ManagedGodotSemanticRuntimeCapabilityContentV1Schema.safeParse(
          rawContent,
        );
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
      const expected = `managed-godot-semantic-runtime:v1:${contentHash(
        content.data as unknown as JsonValue,
      )}`;
      if (value.managedRuntimeId !== expected) {
        context.addIssue({
          code: "custom",
          path: ["managedRuntimeId"],
          message: "managedRuntimeId must match the semantic capability",
        });
      }
    });

export interface ManagedGodotSemanticRuntimeBindingV1 {
  readonly managedRuntimeId: string;
  readonly toolchain: SandboxToolchainBindingV1;
  readonly addonFiles: readonly {
    readonly relativePath: string;
    readonly bytes: Uint8Array;
  }[];
  readonly overlayBytes: Uint8Array;
  readonly fontconfigBytes: Uint8Array;
}

export const createManagedGodotSemanticRuntimeV1 = (input: {
  readonly doctorVersion: string;
  readonly nodeTarget: string;
  readonly godotTarget: string;
  readonly toolchain: {
    readonly capability: SandboxToolchainCapabilityV1;
    readonly binding: SandboxToolchainBindingV1;
  };
  readonly vanillaSidecarSource: string;
  readonly semanticSidecarSource: string;
  readonly addonFiles: readonly {
    readonly relativePath: string;
    readonly bytes: Uint8Array;
  }[];
}): {
  readonly capability: ManagedGodotSemanticRuntimeCapabilityV1;
  readonly binding: ManagedGodotSemanticRuntimeBindingV1;
} => {
  const ownedFiles = input.addonFiles
    .map((file) => ({
      relativePath: file.relativePath,
      bytes: Uint8Array.from(file.bytes),
    }))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  const content = ManagedGodotSemanticRuntimeCapabilityContentV1Schema.parse({
    schemaVersion: 1,
    runtimeProfile: GODOT_SEMANTIC_RUNTIME_PROFILE_V1,
    engine: "godot",
    doctorVersion: input.doctorVersion,
    engineVersion: "4.7.1-stable (official)",
    adapterVersion: "0.5.0",
    protocolProfile: GODOT_SEMANTIC_PROTOCOL_PROFILE_V1,
    protocolVersion: 1,
    nodeTarget: input.nodeTarget,
    godotTarget: input.godotTarget,
    toolchain: input.toolchain.capability,
    vanillaSidecarSourceSha256: sha256(
      Buffer.from(input.vanillaSidecarSource, "utf8"),
    ),
    semanticSidecarSourceSha256: sha256(
      Buffer.from(input.semanticSidecarSource, "utf8"),
    ),
    fontconfigTarget: DEFAULT_SEMANTIC_SIDECAR_TARGETS.fontconfigFile,
    fontconfigByteLength: FONTCONFIG_BYTES.byteLength,
    fontconfigSha256: FONTCONFIG_SHA256,
    overlayTarget: DEFAULT_SEMANTIC_SIDECAR_TARGETS.managedOverrideFile,
    overlayByteLength: OVERLAY_BYTES.byteLength,
    overlayHash: OVERLAY_HASH,
    addonParentTarget: DEFAULT_SEMANTIC_SIDECAR_TARGETS.managedAddonParent,
    addonTarget: DEFAULT_SEMANTIC_SIDECAR_TARGETS.managedAddonRoot,
    addonHash: treeHash(ownedFiles),
    addonFiles: ownedFiles.map((file) => ({
      relativePath: file.relativePath,
      byteLength: file.bytes.byteLength,
      sha256: sha256(file.bytes),
    })),
  });
  const capability = ManagedGodotSemanticRuntimeCapabilityV1Schema.parse({
    ...content,
    managedRuntimeId: `managed-godot-semantic-runtime:v1:${contentHash(
      content as unknown as JsonValue,
    )}`,
  });
  const binding: ManagedGodotSemanticRuntimeBindingV1 = {
    managedRuntimeId: capability.managedRuntimeId,
    toolchain: input.toolchain.binding,
    addonFiles: ownedFiles,
    overlayBytes: Buffer.from(OVERLAY_BYTES),
    fontconfigBytes: Buffer.from(FONTCONFIG_BYTES),
  };
  assertManagedGodotSemanticRuntimeBinding(capability, binding);
  return { capability, binding };
};

export const assertManagedGodotSemanticRuntimeBinding = (
  capabilityInput: ManagedGodotSemanticRuntimeCapabilityV1,
  binding: ManagedGodotSemanticRuntimeBindingV1,
): void => {
  const capability =
    ManagedGodotSemanticRuntimeCapabilityV1Schema.parse(capabilityInput);
  if (
    binding.managedRuntimeId !== capability.managedRuntimeId ||
    binding.toolchain.toolchainId !== capability.toolchain.toolchainId ||
    binding.addonFiles.length !== capability.addonFiles.length ||
    binding.overlayBytes.byteLength !== capability.overlayByteLength ||
    sha256(binding.overlayBytes) !== capability.overlayHash ||
    binding.fontconfigBytes.byteLength !== capability.fontconfigByteLength ||
    sha256(binding.fontconfigBytes) !== capability.fontconfigSha256
  ) {
    throw new TypeError(
      "managed Godot semantic runtime binding identity mismatch",
    );
  }
  for (const [index, file] of binding.addonFiles.entries()) {
    const expected = capability.addonFiles[index];
    if (
      expected === undefined ||
      file.relativePath !== expected.relativePath ||
      file.bytes.byteLength !== expected.byteLength ||
      sha256(file.bytes) !== expected.sha256
    ) {
      throw new TypeError(
        "managed Godot semantic addon binding content mismatch",
      );
    }
  }
  if (treeHash(binding.addonFiles) !== capability.addonHash) {
    throw new TypeError("managed Godot semantic addon tree identity mismatch");
  }
};
