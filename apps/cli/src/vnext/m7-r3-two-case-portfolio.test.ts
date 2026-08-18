import { createHash } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  JsonValueSchema,
  asSha256DigestV1,
  asSourceId,
  type Sha256DigestV1,
} from "@chronorift/domain";
import { canonicalJson } from "@chronorift/json-artifacts";
import { afterEach, describe, expect, it } from "vitest";

import {
  M7R3TwoCasePortfolioFreezeV1Schema,
  createM7R3TwoCasePortfolioFreezeV1,
  openM7R3TwoCasePortfolioStoreV1,
  type CreateM7R3TwoCasePortfolioFreezeV1Input,
  type M7R3TwoCasePortfolioFreezeV1,
  type M7R3TwoCasePortfolioStoreV1,
  type RecordM7R3PortfolioCaseOnceV1Input,
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

const temporaryRoots = new Set<string>();

afterEach(async () => {
  await Promise.all(
    [...temporaryRoots].map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
  temporaryRoots.clear();
});

const portfolioInput = (): CreateM7R3TwoCasePortfolioFreezeV1Input => ({
  commonRuntimeMaterials: {
    authoritativeSensorFreezeRecordSha256: sha(
      "sensor-freeze-before-mutations",
    ),
    adapterRevisionSha256: sha("pristine-adapter-revision"),
    adapterPackageSha256: sha("adapter-package"),
    adapterObservationSchemaSha256: sha("generic-patrol-observation-schema"),
    trajectoryClassifierFreezeRecordSha256: sha("trajectory-classifier-freeze"),
    trajectoryClassifierImplementationSha256: sha(
      "trajectory-classifier-implementation",
    ),
    trajectoryClassifierConfigSha256: sha("trajectory-classifier-config"),
    validatedGameToolSetSha256: sha("host-admitted-game-tools"),
    pristineAdapterConformanceReceiptSha256: sha(
      "pristine-adapter-conformance",
    ),
    commonEnvironmentInstructionsSha256: sha("common-environment-instructions"),
    hostModelRuntimeConfigSha256: sha("host-model-runtime-config"),
  },
  agentConfiguration: {
    provider: "test-provider",
    model: "test-model",
    thinkingLevel: "max",
    agentBudgetSha256: sha("one-turn-budget"),
    codingToolSetSha256: sha("shared-coding-tools"),
    sandboxPolicySha256: sha("shared-sandbox-policy"),
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
  cases: [
    {
      subject: {
        subjectProjectSha256: sha("external-godot-project"),
        pristineProjectRevision: "3e793f53598a131c53fb82555191cc14b8db07ff",
        pristineSelectedTreeSha256: sha("pristine-tree"),
      },
      mutant: {
        mutationSha256: sha("mutation-one"),
        mutatedBuildSourceId: asSourceId(`source:${"1".repeat(64)}`),
        mutatedBuildSourceSha256: sha("mutated-build-one"),
        mutatedBaselineSelectedTreeSha256: sha("mutated-tree-one"),
        mutatedBuildSourceIdentitySha256: sourceIdentitySha(
          `source:${"1".repeat(64)}`,
          sha("mutated-build-one"),
        ),
      },
      naturalPromptUtf8Sha256: sha("natural prompt one UTF-8 bytes"),
      trajectoryCaseSpecId: `m7-r3-trajectory-case:${sha("trajectory-case-spec-one").slice(0, 24)}`,
      trajectoryCaseSpecSha256: sha("trajectory-case-spec-one"),
      adapterMutantCompatibilityReceiptSha256: sha(
        "adapter-mutant-compatibility-one",
      ),
      pairedPublicTaskContractSha256: sha("paired-public-task-contract-one"),
      preflightImplementationSha256: sha("preflight-implementation-one"),
      evaluatorImplementationSha256: sha("evaluator-one"),
      evaluatorBundleSha256: sha("evaluator-bundle-one"),
    },
    {
      subject: {
        subjectProjectSha256: sha("external-godot-project"),
        pristineProjectRevision: "3e793f53598a131c53fb82555191cc14b8db07ff",
        pristineSelectedTreeSha256: sha("pristine-tree"),
      },
      mutant: {
        mutationSha256: sha("mutation-two"),
        mutatedBuildSourceId: asSourceId(`source:${"2".repeat(64)}`),
        mutatedBuildSourceSha256: sha("mutated-build-two"),
        mutatedBaselineSelectedTreeSha256: sha("mutated-tree-two"),
        mutatedBuildSourceIdentitySha256: sourceIdentitySha(
          `source:${"2".repeat(64)}`,
          sha("mutated-build-two"),
        ),
      },
      naturalPromptUtf8Sha256: sha("natural prompt two UTF-8 bytes"),
      trajectoryCaseSpecId: `m7-r3-trajectory-case:${sha("trajectory-case-spec-two").slice(0, 24)}`,
      trajectoryCaseSpecSha256: sha("trajectory-case-spec-two"),
      adapterMutantCompatibilityReceiptSha256: sha(
        "adapter-mutant-compatibility-two",
      ),
      pairedPublicTaskContractSha256: sha("paired-public-task-contract-two"),
      preflightImplementationSha256: sha("preflight-implementation-two"),
      evaluatorImplementationSha256: sha("evaluator-two"),
      evaluatorBundleSha256: sha("evaluator-bundle-two"),
    },
  ],
  frozenAt: "2026-08-16T00:00:00.000Z",
});

interface StoreFixture {
  readonly parent: string;
  readonly root: string;
  readonly exposed: string;
  readonly store: M7R3TwoCasePortfolioStoreV1;
}

const storeFixture = async (): Promise<StoreFixture> => {
  const parent = await mkdtemp(join(tmpdir(), "chronorift-m7-r3-portfolio-"));
  temporaryRoots.add(parent);
  const root = join(parent, "host-only");
  const exposed = join(parent, "agent-exposed");
  await Promise.all([
    mkdir(root, { mode: 0o700 }),
    mkdir(exposed, { mode: 0o700 }),
  ]);
  await Promise.all([chmod(root, 0o700), chmod(exposed, 0o700)]);
  return {
    parent,
    root,
    exposed,
    store: await openM7R3TwoCasePortfolioStoreV1({
      root,
      exposedRoots: [exposed],
    }),
  };
};

const commonReference = (
  freeze: M7R3TwoCasePortfolioFreezeV1,
  caseOrdinal: 1 | 2,
) => ({
  portfolioId: freeze.portfolioId,
  portfolioFreezeRecordSha256: freeze.recordContentSha256,
  caseOrdinal,
  caseId: freeze.cases[caseOrdinal - 1]!.caseId,
  recordedAt:
    caseOrdinal === 1 ? "2026-08-16T01:00:00.000Z" : "2026-08-16T02:00:00.000Z",
});

const constructionFailed = (
  freeze: M7R3TwoCasePortfolioFreezeV1,
  caseOrdinal: 1 | 2,
): RecordM7R3PortfolioCaseOnceV1Input => ({
  ...commonReference(freeze, caseOrdinal),
  disposition: "construction_failed",
  constructionReceiptSha256: sha(`construction-failure-${caseOrdinal}`),
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

const safetyStop = (
  freeze: M7R3TwoCasePortfolioFreezeV1,
): RecordM7R3PortfolioCaseOnceV1Input => ({
  ...commonReference(freeze, 2),
  disposition: "not_started_safety_stop",
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

const campaignTerminal = (
  freeze: M7R3TwoCasePortfolioFreezeV1,
  caseOrdinal: 1 | 2,
): RecordM7R3PortfolioCaseOnceV1Input => ({
  ...commonReference(freeze, caseOrdinal),
  disposition: "campaign_terminal",
  constructionReceiptSha256: null,
  preflightReceiptSha256: null,
  campaignInfrastructureReceiptSha256: null,
  campaignId: `m7-campaign:${caseOrdinal.toString().repeat(24)}`,
  caseCampaignAdmissionRecordSha256: sha(`case-admission-${caseOrdinal}`),
  mutationRegistrationRecordSha256: sha(`mutation-registration-${caseOrdinal}`),
  campaignTerminalRecordSha256: sha(`terminal-${caseOrdinal}`),
  runtimeEnabledResultRecordSha256: sha(`runtime-result-${caseOrdinal}`),
  codeOnlyResultRecordSha256: sha(`code-result-${caseOrdinal}`),
  agentDeliveryTraceRecordSha256: sha(`agent-delivery-${caseOrdinal}`),
  trajectoryUseEvidenceRecordSha256: sha(`trajectory-use-${caseOrdinal}`),
});

const campaignInfrastructureFailure = (
  freeze: M7R3TwoCasePortfolioFreezeV1,
  caseOrdinal: 1 | 2,
  campaignBound: boolean,
): RecordM7R3PortfolioCaseOnceV1Input => ({
  ...commonReference(freeze, caseOrdinal),
  disposition: "campaign_infrastructure_failure",
  constructionReceiptSha256: null,
  preflightReceiptSha256: null,
  campaignInfrastructureReceiptSha256: sha(
    `campaign-infrastructure-${caseOrdinal}`,
  ),
  campaignId: campaignBound
    ? `m7-campaign:${caseOrdinal.toString().repeat(24)}`
    : null,
  caseCampaignAdmissionRecordSha256: campaignBound
    ? sha(`failed-admission-${caseOrdinal}`)
    : null,
  mutationRegistrationRecordSha256: campaignBound
    ? sha(`failed-registration-${caseOrdinal}`)
    : null,
  campaignTerminalRecordSha256: null,
  runtimeEnabledResultRecordSha256: null,
  codeOnlyResultRecordSha256: null,
  agentDeliveryTraceRecordSha256: null,
  trajectoryUseEvidenceRecordSha256: null,
});

describe("M7 R3 two-case portfolio freeze", () => {
  it("freezes exactly two ordered cases and the complete common protocol before any Agent", () => {
    const freeze = createM7R3TwoCasePortfolioFreezeV1(portfolioInput());

    expect(freeze.cases).toHaveLength(2);
    expect(freeze.cases.map((entry) => entry.ordinal)).toEqual([1, 2]);
    expect(freeze.frozenBeforeAnyAgent).toBe(true);
    expect(freeze.pairedAttemptPlan).toEqual({
      armOrder: ["runtime_enabled", "code_only"],
      attemptsPerArm: 1,
      retriesAllowed: false,
      userTurnsPerArm: 1,
    });
    expect(freeze.evaluationPlan).toEqual({
      scenarioClassOrder: [
        "public_reproduction",
        "hidden_variant",
        "regression_control",
      ],
      repetitionsPerScenarioClass: 3,
      expectedFreshCopyRunCount: 9,
      freshCopyPerRun: true,
    });
    expect(freeze.cases[0].caseId).not.toBe(freeze.cases[1].caseId);
    expect(freeze.cases[0]).toMatchObject({
      naturalPromptUtf8Sha256: sha("natural prompt one UTF-8 bytes"),
      trajectoryCaseSpecId: `m7-r3-trajectory-case:${sha("trajectory-case-spec-one").slice(0, 24)}`,
      trajectoryCaseSpecSha256: sha("trajectory-case-spec-one"),
      adapterMutantCompatibilityReceiptSha256: sha(
        "adapter-mutant-compatibility-one",
      ),
      pairedPublicTaskContractSha256: sha("paired-public-task-contract-one"),
      preflightImplementationSha256: sha("preflight-implementation-one"),
    });
    expect(freeze.commonRuntimeMaterials).toMatchObject({
      authoritativeSensorFreezeRecordSha256: sha(
        "sensor-freeze-before-mutations",
      ),
      trajectoryClassifierFreezeRecordSha256: sha(
        "trajectory-classifier-freeze",
      ),
      trajectoryClassifierImplementationSha256: sha(
        "trajectory-classifier-implementation",
      ),
      trajectoryClassifierConfigSha256: sha("trajectory-classifier-config"),
      pristineAdapterConformanceReceiptSha256: sha(
        "pristine-adapter-conformance",
      ),
      commonEnvironmentInstructionsSha256: sha(
        "common-environment-instructions",
      ),
      hostModelRuntimeConfigSha256: sha("host-model-runtime-config"),
    });
    expect(M7R3TwoCasePortfolioFreezeV1Schema.parse(freeze)).toEqual(freeze);
  });

  it("rejects a changed retry plan, non-distinct mutants, and pristine-as-mutant identity", () => {
    const oneCase = portfolioInput() as unknown as Record<string, unknown>;
    oneCase.cases = portfolioInput().cases.slice(0, 1);
    expect(() =>
      createM7R3TwoCasePortfolioFreezeV1(
        oneCase as CreateM7R3TwoCasePortfolioFreezeV1Input,
      ),
    ).toThrow();

    const retrying = portfolioInput() as unknown as Record<string, unknown>;
    retrying.pairedAttemptPlan = {
      armOrder: ["runtime_enabled", "code_only"],
      attemptsPerArm: 1,
      retriesAllowed: true,
      userTurnsPerArm: 1,
    };
    expect(() =>
      createM7R3TwoCasePortfolioFreezeV1(
        retrying as CreateM7R3TwoCasePortfolioFreezeV1Input,
      ),
    ).toThrow();

    const notThreeByThree = portfolioInput() as unknown as Record<
      string,
      unknown
    >;
    notThreeByThree.evaluationPlan = {
      scenarioClassOrder: [
        "public_reproduction",
        "hidden_variant",
        "regression_control",
      ],
      repetitionsPerScenarioClass: 2,
      expectedFreshCopyRunCount: 6,
      freshCopyPerRun: true,
    };
    expect(() =>
      createM7R3TwoCasePortfolioFreezeV1(
        notThreeByThree as CreateM7R3TwoCasePortfolioFreezeV1Input,
      ),
    ).toThrow();

    const duplicate = portfolioInput();
    duplicate.cases[1].mutant.mutationSha256 =
      duplicate.cases[0].mutant.mutationSha256;
    expect(() => createM7R3TwoCasePortfolioFreezeV1(duplicate)).toThrow(
      /distinct mutationSha256/u,
    );

    const duplicateTrajectoryCase = portfolioInput();
    duplicateTrajectoryCase.cases[1].trajectoryCaseSpecId =
      duplicateTrajectoryCase.cases[0].trajectoryCaseSpecId;
    duplicateTrajectoryCase.cases[1].trajectoryCaseSpecSha256 =
      duplicateTrajectoryCase.cases[0].trajectoryCaseSpecSha256;
    expect(() =>
      createM7R3TwoCasePortfolioFreezeV1(duplicateTrajectoryCase),
    ).toThrow(/distinct trajectoryCaseSpecId/u);

    const pristineMutant = portfolioInput();
    pristineMutant.cases[0].mutant.mutatedBaselineSelectedTreeSha256 =
      pristineMutant.cases[0].subject.pristineSelectedTreeSha256;
    expect(() => createM7R3TwoCasePortfolioFreezeV1(pristineMutant)).toThrow(
      /must differ/u,
    );

    const crossedSourceIdentity = portfolioInput();
    crossedSourceIdentity.cases[0].mutant.mutatedBuildSourceIdentitySha256 =
      sha("unrelated-source-identity");
    expect(() =>
      createM7R3TwoCasePortfolioFreezeV1(crossedSourceIdentity),
    ).toThrow(/must derive from its source ID and source hash/u);
  });

  it("rejects tampered derived identities and content hashes", () => {
    const freeze = createM7R3TwoCasePortfolioFreezeV1(portfolioInput());
    expect(
      M7R3TwoCasePortfolioFreezeV1Schema.safeParse({
        ...freeze,
        portfolioId: `m7-r3-portfolio:${"f".repeat(24)}`,
      }).success,
    ).toBe(false);
    expect(
      M7R3TwoCasePortfolioFreezeV1Schema.safeParse({
        ...freeze,
        recordContentSha256: sha("tampered"),
      }).success,
    ).toBe(false);
  });
});

describe("M7 R3 two-case Host-only portfolio store", () => {
  it("creates the freeze once as a canonical one-link mode-0600 file", async () => {
    const { root, exposed, store } = await storeFixture();
    const freeze = await store.createPortfolioOnce(portfolioInput());
    const path = join(root, "m7-r3.portfolio-freeze.json");
    const metadata = await lstat(path);
    expect(metadata.mode & 0o7777).toBe(0o600);
    expect(metadata.nlink).toBe(1);

    await expect(store.createPortfolioOnce(portfolioInput())).rejects.toThrow(
      /overwrite, retry, and reroll are forbidden/u,
    );
    const reopened = await openM7R3TwoCasePortfolioStoreV1({
      root,
      exposedRoots: [exposed],
    });
    expect(await reopened.readPortfolio()).toEqual(freeze);
  });

  it("requires the frozen case order and exact portfolio/case linkage", async () => {
    const { store } = await storeFixture();
    const freeze = await store.createPortfolioOnce(portfolioInput());

    await expect(
      store.recordCaseOnce(campaignTerminal(freeze, 2)),
    ).rejects.toThrow(/case 2 cannot be recorded before case 1/u);
    await expect(
      store.recordCaseOnce({
        ...campaignTerminal(freeze, 1),
        caseId: freeze.cases[1].caseId,
      }),
    ).rejects.toThrow(/crossed its frozen portfolio or case identity/u);
    await expect(
      store.recordCaseOnce({
        ...safetyStop(freeze),
        caseOrdinal: 1,
        caseId: freeze.cases[0].caseId,
      }),
    ).rejects.toThrow(/only valid for the later case/u);
    const incompleteTerminal = campaignTerminal(freeze, 1) as unknown as Record<
      string,
      unknown
    >;
    delete incompleteTerminal.caseCampaignAdmissionRecordSha256;
    delete incompleteTerminal.trajectoryUseEvidenceRecordSha256;
    await expect(
      store.recordCaseOnce(
        incompleteTerminal as unknown as RecordM7R3PortfolioCaseOnceV1Input,
      ),
    ).rejects.toThrow();

    const first = await store.recordCaseOnce(campaignTerminal(freeze, 1));
    expect(first.disposition).toBe("campaign_terminal");
    await expect(
      store.recordCaseOnce(constructionFailed(freeze, 1)),
    ).rejects.toThrow(/overwrite, retry, and reroll are forbidden/u);
    expect(await store.readCaseReference(1)).toEqual(first);
  });

  it("keeps construction failure and a later safety stop in the fixed denominator", async () => {
    const { store } = await storeFixture();
    const freeze = await store.createPortfolioOnce(portfolioInput());
    const first = await store.recordCaseOnce(constructionFailed(freeze, 1));
    const second = await store.recordCaseOnce(safetyStop(freeze));
    const summary = await store.finalizeSummaryOnce("2026-08-16T03:00:00.000Z");

    expect(summary.denominatorCaseCount).toBe(2);
    expect(summary.recordedCaseCount).toBe(2);
    expect(summary.cases.map((entry) => entry.disposition)).toEqual([
      "construction_failed",
      "not_started_safety_stop",
    ]);
    expect(
      summary.cases.map((entry) => entry.caseReferenceRecordSha256),
    ).toEqual([first.recordContentSha256, second.recordContentSha256]);
    expect(summary.cases[0]).toMatchObject({
      constructionReceiptSha256: sha("construction-failure-1"),
      preflightReceiptSha256: null,
      campaignId: null,
      campaignTerminalRecordSha256: null,
    });
    expect(JSON.stringify(summary)).not.toMatch(
      /verdict|claimSupported|outcome/u,
    );
    await expect(
      store.finalizeSummaryOnce("2026-08-16T03:01:00.000Z"),
    ).rejects.toThrow(/overwrite, retry, and reroll are forbidden/u);
  });

  it("keeps a preflight failure in the denominator without inventing campaign identity", async () => {
    const { store } = await storeFixture();
    const freeze = await store.createPortfolioOnce(portfolioInput());
    await expect(
      store.recordCaseOnce({
        ...commonReference(freeze, 1),
        disposition: "preflight_failed",
        constructionReceiptSha256: null,
        preflightReceiptSha256: sha("preflight-failure-receipt"),
        campaignInfrastructureReceiptSha256: null,
        campaignId: `m7-campaign:${"a".repeat(24)}`,
        caseCampaignAdmissionRecordSha256: sha("invented-admission"),
        mutationRegistrationRecordSha256: sha("invented-registration"),
        campaignTerminalRecordSha256: sha("invented-terminal"),
        runtimeEnabledResultRecordSha256: null,
        codeOnlyResultRecordSha256: null,
        agentDeliveryTraceRecordSha256: sha("invented-delivery"),
        trajectoryUseEvidenceRecordSha256: sha("invented-trajectory"),
      } as unknown as RecordM7R3PortfolioCaseOnceV1Input),
    ).rejects.toThrow();
    const preflight = await store.recordCaseOnce({
      ...commonReference(freeze, 1),
      disposition: "preflight_failed",
      constructionReceiptSha256: null,
      preflightReceiptSha256: sha("preflight-failure-receipt"),
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
    await store.recordCaseOnce(safetyStop(freeze));
    const summary = await store.finalizeSummaryOnce("2026-08-16T03:00:00.000Z");

    expect(preflight.disposition).toBe("preflight_failed");
    expect(summary.cases[0]).toMatchObject({
      disposition: "preflight_failed",
      constructionReceiptSha256: null,
      preflightReceiptSha256: sha("preflight-failure-receipt"),
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
  });

  it("retains a sanitized campaign infrastructure receipt without inventing terminal evidence", async () => {
    const { store } = await storeFixture();
    const freeze = await store.createPortfolioOnce(portfolioInput());
    const first = await store.recordCaseOnce(
      campaignInfrastructureFailure(freeze, 1, true),
    );
    const second = await store.recordCaseOnce(
      campaignInfrastructureFailure(freeze, 2, false),
    );
    const summary = await store.finalizeSummaryOnce("2026-08-16T03:00:00.000Z");

    expect(first).toMatchObject({
      disposition: "campaign_infrastructure_failure",
      campaignInfrastructureReceiptSha256: sha("campaign-infrastructure-1"),
      campaignId: `m7-campaign:${"1".repeat(24)}`,
      campaignTerminalRecordSha256: null,
      runtimeEnabledResultRecordSha256: null,
      codeOnlyResultRecordSha256: null,
      agentDeliveryTraceRecordSha256: null,
      trajectoryUseEvidenceRecordSha256: null,
    });
    expect(second.campaignId).toBeNull();
    expect(summary.cases.map((value) => value.disposition)).toEqual([
      "campaign_infrastructure_failure",
      "campaign_infrastructure_failure",
    ]);
    expect(summary.cases[0].campaignInfrastructureReceiptSha256).toBe(
      first.campaignInfrastructureReceiptSha256,
    );
    expect(summary.cases[1].campaignInfrastructureReceiptSha256).toBe(
      second.campaignInfrastructureReceiptSha256,
    );
  });

  it("summarizes only orthogonal case fields and existing M7 record hashes", async () => {
    const { store } = await storeFixture();
    const freeze = await store.createPortfolioOnce(portfolioInput());
    const first = await store.recordCaseOnce(campaignTerminal(freeze, 1));
    const second = await store.recordCaseOnce({
      ...campaignTerminal(freeze, 2),
      codeOnlyResultRecordSha256: null,
    });
    const summary = await store.finalizeSummaryOnce("2026-08-16T03:00:00.000Z");

    expect(summary.cases).toEqual([
      {
        caseOrdinal: 1,
        caseId: freeze.cases[0].caseId,
        disposition: "campaign_terminal",
        caseReferenceRecordSha256: first.recordContentSha256,
        constructionReceiptSha256: null,
        preflightReceiptSha256: null,
        campaignInfrastructureReceiptSha256: null,
        campaignId: first.campaignId,
        caseCampaignAdmissionRecordSha256:
          first.caseCampaignAdmissionRecordSha256,
        mutationRegistrationRecordSha256:
          first.mutationRegistrationRecordSha256,
        campaignTerminalRecordSha256: first.campaignTerminalRecordSha256,
        runtimeEnabledResultRecordSha256:
          first.runtimeEnabledResultRecordSha256,
        codeOnlyResultRecordSha256: first.codeOnlyResultRecordSha256,
        agentDeliveryTraceRecordSha256: first.agentDeliveryTraceRecordSha256,
        trajectoryUseEvidenceRecordSha256:
          first.trajectoryUseEvidenceRecordSha256,
      },
      {
        caseOrdinal: 2,
        caseId: freeze.cases[1].caseId,
        disposition: "campaign_terminal",
        caseReferenceRecordSha256: second.recordContentSha256,
        constructionReceiptSha256: null,
        preflightReceiptSha256: null,
        campaignInfrastructureReceiptSha256: null,
        campaignId: second.campaignId,
        caseCampaignAdmissionRecordSha256:
          second.caseCampaignAdmissionRecordSha256,
        mutationRegistrationRecordSha256:
          second.mutationRegistrationRecordSha256,
        campaignTerminalRecordSha256: second.campaignTerminalRecordSha256,
        runtimeEnabledResultRecordSha256:
          second.runtimeEnabledResultRecordSha256,
        codeOnlyResultRecordSha256: null,
        agentDeliveryTraceRecordSha256: second.agentDeliveryTraceRecordSha256,
        trajectoryUseEvidenceRecordSha256:
          second.trajectoryUseEvidenceRecordSha256,
      },
    ]);
  });

  it("refuses summary until both denominator entries have immutable records", async () => {
    const { store } = await storeFixture();
    const freeze = await store.createPortfolioOnce(portfolioInput());
    await store.recordCaseOnce(campaignTerminal(freeze, 1));
    await expect(
      store.finalizeSummaryOnce("2026-08-16T03:00:00.000Z"),
    ).rejects.toThrow();
  });

  it("rejects exposed, symlinked, non-private, hard-linked, and tampered records", async () => {
    const { parent, root, exposed, store } = await storeFixture();
    await expect(
      openM7R3TwoCasePortfolioStoreV1({ root, exposedRoots: [root] }),
    ).rejects.toThrow(/disjoint/u);

    await chmod(root, 0o755);
    await expect(
      openM7R3TwoCasePortfolioStoreV1({ root, exposedRoots: [exposed] }),
    ).rejects.toThrow(/0700/u);
    await chmod(root, 0o700);

    const linkedRoot = join(parent, "host-only-link");
    await symlink(root, linkedRoot);
    await expect(
      openM7R3TwoCasePortfolioStoreV1({
        root: linkedRoot,
        exposedRoots: [exposed],
      }),
    ).rejects.toThrow(/real directory/u);

    await store.createPortfolioOnce(portfolioInput());
    const freezePath = join(root, "m7-r3.portfolio-freeze.json");
    const alias = join(parent, "freeze-hardlink.json");
    await link(freezePath, alias);
    await expect(store.readPortfolio()).rejects.toThrow(/one-link/u);
    await rm(alias);

    const bytes = await readFile(freezePath, "utf8");
    const value = JSON.parse(bytes) as Record<string, unknown>;
    value.recordContentSha256 = sha("wrong-content-hash");
    await writeFile(freezePath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    await expect(store.readPortfolio()).rejects.toThrow();
  });
});
