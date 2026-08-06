import { dirname, join } from "node:path";

import { asTaskId } from "@chronorift/domain";
import { describe, expect, it } from "vitest";

import {
  CgroupV2Controller,
  type CgroupFsPort,
  type CgroupRootIdentity,
} from "./cgroup-v2.js";

class FakeCgroupFs implements CgroupFsPort {
  readonly files = new Map<string, string>();
  readonly directories = new Set<string>();
  readonly writes: Array<readonly [string, string]> = [];

  public constructor(
    readonly root = "/delegated",
    options: {
      readonly controllers?: string;
      readonly subtreeControl?: string;
      readonly procs?: string;
    } = {},
  ) {
    this.directories.add(root);
    this.seed(root, options);
  }

  public rootIdentity(path: string): Promise<CgroupRootIdentity> {
    if (path !== this.root) throw new Error("unexpected root");
    return Promise.resolve({ canonicalPath: path, device: 1n, inode: 2n });
  }

  public readText(path: string): Promise<string> {
    const value = this.files.get(path);
    if (value === undefined)
      return Promise.reject(new Error(`missing ${path}`));
    return Promise.resolve(value);
  }

  public writeText(path: string, value: string): Promise<void> {
    if (!this.directories.has(dirname(path))) {
      return Promise.reject(new Error(`missing parent ${path}`));
    }
    this.writes.push([path, value]);
    this.files.set(path, value);
    if (path.endsWith("/cgroup.kill") && value === "1\n") {
      const scope = dirname(path);
      this.files.set(join(scope, "cgroup.procs"), "");
      this.files.set(join(scope, "cgroup.events"), "populated 0\n");
    }
    if (path.endsWith("/cgroup.procs") && value.trim() !== "") {
      const scope = dirname(path);
      this.files.set(path, value);
      this.files.set(join(scope, "cgroup.events"), "populated 1\n");
    }
    return Promise.resolve();
  }

  public createDirectory(path: string): Promise<void> {
    if (this.directories.has(path)) return Promise.reject(new Error("exists"));
    this.directories.add(path);
    this.seed(path);
    return Promise.resolve();
  }

  public removeDirectory(path: string): Promise<void> {
    if (!this.directories.delete(path))
      return Promise.reject(new Error("missing"));
    for (const key of [...this.files.keys()]) {
      if (dirname(key) === path) this.files.delete(key);
    }
    return Promise.resolve();
  }

  public pathExists(path: string): Promise<boolean> {
    return Promise.resolve(this.files.has(path) || this.directories.has(path));
  }

  public childDirectories(path: string): Promise<readonly string[]> {
    const prefix = `${path}/`;
    return Promise.resolve(
      [...this.directories]
        .filter((directory) => directory.startsWith(prefix))
        .map((directory) => directory.slice(prefix.length))
        .filter((directory) => !directory.includes("/")),
    );
  }

  private seed(
    path: string,
    options: {
      readonly controllers?: string;
      readonly subtreeControl?: string;
      readonly procs?: string;
    } = {},
  ): void {
    this.files.set(join(path, "cgroup.type"), "domain\n");
    this.files.set(
      join(path, "cgroup.controllers"),
      options.controllers ?? "cpu memory pids\n",
    );
    this.files.set(
      join(path, "cgroup.subtree_control"),
      options.subtreeControl ?? "cpu memory pids\n",
    );
    this.files.set(join(path, "cgroup.procs"), options.procs ?? "");
    this.files.set(join(path, "cgroup.events"), "populated 0\n");
    this.files.set(join(path, "cgroup.kill"), "");
    this.files.set(join(path, "cpu.stat"), "usage_usec 7\n");
    this.files.set(join(path, "memory.peak"), "11\n");
    this.files.set(join(path, "pids.peak"), "2\n");
  }
}

const limits = {
  cpuMax: "200000 100000",
  memoryMaxBytes: 2_147_483_648,
  memorySwapMaxBytes: 0,
  pidsMax: 128,
} as const;

describe("CgroupV2Controller", () => {
  it("rejects a root with processes or missing cpu delegation", async () => {
    const fs = new FakeCgroupFs("/delegated", {
      controllers: "memory pids\n",
      subtreeControl: "memory pids\n",
      procs: "42\n",
    });

    await expect(
      CgroupV2Controller.preflight("/delegated", fs),
    ).rejects.toMatchObject({
      code: "resource_limit_unavailable",
    });
  });

  it("writes and verifies every mandatory limit before attach", async () => {
    const fs = new FakeCgroupFs();
    const controller = await CgroupV2Controller.create(
      "/delegated",
      asTaskId("task_1"),
      fs,
    );
    const scope = await controller.createExecutionScope("operation_1", limits);
    await scope.attach(1234);
    const taskSegment = [...fs.directories]
      .find((path) => path.includes("/task-"))
      ?.split("/")
      .at(-1);
    if (taskSegment === undefined) throw new Error("missing task cgroup");
    await scope.verifyAttached(
      `/host/system.slice/unit/${taskSegment}/${scope.scopeIdentity}`,
    );

    const attachIndex = fs.writes.findIndex(([path]) =>
      path.endsWith("/cgroup.procs"),
    );
    expect(attachIndex).toBeGreaterThan(3);
    expect(
      fs.writes
        .slice(0, attachIndex)
        .map(([path, value]) => [path.split("/").at(-1), value]),
    ).toEqual(
      expect.arrayContaining([
        ["cpu.max", "200000 100000\n"],
        ["memory.max", "2147483648\n"],
        ["memory.swap.max", "0\n"],
        ["pids.max", "128\n"],
      ]),
    );
    await expect(scope.usage()).resolves.toEqual({
      cpuUsageUsec: 7,
      memoryPeakBytes: 11,
      pidsPeak: 2,
    });
  });

  it("rejects a self-reported path outside the execution cgroup", async () => {
    const fs = new FakeCgroupFs();
    const controller = await CgroupV2Controller.create(
      "/delegated",
      asTaskId("task_pid_namespace"),
      fs,
    );
    const scope = await controller.createExecutionScope(
      "operation_pid",
      limits,
    );
    await scope.attach(1234);
    await expect(
      scope.verifyAttached(`/wrong/${scope.scopeIdentity}`),
    ).rejects.toMatchObject({ code: "resource_limit_unavailable" });
  });

  it("uses atomic cgroup.kill and refuses removal while populated", async () => {
    const fs = new FakeCgroupFs();
    const controller = await CgroupV2Controller.create(
      "/delegated",
      asTaskId("task_2"),
      fs,
    );
    const scope = await controller.createExecutionScope("operation_2", limits);
    await scope.attach(55);

    await expect(scope.remove()).rejects.toThrow(/populated/u);
    await expect(scope.kill()).resolves.toBe(true);
    expect(
      fs.writes.some(
        ([path, value]) => path.endsWith("cgroup.kill") && value === "1\n",
      ),
    ).toBe(true);
    await expect(scope.remove()).resolves.toBeUndefined();
    await expect(controller.cleanup()).resolves.toBeUndefined();
  });
});
