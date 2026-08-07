import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { SandboxExecutionRequestV1 } from "./contracts.js";
import { SandboxPiCodingToolPort } from "./pi-coding-tool-port.js";
import type {
  SandboxExecutionOptionsV1,
  SandboxExecutionResultV1,
  TaskSandboxBrokerV1,
} from "./sandbox-broker.js";

const executed = (input: {
  readonly request: SandboxExecutionRequestV1;
  readonly stdout?: string | undefined;
  readonly stderr?: string | undefined;
  readonly status?: "succeeded" | "failed" | undefined;
  readonly exitCode?: number | undefined;
}): SandboxExecutionResultV1 => {
  const stdout = Buffer.from(input.stdout ?? "", "utf8");
  const stderr = Buffer.from(input.stderr ?? "", "utf8");
  return {
    kind: "executed",
    stdout,
    stderr,
    receipt: {
      operationId: input.request.operationId,
      requested: input.request,
      status: input.status ?? "succeeded",
      exitCode: input.exitCode ?? 0,
    },
  } as unknown as SandboxExecutionResultV1;
};

class RecordingBroker implements TaskSandboxBrokerV1 {
  public readonly calls: Array<{
    readonly request: SandboxExecutionRequestV1;
    readonly options: SandboxExecutionOptionsV1 | undefined;
  }> = [];
  public results: Array<
    Pick<
      Parameters<typeof executed>[0],
      "stdout" | "stderr" | "status" | "exitCode"
    >
  > = [];

  public execute(
    request: SandboxExecutionRequestV1,
    options?: SandboxExecutionOptionsV1,
  ): Promise<SandboxExecutionResultV1> {
    this.calls.push({ request, options });
    return Promise.resolve(executed({ request, ...this.results.shift() }));
  }

  public cleanup() {
    return Promise.resolve({
      processGroupTerminated: true,
      cgroupPopulated: false,
      termSent: false,
      killSent: false,
      scopeRemoved: true,
    });
  }
}

describe("SandboxPiCodingToolPort", () => {
  it("routes read, Bash, and atomic writes through the task broker", async () => {
    const broker = new RecordingBroker();
    broker.results.push({ stdout: "source\n" }, { stdout: "done\n" }, {});
    const port = new SandboxPiCodingToolPort(broker);
    const streamed: Uint8Array[] = [];

    await port.read("src/main.ts");
    await port.bash("npm test", {
      timeoutMs: 4_000,
      onOutput: (chunk) => streamed.push(chunk),
    });
    const content = Buffer.from([0, 1, 2, 255]);
    await port.write("src/data.bin", content);

    expect(broker.calls[0]?.request.argv).toEqual([
      "/bin/busybox",
      "cat",
      "--",
      "/workspace/src/main.ts",
    ]);
    expect(broker.calls[1]?.request).toMatchObject({
      argv: ["/bin/bash", "-c", "npm test"],
      timeoutMs: 4_000,
      cwd: "/workspace",
    });
    expect(broker.calls[1]?.options?.onStdoutChunk).toBeDefined();
    expect(broker.calls[1]?.options?.onStderrChunk).toBeDefined();
    expect(broker.calls[2]?.request.argv).toEqual([
      "/bin/busybox",
      "sh",
      "-c",
      expect.stringContaining("chronorift-tmp"),
      "chronorift-write",
      "/workspace/src/data.bin",
    ]);
    expect(broker.calls[2]?.request.stdin).toEqual({
      byteLength: content.byteLength,
      sha256: createHash("sha256").update(content).digest("hex"),
    });
    expect(Array.from(broker.calls[2]?.options?.stdin ?? [])).toEqual(
      Array.from(content),
    );
    expect(broker.calls[2]?.request).not.toHaveProperty("stdin.bytes");
    expect(streamed).toEqual([]);
  });

  it("uses GNU search tools, applies result bounds, and preserves an rg no-match receipt", async () => {
    const broker = new RecordingBroker();
    broker.results.push(
      { status: "failed", exitCode: 1 },
      { stdout: "a.ts\nb.ts\nc.ts\n" },
      { stdout: "src/\nREADME.md\npackage.json\n" },
    );
    const port = new SandboxPiCodingToolPort(broker);

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

    expect(broker.calls[0]?.request.argv).toEqual([
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
      "/workspace",
    ]);
    expect(grep.status).toBe("succeeded");
    expect(grep.exitCode).toBe(1);
    expect(grep.receipt).toMatchObject({ status: "failed", exitCode: 1 });
    expect(Buffer.from(find.stdout).toString("utf8")).toBe("a.ts\nb.ts");
    expect(find.resultLimitReached).toBe(2);
    expect(Buffer.from(ls.stdout).toString("utf8")).toBe("src/\nREADME.md");
    expect(ls.resultLimitReached).toBe(2);
  });

  it("rejects Host and traversal paths before the broker sees them", async () => {
    const broker = new RecordingBroker();
    const port = new SandboxPiCodingToolPort(broker);

    expect(() => port.read("/etc/passwd")).toThrow(/relative workspace path/u);
    expect(() => port.write("../outside", Buffer.from("no", "utf8"))).toThrow(
      /relative workspace path/u,
    );
    expect(broker.calls).toHaveLength(0);
  });
});
