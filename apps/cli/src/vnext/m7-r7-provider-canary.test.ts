import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  projectVNextPiFailureV1,
  VNEXT_PI_LIFECYCLE_STAGES,
  VNextPiTurnFailure,
  type VNextPiHostHttpTransportObservationV1,
  type VNextPiLifecycleEventV1,
} from "@chronorift/pi-harness";
import { afterEach, describe, expect, it } from "vitest";

import {
  executeM7R7ProviderCanaryProgramBoundaryV1,
  parseM7R7ProviderCanaryReceiptBytesV1,
  runM7R7ProviderCanaryOnceV1,
  type M7R7ProviderCanaryDependenciesV1,
} from "./m7-r7-provider-canary.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const transportObservation = (input: {
  readonly requestStartedCount: number;
  readonly responseHeadersCount: number;
  readonly responseCompleteCount: number;
  readonly requestErrorCount: number;
}): VNextPiHostHttpTransportObservationV1 => {
  const basis = {
    schemaVersion: 1 as const,
    recordKind: "vnext-pi-host-http-transport-observation" as const,
    ...input,
  };
  return {
    ...basis,
    recordContentSha256: createHash("sha256")
      .update(JSON.stringify(basis), "utf8")
      .digest("hex"),
  };
};

const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "chronorift-r7-canary-test-"));
  roots.push(root);
  await chmod(root, 0o700);
  const receiptRoot = join(root, "receipts");
  const taskStorageRoot = join(root, "task-storage");
  const agentDir = join(root, "agent");
  await Promise.all(
    [receiptRoot, taskStorageRoot, agentDir].map((path) =>
      mkdir(path, { mode: 0o700 }),
    ),
  );
  return {
    receiptPath: join(receiptRoot, "provider-canary.v1.json"),
    taskStorageRoot,
    agentDir,
  };
};

const lifecycle = (): readonly VNextPiLifecycleEventV1[] =>
  VNEXT_PI_LIFECYCLE_STAGES.map((stage, index) => ({
    schemaVersion: 1,
    ordinal: index + 1,
    stage,
  }));

const stats = (sessionFile: string) => ({
  sessionFile,
  sessionId: "m7-r7-provider-canary-fixture",
  userMessages: 1,
  assistantMessages: 1,
  toolCalls: 1,
  toolResults: 1,
  totalMessages: 3,
  tokens: {
    input: 3,
    output: 2,
    cacheRead: 0,
    cacheWrite: 0,
    total: 5,
  },
  cost: 0,
});

const dependencies = (
  runTurn: M7R7ProviderCanaryDependenciesV1["runTurn"],
): Partial<M7R7ProviderCanaryDependenciesV1> => {
  const uuids = [
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
  ];
  const timestamps = ["2026-08-16T00:00:00.000Z", "2026-08-16T00:00:01.000Z"];
  return {
    runTurn,
    uuid: () => uuids.shift()!,
    now: () => timestamps.shift()!,
    requireTaskStorageTmpfs: async () => undefined,
  };
};

