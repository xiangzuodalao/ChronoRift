import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  InMemoryCredentialStore,
  fauxAssistantMessage,
  fauxProvider,
  fauxThinking,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import {
  createAgentSession,
  defineTool,
  ModelRuntime,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createManagedPiSession,
  exportPiSessionForkContext,
  normalizePiForkTurns,
  parsePiSessionForkContext,
  type ManagedPiSession,
  type PiCollaborationMessage,
  type PiSessionForkContext,
} from "../src/index.js";

const roots: string[] = [];
const sessions: ManagedPiSession[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) session.dispose();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const mail = (
  id: string,
  kind: PiCollaborationMessage["kind"] = "message",
): PiCollaborationMessage => ({
  id,
  kind,
  from: "/root/worker",
  to: "/root",
  text: `Payload ${id}`,
  createdAt: "2026-09-13T00:00:00.000Z",
});

async function fixture(forkContext?: PiSessionForkContext) {
  const root = await mkdtemp(join(tmpdir(), "chronorift-pi-inbox-"));
  roots.push(root);
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  await Promise.all([mkdir(workspace), mkdir(agentDir)]);
  const faux = fauxProvider({
    api: "chronorift-inbox-test-api",
    provider: "chronorift-inbox-test",
    models: [{ id: "offline", input: ["text"], reasoning: true }],
    tokenSize: { min: 1024, max: 1024 },
  });
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    allowModelNetwork: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  const model = modelRuntime.getModel("chronorift-inbox-test", "offline")!;
  let rawSession: AgentSession | undefined;
  let originalStreamFunction:
    AgentSession["agent"]["streamFunction"] | undefined;
  const session = await createManagedPiSession(
    {
      resourceWorkspaceDirectory: workspace,
      sessionDirectory: join(root, "sessions"),
      agentDir,
      modelRuntime,
      model,
      thinkingLevel: "off",
      tools: [
        defineTool({
          name: "inspect",
          label: "inspect",
          description: "Offline fixture",
          parameters: Type.Object({}),
          execute: async () => ({
            content: [{ type: "text", text: "observed" }],
            details: {},
          }),
        }),
      ],
      ...(forkContext === undefined ? {} : { forkContext }),
    },
    {
      createSession: async (options) => {
        const created = await createAgentSession(options);
        rawSession = created.session;
        originalStreamFunction = created.session.agent.streamFunction;
        return created;
      },
    },
  );
  sessions.push(session);
  return {
    session,
    faux,
    rawSession: rawSession!,
    originalStreamFunction: originalStreamFunction!,
  };
}

