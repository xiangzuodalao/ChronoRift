import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, readFile, realpath } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";

const exec = promisify(execFile);
export const GODOT_AI_VERSION = "4.1.0";
export const GODOT_AI_ARCHIVE_SHA256 =
  "535d8a7541871af8d991b07fe5031550dd6121a31b844400476b334a70612831";
export const godotMcpHome = (): string =>
  resolve(
    process.env.CHRONORIFT_GODOT_AI_HOME ??
      fileURLToPath(
        new URL("../../../../.tools/godot-ai/4.1.0", import.meta.url),
      ),
  );
const manifestSchema = z
  .object({
    version: z.literal(GODOT_AI_VERSION),
    archiveSha256: z.literal(GODOT_AI_ARCHIVE_SHA256),
    files: z.record(
      z
        .string()
        .regex(/^plugin\/addons\/godot_ai\/(?!.*(?:^|\/)\.\.(?:\/|$))[^\0]+$/u),
      z.string().regex(/^[a-f0-9]{64}$/u),
    ),
  })
  .strict();

async function executable(name: string): Promise<string> {
  for (const entry of (process.env.PATH ?? "/usr/bin:/bin").split(delimiter)) {
    const path = resolve(entry, name);
    try {
      await access(path, constants.X_OK);
      return await realpath(path);
    } catch {
      /* next */
    }
  }
  throw new Error(`${name} is required for the managed Godot MCP environment`);
}

export async function resolveGodotMcpInstallation() {
  const directory = await realpath(godotMcpHome()).catch(() => {
    throw new Error(
      "Godot MCP is not installed; run godot:install -- --with-mcp",
    );
  });
  const manifest = manifestSchema.parse(
    JSON.parse(await readFile(join(directory, "installation.json"), "utf8")),
  );
  if (Object.keys(manifest.files).length === 0)
    throw new Error("Empty Godot MCP inventory");
  for (const [path, expected] of Object.entries(manifest.files)) {
    const filename = join(directory, path);
    const stat = await lstat(filename);
    if (
      (await realpath(filename)) !== filename ||
      stat.size > 64 * 1024 * 1024 ||
      !stat.isFile() ||
      stat.nlink !== 1 ||
      createHash("sha256")
        .update(await readFile(filename))
        .digest("hex") !== expected
    )
      throw new Error(`Godot MCP installation integrity failed: ${path}`);
  }
  const python = join(directory, "venv/bin/python");
  await access(python, constants.X_OK);
  const xvfb =
    process.env.CHRONORIFT_XVFB_BIN === undefined
      ? await executable("Xvfb")
      : await realpath(process.env.CHRONORIFT_XVFB_BIN);
  await access(xvfb, constants.X_OK);
  return {
    directory,
    python,
    xvfb,
    addon: join(directory, "plugin/addons/godot_ai"),
    files: manifest.files,
  };
}

export async function installGodotMcp() {
  const python = await executable("python3");
  const script = fileURLToPath(
    new URL("../../../../scripts/install-godot-mcp.py", import.meta.url),
  );
  const { stdout } = await exec(python, [script, godotMcpHome()], {
    timeout: 300_000,
    maxBuffer: 1024 * 1024,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: process.env.HOME ?? "/nonexistent",
      LANG: "C.UTF-8",
    },
  });
  return JSON.parse(stdout) as unknown;
}

export async function doctorGodotMcp() {
  try {
    const installation = await resolveGodotMcpInstallation();
    const { stdout } = await exec(
      installation.python,
      [
        "-c",
        "import importlib.metadata; print(importlib.metadata.version('godot-ai'))",
      ],
      {
        timeout: 10_000,
        maxBuffer: 4096,
        env: {
          PATH: "/usr/bin:/bin",
          HOME: "/nonexistent",
          PYTHONNOUSERSITE: "1",
        },
      },
    );
    if (stdout.trim() !== GODOT_AI_VERSION)
      throw new Error("Godot AI Python version mismatch");
    return {
      available: true,
      version: GODOT_AI_VERSION,
      directory: installation.directory,
      xvfb: installation.xvfb,
    };
  } catch (error) {
    return {
      available: false,
      version: GODOT_AI_VERSION,
      error: String(error),
    };
  }
}
