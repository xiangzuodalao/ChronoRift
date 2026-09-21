import { access, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";

import { installGodot, managedGodotBinary } from "@chronorift/godot-adapter";
import { resolvePiHostModel } from "@chronorift/pi-harness";

import { flag, hasFlag, parseArguments, printJson } from "./cli-arguments.js";
import {
  projectPreviewCommand,
  validateProjectPreviewArguments,
} from "./project-preview-command.js";

export const chronoriftHelp = `ChronoRift — investigate a Godot project with Pi

Usage: crf ["task"] [options]
       crf setup

Run in your game's Git directory. With no task, opens the interactive UI.
Use /login to authenticate and /model to select a model; the choice is saved.

Options:
  --provider NAME           Override the saved Pi provider
  --model NAME              Override the saved Pi model
  --thinking LEVEL          Override the saved thinking level
  --multi-agent             Enable optional workers (default maximum: 3)
  --max-agents N            Maximum active workers, 1–4
  --worker-provider NAME    Worker provider (requires --worker-model)
  --worker-model NAME       Worker model
  --worker-thinking LEVEL   Worker thinking level
  --project-root PATH       Godot project path relative to the Git root
  --include-untracked FILE  Include one untracked project file; repeat as needed
  --godot-bin PATH          Use an existing supported Godot executable
  --state-root PATH         Store private runs at this location
  --agent-dir PATH          Use this Pi Host configuration directory
  --timeout-ms MS           Investigation timeout
  --json                    Print structured results; requires a task
  --help                    Show this help

Requires Linux x86_64, Git, Bubblewrap, socat, ripgrep, and user namespaces.
setup downloads checksum-verified Godot into the user's cache (requires curl/unzip).
Changes are made in a private candidate. Review the returned patch before applying it.
`;

export const userToolchainDirectory = (): string =>
  resolve(
    process.env.XDG_CACHE_HOME || resolve(homedir(), ".cache"),
    "chronorift",
  );

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function setupGodot(): Promise<string> {
  const cwd = userToolchainDirectory();
  await mkdir(cwd, { recursive: true, mode: 0o700 });
  process.stderr.write(
    "Installing checksum-verified Godot in the user cache…\n",
  );
  const report = await installGodot({ cwd });
  process.stderr.write(`Godot ready: ${report.binary}\n`);
  return report.binary;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(chronoriftHelp);
    return;
  }
  if (argv[0] === "setup") {
    if (argv.length !== 1) throw new Error("Usage: crf setup");
    await setupGodot();
    return;
  }
  const args = parseArguments(["project", "preview", ...argv]);
  const interactive =
    !hasFlag(args, "json") &&
    process.stdin.isTTY === true &&
    process.stdout.isTTY === true;
  try {
    validateProjectPreviewArguments(args);
    if (args.positionals.length === 0 && !interactive)
      throw Object.assign(
        new Error("A task is required outside an interactive terminal"),
        { code: "goal_required" },
      );
    const selected = await resolvePiHostModel({
      provider: flag(args, "provider", "CHRONORIFT_PI_PROVIDER"),
      model: flag(args, "model", "CHRONORIFT_PI_MODEL"),
      agentDir: flag(args, "agent-dir"),
      interactive,
    });
    const flags = new Map(args.flags);
    flags.set("provider", selected.provider);
    flags.set("model", selected.model);
    if (!flags.has("thinking")) flags.set("thinking", selected.thinkingLevel);
    let godot = flag(args, "godot-bin", "GODOT_BIN");
    if (godot === undefined) {
      const local = managedGodotBinary(process.cwd());
      const cached = managedGodotBinary(userToolchainDirectory());
      if (await exists(local)) godot = local;
      else if (await exists(cached)) godot = cached;
      else if (interactive) {
        const prompt = createInterface({
          input: process.stdin,
          output: process.stderr,
        });
        try {
          const answer = await prompt.question(
            "Godot is not installed. Download the supported version to your user cache? [Y/n] ",
          );
          if (answer.trim() !== "" && !/^y(es)?$/iu.test(answer.trim()))
            throw new Error(
              "Godot setup cancelled; use --godot-bin or run crf setup later",
            );
        } finally {
          prompt.close();
        }
        godot = await setupGodot();
      } else
        throw new Error(
          "Godot is not installed. Run crf setup or pass --godot-bin.",
        );
    }
    flags.set("godot-bin", godot);
    await projectPreviewCommand({ ...args, flags }, process.cwd());
  } catch (error) {
    if (!hasFlag(args, "json")) throw error;
    printJson({
      schemaVersion: hasFlag(args, "multi-agent") ? 4 : 2,
      status: "failed",
      goalDelivered: false,
      failureCode:
        error instanceof Error &&
        "code" in error &&
        error.code === "goal_required"
          ? "goal_required"
          : "project_preview_failed",
      failureMessage: (error instanceof Error ? error.message : String(error))
        .replace(/[\r\n\0]/gu, " ")
        .slice(0, 4096),
    });
    process.exitCode = 1;
  }
}
