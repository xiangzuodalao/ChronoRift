// Operator-only characterization. This does not prescribe either Agent's strategy.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, open, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  INSPECTION_WATCH_PHASE_V1,
  InspectionLaunchOutputV1Schema,
  InspectionQueryOutputV1Schema,
  InspectionStopOutputV1Schema,
  InspectionToolResponseV1Schema,
  InspectionWatchOutputV1Schema,
  inspectionWatchRecordBytesV1,
} from "../../../packages/domain/src/index.ts";
import { GodotInspectionRuntime } from "../../../apps/cli/src/vnext/godot-inspection-runtime.ts";
import { prepareGodotInspectionCandidate } from "../../../apps/cli/src/vnext/godot-inspection-source.ts";
import { selectedTreeSha256 } from "../../../apps/cli/src/vnext/selected-tree.ts";
import { SrtGodotRunner } from "../../../apps/cli/src/vnext/srt-godot-runner.ts";
import { SrtSandboxController } from "../../../apps/cli/src/vnext/srt-sandbox-controller.ts";

const NAMES = [
  "charge",
  "capacity",
  "phase",
  "elapsed_ticks",
  "completed_cycles",
];
const SAMPLE_COUNT = 256;
const PAGE_BYTES = 16_384;
const WAIT_MS = 15_000;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const contains = (parent, child) =>
  parent === child || child.startsWith(parent + sep);
