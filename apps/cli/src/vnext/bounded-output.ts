import { createHash, type Hash } from "node:crypto";

import {
  StreamCaptureReceiptV1Schema,
  type StreamCaptureReceiptV1,
} from "./contracts.js";

export class BoundedOutputCapture {
  readonly #hash: Hash = createHash("sha256");
  readonly #capturedHash: Hash = createHash("sha256");
  readonly #chunks: Buffer[] = [];
  #totalBytes = 0;
  #capturedBytes = 0;

  public constructor(readonly limitBytes: number) {
    if (!Number.isInteger(limitBytes) || limitBytes < 0) {
      throw new RangeError("limitBytes must be a nonnegative integer");
    }
  }

  public add(chunk: Uint8Array): void {
    const bytes = Buffer.from(chunk);
    this.#hash.update(bytes);
    this.#totalBytes += bytes.byteLength;

    const remaining = this.limitBytes - this.#capturedBytes;
    if (remaining <= 0) return;

    const kept = bytes.subarray(0, remaining);
    this.#capturedHash.update(kept);
    this.#chunks.push(kept);
    this.#capturedBytes += kept.byteLength;
  }

  public bytes(): Uint8Array {
    return Buffer.concat(this.#chunks, this.#capturedBytes);
  }

  public receipt(): StreamCaptureReceiptV1 {
    return StreamCaptureReceiptV1Schema.parse({
      totalBytes: this.#totalBytes,
      capturedBytes: this.#capturedBytes,
      sha256: this.#hash.copy().digest("hex"),
      capturedSha256: this.#capturedHash.copy().digest("hex"),
      truncated: this.#capturedBytes !== this.#totalBytes,
    });
  }
}
