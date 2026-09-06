// Case-local independent Godot acceptance; no Agent or provider invocation.
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  chmod,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareGodotInspectionCandidate } from "../../../apps/cli/src/vnext/godot-inspection-source.ts";
import { GodotImportPreparationError } from "../../../apps/cli/src/vnext/godot-import-preparation.ts";
import { selectedTreeSha256 } from "../../../apps/cli/src/vnext/selected-tree.ts";
import { SrtGodotRunner } from "../../../apps/cli/src/vnext/srt-godot-runner.ts";
import { SrtSandboxController } from "../../../apps/cli/src/vnext/srt-sandbox-controller.ts";

const CHECKER_PATH = "__finite_watch_independent_check.gd";
const PREFIX = "CAPACITOR_CHECK_OBSERVATIONS ";
const CONFIGURATIONS = [
  { name: "default", capacity: 100, increment: 7, cycle_length: 120 },
  { name: "smaller_capacity", capacity: 40, increment: 6, cycle_length: 120 },
  {
    name: "increment_above_capacity",
    capacity: 1,
    increment: 2,
    cycle_length: 120,
  },
];
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sourceHash = (files) =>
  selectedTreeSha256(
    files.map((file) => ({
      relativePath: file.relativePath,
      mode: file.executable ? "100755" : "100644",
      content: file.bytes,
    })),
  );
