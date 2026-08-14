import { createHash } from "node:crypto";

import {
  ProjectSnapshotCharacterizationReceiptV1Schema,
  type ProjectSnapshotCharacterizationReceiptV1,
} from "@chronorift/domain";
import { canonicalProjectAdapterValueV1 } from "@chronorift/godot-protocol";

import type { GodotProjectEnvironmentRuntimeClientV1 } from "./project-environment-wire-client.js";

export type GodotProjectEnvironmentSnapshotCharacterizationRuntimeV1 = Pick<
  GodotProjectEnvironmentRuntimeClientV1,
  "restore" | "setControls" | "snapshot"
>;

type SnapshotRequestV1 = Parameters<
  GodotProjectEnvironmentRuntimeClientV1["snapshot"]
>[0];
type SnapshotResultV1 = Awaited<
  ReturnType<GodotProjectEnvironmentRuntimeClientV1["snapshot"]>
>;
type RestoreResultV1 = Awaited<
  ReturnType<GodotProjectEnvironmentRuntimeClientV1["restore"]>
>;

export interface GodotProjectEnvironmentSnapshotCharacterizationOptionsV1 {
  readonly receiptId: string;
  readonly taskId: string;
  readonly adapterRevisionId: string;
  readonly buildId: string;
  readonly runtimeId: string;
  readonly executionId: string;
  readonly mutationId: string;
  readonly requestedBarrier: SnapshotRequestV1["requestedBarrier"];
  readonly applyControlledMutation: (
    runtime: GodotProjectEnvironmentSnapshotCharacterizationRuntimeV1,
  ) => Promise<void>;
}

const digest = (value: unknown): string =>
  createHash("sha256")
    .update(canonicalProjectAdapterValueV1(value))
    .digest("hex");

const unique = (values: readonly string[]): string[] => [...new Set(values)];

const byDomain = (
  snapshot: SnapshotResultV1,
): ReadonlyMap<string, SnapshotResultV1["domains"][number]> =>
  new Map(snapshot.domains.map((domain) => [domain.stateDomainId, domain]));

const restoreByDomain = (
  restore: RestoreResultV1,
): ReadonlyMap<string, RestoreResultV1["domains"][number]> =>
  new Map(restore.domains.map((domain) => [domain.stateDomainId, domain]));

const capturedDigest = (
  domain: SnapshotResultV1["domains"][number] | undefined,
): string | null =>
  domain?.disposition === "captured" && domain.value !== null
    ? digest(domain.value)
    : null;

/**
 * Runs the PE-A fixture-only optional snapshot contract. The receipt compares
 * Adapter-declared projections and deliberately never makes an equivalent
 * start, replay, or correctness claim.
 */
