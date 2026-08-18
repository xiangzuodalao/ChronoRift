import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { asSha256DigestV1 } from "@chronorift/domain";
import { afterEach, describe, expect, it } from "vitest";

import {
  M7R3OperationalCgroupPartitionManifestV1Schema,
  M7R3RealizedCgroupTopologyReceiptV1Schema,
  M7_R3_DELEGATED_CGROUP_PARENT_V1,
  M7_R3_OPERATIONAL_CGROUP_PURPOSES_V1,
  M7_R3_PRIOR_PRE_AGENT_DIAGNOSTICS_V1,
  createM7R3OperationalHostConfigsOnceV1,
  m7R3OperationalHostConfigPathsForCaseV1,
  sealM7R3RealizedCgroupTopologyOnceV1,
  type M7R3OperationalOrchestrationSourcesInputV1,
} from "./m7-r3-live-operational-config.js";
import {
  ProjectEnvironmentHostConfigV1Schema,
  type ProjectEnvironmentHostConfigV1,
} from "./project-environment-host-config.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const digest = (bytes: string | Uint8Array) =>
  asSha256DigestV1(createHash("sha256").update(bytes).digest("hex"));

const makeRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "chronorift-m7-r3-operational-"));
  roots.push(root);
  await chmod(root, 0o700);
  return root;
};

const baseConfig = (root: string): ProjectEnvironmentHostConfigV1 =>
  ProjectEnvironmentHostConfigV1Schema.parse({
    schemaVersion: 1,
    configKind: "chronorift-project-environment-host",
    taskStorageRoot: join(root, "task-storage"),
    runtimeRoot: join(root, "runtime"),
    delegatedCgroupRoot: M7_R3_DELEGATED_CGROUP_PARENT_V1,
    bwrapPath: "/usr/bin/bwrap",
    prlimitPath: "/usr/bin/prlimit",
    busyboxPath: "/usr/bin/busybox",
    fontconfigProbePath: "/usr/bin/fc-match",
    xdgUserDirPath: "/usr/bin/xdg-user-dir",
    nodePath: "/usr/bin/node",
    bashPath: "/usr/bin/bash",
    rgPath: "/usr/bin/rg",
    findPath: "/usr/bin/find",
    lsPath: "/usr/bin/ls",
    lddPath: "/usr/bin/ldd",
    godotToolchains: [
      {
        schemaVersion: 1,
        key: "godot-4.7.1-linux-x86_64-official",
        version: "4.7.1",
        platform: "linux-x86_64",
        channel: "stable-official",
        executablePath: "/opt/godot",
        executableSha256: digest("godot"),
        buildFeatures: ["gdscript", "headless"],
        renderer: "gl_compatibility",
      },
    ],
  });

const sourceKinds = [
  "container-entrypoint",
  "run-wrapper",
  "static-admission",
  "run-control",
  "live-test-config",
  "live-composer",
  "operational-config-composer",
] as const;

const createInputs = async (root: string) => {
  const operationalRoot = join(root, "operational");
  await mkdir(operationalRoot, { mode: 0o700 });
  const liveMaterialManifestPath = join(root, "live-materials.v1.json");
  const baseHostConfigPath = join(root, "host-config.v1.json");
  const liveMaterialManifestBytes = Buffer.from('{"schemaVersion":1}\n');
  const config = baseConfig(root);
  const baseHostConfigBytes = Buffer.from(`${JSON.stringify(config)}\n`);
  await Promise.all([
    writeFile(liveMaterialManifestPath, liveMaterialManifestBytes, {
      mode: 0o600,
    }),
    writeFile(baseHostConfigPath, baseHostConfigBytes, { mode: 0o600 }),
  ]);
  const sourceRecords = [];
  for (const [index, sourceKind] of sourceKinds.entries()) {
    const sourcePath = join(root, `${String(index)}-${sourceKind}`);
    const bytes = Buffer.from(`${sourceKind}\n`);
    await writeFile(sourcePath, bytes, { mode: 0o600 });
    sourceRecords.push({
      sourceKind,
      sourcePath,
      sourceFileSha256: digest(bytes),
    });
  }
  return {
    operationalRoot,
    runMode: "pre-agent-dry-run" as const,
    liveMaterialManifestPath,
    liveMaterialManifestBytes,
    liveMaterialManifestRecordContentSha256: digest("live-content"),
    baseHostConfigPath,
    baseHostConfigBytes,
    baseHostConfig: config,
    orchestrationSources:
      sourceRecords as unknown as M7R3OperationalOrchestrationSourcesInputV1,
    sealedAt: "2026-08-15T00:00:00.000Z",
  } as const;
};

