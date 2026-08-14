import { createHash } from "node:crypto";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import {
  ProjectAdapterLaunchTargetValidationV1Schema,
  asAdapterId,
  asProjectEnvironmentId,
  asProjectEnvironmentRuntimeObservationReceiptId,
  asProjectEnvironmentTaskId,
  type JsonValue,
} from "@chronorift/domain";
import { loadProjectAdapterPackageFilesV2 } from "@chronorift/godot-adapter";
import {
  ProjectEnvironmentStoreV1,
  ProjectEnvironmentTaskStoreV1,
  canonicalJson,
} from "@chronorift/json-artifacts";
import type {
  RunVNextPiSdkTurnOptions,
  VNextPiTurnResult,
} from "@chronorift/pi-harness";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { ProjectEnvironmentHostConfigV1Schema } from "./project-environment-host-config.js";
import {
  runProjectEnvironmentPreviewV1,
  type ProjectEnvironmentPreviewDependenciesV1,
  type ProjectEnvironmentPreviewResultV1,
} from "./project-environment-preview.js";
import { inspectReusableProjectEnvironmentRevisionV2 } from "./project-environment-reuse-v2.js";
import {
  ProjectSourceClosureV1Schema,
  preflightCleanProjectEnvironmentV1,
} from "./source-preflight.js";
import { ProjectEnvironmentWorkspaceMaterializationReceiptV2Schema } from "./workspace-materializer.js";

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
    throw new Error(`${name} is required for the PE-C Preview Host Gate`);
  }
  return value;
};

const assertDisposableProjectRoot = async (
  projectRoot: string,
): Promise<void> => {
  const runnerTemp = await realpath(requiredEnvironment("RUNNER_TEMP"));
  const disposableRoot = requiredEnvironment(
    "CHRONORIFT_TEST_PE_C_DISPOSABLE_PROJECT_ROOT",
  );
  const canonicalProjectRoot = await realpath(projectRoot);
  if (
    canonicalProjectRoot !== projectRoot ||
    disposableRoot !== projectRoot ||
    !/^chronorift-pe-c-source-[A-Za-z0-9]{6}$/u.test(
      relative(runnerTemp, projectRoot),
    )
  ) {
    throw new Error(
      "PE-C Host Gate may mutate only its wrapper-owned disposable RUNNER_TEMP clone",
    );
  }
  const marker = await readFile(
    join(projectRoot, ".git", "chronorift-pe-c-disposable.v1"),
    "utf8",
  );
  if (marker !== "chronorift-project-environment-pe-c-disposable-v1\n") {
    throw new Error("PE-C Host Gate disposable clone marker is invalid");
  }
};

const sha256 = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");

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

const PeCHostContractSchema = z
  .object({
    schemaVersion: z.literal(1),
    contractKind: z.literal(
      "chronorift-project-environment-pe-c-host-contract",
    ),
    source: z
      .object({
        declaredSourceUrl: z.literal(
          "https://github.com/endlessm/moddable-platformer",
        ),
        commit: z.literal("3e793f53598a131c53fb82555191cc14b8db07ff"),
        tree: z.literal("a013bd677c712dbf354e8e2f6e8ff7c53d5684c6"),
      })
      .strict(),
    fixtureOverlay: z
      .object({
        selectedProjectRoot: z.string(),
        discoveredProjectRoots: z.array(z.string()).min(2),
        trackedDirtyPaths: z.array(z.string()).min(1),
        explicitUntrackedPaths: z.array(z.string()).min(1),
      })
      .strict(),
    launchTargets: z
      .object({
        defaultTargetId: z.string(),
        defaultScene: z.string(),
        selectedTargetId: z.string(),
        selectedScene: z.string(),
        expectedValidatedTargetIds: z.array(z.string()).min(1),
      })
      .strict(),
    requiredChecks: z.tuple([
      z.literal("initialization-publishes-selected-source-closure"),
      z.literal("materialization-postflight-reverifies-source"),
      z.literal("project-local-addon-imports"),
      z.literal("default-and-selected-targets-run"),
      z.literal("runtime-run-and-observation-are-recorded"),
      z.literal("unchanged-source-reuses-environment"),
      z.literal("source-change-review-precedes-game-execution"),
    ]),
  })
  .strict();

