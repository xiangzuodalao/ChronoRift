import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { PiHarnessError, PiProviderFailureError } from "@chronorift/pi-harness";
import { describe, expect, it } from "vitest";

import {
  classifyCanaryLiveFailure,
  classifyCanaryLiveFailureDetails,
  createCanaryImplementationReceipt,
} from "./v03-canary-live.js";

const execFileAsync = promisify(execFile);

const progress = (outputObserved: boolean) => ({
  sequence: outputObserved ? 2 : 0,
  fixtureValidated: outputObserved,
  model: {
    requestStarted: outputObserved,
    outputObserved,
    turnCompleted: false,
  },
  tools: {
    started: outputObserved ? 1 : 0,
    completed: outputObserved ? 1 : 0,
    failed: 0,
    semanticRevision: outputObserved ? 1 : 0,
    consecutiveNonProgressToolResults: 0,
  },
  game: { baselineExecutions: outputObserved ? 1 : 0, diagnosticExecutions: 0 },
  proposalSubmitted: false,
});

describe("Luna canary live failure classification", () => {
  it("preserves a typed provider cause ahead of a harness wrapper", () => {
    const provider = new PiProviderFailureError("redacted provider failure", {
      phase: "response_stream",
      code: "http_429",
      httpStatus: 429,
      retryClass: "transient",
    });
    const wrapper = new PiHarnessError(
      "PROPOSAL_MISSING",
      "Pi did not submit a proposal",
      { cause: provider },
    );

    expect(classifyCanaryLiveFailure(wrapper)).toBe("http_429");
    expect(classifyCanaryLiveFailureDetails(wrapper, progress(true))).toEqual({
      kind: "infrastructure",
      code: "http_429",
      providerFailure: {
        phase: "response_stream",
        code: "http_429",
        httpStatus: 429,
        retryClass: "transient",
      },
    });
  });

  it("separates permanent provider failures and progressed timeouts", () => {
    expect(
      classifyCanaryLiveFailureDetails(
        new PiProviderFailureError("redacted", {
          phase: "request",
          code: "auth",
          httpStatus: 401,
          retryClass: "permanent",
        }),
        progress(false),
      ),
    ).toEqual({
      kind: "invalid",
      code: "auth",
      providerFailure: {
        phase: "request",
        code: "auth",
        httpStatus: 401,
        retryClass: "permanent",
      },
    });
    expect(
      classifyCanaryLiveFailureDetails(
        new PiHarnessError("AGENT_TIMEOUT", "Timed out"),
        progress(false),
      ),
    ).toEqual({
      kind: "infrastructure",
      code: "timeout",
      providerFailure: null,
    });
    expect(
      classifyCanaryLiveFailureDetails(
        new PiHarnessError("AGENT_TIMEOUT", "Timed out"),
        progress(true),
      ),
    ).toEqual({
      kind: "diagnostic",
      code: "progress_timeout",
      providerFailure: null,
    });
  });

  it("does not infer connection failure from legacy error prose", () => {
    expect(
      classifyCanaryLiveFailure(
        new PiHarnessError("PROPOSAL_MISSING", "Connection error."),
      ),
    ).toBe("proposal_missing");
  });

  it("binds participating package manifests and TypeScript runtime configs", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "chronorift-canary-receipt-"));
    const sourceFiles = [
      "apps/cli/src/index.ts",
      "packages/domain/src/index.ts",
      "packages/gamebranch/src/index.ts",
      "packages/godot-adapter/src/index.ts",
      "packages/godot-protocol/src/index.ts",
      "packages/json-artifacts/src/index.ts",
      "packages/mock-game/src/index.ts",
      "packages/pi-harness/src/index.ts",
      "godot/addons/chronorift/probe.gd",
      "fixtures/fixture.gd",
    ];
    const implementationFiles = [
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "tsconfig.base.json",
      "tsconfig.json",
      "apps/cli/package.json",
      "apps/cli/tsconfig.json",
      "packages/domain/package.json",
      "packages/domain/tsconfig.json",
      "packages/gamebranch/package.json",
      "packages/gamebranch/tsconfig.json",
      "packages/godot-adapter/package.json",
      "packages/godot-adapter/tsconfig.json",
      "packages/godot-protocol/package.json",
      "packages/godot-protocol/tsconfig.json",
      "packages/json-artifacts/package.json",
      "packages/json-artifacts/tsconfig.json",
      "packages/mock-game/package.json",
      "packages/mock-game/tsconfig.json",
      "packages/pi-harness/package.json",
      "packages/pi-harness/tsconfig.json",
    ];
    for (const path of [...sourceFiles, ...implementationFiles]) {
      const target = join(cwd, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, `${path}\n`, "utf8");
    }
    await execFileAsync("git", ["init", "--quiet"], { cwd });
    await execFileAsync("git", ["add", "."], { cwd });
    await execFileAsync(
      "git",
      [
        "-c",
        "user.name=ChronoRift Test",
        "-c",
        "user.email=chronorift@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "fixture",
      ],
      { cwd },
    );

    const baseline = await createCanaryImplementationReceipt(cwd);
    expect(baseline.sourceWorktreeDirty).toBe(false);

    await writeFile(
      join(cwd, "packages/pi-harness/package.json"),
      '{"exports":{".":"./src/alternate.ts"}}\n',
      "utf8",
    );
    const manifestChanged = await createCanaryImplementationReceipt(cwd);
    expect(manifestChanged.sourceHash).not.toBe(baseline.sourceHash);
    expect(manifestChanged.sourceWorktreeDirty).toBe(true);

    await writeFile(
      join(cwd, "apps/cli/tsconfig.json"),
      '{"compilerOptions":{"module":"CommonJS"}}\n',
      "utf8",
    );
    const configChanged = await createCanaryImplementationReceipt(cwd);
    expect(configChanged.sourceHash).not.toBe(manifestChanged.sourceHash);
  });
});
