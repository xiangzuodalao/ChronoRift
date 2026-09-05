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

const watchStart = {
  schemaVersion: 1,
  executionId: "execution.test",
  action: "start",
  targets: [{ target: { path: "." }, names: ["value"] }],
  sampleCount: 2,
};
const watchState = {
  schemaVersion: 1,
  executionId: "execution.test",
  watchId: "execution.test.watch.1",
  phase: "physics_frame_signal_before_node_physics_process",
  status: "sampling",
  stopReason: null,
  sampleCount: 2,
  recordedCount: 0,
  boundTargets: [{ target: root, names: ["value"] }],
};
const watchRecord = (sequence: number) => ({
  sequence,
  sample: { processFrame: 8 + sequence, physicsTick: 4 + sequence },
  targets: [
    {
      target: root,
      values: [{ name: "value", status: "success", value: "值".repeat(100) }],
    },
  ],
});
const watchRead = {
  schemaVersion: 1,
  executionId: "execution.test",
  watchId: watchState.watchId,
  action: "read",
};
const watchStopped = {
  ...watchState,
  status: "stopped",
  stopReason: "sample_count",
  recordedCount: 2,
};
const watchPage = (records: ReturnType<typeof watchRecord>[]) => ({
  ...watchStopped,
  action: "read",
  records,
  nextSequence: records.at(-1)?.sequence ?? 0,
  bytesUsed: records.reduce(
    (total, record) => total + Buffer.byteLength(JSON.stringify(record)),
    0,
  ),
  requiredByteBudget: null,
  deliveryComplete: true,
});
const registerWatch = async (connection: ReturnType<typeof fixture>) => {
  const pending = connection.client.watch(watchStart);
  connection.send({
    kind: "watch_result",
    requestId: connection.writes.at(-1)?.requestId,
    payload: { ...watchState, action: "start" },
  });
  expect(await pending).toMatchObject({ action: "start", recordedCount: 0 });
};

