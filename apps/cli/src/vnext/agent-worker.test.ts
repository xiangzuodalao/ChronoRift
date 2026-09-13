import { execFileSync, spawn } from "node:child_process";
import { getDefaultResultOrder, setDefaultResultOrder } from "node:dns";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { AgentWorkerMessage } from "./agent-ipc.js";
import {
  agentWorkerEnvironment,
  agentWorkerRuntimeArguments,
  attachAgentWorkerClient,
} from "./agent-worker-client.js";

const bridgeUrl = new URL("./agent-worker.ts", import.meta.url).href;
const fixtureSource = `
import { runAgentWorkerBridge } from ${JSON.stringify(bridgeUrl)};
let current, resolveIdle;
let messages = [];
let text = '';
let count = 0;
const factory = async (options) => ({
  sessionId: 'fixture', sessionFile: '/host/fixture.jsonl', activeTools: ['read'],
  isIdle: () => current === undefined,
  prompt: async (prompt) => {
    count += 1;
    current = new AbortController();
    try {
      const result = await options.tools[0].execute('call-' + count, { prompt }, current.signal);
      text = 'turn ' + count + ': ' + result.content[0].text + '; messages ' + messages.join(',');
    } catch (error) { text = 'cancelled ' + count; }
    finally { current = undefined; resolveIdle?.(); }
  },
  sendMessage: async (message) => { messages.push(message); },
  deliverCollaboration: async (message) => {
    if (message.kind === 'task' && !current) return 'next-turn';
    messages.push(message.text);
    return current ? 'current-turn' : 'next-turn';
  },
  exportForkContext: (forkTurns) => ({schemaVersion:1,parentSessionId:'fixture',forkTurns,messages:[{role:'user',text:'inspect',turnStart:true}]}),
  subscribeConsumption: () => () => {},
  subscribeCollaborationPhase: () => () => {},
  abort: async () => { current?.abort(); },
  waitForIdle: async () => { if (current) await new Promise((resolve) => { resolveIdle = resolve; }); },
  snapshot: (status) => ({
    schemaVersion: 1, status: status ?? 'completed', sessionId: 'fixture', sessionFile: '/host/fixture.jsonl',
    provider: 'fixture', model: 'fixture', requestedThinkingLevel: 'off', realizedThinkingLevel: 'off',
    activeTools: ['read'], assistantText: text, errorMessage: null, eventsObserved: count, stats: { tokens: {input:0,output:0,cacheRead:0,cacheWrite:0,total:0}, cost: 0 }
  }),
  dispose: () => {}, subscribe: () => () => {}
});
runAgentWorkerBridge({
  send: (message) => new Promise((resolve, reject) => process.send(message, (error) => error ? reject(error) : resolve())),
  onMessage: (listener) => process.on('message', listener),
  onDisconnect: (listener) => process.once('disconnect', listener),
  disconnect: () => { if (process.connected) process.disconnect(); }
}, factory);
`;

