import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";

import { asSha256DigestV1, type JsonValue } from "@chronorift/domain";
import { contentHash } from "@chronorift/json-artifacts";

import {
  SandboxToolchainCapabilityV1Schema,
  SandboxToolchainTargetV1Schema,
  type SandboxToolchainCapabilityV1,
} from "./contracts.js";
import { M1Error } from "./errors.js";
import {
  assertTrustedHostExecutablePath,
  assertTrustedHostRuntimeFilePath,
} from "./sandbox-preflight.js";

export interface SandboxToolchainCommandBindingV1 {
  readonly target: string;
  readonly hostPath: string;
}

export interface SandboxToolchainFileBindingV1 {
  readonly target: string;
  readonly hostPath: string;
}

export interface SandboxToolchainBindingV1 {
  readonly toolchainId: string;
  readonly files: readonly SandboxToolchainFileBindingV1[];
}

interface InspectedToolchainFile {
  readonly target: string;
  readonly canonicalHostPath: string;
  readonly bytes: Uint8Array;
}

interface InspectedToolchainCommand extends InspectedToolchainFile {
  readonly dependencies: readonly InspectedToolchainFile[];
}

export interface SandboxToolchainInspectionPort {
  inspectCommand(
    command: SandboxToolchainCommandBindingV1,
  ): Promise<InspectedToolchainCommand>;
  inspectExecutableFile(
    file: SandboxToolchainCommandBindingV1,
  ): Promise<InspectedToolchainFile>;
}

const sha256 = (bytes: Uint8Array) =>
  asSha256DigestV1(createHash("sha256").update(bytes).digest("hex"));

const runLdd = (lddPath: string, executablePath: string): Promise<string> =>
  new Promise((resolveRun, rejectRun) => {
    execFile(
      lddPath,
      [executablePath],
      {
        encoding: "utf8",
        env: {
          HOME: "/nonexistent",
          LANG: "C",
          LC_ALL: "C",
          PATH: "/usr/bin:/bin",
        },
        maxBuffer: 1024 * 1024,
        shell: false,
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          rejectRun(
            new M1Error(
              "sandbox_preflight_failed",
              `toolchain dependency probe failed: ${stderr.trim()}`,
              error,
            ),
          );
          return;
        }
        resolveRun(stdout);
      },
    );
  });