describe("Pi collaboration mailbox at native loop boundaries", () => {
  it("preserves the installed SDK's compaction authentication branch", async () => {
    const { rawSession, originalStreamFunction } = await fixture();
    // Pi has an identity-based auth branch for the legacy compat stream.
    // Its current SDK instead supplies an anonymous modelRuntime wrapper.
    expect(originalStreamFunction).not.toBe(streamSimple);
    expect(rawSession.agent.streamFunction).not.toBe(streamSimple);
    const observedStreamFunction = rawSession.agent.streamFunction;
    const getAuth = vi
      .spyOn(rawSession.modelRuntime, "getAuth")
      .mockRejectedValue(new Error("Fixture auth failure"));
    const isUsingOAuth = vi.spyOn(rawSession.modelRuntime, "isUsingOAuth");
    try {
      for (const streamFunction of [
        originalStreamFunction,
        observedStreamFunction,
      ]) {
        rawSession.agent.streamFunction = streamFunction;
        // Both versions preserve Pi's custom-stream auth fallback before
        // reaching the normal empty-session compaction check, with no request.
        await expect(rawSession.compact()).rejects.toThrow(
          "Nothing to compact",
        );
      }
      expect(getAuth).toHaveBeenCalledTimes(2);
      expect(isUsingOAuth).not.toHaveBeenCalled();
    } finally {
      rawSession.agent.streamFunction = observedStreamFunction;
    }
  });

  it("persists separate request timings through native Pi retry and failed follow-up turns", async () => {
    const { session, faux, rawSession } = await fixture();
    const retrySettings = rawSession.settingsManager.getRetrySettings();
    vi.spyOn(rawSession.settingsManager, "getRetrySettings").mockReturnValue({
      ...retrySettings,
      baseDelayMs: 1,
    });
    faux.setResponses([
      fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: "500 server error",
      }),
      fauxAssistantMessage("Recovered."),
      fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: "Invalid fixture request",
      }),
    ]);
    await session.prompt("Investigate.");
    expect(faux.state.callCount).toBe(2);
    expect(
      session.snapshot().modelRequests?.map((request) => request.outcome),
    ).toEqual(["error", "completed"]);
    await session.prompt("Check another task.");
    const result = session.snapshot();
    expect(result.status).toBe("provider_failed");
    expect(result.modelRequests?.map((request) => request.outcome)).toEqual([
      "error",
      "completed",
      "error",
    ]);
    const persisted = (await readFile(result.sessionFile, "utf8"))
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            customType?: string;
            data?: { phase: string; requestId: string; outcome: string };
          },
      )
      .filter((entry) => entry.customType === "chronorift.model-request.v1");
    expect(persisted.map((entry) => entry.data?.phase)).toEqual([
      "started",
      "finished",
      "started",
      "finished",
      "started",
      "finished",
    ]);
    expect(
      persisted
        .filter((entry) => entry.data?.phase === "finished")
        .map((entry) => entry.data?.requestId),
    ).toEqual(result.modelRequests?.map((request) => request.requestId));
  });

  it("batches mail after tools, acknowledges actual context consumption, and keeps one final answer", async () => {
    const { session, faux } = await fixture();
    const consumed: string[][] = [];
    session.subscribeConsumption((ids) => consumed.push([...ids]));
    faux.setResponses([
      async () => {
        await session.deliverCollaboration(mail("one"));
        await session.deliverCollaboration(mail("two", "completion"));
        await session.deliverCollaboration(mail("three"));
        expect(consumed).toEqual([]);
        return fauxAssistantMessage(fauxToolCall("inspect", {}));
      },
      (context) => {
        const inputs = JSON.stringify(context.messages);
        expect(inputs).toContain("Payload one");
        expect(inputs).toContain("Payload two");
        expect(inputs).toContain("Payload three");
        return fauxAssistantMessage("Integrated result.");
      },
    ]);
    await session.prompt("Investigate.");
    expect(faux.state.callCount).toBe(2);
    expect(session.snapshot().modelRequests).toHaveLength(2);
    expect(
      session
        .snapshot()
        .modelRequests?.every((request) => request.outcome === "completed"),
    ).toBe(true);
    expect(consumed).toEqual([["one", "two", "three"]]);
    expect(session.hasPendingMessages()).toBe(false);
    expect(session.snapshot().assistantText).toBe("Integrated result.");
  });

  it("retains ordinary mail arriving during final until the next explicit prompt", async () => {
    const { session, faux } = await fixture();
    const consumed = vi.fn();
    session.subscribeConsumption(consumed);
    faux.setResponses([
      async () => {
        await session.deliverCollaboration(mail("late", "completion"));
        return fauxAssistantMessage("Final answer.");
      },
      (context) => {
        expect(JSON.stringify(context.messages)).toContain("Payload late");
        return fauxAssistantMessage("Next explicit task.");
      },
    ]);
    await session.prompt("First task.");
    expect(faux.state.callCount).toBe(1);
    expect(session.collaborationPhase).toBe("idle");
    expect(session.hasPendingMessages()).toBe(true);
    expect(consumed).not.toHaveBeenCalled();
    await session.prompt("Second task.");
    expect(faux.state.callCount).toBe(2);
    expect(consumed).toHaveBeenCalledWith(["late"]);
  });

  it("accepts a busy followup into the current run but leaves idle task admission to the Host", async () => {
    const { session, faux } = await fixture();
    expect(await session.deliverCollaboration(mail("idle-task", "task"))).toBe(
      "next-turn",
    );
    expect(session.hasPendingMessages()).toBe(false);
    expect(faux.state.callCount).toBe(0);
    let settled = 0;
    session.subscribe((event) => {
      if (event.type === "agent_settled") settled += 1;
    });
    faux.setResponses([
      async () => {
        expect(
          await session.deliverCollaboration(mail("busy-task", "task")),
        ).toBe("current-turn");
        return fauxAssistantMessage("Initial answer.");
      },
      (context) => {
        expect(JSON.stringify(context.messages)).toContain("Payload busy-task");
        return fauxAssistantMessage("Additional task handled.");
      },
    ]);
    await session.prompt("Host-admitted task.");
    expect(faux.state.callCount).toBe(2);
    expect(settled).toBe(1);
    expect(session.exportForkContext("1").messages[0]).toMatchObject({
      text: "Payload busy-task",
      turnStart: true,
    });
  });

  it("leaves retry ownership to Pi and delivers waiting mail when its retry begins", async () => {
    const { session, faux } = await fixture();
    const events: string[] = [];
    session.subscribe((event) => events.push(event.type));
    faux.setResponses([
      async () => {
        await session.deliverCollaboration(mail("during-error"));
        return fauxAssistantMessage("", {
          stopReason: "error",
          errorMessage: "503 service unavailable",
        });
      },
      (context) => {
        expect(JSON.stringify(context.messages)).toContain(
          "Payload during-error",
        );
        return fauxAssistantMessage("Retry recovered.");
      },
    ]);
    await session.prompt("Retry fixture.");
    expect(session.snapshot().status).toBe("completed");
    expect(events.filter((event) => event === "agent_settled")).toHaveLength(1);
    expect(events).toContain("auto_retry_start");
    expect(faux.state.callCount).toBe(2);
  });

  it("retains unconsumed mail after abort clears Pi's queue and accepts an idempotent redelivery", async () => {
    const { session, faux, rawSession } = await fixture();
    const original = rawSession.agent.prepareNextTurnWithContext!;
    rawSession.agent.prepareNextTurnWithContext = async (turn, signal) => {
      const snapshot = await original(turn, signal);
      rawSession.clearQueue();
      rawSession.agent.abort();
      return snapshot;
    };
    faux.setResponses([
      async () => {
        await session.deliverCollaboration(mail("abort-mail"));
        return fauxAssistantMessage(fauxToolCall("inspect", {}));
      },
    ]);
    await session.prompt("Task interrupted before queued mail enters context.");
    expect(session.hasPendingMessages()).toBe(true);
    rawSession.agent.prepareNextTurnWithContext = original;
    await session.deliverCollaboration(mail("abort-mail"));
    const consumed = vi.fn();
    session.subscribeConsumption(consumed);
    faux.setResponses([
      (context) => {
        expect(
          JSON.stringify(context.messages).match(/Payload abort-mail/g),
        ).toHaveLength(1);
        return fauxAssistantMessage("Resumed.");
      },
    ]);
    await session.prompt("Explicit retry.");
    expect(consumed).toHaveBeenCalledExactlyOnceWith(["abort-mail"]);
    expect(session.hasPendingMessages()).toBe(false);
  });

  it("returns a next-turn disposition for a task racing the closed final boundary", async () => {
    const { session, faux } = await fixture();
    let delivery: Promise<string> | undefined;
    const unsubscribe = session.subscribeCollaborationPhase((phase) => {
      if (phase === "next")
        delivery = session.deliverCollaboration(mail("too-late", "task"));
    });
    faux.setResponses([fauxAssistantMessage("Finished.")]);
    await session.prompt("One task.");
    expect(await delivery).toBe("next-turn");
    expect(faux.state.callCount).toBe(1);
    expect(session.hasPendingMessages()).toBe(false);
    unsubscribe();
  });

  it("keeps manual compaction in Pi and does not let pending mail start another model run", async () => {
    const { session, faux, rawSession } = await fixture();
    faux.setResponses([
      fauxAssistantMessage("Initial result."),
      fauxAssistantMessage("Compacted investigation summary."),
      fauxAssistantMessage("Next result."),
    ]);
    await session.prompt("Initial task.");
    await session.deliverCollaboration(mail("during-compaction"));
    vi.spyOn(
      rawSession.settingsManager,
      "getCompactionSettings",
    ).mockReturnValue({ enabled: true, reserveTokens: 0, keepRecentTokens: 0 });
    await rawSession.compact();
    expect(faux.state.callCount).toBe(2);
    expect(session.hasPendingMessages()).toBe(true);
    expect(
      session
        .exportForkContext("all")
        .messages.some((message) => message.role === "context"),
    ).toBe(true);
    await session.prompt("Continue explicitly.");
    expect(faux.state.callCount).toBe(3);
    expect(session.hasPendingMessages()).toBe(false);
  });

  it("does not lose activity when arrival races listener registration, and deduplicates an envelope", async () => {
    const { session } = await fixture();
    const activity = vi.fn();
    const unsubscribe = session.subscribeActivity(activity);
    await session.deliverCollaboration(mail("queued"));
    expect(session.hasPendingMessages()).toBe(true);
    expect(activity).toHaveBeenCalledOnce();
    await session.deliverCollaboration(mail("queued"));
    expect(activity).toHaveBeenCalledOnce();
    session.onUserInput();
    expect(activity).toHaveBeenCalledTimes(2);
    unsubscribe();
    await session.deliverCollaboration(mail("another"));
    expect(activity).toHaveBeenCalledTimes(2);
  });
});

