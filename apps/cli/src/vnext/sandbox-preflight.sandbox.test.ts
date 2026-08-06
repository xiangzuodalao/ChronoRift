import { describe, expect, it } from "vitest";

import { preflightSandboxHost } from "./sandbox-preflight.js";

describe("real M1 sandbox preflight", () => {
  it("proves the active block/status/cgroup/namespace boundary", async () => {
    const delegatedCgroupRoot = process.env.CHRONORIFT_TEST_CGROUP_ROOT;
    if (delegatedCgroupRoot === undefined || delegatedCgroupRoot === "") {
      throw new Error(
        "CHRONORIFT_TEST_CGROUP_ROOT is required for sandbox conformance",
      );
    }
    const result = await preflightSandboxHost({
      delegatedCgroupRoot,
      bwrapPath: "/usr/bin/bwrap",
      prlimitPath: "/usr/bin/prlimit",
      busyboxPath: "/usr/bin/busybox",
    });
    expect(result).toMatchObject({
      kind: "supported",
      capability: {
        cgroupNamespaceUnshared: true,
        controllers: ["cpu", "memory", "pids"],
      },
    });
  });
});
