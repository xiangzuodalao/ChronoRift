import { readFile } from "node:fs/promises";

import { asSha256DigestV1 } from "@chronorift/domain";
import { expect, describe, it } from "vitest";

import { SandboxCleanupReceiptV1Schema } from "./contracts.js";
import { M7R3PreflightApiBlockerErrorV1 } from "./m7-r3-case-preflight-runner.js";
import type { M7R3PortfolioCaseConstructionProjectionV1 } from "./m7-r3-case-construction.js";
import type { M7R3TwoCasePortfolioFreezeV1 } from "./m7-r3-two-case-portfolio.js";
import {
  M7R4NoAgentLiveErrorV1,
  cleanupM7R4NoAgentPreparedResourcesV1,
  m7R4PortfolioCaseMatchesConstructionProjectionV1,
  m7R4DigestJsonForTestingV1,
  runM7R4NoAgentPreflightCoreV1,
} from "./m7-r4-no-agent-live.js";

const cleanupReceipt = SandboxCleanupReceiptV1Schema.parse({
  processGroupTerminated: true,
  cgroupPopulated: false,
  termSent: true,
  killSent: false,
  scopeRemoved: true,
  storageReconciled: true,
});

const provenCleanup = () => ({
  schemaVersion: 1 as const,
  cleanupProven: true,
  subjects: {
    pristine: {
      attempted: true,
      cleanupProven: true,
      cleanupReceipt,
      cleanupReceiptSha256: m7R4DigestJsonForTestingV1(cleanupReceipt),
      securityEvents: [],
      securityEventsSha256: m7R4DigestJsonForTestingV1([]),
    },
    mutant: {
      attempted: true,
      cleanupProven: true,
      cleanupReceipt,
      cleanupReceiptSha256: m7R4DigestJsonForTestingV1(cleanupReceipt),
      securityEvents: [],
      securityEventsSha256: m7R4DigestJsonForTestingV1([]),
    },
  },
});

