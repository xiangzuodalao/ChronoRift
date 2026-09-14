import type { GodotValidationSourceFile } from "./godot-validation-stage.js";

// Native CSV imports are unusual: their generated resources live beside the CSV.
// Godot declares these in both [deps] files and dest_files, rather than a remap path.
// See Godot's resource_importer_csv_translation.cpp and resource_format_binary.cpp.
const requireValue: (
  condition: unknown,
  message: string,
) => asserts condition = (condition, message) => {
  if (!condition) throw new Error(`Unsafe CSV translation import: ${message}`);
};
const text = (bytes: Uint8Array): string =>
  new TextDecoder("utf-8", { fatal: true }).decode(bytes);
const localePattern =
  /^[a-z]{2,3}(?:_[A-Z][a-z]{3})?(?:_[A-Z]{2})?(?:_[a-z0-9]{4,8})?$/u;

const descriptorValues = (bytes: Uint8Array): Map<string, string> => {
  requireValue(bytes.byteLength <= 1024 * 1024, "descriptor too large");
  const values = new Map<string, string>();
  const sections = new Set<string>();
  let section = "";
  for (const raw of text(bytes).split(/\r?\n/u)) {
    const line = raw.trim();
    if (!line || line.startsWith(";")) continue;
    const heading = /^\[([a-z_]+)\]$/u.exec(line);
    if (heading) {
      section = heading[1]!;
      requireValue(!sections.has(section), "duplicate descriptor section");
      sections.add(section);
      continue;
    }
    const entry = /^([a-z_]+)=(.*)$/u.exec(line);
    requireValue(entry && section, "malformed descriptor");
    const key = `${section}/${entry[1]!}`;
    requireValue(!values.has(key), "duplicate descriptor key");
    values.set(key, entry[2]!);
  }
  const allowed = new Set([
    "remap/importer",
    "remap/type",
    "remap/uid",
    "remap/importer_version",
    "remap/valid",
    "deps/files",
    "deps/source_file",
    "deps/dest_files",
    "params/compress",
    "params/delimiter",
    "params/unescape_keys",
    "params/unescape_translations",
  ]);
  requireValue(
    [...values.keys()].every((key) => allowed.has(key)),
    "unsupported descriptor field",
  );
  requireValue(
    [...sections].every((key) => ["remap", "deps", "params"].includes(key)),
    "unsupported descriptor section",
  );
  return values;
};

// Only canonical locale spellings and '-' separators are accepted. Godot aliases
// requiring its version-specific locale tables fail closed instead of guessing.
const csvLocales = (bytes: Uint8Array, delimiter: string): string[] => {
  let end = 0,
    quoted = false;
  for (; end < bytes.length && end < 64 * 1024; end++) {
    if (bytes[end] === 34) {
      if (quoted && bytes[end + 1] === 34) end++;
      else quoted = !quoted;
    } else if (!quoted && bytes[end] === 10) break;
  }
  requireValue(
    end < 64 * 1024 && !quoted,
    "CSV header is unbounded or malformed",
  );
  const header = text(bytes.subarray(0, end))
    .replace(/^\uFEFF/u, "")
    .replace(/\r$/u, "");
  const fields: string[] = [];
  let field = "",
    state: "start" | "plain" | "quoted" | "closed" = "start";
  for (let i = 0; i <= header.length; i++) {
    const char = header[i];
    if (state === "quoted") {
      if (char === '"') {
        if (header[i + 1] === '"') {
          field += '"';
          i++;
        } else state = "closed";
      } else {
        requireValue(char !== undefined, "unterminated CSV header quote");
        field += char;
      }
    } else if (char === delimiter || char === undefined) {
      fields.push(field);
      field = "";
      state = "start";
    } else if (char === '"' && state === "start") state = "quoted";
    else {
      requireValue(
        state !== "closed" && char !== '"',
        "malformed CSV header quote",
      );
      field += char;
      state = "plain";
    }
  }
  requireValue(
    fields.length > 1 && fields.length <= 512,
    "CSV needs bounded locale columns",
  );
  const locales = fields
    .slice(1)
    .filter(
      (value) =>
        !value.startsWith("_") &&
        !["?context", "?plural"].includes(value.toLowerCase()),
    )
    .map((value) => value.replaceAll("-", "_"));
  requireValue(
    locales.every((locale) => localePattern.test(locale)),
    "unsupported or unsafe CSV locale header",
  );
  requireValue(
    new Set(locales).size === locales.length,
    "duplicate CSV locale",
  );
  return locales;
};

