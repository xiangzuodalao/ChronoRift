import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";

import { JsonValueSchema } from "@chronorift/domain";
import { canonicalJson } from "@chronorift/json-artifacts";
import { describe, it } from "vitest";

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
}) => {
  const receipt = M7R4FormalOuterFailureReceiptV1Schema.parse(input.receipt);
  const root = resolve(input.runsRoot, "run-control");
  const path = resolve(root, "m7-r4.formal-outer-failure.json");
  if (
    root !== join(input.runsRoot, "run-control") ||
    path !== join(root, "m7-r4.formal-outer-failure.json")
  ) {
    throw new Error("R4 formal outer failure path escaped run control");
  }
  const rootMetadata = await lstat(root);
  if (
    !rootMetadata.isDirectory() ||
    rootMetadata.isSymbolicLink() ||
    rootMetadata.uid !== process.geteuid?.() ||
    (rootMetadata.mode & 0o7777) !== 0o700 ||
    (await realpath(root)) !== root
  ) {
    throw new Error(
      "R4 formal run-control root must be canonical, owned, and mode 0700",
    );
  }
  const bytes = Buffer.from(
    `${canonicalJson(JsonValueSchema.parse(receipt))}\n`,
    "utf8",
  );
  const handle = await open(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    let offset = 0;
    while (offset < bytes.byteLength) {
      const { bytesWritten } = await handle.write(
        bytes,
        offset,
        bytes.byteLength - offset,
        offset,
      );
      if (bytesWritten === 0) {
        throw new Error("R4 formal outer failure write made no progress");
      }
      offset += bytesWritten;
    }
    await handle.sync();
    const [opened, linked, canonical] = await Promise.all([
      handle.stat(),
      lstat(path),
      realpath(path),
    ]);
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.uid !== process.geteuid?.() ||
      (opened.mode & 0o7777) !== 0o600 ||
      opened.size !== bytes.byteLength ||
      linked.isSymbolicLink() ||
      linked.dev !== opened.dev ||
      linked.ino !== opened.ino ||
      linked.nlink !== 1 ||
      canonical !== path
    ) {
      throw new Error(
        "R4 formal outer failure must remain a canonical one-link owned mode-0600 file",
      );
    }
  } finally {
    await handle.close();
  }
  const rootHandle = await open(
    root,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await rootHandle.sync();
  } finally {
    await rootHandle.close();
  }
  return receipt.recordContentSha256;
};

describe("M7 R4 moddable-platformer runtime-use portfolio", () => {
  it(
    "runs only the selected R4 operator mode",
    { timeout: 10_800_000 },
    async () => {
      const live = await verifyM7R4LiveMaterialsV1();
      const now = monotonicNow();
      if (live.mode === "pre-agent-dry-run") {
        const terminal = await runM7R4PreAgentDryRunV1({ live, now });
        process.stdout.write(
          `${canonicalJson(JsonValueSchema.parse(terminal))}\n`,
        );
        return;
      }
      const exposedRoots = [live.publicRoot, live.hostConfig.taskStorageRoot];
      const attemptStore = await openM7R4NoAgentPreflightAttemptStoreV1({
        root: live.preflightAttemptRoot,
        exposedRoots,
      });
      if (live.mode === "r4-live") {
        const completed = await runM7R4FormalLiveV1({
          live,
          preflightAttemptStore: attemptStore,
          persistOuterFailureOnce: (receipt) =>
            persistFormalOuterFailureOnce({
              runsRoot: live.runsRoot,
              receipt,
            }),
          now,
        });
        process.stdout.write(
          `${canonicalJson(JsonValueSchema.parse(completed.preflightTerminal))}\n`,
        );
        return;
      }
      const design = await prepareM7R4FreshTwoCaseDesignV1({
        live,
        now,
      });
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
              now,
            });
          },
          beforePassedTerminal: async () => {
            const cleanup = await design.cleanup();
            if (!cleanup.cleanupProven || cleanup.sandboxSafetyFailure) {
              throw new Error(
                cleanup.sandboxSafetyFailure
                  ? "R4 no-Agent phase-one sandbox safety failure"
                  : "R4 no-Agent phase-one cleanup was not proven",
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
              ? "R4 no-Agent phase-one sandbox safety failure"
              : "R4 no-Agent phase-one cleanup was not proven",
          );
        }
      } catch (error) {
        cleanupFailure = error;
      }
      if (primaryFailure !== undefined || cleanupFailure !== undefined) {
        throw primaryFailure !== undefined && cleanupFailure !== undefined
          ? new AggregateError(
              [primaryFailure, cleanupFailure],
              "R4 no-Agent preflight and phase-one cleanup failed",
            )
          : (primaryFailure ?? cleanupFailure);
      }
      if (retained === undefined) {
        throw new Error("R4 no-Agent attempt returned no retained result");
      }
      process.stdout.write(
        `${canonicalJson(JsonValueSchema.parse(retained.terminal))}\n`,
      );
    },
  );
});
