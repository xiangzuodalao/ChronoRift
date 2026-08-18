import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
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

import type {
  M7R3CaseConstructionReceiptV1,
  M7R3CasePreflightReceiptV1,
} from "./m7-r3-case-construction.js";
import type { M7R3PairedCaseContractV1 } from "./m7-r3-paired-agent.js";
import { M7R3ProjectEnvironmentPreparationInfrastructureErrorV1 } from "./m7-r3-project-environment-preparation.js";
import type { M7R3TwoCaseLocalPortfolioRunV1 } from "./m7-r3-two-case-local-portfolio.js";
import {
  assertM7R4PhaseOneAssignmentMatchesV1,
  cleanupM7R4PhaseOneSlotsV1,
  createM7R4FormalCasePlansV1,
  createM7R4ResidualCleanupCallbackV1,
  failM7R4FreshDesignAfterCleanupV1,
  M7R4FormalOuterFailureReceiptV1Schema,
  projectM7R4KnownPreparationFailureCleanupV1,
  projectM7R4PhaseOneCleanupV1,
  retainAndValidateM7R4PreparedPhaseOneV1,
  resolveM7R4PhaseOneAssignmentInputsV1,
  runM7R4FormalLiveV1,
  summarizeM7R4PhaseOneCleanupV1,
  type M7R4FormalCompositionPortsV1,
  type M7R4FreshTwoCaseDesignV1,
  type M7R4PreparedCasePhaseOneV1,
} from "./m7-r4-formal-live.js";
import type { M7R4NoAgentLiveResultV1 } from "./m7-r4-no-agent-live.js";
import {
  openM7R4NoAgentPreflightAttemptStoreV1,
  type M7R4NoAgentPreflightSubjectEvidenceInputV1,
} from "./m7-r4-no-agent-preflight-attempt.js";
import {
  createM7R3TwoCasePortfolioFreezeV1,
  type CreateM7R3TwoCasePortfolioFreezeV1Input,
  type M7R3TwoCasePortfolioFreezeV1,
} from "./m7-r3-two-case-portfolio.js";
import type { M7R4VerifiedLiveMaterialsV1 } from "./m7-r4-live-materials.js";
import { ProjectEnvironmentPreparationInfrastructureErrorV1 } from "./preparation-resource-owner.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

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

const portfolio = (): M7R3TwoCasePortfolioFreezeV1 =>
  createM7R3TwoCasePortfolioFreezeV1({
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
        adapterMutantCompatibilityReceiptSha256: sha(
          `compatibility-${ordinal}`,
        ),
        pairedPublicTaskContractSha256: sha(`public-contract-${ordinal}`),
        preflightImplementationSha256: sha(`preflight-${ordinal}`),
        evaluatorImplementationSha256: sha(`evaluator-${ordinal}`),
        evaluatorBundleSha256: sha(`evaluator-bundle-${ordinal}`),
      };
    }) as CreateM7R3TwoCasePortfolioFreezeV1Input["cases"],
    frozenAt: "2026-08-16T00:00:00.000Z",
  });

const evidence = (
  freeze: M7R3TwoCasePortfolioFreezeV1,
): readonly M7R4NoAgentPreflightSubjectEvidenceInputV1[] =>
  freeze.cases.flatMap((frozenCase) =>
    (["pristine", "mutant"] as const).map((subject) => ({
      caseOrdinal: frozenCase.ordinal,
      caseId: frozenCase.caseId,
      subject,
      cleanupAttempted: false,
      cleanupProven: false,
      cleanupReceipt: null,
      cleanupReceiptSha256: null,
      securityEvents: null,
      securityEventsSha256: null,
    })),
  );

const receipt = (
  freeze: M7R3TwoCasePortfolioFreezeV1,
  index: 0 | 1,
): M7R3CasePreflightReceiptV1 =>
  ({
    ordinal: (index + 1) as 1 | 2,
    portfolio: {
      portfolioId: freeze.portfolioId,
      portfolioFreezeRecordSha256: freeze.recordContentSha256,
      caseId: freeze.cases[index].caseId,
    },
    outcome: "passed",
    recordContentSha256: sha(`preflight-${index + 1}`),
  }) as unknown as M7R3CasePreflightReceiptV1;

