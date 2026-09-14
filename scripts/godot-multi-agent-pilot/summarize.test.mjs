import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  usageFromEntries,
  reconcile,
  overlap,
  rootTailMetrics,
  ownershipMatches,
  runtimeMatchesExpected,
  topologyMatches,
  toolCallsFromEntries,
  toolCallCounts,
  modelRequestMetrics,
  executionTimingMetrics,
  lifecycleMetrics,
  toolExecutionSucceeded,
  summarize,
} from "./summarize.mjs";

const model = {
  id: "fixture",
  provider: "fixture",
  cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
};
const usage = {
  input: 10,
  output: 2,
  cacheRead: 5,
  cacheWrite: 0,
  cost: { total: 0.0000145 },
};
test("accounting retains pre-compaction messages and summary/tool usage exactly once", () => {
  const records = [
    {
      type: "message",
      message: {
        role: "assistant",
        model: "fixture",
        provider: "fixture",
        usage,
        stopReason: "stop",
      },
    },
    { type: "compaction", usage },
    { type: "branch_summary", usage },
    { type: "message", message: { role: "toolResult", usage } },
    { type: "message", message: { role: "user" } },
  ];
  const total = usageFromEntries(records, model);
  assert.equal(total.tokens.total, 68);
  assert.equal(total.pricedRequests, 1);
  assert.equal(total.unpricedEntries, 3);
  assert.deepEqual(total.issues, []);
  assert.equal(
    reconcile({ tokens: total.tokens, cost: total.cost }, total).matched,
    true,
  );
  assert.equal(
    reconcile({ tokens: total.tokens, cost: total.cost * 2 }, total).matched,
    false,
  );
});

test("comparison rejects observed worker effort drift despite matching model names", () => {
  const expected = {
    provider: "openai-codex",
    model: "gpt-5.6-luna",
    thinkingLevel: "max",
  };
  assert.equal(runtimeMatchesExpected(expected, expected), true);
  assert.equal(
    runtimeMatchesExpected({ ...expected, thinkingLevel: "high" }, expected),
    false,
  );
  assert.equal(
    runtimeMatchesExpected({ ...expected, model: "inherit" }, expected),
    false,
  );
  assert.equal(runtimeMatchesExpected(undefined, expected), false);
});
test("failed requests remain incomplete even when zero usage reconciles", () => {
  const total = usageFromEntries(
    [
      {
        type: "message",
        message: {
          role: "assistant",
          provider: "fixture",
          model: "fixture",
          stopReason: "error",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            cost: { total: 0 },
          },
        },
      },
    ],
    model,
  );
  assert.deepEqual(total.issues, ["provider_error"]);
  assert.equal(reconcile(null, total).matched, false);
});
test("missing or malformed usage is not silently accepted", () => {
  const total = usageFromEntries(
    [
      { type: "message", message: { role: "assistant" } },
      { type: "compaction", usage: { ...usage, input: -1 } },
    ],
    model,
  );
  assert.deepEqual(total.issues, ["missing_assistant_usage", "invalid_usage"]);
});
test("concurrency requires overlapping execution, not three configured slots", () => {
  const interval = (a, b) => ({
    startedAt: new Date(a).toISOString(),
    finishedAt: new Date(b).toISOString(),
  });
  assert.deepEqual(
    overlap([interval(0, 10), interval(5, 15), interval(8, 20)]),
    { peak: 3, commonMs: 2, complete: true },
  );
  assert.deepEqual(overlap([interval(0, 10), interval(10, 20)]), {
    peak: 1,
    commonMs: 0,
    complete: true,
  });
  assert.equal(
    overlap([{ startedAt: null, finishedAt: null }]).complete,
    false,
  );
});

