import {
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export type RootToolDefinition = ToolDefinition;

export interface PiProxyToolDescriptor {
  readonly name: string;
  readonly label?: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  readonly promptSnippet?: string;
  readonly promptGuidelines?: readonly string[];
}

export interface PiProxyToolResult {
  readonly content: readonly (
    | { readonly type: "text"; readonly text: string }
    | {
        readonly type: "image";
        readonly data: string;
        readonly mimeType: string;
      }
  )[];
  readonly details?: unknown;
  readonly isError?: boolean;
}

export interface PiProxyToolRequest {
  readonly toolCallId: string;
  readonly name: string;
  readonly arguments: unknown;
}

export type PiProxyToolInvoker = (
  request: PiProxyToolRequest,
  signal?: AbortSignal,
  onUpdate?: (result: PiProxyToolResult) => void,
) => Promise<PiProxyToolResult>;

/** Descriptors contain schemas and prompt metadata, never executable tools. */
export function describePiTools(
  tools: readonly ToolDefinition[],
): PiProxyToolDescriptor[] {
  return tools.map((tool) => ({
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: JSON.parse(JSON.stringify(tool.parameters)) as Record<
      string,
      unknown
    >,
    ...(tool.promptSnippet === undefined
      ? {}
      : { promptSnippet: tool.promptSnippet }),
    ...(tool.promptGuidelines === undefined
      ? {}
      : { promptGuidelines: [...tool.promptGuidelines] }),
  }));
}

export function createPiProxyToolDefinitions(
  descriptors: readonly PiProxyToolDescriptor[],
  invoke: PiProxyToolInvoker,
): ToolDefinition[] {
  const names = new Set<string>();
  return descriptors.map((descriptor) => {
    if (
      !/^[a-zA-Z][a-zA-Z0-9_]{0,127}$/u.test(descriptor.name) ||
      names.has(descriptor.name)
    ) {
      throw new TypeError("Proxy tools must have unique valid names");
    }
    names.add(descriptor.name);
    if (
      typeof descriptor.description !== "string" ||
      descriptor.description.length > 65_536 ||
      descriptor.parameters === null ||
      typeof descriptor.parameters !== "object" ||
      Array.isArray(descriptor.parameters) ||
      descriptor.parameters.type !== "object"
    ) {
      throw new TypeError("Proxy tools require an object parameter schema");
    }
    return defineTool({
      name: descriptor.name,
      label: descriptor.label ?? descriptor.name,
      description: descriptor.description,
      parameters: Type.Unsafe<Record<string, unknown>>(descriptor.parameters),
      ...(descriptor.promptSnippet === undefined
        ? {}
        : { promptSnippet: descriptor.promptSnippet }),
      ...(descriptor.promptGuidelines === undefined
        ? {}
        : { promptGuidelines: [...descriptor.promptGuidelines] }),
      execute: async (toolCallId, args, signal, onUpdate) => {
        signal?.throwIfAborted();
        const result = await invoke(
          { toolCallId, name: descriptor.name, arguments: args },
          signal,
          onUpdate === undefined
            ? undefined
            : (update) =>
                onUpdate({
                  content: [...update.content],
                  details: update.details,
                }),
        );
        if (result.isError === true) {
          throw new Error(
            result.content
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("\n") || "Host tool execution failed",
          );
        }
        return { content: [...result.content], details: result.details };
      },
    });
  });
}
