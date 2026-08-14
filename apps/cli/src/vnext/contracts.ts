import { z } from "zod";

import {
  PatchIdSchema,
  Sha256DigestV1Schema,
  TaskIdSchema,
  type JsonValue,
  type PatchId,
  type Sha256DigestV1,
  type TaskId,
} from "@chronorift/domain";
import { contentHash } from "@chronorift/json-artifacts";

import {
  M1_ERROR_CODES,
  sanitizeM1Diagnostic,
  type M1ErrorCode,
} from "./errors.js";
import { DeclaredSourceUrlV1Schema } from "./godot-project-descriptor.js";

const GitObjectIdV1Schema = z
  .string()
  .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);
const IsoTimestampV1Schema = z.string().datetime({ offset: true });
const NonemptyStringV1Schema = z.string().min(1);
export const SandboxOperationIdV1Schema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const SandboxArgumentV1Schema = z
  .string()
  .max(256 * 1024)
  .refine((value) => !value.includes("\0"), "argument must not contain NUL");
const SandboxEnvironmentKeyV1Schema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/u);
const SandboxEnvironmentValueV1Schema = z
  .string()
  .max(4096)
  .refine(
    (value) => !value.includes("\0"),
    "environment value must not contain NUL",
  );
const SanitizedM1DiagnosticV1Schema = z
  .string()
  .min(1)
  .refine(
    (value) =>
      Buffer.byteLength(value, "utf8") <= 4096 &&
      sanitizeM1Diagnostic(value, []) === value,
    "message must be a sanitized M1 diagnostic of at most 4096 UTF-8 bytes",
  );
const SafeToolVersionV1Schema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\x20-\x7e]+$/u, "version must be one printable ASCII line")
  .refine(
    (value) => !value.includes("/") && !value.includes("\\"),
    "version must not contain path separators",
  );

const isNormalizedRelativePosixPath = (value: string): boolean =>
  !value.startsWith("/") &&
  !value.includes("\\") &&
  !value.includes("\0") &&
  value
    .split("/")
    .every((segment) => segment !== "" && segment !== "." && segment !== "..");

const isNormalizedAbsolutePosixPath = (value: string): boolean =>
  value.startsWith("/") &&
  !value.includes("\\") &&
  !value.includes("\0") &&
  value
    .slice(1)
    .split("/")
    .every((segment) => segment !== "" && segment !== "." && segment !== "..");

export const SandboxToolchainTargetV1Schema = z
  .string()
  .min(2)
  .max(4096)
  .refine(
    isNormalizedAbsolutePosixPath,
    "toolchain target must be a normalized absolute POSIX path",
  )
  .refine(
    (value) =>
      !["/workspace", "/tmp", "/artifacts"].some(
        (root) => value === root || value.startsWith(`${root}/`),
      ),
    "toolchain target must not overlap a writable sandbox path",
  );

export interface SandboxToolchainFileV1 {
  readonly target: string;
  readonly sha256: Sha256DigestV1;
  readonly command: boolean;
}

export interface SandboxToolchainCapabilityV1 {
  readonly schemaVersion: 1;
  readonly toolchainId: string;
  readonly files: readonly SandboxToolchainFileV1[];
}

export const SandboxToolchainFileV1Schema: z.ZodType<SandboxToolchainFileV1> = z
  .object({
    target: SandboxToolchainTargetV1Schema,
    sha256: Sha256DigestV1Schema,
    command: z.boolean(),
  })
  .strict();

export const SandboxToolchainCapabilityV1Schema: z.ZodType<SandboxToolchainCapabilityV1> =
  z
    .object({
      schemaVersion: z.literal(1),
      toolchainId: z.string().regex(/^sandbox-toolchain:v1:[a-f0-9]{64}$/u),
      files: z.array(SandboxToolchainFileV1Schema).min(1).max(256),
    })
    .strict()
    .superRefine((value, context) => {
      const targets = value.files.map((file) => file.target);
      if (
        new Set(targets).size !== targets.length ||
        targets.some(
          (target, index) => index > 0 && target <= targets[index - 1]!,
        )
      ) {
        context.addIssue({
          code: "custom",
          path: ["files"],
          message: "toolchain files must have unique targets in lexical order",
        });
      }
      if (!value.files.some((file) => file.command)) {
        context.addIssue({
          code: "custom",
          path: ["files"],
          message: "toolchain must expose at least one command",
        });
      }
      const content = {
        schemaVersion: value.schemaVersion,
        files: value.files,
      };
      if (
        value.toolchainId !==
        `sandbox-toolchain:v1:${contentHash(content as unknown as JsonValue)}`
      ) {
        context.addIssue({
          code: "custom",
          path: ["toolchainId"],
          message: "toolchainId must match the canonical toolchain content",
        });
      }
    });

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

export type SandboxResourceProfileNameV1 = "coding-default" | "godot-headless";

export const SandboxResourceProfileNameV1Schema = z.enum([
  "coding-default",
  "godot-headless",
]);

