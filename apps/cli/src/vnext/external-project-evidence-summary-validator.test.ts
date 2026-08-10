import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const validatorPath = resolve(
  ".github/scripts/validate-vnext-external-project-evidence.mjs",
);
const schemaPath = resolve(
  "testdata/vnext/external-project/evidence-summary.schema.v1.json",
);
const temporaryRoots: string[] = [];
const hash = "a".repeat(64);

const diagnosticStream = () => ({
  totalSha256: hash,
  totalBytes: 0,
  retainedBytes: 0,
  truncated: false,
});

const syntheticEvidence = () => ({
  schemaVersion: 1,
  evidenceKind: "chronorift-m4-external-project-conformance-evidence",
  conformanceSpecSha256:
    "1fc43c0eaea45ed9fa129a7a2e06913c0cc37495633dc4d90dd3fd7598de5f82",
  profile: "chronorift-godot-lifecycle-v1",
  driver: {
    kind: "deterministic-fake-pi",
    providerContacted: false,
  },
  source: {
    declaredSourceUrl: "https://github.com/endlessm/moddable-platformer",
    headCommit: "3e793f53598a131c53fb82555191cc14b8db07ff",
    gitTreeObjectId: "a013bd677c712dbf354e8e2f6e8ff7c53d5684c6",
    selectedTreeSha256:
      "3e8bd6478d53586284010da38959005e2a377ef6277b2a838ecb1538abc096e8",
    entryCount: 543,
    declaredByteLength: 1_380_343,
    cleanBeforeTask: true,
    unchangedAfterTask: true,
  },
  descriptor: {
    sha256: "534dcd8aa14aeea74685059f8d66e44e5bebe21742b7a702ee7d78e91e1a955e",
    persistedBytesRevalidated: true,
  },
  toolchain: {
    nodeVersion: "v22.23.1",
    godotVersion: "4.7.1.stable.official.a13da4feb",
  },
  sandbox: {
    networkMode: "loopback_only",
    storageFilesystem: "tmpfs",
    storageCapacityBytes: 1_073_741_824,
    storageInodeCapacity: 131_072,
    delegatedControllers: ["cpu", "memory", "pids"],
    sourceMountedReadOnly: true,
    taskCredentialMountCount: 0,
    mountAdmissionReceiptCount: 8,
    mountAdmissionsSha256: hash,
    taskSharedWritableTargets: ["/tmp", "/artifacts"],
  },
  lifecycleTools: {
    exposed: ["game_capabilities", "game_launch", "game_status", "game_stop"],
    notExposed: [
      "game_capture_configure",
      "game_capture_pin",
      "game_query",
      "game_input",
      "game_step",
      "game_set_controls",
      "game_checkpoint_create",
      "game_checkpoint_restore",
      "game_fork",
      "game_trace_create",
      "game_trace_replay",
      "game_compare",
    ],
  },
  taskLifecycle: {
    lifecycleOperationsObserved: [
      "start",
      "continue",
      "show",
      "export",
      "discard",
    ],
    profilePreservedOnContinue: true,
  },
  runtime: {
    import: {
      exitCode: 0,
      timedOut: false,
      durationMs: 1,
      timingFidelity: "operation_bounds",
      stdout: diagnosticStream(),
      stderr: diagnosticStream(),
      receiptSha256: hash,
    },
    vanilla: {
      stabilityObservedMs: 2_000,
      timingFidelity: "operation_bounds",
      timedOut: false,
      stoppedByHarness: true,
      stdout: diagnosticStream(),
      stderr: diagnosticStream(),
      receiptSha256: hash,
    },
    overlay: {
      protocolVersion: 1,
      handshakeObserved: true,
      addonSha256: hash,
      candidateSourceSha256:
        "8aa71e3ea1839fb4a56940b25a3b61bc747bf712ec7a7221cdb42ecaaeeb2336",
      engineVersion: "4.7.1-stable (official)",
      platform: "Linux",
      renderer: "gl_compatibility",
      configuredSceneMatched: true,
      currentSceneMatched: true,
      processFrameDelta: 120,
      physicsTickDelta: 120,
      hostMonotonicStartUs: 1,
      hostMonotonicEndUs: 2,
      diagnosticLossObserved: false,
      receiptSha256: hash,
    },
    shutdown: {
      finalStatus: "stopped",
      receiptSha256: hash,
    },
  },
  candidate: {
    relativePath: "CHRONORIFT_ONBOARDING_SMOKE.md",
    mode: "100644",
    contentSha256:
      "04b0627d60c82e79178aaf7d8b9c7a7591a6bef635be21226e6cae6235b4089e",
    baselineSelectedTreeSha256:
      "3e8bd6478d53586284010da38959005e2a377ef6277b2a838ecb1538abc096e8",
    candidateSelectedTreeSha256:
      "8aa71e3ea1839fb4a56940b25a3b61bc747bf712ec7a7221cdb42ecaaeeb2336",
    exportedPatchSha256: hash,
    roundTripSelectedTreeSha256:
      "8aa71e3ea1839fb4a56940b25a3b61bc747bf712ec7a7221cdb42ecaaeeb2336",
  },
  cleanup: {
    taskDiscarded: true,
    taskProcessesEmpty: true,
    taskCgroupsEmpty: true,
    taskStorageEmpty: true,
  },
});

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

