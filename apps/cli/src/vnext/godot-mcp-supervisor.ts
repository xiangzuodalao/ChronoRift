/** Executed only inside SRT. Socket streams carry standard MCP JSONL unchanged. */
export const GODOT_MCP_SUPERVISOR = String.raw`
import asyncio, base64, contextlib, json, os, re, signal, sys, time
from pathlib import Path
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

root, project, godot, xvfb = sys.argv[1:]
root = Path(root)
children = set()
process_groups = set()
expected_editor_stops = set()
logs = []
captures = set()
relays = {}

def emit(message):
    print(json.dumps(message), flush=True)
active_scene = ""
editor = None
editor_exit = asyncio.Event()

def bounded_text(value, limit):
    return str(value).encode("utf-8", errors="replace")[:limit].decode("utf-8", errors="ignore")

def redact(value):
    text = str(value)
    text = re.sub(r"(?im)(\b(?:authorization|proxy-authorization|cookie|set-cookie)\b[\"']?\s*[:=]\s*)[^\r\n]+", r"\1[redacted]", text)
    text = re.sub(r"(?i)(\b(?:access_token|refresh_token|api_key|apikey|token|capability|password|secret)\b[\"']?\s*[:=]\s*[\"']?)[^\s\"'&,;}]+", r"\1[redacted]", text)
    return re.sub(r"(?i)(https?://)[^/\s:@]+:[^/\s@]+@", r"\1[redacted]@", text)

def log_index():
    index = len(logs)
    logs.append(index)
    return index

async def capture(stream, filename, diagnostic=None):
    # SRT can SIGKILL this process, so persist each redacted complete line now.
    # An unfinished line stays private; overlong lines are dropped in full.
    pending, tail = bytearray(), bytearray()
    kept, truncated, dropping = 0, False, False
    complete = False
    incomplete_path = Path(str(filename) + ".incomplete")
    incomplete_path.write_text("true\n")
    def mark_truncated():
        nonlocal truncated
        if not truncated:
            Path(str(filename) + ".truncated").write_text("true\n")
            truncated = True
    with open(filename, "wb", buffering=0) as log:
        def persist(line):
            nonlocal kept
            output = redact(line.decode("utf-8", errors="replace")).encode("utf-8")
            tail.extend(output)
            del tail[:-4096]
            remaining = max(0, 1024 * 1024 - kept)
            log.write(output[:remaining])
            kept += min(len(output), remaining)
            if len(output) > remaining:
                mark_truncated()
        try:
            while chunk := await stream.read(65536):
                parts = chunk.split(b"\n")
                for index, part in enumerate(parts):
                    ended = index < len(parts) - 1
                    if not dropping:
                        if len(pending) + len(part) > 16384:
                            pending.clear()
                            dropping = True
                            mark_truncated()
                        else:
                            pending.extend(part)
                    if ended:
                        if not dropping:
                            persist(pending + b"\n")
                        pending.clear()
                        dropping = False
            if pending and not dropping:
                persist(pending)
            complete = True
            incomplete_path.unlink()
        finally:
            if diagnostic is not None:
                diagnostic.update({"log": filename.name, "truncated": truncated, "incomplete": not complete, "tail": tail.decode("utf-8", errors="ignore")})

async def capture_stdout(stream, filename):
    kept, truncated = 0, False
    with open(filename, "wb") as log:
        while chunk := await stream.read(65536):
            remaining = max(0, 1024 * 1024 - kept)
            log.write(chunk[:remaining])
            kept += min(len(chunk), remaining)
            truncated = truncated or len(chunk) > remaining
    if truncated:
        Path(str(filename) + ".truncated").write_text("true\n")

async def finish_capture(task):
    try:
        # A descendant may retain stderr after attach exits. Do not let that
        # escape the lifecycle deadline's teardown allowance (Host: +5s).
        await asyncio.wait_for(task, 2)
    except (TimeoutError, asyncio.TimeoutError):
        pass

def error_diagnostic(error, op, step, started, timeout_ms, observations):
    leaves = []
    truncated = False
    visited = 0
    def visit(item, depth):
        nonlocal truncated, visited
        if len(leaves) >= 16 or depth > 8 or visited >= 128:
            truncated = True
            return
        visited += 1
        nested = getattr(item, "exceptions", None)
        if isinstance(nested, tuple):
            for child in nested:
                if len(leaves) >= 16 or visited >= 128:
                    truncated = True
                    break
                visit(child, depth + 1)
        else:
            message = redact(str(item))
            truncated = truncated or len(message.encode("utf-8")) > 512
            leaves.append({"type": bounded_text(type(item).__name__, 128), "message": bounded_text(message, 512)})
    visit(error, 0)
    value = {"operation": bounded_text(op, 128), "step": bounded_text(redact(step), 1024), "elapsedMs": int((time.monotonic() - started) * 1000), "timeoutMs": timeout_ms, "leaves": leaves, "truncated": truncated, **observations}
    # The Host independently validates this diagnostic before retaining it.
    while len(json.dumps(value).encode("utf-8")) > 16384:
        value["truncated"] = True
        if value.get("stderr", {}).get("tail"):
            value["stderr"]["tail"] = ""
        elif value["leaves"]:
            value["leaves"].pop()
        else:
            value = {key: value[key] for key in ("operation", "step", "elapsedMs", "timeoutMs", "leaves", "truncated")}
            break
    return value

async def spawn(*args, pipes=False, env=None, new_session=False):
    index = log_index()
    process = await asyncio.create_subprocess_exec(*args,
        stdin=asyncio.subprocess.PIPE if pipes else asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, env=env,
        start_new_session=new_session)
    if not pipes:
        captures.add(asyncio.create_task(capture_stdout(process.stdout, root / ("process-%d.stdout.log" % index))))
    captures.add(asyncio.create_task(capture(process.stderr, root / ("process-%d.stderr.log" % index))))
    children.add(process)
    if new_session:
        process_groups.add(process)
    return process

def group_has_live_processes(group):
    # A stopped game's orphaned zombies cannot write. killpg(group, 0) alone
    # would keep reporting them until the sandbox's init reaps them.
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        try:
            fields = (entry / "stat").read_text().rsplit(")", 1)[1].split()
        except (FileNotFoundError, ProcessLookupError):
            continue
        if int(fields[2]) == group and fields[0] not in ("Z", "X"):
            return True
    return False

async def stop_process_group(process):
    # Only editors are session leaders. Their game inherits the same process
    # group, so a leftover game cannot outlive the source-write barrier.
    with contextlib.suppress(ProcessLookupError):
        os.killpg(process.pid, signal.SIGTERM)
    try:
        await asyncio.wait_for(process.wait(), 3)
    except asyncio.TimeoutError:
        pass
    if group_has_live_processes(process.pid):
        with contextlib.suppress(ProcessLookupError):
            os.killpg(process.pid, signal.SIGKILL)
    deadline = time.monotonic() + 2
    while process.returncode is None or group_has_live_processes(process.pid):
        if time.monotonic() >= deadline:
            raise RuntimeError("Editor process group did not stop")
        await asyncio.sleep(.025)
    await process.wait()

async def stop(process):
    if process in process_groups:
        await stop_process_group(process)
        process_groups.discard(process)
    elif process.returncode is None:
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
async def client(observations):
    params = StdioServerParameters(command=sys.executable, args=["-m", "godot_ai", "attach"], env=dict(os.environ))
    read_fd, write_fd = os.pipe()
    reader = asyncio.StreamReader()
    pipe = os.fdopen(read_fd, "rb", buffering=0)
    log = os.fdopen(write_fd, "w")
    transport = None
    task = None
    try:
        transport, _ = await asyncio.get_running_loop().connect_read_pipe(lambda: asyncio.StreamReaderProtocol(reader), pipe)
        filename = root / ("process-%d.stderr.log" % log_index())
        observations["stderr"] = {"log": filename.name, "truncated": False, "incomplete": True, "tail": ""}
        task = asyncio.create_task(capture(reader, filename, observations["stderr"]))
        captures.add(task)
        async with stdio_client(params, errlog=log) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                yield session
    finally:
        log.close()
        try:
            if task is not None:
                await finish_capture(task)
        finally:
            if transport is not None:
                transport.close()
            else:
                pipe.close()

async def watch_editor(process):
    await process.wait()
    if process not in expected_editor_stops:
        editor_exit.set()
    expected_editor_stops.discard(process)

async def close_editor():
    global editor
    process = editor
    if process is None or process.returncode is not None:
        raise RuntimeError("Godot editor exited before the confirmed close")
    expected_editor_stops.add(process)
    try:
        await stop(process)
    except BaseException:
        # A partial close cannot grant source access or resume this editor.
        editor_exit.set()
        raise
    editor = None

async def open_scene_checked(session, path):
    opened = await tool(session, "scene_open", {"path": path})
    if not isinstance(opened, dict) or opened.get("switched") is not True or opened.get("path") != path:
        raise RuntimeError("Editor did not confirm switching to scene: " + path)

async def start_editor(progress, observations, restore):
    global editor
    if editor is not None:
        if editor.returncode is not None:
            raise RuntimeError("Godot editor exited unexpectedly")
        return
    editor_env = dict(os.environ)
    editor_env["XDG_DATA_HOME"] = editor_env.pop("CHRONORIFT_GODOT_DATA_HOME")
    progress("launching editor")
    editor = await spawn(godot, "--editor", "--path", project, "--rendering-method", "gl_compatibility", "--display-driver", "x11", "--audio-driver", "Dummy", env=editor_env, new_session=True)
    asyncio.create_task(watch_editor(editor))
    async with asyncio.timeout(120):
        progress("connecting to editor control client")
        async with client(observations) as session:
            progress("waiting for editor readiness")
            while True:
                if editor.returncode is not None:
                    raise RuntimeError("Godot editor exited during startup")
                try:
                    state = await tool(session, "editor_state")
                except Exception as error:
                    observations["pollErrors"] = observations.get("pollErrors", 0) + 1
                    observations["lastPollError"] = bounded_text(redact(str(error)), 512)
                else:
                    if not isinstance(state, dict) or state.get("readiness") not in ("ready", "no_scene", "importing", "playing"):
                        raise RuntimeError("Editor returned an invalid readiness state")
                    observations["lastReadiness"] = state["readiness"]
                    if state["readiness"] in ("ready", "no_scene"):
                        break
                await asyncio.sleep(.25)
            if restore:
                progress("restoring scene " + restore)
                await open_scene_checked(session, restore)
            progress("closing editor control client")

async def control(message):
    global active_scene
    op = "unknown"
    step = "reading lifecycle request"
    started = time.monotonic()
    timeout_ms = 45000
    observations = {}
    def progress(value):
        nonlocal step
        step = value
    try:
        command = message["command"]
        op = command.get("op", "unknown")
        if op == "start_editor":
            timeout_ms = 120000
            restore = command.get("restoreScene", "")
            if not isinstance(restore, str):
                raise RuntimeError("Invalid editor restore scene")
            await start_editor(progress, observations, restore)
            emit({"id": message["id"], "ok": True, "value": {"started": True}})
            return
        async with asyncio.timeout(45):
            progress("connecting to MCP control client")
            async with client(observations) as session:
                if op in ("save", "save_and_close_editor"):
                    if op == "save_and_close_editor" and (editor is None or editor.returncode is not None):
                        raise RuntimeError("Godot editor is not running")
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
                        if not scene.startswith("res://") or any(part in ("", ".", "..") for part in scene[6:].split("/")) or "\\" in scene or any(ord(char) < 32 or ord(char) == 127 for char in scene):
                            raise RuntimeError("Editor returned an invalid scene path")
                    paths = scenes["scenes"]
                    if len(set(paths)) != len(paths) or (paths and active_scene not in paths) or (not paths and active_scene):
                        raise RuntimeError("Editor returned an inconsistent open-scene inventory")
                    ordered = ([active_scene] + [path for path in paths if path != active_scene]) if paths else []
                    for scene in ordered:
                        if scene != active_scene:
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
            if op == "save_and_close_editor":
                progress("closing editor process group")
                await close_editor()
                value["editorStopped"] = True
        emit({"id": message["id"], "ok": True, "value": value})
    except Exception as error:
        diagnostic = error_diagnostic(error, op, step, started, timeout_ms, observations)
        detail = redact(str(error))
        if isinstance(error, TimeoutError):
            detail = "Lifecycle %s timed out while %s%s" % (op, step, (": " + detail) if detail else "")
        elif getattr(error, "exceptions", None) is not None:
            detail = "Lifecycle %s failed while %s: %s" % (op, step, "; ".join(leaf["type"] + ": " + leaf["message"] for leaf in diagnostic["leaves"]))
        elif not detail:
            detail = "Lifecycle %s failed while %s (%s)" % (op, step, type(error).__name__)
        emit({"id": message["id"], "ok": False, "error": bounded_text(redact(detail), 4096), "diagnostic": diagnostic})

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
    watchers += [asyncio.create_task(editor_exit.wait()), asyncio.create_task(done.wait())]
    input_task = asyncio.create_task(pipe_input())
    try:
        await asyncio.wait([*watchers, input_task], return_when=asyncio.FIRST_COMPLETED)
        if not done.is_set():
            if input_task.done():
                await input_task
            raise RuntimeError("Managed editor, backend, display or Host pipe exited")
    finally:
        # Control clients own attach processes outside children. Unwind their
        # context managers before waiting for captures that need their EOF.
        input_task.cancel()
        try:
            await asyncio.wait_for(asyncio.gather(input_task, return_exceptions=True), 4)
        except (TimeoutError, asyncio.TimeoutError):
            pass
        finally:
            for watcher in watchers:
                watcher.cancel()
            await asyncio.gather(*watchers, return_exceptions=True)

async def managed_main():
    try:
        await main()
    finally:
        await asyncio.gather(*(stop(process) for process in list(children)), return_exceptions=True)
        await asyncio.gather(*(finish_capture(task) for task in captures), return_exceptions=True)

asyncio.run(managed_main())

`;
