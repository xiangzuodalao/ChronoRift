import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CanaryCellError,
  V03CanaryJsonLedger,
  buildLunaCanarySpec,
  executeCanaryStage,
  parseCanaryStageReport,
  parseLunaCanarySpec,
  publishCanaryReport,
  type BenchmarkV3CanaryCellRunnerPort,
  type CanaryArm,
  type CanaryFlowSummaryV1,
  type CanaryImplementationReceiptV2,
  type CanaryProgressSummaryV2,
  type CanaryScoredCellResultV1,
  type LunaCanarySpecV1,
  type RunCanaryCellInput,
} from "./v03-canary.js";

const implementationReceipt = (
  sourceHash = "a".repeat(64),
): CanaryImplementationReceiptV2 => ({
  gitCommit: "b".repeat(40),
  sourceHash,
  sourceFileCount: 42,
  sourceWorktreeDirty: false,
});

const buildTestSpec = (
  canaryId: string,
  receipt = implementationReceipt(),
): LunaCanarySpecV1 => buildLunaCanarySpec(canaryId, receipt);

const readyProgress = (arm: CanaryArm): CanaryProgressSummaryV2 => {
  const tools = arm === "chronorift-full" ? 8 : 1;
  return {
    sequence: tools + 1,
    fixtureValidated: true,
    model: {
      requestStarted: true,
      outputObserved: true,
      turnCompleted: true,
    },
    tools: {
      started: tools,
      completed: tools,
      failed: 0,
      semanticRevision: tools,
      consecutiveNonProgressToolResults: 0,
    },
    game: {
      baselineExecutions: 1,
      diagnosticExecutions: arm === "chronorift-full" ? 2 : 0,
    },
    proposalSubmitted: true,
  };
};

const readyFlow = (arm: CanaryArm): CanaryFlowSummaryV1 => {
  if (arm === "generic") {
    return {
      evidenceReceiptCount: 1,
      rawExecutionReceiptCount: 1,
      capsuleReceiptCount: 0,
      sourceReceiptCount: 1,
      replayReceiptCount: 1,
      experimentReceiptCount: 0,
      comparisonReceiptCount: 0,
      matchingReplay: true,
      interventionCount: 0,
      comparisonCount: 0,
    };
  }
  if (arm === "evidence-only") {
    return {
      evidenceReceiptCount: 1,
      rawExecutionReceiptCount: 0,
      capsuleReceiptCount: 1,
      sourceReceiptCount: 1,
      replayReceiptCount: 1,
      experimentReceiptCount: 0,
      comparisonReceiptCount: 0,
      matchingReplay: true,
      interventionCount: 0,
      comparisonCount: 0,
    };
  }
  return {
    evidenceReceiptCount: 2,
    rawExecutionReceiptCount: 0,
    capsuleReceiptCount: 1,
    sourceReceiptCount: 1,
    replayReceiptCount: 1,
    experimentReceiptCount: 1,
    comparisonReceiptCount: 1,
    matchingReplay: true,
    interventionCount: 1,
    comparisonCount: 1,
  };
};

class FakeCanaryRunner implements BenchmarkV3CanaryCellRunnerPort {
  public readonly calls: RunCanaryCellInput[] = [];

  public constructor(
    private readonly failureArm?: CanaryArm,
    private readonly flows: Partial<
      Readonly<Record<CanaryArm, CanaryFlowSummaryV1>>
    > = {},
    private readonly receipt: CanaryImplementationReceiptV2 = implementationReceipt(),
  ) {}

  public implementationReceipt() {
    return Promise.resolve(this.receipt);
  }

  public preflight(spec: LunaCanarySpecV1) {
    return Promise.resolve({
      provider: spec.model.provider,
      model: spec.model.model,
      contextWindow: spec.model.contextWindow,
      maxTokens: spec.model.maxTokens,
      mappedThinkingValue: spec.model.mappedThinkingValue,
    });
  }

  public runCell(input: RunCanaryCellInput): Promise<CanaryScoredCellResultV1> {
    this.calls.push(input);
    if (input.arm === this.failureArm) {
      return Promise.reject(new CanaryCellError("invalid_tool_flow"));
    }
    return Promise.resolve({
      sessionPersisted: true,
      verdict: "confirmed",
      mechanismCorrect: true,
      flow: this.flows[input.arm] ?? readyFlow(input.arm),
      progress: readyProgress(input.arm),
      metrics: {
        gameExecutions: input.arm === "chronorift-full" ? 3 : 1,
        toolCalls: input.arm === "chronorift-full" ? 8 : 1,
        toolErrors: 0,
        maxConsecutiveNonProgressToolResults: 0,
        wallTimeMs: 1_000,
        tokens: {
          input: 100,
          output: 20,
          cacheRead: 30,
          cacheWrite: 0,
          total: 150,
        },
      },
    });
  }
}

