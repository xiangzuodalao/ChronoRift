import {
  VNextCheckpointManifestV1Schema,
  VNextRestoreReceiptV1Schema,
  type AdapterId,
  type BuildId,
  type ExecutionId,
  type RestoreReceiptId,
  type RuntimeId,
  type TaskId,
  type VNextCheckpointManifestV1,
  type VNextCheckpointStateDomainV1,
  type VNextRestoreDomainReceiptV1,
  type VNextRestoreReceiptV1,
  type VNextRestoreValidationV1,
} from "@chronorift/domain";

import type {
  VNextCheckpointRestorePort,
  VNextDomainRestoreAttempt,
} from "../ports/vnext-runtime.js";

export interface VNextCheckpointRestoreRequest {
  readonly taskId: TaskId;
  readonly restoreReceiptId: RestoreReceiptId;
  readonly targetRuntimeId: RuntimeId;
  readonly targetExecutionId: ExecutionId;
  readonly currentBuildId: BuildId;
  readonly currentAdapterId: AdapterId;
  readonly currentStateSchemaVersion: string;
}

const compatibilityFor = (
  manifest: VNextCheckpointManifestV1,
  request: VNextCheckpointRestoreRequest,
): VNextRestoreReceiptV1["compatibility"] => {
  if (manifest.buildId !== request.currentBuildId) return "build_mismatch";
  if (manifest.adapterId !== request.currentAdapterId)
    return "adapter_mismatch";
  if (manifest.stateSchemaVersion !== request.currentStateSchemaVersion) {
    return "schema_mismatch";
  }
  return "same_build";
};

const incompatibleDomainReceipt = (
  domain: VNextCheckpointStateDomainV1,
  compatibility: VNextRestoreReceiptV1["compatibility"],
): VNextRestoreDomainReceiptV1 => {
  if (domain.classification === "unsupported") {
    return {
      schemaVersion: 1,
      domain: domain.domain,
      requested: false,
      status: "unsupported",
      beforeHash: null,
      afterHash: null,
      message: domain.reason,
    };
  }
  if (domain.classification === "uncontrolled") {
    return {
      schemaVersion: 1,
      domain: domain.domain,
      requested: false,
      status: "uncontrolled",
      beforeHash: null,
      afterHash: null,
      message: domain.reason,
    };
  }
  return {
    schemaVersion: 1,
    domain: domain.domain,
    requested: domain.classification !== "externally_controlled",
    status: "rejected",
    beforeHash: null,
    afterHash: null,
    message: `restore rejected because compatibility is ${compatibility}`,
  };
};

const attemptReceipt = (
  domain: VNextCheckpointStateDomainV1,
  attempt: VNextDomainRestoreAttempt,
): VNextRestoreDomainReceiptV1 => {
  const status =
    attempt.status === "rejected"
      ? "rejected"
      : domain.classification === "reset"
        ? "reset"
        : "restored";
  return {
    schemaVersion: 1,
    domain: domain.domain,
    requested: true,
    status,
    beforeHash: attempt.beforeHash,
    afterHash: attempt.afterHash,
    message: attempt.message,
  };
};

export class VNextCheckpointRestoreService {
  public constructor(private readonly port: VNextCheckpointRestorePort) {}

