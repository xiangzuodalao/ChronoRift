import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, realpath, readdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import {
  JsonValueSchema,
  Sha256DigestV1Schema,
  asSha256DigestV1,
  type Sha256DigestV1,
} from "@chronorift/domain";
import { canonicalJson } from "@chronorift/json-artifacts";
import { z } from "zod";

import {
  ProjectEnvironmentHostConfigV1Schema,
  type ProjectEnvironmentHostConfigV1,
} from "./project-environment-host-config.js";
import { publishPrivateFileOnceV1 } from "./private-atomic-publication.js";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MAX_OPERATIONAL_FILE_BYTES = 256 * 1024;
const REQUIRED_CONTROLLERS = Object.freeze(["cpu", "memory", "pids"] as const);

export const M7_R3_DELEGATED_CGROUP_PARENT_V1 =
  "/sys/fs/cgroup/driver/chronorift-vnext-godot" as const;

export const M7_R3_OPERATIONAL_CGROUP_PURPOSES_V1 = Object.freeze([
  Object.freeze({
    purpose: "case-01-runtime" as const,
    delegatedCgroupRoot:
      "/sys/fs/cgroup/driver/chronorift-vnext-godot/case-01/runtime" as const,
    configFileName: "case-01-runtime.host-config.v1.json" as const,
  }),
  Object.freeze({
    purpose: "case-01-code-only" as const,
    delegatedCgroupRoot:
      "/sys/fs/cgroup/driver/chronorift-vnext-godot/case-01/code-only" as const,
    configFileName: "case-01-code-only.host-config.v1.json" as const,
  }),
  Object.freeze({
    purpose: "case-02-runtime" as const,
    delegatedCgroupRoot:
      "/sys/fs/cgroup/driver/chronorift-vnext-godot/case-02/runtime" as const,
    configFileName: "case-02-runtime.host-config.v1.json" as const,
  }),
  Object.freeze({
    purpose: "case-02-code-only" as const,
    delegatedCgroupRoot:
      "/sys/fs/cgroup/driver/chronorift-vnext-godot/case-02/code-only" as const,
    configFileName: "case-02-code-only.host-config.v1.json" as const,
  }),
  Object.freeze({
    purpose: "case-01-no-agent-preflight" as const,
    delegatedCgroupRoot:
      "/sys/fs/cgroup/driver/chronorift-vnext-godot/preflight/case-01" as const,
    configFileName: "case-01-no-agent-preflight.host-config.v1.json" as const,
  }),
  Object.freeze({
    purpose: "case-02-no-agent-preflight" as const,
    delegatedCgroupRoot:
      "/sys/fs/cgroup/driver/chronorift-vnext-godot/preflight/case-02" as const,
    configFileName: "case-02-no-agent-preflight.host-config.v1.json" as const,
  }),
] as const);

const M7_R3_OPERATIONAL_CGROUP_GROUPS_V1 = Object.freeze([
  Object.freeze({
    path: `${M7_R3_DELEGATED_CGROUP_PARENT_V1}/case-01`,
    childNames: Object.freeze(["code-only", "runtime"] as const),
  }),
  Object.freeze({
    path: `${M7_R3_DELEGATED_CGROUP_PARENT_V1}/case-02`,
    childNames: Object.freeze(["code-only", "runtime"] as const),
  }),
  Object.freeze({
    path: `${M7_R3_DELEGATED_CGROUP_PARENT_V1}/preflight`,
    childNames: Object.freeze(["case-01", "case-02"] as const),
  }),
] as const);

const AbsolutePathSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine(
    (value) =>
      !value.includes("\0") && isAbsolute(value) && resolve(value) === value,
    "path must be normalized and absolute",
  );

const purposeSchema = z.enum([
  "case-01-runtime",
  "case-01-code-only",
  "case-02-runtime",
  "case-02-code-only",
  "case-01-no-agent-preflight",
  "case-02-no-agent-preflight",
]);

const sourceKindSchema = z.enum([
  "container-entrypoint",
  "run-wrapper",
  "static-admission",
  "run-control",
  "live-test-config",
  "live-composer",
  "operational-config-composer",
]);

const orchestrationSourceSchema = z
  .object({
    sourceKind: sourceKindSchema,
    sourcePath: AbsolutePathSchema,
    sourceFileSha256: Sha256DigestV1Schema,
  })
  .strict();

