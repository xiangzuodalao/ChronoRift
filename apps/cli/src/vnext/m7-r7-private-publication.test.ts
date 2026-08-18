import { randomUUID } from "node:crypto";
import { chmod, link, mkdir, open, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  publishM7R7PrivateFileOnceV1,
  repairM7R7PrivatePublicationsV1,
} from "./m7-r7-private-publication.js";

const fixture = async () => {
  const root = join("/tmp", `m7-r7-publication-${randomUUID()}`);
  await mkdir(root, { mode: 0o700 });
  await chmod(root, 0o700);
  return root;
};

describe("M7 R7 private no-replace publication", () => {
  it("never exposes a final file when a write makes no progress", async () => {
    const root = await fixture();
    try {
      await expect(
        publishM7R7PrivateFileOnceV1(
          { root, filename: "record.json", bytes: Buffer.from("complete") },
          { write: async () => 0 },
        ),
      ).rejects.toThrow("made no progress");
      await expect(readFile(join(root, "record.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("publishes exact bytes once and rejects replacement", async () => {
    const root = await fixture();
    try {
      const bytes = Buffer.from("complete");
      await publishM7R7PrivateFileOnceV1({
        root,
        filename: "record.json",
        bytes,
      });
      await expect(
        publishM7R7PrivateFileOnceV1({
          root,
          filename: "record.json",
          bytes: Buffer.from("replacement"),
        }),
      ).rejects.toMatchObject({ code: "EEXIST" });
      expect(await readFile(join(root, "record.json"))).toEqual(bytes);
      expect((await stat(join(root, "record.json"))).nlink).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("repairs only a complete published hard-link after a stopped writer", async () => {
    const root = await fixture();
    try {
      const finalPath = join(root, "record.json");
      const temporaryPath = join(
        root,
        ".record.json.tmp-0123456789abcdef0123456789abcdef",
      );
      const handle = await open(temporaryPath, "wx", 0o600);
      await handle.writeFile("complete");
      await handle.sync();
      await handle.close();
      await link(temporaryPath, finalPath);
      const repair = await repairM7R7PrivatePublicationsV1({
        root,
        validatePublishedBytes: (_filename, bytes) => {
          expect(Buffer.from(bytes).toString("utf8")).toBe("complete");
        },
      });
      expect(repair.repairedPublishedLinkCount).toBe(1);
      expect((await stat(finalPath)).nlink).toBe(1);
      expect(await readFile(finalPath, "utf8")).toBe("complete");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
