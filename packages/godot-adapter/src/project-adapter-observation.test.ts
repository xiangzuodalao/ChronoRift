import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  loadProjectAdapterPackageV1,
  ProjectAdapterObservationExecutionValidatorV1,
  validateProjectAdapterObservationV1,
  validateProjectAdapterQueryRowsV1,
} from "./index.js";

const fixtureRoot = join(
  process.cwd(),
  "fixtures/godot-project-environment-snapshot-characterization/adapter",
);

const record = (kind: string, payload: unknown) => ({
  schemaVersion: 1,
  recordSequence: 0,
  clock: {
    processFrame: 1,
    physicsTick: 1,
    simulationTimeUs: 1,
    renderFrame: null,
  },
  kind,
  payload,
});

describe("ProjectAdapter observation validation", () => {
  it("validates declared entity/state projections against exact package schemas", async () => {
    const loaded = await loadProjectAdapterPackageV1(fixtureRoot);
    expect(
      validateProjectAdapterObservationV1(
        loaded,
        record("entity_lifecycle", {
          phase: "appeared",
          entityId: "scene.root",
          entityTypeId: "root",
          incarnation: 1,
          identityScope: "execution_local",
          projection: { name: "Main" },
        }),
      ).kind,
    ).toBe("entity_lifecycle");
    expect(
      validateProjectAdapterQueryRowsV1(loaded, "state", [
        record("state_sample", {
          stateDomainId: "world",
          value: { counter: 7 },
          semanticCoverage: "declared",
        }),
      ]),
    ).toHaveLength(1);
  });

  it("rejects undeclared IDs, schema mismatch, identity drift, and wrong query kinds", async () => {
    const loaded = await loadProjectAdapterPackageV1(fixtureRoot);
    const entity = record("entity_lifecycle", {
      phase: "appeared",
      entityId: "scene.root",
      entityTypeId: "root",
      incarnation: 1,
      identityScope: "execution_local",
      projection: { name: "Main" },
    });
    expect(() =>
      validateProjectAdapterObservationV1(loaded, {
        ...entity,
        payload: {
          phase: "appeared",
          entityId: "scene.root",
          entityTypeId: "undeclared",
          incarnation: 1,
          identityScope: "execution_local",
          projection: { name: "Main" },
        },
      }),
    ).toThrow(/undeclared entity type/u);
    expect(() =>
      validateProjectAdapterObservationV1(loaded, {
        ...entity,
        payload: {
          phase: "appeared",
          entityId: "scene.root",
          entityTypeId: "root",
          incarnation: 1,
          identityScope: "authored",
          projection: { name: "Main" },
        },
      }),
    ).toThrow(/identity strategy/u);
    expect(() =>
      validateProjectAdapterObservationV1(
        loaded,
        record("state_sample", {
          stateDomainId: "world",
          value: { counter: "seven" },
          semanticCoverage: "declared",
        }),
      ),
    ).toThrow(/expected a canonical finite number/u);
    expect(() =>
      validateProjectAdapterQueryRowsV1(loaded, "state", [entity]),
    ).toThrow(/returned record kind/u);
  });

  it("keeps the fixture schema hashes bound to exact bytes", async () => {
    const loaded = await loadProjectAdapterPackageV1(fixtureRoot);
    for (const declaration of loaded.manifest.schemas) {
      const bytes = await readFile(join(fixtureRoot, declaration.path));
      expect(bytes.byteLength).toBeGreaterThan(0);
    }
  });

  it("rejects duplicate appearance and lifecycle for an unknown entity", async () => {
    const loaded = await loadProjectAdapterPackageV1(fixtureRoot);
    const appeared = record("entity_lifecycle", {
      phase: "appeared",
      entityId: "scene.root",
      entityTypeId: "root",
      incarnation: 1,
      identityScope: "execution_local",
      projection: { name: "Main" },
    });
    const validator = new ProjectAdapterObservationExecutionValidatorV1(loaded);
    expect(validator.validate(appeared).kind).toBe("entity_lifecycle");
    expect(() =>
      validator.validate({ ...appeared, recordSequence: 1 }),
    ).toThrow(/duplicate appeared/u);

    const unknown = new ProjectAdapterObservationExecutionValidatorV1(loaded);
    expect(() =>
      unknown.validate(
        record("entity_lifecycle", {
          phase: "disappeared",
          entityId: "scene.root",
          entityTypeId: "root",
          incarnation: 1,
          identityScope: "execution_local",
          projection: null,
        }),
      ),
    ).toThrow(/unknown inactive entity/u);
  });

  it("requires a greater incarnation when a stable entity reappears", async () => {
    const loaded = await loadProjectAdapterPackageV1(fixtureRoot);
    const lifecycle = (
      recordSequence: number,
      phase: "appeared" | "updated" | "disappeared",
      incarnation: number,
    ) => ({
      ...record("entity_lifecycle", {
        phase,
        entityId: "scene.root",
        entityTypeId: "root",
        incarnation,
        identityScope: "execution_local",
        projection: phase === "disappeared" ? null : { name: "Main" },
      }),
      recordSequence,
    });
    const validator = new ProjectAdapterObservationExecutionValidatorV1(loaded);
    validator.validate(lifecycle(0, "appeared", 1));
    validator.validate(lifecycle(1, "updated", 1));
    validator.validate(lifecycle(2, "disappeared", 1));
    expect(() => validator.validate(lifecycle(3, "appeared", 1))).toThrow(
      /greater incarnation/u,
    );
    expect(validator.validate(lifecycle(4, "appeared", 2)).kind).toBe(
      "entity_lifecycle",
    );
    expect(() => validator.validate(lifecycle(5, "updated", 3))).toThrow(
      /changed type, identity scope, or incarnation/u,
    );
  });
});
