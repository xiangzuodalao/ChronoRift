import { z } from "zod";

import {
  PatchIdSchema,
  Sha256DigestV1Schema,
  TaskIdSchema,
  type PatchId,
  type Sha256DigestV1,
  type TaskId,
} from "@chronorift/domain";
import { contentHash } from "@chronorift/json-artifacts";

import { DeclaredSourceUrlV1Schema } from "./godot-project-descriptor.js";

const GitObjectIdV1Schema = z
  .string()
  .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);
const IsoTimestampV1Schema = z.string().datetime({ offset: true });

const isNormalizedRelativePosixPath = (value: string): boolean =>
  !value.startsWith("/") &&
  !value.includes("\\") &&
  !value.includes("\0") &&
  value
    .split("/")
    .every((segment) => segment !== "" && segment !== "." && segment !== "..");

export const RelativeExportPathV1Schema = z
  .string()
  .min(1)
  .refine(
    isNormalizedRelativePosixPath,
    "outputPath must be a normalized relative POSIX path",
  );

const ProjectPrefixV1Schema = z
  .string()
  .refine(
    (value) => value === "" || isNormalizedRelativePosixPath(value),
    "projectPrefix must be empty or a normalized relative POSIX path",
  );

export interface FixtureControlRangeV1 {
  readonly default: number;
  readonly allowed?: readonly number[] | undefined;
  readonly minimum?: number | undefined;
  readonly maximum?: number | undefined;
}

export const FixtureControlRangeV1Schema: z.ZodType<FixtureControlRangeV1> = z
  .object({
    default: z.number().finite(),
    allowed: z.array(z.number().finite()).min(1).optional(),
    minimum: z.number().finite().optional(),
    maximum: z.number().finite().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    for (const key of ["allowed", "minimum", "maximum"] as const) {
      if (
        Object.prototype.hasOwnProperty.call(value, key) &&
        value[key] === undefined
      ) {
        context.addIssue({
          code: "custom",
          path: [key],
          message: `${key} must be omitted rather than set to undefined`,
        });
      }
    }
    if (
      value.minimum !== undefined &&
      value.maximum !== undefined &&
      value.minimum > value.maximum
    ) {
      context.addIssue({
        code: "custom",
        path: ["minimum"],
        message: "minimum must not exceed maximum",
      });
    }
    if (
      (value.minimum !== undefined && value.default < value.minimum) ||
      (value.maximum !== undefined && value.default > value.maximum) ||
      (value.allowed !== undefined && !value.allowed.includes(value.default))
    ) {
      context.addIssue({
        code: "custom",
        path: ["default"],
        message: "default must be included in the declared control range",
      });
    }
  });
export const FixedFpsControlRangeV1Schema = z
  .object({
    default: z.literal(120),
    allowed: z.tuple([z.literal(60), z.literal(120)]),
  })
  .strict();

export const PhysicsTicksControlRangeV1Schema = z
  .object({
    default: z.literal(60),
    allowed: z.tuple([z.literal(60), z.literal(120)]),
  })
  .strict();

export const MaxTicksControlRangeV1Schema = z
  .object({
    default: z.literal(10),
    minimum: z.literal(1),
    maximum: z.literal(600),
  })
  .strict();

export const FixtureControlsV1Schema = z
  .object({
    fixedFps: FixedFpsControlRangeV1Schema,
    physicsTicksPerSecond: PhysicsTicksControlRangeV1Schema,
    maxTicks: MaxTicksControlRangeV1Schema,
  })
  .strict();

export interface FixtureManifestV1 {
  readonly schemaVersion: 1;
  readonly fixtureId: "frame-input-window";
  readonly engine: "godot";
  readonly projectFile: "project.godot";
  readonly startupScene: "res://frame_input_window.tscn";
  readonly protocolVersion: 2;
  readonly runtimeProfile: "chronorift-godot-protocol-v2";
  readonly inputActions: readonly ["attempt_jump"];
  readonly controls: {
    readonly fixedFps: FixtureControlRangeV1;
    readonly physicsTicksPerSecond: FixtureControlRangeV1;
    readonly maxTicks: FixtureControlRangeV1;
  };
  readonly ignoredCachePaths: readonly [".godot"];
}

export const FixtureManifestV1Schema: z.ZodType<FixtureManifestV1> = z
  .object({
    schemaVersion: z.literal(1),
    fixtureId: z.literal("frame-input-window"),
    engine: z.literal("godot"),
    projectFile: z.literal("project.godot"),
    startupScene: z.literal("res://frame_input_window.tscn"),
    protocolVersion: z.literal(2),
    runtimeProfile: z.literal("chronorift-godot-protocol-v2"),
    inputActions: z.tuple([z.literal("attempt_jump")]),
    controls: FixtureControlsV1Schema,
    ignoredCachePaths: z.tuple([z.literal(".godot")]),
  })
  .strict();

