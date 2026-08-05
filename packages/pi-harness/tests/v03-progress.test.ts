import { describe, expect, it } from "vitest";

import { PiHarnessError } from "../src/errors.js";
import {
  assertV03ProgressMonotonic,
  legacyV03ProgressSnapshot,
} from "../src/internal/v03-progress.js";
import type { V03PiProgressSnapshotV3 } from "../src/v03-types.js";

const snapshot = (
  overrides: Partial<V03PiProgressSnapshotV3> = {},
): V03PiProgressSnapshotV3 => ({
  schemaVersion: 3,
  sequence: 1,
  wallTimeMs: 10,
  fixtureStage: "fixture_validated",
  model: {
    requestStarted: true,
    outputObserved: false,
    turnCompleted: false,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  tools: {
    started: 0,
    completed: 0,
    failed: 0,
    semanticRevision: 0,
    consecutiveNonProgressToolResults: 0,
  },
  game: { baselineExecutions: 1, diagnosticExecutions: 0 },
  proposalSubmitted: false,
  ...overrides,
});

describe("V03 progress snapshots", () => {
  it("accepts monotonic progress and rejects a counter regression", () => {
    const previous = snapshot();
    const next = snapshot({
      sequence: 2,
      wallTimeMs: 20,
      tools: {
        ...previous.tools,
        started: 1,
        completed: 1,
        semanticRevision: 1,
      },
    });
    expect(() => assertV03ProgressMonotonic(previous, next)).not.toThrow();

    expect(() =>
      assertV03ProgressMonotonic(
        next,
        snapshot({ sequence: 3, wallTimeMs: 30 }),
      ),
    ).toThrow(PiHarnessError);
  });

  it("does not treat request start or baseline setup as diagnostic progress", () => {
    expect(legacyV03ProgressSnapshot(snapshot())).toMatchObject({
      progressObserved: false,
      toolCalls: 0,
    });
    const withOutput = snapshot({
      model: {
        ...snapshot().model,
        outputObserved: true,
      },
    });
    expect(legacyV03ProgressSnapshot(withOutput).progressObserved).toBe(true);
  });
});
