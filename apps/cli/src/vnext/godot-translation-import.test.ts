import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectGodotImportOutputs } from "./godot-import-preparation.js";
import { collectCsvTranslationOutputs } from "./godot-translation-import.js";
import type { GodotValidationSourceFile } from "./godot-validation-stage.js";

const fixtures = JSON.parse(
  await readFile(
    new URL("./godot-translation-import.fixtures.json", import.meta.url),
    "utf8",
  ),
) as {
  name: string;
  files: { relativePath: string; base64: string }[];
}[];
const filesFor = (index = 0): GodotValidationSourceFile[] =>
  fixtures[index]!.files.map((file) => ({
    relativePath: file.relativePath,
    bytes: Buffer.from(file.base64, "base64"),
    executable: false,
  }));
const source = (files: readonly GodotValidationSourceFile[]) =>
  files.filter((f) => f.relativePath === "messages.csv");
const replace = (
  files: readonly GodotValidationSourceFile[],
  path: string,
  transform: (bytes: Buffer) => Uint8Array,
) =>
  files.map((file) =>
    file.relativePath === path
      ? { ...file, bytes: transform(Buffer.from(file.bytes)) }
      : file,
  );
const metadata = (
  files: readonly GodotValidationSourceFile[],
  from: string,
  to: string,
) =>
  replace(files, "messages.csv.import", (bytes) =>
    Buffer.from(bytes.toString().replaceAll(from, to)),
  );

