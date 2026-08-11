import { execFile } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const validatorPath = resolve(".github/scripts/validate-vnext-e2-freeze.mjs");
const recordPath = resolve(
  "docs/evidence/vnext-e2-public-exposed-r1/freeze-record.v1.json",
);
const contractPath = resolve(
  "testdata/vnext/external-project/moddable-platformer.e2-evaluation-contract.v1.json",
);
const interfacePath = resolve(
  "testdata/vnext/external-project/e2-evaluator-interface.schema.v1.json",
);
const m4Path = resolve(
  "docs/evidence/vnext-e2-public-exposed-r1/chronorift-m4-external-project-evidence.json",
);
const e2Path = resolve(
  "docs/evidence/vnext-e2-public-exposed-r1/chronorift-e2-external-semantic-evidence.json",
);
const freezeTagName = "vnext-e2-public-exposed-conformance-r2-freeze";
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, {
        recursive: true,
        force: true,
      }),
    ),
  );
});

const validatorEnvironment = (): NodeJS.ProcessEnv => {
  const environment = { ...process.env };
  delete environment["GITHUB_EVENT_NAME"];
  delete environment["GITHUB_REF"];
  delete environment["GITHUB_REF_NAME"];
  delete environment["GITHUB_REF_TYPE"];
  return environment;
};

const run = async (
  overrides: {
    readonly recordPath?: string;
    readonly contractPath?: string;
    readonly interfacePath?: string;
    readonly e2Path?: string;
    readonly environment?: NodeJS.ProcessEnv;
    readonly cwd?: string;
    readonly validatorPath?: string;
  } = {},
) =>
  execFileAsync(
    process.execPath,
    [
      overrides.validatorPath ?? validatorPath,
      overrides.recordPath ?? recordPath,
      overrides.contractPath ?? contractPath,
      overrides.interfacePath ?? interfacePath,
      m4Path,
      overrides.e2Path ?? e2Path,
    ],
    {
      cwd: overrides.cwd ?? process.cwd(),
      encoding: "utf8",
      env: { ...validatorEnvironment(), ...overrides.environment },
    },
  );

type TemporaryRepository = {
  readonly root: string;
  readonly validatorPath: string;
};

const git = async (cwd: string, arguments_: readonly string[]) =>
  execFileAsync("git", [...arguments_], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
  });

const temporaryRepository = async (): Promise<TemporaryRepository> => {
  const root = await mkdtemp(join(tmpdir(), "chronorift-e2-freeze-git-"));
  temporaryRoots.push(root);
  const repository = join(root, "repository");
  await execFileAsync(
    "git",
    [
      "clone",
      "--quiet",
      "--no-hardlinks",
      "--no-tags",
      process.cwd(),
      repository,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
    },
  );
  await git(repository, ["config", "user.name", "ChronoRift test"]);
  await git(repository, ["config", "user.email", "chronorift-test.invalid"]);
  const isolatedValidatorPath = join(
    repository,
    ".github/scripts/validate-vnext-e2-freeze.mjs",
  );
  await mkdir(resolve(isolatedValidatorPath, ".."), { recursive: true });
  await copyFile(validatorPath, isolatedValidatorPath);
  return { root: repository, validatorPath: isolatedValidatorPath };
};

const targetTagEnvironment = {
  GITHUB_REF_TYPE: "tag",
  GITHUB_REF_NAME: freezeTagName,
  GITHUB_REF: `refs/tags/${freezeTagName}`,
};

const mutatedJson = async (
  sourcePath: string,
  mutate: (value: Record<string, unknown>) => void,
): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "chronorift-e2-freeze-"));
  temporaryRoots.push(root);
  const value = JSON.parse(await readFile(sourcePath, "utf8")) as Record<
    string,
    unknown
  >;
  mutate(value);
  const target = join(root, "mutated.json");
  await writeFile(target, `${JSON.stringify(value)}\n`, "utf8");
  return target;
};

const failureText = async (
  promise: ReturnType<typeof run>,
): Promise<string> => {
  const failure: unknown = await promise.catch((error: unknown) => error);
  return String(
    typeof failure === "object" && failure !== null && "stderr" in failure
      ? failure.stderr
      : failure,
  );
};

