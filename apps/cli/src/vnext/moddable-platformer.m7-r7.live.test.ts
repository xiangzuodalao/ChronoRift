import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { JsonValueSchema, type Sha256DigestV1 } from "@chronorift/domain";
import { canonicalJson } from "@chronorift/json-artifacts";
import { describe, it } from "vitest";

import type { ExternalHiddenFixEvaluatorHeadroomObserverV1 } from "./external-hidden-fix-evaluator.js";
import {
  M7R4FormalOuterFailureReceiptV1Schema,
  prepareM7R4FreshTwoCaseDesignV1,
  runM7R4FormalLiveV1,
  runM7R4PreAgentDryRunV1,
  type M7R4FormalOuterFailureReceiptV1,
} from "./m7-r4-formal-live.js";
import { verifyM7R4LiveMaterialsV1 } from "./m7-r4-live-materials.js";
import {
  runAndRetainM7R4NoAgentPreflightOnceV1,
  runM7R4NoAgentLivePreflightForDesignV1,
} from "./m7-r4-no-agent-live.js";
import { openM7R4NoAgentPreflightAttemptStoreV1 } from "./m7-r4-no-agent-preflight-attempt.js";
import {
  collectM7R7FormalEvidenceManifestV1,
  persistM7R7FormalEvidenceManifestOnceV1,
} from "./m7-r7-formal-evidence.js";
import { openM7R7PreflightEvidenceStoreV1 } from "./m7-r7-preflight-evidence.js";
import { publishM7R7PrivateFileOnceV1 } from "./m7-r7-private-publication.js";

const R4_PROTOCOL_ENVIRONMENT_SUFFIXES = Object.freeze([
  "PUBLIC_ROOT",
  "STATIC_HOST_ONLY_ROOT",
  "CONSTRUCTION_ROOT",
  "SENSOR_ROOT",
  "PRIVATE_ROOT",
  "RUNS_ROOT",
  "MANIFEST",
  "CASE_01_PRISTINE",
  "CASE_01_MUTANT",
  "CASE_02_PRISTINE",
  "CASE_02_MUTANT",
  "ADAPTER_PACKAGE",
  "ADAPTER_REVISION",
  "ADAPTER_CONFORMANCE",
  "SENSOR_FREEZE",
  "CLASSIFIER_IMPLEMENTATION",
  "PAIRED_AGENT_IMPLEMENTATION",
  "PREPARATION_IMPLEMENTATION",
  "CASE_PREFLIGHT_RUNNER",
  "PREFLIGHT_IMPLEMENTATION",
  "PREFLIGHT_ATTEMPT_RETENTION_IMPLEMENTATION",
  "FORMAL_DRIVER_IMPLEMENTATION",
  "LIVE_MATERIALS_IMPLEMENTATION",
  "NO_AGENT_LIVE_IMPLEMENTATION",
  "GAME_RUNTIME_IMPLEMENTATION",
  "WIRE_CLIENT_IMPLEMENTATION",
  "PREFLIGHT_IMPLEMENTATION_MANIFEST",
  "HOST_CONFIG",
  "OPERATIONAL_CONFIG_ROOT",
  "PREFLIGHT_CONTROL_ROOT",
  "CONTAINER_ENTRYPOINT",
  "RUN_WRAPPER",
  "STATIC_ADMISSION",
  "RUN_CONTROL",
  "LIVE_TEST_CONFIG",
  "LIVE_COMPOSER",
  "OPERATIONAL_CONFIG_COMPOSER",
  "CASE_01_NO_AGENT_HOST_CONFIG",
  "CASE_02_NO_AGENT_HOST_CONFIG",
] as const);

const requiredAbsoluteEnvironment = (name: string): string => {
  const value = process.env[name];
  if (
    value === undefined ||
    value.length === 0 ||
    !isAbsolute(value) ||
    resolve(value) !== value
  ) {
    throw new Error(`${name} must be a normalized absolute path`);
  }
  return value;
};

