import { describe, expect, it } from "vitest";

import { SandboxToolchainCapabilityV1Schema } from "./contracts.js";
import {
  inspectSandboxToolchain,
  type SandboxToolchainInspectionPort,
} from "./sandbox-toolchain.js";

const inspection = (conflicting = false): SandboxToolchainInspectionPort => ({
  inspectCommand: async (command) => ({
    target: command.target,
    canonicalHostPath: command.hostPath,
    bytes: Buffer.from(command.target),
    dependencies: [
      {
        target: "/lib64/ld-linux-x86-64.so.2",
        canonicalHostPath: conflicting
          ? `${command.hostPath}.loader`
          : "/usr/lib/ld-linux-x86-64.so.2",
        bytes: Buffer.from(
          conflicting ? command.hostPath : "shared-loader-bytes",
        ),
      },
    ],
  }),
});

describe("sandbox toolchain manifest", () => {
  it("separates hashed sandbox capability from physical Host binding", async () => {
    const result = await inspectSandboxToolchain({
      lddPath: "/unused/ldd",
      commands: [
        { target: "/usr/bin/rg", hostPath: "/host/bin/rg" },
        { target: "/bin/bash", hostPath: "/host/bin/bash" },
      ],
      inspection: inspection(),
    });

    expect(result.capability.files.map((file) => file.target)).toEqual([
      "/bin/bash",
      "/lib64/ld-linux-x86-64.so.2",
      "/usr/bin/rg",
    ]);
    expect(result.capability.files.filter((file) => file.command)).toHaveLength(
      2,
    );
    expect(JSON.stringify(result.capability)).not.toContain("/host/");
    expect(result.binding.toolchainId).toBe(result.capability.toolchainId);
    expect(result.binding.files).toContainEqual({
      target: "/bin/bash",
      hostPath: "/host/bin/bash",
    });
  });

  it("rejects conflicting targets and tampered capability identities", async () => {
    await expect(
      inspectSandboxToolchain({
        lddPath: "/unused/ldd",
        commands: [
          { target: "/bin/bash", hostPath: "/host/bin/bash" },
          { target: "/usr/bin/rg", hostPath: "/host/bin/rg" },
        ],
        inspection: inspection(true),
      }),
    ).rejects.toThrow(/conflicting Host files/u);

    const valid = await inspectSandboxToolchain({
      lddPath: "/unused/ldd",
      commands: [{ target: "/bin/bash", hostPath: "/host/bin/bash" }],
      inspection: inspection(),
    });
    expect(() =>
      SandboxToolchainCapabilityV1Schema.parse({
        ...valid.capability,
        files: valid.capability.files.map((file, index) =>
          index === 0 ? { ...file, command: !file.command } : file,
        ),
      }),
    ).toThrow(/toolchainId/u);
  });

  it("rejects writable and non-normalized sandbox targets", async () => {
    for (const target of ["/workspace/tool", "/usr/../bin/tool", "relative"]) {
      await expect(
        inspectSandboxToolchain({
          lddPath: "/unused/ldd",
          commands: [{ target, hostPath: "/host/bin/tool" }],
          inspection: inspection(),
        }),
      ).rejects.toThrow();
    }
  });
});
