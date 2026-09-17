import {
  InMemoryCredentialStore,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  ModelRuntime,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import {
  createManagedPiSession,
  createManagedMcpProbe,
  type ManagedMcpProbe,
  type ManagedMcpProbeResult,
  createVNextCodingToolDefinitions,
} from "../src/index.js";
import { SandboxPiCodingToolPort } from "../../../apps/cli/src/vnext/pi-coding-tool-port.js";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import { GodotMcpEnvironment } from "../../../apps/cli/src/vnext/godot-mcp-environment.js";
import { SrtSandboxController } from "../../../apps/cli/src/vnext/srt-sandbox-controller.js";

it("keeps one MCP backend across cold coding and two clean editor restarts", async () => {
  const root = await mkdtemp(join(tmpdir(), "cr-mcp-test-"));
  const workspace = join(root, "project");
  await mkdir(workspace);
  await writeFile(
    join(workspace, "project.godot"),
    'config_version=5\n[application]\nconfig/name="MCP integration"\nrun/main_scene="res://main.tscn"\n[autoload]\nFixtureOverlay="*res://overlay.tscn"\n[display/window]\nsize/viewport_width=640\nsize/viewport_height=480\nsize/window_width_override=640\nsize/window_height_override=480\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n',
  );
  await writeFile(
    join(workspace, "main.tscn"),
    '[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path="res://main.gd" id="1"]\n[node name="Main" type="Node2D"]\nscript=ExtResource("1")\n[node name="MainLabel" type="Label" parent="."]\ntext="scene-ui"\noffset_top=160.0\n',
  );
  await writeFile(
    join(workspace, "overlay.tscn"),
    '[gd_scene format=3]\n[node name="FixtureOverlay" type="CanvasLayer"]\n[node name="AutoloadLabel" type="Label" parent="."]\ntext="autoload-ui"\noffset_top=180.0\n',
  );
  const script =
    'extends Node2D\nvar answer := 40\nvar process_nonce = Crypto.new().generate_random_bytes(16).hex_encode()\nfunc _input(event):\n\tif event.is_action_pressed("ui_right"):\n\t\tanswer += 1\nfunc _draw():\n\tdraw_rect(Rect2(20,20,120,120), Color.RED)\nfunc add_late_ui():\n\tawait get_tree().create_timer(0.25).timeout\n\tvar label := Label.new()\n\tlabel.name = "LateUi"\n\tlabel.text = "late-ui"\n\tadd_child(label)\n';
  await writeFile(join(workspace, "main.gd"), script);
  const controller = new SrtSandboxController();
  const openEditor = vi.spyOn(controller, "openEditor");
  const godot = resolve(
    process.env.GODOT_BIN ??
      ".tools/godot/4.7.1/Godot_v4.7.1-stable_linux.x86_64",
  );
  const projectGodotPids = async () => {
    const candidates = (await readdir("/proc")).filter((name) =>
      /^\d+$/u.test(name),
    );
    const matches = await Promise.all(
      candidates.map(async (pid) => {
        try {
          const argv = (await readFile(`/proc/${pid}/cmdline`, "utf8")).split(
            "\0",
          );
          return argv[0] === godot && argv.includes(workspace) ? pid : null;
        } catch (error) {
          if (
            ["ENOENT", "ESRCH"].includes(
              (error as NodeJS.ErrnoException).code ?? "",
            )
          )
            return null;
          throw error;
        }
      }),
    );
    return matches.filter((pid) => pid !== null);
  };
  const environment = await GodotMcpEnvironment.create({
    controller,
    workspace,
    godot,
    recordsDirectory: join(root, "records"),
    isolationReadRoots: [root],
    admit: () => undefined,
  });
  let probe: ManagedMcpProbe | undefined;
  let callId = 0;
  const homePath = join(root, "coding-home");
  const tempPath = join(root, "coding-tmp");
  const artifactsPath = join(root, "coding-artifacts");
  await Promise.all(
    [homePath, tempPath, artifactsPath].map((path) => mkdir(path)),
  );
  const coding = createVNextCodingToolDefinitions(
    new SandboxPiCodingToolPort(controller, {
      workspacePath: workspace,
      homePath,
      tempPath,
      artifactsPath,
    }),
  );
  const openProbe = async (managed = environment) => {
    const opened = await createManagedMcpProbe({
      resourceWorkspaceDirectory: workspace,
      mcpEnvironment: managed,
    });
    try {
      const catalog = await opened.execute({
        id: `catalog-${++callId}`,
        name: "mcp",
        args: { search: "game" },
      });
      expect(catalog.isError, JSON.stringify(catalog)).toBe(false);
      return opened;
    } catch (error) {
      await opened.close();
      throw error;
    }
  };
  const rawCall = async (
    name: string,
    args: Record<string, unknown> = {},
    target = probe!,
  ) => {
    const native = `godot-ai_${name}`;
    return target.execute(
      target.tools().some((tool) => tool.name === native)
        ? { id: `probe-${++callId}`, name: native, args }
        : {
            id: `probe-${++callId}`,
            name: "mcp",
            args: { tool: native, args },
          },
    );
  };
  const parseResult = (result: ManagedMcpProbeResult): unknown => {
    const parsed = result.content.flatMap((part) => {
      if (part.type !== "text") return [];
      try {
        return [JSON.parse(part.text) as unknown];
      } catch {
        return [];
      }
    });
    expect(parsed, JSON.stringify(result)).toHaveLength(1);
    return parsed[0];
  };
  const call = async (
    name: string,
    args: Record<string, unknown> = {},
    target = probe!,
  ) => {
    const result = await rawCall(name, args, target);
    expect(result.isError, JSON.stringify(result)).toBe(false);
    return parseResult(result);
  };
  const waitForScene = async (target = probe!) => {
    const until = Date.now() + 60_000;
    while (Date.now() < until) {
      const observed = await rawCall(
        "editor_manage",
        {
          op: "game_eval",
          params: { code: "return get_tree().current_scene != null" },
        },
        target,
      );
      if (!observed.isError) {
        const parsed = parseResult(observed) as { result?: unknown };
        if (parsed.result === true) return;
      }
      const waited = await target.execute({
        id: `wait-${++callId}`,
        name: "environment_wait",
        args: { duration_ms: 250 },
      });
      expect(waited.isError, JSON.stringify(waited)).toBe(false);
    }
    throw new Error(
      "Runtime scene did not become observable within 60 seconds",
    );
  };
  try {
    await writeFile(join(root, "host-secret"), "host-only fixture");
    await environment.prepare();
    expect(openEditor).toHaveBeenCalledTimes(1);
    // Preparing the MCP catalog must not import or launch the project.
    expect(await readdir(workspace)).not.toContain(".godot");
    probe = await openProbe();
    expect(await readdir(workspace)).not.toContain(".godot");
    const bash = coding.find((tool) => tool.name === "bash")!;
    await environment.runCoding("bash", async () => {
      const result = await bash.execute(
        "cold-bash",
        { command: "cat main.gd" },
        undefined,
        undefined,
        {} as never,
      );
      expect(JSON.stringify(result.content)).toContain("var answer := 40");
    });
    expect(openEditor).toHaveBeenCalledTimes(1);
    expect(await readdir(workspace)).not.toContain(".godot");
    expect(await projectGodotPids()).toEqual([]);
    await writeFile(
      join(environment.agentDirectory, "host-cache"),
      "host-only cache",
    );
    expect(await call("editor_state")).toBeTruthy();
    await call("scene_open", { path: "res://main.tscn" });
    await rawCall("project_run");
    await waitForScene();
    const initial = (await call("editor_manage", {
      op: "game_eval",
      params: {
        code: 'var file = FileAccess.open("user://continuity.txt", FileAccess.WRITE)\nfile.store_string("task save")\nfile.close()\nreturn {"answer": get_tree().current_scene.answer, "nonce": get_tree().current_scene.process_nonce}',
      },
    })) as { result: { answer: number; nonce: string } };
    expect(initial.result.answer).toBe(40);
    expect(initial.result.nonce).toMatch(/^[0-9a-f]{32}$/u);
    expect((await projectGodotPids()).length).toBeGreaterThanOrEqual(2);
    // Upstream rejects editor mutations while playing. The later Pi write
    // exercises the source barrier with the game still running.
    await call("project_manage", { op: "stop" });
    await call("node_create", {
      type: "Node2D",
      name: "Added",
      parent_path: "/Main",
    });
    expect(await readFile(join(workspace, "main.tscn"), "utf8")).not.toContain(
      'name="Added"',
    );
    // A source write forces the unsaved editor node to disk before executing.
    await environment.runCoding("write", async () => {
      expect(await projectGodotPids()).toEqual([]);
      expect(await readFile(join(workspace, "main.tscn"), "utf8")).toContain(
        'name="Added"',
      );
      await writeFile(join(workspace, "main.gd"), script.replace("40", "41"));
    });
    expect(openEditor).toHaveBeenCalledTimes(1);
    await rawCall("project_run");
    await waitForScene();
    expect(
      await call("editor_manage", {
        op: "game_eval",
        params: { code: "return get_tree().current_scene.answer" },
      }),
    ).toMatchObject({ result: 41 });
    const sceneUi = await call("game_manage", {
      op: "get_ui_elements",
    });
    expect(JSON.stringify(sceneUi)).toContain("scene-ui");
    expect(JSON.stringify(sceneUi)).not.toContain("autoload-ui");
    const autoloadUi = (await call("game_manage", {
      op: "get_ui_elements",
      params: { root_path: "/root/FixtureOverlay" },
    })) as { elements: { text?: string }[] };
    expect(autoloadUi.elements.map((element) => element.text)).toContain(
      "autoload-ui",
    );
    expect(await call("editor_state")).toMatchObject({ helper_live: true });
    expect(
      await call("editor_manage", {
        op: "game_eval",
        params: {
          code: 'var main = get_tree().current_scene\nmain.add_late_ui()\nreturn {"target_ready": main.has_node("LateUi")}',
        },
      }),
    ).toMatchObject({ result: { target_ready: false } });
    // Helper readiness precedes this explicitly delayed target; observe both.
    expect(
      await call("editor_manage", {
        op: "game_eval",
        params: {
          code: 'await get_tree().create_timer(0.4).timeout\nreturn {"target_ready": get_tree().current_scene.has_node("LateUi")}',
        },
      }),
    ).toMatchObject({ result: { target_ready: true } });
    const sampled = (await call("editor_manage", {
      op: "game_eval",
      params: {
        code: 'var samples = []\nfor index in range(3):\n\tawait get_tree().process_frame\n\tvar viewport_size = get_viewport().get_visible_rect().size\n\tvar window_size = DisplayServer.window_get_size()\n\tsamples.append({"index": index, "viewport": [viewport_size.x, viewport_size.y], "window": [window_size.x, window_size.y]})\nreturn {"samples": samples, "count": samples.size()}',
      },
    })) as {
      result: {
        count: number;
        samples: { index: number; viewport: number[]; window: number[] }[];
      };
    };
    expect(sampled.result.count).toBe(3);
    expect(sampled.result.samples).toEqual(
      [0, 1, 2].map((index) => ({
        index,
        viewport: [640, 480],
        window: [640, 480],
      })),
    );
    const visibility = await call("editor_manage", {
      op: "game_eval",
      params: {
        code: `return {"secret": FileAccess.file_exists(${JSON.stringify(join(root, "host-secret"))}), "cache": FileAccess.file_exists(${JSON.stringify(join(environment.agentDirectory, "host-cache"))}), "socket": FileAccess.file_exists(${JSON.stringify(environment.socketPath)})}`,
      },
    });
    expect(visibility).toMatchObject({
      result: { secret: false, cache: false, socket: false },
    });
    await call("game_manage", {
      op: "input_key",
      params: { key: "Right", pressed: true },
    });
    const observed = await call("editor_manage", {
      op: "game_eval",
      params: { code: "return get_tree().current_scene.answer" },
    });
    expect(observed).toMatchObject({ result: 42 });
    const running = (await call("editor_manage", {
      op: "game_eval",
      params: {
        code: 'return {"pid": OS.get_process_id(), "nonce": get_tree().current_scene.process_nonce, "saved": FileAccess.get_file_as_string("user://continuity.txt")}',
      },
    })) as { result: { pid: number; nonce: string; saved: string } };
    expect(running.result.nonce).toMatch(/^[0-9a-f]{32}$/u);
    expect(running.result.nonce).not.toBe(initial.result.nonce);
    expect(running.result.saved).toBe("task save");
    const waitReceipt = await probe.execute({
      id: "live-wait",
      name: "environment_wait",
      args: { duration_ms: 100 },
    });
    expect(waitReceipt.isError).toBe(false);
    const waitResult = (
      waitReceipt.details as {
        chronorift: {
          elapsedMs: number;
          editorState: string;
          editorGeneration: number;
        };
      }
    ).chronorift;
    expect(waitResult).toMatchObject({
      editorState: "ready",
      editorGeneration: 2,
    });
    expect(waitResult.elapsedMs).toBeGreaterThanOrEqual(90);
    expect(
      await call("editor_manage", {
        op: "game_eval",
        params: {
          code: 'return {"pid": OS.get_process_id(), "nonce": get_tree().current_scene.process_nonce, "saved": FileAccess.get_file_as_string("user://continuity.txt")}',
        },
      }),
    ).toEqual(running);
    const screenshot = await rawCall("editor_screenshot", { source: "game" });
    expect(screenshot.isError).not.toBe(true);
    const image = screenshot.content.find((part) => part.type === "image");
    expect(image?.mimeType).toBe("image/png");
    expect(
      Buffer.from(image!.data!, "base64").subarray(0, 8).toString("hex"),
    ).toBe("89504e470d0a1a0a");
    await probe.close();
    probe = undefined;
    // Exercise the installed Pi adapter against the real server, including reconnection.
    const faux = fauxProvider({
      api: "cr-real-mcp",
      provider: "cr-real-mcp",
      models: [{ id: "offline", input: ["text", "image"] }],
    });
    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      allowModelNetwork: false,
    });
    modelRuntime.registerNativeProvider(faux.provider);
    let raw: AgentSession | undefined;
    const session = await createManagedPiSession(
      {
        resourceWorkspaceDirectory: workspace,
        sessionDirectory: join(root, "sessions"),
        agentDir: environment.agentDirectory,
        modelRuntime,
        model: modelRuntime.getModel("cr-real-mcp", "offline")!,
        thinkingLevel: "off",
        mcpEnvironment: environment,
        tools: coding.map((tool) => ({
          ...tool,
          execute: (...args: Parameters<typeof tool.execute>) =>
            environment.runCoding(
              tool.name,
              async () => {
                if (["bash", "edit", "write"].includes(tool.name))
                  expect(await projectGodotPids()).toEqual([]);
                return tool.execute(...args);
              },
              args[2],
            ),
        })),
      },
      {
        createSession: async (options) => {
          const result = await createAgentSession(options);
          raw = result.session;
          return result;
        },
      },
    );
    try {
      faux.setResponses([
        fauxAssistantMessage(fauxToolCall("mcp", { search: "screenshot" })),
        fauxAssistantMessage(
          fauxToolCall("godot-ai_editor_screenshot", { source: "game" }),
        ),
        fauxAssistantMessage(
          fauxToolCall("write", {
            path: "main.gd",
            content: script.replace("40", "43"),
          }),
        ),
        fauxAssistantMessage(
          fauxToolCall("godot-ai_project_manage", { op: "stop" }),
        ),
        fauxAssistantMessage(
          fauxToolCall("mcp", {
            tool: "godot_ai_project_manage",
            args: { op: "stop" },
          }),
        ),
        fauxAssistantMessage(
          fauxToolCall("mcp", { describe: "godot_ai_script_patch" }),
        ),
        fauxAssistantMessage(fauxToolCall("bash", { command: "cat main.gd" })),
        fauxAssistantMessage(
          fauxToolCall("mcp", { tool: "godot_ai_editor_state", args: {} }),
        ),
        fauxAssistantMessage("Finished offline fixture."),
      ]);
      await session.prompt(
        "Capture game, write a file, then inspect the reopened editor.",
      );
      const results = raw!.state.messages.filter(
        (message) => message.role === "toolResult",
      );
      expect(results).toHaveLength(8);
      for (const result of results)
        expect(result.isError, JSON.stringify(result.content)).toBe(false);
      expect(results[1]!.content.some((part) => part.type === "image")).toBe(
        true,
      );
      for (const index of [3, 4])
        expect(JSON.stringify(results[index]!.content)).toContain(
          "already stopped",
        );
      expect(await readFile(join(workspace, "main.gd"), "utf8")).toBe(
        script.replace("40", "43"),
      );
      expect(JSON.stringify(results[2]!.content)).toContain(
        "Previous runtime references are invalid",
      );
      expect(openEditor).toHaveBeenCalledTimes(1);
    } finally {
      await session.shutdownExtensions?.();
      session.dispose();
    }
    probe = await openProbe();
    await rawCall("project_run");
    await waitForScene();
    expect(
      await call("editor_manage", {
        op: "game_eval",
        params: {
          code: 'return FileAccess.get_file_as_string("user://continuity.txt")',
        },
      }),
    ).toMatchObject({ result: "task save" });
    const restarted = (await call("editor_manage", {
      op: "game_eval",
      params: {
        code: 'return {"pid": OS.get_process_id(), "nonce": get_tree().current_scene.process_nonce, "answer": get_tree().current_scene.answer}',
      },
    })) as { result: { pid: number; nonce: string; answer: number } };
    // Compare game identity, without relying on numeric PID allocation.
    expect(restarted.result.nonce).toMatch(/^[0-9a-f]{32}$/u);
    expect(restarted.result.nonce).not.toBe(running.result.nonce);
    expect(restarted.result.nonce).not.toBe(initial.result.nonce);
    expect(restarted.result.answer).toBe(43);
    expect(openEditor).toHaveBeenCalledTimes(1);
    await probe.close();
    probe = undefined;
    await environment.close();
    const lifecycle = JSON.parse(
      await readFile(environment.recordPaths()[0]!, "utf8"),
    ) as {
      events: {
        event: string;
        id?: string;
        requiresEditor?: boolean;
        editorGeneration?: number;
        reason?: string;
      }[];
    };
    // Initial actual call, after the source write, and after the Pi write/bash.
    // The intervening describe + bash must not add an editor startup.
    expect(
      lifecycle.events.filter((entry) => entry.event === "editor_ready"),
    ).toHaveLength(3);
    expect(
      lifecycle.events.filter((entry) => entry.event === "backend_stopped"),
    ).toHaveLength(1);
    expect(
      lifecycle.events.filter((entry) => entry.event === "backend_ready"),
    ).toHaveLength(1);
    expect(
      lifecycle.events.filter((entry) => entry.event === "process_exit"),
    ).toHaveLength(1);
    expect(
      lifecycle.events
        .filter((entry) => entry.event === "editor_closed")
        .map((entry) => ({
          generation: entry.editorGeneration,
          reason: entry.reason,
        })),
    ).toEqual([
      { generation: 1, reason: "write" },
      { generation: 2, reason: "write" },
      { generation: 3, reason: "close" },
    ]);
    expect(await projectGodotPids()).toEqual([]);
    const catalogs = lifecycle.events.filter(
      (entry) => entry.event === "tool" && entry.id?.startsWith("catalog-"),
    );
    expect(catalogs).toHaveLength(2);
    expect(catalogs.every((entry) => entry.requiresEditor === false)).toBe(
      true,
    );
    expect(catalogs.map((entry) => entry.editorGeneration)).toEqual([0, 3]);
    await environment.removeManagedFiles();
    expect(
      await readFile(join(workspace, "project.godot"), "utf8"),
    ).not.toContain("godot_ai");
    const fresh = await GodotMcpEnvironment.create({
      controller,
      workspace,
      godot: resolve(
        process.env.GODOT_BIN ??
          ".tools/godot/4.7.1/Godot_v4.7.1-stable_linux.x86_64",
      ),
      recordsDirectory: join(root, "fresh-records"),
      isolationReadRoots: [root],
      admit: () => undefined,
    });
    let freshProbe: ManagedMcpProbe | undefined;
    try {
      await fresh.prepare();
      freshProbe = await openProbe(fresh);
      await rawCall("project_run", {}, freshProbe);
      await waitForScene(freshProbe);
      expect(
        await call(
          "editor_manage",
          {
            op: "game_eval",
            params: {
              code: 'return FileAccess.file_exists("user://continuity.txt")',
            },
          },
          freshProbe,
        ),
      ).toMatchObject({ result: false });
    } finally {
      await freshProbe?.close();
      await fresh.close();
      await fresh.removeManagedFiles();
    }
  } finally {
    await probe?.close();
    await environment.close();
    await controller.close();
    // Retain failed runtime logs in the task directory for diagnosis.
    if (process.env.CHRONORIFT_KEEP_TEST_ARTIFACTS !== "1") {
      await rm(root, { recursive: true, force: true });
      await rm(environment.root, { recursive: true, force: true });
    }
  }
}, 300_000);
