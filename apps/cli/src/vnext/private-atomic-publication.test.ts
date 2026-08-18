import { randomUUID } from "node:crypto";
import { chmod, link, mkdir, open, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  publishPrivateFileOnceV1,
  repairPrivatePublicationsV1,
} from "./private-atomic-publication.js";

const fixture = async () => {
  const root = join("/tmp", `private-publication-${randomUUID()}`);
  await mkdir(root, { mode: 0o700 });
  await chmod(root, 0o700);
  return root;
};

describe("private atomic no-replace publication", () => {
  it("never exposes a final file when a write makes no progress", async () => {
    const root = await fixture();
    try {
      await expect(
        publishPrivateFileOnceV1(
          { root, filename: "record.json", bytes: Buffer.from("complete") },
          { write: async () => 0 },
        ),
      ).rejects.toThrow("invalid progress");
      await expect(readFile(join(root, "record.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("has one atomic winner and never replaces its bytes", async () => {
    const root = await fixture();
    try {
      const outcomes = await Promise.allSettled([
        publishPrivateFileOnceV1({
          root,
          filename: "record.json",
          bytes: Buffer.from("first"),
        }),
        publishPrivateFileOnceV1({
          root,
          filename: "record.json",
          bytes: Buffer.from("second"),
        }),
      ]);
      expect(
        outcomes.filter(({ status }) => status === "fulfilled"),
      ).toHaveLength(1);
      expect(
        outcomes.filter(({ status }) => status === "rejected"),
      ).toHaveLength(1);
      expect(["first", "second"]).toContain(
        await readFile(join(root, "record.json"), "utf8"),
      );
      expect((await stat(join(root, "record.json"))).nlink).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("removes a complete unpublished temporary after the writer stops", async () => {
    const root = await fixture();
    try {
      const temporaryPath = join(
        root,
        ".record.json.tmp-0123456789abcdef0123456789abcdef",
      );
      const handle = await open(temporaryPath, "wx", 0o600);
      await handle.writeFile("complete");
      await handle.sync();
      await handle.close();
      const repair = await repairPrivatePublicationsV1({
        root,
        validatePublishedBytes: () => {
          throw new Error("an unpublished temporary must not be promoted");
        },
      });
      expect(repair.removedUnpublishedTemporaryCount).toBe(1);
      await expect(readFile(temporaryPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(readFile(join(root, "record.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("repairs a validated complete published hard link", async () => {
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
      const repair = await repairPrivatePublicationsV1({
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
