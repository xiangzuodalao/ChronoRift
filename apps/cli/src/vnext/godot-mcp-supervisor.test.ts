import { execFileSync } from "node:child_process";

import { expect, it } from "vitest";

import { GODOT_MCP_SUPERVISOR } from "./godot-mcp-supervisor.js";

// Run the actual lifecycle functions with in-memory MCP replies. The supervisor
// entrypoint and all process creation are disabled: this never launches Godot.
const RUNNER = String.raw`
import ast, asyncio, contextlib, json, os, sys, tempfile, types
from pathlib import Path
spec = json.load(sys.stdin)
# Offline tests also run with system Python 3.10; production uses pinned 3.12.
# Exercise the same exception-tree interface without requiring an installation.
try:
    ExceptionGroup
except NameError:
    class ExceptionGroup(Exception):
        def __init__(self, message, exceptions):
            super().__init__(message)
            self.exceptions = tuple(exceptions)
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
real_client = namespace["client"]
calls, replies, spawns, signals, groups = [], [], [], [], {}
client_count = 0
responses = iter(spec["responses"])
class FakeSession:
    async def call_tool(self, name, arguments):
        calls.append({"name": name, "arguments": arguments})
        response = next(responses)
        assert response["name"] == name, (response["name"], name)
        if response.get("timeout"):
            raise TimeoutError(response.get("error", ""))
        if response.get("group"):
            raise ExceptionGroup("outer", [ValueError("bad value"), ExceptionGroup("inner", [ConnectionError("attach disconnected")])])
        if "editor_exit" in response:
            namespace["editor"].finish(response["editor_exit"])
        return types.SimpleNamespace(
            isError=response.get("isError", False),
            structuredContent={"data": response["value"]},
            content=[types.SimpleNamespace(type="text", text="upstream refused")])
@contextlib.asynccontextmanager
async def client(observations):
    global client_count
    client_count += 1
    yield FakeSession()
    if spec.get("close_error") or spec.get("close_error_on") == client_count:
        raise RuntimeError("control connection failed on close")
class FakeEditor:
    def __init__(self, pid):
        self.pid = pid
        self.returncode = None
        self.exited = asyncio.Event()
    def finish(self, code=0):
        self.returncode = code
        self.exited.set()
    async def wait(self):
        await self.exited.wait()
        return self.returncode
async def spawn(*args, **kwargs):
    spawns.append({"args": args, **kwargs})
    process = FakeEditor(100 + len(spawns))
    namespace["children"].add(process)
    if kwargs.get("new_session"):
        namespace["process_groups"].add(process)
        groups[process.pid] = {"process": process, "game": True}
    return process
def killpg(pid, sig):
    signals.append({"pid": pid, "signal": sig})
    if spec.get("signal_error"):
        raise PermissionError("editor group signal refused")
    group = groups[pid]
    if sig == namespace["signal"].SIGTERM:
        group["process"].finish()
        group["game"] = bool(spec.get("residual_game"))
    elif sig == namespace["signal"].SIGKILL and not spec.get("surviving_game"):
        group["process"].finish()
        group["game"] = False
def group_has_live_processes(pid):
    group = groups[pid]
    return group["process"].returncode is None or group["game"]
async def reject_subprocess(*args, **kwargs):
    raise RuntimeError("Real subprocess creation is disabled in this test")
@contextlib.asynccontextmanager
async def timeout(seconds):
    # These receipt tests use immediate replies, not the Python 3.12 runtime
    # clock. The Node runner still bounds the whole test process to five seconds.
    yield
asyncio.create_subprocess_exec = reject_subprocess
asyncio.timeout = timeout
namespace.update(client=client, spawn=spawn, emit=replies.append, group_has_live_processes=group_has_live_processes)
os.killpg = killpg
os.environ["CHRONORIFT_GODOT_DATA_HOME"] = "/fake/task-data"
# A stale environment value must never override the per-request restore path.
os.environ["CHRONORIFT_RESTORE_SCENE"] = "res://stale.tscn"
async def run():
    if spec.get("lifecycle"):
        backend, display, relay = (FakeEditor(pid) for pid in (1, 2, 3))
        namespace["children"].update((backend, display, relay))
        namespace["relays"]["existing"] = relay
        for index, command in enumerate(spec["commands"]):
            if command["op"] == "unexpected_exit":
                namespace["editor"].finish(17)
            else:
                await namespace["control"]({"id": str(index), "command": command})
            await asyncio.sleep(0)
        replies.append({"fatal": namespace["editor_exit"].is_set(), "editor": namespace["editor"].pid if namespace["editor"] else None, "children": sorted(process.pid for process in namespace["children"]), "relay": namespace["relays"]["existing"].pid, "services_alive": all(process.returncode is None for process in (backend, display, relay)), "games": {pid: group["game"] for pid, group in groups.items()}, "signals": signals})
    elif spec.get("shutdown"):
        with tempfile.TemporaryDirectory() as directory:
            task_root = Path(directory)
            capability_dir = task_root / "home/capabilities"
            capability_dir.mkdir(parents=True)
            (capability_dir / "test.json").write_text("{}")
            events, inherited = [], []
            called = asyncio.Event()
            class Process:
                returncode = None
                def __init__(self):
                    self.exited = asyncio.Event()
                async def wait(self):
                    await self.exited.wait()
                def terminate(self):
                    events.append("child_stop")
                    self.returncode = 0
                    self.exited.set()
                def kill(self):
                    self.terminate()
            async def fake_spawn(*args, **kwargs):
                process = Process()
                namespace["children"].add(process)
                return process
            async def fake_connection(*args):
                return None, types.SimpleNamespace(close=lambda: None)
            @contextlib.asynccontextmanager
            async def fake_stdio(params, errlog):
                inherited.append(os.dup(errlog.fileno()))
                os.write(errlog.fileno(), b"control started\nAuthorization: Bearer shutdown-private\n")
                try:
                    yield None, None
                finally:
                    events.append("stdio_closed")
            class Session:
                def __init__(self, *args):
                    pass
                async def __aenter__(self):
                    return self
                async def __aexit__(self, *args):
                    pass
                async def initialize(self):
                    pass
                async def call_tool(self, *args):
                    called.set()
                    await asyncio.Future()
            async def fake_input():
                try:
                    await namespace["control"]({"id": "shutdown", "command": {"op": "call", "name": "blocked"}})
                finally:
                    events.append("input_closed")
            async def terminate_when_called():
                await called.wait()
                os.kill(os.getpid(), namespace["signal"].SIGTERM)
            namespace.update(root=task_root, spawn=fake_spawn, client=real_client, pipe_input=fake_input, ClientSession=Session, StdioServerParameters=lambda **kwargs: None, stdio_client=fake_stdio)
            asyncio.open_connection = fake_connection
            trigger = asyncio.create_task(terminate_when_called())
            try:
                await namespace["managed_main"]()
                await trigger
                log = task_root / "process-0.stderr.log"
                replies.append({"events": events, "captures_done": all(task.done() for task in namespace["captures"]), "text": log.read_text(), "incomplete": Path(str(log) + ".incomplete").exists()})
            finally:
                for descriptor in inherited:
                    os.close(descriptor)
    elif spec.get("pipe_capture"):
        with tempfile.TemporaryDirectory() as directory:
            read_fd, write_fd = os.pipe()
            pipe = os.fdopen(read_fd, "rb", buffering=0)
            reader = asyncio.StreamReader()
            transport, _ = await asyncio.get_running_loop().connect_read_pipe(lambda: asyncio.StreamReaderProtocol(reader), pipe)
            diagnostic = {}
            path = Path(directory) / "process-0.stderr.log"
            task = asyncio.create_task(namespace["capture"](reader, path, diagnostic))
            try:
                if spec["pipe_capture"] == "streaming":
                    async def wait_for(predicate):
                        for _ in range(100):
                            if predicate():
                                return
                            await asyncio.sleep(.005)
                        raise AssertionError("capture did not persist the expected line")
                    os.write(write_fd, b"ready line\nAuthoriza")
                    await wait_for(lambda: path.exists() and "ready line" in path.read_text())
                    first = path.read_text()
                    os.write(write_fd, b"tion: Bearer streaming-private\nCookie: cookie-private")
                    await wait_for(lambda: "Authorization: [redacted]" in path.read_text())
                    second = path.read_text()
                    incomplete_before_eof = Path(str(path) + ".incomplete").exists()
                    os.write(write_fd, b"; pending-private\n")
                    for _ in range(5):
                        os.write(write_fd, b"x" * 4096)
                        await asyncio.sleep(.01)
                    await wait_for(lambda: Path(str(path) + ".truncated").exists())
                    os.write(write_fd, b"ignored-private\nafter long line\n")
                    await wait_for(lambda: "after long line" in path.read_text())
                    before_eof = path.read_text()
                    os.close(write_fd)
                    write_fd = None
                    await task
                    replies.append({"first": first, "second": second, "text": before_eof, "incomplete_before_eof": incomplete_before_eof, "incomplete_after_eof": Path(str(path) + ".incomplete").exists(), "diagnostic": diagnostic})
                else:
                    os.write(write_fd, b"Authorization: Bearer inherited-private\nlast line\n")
                    await namespace["finish_capture"](task)
                    replies.append({"done": task.done(), "cancelled": task.cancelled(), "diagnostic": diagnostic, "text": path.read_text(), "incomplete": Path(str(path) + ".incomplete").exists()})
            finally:
                if write_fd is not None:
                    os.close(write_fd)
                transport.close()
    elif spec.get("capture"):
        with tempfile.TemporaryDirectory() as directory:
            reader = asyncio.StreamReader()
            for chunk in spec["capture"]:
                reader.feed_data(chunk.encode())
            reader.feed_eof()
            diagnostic = {}
            path = Path(directory) / "process-0.stderr.log"
            await namespace["capture"](reader, path, diagnostic)
            replies.append({"diagnostic": diagnostic, "text": path.read_text(), "size": path.stat().st_size, "marker": Path(str(path) + ".truncated").exists(), "drained": reader.at_eof()})
    elif spec.get("diagnostic"):
        error = ValueError("token=private " + "界" * 1024)
        if spec["diagnostic"] == "deep":
            for _ in range(12):
                error = ExceptionGroup("nested", [error])
        else:
            error = ExceptionGroup("wide", [error] * 30)
        replies.append(namespace["error_diagnostic"](error, "save", "saving scene", namespace["time"].monotonic(), 45000, {}))
    else:
        await namespace["control"]({"id": "test", "command": {"op": spec["op"], "restoreScene": spec.get("restore", "")}})
asyncio.run(run())
print(json.dumps({"calls": calls, "replies": replies, "spawns": spawns}))
`;

