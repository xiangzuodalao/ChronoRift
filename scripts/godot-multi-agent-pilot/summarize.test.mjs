import assert from "node:assert/strict";
import { test } from "node:test";
import {
  usageFromEntries,
  reconcile,
  overlap,
  rootTailMetrics,
  ownershipMatches,
  runtimeMatchesExpected,
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
