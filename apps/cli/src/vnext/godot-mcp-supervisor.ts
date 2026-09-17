/** Executed only inside SRT. Socket streams carry standard MCP JSONL unchanged. */
export const GODOT_MCP_SUPERVISOR = String.raw`
import asyncio, base64, contextlib, json, os, signal, sys
from pathlib import Path
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

root, project, godot, xvfb = sys.argv[1:]
root = Path(root)
children = set()
logs = []
captures = set()
relays = {}

def emit(message):
    print(json.dumps(message), flush=True)
active_scene = ""
editor = None
editor_exit = asyncio.Event()

async def capture(stream, filename):
    kept = 0
    truncated = False
    with open(filename, "wb") as log:
        while chunk := await stream.read(65536):
            remaining = max(0, 1024 * 1024 - kept)
            log.write(chunk[:remaining])
            kept += min(len(chunk), remaining)
            truncated = truncated or len(chunk) > remaining
    if truncated:
        Path(str(filename) + ".truncated").write_text("true\n")

async def spawn(*args, pipes=False, env=None):
    index = len(logs)
    logs.append(index)
    process = await asyncio.create_subprocess_exec(*args,
        stdin=asyncio.subprocess.PIPE if pipes else asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, env=env)
    if not pipes:
        captures.add(asyncio.create_task(capture(process.stdout, root / ("process-%d.stdout.log" % index))))
    captures.add(asyncio.create_task(capture(process.stderr, root / ("process-%d.stderr.log" % index))))
    children.add(process)
    return process

async def stop(process):
    if process.returncode is None:
        process.terminate()
        try:
            await asyncio.wait_for(process.wait(), 3)
        except asyncio.TimeoutError:
            process.kill()
            await process.wait()
    children.discard(process)

async def tool(client, name, arguments=None):
    result = await client.call_tool(name, arguments or {})
    if result.isError:
        raise RuntimeError(str(result.content)[:4096])
    # Upstream's response is a text-encoded object (structuredContent is optional).
    value = result.structuredContent
    if value is None:
        value = next((json.loads(c.text) for c in result.content if c.type == "text"), {})
    if isinstance(value, dict) and "data" in value:
        value = value["data"]
    return value

@contextlib.asynccontextmanager
async def client():
    params = StdioServerParameters(command=sys.executable, args=["-m", "godot_ai", "attach"], env=dict(os.environ))
    with open(os.devnull, "w") as log:
        async with stdio_client(params, errlog=log) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                yield session

async def watch_editor(process):
    await process.wait()
    editor_exit.set()

async def open_scene_checked(session, path):
    opened = await tool(session, "scene_open", {"path": path})
    if not isinstance(opened, dict) or opened.get("switched") is not True or opened.get("path") != path:
        raise RuntimeError("Editor did not confirm switching to scene: " + path)

async def start_editor(progress):
    global editor
    if editor is not None:
        if editor.returncode is not None:
            raise RuntimeError("Godot editor exited unexpectedly")
        return
    editor_env = dict(os.environ)
    editor_env["XDG_DATA_HOME"] = editor_env.pop("CHRONORIFT_GODOT_DATA_HOME")
    progress("launching editor")
    editor = await spawn(godot, "--editor", "--path", project, "--rendering-method", "gl_compatibility", "--display-driver", "x11", "--audio-driver", "Dummy", env=editor_env)
    asyncio.create_task(watch_editor(editor))
    async with asyncio.timeout(120):
        progress("connecting to editor control client")
        async with client() as session:
            progress("waiting for editor readiness")
            while True:
                if editor.returncode is not None:
                    raise RuntimeError("Godot editor exited during startup")
                try:
                    state = await tool(session, "editor_state")
                    if state:
                        break
                except Exception:
                    pass
                await asyncio.sleep(.25)
            restore = os.environ.get("CHRONORIFT_RESTORE_SCENE", "")
            if restore:
                progress("restoring scene " + restore)
                await open_scene_checked(session, restore)
            progress("closing editor control client")

async def control(message):
    global active_scene
    op = "unknown"
    step = "reading lifecycle request"
    def progress(value):
        nonlocal step
        step = value
    try:
        command = message["command"]
        op = command.get("op", "unknown")
        if op == "start_editor":
            await start_editor(progress)
            emit({"id": message["id"], "ok": True, "value": {"started": True}})
            return
        async with asyncio.timeout(45):
            progress("connecting to MCP control client")
            async with client() as session:
                if command.get("op") == "save":
                    progress("stopping game")
                    stopped = await tool(session, "project_manage", {"op": "stop"})
                    if not isinstance(stopped, dict) or stopped.get("stopped") is not True:
                        raise RuntimeError("Editor did not confirm stopping the game")
                    progress("reading open-scene inventory")
                    scenes = await tool(session, "scene_manage", {"op": "get_roots"})
                    if not isinstance(scenes, dict) or not isinstance(scenes.get("scenes"), list) or not isinstance(scenes.get("current_scene"), str):
                        raise RuntimeError("Editor returned an invalid open-scene inventory")
                    active_scene = scenes["current_scene"]
                    for scene in scenes["scenes"]:
                        if not isinstance(scene, str) or not scene:
                            raise RuntimeError("Unnamed editor scene cannot be saved automatically")
                        progress("opening scene " + scene)
                        await open_scene_checked(session, scene)
                        progress("saving scene " + scene)
                        saved = await tool(session, "scene_save")
                        if not isinstance(saved, dict) or saved.get("path") != scene:
                            raise RuntimeError("Editor did not confirm saving scene: " + scene)
                    value = {"activeScene": active_scene}
                elif command.get("op") == "call_raw":
                    progress("calling " + str(command["name"]))
                    value = (await session.call_tool(command["name"], command.get("arguments", {}))).model_dump(mode="json")
                elif command.get("op") == "call":
                    progress("calling " + str(command["name"]))
                    value = await tool(session, command["name"], command.get("arguments", {}))
                else:
                    raise RuntimeError("Unknown lifecycle operation")
                progress("closing MCP control client")
        emit({"id": message["id"], "ok": True, "value": value})
    except Exception as error:
        detail = str(error)
        if isinstance(error, TimeoutError):
            detail = "Lifecycle %s timed out while %s%s" % (op, step, (": " + detail) if detail else "")
        elif not detail:
            detail = "Lifecycle %s failed while %s (%s)" % (op, step, type(error).__name__)
        emit({"id": message["id"], "ok": False, "error": detail[:4096]})

async def relay_output(channel, process):
    try:
        while chunk := await process.stdout.read(65536):
            emit({"channel": channel, "data": base64.b64encode(chunk).decode()})
    finally:
        emit({"channel": channel, "closed": True})
        relays.pop(channel, None)
        await stop(process)

async def pipe_input():
    reader = asyncio.StreamReader(limit=2 * 1024 * 1024)
    protocol = asyncio.StreamReaderProtocol(reader)
    await asyncio.get_running_loop().connect_read_pipe(lambda: protocol, sys.stdin.buffer)
    while line := await reader.readline():
        message = json.loads(line)
        op = message.get("op")
        channel = message.get("channel")
        if op == "open":
            if len(relays) >= 8:
                raise RuntimeError("Too many MCP connections")
            process = await spawn(sys.executable, "-m", "godot_ai", "attach", pipes=True)
            relays[channel] = process
            asyncio.create_task(relay_output(channel, process))
        elif op == "data" and channel in relays:
            process = relays[channel]
            process.stdin.write(base64.b64decode(message["data"], validate=True))
            await process.stdin.drain()
        elif op == "close" and channel in relays:
            await stop(relays.pop(channel))
        elif op == "control":
            await control(message)

async def main():
    # All TCP listeners are inside this SRT network namespace. No desktop socket
    # or credentials from the Host are mounted into the environment.
    display = await spawn(xvfb, ":99", "-screen", "0", "1280x800x24", "-ac", "-nolock", "-nolisten", "unix", "-listen", "tcp")
    for _ in range(100):
        try:
            reader, writer = await asyncio.open_connection("127.0.0.1", 6099)
            writer.close()
            break
        except OSError:
            await asyncio.sleep(.1)
    else:
        raise RuntimeError("Virtual display did not start")
    backend = await spawn(sys.executable, "-m", "godot_ai", "--transport", "streamable-http")
    for _ in range(200):
        if backend.returncode is not None:
            raise RuntimeError("Godot AI backend exited during startup")
        if list((root / "home/capabilities").glob("*.json")):
            break
        await asyncio.sleep(.1)
    else:
        raise RuntimeError("Godot AI backend did not become ready")
    # MCP schemas and discovery do not require a project editor. The Host asks
    # for start_editor only before executing an actual upstream tool.
    emit({"ready": True})
    done = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, done.set)
    watchers = [asyncio.create_task(process.wait()) for process in (backend, display)]
    input_task = asyncio.create_task(pipe_input())
    await asyncio.wait([*watchers, asyncio.create_task(editor_exit.wait()), asyncio.create_task(done.wait()), input_task], return_when=asyncio.FIRST_COMPLETED)
    if not done.is_set():
        if input_task.done():
            await input_task
        raise RuntimeError("Managed editor, backend, display or Host pipe exited")

async def managed_main():
    try:
        await main()
    finally:
        await asyncio.gather(*(stop(process) for process in list(children)), return_exceptions=True)
        await asyncio.gather(*captures, return_exceptions=True)

asyncio.run(managed_main())

`;
