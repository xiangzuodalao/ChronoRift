import { createHash } from "node:crypto";

import { canonicalJson } from "@chronorift/json-artifacts";
import { describe, expect, it } from "vitest";

import {
  createM7R3PairedPublicTaskContractV1,
  encodeM7R3PairedPublicTaskContractV1,
} from "./m7-r3-public-task.js";
import {
  assertM7R4NoAgentHostConfigBindingsV1,
  m7R4RunOutputRootsForModeV1,
  verifyM7R4PromptTaskContractV1,
} from "./m7-r4-live-materials.js";

const sha = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const task = (taskId: string, goal: string) => ({
  schemaVersion: 1,
  taskKind: "external-hidden-fix",
  taskId,
  subjectCommit: "3e793f53598a131c53fb82555191cc14b8db07ff",
  goal,
  publicExecutionClassifier: {
    schemaVersion: 1,
    classifierId: "chronorift.generic-patrol-sequence.v1",
    implementationSha256: sha("classifier"),
  },
  agentBudget: {
    provider: "openai-codex",
    model: "gpt-5.6-luna",
    thinkingLevel: "max",
    attemptsMaximum: 1,
    userTurnsPerAttemptMaximum: 1,
    toolCallsMaximum: 128,
    wallTimeMsMaximum: 900_000,
    taskSandboxNetworkMode: "denied",
    taskCredentialMountCountMaximum: 0,
  },
  evaluatorBudget: {
    scenarioClasses: [
      "public_reproduction",
      "hidden_variant",
      "regression_control",
    ],
    repetitionsPerScenario: 3,
    plannedRunCount: 9,
    evaluatorProcessAttemptsPerRunMaximum: 1,
    freshWorkspacePerRun: true,
    freshImportCachePerRun: true,
    freshEvaluatorProcessPerRun: true,
    agentRelaunchCountMaximum: 0,
    wallTimeMsPerRunMaximum: 120_000,
  },
});

const fixture = () => {
  const prompt = "Patrolling enemies accelerate unexpectedly. Please fix it.";
  const runtimeBytes = Buffer.from(
    canonicalJson(task("task:m7-r3-case-01-runtime", prompt)),
  );
  const codeOnlyBytes = Buffer.from(
    canonicalJson(task("task:m7-r3-case-01-code-only", prompt)),
  );
  const contract = createM7R3PairedPublicTaskContractV1({
    caseOrdinal: 1,
    subjectRepository: "https://github.com/endlessm/moddable-platformer.git",
    naturalPrompt: prompt,
    runtimeTaskSpecBytes: runtimeBytes,
    codeOnlyTaskSpecBytes: codeOnlyBytes,
  });
  return {
    prompt,
    runtimeBytes,
    codeOnlyBytes,
    contractBytes: encodeM7R3PairedPublicTaskContractV1(contract),
  };
};

describe("M7 R4 live material prompt binding", () => {
  it("accepts one manifest-driven prompt shared by both frozen Tasks", () => {
    const value = fixture();
    const verified = verifyM7R4PromptTaskContractV1({
      ordinal: 1,
      promptBytes: Buffer.from(`${value.prompt}\n`),
      runtimeTaskBytes: value.runtimeBytes,
      codeOnlyTaskBytes: value.codeOnlyBytes,
      pairedTaskContractBytes: value.contractBytes,
    });
    expect(verified.prompt).toBe(value.prompt);
    expect(verified.runtimeTask.goal).toBe(verified.codeOnlyTask.goal);
  });

  it("rejects a prompt substituted independently of Tasks and contract", () => {
    const value = fixture();
    expect(() =>
      verifyM7R4PromptTaskContractV1({
        ordinal: 1,
        promptBytes: Buffer.from("A substituted diagnosis.\n"),
        runtimeTaskBytes: value.runtimeBytes,
        codeOnlyTaskBytes: value.codeOnlyBytes,
        pairedTaskContractBytes: value.contractBytes,
      }),
    ).toThrow(/differ|disagree/iu);
  });
});

describe("M7 R4 physical output namespace selection", () => {
  it.each([
    [
      "no-agent-preflight",
      "/run/no-agent-preflight/construction",
      "/run/no-agent-preflight/portfolio",
      "/permanent/no-agent-attempt",
    ],
    [
      "pre-agent-dry-run",
      "/construction",
      "/run/portfolio",
      "/permanent/no-agent-attempt",
    ],
    [
      "r4-live",
      "/construction",
      "/run/portfolio",
      "/run/run-control/formal-preflight-attempt",
    ],
  ] as const)(
    "selects isolated roots for %s",
    (
      mode,
      expectedConstruction,
      expectedPortfolio,
      expectedPreflightAttempt,
    ) => {
      expect(
        m7R4RunOutputRootsForModeV1({
          mode,
          declaredConstructionRoot: "/construction",
          declaredPreflightAttemptRoot: "/permanent/no-agent-attempt",
          runsRoot: "/run",
        }),
      ).toEqual({
        constructionRoot: expectedConstruction,
        portfolioRoot: expectedPortfolio,
        preflightAttemptRoot: expectedPreflightAttempt,
      });
    },
  );
});

describe("M7 R4 no-Agent Host config binding", () => {
  it("rejects case-swapped no-Agent Host config paths", () => {
    const operationalHostConfigs = {
      noAgentPreflightHostConfigPaths: [
        "/operational/case-01.json",
        "/operational/case-02.json",
      ],
    } as const;
    expect(() =>
      assertM7R4NoAgentHostConfigBindingsV1({
        operationalHostConfigs,
        cases: [
          {
            ordinal: 1,
            noAgentHostConfigPath: "/operational/case-02.json",
          },
          {
            ordinal: 2,
            noAgentHostConfigPath: "/operational/case-01.json",
          },
        ],
      }),
    ).toThrow(/crossed.*ordinal/iu);
  });
});
