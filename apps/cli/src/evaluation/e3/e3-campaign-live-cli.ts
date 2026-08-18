import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { runE3CampaignLiveFromEnvironmentV1 } from "./conformance-runner.js";

const fail = (message: string): never => {
  throw new Error(`E3.1 live Gate failed: ${message}`);
};

export const runE3CampaignLiveCliV1 = async (): Promise<void> => {
  const result = await runE3CampaignLiveFromEnvironmentV1();
  const expectedCases = [
    {
      caseId: "early_complete",
      primaryOutcome: "conformance_complete",
    },
    {
      caseId: "deadline_incomplete",
      primaryOutcome: "incomplete_unknown",
    },
    {
      caseId: "deadline_cleanup_unproven_with_late_cleanup",
      primaryOutcome: "cleanup_unproven",
    },
  ];
  const actualCases = result.cases.map(({ caseId, primaryOutcome }) => ({
    caseId,
    primaryOutcome,
  }));
  if (
    result.summary.capability !== "campaign_denominator_conformance" ||
    result.summary.campaignPurpose !== "registrar_conformance" ||
    result.summary.claimEligible !== false ||
    result.summary.modelCalls !== 0 ||
    result.summary.evaluatorRuns !== 0 ||
    result.primaryOutcome !== "conformance_complete" ||
    JSON.stringify(actualCases) !== JSON.stringify(expectedCases)
  ) {
    fail("validated suite result does not match the frozen conformance matrix");
  }
  process.stdout.write(result.validatorOutput);
};

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  pathToFileURL(resolve(invokedPath)).href === import.meta.url
) {
  try {
    await runE3CampaignLiveCliV1();
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown failure";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