class TranslationReader {
  private position = 0;
  public constructor(private readonly bytes: Uint8Array) {}
  public get offset(): number {
    return this.position;
  }
  public take(length: number): Uint8Array {
    requireValue(
      Number.isSafeInteger(length) &&
        length >= 0 &&
        length <= this.bytes.length - this.position,
      "truncated binary resource",
    );
    const value = this.bytes.subarray(this.position, this.position + length);
    this.position += length;
    return value;
  }
  public u32(): number {
    const b = this.take(4);
    return new DataView(b.buffer, b.byteOffset, 4).getUint32(0, true);
  }
  public u64(): bigint {
    const b = this.take(8);
    return new DataView(b.buffer, b.byteOffset, 8).getBigUint64(0, true);
  }
  public string(): string {
    const length = this.u32();
    requireValue(
      length > 0 && length <= 64 * 1024 * 1024,
      "invalid binary string length",
    );
    const value = this.take(length);
    requireValue(
      value[length - 1] === 0 && !value.subarray(0, -1).includes(0),
      "invalid binary string",
    );
    return text(value.subarray(0, -1));
  }
}

// Accept only the data-only subset written by the native CSV saver. Checking just
// RSRC/type would also admit resources containing scripts or external dependencies.
const validateTranslation = (
  bytes: Uint8Array,
  expectedLocale: string,
  compression: boolean | number,
): void => {
  const r = new TranslationReader(bytes);
  requireValue(
    text(r.take(4)) === "RSRC",
    "expected native RSRC translation (RSCC is unsupported)",
  );
  requireValue(
    r.u32() === 0 && r.u32() === 0 && r.u32() === 4,
    "unsupported binary encoding",
  );
  r.u32(); // Godot minor version; format version controls the supported wire layout.
  const format = r.u32();
  requireValue(
    format === 5 || format === 6,
    "unsupported resource format version",
  );
  const type = r.string();
  const compressed = type === "OptimizedTranslation";
  requireValue(
    compressed || type === "Translation",
    "unexpected resource type",
  );
  requireValue(
    compression === 1 ||
      type === (compression ? "OptimizedTranslation" : "Translation"),
    "resource type disagrees with CSV importer",
  );
  requireValue(r.u64() === 0n, "unexpected resource import metadata");
  const flags = r.u32();
  requireValue(
    flags === 3 || flags === 7,
    "script class or unsupported binary flags",
  );
  r.u64(); // Resource UID is opaque data.
  for (let i = 0; i < 11; i++)
    requireValue(r.u32() === 0, "unsupported reserved resource data");
  const stringCount = r.u32();
  requireValue(stringCount <= 16, "oversized translation property table");
  const strings = Array.from({ length: stringCount }, () => r.string());
  requireValue(
    new Set(strings).size === strings.length,
    "duplicate property table entry",
  );
  requireValue(
    r.u32() === 0 && r.u32() === 1,
    "external or multiple internal resources",
  );
  requireValue(
    /^local:\/\/[A-Za-z0-9_]+$/u.test(r.string()),
    "unsafe internal resource path",
  );
  const offset = r.u64();
  requireValue(offset === BigInt(r.offset), "invalid internal resource offset");
  requireValue(r.string() === type, "mismatched internal resource type");
  const propertyCount = r.u32();
  requireValue(propertyCount <= 8, "too many translation properties");
  const seen = new Set<string>();
  let locale = "en";
  for (let i = 0; i < propertyCount; i++) {
    const name = strings[r.u32()];
    requireValue(
      name && !seen.has(name),
      "invalid or duplicate resource property",
    );
    seen.add(name);
    const variant = r.u32();
    if (name === "script")
      requireValue(variant === 1, "attached translation script");
    else if (name === "locale" || name === "resource_name") {
      requireValue(variant === 5, "non-string locale/resource name");
      const value = r.string();
      if (name === "locale") locale = value;
    } else if (name === "resource_local_to_scene")
      requireValue(variant === 2 && r.u32() === 0, "unexpected local resource");
    else if (!compressed && name === "messages") {
      requireValue(variant === 26, "non-dictionary messages");
      const count = r.u32();
      requireValue(
        count <= bytes.length / 8,
        "oversized/shared message dictionary",
      );
      for (let j = 0; j < count * 2; j++) {
        const valueType = r.u32();
        requireValue(
          valueType === 5 || valueType === 44,
          "non-string translation message",
        );
        r.string();
      }
    } else if (
      compressed &&
      (name === "hash_table" || name === "bucket_table" || name === "strings")
    ) {
      requireValue(
        variant === (name === "strings" ? 31 : 32),
        "invalid optimized translation array",
      );
      const count = r.u32();
      r.take(count * (name === "strings" ? 1 : 4));
      if (name === "strings")
        requireValue(
          r.take((4 - (count % 4)) % 4).every((value) => value === 0),
          "invalid byte-array padding",
        );
    } else
      throw new Error(
        `Unsafe CSV translation import: unexpected property ${name}`,
      );
  }
  requireValue(
    locale === expectedLocale,
    "resource locale disagrees with source CSV",
  );
  requireValue(
    text(r.take(4)) === "RSRC" && r.offset === bytes.length,
    "invalid resource end marker or trailing bytes",
  );
};

