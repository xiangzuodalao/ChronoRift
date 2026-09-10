// Case-local composition of the existing Preview and genuine Pi SDK. No alternate Loop.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { prepareGodotInspectionCandidate } from "../../../apps/cli/src/vnext/godot-inspection-source.ts";
import { selectedTreeSha256 } from "../../../apps/cli/src/vnext/selected-tree.ts";
import { runProjectEnvironmentPreviewV2 } from "../../../apps/cli/src/vnext/project-environment-preview.ts";
import {
  runVNextPiTurnWithSdk,
  VNEXT_CODING_ENVIRONMENT_APPENDIX,
} from "../../../packages/pi-harness/src/index.ts";
import {
  DefaultResourceLoader,
  SettingsManager,
} from "../../../packages/pi-harness/node_modules/@earendil-works/pi-coding-agent/dist/index.js";

export const GOAL =
  "这个自动充能演示有时会短暂显示超过满容量的数值，稍后检查又正常。请调查并做最小合理修复，保证充能过程中始终 0 <= charge <= capacity，同时保留自动放电、按配置速率重新充能和满电保持行为；容量与速率可以配置。自行选择调查、修改和验证方式，允许添加日志或测试，并说明实际验证结果及未覆盖部分。";
export const CONFIG = Object.freeze({
  provider: "openai-codex",
  model: "gpt-5.6-luna",
  thinkingLevel: "max",
  timeoutMs: 600000,
  toolCallLimit: 256,
  freshSessionAttempts: 1,
  armOrder: ["A", "B"],
});
const codingNames = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const execFileAsync = promisify(execFile);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const save = (path, value) =>
  writeFile(path, JSON.stringify(value, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
const contains = (root, path) => path === root || path.startsWith(root + sep);
const metadata = (tool) =>
  Object.fromEntries(
    Object.entries(tool).filter(([, value]) => typeof value !== "function"),
  );

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

// Both arms receive the same prose; only the advertised watch ToolDefinition differs.
export function armOptions(options, arm) {
  if (!["A", "B"].includes(arm)) throw new Error("Unknown arm");
  const sharedInstructions = options.additionalEnvironmentInstructions
    .split("\n")
    .filter((line) => !line.startsWith("- game_watch "))
    .join("\n");
  return {
    ...options,
    tools:
      arm === "A"
        ? options.tools.filter((tool) => tool.name !== "game_watch")
        : options.tools,
    additionalEnvironmentInstructions: sharedInstructions,
  };
}

export function parseArguments(args) {
  const values = new Map();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i],
      value = args[i + 1];
    if (
      !["--project", "--godot-bin", "--output"].includes(key) ||
      values.has(key) ||
      !value ||
      value.startsWith("--") ||
      value.includes("\0")
    )
      throw new Error(
        "Expected --project PATH --godot-bin PATH --output NEW_DIRECTORY; invokes two real Agent sessions",
      );
    values.set(key, value);
  }
  if (values.size !== 3) throw new Error("All arguments are required");
  return {
    project: resolve(values.get("--project")),
    godotBin: resolve(values.get("--godot-bin")),
    output: resolve(values.get("--output")),
  };
}