test("inherited fork context never contributes parent usage and tail counts exclude the first answer", () => {
  const records = [
    {
      type: "message",
      message: {
        role: "custom",
        customType: "chronorift.fork-context",
        details: {
          forkContext: {
            messages: [{ role: "assistant", text: "parent result", usage }],
          },
        },
      },
    },
  ];
  assert.equal(usageFromEntries(records, model).tokens.total, 0);
  const response = (at, content, stopReason = "stop") => ({
    receivedAt: new Date(at).toISOString(),
    event: {
      type: "message_end",
      message: { role: "assistant", content, stopReason, usage },
    },
  });
  const events = [
    response(
      0,
      [
        { type: "text", text: "checking" },
        { type: "toolCall", name: "read" },
      ],
      "toolUse",
    ),
    response(1000, [{ type: "text", text: "finished" }]),
    response(4000, [{ type: "text", text: "acknowledged" }]),
  ];
  assert.deepEqual(rootTailMetrics(events), {
    firstStoppingResponseAt: new Date(1000).toISOString(),
    laterAssistantResponses: 1,
    laterDurationMs: 3000,
    laterEstimatedCostUSD: usage.cost.total,
  });
  assert.equal(rootTailMetrics(events.slice(0, 2)).laterAssistantResponses, 0);
  assert.equal(
    rootTailMetrics(events.slice(0, 1)).laterAssistantResponses,
    null,
  );
});

test("usage ownership must match the actual parent Session and persisted fork provenance", () => {
  const ownership = {
    scope: "session-owned",
    sessionId: "child",
    parentSessionId: "parent",
    inheritedContextMessages: 2,
  };
  const provenance = { parentSessionId: "parent", inheritedContextMessages: 2 };
  assert.equal(
    ownershipMatches(ownership, provenance, "child", "parent"),
    true,
  );
  assert.equal(
    ownershipMatches(ownership, provenance, "child", "other"),
    false,
  );
  assert.equal(
    ownershipMatches(
      ownership,
      { ...provenance, inheritedContextMessages: 3 },
      "child",
      "parent",
    ),
    false,
  );
  assert.equal(ownershipMatches(null, provenance, "child", "parent"), false);
  assert.equal(
    ownershipMatches(
      { ...ownership, parentSessionId: null, inheritedContextMessages: 0 },
      null,
      "child",
      null,
    ),
    true,
  );
  assert.equal(
    ownershipMatches(
      { ...ownership, parentSessionId: null, inheritedContextMessages: 0 },
      provenance,
      "child",
      null,
    ),
    false,
  );
});

test("Adaptive accepts zero or sequential workers while Forced-M3 keeps its original overlap requirement", () => {
  const zero = { schemaVersion: 2, agents: [], turns: [] };
  assert.equal(topologyMatches("multi", zero, true), true);
  assert.equal(topologyMatches("multi", zero, false), false);
  assert.equal(topologyMatches("multi", null, true), false);
  assert.equal(topologyMatches("single", null, true), true);
  assert.equal(topologyMatches("single", zero, true), false);
  const fixture = (count) => ({
    schemaVersion: 2,
    agents: Array.from({ length: count }, (_, i) => ({
      agentId: String(i),
      parentAgentId: "/root",
    })),
    turns: Array.from({ length: count }, (_, i) => ({
      agentId: String(i),
      turnId: 1,
      startedAt: new Date(i * 1000).toISOString(),
      finishedAt: new Date((i + 1) * 1000).toISOString(),
    })),
  });
  assert.equal(topologyMatches("multi", fixture(3), true), true);
  assert.equal(topologyMatches("multi", fixture(3), false), false);
  assert.equal(topologyMatches("multi", fixture(4), true), false);
  const nested = fixture(1);
  nested.agents[0].parentAgentId = "/root/other";
  assert.equal(topologyMatches("multi", nested, true), false);
});

