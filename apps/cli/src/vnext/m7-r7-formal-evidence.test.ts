import { createHash } from "node:crypto";
import {
  link,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  JsonValueSchema,
  asSha256DigestV1,
  asSourceId,
} from "@chronorift/domain";
import { canonicalJson } from "@chronorift/json-artifacts";
import { afterEach, describe, expect, it } from "vitest";

import {
  M7R3PortfolioCaseReferenceV1Schema,
  M7R3TwoCasePortfolioSummaryV1Schema,
  createM7R3TwoCasePortfolioFreezeV1,
} from "./m7-r3-two-case-portfolio.js";
import { M7R7EvaluatorHeadroomEvidenceV1Schema } from "./m7-r7-preflight-evidence.js";
import {
  collectM7R7FormalEvidenceManifestV1,
  collectM7R7IncompleteFormalEvidenceManifestV1,
  deriveM7R7FormalDispositionV1,
  m7R7AgentTransportObservationIsCompleteV1,
  M7R7FormalEvidenceManifestV1Schema,
  persistM7R7FormalEvidenceManifestOnceV1,
} from "./m7-r7-formal-evidence.js";
import {
  SANDBOX_TASK_STORAGE_MINIMUM_HEADROOM_BYTES_V1,
  SANDBOX_TASK_STORAGE_MINIMUM_HEADROOM_INODES_V1,
} from "./sandbox-preflight.js";

const roots: string[] = [];
const hash = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");
const digestJson = (value: unknown): string =>
  hash(canonicalJson(JsonValueSchema.parse(value)));
const sha = (value: string) => asSha256DigestV1(hash(value));
const transportObservation = (requestStartedCount = 1) => {
  const basis = {
    schemaVersion: 1 as const,
    recordKind: "vnext-pi-host-http-transport-observation" as const,
    requestStartedCount,
    responseHeadersCount: requestStartedCount,
    responseCompleteCount: requestStartedCount,
    requestErrorCount: 0,
  };
  return { ...basis, recordContentSha256: hash(JSON.stringify(basis)) };
};
const outerFailureReceipt = () => {
  const basis = {
    schemaVersion: 1 as const,
    recordKind: "m7-r4-formal-outer-infrastructure-failure" as const,
    stage: "materialize_design" as const,
    portfolioId: null,
    errorClassSha256: sha("outer-error-class"),
    cleanupProven: false,
    cleanupReceiptSha256: null,
    sandboxSafetyFailure: false,
    sandboxSafetyReceiptSha256: null,
    observedAt: "2026-08-16T00:00:00.000Z",
  };
  return { ...basis, recordContentSha256: digestJson(basis) };
};

const caseEvidence = (
  ordinal: 1 | 2,
  outcome: "claim_supported" | "infrastructure_failure" = "claim_supported",
) => ({
  schemaVersion: 1 as const,
  ordinal,
  caseId: `case-${ordinal}`,
  caseReferenceRecordSha256: hash(`reference-${ordinal}`),
  disposition: "campaign_terminal" as const,
  campaignId: `campaign-${ordinal}`,
  campaignInfrastructureReceiptSha256: null,
  campaignTerminalRecordSha256: hash(`terminal-${ordinal}`),
  campaignOutcome: outcome,
  campaignReason:
    outcome === "infrastructure_failure"
      ? ("arm_infrastructure_failed" as const)
      : ("runtime_advantage_observed" as const),
});

const sourceIdentitySha = (sourceId: string, sourceHash: string) =>
  sha(
    canonicalJson(
      JsonValueSchema.parse({ schemaVersion: 1, sourceId, sourceHash }),
    ),
  );

