interface RuntimeObservationReceiptSelectionInput {
  readonly receiptId: string;
  readonly outcome: "succeeded" | "incomplete";
}

/**
 * Selects the ordinary runtime receipt that is safe to hand to a caller as
 * positive evidence. Every receipt remains immutable in the Task store, but a
 * later exploratory or incomplete Execution must not hide an earlier complete
 * one in the Preview's single convenience field.
 */
export const selectDeliveredRuntimeObservationReceiptId = (
  current: string | undefined,
  receipt: RuntimeObservationReceiptSelectionInput,
): string | undefined =>
  receipt.outcome === "succeeded" ? receipt.receiptId : current;
