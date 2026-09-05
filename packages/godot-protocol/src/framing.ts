import { TextDecoder } from "node:util";

export const MAX_WIRE_FRAME_BYTES = 1024 * 1024;

export class GodotWireFrameError extends Error {
  public override readonly name = "GodotWireFrameError";
}

export const encodeWireFrame = (json: string): Buffer => {
  const body = Buffer.from(json, "utf8");
  if (body.byteLength === 0 || body.byteLength > MAX_WIRE_FRAME_BYTES) {
    throw new GodotWireFrameError(
      `Wire frame must contain 1..${MAX_WIRE_FRAME_BYTES} bytes`,
    );
  }
  const frame = Buffer.allocUnsafe(4 + body.byteLength);
  frame.writeUInt32BE(body.byteLength, 0);
  body.copy(frame, 4);
  return frame;
};

export class WireFrameDecoder {
  private buffer = Buffer.alloc(0);
  private readonly utf8: TextDecoder | undefined;

  public constructor(options: { readonly fatalUtf8?: boolean } = {}) {
    this.utf8 =
      options.fatalUtf8 === true
        ? new TextDecoder("utf-8", { fatal: true })
        : undefined;
  }

  public push(chunk: Uint8Array): readonly string[] {
    if (chunk.byteLength === 0) return [];
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
    const frames: string[] = [];
    while (this.buffer.byteLength >= 4) {
      const length = this.buffer.readUInt32BE(0);
      if (length === 0 || length > MAX_WIRE_FRAME_BYTES) {
        throw new GodotWireFrameError(
          `Invalid Godot wire frame length: ${length}`,
        );
      }
      if (this.buffer.byteLength < length + 4) break;
      const body = this.buffer.subarray(4, 4 + length);
      frames.push(
        this.utf8 === undefined
          ? body.toString("utf8")
          : this.utf8.decode(body),
      );
      this.buffer = this.buffer.subarray(4 + length);
    }
    return frames;
  }

  public end(): void {
    if (this.buffer.byteLength !== 0) {
      throw new GodotWireFrameError("Connection ended with a partial frame");
    }
  }
}