export interface SandboxExecutionRequestV1 {
  readonly schemaVersion: 1;
  readonly operationId: string;
  readonly profile: SandboxResourceProfileNameV1;
  readonly argv: readonly [string, ...string[]];
  readonly cwd: "/workspace" | "/tmp" | "/artifacts";
  readonly environment: Readonly<Record<string, string>>;
  readonly stdin?:
    | {
        readonly byteLength: number;
        readonly sha256: Sha256DigestV1;
      }
    | undefined;
  readonly timeoutMs?: number | undefined;
}

export const SandboxStdinDescriptorV1Schema = z
  .object({
    byteLength: z
      .number()
      .int()
      .min(0)
      .max(16 * 1024 * 1024),
    sha256: Sha256DigestV1Schema,
  })
  .strict();

export const SandboxExecutionRequestV1Schema: z.ZodType<SandboxExecutionRequestV1> =
  z
    .object({
      schemaVersion: z.literal(1),
      operationId: SandboxOperationIdV1Schema,
      profile: SandboxResourceProfileNameV1Schema,
      argv: z.tuple([SandboxArgumentV1Schema.min(1)], SandboxArgumentV1Schema),
      cwd: z.enum(["/workspace", "/tmp", "/artifacts"]),
      environment: z.record(
        SandboxEnvironmentKeyV1Schema,
        SandboxEnvironmentValueV1Schema,
      ),
      stdin: SandboxStdinDescriptorV1Schema.optional(),
      timeoutMs: z.number().int().min(1).max(600_000).optional(),
    })
    .strict()
    .superRefine((value, context) => {
      for (const key of ["stdin", "timeoutMs"] as const) {
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
      const argumentBytes = value.argv.reduce(
        (total, argument) => total + Buffer.byteLength(argument, "utf8"),
        0,
      );
      if (value.argv.length > 1024 || argumentBytes > 1024 * 1024) {
        context.addIssue({
          code: "custom",
          path: ["argv"],
          message: "argv exceeds the bounded sandbox command profile",
        });
      }
    });

export interface RealizedResourceLimitsV1 {
  readonly cpuMax: "200000 100000";
  readonly memoryMaxBytes: 2_147_483_648;
  readonly memorySwapMaxBytes: 0;
  readonly pidsMax: 128;
  readonly nofile: 1024;
  readonly fileSizeMaxBytes: 536_870_912 | 1_073_741_824;
  readonly stdoutMaxBytes: 16_777_216;
  readonly stderrMaxBytes: 16_777_216;
  readonly timeoutMs: number;
}

export const RealizedResourceLimitsV1Schema: z.ZodType<RealizedResourceLimitsV1> =
  z
    .object({
      cpuMax: z.literal("200000 100000"),
      memoryMaxBytes: z.literal(2_147_483_648),
      memorySwapMaxBytes: z.literal(0),
      pidsMax: z.literal(128),
      nofile: z.literal(1024),
      fileSizeMaxBytes: z.union([
        z.literal(536_870_912),
        z.literal(1_073_741_824),
      ]),
      stdoutMaxBytes: z.literal(16_777_216),
      stderrMaxBytes: z.literal(16_777_216),
      timeoutMs: z.number().int().min(1).max(600_000),
    })
    .strict();

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

export interface SandboxTaskStorageCapabilityV1 {
  readonly kind: "dedicated-capacity-bounded-filesystem-v1";
  readonly filesystem: "tmpfs" | "ext4" | "xfs";
  readonly totalBytes: number;
  readonly totalInodes: number;
  readonly rootIdentitySha256: Sha256DigestV1;
}

export const SandboxTaskStorageCapabilityV1Schema: z.ZodType<SandboxTaskStorageCapabilityV1> =
  z
    .object({
      kind: z.literal("dedicated-capacity-bounded-filesystem-v1"),
      filesystem: z.enum(["tmpfs", "ext4", "xfs"]),
      totalBytes: z.number().int().positive().max(1_073_741_824),
      totalInodes: z.number().int().positive().max(131_072),
      rootIdentitySha256: Sha256DigestV1Schema,
    })
    .strict();

export interface SandboxHostCapabilityV1 {
  readonly schemaVersion: 1;
  readonly platform: "linux";
  readonly architecture: "x64";
  readonly bwrap: {
    readonly identity: Sha256DigestV1;
    readonly version: string;
    readonly features:
      | readonly ["block-fd", "json-status-fd", "bind-fd", "ro-bind-fd"]
      | readonly [
          "block-fd",
          "json-status-fd",
          "bind-fd",
          "ro-bind-fd",
          "remount-ro",
        ];
  };
  readonly prlimitIdentity: Sha256DigestV1;
  readonly runtimeIdentity: Sha256DigestV1;
  readonly delegatedCgroupRootIdentity: Sha256DigestV1;
  readonly controllers: readonly ["cpu", "memory", "pids"];
  readonly cgroupNamespaceUnshared: boolean;
  readonly activeProbeSha256: Sha256DigestV1;
  readonly taskStorage?: SandboxTaskStorageCapabilityV1 | undefined;
}

export const SandboxBwrapCapabilityV1Schema = z
  .object({
    identity: Sha256DigestV1Schema,
    version: SafeToolVersionV1Schema,
    features: z.union([
      z.tuple([
        z.literal("block-fd"),
        z.literal("json-status-fd"),
        z.literal("bind-fd"),
        z.literal("ro-bind-fd"),
      ]),
      z.tuple([
        z.literal("block-fd"),
        z.literal("json-status-fd"),
        z.literal("bind-fd"),
        z.literal("ro-bind-fd"),
        z.literal("remount-ro"),
      ]),
    ]),
  })
  .strict();

export const SandboxHostCapabilityV1Schema: z.ZodType<SandboxHostCapabilityV1> =
  z
    .object({
      schemaVersion: z.literal(1),
      platform: z.literal("linux"),
      architecture: z.literal("x64"),
      bwrap: SandboxBwrapCapabilityV1Schema,
      prlimitIdentity: Sha256DigestV1Schema,
      runtimeIdentity: Sha256DigestV1Schema,
      delegatedCgroupRootIdentity: Sha256DigestV1Schema,
      controllers: z.tuple([
        z.literal("cpu"),
        z.literal("memory"),
        z.literal("pids"),
      ]),
      cgroupNamespaceUnshared: z.boolean(),
      activeProbeSha256: Sha256DigestV1Schema,
      taskStorage: SandboxTaskStorageCapabilityV1Schema.optional(),
    })
    .strict();

export interface SandboxPolicyV1 {
  readonly schemaVersion: 1;
  readonly policyId: string;
  readonly runtimeIdentity: Sha256DigestV1;
  readonly toolchainId: string | null;
  readonly writableTargets: readonly ["/workspace", "/tmp", "/artifacts"];
  readonly readonlyTargets: readonly string[];
  readonly namespaces: readonly [
    "mount",
    "user",
    "pid",
    "ipc",
    "uts",
    "network",
  ];
  readonly network: "isolated";
  readonly copiedEnvironmentKeys: readonly ["CI", "NO_COLOR"];
  readonly profiles: Readonly<
    Record<SandboxResourceProfileNameV1, RealizedResourceLimitsV1>
  >;
}

export type SandboxPolicyContentV1 = Omit<SandboxPolicyV1, "policyId">;

const SandboxReadonlyTargetsV1Schema = z
  .array(SandboxToolchainTargetV1Schema)
  .min(1)
  .max(257)
  .refine(
    (targets) =>
      targets.includes("/bin/busybox") &&
      new Set(targets).size === targets.length &&
      targets.every(
        (target, index) => index === 0 || target > targets[index - 1]!,
      ),
    "readonly targets must include busybox and be unique in lexical order",
  );

export const SandboxPolicyProfilesV1Schema = z
  .object({
    "coding-default": RealizedResourceLimitsV1Schema,
    "godot-headless": RealizedResourceLimitsV1Schema,
  })
  .strict()
  .superRefine((profiles, context) => {
    if (
      profiles["coding-default"].fileSizeMaxBytes !== 536_870_912 ||
      profiles["coding-default"].timeoutMs !== 120_000
    ) {
      context.addIssue({
        code: "custom",
        path: ["coding-default"],
        message: "coding-default must use the frozen M1 profile",
      });
    }
    if (
      profiles["godot-headless"].fileSizeMaxBytes !== 1_073_741_824 ||
      profiles["godot-headless"].timeoutMs !== 180_000
    ) {
      context.addIssue({
        code: "custom",
        path: ["godot-headless"],
        message: "godot-headless must use the frozen M1 profile",
      });
    }
  });

export const SandboxPolicyContentV1Schema: z.ZodType<SandboxPolicyContentV1> = z
  .object({
    schemaVersion: z.literal(1),
    runtimeIdentity: Sha256DigestV1Schema,
    toolchainId: z
      .string()
      .regex(/^sandbox-toolchain:v1:[a-f0-9]{64}$/u)
      .nullable(),
    writableTargets: z.tuple([
      z.literal("/workspace"),
      z.literal("/tmp"),
      z.literal("/artifacts"),
    ]),
    readonlyTargets: SandboxReadonlyTargetsV1Schema,
    namespaces: z.tuple([
      z.literal("mount"),
      z.literal("user"),
      z.literal("pid"),
      z.literal("ipc"),
      z.literal("uts"),
      z.literal("network"),
    ]),
    network: z.literal("isolated"),
    copiedEnvironmentKeys: z.tuple([z.literal("CI"), z.literal("NO_COLOR")]),
    profiles: SandboxPolicyProfilesV1Schema,
  })
  .strict();

export const SandboxPolicyV1Schema: z.ZodType<SandboxPolicyV1> = z
  .object({
    schemaVersion: z.literal(1),
    policyId: z.string().regex(/^sandbox-policy:v1:[a-f0-9]{64}$/u),
    runtimeIdentity: Sha256DigestV1Schema,
    toolchainId: z
      .string()
      .regex(/^sandbox-toolchain:v1:[a-f0-9]{64}$/u)
      .nullable(),
    writableTargets: z.tuple([
      z.literal("/workspace"),
      z.literal("/tmp"),
      z.literal("/artifacts"),
    ]),
    readonlyTargets: SandboxReadonlyTargetsV1Schema,
    namespaces: z.tuple([
      z.literal("mount"),
      z.literal("user"),
      z.literal("pid"),
      z.literal("ipc"),
      z.literal("uts"),
      z.literal("network"),
    ]),
    network: z.literal("isolated"),
    copiedEnvironmentKeys: z.tuple([z.literal("CI"), z.literal("NO_COLOR")]),
    profiles: SandboxPolicyProfilesV1Schema,
  })
  .strict()
  .superRefine((value, context) => {
    const { policyId, ...content } = value;
    if (
      policyId !==
      `sandbox-policy:v1:${contentHash(content as unknown as JsonValue)}`
    ) {
      context.addIssue({
        code: "custom",
        path: ["policyId"],
        message: "policyId must match the canonical sandbox policy content",
      });
    }
  });

export interface SandboxPolicyProfileBindingV2 {
  readonly toolchainId: string;
  readonly managedRuntimeId: string | null;
  readonly workspaceAccess: "read-write" | "read-only";
  readonly readonlyTargets: readonly string[];
}

export interface SandboxPolicyV2 {
  readonly schemaVersion: 2;
  readonly policyId: string;
  readonly runtimeIdentity: Sha256DigestV1;
  readonly writableTargets: readonly ["/workspace", "/tmp", "/artifacts"];
  readonly namespaces: readonly [
    "mount",
    "user",
    "pid",
    "ipc",
    "uts",
    "network",
  ];
  readonly network: "isolated";
  readonly copiedEnvironmentKeys: readonly ["CI", "NO_COLOR"];
  readonly profiles: Readonly<
    Record<SandboxResourceProfileNameV1, RealizedResourceLimitsV1>
  >;
  readonly profileBindings: {
    readonly "coding-default": SandboxPolicyProfileBindingV2 & {
      readonly managedRuntimeId: null;
      readonly workspaceAccess: "read-write";
    };
    readonly "godot-headless": SandboxPolicyProfileBindingV2 & {
      readonly managedRuntimeId: string;
      readonly workspaceAccess: "read-only";
    };
  };
}

export type SandboxPolicyContentV2 = Omit<SandboxPolicyV2, "policyId">;
export type SandboxPolicy = SandboxPolicyV1 | SandboxPolicyV2;

const SandboxToolchainIdV1Schema = z
  .string()
  .regex(/^sandbox-toolchain:v1:[a-f0-9]{64}$/u);
const ManagedGodotRuntimeIdV1Schema = z
  .string()
  .regex(
    /^managed-godot(?:(?:-semantic)?-runtime:v1|-project-environment:v[12]):[a-f0-9]{64}$/u,
  );
export const SandboxPolicyIdSchema = z
  .string()
  .regex(/^sandbox-policy:v[12]:[a-f0-9]{64}$/u);

const SandboxPolicyProfileBindingV2Schema = z
  .object({
    toolchainId: SandboxToolchainIdV1Schema,
    managedRuntimeId: ManagedGodotRuntimeIdV1Schema.nullable(),
    workspaceAccess: z.enum(["read-write", "read-only"]),
    readonlyTargets: SandboxReadonlyTargetsV1Schema,
  })
  .strict();

const SandboxPolicyProfileBindingsV2Schema = z
  .object({
    "coding-default": SandboxPolicyProfileBindingV2Schema.extend({
      managedRuntimeId: z.null(),
      workspaceAccess: z.literal("read-write"),
    }).strict(),
    "godot-headless": SandboxPolicyProfileBindingV2Schema.extend({
      managedRuntimeId: ManagedGodotRuntimeIdV1Schema,
      workspaceAccess: z.literal("read-only"),
    }).strict(),
  })
  .strict();

export const SandboxPolicyContentV2Schema: z.ZodType<SandboxPolicyContentV2> = z
  .object({
    schemaVersion: z.literal(2),
    runtimeIdentity: Sha256DigestV1Schema,
    writableTargets: z.tuple([
      z.literal("/workspace"),
      z.literal("/tmp"),
      z.literal("/artifacts"),
    ]),
    namespaces: z.tuple([
      z.literal("mount"),
      z.literal("user"),
      z.literal("pid"),
      z.literal("ipc"),
      z.literal("uts"),
      z.literal("network"),
    ]),
    network: z.literal("isolated"),
    copiedEnvironmentKeys: z.tuple([z.literal("CI"), z.literal("NO_COLOR")]),
    profiles: SandboxPolicyProfilesV1Schema,
    profileBindings: SandboxPolicyProfileBindingsV2Schema,
  })
  .strict();

export const SandboxPolicyV2Schema: z.ZodType<SandboxPolicyV2> = z
  .object({
    schemaVersion: z.literal(2),
    policyId: z.string().regex(/^sandbox-policy:v2:[a-f0-9]{64}$/u),
    runtimeIdentity: Sha256DigestV1Schema,
    writableTargets: z.tuple([
      z.literal("/workspace"),
      z.literal("/tmp"),
      z.literal("/artifacts"),
    ]),
    namespaces: z.tuple([
      z.literal("mount"),
      z.literal("user"),
      z.literal("pid"),
      z.literal("ipc"),
      z.literal("uts"),
      z.literal("network"),
    ]),
    network: z.literal("isolated"),
    copiedEnvironmentKeys: z.tuple([z.literal("CI"), z.literal("NO_COLOR")]),
    profiles: SandboxPolicyProfilesV1Schema,
    profileBindings: SandboxPolicyProfileBindingsV2Schema,
  })
  .strict()
  .superRefine((value, context) => {
    const { policyId, ...content } = value;
    if (
      policyId !==
      `sandbox-policy:v2:${contentHash(content as unknown as JsonValue)}`
    ) {
      context.addIssue({
        code: "custom",
        path: ["policyId"],
        message: "policyId must match the canonical sandbox policy content",
      });
    }
  });

export const SandboxPolicySchema: z.ZodType<SandboxPolicy> = z.union([
  SandboxPolicyV1Schema,
  SandboxPolicyV2Schema,
]);

export interface SandboxPreflightBlockerV1 {
  readonly code: M1ErrorCode;
  readonly message: string;
}

export const SandboxPreflightBlockerV1Schema: z.ZodType<SandboxPreflightBlockerV1> =
  z
    .object({
      code: z.enum(M1_ERROR_CODES),
      message: NonemptyStringV1Schema,
    })
    .strict();

export type SandboxPreflightReceiptV1 =
  | {
      readonly schemaVersion: 1;
      readonly status: "supported";
      readonly checkedAt: string;
      readonly capabilitySha256: Sha256DigestV1;
      readonly blockers: readonly [];
    }
  | {
      readonly schemaVersion: 1;
      readonly status: "unsupported";
      readonly checkedAt: string;
      readonly capabilitySha256: null;
      readonly blockers: readonly [
        SandboxPreflightBlockerV1,
        ...SandboxPreflightBlockerV1[],
      ];
    };

export const SupportedSandboxPreflightReceiptV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    status: z.literal("supported"),
    checkedAt: IsoTimestampV1Schema,
    capabilitySha256: Sha256DigestV1Schema,
    blockers: z.tuple([]),
  })
  .strict();