test("tool counts retain failed and unanswered calls without leaking arguments or message bodies", () => {
  const records = [
    {
      type: "message",
      timestamp: new Date(0).toISOString(),
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "private reasoning" },
          {
            type: "toolCall",
            id: "a",
            name: "read",
            arguments: { path: "private-file" },
          },
          {
            type: "toolCall",
            id: "b",
            name: "game_query",
            arguments: { private: true },
          },
          { type: "toolCall", id: "c", name: "wait_agent", arguments: {} },
        ],
      },
    },
    {
      type: "message",
      timestamp: new Date(100).toISOString(),
      message: { role: "toolResult", toolCallId: "a", isError: true },
    },
    {
      type: "message",
      timestamp: new Date(200).toISOString(),
      message: { role: "toolResult", toolCallId: "b", isError: false },
    },
  ];
  const calls = toolCallsFromEntries(records);
  assert.deepEqual(toolCallCounts(calls), {
    total: 3,
    coding: 1,
    game: 1,
    collaboration: 1,
    other: 0,
    byName: { game_query: 1, read: 1, wait_agent: 1 },
  });
  assert.equal(calls[0].isError, true);
  assert.equal(calls[2].isError, null);
  assert.equal(calls[2].resultAt, null);
  assert.equal(JSON.stringify(calls).includes("private"), false);
  assert.match(calls[0].argumentsSha256, /^[a-f0-9]{64}$/u);
});

test("request timing deduplicates cumulative snapshots and start/end entries, keeping in-flight work incomplete", () => {
  const initial = {
    requestId: "one",
    boundary: "pi-stream-function",
    startedAt: new Date(0).toISOString(),
    finishedAt: null,
    durationMs: null,
    outcome: "in_flight",
  };
  const finished = {
    ...initial,
    finishedAt: new Date(100).toISOString(),
    durationMs: 100,
    outcome: "completed",
  };
  const entry = (data) => ({
    type: "custom",
    customType: "chronorift.model-request.v1",
    data,
  });
  const metrics = modelRequestMetrics(
    [entry(initial), entry(finished)],
    [[finished], [finished, { ...initial, requestId: "two" }]],
  );
  assert.equal(metrics.count, 2);
  assert.equal(metrics.completedCount, 1);
  assert.equal(metrics.unfinishedCount, 1);
  assert.equal(metrics.durationSumMs, 100);
  assert.equal(metrics.complete, false);
  assert.equal(
    modelRequestMetrics([entry(initial), entry(finished)]).complete,
    true,
  );
  assert.equal(modelRequestMetrics([]).durationSumMs, null);
  const persistenceFailure = modelRequestMetrics(
    [entry(finished)],
    [[{ ...finished, persistenceFailed: true }]],
  );
  assert.equal(persistenceFailure.requests[0].persistenceFailed, true);
  assert.equal(persistenceFailure.complete, false);
});

test("lock timing includes failed acquisition waits and distinguishes missing from zero telemetry", () => {
  const record = {
    schemaVersion: 1,
    records: [
      {
        toolCallId: "a",
        name: "read",
        requestedAt: new Date(0).toISOString(),
        lockRequestedAt: new Date(1).toISOString(),
        lockAcquiredAt: new Date(11).toISOString(),
        finishedAt: new Date(20).toISOString(),
        workspaceLockWaitMs: 10,
        durationMs: 20,
        outcome: "returned",
      },
      {
        toolCallId: "b",
        name: "edit",
        requestedAt: new Date(0).toISOString(),
        lockRequestedAt: new Date(1).toISOString(),
        lockAcquiredAt: null,
        finishedAt: new Date(8).toISOString(),
        workspaceLockWaitMs: 7,
        durationMs: 8,
        outcome: "threw",
      },
    ],
  };
  const metrics = executionTimingMetrics(record);
  assert.equal(metrics.workspaceLockWaitMs, 17);
  assert.equal(metrics.maximumLockWaitMs, 10);
  assert.equal(metrics.cancelledOrFailedBeforeLock, 1);
  assert.equal(metrics.complete, true);
  assert.equal(executionTimingMetrics(null).workspaceLockWaitMs, null);
  assert.equal(
    executionTimingMetrics({ schemaVersion: 1, records: [] })
      .workspaceLockWaitMs,
    0,
  );
});