const operationalConfigIdentitySchema = z
  .object({
    purpose: purposeSchema,
    configPath: AbsolutePathSchema,
    delegatedCgroupRoot: AbsolutePathSchema,
    configFileSha256: Sha256DigestV1Schema,
  })
  .strict();

const exactConfigIdentitySchemas = M7_R3_OPERATIONAL_CGROUP_PURPOSES_V1.map(
  (purpose) =>
    operationalConfigIdentitySchema.extend({
      purpose: z.literal(purpose.purpose),
      delegatedCgroupRoot: z.literal(purpose.delegatedCgroupRoot),
    }),
) as unknown as readonly [
  z.ZodType<z.infer<typeof operationalConfigIdentitySchema>>,
  z.ZodType<z.infer<typeof operationalConfigIdentitySchema>>,
  z.ZodType<z.infer<typeof operationalConfigIdentitySchema>>,
  z.ZodType<z.infer<typeof operationalConfigIdentitySchema>>,
  z.ZodType<z.infer<typeof operationalConfigIdentitySchema>>,
  z.ZodType<z.infer<typeof operationalConfigIdentitySchema>>,
];

const exactConfigIdentitiesSchema = z.tuple(exactConfigIdentitySchemas);

const exactOrchestrationSourcesSchema = z.tuple([
  orchestrationSourceSchema.extend({
    sourceKind: z.literal("container-entrypoint"),
  }),
  orchestrationSourceSchema.extend({ sourceKind: z.literal("run-wrapper") }),
  orchestrationSourceSchema.extend({
    sourceKind: z.literal("static-admission"),
  }),
  orchestrationSourceSchema.extend({ sourceKind: z.literal("run-control") }),
  orchestrationSourceSchema.extend({
    sourceKind: z.literal("live-test-config"),
  }),
  orchestrationSourceSchema.extend({ sourceKind: z.literal("live-composer") }),
  orchestrationSourceSchema.extend({
    sourceKind: z.literal("operational-config-composer"),
  }),
]);

const priorPreAgentDiagnosticSchema = z
  .object({
    ordinal: z.union([
      z.literal(1),
      z.literal(2),
      z.literal(3),
      z.literal(4),
      z.literal(5),
    ]),
    code: z.enum([
      "freezer_identity_domain_mismatch",
      "admission_nested_bind_mount_empty_check",
      "dry_task_storage_capacity_bound",
      "dry_shared_delegated_cgroup_root",
      "admission_operational_root_type",
    ]),
    stage: z.enum(["manifest_freeze", "static_admission", "pre_agent_dry_run"]),
    outcome: z.enum(["failed_before_output", "failed_before_agent"]),
    manifestOutputsCreatedByAttempt: z.literal(false),
    disposableCleanupProven: z.boolean().nullable(),
    formalRunControlCreated: z.literal(false),
    agentLaunchCount: z.literal(0),
    piSessionCount: z.literal(0),
    providerInvocationCount: z.literal(0),
    godotInvocation: z.enum(["none", "compatibility_only"]),
    publicBehaviorPreflightInvoked: z.literal(false),
    hiddenEvaluatorInvoked: z.literal(false),
    constructionOrPortfolioPersisted: z.literal(false),
  })
  .strict();

const priorPreAgentDiagnosticsSchema = z.tuple([
  priorPreAgentDiagnosticSchema.extend({
    ordinal: z.literal(1),
    code: z.literal("freezer_identity_domain_mismatch"),
    stage: z.literal("manifest_freeze"),
    outcome: z.literal("failed_before_output"),
    disposableCleanupProven: z.null(),
    godotInvocation: z.literal("none"),
  }),
  priorPreAgentDiagnosticSchema.extend({
    ordinal: z.literal(2),
    code: z.literal("admission_nested_bind_mount_empty_check"),
    stage: z.literal("static_admission"),
    outcome: z.literal("failed_before_agent"),
    disposableCleanupProven: z.literal(true),
    godotInvocation: z.literal("none"),
  }),
  priorPreAgentDiagnosticSchema.extend({
    ordinal: z.literal(3),
    code: z.literal("dry_task_storage_capacity_bound"),
    stage: z.literal("pre_agent_dry_run"),
    outcome: z.literal("failed_before_agent"),
    disposableCleanupProven: z.literal(true),
    godotInvocation: z.literal("none"),
  }),
  priorPreAgentDiagnosticSchema.extend({
    ordinal: z.literal(4),
    code: z.literal("dry_shared_delegated_cgroup_root"),
    stage: z.literal("pre_agent_dry_run"),
    outcome: z.literal("failed_before_agent"),
    disposableCleanupProven: z.literal(true),
    godotInvocation: z.literal("compatibility_only"),
  }),
  priorPreAgentDiagnosticSchema.extend({
    ordinal: z.literal(5),
    code: z.literal("admission_operational_root_type"),
    stage: z.literal("static_admission"),
    outcome: z.literal("failed_before_agent"),
    disposableCleanupProven: z.literal(true),
    godotInvocation: z.literal("none"),
  }),
]);

