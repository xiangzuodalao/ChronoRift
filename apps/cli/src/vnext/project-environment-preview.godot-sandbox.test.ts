import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { asAdapterId } from "@chronorift/domain";
import type {
  RunVNextPiSdkTurnOptions,
  VNextPiTurnResult,
} from "@chronorift/pi-harness";
import { afterEach, describe, expect, it } from "vitest";

import { createProjectAdapterReferenceTemplateFilesV1 } from "./project-adapter-reference-template.js";
import { ProjectEnvironmentHostConfigV1Schema } from "./project-environment-host-config.js";
import {
  runProjectEnvironmentPreviewV1,
  type ProjectEnvironmentPreviewDependenciesV1,
} from "./project-environment-preview.js";

const execFileAsync = promisify(execFile);
const temporaryRoots = new Set<string>();

afterEach(async () => {
  await Promise.all(
    [...temporaryRoots].map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
  temporaryRoots.clear();
});

const requiredEnvironment = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${name} is required for the PE-A Preview Host Gate`);
  }
  return value;
};

const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

const git = async (cwd: string, args: readonly string[]): Promise<void> => {
  await execFileAsync("/usr/bin/git", [...args], {
    cwd,
    env: {
      PATH: "/usr/bin:/bin",
      LANG: "C",
      LC_ALL: "C",
      HOME: cwd,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "ChronoRift PE-A Preview Host Gate",
      GIT_AUTHOR_EMAIL: "pe-a-preview-host-gate@chronorift.invalid",
      GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
      GIT_COMMITTER_NAME: "ChronoRift PE-A Preview Host Gate",
      GIT_COMMITTER_EMAIL: "pe-a-preview-host-gate@chronorift.invalid",
      GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
    },
    encoding: "utf8",
  });
};

const toolText = (value: unknown): string => {
  if (typeof value !== "object" || value === null || !("content" in value)) {
    throw new Error("fake Pi received a malformed tool result");
  }
  const content: unknown = value.content;
  if (!Array.isArray(content)) {
    throw new Error("fake Pi received a malformed tool result");
  }
  const first: unknown = content[0];
  if (
    typeof first !== "object" ||
    first === null ||
    !("type" in first) ||
    first.type !== "text" ||
    !("text" in first) ||
    typeof first.text !== "string"
  ) {
    throw new Error("fake Pi received a malformed tool result");
  }
  return first.text;
};

const gameOutput = (value: unknown): Record<string, unknown> => {
  const envelope = JSON.parse(toolText(value)) as unknown;
  if (
    typeof envelope !== "object" ||
    envelope === null ||
    !("outcome" in envelope) ||
    envelope.outcome !== "success" ||
    !("output" in envelope) ||
    typeof envelope.output !== "object" ||
    envelope.output === null
  ) {
    throw new Error(`fake Pi game tool failed: ${JSON.stringify(envelope)}`);
  }
  return envelope.output as Record<string, unknown>;
};

const exactPromptValue = (prompt: string, label: string): string => {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = new RegExp(`^${escaped}: (.+)$`, "mu").exec(prompt);
  if (match?.[1] === undefined) {
    throw new Error(`fake Pi prompt omitted ${label}`);
  }
  return match[1];
};

const authoredAdapterFiles = (prompt: string) => {
  const adapterId = asAdapterId(
    exactPromptValue(prompt, "The manifest adapterId must be exactly"),
  );
  const mainScene = exactPromptValue(prompt, "Realized default main scene");
  const reference = new Map(
    createProjectAdapterReferenceTemplateFilesV1({ adapterId, mainScene })
      .filter((file) => file.relativePath.startsWith("templates/minimal/"))
      .map((file) => [
        file.relativePath.slice("templates/minimal/".length),
        Buffer.from(file.bytes).toString("utf8"),
      ]),
  );
  const entityPath = "schemas/entity.scene-root.json";
  const statePath = "schemas/state.project.json";
  const entitySchema = JSON.parse(reference.get(entityPath)!) as Record<
    string,
    unknown
  >;
  entitySchema.schemaId = "entity.main-root";
  const stateSchema = JSON.parse(reference.get(statePath)!) as Record<
    string,
    unknown
  >;
  stateSchema.schemaId = "state.main";
  stateSchema.root = {
    type: "object",
    properties: { counter: { type: "integer", minimum: 0 } },
    required: ["counter"],
    additionalProperties: false,
  };
  const entityBytes = `${JSON.stringify(entitySchema, null, 2)}\n`;
  const stateBytes = `${JSON.stringify(stateSchema, null, 2)}\n`;
  const manifest = JSON.parse(reference.get("manifest.json")!) as {
    schemas: { schemaId: string; path: string; sha256: string }[];
    entityTypes: { entityTypeId: string; schemaId: string }[];
    stateDomains: { stateDomainId: string; schemaId: string }[];
    smoke: { requiredStateDomainIds: string[] };
  };
  for (const schema of manifest.schemas) {
    if (schema.path === entityPath) {
      schema.schemaId = "entity.main-root";
      schema.sha256 = sha256(Buffer.from(entityBytes));
    }
    if (schema.path === statePath) {
      schema.schemaId = "state.main";
      schema.sha256 = sha256(Buffer.from(stateBytes));
    }
  }
  manifest.entityTypes[0]!.entityTypeId = "main-root";
  manifest.entityTypes[0]!.schemaId = "entity.main-root";
  manifest.stateDomains[0]!.stateDomainId = "main-state";
  manifest.stateDomains[0]!.schemaId = "state.main";
  manifest.smoke.requiredStateDomainIds = ["main-state"];
  const entry = `extends ChronoRiftProjectAdapterV1

class EntityProjection extends ChronoRiftEntityProjectionV1:
\tfunc sample(current_scene: Node) -> Array:
\t\treturn [{
\t\t\t"entityId": "main",
\t\t\t"entityTypeId": "main-root",
\t\t\t"incarnation": 1,
\t\t\t"identityScope": "execution_local",
\t\t\t"projection": {"name": str(current_scene.name)},
\t\t}]

class StateProjection extends ChronoRiftStateProjectionV1:
\tfunc sample(current_scene: Node) -> Array:
\t\treturn [{
\t\t\t"stateDomainId": "main-state",
\t\t\t"value": {"counter": int(current_scene.counter)},
\t\t\t"semanticCoverage": "declared",
\t\t}]

class EventProjection extends ChronoRiftEventProjectionV1:
\tfunc drain(_current_scene: Node) -> Array:
\t\treturn []

func create_modules() -> Dictionary:
\treturn {
\t\t"entity_projection": EntityProjection.new(),
\t\t"state_projection": StateProjection.new(),
\t\t"event_projection": EventProjection.new(),
\t}
`;
  return new Map<string, string>([
    ["manifest.json", `${JSON.stringify(manifest, null, 2)}\n`],
    ["src/project_adapter.gd", entry],
    [entityPath, entityBytes],
    [statePath, stateBytes],
    [
      "schemas/launch.params.json",
      reference.get("schemas/launch.params.json")!,
    ],
  ]);
};

const createFakePiDependencies =
  (): ProjectEnvironmentPreviewDependenciesV1 => {
    const sessionIds = new Map<string, string>();
    let callSequence = 0;
    const runPiTurn = async (
      options: RunVNextPiSdkTurnOptions,
    ): Promise<VNextPiTurnResult> => {
      let toolCalls = 0;
      const invoke = async (name: string, input: unknown): Promise<unknown> => {
        const tool = options.tools.find((candidate) => candidate.name === name);
        if (tool === undefined) throw new Error(`fake Pi missing tool ${name}`);
        toolCalls += 1;
        callSequence += 1;
        return tool.execute(
          `fake-pi:${callSequence}`,
          input,
          undefined,
          undefined,
          {} as never,
        );
      };

      const initializing = options.prompt.startsWith(
        "Initialize this Godot project environment",
      );
      if (initializing) {
        for (const [path, content] of authoredAdapterFiles(options.prompt)) {
          await invoke("write", {
            path: `.chronorift/adapter-candidate/${path}`,
            content,
          });
        }
      } else {
        const binding = options.additionalEnvironmentInstructions ?? "";
        const taskId = exactPromptValue(binding, "- taskId");
        if (options.prompt.includes("EDIT_COUNTER_TO_TWO")) {
          await invoke("edit", {
            path: "main.gd",
            edits: [
              { oldText: "var counter := 1", newText: "var counter := 2" },
            ],
          });
        }
        const capabilities = gameOutput(
          await invoke("game_capabilities", { schemaVersion: 1, taskId }),
        );
        const buildId = capabilities.buildId;
        if (typeof buildId !== "string") {
          throw new Error("fake Pi capabilities omitted the compatible Build");
        }
        const launch = gameOutput(
          await invoke("game_launch", {
            schemaVersion: 1,
            taskId,
            buildId,
            launchTargetId: "main",
            parameters: {},
          }),
        );
        const runtimeId = launch.runtimeId;
        const executionId = launch.executionId;
        if (typeof runtimeId !== "string" || typeof executionId !== "string") {
          throw new Error("fake Pi launch omitted runtime identities");
        }
        await invoke("game_capture_configure", {
          schemaVersion: 1,
          taskId,
          runtimeId,
          profile: {
            channels: ["entity", "state", "event", "runtime_error"],
            retention: { clockDomain: "process_frame", before: 0, after: 0 },
            sampling: [],
            triggers: [],
          },
        });
        const entities = gameOutput(
          await invoke("game_query", {
            schemaVersion: 1,
            taskId,
            executionId,
            select: "entities",
            limit: 20,
          }),
        );
        const state = gameOutput(
          await invoke("game_query", {
            schemaVersion: 1,
            taskId,
            executionId,
            select: "state",
            limit: 20,
          }),
        );
        if (
          !Array.isArray(entities.rows) ||
          entities.rows.length === 0 ||
          !Array.isArray(state.rows) ||
          state.rows.length === 0
        ) {
          throw new Error("fake Pi did not observe entity and state rows");
        }
        await invoke("game_capture_pin", {
          schemaVersion: 1,
          taskId,
          runtimeId,
          anchor: { kind: "now" },
          before: 0,
          after: 0,
        });
        await invoke("game_stop", { schemaVersion: 1, taskId, runtimeId });
      }

      await mkdir(options.sessionDirectory, { recursive: true });
      const sessionId =
        options.newSessionId ??
        (options.resumeSessionFile === undefined
          ? undefined
          : sessionIds.get(options.resumeSessionFile));
      if (sessionId === undefined) {
        throw new Error("fake Pi could not resolve the durable Session ID");
      }
      const sessionFile =
        options.resumeSessionFile ??
        join(options.sessionDirectory, `${sessionId}.jsonl`);
      if (options.resumeSessionFile === undefined) {
        await writeFile(
          sessionFile,
          `${JSON.stringify({ type: "session", id: sessionId, cwd: "/workspace" })}\n`,
        );
        sessionIds.set(sessionFile, sessionId);
      }
      await appendFile(
        sessionFile,
        `${JSON.stringify({ type: "fake-pi-turn", prompt: options.prompt })}\n`,
      );
      return {
        schemaVersion: 1,
        status: "completed",
        sessionId,
        sessionFile,
        provider: options.provider,
        model: options.model,
        requestedThinkingLevel: options.thinkingLevel,
        realizedThinkingLevel: options.thinkingLevel,
        activeTools: options.tools.map((tool) => tool.name),
        assistantText:
          "deterministic fake Pi completed the requested Host Gate turn",
        errorMessage: null,
        eventsObserved: toolCalls,
        observedTurnCount: 1,
        stats: {
          sessionFile,
          sessionId,
          userMessages: 1,
          assistantMessages: 1,
          toolCalls,
          toolResults: toolCalls,
          totalMessages: 2 + toolCalls * 2,
          tokens: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            total: 2,
          },
          cost: 0,
        },
      };
    };
    return Object.freeze({ runPiTurn });
  };

describe("PE-A complete Preview Host integration", () => {
  it("initializes, publishes, runs one same-Session goal, and reuses in a new Session", async () => {
    const taskStorageRoot = requiredEnvironment(
      "CHRONORIFT_TEST_TASK_STORAGE_ROOT",
    );
    const godotPath = requiredEnvironment("CHRONORIFT_TEST_GODOT_BIN");
    const root = await mkdtemp(join(tmpdir(), "chronorift-pe-a-preview-host-"));
    const projectRoot = join(root, "project");
    const runtimeRoot = await mkdtemp(
      join(taskStorageRoot, "chronorift-pe-a-preview-runtime-"),
    );
    temporaryRoots.add(root);
    temporaryRoots.add(runtimeRoot);
    await mkdir(projectRoot);
    const fixtureRoot = join(
      process.cwd(),
      "fixtures/godot-project-environment-pe-a-live",
    );
    for (const path of [
      ".godot-version",
      "README.md",
      "main.gd",
      "main.gd.uid",
      "main.tscn",
      "project.godot",
    ]) {
      await writeFile(
        join(projectRoot, path),
        await readFile(join(fixtureRoot, path)),
      );
    }
    await git(projectRoot, ["init", "--quiet", "--initial-branch=main"]);
    await git(projectRoot, ["add", "--all"]);
    await git(projectRoot, ["commit", "--quiet", "-m", "frozen fixture"]);

    const hostConfig = ProjectEnvironmentHostConfigV1Schema.parse({
      schemaVersion: 1,
      configKind: "chronorift-project-environment-host",
      taskStorageRoot,
      runtimeRoot,
      delegatedCgroupRoot: requiredEnvironment("CHRONORIFT_TEST_CGROUP_ROOT"),
      bwrapPath: requiredEnvironment("CHRONORIFT_TEST_BWRAP_BIN"),
      prlimitPath: requiredEnvironment("CHRONORIFT_TEST_PRLIMIT_BIN"),
      busyboxPath: requiredEnvironment("CHRONORIFT_TEST_BUSYBOX_BIN"),
      fontconfigProbePath: requiredEnvironment(
        "CHRONORIFT_TEST_FONTCONFIG_PROBE_BIN",
      ),
      xdgUserDirPath: requiredEnvironment("CHRONORIFT_TEST_XDG_USER_DIR_BIN"),
      nodePath: requiredEnvironment("CHRONORIFT_TEST_NODE_BIN"),
      bashPath: requiredEnvironment("CHRONORIFT_TEST_BASH_BIN"),
      rgPath: requiredEnvironment("CHRONORIFT_TEST_RG_BIN"),
      findPath: requiredEnvironment("CHRONORIFT_TEST_FIND_BIN"),
      lsPath: requiredEnvironment("CHRONORIFT_TEST_LS_BIN"),
      lddPath: requiredEnvironment("CHRONORIFT_TEST_LDD_BIN"),
      godotToolchains: [
        {
          schemaVersion: 1,
          key: "godot-4.7.1-linux-x86_64-official",
          version: "4.7.1",
          platform: "linux-x86_64",
          channel: "stable-official",
          executablePath: godotPath,
          executableSha256: sha256(await readFile(godotPath)),
          buildFeatures: ["gdscript", "headless"],
          renderer: "gl_compatibility",
        },
      ],
    });
    const hostConfigPath = join(root, "host-config.json");
    await writeFile(hostConfigPath, `${JSON.stringify(hostConfig)}\n`);
    const dependencies = createFakePiDependencies();

    const first = await runProjectEnvironmentPreviewV1(
      {
        projectPath: projectRoot,
        provider: "fake-provider",
        model: "fake-model",
        thinkingLevel: "off",
        goal: "EDIT_COUNTER_TO_TWO",
        hostConfigPath,
      },
      dependencies,
    );
    if (first.status !== "ready") {
      throw new Error(`first Preview failed: ${JSON.stringify(first)}`);
    }
    expect(first).toMatchObject({
      status: "ready",
      reused: false,
      goalDelivered: true,
      candidateSourceChanged: true,
    });
    expect(first.environmentRevisionId).not.toBeNull();
    expect(first.adapterRevisionId).not.toBeNull();
    expect(first.buildId).not.toBeNull();
    expect(first.runtimeObservationReceiptId).not.toBeNull();

    const second = await runProjectEnvironmentPreviewV1(
      {
        projectPath: projectRoot,
        provider: "fake-provider",
        model: "fake-model",
        thinkingLevel: "off",
        goal: "OBSERVE_REUSED_ENVIRONMENT",
        hostConfigPath,
      },
      dependencies,
    );
    expect(second).toMatchObject({
      status: "ready",
      reused: true,
      goalDelivered: true,
      candidateSourceChanged: false,
      environmentId: first.environmentId,
      environmentRevisionId: first.environmentRevisionId,
      adapterRevisionId: first.adapterRevisionId,
    });
    expect(second.taskId).not.toBe(first.taskId);
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(second.buildId).not.toBeNull();
    expect(second.runtimeObservationReceiptId).not.toBeNull();
  });
});
