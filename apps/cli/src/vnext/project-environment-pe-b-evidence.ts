import { createHash } from "node:crypto";

import {
  AdapterCompatibilityReceiptV2Schema,
  EnvironmentBindingEpochV1Schema,
  EnvironmentPublicationReceiptV1Schema,
  ProjectEnvironmentPinnedCaptureV2Schema,
  ProjectEnvironmentReuseReceiptV1Schema,
  ProjectEnvironmentRevisionV1Schema,
  ProjectEnvironmentRuntimeObservationReceiptV2Schema,
  ProjectEnvironmentTurnV1Schema,
  ProjectInitializationAttemptV1Schema,
  ProjectToolchainReceiptV1Schema,
  type JsonValue,
} from "@chronorift/domain";
import type { LoadedProjectAdapterPackageV2 } from "@chronorift/godot-adapter";
import {
  canonicalJson,
  contentHash,
  projectEnvironmentPackageContentDigestV1,
  type ImmutablePackageSealV1,
  type ProjectEnvironmentPackageFileInputV1,
} from "@chronorift/json-artifacts";

import type { VerifiedProjectEnvironmentSourceV1 } from "./source-preflight.js";

const sha256 = (value: Uint8Array | string): string =>
  createHash("sha256").update(value).digest("hex");
const json = (value: unknown): JsonValue =>
  JSON.parse(JSON.stringify(value)) as JsonValue;
const requireEvidence = (condition: boolean, message: string): void => {
  if (!condition) throw new TypeError(`invalid PE-B evidence: ${message}`);
};
const fileEvidence = (files: readonly ProjectEnvironmentPackageFileInputV1[]) =>
  Object.freeze(
    files
      .map((file) =>
        Object.freeze({
          path: file.path,
          byteLength: file.bytes.byteLength,
          sha256: sha256(file.bytes),
          canonicalBase64: Buffer.from(file.bytes).toString("base64"),
        }),
      )
      .sort((left, right) => left.path.localeCompare(right.path)),
  );

export interface ProjectEnvironmentPeBPinnedCaptureEvidenceInputV2 {
  readonly payload: unknown;
  readonly records: readonly JsonValue[];
  readonly recordsBytes: Uint8Array;
  readonly payloadHash: string;
  readonly packageHash: string;
  readonly packageSeal: ImmutablePackageSealV1;
}

interface ProjectEnvironmentPeBSessionEvidenceInputV2 {
  readonly taskId: string;
  readonly sessionId: string;
  readonly binding: unknown;
  readonly compatibility: unknown;
  readonly runtime: unknown;
  readonly pinnedCapture: ProjectEnvironmentPeBPinnedCaptureEvidenceInputV2;
  readonly turns: readonly unknown[];
  readonly goalDelivered: boolean;
}

export interface BuildProjectEnvironmentPeBEvidenceV2Input {
  readonly source: VerifiedProjectEnvironmentSourceV1;
  readonly loadedAdapter: LoadedProjectAdapterPackageV2;
  readonly environmentRevision: unknown;
  readonly revisionFiles: readonly ProjectEnvironmentPackageFileInputV1[];
  readonly revisionPayloadHash: string;
  readonly revisionPackageHash: string;
  readonly revisionPackageSeal: ImmutablePackageSealV1;
  readonly publication: unknown;
  readonly initializationAttempt: unknown;
  readonly toolchain: unknown;
  readonly first: ProjectEnvironmentPeBSessionEvidenceInputV2;
  readonly reuse: ProjectEnvironmentPeBSessionEvidenceInputV2 & {
    readonly reuseReceipt: unknown;
  };
}

const sessionEvidence = (
  input: ProjectEnvironmentPeBSessionEvidenceInputV2,
) => {
  const binding = EnvironmentBindingEpochV1Schema.parse(input.binding);
  const compatibility = AdapterCompatibilityReceiptV2Schema.parse(
    input.compatibility,
  );
  const runtime = ProjectEnvironmentRuntimeObservationReceiptV2Schema.parse(
    input.runtime,
  );
  const capture = ProjectEnvironmentPinnedCaptureV2Schema.parse(
    input.pinnedCapture.payload,
  );
  const turns = input.turns.map((turn) =>
    ProjectEnvironmentTurnV1Schema.parse(turn),
  );
  requireEvidence(input.goalDelivered, "goal was not delivered");
  requireEvidence(
    binding.taskId === input.taskId &&
      binding.state !== "pending" &&
      (binding.state !== "reused" || binding.sessionId === input.sessionId),
    "binding crossed Task/Session ownership",
  );
  requireEvidence(
    compatibility.taskId === input.taskId &&
      runtime.taskId === input.taskId &&
      capture.taskId === input.taskId,
    "runtime evidence crossed Task ownership",
  );
  requireEvidence(
    compatibility.buildId === runtime.buildId &&
      runtime.buildId === capture.buildId &&
      runtime.executionId === capture.executionId &&
      runtime.captureWindowIds.includes(capture.captureWindowId),
    "runtime/capture/compatibility binding differs",
  );
  requireEvidence(
    compatibility.outcome === "compatible" &&
      runtime.outcome === "succeeded" &&
      compatibility.dynamicTraces.length > 0 &&
      runtime.dynamicTraces.length > 0 &&
      capture.dynamicTraces.length > 0,
    "session did not retain a successful dynamic trace",
  );
  requireEvidence(
    input.pinnedCapture.recordsBytes.byteLength > 0 &&
      sha256(input.pinnedCapture.recordsBytes) ===
        sha256(
          Buffer.from(`${canonicalJson(json(input.pinnedCapture.records))}\n`),
        ),
    "pinned records bytes are not canonical",
  );
  return Object.freeze({
    schemaVersion: 2 as const,
    taskId: input.taskId,
    sessionId: input.sessionId,
    binding,
    compatibility,
    runtime,
    turns,
    capture: Object.freeze({
      payload: capture,
      recordsCanonicalBase64: Buffer.from(
        input.pinnedCapture.recordsBytes,
      ).toString("base64"),
      payloadHash: input.pinnedCapture.payloadHash,
      packageHash: input.pinnedCapture.packageHash,
      packageSeal: input.pinnedCapture.packageSeal,
    }),
    goalDelivered: true as const,
  });
};

