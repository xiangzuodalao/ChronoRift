import { resolve } from "node:path";
import {
  InMemoryCredentialStore,
  validateToolArguments,
} from "@earendil-works/pi-ai";
import {
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentToolResult,
  type AgentToolUpdateCallback,
  type ToolInfo,
} from "@earendil-works/pi-coding-agent";
import type { ManagedMcpEnvironment } from "./mcp-extension.js";
import { createManagedSessionBootstrap } from "./managed-session-bootstrap.js";

export interface ManagedMcpProbeOptions {
  readonly resourceWorkspaceDirectory: string;
  readonly mcpEnvironment: ManagedMcpEnvironment;
  readonly signal?: AbortSignal;
}

export interface ManagedMcpProbeRequest {
  readonly id: string;
  /** A registered Pi tool name, e.g. godot-ai_editor_manage or mcp. */
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly signal?: AbortSignal;
  readonly onUpdate?: AgentToolUpdateCallback<unknown>;
}

export type ManagedMcpProbeResult = AgentToolResult<unknown> & {
  readonly isError: boolean;
};

export interface ManagedMcpProbe {
  tools(): readonly ToolInfo[];
  execute(request: ManagedMcpProbeRequest): Promise<ManagedMcpProbeResult>;
  /** Abort pending calls, disconnect the adapter, and release the Pi Session. */
  close(): Promise<void>;
}

/**
 * Host-only execution through the same registered adapter tools as live Pi.
 * No prompt, model credentials, provider request, or investigation strategy.
 * The caller owns preparing/closing the sandboxed MCP environment.
 */
export async function createManagedMcpProbe(
  options: ManagedMcpProbeOptions,
): Promise<ManagedMcpProbe> {
  options.signal?.throwIfAborted();
  const cwd = resolve(options.resourceWorkspaceDirectory);
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  const { session, shutdownExtensions } = await createManagedSessionBootstrap({
    sdk: {
      cwd,
      agentDir: options.mcpEnvironment.agentDirectory,
      modelRuntime,
      thinkingLevel: "off",
      sessionManager: SessionManager.inMemory(cwd),
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: false },
      }),
      customTools: [],
    },
    toolNames: [],
    mcpEnvironment: options.mcpEnvironment,
    appendSystemPrompt: [],
  });
  const lifetime = new AbortController();
  const abortLifetime = () => lifetime.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", abortLifetime, { once: true });
  if (options.signal?.aborted) abortLifetime();
  let closed = false;
  let tail: Promise<unknown> = Promise.resolve();
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closePromise !== undefined) return closePromise;
    closed = true;
    lifetime.abort(new Error("Managed MCP probe closed"));
    closePromise = (async () => {
      await tail.catch(() => undefined);
      try {
        await shutdownExtensions();
      } finally {
        options.signal?.removeEventListener("abort", abortLifetime);
        session.dispose();
      }
    })();
    return closePromise;
  };
  if (lifetime.signal.aborted) {
    await close();
    lifetime.signal.throwIfAborted();
  }
  return {
    tools: () => {
      if (closed) throw new Error("Managed MCP probe is closed");
      const active = new Set(session.getActiveToolNames());
      return session.getAllTools().filter((tool) => active.has(tool.name));
    },
    execute: (request) => {
      if (closed)
        return Promise.reject(new Error("Managed MCP probe is closed"));
      const signal =
        request.signal === undefined
          ? lifetime.signal
          : AbortSignal.any([lifetime.signal, request.signal]);
      const run = tail.then(async (): Promise<ManagedMcpProbeResult> => {
        let args: Record<string, unknown> = request.args;
        let result: AgentToolResult<unknown>;
        let isError = false;
        try {
          signal.throwIfAborted();
          if (!session.isIdle)
            throw new Error("Managed MCP probe Session is not idle");
          if (!request.id.trim())
            throw new Error("Tool call id must not be empty");
          const tool = session.state.tools.find(
            (candidate) => candidate.name === request.name,
          );
          if (tool === undefined)
            throw new Error(`Tool ${request.name} not found`);
          const prepared =
            tool.prepareArguments === undefined
              ? request.args
              : tool.prepareArguments(request.args);
          const validated: unknown = validateToolArguments(tool, {
            type: "toolCall",
            id: request.id,
            name: request.name,
            // The SDK validator owns checking/coercing this raw prepared value.
            arguments: prepared as Record<string, unknown>,
          });
          if (
            validated === null ||
            typeof validated !== "object" ||
            Array.isArray(validated)
          ) {
            throw new Error("MCP tool arguments must be an object");
          }
          args = validated as Record<string, unknown>;
          const blocked = await session.extensionRunner.emitToolCall({
            type: "tool_call",
            toolName: request.name,
            toolCallId: request.id,
            input: args,
          });
          if (blocked?.block)
            throw new Error(blocked.reason || "Tool execution was blocked");
          signal.throwIfAborted();
          result = await tool.execute(
            request.id,
            args,
            signal,
            request.onUpdate,
          );
          signal.throwIfAborted();
        } catch (error) {
          isError = true;
          result = {
            content: [
              {
                type: "text",
                text: error instanceof Error ? error.message : String(error),
              },
            ],
            details: { chronorift: { cancelled: signal.aborted } },
          };
        }
        // Adapter execution errors are returned in details, and are marked by
        // its real tool_result hook. Do not infer success from a resolved call.
        const override = await session.extensionRunner.emitToolResult({
          type: "tool_result",
          toolName: request.name,
          toolCallId: request.id,
          input: args,
          content: result.content,
          details: result.details,
          isError,
        });
        return {
          ...result,
          ...(override?.content === undefined
            ? {}
            : { content: override.content }),
          ...(override?.details === undefined
            ? {}
            : { details: override.details }),
          ...(override?.usage === undefined ? {} : { usage: override.usage }),
          isError: override?.isError ?? isError,
        };
      });
      tail = run.catch(() => undefined);
      return run;
    },
    close,
  };
}
