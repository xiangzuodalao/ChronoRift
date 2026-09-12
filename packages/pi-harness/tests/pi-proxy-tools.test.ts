import { describe, expect, it, vi } from "vitest";

import {
  createPiProxyToolDefinitions,
  type PiProxyToolDescriptor,
  type PiProxyToolInvoker,
  type PiProxyToolResult,
} from "../src/index.js";

const descriptor: PiProxyToolDescriptor = {
  name: "read",
  description: "Read from the worker candidate through the Host",
  parameters: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
  },
};

describe("Pi IPC tool proxies", () => {
  it("forwards calls, cancellation, and updates without executing project code", async () => {
    const controller = new AbortController();
    const update: PiProxyToolResult = {
      content: [{ type: "text", text: "reading" }],
    };
    const result: PiProxyToolResult = {
      content: [{ type: "text", text: "source bytes" }],
      details: { exitCode: 0 },
    };
    const invoke = vi.fn<PiProxyToolInvoker>(
      async (_request, signal, onUpdate) => {
        expect(signal).toBe(controller.signal);
        onUpdate?.(update);
        return result;
      },
    );
    const onUpdate = vi.fn();
    const [tool] = createPiProxyToolDefinitions([descriptor], invoke);
    const received = await tool!.execute(
      "call-1",
      { path: "main.gd" },
      controller.signal,
      onUpdate,
      {} as never,
    );
    expect(invoke.mock.calls[0]?.[0]).toEqual({
      toolCallId: "call-1",
      name: "read",
      arguments: { path: "main.gd" },
    });
    expect(onUpdate).toHaveBeenCalledWith({ ...update, details: undefined });
    expect(received).toEqual(result);
    controller.abort();
    await expect(
      tool!.execute(
        "call-2",
        { path: "main.gd" },
        controller.signal,
        undefined,
        {} as never,
      ),
    ).rejects.toThrow();
    expect(invoke).toHaveBeenCalledOnce();
  });

  it("preserves Host failures as Pi tool errors", async () => {
    const [tool] = createPiProxyToolDefinitions([descriptor], async () => ({
      content: [{ type: "text", text: "workspace path escaped" }],
      isError: true,
    }));
    await expect(
      tool!.execute(
        "call-1",
        { path: "../other" },
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toThrow("workspace path escaped");
    expect(() =>
      createPiProxyToolDefinitions([descriptor, descriptor], async () => ({
        content: [],
      })),
    ).toThrow("unique valid names");
    expect(() =>
      createPiProxyToolDefinitions(
        [{ ...descriptor, parameters: { type: "string" } }],
        async () => ({ content: [] }),
      ),
    ).toThrow("object parameter schema");
  });
});