test("lifecycle separates worker first-message proxy, settled and cleanup and keeps Root final validation distinct", () => {
  const at = (value) => new Date(value).toISOString();
  const events = [
    {
      receivedAt: at(10),
      event: {
        type: "tool_execution_start",
        toolCallId: "edit",
        toolName: "edit",
      },
    },
    {
      receivedAt: at(15),
      event: {
        type: "tool_execution_end",
        toolCallId: "edit",
        toolName: "edit",
        isError: false,
      },
    },
    {
      receivedAt: at(20),
      event: {
        type: "tool_execution_start",
        toolCallId: "launch",
        toolName: "game_launch",
      },
    },
    {
      receivedAt: at(30),
      event: {
        type: "tool_execution_end",
        toolCallId: "launch",
        toolName: "game_launch",
        isError: false,
        result: {
          details: {
            schemaVersion: 1,
            outcome: "success",
            output: { executionId: "final" },
          },
        },
      },
    },
    {
      receivedAt: at(40),
      event: {
        type: "tool_execution_end",
        toolCallId: "query",
        toolName: "game_query",
        isError: false,
        result: {
          details: {
            schemaVersion: 1,
            outcome: "success",
            output: { executionId: "final" },
          },
        },
      },
    },
    {
      receivedAt: at(50),
      event: {
        type: "message_end",
        message: {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: "private final" }],
        },
      },
    },
  ];
  const lifecycle = lifecycleMetrics(events, {
    agents: [
      { agentId: "worker", path: "/root/check", parentAgentId: "/root" },
    ],
    messages: [
      {
        envelope: {
          kind: "task",
          from: "/root",
          to: "/root/check",
          createdAt: at(1),
          text: "private task",
        },
      },
      {
        envelope: {
          kind: "message",
          from: "/root/check",
          to: "/root",
          createdAt: at(5),
          text: "not done",
        },
      },
      {
        envelope: {
          kind: "completion",
          from: "/root/check",
          to: "/root",
          createdAt: at(12),
          text: "private result",
        },
      },
    ],
    turns: [
      {
        agentId: "worker",
        turnId: 1,
        startedAt: at(2),
        settledAt: at(10),
        finishedAt: at(12),
        status: "completed",
      },
    ],
  });
  assert.equal(lifecycle.rootFirstEditRequestedAt, at(10));
  assert.equal(lifecycle.rootFinalValidationRequestedAt, at(20));
  assert.equal(lifecycle.rootFinalValidationLastQueryAt, at(40));
  assert.equal(lifecycle.rootFinalResponseAt, at(50));
  assert.equal(lifecycle.finalValidationLaunchAfterLastObservedEdit, true);
  assert.equal(lifecycle.workers[0].firstParentMessageAt, at(5));
  assert.equal(lifecycle.workers[0].firstCompletionNotificationAt, at(12));
  assert.equal(lifecycle.workers[0].turns[0].cleanupAfterSettledMs, 2);
  assert.equal(JSON.stringify(lifecycle).includes("private"), false);
});