const portfolioCaseInput = (ordinal: 1 | 2) => {
  const marker = String(ordinal);
  const sourceId = asSourceId(`source:${marker.repeat(64)}`);
  const sourceHash = sha(`mutated-build-${marker}`);
  const trajectoryCaseSpecSha256 = sha(`trajectory-case-spec-${marker}`);
  return {
    subject: {
      subjectProjectSha256: sha("subject-project"),
      pristineProjectRevision: "3e793f53598a131c53fb82555191cc14b8db07ff",
      pristineSelectedTreeSha256: sha("pristine-tree"),
    },
    mutant: {
      mutationSha256: sha(`mutation-${marker}`),
      mutatedBuildSourceId: sourceId,
      mutatedBuildSourceSha256: sourceHash,
      mutatedBaselineSelectedTreeSha256: sha(`mutant-tree-${marker}`),
      mutatedBuildSourceIdentitySha256: sourceIdentitySha(sourceId, sourceHash),
    },
    naturalPromptUtf8Sha256: sha(`prompt-${marker}`),
    trajectoryCaseSpecId:
      `m7-r3-trajectory-case:${trajectoryCaseSpecSha256.slice(0, 24)}` as const,
    trajectoryCaseSpecSha256,
    adapterMutantCompatibilityReceiptSha256: sha(
      `adapter-compatibility-${marker}`,
    ),
    pairedPublicTaskContractSha256: sha(`paired-contract-${marker}`),
    preflightImplementationSha256: sha(`preflight-${marker}`),
    evaluatorImplementationSha256: sha(`evaluator-${marker}`),
    evaluatorBundleSha256: sha(`evaluator-bundle-${marker}`),
  };
};

