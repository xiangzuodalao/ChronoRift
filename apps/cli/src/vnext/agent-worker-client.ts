import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AGENT_IPC_MAX_PENDING,
  assertAgentIpcSize,
  parseAgentWorkerMessage,
  type AgentHostMessage,
  type AgentWorkerConfiguration,
  type AgentWorkerMessage,
} from "./agent-ipc.js";

export interface AgentWorkerClient {
  send(message: AgentHostMessage): Promise<void>;
  close(): Promise<void>;
}

export interface AgentWorkerClientOptions {
  readonly configuration: AgentWorkerConfiguration;
  readonly onMessage: (message: AgentWorkerMessage) => void;
  readonly onExit: (error: Error) => void;
}

export type AgentWorkerFactory = (
  options: AgentWorkerClientOptions,
) => Promise<AgentWorkerClient>;

const SHUTDOWN_GRACE_MS = 2_000;
const STARTUP_TIMEOUT_MS = 30_000;
const DIAGNOSTIC_MAX_BYTES = 64 * 1024;

/** Keep authentication in this trusted Pi process, but never inherit Node loaders. */
export function agentWorkerEnvironment(
  hostEnvironment: NodeJS.ProcessEnv,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(hostEnvironment).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
        !/^(NODE_OPTIONS|NODE_PATH|TSX_|TS_NODE_|BUN_)/u.test(entry[0]),
    ),
  );
}

/** Fixed trusted entry point. Project data cannot select argv, cwd, or a loader. */
export const createNodeAgentWorker: AgentWorkerFactory = async (options) => {
  const here = dirname(fileURLToPath(import.meta.url));
  const sourceMode = import.meta.url.endsWith(".ts");
  const entry = resolve(
    here,
    sourceMode ? "agent-worker.ts" : "agent-worker.js",
  );
  const args = sourceMode
    ? ["--import", createRequire(import.meta.url).resolve("tsx"), entry]
    : [entry];
  const child = spawn(process.execPath, args, {
    cwd: here,
    env: agentWorkerEnvironment(process.env),
    shell: false,
    detached: false,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    serialization: "json",
  });
  return await attachAgentWorkerClient(child, options);
};

/** Exported for real IPC fixture tests; production always uses the fixed entry. */
export async function attachAgentWorkerClient(
  child: ChildProcess,
  options: AgentWorkerClientOptions,
): Promise<AgentWorkerClient> {
  let diagnostic = "";
  let pendingSends = 0;
  let ready = false;
  let ended = false;
  let closing = false;
  let resolveReady: () => void;
  let rejectReady: (error: Error) => void;
  const startup = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  // A worker can fail while the initial IPC send is still pending.
  void startup.catch(() => undefined);
  let resolveExit: () => void;
  const exited = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });
  const fail = (error: Error): void => {
    if (ended) return;
    ended = true;
    clearTimeout(startupTimer);
    rejectReady(error);
    if (!closing) options.onExit(error);
    child.kill("SIGKILL");
  };
  const startupTimer = setTimeout(
    () => fail(new Error("Agent worker startup timed out")),
    STARTUP_TIMEOUT_MS,
  );
  const collect = (chunk: Buffer | string): void => {
    const next = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
    diagnostic = Buffer.from(diagnostic + next)
      .subarray(-DIAGNOSTIC_MAX_BYTES)
      .toString("utf8");
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  child.on("error", (error) => {
    if (child.pid === undefined) resolveExit();
    fail(error);
  });
  child.once("exit", (code, signal) => {
    resolveExit();
    fail(
      new Error(
        `Agent worker exited (code=${code}, signal=${signal})${diagnostic ? `: ${diagnostic}` : ""}`,
      ),
    );
  });
  child.once("disconnect", () =>
    fail(new Error("Agent worker IPC disconnected")),
  );
  child.on("message", (raw: unknown) => {
    if (ended) return;
    try {
      const message = parseAgentWorkerMessage(raw);
      if (message.type === "ready") {
        if (ready) throw new Error("Agent worker sent duplicate ready");
        ready = true;
        clearTimeout(startupTimer);
        resolveReady();
      } else {
        if (!ready && message.type !== "fatal")
          throw new Error("Agent worker sent a message before ready");
        if (message.type === "fatal") fail(new Error(message.error));
        else options.onMessage(message);
      }
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }
  });
  const send = async (message: AgentHostMessage): Promise<void> => {
    assertAgentIpcSize(message);
    if (ended || !child.connected)
      throw new Error("Agent worker IPC is unavailable");
    if (pendingSends >= AGENT_IPC_MAX_PENDING)
      throw new Error("Agent worker IPC send queue is full");
    pendingSends += 1;
    try {
      await new Promise<void>((resolve, reject) => {
        child.send(message, (error) =>
          error === null ? resolve() : reject(error),
        );
      });
    } finally {
      pendingSends -= 1;
    }
  };
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      closing = true;
      if (!ended)
        await send({ version: 1, type: "close" }).catch(() => undefined);
      const wait = async (): Promise<void> => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            exited,
            new Promise<void>((resolve) => {
              timer = setTimeout(resolve, SHUTDOWN_GRACE_MS);
            }),
          ]);
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
      };
      await wait();
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await exited;
      }
      ended = true;
      clearTimeout(startupTimer);
    })();
    return closePromise;
  };
  try {
    await send({
      version: 1,
      type: "initialize",
      configuration: options.configuration,
    });
    await startup;
    return { send, close };
  } catch (error) {
    await close();
    throw error;
  }
}