test("summarizes a two-arm zero-worker holdout with actual Single and Multi telemetry paths", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "chronorift-adaptive-summary-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const save = async (path, value) =>
    writeFile(path, JSON.stringify(value) + "\n");
  const iso = (value) => new Date(value).toISOString();
  const tokens = {
    input: 10,
    output: 2,
    cacheRead: 5,
    cacheWrite: 0,
    total: 17,
  };
  await mkdir(join(root, "evaluation"));
  await save(join(root, "manifest.json"), {
    schemaVersion: 2,
    cohort: "holdout",
    collaborationPolicy: "adaptive",
    ids: ["mob-single", "mob-multi"],
    cases: ["mob"],
    config: {
      provider: "fixture",
      model: "fixture",
      thinkingLevel: "off",
      collaborationVersion: 2,
    },
    protocol: { maximumWorkers: 3 },
    model: { metadata: model },
  });
  await save(
    join(root, "evaluation/results.json"),
    ["mob-single", "mob-multi"].flatMap((id) =>
      [1, 2].map((repeat) => ({ id, repeat, outcome: "passed" })),
    ),
  );
  await save(join(root, "live-completion.json"), {
    observedProcesses: [
      { role: "root", dnsOrderArgument: "--dns-result-order=ipv4first" },
    ],
    survivingObservedProcesses: [],
  });
  for (const arm of ["single", "multi"]) {
    const directory = join(root, `mob-${arm}`),
      task = join(directory, "task");
    await mkdir(join(task, "records"), { recursive: true });
    await mkdir(join(task, "runtime-records"));
    const sessionFile = join(task, "root-session.jsonl");
    const ownership = {
      scope: "session-owned",
      sessionId: arm,
      parentSessionId: null,
      inheritedContextMessages: 0,
    };
    const modelRequest = {
      requestId: arm,
      boundary: "pi-stream-function",
      provider: "fixture",
      model: "fixture",
      startedAt: iso(0),
      finishedAt: iso(50),
      durationMs: 50,
      outcome: "completed",
      stopReason: "stop",
    };
    const records = [
      { type: "session", id: arm },
      { type: "model_change", provider: "fixture", modelId: "fixture" },
      { type: "thinking_level_change", thinkingLevel: "off" },
      {
        type: "message",
        timestamp: iso(50),
        message: {
          role: "assistant",
          model: "fixture",
          provider: "fixture",
          usage,
          stopReason: "stop",
          content: [{ type: "text", text: "private final" }],
        },
      },
      {
        type: "custom",
        customType: "chronorift.model-request.v1",
        data: modelRequest,
      },
    ];
    await writeFile(
      sessionFile,
      records.map((record) => JSON.stringify(record)).join("\n") + "\n",
    );
    await save(join(directory, "start.json"), { startedAt: iso(0) });
    await save(join(directory, "completion.json"), {
      status: "completed",
      durationMs: 100,
      investigationStartedAt: iso(0),
      investigationFinishedAt: iso(90),
    });
    await save(join(directory, "root-result.json"), {
      status: "completed",
      provider: "fixture",
      model: "fixture",
      requestedThinkingLevel: "off",
      sessionFile,
      stats: { sessionId: arm, sessionFile, tokens, cost: usage.cost.total },
      usageOwnership: ownership,
      modelRequests: [modelRequest],
    });
    const agentRecordPath = join(task, "records", "agents.v2.json");
    if (arm === "multi")
      await save(agentRecordPath, {
        schemaVersion: 2,
        agents: [],
        turns: [],
        messages: [],
        workerUsage: [],
        reportedUsage: { tokens: 17, cost: usage.cost.total },
      });
    await save(join(directory, "preview.json"), {
      taskDirectory: task,
      executions: [],
      ...(arm === "multi"
        ? { agents: { recordPath: agentRecordPath }, workspaceMode: "shared" }
        : {}),
    });
    await save(
      join(
        task,
        arm === "multi" ? "runtime-records" : "records",
        "performance.v1.json",
      ),
      {
        schemaVersion: 1,
        records: [
          {
            toolCallId: "read",
            name: "read",
            requestedAt: iso(50),
            lockRequestedAt: arm === "multi" ? iso(51) : null,
            lockAcquiredAt: arm === "multi" ? iso(53) : null,
            finishedAt: iso(75),
            workspaceLockWaitMs: arm === "multi" ? 2 : 0,
            durationMs: 25,
            outcome: "returned",
          },
        ],
      },
    );
  }
  const log = console.log;
  let summary;
  try {
    console.log = () => undefined;
    summary = await summarize(root);
  } finally {
    console.log = log;
  }
  assert.equal(summary.comparisonProtocolSatisfied, true);
  assert.equal(summary.rows.length, 2);
  assert.deepEqual(
    summary.rows.map((row) => row.workerCount),
    [0, 0],
  );
  assert.deepEqual(
    summary.rows.map((row) => row.rootOnlyTokens),
    [17, 17],
  );
  assert.deepEqual(
    summary.rows.map((row) => row.workspaceLockWaitMs),
    [0, 2],
  );
  assert.deepEqual(
    summary.rows.map((row) => row.rootModelRequests),
    [1, 1],
  );
  assert.deepEqual(
    summary.rows.map((row) => row.performanceTelemetryComplete),
    [true, true],
  );
  assert.equal(summary.rows[1].usageOwnershipReconciled, true);
  const audit = await readFile(join(root, "timing-audit.json"), "utf8");
  assert.equal(JSON.parse(audit).runs.length, 2);
  assert.equal(audit.includes("private final"), false);
  assert.match(
    await readFile(join(root, "results.csv"), "utf8"),
    /rootOnlyTokens/u,
  );
  const original = await readFile(join(root, "summary.json"), "utf8");
  try {
    console.log = () => undefined;
    await summarize(root, join(root, "corrected"));
  } finally {
    console.log = log;
  }
  assert.equal(await readFile(join(root, "summary.json"), "utf8"), original);
  assert.equal(
    JSON.parse(await readFile(join(root, "corrected", "summary.json"), "utf8"))
      .rows.length,
    2,
  );
});

