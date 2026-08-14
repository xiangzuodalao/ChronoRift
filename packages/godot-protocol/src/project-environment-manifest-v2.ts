import { z } from "zod";
import {
  PROJECT_CAPABILITY_MODULE_NAMES_V1,
  PROJECT_READY_REQUIRED_MODULE_NAMES_V1,
  ProjectCapabilityModuleNameV1Schema,
  ProjectCapabilitySetV1Schema,
  type ProjectCapabilityModuleNameV1,
} from "@chronorift/domain";

import { ProjectAdapterPackagePathV1Schema } from "./project-environment-manifest.js";
import {
  ProjectAdapterResourceReferenceV1Schema,
  ProjectAdapterStableIdV1Schema,
} from "./project-environment-values.js";

export const PROJECT_ADAPTER_MANIFEST_KIND_V2 =
  "chronorift-project-adapter" as const;
export const PROJECT_ADAPTER_SDK_ID_V2 =
  "chronorift-project-adapter-sdk" as const;
export const PROJECT_ADAPTER_ENGINE_REQUIREMENT_V2 = "4.7.x" as const;
export const PROJECT_ADAPTER_CAPABILITY_MODULES_V2 =
  PROJECT_CAPABILITY_MODULE_NAMES_V1;
export const PROJECT_ADAPTER_REQUIRED_MODULES_V2 =
  PROJECT_READY_REQUIRED_MODULE_NAMES_V1;
export type ProjectAdapterCapabilityModuleV2 = ProjectCapabilityModuleNameV1;

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const schemaReference = z
  .object({
    schemaVersion: z.literal(2),
    schemaId: ProjectAdapterStableIdV1Schema,
    path: ProjectAdapterPackagePathV1Schema.refine(
      (path) => path.startsWith("schemas/") && path.endsWith(".json"),
    ),
    sha256,
  })
  .strict();
const launchTarget = z
  .object({
    schemaVersion: z.literal(2),
    targetId: ProjectAdapterStableIdV1Schema,
    scene: ProjectAdapterResourceReferenceV1Schema,
    default: z.boolean(),
    parametersSchemaId: ProjectAdapterStableIdV1Schema,
    renderer: z.literal("headless"),
    requiredModules: z.array(ProjectCapabilityModuleNameV1Schema).max(12),
  })
  .strict();
const entityType = z
  .object({
    schemaVersion: z.literal(2),
    entityTypeId: ProjectAdapterStableIdV1Schema,
    schemaId: ProjectAdapterStableIdV1Schema,
    identityStrategy: z.enum([
      "project_persistent",
      "authored",
      "spawn_lineage",
      "execution_local",
    ]),
  })
  .strict();
const subjectScope = z.discriminatedUnion("kind", [
  z
    .object({ schemaVersion: z.literal(2), kind: z.literal("project") })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(2),
      kind: z.literal("entity"),
      allowedEntityTypeIds: z
        .array(ProjectAdapterStableIdV1Schema)
        .min(1)
        .max(128),
    })
    .strict(),
]);
const stateDomain = z
  .object({
    schemaVersion: z.literal(2),
    stateDomainId: ProjectAdapterStableIdV1Schema,
    schemaId: ProjectAdapterStableIdV1Schema,
    checkpointDisposition: z.enum([
      "captured",
      "reset",
      "externally_controlled",
      "unsupported",
      "uncontrolled",
    ]),
    subject: subjectScope,
  })
  .strict();
const eventType = z
  .object({
    schemaVersion: z.literal(2),
    eventTypeId: ProjectAdapterStableIdV1Schema,
    schemaId: ProjectAdapterStableIdV1Schema,
    source: subjectScope,
  })
  .strict();
const dynamicTrace = z
  .object({
    schemaVersion: z.literal(2),
    traceId: ProjectAdapterStableIdV1Schema,
    entityTypeId: ProjectAdapterStableIdV1Schema,
    stateDomainId: ProjectAdapterStableIdV1Schema,
    eventTypeId: ProjectAdapterStableIdV1Schema,
    minimumIncarnations: z.number().int().min(2).max(16),
  })
  .strict();
const smoke = z
  .object({
    schemaVersion: z.literal(2),
    targetId: ProjectAdapterStableIdV1Schema,
    timeoutMs: z.number().int().min(1_000).max(120_000),
    minimumStateSamples: z.number().int().min(2).max(4_096),
    minimumEntityLifecycleRecords: z.number().int().min(3).max(4_096),
    requiredStateDomainIds: z
      .array(ProjectAdapterStableIdV1Schema)
      .min(1)
      .max(128),
    requiredCustomEventTypeIds: z
      .array(ProjectAdapterStableIdV1Schema)
      .min(1)
      .max(128),
    requiredDynamicTraces: z.array(dynamicTrace).min(1).max(32),
  })
  .strict();

