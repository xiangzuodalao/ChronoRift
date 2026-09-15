// Frozen feature tasks; offline preparation, serial one-shot live trials, independent grading.
// This runner reuses the current product and never changes collaboration prompts or Runtime.
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
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { runProjectEnvironmentPreviewV2 } from "../../apps/cli/src/vnext/project-environment-preview.ts";
import { createProjectMultiAgentEnvironment } from "../../apps/cli/src/vnext/project-multi-agent.ts";
import { createNodeAgentWorker } from "../../apps/cli/src/vnext/agent-worker-client.ts";
import { preflightCleanProjectEnvironmentV1 } from "../../apps/cli/src/vnext/source-preflight.ts";
import { prepareGodotInspectionCandidate } from "../../apps/cli/src/vnext/godot-inspection-source.ts";
import { auditResources } from "../../docs/case-studies/city-builder-preview/run.mjs";
import { runVNextPiTurnWithSdk } from "../../packages/pi-harness/src/index.ts";
import {
  ModelRuntime,
  getAgentDir,
} from "../../packages/pi-harness/node_modules/@earendil-works/pi-coding-agent/dist/index.js";
import { assertPilotWorkerRuntime } from "../godot-multi-agent-pilot/run.mjs";
import { summarize } from "../godot-multi-agent-pilot/summarize.mjs";
const execFileAsync = promisify(execFile);
export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// Shared orchestration; profiles change fixed experiment inputs, not the Pi collaboration policy.
export function createFeaturePilot({
  entryPath,
  config,
  spawnPolicy,
  caseOrder,
  cohort,
  commonInstructions,
  multiAppendix,
  executionLimits,
}) {
  if (
    !Array.isArray(caseOrder) ||
    caseOrder.length < 1 ||
    caseOrder.length > 3 ||
    new Set(caseOrder).size !== caseOrder.length ||
    caseOrder.some((id) => !/^[a-z][a-z0-9_]*$/u.test(id))
  )
    throw new Error("Invalid frozen case order");
  if (
    executionLimits &&
    config.sharedToolCallLimit !== executionLimits.sharedToolCallLimit
  )
    throw new Error("Profile team budget disagrees with execution limits");
  const ENTRY = resolve(entryPath);
  const CONFIG = Object.freeze({ ...config });
  const PILOT_SPAWN_POLICY = spawnPolicy;
  const CASE_ORDER = Object.freeze([...caseOrder]);
  const COMMON_INSTRUCTIONS = commonInstructions;
  const MULTI_APPENDIX = multiAppendix;
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
        maxBuffer: 16 * 1024 * 1024,
      })
    ).stdout.trim();
  function nodeArgs(...args) {
    return [
      "--dns-result-order=ipv4first",
      "--import",
      join(REPO, "node_modules/tsx/dist/loader.mjs"),
      ENTRY,
      ...args,
    ];
  }
  function trialOrder(cases) {
    if (
      !Array.isArray(cases) ||
      new Set(cases).size !== cases.length ||
      cases.some((id) => !CASE_ORDER.includes(id))
    )
      throw new Error("Invalid cases");
    return CASE_ORDER.filter((id) => cases.includes(id)).flatMap((id, index) =>
      (index % 2 === 0 ? ["single", "multi"] : ["multi", "single"]).map(
        (arm) => id + "-" + arm,
      ),
    );
  }
  function goalFor(task, arm) {
    if (!["single", "multi"].includes(arm)) throw new Error("Invalid arm");
    return (
      task.trim() +
      "\n\n" +
      COMMON_INSTRUCTIONS +
      (arm === "multi" ? "\n\n" + MULTI_APPENDIX : "")
    );
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
    if (!manifest.ids.includes(options.id)) throw new Error("Unknown arm ID");
    const [kind, arm] = options.id.split("-");
    const output = join(options.output, options.id);
    await mkdir(output, { mode: 0o700 });
    if (getDefaultResultOrder() !== "ipv4first")
      throw new Error("Root DNS order differs");
    const identity = await sourceIdentity(manifest.tasks[kind], options.output);
    if (JSON.stringify(identity) !== JSON.stringify(manifest.source[kind]))
      throw new Error("Source changed after controls");
    const append = (file, data) =>
      appendFileSync(
        join(output, file),
        JSON.stringify({ receivedAt: new Date().toISOString(), ...data }) +
          "\n",
        { mode: 0o600 },
      );
    const started = new Promise((resolveStart, rejectStart) => {
      process.once("message", (message) =>
        message?.type === "start" && Number.isSafeInteger(message.invokedAt)
          ? resolveStart(message.invokedAt)
          : rejectStart(new Error("Unexpected start message")),
      );
      process.once("disconnect", () =>
        rejectStart(new Error("Parent disconnected before start")),
      );
    });
    process.send({ type: "ready", id: options.id });
    const startTime = await started,
      startedAt = new Date(startTime).toISOString();
    const cancellation = new AbortController();
    const onSignal = () => cancellation.abort();
    const deadline = startTime + CONFIG.timeoutMs;
    const deadlineTimer = setTimeout(
      onSignal,
      Math.max(1, deadline - Date.now()),
    );
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
      goalSha256: sha(goalFor(manifest.goals[kind], arm)),
    });
    try {
      preview = await runProjectEnvironmentPreviewV2(
        {
          projectPath: manifest.projects[kind],
          projectRoot: manifest.tasks[kind].projectRoot ?? ".",
          provider: CONFIG.provider,
          model: CONFIG.model,
          thinkingLevel: CONFIG.thinkingLevel,
          timeoutMs: CONFIG.timeoutMs,
          ...(executionLimits ? { executionLimits } : {}),
          agentDir: manifest.model.agentDir,
          stateRoot: join(output, "state"),
          godotBin: manifest.tasks[kind].godotBin,
          goal: goalFor(manifest.goals[kind], arm),
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
              timeoutMs: Math.max(1, deadline - Date.now()),
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
      clearTimeout(deadlineTimer);
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      process.off("disconnect", onSignal);
      const after = await sourceIdentity(
        manifest.tasks[kind],
        options.output,
      ).catch(() => null);
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

  async function sourceIdentity(task, stateRoot) {
    const project = await realpath(task.modelSource);
    if (
      (await git(project, "rev-list", "--all", "--count")) !== "1" ||
      (await git(project, "remote")) !== "" ||
      (await git(project, "status", "--porcelain", "--untracked-files=all")) !==
        ""
    )
      throw new Error(
        "Model source must be a clean one-commit snapshot without remotes",
      );
    const objects = (
      await git(
        project,
        "cat-file",
        "--batch-all-objects",
        "--batch-check=%(objectname) %(objecttype)",
      )
    )
      .split("\n")
      .map((line) => line.split(" "));
    if (
      objects.filter(([, type]) => type === "commit").length !== 1 ||
      objects.some(([, type]) => type === "tag")
    )
      throw new Error("Model source contains non-baseline history objects");
    const reachable = new Set(
      (
        await git(project, "rev-list", "--objects", "--no-object-names", "HEAD")
      ).split("\n"),
    );
    if (
      objects.length !== reachable.size ||
      objects.some(([id]) => !reachable.has(id))
    )
      throw new Error(
        "Model source contains unreachable non-baseline Git objects",
      );
    const tree = await git(project, "rev-parse", "HEAD^{tree}");
    if (tree !== task.base?.tree)
      throw new Error(
        "Model snapshot tree differs from frozen upstream base tree",
      );
    const source = await preflightCleanProjectEnvironmentV1({
      projectPath: project,
      projectRoot: task.projectRoot ?? ".",
      sourceRepositoryExclusionRoots: [stateRoot, REPO],
    });
    // A normal Godot import is insufficient if current Preview rejects the same source.
    await prepareGodotInspectionCandidate(
      resolve(project, task.projectRoot ?? "."),
    );
    return {
      commit: await git(project, "rev-parse", "HEAD"),
      tree,
      sha256: source.selectedTreeSha256,
      projectRoot: source.projectPrefix,
      oneCommitSnapshot: true,
      baselineHistoryOnly: true,
    };
  }

  function eligibleCases(tasks) {
    if (
      tasks.length !== CASE_ORDER.length ||
      tasks.some((task, i) => task.caseId !== CASE_ORDER[i]) ||
      tasks.some((task) => !["ready", "blocked"].includes(task.status))
    )
      throw new Error(
        "All ordered preparation decisions must exist before freezing",
      );
    for (const task of tasks.filter((task) => task.status === "ready")) {
      if (
        task.controls?.passed !== true ||
        !task.modelSource ||
        !task.taskPath ||
        !task.godotBin ||
        !task.evaluator?.module ||
        !/^[a-f0-9]{40}$/u.test(task.base?.commit ?? "") ||
        !/^[a-f0-9]{40}$/u.test(task.reference?.commit ?? "")
      )
        throw new Error(
          "Ready task lacks controls or frozen inputs: " + task.caseId,
        );
    }
    return tasks
      .filter((task) => task.status === "ready")
      .map((task) => task.caseId);
  }

  async function fileIdentity(path) {
    const canonical = await realpath(path);
    const bytes = await readFile(canonical);
    return { path: canonical, sha256: sha(bytes), byteLength: bytes.length };
  }

  async function freeze(options) {
    if (
      process.version !== "v22.23.1" ||
      getDefaultResultOrder() !== CONFIG.dnsOrder
    )
      throw new Error("Use pinned Node22.23.1 with ipv4first");
    await mkdir(options.output, { mode: 0o700 });
    const tasks = [];
    const preparationRecords = [];
    for (const id of CASE_ORDER) {
      const path = join(resolve(options.preparation), id, "manifest.json");
      tasks.push(await json(path));
      preparationRecords.push(await fileIdentity(path));
    }
    const cases = eligibleCases(tasks);
    const source = {},
      goals = {},
      frozenFiles = [
        ...preparationRecords,
        await fileIdentity(
          join(REPO, "docs/case-studies/city-builder-preview/run.mjs"),
        ),
      ];
    for (const task of tasks) {
      for (const path of [
        task.taskPath,
        task.godotBin,
        task.evaluator?.module,
        ...(task.evaluator?.frozenPaths ?? []),
      ].filter(Boolean)) {
        const identity = await fileIdentity(path);
        for (const target of tasks.filter((task) => task.modelSource))
          if (within(await realpath(target.modelSource), identity.path))
            throw new Error(
              "Private evaluator or preparation input overlaps model source",
            );
        frozenFiles.push(identity);
      }
      if (!cases.includes(task.caseId)) continue;
      source[task.caseId] = await sourceIdentity(task, options.output);
      goals[task.caseId] = await readFile(task.taskPath, "utf8");
      // Resource discovery is offline and independent of Pi Session creation.
      const resources = await auditResources(
        {
          resourceWorkspaceDirectory: resolve(
            task.modelSource,
            task.projectRoot ?? ".",
          ),
          agentDir: getAgentDir(),
        },
        REPO,
      );
      for (const resource of [
        ...resources.contexts,
        ...resources.skills,
        ...resources.prompts,
        ...(resources.systemPrompt ? [resources.systemPrompt] : []),
      ])
        frozenFiles.push(await fileIdentity(resource.path));
    }
    const manifest = {
      schemaVersion: 1,
      frozenAt: new Date().toISOString(),
      cohort,
      collaborationPolicy: "adaptive",
      config: CONFIG,
      ...(executionLimits ? { executionLimits } : {}),
      spawnPolicy: PILOT_SPAWN_POLICY,
      commonInstructions: COMMON_INSTRUCTIONS,
      multiAppendix: MULTI_APPENDIX,
      tasks: Object.fromEntries(tasks.map((task) => [task.caseId, task])),
      cases,
      ids: trialOrder(cases),
      projects: Object.fromEntries(
        tasks
          .filter((task) => cases.includes(task.caseId))
          .map((task) => [task.caseId, task.modelSource]),
      ),
      source,
      goals,
      frozenFiles,
      product: await productIdentity(),
      model: cases.length ? await modelIdentity() : null,
      protocol: {
        maximumWorkers: 3,
        maximumModelTrials: 6,
        attemptsPerArm: 1,
        serialTrials: true,
        alternatingFirstArm: true,
        workerCanImplement: true,
        referenceAndEvaluatorVisibleToModel: false,
        independentEvaluationsPerCandidate: 2,
        modelStrategyChangesDuringBatch: false,
        deadlineStartsAtHostInvocation: true,
        cleanupAllowanceMs: 180000,
      },
    };
    await save(join(options.output, "manifest.json"), manifest);
    console.log(
      JSON.stringify({
        frozen: true,
        cases,
        ids: manifest.ids,
        blocked: tasks
          .filter((task) => task.status === "blocked")
          .map((task) => task.caseId),
      }),
    );
  }

  async function verifyFreeze(manifest, output) {
    if (
      process.version !== "v22.23.1" ||
      getDefaultResultOrder() !== CONFIG.dnsOrder
    )
      throw new Error("Use pinned Node22.23.1 with ipv4first");
    if (
      JSON.stringify(CONFIG) !== JSON.stringify(manifest.config) ||
      JSON.stringify(executionLimits) !==
        JSON.stringify(manifest.executionLimits) ||
      JSON.stringify(PILOT_SPAWN_POLICY) !==
        JSON.stringify(manifest.spawnPolicy) ||
      COMMON_INSTRUCTIONS !== manifest.commonInstructions ||
      MULTI_APPENDIX !== manifest.multiAppendix ||
      JSON.stringify(trialOrder(manifest.cases)) !==
        JSON.stringify(manifest.ids) ||
      (await productIdentity()).sha256 !== manifest.product.sha256
    )
      throw new Error(
        "Product, strategy, order, or resource limits changed after freeze",
      );
    for (const record of manifest.frozenFiles)
      if (
        JSON.stringify(await fileIdentity(record.path)) !==
        JSON.stringify(record)
      )
        throw new Error("Frozen input changed: " + record.path);
    for (const id of manifest.cases)
      if (
        JSON.stringify(await sourceIdentity(manifest.tasks[id], output)) !==
        JSON.stringify(manifest.source[id])
      )
        throw new Error("Baseline source changed: " + id);
    if (
      manifest.cases.length &&
      (await modelIdentity()).sha256 !== manifest.model.sha256
    )
      throw new Error("Pinned model metadata changed");
  }

  async function runSerial(options) {
    const manifest = await json(join(options.output, "manifest.json"));
    await verifyFreeze(manifest, options.output);
    // Claim the entire immutable batch before any model request. No result-dependent reruns.
    await save(join(options.output, "live-start.json"), {
      startedAt: new Date().toISOString(),
      ids: manifest.ids,
    });
    const results = [],
      observed = new Map();
    let stopRequested = false,
      batchFailure = null;
    try {
      for (const id of manifest.ids) {
        await verifyFreeze(manifest, options.output);
        const log = createWriteStream(join(options.output, id + "-host.log"), {
          flags: "wx",
          mode: 0o600,
        });
        const invokedAt = Date.now();
        const child = spawn(
          process.execPath,
          nodeArgs("arm", "--output", options.output, "--id", id),
          {
            cwd: REPO,
            stdio: ["ignore", "pipe", "pipe", "ipc"],
          },
        );
        child.stdout.pipe(log, { end: false });
        child.stderr.pipe(log, { end: false });
        let killTimer,
          watchdog,
          monitor,
          sampling = false;
        const sample = async () => {
          if (sampling) return;
          sampling = true;
          try {
            const processes = await processSample([child.pid]);
            for (const p of processes)
              observed.set(p.pid + ":" + p.startTicks, p);
            appendFileSync(
              join(options.output, "host-samples.jsonl"),
              JSON.stringify({ id, at: new Date().toISOString(), processes }) +
                "\n",
              { mode: 0o600 },
            );
          } finally {
            sampling = false;
          }
        };
        const terminate = () => child.kill("SIGTERM");
        const stopBatch = () => {
          stopRequested = true;
          terminate();
        };
        process.once("SIGINT", stopBatch);
        process.once("SIGTERM", stopBatch);
        try {
          const exited = new Promise((resolveExit) => {
            child.once("error", (error) =>
              resolveExit({
                id,
                exitCode: null,
                error: String(error),
                invokedAt: new Date(invokedAt).toISOString(),
                endToEndDurationMs: Date.now() - invokedAt,
              }),
            );
            child.once("exit", (exitCode, signal) =>
              resolveExit({
                id,
                exitCode,
                signal,
                finishedAt: new Date().toISOString(),
                invokedAt: new Date(invokedAt).toISOString(),
                endToEndDurationMs: Date.now() - invokedAt,
              }),
            );
          });
          child.once("message", (message) => {
            if (message?.type !== "ready" || message.id !== id)
              return terminate();
            child.send({ type: "start", invokedAt });
            console.log("Started serial trial: " + id);
          });
          watchdog = setTimeout(() => {
            appendFileSync(
              join(options.output, "watchdog.jsonl"),
              JSON.stringify({
                id,
                at: new Date().toISOString(),
                action: "SIGTERM",
                reason:
                  "Investigation deadline plus cleanup allowance exceeded",
              }) + "\n",
              { mode: 0o600 },
            );
            terminate();
            killTimer = setTimeout(() => child.kill("SIGKILL"), 30000);
          }, CONFIG.timeoutMs + 180000);
          monitor = setInterval(() => {
            void sample().catch((error) => {
              appendFileSync(
                join(options.output, "monitor-errors.jsonl"),
                JSON.stringify({
                  id,
                  at: new Date().toISOString(),
                  error: String(error),
                }) + "\n",
                { mode: 0o600 },
              );
            });
          }, 1000);
          await sample();
          const result = await exited;
          results.push(result);
          console.log(JSON.stringify(result));
        } finally {
          clearTimeout(watchdog);
          clearTimeout(killTimer);
          clearInterval(monitor);
          process.off("SIGINT", stopBatch);
          process.off("SIGTERM", stopBatch);
          log.end();
        }
        // Do not begin the next trial if any previously observed writer survives.
        const surviving = await survivingProcesses([...observed.values()]);
        if (surviving.length) {
          await save(join(options.output, "serial-cleanup-failure.json"), {
            id,
            surviving,
          });
          throw new Error(
            "Previous trial processes survived; remaining trials were not started",
          );
        }
        if (stopRequested) break;
      }
    } catch (error) {
      batchFailure = String(error);
    }
    await save(join(options.output, "live-completion.json"), {
      results,
      finishedAt: new Date().toISOString(),
      observedProcesses: [...observed.values()],
      survivingObservedProcesses: await survivingProcesses([
        ...observed.values(),
      ]),
      failure: batchFailure,
      stopRequested,
      unstartedIds: manifest.ids.filter(
        (id) => !results.some((result) => result.id === id),
      ),
    });
    if (batchFailure) throw new Error(batchFailure);
  }

  async function survivingProcesses(processes) {
    const remaining = [];
    for (const p of processes) {
      try {
        const stat = await readFile("/proc/" + p.pid + "/stat", "utf8");
        const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        if (fields[19] === p.startTicks && fields[0] !== "Z") remaining.push(p);
      } catch (error) {
        if (error.code !== "ENOENT" && error.code !== "ESRCH") throw error;
      }
    }
    return remaining;
  }

  async function evaluate(options) {
    const manifest = await json(join(options.output, "manifest.json"));
    const completion = await json(join(options.output, "live-completion.json"));
    if ((await survivingProcesses(completion.observedProcesses)).length)
      throw new Error("Cannot grade while a trial process remains alive");
    await verifyFreeze(manifest, options.output);
    const directory = join(options.output, "evaluation");
    await mkdir(directory, { mode: 0o700 });
    const results = [];
    for (const id of manifest.ids) {
      const kind = id.split("-")[0],
        task = manifest.tasks[kind];
      const preview = await json(
        join(options.output, id, "preview.json"),
      ).catch(() => null);
      const patch = preview?.candidatePatch;
      for (let repeat = 1; repeat <= 2; repeat++) {
        if (!patch) {
          results.push({
            id,
            repeat,
            outcome: "requires_review",
            reason: "No frozen final candidate patch",
          });
          continue;
        }
        if (
          !within(join(options.output, id), resolve(patch.path)) ||
          patch.roundTripVerified !== true ||
          (await fileIdentity(patch.path)).sha256 !== patch.sha256 ||
          (await readFile(patch.path)).length !== patch.byteLength
        )
          throw new Error("Final candidate patch identity failed");
        const output = join(directory, id + "-" + repeat),
          started = Date.now();
        const module = await import(pathToFileURL(task.evaluator.module).href);
        const result = await module[task.evaluator.exportName ?? "check"]({
          ...task.evaluator.options,
          project: task.modelSource,
          godotBin: task.godotBin,
          candidatePatch: patch.path,
          output,
        });
        await save(join(output, "invocation.json"), {
          durationMs: Date.now() - started,
          exitCode: result.exitCode,
        });
        results.push({
          id,
          repeat,
          output,
          outcome: result.outcome,
          exitCode: result.exitCode,
          patchSha256: patch.sha256,
        });
      }
    }
    await save(join(directory, "results.json"), results);
    console.log(JSON.stringify(results));
  }

  function argumentsFor(args) {
    const [mode, ...rest] = args;
    if (!["freeze", "run", "arm", "evaluate", "summarize"].includes(mode))
      throw new Error("Expected freeze|run|evaluate|summarize");
    const options = { mode };
    for (let i = 0; i < rest.length; i += 2) {
      const key = rest[i],
        value = rest[i + 1];
      if (
        !["--output", "--preparation", "--id"].includes(key) ||
        options[key.slice(2)] !== undefined ||
        !value ||
        value.startsWith("--") ||
        value.includes("\0")
      )
        throw new Error("Invalid argument");
      options[key.slice(2)] = value;
    }
    if (!options.output || (mode === "freeze" && !options.preparation))
      throw new Error("Required output/preparation missing");
    options.output = resolve(options.output);
    return options;
  }

  async function summarizeBatch(options) {
    const manifest = await json(join(options.output, "manifest.json"));
    const output = join(options.output, "derived");
    if (manifest.ids.length) return summarize(options.output, output);
    await mkdir(output, { mode: 0o700 });
    await save(join(output, "summary.json"), {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      cohort: manifest.cohort,
      rows: [],
      modelTrials: 0,
      reason: "All requested cases blocked during offline preparation",
      performanceComparisonAvailable: false,
      totalReportedTokens: 0,
      totalEstimatedCostUSD: 0,
      costMeaning:
        "No experimental model requests were made; no Single/Multi performance observation exists",
    });
    await writeFile(
      join(output, "results.csv"),
      "id,case,arm,status,acceptance,hostDurationMs,tokens,estimatedCostUSD,workerCount\n",
      { flag: "wx", mode: 0o600 },
    );
    await save(join(output, "timing-audit.json"), []);
    await save(join(output, "accounting.json"), []);
  }

  async function main(args = process.argv.slice(2)) {
    const options = argumentsFor(args);
    return {
      freeze,
      run: runSerial,
      arm: runArm,
      evaluate,
      summarize: summarizeBatch,
    }[options.mode](options);
  }
  return {
    trialOrder,
    goalFor,
    sourceIdentity,
    eligibleCases,
    fileIdentity,
    argumentsFor,
    main,
  };
}
