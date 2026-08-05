import { describe, expect, it } from "vitest";

import {
  V032_LUNA_CAMPAIGN,
  V032_LUNA_R1_CAMPAIGN,
  V032_LUNA_R2_CAMPAIGN,
  formalCampaignForIdV3,
} from "./v03-formal-suite.js";

describe("formal Benchmark V3 campaign descriptors", () => {
  it("keeps each Luna execution identity and evidence directory isolated", () => {
    expect(formalCampaignForIdV3()).toBe(V032_LUNA_CAMPAIGN);
    expect(formalCampaignForIdV3("v0.3.2-luna-r1")).toBe(V032_LUNA_R1_CAMPAIGN);
    expect(formalCampaignForIdV3("v0.3.2-luna-r2")).toEqual({
      campaignId: "v0.3.2-luna-r2",
      freezeTag: "v0.3.2-luna-r2-benchmark-freeze",
      evidenceDirectory: "docs/benchmarks/v0.3.2-luna-r2",
      orderSeed: "chronorift-v0.3.2-luna-r2-formal-1",
    });

    const descriptors = [
      V032_LUNA_CAMPAIGN,
      V032_LUNA_R1_CAMPAIGN,
      V032_LUNA_R2_CAMPAIGN,
    ];
    expect(new Set(descriptors.map(({ campaignId }) => campaignId)).size).toBe(
      descriptors.length,
    );
    expect(new Set(descriptors.map(({ freezeTag }) => freezeTag)).size).toBe(
      descriptors.length,
    );
    expect(
      new Set(descriptors.map(({ evidenceDirectory }) => evidenceDirectory))
        .size,
    ).toBe(descriptors.length);
    expect(new Set(descriptors.map(({ orderSeed }) => orderSeed)).size).toBe(
      descriptors.length,
    );
  });
});
