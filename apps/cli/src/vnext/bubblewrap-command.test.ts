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
      runtimeScratch: 8,
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
    expect(joined).toContain("--dev\0/dev\0--remount-ro\0/dev");
    expect(joined).toContain("--remount-ro\0/\0--chdir\0/workspace");
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

  it("creates only the parent directories required by exact runtime files", () => {
    const plan = buildSandboxProcessPlan({
      request,
      limits: codingLimits,
      binaries: { prlimit: "/prlimit", bwrap: "/bwrap" },
      runtimeTargets: [
        { fd: 8, target: "/bin/busybox" },
        { fd: 9, target: "/usr/bin/rg" },
        { fd: 10, target: "/lib/x86_64-linux-gnu/libc.so.6" },
      ],
      unshareCgroupNamespace: true,
    });
    const joined = plan.args.join("\0");
    expect(joined).toContain("--dir\0/usr");
    expect(joined).toContain("--dir\0/lib");
    expect(joined).toContain("--dir\0/usr/bin");
    expect(joined).toContain("--dir\0/lib/x86_64-linux-gnu");
    expect(joined).not.toContain("--ro-bind\0/usr\0/usr");
  });

  it("binds a bounded per-operation staging root only for Godot executions", () => {
    const coding = buildSandboxProcessPlan({
      request,
      limits: codingLimits,
      binaries: { prlimit: "/prlimit", bwrap: "/bwrap" },
      runtimeTargets: [{ fd: 8, target: "/bin/busybox" }],
      unshareCgroupNamespace: true,
    });
    const godot = buildSandboxProcessPlan({
      request: { ...request, profile: "godot-headless" },
      limits: { ...codingLimits, fileSizeMaxBytes: 1_073_741_824 },
      binaries: { prlimit: "/prlimit", bwrap: "/bwrap" },
      runtimeScratch: { fd: 8, target: "/run/chronorift" },
      runtimeTargets: [{ fd: 9, target: "/bin/busybox" }],
      unshareCgroupNamespace: true,
    });

    expect(coding.args.join("\0")).not.toContain("/run/chronorift");
    expect(coding.args.join("\0")).toContain(
      ["--bind-fd", "5", "/workspace"].join("\0"),
    );
    expect(coding.args.join("\0")).not.toContain(
      ["--ro-bind-fd", "5", "/workspace"].join("\0"),
    );
    expect(godot.args.join("\0")).toContain(
      ["--dir", "/run", "--bind-fd", "8", "/run/chronorift"].join("\0"),
    );
    expect(godot.args).not.toContain("--tmpfs");
    expect(godot.inheritedFds).toEqual([3, 4, 5, 6, 7, 8, 9]);
    expect(godot.args.join("\0")).toContain(
      ["--ro-bind-fd", "5", "/workspace"].join("\0"),
    );
    expect(godot.args.join("\0")).not.toContain(
      ["--bind-fd", "5", "/workspace"].join("\0"),
    );
  });

  it("mounts both the managed addon parent guard and exact addon directory read-only", () => {
    const addonParentTarget = "/run/chronorift/project/addons";
    const addonTarget = "/run/chronorift/project/addons/chronorift";
    const plan = buildSandboxProcessPlan({
      request: { ...request, profile: "godot-headless" },
      limits: codingLimits,
      binaries: { prlimit: "/prlimit", bwrap: "/bwrap" },
      runtimeScratch: { fd: 8, target: "/run/chronorift" },
      runtimeTargets: [
        { fd: 9, target: "/bin/busybox" },
        { fd: 10, target: addonParentTarget },
        { fd: 11, target: addonTarget },
      ],
      unshareCgroupNamespace: true,
    });
    const joined = plan.args.join("\0");
    expect(joined).toContain("--dir\0/run/chronorift/project");
    expect(joined).toContain("--dir\0/run/chronorift/project/addons");
    expect(joined).toContain(
      ["--ro-bind-fd", "10", addonParentTarget].join("\0"),
    );
    expect(joined).toContain(["--ro-bind-fd", "11", addonTarget].join("\0"));
  });
});
