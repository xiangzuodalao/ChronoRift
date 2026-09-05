import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareGodotInspectionCandidate } from "./godot-inspection-source.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
const setup = async (mainScene = "res://main.tscn") => {
  const root = await mkdtemp(join(tmpdir(), "chronorift-inspection-source-"));
  roots.push(root);
  await writeFile(
    join(root, "project.godot"),
    `config_version=5\n[application]\nrun/main_scene="${mainScene}"\n`,
  );
  await writeFile(
    join(root, "main.tscn"),
    '[gd_scene format=3]\n[node name="Main" type="Node"]\n',
  );
  return root;
};

describe("inspection source admission", () => {
  it.each(["res://main.tscn", "uid://br3y4"])(
    "accepts a bounded default scene %s without an adapter",
    async (mainScene) => {
      expect(
        await prepareGodotInspectionCandidate(await setup(mainScene)),
      ).toMatchObject({ mainScene });
    },
  );
  it.each([
    "/tmp/main.tscn",
    "res://../main.tscn",
    "res://./main.tscn",
    "res://missing.tscn",
    "res://dir//main.tscn",
    "uid://bad/path",
  ])("rejects unsupported scene %s", async (scene) => {
    await expect(
      prepareGodotInspectionCandidate(await setup(scene)),
    ).rejects.toThrow();
  });
  it.each([
    ".env",
    "module.gdextension",
    "native.dll",
    "script.cs",
    "addons/chronorift_inspection/observer.gd",
    "override.cfg",
  ])("rejects forbidden candidate content %s", async (path) => {
    const root = await setup();
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), "");
    await expect(prepareGodotInspectionCandidate(root)).rejects.toThrow();
  });
  it("rejects symlinks and reserved autoload configuration", async () => {
    const root = await setup();
    await symlink("/etc/passwd", join(root, "escape.txt"));
    await expect(prepareGodotInspectionCandidate(root)).rejects.toThrow();
    await rm(join(root, "escape.txt"));
    await writeFile(
      join(root, "project.godot"),
      '[application]\nrun/main_scene="res://main.tscn"\n[autoload]\nChronoRiftInspection="*res://main.gd"\n',
    );
    await expect(prepareGodotInspectionCandidate(root)).rejects.toThrow(
      /reserved/u,
    );
  });
  it("returns the admitted bytes independently of later candidate edits", async () => {
    const root = await setup();
    const admitted = await prepareGodotInspectionCandidate(root);
    const scene = admitted.sourceFiles.find(
      (file) => file.relativePath === "main.tscn",
    );
    expect(scene?.executable).toBe(false);
    await writeFile(join(root, "main.tscn"), "changed after admission");
    expect(new TextDecoder().decode(scene?.bytes)).toContain(
      '[node name="Main"',
    );
  });
  it("allows ordinary addons and ignores local old state", async () => {
    const root = await setup();
    await mkdir(join(root, "addons/project"), { recursive: true });
    await writeFile(join(root, "addons/project/tool.gd"), "extends Node\n");
    await mkdir(join(root, ".chronorift"));
    await writeFile(
      join(root, ".chronorift/old-state.json"),
      "invalid historical state",
    );
    expect(await prepareGodotInspectionCandidate(root)).toMatchObject({
      mainScene: "res://main.tscn",
    });
  });
});
