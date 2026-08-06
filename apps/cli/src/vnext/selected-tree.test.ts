import { execFile } from "node:child_process";
import {
  chmod,
  mkdtemp,
  mkdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  readTrustedSelectedTree,
  selectedTreeSha256,
  selectedTreeSha256FromSources,
  type SelectedTreeContentSourceV1,
  type SelectedTreeEntryV1,
} from "./selected-tree.js";

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];

const createTemporaryRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "chronorift-selected-tree-test-"));
  temporaryRoots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map(async (root) => rm(root, { recursive: true, force: true })),
  );
});

const canonicalEntries = (): readonly SelectedTreeEntryV1[] => [
  {
    relativePath: "project.godot",
    mode: "100644",
    content: Buffer.from("[application]\n"),
  },
  {
    relativePath: "bin/run.sh",
    mode: "100755",
    content: Buffer.from("#!/bin/sh\n"),
  },
];

describe("selected tree hashing", () => {
  it("uses one stable length-prefixed encoding for bytes and streams", async () => {
    const entries = canonicalEntries();
    const sources: readonly SelectedTreeContentSourceV1[] = entries.map(
      (entry) => ({
        relativePath: entry.relativePath,
        mode: entry.mode,
        byteLength: entry.content.byteLength,
        async *chunks() {
          yield entry.content.subarray(0, 2);
          yield entry.content.subarray(2);
        },
      }),
    );

    expect(selectedTreeSha256([...entries].reverse())).toBe(
      "73302ea7a1359fc6df4190c9cb338730b62cf01c06930b15a14f1330ba4a32ed",
    );
    await expect(
      selectedTreeSha256FromSources([...sources].reverse()),
    ).resolves.toBe(selectedTreeSha256(entries));
  });

  it("rejects streams that yield fewer or more bytes than declared", async () => {
    const source = (
      byteLength: number,
    ): readonly SelectedTreeContentSourceV1[] => [
      {
        relativePath: "project.godot",
        mode: "100644",
        byteLength,
        async *chunks() {
          yield Buffer.from("abc");
        },
      },
    ];

    await expect(selectedTreeSha256FromSources(source(4))).rejects.toThrow(
      /fewer|short|byteLength/iu,
    );
    await expect(selectedTreeSha256FromSources(source(2))).rejects.toThrow(
      /more|long|byteLength/iu,
    );
  });

  it.each([
    "",
    "/absolute",
    "../escape",
    "nested/../escape",
    "windows\\path",
    ".git/config",
    "nested/.git/config",
    "double//slash",
    "./alias",
    "nested/./alias",
  ])("rejects unsafe or aliased path %j", (relativePath) => {
    expect(() =>
      selectedTreeSha256([
        { relativePath, mode: "100644", content: Buffer.alloc(0) },
      ]),
    ).toThrow(/path/iu);
  });

  it("rejects duplicate UTF-8 byte paths", async () => {
    const duplicateEntry: SelectedTreeEntryV1 = {
      relativePath: "project.godot",
      mode: "100644",
      content: Buffer.from("[application]\n"),
    };
    const duplicateEntries = [duplicateEntry, duplicateEntry];
    expect(() => selectedTreeSha256(duplicateEntries)).toThrow(/duplicate/iu);

    const duplicateSources = duplicateEntries.map((entry) => ({
      relativePath: entry.relativePath,
      mode: entry.mode,
      byteLength: entry.content.byteLength,
      async *chunks() {
        yield entry.content;
      },
    }));
    await expect(
      selectedTreeSha256FromSources(duplicateSources),
    ).rejects.toThrow(/duplicate/iu);
  });
});

describe("trusted selected tree reader", () => {
  it("includes every regular file, its bytes, and its executable mode", async () => {
    const root = await createTemporaryRoot();
    await mkdir(join(root, "scripts"));
    await writeFile(join(root, "chronorift.fixture.json"), "{}\n");
    await writeFile(join(root, "scripts", "run.sh"), "#!/bin/sh\n");

    const baseline = await readTrustedSelectedTree(root);

    await writeFile(join(root, "chronorift.fixture.json"), "{ }\n");
    expect(await readTrustedSelectedTree(root)).not.toBe(baseline);
    await writeFile(join(root, "chronorift.fixture.json"), "{}\n");

    await chmod(join(root, "scripts", "run.sh"), 0o755);
    expect(await readTrustedSelectedTree(root)).not.toBe(baseline);
    await chmod(join(root, "scripts", "run.sh"), 0o644);

    await writeFile(join(root, "added.txt"), "new\n");
    expect(await readTrustedSelectedTree(root)).not.toBe(baseline);
  });

  it("never follows symlinks", async () => {
    const root = await createTemporaryRoot();
    await writeFile(join(root, "target.txt"), "target\n");
    await symlink("target.txt", join(root, "link.txt"));

    await expect(readTrustedSelectedTree(root)).rejects.toThrow(
      /symbolic|symlink/iu,
    );
  });

  it("rejects special files", async () => {
    const root = await createTemporaryRoot();
    const fifo = join(root, "events.fifo");
    await execFileAsync("mkfifo", [fifo]);

    await expect(readTrustedSelectedTree(root)).rejects.toThrow(
      /regular|special|unsupported/iu,
    );
  });
});
