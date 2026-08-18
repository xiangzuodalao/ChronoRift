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
  SandboxCleanupReceiptV1Schema,
  SecurityEventV1Schema,
} from "./contracts.js";
import type { M7R3CasePreflightReceiptV1 } from "./m7-r3-case-construction.js";
import { M7R3PreflightApiBlockerErrorV1 } from "./m7-r3-case-preflight-runner.js";
import {
  createM7R3TwoCasePortfolioFreezeV1,
  type CreateM7R3TwoCasePortfolioFreezeV1Input,
} from "./m7-r3-two-case-portfolio.js";
import {
  M7R4NoAgentPreflightTerminalV1Schema,
  openM7R4NoAgentPreflightAttemptStoreV1,
} from "./m7-r4-no-agent-preflight-attempt.js";
import {
  M7R4NoAgentLiveErrorV1,
  runAndRetainM7R4NoAgentPreflightOnceV1,
} from "./m7-r4-no-agent-live.js";

const sha = (value: string): Sha256DigestV1 =>
  asSha256DigestV1(createHash("sha256").update(value).digest("hex"));

const digestJson = (value: unknown): Sha256DigestV1 =>
  sha(canonicalJson(JsonValueSchema.parse(value)));

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

const roots = new Set<string>();

afterEach(async () => {
  await Promise.all(
    [...roots].map((root) => rm(root, { recursive: true, force: true })),
  );
  roots.clear();
});

const unstartedFixture = async () => {
  const parent = await mkdtemp(join(tmpdir(), "chronorift-r4-preflight-"));
  roots.add(parent);
  await chmod(parent, 0o700);
  const root = join(parent, "host-only");
  const exposed = join(parent, "agent-exposed");
  await Promise.all([
    mkdir(root, { mode: 0o700 }),
    mkdir(exposed, { mode: 0o700 }),
  ]);
  await Promise.all([chmod(root, 0o700), chmod(exposed, 0o700)]);
  const portfolio = createM7R3TwoCasePortfolioFreezeV1(portfolioInput());
  const store = await openM7R4NoAgentPreflightAttemptStoreV1({
    root,
    exposedRoots: [exposed],
  });
  return { parent, root, exposed, portfolio, store };
};

const fixture = async () => {
  const value = await unstartedFixture();
  const { portfolio, store } = value;
  const started = await store.createStartedOnce({
    portfolioFreeze: portfolio,
    startedAt: "2026-08-16T00:10:00.000Z",
  });
  return { ...value, started };
};

const completedReceipts = (
  portfolio: ReturnType<typeof createM7R3TwoCasePortfolioFreezeV1>,
) =>
  [
    {
      caseOrdinal: 1 as const,
      caseId: portfolio.cases[0].caseId,
      preflightReceiptSha256: sha("case-1-preflight"),
    },
    {
      caseOrdinal: 2 as const,
      caseId: portfolio.cases[1].caseId,
      preflightReceiptSha256: sha("case-2-preflight"),
    },
  ] as const;

const preflightReceipt = (
  portfolio: ReturnType<typeof createM7R3TwoCasePortfolioFreezeV1>,
  ordinal: 1 | 2,
): M7R3CasePreflightReceiptV1 =>
  ({
    ordinal,
    portfolio: {
      portfolioId: portfolio.portfolioId,
      portfolioFreezeRecordSha256: portfolio.recordContentSha256,
      caseId:
        ordinal === 1 ? portfolio.cases[0].caseId : portfolio.cases[1].caseId,
    },
    outcome: "passed",
    recordContentSha256: sha(`case-${ordinal}-preflight`),
  }) as unknown as M7R3CasePreflightReceiptV1;

const completeCleanupReceipt = SandboxCleanupReceiptV1Schema.parse({
  processGroupTerminated: true,
  cgroupPopulated: false,
  termSent: true,
  killSent: false,
  scopeRemoved: true,
  storageReconciled: true,
});

const strictSecurityEvent = SecurityEventV1Schema.parse({
  schemaVersion: 1,
  eventId: "security_1",
  taskId: "task_1",
  operationId: "operation_1",
  decision: "denied",
  code: "capability_denied",
  message: "capability denied",
  occurredAt: "2026-08-16T00:25:00.000Z",
  target: "/bin/curl",
  sideEffectStarted: false,
});