describe("bounded watch wire delivery", () => {
  it("registers immediately, pages in order, and captures the complete final archive before termination", async () => {
    const connection = fixture();
    const { client, send, writes } = connection;
    try {
      await registerWatch(connection);
      expect(writes[0]).toMatchObject({
        kind: "watch",
        payload: { clock: "physics_tick" },
      });
      expect(client.capturedWatch).toMatchObject({
        records: [],
        deliveryComplete: false,
      });
      const reading = client.watch(watchRead);
      send({
        kind: "watch_result",
        requestId: writes.at(-1)?.requestId,
        payload: watchPage([watchRecord(1)]),
      });
      expect((await reading).action).toBe("read");
      send({
        kind: "watch_final",
        payload: {
          state: watchStopped,
          records: [watchRecord(1), watchRecord(2)],
          deliveryComplete: true,
        },
      });
      send({ kind: "terminated", payload: { import: null, run: null } });
      await client.termination;
      expect(client.capturedWatch).toEqual({
        state: watchStopped,
        records: [watchRecord(1), watchRecord(2)],
        deliveryComplete: true,
      });
      const snapshot = client.capturedWatch!;
      snapshot.records.length = 0;
      expect(client.capturedWatch?.records).toHaveLength(2);
    } finally {
      await client.close();
    }
  });

  it("retains only acquired pages on abnormal EOF and rejects pending reads on cleanup", async () => {
    const connection = fixture();
    const { client, send, writes, readable } = connection;
    await registerWatch(connection);
    const reading = client.watch({ ...watchRead, afterSequence: 1 });
    send({
      kind: "watch_result",
      requestId: writes.at(-1)?.requestId,
      payload: watchPage([watchRecord(2)]),
    });
    await reading;
    const pending = client.watch(watchRead);
    readable.end();
    await expect(pending).rejects.toThrow("ended");
    await expect(client.termination).rejects.toThrow("ended");
    expect(client.capturedWatch).toMatchObject({
      records: [watchRecord(2)],
      deliveryComplete: false,
    });
    await client.close();
    await client.close();
  });

  it("retains actual samples when explicit connection cancellation rejects a pending request", async () => {
    const connection = fixture();
    await registerWatch(connection);
    const pending = connection.client.watch(watchRead);
    await connection.client.close();
    await expect(pending).rejects.toThrow("closed");
    expect(connection.client.capturedWatch).toMatchObject({
      records: [],
      deliveryComplete: false,
    });
  });

  it("recovers a late delivered page after request timeout without inventing missing records", async () => {
    const connection = fixture();
    const { client, send, writes } = connection;
    try {
      await registerWatch(connection);
      const pending = client.watch(watchRead, 1);
      const requestId = writes.at(-1)?.requestId;
      await expect(pending).rejects.toThrow("timed out");
      send({
        kind: "watch_result",
        requestId,
        payload: watchPage([watchRecord(1)]),
      });
      expect(client.capturedWatch).toMatchObject({
        records: [watchRecord(1)],
        deliveryComplete: false,
      });
    } finally {
      await client.close();
    }
  });

  it.each([
    { label: "execution", fields: { executionId: "execution.other" } },
    { label: "watch", fields: { watchId: "execution.test.watch.2" } },
    { label: "action", fields: { action: "stop" } },
    { label: "incorrect byte count", fields: { bytesUsed: 1 } },
    { label: "incorrect cursor", fields: { nextSequence: 2 } },
    {
      label: "duplicate sequence",
      fields: { records: [watchRecord(1), watchRecord(1)] },
    },
  ])(
    "fails closed on mismatched $label and retains the last validated archive",
    async ({ fields }) => {
      const connection = fixture();
      const { client, send, writes } = connection;
      try {
        await registerWatch(connection);
        const pending = client.watch(watchRead);
        send({
          kind: "watch_result",
          requestId: writes.at(-1)?.requestId,
          payload: { ...watchPage([watchRecord(1)]), ...fields },
        });
        await expect(pending).rejects.toThrow();
        expect(client.capturedWatch).toMatchObject({
          records: [],
          deliveryComplete: false,
        });
      } finally {
        await client.close();
      }
    },
  );

  it("rejects a page exceeding the requested UTF-8 budget even inside the global limit", async () => {
    const connection = fixture();
    try {
      await registerWatch(connection);
      const pending = connection.client.watch({
        ...watchRead,
        byteBudget: 256,
      });
      connection.send({
        kind: "watch_result",
        requestId: connection.writes.at(-1)?.requestId,
        payload: watchPage([watchRecord(1)]),
      });
      await expect(pending).rejects.toThrow("budget");
    } finally {
      await connection.client.close();
    }
  });

  it("rejects cross-execution final records and historical rewrites", async () => {
    const connection = fixture();
    try {
      await registerWatch(connection);
      const pending = connection.client.watch(watchRead);
      connection.send({
        kind: "watch_result",
        requestId: connection.writes.at(-1)?.requestId,
        payload: watchPage([watchRecord(1)]),
      });
      await pending;
      connection.send({
        kind: "watch_final",
        payload: {
          state: { ...watchStopped, executionId: "execution.other" },
          records: [watchRecord(1), watchRecord(2)],
          deliveryComplete: true,
        },
      });
      await expect(connection.client.termination).rejects.toThrow("match");
      expect(connection.client.capturedWatch?.records).toEqual([
        watchRecord(1),
      ]);
    } finally {
      await connection.client.close();
    }
    const other = fixture();
    try {
      await registerWatch(other);
      const pending = other.client.watch(watchRead);
      other.send({
        kind: "watch_result",
        requestId: other.writes.at(-1)?.requestId,
        payload: watchPage([watchRecord(1)]),
      });
      await pending;
      const altered = {
        ...watchRecord(1),
        sample: { processFrame: 100, physicsTick: 100 },
      };
      const next = other.client.watch(watchRead);
      other.send({
        kind: "watch_result",
        requestId: other.writes.at(-1)?.requestId,
        payload: watchPage([altered]),
      });
      await expect(next).rejects.toThrow("already delivered");
      expect(other.client.capturedWatch?.records).toEqual([watchRecord(1)]);
    } finally {
      await other.client.close();
    }
  });

  it("allows idempotent watch stop without terminating the execution", async () => {
    const connection = fixture();
    try {
      await registerWatch(connection);
      for (let count = 0; count < 2; count++) {
        const pending = connection.client.watch({
          ...watchRead,
          action: "stop",
        });
        connection.send({
          kind: "watch_result",
          requestId: connection.writes.at(-1)?.requestId,
          payload: {
            ...watchState,
            action: "stop",
            status: "stopped",
            stopReason: "stopped",
          },
        });
        expect(await pending).toMatchObject({
          action: "stop",
          status: "stopped",
        });
      }
      expect(
        connection.writes.every((message) => message.kind === "watch"),
      ).toBe(true);
    } finally {
      await connection.client.close();
    }
  });
});

it("fails the connection and pending watch waiters immediately when transport writing fails", async () => {
  const readable = new PassThrough();
  let writes = 0;
  const client = new GodotInspectionWireClient({
    readable,
    write: () => {
      writes += 1;
      return Promise.reject(new Error("transport rejected write"));
    },
    close: async () => {
      readable.end();
    },
  });
  await expect(client.watch(watchStart)).rejects.toThrow(
    "transport rejected write",
  );
  await expect(client.termination).rejects.toThrow("transport rejected write");
  await expect(client.watch(watchStart)).rejects.toThrow(
    "transport rejected write",
  );
  expect(writes).toBe(1);
  expect(client.capturedWatch).toBeUndefined();
  await client.close();
});