export const M7_R3_PRIOR_PRE_AGENT_DIAGNOSTICS_V1 =
  priorPreAgentDiagnosticsSchema.parse([
    {
      ordinal: 1,
      code: "freezer_identity_domain_mismatch",
      stage: "manifest_freeze",
      outcome: "failed_before_output",
      manifestOutputsCreatedByAttempt: false,
      disposableCleanupProven: null,
      formalRunControlCreated: false,
      agentLaunchCount: 0,
      piSessionCount: 0,
      providerInvocationCount: 0,
      godotInvocation: "none",
      publicBehaviorPreflightInvoked: false,
      hiddenEvaluatorInvoked: false,
      constructionOrPortfolioPersisted: false,
    },
    {
      ordinal: 2,
      code: "admission_nested_bind_mount_empty_check",
      stage: "static_admission",
      outcome: "failed_before_agent",
      manifestOutputsCreatedByAttempt: false,
      disposableCleanupProven: true,
      formalRunControlCreated: false,
      agentLaunchCount: 0,
      piSessionCount: 0,
      providerInvocationCount: 0,
      godotInvocation: "none",
      publicBehaviorPreflightInvoked: false,
      hiddenEvaluatorInvoked: false,
      constructionOrPortfolioPersisted: false,
    },
    {
      ordinal: 3,
      code: "dry_task_storage_capacity_bound",
      stage: "pre_agent_dry_run",
      outcome: "failed_before_agent",
      manifestOutputsCreatedByAttempt: false,
      disposableCleanupProven: true,
      formalRunControlCreated: false,
      agentLaunchCount: 0,
      piSessionCount: 0,
      providerInvocationCount: 0,
      godotInvocation: "none",
      publicBehaviorPreflightInvoked: false,
      hiddenEvaluatorInvoked: false,
      constructionOrPortfolioPersisted: false,
    },
    {
      ordinal: 4,
      code: "dry_shared_delegated_cgroup_root",
      stage: "pre_agent_dry_run",
      outcome: "failed_before_agent",
      manifestOutputsCreatedByAttempt: false,
      disposableCleanupProven: true,
      formalRunControlCreated: false,
      agentLaunchCount: 0,
      piSessionCount: 0,
      providerInvocationCount: 0,
      godotInvocation: "compatibility_only",
      publicBehaviorPreflightInvoked: false,
      hiddenEvaluatorInvoked: false,
      constructionOrPortfolioPersisted: false,
    },
    {
      ordinal: 5,
      code: "admission_operational_root_type",
      stage: "static_admission",
      outcome: "failed_before_agent",
      manifestOutputsCreatedByAttempt: false,
      disposableCleanupProven: true,
      formalRunControlCreated: false,
      agentLaunchCount: 0,
      piSessionCount: 0,
      providerInvocationCount: 0,
      godotInvocation: "none",
      publicBehaviorPreflightInvoked: false,
      hiddenEvaluatorInvoked: false,
      constructionOrPortfolioPersisted: false,
    },
  ]);

