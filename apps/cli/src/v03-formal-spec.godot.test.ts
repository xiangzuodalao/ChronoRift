import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildFormalBenchmarkSuiteSpecV2,
  parseFormalBenchmarkSuiteSpecV2,
  sameFormalSuite,
} from "./v03-formal-suite.js";

describe("committed formal benchmark specification", () => {
  it("matches the current v0.3.1-r2 subject and runner hashes", async () => {
    const cwd = process.cwd();
    const committed = parseFormalBenchmarkSuiteSpecV2(
      JSON.parse(
        await readFile(
          resolve(cwd, "docs/benchmarks/v0.3.1-r2/benchmark-spec.v2.json"),
          "utf8",
        ),
      ) as unknown,
    );
    const current = await buildFormalBenchmarkSuiteSpecV2({
      cwd,
      artifactRoot: await mkdtemp(join(tmpdir(), "chronorift-formal-spec-")),
      campaign: "v0.3.1-r2",
    });
    expect(sameFormalSuite(committed, current)).toBe(true);
  });
});
