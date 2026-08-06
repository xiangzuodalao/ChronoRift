import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  FixtureManifestV1Schema,
  TaskFixtureCapabilityV1Schema,
  type FixtureManifestV1,
} from "./contracts.js";
import {
  assertCandidateFixtureCompatible,
  loadTrustedFixtureCatalog,
  resolveTaskFixtureCapability,
} from "./fixture-manifest.js";
import { readTrustedSelectedTree } from "./selected-tree.js";

const trustedFixtureRoot = fileURLToPath(
  new URL("../../../../fixtures/godot-frame-input-window", import.meta.url),
);
const manifestPath = join(trustedFixtureRoot, "chronorift.fixture.json");
const temporaryRoots: string[] = [];

const readManifest = async (root: string): Promise<FixtureManifestV1> =>
  FixtureManifestV1Schema.parse(
    JSON.parse(await readFile(join(root, "chronorift.fixture.json"), "utf8")),
  );

const copyFixture = async (): Promise<string> => {
  const temporaryParent = await mkdtemp(
    join(tmpdir(), "chronorift-fixture-catalog-test-"),
  );
  temporaryRoots.push(temporaryParent);
  const copyRoot = join(temporaryParent, "fixture");
  await cp(trustedFixtureRoot, copyRoot, { recursive: true });
  return copyRoot;
};

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map(async (root) => rm(root, { recursive: true, force: true })),
  );
});

describe("FixtureManifestV1", () => {
  it("ships the exact no-oracle supported fixture declaration", async () => {
    const manifest = await readManifest(dirname(manifestPath));

    expect(manifest).toEqual({
      schemaVersion: 1,
      fixtureId: "frame-input-window",
      engine: "godot",
      projectFile: "project.godot",
      startupScene: "res://frame_input_window.tscn",
      protocolVersion: 2,
      runtimeProfile: "chronorift-godot-protocol-v2",
      inputActions: ["attempt_jump"],
      controls: {
        fixedFps: { default: 120, allowed: [60, 120] },
        physicsTicksPerSecond: { default: 60, allowed: [60, 120] },
        maxTicks: { default: 10, minimum: 1, maximum: 600 },
      },
      ignoredCachePaths: [".godot"],
    });
    expect(JSON.stringify(manifest)).not.toMatch(
      /oracle|mechanism|sourceLocus|expectedPatch|rootCause|verdict/iu,
    );
  });

  it("rejects unknown manifest fields", async () => {
    const manifest = await readManifest(trustedFixtureRoot);
    expect(() =>
      FixtureManifestV1Schema.parse({
        ...manifest,
        rootCause: "frame counter",
      }),
    ).toThrow();
  });
});

describe("trusted fixture catalog", () => {
  it("resolves an exact external copy and freezes its capability", async () => {
    const externalCopy = await copyFixture();
    const catalog = await loadTrustedFixtureCatalog(trustedFixtureRoot);
    const manifest = await readManifest(externalCopy);
    const selectedTreeSha256 = await readTrustedSelectedTree(externalCopy);

    const capability = resolveTaskFixtureCapability(
      { manifest, selectedTreeSha256 },
      catalog,
    );

    expect(catalog.size).toBe(1);
    expect(TaskFixtureCapabilityV1Schema.parse(capability)).toEqual(capability);
    expect(capability).toMatchObject({
      schemaVersion: 1,
      fixtureId: "frame-input-window",
      baselineSelectedTreeSha256: selectedTreeSha256,
      startupScene: "res://frame_input_window.tscn",
      runtimeProfile: "chronorift-godot-protocol-v2",
      controls: {
        fixedFps: { default: 120, allowed: [60, 120] },
      },
    });
  });

  it("rejects a source tree whose actual bytes differ from the trusted fixture", async () => {
    const externalCopy = await copyFixture();
    const catalog = await loadTrustedFixtureCatalog(trustedFixtureRoot);
    await writeFile(
      join(externalCopy, "frame_input_window.gd"),
      "extends Node\n# changed source byte\n",
    );

    const manifest = await readManifest(externalCopy);
    const selectedTreeSha256 = await readTrustedSelectedTree(externalCopy);
    try {
      resolveTaskFixtureCapability({ manifest, selectedTreeSha256 }, catalog);
      throw new Error("expected source tree rejection");
    } catch (error) {
      expect(error).toMatchObject({ code: "source_feature_unsupported" });
    }
  });

  it.each([
    ["fixture id change", { fixtureId: "different-fixture" }],
    ["runtime profile change", { runtimeProfile: "different-runtime" }],
    ["startup scene change", { startupScene: "res://other.tscn" }],
  ])("rejects candidate %s", async (_label, change) => {
    const catalog = await loadTrustedFixtureCatalog(trustedFixtureRoot);
    const manifest = await readManifest(trustedFixtureRoot);
    const selectedTreeSha256 =
      await readTrustedSelectedTree(trustedFixtureRoot);
    const capability = resolveTaskFixtureCapability(
      { manifest, selectedTreeSha256 },
      catalog,
    );

    expect(() =>
      assertCandidateFixtureCompatible(
        { ...manifest, ...change } as unknown as FixtureManifestV1,
        capability,
      ),
    ).toThrowError(
      expect.objectContaining({ code: "source_configuration_mismatch" }),
    );
  });

  it("rejects candidate control escalation but accepts semantic equality", async () => {
    const catalog = await loadTrustedFixtureCatalog(trustedFixtureRoot);
    const manifest = await readManifest(trustedFixtureRoot);
    const selectedTreeSha256 =
      await readTrustedSelectedTree(trustedFixtureRoot);
    const capability = resolveTaskFixtureCapability(
      { manifest, selectedTreeSha256 },
      catalog,
    );
    const escalated = {
      ...manifest,
      controls: {
        ...manifest.controls,
        fixedFps: { default: 120, allowed: [60, 120, 240] },
      },
    } as unknown as FixtureManifestV1;

    expect(() =>
      assertCandidateFixtureCompatible(escalated, capability),
    ).toThrowError(
      expect.objectContaining({ code: "source_configuration_mismatch" }),
    );
    expect(() =>
      assertCandidateFixtureCompatible(
        JSON.parse(JSON.stringify(manifest)) as FixtureManifestV1,
        capability,
      ),
    ).not.toThrow();
  });
});