type PeCHostContract = z.infer<typeof PeCHostContractSchema>;

const readContract = async (): Promise<PeCHostContract> => {
  const value = JSON.parse(
    await readFile(
      requiredEnvironment("CHRONORIFT_TEST_PE_C_CONTRACT"),
      "utf8",
    ),
  ) as unknown;
  return PeCHostContractSchema.parse(value);
};

const schemaDocument = (
  schemaId: string,
  minimum: number,
  maximum: number,
): string =>
  `${JSON.stringify(
    {
      schemaVersion: 2,
      dialect: "chronorift://schemas/project-adapter-payload/v2",
      schemaId,
      root: {
        type: "object",
        properties: {
          phase: { type: "integer", minimum, maximum },
        },
        required: ["phase"],
        additionalProperties: false,
      },
    },
    null,
    2,
  )}\n`;

const launchParametersSchema = `${JSON.stringify(
  {
    schemaVersion: 2,
    dialect: "chronorift://schemas/project-adapter-payload/v2",
    schemaId: "launch.params",
    root: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  null,
  2,
)}\n`;

const adapterScript = `extends ChronoRiftProjectAdapterV2

var _context: ChronoRiftObservationContextV2

func start(context: ChronoRiftObservationContextV2, current_scene: Node) -> Error:
\t_context = context
\tcurrent_scene.get_tree().node_added.connect(_node_added)
\t_walk(current_scene.get_tree().root)
\treturn OK

func stop() -> void:
\tpass

func _walk(node: Node) -> void:
\t_consider(node)
\tfor child in node.get_children():
\t\t_walk(child)

func _node_added(node: Node) -> void:
\tcall_deferred("_consider", node)

func _consider(node: Node) -> void:
\tif not is_instance_valid(node):
\t\treturn
\tif not node.has_method("chronorift_fixture_stable_id") or not node.has_method("chronorift_fixture_state"):
\t\treturn
\tif not node.has_signal("chronorift_fixture_phase_changed"):
\t\treturn
\tvar entity_id := str(node.call("chronorift_fixture_stable_id"))
\tvar state: Variant = node.call("chronorift_fixture_state")
\tif entity_id.is_empty() or not state is Dictionary:
\t\treturn
\tvar phase: Variant = state.get("phase")
\tif typeof(phase) != TYPE_INT or int(phase) % 2 != 0:
\t\treturn
\tvar reference := _context.register_entity(entity_id, "scene_runtime", "spawn_lineage", node, state)
\tif reference.is_empty():
\t\treturn
\t_context.emit_state("scene_runtime_state", reference, state)
\tnode.connect("chronorift_fixture_phase_changed", _phase_changed.bind(node, reference))

func _phase_changed(phase: int, node: Node, reference: Dictionary) -> void:
\tif not is_instance_valid(node):
\t\treturn
\tvar state: Variant = node.call("chronorift_fixture_state")
\tif not state is Dictionary:
\t\treturn
\t_context.emit_event("scene_phase_changed", reference, {"phase": phase})
\t_context.emit_state("scene_runtime_state", reference, state)
`;

