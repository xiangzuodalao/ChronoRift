// One attempt per arm in a frozen cohort. No model calls during prepare/check.
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

import {
  check as checkMob,
  snapshotBaseline as snapshotMob,
} from "./mob-check.mjs";

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
  collaborationVersion: 3,
  workspaceMode: "worktree",
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
  mob: "Some newly spawned mobs are unexpectedly tilted, which can lead to inconsistent collision and movement behavior. Investigate the project, make the smallest appropriate fix, and validate the candidate. Preserve the intended randomized horizontal spawn direction and speed.",
});
export const MULTI_APPENDIX =
  "本次使用 Adaptive Multi：Root 最多创建三个直接 worker，不强制创建，小任务可以使用零个 worker。只有存在可独立完成、且结果能够替代 Root 后续工作的明确子任务时才委派；不要将同一调查重复交给多个 worker。委派时明确边界、所需证据和交付内容。Worker 完成后用简洁最终答复交付结论、证据和未覆盖项，然后结束当前 turn，不为保持在线而循环 wait_agent；后续工作由 Root 使用 followup_task 启动。Root 利用已有证据整合、修改并在最终共享候选上验证，不完整重复 worker 已完成且有证据的调查。最小修复通过相关最终候选检查后应结束并说明剩余限制；只有出现实际失败、明确未覆盖的验收要求、证据冲突或源码变化时，才重开等价修复方案或重复同一验证。Worker 仅提出另一方案不足以重开已验证修复；运行检查通过不等于完整验收。所有代理共享一个私有候选工作区，修改立即可见，需协调同文件修改。";