test("game success requires an observed successful envelope, including when SDK isError is false", () => {
  const end = {
    type: "tool_execution_end",
    toolName: "game_launch",
    isError: false,
  };
  const envelope = (outcome) => ({ schemaVersion: 1, outcome });
  assert.equal(toolExecutionSucceeded(end), null);
  assert.equal(
    toolExecutionSucceeded({ ...end, result: { details: envelope("error") } }),
    false,
  );
  assert.equal(
    toolExecutionSucceeded({
      ...end,
      result: { details: envelope("success") },
    }),
    true,
  );
  assert.equal(
    toolExecutionSucceeded({
      ...end,
      result: {
        content: [{ type: "text", text: JSON.stringify(envelope("success")) }],
      },
    }),
    true,
  );
  assert.equal(
    toolExecutionSucceeded({
      ...end,
      result: { content: [{ type: "text", text: "not JSON" }] },
    }),
    null,
  );
  assert.equal(
    toolExecutionSucceeded({
      ...end,
      isError: true,
      result: { details: envelope("success") },
    }),
    false,
  );
  assert.equal(
    toolExecutionSucceeded({
      ...end,
      result: {
        details: envelope("success"),
        content: [{ type: "text", text: JSON.stringify(envelope("error")) }],
      },
    }),
    false,
  );
});

test("failed or unobserved launches after an edit cannot become final-candidate validation", () => {
  const at = (value) => new Date(value).toISOString();
  const start = (id, time, name = "game_launch") => ({
    receivedAt: at(time),
    event: { type: "tool_execution_start", toolCallId: id, toolName: name },
  });
  const end = (id, time, outcome, name = "game_launch") => ({
    receivedAt: at(time),
    event: {
      type: "tool_execution_end",
      toolCallId: id,
      toolName: name,
      isError: false,
      ...(outcome === undefined
        ? {}
        : {
            result: {
              details: {
                schemaVersion: 1,
                outcome,
                output: { executionId: "final" },
              },
            },
          }),
    },
  });
  const events = [
    start("baseline", 1),
    end("baseline", 2, "success"),
    start("edit", 3, "edit"),
    end("edit", 4, undefined, "edit"),
    start("failed", 5),
    end("failed", 6, "error"),
    start("unobserved", 7),
    end("unobserved", 8),
  ];
  const missing = lifecycleMetrics(events, null);
  assert.equal(missing.rootFinalValidationRequestedAt, null);
  assert.equal(missing.rootFinalValidationLaunchFinishedAt, null);
  assert.equal(missing.rootLastSuccessfulGameLaunchRequestedAt, at(1));
  assert.equal(missing.finalValidationLaunchAfterLastObservedEdit, false);
  assert.equal(
    lifecycleMetrics(events.slice(2), null).rootFinalValidationRequestedAt,
    null,
  );
  const completed = lifecycleMetrics(
    [
      ...events,
      start("final", 9),
      end("final", 10, "success"),
      start("failed-query", 11, "game_query"),
      end("failed-query", 12, "error", "game_query"),
    ],
    null,
  );
  assert.equal(completed.rootFinalValidationRequestedAt, at(9));
  assert.equal(completed.rootFinalValidationLastQueryAt, null);
  const otherExecution = end("other-query", 13, "success", "game_query");
  otherExecution.event.result.details.output.executionId = "different";
  const withOther = lifecycleMetrics(
    [...events, start("final", 9), end("final", 10, "success"), otherExecution],
    null,
  );
  assert.equal(withOther.rootFinalValidationExecutionId, "final");
  assert.equal(withOther.rootFinalValidationLastQueryAt, null);
});

