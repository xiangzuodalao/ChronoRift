import { describe, expect, it } from "vitest";
import {
  InspectionWatchInputV1Schema,
  InspectionWatchReadInputV1Schema,
  InspectionWatchReadOutputV1Schema,
  InspectionWatchRecordV1Schema,
  InspectionWatchArchiveV1Schema,
  INSPECTION_WATCH_PHASE_V1,
  inspectionWatchRecordBytesV1,
  paginateInspectionWatchArchiveV1,
} from "../src/index.js";

const target = { objectRef: "run:one:object:1", className: "Node", path: "." };
const start = {
  schemaVersion: 1,
  action: "start",
  executionId: "run:one",
  targets: [{ target: { path: "." }, names: ["value"] }],
  sampleCount: 3,
};
const state = {
  schemaVersion: 1 as const,
  executionId: "run:one",
  watchId: "run:one:watch:1",
  phase: INSPECTION_WATCH_PHASE_V1,
  status: "stopped" as const,
  stopReason: "sample_count" as const,
  sampleCount: 3,
  recordedCount: 3,
  boundTargets: [{ target, names: ["value"] }],
};
const record = (sequence: number) => ({
  sequence,
  sample: { processFrame: 40 + sequence, physicsTick: 20 + sequence },
  targets: [
    {
      target,
      values: [
        { name: "value", status: "success" as const, value: "值".repeat(100) },
      ],
    },
  ],
});
const archive = {
  state,
  records: [record(1), record(2), record(3)],
  deliveryComplete: true,
};
const read = (fields: Record<string, unknown> = {}) =>
  InspectionWatchReadInputV1Schema.parse({
    schemaVersion: 1,
    executionId: state.executionId,
    watchId: state.watchId,
    action: "read",
    ...fields,
  });

