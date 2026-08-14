import {
  GodotProjectEnvironmentObservationRecordV2Schema,
  ProjectAdapterEntityRefV2Schema,
  validateProjectAdapterPayloadV2,
  type GodotProjectEnvironmentObservationRecordV2,
  type ProjectAdapterEntityRefV2,
  type ProjectAdapterPayloadSchemaDocumentV2,
  type ProjectAdapterValueV2,
} from "@chronorift/godot-protocol";

import type { LoadedProjectAdapterPackageV2 } from "./project-adapter-package-v2.js";

export class ProjectAdapterObservationV2ValidationError extends Error {
  public override readonly name = "ProjectAdapterObservationV2ValidationError";
}

interface EntityStateV2 {
  readonly active: boolean;
  readonly entityTypeId: string;
  readonly incarnation: number;
  readonly identityScope: string;
}

const fail = (message: string): never => {
  throw new ProjectAdapterObservationV2ValidationError(message);
};

const schemaById = (
  loaded: LoadedProjectAdapterPackageV2,
  schemaId: string,
): ProjectAdapterPayloadSchemaDocumentV2 =>
  loaded.schemas.find((schema) => schema.schemaId === schemaId) ??
  fail(`ProjectAdapter V2 observation references missing schema ${schemaId}`);

const everyEntityRef = (
  value: ProjectAdapterValueV2,
  visit: (reference: ProjectAdapterEntityRefV2) => void,
): void => {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((child) =>
      everyEntityRef(child as ProjectAdapterValueV2, visit),
    );
    return;
  }
  const record = value as Readonly<Record<string, ProjectAdapterValueV2>>;
  if (record.$type === "entity_ref") {
    visit(
      ProjectAdapterEntityRefV2Schema.parse({
        schemaVersion: record.schemaVersion,
        executionId: record.executionId,
        entityId: record.entityId,
        incarnation: record.incarnation,
      }),
    );
  }
  Object.values(record).forEach((child) => everyEntityRef(child, visit));
};

const sameClockOrLater = (
  previous: GodotProjectEnvironmentObservationRecordV2["clock"],
  next: GodotProjectEnvironmentObservationRecordV2["clock"],
): boolean =>
  next.processFrame >= previous.processFrame &&
  next.physicsTick >= previous.physicsTick &&
  next.simulationTimeUs >= previous.simulationTimeUs &&
  (previous.renderFrame === null ||
    next.renderFrame === null ||
    next.renderFrame >= previous.renderFrame);

/**
 * Stateful authority for one V2 Execution. A failure poisons the validator:
 * later well-formed records cannot restore a trustworthy lineage.
 */
export class ProjectAdapterObservationExecutionValidatorV2 {
  readonly #entities = new Map<string, EntityStateV2>();
  #nextSequence = 0;
  #clock: GodotProjectEnvironmentObservationRecordV2["clock"] | undefined;
  #failure: ProjectAdapterObservationV2ValidationError | undefined;

  public constructor(
    private readonly loaded: LoadedProjectAdapterPackageV2,
    private readonly executionId: string,
  ) {}

  public get poisoned(): boolean {
    return this.#failure !== undefined;
  }