describe("M7 R7 provider canary", () => {
  it("does not print an in-memory provider failure at the program boundary", async () => {
    const stderr: string[] = [];
    const status = await executeM7R7ProviderCanaryProgramBoundaryV1(
      async () => {
        throw new Error("SECRET provider response and credential material");
      },
      (message) => stderr.push(message),
    );

    expect(status).toBe(1);
    expect(stderr).toEqual([
      "M7 R7 provider canary failed; inspect its sanitized receipt\n",
    ]);
    expect(stderr.join("")).not.toContain("SECRET");
  });

  it("sanitizes the executable stderr boundary in a real subprocess", async () => {
    const input = await fixture();
    const secretPath = join(
      input.taskStorageRoot,
      "SECRET-provider-response-and-token.json",
    );
    const child = spawn(
      process.execPath,
      [
        join(process.cwd(), "node_modules/tsx/dist/cli.mjs"),
        join(process.cwd(), "apps/cli/src/vnext/m7-r7-provider-canary.ts"),
        "--validate-receipt",
        secretPath,
      ],
      {
        cwd: process.cwd(),
        env: {
          HOME: "/nonexistent",
          LANG: "C.UTF-8",
          LC_ALL: "C.UTF-8",
          PATH: process.env.PATH,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const exitCode = await new Promise<number | null>((resolvePromise) => {
      child.once("close", resolvePromise);
    });

    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toBe(
      "M7 R7 provider canary failed; inspect its sanitized receipt\n",
    );
    expect(stderr).not.toContain("SECRET");
  });

  it("retains exact production transport counts without retaining nonce or prose", async () => {
    const input = await fixture();
    let rawNonce = "";
    const receipt = await runM7R7ProviderCanaryOnceV1(
      input,
      dependencies(async (request) => {
        expect(request.transport).toBe("sse");
        for (const event of lifecycle()) request.onLifecycleEvent(event);
        const toolResult = await request.port.read("canary.txt");
        rawNonce = Buffer.from(toolResult.stdout).toString("utf8").trim();
        const sessionFile = join(request.sessionDirectory, "session.jsonl");
        await writeFile(sessionFile, "transient session\n", { mode: 0o600 });
        return {
          schemaVersion: 1,
          status: "completed",
          sessionId: request.newSessionId,
          sessionFile,
          provider: "openai-codex",
          model: "gpt-5.6-luna",
          requestedThinkingLevel: "max",
          realizedThinkingLevel: "max",
          activeTools: ["read"],
          assistantText: `ready ${rawNonce}`,
          errorMessage: null,
          eventsObserved: 4,
          observedTurnCount: 1,
          stats: stats(sessionFile),
          hostHttpTransportObservation: transportObservation({
            requestStartedCount: 2,
            responseHeadersCount: 2,
            responseCompleteCount: 0,
            requestErrorCount: 2,
          }),
        };
      }),
    );

    expect(receipt.status).toBe("passed");
    expect(receipt.observations.hostHttpTransportObservation).toMatchObject({
      requestStartedCount: 2,
      responseHeadersCount: 2,
      responseCompleteCount: 0,
      requestErrorCount: 2,
    });
    expect(receipt.observations.sessionCleanupProven).toBe(true);
    expect(await readdir(input.taskStorageRoot)).toEqual([]);
    const bytes = await readFile(input.receiptPath);
    expect(parseM7R7ProviderCanaryReceiptBytesV1(bytes)).toEqual(receipt);
    expect(bytes.toString("utf8")).not.toContain(rawNonce);
    expect(bytes.toString("utf8")).not.toContain("ready ");
  });

  it("retains a sanitized failed turn and its failed transport counts", async () => {
    const input = await fixture();
    const events = lifecycle().slice(0, 4);
    const source = new Error("SECRET provider failure");
    await expect(
      runM7R7ProviderCanaryOnceV1(
        input,
        dependencies(async (request) => {
          for (const event of events) request.onLifecycleEvent(event);
          throw new VNextPiTurnFailure(
            {
              schemaVersion: 1,
              recordKind: "vnext-pi-turn-failure",
              stage: "authentication_check",
              lifecycle: events,
              primaryFailure: projectVNextPiFailureV1(
                source,
                "authentication_check",
              ),
              cleanupFailures: [],
              hostHttpTransportObservation: transportObservation({
                requestStartedCount: 1,
                responseHeadersCount: 0,
                responseCompleteCount: 0,
                requestErrorCount: 1,
              }),
            },
            { cause: source },
          );
        }),
      ),
    ).rejects.toThrow("provider canary failed");

    const bytes = await readFile(input.receiptPath);
    const receipt = parseM7R7ProviderCanaryReceiptBytesV1(bytes);
    expect(receipt.status).toBe("failed");
    expect(receipt.failure).toMatchObject({
      stage: "authentication_check",
      primaryFailure: { category: "provider" },
    });
    expect(receipt.observations.hostHttpTransportObservation).toMatchObject({
      requestStartedCount: 1,
      requestErrorCount: 1,
    });
    expect(bytes.toString("utf8")).not.toContain("SECRET");
    expect(await readdir(input.taskStorageRoot)).toEqual([]);
  });

  it("fails closed after a completed turn with inconsistent transport counts", async () => {
    const input = await fixture();
    await expect(
      runM7R7ProviderCanaryOnceV1(
        input,
        dependencies(async (request) => {
          for (const event of lifecycle()) request.onLifecycleEvent(event);
          const toolResult = await request.port.read("canary.txt");
          const nonce = Buffer.from(toolResult.stdout).toString("utf8").trim();
          const sessionFile = join(request.sessionDirectory, "session.jsonl");
          await writeFile(sessionFile, "transient session\n", { mode: 0o600 });
          return {
            schemaVersion: 1,
            status: "completed",
            sessionId: request.newSessionId,
            sessionFile,
            provider: "openai-codex",
            model: "gpt-5.6-luna",
            requestedThinkingLevel: "max",
            realizedThinkingLevel: "max",
            activeTools: ["read"],
            assistantText: nonce,
            errorMessage: null,
            eventsObserved: 1,
            observedTurnCount: 1,
            stats: stats(sessionFile),
            hostHttpTransportObservation: transportObservation({
              requestStartedCount: 2,
              responseHeadersCount: 1,
              responseCompleteCount: 1,
              requestErrorCount: 0,
            }),
          };
        }),
      ),
    ).rejects.toThrow("provider canary failed");
    const receipt = parseM7R7ProviderCanaryReceiptBytesV1(
      await readFile(input.receiptPath),
    );
    expect(receipt.status).toBe("failed");
    expect(receipt.observations.sessionCleanupProven).toBe(true);
    expect(await readdir(input.taskStorageRoot)).toEqual([]);
  });
});
