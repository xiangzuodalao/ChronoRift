import { describe, expect, it, vi } from "vitest";

import { main } from "./main.js";

describe("formal benchmark CLI", () => {
  it.each([
    ["--provider", "override"],
    ["--model", "override"],
    ["--thinking", "low"],
    ["--repetitions", "1"],
    ["--seed", "override"],
    ["--report", "override.json"],
    ["--artifacts", "/tmp/cherry-pick"],
  ])("rejects the frozen formal override %s", async (flag, value) => {
    await expect(main(["benchmark-formal", flag, value])).rejects.toThrow(
      `Unsupported ${flag}`,
    );
  });

  it("rejects unknown spec campaigns", async () => {
    await expect(
      main(["benchmark-spec", "--campaign", "v0.4"]),
    ).rejects.toThrow("Unsupported benchmark campaign");
  });

  it("lists the isolated Luna r1, r2, and r3 campaigns in CLI help", async () => {
    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    try {
      await main(["help"]);
      expect(
        write.mock.calls.map(([chunk]) => String(chunk)).join(""),
      ).toContain(
        "v0.3.1|v0.3.1-r2|v0.3.2-luna|v0.3.2-luna-r1|v0.3.2-luna-r2|v0.3.2-luna-r3",
      );
    } finally {
      write.mockRestore();
    }
  });
});
