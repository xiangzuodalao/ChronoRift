import {
  asSha256DigestV1,
  type JsonValue,
  type Sha256DigestV1,
} from "@chronorift/domain";
import { contentHash } from "@chronorift/json-artifacts";

import {
  RealizedResourceLimitsV1Schema,
  SandboxPolicyContentV1Schema,
  SandboxPolicyV1Schema,
  SandboxResourceProfileNameV1Schema,
  type RealizedResourceLimitsV1,
  type SandboxPolicyContentV1,
  type SandboxPolicyV1,
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
