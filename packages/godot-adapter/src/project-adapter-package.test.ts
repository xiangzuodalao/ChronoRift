import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, symlink } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  PROJECT_ADAPTER_CAPABILITY_MODULES_V1,
  PROJECT_ADAPTER_MANIFEST_KIND_V1,
  PROJECT_ADAPTER_REQUIRED_MODULES_V1,
  PROJECT_ADAPTER_SCHEMA_DIALECT_V1,
  PROJECT_ADAPTER_SDK_ID_V1,
  validateProjectAdapterPayloadV1,
} from "@chronorift/godot-protocol";
import { describe, expect, it } from "vitest";

import {
  loadProjectAdapterPackageV1,
  loadProjectAdapterPackageFilesV1,
  loadProjectAdapterPackageWithBytesV1,
  ProjectAdapterPackageValidationError,
} from "./project-adapter-package.js";

const hash = (bytes: string): string =>
  createHash("sha256").update(bytes).digest("hex");

const emptySchema = JSON.stringify({
  schemaVersion: 1,
  dialect: PROJECT_ADAPTER_SCHEMA_DIALECT_V1,
  schemaId: "launch.params",
  root: {
    type: "object",
    properties: {},
    required: [],
    additionalProperties: false,
  },
});
const entitySchema = JSON.stringify({
  schemaVersion: 1,
  dialect: PROJECT_ADAPTER_SCHEMA_DIALECT_V1,
  schemaId: "entity.node",
  root: {
    type: "object",
    properties: {},
    required: [],
    additionalProperties: false,
  },
});
const stateSchema = JSON.stringify({
  schemaVersion: 1,
  dialect: PROJECT_ADAPTER_SCHEMA_DIALECT_V1,
  schemaId: "state.world",
  root: {
    type: "object",
    properties: { running: { type: "boolean" } },
    required: ["running"],
    additionalProperties: false,
  },
});
const modules = {
  schemaVersion: 1,
  modules: PROJECT_ADAPTER_CAPABILITY_MODULES_V1.map((module) => {
    const required = PROJECT_ADAPTER_REQUIRED_MODULES_V1.includes(
      module as (typeof PROJECT_ADAPTER_REQUIRED_MODULES_V1)[number],
    );
    return {
      schemaVersion: 1,
      module,
      status: required ? "implemented" : "unsupported",
      protocolVersion: required ? "project-adapter-module:v1" : null,
      limitations: required ? [] : ["not exposed"],
    };
  }),
};

const makeManifest = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    schemaVersion: 1,
    manifestKind: PROJECT_ADAPTER_MANIFEST_KIND_V1,
    adapterId: "project.adapter",
    adapterVersion: "1.0.0",
    sdk: { id: PROJECT_ADAPTER_SDK_ID_V1, version: 1 },
    engine: {
      id: "godot",
      versionRequirement: "4.7.x",
      language: "gdscript",
    },
    entryScript: "src/project_adapter.gd",
    schemas: [
      {
        schemaVersion: 1,
        schemaId: "launch.params",
        path: "schemas/launch.json",
        sha256: hash(emptySchema),
      },
      {
        schemaVersion: 1,
        schemaId: "entity.node",
        path: "schemas/entity.json",
        sha256: hash(entitySchema),
      },
      {
        schemaVersion: 1,
        schemaId: "state.world",
        path: "schemas/state.json",
        sha256: hash(stateSchema),
      },
    ],
    launchTargets: [
      {
        schemaVersion: 1,
        targetId: "main",
        scene: "res://main.tscn",
        default: true,
        parametersSchemaId: "launch.params",
        renderer: "headless",
        requiredModules: [...PROJECT_ADAPTER_REQUIRED_MODULES_V1],
      },
    ],
    modules,
    entityTypes: [
      {
        schemaVersion: 1,
        entityTypeId: "node",
        schemaId: "entity.node",
        identityStrategy: "execution_local",
      },
    ],
    stateDomains: [
      {
        schemaVersion: 1,
        stateDomainId: "world",
        schemaId: "state.world",
        checkpointDisposition: "uncontrolled",
      },
    ],
    eventTypes: [],
    smoke: {
      schemaVersion: 1,
      targetId: "main",
      timeoutMs: 30_000,
      minimumStateSamples: 1,
      minimumEntityLifecycleRecords: 1,
      requiredStateDomainIds: ["world"],
      requiredCustomEventTypeIds: [],
    },
    ...overrides,
  });