describe("bounded inspection watch contract", () => {
  it("requires explicit targets, exact unique names, and a finite physics tick count", () => {
    expect(InspectionWatchInputV1Schema.parse(start)).toEqual({
      ...start,
      clock: "physics_tick",
    });
    for (const input of [
      { ...start, sampleCount: 0 },
      { ...start, sampleCount: 257 },
      { ...start, clock: "process_frame" },
      { ...start, targets: [] },
      { ...start, targets: Array.from({ length: 5 }, () => start.targets[0]) },
      {
        ...start,
        targets: [{ target: { path: "../outside" }, names: ["value"] }],
      },
      {
        ...start,
        targets: [{ target: { path: "." }, names: ["value", "value"] }],
      },
      {
        ...start,
        targets: [
          {
            target: { path: "." },
            names: Array.from({ length: 9 }, (_, i) => `v${i}`),
          },
        ],
      },
      { ...start, expression: "value()" },
    ])
      expect(InspectionWatchInputV1Schema.safeParse(input).success).toBe(false);
    expect(read()).toMatchObject({ afterSequence: 0, byteBudget: 65_536 });
    expect(
      InspectionWatchReadInputV1Schema.safeParse({ ...read(), byteBudget: 255 })
        .success,
    ).toBe(false);
  });

  it("pages exact UTF-8 record bytes and reports the budget required to make progress", () => {
    const required = inspectionWatchRecordBytesV1(archive.records[0]);
    expect(required).toBeGreaterThan(JSON.stringify(archive.records[0]).length);
    expect(
      paginateInspectionWatchArchiveV1(archive, read({ byteBudget: 256 })),
    ).toMatchObject({
      records: [],
      bytesUsed: 0,
      nextSequence: 0,
      requiredByteBudget: required,
    });
    const first = paginateInspectionWatchArchiveV1(
      archive,
      read({ byteBudget: required }),
    );
    expect(first.records.map((item) => item.sequence)).toEqual([1]);
    expect(first).toMatchObject({
      bytesUsed: required,
      nextSequence: 1,
      requiredByteBudget: null,
    });
    expect(
      paginateInspectionWatchArchiveV1(
        archive,
        read({ afterSequence: first.nextSequence }),
      ).records.map((item) => item.sequence),
    ).toEqual([2, 3]);
    expect(
      paginateInspectionWatchArchiveV1(archive, read({ afterSequence: 3 })),
    ).toMatchObject({ records: [], nextSequence: 3, bytesUsed: 0 });
    expect(() =>
      paginateInspectionWatchArchiveV1(
        archive,
        read({ executionId: "run:other" }),
      ),
    ).toThrow(/execution/u);
  });

  it("retains sparse actually received records and marks abnormal delivery incomplete", () => {
    const partial = InspectionWatchArchiveV1Schema.parse({
      ...archive,
      records: [record(2)],
      deliveryComplete: false,
    });
    expect(paginateInspectionWatchArchiveV1(partial, read())).toMatchObject({
      deliveryComplete: false,
      records: [record(2)],
      nextSequence: 2,
    });
    expect(
      InspectionWatchArchiveV1Schema.safeParse({
        ...partial,
        deliveryComplete: true,
      }).success,
    ).toBe(false);
  });

  it("rejects invalid identities, reordered clocks, duplicate records, and untruthful byte counts", () => {
    const wrongIdentity = {
      ...record(1),
      targets: [
        {
          target: { ...target, objectRef: "run:two:object:1" },
          values: record(1).targets[0]!.values,
        },
      ],
    };
    const wrongProperties = {
      ...record(1),
      targets: [
        { target, values: [{ name: "other", status: "success", value: 1 }] },
      ],
    };
    for (const records of [
      [record(1), record(1)],
      [record(2), record(1)],
      [wrongIdentity],
      [wrongProperties],
      [record(1), { ...record(2), sample: record(1).sample }],
    ])
      expect(
        InspectionWatchArchiveV1Schema.safeParse({
          ...archive,
          records,
          deliveryComplete: false,
        }).success,
      ).toBe(false);
    const page = paginateInspectionWatchArchiveV1(archive, read());
    expect(
      InspectionWatchReadOutputV1Schema.safeParse({
        ...page,
        bytesUsed: page.bytesUsed - 1,
      }).success,
    ).toBe(false);
    expect(
      InspectionWatchReadOutputV1Schema.safeParse({ ...page, nextSequence: 0 })
        .success,
    ).toBe(false);
    expect(
      InspectionWatchArchiveV1Schema.safeParse({
        ...archive,
        state: { ...state, phase: "end_of_physics_frame" },
      }).success,
    ).toBe(false);
  });

  it("preserves per-property invalid-object errors with the original bound identity", () => {
    const invalid = {
      ...record(1),
      targets: [
        {
          target,
          values: [
            {
              name: "value",
              status: "invalid_object",
              message: "Bound object no longer exists",
            },
          ],
        },
      ],
    };
    expect(
      InspectionWatchArchiveV1Schema.parse({
        ...archive,
        records: [invalid],
        deliveryComplete: false,
      }).records,
    ).toEqual([invalid]);
  });
});

it("returns validation failures for unserializable values instead of throwing during byte checks", () => {
  const cycle: unknown[] = [];
  cycle.push(cycle);
  for (const value of [cycle, 1n, undefined, Symbol("invalid")]) {
    const invalid = {
      ...record(1),
      targets: [
        { target, values: [{ name: "value", status: "success", value }] },
      ],
    };
    expect(InspectionWatchRecordV1Schema.safeParse(invalid).success).toBe(
      false,
    );
    expect(
      InspectionWatchArchiveV1Schema.safeParse({
        ...archive,
        records: [invalid],
        deliveryComplete: false,
      }).success,
    ).toBe(false);
    expect(
      InspectionWatchReadOutputV1Schema.safeParse({
        ...paginateInspectionWatchArchiveV1(archive, read()),
        records: [invalid],
      }).success,
    ).toBe(false);
  }
  expect(inspectionWatchRecordBytesV1(cycle)).toBe(Number.POSITIVE_INFINITY);
  expect(inspectionWatchRecordBytesV1(1n)).toBe(Number.POSITIVE_INFINITY);
  expect(inspectionWatchRecordBytesV1(undefined)).toBe(
    Number.POSITIVE_INFINITY,
  );
});
