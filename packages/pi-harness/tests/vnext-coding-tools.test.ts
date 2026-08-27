import { createHash } from "node:crypto";

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
    if (request.path === ".chronorift/adapter-candidate/schemas") {
      return Promise.resolve(
        ok(
          [...this.files.keys()]
            .filter(
              (path) =>
                path.startsWith(`${request.path}/`) &&
                path.endsWith(request.pattern.slice(1)),
            )
            .sort()
            .map((path) => `${path}\n`)
            .join(""),
        ),
      );
    }
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

  it("finalizes only explicitly enabled V2 adapter schema hashes", async () => {
    const port = new MemoryPort();
    const schemaPath = ".chronorift/adapter-candidate/schemas/state.actor.json";
    const schemaBytes = Buffer.from(
      '{"schemaVersion":2,"dialect":"chronorift://schemas/project-adapter-payload/v2","schemaId":"state.actor","root":{"type":"object","properties":{},"required":[],"additionalProperties":false}}\n',
    );
    port.files.set(schemaPath, schemaBytes);
    port.files.set(
      ".chronorift/adapter-candidate/manifest.json",
      Buffer.from(
        JSON.stringify({
          schemaVersion: 2,
          adapterId: "changed",
          sdk: { id: "changed", version: 99 },
          engine: {
            id: "godot",
            versionRequirement: "4.7.1",
            language: "gdscript",
          },
          launchTargets: [
            {
              targetId: "main",
              scene: "res://changed.tscn",
              default: true,
              renderer: "other",
              parametersSchemaId: "state.actor",
            },
            {
              targetId: "challenge",
              scene: "res://challenge.tscn",
              default: false,
              renderer: "other",
              parametersSchemaId: "state.actor",
            },
          ],
          entityTypes: [{ entityTypeId: "actor", schemaId: "state.actor" }],
          stateDomains: [
            { stateDomainId: "actor-state", schemaId: "state.actor" },
          ],
          eventTypes: [{ eventTypeId: "changed", schemaId: "state.actor" }],
          schemas: [
            {
              schemaVersion: 2,
              schemaId: "state.actor",
              path: "schemas/state.actor.json",
              sha256: "0".repeat(64),
            },
          ],
        }),
      ),
    );
    const tools = createVNextCodingToolDefinitions(port, {
      projectAdapterFinalizeV2: {
        adapterId: "adapter.bound",
        mainScene: "res://main.tscn",
        selectedLaunchTargetId: "challenge",
      },
    });
    expect(tools.map((tool) => tool.name)).toContain(
      "project_adapter_finalize_v2",
    );
    const finalize = tools.find(
      (tool) => tool.name === "project_adapter_finalize_v2",
    );
    if (finalize === undefined) throw new Error("missing V2 finalizer");
    await finalize.execute(
      "call:finalize",
      {},
      undefined,
      undefined,
      {} as never,
    );
    const manifest = JSON.parse(
      Buffer.from(
        port.files.get(".chronorift/adapter-candidate/manifest.json")!,
      ).toString("utf8"),
    ) as {
      adapterId: string;
      sdk: { id: string; version: number };
      engine: { versionRequirement: string };
      launchTargets: { scene: string; default: boolean; renderer: string }[];
      schemas: { sha256: string }[];
    };
    expect(manifest.adapterId).toBe("adapter.bound");
    expect(manifest.sdk).toEqual({
      id: "chronorift-project-adapter-sdk",
      version: 2,
    });
    expect(manifest.engine.versionRequirement).toBe("4.7.x");
    expect(manifest.launchTargets).toEqual([
      {
        targetId: "main",
        scene: "res://main.tscn",
        default: true,
        parametersSchemaId: "state.actor",
        renderer: "headless",
      },
      {
        targetId: "challenge",
        scene: "res://challenge.tscn",
        default: false,
        parametersSchemaId: "state.actor",
        renderer: "headless",
      },
    ]);
    expect(manifest.schemas[0]?.sha256).toBe(
      createHash("sha256").update(schemaBytes).digest("hex"),
    );
    expect(port.calls).toEqual([
      "read:.chronorift/adapter-candidate/manifest.json",
      "find:.chronorift/adapter-candidate/schemas:65",
      `read:${schemaPath}`,
      "write:.chronorift/adapter-candidate/manifest.json",
    ]);

    const edit = tools.find((tool) => tool.name === "edit");
    const write = tools.find((tool) => tool.name === "write");
    const bash = tools.find((tool) => tool.name === "bash");
    const read = tools.find((tool) => tool.name === "read");
    if (
      edit === undefined ||
      write === undefined ||
      bash === undefined ||
      read === undefined
    )
      throw new Error("missing coding tools after V2 finalization");
    await expect(
      edit.execute(
        "call:late-edit",
        { path: "src/a.ts", edits: [{ oldText: "one", newText: "late" }] },
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toMatchObject({ code: "candidate_frozen" });
    await expect(
      write.execute(
        "call:late-write",
        { path: "src/late.ts", content: "late" },
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toMatchObject({ code: "candidate_frozen" });
    await expect(
      bash.execute(
        "call:late-bash",
        { command: "true" },
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toMatchObject({ code: "candidate_frozen" });
    await expect(
      finalize.execute(
        "call:late-finalize",
        {},
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toMatchObject({ code: "candidate_frozen" });
    const postFinalizeRead = await read.execute(
      "call:post-finalize-read",
      { path: "src/a.ts" },
      undefined,
      undefined,
      {} as never,
    );
    expect(JSON.stringify(postFinalizeRead.content)).toContain("one");
    expect(port.calls).toEqual([
      "read:.chronorift/adapter-candidate/manifest.json",
      "find:.chronorift/adapter-candidate/schemas:65",
      `read:${schemaPath}`,
      "write:.chronorift/adapter-candidate/manifest.json",
      "read:src/a.ts",
    ]);
  });

  it("rejects an undeclared selected V2 launch target before freezing", async () => {
    const port = new MemoryPort();
    port.files.set(
      ".chronorift/adapter-candidate/manifest.json",
      Buffer.from(
        JSON.stringify({
          schemaVersion: 2,
          sdk: {},
          engine: {},
          schemas: [],
          launchTargets: [
            {
              targetId: "main",
              scene: "res://main.tscn",
              default: true,
            },
          ],
        }),
      ),
    );
    const finalize = createVNextCodingToolDefinitions(port, {
      projectAdapterFinalizeV2: {
        adapterId: "adapter.bound",
        mainScene: "res://main.tscn",
        selectedLaunchTargetId: "missing",
      },
    }).find((tool) => tool.name === "project_adapter_finalize_v2");
    if (finalize === undefined) throw new Error("missing V2 finalizer");

    await expect(
      finalize.execute("call:finalize", {}, undefined, undefined, {} as never),
    ).rejects.toThrow(
      "ProjectAdapter V2 selected launch target is not declared: missing",
    );
    expect(port.calls).toEqual([
      "read:.chronorift/adapter-candidate/manifest.json",
    ]);
  });

  it("requires exactly one default across V2 launch targets", async () => {
    const port = new MemoryPort();
    port.files.set(
      ".chronorift/adapter-candidate/manifest.json",
      Buffer.from(
        JSON.stringify({
          schemaVersion: 2,
          sdk: {},
          engine: {},
          schemas: [],
          launchTargets: [
            { targetId: "main", default: true },
            { targetId: "challenge", default: true },
          ],
        }),
      ),
    );
    const finalize = createVNextCodingToolDefinitions(port, {
      projectAdapterFinalizeV2: {
        adapterId: "adapter.bound",
        mainScene: "res://main.tscn",
      },
    }).find((tool) => tool.name === "project_adapter_finalize_v2");
    if (finalize === undefined) throw new Error("missing V2 finalizer");

    await expect(
      finalize.execute("call:finalize", {}, undefined, undefined, {} as never),
    ).rejects.toThrow(
      "ProjectAdapter V2 manifest must declare exactly one default launch target",
    );
  });

  it("rebuilds declarations from the exact physical schema inventory", async () => {
    const port = new MemoryPort();
    port.files.set(
      ".chronorift/adapter-candidate/schemas/state.json",
      Buffer.from(
        '{"schemaVersion":2,"dialect":"chronorift://schemas/project-adapter-payload/v2","schemaId":"state.actor","root":{"type":"object","properties":{},"required":[],"additionalProperties":false}}\n',
      ),
    );
    port.files.set(
      ".chronorift/adapter-candidate/schemas/stale.json",
      Buffer.from(
        '{"schemaVersion":2,"dialect":"chronorift://schemas/project-adapter-payload/v2","schemaId":"event.actor","root":{"type":"object","properties":{},"required":[],"additionalProperties":false}}\n',
      ),
    );
    port.files.set(
      ".chronorift/adapter-candidate/manifest.json",
      Buffer.from(
        JSON.stringify({
          schemaVersion: 2,
          adapterId: "changed",
          sdk: { id: "chronorift-project-adapter-sdk", version: 2 },
          engine: {
            id: "godot",
            versionRequirement: "4.7.x",
            language: "gdscript",
          },
          launchTargets: [
            {
              targetId: "main",
              scene: "res://changed.tscn",
              default: true,
              renderer: "other",
              parametersSchemaId: "state.actor",
            },
          ],
          entityTypes: [{ entityTypeId: "actor", schemaId: "state.actor" }],
          stateDomains: [
            { stateDomainId: "actor-state", schemaId: "state.actor" },
          ],
          eventTypes: [{ eventTypeId: "changed", schemaId: "event.actor" }],
          schemas: [
            {
              path: "schemas/state.json",
              sha256: "0".repeat(64),
            },
          ],
        }),
      ),
    );
    const finalize = createVNextCodingToolDefinitions(port, {
      projectAdapterFinalizeV2: {
        adapterId: "adapter.bound",
        mainScene: "res://main.tscn",
      },
    }).find((tool) => tool.name === "project_adapter_finalize_v2");
    if (finalize === undefined) throw new Error("missing V2 finalizer");
    await finalize.execute(
      "call:finalize",
      {},
      undefined,
      undefined,
      {} as never,
    );
    const manifest = JSON.parse(
      Buffer.from(
        port.files.get(".chronorift/adapter-candidate/manifest.json")!,
      ).toString("utf8"),
    ) as { schemas: { schemaId: string; path: string }[] };
    expect(manifest.schemas).toEqual([
      expect.objectContaining({
        schemaId: "event.actor",
        path: "schemas/stale.json",
      }),
      expect.objectContaining({
        schemaId: "state.actor",
        path: "schemas/state.json",
      }),
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
