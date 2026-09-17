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
import { expect, it } from "vitest";
import { GodotMcpEnvironment } from "../../../apps/cli/src/vnext/godot-mcp-environment.js";
import { SrtSandboxController } from "../../../apps/cli/src/vnext/srt-sandbox-controller.js";

it("authors, plays, inspects and saves a real game across a coding/editor switch", async () => {
  const root = await mkdtemp(join(tmpdir(), "cr-mcp-test-"));
  const workspace = join(root, "project");
  await mkdir(workspace);
  await writeFile(
    join(workspace, "project.godot"),
    'config_version=5\n[application]\nconfig/name="MCP integration"\nrun/main_scene="res://main.tscn"\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n',
  );
  await writeFile(
    join(workspace, "main.tscn"),
    '[gd_scene load_steps=2 format=3]\n[ext_resource type="Script" path="res://main.gd" id="1"]\n[node name="Main" type="Node2D"]\nscript=ExtResource("1")\n',
  );
  const script =
    'extends Node2D\nvar answer := 40\nfunc _input(event):\n\tif event.is_action_pressed("ui_right"):\n\t\tanswer += 1\nfunc _draw():\n\tdraw_rect(Rect2(20,20,120,120), Color.RED)\n';
  await writeFile(join(workspace, "main.gd"), script);
  const controller = new SrtSandboxController();
  const environment = await GodotMcpEnvironment.create({
    controller,
    workspace,
    godot: resolve(
      process.env.GODOT_BIN ??
        ".tools/godot/4.7.1/Godot_v4.7.1-stable_linux.x86_64",
    ),
    recordsDirectory: join(root, "records"),
    isolationReadRoots: [root],
    admit: () => undefined,
  });
  const call = (name: string, args: object = {}) =>
    environment.runTool(name, "test", () =>
      environment.control({ op: "call", name, arguments: args }),
    );
  try {
    await writeFile(join(root, "host-secret"), "host-only fixture");
    await environment.prepare();
    // Preparing the MCP catalog must not import or launch the project.
    expect(await readdir(workspace)).not.toContain(".godot");
    await writeFile(
      join(environment.agentDirectory, "host-cache"),
      "host-only cache",
    );
    expect(await call("editor_state")).toBeTruthy();
    await call("scene_open", { path: "res://main.tscn" });
    await call("node_create", {
      type: "Node2D",
      name: "Added",
      parent_path: "/Main",
    });
    // A source write forces the unsaved editor node to disk before executing.
    await environment.runCoding("write", async () => {
      expect(await readFile(join(workspace, "main.tscn"), "utf8")).toContain(
        'name="Added"',
      );
      await writeFile(join(workspace, "main.gd"), script.replace("40", "41"));
    });
    await call("project_run");
    expect(
      await call("editor_manage", {
        op: "game_eval",
        params: { code: "return get_tree().current_scene.answer" },
      }),
    ).toMatchObject({ result: 41 });
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
    const running = await call("editor_manage", {
      op: "game_eval",
      params: {
        code: 'var file = FileAccess.open("user://continuity.txt", FileAccess.WRITE)\nfile.store_string("task save")\nfile.close()\nreturn OS.get_process_id()',
      },
    });
    const waitResult = await environment.wait("live-wait", 100);
    expect(waitResult).toMatchObject({
      editorState: "ready",
      editorGeneration: 2,
    });
    expect(waitResult.elapsedMs).toBeGreaterThanOrEqual(90);
    expect(
      await call("editor_manage", {
        op: "game_eval",
        params: { code: "return OS.get_process_id()" },
      }),
    ).toEqual(running);
    const screenshot = (await environment.runTool(
      "editor_screenshot",
      "screenshot",
      () =>
        environment.control({
          op: "call_raw",
          name: "editor_screenshot",
          arguments: { source: "game" },
        }),
    )) as {
      content: { type: string; data?: string; mimeType?: string }[];
      isError?: boolean;
    };
    expect(screenshot.isError).not.toBe(true);
    const image = screenshot.content.find((part) => part.type === "image");
    expect(image?.mimeType).toBe("image/png");
    expect(
      Buffer.from(image!.data!, "base64").subarray(0, 8).toString("hex"),
    ).toBe("89504e470d0a1a0a");
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
              () => tool.execute(...args),
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
            path: "probe.txt",
            content: "saved through SRT",
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
        fauxAssistantMessage(
          fauxToolCall("bash", { command: "cat probe.txt" }),
        ),
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
      expect(await readFile(join(workspace, "probe.txt"), "utf8")).toBe(
        "saved through SRT",
      );
      expect(JSON.stringify(results[2]!.content)).toContain(
        "Previous runtime references are invalid",
      );
    } finally {
      await session.shutdownExtensions?.();
      session.dispose();
    }
    await call("project_run");
    expect(
      await call("editor_manage", {
        op: "game_eval",
        params: {
          code: 'return FileAccess.get_file_as_string("user://continuity.txt")',
        },
      }),
    ).toMatchObject({ result: "task save" });
    await environment.close();
    const lifecycle = JSON.parse(
      await readFile(environment.recordPaths()[0]!, "utf8"),
    ) as { events: { event: string; requiresEditor?: boolean }[] };
    // Initial actual call, after the source write, and after the Pi write/bash.
    // The intervening describe + bash must not add an editor startup.
    expect(
      lifecycle.events.filter((entry) => entry.event === "editor_ready"),
    ).toHaveLength(3);
    expect(
      lifecycle.events.filter((entry) => entry.event === "backend_stopped"),
    ).toHaveLength(1);
    expect(
      lifecycle.events.filter(
        (entry) => entry.event === "tool" && entry.requiresEditor === false,
      ),
    ).toHaveLength(3);
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
    try {
      await fresh.prepare();
      await fresh.runTool("project_run", "fresh-run", () =>
        fresh.control({ op: "call", name: "project_run" }),
      );
      expect(
        await fresh.runTool("editor_manage", "fresh-save", () =>
          fresh.control({
            op: "call",
            name: "editor_manage",
            arguments: {
              op: "game_eval",
              params: {
                code: 'return FileAccess.file_exists("user://continuity.txt")',
              },
            },
          }),
        ),
      ).toMatchObject({ result: false });
    } finally {
      await fresh.close();
      await fresh.removeManagedFiles();
    }
  } finally {
    await controller.close();
    // Retain failed runtime logs in the task directory for diagnosis.
    if (process.env.CHRONORIFT_KEEP_TEST_ARTIFACTS !== "1") {
      await rm(root, { recursive: true, force: true });
      await rm(environment.root, { recursive: true, force: true });
    }
  }
}, 300_000);