const completed = (
  freeze: M7R3TwoCasePortfolioFreezeV1,
): M7R4NoAgentLiveResultV1 => {
  const receipts = [receipt(freeze, 0), receipt(freeze, 1)] as const;
  return {
    result: {
      schemaVersion: 1,
      status: "completed",
      agentLaunchCount: 0,
      providerInvocationCount: 0,
      piSessionCount: 0,
      receipts,
    },
    completedReceipts: receipts,
    subjectEvidence: evidence(freeze),
  };
};

const openAttemptStore = async () => {
  const root = await mkdtemp(join(tmpdir(), "chronorift-r4-formal-test-"));
  temporaryRoots.push(root);
  return openM7R4NoAgentPreflightAttemptStoreV1({
    root,
    exposedRoots: [],
  });
};

const fixture = () => {
  const freeze = portfolio();
  const constructions = [
    { ordinal: 1 },
    { ordinal: 2 },
  ] as unknown as readonly [
    M7R3CaseConstructionReceiptV1,
    M7R3CaseConstructionReceiptV1,
  ];
  const contracts = [
    { caseOrdinal: 1 },
    { caseOrdinal: 2 },
  ] as unknown as readonly [M7R3PairedCaseContractV1, M7R3PairedCaseContractV1];
  const createPortfolioOnce = vi.fn(async () => freeze);
  const cleanup = vi.fn(async () => ({
    cleanupProven: true,
    cleanupReceiptSha256: sha("cleanup"),
    sandboxSafetyFailure: false,
    sandboxSafetyReceiptSha256: null,
  }));
  const preparedPair = ([1, 2] as const).map((ordinal) => ({
    materials: { ordinal, slug: `case-${ordinal}` },
    roots: { campaignRoot: `/unused/case-${ordinal}` },
    infrastructure: { abortPreparation: vi.fn(async () => undefined) },
  })) as unknown as M7R4FreshTwoCaseDesignV1["preparedPair"];
  const design = {
    constructionStore: {},
    portfolioStore: { createPortfolioOnce },
    preparedPair,
    constructions,
    portfolioFreezeInput: {},
    expectedPortfolio: freeze,
    contracts,
    cleanup,
  } as unknown as M7R4FreshTwoCaseDesignV1;
  const live = {
    mode: "r4-live",
    classifierFreeze: { schemaVersion: 1, marker: "classifier" },
  } as unknown as M7R4VerifiedLiveMaterialsV1;
  return { freeze, constructions, design, live, createPortfolioOnce, cleanup };
};

const portfolioResult = (
  freeze: M7R3TwoCasePortfolioFreezeV1,
): M7R3TwoCaseLocalPortfolioRunV1 =>
  ({
    portfolioFreeze: freeze,
    caseReferences: [],
    safetyStop: null,
    summary: {},
  }) as unknown as M7R3TwoCaseLocalPortfolioRunV1;

const materializationFailurePorts = (
  cleanup: () => Promise<unknown>,
): M7R4FormalCompositionPortsV1 => ({
  prepareFreshDesign: vi.fn(async () =>
    failM7R4FreshDesignAfterCleanupV1({
      error: new Error("phase-one preparation failed"),
      cleanup,
    }),
  ),
  runNoAgentPreflightForDesign: vi.fn(async () => {
    throw new Error("unreachable no-Agent preflight");
  }),
  runPortfolio: vi.fn(async () => {
    throw new Error("unreachable portfolio coordinator");
  }),
});

