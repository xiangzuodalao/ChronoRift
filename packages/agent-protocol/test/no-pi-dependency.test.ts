import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

describe("SDK boundary", () => {
  it("does not depend on or import Pi packages", async () => {
    const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
    const packageJson = await readFile(
      join(packageRoot, "package.json"),
      "utf8",
    );
    const sourceFiles = await Promise.all(
      [
        "api.ts",
        "capabilities.ts",
        "handles.ts",
        "proposal.ts",
        "tools.ts",
      ].map((file) => readFile(join(packageRoot, "src", file), "utf8")),
    );

    expect(packageJson).not.toContain("pi-coding-agent");
    expect(packageJson).not.toContain("@earendil-works/pi");
    expect(sourceFiles.join("\n")).not.toContain("@earendil-works/pi");
  });
});
