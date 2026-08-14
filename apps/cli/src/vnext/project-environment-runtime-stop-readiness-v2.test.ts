import { describe, expect, it } from "vitest";

import {
  projectEnvironmentRuntimeStopMissingEvidenceV2,
  projectEnvironmentRuntimeStopReadinessSummaryV2,
} from "./project-environment-runtime-stop-readiness-v2.js";

describe("projectEnvironmentRuntimeStopMissingEvidenceV2", () => {
  it("reports each remediable missing observation before shutdown", () => {
    expect(
      projectEnvironmentRuntimeStopMissingEvidenceV2({
        dynamicTraceCount: 1,
        entityRows: 2,
        stateRows: 2,
        eventRows: 0,
        captureWindowCount: 0,
      }),
    ).toEqual(["nonempty event query", "durable pinned capture"]);
  });

  it("permits stop only after the complete PE-B evidence set exists", () => {
    expect(
      projectEnvironmentRuntimeStopMissingEvidenceV2({
        dynamicTraceCount: 1,
        entityRows: 2,
        stateRows: 4,
        eventRows: 2,
        captureWindowCount: 1,
      }),
    ).toEqual([]);
  });

  it("formats bounded actionable status without hiding counters", () => {
    expect(
      projectEnvironmentRuntimeStopReadinessSummaryV2({
        dynamicTraceCount: 1,
        entityRows: 2,
        stateRows: 4,
        eventRows: 0,
        captureWindowCount: 1,
      }),
    ).toBe(
      "PE-B stop readiness incomplete; dynamicTraces=1; entityRows=2; stateRows=4; eventRows=0; pinnedCaptures=1; missing=nonempty event query",
    );
  });
});
