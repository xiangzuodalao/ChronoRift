import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { prepareGodotInspectionCandidate } from "./godot-inspection-source.js";
import { GodotImportPreparationError } from "./godot-import-preparation.js";
import type { GodotValidationSourceFile } from "./godot-validation-stage.js";
import { NodeHostGitPort, type HostGitPort } from "./host-git.js";
import { selectedTreeSha256 } from "./selected-tree.js";
import { parseGitTreeListing } from "./source-preflight.js";
import {
  SrtGodotRunner,
  type SrtGodotProcessResult,
} from "./srt-godot-runner.js";
import {
  SrtSandboxController,
  type SrtCommandResult,
} from "./srt-sandbox-controller.js";

export const GN1_COMMIT = "e78b339500dec8e480b33723c4156bf9b74cd25c";
export const GN1_TREE = "9941cb045b3cd73c4554ca1de337a341b383590b";
const CASE_DIRECTORY = fileURLToPath(
  new URL("../../../../docs/case-studies/gn1-preview/", import.meta.url),
);
const REPOSITORY_DIRECTORY = fileURLToPath(
  new URL("../../../../", import.meta.url),
);
const CHECKER_PATH = "__gn1_check.gd";
const CHECKER_SHA256 =
  "3511eeb68c84ed598b0d5dadee70e42157a8c9ec46dba5e1bf7aa68c8a09bcb2";
const PLATFORM_NAMES = [
  "Platform",
  "Platform2",
  "Platform3",
  "Platform4",
] as const;
const WIDTHS = [2, 1, 3, 6] as const;
const SCOPE =
  "Initial geometry and resource identity after two process frames; no player input simulation, model rerun, or gameplay proof.";

export interface Gn1PreviewCheckOptions {
  readonly project: string;
  readonly godotBin: string;
  readonly candidatePatch: string;
}

export function parseGn1PreviewCheckArguments(
  args: readonly string[],
): Gn1PreviewCheckOptions {
  const values = new Map<string, string>();
  for (let index = args[0] === "--" ? 1 : 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (
      name === undefined ||
      !["--project", "--godot-bin", "--candidate-patch"].includes(name) ||
      values.has(name) ||
      value === undefined ||
      value.length === 0 ||
      value.startsWith("--") ||
      value.includes("\0")
    ) {
      throw new Error(
        "Usage: check:gn1-preview --project PATH --godot-bin PATH [--candidate-patch PATH]",
      );
    }
    values.set(name, value);
  }
  const project = values.get("--project");
  const godotBin = values.get("--godot-bin");
  if (project === undefined || godotBin === undefined)
    throw new Error(
      "--project and --godot-bin are required; this command checks a saved patch, not a model session",
    );
  return {
    project: resolve(project),
    godotBin: resolve(godotBin),
    candidatePatch: resolve(
      values.get("--candidate-patch") ??
        join(CASE_DIRECTORY, "candidate.patch"),
    ),
  };
}

const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");
const sourceHash = (files: readonly GodotValidationSourceFile[]): string =>
  selectedTreeSha256(
    files.map((file) => ({
      relativePath: file.relativePath,
      mode: file.executable ? "100755" : "100644",
      content: file.bytes,
    })),
  );