describe("M7 R4 formal production composition", () => {
  it("uses the case-local sensor mount beneath the supplied Host-only root", async () => {
    const root = await mkdtemp(join(tmpdir(), "chronorift-r4-host-inputs-"));
    temporaryRoots.push(root);
    const assignmentRoot = join(root, "assignment");
    const sensorRoot = join(assignmentRoot, "sensor");
    const substitutedSensorRoot = join(root, "substituted-sensor");
    await Promise.all([
      mkdir(sensorRoot, { recursive: true, mode: 0o700 }),
      mkdir(substitutedSensorRoot, { mode: 0o700 }),
    ]);

    const inputs = await resolveM7R4PhaseOneAssignmentInputsV1({
      assignmentRoot,
      authoritativeSensorRoot: sensorRoot,
    });

    expect(inputs).toEqual({
      hostOnlyRoot: assignmentRoot,
      adapterPackageRoot: join(sensorRoot, "package"),
      adapterRevisionPath: join(sensorRoot, "adapter-revision.v1.json"),
      adapterConformanceReceiptPath: join(
        sensorRoot,
        "conformance-receipt.v1.json",
      ),
    });
    await expect(
      resolveM7R4PhaseOneAssignmentInputsV1({
        assignmentRoot,
        authoritativeSensorRoot: substitutedSensorRoot,
      }),
    ).rejects.toThrow("case-local sensor authority mount changed");
  });

  it("proves cleanup when a later case fails Host-input admission before acquiring resources", async () => {
    const firstCleanupSha256 = sha("first-prepared-case-cleanup");
    const firstCleanup = vi.fn(async () => ({
      cleanupProven: true,
      cleanupReceiptSha256: firstCleanupSha256,
      sandboxSafetyFailure: false,
      sandboxSafetyReceiptSha256: null,
    }));

    const zeroResourceCleanup = await cleanupM7R4PhaseOneSlotsV1([
      { ordinal: 1, state: "not_started" },
      { ordinal: 2, state: "not_started" },
    ]);
    const inFlightFailureCleanup = await cleanupM7R4PhaseOneSlotsV1([
      { ordinal: 1, state: "preparation_started" },
      { ordinal: 2, state: "not_started" },
    ]);
    const partialCleanup = await cleanupM7R4PhaseOneSlotsV1([
      {
        ordinal: 1,
        state: "prepared",
        abortPreparation: firstCleanup,
      },
      { ordinal: 2, state: "not_started" },
    ]);
    const observedCleanup = await cleanupM7R4PhaseOneSlotsV1([
      {
        ordinal: 1,
        state: "cleanup_observed",
        cleanup: {
          cleanupProven: true,
          cleanupReceiptSha256: sha("observed preparation cleanup"),
          sandboxSafetyFailure: false,
          sandboxSafetyReceiptSha256: null,
        },
      },
      { ordinal: 2, state: "not_started" },
    ]);

    expect(firstCleanup).toHaveBeenCalledOnce();
    expect(zeroResourceCleanup.cleanupProven).toBe(true);
    expect(zeroResourceCleanup.cleanupReceiptSha256).not.toBeNull();
    expect(inFlightFailureCleanup.cleanupProven).toBe(false);
    expect(inFlightFailureCleanup.cleanupReceiptSha256).toBeNull();
    expect(partialCleanup.cleanupProven).toBe(true);
    expect(partialCleanup.cleanupReceiptSha256).not.toBeNull();
    expect(partialCleanup.sandboxSafetyFailure).toBe(false);
    expect(observedCleanup.cleanupProven).toBe(true);
    expect(observedCleanup.cleanupReceiptSha256).not.toBeNull();
  });

  it("accepts cleanup only from the two typed preparation failures", () => {
    const m7Cleanup = {
      cleanupProven: true,
      cleanupReceiptSha256: sha("M7 typed cleanup"),
      sandboxSafetyFailure: false,
      sandboxSafetyReceiptSha256: null,
    };
    const m7Failure =
      new M7R3ProjectEnvironmentPreparationInfrastructureErrorV1(
        m7Cleanup,
        new Error("M7 preparation failure"),
      );
    const m6Failure = new ProjectEnvironmentPreparationInfrastructureErrorV1(
      "m6:broker",
      {
        schemaVersion: 1,
        sandboxCleanupKind: "broker",
        sandboxCleanupRequired: true,
        sandboxCleanupAttempted: true,
        sandboxCleanupReceiptObserved: true,
        sandboxCleanupComplete: true,
        taskRootRemovalAttempted: true,
        taskRootRemoved: true,
        cleanupProven: true,
      },
      new Error("M6 preparation failure"),
    );

    expect(projectM7R4KnownPreparationFailureCleanupV1(m7Failure)).toEqual(
      m7Cleanup,
    );
    const projectedM6 = projectM7R4KnownPreparationFailureCleanupV1(m6Failure);
    expect(projectedM6).toMatchObject({
      cleanupProven: true,
      sandboxSafetyFailure: false,
    });
    expect(projectedM6?.cleanupReceiptSha256).not.toBeNull();
    expect(
      projectM7R4KnownPreparationFailureCleanupV1(
        new Error("unknown preparation failure"),
      ),
    ).toBeNull();
  });

  it("accepts a successful sentinel cleanup whose preparation retains an informational safety summary", async () => {
    const cleanupReceiptSha256 = sha("cleanup-proof");
    const informationalSafetySummarySha256 = sha(
      "successful-sentinel-safety-summary",
    );
    const abortPreparation = vi.fn(async () => ({
      cleanupProven: true,
      cleanupReceiptSha256,
      sandboxSafetyFailure: false,
      sandboxSafetyReceiptSha256: informationalSafetySummarySha256,
    }));

    const cleanup = await cleanupM7R4PhaseOneSlotsV1([
      { ordinal: 1, state: "prepared", abortPreparation },
      {
        ordinal: 2,
        state: "prepared",
        abortPreparation: async () => ({
          cleanupProven: true,
          cleanupReceiptSha256: sha("case-2-cleanup-proof"),
          sandboxSafetyFailure: false,
          sandboxSafetyReceiptSha256: sha(
            "case-2-successful-sentinel-safety-summary",
          ),
        }),
      },
    ]);

    expect(abortPreparation).toHaveBeenCalledOnce();
    expect(cleanup.cleanupProven).toBe(true);
    expect(cleanup.cleanupReceiptSha256).not.toBeNull();
    expect(cleanup.sandboxSafetyFailure).toBe(false);
    expect(cleanup.sandboxSafetyReceiptSha256).toBeNull();
  });

  it("does not discard a real sandbox-safety failure or invent its proof", () => {
    const sandboxSafetyReceiptSha256 = sha("sandbox-safety-failure");
    expect(
      projectM7R4PhaseOneCleanupV1({
        cleanupProven: true,
        cleanupReceiptSha256: sha("cleanup-proof"),
        sandboxSafetyFailure: true,
        sandboxSafetyReceiptSha256,
      }),
    ).toMatchObject({
      sandboxSafetyFailure: true,
      sandboxSafetyReceiptSha256,
    });
    expect(() =>
      projectM7R4PhaseOneCleanupV1({
        cleanupProven: true,
        cleanupReceiptSha256: sha("cleanup-proof"),
        sandboxSafetyFailure: true,
        sandboxSafetyReceiptSha256: null,
      }),
    ).toThrow("sandbox-safety failure and receipt presence must agree");
  });

  it("projects an informational preparation safety hash at the production case boundary", async () => {
    const value = fixture();
    const cleanupReceiptSha256 = sha("case-boundary-cleanup");
    const abortPreparation = vi.fn(async () => ({
      cleanupProven: true,
      cleanupReceiptSha256,
      sandboxSafetyFailure: false,
      sandboxSafetyReceiptSha256: sha("informational-safety-summary"),
    }));
    const design = {
      ...value.design,
      preparedPair: [
        {
          ...value.design.preparedPair[0],
          infrastructure: {
            ...value.design.preparedPair[0].infrastructure,
            abortPreparation,
          },
        },
        value.design.preparedPair[1],
      ],
    } as unknown as M7R4FreshTwoCaseDesignV1;
    const plans = createM7R4FormalCasePlansV1({
      live: value.live,
      design,
      runSharedNoAgentPreflightOnce: async () => completed(value.freeze),
      now: () => "2026-08-16T01:00:00.000Z",
    });

    await expect(plans[0].abortPreparation()).resolves.toEqual({
      cleanupProven: true,
      cleanupReceiptSha256,
      sandboxSafetyFailure: false,
      sandboxSafetyReceiptSha256: null,
    });
    await plans[0].abortPreparation();
    expect(abortPreparation).toHaveBeenCalledOnce();
  });

  it("preserves a real safety failure hash at the production case boundary", async () => {
    const value = fixture();
    const sandboxSafetyReceiptSha256 = sha("case-boundary-safety-failure");
    const abortPreparation = vi.fn(async () => ({
      cleanupProven: true,
      cleanupReceiptSha256: sha("case-boundary-cleanup"),
      sandboxSafetyFailure: true,
      sandboxSafetyReceiptSha256,
    }));
    const design = {
      ...value.design,
      preparedPair: [
        {
          ...value.design.preparedPair[0],
          infrastructure: {
            ...value.design.preparedPair[0].infrastructure,
            abortPreparation,
          },
        },
        value.design.preparedPair[1],
      ],
    } as unknown as M7R4FreshTwoCaseDesignV1;
    const plans = createM7R4FormalCasePlansV1({
      live: value.live,
      design,
      runSharedNoAgentPreflightOnce: async () => completed(value.freeze),
      now: () => "2026-08-16T01:00:00.000Z",
    });

    await expect(plans[0].abortPreparation()).resolves.toMatchObject({
      cleanupProven: true,
      sandboxSafetyFailure: true,
      sandboxSafetyReceiptSha256,
    });
    expect(abortPreparation).toHaveBeenCalledOnce();
  });

  it("projects informational safety evidence in the prepared campaign cleanup callback", async () => {
    const cleanupReceiptSha256 = sha("prepared-campaign-cleanup");
    const cleanup = vi.fn(async () => ({
      cleanupProven: true,
      cleanupReceiptSha256,
      sandboxSafetyFailure: false,
      sandboxSafetyReceiptSha256: sha(
        "prepared-campaign-informational-safety-summary",
      ),
    }));
    const cleanupRemainingAfterFailure =
      createM7R4ResidualCleanupCallbackV1(cleanup);

    await expect(cleanupRemainingAfterFailure()).resolves.toEqual({
      cleanupProven: true,
      cleanupReceiptSha256,
      sandboxSafetyFailure: false,
      sandboxSafetyReceiptSha256: null,
    });
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("rejects an assignment whose mutated source HEAD differs from the frozen mutant commit", () => {
    const mutationSha256 = sha("mutation");
    const evaluatorImplementationSha256 = sha("evaluator");
    const evaluatorBundleSha256 = sha("bundle");
    const mutatedSelectedTreeSha256 = sha("mutated-tree");
    const runtimeTaskSpecSha256 = sha("runtime-task");
    const materials = {
      slug: "case-01",
      manifest: {
        mutationSha256,
        evaluatorImplementationSha256,
        evaluatorBundleSha256,
        mutatedSelectedTreeSha256,
        runtimeTaskSpecSha256,
        mutantCommit: "a".repeat(40),
      },
    } as unknown as Parameters<
      typeof assertM7R4PhaseOneAssignmentMatchesV1
    >[0]["materials"];
    const assignment = {
      assignment: {
        mutationSha256,
        evaluatorImplementationSha256,
        evaluatorBundleSha256,
        mutatedBaselineSelectedTreeSha256: mutatedSelectedTreeSha256,
      },
      agentProjection: { publicTask: { sha256: runtimeTaskSpecSha256 } },
      mutatedSource: { headCommit: "b".repeat(40) },
    } as unknown as Parameters<
      typeof assertM7R4PhaseOneAssignmentMatchesV1
    >[0]["assignment"];

    expect(() =>
      assertM7R4PhaseOneAssignmentMatchesV1({ assignment, materials }),
    ).toThrow("phase-one assignment crossed bytes");
  });

  it("does not claim complete phase-one cleanup when only one case was prepared", () => {
    expect(
      summarizeM7R4PhaseOneCleanupV1([
        {
          cleanupProven: true,
          cleanupReceiptSha256: sha("case-1-cleanup"),
          sandboxSafetyFailure: false,
          sandboxSafetyReceiptSha256: null,
        },
      ]),
    ).toEqual({
      cleanupProven: false,
      cleanupReceiptSha256: null,
      sandboxSafetyFailure: false,
      sandboxSafetyReceiptSha256: null,
    });
  });

  it("retains registration-mismatch infrastructure before cleanup and preserves its safety truth", async () => {
    const value = fixture();
    const attemptStore = await openAttemptStore();
    const hostModelRuntimeConfigSha256 = sha("host-model");
    const pristineAdapterConformanceReceiptSha256 = sha("adapter-conformance");
    const cleanupReceiptSha256 = sha("registration-cleanup");
    const sandboxSafetyReceiptSha256 = sha("registration-safety");
    const cleanup = vi.fn(async () => ({
      cleanupProven: true,
      cleanupReceiptSha256,
      sandboxSafetyFailure: true,
      sandboxSafetyReceiptSha256,
    }));
    const materials = {
      ordinal: 1,
      slug: "case-01",
      manifest: {
        mutatedSelectedTreeSha256: sha("expected-tree"),
        runtimeTaskSpecSha256: sha("runtime-task"),
        codeOnlyTaskSpecSha256: sha("code-only-task"),
      },
    } as unknown as M7R4PreparedCasePhaseOneV1["materials"];
    const candidate = {
      materials,
      infrastructure: {
        registrationInputs: {
          baselineSelectedTreeSha256: sha("substituted-tree"),
          runtimeArmPublicTaskSpecSha256:
            materials.manifest.runtimeTaskSpecSha256,
          codeOnlyArmPublicTaskSpecSha256:
            materials.manifest.codeOnlyTaskSpecSha256,
          hostModelRuntimeConfigSha256,
          pristineAdapterConformanceReceiptSha256,
        },
        abortPreparation: cleanup,
      },
    } as unknown as M7R4PreparedCasePhaseOneV1;
    const live = {
      ...value.live,
      hostModelRuntimeConfigSha256,
      classifierFreeze: {
        authoritativeAdapter: {
          pristineConformanceReceiptSha256:
            pristineAdapterConformanceReceiptSha256,
        },
      },
    } as unknown as M7R4VerifiedLiveMaterialsV1;
    const persistedFailures: unknown[] = [];
    let retainedCountAtFailure = 0;
    const ports: M7R4FormalCompositionPortsV1 = {
      prepareFreshDesign: vi.fn(async () => {
        const prepared: M7R4PreparedCasePhaseOneV1[] = [];
        try {
          retainAndValidateM7R4PreparedPhaseOneV1({
            prepared,
            candidate,
            live,
          });
        } catch (error) {
          retainedCountAtFailure = prepared.length;
          return failM7R4FreshDesignAfterCleanupV1({
            error,
            cleanup: async () =>
              summarizeM7R4PhaseOneCleanupV1(
                await Promise.all(
                  prepared.map((entry) =>
                    entry.infrastructure.abortPreparation(),
                  ),
                ),
              ),
          });
        }
        throw new Error("registration mismatch was not rejected");
      }),
      runNoAgentPreflightForDesign: vi.fn(async () => {
        throw new Error("unreachable no-Agent preflight");
      }),
      runPortfolio: vi.fn(async () => {
        throw new Error("unreachable portfolio coordinator");
      }),
    };

    await expect(
      runM7R4FormalLiveV1(
        {
          live,
          preflightAttemptStore: attemptStore,
          persistOuterFailureOnce: async (receiptValue) => {
            persistedFailures.push(receiptValue);
            return receiptValue.recordContentSha256;
          },
          now: () => "2026-08-16T01:00:00.000Z",
        },
        ports,
      ),
    ).rejects.toThrow("R4 formal composition failed");

    expect(retainedCountAtFailure).toBe(1);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(persistedFailures[0]).toMatchObject({
      stage: "materialize_design",
      cleanupProven: false,
      cleanupReceiptSha256: null,
      sandboxSafetyFailure: true,
    });
    expect(
      (persistedFailures[0] as { sandboxSafetyReceiptSha256?: unknown })
        .sandboxSafetyReceiptSha256,
    ).not.toBeNull();
  });

  it("publishes one portfolio, retains one shared preflight, and presents cases in fixed order", async () => {
    const value = fixture();
    const attemptStore = await openAttemptStore();
    const events: string[] = [];
    const runNoAgent = vi.fn(async () => {
      events.push("shared-preflight");
      return completed(value.freeze);
    });
    const ports: M7R4FormalCompositionPortsV1 = {
      prepareFreshDesign: vi.fn(async () => value.design),
      runNoAgentPreflightForDesign: runNoAgent,
      runPortfolio: vi.fn(
        async (
          request: Parameters<M7R4FormalCompositionPortsV1["runPortfolio"]>[0],
        ) => {
          expect(request.cases.map((entry) => entry.ordinal)).toEqual([1, 2]);
          events.push("portfolio-create");
          const persisted = await request.portfolioStore.createPortfolioOnce(
            request.portfolioFreezeInput,
          );
          for (const index of [0, 1] as const) {
            events.push(`case-${index + 1}-preflight`);
            await request.cases[index].runAndPersistPreflightOnce({
              portfolioFreeze: persisted,
              constructionReceipt: value.constructions[index],
              trajectoryClassifierFreeze: value.live.classifierFreeze,
            });
          }
          for (const index of [0, 1] as const) {
            events.push(`case-${index + 1}-campaign`);
          }
          return portfolioResult(persisted);
        },
      ),
    };

    const result = await runM7R4FormalLiveV1(
      {
        live: value.live,
        preflightAttemptStore: attemptStore,
        persistOuterFailureOnce: vi.fn(),
        now: () => "2026-08-16T01:00:00.000Z",
      },
      ports,
    );

    expect(value.createPortfolioOnce).toHaveBeenCalledOnce();
    expect(runNoAgent).toHaveBeenCalledOnce();
    expect(value.cleanup).toHaveBeenCalledOnce();
    expect(result.preflightTerminal.status).toBe("passed");
    expect(events).toEqual([
      "portfolio-create",
      "case-1-preflight",
      "shared-preflight",
      "case-2-preflight",
      "case-1-campaign",
      "case-2-campaign",
    ]);
  });

  it("cleans the materialized design and retains a sanitized outer failure", async () => {
    const value = fixture();
    const attemptStore = await openAttemptStore();
    const persistedFailures: unknown[] = [];
    const ports: M7R4FormalCompositionPortsV1 = {
      prepareFreshDesign: vi.fn(async () => value.design),
      runNoAgentPreflightForDesign: vi.fn(async () => completed(value.freeze)),
      runPortfolio: vi.fn(
        async (
          request: Parameters<M7R4FormalCompositionPortsV1["runPortfolio"]>[0],
        ) => {
          const persisted = await request.portfolioStore.createPortfolioOnce(
            request.portfolioFreezeInput,
          );
          await request.cases[0].runAndPersistPreflightOnce({
            portfolioFreeze: persisted,
            constructionReceipt: value.constructions[0],
            trajectoryClassifierFreeze: value.live.classifierFreeze,
          });
          throw new Error("private /host/path must not be retained");
        },
      ),
    };

    await expect(
      runM7R4FormalLiveV1(
        {
          live: value.live,
          preflightAttemptStore: attemptStore,
          persistOuterFailureOnce: async (receiptValue) => {
            persistedFailures.push(receiptValue);
            return receiptValue.recordContentSha256;
          },
          now: () => "2026-08-16T01:00:00.000Z",
        },
        ports,
      ),
    ).rejects.toThrow("R4 formal composition failed");

    expect(value.cleanup).toHaveBeenCalledOnce();
    expect(persistedFailures).toHaveLength(1);
    expect(persistedFailures[0]).toMatchObject({
      stage: "portfolio_campaign",
      cleanupProven: true,
    });
    expect(JSON.stringify(persistedFailures[0])).not.toContain("/host/path");
  });

  it("retains incomplete cleanup truth when materialization fails before returning a design", async () => {
    const value = fixture();
    const attemptStore = await openAttemptStore();
    const cleanup = vi.fn(async () => ({
      cleanupProven: false,
      cleanupReceiptSha256: null,
      sandboxSafetyFailure: false,
      sandboxSafetyReceiptSha256: null,
    }));
    const persistedFailures: unknown[] = [];

    await expect(
      runM7R4FormalLiveV1(
        {
          live: value.live,
          preflightAttemptStore: attemptStore,
          persistOuterFailureOnce: async (receiptValue) => {
            persistedFailures.push(receiptValue);
            return receiptValue.recordContentSha256;
          },
          now: () => "2026-08-16T01:00:00.000Z",
        },
        materializationFailurePorts(cleanup),
      ),
    ).rejects.toThrow("R4 formal composition failed");

    expect(cleanup).toHaveBeenCalledOnce();
    expect(persistedFailures).toHaveLength(1);
    expect(persistedFailures[0]).toMatchObject({
      stage: "materialize_design",
      cleanupProven: false,
      cleanupReceiptSha256: null,
      sandboxSafetyFailure: false,
      sandboxSafetyReceiptSha256: null,
    });
  });

  it("retains materialization cleanup sandbox-safety truth", async () => {
    const value = fixture();
    const attemptStore = await openAttemptStore();
    const cleanupReceiptSha256 = sha("partial-cleanup-proof");
    const sandboxSafetyReceiptSha256 = sha("sandbox-safety-failure");
    const cleanup = vi.fn(async () => ({
      cleanupProven: true,
      cleanupReceiptSha256,
      sandboxSafetyFailure: true,
      sandboxSafetyReceiptSha256,
    }));
    const persistedFailures: unknown[] = [];

    await expect(
      runM7R4FormalLiveV1(
        {
          live: value.live,
          preflightAttemptStore: attemptStore,
          persistOuterFailureOnce: async (receiptValue) => {
            persistedFailures.push(receiptValue);
            return receiptValue.recordContentSha256;
          },
          now: () => "2026-08-16T01:00:00.000Z",
        },
        materializationFailurePorts(cleanup),
      ),
    ).rejects.toThrow("R4 formal composition failed");

    expect(cleanup).toHaveBeenCalledOnce();
    expect(persistedFailures).toHaveLength(1);
    expect(persistedFailures[0]).toMatchObject({
      stage: "materialize_design",
      cleanupProven: true,
      cleanupReceiptSha256,
      sandboxSafetyFailure: true,
      sandboxSafetyReceiptSha256,
    });
  });

  it("strictly rejects raw prose added to the outer failure receipt", () => {
    expect(() =>
      M7R4FormalOuterFailureReceiptV1Schema.parse({
        schemaVersion: 1,
        recordKind: "m7-r4-formal-outer-infrastructure-failure",
        stage: "portfolio_campaign",
        portfolioId: portfolio().portfolioId,
        errorClassSha256: sha("Error"),
        cleanupProven: false,
        cleanupReceiptSha256: null,
        sandboxSafetyFailure: false,
        sandboxSafetyReceiptSha256: null,
        observedAt: "2026-08-16T01:00:00.000Z",
        recordContentSha256: sha("not-relevant-before-strict-rejection"),
        message: "secret /host/private/path",
      }),
    ).toThrow();
  });
});