describe("filtered fork context and owned Session usage", () => {
  it("filters thinking, tools and ordinary communications and counts actual task boundaries", () => {
    const messages = [
      { role: "compactionSummary", summary: "Earlier investigation context." },
      { role: "user", content: "First user task." },
      fauxAssistantMessage([
        fauxThinking("private analysis"),
        fauxToolCall("inspect", {}),
      ]),
      {
        role: "toolResult",
        content: [{ type: "text", text: "raw tool output" }],
      },
      {
        role: "custom",
        customType: "chronorift.collaboration",
        details: {
          messages: [
            mail("ordinary"),
            mail("followup", "task"),
            mail("completed", "completion"),
          ],
        },
      },
      fauxAssistantMessage([
        fauxThinking("private final analysis"),
        { type: "text", text: "Visible final." },
      ]),
    ];
    const session = { sessionId: "parent", messages } as Parameters<
      typeof exportPiSessionForkContext
    >[0];
    const all = exportPiSessionForkContext(session, "all");
    expect(all.messages.map((message) => message.text)).toEqual([
      "Earlier investigation context.",
      "First user task.",
      "Payload followup",
      "Visible final.",
    ]);
    expect(JSON.stringify(all)).not.toMatch(
      /private|raw tool|Payload ordinary|Payload completed/,
    );
    expect(
      exportPiSessionForkContext(session, "1").messages.map(
        (message) => message.text,
      ),
    ).toEqual(["Payload followup", "Visible final."]);
    expect(exportPiSessionForkContext(session, "none").messages).toEqual([]);
    expect(exportPiSessionForkContext(session, "999").messages[0]?.text).toBe(
      "First user task.",
    );
    expect(normalizePiForkTurns(" ALL ")).toBe("all");
    expect(() => normalizePiForkTurns("0")).toThrow("positive integer");
    expect(() => normalizePiForkTurns("1.5")).toThrow("positive integer");
  });

  it("rejects unsupported image inheritance instead of silently dropping it", () => {
    const parent = {
      sessionId: "image-parent",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Inspect this screenshot" },
            { type: "image", mimeType: "image/png", data: "image" },
          ],
        },
      ],
    } as Parameters<typeof exportPiSessionForkContext>[0];
    expect(() => exportPiSessionForkContext(parent, "all")).toThrow(
      "non-text user content",
    );
    expect(exportPiSessionForkContext(parent, "none").messages).toEqual([]);
  });

  it("imports parent text as usage-free background and retains auditable ownership", async () => {
    const forkContext: PiSessionForkContext = {
      schemaVersion: 1,
      parentSessionId: "parent-session",
      forkTurns: "all",
      messages: [
        { role: "user", text: "Parent task", turnStart: true },
        { role: "assistant", text: "Parent conclusion", turnStart: false },
      ],
    };
    const { session, faux } = await fixture(forkContext);
    faux.setResponses([
      (context) => {
        expect(JSON.stringify(context.messages)).toContain("Parent conclusion");
        return fauxAssistantMessage("Child result.");
      },
    ]);
    await session.prompt("Bounded child task.");
    const result = session.snapshot();
    expect(result.stats.assistantMessages).toBe(1);
    expect(result.usageOwnership).toEqual({
      scope: "session-owned",
      sessionId: session.sessionId,
      parentSessionId: "parent-session",
      inheritedContextMessages: 2,
    });
    expect(
      session.exportForkContext("all").messages.map((message) => message.text),
    ).toEqual([
      "Parent task",
      "Parent conclusion",
      "Bounded child task.",
      "Child result.",
    ]);
    expect(session.exportForkContext("1").messages[0]?.text).toBe(
      "Bounded child task.",
    );
  });

  it("records none-fork provenance without adding parent context", async () => {
    const { session, faux } = await fixture({
      schemaVersion: 1,
      parentSessionId: "parent",
      forkTurns: "none",
      messages: [],
    });
    faux.setResponses([fauxAssistantMessage("Fresh child.")]);
    await session.prompt("Fresh task.");
    expect(session.snapshot().usageOwnership).toMatchObject({
      parentSessionId: "parent",
      inheritedContextMessages: 0,
    });
    expect(session.exportForkContext("all").messages).toHaveLength(2);
    expect(() =>
      parsePiSessionForkContext({
        schemaVersion: 1,
        parentSessionId: "parent",
        forkTurns: "none",
        messages: [{ role: "user", text: "forged", turnStart: true }],
      }),
    ).toThrow("no inherited messages");
  });
});