const stripCgroup = (config: ProjectEnvironmentHostConfigV1) => {
  const { delegatedCgroupRoot, ...common } = config;
  void delegatedCgroupRoot;
  return common;
};

describe("M7 R3 live operational cgroup partition", () => {
  it("writes six exact configs and a strict self-hashed supplemental record once", async () => {
    const root = await makeRoot();
    const input = await createInputs(root);
    const prepared = await createM7R3OperationalHostConfigsOnceV1(input);

    expect(prepared.manifest.configs.map((config) => config.purpose)).toEqual(
      M7_R3_OPERATIONAL_CGROUP_PURPOSES_V1.map((purpose) => purpose.purpose),
    );
    expect(prepared.manifest.priorPreAgentDiagnostics).toEqual(
      M7_R3_PRIOR_PRE_AGENT_DIAGNOSTICS_V1,
    );
    expect(prepared.manifest.priorPreAgentDiagnostics).toHaveLength(5);
    expect(prepared.manifest.priorPreAgentDiagnostics[4]).toMatchObject({
      ordinal: 5,
      code: "admission_operational_root_type",
      stage: "static_admission",
      outcome: "failed_before_agent",
      disposableCleanupProven: true,
      formalRunControlCreated: false,
      agentLaunchCount: 0,
      piSessionCount: 0,
      providerInvocationCount: 0,
      godotInvocation: "none",
      publicBehaviorPreflightInvoked: false,
      hiddenEvaluatorInvoked: false,
      constructionOrPortfolioPersisted: false,
    });
    expect(prepared.manifest.orchestrationSources).toHaveLength(7);
    expect(m7R3OperationalHostConfigPathsForCaseV1(prepared, 1)).toEqual({
      runtime: prepared.manifest.configs[0].configPath,
      codeOnly: prepared.manifest.configs[1].configPath,
      noAgentPreflight: prepared.manifest.configs[4].configPath,
    });
    expect(m7R3OperationalHostConfigPathsForCaseV1(prepared, 2)).toEqual({
      runtime: prepared.manifest.configs[2].configPath,
      codeOnly: prepared.manifest.configs[3].configPath,
      noAgentPreflight: prepared.manifest.configs[5].configPath,
    });
    expect(
      M7R3OperationalCgroupPartitionManifestV1Schema.parse(prepared.manifest),
    ).toEqual(prepared.manifest);
    expect(() =>
      M7R3OperationalCgroupPartitionManifestV1Schema.parse({
        ...prepared.manifest,
        sealedAt: "2026-08-15T00:00:09.000Z",
      }),
    ).toThrow(/content hash does not match/u);

    for (const [index, record] of prepared.manifest.configs.entries()) {
      const expected = M7_R3_OPERATIONAL_CGROUP_PURPOSES_V1[index]!;
      const bytes = await readFile(record.configPath);
      const config = ProjectEnvironmentHostConfigV1Schema.parse(
        JSON.parse(bytes.toString("utf8")),
      );
      expect(config.delegatedCgroupRoot).toBe(expected.delegatedCgroupRoot);
      expect(stripCgroup(config)).toEqual(stripCgroup(input.baseHostConfig));
      expect(digest(bytes)).toBe(record.configFileSha256);
      const metadata = await lstat(record.configPath);
      expect(metadata.mode & 0o7777).toBe(0o600);
      expect(metadata.nlink).toBe(1);
    }
    const manifestMetadata = await lstat(prepared.manifestPath);
    expect(manifestMetadata.mode & 0o7777).toBe(0o600);
    expect(manifestMetadata.nlink).toBe(1);
    await expect(createM7R3OperationalHostConfigsOnceV1(input)).rejects.toThrow(
      /fresh owned canonical mode-0700/u,
    );
  });

  it("seals the exact realized hierarchy and rejects nonempty leaves", async () => {
    const root = await makeRoot();
    const input = await createInputs(root);
    const prepared = await createM7R3OperationalHostConfigsOnceV1(input);
    let inode = 100n;
    const childCgroups = (path: string): string[] => {
      if (path === M7_R3_DELEGATED_CGROUP_PARENT_V1) {
        return ["case-01", "case-02", "preflight"];
      }
      if (path.endsWith("/case-01") && !path.includes("/preflight/")) {
        return ["code-only", "runtime"];
      }
      if (path.endsWith("/case-02") && !path.includes("/preflight/")) {
        return ["code-only", "runtime"];
      }
      if (path.endsWith("/preflight")) return ["case-01", "case-02"];
      return [];
    };
    const sealed = await sealM7R3RealizedCgroupTopologyOnceV1(
      {
        operationalRoot: input.operationalRoot,
        operational: prepared,
        observedAt: "2026-08-15T00:00:01.000Z",
      },
      {
        inspect: (path) =>
          Promise.resolve({
            canonicalPath: path,
            device: "1",
            inode: String(inode++),
            ownerUid: process.geteuid?.() ?? 0,
            cgroupType: "domain",
            controllers: ["cpu", "memory", "pids"],
            subtreeControl: ["cpu", "memory", "pids"],
            processesEmpty: true,
            childCgroups: childCgroups(path),
          }),
      },
    );
    expect(
      M7R3RealizedCgroupTopologyReceiptV1Schema.parse(sealed.receipt),
    ).toEqual(sealed.receipt);
    expect(sealed.receipt.leaves).toHaveLength(6);
    expect(
      sealed.receipt.leaves.every((leaf) => leaf.childCgroups.length === 0),
    ).toBe(true);
    expect((await readdir(input.operationalRoot)).sort()).toHaveLength(8);
    const receiptMetadata = await lstat(sealed.receiptPath);
    expect(receiptMetadata.mode & 0o7777).toBe(0o600);
    expect(receiptMetadata.nlink).toBe(1);

    const rejectedRoot = await makeRoot();
    const rejectedInput = await createInputs(rejectedRoot);
    const rejectedPrepared =
      await createM7R3OperationalHostConfigsOnceV1(rejectedInput);
    await expect(
      sealM7R3RealizedCgroupTopologyOnceV1(
        {
          operationalRoot: rejectedInput.operationalRoot,
          operational: rejectedPrepared,
          observedAt: "2026-08-15T00:00:02.000Z",
        },
        {
          inspect: (path) =>
            Promise.resolve({
              canonicalPath: path,
              device: "1",
              inode: String(inode++),
              ownerUid: process.geteuid?.() ?? 0,
              cgroupType: "domain",
              controllers: ["cpu", "memory", "pids"],
              subtreeControl: ["cpu", "memory", "pids"],
              processesEmpty: true,
              childCgroups:
                path ===
                M7_R3_OPERATIONAL_CGROUP_PURPOSES_V1[0].delegatedCgroupRoot
                  ? ["stale-task"]
                  : childCgroups(path),
            }),
        },
      ),
    ).rejects.toThrow(/leaf changed or is not empty/u);
    expect(await readdir(rejectedInput.operationalRoot)).toHaveLength(7);
  });

  it("fails before creating derived output when a bound source hash differs", async () => {
    const root = await makeRoot();
    const input = await createInputs(root);
    const first = input.orchestrationSources[0];
    await expect(
      createM7R3OperationalHostConfigsOnceV1({
        ...input,
        orchestrationSources: [
          { ...first, sourceFileSha256: digest("substituted") },
          ...input.orchestrationSources.slice(1),
        ] as unknown as M7R3OperationalOrchestrationSourcesInputV1,
      }),
    ).rejects.toThrow(/orchestration source changed/u);
    expect(await readdir(input.operationalRoot)).toEqual([]);
  });
});
