import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { asSha256DigestV1, type JsonValue } from "@chronorift/domain";
import { contentHash } from "@chronorift/json-artifacts";

import { SandboxToolchainCapabilityV1Schema } from "./contracts.js";
import {
  assertManagedGodotRuntimeBinding,
  createManagedGodotRuntimeV1,
} from "./managed-godot-runtime.js";

const digest = (value: string) =>
  asSha256DigestV1(createHash("sha256").update(value).digest("hex"));

const jsonValue = (value: unknown): JsonValue =>
  JSON.parse(JSON.stringify(value)) as JsonValue;

const toolchain = () => {
  const files = [
    { target: "/bin/sh", sha256: digest("busybox"), command: false },
    { target: "/lib/libc.so.6", sha256: digest("libc"), command: false },
    {
      target: "/lib/x86_64-linux-gnu/libfontconfig.so.1",
      sha256: digest("fontconfig"),
      command: false,
    },
    {
      target: "/opt/chronorift/bin/godot",
      sha256: digest("godot"),
      command: true,
    },
    {
      target: "/opt/chronorift/bin/node",
      sha256: digest("node"),
      command: true,
    },
    {
      target: "/usr/bin/xdg-user-dir",
      sha256: digest("xdg-user-dir"),
      command: false,
    },
  ] as const;
  const content = { schemaVersion: 1 as const, files };
  const capability = SandboxToolchainCapabilityV1Schema.parse({
    ...content,
    toolchainId: `sandbox-toolchain:v1:${contentHash(jsonValue(content))}`,
  });
  return {
    capability,
    binding: {
      toolchainId: capability.toolchainId,
      files: [
        { target: files[0].target, hostPath: "/usr/bin/busybox" },
        { target: files[1].target, hostPath: "/usr/lib/libc.so.6" },
        { target: files[2].target, hostPath: "/usr/lib/libfontconfig.so.1" },
        { target: files[3].target, hostPath: "/usr/lib/godot" },
        { target: files[4].target, hostPath: "/usr/bin/node" },
        { target: files[5].target, hostPath: "/usr/bin/xdg-user-dir" },
      ],
    },
  };
};

describe("managed Godot runtime capability", () => {
  it("binds exact profile commands, sidecar source, and addon bytes", () => {
    const frozen = createManagedGodotRuntimeV1({
      doctorVersion: "4.7.1.stable.official.a13da4feb",
      nodeTarget: "/opt/chronorift/bin/node",
      godotTarget: "/opt/chronorift/bin/godot",
      toolchain: toolchain(),
      sidecarSource: "sidecar source",
      addonFiles: [
        { relativePath: "plugin.cfg", bytes: Buffer.from("[plugin]\n") },
        { relativePath: "probe.gd", bytes: Buffer.from("extends Node\n") },
      ],
    });
    expect(frozen.capability.managedRuntimeId).toMatch(
      /^managed-godot-runtime:v1:[a-f0-9]{64}$/u,
    );
    expect(
      frozen.capability.toolchain.files.filter((file) => file.command),
    ).toHaveLength(2);
    expect(frozen.capability.addonTarget).toBe(
      "/run/chronorift/project/addons/chronorift",
    );
    expect(frozen.capability.addonParentTarget).toBe(
      "/run/chronorift/project/addons",
    );
    expect(frozen.capability.fontconfigTarget).toBe(
      "/opt/chronorift/etc/fontconfig/fonts.conf",
    );
    expect(() =>
      assertManagedGodotRuntimeBinding(frozen.capability, frozen.binding),
    ).not.toThrow();
  });

  it("rejects changed addon bytes and extra executable commands", () => {
    const base = toolchain();
    const frozen = createManagedGodotRuntimeV1({
      doctorVersion: "4.7.1.stable.official.a13da4feb",
      nodeTarget: "/opt/chronorift/bin/node",
      godotTarget: "/opt/chronorift/bin/godot",
      toolchain: base,
      sidecarSource: "sidecar source",
      addonFiles: [{ relativePath: "probe.gd", bytes: Buffer.from("good") }],
    });
    expect(() =>
      assertManagedGodotRuntimeBinding(frozen.capability, {
        ...frozen.binding,
        addonFiles: [{ relativePath: "probe.gd", bytes: Buffer.from("bad!") }],
      }),
    ).toThrow(/content mismatch/u);
    expect(() =>
      assertManagedGodotRuntimeBinding(frozen.capability, {
        ...frozen.binding,
        fontconfigBytes: Buffer.from("<fontconfig/>\n"),
      }),
    ).toThrow(/identity mismatch/u);

    const widenedFiles = base.capability.files.map((file) => ({
      ...file,
      command: true,
    }));
    const widenedContent = {
      schemaVersion: 1 as const,
      files: widenedFiles,
    };
    const widened = SandboxToolchainCapabilityV1Schema.parse({
      ...widenedContent,
      toolchainId: `sandbox-toolchain:v1:${contentHash(jsonValue(widenedContent))}`,
    });
    expect(() =>
      createManagedGodotRuntimeV1({
        doctorVersion: "4.7.1.stable.official.a13da4feb",
        nodeTarget: "/opt/chronorift/bin/node",
        godotTarget: "/opt/chronorift/bin/godot",
        toolchain: { capability: widened, binding: base.binding },
        sidecarSource: "sidecar source",
        addonFiles: [{ relativePath: "probe.gd", bytes: Buffer.from("good") }],
      }),
    ).toThrow(/exactly Node and Godot/u);
  });

  it("binds the exact Godot doctor version into runtime identity", () => {
    const base = {
      nodeTarget: "/opt/chronorift/bin/node",
      godotTarget: "/opt/chronorift/bin/godot",
      toolchain: toolchain(),
      sidecarSource: "sidecar source",
      addonFiles: [{ relativePath: "probe.gd", bytes: Buffer.from("good") }],
    };
    const official = createManagedGodotRuntimeV1({
      ...base,
      doctorVersion: "4.7.1.stable.official.a13da4feb",
    });
    const differentBuild = createManagedGodotRuntimeV1({
      ...base,
      doctorVersion: "4.7.1.stable.official.b13da4feb",
    });

    expect(official.capability.doctorVersion).toBe(
      "4.7.1.stable.official.a13da4feb",
    );
    expect(official.capability.engineVersion).toBe("4.7.1-stable (official)");
    expect(differentBuild.capability.managedRuntimeId).not.toBe(
      official.capability.managedRuntimeId,
    );
    expect(() =>
      createManagedGodotRuntimeV1({
        ...base,
        doctorVersion: "4.7.1",
      }),
    ).toThrow(/supported official stable build/u);
  });
});
