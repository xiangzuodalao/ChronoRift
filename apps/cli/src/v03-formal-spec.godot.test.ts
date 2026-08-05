import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildFormalBenchmarkSuiteSpecV3,
  parseFormalBenchmarkSuiteSpecV2,
  parseFormalBenchmarkSuiteSpecV3,
  sameFormalSuiteV3,
} from "./v03-formal-suite.js";

describe("committed formal benchmark specification", () => {
  it("keeps the frozen v0.3.1-r2 specification parseable", async () => {
    const cwd = process.cwd();
    const committed = parseFormalBenchmarkSuiteSpecV2(
      JSON.parse(
        await readFile(
          resolve(cwd, "docs/benchmarks/v0.3.1-r2/benchmark-spec.v2.json"),
          "utf8",
        ),
      ) as unknown,
    );
    expect(committed.campaign).toEqual({
      campaignId: "v0.3.1-r2",
      freezeTag: "v0.3.1-r2-benchmark-freeze",
    });
  });

  it("builds the current V3 Luna specification deterministically", async () => {
    const cwd = process.cwd();
    const artifactRoot = await mkdtemp(
      join(tmpdir(), "chronorift-formal-spec-v3-"),
    );
    try {
      const first = await buildFormalBenchmarkSuiteSpecV3({
        cwd,
        artifactRoot,
      });
      const second = await buildFormalBenchmarkSuiteSpecV3({
        cwd,
        artifactRoot,
      });
      expect(sameFormalSuiteV3(first, second)).toBe(true);
      expect(first.provider).toBe("openai-codex");
      expect(first.model).toBe("gpt-5.6-luna");
    } finally {
      await rm(artifactRoot, { recursive: true, force: true });
    }
  });

  it("keeps the committed V3 Luna r3 specification identical to the implementation", async () => {
    const cwd = process.cwd();
    const artifactRoot = await mkdtemp(
      join(tmpdir(), "chronorift-formal-spec-v3-r3-"),
    );
    try {
      const committed = parseFormalBenchmarkSuiteSpecV3(
        JSON.parse(
          await readFile(
            resolve(
              cwd,
              "docs/benchmarks/v0.3.2-luna-r3/benchmark-spec.v3.json",
            ),
            "utf8",
          ),
        ) as unknown,
      );
      const rebuilt = await buildFormalBenchmarkSuiteSpecV3({
        cwd,
        artifactRoot,
        campaign: "v0.3.2-luna-r3",
      });

      expect(sameFormalSuiteV3(committed, rebuilt)).toBe(true);
      expect(committed.campaign).toEqual({
        campaignId: "v0.3.2-luna-r3",
        freezeTag: "v0.3.2-luna-r3-benchmark-freeze",
      });
      expect(committed.orderSeed).toBe("chronorift-v0.3.2-luna-r3-formal-1");
    } finally {
      await rm(artifactRoot, { recursive: true, force: true });
    }
  });

  it("keeps the original frozen V3 Luna specification parseable", async () => {
    const cwd = process.cwd();
    const committed = parseFormalBenchmarkSuiteSpecV3(
      JSON.parse(
        await readFile(
          resolve(cwd, "docs/benchmarks/v0.3.2-luna/benchmark-spec.v3.json"),
          "utf8",
        ),
      ) as unknown,
    );
    expect(committed.campaign).toEqual({
      campaignId: "v0.3.2-luna",
      freezeTag: "v0.3.2-luna-benchmark-freeze",
    });
  });

  it("keeps the frozen V3 Luna r1 specification parseable", async () => {
    const cwd = process.cwd();
    const committed = parseFormalBenchmarkSuiteSpecV3(
      JSON.parse(
        await readFile(
          resolve(cwd, "docs/benchmarks/v0.3.2-luna-r1/benchmark-spec.v3.json"),
          "utf8",
        ),
      ) as unknown,
    );
    expect(committed.campaign).toEqual({
      campaignId: "v0.3.2-luna-r1",
      freezeTag: "v0.3.2-luna-r1-benchmark-freeze",
    });
  });

  it("keeps the frozen V3 Luna r2 specification parseable", async () => {
    const cwd = process.cwd();
    const committed = parseFormalBenchmarkSuiteSpecV3(
      JSON.parse(
        await readFile(
          resolve(cwd, "docs/benchmarks/v0.3.2-luna-r2/benchmark-spec.v3.json"),
          "utf8",
        ),
      ) as unknown,
    );
    expect(committed.campaign).toEqual({
      campaignId: "v0.3.2-luna-r2",
      freezeTag: "v0.3.2-luna-r2-benchmark-freeze",
    });
  });
});
