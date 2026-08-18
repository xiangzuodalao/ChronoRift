import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { JsonValueSchema } from "@chronorift/domain";
import { canonicalJson } from "@chronorift/json-artifacts";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const scriptPath = resolve(
  process.cwd(),
  ".chronorift/m7-r3-live/run-control.mjs",
);

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const sha256 = (bytes: string | Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");
const digestJson = (value: unknown): string =>
  sha256(canonicalJson(JsonValueSchema.parse(value)));
const encodeRecord = (basis: Record<string, unknown>): Buffer =>
  Buffer.from(
    `${canonicalJson({ ...basis, recordContentSha256: digestJson(basis) })}\n`,
    "utf8",
  );

const setup = async () => {
  const root = await mkdtemp(join(tmpdir(), "chronorift-m7-r3-control-"));
  roots.push(root);
  await chmod(root, 0o700);
  const runControlRoot = join(root, "run-control");
  const operationalRoot = join(root, "operational-config");
  await Promise.all([
    mkdir(runControlRoot, { mode: 0o700 }),
    mkdir(operationalRoot, { mode: 0o700 }),
  ]);
  return { runControlRoot, operationalRoot };
};

const runControl = async (
  rootsInput: Awaited<ReturnType<typeof setup>>,
  ...args: string[]
) =>
  execFileAsync(process.execPath, [scriptPath, ...args], {
    env: {
      ...process.env,
      CHRONORIFT_M7_R3_RUN_CONTROL_ROOT: rootsInput.runControlRoot,
      CHRONORIFT_M7_R3_OPERATIONAL_CONFIG_ROOT: rootsInput.operationalRoot,
    },
  });

describe("M7 R3 formal run control operational binding", () => {
  it("retains raw/content hashes for started, manifest, and topology records", async () => {
    const directories = await setup();
    await runControl(directories, "started");
    const startedBytes = await readFile(
      join(directories.runControlRoot, "started.v1.json"),
    );
    const started = JSON.parse(startedBytes.toString("utf8")) as {
      recordContentSha256: string;
    };

    const manifestBasis = {
      schemaVersion: 1,
      recordKind: "m7-r3-operational-cgroup-partition",
      marker: "test",
    };
    const manifestBytes = encodeRecord(manifestBasis);
    const manifestContentSha256 = digestJson(manifestBasis);
    await writeFile(
      join(directories.operationalRoot, "m7-r3-cgroup-partition.v1.json"),
      manifestBytes,
      { mode: 0o600 },
    );
    const topologyBasis = {
      schemaVersion: 1,
      recordKind: "m7-r3-realized-cgroup-topology",
      operationalManifestFileSha256: sha256(manifestBytes),
      operationalManifestRecordContentSha256: manifestContentSha256,
    };
    const topologyBytes = encodeRecord(topologyBasis);
    await writeFile(
      join(
        directories.operationalRoot,
        "m7-r3-realized-cgroup-topology.v1.json",
      ),
      topologyBytes,
      { mode: 0o600 },
    );

    await runControl(directories, "result", "0");
    const resultPath = join(
      directories.runControlRoot,
      "command-result.v1.json",
    );
    const result = JSON.parse(await readFile(resultPath, "utf8")) as Record<
      string,
      unknown
    >;
    expect(result.startedRecordFileSha256).toBe(sha256(startedBytes));
    expect(result.startedRecordContentSha256).toBe(started.recordContentSha256);
    expect(result.operationalManifestFileSha256).toBe(sha256(manifestBytes));
    expect(result.operationalManifestRecordContentSha256).toBe(
      manifestContentSha256,
    );
    expect(result.realizedTopologyReceiptFileSha256).toBe(
      sha256(topologyBytes),
    );
    expect(result.realizedTopologyReceiptRecordContentSha256).toBe(
      digestJson(topologyBasis),
    );
    const metadata = await lstat(resultPath);
    expect(metadata.mode & 0o7777).toBe(0o600);
    expect(metadata.nlink).toBe(1);
  });

  it("retains null operational hashes when failure precedes the seal", async () => {
    const directories = await setup();
    await runControl(directories, "started");
    await runControl(directories, "result", "1");
    const result = JSON.parse(
      await readFile(
        join(directories.runControlRoot, "command-result.v1.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    expect(result.status).toBe("failed");
    expect(result.operationalManifestFileSha256).toBeNull();
    expect(result.operationalManifestRecordContentSha256).toBeNull();
    expect(result.realizedTopologyReceiptFileSha256).toBeNull();
    expect(result.realizedTopologyReceiptRecordContentSha256).toBeNull();
  });
});
