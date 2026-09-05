// Case-only composition of the existing Preview. Run with the repository's tsx.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { runProjectEnvironmentPreviewV2 } from "../../../apps/cli/src/vnext/project-environment-preview.ts";
import {
  runVNextPiTurnWithSdk,
  VNEXT_CODING_ENVIRONMENT_APPENDIX,
} from "../../../packages/pi-harness/src/index.ts";
import {
  DefaultResourceLoader,
  SettingsManager,
} from "../../../packages/pi-harness/node_modules/@earendil-works/pi-coding-agent/dist/index.js";

export const SOURCE_COMMIT = "4535092b740b378b700efd9df9e27a631815b84a";
export const GOAL =
  "建筑预览在空闲时似乎反复重建。请调查并作最小合理修复：选中建筑不变时避免重复重建，同时保留初始化显示、前后切换及首尾循环时的正确更新。自行选择调查、修改和验证方式，并说明实际验证结果与未覆盖部分。";
const GAME_TOOLS = new Set(["game_launch", "game_query", "game_stop"]);
const execFileAsync = promisify(execFile);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const save = (path, value) =>
  writeFile(path, JSON.stringify(value, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
const contains = (root, path) => path === root || path.startsWith(root + sep);

export async function resolveOutputDirectory(requested, project, repo) {
  const absolute = resolve(requested);
  const output = join(await realpath(dirname(absolute)), basename(absolute));
  if (contains(project, output) || contains(repo, output))
    throw new Error("Output must be outside both source checkouts");
  return output;
}

// Mirror the installed harness loader without creating a Session or invoking a
// model. An empty agentDir does not disable normal ~/.agents/skills discovery.
export async function auditResources(options, repo) {
  const workspace = await realpath(options.resourceWorkspaceDirectory);
  const repository = await realpath(repo);
  const resourceLoader = new DefaultResourceLoader({
    cwd: workspace,
    agentDir: options.agentDir,
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: true },
      retry: { enabled: true, maxRetries: 2 },
    }),
    noExtensions: true,
    noThemes: true,
    appendSystemPrompt: [
      VNEXT_CODING_ENVIRONMENT_APPENDIX,
      ...(options.additionalEnvironmentInstructions === undefined
        ? []
        : [options.additionalEnvironmentInstructions]),
    ],
  });
  await resourceLoader.reload();
  const identify = async (path, context = false) => {
    const canonical = await realpath(path);
    if (
      contains(repository, canonical) ||
      (context && !contains(workspace, canonical))
    )
      throw new Error(`Unexpected inherited Pi resource: ${canonical}`);
    return { path: canonical, sha256: sha256(await readFile(canonical)) };
  };
  const contexts = await Promise.all(
    resourceLoader
      .getAgentsFiles()
      .agentsFiles.map(({ path }) => identify(path, true)),
  );
  const skills = await Promise.all(
    resourceLoader.getSkills().skills.map(async (skill) => ({
      ...(await identify(skill.filePath)),
      name: skill.name,
      disableModelInvocation: skill.disableModelInvocation,
    })),
  );
  const prompts = await Promise.all(
    resourceLoader
      .getPrompts()
      .prompts.map(({ filePath }) => identify(filePath)),
  );
  const systemPromptSource = resourceLoader.getSystemPromptSource();
  const systemPrompt = systemPromptSource
    ? await identify(systemPromptSource.path)
    : null;
  return { contexts, skills, prompts, systemPrompt };
}

export function armOptions(options, arm) {
  if (arm === "chronorift") return options;
  if (arm !== "coding-only") throw new Error("Unknown arm");
  const forwarded = { ...options };
  delete forwarded.additionalEnvironmentInstructions;
  forwarded.tools = options.tools.filter((tool) => !GAME_TOOLS.has(tool.name));
  return forwarded;
}

function argumentsFor(args) {
  const allowed = new Set(["--arm", "--project", "--godot-bin", "--output"]);
  const values = new Map();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    const value = args[i + 1];
    if (
      !allowed.has(key) ||
      values.has(key) ||
      !value ||
      value.startsWith("--") ||
      value.includes("\0")
    )
      throw new Error(
        "Usage: run.mjs --arm coding-only|chronorift --project PATH --godot-bin PATH --output NEW_DIRECTORY",
      );
    values.set(key, value);
  }
  if (
    values.size !== allowed.size ||
    !["coding-only", "chronorift"].includes(values.get("--arm"))
  )
    throw new Error(
      "All four arguments are required; this command invokes a real model.",
    );
  return values;
}

