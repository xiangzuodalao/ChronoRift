import {
  access,
  mkdir,
  mkdtemp,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  clearGeneratedGodotCache,
  fingerprintGodotSourceTrees,
  stageGodotProject,
  verifyStagedGodotProject,
} from "./fixture.js";

describe("Godot project staging integrity", () => {
  it("creates an exact stage and rejects modified or extra source files", async () => {
    const root = await mkdtemp(join(tmpdir(), "chronorift-stage-"));
    const fixtureSource = join(root, "fixture-source");
    const addonSource = join(root, "addon-source");
    const artifactRoot = join(root, "artifacts");
    await Promise.all([
      mkdir(fixtureSource, { recursive: true }),
      mkdir(addonSource, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(fixtureSource, "project.godot"), "[application]\n"),
      writeFile(join(fixtureSource, "case.gd"), "extends Node\n"),
      writeFile(join(addonSource, "plugin.gd"), "extends Node\n"),
    ]);
    const fingerprint = await fingerprintGodotSourceTrees({
      fixtureSource,
      addonSource,
    });
    const staged = await stageGodotProject({
      artifactRoot,
      directoryName: "case-deadbeef",
      fixtureSource,
      addonSource,
      projectHash: fingerprint.projectHash,
      addonHash: fingerprint.addonHash,
    });
    await expect(
      verifyStagedGodotProject(staged, fingerprint),
    ).resolves.toBeUndefined();
    const linkedStage = join(root, "linked-stage");
    await symlink(staged, linkedStage, "dir");
    await expect(
      verifyStagedGodotProject(linkedStage, fingerprint),
    ).rejects.toThrow(/real directory/u);

    await mkdir(join(staged, ".godot"), { recursive: true });
    await writeFile(join(staged, ".godot", "generated-cache"), "ignored");
    await expect(
      verifyStagedGodotProject(staged, fingerprint),
    ).resolves.toBeUndefined();
    await expect(clearGeneratedGodotCache(staged)).resolves.toBeUndefined();
    await expect(access(join(staged, ".godot"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    const outsideCache = join(root, "outside-cache");
    await mkdir(outsideCache);
    await symlink(outsideCache, join(staged, ".godot"), "dir");
    await expect(clearGeneratedGodotCache(staged)).rejects.toThrow(
      /real directory/u,
    );
    await unlink(join(staged, ".godot"));

    await writeFile(join(staged, "case.gd"), "extends Resource\n");
    await expect(verifyStagedGodotProject(staged, fingerprint)).rejects.toThrow(
      /integrity mismatch/u,
    );
    await expect(
      stageGodotProject({
        artifactRoot,
        directoryName: "case-deadbeef",
        fixtureSource,
        addonSource,
        projectHash: fingerprint.projectHash,
        addonHash: fingerprint.addonHash,
      }),
    ).rejects.toThrow(/integrity mismatch/u);
  });

  it("rejects stale files outside Godot's generated cache", async () => {
    const root = await mkdtemp(join(tmpdir(), "chronorift-stage-extra-"));
    const fixtureSource = join(root, "fixture-source");
    const addonSource = join(root, "addon-source");
    await Promise.all([
      mkdir(fixtureSource, { recursive: true }),
      mkdir(addonSource, { recursive: true }),
    ]);
    await writeFile(join(fixtureSource, "project.godot"), "[application]\n");
    await writeFile(join(addonSource, "plugin.gd"), "extends Node\n");
    const fingerprint = await fingerprintGodotSourceTrees({
      fixtureSource,
      addonSource,
    });
    const staged = await stageGodotProject({
      artifactRoot: join(root, "artifacts"),
      directoryName: "case-deadbeef",
      fixtureSource,
      addonSource,
      projectHash: fingerprint.projectHash,
      addonHash: fingerprint.addonHash,
    });
    await writeFile(join(staged, "stale.gd"), "extends Node\n");

    await expect(verifyStagedGodotProject(staged, fingerprint)).rejects.toThrow(
      /integrity mismatch/u,
    );
  });
});