const authoredAdapterFiles = async (
  prompt: string,
  contract: PeCHostContract,
): Promise<ReadonlyMap<string, string>> => {
  const adapterId = exactPromptValue(
    prompt,
    "The manifest adapterId must be exactly",
  );
  const mainScene = exactPromptValue(prompt, "Realized default main scene");
  if (mainScene !== contract.launchTargets.defaultScene) {
    throw new Error("PE-C fixture default main scene drifted");
  }
  if (
    !prompt.includes(
      `The operator selected launch targetId exactly: ${contract.launchTargets.selectedTargetId}.`,
    )
  ) {
    throw new Error("PE-C initialization prompt omitted the selected target");
  }

  const files = new Map<string, string>([
    ["schemas/launch.params.json", launchParametersSchema],
    [
      "schemas/entity.scene_runtime.json",
      schemaDocument("entity.scene_runtime", 0, 3),
    ],
    [
      "schemas/state.scene_runtime.json",
      schemaDocument("state.scene_runtime", 0, 3),
    ],
    [
      "schemas/event.scene_phase_changed.json",
      schemaDocument("event.scene_phase_changed", 1, 3),
    ],
    ["src/project_adapter.gd", adapterScript],
  ]);
  const reference = JSON.parse(
    await readFile(
      join(
        process.cwd(),
        "testdata/vnext/project-environment/pe-b-dynamic-adapter/manifest.json",
      ),
      "utf8",
    ),
  ) as Record<string, unknown>;
  reference.adapterId = adapterId;
  reference.schemas = [
    ["launch.params", "schemas/launch.params.json"],
    ["entity.scene_runtime", "schemas/entity.scene_runtime.json"],
    ["state.scene_runtime", "schemas/state.scene_runtime.json"],
    ["event.scene_phase_changed", "schemas/event.scene_phase_changed.json"],
  ].map(([schemaId, path]) => ({
    schemaVersion: 2,
    schemaId,
    path,
    sha256: sha256(files.get(path!)!),
  }));
  const referenceTargets = reference.launchTargets;
  if (!Array.isArray(referenceTargets) || referenceTargets[0] === undefined) {
    throw new Error("PE-C reference adapter omitted its launch target");
  }
  const target = referenceTargets[0] as Record<string, unknown>;
  reference.launchTargets = [
    {
      ...target,
      targetId: contract.launchTargets.defaultTargetId,
      scene: contract.launchTargets.defaultScene,
      default: true,
    },
    {
      ...target,
      targetId: contract.launchTargets.selectedTargetId,
      scene: contract.launchTargets.selectedScene,
      default: false,
    },
  ];
  reference.entityTypes = [
    {
      schemaVersion: 2,
      entityTypeId: "scene_runtime",
      schemaId: "entity.scene_runtime",
      identityStrategy: "spawn_lineage",
    },
  ];
  reference.stateDomains = [
    {
      schemaVersion: 2,
      stateDomainId: "scene_runtime_state",
      schemaId: "state.scene_runtime",
      checkpointDisposition: "uncontrolled",
      subject: {
        schemaVersion: 2,
        kind: "entity",
        allowedEntityTypeIds: ["scene_runtime"],
      },
    },
  ];
  reference.eventTypes = [
    {
      schemaVersion: 2,
      eventTypeId: "scene_phase_changed",
      schemaId: "event.scene_phase_changed",
      source: {
        schemaVersion: 2,
        kind: "entity",
        allowedEntityTypeIds: ["scene_runtime"],
      },
    },
  ];
  reference.smoke = {
    schemaVersion: 2,
    targetId: contract.launchTargets.defaultTargetId,
    timeoutMs: 30_000,
    minimumStateSamples: 4,
    minimumEntityLifecycleRecords: 3,
    requiredStateDomainIds: ["scene_runtime_state"],
    requiredCustomEventTypeIds: ["scene_phase_changed"],
    requiredDynamicTraces: [
      {
        schemaVersion: 2,
        traceId: "source_probe_recreation",
        entityTypeId: "scene_runtime",
        stateDomainId: "scene_runtime_state",
        eventTypeId: "scene_phase_changed",
        minimumIncarnations: 2,
      },
    ],
  };
  files.set("manifest.json", `${JSON.stringify(reference, null, 2)}\n`);
  return files;
};

interface FakePiGoalObservation {
  readonly capabilities: Record<string, unknown>;
  readonly launch: Record<string, unknown>;
  readonly capture: Record<string, unknown>;
  readonly entities: Record<string, unknown>;
  readonly state: Record<string, unknown>;
  readonly events: Record<string, unknown>;
  readonly stop: Record<string, unknown>;
}

interface FakePiMetrics {
  piTurns: number;
  gameToolCalls: number;
  initializationTurns: number;
  readonly goals: FakePiGoalObservation[];
}

