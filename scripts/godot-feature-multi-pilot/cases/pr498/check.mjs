// Run from this repository with Node >=22: node --import tsx <this-file> ...
// Case-local orchestration only; no Pi imports, model calls, or product changes.
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  mkdir,
  lstat,
  readdir,
  mkdtemp,
  open,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { isExternalGodotNativeSourcePathV1 } from "../../../../apps/cli/src/vnext/external-godot-source-policy.ts";
import { isProjectEnvironmentSensitivePathV1 } from "../../../../apps/cli/src/vnext/project-environment-source-policy.ts";
import { GodotImportPreparationError } from "../../../../apps/cli/src/vnext/godot-import-preparation.ts";
import { selectedTreeSha256 } from "../../../../apps/cli/src/vnext/selected-tree.ts";
import { SrtGodotRunner } from "../../../../apps/cli/src/vnext/srt-godot-runner.ts";
import { SrtSandboxController } from "../../../../apps/cli/src/vnext/srt-sandbox-controller.ts";

const CHECKER_PATH = "__pr498_independent_check.gd";
export const ASSERTION_IDS = [
  "event_classification",
  "device_event_filtering",
  "filter_wrap_and_fallback",
  "empty_action",
  "text_fallback",
  "icon_mapping_and_refresh",
  "input_index_refresh",
  "cycle_timer",
  "static_hint",
  "device_switching",
  "combined_keyboard_mouse_cycle",
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
        "--checker",
        "--output",
      ].includes(key) &&
        !values.has(key) &&
        typeof value === "string" &&
        value.length > 0 &&
        !value.startsWith("--") &&
        !value.includes("\0"),
      "Usage: node --import tsx check.mjs --project PATH --godot-bin PATH [--candidate-patch PATH] --checker PRIVATE_FILE --output NEW_DIRECTORY",
    );
    values.set(key, resolve(value));
  }
  for (const key of ["--project", "--godot-bin", "--checker", "--output"])
    requireValue(values.has(key), `${key} is required`);
  return {
    project: values.get("--project"),
    godotBin: values.get("--godot-bin"),
    candidatePatch: values.get("--candidate-patch"),
    checkerPath: values.get("--checker"),
    output: values.get("--output"),
  };
}