const frozenPortfolio = () =>
  createM7R3TwoCasePortfolioFreezeV1({
    commonRuntimeMaterials: {
      authoritativeSensorFreezeRecordSha256: sha("sensor"),
      adapterRevisionSha256: sha("adapter-revision"),
      adapterPackageSha256: sha("adapter-package"),
      adapterObservationSchemaSha256: sha("adapter-schema"),
      trajectoryClassifierFreezeRecordSha256: sha("classifier-freeze"),
      trajectoryClassifierImplementationSha256: sha(
        "classifier-implementation",
      ),
      trajectoryClassifierConfigSha256: sha("classifier-config"),
      validatedGameToolSetSha256: sha("game-tools"),
      pristineAdapterConformanceReceiptSha256: sha("adapter-conformance"),
      commonEnvironmentInstructionsSha256: sha("environment-instructions"),
      hostModelRuntimeConfigSha256: sha("model-runtime-config"),
    },
    agentConfiguration: {
      provider: "test-provider",
      model: "test-model",
      thinkingLevel: "max",
      agentBudgetSha256: sha("agent-budget"),
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
    cases: [portfolioCaseInput(1), portfolioCaseInput(2)],
    frozenAt: "2026-08-16T00:00:00.000Z",
  });

const safetyStopReference = (
  portfolio: ReturnType<typeof frozenPortfolio>,
  ordinal: 1 | 2,
) => {
  const basis = {
    schemaVersion: 1 as const,
    recordKind: "m7-r3-portfolio-case-reference" as const,
    portfolioId: portfolio.portfolioId,
    portfolioFreezeRecordSha256: portfolio.recordContentSha256,
    caseOrdinal: ordinal,
    caseId: portfolio.cases[ordinal - 1]!.caseId,
    disposition: "not_started_safety_stop" as const,
    constructionReceiptSha256: null,
    preflightReceiptSha256: null,
    campaignInfrastructureReceiptSha256: null,
    campaignId: null,
    caseCampaignAdmissionRecordSha256: null,
    mutationRegistrationRecordSha256: null,
    campaignTerminalRecordSha256: null,
    runtimeEnabledResultRecordSha256: null,
    codeOnlyResultRecordSha256: null,
    agentDeliveryTraceRecordSha256: null,
    trajectoryUseEvidenceRecordSha256: null,
    recordedAt: `2026-08-16T0${ordinal}:00:00.000Z`,
  };
  return M7R3PortfolioCaseReferenceV1Schema.parse({
    ...basis,
    recordContentSha256: digestJson(basis),
  });
};

const localPortfolio = () => {
  const portfolioFreeze = frozenPortfolio();
  const caseReferences = [
    safetyStopReference(portfolioFreeze, 1),
    safetyStopReference(portfolioFreeze, 2),
  ] as const;
  const summaryCase = (reference: (typeof caseReferences)[number]) => ({
    caseOrdinal: reference.caseOrdinal,
    caseId: reference.caseId,
    caseReferenceRecordSha256: reference.recordContentSha256,
    disposition: reference.disposition,
    constructionReceiptSha256: null,
    preflightReceiptSha256: null,
    campaignInfrastructureReceiptSha256: null,
    campaignId: null,
    caseCampaignAdmissionRecordSha256: null,
    mutationRegistrationRecordSha256: null,
    campaignTerminalRecordSha256: null,
    runtimeEnabledResultRecordSha256: null,
    codeOnlyResultRecordSha256: null,
    agentDeliveryTraceRecordSha256: null,
    trajectoryUseEvidenceRecordSha256: null,
  });
  const summaryCases = [
    summaryCase(caseReferences[0]),
    summaryCase(caseReferences[1]),
  ] as const;
  const summaryBasis = {
    schemaVersion: 1 as const,
    recordKind: "m7-r3-two-case-portfolio-summary" as const,
    portfolioId: portfolioFreeze.portfolioId,
    portfolioFreezeRecordSha256: portfolioFreeze.recordContentSha256,
    denominatorCaseCount: 2 as const,
    recordedCaseCount: 2 as const,
    cases: summaryCases,
    summarizedAt: "2026-08-16T03:00:00.000Z",
  };
  const summary = M7R3TwoCasePortfolioSummaryV1Schema.parse({
    ...summaryBasis,
    recordContentSha256: digestJson(summaryBasis),
  });
  return {
    portfolioFreeze,
    caseReferences,
    safetyStop: null,
    summary,
  };
};

const collectorRoots = async () => {
  const root = await mkdtemp(join(tmpdir(), "m7-r7-formal-collector-"));
  roots.push(root);
  const runsRoot = join(root, "runs");
  const constructionRoot = join(root, "construction");
  for (const path of [
    runsRoot,
    constructionRoot,
    join(runsRoot, "assignments"),
    join(runsRoot, "assignments", "case-01"),
    join(runsRoot, "assignments", "case-02"),
    join(runsRoot, "portfolio"),
    join(runsRoot, "campaigns"),
    join(runsRoot, "evidence"),
    join(runsRoot, "durable"),
    join(runsRoot, "preflight-evidence"),
    join(runsRoot, "preflight-evidence", "case-01"),
    join(runsRoot, "preflight-evidence", "case-02"),
    join(runsRoot, "agent-resources"),
    join(runsRoot, "patches"),
    join(runsRoot, "operational-config"),
    join(runsRoot, "run-control"),
    join(runsRoot, "run-control", "formal-preflight-attempt"),
  ]) {
    await mkdir(path, { mode: 0o700 });
  }
  return { root, runsRoot, constructionRoot };
};

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("M7 R7 formal evidence", () => {
  it("separates a sealed process from infrastructure and incomplete outcomes", () => {
    const completedCases = [caseEvidence(1), caseEvidence(2)] as const;
    expect(
      deriveM7R7FormalDispositionV1({
        cases: completedCases,
        requiredRecordGaps: [],
      }),
    ).toBe("campaigns_completed");
    expect(
      deriveM7R7FormalDispositionV1({
        cases: [caseEvidence(1, "infrastructure_failure"), caseEvidence(2)],
        requiredRecordGaps: [],
      }),
    ).toBe("infrastructure_failure");
    expect(
      deriveM7R7FormalDispositionV1({
        cases: completedCases,
        requiredRecordGaps: ["runs/evidence/missing.json"],
      }),
    ).toBe("incomplete");
  });

  it("requires a strict Host HTTP observation exactly when an Agent entered Pi", () => {
    const observation = transportObservation();
    expect(
      m7R7AgentTransportObservationIsCompleteV1({
        result: { hostHttpTransportObservation: observation },
        attemptEvidence: { piTurnStarted: true },
        failureReceipt: null,
      }),
    ).toBe(true);
    expect(
      m7R7AgentTransportObservationIsCompleteV1({
        result: { hostHttpTransportObservation: null },
        attemptEvidence: { piTurnStarted: true },
        failureReceipt: null,
      }),
    ).toBe(false);
    expect(
      m7R7AgentTransportObservationIsCompleteV1({
        result: {
          hostHttpTransportObservation: transportObservation(0),
        },
        attemptEvidence: { piTurnStarted: true },
        failureReceipt: null,
      }),
    ).toBe(false);
    expect(
      m7R7AgentTransportObservationIsCompleteV1({
        result: null,
        attemptEvidence: { piTurnStarted: false },
        failureReceipt: {
          lifecycle: [{ stage: "sdk_call_started" }],
          hostHttpTransportObservation: null,
        },
      }),
    ).toBe(false);
    expect(
      m7R7AgentTransportObservationIsCompleteV1({
        result: null,
        attemptEvidence: { piTurnStarted: false },
        failureReceipt: {
          lifecycle: [],
          hostHttpTransportObservation: null,
        },
      }),
    ).toBe(true);
    expect(
      m7R7AgentTransportObservationIsCompleteV1({
        result: {
          hostHttpTransportObservation: {
            ...observation,
            responseHeadersCount: observation.responseHeadersCount + 1,
          },
        },
        attemptEvidence: { piTurnStarted: true },
        failureReceipt: null,
      }),
    ).toBe(false);
  });

  it("persists the exact manifest once and syncs a private control root", async () => {
    const root = await mkdtemp(join(tmpdir(), "m7-r7-formal-evidence-"));
    roots.push(root);
    const controlRoot = join(root, "control");
    await mkdir(controlRoot, { mode: 0o700 });
    const basis = {
      schemaVersion: 1 as const,
      recordKind: "m7-r7-formal-evidence-manifest" as const,
      portfolioId: "portfolio:test",
      portfolioFreezeRecordSha256: hash("portfolio"),
      portfolioSummaryRecordSha256: hash("summary"),
      preflightTerminalRecordSha256: hash("preflight"),
      outerFailureRecordSha256: null,
      formalDisposition: "infrastructure_failure" as const,
      cases: [
        caseEvidence(1, "infrastructure_failure"),
        caseEvidence(2, "infrastructure_failure"),
      ] as const,
      records: [
        {
          schemaVersion: 1 as const,
          scope: "portfolio" as const,
          relativePath: "runs/portfolio/m7-r3.portfolio-summary.json",
          byteLength: 42,
          fileSha256: hash("file"),
          recordKind: "m7-r3-two-case-portfolio-summary",
          recordContentSha256: hash("content"),
        },
      ],
      requiredRecordGaps: [],
      sealedAt: "2026-08-16T00:00:00.000Z",
    };
    const manifest = M7R7FormalEvidenceManifestV1Schema.parse({
      ...basis,
      recordContentSha256: digestJson(basis),
    });
    await expect(
      persistM7R7FormalEvidenceManifestOnceV1({ controlRoot, manifest }),
    ).resolves.toEqual(manifest);
    const path = join(controlRoot, "formal-evidence-manifest.v1.json");
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(manifest);
    expect((await stat(path)).mode & 0o7777).toBe(0o600);
    await expect(
      persistM7R7FormalEvidenceManifestOnceV1({ controlRoot, manifest }),
    ).rejects.toThrow(/create-once/u);
  });

  it("rejects a completed disposition with a missing evidence record", () => {
    const basis = {
      schemaVersion: 1 as const,
      recordKind: "m7-r7-formal-evidence-manifest" as const,
      portfolioId: "portfolio:test",
      portfolioFreezeRecordSha256: hash("portfolio"),
      portfolioSummaryRecordSha256: hash("summary"),
      preflightTerminalRecordSha256: hash("preflight"),
      outerFailureRecordSha256: null,
      formalDisposition: "campaigns_completed" as const,
      cases: [caseEvidence(1), caseEvidence(2)] as const,
      records: [
        {
          schemaVersion: 1 as const,
          scope: "portfolio" as const,
          relativePath: "runs/portfolio/m7-r3.portfolio-summary.json",
          byteLength: 42,
          fileSha256: hash("file"),
          recordKind: "m7-r3-two-case-portfolio-summary",
          recordContentSha256: hash("content"),
        },
      ],
      requiredRecordGaps: ["runs/evidence/missing.json"],
      sealedAt: "2026-08-16T00:00:00.000Z",
    };
    expect(() =>
      M7R7FormalEvidenceManifestV1Schema.parse({
        ...basis,
        recordContentSha256: digestJson(basis),
      }),
    ).toThrow(/campaigns_completed/u);
  });

  it("does not let an outer or credential failure rewrite completed evidence", () => {
    const basis = {
      schemaVersion: 1 as const,
      recordKind: "m7-r7-formal-evidence-manifest" as const,
      portfolioId: "portfolio:test",
      portfolioFreezeRecordSha256: hash("portfolio"),
      portfolioSummaryRecordSha256: hash("summary"),
      preflightTerminalRecordSha256: hash("preflight"),
      outerFailureRecordSha256: hash("outer-failure"),
      formalDisposition: "infrastructure_failure" as const,
      cases: [
        caseEvidence(1, "infrastructure_failure"),
        caseEvidence(2, "infrastructure_failure"),
      ] as const,
      records: [],
      requiredRecordGaps: [],
      sealedAt: "2026-08-16T00:00:00.000Z",
    };
    expect(() =>
      M7R7FormalEvidenceManifestV1Schema.parse({
        ...basis,
        recordContentSha256: digestJson(basis),
      }),
    ).toThrow(/cannot rewrite/u);
  });

  it("keeps opaque and below-bound preflight files as explicit gaps", async () => {
    const { runsRoot, constructionRoot } = await collectorRoots();
    const portfolio = localPortfolio();
    const publicPath = join(
      runsRoot,
      "preflight-evidence",
      "case-01",
      "public-pristine.json",
    );
    await writeFile(
      publicPath,
      `${canonicalJson(
        JsonValueSchema.parse({
          schemaVersion: 1,
          recordKind: "opaque-record-at-required-path",
        }),
      )}\n`,
      { mode: 0o600 },
    );
    const headroomBasis = {
      schemaVersion: 1 as const,
      recordKind: "m7-r7-evaluator-headroom-evidence" as const,
      caseOrdinal: 1 as const,
      caseId: portfolio.portfolioFreeze.cases[0].caseId,
      taskId: "task:m7-r4:no-agent-evaluator:case-01",
      boundary: "no_agent_hidden_evaluator" as const,
      runOrdinal: 1,
      taskStorage: {
        schemaVersion: 1 as const,
        availableBytes: 0,
        availableInodes: 0,
        requiredAvailableBytes: SANDBOX_TASK_STORAGE_MINIMUM_HEADROOM_BYTES_V1,
        requiredAvailableInodes:
          SANDBOX_TASK_STORAGE_MINIMUM_HEADROOM_INODES_V1,
      },
      evaluatorStorage: {
        schemaVersion: 1 as const,
        availableBytes: 0,
        availableInodes: 0,
        requiredAvailableBytes: SANDBOX_TASK_STORAGE_MINIMUM_HEADROOM_BYTES_V1,
        requiredAvailableInodes:
          SANDBOX_TASK_STORAGE_MINIMUM_HEADROOM_INODES_V1,
      },
      observedAt: "2026-08-16T00:00:00.000Z",
    };
    const headroom = M7R7EvaluatorHeadroomEvidenceV1Schema.parse({
      ...headroomBasis,
      recordContentSha256: digestJson(headroomBasis),
    });
    const headroomPath = join(
      runsRoot,
      "preflight-evidence",
      "case-01",
      "evaluator-headroom-000001.json",
    );
    await writeFile(
      headroomPath,
      `${canonicalJson(JsonValueSchema.parse(headroom))}\n`,
      { mode: 0o600 },
    );

    const manifest = await collectM7R7FormalEvidenceManifestV1({
      runsRoot,
      constructionRoot,
      portfolio,
      preflightTerminalRecordSha256: hash("preflight-terminal"),
      sealedAt: "2026-08-16T00:00:00.000Z",
    });
    expect(manifest.formalDisposition).toBe("incomplete");
    expect(manifest.requiredRecordGaps).toContain(
      "runs/preflight-evidence/case-01/public-pristine.json",
    );
    expect(manifest.requiredRecordGaps).toContain(
      "runs/preflight-evidence/case-01/evaluator-headroom-000001.json",
    );
    for (const path of [
      "construction/m7-r3.case-01-construction.json",
      "construction/m7-r3.case-02-construction.json",
      "construction/m7-r3.case-01-preflight.json",
      "construction/m7-r3.case-02-preflight.json",
    ]) {
      expect(manifest.requiredRecordGaps).toContain(path);
    }
    expect(
      manifest.records.find(
        (record) =>
          record.relativePath ===
          "runs/preflight-evidence/case-01/public-pristine.json",
      ),
    ).toMatchObject({ recordKind: "opaque-record-at-required-path" });
  });

  it("repairs every declared post-link SIGKILL window before collecting", async () => {
    const { runsRoot, constructionRoot } = await collectorRoots();
    const campaignRoot = join(runsRoot, "campaigns", "case-01");
    const assignmentRoot = join(runsRoot, "assignments", "case-01");
    const assignmentMaterialRoot = join(assignmentRoot, "materials");
    const patchRoot = join(runsRoot, "patches", "case-01", "code-only");
    await mkdir(campaignRoot, { mode: 0o700 });
    await mkdir(assignmentMaterialRoot, { mode: 0o700 });
    await mkdir(patchRoot, { recursive: true, mode: 0o700 });
    const interrupted = [
      {
        root: campaignRoot,
        filename: "m7.terminal.json",
        value: {
          schemaVersion: 1,
          recordKind: "opaque-interrupted-campaign-publication",
        },
      },
      {
        root: assignmentRoot,
        filename: "assignment.json",
        value: {
          schemaVersion: 1,
          recordKind: "opaque-interrupted-assignment-publication",
        },
      },
      {
        root: join(runsRoot, "operational-config"),
        filename: "case-01.runtime.json",
        value: {
          schemaVersion: 1,
          recordKind: "opaque-interrupted-config-publication",
        },
      },
      {
        root: join(runsRoot, "run-control"),
        filename: "m7-r4.formal-outer-failure.json",
        value: outerFailureReceipt(),
      },
    ] as const;
    const paths: Array<{ finalPath: string; temporaryPath: string }> = [];
    for (const publication of interrupted) {
      const finalPath = join(publication.root, publication.filename);
      const temporaryPath = join(
        publication.root,
        `.${publication.filename}.tmp-0123456789abcdef0123456789abcdef`,
      );
      await writeFile(
        finalPath,
        `${canonicalJson(JsonValueSchema.parse(publication.value))}\n`,
        { mode: 0o600 },
      );
      await link(finalPath, temporaryPath);
      expect((await stat(finalPath)).nlink).toBe(2);
      paths.push({ finalPath, temporaryPath });
    }
    const rawPatch = Buffer.from(
      "diff --git a/a.gd b/a.gd\n--- a/a.gd\n+++ b/a.gd\n@@ -1 +1 @@\n-old\n+new\n",
      "utf8",
    );
    const patchFilename = `${hash(rawPatch)}.patch`;
    const patchFinalPath = join(patchRoot, patchFilename);
    const patchTemporaryPath = join(
      patchRoot,
      `.${patchFilename}.tmp-0123456789abcdef0123456789abcdef`,
    );
    await writeFile(patchFinalPath, rawPatch, { mode: 0o600 });
    await link(patchFinalPath, patchTemporaryPath);
    expect((await stat(patchFinalPath)).nlink).toBe(2);
    paths.push({
      finalPath: patchFinalPath,
      temporaryPath: patchTemporaryPath,
    });
    const materialFinalPath = join(
      assignmentMaterialRoot,
      "immutable-material.json",
    );
    const materialTemporaryPath = join(
      assignmentMaterialRoot,
      ".immutable-material.json.tmp-fedcba9876543210fedcba9876543210",
    );
    await writeFile(
      materialFinalPath,
      `${canonicalJson(
        JsonValueSchema.parse({
          schemaVersion: 1,
          recordKind: "assignment-material-not-owned-by-recovery",
        }),
      )}\n`,
      { mode: 0o600 },
    );
    await link(materialFinalPath, materialTemporaryPath);
    const unrelatedControlFinalPath = join(
      runsRoot,
      "run-control",
      "formal-result.v1.json",
    );
    const unrelatedControlTemporaryPath = join(
      runsRoot,
      "run-control",
      ".formal-result.v1.json.tmp-fedcba9876543210fedcba9876543210",
    );
    await writeFile(
      unrelatedControlFinalPath,
      `${canonicalJson(
        JsonValueSchema.parse({
          schemaVersion: 1,
          recordKind: "formal-result-not-owned-by-recovery",
        }),
      )}\n`,
      { mode: 0o600 },
    );
    await link(unrelatedControlFinalPath, unrelatedControlTemporaryPath);

    const manifest = await collectM7R7IncompleteFormalEvidenceManifestV1({
      runsRoot,
      constructionRoot,
      reason: "interrupted",
      sealedAt: "2026-08-16T00:00:00.000Z",
    });
    for (const publication of paths) {
      expect((await stat(publication.finalPath)).nlink).toBe(1);
      await expect(lstat(publication.temporaryPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
    }
    expect((await stat(materialFinalPath)).nlink).toBe(2);
    expect((await stat(materialTemporaryPath)).nlink).toBe(2);
    expect((await stat(unrelatedControlFinalPath)).nlink).toBe(2);
    expect((await stat(unrelatedControlTemporaryPath)).nlink).toBe(2);
    expect(manifest.outerFailureRecordSha256).toBeNull();
    expect(manifest.requiredRecordGaps).toContain(
      "runs/run-control/m7-r4.formal-outer-failure.json",
    );
    expect(manifest.records).toContainEqual(
      expect.objectContaining({
        relativePath: "runs/campaigns/case-01/m7.terminal.json",
      }),
    );
  });

  it("does not repair an invalid outer-failure publication", async () => {
    const { runsRoot, constructionRoot } = await collectorRoots();
    const finalPath = join(
      runsRoot,
      "run-control",
      "m7-r4.formal-outer-failure.json",
    );
    const temporaryPath = join(
      runsRoot,
      "run-control",
      ".m7-r4.formal-outer-failure.json.tmp-0123456789abcdef0123456789abcdef",
    );
    await writeFile(
      finalPath,
      `${canonicalJson(
        JsonValueSchema.parse({
          schemaVersion: 1,
          recordKind: "opaque-not-an-outer-failure",
        }),
      )}\n`,
      { mode: 0o600 },
    );
    await link(finalPath, temporaryPath);

    await expect(
      collectM7R7IncompleteFormalEvidenceManifestV1({
        runsRoot,
        constructionRoot,
        reason: "interrupted",
        sealedAt: "2026-08-16T00:00:00.000Z",
      }),
    ).rejects.toThrow();
    expect((await stat(finalPath)).nlink).toBe(2);
    expect((await stat(temporaryPath)).nlink).toBe(2);
  });

  it("does not repair a raw patch whose filename digest is wrong", async () => {
    const { runsRoot, constructionRoot } = await collectorRoots();
    const patchRoot = join(runsRoot, "patches", "case-01", "runtime-enabled");
    await mkdir(patchRoot, { recursive: true, mode: 0o700 });
    const rawPatch = Buffer.from(
      "diff --git a/a.gd b/a.gd\n--- a/a.gd\n+++ b/a.gd\n@@ -1 +1 @@\n-old\n+new\n",
      "utf8",
    );
    const filename = `${hash("not-the-retained-patch")}.patch`;
    const finalPath = join(patchRoot, filename);
    const temporaryPath = join(
      patchRoot,
      `.${filename}.tmp-0123456789abcdef0123456789abcdef`,
    );
    await writeFile(finalPath, rawPatch, { mode: 0o600 });
    await link(finalPath, temporaryPath);

    await expect(
      collectM7R7IncompleteFormalEvidenceManifestV1({
        runsRoot,
        constructionRoot,
        reason: "interrupted",
        sealedAt: "2026-08-16T00:00:00.000Z",
      }),
    ).rejects.toThrow(/filename hash changed/u);
    expect((await stat(finalPath)).nlink).toBe(2);
    expect((await stat(temporaryPath)).nlink).toBe(2);
  });

  it("binds only the exact normal outer-failure file declared by the caller", async () => {
    const { runsRoot, constructionRoot } = await collectorRoots();
    const receipt = outerFailureReceipt();
    const path = join(
      runsRoot,
      "run-control",
      "m7-r4.formal-outer-failure.json",
    );
    await writeFile(
      path,
      `${canonicalJson(JsonValueSchema.parse(receipt))}\n`,
      { mode: 0o600 },
    );

    const matching = await collectM7R7IncompleteFormalEvidenceManifestV1({
      runsRoot,
      constructionRoot,
      outerFailureRecordSha256: receipt.recordContentSha256,
      reason: "outer_infrastructure_failure",
      sealedAt: "2026-08-16T00:00:00.000Z",
    });
    expect(matching.outerFailureRecordSha256).toBe(receipt.recordContentSha256);
    expect(matching.requiredRecordGaps).not.toContain(
      "runs/run-control/m7-r4.formal-outer-failure.json",
    );
    expect(matching.records).toContainEqual(
      expect.objectContaining({
        relativePath: "runs/run-control/m7-r4.formal-outer-failure.json",
        recordContentSha256: receipt.recordContentSha256,
      }),
    );

    const mismatched = await collectM7R7IncompleteFormalEvidenceManifestV1({
      runsRoot,
      constructionRoot,
      outerFailureRecordSha256: sha("different-outer-failure"),
      reason: "outer_infrastructure_failure",
      sealedAt: "2026-08-16T00:00:01.000Z",
    });
    expect(mismatched.outerFailureRecordSha256).toBeNull();
    expect(mismatched.requiredRecordGaps).toContain(
      "runs/run-control/m7-r4.formal-outer-failure.json",
    );

    await writeFile(
      path,
      `${canonicalJson(
        JsonValueSchema.parse({
          schemaVersion: 1,
          recordKind: "opaque-normal-run-control-record",
          recordContentSha256: receipt.recordContentSha256,
        }),
      )}\n`,
      { mode: 0o600 },
    );
    const invalidSchema = await collectM7R7IncompleteFormalEvidenceManifestV1({
      runsRoot,
      constructionRoot,
      outerFailureRecordSha256: receipt.recordContentSha256,
      reason: "outer_infrastructure_failure",
      sealedAt: "2026-08-16T00:00:02.000Z",
    });
    expect(invalidSchema.outerFailureRecordSha256).toBeNull();
    expect(invalidSchema.requiredRecordGaps).toContain(
      "runs/run-control/m7-r4.formal-outer-failure.json",
    );
  });

  it("seals an explicit incomplete record before a portfolio exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "m7-r7-formal-incomplete-"));
    roots.push(root);
    const runsRoot = join(root, "runs");
    const constructionRoot = join(root, "construction");
    for (const path of [
      runsRoot,
      constructionRoot,
      join(runsRoot, "assignments"),
      join(runsRoot, "assignments", "case-01"),
      join(runsRoot, "assignments", "case-02"),
      join(runsRoot, "portfolio"),
      join(runsRoot, "campaigns"),
      join(runsRoot, "evidence"),
      join(runsRoot, "durable"),
      join(runsRoot, "agent-resources"),
      join(runsRoot, "patches"),
      join(runsRoot, "operational-config"),
      join(runsRoot, "run-control"),
      join(runsRoot, "run-control", "formal-preflight-attempt"),
    ]) {
      await mkdir(path, { mode: 0o700 });
    }
    const manifest = await collectM7R7IncompleteFormalEvidenceManifestV1({
      runsRoot,
      constructionRoot,
      reason: "interrupted",
      sealedAt: "2026-08-16T00:00:00.000Z",
    });
    expect(manifest).toMatchObject({
      formalDisposition: "incomplete",
      portfolioId: null,
      cases: [],
      requiredRecordGaps: ["interrupted"],
    });
  });
});
