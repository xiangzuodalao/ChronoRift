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
  M7R3CaseCampaignAdmissionV1Schema,
  createM7R3CaseCampaignAdmissionV1,
  openM7R3CaseCampaignAdmissionStoreV1,
  type CreateM7R3CaseCampaignAdmissionV1Input,
} from "./m7-r3-case-admission.js";
import {
  createM7R3TwoCasePortfolioFreezeV1,
  type CreateM7R3TwoCasePortfolioFreezeV1Input,
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
    adapterRevisionSha256: sha("pristine-adapter-revision"),
    adapterPackageSha256: sha("pristine-adapter-package"),
    adapterObservationSchemaSha256: sha("generic-patrol-schema"),
    trajectoryClassifierFreezeRecordSha256: sha("classifier-freeze"),
    trajectoryClassifierImplementationSha256: sha("classifier-code"),
    trajectoryClassifierConfigSha256: sha("classifier-config"),
    validatedGameToolSetSha256: sha("validated-game-tools"),
    pristineAdapterConformanceReceiptSha256: sha("pristine-conformance"),
    commonEnvironmentInstructionsSha256: sha("common-environment"),
    hostModelRuntimeConfigSha256: sha("host-model-config"),
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
  cases: [
    {
      subject: {
        subjectProjectSha256: sha("external-project"),
        pristineProjectRevision: "3e793f53598a131c53fb82555191cc14b8db07ff",
        pristineSelectedTreeSha256: sha("pristine-tree"),
      },
      mutant: {
        mutationSha256: sha("mutation-one"),
        mutatedBuildSourceId: asSourceId(`source:${"1".repeat(64)}`),
        mutatedBuildSourceSha256: sha("mutated-build-one"),
        mutatedBaselineSelectedTreeSha256: sha("mutant-tree-one"),
        mutatedBuildSourceIdentitySha256: sourceIdentitySha(
          `source:${"1".repeat(64)}`,
          sha("mutated-build-one"),
        ),
      },
      naturalPromptUtf8Sha256: sha("prompt-one-utf8"),
      trajectoryCaseSpecId: `m7-r3-trajectory-case:${sha("case-spec-one").slice(0, 24)}`,
      trajectoryCaseSpecSha256: sha("case-spec-one"),
      adapterMutantCompatibilityReceiptSha256: sha("compatibility-one"),
      pairedPublicTaskContractSha256: sha("paired-contract-one"),
      preflightImplementationSha256: sha("preflight-code-one"),
      evaluatorImplementationSha256: sha("evaluator-code-one"),
      evaluatorBundleSha256: sha("evaluator-bundle-one"),
    },
    {
      subject: {
        subjectProjectSha256: sha("external-project"),
        pristineProjectRevision: "3e793f53598a131c53fb82555191cc14b8db07ff",
        pristineSelectedTreeSha256: sha("pristine-tree"),
      },
      mutant: {
        mutationSha256: sha("mutation-two"),
        mutatedBuildSourceId: asSourceId(`source:${"2".repeat(64)}`),
        mutatedBuildSourceSha256: sha("mutated-build-two"),
        mutatedBaselineSelectedTreeSha256: sha("mutant-tree-two"),
        mutatedBuildSourceIdentitySha256: sourceIdentitySha(
          `source:${"2".repeat(64)}`,
          sha("mutated-build-two"),
        ),
      },
      naturalPromptUtf8Sha256: sha("prompt-two-utf8"),
      trajectoryCaseSpecId: `m7-r3-trajectory-case:${sha("case-spec-two").slice(0, 24)}`,
      trajectoryCaseSpecSha256: sha("case-spec-two"),
      adapterMutantCompatibilityReceiptSha256: sha("compatibility-two"),
      pairedPublicTaskContractSha256: sha("paired-contract-two"),
      preflightImplementationSha256: sha("preflight-code-two"),
      evaluatorImplementationSha256: sha("evaluator-code-two"),
      evaluatorBundleSha256: sha("evaluator-bundle-two"),
    },
  ],
  frozenAt: "2026-08-16T00:00:00.000Z",
});

const admissionInput = (
  caseOrdinal: 1 | 2 = 1,
): CreateM7R3CaseCampaignAdmissionV1Input => ({
  portfolioFreeze: createM7R3TwoCasePortfolioFreezeV1(portfolioInput()),
  caseOrdinal,
  campaignId: `m7-campaign:${caseOrdinal.toString().repeat(24)}`,
  mutationRegistrationRecordSha256: sha(`mutation-registration-${caseOrdinal}`),
  naturalPromptCanonicalJsonSha256: sha(
    `natural-prompt-canonical-json-${caseOrdinal}`,
  ),
  pairedAgentProtocolImplementationSha256: sha(
    "paired-agent-protocol-implementation",
  ),
  pairedCaseContractContentSha256: sha(`paired-case-contract-${caseOrdinal}`),
  runtimeArmPublicTaskSpecSha256: sha(`runtime-task-${caseOrdinal}`),
  codeOnlyArmPublicTaskSpecSha256: sha(`code-only-task-${caseOrdinal}`),
  admittedAt: `2026-08-16T0${caseOrdinal}:00:00.000Z`,
});

const temporaryRoots = new Set<string>();

afterEach(async () => {
  await Promise.all(
    [...temporaryRoots].map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
  temporaryRoots.clear();
});

const storeFixture = async () => {
  const parent = await mkdtemp(join(tmpdir(), "chronorift-m7-r3-admission-"));
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
    store: await openM7R3CaseCampaignAdmissionStoreV1({
      root,
      exposedRoots: [exposed],
    }),
  };
};

