import type { BigIntStats, PathLike, Stats } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const lstatRace = vi.hoisted(() => ({
  suffix: null as string | null,
  swap: null as (() => Promise<void>) | null,
}));

interface MockedFsPromises {
  readonly [name: string]: unknown;
  lstat(target: PathLike): Promise<Stats>;
  lstat(
    target: PathLike,
    options: { readonly bigint: true },
  ): Promise<BigIntStats>;
}

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<MockedFsPromises>();
  return {
    ...actual,
    lstat: async (
      target: PathLike,
      options?: { readonly bigint?: boolean },
    ) => {
      const result =
        options?.bigint === true
          ? await actual.lstat(target, { bigint: true })
          : await actual.lstat(target);
      const targetText = target.toString();
      const swap = lstatRace.swap;
      if (
        swap !== null &&
        lstatRace.suffix !== null &&
        targetText.endsWith(lstatRace.suffix)
      ) {
        lstatRace.swap = null;
        await swap();
      }
      return result;
    },
  };
});

import {
  asSha256DigestV1,
  asTaskId,
  asWorkspaceId,
  type JsonValue,
} from "@chronorift/domain";
import { contentHash } from "@chronorift/json-artifacts";

import {
  prepareCandidateGodotBuildV1,
  prepareExternalGodotLifecycleBuildV1,
} from "./candidate-godot-build.js";
import type { TaskFixtureCapabilityV1 } from "./contracts.js";
import type { ManagedGodotRuntimeCapabilityV1 } from "./managed-godot-runtime.js";

const roots: string[] = [];
afterEach(async () => {
  lstatRace.suffix = null;
  lstatRace.swap = null;
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

const hash = asSha256DigestV1("a".repeat(64));
const hashJson = (value: unknown) =>
  contentHash(JSON.parse(JSON.stringify(value)) as JsonValue);
const fixtureControls = {
  fixedFps: { default: 120, allowed: [60, 120] },
  physicsTicksPerSecond: { default: 60, allowed: [60, 120] },
  maxTicks: { default: 10, minimum: 1, maximum: 600 },
} as const;
const fixtureManifest = {
  schemaVersion: 1,
  fixtureId: "frame-input-window",
  engine: "godot",
  projectFile: "project.godot",
  startupScene: "res://frame_input_window.tscn",
  protocolVersion: 2,
  runtimeProfile: "chronorift-godot-protocol-v2",
  inputActions: ["attempt_jump"],
  controls: fixtureControls,
  ignoredCachePaths: [".godot"],
} as const;
const fixtureCapabilityContent = {
  schemaVersion: 1,
  fixtureId: "frame-input-window",
  trustedManifestSha256: asSha256DigestV1(hashJson(fixtureManifest)),
  baselineSelectedTreeSha256: hash,
  startupScene: "res://frame_input_window.tscn",
  protocolVersion: 2,
  runtimeProfile: "chronorift-godot-protocol-v2",
  inputActions: ["attempt_jump"],
  controls: fixtureControls,
  ignoredCachePaths: [".godot"],
} as const;
const fixtureCapability: TaskFixtureCapabilityV1 = {
  ...fixtureCapabilityContent,
  capabilitySha256: asSha256DigestV1(hashJson(fixtureCapabilityContent)),
};
const managedRuntime = {
  managedRuntimeId: `managed-godot-runtime:v1:${"b".repeat(64)}`,
  addonHash: asSha256DigestV1("c".repeat(64)),
} as ManagedGodotRuntimeCapabilityV1;

const createWorkspace = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "chronorift-candidate-"));
  roots.push(root);
  await writeFile(
    join(root, "chronorift.fixture.json"),
    JSON.stringify(fixtureManifest),
  );
  await writeFile(join(root, "project.godot"), "[application]\n");
  await writeFile(join(root, "frame_input_window.gd"), "extends Node\n");
  return root;
};