/** Compare actual admitted bytes as well as Git status: assume-unchanged is not proof. */
export async function snapshotGn1Baseline(
  project: string,
  git: Pick<
    HostGitPort,
    | "resolveRepositoryRoot"
    | "resolveHeadCommit"
    | "resolveHeadTree"
    | "statusPorcelain"
    | "listTree"
  > = new NodeHostGitPort(),
): Promise<readonly GodotValidationSourceFile[]> {
  const root = await realpath(project);
  if ((await realpath(await git.resolveRepositoryRoot(root))) !== root)
    throw new Error("--project must be the GN-1 repository root");
  if (
    (await git.resolveHeadCommit(root)) !== GN1_COMMIT ||
    (await git.resolveHeadTree(root)) !== GN1_TREE
  )
    throw new Error(
      `GN-1 must be checked out at commit ${GN1_COMMIT} (tree ${GN1_TREE})`,
    );
  if ((await git.statusPorcelain(root)).byteLength !== 0)
    throw new Error("GN-1 checkout must be clean, including untracked files");
  const entries = parseGitTreeListing(
    await git.listTree({ context: { cwd: root }, treeish: GN1_TREE }),
    "",
  );
  const { sourceFiles } = await prepareGodotInspectionCandidate(root);
  const byPath = new Map(sourceFiles.map((file) => [file.relativePath, file]));
  if (entries.length !== sourceFiles.length)
    throw new Error("GN-1 working files differ from the pinned Git tree");
  for (const entry of entries) {
    const file = byPath.get(entry.relativePath);
    if (
      file === undefined ||
      entry.byteLength !== file.bytes.byteLength ||
      file.executable !== (entry.mode === "100755") ||
      createHash("sha1")
        .update(`blob ${file.bytes.byteLength}\0`)
        .update(file.bytes)
        .digest("hex") !== entry.objectId
    )
      throw new Error(
        `GN-1 source does not match the pinned blob: ${entry.relativePath}`,
      );
  }
  return sourceFiles;
}

const VectorSchema = z.tuple([z.number().finite(), z.number().finite()]);
const ObservationSchema = z
  .object({
    platform: z.enum(PLATFORM_NAMES),
    width: z.number().int(),
    sprite_count: z.number().int().nonnegative(),
    solid_size: VectorSchema,
    solid_instance_id: z.string().regex(/^-?[1-9][0-9]*$/u),
    area_size: VectorSchema,
    area_instance_id: z.string().regex(/^-?[1-9][0-9]*$/u),
  })
  .strict();
const ContextSchema = z
  .object({
    main_scene: z.string().min(1).max(2048),
    global_autoload: z.literal("/root/Global"),
    // Engine's reported counter is distinct from the number of awaited signals.
    process_frame: z.number().int().nonnegative(),
    physics_frame: z.number().int().nonnegative(),
    settled_process_frames: z.literal(2),
    scope: z.literal(
      "initial platform dimensions and resource identity only; no input simulation",
    ),
  })
  .strict();
const SummarySchema = z
  .object({
    passed: z.boolean(),
    problems: z.array(z.string().min(1)).max(64),
    observed_platforms: z.literal(4),
  })
  .strict();

const completeProcess = (process: SrtCommandResult): boolean =>
  process.status === "exited" &&
  process.signal === null &&
  !process.timedOut &&
  !process.cancelled &&
  !process.stdoutTruncated &&
  !process.stderrTruncated;

export interface Gn1CheckAssessment {
  readonly outcome: "passed" | "assertions_failed" | "requires_review";
  readonly reason: string | null;
  readonly context: z.infer<typeof ContextSchema> | null;
  readonly observations: readonly z.infer<typeof ObservationSchema>[];
  readonly summary: z.infer<typeof SummarySchema> | null;
}

