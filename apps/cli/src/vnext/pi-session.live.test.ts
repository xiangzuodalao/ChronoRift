import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createVNextCodingToolDefinitions,
  runVNextPiTurnWithSdk,
  type BrokerToolResult,
  type VNextCodingToolPort,
} from "@chronorift/pi-harness";
import { afterEach, expect, test } from "vitest";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const result = (
  stdout: string,
  status: BrokerToolResult["status"] = "succeeded",
): BrokerToolResult => ({
  stdout: Buffer.from(stdout, "utf8"),
  stderr: new Uint8Array(),
  exitCode: status === "succeeded" ? 0 : 1,
  status,
  receipt: { schemaVersion: 1, kind: "vnext-pi-live-smoke" },
});

test("real Luna max drives the vNext Pi Session and consumes an actual tool result", async () => {
  const root = await mkdtemp(join(tmpdir(), "chronorift-vnext-pi-live-"));
  roots.push(root);
  const workspace = join(root, "workspace");
  const sessions = join(root, "pi-sessions");
  const agentDir = join(root, "agent");
  await Promise.all([mkdir(workspace), mkdir(sessions), mkdir(agentDir)]);
  const nonce = `chronorift-live-${randomUUID()}`;
  await writeFile(join(workspace, "live-nonce.txt"), `${nonce}\n`, "utf8");
  const observations: string[] = [];
  const port: VNextCodingToolPort = {
    read: (path) => {
      observations.push(`read:${path}`);
      return Promise.resolve(
        path === "live-nonce.txt" ? result(`${nonce}\n`) : result("", "failed"),
      );
    },
    bash: (command) => {
      observations.push(`bash:${command}`);
      return Promise.resolve(
        command.includes("live-nonce.txt")
          ? result(`${nonce}\n`)
          : result("", "failed"),
      );
    },
    write: (path) => {
      observations.push(`write:${path}`);
      return Promise.resolve(result("", "failed"));
    },
    grep: (request) => {
      observations.push(`grep:${request.path}`);
      return Promise.resolve(result(`live-nonce.txt:1:${nonce}\n`));
    },
    find: (request) => {
      observations.push(`find:${request.path}`);
      return Promise.resolve(result("live-nonce.txt\n"));
    },
    ls: (request) => {
      observations.push(`ls:${request.path}`);
      return Promise.resolve(result("live-nonce.txt\n"));
    },
  };

  const turn = await runVNextPiTurnWithSdk({
    resourceWorkspaceDirectory: workspace,
    sessionDirectory: sessions,
    agentDir,
    provider: "openai-codex",
    model: "gpt-5.6-luna",
    thinkingLevel: "max",
    prompt:
      "Inspect the task workspace with the available tools, obtain the exact contents of live-nonce.txt, and report that value. Do not guess.",
    tools: createVNextCodingToolDefinitions(port),
    timeoutMs: 180_000,
  });

  expect(turn.status).toBe("completed");
  expect(turn.provider).toBe("openai-codex");
  expect(turn.model).toBe("gpt-5.6-luna");
  expect(turn.requestedThinkingLevel).toBe("max");
  expect(turn.realizedThinkingLevel).toBe("max");
  expect(turn.assistantText).toContain(nonce);
  expect(turn.stats.tokens.total).toBeGreaterThan(0);
  expect(turn.stats.toolCalls).toBeGreaterThan(0);
  expect(observations.length).toBeGreaterThan(0);
  expect((await stat(turn.sessionFile)).isFile()).toBe(true);
});