// Standalone evaluation retains the complete upstream source, including override.cfg.
export async function snapshotBaseline(project) {
  const files = [];
  let entries = 0,
    totalBytes = 0;
  const same = (a, b) =>
    ["dev", "ino", "mode", "nlink", "size", "mtimeNs", "ctimeNs"].every(
      (key) => a[key] === b[key],
    );
  const visit = async (path, relativePath, depth, device) => {
    requireValue(
      ++entries <= 16_384 && depth <= 64,
      "Source entry/depth budget exceeded",
    );
    const before = await lstat(path, { bigint: true });
    requireValue(
      !before.isSymbolicLink() && (before.isDirectory() || before.isFile()),
      "Source contains a link or special file",
    );
    const handle = await open(
      path,
      constants.O_RDONLY |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK |
        (before.isDirectory() ? constants.O_DIRECTORY : 0),
    );
    try {
      const pinned = await handle.stat({ bigint: true });
      requireValue(
        same(before, pinned) && (device === undefined || pinned.dev === device),
        "Source changed or crossed a filesystem boundary",
      );
      if (pinned.isDirectory()) {
        for (const name of (
          await readdir(`/proc/self/fd/${handle.fd}`)
        ).sort()) {
          if (relativePath === "" && [".git", ".godot"].includes(name))
            continue;
          requireValue(
            !name.includes("\\") && ![".git", ".godot"].includes(name),
            "Source contains a reserved or invalid path",
          );
          const child = relativePath ? `${relativePath}/${name}` : name;
          requireValue(
            !isProjectEnvironmentSensitivePathV1(child) &&
              !isExternalGodotNativeSourcePathV1(child),
            "Source contains a sensitive or native-code path",
          );
          await visit(
            `/proc/self/fd/${handle.fd}/${name}`,
            child,
            depth + 1,
            pinned.dev,
          );
        }
      } else {
        const size = Number(pinned.size);
        totalBytes += size;
        requireValue(
          pinned.nlink === 1n &&
            size <= 64 * 1024 * 1024 &&
            totalBytes <= 256 * 1024 * 1024,
          "Source file/byte budget exceeded or hard link found",
        );
        const bytes = Buffer.alloc(size + 1);
        let length = 0;
        while (length < bytes.length) {
          const read = await handle.read(
            bytes,
            length,
            bytes.length - length,
            length,
          );
          if (!read.bytesRead) break;
          length += read.bytesRead;
        }
        requireValue(length === size, "Source changed while reading");
        files.push({
          relativePath,
          bytes: bytes.subarray(0, length),
          executable: (pinned.mode & 0o111n) !== 0n,
        });
      }
      requireValue(
        same(pinned, await handle.stat({ bigint: true })),
        "Source changed during snapshot",
      );
    } finally {
      await handle.close();
    }
  };
  await visit(project, "", 0, undefined);
  requireValue(
    files.some((file) => file.relativePath === "project.godot"),
    "Source lacks project.godot",
  );
  return files;
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

// Assess the private behavior script, retaining infrastructure errors separately.
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
    requireValue(
      !/(?:^|\n)(?:\u001b\[[0-9;]*m)*(?:SCRIPT )?ERROR:/u.test(
        `${importProcess.stdout}\n${importProcess.stderr}\n${runtime.process.stdout}\n${runtime.process.stderr}`,
      ),
      "Godot reported import or script errors",
    );
    const lines = runtime.process.stdout
      .split(/\r?\n/u)
      .filter((line) => line.startsWith("CHRONORIFT_PR498_EVAL="));
    requireValue(lines.length === 1, "Missing or duplicate evaluator output");
    const record = JSON.parse(lines[0].slice("CHRONORIFT_PR498_EVAL=".length));
    requireValue(
      record.schemaVersion === 1 &&
        Array.isArray(record.assertions) &&
        record.assertions.length === ASSERTION_IDS.length,
      "Malformed input hint assertions",
    );
    const assertions = record.assertions;
    for (const [index, assertion] of assertions.entries()) {
      requireValue(
        assertion.id === ASSERTION_IDS[index] &&
          typeof assertion.passed === "boolean" &&
          assertion.observed !== undefined,
        "Malformed or unexpected input hint assertion",
      );
    }
    const accepted = assertions.every((item) => item.passed);
    requireValue(
      runtime.process.exitCode === (accepted ? 0 : 1),
      "Evaluator exit code disagrees with observations",
    );
    return {
      outcome: accepted ? "passed" : "assertions_failed",
      reason: null,
      assertions,
      scope:
        "Synthetic input events and instantiated input-hint scenes; no physical controller, visual-layout or full-menu gameplay acceptance.",
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
    privateRoot = await mkdtemp(join(tmpdir(), "chronorift-pr498-check-"));
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
      const patchFile = join(workspace, "__pr498_candidate.patch");
      requireValue(
        !sourceFiles.some(
          (file) => file.relativePath === "__pr498_candidate.patch",
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
            "__pr498_candidate.patch",
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
    const candidate = { sourceFiles: await snapshotBaseline(workspace) };
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
      caseId: "pr498",
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
    if (prepared.bootstrapProcess)
      await saveProcess(
        options.output,
        "import-bootstrap",
        prepared.bootstrapProcess,
      );
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
    if (
      error instanceof GodotImportPreparationError &&
      error.bootstrapProcess !== null
    )
      await saveProcess(
        options.output,
        "import-bootstrap",
        error.bootstrapProcess,
      );
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
    assessment = review(
      abort.signal.aborted ? "Check cancelled" : "Sandbox cleanup failed",
    );
  }
  await save(join(options.output, "result.json"), {
    schemaVersion: 1,
    kind: "pr498-input-hints-independent-check",
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