export interface TaskFixtureCapabilityV1 {
  readonly schemaVersion: 1;
  readonly fixtureId: "frame-input-window";
  readonly trustedManifestSha256: Sha256DigestV1;
  readonly baselineSelectedTreeSha256: Sha256DigestV1;
  readonly startupScene: "res://frame_input_window.tscn";
  readonly protocolVersion: 2;
  readonly runtimeProfile: "chronorift-godot-protocol-v2";
  readonly inputActions: readonly ["attempt_jump"];
  readonly controls: FixtureManifestV1["controls"];
  readonly ignoredCachePaths: readonly [".godot"];
  readonly capabilitySha256: Sha256DigestV1;
}

export type TaskFixtureCapabilityContentV1 = Omit<
  TaskFixtureCapabilityV1,
  "capabilitySha256"
>;

export const TaskFixtureCapabilityContentV1Schema: z.ZodType<TaskFixtureCapabilityContentV1> =
  z
    .object({
      schemaVersion: z.literal(1),
      fixtureId: z.literal("frame-input-window"),
      trustedManifestSha256: Sha256DigestV1Schema,
      baselineSelectedTreeSha256: Sha256DigestV1Schema,
      startupScene: z.literal("res://frame_input_window.tscn"),
      protocolVersion: z.literal(2),
      runtimeProfile: z.literal("chronorift-godot-protocol-v2"),
      inputActions: z.tuple([z.literal("attempt_jump")]),
      controls: FixtureControlsV1Schema,
      ignoredCachePaths: z.tuple([z.literal(".godot")]),
    })
    .strict();

export const TaskFixtureCapabilityV1Schema: z.ZodType<TaskFixtureCapabilityV1> =
  z
    .object({
      schemaVersion: z.literal(1),
      fixtureId: z.literal("frame-input-window"),
      trustedManifestSha256: Sha256DigestV1Schema,
      baselineSelectedTreeSha256: Sha256DigestV1Schema,
      startupScene: z.literal("res://frame_input_window.tscn"),
      protocolVersion: z.literal(2),
      runtimeProfile: z.literal("chronorift-godot-protocol-v2"),
      inputActions: z.tuple([z.literal("attempt_jump")]),
      controls: FixtureControlsV1Schema,
      ignoredCachePaths: z.tuple([z.literal(".godot")]),
      capabilitySha256: Sha256DigestV1Schema,
    })
    .strict()
    .superRefine((value, context) => {
      const { capabilitySha256, ...content } = value;
      if (capabilitySha256 !== contentHash(content)) {
        context.addIssue({
          code: "custom",
          path: ["capabilitySha256"],
          message:
            "capabilitySha256 must match the canonical capability content",
        });
      }
    });

export interface TaskGodotProjectCapabilityV1 {
  readonly schemaVersion: 1;
  readonly capabilityKind: "godot-external-lifecycle-v1";
  readonly descriptorSha256: Sha256DigestV1;
  readonly declaredSourceUrl: string;
  readonly sourceRevision: string;
  readonly baselineSelectedTreeSha256: Sha256DigestV1;
  readonly projectFile: "project.godot";
  readonly engineVersion: "4.7.1-stable (official)";
  readonly scripting: "gdscript";
  readonly renderer: "gl_compatibility";
  readonly executionMode: "headless";
  readonly startup: "project-main-scene";
  readonly runtimeProfile: "chronorift-godot-lifecycle-v1";
  readonly bridgeMode: "managed-runtime-overlay";
  readonly protocolVersion: 1;
  readonly ignoredCachePaths: readonly [".godot"];
  readonly reservedSourceRoots: readonly [
    ".chronorift",
    "addons",
    "override.cfg",
  ];
  readonly capabilitySha256: Sha256DigestV1;
}

export type TaskGodotProjectCapabilityContentV1 = Omit<
  TaskGodotProjectCapabilityV1,
  "capabilitySha256"
>;

export const TaskGodotProjectCapabilityContentV1Schema: z.ZodType<TaskGodotProjectCapabilityContentV1> =
  z
    .object({
      schemaVersion: z.literal(1),
      capabilityKind: z.literal("godot-external-lifecycle-v1"),
      descriptorSha256: Sha256DigestV1Schema,
      declaredSourceUrl: DeclaredSourceUrlV1Schema,
      sourceRevision: GitObjectIdV1Schema,
      baselineSelectedTreeSha256: Sha256DigestV1Schema,
      projectFile: z.literal("project.godot"),
      engineVersion: z.literal("4.7.1-stable (official)"),
      scripting: z.literal("gdscript"),
      renderer: z.literal("gl_compatibility"),
      executionMode: z.literal("headless"),
      startup: z.literal("project-main-scene"),
      runtimeProfile: z.literal("chronorift-godot-lifecycle-v1"),
      bridgeMode: z.literal("managed-runtime-overlay"),
      protocolVersion: z.literal(1),
      ignoredCachePaths: z.tuple([z.literal(".godot")]),
      reservedSourceRoots: z.tuple([
        z.literal(".chronorift"),
        z.literal("addons"),
        z.literal("override.cfg"),
      ]),
    })
    .strict();

