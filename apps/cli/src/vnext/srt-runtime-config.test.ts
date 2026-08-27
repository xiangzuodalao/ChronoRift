import {
  chmod,
  mkdtemp,
  mkdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { managedGodotBinary } from "@chronorift/godot-adapter";
import { asSha256DigestV1 } from "@chronorift/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  resolveSrtRuntimeConfig,
  type SrtRuntimeConfigDependencies,
} from "./srt-runtime-config.js";

describe("resolveSrtRuntimeConfig", () => {
  let root: string;
  let repositoryRoot: string;
  let homePath: string;
  let explicitGodot: string;
  let environmentGodot: string;
  let managedGodot: string;
  const digest = asSha256DigestV1("a".repeat(64));

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "chronorift-srt-config-"));
    repositoryRoot = join(root, "repository");
    homePath = join(root, "home");
    explicitGodot = join(root, "godot-explicit");
    environmentGodot = join(root, "godot-environment");
    managedGodot = managedGodotBinary(repositoryRoot);
    await Promise.all([
      mkdir(repositoryRoot, { recursive: true }),
      mkdir(homePath, { recursive: true }),
      mkdir(join(managedGodot, ".."), { recursive: true }),
    ]);
    for (const path of [explicitGodot, environmentGodot, managedGodot]) {
      await writeFile(path, "#!/bin/sh\nexit 0\n");
      await chmod(path, 0o755);
    }
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const dependencies = (
    overrides: Partial<SrtRuntimeConfigDependencies> = {},
  ): Partial<SrtRuntimeConfigDependencies> => ({
    platform: () => "linux",
    architecture: () => "x64",
    homeDirectory: () => homePath,
    probeGodotVersion: async () => "4.7.1.stable.official.a13da4feb\n",
    sha256File: async () => digest,
    ...overrides,
  });

  it("uses the documented state and Godot path precedence", async () => {
    const explicitState = join(root, "state-physical");
    const explicitStateLink = join(root, "state-link");
    const explicitGodotLink = join(root, "godot-link");
    const environmentState = join(root, "state-environment");
    const xdgState = join(root, "xdg-state");
    await mkdir(explicitState);
    await symlink(explicitState, explicitStateLink);
    await symlink(explicitGodot, explicitGodotLink);

    const explicit = await resolveSrtRuntimeConfig(
      {
        repositoryRoot,
        stateRoot: explicitStateLink,
        godotBin: explicitGodotLink,
        environment: {
          CHRONORIFT_STATE_ROOT: environmentState,
          XDG_STATE_HOME: xdgState,
          GODOT_BIN: environmentGodot,
        },
      },
      dependencies(),
    );
    expect(explicit.stateRoot).toBe(await realpath(explicitState));
    expect(explicit.godot.binding.executablePath).toBe(
      await realpath(explicitGodot),
    );

    const fromEnvironment = await resolveSrtRuntimeConfig(
      {
        repositoryRoot,
        environment: {
          CHRONORIFT_STATE_ROOT: environmentState,
          XDG_STATE_HOME: xdgState,
          GODOT_BIN: environmentGodot,
        },
      },
      dependencies(),
    );
    expect(fromEnvironment.stateRoot).toBe(await realpath(environmentState));
    expect(fromEnvironment.godot.binding.executablePath).toBe(
      await realpath(environmentGodot),
    );

    const fromXdg = await resolveSrtRuntimeConfig(
      {
        repositoryRoot,
        environment: { XDG_STATE_HOME: xdgState },
      },
      dependencies(),
    );
    expect(fromXdg.stateRoot).toBe(
      await realpath(join(xdgState, "chronorift")),
    );
    expect(fromXdg.godot.binding.executablePath).toBe(
      await realpath(managedGodot),
    );

    const fromHome = await resolveSrtRuntimeConfig(
      { repositoryRoot, environment: {} },
      dependencies(),
    );
    expect(fromHome.stateRoot).toBe(
      await realpath(join(homePath, ".local", "state", "chronorift")),
    );
  });

  it("returns canonical Node/Godot paths and the existing PE toolchain fields", async () => {
    const config = await resolveSrtRuntimeConfig(
      {
        repositoryRoot,
        stateRoot: join(root, "state"),
        godotBin: explicitGodot,
        environment: {},
      },
      dependencies(),
    );

    expect(config.nodePath).toBe(await realpath(process.execPath));
    expect(config.godot).toEqual({
      binding: { executablePath: await realpath(explicitGodot) },
      receipt: {
        schemaVersion: 1,
        registryKey: "godot-4.7.1-linux-x86_64-official",
        requestedVersion: "4.7.1",
        realizedVersion: "4.7.1",
        realizedVersionOutput: "4.7.1.stable.official.a13da4feb",
        platform: "linux-x86_64",
        executableSha256: digest,
        buildFeatures: ["gdscript", "headless"],
        renderer: "gl_compatibility",
      },
    });
  });

  it("rejects unsupported Hosts before preparing state", async () => {
    await expect(
      resolveSrtRuntimeConfig(
        { repositoryRoot, environment: {} },
        dependencies({ platform: () => "darwin" }),
      ),
    ).rejects.toThrow(/Linux only/u);
    await expect(
      resolveSrtRuntimeConfig(
        { repositoryRoot, environment: {} },
        dependencies({ architecture: () => "arm64" }),
      ),
    ).rejects.toThrow(/x86_64/u);
  });

  it("rejects a non-directory state root and a non-executable Godot file", async () => {
    const stateFile = join(root, "state-file");
    const nonExecutable = join(root, "godot-not-executable");
    await writeFile(stateFile, "not a directory");
    await writeFile(nonExecutable, "not executable");

    await expect(
      resolveSrtRuntimeConfig(
        {
          repositoryRoot,
          stateRoot: stateFile,
          godotBin: explicitGodot,
          environment: {},
        },
        dependencies(),
      ),
    ).rejects.toThrow();
    await expect(
      resolveSrtRuntimeConfig(
        {
          repositoryRoot,
          stateRoot: join(root, "state"),
          godotBin: nonExecutable,
          environment: {},
        },
        dependencies(),
      ),
    ).rejects.toThrow();
  });

  it("rejects non-official or non-exact Godot version output", async () => {
    for (const output of [
      "4.7.1.custom_build",
      "4.7.2.stable.official.a13da4feb",
      "4.7.1.stable.official.short",
    ]) {
      await expect(
        resolveSrtRuntimeConfig(
          {
            repositoryRoot,
            stateRoot: join(root, `state-${output.length}`),
            godotBin: explicitGodot,
            environment: {},
          },
          dependencies({ probeGodotVersion: async () => output }),
        ),
      ).rejects.toThrow(/exact official Godot 4\.7\.1/u);
    }
  });
});
