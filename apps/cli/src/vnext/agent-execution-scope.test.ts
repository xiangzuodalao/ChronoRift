import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import {
  AgentExecutionBudget,
  AgentExecutionScope,
  AgentWorkspaceGate,
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
  candidateGate?: AgentWorkspaceGate,
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
    ...(candidateGate === undefined ? {} : { candidateGate }),
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
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  const freeze = vi.fn(async () => "snapshot");
  const snapshot = value.candidateGate.run(freeze);
  expect(freeze).not.toHaveBeenCalled();
  release();
  await coding;
  expect(await snapshot).toBe("snapshot");
  await value.close();
});

it("serializes shared candidate operations and snapshots across scopes", async () => {
  let release!: () => void;
  const calls: string[] = [];
  const controller = {
    runCoding: vi.fn(async () => {
      calls.push("coding");
      if (calls.length === 1)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      return result;
    }),
  } as unknown as SrtSandboxController;
  const candidateGate = new AgentWorkspaceGate();
  const budget = new AgentExecutionBudget();
  const a = await scope(controller, budget, undefined, candidateGate);
  const b = await scope(controller, budget, undefined, candidateGate);
  const first = callRead(a);
  await vi.waitFor(() => expect(calls).toEqual(["coding"]));
  const second = callRead(b);
  await Promise.resolve();
  const snapshot = candidateGate.run(async () => {
    calls.push("snapshot");
  });
  expect(calls).toEqual(["coding"]);
  await vi.waitFor(() =>
    expect(b.telemetry.records[0]?.lockRequestedAt).not.toBeNull(),
  );
  expect(b.telemetry.records[0]?.lockAcquiredAt).toBeNull();
  release();
  await Promise.all([first, second, snapshot]);
  expect(calls).toEqual(["coding", "coding", "snapshot"]);
  expect(b.telemetry.records[0]).toMatchObject({
    name: "read",
    outcome: "returned",
  });
  expect(b.telemetry.records[0]!.lockAcquiredAt).toBeTypeOf("string");
  expect(b.telemetry.records[0]!.finishedAt).toBeTypeOf("string");
  expect(b.telemetry.records[0]!.workspaceLockWaitMs).toBeGreaterThan(0);
  await Promise.all([a.close(), b.close()]);
});

it("cancels a shared-lock waiter without waiting for or stopping its sibling", async () => {
  let release!: () => void;
  let siblingSignal: AbortSignal | undefined;
  const runCoding = vi.fn(async (request: SrtCodingRequest) => {
    siblingSignal = request.signal;
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return result;
  });
  const controller = { runCoding } as unknown as SrtSandboxController;
  const candidateGate = new AgentWorkspaceGate();
  const budget = new AgentExecutionBudget();
  const a = await scope(controller, budget, undefined, candidateGate);
  const b = await scope(controller, budget, undefined, candidateGate);
  const first = callRead(b);
  await vi.waitFor(() => expect(runCoding).toHaveBeenCalledOnce());
  const waiting = expect(callRead(a)).rejects.toThrow("cancelled");
  await a.cancel();
  await waiting;
  expect(siblingSignal?.aborted).toBe(false);
  expect(budget.used).toBe(1);
  expect(a.telemetry.records[0]).toMatchObject({
    name: "read",
    lockAcquiredAt: null,
    outcome: "threw",
  });
  expect(a.telemetry.records[0]!.finishedAt).toBeTypeOf("string");
  release();
  await first;
  await candidateGate.idle();
  expect(runCoding).toHaveBeenCalledOnce();
  await Promise.all([a.close(), b.close()]);
});

it("drains Host patch writes on close and rejects queued workspace operations", async () => {
  const value = await scope({
    runCoding: vi.fn(async () => result),
  } as unknown as SrtSandboxController);
  let release!: () => void;
  const active = value.runWorkspaceOperation(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  const queuedOperation = vi.fn(async () => undefined);
  const queued = value.runWorkspaceOperation(queuedOperation);
  const rejected = expect(queued).rejects.toThrow("cancelled");
  let closed = false;
  const closing = value.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  release();
  await Promise.all([active, rejected, closing]);
  expect(queuedOperation).not.toHaveBeenCalled();
  expect(closed).toBe(true);
});

it("cancels a queued Host operation through its tool signal without cancelling the active operation", async () => {
  const value = await scope({
    runCoding: vi.fn(async () => result),
  } as unknown as SrtSandboxController);
  let release!: () => void;
  let activeSignal: AbortSignal | undefined;
  const active = value.runWorkspaceOperation((signal) => {
    activeSignal = signal;
    return new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  const abort = new AbortController();
  const queuedOperation = vi.fn(async () => undefined);
  const queued = value.runWorkspaceOperation(queuedOperation, abort.signal);
  const cancelled = expect(queued).rejects.toMatchObject({ code: "cancelled" });
  try {
    abort.abort();
    await cancelled;
    expect(activeSignal?.aborted).toBe(false);
    expect(queuedOperation).not.toHaveBeenCalled();
  } finally {
    release();
    await active;
    await value.close();
  }
  expect(queuedOperation).not.toHaveBeenCalled();
});
