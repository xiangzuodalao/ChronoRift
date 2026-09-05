import { describe, expect, it } from "vitest";

import {
  createProjectEnvironmentToolCallAdmissionV1,
  createVNextCodingToolDefinitions,
  ProjectEnvironmentToolCallBudgetExhaustedErrorV1,
  type CodingToolResult,
  type VNextCodingToolPort,
} from "../src/index.js";

const ok = (stdout = ""): CodingToolResult => ({
  stdout: Buffer.from(stdout),
  stderr: new Uint8Array(),
  exitCode: 0,
  status: "succeeded",
});

class MemoryPort implements VNextCodingToolPort {
  public readonly files = new Map<string, Uint8Array>([
    ["src/a.ts", Buffer.from("one\ntwo\nthree\n")],
  ]);
  public readonly calls: string[] = [];

  public read(path: string): Promise<CodingToolResult> {
    this.calls.push(`read:${path}`);
    const bytes = this.files.get(path);
    return Promise.resolve(
      bytes === undefined
        ? { ...ok(), status: "failed", exitCode: 1 }
        : { ...ok(), stdout: bytes },
    );
  }
  public bash(
    command: string,
    options: Parameters<VNextCodingToolPort["bash"]>[1],
  ): Promise<CodingToolResult> {
    this.calls.push(`bash:${command}:${String(options.timeoutMs)}`);
    options.onOutput?.(Buffer.from("streamed"));
    return Promise.resolve(ok("streamed"));
  }
  public write(path: string, content: Uint8Array): Promise<CodingToolResult> {
    this.calls.push(`write:${path}`);
    this.files.set(path, Uint8Array.from(content));
    return Promise.resolve(ok());
  }
  public grep(
    request: Parameters<VNextCodingToolPort["grep"]>[0],
  ): Promise<CodingToolResult> {
    this.calls.push(`grep:${request.path}:${request.limit}`);
    return Promise.resolve(ok("src/a.ts:2:two\n"));
  }
  public find(
    request: Parameters<VNextCodingToolPort["find"]>[0],
  ): Promise<CodingToolResult> {
    this.calls.push(`find:${request.path}:${request.limit}`);
    return Promise.resolve(ok("src/a.ts\n"));
  }
  public ls(
    request: Parameters<VNextCodingToolPort["ls"]>[0],
  ): Promise<CodingToolResult> {
    this.calls.push(`ls:${request.path}:${request.limit}`);
    return Promise.resolve(ok("src/\n"));
  }
}

const execute = async (
  port: MemoryPort,
  name: string,
  params: Record<string, unknown>,
  onUpdate?: (text: string) => void,
) => {
  const tool = createVNextCodingToolDefinitions(port).find(
    (entry) => entry.name === name,
  );
  if (tool === undefined) throw new Error(`missing tool ${name}`);
  return tool.execute(
    "call_fixture",
    params,
    undefined,
    onUpdate === undefined
      ? undefined
      : (update) =>
          onUpdate(
            update.content[0]?.type === "text" ? update.content[0].text : "",
          ),
    {} as never,
  );
};

describe("vNext sandboxed Pi coding tools", () => {
  it("registers exactly the seven normal coding tools", () => {
    const names = createVNextCodingToolDefinitions(new MemoryPort()).map(
      (tool) => tool.name,
    );
    expect(names).toEqual([
      "read",
      "bash",
      "edit",
      "write",
      "grep",
      "find",
      "ls",
    ]);
  });

  it("rejects the first over-budget coding call before reaching the broker", async () => {
    const port = new MemoryPort();
    const admission = createProjectEnvironmentToolCallAdmissionV1(1);
    const tools = createVNextCodingToolDefinitions(port, {
      toolCallAdmission: admission,
    });
    const read = tools.find((tool) => tool.name === "read");
    const bash = tools.find((tool) => tool.name === "bash");
    if (read === undefined || bash === undefined) {
      throw new Error("missing budget test tools");
    }

    await read.execute(
      "call:read",
      { path: "src/a.ts" },
      undefined,
      undefined,
      {} as never,
    );
    await expect(
      bash.execute(
        "call:bash",
        { command: "must-not-run" },
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toMatchObject({
      code: "budget_exhausted",
      limit: 1,
      name: ProjectEnvironmentToolCallBudgetExhaustedErrorV1.name,
    });
    expect(port.calls).toEqual(["read:src/a.ts"]);
    expect(admission).toMatchObject({
      admitted: 1,
      rejected: 1,
      attempted: 2,
      exhausted: true,
    });
  });

  it("reads with Pi-compatible one-based offsets and rejects Host paths before the port", async () => {
    const port = new MemoryPort();
    const result = await execute(port, "read", {
      path: "src/a.ts",
      offset: 2,
      limit: 1,
    });
    expect(result.content).toEqual([{ type: "text", text: "two" }]);
    await expect(
      execute(port, "read", { path: "/etc/passwd" }),
    ).rejects.toThrow(/relative workspace/u);
    await expect(execute(port, "read", { path: "../secret" })).rejects.toThrow(
      /relative workspace/u,
    );
    expect(port.calls).toEqual(["read:src/a.ts"]);
  });

  it("returns a failed command result to the Agent without continuing the operation", async () => {
    const port = new MemoryPort();
    const result = await execute(port, "read", { path: "missing.ts" });
    expect(result.content).toEqual([
      {
        type: "text",
        text: "read failed (failed, exitCode=1)",
      },
    ]);
    expect(result.details).toEqual({});
  });

  it("serializes writes and applies unique exact edits against the original file", async () => {
    const port = new MemoryPort();
    const written = await execute(port, "write", {
      path: "src/new.ts",
      content: "alpha\nbéta\n",
    });
    expect(written.content).toEqual([
      {
        type: "text",
        text: "Successfully wrote 12 bytes to src/new.ts",
      },
    ]);
    const edited = await execute(port, "edit", {
      path: "src/new.ts",
      edits: [
        { oldText: "alpha", newText: "ALPHA" },
        { oldText: "béta", newText: "BETA" },
      ],
    });
    expect(Buffer.from(port.files.get("src/new.ts")!).toString("utf8")).toBe(
      "ALPHA\nBETA\n",
    );
    expect(edited.details).toMatchObject({ firstChangedLine: 1 });
    await expect(
      execute(port, "edit", {
        path: "src/new.ts",
        edits: [{ oldText: "A", newText: "x" }],
      }),
    ).rejects.toThrow(/exactly once/u);
  });

  it("forwards Bash streaming and bounded search/list requests without a tool order", async () => {
    const port = new MemoryPort();
    const updates: string[] = [];
    await execute(port, "bash", { command: "make test", timeout: 3 }, (value) =>
      updates.push(value),
    );
    await Promise.all([
      execute(port, "grep", { pattern: "two" }),
      execute(port, "find", { pattern: "*.ts", limit: 7 }),
      execute(port, "ls", {}),
    ]);
    expect(updates).toEqual(["streamed"]);
    expect(port.calls).toEqual(
      expect.arrayContaining([
        "bash:make test:3000",
        "grep:.:100",
        "find:.:7",
        "ls:.:500",
      ]),
    );
  });

  it("normalizes an explicit empty optional search path to the workspace root", async () => {
    const port = new MemoryPort();

    await Promise.all([
      execute(port, "grep", { pattern: "two", path: "" }),
      execute(port, "find", { pattern: "*.ts", path: "" }),
      execute(port, "ls", { path: "" }),
    ]);

    expect(port.calls).toEqual(
      expect.arrayContaining(["grep:.:100", "find:.:1000", "ls:.:500"]),
    );
  });
});
