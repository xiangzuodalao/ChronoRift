import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assessGn1Check,
  checkGn1Preview,
  GN1_COMMIT,
  GN1_TREE,
  gn1CheckExitCode,
  parseGn1PreviewCheckArguments,
  snapshotGn1Baseline,
} from "./gn1-preview-check.js";
import { GodotImportPreparationError } from "./godot-import-preparation.js";
import { NodeHostGitPort } from "./host-git.js";
import {
  SrtGodotRunner,
  type SrtGodotProcessResult,
} from "./srt-godot-runner.js";
import {
  SrtSandboxController,
  type SrtCommandResult,
} from "./srt-sandbox-controller.js";

const processResult = (
  overrides: Partial<SrtCommandResult> = {},
): SrtCommandResult => ({
  status: "exited",
  exitCode: 0,
  signal: null,
  stdout: "",
  stderr: "",
  durationMs: 1,
  timedOut: false,
  cancelled: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  ...overrides,
});

function output(passed: boolean): string {
  const widths = [2, 1, 3, 6];
  const names = ["Platform", "Platform2", "Platform3", "Platform4"];
  const problems = passed
    ? []
    : [
        "Platform: area size differs",
        "Platform2: area size differs",
        "Platform3: area size differs",
        "Platform / Platform2: area shape is shared",
        "Platform / Platform3: area shape is shared",
        "Platform / Platform4: area shape is shared",
        "Platform2 / Platform3: area shape is shared",
        "Platform2 / Platform4: area shape is shared",
        "Platform3 / Platform4: area shape is shared",
      ];
  return [
    "Godot Engine v4.7.1.stable.official.a13da4feb - https://godotengine.org",
    `GN1_CHECK_CONTEXT ${JSON.stringify({ main_scene: "res://main.tscn", global_autoload: "/root/Global", process_frame: 2, physics_frame: 10, settled_process_frames: 2, scope: "initial platform dimensions and resource identity only; no input simulation" })}`,
    ...widths.map(
      (width, index) =>
        `GN1_CHECK_OBSERVATION ${JSON.stringify({ platform: names[index], width, sprite_count: width, solid_size: [width * 128, 128], solid_instance_id: `${index + 10}`, area_size: [passed ? width * 128 : 768, 40], area_instance_id: passed ? `${index + 100}` : "100" })}`,
    ),
    `GN1_CHECK_RESULT ${JSON.stringify({ passed, problems, observed_platforms: 4 })}`,
    "",
  ].join("\n");
}

const runtimeResult = (passed = true): SrtGodotProcessResult => ({
  process: processResult({ stdout: output(passed), exitCode: passed ? 0 : 1 }),
  sourceSha256: "a".repeat(64),
  observedSourceSha256: "a".repeat(64),
  sourceUnchanged: true,
});

describe("GN-1 saved candidate check arguments", () => {
  it("requires explicit local project and Godot, with the published patch as default", () => {
    const parsed = parseGn1PreviewCheckArguments([
      "--",
      "--project",
      "/project",
      "--godot-bin",
      "/godot",
    ]);
    expect(parsed).toMatchObject({ project: "/project", godotBin: "/godot" });
    expect(parsed.candidatePatch).toMatch(
      /docs\/case-studies\/gn1-preview\/candidate\.patch$/u,
    );
    expect(
      parseGn1PreviewCheckArguments([
        "--project",
        "/project",
        "--godot-bin",
        "/godot",
        "--candidate-patch",
        "/saved.patch",
      ]).candidatePatch,
    ).toBe("/saved.patch");
  });

  it.each([
    [],
    ["--project", "/project"],
    ["--godot-bin", "/godot"],
    ["--project", "/project", "--godot-bin", "/godot", "--model", "anything"],
    ["--project", "/project", "--project", "/other", "--godot-bin", "/godot"],
    ["--project", "--godot-bin", "/godot"],
    ["--project", "\0", "--godot-bin", "/godot"],
  ])("rejects incomplete or unsupported arguments: %j", (...args) => {
    expect(() => parseGn1PreviewCheckArguments(args)).toThrow();
  });
});