const subjectEvidence = (
  portfolio: ReturnType<typeof createM7R3TwoCasePortfolioFreezeV1>,
) =>
  [
    {
      caseOrdinal: 1 as const,
      caseId: portfolio.cases[0].caseId,
      subject: "pristine" as const,
      cleanupAttempted: false,
      cleanupProven: false,
      cleanupReceipt: null,
      cleanupReceiptSha256: null,
      securityEvents: null,
      securityEventsSha256: null,
    },
    {
      caseOrdinal: 1 as const,
      caseId: portfolio.cases[0].caseId,
      subject: "mutant" as const,
      cleanupAttempted: false,
      cleanupProven: false,
      cleanupReceipt: null,
      cleanupReceiptSha256: null,
      securityEvents: null,
      securityEventsSha256: null,
    },
    {
      caseOrdinal: 2 as const,
      caseId: portfolio.cases[1].caseId,
      subject: "pristine" as const,
      cleanupAttempted: false,
      cleanupProven: false,
      cleanupReceipt: null,
      cleanupReceiptSha256: null,
      securityEvents: null,
      securityEventsSha256: null,
    },
    {
      caseOrdinal: 2 as const,
      caseId: portfolio.cases[1].caseId,
      subject: "mutant" as const,
      cleanupAttempted: true,
      cleanupProven: true,
      cleanupReceipt: completeCleanupReceipt,
      cleanupReceiptSha256: digestJson(completeCleanupReceipt),
      securityEvents: [strictSecurityEvent],
      securityEventsSha256: digestJson([strictSecurityEvent]),
    },
  ] as const;

