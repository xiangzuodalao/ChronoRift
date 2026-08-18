import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PROJECT_CAPABILITY_MODULE_NAMES_V1,
  ProjectAdapterRevisionV1Schema,
  asSha256DigestV1,
  asTaskId,
  asWorkspaceId,
} from "@chronorift/domain";
import { afterEach, describe, expect, it } from "vitest";

import { collectCandidateGodotSourceV1 } from "./candidate-godot-build.js";
import { prepareM6ExactGodotBuildV1 } from "./m6-exact-godot-build.js";
import { selectedTreeSha256 } from "./selected-tree.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const sha = (character: string) => asSha256DigestV1(character.repeat(64));

const adapterRevision = ProjectAdapterRevisionV1Schema.parse({
  schemaVersion: 1,
  adapterRevisionId: "adapter-revision:m6:pristine",
  adapterId: "adapter:m6:task-blind",
  sourceId: `source:${sha("1")}`,
  packageDigest: sha("2"),
  manifestDigest: sha("3"),
  implementationDigest: sha("4"),
  payloadSchemaDigest: sha("5"),
  sdkDigest: sha("6"),
  bridgeDigest: sha("7"),
  capabilitySet: {
    schemaVersion: 1,
    modules: PROJECT_CAPABILITY_MODULE_NAMES_V1.map((module) => ({
      schemaVersion: 1,
      module,
      status: "implemented",
      protocolVersion: "project-environment-v1",
      limitations: [],
    })),
  },
  conformanceReceiptId: "conformance:m6:pristine",
  contentByteLength: 100,
  contentFileCount: 2,
});

const createProject = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "chronorift-m6-exact-build-"));
  roots.push(root);
  await mkdir(join(root, "scripts"));
  await writeFile(
    join(root, "project.godot"),
    '[application]\nrun/main_scene="res://main.tscn"\n',
  );
  await writeFile(
    join(root, "main.tscn"),
    '[gd_scene load_steps=2 format=3]\n\n[node name="Main" type="Node"]\n',
  );
  await writeFile(
    join(root, "scripts", "player.gd"),
    "extends Node\nvar speed := 1\n",
  );
  await writeFile(
    join(root, "scripts", "inspector_helper.gd"),
    "@tool\nextends Node\n",
  );
  return root;
};

const request = (workspaceDirectory: string, baselineSourceHash: string) => ({
  taskId: asTaskId("task:m6:external-hidden-fix"),
  workspaceId: asWorkspaceId("workspace:m6:external-hidden-fix"),
  workspaceDirectory,
  baselineSourceHash,
  adapterRevision,
  toolchainReceiptId: "toolchain:m6:godot-4.7.1",
  toolchainArtifactDigest: sha("8"),
  runtimeIdentity: {
    schemaVersion: 1 as const,
    managedRuntimeId: "managed-runtime:m6:godot-4.7.1",
    engineVersion: "4.7.1",
    runtimeArtifactDigest: sha("9"),
    overlayDigest: sha("a"),
  },
  policyProfileDigest: sha("b"),
  now: "2026-08-14T00:00:00.000Z",
});

describe("M6 exact Godot Build preparation", () => {
  it("keeps pristine Adapter provenance separate from exact mutant and candidate source identities", async () => {
    const workspace = await createProject();
    const baselineEntries = await collectCandidateGodotSourceV1(
      workspace,
      "project-environment",
      "tracked-tool-scripts-v1",
    );
    const baselineHash = selectedTreeSha256(baselineEntries);
    const baseline = await prepareM6ExactGodotBuildV1(
      request(workspace, baselineHash),
    );

    expect(baseline.configuredMainScene).toBe("res://main.tscn");
    expect(baseline.build.sourceHash).toBe(baselineHash);
    expect(baseline.build.sourceId).toBe(`source:${baselineHash}`);
    expect(baseline.adapterRevision.sourceId).toBe(adapterRevision.sourceId);
    expect(baseline.adapterRevision.sourceId).not.toBe(baseline.build.sourceId);
    expect(JSON.stringify(baseline)).not.toMatch(/environmentRevision/iu);

    await writeFile(
      join(workspace, "scripts", "player.gd"),
      "extends Node\nvar speed := 2\n",
    );
    const candidateEntries = await collectCandidateGodotSourceV1(
      workspace,
      "project-environment",
      "tracked-tool-scripts-v1",
    );
    const candidateHash = selectedTreeSha256(candidateEntries);
    const candidate = await prepareM6ExactGodotBuildV1(
      request(workspace, baselineHash),
    );
    const repeated = await prepareM6ExactGodotBuildV1({
      ...request(workspace, baselineHash),
      now: "2026-08-14T01:00:00.000Z",
    });

    expect(candidate.build.sourceHash).toBe(candidateHash);
    expect(candidate.build.sourceId).toBe(`source:${candidateHash}`);
    expect(candidate.build.workspaceDiffHash).not.toBe(
      baseline.build.workspaceDiffHash,
    );
    expect(repeated.build.buildId).toBe(candidate.build.buildId);
    expect(repeated.build.buildConfigurationHash).toBe(
      candidate.build.buildConfigurationHash,
    );
  });

  it("rejects a configured main scene that is absent from the exact selected tree", async () => {
    const workspace = await createProject();
    const entries = await collectCandidateGodotSourceV1(
      workspace,
      "project-environment",
      "tracked-tool-scripts-v1",
    );
    const baselineHash = selectedTreeSha256(entries);
    await writeFile(
      join(workspace, "project.godot"),
      '[application]\nrun/main_scene="res://missing.tscn"\n',
    );

    await expect(
      prepareM6ExactGodotBuildV1(request(workspace, baselineHash)),
    ).rejects.toThrow(/main scene.*exact file/iu);
  });

  it("normalizes a uniquely matched selected uid scene into Build identity", async () => {
    const workspace = await createProject();
    await writeFile(
      join(workspace, "project.godot"),
      '[application]\nrun/main_scene="uid://m6buildmain"\n',
    );
    await writeFile(
      join(workspace, "main.tscn"),
      '[gd_scene load_steps=2 format=3 uid="uid://m6buildmain"]\n\n[node name="Main" type="Node"]\n',
    );
    const entries = await collectCandidateGodotSourceV1(
      workspace,
      "project-environment",
      "tracked-tool-scripts-v1",
    );
    const prepared = await prepareM6ExactGodotBuildV1(
      request(workspace, selectedTreeSha256(entries)),
    );

    expect(prepared.configuredMainScene).toBe("res://main.tscn");
  });

  it.each(["missing", "ambiguous"] as const)(
    "rejects a %s selected uid scene",
    async (kind) => {
      const workspace = await createProject();
      await writeFile(
        join(workspace, "project.godot"),
        '[application]\nrun/main_scene="uid://m6buildmissing"\n',
      );
      if (kind === "ambiguous") {
        const scene =
          '[gd_scene format=3 uid="uid://m6buildmissing"]\n\n[node name="Main" type="Node"]\n';
        await writeFile(join(workspace, "main.tscn"), scene);
        await writeFile(join(workspace, "duplicate.tscn"), scene);
      }
      const entries = await collectCandidateGodotSourceV1(
        workspace,
        "project-environment",
        "tracked-tool-scripts-v1",
      );

      await expect(
        prepareM6ExactGodotBuildV1(
          request(workspace, selectedTreeSha256(entries)),
        ),
      ).rejects.toThrow(/uid.*scene|scene.*uid/iu);
    },
  );
});
