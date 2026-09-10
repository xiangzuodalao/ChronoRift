import assert from "node:assert/strict";
import test from "node:test";
import { assessWitness } from "./witness.mjs";

const values = (charge = 10, phase = "ready") => [
  { name: "charge", status: "success", value: charge },
  { name: "capacity", status: "success", value: 10 },
  { name: "phase", status: "success", value: phase },
  { name: "elapsed_ticks", status: "success", value: 100 },
  { name: "completed_cycles", status: "success", value: 1 },
];
const input = (anomaly) => {
  const target = { objectRef: "execution.root", className: "Node" };
  return {
    records: Array.from({ length: 256 }, (_, index) => ({
      sequence: index + 1,
      sample: { physicsTick: index + 20, processFrame: index + 20 },
      targets: [{ target, values: values(anomaly && index === 90 ? 13 : 10) }],
    })),
    query: {
      target,
      sample: { physicsTick: 300, processFrame: 300 },
      values: values(),
    },
  };
};

test("witness requires retained abnormal values before a later healthy query", () => {
  const { records, query } = input(true);
  const result = assessWitness(records, query, true);
  assert.equal(result.anomalies.length, 1);
  assert.equal(result.anomalies[0].sequence, 91);
  assert.equal(result.anomalies[0].values.charge, 13);
  assert.throws(() => assessWitness(records, query, false), /anomaly evidence/);
  assert.throws(
    () => assessWitness(records.slice(1), query, true),
    /Incomplete/,
  );
  const fixed = input(false);
  assert.equal(
    assessWitness(fixed.records, fixed.query, false).anomalies.length,
    0,
  );
  assert.throws(
    () => assessWitness(fixed.records, fixed.query, true),
    /anomaly evidence/,
  );
});

test("witness rejects lost identity, duplicate ticks, property errors, and early/abnormal post-query", () => {
  for (const mutate of [
    (data) => {
      data.records[5].sequence = 5;
    },
    (data) => {
      data.records[5].sample.physicsTick = data.records[4].sample.physicsTick;
    },
    (data) => {
      data.records[5].targets[0].target = { objectRef: "replacement" };
    },
    (data) => {
      data.records[5].targets[0].values[0] = {
        name: "charge",
        status: "missing",
      };
    },
    (data) => {
      data.query.sample.physicsTick = data.records.at(-1).sample.physicsTick;
    },
    (data) => {
      data.query.target = { objectRef: "replacement" };
    },
    (data) => {
      data.query.values = values(13);
    },
    (data) => {
      data.query.values = values(10, "charging");
    },
  ]) {
    const data = input(true);
    mutate(data);
    assert.throws(() => assessWitness(data.records, data.query, true));
  }
});
