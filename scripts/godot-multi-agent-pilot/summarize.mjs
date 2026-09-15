// Read-only accounting and compact projections; raw messages stay in local state.
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { calculateCost } from "../../packages/pi-harness/node_modules/@earendil-works/pi-ai/dist/models.js";

const FIELDS = ["input", "output", "cacheRead", "cacheWrite"];
const close = (a, b) =>
  typeof a === "number" &&
  typeof b === "number" &&
  Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
const json = async (path) => JSON.parse(await readFile(path, "utf8"));
const optional = (path) =>
  json(path).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
const entries = async (path) =>
  (await readFile(path, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
const within = (parent, child) =>
  child === parent || child.startsWith(parent + sep);
const COLLABORATION_TOOLS = new Set([
  "spawn_agent",
  "list_agents",
  "send_message",
  "followup_task",
  "wait_agent",
  "interrupt_agent",
]);
const CODING_TOOLS = new Set([
  "read",
  "write",
  "edit",
  "bash",
  "grep",
  "find",
  "ls",
]);
const timestamp = (value) => {
  const ms = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};
const difference = (start, end) =>
  start && end ? Math.max(0, Date.parse(end) - Date.parse(start)) : null;
const sum = (values) => values.reduce((total, value) => total + value, 0);

export function topologyMatches(arm, agents, adaptive, maxWorkers = 3) {
  if (arm === "single") return agents === null;
  if (!agents || !Array.isArray(agents.agents)) return false;
  const identities = agents.agents;
  const initial = identities
    .map((a) =>
      agents.turns?.find((t) => t.agentId === a.agentId && t.turnId === 1),
    )
    .filter(Boolean);
  const direct =
    agents.schemaVersion === 1 ||
    identities.every((a) => a.parentAgentId === "/root");
  return adaptive
    ? identities.length <= maxWorkers &&
        direct &&
        initial.length === identities.length
    : identities.length === 3 &&
        direct &&
        initial.length === 3 &&
        overlap(initial).commonMs > 0;
}

/** Tool arguments and model messages remain private; hashes only support exact-match review. */
export function toolCallsFromEntries(records) {
  const results = new Map(
    records
      .filter(
        (entry) =>
          entry.type === "message" && entry.message?.role === "toolResult",
      )
      .map((entry) => [entry.message.toolCallId, entry]),
  );
  return records.flatMap((entry) => {
    if (entry.type !== "message" || entry.message?.role !== "assistant")
      return [];
    return (entry.message.content ?? [])
      .filter((part) => part.type === "toolCall")
      .map((call) => {
        const result = results.get(call.id);
        return {
          toolCallId: call.id ?? null,
          name: call.name,
          category: COLLABORATION_TOOLS.has(call.name)
            ? "collaboration"
            : call.name.startsWith("game_")
              ? "game"
              : CODING_TOOLS.has(call.name)
                ? "coding"
                : "other",
          assistantResponseAt: timestamp(
            entry.timestamp ?? entry.message.timestamp,
          ),
          resultAt: result
            ? timestamp(result.timestamp ?? result.message.timestamp)
            : null,
          isError: result ? result.message.isError === true : null,
          argumentsSha256: createHash("sha256")
            .update(JSON.stringify(call.arguments ?? null))
            .digest("hex"),
        };
      });
  });
}
export function toolCallCounts(calls) {
  return {
    total: calls.length,
    coding: calls.filter((call) => call.category === "coding").length,
    game: calls.filter((call) => call.category === "game").length,
    collaboration: calls.filter((call) => call.category === "collaboration")
      .length,
    other: calls.filter((call) => call.category === "other").length,
    byName: Object.fromEntries(
      [...new Set(calls.map((call) => call.name))]
        .sort()
        .map((name) => [
          name,
          calls.filter((call) => call.name === name).length,
        ]),
    ),
  };
}

/** A Session may contain start/end entries and several cumulative turn snapshots. */
export function modelRequestMetrics(records, snapshots = []) {
  const byId = new Map();
  const persisted = records
    .filter(
      (entry) =>
        entry.type === "custom" &&
        entry.customType === "chronorift.model-request.v1",
    )
    .map((entry) => entry.data);
  for (const request of [...snapshots.flat(), ...persisted]) {
    if (!request?.requestId) continue;
    const existing = byId.get(request.requestId);
    if (existing?.finishedAt && !request.finishedAt) continue;
    byId.set(request.requestId, {
      requestId: request.requestId,
      boundary: request.boundary,
      provider: request.provider,
      model: request.model,
      startedAt: timestamp(request.startedAt),
      finishedAt: timestamp(request.finishedAt),
      durationMs: Number.isFinite(request.durationMs)
        ? request.durationMs
        : null,
      outcome: request.outcome,
      stopReason: request.stopReason ?? null,
      persistenceFailed:
        request.persistenceFailed === true ||
        existing?.persistenceFailed === true,
    });
  }
  const requests = [...byId.values()].sort(
    (a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt),
  );
  const durations = requests
    .map((request) => request.durationMs)
    .filter((value) => value !== null);
  return {
    requests,
    count: requests.length,
    completedCount: requests.filter(
      (request) => request.outcome === "completed",
    ).length,
    unfinishedCount: requests.filter((request) => request.finishedAt === null)
      .length,
    durationSumMs: durations.length ? sum(durations) : null,
    maximumDurationMs: durations.length ? Math.max(...durations) : null,
    complete:
      requests.length > 0 &&
      requests.every(
        (request) =>
          request.startedAt &&
          request.finishedAt &&
          request.durationMs !== null &&
          !request.persistenceFailed,
      ),
  };
}

export function executionTimingMetrics(performanceRecord) {
  const records = (performanceRecord?.records ?? []).map((record) => ({
    toolCallId: record.toolCallId,
    name: record.name,
    requestedAt: timestamp(record.requestedAt),
    lockRequestedAt: timestamp(record.lockRequestedAt),
    lockAcquiredAt: timestamp(record.lockAcquiredAt),
    finishedAt: timestamp(record.finishedAt),
    workspaceLockWaitMs: Number.isFinite(record.workspaceLockWaitMs)
      ? record.workspaceLockWaitMs
      : null,
    durationMs: Number.isFinite(record.durationMs) ? record.durationMs : null,
    outcome: record.outcome,
  }));
  const waits = records.filter((record) => record.lockRequestedAt !== null);
  const complete =
    performanceRecord?.schemaVersion === 1 &&
    records.every(
      (record) =>
        record.requestedAt &&
        record.finishedAt &&
        record.durationMs !== null &&
        (record.lockRequestedAt === null ||
          record.workspaceLockWaitMs !== null),
    );
  return {
    records,
    present: performanceRecord != null,
    complete,
    lockRequests: waits.length,
    cancelledOrFailedBeforeLock: waits.filter(
      (record) => record.lockAcquiredAt === null,
    ).length,
    workspaceLockWaitMs: performanceRecord
      ? sum(waits.map((record) => record.workspaceLockWaitMs ?? 0))
      : null,
    maximumLockWaitMs: performanceRecord
      ? Math.max(0, ...waits.map((record) => record.workspaceLockWaitMs ?? 0))
      : null,
    codingDurationSumMs: performanceRecord
      ? sum(
          records
            .filter((record) => CODING_TOOLS.has(record.name))
            .map((record) => record.durationMs ?? 0),
        )
      : null,
    gameDurationSumMs: performanceRecord
      ? sum(
          records
            .filter((record) => record.name.startsWith("game_"))
            .map((record) => record.durationMs ?? 0),
        )
      : null,
    captureDurationSumMs: performanceRecord
      ? sum(
          records
            .filter((record) => record.name === "capture_candidate")
            .map((record) => record.durationMs ?? 0),
        )
      : null,
  };
}

function gameOperationEnvelopes(event) {
  const envelopes = [event.result?.details];
  for (const part of event.result?.content ?? []) {
    if (part.type !== "text") continue;
    try {
      envelopes.push(JSON.parse(part.text));
    } catch {
      /* Not a game envelope. */
    }
  }
  return envelopes.filter((value) => value?.schemaVersion === 1);
}

/** SDK tool completion and a successful game operation are separate boundaries. */
export function toolExecutionSucceeded(event) {
  if (event?.type !== "tool_execution_end") return null;
  if (event.isError === true) return false;
  if (!event.toolName?.startsWith("game_"))
    return event.isError === false ? true : null;
  const outcomes = gameOperationEnvelopes(event).map((value) => value.outcome);
  if (outcomes.includes("error")) return false;
  return outcomes.includes("success") ? true : null;
}
const executionIdFromEvent = (event) => {
  const id = gameOperationEnvelopes(event).find(
    (value) => value.outcome === "success",
  )?.output?.executionId;
  return typeof id === "string" && id.length > 0 ? id : null;
};

export function lifecycleMetrics(rootEvents, workerRecords) {
  const ends = rootEvents.filter(
    (entry) => toolExecutionSucceeded(entry.event) === true,
  );
  const startFor = (end) =>
    rootEvents.find(
      (entry) =>
        entry.event?.type === "tool_execution_start" &&
        entry.event.toolCallId === end.event.toolCallId,
    )?.receivedAt ?? null;
  const edits = ends.filter((entry) =>
    ["edit", "write"].includes(entry.event.toolName),
  );
  const launches = ends.filter(
    (entry) => entry.event.toolName === "game_launch",
  );
  const lastEdit = edits.at(-1)?.receivedAt ?? null;
  const lastSuccessfulLaunch = launches.at(-1);
  const lastSuccessfulLaunchRequestedAt = lastSuccessfulLaunch
    ? startFor(lastSuccessfulLaunch)
    : null;
  const afterLastEdit =
    lastEdit && lastSuccessfulLaunchRequestedAt
      ? Date.parse(lastSuccessfulLaunchRequestedAt) >= Date.parse(lastEdit)
      : null;
  const finalLaunch =
    lastSuccessfulLaunchRequestedAt !== null && afterLastEdit !== false
      ? lastSuccessfulLaunch
      : undefined;
  const finalExecutionId = finalLaunch
    ? executionIdFromEvent(finalLaunch.event)
    : null;
  const finalLaunchRequestedAt = finalLaunch ? startFor(finalLaunch) : null;
  const responses = rootEvents.filter(
    (entry) =>
      entry.event?.type === "message_end" &&
      entry.event.message?.role === "assistant" &&
      entry.event.message.stopReason === "stop" &&
      !entry.event.message.content?.some((part) => part.type === "toolCall"),
  );
  const afterFinalLaunch =
    finalLaunch && finalExecutionId !== null
      ? ends.filter(
          (entry) =>
            Date.parse(entry.receivedAt) >=
              Date.parse(finalLaunch.receivedAt) &&
            executionIdFromEvent(entry.event) === finalExecutionId,
        )
      : [];
  return {
    rootFirstEditRequestedAt: edits[0] ? startFor(edits[0]) : null,
    rootFirstEditFinishedAt: edits[0]?.receivedAt ?? null,
    rootLastEditFinishedAt: lastEdit,
    rootLastSuccessfulGameLaunchRequestedAt: lastSuccessfulLaunchRequestedAt,
    rootFinalValidationExecutionId: finalExecutionId,
    rootFinalValidationRequestedAt: finalLaunchRequestedAt,
    rootFinalValidationLaunchFinishedAt: finalLaunch?.receivedAt ?? null,
    rootFinalValidationLastQueryAt:
      afterFinalLaunch
        .filter((entry) => entry.event.toolName === "game_query")
        .at(-1)?.receivedAt ?? null,
    rootFinalValidationStopAt:
      afterFinalLaunch
        .filter((entry) => entry.event.toolName === "game_stop")
        .at(-1)?.receivedAt ?? null,
    finalValidationLaunchAfterLastObservedEdit: afterLastEdit,
    rootFinalResponseAt: responses.at(-1)?.receivedAt ?? null,
    workers: (workerRecords?.agents ?? []).map((agent) => {
      const messages = (workerRecords.messages ?? []).map(
        (record) => record.envelope,
      );
      const path = agent.path ?? agent.taskName;
      const turns = (workerRecords.turns ?? []).filter(
        (turn) => turn.agentId === agent.agentId,
      );
      const parentPath =
        agent.parentAgentId === "/root"
          ? "/root"
          : workerRecords.agents.find((a) => a.agentId === agent.parentAgentId)
              ?.path;
      const initialTask = messages.find(
        (message) => message.kind === "task" && message.to === path,
      );
      const firstMessage = messages.find(
        (message) =>
          ["message", "completion"].includes(message.kind) &&
          message.from === path &&
          message.to === parentPath,
      );
      const completed = messages.find(
        (message) =>
          message.kind === "completion" &&
          message.from === path &&
          message.to === parentPath,
      );
      return {
        agentId: agent.agentId,
        path,
        spawnRecordedAt: initialTask?.createdAt ?? null,
        startedAt: turns[0]?.startedAt ?? null,
        firstParentMessageAt: firstMessage?.createdAt ?? null,
        firstParentMessageKind: firstMessage?.kind ?? null,
        firstCompletionNotificationAt: completed?.createdAt ?? null,
        naturalCompletedTurns: turns.filter(
          (turn) => turn.status === "completed",
        ).length,
        cancelledTurns: turns.filter((turn) => turn.status === "cancelled")
          .length,
        turns: turns.map((turn) => ({
          turnId: turn.turnId,
          status: turn.status,
          startedAt: turn.startedAt,
          settledAt: turn.settledAt ?? null,
          finishedAt: turn.finishedAt,
          cleanupAfterSettledMs: difference(turn.settledAt, turn.finishedAt),
        })),
      };
    }),
    limitations: [
      "First parent message is a timing proxy, not evidence that the assigned result was complete or used by Root.",
      "Final validation requires an observed successful Root game_launch after the last edit/write; queries and stop must succeed for that execution. The last successful launch is recorded separately when it predates edits. SDK tool completion alone is insufficient; acceptance is evaluated separately.",
      "Observed edit milestones include successful edit/write tools; shell-based source writes require separate review.",
      "Worker settledAt is when Host received a Pi terminal result, before resource cleanup; it is not the provider request end.",
    ],
  };
}

export function usageFromEntries(records, model) {
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  let cost = 0,
    pricedRequests = 0,
    unpricedEntries = 0;
  const issues = [],
    modelIdentities = new Set();
  for (const entry of records) {
    const message = entry.type === "message" ? entry.message : null;
    const assistant = message?.role === "assistant";
    const usage =
      assistant || message?.role === "toolResult"
        ? message.usage
        : ["compaction", "branch_summary"].includes(entry.type)
          ? entry.usage
          : undefined;
    if (assistant) {
      modelIdentities.add(message.provider + "/" + message.model);
      if (["error", "aborted"].includes(message.stopReason))
        issues.push("provider_" + message.stopReason);
      if (!usage) issues.push("missing_assistant_usage");
    }
    if (!usage) continue;
    if (
      !FIELDS.every(
        (field) => Number.isSafeInteger(usage[field]) && usage[field] >= 0,
      ) ||
      !Number.isFinite(usage.cost?.total) ||
      usage.cost.total < 0
    ) {
      issues.push("invalid_usage");
      continue;
    }
    for (const field of FIELDS) tokens[field] += usage[field];
    cost += usage.cost.total;
    if (
      assistant &&
      message.model === model.id &&
      message.provider === model.provider
    ) {
      const priced = structuredClone(usage);
      calculateCost(model, priced);
      pricedRequests++;
      if (!close(priced.cost.total, usage.cost.total))
        issues.push("request_price_mismatch");
    } else {
      unpricedEntries++;
    }
  }
  tokens.total = FIELDS.reduce((sum, field) => sum + tokens[field], 0);
  if (tokens.total > 0 && cost === 0) issues.push("zero_price_with_usage");
  return {
    tokens,
    cost,
    pricedRequests,
    unpricedEntries,
    issues: [...new Set(issues)],
    models: [...modelIdentities],
  };
}
export function reconcile(snapshot, recomputed) {
  if (!snapshot) return { matched: false, reason: "missing_snapshot" };
  return {
    matched:
      [...FIELDS, "total"].every(
        (field) => snapshot.tokens?.[field] === recomputed.tokens[field],
      ) && close(snapshot.cost, recomputed.cost),
    snapshotTokens: snapshot.tokens,
    snapshotCost: snapshot.cost,
  };
}
export function runtimeMatchesExpected(actual, expected) {
  return (
    actual !== null &&
    actual !== undefined &&
    ["provider", "model", "thinkingLevel"].every(
      (key) => actual[key] === expected[key],
    )
  );
}
export function ownershipMatches(
  ownership,
  provenance,
  sessionId,
  parentSessionId,
) {
  if (
    !ownership ||
    ownership.scope !== "session-owned" ||
    ownership.sessionId !== sessionId ||
    ownership.parentSessionId !== parentSessionId
  )
    return false;
  if (parentSessionId === null)
    return provenance === null && ownership.inheritedContextMessages === 0;
  return (
    typeof parentSessionId === "string" &&
    provenance?.parentSessionId === parentSessionId &&
    Number.isSafeInteger(provenance.inheritedContextMessages) &&
    provenance.inheritedContextMessages >= 0 &&
    ownership.inheritedContextMessages === provenance.inheritedContextMessages
  );
}
export function overlap(intervals) {
  const valid = intervals.filter(
    (i) =>
      i.startedAt &&
      i.finishedAt &&
      Date.parse(i.finishedAt) >= Date.parse(i.startedAt),
  );
  if (valid.length !== intervals.length || !valid.length)
    return { peak: 0, commonMs: 0, complete: false };
  const points = valid.flatMap((i) => [
    [Date.parse(i.startedAt), 1],
    [Date.parse(i.finishedAt), -1],
  ]);
  points.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let active = 0,
    peak = 0;
  for (const [, change] of points) {
    active += change;
    peak = Math.max(peak, active);
  }
  const commonMs = Math.max(
    0,
    Math.min(...valid.map((i) => Date.parse(i.finishedAt))) -
      Math.max(...valid.map((i) => Date.parse(i.startedAt))),
  );
  return { peak, commonMs, complete: true };
}
/** Completed assistant responses after the first stopping answer; this alone does not explain their cause. */
export function rootTailMetrics(events) {
  const responses = events.filter(
    (entry) =>
      entry.event?.type === "message_end" &&
      entry.event.message?.role === "assistant",
  );
  const first = responses.findIndex(
    ({ event }) =>
      event.message.stopReason === "stop" &&
      event.message.content?.some(
        (part) => part.type === "text" && part.text.trim(),
      ) &&
      !event.message.content.some((part) => part.type === "toolCall"),
  );
  const later = first < 0 ? [] : responses.slice(first + 1);
  const ended = later.at(-1)?.receivedAt;
  const started = first < 0 ? null : responses[first].receivedAt;
  return {
    firstStoppingResponseAt: started,
    laterAssistantResponses: first < 0 ? null : later.length,
    laterDurationMs:
      first < 0 ? null : ended ? Date.parse(ended) - Date.parse(started) : 0,
    laterEstimatedCostUSD:
      first < 0
        ? null
        : later.reduce(
            (sum, entry) => sum + (entry.event.message.usage?.cost?.total ?? 0),
            0,
          ),
  };
}
export async function summarize(root, outputDirectory = root) {
  root = resolve(root);
  outputDirectory = resolve(outputDirectory);
  const manifest = await json(join(root, "manifest.json"));
  const checks = await json(join(root, "evaluation/results.json"));
  const rows = [],
    accounting = [],
    timingAudit = [],
    starts = [],
    investigations = [];
  const ids =
    manifest.ids ??
    (manifest.cases ?? ["gn1", "city"]).flatMap((kind) => [
      `${kind}-single`,
      `${kind}-multi`,
    ]);
  if (
    !Array.isArray(ids) ||
    !ids.length ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => !/^[a-z0-9_]+-(single|multi)$/u.test(id))
  )
    throw new Error("Invalid manifest arm IDs");
  const adaptive = manifest.collaborationPolicy === "adaptive";
  for (const id of ids) {
    const directory = join(root, id),
      [kind, arm] = id.split("-");
    const start = await optional(join(directory, "start.json"));
    const done = await optional(join(directory, "completion.json"));
    const preview = await optional(join(directory, "preview.json"));
    const rootResult = await optional(join(directory, "root-result.json"));
    // Serial batches can stop before later arm directories are created. Retain
    // those arms as missing records; malformed or inaccessible inputs still fail.
    const armFiles = await readdir(directory).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    const workerConfigurations = await Promise.all(
      armFiles
        .filter((name) => /^worker-[0-9]+-configuration\.json$/u.test(name))
        .map((name) => json(join(directory, name))),
    );
    if (start) starts.push(Date.parse(start.startedAt));
    investigations.push({
      startedAt: done?.investigationStartedAt,
      finishedAt: done?.investigationFinishedAt,
    });
    let agents = null;
    if (preview?.agents?.recordPath) {
      if (!within(directory, resolve(preview.agents.recordPath)))
        throw new Error("Agent records escape the Run");
      agents = await json(preview.agents.recordPath);
    }
    const sessions = [];
    if (rootResult)
      sessions.push({
        agent: "root",
        sessionFile: rootResult.sessionFile,
        stats: rootResult.stats,
        status: rootResult.status,
        usageOwnership: rootResult.usageOwnership,
      });
    for (const worker of agents?.workerUsage ?? []) {
      sessions.push({
        agent: worker.agentId,
        sessionFile: worker.sessionStats?.sessionFile,
        stats: worker.sessionStats,
        incomplete: worker.incomplete,
        usageOwnership: worker.usageOwnership,
        status: agents.turns.filter((t) => t.agentId === worker.agentId).at(-1)
          ?.status,
      });
    }
    const seen = new Set(),
      sessionChecks = [],
      agentTimings = [];
    const taskDirectory = preview?.taskDirectory
      ? resolve(preview.taskDirectory)
      : null;
    if (taskDirectory && !within(directory, taskDirectory))
      throw new Error("Task directory escapes Run");
    for (const session of sessions) {
      if (!session.sessionFile) {
        sessionChecks.push({ agent: session.agent, missing: true });
        continue;
      }
      const path = resolve(session.sessionFile);
      if (!within(directory, path) || seen.has(path))
        throw new Error("Escaped or duplicate Session");
      seen.add(path);
      const records = await entries(path);
      const isRoot = session.agent === "root";
      const modelSnapshots = isRoot
        ? [rootResult?.modelRequests ?? agents?.rootModelRequests ?? []]
        : (agents?.turns ?? [])
            .filter((turn) => turn.agentId === session.agent)
            .map((turn) => turn.modelRequests ?? []);
      const timingPath =
        taskDirectory === null
          ? null
          : isRoot
            ? join(
                taskDirectory,
                agents ? "runtime-records" : "records",
                "performance.v1.json",
              )
            : join(
                taskDirectory,
                "records",
                "agents",
                session.agent,
                "runtime",
                "performance.v1.json",
              );
      if (timingPath && !within(directory, resolve(timingPath)))
        throw new Error("Performance record escapes Run");
      const calls = toolCallsFromEntries(records);
      agentTimings.push({
        agent: session.agent,
        path: isRoot
          ? "/root"
          : agents?.agents.find((agent) => agent.agentId === session.agent)
              ?.path,
        toolCallCounts: toolCallCounts(calls),
        toolCalls: calls,
        modelRequests: modelRequestMetrics(records, modelSnapshots),
        execution: executionTimingMetrics(
          timingPath ? await optional(timingPath) : null,
        ),
      });
      const recomputed = usageFromEntries(records, manifest.model.metadata);
      const toolErrors = records.filter(
        (entry) =>
          entry.type === "message" &&
          entry.message?.role === "toolResult" &&
          entry.message.isError,
      ).length;
      const header = records.find((r) => r.type === "session");
      const modelChange = records.findLast(
        (record) => record.type === "model_change",
      );
      const thinkingChange = records.findLast(
        (record) => record.type === "thinking_level_change",
      );
      const realizedRuntime = {
        provider: modelChange?.provider,
        model: modelChange?.modelId,
        thinkingLevel: thinkingChange?.thinkingLevel,
      };
      const provenance =
        records.find(
          (r) =>
            r.type === "custom" &&
            r.customType === "chronorift.fork-provenance",
        )?.data ?? null;
      const parentAgentId = agents?.agents.find(
        (agent) => agent.agentId === session.agent,
      )?.parentAgentId;
      const taskParentSessionId =
        session.agent === "root"
          ? null
          : parentAgentId === "/root"
            ? rootResult?.stats.sessionId
            : agents?.agents.find((agent) => agent.agentId === parentAgentId)
                ?.sessionId;
      // A task parent does not imply inherited context when fork_turns is none.
      const parentSessionId = provenance === null ? null : taskParentSessionId;
      const usageOwnershipVerified =
        manifest.config.collaborationVersion === 2
          ? ownershipMatches(
              session.usageOwnership,
              provenance,
              header?.id,
              parentSessionId,
            )
          : null;
      if (!header || header.id !== session.stats.sessionId)
        recomputed.issues.push("session_identity_mismatch");
      if (usageOwnershipVerified === false)
        recomputed.issues.push("usage_ownership_mismatch");
      sessionChecks.push({
        agent: session.agent,
        sessionId: header?.id,
        realizedRuntime,
        status: session.status,
        reportedIncomplete: session.incomplete ?? false,
        recomputed,
        toolErrors,
        usageOwnership: session.usageOwnership ?? null,
        usageOwnershipVerified,
        forkProvenance: provenance,
        taskParentSessionId,
        reconciliation: reconcile(session.stats, recomputed),
      });
    }
    const reported = sessionChecks.filter((s) => s.recomputed);
    const tokens = reported.reduce(
      (sum, s) => sum + s.recomputed.tokens.total,
      0,
    );
    const estimatedCost = reported.reduce(
      (sum, s) => sum + s.recomputed.cost,
      0,
    );
    const reconciled =
      sessions.length > 0 &&
      sessionChecks.every((s) => s.reconciliation?.matched === true);
    const usageIncomplete =
      !rootResult ||
      sessionChecks.some(
        (s) =>
          s.missing ||
          s.reportedIncomplete ||
          s.status !== "completed" ||
          s.recomputed?.issues.length,
      );
    const summaryMatches = agents
      ? agents.reportedUsage.tokens === tokens &&
        close(agents.reportedUsage.cost, estimatedCost)
      : null;
    const turns = agents?.turns ?? [];
    const initialTurns = (agents?.agents ?? [])
      .map((a) => turns.find((t) => t.agentId === a.agentId && t.turnId === 1))
      .filter(Boolean);
    const workerOverlap = overlap(initialTurns),
      allWorkerOverlap = overlap(turns.filter((t) => t.startedAt));
    const accepted = checks.filter((c) => c.id === id);
    const evaluationInvocations = await Promise.all(
      accepted.map(async (check) =>
        check.output ? optional(join(check.output, "invocation.json")) : null,
      ),
    );
    const consistent =
      accepted.length === 2 && accepted[0].outcome === accepted[1].outcome;
    const outcome = !consistent ? "unstable_or_missing" : accepted[0].outcome;
    const rootEvents = await entries(
      join(directory, "root-events.jsonl"),
    ).catch(() => []);
    const completedTools = rootEvents.filter(
      (e) => e.event?.type === "tool_execution_end",
    );
    const runtimeRecords = [];
    for (const path of preview?.executions ?? []) {
      if (!within(directory, resolve(path)))
        throw new Error("Execution record escapes Run");
      runtimeRecords.push(await json(path));
    }
    let patchVerified = false;
    if (preview?.candidatePatch) {
      const patch = preview.candidatePatch;
      if (!within(directory, resolve(patch.path)))
        throw new Error("Patch escapes Run");
      const bytes = await readFile(patch.path);
      patchVerified =
        patch.roundTripVerified &&
        bytes.length === patch.byteLength &&
        createHash("sha256").update(bytes).digest("hex") === patch.sha256;
    }
    const topologySatisfied = topologyMatches(
      arm,
      agents,
      adaptive,
      manifest.protocol?.maximumWorkers ?? 3,
    );
    const runtimeConfigurationSatisfied =
      runtimeMatchesExpected(
        rootResult && {
          provider: rootResult.provider,
          model: rootResult.model,
          thinkingLevel: rootResult.requestedThinkingLevel,
        },
        manifest.config,
      ) &&
      workerConfigurations.every((record) =>
        runtimeMatchesExpected(record.configuration, manifest.config),
      ) &&
      sessionChecks.every((session) =>
        runtimeMatchesExpected(session.realizedRuntime, manifest.config),
      );
    const rootTiming = agentTimings.find((agent) => agent.agent === "root");
    const workerTimings = agentTimings.filter(
      (agent) => agent.agent !== "root",
    );
    const rootUsage = sessionChecks.find(
      (session) => session.agent === "root",
    )?.recomputed;
    const workerCalls = toolCallCounts(
      workerTimings.flatMap((agent) => agent.toolCalls),
    );
    const allTimingsPresent =
      agentTimings.length === sessions.length &&
      agentTimings.length > 0 &&
      agentTimings.every((agent) => agent.execution.present);
    const timingComplete =
      allTimingsPresent &&
      agentTimings.every(
        (agent) => agent.execution.complete && agent.modelRequests.complete,
      );
    const lifecycle = lifecycleMetrics(rootEvents, agents);
    const latestWorkerTurns = (agents?.agents ?? []).map((agent) =>
      turns.filter((turn) => turn.agentId === agent.agentId).at(-1),
    );
    timingAudit.push({
      id,
      lifecycle,
      agents: agentTimings,
      complete: timingComplete,
      limitations: [
        "Durations and waits are summed across agents and may overlap; they are not additive wall-clock or causal critical-path measurements.",
        "Tool calls are counted from Session assistant toolCall entries, including calls that fail or are cancelled; tool response timestamps are not exact execution admission timestamps.",
        "Argument hashes permit exact repeated-call comparison without publishing commands or model content; semantically duplicate investigations still need manual review.",
        "Pi stream-function timings include transport and provider delay, but do not expose each internal HTTP retry or pure inference time.",
      ],
    });
    rows.push({
      id,
      case: kind,
      arm,
      cohort: manifest.cohort ?? "legacy",
      collaborationPolicy: adaptive ? "adaptive" : "forced-m3",
      collaborationVersion: agents?.schemaVersion ?? null,
      workspaceMode: preview?.workspaceMode ?? (agents ? "isolated" : "single"),
      status: done?.status ?? "missing",
      workerCount: agents?.agents.length ?? 0,
      peakActiveWorkers: allWorkerOverlap.peak,
      initialThreeWorkersOverlapMs: workerOverlap.commonMs,
      naturalCompletedWorkers: latestWorkerTurns.filter(
        (turn) => turn?.status === "completed",
      ).length,
      cancelledWorkers: latestWorkerTurns.filter(
        (turn) => turn?.status === "cancelled",
      ).length,
      failedWorkers: latestWorkerTurns.filter(
        (turn) => turn?.status === "failed",
      ).length,
      timedOutWorkers: latestWorkerTurns.filter(
        (turn) => turn?.status === "timed_out",
      ).length,
      topologySatisfied,
      runtimeConfigurationSatisfied,
      comparisonProtocolSatisfied:
        topologySatisfied && runtimeConfigurationSatisfied,
      workerThinkingLevels: [
        ...new Set(
          workerConfigurations.map(
            (record) => record.configuration.thinkingLevel,
          ),
        ),
      ],
      hostDurationMs: done?.durationMs ?? null,
      investigationDurationMs:
        done?.investigationFinishedAt && done?.investigationStartedAt
          ? Date.parse(done.investigationFinishedAt) -
            Date.parse(done.investigationStartedAt)
          : null,
      evaluationDurationMs:
        evaluationInvocations.length === 2 &&
        evaluationInvocations.every((i) => Number.isFinite(i?.durationMs))
          ? evaluationInvocations.reduce(
              (sum, invocation) => sum + invocation.durationMs,
              0,
            )
          : null,
      tokens: reported.length ? tokens : null,
      inputTokens: reported.length
        ? reported.reduce((sum, s) => sum + s.recomputed.tokens.input, 0)
        : null,
      outputTokens: reported.length
        ? reported.reduce((sum, s) => sum + s.recomputed.tokens.output, 0)
        : null,
      cacheReadTokens: reported.length
        ? reported.reduce((sum, s) => sum + s.recomputed.tokens.cacheRead, 0)
        : null,
      cacheWriteTokens: reported.length
        ? reported.reduce((sum, s) => sum + s.recomputed.tokens.cacheWrite, 0)
        : null,
      estimatedCostUSD: reported.length ? estimatedCost : null,
      rootOnlyTokens: rootUsage?.tokens.total ?? null,
      rootOnlyEstimatedCostUSD: rootUsage?.cost ?? null,
      workerTokens: rootUsage ? tokens - rootUsage.tokens.total : null,
      rootToolCalls: rootTiming?.toolCallCounts.total ?? null,
      rootCodingToolCalls: rootTiming?.toolCallCounts.coding ?? null,
      rootGameToolCalls: rootTiming?.toolCallCounts.game ?? null,
      rootCollaborationToolCalls:
        rootTiming?.toolCallCounts.collaboration ?? null,
      workerToolCalls: workerCalls.total,
      workerCodingToolCalls: workerCalls.coding,
      workerGameToolCalls: workerCalls.game,
      workerCollaborationToolCalls: workerCalls.collaboration,
      workspaceLockWaitMs: allTimingsPresent
        ? sum(agentTimings.map((agent) => agent.execution.workspaceLockWaitMs))
        : null,
      rootWorkspaceLockWaitMs:
        rootTiming?.execution.workspaceLockWaitMs ?? null,
      workerWorkspaceLockWaitMs: allTimingsPresent
        ? sum(workerTimings.map((agent) => agent.execution.workspaceLockWaitMs))
        : null,
      maximumWorkspaceLockWaitMs: allTimingsPresent
        ? Math.max(
            ...agentTimings.map((agent) => agent.execution.maximumLockWaitMs),
          )
        : null,
      rootModelRequests: rootTiming?.modelRequests.count ?? null,
      workerModelRequests: sum(
        workerTimings.map((agent) => agent.modelRequests.count),
      ),
      rootModelRequestDurationSumMs:
        rootTiming?.modelRequests.durationSumMs ?? null,
      workerModelRequestDurationSumMs: workerTimings.every(
        (agent) => agent.modelRequests.durationSumMs !== null,
      )
        ? sum(workerTimings.map((agent) => agent.modelRequests.durationSumMs))
        : null,
      performanceTelemetryComplete: timingComplete,
      rootFirstEditAt: lifecycle.rootFirstEditRequestedAt,
      rootFinalValidationAt: lifecycle.rootFinalValidationRequestedAt,
      rootLastSuccessfulGameLaunchAt:
        lifecycle.rootLastSuccessfulGameLaunchRequestedAt,
      rootFinalResponseAt: lifecycle.rootFinalResponseAt,
      usageReconciled: reconciled,
      usageOwnershipReconciled:
        manifest.config.collaborationVersion === 2
          ? sessionChecks.length > 0 &&
            sessionChecks.every(
              (session) => session.usageOwnershipVerified === true,
            )
          : null,
      multiSummaryMatches: summaryMatches,
      usageIncomplete: !!usageIncomplete,
      allUsageEntriesPriced:
        reported.length > 0 &&
        reported.every((s) => s.recomputed.unpricedEntries === 0),
      actualBilledCost: null,
      acceptance: outcome,
      acceptanceRepeatedConsistently: consistent,
      patchVerified,
      patchSha256: preview?.candidatePatch?.sha256 ?? null,
      sourceCheckoutUnchanged: done?.sourceCheckoutUnchanged ?? null,
      rootGameLaunches: completedTools.filter(
        (e) => e.event.toolName === "game_launch",
      ).length,
      rootSuccessfulGameLaunches: completedTools.filter(
        (e) =>
          e.event.toolName === "game_launch" &&
          toolExecutionSucceeded(e.event) === true,
      ).length,
      rootFailedGameLaunches: completedTools.filter(
        (e) =>
          e.event.toolName === "game_launch" &&
          toolExecutionSucceeded(e.event) === false,
      ).length,
      rootUnknownGameLaunches: completedTools.filter(
        (e) =>
          e.event.toolName === "game_launch" &&
          toolExecutionSucceeded(e.event) === null,
      ).length,
      finalValidationLaunchAfterLastObservedEdit:
        lifecycle.finalValidationLaunchAfterLastObservedEdit,
      rootPatchApplyCalls: completedTools.filter(
        (e) => e.event.toolName === "apply_agent_patch",
      ).length,
      providerRetries: rootEvents.filter(
        (e) => e.event?.type === "auto_retry_start",
      ).length,
      toolResultErrors: sessionChecks.reduce(
        (sum, check) => sum + (check.toolErrors ?? 0),
        0,
      ),
      sharedToolCalls: agents?.sharedToolCalls ?? null,
      collaborationMessages: agents?.messages?.length ?? null,
      collaborationMessagesConsumed:
        agents?.messages?.filter((message) => message.consumedAt !== null)
          .length ?? null,
      collaborationDeliveryErrors:
        agents?.messages?.filter((message) => message.error !== null).length ??
        null,
      rootTail: rootTailMetrics(rootEvents),
      failure: done?.failure ?? preview?.failureMessage ?? null,
    });
    accounting.push({
      id,
      sessionChecks,
      workerOverlap,
      allWorkerOverlap,
      checks: accepted,
      rootToolCompletions: completedTools.map((e) => ({
        at: e.receivedAt,
        tool: e.event.toolName,
        isError: e.event.isError,
        operationSucceeded: toolExecutionSucceeded(e.event),
      })),
      runtimeRecords,
      limitations: preview?.limitations ?? [],
    });
  }
  const concurrency = overlap(investigations);
  const completion = await json(join(root, "live-completion.json"));
  const modelProcesses = completion.observedProcesses.filter((p) =>
    ["root", "worker"].includes(p.role),
  );
  const summary = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    summarizerSha256: createHash("sha256")
      .update(await readFile(fileURLToPath(import.meta.url)))
      .digest("hex"),
    rows,
    cohort: manifest.cohort ?? "legacy",
    collaborationPolicy: adaptive ? "adaptive" : "forced-m3",
    comparisonProtocolSatisfied: rows.every(
      (row) => row.comparisonProtocolSatisfied,
    ),
    concurrency,
    modelProcessCount: modelProcesses.length,
    allModelProcessesIpv4First:
      modelProcesses.length > 0 &&
      modelProcesses.every(
        (p) => p.dnsOrderArgument === "--dns-result-order=ipv4first",
      ),
    actualConnectionAddressFamily: null,
    survivingObservedProcessCount: completion.survivingObservedProcesses.length,
    startSkewMs:
      starts.length === ids.length
        ? Math.max(...starts) - Math.min(...starts)
        : null,
    totalReportedTokens: rows.reduce((sum, row) => sum + (row.tokens ?? 0), 0),
    totalEstimatedCostUSD: rows.reduce(
      (sum, row) => sum + (row.estimatedCostUSD ?? 0),
      0,
    ),
    actualBilledCost: null,
    estimatedCostMeaning: "SDK estimate, not provider invoice",
    limitations: [
      "One attempt per case and arm; development and holdout cohorts remain separate; no population-level superiority claim.",
      "Hosts in a cohort share machine/provider capacity.",
      "Missing provider usage cannot be recovered from a successful SDK reconciliation.",
      ...(rows.every((row) => row.comparisonProtocolSatisfied)
        ? []
        : [
            "Configured model/effort or worker topology deviated from the comparison protocol; these runs do not establish a controlled Single/Multi comparison.",
          ]),
    ],
  };
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  await writeFile(
    join(outputDirectory, "summary.json"),
    JSON.stringify(summary, null, 2) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  await writeFile(
    join(outputDirectory, "accounting.json"),
    JSON.stringify(accounting, null, 2) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  await writeFile(
    join(outputDirectory, "timing-audit.json"),
    JSON.stringify({ schemaVersion: 1, runs: timingAudit }, null, 2) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  const columns = Object.keys(rows[0]);
  const cell = (v) =>
    '"' +
    (v !== null && typeof v === "object"
      ? JSON.stringify(v)
      : String(v ?? "")
    ).replaceAll('"', '""') +
    '"';
  await writeFile(
    join(outputDirectory, "results.csv"),
    [
      columns.join(","),
      ...rows.map((row) => columns.map((key) => cell(row[key])).join(",")),
    ].join("\n") + "\n",
    { flag: "wx", mode: 0o600 },
  );
  console.log(JSON.stringify(summary, null, 2));
  return summary;
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (process.argv.length < 3 || process.argv.length > 4)
    throw new Error(
      "Usage: node summarize.mjs PILOT_DIRECTORY [OUTPUT_DIRECTORY]",
    );
  await summarize(process.argv[2], process.argv[3]);
}