const operationalManifestBasisSchema = z
  .object({
    schemaVersion: z.literal(1),
    recordKind: z.literal("m7-r3-operational-cgroup-partition"),
    sealedBeforeAnyAgent: z.literal(true),
    runMode: z.enum(["pre-agent-dry-run", "r3-live"]),
    formalRunControlAtSeal: z.boolean(),
    liveMaterialManifestPath: AbsolutePathSchema,
    liveMaterialManifestFileSha256: Sha256DigestV1Schema,
    liveMaterialManifestRecordContentSha256: Sha256DigestV1Schema,
    baseHostConfigPath: AbsolutePathSchema,
    baseHostConfigFileSha256: Sha256DigestV1Schema,
    baseDelegatedCgroupRoot: z.literal(M7_R3_DELEGATED_CGROUP_PARENT_V1),
    commonConfigWithoutDelegatedCgroupRootSha256: Sha256DigestV1Schema,
    configs: exactConfigIdentitiesSchema,
    orchestrationSources: exactOrchestrationSourcesSchema,
    priorPreAgentDiagnosticsProvenance: z.literal(
      "operator_disclosed_not_attested",
    ),
    priorPreAgentDiagnostics: priorPreAgentDiagnosticsSchema,
    agentLaunchCountAtSeal: z.literal(0),
    providerInvocationCountAtSeal: z.literal(0),
    piSessionCountAtSeal: z.literal(0),
    sealedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export const M7R3OperationalCgroupPartitionManifestV1Schema =
  operationalManifestBasisSchema
    .extend({ recordContentSha256: Sha256DigestV1Schema })
    .strict()
    .superRefine((value, context) => {
      const { recordContentSha256, ...basis } = value;
      if (recordContentSha256 !== digestJson(basis)) {
        context.addIssue({
          code: "custom",
          path: ["recordContentSha256"],
          message: "operational cgroup partition content hash does not match",
        });
      }
      if (value.formalRunControlAtSeal !== (value.runMode === "r3-live")) {
        context.addIssue({
          code: "custom",
          path: ["formalRunControlAtSeal"],
          message: "operational run-control state does not match run mode",
        });
      }
      const paths = new Set(value.configs.map((config) => config.configPath));
      const roots = new Set(
        value.configs.map((config) => config.delegatedCgroupRoot),
      );
      const hashes = new Set(
        value.configs.map((config) => config.configFileSha256),
      );
      if (paths.size !== 6 || roots.size !== 6 || hashes.size !== 6) {
        context.addIssue({
          code: "custom",
          path: ["configs"],
          message: "six operational cgroup configs require distinct identities",
        });
      }
      const sourcePaths = new Set(
        value.orchestrationSources.map((source) => source.sourcePath),
      );
      if (sourcePaths.size !== 7) {
        context.addIssue({
          code: "custom",
          path: ["orchestrationSources"],
          message: "operational orchestration sources must be distinct",
        });
      }
    });

export type M7R3OperationalCgroupPartitionManifestV1 = z.infer<
  typeof M7R3OperationalCgroupPartitionManifestV1Schema
>;

const stringArraySchema = z
  .array(z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u))
  .max(64)
  .superRefine((value, context) => {
    if (
      new Set(value).size !== value.length ||
      value.some((entry, index) => index > 0 && value[index - 1]! >= entry)
    ) {
      context.addIssue({
        code: "custom",
        message: "cgroup string array must be unique and sorted",
      });
    }
  });

const realizedCgroupNodeSchema = z
  .object({
    canonicalPath: AbsolutePathSchema,
    device: z.string().regex(/^\d+$/u),
    inode: z.string().regex(/^\d+$/u),
    ownerUid: z.number().int().nonnegative(),
    cgroupType: z.literal("domain"),
    controllers: stringArraySchema,
    subtreeControl: stringArraySchema,
    processesEmpty: z.literal(true),
    childCgroups: stringArraySchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.ownerUid !== effectiveUserId()) {
      context.addIssue({
        code: "custom",
        path: ["ownerUid"],
        message: "realized cgroup node is not owned by the effective user",
      });
    }
    for (const controller of REQUIRED_CONTROLLERS) {
      if (!value.controllers.includes(controller)) {
        context.addIssue({
          code: "custom",
          path: ["controllers"],
          message: `realized cgroup lacks ${controller}`,
        });
      }
      if (!value.subtreeControl.includes(controller)) {
        context.addIssue({
          code: "custom",
          path: ["subtreeControl"],
          message: `realized cgroup subtree lacks ${controller}`,
        });
      }
    }
  });

