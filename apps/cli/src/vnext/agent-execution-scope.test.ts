import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import {
  AgentExecutionBudget,
  AgentExecutionScope,
} from "./agent-execution-scope.js";
import type {
  SrtCodingRequest,
  SrtSandboxController,
} from "./srt-sandbox-controller.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
const result = {
  status: "exited" as const,
  exitCode: 0,
  signal: null,
  stdout: "ok",
  stderr: "",
  durationMs: 1,
  timedOut: false,
  cancelled: false,
  stdoutTruncated: false,
  stderrTruncated: false,
};
async function scope(
  controller: SrtSandboxController,
  budget = new AgentExecutionBudget(),
  taskRoot?: string,
) {
  const root = await mkdtemp(join(tmpdir(), "agent-scope-"));
  roots.push(root);
  const value = new AgentExecutionScope({
    controller,
    taskRootDirectory: taskRoot ?? root,
    workspaceDirectory: join(root, "workspace"),
    temporaryDirectory: join(root, "tmp"),
    artifactsDirectory: join(root, "artifacts"),
    recordsDirectory: join(root, "records"),
    validationDirectory: join(root, "validation"),
    nodePath: process.execPath,
    godotPath: "/host/godot",
    budget,
  });
  await value.initialize();
  return value;
}
const callRead = (value: AgentExecutionScope, id = "read") =>
  value
    .tools()
    .find((tool) => tool.name === "read")!
    .execute(id, { path: "project.godot" }, undefined, undefined, {} as never);

it("binds the namespace even outside default deny roots and shares the execution budget", async () => {
  const runCoding = vi.fn(async () => result);
  const controller = { runCoding } as unknown as SrtSandboxController;
  const budget = new AgentExecutionBudget(2);
  const a = await scope(controller, budget, "/outside-default-deny/task");
  const b = await scope(controller, budget, "/outside-default-deny/task");
  await Promise.all([callRead(a), callRead(b)]);
  expect(runCoding.mock.calls).toHaveLength(2);
  const requests = runCoding.mock.calls as unknown as [SrtCodingRequest][];
  expect(requests.map(([request]) => request.isolationReadRoots)).toEqual([
    ["/outside-default-deny/task"],
    ["/outside-default-deny/task"],
  ]);
  expect(requests[0]![0].workspacePath).not.toBe(requests[1]![0].workspacePath);
  await expect(callRead(a)).rejects.toThrow(/budget exhausted/u);
  expect(budget.used).toBe(2);
  expect(() => budget.admit("game_stop")).not.toThrow();
  await Promise.all([a.close(), b.close()]);
});

it("interrupts only the owning agent and allows its next turn", async () => {
  const requests: SrtCodingRequest[] = [];
  const controller = {
    runCoding: vi.fn((request: SrtCodingRequest) => {
      requests.push(request);
      return new Promise<typeof result>((resolve) => {
        request.signal!.addEventListener("abort", () => resolve(result), {
          once: true,
        });
      });
    }),
  } as unknown as SrtSandboxController;
  const a = await scope(controller);
  const b = await scope(controller);
  const first = callRead(a);
  const second = callRead(b);
  await vi.waitFor(() => expect(requests).toHaveLength(2));
  await a.cancel();
  await first;
  expect(requests[0]!.signal!.aborted).toBe(true);
  expect(requests[1]!.signal!.aborted).toBe(false);
  const next = callRead(a, "next");
  await vi.waitFor(() => expect(requests).toHaveLength(3));
  expect(requests[2]!.signal!.aborted).toBe(false);
  await Promise.all([a.close(), b.close()]);
  await Promise.all([second, next]);
  await expect(callRead(a)).rejects.toThrow(/cancelled/u);
});

it("waits for a coding command before entering the snapshot gate", async () => {
  let release!: () => void;
  const controller = {
    runCoding: vi.fn(
      () =>
        new Promise<typeof result>((resolve) => {
          release = () => resolve(result);
        }),
    ),
  } as unknown as SrtSandboxController;
  const value = await scope(controller);
  const coding = callRead(value);
  const freeze = vi.fn(async () => "snapshot");
  const snapshot = value.gate.run(freeze);
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  expect(freeze).not.toHaveBeenCalled();
  release();
  await coding;
  expect(await snapshot).toBe("snapshot");
  await value.close();
});
