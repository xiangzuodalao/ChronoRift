import { execFileSync } from "node:child_process";

import { expect, it } from "vitest";

import { GODOT_MCP_SUPERVISOR } from "./godot-mcp-supervisor.js";

// Run the actual lifecycle functions with in-memory MCP replies. The supervisor
// entrypoint and all process creation are disabled: this never launches Godot.
const RUNNER = String.raw`
import ast, asyncio, contextlib, json, os, sys, types
spec = json.load(sys.stdin)
for name in ("mcp", "mcp.client", "mcp.client.stdio"):
    sys.modules[name] = types.ModuleType(name)
sys.modules["mcp"].ClientSession = object
sys.modules["mcp"].StdioServerParameters = object
sys.modules["mcp.client.stdio"].stdio_client = object
sys.argv = ["supervisor", "/fake/run", "/fake/project", "/fake/godot", "/fake/xvfb"]
tree = ast.parse(spec["supervisor"])
assert ast.unparse(tree.body[-1]) == "asyncio.run(managed_main())"
tree.body.pop()
namespace = {}
exec(compile(tree, "supervisor", "exec"), namespace)
calls, replies, spawns = [], [], []
responses = iter(spec["responses"])
class FakeSession:
    async def call_tool(self, name, arguments):
        calls.append({"name": name, "arguments": arguments})
        response = next(responses)
        assert response["name"] == name, (response["name"], name)
        if response.get("timeout"):
            raise TimeoutError(response.get("error", ""))
        return types.SimpleNamespace(
            isError=response.get("isError", False),
            structuredContent={"data": response["value"]},
            content=[types.SimpleNamespace(type="text", text="upstream refused")])
@contextlib.asynccontextmanager
async def client():
    yield FakeSession()
class FakeEditor:
    returncode = None
    async def wait(self):
        await asyncio.Future()
async def spawn(*args, **kwargs):
    spawns.append({"args": args, "env": kwargs.get("env")})
    return FakeEditor()
async def reject_subprocess(*args, **kwargs):
    raise RuntimeError("Real subprocess creation is disabled in this test")
@contextlib.asynccontextmanager
async def timeout(seconds):
    # These receipt tests use immediate replies, not the Python 3.12 runtime
    # clock. The Node runner still bounds the whole test process to five seconds.
    yield
asyncio.create_subprocess_exec = reject_subprocess
asyncio.timeout = timeout
namespace.update(client=client, spawn=spawn, emit=replies.append)
os.environ["CHRONORIFT_GODOT_DATA_HOME"] = "/fake/task-data"
os.environ["CHRONORIFT_RESTORE_SCENE"] = spec.get("restore", "")
asyncio.run(namespace["control"]({"id": "test", "command": {"op": spec["op"]}}))
print(json.dumps({"calls": calls, "replies": replies, "spawns": spawns}))
`;

interface Reply {
  name: string;
  value: unknown;
  isError?: boolean;
  timeout?: boolean;
  error?: string;
}

function control(op: "save" | "start_editor", responses: Reply[]) {
  return JSON.parse(
    execFileSync("/usr/bin/python3", ["-I", "-c", RUNNER], {
      input: JSON.stringify({
        supervisor: GODOT_MCP_SUPERVISOR,
        op,
        responses,
        restore: "res://a.tscn",
      }),
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin" },
      timeout: 5_000,
    }),
  ) as {
    calls: { name: string; arguments: Record<string, unknown> }[];
    replies: { ok: boolean; value?: unknown; error?: string }[];
    spawns: { args: string[]; env: Record<string, string> }[];
  };
}

const beforeSave = (): Reply[] => [
  { name: "project_manage", value: { stopped: true } },
  {
    name: "scene_manage",
    value: { scenes: ["res://a.tscn"], current_scene: "res://a.tscn" },
  },
];
const opened = (): Reply => ({
  name: "scene_open",
  value: { path: "res://a.tscn", switched: true, settle: "already_current" },
});

