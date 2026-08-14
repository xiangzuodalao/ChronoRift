import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  GodotSemanticAdapterProfileSnapshotV1Schema,
  parseGodotSemanticAdapterProfileSnapshotV1,
  readGodotSemanticAdapterProfileSnapshotV1,
} from "./semantic-adapter-profile.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const profile = {
  schemaVersion: 1,
  profileKind: "chronorift-godot-semantic-adapter",
  adapterKind: "timer_spawn_v1",
  projectCapabilitySha256: "a".repeat(64),
  targetScene: "res://components/spawner/enemy_spawner_broken.tscn",
  spawnIntervalSeconds: 1,
  checkpointBarrier: "adapter_process_tail",
  limits: {
    activeRuntimesMaximum: 2,
    launchesPerTurnMaximum: 8,
    entityMaximum: 256,
    eventMaximum: 4096,
    rawSemanticBytesMaximum: 2_097_152,
    checkpointBytesMaximum: 1_048_576,
    traceSamplesMaximum: 32,
    traceTicksMaximum: 600,
    queryRowsMaximum: 200,
  },
};

describe("Godot semantic adapter profile snapshot", () => {
  it("freezes raw and canonical identities", () => {
    const snapshot = parseGodotSemanticAdapterProfileSnapshotV1(
      Buffer.from(`${JSON.stringify(profile)}\n`),
    );
    expect(GodotSemanticAdapterProfileSnapshotV1Schema.parse(snapshot)).toEqual(
      snapshot,
    );
    expect(snapshot.rawBytesSha256).not.toBe(snapshot.adapterProfileSha256);
  });

  it("rejects unknown fields and traversal", () => {
    expect(() =>
      parseGodotSemanticAdapterProfileSnapshotV1(
        Buffer.from(JSON.stringify({ ...profile, oracle: "hidden" })),
      ),
    ).toThrow();
    expect(() =>
      parseGodotSemanticAdapterProfileSnapshotV1(
        Buffer.from(
          JSON.stringify({ ...profile, targetScene: "res://../private.tscn" }),
        ),
      ),
    ).toThrow(/traverse/iu);
  });

  it("rejects corrupt persisted raw bytes without throwing outside schema validation", () => {
    const snapshot = parseGodotSemanticAdapterProfileSnapshotV1(
      Buffer.from(JSON.stringify(profile)),
    );
    const corrupt = {
      ...snapshot,
      bytesBase64: Buffer.from("not-json").toString("base64"),
      byteLength: 8,
      rawBytesSha256: "b".repeat(64),
    };
    expect(
      GodotSemanticAdapterProfileSnapshotV1Schema.safeParse(corrupt).success,
    ).toBe(false);
  });

  it("reads only a canonical regular file and rejects a symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "chronorift-semantic-profile-"));
    roots.push(root);
    const target = join(root, "profile.json");
    const link = join(root, "linked.json");
    await writeFile(target, JSON.stringify(profile));
    await symlink(target, link);
    await expect(
      readGodotSemanticAdapterProfileSnapshotV1(target),
    ).resolves.toMatchObject({ canonicalPath: target });
    await expect(
      readGodotSemanticAdapterProfileSnapshotV1(link),
    ).rejects.toThrow(/canonical regular file/iu);
  });
});