  public restore(
    manifest: VNextCheckpointManifestV1,
    request: VNextCheckpointRestoreRequest,
  ): VNextRestoreReceiptV1 {
    VNextCheckpointManifestV1Schema.parse(manifest);
    if (manifest.taskId !== request.taskId) {
      throw new Error(
        "checkpoint task ownership does not match restore request",
      );
    }

    const compatibility = compatibilityFor(manifest, request);
    if (compatibility !== "same_build") {
      const domains = manifest.domains.map((domain) =>
        incompatibleDomainReceipt(domain, compatibility),
      );
      return VNextRestoreReceiptV1Schema.parse({
        schemaVersion: 1,
        taskId: request.taskId,
        restoreReceiptId: request.restoreReceiptId,
        checkpointId: manifest.checkpointId,
        checkpointBuildId: manifest.buildId,
        currentBuildId: request.currentBuildId,
        checkpointAdapterId: manifest.adapterId,
        currentAdapterId: request.currentAdapterId,
        checkpointStateSchemaVersion: manifest.stateSchemaVersion,
        currentStateSchemaVersion: request.currentStateSchemaVersion,
        targetRuntimeId: request.targetRuntimeId,
        targetExecutionId: request.targetExecutionId,
        compatibility,
        status: "rejected",
        equivalentForkEligible: false,
        equivalence: "unavailable",
        domains,
        uncoveredDomains: manifest.domains.map((domain) => domain.domain),
        fidelity: "descriptive_only",
        deterministicBoundary:
          "checkpoint build, adapter, and state schema compatibility",
        validations: [],
        firstDivergence: null,
      });
    }

    const receipts = new Map<string, VNextRestoreDomainReceiptV1>();
    let dependencyFailed = false;
    for (const domainName of manifest.restoreDependencyOrder) {
      const domain = manifest.domains.find(
        (candidate) => candidate.domain === domainName,
      );
      if (domain === undefined) {
        throw new Error(
          `checkpoint restore dependency is missing: ${domainName}`,
        );
      }
      if (dependencyFailed) {
        receipts.set(domain.domain, {
          schemaVersion: 1,
          domain: domain.domain,
          requested: true,
          status: "skipped",
          beforeHash: null,
          afterHash: null,
          message: "an earlier restore dependency failed",
        });
        continue;
      }
      try {
        if (domain.classification === "captured") {
          const receipt = attemptReceipt(
            domain,
            this.port.restoreCapturedDomain(domain),
          );
          receipts.set(domain.domain, receipt);
          dependencyFailed = receipt.status === "rejected";
        } else if (domain.classification === "reset") {
          const receipt = attemptReceipt(domain, this.port.resetDomain(domain));
          receipts.set(domain.domain, receipt);
          dependencyFailed = receipt.status === "rejected";
        }
      } catch (error) {
        receipts.set(domain.domain, {
          schemaVersion: 1,
          domain: domain.domain,
          requested: true,
          status: "rejected",
          beforeHash: null,
          afterHash: null,
          message:
            error instanceof Error ? error.message : "runtime restore failed",
        });
        dependencyFailed = true;
      }
    }

    for (const domain of manifest.domains) {
      if (receipts.has(domain.domain)) continue;
      switch (domain.classification) {
        case "externally_controlled":
          receipts.set(domain.domain, {
            schemaVersion: 1,
            domain: domain.domain,
            requested: false,
            status: "externally_controlled",
            beforeHash: null,
            afterHash: null,
            message: domain.limitation,
          });
          break;
        case "unsupported":
          receipts.set(domain.domain, {
            schemaVersion: 1,
            domain: domain.domain,
            requested: false,
            status: "unsupported",
            beforeHash: null,
            afterHash: null,
            message: domain.reason,
          });
          break;
        case "uncontrolled":
          receipts.set(domain.domain, {
            schemaVersion: 1,
            domain: domain.domain,
            requested: false,
            status: "uncontrolled",
            beforeHash: null,
            afterHash: null,
            message: domain.reason,
          });
          break;
        case "captured":
        case "reset":
          receipts.set(domain.domain, {
            schemaVersion: 1,
            domain: domain.domain,
            requested: true,
            status: "rejected",
            beforeHash: null,
            afterHash: null,
            message:
              "restorable domain was absent from restore dependency order",
          });
          break;
      }
    }

    let validations: readonly VNextRestoreValidationV1[];
    try {
      validations = this.port.validateRestore(manifest);
    } catch (error) {
      validations = [
        {
          schemaVersion: 1,
          name: "runtime.restore_validation",
          status: "unavailable",
          expectedHash: null,
          actualHash: null,
          message:
            error instanceof Error
              ? error.message
              : "restore validation was unavailable",
        },
      ];
    }

    const domains = manifest.domains.map((domain) => {
      const receipt = receipts.get(domain.domain);
      if (receipt === undefined) {
        throw new Error(`restore receipt missing domain: ${domain.domain}`);
      }
      return receipt;
    });
    const failedWrite = domains.some((domain) => domain.status === "rejected");
    const uncoveredDomains = domains
      .filter(
        (domain) =>
          domain.status === "rejected" ||
          domain.status === "skipped" ||
          domain.status === "unsupported" ||
          domain.status === "uncontrolled",
      )
      .map((domain) => domain.domain);
    const validationFailed = validations.some(
      (validation) => validation.status === "fail",
    );
    const status =
      failedWrite || validationFailed ? "partially_restored" : "restored";
    const validationComplete = validations.every(
      (validation) => validation.status === "pass",
    );
    const equivalentForkEligible =
      status === "restored" &&
      manifest.fidelity === "equivalent_candidate" &&
      uncoveredDomains.length === 0 &&
      validations.length > 0 &&
      validationComplete;

    return VNextRestoreReceiptV1Schema.parse({
      schemaVersion: 1,
      taskId: request.taskId,
      restoreReceiptId: request.restoreReceiptId,
      checkpointId: manifest.checkpointId,
      checkpointBuildId: manifest.buildId,
      currentBuildId: request.currentBuildId,
      checkpointAdapterId: manifest.adapterId,
      currentAdapterId: request.currentAdapterId,
      checkpointStateSchemaVersion: manifest.stateSchemaVersion,
      currentStateSchemaVersion: request.currentStateSchemaVersion,
      targetRuntimeId: request.targetRuntimeId,
      targetExecutionId: request.targetExecutionId,
      compatibility,
      status,
      equivalentForkEligible,
      equivalence:
        status === "restored"
          ? "registered_state_restored_but_equivalence_unestablished"
          : "unavailable",
      domains,
      uncoveredDomains,
      fidelity: equivalentForkEligible
        ? "equivalent_candidate"
        : "descriptive_only",
      deterministicBoundary:
        "only manifest-declared captured/reset domains and successful validations",
      validations,
      firstDivergence: null,
    });
  }
}
