import { describe, expect, it } from "vitest";

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
});
