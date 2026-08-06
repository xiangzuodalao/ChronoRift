import {
  INVESTIGATION_TOOL_NAMES_V1,
  type CapsuleAccessResultV1,
  type CompareExecutionsResultV1,
  type DiagnosisProposalDraftV1,
  type ListInterventionsResultV1,
  type ReplayExecutionResultV1,
  type ResourceHandleV1,
  type RunInterventionResultV1,
  type SourceReadResultV1,
  type SourceSearchResultV1,
} from "@chronorift/agent-protocol";
import type { JsonObject } from "@chronorift/domain";
import {
  v04GodotClaimForFixture,
  type V03FixtureName,
} from "@chronorift/godot-adapter";
import {
  createRestrictedSourceAccess,
  createVirtualSourceAccess,
  runScriptedV04PiDiagnosis,
  runV04PiDiagnosis,
  type PiThinkingLevel,
  type RestrictedSourceAccess,
  type V04PiDiagnosisRunResult,
  type V04ScriptObservation,
} from "@chronorift/pi-harness";

import {
  V04InvestigationApi,
  type V04InvestigationApiOptions,
} from "./v04-investigation-api.js";
import { createV04Run, type V04RunContext } from "./v04-runtime.js";

export type V04DiagnosisMode = "scripted" | "live";

export interface RunV04DiagnosisOptions {
  readonly cwd: string;
  readonly fixture: V03FixtureName;
  readonly mode: V04DiagnosisMode;
  readonly artifactRoot?: string | undefined;
  readonly godotBin?: string | undefined;
  readonly provider?: string | undefined;
  readonly model?: string | undefined;
  readonly thinkingLevel?: PiThinkingLevel | undefined;
  readonly timeoutMs?: number | undefined;
  readonly apiOptions?: Omit<V04InvestigationApiOptions, "source"> | undefined;
}

const neutralSourceFor = async (
  context: V04RunContext,
): Promise<RestrictedSourceAccess> => {
  const source = await createRestrictedSourceAccess({
    root: context.preparedFixture.sourceDirectory,
    maxReadLines: 5_000,
  });
  const original = await source.read({
    path: context.preparedFixture.oracle.sourcePath,
    limit: 5_000,
  });
  if (original.truncated) {
    throw new Error("Fixture source exceeds the neutral source-view limit");
  }
  return createVirtualSourceAccess({
    files: [{ path: "case/main.gd", content: original.content }],
    maxReadLines: 5_000,
  });
};

const observed = <T>(
  observations: readonly V04ScriptObservation[],
  toolName: V04ScriptObservation["toolName"],
): T => {
  const match = observations.find((entry) => entry.toolName === toolName);
  if (match === undefined) {
    throw new Error(`Script has no observation for ${toolName}`);
  }
  return match.result as T;
};

const selectedIntervention = (
  catalog: ListInterventionsResultV1,
  assertion: JsonObject,
): ResourceHandleV1 => {
  const inputOrder = assertion["inputOrder"];
  const runtimeControlName = assertion["runtimeControlName"];
  const fixtureControlName = assertion["fixtureControlName"];
  const fixtureControlValue = assertion["fixtureControlValue"];
  const selected = catalog.interventions.find(({ candidate }) => {
    const intervention = candidate.intervention;
    if (typeof inputOrder === "number" && intervention.kind === "shift_input") {
      return (
        intervention.inputOrder === inputOrder && intervention.deltaTicks > 0
      );
    }
    if (
      typeof runtimeControlName === "string" &&
      intervention.kind === "set_runtime_control"
    ) {
      return intervention.name === runtimeControlName;
    }
    if (
      typeof fixtureControlName === "string" &&
      intervention.kind === "set_fixture_control"
    ) {
      return (
        intervention.name === fixtureControlName &&
        JSON.stringify(intervention.value) ===
          JSON.stringify(fixtureControlValue)
      );
    }
    return false;
  });
  if (selected === undefined) {
    throw new Error("Scripted model found no intervention matching its claim");
  }
  return selected.interventionHandle;
};