export const COHORTS = Object.freeze({
  development: Object.freeze(["gn1", "city"]),
  "development-optimized": Object.freeze(["gn1", "city"]),
  holdout: Object.freeze(["mob"]),
});
export function idsForCases(cases) {
  if (
    !Array.isArray(cases) ||
    cases.length === 0 ||
    new Set(cases).size !== cases.length ||
    cases.some((kind) => !Object.hasOwn(GOALS, kind))
  )
    throw new Error("Invalid cohort cases");
  return cases.flatMap((kind) => [kind + "-single", kind + "-multi"]);
}
const REFERENCES = {
  mob: join(
    REPO,
    "docs/case-studies/godot-demo-mob-orientation/minimal-target-fix.patch",
  ),
  gn1: join(REPO, "docs/case-studies/gn1-preview/candidate.patch"),
  city: join(
    REPO,
    "docs/case-studies/city-builder-preview/chronorift/candidate.patch",
  ),
};
const CHECKERS = {
  mob: join(REPO, "scripts/godot-multi-agent-pilot/mob-independent-check.gd"),
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
        "--mob",
        "--cohort",
        "--previous-comparison",
        "--optimization-note",
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
  if (values.cohort !== undefined && !Object.hasOwn(COHORTS, values.cohort))
    throw new Error("Unknown cohort");
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
  const files = await {
    gn1: snapshotGn1Baseline,
    city: snapshotCity,
    mob: snapshotMob,
  }[kind](project);
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
    !Object.hasOwn(GOALS, options.case) ||
    !options.project ||
    !options.patch ||
    !options["godot-bin"]
  )
    throw new Error("Incomplete checker arguments");
  if (options.case === "city" || options.case === "mob") {
    const result = await (options.case === "city" ? checkCity : checkMob)({
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
// Startup recovery for the existing nested Mob case; runtime and strategy stay frozen.
export function holdoutOrchestrationAmendment(previous, currentProduct) {
  if (
    JSON.stringify(previous.config) !== JSON.stringify(CONFIG) ||
    JSON.stringify(previous.spawnPolicy) !==
      JSON.stringify(PILOT_SPAWN_POLICY) ||
    previous.multiAppendix !== MULTI_APPENDIX ||
    JSON.stringify(previous.goals) !==
      JSON.stringify(
        Object.fromEntries(previous.cases.map((kind) => [kind, GOALS[kind]])),
      )
  )
    throw new Error(
      "Holdout configuration or strategy changed after development",
    );
  if (previous.product.sha256 === currentProduct.sha256) return null;
  const before = previous.product.files;
  const after = currentProduct.files;
  if (
    JSON.stringify(before.map((file) => file.path)) !==
    JSON.stringify(after.map((file) => file.path))
  )
    throw new Error("Holdout product file set changed after development");
  const changed = after.filter(
    (file, index) => JSON.stringify(file) !== JSON.stringify(before[index]),
  );
  const runnerPath = "scripts/godot-multi-agent-pilot/run.mjs";
  if (
    changed.length !== 1 ||
    changed[0].path !== runnerPath ||
    !changed[0].sha256 ||
    !before.find((file) => file.path === runnerPath)?.sha256
  )
    throw new Error(
      "Holdout may only repair its runner project-root selection; runtime files must match development",
    );
  return {
    changedPaths: [runnerPath],
    previousRunnerSha256: before.find((file) => file.path === runnerPath)
      .sha256,
    currentRunnerSha256: changed[0].sha256,
    reason:
      "Startup-only repair: pass the existing explicit projectRoot for the nested Mob case after zero-model prerequisite failure. All other product files, model, budgets, goals and collaboration strategy match development.",
    projectRoot: "3d/squash_the_creeps",
  };
}

async function prepare(options) {
  if (
    process.version !== "v22.23.1" ||
    getDefaultResultOrder() !== CONFIG.dnsOrder
  )
    throw new Error("Use Node 22.23.1 with --dns-result-order=ipv4first");
  const cohort = options.cohort ?? "development";
  const cases = COHORTS[cohort];
  const projects = Object.fromEntries(
    await Promise.all(
      cases.map(async (kind) => {
        if (!options[kind])
          throw new Error(`--${kind} is required for ${cohort}`);
        return [kind, await realpath(options[kind])];
      }),
    ),
  );
  let previousComparison = null;
  let orchestrationAmendment = null;
  if (cohort !== "development") {
    if (!options["previous-comparison"])
      throw new Error("A completed development comparison is required");
    const path = await realpath(options["previous-comparison"]);
    const previous = await json(join(path, "manifest.json"));
    await json(join(path, "live-completion.json"));
    await json(join(path, "evaluation/results.json"));
    if (cohort === "development-optimized" && previous.cohort !== "development")
      throw new Error(
        "Only one telemetry-targeted optimization round is allowed",
      );
    if (
      cohort === "holdout" &&
      !["development", "development-optimized"].includes(previous.cohort)
    )
      throw new Error("Holdout must follow development");
    previousComparison = {
      path,
      productSha256: previous.product.sha256,
      cohort: previous.cohort,
    };
    if (cohort === "holdout")
      orchestrationAmendment = holdoutOrchestrationAmendment(
        previous,
        await productIdentity(),
      );
  }
  let optimization = null;
  if (cohort === "development-optimized") {
    if (!options["optimization-note"])
      throw new Error(
        "Freeze a telemetry-backed optimization note before the optional round",
      );
    optimization = await json(resolve(options["optimization-note"]));
    for (const key of ["bottleneck", "telemetryEvidence", "change"])
      if (typeof optimization[key] !== "string" || !optimization[key].trim())
        throw new Error(`Optimization note requires ${key}`);
  }
  const godotBin = await realpath(options["godot-bin"]);
  const parent = await realpath(dirname(options.output));
  const output = join(parent, options.output.split(sep).at(-1));
  for (const root of [REPO, ...Object.values(projects)])
    if (within(root, output) || within(output, root))
      throw new Error("Output must not overlap source checkouts");
  await mkdir(output, { mode: 0o700 });
  const manifest = {
    schemaVersion: 2,
    cohort,
    collaborationPolicy: "adaptive",
    cases,
    ids: idsForCases(cases),
    protocol: {
      attemptsPerArm: 1,
      maximumOptimizationRounds: 1,
      minimumWorkers: 0,
      maximumWorkers: 3,
      automaticReruns: false,
      optimizationTrigger: {
        metric: "hostWallClockMs",
        adaptiveToSingleRatioAbove: 1.2,
        selection: "largest telemetry-observed bottleneck",
      },
      holdoutAfterDevelopmentDecision: true,
    },
    previousComparison,
    orchestrationAmendment,
    optimization,
    preparedAt: new Date().toISOString(),
    config: CONFIG,
    spawnPolicy: PILOT_SPAWN_POLICY,
    goals: Object.fromEntries(cases.map((kind) => [kind, GOALS[kind]])),
    multiAppendix: MULTI_APPENDIX,
    projects,
    source: Object.fromEntries(
      await Promise.all(
        cases.map(async (kind) => [
          kind,
          await sourceIdentity(projects[kind], kind),
        ]),
      ),
    ),
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
    checkers: Object.fromEntries(
      await Promise.all(
        cases.map(async (kind) => [kind, sha(await readFile(CHECKERS[kind]))]),
      ),
    ),
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
          cases.map(async (kind) => ({
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
  if (cohort !== "holdout") {
    // Deliberately broken reference variants, never visible to model Sessions.
    const { gn1, city } = projects;
    const cityOriginal = await readFile(
      join(city, "scripts/builder.gd"),
      "utf8",
    );
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
  if (!process.send) throw new Error("arm requires trusted parent IPC");
  const manifest = await json(join(options.output, "manifest.json"));
  if (!idsForCases(manifest.cases).includes(options.id))
    throw new Error("Unknown arm ID");
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
        ...(kind === "mob" ? { projectRoot: "3d/squash_the_creeps" } : {}),
        provider: CONFIG.provider,
        model: CONFIG.model,
        thinkingLevel: CONFIG.thinkingLevel,
        timeoutMs: CONFIG.timeoutMs,
        agentDir: manifest.model.agentDir,
        stateRoot: join(output, "state"),
        godotBin: manifest.godotBin,
        goal:
          manifest.goals[kind] +
          (arm === "multi" ? "\n\n" + manifest.multiAppendix : ""),
        interactive: false,
        ...(arm === "multi"
          ? {
              multiAgent: {
                maxAgents: CONFIG.maxAgents,
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
            toolDefinitions: piOptions.tools.map((t) => ({
              name: t.name,
              description: t.description,
              parameters: t.parameters,
              promptSnippet: t.promptSnippet,
              promptGuidelines: t.promptGuidelines,
            })),
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
async function runCohort(options) {
  const manifest = await json(join(options.output, "manifest.json"));
  const ids = idsForCases(manifest.cases);
  if (!(await json(join(options.output, "controls.json"))).passed)
    throw new Error("Offline controls have not passed");
  if (
    manifest.collaborationPolicy !== "adaptive" ||
    manifest.multiAppendix !== MULTI_APPENDIX ||
    JSON.stringify(manifest.goals) !==
      JSON.stringify(
        Object.fromEntries(manifest.cases.map((kind) => [kind, GOALS[kind]])),
      ) ||
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
  for (const kind of manifest.cases)
    if (sha(await readFile(CHECKERS[kind])) !== manifest.checkers[kind])
      throw new Error("Checker changed");
  // Claim once before starting any Host. This file makes accidental live reruns fail closed.
  await save(join(options.output, "live-start.json"), {
    startedAt: new Date().toISOString(),
    ids,
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
  for (const id of ids) {
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
    console.log("Started live Hosts: " + ids.join(", "));
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
    for (const kind of manifest.cases) {
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
    await { prepare, run: runCohort, arm: runArm, check: checker, evaluate }[
      options.mode
    ](options);
  } catch (error) {
    console.error(String(error));
    process.exitCode = 2;
  }
}