const prepare = (workspaceDirectory: string) =>
  prepareCandidateGodotBuildV1({
    taskId: asTaskId("task:test"),
    workspaceId: asWorkspaceId("workspace:test"),
    workspaceDirectory,
    baselineSourceHash: hash,
    fixtureCapability,
    managedRuntime,
    now: "2026-08-07T00:00:00.000Z",
  });

describe("candidate Godot build snapshot", () => {
  it("derives stable source/build identities and changes them after an edit", async () => {
    const workspace = await createWorkspace();
    const first = await prepare(workspace);
    const second = await prepare(workspace);
    expect(second).toEqual(first);
    await writeFile(
      join(workspace, "frame_input_window.gd"),
      "extends Node\n# edit\n",
    );
    const edited = await prepare(workspace);
    expect(edited.build.sourceHash).not.toBe(first.build.sourceHash);
    expect(edited.build.buildId).not.toBe(first.build.buildId);
  });

  it("includes managed runtime configuration in build identity without changing projectHash", async () => {
    const workspace = await createWorkspace();
    const first = await prepare(workspace);
    const changedRuntime = await prepareCandidateGodotBuildV1({
      taskId: asTaskId("task:test"),
      workspaceId: asWorkspaceId("workspace:test"),
      workspaceDirectory: workspace,
      baselineSourceHash: hash,
      fixtureCapability,
      managedRuntime: {
        ...managedRuntime,
        managedRuntimeId: `managed-godot-runtime:v1:${"d".repeat(64)}`,
      },
      now: "2026-08-07T00:00:00.000Z",
    });
    expect(changedRuntime.projectHash).toBe(first.projectHash);
    expect(changedRuntime.build.buildConfigurationHash).not.toBe(
      first.build.buildConfigurationHash,
    );
    expect(changedRuntime.build.buildId).not.toBe(first.build.buildId);
  });

  it("rejects every candidate addon that could hide the managed mount and symlinked source", async () => {
    const collision = await createWorkspace();
    await mkdir(join(collision, "addons", "chronorift"), { recursive: true });
    await writeFile(
      join(collision, "addons", "chronorift", "foreign.gd"),
      "bad",
    );
    await expect(prepare(collision)).rejects.toThrow(/collides/u);

    const unrelatedAddon = await createWorkspace();
    await mkdir(join(unrelatedAddon, "addons", "third_party"), {
      recursive: true,
    });
    await writeFile(
      join(unrelatedAddon, "addons", "third_party", "plugin.gd"),
      "extends Node\n",
    );
    await expect(prepare(unrelatedAddon)).rejects.toThrow(/collides/u);

    const linked = await createWorkspace();
    await symlink("project.godot", join(linked, "linked.godot"));
    await expect(prepare(linked)).rejects.toThrow(/symlink/u);
  });

  it("fails closed when a traversed ancestor is replaced by a symlink after inspection", async () => {
    const workspace = await createWorkspace();
    const victim = join(workspace, "victim");
    const parked = join(workspace, "victim-parked");
    await mkdir(victim);
    await writeFile(join(victim, "local.gd"), "extends Node\n");

    const outside = await mkdtemp(join(tmpdir(), "chronorift-outside-"));
    roots.push(outside);
    await writeFile(join(outside, "host-secret.gd"), "host secret\n");

    lstatRace.suffix = "/victim";
    lstatRace.swap = async () => {
      await rename(victim, parked);
      await symlink(outside, victim, "dir");
    };

    await expect(prepare(workspace)).rejects.toThrow(
      /changed|symlink|snapshot/u,
    );
    await expect(readFile(join(parked, "local.gd"), "utf8")).resolves.toBe(
      "extends Node\n",
    );
  });
});

