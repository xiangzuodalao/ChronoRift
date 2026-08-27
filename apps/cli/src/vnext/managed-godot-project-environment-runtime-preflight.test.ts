import { describe, expect, it } from "vitest";

import { asSha256DigestV1 } from "@chronorift/domain";

import { preflightManagedGodotProjectEnvironmentRuntimeV2 } from "./managed-godot-project-environment-runtime-v2-preflight.js";
import { preflightManagedGodotProjectEnvironmentRuntimeV1 } from "./managed-godot-project-environment-runtime-preflight.js";
import type { SrtGodotToolchainReceipt } from "./srt-runtime-config.js";

const godotReceipt: SrtGodotToolchainReceipt = {
  schemaVersion: 1,
  registryKey: "godot-4.7.1-linux-x86_64-official",
  requestedVersion: "4.7.1",
  realizedVersion: "4.7.1",
  realizedVersionOutput: "4.7.1.stable.official.abcdef0",
  platform: "linux-x86_64",
  executableSha256: asSha256DigestV1("a".repeat(64)),
  buildFeatures: ["gdscript", "headless"],
  renderer: "gl_compatibility",
};

const adapterFiles = [
  { relativePath: "manifest.json", bytes: Buffer.from("{}\n") },
  {
    relativePath: "src/adapter.gd",
    bytes: Buffer.from("extends ChronoRiftProjectAdapterV1\n"),
  },
];

describe("managed Godot Project Environment runtime preflight", () => {
  it("builds V1 runtime identities from only the Godot receipt and adapter", () => {
    const result = preflightManagedGodotProjectEnvironmentRuntimeV1({
      godotReceipt,
      adapterFiles,
    });

    expect(result.capability).toMatchObject({
      engineVersion: "4.7.1-stable (official)",
      protocolProfile: "chronorift-godot-project-environment-v1",
    });
    expect(result.binding.managedRuntimeId).toBe(
      result.capability.managedRuntimeId,
    );
    expect(result.vanillaSidecarSource).not.toBe(
      result.projectEnvironmentSidecarSource,
    );
    expect(result.sdkDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.bridgeDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.sdkDigest).not.toBe(result.bridgeDigest);
    expect(result.capability).not.toHaveProperty("toolchain");
    expect(result.capability).not.toHaveProperty("godotTarget");
    expect(result.capability).not.toHaveProperty("fontconfigTarget");
  });

  it("builds the matching minimal V2 runtime identities", () => {
    const result = preflightManagedGodotProjectEnvironmentRuntimeV2({
      godotReceipt,
      adapterFiles,
    });

    expect(result.capability).toMatchObject({
      schemaVersion: 2,
      engineVersion: "4.7.1-stable (official)",
      protocolProfile: "chronorift-godot-project-environment-v2",
      protocolVersion: 2,
    });
    expect(Object.keys(result.binding).sort()).toEqual(
      ["managedRuntimeId", "addonFiles", "adapterFiles", "overlayBytes"].sort(),
    );
    expect(result.sdkDigest).not.toBe(result.bridgeDigest);
  });

  it("rejects a Godot receipt outside the exact official 4.7.1 build", () => {
    expect(() =>
      preflightManagedGodotProjectEnvironmentRuntimeV1({
        godotReceipt: {
          ...godotReceipt,
          realizedVersionOutput: "4.7.2.stable.official.abcdef0",
        },
        adapterFiles,
      }),
    ).toThrow();
  });
});
