import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import type {
  ManagedMcpEnvironment,
  ManagedMcpToolRequest,
} from "@chronorift/pi-harness";
import type {
  SrtDuplexHandle,
  SrtSandboxController,
} from "./srt-sandbox-controller.js";
import { resolveGodotMcpInstallation } from "./godot-mcp-installation.js";
import { GodotMcpTransport } from "./godot-mcp-transport.js";
import { GODOT_MCP_SUPERVISOR } from "./godot-mcp-supervisor.js";

const PLUGIN = '"res://addons/godot_ai/plugin.cfg"';
const AUTOLOAD =
  '_mcp_game_helper="*res://addons/godot_ai/runtime/game_helper.gd"';

/** Change only the managed entries; preserve unrelated Godot configuration. */
export function addGodotMcpConfiguration(source: string): string {
  let result = source;
  if (!result.includes("[editor_plugins]"))
    result += "\n[editor_plugins]\nenabled=PackedStringArray()\n";
  result = result.replace(
    /(\[editor_plugins\][\s\S]*?)(?=\n\[|$)/u,
    (section) => {
      if (section.includes(PLUGIN)) return section;
      if (/enabled=PackedStringArray\(([^)]*)\)/u.test(section))
        return section.replace(
          /enabled=PackedStringArray\(([^)]*)\)/u,
          (_match, values: string) =>
            `enabled=PackedStringArray(${values.trim() ? values + ", " : ""}${PLUGIN})`,
        );
      return section + `\nenabled=PackedStringArray(${PLUGIN})\n`;
    },
  );
  if (!result.includes("[autoload]")) result += "\n[autoload]\n";
  const existing = result.match(/^_mcp_game_helper=.*$/mu)?.[0];
  if (existing !== undefined && existing !== AUTOLOAD)
    throw new Error("Project already defines a conflicting Godot AI helper");
  if (existing === undefined)
    result = result.replace("[autoload]", "[autoload]\n" + AUTOLOAD);
  return result;
}

export function removeGodotMcpConfiguration(
  source: string,
  original: string,
): string {
  let result = source;
  if (!original.includes(PLUGIN))
    result = result.replace(
      /,?\s*"res:\/\/addons\/godot_ai\/plugin.cfg"\s*,?/u,
      (value) =>
        value.startsWith(",") && value.trimEnd().endsWith(",") ? ", " : "",
    );
  if (!original.includes(AUTOLOAD))
    result = result.replace(/^_mcp_game_helper=.*\n?/mu, "");
  for (const section of ["editor_plugins", "autoload"]) {
    if (!original.includes(`[${section}]`))
      result = result.replace(
        new RegExp(
          `\\n?\\[${section}\\]\\s*(?:enabled=PackedStringArray\\(\\)\\s*)?(?=\\[|$)`,
          "u",
        ),
        "",
      );
  }
  if (original.endsWith("\n") && !result.endsWith("\n")) result += "\n";
  return result;
}

