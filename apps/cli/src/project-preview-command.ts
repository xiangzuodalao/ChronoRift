import { resolve } from "node:path";
import { DEFAULT_PI_THINKING_LEVEL } from "./pi-defaults.js";
import {
  assertOnlyFlags,
  flag,
  hasFlag,
  positiveIntegerFlag,
  printJson,
  repeatableFlag,
  requiredFlag,
  thinkingLevelFlag,
  type Arguments,
} from "./cli-arguments.js";
import {
  ProjectEnvironmentPreviewStartupFailureV2Schema,
  runProjectEnvironmentPreviewV2,
} from "./vnext/project-environment-preview.js";

export function validateProjectPreviewArguments(args: Arguments): {
  multiAgent: boolean;
  maxAgents: number;
} {
  assertOnlyFlags(args, [
    "provider",
    "model",
    "thinking",
    "state-root",
    "godot-bin",
    "timeout-ms",
    "agent-dir",
    "project-root",
    "include-untracked",
    "json",
    "multi-agent",
    "max-agents",
    "worker-provider",
    "worker-model",
    "worker-thinking",
  ]);
  const multiAgent = hasFlag(args, "multi-agent");
  const workerFlags = [
    "max-agents",
    "worker-provider",
    "worker-model",
    "worker-thinking",
  ];
  if (!multiAgent && workerFlags.some((name) => args.flags.has(name))) {
    throw new Error("Worker configuration requires --multi-agent");
  }
  const maxAgents = positiveIntegerFlag(args, "max-agents", 3);
  if (maxAgents > 4) throw new Error("--max-agents must be between 1 and 4");
  if (args.flags.has("worker-provider") && !args.flags.has("worker-model")) {
    throw new Error("--worker-provider requires --worker-model");
  }
  thinkingLevelFlag(args, DEFAULT_PI_THINKING_LEVEL);
  thinkingLevelFlag(args, DEFAULT_PI_THINKING_LEVEL, "worker-thinking");
  if (args.flags.has("timeout-ms"))
    positiveIntegerFlag(args, "timeout-ms", 1_800_000);
  return { multiAgent, maxAgents };
}

export async function projectPreviewCommand(
  args: Arguments,
  cwd: string,
): Promise<void> {
  const { multiAgent, maxAgents } = validateProjectPreviewArguments(args);
  let result: Awaited<ReturnType<typeof runProjectEnvironmentPreviewV2>>;
  try {
    result = await runProjectEnvironmentPreviewV2({
      projectPath: cwd,
      provider: requiredFlag(args, "provider", "CHRONORIFT_PI_PROVIDER"),
      model: requiredFlag(args, "model", "CHRONORIFT_PI_MODEL"),
      thinkingLevel: thinkingLevelFlag(args, DEFAULT_PI_THINKING_LEVEL),
      goal: args.positionals[0] ?? null,
      ...(multiAgent
        ? {
            multiAgent: {
              maxAgents,
              ...(flag(args, "worker-provider") === undefined
                ? {}
                : { workerProvider: flag(args, "worker-provider")! }),
              ...(flag(args, "worker-model") === undefined
                ? {}
                : { workerModel: flag(args, "worker-model")! }),
              ...(flag(args, "worker-thinking") === undefined
                ? {}
                : {
                    workerThinking: thinkingLevelFlag(
                      args,
                      DEFAULT_PI_THINKING_LEVEL,
                      "worker-thinking",
                    ),
                  }),
            },
          }
        : {}),
      ...(flag(args, "project-root") === undefined
        ? {}
        : { projectRoot: flag(args, "project-root")! }),
      includeUntrackedPaths: repeatableFlag(args, "include-untracked"),
      interactive:
        !hasFlag(args, "json") &&
        process.stdin.isTTY === true &&
        process.stdout.isTTY === true,
      ...(flag(args, "state-root") === undefined
        ? {}
        : { stateRoot: resolve(flag(args, "state-root")!) }),
      ...(flag(args, "godot-bin", "GODOT_BIN") === undefined
        ? {}
        : { godotBin: resolve(flag(args, "godot-bin", "GODOT_BIN")!) }),
      ...(flag(args, "agent-dir") === undefined
        ? {}
        : { agentDir: resolve(flag(args, "agent-dir")!) }),
      ...(flag(args, "timeout-ms") === undefined
        ? {}
        : { timeoutMs: positiveIntegerFlag(args, "timeout-ms", 1_800_000) }),
    });
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : String(error);
    const rawCode =
      error !== null && typeof error === "object" && "code" in error
        ? (error as { readonly code?: unknown }).code
        : null;
    const failureCode =
      typeof rawCode === "string" && /^[a-z][a-z0-9_]{0,63}$/u.test(rawCode)
        ? rawCode
        : "project_preview_failed";
    const failureMessage =
      rawMessage
        .replace(/[\r\n\0]/gu, " ")
        .trim()
        .slice(0, 4_096) || "Project Environment Preview failed";
    const failure = ProjectEnvironmentPreviewStartupFailureV2Schema.parse({
      schemaVersion: 2 as const,
      status: "failed" as const,
      goalDelivered: false as const,
      failureCode,
      failureMessage,
    });
    if (hasFlag(args, "json")) {
      printJson(multiAgent ? { ...failure, schemaVersion: 6 } : failure);
    } else {
      process.stderr.write(
        `ChronoRift Project Environment Preview — failed\nfailure: ${failure.failureCode}: ${failure.failureMessage}\n`,
      );
    }
    process.exitCode = 1;
    return;
  }
  const unsuccessful =
    result.status !== "completed" ||
    !result.goalDelivered ||
    result.failureCode !== null;
  if (hasFlag(args, "json")) {
    printJson(result);
    if (unsuccessful) process.exitCode = 1;
    return;
  }
  process.stdout.write(
    [
      `ChronoRift Project Environment Preview — ${result.status}`,
      `task: ${result.taskId}`,
      `source: ${result.sourceSha256}`,
      `selected project root: ${result.projectRoot.length === 0 ? "." : result.projectRoot}`,
      `candidate source: ${result.candidateSourceChanged === null ? "unknown (candidate not frozen)" : result.candidateSourceChanged ? "changed" : "unchanged"}`,
      `candidate patch: ${result.candidatePatch?.path ?? "unavailable"}`,
      `runtime executions: ${result.executions.length}`,
      ...(result.schemaVersion === 6
        ? [`agent records: ${result.agents?.recordPath ?? "unavailable"}`]
        : []),
      `Pi: ${result.provider}/${result.model} (${result.thinkingLevel})`,
      `session: ${result.sessionFile ?? "not persisted"}`,
      `queued goal: ${result.goalDelivered ? "delivered" : "not delivered"}`,
      ...(result.failureMessage === null
        ? []
        : [`failure: ${result.failureCode}: ${result.failureMessage}`]),
      `task records: ${result.taskDirectory}`,
      ...result.limitations.map((limitation) => `limitation: ${limitation}`),
    ].join("\n") + "\n",
  );
  if (unsuccessful) process.exitCode = 1;
}