describe("trusted agent worker", () => {
  it("passes Host DNS ordering to a real child without inheriting Node loaders", () => {
    const original = getDefaultResultOrder();
    try {
      for (const order of ["ipv4first", "verbatim"] as const) {
        setDefaultResultOrder(order);
        const output = execFileSync(
          process.execPath,
          [
            ...agentWorkerRuntimeArguments(),
            "-e",
            "process.stdout.write(require('node:dns').getDefaultResultOrder())",
          ],
          {
            env: agentWorkerEnvironment({
              NODE_OPTIONS: "--import /untrusted/must-not-load.mjs",
            }),
            encoding: "utf8",
            timeout: 5_000,
          },
        );
        expect(output).toBe(order);
      }
    } finally {
      setDefaultResultOrder(original);
    }
  });
  it("strips inherited runtime code loading options while retaining Host model authentication", () => {
    expect(
      agentWorkerEnvironment({
        HOME: "/host",
        OPENAI_API_KEY: "fixture-only",
        NODE_OPTIONS: "--import /project/attack.mjs",
        NODE_PATH: "/project",
        TSX_TSCONFIG_PATH: "/project/tsconfig.json",
        TS_NODE_PROJECT: "/project",
      }),
    ).toEqual({ HOME: "/host", OPENAI_API_KEY: "fixture-only" });
  });

  it("runs persistent Sessions in a real child process and accepts messages/cancellation while a tool is pending", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chronorift-worker-ipc-"));
    const entry = join(directory, "fixture.mjs");
    await writeFile(entry, fixtureSource);
    const messages: AgentWorkerMessage[] = [];
    const exits: Error[] = [];
    const child = spawn(
      process.execPath,
      ["--import", createRequire(import.meta.url).resolve("tsx"), entry],
      {
        cwd: directory,
        env: { PATH: process.env.PATH ?? "" },
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        serialization: "json",
      },
    );
    const waitMessage = async (
      predicate: (message: AgentWorkerMessage) => boolean,
    ): Promise<AgentWorkerMessage> => {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const found = messages.find(predicate);
        if (found !== undefined) return found;
        if (exits.length !== 0) throw exits[0] ?? new Error("Worker exited");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error("Timed out waiting for fixture IPC");
    };
    let client;
    try {
      client = await attachAgentWorkerClient(child, {
        configuration: {
          resourceWorkspaceDirectory: directory,
          sessionDirectory: directory,
          provider: "fixture",
          model: "fixture",
          thinkingLevel: "off",
          tools: [
            {
              name: "read",
              description: "Read fixture observation",
              parameters: {
                type: "object",
                properties: { prompt: { type: "string" } },
              },
            },
          ],
        },
        onMessage: (message) => {
          messages.push(message);
        },
        onExit: (error) => {
          exits.push(error);
        },
      });
      await client.send({
        version: 2,
        type: "prompt",
        turnId: 1,
        text: "inspect",
      });
      const first = await waitMessage(
        (message) => message.type === "tool_request" && message.turnId === 1,
      );
      if (first.type !== "tool_request")
        throw new Error("Expected a tool request");
      await client.send({
        version: 2,
        type: "collaboration",
        requestId: "correction",
        envelope: {
          id: "correction",
          kind: "message",
          from: "/root",
          to: "/root/worker",
          text: "root correction",
          createdAt: new Date().toISOString(),
        },
      });
      expect(
        await waitMessage(
          (message) =>
            message.type === "collaboration_accepted" &&
            message.requestId === "correction",
        ),
      ).toMatchObject({ acceptedInCurrentTurn: true });
      await client.send({
        version: 2,
        type: "tool_result",
        turnId: 1,
        requestId: first.requestId,
        result: { content: [{ type: "text", text: "real Host observation" }] },
      });
      expect(
        await waitMessage(
          (message) => message.type === "completed" && message.turnId === 1,
        ),
      ).toMatchObject({
        result: {
          assistantText:
            "turn 1: real Host observation; messages root correction",
        },
      });
      await client.send({
        version: 2,
        type: "export_context",
        requestId: "fork",
        forkTurns: "all",
      });
      expect(
        await waitMessage((message) => message.type === "context_exported"),
      ).toMatchObject({
        requestId: "fork",
        context: { parentSessionId: "fixture", forkTurns: "all" },
      });
      await client.send({
        version: 2,
        type: "collaboration",
        requestId: "idle-task",
        envelope: {
          id: "idle-task",
          kind: "task",
          from: "/root",
          to: "/root/worker",
          text: "next task",
          createdAt: new Date().toISOString(),
        },
      });
      expect(
        await waitMessage(
          (message) =>
            message.type === "collaboration_accepted" &&
            message.requestId === "idle-task",
        ),
      ).toMatchObject({ acceptedInCurrentTurn: false });
      await client.send({
        version: 2,
        type: "prompt",
        turnId: 2,
        text: "continue",
      });
      await waitMessage(
        (message) => message.type === "tool_request" && message.turnId === 2,
      );
      await client.send({ version: 2, type: "interrupt", turnId: 2 });
      expect(
        await waitMessage(
          (message) => message.type === "completed" && message.turnId === 2,
        ),
      ).toMatchObject({
        result: { status: "aborted", assistantText: "cancelled 2" },
      });
      await client.send({
        version: 2,
        type: "prompt",
        turnId: 3,
        text: "recover",
      });
      const third = await waitMessage(
        (message) => message.type === "tool_request" && message.turnId === 3,
      );
      if (third.type !== "tool_request")
        throw new Error("Expected a tool request");
      // Old responses cannot complete a new turn's tool, even with a current ID.
      await client.send({
        version: 2,
        type: "tool_result",
        turnId: 1,
        requestId: third.requestId,
        result: { content: [{ type: "text", text: "stale" }] },
      });
      await client.send({
        version: 2,
        type: "tool_result",
        turnId: 3,
        requestId: third.requestId,
        result: { content: [{ type: "text", text: "fresh" }] },
      });
      expect(
        await waitMessage(
          (message) => message.type === "completed" && message.turnId === 3,
        ),
      ).toMatchObject({
        result: { assistantText: "turn 3: fresh; messages root correction" },
      });
    } finally {
      await client?.close();
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
      await rm(directory, { recursive: true, force: true });
    }
    expect(exits).toEqual([]);
  }, 20_000);
});
