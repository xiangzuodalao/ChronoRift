import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it, vi } from "vitest";

import {
  AgentExecutionBudget,
  AgentExecutionScope,
} from "./agent-execution-scope.js";
import { SrtSandboxController } from "./srt-sandbox-controller.js";

it("isolates sibling agents outside default deny roots and reaps cancelled/background coding processes", async () => {
  // /run/lock is outside the default /home and /tmp read-deny policy. The task
  // namespace must be explicitly hidden even when an owner runs there.
  const root = await mkdtemp("/run/lock/chronorift-agent-sandbox-");
  const controller = new SrtSandboxController();
  const budget = new AgentExecutionBudget();
  const makeScope = async (name: string) => {
    const base = join(root, name);
    await mkdir(join(base, "workspace"), { recursive: true, mode: 0o700 });
    const scope = new AgentExecutionScope({
      controller,
      taskRootDirectory: root,
      workspaceDirectory: join(base, "workspace"),
      temporaryDirectory: join(base, "tmp"),
      artifactsDirectory: join(base, "artifacts"),
      recordsDirectory: join(base, "records"),
      validationDirectory: join(base, "validation"),
      nodePath: process.execPath,
      godotPath: "/unused",
      budget,
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
    await writeFile(join(root, "b/workspace/sibling"), "Sibling only");
    vi.stubEnv("CHRONORIFT_TEST_HOST_SECRET", "must-not-reach-tools");
    const escaped = root.replaceAll("'", "'\\''");
    const checked = await bash(
      a,
      `set -eu; test -z "\${CHRONORIFT_TEST_HOST_SECRET+x}"; if cat '${escaped}/host-secret' 2>/dev/null; then exit 41; fi; if cat '${escaped}/b/workspace/sibling' 2>/dev/null; then exit 42; fi; echo isolated`,
    );
    expect(checked.content).toContainEqual({
      type: "text",
      text: expect.stringContaining("isolated") as unknown,
    });

    const active = bash(
      a,
      "set -eu; while :; do echo x >> heartbeat; sleep 0.02; done",
    );
    await Promise.race([
      vi.waitFor(
        async () =>
          expect(
            (await readFile(join(root, "a/workspace/heartbeat"))).length,
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
    const stopped = await readFile(join(root, "a/workspace/heartbeat"), "utf8");
    await delay(150);
    expect(await readFile(join(root, "a/workspace/heartbeat"), "utf8")).toBe(
      stopped,
    );
    expect((await bash(b, "cat sibling")).content).toContainEqual({
      type: "text",
      text: expect.stringContaining("Sibling only") as unknown,
    });

    // A process that changes session and closes inherited stdio still belongs
    // to the sandbox PID namespace and must not outlive the coding operation.
    await bash(
      a,
      "setsid /bin/bash -c 'while :; do echo x >> background; sleep 0.02; done' </dev/null >/dev/null 2>&1 & sleep 0.1; exit 0",
    );
    const before = await readFile(join(root, "a/workspace/background"), "utf8");
    await delay(150);
    expect(await readFile(join(root, "a/workspace/background"), "utf8")).toBe(
      before,
    );
  } finally {
    vi.unstubAllEnvs();
    await Promise.allSettled([a.close(), b.close()]);
    await controller.close();
    await rm(root, { recursive: true, force: true });
  }
});
