import { createHash } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  asSha256DigestV1,
  asSourceId,
  type Sha256DigestV1,
} from "@chronorift/domain";
import { afterEach, describe, expect, it } from "vitest";

import {
  M7ArmResultV1Schema,
  M7CampaignTerminalRecordV1Schema,
  M7CampaignSensorBindingV1Schema,
  createM7ArmResultV1,
  createM7CampaignTerminalRecordV1,
  createM7CampaignSensorBindingV1,
  deriveM7CampaignOutcomeV1,
  deriveM7BuildSourceIdentitySha256V1,
  openM7RuntimeUseCampaignStoreV1,
  type BeginM7ArmOnceV1Input,
  type CreateM7MutationRegistrationV1Input,
  type CreateM7CampaignSensorBindingV1Input,
  type M7ArmClaimV1,
  type M7ArmResultV1,
  type M7ArmV1,
  type M7CandidatePatchV1,
  type M7MutationRegistrationV1,
  type M7RuntimeUseCampaignStoreV1,
} from "./m7-runtime-use-campaign.js";

const sha = (value: string): Sha256DigestV1 =>
  asSha256DigestV1(createHash("sha256").update(value).digest("hex"));

const cleanupRoots = new Set<string>();

afterEach(async () => {
  await Promise.all(
    [...cleanupRoots].map((path) => rm(path, { recursive: true, force: true })),
  );
  cleanupRoots.clear();
});

const sensorBindingInput = (): CreateM7CampaignSensorBindingV1Input => ({
  schemaVersion: 1,
  authoritativeSensorFreezeId: `m7-sensor-freeze:${"a".repeat(24)}`,
  authoritativeSensorFreezeRecordSha256: sha("authoritative-sensor-freeze"),
  subjectProjectSha256: sha("subject"),
  pristineProjectRevision: "3e793f53598a131c53fb82555191cc14b8db07ff",
  pristineSelectedTreeSha256: sha("pristine-tree"),
  pristineAdapterRevisionSha256: sha("pristine-adapter-revision"),
  adapterPackageSha256: sha("adapter-package"),
  adapterObservationSchemaSha256: sha("generic-patrol-observation-schema"),
  publicPatrolClassifierSha256: sha("generic-patrol-classifier"),
  pristineConformanceReceiptSha256: sha("pristine-conformance"),
  validatedGameToolSetSha256: sha("validated-game-tools"),
  boundAt: "2026-08-15T00:00:00.000Z",
});

const registrationInput = (): CreateM7MutationRegistrationV1Input => ({
  mutationSha256: sha("left-and-right-ray-mask-5-to-1"),
  mutatedBaselineSelectedTreeSha256: sha("mutated-tree"),
  mutatedBuildSourceIdentitySha256: deriveM7BuildSourceIdentitySha256V1({
    sourceId: asSourceId(`source:${"b".repeat(64)}`),
    sourceHash: sha("mutated-tree"),
  }),
  adapterMutantCompatibilityReceiptSha256: sha("mutant-compatibility"),
  publicTaskSpecSha256: sha("natural-user-prompt"),
  evaluatorImplementationSha256: sha("hidden-evaluator"),
  evaluatorBundleSha256: sha("3x3-evaluator-bundle"),
  provider: "test-provider",
  model: "test-model",
  thinkingLevel: "high",
  agentBudgetSha256: sha("one-turn-budget"),
  codingToolSetSha256: sha("same-coding-tools"),
  sandboxPolicySha256: sha("same-sandbox-policy"),
  registeredAt: "2026-08-15T00:01:00.000Z",
});

interface StoreFixture {
  readonly parent: string;
  readonly root: string;
  readonly exposed: string;
  readonly store: M7RuntimeUseCampaignStoreV1;
}