export const characterizeGodotProjectEnvironmentSnapshotV1 = async (
  runtime: GodotProjectEnvironmentSnapshotCharacterizationRuntimeV1,
  options: GodotProjectEnvironmentSnapshotCharacterizationOptionsV1,
): Promise<ProjectSnapshotCharacterizationReceiptV1> => {
  const initial = await runtime.snapshot({
    requestedBarrier: options.requestedBarrier,
  });
  await options.applyControlledMutation(runtime);
  const mutation = await runtime.snapshot({
    requestedBarrier: options.requestedBarrier,
  });
  const restored = await runtime.restore({
    snapshotId: initial.snapshotId,
    requestedBarrier: options.requestedBarrier,
  });
  const readBack = await runtime.snapshot({
    requestedBarrier: options.requestedBarrier,
  });

  const mutationDomains = byDomain(mutation);
  const restoreDomains = restoreByDomain(restored);
  const readBackDomains = byDomain(readBack);
  const domains = [...initial.domains]
    .sort((left, right) =>
      left.stateDomainId.localeCompare(right.stateDomainId, "en-US"),
    )
    .map((expected) => {
      const mutated = mutationDomains.get(expected.stateDomainId);
      const restore = restoreDomains.get(expected.stateDomainId);
      const actual = readBackDomains.get(expected.stateDomainId);
      const expectedDigest = capturedDigest(expected);
      const mutatedDigest =
        expected.disposition === "captured" ? capturedDigest(mutated) : null;
      const actualDigest =
        expected.disposition === "captured" ? capturedDigest(actual) : null;
      const mutationObserved =
        expectedDigest !== null &&
        mutatedDigest !== null &&
        expectedDigest !== mutatedDigest;
      const missing =
        expected.disposition === "captured" && actualDigest === null;
      const mismatch =
        expectedDigest !== null &&
        actualDigest !== null &&
        expectedDigest !== actualDigest;
      const restoreStatus = restore?.status ?? "missing";
      const limitations = unique([
        ...expected.limitations,
        ...(mutated?.limitations ?? [
          "The mutation snapshot omitted this declared state domain.",
        ]),
        ...(actual?.limitations ?? [
          "The post-restore read-back snapshot omitted this declared state domain.",
        ]),
        ...(restore?.limitations ?? [
          "The restore result omitted this declared state domain.",
        ]),
        ...(restoreStatus !== "written" && expected.disposition === "captured"
          ? [`The Adapter reported restore status ${restoreStatus}.`]
          : []),
        ...(missing
          ? ["No captured value was available at post-restore read-back."]
          : []),
        ...(mismatch
          ? ["The post-restore read-back digest differs from the snapshot."]
          : []),
      ]);
      return {
        schemaVersion: 1 as const,
        domainId: expected.stateDomainId,
        disposition: expected.disposition,
        expectedHash: expectedDigest,
        mutatedHash: mutatedDigest,
        actualHash: actualDigest,
        mutationObserved,
        restoreStatus,
        missing,
        mismatch,
        limitations,
      };
    });

  const first = domains.find((domain) => domain.missing || domain.mismatch);
  const initialIds = new Set(
    initial.domains.map((domain) => domain.stateDomainId),
  );
  const unknownDomainIds = unique(
    [...mutation.domains, ...restored.domains, ...readBack.domains]
      .map((domain) => domain.stateDomainId)
      .filter((domainId) => !initialIds.has(domainId)),
  );
  const controlledMutationObserved = domains.some(
    (domain) => domain.mutationObserved,
  );

  return ProjectSnapshotCharacterizationReceiptV1Schema.parse({
    schemaVersion: 1,
    receiptId: options.receiptId,
    taskId: options.taskId,
    adapterRevisionId: options.adapterRevisionId,
    buildId: options.buildId,
    runtimeId: options.runtimeId,
    executionId: options.executionId,
    initialSnapshotId: initial.snapshotId,
    mutationSnapshotId: mutation.snapshotId,
    readBackSnapshotId: readBack.snapshotId,
    mutationId: options.mutationId,
    requestedBarrierId: options.requestedBarrier,
    initialRealizedBarrierId: initial.realizedBarrier,
    mutationRealizedBarrierId: mutation.realizedBarrier,
    restoreRealizedBarrierId: restored.realizedBarrier,
    readBackRealizedBarrierId: readBack.realizedBarrier,
    controlledMutationObserved,
    domains,
    firstDivergence:
      first === undefined || first.expectedHash === null
        ? null
        : {
            schemaVersion: 1,
            domainId: first.domainId,
            kind: first.missing ? "missing" : "mismatch",
            expectedHash: first.expectedHash,
            actualHash: first.actualHash,
            observation: "post_restore_read_back",
            description: first.missing
              ? "The first compared domain was absent at post-restore read-back."
              : "The first compared domain differed at post-restore read-back.",
          },
    conclusion: "descriptive_only",
    limitations: unique([
      "Characterization compares only Adapter-declared snapshot projections.",
      "No observed read-back divergence does not establish an equivalent start.",
      ...(!controlledMutationObserved
        ? ["The controlled mutation was not observed in any captured domain."]
        : []),
      ...(unknownDomainIds.length > 0
        ? [
            `Later phases reported domains absent from the initial snapshot: ${unknownDomainIds.join(", ")}.`,
          ]
        : []),
    ]),
  });
};
