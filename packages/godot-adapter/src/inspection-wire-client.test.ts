import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  GODOT_INSPECTION_PROTOCOL_V1,
  WireFrameDecoder,
  encodeWireFrame,
} from "@chronorift/godot-protocol";
import { GodotInspectionWireClient } from "./inspection-wire-client.js";

const fixture = () => {
  const readable = new PassThrough();
  const writes: Record<string, unknown>[] = [];
  const decoder = new WireFrameDecoder();
  const client = new GodotInspectionWireClient({
    readable,
    write: async (bytes) => {
      for (const text of decoder.push(bytes))
        writes.push(JSON.parse(text) as Record<string, unknown>);
    },
    close: async () => {
      readable.end();
    },
  });
  let sequence = 0;
  const send = (value: Record<string, unknown>) =>
    readable.write(
      encodeWireFrame(
        JSON.stringify({
          schemaVersion: 1,
          profile: GODOT_INSPECTION_PROTOCOL_V1,
          sequence: sequence++,
          ...value,
        }),
      ),
    );
  return { readable, writes, client, send };
};
const root = {
  objectRef: "execution.test.object.1",
  className: "Node2D",
  name: "World",
  path: ".",
  childCount: 0,
};

describe("generic Godot inspection wire client", () => {
  it("validates and correlates current-object queries, preserving request defaults", async () => {
    const { client, send, writes } = fixture();
    try {
      const ready = client.ready();
      send({
        kind: "ready",
        payload: {
          executionId: "execution.test",
          engineVersion: "4.7.1",
          scene: "res://main.tscn",
          root,
        },
      });
      expect((await ready).root).toEqual(root);
      const result = client.query({
        schemaVersion: 1,
        executionId: "execution.test",
        select: "children",
      });
      expect(writes[0]).toMatchObject({
        kind: "query",
        payload: { offset: 0, limit: 100, target: { path: "." } },
      });
      send({
        kind: "query_result",
        requestId: writes[0]?.requestId,
        payload: {
          schemaVersion: 1,
          executionId: "execution.test",
          select: "children",
          target: root,
          sample: { processFrame: 42, physicsTick: 41 },
          offset: 0,
          total: 0,
          items: [],
        },
      });
      expect(await result).toMatchObject({
        sample: { processFrame: 42, physicsTick: 41 },
      });
      const stopped = client.stop();
      send({ kind: "terminated", payload: { import: null, run: null } });
      expect(await stopped).toEqual({ import: null, run: null });
      await expect(
        client.query({
          schemaVersion: 1,
          executionId: "execution.test",
          select: "children",
        }),
      ).rejects.toThrow("exited");
    } finally {
      await client.close();
    }
  });

  it.each([
    { schemaVersion: 2, kind: "ready", payload: {} },
    { sequence: 4, kind: "terminated", payload: { import: null, run: null } },
    {
      kind: "terminated",
      payload: { import: null, run: null, verdict: "fixed" },
    },
  ])("fails closed on invalid envelopes %j", async (message) => {
    const { client, send } = fixture();
    try {
      send(message);
      await expect(client.termination).rejects.toThrow();
    } finally {
      await client.close();
    }
  });

  it("rejects partial frames on EOF", async () => {
    const { client, readable } = fixture();
    readable.end(Buffer.from([0, 0, 0, 100, 123]));
    await expect(client.termination).rejects.toThrow("partial frame");
    await client.close();
  });

  it("rejects malformed UTF-8 instead of silently replacing observation bytes", async () => {
    const { client, readable } = fixture();
    const bytes = encodeWireFrame(
      JSON.stringify({
        schemaVersion: 1,
        profile: GODOT_INSPECTION_PROTOCOL_V1,
        sequence: 0,
        kind: "error",
        payload: { code: "bad", message: "invalid" },
      }),
    );
    bytes[bytes.indexOf("invalid")] = 0xff;
    readable.write(bytes);
    await expect(client.termination).rejects.toThrow(/encoded|encoding/u);
    await client.close();
  });

  it("rejects unsafe property paths before issuing a request", async () => {
    const { client, writes } = fixture();
    await expect(
      client.query({
        schemaVersion: 1,
        executionId: "execution.test",
        target: { path: "../outside" },
        select: "values",
        names: ["shape"],
      }),
    ).rejects.toThrow();
    expect(writes).toHaveLength(0);
    await client.close();
  });

  it("rejects a correlated response from a different execution", async () => {
    const { client, send, writes } = fixture();
    try {
      const result = client.query({
        schemaVersion: 1,
        executionId: "execution.test",
        select: "children",
      });
      send({
        kind: "query_result",
        requestId: writes[0]?.requestId,
        payload: {
          schemaVersion: 1,
          executionId: "execution.other",
          select: "children",
          target: root,
          sample: { processFrame: 1, physicsTick: 0 },
          offset: 0,
          total: 0,
          items: [],
        },
      });
      await expect(result).rejects.toThrow("does not match");
    } finally {
      await client.close();
    }
  });

  it.each([
    {
      label: "a different object reference",
      input: {
        select: "children",
        target: { objectRef: "execution.test.object.2" },
      },
      output: { select: "children", offset: 0, total: 0, items: [] },
    },
    {
      label: "a different property",
      input: { select: "values", names: ["width"] },
      output: {
        select: "values",
        values: [{ name: "height", status: "success", value: 40 }],
      },
    },
    {
      label: "properties in another order",
      input: { select: "values", names: ["width", "height"] },
      output: {
        select: "values",
        values: [
          { name: "height", status: "success", value: 40 },
          { name: "width", status: "success", value: 80 },
        ],
      },
    },
    {
      label: "missing requested properties",
      input: { select: "values", names: ["width", "height"] },
      output: {
        select: "values",
        values: [{ name: "width", status: "success", value: 80 }],
      },
    },
    {
      label: "a different page offset",
      input: { select: "children", offset: 1 },
      output: { select: "children", offset: 0, total: 0, items: [] },
    },
    {
      label: "more items than the requested limit",
      input: { select: "properties", limit: 1 },
      output: {
        select: "properties",
        offset: 0,
        total: 2,
        items: [
          { name: "width", type: "float" },
          { name: "height", type: "float" },
        ],
      },
    },
  ])(
    "rejects a correlated response containing $label",
    async ({ input, output }) => {
      const { client, send, writes } = fixture();
      try {
        const result = client.query({
          schemaVersion: 1,
          executionId: "execution.test",
          ...input,
        });
        send({
          kind: "query_result",
          requestId: writes[0]?.requestId,
          payload: {
            schemaVersion: 1,
            executionId: "execution.test",
            target: root,
            sample: { processFrame: 1, physicsTick: 0 },
            ...output,
          },
        });
        await expect(result).rejects.toThrow(/match the request/u);
      } finally {
        await client.close();
      }
    },
  );
});
