import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it, vi } from "vitest";

import {
  AgentExecutionBudget,
  AgentExecutionScope,
  AgentWorkspaceGate,
} from "./agent-execution-scope.js";
import { SrtSandboxController } from "./srt-sandbox-controller.js";

it("shares candidate source while hiding sibling resources and reaping only owned coding processes", async () => {
  // /run/lock is outside the default /home and /tmp read-deny policy. The task
  // namespace must be explicitly hidden even when an owner runs there.
  const root = await mkdtemp("/run/lock/chronorift-agent-sandbox-");
  const controller = new SrtSandboxController();
  const budget = new AgentExecutionBudget();
  const candidateGate = new AgentWorkspaceGate();
  const workspace = join(root, "candidate");
  await mkdir(workspace, { mode: 0o700 });
  const makeScope = async (name: string) => {
    const base = join(root, name);
    const scope = new AgentExecutionScope({
      controller,
      taskRootDirectory: root,
      workspaceDirectory: workspace,
      temporaryDirectory: join(base, "tmp"),
      artifactsDirectory: join(base, "artifacts"),
      recordsDirectory: join(base, "records"),
      validationDirectory: join(base, "validation"),
      nodePath: process.execPath,
      godotPath: "/unused",
      budget,
      candidateGate,
    });
    await scope.initialize();
    return scope;
  };
  const a = await makeScope("a");
  const b = await makeScope("b");
  const bash = (scope: AgentExecutionScope, command: string) =>
    scope
      .tools()
      .find((tool) => tool.name === "bash")!
      .execute(
        "sandbox-test",
        { command, timeout: 20 },
        undefined,
        undefined,
        {} as never,
      );
  try {
    await writeFile(join(root, "host-secret"), "Host only");
    await writeFile(join(root, "b/tmp/sibling"), "Sibling only");
    await writeFile(join(workspace, "shared"), "Shared candidate");
    vi.stubEnv("CHRONORIFT_TEST_HOST_SECRET", "must-not-reach-tools");
    const escaped = root.replaceAll("'", "'\\''");
    const checked = await bash(
      a,
      `set -eu; test -z "\${CHRONORIFT_TEST_HOST_SECRET+x}"; if cat '${escaped}/host-secret' 2>/dev/null; then exit 41; fi; if cat '${escaped}/b/tmp/sibling' 2>/dev/null; then exit 42; fi; echo isolated`,
    );
    expect(checked.content).toContainEqual({
      type: "text",
      text: expect.stringContaining("isolated") as unknown,
    });

    await writeFile(join(workspace, "contended.gd"), "var value = 0\n");
    const edit = (scope: AgentExecutionScope, value: number) =>
      scope
        .tools()
        .find((tool) => tool.name === "edit")!
        .execute(
          `edit-${value}`,
          {
            path: "contended.gd",
            edits: [{ oldText: "value = 0", newText: `value = ${value}` }],
          },
          undefined,
          undefined,
          {} as never,
        );
    const edits = await Promise.allSettled([edit(a, 1), edit(b, 2)]);
    expect(edits.filter((entry) => entry.status === "fulfilled")).toHaveLength(
      1,
    );
    const rejected = edits.find((entry) => entry.status === "rejected");
    expect(
      rejected?.status === "rejected" ? String(rejected.reason) : "",
    ).toContain("oldText was not found");
    expect(await readFile(join(workspace, "contended.gd"), "utf8")).toMatch(
      /^var value = [12]\n$/u,
    );

    const active = bash(
      a,
      "set -eu; while :; do echo x >> heartbeat; sleep 0.02; done",
    );
    await Promise.race([
      vi.waitFor(
        async () =>
          expect(
            (await readFile(join(workspace, "heartbeat"))).length,
          ).toBeGreaterThan(0),
        { timeout: 10_000 },
      ),
      active.then((result) => {
        throw new Error(
          `Coding heartbeat exited early: ${JSON.stringify(result)}`,
        );
      }),
    ]);
    await a.cancel();
    await active;
    const stopped = await readFile(join(workspace, "heartbeat"), "utf8");
    await delay(150);
    expect(await readFile(join(workspace, "heartbeat"), "utf8")).toBe(stopped);
    expect((await bash(b, "cat shared")).content).toContainEqual({
      type: "text",
      text: expect.stringContaining("Shared candidate") as unknown,
    });

    // A process that changes session and closes inherited stdio still belongs
    // to the sandbox PID namespace and must not outlive the coding operation.
    await bash(
      a,
      "setsid /bin/bash -c 'while :; do echo x >> background; sleep 0.02; done' </dev/null >/dev/null 2>&1 & sleep 0.1; exit 0",
    );
    const before = await readFile(join(workspace, "background"), "utf8");
    await delay(150);
    expect(await readFile(join(workspace, "background"), "utf8")).toBe(before);
  } finally {
    vi.unstubAllEnvs();
    await Promise.allSettled([a.close(), b.close()]);
    await controller.close();
    await rm(root, { recursive: true, force: true });
  }
});
