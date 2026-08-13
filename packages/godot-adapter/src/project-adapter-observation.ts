import {
  GodotProjectEnvironmentObservationRecordV1Schema,
  validateProjectAdapterPayloadV1,
  type GodotProjectEnvironmentObservationRecordV1,
  type ProjectAdapterPayloadSchemaDocumentV1,
} from "@chronorift/godot-protocol";

import type { LoadedProjectAdapterPackageV1 } from "./project-adapter-package.js";

export class ProjectAdapterObservationValidationError extends Error {
  public override readonly name = "ProjectAdapterObservationValidationError";
}

interface ProjectAdapterEntityLifecycleStateV1 {
  readonly active: boolean;
  readonly entityTypeId: string;
  readonly incarnation: number;
  readonly identityScope: string;
}

const fail = (message: string): never => {
  throw new ProjectAdapterObservationValidationError(message);
};

const schemaById = (
  loaded: LoadedProjectAdapterPackageV1,
  schemaId: string,
): ProjectAdapterPayloadSchemaDocumentV1 =>
  loaded.schemas.find((schema) => schema.schemaId === schemaId) ??
  fail(`ProjectAdapter observation references missing schema ${schemaId}`);

/**
 * Applies the exact published manifest and payload schema to one untrusted
 * bridge observation. The wire schema proves only a bounded canonical shape;
 * this check proves that the project-specific IDs and payload projection are
 * declared by the pinned Adapter revision.
 */
export const validateProjectAdapterObservationV1 = (
  loaded: LoadedProjectAdapterPackageV1,
  input: unknown,
): GodotProjectEnvironmentObservationRecordV1 => {
  const record = GodotProjectEnvironmentObservationRecordV1Schema.parse(input);
  if (record.kind === "entity_lifecycle") {
    const declaration = loaded.manifest.entityTypes.find(
      (candidate) => candidate.entityTypeId === record.payload.entityTypeId,
    );
    if (declaration === undefined) {
      return fail(
        `ProjectAdapter emitted undeclared entity type ${record.payload.entityTypeId}`,
      );
    }
    if (declaration.identityStrategy !== record.payload.identityScope) {
      return fail(
        `ProjectAdapter entity type ${record.payload.entityTypeId} changed its declared identity strategy`,
      );
    }
    if (record.payload.phase !== "disappeared") {
      validateProjectAdapterPayloadV1(
        schemaById(loaded, declaration.schemaId),
        record.payload.projection,
      );
    }
  } else if (record.kind === "state_sample") {
    const declaration = loaded.manifest.stateDomains.find(
      (candidate) => candidate.stateDomainId === record.payload.stateDomainId,
    );
    if (declaration === undefined) {
      return fail(
        `ProjectAdapter emitted undeclared state domain ${record.payload.stateDomainId}`,
      );
    }
    validateProjectAdapterPayloadV1(
      schemaById(loaded, declaration.schemaId),
      record.payload.value,
    );
  } else if (record.kind === "adapter_event") {
    const declaration = loaded.manifest.eventTypes.find(
      (candidate) => candidate.eventTypeId === record.payload.eventTypeId,
    );
    if (declaration === undefined) {
      return fail(
        `ProjectAdapter emitted undeclared event type ${record.payload.eventTypeId}`,
      );
    }
    validateProjectAdapterPayloadV1(
      schemaById(loaded, declaration.schemaId),
      record.payload.value,
    );
  }
  return record;
};

/**
 * Applies the cross-record entity invariants that a single wire DTO cannot
 * prove. Create one validator per Execution and feed it authoritative transport
 * observations in record order; query results are historical views and must not
 * be replayed through this state machine.
 */
export class ProjectAdapterObservationExecutionValidatorV1 {
  readonly #entities = new Map<string, ProjectAdapterEntityLifecycleStateV1>();

  public constructor(private readonly loaded: LoadedProjectAdapterPackageV1) {}

  public validate(input: unknown): GodotProjectEnvironmentObservationRecordV1 {
    const record = validateProjectAdapterObservationV1(this.loaded, input);
    if (record.kind !== "entity_lifecycle") return record;
    const entity = record.payload;
    const previous = this.#entities.get(entity.entityId);
    if (entity.phase === "appeared") {
      if (previous?.active === true) {
        return fail(
          `ProjectAdapter emitted duplicate appeared lifecycle for active entity ${entity.entityId}`,
        );
      }
      if (
        previous !== undefined &&
        (previous.entityTypeId !== entity.entityTypeId ||
          previous.identityScope !== entity.identityScope)
      ) {
        return fail(
          `ProjectAdapter reused entity ${entity.entityId} with a different declared type or identity scope`,
        );
      }
      if (
        previous !== undefined &&
        entity.incarnation <= previous.incarnation
      ) {
        return fail(
          `ProjectAdapter entity ${entity.entityId} reappeared without a greater incarnation`,
        );
      }
      this.#entities.set(entity.entityId, {
        active: true,
        entityTypeId: entity.entityTypeId,
        incarnation: entity.incarnation,
        identityScope: entity.identityScope,
      });
      return record;
    }
    if (previous === undefined || !previous.active) {
      return fail(
        `ProjectAdapter emitted ${entity.phase} lifecycle for unknown inactive entity ${entity.entityId}`,
      );
    }
    if (
      previous.entityTypeId !== entity.entityTypeId ||
      previous.identityScope !== entity.identityScope ||
      previous.incarnation !== entity.incarnation
    ) {
      return fail(
        `ProjectAdapter entity ${entity.entityId} changed type, identity scope, or incarnation while active`,
      );
    }
    if (entity.phase === "disappeared") {
      this.#entities.set(entity.entityId, { ...previous, active: false });
    }
    return record;
  }
}

export const validateProjectAdapterQueryRowsV1 = (
  loaded: LoadedProjectAdapterPackageV1,
  queryKind: "entities" | "state" | "events" | "errors",
  rows: readonly unknown[],
): readonly GodotProjectEnvironmentObservationRecordV1[] => {
  const expectedKind = {
    entities: "entity_lifecycle",
    state: "state_sample",
    events: "adapter_event",
    errors: "runtime_error",
  } as const;
  return Object.freeze(
    rows.map((row) => {
      const record = validateProjectAdapterObservationV1(loaded, row);
      if (record.kind !== expectedKind[queryKind]) {
        return fail(
          `ProjectAdapter query ${queryKind} returned record kind ${record.kind}`,
        );
      }
      return record;
    }),
  );
};