describe("independent GN-1 checker result", () => {
  it("accepts both exact published historical stdout files, including signed Godot IDs", async () => {
    const baseline = runtimeResult(false);
    const candidate = runtimeResult();
    const baselineStdout = await readFile(
      new URL(
        "../../../../docs/case-studies/gn1-preview/independent/baseline/stdout.log",
        import.meta.url,
      ),
      "utf8",
    );
    const candidateStdout = await readFile(
      new URL(
        "../../../../docs/case-studies/gn1-preview/independent/candidate/stdout.log",
        import.meta.url,
      ),
      "utf8",
    );
    expect(baselineStdout).toContain('"area_instance_id":"-');
    const before = assessGn1Check(processResult(), {
      ...baseline,
      process: { ...baseline.process, stdout: baselineStdout },
    });
    const after = assessGn1Check(processResult(), {
      ...candidate,
      process: { ...candidate.process, stdout: candidateStdout },
    });
    expect(before.outcome).toBe("assertions_failed");
    expect(after.outcome).toBe("passed");
    expect(gn1CheckExitCode(before, after)).toBe(0);
  });
  it("accepts the expected baseline failure and candidate pass, keeping clocks separate", () => {
    const baseline = assessGn1Check(processResult(), runtimeResult(false));
    const candidate = assessGn1Check(processResult(), runtimeResult());
    expect(baseline.outcome).toBe("assertions_failed");
    expect(baseline.summary?.problems).toHaveLength(9);
    expect(candidate.outcome).toBe("passed");
    expect(candidate.context).toMatchObject({
      process_frame: 2,
      physics_frame: 10,
    });
    expect(gn1CheckExitCode(baseline, candidate)).toBe(0);
    expect(gn1CheckExitCode(baseline, baseline)).toBe(1);
    expect(gn1CheckExitCode(candidate, candidate)).toBe(2);
  });

  it.each([0, 1])(
    "keeps reported process counter %i separate from the two awaited process-frame signals",
    (processFrame) => {
      const observations = [false, true].map((passed) => {
        const result = runtimeResult(passed);
        return assessGn1Check(processResult(), {
          ...result,
          process: {
            ...result.process,
            stdout: result.process.stdout.replace(
              '"process_frame":2',
              `"process_frame":${processFrame}`,
            ),
          },
        });
      });
      expect(observations[0]?.outcome).toBe("assertions_failed");
      expect(observations[1]?.outcome).toBe("passed");
      for (const observation of observations) {
        expect(observation.context).toMatchObject({
          process_frame: processFrame,
          settled_process_frames: 2,
        });
      }
    },
  );

  it.each([
    { stdoutTruncated: true },
    { stderrTruncated: true },
    { timedOut: true },
    { cancelled: true },
    { signal: "SIGTERM" as const },
    { status: "timed_out" as const },
    { exitCode: null },
    { stderr: "SCRIPT ERROR: failure" },
  ])("requires review for incomplete runtime output %j", (overrides) => {
    const result = runtimeResult();
    const assessment = assessGn1Check(processResult(), {
      ...result,
      process: { ...result.process, ...overrides },
    });
    expect(assessment.outcome).toBe("requires_review");
    expect(
      gn1CheckExitCode(
        assessGn1Check(processResult(), runtimeResult(false)),
        assessment,
      ),
    ).toBe(2);
  });

  it.each([
    { exitCode: 1 },
    { stdoutTruncated: true },
    { stderrTruncated: true },
    { timedOut: true },
    { signal: "SIGTERM" as const },
    { stderr: "ERROR: import failed" },
  ])("requires review for incomplete import %j", (overrides) => {
    expect(
      assessGn1Check(processResult(overrides), runtimeResult()).outcome,
    ).toBe("requires_review");
  });

  it("requires unchanged staged source and matching hashes", () => {
    expect(
      assessGn1Check(processResult(), {
        ...runtimeResult(),
        sourceUnchanged: false,
      }).outcome,
    ).toBe("requires_review");
    expect(
      assessGn1Check(processResult(), {
        ...runtimeResult(),
        observedSourceSha256: "b".repeat(64),
      }).outcome,
    ).toBe("requires_review");
  });

  it.each([
    (text: string) => text.replace("GN1_CHECK_CONTEXT ", "IGNORED_CONTEXT "),
    (text: string) => text + text,
    (text: string) => text + "GN1_CHECK_INFRASTRUCTURE_ERROR missing node\n",
    (text: string) =>
      text.replace('"observed_platforms":4', '"observed_platforms":3'),
    (text: string) =>
      text.replace('"platform":"Platform2"', '"platform":"Platform"'),
    (text: string) =>
      text.replace('"area_size":[256,40]', '"area_size":[768,40]'),
    (text: string) =>
      text.replace('"area_instance_id":"101"', '"area_instance_id":"100"'),
    (text: string) => text.replace('"passed":true', '"passed":false'),
    (text: string) =>
      text.replace('"settled_process_frames":2', '"settled_process_frames":1'),
    (text: string) => text.replace('"process_frame":2', '"process_frame":-1'),
    (text: string) =>
      text.replace('"problems":[]', '"problems":[],"agent_says":"fixed"'),
    () => "Agent says: fixed.\n",
  ])(
    "rejects missing, duplicated, malformed, or inconsistent observations",
    (mutate) => {
      const result = runtimeResult();
      expect(
        assessGn1Check(processResult(), {
          ...result,
          process: { ...result.process, stdout: mutate(result.process.stdout) },
        }).outcome,
      ).toBe("requires_review");
    },
  );

  it("does not allow final prose or an exit code to override failed observations", () => {
    const result = runtimeResult(false);
    expect(
      assessGn1Check(processResult(), {
        ...result,
        process: {
          ...result.process,
          stdout: `${result.process.stdout}\nAgent: fixed.`,
        },
      }).outcome,
    ).toBe("assertions_failed");
    expect(
      assessGn1Check(processResult(), {
        ...result,
        process: { ...result.process, exitCode: 0 },
      }).outcome,
    ).toBe("requires_review");
  });
});