const topologyReceiptBasisSchema = z
  .object({
    schemaVersion: z.literal(1),
    recordKind: z.literal("m7-r3-realized-cgroup-topology"),
    observedBeforeAnyAgent: z.literal(true),
    operationalManifestPath: AbsolutePathSchema,
    operationalManifestFileSha256: Sha256DigestV1Schema,
    operationalManifestRecordContentSha256: Sha256DigestV1Schema,
    parent: realizedCgroupNodeSchema,
    groups: z.tuple([
      realizedCgroupNodeSchema,
      realizedCgroupNodeSchema,
      realizedCgroupNodeSchema,
    ]),
    leaves: z.tuple([
      realizedCgroupNodeSchema,
      realizedCgroupNodeSchema,
      realizedCgroupNodeSchema,
      realizedCgroupNodeSchema,
      realizedCgroupNodeSchema,
      realizedCgroupNodeSchema,
    ]),
    agentLaunchCountAtObservation: z.literal(0),
    providerInvocationCountAtObservation: z.literal(0),
    piSessionCountAtObservation: z.literal(0),
    observedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export const M7R3RealizedCgroupTopologyReceiptV1Schema =
  topologyReceiptBasisSchema
    .extend({ recordContentSha256: Sha256DigestV1Schema })
    .strict()
    .superRefine((value, context) => {
      const { recordContentSha256, ...basis } = value;
      if (recordContentSha256 !== digestJson(basis)) {
        context.addIssue({
          code: "custom",
          path: ["recordContentSha256"],
          message: "realized cgroup topology content hash does not match",
        });
      }
      if (
        value.parent.canonicalPath !== M7_R3_DELEGATED_CGROUP_PARENT_V1 ||
        canonicalJson(value.parent.childCgroups) !==
          canonicalJson(["case-01", "case-02", "preflight"])
      ) {
        context.addIssue({
          code: "custom",
          path: ["parent"],
          message: "realized cgroup parent topology changed",
        });
      }
      for (const [
        index,
        expected,
      ] of M7_R3_OPERATIONAL_CGROUP_GROUPS_V1.entries()) {
        const group = value.groups[index];
        if (
          group === undefined ||
          group.canonicalPath !== expected.path ||
          canonicalJson(group.childCgroups) !==
            canonicalJson(JsonValueSchema.parse(expected.childNames))
        ) {
          context.addIssue({
            code: "custom",
            path: ["groups", index],
            message: "realized cgroup group topology changed",
          });
        }
      }
      for (const [
        index,
        expected,
      ] of M7_R3_OPERATIONAL_CGROUP_PURPOSES_V1.entries()) {
        const leaf = value.leaves[index];
        if (
          leaf === undefined ||
          leaf.canonicalPath !== expected.delegatedCgroupRoot ||
          leaf.childCgroups.length !== 0
        ) {
          context.addIssue({
            code: "custom",
            path: ["leaves", index],
            message: "realized delegated cgroup leaf changed or is not empty",
          });
        }
      }
    });

export type M7R3RealizedCgroupTopologyReceiptV1 = z.infer<
  typeof M7R3RealizedCgroupTopologyReceiptV1Schema
>;

const digest = (bytes: string | Uint8Array): Sha256DigestV1 =>
  asSha256DigestV1(createHash("sha256").update(bytes).digest("hex"));

const digestJson = (value: unknown): Sha256DigestV1 =>
  digest(canonicalJson(JsonValueSchema.parse(value)));

const encodeJson = (value: unknown): Uint8Array =>
  Buffer.from(`${canonicalJson(JsonValueSchema.parse(value))}\n`, "utf8");

const effectiveUserId = (): number => {
  const uid = process.geteuid?.();
  if (uid === undefined) {
    throw new Error("R3 operational config requires Unix ownership checks");
  }
  return uid;
};

const requireFreshPrivateDirectory = async (path: string): Promise<void> => {
  const [canonical, metadata, entries] = await Promise.all([
    realpath(path),
    lstat(path),
    readdir(path),
  ]);
  if (
    canonical !== path ||
    !isAbsolute(path) ||
    resolve(path) !== path ||
    metadata.isSymbolicLink() ||
    !metadata.isDirectory() ||
    metadata.uid !== effectiveUserId() ||
    (metadata.mode & 0o7777) !== PRIVATE_DIRECTORY_MODE ||
    entries.length !== 0
  ) {
    throw new TypeError(
      "R3 operational config root must be a fresh owned canonical mode-0700 directory",
    );
  }
};

const writePrivateFileOnce = async (
  path: string,
  bytes: Uint8Array,
): Promise<void> => {
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_OPERATIONAL_FILE_BYTES) {
    throw new TypeError("R3 operational file has unsupported size");
  }
  await publishPrivateFileOnceV1({
    root: dirname(path),
    filename: basename(path),
    bytes,
  });
};

const assertStablePrivateFile = async (
  path: string,
  expectedBytes: Uint8Array,
): Promise<void> => {
  const [canonical, metadata, bytes] = await Promise.all([
    realpath(path),
    lstat(path),
    readFile(path),
  ]);
  if (
    canonical !== path ||
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    metadata.nlink !== 1 ||
    metadata.uid !== effectiveUserId() ||
    (metadata.mode & 0o7777) !== PRIVATE_FILE_MODE ||
    !Buffer.from(bytes).equals(Buffer.from(expectedBytes))
  ) {
    throw new Error("R3 operational file changed after its exclusive write");
  }
};

const readStableRegularFile = async (path: string): Promise<Uint8Array> => {
  const [canonical, before] = await Promise.all([realpath(path), lstat(path)]);
  if (
    canonical !== path ||
    before.isSymbolicLink() ||
    !before.isFile() ||
    before.nlink !== 1 ||
    before.size < 1 ||
    before.size > MAX_OPERATIONAL_FILE_BYTES
  ) {
    throw new TypeError(
      "R3 operational source must be a bounded canonical file",
    );
  }
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const opened = await handle.stat();
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.nlink !== 1 ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      after.nlink !== 1
    ) {
      throw new Error("R3 operational source changed while reading");
    }
    return Uint8Array.from(bytes);
  } finally {
    await handle.close();
  }
};