export const UnsupportedSandboxPreflightReceiptV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    status: z.literal("unsupported"),
    checkedAt: IsoTimestampV1Schema,
    capabilitySha256: z.null(),
    blockers: z.tuple(
      [SandboxPreflightBlockerV1Schema],
      SandboxPreflightBlockerV1Schema,
    ),
  })
  .strict();

export const SandboxPreflightReceiptV1Schema: z.ZodType<SandboxPreflightReceiptV1> =
  z.discriminatedUnion("status", [
    SupportedSandboxPreflightReceiptV1Schema,
    UnsupportedSandboxPreflightReceiptV1Schema,
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

export interface SecurityEventV1 {
  readonly schemaVersion: 1;
  readonly eventId: string;
  readonly taskId: TaskId;
  readonly operationId: string;
  readonly decision: "denied";
  readonly code: "path_denied" | "capability_denied";
  readonly message: string;
  readonly occurredAt: string;
  readonly target: string;
  readonly sideEffectStarted: false;
}

export const SecurityEventV1Schema: z.ZodType<SecurityEventV1> = z
  .object({
    schemaVersion: z.literal(1),
    eventId: SandboxOperationIdV1Schema,
    taskId: TaskIdSchema,
    operationId: SandboxOperationIdV1Schema,
    decision: z.literal("denied"),
    code: z.enum(["path_denied", "capability_denied"]),
    message: SanitizedM1DiagnosticV1Schema,
    occurredAt: IsoTimestampV1Schema,
    target: SanitizedM1DiagnosticV1Schema,
    sideEffectStarted: z.literal(false),
  })
  .strict();

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

export interface RealizedResourceMechanismsV1 {
  readonly cpu: "cgroup-v2";
  readonly memory: "cgroup-v2";
  readonly processCount: "cgroup-v2";
  readonly openFiles: "rlimit-nofile";
  readonly fileSize: "rlimit-fsize";
  readonly wallTimeout: "host-monotonic-timer";
  readonly aggregateStorage?:
    "dedicated-capacity-bounded-filesystem-v1" | undefined;
  readonly unavailable: readonly [] | readonly ["aggregate-storage"];
}

export const RealizedResourceMechanismsV1Schema: z.ZodType<RealizedResourceMechanismsV1> =
  z
    .object({
      cpu: z.literal("cgroup-v2"),
      memory: z.literal("cgroup-v2"),
      processCount: z.literal("cgroup-v2"),
      openFiles: z.literal("rlimit-nofile"),
      fileSize: z.literal("rlimit-fsize"),
      wallTimeout: z.literal("host-monotonic-timer"),
      aggregateStorage: z
        .literal("dedicated-capacity-bounded-filesystem-v1")
        .optional(),
      unavailable: z.union([
        z.tuple([]),
        z.tuple([z.literal("aggregate-storage")]),
      ]),
    })
    .strict()
    .superRefine((value, context) => {
      if (
        value.aggregateStorage !== undefined &&
        value.unavailable.length > 0
      ) {
        context.addIssue({
          code: "custom",
          path: ["unavailable"],
          message: "aggregate storage cannot be both realized and unavailable",
        });
      }
    });

export interface AggregateStorageUsageV1 {
  readonly usedBytes: number;
  readonly usedInodes: number;
}

export const AggregateStorageUsageV1Schema: z.ZodType<AggregateStorageUsageV1> =
  z
    .object({
      usedBytes: z.number().int().nonnegative().max(1_073_741_824),
      usedInodes: z.number().int().nonnegative().max(131_072),
    })
    .strict();

export interface ObservedResourceUsageV1 {
  readonly cpuUsageUsec: number;
  readonly memoryPeakBytes: number | null;
  readonly pidsPeak: number | null;
  readonly aggregateStorage?: AggregateStorageUsageV1 | undefined;
}

export const ObservedResourceUsageV1Schema: z.ZodType<ObservedResourceUsageV1> =
  z
    .object({
      cpuUsageUsec: z.number().int().nonnegative(),
      memoryPeakBytes: z.number().int().nonnegative().nullable(),
      pidsPeak: z.number().int().nonnegative().nullable(),
      aggregateStorage: AggregateStorageUsageV1Schema.optional(),
    })
    .strict();

export interface SandboxCleanupReceiptV1 {
  readonly processGroupTerminated: boolean;
  readonly cgroupPopulated: boolean;
  readonly termSent: boolean;
  readonly killSent: boolean;
  readonly scopeRemoved: boolean;
  /**
   * Present only when bounded Task-storage inspection was available during
   * this cleanup attempt. `true` means that inspection completed; omission or
   * `false` must not be upgraded to a storage cleanup fact by consumers.
   */
  readonly storageReconciled?: boolean | undefined;
}

export const SandboxCleanupReceiptV1Schema: z.ZodType<SandboxCleanupReceiptV1> =
  z
    .object({
      processGroupTerminated: z.boolean(),
      cgroupPopulated: z.boolean(),
      termSent: z.boolean(),
      killSent: z.boolean(),
      scopeRemoved: z.boolean(),
      storageReconciled: z.boolean().optional(),
    })
    .strict()
    .superRefine((value, context) => {
      if (
        value.cgroupPopulated &&
        (value.processGroupTerminated || value.scopeRemoved)
      ) {
        context.addIssue({
          code: "custom",
          path: ["cgroupPopulated"],
          message:
            "a populated cgroup cannot have a terminated process group or removed scope",
        });
      }
      if (value.scopeRemoved && !value.processGroupTerminated) {
        context.addIssue({
          code: "custom",
          path: ["scopeRemoved"],
          message: "a removed scope requires proven process-group termination",
        });
      }
    });

export interface SandboxMountAdmissionReceiptV1 {
  readonly schemaVersion: 1;
  readonly evidenceBasis: "validated-process-plan";
  readonly profile: SandboxResourceProfileNameV1;
  readonly workspaceAccess: "read-write" | "read-only";
  readonly taskSharedWritableTargets: readonly ["/tmp", "/artifacts"];
  readonly operationPrivateWritableTargets:
    readonly [] | readonly ["/run/chronorift"];
  readonly readonlyTargetCount: number;
  readonly readonlyTargetsSha256: Sha256DigestV1;
  readonly mountCount: number;
  readonly mountPlanSha256: Sha256DigestV1;
  readonly credentialTargetCount: 0;
}

export const SandboxMountAdmissionReceiptV1Schema: z.ZodType<SandboxMountAdmissionReceiptV1> =
  z
    .object({
      schemaVersion: z.literal(1),
      evidenceBasis: z.literal("validated-process-plan"),
      profile: SandboxResourceProfileNameV1Schema,
      workspaceAccess: z.enum(["read-write", "read-only"]),
      taskSharedWritableTargets: z.tuple([
        z.literal("/tmp"),
        z.literal("/artifacts"),
      ]),
      operationPrivateWritableTargets: z.union([
        z.tuple([]),
        z.tuple([z.literal("/run/chronorift")]),
      ]),
      readonlyTargetCount: z.number().int().min(1).max(258),
      readonlyTargetsSha256: Sha256DigestV1Schema,
      mountCount: z.number().int().min(4).max(261),
      mountPlanSha256: Sha256DigestV1Schema,
      credentialTargetCount: z.literal(0),
    })
    .strict()
    .superRefine((value, context) => {
      const godotProfile = value.profile === "godot-headless";
      if (
        (godotProfile && value.workspaceAccess !== "read-only") ||
        (!godotProfile && value.workspaceAccess !== "read-write")
      ) {
        context.addIssue({
          code: "custom",
          path: ["workspaceAccess"],
          message: "workspace access must match the admitted sandbox profile",
        });
      }
      if (
        (godotProfile && value.operationPrivateWritableTargets.length !== 1) ||
        (!godotProfile && value.operationPrivateWritableTargets.length !== 0)
      ) {
        context.addIssue({
          code: "custom",
          path: ["operationPrivateWritableTargets"],
          message:
            "operation-private writable targets must match the admitted sandbox profile",
        });
      }
      const workspaceReadonlyCount =
        value.workspaceAccess === "read-only" ? 1 : 0;
      const expectedMountCount =
        3 +
        value.operationPrivateWritableTargets.length +
        value.readonlyTargetCount -
        workspaceReadonlyCount;
      if (value.mountCount !== expectedMountCount) {
        context.addIssue({
          code: "custom",
          path: ["mountCount"],
          message:
            "mountCount must account for every admitted fixed and read-only target",
        });
      }
    });

export interface SandboxExecutionReceiptV1 {
  readonly schemaVersion: 1;
  readonly taskId: TaskId;
  readonly operationId: string;
  readonly policyId: string;
  readonly sandboxCapabilitySha256: Sha256DigestV1;
  readonly sandboxBackend: "bwrap-direct-cgroup-v2";
  readonly status:
    "succeeded" | "failed" | "timed_out" | "cancelled" | "launch_failed";
  readonly requested: SandboxExecutionRequestV1;
  readonly realizedResources: RealizedResourceLimitsV1;
  readonly realizedMechanisms: RealizedResourceMechanismsV1;
  readonly resourceUsage: ObservedResourceUsageV1;
  readonly stdout: StreamCaptureReceiptV1;
  readonly stderr: StreamCaptureReceiptV1;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly startedAtMonotonicMs: number;
  readonly endedAtMonotonicMs: number;
  readonly cleanup: SandboxCleanupReceiptV1;
  /** Added after M1; absent on historical receipts and pre-plan launch failures. */
  readonly mountAdmission?: SandboxMountAdmissionReceiptV1 | undefined;
}

export const SandboxExecutionReceiptV1Schema: z.ZodType<SandboxExecutionReceiptV1> =
  z
    .object({
      schemaVersion: z.literal(1),
      taskId: TaskIdSchema,
      operationId: SandboxOperationIdV1Schema,
      policyId: SandboxPolicyIdSchema,
      sandboxCapabilitySha256: Sha256DigestV1Schema,
      sandboxBackend: z.literal("bwrap-direct-cgroup-v2"),
      status: z.enum([
        "succeeded",
        "failed",
        "timed_out",
        "cancelled",
        "launch_failed",
      ]),
      requested: SandboxExecutionRequestV1Schema,
      realizedResources: RealizedResourceLimitsV1Schema,
      realizedMechanisms: RealizedResourceMechanismsV1Schema,
      resourceUsage: ObservedResourceUsageV1Schema,
      stdout: StreamCaptureReceiptV1Schema,
      stderr: StreamCaptureReceiptV1Schema,
      exitCode: z.number().int().nullable(),
      signal: z.string().min(1).nullable(),
      startedAtMonotonicMs: z.number().finite().nonnegative(),
      endedAtMonotonicMs: z.number().finite().nonnegative(),
      cleanup: SandboxCleanupReceiptV1Schema,
      mountAdmission: SandboxMountAdmissionReceiptV1Schema.optional(),
    })
    .strict()
    .superRefine((value, context) => {
      const aggregateStorageRealized =
        value.realizedMechanisms.aggregateStorage !== undefined;
      const aggregateStorageObserved =
        value.resourceUsage.aggregateStorage !== undefined;
      if (aggregateStorageRealized !== aggregateStorageObserved) {
        context.addIssue({
          code: "custom",
          path: ["resourceUsage", "aggregateStorage"],
          message:
            "aggregate storage usage must accompany its realized mechanism",
        });
      }
      if (value.startedAtMonotonicMs > value.endedAtMonotonicMs) {
        context.addIssue({
          code: "custom",
          path: ["startedAtMonotonicMs"],
          message: "startedAtMonotonicMs must not exceed endedAtMonotonicMs",
        });
      }
      if (
        value.mountAdmission !== undefined &&
        value.mountAdmission.profile !== value.requested.profile
      ) {
        context.addIssue({
          code: "custom",
          path: ["mountAdmission", "profile"],
          message: "mount admission profile must match the requested profile",
        });
      }
      const cleanExit = value.exitCode === 0 && value.signal === null;
      const failedExit =
        (value.exitCode !== null &&
          value.exitCode !== 0 &&
          value.signal === null) ||
        (value.exitCode === null && value.signal !== null);
      if (
        (value.status === "succeeded" && !cleanExit) ||
        (value.status === "failed" && !failedExit) ||
        ((value.status === "timed_out" ||
          value.status === "cancelled" ||
          value.status === "launch_failed") &&
          (value.exitCode !== null || value.signal !== null))
      ) {
        context.addIssue({
          code: "custom",
          path: ["status"],
          message: "execution status must match its exit code and signal",
        });
      }
    });

export type M1TaskEventV1 =
  | {
      readonly schemaVersion: 1;
      readonly taskId: TaskId;
      readonly kind: "creating";
      readonly occurredAt: string;
    }
  | {
      readonly schemaVersion: 1;
      readonly taskId: TaskId;
      readonly kind: "ready";
      readonly occurredAt: string;
      readonly policyId: string;
      readonly baselineSourceHash: Sha256DigestV1;
    }
  | {
      readonly schemaVersion: 1;
      readonly taskId: TaskId;
      readonly kind: "setup_failed" | "resume_failed";
      readonly occurredAt: string;
      readonly code: M1ErrorCode;
      readonly message: string;
    }
  | {
      readonly schemaVersion: 1;
      readonly taskId: TaskId;
      readonly kind: "suspended" | "resumed";
      readonly occurredAt: string;
      readonly policyId: string;
    };

const CreatingM1TaskEventV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    taskId: TaskIdSchema,
    kind: z.literal("creating"),
    occurredAt: IsoTimestampV1Schema,
  })
  .strict();

