// Read-only accounting and compact projections; raw messages stay in local state.
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
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
export async function summarize(root) {
  root = resolve(root);
  const manifest = await json(join(root, "manifest.json"));
  const checks = await json(join(root, "evaluation/results.json"));
  const rows = [],
    accounting = [],
    starts = [],
    investigations = [];
  for (const id of ["gn1-single", "gn1-multi", "city-single", "city-multi"]) {
    const directory = join(root, id),
      [kind, arm] = id.split("-");
    const start = await optional(join(directory, "start.json"));
    const done = await optional(join(directory, "completion.json"));
    const preview = await optional(join(directory, "preview.json"));
    const rootResult = await optional(join(directory, "root-result.json"));
    const workerConfigurations = await Promise.all(
      (await readdir(directory))
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
      sessionChecks = [];
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
    const topologySatisfied =
      arm === "single"
        ? !agents
        : agents?.agents.length === 3 &&
          (agents.schemaVersion === 1 ||
            agents.agents.every((agent) => agent.parentAgentId === "/root")) &&
          initialTurns.length === 3 &&
          workerOverlap.commonMs > 0;
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
    rows.push({
      id,
      case: kind,
      arm,
      collaborationVersion: agents?.schemaVersion ?? null,
      workspaceMode: preview?.workspaceMode ?? (agents ? "isolated" : "single"),
      status: done?.status ?? "missing",
      workerCount: agents?.agents.length ?? 0,
      peakActiveWorkers: allWorkerOverlap.peak,
      initialThreeWorkersOverlapMs: workerOverlap.commonMs,
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
    comparisonProtocolSatisfied: rows.every(
      (row) => row.comparisonProtocolSatisfied,
    ),
    concurrency,
    modelProcessCount: modelProcesses.length,
    allModelProcessesIpv4First:
      modelProcesses.length >= 10 &&
      modelProcesses.every(
        (p) => p.dnsOrderArgument === "--dns-result-order=ipv4first",
      ),
    actualConnectionAddressFamily: null,
    survivingObservedProcessCount: completion.survivingObservedProcesses.length,
    startSkewMs:
      starts.length === 4 ? Math.max(...starts) - Math.min(...starts) : null,
    totalReportedTokens: rows.reduce((sum, row) => sum + (row.tokens ?? 0), 0),
    totalEstimatedCostUSD: rows.reduce(
      (sum, row) => sum + (row.estimatedCostUSD ?? 0),
      0,
    ),
    actualBilledCost: null,
    estimatedCostMeaning: "SDK estimate, not provider invoice",
    limitations: [
      "Two known tasks and one attempt per arm; no population-level superiority claim.",
      "All four Hosts share machine/provider capacity.",
      "Missing provider usage cannot be recovered from a successful SDK reconciliation.",
      ...(rows.every((row) => row.comparisonProtocolSatisfied)
        ? []
        : [
            "Configured model/effort or worker topology deviated from the comparison protocol; these runs do not establish a controlled Single/Multi comparison.",
          ]),
    ],
  };
  await writeFile(
    join(root, "summary.json"),
    JSON.stringify(summary, null, 2) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  await writeFile(
    join(root, "accounting.json"),
    JSON.stringify(accounting, null, 2) + "\n",
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
    join(root, "results.csv"),
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
  if (process.argv.length !== 3)
    throw new Error("Usage: node summarize.mjs PILOT_DIRECTORY");
  await summarize(process.argv[2]);
}