const storeFixture = async (): Promise<StoreFixture> => {
  const parent = await mkdtemp(join(tmpdir(), "chronorift-m7-campaign-"));
  cleanupRoots.add(parent);
  const root = join(parent, "host-only");
  const exposed = join(parent, "agent-exposed");
  await Promise.all([
    mkdir(root, { mode: 0o700 }),
    mkdir(exposed, { mode: 0o700 }),
  ]);
  await Promise.all([chmod(root, 0o700), chmod(exposed, 0o700)]);
  const store = await openM7RuntimeUseCampaignStoreV1({
    root,
    exposedRoots: [exposed],
  });
  return { parent, root, exposed, store };
};

const passedPreflightInput = () => ({
  pristinePassCount: 9,
  mutantPublicAndHiddenPassCount: 0,
  mutantRegressionPassCount: 3,
  genericClassifierMutantWitnessObserved: true,
  pristineAdapterConformancePassed: true,
  mutantBuildCompatibilityPassed: true,
  cleanupProven: true,
  infrastructureFailureCode: null,
  completedAt: "2026-08-15T00:02:00.000Z",
});

const binding = (registration: M7MutationRegistrationV1) => ({
  publicTaskSpecSha256: registration.publicTaskSpecSha256,
  provider: registration.provider,
  model: registration.model,
  thinkingLevel: registration.thinkingLevel,
  agentBudgetSha256: registration.agentBudgetSha256,
  workspaceBaselineSelectedTreeSha256:
    registration.mutatedBaselineSelectedTreeSha256,
  codingToolSetSha256: registration.codingToolSetSha256,
  sandboxPolicySha256: registration.sandboxPolicySha256,
});

const armClaimInput = (
  registration: M7MutationRegistrationV1,
  arm: M7ArmV1,
  identityPrefix = arm,
): BeginM7ArmOnceV1Input => ({
  campaignId: registration.campaignId,
  arm,
  binding: binding(registration),
  taskId: `task:m7:${arm}`,
  sessionIdentitySha256: sha(`${identityPrefix}:session`),
  workspaceIdentitySha256: sha(`${identityPrefix}:workspace`),
  cacheIdentitySha256: sha(`${identityPrefix}:cache`),
  startedAt:
    arm === "runtime_enabled"
      ? "2026-08-15T00:03:00.000Z"
      : "2026-08-15T00:05:00.000Z",
});

const candidate = (
  registration: M7MutationRegistrationV1,
  arm: M7ArmV1,
): M7CandidatePatchV1 => ({
  schemaVersion: 1,
  baselineSelectedTreeSha256: registration.mutatedBaselineSelectedTreeSha256,
  candidateSelectedTreeSha256: sha(`${arm}:candidate-tree`),
  patchSha256: sha(`${arm}:patch`),
  byteLength: 200,
  roundTripVerified: true,
});

const freshRuns = (arm: M7ArmV1) => {
  const result = [];
  let ordinal = 1;
  for (const scenarioClass of [
    "public_reproduction",
    "hidden_variant",
    "regression_control",
  ] as const) {
    for (const repetition of [1, 2, 3] as const) {
      result.push({
        schemaVersion: 1 as const,
        ordinal,
        scenarioClass,
        repetition,
        receiptSha256: sha(`${arm}:${scenarioClass}:${repetition}`),
      });
      ordinal += 1;
    }
  }
  return result;
};

interface ArmResultOptions {
  readonly loopOutcome?: M7ArmResultV1["loopOutcome"];
  readonly candidateOutcome?: M7ArmResultV1["candidateOutcome"];
  readonly runtimeUseOutcome?: M7ArmResultV1["runtimeUseOutcome"];
  readonly evaluatorOutcome?: M7ArmResultV1["evaluatorOutcome"];
  readonly cleanupProven?: boolean;
  readonly candidateOverride?: M7CandidatePatchV1 | null;
  readonly claimHashOverride?: Sha256DigestV1;
}

