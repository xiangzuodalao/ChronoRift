import type {
  GodotProjectEnvironmentObservationBatchV2,
  GodotProjectEnvironmentObservationRecordV2,
  GodotProjectEnvironmentStatusV1,
} from "@chronorift/godot-protocol";
import {
  ProjectAdapterObservationExecutionValidatorV2,
  recognizeProjectAdapterDynamicTracesV2,
  type LoadedProjectAdapterPackageV2,
  type ProjectAdapterDynamicTraceMatchV2,
} from "@chronorift/godot-adapter";

export interface ProjectEnvironmentObservationBatchSourceV2 {
  nextObservationBatch(
    timeoutMs?: number,
  ): Promise<GodotProjectEnvironmentObservationBatchV2>;
  acknowledgeObservationBatch(
    batch: GodotProjectEnvironmentObservationBatchV2,
    nextWindowBatches?: number,
  ): Promise<void>;
}

export class ProjectEnvironmentValidatedRingV2 {
  readonly #records: GodotProjectEnvironmentObservationRecordV2[] = [];
  readonly #validator: ProjectAdapterObservationExecutionValidatorV2;
  #coverage: GodotProjectEnvironmentStatusV1["coverage"] | undefined;
  #poison: Error | undefined;
  #stopped = false;
  #waiters: (() => void)[] = [];
  #pump: Promise<void> | undefined;

  public constructor(
    loaded: LoadedProjectAdapterPackageV2,
    executionId: string,
    private readonly limit = 4_096,
    private readonly onPoison?:
      ((error: Error) => void | Promise<void>) | undefined,
  ) {
    if (!Number.isInteger(limit) || limit < 128 || limit > 65_536)
      throw new TypeError("validated ring bound is invalid");
    this.#validator = new ProjectAdapterObservationExecutionValidatorV2(
      loaded,
      executionId,
    );
  }

  public start(source: ProjectEnvironmentObservationBatchSourceV2): void {
    if (this.#pump !== undefined)
      throw new Error("validated ring pump already started");
    this.#pump = this.run(source);
    void this.#pump.catch(() => undefined);
  }

  public stop(): Promise<void> {
    this.#stopped = true;
    this.wake();
    return Promise.resolve();
  }

  public async waitFor(
    predicate: (
      records: readonly GodotProjectEnvironmentObservationRecordV2[],
    ) => boolean,
    timeoutMs: number,
  ): Promise<void> {
    const deadline = performance.now() + timeoutMs;
    while (!predicate(this.#records)) {
      this.assertHealthy();
      const remaining = deadline - performance.now();
      if (remaining <= 0)
        throw new Error("timed out waiting for validated V2 observations");
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () =>
            reject(
              new Error("timed out waiting for validated V2 observations"),
            ),
          remaining,
        );
        this.#waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  public query(
    kind: "entities" | "state" | "events" | "errors",
    limit: number,
  ): readonly GodotProjectEnvironmentObservationRecordV2[] {
    this.assertHealthy();
    const expected = {
      entities: "entity_lifecycle",
      state: "state_sample",
      events: "adapter_event",
      errors: "runtime_error",
    } as const;
    return Object.freeze(
      this.#records
        .filter((record) => record.kind === expected[kind])
        .slice(-limit),
    );
  }

  public snapshot(): readonly GodotProjectEnvironmentObservationRecordV2[] {
    this.assertHealthy();
    return Object.freeze([...this.#records]);
  }

  public dynamicTraces(
    loaded: LoadedProjectAdapterPackageV2,
  ): readonly ProjectAdapterDynamicTraceMatchV2[] {
    this.assertHealthy();
    return recognizeProjectAdapterDynamicTracesV2(loaded, this.#records);
  }

  public get coverage():
    GodotProjectEnvironmentStatusV1["coverage"] | undefined {
    return this.#coverage;
  }
  public get poisoned(): boolean {
    return this.#poison !== undefined;
  }
  public get validatedRecordCount(): number {
    return this.#records.length;
  }

  private async run(
    source: ProjectEnvironmentObservationBatchSourceV2,
  ): Promise<void> {
    while (!this.#stopped && this.#poison === undefined) {
      try {
        const batch = await source.nextObservationBatch(2_000);
        const validated = batch.records.map((record) =>
          this.#validator.validate(record),
        );
        if (
          batch.coverage.status !== "complete" ||
          batch.coverage.droppedRecordCount !== 0 ||
          batch.coverage.overwriteCount !== 0 ||
          batch.coverage.semanticCoverage !== "declared"
        )
          throw new Error("V2 observation coverage became incomplete");
        if (this.#records.length + validated.length > this.limit)
          throw new Error(
            "V2 validated ring would overwrite authoritative records",
          );
        this.#records.push(...validated);
        this.#coverage = batch.coverage;
        // ACK only after the entire batch is schema/identity/lineage-valid and retained.
        await source.acknowledgeObservationBatch(batch, 8);
        this.wake();
      } catch (error) {
        if (
          this.#stopped &&
          error instanceof Error &&
          /closed|ended|timeout/iu.test(error.message)
        )
          break;
        this.#poison =
          error instanceof Error
            ? error
            : new Error("V2 observation pump failed");
        await this.onPoison?.(this.#poison);
        this.wake();
        break;
      }
    }
  }

  private wake(): void {
    for (const waiter of this.#waiters.splice(0)) waiter();
  }
  private assertHealthy(): void {
    if (this.#poison !== undefined) throw this.#poison;
  }
}
