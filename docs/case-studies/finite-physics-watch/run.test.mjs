import assert from "node:assert/strict";
import test from "node:test";
import { armOptions, CONFIG, GOAL, parseArguments } from "./run.mjs";

test("A removes only watch; both arms preserve every coding/runtime tool object and identical prompt/settings", () => {
  const tools = [
    "read",
    "bash",
    "edit",
    "write",
    "grep",
    "find",
    "ls",
    "game_launch",
    "game_query",
    "game_watch",
    "game_stop",
  ].map((name) => ({ name, execute: () => name }));
  const original = {
    tools,
    prompt: GOAL,
    provider: CONFIG.provider,
    model: CONFIG.model,
    thinkingLevel: CONFIG.thinkingLevel,
    timeoutMs: CONFIG.timeoutMs,
    additionalEnvironmentInstructions:
      "Godot inspection:\n- game_query reads objects.\n- game_watch samples them.\n- Getters may have side effects.",
  };
  const a = armOptions(original, "A"),
    b = armOptions(original, "B");
  assert.deepEqual(
    a.tools.map((t) => t.name),
    tools.filter((t) => t.name !== "game_watch").map((t) => t.name),
  );
  assert.equal(b.tools, tools);
  for (const tool of a.tools)
    assert.equal(
      tool,
      tools.find((t) => t.name === tool.name),
    );
  for (const key of [
    "prompt",
    "provider",
    "model",
    "thinkingLevel",
    "timeoutMs",
    "additionalEnvironmentInstructions",
  ])
    assert.equal(a[key], b[key]);
  assert.match(a.additionalEnvironmentInstructions, /game_query/);
  assert.doesNotMatch(a.additionalEnvironmentInstructions, /game_watch/);
  assert.match(original.additionalEnvironmentInstructions, /game_watch/);
  assert.throws(() => armOptions(original, "coding-only"), /Unknown arm/);
});

test("case invocation requires explicit source, engine and fresh output arguments", () => {
  assert.deepEqual(
    parseArguments([
      "--project",
      "/source",
      "--godot-bin",
      "/godot",
      "--output",
      "/out",
    ]),
    { project: "/source", godotBin: "/godot", output: "/out" },
  );
  for (const args of [
    [],
    ["--project", "/source"],
    ["--project", "/a", "--project", "/b"],
    ["--unknown", "/a"],
    ["--output", "x\0y"],
  ])
    assert.throws(() => parseArguments(args));
});
