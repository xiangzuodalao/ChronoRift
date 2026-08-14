import { z } from "zod";
import {
  PROJECT_CAPABILITY_MODULE_NAMES_V1,
  PROJECT_READY_REQUIRED_MODULE_NAMES_V1,
  ProjectCapabilityModuleNameV1Schema,
  ProjectCapabilitySetV1Schema,
  type ProjectCapabilityModuleNameV1,
} from "@chronorift/domain";

import {
  ProjectAdapterResourceReferenceV1Schema,
  ProjectAdapterStableIdV1Schema,
} from "./project-environment-values.js";

export const PROJECT_ADAPTER_MANIFEST_KIND_V1 =
  "chronorift-project-adapter" as const;
export const PROJECT_ADAPTER_SDK_ID_V1 =
  "chronorift-project-adapter-sdk" as const;
export const PROJECT_ADAPTER_ENGINE_REQUIREMENT_V1 = "4.7.x" as const;

export const PROJECT_ADAPTER_CAPABILITY_MODULES_V1 =
  PROJECT_CAPABILITY_MODULE_NAMES_V1;

export type ProjectAdapterCapabilityModuleV1 = ProjectCapabilityModuleNameV1;

export const PROJECT_ADAPTER_REQUIRED_MODULES_V1 =
  PROJECT_READY_REQUIRED_MODULE_NAMES_V1;

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);

export const ProjectAdapterPackagePathV1Schema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9_][A-Za-z0-9_./-]*$/u)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.includes("\\") &&
      !value.includes("//") &&
      !value
        .split("/")
        .some(
          (segment) => segment === "" || segment === "." || segment === "..",
        ),
    "adapter package paths must be normalized relative paths",
  );

export const ProjectAdapterCapabilityModulesV1Schema =
  ProjectCapabilitySetV1Schema;
export type ProjectAdapterCapabilityModulesV1 = z.infer<
  typeof ProjectAdapterCapabilityModulesV1Schema
>;

const schemaReference = z
  .object({
    schemaVersion: z.literal(1),
    schemaId: ProjectAdapterStableIdV1Schema,
    path: ProjectAdapterPackagePathV1Schema.refine(
      (path) => path.startsWith("schemas/") && path.endsWith(".json"),
      "payload schemas must be JSON files below schemas/",
    ),
    sha256,
  })
  .strict();

const launchTarget = z
  .object({
    schemaVersion: z.literal(1),
    targetId: ProjectAdapterStableIdV1Schema,
    scene: ProjectAdapterResourceReferenceV1Schema,
    default: z.boolean(),
    parametersSchemaId: ProjectAdapterStableIdV1Schema,
    renderer: z.literal("headless"),
    requiredModules: z
      .array(ProjectCapabilityModuleNameV1Schema)
      .max(PROJECT_ADAPTER_CAPABILITY_MODULES_V1.length),
  })
  .strict();