const unique = <T>(values: readonly T[], key: (value: T) => string): boolean =>
  new Set(values.map(key)).size === values.length;

export const ProjectAdapterManifestV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    manifestKind: z.literal(PROJECT_ADAPTER_MANIFEST_KIND_V2),
    adapterId: ProjectAdapterStableIdV1Schema,
    adapterVersion: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.-]+)?$/u),
    sdk: z
      .object({
        id: z.literal(PROJECT_ADAPTER_SDK_ID_V2),
        version: z.literal(2),
      })
      .strict(),
    engine: z
      .object({
        id: z.literal("godot"),
        versionRequirement: z.literal(PROJECT_ADAPTER_ENGINE_REQUIREMENT_V2),
        language: z.literal("gdscript"),
      })
      .strict(),
    entryScript: ProjectAdapterPackagePathV1Schema.refine(
      (path) => path.startsWith("src/") && path.endsWith(".gd"),
    ),
    schemas: z.array(schemaReference).min(1).max(256),
    launchTargets: z.array(launchTarget).min(1).max(32),
    modules: ProjectCapabilitySetV1Schema,
    entityTypes: z.array(entityType).min(1).max(128),
    stateDomains: z.array(stateDomain).min(1).max(128),
    eventTypes: z.array(eventType).min(1).max(128),
    smoke,
  })
  .strict()
  .superRefine((manifest, context) => {
    const schemaIds = new Set(manifest.schemas.map((value) => value.schemaId));
    const entityTypes = new Set(
      manifest.entityTypes.map((value) => value.entityTypeId),
    );
    const stateDomains = new Map(
      manifest.stateDomains.map((value) => [value.stateDomainId, value]),
    );
    const eventTypes = new Map(
      manifest.eventTypes.map((value) => [value.eventTypeId, value]),
    );
    if (
      manifest.launchTargets.filter((target) => target.default).length !== 1
    ) {
      context.addIssue({
        code: "custom",
        path: ["launchTargets"],
        message: "exactly one launch target must be default",
      });
    }
    if (
      !unique(manifest.schemas, (value) => value.schemaId) ||
      !unique(manifest.launchTargets, (value) => value.targetId) ||
      !unique(manifest.entityTypes, (value) => value.entityTypeId) ||
      !unique(manifest.stateDomains, (value) => value.stateDomainId) ||
      !unique(manifest.eventTypes, (value) => value.eventTypeId) ||
      !unique(manifest.smoke.requiredDynamicTraces, (value) => value.traceId)
    ) {
      context.addIssue({
        code: "custom",
        message: "manifest identities must be unique",
      });
    }
    for (const schemaId of [
      ...manifest.launchTargets.map((value) => value.parametersSchemaId),
      ...manifest.entityTypes.map((value) => value.schemaId),
      ...manifest.stateDomains.map((value) => value.schemaId),
      ...manifest.eventTypes.map((value) => value.schemaId),
    ]) {
      if (!schemaIds.has(schemaId))
        context.addIssue({
          code: "custom",
          path: ["schemas"],
          message: `missing declared schema ${schemaId}`,
        });
    }
    for (const declaration of [
      ...manifest.stateDomains.map((value) => value.subject),
      ...manifest.eventTypes.map((value) => value.source),
    ]) {
      if (
        declaration.kind === "entity" &&
        declaration.allowedEntityTypeIds.some((id) => !entityTypes.has(id))
      ) {
        context.addIssue({
          code: "custom",
          message: "scope references an undeclared entity type",
        });
      }
    }
    for (const trace of manifest.smoke.requiredDynamicTraces) {
      const state = stateDomains.get(trace.stateDomainId);
      const event = eventTypes.get(trace.eventTypeId);
      if (
        !entityTypes.has(trace.entityTypeId) ||
        state?.subject.kind !== "entity" ||
        event?.source.kind !== "entity" ||
        !state.subject.allowedEntityTypeIds.includes(trace.entityTypeId) ||
        !event.source.allowedEntityTypeIds.includes(trace.entityTypeId)
      ) {
        context.addIssue({
          code: "custom",
          path: ["smoke", "requiredDynamicTraces"],
          message: `dynamic trace ${trace.traceId} is not backed by entity-scoped declarations`,
        });
      }
    }
  });

export type ProjectAdapterManifestV2 = z.infer<
  typeof ProjectAdapterManifestV2Schema
>;