export const TaskGodotProjectCapabilityV1Schema: z.ZodType<TaskGodotProjectCapabilityV1> =
  z
    .object({
      schemaVersion: z.literal(1),
      capabilityKind: z.literal("godot-external-lifecycle-v1"),
      descriptorSha256: Sha256DigestV1Schema,
      declaredSourceUrl: DeclaredSourceUrlV1Schema,
      sourceRevision: GitObjectIdV1Schema,
      baselineSelectedTreeSha256: Sha256DigestV1Schema,
      projectFile: z.literal("project.godot"),
      engineVersion: z.literal("4.7.1-stable (official)"),
      scripting: z.literal("gdscript"),
      renderer: z.literal("gl_compatibility"),
      executionMode: z.literal("headless"),
      startup: z.literal("project-main-scene"),
      runtimeProfile: z.literal("chronorift-godot-lifecycle-v1"),
      bridgeMode: z.literal("managed-runtime-overlay"),
      protocolVersion: z.literal(1),
      ignoredCachePaths: z.tuple([z.literal(".godot")]),
      reservedSourceRoots: z.tuple([
        z.literal(".chronorift"),
        z.literal("addons"),
        z.literal("override.cfg"),
      ]),
      capabilitySha256: Sha256DigestV1Schema,
    })
    .strict()
    .superRefine((value, context) => {
      const { capabilitySha256, ...content } = value;
      if (capabilitySha256 !== contentHash(content)) {
        context.addIssue({
          code: "custom",
          path: ["capabilitySha256"],
          message:
            "capabilitySha256 must match the canonical Godot project capability content",
        });
      }
    });

export interface WorkspaceMaterializationReceiptV1 {
  readonly schemaVersion: 1;
  readonly taskId: TaskId;
  readonly repositoryIdentity: Sha256DigestV1;
  readonly sourceRevision: string;
  readonly projectPrefix: string;
  readonly selectedTreeSha256: Sha256DigestV1;
  readonly agentBaselineCommit: string;
  readonly hostBaselineCommit: string;
  readonly copyRule: "git-object-plumbing-v1";
  readonly excludedCachePaths: readonly [".godot"];
  readonly fixtureCapabilitySha256: Sha256DigestV1;
}

export const WorkspaceMaterializationReceiptV1Schema: z.ZodType<WorkspaceMaterializationReceiptV1> =
  z
    .object({
      schemaVersion: z.literal(1),
      taskId: TaskIdSchema,
      repositoryIdentity: Sha256DigestV1Schema,
      sourceRevision: GitObjectIdV1Schema,
      projectPrefix: ProjectPrefixV1Schema,
      selectedTreeSha256: Sha256DigestV1Schema,
      agentBaselineCommit: GitObjectIdV1Schema,
      hostBaselineCommit: GitObjectIdV1Schema,
      copyRule: z.literal("git-object-plumbing-v1"),
      excludedCachePaths: z.tuple([z.literal(".godot")]),
      fixtureCapabilitySha256: Sha256DigestV1Schema,
    })
    .strict();

export interface WorkspaceMaterializationReceiptV2 {
  readonly schemaVersion: 2;
  readonly taskId: TaskId;
  readonly repositoryIdentity: Sha256DigestV1;
  readonly sourceRevision: string;
  readonly projectPrefix: "";
  readonly selectedTreeSha256: Sha256DigestV1;
  readonly agentBaselineCommit: string;
  readonly hostBaselineCommit: string;
  readonly copyRule: "git-object-plumbing-v1";
  readonly excludedCachePaths: readonly [".godot"];
  readonly sourceCapabilityKind: "godot-external-lifecycle-v1";
  readonly projectCapabilitySha256: Sha256DigestV1;
  readonly descriptorSha256: Sha256DigestV1;
  readonly sourcePostflight: {
    readonly observedHeadCommit: string;
    readonly observedSelectedTreeSha256: Sha256DigestV1;
    readonly statusPorcelainSha256: Sha256DigestV1;
    readonly stagingWorktreeRegistered: false;
  };
}