const save = (path, value) =>
  writeFile(path, JSON.stringify(value, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
const requireValue = (condition, message) => {
  if (!condition) throw new Error(message);
};
const within = (parent, path) =>
  path === parent || path.startsWith(parent + sep);
const completeProcess = (value) =>
  value.status === "exited" &&
  value.exitCode === 0 &&
  value.signal === null &&
  !value.timedOut &&
  !value.cancelled &&
  !value.stdoutTruncated &&
  !value.stderrTruncated;
const review = (reason) => ({
  outcome: "requires_review",
  reason,
  scenarios: [],
});

export function assess(importProcess, runtime) {
  try {
    requireValue(
      completeProcess(importProcess) && completeProcess(runtime.process),
      "Import or runtime did not finish with complete successful output",
    );
    requireValue(
      runtime.sourceUnchanged &&
        runtime.sourceSha256 === runtime.observedSourceSha256,
      "Read-only staged source integrity failed",
    );
    requireValue(
      !/(?:^|\n)(?:\u001b\[[0-9;]*m)*(?:SCRIPT )?ERROR:/u.test(
        `${importProcess.stdout}\n${importProcess.stderr}\n${runtime.process.stdout}\n${runtime.process.stderr}`,
      ),
      "Godot reported a script or import error",
    );
    const lines = runtime.process.stdout
      .split(/\r?\n/u)
      .filter((line) => line.startsWith("CAPACITOR_CHECK_"));
    requireValue(
      lines.length === 1 && lines[0].startsWith(PREFIX),
      "Missing or duplicate independent checker observations",
    );
    const observations = JSON.parse(lines[0].slice(PREFIX.length));
    requireValue(
      observations.schema_version === 1 &&
        observations.phase ===
          "checker_physics_process_after_subject_callbacks" &&
        observations.checker_physics_priority === 1000000 &&
        observations.scenarios.length === 3,
      "Unexpected checker sampling phase or scenario set",
    );
    const scenarios = observations.scenarios.map((scenario, index) => {
      const configuration = CONFIGURATIONS[index];
      requireValue(
        Object.keys(scenario.configuration).length === 4 &&
          Object.entries(configuration).every(
            ([key, value]) => scenario.configuration[key] === value,
          ) &&
          scenario.samples.length === 360,
        "Incomplete or unexpected scenario timeline",
      );
      const problems = [];
      const add = (ordinal, message) => {
        if (problems.length < 32) problems.push({ ordinal, message });
      };
      let previousPhysics = -1,
        previousProcess = -1;
      const identity = scenario.samples[0].instance_id;
      for (const [offset, sample] of scenario.samples.entries()) {
        const ordinal = offset + 1;
        requireValue(
          sample.ordinal === ordinal &&
            Number.isSafeInteger(sample.physics_tick) &&
            sample.physics_tick > previousPhysics &&
            (offset === 0 || sample.physics_tick === previousPhysics + 1) &&
            Number.isSafeInteger(sample.process_frame) &&
            sample.process_frame >= previousProcess &&
            typeof identity === "string" &&
            /^\d+$/u.test(identity) &&
            sample.instance_id === identity,
          "Incomplete clocks, identity, or sample ordering",
        );
        previousPhysics = sample.physics_tick;
        previousProcess = sample.process_frame;
        const cycleTick = (offset % configuration.cycle_length) + 1;
        const finished = Math.floor(offset / configuration.cycle_length);
        const expectedCharge = Math.min(
          configuration.capacity,
          (cycleTick - 1) * configuration.increment,
        );
        if (
          !Number.isSafeInteger(sample.charge) ||
          sample.charge < 0 ||
          sample.charge > configuration.capacity
        )
          add(ordinal, "charge outside configured capacity bounds");
        if (sample.charge !== expectedCharge)
          add(
            ordinal,
            `charge differs from recharge trajectory: expected ${expectedCharge}, observed ${sample.charge}`,
          );
        if (
          sample.capacity !== configuration.capacity ||
          sample.increment !== configuration.increment ||
          sample.cycle_length !== configuration.cycle_length
        )
          add(ordinal, "exported configuration changed or was ignored");
        if (
          sample.elapsed_ticks !== ordinal ||
          !sample.physics_processing ||
          !Number.isInteger(sample.physics_priority) ||
          sample.physics_priority >= observations.checker_physics_priority
        )
          add(
            ordinal,
            "subject did not process one callback before the checker",
          );
        if (!["charging", "ready"].includes(sample.phase))
          add(ordinal, "unexpected charge phase");
        if (
          expectedCharge < configuration.capacity &&
          sample.phase !== "charging"
        )
          add(ordinal, "reported ready before recharge finished");
        const latestReady =
          Math.ceil(configuration.capacity / configuration.increment) + 2;
        if (cycleTick >= latestReady && sample.phase !== "ready")
          add(ordinal, "did not become ready after full recharge");
        const expectedCompleted = finished + (sample.phase === "ready" ? 1 : 0);
        if (sample.completed_cycles !== expectedCompleted)
          add(
            ordinal,
            "completed cycle count does not match actual recharge state",
          );
      }
      return {
        name: configuration.name,
        passed: problems.length === 0,
        samples: scenario.samples.length,
        problems,
      };
    });
    requireValue(
      new Set(
        observations.scenarios.map(
          (scenario) => scenario.samples[0].instance_id,
        ),
      ).size === 3,
      "Scenario instances were not independent",
    );
    return {
      outcome: scenarios.every((scenario) => scenario.passed)
        ? "passed"
        : "assertions_failed",
      reason: null,
      scenarios,
      observations,
    };
  } catch (error) {
    return review(error instanceof Error ? error.message : String(error));
  }
}

async function saveProcess(output, name, result) {
  await save(join(output, `${name}-process.json`), result);
  await writeFile(join(output, `${name}-stdout.log`), result.stdout, {
    flag: "wx",
    mode: 0o600,
  });
  await writeFile(join(output, `${name}-stderr.log`), result.stderr, {
    flag: "wx",
    mode: 0o600,
  });
}

export async function checkCandidate({ project, godotBin, output }) {
  project = await realpath(project);
  output = join(
    await realpath(dirname(resolve(output))),
    basename(resolve(output)),
  );
  const repo = await realpath(
    fileURLToPath(new URL("../../..", import.meta.url)),
  );
  requireValue(
    !within(project, output) &&
      !within(output, project) &&
      !within(repo, output),
    "Output must not overlap the project or repository",
  );
  await mkdir(output, { mode: 0o700 });
  const startedAt = new Date().toISOString(),
    start = Date.now();
  const abort = new AbortController(),
    onSignal = () => abort.abort();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  const controller = new SrtSandboxController({
    outputLimitBytes: 1024 * 1024,
  });
  const cleanupErrors = [];
  let privateRoot,
    assessment = review("Check did not start"),
    details = {};
  try {
    const candidate = await prepareGodotInspectionCandidate(project);
    requireValue(
      !candidate.sourceFiles.some((file) =>
        [CHECKER_PATH, "override.cfg"].includes(file.relativePath),
      ),
      "Candidate occupies a reserved checker overlay path",
    );
    const checker = await readFile(
      fileURLToPath(new URL("independent-check.gd", import.meta.url)),
    );
    await writeFile(join(output, "independent-check.gd"), checker, {
      flag: "wx",
      mode: 0o600,
    });
    privateRoot = await mkdtemp(
      join(tmpdir(), "chronorift-watch-independent-"),
    );
    const toolDirectory = join(privateRoot, "tools");
    await mkdir(toolDirectory, { mode: 0o700 });
    const godot = join(toolDirectory, "godot");
    await copyFile(await realpath(godotBin), godot);
    await chmod(godot, 0o700);
    details = {
      candidateSourceSha256: sourceHash(candidate.sourceFiles),
      checkerSha256: sha256(checker),
      checkerRunnerSha256: sha256(
        await readFile(fileURLToPath(import.meta.url)),
      ),
      godotExecutableSha256: sha256(await readFile(godot)),
    };
    await save(join(output, "inputs.json"), details);
    const runner = new SrtGodotRunner({
      controller,
      candidateWorkspace: project,
      validationRoot: join(privateRoot, "stages"),
    });
    const prepared = await runner.prepareImport({
      sourceFiles: [
        ...candidate.sourceFiles,
        { relativePath: CHECKER_PATH, bytes: checker, executable: false },
      ],
      overlayFiles: [
        {
          relativePath: "override.cfg",
          bytes: Buffer.from(
            `[autoload]\n\nFiniteWatchIndependentCheck="*res://${CHECKER_PATH}"\n`,
          ),
        },
      ],
      godotPath: godot,
      timeoutMs: 120000,
      signal: abort.signal,
    });
    await saveProcess(output, "import", prepared.process);
    const handle = await runner.open({
      sourceFiles: prepared.sourceFiles,
      importCacheFiles: prepared.importCacheFiles,
      argv: (stage) => [
        godot,
        "--headless",
        "--path",
        stage.projectStagePath,
        "--fixed-fps",
        "60",
        "--disable-render-loop",
      ],
      timeoutMs: 30000,
      readOnlyPaths: [toolDirectory],
      signal: abort.signal,
    });
    handle.process.stdin.on("error", () => undefined);
    handle.process.stdin.end();
    const result = await handle.completion;
    await saveProcess(output, "runtime", result.process);
    await save(join(output, "source-integrity.json"), {
      sourceSha256: result.sourceSha256,
      observedSourceSha256: result.observedSourceSha256,
      sourceUnchanged: result.sourceUnchanged,
    });
    assessment = assess(prepared.process, result);
    details.inputSourceUnchanged =
      sourceHash(
        (await prepareGodotInspectionCandidate(project)).sourceFiles,
      ) === details.candidateSourceSha256;
    requireValue(
      details.inputSourceUnchanged,
      "Input candidate changed during independent acceptance",
    );
  } catch (error) {
    if (error instanceof GodotImportPreparationError && error.process !== null)
      await saveProcess(output, "import", error.process);
    assessment = review(error instanceof Error ? error.message : String(error));
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    try {
      await controller.close();
    } catch (error) {
      cleanupErrors.push(String(error));
    }
    try {
      if (privateRoot) await rm(privateRoot, { recursive: true, force: true });
    } catch (error) {
      cleanupErrors.push(String(error));
    }
  }
  const exitCode =
    cleanupErrors.length ||
    abort.signal.aborted ||
    assessment.outcome === "requires_review"
      ? 2
      : assessment.outcome === "passed"
        ? 0
        : 1;
  await save(join(output, "result.json"), {
    schemaVersion: 1,
    kind: "finite-physics-watch-independent-check",
    startedAt,
    checkedAt: new Date().toISOString(),
    durationMs: Date.now() - start,
    modelInvoked: false,
    ...details,
    assessment,
    cancelled: abort.signal.aborted,
    cleanupErrors,
    exitCode,
  });
  return {
    directory: output,
    exitCode,
    outcome: assessment.outcome,
    reason: assessment.reason,
  };
}

export function parseArguments(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index],
      value = args[index + 1];
    requireValue(
      ["--project", "--godot-bin", "--output"].includes(key) &&
        !values.has(key) &&
        typeof value === "string" &&
        value.length > 0 &&
        !value.startsWith("--") &&
        !value.includes("\0"),
      "Usage: node --import tsx check.mjs --project PATH --godot-bin PATH --output NEW_DIRECTORY",
    );
    values.set(key, resolve(value));
  }
  requireValue(values.size === 3, "All three arguments are required");
  return {
    project: values.get("--project"),
    godotBin: values.get("--godot-bin"),
    output: values.get("--output"),
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const result = await checkCandidate(parseArguments(process.argv.slice(2)));
  console.log(JSON.stringify(result));
  process.exitCode = result.exitCode;
}
