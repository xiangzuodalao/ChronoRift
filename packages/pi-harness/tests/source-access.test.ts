import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createRestrictedSourceAccess,
  createVirtualSourceAccess,
} from "../src/source-access.js";

describe("restricted source access", () => {
  let fixtureRoot: string;
  let sourceRoot: string;
  let outsideRoot: string;

  beforeEach(async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), "chronorift-source-"));
    sourceRoot = join(fixtureRoot, "source");
    outsideRoot = join(fixtureRoot, "outside");
    await mkdir(join(sourceRoot, "src"), { recursive: true });
    await mkdir(outsideRoot, { recursive: true });
    await writeFile(
      join(sourceRoot, "src", "door.ts"),
      [
        "export const thresholdUs = 100_000;",
        "export function shouldOpen(elapsedUs: number): boolean {",
        "  return elapsedUs === thresholdUs;",
        "}",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(outsideRoot, "secret.ts"),
      "export const secret = 'must-not-leak';\n",
      "utf8",
    );
    await symlink(outsideRoot, join(sourceRoot, "escape"), "dir");
  });

  afterEach(async () => {
    await rm(fixtureRoot, { recursive: true, force: true });
  });

  it("reads and searches files inside the canonical root", async () => {
    const source = await createRestrictedSourceAccess({ root: sourceRoot });

    await expect(
      source.read({ path: "src/door.ts", offset: 2, limit: 2 }),
    ).resolves.toMatchObject({
      path: "src/door.ts",
      startLine: 2,
      endLine: 3,
      content:
        "export function shouldOpen(elapsedUs: number): boolean {\n  return elapsedUs === thresholdUs;",
      truncated: true,
    });

    await expect(
      source.search({
        query: "elapsedUs === thresholdUs",
        includeSuffixes: [".ts"],
      }),
    ).resolves.toMatchObject({
      matches: [
        {
          path: "src/door.ts",
          line: 3,
          column: 10,
        },
      ],
      scannedFiles: 1,
    });
  });

  it("rejects lexical traversal and absolute paths", async () => {
    const source = await createRestrictedSourceAccess({ root: sourceRoot });

    await expect(
      source.read({ path: "../outside/secret.ts" }),
    ).rejects.toMatchObject({ code: "SOURCE_OUT_OF_BOUNDS" });
    await expect(
      source.read({ path: join(outsideRoot, "secret.ts") }),
    ).rejects.toMatchObject({ code: "SOURCE_OUT_OF_BOUNDS" });
  });

  it("rejects an explicit symlink escape and skips it during recursive search", async () => {
    const source = await createRestrictedSourceAccess({ root: sourceRoot });

    await expect(
      source.read({ path: "escape/secret.ts" }),
    ).rejects.toMatchObject({ code: "SOURCE_OUT_OF_BOUNDS" });

    const result = await source.search({ query: "must-not-leak" });
    expect(result.matches).toEqual([]);
    expect(result.scannedFiles).toBe(1);
  });
});

describe("virtual source access", () => {
  it("exposes only neutral aliases and supports deterministic reads and searches", async () => {
    const source = createVirtualSourceAccess({
      files: [
        {
          path: "case/main.gd",
          content: "extends Node\n\nfunc _resolve_pending_effects():\n\tpass\n",
        },
      ],
    });

    await expect(source.read({ path: "case/main.gd" })).resolves.toMatchObject({
      path: "case/main.gd",
      startLine: 1,
    });
    await expect(
      source.search({ query: "_resolve_pending_effects", path: "case" }),
    ).resolves.toMatchObject({
      scannedFiles: 1,
      matches: [{ path: "case/main.gd", line: 3 }],
    });
    await expect(
      source.read({ path: "entity_reuse.gd" }),
    ).rejects.toMatchObject({
      code: "SOURCE_NOT_FOUND",
    });
    await expect(source.read({ path: "../secret.gd" })).rejects.toMatchObject({
      code: "SOURCE_OUT_OF_BOUNDS",
    });
  });

  it("rejects duplicate or non-normalized aliases", () => {
    expect(() =>
      createVirtualSourceAccess({
        files: [
          { path: "case/main.gd", content: "one" },
          { path: "case/main.gd", content: "two" },
        ],
      }),
    ).toThrow(/Duplicate virtual source path/u);
    expect(() =>
      createVirtualSourceAccess({
        files: [{ path: "case/../secret.gd", content: "secret" }],
      }),
    ).toThrow(/normalized relative POSIX/u);
  });
});