export const WorkspaceMaterializationReceiptV2Schema: z.ZodType<WorkspaceMaterializationReceiptV2> =
  z
    .object({
      schemaVersion: z.literal(2),
      taskId: TaskIdSchema,
      repositoryIdentity: Sha256DigestV1Schema,
      sourceRevision: GitObjectIdV1Schema,
      projectPrefix: z.literal(""),
      selectedTreeSha256: Sha256DigestV1Schema,
      agentBaselineCommit: GitObjectIdV1Schema,
      hostBaselineCommit: GitObjectIdV1Schema,
      copyRule: z.literal("git-object-plumbing-v1"),
      excludedCachePaths: z.tuple([z.literal(".godot")]),
      sourceCapabilityKind: z.literal("godot-external-lifecycle-v1"),
      projectCapabilitySha256: Sha256DigestV1Schema,
      descriptorSha256: Sha256DigestV1Schema,
      sourcePostflight: z
        .object({
          observedHeadCommit: GitObjectIdV1Schema,
          observedSelectedTreeSha256: Sha256DigestV1Schema,
          statusPorcelainSha256: Sha256DigestV1Schema,
          stagingWorktreeRegistered: z.literal(false),
        })
        .strict(),
    })
    .strict()
    .superRefine((value, context) => {
      if (value.sourcePostflight.observedHeadCommit !== value.sourceRevision) {
        context.addIssue({
          code: "custom",
          path: ["sourcePostflight", "observedHeadCommit"],
          message: "observedHeadCommit must match the frozen sourceRevision",
        });
      }
      if (
        value.sourcePostflight.observedSelectedTreeSha256 !==
        value.selectedTreeSha256
      ) {
        context.addIssue({
          code: "custom",
          path: ["sourcePostflight", "observedSelectedTreeSha256"],
          message:
            "observedSelectedTreeSha256 must match the frozen selected tree",
        });
      }
      if (
        value.sourcePostflight.statusPorcelainSha256 !==
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
      ) {
        context.addIssue({
          code: "custom",
          path: ["sourcePostflight", "statusPorcelainSha256"],
          message: "source postflight status must be empty",
        });
      }
    });

export type WorkspaceMaterializationReceipt =
  WorkspaceMaterializationReceiptV1 | WorkspaceMaterializationReceiptV2;

export const WorkspaceMaterializationReceiptSchema: z.ZodType<WorkspaceMaterializationReceipt> =
  z.union([
    WorkspaceMaterializationReceiptV1Schema,
    WorkspaceMaterializationReceiptV2Schema,
  ]);

export interface PatchExportReceiptV1 {
  readonly schemaVersion: 1;
  readonly taskId: TaskId;
  readonly patchId: PatchId;
  readonly patchSha256: Sha256DigestV1;
  readonly outputPath: string;
  readonly byteLength: number;
  readonly exportedAt: string;
  readonly status: "completed";
}

export const PatchExportReceiptV1Schema: z.ZodType<PatchExportReceiptV1> = z
  .object({
    schemaVersion: z.literal(1),
    taskId: TaskIdSchema,
    patchId: PatchIdSchema,
    patchSha256: Sha256DigestV1Schema,
    outputPath: RelativeExportPathV1Schema,
    byteLength: z.number().int().nonnegative(),
    exportedAt: IsoTimestampV1Schema,
    status: z.literal("completed"),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.patchId !== `patch:v1:${value.patchSha256}`) {
      context.addIssue({
        code: "custom",
        path: ["patchId"],
        message: "patchId must match patchSha256",
      });
    }
  });

export interface StreamCaptureReceiptV1 {
  readonly totalBytes: number;
  readonly capturedBytes: number;
  readonly sha256: Sha256DigestV1;
  readonly capturedSha256: Sha256DigestV1;
  readonly truncated: boolean;
}

export const StreamCaptureReceiptV1Schema: z.ZodType<StreamCaptureReceiptV1> = z
  .object({
    totalBytes: z.number().int().nonnegative(),
    capturedBytes: z.number().int().nonnegative(),
    sha256: Sha256DigestV1Schema,
    capturedSha256: Sha256DigestV1Schema,
    truncated: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.capturedBytes > value.totalBytes) {
      context.addIssue({
        code: "custom",
        path: ["capturedBytes"],
        message: "capturedBytes must not exceed totalBytes",
      });
    }
    if (value.truncated !== value.capturedBytes < value.totalBytes) {
      context.addIssue({
        code: "custom",
        path: ["truncated"],
        message: "truncated must exactly describe omitted stream bytes",
      });
    }
    if (!value.truncated && value.sha256 !== value.capturedSha256) {
      context.addIssue({
        code: "custom",
        path: ["capturedSha256"],
        message:
          "capturedSha256 must match sha256 when the complete stream was captured",
      });
    }
  });
