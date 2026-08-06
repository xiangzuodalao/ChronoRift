import { describe, expect, it } from "vitest";

import type {
  RealizedResourceLimitsV1,
  SandboxExecutionRequestV1,
} from "./contracts.js";
import { SANDBOX_FDS, buildSandboxProcessPlan } from "./bubblewrap-command.js";

const codingLimits: RealizedResourceLimitsV1 = {
  cpuMax: "200000 100000",
  memoryMaxBytes: 2_147_483_648,
  memorySwapMaxBytes: 0,
  pidsMax: 128,
  nofile: 1024,
  fileSizeMaxBytes: 536_870_912,
  stdoutMaxBytes: 16_777_216,
  stderrMaxBytes: 16_777_216,
  timeoutMs: 120_000,
};

const request: SandboxExecutionRequestV1 = {
  schemaVersion: 1,
  operationId: "operation_1",
  profile: "coding-default",
  argv: [
    "/bin/busybox",
    "sh",
    "-c",
    "touch /workspace/x; echo $HOME `id` $(id)",
  ],
  cwd: "/workspace",
  environment: { CI: "1", NO_COLOR: "true" },
};

describe("buildSandboxProcessPlan", () => {
  it("keeps adversarial shell text in one unchanged argv element", () => {
    const plan = buildSandboxProcessPlan({
      request,
      limits: codingLimits,
      binaries: { prlimit: "/usr/bin/prlimit", bwrap: "/usr/bin/bwrap" },
      runtimeTargets: [{ fd: 8, target: "/bin/busybox" }],
      unshareCgroupNamespace: true,
    });

    expect(plan.executable).toBe("/usr/bin/prlimit");
    expect(plan.args.at(-1)).toBe(request.argv.at(-1));
    expect(plan.args).toContain("--clearenv");
    expect(plan.args).toContain("--unshare-cgroup");
    expect(plan.args.join("\0")).not.toContain("--ro-bind\0/\0/");
    expect(plan.inheritedFds).toEqual([3, 4, 5, 6, 7, 8]);
    expect(SANDBOX_FDS).toEqual({
      block: 3,
      status: 4,
      workspace: 5,
      temporary: 6,
      artifacts: 7,
      runtimeStart: 8,
    });
  });

  it("freezes namespace, mount, environment, and resource arguments", () => {
    const plan = buildSandboxProcessPlan({
      request,
      limits: { ...codingLimits, fileSizeMaxBytes: 1_073_741_824 },
      binaries: { prlimit: "/prlimit", bwrap: "/bwrap" },
      runtimeTargets: [{ fd: 8, target: "/bin/busybox" }],
      unshareCgroupNamespace: false,
    });

    expect(plan.args.slice(0, 5)).toEqual([
      "--nofile=1024:1024",
      "--fsize=1073741824:1073741824",
      "--core=0:0",
      "--",
      "/bwrap",
    ]);
    expect(plan.args).not.toContain("--unshare-cgroup");
    expect(plan.args).toEqual(
      expect.arrayContaining([
        "--unshare-user",
        "--unshare-pid",
        "--unshare-ipc",
        "--unshare-uts",
        "--unshare-net",
        "--bind-fd",
        "--ro-bind-fd",
        "--block-fd",
        "--json-status-fd",
      ]),
    );
    const joined = plan.args.join("\0");
    expect(plan.args).not.toContain("/home");
    expect(joined).not.toContain("/sys");
    expect(joined).not.toContain("--share-net");
    expect(joined).toContain(["--setenv", "CI", "1"].join("\0"));
    expect(joined).toContain("--setenv\0NO_COLOR\0true");
  });

  it("rejects duplicate or reserved runtime descriptors", () => {
    const base = {
      request,
      limits: codingLimits,
      binaries: { prlimit: "/prlimit", bwrap: "/bwrap" },
      unshareCgroupNamespace: true,
    } as const;

    expect(() =>
      buildSandboxProcessPlan({
        ...base,
        runtimeTargets: [{ fd: 7, target: "/bin/busybox" }],
      }),
    ).toThrow();
    expect(() =>
      buildSandboxProcessPlan({
        ...base,
        runtimeTargets: [
          { fd: 8, target: "/bin/busybox" },
          { fd: 8, target: "/bin/other" },
        ],
      }),
    ).toThrow();
  });
});
