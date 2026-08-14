import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  MAX_GODOT_PROJECT_DESCRIPTOR_BYTES_V1,
  GodotProjectDescriptorV1Schema,
  readGodotProjectDescriptorSnapshotV1,
} from "./godot-project-descriptor.js";

const roots: string[] = [];

const descriptor = {
  schemaVersion: 1,
  descriptorKind: "chronorift-godot-external-project",
  declaredSourceUrl: "https://github.com/endlessm/moddable-platformer",
  projectFile: "project.godot",
  runtime: {
    engineVersion: "4.7.1-stable (official)",
    scripting: "gdscript",
    renderer: "gl_compatibility",
    executionMode: "headless",
  },
  launch: { scene: "project-main-scene" },
  cache: { ignoredPaths: [".godot"] },
  bridge: { mode: "managed-runtime-overlay", protocolVersion: 1 },
} as const;

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("GodotProjectDescriptorV1", () => {
  it("strictly accepts the lifecycle-only external project profile", () => {
    expect(GodotProjectDescriptorV1Schema.parse(descriptor)).toEqual(
      descriptor,
    );
    expect(() =>
      GodotProjectDescriptorV1Schema.parse({
        ...descriptor,
        argv: ["--editor"],
      }),
    ).toThrow();
    expect(() =>
      GodotProjectDescriptorV1Schema.parse({
        ...descriptor,
        declaredSourceUrl: "https://user:secret@example.test/project",
      }),
    ).toThrow(/declaredSourceUrl/u);
  });

  it("pins the exact bounded descriptor bytes and rejects symlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "chronorift-descriptor-test-"));
    roots.push(root);
    const descriptorPath = join(root, "project.json");
    const bytes = Buffer.from(`${JSON.stringify(descriptor, null, 2)}\n`);
    await writeFile(descriptorPath, bytes);

    const snapshot = await readGodotProjectDescriptorSnapshotV1(descriptorPath);

    expect(Buffer.from(snapshot.bytes)).toEqual(bytes);
    expect(snapshot.descriptor).toEqual(descriptor);
    expect(snapshot.descriptorSha256).toMatch(/^[a-f0-9]{64}$/u);

    const linked = join(root, "linked.json");
    await symlink(descriptorPath, linked);
    await expect(
      readGodotProjectDescriptorSnapshotV1(linked),
    ).rejects.toMatchObject({ code: "path_denied" });
  });

  it("rejects malformed, non-UTF-8, and oversized bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "chronorift-descriptor-test-"));
    roots.push(root);
    await mkdir(join(root, "directory"));
    await expect(
      readGodotProjectDescriptorSnapshotV1(join(root, "directory")),
    ).rejects.toMatchObject({ code: "path_denied" });

    const invalid = join(root, "invalid.json");
    await writeFile(invalid, Buffer.from([0xff]));
    await expect(
      readGodotProjectDescriptorSnapshotV1(invalid),
    ).rejects.toMatchObject({ code: "source_configuration_mismatch" });

    const oversized = join(root, "oversized.json");
    await writeFile(
      oversized,
      Buffer.alloc(MAX_GODOT_PROJECT_DESCRIPTOR_BYTES_V1 + 1, 0x20),
    );
    await expect(
      readGodotProjectDescriptorSnapshotV1(oversized),
    ).rejects.toMatchObject({ code: "source_configuration_mismatch" });
  });
});