const withoutDelegatedCgroupRoot = (
  config: ProjectEnvironmentHostConfigV1,
): Omit<ProjectEnvironmentHostConfigV1, "delegatedCgroupRoot"> => {
  const { delegatedCgroupRoot: _delegatedCgroupRoot, ...common } = config;
  void _delegatedCgroupRoot;
  return common;
};

export interface M7R3PreparedOperationalHostConfigsV1 {
  readonly manifestPath: string;
  readonly manifestFileSha256: Sha256DigestV1;
  readonly manifest: M7R3OperationalCgroupPartitionManifestV1;
  readonly caseAgentHostConfigPaths: readonly [
    Readonly<{ readonly runtime: string; readonly codeOnly: string }>,
    Readonly<{ readonly runtime: string; readonly codeOnly: string }>,
  ];
  readonly noAgentPreflightHostConfigPaths: readonly [string, string];
}

export const m7R3OperationalHostConfigPathsForCaseV1 = (
  prepared: M7R3PreparedOperationalHostConfigsV1,
  ordinal: 1 | 2,
): Readonly<{
  readonly runtime: string;
  readonly codeOnly: string;
  readonly noAgentPreflight: string;
}> => {
  const index = ordinal === 1 ? 0 : 1;
  const agent = prepared.caseAgentHostConfigPaths[index];
  return Object.freeze({
    runtime: agent.runtime,
    codeOnly: agent.codeOnly,
    noAgentPreflight: prepared.noAgentPreflightHostConfigPaths[index],
  });
};

export type M7R3OperationalOrchestrationSourcesInputV1 = z.input<
  typeof exactOrchestrationSourcesSchema
>;

/**
 * Derives six R3-only physical cgroup bindings from the already-frozen Host
 * config. Every other Host config field remains exactly equal at the parsed
 * DTO boundary. The files are immutable run outputs and never rewrite frozen
 * material.
 */
