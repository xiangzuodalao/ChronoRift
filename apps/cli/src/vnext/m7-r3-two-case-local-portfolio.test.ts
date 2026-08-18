import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  JsonValueSchema,
  asSha256DigestV1,
  asSourceId,
  type Sha256DigestV1,
} from "@chronorift/domain";
import { canonicalJson } from "@chronorift/json-artifacts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  attemptM7R3ResidualCampaignCleanupV1,
  retainM7R3CampaignInfrastructureFailureV1,
  runM7R3TwoCaseLocalPortfolioCoreV1,
  type M7R3CampaignInfrastructureFailureInputV1,
  type M7R3LocalPortfolioCampaignReferenceV1,
  type M7R3LocalPortfolioPreAgentTerminalV1,
} from "./m7-r3-two-case-local-portfolio.js";
import {
  openM7R3TwoCasePortfolioStoreV1,
  type CreateM7R3TwoCasePortfolioFreezeV1Input,
  type M7R3TwoCasePortfolioFreezeV1,
  type M7R3TwoCasePortfolioStoreV1,
} from "./m7-r3-two-case-portfolio.js";

const sha = (value: string): Sha256DigestV1 =>
  asSha256DigestV1(createHash("sha256").update(value).digest("hex"));

const sourceIdentitySha = (
  sourceId: string,
  sourceHash: Sha256DigestV1,
): Sha256DigestV1 =>
  sha(
    canonicalJson(
      JsonValueSchema.parse({ schemaVersion: 1, sourceId, sourceHash }),
    ),
  );

const portfolioInput = (): CreateM7R3TwoCasePortfolioFreezeV1Input => ({
  commonRuntimeMaterials: {
    authoritativeSensorFreezeRecordSha256: sha("sensor-freeze"),
    adapterRevisionSha256: sha("adapter-revision"),
    adapterPackageSha256: sha("adapter-package"),
    adapterObservationSchemaSha256: sha("observation-schema"),
    trajectoryClassifierFreezeRecordSha256: sha("classifier-freeze"),
    trajectoryClassifierImplementationSha256: sha("classifier-code"),
    trajectoryClassifierConfigSha256: sha("classifier-config"),
    validatedGameToolSetSha256: sha("game-tools"),
    pristineAdapterConformanceReceiptSha256: sha("adapter-conformance"),
    commonEnvironmentInstructionsSha256: sha("environment-instructions"),
    hostModelRuntimeConfigSha256: sha("model-runtime"),
  },
  agentConfiguration: {
    provider: "test-provider",
    model: "test-model",
    thinkingLevel: "max",
    agentBudgetSha256: sha("budget"),
    codingToolSetSha256: sha("coding-tools"),
    sandboxPolicySha256: sha("sandbox-policy"),
  },
  pairedAttemptPlan: {
    armOrder: ["runtime_enabled", "code_only"],
    attemptsPerArm: 1,
    retriesAllowed: false,
    userTurnsPerArm: 1,
  },
  evaluationPlan: {
    scenarioClassOrder: [
      "public_reproduction",
      "hidden_variant",
      "regression_control",
    ],
    repetitionsPerScenarioClass: 3,
    expectedFreshCopyRunCount: 9,
    freshCopyPerRun: true,
  },
  cases: ([1, 2] as const).map((ordinal) => {
    const sourceId = asSourceId(`source:${String(ordinal).repeat(64)}`);
    const sourceHash = sha(`mutant-source-${ordinal}`);
    const caseSpecSha256 = sha(`case-spec-${ordinal}`);
    return {
      subject: {
        subjectProjectSha256: sha("subject-project"),
        pristineProjectRevision: "3e793f53598a131c53fb82555191cc14b8db07ff",
        pristineSelectedTreeSha256: sha("pristine-tree"),
      },
      mutant: {
        mutationSha256: sha(`mutation-${ordinal}`),
        mutatedBuildSourceId: sourceId,
        mutatedBuildSourceSha256: sourceHash,
        mutatedBaselineSelectedTreeSha256: sha(`mutant-tree-${ordinal}`),
        mutatedBuildSourceIdentitySha256: sourceIdentitySha(
          sourceId,
          sourceHash,
        ),
      },
      naturalPromptUtf8Sha256: sha(`prompt-${ordinal}`),
      trajectoryCaseSpecId:
        `m7-r3-trajectory-case:${caseSpecSha256.slice(0, 24)}` as const,
      trajectoryCaseSpecSha256: caseSpecSha256,
      adapterMutantCompatibilityReceiptSha256: sha(`compatibility-${ordinal}`),
      pairedPublicTaskContractSha256: sha(`public-contract-${ordinal}`),
      preflightImplementationSha256: sha(`preflight-${ordinal}`),
      evaluatorImplementationSha256: sha(`evaluator-${ordinal}`),
      evaluatorBundleSha256: sha(`evaluator-bundle-${ordinal}`),
    };
  }) as CreateM7R3TwoCasePortfolioFreezeV1Input["cases"],
  frozenAt: "2026-08-16T00:00:00.000Z",
});

