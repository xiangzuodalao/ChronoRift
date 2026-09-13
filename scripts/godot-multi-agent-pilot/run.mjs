// Four independent Preview Hosts. No model calls during prepare/check.
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { getDefaultResultOrder } from "node:dns";
import { appendFileSync, createWriteStream } from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { cpus, freemem, loadavg } from "node:os";

import { runProjectEnvironmentPreviewV2 } from "../../apps/cli/src/vnext/project-environment-preview.ts";
import { createProjectMultiAgentEnvironment } from "../../apps/cli/src/vnext/project-multi-agent.ts";
import { createNodeAgentWorker } from "../../apps/cli/src/vnext/agent-worker-client.ts";
import {
  checkGn1Preview,
  snapshotGn1Baseline,
} from "../../apps/cli/src/vnext/gn1-preview-check.ts";
import { selectedTreeSha256 } from "../../apps/cli/src/vnext/selected-tree.ts";
import {
  check as checkCity,
  snapshotBaseline as snapshotCity,
} from "../../docs/case-studies/city-builder-preview/check.mjs";
import {
  auditResources,
  GOAL as CITY_GOAL,
} from "../../docs/case-studies/city-builder-preview/run.mjs";
import { runVNextPiTurnWithSdk } from "../../packages/pi-harness/src/index.ts";
import {
  ModelRuntime,
  getAgentDir,
} from "../../packages/pi-harness/node_modules/@earendil-works/pi-coding-agent/dist/index.js";

const execFileAsync = promisify(execFile);
export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ENTRY = fileURLToPath(import.meta.url);
export const CONFIG = Object.freeze({
  provider: "openai-codex",
  model: "gpt-5.6-luna",
  thinkingLevel: "max",
  timeoutMs: 1_200_000,
  sharedToolCallLimit: 256,
  maxAgents: 3,
  dnsOrder: "ipv4first",
  collaborationVersion: 2,
  workspaceMode: "shared",
});
export const PILOT_SPAWN_POLICY = Object.freeze({
  maxCreatedAgents: 3,
  maxDepth: 1,
  lockedRuntime: Object.freeze({
    provider: CONFIG.provider,
    model: CONFIG.model,
    thinkingLevel: CONFIG.thinkingLevel,
  }),
});
export function assertPilotWorkerRuntime(configuration) {
  for (const [key, value] of Object.entries(PILOT_SPAWN_POLICY.lockedRuntime))
    if (configuration[key] !== value)
      throw new Error(
        `Pilot worker ${key} differs from the locked configuration`,
      );
}
export const GOALS = Object.freeze({
  gn1: "A falling platform can activate while the player is still outside its visible width. Investigate the project, make the smallest appropriate fix, and validate the candidate. You choose the investigation, edit, and validation strategy.",
  city: CITY_GOAL,
});
export const MULTI_APPENDIX =
  "本次使用一个 Root 和三个 worker。Root 开始调查时先创建恰好三个 worker，并让三个初始任务并行开展；由你决定分工和后续协作。全组只使用这三个 worker，不创建替代或更下层的代理。所有代理共享同一个私有候选工作区，修改立即相互可见；协调同文件修改。Root 负责在交付前收齐需要的结果，并在最终共享候选上重新运行验证。";
