import type {
  RealizedResourceLimitsV1,
  SandboxExecutionRequestV1,
} from "./contracts.js";

export const SANDBOX_FDS = {
  block: 3,
  status: 4,
  workspace: 5,
  temporary: 6,
  artifacts: 7,
  runtimeStart: 8,
} as const;

export interface SandboxRuntimeTarget {
  readonly fd: number;
  readonly target: string;
}

export interface SandboxProcessPlan {
  readonly executable: string;
  readonly args: readonly string[];
  readonly inheritedFds: readonly number[];
}

export interface BuildSandboxProcessPlanInput {
  readonly request: SandboxExecutionRequestV1;
  readonly limits: RealizedResourceLimitsV1;
  readonly binaries: {
    readonly prlimit: string;
    readonly bwrap: string;
  };
  readonly runtimeTargets: readonly SandboxRuntimeTarget[];
  readonly unshareCgroupNamespace: boolean;
}

const assertRuntimeTargets = (
  targets: readonly SandboxRuntimeTarget[],
): void => {
  const seenFds = new Set<number>();
  const seenTargets = new Set<string>();
  for (const [index, target] of targets.entries()) {
    if (
      !Number.isInteger(target.fd) ||
      target.fd !== SANDBOX_FDS.runtimeStart + index
    ) {
      throw new TypeError("runtime descriptors must be contiguous from fd 8");
    }
    if (
      !target.target.startsWith("/") ||
      target.target.includes("\0") ||
      target.target.split("/").some((part) => part === "..")
    ) {
      throw new TypeError("runtime targets must be safe absolute paths");
    }
    if (seenFds.has(target.fd) || seenTargets.has(target.target)) {
      throw new TypeError("runtime descriptors and targets must be unique");
    }
    seenFds.add(target.fd);
    seenTargets.add(target.target);
  }
};

export const buildSandboxProcessPlan = (
  input: BuildSandboxProcessPlanInput,
): SandboxProcessPlan => {
  assertRuntimeTargets(input.runtimeTargets);

  const bwrapArgs: string[] = [
    input.binaries.bwrap,
    "--unshare-user",
    "--uid",
    "0",
    "--gid",
    "0",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--unshare-net",
  ];
  if (input.unshareCgroupNamespace) bwrapArgs.push("--unshare-cgroup");
  bwrapArgs.push(
    "--die-with-parent",
    "--new-session",
    "--hostname",
    "chronorift",
    "--cap-drop",
    "ALL",
    "--clearenv",
    "--setenv",
    "HOME",
    "/tmp/home",
    "--setenv",
    "TMPDIR",
    "/tmp",
    "--setenv",
    "PATH",
    "/bin",
    "--setenv",
    "LANG",
    "C.UTF-8",
    "--setenv",
    "LC_ALL",
    "C.UTF-8",
  );
  for (const key of ["CI", "NO_COLOR"] as const) {
    const value = input.request.environment[key];
    if (value !== undefined) bwrapArgs.push("--setenv", key, value);
  }
  bwrapArgs.push(
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--dir",
    "/bin",
    "--dir",
    "/workspace",
    "--dir",
    "/tmp",
    "--dir",
    "/artifacts",
    "--bind-fd",
    String(SANDBOX_FDS.workspace),
    "/workspace",
    "--bind-fd",
    String(SANDBOX_FDS.temporary),
    "/tmp",
    "--bind-fd",
    String(SANDBOX_FDS.artifacts),
    "/artifacts",
  );
  for (const target of input.runtimeTargets) {
    bwrapArgs.push("--ro-bind-fd", String(target.fd), target.target);
  }
  bwrapArgs.push(
    "--dir",
    "/tmp/home",
    "--chdir",
    input.request.cwd,
    "--block-fd",
    String(SANDBOX_FDS.block),
    "--json-status-fd",
    String(SANDBOX_FDS.status),
    "--",
    ...input.request.argv,
  );

  return {
    executable: input.binaries.prlimit,
    args: [
      `--nofile=${input.limits.nofile}:${input.limits.nofile}`,
      `--fsize=${input.limits.fileSizeMaxBytes}:${input.limits.fileSizeMaxBytes}`,
      "--core=0:0",
      "--",
      ...bwrapArgs,
    ],
    inheritedFds: [
      SANDBOX_FDS.block,
      SANDBOX_FDS.status,
      SANDBOX_FDS.workspace,
      SANDBOX_FDS.temporary,
      SANDBOX_FDS.artifacts,
      ...input.runtimeTargets.map(({ fd }) => fd),
    ],
  };
};