const armResult = (
  registration: M7MutationRegistrationV1,
  claim: M7ArmClaimV1,
  options: ArmResultOptions = {},
): M7ArmResultV1 => {
  const loopOutcome = options.loopOutcome ?? "completed";
  const candidateOutcome =
    options.candidateOutcome ??
    (loopOutcome === "completed" ? "valid_candidate" : "no_candidate");
  const runtimeUseOutcome =
    options.runtimeUseOutcome ??
    (claim.arm === "runtime_enabled" ? "verified" : "not_applicable");
  const evaluatorOutcome =
    options.evaluatorOutcome ??
    (loopOutcome !== "completed"
      ? "not_run_agent_failure"
      : candidateOutcome === "no_candidate"
        ? "not_run_no_candidate"
        : candidateOutcome === "invalid_candidate"
          ? "not_run_invalid_candidate"
          : "accepted");
  const evaluatorRan = [
    "accepted",
    "rejected",
    "infrastructure_failed",
  ].includes(evaluatorOutcome);
  const completedEvaluation =
    evaluatorOutcome === "accepted" || evaluatorOutcome === "rejected";
  const cleanupProven = options.cleanupProven ?? true;
  return createM7ArmResultV1({
    campaignId: registration.campaignId,
    arm: claim.arm,
    armClaimSha256: options.claimHashOverride ?? claim.recordContentSha256,
    observedTurnCount: 1,
    loopOutcome,
    candidateOutcome,
    candidate:
      options.candidateOverride === undefined
        ? candidateOutcome === "valid_candidate"
          ? candidate(registration, claim.arm)
          : null
        : options.candidateOverride,
    runtimeUseOutcome,
    runtimeUseReceiptSha256:
      claim.arm === "runtime_enabled" &&
      (runtimeUseOutcome === "verified" || runtimeUseOutcome === "rejected")
        ? sha(`${claim.arm}:runtime-use`)
        : null,
    evaluatorOutcome,
    evaluatorReceiptSha256: evaluatorRan ? sha(`${claim.arm}:evaluator`) : null,
    freshRunReferences: completedEvaluation ? freshRuns(claim.arm) : [],
    cleanupProven,
    cleanupReceiptSha256: cleanupProven ? sha(`${claim.arm}:cleanup`) : null,
    completedAt:
      claim.arm === "runtime_enabled"
        ? "2026-08-15T00:04:00.000Z"
        : "2026-08-15T00:06:00.000Z",
  });
};

const campaignRecords = async () => {
  const fixture = await storeFixture();
  await fixture.store.bindCampaignSensorOnce(sensorBindingInput());
  const registration =
    await fixture.store.registerMutationOnce(registrationInput());
  const preflight = await fixture.store.putPreflightOnce(
    passedPreflightInput(),
  );
  const runtimeClaim = await fixture.store.beginArmOnce(
    armClaimInput(registration, "runtime_enabled"),
  );
  return { ...fixture, registration, preflight, runtimeClaim };
};