const ReadyM1TaskEventV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    taskId: TaskIdSchema,
    kind: z.literal("ready"),
    occurredAt: IsoTimestampV1Schema,
    policyId: SandboxPolicyIdSchema,
    baselineSourceHash: Sha256DigestV1Schema,
  })
  .strict();

const SetupFailedM1TaskEventV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    taskId: TaskIdSchema,
    kind: z.enum(["setup_failed", "resume_failed"]),
    occurredAt: IsoTimestampV1Schema,
    code: z.enum(M1_ERROR_CODES),
    message: SanitizedM1DiagnosticV1Schema,
  })
  .strict();

const LifecycleM1TaskEventV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    taskId: TaskIdSchema,
    kind: z.enum(["suspended", "resumed"]),
    occurredAt: IsoTimestampV1Schema,
    policyId: SandboxPolicyIdSchema,
  })
  .strict();

export const M1TaskEventV1Schema: z.ZodType<M1TaskEventV1> =
  z.discriminatedUnion("kind", [
    CreatingM1TaskEventV1Schema,
    ReadyM1TaskEventV1Schema,
    SetupFailedM1TaskEventV1Schema,
    LifecycleM1TaskEventV1Schema,
  ]);

export interface SandboxOperationRecordV1 {
  readonly schemaVersion: 1;
  readonly taskId: TaskId;
  readonly recordedAt: string;
  readonly receipt: SandboxExecutionReceiptV1;
}