/** Validate declarations and the native data-only products they name. */
const collectBoundCsvTranslations = (
  before: readonly GodotValidationSourceFile[],
  after: readonly GodotValidationSourceFile[],
  allowMissingOutputs = false,
): ReadonlySet<string> => {
  const imported = new Map(after.map((file) => [file.relativePath, file]));
  const accepted = new Set<string>();
  for (const csv of before.filter((file) =>
    file.relativePath.toLowerCase().endsWith(".csv"),
  )) {
    const descriptor = imported.get(`${csv.relativePath}.import`);
    if (!descriptor) continue;
    requireValue(
      descriptor.bytes.byteLength <= 1024 * 1024,
      "descriptor too large",
    );
    if (!text(descriptor.bytes).includes('"csv_translation"')) continue;
    const values = descriptorValues(descriptor.bytes);
    const json = (key: string): unknown =>
      JSON.parse(values.get(key) ?? "null") as unknown;
    requireValue(
      json("remap/importer") === "csv_translation" &&
        json("remap/type") === "Translation",
      "wrong importer/type declaration",
    );
    if (values.has("remap/uid"))
      requireValue(
        typeof json("remap/uid") === "string" &&
          /^uid:\/\/[a-z0-9]+$/u.test(json("remap/uid") as string),
        "invalid importer UID",
      );
    if (values.has("remap/importer_version"))
      requireValue(
        Number.isSafeInteger(json("remap/importer_version")) &&
          Number(json("remap/importer_version")) >= 0,
        "invalid importer version",
      );
    requireValue(
      !values.has("remap/valid") || json("remap/valid") === true,
      "invalid import declaration",
    );
    requireValue(
      json("deps/source_file") === `res://${csv.relativePath}`,
      "descriptor source mismatch",
    );
    const currentCsv = imported.get(csv.relativePath);
    requireValue(
      currentCsv &&
        currentCsv.executable === csv.executable &&
        Buffer.from(currentCsv.bytes).equals(csv.bytes),
      "source CSV changed",
    );
    const delimiter = json("params/delimiter");
    const compressed = json("params/compress");
    requireValue(
      (delimiter === 0 || delimiter === 1 || delimiter === 2) &&
        (typeof compressed === "boolean" ||
          compressed === 0 ||
          compressed === 1),
      "unsupported CSV importer parameters",
    );
    for (const key of ["params/unescape_keys", "params/unescape_translations"])
      requireValue(
        !values.has(key) || typeof json(key) === "boolean",
        "invalid CSV escaping parameter",
      );
    const locales = csvLocales(csv.bytes, [",", ";", "\t"][delimiter]!);
    const expected = locales.map(
      (locale) =>
        `res://${csv.relativePath.slice(0, -4)}.${locale}.translation`,
    );
    const files = json("deps/files") ?? [],
      destinations = json("deps/dest_files") ?? [];
    requireValue(
      Array.isArray(files) &&
        Array.isArray(destinations) &&
        JSON.stringify(files) === JSON.stringify(destinations) &&
        new Set(files).size === files.length &&
        files.every(
          (path: unknown) =>
            typeof path === "string" && expected.includes(path),
        ),
      "generated files do not match source CSV locale columns",
    );
    for (const path of files as string[]) {
      const index = expected.indexOf(path);
      const relativePath = path.slice(6);
      requireValue(
        !relativePath.includes("\\") &&
          !relativePath.includes("\0") &&
          !relativePath.includes(":") &&
          relativePath
            .split("/")
            .every(
              (part) =>
                part &&
                part !== "." &&
                part !== ".." &&
                part !== ".godot" &&
                part !== ".git",
            ),
        "unsafe generated path",
      );
      const output = imported.get(relativePath);
      if (!output && allowMissingOutputs) continue;
      requireValue(
        output && !output.executable,
        "missing or executable translation output",
      );
      validateTranslation(output.bytes, locales[index]!, compressed);
      accepted.add(relativePath);
    }
  }
  return accepted;
};

/** Existing resources can regenerate only if the immutable input already declares
 * and contains the same source-bound, data-only CSV product. */
export const collectCsvTranslationOutputs = (
  before: readonly GodotValidationSourceFile[],
  after: readonly GodotValidationSourceFile[],
): ReadonlySet<string> => {
  const outputs = collectBoundCsvTranslations(before, after);
  const originals = new Map(before.map((file) => [file.relativePath, file]));
  const imported = new Map(after.map((file) => [file.relativePath, file]));
  const changedOriginals = [...outputs].filter((path) => {
    const original = originals.get(path),
      current = imported.get(path)!;
    return (
      original &&
      (original.executable !== current.executable ||
        !Buffer.from(original.bytes).equals(current.bytes))
    );
  });
  const previousOutputs = changedOriginals.length
    ? collectBoundCsvTranslations(before, before, true)
    : new Set<string>();
  return new Set(
    [...outputs].filter(
      (path) => !originals.has(path) || previousOutputs.has(path),
    ),
  );
};
