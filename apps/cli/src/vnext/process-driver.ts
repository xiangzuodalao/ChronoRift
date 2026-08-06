import {
  spawn,
  type ChildProcess,
  type Serializable,
  type StdioOptions,
} from "node:child_process";
import type { Readable } from "node:stream";

export interface ProcessStartRequest {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly detached: boolean;
  readonly stdio: readonly ("ignore" | "pipe" | "ipc" | number)[];
}

export interface ProcessExit {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface SpawnedProcess {
  readonly pid: number;
  readonly stdout: NodeJS.ReadableStream;
  readonly stderr: NodeJS.ReadableStream;
  wait(): Promise<ProcessExit>;
  signal(signal: NodeJS.Signals): void;
}

export interface SpawnedIpcProcess extends SpawnedProcess {
  send(message: Serializable): Promise<void>;
  onMessage(listener: (message: unknown) => void): () => void;
}

export interface ProcessDriver {
  start(request: ProcessStartRequest): SpawnedProcess;
  startIpc(request: ProcessStartRequest): SpawnedIpcProcess;
}

interface WrappedProcess extends SpawnedProcess {
  readonly child: ChildProcess;
}

const requireReadable = (
  stream: Readable | null,
  name: "stdout" | "stderr",
): Readable => {
  if (stream === null) {
    throw new TypeError(`${name} must use pipe stdio`);
  }
  return stream;
};

const wrapProcess = (child: ChildProcess): WrappedProcess => {
  if (child.pid === undefined) {
    child.kill("SIGKILL");
    throw new Error("spawn returned no process id");
  }
  const stdout = requireReadable(child.stdout, "stdout");
  const stderr = requireReadable(child.stderr, "stderr");
  const exit = new Promise<ProcessExit>((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (exitCode, signal) => {
      resolveExit({ exitCode, signal });
    });
  });

  return {
    child,
    pid: child.pid,
    stdout,
    stderr,
    wait: () => exit,
    signal: (signal) => {
      child.kill(signal);
    },
  };
};

const spawnRequest = (request: ProcessStartRequest): ChildProcess =>
  spawn(request.executable, [...request.args], {
    cwd: request.cwd,
    detached: request.detached,
    env: { ...request.env },
    shell: false,
    stdio: [...request.stdio] as StdioOptions,
  });

export class NodeProcessDriver implements ProcessDriver {
  public start(request: ProcessStartRequest): SpawnedProcess {
    if (request.stdio.includes("ipc")) {
      throw new TypeError("start does not accept an ipc descriptor");
    }
    return wrapProcess(spawnRequest(request));
  }

  public startIpc(request: ProcessStartRequest): SpawnedIpcProcess {
    const ipcCount = request.stdio.filter((entry) => entry === "ipc").length;
    if (ipcCount !== 1) {
      throw new TypeError("startIpc requires exactly one ipc descriptor");
    }

    const wrapped = wrapProcess(spawnRequest(request));
    const child = wrapped.child;
    const queuedMessages: unknown[] = [];
    const messageListeners = new Set<(message: unknown) => void>();
    child.on("message", (message: unknown) => {
      if (messageListeners.size === 0) {
        queuedMessages.push(message);
        return;
      }
      for (const listener of messageListeners) listener(message);
    });
    return {
      ...wrapped,
      send: (message) =>
        new Promise<void>((resolveSend, rejectSend) => {
          if (!child.connected) {
            rejectSend(new Error("IPC channel is not connected"));
            return;
          }
          child.send(message, (error) => {
            if (error === null) resolveSend();
            else rejectSend(error);
          });
        }),
      onMessage: (listener) => {
        messageListeners.add(listener);
        for (const message of queuedMessages.splice(0)) listener(message);
        return () => messageListeners.delete(listener);
      },
    };
  }
}