describe("M7 runtime-use campaign records", () => {
  it("derives Build source identity from sourceId plus sourceHash", () => {
    const sourceHash = sha("mutated-selected-tree");
    const sourceId = asSourceId(`source:${"c".repeat(64)}`);
    const derived = deriveM7BuildSourceIdentitySha256V1({
      sourceId,
      sourceHash,
    });
    expect(derived).not.toBe(sourceHash);
    expect(deriveM7BuildSourceIdentitySha256V1({ sourceId, sourceHash })).toBe(
      derived,
    );
    expect(
      deriveM7BuildSourceIdentitySha256V1({
        sourceId: asSourceId(`source:${"d".repeat(64)}`),
        sourceHash,
      }),
    ).not.toBe(derived);
  });

  it("binds the sensor freeze ID and content hash to pre-mutation identities", () => {
    const record = createM7CampaignSensorBindingV1(sensorBindingInput());
    expect(M7CampaignSensorBindingV1Schema.parse(record)).toEqual(record);
    expect(record.campaignSensorBindingId).toMatch(
      /^m7-campaign-sensor-binding:[a-f0-9]{24}$/u,
    );
    expect(record.authoritativeSensorFreezeId).toBe(
      sensorBindingInput().authoritativeSensorFreezeId,
    );
    expect(record.authoritativeSensorFreezeRecordSha256).toBe(
      sensorBindingInput().authoritativeSensorFreezeRecordSha256,
    );

    expect(
      M7CampaignSensorBindingV1Schema.safeParse({
        ...record,
        publicPatrolClassifierSha256: sha("tampered-classifier"),
      }).success,
    ).toBe(false);
    expect(
      M7CampaignSensorBindingV1Schema.safeParse({ ...record, surprise: true })
        .success,
    ).toBe(false);
    expect(createM7CampaignSensorBindingV1(sensorBindingInput())).toEqual(
      record,
    );
  });

  it("requires the complete canonical 3x3 evaluator receipt set", async () => {
    const { registration, runtimeClaim } = await campaignRecords();
    const result = armResult(registration, runtimeClaim);
    expect(result.freshRunReferences).toHaveLength(9);
    expect(M7ArmResultV1Schema.parse(result)).toEqual(result);

    expect(
      M7ArmResultV1Schema.safeParse({
        ...result,
        freshRunReferences: result.freshRunReferences.slice(0, 8),
      }).success,
    ).toBe(false);
    expect(
      M7ArmResultV1Schema.safeParse({
        ...result,
        freshRunReferences: result.freshRunReferences.map((run, index) =>
          index === 0 ? { ...run, scenarioClass: "hidden_variant" } : run,
        ),
      }).success,
    ).toBe(false);
  });
});