const save = (path, value) =>
  writeFile(path, JSON.stringify(value, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
const sourceHash = (files) =>
  selectedTreeSha256(
    files.map((file) => ({
      relativePath: file.relativePath,
      mode: file.executable ? "100755" : "100644",
      content: file.bytes,
    })),
  );

export function observedValues(values) {
  assert.deepEqual(
    values.map((value) => value.name),
    NAMES,
  );
  for (const value of values)
    assert.equal(value.status, "success", `Property error: ${value.name}`);
  return Object.fromEntries(values.map(({ name, value }) => [name, value]));
}

export function assessWitness(records, query, expectAnomaly) {
  assert.equal(records.length, SAMPLE_COUNT, "Incomplete observation window");
  const identity = records[0].targets[0].target.objectRef;
  let previousPhysics = -1;
  let previousProcess = -1;
  const anomalies = [];
  for (const [index, record] of records.entries()) {
    assert.equal(record.sequence, index + 1, "Missing/duplicate sequence");
    assert.ok(record.sample.physicsTick > previousPhysics);
    assert.ok(record.sample.processFrame >= previousProcess);
    previousPhysics = record.sample.physicsTick;
    previousProcess = record.sample.processFrame;
    assert.equal(record.targets.length, 1);
    assert.equal(record.targets[0].target.objectRef, identity);
    const values = observedValues(record.targets[0].values);
    assert.equal(typeof values.charge, "number");
    assert.equal(typeof values.capacity, "number");
    if (values.charge > values.capacity)
      anomalies.push({
        sequence: record.sequence,
        sample: record.sample,
        values,
      });
  }
  assert.equal(
    anomalies.length > 0,
    expectAnomaly,
    "Unexpected anomaly evidence",
  );
  assert.equal(query.target.objectRef, identity);
  assert.ok(query.sample.physicsTick > records.at(-1).sample.physicsTick);
  const after = observedValues(query.values);
  assert.equal(after.phase, "ready");
  assert.equal(after.charge, after.capacity);
  return { anomalies, after, identity };
}

/** No Pi or provider calls. The output directory must be new and outside both repos. */
export async function captureWitness({
  project,
  godotBin,
  output,
  expectAnomaly = true,
}) {
  assert.equal(typeof expectAnomaly, "boolean");
  const source = await realpath(project);
  const repository = await realpath(
    resolve(dirname(fileURLToPath(import.meta.url)), "../../.."),
  );
  const outputPath = join(
    await realpath(dirname(resolve(output))),
    basename(output),
  );
  for (const parent of [source, repository])
    assert.ok(
      !contains(parent, outputPath) && !contains(outputPath, parent),
      "Witness output must not overlap the source or ChronoRift repository",
    );
  await mkdir(outputPath, { mode: 0o700 });
  const calls = await open(join(outputPath, "calls.jsonl"), "wx", 0o600);
  const started = performance.now();
  const summary = {
    schemaVersion: 1,
    kind: "finite-physics-watch-operator-witness",
    modelInvoked: false,
    expectAnomaly,
    startedAt: new Date().toISOString(),
    outcome: "failed",
    phase: INSPECTION_WATCH_PHASE_V1,
    sampleCount: SAMPLE_COUNT,
    pageByteBudget: PAGE_BYTES,
    observationDeadlineMs: WAIT_MS,
    callCount: 0,
    pageCount: 0,
    retainedRecordCount: 0,
    cleanupErrors: [],
    error: null,
    summaryPath: join(outputPath, "summary.json"),
  };
  const abort = new AbortController();
  const onSignal = () => abort.abort();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  let runtime;
  let controller;
  let waitTimer;
  try {
    const baseline = await prepareGodotInspectionCandidate(source);
    const candidate = join(outputPath, "candidate");
    await mkdir(candidate, { mode: 0o700 });
    for (const file of baseline.sourceFiles) {
      await mkdir(dirname(join(candidate, file.relativePath)), {
        recursive: true,
        mode: 0o700,
      });
      await writeFile(join(candidate, file.relativePath), file.bytes, {
        flag: "wx",
        mode: file.executable ? 0o700 : 0o600,
      });
    }
    summary.sourceSha256 = sourceHash(baseline.sourceFiles);
    await save(join(outputPath, "inputs.json"), {
      sourceSha256: summary.sourceSha256,
      runnerSha256: sha256(await readFile(fileURLToPath(import.meta.url))),
      mainScene: baseline.mainScene,
      files: baseline.sourceFiles.map((file) => ({
        path: file.relativePath,
        sha256: sha256(file.bytes),
      })),
      expectAnomaly,
    });
    controller = new SrtSandboxController();
    runtime = new GodotInspectionRuntime({
      runner: new SrtGodotRunner({
        controller,
        candidateWorkspace: candidate,
        validationRoot: join(outputPath, "stages"),
      }),
      candidateWorkspace: candidate,
      artifactsDirectory: join(outputPath, "runtime-records"),
      nodePath: await realpath(process.execPath),
      godotPath: await realpath(godotBin),
      executionTimeoutMs: 60_000,
      queryTimeoutMs: 5_000,
    });
    const invoke = async (toolName, input, label, signal = abort.signal) => {
      const callId = ++summary.callCount;
      const begin = performance.now();
      const request = {
        schemaVersion: 1,
        toolCallId: `witness.${callId}`,
        toolName,
        input,
      };
      await calls.appendFile(
        JSON.stringify({
          event: "start",
          callId,
          label,
          receivedAt: new Date().toISOString(),
          request,
        }) + "\n",
      );
      const response = InspectionToolResponseV1Schema.parse(
        await runtime.invoke(request, signal),
      );
      const entry = {
        event: "end",
        callId,
        label,
        receivedAt: new Date().toISOString(),
        durationMs: performance.now() - begin,
        response,
      };
      await calls.appendFile(JSON.stringify(entry) + "\n");
      if (label !== "status")
        await save(join(outputPath, `${label}.json`), entry);
      assert.equal(response.outcome, "success", JSON.stringify(response));
      return response.output;
    };
    const launch = InspectionLaunchOutputV1Schema.parse(
      await invoke("game_launch", { schemaVersion: 1 }, "launch"),
    );
    summary.executionId = launch.executionId;
    const base = { schemaVersion: 1, executionId: launch.executionId };
    const watch = InspectionWatchOutputV1Schema.parse(
      await invoke(
        "game_watch",
        {
          ...base,
          action: "start",
          targets: [{ target: { path: "." }, names: NAMES }],
          clock: "physics_tick",
          sampleCount: SAMPLE_COUNT,
        },
        "watch-start",
      ),
    );
    assert.equal(watch.phase, INSPECTION_WATCH_PHASE_V1);
    summary.watchId = watch.watchId;
    const watchBase = { ...base, watchId: watch.watchId };
    // Each reply reports actual observer state. No Host sleep determines readiness.
    const deadline = performance.now() + WAIT_MS;
    waitTimer = setTimeout(() => abort.abort(), WAIT_MS);
    let state = watch;
    while (state.status !== "stopped") {
      assert.ok(
        performance.now() < deadline && summary.callCount < 4096,
        "Watch deadline exceeded",
      );
      state = InspectionWatchOutputV1Schema.parse(
        await invoke(
          "game_watch",
          {
            ...watchBase,
            action: "read",
            afterSequence: SAMPLE_COUNT,
            byteBudget: 256,
          },
          "status",
        ),
      );
    }
    assert.equal(state.stopReason, "sample_count");
    assert.equal(state.recordedCount, SAMPLE_COUNT);
    const records = [];
    let cursor = 0;
    while (cursor < state.recordedCount) {
      assert.ok(performance.now() < deadline, "Page deadline exceeded");
      const page = InspectionWatchOutputV1Schema.parse(
        await invoke(
          "game_watch",
          {
            ...watchBase,
            action: "read",
            afterSequence: cursor,
            byteBudget: PAGE_BYTES,
          },
          `page-${++summary.pageCount}`,
        ),
      );
      assert.equal(page.action, "read");
      assert.equal(page.deliveryComplete, true);
      assert.equal(
        page.bytesUsed,
        page.records.reduce(
          (sum, record) => sum + inspectionWatchRecordBytesV1(record),
          0,
        ),
      );
      assert.ok(page.bytesUsed <= PAGE_BYTES && page.nextSequence > cursor);
      records.push(...page.records);
      cursor = page.nextSequence;
      summary.retainedRecordCount = records.length;
    }
    await save(join(outputPath, "retained-records.json"), records);
    let query;
    let queryCount = 0;
    do {
      assert.ok(
        performance.now() < deadline && queryCount < 4096,
        "Healthy post-query deadline exceeded",
      );
      query = InspectionQueryOutputV1Schema.parse(
        await invoke(
          "game_query",
          {
            ...base,
            target: { path: "." },
            select: "values",
            names: NAMES,
          },
          `post-query-${++queryCount}`,
        ),
      );
      assert.equal(query.select, "values");
      const values = observedValues(query.values);
      if (
        query.sample.physicsTick > records.at(-1).sample.physicsTick &&
        values.phase === "ready" &&
        values.charge === values.capacity
      )
        break;
    } while (true);
    clearTimeout(waitTimer);
    summary.observations = assessWitness(records, query, expectAnomaly);
    summary.postQuery = { sample: query.sample, target: query.target };
    const stop = InspectionStopOutputV1Schema.parse(
      await invoke("game_stop", base, "game-stop"),
    );
    assert.equal(stop.record.sourceUnchanged, true);
    assert.equal(stop.record.error, null);
    assert.equal(stop.record.watch?.deliveryComplete, true);
    assert.deepEqual(stop.record.watch.records, records);
    summary.sourceUnchanged =
      sourceHash(
        (await prepareGodotInspectionCandidate(source)).sourceFiles,
      ) === summary.sourceSha256;
    assert.equal(summary.sourceUnchanged, true);
    summary.outcome = "passed";
  } catch (error) {
    summary.error = error instanceof Error ? error.message : String(error);
  } finally {
    clearTimeout(waitTimer);
    for (const resource of [runtime, controller]) {
      try {
        await resource?.close();
      } catch (error) {
        summary.cleanupErrors.push(String(error));
      }
    }
    summary.runtimeRecords = runtime?.recordPaths() ?? [];
    summary.cancelled = abort.signal.aborted;
    if (summary.cancelled || summary.cleanupErrors.length)
      summary.outcome = "failed";
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    await calls.close();
    summary.finishedAt = new Date().toISOString();
    summary.durationMs = performance.now() - started;
    await save(summary.summaryPath, summary);
  }
  return summary;
}
