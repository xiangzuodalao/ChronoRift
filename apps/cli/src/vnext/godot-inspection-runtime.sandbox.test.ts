import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  InspectionLaunchOutputV1Schema,
  InspectionQueryOutputV1Schema,
  InspectionStopOutputV1Schema,
  InspectionToolResponseV1Schema,
  type InspectionToolNameV1,
} from "@chronorift/domain";
import { expect, it } from "vitest";

import { GodotInspectionRuntime } from "./godot-inspection-runtime.js";
import { SrtGodotRunner } from "./srt-godot-runner.js";
import { SrtSandboxController } from "./srt-sandbox-controller.js";

const mainScript = (independent: boolean): string => `extends Node
var source_write_blocked := false
var texture_width := preload("res://assets/icon.svg").get_width()
var import_metadata_write_blocked := false
var cache_write_allowed := false
var temporary: Node
func _ready() -> void:
    print("bounded-output-check:" + "x".repeat(40000))
    source_write_blocked = FileAccess.open("res://platform.gd", FileAccess.WRITE) == null
    import_metadata_write_blocked = FileAccess.open("res://assets/icon.svg.import", FileAccess.WRITE) == null
    var cache_file := FileAccess.open("res://.godot/runtime-write-check", FileAccess.WRITE)
    cache_write_allowed = cache_file != null
    if cache_file != null:
        cache_file.store_string("runtime cache remains writable")
        cache_file.close()
    var shared := RectangleShape2D.new()
    for width in [80.0, 160.0]:
        var body := preload("res://platform.gd").new()
        body.name = "Platform" + str(int(width))
        body.width = width
        var collision := CollisionShape2D.new()
        collision.name = "Collision"
        collision.shape = ${independent ? "shared.duplicate()" : "shared"}
        collision.shape.size = Vector2(width, 20)
        body.add_child(collision)
        add_child(body)
    temporary = Node.new()
    temporary.name = "Transient"
    add_child(temporary)
    get_tree().create_timer(2.0).timeout.connect(func(): temporary.queue_free())
`;

