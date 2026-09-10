import {
  INSPECTION_WATCH_PHASE_V1,
  InspectionToolResponseV1Schema,
  InspectionStopOutputV1Schema,
  InspectionWatchReadOutputV1Schema,
  inspectionWatchRecordBytesV1,
  type InspectionValueV1,
  type InspectionRunRecordV1,
  type InspectionStopOutputV1,
  type InspectionWatchReadOutputV1,
  type InspectionWatchRecordV1,
} from "@chronorift/domain";
import { describe, expect, it } from "vitest";

import {
  formatInspectionStopText,
  formatInspectionWatchReadText,
} from "../src/inspection-watch-text.js";

const executionId = "inspection.0aa11111-2222-4333-8444-555555555555";
const binding = {
  target: {
    objectRef: `${executionId}.object.1`,
    className: "Node2D",
    name: "Observed",
    path: "World/Observed",
    scriptPath: "res://observed.gd",
    childCount: 0,
  },
  names: ["value", "enabled", "label", "data"],
};

const record = (sequence: number): InspectionWatchRecordV1 => ({
  sequence,
  sample: { processFrame: 1000 + sequence * 3, physicsTick: 700 + sequence },
  targets: [
    {
      target: { ...binding.target },
      values: [
        { name: "value", status: "success", value: sequence / 10 + 0.125 },
        { name: "enabled", status: "success", value: true },
        { name: "label", status: "success", value: "active" },
        {
          name: "data",
          status: "success",
          value: { items: [1, "two", null], flag: false },
        },
      ],
    },
  ],
});

function page(
  records: InspectionWatchRecordV1[],
  overrides: Partial<InspectionWatchReadOutputV1> = {},
): InspectionWatchReadOutputV1 {
  return InspectionWatchReadOutputV1Schema.parse({
    schemaVersion: 1,
    executionId,
    watchId: `${executionId}.watch.1`,
    phase: INSPECTION_WATCH_PHASE_V1,
    status: "sampling",
    stopReason: null,
    sampleCount: 256,
    recordedCount: records.at(-1)?.sequence ?? 0,
    boundTargets: [binding],
    action: "read",
    deliveryComplete: true,
    records,
    nextSequence: records.at(-1)?.sequence ?? 0,
    bytesUsed: records.reduce(
      (sum, entry) => sum + inspectionWatchRecordBytesV1(entry),
      0,
    ),
    requiredByteBudget: null,
    ...overrides,
  });
}

const response = (output: InspectionWatchReadOutputV1) => ({
  schemaVersion: 1,
  outcome: "success",
  output,
});

// Independent reader of the documented text layout, deliberately test-only.
// Production details and archives continue using the existing strict schemas.
function restore(text: string) {
  const lines = text.split("\n");
  const header = JSON.parse(lines[1]!) as {
    schemaVersion: 1;
    outcome: "success";
    output: InspectionWatchReadOutputV1 | InspectionStopOutputV1;
  };
  const stop = "record" in header.output ? header.output : undefined;
  expect(lines[0]).toBe(stop ? "game_stop" : "game_watch read");
  const boundTargets =
    "boundTargets" in header.output
      ? header.output.boundTargets
      : header.output.record.watch!.state.boundTargets;
  type TargetColumn = [Record<string, unknown> | null, ...unknown[][]];
  type Row = [number, number, number, ...TargetColumn[]];
  const records = lines
    .slice(2)
    .filter((line) => !line.startsWith("#"))
    .map((line) => {
      const [sequence, processFrame, physicsTick, ...targets] = JSON.parse(
        line,
      ) as Row;
      return {
        sequence,
        sample: { processFrame, physicsTick },
        targets: targets.map(([metadata, ...cells], targetIndex) => {
          const bound = boundTargets[targetIndex]!;
          expect(cells).toHaveLength(bound.names.length);
          return {
            target:
              metadata === null
                ? bound.target
                : {
                    objectRef: bound.target.objectRef,
                    className: bound.target.className,
                    ...metadata,
                  },
            values: cells.map((cell, propertyIndex) => {
              expect([1, 2]).toContain(cell.length);
              const name = bound.names[propertyIndex]!;
              return cell.length === 1
                ? { name, status: "success", value: cell[0] }
                : { name, status: cell[0], message: cell[1] };
            }),
          };
        }),
      };
    });
  return InspectionToolResponseV1Schema.parse({
    ...header,
    output: stop
      ? {
          ...stop,
          record: {
            ...stop.record,
            watch: { ...stop.record.watch, records },
          },
        }
      : { ...header.output, records },
  });
}