describe("M7 Host-only campaign store", () => {
  it("enforces sensor binding, mutation, preflight, fixed arm order, equality, isolation, and create-once records", async () => {
    const { root, store } = await storeFixture();
    await expect(
      store.registerMutationOnce(registrationInput()),
    ).rejects.toThrow(/sensor binding/u);

    const sensorBinding =
      await store.bindCampaignSensorOnce(sensorBindingInput());
    expect(
      (await lstat(join(root, "m7.sensor-binding.json"))).mode & 0o7777,
    ).toBe(0o600);
    await expect(
      store.bindCampaignSensorOnce(sensorBindingInput()),
    ).rejects.toThrow(/already exists/u);

    const registration = await store.registerMutationOnce(registrationInput());
    expect(registration.campaignSensorBindingRecordSha256).toBe(
      sensorBinding.recordContentSha256,
    );
    expect(registration.sensorFreezeId).toBe(
      sensorBinding.authoritativeSensorFreezeId,
    );
    expect(registration.sensorFreezeRecordSha256).toBe(
      sensorBinding.authoritativeSensorFreezeRecordSha256,
    );
    expect(registration.runtimeGameToolSetSha256).toBe(
      sensorBinding.validatedGameToolSetSha256,
    );
    await expect(
      store.registerMutationOnce(registrationInput()),
    ).rejects.toThrow(/rerolls/u);

    const preflight = await store.putPreflightOnce(passedPreflightInput());
    expect(preflight.outcome).toBe("passed");
    await expect(
      store.putPreflightOnce(passedPreflightInput()),
    ).rejects.toThrow(/already exists/u);
    await expect(
      store.beginArmOnce(armClaimInput(registration, "code_only")),
    ).rejects.toThrow(/runtime-enabled arm first/u);

    const wrongBinding = armClaimInput(registration, "runtime_enabled");
    await expect(
      store.beginArmOnce({
        ...wrongBinding,
        binding: { ...wrongBinding.binding, model: "different-model" },
      }),
    ).rejects.toThrow(/exact frozen prompt, provider, model, budget/u);

    const runtimeClaim = await store.beginArmOnce(
      armClaimInput(registration, "runtime_enabled"),
    );
    expect(runtimeClaim.attemptOrdinal).toBe(1);
    expect(runtimeClaim.turnLimit).toBe(1);
    expect(runtimeClaim.gameToolSetSha256).toBe(
      sensorBinding.validatedGameToolSetSha256,
    );
    await expect(
      store.beginArmOnce(armClaimInput(registration, "runtime_enabled")),
    ).rejects.toThrow(/already exists/u);

    const detachedResult = armResult(registration, runtimeClaim, {
      claimHashOverride: sha("wrong-claim"),
    });
    await expect(store.putArmResultOnce(detachedResult)).rejects.toThrow(
      /crossed its campaign, claim, or baseline/u,
    );
    const runtimeResult = armResult(registration, runtimeClaim);
    await store.putArmResultOnce(runtimeResult);

    await expect(
      store.beginArmOnce({
        ...armClaimInput(registration, "code_only"),
        sessionIdentitySha256: runtimeClaim.sessionIdentitySha256,
      }),
    ).rejects.toThrow(/isolated session/u);

    const codeClaim = await store.beginArmOnce(
      armClaimInput(registration, "code_only"),
    );
    expect(codeClaim.gameToolSetSha256).toBeNull();
    expect(codeClaim.binding).toEqual(runtimeClaim.binding);
    expect(codeClaim.workspaceIdentitySha256).not.toBe(
      runtimeClaim.workspaceIdentitySha256,
    );
    const codeResult = armResult(registration, codeClaim, {
      candidateOutcome: "no_candidate",
    });
    await store.putArmResultOnce(codeResult);

    const terminal = await store.finalizeCampaignOnce(
      "2026-08-15T00:07:00.000Z",
    );
    expect(terminal.outcome).toBe("claim_supported");
    expect(M7CampaignTerminalRecordV1Schema.parse(terminal)).toEqual(terminal);
    await expect(
      store.finalizeCampaignOnce("2026-08-15T00:08:00.000Z"),
    ).rejects.toThrow(/already exists/u);
  });

  it("does not start code-only without proven runtime cleanup", async () => {
    const { root, exposed, store, registration, runtimeClaim } =
      await campaignRecords();
    await store.putArmResultOnce(
      armResult(registration, runtimeClaim, { cleanupProven: false }),
    );
    await expect(
      store.beginArmOnce(armClaimInput(registration, "code_only")),
    ).rejects.toThrow(/proven runtime-arm cleanup/u);
    const terminal = await store.finalizeCampaignOnce(
      "2026-08-15T00:07:00.000Z",
    );
    expect(terminal.outcome).toBe("cleanup_failed");
    expect(terminal.primaryOutcome).toBe("comparison_inconclusive");
    expect(terminal.primaryReason).toBe("agent_attempt_inconclusive");
    expect(
      M7CampaignTerminalRecordV1Schema.safeParse({
        ...terminal,
        primaryOutcome: null,
        primaryReason: null,
      }).success,
    ).toBe(false);
    const reopened = await openM7RuntimeUseCampaignStoreV1({
      root,
      exposedRoots: [exposed],
    });
    expect(await reopened.readTerminal()).toEqual(terminal);
  });

  it("stops after one recorded failed preflight", async () => {
    const { store } = await storeFixture();
    await store.bindCampaignSensorOnce(sensorBindingInput());
    const registration = await store.registerMutationOnce(registrationInput());
    const preflight = await store.putPreflightOnce({
      ...passedPreflightInput(),
      mutantPublicAndHiddenPassCount: 1,
    });
    expect(preflight.outcome).toBe("preflight_failed");
    await expect(
      store.beginArmOnce(armClaimInput(registration, "runtime_enabled")),
    ).rejects.toThrow(/cannot start after preflight_failed/u);
    const terminal = await store.finalizeCampaignOnce(
      "2026-08-15T00:03:00.000Z",
    );
    expect(terminal.outcome).toBe("infrastructure_failure");
    expect(terminal.reason).toBe("preflight_failed");
  });

  it("rejects exposed, symlinked, non-private, and hard-linked records", async () => {
    const { parent, root, exposed, store } = await storeFixture();
    await expect(
      openM7RuntimeUseCampaignStoreV1({
        root,
        exposedRoots: [root],
      }),
    ).rejects.toThrow(/disjoint/u);

    await chmod(root, 0o755);
    await expect(
      openM7RuntimeUseCampaignStoreV1({ root, exposedRoots: [exposed] }),
    ).rejects.toThrow(/0700/u);
    await chmod(root, 0o700);

    const linkedRoot = join(parent, "host-link");
    await symlink(root, linkedRoot);
    await expect(
      openM7RuntimeUseCampaignStoreV1({
        root: linkedRoot,
        exposedRoots: [exposed],
      }),
    ).rejects.toThrow(/real directory/u);

    const sensorBinding =
      await store.bindCampaignSensorOnce(sensorBindingInput());
    const alias = join(parent, "freeze-alias.json");
    await link(join(root, "m7.sensor-binding.json"), alias);
    await expect(store.readCampaignSensorBinding()).rejects.toThrow(
      /one-link/u,
    );
    expect(sensorBinding.recordKind).toBe("m7-campaign-sensor-binding");
  });
});

