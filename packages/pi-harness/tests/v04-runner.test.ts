import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  INVESTIGATION_CAPABILITIES_V1,
  INVESTIGATION_TOOL_DEFINITIONS_V1,
  INVESTIGATION_TOOL_NAMES_V1,
  type DiagnosisProposalDraftV1,
  type InvestigationApiV1,
  type ResourceHandleV1,
} from "@chronorift/agent-protocol";
import {
  DiagnosisProposalV4Schema,
  type DiagnosisProposalV4,
} from "@chronorift/domain";
import { afterEach, describe, expect, it } from "vitest";

import type { PiHarnessError } from "../src/errors.js";
import { runScriptedV04PiDiagnosis } from "../src/harness.js";
import {
  buildV04SystemPrompt,
  buildV04UserPrompt,
} from "../src/internal/v04-prompt.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const temporaryRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "chronorift-pi-v04-"));
  roots.push(root);
  return root;
};

const handle = (suffix: string): ResourceHandleV1 =>
  `rh_${suffix.padEnd(8, "0")}` as ResourceHandleV1;

const handles = {
  capsule: handle("capsule"),
  baseline: handle("baseline"),
  replay: handle("replay"),
  candidate: handle("candidate"),
  intervention: handle("intervene"),
  comparison: handle("compare"),
  event: handle("event"),
  candidateEvent: handle("cand_evt"),
  receiptCapsule: handle("rcpt_cap"),
  receiptReplay: handle("rcpt_rep"),
  receiptList: handle("rcpt_lst"),
  receiptRun: handle("rcpt_run"),
  receiptCompare: handle("rcpt_cmp"),
  receiptSource: handle("rcpt_src"),
  proposal: handle("proposal"),
} as const;

const manifest = {
  schemaVersion: 1,
  protocolVersion: "chronorift.investigation.v1",
  capabilities: [...INVESTIGATION_CAPABILITIES_V1],
  claimPolicies: [
    {
      policyId: "test.signal-ordering",
      policyVersion: "1.0.0",
      mechanismId: "signal_before_receiver_connection",
      assertionSchemaId: "chronorift.test.signal-ordering.v1",
      mechanismDescription:
        "A signal was emitted before its receiver was connected.",
      additionalProperties: false,
      assertionFields: [
        {
          name: "signalName",
          type: "string",
          required: true,
          description: "Observed signal name.",
        },
      ],
      evidenceRequirements: [
        "Cite the emitted signal and its delivery in both executions.",
      ],
    },
  ],
  budgets: {
    maxToolCalls: 16,
    maxReplayCalls: 1,
    maxInterventions: 1,
    maxComparisons: 1,
    maxSourceReads: 2,
    maxSourceSearches: 2,
    maxSourceReadLines: 500,
    maxSourceSearchResults: 20,
  },
} as const;

type ApiCall = {
  readonly method: string;
  readonly input: unknown;
};

const canonicalProposal = (
  draft: DiagnosisProposalDraftV1,
): DiagnosisProposalV4 =>
  DiagnosisProposalV4Schema.parse({
    schemaVersion: 4,
    proposalId: "proposal:v04:test",
    runId: "run:v04:test",
    investigationId: "investigation:v04:test",
    capsuleId: "capsule:v04:test",
    baselineExecutionId: "execution:v04:baseline",
    ...(draft.replayExecutionHandle === undefined
      ? {}
      : { replayExecutionId: "execution:v04:replay" }),
    candidateExecutionIds: draft.candidateExecutionHandles.map(
      (_, index) => `execution:v04:candidate:${index}`,
    ),
    comparisonIds: draft.comparisonHandles.map(
      (_, index) => `comparison:v04:${index}`,
    ),
    accessReceiptIds: draft.accessReceiptHandles.map(
      (_, index) => `receipt:v04:${index}`,
    ),
    claim: draft.claim,
    summary: draft.summary,
    evidenceEventIds: draft.evidenceEventHandles.map(
      (_, index) => `event:v04:${index}`,
    ),
    ...(draft.suspectedSource === undefined
      ? {}
      : { suspectedSource: draft.suspectedSource }),
    blockers: draft.blockers,
    nextExperiment: draft.nextExperiment,
    confidence: draft.confidence,
  });

class RecordingInvestigationApi implements InvestigationApiV1 {
  public readonly manifest = manifest;
  public readonly calls: ApiCall[] = [];
  public failMethod: string | undefined;

  private record<T>(method: string, input: unknown, value: T): Promise<T> {
    this.calls.push({ method, input: structuredClone(input) });
    return this.failMethod === method
      ? Promise.reject(new Error(`${method} failed`))
      : Promise.resolve(value);
  }

