import { createHash } from "node:crypto";

import { canonicalJson } from "@chronorift/json-artifacts";
import { describe, expect, it } from "vitest";

import {
  createM7R3PairedPublicTaskContractV1,
  encodeM7R3PairedPublicTaskContractV1,
} from "./m7-r3-public-task.js";

const sha = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const task = (
  taskId: string,
  goal = "Enemies stop moving. Please fix it.",
) => ({
  schemaVersion: 1,
  taskKind: "external-hidden-fix",
  taskId,
  subjectCommit: "3e793f53598a131c53fb82555191cc14b8db07ff",
  goal,
  publicExecutionClassifier: {
    schemaVersion: 1,
    classifierId: "chronorift.generic-patrol-sequence.v1",
    implementationSha256: sha("generic public classifier"),
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

describe("M7 R3 paired public Task contract", () => {
  it("binds byte-exact matched natural Tasks with only runtime treatment differing", () => {
    const prompt = "Enemies stop moving. Please fix it.";
    const runtime = canonicalJson(task("task:r3-runtime"));
    const codeOnly = canonicalJson(task("task:r3-code-only"));
    const contract = createM7R3PairedPublicTaskContractV1({
      caseOrdinal: 2,
      subjectRepository: "https://github.com/endlessm/moddable-platformer.git",
      naturalPrompt: prompt,
      runtimeTaskSpecBytes: runtime,
      codeOnlyTaskSpecBytes: codeOnly,
    });

    expect(contract.naturalPrompt.text).toBe(prompt);
    expect(contract.runtimeUseNotRequiredByPrompt).toBe(true);
    expect(contract.runtimeTask.rawSha256).toBe(sha(runtime));
    expect(contract.codeOnlyTask.rawSha256).toBe(sha(codeOnly));
    expect(
      new TextDecoder().decode(encodeM7R3PairedPublicTaskContractV1(contract)),
    ).toBe(canonicalJson(contract));
  });

  it("rejects prompt, budget, and non-canonical byte differences", () => {
    const runtime = task("task:r3-runtime");
    const codeOnly = task("task:r3-code-only");
    expect(() =>
      createM7R3PairedPublicTaskContractV1({
        caseOrdinal: 1,
        subjectRepository:
          "https://github.com/endlessm/moddable-platformer.git",
        naturalPrompt: runtime.goal,
        runtimeTaskSpecBytes: JSON.stringify(runtime, null, 2),
        codeOnlyTaskSpecBytes: canonicalJson(codeOnly),
      }),
    ).toThrow(/canonical JSON/iu);
    expect(() =>
      createM7R3PairedPublicTaskContractV1({
        caseOrdinal: 1,
        subjectRepository:
          "https://github.com/endlessm/moddable-platformer.git",
        naturalPrompt: runtime.goal,
        runtimeTaskSpecBytes: canonicalJson(runtime),
        codeOnlyTaskSpecBytes: canonicalJson({
          ...codeOnly,
          goal: "A different instruction",
        }),
      }),
    ).toThrow(/differ only/iu);
  });
});
