/** A boundary scanner for Godot text settings. Values remain opaque Variant text. */
export interface GodotTextSetting {
  readonly name: string;
  readonly value: string;
}

const decode = (bytes: Uint8Array): string => {
  if (bytes.byteLength > 1024 * 1024)
    throw new Error("Godot settings exceed the 1 MiB configuration budget");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (text.includes("\0")) throw new Error("Godot settings contain NUL");
  return text;
};

export function readGodotTextSettings(bytes: Uint8Array): GodotTextSetting[] {
  const text = decode(bytes),
    settings: GodotTextSetting[] = [];
  let offset = 0,
    section = "";
  const invalid = (): never => {
    throw new Error("Malformed or unsupported Godot settings syntax");
  };
  const skip = (): void => {
    while (offset < text.length) {
      if (text.charCodeAt(offset) <= 32) offset++;
      else if (text[offset] === ";") {
        while (offset < text.length && text[offset] !== "\n") offset++;
      } else break;
    }
  };
  const string = (): string => {
    if (text[offset++] !== '"') return invalid();
    let result = "";
    while (offset < text.length) {
      const char = text[offset++];
      if (char === '"') return result;
      if (char !== "\\") {
        result += char;
        continue;
      }
      const escape = text[offset++];
      if (escape === undefined) return invalid();
      if (escape === "u" || escape === "U") {
        const length = escape === "u" ? 4 : 6,
          hex = text.slice(offset, offset + length);
        if (hex.length !== length || !/^[a-f0-9]+$/iu.test(hex))
          return invalid();
        offset += length;
        const point = Number.parseInt(hex, 16);
        if (point > 0x10ffff) return invalid();
        result += String.fromCodePoint(point);
      } else {
        result +=
          (
            { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r" } as Record<
              string,
              string
            >
          )[escape] ?? escape;
      }
    }
    return invalid();
  };
  const container = (): void => {
    const pairs: Record<string, string> = { "[": "]", "{": "}", "(": ")" };
    const stack: string[] = [];
    do {
      skip();
      const char = text[offset];
      if (char === undefined) return invalid();
      if (char === '"') {
        string();
        continue;
      }
      offset++;
      if (pairs[char]) {
        stack.push(pairs[char]);
        if (stack.length > 64)
          throw new Error("Godot settings nesting budget exceeded");
      } else if (["]", "}", ")"].includes(char) && stack.pop() !== char)
        return invalid();
    } while (stack.length);
  };
  const value = (): string => {
    skip();
    const start = offset,
      char = text[offset];
    if (char === '"') string();
    else if ((char === "&" || char === "^") && text[offset + 1] === '"') {
      offset++;
      string();
    } else if (char === "[" || char === "{") container();
    else {
      const token =
        /^(?:[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|-?[A-Za-z_][A-Za-z_0-9]*|#[A-Fa-f0-9]+)/u.exec(
          text.slice(offset),
        )?.[0];
      if (!token) return invalid();
      offset += token.length;
      // Constructor and typed-array payloads may contain multiline Variant values.
      if (
        /^[A-Za-z_]/u.test(token) &&
        !["true", "false", "null", "nil", "inf", "nan", "inf_neg"].includes(
          token,
        )
      ) {
        skip();
        if (text[offset] === "[") container();
        skip();
        if (text[offset] === "(") container();
      }
    }
    return text.slice(start, offset).trim();
  };
  while (true) {
    skip();
    if (offset >= text.length) return settings;
    if (text[offset] === "[") {
      offset++;
      const start = offset;
      let escaped = false,
        closed = false;
      while (offset < text.length) {
        const char = text[offset++];
        if (char === "]" && !escaped) {
          closed = true;
          break;
        }
        escaped = char === "\\";
      }
      if (!closed) return invalid();
      section = text.slice(start, offset - 1).trim();
      if (!section) return invalid();
      continue;
    }
    let name = "";
    while (offset < text.length && text[offset] !== "=") {
      skip();
      if (text[offset] === "=") break;
      if (text[offset] === '"') name = string();
      else if (offset < text.length) name += text[offset++];
    }
    if (!name || name.includes("\0") || text[offset++] !== "=")
      return invalid();
    settings.push({
      name: section ? `${section}/${name}` : name,
      value: value(),
    });
    if (settings.length > 16_384)
      throw new Error("Godot settings entry budget exceeded");
  }
}

export function godotSettingString(value: string): string | null {
  if (!value.startsWith('"')) return null;
  // Reuse the scanner's Godot string escapes through a quoted assignment name.
  const setting = readGodotTextSettings(
    Buffer.from(`"__value:${value.slice(1)}=null`, "utf8"),
  );
  return setting.length === 1
    ? (setting[0]?.name.slice("__value:".length) ?? null)
    : null;
}

/** Alternate override chains cannot supersede the Host-owned inspection autoload. */
export function assertInspectionSettingsSafe(
  settings: readonly GodotTextSetting[],
): void {
  for (const setting of settings) {
    const base = setting.name.split(".")[0];
    if (
      base === "autoload/ChronoRiftInspection" ||
      base?.startsWith("autoload/ChronoRiftInspection/") ||
      base === "autoload_prepend/ChronoRiftInspection" ||
      base?.startsWith("autoload_prepend/ChronoRiftInspection/")
    )
      throw new Error(
        "Godot settings contain the reserved ChronoRiftInspection autoload",
      );
    if (
      base === "application/config/project_settings_override" &&
      godotSettingString(setting.value) !== ""
    )
      throw new Error(
        "Custom project_settings_override chains are not supported by inspection",
      );
    if (
      base === "application/config/disable_project_settings_override" &&
      setting.value !== "false"
    )
      throw new Error(
        "Inspection requires project settings overrides to remain enabled",
      );
  }
}

/** Preserve source text, then append Host values, including known feature-tag variants. */
export function mergeGodotSettingsOverride(
  original: Uint8Array | undefined,
  managed: Uint8Array,
  inherited: readonly GodotTextSetting[] = [],
): Uint8Array {
  const upstream =
    original === undefined ? [] : readGodotTextSettings(original);
  const host = readGodotTextSettings(managed);
  const hostByName = new Map(
    host.map((setting) => [setting.name, setting.value]),
  );
  const variants = new Map<string, string>();
  for (const setting of [...inherited, ...upstream]) {
    const base = setting.name.split(".")[0];
    const value = base === undefined ? undefined : hostByName.get(base);
    if (setting.name !== base && value !== undefined)
      variants.set(setting.name, value);
  }
  const suffix = [...variants]
    .map(([name, value]) => {
      const slash = name.indexOf("/");
      if (slash < 1 || /[\r\n\[\]\\]/u.test(name.slice(0, slash)))
        throw new Error("Unsupported feature-qualified managed setting");
      return `\n[${name.slice(0, slash)}]\n${JSON.stringify(name.slice(slash + 1))}=${value}\n`;
    })
    .join("");
  return Buffer.concat([
    original ?? Buffer.alloc(0),
    Buffer.from(original === undefined ? "" : "\n"),
    managed,
    Buffer.from(suffix),
  ]);
}
