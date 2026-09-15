import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createManagedPiSessionWithSdk,
  createPiProxyToolDefinitions,
  type ManagedPiSession,
  type PiProxyToolResult,
} from "@chronorift/pi-harness";

import {
  AGENT_IPC_MAX_PENDING,
  agentToolError,
  assertAgentIpcSize,
  parseAgentHostMessage,
  type AgentHostMessage,
  type AgentWorkerConfiguration,
  type AgentWorkerMessage,
} from "./agent-ipc.js";

export interface AgentWorkerChannel {
  send(message: AgentWorkerMessage): Promise<void>;
  onMessage(listener: (message: unknown) => void): void;
  onDisconnect(listener: () => void): void;
  disconnect(): void;
}

type WorkerSessionFactory = typeof createManagedPiSessionWithSdk;

/** The worker owns Pi only. Every project operation crosses the Host tool broker. */
export function runAgentWorkerBridge(
  channel: AgentWorkerChannel,
  createSession: WorkerSessionFactory = createManagedPiSessionWithSdk,
): void {
  let initializing = false;
  let closing = false;
  let session: ManagedPiSession | undefined;
  let currentTurn: number | undefined;
  let interrupted = false;
  const subscriptions: (() => void)[] = [];
  const pending = new Map<
    string,
    {
      turnId: number;
      resolve: (result: PiProxyToolResult) => void;
      update: ((result: PiProxyToolResult) => void) | undefined;
      dispose: () => void;
    }
  >();
  const send = async (message: AgentWorkerMessage): Promise<void> => {
    assertAgentIpcSize(message);
    await channel.send(message);
  };
  const cancelPending = (): void => {
    for (const [requestId, request] of pending) {
      request.dispose();
      request.resolve(agentToolError("Agent turn was cancelled"));
      pending.delete(requestId);
    }
  };
  const close = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    for (const unsubscribe of subscriptions.splice(0)) unsubscribe();
    cancelPending();
    await session?.abort().catch(() => undefined);
    session?.dispose();
    channel.disconnect();
  };
  const fatal = async (error: unknown): Promise<void> => {
    await send({
      version: 2,
      type: "fatal",
      error: String(error instanceof Error ? error.message : error).slice(
        0,
        65_536,
      ),
    }).catch(() => undefined);
    await close();
  };
  const initialize = async (
    configuration: AgentWorkerConfiguration,
  ): Promise<void> => {
    if (initializing) throw new Error("Worker was already initialized");
    initializing = true;
    const tools = createPiProxyToolDefinitions(
      configuration.tools,
      async (request, signal, onUpdate) => {
        const turnId = currentTurn;
        if (turnId === undefined || closing || interrupted || signal?.aborted)
          return agentToolError("No active worker turn");
        if (pending.size >= AGENT_IPC_MAX_PENDING)
          return agentToolError("Too many outstanding worker tools");
        const requestId = randomUUID();
        return await new Promise<PiProxyToolResult>((resolveResult) => {
          const abort = (): void => {
            const entry = pending.get(requestId);
            if (entry === undefined) return;
            pending.delete(requestId);
            entry.dispose();
            entry.resolve(agentToolError("Worker tool was cancelled"));
            void send({
              version: 2,
              type: "tool_cancel",
              turnId,
              requestId,
            }).catch(fatal);
          };
          signal?.addEventListener("abort", abort, { once: true });
          pending.set(requestId, {
            turnId,
            resolve: resolveResult,
            update: onUpdate,
            dispose: () => signal?.removeEventListener("abort", abort),
          });
          void send({
            version: 2,
            type: "tool_request",
            turnId,
            requestId,
            name: request.name,
            arguments: request.arguments,
          }).catch((error: unknown) => {
            const entry = pending.get(requestId);
            pending.delete(requestId);
            entry?.dispose();
            resolveResult(agentToolError(String(error)));
            void fatal(error);
          });
        });
      },
    );
    session = await createSession({ ...configuration, tools });
    if (closing) {
      session.dispose();
      return;
    }
    subscriptions.push(
      session.subscribeConsumption((ids) => {
        if (!closing)
          void send({ version: 2, type: "collaboration_consumed", ids }).catch(
            fatal,
          );
      }),
      session.subscribeCollaborationPhase((phase) => {
        if (!closing)
          void send({ version: 2, type: "phase", phase }).catch(fatal);
      }),
    );
    await send({ version: 2, type: "ready" });
  };
  const prompt = async (
    message: Extract<AgentHostMessage, { type: "prompt" }>,
  ): Promise<void> => {
    if (session === undefined || currentTurn !== undefined)
      throw new Error("Worker cannot start overlapping turns");
    currentTurn = message.turnId;
    interrupted = false;
    try {
      await session.prompt(message.text);
      await session.waitForIdle();
      const result = session.snapshot(interrupted ? "aborted" : undefined);
      currentTurn = undefined;
      if (!closing)
        await send({
          version: 2,
          type: "completed",
          turnId: message.turnId,
          result,
        });
    } catch (error) {
      currentTurn = undefined;
      if (!closing)
        await send({
          version: 2,
          type: "failed",
          turnId: message.turnId,
          error: String(error instanceof Error ? error.message : error).slice(
            0,
            65_536,
          ),
        });
    } finally {
      cancelPending();
    }
  };
  const handle = async (raw: unknown): Promise<void> => {
    const message = parseAgentHostMessage(raw);
    if (message.type === "close") {
      await close();
      return;
    }
    if (closing) return;
    if (message.type === "initialize") {
      await initialize(message.configuration);
      return;
    }
    if (session === undefined)
      throw new Error("Worker received a command before initialization");
    switch (message.type) {
      case "prompt":
        await prompt(message);
        break;
      case "collaboration": {
        const disposition = await session.deliverCollaboration(
          message.envelope,
        );
        await send({
          version: 2,
          type: "collaboration_accepted",
          requestId: message.requestId,
          acceptedInCurrentTurn: disposition === "current-turn",
        });
        break;
      }
      case "export_context":
        await send({
          version: 2,
          type: "context_exported",
          requestId: message.requestId,
          context: session.exportForkContext(message.forkTurns),
        });
        break;
      case "interrupt":
        if (message.turnId === currentTurn) {
          interrupted = true;
          cancelPending();
          await session.abort();
        }
        break;
      case "tool_result":
      case "tool_update": {
        const entry = pending.get(message.requestId);
        if (
          entry === undefined ||
          entry.turnId !== message.turnId ||
          message.turnId !== currentTurn
        )
          return;
        if (message.type === "tool_update") entry.update?.(message.result);
        else {
          pending.delete(message.requestId);
          entry.dispose();
          entry.resolve(message.result);
        }
        break;
      }
    }
  };
  // Do not serialize this handler behind prompt(): abort and RPC replies must
  // remain deliverable while the model is waiting or a tool is running.
  channel.onMessage((raw) => {
    void handle(raw).catch(fatal);
  });
  channel.onDisconnect(() => {
    void close();
  });
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (process.send === undefined)
    throw new Error("Agent worker requires a Host IPC channel");
  runAgentWorkerBridge({
    send: async (message) => {
      await new Promise<void>((resolveSend, rejectSend) => {
        if (!process.connected || process.send === undefined) {
          rejectSend(new Error("Host IPC disconnected"));
          return;
        }
        process.send(message, (error: Error | null) =>
          error === null ? resolveSend() : rejectSend(error),
        );
      });
    },
    onMessage: (listener) => {
      process.on("message", listener);
    },
    onDisconnect: (listener) => {
      process.once("disconnect", listener);
    },
    disconnect: () => {
      if (process.connected) process.disconnect();
    },
  });
}