/** The checker output, not the Agent's final answer, determines this narrow result. */
export function assessGn1Check(
  importProcess: SrtCommandResult,
  result: SrtGodotProcessResult,
): Gn1CheckAssessment {
  try {
    if (
      !completeProcess(importProcess) ||
      importProcess.exitCode !== 0 ||
      !completeProcess(result.process) ||
      !result.sourceUnchanged ||
      result.sourceSha256 !== result.observedSourceSha256
    )
      throw new Error(
        "Import/runtime execution incomplete or staged source changed",
      );
    if (
      /(?:^|\n)(?:\u001b\[[0-9;]*m)*(?:SCRIPT )?ERROR:/u.test(
        `${importProcess.stderr}\n${result.process.stderr}`,
      )
    )
      throw new Error("Godot reported an import or runtime error");
    const lines = result.process.stdout
      .split(/\r?\n/u)
      .filter((line) => line.startsWith("GN1_CHECK_"));
    if (
      lines.length !== 6 ||
      !lines[0]?.startsWith("GN1_CHECK_CONTEXT ") ||
      !lines[5]?.startsWith("GN1_CHECK_RESULT ") ||
      lines
        .slice(1, 5)
        .some((line) => !line.startsWith("GN1_CHECK_OBSERVATION "))
    )
      throw new Error(
        "Expected one context, four observations, and one result in order; missing, duplicate, or infrastructure output requires review",
      );
    const context = ContextSchema.parse(
      JSON.parse(lines[0].slice("GN1_CHECK_CONTEXT ".length)) as unknown,
    );
    const observations = lines
      .slice(1, 5)
      .map((line) =>
        ObservationSchema.parse(
          JSON.parse(line.slice("GN1_CHECK_OBSERVATION ".length)) as unknown,
        ),
      );
    const summary = SummarySchema.parse(
      JSON.parse(lines[5].slice("GN1_CHECK_RESULT ".length)) as unknown,
    );
    const expectedProblems: string[] = [];
    observations.forEach((observation, index) => {
      const name = PLATFORM_NAMES[index];
      const width = WIDTHS[index];
      if (
        name === undefined ||
        width === undefined ||
        observation.platform !== name
      )
        throw new Error(
          "Missing, duplicate, or reordered platform observation",
        );
      if (observation.width !== width)
        expectedProblems.push(`${name}: configured width differs`);
      if (observation.sprite_count !== width)
        expectedProblems.push(`${name}: sprite count differs`);
      if (
        observation.solid_size[0] !== width * 128 ||
        observation.solid_size[1] !== 128
      )
        expectedProblems.push(`${name}: solid size differs`);
      if (
        observation.area_size[0] !== width * 128 ||
        observation.area_size[1] !== 40
      )
        expectedProblems.push(`${name}: area size differs`);
    });
    for (let left = 0; left < observations.length; left += 1) {
      for (let right = left + 1; right < observations.length; right += 1) {
        if (
          observations[left]?.area_instance_id ===
          observations[right]?.area_instance_id
        )
          expectedProblems.push(
            `${PLATFORM_NAMES[left]} / ${PLATFORM_NAMES[right]}: area shape is shared`,
          );
      }
    }
    if (
      JSON.stringify(summary.problems) !== JSON.stringify(expectedProblems) ||
      summary.passed !== (expectedProblems.length === 0) ||
      result.process.exitCode !== (summary.passed ? 0 : 1)
    )
      throw new Error(
        "Checker result, observations, and process exit code disagree",
      );
    return {
      outcome: summary.passed ? "passed" : "assertions_failed",
      reason: null,
      context,
      observations,
      summary,
    };
  } catch (error) {
    return {
      outcome: "requires_review",
      reason: error instanceof Error ? error.message : String(error),
      context: null,
      observations: [],
      summary: null,
    };
  }
}

export function gn1CheckExitCode(
  baseline: Gn1CheckAssessment,
  candidate: Gn1CheckAssessment,
): 0 | 1 | 2 {
  if (
    baseline.outcome !== "assertions_failed" ||
    candidate.outcome === "requires_review"
  )
    return 2;
  return candidate.outcome === "passed" ? 0 : 1;
}

const save = (path: string, value: unknown): Promise<void> =>
  writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
const saveProcess = async (
  directory: string,
  prefix: string,
  result: SrtCommandResult,
): Promise<void> => {
  await save(join(directory, `${prefix}-process.json`), result);
  await writeFile(join(directory, `${prefix}-stdout.log`), result.stdout, {
    flag: "wx",
    mode: 0o600,
  });
  await writeFile(join(directory, `${prefix}-stderr.log`), result.stderr, {
    flag: "wx",
    mode: 0o600,
  });
};

const readOrdinaryFile = async (
  path: string,
  maxBytes: number,
): Promise<Buffer> => {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > maxBytes)
      throw new Error(
        "Input must be a bounded ordinary file, not a link or device",
      );
    const bytes = Buffer.alloc(before.size + 1);
    let count = 0;
    while (count < bytes.length) {
      const { bytesRead } = await handle.read(
        bytes,
        count,
        bytes.length - count,
        count,
      );
      if (bytesRead === 0) break;
      count += bytesRead;
    }
    const after = await handle.stat();
    if (
      count !== before.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      before.size !== after.size
    )
      throw new Error("Input changed while reading");
    return bytes.subarray(0, count);
  } finally {
    await handle.close();
  }
};

