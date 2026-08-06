import { describe, expect, it } from "vitest";

import { BoundedOutputCapture } from "./bounded-output.js";

describe("BoundedOutputCapture", () => {
  it("drains all bytes while retaining exactly the configured prefix", () => {
    const capture = new BoundedOutputCapture(4);
    capture.add(Buffer.from("abc"));
    capture.add(Buffer.from("def"));

    expect(Buffer.from(capture.bytes()).toString("utf8")).toBe("abcd");
    expect(capture.receipt()).toMatchObject({
      totalBytes: 6,
      capturedBytes: 4,
      truncated: true,
    });
  });

  it("hashes discarded bytes without retaining the tail", () => {
    const capture = new BoundedOutputCapture(16 * 1024 * 1024);
    const chunk = Buffer.alloc(1024 * 1024, 0x61);
    for (let index = 0; index < 100; index += 1) capture.add(chunk);

    expect(capture.bytes()).toHaveLength(16 * 1024 * 1024);
    expect(capture.receipt()).toMatchObject({
      totalBytes: 100 * 1024 * 1024,
      capturedBytes: 16 * 1024 * 1024,
      truncated: true,
    });
  });

  it("rejects invalid limits", () => {
    expect(() => new BoundedOutputCapture(-1)).toThrow(RangeError);
    expect(() => new BoundedOutputCapture(1.5)).toThrow(RangeError);
  });
});