interface Reply {
  name: string;
  value: unknown;
  isError?: boolean;
  timeout?: boolean;
  error?: string;
  group?: boolean;
  editor_exit?: number;
}

function run(spec: Record<string, unknown>) {
  return JSON.parse(
    execFileSync("/usr/bin/python3", ["-I", "-c", RUNNER], {
      input: JSON.stringify({
        supervisor: GODOT_MCP_SUPERVISOR,
        responses: [],
        restore: "res://a.tscn",
        ...spec,
      }),
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin" },
      timeout: 5_000,
      maxBuffer: 4 * 1024 * 1024,
    }),
  ) as {
    calls: { name: string; arguments: Record<string, unknown> }[];
    replies: {
      ok: boolean;
      value?: unknown;
      error?: string;
      diagnostic?: Record<string, unknown>;
    }[];
    spawns: {
      args: string[];
      env: Record<string, string>;
      new_session?: boolean;
    }[];
  };
}

function control(
  op: "save" | "start_editor",
  responses: Reply[],
  extra: Record<string, unknown> = {},
) {
  return run({ op, responses, ...extra });
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

it("saves the active scene without opening it again", () => {
  const result = control("save", [
    ...beforeSave(),
    { name: "scene_save", value: { path: "res://a.tscn" } },
  ]);
  expect(result.replies).toEqual([
    { id: "test", ok: true, value: { activeScene: "res://a.tscn" } },
  ]);
  expect(result.calls.map((call) => call.name)).toEqual([
    "project_manage",
    "scene_manage",
    "scene_save",
  ]);
  expect(result.spawns).toEqual([]);
});

const ready = (): Reply => ({
  name: "editor_state",
  value: { readiness: "ready" },
});
const saved = (): Reply => ({
  name: "scene_save",
  value: { path: "res://a.tscn" },
});

it("keeps the backend, display and existing MCP relay across editor closes and restarts", () => {
  const result = run({
    lifecycle: true,
    residual_game: true,
    commands: [
      { op: "start_editor" },
      { op: "save_and_close_editor" },
      { op: "start_editor", restoreScene: "res://a.tscn" },
      { op: "save_and_close_editor" },
    ],
    responses: [
      ready(),
      ...beforeSave(),
      saved(),
      ready(),
      opened(),
      ...beforeSave(),
      saved(),
    ],
  });
  expect(result.replies.slice(0, 4).every((reply) => reply.ok)).toBe(true);
  expect(result.replies[1]?.value).toEqual({
    activeScene: "res://a.tscn",
    editorStopped: true,
  });
  expect(result.replies.at(-1)).toMatchObject({
    fatal: false,
    editor: null,
    children: [1, 2, 3],
    relay: 3,
    services_alive: true,
    games: { "101": false, "102": false },
    signals: [
      { pid: 101, signal: 15 },
      { pid: 101, signal: 9 },
      { pid: 102, signal: 15 },
      { pid: 102, signal: 9 },
    ],
  });
  expect(result.spawns).toHaveLength(2);
  expect(result.spawns.every((spawn) => spawn.new_session)).toBe(true);
  expect(result.calls.filter((call) => call.name === "scene_open")).toEqual([
    { name: "scene_open", arguments: { path: "res://a.tscn" } },
  ]);
});

it("still marks an unexpected editor exit as fatal", () => {
  const result = run({
    lifecycle: true,
    commands: [{ op: "start_editor" }, { op: "unexpected_exit" }],
    responses: [ready()],
  });
  expect(result.replies.at(-1)).toMatchObject({ fatal: true, signals: [] });
});

it.each([
  { responses: [...beforeSave(), { ...saved(), isError: true }] },
  { responses: [...beforeSave(), saved()], close_error_on: 2 },
])(
  "does not close the editor after an unconfirmed save or client teardown",
  (failure) => {
    const result = run({
      lifecycle: true,
      commands: [{ op: "start_editor" }, { op: "save_and_close_editor" }],
      ...failure,
      responses: [ready(), ...failure.responses],
    });
    expect(result.replies[0]?.ok).toBe(true);
    expect(result.replies[1]?.ok).toBe(false);
    expect(result.replies[1]?.value).toBeUndefined();
    expect(result.replies.at(-1)).toMatchObject({
      fatal: false,
      editor: 101,
      children: [1, 2, 3, 101],
      signals: [],
    });
  },
);

it.each([
  { signal_error: true, error: "editor group signal refused" },
  {
    residual_game: true,
    surviving_game: true,
    error: "Editor process group did not stop",
  },
])(
  "fails closed when the editor group cannot be stopped: $error",
  (failure) => {
    const result = run({
      lifecycle: true,
      ...failure,
      commands: [{ op: "start_editor" }, { op: "save_and_close_editor" }],
      responses: [ready(), ...beforeSave(), saved()],
    });
    expect(result.replies[1]).toMatchObject({
      ok: false,
      error: failure.error,
      diagnostic: { step: "closing editor process group" },
    });
    expect(result.replies[1]?.value).toBeUndefined();
    expect(result.replies.at(-1)).toMatchObject({
      fatal: true,
      services_alive: true,
    });
  },
);

const beforeSwitch = (): Reply[] => [
  { name: "project_manage", value: { stopped: true } },
  {
    name: "scene_manage",
    value: {
      scenes: ["res://a.tscn", "res://b.tscn"],
      current_scene: "res://b.tscn",
    },
  },
  { name: "scene_save", value: { path: "res://b.tscn" } },
];

it("saves the active scene first and confirms switching before saving other scenes", () => {
  const result = control("save", [
    ...beforeSwitch(),
    opened(),
    { name: "scene_save", value: { path: "res://a.tscn" } },
  ]);
  expect(result.replies[0]).toMatchObject({
    ok: true,
    value: { activeScene: "res://b.tscn" },
  });
  expect(result.calls.map((call) => call.name)).toEqual([
    "project_manage",
    "scene_manage",
    "scene_save",
    "scene_open",
    "scene_save",
  ]);
});

it.each([
  { path: "res://a.tscn", switched: false, settle: "timeout" },
  { path: "res://other.tscn", switched: true },
  { path: "res://a.tscn" },
])("does not save or acknowledge an unconfirmed scene switch: %j", (value) => {
  const result = control("save", [
    ...beforeSwitch(),
    { name: "scene_open", value },
  ]);
  expect(result.replies[0]).toMatchObject({
    ok: false,
    error: "Editor did not confirm switching to scene: res://a.tscn",
  });
  expect(
    result.calls.filter((call) => call.name === "scene_save"),
  ).toHaveLength(1);
});

it.each([{ path: "res://other.tscn" }, {}])(
  "rejects a save receipt for a different or missing scene: %j",
  (value) => {
    const result = control("save", [
      ...beforeSave(),
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
    { name: "scene_save", value: { path: "res://a.tscn" }, isError: true },
  ]);
  expect(result.replies[0]?.ok).toBe(false);
  expect(result.replies[0]?.error).toContain("upstream refused");
});

it.each([true, false])(
  "requires a confirmed restored-scene switch during startup (switched=%s)",
  (switched) => {
    const result = control("start_editor", [
      {
        name: "editor_state",
        value: { project_name: "test", readiness: "ready" },
      },
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
      { name: "scene_save", value: {}, timeout: true },
    ],
    message: "Lifecycle save timed out while saving scene res://a.tscn",
  },
  {
    op: "start_editor" as const,
    responses: [
      {
        name: "editor_state",
        value: { project_name: "test", readiness: "ready" },
      },
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
    diagnostic: {
      operation: input.op,
      timeoutMs: input.op === "start_editor" ? 120_000 : 45_000,
      leaves: [{ type: "TimeoutError" }],
    },
  });
});

it.each(["ready", "no_scene"])(
  "waits through imports and accepts editor readiness %s without game liveness",
  (readiness) => {
    const result = control(
      "start_editor",
      [
        { name: "editor_state", value: { readiness: "importing" } },
        { name: "editor_state", value: { readiness } },
      ],
      { restore: "" },
    );
    expect(result.replies[0]?.ok).toBe(true);
    expect(result.calls).toHaveLength(2);
  },
);

it.each([{}, { readiness: "unknown" }, null, "ready"])(
  "rejects malformed readiness instead of accepting a truthy response: %j",
  (value) => {
    const result = control("start_editor", [{ name: "editor_state", value }], {
      restore: "",
    });
    expect(result.replies[0]).toMatchObject({
      ok: false,
      error: "Editor returned an invalid readiness state",
    });
  },
);

it("does not mistake a live game helper for editor readiness", () => {
  const result = control(
    "start_editor",
    [
      {
        name: "editor_state",
        value: { readiness: "playing", helper_live: true },
      },
      {
        name: "editor_state",
        value: { readiness: "ready", helper_live: false },
      },
    ],
    { restore: "" },
  );
  expect(result.replies[0]?.ok).toBe(true);
  expect(result.calls).toHaveLength(2);
});

it("records the last poll failure and readiness when the editor exits", () => {
  const result = control(
    "start_editor",
    [
      {
        name: "editor_state",
        value: {},
        timeout: true,
        error: "early bridge unavailable",
      },
      {
        name: "editor_state",
        value: { readiness: "importing" },
        editor_exit: 1,
      },
    ],
    { restore: "" },
  );
  expect(result.replies[0]).toMatchObject({
    ok: false,
    diagnostic: {
      lastReadiness: "importing",
      pollErrors: 1,
      lastPollError: "early bridge unavailable",
    },
  });
});

it.each([
  { scenes: ["res://a.tscn"], current_scene: "res://missing.tscn" },
  { scenes: ["res://a.tscn", "res://a.tscn"], current_scene: "res://a.tscn" },
  { scenes: [], current_scene: "res://a.tscn" },
  { scenes: ["res://a.tscn", ""], current_scene: "res://a.tscn" },
  { scenes: ["res://../outside.tscn"], current_scene: "res://../outside.tscn" },
])("validates the entire inventory before saving any scene: %j", (value) => {
  const result = control("save", [
    beforeSave()[0]!,
    { name: "scene_manage", value },
  ]);
  expect(result.replies[0]?.ok).toBe(false);
  expect(result.calls).toHaveLength(2);
});

it("allows an empty editor inventory", () => {
  const result = control("save", [
    beforeSave()[0]!,
    { name: "scene_manage", value: { scenes: [], current_scene: "" } },
  ]);
  expect(result.replies[0]).toMatchObject({
    ok: true,
    value: { activeScene: "" },
  });
});

it("retains nested exception leaves and the failed lifecycle step", () => {
  const result = control("save", [
    ...beforeSave(),
    { name: "scene_save", value: {}, group: true },
  ]);
  expect(result.replies[0]).toMatchObject({
    ok: false,
    diagnostic: {
      operation: "save",
      step: "saving scene res://a.tscn",
      timeoutMs: 45_000,
      leaves: [
        { type: "ValueError", message: "bad value" },
        { type: "ConnectionError", message: "attach disconnected" },
      ],
      truncated: false,
    },
  });
  expect(result.replies[0]?.error).toContain(
    "ConnectionError: attach disconnected",
  );
  expect(result.replies[0]?.error).not.toContain("timed out");
});

it("identifies control-client close failures separately from successful tool execution", () => {
  const result = control(
    "save",
    [...beforeSave(), { name: "scene_save", value: { path: "res://a.tscn" } }],
    { close_error: true },
  );
  expect(result.replies[0]).toMatchObject({
    ok: false,
    diagnostic: {
      step: "closing MCP control client",
      leaves: [
        { type: "RuntimeError", message: "control connection failed on close" },
      ],
    },
  });
});

it.each(["wide", "deep"])(
  "bounds and redacts exception diagnostics: %s",
  (diagnostic) => {
    const result = run({ diagnostic }).replies[0];
    expect(result).toMatchObject({ truncated: true });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(
      16 * 1024,
    );
    expect(JSON.stringify(result)).not.toContain("private");
    if (diagnostic === "wide") {
      const leaves = (result as unknown as { leaves: unknown[] }).leaves;
      expect(leaves.length).toBeGreaterThan(0);
      expect(leaves.length).toBeLessThanOrEqual(16);
    }
  },
);

it("drains oversized stderr, redacts across read boundaries and preserves a bounded final diagnostic", () => {
  const result = run({
    capture: [
      "x".repeat(65_526) + "\nAuthoriza",
      "tion: Bearer header-private\nhttps://user:password-private@example.test?token=query-private\n",
      "noise\n".repeat(190_000),
      "last failure\nCookie: cookie-private\n",
    ],
  }).replies[0];
  expect(result).toMatchObject({
    marker: true,
    drained: true,
    diagnostic: { truncated: true },
  });
  expect(result).toHaveProperty("size");
  expect((result as unknown as { size: number }).size).toBeLessThanOrEqual(
    1024 * 1024,
  );
  expect(JSON.stringify(result)).not.toContain("-private");
  expect(result?.diagnostic?.tail).toContain("last failure");
});

it("bounds stderr teardown when a descendant still holds the real pipe open", () => {
  const result = run({ pipe_capture: true }).replies[0];
  expect(result).toMatchObject({
    done: true,
    cancelled: true,
    incomplete: true,
    diagnostic: { incomplete: true },
  });
  expect(JSON.stringify(result)).not.toContain("inherited-private");
  expect(result?.diagnostic?.tail).toContain("last line");
});

it("persists redacted complete lines before EOF and marks incomplete or dropped output immediately", () => {
  const result = run({ pipe_capture: "streaming" }).replies[0];
  expect(result).toMatchObject({
    first: "ready line\n",
    second: "ready line\nAuthorization: [redacted]\n",
    text: "ready line\nAuthorization: [redacted]\nCookie: [redacted]\nafter long line\n",
    incomplete_before_eof: true,
    incomplete_after_eof: false,
    diagnostic: { truncated: true, incomplete: false },
  });
  expect(JSON.stringify(result)).not.toContain("-private");
});

it("unwinds an active control client before collecting captures on real SIGTERM", () => {
  const result = run({ shutdown: true }).replies.at(-1);
  expect(result).toMatchObject({
    events: ["stdio_closed", "input_closed", "child_stop", "child_stop"],
    captures_done: true,
    text: "control started\nAuthorization: [redacted]\n",
    incomplete: true,
  });
  expect(JSON.stringify(result)).not.toContain("shutdown-private");
});