describe("M7 R4 no-Agent preflight attempt retention", () => {
  it("dispatches a failed no-Agent runner with zero Agent, Pi, and provider counts", async () => {
    const { root, portfolio, store } = await unstartedFixture();
    const secret = "provider secret in /host/private/runner.json";
    await expect(
      runAndRetainM7R4NoAgentPreflightOnceV1({
        portfolioFreeze: portfolio,
        attemptStore: store,
        run: async () => {
          throw new M7R4NoAgentLiveErrorV1(
            "hidden_evaluation",
            2,
            "mutant",
            [],
            subjectEvidence(portfolio),
            new M7R3PreflightApiBlockerErrorV1(
              "hidden_evaluator_port_failed",
              2,
              "mutant",
              { cause: new Error(secret) },
            ),
          );
        },
        now: (() => {
          const values = [
            "2026-08-16T00:10:00.000Z",
            "2026-08-16T00:20:00.000Z",
          ];
          return () => values.shift() ?? "2026-08-16T00:20:00.000Z";
        })(),
      }),
    ).rejects.toBeInstanceOf(M7R4NoAgentLiveErrorV1);

    const terminal = await store.readTerminal();
    expect(terminal).toMatchObject({
      status: "failed",
      agentLaunchCount: 0,
      piSessionCount: 0,
      providerInvocationCount: 0,
    });
    if (terminal.status !== "failed") {
      throw new Error("expected failed no-Agent terminal");
    }
    expect(terminal.subjectEvidence).toHaveLength(4);
    const bytes = await readFile(
      join(root, "preflight-terminal.v1.json"),
      "utf8",
    );
    expect(bytes).not.toContain(secret);
    expect(bytes).not.toMatch(/message|stack|cause|host\/private/iu);
  });

  it("retains an evaluator cleanup safety stop with exact context and completed receipt prefix", async () => {
    const { portfolio, store } = await unstartedFixture();
    const firstReceipt = preflightReceipt(portfolio, 1);
    await expect(
      runAndRetainM7R4NoAgentPreflightOnceV1({
        portfolioFreeze: portfolio,
        attemptStore: store,
        run: async () => ({
          result: {
            schemaVersion: 1,
            status: "safety_stopped",
            reason: "hidden_evaluator_cleanup_not_proven",
            stoppedAfter: {
              ordinal: 2,
              subject: "mutant",
              scenarioId: "hidden_variant:2",
            },
            agentLaunchCount: 0,
            providerInvocationCount: 0,
            piSessionCount: 0,
            receipts: [firstReceipt],
          },
          completedReceipts: [firstReceipt],
          subjectEvidence: subjectEvidence(portfolio),
        }),
        now: (() => {
          const values = [
            "2026-08-16T00:10:00.000Z",
            "2026-08-16T00:20:00.000Z",
          ];
          return () => values.shift() ?? "2026-08-16T00:20:00.000Z";
        })(),
      }),
    ).rejects.toMatchObject({
      stage: "cleanup",
      caseOrdinal: 2,
      subject: "mutant",
    });

    const terminal = await store.readTerminal();
    expect(terminal).toMatchObject({
      status: "failed",
      failure: {
        stage: "cleanup",
        caseOrdinal: 2,
        subject: "mutant",
      },
      preflightReceipts: [completedReceipts(portfolio)[0]],
      agentLaunchCount: 0,
      piSessionCount: 0,
      providerInvocationCount: 0,
    });
  });

  it("durably binds one started record to one passed terminal and both case receipts", async () => {
    const { root, portfolio, store, started } = await fixture();
    const terminal = await store.createPassedTerminalOnce({
      started,
      preflightReceipts: completedReceipts(portfolio),
      completedAt: "2026-08-16T00:20:00.000Z",
    });

    expect(terminal).toMatchObject({
      status: "passed",
      portfolioId: portfolio.portfolioId,
      portfolioFreezeRecordSha256: portfolio.recordContentSha256,
      startedRecordContentSha256: started.recordContentSha256,
      agentLaunchCount: 0,
      piSessionCount: 0,
      providerInvocationCount: 0,
      preflightReceipts: completedReceipts(portfolio),
    });
    await expect(store.readStarted()).resolves.toEqual(started);
    await expect(store.readTerminal()).resolves.toEqual(terminal);

    for (const name of [
      "preflight-started.v1.json",
      "preflight-terminal.v1.json",
    ]) {
      const metadata = await lstat(join(root, name));
      expect(metadata.isFile()).toBe(true);
      expect(metadata.mode & 0o7777).toBe(0o600);
      expect(metadata.nlink).toBe(1);
    }
    await expect(
      store.createStartedOnce({
        portfolioFreeze: portfolio,
        startedAt: "2026-08-16T00:21:00.000Z",
      }),
    ).rejects.toThrow(/already exists/iu);
    await expect(
      store.createPassedTerminalOnce({
        started,
        preflightReceipts: completedReceipts(portfolio),
        completedAt: "2026-08-16T00:22:00.000Z",
      }),
    ).rejects.toThrow(/already exists/iu);
  });

  it("retains a typed blocker without its cause, message, stack, or path", async () => {
    const { root, portfolio, store, started } = await fixture();
    const secret = "provider secret in /host/private/session.json";
    const terminal = await store.createFailedTerminalOnce({
      started,
      stage: "hidden_evaluation",
      caseOrdinal: 2,
      subject: "mutant",
      error: new M7R3PreflightApiBlockerErrorV1(
        "hidden_evaluator_port_failed",
        2,
        "mutant",
        { cause: new Error(secret) },
      ),
      completedPreflightReceipts: [completedReceipts(portfolio)[0]],
      agentLaunchCount: 0,
      piSessionCount: 0,
      providerInvocationCount: 0,
      subjectEvidence: subjectEvidence(portfolio),
      completedAt: "2026-08-16T00:30:00.000Z",
    });

    expect(terminal).toMatchObject({
      status: "failed",
      failure: {
        stage: "hidden_evaluation",
        caseOrdinal: 2,
        subject: "mutant",
        blockerCode: "hidden_evaluator_port_failed",
        errorClassSha256: null,
      },
      preflightReceipts: [completedReceipts(portfolio)[0]],
    });
    expect(terminal.subjectEvidence[3]).toMatchObject({
      caseOrdinal: 2,
      subject: "mutant",
      cleanup: {
        attempted: true,
        cleanupProven: true,
        receipt: completeCleanupReceipt,
        receiptSha256: digestJson(completeCleanupReceipt),
      },
      security: {
        available: true,
        eventsSha256: digestJson([strictSecurityEvent]),
        events: [
          {
            eventId: strictSecurityEvent.eventId,
            taskId: strictSecurityEvent.taskId,
            operationId: strictSecurityEvent.operationId,
            code: strictSecurityEvent.code,
            occurredAt: strictSecurityEvent.occurredAt,
            sideEffectStarted: false,
          },
        ],
      },
    });
    const bytes = await readFile(
      join(root, "preflight-terminal.v1.json"),
      "utf8",
    );
    expect(bytes).not.toContain(secret);
    expect(bytes).not.toMatch(/message|stack|cause|host\/private/iu);
    expect(bytes).not.toMatch(/target|\/bin\/curl/iu);
    expect(() =>
      M7R4NoAgentPreflightTerminalV1Schema.parse(JSON.parse(bytes)),
    ).not.toThrow();
  });

  it("hashes only the class of an untyped failure and preserves measured counters", async () => {
    const { portfolio, store, started } = await fixture();
    const terminal = await store.createFailedTerminalOnce({
      started,
      stage: "cleanup",
      caseOrdinal: 1,
      subject: "pristine",
      error: new TypeError("credential abc in /tmp/private"),
      completedPreflightReceipts: [],
      agentLaunchCount: 1,
      piSessionCount: 2,
      providerInvocationCount: 3,
      subjectEvidence: subjectEvidence(portfolio),
      completedAt: "2026-08-16T00:31:00.000Z",
    });

    expect(terminal).toMatchObject({
      failure: {
        blockerCode: null,
        errorClassSha256: sha("TypeError"),
      },
      agentLaunchCount: 1,
      piSessionCount: 2,
      providerInvocationCount: 3,
    });
    expect(JSON.stringify(terminal)).not.toMatch(/credential|tmp\/private/iu);
  });

  it.each([
    ["prepare", null, "pristine"],
    ["public_observation", 1, null],
    ["hidden_evaluation", null, "mutant"],
    ["receipt_persistence", 2, "pristine"],
  ] as const)(
    "rejects incoherent %s stage context before writing a terminal",
    async (stage, caseOrdinal, subject) => {
      const { root, portfolio, store, started } = await fixture();
      await expect(
        store.createFailedTerminalOnce({
          started,
          stage,
          caseOrdinal,
          subject,
          error: new Error("not persisted"),
          completedPreflightReceipts: [],
          agentLaunchCount: 0,
          piSessionCount: 0,
          providerInvocationCount: 0,
          subjectEvidence: subjectEvidence(portfolio),
          completedAt: "2026-08-16T00:32:00.000Z",
        }),
      ).rejects.toThrow();
      await expect(
        lstat(join(root, "preflight-terminal.v1.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("rejects blocker identity substitution before writing a terminal", async () => {
    const { root, portfolio, store, started } = await fixture();
    await expect(
      store.createFailedTerminalOnce({
        started,
        stage: "public_observation",
        caseOrdinal: 1,
        subject: "pristine",
        error: new M7R3PreflightApiBlockerErrorV1(
          "project_environment_port_failed",
          2,
          "mutant",
        ),
        completedPreflightReceipts: [],
        agentLaunchCount: 0,
        piSessionCount: 0,
        providerInvocationCount: 0,
        subjectEvidence: subjectEvidence(portfolio),
        completedAt: "2026-08-16T00:33:00.000Z",
      }),
    ).rejects.toThrow(/blocker.*context/iu);
    await expect(
      lstat(join(root, "preflight-terminal.v1.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects non-private, symlinked, overlapping, and later hard-linked storage", async () => {
    const parent = await mkdtemp(join(tmpdir(), "chronorift-r4-integrity-"));
    roots.add(parent);
    await chmod(parent, 0o700);
    const badMode = join(parent, "bad-mode");
    const real = join(parent, "real");
    const alias = join(parent, "alias");
    await Promise.all([
      mkdir(badMode, { mode: 0o755 }),
      mkdir(real, { mode: 0o700 }),
    ]);
    await Promise.all([chmod(badMode, 0o755), chmod(real, 0o700)]);
    await symlink(real, alias);

    await expect(
      openM7R4NoAgentPreflightAttemptStoreV1({
        root: badMode,
        exposedRoots: [],
      }),
    ).rejects.toThrow(/0700/iu);
    await expect(
      openM7R4NoAgentPreflightAttemptStoreV1({
        root: alias,
        exposedRoots: [],
      }),
    ).rejects.toThrow(/canonical|real directory/iu);
    await expect(
      openM7R4NoAgentPreflightAttemptStoreV1({
        root: real,
        exposedRoots: [real],
      }),
    ).rejects.toThrow(/disjoint/iu);

    const store = await openM7R4NoAgentPreflightAttemptStoreV1({
      root: real,
      exposedRoots: [],
    });
    await store.createStartedOnce({
      portfolioFreeze: createM7R3TwoCasePortfolioFreezeV1(portfolioInput()),
      startedAt: "2026-08-16T00:40:00.000Z",
    });
    await link(
      join(real, "preflight-started.v1.json"),
      join(parent, "started-hardlink.json"),
    );
    await expect(store.readStarted()).rejects.toThrow(/one-link/iu);
  });
});
