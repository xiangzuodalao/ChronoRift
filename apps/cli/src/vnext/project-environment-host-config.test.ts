import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { asSha256DigestV1 } from "@chronorift/domain";

import {
  ProjectEnvironmentHostConfigV1Schema,
  readProjectEnvironmentHostConfigV1,
  resolveProjectEnvironmentGodotToolchainV1,
  type ProjectEnvironmentHostConfigV1,
} from "./project-environment-host-config.js";

const roots: string[] = [];

const makeRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "chronorift-pe-host-config-"));
  roots.push(root);
  return root;
};

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const config = (root: string): ProjectEnvironmentHostConfigV1 =>
  ProjectEnvironmentHostConfigV1Schema.parse({
    schemaVersion: 1,
    configKind: "chronorift-project-environment-host",
    taskStorageRoot: join(root, "task-storage"),
    runtimeRoot: join(root, "task-storage", "runtime"),
    delegatedCgroupRoot: join(root, "cgroup"),
    bwrapPath: "/usr/bin/bwrap",
    prlimitPath: "/usr/bin/prlimit",
    busyboxPath: "/usr/bin/busybox",
    fontconfigProbePath: "/usr/bin/fc-match",
    xdgUserDirPath: "/usr/bin/xdg-user-dir",
    nodePath: "/usr/bin/node",
    bashPath: "/usr/bin/bash",
    rgPath: "/usr/bin/rg",
    findPath: "/usr/bin/find",
    lsPath: "/usr/bin/ls",
    lddPath: "/usr/bin/ldd",
    godotToolchains: [
      {
        schemaVersion: 1,
        key: "godot-4.7.1-linux-x86_64-official",
        version: "4.7.1",
        platform: "linux-x86_64",
        channel: "stable-official",
        executablePath: "/opt/godot/godot-4.7.1",
        executableSha256: "a".repeat(64),
        buildFeatures: ["official", "stable"],
        renderer: "gl_compatibility",
      },
    ],
  });

describe("Project Environment Host config", () => {
  it("strictly reads a bounded canonical config file", async () => {
    const root = await makeRoot();
    await Promise.all([
      mkdir(join(root, "task-storage", "runtime"), { recursive: true }),
      mkdir(join(root, "cgroup")),
    ]);
    const path = join(root, "host.json");
    await writeFile(path, `${JSON.stringify(config(root))}\n`);

    await expect(readProjectEnvironmentHostConfigV1(path)).resolves.toEqual(
      config(root),
    );

    const link = join(root, "host-link.json");
    await symlink(path, link);
    await expect(readProjectEnvironmentHostConfigV1(link)).rejects.toThrow(
      /canonical/u,
    );
  });

  it("rejects unknown config fields", async () => {
    const root = await makeRoot();
    const path = join(root, "host.json");
    await writeFile(
      path,
      JSON.stringify({ ...config(root), credential: "must-not-be-accepted" }),
    );

    await expect(readProjectEnvironmentHostConfigV1(path)).rejects.toThrow(
      /invalid/u,
    );
  });

  it("binds only the exact official 4.7.1 registry executable", async () => {
    const root = await makeRoot();
    const parsed = config(root);
    const receipt = await resolveProjectEnvironmentGodotToolchainV1(
      parsed,
      "4.7.1",
      {
        trustExecutable: async (path) => path,
        sha256File: async () => asSha256DigestV1("a".repeat(64)),
        probeVersion: async () => "4.7.1.stable.official.abcdef0\n",
      },
    );

    expect(receipt.receipt).toMatchObject({
      requestedVersion: "4.7.1",
      realizedVersion: "4.7.1",
      executableSha256: "a".repeat(64),
    });
    expect(receipt.binding).toEqual({
      executablePath: "/opt/godot/godot-4.7.1",
    });

    await expect(
      resolveProjectEnvironmentGodotToolchainV1(parsed, "4.7.2", {
        trustExecutable: async (path) => path,
        sha256File: async () => asSha256DigestV1("a".repeat(64)),
        probeVersion: async () => "4.7.2.stable.official.abcdef0\n",
      }),
    ).rejects.toThrow(/only exact Godot 4\.7\.1/u);
  });

  it("fails closed on executable hash or build drift", async () => {
    const root = await makeRoot();
    const parsed = config(root);
    await expect(
      resolveProjectEnvironmentGodotToolchainV1(parsed, "4.7.1", {
        trustExecutable: async (path) => path,
        sha256File: async () => asSha256DigestV1("b".repeat(64)),
        probeVersion: async () => "4.7.1.stable.official.abcdef0\n",
      }),
    ).rejects.toThrow(/content hash/u);
    await expect(
      resolveProjectEnvironmentGodotToolchainV1(parsed, "4.7.1", {
        trustExecutable: async (path) => path,
        sha256File: async () => asSha256DigestV1("a".repeat(64)),
        probeVersion: async () => "4.7.1.custom_build\n",
      }),
    ).rejects.toThrow(/official Godot 4\.7\.1/u);
  });
});