const installM7R7ProtocolCompatibilityV1 = (): {
  readonly mode: "pre-agent-dry-run" | "no-agent-preflight" | "r7-live";
} => {
  const mode = process.env.CHRONORIFT_M7_R7_MODE;
  if (
    mode !== "pre-agent-dry-run" &&
    mode !== "no-agent-preflight" &&
    mode !== "r7-live"
  ) {
    throw new Error("M7 R7 composer received an invalid operator mode");
  }
  for (const name of Object.keys(process.env)) {
    if (name.startsWith("CHRONORIFT_TEST_M7_R4_")) {
      delete process.env[name];
    }
  }
  if (R4_PROTOCOL_ENVIRONMENT_SUFFIXES.length !== 39) {
    throw new Error("M7 R7 protocol environment whitelist changed");
  }
  for (const suffix of R4_PROTOCOL_ENVIRONMENT_SUFFIXES) {
    const value = process.env[`CHRONORIFT_TEST_M7_R7_${suffix}`];
    if (value === undefined || value.length === 0) {
      throw new Error(`M7 R7 composer is missing protocol input ${suffix}`);
    }
    process.env[`CHRONORIFT_TEST_M7_R4_${suffix}`] = value;
  }
  process.env.CHRONORIFT_M7_R4_LIVE_MODE =
    mode === "r7-live" ? "r4-live" : mode;
  return Object.freeze({ mode });
};

const monotonicNow = (): (() => string) => {
  let previous = Date.now() - 1;
  return () => {
    previous = Math.max(Date.now(), previous + 1);
    return new Date(previous).toISOString();
  };
};

const persistFormalOuterFailureOnce = async (input: {
  readonly runsRoot: string;
  readonly receipt: M7R4FormalOuterFailureReceiptV1;
}): Promise<Sha256DigestV1> => {
  const receipt = M7R4FormalOuterFailureReceiptV1Schema.parse(input.receipt);
  const root = resolve(input.runsRoot, "run-control");
  const path = resolve(root, "m7-r4.formal-outer-failure.json");
  if (
    root !== join(input.runsRoot, "run-control") ||
    path !== join(root, "m7-r4.formal-outer-failure.json")
  ) {
    throw new Error("R7 formal outer failure path escaped run control");
  }
  const [rootMetadata, canonicalRoot] = await Promise.all([
    lstat(root),
    realpath(root),
  ]);
  if (
    !rootMetadata.isDirectory() ||
    rootMetadata.isSymbolicLink() ||
    rootMetadata.uid !== process.geteuid?.() ||
    (rootMetadata.mode & 0o7777) !== 0o700 ||
    canonicalRoot !== root
  ) {
    throw new Error("R7 formal run-control root must be private");
  }
  const bytes = Buffer.from(
    `${canonicalJson(JsonValueSchema.parse(receipt))}\n`,
    "utf8",
  );
  await publishM7R7PrivateFileOnceV1({
    root,
    filename: "m7-r4.formal-outer-failure.json",
    bytes,
  });
  if (path !== join(root, "m7-r4.formal-outer-failure.json")) {
    throw new Error("R7 formal outer failure publication changed path");
  }
  return receipt.recordContentSha256;
};