class ObservedProviderFailureRunner extends FakeCanaryRunner {
  public override runCell(
    input: RunCanaryCellInput,
  ): Promise<CanaryScoredCellResultV1> {
    if (input.arm !== "evidence-only") return super.runCell(input);
    return Promise.reject(
      new CanaryCellError("http_429", {
        kind: "infrastructure",
        providerFailure: {
          phase: "response_stream",
          code: "http_429",
          httpStatus: 429,
          retryClass: "transient",
        },
        flow: {
          ...readyFlow(input.arm),
          replayReceiptCount: 0,
          matchingReplay: false,
        },
        progress: {
          ...readyProgress(input.arm),
          sequence: 6,
          model: {
            requestStarted: true,
            outputObserved: true,
            turnCompleted: false,
          },
          tools: {
            started: 4,
            completed: 4,
            failed: 0,
            semanticRevision: 3,
            consecutiveNonProgressToolResults: 0,
          },
          proposalSubmitted: false,
        },
        metrics: {
          gameExecutions: 2,
          toolCalls: 4,
          toolErrors: 0,
          maxConsecutiveNonProgressToolResults: 0,
          wallTimeMs: 12_345,
          tokens: {
            input: 900,
            output: 100,
            cacheRead: 200,
            cacheWrite: 0,
            total: 1_200,
          },
        },
      }),
    );
  }
}

class PostProposalFailureRunner extends FakeCanaryRunner {
  public override runCell(
    input: RunCanaryCellInput,
  ): Promise<CanaryScoredCellResultV1> {
    if (input.arm !== "generic") return super.runCell(input);
    return Promise.reject(
      new CanaryCellError("harness_failure", {
        kind: "invalid",
        sessionPersisted: true,
        proposalPresent: true,
        flow: readyFlow(input.arm),
        progress: readyProgress(input.arm),
        metrics: {
          gameExecutions: 1,
          toolCalls: 1,
          toolErrors: 0,
          maxConsecutiveNonProgressToolResults: 0,
          wallTimeMs: 1_000,
          tokens: {
            input: 100,
            output: 20,
            cacheRead: 30,
            cacheWrite: 0,
            total: 150,
          },
        },
      }),
    );
  }
}

const clock = () => {
  let second = 0;
  return () => new Date(Date.UTC(2026, 7, 5, 0, 0, second++)).toISOString();
};

const workspace = async () => {
  const cwd = await mkdtemp(join(tmpdir(), "chronorift-canary-"));
  return { cwd, artifactRoot: join(cwd, ".chronorift") };
};