export async function runPair(args) {
  const request = parseArguments(args);
  const caseDirectory = dirname(fileURLToPath(import.meta.url));
  const repo = await realpath(resolve(caseDirectory, "../../.."));
  const project = await realpath(request.project);
  const output = join(
    await realpath(dirname(request.output)),
    basename(request.output),
  );
  if (
    contains(repo, output) ||
    contains(project, output) ||
    contains(repo, project)
  )
    throw new Error(
      "Use separate source checkout and output outside ChronoRift",
    );
  const git = async (cwd, ...args) =>
    (
      await execFileAsync("git", ["-C", cwd, ...args], {
        maxBuffer: 1024 * 1024,
      })
    ).stdout.trim();
  assert.equal(await git(project, "status", "--porcelain"), "");
  assert.equal(
    await git(
      repo,
      "status",
      "--porcelain",
      "--untracked-files=all",
      "--",
      "apps",
      "packages",
      "pnpm-lock.yaml",
      "package.json",
    ),
    "",
    "Use committed, unchanged product source",
  );
  await mkdir(output, { mode: 0o700 });
  const sourceCommit = await git(project, "rev-parse", "HEAD"),
    sourceTree = await git(project, "rev-parse", "HEAD^{tree}");
  const implementation = await Promise.all(
    ["run.mjs", "witness.mjs", "check.mjs", "independent-check.gd"].map(
      async (path) => ({
        path,
        sha256: sha256(await readFile(join(caseDirectory, path))),
      }),
    ),
  );
  const manifest = {
    schemaVersion: 1,
    ...CONFIG,
    prompt: GOAL,
    promptSha256: sha256(GOAL),
    sourceCommit,
    sourceTree,
    chronoriftCommit: await git(repo, "rev-parse", "HEAD"),
    implementation,
    node: process.version,
    startedAt: new Date().toISOString(),
    intervention:
      "A retains coding+launch/query/stop; B adds only game_watch metadata and execution. Shared user prompt and environment prose are identical.",
    selection:
      "One deliberately simple authored recurring transient; not a random external project. One pair, no selected reruns or human follow-up.",
    independentAcceptance:
      "Frozen before model calls; checker and developer controls are outside candidates and never passed to Pi. Agent text is not acceptance.",
  };
  await save(join(output, "manifest.json"), manifest);
  const outcomes = [];
  let configurationA;
  for (const arm of CONFIG.armOrder) {
    assert.equal(await git(project, "rev-parse", "HEAD"), sourceCommit);
    assert.equal(await git(project, "rev-parse", "HEAD^{tree}"), sourceTree);
    assert.equal(await git(project, "status", "--porcelain"), "");
    const directory = join(output, arm);
    await mkdir(directory, { mode: 0o700 });
    const agentDir = join(directory, "agent");
    await mkdir(agentDir, { mode: 0o700 });
    const eventsPath = join(directory, "events.jsonl");
    await writeFile(eventsPath, "", { flag: "wx", mode: 0o600 });
    const startedAt = new Date().toISOString(),
      started = performance.now();
    await save(join(directory, "invocation.json"), {
      arm,
      startedAt,
      ...CONFIG,
      sourceCommit,
      sourceTree,
      prompt: GOAL,
    });
    let preview = null,
      invocationFailure = null,
      loopCalls = 0;
    try {
      preview = await runProjectEnvironmentPreviewV2(
        {
          projectPath: project,
          provider: CONFIG.provider,
          model: CONFIG.model,
          thinkingLevel: CONFIG.thinkingLevel,
          goal: GOAL,
          stateRoot: join(directory, "state"),
          godotBin: request.godotBin,
          agentDir,
          timeoutMs: CONFIG.timeoutMs,
          interactive: false,
        },
        {
          runPiTurn: async (options) => {
            assert.equal(++loopCalls, 1);
            assert.equal(options.prompt, GOAL);
            assert.equal(options.timeoutMs, CONFIG.timeoutMs);
            const forwarded = armOptions(options, arm);
            const expected = [
              ...codingNames,
              "game_launch",
              "game_query",
              ...(arm === "B" ? ["game_watch"] : []),
              "game_stop",
            ];
            assert.deepEqual(
              forwarded.tools.map((t) => t.name),
              expected,
            );
            const resources = await auditResources(forwarded, repo);
            const candidateSource = await prepareGodotInspectionCandidate(
              forwarded.resourceWorkspaceDirectory,
            );
            const candidateInitialSourceSha256 = selectedTreeSha256(
              candidateSource.sourceFiles.map((file) => ({
                relativePath: file.relativePath,
                mode: file.executable ? "100755" : "100644",
                content: file.bytes,
              })),
            );
            const configuration = {
              candidateInitialSourceSha256,
              resources,
              activeTools: expected,
              toolDefinitions: forwarded.tools.map(metadata),
              environmentProfile: forwarded.environmentProfile,
              codingAppendix: VNEXT_CODING_ENVIRONMENT_APPENDIX,
              additionalEnvironmentInstructions:
                forwarded.additionalEnvironmentInstructions,
            };
            await save(
              join(directory, "session-configuration.json"),
              configuration,
            );
            if (arm === "A") configurationA = configuration;
            else {
              assert.ok(
                configurationA,
                "A configuration must be recorded before B",
              );
              assert.equal(
                configuration.candidateInitialSourceSha256,
                configurationA.candidateInitialSourceSha256,
                "Initial candidate bytes must match",
              );
              assert.deepEqual(
                configuration.resources,
                configurationA.resources,
                "Pi context/skills/prompts must match",
              );
              assert.equal(
                configuration.additionalEnvironmentInstructions,
                configurationA.additionalEnvironmentInstructions,
              );
              assert.deepEqual(
                configuration.toolDefinitions.filter(
                  (t) => t.name !== "game_watch",
                ),
                configurationA.toolDefinitions,
              );
            }
            const result = await runVNextPiTurnWithSdk({
              ...forwarded,
              onEvent: (event) => {
                appendFileSync(
                  eventsPath,
                  JSON.stringify({
                    receivedAt: new Date().toISOString(),
                    elapsedMs: performance.now() - started,
                    event,
                  }) + "\n",
                  { mode: 0o600 },
                );
                if (
                  event.type === "tool_execution_start" ||
                  event.type === "tool_execution_end"
                )
                  process.stdout.write(
                    JSON.stringify({
                      arm,
                      event: event.type,
                      tool: event.toolName,
                      ...(event.type === "tool_execution_end"
                        ? { isError: event.isError }
                        : {}),
                    }) + "\n",
                  );
              },
            });
            await save(join(directory, "pi-result.json"), result);
            return result;
          },
        },
      );
      await save(join(directory, "preview-result.json"), preview);
    } catch (error) {
      invocationFailure =
        error instanceof Error
          ? { name: error.name, message: error.message }
          : { message: String(error) };
      await save(join(directory, "invocation-failure.json"), invocationFailure);
    }
    const completion = {
      arm,
      startedAt,
      completedAt: new Date().toISOString(),
      durationMs: performance.now() - started,
      loopCalls,
      status: preview?.status ?? "failed",
      invocationFailure,
      sourceCheckoutUnchanged:
        (await git(project, "status", "--porcelain")) === "",
    };
    await save(join(directory, "completion.json"), completion);
    outcomes.push(completion);
    process.stdout.write(
      JSON.stringify({
        arm,
        status: completion.status,
        durationMs: completion.durationMs,
      }) + "\n",
    );
  }
  await save(join(output, "pair-completion.json"), {
    completedAt: new Date().toISOString(),
    arms: outcomes,
  });
  return { output, arms: outcomes };
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const result = await runPair(process.argv.slice(2));
  console.log(JSON.stringify(result));
  if (result.arms.some((arm) => arm.status !== "completed"))
    process.exitCode = 1;
}
