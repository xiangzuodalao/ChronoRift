import { execFile } from "node:child_process";
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

import type {
  RunVNextPiSdkTurnOptions,
  VNextPiTurnResult,
} from "@chronorift/pi-harness";
import {
  asAdapterId,
  asBuildId,
  asProjectEnvironmentId,
  asProjectEnvironmentRuntimeObservationReceiptId,
  asProjectEnvironmentTaskId,
} from "@chronorift/domain";
import { loadProjectAdapterPackageFilesV2 } from "@chronorift/godot-adapter";
import {
  ProjectEnvironmentStoreV1,
  ProjectEnvironmentTaskStoreV1,
} from "@chronorift/json-artifacts";
import { afterEach, describe, expect, it } from "vitest";

import {
  runProjectEnvironmentPreviewV1,
  type ProjectEnvironmentPreviewDependenciesV1,
} from "./project-environment-preview.js";
import { inspectReusableProjectEnvironmentRevisionV2 } from "./project-environment-reuse-v2.js";
import { preflightCleanProjectEnvironmentV1 } from "./source-preflight.js";

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
    throw new Error(`${name} is required for the PE-B Preview Host Gate`);
  }
  return value;
};

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

const authoredAdapterFiles = async (prompt: string) => {
  const adapterId = exactPromptValue(
    prompt,
    "The manifest adapterId must be exactly",
  );
  const mainScene = exactPromptValue(prompt, "Realized default main scene");
  if (mainScene !== "res://main.tscn")
    throw new Error("PE-B fixture main scene drifted");
  const root = join(
    process.cwd(),
    "testdata/vnext/project-environment/pe-b-dynamic-adapter",
  );
  const paths = [
    "manifest.json",
    "src/project_adapter.gd",
    "schemas/entity.dynamic_actor.json",
    "schemas/event.level_changed.json",
    "schemas/launch.params.json",
    "schemas/state.dynamic_actor.json",
  ];
  const files = new Map<string, string>();
  for (const path of paths)
    files.set(path, await readFile(join(root, path), "utf8"));
  const manifest = JSON.parse(files.get("manifest.json")!) as Record<
    string,
    unknown
  >;
  manifest.adapterId = adapterId;
  const schemaPathById = new Map([
    ["entity.dynamic_actor", "schemas/entity.json"],
    ["event.level_changed", "schemas/event.json"],
    ["launch.params", "schemas/launch.params.json"],
    ["state.dynamic_actor", "schemas/state.json"],
  ]);
  if (!Array.isArray(manifest.schemas))
    throw new Error("PE-B reference adapter omitted its schema inventory");
  const schemaDeclarations: unknown[] = manifest.schemas;
  for (const declaration of schemaDeclarations) {
    if (
      typeof declaration !== "object" ||
      declaration === null ||
      !("schemaId" in declaration) ||
      typeof declaration.schemaId !== "string"
    )
      throw new Error("PE-B reference adapter has a malformed schema entry");
    const schemaId = declaration.schemaId;
    const path = schemaPathById.get(schemaId);
    if (path === undefined)
      throw new Error("PE-B reference adapter declared an unknown schema");
    (declaration as Record<string, unknown>).path = path;
  }
  files.set(
    "schemas/entity.json",
    files.get("schemas/entity.dynamic_actor.json")!,
  );
  files.set(
    "schemas/event.json",
    files.get("schemas/event.level_changed.json")!,
  );
  files.set(
    "schemas/state.json",
    files.get("schemas/state.dynamic_actor.json")!,
  );
  files.delete("schemas/entity.dynamic_actor.json");
  files.delete("schemas/event.level_changed.json");
  files.delete("schemas/state.dynamic_actor.json");
  files.set("manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
  return files;
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
      const queryUntilRowsArrive = async (
        taskId: string,
        executionId: string,
        select: "entities" | "state" | "events",
      ): Promise<Record<string, unknown>> => {
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const output = gameOutput(
            await invoke("game_query", {
              schemaVersion: 1,
              taskId,
              executionId,
              select,
              limit: 20,
            }),
          );
          if (Array.isArray(output.rows) && output.rows.length > 0)
            return output;
          await new Promise<void>((resolve) => setTimeout(resolve, 25));
        }
        throw new Error(
          `fake Pi did not observe ${select} rows in the bounded retry window`,
        );
      };

      const initializing = options.prompt.startsWith(
        "Initialize this Godot project environment",
      );
      if (initializing) {
        for (const [path, content] of await authoredAdapterFiles(
          options.prompt,
        )) {
          await invoke("write", {
            path: `.chronorift/adapter-candidate/${path}`,
            content,
          });
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
        const entities = await queryUntilRowsArrive(
          taskId,
          executionId,
          "entities",
        );
        const state = await queryUntilRowsArrive(taskId, executionId, "state");
        const events = await queryUntilRowsArrive(
          taskId,
          executionId,
          "events",
        );
        if (
          !Array.isArray(entities.rows) ||
          entities.rows.length === 0 ||
          !Array.isArray(state.rows) ||
          state.rows.length === 0 ||
          !Array.isArray(events.rows) ||
          events.rows.length === 0
        ) {
          throw new Error("fake Pi did not observe the PE-B dynamic rows");
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
          `${JSON.stringify({ type: "session", id: sessionId, cwd: options.resourceWorkspaceDirectory })}\n`,
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

describe("PE-B complete Preview Host integration", () => {
  it("initializes, publishes, runs one same-Session goal, and reuses in a new Session", async () => {
    const godotPath = requiredEnvironment("GODOT_BIN");
    const root = await mkdtemp(join(tmpdir(), "chronorift-pe-b-preview-host-"));
    const projectRoot = join(root, "project");
    const runtimeRoot = join(root, "state");
    temporaryRoots.add(root);
    await mkdir(projectRoot);
    const fixtureRoot = join(
      process.cwd(),
      "fixtures/godot-project-environment-dynamic",
    );
    for (const path of [
      ".godot-version",
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

    const dependencies = createFakePiDependencies();
    const source = await preflightCleanProjectEnvironmentV1({
      projectPath: projectRoot,
      sourceRepositoryExclusionRoots: [runtimeRoot],
    });

    const first = await runProjectEnvironmentPreviewV1(
      {
        projectPath: projectRoot,
        provider: "fake-provider",
        model: "fake-model",
        thinkingLevel: "off",
        goal: "OBSERVE_DYNAMIC_PROJECTION",
        stateRoot: runtimeRoot,
        godotBin: godotPath,
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
      candidateSourceChanged: false,
      sourceId: source.sourceClosure?.sourceId,
      projectRoot: "",
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
        stateRoot: runtimeRoot,
        godotBin: godotPath,
      },
      dependencies,
    );
    expect(second).toMatchObject({
      status: "ready",
      reused: true,
      goalDelivered: true,
      candidateSourceChanged: false,
      environmentId: first.environmentId,
      sourceId: first.sourceId,
      projectRoot: first.projectRoot,
      environmentRevisionId: first.environmentRevisionId,
      adapterRevisionId: first.adapterRevisionId,
    });
    expect(second.taskId).not.toBe(first.taskId);
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(second.buildId).not.toBeNull();
    expect(second.runtimeObservationReceiptId).not.toBeNull();

    const openTaskStore = async (result: typeof first) => {
      const store = new ProjectEnvironmentTaskStoreV1({
        storeRoot: join(result.taskDirectory, "project-environment-records"),
        taskId: asProjectEnvironmentTaskId(result.taskId),
      });
      await store.open();
      return store;
    };
    const firstStore = await openTaskStore(first);
    const secondStore = await openTaskStore(second);
    const [firstBindings, secondBindings, firstTurns, secondTurns] =
      await Promise.all([
        firstStore.readBindingEpochs(),
        secondStore.readBindingEpochs(),
        firstStore.readTurns(),
        secondStore.readTurns(),
      ]);
    const firstBinding = firstBindings[0];
    const secondBinding = secondBindings[0];
    if (firstBinding?.state !== "bound" || secondBinding?.state !== "reused")
      throw new Error("PE-B Preview omitted exact binding epochs");
    const [attemptEvents, publication, reuseReceipt] = await Promise.all([
      firstStore.readAttemptEvents(),
      firstStore.readPublicationReceipt(firstBinding.publicationReceiptId),
      secondStore.readReuseReceipt(secondBinding.reuseReceiptId),
    ]);
    const created = attemptEvents[0];
    if (created?.eventKind !== "created")
      throw new Error("PE-B Preview omitted initialization creation");
    const attempt = await firstStore.readInitializationAttempt(
      created.attemptId,
    );
    if (
      first.buildId === null ||
      second.buildId === null ||
      first.runtimeObservationReceiptId === null ||
      second.runtimeObservationReceiptId === null
    )
      throw new Error("PE-B Preview omitted runtime/build identities");
    const [firstBuildBinding, secondBuildBinding, firstRuntime, secondRuntime] =
      await Promise.all([
        firstStore.readBuildBinding(asBuildId(first.buildId)),
        secondStore.readBuildBinding(asBuildId(second.buildId)),
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
    if (
      firstBuildBinding.compatibilityReceiptId === null ||
      secondBuildBinding.compatibilityReceiptId === null ||
      firstRuntime.captureWindowIds[0] === undefined ||
      secondRuntime.captureWindowIds[0] === undefined
    )
      throw new Error("PE-B Preview omitted compatibility/capture IDs");
    const [
      firstCompatibility,
      secondCompatibility,
      firstCapture,
      secondCapture,
    ] = await Promise.all([
      firstStore.readCompatibilityReceiptV2(
        firstBuildBinding.compatibilityReceiptId,
      ),
      secondStore.readCompatibilityReceiptV2(
        secondBuildBinding.compatibilityReceiptId,
      ),
      firstStore.readPinnedCapture(firstRuntime.captureWindowIds[0]),
      secondStore.readPinnedCapture(secondRuntime.captureWindowIds[0]),
    ]);
    const projectStore = new ProjectEnvironmentStoreV1({
      namespaceRoot: first.projectNamespace,
      environmentId: asProjectEnvironmentId(first.environmentId),
    });
    await projectStore.open();
    const current = await projectStore.readCurrent();
    if (current === null)
      throw new Error("PE-B Preview omitted current revision");
    const revision = await projectStore.readRevision(
      current.environmentRevisionId,
      current.publicationOperationId,
    );
    expect(revision.files.map((file) => file.path)).toEqual(
      expect.arrayContaining([
        "records/source-closure.v1.json",
        "records/source-materialization-receipt.v2.json",
      ]),
    );
    const adapterFiles = revision.files
      .filter((file) => file.path.startsWith("adapter/"))
      .map((file) => ({ path: file.path.slice(8), bytes: file.bytes }));
    const loadedAdapter = loadProjectAdapterPackageFilesV2(adapterFiles, {
      requireSingleLaunchTarget: true,
      expectedMainScene: source.mainScene,
      requireEmptyLaunchParameters: true,
    });
    inspectReusableProjectEnvironmentRevisionV2({
      revision: revision.payload,
      files: revision.files,
      expectedSourceId: revision.payload.sourceId,
      expectedToolchainReceiptId: revision.payload.toolchainReceiptId,
      expectedAdapterId: asAdapterId(loadedAdapter.manifest.adapterId),
      expectedMainScene: source.mainScene,
    });
    const toolchain = await firstStore.readToolchainReceipt(
      revision.payload.toolchainReceiptId,
    );
    expect(firstTurns).toHaveLength(2);
    expect(secondTurns).toHaveLength(1);
    expect(publication).toMatchObject({
      outcome: "committed",
      targetEnvironmentRevisionId: first.environmentRevisionId,
    });
    expect(attempt).toMatchObject({
      state: "succeeded",
      environmentRevisionId: first.environmentRevisionId,
    });
    expect(toolchain.status).toBe("realized");
    expect(loadedAdapter.manifest).toMatchObject({
      schemaVersion: 2,
      sdk: { version: 2 },
    });
    expect(firstCompatibility).toMatchObject({
      schemaVersion: 2,
      outcome: "compatible",
    });
    expect(secondCompatibility).toMatchObject({
      schemaVersion: 2,
      outcome: "compatible",
    });
    expect(firstRuntime).toMatchObject({
      schemaVersion: 2,
      outcome: "succeeded",
      stickyPoisoned: false,
    });
    expect(secondRuntime).toMatchObject({
      schemaVersion: 2,
      outcome: "succeeded",
      stickyPoisoned: false,
    });
    expect(firstCompatibility.dynamicTraces.length).toBeGreaterThan(0);
    expect(secondCompatibility.dynamicTraces.length).toBeGreaterThan(0);
    expect(firstRuntime.dynamicTraces.length).toBeGreaterThan(0);
    expect(secondRuntime.dynamicTraces.length).toBeGreaterThan(0);
    if (
      firstCapture.payload.schemaVersion !== 2 ||
      secondCapture.payload.schemaVersion !== 2
    ) {
      throw new Error("PE-B Preview persisted a non-V2 pinned capture");
    }
    expect(firstCapture.payload).toMatchObject({
      schemaVersion: 2,
    });
    expect(secondCapture.payload).toMatchObject({
      schemaVersion: 2,
    });
    expect(firstCapture.payload.dynamicTraces.length).toBeGreaterThan(0);
    expect(secondCapture.payload.dynamicTraces.length).toBeGreaterThan(0);
    expect(reuseReceipt).toMatchObject({
      outcome: "reused",
      environmentRevisionId: first.environmentRevisionId,
    });
    expect(firstRuntime.executionId).not.toBe(secondRuntime.executionId);
  });
});
