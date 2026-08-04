import { describe, expect, it } from "vitest";

import {
  GodotWireFrameError,
  MAX_WIRE_FRAME_BYTES,
  WireFrameDecoder,
  encodeWireFrame,
} from "./framing.js";
import {
  GodotWireProtocolError,
  makeGodotWireMessage,
  parseGodotWireMessage,
} from "./messages.js";

describe("Godot protocol v1", () => {
  it("round-trips a strictly hashed message", () => {
    const message = makeGodotWireMessage({
      sequence: 0,
      requestId: "request:configure",
      kind: "configure",
      payload: {
        probePlan: {
          schemaVersion: 1,
          signals: [{ source: "switch", name: "switch.activated" }],
          properties: ["door.open"],
        },
      },
    });
    expect(parseGodotWireMessage(JSON.stringify(message))).toEqual(message);
  });

  it("rejects payload tampering and unknown fields", () => {
    const message = makeGodotWireMessage({
      sequence: 0,
      requestId: "request:snapshot",
      kind: "snapshot",
      payload: {},
    });
    expect(() =>
      parseGodotWireMessage(
        JSON.stringify({ ...message, payload: { unexpected: true } }),
      ),
    ).toThrow();
    expect(() =>
      parseGodotWireMessage(JSON.stringify({ ...message, extra: true })),
    ).toThrow();
  });

  it("decodes fragmented and coalesced TCP frames", () => {
    const first = encodeWireFrame('{"first":true}');
    const second = encodeWireFrame('{"second":true}');
    const bytes = Buffer.concat([first, second]);
    const decoder = new WireFrameDecoder();
    expect(decoder.push(bytes.subarray(0, 3))).toEqual([]);
    expect(decoder.push(bytes.subarray(3, first.length + 2))).toEqual([
      '{"first":true}',
    ]);
    expect(decoder.push(bytes.subarray(first.length + 2))).toEqual([
      '{"second":true}',
    ]);
    expect(() => decoder.end()).not.toThrow();
  });

  it("rejects oversize, empty, and partial frames", () => {
    expect(() => encodeWireFrame("")).toThrow(GodotWireFrameError);
    expect(() => encodeWireFrame("x".repeat(MAX_WIRE_FRAME_BYTES + 1))).toThrow(
      GodotWireFrameError,
    );
    const decoder = new WireFrameDecoder();
    decoder.push(encodeWireFrame("partial").subarray(0, 5));
    expect(() => decoder.end()).toThrow(GodotWireFrameError);
    expect(() => parseGodotWireMessage("not json")).toThrow(
      GodotWireProtocolError,
    );
  });
});
