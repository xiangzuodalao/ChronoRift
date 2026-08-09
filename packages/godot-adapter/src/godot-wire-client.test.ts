import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import {
  encodeWireFrame,
  makeGodotWireMessage,
} from "@chronorift/godot-protocol";

import {
  GodotWireClient,
  type GodotByteTransport,
} from "./godot-wire-client.js";

const transportHarness = (
  options: { readonly writeFailure?: Error } = {},
): {
  readonly readable: PassThrough;
  readonly writes: Uint8Array[];
  readonly transport: GodotByteTransport;
  readonly closeCount: number;
} => {
  const readable = new PassThrough();
  const writes: Uint8Array[] = [];
  let closeCount = 0;
  return {
    readable,
    writes,
    get closeCount() {
      return closeCount;
    },
    transport: {
      readable,
      write: async (bytes) => {
        writes.push(Uint8Array.from(bytes));
        if (options.writeFailure !== undefined) {
          throw options.writeFailure;
        }
      },
      close: async () => {
        closeCount += 1;
        readable.end();
      },
    },
  };
};

const frame = (input: {
  readonly sequence: number;
  readonly protocolVersion?: 1 | 2;
  readonly requestId?: string;
}) =>
  encodeWireFrame(
    JSON.stringify(
      makeGodotWireMessage({
        sequence: input.sequence,
        protocolVersion: input.protocolVersion ?? 2,
        kind: "configured",
        requestId: input.requestId ?? `request:${input.sequence}`,
        payload: { accepted: true },
      }),
    ),
  );

describe("GodotWireClient", () => {
  it("decodes fragmented frames, validates sequence and writes framed requests", async () => {
    const harness = transportHarness();
    const client = new GodotWireClient(harness.transport, 2);
    const waiting = client.waitFor((message) => message.kind === "configured");
    const bytes = frame({ sequence: 0 });
    harness.readable.write(bytes.subarray(0, 3));
    harness.readable.write(bytes.subarray(3));
    await expect(waiting).resolves.toMatchObject({
      kind: "configured",
      sequence: 0,
      protocolVersion: 2,
    });
    await client.send("snapshot", {}, "request:test");
    expect(harness.writes).toHaveLength(1);
    await client.close();
  });

  it("handles the response waiter rejection when a request write fails", async () => {
    const writeFailure = new Error("transport write rejected");
    const harness = transportHarness({ writeFailure });
    const client = new GodotWireClient(harness.transport, 2);
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown): void => {
      unhandledRejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandledRejection);

    try {
      await expect(
        client.request("snapshot", {}, "snapshot_result"),
      ).rejects.toBe(writeFailure);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandledRejections).toEqual([]);
      expect(harness.closeCount).toBe(1);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
  });

  it("fails closed on a protocol-version mismatch", async () => {
    const harness = transportHarness();
    const client = new GodotWireClient(harness.transport, 2);
    const waiting = client.waitFor(() => true);
    harness.readable.write(frame({ sequence: 0, protocolVersion: 1 }));
    await expect(waiting).rejects.toThrow("Expected protocol 2");
    await expect(client.send("snapshot", {})).rejects.toThrow(
      "Expected protocol 2",
    );
    expect(harness.closeCount).toBe(1);
  });

  it("bounds unsolicited valid messages instead of retaining an unbounded queue", async () => {
    const harness = transportHarness();
    const client = new GodotWireClient(harness.transport, 2, {
      maxUnsolicitedMessages: 1,
    });
    harness.readable.write(frame({ sequence: 0 }));
    harness.readable.write(frame({ sequence: 1 }));
    await expect(client.send("snapshot", {})).rejects.toThrow(
      "bounded unsolicited-message queue",
    );
    expect(harness.closeCount).toBe(1);
  });

  it("bounds unsolicited encoded bytes and actively closes the transport", async () => {
    const harness = transportHarness();
    const oversized = frame({ sequence: 0 });
    const client = new GodotWireClient(harness.transport, 2, {
      maxUnsolicitedMessages: 8,
      maxUnsolicitedBytes: oversized.byteLength - 1,
    });
    harness.readable.write(oversized);
    await expect(client.send("snapshot", {})).rejects.toThrow(
      "queue count or byte limit",
    );
    expect(harness.closeCount).toBe(1);
  });
});
