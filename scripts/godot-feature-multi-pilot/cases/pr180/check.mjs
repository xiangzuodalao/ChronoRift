// Run from this repository with Node >=22: node --import tsx <this-file> ...
// Case-local orchestration only; no Pi imports, model calls, or product changes.
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { prepareGodotInspectionCandidate } from "../../../../apps/cli/src/vnext/godot-inspection-source.ts";
import { GodotImportPreparationError } from "../../../../apps/cli/src/vnext/godot-import-preparation.ts";
import { NodeHostGitPort } from "../../../../apps/cli/src/vnext/host-git.ts";
import { selectedTreeSha256 } from "../../../../apps/cli/src/vnext/selected-tree.ts";
import { parseGitTreeListing } from "../../../../apps/cli/src/vnext/source-preflight.ts";
import { SrtGodotRunner } from "../../../../apps/cli/src/vnext/srt-godot-runner.ts";
import { SrtSandboxController } from "../../../../apps/cli/src/vnext/srt-sandbox-controller.ts";

export const SOURCE_COMMIT = "eea63dab5d96901cdae451473b446d56d7fcea85";
export const SOURCE_TREE = "af4039f471bac2401b1b4e1a4ae7b15f20b6dd79";
export const PROJECT_PREFIX = "";
const CHECKER_PATH = "__feature_independent_check.gd";
export const ASSERTION_IDS = Object.freeze([
  "public_state_classes",
  "autoload_opens_state",
  "opening_metadata",
  "first_version_stable_last_version_updates",
  "typed_key_reuse",
  "independent_keys",
  "incompatible_type_replaced",
  "generic_data_disk_roundtrip",
  "game_counter_and_progress",
  "game_api_persists",
  "project_color_signal_updates_display",
  "project_color_disk_restored_scene",
  "project_colors_isolated_by_level",
  "project_play_signal_starts_game",
  "project_play_requests_game_scene",
  "project_loader_starts_at_first_level",
  "project_loader_advances",
  "project_loader_progress_disk_roundtrip",
  "project_reset_signal_game_options_menu.tscn",
  "project_reset_disk_game_options_menu.tscn",
  "project_reset_signal_mini_options_menu_with_reset.tscn",
  "project_reset_disk_mini_options_menu_with_reset.tscn",
  "template_color_signal_updates_display",
  "template_color_disk_restored_scene",
  "template_colors_isolated_by_level",
  "template_play_signal_starts_game",
  "template_play_requests_game_scene",
  "template_loader_starts_at_first_level",
  "template_loader_advances",
  "template_loader_progress_disk_roundtrip",
  "template_reset_signal_game_options_menu.tscn",
  "template_reset_disk_game_options_menu.tscn",
  "template_reset_signal_mini_options_menu_with_reset.tscn",
  "template_reset_disk_mini_options_menu_with_reset.tscn",
  "global_reset_clears_registered_states",
  "global_reset_persisted",
  "reset_preserves_settings_and_metadata",
]);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sourceHash = (files) =>
  selectedTreeSha256(
    files.map((file) => ({
      relativePath: file.relativePath,
      mode: file.executable ? "100755" : "100644",
      content: file.bytes,
    })),
  );
const requireValue = (condition, message) => {
  if (!condition) throw new Error(message);
};
const save = (path, value) =>
  writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });

export function parseArguments(args) {
  const values = new Map();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i],
      value = args[i + 1];
    requireValue(
      [
        "--project",
        "--godot-bin",
        "--candidate-patch",
        "--output",
        "--checker-path",
      ].includes(key) &&
        !values.has(key) &&
        typeof value === "string" &&
        value.length > 0 &&
        !value.startsWith("--") &&
        !value.includes("\0"),
      "Usage: node --import tsx check.mjs --project PATH --godot-bin PATH [--candidate-patch PATH] --checker-path PRIVATE_FILE --output NEW_DIRECTORY",
    );
    values.set(key, resolve(value));
  }
  for (const key of ["--project", "--godot-bin", "--output", "--checker-path"])
    requireValue(values.has(key), `${key} is required`);
  return {
    project: values.get("--project"),
    godotBin: values.get("--godot-bin"),
    candidatePatch: values.get("--candidate-patch"),
    output: values.get("--output"),
    checkerPath: values.get("--checker-path"),
  };
}