function stopOutput(
  observed: InspectionWatchReadOutputV1,
  overrides: Partial<InspectionRunRecordV1> = {},
): InspectionStopOutputV1 {
  return InspectionStopOutputV1Schema.parse({
    schemaVersion: 1,
    executionId,
    recordPath: "/records/inspection.json",
    record: {
      schemaVersion: 1,
      executionId,
      sourceSha256: "a".repeat(64),
      observedSourceSha256: "a".repeat(64),
      sourceUnchanged: true,
      mainScene: "res://world.tscn",
      engineVersion: "4.7.1",
      startedAt: "2026-09-06T00:00:00.000Z",
      endedAt: "2026-09-06T00:00:01.000Z",
      status: "exited",
      exitCode: 0,
      signal: null,
      import: null,
      run: null,
      stderr: "",
      stderrTruncated: false,
      error: null,
      watch: {
        state: {
          schemaVersion: 1,
          executionId,
          watchId: observed.watchId,
          phase: observed.phase,
          status: "stopped",
          stopReason: observed.stopReason ?? "stopped",
          sampleCount: observed.sampleCount,
          recordedCount: observed.recordedCount,
          boundTargets: observed.boundTargets,
        },
        records: observed.records,
        deliveryComplete:
          observed.deliveryComplete &&
          observed.records.length === observed.recordedCount &&
          observed.records.every((entry, i) => entry.sequence === i + 1),
      },
      ...overrides,
    },
  });
}

function expectStopRoundTrip(observed: InspectionWatchReadOutputV1) {
  return expectStopOutputRoundTrip(stopOutput(observed));
}

function expectStopOutputRoundTrip(output: InspectionStopOutputV1) {
  freeze(output);
  const original = structuredClone(output);
  const text = formatInspectionStopText(output);
  expect(formatInspectionStopText(output)).toBe(text);
  expect(output).toEqual(original);
  expect(restore(text)).toEqual({
    schemaVersion: 1,
    outcome: "success",
    output,
  });
  return text;
}

function freeze(value: unknown): void {
  if (value !== null && typeof value === "object") {
    Object.freeze(value);
    for (const nested of Object.values(value)) freeze(nested);
  }
}

