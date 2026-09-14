interface Token {
  readonly kind: "word" | "string" | "symbol";
  readonly value: string;
}

// Only the literal declarations relevant to script admission are inspected.
// This is not a GDScript control-flow or dynamic-resource reachability analysis.
const tokens = (source: string, gdscript: boolean): readonly Token[] => {
  const result: Token[] = [];
  for (let offset = 0; offset < source.length;) {
    const char = source[offset]!;
    if (/\s/u.test(char)) {
      offset += 1;
    } else if (char === "#" || (!gdscript && char === ";")) {
      const newline = source.indexOf("\n", offset);
      offset = newline === -1 ? source.length : newline + 1;
    } else if (char === '"' || char === "'") {
      const delimiter = source.startsWith(char.repeat(3), offset)
        ? char.repeat(3)
        : char;
      offset += delimiter.length;
      let value = "";
      while (offset < source.length && !source.startsWith(delimiter, offset)) {
        if (source[offset] === "\\") {
          offset += 1;
          if (source[offset] === "u" || source[offset] === "U") {
            const length = source[offset] === "u" ? 4 : 6;
            const hex = source.slice(offset + 1, offset + 1 + length);
            const point = Number.parseInt(hex, 16);
            if (
              hex.length === length &&
              /^[0-9a-f]+$/iu.test(hex) &&
              point <= 0x10ffff
            ) {
              value += String.fromCodePoint(point);
              offset += 1 + length;
              continue;
            }
          }
        }
        value += source[offset] ?? "";
        offset += 1;
      }
      offset += delimiter.length;
      result.push({ kind: "string", value });
    } else {
      const word = /^[\p{L}\p{N}_/.]+/u.exec(source.slice(offset))?.[0];
      if (word !== undefined) {
        result.push({ kind: "word", value: word });
        offset += word.length;
      } else {
        result.push({ kind: "symbol", value: char });
        offset += 1;
      }
    }
  }
  return result;
};

const csharpPath = (token: Token | undefined): boolean =>
  token?.kind === "string" && /\.cs$/iu.test(token.value);

/**
 * Reject explicit .NET requirements while retaining optional C# source bytes.
 * A guarded runtime load, such as a plugin probing CSharpScript support, cannot
 * be proven reachable here. Its actual import/run result remains authoritative.
 */
export const projectEnvironmentCSharpRequirementV1 = (
  relativePath: string,
  bytes: Uint8Array,
): string | undefined => {
  const path = relativePath.toLowerCase();
  const gdscript = path.endsWith(".gd");
  const configuration = path === "project.godot" || path === "override.cfg";
  const plugin = path.endsWith("/plugin.cfg") || path === "plugin.cfg";
  const resource = path.endsWith(".tscn") || path.endsWith(".tres");
  if (!gdscript && !configuration && !plugin && !resource) return undefined;
  const unsupported = () =>
    `Project Environment requires the GDScript runtime; explicit C#/.NET script requirement in ${relativePath}`;
  if (configuration) {
    try {
      for (const setting of readGodotTextSettings(bytes)) {
        const name = setting.name.split(".")[0];
        if (
          name === "application/config/features" &&
          tokens(setting.value, false).some(
            (token) =>
              token.kind === "string" && token.value.toLowerCase() === "c#",
          )
        )
          return unsupported();
        if (
          (name?.startsWith("autoload/") ||
            name?.startsWith("autoload_prepend/") ||
            name === "application/run/main_scene") &&
          /\.cs$/iu.test(godotSettingString(setting.value) ?? "")
        )
          return unsupported();
      }
    } catch (error) {
      return error instanceof Error
        ? error.message
        : `Invalid project settings: ${relativePath}`;
    }
    // An assembly_name alone is harmless metadata, not a Mono requirement.
    return undefined;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return `Project Environment source must be valid UTF-8: ${relativePath}`;
  }
  const input = tokens(text, gdscript);
  let section = "";
  for (let i = 0; i < input.length; i += 1) {
    const token = input[i]!;
    const next = input[i + 1];
    if (token.kind === "symbol" && token.value === "[") {
      section = next?.value ?? "";
    }
    if (token.kind !== "word") continue;
    if (gdscript) {
      if (
        (token.value === "extends" && csharpPath(next)) ||
        (token.value === "preload" &&
          next?.value === "(" &&
          csharpPath(input[i + 2]))
      )
        return unsupported();
      continue;
    }
    if (next?.value !== "=") continue;
    const value = input[i + 2];
    if (
      (plugin && token.value === "script" && csharpPath(value)) ||
      (resource &&
        ((section === "ext_resource" &&
          token.value === "path" &&
          csharpPath(value)) ||
          (token.value === "type" && value?.value === "CSharpScript")))
    )
      return unsupported();
  }
  return undefined;
};
import {
  godotSettingString,
  readGodotTextSettings,
} from "./godot-settings-overlay.js";
