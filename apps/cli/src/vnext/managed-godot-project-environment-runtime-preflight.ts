import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { asSha256DigestV1, type Sha256DigestV1 } from "@chronorift/domain";
import {
  DEFAULT_PROJECT_ENVIRONMENT_SIDECAR_TARGETS_V1,
  PROJECT_ADAPTER_SDK_FILES_V1,
  PROJECT_ENVIRONMENT_BRIDGE_FILES_V1,
  createProjectEnvironmentRuntimeSidecarSource,
  createProjectEnvironmentVanillaSmokeSidecarSource,
} from "@chronorift/godot-adapter";

import {
  createManagedGodotProjectEnvironmentRuntimeV1,
  type ManagedGodotProjectEnvironmentRuntimeBindingV1,
  type ManagedGodotProjectEnvironmentRuntimeCapabilityV1,
} from "./managed-godot-project-environment-runtime.js";
import type {
  ProjectEnvironmentHostConfigV1,
  ProjectEnvironmentToolchainBindingV1,
  ProjectEnvironmentToolchainReceiptV1,
} from "./project-environment-host-config.js";
import {
  inspectSandboxToolchain,
  type SandboxToolchainInspectionPort,
} from "./sandbox-toolchain.js";

const execFileAsync = promisify(execFile);
const roleDigest = (
  files: readonly {
    readonly relativePath: string;
    readonly bytes: Uint8Array;
  }[],
): Sha256DigestV1 => {
  const hash = createHash("sha256");
  for (const file of [...files].sort((a, b) =>
    a.relativePath.localeCompare(b.relativePath),
  )) {
    hash.update(file.relativePath).update("\0").update(file.bytes).update("\0");
  }
  return asSha256DigestV1(hash.digest("hex"));
};

export interface ManagedGodotProjectEnvironmentRuntimePreflightResultV1 {
  readonly capability: ManagedGodotProjectEnvironmentRuntimeCapabilityV1;
  readonly binding: ManagedGodotProjectEnvironmentRuntimeBindingV1;
  readonly vanillaSidecarSource: string;
  readonly projectEnvironmentSidecarSource: string;
  readonly sdkDigest: Sha256DigestV1;
  readonly bridgeDigest: Sha256DigestV1;
}

export async function preflightManagedGodotProjectEnvironmentRuntimeV1(input: {
  readonly hostConfig: ProjectEnvironmentHostConfigV1;
  readonly godot: {
    readonly receipt: ProjectEnvironmentToolchainReceiptV1;
    readonly binding: ProjectEnvironmentToolchainBindingV1;
  };
  readonly adapterFiles: readonly {
    readonly relativePath: string;
    readonly bytes: Uint8Array;
  }[];
  readonly toolchainInspection?: SandboxToolchainInspectionPort | undefined;
  readonly probeNodeVersion?: ((path: string) => Promise<string>) | undefined;
}): Promise<ManagedGodotProjectEnvironmentRuntimePreflightResultV1> {
  const probeNodeVersion =
    input.probeNodeVersion ??
    (async (path: string) =>
      (
        await execFileAsync(path, ["--version"], {
          encoding: "utf8",
          env: { HOME: "/nonexistent", LANG: "C", LC_ALL: "C" },
          maxBuffer: 4_096,
          timeout: 10_000,
        })
      ).stdout);
  if (
    (await probeNodeVersion(input.hostConfig.nodePath)).trim() !== "v22.23.1"
  ) {
    throw new Error("Project Environment runtime requires exact Node v22.23.1");
  }
  const toolchain = await inspectSandboxToolchain({
    lddPath: input.hostConfig.lddPath,
    commands: [
      {
        target: DEFAULT_PROJECT_ENVIRONMENT_SIDECAR_TARGETS_V1.nodeExecutable,
        hostPath: input.hostConfig.nodePath,
      },
      {
        target: DEFAULT_PROJECT_ENVIRONMENT_SIDECAR_TARGETS_V1.godotExecutable,
        hostPath: input.godot.binding.executablePath,
      },
    ],
    dependencyAnchors: [
      {
        target:
          DEFAULT_PROJECT_ENVIRONMENT_SIDECAR_TARGETS_V1.fontconfigProbeExecutable,
        hostPath: input.hostConfig.fontconfigProbePath,
      },
    ],
    runtimeExecutableFiles: [
      {
        target: DEFAULT_PROJECT_ENVIRONMENT_SIDECAR_TARGETS_V1.shellExecutable,
        hostPath: input.hostConfig.busyboxPath,
      },
      {
        target:
          DEFAULT_PROJECT_ENVIRONMENT_SIDECAR_TARGETS_V1.xdgUserDirExecutable,
        hostPath: input.hostConfig.xdgUserDirPath,
      },
    ],
    ...(input.toolchainInspection === undefined
      ? {}
      : { inspection: input.toolchainInspection }),
  });
  const sourceOptions = {
    godotExecutable:
      DEFAULT_PROJECT_ENVIRONMENT_SIDECAR_TARGETS_V1.godotExecutable,
    workspaceRoot: DEFAULT_PROJECT_ENVIRONMENT_SIDECAR_TARGETS_V1.workspaceRoot,
    runtimeRoot: DEFAULT_PROJECT_ENVIRONMENT_SIDECAR_TARGETS_V1.runtimeRoot,
  };
  const vanillaSidecarSource =
    createProjectEnvironmentVanillaSmokeSidecarSource(sourceOptions);
  const projectEnvironmentSidecarSource =
    createProjectEnvironmentRuntimeSidecarSource(sourceOptions);
  const runtime = createManagedGodotProjectEnvironmentRuntimeV1({
    doctorVersion: input.godot.receipt.realizedVersionOutput,
    nodeTarget: DEFAULT_PROJECT_ENVIRONMENT_SIDECAR_TARGETS_V1.nodeExecutable,
    godotTarget: DEFAULT_PROJECT_ENVIRONMENT_SIDECAR_TARGETS_V1.godotExecutable,
    toolchain,
    vanillaSidecarSource,
    projectEnvironmentSidecarSource,
    adapterFiles: input.adapterFiles,
  });
  return Object.freeze({
    ...runtime,
    vanillaSidecarSource,
    projectEnvironmentSidecarSource,
    sdkDigest: roleDigest(PROJECT_ADAPTER_SDK_FILES_V1),
    bridgeDigest: roleDigest(PROJECT_ENVIRONMENT_BRIDGE_FILES_V1),
  });
}