export async function createM7R3OperationalHostConfigsOnceV1(input: {
  readonly operationalRoot: string;
  readonly runMode: "pre-agent-dry-run" | "r3-live";
  readonly liveMaterialManifestPath: string;
  readonly liveMaterialManifestBytes: Uint8Array;
  readonly liveMaterialManifestRecordContentSha256: Sha256DigestV1;
  readonly baseHostConfigPath: string;
  readonly baseHostConfigBytes: Uint8Array;
  readonly baseHostConfig: ProjectEnvironmentHostConfigV1;
  readonly orchestrationSources: M7R3OperationalOrchestrationSourcesInputV1;
  readonly sealedAt: string;
}): Promise<M7R3PreparedOperationalHostConfigsV1> {
  await requireFreshPrivateDirectory(input.operationalRoot);
  if (
    input.baseHostConfig.delegatedCgroupRoot !==
    M7_R3_DELEGATED_CGROUP_PARENT_V1
  ) {
    throw new TypeError(
      "R3 frozen Host config has an unexpected cgroup parent",
    );
  }
  const [realizedManifestBytes, realizedHostConfigBytes] = await Promise.all([
    readStableRegularFile(input.liveMaterialManifestPath),
    readStableRegularFile(input.baseHostConfigPath),
  ]);
  if (
    digest(input.liveMaterialManifestBytes) !== digest(realizedManifestBytes) ||
    digest(input.baseHostConfigBytes) !== digest(realizedHostConfigBytes)
  ) {
    throw new Error(
      "R3 frozen input bytes changed before operational derivation",
    );
  }
  const commonConfigWithoutDelegatedCgroupRootSha256 = digestJson(
    withoutDelegatedCgroupRoot(input.baseHostConfig),
  );
  const orchestrationSources = exactOrchestrationSourcesSchema.parse(
    input.orchestrationSources,
  );
  const realizedOrchestrationSourceBytes = await Promise.all(
    orchestrationSources.map((source) =>
      readStableRegularFile(source.sourcePath),
    ),
  );
  if (
    orchestrationSources.some(
      (source, index) =>
        source.sourceFileSha256 !==
        digest(realizedOrchestrationSourceBytes[index]!),
    )
  ) {
    throw new Error("R3 orchestration source changed before operational seal");
  }
  const configRecords: Array<z.infer<typeof operationalConfigIdentitySchema>> =
    [];
  for (const purpose of M7_R3_OPERATIONAL_CGROUP_PURPOSES_V1) {
    const config = ProjectEnvironmentHostConfigV1Schema.parse({
      ...input.baseHostConfig,
      delegatedCgroupRoot: purpose.delegatedCgroupRoot,
    });
    if (
      digestJson(withoutDelegatedCgroupRoot(config)) !==
      commonConfigWithoutDelegatedCgroupRootSha256
    ) {
      throw new Error("R3 operational Host config changed a non-cgroup field");
    }
    const configPath = join(input.operationalRoot, purpose.configFileName);
    const bytes = encodeJson(config);
    await writePrivateFileOnce(configPath, bytes);
    await assertStablePrivateFile(configPath, bytes);
    configRecords.push({
      purpose: purpose.purpose,
      configPath,
      delegatedCgroupRoot: purpose.delegatedCgroupRoot,
      configFileSha256: digest(bytes),
    });
  }
  const parsedConfigs = exactConfigIdentitiesSchema.parse(configRecords);
  const manifestBasis = operationalManifestBasisSchema.parse({
    schemaVersion: 1,
    recordKind: "m7-r3-operational-cgroup-partition",
    sealedBeforeAnyAgent: true,
    runMode: input.runMode,
    formalRunControlAtSeal: input.runMode === "r3-live",
    liveMaterialManifestPath: input.liveMaterialManifestPath,
    liveMaterialManifestFileSha256: digest(input.liveMaterialManifestBytes),
    liveMaterialManifestRecordContentSha256:
      input.liveMaterialManifestRecordContentSha256,
    baseHostConfigPath: input.baseHostConfigPath,
    baseHostConfigFileSha256: digest(input.baseHostConfigBytes),
    baseDelegatedCgroupRoot: input.baseHostConfig.delegatedCgroupRoot,
    commonConfigWithoutDelegatedCgroupRootSha256,
    configs: parsedConfigs,
    orchestrationSources,
    priorPreAgentDiagnosticsProvenance: "operator_disclosed_not_attested",
    priorPreAgentDiagnostics: M7_R3_PRIOR_PRE_AGENT_DIAGNOSTICS_V1,
    agentLaunchCountAtSeal: 0,
    providerInvocationCountAtSeal: 0,
    piSessionCountAtSeal: 0,
    sealedAt: input.sealedAt,
  });
  const manifest = M7R3OperationalCgroupPartitionManifestV1Schema.parse({
    ...manifestBasis,
    recordContentSha256: digestJson(manifestBasis),
  });
  const manifestPath = join(
    input.operationalRoot,
    "m7-r3-cgroup-partition.v1.json",
  );
  const manifestBytes = encodeJson(manifest);
  await writePrivateFileOnce(manifestPath, manifestBytes);
  await assertStablePrivateFile(manifestPath, manifestBytes);
  const caseAgentHostConfigPaths = Object.freeze([
    Object.freeze({
      runtime: parsedConfigs[0].configPath,
      codeOnly: parsedConfigs[1].configPath,
    }),
    Object.freeze({
      runtime: parsedConfigs[2].configPath,
      codeOnly: parsedConfigs[3].configPath,
    }),
  ] as const);
  const noAgentPreflightHostConfigPaths = Object.freeze([
    parsedConfigs[4].configPath,
    parsedConfigs[5].configPath,
  ] as const);
  return Object.freeze({
    manifestPath,
    manifestFileSha256: digest(manifestBytes),
    manifest,
    caseAgentHostConfigPaths,
    noAgentPreflightHostConfigPaths,
  });
}

