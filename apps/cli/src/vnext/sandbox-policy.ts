import {
  asSha256DigestV1,
  type JsonValue,
  type Sha256DigestV1,
} from "@chronorift/domain";
import { contentHash } from "@chronorift/json-artifacts";

import {
  RealizedResourceLimitsV1Schema,
  SandboxPolicyContentV1Schema,
  SandboxPolicyContentV2Schema,
  SandboxPolicyV1Schema,
  SandboxPolicyV2Schema,
  SandboxResourceProfileNameV1Schema,
  type RealizedResourceLimitsV1,
  type SandboxPolicyContentV1,
  type SandboxPolicyContentV2,
  type SandboxPolicyV1,
  type SandboxPolicyV2,
  type SandboxResourceProfileNameV1,
} from "./contracts.js";
import { M1Error } from "./errors.js";

export const resolveResourceLimitsV1 = (
  profile: SandboxResourceProfileNameV1,
  requestedTimeoutMs: number | undefined,
): RealizedResourceLimitsV1 => {
  const parsedProfile = SandboxResourceProfileNameV1Schema.parse(profile);
  const defaultTimeoutMs =
    parsedProfile === "coding-default" ? 120_000 : 180_000;
  const timeoutMs = requestedTimeoutMs ?? defaultTimeoutMs;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) {
    throw new M1Error(
      "capability_denied",
      "timeoutMs must be an integer from 1 to 600000",
    );
  }
  return Object.freeze(
    RealizedResourceLimitsV1Schema.parse({
      cpuMax: "200000 100000",
      memoryMaxBytes: 2_147_483_648,
      memorySwapMaxBytes: 0,
      pidsMax: 128,
      nofile: 1024,
      fileSizeMaxBytes:
        parsedProfile === "coding-default" ? 536_870_912 : 1_073_741_824,
      stdoutMaxBytes: 16_777_216,
      stderrMaxBytes: 16_777_216,
      timeoutMs,
    }),
  );
};

export const sandboxPolicyV1Content = (
  policy: SandboxPolicyV1,
): SandboxPolicyContentV1 =>
  SandboxPolicyContentV1Schema.parse({
    schemaVersion: policy.schemaVersion,
    runtimeIdentity: policy.runtimeIdentity,
    toolchainId: policy.toolchainId,
    writableTargets: policy.writableTargets,
    readonlyTargets: policy.readonlyTargets,
    namespaces: policy.namespaces,
    network: policy.network,
    copiedEnvironmentKeys: policy.copiedEnvironmentKeys,
    profiles: policy.profiles,
  });

export const createSandboxPolicyV1 = (
  runtimeIdentity: Sha256DigestV1,
  toolchain?: {
    readonly toolchainId: string;
    readonly targets: readonly string[];
  },
): SandboxPolicyV1 => {
  const readonlyTargets = [
    "/bin/busybox",
    ...(toolchain?.targets ?? []),
  ].sort();
  const content = SandboxPolicyContentV1Schema.parse({
    schemaVersion: 1,
    runtimeIdentity: asSha256DigestV1(runtimeIdentity),
    toolchainId: toolchain?.toolchainId ?? null,
    writableTargets: ["/workspace", "/tmp", "/artifacts"],
    readonlyTargets,
    namespaces: ["mount", "user", "pid", "ipc", "uts", "network"],
    network: "isolated",
    copiedEnvironmentKeys: ["CI", "NO_COLOR"],
    profiles: {
      "coding-default": resolveResourceLimitsV1("coding-default", undefined),
      "godot-headless": resolveResourceLimitsV1("godot-headless", undefined),
    },
  });
  const policy = SandboxPolicyV1Schema.parse({
    ...content,
    policyId: `sandbox-policy:v1:${asSha256DigestV1(
      contentHash(content as unknown as JsonValue),
    )}`,
  });
  Object.freeze(policy.profiles["coding-default"]);
  Object.freeze(policy.profiles["godot-headless"]);
  Object.freeze(policy.profiles);
  Object.freeze(policy.writableTargets);
  Object.freeze(policy.readonlyTargets);
  Object.freeze(policy.namespaces);
  Object.freeze(policy.copiedEnvironmentKeys);
  return Object.freeze(policy);
};

export const sandboxPolicyV2Content = (
  policy: SandboxPolicyV2,
): SandboxPolicyContentV2 =>
  SandboxPolicyContentV2Schema.parse({
    schemaVersion: policy.schemaVersion,
    runtimeIdentity: policy.runtimeIdentity,
    writableTargets: policy.writableTargets,
    namespaces: policy.namespaces,
    network: policy.network,
    copiedEnvironmentKeys: policy.copiedEnvironmentKeys,
    profiles: policy.profiles,
    profileBindings: policy.profileBindings,
  });

export const createSandboxPolicyV2 = (
  runtimeIdentity: Sha256DigestV1,
  bindings: {
    readonly coding: {
      readonly toolchainId: string;
      readonly targets: readonly string[];
    };
    readonly godot: {
      readonly toolchainId: string;
      readonly managedRuntimeId: string;
      readonly targets: readonly string[];
    };
  },
): SandboxPolicyV2 => {
  const content = SandboxPolicyContentV2Schema.parse({
    schemaVersion: 2,
    runtimeIdentity: asSha256DigestV1(runtimeIdentity),
    writableTargets: ["/workspace", "/tmp", "/artifacts"],
    namespaces: ["mount", "user", "pid", "ipc", "uts", "network"],
    network: "isolated",
    copiedEnvironmentKeys: ["CI", "NO_COLOR"],
    profiles: {
      "coding-default": resolveResourceLimitsV1("coding-default", undefined),
      "godot-headless": resolveResourceLimitsV1("godot-headless", undefined),
    },
    profileBindings: {
      "coding-default": {
        toolchainId: bindings.coding.toolchainId,
        managedRuntimeId: null,
        workspaceAccess: "read-write",
        readonlyTargets: ["/bin/busybox", ...bindings.coding.targets].sort(),
      },
      "godot-headless": {
        toolchainId: bindings.godot.toolchainId,
        managedRuntimeId: bindings.godot.managedRuntimeId,
        workspaceAccess: "read-only",
        readonlyTargets: ["/bin/busybox", ...bindings.godot.targets].sort(),
      },
    },
  });
  const policy = SandboxPolicyV2Schema.parse({
    ...content,
    policyId: `sandbox-policy:v2:${asSha256DigestV1(
      contentHash(content as unknown as JsonValue),
    )}`,
  });
  Object.freeze(policy.profiles["coding-default"]);
  Object.freeze(policy.profiles["godot-headless"]);
  Object.freeze(policy.profiles);
  Object.freeze(policy.profileBindings["coding-default"].readonlyTargets);
  Object.freeze(policy.profileBindings["coding-default"]);
  Object.freeze(policy.profileBindings["godot-headless"].readonlyTargets);
  Object.freeze(policy.profileBindings["godot-headless"]);
  Object.freeze(policy.profileBindings);
  Object.freeze(policy.writableTargets);
  Object.freeze(policy.namespaces);
  Object.freeze(policy.copiedEnvironmentKeys);
  return Object.freeze(policy);
};