export async function snapshotBaseline(project) {
  const git = new NodeHostGitPort();
  const root = await realpath(project);
  requireValue(
    resolve(await git.resolveRepositoryRoot(root), PROJECT_PREFIX) === root,
    "--project must be the base-only snapshot Git root",
  );
  requireValue(
    (await git.resolveHeadTree(root)) === SOURCE_TREE,
    `Baseline must be pinned at ${SOURCE_COMMIT}`,
  );
  requireValue(
    (await git.statusPorcelain(root)).byteLength === 0,
    "Baseline must be clean, including untracked files",
  );
  const entries = parseGitTreeListing(
    await git.listTree({
      context: { cwd: await git.resolveRepositoryRoot(root) },
      treeish: SOURCE_TREE,
      projectPrefix: PROJECT_PREFIX,
    }),
    PROJECT_PREFIX,
  );
  const { sourceFiles } = await prepareGodotInspectionCandidate(root);
  const byPath = new Map(sourceFiles.map((file) => [file.relativePath, file]));
  requireValue(
    entries.length === sourceFiles.length,
    "Baseline file set differs from pinned tree",
  );
  for (const entry of entries) {
    const file = byPath.get(entry.relativePath);
    requireValue(
      file &&
        entry.byteLength === file.bytes.byteLength &&
        file.executable === (entry.mode === "100755") &&
        createHash("sha1")
          .update(`blob ${file.bytes.byteLength}\0`)
          .update(file.bytes)
          .digest("hex") === entry.objectId,
      `Baseline bytes differ from pinned blob: ${entry.relativePath}`,
    );
  }
  return sourceFiles;
}

async function readOrdinaryFile(path, limit) {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await handle.stat();
    requireValue(
      before.isFile() && before.nlink === 1 && before.size <= limit,
      "Input must be a bounded ordinary file, not a link or device",
    );
    const bytes = Buffer.alloc(before.size + 1);
    let count = 0;
    while (count < bytes.length) {
      const read = await handle.read(bytes, count, bytes.length - count, count);
      if (!read.bytesRead) break;
      count += read.bytesRead;
    }
    const after = await handle.stat();
    requireValue(
      count === before.size &&
        before.size === after.size &&
        before.mtimeMs === after.mtimeMs &&
        before.ctimeMs === after.ctimeMs,
      "Input changed while reading",
    );
    return bytes.subarray(0, count);
  } finally {
    await handle.close();
  }
}

const completeProcess = (result) =>
  result.status === "exited" &&
  result.signal === null &&
  !result.timedOut &&
  !result.cancelled &&
  !result.stdoutTruncated &&
  !result.stderrTruncated;
const review = (reason) => ({ outcome: "requires_review", reason });