export interface M7R3CgroupNodeInspectionPortV1 {
  inspect(path: string): Promise<unknown>;
}

const words = (value: string): string[] =>
  [...new Set(value.trim().split(/\s+/u).filter(Boolean))].sort();

const NODE_CGROUP_INSPECTION: M7R3CgroupNodeInspectionPortV1 = {
  async inspect(path) {
    const [
      canonicalPath,
      metadata,
      cgroupType,
      controllers,
      subtree,
      procs,
      entries,
    ] = await Promise.all([
      realpath(path),
      lstat(path, { bigint: true }),
      readFile(join(path, "cgroup.type"), "utf8"),
      readFile(join(path, "cgroup.controllers"), "utf8"),
      readFile(join(path, "cgroup.subtree_control"), "utf8"),
      readFile(join(path, "cgroup.procs"), "utf8"),
      readdir(path, { withFileTypes: true }),
    ]);
    return {
      canonicalPath,
      device: metadata.dev.toString(),
      inode: metadata.ino.toString(),
      ownerUid: Number(metadata.uid),
      cgroupType: cgroupType.trim(),
      controllers: words(controllers),
      subtreeControl: words(subtree),
      processesEmpty: procs.trim() === "",
      childCgroups: entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort(),
    };
  },
};

/** Seals actual, empty six-leaf cgroup topology before any Task broker runs. */
export async function sealM7R3RealizedCgroupTopologyOnceV1(
  input: {
    readonly operationalRoot: string;
    readonly operational: M7R3PreparedOperationalHostConfigsV1;
    readonly observedAt: string;
  },
  inspection: M7R3CgroupNodeInspectionPortV1 = NODE_CGROUP_INSPECTION,
): Promise<{
  readonly receiptPath: string;
  readonly receiptFileSha256: Sha256DigestV1;
  readonly receipt: M7R3RealizedCgroupTopologyReceiptV1;
}> {
  const expectedExistingNames = [
    ...M7_R3_OPERATIONAL_CGROUP_PURPOSES_V1.map(
      (purpose) => purpose.configFileName,
    ),
    basename(input.operational.manifestPath),
  ].sort();
  if (
    canonicalJson((await readdir(input.operationalRoot)).sort()) !==
    canonicalJson(expectedExistingNames)
  ) {
    throw new Error("R3 operational root changed before topology sealing");
  }
  const [parent, groups, leaves] = await Promise.all([
    inspection.inspect(M7_R3_DELEGATED_CGROUP_PARENT_V1),
    Promise.all(
      M7_R3_OPERATIONAL_CGROUP_GROUPS_V1.map((group) =>
        inspection.inspect(group.path),
      ),
    ),
    Promise.all(
      M7_R3_OPERATIONAL_CGROUP_PURPOSES_V1.map((purpose) =>
        inspection.inspect(purpose.delegatedCgroupRoot),
      ),
    ),
  ]);
  const receiptBasis = topologyReceiptBasisSchema.parse({
    schemaVersion: 1,
    recordKind: "m7-r3-realized-cgroup-topology",
    observedBeforeAnyAgent: true,
    operationalManifestPath: input.operational.manifestPath,
    operationalManifestFileSha256: input.operational.manifestFileSha256,
    operationalManifestRecordContentSha256:
      input.operational.manifest.recordContentSha256,
    parent,
    groups,
    leaves,
    agentLaunchCountAtObservation: 0,
    providerInvocationCountAtObservation: 0,
    piSessionCountAtObservation: 0,
    observedAt: input.observedAt,
  });
  const receipt = M7R3RealizedCgroupTopologyReceiptV1Schema.parse({
    ...receiptBasis,
    recordContentSha256: digestJson(receiptBasis),
  });
  const receiptPath = join(
    input.operationalRoot,
    "m7-r3-realized-cgroup-topology.v1.json",
  );
  const receiptBytes = encodeJson(receipt);
  await writePrivateFileOnce(receiptPath, receiptBytes);
  await assertStablePrivateFile(receiptPath, receiptBytes);
  return Object.freeze({
    receiptPath,
    receiptFileSha256: digest(receiptBytes),
    receipt,
  });
}