describe("external lifecycle candidate build snapshot", () => {
  const lifecycleRuntime = {
    managedRuntimeId: `managed-godot-runtime:v1:${"1".repeat(64)}`,
    addonHash: asSha256DigestV1("2".repeat(64)),
    overlayHash: asSha256DigestV1("3".repeat(64)),
    vanillaSidecarSourceSha256: asSha256DigestV1("4".repeat(64)),
    lifecycleSidecarSourceSha256: asSha256DigestV1("5".repeat(64)),
    protocolProfile: "chronorift-godot-lifecycle-v1" as const,
  };

  const prepareLifecycle = (workspaceDirectory: string) =>
    prepareExternalGodotLifecycleBuildV1({
      taskId: asTaskId("task:external"),
      workspaceId: asWorkspaceId("workspace:external"),
      workspaceDirectory,
      baselineSourceHash: hash,
      projectCapability: {
        capabilitySha256: asSha256DigestV1("6".repeat(64)),
        descriptorSha256: asSha256DigestV1("7".repeat(64)),
      },
      managedRuntime: lifecycleRuntime,
      now: "2026-08-10T00:00:00.000Z",
    });

  it("binds source, descriptor, overlay, addon, and sidecars into build identity", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "chronorift-external-candidate-"),
    );
    roots.push(workspace);
    await writeFile(
      join(workspace, "project.godot"),
      '[application]\nrun/main_scene="res://main.tscn"\n',
    );
    await writeFile(join(workspace, "main.gd"), "extends Node\n");

    const first = await prepareLifecycle(workspace);
    const changed = await prepareExternalGodotLifecycleBuildV1({
      taskId: asTaskId("task:external"),
      workspaceId: asWorkspaceId("workspace:external"),
      workspaceDirectory: workspace,
      baselineSourceHash: hash,
      projectCapability: {
        capabilitySha256: asSha256DigestV1("6".repeat(64)),
        descriptorSha256: asSha256DigestV1("7".repeat(64)),
      },
      managedRuntime: {
        ...lifecycleRuntime,
        overlayHash: asSha256DigestV1("8".repeat(64)),
      },
      now: "2026-08-10T00:00:00.000Z",
    });
    expect(first.projectHash).not.toBe(changed.projectHash);
    expect(first.build.buildId).not.toBe(changed.build.buildId);
    expect(first.build.sourceHash).toBe(changed.build.sourceHash);
  });

  it("rejects candidate-only overlay and product state", async () => {
    for (const relativePath of [
      "override.cfg",
      ".chronorift/state.json",
      "Addons/plugin.gd",
      ".ChronoRift/state.json",
    ]) {
      const workspace = await mkdtemp(
        join(tmpdir(), "chronorift-external-collision-"),
      );
      roots.push(workspace);
      await writeFile(join(workspace, "project.godot"), "[application]\n");
      const target = join(workspace, relativePath);
      await mkdir(join(target, ".."), { recursive: true });
      await writeFile(target, "reserved\n");
      await expect(prepareLifecycle(workspace)).rejects.toThrow(/reserved/iu);
    }
  });

  it("rejects native and non-GDScript candidate additions before launch", async () => {
    for (const relativePath of [
      "native.SO",
      "bridge.gdextension",
      "Logic.CS",
    ]) {
      const workspace = await mkdtemp(
        join(tmpdir(), "chronorift-external-native-"),
      );
      roots.push(workspace);
      await writeFile(
        join(workspace, "project.godot"),
        '[application]\nrun/main_scene="res://main.tscn"\n',
      );
      await writeFile(join(workspace, relativePath), "unsupported\n");
      await expect(prepareLifecycle(workspace)).rejects.toThrow(
        /native|non-GDScript/iu,
      );
    }
  });

  it("rejects a missing main scene and the reserved lifecycle autoload", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "chronorift-external-project-config-"),
    );
    roots.push(workspace);
    await writeFile(join(workspace, "project.godot"), "[application]\n");
    await expect(prepareLifecycle(workspace)).rejects.toThrow(/main_scene/iu);

    await writeFile(
      join(workspace, "project.godot"),
      '[application]\nrun/main_scene="res://main.tscn"\n[autoload]\nChronoRiftLifecycle="*res://probe.gd"\n',
    );
    await expect(prepareLifecycle(workspace)).rejects.toThrow(/autoload/iu);
  });
});
