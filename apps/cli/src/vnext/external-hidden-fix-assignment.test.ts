import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import {
  AdapterConformanceReceiptV1Schema,
  ProjectAdapterRevisionV1Schema,
  asAdapterId,
  asAdapterConformanceReceiptId,
  asProjectAdapterRevisionId,
  asSha256DigestV1,
  asSourceId,
} from "@chronorift/domain";
import { loadProjectAdapterPackageV1 } from "@chronorift/godot-adapter";
import {
  canonicalJson,
  projectEnvironmentPackageContentDigestV1,
} from "@chronorift/json-artifacts";
import { afterEach, describe, expect, it } from "vitest";

import { createProjectAdapterReferenceTemplateFilesV1 } from "./project-adapter-reference-template.js";
import { readTrustedSelectedTree } from "./selected-tree.js";
import { preflightCleanProjectEnvironmentV1 } from "./source-preflight.js";
import {
  ExternalHiddenFixAgentAssignmentProjectionV1Schema,
  ExternalHiddenFixPublicTaskSpecV1Schema,
  prepareExternalHiddenFixAssignmentV1,
  type PrepareExternalHiddenFixAssignmentV1Input,
} from "./external-hidden-fix-assignment.js";

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];

const git = async (cwd: string, args: readonly string[]): Promise<string> => {
  const result = await execFileAsync("/usr/bin/git", [...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  return result.stdout.trim();
};

const commitAll = async (root: string, message: string): Promise<string> => {
  await git(root, ["add", "--all"]);
  await git(root, [
    "-c",
    "user.name=ChronoRift Test",
    "-c",
    "user.email=test@chronorift.invalid",
    "commit",
    "--quiet",
    "-m",
    message,
  ]);
  return git(root, ["rev-parse", "HEAD"]);
};

const sha = (value: string | Uint8Array) =>
  asSha256DigestV1(createHash("sha256").update(value).digest("hex"));

const labeledDigest = (label: string, value: string) =>
  asSha256DigestV1(
    createHash("sha256").update(label).update("\0").update(value).digest("hex"),
  );

const writePrivate = async (
  path: string,
  bytes: string | Uint8Array,
): Promise<void> => {
  await writeFile(path, bytes, { mode: 0o600, flag: "wx" });
  await chmod(path, 0o600);
};

interface Fixture {
  readonly parent: string;
  readonly pristineRoot: string;
  readonly mutatedRoot: string;
  readonly hostOnlyRoot: string;
  readonly exposedRoot: string;
  readonly subjectCommit: string;
  readonly adapterRevisionPath: string;
  readonly adapterConformanceReceiptPath: string;
  readonly input: PrepareExternalHiddenFixAssignmentV1Input;
}

const publicTask = (subjectCommit: string) =>
  ExternalHiddenFixPublicTaskSpecV1Schema.parse({
    schemaVersion: 1,
    taskKind: "external-hidden-fix",
    taskId: "task:m6-moddable-platformer-hidden-fix-r1",
    subjectCommit,
    goal: "Investigate the public runtime symptom, implement a fix, and rerun it.",
    publicExecutionClassifier: {
      schemaVersion: 1,
      classifierId: "moddable-platformer-public-symptom-v1",
      implementationSha256: sha("public classifier v1"),
    },
    agentBudget: {
      provider: "openai-codex",
      model: "gpt-5.6-luna",
      thinkingLevel: "max",
      attemptsMaximum: 1,
      userTurnsPerAttemptMaximum: 1,
      toolCallsMaximum: 128,
      wallTimeMsMaximum: 900_000,
      taskSandboxNetworkMode: "denied",
      taskCredentialMountCountMaximum: 0,
    },
    evaluatorBudget: {
      scenarioClasses: [
        "public_reproduction",
        "hidden_variant",
        "regression_control",
      ],
      repetitionsPerScenario: 3,
      plannedRunCount: 9,
      evaluatorProcessAttemptsPerRunMaximum: 1,
      freshWorkspacePerRun: true,
      freshImportCachePerRun: true,
      freshEvaluatorProcessPerRun: true,
      agentRelaunchCountMaximum: 0,
      wallTimeMsPerRunMaximum: 120_000,
    },
  });

const createFixture = async (): Promise<Fixture> => {
  const parent = await mkdtemp(
    join(tmpdir(), "chronorift-m6-assignment-prep-"),
  );
  temporaryRoots.push(parent);
  await chmod(parent, 0o700);
  const pristineRoot = join(parent, "pristine");
  const mutatedRoot = join(parent, "mutated-authority");
  const hostOnlyRoot = join(parent, "host-only");
  const exposedRoot = join(parent, "agent-public");
  await Promise.all([
    mkdir(pristineRoot, { mode: 0o700 }),
    mkdir(hostOnlyRoot, { mode: 0o700 }),
    mkdir(exposedRoot, { mode: 0o700 }),
  ]);
  await Promise.all([
    writeFile(join(pristineRoot, ".godot-version"), "4.7.1\n"),
    writeFile(
      join(pristineRoot, "project.godot"),
      'config_version=5\n\n[application]\nrun/main_scene="res://main.tscn"\n',
    ),
    writeFile(
      join(pristineRoot, "main.tscn"),
      '[gd_scene load_steps=2 format=3]\n\n[ext_resource path="res://player.gd" type="Script" id="1"]\n\n[node name="Main" type="Node"]\nscript = ExtResource("1")\n',
    ),
    writeFile(
      join(pristineRoot, "player.gd"),
      "@tool\nextends Node\nvar speed := 10\n",
    ),
  ]);
  await git(pristineRoot, ["init", "--quiet", "--initial-branch=main"]);
  const subjectCommit = await commitAll(pristineRoot, "pristine subject");

  const pristine = await preflightCleanProjectEnvironmentV1({
    projectPath: pristineRoot,
    sourceRepositoryExclusionRoots: [hostOnlyRoot, exposedRoot],
    gdscriptPolicy: "tracked-tool-scripts-v1",
  });
  const adapterRoot = join(hostOnlyRoot, "adapter");
  await mkdir(adapterRoot, { mode: 0o700 });
  const template = createProjectAdapterReferenceTemplateFilesV1({
    adapterId: asAdapterId("adapter:moddable-platformer"),
    mainScene: pristine.mainScene,
  });
  for (const file of template) {
    const relativePath = file.relativePath.replace(
      /^templates\/minimal\//u,
      "",
    );
    const destination = join(adapterRoot, relativePath);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await writePrivate(destination, file.bytes);
  }
  const loadedAdapter = await loadProjectAdapterPackageV1(adapterRoot, {
    requireSingleLaunchTarget: true,
    expectedMainScene: pristine.mainScene,
    requireEmptyLaunchParameters: true,
  });
  const adapterPackageFiles = await Promise.all(
    loadedAdapter.files.map(async (file) => ({
      path: file.path,
      bytes: new Uint8Array(await readFile(join(adapterRoot, file.path))),
    })),
  );
  const adapterContentDigest = asSha256DigestV1(
    projectEnvironmentPackageContentDigestV1(adapterPackageFiles),
  );
  const adapterRevision = ProjectAdapterRevisionV1Schema.parse({
    schemaVersion: 1,
    adapterRevisionId: asProjectAdapterRevisionId(
      `adapter-revision:v1:${loadedAdapter.candidateSha256}`,
    ),
    adapterId: loadedAdapter.manifest.adapterId,
    sourceId: asSourceId(`source:v1:${pristine.projectSourceIdentity}`),
    packageDigest: loadedAdapter.candidateSha256,
    manifestDigest: loadedAdapter.manifestSha256,
    implementationDigest: labeledDigest(
      "project-adapter-implementation-v1",
      loadedAdapter.files
        .filter((file) => file.path.endsWith(".gd"))
        .map((file) => `${file.path}:${file.sha256}`)
        .join("\n"),
    ),
    payloadSchemaDigest: labeledDigest(
      "project-adapter-payload-schemas-v1",
      loadedAdapter.manifest.schemas
        .map((schema) => `${schema.schemaId}:${schema.sha256}`)
        .join("\n"),
    ),
    sdkDigest: sha("sdk"),
    bridgeDigest: sha("bridge"),
    capabilitySet: {
      schemaVersion: 1,
      modules: loadedAdapter.manifest.modules.modules.map((module) => ({
        ...module,
      })),
    },
    conformanceReceiptId: asAdapterConformanceReceiptId("conformance:m6-test"),
    contentByteLength: loadedAdapter.totalBytes,
    contentFileCount: loadedAdapter.files.length,
  });
  const adapterRevisionPath = join(hostOnlyRoot, "adapter-revision.json");
  await writePrivate(
    adapterRevisionPath,
    `${canonicalJson(adapterRevision as never)}\n`,
  );
  const adapterConformanceReceipt = AdapterConformanceReceiptV1Schema.parse({
    schemaVersion: 1,
    receiptId: adapterRevision.conformanceReceiptId,
    taskId: "task:m6-adapter-pristine-conformance",
    attemptId: "attempt:m6-adapter-pristine-conformance",
    sourceId: adapterRevision.sourceId,
    candidateId: "candidate:m6-adapter-pristine-conformance",
    candidateDigest: adapterContentDigest,
    toolchainReceiptId: "toolchain:m6-adapter-pristine-conformance",
    capabilitySet: adapterRevision.capabilitySet,
    stateDomains: [
      {
        schemaVersion: 1,
        domainId: "world",
        disposition: "uncontrolled",
        schemaDigest: null,
        limitations: ["Frozen pristine conformance does not checkpoint state."],
      },
    ],
    observations: {
      schemaVersion: 1,
      bridgeHandshakes: 1,
      entityLifecycleRecords: 1,
      stateSamples: 1,
      queries: 2,
      declaredCustomEventTypes: 0,
      observedCustomEventTypes: 0,
      captures: 1,
    },
    coverage: [
      {
        schemaVersion: 1,
        channelId: "project_adapter_observations",
        status: "complete",
        observedRecords: 4,
        droppedRecords: 0,
        overwrittenRecords: 0,
        limitations: [],
      },
    ],
    cleanup: {
      schemaVersion: 1,
      processTreeTerminated: true,
      runtimeExited: true,
      bridgeExited: true,
      isolationGroupEmpty: true,
      scopeRemoved: true,
      scratchRemoved: true,
      storageReconciled: true,
    },
    outcome: "conformed",
    failures: [],
    startedAt: "2026-08-13T00:00:00.000Z",
    completedAt: "2026-08-13T00:00:10.000Z",
  });
  const adapterConformanceReceiptPath = join(
    hostOnlyRoot,
    "adapter-conformance-receipt.json",
  );
  await writePrivate(
    adapterConformanceReceiptPath,
    `${canonicalJson(adapterConformanceReceipt as never)}\n`,
  );

  await execFileAsync("/usr/bin/git", [
    "clone",
    "--quiet",
    pristineRoot,
    mutatedRoot,
  ]);
  await writeFile(
    join(mutatedRoot, "player.gd"),
    "@tool\nextends Node\nvar speed := -10\n",
  );
  await commitAll(mutatedRoot, "hidden mutation");
  const mutationBytes = await git(mutatedRoot, [
    "diff",
    "--binary",
    subjectCommit,
    "HEAD",
  ]);

  const publicTaskPath = join(exposedRoot, "assignment.json");
  await writeFile(
    publicTaskPath,
    `${canonicalJson(publicTask(subjectCommit) as never)}\n`,
  );
  const mutationPath = join(hostOnlyRoot, "mutation.patch");
  const evaluatorImplementationPath = join(hostOnlyRoot, "evaluator.mjs");
  const evaluatorBundlePath = join(hostOnlyRoot, "evaluator-bundle.json");
  await Promise.all([
    writePrivate(mutationPath, `${mutationBytes}\n`),
    writePrivate(
      evaluatorImplementationPath,
      "export const evaluate = () => true;\n",
    ),
    writePrivate(
      evaluatorBundlePath,
      '{"scenarioClasses":3,"repetitions":3}\n',
    ),
  ]);

  return {
    parent,
    pristineRoot,
    mutatedRoot,
    hostOnlyRoot,
    exposedRoot,
    subjectCommit,
    adapterRevisionPath,
    adapterConformanceReceiptPath,
    input: {
      pristineProjectRoot: pristineRoot,
      mutatedProjectRoot: mutatedRoot,
      expectedSubjectCommit: subjectCommit,
      publicTaskSpecPath: publicTaskPath,
      adapterPackageRoot: adapterRoot,
      adapterRevisionPath,
      adapterConformanceReceiptPath,
      mutationPath,
      evaluatorImplementationPath,
      evaluatorBundlePath,
      hostOnlyRoot,
      agentExposedRoots: [exposedRoot],
      createdAt: "2026-08-14T00:00:00.000Z",
    },
  };
};

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("prepareExternalHiddenFixAssignmentV1", () => {
  it("freezes actual identities and exposes only the public one-attempt task", async () => {
    const fixture = await createFixture();

    const prepared = await prepareExternalHiddenFixAssignmentV1(fixture.input);

    expect(prepared.assignment.subjectProjectSha256).toBe(
      prepared.pristineSource.projectSourceIdentity,
    );
    expect(prepared.assignment.pristineSelectedTreeSha256).toBe(
      prepared.pristineSource.selectedTreeSha256,
    );
    expect(prepared.assignment.mutatedBaselineSelectedTreeSha256).toBe(
      prepared.mutatedSource.selectedTreeSha256,
    );
    expect(prepared.assignment.taskBlindAdapterSha256).not.toBe(
      prepared.adapterPackage.candidateSha256,
    );
    expect(prepared.adapterConformanceReceipt.candidateDigest).not.toBe(
      prepared.adapterRevision.packageDigest,
    );
    const adapterRevisionBytes = await readFile(fixture.adapterRevisionPath);
    const adapterRevisionSha256 = sha(adapterRevisionBytes);
    const adapterConformanceReceiptSha256 = sha(
      await readFile(fixture.adapterConformanceReceiptPath),
    );
    expect(prepared.assignment.taskBlindAdapterSha256).toBe(
      sha(
        canonicalJson({
          schemaVersion: 1,
          adapterRevisionSha256,
          packageSha256: prepared.adapterPackage.candidateSha256,
          conformanceReceiptSha256: adapterConformanceReceiptSha256,
        }),
      ),
    );
    expect(prepared.assignment.baselineRoot).toBe(
      prepared.protectedBaselineRoot,
    );
    expect(prepared.assignment.baselineRoot).not.toBe(fixture.mutatedRoot);
    expect(
      await readTrustedSelectedTree(prepared.assignment.baselineRoot),
    ).toBe(prepared.mutatedSource.selectedTreeSha256);
    expect(await readdir(prepared.assignment.baselineRoot)).not.toContain(
      ".git",
    );
    await expect(
      access(join(prepared.assignment.baselineRoot, ".git")),
    ).rejects.toBeInstanceOf(Error);

    const projection = ExternalHiddenFixAgentAssignmentProjectionV1Schema.parse(
      prepared.agentProjection,
    );
    expect(projection.publicTask.spec).toMatchObject({
      taskId: "task:m6-moddable-platformer-hidden-fix-r1",
      subjectCommit: fixture.subjectCommit,
      publicExecutionClassifier: {
        classifierId: "moddable-platformer-public-symptom-v1",
        implementationSha256: sha("public classifier v1"),
      },
      agentBudget: {
        attemptsMaximum: 1,
        userTurnsPerAttemptMaximum: 1,
      },
      evaluatorBudget: {
        repetitionsPerScenario: 3,
        plannedRunCount: 9,
        agentRelaunchCountMaximum: 0,
      },
    });
    expect(projection.adapter).toMatchObject({
      packageSha256: prepared.adapterPackage.candidateSha256,
    });
    expect(projection.adapter.revisionSha256).toBe(adapterRevisionSha256);
    expect(projection.adapter.conformanceReceiptSha256).toBe(
      adapterConformanceReceiptSha256,
    );
    const serialized = JSON.stringify(projection);
    expect(serialized).not.toContain(fixture.hostOnlyRoot);
    expect(serialized).not.toContain(fixture.mutatedRoot);
    expect(serialized).not.toMatch(/mutation\.patch|evaluator\.mjs/u);
    expect(await readFile(prepared.assignment.mutationPath, "utf8")).toContain(
      "diff --git",
    );
  });

  it("rejects a wrong fixed subject commit before creating an assignment", async () => {
    const fixture = await createFixture();

    await expect(
      prepareExternalHiddenFixAssignmentV1({
        ...fixture.input,
        expectedSubjectCommit: "0".repeat(40),
      }),
    ).rejects.toThrow(/fixed subject commit/u);
  });

  it("rejects pretty-printed public task JSON under the default byte policy", async () => {
    const fixture = await createFixture();
    const prettyBytes = `${JSON.stringify(publicTask(fixture.subjectCommit), null, 2)}\n`;
    await writeFile(fixture.input.publicTaskSpecPath, prettyBytes);

    await expect(
      prepareExternalHiddenFixAssignmentV1(fixture.input),
    ).rejects.toThrow(/must be canonical JSON/u);
  });

  it("accepts a strict public task at its exact pre-frozen byte identity", async () => {
    const fixture = await createFixture();
    const task = publicTask(fixture.subjectCommit);
    const prettyBytes = `${JSON.stringify(task, null, 2)}\n`;
    await writeFile(fixture.input.publicTaskSpecPath, prettyBytes);
    const expectedSha256 = sha(prettyBytes);

    const prepared = await prepareExternalHiddenFixAssignmentV1({
      ...fixture.input,
      publicTaskSpecBytePolicy: {
        kind: "frozen-exact-v1",
        expectedSha256,
      },
    });

    expect(prepared.assignment.publicTaskSpecSha256).toBe(expectedSha256);
    expect(prepared.agentProjection.publicTask.sha256).toBe(expectedSha256);
    expect(prepared.agentProjection.publicTask.spec).toEqual(task);
  });

  it("rejects a frozen-exact public task when its raw digest differs", async () => {
    const fixture = await createFixture();
    const prettyBytes = `${JSON.stringify(publicTask(fixture.subjectCommit), null, 2)}\n`;
    await writeFile(fixture.input.publicTaskSpecPath, prettyBytes);

    await expect(
      prepareExternalHiddenFixAssignmentV1({
        ...fixture.input,
        publicTaskSpecBytePolicy: {
          kind: "frozen-exact-v1",
          expectedSha256: sha("different frozen bytes"),
        },
      }),
    ).rejects.toThrow(/frozen-exact public task specification digest/u);
  });

  it("rejects adapter provenance that names the mutated source", async () => {
    const fixture = await createFixture();
    const mutated = await preflightCleanProjectEnvironmentV1({
      projectPath: fixture.mutatedRoot,
      sourceRepositoryExclusionRoots: [
        fixture.hostOnlyRoot,
        fixture.exposedRoot,
      ],
      gdscriptPolicy: "tracked-tool-scripts-v1",
    });
    const raw = JSON.parse(
      await readFile(fixture.adapterRevisionPath, "utf8"),
    ) as Record<string, unknown>;
    raw.sourceId = `source:v1:${mutated.projectSourceIdentity}`;
    await writeFile(
      fixture.adapterRevisionPath,
      `${canonicalJson(raw as never)}\n`,
      { mode: 0o600 },
    );
    await chmod(fixture.adapterRevisionPath, 0o600);

    await expect(
      prepareExternalHiddenFixAssignmentV1(fixture.input),
    ).rejects.toThrow(/pristine-source provenance/u);
  });

  it("rejects a frozen conformance receipt detached from the Adapter package", async () => {
    const fixture = await createFixture();
    const raw = JSON.parse(
      await readFile(fixture.adapterConformanceReceiptPath, "utf8"),
    ) as Record<string, unknown>;
    raw.candidateDigest = sha("different adapter package");
    await writeFile(
      fixture.adapterConformanceReceiptPath,
      `${canonicalJson(raw as never)}\n`,
      { mode: 0o600 },
    );
    await chmod(fixture.adapterConformanceReceiptPath, 0o600);

    await expect(
      prepareExternalHiddenFixAssignmentV1(fixture.input),
    ).rejects.toThrow(/pristine-source provenance/u);
  });

  it("rejects the loader package identity in the conformance content-digest slot", async () => {
    const fixture = await createFixture();
    const revision = ProjectAdapterRevisionV1Schema.parse(
      JSON.parse(await readFile(fixture.adapterRevisionPath, "utf8")),
    );
    const raw = JSON.parse(
      await readFile(fixture.adapterConformanceReceiptPath, "utf8"),
    ) as Record<string, unknown>;
    raw.candidateDigest = revision.packageDigest;
    await writeFile(
      fixture.adapterConformanceReceiptPath,
      `${canonicalJson(raw as never)}\n`,
      { mode: 0o600 },
    );
    await chmod(fixture.adapterConformanceReceiptPath, 0o600);

    await expect(
      prepareExternalHiddenFixAssignmentV1(fixture.input),
    ).rejects.toThrow(/pristine-source provenance/u);
  });

  it("rejects a hidden patch that does not reproduce the frozen mutant", async () => {
    const fixture = await createFixture();
    await writeFile(
      fixture.input.mutationPath,
      "diff --git a/player.gd b/player.gd\n--- a/player.gd\n+++ b/player.gd\n@@ -1,3 +1,3 @@\n @tool\n extends Node\n-var speed := 10\n+var speed := 20\n",
      { mode: 0o600 },
    );
    await chmod(fixture.input.mutationPath, 0o600);

    await expect(
      prepareExternalHiddenFixAssignmentV1(fixture.input),
    ).rejects.toThrow(/does not reproduce the frozen mutated source tree/u);
  });

  it("rejects public specs that weaken the single-attempt 3x3 Gate", async () => {
    const fixture = await createFixture();
    const taskPath = fixture.input.publicTaskSpecPath;
    const raw = JSON.parse(await readFile(taskPath, "utf8")) as {
      agentBudget: { attemptsMaximum: number };
      evaluatorBudget: { plannedRunCount: number };
    };
    raw.agentBudget.attemptsMaximum = 2;
    raw.evaluatorBudget.plannedRunCount = 8;
    await writeFile(taskPath, `${canonicalJson(raw as never)}\n`);

    await expect(
      prepareExternalHiddenFixAssignmentV1(fixture.input),
    ).rejects.toBeInstanceOf(Error);
  });
});
