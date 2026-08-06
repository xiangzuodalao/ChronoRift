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

  it("keeps the committed V3 Luna r4 identity frozen while v0.4 evolves in parallel", async () => {
    const cwd = process.cwd();
    const artifactRoot = await mkdtemp(
      join(tmpdir(), "chronorift-formal-spec-v3-r4-"),
    );
    try {
      const committed = parseFormalBenchmarkSuiteSpecV3(
        JSON.parse(
          await readFile(
            resolve(
              cwd,
              "docs/benchmarks/v0.3.2-luna-r4/benchmark-spec.v3.json",
            ),
            "utf8",
          ),
        ) as unknown,
      );
      const rebuilt = await buildFormalBenchmarkSuiteSpecV3({
        cwd,
        artifactRoot,
        campaign: "v0.3.2-luna-r4",
      });

      expect(sameFormalSuiteV3(committed, rebuilt)).toBe(false);
      expect(committed.definitionId).toBe(
        "benchmark-definition:61a0cf9b8240945d61d8c614baf91f2e8da440794a33ca8dee657cd78552210f",
      );
      expect(committed.subjectHash).toBe(
        "314958f7037241fbdb0a4c02f9b7e5bf617f7e1fd4eccd253449e18843e9066a",
      );
      expect(committed.runnerHash).toBe(
        "87a0d0351e981c41fda51ad5c1f48c3a1612424c7ae2a14a85c935ae6d1edcf0",
      );
      expect(rebuilt.subjectHash).not.toBe(committed.subjectHash);
      expect(rebuilt.runnerHash).not.toBe(committed.runnerHash);
      expect(committed.campaign).toEqual({
        campaignId: "v0.3.2-luna-r4",
        freezeTag: "v0.3.2-luna-r4-benchmark-freeze",
      });
      expect(committed.orderSeed).toBe("chronorift-v0.3.2-luna-r4-formal-1");
    } finally {
      await rm(artifactRoot, { recursive: true, force: true });
    }
  });

  it("keeps the frozen V3 Luna r3 specification parseable", async () => {
    const cwd = process.cwd();
    const committed = parseFormalBenchmarkSuiteSpecV3(
      JSON.parse(
        await readFile(
          resolve(cwd, "docs/benchmarks/v0.3.2-luna-r3/benchmark-spec.v3.json"),
          "utf8",
        ),
      ) as unknown,
    );
    expect(committed.campaign).toEqual({
      campaignId: "v0.3.2-luna-r3",
      freezeTag: "v0.3.2-luna-r3-benchmark-freeze",
    });
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