export const SandboxOperationRecordV1Schema: z.ZodType<SandboxOperationRecordV1> =
  z
    .object({
      schemaVersion: z.literal(1),
      taskId: TaskIdSchema,
      recordedAt: IsoTimestampV1Schema,
      receipt: SandboxExecutionReceiptV1Schema,
    })
    .strict()
    .superRefine((value, context) => {
      if (value.taskId !== value.receipt.taskId) {
        context.addIssue({
          code: "custom",
          path: ["taskId"],
          message: "taskId must match the sandbox receipt Task",
        });
      }
    });

export type PatchExportEventV1 =
  | {
      readonly schemaVersion: 1;
      readonly taskId: TaskId;
      readonly kind: "requested";
      readonly patchId: PatchId;
      readonly patchSha256: Sha256DigestV1;
      readonly outputPath: string;
      readonly occurredAt: string;
    }
  | {
      readonly schemaVersion: 1;
      readonly taskId: TaskId;
      readonly kind: "completed";
      readonly receipt: PatchExportReceiptV1;
      readonly occurredAt: string;
    }
  | {
      readonly schemaVersion: 1;
      readonly taskId: TaskId;
      readonly kind: "failed";
      readonly patchId: PatchId;
      readonly patchSha256: Sha256DigestV1;
      readonly outputPath: string;
      readonly occurredAt: string;
      readonly code: "patch_export_failed" | "artifact_write_failed";
      readonly message: string;
      readonly targetPublished: boolean;
    };