describe("pinned GN-1 source snapshot", () => {
  const directories: string[] = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
      directories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  async function fixture() {
    const directory = await mkdtemp(
      join(tmpdir(), "chronorift-gn1-source-test-"),
    );
    directories.push(directory);
    const files = {
      "project.godot": '[application]\nrun/main_scene="res://main.tscn"\n',
      "main.tscn": '[gd_scene format=3]\n[node name="Main" type="Node2D"]\n',
    };
    for (const [name, text] of Object.entries(files))
      await writeFile(join(directory, name), text);
    const listing = Buffer.from(
      Object.entries(files)
        .map(
          ([name, text]) =>
            `100644 blob ${createHash("sha1")
              .update(`blob ${Buffer.byteLength(text)}\0`)
              .update(text)
              .digest("hex")} ${Buffer.byteLength(text)}\t${name}\0`,
        )
        .join(""),
    );
    const git = {
      resolveRepositoryRoot: vi.fn(async () => directory),
      resolveHeadCommit: vi.fn(async () => GN1_COMMIT),
      resolveHeadTree: vi.fn(async () => GN1_TREE),
      statusPorcelain: vi.fn(async () => Buffer.alloc(0)),
      listTree: vi.fn(async () => listing),
    };
    return { directory, git };
  }

  it("checks actual blobs and takes a detached byte snapshot without writing the input", async () => {
    const { directory, git } = await fixture();
    const files = await snapshotGn1Baseline(directory, git);
    expect(files.map((file) => file.relativePath)).toEqual([
      "main.tscn",
      "project.godot",
    ]);
    await writeFile(join(directory, "main.tscn"), "changed after snapshot");
    expect(Buffer.from(files[0]!.bytes).toString()).toContain("[gd_scene");
    await expect(snapshotGn1Baseline(directory, git)).rejects.toThrow(
      "pinned blob",
    );
  });

  it("rejects wrong commit, tree, and dirty status before copying", async () => {
    const { directory, git } = await fixture();
    git.resolveHeadCommit.mockResolvedValueOnce("0".repeat(40));
    await expect(snapshotGn1Baseline(directory, git)).rejects.toThrow(
      "checked out at commit",
    );
    git.resolveHeadTree.mockResolvedValueOnce("0".repeat(40));
    await expect(snapshotGn1Baseline(directory, git)).rejects.toThrow(
      "checked out at commit",
    );
    git.statusPorcelain.mockResolvedValueOnce(Buffer.from(" M main.tscn\0"));
    await expect(snapshotGn1Baseline(directory, git)).rejects.toThrow("clean");
  });

  it("rejects extra files even when Git status omitted them", async () => {
    const { directory, git } = await fixture();
    await writeFile(join(directory, "extra.gd"), "extends Node\n");
    await expect(snapshotGn1Baseline(directory, git)).rejects.toThrow(
      "working files differ",
    );
  });

  it("rejects unsafe source entries and link escapes", async () => {
    const { directory, git } = await fixture();
    await symlink("/etc/passwd", join(directory, "unsafe.gd"));
    await expect(snapshotGn1Baseline(directory, git)).rejects.toThrow();
  });

  async function commandFixture() {
    const { directory, git } = await fixture();
    vi.spyOn(
      NodeHostGitPort.prototype,
      "resolveRepositoryRoot",
    ).mockImplementation(git.resolveRepositoryRoot);
    vi.spyOn(NodeHostGitPort.prototype, "resolveHeadCommit").mockImplementation(
      git.resolveHeadCommit,
    );
    vi.spyOn(NodeHostGitPort.prototype, "resolveHeadTree").mockImplementation(
      git.resolveHeadTree,
    );
    vi.spyOn(NodeHostGitPort.prototype, "statusPorcelain").mockImplementation(
      git.statusPorcelain,
    );
    vi.spyOn(NodeHostGitPort.prototype, "listTree").mockImplementation(
      git.listTree,
    );
    const inputs = await mkdtemp(join(tmpdir(), "chronorift-gn1-patch-test-"));
    directories.push(inputs);
    const candidatePatch = join(inputs, "candidate.patch");
    const godotBin = join(inputs, "godot");
    await writeFile(godotBin, "standalone test executable", { mode: 0o700 });
    await writeFile(
      join(inputs, "host-sibling-canary.txt"),
      "harmless Host-only canary",
    );
    const toolCopies: {
      directory: string;
      entries: string[];
      bytes: string;
    }[] = [];
    await writeFile(
      candidatePatch,
      'diff --git a/main.tscn b/main.tscn\n--- a/main.tscn\n+++ b/main.tscn\n@@ -1,2 +1,3 @@\n [gd_scene format=3]\n [node name="Main" type="Node2D"]\n+# saved candidate\n',
    );
    const prepare = vi
      .spyOn(SrtGodotRunner.prototype, "prepareImport")
      .mockImplementation(async (input) => {
        toolCopies.push({
          directory: dirname(input.godotPath),
          entries: await readdir(dirname(input.godotPath)),
          bytes: await readFile(input.godotPath, "utf8"),
        });
        return {
          sourceFiles: [...input.sourceFiles],
          importCacheFiles: [],
          process: processResult(),
        };
      });
    const launch = vi
      .spyOn(SrtGodotRunner.prototype, "open")
      .mockImplementation(async (input) => {
        const passed =
          input.sourceFiles?.some(
            (file) =>
              file.relativePath === "main.tscn" &&
              Buffer.from(file.bytes).toString().includes("# saved candidate"),
          ) ?? false;
        const result = runtimeResult(passed);
        return {
          process: {
            pid: 1,
            stdin: new PassThrough(),
            stdout: new PassThrough(),
            stderr: new PassThrough(),
            wait: async () => result.process,
            stop: async () => result.process,
          },
          sourceSha256: result.sourceSha256,
          completion: Promise.resolve(result),
          terminate: async () => undefined,
        };
      });
    const close = vi
      .spyOn(SrtSandboxController.prototype, "close")
      .mockResolvedValue(undefined);
    return {
      directory,
      godotBin,
      candidatePatch,
      prepare,
      launch,
      close,
      toolCopies,
    };
  }

  it("checks a saved patch with fake Godot, stages the checker only, and leaves input unchanged", async () => {
    const fixture = await commandFixture();
    const before = await readFile(join(fixture.directory, "main.tscn"));
    const result = await checkGn1Preview({
      project: fixture.directory,
      godotBin: fixture.godotBin,
      candidatePatch: fixture.candidatePatch,
    });
    directories.push(result.directory);
    expect(result.exitCode).toBe(0);
    expect(await readFile(join(fixture.directory, "main.tscn"))).toEqual(
      before,
    );
    expect(fixture.prepare).toHaveBeenCalledTimes(2);
    expect(fixture.toolCopies).toHaveLength(2);
    for (const copy of fixture.toolCopies) {
      expect(copy.directory).not.toBe(dirname(fixture.godotBin));
      expect(copy.entries).toEqual(["godot"]);
      expect(copy.bytes).toBe("standalone test executable");
    }
    for (const [input] of fixture.launch.mock.calls)
      expect(input.readOnlyPaths).toEqual([fixture.toolCopies[0]?.directory]);
    for (const [input] of fixture.prepare.mock.calls) {
      expect(
        input.sourceFiles.filter(
          (file) => file.relativePath === "__gn1_check.gd",
        ),
      ).toHaveLength(1);
    }
    expect(
      await readFile(join(result.directory, "result.json"), "utf8"),
    ).toContain('"modelInvoked": false');
    expect(
      await readFile(
        join(result.directory, "candidate/runtime-stdout.log"),
        "utf8",
      ),
    ).toBe(output(true));
  });

  it("treats an empty patch as an unchanged candidate, not a successful fix", async () => {
    const fixture = await commandFixture();
    await writeFile(fixture.candidatePatch, "");
    const result = await checkGn1Preview({
      project: fixture.directory,
      godotBin: fixture.godotBin,
      candidatePatch: fixture.candidatePatch,
    });
    directories.push(result.directory);
    expect(result.exitCode).toBe(1);
  });

  it("preserves failed import output and never launches that runtime unsandboxed", async () => {
    const fixture = await commandFixture();
    fixture.prepare.mockRejectedValue(
      new GodotImportPreparationError(
        "sandbox/import failed",
        processResult({ exitCode: 2, stderr: "actual failure" }),
      ),
    );
    const result = await checkGn1Preview({
      project: fixture.directory,
      godotBin: fixture.godotBin,
      candidatePatch: fixture.candidatePatch,
    });
    directories.push(result.directory);
    expect(result.exitCode).toBe(2);
    expect(fixture.launch).not.toHaveBeenCalled();
    expect(
      await readFile(
        join(result.directory, "candidate/import-stderr.log"),
        "utf8",
      ),
    ).toBe("actual failure");
  });

  it("rejects a parent-traversal patch before launching Godot", async () => {
    const fixture = await commandFixture();
    await writeFile(
      fixture.candidatePatch,
      "diff --git a/../escaped.gd b/../escaped.gd\nnew file mode 100644\n--- /dev/null\n+++ b/../escaped.gd\n@@ -0,0 +1 @@\n+extends Node\n",
    );
    const result = await checkGn1Preview({
      project: fixture.directory,
      godotBin: fixture.godotBin,
      candidatePatch: fixture.candidatePatch,
    });
    directories.push(result.directory);
    expect(result.exitCode).toBe(2);
    expect(fixture.prepare).not.toHaveBeenCalled();
    expect(fixture.launch).not.toHaveBeenCalled();
  });

  it("rejects a patch that adds an unsafe symlink before staging", async () => {
    const fixture = await commandFixture();
    await writeFile(
      fixture.candidatePatch,
      "diff --git a/unsafe.gd b/unsafe.gd\nnew file mode 120000\n--- /dev/null\n+++ b/unsafe.gd\n@@ -0,0 +1 @@\n+/etc/passwd\n\\ No newline at end of file\n",
    );
    const result = await checkGn1Preview({
      project: fixture.directory,
      godotBin: fixture.godotBin,
      candidatePatch: fixture.candidatePatch,
    });
    directories.push(result.directory);
    expect(result.exitCode).toBe(2);
    expect(fixture.prepare).not.toHaveBeenCalled();
  });

  it("forwards cancellation, skips subsequent launch, and retains a review result", async () => {
    const fixture = await commandFixture();
    const cancellation = new AbortController();
    fixture.prepare.mockImplementationOnce(async (input) => {
      expect(input.signal).toBe(cancellation.signal);
      cancellation.abort(new Error("test interruption"));
      return {
        sourceFiles: [...input.sourceFiles],
        importCacheFiles: [],
        process: processResult(),
      };
    });
    const result = await checkGn1Preview(
      {
        project: fixture.directory,
        godotBin: fixture.godotBin,
        candidatePatch: fixture.candidatePatch,
      },
      { signal: cancellation.signal },
    );
    directories.push(result.directory);
    expect(result.exitCode).toBe(2);
    expect(fixture.prepare).toHaveBeenCalledTimes(1);
    expect(fixture.launch).not.toHaveBeenCalled();
    expect(fixture.close).toHaveBeenCalledOnce();
    const report: unknown = JSON.parse(
      await readFile(join(result.directory, "result.json"), "utf8"),
    );
    expect(report).toMatchObject({
      exitCode: 2,
      cancelled: true,
      baseline: { outcome: "requires_review" },
      candidate: { outcome: "requires_review" },
    });
  });

  it("does not suppress the final report when cleanup fails", async () => {
    const fixture = await commandFixture();
    fixture.close.mockRejectedValue(new Error("cleanup failed"));
    const result = await checkGn1Preview({
      project: fixture.directory,
      godotBin: fixture.godotBin,
      candidatePatch: fixture.candidatePatch,
    });
    directories.push(result.directory);
    expect(result.exitCode).toBe(2);
    const report: unknown = JSON.parse(
      await readFile(join(result.directory, "result.json"), "utf8"),
    );
    expect(report).toMatchObject({
      exitCode: 2,
      cleanupErrors: ["cleanup failed"],
      candidate: { outcome: "passed" },
    });
  });
});