// Assertions are private, frozen behavioral fixtures supplied only by the Host.
// Parse/runtime errors and missing evidence never become an acceptance pass.
export function assess(importProcess, runtime) {
  try {
    requireValue(
      completeProcess(importProcess) &&
        importProcess.exitCode === 0 &&
        completeProcess(runtime.process) &&
        [0, 1].includes(runtime.process.exitCode),
      "Import or runtime did not finish with complete output",
    );
    requireValue(
      runtime.sourceUnchanged &&
        runtime.sourceSha256 === runtime.observedSourceSha256,
      "Staged source changed during execution",
    );
    const lines = runtime.process.stdout
      .split(/\r?\n/u)
      .filter((line) => line.startsWith("CHRONORIFT_FEATURE_EVAL="));
    requireValue(lines.length === 1, "Missing or duplicate evaluator output");
    const record = JSON.parse(
      lines[0].slice("CHRONORIFT_FEATURE_EVAL=".length),
    );
    requireValue(
      record.schemaVersion === 1 &&
        Array.isArray(record.assertions) &&
        record.assertions.length > 0 &&
        record.assertions.every(
          (a) => typeof a.id === "string" && typeof a.passed === "boolean",
        ),
      "Malformed feature assertions",
    );
    requireValue(
      new Set(record.assertions.map((a) => a.id)).size ===
        record.assertions.length,
      "Duplicate feature assertions",
    );
    const accepted = record.assertions.every((a) => a.passed);
    if (accepted)
      requireValue(
        record.assertions.length === ASSERTION_IDS.length &&
          ASSERTION_IDS.every((id) =>
            record.assertions.some((a) => a.id === id),
          ),
        "Missing acceptance requirements",
      );
    requireValue(
      runtime.process.exitCode === (accepted ? 0 : 1),
      "Evaluator exit code disagrees with assertions",
    );
    const godotErrors = /(?:^|\n)(?:\u001b\[[0-9;]*m)*(?:SCRIPT )?ERROR:/u.test(
      `${importProcess.stdout}\n${importProcess.stderr}\n${runtime.process.stdout}\n${runtime.process.stderr}`,
    );
    if (godotErrors)
      return {
        outcome: "requires_review",
        reason: "Godot reported import or script errors",
        assertions: record.assertions,
      };
    return {
      outcome: accepted ? "passed" : "assertions_failed",
      reason: null,
      assertions: record.assertions,
      scope: record.scope ?? null,
    };
  } catch (error) {
    return review(error instanceof Error ? error.message : String(error));
  }
}

async function saveProcess(directory, prefix, result) {
  await save(join(directory, `${prefix}-process.json`), result);
  await writeFile(join(directory, `${prefix}-stdout.log`), result.stdout, {
    flag: "wx",
    mode: 0o600,
  });
  await writeFile(join(directory, `${prefix}-stderr.log`), result.stderr, {
    flag: "wx",
    mode: 0o600,
  });
}

export async function check(options) {
  const projectRoot = await realpath(options.project);
  const outputPath = join(
    await realpath(dirname(options.output)),
    options.output.split("/").at(-1),
  );
  const within = (parent, child) => {
    const path = relative(parent, child);
    return (
      path === "" ||
      (!isAbsolute(path) && path !== ".." && !path.startsWith("../"))
    );
  };
  requireValue(
    !within(projectRoot, outputPath) && !within(outputPath, projectRoot),
    "Output must not overlap the source baseline",
  );
  // mkdir without recursive deliberately refuses existing output: evidence is append-only.
  await mkdir(options.output, { mode: 0o700 });
  const startedAt = new Date().toISOString(),
    controller = new SrtSandboxController({ outputLimitBytes: 1024 * 1024 });
  let privateRoot,
    assessment = review("Check did not start"),
    details = {},
    exitCode = 2;
  const cleanupErrors = [],
    abort = new AbortController();
  const onSignal = () => abort.abort();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    const project = await realpath(options.project);
    const sourceFiles = await snapshotBaseline(project),
      baselineSourceSha256 = sourceHash(sourceFiles);
    const checker = await readOrdinaryFile(options.checkerPath, 1024 * 1024);
    const patch = options.candidatePatch
      ? await readOrdinaryFile(options.candidatePatch, 8 * 1024 * 1024)
      : Buffer.alloc(0);
    await writeFile(join(options.output, "candidate.patch"), patch, {
      flag: "wx",
      mode: 0o600,
    });
    await writeFile(join(options.output, "independent-check.gd"), checker, {
      flag: "wx",
      mode: 0o600,
    });
    privateRoot = await mkdtemp(join(tmpdir(), "chronorift-feature-check-"));
    const workspace = join(privateRoot, "candidate");
    await mkdir(workspace, { mode: 0o700 });
    for (const file of sourceFiles) {
      await mkdir(dirname(join(workspace, file.relativePath)), {
        recursive: true,
        mode: 0o700,
      });
      await writeFile(join(workspace, file.relativePath), file.bytes, {
        flag: "wx",
        mode: file.executable ? 0o700 : 0o600,
      });
    }
    const paths = {
      homePath: join(privateRoot, "home"),
      tempPath: join(privateRoot, "temp"),
      artifactsPath: join(privateRoot, "artifacts"),
    };
    for (const path of Object.values(paths)) await mkdir(path, { mode: 0o700 });
    if (patch.byteLength) {
      // Never feed the patch to Host git: all candidate edits occur in the coding sandbox.
      const patchFile = join(workspace, "__feature_candidate.patch");
      requireValue(
        !sourceFiles.some(
          (file) => file.relativePath === "__feature_candidate.patch",
        ),
        "Reserved patch path is occupied",
      );
      await writeFile(patchFile, patch, { flag: "wx", mode: 0o600 });
      for (const checkOnly of [true, false]) {
        const result = await controller.runCoding({
          ...paths,
          workspacePath: workspace,
          cwd: workspace,
          argv: [
            "/usr/bin/git",
            "-c",
            "core.hooksPath=/dev/null",
            "apply",
            "--no-index",
            ...(checkOnly ? ["--check"] : []),
            "--",
            "__feature_candidate.patch",
          ],
          timeoutMs: 30_000,
          signal: abort.signal,
        });
        await saveProcess(
          options.output,
          checkOnly ? "patch-check" : "patch-apply",
          result,
        );
        requireValue(
          completeProcess(result) && result.exitCode === 0,
          "Sandboxed candidate patch application failed",
        );
      }
      await rm(patchFile);
    }
    const candidate = await prepareGodotInspectionCandidate(workspace);
    requireValue(
      !candidate.sourceFiles.some((file) => file.relativePath === CHECKER_PATH),
      "Candidate occupies reserved checker path",
    );
    const toolDirectory = join(privateRoot, "tools");
    await mkdir(toolDirectory, { mode: 0o700 });
    const suppliedGodot = await realpath(options.godotBin);
    await access(suppliedGodot, constants.X_OK);
    const godotBytes = await readOrdinaryFile(suppliedGodot, 512 * 1024 * 1024),
      godot = join(toolDirectory, "godot");
    await writeFile(godot, godotBytes, { flag: "wx", mode: 0o700 });
    details = {
      sourceCommit: SOURCE_COMMIT,
      sourceTree: SOURCE_TREE,
      baselineSourceSha256,
      candidateSourceSha256: sourceHash(candidate.sourceFiles),
      checkerSha256: sha256(checker),
      checkerRunnerSha256: sha256(
        await readOrdinaryFile(fileURLToPath(import.meta.url), 1024 * 1024),
      ),
      patchSha256: sha256(patch),
      godotExecutableSha256: sha256(godotBytes),
    };
    await save(join(options.output, "inputs.json"), details);
    const runner = new SrtGodotRunner({
      controller,
      candidateWorkspace: workspace,
      validationRoot: join(privateRoot, "stages"),
    });
    const prepared = await runner.prepareImport({
      sourceFiles: [
        ...candidate.sourceFiles,
        { relativePath: CHECKER_PATH, bytes: checker, executable: false },
      ],
      overlayFiles: [],
      godotPath: godot,
      timeoutMs: 120_000,
      signal: abort.signal,
    });
    await saveProcess(options.output, "import", prepared.process);
    const handle = await runner.open({
      sourceFiles: prepared.sourceFiles,
      importCacheFiles: prepared.importCacheFiles,
      argv: (stage) => [
        godot,
        "--headless",
        "--audio-driver",
        "Dummy",
        "--path",
        stage.projectStagePath,
        "--script",
        `res://${CHECKER_PATH}`,
      ],
      timeoutMs: 30_000,
      readOnlyPaths: [toolDirectory],
      signal: abort.signal,
    });
    handle.process.stdin.on("error", () => undefined);
    handle.process.stdin.end();
    const result = await handle.completion;
    await saveProcess(options.output, "runtime", result.process);
    await save(join(options.output, "source-integrity.json"), {
      sourceSha256: result.sourceSha256,
      observedSourceSha256: result.observedSourceSha256,
      sourceUnchanged: result.sourceUnchanged,
    });
    assessment = assess(prepared.process, result);
    details.inputSourceUnchanged =
      sourceHash(await snapshotBaseline(project)) === baselineSourceSha256;
    requireValue(
      details.inputSourceUnchanged,
      "Input baseline changed during check",
    );
    exitCode =
      assessment.outcome === "passed"
        ? 0
        : assessment.outcome === "assertions_failed"
          ? 1
          : 2;
  } catch (error) {
    if (error instanceof GodotImportPreparationError && error.process !== null)
      await saveProcess(options.output, "import", error.process);
    assessment = review(error instanceof Error ? error.message : String(error));
    exitCode = 2;
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
  if (cleanupErrors.length || abort.signal.aborted) {
    exitCode = 2;
    assessment = review("Checker cancelled or cleanup failed");
  }
  await save(join(options.output, "result.json"), {
    schemaVersion: 1,
    kind: "godot-feature-pr180-independent-check",
    startedAt,
    checkedAt: new Date().toISOString(),
    modelInvoked: false,
    ...details,
    assessment,
    cancelled: abort.signal.aborted,
    cleanupErrors,
    exitCode,
  });
  return {
    directory: options.output,
    exitCode,
    outcome: assessment.outcome,
    reason: assessment.reason,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const result = await check(parseArguments(process.argv.slice(2)));
    console.log(JSON.stringify(result));
    process.exitCode = result.exitCode;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