describe("compact Agent watch read text", () => {
  it("deterministically reduces the same 64-record page and fully restores its canonical response", () => {
    const original = page(Array.from({ length: 64 }, (_, i) => record(i + 1)));
    const before = JSON.stringify(response(original), null, 2);
    freeze(original);
    const after = formatInspectionWatchReadText(original);
    expect(formatInspectionWatchReadText(original)).toBe(after);
    expect(JSON.stringify(response(original), null, 2)).toBe(before);
    expect(restore(after)).toEqual(response(original));
    expect(after.split(binding.target.objectRef)).toHaveLength(2);
    expect(after.split('"Node2D"')).toHaveLength(2);
    for (const name of binding.names)
      expect(after.split(JSON.stringify(name))).toHaveLength(2);
    expect(after.split("\n").at(-1)).toBe(
      '[64,1192,764,[null,[6.525],[true],["active"],[{"items":[1,"two",null],"flag":false}]]]',
    );
    const bytes = {
      before: Buffer.byteLength(before, "utf8"),
      after: Buffer.byteLength(after, "utf8"),
    };
    expect(bytes.after).toBeLessThan(bytes.before * 0.2);
    expect(bytes).toMatchInlineSnapshot(`
      {
        "after": 6758,
        "before": 81042,
      }
    `);
  });

  it.each(["missing", "invalid_object", "unsupported", "truncated"] as const)(
    "retains %s and its complete message, followed by actual recovery",
    (status) => {
      const failed = record(2);
      failed.targets[0]!.values[0] = {
        name: "value",
        status,
        message: '异常：雪☃\n"quoted" \\ path\t\u0001',
      };
      const original = page([record(1), failed, record(3)]);
      const text = formatInspectionWatchReadText(original);
      expect(text).toContain(
        JSON.stringify([status, failed.targets[0]!.values[0].message]),
      );
      expect(restore(text)).toEqual(response(original));
      expectStopRoundTrip(original);
    },
  );

  it.each<InspectionValueV1>([
    null,
    false,
    0.10000000000000002,
    'multi\nline\r\t\u0000 雪☃ " [missing,error] \\',
    ["missing", "this is a successful array value"],
    { status: "invalid_object", message: "this is a successful map value" },
    { $type: "vector2", x: 0.125, y: -2.5 },
    { $type: "vector3", x: 1, y: 2, z: 3 },
    { $type: "color", r: 1, g: 0, b: 0.5, a: 0.25 },
    { $type: "int64", value: "9223372036854775807" },
    {
      $type: "object",
      objectRef: `${executionId}.object.2`,
      className: "Resource",
      resourcePath: "res://data.tres",
    },
    { nested: [{ $type: "unsupported", type: "Callable" }] },
    { nested: [{ $type: "truncated", reason: "depth_budget" }] },
  ])("preserves successful JSON values and runtime tags: %j", (value) => {
    const entry = record(1);
    entry.targets[0]!.values[0] = { name: "value", status: "success", value };
    const original = page([entry]);
    expect(restore(formatInspectionWatchReadText(original))).toEqual(
      response(original),
    );
    expectStopRoundTrip(original);
  });

  it("preserves target order and changed or removed optional object metadata", () => {
    const second = {
      target: {
        objectRef: `${executionId}.object.2`,
        className: "Resource",
        resourcePath: "res://first.tres",
      },
      names: ["text"],
    };
    const records = [record(1), record(2), record(3)];
    for (const entry of records)
      entry.targets.push({
        target: { ...second.target },
        values: [{ name: "text", status: "success", value: "second target" }],
      });
    records[1]!.targets[0]!.target = {
      ...binding.target,
      name: "Renamed",
      path: "Other/Renamed",
      scriptPath: "res://changed.gd",
      childCount: 2,
    };
    records[1]!.targets[1]!.target = {
      ...second.target,
      resourcePath: "res://second.tres",
    };
    // Missing optional fields are observations too: an empty replacement must
    // not accidentally inherit the old path, name, or childCount.
    records[2]!.targets[0]!.target = {
      objectRef: binding.target.objectRef,
      className: binding.target.className,
    };
    const original = page(records, { boundTargets: [binding, second] });
    const text = formatInspectionWatchReadText(original);
    expect(text).toContain("[3,1009,703,[{},");
    expect(restore(text)).toEqual(response(original));
    expectStopRoundTrip(original);
  });

  it.each([
    "sample_count",
    "stopped",
    "record_budget",
    "construction_budget",
    "encoded_budget",
    "execution_exit",
  ] as const)("retains stopReason=%s and incomplete delivery", (stopReason) => {
    const original = page([record(2), record(9)], {
      status: "stopped",
      stopReason,
      sampleCount: stopReason === "sample_count" ? 9 : 256,
      deliveryComplete: false,
    });
    const text = formatInspectionWatchReadText(original);
    expect(text).toContain('"deliveryComplete":false');
    expect(text).toContain(`"stopReason":"${stopReason}"`);
    expect(restore(text)).toEqual(response(original));
    expectStopRoundTrip(original);
  });

  it.each([
    { recordedCount: 0, nextSequence: 0, requiredByteBudget: null },
    { recordedCount: 4, nextSequence: 2, requiredByteBudget: 1234 },
    { recordedCount: 4, nextSequence: 4, requiredByteBudget: null },
  ])(
    "retains empty page, cursor and canonical byte-budget state %j",
    (state) => {
      const original = page([], state);
      const text = formatInspectionWatchReadText(original);
      expect(text).toContain("# records=0;");
      expect(restore(text)).toEqual(response(original));
      expectStopRoundTrip(original);
    },
  );
});

