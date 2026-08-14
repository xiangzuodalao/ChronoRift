import {
  SandboxCleanupReceiptV1Schema,
  type SandboxCleanupReceiptV1,
} from "./contracts.js";

export class ProjectEnvironmentHostGateCleanupError extends Error {
  public override readonly name = "ProjectEnvironmentHostGateCleanupError";

  public constructor(public readonly receipt: SandboxCleanupReceiptV1) {
    super("Project Environment sandbox cleanup could not be proven");
  }
}

/**
 * Seals the PE Host Gate only when the real sandbox process group, cgroup
 * scope, and bounded Task storage have all been reconciled. An incomplete
 * receipt remains retryable at the broker boundary, but it is never reported
 * as a successful Host Gate cleanup.
 */
export async function closeProjectEnvironmentHostGateV1(
  cleanupSandbox: () => Promise<SandboxCleanupReceiptV1>,
): Promise<SandboxCleanupReceiptV1> {
  const receipt = SandboxCleanupReceiptV1Schema.parse(await cleanupSandbox());
  if (
    !receipt.processGroupTerminated ||
    receipt.cgroupPopulated ||
    !receipt.scopeRemoved ||
    receipt.storageReconciled !== true
  ) {
    throw new ProjectEnvironmentHostGateCleanupError(receipt);
  }
  return Object.freeze({ ...receipt });
}