describe("Luna staged canary", () => {
  it("freezes the strict C0 signal and C1 physics three-arm plan", () => {
    const spec = buildLunaCanarySpec();
    expect(parseLunaCanarySpec(spec)).toEqual(spec);
    const hardened = buildTestSpec("v0.3.2-luna-canary-hardened-spec");
    expect(parseLunaCanarySpec(hardened)).toEqual(hardened);
    expect(hardened).toMatchObject({
      schemaVersion: 2,
      implementationReceipt: implementationReceipt(),
    });
    expect(spec.stages).toEqual([
      {
        stage: "c0",
        stageId: "v0.3.2-luna-c0-001",
        seed: "chronorift-v0.3.2-luna-canary-c0-1",
        fixture: "signal-ordering",
        arms: ["generic", "evidence-only", "chronorift-full"],
      },
      {
        stage: "c1",
        stageId: "v0.3.2-luna-c1-001",
        seed: "chronorift-v0.3.2-luna-canary-c1-1",
        fixture: "physics-tunneling",
        arms: ["generic", "evidence-only", "chronorift-full"],
      },
    ]);
    expect(spec.retryPolicy).toEqual({
      maxAttemptsPerCell: 1,
      providerInternalRetries: 0,
    });

    const withUnknown = {
      ...spec,
      untrustedOverride: "ignored",
    };
    expect(() => parseLunaCanarySpec(withUnknown)).toThrow(
      "unknown or missing fields",
    );
    expect(() =>
      parseLunaCanarySpec({ ...spec, specHash: "0".repeat(64) }),
    ).toThrow("hash mismatch");
  });

  it("runs C0 once per arm and reopens its sealed report without retrying", async () => {
    const paths = await workspace();
    const spec = buildTestSpec("v0.3.2-luna-canary-c0-ready");
    const runner = new FakeCanaryRunner();
    const options = {
      ...paths,
      spec,
      stage: "c0" as const,
      runner,
      nowIso: clock(),
    };
    const report = await executeCanaryStage(options);

    expect(report.readiness).toEqual({ status: "ready", reasons: [] });
    expect(report.cells.map((cell) => cell.arm)).toEqual([
      "generic",
      "evidence-only",
      "chronorift-full",
    ]);
    expect(runner.calls).toHaveLength(3);
    expect(await executeCanaryStage(options)).toEqual(report);
    expect(runner.calls).toHaveLength(3);
    expect(parseCanaryStageReport(report)).toEqual(report);
  });

  it("requires ready C0 evidence and links it before running C1", async () => {
    const paths = await workspace();
    const spec = buildTestSpec("v0.3.2-luna-canary-staged-ready");
    const runner = new FakeCanaryRunner();
    await expect(
      executeCanaryStage({
        ...paths,
        spec,
        stage: "c1",
        runner,
        nowIso: clock(),
      }),
    ).rejects.toThrow("C1 requires the exact ready C0 report");
    expect(runner.calls).toHaveLength(0);

    const c0 = await executeCanaryStage({
      ...paths,
      spec,
      stage: "c0",
      runner,
      nowIso: clock(),
    });
    const c1 = await executeCanaryStage({
      ...paths,
      spec,
      stage: "c1",
      runner,
      prerequisiteReport: c0,
      nowIso: clock(),
    });
    expect(c1.prerequisiteReportHash).toBe(c0.reportHash);
    expect(c1.readiness.status).toBe("ready");
    expect(runner.calls).toHaveLength(6);
    expect(
      runner.calls
        .slice(3)
        .every((call) => call.fixture === "physics-tunneling"),
    ).toBe(true);
  });

  it("rejects a valid but forged C0 report and implementation drift", async () => {
    const paths = await workspace();
    const spec = buildTestSpec("v0.3.2-luna-canary-prerequisite-integrity");
    const c0 = await executeCanaryStage({
      ...paths,
      spec,
      stage: "c0",
      runner: new FakeCanaryRunner(),
      nowIso: clock(),
    });
    const foreignPaths = await workspace();
    const foreignReceipt = implementationReceipt("c".repeat(64));
    const foreignSpec = buildTestSpec(spec.canaryId, foreignReceipt);
    const foreignC0 = await executeCanaryStage({
      ...foreignPaths,
      spec: foreignSpec,
      stage: "c0",
      runner: new FakeCanaryRunner(undefined, {}, foreignReceipt),
      nowIso: clock(),
    });

    await expect(
      executeCanaryStage({
        ...paths,
        spec,
        stage: "c1",
        runner: new FakeCanaryRunner(),
        prerequisiteReport: foreignC0,
      }),
    ).rejects.toThrow("exact same canary spec");

    await expect(
      executeCanaryStage({
        ...paths,
        spec,
        stage: "c1",
        runner: new FakeCanaryRunner(
          undefined,
          {},
          implementationReceipt("c".repeat(64)),
        ),
        prerequisiteReport: c0,
      }),
    ).rejects.toThrow("bound to the exact implementation");
  });

  it("seals a failed arm once and fails readiness without a retry", async () => {
    const paths = await workspace();
    const spec = buildTestSpec("v0.3.2-luna-canary-flow-failure");
    const runner = new FakeCanaryRunner("chronorift-full");
    const report = await executeCanaryStage({
      ...paths,
      spec,
      stage: "c0",
      runner,
      nowIso: clock(),
    });

    expect(runner.calls).toHaveLength(3);
    expect(
      runner.calls.filter((call) => call.arm === "chronorift-full"),
    ).toHaveLength(1);
    expect(report.readiness).toEqual({
      status: "not_ready",
      reasons: ["chronorift-full:failure:invalid_tool_flow"],
    });
    expect(report.cells.at(-1)).toMatchObject({
      attemptOrdinal: 1,
      status: "diagnostic_failure",
      failureKind: "diagnostic",
      failureCode: "invalid_tool_flow",
    });
  });

  it("preserves typed infrastructure status and last observed progress", async () => {
    const paths = await workspace();
    const spec = buildTestSpec("v0.3.2-luna-canary-provider-progress");
    const report = await executeCanaryStage({
      ...paths,
      spec,
      stage: "c0",
      runner: new ObservedProviderFailureRunner(),
      nowIso: clock(),
    });
    const failed = report.cells.find((cell) => cell.arm === "evidence-only");

    expect(failed).toMatchObject({
      schemaVersion: 2,
      status: "infra_failure",
      failureKind: "infrastructure",
      failureCode: "http_429",
      providerFailure: {
        phase: "response_stream",
        code: "http_429",
        httpStatus: 429,
        retryClass: "transient",
      },
      progress: {
        sequence: 6,
        model: { outputObserved: true, turnCompleted: false },
        tools: { started: 4, completed: 4 },
        proposalSubmitted: false,
      },
      metrics: {
        gameExecutions: 2,
        toolCalls: 4,
        wallTimeMs: 12_345,
        tokens: { total: 1_200 },
      },
    });
    expect(report.readiness.reasons).toContain(
      "evidence-only:infra_failure:http_429",
    );
    expect(parseCanaryStageReport(report)).toEqual(report);
  });

  it("preserves a persisted session and proposal when a later step fails", async () => {
    const paths = await workspace();
    const spec = buildTestSpec("v0.3.2-luna-canary-post-proposal-failure");
    const report = await executeCanaryStage({
      ...paths,
      spec,
      stage: "c0",
      runner: new PostProposalFailureRunner(),
      nowIso: clock(),
    });
    const failed = report.cells.find((cell) => cell.arm === "generic");

    expect(failed).toMatchObject({
      status: "invalid",
      failureCode: "harness_failure",
      sessionPersisted: true,
      proposalPresent: true,
      progress: { proposalSubmitted: true },
    });
    expect(parseCanaryStageReport(report)).toEqual(report);
    expect(() =>
      parseCanaryStageReport({
        ...report,
        cells: report.cells.map((cell) =>
          cell.arm === "generic" ? { ...cell, proposalPresent: false } : cell,
        ),
      }),
    ).toThrow("proposal fact contradicts its observed progress");
  });

  it("requires the frozen raw/capsule replay and source accesses per arm", async () => {
    const paths = await workspace();
    const spec = buildTestSpec("v0.3.2-luna-canary-access-contract");
    const runner = new FakeCanaryRunner(undefined, {
      generic: {
        ...readyFlow("generic"),
        rawExecutionReceiptCount: 0,
        sourceReceiptCount: 0,
        replayReceiptCount: 0,
        matchingReplay: false,
      },
      "evidence-only": {
        ...readyFlow("evidence-only"),
        capsuleReceiptCount: 0,
        sourceReceiptCount: 0,
        replayReceiptCount: 0,
        matchingReplay: false,
      },
    });
    const report = await executeCanaryStage({
      ...paths,
      spec,
      stage: "c0",
      runner,
      nowIso: clock(),
    });

    expect(report.readiness).toEqual({
      status: "not_ready",
      reasons: [
        "generic:raw_baseline_receipt_missing",
        "generic:raw_replay_missing",
        "generic:source_receipt_missing",
        "evidence-only:capsule_receipt_missing",
        "evidence-only:strict_replay_missing",
        "evidence-only:source_receipt_missing",
      ],
    });
  });

  it("refuses to resume an interrupted stage under a reused identity", async () => {
    const paths = await workspace();
    const spec = buildTestSpec("v0.3.2-luna-canary-interrupted");
    const ledger = new V03CanaryJsonLedger(
      paths.cwd,
      paths.artifactRoot,
      spec.canaryId,
    );
    await ledger.putSpec(spec);
    await ledger.putStarted("c0", "2026-08-05T00:00:00.000Z");

    await expect(
      executeCanaryStage({
        ...paths,
        spec,
        stage: "c0",
        runner: new FakeCanaryRunner(),
      }),
    ).rejects.toThrow("no-resume policy requires a new canary identity");
  });

  it("detects report tampering and publishes sanitized evidence once", async () => {
    const paths = await workspace();
    const spec = buildTestSpec("v0.3.2-luna-canary-publish");
    const report = await executeCanaryStage({
      ...paths,
      spec,
      stage: "c0",
      runner: new FakeCanaryRunner(),
      nowIso: clock(),
    });
    expect(() =>
      parseCanaryStageReport({
        ...report,
        cells: report.cells.map((cell, index) =>
          index === 0 ? { ...cell, incorrectConfirmation: true } : cell,
        ),
      }),
    ).toThrow();

    const outputPath = "published/c0.report.json";
    const published = await publishCanaryReport({
      ...paths,
      canaryId: spec.canaryId,
      stage: "c0",
      outputPath,
    });
    expect(
      parseCanaryStageReport(JSON.parse(await readFile(published, "utf8"))),
    ).toEqual(report);
    await expect(
      publishCanaryReport({
        ...paths,
        canaryId: spec.canaryId,
        stage: "c0",
        outputPath,
      }),
    ).rejects.toMatchObject({ code: "EEXIST" });
    await expect(
      publishCanaryReport({
        ...paths,
        canaryId: spec.canaryId,
        stage: "c0",
        outputPath: "../escape.json",
      }),
    ).rejects.toThrow("escapes the workspace");
  });
});