describe("M7 campaign truth table", () => {
  it("derives only the pre-registered supported comparison", async () => {
    const fixture = await campaignRecords();
    const runtime = armResult(fixture.registration, fixture.runtimeClaim);
    await fixture.store.putArmResultOnce(runtime);
    const codeClaim = await fixture.store.beginArmOnce(
      armClaimInput(fixture.registration, "code_only"),
    );
    const codeNoCandidate = armResult(fixture.registration, codeClaim, {
      candidateOutcome: "no_candidate",
    });
    expect(
      deriveM7CampaignOutcomeV1({
        preflight: fixture.preflight,
        runtimeEnabled: runtime,
        codeOnly: codeNoCandidate,
      }),
    ).toEqual({
      outcome: "claim_supported",
      reason: "runtime_advantage_observed",
      primaryOutcome: null,
      primaryReason: null,
    });

    for (const codeOnly of [
      armResult(fixture.registration, codeClaim, {
        candidateOutcome: "invalid_candidate",
      }),
      armResult(fixture.registration, codeClaim, {
        evaluatorOutcome: "rejected",
      }),
    ]) {
      expect(
        deriveM7CampaignOutcomeV1({
          preflight: fixture.preflight,
          runtimeEnabled: runtime,
          codeOnly,
        }).outcome,
      ).toBe("claim_supported");
    }
  });

  it("does not support the claim when code-only is accepted or treatment/runtime-use evidence fails", async () => {
    const fixture = await campaignRecords();
    const runtime = armResult(fixture.registration, fixture.runtimeClaim);
    await fixture.store.putArmResultOnce(runtime);
    const codeClaim = await fixture.store.beginArmOnce(
      armClaimInput(fixture.registration, "code_only"),
    );
    const codeAccepted = armResult(fixture.registration, codeClaim);

    expect(
      deriveM7CampaignOutcomeV1({
        preflight: fixture.preflight,
        runtimeEnabled: runtime,
        codeOnly: codeAccepted,
      }),
    ).toEqual({
      outcome: "claim_not_supported",
      reason: "code_only_candidate_accepted",
      primaryOutcome: null,
      primaryReason: null,
    });

    for (const failedRuntime of [
      armResult(fixture.registration, fixture.runtimeClaim, {
        runtimeUseOutcome: "missing",
      }),
      armResult(fixture.registration, fixture.runtimeClaim, {
        runtimeUseOutcome: "rejected",
      }),
      armResult(fixture.registration, fixture.runtimeClaim, {
        evaluatorOutcome: "rejected",
      }),
      armResult(fixture.registration, fixture.runtimeClaim, {
        candidateOutcome: "no_candidate",
      }),
    ]) {
      expect(
        deriveM7CampaignOutcomeV1({
          preflight: fixture.preflight,
          runtimeEnabled: failedRuntime,
          codeOnly: codeAccepted,
        }).outcome,
      ).toBe("claim_not_supported");
    }
  });

  it("keeps Agent failures inconclusive, infrastructure distinct, and cleanup dominant", async () => {
    const fixture = await campaignRecords();
    const runtime = armResult(fixture.registration, fixture.runtimeClaim);
    await fixture.store.putArmResultOnce(runtime);
    const codeClaim = await fixture.store.beginArmOnce(
      armClaimInput(fixture.registration, "code_only"),
    );
    const code = armResult(fixture.registration, codeClaim, {
      candidateOutcome: "no_candidate",
    });

    for (const loopOutcome of [
      "provider_failure",
      "timed_out",
      "aborted",
    ] as const) {
      expect(
        deriveM7CampaignOutcomeV1({
          preflight: fixture.preflight,
          runtimeEnabled: armResult(
            fixture.registration,
            fixture.runtimeClaim,
            { loopOutcome },
          ),
          codeOnly: code,
        }).outcome,
      ).toBe("comparison_inconclusive");
    }

    expect(
      deriveM7CampaignOutcomeV1({
        preflight: fixture.preflight,
        runtimeEnabled: runtime,
        codeOnly: armResult(fixture.registration, codeClaim, {
          evaluatorOutcome: "infrastructure_failed",
        }),
      }).outcome,
    ).toBe("infrastructure_failure");

    expect(
      deriveM7CampaignOutcomeV1({
        preflight: fixture.preflight,
        runtimeEnabled: armResult(fixture.registration, fixture.runtimeClaim, {
          loopOutcome: "infrastructure_failed",
        }),
        codeOnly: null,
      }).outcome,
    ).toBe("infrastructure_failure");

    expect(
      deriveM7CampaignOutcomeV1({
        preflight: fixture.preflight,
        runtimeEnabled: armResult(fixture.registration, fixture.runtimeClaim, {
          evaluatorOutcome: "infrastructure_failed",
        }),
        codeOnly: null,
      }).outcome,
    ).toBe("infrastructure_failure");

    expect(
      deriveM7CampaignOutcomeV1({
        preflight: fixture.preflight,
        runtimeEnabled: armResult(fixture.registration, fixture.runtimeClaim, {
          loopOutcome: "provider_failure",
          cleanupProven: false,
        }),
        codeOnly: null,
      }).outcome,
    ).toBe("cleanup_failed");
  });

  it("requires both arms after any cleaned runtime attempt", async () => {
    const fixture = await campaignRecords();
    const runtimeProviderFailure = armResult(
      fixture.registration,
      fixture.runtimeClaim,
      { loopOutcome: "provider_failure" },
    );
    expect(() =>
      deriveM7CampaignOutcomeV1({
        preflight: fixture.preflight,
        runtimeEnabled: runtimeProviderFailure,
        codeOnly: null,
      }),
    ).toThrow(/requires the fixed code-only arm/u);
  });

  it("binds terminal hashes to the exact supplied records", async () => {
    const fixture = await campaignRecords();
    const runtime = armResult(fixture.registration, fixture.runtimeClaim);
    await fixture.store.putArmResultOnce(runtime);
    const codeClaim = await fixture.store.beginArmOnce(
      armClaimInput(fixture.registration, "code_only"),
    );
    const code = armResult(fixture.registration, codeClaim, {
      evaluatorOutcome: "rejected",
    });
    const terminal = createM7CampaignTerminalRecordV1({
      campaignId: fixture.registration.campaignId,
      preflight: fixture.preflight,
      runtimeEnabled: runtime,
      codeOnly: code,
      completedAt: "2026-08-15T00:07:00.000Z",
    });
    expect(terminal.runtimeEnabledResultSha256).toBe(
      runtime.recordContentSha256,
    );
    expect(terminal.codeOnlyResultSha256).toBe(code.recordContentSha256);
    expect(
      M7CampaignTerminalRecordV1Schema.safeParse({
        ...terminal,
        codeOnlyResultSha256: sha("other-result"),
      }).success,
    ).toBe(false);
  });
});
