// Read-only reduction of local actual tool events. Never invokes an Agent.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value) => typeof value === "string" && value.length > 0;
const sha256 = (value) => text(value) && /^[a-f0-9]{64}$/u.test(value);
const readFailure = (path, error) => ({
  path,
  status: error?.code === "ENOENT" ? "missing" : "unreadable",
  code: error?.code ?? null,
});
const readBytes = async (path) => {
  if (!text(path))
    return { value: null, evidence: { path: null, status: "not_recorded" } };
  try {
    return {
      value: await readFile(path),
      evidence: { path, status: "available" },
    };
  } catch (error) {
    return { value: null, evidence: readFailure(path, error) };
  }
};
const readJson = async (path) => {
  const loaded = await readBytes(path);
  if (loaded.value === null) return loaded;
  let value;
  try {
    value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(loaded.value),
    );
  } catch {
    return { value: null, evidence: { path, status: "invalid_json" } };
  }
  return object(value)
    ? { value, evidence: loaded.evidence }
    : { value: null, evidence: { path, status: "invalid_shape" } };
};
// null means the evidence cannot establish either equality or inequality.
const compare = (a, b, valid) =>
  valid(a) && valid(b) ? JSON.stringify(a) === JSON.stringify(b) : null;
const save = (path, value) =>
  writeFile(path, JSON.stringify(value, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
export function failedTool(event) {
  if (event.isError) return true;
  const details = event.result?.details;
  if (
    details?.outcome === "error" ||
    details?.status === "failed" ||
    details?.status === "cancelled" ||
    details?.status === "timed_out"
  )
    return true;
  for (const content of event.result?.content ?? []) {
    if (content.type !== "text") continue;
    // Pi's coding bridge appends this actual process footer but may leave
    // tool_execution_end.isError false. Retain and count the reported failure.
    if (
      /\[Command (?:failed|timed out|cancelled); exitCode=/u.test(content.text)
    )
      return true;
    try {
      const parsed = JSON.parse(content.text);
      if (parsed?.outcome === "error") return true;
    } catch {
      /* Ordinary text results are valid. */
    }
  }
  return false;
}
export async function summarizePair({ pair, output }) {
  pair = resolve(pair);
  output = resolve(output);
  await mkdir(output, { mode: 0o700 });
  const manifestInput = await readJson(join(pair, "manifest.json"));
  const manifest = manifestInput.value;
  const arms = [],
    configurations = [];
  for (const arm of ["A", "B"]) {
    const directory = join(pair, arm);
    const inputs = {};
    for (const [name, file] of Object.entries({
      completion: "completion.json",
      preview: "preview-result.json",
      pi: "pi-result.json",
      configuration: "session-configuration.json",
    }))
      inputs[name] = await readJson(join(directory, file));
    const completion = inputs.completion.value;
    const preview = inputs.preview.value;
    const pi = inputs.pi.value;
    const configuration = inputs.configuration.value;
    configurations.push(configuration);
    const evidence = Object.fromEntries(
      Object.entries(inputs).map(([name, input]) => [name, input.evidence]),
    );
    const calls = [],
      byId = new Map(),
      retries = [];
    const eventsPath = join(directory, "events.jsonl");
    const inputStream = createReadStream(eventsPath);
    const stream = createInterface({
      input: inputStream,
      crlfDelay: Infinity,
    });
    let lineNumber = 0;
    evidence.events = { path: eventsPath, status: "available" };
    try {
      for await (const line of stream) {
        lineNumber += 1;
        if (!line) continue;
        let entry;
        try {
          entry = JSON.parse(line);
        } catch {
          evidence.events = {
            path: eventsPath,
            status: "invalid_json",
            line: lineNumber,
          };
          break;
        }
        assert.ok(
          object(entry) && object(entry.event) && text(entry.event.type),
          "Invalid event shape",
        );
        const event = entry.event;
        if (["tool_execution_start", "tool_execution_end"].includes(event.type))
          assert.ok(
            text(event.toolCallId) &&
              text(event.toolName) &&
              text(entry.receivedAt) &&
              Number.isFinite(entry.elapsedMs),
            "Invalid tool event identity or timestamp",
          );
        if (event.type === "tool_execution_start") {
          const call = {
            index: calls.length + 1,
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            args: event.args,
            startedAt: entry.receivedAt,
            startElapsedMs: entry.elapsedMs,
          };
          assert.ok(!byId.has(event.toolCallId), "Duplicate tool start");
          byId.set(event.toolCallId, call);
          calls.push(call);
        } else if (event.type === "tool_execution_end") {
          const call = byId.get(event.toolCallId);
          assert.ok(call, "Unmatched tool end");
          assert.ok(!call.endedAt, "Duplicate tool end");
          Object.assign(call, {
            endedAt: entry.receivedAt,
            durationMs: entry.elapsedMs - call.startElapsedMs,
            isError: event.isError,
            failed: failedTool(event),
            result: event.result,
          });
        } else if (event.type.includes("retry")) retries.push(entry);
      }
    } catch (error) {
      evidence.events =
        error?.code === "ERR_ASSERTION"
          ? {
              path: eventsPath,
              status: "invalid_shape",
              line: lineNumber,
              message: error.message,
            }
          : readFailure(eventsPath, error);
    } finally {
      stream.close();
      inputStream.destroy();
    }
    const counts = {};
    for (const call of calls)
      counts[call.toolName] = (counts[call.toolName] ?? 0) + 1;
    const patchInput = await readBytes(preview?.candidatePatch?.path);
    const patch = patchInput.value;
    evidence.patch = patchInput.evidence;
    const patchMatchesPreview =
      patch !== null &&
      sha256(preview?.candidatePatch?.sha256) &&
      digest(patch) === preview.candidatePatch.sha256 &&
      patch.byteLength === preview.candidatePatch.byteLength;
    if (patch !== null && !patchMatchesPreview)
      evidence.patch = {
        ...evidence.patch,
        status: "metadata_mismatch",
        expectedSha256: preview?.candidatePatch?.sha256 ?? null,
        observedSha256: digest(patch),
        expectedByteLength: preview?.candidatePatch?.byteLength ?? null,
        observedByteLength: patch.byteLength,
      };
    if (patch)
      await writeFile(join(output, `${arm}.patch`), patch, {
        flag: "wx",
        mode: 0o600,
      });
    const executions = await Promise.all(
      (Array.isArray(preview?.executions) ? preview.executions : []).map(
        async (path) => {
          const input = await readJson(path);
          return { path, record: input.value, evidence: input.evidence };
        },
      ),
    );
    const record = {
      arm,
      status: completion?.status ?? "unknown",
      durationMs: completion?.durationMs ?? null,
      evidence,
      sourceSha256: preview?.sourceSha256,
      initialCandidateSourceSha256: configuration?.candidateInitialSourceSha256,
      sessionFile: preview?.sessionFile,
      provider: pi?.provider,
      model: pi?.model,
      requestedThinking: pi?.requestedThinkingLevel,
      realizedThinking: pi?.realizedThinkingLevel,
      stats: pi?.stats,
      toolCalls: calls.length,
      toolTraceComplete: evidence.events.status === "available",
      toolCounts: counts,
      failedTools: calls.filter((c) => c.failed),
      unfinishedTools: calls.filter((c) => !c.endedAt),
      retries,
      patch: patch
        ? {
            sha256: digest(patch),
            byteLength: patch.byteLength,
            originalPath: preview.candidatePatch.path,
            copyPath: join(output, `${arm}.patch`),
            roundTripVerified:
              patchMatchesPreview &&
              preview.candidatePatch.roundTripVerified === true,
          }
        : null,
      previewFailure: {
        code: preview?.failureCode,
        message: preview?.failureMessage,
      },
      invocationFailure: completion?.invocationFailure,
      sourceCheckoutUnchanged: completion?.sourceCheckoutUnchanged,
      executions,
      assistantText: pi?.assistantText,
    };
    await save(join(output, `${arm}-tools.json`), calls);
    await save(join(output, `${arm}-summary.json`), record);
    arms.push(record);
  }
  const [aConfig, bConfig] = configurations;
  const tools = (value) =>
    Array.isArray(value) &&
    value.every((tool) => object(tool) && text(tool.name));
  const bSharedTools = tools(bConfig?.toolDefinitions)
    ? bConfig.toolDefinitions.filter((tool) => tool.name !== "game_watch")
    : undefined;
  const knownModel =
    text(manifest?.provider) &&
    text(manifest?.model) &&
    arms.every((arm) => text(arm.provider) && text(arm.model));
  const knownThinking =
    text(manifest?.thinkingLevel) &&
    arms.every((arm) => text(arm.realizedThinking));
  const comparability = {
    sameInitialCandidateBytes: compare(
      arms[0].initialCandidateSourceSha256,
      arms[1].initialCandidateSourceSha256,
      sha256,
    ),
    sameSelectedSource: compare(
      arms[0].sourceSha256,
      arms[1].sourceSha256,
      sha256,
    ),
    sameSharedToolDefinitions: compare(
      aConfig?.toolDefinitions,
      bSharedTools,
      tools,
    ),
    sameResources: compare(aConfig?.resources, bConfig?.resources, object),
    sameEnvironmentProse: compare(
      aConfig?.additionalEnvironmentInstructions,
      bConfig?.additionalEnvironmentInstructions,
      (value) => typeof value === "string",
    ),
    sameCodingAppendix: compare(
      aConfig?.codingAppendix,
      bConfig?.codingAppendix,
      (value) => typeof value === "string",
    ),
    sameRequestedModel: knownModel
      ? arms.every(
          (a) => a.provider === manifest.provider && a.model === manifest.model,
        )
      : null,
    sameRealizedThinking: knownThinking
      ? arms.every((a) => a.realizedThinking === manifest.thinkingLevel)
      : null,
  };
  const result = {
    schemaVersion: 1,
    pair,
    manifest,
    evidence: { manifest: manifestInput.evidence },
    comparabilityUnknown:
      "null means required evidence is missing, unreadable, invalid, or lacks the compared field",
    comparability,
    arms: arms.map((arm) => ({
      arm: arm.arm,
      status: arm.status,
      durationMs: arm.durationMs,
      toolCalls: arm.toolCalls,
      toolTraceComplete: arm.toolTraceComplete,
      evidence: arm.evidence,
      toolCounts: arm.toolCounts,
      stats: arm.stats,
      failedToolCount: arm.failedTools.length,
      executionCount: arm.executions.length,
      patch: arm.patch,
      sourceSha256: arm.sourceSha256,
      unfinishedTools: arm.unfinishedTools,
      retries: arm.retries,
      previewFailure: arm.previewFailure,
      invocationFailure: arm.invocationFailure,
    })),
    identicalPatch: compare(
      arms[0].patch?.sha256,
      arms[1].patch?.sha256,
      sha256,
    ),
  };
  await save(join(output, "summary.json"), result);
  return result;
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (process.argv.length !== 4)
    throw new Error("Expected PAIR_DIRECTORY NEW_OUTPUT_DIRECTORY");
  const result = await summarizePair({
    pair: process.argv[2],
    output: process.argv[3],
  });
  console.log(JSON.stringify(result, null, 2));
}