describe("M7 R3 case-campaign admission", () => {
  it("binds the frozen case, mutant source, prompt digests, classifier, and paired task protocol", () => {
    const input = admissionInput(1);
    const record = createM7R3CaseCampaignAdmissionV1(input);
    const frozenCase = input.portfolioFreeze.cases[0];

    expect(record).toMatchObject({
      portfolioId: input.portfolioFreeze.portfolioId,
      portfolioFreezeRecordSha256: input.portfolioFreeze.recordContentSha256,
      caseOrdinal: 1,
      caseId: frozenCase.caseId,
      campaignId: input.campaignId,
      mutationRegistrationRecordSha256: input.mutationRegistrationRecordSha256,
      mutant: frozenCase.mutant,
      prompt: {
        utf8Sha256: frozenCase.naturalPromptUtf8Sha256,
        canonicalJsonSha256: input.naturalPromptCanonicalJsonSha256,
      },
      trajectory: {
        classifierFreezeRecordSha256:
          input.portfolioFreeze.commonRuntimeMaterials
            .trajectoryClassifierFreezeRecordSha256,
        classifierImplementationSha256:
          input.portfolioFreeze.commonRuntimeMaterials
            .trajectoryClassifierImplementationSha256,
        classifierConfigSha256:
          input.portfolioFreeze.commonRuntimeMaterials
            .trajectoryClassifierConfigSha256,
        caseSpecId: frozenCase.trajectoryCaseSpecId,
        caseSpecSha256: frozenCase.trajectoryCaseSpecSha256,
      },
      pairedProtocol: {
        pairedAgentProtocolImplementationSha256:
          input.pairedAgentProtocolImplementationSha256,
        pairedCaseContractContentSha256: input.pairedCaseContractContentSha256,
        pairedPublicTaskContractSha256:
          frozenCase.pairedPublicTaskContractSha256,
        runtimeArmPublicTaskSpecSha256: input.runtimeArmPublicTaskSpecSha256,
        codeOnlyArmPublicTaskSpecSha256: input.codeOnlyArmPublicTaskSpecSha256,
      },
      authoritativeSensorFreezeRecordSha256:
        input.portfolioFreeze.commonRuntimeMaterials
          .authoritativeSensorFreezeRecordSha256,
      adapterMutantCompatibilityReceiptSha256:
        frozenCase.adapterMutantCompatibilityReceiptSha256,
      preflightImplementationSha256: frozenCase.preflightImplementationSha256,
    });
    expect(M7R3CaseCampaignAdmissionV1Schema.parse(record)).toEqual(record);

    const serialized = JSON.stringify(record);
    expect(serialized).not.toMatch(
      /promptText|mutationBytes|evaluatorBytes|mutationPath|evaluatorPath/iu,
    );
  });

  it("rejects hidden bytes or paths and detects identity/content tampering", () => {
    const input = admissionInput(1);
    expect(() =>
      createM7R3CaseCampaignAdmissionV1({
        ...input,
        mutationPath: "/host/private/mutation.patch",
      } as unknown as CreateM7R3CaseCampaignAdmissionV1Input),
    ).toThrow();

    const record = createM7R3CaseCampaignAdmissionV1(input);
    expect(
      M7R3CaseCampaignAdmissionV1Schema.safeParse({
        ...record,
        admissionId: `m7-r3-case-admission:${"f".repeat(24)}`,
      }).success,
    ).toBe(false);
    expect(
      M7R3CaseCampaignAdmissionV1Schema.safeParse({
        ...record,
        recordContentSha256: sha("tampered"),
      }).success,
    ).toBe(false);
    expect(
      M7R3CaseCampaignAdmissionV1Schema.safeParse({
        ...record,
        evaluatorBytes: "hidden",
      }).success,
    ).toBe(false);
  });
});

describe("M7 R3 Host-only case-campaign admission store", () => {
  it("creates each case admission once as canonical one-link mode-0600 data", async () => {
    const { root, store } = await storeFixture();
    const first = await store.createAdmissionOnce(admissionInput(1));
    const path = join(root, "m7-r3.case-01-campaign-admission.json");
    const metadata = await lstat(path);
    expect(metadata.mode & 0o7777).toBe(0o600);
    expect(metadata.nlink).toBe(1);
    expect(await store.readAdmission(1)).toEqual(first);
    await expect(store.createAdmissionOnce(admissionInput(1))).rejects.toThrow(
      /overwrite, retry, and reroll are forbidden/u,
    );

    const second = await store.createAdmissionOnce(admissionInput(2));
    expect(second.caseOrdinal).toBe(2);
    expect(await store.readAdmission(2)).toEqual(second);
  });

  it("rejects exposed, symlinked, hard-linked, and tampered admission records", async () => {
    const { parent, root, exposed, store } = await storeFixture();
    await expect(
      openM7R3CaseCampaignAdmissionStoreV1({
        root,
        exposedRoots: [root],
      }),
    ).rejects.toThrow(/disjoint/u);

    const linkedRoot = join(parent, "host-only-link");
    await symlink(root, linkedRoot);
    await expect(
      openM7R3CaseCampaignAdmissionStoreV1({
        root: linkedRoot,
        exposedRoots: [exposed],
      }),
    ).rejects.toThrow(/real directory/u);

    await store.createAdmissionOnce(admissionInput(1));
    const path = join(root, "m7-r3.case-01-campaign-admission.json");
    const alias = join(parent, "admission-hardlink.json");
    await link(path, alias);
    await expect(store.readAdmission(1)).rejects.toThrow(/one-link/u);
    await rm(alias);

    const record = JSON.parse(await readFile(path, "utf8")) as Record<
      string,
      unknown
    >;
    record.recordContentSha256 = sha("tampered-on-disk");
    await writeFile(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    await expect(store.readAdmission(1)).rejects.toThrow();
  });
});