async function materialize(
  directory: string,
  files: readonly GodotValidationSourceFile[],
): Promise<void> {
  await mkdir(directory, { mode: 0o700 });
  for (const file of files) {
    await mkdir(dirname(join(directory, file.relativePath)), {
      recursive: true,
      mode: 0o700,
    });
    await writeFile(join(directory, file.relativePath), file.bytes, {
      flag: "wx",
      mode: file.executable ? 0o700 : 0o600,
    });
  }
}

async function runOne(input: {
  directory: string;
  workspace: string;
  files: readonly GodotValidationSourceFile[];
  checker: Uint8Array;
  godot: string;
  controller: SrtSandboxController;
  signal?: AbortSignal | undefined;
}): Promise<Gn1CheckAssessment> {
  await mkdir(input.directory, { mode: 0o700 });
  try {
    input.signal?.throwIfAborted();
    if (input.files.some((file) => file.relativePath === CHECKER_PATH))
      throw new Error(
        "Candidate occupies the independent checker's reserved path",
      );
    const runner = new SrtGodotRunner({
      controller: input.controller,
      candidateWorkspace: input.workspace,
      validationRoot: join(input.directory, "stages"),
    });
    const prepared = await runner.prepareImport({
      sourceFiles: [
        ...input.files,
        { relativePath: CHECKER_PATH, bytes: input.checker, executable: false },
      ],
      overlayFiles: [],
      godotPath: input.godot,
      timeoutMs: 120_000,
      signal: input.signal,
    });
    await saveProcess(input.directory, "import", prepared.process);
    input.signal?.throwIfAborted();
    const handle = await runner.open({
      sourceFiles: prepared.sourceFiles,
      importCacheFiles: prepared.importCacheFiles,
      argv: (stage) => [
        input.godot,
        "--headless",
        "--path",
        stage.projectStagePath,
        "--script",
        `res://${CHECKER_PATH}`,
      ],
      timeoutMs: 30_000,
      readOnlyPaths: [dirname(input.godot)],
      signal: input.signal,
    });
    handle.process.stdin.on("error", () => undefined);
    handle.process.stdin.end();
    const result = await handle.completion;
    await saveProcess(input.directory, "runtime", result.process);
    await save(join(input.directory, "source-integrity.json"), {
      sourceSha256: result.sourceSha256,
      observedSourceSha256: result.observedSourceSha256,
      sourceUnchanged: result.sourceUnchanged,
    });
    return assessGn1Check(prepared.process, result);
  } catch (error) {
    if (error instanceof GodotImportPreparationError && error.process !== null)
      await saveProcess(input.directory, "import", error.process);
    const reason = error instanceof Error ? error.message : String(error);
    await save(join(input.directory, "failure.json"), { reason });
    return {
      outcome: "requires_review",
      reason,
      context: null,
      observations: [],
      summary: null,
    };
  }
}