const temporaryRoots = new Set<string>();

afterEach(async () => {
  await Promise.all(
    [...temporaryRoots].map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
  temporaryRoots.clear();
});

const storeFixture = async (): Promise<{
  readonly store: M7R3TwoCasePortfolioStoreV1;
  readonly freeze: M7R3TwoCasePortfolioFreezeV1;
}> => {
  const parent = await mkdtemp(join(tmpdir(), "chronorift-r3-coordinator-"));
  temporaryRoots.add(parent);
  const host = join(parent, "host-only");
  const exposed = join(parent, "agent-exposed");
  await Promise.all([
    mkdir(host, { mode: 0o700 }),
    mkdir(exposed, { mode: 0o700 }),
  ]);
  await Promise.all([chmod(host, 0o700), chmod(exposed, 0o700)]);
  const store = await openM7R3TwoCasePortfolioStoreV1({
    root: host,
    exposedRoots: [exposed],
  });
  return { store, freeze: await store.createPortfolioOnce(portfolioInput()) };
};

const campaignReference = (
  ordinal: 1 | 2,
  safetyStop: M7R3LocalPortfolioCampaignReferenceV1["safetyStop"] = null,
): M7R3LocalPortfolioCampaignReferenceV1 => ({
  disposition: "campaign_terminal",
  campaignInfrastructureReceiptSha256: null,
  campaignId: `m7-campaign:${sha(`campaign-${ordinal}`).slice(0, 24)}`,
  caseCampaignAdmissionRecordSha256: sha(`admission-${ordinal}`),
  mutationRegistrationRecordSha256: sha(`registration-${ordinal}`),
  campaignTerminalRecordSha256: sha(`terminal-${ordinal}`),
  runtimeEnabledResultRecordSha256: sha(`runtime-result-${ordinal}`),
  codeOnlyResultRecordSha256: sha(`code-result-${ordinal}`),
  agentDeliveryTraceRecordSha256: sha(`delivery-${ordinal}`),
  trajectoryUseEvidenceRecordSha256: sha(`trajectory-${ordinal}`),
  safetyStop,
});

const runCore = async (input: {
  readonly stages: readonly [
    () => Promise<M7R3LocalPortfolioPreAgentTerminalV1>,
    () => Promise<M7R3LocalPortfolioPreAgentTerminalV1>,
  ];
  readonly campaigns: readonly [
    () => Promise<M7R3LocalPortfolioCampaignReferenceV1>,
    () => Promise<M7R3LocalPortfolioCampaignReferenceV1>,
  ];
}) => {
  const { store, freeze } = await storeFixture();
  return runM7R3TwoCaseLocalPortfolioCoreV1({
    portfolioFreeze: freeze,
    portfolioStore: store,
    resolvePreAgentStageOnce: input.stages,
    runCampaignGateOnce: input.campaigns,
    now: () => "2026-08-16T01:00:00.000Z",
  });
};

describe("M7 R3 two-case local portfolio coordinator", () => {
  it("finishes preflight 1 then preflight 2 before either fixed-order Gate", async () => {
    const events: string[] = [];
    const result = await runCore({
      stages: [
        async () => {
          events.push("preflight-1:start");
          await Promise.resolve();
          events.push("preflight-1:end");
          return { disposition: "ready" };
        },
        async () => {
          events.push("preflight-2:start");
          expect(events).toContain("preflight-1:end");
          await Promise.resolve();
          events.push("preflight-2:end");
          return { disposition: "ready" };
        },
      ],
      campaigns: [
        async () => {
          events.push("case-1:runtime", "case-1:cleanup", "case-1:code-only");
          return campaignReference(1);
        },
        async () => {
          events.push("case-2:runtime", "case-2:cleanup", "case-2:code-only");
          return campaignReference(2);
        },
      ],
    });

    expect(events).toEqual([
      "preflight-1:start",
      "preflight-1:end",
      "preflight-2:start",
      "preflight-2:end",
      "case-1:runtime",
      "case-1:cleanup",
      "case-1:code-only",
      "case-2:runtime",
      "case-2:cleanup",
      "case-2:code-only",
    ]);
    expect(result.summary.cases.map((value) => value.disposition)).toEqual([
      "campaign_terminal",
      "campaign_terminal",
    ]);
    expect(result.safetyStop).toBeNull();
  });

  it("retains both pre-Agent failures without a replacement, retry, or Agent", async () => {
    const firstGate = vi.fn();
    const secondGate = vi.fn();
    const result = await runCore({
      stages: [
        async () => ({
          disposition: "construction_failed",
          constructionReceiptSha256: sha("construction-failure"),
        }),
        async () => ({
          disposition: "preflight_failed",
          preflightReceiptSha256: sha("preflight-failure"),
        }),
      ],
      campaigns: [firstGate, secondGate],
    });

    expect(firstGate).not.toHaveBeenCalled();
    expect(secondGate).not.toHaveBeenCalled();
    expect(result.summary.cases.map((value) => value.disposition)).toEqual([
      "construction_failed",
      "preflight_failed",
    ]);
    expect(result.summary.denominatorCaseCount).toBe(2);
  });

  it("continues case 2 after an ordinary/inconclusive case-1 terminal", async () => {
    const secondGate = vi.fn(async () => campaignReference(2));
    const result = await runCore({
      stages: [
        async () => ({ disposition: "ready" }),
        async () => ({ disposition: "ready" }),
      ],
      campaigns: [async () => campaignReference(1), secondGate],
    });

    expect(secondGate).toHaveBeenCalledOnce();
    expect(result.summary.cases[1].disposition).toBe("campaign_terminal");
  });

  it("safety-stops only the later runnable case after retained cleanup failure", async () => {
    const events: string[] = [];
    const secondGate = vi.fn();
    const cleanupStop = {
      triggerCaseOrdinal: 1 as const,
      reason: "cleanup_not_proven" as const,
      receiptSha256: sha("cleanup-terminal"),
    };
    const result = await runCore({
      stages: [
        async () => {
          events.push("preflight-1");
          return { disposition: "ready" };
        },
        async () => {
          events.push("preflight-2");
          return { disposition: "ready" };
        },
      ],
      campaigns: [
        async () => {
          events.push("gate-1");
          return campaignReference(1, cleanupStop);
        },
        secondGate,
      ],
    });

    expect(events).toEqual(["preflight-1", "preflight-2", "gate-1"]);
    expect(secondGate).not.toHaveBeenCalled();
    expect(result.safetyStop).toEqual(cleanupStop);
    expect(result.summary.cases[1].disposition).toBe("not_started_safety_stop");
  });

  it("keeps an already terminal case-2 preflight failure ahead of a later safety stop", async () => {
    const secondGate = vi.fn();
    const result = await runCore({
      stages: [
        async () => ({ disposition: "ready" }),
        async () => ({
          disposition: "preflight_failed",
          preflightReceiptSha256: sha("case-2-preflight"),
        }),
      ],
      campaigns: [
        async () =>
          campaignReference(1, {
            triggerCaseOrdinal: 1,
            reason: "sandbox_safety_failure",
            receiptSha256: sha("sandbox-safety"),
          }),
        secondGate,
      ],
    });

    expect(secondGate).not.toHaveBeenCalled();
    expect(result.summary.cases[1].disposition).toBe("preflight_failed");
    expect(result.safetyStop?.reason).toBe("sandbox_safety_failure");
  });

  it("leaves the persisted summary as hashes and dispositions, not a causal claim", async () => {
    const result = await runCore({
      stages: [
        async () => ({ disposition: "ready" }),
        async () => ({ disposition: "ready" }),
      ],
      campaigns: [
        async () => campaignReference(1),
        async () => campaignReference(2),
      ],
    });
    const json = canonicalJson(JsonValueSchema.parse(result.summary));
    expect(json).not.toMatch(/diagnosis|mental_causality|general_claim/u);
    expect(result.summary.recordedCaseCount).toBe(2);
  });
});

describe("M7 R3 coordinator failure cleanup boundary", () => {
  const retainFailure = async (input: {
    readonly stage:
      "campaign_preparation" | "campaign_gate" | "terminal_evidence";
    readonly agentStarted: boolean;
    readonly cleanup: () => Promise<unknown>;
    readonly campaignBound: boolean;
    readonly observedTerminal: boolean;
    readonly error?: Error | undefined;
  }) => {
    const { freeze } = await storeFixture();
    const persisted: M7R3CampaignInfrastructureFailureInputV1[] = [];
    const persist = vi.fn(
      async (receipt: M7R3CampaignInfrastructureFailureInputV1) => {
        persisted.push(receipt);
        return sha(`infrastructure:${input.stage}`);
      },
    );
    const campaignId = input.campaignBound
      ? `m7-campaign:${sha("failed-campaign").slice(0, 24)}`
      : null;
    const reference = await retainM7R3CampaignInfrastructureFailureV1({
      portfolioFreeze: freeze,
      caseOrdinal: 1,
      stage: input.stage,
      error: input.error ?? new Error("secret message /host/private/path"),
      agentStarted: input.agentStarted,
      campaignId,
      caseCampaignAdmissionRecordSha256:
        campaignId === null ? null : sha("failed-admission"),
      mutationRegistrationRecordSha256:
        campaignId === null ? null : sha("failed-registration"),
      observedTerminalRecordSha256:
        campaignId !== null && input.observedTerminal
          ? sha("observed-terminal")
          : null,
      cleanupRemainingAfterFailure: input.cleanup,
      persistInfrastructureFailureOnce: persist,
      now: () => "2026-08-16T01:30:00.000Z",
    });
    return { reference, persisted: persisted[0], persist };
  };

  it("retains a prepare throw after finally cleanup without persisting Error text or paths", async () => {
    const cleanup = vi.fn(async () => ({
      cleanupProven: true,
      cleanupReceiptSha256: sha("prepare-cleanup"),
      sandboxSafetyFailure: false,
      sandboxSafetyReceiptSha256: null,
    }));
    const { reference, persisted, persist } = await retainFailure({
      stage: "campaign_preparation",
      agentStarted: false,
      cleanup,
      campaignBound: false,
      observedTerminal: false,
    });

    expect(cleanup).toHaveBeenCalledOnce();
    expect(persist).toHaveBeenCalledOnce();
    expect(reference.disposition).toBe("campaign_infrastructure_failure");
    expect(reference.campaignId).toBeNull();
    expect(reference.safetyStop).toBeNull();
    expect(persisted).toMatchObject({
      stage: "campaign_preparation",
      agentStarted: false,
      cleanupProven: true,
    });
    expect(JSON.stringify(persisted)).not.toMatch(
      /secret message|private\/path/u,
    );
  });

  it("distinguishes a Gate throw before Agent start and keeps case 2 runnable", async () => {
    const { reference, persisted } = await retainFailure({
      stage: "campaign_gate",
      agentStarted: false,
      cleanup: async () => ({
        cleanupProven: true,
        cleanupReceiptSha256: sha("pre-agent-gate-cleanup"),
        sandboxSafetyFailure: false,
        sandboxSafetyReceiptSha256: null,
      }),
      campaignBound: true,
      observedTerminal: false,
    });
    const secondGate = vi.fn(async () => campaignReference(2));
    const result = await runCore({
      stages: [
        async () => ({ disposition: "ready" }),
        async () => ({ disposition: "ready" }),
      ],
      campaigns: [async () => reference, secondGate],
    });

    expect(persisted?.agentStarted).toBe(false);
    expect(secondGate).toHaveBeenCalledOnce();
    expect(result.summary.cases[0].disposition).toBe(
      "campaign_infrastructure_failure",
    );
    expect(result.summary.cases[0].campaignTerminalRecordSha256).toBeNull();
  });

  it("retains a Gate throw after Agent start and safety-stops on cleanup failure", async () => {
    const { reference, persisted } = await retainFailure({
      stage: "campaign_gate",
      agentStarted: true,
      cleanup: async () => {
        throw new Error("cleanup controller failed");
      },
      campaignBound: true,
      observedTerminal: false,
    });
    const secondGate = vi.fn();
    const result = await runCore({
      stages: [
        async () => ({ disposition: "ready" }),
        async () => ({ disposition: "ready" }),
      ],
      campaigns: [async () => reference, secondGate],
    });

    expect(persisted).toMatchObject({
      stage: "campaign_gate",
      agentStarted: true,
      cleanupProven: false,
      cleanupReceiptSha256: null,
    });
    expect(reference.safetyStop?.reason).toBe("cleanup_not_proven");
    expect(secondGate).not.toHaveBeenCalled();
    expect(result.summary.cases.map((value) => value.disposition)).toEqual([
      "campaign_infrastructure_failure",
      "not_started_safety_stop",
    ]);
  });

  it("retains a post-terminal evidence-read failure without publishing terminal/evidence refs", async () => {
    const { reference, persisted } = await retainFailure({
      stage: "terminal_evidence",
      agentStarted: true,
      cleanup: async () => ({
        cleanupProven: true,
        cleanupReceiptSha256: sha("evidence-failure-cleanup"),
        sandboxSafetyFailure: false,
        sandboxSafetyReceiptSha256: null,
      }),
      campaignBound: true,
      observedTerminal: true,
    });

    expect(persisted?.observedTerminalRecordSha256).toBe(
      sha("observed-terminal"),
    );
    expect(reference).toMatchObject({
      disposition: "campaign_infrastructure_failure",
      campaignTerminalRecordSha256: null,
      runtimeEnabledResultRecordSha256: null,
      codeOnlyResultRecordSha256: null,
      agentDeliveryTraceRecordSha256: null,
      trajectoryUseEvidenceRecordSha256: null,
    });
  });

  it("closes residual prepared resources after a terminal and does not hide an unproven close", async () => {
    const residualClose = vi.fn(async () => ({
      cleanupProven: false,
      cleanupReceiptSha256: null,
      sandboxSafetyFailure: false,
      sandboxSafetyReceiptSha256: null,
    }));
    const attempted = await attemptM7R3ResidualCampaignCleanupV1(residualClose);
    const { freeze } = await storeFixture();
    const shouldNotCloseTwice = vi.fn();
    const persist = vi.fn(
      async (receipt: M7R3CampaignInfrastructureFailureInputV1) => {
        void receipt;
        return sha("residual-cleanup-failure");
      },
    );
    const campaignId = `m7-campaign:${sha("residual-campaign").slice(0, 24)}`;
    const reference = await retainM7R3CampaignInfrastructureFailureV1({
      portfolioFreeze: freeze,
      caseOrdinal: 1,
      stage: "residual_cleanup",
      error: new Error("residual cleanup was not proven /host/path"),
      agentStarted: true,
      campaignId,
      caseCampaignAdmissionRecordSha256: sha("residual-admission"),
      mutationRegistrationRecordSha256: sha("residual-registration"),
      observedTerminalRecordSha256: sha("residual-terminal"),
      cleanupRemainingAfterFailure: shouldNotCloseTwice,
      completedResidualCleanup: attempted.cleanup,
      persistInfrastructureFailureOnce: persist,
      now: () => "2026-08-16T01:45:00.000Z",
    });

    expect(residualClose).toHaveBeenCalledOnce();
    expect(shouldNotCloseTwice).not.toHaveBeenCalled();
    expect(reference).toMatchObject({
      disposition: "campaign_infrastructure_failure",
      campaignTerminalRecordSha256: null,
      safetyStop: {
        reason: "cleanup_not_proven",
        receiptSha256: sha("residual-cleanup-failure"),
      },
    });
    expect(JSON.stringify(persist.mock.calls[0]?.[0])).not.toMatch(
      /residual cleanup|host\/path/iu,
    );
  });
});
