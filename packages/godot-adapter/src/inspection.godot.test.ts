import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import type {
  InspectionQueryInputV1,
  InspectionQueryResultV1,
} from "@chronorift/domain";
import { GODOT_INSPECTION_OVERLAY_FILES_V1 } from "./inspection-runtime-assets.js";
import { createGodotInspectionSidecarSource } from "./inspection-sidecar-source.js";
import { GodotInspectionWireClient } from "./inspection-wire-client.js";

type QueryFields = { readonly target?: InspectionQueryInputV1["target"] } & (
  | {
      readonly select: "children" | "properties";
      readonly offset?: number;
      readonly limit?: number;
    }
  | { readonly select: "values"; readonly names: string[] }
);

const objectValue = (
  result: InspectionQueryResultV1,
  name: string,
): { objectRef: string } => {
  if (result.select !== "values") throw new Error("Expected values");
  const item = result.values.find((value) => value.name === name);
  if (
    item?.status !== "success" ||
    item.value === null ||
    typeof item.value !== "object" ||
    Array.isArray(item.value) ||
    !("objectRef" in item.value) ||
    typeof item.value.objectRef !== "string"
  )
    throw new Error("Expected an object reference");
  return { objectRef: item.value.objectRef };
};

it("inspects shared Shape identity, widths, vectors, pagination, missing values and weak object lifetimes without a project adapter", async () => {
  const root = await mkdtemp(join(tmpdir(), "chronorift-inspection-godot-"));
  let child: ReturnType<typeof spawn> | undefined;
  let client: GodotInspectionWireClient | undefined;
  try {
    for (const file of GODOT_INSPECTION_OVERLAY_FILES_V1) {
      await mkdir(dirname(join(root, file.relativePath)), { recursive: true });
      await writeFile(join(root, file.relativePath), file.bytes);
    }
    await writeFile(
      join(root, "project.godot"),
      '[application]\nconfig/name="Inspection"\nrun/main_scene="res://main.tscn"\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n',
    );
    await writeFile(
      join(root, "main.tscn"),
      '[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path="res://main.gd" id="1"]\n[node name="World" type="Node2D"]\nscript = ExtResource("1")\n',
    );
    await writeFile(
      join(root, "platform.gd"),
      "extends Node2D\n@export var width := 100.0\n",
    );
    await writeFile(
      join(root, "main.gd"),
      `extends Node2D
var ephemeral: RefCounted = RefCounted.new()
var huge: int = 9223372036854775807
var transform_value := Transform2D.IDENTITY
var long_value := "x".repeat(20000)
var nested := {"ok": Vector3(1, 2, 3), "unsupported": Transform2D.IDENTITY}
var wide: Array = []
var cyclic: Array = []
var fill_scene: bool:
  get:
    for index in range(16384):
      var item := Node.new()
      item.name = "Budget" + str(index)
      add_child(item)
    return true
func _get_property_list() -> Array[Dictionary]:
  return [{"name": "literal:name", "type": TYPE_INT}]
func _get(property_name: StringName) -> Variant:
  return 42 if property_name == "literal:name" else null
var release_ephemeral: bool:
  get:
    ephemeral = null
    return true
var split_shape: bool:
  get:
    $PlatformB/SolidShape.shape = $PlatformB/SolidShape.shape.duplicate()
    $PlatformB/SolidShape.shape.size = Vector2(300, 20)
    return true
func _ready() -> void:
  for index in range(256):
    var row: Array = []
    row.resize(256)
    row.fill(0)
    wide.append(row)
  cyclic.append(cyclic)
  var shape := RectangleShape2D.new()
  shape.size = Vector2(200, 20)
  for index in range(2):
    var platform: Node2D = load("res://platform.gd").new()
    platform.name = "PlatformA" if index == 0 else "PlatformB"
    platform.width = 100.0 if index == 0 else 200.0
    var collision := CollisionShape2D.new()
    collision.name = "SolidShape"
    collision.shape = shape
    platform.add_child(collision)
    add_child(platform)
  print("inspection fixture ready")
`,
    );
    const source = createGodotInspectionSidecarSource({
      godotExecutable:
        process.env.CHRONORIFT_TEST_GODOT_BIN ??
        join(
          process.cwd(),
          ".tools/godot/4.7.1/Godot_v4.7.1-stable_linux.x86_64",
        ),
      projectRoot: root,
      executionId: "inspection.test",
      importTimeoutMs: 15_000,
      executionTimeoutMs: 30_000,
      startupTimeoutMs: 5_000,
    });
    child = spawn(process.execPath, ["-e", source], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const processHandle = child;
    if (processHandle.stdout === null || processHandle.stdin === null)
      throw new Error("Missing sidecar streams");
    const input = processHandle.stdin;
    client = new GodotInspectionWireClient({
      readable: processHandle.stdout,
      write: (bytes) =>
        new Promise<void>((resolve, reject) =>
          input.write(bytes, (error) =>
            error === null || error === undefined ? resolve() : reject(error),
          ),
        ),
      close: async () => {
        input.end();
      },
    });
    const runtime = client;
    const ready = await runtime.ready(20_000).catch(async (error: unknown) => {
      const termination = await runtime.termination.catch(() => undefined);
      throw new Error(`${String(error)} ${JSON.stringify(termination)}`);
    });
    expect(ready.scene).toBe("res://main.tscn");
    expect(ready.root.path).toBe(".");
    const query = (fields: QueryFields) =>
      runtime.query({
        schemaVersion: 1,
        executionId: "inspection.test",
        ...fields,
      } as InspectionQueryInputV1);
    const children = await query({ select: "children", limit: 1 });
    expect(children).toMatchObject({
      select: "children",
      total: 2,
      offset: 0,
      items: [
        {
          name: "PlatformA",
          path: "PlatformA",
          scriptPath: "res://platform.gd",
          childCount: 1,
        },
      ],
    });
    expect(
      await query({ select: "children", offset: 1, limit: 1 }),
    ).toMatchObject({ items: [{ name: "PlatformB" }] });
    expect(
      await query({
        select: "values",
        target: { path: "PlatformA" },
        names: ["width"],
      }),
    ).toMatchObject({
      values: [{ name: "width", status: "success", value: 100 }],
    });
    const properties = await query({
      select: "properties",
      target: { path: "PlatformA" },
    });
    expect(properties.select).toBe("properties");
    if (properties.select !== "properties")
      throw new Error("Expected property descriptors");
    expect(properties.items).toContainEqual({ name: "width", type: "float" });
    const first = objectValue(
      await query({
        select: "values",
        target: { path: "PlatformA/SolidShape" },
        names: ["shape"],
      }),
      "shape",
    );
    const second = objectValue(
      await query({
        select: "values",
        target: { path: "PlatformB/SolidShape" },
        names: ["shape"],
      }),
      "shape",
    );
    expect(first).toEqual(second);
    expect(
      await query({ select: "values", target: first, names: ["size"] }),
    ).toMatchObject({
      values: [{ value: { $type: "vector2", x: 200, y: 20 } }],
    });
    await query({ select: "values", names: ["split_shape"] });
    const split = objectValue(
      await query({
        select: "values",
        target: { path: "PlatformB/SolidShape" },
        names: ["shape"],
      }),
      "shape",
    );
    expect(split).not.toEqual(first);
    expect(
      await query({ select: "values", target: split, names: ["size"] }),
    ).toMatchObject({
      values: [{ value: { $type: "vector2", x: 300, y: 20 } }],
    });
    const ephemeral = objectValue(
      await query({ select: "values", names: ["ephemeral"] }),
      "ephemeral",
    );
    await query({ select: "values", names: ["release_ephemeral"] });
    await expect(
      query({ select: "properties", target: ephemeral }),
    ).rejects.toThrow("object_not_found");
    const values = await query({
      select: "values",
      names: ["huge", "absent", "transform_value", "long_value", "nested"],
    });
    expect(
      await query({
        select: "values",
        names: ["wide", "cyclic", "literal:name"],
      }),
    ).toMatchObject({
      values: [
        { name: "wide", status: "truncated" },
        { name: "cyclic", status: "truncated" },
        { name: "literal:name", status: "success", value: 42 },
      ],
    });
    expect(values).toMatchObject({
      values: [
        {
          name: "huge",
          status: "success",
          value: { $type: "int64", value: "9223372036854775807" },
        },
        { name: "absent", status: "missing" },
        { name: "transform_value", status: "unsupported" },
        { name: "long_value", status: "truncated" },
        {
          name: "nested",
          status: "success",
          value: {
            ok: { $type: "vector3", x: 1, y: 2, z: 3 },
            unsupported: { $type: "unsupported", type: "Transform2D" },
          },
        },
      ],
    });
    await query({ select: "values", names: ["fill_scene"] });
    let exhausted = false;
    for (let offset = 0; offset < 16600; offset += 200) {
      try {
        await query({ select: "children", offset, limit: 200 });
      } catch (error) {
        expect(String(error)).toContain("budget_exhausted");
        exhausted = true;
        break;
      }
    }
    expect(exhausted).toBe(true);
    expect(
      await query({ select: "values", names: ["literal:name"] }),
    ).toMatchObject({ values: [{ status: "success", value: 42 }] });
    const terminal = await runtime.stop();
    expect(terminal.import).toMatchObject({ exitCode: 0, timedOut: false });
    expect(terminal.run?.stdout).toContain("inspection fixture ready");
    expect(terminal.run?.stderr).not.toContain("SCRIPT ERROR");
  } finally {
    child?.kill("SIGKILL");
    await client?.close();
    await rm(root, { recursive: true, force: true });
  }
}, 45_000);

it.each(["natural_exit", "timeout"] as const)(
  "preserves bounded process streams and actual %s status",
  async (mode) => {
    const root = await mkdtemp(join(tmpdir(), "chronorift-inspection-status-"));
    let child: ReturnType<typeof spawn> | undefined;
    let client: GodotInspectionWireClient | undefined;
    try {
      for (const file of GODOT_INSPECTION_OVERLAY_FILES_V1) {
        await mkdir(dirname(join(root, file.relativePath)), {
          recursive: true,
        });
        await writeFile(join(root, file.relativePath), file.bytes);
      }
      await writeFile(
        join(root, "project.godot"),
        '[application]\nconfig/name="Inspection status"\nrun/main_scene="res://main.tscn"\n',
      );
      await writeFile(
        join(root, "main.tscn"),
        '[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path="res://main.gd" id="1"]\n[node name="World" type="Node"]\nscript=ExtResource("1")\n',
      );
      await writeFile(
        join(root, "main.gd"),
        `extends Node
func _ready() -> void:
  print("stdout-prefix" + "x".repeat(40000))
  printerr("stderr-prefix" + "y".repeat(40000))
${mode === "natural_exit" ? "  await get_tree().create_timer(0.5).timeout\n  get_tree().quit(7)\n" : ""}`,
      );
      child = spawn(
        process.execPath,
        [
          "-e",
          createGodotInspectionSidecarSource({
            godotExecutable:
              process.env.CHRONORIFT_TEST_GODOT_BIN ??
              join(
                process.cwd(),
                ".tools/godot/4.7.1/Godot_v4.7.1-stable_linux.x86_64",
              ),
            projectRoot: root,
            executionId: "inspection.status",
            importTimeoutMs: 15_000,
            executionTimeoutMs: mode === "timeout" ? 2_000 : 10_000,
            startupTimeoutMs: 5_000,
          }),
        ],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      const processHandle = child;
      if (processHandle.stdout === null || processHandle.stdin === null)
        throw new Error("Missing streams");
      const input = processHandle.stdin;
      client = new GodotInspectionWireClient({
        readable: processHandle.stdout,
        write: (bytes) =>
          new Promise<void>((resolve, reject) =>
            input.write(bytes, (error) => (error ? reject(error) : resolve())),
          ),
        close: async () => {
          input.end();
        },
      });
      await client.ready(20_000);
      const terminal = await client.termination;
      expect(terminal.import?.exitCode).toBe(0);
      expect(terminal.run?.timedOut).toBe(mode === "timeout");
      if (mode === "natural_exit") expect(terminal.run?.exitCode).toBe(7);
      expect(terminal.run?.stdoutTruncated).toBe(true);
      expect(terminal.run?.stderrTruncated).toBe(true);
      expect(terminal.run?.stdout).toContain("stdout-prefix");
      expect(terminal.run?.stderr).toContain("stderr-prefix");
      expect(Buffer.byteLength(terminal.run?.stdout ?? "")).toBeLessThanOrEqual(
        32768,
      );
      expect(Buffer.byteLength(terminal.run?.stderr ?? "")).toBeLessThanOrEqual(
        32768,
      );
    } finally {
      child?.kill("SIGKILL");
      await client?.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);
