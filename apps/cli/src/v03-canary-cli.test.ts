import { describe, expect, it, vi } from "vitest";

import { main } from "./main.js";
import { buildLunaCanarySpec, parseLunaCanarySpec } from "./v03-canary.js";

describe("staged canary CLI", () => {
  it("prints the frozen Luna C0/C1 spec without contacting a provider", async () => {
    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    try {
      await main(["benchmark-canary-spec"]);
      const output = write.mock.calls.map(([chunk]) => String(chunk)).join("");
      const spec = parseLunaCanarySpec(JSON.parse(output) as unknown);
      expect(
        spec.stages.map(({ stageId, seed }) => ({ stageId, seed })),
      ).toEqual([
        {
          stageId: "v0.3.2-luna-c0-001",
          seed: "chronorift-v0.3.2-luna-canary-c0-1",
        },
        {
          stageId: "v0.3.2-luna-c1-001",
          seed: "chronorift-v0.3.2-luna-canary-c1-1",
        },
      ]);
    } finally {
      write.mockRestore();
    }
  });

  it.each([
    ["benchmark-canary", "--provider"],
    ["benchmark-canary", "--model"],
    ["benchmark-canary", "--thinking"],
    ["benchmark-canary", "--retries"],
    ["benchmark-canary-publish", "--provider"],
    ["benchmark-canary-spec", "--campaign"],
  ])("rejects an unfrozen override for %s", async (command, flag) => {
    await expect(main([command, flag, "override"])).rejects.toThrow(
      `Unsupported ${flag}`,
    );
  });

  it("requires an explicit C0 report path only for C1 execution", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chronorift-canary-cli-"));
    const specPath = join(directory, "spec.json");
    await writeFile(
      specPath,
      JSON.stringify(
        buildLunaCanarySpec("v0.3.2-luna-canary-cli-prerequisite", {
          gitCommit: "a".repeat(40),
          sourceHash: "b".repeat(64),
          sourceFileCount: 1,
          sourceWorktreeDirty: false,
        }),
      ),
      "utf8",
    );

    await expect(
      main(["benchmark-canary", "--spec", specPath, "--stage", "c1"]),
    ).rejects.toThrow("--c0-report is required for C1");
    await expect(
      main([
        "benchmark-canary",
        "--spec",
        specPath,
        "--stage",
        "c0",
        "--c0-report",
        "unused.json",
      ]),
    ).rejects.toThrow("--c0-report is only valid for C1");
  });
});
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