const uniqueHandles = (
  handles: readonly ResourceHandleV1[],
): ResourceHandleV1[] => [...new Set(handles)];

const scriptedRun = async (
  context: V04RunContext,
  api: V04InvestigationApi,
): Promise<V04PiDiagnosisRunResult> => {
  const claim = v04GodotClaimForFixture(context.preparedFixture.fixtureName);
  const sourceSymbol = context.preparedFixture.oracle.sourceSymbol;
  const steps = [
    {
      toolName: INVESTIGATION_TOOL_NAMES_V1.getCapsule,
      input: { capsuleHandle: api.initialCapsuleHandle },
    },
    {
      toolName: INVESTIGATION_TOOL_NAMES_V1.replayExecution,
      input: (observations: readonly V04ScriptObservation[]) => ({
        executionHandle: observed<CapsuleAccessResultV1>(
          observations,
          INVESTIGATION_TOOL_NAMES_V1.getCapsule,
        ).baselineExecutionHandle,
      }),
    },
    {
      toolName: INVESTIGATION_TOOL_NAMES_V1.listInterventions,
      input: {},
    },
    {
      toolName: INVESTIGATION_TOOL_NAMES_V1.runIntervention,
      input: (observations: readonly V04ScriptObservation[]) => ({
        baselineExecutionHandle: observed<CapsuleAccessResultV1>(
          observations,
          INVESTIGATION_TOOL_NAMES_V1.getCapsule,
        ).baselineExecutionHandle,
        interventionHandle: selectedIntervention(
          observed<ListInterventionsResultV1>(
            observations,
            INVESTIGATION_TOOL_NAMES_V1.listInterventions,
          ),
          claim.assertion.payload,
        ),
      }),
    },
    {
      toolName: INVESTIGATION_TOOL_NAMES_V1.compareExecutions,
      input: (observations: readonly V04ScriptObservation[]) => ({
        baselineExecutionHandle: observed<CapsuleAccessResultV1>(
          observations,
          INVESTIGATION_TOOL_NAMES_V1.getCapsule,
        ).baselineExecutionHandle,
        candidateExecutionHandle: observed<RunInterventionResultV1>(
          observations,
          INVESTIGATION_TOOL_NAMES_V1.runIntervention,
        ).executionHandle,
      }),
    },
    {
      toolName: INVESTIGATION_TOOL_NAMES_V1.searchSource,
      input: {
        query: `func ${sourceSymbol}`,
        path: "case",
        includeSuffixes: [".gd"],
        maxResults: 20,
      },
    },
    {
      toolName: INVESTIGATION_TOOL_NAMES_V1.readSource,
      input: (observations: readonly V04ScriptObservation[]) => {
        const search = observed<SourceSearchResultV1>(
          observations,
          INVESTIGATION_TOOL_NAMES_V1.searchSource,
        );
        const first = search.matches[0];
        if (first === undefined) {
          throw new Error("Scripted model could not locate the source symbol");
        }
        return { path: first.path, limit: 500 };
      },
    },
  ] as const;

  return runScriptedV04PiDiagnosis({
    cwd: context.preparedFixture.sourceDirectory,
    runDir: context.runDirectory,
    api,
    initialCapsuleHandle: api.initialCapsuleHandle,
    steps,
    finalDraft: (observations): DiagnosisProposalDraftV1 => {
      const capsule = observed<CapsuleAccessResultV1>(
        observations,
        INVESTIGATION_TOOL_NAMES_V1.getCapsule,
      );
      const replay = observed<ReplayExecutionResultV1>(
        observations,
        INVESTIGATION_TOOL_NAMES_V1.replayExecution,
      );
      const catalog = observed<ListInterventionsResultV1>(
        observations,
        INVESTIGATION_TOOL_NAMES_V1.listInterventions,
      );
      const candidate = observed<RunInterventionResultV1>(
        observations,
        INVESTIGATION_TOOL_NAMES_V1.runIntervention,
      );
      const comparison = observed<CompareExecutionsResultV1>(
        observations,
        INVESTIGATION_TOOL_NAMES_V1.compareExecutions,
      );
      const search = observed<SourceSearchResultV1>(
        observations,
        INVESTIGATION_TOOL_NAMES_V1.searchSource,
      );
      const read = observed<SourceReadResultV1>(
        observations,
        INVESTIGATION_TOOL_NAMES_V1.readSource,
      );
      return {
        schemaVersion: 1,
        capsuleHandle: capsule.capsuleHandle,
        baselineExecutionHandle: capsule.baselineExecutionHandle,
        replayExecutionHandle: replay.executionHandle,
        candidateExecutionHandles: [candidate.executionHandle],
        comparisonHandles: [comparison.comparisonHandle],
        accessReceiptHandles: uniqueHandles([
          capsule.accessReceiptHandle,
          replay.accessReceiptHandle,
          catalog.accessReceiptHandle,
          candidate.accessReceiptHandle,
          comparison.accessReceiptHandle,
          search.accessReceiptHandle,
          read.accessReceiptHandle,
        ]),
        claim,
        summary:
          "A matching replay plus one comparable fail-to-pass intervention supports the typed runtime mechanism.",
        evidenceEventHandles: uniqueHandles([
          ...capsule.events.map((entry) => entry.eventHandle),
          ...replay.events.map((entry) => entry.eventHandle),
          ...candidate.events.map((entry) => entry.eventHandle),
        ]),
        suspectedSource: { path: read.path, symbol: sourceSymbol },
        blockers: [],
        nextExperiment: null,
        confidence: 0,
      };
    },
  });
};