/** No Pi imports, provider calls, source-repository writes, or unsandboxed Godot. */
export async function checkGn1Preview(
  options: Gn1PreviewCheckOptions,
  dependencies: {
    snapshotBaseline?: typeof snapshotGn1Baseline;
    signal?: AbortSignal;
  } = {},
): Promise<{ readonly exitCode: 0 | 1 | 2; readonly directory: string }> {
  const stateRoot = join(REPOSITORY_DIRECTORY, ".chronorift");
  await mkdir(stateRoot, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(stateRoot, "gn1-preview-check-"));
  const startedAt = new Date().toISOString();
  let privateRoot: string | undefined;
  const controller = new SrtSandboxController({
    outputLimitBytes: 1024 * 1024,
  });
  let exitCode: 0 | 1 | 2 = 2;
  let details: Record<string, unknown> = {};
  const cleanupErrors: string[] = [];
  try {
    dependencies.signal?.throwIfAborted();
    const project = await realpath(options.project);
    const suppliedGodot = await realpath(options.godotBin);
    if (!(await stat(suppliedGodot)).isFile())
      throw new Error(
        "--godot-bin must resolve to an ordinary executable file",
      );
    await access(suppliedGodot, constants.X_OK);
    const snapshotBaseline =
      dependencies.snapshotBaseline ?? snapshotGn1Baseline;
    const sourceFiles = await snapshotBaseline(project);
    const baselineSourceSha256 = sourceHash(sourceFiles);
    const checker = await readOrdinaryFile(
      join(CASE_DIRECTORY, "independent-check.gd"),
      1024 * 1024,
    );
    if (sha256(checker) !== CHECKER_SHA256)
      throw new Error(
        "Published independent checker differs from the recorded checker",
      );
    const patch = await readOrdinaryFile(
      options.candidatePatch,
      8 * 1024 * 1024,
    );
    await writeFile(join(directory, "candidate.patch"), patch, {
      flag: "wx",
      mode: 0o600,
    });
    privateRoot = await mkdtemp(join(tmpdir(), "chronorift-gn1-check-"));
    // Do not grant dirname(userProvidedGodot): the binary could sit beside Host credentials.
    // This command accepts the official standalone executable, not an installation tree.
    const toolDirectory = join(privateRoot, "tools");
    await mkdir(toolDirectory, { mode: 0o700 });
    const godot = join(toolDirectory, "godot");
    const godotBytes = await readOrdinaryFile(suppliedGodot, 512 * 1024 * 1024);
    const godotExecutableSha256 = sha256(godotBytes);
    await writeFile(godot, godotBytes, { flag: "wx", mode: 0o700 });
    dependencies.signal?.throwIfAborted();
    const baselineWorkspace = join(privateRoot, "baseline");
    const candidateWorkspace = join(privateRoot, "candidate");
    await materialize(baselineWorkspace, sourceFiles);
    await materialize(candidateWorkspace, sourceFiles);
    if (patch.byteLength !== 0) {
      const git = new NodeHostGitPort();
      await git.initializeRepository({
        directory: candidateWorkspace,
        bare: false,
      });
      const handle = await open(
        join(directory, "candidate.patch"),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        await git.applyPatch({
          context: { cwd: candidateWorkspace },
          patch: handle,
          checkOnly: true,
        });
        await git.applyPatch({
          context: { cwd: candidateWorkspace },
          patch: handle,
          checkOnly: false,
        });
      } finally {
        await handle.close();
      }
    }
    const candidate = await prepareGodotInspectionCandidate(candidateWorkspace);
    const baselineResult = await runOne({
      directory: join(directory, "baseline"),
      workspace: baselineWorkspace,
      files: sourceFiles,
      checker,
      godot,
      controller,
      signal: dependencies.signal,
    });
    const candidateResult = await runOne({
      directory: join(directory, "candidate"),
      workspace: candidateWorkspace,
      files: candidate.sourceFiles,
      checker,
      godot,
      controller,
      signal: dependencies.signal,
    });
    const sourceUnchanged =
      sourceHash(await snapshotBaseline(project)) === baselineSourceSha256;
    exitCode =
      sourceUnchanged && dependencies.signal?.aborted !== true
        ? gn1CheckExitCode(baselineResult, candidateResult)
        : 2;
    details = {
      sourceCommit: GN1_COMMIT,
      sourceTree: GN1_TREE,
      baselineSourceSha256,
      candidateSourceSha256: sourceHash(candidate.sourceFiles),
      checkerSha256: sha256(checker),
      patchSha256: sha256(patch),
      godotExecutableSha256,
      inputSourceUnchanged: sourceUnchanged,
      cancelled: dependencies.signal?.aborted ?? false,
      baseline: baselineResult,
      candidate: candidateResult,
    };
  } catch (error) {
    exitCode = 2;
    details = {
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    try {
      await controller.close();
    } catch (error) {
      cleanupErrors.push(
        error instanceof Error ? error.message : String(error),
      );
    }
    try {
      if (privateRoot !== undefined)
        await rm(privateRoot, { recursive: true, force: true });
    } catch (error) {
      cleanupErrors.push(
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  if (cleanupErrors.length > 0) exitCode = 2;
  await save(join(directory, "result.json"), {
    schemaVersion: 1,
    kind: "gn1-preview-saved-candidate-check",
    startedAt,
    checkedAt: new Date().toISOString(),
    scope: SCOPE,
    modelInvoked: false,
    ...details,
    cleanupErrors,
    exitCode,
  });
  return { exitCode, directory };
}