export const buildProjectEnvironmentPeBEvidenceV2 = (
  input: BuildProjectEnvironmentPeBEvidenceV2Input,
) => {
  const revision = ProjectEnvironmentRevisionV1Schema.parse(
    input.environmentRevision,
  );
  const publication = EnvironmentPublicationReceiptV1Schema.parse(
    input.publication,
  );
  const attempt = ProjectInitializationAttemptV1Schema.parse(
    input.initializationAttempt,
  );
  const toolchain = ProjectToolchainReceiptV1Schema.parse(input.toolchain);
  const first = sessionEvidence(input.first);
  const reuse = Object.freeze({
    ...sessionEvidence(input.reuse),
    reuseReceipt: ProjectEnvironmentReuseReceiptV1Schema.parse(
      input.reuse.reuseReceipt,
    ),
  });
  requireEvidence(
    input.source.sourceKind === "project-environment-v1-clean-git" &&
      input.source.requestedGodotVersion === "4.7.1",
    "source is outside PE-B clean Godot 4.7.1 scope",
  );
  requireEvidence(
    projectEnvironmentPackageContentDigestV1(input.revisionFiles) ===
      revision.contentDigest,
    "revision physical content digest differs",
  );
  requireEvidence(
    input.loadedAdapter.manifest.schemaVersion === 2 &&
      input.loadedAdapter.manifest.sdk.version === 2 &&
      input.loadedAdapter.manifest.smoke.requiredDynamicTraces.length > 0,
    "published adapter is not a dynamic V2 adapter",
  );
  requireEvidence(
    publication.outcome === "committed" &&
      publication.targetEnvironmentRevisionId ===
        revision.environmentRevisionId &&
      attempt.state === "succeeded",
    "initialization/publication did not complete",
  );
  requireEvidence(
    first.taskId !== reuse.taskId &&
      first.sessionId !== reuse.sessionId &&
      first.runtime.executionId !== reuse.runtime.executionId,
    "first and reuse evidence are not independent Task/Session/Executions",
  );
  requireEvidence(
    reuse.reuseReceipt.outcome === "reused" &&
      reuse.reuseReceipt.environmentRevisionId ===
        revision.environmentRevisionId,
    "second Session did not reuse the exact revision",
  );
  const body = Object.freeze({
    schemaVersion: 2 as const,
    evidenceKind: "chronorift-project-environment-pe-b-evidence" as const,
    evidenceProfile: "dynamic-projection-two-session-v2" as const,
    source: Object.freeze({
      sourceKind: input.source.sourceKind,
      headCommit: input.source.headCommit,
      selectedTreeSha256: input.source.selectedTreeSha256,
      projectSourceIdentity: input.source.projectSourceIdentity,
      mainScene: input.source.mainScene,
      requestedGodotVersion: input.source.requestedGodotVersion,
    }),
    toolchain,
    adapter: Object.freeze({
      candidateSha256: input.loadedAdapter.candidateSha256,
      manifestSha256: input.loadedAdapter.manifestSha256,
      manifest: input.loadedAdapter.manifest,
    }),
    environment: Object.freeze({
      revision,
      files: fileEvidence(input.revisionFiles),
      payloadHash: input.revisionPayloadHash,
      packageHash: input.revisionPackageHash,
      packageSeal: input.revisionPackageSeal,
    }),
    publication,
    initializationAttempt: attempt,
    first,
    reuse,
    limitations: Object.freeze([
      "One frozen dynamic Godot structure only.",
      "Record ordering and binding do not attest Signal-to-state causality or adapter semantic correctness.",
      "This local evidence is not a signature, protected artifact, or arbitrary-project generalization.",
    ]),
  });
  return Object.freeze({
    ...body,
    bundleContentHash: contentHash(json(body)),
  });
};
