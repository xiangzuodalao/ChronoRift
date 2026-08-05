import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  FailureBriefV1Schema,
  asCapsuleId,
  asContractId,
  asExecutionId,
  asFixtureId,
  asRunId,
  type BenchmarkArmV1,
} from "@chronorift/domain";
import {
  InMemoryCredentialStore,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type FauxResponseStep,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";

import { PiHarnessError, PiProviderFailureError } from "../src/errors.js";
import {
  V03ToolFlow,
  createV03Tools,
  runV03PiDiagnosisWithRuntime,
} from "../src/internal/v03-runner.js";
import { createVirtualSourceAccess } from "../src/source-access.js";
import type {
  RestrictedSourceAccess,
  SourceReadResult,
  SourceSearchResult,
} from "../src/types.js";
import type {
  DeterministicV03PiHarnessOptions,
  V03AgentGameApi,
  V03PiProgressSnapshotV3,
} from "../src/v03-types.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const root = async (): Promise<string> => {
  const value = await mkdtemp(join(tmpdir(), "chronorift-pi-v03-"));
  roots.push(value);
  return value;
};

const failureBrief = FailureBriefV1Schema.parse({
  schemaVersion: 1,
  runId: asRunId("run:v03-reliability"),
  fixtureId: asFixtureId("fixture:v03-reliability"),
  contractId: asContractId("contract:v03-reliability"),
  capsuleId: asCapsuleId("capsule:v03-reliability"),
  baselineExecutionId: asExecutionId("execution:v03-reliability"),
  trigger: { kind: "signal", source: "subject", name: "triggered" },
  triggerEventId: "event:v03-reliability",
  triggerTick: 0,
  expectation: {
    kind: "property_equals",
    path: "subject.result",
    value: true,
  },
  deadlineTick: 1,
  actual: { present: true, value: false },
  violationSummary: "The frozen expectation was not met",
});

const unavailableGame = {} as V03AgentGameApi;

const options = (
  cwd: string,
  source: RestrictedSourceAccess,
  extra: Partial<DeterministicV03PiHarnessOptions> = {},
): DeterministicV03PiHarnessOptions => ({
  cwd,
  runDir: join(cwd, "run"),
  arm: "generic",
  initialCapsuleId: failureBrief.capsuleId,
  baselineExecutionId: failureBrief.baselineExecutionId,
  game: unavailableGame,
  source,
  failureBrief,
  thinkingLevel: "off",
  sdkRetry: false,
  timeoutMs: 5_000,
  ...extra,
});

const runtime = async (responses: readonly FauxResponseStep[]) => {
  const faux = fauxProvider({
    api: "chronorift-v03-reliability-api",
    provider: "chronorift-v03-reliability",
    models: [{ id: "reliability", input: ["text"], maxTokens: 8_192 }],
    tokenSize: { min: 4, max: 4 },
  });
  faux.setResponses([...responses]);
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    allowModelNetwork: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  const model = modelRuntime.getModel(
    "chronorift-v03-reliability",
    "reliability",
  );
  if (!model) throw new Error("Reliability faux model was not registered");
  return { faux, modelRuntime, model };
};

describe("V03 Pi runner reliability", () => {
  it.each(["generic", "evidence-only", "chronorift-full"] as const)(
    "marks every %s tool sequential",
    (arm: BenchmarkArmV1) => {
      const flow = new V03ToolFlow(
        options(
          "/virtual",
          createVirtualSourceAccess({
            files: [{ path: "case/main.gd", content: "extends Node" }],
          }),
          { arm },
        ),
      );

      const tools = createV03Tools(flow, arm);
      expect(tools.length).toBeGreaterThan(0);
      expect(new Set(tools.map((tool) => tool.name)).size).toBe(tools.length);
      expect(tools.every((tool) => tool.executionMode === "sequential")).toBe(
        true,
      );
    },
  );

  it("aborts a multi-tool batch immediately on its first tool error", async () => {
    const cwd = await root();
    let readCalls = 0;
    let searchCalls = 0;
    const firstFailure = new PiHarnessError(
      "SOURCE_NOT_FOUND",
      "intentional first tool failure",
    );
    const source: RestrictedSourceAccess = {
      root: "/virtual",
      read: (): Promise<SourceReadResult> => {
        readCalls += 1;
        return Promise.reject(firstFailure);
      },
      search: (): Promise<SourceSearchResult> => {
        searchCalls += 1;
        return Promise.resolve({
          query: "never",
          matches: [],
          scannedFiles: 0,
          truncated: false,
        });
      },
    };
    const fake = await runtime([
      fauxAssistantMessage(
        [
          fauxToolCall(
            "source_read_v1",
            { path: "missing.gd" },
            { id: "first-failing-tool" },
          ),
          fauxToolCall(
            "source_search_v1",
            { query: "never" },
            { id: "must-not-run" },
          ),
        ],
        { stopReason: "toolUse", timestamp: 1_735_689_600_000 },
      ),
    ]);
    const snapshots: V03PiProgressSnapshotV3[] = [];

    const failure = await runV03PiDiagnosisWithRuntime(
      options(cwd, source, {
        onProgressV3: async (snapshot) => {
          snapshots.push(snapshot);
          if (snapshot.tools.failed > 0) {
            throw new Error("later progress persistence failure");
          }
        },
      }),
      fake,
    ).catch((error: unknown) => error);

    expect(failure).toBe(firstFailure);
    expect(readCalls).toBe(1);
    expect(searchCalls).toBe(0);
    // Pi closes the Agent Loop with one signal-aborted continuation turn. The
    // important invariant is that no sibling tool executes after the failure.
    expect(fake.faux.state.callCount).toBe(2);
    expect(snapshots.some((snapshot) => snapshot.tools.failed === 1)).toBe(
      true,
    );
  });

  it("returns a typed connection failure instead of proposal_missing", async () => {
    const cwd = await root();
    const fake = await runtime([
      fauxAssistantMessage([], {
        stopReason: "error",
        errorMessage: "Connection error.",
        timestamp: 1_735_689_600_000,
      }),
    ]);
    const snapshots: V03PiProgressSnapshotV3[] = [];

    const failure = await runV03PiDiagnosisWithRuntime(
      options(
        cwd,
        createVirtualSourceAccess({
          files: [{ path: "case/main.gd", content: "extends Node" }],
        }),
        {
          onProgressV3: (snapshot) => {
            snapshots.push(snapshot);
            return Promise.resolve();
          },
        },
      ),
      fake,
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PiProviderFailureError);
    expect(failure).toMatchObject({
      phase: "request",
      code: "connection",
      httpStatus: null,
      retryClass: "transient",
    });
    expect(snapshots.at(-1)).toMatchObject({
      schemaVersion: 3,
      fixtureStage: "fixture_validated",
      model: { requestStarted: true, outputObserved: false },
      tools: { started: 0, completed: 0, failed: 0, semanticRevision: 0 },
      game: { baselineExecutions: 1, diagnosticExecutions: 0 },
      proposalSubmitted: false,
    });
  });
});
