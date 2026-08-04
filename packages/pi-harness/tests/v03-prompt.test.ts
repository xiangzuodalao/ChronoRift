import { describe, expect, it } from "vitest";

import {
  auditV03BlindPrompt,
  buildV03BlindSystemPrompt,
  buildV03BlindUserPrompt,
  v03FailureBriefReceiptId,
} from "../src/index.js";
import { FailureBriefV1Schema } from "@chronorift/domain";

const brief = {
  schemaVersion: 1,
  runId: "run:opaque-03",
  fixtureId: "godot-runtime-case-03",
  contractId: "contract:opaque",
  capsuleId: "capsule:opaque",
  baselineExecutionId: "execution:opaque",
  trigger: { kind: "signal", source: "subject", name: "subject.triggered" },
  triggerEventId: "event:opaque",
  triggerTick: 0,
  expectation: { kind: "property_equals", path: "subject.result", value: true },
  deadlineTick: 3,
  actual: { present: true, value: false },
  violationSummary: "subject.result did not satisfy the frozen Contract",
} as const;
const parsedBrief = FailureBriefV1Schema.parse(brief);

describe("v0.3 blind benchmark prompts", () => {
  it("contains no treatment label or semantic Fixture filename", () => {
    const prompts = [
      buildV03BlindSystemPrompt(),
      buildV03BlindUserPrompt(brief, v03FailureBriefReceiptId(parsedBrief)),
    ];
    for (const text of prompts) {
      expect(text).not.toMatch(/generic|evidence-only|chronorift-full/iu);
      expect(text).not.toMatch(
        /signal-ordering|frame-input-window|physics-tunneling|entity-reuse/iu,
      );
    }
  });

  it("is byte-identical when the same Failure Brief is assigned to any arm", () => {
    const audits = ["generic", "evidence-only", "chronorift-full"].map(() =>
      auditV03BlindPrompt(parsedBrief),
    );
    expect(new Set(audits.map((audit) => audit.failureBriefHash))).toHaveLength(
      1,
    );
    expect(new Set(audits.map((audit) => audit.systemHash))).toHaveLength(1);
    expect(new Set(audits.map((audit) => audit.userHash))).toHaveLength(1);
    expect(
      new Set(audits.map((audit) => audit.failureBriefReceiptId)),
    ).toHaveLength(1);
  });
});
