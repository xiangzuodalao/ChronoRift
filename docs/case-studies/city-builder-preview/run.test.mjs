import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { armOptions, auditResources, resolveOutputDirectory } from "./run.mjs";

test("control removes only the three game tools and their appendix", () => {
  const options = {
    tools: [
      "read",
      "bash",
      "edit",
      "write",
      "grep",
      "find",
      "ls",
      "game_launch",
      "game_query",
      "game_stop",
    ].map((name) => ({ name })),
    prompt: "unchanged goal",
    provider: "provider",
    model: "model",
    thinkingLevel: "max",
    timeoutMs: 600000,
    environmentProfile: "coding",
    additionalEnvironmentInstructions: "game instructions",
    newSessionId: "fresh session",
  };
  const control = armOptions(options, "coding-only");
  assert.deepEqual(
    control.tools.map((tool) => tool.name),
    ["read", "bash", "edit", "write", "grep", "find", "ls"],
  );
  assert.equal("additionalEnvironmentInstructions" in control, false);
  const { tools, additionalEnvironmentInstructions, ...remaining } = options;
  assert.ok(tools.length && additionalEnvironmentInstructions.length);
  const { tools: controlTools, ...controlRemaining } = control;
  assert.ok(controlTools.length);
  assert.deepEqual(controlRemaining, remaining);
  assert.equal(armOptions(options, "chronorift"), options);
  assert.equal(options.tools.length, 10);
  assert.throws(() => armOptions(options, "mistyped-arm"), /Unknown arm/);
});

test("output location rejects symlink parents that enter either checkout", async () => {
  const root = await mkdtemp(join(tmpdir(), "city-builder-output-test-"));
  try {
    const project = join(root, "project");
    const repo = join(root, "chronorift");
    await Promise.all([mkdir(project), mkdir(repo)]);
    await symlink(project, join(root, "project-link"));
    await symlink(repo, join(root, "repo-link"));
    for (const name of ["project-link", "repo-link"])
      await assert.rejects(
        resolveOutputDirectory(join(root, name, "run"), project, repo),
        /outside both/,
      );
    assert.equal(
      await resolveOutputDirectory(join(root, "run"), project, repo),
      join(root, "run"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resource audit records candidate context hashes and rejects inherited context", async () => {
  const root = await mkdtemp(join(tmpdir(), "city-builder-resources-test-"));
  try {
    const workspace = join(root, "workspace");
    const agentDir = join(root, "agent");
    const repo = join(root, "chronorift");
    await Promise.all([mkdir(workspace), mkdir(agentDir), mkdir(repo)]);
    await writeFile(
      join(workspace, "AGENTS.md"),
      "Project-owned instructions.",
    );
    const options = { resourceWorkspaceDirectory: workspace, agentDir };
    const resources = await auditResources(options, repo);
    assert.equal(resources.contexts.length, 1);
    assert.equal(resources.contexts[0].path, join(workspace, "AGENTS.md"));
    assert.match(resources.contexts[0].sha256, /^[0-9a-f]{64}$/);
    assert.equal("content" in resources.contexts[0], false);
    await writeFile(
      join(root, "AGENTS.md"),
      "Case-specific analysis must not enter the session.",
    );
    await assert.rejects(
      auditResources(options, repo),
      /Unexpected inherited Pi resource/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