test("a stopped serial batch retains an unstarted arm without inventing usage or acceptance", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "chronorift-unstarted-summary-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const save = (path, value) => writeFile(path, JSON.stringify(value) + "\n");
  await mkdir(join(root, "evaluation"));
  await mkdir(join(root, "pr498-single"));
  await save(join(root, "manifest.json"), {
    ids: ["pr498-single", "pr498-multi"],
    cohort: "godot-feature-multi-v1",
    collaborationPolicy: "adaptive",
    config: { provider: "fixture", model: "fixture", thinkingLevel: "off" },
    model: { metadata: model },
  });
  await save(
    join(root, "evaluation", "results.json"),
    ["pr498-single", "pr498-multi"].flatMap((id) =>
      [1, 2].map((repeat) => ({
        id,
        repeat,
        outcome: "requires_review",
        reason: "No frozen final candidate patch",
      })),
    ),
  );
  await save(join(root, "live-completion.json"), {
    observedProcesses: [],
    survivingObservedProcesses: [],
    stopRequested: true,
    unstartedIds: ["pr498-multi"],
  });
  await save(join(root, "pr498-single", "completion.json"), {
    status: "cancelled",
    durationMs: 123,
    failure: "Stopped before model startup",
  });
  const sourceRecord = await readFile(
    join(root, "pr498-single", "completion.json"),
    "utf8",
  );
  const log = console.log;
  let summary;
  try {
    console.log = () => undefined;
    summary = await summarize(root, join(root, "derived"));
  } finally {
    console.log = log;
  }
  assert.equal(summary.rows.length, 2);
  assert.equal(summary.rows[0].status, "cancelled");
  assert.equal(summary.rows[0].hostDurationMs, 123);
  const missing = summary.rows[1];
  assert.equal(missing.status, "missing");
  assert.equal(missing.acceptance, "requires_review");
  assert.equal(missing.tokens, null);
  assert.equal(missing.estimatedCostUSD, null);
  assert.equal(missing.hostDurationMs, null);
  assert.equal(missing.rootModelRequests, null);
  assert.equal(missing.usageIncomplete, true);
  assert.equal(missing.comparisonProtocolSatisfied, false);
  assert.equal(summary.comparisonProtocolSatisfied, false);
  assert.equal(
    await readFile(join(root, "pr498-single", "completion.json"), "utf8"),
    sourceRecord,
  );
  assert.match(
    await readFile(join(root, "derived", "results.csv"), "utf8"),
    /pr498-multi/u,
  );

  // An existing arm that is not a directory is corruption, not an unstarted arm.
  await writeFile(join(root, "pr498-multi"), "corrupt arm path");
  await assert.rejects(summarize(root, join(root, "invalid")), {
    code: "ENOTDIR",
  });
});