describe("source-bound native CSV translation artifacts", () => {
  const roots: string[] = [];
  afterEach(async () => {
    for (const root of roots.splice(0))
      await rm(root, { recursive: true, force: true });
  });
  const collect = async (
    before: readonly GodotValidationSourceFile[],
    after: readonly GodotValidationSourceFile[],
  ) => {
    const root = await mkdtemp(join(tmpdir(), "chronorift-translations-test-"));
    roots.push(root);
    for (const file of after) {
      await mkdir(dirname(join(root, file.relativePath)), { recursive: true });
      await writeFile(join(root, file.relativePath), file.bytes, {
        mode: file.executable ? 0o700 : 0o600,
      });
    }
    return collectGodotImportOutputs(root, before);
  };

  it.each(fixtures.map((f, index) => [f.name, index] as const))(
    "admits actual %s output without altering pinned CSV bytes",
    async (_name, index) => {
      const after = filesFor(index),
        before = source(after);
      const result = await collect(before, after);
      expect(result.sourceFiles.map((f) => f.relativePath)).toEqual(
        after.map((f) => f.relativePath).sort(),
      );
      expect(
        result.sourceFiles.find((f) => f.relativePath === "messages.csv")
          ?.bytes,
      ).toEqual(before[0]!.bytes);
      expect(result.importCacheFiles).toEqual([]);
    },
  );

  it.each([
    [";", 1],
    ["\t", 2],
  ] as const)(
    "binds quoted/BOM locale headers using delimiter %j",
    (delimiter, option) => {
      let after = filesFor();
      after = replace(after, "messages.csv", () =>
        Buffer.from(
          `\uFEFF"keys"${delimiter}"en"${delimiter}"_comment"${delimiter}"fr"\r\nhello${delimiter}Hello${delimiter}ignored${delimiter}Bonjour\n`,
        ),
      );
      after = metadata(after, "delimiter=0", `delimiter=${option}`);
      expect([...collectCsvTranslationOutputs(source(after), after)]).toEqual([
        "messages.en.translation",
        "messages.fr.translation",
      ]);
    },
  );

  it("permits regeneration of already declared data-only translation products", async () => {
    const before = filesFor(0),
      after = filesFor(1);
    const result = await collect(before, after);
    expect(
      result.sourceFiles.find(
        (f) => f.relativePath === "messages.en.translation",
      )?.bytes,
    ).toEqual(
      after.find((f) => f.relativePath === "messages.en.translation")?.bytes,
    );
    expect(
      before.find((f) => f.relativePath === "messages.en.translation")?.bytes,
    ).not.toEqual(
      after.find((f) => f.relativePath === "messages.en.translation")?.bytes,
    );
  });

  it("rejects changed existing products without original declaration or safe original type", async () => {
    const before = filesFor(0),
      after = filesFor(1);
    await expect(
      collect(
        before.filter((f) => f.relativePath !== "messages.csv.import"),
        after,
      ),
    ).rejects.toThrow("ordinary source");
    await expect(
      collect(
        metadata(before, "messages.en.translation", "other.en.translation"),
        after,
      ),
    ).rejects.toThrow("source CSV locale");
    await expect(
      collect(
        replace(before, "messages.en.translation", () =>
          Buffer.from("extends RefCounted"),
        ),
        after,
      ),
    ).rejects.toThrow("RSRC");
  });

  it("does not authorize overwriting an original translation or CSV source", async () => {
    const after = filesFor();
    const before = [
      ...source(after),
      {
        relativePath: "messages.en.translation",
        bytes: Buffer.from("original ordinary source"),
        executable: false,
      },
    ];
    await expect(collect(before, after)).rejects.toThrow("ordinary source");
    const tampered = replace(after, "messages.csv", () =>
      Buffer.from("keys,en,de\n"),
    );
    await expect(collect(source(after), tampered)).rejects.toThrow(
      "source CSV changed",
    );
  });

  it.each([
    [
      "no descriptor",
      (f: GodotValidationSourceFile[]) =>
        f.filter((x) => x.relativePath !== "messages.csv.import"),
    ],
    [
      "wrong importer",
      (f: GodotValidationSourceFile[]) =>
        metadata(
          f,
          'importer="csv_translation"',
          'importer="custom_translation"',
        ),
    ],
    [
      "wrong source",
      (f: GodotValidationSourceFile[]) =>
        metadata(
          f,
          'source_file="res://messages.csv"',
          'source_file="res://other.csv"',
        ),
    ],
    [
      "wrong type",
      (f: GodotValidationSourceFile[]) =>
        metadata(f, 'type="Translation"', 'type="Script"'),
    ],
    [
      "declared script",
      (f: GodotValidationSourceFile[]) =>
        metadata(f, "messages.en.translation", "messages.gd"),
    ],
    [
      "unrelated output",
      (f: GodotValidationSourceFile[]) =>
        metadata(f, "messages.en.translation", "other.en.translation"),
    ],
    [
      "undeclared locale",
      (f: GodotValidationSourceFile[]) =>
        metadata(f, "messages.en.translation", "messages.de.translation"),
    ],
    [
      "path escape",
      (f: GodotValidationSourceFile[]) =>
        metadata(
          f,
          "res://messages.en.translation",
          "res://../messages.en.translation",
        ),
    ],
    [
      "absolute output",
      (f: GodotValidationSourceFile[]) =>
        metadata(
          f,
          "res://messages.en.translation",
          "/tmp/messages.en.translation",
        ),
    ],
    [
      "mismatched declarations",
      (f: GodotValidationSourceFile[]) =>
        replace(f, "messages.csv.import", (b) =>
          Buffer.from(
            b
              .toString()
              .replace(
                'dest_files=["res://messages.en.translation", "res://messages.fr.translation"]',
                'dest_files=["res://messages.en.translation"]',
              ),
          ),
        ),
    ],
    [
      "duplicate section",
      (f: GodotValidationSourceFile[]) =>
        metadata(f, "[deps]", "[deps]\n[deps]"),
    ],
    [
      "duplicate key",
      (f: GodotValidationSourceFile[]) =>
        metadata(
          f,
          'type="Translation"',
          'type="Translation"\ntype="Translation"',
        ),
    ],
    [
      "invalid import",
      (f: GodotValidationSourceFile[]) =>
        metadata(f, 'type="Translation"', 'type="Translation"\nvalid=false'),
    ],
    [
      "malicious CSV header",
      (f: GodotValidationSourceFile[]) =>
        replace(f, "messages.csv", () => Buffer.from("keys,en,../../escape\n")),
    ],
    [
      "missing generated file",
      (f: GodotValidationSourceFile[]) =>
        f.filter((x) => x.relativePath !== "messages.fr.translation"),
    ],
    [
      "executable output",
      (f: GodotValidationSourceFile[]) =>
        f.map((x) =>
          x.relativePath.endsWith(".translation")
            ? { ...x, executable: true }
            : x,
        ),
    ],
  ] as const)("rejects %s", async (_name, mutate) => {
    const after = mutate(filesFor());
    await expect(collect(source(after), after)).rejects.toThrow();
  });

  it.each([
    ["script bytes", () => Buffer.from("extends Resource\n")],
    [
      "compressed resource container",
      (b: Buffer) => {
        b.write("RSCC");
        return b;
      },
    ],
    [
      "wrong resource type",
      (b: Buffer) =>
        Buffer.from(
          b
            .toString("latin1")
            .replaceAll("OptimizedTranslation", "MaliciousTranslation"),
          "latin1",
        ),
    ],
    [
      "script class flag",
      (b: Buffer) => {
        const typeLength = b.readUInt32LE(24);
        b.writeUInt32LE(11, 28 + typeLength + 8);
        return b;
      },
    ],
    [
      "external resource",
      (b: Buffer) => {
        b.writeUInt32LE(1, b.indexOf(Buffer.from("script\0")) + 7);
        return b;
      },
    ],
    [
      "multiple internal resources",
      (b: Buffer) => {
        b.writeUInt32LE(2, b.indexOf(Buffer.from("script\0")) + 11);
        return b;
      },
    ],
    [
      "attached script",
      (b: Buffer) => {
        b.writeUInt32LE(24, b.length - 8);
        return b;
      },
    ],
    [
      "unknown property",
      (b: Buffer) =>
        Buffer.from(
          b.toString("latin1").replaceAll("hash_table", "fake_table"),
          "latin1",
        ),
    ],
    ["truncated resource", (b: Buffer) => b.subarray(0, -5)],
    [
      "trailing payload",
      (b: Buffer) => Buffer.concat([b, Buffer.from("payload")]),
    ],
    [
      "oversized string",
      (b: Buffer) => {
        b.writeUInt32LE(0x7fffffff, 24);
        return b;
      },
    ],
  ] as const)("rejects forged binary resource: %s", (_name, mutate) => {
    const after = replace(filesFor(), "messages.en.translation", mutate);
    expect(() => collectCsvTranslationOutputs(source(after), after)).toThrow();
  });

  it("binds binary resource locale to its CSV column", () => {
    const after = filesFor();
    const en = after.find(
      (f) => f.relativePath === "messages.en.translation",
    )!.bytes;
    expect(() =>
      collectCsvTranslationOutputs(
        source(after),
        replace(after, "messages.fr.translation", () => en),
      ),
    ).toThrow("resource locale");
  });
});
