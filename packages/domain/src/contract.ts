import { z } from "zod";

import { ContractIdSchema, type ContractId } from "./ids.js";
import {
  PropertyEqualsPredicateSchema,
  SignalPredicateSchema,
  type PropertyEqualsPredicate,
  type SignalPredicate,
} from "./invariant.js";

/**
 * The only executable contract supported by the v0.1 vertical slice.
 *
 * `contractId` is the canonical content hash assigned by the Harness. The
 * authority marker is data, but the Harness must still verify the hash before
 * accepting the contract as an oracle.
 */
export interface FrozenContract {
  readonly schemaVersion: 1;
  readonly contractId: ContractId;
  readonly fixture: "switch-door";
  readonly authority: {
    readonly status: "frozen";
    readonly approvedBy: string;
  };
  readonly rule: {
    readonly trigger: SignalPredicate;
    readonly expectation: PropertyEqualsPredicate;
    readonly withinTicks: 1;
    readonly inclusive: true;
  };
}

export const FrozenContractSchema: z.ZodType<FrozenContract> = z
  .object({
    schemaVersion: z.literal(1),
    contractId: ContractIdSchema,
    fixture: z.literal("switch-door"),
    authority: z
      .object({
        status: z.literal("frozen"),
        approvedBy: z.string().min(1),
      })
      .strict(),
    rule: z
      .object({
        trigger: SignalPredicateSchema,
        expectation: PropertyEqualsPredicateSchema,
        withinTicks: z.literal(1),
        inclusive: z.literal(true),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    const expected = {
      source: "switch",
      signal: "switch.activated",
      path: "door.open",
    } as const;
    if (
      value.rule.trigger.source !== expected.source ||
      value.rule.trigger.name !== expected.signal
    ) {
      context.addIssue({
        code: "custom",
        message: "v0.1 freezes the trigger to switch/switch.activated",
        path: ["rule", "trigger"],
      });
    }
    if (
      value.rule.expectation.path !== expected.path ||
      value.rule.expectation.value !== true
    ) {
      context.addIssue({
        code: "custom",
        message: "v0.1 freezes the expectation to door.open === true",
        path: ["rule", "expectation"],
      });
    }
  });