const RequestedPatchExportEventV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    taskId: TaskIdSchema,
    kind: z.literal("requested"),
    patchId: PatchIdSchema,
    patchSha256: Sha256DigestV1Schema,
    outputPath: RelativeExportPathV1Schema,
    occurredAt: IsoTimestampV1Schema,
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

const CompletedPatchExportEventV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    taskId: TaskIdSchema,
    kind: z.literal("completed"),
    receipt: PatchExportReceiptV1Schema,
    occurredAt: IsoTimestampV1Schema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.taskId !== value.receipt.taskId) {
      context.addIssue({
        code: "custom",
        path: ["taskId"],
        message: "taskId must match the export receipt Task",
      });
    }
  });

const FailedPatchExportEventV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    taskId: TaskIdSchema,
    kind: z.literal("failed"),
    patchId: PatchIdSchema,
    patchSha256: Sha256DigestV1Schema,
    outputPath: RelativeExportPathV1Schema,
    occurredAt: IsoTimestampV1Schema,
    code: z.enum(["patch_export_failed", "artifact_write_failed"]),
    message: SanitizedM1DiagnosticV1Schema,
    targetPublished: z.boolean(),
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

export const PatchExportEventV1Schema: z.ZodType<PatchExportEventV1> =
  z.discriminatedUnion("kind", [
    RequestedPatchExportEventV1Schema,
    CompletedPatchExportEventV1Schema,
    FailedPatchExportEventV1Schema,
  ]);