export async function runCase(args) {
  const values = argumentsFor(args);
  const arm = values.get("--arm");
  const project = await realpath(resolve(values.get("--project")));
  const caseDirectory = dirname(fileURLToPath(import.meta.url));
  const repo = await realpath(resolve(caseDirectory, "../../.."));
  const output = await resolveOutputDirectory(
    values.get("--output"),
    project,
    repo,
  );
  const git = async (...args) =>
    (
      await execFileAsync("git", ["-C", project, ...args], {
        maxBuffer: 1024 * 1024,
      })
    ).stdout.trim();
  if (
    (await git("rev-parse", "HEAD")) !== SOURCE_COMMIT ||
    (await git("status", "--porcelain")) !== ""
  )
    throw new Error("Expected the clean pinned City Builder checkout");
  await mkdir(output, { mode: 0o700 });
  const agentDir = join(output, "empty-agent-resources");
  await mkdir(agentDir, { mode: 0o700 });
  const sourceIdentity = await execFileAsync("git", [
    "-C",
    repo,
    "rev-parse",
    "HEAD",
  ]);
  await execFileAsync("git", [
    "-C",
    repo,
    "diff",
    "--quiet",
    "HEAD",
    "--",
    "apps",
    "packages",
    "pnpm-lock.yaml",
    "package.json",
  ]);
  const productStatus = await execFileAsync("git", [
    "-C",
    repo,
    "status",
    "--porcelain",
    "--untracked-files=all",
    "--",
    "apps",
    "packages",
    "pnpm-lock.yaml",
    "package.json",
  ]);
  if (productStatus.stdout.trim())
    throw new Error(
      "Expected unchanged ChronoRift product source, including untracked files",
    );
  const sourceFiles = await Promise.all(
    [
      "apps/cli/src/vnext/project-environment-preview.ts",
      "apps/cli/src/vnext/godot-inspection-source.ts",
      "apps/cli/src/vnext/candidate-godot-build.ts",
      "packages/pi-harness/src/vnext-session.ts",
    ].map(async (path) => {
      const bytes = await readFile(join(repo, path));
      const blob = createHash("sha1")
        .update(`blob ${bytes.length}\0`)
        .update(bytes)
        .digest("hex");
      const expected = await execFileAsync("git", [
        "-C",
        repo,
        "rev-parse",
        `HEAD:${path}`,
      ]);
      if (blob !== expected.stdout.trim())
        throw new Error(`Source blob differs from HEAD: ${path}`);
      return { path, gitBlob: blob, sha256: sha256(bytes) };
    }),
  );
  const manifest = {
    schemaVersion: 1,
    arm,
    sourceCommit: SOURCE_COMMIT,
    sourceTree: await git("rev-parse", "HEAD^{tree}"),
    chronoriftCommit: sourceIdentity.stdout.trim(),
    chronoriftSourceFiles: sourceFiles,
    runnerSha256: sha256(await readFile(fileURLToPath(import.meta.url))),
    checkerSha256: sha256(
      await readFile(join(caseDirectory, "independent-check.gd")),
    ),
    prompt: GOAL,
    provider: "openai-codex",
    model: "gpt-5.6-luna",
    thinking: "max",
    timeoutMs: 600_000,
    toolCallLimit: 256,
    interactive: false,
    node: process.version,
    startedAt: new Date().toISOString(),
  };
  await save(join(output, "manifest.json"), manifest);
  const start = Date.now();
  const preview = await runProjectEnvironmentPreviewV2(
    {
      projectPath: project,
      provider: manifest.provider,
      model: manifest.model,
      thinkingLevel: manifest.thinking,
      goal: GOAL,
      stateRoot: join(output, "state"),
      godotBin: resolve(values.get("--godot-bin")),
      agentDir,
      timeoutMs: manifest.timeoutMs,
      interactive: false,
    },
    {
      runPiTurn: async (options) => {
        const forwarded = armOptions(options, arm);
        const resources = await auditResources(forwarded, repo);
        await save(join(output, "session-configuration.json"), {
          resources,
          activeTools: forwarded.tools.map((tool) => tool.name),
          environmentProfile: forwarded.environmentProfile,
          additionalEnvironmentInstructions:
            forwarded.additionalEnvironmentInstructions ?? null,
        });
        const result = await runVNextPiTurnWithSdk({
          ...forwarded,
          onEvent: (event) => {
            appendFileSync(
              join(output, "events.jsonl"),
              JSON.stringify({ receivedAt: new Date().toISOString(), event }) +
                "\n",
              { mode: 0o600 },
            );
            if (event.type === "tool_execution_start")
              process.stdout.write(`${arm}: ${event.toolName}\n`);
          },
        });
        await save(join(output, "pi-result.json"), result);
        return result;
      },
    },
  );
  await save(join(output, "preview-result.json"), preview);
  await save(join(output, "completion.json"), {
    completedAt: new Date().toISOString(),
    durationMs: Date.now() - start,
    sourceCheckoutUnchanged: (await git("status", "--porcelain")) === "",
  });
  console.log(
    JSON.stringify({
      arm,
      status: preview.status,
      sourceSha256: preview.sourceSha256,
      output,
    }),
  );
  if (preview.status !== "completed") process.exitCode = 1;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await runCase(process.argv.slice(2));
}