const IDS = ["gn1-single", "gn1-multi", "city-single", "city-multi"];
const REFERENCES = {
  gn1: join(REPO, "docs/case-studies/gn1-preview/candidate.patch"),
  city: join(
    REPO,
    "docs/case-studies/city-builder-preview/chronorift/candidate.patch",
  ),
};
const CHECKERS = {
  gn1: join(REPO, "docs/case-studies/gn1-preview/independent-check.gd"),
  city: join(
    REPO,
    "docs/case-studies/city-builder-preview/independent-check.gd",
  ),
};
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const save = (path, data) =>
  writeFile(path, JSON.stringify(data, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
const json = async (path) => JSON.parse(await readFile(path, "utf8"));
const within = (parent, child) =>
  child === parent || child.startsWith(parent + sep);
const git = async (project, ...args) =>
  (
    await execFileAsync("git", ["-C", project, ...args], {
      maxBuffer: 4 * 1024 * 1024,
    })
  ).stdout.trim();
export function argumentsFor(args) {
  const [mode, ...rest] = args;
  if (!["prepare", "run", "arm", "check", "evaluate"].includes(mode))
    throw new Error("Expected prepare|run|evaluate (or internal arm|check)");
  const values = { mode };
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i],
      value = rest[i + 1];
    if (
      ![
        "--output",
        "--gn1",
        "--city",
        "--godot-bin",
        "--id",
        "--project",
        "--case",
        "--patch",
      ].includes(key) ||
      values[key.slice(2)] !== undefined ||
      !value ||
      value.startsWith("--") ||
      value.includes("\0")
    )
      throw new Error("Invalid or duplicate pilot argument");
    values[key.slice(2)] = value;
  }
  if (!values.output) throw new Error("--output is required");
  values.output = resolve(values.output);
  return values;
}
function nodeArgs(...args) {
  return [
    "--dns-result-order=ipv4first",
    "--import",
    join(REPO, "node_modules/tsx/dist/loader.mjs"),
    ENTRY,
    ...args,
  ];
}
async function sourceIdentity(project, kind) {
  const files = await (kind === "gn1"
    ? snapshotGn1Baseline(project)
    : snapshotCity(project));
  return {
    commit: await git(project, "rev-parse", "HEAD"),
    tree: await git(project, "rev-parse", "HEAD^{tree}"),
    sha256: selectedTreeSha256(
      files.map((f) => ({
        relativePath: f.relativePath,
        mode: f.executable ? "100755" : "100644",
        content: f.bytes,
      })),
    ),
  };
}
async function productIdentity() {
  const files = (
    await git(
      REPO,
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      "apps",
      "packages",
      "scripts",
      "package.json",
      "pnpm-lock.yaml",
    )
  )
    .split("\n")
    .filter(Boolean);
  const hashes = await Promise.all(
    [...new Set(files)].sort().map(async (path) => {
      try {
        return { path, sha256: sha(await readFile(join(REPO, path))) };
      } catch (error) {
        if (error.code === "ENOENT") return { path, deleted: true };
        throw error;
      }
    }),
  );
  return {
    commit: await git(REPO, "rev-parse", "HEAD"),
    files: hashes,
    sha256: sha(JSON.stringify(hashes)),
  };
}
async function modelIdentity() {
  const agentDir = getAgentDir();
  const runtime = await ModelRuntime.create({
    allowModelNetwork: false,
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
  });
  const model = runtime.getModel(CONFIG.provider, CONFIG.model);
  if (!model || !runtime.hasConfiguredAuth(CONFIG.provider))
    throw new Error("Pinned model or Host authentication unavailable");
  // Deliberately do not serialize provider headers, authentication or the full model object.
  const {
    id,
    provider,
    api,
    cost,
    contextWindow,
    maxTokens,
    reasoning,
    thinkingLevelMap,
  } = model;
  const metadata = {
    id,
    provider,
    api,
    cost,
    contextWindow,
    maxTokens,
    reasoning,
    thinkingLevelMap,
  };
  return {
    agentDir,
    metadata,
    sha256: sha(JSON.stringify(metadata)),
    costMeaning: "SDK estimate; actual provider bill unavailable",
  };
}
async function invokeCheck(kind, project, godotBin, patch, output) {
  const started = Date.now();
  let processResult;
  try {
    const result = await execFileAsync(
      process.execPath,
      nodeArgs(
        "check",
        "--case",
        kind,
        "--project",
        project,
        "--godot-bin",
        godotBin,
        "--patch",
        patch,
        "--output",
        output,
      ),
      {
        cwd: REPO,
        timeout: 240_000,
        maxBuffer: 1024 * 1024,
        killSignal: "SIGTERM",
      },
    );
    processResult = {
      exitCode: 0,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (error) {
    processResult = {
      exitCode: typeof error.code === "number" ? error.code : null,
      signal: error.signal ?? null,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
      error: error.message,
    };
  }
  const result = await json(join(output, "result.json")).catch(() => null);
  await save(join(output, "invocation.json"), {
    ...processResult,
    durationMs: Date.now() - started,
  });
  return {
    output,
    exitCode: processResult.exitCode,
    outcome:
      kind === "gn1"
        ? (result?.candidate?.outcome ?? result?.outcome ?? "requires_review")
        : (result?.assessment?.outcome ?? "requires_review"),
  };
}
async function checker(options) {
  if (
    !["gn1", "city"].includes(options.case) ||
    !options.project ||
    !options.patch ||
    !options["godot-bin"]
  )
    throw new Error("Incomplete checker arguments");
  if (options.case === "city") {
    const result = await checkCity({
      project: resolve(options.project),
      candidatePatch: resolve(options.patch),
      godotBin: resolve(options["godot-bin"]),
      output: options.output,
    });
    process.exitCode = result.exitCode;
  } else {
    await mkdir(options.output, { mode: 0o700 });
    const result = await checkGn1Preview({
      project: resolve(options.project),
      candidatePatch: resolve(options.patch),
      godotBin: resolve(options["godot-bin"]),
    });
    const record = await json(join(result.directory, "result.json"));
    await save(join(options.output, "result.json"), {
      ...record,
      originalDirectory: result.directory,
    });
    process.exitCode = result.exitCode;
  }
}
async function prepare(options) {
  if (
    process.version !== "v22.23.1" ||
    getDefaultResultOrder() !== CONFIG.dnsOrder
  )
    throw new Error("Use Node 22.23.1 with --dns-result-order=ipv4first");
  const gn1 = await realpath(options.gn1),
    city = await realpath(options.city),
    godotBin = await realpath(options["godot-bin"]);
  const parent = await realpath(dirname(options.output));
  const output = join(parent, options.output.split(sep).at(-1));
  for (const root of [REPO, gn1, city])
    if (within(root, output) || within(output, root))
      throw new Error("Output must not overlap source checkouts");
  await mkdir(output, { mode: 0o700 });
  const manifest = {
    schemaVersion: 1,
    preparedAt: new Date().toISOString(),
    config: CONFIG,
    spawnPolicy: PILOT_SPAWN_POLICY,
    goals: GOALS,
    multiAppendix: MULTI_APPENDIX,
    projects: { gn1, city },
    source: {
      gn1: await sourceIdentity(gn1, "gn1"),
      city: await sourceIdentity(city, "city"),
    },
    product: await productIdentity(),
    model: await modelIdentity(),
    node: process.version,
    piVersion: (
      await json(
        join(
          REPO,
          "packages/pi-harness/node_modules/@earendil-works/pi-coding-agent/package.json",
        ),
      )
    ).version,
    srtVersion: (
      await json(
        join(
          REPO,
          "apps/cli/node_modules/@anthropic-ai/sandbox-runtime/package.json",
        ),
      )
    ).version,
    godotBin,
    godotSha256: sha(await readFile(godotBin)),
    checkers: {
      gn1: sha(await readFile(CHECKERS.gn1)),
      city: sha(await readFile(CHECKERS.city)),
    },
  };
  await save(join(output, "manifest.json"), manifest);
  const controls = join(output, "controls");
  await mkdir(controls, { mode: 0o700 });
  const empty = join(controls, "empty.patch");
  await writeFile(empty, "", { flag: "wx", mode: 0o600 });
  const results = [];
  // At most two checker processes at once, never multiple SRT controllers in one process.
  for (let repeat = 1; repeat <= 3; repeat++) {
    for (const variant of ["baseline", "reference"]) {
      results.push(
        ...(await Promise.all(
          ["gn1", "city"].map(async (kind) => ({
            kind,
            variant,
            repeat,
            ...(await invokeCheck(
              kind,
              manifest.projects[kind],
              godotBin,
              variant === "baseline" ? empty : REFERENCES[kind],
              join(controls, kind + "-" + variant + "-" + repeat),
            )),
          })),
        )),
      );
    }
  }
  // Deliberately broken reference variants, never visible to model Sessions.
  const cityOriginal = await readFile(join(city, "scripts/builder.gd"), "utf8");
  const cityFixed = cityOriginal
    .replace(
      "func action_structure_toggle():",
      "func action_structure_toggle():\n\tvar previous_index := index\n",
    )
    .replace(
      "\tupdate_structure()\n\n# Update the structure",
      "\tif index != previous_index:\n\t\tupdate_structure()\n\n# Update the structure",
    );
  const gn1Original = await readFile(
    join(gn1, "components/platform/platform.gd"),
    "utf8",
  );
  const variants = [
    {
      kind: "gn1",
      name: "wrong-width",
      path: "components/platform/platform.gd",
      before: gn1Original,
      after: gn1Original.replace(
        "width * TILE_WIDTH, _area_collision_shape.shape.size[1]",
        "TILE_WIDTH, _area_collision_shape.shape.size[1]",
      ),
    },
    {
      kind: "city",
      name: "missing-initialization",
      path: "scripts/builder.gd",
      before: cityOriginal,
      after: cityFixed.replace(
        "\tupdate_structure()",
        "\tpass # missing initialization",
      ),
    },
    {
      kind: "city",
      name: "missing-switch",
      path: "scripts/builder.gd",
      before: cityOriginal,
      after: cityFixed.replace(
        "\tif index != previous_index:\n\t\tupdate_structure()",
        "\tif index != previous_index:\n\t\tpass # missing switch update",
      ),
    },
  ];
  for (const variant of variants) {
    if (variant.after === variant.before)
      throw new Error("Negative control did not mutate source");
    // difflib runs on Host-owned control strings; candidate code is only executed in SRT.
    const patch = (
      await execFileAsync(
        "python3",
        [
          "-c",
          "import sys,json,difflib;x=json.loads(sys.argv[1]);print(''.join(difflib.unified_diff(x['before'].splitlines(True),x['after'].splitlines(True),fromfile='a/'+x['path'],tofile='b/'+x['path'])),end='')",
          JSON.stringify({
            before: variant.before,
            after: variant.after,
            path: variant.path,
          }),
        ],
        { maxBuffer: 1024 * 1024 },
      )
    ).stdout;
    const path = join(controls, variant.name + ".patch");
    await writeFile(path, patch, { flag: "wx", mode: 0o600 });
    results.push({
      kind: variant.kind,
      variant: variant.name,
      repeat: 1,
      ...(await invokeCheck(
        variant.kind,
        manifest.projects[variant.kind],
        godotBin,
        path,
        join(controls, variant.kind + "-" + variant.name),
      )),
    });
  }
  const passed = results.every(
    (r) =>
      r.outcome ===
        (r.variant === "reference" ? "passed" : "assertions_failed") &&
      r.exitCode === (r.variant === "reference" ? 0 : 1),
  );
  await save(join(output, "controls.json"), {
    passed,
    results,
    modelInvoked: false,
  });
  console.log(
    JSON.stringify({ output, controlsPassed: passed, checks: results.length }),
  );
  if (!passed) process.exitCode = 1;
}
const eventTypes = new Set([
  "agent_start",
  "agent_end",
  "turn_start",
  "turn_end",
  "message_end",
  "tool_execution_start",
  "tool_execution_end",
  "auto_retry_start",
  "auto_retry_end",
  "auto_compaction_start",
  "auto_compaction_end",
]);
async function processSample(rootPids) {
  const processes = [];
  for (const pid of (await readdir("/proc")).filter((name) =>
    /^\d+$/u.test(name),
  )) {
    try {
      const text = await readFile("/proc/" + pid + "/stat", "utf8");
      const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
      processes.push({
        pid: Number(pid),
        parentPid: Number(fields[1]),
        startTicks: fields[19],
      });
    } catch {
      /* A process may exit between directory enumeration and reading. */
    }
  }
  const selected = new Set(rootPids);
  let changed = true;
  while (changed) {
    changed = false;
    for (const process of processes)
      if (selected.has(process.parentPid) && !selected.has(process.pid)) {
        selected.add(process.pid);
        changed = true;
      }
  }
  const records = [];
  for (const process of processes.filter((p) => selected.has(p.pid))) {
    try {
      const args = (
        await readFile("/proc/" + process.pid + "/cmdline", "utf8")
      ).split("\0");
      const role = rootPids.includes(process.pid)
        ? "root"
        : args.some((a) => /agent-worker\.(?:ts|js)$/u.test(a))
          ? "worker"
          : /godot/iu.test(args[0]?.split("/").at(-1) ?? "")
            ? "godot"
            : "other";
      records.push({
        ...process,
        role,
        dnsOrderArgument:
          args.find((a) =>
            /^--dns-result-order=(?:ipv4first|ipv6first|verbatim)$/u.test(a),
          ) ?? null,
      });
    } catch {
      /* Do not retain command lines or environment variables. */
    }
  }
  return records;
}
async function runArm(options) {
  if (!IDS.includes(options.id) || !process.send)
    throw new Error("arm requires trusted parent IPC and known ID");
  const manifest = await json(join(options.output, "manifest.json"));
  const [kind, arm] = options.id.split("-");
  const output = join(options.output, options.id);
  await mkdir(output, { mode: 0o700 });
  if (getDefaultResultOrder() !== "ipv4first")
    throw new Error("Root DNS order differs");
  const identity = await sourceIdentity(manifest.projects[kind], kind);
  if (JSON.stringify(identity) !== JSON.stringify(manifest.source[kind]))
    throw new Error("Source changed after controls");
  const append = (file, data) =>
    appendFileSync(
      join(output, file),
      JSON.stringify({ receivedAt: new Date().toISOString(), ...data }) + "\n",
      { mode: 0o600 },
    );
  const started = new Promise((resolveStart, rejectStart) => {
    process.once("message", (message) =>
      message?.type === "start"
        ? resolveStart()
        : rejectStart(new Error("Unexpected start message")),
    );
    process.once("disconnect", () =>
      rejectStart(new Error("Parent disconnected before start")),
    );
  });
  process.send({ type: "ready", id: options.id });
  await started;
  const startTime = Date.now(),
    startedAt = new Date(startTime).toISOString();
  const cancellation = new AbortController();
  const onSignal = () => cancellation.abort();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  process.once("disconnect", onSignal);
  let investigationStartedAt = null,
    investigationFinishedAt = null,
    preview = null,
    failure = null,
    workerIndex = 0;
  await save(join(output, "start.json"), {
    startedAt,
    pid: process.pid,
    dnsOrder: getDefaultResultOrder(),
    id: options.id,
    source: identity,
  });
  try {
    preview = await runProjectEnvironmentPreviewV2(
      {
        projectPath: manifest.projects[kind],
        provider: CONFIG.provider,
        model: CONFIG.model,
        thinkingLevel: CONFIG.thinkingLevel,
        timeoutMs: CONFIG.timeoutMs,
        agentDir: manifest.model.agentDir,
        stateRoot: join(output, "state"),
        godotBin: manifest.godotBin,
        goal: GOALS[kind] + (arm === "multi" ? "\n\n" + MULTI_APPENDIX : ""),
        interactive: false,
        ...(arm === "multi"
          ? {
              multiAgent: {
                maxAgents: 3,
                workerProvider: CONFIG.provider,
                workerModel: CONFIG.model,
                workerThinking: CONFIG.thinkingLevel,
              },
            }
          : {}),
      },
      {
        createMultiAgentEnvironment: (configuration) =>
          createProjectMultiAgentEnvironment({
            ...configuration,
            spawnPolicy: PILOT_SPAWN_POLICY,
            workerFactory: async (workerOptions) => {
              assertPilotWorkerRuntime(workerOptions.configuration);
              const index = ++workerIndex;
              const resources = await auditResources(
                workerOptions.configuration,
                REPO,
              );
              await save(
                join(output, "worker-" + index + "-configuration.json"),
                {
                  resources,
                  configuration: workerOptions.configuration,
                  expectedDnsOrder: getDefaultResultOrder(),
                },
              );
              return createNodeAgentWorker({
                ...workerOptions,
                onMessage: (message) => {
                  append("worker-events.jsonl", { worker: index, message });
                  workerOptions.onMessage(message);
                },
              });
            },
          }),
        runPiTurn: async (piOptions) => {
          const resources = await auditResources(piOptions, REPO);
          await save(join(output, "root-configuration.json"), {
            resources,
            tools: piOptions.tools.map((t) => t.name),
            environmentProfile: piOptions.environmentProfile,
            additionalEnvironmentInstructions:
              piOptions.additionalEnvironmentInstructions,
            dnsOrder: getDefaultResultOrder(),
          });
          investigationStartedAt = new Date().toISOString();
          append("lifecycle.jsonl", { event: "investigation_start" });
          const result = await runVNextPiTurnWithSdk({
            ...piOptions,
            signal: cancellation.signal,
            onEvent: (event) => {
              if (eventTypes.has(event.type))
                append("root-events.jsonl", { event });
            },
          });
          investigationFinishedAt = new Date().toISOString();
          append("lifecycle.jsonl", { event: "investigation_end" });
          await save(join(output, "root-result.json"), result);
          return result;
        },
      },
    );
    await save(join(output, "preview.json"), preview);
  } catch (error) {
    failure = String(error);
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    process.off("disconnect", onSignal);
    const after = await sourceIdentity(manifest.projects[kind], kind).catch(
      () => null,
    );
    await save(join(output, "completion.json"), {
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startTime,
      investigationStartedAt,
      investigationFinishedAt,
      failure,
      status: preview?.status ?? "failed",
      sourceCheckoutUnchanged:
        JSON.stringify(after) === JSON.stringify(identity),
    });
    if (process.connected) process.disconnect();
  }
  if (failure || preview?.status !== "completed") process.exitCode = 1;
}
async function runFour(options) {
  const manifest = await json(join(options.output, "manifest.json"));
  if (!(await json(join(options.output, "controls.json"))).passed)
    throw new Error("Offline controls have not passed");
  if (
    JSON.stringify(CONFIG) !== JSON.stringify(manifest.config) ||
    JSON.stringify(PILOT_SPAWN_POLICY) !==
      JSON.stringify(manifest.spawnPolicy) ||
    manifest.product.sha256 !== (await productIdentity()).sha256
  )
    throw new Error(
      "Product/configuration changed since prepare; create a new preparation",
    );
  if (manifest.model.sha256 !== (await modelIdentity()).sha256)
    throw new Error("Model metadata changed");
  for (const kind of ["gn1", "city"])
    if (sha(await readFile(CHECKERS[kind])) !== manifest.checkers[kind])
      throw new Error("Checker changed");
  // Claim once before starting any Host. This file makes accidental live reruns fail closed.
  await save(join(options.output, "live-start.json"), {
    startedAt: new Date().toISOString(),
    ids: IDS,
    config: CONFIG,
  });
  const children = [];
  const exits = [];
  const ready = [];
  const terminate = () => {
    for (const child of children)
      if (child.exitCode === null) child.kill("SIGTERM");
  };
  process.once("SIGINT", terminate);
  process.once("SIGTERM", terminate);
  for (const id of IDS) {
    const log = createWriteStream(join(options.output, id + "-host.log"), {
      flags: "wx",
      mode: 0o600,
    });
    const child = spawn(
      process.execPath,
      nodeArgs("arm", "--id", id, "--output", options.output),
      { cwd: REPO, stdio: ["ignore", "pipe", "pipe", "ipc"] },
    );
    children.push(child);
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    exits.push(
      new Promise((resolveExit) => {
        child.once("error", (error) =>
          resolveExit({ id, error: String(error), exitCode: null }),
        );
        child.once("exit", (exitCode, signal) => {
          log.end();
          resolveExit({
            id,
            exitCode,
            signal,
            finishedAt: new Date().toISOString(),
          });
        });
      }),
    );
    ready.push(
      new Promise((resolveReady, rejectReady) => {
        child.once("message", (message) =>
          message?.type === "ready" && message.id === id
            ? resolveReady()
            : rejectReady(new Error("Unexpected readiness message")),
        );
        child.once("exit", () =>
          rejectReady(new Error(id + " exited before readiness")),
        );
        child.once("error", rejectReady);
      }),
    );
  }
  const observed = new Map();
  let sampling = false;
  const sample = async () => {
    if (sampling) return;
    sampling = true;
    try {
      const processes = await processSample(children.map((c) => c.pid));
      for (const process of processes) observed.set(process.pid, process);
      appendFileSync(
        join(options.output, "host-samples.jsonl"),
        JSON.stringify({
          at: new Date().toISOString(),
          freeMemoryBytes: freemem(),
          loadAverage: loadavg(),
          cpuTimes: cpus().map((c) => c.times),
          processes,
        }) + "\n",
        { mode: 0o600 },
      );
    } finally {
      sampling = false;
    }
  };
  const monitor = setInterval(() => {
    void sample().catch((error) => {
      appendFileSync(
        join(options.output, "monitor-errors.log"),
        String(error) + "\n",
        { mode: 0o600 },
      );
    });
  }, 5_000);
  let timer, watchdog, killTimer;
  try {
    await Promise.race([
      Promise.all(ready),
      new Promise((_, rejectReady) => {
        timer = setTimeout(
          () => rejectReady(new Error("Host readiness timed out")),
          120_000,
        );
      }),
    ]);
    clearTimeout(timer);
    const releasedAt = new Date().toISOString();
    for (const child of children) child.send({ type: "start" });
    await save(join(options.output, "barrier.json"), {
      releasedAt,
      rootPids: children.map((c) => c.pid),
    });
    console.log("Started all four live Hosts: " + IDS.join(", "));
    watchdog = setTimeout(() => {
      appendFileSync(
        join(options.output, "watchdog.jsonl"),
        JSON.stringify({
          at: new Date().toISOString(),
          action: "SIGTERM",
          reason:
            "20-minute investigation plus 3-minute Host overhead allowance exhausted",
        }) + "\n",
        { mode: 0o600 },
      );
      terminate();
      killTimer = setTimeout(() => {
        for (const child of children)
          if (child.exitCode === null && child.signalCode === null)
            child.kill("SIGKILL");
      }, 30_000);
    }, CONFIG.timeoutMs + 180_000);
    const results = await Promise.all(exits);
    const remaining = [];
    for (const process of observed.values()) {
      try {
        const stat = await readFile("/proc/" + process.pid + "/stat", "utf8");
        if (
          stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ===
          process.startTicks
        )
          remaining.push(process);
      } catch {
        /* Already cleaned up. */
      }
    }
    await save(join(options.output, "live-completion.json"), {
      results,
      finishedAt: new Date().toISOString(),
      observedProcesses: [...observed.values()],
      survivingObservedProcesses: remaining,
    });
    console.log(JSON.stringify(results));
  } catch (error) {
    terminate();
    await save(join(options.output, "live-start-failure.json"), {
      error: String(error),
    });
    throw error;
  } finally {
    clearTimeout(timer);
    clearTimeout(watchdog);
    clearTimeout(killTimer);
    clearInterval(monitor);
    process.off("SIGINT", terminate);
    process.off("SIGTERM", terminate);
  }
}
async function evaluate(options) {
  const manifest = await json(join(options.output, "manifest.json"));
  await json(join(options.output, "live-completion.json"));
  const output = join(options.output, "evaluation");
  await mkdir(output, { mode: 0o700 });
  const results = [];
  for (let repeat = 1; repeat <= 2; repeat++) {
    for (const kind of ["gn1", "city"]) {
      results.push(
        ...(await Promise.all(
          ["single", "multi"].map(async (arm) => {
            const id = kind + "-" + arm;
            const preview = await json(
              join(options.output, id, "preview.json"),
            ).catch(() => null);
            const patch = preview?.candidatePatch;
            if (!patch)
              return {
                id,
                repeat,
                outcome: "requires_review",
                reason: "Missing final Root patch",
              };
            if (!within(join(options.output, id), resolve(patch.path)))
              throw new Error("Candidate patch escapes its Run");
            const bytes = await readFile(patch.path);
            if (
              sha(bytes) !== patch.sha256 ||
              bytes.length !== patch.byteLength ||
              patch.roundTripVerified !== true
            )
              throw new Error("Final Root patch mismatch");
            return {
              id,
              repeat,
              patchSha256: patch.sha256,
              ...(await invokeCheck(
                kind,
                manifest.projects[kind],
                manifest.godotBin,
                patch.path,
                join(output, id + "-" + repeat),
              )),
            };
          }),
        )),
      );
    }
  }
  await save(join(output, "results.json"), results);
  console.log(JSON.stringify(results));
}
if (process.argv[1] && resolve(process.argv[1]) === ENTRY) {
  try {
    const options = argumentsFor(process.argv.slice(2));
    await { prepare, run: runFour, arm: runArm, check: checker, evaluate }[
      options.mode
    ](options);
  } catch (error) {
    console.error(String(error));
    process.exitCode = 2;
  }
}