const assertR7SpecificRoots = (
  runsRoot: string,
): {
  readonly formalEvidencePath: string;
  readonly preflightEvidenceRoots: readonly [string, string];
} => {
  const formalEvidencePath = requiredAbsoluteEnvironment(
    "CHRONORIFT_TEST_M7_R7_FORMAL_EVIDENCE_PATH",
  );
  const preflightEvidenceRoots = Object.freeze([
    requiredAbsoluteEnvironment(
      "CHRONORIFT_TEST_M7_R7_CASE_01_PREFLIGHT_EVIDENCE_ROOT",
    ),
    requiredAbsoluteEnvironment(
      "CHRONORIFT_TEST_M7_R7_CASE_02_PREFLIGHT_EVIDENCE_ROOT",
    ),
  ] as const);
  const expected = {
    formalEvidencePath: join(
      runsRoot,
      "run-control",
      "formal-evidence-manifest.v1.json",
    ),
    preflightEvidenceRoots: [
      join(runsRoot, "preflight-evidence", "case-01"),
      join(runsRoot, "preflight-evidence", "case-02"),
    ],
    evaluatorRoots: [
      join(runsRoot, "evaluator-temp", "case-01", "runtime-enabled"),
      join(runsRoot, "evaluator-temp", "case-01", "code-only"),
      join(runsRoot, "evaluator-temp", "case-02", "runtime-enabled"),
      join(runsRoot, "evaluator-temp", "case-02", "code-only"),
    ],
  } as const;
  const evaluatorRoots = [
    requiredAbsoluteEnvironment(
      "CHRONORIFT_TEST_M7_R7_CASE_01_RUNTIME_EVALUATOR_TEMP_ROOT",
    ),
    requiredAbsoluteEnvironment(
      "CHRONORIFT_TEST_M7_R7_CASE_01_CODE_ONLY_EVALUATOR_TEMP_ROOT",
    ),
    requiredAbsoluteEnvironment(
      "CHRONORIFT_TEST_M7_R7_CASE_02_RUNTIME_EVALUATOR_TEMP_ROOT",
    ),
    requiredAbsoluteEnvironment(
      "CHRONORIFT_TEST_M7_R7_CASE_02_CODE_ONLY_EVALUATOR_TEMP_ROOT",
    ),
  ];
  if (
    formalEvidencePath !== expected.formalEvidencePath ||
    preflightEvidenceRoots.some(
      (candidate, index) =>
        candidate !== expected.preflightEvidenceRoots[index],
    ) ||
    evaluatorRoots.some(
      (candidate, index) => candidate !== expected.evaluatorRoots[index],
    )
  ) {
    throw new Error("R7 evidence or evaluator roots crossed the run namespace");
  }
  return Object.freeze({ formalEvidencePath, preflightEvidenceRoots });
};

const selected = installM7R7ProtocolCompatibilityV1();

const persistDryEvidenceOnce = async (
  runsRoot: string,
  terminal: unknown,
): Promise<void> => {
  const path = requiredAbsoluteEnvironment(
    "CHRONORIFT_TEST_M7_R7_DRY_EVIDENCE_PATH",
  );
  const expected = join(runsRoot, "run-control/dry-stage-evidence.v1.json");
  if (path !== expected || dirname(path) !== join(runsRoot, "run-control")) {
    throw new Error("R7 dry evidence crossed its retained run root");
  }
  const basis = {
    schemaVersion: 1,
    recordKind: "m7-r7-dry-stage-evidence",
    terminal: JsonValueSchema.parse(terminal),
  } as const;
  const canonicalBasis = JsonValueSchema.parse(basis);
  const record = JsonValueSchema.parse({
    ...basis,
    recordContentSha256: createHash("sha256")
      .update(canonicalJson(canonicalBasis))
      .digest("hex"),
  });
  await publishM7R7PrivateFileOnceV1({
    root: dirname(path),
    filename: "dry-stage-evidence.v1.json",
    bytes: Buffer.from(`${canonicalJson(record)}\n`, "utf8"),
  });
  const retained = await readFile(path);
  if (!retained.equals(Buffer.from(`${canonicalJson(record)}\n`, "utf8"))) {
    throw new Error("R7 dry evidence changed after publication");
  }
};