const createFakePiDependencies = (
  contract: PeCHostContract,
): {
  readonly dependencies: ProjectEnvironmentPreviewDependenciesV1;
  readonly metrics: FakePiMetrics;
} => {
  const sessionIds = new Map<string, string>();
  const metrics: FakePiMetrics = {
    piTurns: 0,
    gameToolCalls: 0,
    initializationTurns: 0,
    goals: [],
  };
  let callSequence = 0;
  const runPiTurn = async (
    options: RunVNextPiSdkTurnOptions,
  ): Promise<VNextPiTurnResult> => {
    metrics.piTurns += 1;
    let toolCalls = 0;
    const invoke = async (name: string, input: unknown): Promise<unknown> => {
      const tool = options.tools.find((candidate) => candidate.name === name);
      if (tool === undefined) throw new Error(`fake Pi missing tool ${name}`);
      toolCalls += 1;
      callSequence += 1;
      if (name.startsWith("game_")) metrics.gameToolCalls += 1;
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
      metrics.initializationTurns += 1;
      for (const [path, content] of await authoredAdapterFiles(
        options.prompt,
        contract,
      )) {
        await invoke("write", {
          path: `.chronorift/adapter-candidate/${path}`,
          content,
        });
      }
      const finalized = await invoke("project_adapter_finalize_v2", {});
      if (!toolText(finalized).includes("Updated 4 exact schema SHA-256")) {
        throw new Error("fake Pi did not successfully finalize the V2 adapter");
      }
    } else {
      const binding = options.additionalEnvironmentInstructions ?? "";
      const taskId = exactPromptValue(binding, "- taskId");
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
          launchTargetId: contract.launchTargets.selectedTargetId,
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
      const events = gameOutput(
        await invoke("game_query", {
          schemaVersion: 1,
          taskId,
          executionId,
          select: "events",
          limit: 20,
        }),
      );
      for (const output of [entities, state, events]) {
        if (!Array.isArray(output.rows) || output.rows.length === 0) {
          throw new Error("fake Pi did not observe PE-C runtime rows");
        }
      }
      const capture = gameOutput(
        await invoke("game_capture_pin", {
          schemaVersion: 1,
          taskId,
          runtimeId,
          anchor: { kind: "now" },
          before: 0,
          after: 0,
        }),
      );
      const stop = gameOutput(
        await invoke("game_stop", { schemaVersion: 1, taskId, runtimeId }),
      );
      metrics.goals.push({
        capabilities,
        launch,
        capture,
        entities,
        state,
        events,
        stop,
      });
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
      assistantText: "deterministic fake Pi completed the PE-C Host turn",
      errorMessage: null,
      eventsObserved: toolCalls,
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
  return {
    dependencies: Object.freeze({ runPiTurn }),
    metrics,
  };
};

const openTaskStore = async (result: ProjectEnvironmentPreviewResultV1) => {
  const store = new ProjectEnvironmentTaskStoreV1({
    storeRoot: join(result.taskDirectory, "project-environment-records"),
    taskId: asProjectEnvironmentTaskId(result.taskId),
  });
  await store.open();
  return store;
};

const readCanonicalRecord = <T>(
  files: readonly { readonly path: string; readonly bytes: Uint8Array }[],
  path: string,
  parse: (value: unknown) => T,
): T => {
  const matches = files.filter((file) => file.path === path);
  if (matches.length !== 1 || matches[0] === undefined) {
    throw new Error(`PE-C revision must contain exactly one ${path}`);
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(
    matches[0].bytes,
  );
  const value = JSON.parse(text) as unknown;
  const parsed = parse(value);
  expect(text).toBe(
    `${canonicalJson(JSON.parse(JSON.stringify(parsed)) as JsonValue)}\n`,
  );
  return parsed;
};

describe("PE-C external-project Preview Host integration", () => {
  it("publishes a dirty closure, runs selected target, reuses unchanged source, and reviews drift", async () => {
    const contract = await readContract();
    const projectRoot = requiredEnvironment(
      "CHRONORIFT_TEST_PE_C_PROJECT_ROOT",
    );
    const selectedProjectRoot = requiredEnvironment(
      "CHRONORIFT_TEST_PE_C_SELECTED_PROJECT_ROOT",
    );
    await assertDisposableProjectRoot(projectRoot);
    const includeUntrackedPaths = JSON.parse(
      requiredEnvironment("CHRONORIFT_TEST_PE_C_INCLUDE_UNTRACKED_JSON"),
    ) as unknown;
    const defaultTarget = requiredEnvironment(
      "CHRONORIFT_TEST_PE_C_DEFAULT_TARGET",
    );
    const selectedTarget = requiredEnvironment(
      "CHRONORIFT_TEST_PE_C_SELECTED_TARGET",
    );
    expect(selectedProjectRoot).toBe(
      contract.fixtureOverlay.selectedProjectRoot,
    );
    expect(includeUntrackedPaths).toEqual(
      contract.fixtureOverlay.explicitUntrackedPaths,
    );
    expect(defaultTarget).toBe(contract.launchTargets.defaultTargetId);
    expect(selectedTarget).toBe(contract.launchTargets.selectedTargetId);
    if (
      !Array.isArray(includeUntrackedPaths) ||
      !includeUntrackedPaths.every(
        (value): value is string => typeof value === "string",
      )
    ) {
      throw new Error("PE-C explicit untracked input must be a string array");
    }

    const taskStorageRoot = requiredEnvironment(
      "CHRONORIFT_TEST_TASK_STORAGE_ROOT",
    );
    const godotPath = requiredEnvironment("CHRONORIFT_TEST_GODOT_BIN");
    const root = await mkdtemp(join(tmpdir(), "chronorift-pe-c-preview-host-"));
    const runtimeRoot = await mkdtemp(
      join(taskStorageRoot, "chronorift-pe-c-preview-runtime-"),
    );
    temporaryRoots.add(root);
    temporaryRoots.add(runtimeRoot);
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

    const sourceRequest = {
      projectPath: projectRoot,
      projectRoot: selectedProjectRoot,
      includeUntrackedPaths,
      sourceRepositoryExclusionRoots: [taskStorageRoot],
    } as const;
    const initialSource =
      await preflightCleanProjectEnvironmentV1(sourceRequest);
    if (initialSource.sourceClosure === undefined) {
      throw new Error("PE-C preflight omitted its source closure");
    }
    expect(initialSource.mainScene).toBe(contract.launchTargets.defaultScene);
    expect(initialSource.sourceClosure.includedUntrackedPaths).toEqual(
      includeUntrackedPaths,
    );

    const fake = createFakePiDependencies(contract);
    const previewRequest = {
      projectPath: projectRoot,
      projectRoot: selectedProjectRoot,
      includeUntrackedPaths,
      launchTargetId: selectedTarget,
      provider: "fake-provider",
      model: "fake-model",
      thinkingLevel: "off" as const,
      hostConfigPath,
    };
    const first = await runProjectEnvironmentPreviewV1(
      { ...previewRequest, goal: "OBSERVE_SELECTED_PE_C_TARGET" },
      fake.dependencies,
    );
    if (first.status !== "ready") {
      throw new Error(`first PE-C Preview failed: ${JSON.stringify(first)}`);
    }
    expect(first).toMatchObject({
      reused: false,
      goalDelivered: true,
      candidateSourceChanged: false,
      sourceId: initialSource.sourceClosure.sourceId,
      projectRoot: "",
      launchTargetId: selectedTarget,
      validatedLaunchTargetIds:
        contract.launchTargets.expectedValidatedTargetIds,
    });
    expect(first.environmentRevisionId).not.toBeNull();
    expect(first.runtimeObservationReceiptId).not.toBeNull();

    const second = await runProjectEnvironmentPreviewV1(
      { ...previewRequest, goal: "OBSERVE_REUSED_PE_C_TARGET" },
      fake.dependencies,
    );
    if (second.status !== "ready") {
      throw new Error(`second PE-C Preview failed: ${JSON.stringify(second)}`);
    }
    expect(second).toMatchObject({
      reused: true,
      goalDelivered: true,
      candidateSourceChanged: false,
      environmentId: first.environmentId,
      sourceId: first.sourceId,
      projectRoot: first.projectRoot,
      launchTargetId: first.launchTargetId,
      validatedLaunchTargetIds: first.validatedLaunchTargetIds,
      environmentRevisionId: first.environmentRevisionId,
      adapterRevisionId: first.adapterRevisionId,
    });
    expect(second.taskId).not.toBe(first.taskId);
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(fake.metrics.initializationTurns).toBe(1);
    expect(fake.metrics.goals).toHaveLength(2);

    const unchangedSource =
      await preflightCleanProjectEnvironmentV1(sourceRequest);
    expect(unchangedSource.sourceClosure?.sourceId).toBe(
      initialSource.sourceClosure.sourceId,
    );
    expect(unchangedSource.projectSourceIdentity).toBe(
      initialSource.projectSourceIdentity,
    );

    const projectStore = new ProjectEnvironmentStoreV1({
      namespaceRoot: first.projectNamespace,
      environmentId: asProjectEnvironmentId(first.environmentId),
    });
    await projectStore.open();
    const current = await projectStore.readCurrent();
    if (current === null) {
      throw new Error("PE-C Host Gate omitted current revision");
    }
    const revision = await projectStore.readRevision(
      current.environmentRevisionId,
      current.publicationOperationId,
    );
    expect(revision.payload.environmentRevisionId).toBe(
      first.environmentRevisionId,
    );
    expect(revision.payload.sourceId).toBe(
      initialSource.sourceClosure.sourceId,
    );

    const sourceClosure = readCanonicalRecord(
      revision.files,
      "records/source-closure.v1.json",
      (value) => ProjectSourceClosureV1Schema.parse(value),
    );
    const materialization = readCanonicalRecord(
      revision.files,
      "records/source-materialization-receipt.v2.json",
      (value) =>
        ProjectEnvironmentWorkspaceMaterializationReceiptV2Schema.parse(value),
    );
    const targetValidation = readCanonicalRecord(
      revision.files,
      "records/launch-target-validation.v1.json",
      (value) => ProjectAdapterLaunchTargetValidationV1Schema.parse(value),
    );
    expect(sourceClosure).toEqual(initialSource.sourceClosure);
    expect(sourceClosure.projectPath).toBe("");
    expect(sourceClosure.submodules).toEqual([]);
    expect(sourceClosure.entries.map((entry) => entry.relativePath)).toEqual(
      [...sourceClosure.entries]
        .map((entry) => entry.relativePath)
        .sort((left, right) =>
          Buffer.compare(Buffer.from(left), Buffer.from(right)),
        ),
    );
    for (const path of contract.fixtureOverlay.trackedDirtyPaths) {
      expect(sourceClosure.entries).toContainEqual(
        expect.objectContaining({ relativePath: path, provenance: "tracked" }),
      );
    }
    for (const path of contract.fixtureOverlay.explicitUntrackedPaths) {
      expect(sourceClosure.entries).toContainEqual(
        expect.objectContaining({
          relativePath: path,
          provenance: "explicit_untracked",
        }),
      );
    }
    expect(materialization).toMatchObject({
      schemaVersion: 2,
      sourceId: initialSource.sourceClosure.sourceId,
      projectSourceIdentity: initialSource.projectSourceIdentity,
      projectPrefix: "",
      selectedTreeSha256: initialSource.selectedTreeSha256,
      copyRule: "verified-source-closure-v1",
      sourcePostflight: {
        observedProjectSourceIdentity: initialSource.projectSourceIdentity,
        status: "stable",
      },
    });
    expect(targetValidation).toMatchObject({
      defaultTargetId: defaultTarget,
      selectedTargetId: selectedTarget,
    });
    expect(
      targetValidation.targets.map(({ targetId, status }) => ({
        targetId,
        status,
      })),
    ).toEqual(
      contract.launchTargets.expectedValidatedTargetIds.map((targetId) => ({
        targetId,
        status: "validated",
      })),
    );
    for (const path of [
      "records/source-closure.v1.json",
      "records/source-materialization-receipt.v2.json",
      "records/launch-target-validation.v1.json",
    ]) {
      const record = revision.files.find((file) => file.path === path);
      expect(record).toBeDefined();
      expect(Buffer.from(record!.bytes).toString("utf8")).not.toContain(
        projectRoot,
      );
    }

    const adapterFiles = revision.files
      .filter((file) => file.path.startsWith("adapter/"))
      .map((file) => ({ path: file.path.slice(8), bytes: file.bytes }));
    const loadedAdapter = loadProjectAdapterPackageFilesV2(adapterFiles, {
      selectedLaunchTargetId: selectedTarget,
      expectedMainScene: contract.launchTargets.defaultScene,
      requireEmptyLaunchParameters: true,
    });
    const inspected = inspectReusableProjectEnvironmentRevisionV2({
      revision: revision.payload,
      files: revision.files,
      expectedSourceId: revision.payload.sourceId,
      expectedToolchainReceiptId: revision.payload.toolchainReceiptId,
      expectedAdapterId: asAdapterId(loadedAdapter.manifest.adapterId),
      expectedMainScene: contract.launchTargets.defaultScene,
      selectedLaunchTargetId: selectedTarget,
    });
    expect(inspected.selectedLaunchTarget).toMatchObject({
      targetId: selectedTarget,
      scene: contract.launchTargets.selectedScene,
      default: false,
    });

    const [firstStore, secondStore] = await Promise.all([
      openTaskStore(first),
      openTaskStore(second),
    ]);
    if (
      first.runtimeObservationReceiptId === null ||
      second.runtimeObservationReceiptId === null
    ) {
      throw new Error("PE-C Host Gate omitted runtime observation receipts");
    }
    const [firstRuntime, secondRuntime] = await Promise.all([
      firstStore.readRuntimeObservationReceiptV2(
        asProjectEnvironmentRuntimeObservationReceiptId(
          first.runtimeObservationReceiptId,
        ),
      ),
      secondStore.readRuntimeObservationReceiptV2(
        asProjectEnvironmentRuntimeObservationReceiptId(
          second.runtimeObservationReceiptId,
        ),
      ),
    ]);
    for (const runtime of [firstRuntime, secondRuntime]) {
      expect(runtime).toMatchObject({
        launchTargetId: selectedTarget,
        outcome: "succeeded",
        stickyPoisoned: false,
      });
      expect(runtime.captureCount).toBeGreaterThan(0);
      expect(runtime.queryObservations.entityRows).toBeGreaterThan(0);
      expect(runtime.queryObservations.stateRows).toBeGreaterThan(0);
      expect(runtime.eventRows).toBeGreaterThan(0);
      expect(runtime.dynamicTraces.length).toBeGreaterThan(0);
      expect(runtime.dynamicTraces).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            traceId: "source_probe_recreation",
            entityId: "pe-c-runtime-probe",
            firstIncarnation: 1,
            lastIncarnation: 2,
          }),
        ]),
      );
    }
    for (const goal of fake.metrics.goals) {
      const targets = goal.capabilities.launchTargets;
      expect(targets).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            targetId: defaultTarget,
            scene: contract.launchTargets.defaultScene,
            validationStatus: "validated",
          }),
          expect.objectContaining({
            targetId: selectedTarget,
            scene: contract.launchTargets.selectedScene,
            validationStatus: "validated",
          }),
        ]),
      );
      expect(goal.launch).toMatchObject({
        requested: { launchTargetId: selectedTarget },
        realized: { launchTargetId: selectedTarget },
        status: "running",
      });
      const entityRecords = JSON.stringify(goal.entities);
      expect(entityRecords).toContain('"kind":"entity_lifecycle"');
      expect(entityRecords).toContain('"entityId":"pe-c-runtime-probe"');
      const stateRecords = JSON.stringify(goal.state);
      expect(stateRecords).toContain('"kind":"state_sample"');
      expect(stateRecords).toContain('"value":{"phase":3}');
      const eventRecords = JSON.stringify(goal.events);
      expect(eventRecords).toContain('"kind":"adapter_event"');
      expect(eventRecords).toContain('"value":{"phase":3}');
      expect(goal.capture.captureWindowId).toEqual(expect.any(String));
      expect(goal.stop.status).toBe("stopped");
    }

    const beforeReview = {
      piTurns: fake.metrics.piTurns,
      gameToolCalls: fake.metrics.gameToolCalls,
      goals: fake.metrics.goals.length,
    };
    const taskEntriesBeforeReview = (
      await readdir(join(runtimeRoot, "tasks"))
    ).sort();
    await appendFile(
      join(projectRoot, "README.md"),
      "\nPE-C selected tracked source changed after publication.\n",
    );
    await expect(
      runProjectEnvironmentPreviewV1(
        { ...previewRequest, goal: "MUST_NOT_RUN_AFTER_SOURCE_DRIFT" },
        fake.dependencies,
      ),
    ).rejects.toMatchObject({ code: "review_required" });
    expect(fake.metrics.piTurns).toBe(beforeReview.piTurns);
    expect(fake.metrics.gameToolCalls).toBe(beforeReview.gameToolCalls);
    expect(fake.metrics.goals).toHaveLength(beforeReview.goals);
    expect((await readdir(join(runtimeRoot, "tasks"))).sort()).toEqual(
      taskEntriesBeforeReview,
    );
  });
});
