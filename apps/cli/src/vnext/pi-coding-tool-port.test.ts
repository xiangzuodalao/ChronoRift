import { describe, expect, it } from "vitest";

import { SandboxPiCodingToolPort } from "./pi-coding-tool-port.js";
import type {
  SrtCodingRequest,
  SrtCommandResult,
  SrtSandboxController,
} from "./srt-sandbox-controller.js";

const paths = Object.freeze({
  workspacePath: "/tmp/chronorift-task/candidate",
  homePath: "/tmp/chronorift-task/home",
  tempPath: "/tmp/chronorift-task/tmp",
  artifactsPath: "/tmp/chronorift-task/artifacts",
});

type QueuedResult = Partial<SrtCommandResult> & {
  readonly streamed?: readonly string[] | undefined;
};

class RecordingController implements Pick<SrtSandboxController, "runCoding"> {
  public readonly calls: SrtCodingRequest[] = [];
  public readonly results: QueuedResult[] = [];

  public async runCoding(request: SrtCodingRequest): Promise<SrtCommandResult> {
    this.calls.push(request);
    const next = this.results.shift() ?? {};
    for (const chunk of next.streamed ?? []) {
      request.onOutput?.(Buffer.from(chunk, "utf8"));
    }
    return {
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
      ...next,
    };
  }
}

describe("SandboxPiCodingToolPort", () => {
  it("runs read, Bash, and atomic writes in the physical candidate workspace", async () => {
    const controller = new RecordingController();
    controller.results.push(
      { stdout: "source\n" },
      { stdout: "done\n", streamed: ["do", "ne\n"] },
      {},
    );
    const port = new SandboxPiCodingToolPort(controller, paths);
    const streamed: Uint8Array[] = [];

    await port.read("src/main.ts");
    await port.bash("npm test", {
      timeoutMs: 4_000,
      onOutput: (chunk) => streamed.push(chunk),
    });
    const content = Buffer.from([0, 1, 2, 255]);
    await port.write("src/data.bin", content);

    expect(controller.calls[0]?.argv).toEqual([
      "/usr/bin/cat",
      "--",
      "src/main.ts",
    ]);
    expect(controller.calls[0]).toMatchObject({
      cwd: paths.workspacePath,
      ...paths,
    });
    expect(controller.calls[1]).toMatchObject({
      argv: ["/bin/bash", "-c", "npm test"],
      cwd: paths.workspacePath,
      timeoutMs: 4_000,
    });
    expect(controller.calls[2]?.argv).toEqual([
      "/bin/bash",
      "-c",
      expect.stringContaining("chronorift-tmp"),
      "chronorift-write",
      "src/data.bin",
    ]);
    const writeStdin = controller.calls[2]?.stdin;
    if (!(writeStdin instanceof Uint8Array)) {
      throw new Error("expected binary write stdin");
    }
    expect(Array.from(writeStdin)).toEqual(Array.from(content));
    expect(
      streamed.map((chunk) => Buffer.from(chunk).toString("utf8")),
    ).toEqual(["do", "ne\n"]);
  });

  it("maps SRT process outcomes without manufacturing execution receipts", async () => {
    const controller = new RecordingController();
    controller.results.push(
      { status: "exited", exitCode: 7, stderr: "failed" },
      { status: "timed_out", exitCode: null, timedOut: true },
      { status: "cancelled", exitCode: null, cancelled: true },
    );
    const port = new SandboxPiCodingToolPort(controller, paths);

    await expect(port.bash("exit 7", {})).resolves.toEqual({
      stdout: Buffer.from(""),
      stderr: Buffer.from("failed"),
      exitCode: 7,
      status: "failed",
    });
    await expect(port.bash("sleep 10", {})).resolves.toMatchObject({
      exitCode: null,
      status: "timed_out",
    });
    await expect(port.bash("sleep 10", {})).resolves.toMatchObject({
      exitCode: null,
      status: "cancelled",
    });
  });

  it("uses physical paths for search tools and applies result bounds", async () => {
    const controller = new RecordingController();
    controller.results.push(
      { exitCode: 1 },
      { stdout: "a.ts\nb.ts\nc.ts\n" },
      { stdout: "src/\nREADME.md\npackage.json\n" },
    );
    const port = new SandboxPiCodingToolPort(controller, paths);

    const grep = await port.grep({
      pattern: "needle",
      path: ".",
      glob: "*.ts",
      ignoreCase: true,
      literal: true,
      context: 2,
      limit: 10,
    });
    const find = await port.find({ pattern: "*.ts", path: ".", limit: 2 });
    const ls = await port.ls({ path: ".", limit: 2 });

    expect(controller.calls[0]?.argv).toEqual([
      "/usr/bin/rg",
      "--line-number",
      "--color=never",
      "--ignore-case",
      "--fixed-strings",
      "--context",
      "2",
      "--glob",
      "*.ts",
      "--",
      "needle",
      ".",
    ]);
    expect(grep).toMatchObject({
      status: "succeeded",
      exitCode: 1,
      stdout: new Uint8Array(),
    });
    expect(Buffer.from(find.stdout).toString("utf8")).toBe("a.ts\nb.ts");
    expect(find.resultLimitReached).toBe(2);
    expect(Buffer.from(ls.stdout).toString("utf8")).toBe("src/\nREADME.md");
    expect(ls.resultLimitReached).toBe(2);
  });

  it("rejects Host and traversal paths before SRT sees them", async () => {
    const controller = new RecordingController();
    const port = new SandboxPiCodingToolPort(controller, paths);

    expect(() => port.read("/etc/passwd")).toThrow(/relative workspace path/u);
    expect(() => port.write("../outside", Buffer.from("no", "utf8"))).toThrow(
      /relative workspace path/u,
    );
    expect(controller.calls).toHaveLength(0);
  });

  it("rejects non-absolute Task paths at construction", () => {
    const controller = new RecordingController();
    expect(
      () =>
        new SandboxPiCodingToolPort(controller, {
          ...paths,
          workspacePath: "relative",
        }),
    ).toThrow(/workspacePath must be an absolute path/u);
  });
});
