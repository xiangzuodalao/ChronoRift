import {
  cp,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  InspectionLaunchOutputV1Schema,
  InspectionQueryOutputV1Schema,
  InspectionStopOutputV1Schema,
  InspectionToolResponseV1Schema,
  InspectionWatchOutputV1Schema,
  type InspectionToolNameV1,
} from "@chronorift/domain";
import { expect, it } from "vitest";

import { GodotInspectionRuntime } from "./godot-inspection-runtime.js";
import { SrtGodotRunner } from "./srt-godot-runner.js";
import { SrtSandboxController } from "./srt-sandbox-controller.js";

const fixtureRoot = fileURLToPath(
  new URL("../../../../testdata/vnext/inspection-watch", import.meta.url),
);
const phase = "physics_frame_signal_before_node_physics_process";

async function fixture() {
  const configuredGodot = process.env.GODOT_BIN;
  if (configuredGodot === undefined)
    throw new Error("GODOT_BIN is required for the watch sandbox tests");
  const root = await mkdtemp(join(tmpdir(), "chronorift-watch-sandbox-"));
  const candidate = join(root, "candidate");
  await cp(fixtureRoot, candidate, { recursive: true });
  const controller = new SrtSandboxController();
  const runtime = new GodotInspectionRuntime({
    runner: new SrtGodotRunner({
      controller,
      candidateWorkspace: candidate,
      validationRoot: join(root, "stages"),
    }),
    candidateWorkspace: candidate,
    artifactsDirectory: join(root, "records"),
    nodePath: await realpath(process.execPath),
    godotPath: await realpath(configuredGodot),
  });
  const invoke = async (toolName: InspectionToolNameV1, input: unknown) => {
    const response = InspectionToolResponseV1Schema.parse(
      await runtime.invoke({
        schemaVersion: 1,
        toolCallId: "watch-sandbox-test",
        toolName,
        input,
      }),
    );
    if (response.outcome !== "success")
      throw new Error(
        `${JSON.stringify(response)}\n${JSON.stringify(runtime.records())}`,
      );
    return response.output;
  };
  const launch = async () =>
    InspectionLaunchOutputV1Schema.parse(
      await invoke("game_launch", { schemaVersion: 1 }),
    );
  const stopExecution = async (executionId: string) =>
    InspectionStopOutputV1Schema.parse(
      await invoke("game_stop", { schemaVersion: 1, executionId }),
    );
  const query = async (
    executionId: string,
    target: { path: string } | { objectRef: string },
    names: string[],
  ) => {
    const result = InspectionQueryOutputV1Schema.parse(
      await invoke("game_query", {
        schemaVersion: 1,
        executionId,
        target,
        select: "values",
        names,
      }),
    );
    if (result.select !== "values") throw new Error("Expected values result");
    return result;
  };
  const start = async (
    executionId: string,
    names: string[],
    sampleCount: number,
    target: { path: string } | { objectRef: string } = { path: "." },
  ) =>
    InspectionWatchOutputV1Schema.parse(
      await invoke("game_watch", {
        schemaVersion: 1,
        executionId,
        action: "start",
        clock: "physics_tick",
        targets: [{ target, names }],
        sampleCount,
      }),
    );
  const read = async (
    executionId: string,
    watchId: string,
    afterSequence = 0,
    byteBudget = 65_536,
  ) => {
    const result = InspectionWatchOutputV1Schema.parse(
      await invoke("game_watch", {
        schemaVersion: 1,
        executionId,
        action: "read",
        watchId,
        afterSequence,
        byteBudget,
      }),
    );
    if (!("records" in result)) throw new Error("Expected watch read result");
    return result;
  };
  const waitForWindow = async (executionId: string, watchId: string) => {
    // Host reads only inspect progress. Sampling happens in the observer, and
    // the fixture is armed by the first sampled getter, never by elapsed time.
    await expect
      .poll(async () => (await read(executionId, watchId, 0, 256)).status, {
        timeout: 10_000,
        interval: 10,
      })
      .toBe("stopped");
    return read(executionId, watchId);
  };
  const stopWatch = async (executionId: string, watchId: string) =>
    InspectionWatchOutputV1Schema.parse(
      await invoke("game_watch", {
        schemaVersion: 1,
        executionId,
        action: "stop",
        watchId,
      }),
    );
  const close = async () => {
    try {
      await runtime.close();
    } finally {
      try {
        await controller.close();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  };
  return {
    candidate,
    runtime,
    launch,
    stopExecution,
    query,
    start,
    read,
    waitForWindow,
    stopWatch,
    close,
  };
}

it("retains a one-tick fault that a later query misses, then observes the same fixed window in SRT", async () => {
  const game = await fixture();
  try {
    const first = await game.launch();
    const watch = await game.start(
      first.executionId,
      [
        "observed_value",
        "recoverable",
        "callback_tick",
        "precise_value",
        "escaped_small",
      ],
      3,
    );
    expect(watch).toMatchObject({
      status: "sampling",
      recordedCount: 0,
      phase,
    });
    const observed = await game.waitForWindow(first.executionId, watch.watchId);
    expect(observed).toMatchObject({
      stopReason: "sample_count",
      recordedCount: 3,
      phase,
    });
    expect(observed.records.map((record) => record.sequence)).toEqual([
      1, 2, 3,
    ]);
    expect(
      observed.records.map((record) => record.targets[0]?.values.slice(0, 2)),
    ).toMatchObject([
      [
        { name: "observed_value", status: "success", value: 42 },
        { name: "recoverable", status: "success", value: 42 },
      ],
      [
        { name: "observed_value", status: "success", value: -1 },
        { name: "recoverable", status: "missing" },
      ],
      [
        { name: "observed_value", status: "success", value: 42 },
        { name: "recoverable", status: "success", value: 42 },
      ],
    ]);
    for (const [index, record] of observed.records.entries()) {
      expect(record.sample.physicsTick).toBe(
        observed.records[0]!.sample.physicsTick + index,
      );
      expect(record.targets[0]?.values[2]).toMatchObject({
        status: "success",
        value: record.sample.physicsTick - 1,
      });
      expect(record.targets[0]?.target.objectRef).toBe(first.root.objectRef);
      expect(record.targets[0]?.values[3]).toMatchObject({
        status: "success",
        value: 0.12345678901234566,
      });
      expect(record.targets[0]?.values[4]).toMatchObject({
        status: "success",
        value: "\u0001\t\n",
      });
      if (index > 0)
        expect(record.sample.processFrame).toBeGreaterThanOrEqual(
          observed.records[index - 1]!.sample.processFrame,
        );
    }
    expect(
      (
        await game.query(first.executionId, { path: "." }, [
          "observed_value",
          "recoverable",
          "precise_value",
          "escaped_small",
        ])
      ).values,
    ).toMatchObject([
      { status: "success", value: 42 },
      { status: "success", value: 42 },
      { status: "success", value: 0.12345678901234566 },
      { status: "success", value: "\u0001\t\n" },
    ]);
    const original = await game.stopExecution(first.executionId);
    expect(original.record).toMatchObject({
      sourceUnchanged: true,
      error: null,
      watch: { deliveryComplete: true, records: observed.records },
    });
    const source = await readFile(join(game.candidate, "main.gd"), "utf8");
    await writeFile(
      join(game.candidate, "main.gd"),
      source.replace("const FIXED := false", "const FIXED := true"),
    );
    const second = await game.launch();
    expect(second.sourceSha256).not.toBe(first.sourceSha256);
    const fixedWatch = await game.start(
      second.executionId,
      [
        "observed_value",
        "recoverable",
        "callback_tick",
        "precise_value",
        "escaped_small",
      ],
      3,
      { objectRef: second.root.objectRef },
    );
    const fixed = await game.waitForWindow(
      second.executionId,
      fixedWatch.watchId,
    );
    expect(fixed.records).toHaveLength(3);
    for (const record of fixed.records) {
      expect(record.targets[0]?.values.slice(0, 2)).toMatchObject([
        { status: "success", value: 42 },
        { status: "success", value: 42 },
      ]);
      expect(record.targets[0]?.values[2]).toMatchObject({
        status: "success",
        value: record.sample.physicsTick - 1,
      });
    }
    const repaired = await game.stopExecution(second.executionId);
    expect(repaired.record).toMatchObject({
      sourceUnchanged: true,
      error: null,
    });
    expect(repaired.record.run?.stderr).toBe("");
    expect(original.record.watch?.records).toEqual(observed.records);
  } finally {
    await game.close();
  }
});

it("paginates retained UTF-8 samples by sequence and byte budget and stops idempotently without exiting the game", async () => {
  const game = await fixture();
  try {
    const run = await game.launch();
    const watch = await game.start(run.executionId, ["page_payload"], 5);
    const complete = await game.waitForWindow(run.executionId, watch.watchId);
    const tiny = await game.read(run.executionId, watch.watchId, 0, 256);
    expect(tiny.records).toEqual([]);
    expect(tiny.nextSequence).toBe(0);
    expect(tiny.bytesUsed).toBe(0);
    expect(tiny.requiredByteBudget).toBeGreaterThan(256);
    expect(tiny.requiredByteBudget).toBeLessThanOrEqual(65_536);
    const first = await game.read(
      run.executionId,
      watch.watchId,
      0,
      tiny.requiredByteBudget!,
    );
    expect(first.records).toHaveLength(1);
    expect(first.nextSequence).toBe(1);
    const records = [...first.records];
    let cursor = first.nextSequence;
    while (cursor < complete.recordedCount) {
      const page = await game.read(
        run.executionId,
        watch.watchId,
        cursor,
        2048,
      );
      expect(page.records.length).toBeGreaterThan(0);
      expect(page.bytesUsed).toBeLessThanOrEqual(2048);
      expect(page.nextSequence).toBeGreaterThan(cursor);
      cursor = page.nextSequence;
      records.push(...page.records);
    }
    expect(records).toEqual(complete.records);
    expect(new Set(records.map((record) => record.sequence)).size).toBe(5);
    expect(
      (await game.read(run.executionId, watch.watchId, cursor)).records,
    ).toEqual([]);
    const stopped = await game.stopWatch(run.executionId, watch.watchId);
    expect(await game.stopWatch(run.executionId, watch.watchId)).toEqual(
      stopped,
    );
    expect(stopped.stopReason).toBe("sample_count");
    expect(
      (await game.query(run.executionId, { path: "." }, ["page_payload"]))
        .values[0],
    ).toMatchObject({ status: "success" });
    await game.stopExecution(run.executionId);

    const ongoingRun = await game.launch();
    const ongoingWatch = await game.start(
      ongoingRun.executionId,
      ["callback_tick"],
      256,
    );
    await expect
      .poll(
        async () =>
          (await game.read(ongoingRun.executionId, ongoingWatch.watchId))
            .recordedCount,
        {
          timeout: 10_000,
          interval: 10,
        },
      )
      .toBeGreaterThan(0);
    const manuallyStopped = await game.stopWatch(
      ongoingRun.executionId,
      ongoingWatch.watchId,
    );
    expect(manuallyStopped).toMatchObject({
      status: "stopped",
      stopReason: "stopped",
    });
    expect(manuallyStopped.recordedCount).toBeLessThan(256);
    expect(
      await game.stopWatch(ongoingRun.executionId, ongoingWatch.watchId),
    ).toEqual(manuallyStopped);
    const retained = await game.read(
      ongoingRun.executionId,
      ongoingWatch.watchId,
    );
    const finalTick = retained.records.at(-1)!.sample.physicsTick;
    await expect
      .poll(
        async () =>
          (
            await game.query(ongoingRun.executionId, { path: "." }, [
              "callback_tick",
            ])
          ).sample.physicsTick,
        {
          timeout: 10_000,
          interval: 10,
        },
      )
      .toBeGreaterThan(finalTick);
    expect(
      (await game.read(ongoingRun.executionId, ongoingWatch.watchId)).records,
    ).toEqual(retained.records);
    await game.stopExecution(ongoingRun.executionId);
  } finally {
    await game.close();
  }
});

it("keeps a watch bound to an invalidated object when its scene path is reused", async () => {
  const game = await fixture();
  try {
    const run = await game.launch();
    const watch = await game.start(run.executionId, ["identity"], 3, {
      path: "Replaceable",
    });
    const originalRef = watch.boundTargets[0]!.target.objectRef;
    const observed = await game.waitForWindow(run.executionId, watch.watchId);
    expect(observed.records[0]?.targets[0]?.values[0]).toMatchObject({
      status: "success",
      value: "original",
    });
    for (const record of observed.records.slice(1)) {
      expect(record.targets[0]?.target.objectRef).toBe(originalRef);
      expect(record.targets[0]?.values[0]).toMatchObject({
        name: "identity",
        status: "invalid_object",
      });
    }
    const replacement = await game.query(
      run.executionId,
      { path: "Replaceable" },
      ["name"],
    );
    expect(replacement.target.objectRef).not.toBe(originalRef);
    expect(replacement.values[0]).toMatchObject({
      status: "success",
      value: "Replaceable",
    });
    await game.stopExecution(run.executionId);
  } finally {
    await game.close();
  }
});

it("stops on aggregate construction and append-cache budgets without fabricating samples", async () => {
  const game = await fixture();
  try {
    const largeRun = await game.launch();
    const largeWatch = await game.start(
      largeRun.executionId,
      ["large_nested"],
      3,
    );
    const construction = await game.waitForWindow(
      largeRun.executionId,
      largeWatch.watchId,
    );
    expect(construction).toMatchObject({
      stopReason: "construction_budget",
      recordedCount: 0,
      records: [],
    });
    expect(
      (await game.query(largeRun.executionId, { path: "." }, ["callback_tick"]))
        .values[0],
    ).toMatchObject({ status: "success" });
    await game.stopExecution(largeRun.executionId);

    const escapedRun = await game.launch();
    const escapedWatch = await game.start(
      escapedRun.executionId,
      ["escaped_payload"],
      3,
    );
    const encoded = await game.waitForWindow(
      escapedRun.executionId,
      escapedWatch.watchId,
    );
    expect(
      encoded,
      JSON.stringify(game.runtime.records(), null, 2),
    ).toMatchObject({
      stopReason: "encoded_budget",
      recordedCount: 0,
      records: [],
    });
    await game.stopExecution(escapedRun.executionId);

    const cacheRun = await game.launch();
    const cacheWatch = await game.start(
      cacheRun.executionId,
      ["page_payload"],
      256,
    );
    const cached = await game.waitForWindow(
      cacheRun.executionId,
      cacheWatch.watchId,
    );
    expect(cached.stopReason).toBe("encoded_budget");
    expect(cached.recordedCount).toBeGreaterThan(0);
    expect(cached.recordedCount).toBeLessThan(256);
    const stopped = await game.stopExecution(cacheRun.executionId);
    expect(stopped.record.watch?.deliveryComplete).toBe(true);
    expect(stopped.record.watch?.records).toHaveLength(cached.recordedCount);
    expect(
      stopped.record.watch?.records.map((record) => record.sequence),
    ).toEqual(
      Array.from({ length: cached.recordedCount }, (_, index) => index + 1),
    );
  } finally {
    await game.close();
  }
});

it("retrieves the observer's retained samples on fixture-driven normal exit", async () => {
  const game = await fixture();
  try {
    const run = await game.launch();
    const watch = await game.start(run.executionId, ["exit_after_sample"], 32);
    await expect
      .poll(() => game.runtime.records().length, {
        timeout: 10_000,
        interval: 10,
      })
      .toBe(1);
    const stopped = await game.stopExecution(run.executionId);
    expect(stopped.record).toMatchObject({
      sourceUnchanged: true,
      error: null,
      watch: {
        deliveryComplete: true,
        state: {
          watchId: watch.watchId,
          status: "stopped",
          stopReason: "execution_exit",
          recordedCount: 3,
          phase,
        },
      },
    });
    expect(stopped.record.watch?.records).toHaveLength(3);
    expect(
      stopped.record.watch?.records.map((record) => record.sequence),
    ).toEqual([1, 2, 3]);
    expect(await game.read(run.executionId, watch.watchId)).toMatchObject({
      deliveryComplete: true,
      records: stopped.record.watch?.records,
    });
  } finally {
    await game.close();
  }
});

it("keeps only pages actually received when the sandboxed Godot process exits abnormally", async () => {
  const game = await fixture();
  try {
    const run = await game.launch();
    const watch = await game.start(run.executionId, ["callback_tick"], 256);
    let first = await game.read(run.executionId, watch.watchId);
    await expect
      .poll(
        async () => {
          first = await game.read(run.executionId, watch.watchId);
          return first.records.length;
        },
        { timeout: 10_000, interval: 10 },
      )
      .toBeGreaterThan(0);
    // The already-delivered page is the synchronization barrier. This fixture
    // getter arms self-termination only after the Host has that real evidence.
    await game.query(run.executionId, { path: "." }, ["crash_after_sample"]);
    // Do not read again. The observer continues sampling, but a process kill
    // cannot turn undelivered observer records into Host observations.
    await expect
      .poll(() => game.runtime.records().length, {
        timeout: 10_000,
        interval: 10,
      })
      .toBe(1);
    const stopped = await game.stopExecution(run.executionId);
    expect(stopped.record.watch).toMatchObject({
      deliveryComplete: false,
      records: first.records,
    });
    expect(stopped.record.run?.signal).toBe("SIGKILL");
    expect(await game.read(run.executionId, watch.watchId)).toMatchObject({
      deliveryComplete: false,
      records: first.records,
    });
    const nextRun = await game.launch();
    expect(nextRun.executionId).not.toBe(run.executionId);
    await game.stopExecution(nextRun.executionId);
  } finally {
    await game.close();
  }
});