describe("M7 R7 moddable-platformer infrastructure-hardened portfolio", () => {
  it(
    "runs only the selected R7 operator mode",
    { timeout: 10_800_000 },
    async () => {
      const live = await verifyM7R4LiveMaterialsV1();
      const now = monotonicNow();
      const r7Roots = assertR7SpecificRoots(live.runsRoot);
      if (selected.mode === "pre-agent-dry-run") {
        const terminal = await runM7R4PreAgentDryRunV1({ live, now });
        await persistDryEvidenceOnce(live.runsRoot, terminal);
        process.stdout.write(
          `${canonicalJson(JsonValueSchema.parse(terminal))}\n`,
        );
        return;
      }

      const preflightEvidencePersistence = Object.freeze([
        await openM7R7PreflightEvidenceStoreV1({
          root: r7Roots.preflightEvidenceRoots[0],
          ordinal: 1,
        }),
        await openM7R7PreflightEvidenceStoreV1({
          root: r7Roots.preflightEvidenceRoots[1],
          ordinal: 2,
        }),
      ] as const);
      const preflightEvaluatorHeadroomObservers = Object.freeze([
        (observation) =>
          preflightEvidencePersistence[0].persistEvaluatorHeadroomOnce({
            taskId: "task:m7-r4:no-agent-evaluator:case-01",
            observation,
          }),
        (observation) =>
          preflightEvidencePersistence[1].persistEvaluatorHeadroomOnce({
            taskId: "task:m7-r4:no-agent-evaluator:case-02",
            observation,
          }),
      ] as const satisfies readonly [
        ExternalHiddenFixEvaluatorHeadroomObserverV1,
        ExternalHiddenFixEvaluatorHeadroomObserverV1,
      ]);
      const attemptStore = await openM7R4NoAgentPreflightAttemptStoreV1({
        root: live.preflightAttemptRoot,
        exposedRoots: [live.publicRoot, live.hostConfig.taskStorageRoot],
      });

      if (selected.mode === "r7-live") {
        const completed = await runM7R4FormalLiveV1({
          live,
          preflightAttemptStore: attemptStore,
          preflightEvidencePersistence,
          preflightEvaluatorHeadroomObservers,
          persistOuterFailureOnce: (receipt) =>
            persistFormalOuterFailureOnce({
              runsRoot: live.runsRoot,
              receipt,
            }),
          now,
        });
        const manifest = await collectM7R7FormalEvidenceManifestV1({
          runsRoot: live.runsRoot,
          constructionRoot: live.constructionRoot,
          portfolio: completed.portfolio,
          preflightTerminalRecordSha256:
            completed.preflightTerminal.recordContentSha256,
          sealedAt: now(),
        });
        const retained = await persistM7R7FormalEvidenceManifestOnceV1({
          controlRoot: join(live.runsRoot, "run-control"),
          manifest,
        });
        if (
          r7Roots.formalEvidencePath !==
            join(
              live.runsRoot,
              "run-control",
              "formal-evidence-manifest.v1.json",
            ) ||
          retained.recordContentSha256 !== manifest.recordContentSha256
        ) {
          throw new Error("R7 formal evidence persistence changed identity");
        }
        process.stdout.write(
          `${canonicalJson(JsonValueSchema.parse(completed.preflightTerminal))}\n`,
        );
        return;
      }

      const design = await prepareM7R4FreshTwoCaseDesignV1({ live, now });
      let retained:
        | Awaited<ReturnType<typeof runAndRetainM7R4NoAgentPreflightOnceV1>>
        | undefined;
      let primaryFailure: unknown;
      try {
        retained = await runAndRetainM7R4NoAgentPreflightOnceV1({
          portfolioFreeze: design.expectedPortfolio,
          attemptStore,
          run: async () => {
            const portfolioFreeze =
              await design.portfolioStore.createPortfolioOnce(
                design.portfolioFreezeInput,
              );
            return runM7R4NoAgentLivePreflightForDesignV1({
              live,
              design,
              portfolioFreeze,
              evidencePersistence: preflightEvidencePersistence,
              evaluatorHeadroomObservers: preflightEvaluatorHeadroomObservers,
              now,
            });
          },
          beforePassedTerminal: async () => {
            const cleanup = await design.cleanup();
            if (!cleanup.cleanupProven || cleanup.sandboxSafetyFailure) {
              throw new Error(
                cleanup.sandboxSafetyFailure
                  ? "R7 no-Agent phase-one sandbox safety failure"
                  : "R7 no-Agent phase-one cleanup was not proven",
              );
            }
          },
          now,
        });
      } catch (error) {
        primaryFailure = error;
      }
      let cleanupFailure: unknown;
      try {
        const cleanup = await design.cleanup();
        if (!cleanup.cleanupProven || cleanup.sandboxSafetyFailure) {
          cleanupFailure = new Error(
            cleanup.sandboxSafetyFailure
              ? "R7 no-Agent phase-one sandbox safety failure"
              : "R7 no-Agent phase-one cleanup was not proven",
          );
        }
      } catch (error) {
        cleanupFailure = error;
      }
      if (primaryFailure !== undefined || cleanupFailure !== undefined) {
        throw primaryFailure !== undefined && cleanupFailure !== undefined
          ? new AggregateError(
              [primaryFailure, cleanupFailure],
              "R7 no-Agent preflight and phase-one cleanup failed",
            )
          : (primaryFailure ?? cleanupFailure);
      }
      if (retained === undefined) {
        throw new Error("R7 no-Agent attempt returned no retained result");
      }
      process.stdout.write(
        `${canonicalJson(JsonValueSchema.parse(retained.terminal))}\n`,
      );
    },
  );
});