const dependencyTargets = (lddOutput: string): readonly string[] => {
  if (lddOutput.includes("not found")) {
    throw new M1Error(
      "sandbox_preflight_failed",
      "toolchain dependency probe reported a missing library",
    );
  }
  const targets = new Set<string>();
  for (const line of lddOutput.split("\n")) {
    const match = line.match(/(?:=>\s+)?(\/[^\s(]+)/u);
    if (match?.[1] !== undefined) targets.add(match[1]);
  }
  if (targets.size === 0) {
    throw new M1Error(
      "sandbox_preflight_failed",
      "toolchain command exposed no dynamic runtime dependencies",
    );
  }
  return [...targets].sort();
};

class RealSandboxToolchainInspection implements SandboxToolchainInspectionPort {
  public constructor(private readonly lddPath: string) {}

  public async inspectCommand(
    command: SandboxToolchainCommandBindingV1,
  ): Promise<InspectedToolchainCommand> {
    const target = SandboxToolchainTargetV1Schema.parse(command.target);
    const canonicalHostPath = await assertTrustedHostExecutablePath(
      command.hostPath,
    );
    const output = await runLdd(this.lddPath, canonicalHostPath);
    const dependencies = await Promise.all(
      dependencyTargets(output).map(async (dependencyTarget) => {
        const canonicalDependencyPath = await realpath(dependencyTarget);
        await assertTrustedHostRuntimeFilePath(canonicalDependencyPath);
        return {
          target: SandboxToolchainTargetV1Schema.parse(dependencyTarget),
          canonicalHostPath: canonicalDependencyPath,
          bytes: await readFile(canonicalDependencyPath),
        };
      }),
    );
    return {
      target,
      canonicalHostPath,
      bytes: await readFile(canonicalHostPath),
      dependencies,
    };
  }

  public async inspectExecutableFile(
    file: SandboxToolchainCommandBindingV1,
  ): Promise<InspectedToolchainFile> {
    const target = SandboxToolchainTargetV1Schema.parse(file.target);
    const canonicalHostPath = await assertTrustedHostExecutablePath(
      file.hostPath,
    );
    return {
      target,
      canonicalHostPath,
      bytes: await readFile(canonicalHostPath),
    };
  }
}

export async function inspectSandboxToolchain(input: {
  readonly lddPath: string;
  readonly commands: readonly SandboxToolchainCommandBindingV1[];
  readonly dependencyAnchors?:
    readonly SandboxToolchainCommandBindingV1[] | undefined;
  readonly runtimeExecutableFiles?:
    readonly SandboxToolchainCommandBindingV1[] | undefined;
  readonly inspection?: SandboxToolchainInspectionPort | undefined;
}): Promise<{
  readonly capability: SandboxToolchainCapabilityV1;
  readonly binding: SandboxToolchainBindingV1;
}> {
  const dependencyAnchors = input.dependencyAnchors ?? [];
  const runtimeExecutableFiles = input.runtimeExecutableFiles ?? [];
  if (
    input.commands.length === 0 ||
    input.commands.length > 32 ||
    dependencyAnchors.length > 32 ||
    runtimeExecutableFiles.length > 32 ||
    input.commands.length +
      dependencyAnchors.length +
      runtimeExecutableFiles.length >
      64
  ) {
    throw new M1Error(
      "sandbox_preflight_failed",
      "toolchain executable declaration exceeds its frozen bounds",
    );
  }
  if (input.inspection === undefined) {
    await assertTrustedHostExecutablePath(input.lddPath);
  }
  const inspection =
    input.inspection ?? new RealSandboxToolchainInspection(input.lddPath);
  const inspectedCommands = await Promise.all(
    input.commands.map((command) => inspection.inspectCommand(command)),
  );
  const inspectedDependencyAnchors = await Promise.all(
    dependencyAnchors.map((command) => inspection.inspectCommand(command)),
  );
  const inspectedRuntimeFiles = await Promise.all(
    runtimeExecutableFiles.map((file) =>
      inspection.inspectExecutableFile(file),
    ),
  );
  const files = new Map<
    string,
    {
      readonly hostPath: string;
      readonly sha256: ReturnType<typeof sha256>;
      command: boolean;
    }
  >();
  const addFile = (file: InspectedToolchainFile, command: boolean): void => {
    const existing = files.get(file.target);
    const identity = sha256(file.bytes);
    if (
      existing !== undefined &&
      (existing.hostPath !== file.canonicalHostPath ||
        existing.sha256 !== identity)
    ) {
      throw new M1Error(
        "sandbox_preflight_failed",
        `toolchain target ${file.target} resolves to conflicting Host files`,
      );
    }
    files.set(file.target, {
      hostPath: file.canonicalHostPath,
      sha256: identity,
      command: command || existing?.command === true,
    });
  };
  for (const command of inspectedCommands) {
    addFile(command, true);
    for (const dependency of command.dependencies) addFile(dependency, false);
  }
  for (const command of inspectedDependencyAnchors) {
    for (const dependency of command.dependencies) addFile(dependency, false);
  }
  for (const file of inspectedRuntimeFiles) addFile(file, false);
  const ordered = [...files.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  );
  const capabilityFiles = ordered.map(([target, file]) => ({
    target,
    sha256: file.sha256,
    command: file.command,
  }));
  const content: JsonValue = {
    schemaVersion: 1,
    files: capabilityFiles,
  };
  const capability = SandboxToolchainCapabilityV1Schema.parse({
    ...content,
    toolchainId: `sandbox-toolchain:v1:${contentHash(content)}`,
  });
  const binding: SandboxToolchainBindingV1 = Object.freeze({
    toolchainId: capability.toolchainId,
    files: Object.freeze(
      ordered.map(([target, file]) =>
        Object.freeze({ target, hostPath: file.hostPath }),
      ),
    ),
  });
  return { capability: Object.freeze(capability), binding };
}