it("confirms each scene switch and save before issuing the lifecycle save receipt", () => {
  const result = control("save", [
    ...beforeSave(),
    opened(),
    { name: "scene_save", value: { path: "res://a.tscn" } },
  ]);
  expect(result.replies).toEqual([
    { id: "test", ok: true, value: { activeScene: "res://a.tscn" } },
  ]);
  expect(result.calls.map((call) => call.name)).toEqual([
    "project_manage",
    "scene_manage",
    "scene_open",
    "scene_save",
  ]);
  expect(result.spawns).toEqual([]);
});

it.each([
  { path: "res://a.tscn", switched: false, settle: "timeout" },
  { path: "res://other.tscn", switched: true },
  { path: "res://a.tscn" },
])("does not save or acknowledge an unconfirmed scene switch: %j", (value) => {
  const result = control("save", [
    ...beforeSave(),
    { name: "scene_open", value },
  ]);
  expect(result.replies[0]).toMatchObject({
    ok: false,
    error: "Editor did not confirm switching to scene: res://a.tscn",
  });
  expect(result.calls.some((call) => call.name === "scene_save")).toBe(false);
});

it.each([{ path: "res://other.tscn" }, {}])(
  "rejects a save receipt for a different or missing scene: %j",
  (value) => {
    const result = control("save", [
      ...beforeSave(),
      opened(),
      { name: "scene_save", value },
    ]);
    expect(result.replies[0]).toMatchObject({
      ok: false,
      error: "Editor did not confirm saving scene: res://a.tscn",
    });
  },
);

it("requires a confirmed stop and a complete open-scene inventory", () => {
  const notStopped = control("save", [
    { name: "project_manage", value: { stopped: false } },
  ]);
  expect(notStopped.replies[0]).toMatchObject({ ok: false });
  expect(notStopped.calls).toHaveLength(1);
  const noInventory = control("save", [
    beforeSave()[0]!,
    { name: "scene_manage", value: {} },
  ]);
  expect(noInventory.replies[0]).toMatchObject({
    ok: false,
    error: "Editor returned an invalid open-scene inventory",
  });
  const unnamed = control("save", [
    beforeSave()[0]!,
    { name: "scene_manage", value: { scenes: [""], current_scene: "" } },
  ]);
  expect(unnamed.replies[0]).toMatchObject({
    ok: false,
    error: "Unnamed editor scene cannot be saved automatically",
  });
});

it("does not acknowledge an upstream save error even with a matching path", () => {
  const result = control("save", [
    ...beforeSave(),
    opened(),
    { name: "scene_save", value: { path: "res://a.tscn" }, isError: true },
  ]);
  expect(result.replies[0]?.ok).toBe(false);
  expect(result.replies[0]?.error).toContain("upstream refused");
});

it.each([true, false])(
  "requires a confirmed restored-scene switch during startup (switched=%s)",
  (switched) => {
    const result = control("start_editor", [
      { name: "editor_state", value: { project_name: "test" } },
      { name: "scene_open", value: { path: "res://a.tscn", switched } },
    ]);
    expect(result.replies[0]?.ok).toBe(switched);
    expect(result.spawns[0]?.env.XDG_DATA_HOME).toBe("/fake/task-data");
    expect(result.spawns[0]?.env).not.toHaveProperty(
      "CHRONORIFT_GODOT_DATA_HOME",
    );
    if (!switched)
      expect(result.replies[0]?.error).toContain("did not confirm switching");
  },
);

it.each([
  {
    op: "save" as const,
    responses: [
      ...beforeSave(),
      opened(),
      { name: "scene_save", value: {}, timeout: true },
    ],
    message: "Lifecycle save timed out while saving scene res://a.tscn",
  },
  {
    op: "start_editor" as const,
    responses: [
      { name: "editor_state", value: { project_name: "test" } },
      { name: "scene_open", value: {}, timeout: true, error: "upstream wait" },
    ],
    message:
      "Lifecycle start_editor timed out while restoring scene res://a.tscn: upstream wait",
  },
])("reports the lifecycle operation and step for timeout: $op", (input) => {
  const result = control(input.op, input.responses);
  expect(result.replies[0]).toMatchObject({
    ok: false,
    error: input.message,
  });
});