const entityType = z
  .object({
    schemaVersion: z.literal(1),
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

const stateDomain = z
  .object({
    schemaVersion: z.literal(1),
    stateDomainId: ProjectAdapterStableIdV1Schema,
    schemaId: ProjectAdapterStableIdV1Schema,
    checkpointDisposition: z.enum([
      "captured",
      "reset",
      "externally_controlled",
      "unsupported",
      "uncontrolled",
    ]),
  })
  .strict();

const eventType = z
  .object({
    schemaVersion: z.literal(1),
    eventTypeId: ProjectAdapterStableIdV1Schema,
    schemaId: ProjectAdapterStableIdV1Schema,
  })
  .strict();

const smoke = z
  .object({
    schemaVersion: z.literal(1),
    targetId: ProjectAdapterStableIdV1Schema,
    timeoutMs: z.number().int().min(1_000).max(120_000),
    minimumStateSamples: z.number().int().min(1).max(64),
    minimumEntityLifecycleRecords: z.number().int().min(1).max(1_024),
    requiredStateDomainIds: z
      .array(ProjectAdapterStableIdV1Schema)
      .min(1)
      .max(128),
    requiredCustomEventTypeIds: z
      .array(ProjectAdapterStableIdV1Schema)
      .max(128),
  })
  .strict();

const uniqueBy = <T>(
  values: readonly T[],
  key: (value: T) => string,
): boolean => new Set(values.map(key)).size === values.length;

export const ProjectAdapterManifestV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    manifestKind: z.literal(PROJECT_ADAPTER_MANIFEST_KIND_V1),
    adapterId: ProjectAdapterStableIdV1Schema,
    adapterVersion: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.-]+)?$/u),
    sdk: z
      .object({
        id: z.literal(PROJECT_ADAPTER_SDK_ID_V1),
        version: z.literal(1),
      })
      .strict(),
    engine: z
      .object({
        id: z.literal("godot"),
        versionRequirement: z.literal(PROJECT_ADAPTER_ENGINE_REQUIREMENT_V1),
        language: z.literal("gdscript"),
      })
      .strict(),
    entryScript: ProjectAdapterPackagePathV1Schema.refine(
      (path) => path.startsWith("src/") && path.endsWith(".gd"),
      "the adapter entry script must be a GDScript below src/",
    ),
    schemas: z.array(schemaReference).min(1).max(256),
    launchTargets: z.array(launchTarget).min(1).max(32),
    modules: ProjectAdapterCapabilityModulesV1Schema,
    entityTypes: z.array(entityType).min(1).max(128),
    stateDomains: z.array(stateDomain).min(1).max(128),
    eventTypes: z.array(eventType).max(128),
    smoke,
  })
  .strict()
  .superRefine((manifest, context) => {
    const schemaIds = new Set(
      manifest.schemas.map((schema) => schema.schemaId),
    );
    const defaults = manifest.launchTargets.filter((target) => target.default);
    if (defaults.length !== 1) {
      context.addIssue({
        code: "custom",
        path: ["launchTargets"],
        message: "a manifest must declare exactly one default launch target",
      });
    }
    const uniqueness = [
      uniqueBy(manifest.schemas, (value) => value.schemaId),
      uniqueBy(manifest.schemas, (value) => value.path),
      uniqueBy(manifest.launchTargets, (value) => value.targetId),
      uniqueBy(manifest.entityTypes, (value) => value.entityTypeId),
      uniqueBy(manifest.stateDomains, (value) => value.stateDomainId),
      uniqueBy(manifest.eventTypes, (value) => value.eventTypeId),
    ];
    if (uniqueness.some((unique) => !unique)) {
      context.addIssue({
        code: "custom",
        message:
          "manifest schema, target, entity, state, and event identities must be unique",
      });
    }
    const referencedSchemas = [
      ...manifest.launchTargets.map((target) => target.parametersSchemaId),
      ...manifest.entityTypes.map((entity) => entity.schemaId),
      ...manifest.stateDomains.map((domain) => domain.schemaId),
      ...manifest.eventTypes.map((event) => event.schemaId),
    ];
    for (const referenced of referencedSchemas) {
      if (!schemaIds.has(referenced)) {
        context.addIssue({
          code: "custom",
          path: ["schemas"],
          message: `referenced payload schema ${referenced} is not declared`,
        });
      }
    }
    if (
      !manifest.launchTargets.some(
        (target) => target.targetId === manifest.smoke.targetId,
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["smoke", "targetId"],
        message: "smoke target is not declared",
      });
    }
    const stateDomainIds = new Set(
      manifest.stateDomains.map((domain) => domain.stateDomainId),
    );
    for (const id of manifest.smoke.requiredStateDomainIds) {
      if (!stateDomainIds.has(id)) {
        context.addIssue({
          code: "custom",
          path: ["smoke", "requiredStateDomainIds"],
          message: `smoke state domain ${id} is not declared`,
        });
      }
    }
    const eventTypeIds = new Set(
      manifest.eventTypes.map((event) => event.eventTypeId),
    );
    for (const id of manifest.smoke.requiredCustomEventTypeIds) {
      if (!eventTypeIds.has(id)) {
        context.addIssue({
          code: "custom",
          path: ["smoke", "requiredCustomEventTypeIds"],
          message: `smoke event type ${id} is not declared`,
        });
      }
    }
  });

export type ProjectAdapterManifestV1 = z.infer<
  typeof ProjectAdapterManifestV1Schema
>;