export class GodotMcpEnvironment implements ManagedMcpEnvironment {
  private readonly runs: string[] = [];
  private transport: GodotMcpTransport | undefined;
  private process: SrtDuplexHandle | undefined;
  private tail: Promise<unknown> = Promise.resolve();
  private originalConfig = "";
  private injectedAddon = false;
  private activeScene = "";
  private editorState: "stopped" | "starting" | "ready" | "failed" = "stopped";
  private editorGeneration = 0;
  private closed = false;
  private stopping = false;
  private unsavedChangesPossible = false;
  private readonly records: object[] = [];
  private installation:
    Awaited<ReturnType<typeof resolveGodotMcpInstallation>> | undefined;
  private constructor(
    readonly root: string,
    private readonly options: {
      controller: SrtSandboxController;
      workspace: string;
      godot: string;
      recordsDirectory: string;
      isolationReadRoots: readonly string[];
      admit: (name: string) => void;
    },
  ) {}
  get socketPath(): string {
    return join(this.root, "mcp.sock");
  }
  get agentDirectory(): string {
    return join(this.root, "pi");
  }
  static async create(
    options: GodotMcpEnvironment["options"],
  ): Promise<GodotMcpEnvironment> {
    const instance = new GodotMcpEnvironment(
      await mkdtemp(join(tmpdir(), "cr-mcp-")),
      options,
    );
    await Promise.all(
      ["runtime", "pi", "godot-data"].map((part) =>
        mkdir(join(instance.root, part), { mode: 0o700 }),
      ),
    );
    return instance;
  }
  async prepare(): Promise<void> {
    this.installation = await resolveGodotMcpInstallation();
    this.originalConfig = await readFile(
      join(this.options.workspace, "project.godot"),
      "utf8",
    );
    await assertDirectoryChain(this.options.workspace, ["addons", "godot_ai"]);
    const target = join(this.options.workspace, "addons/godot_ai");
    this.injectedAddon = await lstat(target).then(
      () => false,
      () => true,
    );
    for (const [path, expected] of Object.entries(this.installation.files)) {
      const relative = path.slice("plugin/".length);
      const destination = join(this.options.workspace, relative);
      if (!this.injectedAddon) {
        const stat = await lstat(destination);
        if (
          !stat.isFile() ||
          stat.nlink !== 1 ||
          createHash("sha256")
            .update(await readFile(destination))
            .digest("hex") !== expected
        )
          throw new Error(
            "Existing Godot AI addon does not match the pinned release",
          );
      } else {
        await mkdir(dirname(destination), { recursive: true });
        await copyFile(
          join(this.installation.directory, path),
          destination,
          constants.COPYFILE_EXCL,
        );
      }
    }
    await writeFile(
      join(this.options.workspace, "project.godot"),
      addGodotMcpConfiguration(this.originalConfig),
    );
    await writeFile(join(this.root, "supervisor.py"), GODOT_MCP_SUPERVISOR, {
      mode: 0o600,
    });
    this.transport = new GodotMcpTransport(this.socketPath);
    await this.transport.listen();
    await this.start();
  }
  private async start(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (this.closed) throw new Error("Godot MCP environment is closed");
    if (this.process !== undefined) return;
    const installation = this.installation;
    if (installation === undefined)
      throw new Error("Godot MCP environment is not prepared");
    const runDirectory = await mkdtemp(join(this.root, "runtime/run-"));
    this.runs.push(runDirectory);
    await Promise.all(
      ["home", "tmp"].map((part) =>
        mkdir(join(runDirectory, part), { mode: 0o700 }),
      ),
    );
    const started = Date.now();
    // A tool/turn signal must not remain attached to a long-lived editor after
    // the initiating call ends (e.g. cancelling a later Host wait).
    const startupAbort = new AbortController();
    const abortStartup = () => startupAbort.abort(signal?.reason);
    signal?.addEventListener("abort", abortStartup, { once: true });
    if (signal?.aborted) abortStartup();
    let process: SrtDuplexHandle;
    try {
      process = await this.options.controller.openEditor({
        workspacePath: this.options.workspace,
        cwd: this.options.workspace,
        homePath: join(runDirectory, "home"),
        tempPath: join(runDirectory, "tmp"),
        artifactsPath: runDirectory,
        godotDataPath: join(this.root, "godot-data"),
        readOnlyPaths: [
          join(this.root, "supervisor.py"),
          installation.directory,
          this.options.godot,
          dirname(dirname(installation.xvfb)),
        ],
        isolationReadRoots: [...this.options.isolationReadRoots, this.root],
        argv: [
          installation.python,
          join(this.root, "supervisor.py"),
          runDirectory,
          this.options.workspace,
          this.options.godot,
          installation.xvfb,
        ],
        environment: {
          DISPLAY: "127.0.0.1:99",
          LD_LIBRARY_PATH: join(
            dirname(dirname(installation.xvfb)),
            "lib/x86_64-linux-gnu",
          ),
          LIBGL_ALWAYS_SOFTWARE: "1",
          PYTHONNOUSERSITE: "1",
          PYTHONUNBUFFERED: "1",
          GODOT_AI_DISABLE_TELEMETRY: "true",
          GODOT_AI_MODE: "dev",
          GODOT_AI_CAPABILITY_DIR: join(runDirectory, "home/capabilities"),
          CHRONORIFT_RESTORE_SCENE: this.activeScene,
          CHRONORIFT_GODOT_DATA_HOME: join(this.root, "godot-data"),
        },
        timeoutMs: 5_400_000,
        ...(signal === undefined ? {} : { signal: startupAbort.signal }),
      });
    } finally {
      signal?.removeEventListener("abort", abortStartup);
    }
    this.process = process;
    const ready = this.transport!.bind(process);
    void process.wait().then((result) => {
      if (
        this.process === process &&
        !this.stopping &&
        this.editorState === "ready"
      )
        this.unsavedChangesPossible = true;
      this.records.push({
        event: "process_exit",
        ...result,
        stdout: result.stdout.slice(0, 4096),
        stdoutTruncated: result.stdoutTruncated || result.stdout.length > 4096,
      });
      if (this.process === process) {
        this.process = undefined;
        this.editorState = this.stopping ? "stopped" : "failed";
      }
      return result;
    });
    try {
      signal?.throwIfAborted();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          ready,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new Error("Godot MCP startup timed out")),
              150_000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      await access(this.socketPath);
      this.records.push({
        event: "backend_ready",
        durationMs: Date.now() - started,
        activeScene: this.activeScene,
      });
    } catch (error) {
      await process.stop();
      throw error;
    }
  }
  private serial<T>(
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const result = this.tail.then(() => {
      signal?.throwIfAborted();
      return operation();
    });
    this.tail = result.catch(() => undefined);
    return result;
  }
  async runTool<T>(
    name: string,
    id: string,
    operation: () => Promise<T>,
    signal?: AbortSignal,
    requiresEditor = true,
    request?: ManagedMcpToolRequest<T>,
  ): Promise<T> {
    const requestedAt = Date.now();
    return this.serial(async () => {
      this.options.admit(name);
      const started = Date.now();
      let cancellation: Promise<void> | undefined;
      const cancel = () => {
        if (this.editorState === "ready") this.unsavedChangesPossible = true;
        cancellation ??= this.stopProcess();
        void cancellation.catch(() => undefined);
      };
      signal?.addEventListener("abort", cancel, { once: true });
      let outcome = "returned";
      try {
        signal?.throwIfAborted();
        if (this.closed) throw new Error("Godot MCP environment is closed");
        if (
          this.editorState === "stopped" &&
          request?.whenEditorStopped !== undefined
        ) {
          outcome = "host_noop";
          return request.whenEditorStopped();
        }
        await this.start(signal);
        signal?.throwIfAborted();
        if (requiresEditor && this.editorState !== "ready") {
          const editorStarted = Date.now();
          this.editorState = "starting";
          this.editorGeneration += 1;
          try {
            await this.transport!.control({ op: "start_editor" }, 150_000);
            signal?.throwIfAborted();
            if (this.process === undefined)
              throw new Error("Godot MCP exited during editor startup");
            this.editorState = "ready";
          } catch (error) {
            await this.stopProcess();
            this.editorState = "failed";
            this.records.push({
              event: "editor_start_failed",
              durationMs: Date.now() - editorStarted,
              editorGeneration: this.editorGeneration,
            });
            throw error;
          }
          this.records.push({
            event: "editor_ready",
            durationMs: Date.now() - editorStarted,
            activeScene: this.activeScene,
            editorGeneration: this.editorGeneration,
          });
        }
        signal?.throwIfAborted();
        const result = await operation();
        signal?.throwIfAborted();
        return result;
      } catch (error) {
        outcome = signal?.aborted ? "cancelled" : "failed";
        throw error;
      } finally {
        signal?.removeEventListener("abort", cancel);
        if (cancellation !== undefined) {
          await cancellation;
          this.editorState = "failed";
        }
        this.records.push({
          event: "tool",
          name,
          id,
          requestedAt,
          startedAt: started,
          waitMs: started - requestedAt,
          durationMs: Date.now() - started,
          outcome,
          requiresEditor,
          ...(request === undefined
            ? {}
            : { tool: request.tool, operation: request.operation }),
          editorState: this.editorState,
          editorGeneration: this.editorGeneration,
        });
      }
    }, signal);
  }
  async runCoding<T>(
    name: string,
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    return this.serial(async () => {
      const invalidated =
        ["bash", "edit", "write"].includes(name) &&
        this.editorState === "ready";
      if (["bash", "edit", "write"].includes(name))
        await this.saveAndStop(name);
      signal?.throwIfAborted();
      const noticeText = `[ChronoRift environment] Editor generation ${this.editorGeneration} was saved and closed before ${name}. Previous runtime references are invalid. The next Godot tool reopens the editor from disk; use project_run explicitly to start a new game.`;
      let result: T;
      try {
        result = await operation();
      } catch (error) {
        if (!invalidated) throw error;
        if (error instanceof Error) {
          // Preserve error identity, cause, code and original message.
          error.message += `\n\n${noticeText}`;
          throw error;
        }
        throw new Error(`${String(error)}\n\n${noticeText}`, { cause: error });
      }
      if (
        !invalidated ||
        result === null ||
        typeof result !== "object" ||
        !("content" in result) ||
        !Array.isArray(result.content)
      )
        return result;
      const notice = {
        editorState: this.editorState,
        editorGeneration: this.editorGeneration,
        runtimeReferencesInvalidated: true,
      };
      return {
        ...result,
        content: [
          ...(result.content as unknown[]),
          {
            type: "text",
            text: noticeText,
          },
        ],
        details: {
          ...("details" in result &&
          typeof result.details === "object" &&
          result.details !== null
            ? result.details
            : {}),
          chronoriftEnvironment: notice,
        },
      };
    }, signal);
  }
  async wait(
    id: string,
    durationMs: number,
    signal?: AbortSignal,
  ): Promise<{
    elapsedMs: number;
    editorState: "stopped" | "starting" | "ready" | "failed";
    editorGeneration: number;
  }> {
    if (!Number.isInteger(durationMs) || durationMs < 0 || durationMs > 10_000)
      throw new TypeError("duration_ms must be an integer between 0 and 10000");
    const requestedAt = Date.now();
    return this.serial(async () => {
      if (this.closed) throw new Error("Godot MCP environment is closed");
      this.options.admit("environment_wait");
      const startedAt = Date.now();
      const started = performance.now();
      let outcome = "returned";
      try {
        if (durationMs > 0) await delay(durationMs, undefined, { signal });
        signal?.throwIfAborted();
        return {
          elapsedMs: performance.now() - started,
          editorState: this.editorState,
          editorGeneration: this.editorGeneration,
        };
      } catch (error) {
        outcome = signal?.aborted ? "cancelled" : "failed";
        throw error;
      } finally {
        this.records.push({
          event: "tool",
          name: "environment_wait",
          id,
          requestedAt,
          startedAt,
          waitMs: startedAt - requestedAt,
          durationMs: performance.now() - started,
          outcome,
          requiresEditor: false,
        });
      }
    }, signal);
  }
  async control(command: object): Promise<unknown> {
    if (!this.transport) throw new Error("Godot MCP transport is not prepared");
    return this.transport.control(command);
  }
  private async stopProcess(): Promise<void> {
    const process = this.process;
    this.stopping = true;
    try {
      await process?.stop();
      if (this.process === process) this.process = undefined;
      this.editorState = "stopped";
    } finally {
      this.stopping = false;
    }
  }
  private async saveAndStop(reason = "close"): Promise<void> {
    if (this.process === undefined) return;
    const started = performance.now();
    const hadEditor = this.editorState === "ready";
    if (hadEditor) {
      const saved = (await this.control({ op: "save" })) as {
        activeScene?: string;
      };
      this.activeScene =
        typeof saved.activeScene === "string" ? saved.activeScene : "";
    }
    await this.stopProcess();
    this.records.push({
      event: hadEditor ? "saved_and_stopped" : "backend_stopped",
      activeScene: this.activeScene,
      reason,
      durationMs: performance.now() - started,
      editorGeneration: this.editorGeneration,
    });
  }
  recordPaths(): readonly string[] {
    return [join(this.options.recordsDirectory, "godot-mcp.v1.json")];
  }
  async close(): Promise<void> {
    await this.tail;
    if (this.closed) return;
    let failure: Error | undefined;
    try {
      await this.saveAndStop();
    } catch (error) {
      failure =
        error instanceof Error
          ? error
          : new Error("Editor save failed", { cause: error });
    } finally {
      this.closed = true;
      await this.process?.stop();
      await this.transport?.close();
      await mkdir(this.options.recordsDirectory, { recursive: true });
      await writeFile(
        this.recordPaths()[0]!,
        JSON.stringify(
          {
            schemaVersion: 1,
            backend: "godot-ai",
            events: this.records,
            unsavedChangesPossible:
              failure !== undefined || this.unsavedChangesPossible,
          },
          null,
          2,
        ) + "\n",
      );
      for (const [index, directory] of this.runs.entries()) {
        for (const name of await readdir(directory)) {
          if (
            !/^process-\d+\.(?:stdout|stderr)\.log(?:\.truncated)?$/u.test(name)
          )
            continue;
          const value = await readRegularFile(
            join(directory, name),
            1024 * 1024,
          );
          await writeFile(
            join(this.options.recordsDirectory, `run-${index}-${name}`),
            value,
          );
        }
      }
      await rm(this.root, { recursive: true, force: true });
    }
    if (failure !== undefined) throw failure;
    if (this.unsavedChangesPossible)
      throw new Error(
        "Managed editor exited unexpectedly; unsaved editor state may have been lost. Saved disk changes remain available.",
      );
  }
  async removeManagedFiles(): Promise<void> {
    if (this.originalConfig === "") return;
    const config = join(this.options.workspace, "project.godot");
    const value = removeGodotMcpConfiguration(
      (await readRegularFile(config, 1024 * 1024)).toString("utf8"),
      this.originalConfig,
    );
    // The editor and all coding writers have stopped before this Host write.
    const handle = await open(
      config,
      constants.O_WRONLY | constants.O_NOFOLLOW,
    );
    try {
      await handle.truncate(0);
      await handle.writeFile(value);
    } finally {
      await handle.close();
    }
    await assertDirectoryChain(this.options.workspace, ["addons"]);
    if (this.injectedAddon)
      await rm(join(this.options.workspace, "addons/godot_ai"), {
        recursive: true,
        force: true,
      });
  }
}

async function readRegularFile(
  path: string,
  maxBytes: number,
): Promise<Buffer> {
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > maxBytes)
      throw new Error(`Unsafe MCP artifact: ${path}`);
    const buffer = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > maxBytes)
      throw new Error(`Oversized MCP artifact: ${path}`);
    return buffer.subarray(0, bytesRead);
  } finally {
    await file.close();
  }
}

async function assertDirectoryChain(
  root: string,
  parts: readonly string[],
): Promise<void> {
  let path = root;
  for (const part of parts) {
    path = join(path, part);
    const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (stat !== undefined && !stat.isDirectory())
      throw new Error(`Unsafe MCP directory: ${path}`);
  }
}