  public getCapsule(input: Parameters<InvestigationApiV1["getCapsule"]>[0]) {
    return this.record("getCapsule", input, {
      capsuleHandle: handles.capsule,
      baselineExecutionHandle: handles.baseline,
      accessReceiptHandle: handles.receiptCapsule,
      capsule: {
        schemaVersion: 2,
        capsuleId: "capsule:v04:test",
        baselineExecutionId: "execution:v04:baseline",
        eventChain: [],
      },
      events: [
        {
          eventHandle: handles.event,
          event: { eventId: "event:v04:baseline" },
        },
      ],
    } as Awaited<ReturnType<InvestigationApiV1["getCapsule"]>>);
  }

  public replayExecution(
    input: Parameters<InvestigationApiV1["replayExecution"]>[0],
  ) {
    return this.record("replayExecution", input, {
      executionHandle: handles.replay,
      accessReceiptHandle: handles.receiptReplay,
      execution: { executionId: "execution:v04:replay", events: [] },
      events: [],
      matches: true,
      sourceDigest: "source",
      replayDigest: "source",
    } as Awaited<ReturnType<InvestigationApiV1["replayExecution"]>>);
  }

  public listInterventions(
    input: Parameters<InvestigationApiV1["listInterventions"]>[0],
  ) {
    return this.record("listInterventions", input, {
      accessReceiptHandle: handles.receiptList,
      interventions: [
        {
          interventionHandle: handles.intervention,
          candidate: {
            schemaVersion: 1,
            interventionId: "intervention:v04:test",
            label: "Caller-selected test intervention",
            intervention: { kind: "shift_input", inputOrder: 0, deltaTicks: 1 },
          },
        },
      ],
    } as Awaited<ReturnType<InvestigationApiV1["listInterventions"]>>);
  }

  public runIntervention(
    input: Parameters<InvestigationApiV1["runIntervention"]>[0],
  ) {
    return this.record("runIntervention", input, {
      interventionHandle: handles.intervention,
      executionHandle: handles.candidate,
      accessReceiptHandle: handles.receiptRun,
      execution: { executionId: "execution:v04:candidate", events: [] },
      events: [
        {
          eventHandle: handles.candidateEvent,
          event: { eventId: "event:v04:candidate" },
        },
      ],
    } as Awaited<ReturnType<InvestigationApiV1["runIntervention"]>>);
  }

  public compareExecutions(
    input: Parameters<InvestigationApiV1["compareExecutions"]>[0],
  ) {
    return this.record("compareExecutions", input, {
      comparisonHandle: handles.comparison,
      accessReceiptHandle: handles.receiptCompare,
      comparison: {
        comparisonId: "comparison:v04:test",
        comparable: true,
        baselineOutcome: "fail",
        candidateOutcome: "pass",
      },
    } as Awaited<ReturnType<InvestigationApiV1["compareExecutions"]>>);
  }

  public readSource(input: Parameters<InvestigationApiV1["readSource"]>[0]) {
    return this.record("readSource", input, {
      accessReceiptHandle: handles.receiptSource,
      path: input.path,
      content: "func receive_signal():\n  pass",
      startLine: 1,
      endLine: 2,
      totalLines: 2,
      truncated: false,
    });
  }

  public searchSource(
    input: Parameters<InvestigationApiV1["searchSource"]>[0],
  ) {
    return this.record("searchSource", input, {
      accessReceiptHandle: handles.receiptSource,
      query: input.query,
      matches: [],
      scannedFiles: 1,
      truncated: false,
    });
  }

  public submitProposal(
    draft: Parameters<InvestigationApiV1["submitProposal"]>[0],
  ) {
    return this.record("submitProposal", draft, {
      accepted: true as const,
      proposalHandle: handles.proposal,
      proposal: canonicalProposal(draft),
    });
  }
}

