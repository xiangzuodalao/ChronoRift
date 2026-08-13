import { describe, expect, it } from "vitest";

import { asSha256DigestV1 } from "@chronorift/domain";

import {
  SandboxPolicySchema,
  SandboxPolicyV1Schema,
  SandboxPolicyV2Schema,
} from "./contracts.js";
import {
  createSandboxPolicyV1,
  createSandboxPolicyV2,
  resolveResourceLimitsV1,
} from "./sandbox-policy.js";

describe("M1 sandbox policy", () => {
  it("freezes exact coding limits and clamps no value silently", () => {
    expect(resolveResourceLimitsV1("coding-default", undefined)).toMatchObject({
      timeoutMs: 120_000,
      cpuMax: "200000 100000",
      memoryMaxBytes: 2_147_483_648,
      memorySwapMaxBytes: 0,
      pidsMax: 128,
      nofile: 1024,
      fileSizeMaxBytes: 536_870_912,
      stdoutMaxBytes: 16_777_216,
      stderrMaxBytes: 16_777_216,
    });
    expect(resolveResourceLimitsV1("godot-headless", undefined)).toMatchObject({
      timeoutMs: 180_000,
      fileSizeMaxBytes: 1_073_741_824,
    });
    expect(() => resolveResourceLimitsV1("coding-default", 0)).toThrow();
    expect(() => resolveResourceLimitsV1("coding-default", 600_001)).toThrow();
  });

  it("produces a stable, validated policy identity", () => {
    const runtimeIdentity = asSha256DigestV1("a".repeat(64));
    const first = createSandboxPolicyV1(runtimeIdentity);
    expect(first).toEqual(createSandboxPolicyV1(runtimeIdentity));
    expect(SandboxPolicyV1Schema.parse(first)).toEqual(first);
    expect(() =>
      SandboxPolicyV1Schema.parse({
        ...first,
        network: "host",
      }),
    ).toThrow();
    expect(() =>
      SandboxPolicyV1Schema.parse({
        ...first,
        runtimeIdentity: asSha256DigestV1("b".repeat(64)),
      }),
    ).toThrow(/policyId/u);
  });

  it("never makes Host-only task directories mountable", () => {
    const serialized = JSON.stringify(
      createSandboxPolicyV1(asSha256DigestV1("a".repeat(64))),
    );
    expect(serialized).not.toMatch(
      /records|host-baseline\.git|host-tmp|sandbox-artifacts/u,
    );
  });

  it("binds coding and managed Godot mounts to separate V2 profiles", () => {
    const runtimeIdentity = asSha256DigestV1("a".repeat(64));
    const codingToolchainId = `sandbox-toolchain:v1:${"b".repeat(64)}`;
    const managedToolchainId = `sandbox-toolchain:v1:${"c".repeat(64)}`;
    const managedRuntimeId = `managed-godot-runtime:v1:${"d".repeat(64)}`;
    const policy = createSandboxPolicyV2(runtimeIdentity, {
      coding: {
        toolchainId: codingToolchainId,
        targets: ["/bin/bash", "/usr/bin/rg"],
      },
      godot: {
        toolchainId: managedToolchainId,
        managedRuntimeId,
        targets: [
          "/opt/chronorift/bin/godot",
          "/opt/chronorift/bin/node",
          "/lib/libc.so.6",
          "/run/chronorift/project/addons",
          "/run/chronorift/project/addons/chronorift",
        ],
      },
    });

    expect(SandboxPolicyV2Schema.parse(policy)).toEqual(policy);
    expect(SandboxPolicySchema.parse(policy)).toEqual(policy);
    expect(policy.profileBindings["coding-default"]).toEqual({
      toolchainId: codingToolchainId,
      managedRuntimeId: null,
      workspaceAccess: "read-write",
      readonlyTargets: ["/bin/bash", "/bin/busybox", "/usr/bin/rg"],
    });
    expect(policy.profileBindings["godot-headless"]).toEqual({
      toolchainId: managedToolchainId,
      managedRuntimeId,
      workspaceAccess: "read-only",
      readonlyTargets: [
        "/bin/busybox",
        "/lib/libc.so.6",
        "/opt/chronorift/bin/godot",
        "/opt/chronorift/bin/node",
        "/run/chronorift/project/addons",
        "/run/chronorift/project/addons/chronorift",
      ],
    });
    expect(() =>
      SandboxPolicyV2Schema.parse({
        ...policy,
        profileBindings: {
          ...policy.profileBindings,
          "godot-headless": {
            ...policy.profileBindings["godot-headless"],
            managedRuntimeId: `managed-godot-runtime:v1:${"e".repeat(64)}`,
          },
        },
      }),
    ).toThrow(/policyId/u);
  });

  it("accepts the independently versioned Project Environment runtime identity", () => {
    const policy = createSandboxPolicyV2(asSha256DigestV1("a".repeat(64)), {
      coding: {
        toolchainId: `sandbox-toolchain:v1:${"b".repeat(64)}`,
        targets: ["/bin/bash"],
      },
      godot: {
        toolchainId: `sandbox-toolchain:v1:${"c".repeat(64)}`,
        managedRuntimeId: `managed-godot-project-environment:v1:${"d".repeat(64)}`,
        targets: ["/opt/chronorift/bin/godot"],
      },
    });

    expect(SandboxPolicyV2Schema.parse(policy)).toEqual(policy);

    const v2 = createSandboxPolicyV2(asSha256DigestV1("a".repeat(64)), {
      coding: {
        toolchainId: `sandbox-toolchain:v1:${"b".repeat(64)}`,
        targets: ["/bin/bash"],
      },
      godot: {
        toolchainId: `sandbox-toolchain:v1:${"c".repeat(64)}`,
        managedRuntimeId: `managed-godot-project-environment:v2:${"d".repeat(64)}`,
        targets: ["/opt/chronorift/bin/godot"],
      },
    });
    expect(SandboxPolicyV2Schema.parse(v2)).toEqual(v2);
    expect(() =>
      SandboxPolicyV2Schema.parse({
        ...v2,
        profileBindings: {
          ...v2.profileBindings,
          "godot-headless": {
            ...v2.profileBindings["godot-headless"],
            managedRuntimeId: `managed-godot-project-environment:v3:${"d".repeat(64)}`,
          },
        },
      }),
    ).toThrow();
  });
});