describe("vNext E2 post-Gate freeze validator", () => {
  it("binds the product, adapter, budgets, evaluator interface, and evidence", async () => {
    await expect(run()).resolves.toMatchObject({
      stdout:
        '[chronorift-e2-freeze] {"schemaVersion":1,"anchorMode":"working_tree"}\n',
      stderr: "",
    });
  });

  it("rejects budget drift and evaluator-interface drift", async () => {
    const changedBudget = await mutatedJson(contractPath, (value) => {
      const budget = value["agentBudget"] as Record<string, unknown>;
      budget["gameToolCallsPerAttemptMaximum"] = 65;
    });
    expect(await failureText(run({ contractPath: changedBudget }))).toContain(
      "Agent budget does not equal its frozen value",
    );

    const widenedInterface = await mutatedJson(interfacePath, (value) => {
      value["additionalProperties"] = true;
    });
    expect(
      await failureText(run({ interfacePath: widenedInterface })),
    ).toContain("evaluator interface bytes does not equal its frozen value");
  });

  it("rejects evidence that no longer proves sealed executions", async () => {
    const unsealedEvidence = await mutatedJson(e2Path, (value) => {
      value["allExecutionsSealed"] = false;
    });
    expect(await failureText(run({ e2Path: unsealedEvidence }))).toContain(
      "E2 evidence bytes",
    );
  });

  it("rejects duplicate JSON object keys", async () => {
    const root = await mkdtemp(join(tmpdir(), "chronorift-e2-freeze-"));
    temporaryRoots.push(root);
    const duplicateRecord = join(root, "duplicate-record.json");
    const text = await readFile(recordPath, "utf8");
    await writeFile(
      duplicateRecord,
      text.replace(
        '"schemaVersion": 1',
        '"schemaVersion": 1, "schemaVersion": 1',
      ),
      "utf8",
    );
    expect(await failureText(run({ recordPath: duplicateRecord }))).toContain(
      "freeze record contains duplicate object key schemaVersion",
    );
  });

  it("rejects unknown freeze-validation plumbing fields", async () => {
    const widenedRecord = await mutatedJson(recordPath, (value) => {
      const plumbing = value["freezeValidationPlumbing"] as Record<
        string,
        unknown
      >;
      plumbing["unreviewedValidator"] = "enabled";
    });
    expect(await failureText(run({ recordPath: widenedRecord }))).toContain(
      "freeze-validation plumbing contains a missing or unknown field",
    );
  });

  it("does not hijack an unrelated tag push", async () => {
    await expect(
      run({
        environment: {
          GITHUB_REF_TYPE: "tag",
          GITHUB_REF_NAME: "unrelated-release",
        },
      }),
    ).resolves.toMatchObject({
      stdout:
        '[chronorift-e2-freeze] {"schemaVersion":1,"anchorMode":"working_tree"}\n',
      stderr: "",
    });
  });

  it("requires the target tag to exist on its tag push", async () => {
    const repository = await temporaryRepository();
    expect(
      await failureText(
        run({
          cwd: repository.root,
          validatorPath: repository.validatorPath,
          environment: targetTagEnvironment,
        }),
      ),
    ).toContain("freeze anchor tag is missing");
  });

  it("rejects a lightweight target tag", async () => {
    const repository = await temporaryRepository();
    await git(repository.root, ["tag", freezeTagName, "HEAD"]);
    expect(
      await failureText(
        run({
          cwd: repository.root,
          validatorPath: repository.validatorPath,
          environment: targetTagEnvironment,
        }),
      ),
    ).toContain("freeze anchor must be an annotated tag object");
  });

  it("rejects an annotated target tag that does not target checkout", async () => {
    const repository = await temporaryRepository();
    const previousCommit = (
      await git(repository.root, ["rev-parse", "HEAD"])
    ).stdout.trim();
    await git(repository.root, [
      "commit",
      "--allow-empty",
      "--quiet",
      "-m",
      "freeze commit",
    ]);
    await git(repository.root, [
      "tag",
      "--annotate",
      freezeTagName,
      "--message",
      "wrong target",
      previousCommit,
    ]);
    expect(
      await failureText(
        run({
          cwd: repository.root,
          validatorPath: repository.validatorPath,
          environment: targetTagEnvironment,
        }),
      ),
    ).toContain("freeze anchor does not target the checked-out commit");
  });

  it("accepts an annotated target and continues with anchored bytes", async () => {
    const repository = await temporaryRepository();
    const frozenRecordPath = join(
      repository.root,
      "docs/evidence/vnext-e2-public-exposed-r1/freeze-record.v1.json",
    );
    await mkdir(resolve(frozenRecordPath, ".."), { recursive: true });
    await copyFile(recordPath, frozenRecordPath);
    const workflowPath = join(repository.root, ".github/workflows/ci.yml");
    const workflow = await readFile(workflowPath, "utf8");
    await writeFile(workflowPath, `${workflow}\n# anchored-byte-test-drift\n`);
    await git(repository.root, ["add", frozenRecordPath, workflowPath]);
    await git(repository.root, [
      "commit",
      "--allow-empty",
      "--quiet",
      "-m",
      "freeze record",
    ]);
    await git(repository.root, [
      "tag",
      "--annotate",
      freezeTagName,
      "--message",
      "freeze",
      "HEAD",
    ]);
    const failure = await failureText(
      run({
        cwd: repository.root,
        validatorPath: repository.validatorPath,
        environment: targetTagEnvironment,
      }),
    );
    expect(failure).not.toContain("freeze anchor");
    expect(failure).toContain("freeze-validation workflow bytes");
  });
});
