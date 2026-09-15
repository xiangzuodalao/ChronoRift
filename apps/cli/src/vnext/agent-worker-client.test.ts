import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { afterEach, expect, it, vi } from "vitest";

import type { AgentHostMessage } from "./agent-ipc.js";
import { attachAgentWorkerClient } from "./agent-worker-client.js";

afterEach(() => vi.useRealTimers());

async function fixture() {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    connected: true,
    pid: 12345,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill: vi.fn<ChildProcess["kill"]>(() => false),
    send(message: AgentHostMessage, callback: (error: Error | null) => void) {
      void Promise.resolve().then(() => {
        callback(null);
        if (message.type === "initialize")
          child.emit("message", { version: 2, type: "ready" });
      });
    },
  });
  const client = await attachAgentWorkerClient(
    child as unknown as ChildProcess,
    {
      configuration: {
        resourceWorkspaceDirectory: "/host/candidate",
        sessionDirectory: "/host/sessions",
        provider: "fixture",
        model: "fixture",
        thinkingLevel: "off",
        tools: [],
      },
      onMessage: () => undefined,
      onExit: () => undefined,
    },
  );
  return { child, client };
}

it("allows Host cleanup to retry after a kill failure while successful close stays idempotent", async () => {
  vi.useFakeTimers();
  const { child, client } = await fixture();
  child.kill
    .mockImplementationOnce(() => {
      throw new Error("temporary kill failure");
    })
    .mockImplementation(() => {
      if (child.signalCode === null) {
        child.signalCode = "SIGKILL";
        child.emit("exit", null, "SIGKILL");
      }
      return true;
    });
  const failed = expect(client.close()).rejects.toThrow(
    "temporary kill failure",
  );
  await vi.advanceTimersByTimeAsync(2_000);
  await failed;
  const retried = client.close();
  await vi.advanceTimersByTimeAsync(2_000);
  await retried;
  const kills = child.kill.mock.calls.length;
  await client.close();
  expect(child.kill).toHaveBeenCalledTimes(kills);
});

it("reports unconfirmed process exit instead of waiting forever or declaring cleanup complete", async () => {
  vi.useFakeTimers();
  const { child, client } = await fixture();
  const failed = expect(client.close()).rejects.toThrow(
    "exit was not confirmed",
  );
  await vi.advanceTimersByTimeAsync(4_000);
  await failed;
  expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  child.signalCode = "SIGKILL";
  child.emit("exit", null, "SIGKILL");
  await client.close();
});