const resultOf = (
  observations: readonly { readonly result: unknown }[],
  index: number,
): Record<string, unknown> => {
  const value = observations[index]?.result;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Observation ${index} is not an object`);
  }
  return value as Record<string, unknown>;
};

describe("v0.4 Pi adapter", () => {
  it("runs the caller-authored handle flow through a real Pi Session", async () => {
    const cwd = await temporaryRoot();
    const api = new RecordingInvestigationApi();
    const result = await runScriptedV04PiDiagnosis({
      cwd,
      runDir: cwd,
      api,
      initialCapsuleHandle: handles.capsule,
      steps: [
        {
          toolName: INVESTIGATION_TOOL_NAMES_V1.getCapsule,
          input: { capsuleHandle: handles.capsule },
        },
        {
          toolName: INVESTIGATION_TOOL_NAMES_V1.replayExecution,
          input: (observations) => ({
            executionHandle: resultOf(observations, 0)[
              "baselineExecutionHandle"
            ],
          }),
        },
        {
          toolName: INVESTIGATION_TOOL_NAMES_V1.listInterventions,
          input: {},
        },
        {
          toolName: INVESTIGATION_TOOL_NAMES_V1.runIntervention,
          input: (observations) => {
            const capsule = resultOf(observations, 0);
            const list = resultOf(observations, 2);
            const interventions = list["interventions"] as readonly Record<
              string,
              unknown
            >[];
            return {
              baselineExecutionHandle: capsule["baselineExecutionHandle"],
              interventionHandle: interventions[0]?.["interventionHandle"],
            };
          },
        },
        {
          toolName: INVESTIGATION_TOOL_NAMES_V1.compareExecutions,
          input: (observations) => ({
            baselineExecutionHandle: resultOf(observations, 0)[
              "baselineExecutionHandle"
            ],
            candidateExecutionHandle: resultOf(observations, 3)[
              "executionHandle"
            ],
          }),
        },
      ],
      finalDraft: (observations) => {
        const capsule = resultOf(observations, 0);
        const replay = resultOf(observations, 1);
        const list = resultOf(observations, 2);
        const intervention = resultOf(observations, 3);
        const comparison = resultOf(observations, 4);
        const listed = list["interventions"] as readonly Record<
          string,
          unknown
        >[];
        void listed;
        return {
          schemaVersion: 1,
          capsuleHandle: capsule["capsuleHandle"] as ResourceHandleV1,
          baselineExecutionHandle: capsule[
            "baselineExecutionHandle"
          ] as ResourceHandleV1,
          replayExecutionHandle: replay["executionHandle"] as ResourceHandleV1,
          candidateExecutionHandles: [
            intervention["executionHandle"] as ResourceHandleV1,
          ],
          comparisonHandles: [
            comparison["comparisonHandle"] as ResourceHandleV1,
          ],
          accessReceiptHandles: [
            capsule["accessReceiptHandle"] as ResourceHandleV1,
            replay["accessReceiptHandle"] as ResourceHandleV1,
            list["accessReceiptHandle"] as ResourceHandleV1,
            intervention["accessReceiptHandle"] as ResourceHandleV1,
            comparison["accessReceiptHandle"] as ResourceHandleV1,
          ],
          claim: {
            kind: "mechanism",
            mechanismId: "test.plugin.mechanism",
            assertion: {
              schemaId: "chronorift.test.assertion.v1",
              payload: { callerSelected: true },
            },
          },
          summary: "The caller-provided script gathered supporting evidence.",
          evidenceEventHandles: [handles.event, handles.candidateEvent],
          blockers: [],
          nextExperiment: null,
          confidence: 0.5,
        };
      },
    });

    expect(result.proposal.claim).toEqual({
      kind: "mechanism",
      mechanismId: "test.plugin.mechanism",
      assertion: {
        schemaId: "chronorift.test.assertion.v1",
        payload: { callerSelected: true },
      },
    });
    expect(result.piSession.activeTools).toEqual(
      INVESTIGATION_TOOL_DEFINITIONS_V1.map((tool) => tool.name),
    );
    expect(result.piSession.activeTools).not.toContain("bash");
    expect(result.toolCalls.map((call) => call.toolName)).toEqual([
      INVESTIGATION_TOOL_NAMES_V1.getCapsule,
      INVESTIGATION_TOOL_NAMES_V1.replayExecution,
      INVESTIGATION_TOOL_NAMES_V1.listInterventions,
      INVESTIGATION_TOOL_NAMES_V1.runIntervention,
      INVESTIGATION_TOOL_NAMES_V1.compareExecutions,
      INVESTIGATION_TOOL_NAMES_V1.submitProposal,
    ]);
    expect(api.calls.map((call) => call.method)).toEqual([
      "getCapsule",
      "replayExecution",
      "listInterventions",
      "runIntervention",
      "compareExecutions",
      "submitProposal",
    ]);
    expect(api.calls[1]?.input).toEqual({
      executionHandle: handles.baseline,
    });
    expect(api.calls[3]?.input).toEqual({
      baselineExecutionHandle: handles.baseline,
      interventionHandle: handles.intervention,
    });
  });

  it("permits an evidence-backed unknown instead of inventing a mechanism", async () => {
    const cwd = await temporaryRoot();
    const api = new RecordingInvestigationApi();
    const result = await runScriptedV04PiDiagnosis({
      cwd,
      runDir: cwd,
      api,
      initialCapsuleHandle: handles.capsule,
      steps: [
        {
          toolName: INVESTIGATION_TOOL_NAMES_V1.getCapsule,
          input: { capsuleHandle: handles.capsule },
        },
      ],
      finalDraft: (observations) => {
        const capsule = resultOf(observations, 0);
        return {
          schemaVersion: 1,
          capsuleHandle: capsule["capsuleHandle"] as ResourceHandleV1,
          baselineExecutionHandle: capsule[
            "baselineExecutionHandle"
          ] as ResourceHandleV1,
          candidateExecutionHandles: [],
          comparisonHandles: [],
          accessReceiptHandles: [
            capsule["accessReceiptHandle"] as ResourceHandleV1,
          ],
          claim: { kind: "unknown" },
          summary: "No replay or comparable intervention is available.",
          evidenceEventHandles: [],
          blockers: ["Mechanism evidence is insufficient."],
          nextExperiment: "Run a matching replay before claiming causality.",
          confidence: 1,
        };
      },
    });

    expect(result.proposal.claim).toEqual({ kind: "unknown" });
    expect(result.proposal.confidence).toBe(1);
    expect(result.toolCalls).toHaveLength(2);
  });

  it("fails closed when a source/API tool fails", async () => {
    const cwd = await temporaryRoot();
    const api = new RecordingInvestigationApi();
    api.failMethod = "readSource";

    await expect(
      runScriptedV04PiDiagnosis({
        cwd,
        runDir: cwd,
        api,
        initialCapsuleHandle: handles.capsule,
        steps: [
          {
            toolName: INVESTIGATION_TOOL_NAMES_V1.readSource,
            input: { path: "case/main.gd" },
          },
        ],
        finalDraft: {
          schemaVersion: 1,
          capsuleHandle: handles.capsule,
          baselineExecutionHandle: handles.baseline,
          candidateExecutionHandles: [],
          comparisonHandles: [],
          accessReceiptHandles: [],
          claim: { kind: "unknown" },
          summary: "Source access failed.",
          evidenceEventHandles: [],
          blockers: ["Source evidence could not be read."],
          nextExperiment: "Restore bounded source access and retry.",
          confidence: 0,
        },
      }),
    ).rejects.toMatchObject<PiHarnessError>({
      code: "INVALID_TOOL_FLOW",
    });
  });

  it("rejects invalid scripted inputs before invoking the scoped API", async () => {
    const cwd = await temporaryRoot();
    const api = new RecordingInvestigationApi();

    await expect(
      runScriptedV04PiDiagnosis({
        cwd,
        runDir: cwd,
        api,
        initialCapsuleHandle: handles.capsule,
        steps: [
          {
            toolName: INVESTIGATION_TOOL_NAMES_V1.getCapsule,
            input: { capsuleHandle: "../artifact.json" },
          },
        ],
        finalDraft: {} as DiagnosisProposalDraftV1,
      }),
    ).rejects.toMatchObject<PiHarnessError>({ code: "INVALID_ARGUMENT" });
    expect(api.calls).toEqual([]);
  });

  it("contains no benchmark arm, oracle, or fixture mechanism inference", async () => {
    const source = await readFile(
      new URL("../src/internal/v04-runner.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toContain("BenchmarkArmV1");
    expect(source).not.toContain("V03BenchmarkOracle");
    expect(source).not.toContain("signal_before_receiver_connection");
    expect(source).not.toContain("frame_count_used_for_time_window");
    expect(source).not.toContain("discrete_physics_tunneling");
    expect(source).not.toContain("stale_effect_crossed_entity_incarnation");
  });

  it("treats runtime and source text as untrusted prompt data", () => {
    const prompt = buildV04SystemPrompt();
    expect(prompt).toContain("untrusted evidence");
    expect(prompt).toContain("unknown claim");
    expect(prompt).toContain("never determines the Harness verdict");
    expect(prompt).toContain("Required tool sequence:");
    expect(prompt).toContain(
      "game_get_evidence_capsule_v4 and wait for its result",
    );
    expect(prompt).toContain("Do not batch or request parallel tool calls");
    expect(prompt).toContain("claimPolicies array");
    expect(prompt).toContain("provide every required assertionFields entry");
    expect(prompt).toContain("every published evidenceRequirements item");

    const userPrompt = buildV04UserPrompt({
      initialCapsuleHandle: handles.capsule,
      manifest,
    });
    expect(userPrompt).toContain("signal_before_receiver_connection");
    expect(userPrompt).toContain("chronorift.test.signal-ordering.v1");
    expect(userPrompt).toContain('"name": "signalName"');
  });
});