it("inspects live GN-1-shaped resource aliases without an Adapter and restarts from edited source in SRT", async () => {
  const configuredGodot = process.env.GODOT_BIN;
  if (configuredGodot === undefined)
    throw new Error("GODOT_BIN is required for the inspection sandbox test");
  const root = await mkdtemp(join(tmpdir(), "chronorift-inspection-sandbox-"));
  const candidate = join(root, "candidate");
  await mkdir(candidate);
  await writeFile(
    join(candidate, "project.godot"),
    'config_version=5\n[application]\nrun/main_scene="res://main.tscn"\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n',
  );
  await writeFile(
    join(candidate, "main.tscn"),
    '[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path="res://main.gd" id="1"]\n[node name="Main" type="Node"]\nscript = ExtResource("1")\n',
  );
  await writeFile(join(candidate, "main.gd"), mainScript(false));
  await mkdir(join(candidate, "assets"));
  await writeFile(
    join(candidate, "assets/icon.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="red"/></svg>',
  );
  await writeFile(
    join(candidate, "platform.gd"),
    "extends StaticBody2D\n@export var width: float = 0\n",
  );
  const controller = new SrtSandboxController();
  const runtime = new GodotInspectionRuntime({
    runner: new SrtGodotRunner({
      controller,
      candidateWorkspace: candidate,
      validationRoot: join(root, "stages"),
    }),
    candidateWorkspace: candidate,
    artifactsDirectory: join(root, "records"),
    nodePath: await realpath(process.execPath),
    godotPath: await realpath(configuredGodot),
  });
  const invoke = async (toolName: InspectionToolNameV1, input: unknown) => {
    const response = InspectionToolResponseV1Schema.parse(
      await runtime.invoke({
        schemaVersion: 1,
        toolCallId: "sandbox-test",
        toolName,
        input,
      }),
    );
    if (response.outcome !== "success")
      throw new Error(
        `${JSON.stringify(response)}\n${JSON.stringify(runtime.records())}`,
      );
    return response.output;
  };
  const values = async (
    executionId: string,
    target: { path: string } | { objectRef: string },
    names: string[],
  ) => {
    const output = InspectionQueryOutputV1Schema.parse(
      await invoke("game_query", {
        schemaVersion: 1,
        executionId,
        target,
        select: "values",
        names,
      }),
    );
    if (output.select !== "values")
      throw new Error("Expected value observations");
    return output.values;
  };
  const shapeRef = async (
    executionId: string,
    path: string,
  ): Promise<string> => {
    const result = (await values(executionId, { path }, ["shape"]))[0];
    expect(result).toMatchObject({
      status: "success",
      value: { $type: "object", className: "RectangleShape2D" },
    });
    if (
      result?.status !== "success" ||
      typeof result.value !== "object" ||
      result.value === null ||
      Array.isArray(result.value) ||
      typeof result.value.objectRef !== "string"
    )
      throw new Error("Shape observation omitted its reference");
    return result.value.objectRef;
  };
  try {
    const first = InspectionLaunchOutputV1Schema.parse(
      await invoke("game_launch", { schemaVersion: 1 }),
    );
    expect(
      (await values(first.executionId, { path: "." }, ["texture_width"]))[0],
    ).toMatchObject({ status: "success", value: 8 });
    expect(
      await values(first.executionId, { path: "." }, [
        "import_metadata_write_blocked",
        "cache_write_allowed",
      ]),
    ).toMatchObject([
      { status: "success", value: true },
      { status: "success", value: true },
    ]);
    expect(
      (
        await values(first.executionId, { path: "." }, ["source_write_blocked"])
      )[0],
    ).toMatchObject({ status: "success", value: true });
    expect(
      (await values(first.executionId, { path: "Platform80" }, ["width"]))[0],
    ).toMatchObject({ status: "success", value: 80 });
    const shared = await shapeRef(first.executionId, "Platform80/Collision");
    expect(await shapeRef(first.executionId, "Platform160/Collision")).toBe(
      shared,
    );
    expect(
      (await values(first.executionId, { objectRef: shared }, ["size"]))[0],
    ).toMatchObject({
      status: "success",
      value: { $type: "vector2", x: 160, y: 20 },
    });
    const transient = (
      await values(first.executionId, { path: "." }, ["temporary"])
    )[0];
    if (
      transient?.status !== "success" ||
      typeof transient.value !== "object" ||
      transient.value === null ||
      Array.isArray(transient.value) ||
      typeof transient.value.objectRef !== "string"
    )
      throw new Error("Transient node did not return an object reference");
    const transientRef = transient.value.objectRef;
    await expect
      .poll(
        async () => {
          const response = InspectionToolResponseV1Schema.parse(
            await runtime.invoke({
              schemaVersion: 1,
              toolCallId: "stale-ref",
              toolName: "game_query",
              input: {
                schemaVersion: 1,
                executionId: first.executionId,
                target: { objectRef: transientRef },
                select: "properties",
              },
            }),
          );
          return response.outcome === "error" ? response.error.code : "present";
        },
        { timeout: 5_000, interval: 100 },
      )
      .toBe("object_not_found");
    await writeFile(join(candidate, "main.gd"), mainScript(true));
    expect(await shapeRef(first.executionId, "Platform80/Collision")).toBe(
      shared,
    );
    const firstStop = InspectionStopOutputV1Schema.parse(
      await invoke("game_stop", {
        schemaVersion: 1,
        executionId: first.executionId,
      }),
    );
    expect(firstStop.record).toMatchObject({
      sourceUnchanged: true,
      import: { exitCode: 0 },
      run: { stdoutTruncated: true },
      error: null,
    });
    expect(await readFile(join(candidate, "platform.gd"), "utf8")).toBe(
      "extends StaticBody2D\n@export var width: float = 0\n",
    );
    const second = InspectionLaunchOutputV1Schema.parse(
      await invoke("game_launch", { schemaVersion: 1 }),
    );
    expect(second.sourceSha256).not.toBe(first.sourceSha256);
    const independent = await shapeRef(
      second.executionId,
      "Platform80/Collision",
    );
    expect(
      await shapeRef(second.executionId, "Platform160/Collision"),
    ).not.toBe(independent);
    expect(
      (
        await values(second.executionId, { objectRef: independent }, ["size"])
      )[0],
    ).toMatchObject({
      status: "success",
      value: { $type: "vector2", x: 80, y: 20 },
    });
    const foreign = InspectionToolResponseV1Schema.parse(
      await runtime.invoke({
        schemaVersion: 1,
        toolCallId: "foreign",
        toolName: "game_query",
        input: {
          schemaVersion: 1,
          executionId: second.executionId,
          target: { objectRef: shared },
          select: "properties",
        },
      }),
    );
    expect(foreign).toMatchObject({
      outcome: "error",
      error: { code: "object_not_found" },
    });
    const secondStop = InspectionStopOutputV1Schema.parse(
      await invoke("game_stop", {
        schemaVersion: 1,
        executionId: second.executionId,
      }),
    );
    expect(secondStop.record.sourceUnchanged).toBe(true);
    expect(secondStop.record.import?.stderr).toBe("");
    expect(secondStop.record.run?.stderr).toBe("");
  } finally {
    await runtime.close();
    await controller.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("preserves user override settings alongside the Host observer in a readonly SRT launch", async () => {
  const configuredGodot = process.env.GODOT_BIN;
  if (configuredGodot === undefined)
    throw new Error("GODOT_BIN is required for the inspection sandbox test");
  const root = await mkdtemp(join(tmpdir(), "chronorift-override-sandbox-"));
  const candidate = join(root, "candidate");
  await mkdir(candidate);
  const project =
    'config_version=5\n[application]\nrun/main_scene="res://fallback.tscn"\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n';
  const override =
    '; Original user configuration remains intact.\n[application]\nrun/main_scene="res://main.tscn"\n[autoload]\nUserState="*res://state.gd"\n[custom]\nmarker="user-override"\n[input]\ninspect_action={"deadzone": 0.5, "events": [Object(InputEventKey, "physical_keycode": 81)]}\n';
  await writeFile(join(candidate, "project.godot"), project);
  await writeFile(join(candidate, "override.cfg"), override);
  await writeFile(
    join(candidate, "fallback.tscn"),
    '[gd_scene format=3]\n[node name="Fallback" type="Node"]\n',
  );
  await writeFile(
    join(candidate, "main.tscn"),
    '[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path="res://main.gd" id="1"]\n[node name="Main" type="Node"]\nscript = ExtResource("1")\n',
  );
  await writeFile(
    join(candidate, "state.gd"),
    "extends Node\nvar marker := 41\n",
  );
  await writeFile(
    join(candidate, "main.gd"),
    `extends Node
var physical_key: int = 0
var user_autoload_marker: int = 0
var config_marker: String = ""
var override_write_blocked := false
func _ready() -> void:
    physical_key = InputMap.action_get_events("inspect_action")[0].physical_keycode
    user_autoload_marker = get_node("/root/UserState").marker
    config_marker = ProjectSettings.get_setting("custom/marker")
    override_write_blocked = FileAccess.open("res://override.cfg", FileAccess.WRITE) == null
`,
  );
  const controller = new SrtSandboxController();
  const runtime = new GodotInspectionRuntime({
    runner: new SrtGodotRunner({
      controller,
      candidateWorkspace: candidate,
      validationRoot: join(root, "stages"),
    }),
    candidateWorkspace: candidate,
    artifactsDirectory: join(root, "records"),
    nodePath: await realpath(process.execPath),
    godotPath: await realpath(configuredGodot),
  });
  const invoke = async (toolName: InspectionToolNameV1, input: unknown) => {
    const response = InspectionToolResponseV1Schema.parse(
      await runtime.invoke({
        schemaVersion: 1,
        toolCallId: "override-sandbox-test",
        toolName,
        input,
      }),
    );
    if (response.outcome !== "success")
      throw new Error(
        `${JSON.stringify(response)}\n${JSON.stringify(runtime.records())}`,
      );
    return response.output;
  };
  try {
    const launch = InspectionLaunchOutputV1Schema.parse(
      await invoke("game_launch", { schemaVersion: 1 }),
    );
    const query = InspectionQueryOutputV1Schema.parse(
      await invoke("game_query", {
        schemaVersion: 1,
        executionId: launch.executionId,
        target: { path: "." },
        select: "values",
        names: [
          "physical_key",
          "user_autoload_marker",
          "config_marker",
          "override_write_blocked",
        ],
      }),
    );
    if (query.select !== "values") throw new Error("Expected values");
    expect(query.values).toMatchObject([
      { status: "success", value: 81 },
      { status: "success", value: 41 },
      { status: "success", value: "user-override" },
      { status: "success", value: true },
    ]);
    const stop = InspectionStopOutputV1Schema.parse(
      await invoke("game_stop", {
        schemaVersion: 1,
        executionId: launch.executionId,
      }),
    );
    expect(stop.record).toMatchObject({
      sourceUnchanged: true,
      import: { exitCode: 0, stderr: "" },
      run: { stderr: "" },
      error: null,
    });
    expect(await readFile(join(candidate, "project.godot"), "utf8")).toBe(
      project,
    );
    expect(await readFile(join(candidate, "override.cfg"), "utf8")).toBe(
      override,
    );
  } finally {
    await runtime.close();
    await controller.close();
    await rm(root, { recursive: true, force: true });
  }
});