describe("compact Agent stop archive text", () => {
  it("keeps the last sampling state when exit did not deliver a final watch state", () => {
    const output = stopOutput(
      page([record(2)], {
        deliveryComplete: false,
        recordedCount: 9,
      }),
      {
        status: "failed",
        error: {
          code: "protocol_error",
          message: "Connection lost before final delivery",
        },
      },
    );
    output.record.watch!.state.status = "sampling";
    output.record.watch!.state.stopReason = null;
    const text = expectStopOutputRoundTrip(
      InspectionStopOutputV1Schema.parse(output),
    );
    expect(text).toContain('"status":"sampling"');
    expect(text).toContain('"stopReason":null');
    expect(text).toContain('"deliveryComplete":false');
    expect(text).toContain("# records=1;");
  });

  it("losslessly reduces a deterministic 256-record archive by at least 90%", () => {
    // A full archive can exceed a read page's 64 KiB budget. Build it directly
    // and validate the archive, without pretending all records fit one page.
    const output = stopOutput(page([], { recordedCount: 256 }));
    output.record.watch!.records = Array.from({ length: 256 }, (_, i) =>
      record(i + 1),
    );
    output.record.watch!.deliveryComplete = true;
    const text = expectStopOutputRoundTrip(
      InspectionStopOutputV1Schema.parse(output),
    );
    expect(text.split(binding.target.objectRef)).toHaveLength(2);
    expect(text.split('"Node2D"')).toHaveLength(2);
    for (const name of binding.names)
      expect(text.split(JSON.stringify(name))).toHaveLength(2);
    const bytes = {
      before: Buffer.byteLength(
        JSON.stringify(
          { schemaVersion: 1, outcome: "success", output },
          null,
          2,
        ),
      ),
      after: Buffer.byteLength(text),
    };
    expect(bytes.after).toBeLessThan(bytes.before * 0.1);
    expect(bytes).toMatchInlineSnapshot(`
      {
        "after": 24471,
        "before": 371651,
      }
    `);
  });

  it.each(["exited", "failed", "cancelled", "timed_out"] as const)(
    "preserves %s process results, logs, errors and incomplete archive gaps",
    (status) => {
      const process = {
        exitCode: null,
        signal: "SIGKILL",
        timedOut: status === "timed_out",
        stdout: 'Actual stdout\n雪 "quoted"',
        stderr: "Actual stderr\n",
        stdoutTruncated: true,
        stderrTruncated: true,
      };
      const output = stopOutput(
        page([record(2), record(9)], {
          deliveryComplete: false,
          recordedCount: 12,
          status: "stopped",
          stopReason: "execution_exit",
        }),
        {
          status,
          exitCode: null,
          signal: process.signal,
          import: process,
          run: process,
          stderr: process.stderr,
          stderrTruncated: true,
          observedSourceSha256: "b".repeat(64),
          sourceUnchanged: false,
          error: {
            code: "protocol_error",
            message: "Actual connection failure",
          },
        },
      );
      freeze(output);
      const text = formatInspectionStopText(output);
      expect(restore(text)).toEqual({
        schemaVersion: 1,
        outcome: "success",
        output,
      });
      expect(text).toContain('"deliveryComplete":false');
      expect(text).toContain('"recordedCount":12');
      expect(text).toContain("# records=2;");
    },
  );
});