const writeFile = async (path: string, bytes: string): Promise<void> => {
  const { writeFile: write } = await import("node:fs/promises");
  await write(path, bytes, { encoding: "utf8", flag: "wx" });
};

const makePackage = async (
  manifest = makeManifest(),
  entry = "extends RefCounted\n",
): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "chronorift-project-adapter-"));
  await mkdir(join(root, "src"));
  await mkdir(join(root, "schemas"));
  await writeFile(join(root, "manifest.json"), manifest);
  await writeFile(join(root, "src/project_adapter.gd"), entry);
  await writeFile(join(root, "schemas/launch.json"), emptySchema);
  await writeFile(join(root, "schemas/entity.json"), entitySchema);
  await writeFile(join(root, "schemas/state.json"), stateSchema);
  return root;
};

describe("ProjectAdapter package validator V1", () => {
  it("loads a strict PE-A package and applies launch expectations at the boundary", async () => {
    const root = await makePackage();
    const loaded = await loadProjectAdapterPackageV1(root, {
      requireSingleLaunchTarget: true,
      expectedMainScene: "res://main.tscn",
      requireEmptyLaunchParameters: true,
    });
    expect(loaded.schemaVersion).toBe(1);
    expect(loaded.manifest.adapterId).toBe("project.adapter");
    expect(loaded.files.map((file) => file.path)).toContain("manifest.json");
    expect(loaded.files.map((file) => file.path)).toContain(
      "src/project_adapter.gd",
    );
    await expect(
      loadProjectAdapterPackageV1(root, {
        expectedMainScene: "res://other.tscn",
      }),
    ).rejects.toThrow(/realized main scene/u);
  });

  it("revalidates immutable published bytes without materializing a candidate", async () => {
    const root = await makePackage();
    const paths = [
      "manifest.json",
      "src/project_adapter.gd",
      "schemas/launch.json",
      "schemas/entity.json",
      "schemas/state.json",
    ];
    const loaded = loadProjectAdapterPackageFilesV1(
      await Promise.all(
        paths.map(async (path) => ({
          path,
          bytes: await readFile(join(root, ...path.split("/"))),
        })),
      ),
      {
        requireSingleLaunchTarget: true,
        expectedMainScene: "res://main.tscn",
        requireEmptyLaunchParameters: true,
      },
    );
    expect(loaded.manifest.adapterId).toBe("project.adapter");
    expect(() =>
      loadProjectAdapterPackageFilesV1([
        { path: "manifest.json", bytes: Buffer.from(makeManifest()) },
        { path: "manifest.json", bytes: Buffer.from(makeManifest()) },
      ]),
    ).toThrow(/paths must be unique/u);
  });

  it("returns defensive copies of the exact bytes from the stable read", async () => {
    const root = await makePackage();
    const loaded = await loadProjectAdapterPackageWithBytesV1(root);
    const entry = loaded.fileBytes.find(
      (file) => file.path === "src/project_adapter.gd",
    );
    expect(entry).toBeDefined();
    expect(Buffer.from(entry?.bytes ?? [])).toEqual(
      await readFile(join(root, "src/project_adapter.gd")),
    );
    expect(
      createHash("sha256")
        .update(Buffer.from(entry?.bytes ?? new Uint8Array()))
        .digest("hex"),
    ).toBe(
      loaded.files.find((file) => file.path === "src/project_adapter.gd")
        ?.sha256,
    );

    if (entry !== undefined) entry.bytes[0] = 0;
    expect(await readFile(join(root, "src/project_adapter.gd"))).toEqual(
      Buffer.from("extends RefCounted\n", "utf8"),
    );
  });

  it("rejects schema corruption and forbidden GDScript features", async () => {
    const badHash = await makePackage(
      makeManifest({
        schemas: [
          {
            schemaVersion: 1,
            schemaId: "launch.params",
            path: "schemas/launch.json",
            sha256: "a".repeat(64),
          },
          {
            schemaVersion: 1,
            schemaId: "entity.node",
            path: "schemas/entity.json",
            sha256: hash(entitySchema),
          },
          {
            schemaVersion: 1,
            schemaId: "state.world",
            path: "schemas/state.json",
            sha256: hash(stateSchema),
          },
        ],
      }),
    );
    await expect(loadProjectAdapterPackageV1(badHash)).rejects.toThrow(
      /hash does not match/u,
    );
    const tool = await makePackage(
      makeManifest(),
      "@tool\nextends RefCounted\n",
    );
    await expect(loadProjectAdapterPackageV1(tool)).rejects.toThrow(
      /forbidden @tool/u,
    );
  });

  it("rejects symlinks instead of following them", async () => {
    const root = await makePackage();
    await symlink("src/project_adapter.gd", join(root, "src/linked.gd"));
    const failure = await loadProjectAdapterPackageV1(root).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ProjectAdapterPackageValidationError);
    expect((failure as Error).message).toMatch(/cannot contain symlinks/u);
  });

  it("rejects traversal paths and filesystem special files", async () => {
    expect(() =>
      loadProjectAdapterPackageFilesV1([
        { path: "../manifest.json", bytes: Buffer.from("{}") },
      ]),
    ).toThrow(/normalized relative paths/u);

    const root = await makePackage();
    const socketPath = join(root, "src/runtime.gd");
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    try {
      await expect(loadProjectAdapterPackageV1(root)).rejects.toThrow(
        /cannot contain special files/u,
      );
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) =>
          error === undefined ? resolve() : reject(error),
        );
      });
    }
  });

  it("loads the GN-1 adapter and enforces its platform geometry payload", async () => {
    const root = join(
      process.cwd(),
      "testdata/vnext/external-project/moddable-platformer-platform-alias-adapter",
    );
    const loaded = await loadProjectAdapterPackageWithBytesV1(root, {
      requireSingleLaunchTarget: true,
      expectedMainScene: "res://main.tscn",
      requireEmptyLaunchParameters: true,
    });
    expect(loaded.manifest).toMatchObject({
      adapterId: "moddable_platformer.platform_alias",
      eventTypes: [],
      entityTypes: [{ entityTypeId: "platform", identityStrategy: "authored" }],
      stateDomains: [{ stateDomainId: "platform_geometry" }],
    });
    expect(loaded.fileBytes.map((file) => file.path)).toEqual(
      [...loaded.fileBytes.map((file) => file.path)].sort((left, right) =>
        left.localeCompare(right, "en-US"),
      ),
    );

    const stateSchema = loaded.schemas.find(
      (schema) => schema.schemaId === "state.platform_geometry",
    );
    expect(stateSchema).toBeDefined();
    const observed = {
      platforms: [
        {
          node_path: "Platforms/Platform3",
          configured_width_tiles: 3,
          rendered_sprite_count: 3,
          one_way: true,
          fall_time_seconds: 2,
          solid_shape_instance_id: "1234",
          solid_collision_width_px: 384,
          area_shape_instance_id: "5678",
          area_collision_width_px: 768,
        },
      ],
    };
    expect(validateProjectAdapterPayloadV1(stateSchema!, observed)).toEqual(
      observed,
    );
    expect(() =>
      validateProjectAdapterPayloadV1(stateSchema!, {
        ...observed,
        platforms: [
          {
            ...observed.platforms[0],
            area_shape_instance_id: 5678,
          },
        ],
      }),
    ).toThrow(/expected string/u);
  });
});