export interface V04DiagnosisOutput {
  readonly schemaVersion: 4;
  readonly fixture: V03FixtureName;
  readonly mode: V04DiagnosisMode;
  readonly runId: string;
  readonly investigationId: string;
  readonly artifactRoot: string;
  readonly runDirectory: string;
  readonly contractId: string;
  readonly baseline: {
    readonly executionId: string;
    readonly outcome: string;
    readonly timelineDigest: string;
  };
  readonly proposal: V04PiDiagnosisRunResult["proposal"];
  readonly verdict: Awaited<
    ReturnType<V04RunContext["gameBranch"]["conclude"]>
  >;
  readonly piSession: V04PiDiagnosisRunResult["piSession"];
  readonly toolCalls: V04PiDiagnosisRunResult["toolCalls"];
}

export async function runV04Diagnosis(
  options: RunV04DiagnosisOptions,
): Promise<V04DiagnosisOutput> {
  const context = await createV04Run({
    cwd: options.cwd,
    fixture: options.fixture,
    ...(options.artifactRoot === undefined
      ? {}
      : { artifactRoot: options.artifactRoot }),
    ...(options.godotBin === undefined ? {} : { godotBin: options.godotBin }),
  });
  const source = await neutralSourceFor(context);
  const api = new V04InvestigationApi(context, {
    source,
    ...options.apiOptions,
  });
  const result =
    options.mode === "scripted"
      ? await scriptedRun(context, api)
      : await runV04PiDiagnosis({
          cwd: options.cwd,
          runDir: context.runDirectory,
          api,
          initialCapsuleHandle: api.initialCapsuleHandle,
          provider: options.provider ?? "",
          model: options.model ?? "",
          ...(options.thinkingLevel === undefined
            ? {}
            : { thinkingLevel: options.thinkingLevel }),
          ...(options.timeoutMs === undefined
            ? {}
            : { timeoutMs: options.timeoutMs }),
        });
  const verdict = await context.gameBranch.conclude(
    result.proposal,
    api.getReceipts(),
  );
  return {
    schemaVersion: 4,
    fixture: options.fixture,
    mode: options.mode,
    runId: context.runId,
    investigationId: context.investigationId,
    artifactRoot: context.artifactRoot,
    runDirectory: context.runDirectory,
    contractId: context.contract.contractId,
    baseline: {
      executionId: context.baselineExecution.executionId,
      outcome: context.baselineExecution.evaluation.status,
      timelineDigest: context.baselineExecution.timelineDigest,
    },
    proposal: result.proposal,
    verdict,
    piSession: result.piSession,
    toolCalls: result.toolCalls,
  };
}