  public validate(input: unknown): GodotProjectEnvironmentObservationRecordV2 {
    if (this.#failure !== undefined) throw this.#failure;
    try {
      return this.validateUnpoisoned(input);
    } catch (error) {
      this.#failure =
        error instanceof ProjectAdapterObservationV2ValidationError
          ? error
          : new ProjectAdapterObservationV2ValidationError(
              error instanceof Error ? error.message : "invalid V2 observation",
            );
      throw this.#failure;
    }
  }

  private validateUnpoisoned(
    input: unknown,
  ): GodotProjectEnvironmentObservationRecordV2 {
    const record =
      GodotProjectEnvironmentObservationRecordV2Schema.parse(input);
    if (record.executionId !== this.executionId)
      fail("observation belongs to another Execution");
    if (record.recordSequence !== this.#nextSequence)
      fail(
        `expected record sequence ${this.#nextSequence}, received ${record.recordSequence}`,
      );
    if (
      this.#clock !== undefined &&
      !sameClockOrLater(this.#clock, record.clock)
    )
      fail("observation clock moved backwards");
    this.#nextSequence += 1;
    this.#clock = record.clock;

    if (record.kind === "entity_lifecycle") this.validateLifecycle(record);
    else if (record.kind === "state_sample") this.validateState(record);
    else if (record.kind === "adapter_event") this.validateEvent(record);
    else if (record.kind === "capture_loss")
      fail("capture loss makes V2 lineage incomplete");
    return record;
  }

  private validateReference(
    reference: ProjectAdapterEntityRefV2,
  ): EntityStateV2 {
    if (reference.executionId !== this.executionId)
      fail("entity reference belongs to another Execution");
    const state = this.#entities.get(reference.entityId);
    if (
      state === undefined ||
      !state.active ||
      state.incarnation !== reference.incarnation
    )
      return fail(
        `entity reference is stale or inactive: ${reference.entityId}`,
      );
    return state;
  }

  private validatePayload(
    schemaId: string,
    value: ProjectAdapterValueV2,
  ): void {
    const validated = validateProjectAdapterPayloadV2(
      schemaById(this.loaded, schemaId),
      value,
    );
    everyEntityRef(validated, (reference) => this.validateReference(reference));
  }

  private validateLifecycle(
    record: Extract<
      GodotProjectEnvironmentObservationRecordV2,
      { readonly kind: "entity_lifecycle" }
    >,
  ): void {
    const payload = record.payload;
    if (payload.entity.executionId !== this.executionId)
      fail("lifecycle reference belongs to another Execution");
    const declaration =
      this.loaded.manifest.entityTypes.find(
        (candidate) => candidate.entityTypeId === payload.entityTypeId,
      ) ?? fail(`undeclared entity type ${payload.entityTypeId}`);
    if (declaration.identityStrategy !== payload.identityScope)
      fail("entity identity strategy differs from its manifest");
    const previous = this.#entities.get(payload.entity.entityId);
    if (payload.phase === "appeared") {
      if (previous?.active === true)
        fail("duplicate appeared for active entity");
      if (previous === undefined && payload.entity.incarnation !== 1)
        fail("first entity incarnation must be 1");
      if (
        previous !== undefined &&
        payload.entity.incarnation !== previous.incarnation + 1
      )
        fail("entity incarnation must increase by exactly 1");
      if (
        previous !== undefined &&
        (previous.entityTypeId !== payload.entityTypeId ||
          previous.identityScope !== payload.identityScope)
      )
        fail("entity type or identity scope changed across incarnations");
      if (payload.projection === null)
        fail("appeared lifecycle requires a projection");
      this.#entities.set(payload.entity.entityId, {
        active: true,
        entityTypeId: payload.entityTypeId,
        incarnation: payload.entity.incarnation,
        identityScope: payload.identityScope,
      });
      this.validatePayload(declaration.schemaId, payload.projection);
      return;
    }
    const active = this.validateReference(payload.entity);
    if (
      active.entityTypeId !== payload.entityTypeId ||
      active.identityScope !== payload.identityScope
    )
      fail("active entity declaration changed");
    if (payload.phase === "updated") {
      if (payload.projection === null)
        fail("updated lifecycle requires a projection");
      this.validatePayload(declaration.schemaId, payload.projection);
    } else {
      if (payload.projection !== null)
        fail("disappeared lifecycle projection must be null");
      this.#entities.set(payload.entity.entityId, { ...active, active: false });
    }
  }

  private validateState(
    record: Extract<
      GodotProjectEnvironmentObservationRecordV2,
      { readonly kind: "state_sample" }
    >,
  ): void {
    const declaration =
      this.loaded.manifest.stateDomains.find(
        (candidate) => candidate.stateDomainId === record.payload.stateDomainId,
      ) ?? fail(`undeclared state domain ${record.payload.stateDomainId}`);
    if (declaration.subject.kind === "project") {
      if (record.payload.subjectEntity !== null)
        fail("project-scoped state must use a null subject");
    } else {
      if (record.payload.subjectEntity === null)
        return fail("entity-scoped state requires a subject");
      const entity = this.validateReference(record.payload.subjectEntity);
      if (
        !declaration.subject.allowedEntityTypeIds.includes(entity.entityTypeId)
      )
        fail("state subject entity type is not allowed");
    }
    this.validatePayload(declaration.schemaId, record.payload.value);
  }

  private validateEvent(
    record: Extract<
      GodotProjectEnvironmentObservationRecordV2,
      { readonly kind: "adapter_event" }
    >,
  ): void {
    const declaration =
      this.loaded.manifest.eventTypes.find(
        (candidate) => candidate.eventTypeId === record.payload.eventTypeId,
      ) ?? fail(`undeclared event type ${record.payload.eventTypeId}`);
    if (declaration.source.kind === "project") {
      if (record.payload.sourceEntity !== null)
        fail("project-scoped event must use a null source");
    } else {
      if (record.payload.sourceEntity === null)
        return fail("entity-scoped event requires a source");
      const entity = this.validateReference(record.payload.sourceEntity);
      if (
        !declaration.source.allowedEntityTypeIds.includes(entity.entityTypeId)
      )
        fail("event source entity type is not allowed");
    }
    this.validatePayload(declaration.schemaId, record.payload.value);
  }
}

export interface ProjectAdapterDynamicTraceMatchV2 {
  readonly traceId: string;
  readonly entityId: string;
  readonly firstIncarnation: number;
  readonly lastIncarnation: number;
  readonly recordSequences: readonly number[];
}

const valueDigest = (value: ProjectAdapterValueV2): string =>
  JSON.stringify(value);

/** Recognizes the declared ordered trace without claiming event/state causality. */
export const recognizeProjectAdapterDynamicTracesV2 = (
  loaded: LoadedProjectAdapterPackageV2,
  records: readonly GodotProjectEnvironmentObservationRecordV2[],
): readonly ProjectAdapterDynamicTraceMatchV2[] =>
  Object.freeze(
    loaded.manifest.smoke.requiredDynamicTraces.map((trace) => {
      const candidates = new Map<
        string,
        GodotProjectEnvironmentObservationRecordV2[]
      >();
      for (const record of records) {
        const reference =
          record.kind === "entity_lifecycle"
            ? record.payload.entity
            : record.kind === "state_sample"
              ? record.payload.subjectEntity
              : record.kind === "adapter_event"
                ? record.payload.sourceEntity
                : null;
        if (reference === null) continue;
        const values = candidates.get(reference.entityId) ?? [];
        values.push(record);
        candidates.set(reference.entityId, values);
      }
      for (const [entityId, values] of candidates) {
        const matchedSequences: number[] = [];
        let position = 0;
        let firstStateDigest = "";
        let firstIncarnation = 0;
        let expectedIncarnation = 0;
        for (const record of values) {
          const reference =
            record.kind === "entity_lifecycle"
              ? record.payload.entity
              : record.kind === "state_sample"
                ? record.payload.subjectEntity
                : record.kind === "adapter_event"
                  ? record.payload.sourceEntity
                  : null;
          if (reference === null) continue;
          const isAppeared =
            record.kind === "entity_lifecycle" &&
            record.payload.phase === "appeared" &&
            record.payload.entityTypeId === trace.entityTypeId;
          const isDisappeared =
            record.kind === "entity_lifecycle" &&
            record.payload.phase === "disappeared" &&
            record.payload.entityTypeId === trace.entityTypeId;
          const isState =
            record.kind === "state_sample" &&
            record.payload.stateDomainId === trace.stateDomainId;
          const isEvent =
            record.kind === "adapter_event" &&
            record.payload.eventTypeId === trace.eventTypeId;
          const accept = (): void => {
            matchedSequences.push(record.recordSequence);
            position += 1;
          };
          if (position === 0 && isAppeared) {
            firstIncarnation = reference.incarnation;
            expectedIncarnation = firstIncarnation;
            accept();
          } else if (
            (position === 1 || position === 6) &&
            isState &&
            reference.incarnation === expectedIncarnation
          ) {
            firstStateDigest = valueDigest(record.payload.value);
            accept();
          } else if (
            (position === 2 || position === 7) &&
            isEvent &&
            reference.incarnation === expectedIncarnation
          )
            accept();
          else if (
            (position === 3 || position === 8) &&
            isState &&
            reference.incarnation === expectedIncarnation &&
            valueDigest(record.payload.value) !== firstStateDigest
          )
            accept();
          else if (
            position === 4 &&
            isDisappeared &&
            reference.incarnation === expectedIncarnation
          )
            accept();
          else if (
            position === 5 &&
            isAppeared &&
            reference.incarnation === expectedIncarnation + 1
          ) {
            expectedIncarnation = reference.incarnation;
            accept();
          }
          if (
            position === 9 &&
            expectedIncarnation - firstIncarnation + 1 >=
              trace.minimumIncarnations
          ) {
            return Object.freeze({
              traceId: trace.traceId,
              entityId,
              firstIncarnation,
              lastIncarnation: expectedIncarnation,
              recordSequences: Object.freeze(matchedSequences),
            });
          }
        }
      }
      return fail(`required dynamic trace was not observed: ${trace.traceId}`);
    }),
  );