const validate = async (value: unknown) => {
  const root = await mkdtemp(join(tmpdir(), "chronorift-m4-evidence-test-"));
  temporaryRoots.push(root);
  const evidencePath = join(root, "evidence.json");
  await writeFile(evidencePath, `${JSON.stringify(value)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  return spawnSync(
    process.execPath,
    [validatorPath, schemaPath, evidencePath],
    {
      encoding: "utf8",
    },
  );
};

describe("test-only M4 external-project evidence summary validator", () => {
  it("accepts a synthetic value satisfying the frozen strict contract", async () => {
    const result = await validate(syntheticEvidence());

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(
      "validated strict M4 external-project evidence summary\n",
    );
    expect(result.stderr).toBe("");
  });

  it("rejects unknown fields and values below frozen Gate thresholds", async () => {
    const unknownField = await validate({
      ...syntheticEvidence(),
      assistantProse: "looks good",
    });
    const evidence = syntheticEvidence();
    evidence.runtime.overlay.processFrameDelta = 119;
    const belowThreshold = await validate(evidence);

    expect(unknownField.status).not.toBe(0);
    expect(unknownField.stderr).toContain(
      "$evidence.assistantProse is not allowed",
    );
    expect(belowThreshold.status).not.toBe(0);
    expect(belowThreshold.stderr).toContain(
      "$evidence.runtime.overlay.processFrameDelta is below its minimum",
    );
  });

  it("rejects internally inconsistent diagnostic and monotonic facts", async () => {
    const inconsistentDiagnostic = syntheticEvidence();
    inconsistentDiagnostic.runtime.import.stdout.totalBytes = 2;
    inconsistentDiagnostic.runtime.import.stdout.retainedBytes = 1;
    const diagnosticResult = await validate(inconsistentDiagnostic);

    const reversedClock = syntheticEvidence();
    reversedClock.runtime.overlay.hostMonotonicStartUs = 2;
    reversedClock.runtime.overlay.hostMonotonicEndUs = 1;
    const clockResult = await validate(reversedClock);

    expect(diagnosticResult.status).not.toBe(0);
    expect(diagnosticResult.stderr).toContain(
      "a non-truncated diagnostic stream must retain every byte",
    );
    expect(clockResult.status).not.toBe(0);
    expect(clockResult.stderr).toContain(
      "overlay Host monotonic bounds are reversed",
    );
  });

  it("rejects writable Godot workspace and credential-mount evidence", async () => {
    const writableWorkspace = syntheticEvidence();
    writableWorkspace.sandbox.sourceMountedReadOnly = false;
    const writableResult = await validate(writableWorkspace);

    const credentialMount = syntheticEvidence();
    credentialMount.sandbox.taskCredentialMountCount = 1;
    const credentialResult = await validate(credentialMount);

    expect(writableResult.status).not.toBe(0);
    expect(writableResult.stderr).toContain(
      "$evidence.sandbox.sourceMountedReadOnly does not equal its frozen value",
    );
    expect(credentialResult.status).not.toBe(0);
    expect(credentialResult.stderr).toContain(
      "$evidence.sandbox.taskCredentialMountCount does not equal its frozen value",
    );
  });
});