describe("M7 R4 no-Agent preflight lifecycle", () => {
  it("cleans the bounded evaluator before PE resources and fails closed on evaluator debt", async () => {
    const calls: string[] = [];
    await expect(
      cleanupM7R4NoAgentPreparedResourcesV1({
        evaluator: {
          cleanup: async () => {
            calls.push("evaluator");
            return {
              schemaVersion: 1,
              runCount: 1,
              activeRunCount: 0,
              cleanupProven: false,
            };
          },
        },
        projectEnvironment: {
          cleanup: async () => {
            calls.push("project-environment");
            return provenCleanup();
          },
        },
      }),
    ).rejects.toThrow(/cleanup was not proven/iu);
    expect(calls).toEqual(["evaluator", "project-environment"]);
  });

  it("compares only construction-projection fields and rejects a substituted field", () => {
    const projection = {
      subject: { selected: "pristine" },
      mutant: { selected: "mutant" },
      naturalPromptUtf8Sha256: "1".repeat(64),
    } as unknown as M7R3PortfolioCaseConstructionProjectionV1;
    const frozenCase = {
      schemaVersion: 1,
      ordinal: 1,
      caseId: "m7-r3-case:111111111111111111111111",
      ...projection,
    } as unknown as M7R3TwoCasePortfolioFreezeV1["cases"][number];

    expect(
      m7R4PortfolioCaseMatchesConstructionProjectionV1({
        projection,
        frozenCase,
      }),
    ).toBe(true);
    expect(
      m7R4PortfolioCaseMatchesConstructionProjectionV1({
        projection,
        frozenCase: {
          ...frozenCase,
          naturalPromptUtf8Sha256: asSha256DigestV1("2".repeat(64)),
        },
      }),
    ).toBe(false);
  });

  it("prepares both cases in order, invokes the shared runner once, and retains four cleanup inputs", async () => {
    const calls: string[] = [];
    let failure: unknown;
    try {
      await runM7R4NoAgentPreflightCoreV1({
        cases: [
          {
            ordinal: 1,
            caseId: "m7-r3-case:111111111111111111111111",
            prepare: async () => {
              calls.push("prepare:1");
              return 1;
            },
            cleanup: async () => {
              calls.push("cleanup:1");
              return provenCleanup();
            },
          },
          {
            ordinal: 2,
            caseId: "m7-r3-case:222222222222222222222222",
            prepare: async () => {
              calls.push("prepare:2");
              return 2;
            },
            cleanup: async () => {
              calls.push("cleanup:2");
              return provenCleanup();
            },
          },
        ],
        runPrepared: async (prepared) => {
          calls.push(`runner:${prepared.join(",")}`);
          throw new M7R3PreflightApiBlockerErrorV1(
            "hidden_evaluator_port_failed",
            2,
            "mutant",
          );
        },
        readCompletedReceipts: async () => ({ receipts: [], failure: null }),
      });
    } catch (error) {
      failure = error;
    }

    expect(calls).toEqual([
      "prepare:1",
      "prepare:2",
      "runner:1,2",
      "cleanup:1",
      "cleanup:2",
    ]);
    expect(failure).toBeInstanceOf(M7R4NoAgentLiveErrorV1);
    if (!(failure instanceof M7R4NoAgentLiveErrorV1)) {
      throw new Error("expected structured R4 no-Agent failure");
    }
    expect(failure).toMatchObject({
      stage: "hidden_evaluation",
      caseOrdinal: 2,
      subject: "mutant",
    });
    expect(failure.subjectEvidence).toHaveLength(4);
    expect(
      failure.subjectEvidence.every(
        (value) => value.cleanupAttempted && value.cleanupProven,
      ),
    ).toBe(true);
  });

  it("attributes a second-case preparation failure and still cleans the prepared first case", async () => {
    const calls: string[] = [];
    let failure: unknown;
    try {
      await runM7R4NoAgentPreflightCoreV1({
        cases: [
          {
            ordinal: 1,
            caseId: "m7-r3-case:111111111111111111111111",
            prepare: async () => {
              calls.push("prepare:1");
              return 1;
            },
            cleanup: async () => {
              calls.push("cleanup:1");
              return provenCleanup();
            },
          },
          {
            ordinal: 2,
            caseId: "m7-r3-case:222222222222222222222222",
            prepare: async () => {
              calls.push("prepare:2");
              throw new Error("evaluator open failed");
            },
            cleanup: async () => {
              calls.push("cleanup:2");
              return provenCleanup();
            },
          },
        ],
        runPrepared: async () => {
          throw new Error("runner must not start");
        },
        readCompletedReceipts: async () => ({ receipts: [], failure: null }),
      });
    } catch (error) {
      failure = error;
    }

    expect(calls).toEqual(["prepare:1", "prepare:2", "cleanup:1"]);
    expect(failure).toBeInstanceOf(M7R4NoAgentLiveErrorV1);
    if (!(failure instanceof M7R4NoAgentLiveErrorV1)) {
      throw new Error("expected structured R4 no-Agent failure");
    }
    expect(failure).toMatchObject({
      stage: "prepare",
      caseOrdinal: 2,
      subject: null,
    });
    expect(failure.subjectEvidence.slice(0, 2)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          cleanupAttempted: true,
          cleanupProven: true,
        }),
      ]),
    );
    expect(failure.subjectEvidence.slice(2)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          cleanupAttempted: false,
          cleanupProven: false,
        }),
      ]),
    );
  });

  it("keeps four cleanup inputs when reopening retained receipts fails", async () => {
    let failure: unknown;
    try {
      await runM7R4NoAgentPreflightCoreV1({
        cases: [
          {
            ordinal: 1,
            caseId: "m7-r3-case:111111111111111111111111",
            prepare: async () => 1,
            cleanup: async () => provenCleanup(),
          },
          {
            ordinal: 2,
            caseId: "m7-r3-case:222222222222222222222222",
            prepare: async () => 2,
            cleanup: async () => provenCleanup(),
          },
        ],
        runPrepared: async () => ({
          schemaVersion: 1,
          status: "safety_stopped",
          reason: "hidden_evaluator_cleanup_not_proven",
          stoppedAfter: {
            ordinal: 1,
            subject: "pristine",
            scenarioId: "scenario_1",
          },
          agentLaunchCount: 0,
          providerInvocationCount: 0,
          piSessionCount: 0,
          receipts: [],
        }),
        readCompletedReceipts: async () => {
          throw new Error("corrupt retained receipt at /private/path");
        },
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(M7R4NoAgentLiveErrorV1);
    if (!(failure instanceof M7R4NoAgentLiveErrorV1)) {
      throw new Error("expected structured R4 no-Agent failure");
    }
    expect(failure).toMatchObject({
      stage: "receipt_persistence",
      caseOrdinal: 1,
      subject: null,
    });
    expect(failure.subjectEvidence).toHaveLength(4);
    expect(
      failure.subjectEvidence.every(
        (value) => value.cleanupAttempted && value.cleanupProven,
      ),
    ).toBe(true);
  });

  it("reuses phase-one assignments instead of creating a second assignment", async () => {
    const source = await readFile(
      new URL("./m7-r4-no-agent-live.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toContain("prepareExternalHiddenFixAssignmentV1");
    expect(source).toContain("input.phaseOne.assignment");
    expect(source).not.toContain(
      "hostConfigPath: materials.noAgentHostConfigPath",
    );
    expect(source).toContain("m7R3OperationalHostConfigPathsForCaseV1(");
    expect(source).toContain(
      "CgroupBwrapExternalHiddenFixEvaluatorProcessV1.open",
    );
    expect(source).toMatch(
      /assertTaskStorageHeadroom:\s*projectEnvironment\.assertTaskStorageHeadroom/u,
    );
    expect(source).toContain("materials.preflightEvaluatorTemporaryRoot");
    expect(source).not.toMatch(
      /\bBwrapExternalHiddenFixEvaluatorProcessV1\.open/u,
    );
  });
});
