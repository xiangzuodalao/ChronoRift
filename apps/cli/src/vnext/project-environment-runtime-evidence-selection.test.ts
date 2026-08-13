import { describe, expect, it } from "vitest";

import { selectDeliveredRuntimeObservationReceiptId } from "./project-environment-runtime-evidence-selection.js";

describe("selectDeliveredRuntimeObservationReceiptId", () => {
  it("does not let a later incomplete V1 Execution hide prior success", () => {
    const receipt = {
      receiptId: "runtime-observation-receipt.v1.incomplete",
      outcome: "incomplete" as const,
    };
    expect(
      selectDeliveredRuntimeObservationReceiptId(
        "runtime-observation-receipt.v1.complete",
        receipt,
      ),
    ).toBe("runtime-observation-receipt.v1.complete");
  });

  it("does not expose an incomplete V2 Execution as positive evidence", () => {
    const receipt = {
      receiptId: "runtime-observation-receipt.v2.incomplete",
      outcome: "incomplete" as const,
    };
    expect(selectDeliveredRuntimeObservationReceiptId(undefined, receipt)).toBe(
      undefined,
    );
  });

  it("advances to each later successful Execution", () => {
    expect(
      selectDeliveredRuntimeObservationReceiptId(
        "runtime-observation-receipt.v2.first",
        {
          receiptId: "runtime-observation-receipt.v2.second",
          outcome: "succeeded",
        },
      ),
    ).toBe("runtime-observation-receipt.v2.second");
  });
});
