import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { failedTool, summarizePair } from "./summarize.mjs";

test("counts reported command and game failures even when event.isError is false", () => {
  const result = (text) => ({
    isError: false,
    result: { content: [{ type: "text", text }] },
  });
  assert.equal(
    failedTool(
      result("fatal: external diff died\n\n[Command failed; exitCode=128]"),
    ),
    true,
  );
  assert.equal(
    failedTool(
      result(
        JSON.stringify({
          outcome: "error",
          error: { code: "budget_exhausted" },
        }),
      ),
    ),
    true,
  );
  assert.equal(failedTool({ isError: true }), true);
  assert.equal(failedTool(result("success")), false);
  // A missing-binary probe masked with ||true is diagnostic output, not a
  // nonzero tool result; its exact output is still retained in the full trace.
  assert.equal(failedTool(result("godot: command not found")), false);
});

// Synthetic local files exercise reduction, never provider or runtime behavior.
async function withPair(run) {
  const root = await mkdtemp(join(tmpdir(), "watch-summary-test-"));
  const pair = join(root, "pair"),
    output = join(root, "summary");
  const save = (path, value) => writeFile(path, JSON.stringify(value));
  try {
    await mkdir(pair);
    await save(join(pair, "manifest.json"), {
      provider: "test-provider",
      model: "test-model",
      thinkingLevel: "max",
    });
    for (const [index, arm] of ["A", "B"].entries()) {
      const directory = join(pair, arm);
      await mkdir(directory);
      const patch = `synthetic patch ${arm}\n`;
      const patchPath = join(directory, "candidate.patch");
      await writeFile(patchPath, patch);
      await save(join(directory, "completion.json"), {
        status: "completed",
        durationMs: 100 - index * 20,
        invocationFailure: null,
        sourceCheckoutUnchanged: true,
      });
      await save(join(directory, "preview-result.json"), {
        sourceSha256: "a".repeat(64),
        executions: [],
        candidatePatch: {
          path: patchPath,
          sha256: createHash("sha256").update(patch).digest("hex"),
          byteLength: Buffer.byteLength(patch),
          roundTripVerified: true,
        },
      });
      await save(join(directory, "pi-result.json"), {
        provider: "test-provider",
        model: "test-model",
        requestedThinkingLevel: "max",
        realizedThinkingLevel: "max",
        stats: { toolCalls: 1, tokens: { total: 1000 } },
      });
      await save(join(directory, "session-configuration.json"), {
        candidateInitialSourceSha256: "a".repeat(64),
        toolDefinitions: [
          { name: "bash" },
          ...(arm === "B" ? [{ name: "game_watch" }] : []),
        ],
        resources: {
          contexts: [],
          skills: [],
          prompts: [],
          systemPrompt: null,
        },
        codingAppendix: "shared coding prose",
        additionalEnvironmentInstructions: "shared game prose",
      });
      const event = { toolCallId: "call.1", toolName: "bash" };
      await writeFile(
        join(directory, "events.jsonl"),
        [
          {
            receivedAt: "2026-01-01T00:00:00.000Z",
            elapsedMs: 10,
            event: {
              ...event,
              type: "tool_execution_start",
              args: { command: "false" },
            },
          },
          {
            receivedAt: "2026-01-01T00:00:00.005Z",
            elapsedMs: 15,
            event: {
              ...event,
              type: "tool_execution_end",
              isError: false,
              result: {
                content: [
                  { type: "text", text: "[Command failed; exitCode=1]" },
                ],
              },
            },
          },
        ]
          .map((value) => JSON.stringify(value))
          .join("\n") + "\n",
      );
    }
    await run({ pair, output, save });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("complete pairs preserve metrics, verified patches, and actual comparability", async () => {
  await withPair(async ({ pair, output }) => {
    const result = await summarizePair({ pair, output });
    assert.ok(
      Object.values(result.comparability).every((value) => value === true),
    );
    assert.equal(result.identicalPatch, false);
    for (const [index, arm] of result.arms.entries()) {
      assert.equal(arm.durationMs, 100 - index * 20);
      assert.equal(arm.toolCalls, 1);
      assert.equal(arm.failedToolCount, 1);
      assert.equal(arm.toolTraceComplete, true);
      assert.equal(arm.patch.roundTripVerified, true);
      assert.equal(arm.evidence.patch.status, "available");
      assert.deepEqual(arm.stats, { toolCalls: 1, tokens: { total: 1000 } });
    }
  });
});

test("missing both sides never establishes matching source, patch, model, or resources", async () => {
  await withPair(async ({ pair, output }) => {
    for (const arm of ["A", "B"])
      for (const file of [
        "preview-result.json",
        "pi-result.json",
        "session-configuration.json",
      ])
        await rm(join(pair, arm, file));
    const result = await summarizePair({ pair, output });
    assert.equal(result.identicalPatch, null);
    assert.ok(
      Object.values(result.comparability).every((value) => value === null),
    );
    for (const arm of result.arms) {
      assert.equal(arm.evidence.preview.status, "missing");
      assert.equal(arm.evidence.pi.status, "missing");
      assert.equal(arm.evidence.configuration.status, "missing");
      assert.equal(arm.evidence.patch.status, "not_recorded");
      assert.equal(arm.toolCalls, 1);
    }
  });
});

test("damaged JSON, invalid shapes, unreadable files, and missing files remain distinct", async () => {
  await withPair(async ({ pair, output }) => {
    const damaged = '{"status":';
    await writeFile(join(pair, "A", "preview-result.json"), damaged);
    await rm(join(pair, "B", "preview-result.json"));
    await writeFile(join(pair, "A", "pi-result.json"), "null");
    const unreadable = join(pair, "B", "pi-result.json");
    await rm(unreadable);
    await mkdir(unreadable);
    const result = await summarizePair({ pair, output });
    assert.equal(result.arms[0].evidence.preview.status, "invalid_json");
    assert.equal(result.arms[1].evidence.preview.status, "missing");
    assert.equal(result.arms[0].evidence.pi.status, "invalid_shape");
    assert.equal(result.arms[1].evidence.pi.status, "unreadable");
    assert.equal(result.comparability.sameSelectedSource, null);
    assert.equal(result.identicalPatch, null);
    assert.equal(
      await readFile(join(pair, "A", "preview-result.json"), "utf8"),
      damaged,
    );
  });
});

test("partial and missing traces retain actual calls and mark counts incomplete", async () => {
  await withPair(async ({ pair, output }) => {
    const path = join(pair, "A", "events.jsonl");
    const first = (await readFile(path, "utf8")).split("\n")[0];
    await writeFile(path, first + '\n{"event":\n');
    await rm(join(pair, "B", "events.jsonl"));
    await rm(join(pair, "A", "completion.json"));
    await writeFile(join(pair, "manifest.json"), "[]");
    const result = await summarizePair({ pair, output });
    assert.equal(result.evidence.manifest.status, "invalid_shape");
    assert.equal(result.comparability.sameRequestedModel, null);
    assert.equal(result.arms[0].status, "unknown");
    assert.equal(result.arms[0].durationMs, null);
    assert.equal(result.arms[0].toolCalls, 1);
    assert.equal(result.arms[0].unfinishedTools.length, 1);
    assert.equal(result.arms[0].evidence.events.status, "invalid_json");
    assert.equal(result.arms[0].evidence.events.line, 2);
    assert.equal(result.arms[1].evidence.events.status, "missing");
    assert.ok(result.arms.every((arm) => arm.toolTraceComplete === false));
  });
});

test("missing or changed saved patches never inherit a successful round-trip assertion", async () => {
  await withPair(async ({ pair, output }) => {
    await writeFile(join(pair, "A", "candidate.patch"), "changed patch\n");
    await rm(join(pair, "B", "candidate.patch"));
    const result = await summarizePair({ pair, output });
    assert.equal(result.arms[0].evidence.patch.status, "metadata_mismatch");
    assert.equal(result.arms[0].patch.roundTripVerified, false);
    assert.equal(result.arms[1].evidence.patch.status, "missing");
    assert.equal(result.arms[1].patch, null);
    assert.equal(result.identicalPatch, null);
    assert.equal(
      await readFile(join(output, "A.patch"), "utf8"),
      "changed patch\n",
    );
  });
});
